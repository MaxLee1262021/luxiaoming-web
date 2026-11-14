"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const CS = require("../lib/customerService.cjs");
const { createSvcStore, createSvcMemoryStore } = require("../lib/svcStore.cjs");
const at = "2026-11-13 12:00:00";
function disabled(t) {
  const prior = process.env.SVC_ENABLE_AT; delete process.env.SVC_ENABLE_AT;
  t.after(() => { if (prior === undefined) delete process.env.SVC_ENABLE_AT; else process.env.SVC_ENABLE_AT = prior; });
}
function admittedState() {
  return { operationLogs: [{ id: "1", order_no: "MANUAL", action: "claim", staff_id: "cs", operator: "cs-account", created_at: "2026-11-01 12:00:00" }],
    orders: [{ id: "o", order_no: "MANUAL", paid_at: "2026-10-31 12:00:00", done_at: "2026-11-01 12:00:00", service_status: "done", assignee_id: "cs", svc_paid_processed: 0, svcPaymentPending: true, svcPaymentAttempts: 2 },
      { id: "other", order_no: "UNCLAIMED", paid_at: "2026-10-31 12:00:00", service_status: "new", svc_paid_processed: 0 }],
    staff: [{ id: "cs", name: "客服", account_id: "cs-account", staff_status: "active" }],
    ledger: [{ id: "1", biz_no: "MANUAL", beneficiary_type: "service", party_id: "cs", category: "photo", rate_bp: 500, net_amount_fen: 20000, commission_fen: 1000,
      paid_at: "2026-10-31 12:00:00", done_at: "2026-11-01 12:00:00", observe_days: 7, status: "obs", settle_id: null }],
    configs: [], rules: [] };
}
const rejectAccess = async () => { throw new Error("unapproved payment/order scan"); };

