"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture(role = "super") {
  const calls = [], listeners = {}, notices = [];
  const controls = { handler: async () => ({ code: 0, data: { list: [], total: 0, summary: {} } }) };
  const window = { LXM_APP_PARTS: [], crypto: { randomUUID: () => `request-${calls.length}` }, addEventListener: (key, handler) => { listeners[key] = handler; },
    LXM_AUTH: { hasSession: () => true }, LXM_HTTP: { async request(url, init) {
      calls.push({ url, init, body: init?.body && JSON.parse(init.body) });
      const result = await controls.handler(url, init);
      return { ok: result.status ? result.status < 400 : true, status: result.status || 200, json: async () => result, blob: async () => new Blob(["test QR"], { type: "image/png" }) };
    } } };
  const ctx = { state: { role, authed: true, currentAccount: "user" }, reactive: (value) => value, computed: (fn) => ({ get value() { return fn(); } }), watch() {}, can: () => false,
    ElMessage: Object.fromEntries(["error", "success", "warning"].map((type) => [type, (text) => notices.push({ type, text })])) };
  vm.runInNewContext(source("src/app/19-merchant-share.js"), { window, URL, URLSearchParams, console, Date });
  const ui = window.LXM_APP_PARTS[0](ctx);
  return { calls, controls, ctx, ui, listeners, notices };
}
test("share pages compile with the shipped Vue runtime", () => {
  const sandbox = { window: {}, console: { ...console, info() {} } }; vm.createContext(sandbox);
  vm.runInContext(source("public/vendor/vue.global.js"), sandbox);
  const entities = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
  for (const page of ["rules", "details", "mine"]) {
    const render = sandbox.Vue.compile(source(`src/views/share/${page}/${page}.html`), {
      decodeEntities: (value) => value.replace(/&(?:lt|gt|amp|quot|#39);/g, (match) => entities[match]), onError(error) { throw error; }
    });
    assert.equal(typeof render, "function");
  }
  for (const file of ["operation/dashboard/operation-dashboard", "operation/performance/operation-performance", "finance/reconciliation/reconciliation"]) assert.equal(typeof sandbox.Vue.compile(source(`src/views/${file}.html`), {
    decodeEntities: (value) => value.replace(/&(?:lt|gt|amp|quot|#39);/g, (match) => entities[match]), onError(error) { throw error; }
  }), "function");
});
test("merchant identities cannot load admin data or mutate merchant settings", async () => {
  const f = fixture("merchant");
  await f.ui.loadShareRules(); await f.ui.loadShareDetails(); f.ui.openShareNewMerchant(); await f.ui.saveShareConfig();
  assert.equal(f.calls.length, 0); assert.equal(f.ui.shareState.editorOpen, false);
  f.controls.handler = async () => ({ code: 0, data: { merchant: { name: "本店" }, list: [{ maskedOrderNo: "****1234" }], stats: {} } });
  await f.ui.loadShareMine(); assert.ok(f.calls[0].url.startsWith("/api/share/mine?"));
  assert.equal(f.ui.shareOrderTail({ orderNo: "PRIVATE-ORDER-1234" }), "****1234");
});
test("super preview requires a selected merchant and merchant queries cannot choose another shop", async () => {
  const f = fixture(); await f.ui.loadShareMine(); assert.equal(f.calls.length, 0);
  f.ui.shareState.mineQuery.merchantId = "shop-b"; await f.ui.loadShareMine(); assert.match(f.calls[0].url, /merchantId=shop-b/);
  const merchant = fixture("merchant"); merchant.ui.shareState.mineQuery.merchantId = "other-shop"; await merchant.ui.loadShareMine();
  assert.doesNotMatch(merchant.calls[0].url, /merchantId/);
});

test("merchant orders retain their own pagination and never inflate posted ledger totals", async () => {
  const f = fixture("merchant");
  f.ui.shareState.mineQuery.page = 3;
  f.ui.shareState.mineQuery.orderPage = 2;
  f.ui.shareState.mineQuery.orderSize = 50;
  f.controls.handler = async () => ({ code: 0, data: {
    merchant: { name: "本店" }, list: [{ orderNo: "****1111", amount: "10.00" }], total: 1,
    sum: { netAmount: "10.00" }, stats: { monthAmount: "10.00", accT1Amount: "10.00", accT2Amount: "0.00" },
    orders: [{ orderNo: "****2222", paidAmount: "100.00", status: "observing", statusText: "退款观察期" }],
    orderTotal: 55, orderStats: { total: 55 }, notices: ["合成业务提示"],
  } });
  await f.ui.loadShareMine();
  const query = new URL(f.calls[0].url, "https://synthetic.test").searchParams;
  assert.equal(query.get("page"), "3"); assert.equal(query.get("orderPage"), "2"); assert.equal(query.get("orderSize"), "50");
  assert.equal(f.ui.shareState.mine.orders[0].statusText, "退款观察期");
  assert.equal(f.ui.shareState.mine.orderTotal, 55); assert.equal(f.ui.shareState.mine.list[0].orderNo, "****1111");
  assert.equal(f.ui.shareState.mine.sum.netAmount, "10.00"); assert.equal(f.ui.shareAccumulatedTotal(f.ui.shareState.mine.stats), "10.00");
  f.ui.shareState.mineQuery.period = "2026-10";
  await f.ui.loadShareMine(true);
  const reset = new URL(f.calls[1].url, "https://synthetic.test").searchParams;
  assert.equal(reset.get("page"), "1"); assert.equal(reset.get("orderPage"), "1"); assert.equal(reset.get("period"), "2026-10");
});

test("account changes clear associated orders and prevent late progress results from restoring them", async () => {
  const f = fixture("merchant"); let resolve;
  f.ui.shareState.mine = { ...f.ui.shareState.mine, orders: [{ orderNo: "****1234" }], notices: ["old-account-notice"], orderTotal: 1 };
  f.ui.shareState.mineQuery.orderPage = 3;
  f.controls.handler = () => new Promise(done => { resolve = done; });
  const pending = f.ui.loadShareMine();
  f.listeners["lxm-auth-changed"]();
  resolve({ code: 0, data: { orders: [{ orderNo: "****5678" }], orderTotal: 1, notices: ["late-account-notice"] } });
  await pending;
  assert.deepEqual(plain(f.ui.shareState.mine.orders), []); assert.deepEqual(plain(f.ui.shareState.mine.notices), []);
  assert.equal(f.ui.shareState.mine.orderTotal, 0); assert.equal(f.ui.shareState.mineQuery.orderPage, 1);
});
test("a response from the previous account cannot repopulate cleared share data", async () => {
  const f = fixture(); let resolve;
  f.controls.handler = () => new Promise((done) => { resolve = done; });
  const pending = f.ui.loadShareRules();
  f.ui.shareState.form.password = "temporary"; f.listeners["lxm-auth-changed"]();
  resolve({ code: 0, data: { list: [{ merchantId: "private" }], total: 1 } }); await pending;
  assert.deepEqual(plain(f.ui.shareState.rules), []); assert.equal(f.ui.shareState.form.password, ""); assert.equal(f.ui.shareState.loading.rules, false);
});
test("the latest filter request wins when responses arrive out of order", async () => {
  const f = fixture(); const queue = [];
  f.controls.handler = () => new Promise((resolve) => queue.push(resolve));
  const first = f.ui.loadShareDetails(); f.ui.shareState.detailQuery.merchantId = "B"; const second = f.ui.loadShareDetails();
  queue[1]({ code: 0, data: { list: [{ merchantName: "B" }], total: 1, sum: { netAmount: "8.00" } } }); await second;
  queue[0]({ code: 0, data: { list: [{ merchantName: "A" }], total: 1 } }); await first;
  assert.equal(f.ui.shareState.details[0].merchantName, "B"); assert.equal(f.ui.shareState.detailSum.netAmount, "8.00");
});
test("onboarding requires cooperation and valid rules, sends decimal ratios and retry identity", async () => {
  const f = fixture(); f.ui.openShareNewMerchant();
  Object.assign(f.ui.shareState.form, { name: "门店", account: "shop-a", password: "TestOnly!234", ratioT1: 5.25, ratioT2: 0, reason: "签约开通" });
  await f.ui.saveShareNewMerchant(); assert.equal(f.calls.length, 0); assert.match(f.ui.shareState.formFieldErrors.cooperationConfirmed, /合作/);
  f.ui.shareState.form.cooperationConfirmed = true;
  f.controls.handler = async () => ({ status: 503, code: "RETRY", msg: "稍后重试" });
  await f.ui.saveShareNewMerchant(); await f.ui.saveShareNewMerchant();
  assert.equal(f.calls[0].body.ratioT1, 0.0525); assert.equal(f.calls[0].body.ratioT2, 0);
  assert.equal(f.calls[0].body.ttlHours, undefined); assert.equal(f.calls[0].body.refundWindowDays, 3);
  assert.equal(f.calls[0].init.headers["Idempotency-Key"], f.calls[1].init.headers["Idempotency-Key"]);
  assert.equal(f.ui.shareState.form.name, "门店"); assert.equal(f.ui.shareState.editorOpen, true);
  assert.match(f.ui.shareValidateConfig({ ratioT1: 50.01, ratioT2: 1, ttlHours: 720, refundWindowDays: 3, reason: "x" }), /0–50/);
  assert.match(f.ui.shareValidateConfig({ ratioT1: 5.001, ratioT2: 1, ttlHours: 720, refundWindowDays: 3, reason: "x" }), /两位/);
});
test("config version conflicts retain edits and send the displayed version", async () => {
  const f = fixture(); f.ui.shareState.merchant = { merchant: { merchantId: "shop-a" } };
  f.ui.shareState.configForm = { ratioT1: 5, ratioT2: 8, ttlHours: 720, refundWindowDays: 3, reason: "活动", versionNo: 4 };
  f.controls.handler = async () => ({ status: 409, code: 4091, msg: "配置版本已变化" });
  await f.ui.saveShareConfig(); assert.equal(f.calls[0].body.versionNo, 4); assert.equal(f.calls[0].body.ttlHours, undefined); assert.equal(f.ui.shareState.configForm.ratioT2, 8); assert.match(f.ui.shareState.configError, /版本/);
});
test("missing backend fails visibly and does not fill mock figures", async () => {
  const f = fixture(); f.controls.handler = async () => { throw new Error("网络不可用"); };
  await f.ui.loadShareRules(); assert.match(f.ui.shareState.errors.rules, /网络不可用/); assert.deepEqual(plain(f.ui.shareState.rules), []); assert.deepEqual(plain(f.ui.shareState.summary), {});
  assert.equal(f.ui.shareMoney(undefined), "—"); assert.equal(f.ui.shareMoney("-6.00"), "¥ -6.00"); assert.equal(f.ui.sharePercent(0.5), "50%");
});
test("opening and refreshing the merchant QR keeps actual count and daily trend together without reporting a scan", async () => {
  const f = fixture(); let count = 2;
  f.controls.handler = async (url) => ({ code: 0, data: url.includes("/image?") ? {} : {
    merchant: { merchantId: "shop-a", name: "门店A" }, qr: { id: "qr-a", scanCount: count },
    stats: { scanCount: count, dailyScans: [{ date: "2026-11-13", count }] }, qrHistory: [{ id: "qr-a", scanCount: count }]
  } });
  await f.ui.openShareMerchant({ merchantId: "shop-a" }, "qr");
  assert.equal(f.ui.shareQr.value.scanCount, 2); assert.equal(f.ui.shareDailyScans.value[0].count, 2); assert.ok(f.ui.shareState.qrImage);
  f.ui.shareState.configForm.reason = "未保存的配置原因"; count = 3;
  await f.ui.loadShareQr();
  assert.equal(f.ui.shareQr.value.scanCount, 3); assert.equal(f.ui.shareStats.value.scanCount, 3); assert.equal(f.ui.shareDailyScans.value[0].count, 3);
  assert.equal(f.ui.shareState.merchant.qrHistory[0].scanCount, 3); assert.equal(f.ui.shareState.configForm.reason, "未保存的配置原因");
  assert.equal(f.calls.filter((call) => call.url === "/api/share/merchants/shop-a").length, 2);
  assert.equal(f.calls.some((call) => call.url === "/api/share/merchants/shop-a/qr"), false);
  assert.equal(f.calls.every((call) => !call.init?.method || call.init.method === "GET"), true);
  f.ui.closeShareMerchant();
});
test("QR statistics failure is visible and an old merchant refresh cannot replace the next merchant", async () => {
  const f = fixture(); const detail = (id, count) => ({ code: 0, data: { merchant: { merchantId: id }, qr: { id: "qr-" + id, scanCount: count }, stats: { scanCount: count, dailyScans: [{ date: "2026-11-13", count }] } } });
  f.controls.handler = async () => detail("A", 4);
  await f.ui.openShareMerchant({ merchantId: "A" }, "qr");
  f.controls.handler = async () => ({ status: 503, msg: "扫码统计暂不可用" });
  await f.ui.loadShareQr();
  assert.match(f.ui.shareState.errors.qr, /扫码统计暂不可用/); assert.equal(f.ui.shareQr.value.scanCount, 4); assert.equal(f.ui.shareDailyScans.value[0].count, 4);
  let resolveOld;
  f.controls.handler = (url) => url === "/api/share/merchants/A" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(detail("B", 8));
  const oldRefresh = f.ui.loadShareQr();
  await f.ui.openShareMerchant({ merchantId: "B" }, "qr");
  resolveOld(detail("A", 5)); await oldRefresh;
  assert.equal(f.ui.shareSelectedMerchant.value.merchantId, "B"); assert.equal(f.ui.shareQr.value.id, "qr-B"); assert.equal(f.ui.shareQr.value.scanCount, 8); assert.equal(f.ui.shareDailyScans.value[0].count, 8);
  assert.equal(f.ui.shareState.errors.qr, ""); f.ui.closeShareMerchant();
});
test("super can grant custom role configuration with implied read but cannot grant admin", async () => {
  const f = fixture();
  const roles = [{ id: "ops", name: "运营", roleKey: "custom-ops", sharePermissions: [] }, { id: "finance", name: "财务", roleKey: "finance", sharePermissions: [] }, { id: "super", roleKey: "super" }, { id: "merchant", roleKey: "merchant" }];
  f.controls.handler = async () => ({ code: 0, data: { roles } });
  await f.ui.loadShareGrants(); assert.deepEqual(Array.from(f.ui.shareState.grantRoles.map((row) => row.id)), ["ops", "finance"]);
  f.ui.shareState.grantRoleId = "ops"; f.ui.selectShareGrantRole(); f.ui.shareState.grantPermissions = ["share:config", "share:admin"];
  await f.ui.saveShareGrant();
  const write = f.calls.find((row) => row.init.method === "POST");
  assert.deepEqual(write.body, { roleId: "ops", permissions: ["share:view", "share:config"] });
  f.ui.shareState.grantRoleId = "finance"; f.ui.selectShareGrantRole(); f.ui.shareState.grantPermissions = ["share:view", "share:config"];
  f.ui.shareGrantPermissionsChanged(); assert.deepEqual(Array.from(f.ui.shareState.grantPermissions), ["share:view"]);
});
test("non-super grant calls are blocked and auth clear removes grant drafts", async () => {
  const f = fixture("service"); f.ui.openShareGrants(); await f.ui.loadShareGrants(); await f.ui.saveShareGrant(); assert.equal(f.calls.length, 0);
  const admin = fixture(); admin.ui.shareState.grantsOpen = true; admin.ui.shareState.grantRoles = [{ id: "secret" }]; admin.ui.shareState.grantPermissions = ["share:config"];
  admin.listeners["lxm-auth-expired"](); assert.equal(admin.ui.shareState.grantsOpen, false); assert.equal(admin.ui.shareState.grantRoles.length, 0); assert.equal(admin.ui.shareState.grantPermissions.length, 0);
});
test("merchant rule presence and accumulated amounts use the actual mine response fields", () => {
  const f = fixture("merchant"); assert.equal(f.ui.shareMineConfigured.value, false);
  f.ui.shareState.mine.rule = { ratioT1: 0, ratioT2: 0, ttlHours: 720, refundWindowDays: 3 };
  assert.equal(f.ui.shareMineConfigured.value, true, "zero proportions are configured even without a version field");
  assert.equal(f.ui.shareAccumulatedTotal({ accT1Amount: "45.00", accT2Amount: "30.00" }), "75.00");
  assert.equal(f.ui.shareAccumulatedTotal({ accT1Amount: "0.02", accT2Amount: "-0.01" }), "0.01");
  assert.equal(f.ui.shareAccumulatedTotal({ totalAmount: "0.00", accT1Amount: "45.00", accT2Amount: "30.00" }), "0.00");
  assert.equal(f.ui.shareAccumulatedTotal({ accT1Amount: "45.00" }), undefined);
});
test("timestamps with offsets display in Shanghai while business wall-clock values keep their meaning", () => {
  const f = fixture();
  assert.equal(f.ui.shareTime("2026-11-06T16:30:45.000Z"), "2026-11-07 00:30:45");
  assert.equal(f.ui.shareTime("2026-11-07T00:30:45+08:00"), "2026-11-07 00:30:45");
  assert.equal(f.ui.shareTime("2026-11-07T00:30:45"), "2026-11-07 00:30:45");
  assert.equal(f.ui.shareTime("2026-11-07"), "2026-11-07");
});
test("refund observation and reason validation match the service limits", () => {
  const f = fixture(); const valid = { ratioT1: 5, ratioT2: 8, refundWindowDays: 365, reason: "开通" };
  assert.equal(f.ui.shareValidateConfig(valid), "");
  assert.match(f.ui.shareValidateConfig({ ...valid, refundWindowDays: 366 }), /365/);
  assert.match(f.ui.shareValidateConfig({ ...valid, reason: "字".repeat(256) }), /255/);
});
test("onboarding input errors stay on their fields without clearing the draft", async () => {
  const f = fixture(); f.ui.openShareNewMerchant();
  Object.assign(f.ui.shareState.form, { name: "", account: "shop-test", password: "TestOnly123!", phone: "12345", ratioT1: 0, ratioT2: 0, reason: "", cooperationConfirmed: true });
  await f.ui.saveShareNewMerchant();
  assert.equal(f.calls.length, 0); assert.match(f.ui.shareState.formFieldErrors.name, /商家名称/); assert.match(f.ui.shareState.formFieldErrors.phone, /手机号/); assert.match(f.ui.shareState.formFieldErrors.reason, /原因/);
  assert.equal(f.ui.shareState.formFieldErrors.ratioT1, undefined); assert.equal(f.ui.shareState.formFieldErrors.ratioT2, undefined); assert.equal(f.ui.shareState.formError, "");
  assert.equal(f.ui.shareState.form.phone, "12345"); assert.equal(f.ui.shareState.form.account, "shop-test");
  f.ui.shareState.form.phone = "13800000000"; f.ui.clearShareFieldError("new", "phone"); assert.equal(f.ui.shareState.formFieldErrors.phone, undefined); assert.ok(f.ui.shareState.formFieldErrors.name);
  f.ui.openShareNewMerchant(); assert.deepEqual(plain(f.ui.shareState.formFieldErrors), {});
});
test("server name and account conflicts attach to the relevant onboarding fields; provider failures stay global", async () => {
  const f = fixture(); f.ui.openShareNewMerchant();
  Object.assign(f.ui.shareState.form, { name: "同名门店", account: "shop-test", password: "TestOnly123!", ratioT1: 0, ratioT2: 0, reason: "合作确认", cooperationConfirmed: true });
  f.controls.handler = async () => ({ status: 409, code: "SHARE_4006", msg: "商家名称已存在" }); await f.ui.saveShareNewMerchant();
  assert.match(f.ui.shareState.formFieldErrors.name, /已存在/); assert.equal(f.ui.shareState.formError, ""); assert.equal(f.ui.shareState.form.name, "同名门店");
  f.controls.handler = async () => ({ status: 409, code: "SHARE_4001", msg: "登录账号已存在，请更换账号" }); await f.ui.saveShareNewMerchant();
  assert.match(f.ui.shareState.formFieldErrors.account, /账号/); assert.equal(f.ui.shareState.form.account, "shop-test");
  f.controls.handler = async () => ({ status: 503, code: "PROVIDER_ERROR", msg: "码图服务不可用" }); await f.ui.saveShareNewMerchant();
  assert.equal(f.ui.shareState.formFieldErrors.name, undefined); assert.equal(f.ui.shareState.formFieldErrors.account, undefined); assert.match(f.ui.shareState.formError, /服务不可用/);
});
test("explicit zero proportions can be saved, and a missing config reason blocks the save inline", async () => {
  const f = fixture(); f.ui.openShareNewMerchant();
  Object.assign(f.ui.shareState.form, { name: "零比例门店", account: "shop-zero", password: "TestOnly123!", ratioT1: 0, ratioT2: 0, reason: "先建档", cooperationConfirmed: true });
  f.controls.handler = async (url, init) => ({ code: 0, data: init.method === "POST" ? { merchantId: "zero" } : url.includes("/rules?") ? { list: [], total: 0 } : { merchant: { merchantId: "zero", name: "零比例门店" }, rule: { ratioT1: 0, ratioT2: 0, versionNo: 1, ttlHours: 720, refundWindowDays: 3 } } });
  await f.ui.saveShareNewMerchant(); const saved = f.calls.find((row) => row.init.method === "POST");
  assert.equal(saved.body.ratioT1, 0); assert.equal(saved.body.ratioT2, 0); assert.equal(f.ui.shareState.editorOpen, false);
  const before = f.calls.length; f.ui.shareState.configForm.reason = ""; await f.ui.saveShareConfig();
  assert.equal(f.calls.length, before); assert.match(f.ui.shareState.configFieldErrors.reason, /原因/); assert.equal(f.ui.shareState.configError, ""); assert.equal(f.ui.shareState.configForm.ratioT1, 0);
});
test("export requests all current-month filtered records even above the former estimated volume", async () => {
  const f = fixture(); f.ui.shareState.detailTotal = 2001;
  Object.assign(f.ui.shareState.detailQuery, { merchantId: "chosen", period: "2026-11", splitType: "T2", page: 4, size: 20 });
  // The download provider's failure is visible, but the frontend must send the
  // full filtered export request rather than truncate/block at 2000 rows.
  f.controls.handler = async () => ({ status: 503, msg: "测试下载服务暂不可用" });
  await f.ui.exportShareDetails();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/details\/export\?/); assert.match(f.calls[0].url, /period=2026-11/); assert.match(f.calls[0].url, /merchantId=chosen/); assert.match(f.calls[0].url, /splitType=T2/);
  assert.doesNotMatch(f.calls[0].url, /(?:page|size|limit)=/); assert.equal(f.notices.some((row) => row.type === "warning"), false);
});
test("super rule help reads actual business settings without exposing endpoint URLs or implying a future launch is active", async () => {
  const f = fixture();
  f.controls.handler = async () => ({ code: 0, data: { enabled: true, enableAt: "2027-01-01T00:00:00+08:00", defaultTtlHours: 960, defaultRefundWindowDays: 3, csAttrDays: 0, maxCandidateMerchants: 12, scanDedupSeconds: 8, judgeRetryMax: 3, engineVersion: "test-2.0", phoneAlertConfigured: true, operationalAlertConfigured: false, webhookUrl: "https://DO_NOT_SHOW.invalid/hook", secret: "DO_NOT_SHOW" } });
  f.ui.openShareHelp(); await new Promise(setImmediate);
  assert.equal(f.ui.shareState.helpOpen, true); assert.equal(f.calls[0].url, "/api/share/settings"); assert.equal(f.calls[0].init.method, "GET"); assert.equal(f.calls[0].body, undefined);
  const rows = f.ui.shareSettingsRows.value; assert.equal(rows.length, 9);
  assert.equal(rows.some((row) => ["defaultTtlHours", "maxCandidateMerchants"].includes(row.key)), false); assert.equal(rows.find((row) => row.key === "csAttrDays").value, "仅本次会话");
  assert.equal(rows.find((row) => row.key === "enableAt").value, "2027-01-01 00:00:00");
  assert.equal(rows.find((row) => row.key === "enabled").label, "启用日配置状态"); assert.equal(rows.find((row) => row.key === "enabled").value, "已配置");
  assert.equal(rows.find((row) => row.key === "phoneAlertConfigured").value, "已配置"); assert.equal(rows.find((row) => row.key === "operationalAlertConfigured").value, "未配置");
  assert.doesNotMatch(JSON.stringify(f.ui.shareState.settings), /DO_NOT_SHOW|webhookUrl|secret/); assert.doesNotMatch(JSON.stringify(rows), /已启用|发送成功/);
});
test("settings failure can be retried, non-super roles cannot request it, and auth clear discards late results", async () => {
  for (const role of ["merchant", "finance", "service", "custom-ops"]) {
    const f = fixture(role); f.ctx.can = () => true; f.ui.openShareHelp(); await f.ui.loadShareSettings(); assert.equal(f.calls.length, 0); assert.equal(f.ui.shareSettingsRows.value.length, 0);
  }
  const f = fixture(); f.controls.handler = async () => ({ status: 503, msg: "参数读取暂不可用 https://DO_NOT_SHOW.invalid/hook" }); await f.ui.loadShareSettings();
  assert.match(f.ui.shareState.settingsError, /暂不可用/); assert.equal(f.ui.shareState.settings, null); assert.equal(f.ui.shareState.settingsLoading, false);
  assert.doesNotMatch(f.ui.shareState.settingsError, /DO_NOT_SHOW|https/);
  f.controls.handler = async () => ({ code: 0, data: { enabled: false, enableAt: null, scanDedupSeconds: 5 } }); await f.ui.loadShareSettings();
  assert.equal(f.ui.shareState.settingsError, ""); assert.equal(f.ui.shareSettingsRows.value.find((row) => row.key === "enableAt").value, "未设置");
  let resolve; f.controls.handler = () => new Promise((done) => { resolve = done; }); const pending = f.ui.loadShareSettings(); assert.equal(f.ui.shareState.settingsLoading, true);
  f.listeners["lxm-auth-expired"](); resolve({ code: 0, data: { enabled: true, defaultTtlHours: 100 } }); await pending;
  assert.equal(f.ui.shareState.settings, null); assert.equal(f.ui.shareState.settingsLoading, false); assert.equal(f.ui.shareSettingsRows.value.length, 0);
});
