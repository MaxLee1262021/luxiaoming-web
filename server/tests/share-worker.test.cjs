"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createShareWorker, SCHEDULES, latestSlot } = require("../lib/shareWorker.cjs");
const { serviceFor } = require("../lib/merchantShare.cjs");
const { fixture, merchant } = require("./fixtures/shareSql.cjs");

function setup(overrides = {}) {
  const acked = []; const failed = []; const processed = []; const logs = [];
  const projectedOrders = new Map();
  const source = { list: async () => [], transaction: async work => work({ query: async () => [[]] }),
    get: async (_, id) => projectedOrders.get(id) || { id }, update: async (_, id, patch) => { const value = { id, ...patch }; projectedOrders.set(id, value); return value; } };
  const store = { listDueJobs: async () => [], processJob: async id => { processed.push(id); }, listMerchants: async () => [], listOutbox: async () => [],
    refreshPendingBatch: async () => ({ refreshed: 0, failed: 0, finished: true }), reviewPostedFacts: async () => ({ reviewed: 0, flagged: 0 }),
    getEffectiveAttribution: async orderId => ({ state: { orderId, splitType: "T1", sourceReason: "NONE" }, revisionNo: 0 }),
    claimScheduledSlot: async () => ({ claimed: false }), listRefundOrderIds: async () => [], reconcileRefundReversals: async () => ({ repairedAmount: "0.00", overdue: false }),
    acknowledgeOutbox: async id => { acked.push(id); }, failOutbox: async id => { failed.push(id); }, ...overrides };
  const service = { settings: () => ({ enabled: true, enableAt: "2026-11-01T00:00:00Z" }), store };
  const logger = { error: (...input) => logs.push(input), warn: (...input) => logs.push(input) };
  return { source, store, service, acked, failed, processed, logs, options: { service, logger, env: { NODE_ENV: "test" }, clock: () => new Date("2026-11-06T00:00:00Z") } };
}

test("worker acknowledges ordinary accounting outbox events without external notifications", async () => {
  const f = setup({ listOutbox: async () => ["SHARE_PAYMENT_QUEUED", "SHARE_SNAPSHOT_CREATED", "SHARE_REFUND_RECORDED"].map((eventType, i) => ({ id: String(i), eventType, payloadJson: { orderId: "o", refundNo: "r" } })) });
  let calls = 0; const worker = createShareWorker(f.source, { ...f.options, fetch: async () => { calls++; throw new Error("no normal-event network call"); } });
  const result = await worker.tick();
  assert.equal(result.events, 3); assert.deepEqual(f.acked, ["0", "1", "2"]); assert.deepEqual(f.failed, []); assert.equal(calls, 0);
});

test("unconfigured alert channels never acknowledge critical delivery as successful", async () => {
  const f = setup({ listOutbox: async () => [{ id: "critical", eventType: "SHARE_JOB_FAILED", payloadJson: { priority: "P0", orderId: "o" } }] });
  await createShareWorker(f.source, f.options).tick();
  assert.deepEqual(f.acked, []); assert.deepEqual(f.failed, ["critical"]);
  assert.ok(f.logs.some(row => row[1].errorCode === "SHARE_ALERT_NOT_CONFIGURED"));
});

test("critical alerts select phone channel and acknowledge only successful HTTP delivery", async () => {
  const f = setup({ listOutbox: async () => [{ id: "critical", eventType: "SHARE_JOB_FAILED", payloadJson: { priority: "P0", orderId: "o" } }] });
  let requested;
  await createShareWorker(f.source, { ...f.options, env: { NODE_ENV: "test", SHARE_PHONE_ALERT_URL: "https://phone.example.test/alerts", SHARE_ALERT_WEBHOOK_URL: "https://message.example.test/alerts" },
    fetch: async (url, options) => { requested = { url: String(url), options }; return { ok: true }; } }).tick();
  assert.equal(requested.url, "https://phone.example.test/alerts"); assert.equal(requested.options.headers["Idempotency-Key"], "critical");
  assert.deepEqual(f.acked, ["critical"]);
});

