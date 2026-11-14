"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const core = require("../lib/svcCore.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const service = { kind: "admin", role: "service", authzUserId: "account-1" };
const admin = { kind: "admin", role: "super", authzUserId: "admin" };
const initial = () => ({
  staff: [{ id: "st1", account_id: "account-1", name: "林晓", staff_status: "active", base_salary: 3500 }, { id: "st2", account_id: "account-2", name: "阿宁", staff_status: "active", base_salary: 0 }],
  configs: [{ id: "1", ...core.DEFAULT_CONFIG, ver: 1, eff_at: "2026-11-01 00:00:00", operator: "admin", created_at: "2026-11-01 00:00:00" }],
  rules: [{ id: "1", ver: 1, beneficiary_type: "service", party_id: null, rate_photo_bp: 300, rate_video_bp: 300, rate_combo_bp: 300, rate_peripheral_bp: 300, eff_at: "2026-11-01 00:00:00" }, { id: "2", ver: 2, beneficiary_type: "service", party_id: "st1", rate_photo_bp: 400, rate_video_bp: 400, rate_combo_bp: 400, rate_peripheral_bp: 400, eff_at: "2026-11-01 00:00:00" }],
  orders: [{ id: "order1", order_no: "LM1", paid_at: "2026-11-10 20:52:00", customer_openid: "same-customer", requested_time: "2026-11-12 15:00:00", service_status: "new", assignee_id: null, photo_id: null, category: "photo", net_amount_fen: 69900, svc_paid_processed: 1, service_managed: true,
    totalAmount: 699, depositDue: 99, depositPaid: 99, depositFinanceStatus: "confirmed", finalDue: 600, finalPaid: 600, finalFinanceStatus: "confirmed" }],
  photographers: [{ id: "p1", name: "阿凯", status: "active" }, { id: "p2", name: "阿青", status: "active" }, { id: "p3", name: "离职", status: "ended" }],
});
function fixture(changes = {}) {
  const state = { ...initial(), ...changes }, store = createSvcMemoryStore(state); let date = "2026-11-10 21:00:00";
  const app = createSvcWorkbench({ store, clock: () => new Date(core.millis(date)) });
  return { app, store, at(v) { date = v; }, call(action, body = {}, who = service) { return app.execute("POST", "/api/kf/orders/LM1/" + action, body, who); } };
}
test("quiet window six documented boundaries use China time", () => {
  const base = core.DEFAULT_CONFIG;
  for (const [time, quiet, start] of [["2026-11-10 22:00:00", 1, "2026-11-11 09:00:00"], ["2026-11-10 09:00:00", 0, "2026-11-10 09:00:00"], ["2026-11-10 00:30:00", 1, "2026-11-10 09:00:00"], ["2026-11-10 20:52:00", 0, "2026-11-10 20:52:00"]]) {
    const row = core.reserveWindow(time, base); assert.equal(row.is_quiet, quiet); assert.equal(row.reserve_start_at, start);
  }
  assert.equal(core.reserveWindow("2026-11-10 13:00:00", { ...base, quiet_start: "12:00", quiet_end: "14:00" }).reserve_start_at, "2026-11-10 14:00:00");
  assert.throws(() => core.validateConfig({ quiet_start: "09:00", quiet_end: "09:00" }), e => e.code === 4013);
});
test('schedule and assignment reject overlong SQL reasons before mutating state',async()=>{
  const f=fixture();await f.call('claim',{expected_status:'new'});
  await assert.rejects(f.call('slot/confirm',{expected_status:'claimed',new_time:'2026-11-12 16:00:00',reason:'长'.repeat(65),channel:'phone'}),error=>error.code===4014);
  assert.equal(f.store.snapshot().orders[0].service_status,'claimed');assert.equal(f.store.snapshot().slotLogs.length,0);assert.equal(f.store.snapshot().assignLogs.length,0);
  await f.call('slot/confirm',{expected_status:'claimed',new_time:'2026-11-12 15:00:00'});
  await assert.rejects(f.call('assign',{expected_status:'confirmed',to_photo:'p1',reason:'长'.repeat(65),channel:'phone'}),error=>error.code===4014);
  assert.equal(f.store.snapshot().orders[0].service_status,'confirmed');assert.equal(f.store.snapshot().assignLogs.length,0);
});
test("50 concurrent claims have a single owner and accurate loser message", async () => {
  const f = fixture();
  const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => f.call("claim", { expected_status: "new" }, i % 2 ? { ...service, authzUserId: "account-2" } : service)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.store.snapshot().orders[0].assignee_id, "st1");
  for (const r of results.filter(r => r.status === "rejected")) { assert.equal(r.reason.code, 4001); assert.match(r.reason.message, /林晓/); }
  assert.equal(f.store.snapshot().ledger.length, 1);
});
test("claim does not bind ordinary customer and uses shared personal rate", async () => {
  const f = fixture(); await f.call("claim", { expected_status: "new" });
  const state = f.store.snapshot(); assert.equal(state.bindings.length, 0); assert.equal(state.ledger[0].commission_fen, 2796); assert.equal(state.ledger[0].rate_mode, "custom");
});
test("confirmation preserves requested time and only changed value creates slot log", async () => {
  const f = fixture(); await f.call("claim", { expected_status: "new" }); await f.call("slot/confirm", { expected_status: "claimed", new_time: "2026-11-12 15:00:00" });
  assert.equal(f.store.snapshot().slotLogs.length, 0); assert.equal(f.store.snapshot().orders[0].service_status, "confirmed");
  const g = fixture(); await g.call("claim", { expected_status: "new" }); await g.call("slot/confirm", { expected_status: "claimed", new_time: "2026-11-12 16:00:00", reason: "用户调整", channel: "phone" });
  assert.equal(g.store.snapshot().slotLogs.length, 1); assert.equal(g.store.snapshot().orders[0].requested_time, "2026-11-12 15:00:00");
});
test("reschedule while shooting preserves state, rejects past and invalid dates", async () => {
  const state = initial(); Object.assign(state.orders[0], { service_status: "shooting", assignee_id: "st1", photo_id: "p1", schedule_time: "2026-11-12 15:00:00" }); const f = fixture(state);
  const result = await f.call("slot/reschedule", { expected_status: "shooting", new_time: "2026-11-13 16:00:00", reason: "天气", channel: "wechat" });
  assert.equal(result.service_status, "shooting"); assert.equal(result.requested_time, "2026-11-12 15:00:00");
  await assert.rejects(f.call("slot/reschedule", { expected_status: "shooting", new_time: "2026-11-09 16:00:00", reason: "天气", channel: "wechat" }), e => e.code === 4008);
  await assert.rejects(f.call("slot/reschedule", { expected_status: "shooting", new_time: "2026-11-31 16:00:00", reason: "天气", channel: "wechat" }), e => e.code === 4008);
});
test("photographer transfer cannot change service owner or commission", async () => {
  const f = fixture(); await f.call("claim", { expected_status: "new" }); await f.call("slot/confirm", { expected_status: "claimed", new_time: "2026-11-12 15:00:00" }); await f.call("assign", { expected_status: "confirmed", to_photo: "p1", reason: "线下确认", channel: "phone" });
  const before = f.store.snapshot().ledger[0]; await f.call("transfer", { expected_status: "confirmed", to_photo: "p2", reason: "临时有事", channel: "phone" });
  const after = f.store.snapshot(); assert.equal(after.orders[0].assignee_id, "st1"); assert.equal(after.orders[0].photo_id, "p2"); assert.deepEqual(after.ledger[0], before); assert.equal(after.assignLogs.at(-1).zero_amount, 1);
  await assert.rejects(f.call("transfer", { expected_status: "confirmed", to_photo: "p3", reason: "调整", channel: "phone" }), e => e.code === 4009);
});
test("finishing an already fully paid shoot activates ledger and binds customer, absent photographer rolls back", async () => {
  const state = initial(); Object.assign(state.orders[0], { service_status: "shooting", assignee_id: "st1", photo_id: "p1" }); const f = fixture(state);
  const result = await f.call("shoot/finish", { expected_status: "shooting" });
  assert.equal(result.commission_fen, 2796); assert.equal(result.bind_expire_at, "2026-11-15 21:00:00"); assert.equal(f.store.snapshot().ledger[0].status, "obs");
  const g = fixture({ orders: [{ ...state.orders[0], photo_id: null }] }); await assert.rejects(g.call("shoot/finish", { expected_status: "shooting" }), e => e.code === 4003); assert.equal(g.store.snapshot().orders[0].service_status, "shooting"); assert.equal(g.store.snapshot().bindings.length, 0);
});
test("missing openid never blocks completion or commission", async () => {
  const state = initial(); Object.assign(state.orders[0], { service_status: "shooting", assignee_id: "st1", photo_id: "p1", customer_openid: null }); const f = fixture(state);
  const result = await f.call("shoot/finish", { expected_status: "shooting" }); assert.equal(result.bound, false); assert.equal(result.commission_fen, 2796); assert.equal(f.store.snapshot().bindings.length, 0);
});
function boundState(paid = "2026-11-10 22:12:00") { const state = initial(); state.orders[0].paid_at = paid; state.bindings = [{ id: "1", openid: "same-customer", staff_id: "st1", source_order_no: "old", bound_at: "2026-11-09 15:00:00", expire_at: "2026-11-14 15:00:00", status: "active" }]; return state; }
test("payment callback is idempotent under 20 repeats and quiet countdown frozen", async () => {
  const f = fixture(boundState()); await Promise.all(Array.from({ length: 20 }, () => f.app.onPaid({ orderNo: "LM1", paid_at: "2026-11-10 22:12:00" })));
  assert.equal(f.store.snapshot().reserves.length, 1); assert.equal(f.store.snapshot().events.length, 1);
  const row = f.store.snapshot().reserves[0]; assert.equal(row.reserve_start_at, "2026-11-11 09:00:00");
  f.at("2026-11-11 08:59:59"); await f.app.runTasks(); const list = await f.app.execute("GET", "/api/kf/orders/reserved", {}, service); assert.equal(list.list[0].left_seconds, null);
  f.at("2026-11-11 09:00:00"); await f.app.runTasks(); assert.equal(f.store.snapshot().reserves[0].status, "started");
});
test("holding reservation may be taken early, renews binding and not later reflowed", async () => {
  const f = fixture(boundState()); await f.app.onPaid({ orderNo: "LM1" }); f.at("2026-11-10 23:00:00"); await f.call("reserve/take", { expected_status: "reserved" });
  assert.equal(f.store.snapshot().orders[0].service_status, "claimed"); assert.equal(f.store.snapshot().bindings[0].expire_at, "2026-11-15 23:00:00");
  f.at("2026-11-11 11:00:00"); await f.app.runTasks(); assert.equal(f.store.snapshot().orders[0].service_status, "claimed");
});
test("expiration reflows only one order and keeps binding for other reserved order", async () => {
  const state = boundState("2026-11-10 20:00:00"); state.orders.push({ ...state.orders[0], id: "order2", order_no: "LM2", paid_at: "2026-11-10 20:30:00" }); const f = fixture(state);
  await f.app.onPaid({ orderNo: "LM1" }); await f.app.onPaid({ orderNo: "LM2" }); f.at("2026-11-10 21:00:00"); await f.app.runTasks();
  let after = f.store.snapshot(); assert.equal(after.orders[0].service_status, "new"); assert.equal(after.orders[1].service_status, "reserved"); assert.equal(after.bindings[0].status, "active");
  f.at("2026-11-10 21:30:00"); await f.app.runTasks(); after = f.store.snapshot(); assert.equal(after.bindings[0].status, "released"); assert.equal(after.bindings[0].release_reason, "timeout");
  const before = after.bindingLogs.length; await f.app.runTasks(); assert.equal(f.store.snapshot().bindingLogs.length, before);
});
test("quiet active giveup immediately returns pool and conditionally unbinds", async () => {
  const f = fixture(boundState()); await f.app.onPaid({ orderNo: "LM1" }); await f.call("reserve/giveup", { expected_status: "reserved" }); assert.equal(f.store.snapshot().orders[0].service_status, "new"); assert.equal(f.store.snapshot().bindings[0].release_reason, "giveup");
});
test("paused and expired bindings never reserve a newly paid order", async () => {
  for (const mutate of [s => { s.staff[0].staff_status = "paused"; }, s => { s.bindings[0].expire_at = "2026-11-10 00:00:00"; }]) {
    const state = boundState(); mutate(state); const f = fixture(state); const result = await f.app.onPaid({ orderNo: "LM1" }); assert.equal(result.reserved, false); assert.equal(f.store.snapshot().reserves.length, 0);
  }
});
test("refund cancels reserved order without reflow or binding release; terminal cannot claim", async () => {
  const f = fixture(boundState()); await f.app.onPaid({ orderNo: "LM1" }); await f.app.onRefund("LM1"); f.at("2026-11-12 11:00:00"); await f.app.runTasks();
  assert.equal(f.store.snapshot().orders[0].service_status, "refunded"); assert.equal(f.store.snapshot().reserves[0].status, "canceled");
  await assert.rejects(f.call("claim", { expected_status: "refunded" }), e => e.code === 4003);
});
test("observation boundary uses exact timestamps and unknown complaints stay on hold", async () => {
  const state = initial(); Object.assign(state.orders[0], { service_status: "shooting", assignee_id: "st1", photo_id: "p1" }); const f = fixture(state); f.at("2026-11-10 23:50:00"); await f.call("shoot/finish", { expected_status: "shooting" });
  f.at("2026-11-17 23:49:59"); await f.app.runTasks(); assert.equal(f.store.snapshot().ledger[0].status, "obs");
  f.at("2026-11-17 23:50:00"); await f.app.runTasks(); assert.equal(f.store.snapshot().ledger[0].status, "settleable");
  await f.app.execute("POST", "/api/kf/complaints", { order_no: "LM1", resp: "unknown", reason: "待调查" }, service); await f.app.runTasks(); assert.equal(f.store.snapshot().ledger[0].status, "obs");
});
test("service responsibility allows finish but blocks/revokes binding; duplicate complaint returns id", async () => {
  const state = initial(); Object.assign(state.orders[0], { service_status: "shooting", assignee_id: "st1", photo_id: "p1" }); const f = fixture(state);
  const complaint = await f.app.execute("POST", "/api/kf/complaints", { order_no: "LM1", resp: "service", reason: "服务问题" }, service);
  await assert.rejects(f.app.execute("POST", "/api/kf/complaints", { order_no: "LM1", resp: "service", reason: "重复" }, service), e => e.code === 4010 && e.data.id === complaint.id);
  const done = await f.call("shoot/finish", { expected_status: "shooting" }); assert.equal(done.bound, false); assert.equal(f.store.snapshot().ledger[0].status, "void");
  await assert.rejects(f.app.execute("POST", `/api/kf/complaints/${complaint.id}/rejudge`, { resp: "user", reason: "复核" }, service), e => e.code === 403);
  await f.app.execute("POST", `/api/kf/complaints/${complaint.id}/rejudge`, { resp: "user", reason: "复核" }, admin); assert.equal(f.store.snapshot().complaints[0].resp, "service"); assert.equal(f.store.snapshot().complaints[0].rejudge_log[0].to, "user");
});
test("config versions use CAS, next midnight, single source and no retroactive reserve changes", async () => {
  const f = fixture(boundState()); await f.app.onPaid({ orderNo: "LM1" }); const reserve = f.store.snapshot().reserves[0];
  const saved = await f.app.execute("PUT", "/api/kf/rebuy/config", { ver: 1, hold_minutes: 120 }, admin); assert.equal(saved.eff_at, "2026-11-11 00:00:00");
  await assert.rejects(f.app.execute("PUT", "/api/kf/rebuy/config", { ver: 1, hold_minutes: 90 }, admin), e => e.code === 5003);
  assert.deepEqual(f.store.snapshot().reserves[0], reserve); const read = await f.app.execute("GET", "/api/kf/rebuy/config", {}, service); assert.equal(read.active.hold_minutes, 60); assert.equal(read.latest.hold_minutes, 120);
});
test("session identity scope ignores body staff and rejects finance actions", async () => {
  const f = fixture(); await f.call("claim", { expected_status: "new", staff_id: "st2" }); assert.equal(f.store.snapshot().orders[0].assignee_id, "st1");
  await assert.rejects(f.call("slot/confirm", { expected_status: "claimed", new_time: "2026-11-12 15:00:00" }, { ...service, role: "finance" }), e => e.code === 403);
  const other = await f.app.execute("GET", "/api/kf/orders/mine", {}, { ...service, authzUserId: "account-2" }); assert.equal(other.total, 0);
  await assert.rejects(f.app.execute("GET", "/api/kf/orders/LM1", {}, { ...service, authzUserId: "account-2" }), e => e.code === 403);
});
test("link resolve only reveals other ownership and generate rejects forged owner", async () => {
  const f = fixture(); await f.call("claim", { expected_status: "new" }); const other = { ...service, authzUserId: "account-2" };
  const result = await f.app.execute("GET", "/api/kf/link/resolve", { no: "LM1" }, other); assert.equal(result.is_mine, false); assert.equal(result.phone, undefined);
  await assert.rejects(f.app.execute("POST", "/api/kf/link/generate", { order_no: "LM1" }, other), e => e.code === 4011);
});
test("historical paid orders appear in the public pool while unpaid orders remain in all orders", async () => {
  const state = initial(); state.orders.push({ ...state.orders[0], id: "old", order_no: "OLD", svc_paid_processed: 0, service_managed: false }); state.orders.push({ ...state.orders[0], id: "unpaid", order_no: "UNPAID", depositPaid: 0, finalPaid: 0 }); const f = fixture(state);
  const rows = await f.app.execute("GET", "/api/kf/orders/pool", {}, service); assert.deepEqual(new Set(rows.list.map(x => x.order_no)), new Set(["LM1","OLD"]));
  assert.equal(rows.list.find(row=>row.order_no==='OLD').can_claim,true);
  const all = await f.app.execute("GET", "/api/kf/orders/all", {}, service); assert.equal(all.total, 3);
});
function managedGroupState() {
  const state = initial();
  state.staff.push({ id: "manager", account_id: "manager-account", name: "直属主管", staff_status: "active" }, { id: "other-manager", account_id: "other-manager-account", name: "别组主管", staff_status: "active" }, { id: "indirect", account_id: "indirect-account", supervisor_id: "st1", name: "间接下属", staff_status: "active" });
  state.staff[0].supervisor_id = "manager"; state.staff[1].supervisor_id = "other-manager";
  return state;
}
const supervisor = { kind: "admin", role: "service_supervisor", authzUserId: "manager-account" };
test("supervisor acts on a direct report reservation without taking commission ownership", async () => {
  const state = managedGroupState();
  state.bindings = [{ id: "1", openid: "same-customer", staff_id: "st1", source_order_no: "prior", bound_at: "2026-11-09 12:00:00", expire_at: "2026-11-14 12:00:00", status: "active" }];
  state.orders[0].service_status = "new"; const f = fixture(state); await f.app.onPaid({ orderNo: "LM1" });
  const choices = await f.app.execute("GET", "/api/kf/staff", {}, supervisor);
  assert.deepEqual(choices.list.map(row => row.id).sort(), ["manager", "st1"]);
  const result = await f.call("reserve/take", { expected_status: "reserved", staff_id: "manager" }, supervisor);
  assert.equal(result.assignee_id, "st1"); const snap = f.store.snapshot();
  assert.equal(snap.ledger[0].party_id, "st1"); assert.equal(snap.ledger[0].commission_fen, 2796);
  assert.equal(snap.bindings[0].staff_id, "st1"); assert.equal(snap.bindingLogs.at(-1).operator, "manager-account");
  assert.equal(snap.operationLogs.at(-1).staff_id, "st1"); assert.equal(snap.operationLogs.at(-1).operator, "manager-account");
  const out = fixture({ ...managedGroupState(), ...{ orders: [{ ...initial().orders[0], service_status: "reserved", reserve_staff_id: "st2" }], reserves: [{ id: "1", order_no: "LM1", staff_id: "st2", status: "started", reserve_start_at: "2026-11-10 20:52:00", reserve_expire_at: "2026-11-10 21:52:00" }] } });
  await assert.rejects(out.call("reserve/take", { expected_status: "reserved" }, supervisor), error => error.code === 4002);
});
test("supervisor delegates claim and giveup only within direct scope, with real actor audit", async () => {
  const state = managedGroupState(), f = fixture(state);
  await assert.rejects(f.call("claim", { expected_status: "new", staff_id: "indirect" }, supervisor), error => error.code === 403);
  await f.call("claim", { expected_status: "new", staff_id: "st1" }, supervisor);
  assert.equal(f.store.snapshot().orders[0].assignee_id, "st1");
  assert.equal(f.store.snapshot().operationLogs[0].operator, "manager-account");
  const reserved = managedGroupState(); Object.assign(reserved.orders[0], { service_status: "reserved", reserve_staff_id: "st1" });
  reserved.reserves = [{ id: "1", order_no: "LM1", staff_id: "st1", openid: "same-customer", status: "holding", reserve_start_at: "2026-11-11 09:00:00", reserve_expire_at: "2026-11-11 10:00:00" }];
  const giveup = fixture(reserved); await giveup.call("reserve/giveup", { expected_status: "reserved" }, supervisor);
  assert.equal(giveup.store.snapshot().orders[0].service_status, "new"); assert.equal(giveup.store.snapshot().operationLogs[0].staff_id, "st1");
});
test("supervisor generated links retain subordinate source and reject indirect or unrelated staff", async () => {
  const state = managedGroupState(); Object.assign(state.orders[0], { service_status: "claimed", assignee_id: "st1" }); const store = createSvcMemoryStore(state);
  let generatedFor;
  const app = createSvcWorkbench({ store, clock: () => new Date(core.millis("2026-11-10 21:00:00")), linkProvider: async ({ staff, session }) => { generatedFor = { staff: staff.id, actor: session.authzUserId }; return { path: "pages/index?staff=" + staff.id }; } });
  const resolved = await app.execute("GET", "/api/kf/link/resolve", { no: "LM1" }, supervisor);
  assert.equal(resolved.is_mine, false); assert.equal(resolved.can_generate_link, true);
  await app.execute("POST", "/api/kf/link/generate", { order_no: "LM1", staff_id: "manager" }, supervisor);
  assert.deepEqual(generatedFor, { staff: "st1", actor: "manager-account" }); assert.equal(store.snapshot().links[0].staff_id, "st1");
  await store.transaction(s => { s.orders[0].assignee_id = "indirect"; });
  const rejected = await app.execute("GET", "/api/kf/link/resolve", { no: "LM1" }, supervisor); assert.equal(rejected.can_generate_link, false); assert.equal(rejected.phone, undefined);
  await assert.rejects(app.execute("POST", "/api/kf/link/generate", { order_no: "LM1" }, supervisor), error => error.code === 4011);
});
test("supervisor final responsibility rejudgment restores direct report commission without finance approval", async () => {
  const state = managedGroupState(); Object.assign(state.orders[0], { service_status: "shooting", assignee_id: "st1", photo_id: "p1" }); const f = fixture(state);
  await f.app.execute("POST", "/api/kf/complaints", { order_no: "LM1", resp: "service", reason: "初次判责" }, service);
  await f.call("shoot/finish", { expected_status: "shooting" }); assert.equal(f.store.snapshot().ledger[0].status, "void");
  await f.app.execute("POST", "/api/kf/complaints/1/rejudge", { resp: "user", reason: "复核客服无责" }, supervisor);
  assert.equal(f.store.snapshot().ledger[0].status, "obs"); assert.equal(f.store.snapshot().ledger[0].party_id, "st1");
  assert.equal(f.store.snapshot().complaints[0].rejudge_log[0].by, "manager-account"); assert.equal(f.store.snapshot().adjustments.filter(row => row.action === "restore").length, 0);
  await f.store.transaction(s => { s.orders[0].assignee_id = "st2"; });
  await assert.rejects(f.app.execute("POST", "/api/kf/complaints/1/rejudge", { resp: "service", reason: "越组" }, supervisor), error => error.code === 403);
});
test("peripheral receipt completes without photographer, is idempotent and starts observation at receipt", async () => {
  const state = managedGroupState(); Object.assign(state.orders[0], { service_status: "claimed", assignee_id: "st1", category: "peripheral", photo_id: null, schedule_time: null, service_net_amount_fen: 20000 }); const f = fixture(state);
  await assert.rejects(f.call("receipt/confirm", { expected_status: "claimed", received: false }, supervisor), error => error.code === 4014);
  const done = await f.call("receipt/confirm", { expected_status: "claimed", received: true }, supervisor);
  assert.equal(done.service_status, "done"); assert.equal(done.photo_id, null); assert.equal(done.assignee_id, "st1");
  assert.equal(done.done_at, "2026-11-10 21:00:00"); assert.equal(done.observe_until, "2026-11-17 21:00:00"); assert.equal(done.commission_basis_amount_fen, 20000);
  const first = f.store.snapshot(); assert.equal(first.ledger[0].status, "obs"); assert.equal(first.receiptLogs[0].operator, "manager-account");
  f.at("2026-11-10 22:00:00"); const repeat = await f.call("receipt/confirm", { expected_status: "claimed", received: true }, supervisor);
  assert.equal(repeat.idempotent, true); assert.equal(f.store.snapshot().receiptLogs.length, 1); assert.equal(f.store.snapshot().orders[0].done_at, first.orders[0].done_at);
  const detail = await f.app.execute("GET", "/api/kf/orders/LM1", {}, supervisor); assert.ok(detail.timeline.some(log => log.action === "receipt_confirmed"));
  await f.app.onRefund("LM1"); await assert.rejects(f.call("receipt/confirm", { expected_status: "refunded", received: true }, supervisor), error => error.code === 4003);
});
test("photography orders cannot skip shooting through receipt endpoint; peripheral cannot fabricate shooting", async () => {
  const state = initial(); Object.assign(state.orders[0], { service_status: "claimed", assignee_id: "st1" }); const photo = fixture(state);
  await assert.rejects(photo.call("receipt/confirm", { expected_status: "claimed", received: true }), error => error.code === 4003);
  state.orders[0].category = "peripheral"; const peripheral = fixture(state);
  await assert.rejects(peripheral.call("assign", { expected_status: "claimed", to_photo: "p1", reason: "不应派单", channel: "phone" }), error => error.code === 4003);
  await peripheral.store.transaction(s => { s.orders[0].service_status = "confirmed"; s.orders[0].photo_id = "p1"; s.orders[0].schedule_time = "2026-11-12 15:00:00"; });
  await assert.rejects(peripheral.call("shoot/start", { expected_status: "confirmed" }), error => error.code === 4003);
});
test("calendar rejects impossible dates and overlaps while preserving shared config", () => {
  assert.throws(() => core.validateConfig({ holiday_dates: ["2026-02-30"] }), error => error.code === 4014);
  assert.throws(() => core.validateConfig({ holiday_dates: ["2026-11-14"], workday_dates: ["2026-11-14"] }), error => error.code === 4014);
  assert.deepEqual(core.validateConfig({ holiday_dates: ["2026-11-16", "2026-11-16"], workday_dates: ["2026-11-14"] }).holiday_dates, ["2026-11-16"]);
});

