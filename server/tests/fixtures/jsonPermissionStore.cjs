"use strict";
// Isolated synthetic authorization storage; excluded from runtime packages.
const fs = require("fs");
const path = require("path");
const realStore = require("../../lib/permissionStore.cjs");
const { AUTHZ_KEYS, clone, id, now, menuKey, normalizeMenu, normalizeUser, hashPassword, verifyPassword, safeUser } = realStore.adapterTools;
function createJson(options) {
  if (!options.jsonFile) throw new Error("An explicit isolated permission fixture path is required");
  const file = options.jsonFile;
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


module.exports = function(options = {}) {
  if (options.backend === "mysql") return realStore(options);
  return realStore.decorateStore(createJson(options), "json", options);
};
