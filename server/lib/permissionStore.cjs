// Normalized authorization storage. This module is intentionally independent
// from the HTTP API so migrations, jobs, and future admin routes share the
// same menu/role/user contract.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUTHZ_KEYS = ["menus", "roles", "roleMenus", "rolePermissions", "users"];
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
  const { password, passwordHash, ...rest } = user;
  return clone(rest);
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
    listRoles, getRole: async (x) => clone(bucket("roles")[x] || null), createRole: (x) => createEntity("roles", x, "role"), updateRole: (x, p) => updateEntity("roles", x, p), deleteRole: (x) => removeEntity("roles", x),
    listUsers, getUser: async (x) => safeUser(bucket("users")[x]), createUser: async (x) => { const item = normalizeUser(x); if (item.password && !String(item.password).startsWith("lxm1$")) item.password = hashPassword(item.password); return createEntity("users", item, "usr"); },
    updateUser: async (x, p) => { const patch = normalizeUser(p); if (patch.password && !String(patch.password).startsWith("lxm1$")) patch.password = hashPassword(patch.password); return updateEntity("users", x, patch); }, deleteUser: (x) => removeEntity("users", x),
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
  let mysql;
  try { mysql = require("mysql2/promise"); } catch (_) { throw Object.assign(new Error("MySQL 驱动未安装"), { code: "DATA_SOURCE_UNAVAILABLE" }); }
  if (!options.dbHost || !options.dbUser || !options.dbName) throw Object.assign(new Error("MySQL 配置不完整"), { code: "DATA_SOURCE_CONFIG_INVALID" });
  const pool = mysql.createPool({ host: options.dbHost, port: options.dbPort || 3306, user: options.dbUser, password: options.dbPassword, database: options.dbName, waitForConnections: true, connectionLimit: options.connectionLimit || 10, connectTimeout: options.connectTimeout || 3000, multipleStatements: false });
  const tables = { menus: "lxm_auth_menus", roles: "lxm_auth_roles", roleMenus: "lxm_auth_role_menus", rolePermissions: "lxm_auth_role_permissions", users: "lxm_auth_users" };
  async function q(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; }
  async function ensureSchema() { const ddl = [
    `CREATE TABLE IF NOT EXISTS lxm_auth_menus (id VARCHAR(64) PRIMARY KEY, menu_key VARCHAR(128) NOT NULL UNIQUE, parent_key VARCHAR(128) NULL, name VARCHAR(128) NOT NULL, path VARCHAR(255) NOT NULL, icon VARCHAR(64) NULL, sort_no INT NOT NULL DEFAULT 0, status VARCHAR(32) NOT NULL DEFAULT 'active', meta JSON NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_menu_parent (parent_key), KEY idx_menu_status (status))`,
    `CREATE TABLE IF NOT EXISTS lxm_auth_roles (id VARCHAR(64) PRIMARY KEY, role_key VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', description VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lxm_auth_role_menus (role_id VARCHAR(64) NOT NULL, menu_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL, PRIMARY KEY(role_id,menu_key), KEY idx_rm_menu(menu_key))`,
    `CREATE TABLE IF NOT EXISTS lxm_auth_role_permissions (role_id VARCHAR(64) NOT NULL, permission_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL, PRIMARY KEY(role_id,permission_key))`,
    `CREATE TABLE IF NOT EXISTS lxm_auth_users (id VARCHAR(64) PRIMARY KEY, account VARCHAR(128) NOT NULL UNIQUE, display_name VARCHAR(128) NOT NULL, password_hash VARCHAR(255) NOT NULL, role_id VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', phone VARCHAR(64) NULL, email VARCHAR(255) NULL, extra JSON NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, KEY idx_user_role(role_id), KEY idx_user_status(status))`
  ]; for (const sql of ddl) await pool.query(sql); return { backend: "mysql", ready: true }; }
  const dt = () => new Date();
  async function listMenus() { const rows = await q(`SELECT id,menu_key menuKey,parent_key parentKey,name,path,icon,sort_no sortNo,status,meta,created_at createdAt,updated_at updatedAt FROM ${tables.menus} ORDER BY sort_no,id`); return rows.map((r) => ({ ...r, meta: parseJson(r.meta) })); }
  async function listRoles() { return q(`SELECT id,role_key roleKey,name,status,description,created_at createdAt,updated_at updatedAt FROM ${tables.roles} ORDER BY name`); }
  async function listUsers() { const rows = await q(`SELECT id,account,display_name name,role_id roleId,status,phone,email,extra,created_at createdAt,updated_at updatedAt FROM ${tables.users} ORDER BY display_name`); return rows.map((r) => ({ ...r, extra: parseJson(r.extra) })); }
  async function one(table, entityId, cols) { const rows = await q(`SELECT ${cols} FROM ${table} WHERE id=?`, [entityId]); return rows[0] || null; }
  async function upsertMenu(data, entityId) { const idv = entityId || data.id || id("menu"), t = dt(); await pool.query(`INSERT INTO ${tables.menus} (id,menu_key,parent_key,name,path,icon,sort_no,status,meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE menu_key=VALUES(menu_key),parent_key=VALUES(parent_key),name=VALUES(name),path=VALUES(path),icon=VALUES(icon),sort_no=VALUES(sort_no),status=VALUES(status),meta=VALUES(meta),updated_at=VALUES(updated_at)`, [idv, data.menuKey || data.key || data.path || idv, data.parentKey || null, data.name || "", data.path || "", data.icon || null, Number(data.sortNo) || 0, data.status || "active", JSON.stringify(data.meta || {}), t, t]); return (await listMenus()).find((x) => x.id === idv) || null; }
  return { mode: "mysql", backend: "mysql", ensureSchema, listMenus, getMenu: (x) => one(tables.menus, x, "id,parent_id parentId,name,path,icon,sort_no sortNo,status,meta,created_at createdAt,updated_at updatedAt"), createMenu: (x) => upsertMenu(x), updateMenu: (x,p) => upsertMenu(p,x), deleteMenu: async (x) => (await pool.query(`DELETE FROM ${tables.menus} WHERE id=?`, [x]))[0].affectedRows > 0,
    listRoles, getRole: (x) => one(tables.roles, x, "id,role_key roleKey,name,status,description,created_at createdAt,updated_at updatedAt"), createRole: async (x) => { const idv = x.id || id("role"), t = dt(); await pool.query(`INSERT INTO ${tables.roles} (id,role_key,name,status,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [idv,x.roleKey || x.code || idv,x.name,x.status||"active",x.description||null,t,t]); return one(tables.roles,idv,"id,role_key roleKey,name,status,description,created_at createdAt,updated_at updatedAt"); }, updateRole: async (x,p) => { await pool.query(`UPDATE ${tables.roles} SET role_key=?,name=?,status=?,description=?,updated_at=? WHERE id=?`, [p.roleKey || p.code,p.name,p.status||"active",p.description||null,dt(),x]); return one(tables.roles,x,"id,role_key roleKey,name,status,description,created_at createdAt,updated_at updatedAt"); }, deleteRole: async (x) => (await pool.query(`DELETE FROM ${tables.roles} WHERE id=?`, [x]))[0].affectedRows > 0,
    listUsers, getUser: async (x) => one(tables.users,x,"id,account,display_name name,role_id roleId,status,phone,email,extra,created_at createdAt,updated_at updatedAt"), createUser: async (x) => userUpsert(x), updateUser: async (x,p) => userUpsert(p,x), deleteUser: async (x) => (await pool.query(`DELETE FROM ${tables.users} WHERE id=?`, [x]))[0].affectedRows > 0,
    setRoleMenus: async (roleId, menuIds) => { await pool.query(`DELETE FROM ${tables.roleMenus} WHERE role_id=?`, [roleId]); for (const menuKey of new Set(menuIds || [])) await pool.query(`INSERT INTO ${tables.roleMenus} (role_id,menu_key,created_at) VALUES (?,?,?)`, [roleId,menuKey,dt()]); return { roleId, menuKeys: [...new Set(menuIds || [])] }; }, getRoleMenus: async (roleId) => ({ roleId, menuKeys: (await q(`SELECT menu_key FROM ${tables.roleMenus} WHERE role_id=?`,[roleId])).map((x)=>x.menu_key) }),
    setRolePermissions: async (roleId, permissions) => { await pool.query(`DELETE FROM ${tables.rolePermissions} WHERE role_id=?`,[roleId]); for (const key of new Set(permissions || [])) await pool.query(`INSERT INTO ${tables.rolePermissions} (role_id,permission_key,created_at) VALUES (?,?,?)`,[roleId,key,dt()]); return { roleId, permissions: [...new Set(permissions || [])] }; }, getRolePermissions: async (roleId) => ({ roleId, permissions: (await q(`SELECT permission_key FROM ${tables.rolePermissions} WHERE role_id=?`,[roleId])).map((x)=>x.permission_key) }),
    authenticate: async (account,password) => { const rows = await q(`SELECT * FROM ${tables.users} WHERE account=? LIMIT 1`,[String(account).trim()]); const row=rows[0]; if(!row || ["disabled","停用","禁用"].includes(String(row.status).toLowerCase()) || !verifyPassword(row.password_hash,password)) return null; return safeUser({ id:row.id,account:row.account,name:row.name,roleId:row.role_id,status:row.status,phone:row.phone,email:row.email,extra:parseJson(row.extra) }); },
    async health() { try { await q("SELECT 1 AS ok"); const rows = await q("SELECT COUNT(*) count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (?,?,?,?,?)", Object.values(tables)); return { backend: "mysql", configured: true, ready: Number(rows[0] && rows[0].count) === 5, persistent: true, tables: Number(rows[0] && rows[0].count) }; } catch (e) { return { backend: "mysql", configured: true, ready: false, persistent: true, error: e.code || "unavailable" }; } },
    async snapshot() { return { menus: await listMenus(), roles: await listRoles(), roleMenus: await q(`SELECT role_id roleId,menu_key menuKey FROM ${tables.roleMenus}`), rolePermissions: await q(`SELECT role_id roleId,permission_key permissionKey FROM ${tables.rolePermissions}`), users: await listUsers() }; },
    async close() { await pool.end(); }
  };
  async function userUpsert(input, entityId) { const u=normalizeUser(input), idv=entityId||u.id||id("usr"), t=dt(), hash=u.password && String(u.password).startsWith("lxm1$") ? u.password : hashPassword(u.password || crypto.randomBytes(18).toString("hex")); await pool.query(`INSERT INTO ${tables.users} (id,account,display_name,password_hash,role_id,status,phone,email,extra,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE account=VALUES(account),display_name=VALUES(display_name),password_hash=VALUES(password_hash),role_id=VALUES(role_id),status=VALUES(status),phone=VALUES(phone),email=VALUES(email),extra=VALUES(extra),updated_at=VALUES(updated_at)`,[idv,u.account,u.name,hash,u.roleId||u.role||"service",u.status||"active",u.phone||null,u.email||null,JSON.stringify(u.extra||{}),t,t]); return one(tables.users,idv,"id,account,display_name name,role_id roleId,status,phone,email,extra,created_at createdAt,updated_at updatedAt"); }
}
function parseJson(v) { if (v == null || typeof v === "object") return v || {}; try { return JSON.parse(v); } catch (_) { return {}; } }

function createPermissionStore(options = {}) {
  const backend = String(options.backend || process.env.DATA_MODE || process.env.BACKEND || "json").toLowerCase();
  const store = backend === "mysql" ? createMysql(options) : createJson(options);
  // Stable facade consumed by API/bootstrap code. Keep the CRUD names explicit
  // and provide aliases for older callers that used remove* verbs.
  store.required = backend === "mysql";
  store.init = async () => { if (typeof store.ensureSchema === "function" && (!store.required || String(process.env.DB_AUTO_MIGRATE || "").toLowerCase() === "true")) await store.ensureSchema(); return store; };
  const backendHealth = store.health;
  store.health = async () => {
    try { if (typeof backendHealth === "function") return await backendHealth(); await store.init(); return { backend: store.backend, configured: true, ready: true, persistent: store.required }; }
    catch (e) { return { backend: store.backend, configured: true, ready: false, persistent: store.required, error: e.code || "unavailable" }; }
  };
  store.removeMenu = store.deleteMenu;
  store.removeRole = store.deleteRole;
  store.setRoleGrants = async (roleId, grants = {}) => {
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
    return { user: safeUser(user), role: role || null, menuKeys: grants.menuKeys, permissionKeys: grants.permissionKeys };
  };
  store.getRoleGrants = async (roleId) => {
    const menus = await store.getRoleMenus(roleId);
    const permissions = await store.getRolePermissions(roleId);
    return { roleId, menuKeys: menus.menuIds || menus.menuKeys || [], permissionKeys: permissions.permissions || permissions.permissionKeys || [] };
  };
  store.disableUser = async (userId) => store.updateUser(userId, { status: "disabled" });
  store.syncLegacyAccount = async (key, doc = {}) => {
    if (!doc || !doc.account) return null;
    const legacyId = String(doc.id || doc._id || `${key}_${doc.account}`);
    const role = doc.role || (key === "shops" ? "merchant" : key === "distributors" ? "distributor" : key === "agents" ? "agent" : "service");
    const existing = await store.getUser(legacyId);
    const payload = { id: legacyId, account: doc.account, name: doc.name || doc.title || doc.account, role, roleId: doc.roleId || role, status: doc.status || "active", phone: doc.phone || doc.contactPhone || "", email: doc.email || "", extra: { legacyKey: key, legacyId }, password: doc.password || doc.passwordHash || crypto.randomBytes(18).toString("hex") };
    return existing ? store.updateUser(legacyId, payload) : store.createUser(payload);
  };
  return store;
}
createPermissionStore.hashPassword = hashPassword;
createPermissionStore.verifyPassword = verifyPassword;
createPermissionStore.AUTHZ_KEYS = AUTHZ_KEYS;
createPermissionStore.BUSINESS_KEYS = BUSINESS_KEYS;
module.exports = createPermissionStore;