test("one failed job cannot prevent later due jobs and overlapping ticks cannot run twice", async () => {
  let entered; let release; const waiting = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const f = setup({ listDueJobs: async () => [{ orderId: "bad" }, { orderId: "good" }], processJob: async id => {
    f.processed.push(id); if (id === "bad") { entered(); await gate; throw Object.assign(new Error("storage"), { code: "SHARE_5001" }); }
  } });
  const worker = createShareWorker(f.source, f.options); const first = worker.tick(); await waiting;
  assert.deepEqual(await worker.tick(), { skipped: true }); release(); await first;
  assert.deepEqual(f.processed, ["bad", "good"]);
  assert.ok(f.logs.some(row => row[0] === "share.job.failed"));
});

test("recovery enqueues earlier payment facts first and skips manual final payments", async () => {
  const captured = []; const f = setup();
  f.source.list = async key => key === "orders" ? [
    { id: "late", openid: "u", finalPaidAt: "2026-11-04T00:00:00Z", finalPaid: "10.00", paymentRecords: [{ phase: "final", status: "confirmed", provider: "wechat_pay" }] },
    { id: "manual", openid: "u", finalPaidAt: "2026-11-02T00:00:00Z", finalPaid: "10.00", paymentRecords: [{ phase: "final", status: "confirmed", provider: "manual" }] },
    { id: "early", openid: "u", finalPaidAt: "2026-11-03T00:00:00Z", finalPaid: "10.00", paymentRecords: [{ phase: "final", status: "confirmed", provider: "wechat_pay" }] },
  ] : [];
  serviceFor(f.source, { store: { enqueuePayment: async input => captured.push(input.orderId) }, enableAt: "2026-11-01T00:00:00Z" });
  await createShareWorker(f.source, f.options).recover({ full: true });
  assert.deepEqual(captured, ["early", "late"]);
});

test("the four named schedules use exact Shanghai clock boundaries", () => {
  const byName = Object.fromEntries(SCHEDULES.map(schedule => [schedule.name, schedule]));
  assert.equal(SCHEDULES.length, 4);
  assert.equal(latestSlot(byName.DAILY_METRICS, "2026-11-06T17:14:59Z"), "2026-11-05T17:15:00.000Z");
  assert.equal(latestSlot(byName.DAILY_METRICS, "2026-11-06T17:15:00Z"), "2026-11-06T17:15:00.000Z");
  assert.equal(latestSlot(byName.PAYMENT_GAP_COMPENSATION, "2026-11-06T19:29:59Z"), "2026-11-05T19:30:00.000Z");
  assert.equal(latestSlot(byName.PAYMENT_GAP_COMPENSATION, "2026-11-06T19:30:00Z"), "2026-11-06T19:30:00.000Z");
  assert.equal(latestSlot(byName.UNCONFIGURED_MERCHANTS, "2026-11-07T00:59:59Z"), "2026-11-06T01:00:00.000Z");
  assert.equal(latestSlot(byName.UNCONFIGURED_MERCHANTS, "2026-11-07T01:00:00Z"), "2026-11-07T01:00:00.000Z");
  assert.equal(latestSlot(byName.REFUND_REVERSAL_SCAN, "2026-11-07T00:59:59Z"), "2026-11-07T00:00:00.000Z");
});

test("minute recovery reads only durable pending markers instead of scanning all historical orders", async () => {
  const captured = []; const f = setup();
  f.source.transaction = async work => work({ query: async sql => {
    assert.match(sql, /lxm_collection_values/); assert.match(sql, /shareEnqueuePending/);
    return [[{ record_id: "pending" }]];
  } });
  f.source.get = async (_, id) => ({ id, openid: "u", shareEnqueuePending: true, finalPaidAt: "2026-11-03T00:00:00Z", finalPaid: "10.00", paymentRecords: [{ phase: "final", status: "confirmed", provider: "wechat_pay" }] });
  f.source.list = async key => { throw new Error("minute recovery must not scan collection " + key); };
  f.source.update = async (_, id, patch) => { assert.equal(id, "pending"); assert.equal(patch.shareEnqueuePending, false); };
  serviceFor(f.source, { store: { enqueuePayment: async input => captured.push(input.orderId) }, enableAt: "2026-11-01T00:00:00Z" });
  assert.equal((await createShareWorker(f.source, f.options).recover()).failed, 0);
  assert.deepEqual(captured, ["pending"]);
});