test("first assignment waits for confirmed time and photography completion cannot skip shooting", async () => {
  const f = fixture(); await f.call("claim", { expected_status: "new" });
  await assert.rejects(f.call("assign", { expected_status: "claimed", to_photo: "p1", reason: "线下确认", channel: "phone" }), { code: 4003 });
  assert.equal(f.store.snapshot().assignLogs.length, 0);
  await f.call("slot/confirm", { expected_status: "claimed", new_time: "2026-11-12 15:00:00", channel: "phone" });
  await f.call("assign", { expected_status: "confirmed", to_photo: "p1", reason: "线下确认", channel: "phone" });
  await assert.rejects(f.call("shoot/finish", { expected_status: "confirmed" }), { code: 4003 });
  await f.call("shoot/start", { expected_status: "confirmed" });
  await f.call("shoot/finish", { expected_status: "shooting" });
  assert.equal(f.store.snapshot().orders[0].service_status, "done");
});

test("state residence follows durable transition logs and rescheduling never resets it", async () => {
  const f = fixture(); await f.call("claim", { expected_status: "new" });
  f.at("2026-11-10 21:20:00");
  let row = await f.app.execute("GET", "/api/kf/orders/LM1", {}, service);
  assert.equal(row.stay_minutes, 20); assert.equal(row.status_changed_at, "2026-11-10 21:00:00");
  await f.call("slot/confirm", { expected_status: "claimed", new_time: "2026-11-12 15:00:00", channel: "phone" });
  f.at("2026-11-10 21:35:00");
  await f.call("slot/reschedule", { expected_status: "confirmed", new_time: "2026-11-12 16:00:00", reason: "天气", channel: "wechat" });
  row = await f.app.execute("GET", "/api/kf/orders/LM1", {}, service);
  assert.equal(row.stay_minutes, 15); assert.equal(row.requested_time, "2026-11-12 15:00:00");
  assert.ok(row.timeline.some(log => log.action === "slot_confirm" && log.reason.includes("phone")));
  await f.call("assign", { expected_status: "confirmed", to_photo: "p1", reason: "线下确认", channel: "phone" });
  await f.call("shoot/start", { expected_status: "confirmed" });
  f.at("2026-11-10 22:00:00");
  const restarted = createSvcWorkbench({ store: f.store, clock: () => "2026-11-10 22:00:00" });
  row = await restarted.execute("GET", "/api/kf/orders/LM1", {}, service);
  assert.equal(row.stay_minutes, 25); assert.equal(row.status_changed_at, "2026-11-10 21:35:00");
});

