"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const createPermissionStore = require("../lib/permissionStore.cjs");
const createApi = require("../lib/api.cjs");

function permissionFixture() {
  const roles = [["role_super", "super"], ["role_merchant", "merchant"], ["role_operations", "operations"], ["role_finance", "finance"], ["role_service", "service"], ["role_photo", "photo"]]
    .map(([id, role_key]) => ({ id, role_key, roleKey: role_key, name: role_key, status: "active" }));
  let permissions = [{ role_id: "role_operations", permission_key: "orderEdit" }];
  let menus = [{ role_id: "role_operations", menu_key: "orders" }];
  const menuRows = ["orders", "shareRules", "shareDetails", "shareMine"].map((menu_key, sort_no) => ({ id: "menu_" + menu_key, menu_key, name: menu_key, path: "/" + menu_key, status: "active", sort_no }));
  let backup; let failOn = null; const events = []; let tail = Promise.resolve();
  const shareKeys = ["share:view", "share:config", "share:admin"];
  const conn = { query: async (sql, params = []) => {
    events.push(sql);
    if (/SELECT.*FROM lxm_auth_roles/.test(sql)) return [roles.filter(role => !/WHERE id=\?/.test(sql) || role.id === params[0]).map(role => ({ ...role }))];
    if (/DELETE FROM lxm_auth_roles WHERE id=\?/.test(sql)) { const index = roles.findIndex(role => role.id === params[0]); if (index >= 0) roles.splice(index, 1); return [{ affectedRows: index >= 0 ? 1 : 0 }]; }
    if (/INSERT INTO lxm_auth_roles/.test(sql)) { roles.push({ id: params[0], role_key: params[1], roleKey: params[1], name: params[2], status: params[3] }); return [{ affectedRows: 1 }]; }
    if (/SELECT.*FROM lxm_auth_menu_attributes/.test(sql)) return [[]];
    if (/SELECT.*FROM lxm_auth_menus/.test(sql)) return [menuRows.map(row => ({ ...row }))];
    if (/SELECT.*FROM lxm_auth_role_permissions/.test(sql)) return [permissions.filter(row => row.role_id === params[0] && shareKeys.includes(row.permission_key)).map(row => ({ ...row })).sort((a, b) => a.permission_key.localeCompare(b.permission_key))];
    if (/SELECT.*FROM lxm_auth_role_menus/.test(sql)) return [menus.filter(row => row.role_id === params[0]).map(row => ({ ...row })).sort((a, b) => a.menu_key.localeCompare(b.menu_key))];
    if (/DELETE FROM lxm_auth_role_permissions/.test(sql)) { permissions = permissions.filter(row => row.role_id !== params[0] || !shareKeys.includes(row.permission_key)); return [{ affectedRows: 1 }]; }
    if (/DELETE FROM lxm_auth_role_menus/.test(sql)) { menus = menus.filter(row => row.role_id !== params[0] || /menu_key IN/.test(sql) && !["shareRules", "shareDetails", "shareMine"].includes(row.menu_key)); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO lxm_auth_role_permissions/.test(sql)) {
      if (params[1] === failOn) throw Object.assign(new Error("injected grant persistence failure"), { code: "ER_TEST_FAILURE" });
      permissions.push({ role_id: params[0], permission_key: params[1] }); return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO lxm_auth_role_menus/.test(sql)) { menus.push({ role_id: params[0], menu_key: params[1] }); return [{ affectedRows: 1 }]; }
    throw new Error("Unimplemented permission SQL: " + sql);
  }, beginTransaction: async () => { backup = { permissions: structuredClone(permissions), menus: structuredClone(menus) }; events.push("BEGIN"); },
  commit: async () => { events.push("COMMIT"); }, rollback: async () => { permissions = backup.permissions; menus = backup.menus; events.push("ROLLBACK"); }, release: () => {} };
  const pool = { query: conn.query, getConnection: async () => {
    let release; const previous = tail; tail = new Promise(resolve => { release = resolve; }); await previous;
    return { ...conn, release };
  } };
  const store = createPermissionStore({ pool, backend: "mysql", autoMigrate: false, logger: { warn() {}, error() {} } });
  return { roles, store, events, rows: () => ({ permissions: structuredClone(permissions), menus: structuredClone(menus) }), failOn: key => { failOn = key; } };
}

test("share permission keys persist, read back and revoke without reviving arbitrary old action grants", async () => {
  const f = permissionFixture();
  await f.store.setRolePermissions("role_operations", ["orderEdit", "financeReview", "*", "share:config", "share:view", "share:view"]);
  assert.deepEqual(await f.store.getRolePermissions("role_operations"), { roleId: "role_operations", permissionKeys: ["share:config", "share:view"] });
  const before = await f.store.getPolicyForUser({ id: "user", account: "operations", roleId: "role_operations", permissionKeys: ["orderEdit", "*"] });
  assert.equal(Object.hasOwn(before, "permissionKeys"), false); assert.equal(Object.hasOwn(before.user, "permissionKeys"), false);
  assert.deepEqual(before.menuKeys, ["orders"], "capability rows cannot create unrelated menus or old action scopes");
  await f.store.setRolePermissions("role_operations", []);
  assert.deepEqual(await f.store.getRolePermissions("role_operations"), { roleId: "role_operations" });
  assert.deepEqual(f.rows().permissions, [{ role_id: "role_operations", permission_key: "orderEdit" }], "old rows remain inert rather than being converted into new capabilities");
});

