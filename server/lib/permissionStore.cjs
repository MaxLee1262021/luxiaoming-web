// Normalized authorization storage. This module is intentionally independent
// from the HTTP API so migrations, jobs, and future admin routes share the
// same menu/role/user contract.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUTHZ_KEYS = ["menus", "roles", "roleMenus", "rolePermissions", "users"];
const LEGACY_ROLE_ALIASES = { admin: "super", administrator: "super", photographer: "photo" };
const AUTHORITY_PERMISSION_KEYS = new Set(["permissionManage", "permission.manage", "authz.manage", "system.permission.manage"]);
const BUSINESS_KEYS = [
  "cities", "agents", "distributors", "shops", "staff", "spots", "series", "albums", "samples",
  "packages", "addonServices", "peripherals", "tagLibrary", "guides", "stories", "scans", "orders",
  "afterSales", "reconciliationTransfers", "financeSettings", "monthlyClosings", "adjustmentRecords",
  "homeConfig", "logs", "trash", "merchantCodes", "siteConfig", "userProfiles", "config"
];

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }
function now() { return new Date().toISOString(); }

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `lxm1$${salt}$${crypto.scryptSync(String(plain), salt, 64).toString("hex")}`;
}
function verifyPassword(stored, plain) {
  if (!stored) return false;
  const value = String(stored);
  if (!value.startsWith("lxm1$")) return value === String(plain);
  const parts = value.split("$");
  if (parts.length !== 3 || !/^[0-9a-f]+$/i.test(parts[1]) || !/^[0-9a-f]+$/i.test(parts[2])) return false;
  try {
    const actual = crypto.scryptSync(String(plain), parts[1], 64);
    const expected = Buffer.from(parts[2], "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}
function safeUser(user) {
  if (!user) return null;
  const { password, passwordHash, password_hash, ...rest } = user;
  const scrub = (value) => {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(scrub);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/password|token|secret|private.?key|authorization/i.test(key)) continue;
      out[key] = scrub(child);
    }
    return out;
  };
  return clone(scrub(rest));
}
function normalizeUser(input = {}) {
  const out = { ...input };
  out.account = String(out.account || out.username || "").trim();
  out.name = String(out.name || out.displayName || out.account).trim();
  out.role = String(out.role || "service").trim().toLowerCase();
  out.permissions = Array.isArray(out.permissions) ? [...new Set(out.permissions.map(String))] : [];
  out.status = out.status || "active";
  out.updatedAt = now();
  return out;
}
function normalizeAuthzRole(value) {
  const key = String(value || "").trim().toLowerCase();
  return LEGACY_ROLE_ALIASES[key] || key;
}

function createJson(options) {
  const file = options.jsonFile || path.join(__dirname, "..", "data", "db.json");
  let cache;
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) {
      if (e.code !== "ENOENT") throw Object.assign(new Error("JSON 数据文件无效"), { code: "DATA_SOURCE_INVALID" });
      cache = { collections: {} };
    }
    if (!cache || typeof cache !== "object") throw Object.assign(new Error("JSON 数据文件格式无效"), { code: "DATA_SOURCE_INVALID" });
    if (!cache.collections || typeof cache.collections !== "object") cache.collections = {};
    if (!cache.authz || typeof cache.authz !== "object") cache.authz = {};
    for (const key of AUTHZ_KEYS) if (!cache.authz[key] || typeof cache.authz[key] !== "object") cache.authz[key] = {};
    return cache;
  }
  function persist() {
    load(); fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch (_) { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch (__) {} }
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }
  function bucket(key) { return load().authz[key]; }
  function values(key) { return Object.values(bucket(key)).map(clone); }
  async function listMenus() { return values("menus"); }
  async function listRoles() { return values("roles"); }
  async function listUsers() { return values("users").map(safeUser); }
  async function createEntity(key, data, prefix) {
    const item = { ...data, id: data.id || data._id || id(prefix), createdAt: data.createdAt || now(), updatedAt: now() };
    if (bucket(key)[item.id]) throw Object.assign(new Error("记录已存在"), { code: "DUPLICATE_RECORD" });
    bucket(key)[item.id] = item; persist(); return clone(key === "users" ? safeUser(item) : item);
  }
  async function updateEntity(key, entityId, patch) {
    const cur = bucket(key)[entityId]; if (!cur) return null;
    const next = { ...cur, ...patch, id: entityId, updatedAt: now() }; bucket(key)[entityId] = next; persist();
    return clone(key === "users" ? safeUser(next) : next);
  }
  async function removeEntity(key, entityId) { if (!bucket(key)[entityId]) return false; delete bucket(key)[entityId]; persist(); return true; }
  return {
    mode: "json", backend: "json", async ensureSchema() { load(); persist(); return { backend: "json", ready: true }; },
    listMenus, getMenu: async (x) => clone(bucket("menus")[x] || null), createMenu: (x) => createEntity("menus", x, "menu"), updateMenu: (x, p) => updateEntity("menus", x, p), deleteMenu: (x) => removeEntity("menus", x),
    listRoles, getRole: async (x) => clone(bucket("roles")[x] || null), createRole: (x) => createEntity("roles", x, "role"), updateRole: (x, p) => updateEntity("roles", x, p), deleteRole: async (x) => { if (!bucket("roles")[x]) return false; delete bucket("roles")[x]; delete bucket("roleMenus")[x]; delete bucket("rolePermissions")[x]; persist(); return true; },
    listUsers, getUser: async (x) => safeUser(bucket("users")[x]), getUserState: async (x) => clone(bucket("users")[x] || null), createUser: async (x) => { const item = normalizeUser(x); if (item.password && !String(item.password).startsWith("lxm1$")) item.password = hashPassword(item.password); return createEntity("users", item, "usr"); },
    updateUser: async (x, p) => { const current = bucket("users")[x] || {}; const patch = normalizeUser({ ...current, ...p }); if (patch.password && !String(patch.password).startsWith("lxm1$")) patch.password = hashPassword(patch.password); return updateEntity("users", x, patch); }, deleteUser: (x) => removeEntity("users", x),
    setRoleMenus: async (roleId, menuIds) => { const item = { roleId, menuIds: [...new Set((menuIds || []).map(String))], updatedAt: now() }; bucket("roleMenus")[roleId] = item; persist(); return clone(item); },
    getRoleMenus: async (roleId) => clone(bucket("roleMenus")[roleId] || { roleId, menuIds: [] }),
    setRolePermissions: async (roleId, permissions) => { const item = { roleId, permissions: [...new Set((permissions || []).map(String))], updatedAt: now() }; bucket("rolePermissions")[roleId] = item; persist(); return clone(item); },
    getRolePermissions: async (roleId) => clone(bucket("rolePermissions")[roleId] || { roleId, permissions: [] }),
    async authenticate(account, password) { const found = values("users").find((u) => u.account === String(account).trim()); if (!found || ["disabled", "停用", "禁用"].includes(String(found.status).toLowerCase()) || !verifyPassword(found.password || found.passwordHash, password)) return null; return safeUser(found); },
    async snapshot() { const out = {}; for (const k of AUTHZ_KEYS) out[k] = values(k); return out; },
    async close() {}
  };
}