test("each named task runs in its own slot and a restarted worker cannot repeat completed slots", async () => {
  const f = setup(); let now = "2026-11-06T17:14:00Z";
  const cursors = new Map(); const completed = []; const emitted = []; const metricResults = [];
  f.source.transaction = async work => work({ query: async (_, values) => { if (values && values.length === 8) emitted.push(values[1]); return [[]]; } });
  f.source.list = async () => [];
  Object.assign(f.store, {
    claimScheduledSlot: async input => {
      if (cursors.get(input.name) === input.slotAt) return { claimed: false };
      cursors.set(input.name, input.slotAt); return { ...input, claimed: true, leaseToken: input.name, skippedSlots: 0 };
    },
    completeScheduledSlot: async input => { completed.push(input.name); return true; },
    failScheduledSlot: async input => { throw new Error("unexpected failed schedule " + input.name); },
    renewScheduledSlot: async () => true,
    readOperationalFacts: async () => ({ job: [], snapshot: [], detail: [], refund: [], observation: [], click: [] }),
    recordRisk: async () => {}, saveMetricSnapshot: async input => { metricResults.push(input); },
    listMerchants: async () => [{ merchantId: "m", unconfigured: true }],
  });
  f.service.settings = () => ({ enabled: true, enableAt: "2026-11-06T16:00:00Z" });
  const options = { ...f.options, clock: () => new Date(now) };
  const worker = createShareWorker(f.source, options);
  await worker.schedules(new Date(now)); assert.deepEqual(completed, ["REFUND_REVERSAL_SCAN"]);
  now = "2026-11-06T17:15:00Z"; await worker.schedules(new Date(now)); assert.equal(completed.at(-1), "DAILY_METRICS");
  assert.equal(emitted.includes("UNCONFIGURED_MERCHANTS"), false, "01:15 metrics cannot impersonate 09:00 operations reminder");
  now = "2026-11-06T19:29:59Z"; await worker.schedules(new Date(now)); assert.equal(completed.includes("PAYMENT_GAP_COMPENSATION"), false);
  now = "2026-11-06T19:30:00Z"; await worker.schedules(new Date(now)); assert.ok(completed.includes("PAYMENT_GAP_COMPENSATION"));
  now = "2026-11-07T00:59:59Z"; await worker.schedules(new Date(now)); assert.equal(emitted.includes("UNCONFIGURED_MERCHANTS"), false);
  now = "2026-11-07T01:00:00Z"; await worker.schedules(new Date(now)); assert.equal(emitted.filter(type => type === "UNCONFIGURED_MERCHANTS").length, 1);
  const beforeRestart = completed.length;
  await createShareWorker(f.source, options).schedules(new Date(now)); assert.equal(completed.length, beforeRestart);
  assert.equal(metricResults.length, 1); assert.equal(metricResults[0].date, "2026-11-06");
});