test("UI share grants update menus and capabilities atomically and revoke both together", async () => {
  const f = permissionFixture();
  await f.store.setShareGrants("role_operations", ["share:config"]);
  assert.deepEqual(await f.store.getRolePermissions("role_operations"), { roleId: "role_operations", permissionKeys: ["share:config", "share:view"] });
  assert.deepEqual((await f.store.getRoleMenus("role_operations")).menuKeys, ["orders", "shareDetails", "shareRules"]);
  const before = f.rows(); f.failOn("share:view");
  await assert.rejects(f.store.setShareGrants("role_operations", ["share:view"]), /injected grant persistence failure/);
  assert.deepEqual(f.rows(), before); assert.ok(f.events.includes("ROLLBACK"));
  f.failOn(null); await f.store.setShareGrants("role_operations", []);
  assert.deepEqual((await f.store.getRoleMenus("role_operations")).menuKeys, ["orders"]);
  assert.deepEqual(await f.store.getRolePermissions("role_operations"), { roleId: "role_operations" });
});

test("UI grants cannot target built-in super/merchant or give config to finance, service or photography", async () => {
  const f = permissionFixture(); const before = f.rows();
  for (const role of ["role_super", "role_merchant", "missing"]) await assert.rejects(f.store.setShareGrants(role, ["share:view"]), { code: "SHARE_4001" });
  for (const role of ["role_finance", "role_service", "role_photo"]) {
    await assert.rejects(f.store.setShareGrants(role, ["share:config"]), { code: "SHARE_4001" });
    await f.store.setShareGrants(role, ["share:view"]);
  }
  for (const permission of ["share:admin", "orderEdit", "*"]) await assert.rejects(f.store.setShareGrants("role_operations", [permission]), { code: "SHARE_4001" });
  assert.deepEqual(f.rows().menus.filter(row => row.role_id === "role_operations"), before.menus);
});

test("deleting and recreating a role ID cannot resurrect its previous share capabilities", async () => {
  const f = permissionFixture(); await f.store.setShareGrants("role_operations", ["share:config"]);
  assert.equal(await f.store.deleteRole("role_operations"), true);
  await f.store.createRole({ id: "role_operations", roleKey: "replacement", name: "全新角色", status: "active" });
  assert.deepEqual(await f.store.getRolePermissions("role_operations"), { roleId: "role_operations" });
  assert.deepEqual((await f.store.getRoleMenus("role_operations")).menuKeys, []);
});

test("HTTP share-grants endpoint is super-only, rejects protected targets and persists allowed grants", async t => {
  const f = permissionFixture(); const user = token => ({ id: "u_" + token, account: token === "super" ? "admin" : token, status: "active", roleId: "role_" + token });
  const permissions = { ...f.store,
    getUser: async id => user(String(id).replace(/^u_/, "")),
    getPolicyForUser: async u => ({ user: u, role: f.roles.find(role => role.id === u.roleId), menuKeys: ["shareRules"] }),
  };
  const auth = { init: async () => {}, getSession: async token => ["super", "merchant", "service", "operations"].includes(token)
    ? { kind: "admin", role: token, account: token === "super" ? "admin" : token, subjectId: "u_" + token, authzUserId: "u_" + token, roleId: "role_" + token, shopId: token === "merchant" ? "m" : "" } : null };
  const source = { list: async () => [], get: async () => null, create: async (_, value) => value };
  const handler = createApi(source, "mysql", { auth, permissionStore: permissions, shareService: {} });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (token, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/share/grants`, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  for (const token of ["merchant", "service", "operations"]) assert.equal((await request(token, { roleId: "role_operations", permissions: ["share:view"] })).status, 403);
  const available = await request("super"); assert.equal(available.status, 200);
  assert.equal(available.body.data.roles.some(role => ["super", "merchant"].includes(role.roleKey)), false);
  for (const roleId of ["role_super", "role_merchant"]) assert.equal((await request("super", { roleId, permissions: ["share:view"] })).status, 400);
  assert.equal((await request("super", { roleId: "role_finance", permissions: ["share:config"] })).status, 400);
  assert.equal((await request("super", { roleId: "role_operations", permissions: ["share:admin"] })).status, 400);
  assert.equal((await request("super", { roleId: "role_operations", permissions: ["share:config"] })).status, 200);
  assert.deepEqual((await f.store.getRolePermissions("role_operations")).permissionKeys, ["share:config", "share:view"]);
  assert.equal((await request("super", { roleId: "role_operations", permissions: [] })).status, 200);
  assert.deepEqual((await f.store.getRoleMenus("role_operations")).menuKeys, ["orders"]);
});