function createMysql(options) {
  return require("./mysqlPermissionStore.cjs")(options);
}
function createPermissionStore(options = {}) {
  const backend = String(options.backend || process.env.DATA_MODE || process.env.BACKEND || "json").toLowerCase();
  let store;
  try {
    store = backend === "mysql" ? createMysql(options) : createJson(options);
  } catch (error) {
    const fail = async () => { throw error; };
    return {
      mode: backend, backend, required: backend === "mysql", unavailable: true,
      init: fail, health: async () => ({ backend, configured: false, ready: false, persistent: backend === "mysql", error: error.code || "unavailable" }),
      authenticate: fail, findUserByAccount: fail, getUser: fail, getUserState: fail, getPolicyForUser: fail, snapshot: fail,
      listMenus: fail, listRoles: fail, listUsers: fail, getMenu: fail, getRole: fail,
      createMenu: fail, updateMenu: fail, deleteMenu: fail, createRole: fail, updateRole: fail, deleteRole: fail,
      createUser: fail, updateUser: fail, deleteUser: fail, disableUser: fail, restoreUserState: fail,
      setRoleMenus: fail, getRoleMenus: fail, setRolePermissions: fail, getRolePermissions: fail, getRoleGrants: fail,
      setRoleGrants: fail, syncLegacyAccount: fail, close: async () => {}
    };
  }
  // Stable facade consumed by API/bootstrap code. Keep the CRUD names explicit
  // and provide aliases for older callers that used remove* verbs.
  store.required = backend === "mysql";
  const autoMigrate = options.autoMigrate !== undefined ? !!options.autoMigrate : String(process.env.DB_AUTO_MIGRATE || "").toLowerCase() === "true";
  store.init = async () => { if (typeof store.ensureSchema === "function" && (!store.required || autoMigrate)) await store.ensureSchema(); return store; };
  const backendHealth = store.health;
  store.health = async () => {
    try { if (typeof backendHealth === "function") return await backendHealth(); await store.init(); return { backend: store.backend, configured: true, ready: true, persistent: store.required }; }
    catch (e) { return { backend: store.backend, configured: true, ready: false, persistent: store.required, error: e.code || "unavailable" }; }
  };
  store.removeMenu = store.deleteMenu;
  store.removeRole = store.deleteRole;
  store.setRoleGrants = async (roleId, grants = {}) => {
    if (typeof store.setRoleGrantsAtomic === "function") {
      return store.setRoleGrantsAtomic(roleId, grants.menuKeys || grants.menuIds || [], grants.permissionKeys || grants.permissions || []);
    }
    const menus = await store.setRoleMenus(roleId, grants.menuKeys || grants.menuIds || []);
    const permissions = await store.setRolePermissions(roleId, grants.permissionKeys || grants.permissions || []);
    return { roleId, menuKeys: menus.menuKeys || menus.menuIds || [], permissionKeys: permissions.permissionKeys || permissions.permissions || [] };
  };
  store.getPolicyForUser = async (user) => {
    const roleId = user && (user.roleId || user.role_id || user.role);
    let role = roleId && await store.getRole(roleId);
    if (!role && roleId && typeof store.listRoles === "function") role = (await store.listRoles()).find((r) => (r.roleKey || r.code) === roleId) || null;
    const resolvedRoleId = role && role.id ? role.id : roleId;
    const grants = resolvedRoleId ? await store.getRoleGrants(resolvedRoleId) : { menuKeys: [], permissionKeys: [] };
    const menuRows = typeof store.listMenus === "function" ? await store.listMenus() : [];
    const activeMenus = new Set((Array.isArray(menuRows) ? menuRows : [])
      .filter((menu) => !["disabled", "停用", "禁用", "inactive"].includes(String(menu.status || "").toLowerCase()))
      .map((menu) => String(menu.menuKey || menu.key || menu.id || "")));
    const menuKeys = (grants.menuKeys || []).map(String).filter((key) => !menuRows.length || activeMenus.has(key));
    const extra = user && user.extra && typeof user.extra === "object" ? user.extra : {};
    const direct = Array.isArray(user && user.permissionKeys) ? user.permissionKeys : (Array.isArray(extra.permissionKeys) ? extra.permissionKeys : []);
    const roleKey = String(role && (role.roleKey || role.code || role.key) || "").trim().toLowerCase();
    const permissionKeys = [...new Set([...(grants.permissionKeys || []), ...direct].map(String))]
      .filter((key) => roleKey === "super" || (key !== "*" && !AUTHORITY_PERMISSION_KEYS.has(key)));
    return { user: safeUser(user), role: role || null, menuKeys: [...new Set(menuKeys)], permissionKeys };
  };
  store.getRoleGrants = async (roleId) => {
    const menus = await store.getRoleMenus(roleId);
    const permissions = await store.getRolePermissions(roleId);
    return { roleId, menuKeys: menus.menuIds || menus.menuKeys || [], permissionKeys: permissions.permissions || permissions.permissionKeys || [] };
  };
  store.disableUser = async (userId) => store.updateUser(userId, { status: "disabled" });
  store.restoreUserState = async (userId, state) => {
    if (!state) return false;
    const payload = { ...state, id: userId };
    if (state.passwordHash) payload.passwordHash = state.passwordHash;
    return !!(await store.updateUser(userId, payload));
  };
  store.syncLegacyAccount = async (key, doc = {}) => {
    if (!doc || !doc.account) return null;
    const legacyId = String(doc.id || doc._id || `${key}_${doc.account}`);
    const role = normalizeAuthzRole(doc.role || (key === "shops" ? "merchant" : key === "distributors" ? "distributor" : key === "agents" ? "agent" : "service"));
    const existing = await store.getUser(legacyId);
    const previousExtra = existing && existing.extra && typeof existing.extra === "object" ? existing.extra : {};
    const permissionKeys = Array.isArray(doc.permissionKeys) ? doc.permissionKeys : (Array.isArray(doc.permissions) ? doc.permissions : previousExtra.permissionKeys || []);
    const extra = { ...previousExtra, permissionKeys, legacyKey: key, legacyId, subjectType: key === "shops" ? "merchant" : key === "distributors" ? "distributor" : key === "agents" ? "agent" : "staff", subjectId: legacyId, shopId: doc.shopId || previousExtra.shopId || "", distributorId: doc.distributorId || previousExtra.distributorId || "", agentId: doc.agentId || previousExtra.agentId || "" };
    let roleId = doc.roleId || (existing && existing.roleId) || "";
    if (!roleId || String(roleId) === String(role)) {
      try {
        const roles = typeof store.listRoles === "function" ? await store.listRoles() : [];
        const match = (Array.isArray(roles) ? roles : []).find((item) => String(item.roleKey || item.code || item.key || item.id || "") === String(role));
        roleId = match && match.id ? match.id : roleId;
      } catch (_) {}
    }
    if (!roleId) roleId = String(role).startsWith("role_") ? String(role) : `role_${role}`;
    const payload = { id: legacyId, account: doc.account, name: doc.name || doc.title || doc.account, role, roleId, status: doc.status || "active", phone: doc.phone || doc.contactPhone || "", email: doc.email || "", extra, permissionKeys, permissions: permissionKeys };
    if (doc.password || doc.passwordHash) payload.password = doc.password || doc.passwordHash;
    return existing ? store.updateUser(legacyId, payload) : store.createUser(payload);
  };
  return store;
}
createPermissionStore.hashPassword = hashPassword;
createPermissionStore.verifyPassword = verifyPassword;
createPermissionStore.AUTHZ_KEYS = AUTHZ_KEYS;
createPermissionStore.BUSINESS_KEYS = BUSINESS_KEYS;
module.exports = createPermissionStore;
