"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

function fixture(options = {}) {
  const messages = [], requests = [], events = new Map();
  const poisoned = { staff: [{ id: "fake", account: "local-admin", password: "Password123" }], orders: [{ id: "fake-order" }], homeConfig: { activity: "fake" } };
  const computed = (getter) => ({ get value() { return getter(); } });
  const config = { roles: { super: { name: "管理员", menus: ["orders"], home: "orders", ...(options.roleDefaults || {}) } }, menus: [{ key: "orders", label: "订单" }], orderStatuses: [] };
  const window = {
    LXM_APP_PARTS: [], LXM_DATA: poisoned,
    LXM_UPLOAD: { ready: () => true },
    location: { protocol: "file:" }, LXM_DEMO_MODE: true,
    LXM_CLOUD_MODE: options.connected ? "mysql" : "unavailable", LXM_API_STATE: { reachable: !!options.connected },
    addEventListener(name, callback) { events.set(name, callback); },
    LXM_AUTH: {
      getSession: () => null, hasSession: () => !!options.connected,
      login: options.login || (async () => { throw new Error("network unavailable"); }),
      clearSession() {}, setSession() {}, logout: async () => null
    },
    LXM_HTTP: { request: async () => { throw new Error("network unavailable"); } },
    LXM_CLOUD: {
      clearMenuLoadState() {},
      async loadMenuData(key, data) { requests.push(key); data.orders = [{ id: "database-order" }]; return { ok: true }; }
    }
  };
  const sandbox = { window, LXM_CONFIG: config, LXM_DATA: poisoned, LXMFormat: { nowText: () => "2026-11-05 10:00:00" }, setTimeout() {}, localStorage: {
    getItem() { assert.fail("业务状态不得读取localStorage"); },
    setItem() { assert.fail("业务状态不得写入localStorage"); }
  } };
  const ctx = { computed, reactive: (value) => value };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/01-core-state.js"), "utf8"), sandbox);
  Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  Object.assign(ctx, {
    ElMessage: Object.fromEntries(["error", "success", "warning"].map((kind) => [kind, (message) => messages.push({ kind, message })])),
    log() {}, resetPageState() {}, currentOperatorName: () => "数据库用户", roleName: (key) => key,
    isServerConnected: () => !!options.connected
  });
  return {
    ctx, window, messages, requests, config,
    loadPart(name) {
      vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", name), "utf8"), sandbox);
      const part = window.LXM_APP_PARTS.pop()(ctx);
      Object.assign(ctx, part);
      return part;
    },
    loadAuth() {
      vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/03-auth.js"), "utf8"), sandbox);
      Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
      return ctx;
    }
  };
}

test("业务集合启动为空且忽略浏览器中遗留的演示快照", () => {
  const f = fixture();
  for (const [key, value] of Object.entries(f.ctx.data)) assert.equal(Array.isArray(value) ? value.length : Object.keys(value).length, 0, key);
  assert.equal(f.ctx.state.logs.length, 0);
  assert.equal(f.ctx.state.trash.length, 0);
  assert.equal(Object.keys(f.ctx.state.homeConfig).length, 0);
  assert.equal(Object.keys(f.ctx.state.siteConfig).length, 0);
  assert.equal(f.ctx.state.currentStaffId, "");
  assert.equal(f.ctx.canPreviewRoles.value, false);
});

test("直接打开页面也不能用本地账号登录，连接失败维持未认证和空集合", async () => {
  const f = fixture();
  const ctx = f.loadAuth();
  Object.assign(ctx.state.login, { account: "local-admin", password: "Password123" });
  await ctx.login();
  assert.equal(ctx.state.authed, false);
  assert.equal(ctx.state.authSource, "");
  assert.equal(ctx.data.staff.length, 0);
  assert.equal(ctx.data.orders.length, 0);
  assert.equal(f.requests.length, 0);
  assert.match(f.messages.at(-1).message, /无法连接后台服务/);
  assert.equal(f.messages.some((entry) => entry.kind === "success"), false);
});

