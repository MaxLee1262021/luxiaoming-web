"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const C = require("../lib/svcCommission.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const admin = { kind: "admin", role: "super", authzUserId: "root" };
const service = { kind: "admin", role: "service", subjectId: "cs", authzUserId: "cs-account" };
const at = "2026-11-13 12:00:00";
function seed() {
  return { staff: [{ id: "cs", name: "客服", account_id: "cs-account", staff_status: "active", base_salary: 0 }],
    configs: [], orders: [{ order_no: "ORDER", assignee_id: "cs", service_status: "done", done_at: "2026-11-01 12:00:00" }],
    rules: [], ledger: [{ id: "1", biz_no: "ORDER", beneficiary_type: "service", party_id: "cs", category: "photo", net_amount_fen: 100000,
      rate_bp: 1000, commission_fen: 10000, paid_at: "2026-10-30 10:00:00", done_at: "2026-11-01 12:00:00", status: "settled", settle_id: "ORIGINAL", observe_days: 7, created_at: at }],
    settlements: [{ settle_id: "ORIGINAL", period: "2026-10", staff_id: "cs", amount_fen: 10000, item_count: 1, status: "paid" }],
    adjustments: [], complaints: [] };
}
function addDeduction(state, plan, amount, index = 1) {
  state.adjustments.push({ id: String(state.adjustments.length + 1), order_no: plan.order_no, staff_id: plan.staff_id, action: "offset_plan",
    amount_fen: -amount, plan_id: String(plan.id), settle_id: "DEDUCTED-" + index, carried: index, created_at: at });
}

test("an unexecuted offset reversal is a zero-money audit event and a later decision creates a new plan", () => {
  const state = seed(), original = structuredClone(state.settlements);
  C.applyComplaint(state, state.orders[0], "user", "service", at);
  const first = state.adjustments[0];
  C.applyComplaint(state, state.orders[0], "service", "user", at);
  assert.equal(state.adjustments.find(row => row.action === "cancel_offset").amount_fen, 0);
  assert.equal(state.adjustments.filter(row => row.action === "makeup").length, 0);
  C.applyComplaint(state, state.orders[0], "user", "service", at);
  const plans = state.adjustments.filter(row => row.action === "offset_plan");
  assert.equal(plans.length, 2); assert.notEqual(plans[1].plan_id, first.plan_id);
  assert.deepEqual(state.settlements, original); assert.equal(state.ledger[0].status, "settled");
});

test("a fully executed offset is closed once and rejudgment reimburses only the actual deduction", () => {
  const state = seed(); C.applyComplaint(state, state.orders[0], "user", "service", at);
  addDeduction(state, state.adjustments[0], 10000);
  C.applyComplaint(state, state.orders[0], "service", "user", at);
  assert.equal(state.adjustments.find(row => row.action === "cancel_offset").amount_fen, 0);
  const makeup = state.adjustments.find(row => row.action === "makeup");
  assert.equal(makeup.amount_fen, 10000); assert.equal(makeup.period, "2026-12");
  const after = structuredClone(state);
  C.applyComplaint(state, state.orders[0], "service", "user", at);
  assert.deepEqual(state, after, "replaying an already closed plan cannot reimburse again");
  C.applyComplaint(state, state.orders[0], "user", "service", at);
  assert.equal(state.adjustments.filter(row => row.action === "offset_plan" && !row.settle_id).length, 2);
});

test("partial recovery and offline handoff cannot be mistaken for money already deducted", () => {
  const state = seed(); C.applyComplaint(state, state.orders[0], "user", "service", at);
  const plan = state.adjustments[0]; addDeduction(state, plan, 3000);
  state.adjustments.push({ id: "3", order_no: "ORDER", staff_id: "cs", action: "offset_plan", amount_fen: -7000,
    plan_id: plan.plan_id, settle_id: null, note: "已转线下", created_at: at });
  C.applyComplaint(state, state.orders[0], "service", "user", at);
  assert.equal(state.adjustments.find(row => row.action === "makeup").amount_fen, 3000);
  assert.equal(state.adjustments.find(row => row.action === "cancel_offset").amount_fen, 0);
  assert.equal(state.settlements[0].amount_fen, 10000);
});

