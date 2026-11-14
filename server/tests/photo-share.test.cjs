"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../lib/photoShare.cjs");
const B = require("../lib/svcBenefit.cjs");
function fixture() {
  let state = { rules: [{ id: "1", ver: 1, beneficiary_type: "photo", party_id: null, rule_mode: "global", ...P.DEFAULT_RATES, eff_at: "2026-01-01 00:00:00", reason: "初始化", operator: "qa" }],
    profiles: ["PH20260001", "PH20260002", "PH20260003"].map((id, i) => ({ id, name: ["阿坤", "老赵", "小满"][i], phone: "1390000000" + i, agree_no: "QA-" + i, rate_mode: "global", status: "active", dispute_days: 5, wait_days: 3, cycle: "monthly", pending_count: 0, pending_orders: [] })),
    ledgers: [], settlements: [], logs: [], adjustments: [], assignments: [], notifications: [], orders: [], phones: [] };
  let clock = "2026-11-10 12:00:00", fail = false, tail = Promise.resolve();
  const store = { withState: async (work, config = {}) => {
    const before = tail; let release; tail = new Promise(resolve => { release = resolve; }); await before;
    try { const next = structuredClone(state), result = await work(next); if (fail && !config.readOnly) throw new Error("injected commit failure"); if (!config.readOnly) state = next; return result; } finally { release(); }
  } };
  const service = P.createPhotoShareService({ store, clock: () => clock, provisionAccount: async (_, profile, input) => ({ account: input.account, account_id: "TEST_ONLY_" + profile.id, account_created: true }) });
  return { service, state: () => state, setTime: value => { clock = value; }, commitFailure: value => { fail = value; } };
}
function order(no = "QA-1", photo = "PH20260001", overrides = {}) { return { no, photo_id: photo, category: "combo", net_amount_fen: 299900, paid_at: "2026-11-02 10:00:00", done_at: "2026-11-09 10:00:00", service_status: "done", customer_openid: "oQA_same_customer_12345678901", ...overrides }; }
const admin = { role: "super", account: "qa-admin" };
const self = { role: "photo", subjectId: "PH20260001" };
async function add(f, o) { return f.service.onOrderChanged(o); }

