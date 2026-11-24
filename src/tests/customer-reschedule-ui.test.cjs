"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../api/svc-workbench-ui.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const pending = overrides => ({ id: "order-1", orderNo: "LM-1", status: "deposit_paid", workflowStage: "awaiting_dispatch", assigneeId: "s1", appointmentAt: "2026-12-01", timePeriod: "10:00", rescheduleRequest: { id: "request-1", status: "pending", appointmentAt: "2026-12-02", timePeriod: "14:30", reason: "出行时间调整", requestedAt: "2026-11-15 11:00:00" }, ...overrides });

function fixture(role = "service") {
  let mount, unmount;
  const calls = [], messages = [];
  const control = { rows: [], confirm: async () => {}, prompt: async () => ({ value: "该时段已约满" }), save: async id => {
    control.rows = control.rows.filter(row => row.id !== id);
    return {};
  } };
  const window = {
    LXM_CLOUD: {
      async getColl(key) { calls.push({ kind: "list", key }); return control.list ? control.list() : control.rows; },
      async orderAction(id, action, payload) { calls.push({ kind: "action", id, action, payload }); return control.save(id, payload); }
    },
    LXM_HTTP: { async request(url) { calls.push({ kind: "overview", url }); return { ok: true, json: async () => ({ code: 0, data: { list: [], reserved: { list: [] } } }) }; } }
  };
  const ctx = { state: { role, currentStaffId: "s1" }, ElMessage: Object.fromEntries(["success", "error", "warning"].map(kind => [kind, text => messages.push({ kind, text })])), ElMessageBox: { confirm: (...args) => control.confirm(...args), prompt: (...args) => control.prompt(...args) }, switchMenu() {} };
  vm.runInNewContext(source, { window, Vue: { reactive: value => value, computed: fn => ({ get value() { return fn(); } }), onMounted: fn => { mount = fn; }, onUnmounted: fn => { unmount = fn; } }, URLSearchParams, AbortController, Intl, Date, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, document: { visibilityState: "visible" } });
  return { ui: window.LXM_SVC_WORKBENCH_SETUP(ctx, "workbench"), calls, control, messages, mount: () => mount(), unmount: () => unmount() };
}

test("customer reschedule queue loads only when opened and keeps pending requests in submission order", async () => {
  const f = fixture();
  const first = pending(), second = pending({ id: "order-2", rescheduleRequest: { ...pending().rescheduleRequest, id: "request-2", requestedAt: "2026-11-16 11:00:00" } });
  f.control.rows = [second, pending({ rescheduleRequest: { status: "approved" } }), first];
  await f.mount();
  assert.equal(f.calls.filter(call => call.kind === "list").length, 0);
  await f.ui.kfOpenReschedules();
  assert.equal(f.ui.kf.rescheduleVisible, true);
  assert.deepEqual(Array.from(f.ui.kf.rescheduleRows, row => row.id), ["order-1", "order-2"]);
  assert.equal(f.ui.kf.rescheduleRows[0].appointmentAt, "2026-12-01");
  f.unmount();
});

test("approval keeps the old schedule until the protected action resolves and suppresses duplicate clicks", async () => {
  const f = fixture(), row = pending(); f.control.rows = [row];
  let confirm, resolveSave;
  f.control.confirm = () => new Promise(resolve => { confirm = resolve; });
  f.control.save = () => new Promise(resolve => { resolveSave = resolve; });
  await f.ui.kfOpenReschedules();
  const action = f.ui.kfReviewReschedule(row, true);
  await f.ui.kfReviewReschedule(row, true);
  assert.equal(f.calls.filter(call => call.kind === "action").length, 0);
  assert.equal(f.ui.kf.rescheduleBusy, true);
  confirm(); await Promise.resolve(); await Promise.resolve();
  const submitted = f.calls.find(call => call.kind === "action");
  assert.deepEqual(plain(submitted), { kind: "action", id: "order-1", action: "reviewreschedule", payload: { requestId: "request-1", approved: true, reason: "同意客人改期申请" } });
  assert.equal(row.appointmentAt, "2026-12-01");
  assert.equal(row.rescheduleRequest.status, "pending");
  f.control.rows = []; resolveSave({}); await action;
  assert.equal(f.ui.kf.rescheduleRows.length, 0);
  assert.equal(f.ui.kf.rescheduleBusy, false);
  assert.ok(f.messages.some(message => message.kind === "success"));
});

