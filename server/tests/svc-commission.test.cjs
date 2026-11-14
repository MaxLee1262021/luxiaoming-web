"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../lib/svcBenefit.cjs");
const C = require("../lib/svcCommission.cjs");
const { DEFAULT_CONFIG } = require("../lib/svcCore.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const admin = { kind: "admin", role: "super", id: "root" }, finance = { kind: "admin", role: "finance", id: "finance" };
const service = { kind: "admin", role: "service", authzUserId: "a-account", subjectId: "a" };
const rates = (photo = 300) => ({ rate_photo_bp: photo, rate_video_bp: 300, rate_combo_bp: 300, rate_peripheral_bp: 240 });
function seed() {
  return { configs: [{ ...DEFAULT_CONFIG, id: "1", ver: 1, eff_at: "2026-10-01 00:00:00", observe_days: 7, offset_cap_bp: 3000, offset_periods: 3 }],
    staff: [{ id: "a", name: "客服甲", phone: "13800138000", joined_at: "2026-10-01", base_salary: 3500, rate_mode: "custom", staff_status: "active", account_id: "a-account" },
      { id: "b", name: "客服乙", base_salary: 0, rate_mode: "global", staff_status: "ended", account_id: "b-account" }],
    rules: [{ id: "1", ver: 1, beneficiary_type: "service", party_id: null, rule_mode: "global", ...rates(), eff_at: "2026-10-01 00:00:00" },
      { id: "2", ver: 2, beneficiary_type: "service", party_id: "a", rule_mode: "custom", ...rates(400), eff_at: "2026-10-01 00:00:00" }],
    orders: [{ id: "o1", order_no: "ORDER-1", assignee_id: "a", category: "photo", net_amount_fen: 69900, paid_at: "2026-11-01 12:00:00", done_at: "2026-11-02 23:50:00", service_status: "done", customer_openid: "=formula-guard", product_name: "长沙照片" },
      { id: "o2", order_no: "ORDER-2", assignee_id: "b", category: "video", net_amount_fen: 129900, paid_at: "2026-11-01 12:00:00", done_at: "2026-11-02 23:50:00", service_status: "done", customer_openid: "other-customer" }] };
}
function harness(initial = seed(), at = "2026-11-10 12:00:00") {
  const store = createSvcMemoryStore(initial); let now = at;
  return { store, service: C.createSvcCommission({ store, clock: () => now }), setTime: value => { now = value; },
    populate: async () => store.transaction(state => { for (const order of state.orders) C.ensureLedger(state, order, now); }) };
}

test('super customer-service client aggregates all people and can preview a selected person without a bound profile', async () => {
  const h = harness(); await h.populate();
  await h.store.transaction(state => {
    state.settlements.push({settle_id:'SET-A',staff_id:'a',period:'2026-11',status:'confirmed'}, {settle_id:'SET-B',staff_id:'b',period:'2026-11',status:'draft'});
    state.appeals.push({id:'AP-A',staff_id:'a',reason:'甲申诉'}, {id:'AP-B',staff_id:'b',reason:'乙申诉'});
  });
  const snapshot = h.store.snapshot();
  const all = await h.service.execute('GET','/me',{period:'2026-11',size:1},admin);
  assert.equal(all.preview,true); assert.equal(all.staff,null); assert.equal(all.current_rates,null);
  assert.equal(all.total,2); assert.equal(all.list.length,1); assert.equal(all.kpi.staff_count,2);
  assert.equal(all.kpi.month_fen,6693); assert.equal(all.kpi.total_fen,6693);
  assert.equal(all.kpi.base_salary_fen,350000); assert.equal(all.kpi.month_remuneration_fen,356693);
  assert.deepEqual(all.staff_options.map(row=>row.id),['a','b']);
  assert.deepEqual(all.settlements.map(row=>row.staff_name),['客服甲','客服乙']); assert.equal(all.appeals.length,2);
  const selected = await h.service.execute('GET','/me',{staff:'b',period:'2026-11'},admin);
  assert.equal(selected.staff.id,'b'); assert.equal(selected.kpi.month_fen,3897); assert.equal(selected.kpi.staff_count,1);
  assert.equal(selected.current_rates.video_bp,300); assert.deepEqual(selected.list.map(row=>row.party_id),['b']);
  assert.deepEqual(selected.settlements.map(row=>row.staff_id),['b']); assert.deepEqual(selected.appeals.map(row=>row.staff_id),['b']);
  const cleared = await h.service.execute('GET','/me',{staff:'',period:'2026-11'},admin); assert.equal(cleared.total,2);
  await assert.rejects(h.service.execute('GET','/me',{staff:'unknown'},admin),{code:5010});
  assert.deepEqual(h.store.snapshot(),snapshot,'preview reads never mutate commission state');
});

test('ordinary customer-service identities cannot use preview filters to read another person or all personnel', async () => {
  const h = harness(); await h.populate();
  await h.store.transaction(state => {
    state.settlements.push({settle_id:'SET-A',staff_id:'a',status:'confirmed'}, {settle_id:'SET-B',staff_id:'b',status:'confirmed'});
    state.appeals.push({id:'AP-A',staff_id:'a'}, {id:'AP-B',staff_id:'b'});
  });
  for (const session of [service,{...service,role:'service_supervisor'}]) {
    const result = await h.service.execute('GET','/me',{staff:'b',scope:'all'},session);
    assert.equal(result.staff.id,'a'); assert.equal(result.total,1); assert.equal(result.kpi.month_fen,2796);
    assert.deepEqual(result.list.map(row=>row.party_id),['a']); assert.deepEqual(result.settlements.map(row=>row.staff_id),['a']);
    assert.deepEqual(result.appeals.map(row=>row.staff_id),['a']); assert.equal(result.staff_options,undefined); assert.equal(result.preview,undefined);
  }
  await assert.rejects(h.service.execute('GET','/me',{},finance),{code:4030});
});

test("one resolver honors effective personal/global versions and append-only return-to-global markers", () => {
  const state = seed();
  assert.deepEqual(B.rateBpOf(state.rules, "a", "photo", "2026-11-01 12:00:00"), { bp: 400, mode: "custom", ver: 2 });
  state.rules.push({ id: "3", ver: 3, beneficiary_type: "service", party_id: "a", rule_mode: "global", ...rates(), eff_at: "2026-11-03 00:00:00" });
  assert.equal(B.rateBpOf(state.rules, "a", "photo", "2026-11-02 23:59:59").bp, 400);
  assert.deepEqual(B.rateBpOf(state.rules, "a", "photo", "2026-11-03 00:00:00"), { bp: 300, mode: "global", ver: 1 });
  state.rules.push({ id: "4", ver: 4, beneficiary_type: "service", party_id: null, ...rates(500), eff_at: "2026-11-04 00:00:00" });
  assert.equal(B.rateBpOf(state.rules, "a", "photo", "2026-11-04 00:00:00").bp, 500);
  assert.throws(() => B.rateBpOf([], "a", "photo", "2026-11-04 00:00:00"), { code: 5011 });
});
test("money uses integer BigInt floor, valid zero and exact large safe integers", () => {
  assert.equal(B.commissionFen(69900, 400), 2796);
  assert.equal(B.commissionFen(129900, 300), 3897);
  assert.equal(B.commissionFen(39900, 240), 957, "the supplied demo rounds this to 958; the requirement explicitly floors");
  assert.equal(B.commissionFen(9007199254740991, 9990), 8998192055486250);
  assert.equal(B.commissionFen(-1, 400), 0);
  assert.equal(B.commissionFen(123, 0), 0);
  assert.throws(() => B.commissionFen(1.2, 300), { code: 4014 });
  assert.throws(() => B.ratesOf({ photo_bp: -1, video_bp: 300, combo_bp: 300, peripheral_bp: 300 }), { code: 5001 });
  assert.throws(() => B.ratesOf({ photo_bp: 300 }), { code: 5008 });
});
test("benefit boundary validation covers missing and invalid input without unsafe money conversion", () => {
  assert.equal(B.timestamp(new Date("2026-11-10T00:00:00Z")), Date.parse("2026-11-10T00:00:00Z"));
  assert.equal(B.timestamp(1), 1); assert.equal(B.localTime("2026-11-10"), "2026-11-10 00:00:00");
  assert.throws(() => B.timestamp("bad-date"), { code: 4014 });
  assert.throws(() => B.integer("9007199254740992"), { code: 4014 });
  assert.throws(() => B.commissionFen(100, 10001), { code: 5001 });
  assert.throws(() => B.ratesOf(null), { code: 5008 });
  assert.deepEqual(B.ratesOf({ rate_photo_bp: 0, rate_video_bp: 10000, rate_combo_bp: "300", rate_peripheral_bp: 240 }), { rate_photo_bp: 0, rate_video_bp: 10000, rate_combo_bp: 300, rate_peripheral_bp: 240 });
  assert.throws(() => B.rateBpOf(seed().rules, "a", "bad", "2026-11-01"), { code: 4014 });
  assert.equal(B.statusOf({ status: "settled", zero_reason: "refund" }, {}, 1), "settled");
  assert.equal(B.statusOf({ zero_reason: "refund" }, {}, 1), "void");
  assert.equal(B.statusOf({}, { service_status: "new" }, 1), "est");
  assert.equal(B.statusOf({}, { service_status: "done" }, 1), "est");
  assert.equal(B.statusOf({ done_at: "2026-11-01" }, { service_status: "done", resp: "unknown" }, "2026-11-20"), "obs");
  assert.equal(B.money(-101), "-1.01"); assert.equal(B.sumFen([{}], "absent"), 0);
  assert.throws(() => B.sumFen([{ amount: Number.MAX_SAFE_INTEGER }, { amount: 1 }], "amount"), { code: 4014 });
  assert.equal(B.safeCsv("-1+2"), '"\'-1+2"'); assert.equal(B.safeCsv(-10), '"-10"'); assert.equal(B.safeCsv(null), '""');
});
test("observation uses timestamp boundary and per-payment configuration snapshot across month", async () => {
  const initial = seed(); initial.configs.push({ id: "2", ver: 2, eff_at: "2026-11-02 00:00:00", observe_days: 0 });
  initial.orders[0].done_at = "2026-11-28 23:50:00";
  const h = harness(initial, "2026-12-05 23:49:59"); await h.populate();
  let ledger = h.store.snapshot().ledger[0]; assert.equal(ledger.observe_days, 7); assert.equal(ledger.status, "obs");
  assert.equal(B.duePeriod(ledger, ledger), "2026-12");
  h.setTime("2026-12-05 23:50:00"); await h.service.runTasks(); ledger = h.store.snapshot().ledger[0]; assert.equal(ledger.status, "settleable");
});
test("version CAS is atomic, next-midnight effective, configuration save is same source", async () => {
  const h = harness(); await h.populate();
  const input = { ver: 2, rates: { photo_bp: 500, video_bp: 300, combo_bp: 300, peripheral_bp: 300 }, reason: "调整" };
  const result = await Promise.allSettled([h.service.execute("POST", "/rule", input, admin), h.service.execute("POST", "/rule", input, admin)]);
  assert.equal(result.filter(row => row.status === "fulfilled").length, 1); assert.equal(result.find(row => row.status === "rejected").reason.code, 5003);
  const rule = h.store.snapshot().rules.at(-1); assert.equal(rule.eff_at, "2026-11-11 00:00:00");
  assert.equal(h.store.snapshot().ledger[0].commission_fen, 2796);
  await h.service.execute("POST", "/rule", { config: { ver: 1, protect_days: 3 } }, admin);
  assert.equal(h.store.snapshot().configs.at(-1).protect_days, 3);
  const visible = await h.service.execute("GET", "/rule", {}, admin); assert.equal(visible.latest_config_ver, 2); assert.equal(visible.pending_config.protect_days, 3);
});
test("batch settlement separates staff, serializes duplicate claims, locks confirmation and requires voucher", async () => {
  const h = harness(); await h.populate();
  const ids = h.store.snapshot().ledger.map(row => row.id), result = await Promise.allSettled([
    h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ids, period: "2026-11" }, finance),
    h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ids, period: "2026-11" }, finance),
  ]);
  assert.equal(result.filter(row => row.status === "fulfilled").length, 1);
  const rows = h.store.snapshot().settlements; assert.equal(rows.length, 2); assert.notEqual(rows[0].settle_id, rows[1].settle_id);
  const settlement = rows.find(row => row.staff_id === "a"); assert.equal(settlement.amount_fen, 2796); assert.equal(settlement.base_salary_fen, 350000); assert.equal(settlement.payable_fen, 2796);
  await h.service.execute("POST", `/settlement/${settlement.settle_id}/confirm`, {}, finance);
  await assert.rejects(h.service.execute("POST", `/settlement/${settlement.settle_id}/exclude`, { ledger_id: ids[0], reason: "迟到" }, finance), { code: 5005 });
  await assert.rejects(h.service.execute("POST", `/settlement/${settlement.settle_id}/pay`, {}, finance), { code: 5006 });
  await h.service.execute("POST", `/settlement/${settlement.settle_id}/pay`, { voucher_url: "/api/media/voucher" }, finance);
  assert.equal(h.store.snapshot().settlements.find(row => row.staff_id === "a").status, "paid");
});
test("bad batch rolls back all selected rows; confirmed amount mismatch blocks confirmation", async () => {
  const h = harness(); await h.populate();
  await h.store.transaction(state => { state.ledger[1].status = "obs"; });
  await assert.rejects(h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ["1", "missing"], period: "2026-11" }, finance), { code: 5004 });
  assert.equal(h.store.snapshot().settlements.length, 0); assert.equal(h.store.snapshot().ledger[0].settle_id, null);
  const batch = await h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ["1"], period: "2026-11" }, finance);
  await h.store.transaction(state => { state.settlements[0].amount_fen = 1; });
  await assert.rejects(h.service.execute("POST", `/settlement/${batch.list[0].settle_id}/confirm`, {}, finance), { code: 5012 });
});
test("staff creation failure leaves no profile, service identity cannot read or edit others", async () => {
  const h = harness(); await h.populate();
  await assert.rejects(h.service.execute("POST", "/staff", { name: "新客服", phone: "13900139000", joined_at: "2026-11-10", base_salary: 0, rate_mode: "custom", rates: { photo_bp: 400 } }, admin), { code: 5008 });
  assert.equal(h.store.snapshot().staff.length, 2);
  const mine = await h.service.execute("GET", "/me", { staff: "b" }, service); assert.equal(mine.total, 1); assert.equal(mine.list[0].party_id, "a");
  const ledger = await h.service.execute("GET", "/ledger", { staff: "b" }, service); assert.equal(ledger.total, 0);
  await assert.rejects(h.service.execute("POST", "/rule", {}, service), { code: 4030 });
  await assert.rejects(h.service.execute("GET", "/ledger", {}, { kind: "public", role: "super" }), { code: 4030 });
});
test("return-to-global appends marker without changing historical snapshots", async () => {
  const h = harness(); await h.populate();
  const result = await h.service.execute("POST", "/staff/a/rate", { mode: "global", reason: "恢复统一" }, admin);
  assert.equal(result.rule_mode, "global"); assert.equal(h.store.snapshot().ledger[0].rate_bp, 400);
  assert.equal(B.rateBpOf(h.store.snapshot().rules, "a", "photo", "2026-11-11 12:00:00").bp, 300);
});
test("CSV is BOM UTF-8 twelve columns, contains full OpenID, guards spreadsheet formula cells", async () => {
  const h = harness(); await h.populate();
  const output = await h.service.execute("GET", "/ledger/export", {}, admin);
  assert.equal(output.csv.codePointAt(0), 0xFEFF); assert.equal(output.csv.split("\r\n")[0].split(",").length, 12);
  assert.ok(output.csv.includes("'=formula-guard")); assert.ok(output.csv.includes("other-customer")); assert.ok(output.csv.includes("27.96"));
});
test("confirmed refund makes next-period adjustment, leaves ledger and payout untouched", async () => {
  const h = harness(); await h.populate(); const batch = await h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ["1"], period: "2026-11" }, finance);
  await h.service.execute("POST", `/settlement/${batch.list[0].settle_id}/confirm`, {}, finance);
  await h.store.transaction(state => { C.onRefund(state, state.orders[0], "2026-11-11 12:00:00"); C.onRefund(state, state.orders[0], "2026-11-11 12:00:00"); });
  const state = h.store.snapshot(); assert.equal(state.ledger[0].status, "settled"); assert.equal(state.settlements[0].amount_fen, 2796);
  assert.equal(state.adjustments.filter(row => row.action === "offset_plan").length, 1); assert.equal(state.adjustments[0].amount_fen, -2796);
});
test("offsets share total 30% cap, carry at most three periods, remaining balance goes offline", () => {
  const state = { ...seed(), adjustments: [{ id: "1", order_no: "ORDER-1", staff_id: "a", action: "offset_plan", amount_fen: -240000, carried: 0, plan_id: "1", period: "2026-11", settle_id: null, created_at: "2026-10-15 12:00:00" }], ledger: [], settlements: [] };
  for (const period of ["2026-11", "2026-12", "2027-01"]) {
    const s = { settle_id: "S" + period, staff_id: "a", period, status: "draft", amount_fen: 10000, makeup_fen: 0, offset_fen: 0 };
    state.settlements.push(s); state.ledger.push({ settle_id: s.settle_id, beneficiary_type: "service", status: "settled", commission_fen: 10000 });
    C.allocateAdjustments(state, s, period + "-10 12:00:00"); assert.equal(s.offset_fen, -3000); assert.equal(s.payable_fen, 7000);
  }
  assert.equal(state.adjustments.filter(row => row.note === "已转线下").length, 1);
  assert.equal(state.adjustments.at(-1).amount_fen, -231000);
  const fourth = { settle_id: "S2027-02", staff_id: "a", period: "2027-02", status: "draft", amount_fen: 10000, makeup_fen: 0, offset_fen: 0 };
  state.ledger.push({ settle_id: fourth.settle_id, beneficiary_type: "service", status: "settled", commission_fen: 10000 });
  C.allocateAdjustments(state, fourth, "2027-02-10 12:00:00"); assert.equal(fourth.offset_fen, 0, "offline residual must never become another automatic debt plan");
});
test("complaint and refund never double recover the same confirmed commission; refund survives rejudgment", async () => {
  const h = harness(); await h.populate(); const batch = await h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ["1"], period: "2026-11" }, finance);
  await h.service.execute("POST", `/settlement/${batch.list[0].settle_id}/confirm`, {}, finance);
  await h.store.transaction(state => {
    C.applyComplaint(state, state.orders[0], "unknown", "service", "2026-11-11 12:00:00");
    state.orders[0].service_status = "refunded"; C.onRefund(state, state.orders[0], "2026-11-11 12:00:00");
    C.applyComplaint(state, state.orders[0], "service", "user", "2026-11-12 12:00:00");
  });
  const state = h.store.snapshot(); assert.equal(state.adjustments.filter(row => row.action === "offset_plan").length, 1); assert.equal(state.adjustments.filter(row => row.action === "cancel_offset").length, 0);
});
test("appeal ownership, five business days, L1/L2 audit, next-period makeup and immutable settlement", async () => {
  const h = harness(); await h.populate(); const batch = await h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ["1"], period: "2026-11" }, finance);
  await h.service.execute("POST", `/settlement/${batch.list[0].settle_id}/confirm`, {}, finance);
  await assert.rejects(h.service.execute("POST", "/appeal", { settle_id: batch.list[0].settle_id, ledger_id: "2", reason: "不是我的" }, service), { code: 5010 });
  const appeal = await h.service.execute("POST", "/appeal", { settle_id: batch.list[0].settle_id, ledger_id: "1", reason: "核对补发" }, service);
  await h.service.execute("POST", `/appeal/${appeal.id}/l1`, { result: "revise", note: "查实", amount_fen: 100 }, admin);
  await h.service.execute("POST", `/appeal/${appeal.id}/l2`, { result: "accepted", note: "同意" }, admin);
  assert.equal(h.store.snapshot().adjustments[0].period, "2026-12"); assert.equal(h.store.snapshot().settlements[0].amount_fen, 2796);
  h.setTime("2026-11-30 12:00:00"); await assert.rejects(h.service.execute("POST", "/appeal", { settle_id: batch.list[0].settle_id, ledger_id: "1", reason: "逾期" }, service), { code: 5009 });
  assert.equal(B.addWorkdays("2026-11-13 12:00:00", 5, ["2026-11-16"], ["2026-11-14"]), "2026-11-20");
});
test("service snapshot uses collected deposit independently of agreed total and photographer amount", async () => {
  const initial = seed(); initial.orders[0].service_net_amount_fen = 20000; initial.orders[0].net_amount_fen = 100000;
  const h = harness(initial); await h.populate();
  let state = h.store.snapshot(); assert.equal(state.ledger[0].net_amount_fen, 20000); assert.equal(state.ledger[0].commission_fen, 800); assert.equal(state.orders[0].net_amount_fen, 100000);
  await h.store.transaction(s => { s.orders[0].service_net_amount_fen = 100000; s.orders[0].finalPaid = 800; C.ensureLedger(s, s.orders[0], "2026-11-11 12:00:00"); });
  state = h.store.snapshot(); assert.equal(state.ledger[0].net_amount_fen, 20000); assert.equal(state.ledger[0].commission_fen, 800);
});
test("manual labels and review date are scoped, preserve audit, clear explicitly and never change rates", async () => {
  const initial = seed(); initial.staff.push({ id: "manager", account_id: "manager-account", name: "主管", staff_status: "active" }, { id: "indirect", supervisor_id: "a", name: "间接下属", staff_status: "active" }); initial.staff[0].supervisor_id = "manager";
  const supervisor = { kind: "admin", role: "service_supervisor", authzUserId: "manager-account", subjectId: "manager" }, h = harness(initial); await h.populate();
  const ruleBefore = h.store.snapshot().rules, ledgerBefore = h.store.snapshot().ledger;
  const updated = await h.service.execute("POST", "/staff/a/profile", { assessment_tags: ["新员工", " 旺季沟通 "], rate_review_date: "2026-12-01", reason: "主管人工维护" }, supervisor);
  assert.deepEqual(updated.assessment_tags, ["新员工", "旺季沟通"]); assert.equal(updated.rate_review_date, "2026-12-01");
  let snapshot = h.store.snapshot(); assert.equal(snapshot.staffLogs[0].operator, "manager-account"); assert.deepEqual(snapshot.staffLogs[0].from_tags, []); assert.deepEqual(snapshot.staffLogs[0].to_tags, ["新员工", "旺季沟通"]);
  assert.deepEqual(snapshot.rules, ruleBefore); assert.deepEqual(snapshot.ledger, ledgerBefore);
  const list = await h.service.execute("GET", "/staff", {}, supervisor); assert.equal(list.list.find(row => row.id === "a").can_edit_profile, true); assert.equal(list.list.some(row => row.id === "indirect"), false);
  await assert.rejects(h.service.execute("POST", "/staff/indirect/profile", { assessment_tags: ["不应修改"], reason: "越级" }, supervisor), { code: 4030 });
  await assert.rejects(h.service.execute("POST", "/staff/b/profile", { assessment_tags: ["不应修改"], reason: "越组" }, supervisor), { code: 4030 });
  await assert.rejects(h.service.execute("POST", "/staff/a/profile", { assessment_tags: ["不应修改"], reason: "员工自行操作" }, service), { code: 4030 });
  await assert.rejects(h.service.execute("POST", "/staff/a/profile", { rate_photo_bp: 5000, reason: "夹带比例" }, supervisor), { code: 4014 });
  await h.service.execute("POST", "/staff/a/profile", { assessment_tags: [], rate_review_date: null, reason: "撤销标记" }, supervisor);
  snapshot = h.store.snapshot(); assert.deepEqual(snapshot.staff[0].assessment_tags, []); assert.equal(snapshot.staff[0].rate_review_date, null); assert.equal(snapshot.staffLogs.length, 2);
  await h.service.execute("POST", "/staff/a/profile", { assessment_tags: [], rate_review_date: null, reason: "重复提交" }, supervisor); assert.equal(h.store.snapshot().staffLogs.length, 2);
});
test("staff creation keeps freely entered tags and strict dates in the same transaction", async () => {
  const h = harness();
  const form = { name: "新客服", phone: "13900139000", joined_at: "2026-11-10", base_salary: 0, rate_mode: "global", assessment_tags: ["新员工", "临时支持"], rate_review_date: "2026-12-01", reason: "新建档案" };
  const created = await h.service.execute("POST", "/staff", form, admin); assert.deepEqual(created.assessment_tags, form.assessment_tags); assert.equal(created.rate_review_date, form.rate_review_date);
  const before = h.store.snapshot();
  for (const change of [{ assessment_tags: ["重复", "重复"] }, { assessment_tags: ["过长".repeat(17)] }, { assessment_tags: ["非法\n标签"] }, { rate_review_date: "2026-02-30" }]) {
    await assert.rejects(h.service.execute("POST", `/staff/${created.id}/profile`, { ...change, reason: "校验无效输入" }, admin), { code: 4014 });
  }
  assert.deepEqual(h.store.snapshot(), before);
});
test("supervisor submits appeal on behalf of direct report without changing beneficiary or gaining financial permissions", async () => {
  const initial = seed(); initial.staff[0].supervisor_id = "manager"; initial.staff.push({ id: "manager", account_id: "manager-account", name: "主管", staff_status: "active" });
  const supervisor = { kind: "admin", role: "service_supervisor", authzUserId: "manager-account", subjectId: "manager" }, h = harness(initial); await h.populate();
  const batch = await h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ["1", "2"], period: "2026-11" }, finance); const a = batch.list.find(row => row.staff_id === "a"), b = batch.list.find(row => row.staff_id === "b");
  await h.service.execute("POST", `/settlement/${a.settle_id}/confirm`, {}, finance);
  const appeal = await h.service.execute("POST", "/appeal", { settle_id: a.settle_id, ledger_id: "1", reason: "代直属客服核对", staff_id: "manager" }, supervisor);
  assert.equal(appeal.staff_id, "a"); assert.equal(appeal.submitted_by, "manager-account");
  await assert.rejects(h.service.execute("POST", "/appeal", { settle_id: b.settle_id, ledger_id: "2", reason: "越组代办" }, supervisor), { code: 5010 });
  await assert.rejects(h.service.execute("POST", "/rule", {}, supervisor), { code: 4030 });
  await assert.rejects(h.service.execute("POST", `/settlement/${a.settle_id}/pay`, { voucher_url: "/api/media/voucher" }, supervisor), { code: 4030 });
  await assert.rejects(h.service.execute("POST", "/staff/a/rate", { reason: "越权改比例" }, supervisor), { code: 4030 });
});
test("final complaint reversal automatically restores draft and schedules already confirmed correction", async () => {
  const h = harness(); await h.populate(); await h.store.transaction(state => {
    C.applyComplaint(state, state.orders[0], null, "service", "2026-11-10 12:00:00", "manager");
    assert.equal(state.ledger[0].status, "void"); C.applyComplaint(state, state.orders[0], "service", "user", "2026-11-10 12:00:00", "manager");
    assert.equal(state.ledger[0].status, "settleable");
  });
  const batch = await h.service.execute("POST", "/ledger/batch-settle", { ledger_ids: ["1"], period: "2026-11" }, finance); await h.service.execute("POST", `/settlement/${batch.list[0].settle_id}/confirm`, {}, finance);
  await h.store.transaction(state => { C.applyComplaint(state, state.orders[0], "user", "service", "2026-11-11 12:00:00", "manager"); C.applyComplaint(state, state.orders[0], "service", "user", "2026-11-12 12:00:00", "manager"); });
  const snapshot = h.store.snapshot(); assert.equal(snapshot.settlements[0].amount_fen, 2796); assert.equal(snapshot.ledger[0].status, "settled"); assert.ok(snapshot.adjustments.some(row => row.action === "cancel_offset"));
});