test("daily metrics persist A1/A2 freezes, A3 spikes, A5 nonblocking risk and actual technical observations", async () => {
  const f = setup(); const events = []; const risks = []; let saved;
  f.source.transaction = async work => work({ query: async (_, values) => { events.push({ type: values[1], payload: JSON.parse(values[2]) }); return [{ affectedRows: 1 }]; } });
  f.source.list = async key => key === "orders" ? ["o0", "o1", "not-enqueued"].map(id => ({ id, finalPaidAt: "2026-11-06T03:00:00Z", paymentRecords: [{ phase: "final", status: "confirmed", provider: "wechat_pay" }] })) : [];
  const jobs = Array.from({ length: 22 }, (_, i) => ({ orderId: "o" + i, userId: i < 21 ? "risk-user" : "another", payTime: "2026-11-06T03:00:00Z", availableAt: "2026-11-06T03:00:00Z", status: "DONE", paidTotal: "100.00",
    decisionJson: { splitType: i < 21 ? "T1" : "T2", ratio: "0.0500", hitMerchantId: "m", sourceFlag: i < 6 ? "cs_link_missing" : "", candidateJson: { truncated: i === 21 } } }));
  const facts = { job: jobs, snapshot: [{ orderId: "o0", splitAmount: "150.00", paidTotal: "100.00", baseAmount: "100.00" }, { orderId: "o0", splitAmount: "5.00", paidTotal: "100.00", baseAmount: "100.00" }],
    detail: [{ merchantId: "m", createdAt: "2026-11-06T03:00:00Z", amount: "400.00" }, { merchantId: "m", createdAt: "2026-11-05T03:00:00Z", amount: "100.00" }], refund: [],
    observation: [{ metricKey: "SCENE_PARSE", success: 0, occurredAt: "2026-11-06T03:00:00Z" }, { metricKey: "SCENE_PARSE", success: 1, occurredAt: "2026-11-06T03:00:00Z" }, { metricKey: "SCENE_PARSE", success: 1, occurredAt: "2026-11-06T03:00:00Z" },
      { metricKey: "JUDGE_DURATION_MS", valueNumber: "10", occurredAt: "2026-11-06T03:00:00Z" }, { metricKey: "JUDGE_DURATION_MS", valueNumber: "80", occurredAt: "2026-11-06T03:00:00Z" }],
    click: [{ staffId: null, clickAt: "2026-11-06T03:00:00Z" }, { staffId: "service", clickAt: "2026-11-06T03:00:00Z" }] };
  Object.assign(f.store, { readOperationalFacts: async () => facts, recordRisk: async input => risks.push(input), saveMetricSnapshot: async input => { saved = input; },
    listRefundOrderIds: async () => ["gap"], reconcileRefundReversals: async () => ({ repairedAmount: "1.00", overdue: true }) });
  const result = await createShareWorker(f.source, { ...f.options, clock: () => new Date("2026-11-06T17:15:00Z") }).metrics({ slotAt: "2026-11-06T17:15:00Z" });
  assert.equal(saved.date, "2026-11-06"); assert.equal(result.sceneFailureRate, 1 / 3); assert.equal(result.judgeP99Ms, 80);
  assert.equal(result.coverage, 1 / 22); assert.equal(result.queueCoverage, 2 / 3); assert.equal(result.candidateTruncated, 1); assert.equal(result.refundRepairs.overdue, 1);
  for (const type of ["SPLIT_OVER_BASE", "DUPLICATE_SNAPSHOT", "MERCHANT_SPIKE", "USER_FREQUENT_ORDERS", "SHARE_COVERAGE_LOW", "SHARE_SCENE_FAILURES", "SHARE_CS_LINK_MISSING", "SHARE_CANDIDATE_TRUNCATED", "SHARE_ENGINE_HEALTH"]) assert.ok(events.some(event => event.type === type), type);
  assert.equal(risks.filter(risk => risk.entityType === "ORDER").length, 2);
  assert.ok(risks.filter(risk => risk.entityType === "ORDER").every(risk => risk.payload.freezeSettlement));
  assert.equal(risks.find(risk => risk.entityType === "USER").payload.automaticBlock, false);
  assert.equal(JSON.stringify(events).includes("risk-user"), false, "external notifications receive a stable hash rather than user identifiers");
});

test("a partially failed metrics slot retries and persists its successful result instead of caching failure", async () => {
  const f = setup(); let now = "2026-11-06T17:15:00Z"; let failOnce = true; let failedSlots = 0; let completedSlots = 0; const saved = [];
  Object.assign(f.store, {
    claimScheduledSlot: async input => input.name === "DAILY_METRICS" && !completedSlots ? { ...input, claimed: true, leaseToken: "attempt-" + failedSlots } : { claimed: false },
    failScheduledSlot: async () => { failedSlots++; return true; }, completeScheduledSlot: async () => { completedSlots++; return true; }, renewScheduledSlot: async () => true,
    readOperationalFacts: async () => ({ job: [], snapshot: [], detail: [], refund: [], observation: [], click: [] }),
    listRefundOrderIds: async () => ["refund-gap"],
    reconcileRefundReversals: async () => { if (failOnce) { failOnce = false; throw new Error("temporary refund store outage"); } return { repairedAmount: "1.00", overdue: false }; },
    saveMetricSnapshot: async input => { saved.push(input); },
  });
  const worker = createShareWorker(f.source, { ...f.options, clock: () => new Date(now) });
  await worker.schedules(new Date(now));
  assert.equal(failedSlots, 1); assert.equal(saved.length, 0); assert.equal(completedSlots, 0);
  now = "2026-11-06T17:16:00Z"; await worker.schedules(new Date(now));
  assert.equal(completedSlots, 1); assert.equal(saved.length, 1); assert.equal(saved[0].metrics.refundRepairs.failed, 0);
  assert.equal(saved[0].metrics.refundRepairs.repaired, 1);
});

