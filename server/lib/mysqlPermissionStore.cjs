"use strict";

// Relational authorization store.  The public permission-store contract still
// exposes `meta`/`extra` objects, but MySQL stores their declared fields and
// typed attribute leaves in separate columns/rows.  No credential or object
// payload is serialized into a single database column.
const crypto = require("crypto");

const TABLES = Object.freeze({
  menus: "lxm_auth_menus",
  roles: "lxm_auth_roles",
  roleMenus: "lxm_auth_role_menus",
  rolePermissions: "lxm_auth_role_permissions",
  userPermissions: "lxm_auth_user_permissions",
  users: "lxm_auth_users",
  menuAttributes: "lxm_auth_menu_attributes",
  userAttributes: "lxm_auth_user_attributes"
});
const DISABLED = new Set(["disabled", "停用", "禁用", "inactive"]);
const SENSITIVE = /password|token|secret|private.?key|authorization/i;

function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }
function now() { return new Date(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function parseObject(value) {
  if (value == null) return {};
  if (typeof value === "object") {
    if (Array.isArray(value)) throw Object.assign(new Error("旧版权限载荷格式无效"), { code: "DATA_SOURCE_INVALID" });
    return value;
  }
  let parsed;
  try { parsed = JSON.parse(String(value)); }
  catch (_) { throw Object.assign(new Error("旧版权限载荷格式无效"), { code: "DATA_SOURCE_INVALID" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("旧版权限载荷格式无效"), { code: "DATA_SOURCE_INVALID" });
  return parsed;
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
  const scrub = (value) => {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    if (Array.isArray(value)) return value.map(scrub);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE.test(key)) continue;
      out[key] = scrub(child);
    }
    return out;
  };
  const { password, passwordHash, password_hash, ...rest } = user;
  return clone(scrub(rest));
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}
function flatten(value, path, output) {
  if (value === undefined || SENSITIVE.test(String(path).split(/[.\[]/).pop() || "")) return;
  if (Array.isArray(value)) {
    if (!value.length) output.push({ path, ordinal: 0, value_type: "array", value_text: null, value_number: null, value_bool: null });
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, output));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => !SENSITIVE.test(key));
    if (!entries.length) output.push({ path, ordinal: 0, value_type: "object", value_text: null, value_number: null, value_bool: null });
    entries.forEach(([key, child]) => flatten(child, path ? `${path}.${key}` : key, output));
    return;
  }
  const type = valueType(value);
  output.push({
    path,
    ordinal: 0,
    value_type: type,
    value_text: type === "string" ? (value == null ? null : String(value)) : null,
    value_number: type === "number" && Number.isFinite(value) ? value : null,
    value_bool: type === "boolean" ? (value ? 1 : 0) : null
  });
}
function parseAttribute(row) {
  if (row.value_type === "array") return [];
  if (row.value_type === "object") return {};
  if (row.value_type === "null") return null;
  if (row.value_type === "boolean") return !!Number(row.value_bool);
  if (row.value_type === "number") return row.value_number == null ? null : Number(row.value_number);
  return row.value_text == null ? "" : String(row.value_text);
}
function setPath(target, path, value) {
  const tokens = [];
  String(path || "").replace(/([^.[\]]+)|\[(\d+)\]/g, (_, key, index) => tokens.push(index === undefined ? key : Number(index)));
  if (!tokens.length) return;
  let cursor = target;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const next = tokens[i + 1];
    if (!cursor[tokens[i]] || typeof cursor[tokens[i]] !== "object") cursor[tokens[i]] = typeof next === "number" ? [] : {};
    cursor = cursor[tokens[i]];
  }
  cursor[tokens[tokens.length - 1]] = value;
}
function hydrateAttributes(rows) {
  const out = {};
  for (const row of rows || []) setPath(out, row.path, parseAttribute(row));
  return out;
}
function normalizeUser(input = {}) {
  const out = { ...input };
  out.account = String(out.account || out.username || "").trim();
  out.name = String(out.name || out.displayName || out.account).trim();
  out.role = String(out.role || "service").trim().toLowerCase();
  out.status = out.status || "active";
  return out;
}

