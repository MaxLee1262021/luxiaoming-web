"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  const loads = [], notices = [], sessions = [];
  const window = { LXM_APP_PARTS: [], LXM_API_STATE: { reachable: true }, LXM_CLOUD_MODE: "mysql", addEventListener() {},
    LXM_AUTH: { getSession: () => null, hasSession: () => true, setSession: (value) => sessions.push(value), clearSession() {} },
    LXM_CLOUD: { clearMenuLoadState() {}, async loadMenuData(key) { loads.push(key); return { ok: true }; } }
  };
  const sandbox = { window, structuredClone, setTimeout() {}, LXMFormat: { nowText: () => "2026-11-07 10:00:00" }, console };
  vm.createContext(sandbox); vm.runInContext(read("src/config/business-config.js"), sandbox); sandbox.LXM_CONFIG = window.LXM_CONFIG;
  vm.runInContext(read("src/config/customer-service.js"), sandbox);
  vm.runInContext(read("src/router/index.js"), sandbox);
  const ctx = { computed: (fn) => ({ get value() { return fn(); } }), reactive: (value) => value, watch() {},
    ElMessage: Object.fromEntries(["warning", "success", "error"].map((kind) => [kind, (message) => notices.push({ kind, message })])), log() {}, resetPageState() {}, isServerConnected: () => true };
  for (const file of ["01-core-state.js", "02-order-basis.js", "03-auth.js"]) {
    vm.runInContext(read(`src/app/${file}`), sandbox); Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  }
  async function mountPermissions(rows) {
    const mounted = [];
    sandbox.Vue = { computed: ctx.computed, reactive: ctx.reactive, ref: value => ({ value }), onMounted: fn => mounted.push(fn) };
    sandbox.ElementPlus = { ElMessage: ctx.ElMessage, ElMessageBox: {} };
    window.LXM_PERMISSIONS = { async menus() { return plain(rows); }, async roles() { return []; }, async users() { return []; } };
    const register = window.LXM_PAGES.register;
    let page;
    window.LXM_PAGES.register = value => { page = value; };
    vm.runInContext(read("src/views/system/permissions/permissions.js"), sandbox);
    window.LXM_PAGES.register = register;
    const ui = page.setup(ctx);
    await Promise.all(mounted.map(fn => fn()));
    return ui;
  }
  return { window, ctx, loads, notices, sessions, config: sandbox.LXM_CONFIG, mountPermissions };
}
test("only the three agreed share routes are registered, and the old merchant page is retired", () => {
  const f = fixture(); const manifest = f.window.LXM_PAGES.manifest;
  assert.equal(manifest.some((row) => row.key === "shops"), false);
  assert.deepEqual(Array.from(manifest.filter((row) => row.key.startsWith("share")).map((row) => row.key)), ["shareRules", "shareDetails", "shareMine"]);
  assert.deepEqual(Array.from(f.config.menus.filter((row) => row.group === "商家分成管理").map((row) => row.label)), ["配置列表", "分成明细", "商家端"]);
  assert.equal(f.config.routeMenuKeys.includes("shops"), false);
});
test("merchant login clamps legacy grants to My Share and does not request old collections", async () => {
  const f = fixture(); f.ctx.applyLogin({ token: "test", role: "merchant", account: "shop", shopId: "s1", menus: ["dashboard", "orders", "shops"] }, { source: "server" });
  assert.equal(f.ctx.state.active, "shareMine"); assert.deepEqual(plain(f.ctx.roleProfile.value.menus), ["shareMine"]);
  await f.ctx.loadAuthenticatedData(); assert.deepEqual(f.loads, []);
  await f.ctx.switchMenu("shops"); assert.equal(f.ctx.state.active, "shareMine"); assert.deepEqual(f.loads, []);
});
test("old shop aliases, descendants and empty containers cannot return through saved server menus", () => {
  const f = fixture();
  f.ctx.applyLogin({ token: "test", role: "super", menus: ["dashboard", "oldGroup", "oldShop", "oldChild", "shareRules"], menuDefinitions: [
    { key: "oldGroup", containerOnly: true }, { key: "oldShop", routeKey: "shops", parentKey: "oldGroup" }, { key: "oldChild", routeKey: "orders", parentKey: "oldShop" }
  ] }, { source: "server" });
  assert.equal(f.config.menus.some((row) => ["oldGroup", "oldShop", "oldChild", "shops"].includes(row.key)), false);
  assert.deepEqual(plain(f.ctx.roleProfile.value.menus), ["dashboard", "shareRules"]);
});
test("custom share writes require explicit permissions; builtin finance and service remain read only", () => {
  const f = fixture(); f.ctx.applyLogin({ token: "test", role: "custom-ops", menus: ["shareRules", "shareDetails"], sharePermissions: ["share:view"] }, { source: "server" });
  assert.equal(f.ctx.can("shareView"), true); assert.equal(f.ctx.can("shareConfig"), false);
  f.ctx.state.sharePermissions = ["share:config"]; assert.equal(f.ctx.can("shareConfig"), true); assert.equal(f.ctx.can("shareAdmin"), false);
  for (const role of ["finance", "service"]) {
    f.ctx.applyLogin({ token: "test", role, menus: ["shareRules", "shareDetails"], sharePermissions: ["share:admin"] }, { source: "server" });
    assert.equal(f.ctx.can("shareView"), true); assert.equal(f.ctx.can("shareConfig"), false); assert.equal(f.ctx.can("shareAdmin"), false);
  }
});
test("confirmed refunds count successful attempts before ticket completion and exclude processing amounts", () => {
  const f = fixture(); const order = { id: "o", refundAmount: 900 };
  f.ctx.data.afterSales = [{ orderId: "o", status: "processing", refundAmount: 30, refundAttempts: [{ status: "SUCCESS", amountFen: 1000 }, { status: "PROCESSING", amountFen: 2000 }] }];
  assert.equal(f.ctx.confirmedRefund(order), 10);
  f.ctx.data.afterSales = [{ orderId: "o", refundAmount: 12, refundStatus: "manual_refunded", refundConfirmed: true }];
  assert.equal(f.ctx.confirmedRefund(order), 12);
  f.ctx.data.afterSales[0].refundConfirmed = false; assert.equal(f.ctx.confirmedRefund(order), 0);
  order.onlineRefundedAmount = 20;
  assert.equal(f.ctx.confirmedRefund(order), 20, "hidden automatic refunds remain verified order money");
  f.ctx.data.afterSales = [{ orderId: "o", refundAmount: 12, refundStatus: "manual_refunded", refundConfirmed: true },
    { orderId: "o", refundAttempts: [{ status: "SUCCESS", amountFen: 1000 }, { status: "PROCESSING", amountFen: 99999 }] }];
  assert.equal(f.ctx.confirmedRefund(order), 32, "visible online successes overlap the order total; manual refunds add separately");
  f.ctx.data.afterSales = [];
  order.customerCancellationRefundAmount = 999;
  assert.equal(f.ctx.confirmedRefund(order), 20, "a requested cancellation amount cannot become confirmed money");
});