test("approved legacy finance reset prevents replay from recreating cleared commissions", async () => {
  const f = fixture();
  f.state().logs.push({ id: "1", photo_id: "*", action: "finance_reset", detail: JSON.stringify({ scope: require("../lib/photoLegacyCleanup.cjs").SCOPE, v: 1, cutoff_at: "2026-11-10 12:00:00", snapshot_sha256: "a".repeat(64), reset_id: "TEST_ONLY" }), created_at: "2026-11-10 12:00:00" });
  const result = await add(f, order()); assert.deepEqual(result, { skipped: true, reason: "HISTORICAL_FINANCE_CLEARED" }); assert.equal(f.state().ledgers.length, 0);
  const fresh = await add(f, order("NEW-POST-RESET", "PH20260001", { paid_at: "2026-11-10 12:00:01", done_at: "2026-11-10 13:00:00" })); assert.equal(fresh.ledger.status, "settleable");
});
async function draft(f, ids, period = "2026-11") { return (await f.service.batchSettle({ ids, period }, admin)).rows[0]; }
test("photo golden eight uniform snapshots total 1734.52; integer floor and independent personal 22%", async () => {
  const f = fixture(), prices = [69900, 129900, 69900, 159900, 39900, 89900, 299900, 19900];
  for (let i = 0; i < prices.length; i++) await add(f, order("gold-" + i, "PH20260001", { net_amount_fen: prices[i], category: i === 7 ? "peripheral" : "combo" }));
  assert.equal(B.sumFen(f.state().ledgers, "commission_fen"), 173452);
  assert.equal(B.commissionFen(299900, 2200), 65978); assert.equal(B.commissionFen(69900, 2000), 13980); assert.equal(B.commissionFen(19900, 800), 1592); assert.equal(B.commissionFen(101, 2200), 22);
});
test("shared resolver uses personal category version at paid timestamp; no observation period", async () => {
  const f = fixture(); f.state().rules.push({ ...f.state().rules[0], id: "2", ver: 2, party_id: "PH20260001", rule_mode: "custom", rate_combo_bp: 2200 });
  await add(f, order()); assert.equal(f.state().ledgers[0].commission_fen, 65978); assert.equal(f.state().ledgers[0].status, "settleable"); assert.equal(f.state().ledgers[0].observe_days, 0);
});
test("personal override list exposes applicable reason/operator/effective date and pending version", async () => {
  const f = fixture(); const profile = f.state().profiles[0]; profile.rate_mode = "custom";
  f.state().rules.push({ ...f.state().rules[0], id: "2", ver: 2, party_id: profile.id, rule_mode: "custom", reason: "按人签约", operator: "qa-contract", eff_at: "2026-11-01 00:00:00" });
  await f.service.savePartyRate(profile.id, { ...P.DEFAULT_RATES, rate_combo_bp: 2200, ver: 2, reason: "次日调价" }, admin);
  const row = (await f.service.getRules()).overrides[0]; assert.equal(row.reason, "按人签约"); assert.equal(row.operator, "qa-contract"); assert.equal(row.eff_at, "2026-11-01 00:00:00"); assert.equal(row.pending.reason, "次日调价");
});
test("new rule is next China midnight, global unique version, stale writes rejected and historical row unchanged", async () => {
  const f = fixture(); await add(f, order()); const before = structuredClone(f.state().ledgers);
  f.state().rules.push({ ...f.state().rules[0], id: "9", ver: 9, beneficiary_type: "service" });
  const row = await f.service.saveRule({ ...P.DEFAULT_RATES, rate_combo_bp: 2200, ver: 1, reason: "协议调整" }, admin);
  assert.equal(row.ver, 10); assert.equal(row.eff_at, "2026-11-11 00:00:00"); assert.deepEqual(f.state().ledgers, before);
  await assert.rejects(f.service.saveRule({ ...P.DEFAULT_RATES, ver: 1, reason: "并发旧版" }, admin), { code: 4303 });
  assert.equal(B.rateBpOf(f.state().rules, "PH20260001", "combo", "2026-11-10 23:59:59", "photo").bp, 2000);
  assert.equal(B.rateBpOf(f.state().rules, "PH20260001", "combo", "2026-11-11 00:00:00", "photo").bp, 2200);
});
test("negative, missing categories, reason and oversized fractional rates are rejected; zero legal", async () => {
  const f = fixture(); await assert.rejects(f.service.saveRule({ ...P.DEFAULT_RATES, rate_photo_bp: -10, ver: 1, reason: "bad" }, admin), { code: 4304 });
  await assert.rejects(f.service.saveRule({ rate_photo_bp: 2000, ver: 1, reason: "bad" }, admin), { code: 4308 });
  await assert.rejects(f.service.saveRule({ ...P.DEFAULT_RATES, ver: 1, reason: " " }, admin), { code: 4305 });
  assert.throws(() => P.ratesOf({ ...P.DEFAULT_RATES, rate_photo_bp: 2001 }), { code: 4304 });
  f.state().rules[0].rate_combo_bp = 0; await add(f, order()); const result = await f.service.listLedger(); assert.equal(result.rows[0].commission_fen, 0); assert.equal(result.rows[0].zero_text, "比例已设为 0"); assert.equal(result.rows[0].status, "settleable");
});
test("peripheral 8% to10% preview counts only changed estimates and excludes personal/completed snapshots", async () => {
  const f = fixture(); await add(f, order("photo-est", "PH20260001", { category: "photo", service_status: "confirmed", done_at: null }));
  await add(f, order("peri-est", "PH20260001", { category: "peripheral", net_amount_fen: 19900, service_status: "confirmed", done_at: null }));
  await add(f, order("peri-done", "PH20260001", { category: "peripheral", net_amount_fen: 19900 }));
  const result = await f.service.previewRule({ ...P.DEFAULT_RATES, rate_peripheral_bp: 1000 }); assert.equal(result.affected_count, 1); assert.equal(result.delta_fen, 398); assert.equal(result.categories.find(c => c.category === "photo").count, 0);
});
test("assignment idempotency, two transfers retain A/B zero and C full; return before settlement restores A", async () => {
  const f = fixture(), a = order(); await add(f, a); await add(f, a); assert.equal(f.state().ledgers.length, 1);
  const c = { ...a, photo_id: "PH20260002" }; await f.service.onOrderChanged(c, a);
  const d = { ...a, photo_id: "PH20260003" }; await f.service.onOrderChanged(d, c);
  assert.deepEqual(f.state().ledgers.map(r => [r.party_id, r.commission_fen, r.status]), [["PH20260001", 0, "void"], ["PH20260002", 0, "void"], ["PH20260003", 59980, "settleable"]]);
  await f.service.onOrderChanged(a, d); assert.equal(f.state().ledgers.length, 3); assert.equal(f.state().ledgers[0].commission_fen, 59980); assert.equal(f.state().ledgers[2].commission_fen, 0);
});
test("latest transfer wins unchanged stale order, explicit unassignment zeros current owner", async () => {
  const f = fixture(), a = order(); f.state().assignments.push({ id: "1", order_no: a.no, to_photo: "PH20260002", created_at: "2026-11-09 12:00:00" });
  await add(f, a); assert.equal(f.state().ledgers[0].party_id, "PH20260002");
  await f.service.onOrderChanged({ ...a, photo_id: "" }, { ...a, photo_id: "PH20260002" }); assert.equal(f.state().ledgers[0].commission_fen, 0);
});
test("return to photographer with published snapshot requires explicit manual accounting review", async () => {
  const f = fixture(), a = order(), l = (await add(f, a)).ledger, s = await draft(f, [l.id]);
  await f.service.settlementAction(s.settle_id, "push", {}, admin); const next = { ...a, photo_id: "PH20260002" };
  await f.service.onOrderChanged(next, a); const before = structuredClone(f.state());
  await assert.rejects(f.service.onOrderChanged(a, next), { code: 4311 }); assert.deepEqual(f.state(), before);
});
test("missing assignee makes no ledger; paused accepts existing completion but blocks new assignment", async () => {
  const f = fixture(); await add(f, order("none", "")); assert.equal(f.state().ledgers.length, 0);
  const est = order("est", "PH20260001", { service_status: "confirmed", done_at: null }); await add(f, est);
  await f.service.setPartyStatus("PH20260001", { status: "paused", reason: "休假" }, admin);
  await f.service.onOrderChanged(order("est"), est); assert.equal(f.state().ledgers[0].status, "settleable");
  await assert.rejects(add(f, order("new", "PH20260001", { service_status: "confirmed", done_at: null })), { code: 4310 });
});
test("unsettled zero and draft zero preserve rows and recompute header, all four reasons", async () => {
  for (const reason of Object.keys(P.ZERO_REASONS)) {
    const f = fixture(); const one = (await add(f, order())).ledger, two = (await add(f, order("QA-2"))).ledger;
    await f.service.zeroLedger(one.id, reason, admin); assert.equal(f.state().ledgers[0].commission_fen, 0); assert.equal(f.state().ledgers[0].zero_reason, reason);
    const s = await draft(f, [two.id]); await f.service.zeroLedger(two.id, reason, admin);
    assert.equal(f.state().ledgers.length, 2); assert.equal(f.state().ledgers[1].settle_id, null); assert.equal(f.state().settlements[0].item_count, 0); assert.equal(f.state().settlements[0].payable_fen, 0); assert.equal(s.status, "draft");
  }
});
test("pushed and accepted zero generate one adjustment and preserve all original snapshots", async () => {
  for (const accept of [false, true]) {
    const f = fixture(), l = (await add(f, order())).ledger, s = await draft(f, [l.id]); await f.service.settlementAction(s.settle_id, "push", {}, admin);
    if (accept) await f.service.settlementAction(s.settle_id, "accept", { reason: "已线下认可" }, admin);
    const before = structuredClone({ ledgers: f.state().ledgers, settlements: f.state().settlements });
    await f.service.zeroLedger(l.id, "transfer", admin); await f.service.zeroLedger(l.id, "transfer", admin);
    assert.deepEqual({ ledgers: f.state().ledgers, settlements: f.state().settlements }, before); assert.equal(f.state().adjustments.length, 1); assert.equal(f.state().adjustments[0].action, "void"); assert.equal(f.state().adjustments[0].amount_fen, -59980);
  }
});
test("complaint rejudgment restores the original snapshot without changing completed order facts", async () => {
  const f = fixture(), original = order(); const row = (await add(f, original)).ledger;
  const complaint = { ...original, zero_reason: "complaint_photo" };
  await f.service.onOrderChanged(complaint, original);
  assert.equal(f.state().ledgers[0].status, "void");
  // A later edit to amount/rules cannot rewrite the commission being restored.
  f.state().rules[0].rate_combo_bp = 1000;
  await f.service.onOrderChanged({ ...original, net_amount_fen: 999999 }, complaint);
  const restored = f.state().ledgers[0];
  assert.equal(restored.commission_fen, row.commission_fen); assert.equal(restored.rate_bp, 2000);
  assert.equal(restored.net_amount_fen, 299900); assert.equal(restored.status, "settleable"); assert.equal(restored.zero_reason, null);
});
test("unexecuted published complaint deductions cancel once and never create a supplement", async () => {
  const f = fixture(), original = order(), l = (await add(f, original)).ledger, statement = await draft(f, [l.id]);
  await f.service.settlementAction(statement.settle_id, "push", {}, admin);
  const published = structuredClone({ rows: f.state().ledgers, statement: f.state().settlements[0] });
  const complaint = { ...original, zero_reason: "complaint_photo" };
  await f.service.onOrderChanged(complaint, original); await f.service.onOrderChanged(original, complaint); await f.service.onOrderChanged(original, complaint);
  assert.equal(f.state().adjustments.filter(a => a.action === "cancel_offset").length, 1);
  assert.equal(f.state().adjustments.filter(a => a.action === "makeup").length, 0);
  assert.deepEqual({ rows: f.state().ledgers, statement: f.state().settlements[0] }, published);
  assert.equal(P.remainingPlan(f.state(), f.state().adjustments[0]), 0);
  assert.equal((await f.service.listLedger()).rows[0].adjustment_pending, false);
});
test("a draft reservation is not an executed deduction and cancellation recalculates that draft", async () => {
  const f = fixture(), original = order(), l = (await add(f, original)).ledger, s = await draft(f, [l.id]);
  await f.service.settlementAction(s.settle_id, "push", {}, admin);
  const complaint = { ...original, zero_reason: "complaint_photo" };
  await f.service.onOrderChanged(complaint, original);
  const next = (await add(f, order("DRAFT-NEXT", "PH20260001", { net_amount_fen: 10000, paid_at: "2026-12-01 10:00:00", done_at: "2026-12-01 11:00:00" }))).ledger;
  const dec = await draft(f, [next.id], "2026-12"); assert.equal(dec.offset_fen, 2000);
  await f.service.onOrderChanged(original, complaint);
  assert.equal(f.state().adjustments.filter(a => a.action === "makeup").length, 0);
  const recalculated = f.state().settlements.find(row => row.settle_id === dec.settle_id);
  assert.equal(recalculated.offset_fen, 0); assert.equal(recalculated.payable_fen, 2000);
});
test("executed complaint recovery creates exactly the deducted supplement and can pay it without new orders", async () => {
  const f = fixture(), original = order(), l = (await add(f, original)).ledger, originalStatement = await draft(f, [l.id]);
  await f.service.settlementAction(originalStatement.settle_id, "push", {}, admin);
  const complaint = { ...original, zero_reason: "complaint_photo" };
  await f.service.onOrderChanged(complaint, original);
  const next = (await add(f, order("NEXT", "PH20260001", { net_amount_fen: 10000, paid_at: "2026-12-01 10:00:00", done_at: "2026-12-01 11:00:00" }))).ledger;
  const dec = await draft(f, [next.id], "2026-12"); assert.equal(dec.offset_fen, 2000);
  await f.service.settlementAction(dec.settle_id, "push", {}, admin);
  const published = structuredClone(f.state().settlements);
  f.setTime("2026-12-10 12:00:00");
  await f.service.onOrderChanged(original, complaint); await f.service.onOrderChanged(original, complaint);
  assert.deepEqual(f.state().settlements, published);
  const credit = f.state().adjustments.find(a => a.action === "makeup" && !a.settle_id);
  assert.equal(credit.amount_fen, 2000); assert.equal((await f.service.listLedger()).rows.find(r => r.id === l.id).makeup_pending_fen, 2000);
  assert.match(await f.service.exportCsv({}, admin), /改判补发待入账/);
  const jan = await f.service.settlementAction(null, "generate", { period: "2027-01" }, admin);
  assert.equal(jan.generated, 1); assert.equal(jan.rows[0].item_count, 0); assert.equal(jan.rows[0].offset_fen, -2000); assert.equal(jan.rows[0].payable_fen, 2000);
  assert.equal((await f.service.settlementAction(null, "generate", { period: "2027-01" }, admin)).generated, 0);
  assert.equal((await f.service.settlementAction(null, "generate", { period: "2027-02" }, admin)).generated, 0, "earlier draft reserves the supplement");
  await f.service.settlementAction(jan.rows[0].settle_id, "push", {}, admin);
  await f.service.settlementAction(jan.rows[0].settle_id, "accept", { reason: "补发金额已核对" }, admin);
  const paid = await f.service.settlementAction(jan.rows[0].settle_id, "pay", { voucher_url: "/api/media/makeup-proof" }, admin);
  assert.equal(paid.payable_fen, 2000); assert.equal(paid.status, "paid");
  assert.equal((await f.service.settlementAction(null, "generate", { period: "2027-02" }, admin)).generated, 0);
  assert.equal(f.state().adjustments.filter(a => a.action === "makeup" && a.settle_id).length, 1);
});
test("repeated responsibility changes create a fresh plan only after cancellation", async () => {
  const f = fixture(), original = order(), l = (await add(f, original)).ledger, s = await draft(f, [l.id]);
  await f.service.settlementAction(s.settle_id, "push", {}, admin);
  const complaint = { ...original, zero_reason: "complaint_photo" };
  await f.service.onOrderChanged(complaint, original); await f.service.onOrderChanged(original, complaint);
  await f.service.onOrderChanged(complaint, original); await f.service.onOrderChanged(complaint, complaint);
  const plans = f.state().adjustments.filter(a => Number(a.amount_fen) < 0);
  assert.equal(plans.length, 2); assert.notEqual(plans[0].plan_id, plans[1].plan_id);
  assert.equal(P.remainingPlan(f.state(), plans[0]), 0); assert.equal(P.remainingPlan(f.state(), plans[1]), l.commission_fen);
});
test("completed transfer rejects paused targets and keeps the existing ledger intact", async () => {
  const f = fixture(), original = order(); await add(f, original); f.state().profiles[1].status = "paused";
  const before = structuredClone(f.state());
  await assert.rejects(f.service.onOrderChanged({ ...original, photo_id: "PH20260002" }, original), { code: 4310 }); assert.deepEqual(f.state(), before);
});
test("paid zero creates capped three-period plan; small next payout never negative and original unchanged", async () => {
  const f = fixture(), l = (await add(f, order())).ledger, s = await draft(f, [l.id]);
  await f.service.settlementAction(s.settle_id, "push", {}, admin); await f.service.settlementAction(s.settle_id, "accept", { reason: "已核对" }, admin);
  await assert.rejects(f.service.settlementAction(s.settle_id, "pay", {}, admin), { code: 4307 });
  await f.service.settlementAction(s.settle_id, "pay", { voucher_url: "/api/media/qa-receipt" }, admin); const before = structuredClone(f.state().settlements[0]);
  await f.service.zeroLedger(l.id, "refund", admin); assert.equal(f.state().adjustments[0].action, "offset_plan");
  for (const [month, date] of [["2026-12", "2026-12-05"], ["2027-01", "2027-01-05"], ["2027-02", "2027-02-05"], ["2027-03", "2027-03-05"]]) {
    const ledger = (await add(f, order(date, "PH20260001", { net_amount_fen: 10000, paid_at: date + " 08:00:00", done_at: date + " 10:00:00" }))).ledger;
    const draftRow = await draft(f, [ledger.id], month); assert.equal(draftRow.offset_fen, month === "2027-03" ? 0 : 2000); assert.ok(draftRow.payable_fen >= 0);
    await f.service.settlementAction(draftRow.settle_id, "push", {}, admin);
  }
  assert.deepEqual(f.state().settlements[0], before); assert.equal(f.state().adjustments.filter(r => r.settle_id).length, 3);
  const tasks = await f.service.runTasks("2027-03-06 01:00:00"); assert.ok(tasks.alerts.some(r => r.code === "PHOTO_OFFSET_REQUIRES_REVIEW"));
});
test("offset reservations consume each plan once across drafts", () => {
  const f = fixture(), state = f.state();
  state.adjustments.push({ id: "1", staff_id: "PH20260001", plan_id: "photo:1", amount_fen: -100, period: "2026-11", settle_id: null }, { id: "2", staff_id: "PH20260001", plan_id: "photo:2", amount_fen: -200, period: "2026-11", settle_id: null });
  for (const [i, period, amount] of [[1, "2026-11", 100], [2, "2026-12", 300]]) { state.ledgers.push({ id: String(i), beneficiary_type: "photo", party_id: "PH20260001", settle_id: "s" + i, status: "settled", commission_fen: amount }); state.settlements.push({ settle_id: "s" + i, period, photo_id: "PH20260001", amount_fen: amount, status: "draft" }); }
  P.recalcSettlement(state, "s1"); P.recalcSettlement(state, "s2"); assert.equal(state.settlements[0].offset_fen, 100); assert.equal(state.settlements[1].offset_fen, 200);
});
test("complete month drives statements even when paid in prior month; published statement cannot be modified", async () => {
  const f = fixture(); const l = (await add(f, order("cross", "PH20260001", { paid_at: "2026-10-30 10:00:00", done_at: "2026-11-01 00:00:00" }))).ledger;
  assert.equal((await f.service.settlementAction(null, "generate", { period: "2026-10" }, admin)).generated, 0);
  const result = await f.service.settlementAction(null, "generate", { period: "2026-11" }, admin); assert.equal(result.generated, 1); assert.equal(result.rows[0].amount_fen, 59980);
  await f.service.settlementAction(result.rows[0].settle_id, "push", {}, admin); await assert.rejects(f.service.settlementAction(result.rows[0].settle_id, "push", {}, admin), { code: 4306 }); assert.equal(f.state().ledgers.find(r => r.id === l.id).status, "settled");
});
test("Friday plus five workdays, deadline inclusive, deemed acceptance durable note and idempotency", async () => {
  const f = fixture(); f.setTime("2026-11-13 10:00:00"); const l = (await add(f, order())).ledger, s = await draft(f, [l.id]);
  const pushed = await f.service.settlementAction(s.settle_id, "push", {}, admin); assert.equal(pushed.dispute_until, "2026-11-20"); assert.equal(f.state().notifications.length, 1);
  assert.equal((await f.service.runTasks("2026-11-20 23:59:59")).accepted, 0);
  assert.equal((await f.service.runTasks("2026-11-21 00:05:00")).accepted, 1);
  assert.equal((await f.service.runTasks("2026-11-21 00:06:00")).accepted, 0);
  assert.ok(f.state().logs.some(row => row.detail.includes("逾期未提异议")));
});
test("missing deadline repaired from original push day before accepting overdue", async () => {
  const f = fixture(); f.state().settlements.push({ settle_id: "repair", photo_id: "PH20260001", period: "2026-10", status: "pushed", pushed_at: "2026-11-06 15:00:00", dispute_until: null, item_count: 0, amount_fen: 0, offset_fen: 0, payable_fen: 0 });
  const result = await f.service.runTasks("2026-11-14 00:10:00"); assert.equal(result.repaired, 1); assert.equal(result.accepted, 1); assert.equal(f.state().settlements[0].dispute_until, "2026-11-13");
});
test("daily jobs respect 00:05 acceptance and 00:10 repair minimum slots", async () => {
  const f = fixture(); f.state().settlements.push({ settle_id: "early", photo_id: "PH20260001", period: "2026-10", status: "pushed", pushed_at: "2026-11-06 15:00:00", dispute_until: "2026-11-13", item_count: 0, amount_fen: 0, offset_fen: 0, payable_fen: 0 });
  assert.equal((await f.service.runTasks("2026-11-14 00:04:59")).accepted, 0); assert.equal((await f.service.runTasks("2026-11-14 00:05:00")).accepted, 1);
});
test("in-transit blocks termination with order detail and writes nothing; pause allowed and end after clearing", async () => {
  const f = fixture(), profile = f.state().profiles[0]; profile.pending_count = 1; profile.pending_orders = [{ order_no: "QA-PENDING", status: "confirmed" }]; const snapshot = structuredClone(f.state());
  await assert.rejects(f.service.setPartyStatus(profile.id, { status: "ended", reason: "到期" }, admin), error => error.code === 4302 && error.data.pending_orders[0].order_no === "QA-PENDING"); assert.deepEqual(f.state(), snapshot);
  await f.service.setPartyStatus(profile.id, { status: "paused", reason: "暂停" }, admin); f.state().profiles[0].pending_count = 0; f.state().profiles[0].pending_orders = [];
  await f.service.setPartyStatus(profile.id, { status: "ended", reason: "已改派" }, admin); assert.ok(f.state().logs.some(row => row.action === "end")); assert.equal((await f.service.listParties({ status: "ended" })).total, 1);
});
test("profile rule log transaction rolls back commit failure; phone checked across platform", async () => {
  const f = fixture(), input = { name: "新摄影", phone: "13811112222", agree_no: "QA-2026-04", account: "test-photo", password: "TestPhoto123!", ...P.DEFAULT_RATES };
  f.commitFailure(true); await assert.rejects(f.service.createParty(input, admin), /injected/); assert.equal(f.state().profiles.length, 3); assert.equal(f.state().rules.length, 1); assert.equal(f.state().logs.length, 0);
  f.commitFailure(false); const p = await f.service.createParty({ ...input, reason: "首签合作" }, admin); assert.equal(p.id, "PH20260004"); assert.equal(f.state().rules.length, 2); assert.equal(f.state().logs[0].action, "create"); assert.equal(f.state().rules[1].reason, "首签合作"); assert.ok(f.state().logs[0].detail.includes("首签合作"));
  await assert.rejects(f.service.createParty(input, admin), { code: 4301 }); f.state().phones.push("13811113333"); await assert.rejects(f.service.createParty({ ...input, phone: "13811113333" }, admin), { code: 4301 });
});
test("concurrent profile creation uses unique sequential identities", async () => {
  const f = fixture(); const rows = await Promise.all([0, 1].map(i => f.service.createParty({ name: "并发" + i, phone: "1382222333" + i, agree_no: "QA" + i, account: "photo-" + i, password: "TestPhoto123!" }, admin)));
  assert.deepEqual(rows.map(r => r.id), ["PH20260004", "PH20260005"]);
});
test("PH06 ignores attacker filter, exposes only own published statements, CSV nine columns and BOM", async () => {
  const f = fixture(); await add(f, order()); await add(f, order("other", "PH20260002"));
  const result = await f.service.mine({ photo_id: "PH20260002", period: "2026-11" }, self); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].party_id, self.subjectId);
  for (const role of ["admin", "administrator", "finance", "service", "service_supervisor", "auditor"]) await assert.rejects(f.service.mine({ photo: self.subjectId }, { role, subjectId: self.subjectId }), { code: 4309 });
  await assert.rejects(f.service.mine({}, { ...admin, kind: "public" }), { code: 4309 });
  const csv = await f.service.exportCsv({ photo_id: "PH20260002" }, self, { mine: true }); assert.equal(csv.charCodeAt(0), 0xFEFF); assert.equal(csv.split("\r\n")[0].split(",").length, 9); assert.ok(!csv.includes("other"));
  const adminCsv = await f.service.exportCsv({}, admin); assert.equal(adminCsv.split("\r\n")[0].split(",").length, 10);
});