test("manual claim admission lookup uses a parameterized EXISTS and never reads orders or runs writes", async () => {
  const calls = [], source = { transaction: async work => work({ query: async (sql, params) => { calls.push({ sql, params }); return [[{ has_manual_claims: 1 }]]; } }) };
  const store = createSvcStore(source);
  assert.equal(await store.hasManualClaims(), true);
  const malicious = "ORDER' OR 1=1";
  assert.equal(await store.hasManualClaims(malicious), true);
  assert.equal(await CS.hasManualClaims(source, malicious), true);
  assert.equal(await store.hasManualClaims(""), false);
  assert.equal(calls.length, 3);
  for (const { sql, params } of calls) {
    assert.match(sql, /^SELECT EXISTS\(SELECT 1 FROM svc_operation_log WHERE action='claim'/);
    assert.doesNotMatch(sql, /lxm_orders|FOR UPDATE|INSERT|UPDATE|DELETE|CREATE|ALTER/i);
    assert.equal(sql.includes("order_no=?"), params.length === 1);
    if (params.length) { assert.deepEqual(params, [malicious]); assert.ok(!sql.includes(malicious)); }
  }
});

test("manual lookup treats absent migrations and legacy adapters as inactive while surfacing other database failures", async () => {
  assert.equal(await CS.hasManualClaims({}), false);
  const missing = { transaction: async () => { throw Object.assign(new Error("absent table"), { code: "ER_NO_SUCH_TABLE" }); } };
  assert.equal(await CS.hasManualClaims(missing), false);
  const broken = { transaction: async () => { throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" }); } };
  await assert.rejects(CS.hasManualClaims(broken), { code: "ECONNREFUSED" });
  const memory = createSvcMemoryStore({ operationLogs: [{ action: "assign", order_no: "NO" }, { action: "claim", order_no: "YES" }] });
  assert.equal(await memory.hasManualClaims(), true); assert.equal(await memory.hasManualClaims("YES"), true);
  assert.equal(await memory.hasManualClaims("NO"), false); assert.equal(await memory.hasManualClaims(""), false);
});

test("disabled automation with no explicit claims performs only the admission read and leaves all state unchanged", async t => {
  disabled(t);
  const initial = admittedState(); initial.operationLogs = [];
  const inner = createSvcMemoryStore(initial), before = inner.snapshot(); let writes = 0, checks = 0;
  const store = { ...inner, async hasManualClaims(no) { checks++; return inner.hasManualClaims(no); }, async transaction() { writes++; throw new Error("must not run disabled jobs"); } };
  const source = { list: rejectAccess, get: rejectAccess, update: rejectAccess };
  const worker = CS.createWorker(source, { store, clock: () => at, logger: { error: (...args) => assert.fail(JSON.stringify(args)) } });
  await worker.tick(); await worker.tick(); await worker.stop();
  assert.equal(checks, 2); assert.equal(writes, 0); assert.deepEqual(inner.snapshot(), before);
  assert.deepEqual(await CS.onPaid(source, { id: "o", depositPaidAt: at }), { skipped: true });
  assert.deepEqual(await CS.queuePaid(source, { id: "o", depositPaidAt: at }), { skipped: true });
  assert.deepEqual(await CS.onRefund(source, { orderNo: "UNCLAIMED" }), { skipped: true });
});

test("disabled automation keeps manual observation and monthly settlement jobs running without reading or retrying payment orders", async t => {
  disabled(t);
  const store = createSvcMemoryStore(admittedState()), source = { list: rejectAccess, get: rejectAccess, update: rejectAccess };
  let now = at;
  const options = { store, clock: () => now, logger: { error: (...args) => assert.fail(JSON.stringify(args)) } };
  const worker = CS.createWorker(source, options);
  await worker.tick();
  let state = store.snapshot(); assert.equal(state.ledger[0].status, "settleable");
  assert.equal(state.orders[0].svcPaymentPending, true); assert.equal(state.orders[0].svcPaymentAttempts, 2);
  assert.equal(state.orders[0].svc_paid_processed, 0); assert.deepEqual(state.events, []); assert.deepEqual(state.reserves, []);
  now = "2026-12-01 00:30:00"; await worker.tick(); state = store.snapshot();
  assert.equal(state.settlements.length, 1); assert.equal(state.settlements[0].period, "2026-11"); assert.equal(state.settlements[0].amount_fen, 1000);
  assert.equal(state.ledger[0].status, "settled"); assert.equal(state.orders[0].svc_paid_processed, 0);
  await worker.tick(); assert.equal(store.snapshot().settlements.length, 1);
  await worker.stop();
  assert.deepEqual(await CS.queuePaid(source, { id: "o", depositPaidAt: at }), { skipped: true });
  assert.deepEqual(await CS.onPaid(source, { id: "o", depositPaidAt: at }), { skipped: true });
});

test("disabled refund closes only the explicitly claimed order and does not restore or replay any payment attribution", async t => {
  disabled(t);
  const store = createSvcMemoryStore(admittedState()), source = { list: rejectAccess, get: rejectAccess, update: rejectAccess };
  CS.serviceFor(source, { store, clock: () => at });
  const before = store.snapshot();
  assert.deepEqual(await CS.onRefund(source, { orderNo: "UNCLAIMED" }), { skipped: true }); assert.deepEqual(store.snapshot(), before);
  const result = await CS.onRefund(source, { orderNo: "MANUAL" }); assert.equal(result.service_status, "refunded");
  let state = store.snapshot(); assert.equal(state.ledger[0].status, "void"); assert.equal(state.ledger[0].zero_reason, "refund");
  assert.equal(state.orders[0].svc_paid_processed, 0); assert.deepEqual(state.events, []); assert.deepEqual(state.reserves, []);
  assert.equal(state.orders[1].service_status, "new");
  const refunded = structuredClone(state); assert.deepEqual(await CS.onRefund(source, { order_no: "MANUAL" }), { duplicate: true });
  assert.deepEqual(store.snapshot(), refunded);
});