test("commission navigation keeps direct client pages and list order after stale server definitions arrive", () => {
  const f = fixture();
  const keys = ['svcRules','svcLedger','svcStaff','svcSettlements','svcMine','photoRules','photoLedger','photoParty','photoSettlement','photoMine'];
  const folders=[{key:'svcClient',label:'客服端',containerOnly:true},{key:'photoClient',label:'摄影端',containerOnly:true}];
  f.ctx.applyLogin({ token:'test', role:'super', menuKeys:[...keys,'svcStaffNew','photoNew',...folders.map(row=>row.key)], menuDefinitions:[...folders,...keys.map((key,index)=>({key,label:key.endsWith('Rules')?'分成比例设置':key==='svcStaff'?'客服人员':'旧名称',routeKey:key,parentKey:key==='svcMine'?'svcClient':key==='photoMine'?'photoClient':'',sort:100-index}))] },{source:'server'});
  const sections = plain(f.ctx.sidebarSections.value);
  for (const [group,listLabel,client,mine] of [['客服分成管理','客服列表','客服端','svcMine'],['摄影师分成管理','摄影师列表','摄影端','photoMine']]) {
    const items = sections.find((section)=>section.label===group).items;
    assert.deepEqual(items.map((item)=>item.label),['分成配置','分成明细',listLabel,'结算管理',client]);
    assert.equal(items.at(-1).key,mine);
    assert.equal(items.at(-1).navigable,true);
    assert.deepEqual(items.at(-1).children,[]);
  }
  assert.equal(f.config.menus.some((row)=>['svcStaffNew','photoNew','svcClient','photoClient'].includes(row.key)),false);
  assert.equal(f.ctx.roleProfile.value.menus.some((key)=>['svcStaffNew','photoNew','svcClient','photoClient'].includes(key)),false);
  f.ctx.state.active='svcMine';
  assert.deepEqual(plain(f.ctx.breadcrumbTrail.value),['客服分成管理','客服端']);
  f.ctx.state.menuSearch='客服端';
  assert.deepEqual(plain(f.ctx.searchedMenus.value).map((row)=>row.key),['svcMine']);
});