module.exports = function createMysqlPermissionStore(options = {}) {
  let mysql = null;
  if (!options.pool) {
    try { mysql = require("mysql2/promise"); }
    catch (_) { throw Object.assign(new Error("MySQL 驱动未安装"), { code: "DATA_SOURCE_UNAVAILABLE" }); }
  }
  if (!options.pool && (!options.dbHost || !options.dbUser || !options.dbName)) throw Object.assign(new Error("MySQL 配置不完整"), { code: "DATA_SOURCE_CONFIG_INVALID" });
  const pool = options.pool || mysql.createPool({
    host: options.dbHost, port: options.dbPort || 3306, user: options.dbUser,
    password: options.dbPassword || "", database: options.dbName, waitForConnections: true,
    connectionLimit: options.connectionLimit || 10, connectTimeout: options.connectTimeout || 3000,
    multipleStatements: false, ...(options.dbSsl ? { ssl: { rejectUnauthorized: true } } : {})
  });
  const autoMigrate = options.autoMigrate === true || String(options.autoMigrate ?? process.env.DB_AUTO_MIGRATE ?? "false").toLowerCase() === "true";
  let ensurePromise = null;
  let schemaReady = false;
  let closed = false;

  async function query(conn, sql, params = []) { const [rows] = await conn.query(sql, params); return rows; }
  async function execute(conn, sql, params = []) { const [result] = await conn.query(sql, params); return result; }
  async function withTransaction(work) {
    if (typeof pool.getConnection !== "function") return work(pool);
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); const result = await work(conn); await conn.commit(); return result; }
    catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
    finally { try { conn.release(); } catch (_) {} }
  }
  const ddl = [
    `CREATE TABLE IF NOT EXISTS ${TABLES.menus} (id VARCHAR(128) NOT NULL, menu_key VARCHAR(128) NOT NULL, parent_key VARCHAR(128) NULL, name VARCHAR(128) NOT NULL, path VARCHAR(255) NOT NULL, icon VARCHAR(64) NULL, sort_no INT NOT NULL DEFAULT 0, status VARCHAR(32) NOT NULL DEFAULT 'active', meta_group VARCHAR(64) NULL, meta_type VARCHAR(64) NULL, meta_label VARCHAR(128) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(id), UNIQUE KEY uq_auth_menu_key(menu_key), KEY idx_auth_menu_parent(parent_key), KEY idx_auth_menu_status(status)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${TABLES.roles} (id VARCHAR(128) NOT NULL, role_key VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', description VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(id), UNIQUE KEY uq_auth_role_key(role_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${TABLES.roleMenus} (role_id VARCHAR(128) NOT NULL, menu_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(role_id,menu_key), KEY idx_auth_rm_menu(menu_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${TABLES.rolePermissions} (role_id VARCHAR(128) NOT NULL, permission_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(role_id,permission_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${TABLES.userPermissions} (user_id VARCHAR(128) NOT NULL, permission_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(user_id,permission_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${TABLES.users} (id VARCHAR(128) NOT NULL, account VARCHAR(128) NOT NULL, display_name VARCHAR(128) NOT NULL, password_hash VARCHAR(255) NOT NULL, role_id VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', phone VARCHAR(64) NULL, email VARCHAR(255) NULL, legacy_key VARCHAR(64) NULL, legacy_id VARCHAR(128) NULL, subject_type VARCHAR(64) NULL, subject_id VARCHAR(128) NULL, shop_id VARCHAR(128) NULL, distributor_id VARCHAR(128) NULL, agent_id VARCHAR(128) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(id), UNIQUE KEY uq_auth_user_account(account), KEY idx_auth_user_role(role_id), KEY idx_auth_user_status(status), KEY idx_auth_user_subject(subject_type,subject_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${TABLES.menuAttributes} (menu_id VARCHAR(128) NOT NULL, attribute_key VARCHAR(128) NOT NULL, ordinal INT NOT NULL DEFAULT 0, value_type VARCHAR(16) NOT NULL, value_text TEXT NULL, value_number DECIMAL(20,6) NULL, value_bool TINYINT(1) NULL, PRIMARY KEY(menu_id,attribute_key,ordinal)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ${TABLES.userAttributes} (user_id VARCHAR(128) NOT NULL, attribute_key VARCHAR(128) NOT NULL, ordinal INT NOT NULL DEFAULT 0, value_type VARCHAR(16) NOT NULL, value_text TEXT NULL, value_number DECIMAL(20,6) NULL, value_bool TINYINT(1) NULL, PRIMARY KEY(user_id,attribute_key,ordinal)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  async function columnsFor(table) {
    const rows = await query(pool, "SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=?", [table]);
    return new Set(rows.map((row) => String(row.column_name || row.COLUMN_NAME || "")).filter(Boolean));
  }
  async function addColumn(table, columns, name, type) {
    if (columns.has(name)) return;
    await execute(pool, `ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    columns.add(name);
  }
  async function replaceAttributes(table, idColumn, idValue, attributes) {
    await execute(pool, `DELETE FROM ${table} WHERE ${idColumn}=?`, [idValue]);
    for (const row of attributes) await execute(pool, `INSERT INTO ${table} (${idColumn},attribute_key,ordinal,value_type,value_text,value_number,value_bool) VALUES (?,?,?,?,?,?,?)`, [idValue, row.path, row.ordinal, row.value_type, row.value_text, row.value_number, row.value_bool]);
  }
  async function repairLegacySchema() {
    const coreWidths = {
      [TABLES.menus]: [["id", "VARCHAR(128) NOT NULL"], ["menu_key", "VARCHAR(128) NOT NULL"], ["parent_key", "VARCHAR(128) NULL"]],
      [TABLES.roles]: [["id", "VARCHAR(128) NOT NULL"], ["role_key", "VARCHAR(64) NOT NULL"]],
      [TABLES.roleMenus]: [["role_id", "VARCHAR(128) NOT NULL"], ["menu_key", "VARCHAR(128) NOT NULL"]],
      [TABLES.rolePermissions]: [["role_id", "VARCHAR(128) NOT NULL"], ["permission_key", "VARCHAR(128) NOT NULL"]],
      [TABLES.userPermissions]: [["user_id", "VARCHAR(128) NOT NULL"], ["permission_key", "VARCHAR(128) NOT NULL"]],
      [TABLES.users]: [["id", "VARCHAR(128) NOT NULL"], ["account", "VARCHAR(128) NOT NULL"], ["role_id", "VARCHAR(128) NOT NULL"]]
    };
    for (const [table, columns] of Object.entries(coreWidths)) {
      const existing = await columnsFor(table);
      for (const [name, type] of columns) if (existing.has(name)) await execute(pool, `ALTER TABLE ${table} MODIFY COLUMN ${name} ${type}`);
    }
    const menuColumns = await columnsFor(TABLES.menus);
    for (const [name, type] of [["meta_group", "VARCHAR(64) NULL"], ["meta_type", "VARCHAR(64) NULL"], ["meta_label", "VARCHAR(128) NULL"]]) await addColumn(TABLES.menus, menuColumns, name, type);
    if (menuColumns.has("meta")) {
      const rows = await query(pool, `SELECT id,meta FROM ${TABLES.menus}`);
      for (const row of rows) {
        const meta = parseObject(row.meta);
        await execute(pool, `UPDATE ${TABLES.menus} SET meta_group=?,meta_type=?,meta_label=? WHERE id=?`, [meta.group || null, meta.type || null, meta.label || null, row.id]);
        const attrs = [];
        flatten(Object.fromEntries(Object.entries(meta).filter(([key]) => !["group", "type", "label"].includes(key))), "meta", attrs);
        await replaceAttributes(TABLES.menuAttributes, "menu_id", row.id, attrs);
      }
      await execute(pool, `ALTER TABLE ${TABLES.menus} DROP COLUMN meta`);
    }
    const userColumns = await columnsFor(TABLES.users);
    for (const [name, type] of [["legacy_key", "VARCHAR(64) NULL"], ["legacy_id", "VARCHAR(128) NULL"], ["subject_type", "VARCHAR(64) NULL"], ["subject_id", "VARCHAR(128) NULL"], ["shop_id", "VARCHAR(128) NULL"], ["distributor_id", "VARCHAR(128) NULL"], ["agent_id", "VARCHAR(128) NULL"]]) await addColumn(TABLES.users, userColumns, name, type);
    if (userColumns.has("extra")) {
      const rows = await query(pool, `SELECT id,extra FROM ${TABLES.users}`);
      for (const row of rows) {
        const extra = parseObject(row.extra);
        await execute(pool, `UPDATE ${TABLES.users} SET legacy_key=?,legacy_id=?,subject_type=?,subject_id=?,shop_id=?,distributor_id=?,agent_id=? WHERE id=?`, [extra.legacyKey || null, extra.legacyId || null, extra.subjectType || null, extra.subjectId || null, extra.shopId || null, extra.distributorId || null, extra.agentId || null, row.id]);
        const permissionKeys = Array.isArray(extra.permissionKeys) ? extra.permissionKeys : Array.isArray(extra.permissions) ? extra.permissions : [];
        await execute(pool, `DELETE FROM ${TABLES.userPermissions} WHERE user_id=?`, [row.id]);
        for (const permission of new Set(permissionKeys.map(String).filter(Boolean))) await execute(pool, `INSERT INTO ${TABLES.userPermissions} (user_id,permission_key) VALUES (?,?) ON DUPLICATE KEY UPDATE permission_key=VALUES(permission_key)`, [row.id, permission]);
        const known = new Set(["legacyKey", "legacyId", "subjectType", "subjectId", "shopId", "distributorId", "agentId", "permissionKeys", "permissions"]);
        const attrs = [];
        for (const [key, value] of Object.entries(extra)) if (!known.has(key)) flatten(value, key, attrs);
        await replaceAttributes(TABLES.userAttributes, "user_id", row.id, attrs);
      }
      await execute(pool, `ALTER TABLE ${TABLES.users} DROP COLUMN extra`);
    }
    for (const table of [TABLES.menuAttributes, TABLES.userAttributes]) {
      const columns = await columnsFor(table);
      if (table === TABLES.menuAttributes && columns.has("menu_id")) await execute(pool, `ALTER TABLE ${table} MODIFY COLUMN menu_id VARCHAR(128) NOT NULL`);
      if (table === TABLES.userAttributes && columns.has("user_id")) await execute(pool, `ALTER TABLE ${table} MODIFY COLUMN user_id VARCHAR(128) NOT NULL`);
      await addColumn(table, columns, "value_type", "VARCHAR(16) NOT NULL DEFAULT 'string'");
    }
    for (const table of [TABLES.menus, TABLES.roles, TABLES.roleMenus, TABLES.rolePermissions, TABLES.userPermissions, TABLES.users]) {
      const columns = await columnsFor(table);
      if (!columns.has("created_at")) await execute(pool, `ALTER TABLE ${table} ADD COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
      else {
        await execute(pool, `UPDATE ${table} SET created_at=CURRENT_TIMESTAMP(3) WHERE created_at IS NULL`);
        await execute(pool, `ALTER TABLE ${table} MODIFY COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
      }
      if (!columns.has("updated_at")) await execute(pool, `ALTER TABLE ${table} ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
      else {
        await execute(pool, `UPDATE ${table} SET updated_at=CURRENT_TIMESTAMP(3) WHERE updated_at IS NULL`);
        await execute(pool, `ALTER TABLE ${table} MODIFY COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
      }
    }
    const userIndexes = await query(pool, "SELECT column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=?", [TABLES.users]);
    if (!userIndexes.some((row) => ["subject_type", "subject_id"].includes(String(row.column_name).toLowerCase()))) await execute(pool, `ALTER TABLE ${TABLES.users} ADD KEY idx_auth_user_subject (subject_type,subject_id)`);
  }

  async function ensureSchema() {
    if (closed) throw new Error("数据源已关闭");
    if (!autoMigrate) return { backend: "mysql", ready: false, migrated: false };
    if (schemaReady) return { backend: "mysql", ready: true, migrated: false };
    if (!ensurePromise) ensurePromise = (async () => { for (const statement of ddl) await execute(pool, statement); await repairLegacySchema(); return true; })().finally(() => { ensurePromise = null; });
    await ensurePromise;
    schemaReady = true;
    return { backend: "mysql", ready: true, migrated: true };
  }
  async function menuRows() {
    return query(pool, `SELECT id,menu_key,parent_key,name,path,icon,sort_no,status,meta_group,meta_type,meta_label,created_at,updated_at FROM ${TABLES.menus} ORDER BY sort_no,id`);
  }
  async function menuDocument(row) {
    if (!row) return null;
    const meta = {};
    if (row.meta_group != null) meta.group = row.meta_group;
    if (row.meta_type != null) meta.type = row.meta_type;
    if (row.meta_label != null) meta.label = row.meta_label;
    const custom = hydrateAttributes(await query(pool, `SELECT attribute_key path,ordinal,value_type,value_text,value_number,value_bool FROM ${TABLES.menuAttributes} WHERE menu_id=? ORDER BY attribute_key,ordinal`, [row.id]));
    if (custom.meta && typeof custom.meta === "object") Object.assign(meta, custom.meta);
    return { id: row.id, menuKey: row.menu_key, parentKey: row.parent_key, name: row.name, path: row.path, icon: row.icon, sortNo: Number(row.sort_no || 0), status: row.status, meta, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async function listMenus() { const rows = await menuRows(); const output = []; for (const row of rows) output.push(await menuDocument(row)); return output; }
  async function getMenu(entityId) { const rows = await query(pool, `SELECT id,menu_key,parent_key,name,path,icon,sort_no,status,meta_group,meta_type,meta_label,created_at,updated_at FROM ${TABLES.menus} WHERE id=?`, [entityId]); return menuDocument(rows[0]); }
  async function upsertMenu(input, entityId) {
    const current = entityId ? await getMenu(entityId) : null;
    const data = { ...(current || {}), ...(input || {}) }; const idv = String(entityId || data.id || data._id || id("menu")); const meta = data.meta && typeof data.meta === "object" ? data.meta : {};
    const values = [idv, String(data.menuKey || data.key || data.path || idv), data.parentKey || data.parentId || null, String(data.name || data.label || ""), String(data.path || ""), data.icon || null, Number(data.sortNo ?? data.sort ?? 0) || 0, data.status || "active", meta.group || null, meta.type || null, meta.label || null];
    const extra = Object.fromEntries(Object.entries(meta).filter(([key]) => !["group", "type", "label"].includes(key)));
    const attributes = [];
    flatten(extra, "meta", attributes);
    await withTransaction(async (conn) => {
      await execute(conn, `INSERT INTO ${TABLES.menus} (id,menu_key,parent_key,name,path,icon,sort_no,status,meta_group,meta_type,meta_label) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE menu_key=VALUES(menu_key),parent_key=VALUES(parent_key),name=VALUES(name),path=VALUES(path),icon=VALUES(icon),sort_no=VALUES(sort_no),status=VALUES(status),meta_group=VALUES(meta_group),meta_type=VALUES(meta_type),meta_label=VALUES(meta_label),updated_at=CURRENT_TIMESTAMP(3)`, values);
      await execute(conn, `DELETE FROM ${TABLES.menuAttributes} WHERE menu_id=?`, [idv]);
      for (const row of attributes) await execute(conn, `INSERT INTO ${TABLES.menuAttributes} (menu_id,attribute_key,ordinal,value_type,value_text,value_number,value_bool) VALUES (?,?,?,?,?,?,?)`, [idv, row.path, row.ordinal, row.value_type, row.value_text, row.value_number, row.value_bool]);
    });
    return getMenu(idv);
  }
  async function listRoles() { return query(pool, `SELECT id,role_key roleKey,name,status,description,created_at createdAt,updated_at updatedAt FROM ${TABLES.roles} ORDER BY name,id`); }
  async function getRole(entityId) { const rows = await query(pool, `SELECT id,role_key roleKey,name,status,description,created_at createdAt,updated_at updatedAt FROM ${TABLES.roles} WHERE id=?`, [entityId]); return rows[0] || null; }
  async function createRole(input = {}) { const idv = input.id || input._id || id("role"); await execute(pool, `INSERT INTO ${TABLES.roles} (id,role_key,name,status,description) VALUES (?,?,?,?,?)`, [idv, input.roleKey || input.code || idv, input.name || input.label || "", input.status || "active", input.description || null]); return getRole(idv); }
  async function updateRole(entityId, input = {}) { const current = await getRole(entityId); if (!current) return null; const data = { ...current, ...(input || {}) }; await execute(pool, `UPDATE ${TABLES.roles} SET role_key=?,name=?,status=?,description=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [data.roleKey || data.code, data.name || data.label || "", data.status || "active", data.description || null, entityId]); return getRole(entityId); }
  async function deleteRole(entityId) { return withTransaction(async (conn) => { await execute(conn, `DELETE FROM ${TABLES.roleMenus} WHERE role_id=?`, [entityId]); await execute(conn, `DELETE FROM ${TABLES.rolePermissions} WHERE role_id=?`, [entityId]); const result = await execute(conn, `DELETE FROM ${TABLES.roles} WHERE id=?`, [entityId]); return Number(result.affectedRows || 0) > 0; }); }

  async function userAttributes(userId) { return query(pool, `SELECT attribute_key path,ordinal,value_type,value_text,value_number,value_bool FROM ${TABLES.userAttributes} WHERE user_id=? ORDER BY attribute_key,ordinal`, [userId]); }
  async function userPermissions(userId) { return query(pool, `SELECT permission_key FROM ${TABLES.userPermissions} WHERE user_id=? ORDER BY permission_key`, [userId]); }
  async function userDocument(row, includePassword = false) {
    if (!row) return null;
    const extra = hydrateAttributes(await userAttributes(row.id));
    const permissions = (await userPermissions(row.id)).map((item) => String(item.permission_key));
    if (permissions.length) extra.permissionKeys = permissions;
    const result = { id: row.id, account: row.account, name: row.display_name, roleId: row.role_id, status: row.status, phone: row.phone || "", email: row.email || "", extra, permissionKeys: permissions, createdAt: row.created_at, updatedAt: row.updated_at };
    if (row.legacy_key) extra.legacyKey = row.legacy_key;
    if (row.legacy_id) extra.legacyId = row.legacy_id;
    if (row.subject_type) extra.subjectType = row.subject_type;
    if (row.subject_id) extra.subjectId = row.subject_id;
    if (row.shop_id) extra.shopId = row.shop_id;
    if (row.distributor_id) extra.distributorId = row.distributor_id;
    if (row.agent_id) extra.agentId = row.agent_id;
    if (includePassword) result.passwordHash = row.password_hash;
    return includePassword ? result : safeUser(result);
  }
  async function rawUser(entityId) { const rows = await query(pool, `SELECT * FROM ${TABLES.users} WHERE id=?`, [entityId]); return rows[0] || null; }
  async function listUsers() { const rows = await query(pool, `SELECT * FROM ${TABLES.users} ORDER BY display_name,id`); const out = []; for (const row of rows) out.push(await userDocument(row)); return out; }
  async function getUser(entityId) { return userDocument(await rawUser(entityId)); }
  async function getUserState(entityId) { return userDocument(await rawUser(entityId), true); }
  async function upsertUser(input = {}, entityId) {
    const existing = entityId ? await rawUser(entityId) : null;
    const current = existing ? { account: existing.account, name: existing.display_name, roleId: existing.role_id, status: existing.status, phone: existing.phone, email: existing.email, extra: hydrateAttributes(await userAttributes(existing.id)), permissionKeys: (await userPermissions(existing.id)).map((item) => item.permission_key) } : {};
    const data = normalizeUser({ ...current, ...input });
    const idv = String(entityId || data.id || data._id || id("usr"));
    const extra = data.extra && typeof data.extra === "object" ? data.extra : {};
    const permissionKeys = [...new Set((data.permissionKeys || data.permissions || extra.permissionKeys || []).map(String).filter(Boolean))];
    const supplied = data.passwordHash || data.password_hash || data.password;
    const passwordHash = supplied ? (String(supplied).startsWith("lxm1$") ? String(supplied) : hashPassword(supplied)) : (existing && existing.password_hash) || hashPassword(crypto.randomBytes(18).toString("hex"));
    const roleId = String(data.roleId || data.role || "service");
    const values = [idv, data.account, data.name, passwordHash, roleId, data.status || "active", data.phone || null, data.email || null, extra.legacyKey || null, extra.legacyId || null, extra.subjectType || null, extra.subjectId || null, extra.shopId || null, extra.distributorId || null, extra.agentId || null];
    const known = new Set(["permissionKeys", "legacyKey", "legacyId", "subjectType", "subjectId", "shopId", "distributorId", "agentId"]);
    const attrs = [];
    for (const [key, value] of Object.entries(extra)) if (!known.has(key)) flatten(value, key, attrs);
    await withTransaction(async (conn) => {
      await execute(conn, `INSERT INTO ${TABLES.users} (id,account,display_name,password_hash,role_id,status,phone,email,legacy_key,legacy_id,subject_type,subject_id,shop_id,distributor_id,agent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE account=VALUES(account),display_name=VALUES(display_name),password_hash=VALUES(password_hash),role_id=VALUES(role_id),status=VALUES(status),phone=VALUES(phone),email=VALUES(email),legacy_key=VALUES(legacy_key),legacy_id=VALUES(legacy_id),subject_type=VALUES(subject_type),subject_id=VALUES(subject_id),shop_id=VALUES(shop_id),distributor_id=VALUES(distributor_id),agent_id=VALUES(agent_id),updated_at=CURRENT_TIMESTAMP(3)`, values);
      await execute(conn, `DELETE FROM ${TABLES.userPermissions} WHERE user_id=?`, [idv]);
      for (const key of permissionKeys) await execute(conn, `INSERT INTO ${TABLES.userPermissions} (user_id,permission_key) VALUES (?,?)`, [idv, key]);
      await execute(conn, `DELETE FROM ${TABLES.userAttributes} WHERE user_id=?`, [idv]);
      for (const row of attrs) await execute(conn, `INSERT INTO ${TABLES.userAttributes} (user_id,attribute_key,ordinal,value_type,value_text,value_number,value_bool) VALUES (?,?,?,?,?,?,?)`, [idv, row.path, row.ordinal, row.value_type, row.value_text, row.value_number, row.value_bool]);
    });
    return getUser(idv);
  }
  async function createUser(input) { try { return await upsertUser(input); } catch (error) { if (error && (error.code === "ER_DUP_ENTRY" || Number(error.errno) === 1062)) throw Object.assign(new Error("账号已存在"), { code: "DUPLICATE_RECORD" }); throw error; } }
  async function updateUser(entityId, input) { if (!(await rawUser(entityId))) return null; return upsertUser(input, entityId); }
  async function deleteUser(entityId) { return withTransaction(async (conn) => { await execute(conn, `DELETE FROM ${TABLES.userPermissions} WHERE user_id=?`, [entityId]); await execute(conn, `DELETE FROM ${TABLES.userAttributes} WHERE user_id=?`, [entityId]); const result = await execute(conn, `DELETE FROM ${TABLES.users} WHERE id=?`, [entityId]); return Number(result.affectedRows || 0) > 0; }); }
  async function authenticate(account, password, options = {}) { const rows = await query(pool, `SELECT * FROM ${TABLES.users} WHERE account=? LIMIT 1`, [String(account).trim()]); const row = rows[0]; const verifier = typeof options.verifyPassword === "function" ? options.verifyPassword : verifyPassword; if (!row || DISABLED.has(String(row.status).toLowerCase()) || !verifier(row.password_hash, password)) return null; return userDocument(row); }
  async function setRoleMenus(roleId, menuIds) { return withTransaction(async (conn) => { const keys = [...new Set((menuIds || []).map(String).filter(Boolean))]; await execute(conn, `DELETE FROM ${TABLES.roleMenus} WHERE role_id=?`, [roleId]); for (const key of keys) await execute(conn, `INSERT INTO ${TABLES.roleMenus} (role_id,menu_key) VALUES (?,?)`, [roleId, key]); return { roleId, menuKeys: keys }; }); }
  async function getRoleMenus(roleId) { const rows = await query(pool, `SELECT menu_key FROM ${TABLES.roleMenus} WHERE role_id=? ORDER BY menu_key`, [roleId]); return { roleId, menuKeys: rows.map((row) => row.menu_key), menuIds: rows.map((row) => row.menu_key) }; }
  async function setRolePermissions(roleId, permissions) { return withTransaction(async (conn) => { const keys = [...new Set((permissions || []).map(String).filter(Boolean))]; await execute(conn, `DELETE FROM ${TABLES.rolePermissions} WHERE role_id=?`, [roleId]); for (const key of keys) await execute(conn, `INSERT INTO ${TABLES.rolePermissions} (role_id,permission_key) VALUES (?,?)`, [roleId, key]); return { roleId, permissions: keys, permissionKeys: keys }; }); }
  async function getRolePermissions(roleId) { const rows = await query(pool, `SELECT permission_key FROM ${TABLES.rolePermissions} WHERE role_id=? ORDER BY permission_key`, [roleId]); return { roleId, permissions: rows.map((row) => row.permission_key), permissionKeys: rows.map((row) => row.permission_key) }; }
  async function setRoleGrantsAtomic(roleId, menuKeys = [], permissionKeys = []) { return withTransaction(async (conn) => { const menus = [...new Set(menuKeys.map(String).filter(Boolean))]; const permissions = [...new Set(permissionKeys.map(String).filter(Boolean))]; await execute(conn, `DELETE FROM ${TABLES.roleMenus} WHERE role_id=?`, [roleId]); for (const key of menus) await execute(conn, `INSERT INTO ${TABLES.roleMenus} (role_id,menu_key) VALUES (?,?)`, [roleId, key]); await execute(conn, `DELETE FROM ${TABLES.rolePermissions} WHERE role_id=?`, [roleId]); for (const key of permissions) await execute(conn, `INSERT INTO ${TABLES.rolePermissions} (role_id,permission_key) VALUES (?,?)`, [roleId, key]); return { roleId, menuKeys: menus, permissionKeys: permissions }; }); }
  async function health() {
    try {
      if (autoMigrate) await ensureSchema();
      await query(pool, "SELECT 1 AS ok");
      const rows = await query(pool, `SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (${Object.values(TABLES).map(() => "?").join(",")})`, Object.values(TABLES));
      const count = Number(rows[0] && rows[0].count || 0);
      const required = {
        [TABLES.menus]: ["id", "menu_key", "meta_group", "meta_type", "meta_label"],
        [TABLES.users]: ["id", "account", "password_hash", "role_id", "legacy_key", "subject_type", "subject_id"]
      };
      const missing = [];
      for (const [table, names] of Object.entries(required)) {
        const columns = await columnsFor(table);
        for (const name of names) if (!columns.has(name)) missing.push(`${table}.${name}`);
        for (const forbidden of ["meta", "extra"]) if (columns.has(forbidden)) missing.push(`${table}.${forbidden}`);
      }
      const subjectIndexes = await query(pool, "SELECT column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=?", [TABLES.users]);
      if (!subjectIndexes.some((row) => ["subject_type", "subject_id"].includes(String(row.column_name).toLowerCase()))) missing.push(`${TABLES.users}.idx_auth_user_subject`);
      const ready = count === Object.values(TABLES).length && missing.length === 0;
      return { backend: "mysql", configured: true, ready, persistent: true, tables: count, normalized: missing.length === 0, ...(missing.length ? { error: "schema_incomplete", missing } : {}) };
    } catch (error) { return { backend: "mysql", configured: true, ready: false, persistent: true, error: error.code || "unavailable" }; }
  }
  async function snapshot() { return { menus: await listMenus(), roles: await listRoles(), roleMenus: await query(pool, `SELECT role_id roleId,menu_key menuKey FROM ${TABLES.roleMenus}`), rolePermissions: await query(pool, `SELECT role_id roleId,permission_key permissionKey FROM ${TABLES.rolePermissions}`), users: await listUsers() }; }

  return { mode: "mysql", backend: "mysql", required: true, tables: TABLES, ensureSchema, listMenus, getMenu, createMenu: (input) => upsertMenu(input), updateMenu: (entityId, input) => upsertMenu(input, entityId), deleteMenu: async (entityId) => { const result = await execute(pool, `DELETE FROM ${TABLES.menus} WHERE id=?`, [entityId]); await execute(pool, `DELETE FROM ${TABLES.menuAttributes} WHERE menu_id=?`, [entityId]); return Number(result.affectedRows || 0) > 0; }, listRoles, getRole, createRole, updateRole, deleteRole, listUsers, getUser, getUserState, createUser, updateUser, deleteUser, setRoleMenus, getRoleMenus, setRolePermissions, getRolePermissions, setRoleGrantsAtomic, authenticate, health, snapshot, async close() { closed = true; if (typeof pool.end === "function") await pool.end(); } };
};
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.safeUser = safeUser;
module.exports.TABLES = TABLES;