test("minute refresh drains multiple keyset pages instead of repeatedly refreshing the first hundred", async () => {
  const pages = [100, 100, 5]; let index = 0;
  const f = setup({ refreshPendingBatch: async input => { assert.equal(input.limit, 100); const count = pages[index++]; return { refreshed: count, failed: 0, finished: index === 3 }; } });
  const summary = await createShareWorker(f.source, f.options).refreshPending();
  assert.equal(summary.refreshed, 205); assert.equal(summary.pages, 3); assert.equal(summary.finished, true);
});

test("posted source projection uses the latest revision and is persisted before the snapshot outbox is acknowledged", async () => {
  const trace = []; let order = { id: "o", shareAttributionRevision: 1 };
  const f = setup({ getEffectiveAttribution: async () => ({ revisionNo: 2, state: { splitType: "T2", staffId: "service", csClickId: "click", sourceReason: "CS_LINK" } }),
    listOutbox: async () => [{ id: "posted", eventType: "SHARE_SNAPSHOT_CREATED", payloadJson: { orderId: "o" } }],
    acknowledgeOutbox: async id => { trace.push("ack:" + id); } });
  f.source.get = async () => order;
  f.source.compareAndUpdate = async (_, id, expected, patch) => { assert.equal(expected.shareAttributionRevision, 1); trace.push("save:" + id); order = { ...order, ...patch }; return order; };
  await createShareWorker(f.source, f.options).tick();
  assert.deepEqual(trace, ["save:o", "ack:posted"]); assert.equal(order.shareOrderSource, "SERVICE"); assert.equal(order.shareServiceStaffId, "service"); assert.equal(order.shareAttributionRevision, 2);
});

test("source projection storage failure keeps its outbox retryable and a stale event cannot overwrite a newer revision", async () => {
  const f = setup({ listOutbox: async () => [{ id: "posted", eventType: "SHARE_SNAPSHOT_CREATED", payloadJson: { orderId: "o" } }] });
  delete f.source.update;
  await createShareWorker(f.source, f.options).tick();
  assert.deepEqual(f.acked, []); assert.deepEqual(f.failed, ["posted"]);
  f.source.get = async () => ({ id: "o", shareAttributionRevision: 3, shareOrderSource: "SERVICE" });
  await createShareWorker(f.source, f.options).tick();
  assert.deepEqual(f.acked, ["posted"], "already-newer projection is safe to acknowledge without regressing it");
});

test("queued payment and refund facts request historical review without finalizing source fields", async () => {
  const reviewed = []; const f = setup({ reviewPostedFacts: async input => { reviewed.push(input); }, listOutbox: async () => [
    { id: "payment", eventType: "SHARE_PAYMENT_QUEUED", payloadJson: { orderId: "new-paid" } },
    { id: "refund", eventType: "SHARE_REFUND_RECORDED", payloadJson: { orderId: "old-paid", refundNo: "r" } },
  ] });
  f.source.update = async () => { throw new Error("provisional decisions cannot finalize an order source"); };
  await createShareWorker(f.source, f.options).tick();
  assert.deepEqual(reviewed.map(input => [input.orderId, input.refundNo]), [["new-paid", undefined], ["old-paid", "r"]]);
  assert.deepEqual(f.acked, ["payment", "refund"]);
});

test("city and dispute monitoring stay unknown without samples; trusted observations trigger city and scan-drop warnings", async () => {
  const f = fixture(); const store = f.newStore(); await store.ensureSchema(); await store.onboardMerchant(merchant());
  f.source.list = async () => [];
  for (let index = 0; index < 70; index++) f.tables().scan.push({ id: String(1000 + index), user_id: "historical-" + index, merchant_id: "m1", qr_id: "qr-m1", scene: "c=m1", scan_at: "2026-11-06 03:00:00.000" });
  let now = "2026-11-06T17:15:00Z"; f.setTime(now);
  const worker = createShareWorker(f.source, { service: { settings: () => ({ enabled: true, enableAt: "2026-11-01T00:00:00Z" }), store }, clock: () => new Date(now), env: { NODE_ENV: "test" } });
  const absent = await worker.metrics({ slotAt: now });
  assert.equal(absent.cityMonitoringAvailable, false); assert.equal(absent.crossCityQrCount, null); assert.equal(absent.disputeRate, null);
  assert.equal(f.tables().outbox.some(row => row.event_type === "SHARE_QR_CROSS_CITY"), false);
  f.setTime("2026-11-07T03:00:00Z");
  await store.recordObservation({ metricKey: "SCAN_CITY", subjectId: "qr-m1", valueText: "CITY_A" });
  await store.recordObservation({ metricKey: "SCAN_CITY", subjectId: "qr-m1", valueText: "CITY_B" });
  await store.recordObservation({ metricKey: "ATTRIBUTION_DISPUTE", subjectId: "disputed-order" });
  now = "2026-11-07T17:15:00Z"; f.setTime(now);
  const observed = await worker.metrics({ slotAt: now });
  assert.equal(observed.cityMonitoringAvailable, true); assert.equal(observed.crossCityQrCount, 1); assert.equal(observed.scanDropQrCount, 1);
  assert.equal(observed.disputeMonitoringAvailable, true); assert.equal(observed.disputedOrders, 1);
  for (const type of ["SHARE_QR_CROSS_CITY", "SHARE_QR_SCAN_DROP"]) assert.ok(f.tables().outbox.some(row => row.event_type === type));
  assert.ok(f.tables().observation.some(row => row.value_text === "CITY_A"));
  assert.throws(() => store.recordObservation({ metricKey: "SCAN_CITY", valueText: "x".repeat(256) }), { code: "SHARE_4001" });
});