test("opening and reloading permissions cannot restore legacy commission groups or undo navigation order", async () => {
  const f = fixture();
  const rows = plain(f.config.menus).map((row, index) => {
    const { navigationOrder, ...menu } = row;
    const key = row.key === "photoParty" ? "customPhotoList" : row.key;
    return { ...menu, id: `menu_${key}`, key, routeKey: row.key, label: `旧${row.label}`, name: `旧${row.label}`,
      group: row.group === "摄影师分成管理" ? "摄影师分成" : row.group,
      parentKey: row.key === "photoMine" ? "photoClient" : row.key === "svcMine" ? "svcClient" : "", sort: 1000 - index };
  });
  rows.push(
    { id: "oldPhotoClient", key: "photoClient", name: "摄影端", group: "摄影师分成", containerOnly: true },
    { id: "oldSvcClient", key: "svcClient", name: "客服端", group: "客服分成管理", containerOnly: true },
    { id: "oldPhotoNew", key: "photoNew", name: "新增摄影师", group: "摄影师分成" },
    { id: "oldSvcNew", key: "svcStaffNew", name: "新增客服", group: "客服分成管理" }
  );
  const session = { token: "test", role: "super", menuKeys: rows.map(row => row.key), menuDefinitions: rows };
  f.ctx.applyLogin(session, { source: "server" });
  const expectedGroups = ["经营中心", "订单履约", "内容管理", "客服工作台", "客服分成管理", "摄影师分成管理", "商家分成管理", "财务管理", "内容运营", "系统安全", "渠道增长"];
  const assertNavigation = () => {
    const sections = plain(f.ctx.sidebarSections.value);
    assert.deepEqual(sections.map(section => section.label), expectedGroups);
    for (const [group, listLabel, client, clientKey] of [
      ["客服分成管理", "客服列表", "客服端", "svcMine"],
      ["摄影师分成管理", "摄影师列表", "摄影端", "photoMine"]
    ]) {
      const items = sections.find(section => section.label === group).items;
      assert.deepEqual(items.map(item => item.label), ["分成配置", "分成明细", listLabel, "结算管理", client]);
      assert.equal(items.at(-1).key, clientKey);
      assert.equal(items.at(-1).navigable, true);
      assert.deepEqual(items.at(-1).children, []);
    }
    assert.equal(sections.find(section => section.label === "摄影师分成管理").items[2].key, "customPhotoList");
    assert.equal(f.config.menus.some(row => ["svcStaffNew", "photoNew", "svcClient", "photoClient"].includes(row.key)), false);
  };
  assertNavigation();
  const ui = await f.mountPermissions(rows);
  assertNavigation();
  await ui.loadAll();
  assertNavigation();
  f.ctx.applyLogin(session, { source: "server" });
  assertNavigation();
});