test("有效服务端会话只载入真实接口数据且拒绝角色演示切换", async () => {
  const f = fixture({ connected: true, login: async () => ({ ok: true, token: "test-token", role: "super", account: "real-admin", menus: ["orders"] }) });
  const ctx = f.loadAuth();
  Object.assign(ctx.state.login, { account: "real-admin", password: "Password123" });
  await ctx.login();
  assert.equal(ctx.state.authed, true);
  assert.equal(ctx.state.authSource, "server");
  assert.deepEqual(Array.from(ctx.data.orders, (row) => row.id), ["database-order"]);
  const before = JSON.stringify({ role: ctx.state.role, orders: ctx.data.orders });
  await ctx.switchRole("merchant");
  assert.equal(JSON.stringify({ role: ctx.state.role, orders: ctx.data.orders }), before);
  assert.match(f.messages.at(-1).message, /真实登录账号/);
});

test("真实会话缺少实体绑定时清空旧角色资料，不继承示例或上一位用户ID", async () => {
  const bindings = { staffId: "legacy-staff", shopId: "legacy-shop", agentId: "legacy-agent", distributorId: "legacy-distributor" };
  const f = fixture({ connected: true, roleDefaults: bindings, login: async () => ({ ok: true, token: "test-token", role: "super", account: "real-admin", menus: ["orders"] }) });
  const ctx = f.loadAuth();
  Object.assign(ctx.state.login, { account: "real-admin", password: "Password123" });
  await ctx.login();
  for (const field of Object.keys(bindings)) assert.equal(f.config.roles.super[field], "", field);
  ctx.applyLogin({ token: "another-token", role: "super", menus: ["orders"], ...bindings }, { source: "server" });
  assert.equal(f.config.roles.super.staffId, "legacy-staff");
  ctx.applyLogin({ token: "third-token", role: "super", menus: ["orders"] }, { source: "server" });
  for (const field of Object.keys(bindings)) assert.equal(f.config.roles.super[field], "", field);
  assert.equal(ctx.state.currentStaffId, "");
});

test("改密与账号保存断网时不使用本地密码，也不返回本地保存成功", async () => {
  const f = fixture();
  const ctx = f.loadAuth();
  const account = { id: "local", account: "local-admin", password: "Password123" };
  ctx.data.staff.push(account);
  ctx.state.currentAccount = account.account;
  Object.assign(ctx.state.changePwd, { oldPwd: "Password123", newPwd: "NewPassword456", confirmPwd: "NewPassword456", open: true });
  await ctx.changePassword();
  assert.equal(account.password, "Password123");
  assert.equal(ctx.state.changePwd.open, true);
  assert.equal(await ctx.persistAccountToCloud("staff", account), false);
  assert.equal(f.messages.some((entry) => entry.kind === "success"), false);
});

test("静态入口不再导入本地业务数据源", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.doesNotMatch(html, /src\/mock\/|document\.write\(/);
  assert.equal(fs.existsSync(path.join(root, "src/mock/business-data.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/mock/demo-data.js")), false);
});

test("断网时商品、轮播、排序和回收站均拒绝本地保存", async () => {
  const f = fixture();
  f.ctx.state.trash = [];
  const editor = f.loadPart("12-content-edit.js");
  const source = { id: "existing", name: "已保存商品", isShow: true, localOnly: true };
  const previous = { id: "existing", name: "已保存商品", isShow: false };
  assert.equal(await editor.persistContentMutation("peripherals", source, previous), false);
  assert.deepEqual(source, previous);
  assert.equal(await editor.persistSpotSort({ id: "point" }, 1), false);
  assert.equal(await editor.saveHomeConfig(), false);
  await editor.saveSiteConfig();
  const trash = f.loadPart("08-trash.js");
  assert.equal(await trash.persistTrashRecord({ id: "trash", name: "未保存记录" }), null);
  assert.equal(f.ctx.state.trash.length, 0);
  assert.equal(f.messages.some((entry) => entry.kind === "success"), false);
});

