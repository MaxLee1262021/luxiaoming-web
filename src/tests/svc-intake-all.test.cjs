"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const script = fs.readFileSync(path.resolve(__dirname, "../api/svc-workbench-ui.js"), "utf8");
function fixture(role = "super") {
  let mount, unmount;
  const requests = [], timers = [], controls = { rows: [], confirmCount: 0, afterSales: [] };
  const window = { LXM_HTTP: { async request(url, init = {}) {
    requests.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    return { ok: true, json: async () => ({ code: 0, data: { list: controls.rows, total: controls.rows.length, reserved: { list: [] } } }) };
  } } };
  const ctx = { state: { role, currentStaffId: "S1" }, ElMessage: { success() {}, warning() {}, error() {} }, ElMessageBox: { async confirm() { controls.confirmCount++; } }, switchMenu() {}, async openServiceAfterSale(orderNo) { controls.afterSales.push(orderNo); } };
  vm.runInNewContext(script, { window, Vue: { reactive: v => v, computed: fn => ({ get value() { return fn(); } }), onMounted: fn => { mount = fn; }, onUnmounted: fn => { unmount = fn; } }, URLSearchParams, AbortController, Intl, Date, setTimeout, clearTimeout, setInterval: (fn, interval) => { timers.push({ fn, interval }); return timers.length; }, clearInterval() {}, document: { visibilityState: "visible" } });
  return { ui: window.LXM_SVC_WORKBENCH_SETUP(ctx, "intake"), controls, requests, timers, mount: () => mount(), unmount: () => unmount() };
}

test("intake opens all orders, preserves unpaid and historical rows, and refreshes new orders without switching pages", async () => {
  const f = fixture();
  f.controls.rows = [{ order_no: "UNPAID", service_status: "new", payment_status: "unpaid", has_paid: false, paid_at: null, created_at: "2026-11-13 10:00:00", can_claim: false, can_operate: false }, { order_no: "HISTORY", service_status: "done", can_operate: false }];
  await f.mount();
  assert.equal(new URL(f.requests[0].url, "http://test").searchParams.get("tab"), "all");
  assert.deepEqual(Array.from(f.ui.kfRows.value, row => row.order_no), ["UNPAID", "HISTORY"]);
  assert.equal(f.ui.kfPaymentLabel(f.controls.rows[0]), "未支付");
  assert.equal(f.ui.kfStatusLabel(f.controls.rows[0]), "待支付");
  assert.equal(f.ui.kfCreatedTime(f.controls.rows[0]), "2026-11-13 10:00:00");
  assert.equal(f.ui.kfTime(f.controls.rows[0].paid_at), "—");
  assert.equal(f.ui.kfPaymentLabel({ payment_status: "waived", payment_status_label: "免定金", has_paid: false }), "免定金");
  f.controls.rows = [...f.controls.rows, { order_no: "NEW", service_status: "new", can_claim: true }];
  await f.timers.find(timer => timer.interval === 30000).fn();
  assert.equal(f.ui.kfRows.value.length, 3);
  for (const tab of ["pool", "mine", "all"]) {
    f.ui.kf.tab = tab;
    await f.ui.kfLoad();
    assert.equal(new URL(f.requests.at(-1).url, "http://test").searchParams.get("tab"), tab);
  }
  f.unmount();
});

test("read-only orders cannot trigger claims, schedule edits, shooting, receipts, links or aftersales", async () => {
  const f = fixture(), row = { order_no: "READONLY", service_status: "claimed", can_claim: false, can_operate: false, can_complaint: false, can_generate_link: false };
  assert.equal(f.ui.kfCanAct(row), false);
  assert.equal(f.ui.kfCanClaim({ ...row, service_status: "new" }), false);
  assert.equal(f.ui.kfCanClaim({ order_no: "UNKNOWN", service_status: "new" }), false, "recognition requires an explicit API permission");
  assert.equal(f.ui.kfCanAftersale(row), false);
  await f.ui.kfClaim({ ...row, service_status: "new" });
  for (const kind of ["confirm", "reschedule", "assign", "transfer"]) await f.ui.kfOpen(kind, row);
  await f.ui.kfShoot(row, "finish");
  await f.ui.kfReserve({ ...row, service_status: "reserved" }, "take");
  await f.ui.kfReceipt({ ...row, category: "peripheral" });
  f.ui.kf.linkOrder = row; await f.ui.kfGenerateLink();
  f.ui.kf.detail = row; await f.ui.kfDrawerTab("actions");
  f.ui.kfAftersale(row);
  assert.equal(f.requests.length, 0);
  assert.equal(f.controls.confirmCount, 0);
  assert.equal(f.ui.kf.dialog, "");
  assert.equal(f.ui.kf.fromOrder, "");
});

test("claimability follows server permission for paid and waived deposits while finance remains read-only", async () => {
  for (const row of [{ order_no: "PAID", service_status: "new", can_claim: true }, { order_no: "WAIVED", service_status: "new", payment_status: "waived", can_claim: true }]) {
    const f = fixture("service");
    assert.equal(f.ui.kfCanClaim(row), true);
    await f.ui.kfClaim(row);
    assert.equal(f.requests[0].method, "POST");
    assert.equal(f.requests[0].url, `/api/kf/orders/${row.order_no}/claim`);
  }
  const f = fixture("finance");
  await f.ui.kfClaim({ order_no: "PAID", service_status: "new", can_claim: true });
  assert.equal(f.requests.length, 0);
});

test("ownership labels distinguish public claim candidates from missing historical attribution", () => {
  const {ui} = fixture();
  assert.equal(ui.kfAssigneeLabel({service_status:"new",payment_status:"paid"}),"公共池");
  assert.equal(ui.kfAssigneeLabel({service_status:"new",payment_status:"unpaid"}),"待支付");
  assert.equal(ui.kfAssigneeLabel({service_status:"confirmed",payment_status:"paid"}),"未记录客服归属");
  assert.equal(ui.kfAssigneeLabel({service_status:"done",payment_status:"paid"}),"未记录客服归属");
  assert.equal(ui.kfAssigneeLabel({service_status:"reserved",reserve_staff_name:"客服甲"}),"客服甲");
  assert.equal(ui.kfAssigneeLabel({service_status:"confirmed",assignee_name:"客服乙"}),"客服乙");
});

test("live service after-sale entry resolves the real order number and ignores projection ids", async () => {
  const f = fixture("service");
  await f.ui.kfAftersale({ id: 44, order_no: "ACTUAL-ORDER", service_status: "done", can_complaint: true });
  assert.deepEqual(f.controls.afterSales, ["ACTUAL-ORDER"]);
  assert.equal(f.ui.kf.fromOrder, "", "the refund issue does not go to responsibility-only complaint registration");
  assert.equal(f.requests.length, 0, "the app's authorized business-document adapter owns issue lookup");
  assert.equal(f.ui.kf.busy, false);
});
