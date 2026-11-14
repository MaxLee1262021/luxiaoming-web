"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const createApi = require("../lib/api.cjs");

test("stored global-settings menus stay retired in sessions and permission management", async (t) => {
  const menus = [
    { id: "menu_carousel", menuKey: "miniDecor", name: "小程序首页", status: "active", meta: { routeKey: "miniDecor" } },
    { id: "menu_global", menuKey: "miniConfig", name: "小程序全局配置", status: "active", meta: { routeKey: "miniConfig" } },
    { id: "menu_global_alias", menuKey: "legacyGlobal", name: "旧全局配置", status: "active", meta: { routeKey: "miniConfig" } },
    { id: "menu_shops", menuKey: "shops", name: "旧商家管理", status: "active", meta: { routeKey: "shops" } },
    { id: "menu_permissions", menuKey: "permissions", name: "权限管理", status: "active" }
  ];
  const user = { id: "admin", account: "admin", status: "active", roleId: "role_super" };
  const permissionStore = {
    backend: "mysql", required: true,
    async init() {},
    async getUser() { return user; },
    async getPolicyForUser() { return { role: { id: "role_super", roleKey: "super", status: "active" }, menuKeys: menus.map((menu) => menu.menuKey) }; },
    async listMenus() { return menus; }
  };
  const source = { async list() { return []; }, async get() { return null; } };
  const auth = {
    async init() {},
    async getSession(token) { return token === "test-session" ? { kind: "admin", role: "super", account: "admin", authzUserId: "admin", subjectId: "admin" } : null; }
  };
  const handler = createApi(source, "json", { auth, permissionStore });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + route, {
      method, headers: { Authorization: "Bearer test-session", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: await response.json() };
  };
  const session = await request("/api/auth/me");
  assert.equal(session.status, 200);
  assert.deepEqual(session.body.menuDefinitions.filter(menu => !/^(?:svc|photo)/.test(menu.key)).map((menu) => menu.key), ["miniDecor", "permissions", "bookingConfig", "shareRules", "shareDetails", "shareMine"]);
  assert.equal(session.body.menuDefinitions.find(menu => menu.key === "bookingConfig").label, "预约配置");
  assert.equal(session.body.menuDefinitions[0].label, "小程序轮播配置");
  const permissions = await request("/api/permissions/menus");
  assert.equal(permissions.status, 200);
  assert.deepEqual(permissions.body.map((menu) => menu.key).sort(), ["miniDecor", "permissions"]);
  assert.equal(session.body.menuDefinitions.some(menu => ["miniConfig", "legacyGlobal", "shops"].includes(menu.key)), false);
  assert.ok(["shareRules", "shareDetails", "shareMine"].every(key => session.body.menuDefinitions.some(menu => menu.key === key && menu.group === "商家分成管理")));
  assert.equal(permissions.body.find((menu) => menu.key === "miniDecor").name, "小程序轮播配置");
  const obsoleteTarget = await request("/api/permissions/menus", "POST", { key: "newGlobal", name: "旧全局入口", routeKey: "miniConfig" });
  assert.equal(obsoleteTarget.status, 400);
  assert.match(obsoleteTarget.body.error, /目标页面必须是已注册后台页面/);
  const obsoleteKey = await request("/api/permissions/menus", "POST", { key: "miniConfig", name: "旧全局入口", routeKey: "miniDecor" });
  assert.equal(obsoleteKey.status, 400);
  menus.push(...[
    ['svcRules','分成比例设置'],['svcStaff','客服人员'],['svcMine','旧本人分成'],['svcStaffNew','新增客服'],['svcClient','客服端'],
    ['photoRules','分成比例设置'],['photoMine','旧本人分成'],['photoNew','新增摄影师'],['photoClient','摄影端']
  ].map(([key,name],index)=>({id:'old_'+key,menuKey:key,name,status:'active',parentKey:key==='svcMine'?'svcClient':key==='photoMine'?'photoClient':null,sortNo:900-index,meta:{routeKey:key,group:'旧分成分组'}})));
  const refreshed=await request('/api/auth/me');
  assert.equal(refreshed.status,200);
  for (const [group,client,listLabel] of [['客服分成管理','svcClient','客服列表'],['摄影师分成管理','photoClient','摄影师列表']]) {
    const rows=refreshed.body.menuDefinitions.filter(menu=>menu.group===group);
    assert.deepEqual(rows.map(menu=>menu.label),['分成配置','分成明细',listLabel,'结算管理',client==='svcClient'?'客服端':'摄影端']);
    assert.equal(rows.at(-1).parentKey,null);
  }
  assert.equal(refreshed.body.menuDefinitions.some(menu=>['svcStaffNew','photoNew','svcClient','photoClient'].includes(menu.key)),false);
});
