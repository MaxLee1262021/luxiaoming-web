"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createSvcMemoryStore } = require("../../server/lib/svcStore.cjs");
const { createSvcWorkbench } = require("../../server/lib/svcWorkbench.cjs");
const core = require("../../server/lib/svcCore.cjs");
const root = path.resolve(__dirname, "../..");
const script = fs.readFileSync(path.join(root, "src/views/service/general-workbench/general-workbench.js"), "utf8");
const template = fs.readFileSync(path.join(root, "src/views/service/general-workbench/general-workbench.html"), "utf8");
const actor = { kind: "admin", role: "service", authzUserId: "account-test" };
const clock = "2026-11-20 10:00:00";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = data => ({ ok: true, status: 200, async json() { return { code: 0, msg: "ok", data: structuredClone(data) }; } });
const wireFailure = (code, message) => ({ ok: false, status: 503, async json() { return { code, msg: message }; } });
function seed() {
  const rows = [
    ["confirmed", "p1", "2026-11-21 14:00:00"], ["shooting", "p2", "2026-11-22 10:00:00"],
    ["claimed", null, null], ["new", null, null], ["new", null, null],
    ["confirmed", "p2", "2026-11-23 19:00:00"], ["final_pending", "p1", "2026-11-24 10:00:00"], ["claimed", null, null],
  ];
  return {
    staff: [{ id: "st1", account_id: "account-test", name: "测试客服", staff_status: "active" }],
    photographers: [{ id: "p1", name: "摄影师一", status: "active" }, { id: "p2", name: "摄影师二", status: "active" }],
    configs: [{ id: "1", ...core.DEFAULT_CONFIG, ver: 1, eff_at: "2026-11-01 00:00:00" }],
    rules: [{ id: "1", ver: 1, beneficiary_type: "service", party_id: null, rate_photo_bp: 300, rate_video_bp: 300, rate_combo_bp: 300, rate_peripheral_bp: 300, eff_at: "2026-11-01 00:00:00" }],
    orders: rows.map(([service_status, photo_id, schedule_time], index) => ({
      id: `order${index + 1}`, order_no: `UI-${index + 1}`, service_status, photo_id, schedule_time,
      assignee_id: service_status === "new" ? null : "st1", category: "photo", product_name: "测试留影",
      customer_openid: `customer-${index + 1}`, customer_name: "测试客人", phone: "13912345678",
      requested_time: "2026-11-21 14:00:00", paid_at: "2026-11-19 09:00:00", created_at: "2026-11-19 08:00:00",
      svc_paid_processed: 1, service_managed: true, net_amount_fen: 50000,
      totalAmount: 500, depositDue: 50, depositPaid: 50, depositFinanceStatus: "confirmed", finalDue: 450, finalPaid: 0,
    })),
  };
}
function fixture(t, options = {}) {
  const initial = seed(); if (options.busy) initial.orders.push({ ...initial.orders[0], id: "other-busy", order_no: "OTHER-BUSY", customer_openid: "other-customer" });
  const store = createSvcMemoryStore(initial);
  const app = createSvcWorkbench({ store, clock: () => new Date(core.millis(clock)) });
  const mounts = [], unmounts = [], calls = [], messages = [], confirmations = [];
  let hook, confirm = async () => true;
  const vue = { reactive: value => value, computed: getter => ({ get value() { return getter(); } }), ref: value => ({ value }),
    markRaw: value => value, nextTick: async () => {}, provide() {}, onMounted: fn => mounts.push(fn), onUnmounted: fn => unmounts.push(fn) };
  const ctx = {
    state: { role: "service", currentStaffId: "st1", active: "svcGeneralWorkbench" },
    ElMessage: Object.fromEntries(["warning", "error", "success", "info"].map(type => [type, value => messages.push({ type, value })])),
    ElMessageBox: { async confirm(...args) { confirmations.push(args); return confirm(...args); } },
  };
  const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const window = { Vue: vue, LXM_PAGES: { register(page) { window.page = page; } }, LXM_HTTP: { async request(rawUrl, init = {}) {
    const url = new URL(rawUrl, "https://ui.example.test");
    const call = { url: rawUrl, pathname: url.pathname, method: init.method || "GET", body: init.body && JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    const run = async () => {
      try { return response(await app.execute(call.method, url.pathname, call.method === "GET" ? Object.fromEntries(url.searchParams) : call.body || {}, actor)); }
      catch (error) { return { ok: Number(error.statusCode || 200) < 400, status: error.statusCode || 200, async json() { return { code: error.code, msg: error.message }; } }; }
    };
    const intercepted = hook ? await hook(call, run) : undefined;
    return intercepted === undefined ? run() : intercepted;
  } } };
  vm.runInNewContext(script, { window, Vue: vue, document, AbortController, URLSearchParams, URL, Date, Intl, WeakMap, Proxy,
    setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => { throw new Error("unexpected template request"); },
    location: { href: "https://ui.example.test/#svcGeneralWorkbench" }, navigator: { userAgent: "ui-test wxwork/4.1" } });
  const page = window.page.setup(ctx);
  let stopped = false;
  const unmount = () => { if (!stopped) { stopped = true; unmounts.forEach(fn => fn()); } };
  t.after(unmount);
  return { page, store, app, calls, messages, confirmations, window, ctx, unmount,
    hook(fn) { hook = fn; }, confirm(fn) { confirm = fn; },
    async load() { await page.gwLoad(); },
    async row(number) { return app.execute("GET", `/api/kf/orders/UI-${number}`, {}, actor); },
    writes() { return calls.filter(call => call.method === "POST"); },
  };
}

test("all six action types and the screenshot's eight rows retain 22 separate inline buttons", async t => {
  const f = fixture(t); await f.load();
  const expected = [["登记派单", "改期", "转派", "详情"], ["详情"], ["确认时间", "登记派单", "改期", "详情"], ["认领", "详情"], ["认领", "详情"], ["登记派单", "改期", "转派", "详情"], ["详情"], ["确认时间", "登记派单", "改期", "详情"]];
  const actual = [];
  for (let index = 1; index <= 8; index++) actual.push(Array.from(f.page.gwActions(await f.row(index)), button => button.label));
  assert.deepEqual(actual, expected); assert.equal(actual.flat().length, 22); assert.equal(new Set(actual.flat()).size, 6);
  assert.equal(f.page.gwCards.value.length, 6);
  assert.match(template, /v-for="button in gwActions\(row\)"/);
  assert.equal(/el-dropdown/.test(template), false, "actions must remain inline");
});

test("claimed dispatch saves confirm and assign separately through the real business contract", async t => {
  const f = fixture(t); await f.load();
  await f.page.gwOpen("assign", await f.row(3));
  assert.equal(f.page.gw.action, "wizard"); assert.equal(f.page.gw.wizardStep, "confirm");
  await f.page.gwSubmit();
  assert.equal(f.page.gw.wizardStep, "assign"); assert.equal(f.page.gw.confirmedInWizard, true);
  assert.equal(f.store.snapshot().orders.find(row => row.order_no === "UI-3").service_status, "confirmed");
  f.page.gw.form.to_photo = "p2"; f.page.gw.form.reason = "线下确认承接";
  await f.page.gwSubmit();
  assert.deepEqual(f.writes().map(call => call.pathname), ["/api/kf/orders/UI-3/slot/confirm", "/api/kf/orders/UI-3/assign"]);
  assert.equal(f.writes()[0].body.expected_status, "claimed"); assert.equal(f.writes()[1].body.expected_status, "confirmed");
  assert.equal(f.page.gw.action, "");
  const final = f.store.snapshot().orders.find(row => row.order_no === "UI-3");
  assert.equal(final.photo_id, "p2"); assert.equal(final.assignee_id, "st1");
});

test("failed or cancelled second dispatch step preserves confirmed time and retries only assignment", async t => {
  const f = fixture(t); await f.load(); await f.page.gwOpen("assign", await f.row(3)); await f.page.gwSubmit();
  f.hook(call => call.method === "POST" && call.pathname.endsWith("/assign") ? wireFailure(4009, "摄影师暂不可用") : undefined);
  f.page.gw.form.to_photo = "p1"; f.page.gw.form.reason = "安排"; await f.page.gwSubmit();
  assert.equal(f.page.gw.wizardStep, "assign"); assert.equal(f.page.gw.confirmedInWizard, true);
  assert.equal(f.store.snapshot().orders.find(row => row.order_no === "UI-3").photo_id, null);
  f.page.gwCloseAction(); assert.equal(f.page.gw.action, "");
  assert.equal(f.store.snapshot().orders.find(row => row.order_no === "UI-3").service_status, "confirmed");
  f.hook(); await f.page.gwOpen("assign", await f.row(3));
  assert.equal(f.page.gwEffectiveAction.value, "assign");
  f.page.gw.form.to_photo = "p2"; f.page.gw.form.reason = "恢复安排"; await f.page.gwSubmit();
  assert.equal(f.writes().filter(call => call.pathname.endsWith("/slot/confirm")).length, 1);
  assert.equal(f.store.snapshot().orders.find(row => row.order_no === "UI-3").photo_id, "p2");
});

test("unknown confirmation result blocks duplicate writes until readback restores the assign step", async t => {
  const f = fixture(t); await f.load(); await f.page.gwOpen("assign", await f.row(3));
  f.hook(async (call, run) => {
    if (call.method === "POST" && call.pathname.endsWith("/slot/confirm")) { await run(); throw new Error("response lost after save"); }
    if (call.method === "GET" && call.pathname === "/api/kf/orders/UI-3") throw new Error("readback unavailable");
  });
  await f.page.gwSubmit(); assert.equal(f.page.gw.actionUnknown, true);
  await f.page.gwSubmit(); assert.equal(f.writes().length, 1);
  f.hook(); await f.page.gwCheckAction();
  assert.equal(f.page.gw.actionUnknown, false); assert.equal(f.page.gw.wizardStep, "assign");
  f.page.gw.form.to_photo = "p2"; f.page.gw.form.reason = "核对后安排"; await f.page.gwSubmit();
  assert.deepEqual(f.writes().map(call => call.pathname), ["/api/kf/orders/UI-3/slot/confirm", "/api/kf/orders/UI-3/assign"]);
});

test("existing dispatch record is read-only and transfers only after the separate explicit action", async t => {
  const f = fixture(t); await f.load(); await f.page.gwOpen("assign", await f.row(1));
  assert.equal(f.page.gw.record, true); assert.equal(f.page.gw.recordOrder.photo_id, "p1"); assert.deepEqual(f.writes(), []);
  await f.page.gwOpen("transfer", f.page.gw.recordOrder);
  f.page.gw.form.to_photo = "p2"; f.page.gw.form.reason = "原摄影师有事"; await f.page.gwSubmit();
  assert.deepEqual(f.writes().map(call => call.pathname), ["/api/kf/orders/UI-1/transfer"]);
  const order = f.store.snapshot().orders.find(row => row.order_no === "UI-1");
  assert.equal(order.photo_id, "p2"); assert.equal(order.assignee_id, "st1");
});

test("slot conflicts exclude the current order; cancellation writes nothing and continuing writes once", async t => {
  const f = fixture(t, { busy: true }); await f.load(); await f.page.gwOpen("reschedule", await f.row(1));
  await f.page.gwLoadOccupancy();
  f.page.gw.form.reason = "根据客人要求调整";
  assert.equal(f.page.gwConflictCount.value, 1, "current UI-1 must not count as its own conflict");
  assert.equal(f.page.gwBuckets.value.find(bucket => bucket.key === "PM").count, 1);
  f.confirm(async () => { throw new Error("cancel"); }); await f.page.gwSubmit(); assert.deepEqual(f.writes(), []);
  const gate = deferred(); f.confirm(() => gate.promise);
  const pending = f.page.gwSubmit(); await f.page.gwSubmit();
  assert.equal(f.confirmations.length, 2, "duplicate click cannot open another confirmation");
  gate.resolve(true); await pending;
  assert.deepEqual(f.writes().map(call => call.pathname), ["/api/kf/orders/UI-1/slot/reschedule"]);
});

test("changing the final time while a conflict confirmation is open invalidates its approval", async t => {
  const f = fixture(t, { busy: true }); await f.load(); await f.page.gwOpen("reschedule", await f.row(1)); await f.page.gwLoadOccupancy();
  f.page.gw.form.reason = "改期";
  const gate = deferred(); f.confirm(() => gate.promise);
  const pending = f.page.gwSubmit();
  f.page.gw.form.new_time = "2026-11-21 19:00:00";
  gate.resolve(true); await pending;
  assert.deepEqual(f.writes(), []); assert.match(f.page.gw.actionError, /变化/);
});

test("only-self occupancy is not a conflict, and bucket recommendations do not edit assignment time", async t => {
  const f = fixture(t); await f.load(); await f.page.gwOpen("reschedule", await f.row(1)); await f.page.gwLoadOccupancy();
  assert.equal(f.page.gwConflictCount.value, 0);
  f.page.gwChooseDate("2026-11-22"); f.page.gwChooseBucket(f.page.gwBuckets.value.find(bucket => bucket.key === "AM"));
  assert.equal(f.page.gw.form.new_time, "2026-11-22 10:00:00");
  f.page.gwCloseAction(); await f.page.gwOpen("assign", await f.row(3)); await f.page.gwSubmit();
  const assignedTime = f.page.gw.form.new_time;
  f.page.gwChooseDate("2026-11-23"); f.page.gwChooseBucket(f.page.gwBuckets.value.find(bucket => bucket.key === "EVE"));
  assert.equal(f.page.gw.form.new_time, assignedTime);
});

test("phone and free-text masking preserves 12-digit identifiers and landlines without mutating source data", t => {
  const f = fixture(t);
  assert.equal(f.page.gwMask("请拨13912345678，备用0731-88886666"), "请拨139****5678，备用0731-88886666");
  assert.equal(f.page.gwMask("编号139123456789或013912345678"), "编号139123456789或013912345678");
  assert.equal(f.page.gwPhone("13912345678"), "139****5678"); assert.equal(f.page.gwPhone("+86 13912345678"), "联系方式已隐藏");
  assert.equal(f.page.gwPhone("139****5678"), "139****5678");
  assert.equal(f.store.snapshot().orders[0].phone, "13912345678");
});

test("late list and detail responses cannot repopulate a destroyed new workbench instance", async t => {
  const f = fixture(t); const listGate = deferred(), detailGate = deferred();
  f.hook(call => call.pathname === "/api/kf/workbench/general" ? listGate.promise : call.pathname === "/api/kf/orders/UI-1" ? detailGate.promise : undefined);
  const list = f.page.gwLoad(), detail = f.page.gwDetail({ order_no: "UI-1" });
  f.unmount();
  listGate.resolve(response({ list: [{ order_no: "LATE" }], total: 1, cards: { pool: 999 }, reserved: { list: [], total: 0 } }));
  detailGate.resolve(response({ order_no: "UI-1", customer_name: "late detail" }));
  await Promise.all([list, detail]);
  assert.equal(f.page.gw.rows.length, 0); assert.equal(f.page.gw.detail, null); assert.equal(f.page.gw.cards.pool, undefined);
});

test("a reschedule saved before a lost response is recognized by readback without submitting it again", async t => {
  const f = fixture(t); await f.load(); await f.page.gwOpen("reschedule", await f.row(1));
  f.page.gw.form.new_time = "2026-11-22 19:00:00"; f.page.gw.form.reason = "客人调整";
  f.hook(async (call, run) => {
    if (call.method === "POST" && call.pathname.endsWith("/slot/reschedule")) { await run(); throw new Error("response lost after save"); }
  });
  await f.page.gwSubmit();
  assert.equal(f.store.snapshot().orders.find(row => row.order_no === "UI-1").schedule_time, "2026-11-22 19:00:00");
  assert.equal(f.page.gw.action, "", "confirmed reschedule must not remain available for an accidental duplicate submission");
  await f.page.gwSubmit(); assert.equal(f.writes().length, 1);
});

test("late enterprise-chat completion cannot update an unmounted page", async t => {
  const f = fixture(t), started = deferred(), opened = deferred();
  f.window.ww = { register() {}, openEnterpriseChat() { started.resolve(); return opened.promise; } };
  f.hook(call => call.pathname.endsWith("/contact") ? response({ kind: "wecom_jsapi", corp_id: "ww_test", agent_id: 100001, config_signature: {}, agent_signature: {}, params: { externalUserIds: ["wm_TEST"] } }) : undefined);
  const pending = f.page.gwContact({ order_no: "UI-1" }); await started.promise;
  f.unmount(); opened.resolve({ errMsg: "openEnterpriseChat:ok" }); await pending;
  assert.equal(f.page.gw.contactMessage, ""); assert.equal(f.page.gw.contactError, "");
});

test("switching or closing order detail invalidates an in-flight contact preparation before SDK invocation", async t => {
  for (const action of ["switch", "close"]) {
    const f = fixture(t), gate = deferred(); let registrations = 0, opened = 0;
    await f.page.gwDetail({ order_no: "UI-1" });
    f.window.ww = { register() { registrations++; }, async openEnterpriseChat() { opened++; } };
    f.hook(call => call.pathname.endsWith("/contact") ? gate.promise : undefined);
    const pending = f.page.gwContact(f.page.gw.detail);
    if (action === "switch") await f.page.gwDetail({ order_no: "UI-2" }); else f.page.gwCloseDetail();
    gate.resolve(response({ kind: "wecom_jsapi", corp_id: "ww_test", agent_id: 100001, config_signature: {}, agent_signature: {}, params: { externalUserIds: ["wm_ORDER_ONE"] } }));
    await pending;
    assert.equal(registrations, 0); assert.equal(opened, 0); assert.equal(f.page.gw.contactMessage, "");
    assert.equal(f.page.gw.contactError, ""); assert.equal(f.page.gw.contactLoading, false);
    assert.equal(f.page.gw.detail?.order_no || null, action === "switch" ? "UI-2" : null);
  }
});

test("contact completion from order A cannot overwrite feedback for a newly opened order B", async t => {
  const f = fixture(t), started = deferred(), gate = deferred();
  await f.page.gwDetail({ order_no: "UI-1" });
  f.window.ww = { register() {}, openEnterpriseChat() { started.resolve(); return gate.promise; } };
  f.hook(call => call.pathname.endsWith("/contact") ? response({ kind: "wecom_jsapi", corp_id: "ww_test", agent_id: 100001, config_signature: {}, agent_signature: {}, params: { externalUserIds: ["wm_ORDER_ONE"] } }) : undefined);
  const pending = f.page.gwContact(f.page.gw.detail); await started.promise;
  await f.page.gwDetail({ order_no: "UI-2" });
  gate.resolve({ errMsg: "openEnterpriseChat:ok" }); await pending;
  assert.equal(f.page.gw.detail.order_no, "UI-2"); assert.equal(f.page.gw.contactMessage, ""); assert.equal(f.page.gw.contactError, "");
});

test("late photographer loading cannot start a new occupancy request after unmount", async t => {
  const f = fixture(t); await f.load(); const gate = deferred();
  f.hook(call => call.pathname === "/api/kf/photographers" ? gate.promise : undefined);
  const pending = f.page.gwOpen("reschedule", await f.row(1));
  const before = f.calls.length; f.unmount();
  gate.resolve(response({ list: [{ id: "p1", name: "摄影师一", status: "active" }] })); await pending;
  assert.equal(f.calls.length, before, "destroyed component must not start another dependent request");
});

test("Vue compiles the independent workbench template", () => {
  const sandbox = { window: {}, console: { info() {}, warn() {}, log() {} } };
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(root, "public/vendor/vue.global.js"), "utf8"), sandbox);
  assert.equal(typeof sandbox.Vue.compile(template, { onError(error) { throw error; }, decodeEntities: value => value }), "function");
});