test("reversal inside observation restores the original maturity without a financial adjustment", () => {
  const state = seed(); state.settlements = []; Object.assign(state.ledger[0], { status: "void", zero_reason: "complaint_service", settle_id: null, done_at: "2026-11-12 23:50:00" });
  state.orders[0].done_at = state.ledger[0].done_at;
  C.applyComplaint(state, state.orders[0], "service", "user", at);
  assert.equal(state.ledger[0].status, "obs"); assert.equal(state.ledger[0].done_at, "2026-11-12 23:50:00"); assert.deepEqual(state.adjustments, []);
  C.refreshLedger(state, "2026-11-19 23:49:59"); assert.equal(state.ledger[0].status, "obs");
  C.refreshLedger(state, "2026-11-19 23:50:00"); assert.equal(state.ledger[0].status, "settleable");
});

test("my commission exposes capped current offsets, observation and estimate totals without writes or photo leakage", async () => {
  const initial = seed(); initial.settlements = []; initial.orders.push({ order_no: "RECENT", service_status: "done" });
  initial.ledger[0] = { ...initial.ledger[0], status: "settleable", settle_id: null, paid_at: "2026-11-01 10:00:00" };
  initial.ledger.push({ ...initial.ledger[0], id: "2", biz_no: "RECENT", status: "obs", done_at: "2026-11-12 12:00:00", commission_fen: 5000 });
  initial.adjustments.push({ id: "1", staff_id: "cs", order_no: "OLD", action: "offset_plan", amount_fen: -10000, plan_id: "1", period: "2026-11", created_at: at },
    { id: "2", staff_id: "cs", order_no: "PHOTO", action: "makeup", amount_fen: 999999, plan_id: "photo:photo-ledger:2", period: "2026-11", created_at: at },
    { id: "3", staff_id: "other", order_no: "PRIVATE", action: "offset_plan", amount_fen: -20000, plan_id: "3", period: "2026-11", created_at: at });
  const store = createSvcMemoryStore(initial), app = C.createSvcCommission({ store, clock: () => at }), before = store.snapshot();
  const mine = await app.execute("GET", "/me", { staff: "other" }, service);
  assert.equal(mine.kpi.month_estimate_fen, 15000); assert.equal(mine.kpi.pending_count, 1); assert.equal(mine.kpi.pending_fen, 5000);
  assert.equal(mine.kpi.offset_fen, -3000); assert.equal(mine.kpi.makeup_fen, 0); assert.equal(mine.kpi.pending_offset_fen, 10000);
  assert.equal(mine.adjustments.length, 1); assert.equal(mine.adjustments[0].order_no, "OLD"); assert.equal(mine.adjustments[0].remaining_fen, 10000);
  assert.equal(mine.adjustment_period, "2026-11"); assert.deepEqual(store.snapshot(), before);
  const all = await app.execute("GET", "/me", {}, admin); assert.equal(all.kpi.pending_offset_fen, 30000);
  assert.equal(all.adjustments.length, 2); assert.deepEqual(store.snapshot(), before);
});

test("service settlement generation and confirmation never allocate photographer makeups for a matching party id", async () => {
  const initial = seed(); initial.settlements = []; initial.ledger = [];
  initial.adjustments.push({ id: "1", staff_id: "cs", order_no: "PHOTO", action: "makeup", amount_fen: 99999, plan_id: "photo:ledger:1", period: "2026-11", created_at: at });
  const store = createSvcMemoryStore(initial), app = C.createSvcCommission({ store, clock: () => at });
  assert.deepEqual((await app.execute("POST", "/settlement/generate", { period: "2026-11" }, admin)).list, []);
  assert.equal(store.snapshot().settlements.length, 0);
  await store.transaction(state => {
    const settlement = { settle_id: "CS", staff_id: "cs", period: "2026-11", status: "draft", amount_fen: 0 };
    C.allocateAdjustments(state, settlement, at); assert.equal(settlement.makeup_fen, 0); assert.equal(settlement.offset_fen, 0);
  });
  assert.equal(store.snapshot().adjustments.length, 1);
});