test("super photographer view defaults to all data and can preview one photographer without losing picker options", async () => {
  const f = fixture();
  await add(f, order("own-current"));
  await add(f, order("other-current", "PH20260002", { category: "photo", net_amount_fen: 10000 }));
  await add(f, order("own-old", "PH20260001", { category: "photo", net_amount_fen: 5000, paid_at: "2026-10-01 10:00:00", done_at: "2026-10-02 10:00:00" }));
  f.state().ledgers[0].status = "settled";
  f.state().settlements.push({ settle_id: "draft-a", photo_id: "PH20260001", period: "2026-11", status: "draft", payable_fen: 59980 }, { settle_id: "published-b", photo_id: "PH20260002", period: "2026-11", status: "pushed", payable_fen: 2000 });
  const all = await f.service.mine({ period: "2026-11", page: 1, size: 1 }, admin);
  assert.equal(all.aggregate, true); assert.deepEqual(all.photo, {});
  assert.equal(all.total, 2); assert.equal(all.rows.length, 1); assert.equal(all.rows[0].photo_id, "PH20260002"); assert.equal(all.rows[0].photo_name, "老赵");
  assert.deepEqual(all.kpi, { month_fen: 61980, total_fen: 62980, month_orders: 2, rates: null, settled_rows: 1 });
  assert.equal(all.photographers.length, 3); assert.deepEqual(Object.keys(all.photographers[0]).sort(), ["id", "name", "status"]);
  assert.deepEqual(all.settlements.map(row => [row.settle_id, row.photo_name]), [["draft-a", "阿坤"], ["published-b", "老赵"]]);
  const selected = await f.service.mine({ photo: "PH20260001", period: "2026-11" }, admin);
  assert.equal(selected.aggregate, false); assert.equal(selected.photo.name, "阿坤"); assert.equal(selected.total, 1); assert.equal(selected.photographers.length, 3);
  assert.equal(selected.kpi.total_fen, 60980); assert.equal(selected.kpi.rates.combo_bp, 2000);
  assert.deepEqual(selected.settlements.map(row => row.settle_id), ["draft-a"]);
  const personal = await f.service.mine({ photo: "PH20260002", photo_id: "PH20260002", period: "2026-11" }, self);
  assert.equal(personal.photo.id, self.subjectId); assert.deepEqual(personal.photographers, []); assert.deepEqual(personal.settlements, []);
  assert.equal(personal.rows.every(row => row.photo_id === self.subjectId), true);
  await assert.rejects(f.service.mine({ photo: "missing" }, admin), { code: 4300 });
});

