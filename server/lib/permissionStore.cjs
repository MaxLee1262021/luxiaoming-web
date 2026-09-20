// Normalized authorization storage. This module is intentionally independent
// from the HTTP API so migrations, jobs, and future admin routes share the
// same menu/role/user contract.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUTHZ_KEYS = ["menus", "roles", "roleMenus", "rolePermissions", "users"];
const BUILTIN_ADMIN_ACCOUNT = "admin";
const LEGACY_ROLE_ALIASES = { admin: "super", administrator: "super", photographer: "photo" };
const BUSINESS_KEYS = [
  "cities", "agents", "distributors", "shops", "staff", "spots", "series", "albums", "samples",
  "packages", "addonServices", "peripherals", "tagLibrary", "guides", "stories", "scans", "orders",
  "afterSales", "reconciliationTransfers", "financeSettings", "monthlyClosings", "adjustmentRecords",
  "homeConfig", "logs", "trash", "merchantCodes", "siteConfig", "userProfiles", "config"
];

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }
function now() { return new Date().toISOString(); }
function isBuiltinAdminAccount(user) {
  const account = user && typeof user === "object" ? user.account : user;
  return String(account || "").trim().toLowerCase() === BUILTIN_ADMIN_ACCOUNT;
}
function menuKey(menu) { return String(menu && (menu.menuKey || menu.key || menu.id) || ""); }
function menuParentKey(menu) {
  if (menu && Object.prototype.hasOwnProperty.call(menu, "parentKey")) return String(menu.parentKey || "");
  return String(menu && menu.parentId || "");
}
function normalizeMenu(input = {}, current = {}) {
  const next = { ...(current || {}), ...(input || {}) };
  const hasParentKey = Object.prototype.hasOwnProperty.call(input || {}, "parentKey");
  const hasParentId = Object.prototype.hasOwnProperty.call(input || {}, "parentId");
  if (hasParentKey || hasParentId) {
    const raw = hasParentKey ? input.parentKey : input.parentId;
    const parent = raw === undefined || raw === null ? "" : String(raw).trim();
    next.parentKey = parent || null;
    next.parentId = parent || null;
  } else if (Object.prototype.hasOwnProperty.call(next, "parentKey")) {
    const parent = String(next.parentKey || "").trim();
    next.parentKey = parent || null;
    next.parentId = parent || null;
  }
  return next;
}
function menuEnabled(menu) {
  return !["disabled", "停用", "禁用", "inactive"].includes(String(menu && menu.status || "").trim().toLowerCase());
}

// A role may select a second-level entry directly. Validate its enabled parent
// chain here, but keep the parent out of menuKeys so navigation authorization
// never expands from a child to its container page.
function effectiveMenuKeys(menuRows, sourceKeys) {
  const rows = Array.isArray(menuRows) ? menuRows : [];
  const byKey = new Map(rows.map((menu) => [menuKey(menu), menu]).filter(([key]) => key));
  const requested = [...new Set((Array.isArray(sourceKeys) ? sourceKeys : []).map(String).filter(Boolean))];
  const allowed = new Set();
  for (const requestedKey of requested) {
    const seen = new Set();
    let current = byKey.get(requestedKey);
    let valid = !!current;
    let depth = 0;
    while (current) {
      const key = menuKey(current);
      depth += 1;
      if (!key || seen.has(key) || !menuEnabled(current) || depth > 2) {
        valid = false;
        break;
      }
      seen.add(key);
      const parentKey = menuParentKey(current);
      if (!parentKey) break;
      current = byKey.get(parentKey);
      if (!current) {
        valid = false;
        break;
      }
    }
    if (valid) allowed.add(requestedKey);
  }
  return rows.map(menuKey).filter((key) => allowed.has(key));
}

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
  const { password, passwordHash, password_hash, permissions, permissionKeys, ...rest } = user;
  const scrub = (value) => {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(scrub);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (/password|token|secret|private.?key|authorization|^permissions$|^permissionKeys$/i.test(key)) continue;
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
  delete out.permissions;
  delete out.permissionKeys;
  if (out.extra && typeof out.extra === "object" && !Array.isArray(out.extra)) {
    out.extra = { ...out.extra };
    delete out.extra.permissions;
    delete out.extra.permissionKeys;
  }
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
  function canonicalMenu(input = {}, current = {}) {
    const next = normalizeMenu(input, current);
    const parent = String(next.parentKey || "");
    if (parent) {
      const match = Object.values(bucket("menus")).find((menu) => menuKey(menu) === parent || String(menu && menu.id || "") === parent);
      if (match) {
        next.parentKey = menuKey(match);
        next.parentId = next.parentKey;
      }
    }
    return next;
  }
  async function listMenus() { return values("menus").map((menu) => canonicalMenu(menu)); }
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
    listMenus, getMenu: async (x) => { const row = bucket("menus")[x]; return row ? clone(canonicalMenu(row)) : null; }, createMenu: (x) => createEntity("menus", canonicalMenu(x), "menu"), updateMenu: async (x, p) => updateEntity("menus", x, canonicalMenu(p, bucket("menus")[x] || {})), deleteMenu: (x) => removeEntity("menus", x),
    listRoles, getRole: async (x) => clone(bucket("roles")[x] || null), createRole: (x) => createEntity("roles", x, "role"), updateRole: (x, p) => updateEntity("roles", x, p), deleteRole: async (x) => { if (!bucket("roles")[x]) return false; delete bucket("roles")[x]; delete bucket("roleMenus")[x]; persist(); return true; },
    listUsers, getUser: async (x) => safeUser(bucket("users")[x]), getUserState: async (x) => clone(bucket("users")[x] || null), createUser: async (x) => { const item = normalizeUser(x); if (item.password && !String(item.password).startsWith("lxm1$")) item.password = hashPassword(item.password); return createEntity("users", item, "usr"); },
    updateUser: async (x, p) => { const current = bucket("users")[x] || {}; const patch = normalizeUser({ ...current, ...p }); if (patch.password && !String(patch.password).startsWith("lxm1$")) patch.password = hashPassword(patch.password); return updateEntity("users", x, patch); }, deleteUser: (x) => removeEntity("users", x),
    setRoleMenus: async (roleId, menuIds) => { const item = { roleId, menuIds: [...new Set((menuIds || []).map(String))], updatedAt: now() }; bucket("roleMenus")[roleId] = item; persist(); return clone(item); },
    getRoleMenus: async (roleId) => clone(bucket("roleMenus")[roleId] || { roleId, menuIds: [] }),
    // Legacy action grants remain in the JSON document for compatibility, but
    // the active authorization policy is menu-only.
    setRolePermissions: async (roleId) => ({ roleId }),
    getRolePermissions: async (roleId) => ({ roleId }),
    async authenticate(account, password, options = {}) {
      const found = values("users").find((user) => user.account === String(account).trim());
      if (!found || !verifyPassword(found.password || found.passwordHash, password)) return null;
      const disabled = ["disabled", "停用", "禁用", "inactive"].includes(String(found.status || "").toLowerCase());
      if (disabled && options.includeDisabled !== true) return null;
      return safeUser(found);
    },
    async snapshot() { return { menus: values("menus"), roles: values("roles"), roleMenus: values("roleMenus"), users: await listUsers() }; },
    async close() {}
  };
}