test("timeout creates one durable reflow audit and refund clears reserved ownership without releasing binding", async () => {
  const f = fixture(boundState("2026-11-10 20:00:00"));
  await f.app.onPaid({ orderNo: "LM1" }); await f.app.runTasks(); await f.app.runTasks();
  const row = await f.app.execute("GET", "/api/kf/orders/LM1", {}, service);
  assert.equal(row.reflow_count, 1); assert.equal(row.reflow_at, "2026-11-10 21:00:00");
  assert.equal(row.status_changed_at, "2026-11-10 21:00:00");
  assert.equal(f.store.snapshot().operationLogs.filter(log => log.action === "reserve_timeout").length, 1);
  const g = fixture(boundState()); await g.app.onPaid({ orderNo: "LM1" }); await g.app.onRefund("LM1");
  const refunded = g.store.snapshot();
  assert.equal(refunded.orders[0].reserve_staff_id, null); assert.equal(refunded.bindings[0].status, "active");
  assert.equal(refunded.reserves[0].status, "canceled"); assert.equal(refunded.bindingLogs.length, 0);
  await g.app.onRefund("LM1"); assert.equal(g.store.snapshot().operationLogs.filter(log => log.action === "refund").length, 1);
});

test("direct claim cannot bypass a live reservation whose order status projection is inconsistent", async () => {
  const state = initial();
  state.reserves = [{ id: "1", order_no: "LM1", staff_id: "st2", status: "holding", reserve_start_at: "2026-11-11 09:00:00", reserve_expire_at: "2026-11-11 10:00:00" }];
  const f = fixture(state);
  await assert.rejects(f.call("claim", { expected_status: "new" }), { code: 4002 });
  assert.equal(f.store.snapshot().orders[0].assignee_id, null);
});