test("super photographer view export honors all or selected scope while self export ignores both spoofed owner aliases", async () => {
  const f = fixture(); await add(f, order("own-export")); await add(f, order("other-export", "PH20260002"));
  const all = await f.service.exportCsv({ period: "2026-11" }, admin, { mine: true });
  assert.equal(all.charCodeAt(0), 0xFEFF); assert.equal(all.split("\r\n")[0].split(",").length, 10);
  assert.ok(all.includes("own-export") && all.includes("other-export") && all.includes("阿坤") && all.includes("老赵"));
  const selected = await f.service.exportCsv({ photo: "PH20260002", period: "2026-11" }, admin, { mine: true });
  assert.ok(selected.includes("other-export")); assert.equal(selected.includes("own-export"), false);
  const personal = await f.service.exportCsv({ photo: "PH20260002", photo_id: "PH20260002" }, self, { mine: true });
  assert.ok(personal.includes("own-export")); assert.equal(personal.includes("other-export"), false); assert.equal(personal.split("\r\n")[0].split(",").length, 9);
  for (const role of ["admin", "finance", "service_supervisor"]) await assert.rejects(f.service.exportCsv({}, { role }, { mine: true }), { code: 4309 });
});
test("payment registration rejects corrupt statement and CSV neutralizes spreadsheet formula input", async () => {
  const f = fixture(), l = (await add(f, order("=HYPERLINK(bad)", "PH20260001"))).ledger, s = await draft(f, [l.id]);
  await f.service.settlementAction(s.settle_id, "push", {}, admin); await f.service.settlementAction(s.settle_id, "accept", { reason: "已核对" }, admin);
  f.state().settlements[0].amount_fen = 1;
  await assert.rejects(f.service.settlementAction(s.settle_id, "pay", { voucher_url: "https://example.test/receipt" }, admin), { code: 4312 });
  assert.ok((await f.service.exportCsv({}, admin)).includes("'" + "=HYPERLINK(bad)"));
});
module.exports = { fixture, order };