test("permissions synchronization preserves custom menu structure while reflecting deletion and disabled state", async () => {
  const f = fixture();
  const rows = [
    { id: "dashboard", key: "dashboard", routeKey: "dashboard", name: "经营看板", group: "经营中心", sort: 99 },
    { id: "disabledPhoto", key: "photoRules", routeKey: "photoRules", name: "旧分成比例", group: "摄影师分成", status: "disabled", sort: 3 },
    { id: "early", key: "customEarly", routeKey: "series", name: "自定义首项", group: "自定义业务", sort: 1 },
    { id: "folder", key: "customFolder", name: "自定义目录", group: "自定义业务", sort: 2, containerOnly: true },
    { id: "child", key: "customChild", routeKey: "staff", name: "自定义子项", group: "自定义业务", parentKey: "customFolder", sort: 8 },
    { id: "removed", key: "customRemoved", routeKey: "distributors", name: "待删除菜单", group: "自定义业务", sort: 3 },
    { id: "late", key: "customLate", routeKey: "staff", name: "待停用菜单", group: "自定义业务", sort: 7 }
  ];
  f.ctx.applyLogin({ token: "test", role: "super", menuKeys: rows.map(row => row.key), menuDefinitions: rows }, { source: "server" });
  const ui = await f.mountPermissions(rows);
  const customItems = () => plain(f.ctx.sidebarSections.value).find(section => section.label === "自定义业务").items;
  assert.deepEqual(customItems().map(item => item.key), ["customEarly", "customFolder", "customRemoved", "customLate"]);
  assert.equal(customItems()[1].navigable, false);
  assert.deepEqual(customItems()[1].children.map(item => item.label), ["自定义子项"]);
  assert.equal(f.ctx.sidebarSections.value.some(section => section.label === "摄影师分成管理"), false);
  assert.equal(f.config.menus.find(row => row.key === "photoRules").status, "停用");
  rows.splice(rows.findIndex(row => row.key === "customRemoved"), 1);
  rows.find(row => row.key === "customLate").status = "disabled";
  f.ctx.state.active = "customRemoved";
  await ui.loadAll();
  assert.deepEqual(customItems().map(item => item.key), ["customEarly", "customFolder"]);
  assert.equal(f.config.menus.some(row => row.key === "customRemoved"), false);
  assert.equal(f.config.menus.find(row => row.key === "customLate").status, "停用");
  assert.equal(f.ctx.roleProfile.value.menus.includes("customLate"), false);
  assert.notEqual(f.ctx.state.active, "customRemoved");
  await f.ctx.switchMenu("customLate");
  assert.equal(f.notices.at(-1).kind, "warning");
});

test("personal commission grants display only their direct client page and keep management inaccessible", async () => {
  for (const [role,key,client] of [['photo','photoMine','摄影端'],['service','svcMine','客服端']]) {
    const f=fixture();
    f.ctx.applyLogin({token:'test',role,menus:[key]}, {source:'server'});
    const items=plain(f.ctx.sidebarSections.value).flatMap((section)=>section.items);
    assert.deepEqual(items.map((item)=>item.label),[client]);
    assert.equal(items[0].key,key);assert.equal(items[0].navigable,true);
    assert.deepEqual(items[0].children,[]);
    await f.ctx.switchMenu(role==='photo'?'photoParty':'svcStaff');
    assert.equal(f.ctx.state.active,key);
    assert.equal(f.notices.at(-1).kind,'warning');
  }
});

test("legacy creation targets open list actions and never load separate create pages", async () => {
  const f=fixture();let photoOpens=0;
  f.ctx.openPhotoCreate=async()=>{photoOpens++;};
  await f.ctx.switchMenu('svcStaffNew');
  assert.equal(f.ctx.state.active,'svcStaff');assert.equal(f.ctx.state.svcCreateRequested,true);
  await f.ctx.switchMenu('photoNew');
  assert.equal(f.ctx.state.active,'photoParty');assert.equal(photoOpens,1);
  assert.deepEqual(f.loads,[]);
  const pages=f.window.LXM_PAGES;
  assert.equal(pages.manifest.some((page)=>['svcStaffNew','photoNew'].includes(page.key)),false);
  assert.equal(pages.pageFor('svcStaffNew').key,'svcStaff');
  assert.equal(pages.pageFor('photoNew').key,'photoParty');
});