test("workbench prioritizes urgent reservations, six oldest claimable orders and unresolved complaints", async () => {
  const state = initial(), base = state.orders[0];
  const order = (no, status, extra = {}) => ({ ...base, id: no, order_no: no, service_status: status, assignee_id: "st1", photo_id: "p1", paid_at: "2026-11-10 12:00:00", ...extra });
  state.orders = [order("URGENT", "reserved", { assignee_id: null, reserve_staff_id: "st1" }), order("REVIEW", "done", { done_at: "2026-11-10 15:00:00" }), order("CLAIMED", "claimed", { photo_id: null }), order("UNASSIGNED", "confirmed", { photo_id: null }), order("SHOOT", "shooting"), order("NIGHT", "reserved", { assignee_id: null, reserve_staff_id: "st1" }), order("OTHER", "done", { assignee_id: "st2" })];
  state.orders.push(...Array.from({ length: 8 }, (_, i) => order("PUBLIC" + i, "new", { assignee_id: null, photo_id: null, paid_at: `2026-11-10 12:0${i}:00` })));
  state.reserves = [{ id: "1", order_no: "URGENT", staff_id: "st1", status: "started", reserve_start_at: "2026-11-10 20:05:00", reserve_expire_at: "2026-11-10 21:05:00" }, { id: "2", order_no: "NIGHT", staff_id: "st1", status: "holding", reserve_start_at: "2026-11-11 09:00:00", reserve_expire_at: "2026-11-11 10:00:00" }];
  state.complaints = [{ id: "1", order_no: "REVIEW", resp: "unknown", reason: "待复核", created_at: "2026-11-10 20:30:00" }, { id: "2", order_no: "OTHER", resp: "unknown", created_at: "2026-11-10 20:00:00" }];
  const f = fixture(state), rows = (await f.app.execute("GET", "/api/kf/workbench/todo", { size: 100 }, service)).list;
  assert.deepEqual(rows.map(row => row.order_no), ["URGENT", "PUBLIC0", "PUBLIC1", "PUBLIC2", "PUBLIC3", "PUBLIC4", "PUBLIC5", "REVIEW", "CLAIMED", "UNASSIGNED", "SHOOT", "NIGHT"]);
  assert.equal(rows[0].suggested_action, "reserve_take");
  assert.equal(rows[7].suggested_action, "rejudge"); assert.equal(rows[7].complaint_id, "1"); assert.equal(rows[7].stay_minutes, 30);
  assert.equal(rows[9].suggested_action, "assign"); assert.equal(rows.at(-1).left_seconds, null);
});