test("库存提醒只使用已设置库存，周边订单不能冒充实际出库数", () => {
  const f = fixture();
  f.ctx.scopedOrders = { value: [] };
  f.ctx.data.peripherals = [
    { id: "unset" }, { id: "low", stock: 4, stockWarning: 5 },
    { id: "ready", stockQty: 4, stockWarning: 2 }, { id: "removed", stock: 0, isDeleted: true }
  ];
  const dashboard = f.loadPart("05-dashboard.js");
  assert.equal(dashboard.dashboardPeripheralSales.value.outbound, null);
  assert.deepEqual(Array.from(dashboard.dashboardPeripheralSales.value.lowStock, (row) => row.id), ["low"]);
  assert.equal(dashboard.dashboardPeripheralSales.value.stock, 8);
  f.ctx.data.peripherals[1].outboundQty = 3;
  f.ctx.data.peripherals[2].shippedQty = 2;
  assert.equal(dashboard.dashboardPeripheralSales.value.outbound, 5);
});

test("账号和订单保存未收到有效确认时失败，并保留原账号与订单资料", async () => {
  const f = fixture({ connected: true });
  const ctx = f.loadAuth();
  f.loadPart("02-order-basis.js");
  const account = { id: "staff-real", password: "NewPassword123" };
  const order = { id: "order-real", status: "deposit_paid", depositPaid: 30 };
  const before = JSON.stringify(order);
  for (const reply of [undefined, null, {}, [], false, { ok: false }, { error: "write rejected" }]) {
    f.window.LXM_CLOUD.update = async () => reply;
    f.window.LXM_CLOUD.orderAction = async () => reply;
    assert.equal(await ctx.persistAccountToCloud("staff", account), false);
    assert.equal(account.password, "NewPassword123");
    await assert.rejects(ctx.persistOrderAction(order, "assign", { photographerId: "requested" }), /未确认|write rejected/);
    assert.equal(JSON.stringify(order), before);
  }
  assert.equal(f.messages.some((entry) => entry.kind === "success"), false);
});

test("内容、轮播和全局配置空响应不会被当作本地保存成功", async () => {
  const f = fixture({ connected: true });
  const editor = f.loadPart("12-content-edit.js");
  const payload = { id: "article", title: "未获确认的内容" };
  for (const reply of [undefined, null, {}, [], { ok: false }, { error: "write rejected" }]) {
    f.window.LXM_CLOUD.update = async () => reply;
    f.window.LXM_CLOUD.upsertDoc = async () => reply;
    assert.equal(await editor.pushContentToCloud("guides", payload), null);
    assert.equal(await editor.saveHomeConfig(), false);
    assert.equal(await editor.saveSiteConfig(), false);
    assert.deepEqual(payload, { id: "article", title: "未获确认的内容" });
  }
  assert.equal(f.messages.some((entry) => entry.kind === "success"), false);
});

test("保存接受实际记录或明确ok确认，纯确认不污染业务记录", async () => {
  const f = fixture({ connected: true });
  const ctx = f.loadAuth();
  f.loadPart("02-order-basis.js");
  const editor = f.loadPart("12-content-edit.js");
  f.window.LXM_CLOUD.update = async () => ({ ok: true });
  f.window.LXM_CLOUD.upsertDoc = async () => ({ ok: true });
  f.window.LXM_CLOUD.orderAction = async () => ({ ok: true });
  const account = { id: "staff-real", password: "NewPassword123" };
  assert.equal(await ctx.persistAccountToCloud("staff", account), true);
  assert.equal(account.password, undefined);
  const order = { id: "order-real", status: "deposit_paid", depositPaid: 30 };
  await ctx.persistOrderAction(order, "note", { reason: "真实备注" });
  assert.equal(Object.hasOwn(order, "ok"), false);
  assert.equal((await editor.pushContentToCloud("guides", { id: "article", title: "真实内容" })).title, "真实内容");
  assert.equal(await editor.saveHomeConfig(), true);
  assert.equal(await editor.saveSiteConfig(), true);
  f.window.LXM_CLOUD.update = async () => ({ id: "article", title: "服务端内容" });
  assert.equal((await editor.pushContentToCloud("guides", { id: "article", title: "请求内容" })).title, "服务端内容");
});