function createMysql(options) {
  return require("./mysqlPermissionStore.cjs")(options);
}
function createPermissionStore(options = {}) {
  const backend = String(options.backend || process.env.DATA_MODE || process.env.BACKEND || "mysql").toLowerCase();
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
    const menus = await store.setRoleMenus(roleId, grants.menuKeys || grants.menuIds || []);
    return { roleId, menuKeys: menus.menuKeys || menus.menuIds || [] };
  };
  store.getPolicyForUser = async (user) => {
    const roleId = user && (user.roleId || user.role_id || user.role);
    let role = roleId && await store.getRole(roleId);
    if (!role && roleId && typeof store.listRoles === "function") role = (await store.listRoles()).find((r) => (r.roleKey || r.code) === roleId) || null;
    const menuRows = typeof store.listMenus === "function" ? await store.listMenus() : [];
    const roleKey = String(role && (role.roleKey || role.code || role.key) || "").trim().toLowerCase();
    if (isBuiltinAdminAccount(user)) {
      const roles = typeof store.listRoles === "function" ? await store.listRoles() : [];
      const superRole = (Array.isArray(roles) ? roles : []).find((item) => String(item.roleKey || item.code || item.key || "") === "super") || {};
      return {
        user: safeUser(user),
        role: { ...superRole, id: superRole.id || "role_super", roleKey: "super", key: "super", name: superRole.name || "系统管理员", status: "active" },
        menuKeys: effectiveMenuKeys(menuRows, (Array.isArray(menuRows) ? menuRows : []).map(menuKey)),
        isBuiltinAdmin: true
      };
    }
    const resolvedRoleId = role && role.id ? role.id : roleId;
    const grants = roleKey === "super"
      ? { menuKeys: (Array.isArray(menuRows) ? menuRows : []).map(menuKey) }
      : (resolvedRoleId ? await store.getRoleGrants(resolvedRoleId) : { menuKeys: [] });
    return { user: safeUser(user), role: role || null, menuKeys: effectiveMenuKeys(menuRows, grants.menuKeys) };
  };
  store.getRoleGrants = async (roleId) => {
    const menus = await store.getRoleMenus(roleId);
    return { roleId, menuKeys: menus.menuIds || menus.menuKeys || [] };
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
    const previousExtra = existing && existing.extra && typeof existing.extra === "object" ? { ...existing.extra } : {};
    delete previousExtra.permissions;
    delete previousExtra.permissionKeys;
    const extra = { ...previousExtra, legacyKey: key, legacyId, subjectType: key === "shops" ? "merchant" : key === "distributors" ? "distributor" : key === "agents" ? "agent" : "staff", subjectId: legacyId, shopId: doc.shopId || previousExtra.shopId || "", distributorId: doc.distributorId || previousExtra.distributorId || "", agentId: doc.agentId || previousExtra.agentId || "" };
    let roleId = doc.roleId || (existing && existing.roleId) || "";
    if (!roleId || String(roleId) === String(role)) {
      try {
        const roles = typeof store.listRoles === "function" ? await store.listRoles() : [];
        const match = (Array.isArray(roles) ? roles : []).find((item) => String(item.roleKey || item.code || item.key || item.id || "") === String(role));
        roleId = match && match.id ? match.id : roleId;
      } catch (_) {}
    }
    if (!roleId) roleId = String(role).startsWith("role_") ? String(role) : `role_${role}`;
    const payload = { id: legacyId, account: doc.account, name: doc.name || doc.title || doc.account, role, roleId, status: doc.status || "active", phone: doc.phone || doc.contactPhone || "", email: doc.email || "", extra };
    if (doc.password || doc.passwordHash) payload.password = doc.password || doc.passwordHash;
    return existing ? store.updateUser(legacyId, payload) : store.createUser(payload);
  };
  return store;
}
createPermissionStore.hashPassword = hashPassword;
createPermissionStore.verifyPassword = verifyPassword;
createPermissionStore.isBuiltinAdminAccount = isBuiltinAdminAccount;
createPermissionStore.AUTHZ_KEYS = AUTHZ_KEYS;
createPermissionStore.BUSINESS_KEYS = BUSINESS_KEYS;
module.exports = createPermissionStore;