test("rejection sends the customer-visible reason and never changes the original schedule", async () => {
  const f = fixture(), row = pending(); f.control.rows = [row];
  await f.ui.kfOpenReschedules(); await f.ui.kfReviewReschedule(row, false);
  const action = f.calls.find(call => call.kind === "action");
  assert.equal(action.payload.approved, false);
  assert.equal(action.payload.reason, "该时段已约满");
  assert.equal(row.appointmentAt, "2026-12-01");
  assert.equal(row.timePeriod, "10:00");
  assert.equal(f.ui.kf.rescheduleBusy, false);
});

test("canceling approval or providing an invalid rejection reason never writes an action", async () => {
  const f = fixture(), row = pending();
  f.control.confirm = async () => { throw "cancel"; };
  await f.ui.kfReviewReschedule(row, true);
  f.control.prompt = async () => ({ value: " " });
  await f.ui.kfReviewReschedule(row, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.ui.kf.rescheduleBusy, false);
});

test("shooting, terminal states and other staff ownership revoke approval while finance cannot review", async () => {
  const f = fixture();
  for (const fields of [{ status: "shooting" }, { businessStatus: "shooting" }, { service_status: "done" }, { shootingStartedAt: "2026-11-15 12:00:00" }, { assigneeId: "other" }]) {
    const row = pending(fields);
    assert.equal(f.ui.kfRescheduleCanApprove(row), false);
    await f.ui.kfReviewReschedule(row, true);
  }
  assert.equal(f.ui.kfRescheduleCanReview(pending({ assigneeId: "" })), true, "unclaimed requests can be reviewed");
  assert.equal(f.ui.kfRescheduleCanReview(pending({ assigneeId: "auth-account", assignee_id: "svc-staff", canReviewReschedule: true })), true, "server ownership mapping grants the actual workbench owner");
  assert.equal(f.ui.kfRescheduleCanReview(pending({ canReviewReschedule: false })), false, "server permission revokes a stale local ownership match");
  assert.equal(f.calls.length, 0);
  const finance = fixture("finance"); await finance.ui.kfOpenReschedules(); await finance.ui.kfReviewReschedule(pending(), false);
  assert.equal(finance.calls.length, 0);
});

test("a server conflict refreshes the queue and preserves the error instead of claiming success", async () => {
  const f = fixture(), row = pending(); f.control.rows = [row];
  f.control.save = async () => { throw new Error("订单已开始拍摄，不能同意改期"); };
  await f.ui.kfOpenReschedules(); await f.ui.kfReviewReschedule(row, true);
  assert.equal(f.ui.kf.rescheduleError, "订单已开始拍摄，不能同意改期");
  assert.equal(f.ui.kf.rescheduleRows.length, 1);
  assert.equal(row.appointmentAt, "2026-12-01");
  assert.equal(f.messages.some(message => message.kind === "success"), false);
  assert.equal(f.ui.kf.rescheduleBusy, false);
});

test("leaving the workbench discards a pending list response and cancels a confirmed review before write", async () => {
  const f = fixture(); let finish;
  f.control.list = () => new Promise(resolve => { finish = resolve; });
  const read = f.ui.kfOpenReschedules(); f.unmount(); finish([pending()]); await read;
  assert.equal(f.ui.kf.rescheduleRows.length, 0);
  const g = fixture(); let confirm;
  g.control.confirm = () => new Promise(resolve => { confirm = resolve; });
  const review = g.ui.kfReviewReschedule(pending(), true); g.unmount(); confirm(); await review;
  assert.equal(g.calls.some(call => call.kind === "action"), false);
});