test("stop clears future ticks immediately and awaits an in-flight tick before allowing database shutdown", async () => {
  let entered; let release; const arrived = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const f = setup({ listDueJobs: async () => [{ orderId: "inflight" }], processJob: async () => { entered(); await gate; } });
  const worker = createShareWorker(f.source, f.options); worker.start(); const tick = worker.tick(); await arrived;
  let stopped = false; const drained = worker.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  assert.equal((await worker.tick()).reason, "SHARE_WORKER_STOPPED");
  release(); await tick; await drained; assert.equal(stopped, true);
});

test("stop also drains a directly running scheduled task before returning", async () => {
  let entered; let release; const arrived = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const f = setup(); let completed = false;
  f.source.list = async key => { if (key === "orders") { entered(); await gate; } return []; };
  f.store.claimScheduledSlot = async input => input.name === "PAYMENT_GAP_COMPENSATION" ? { ...input, claimed: true, leaseToken: "direct-schedule" } : { claimed: false };
  f.store.completeScheduledSlot = async () => { completed = true; return true; };
  f.store.failScheduledSlot = async () => { throw new Error("schedule should complete while draining"); };
  const worker = createShareWorker(f.source, f.options); const scheduled = worker.schedules(f.options.clock()); await arrived;
  let stopped = false; const stop = worker.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  release(); await scheduled; await stop; assert.equal(completed, true); assert.equal(stopped, true);
});

test("historical metric catchup repairs cash at execution time and never backdates a reversal into the old month", async () => {
  const f = setup(); let repairedAt;
  f.service.settings = () => ({ enabled: true, enableAt: "2026-10-01T00:00:00Z" });
  Object.assign(f.store, { readOperationalFacts: async () => ({ job: [], snapshot: [], detail: [], refund: [], observation: [], click: [] }),
    listRefundOrderIds: async () => ["o"], reconcileRefundReversals: async (_, input) => { repairedAt = input.now; return { repairedAmount: "0.00", overdue: false }; }, saveMetricSnapshot: async () => {} });
  const clock = () => new Date("2026-10-31T16:30:00Z");
  await createShareWorker(f.source, { ...f.options, clock }).metrics({ slotAt: "2026-10-30T17:15:00Z" });
  assert.equal(new Date(repairedAt).toISOString(), clock().toISOString());
  assert.equal(require("../lib/shareEngine.cjs").periodAt(repairedAt), "2026-11");
});

test("a long pending refresh crossing midnight uses a fresh execution clock for mature postings", async () => {
  const f = setup(); let now = "2026-10-31T15:59:59Z", processedAt;
  f.service.settings = () => ({ enabled: true, enableAt: "2026-10-01T00:00:00Z" });
  f.store.refreshPendingBatch = async () => { now = "2026-10-31T16:00:01Z"; return { refreshed: 1, failed: 0, finished: true }; };
  f.store.listDueJobs = async () => [{ orderId: "mature" }];
  f.store.processJob = async (_, input) => { processedAt = input.now; };
  const result = await createShareWorker(f.source, { ...f.options, clock: () => new Date(now) }).tick();
  assert.equal(require("../lib/shareEngine.cjs").periodAt(processedAt), "2026-11"); assert.equal(result.period, "2026-11");
});
