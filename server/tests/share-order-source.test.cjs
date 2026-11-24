"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, merchant } = require("./fixtures/shareSql.cjs");

const orderSource = { merchantId: "m1", qrId: "qr-m1", scene: "c=m1", at: "2026-11-01T01:00:00.000Z" };
const payment = { orderId: "bound-order", userId: "u", paidTotal: "500.00", payTime: "2026-11-01T03:00:00Z", provider: "wechat_pay", orderSource };

async function ready() {
  const f = fixture(), store = f.newStore();
  await store.ensureSchema();
  await store.onboardMerchant(merchant("m1"));
  await store.onboardMerchant(merchant("m2"));
  return { f, store };
}

test("a verified order merchant earns T1 without creating a scan or a global binding", async () => {
  const { f, store } = await ready();
  f.setTime(payment.payTime);
  const result = await store.enqueuePayment(payment);
  assert.equal(result.decision.hitMerchantId, "m1");
  assert.equal(result.decision.hitReason, "ORDER_SOURCE");
  assert.equal(result.decision.ratio, "0.0500");
  assert.deepEqual(result.decision.orderSource, orderSource);
  assert.deepEqual((await store.getJob(payment.orderId)).decisionJson.candidateJson.orderSource, orderSource);
  for (const key of ["scan", "binding", "binding_event", "detail", "snapshot"]) assert.equal(f.tables()[key].length, 0, key);
  assert.equal((await store.processJob(payment.orderId)).pending, true);
  assert.equal((await store.getMerchantStats("m1")).totalAmount, "0.00", "the accounting window still protects the ledger");
});

test("latest scan wins over checkout; later changes preserve payment-time attribution and idempotent refunds", async () => {
  const { f, store } = await ready();
  f.setTime("2026-11-01T02:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m2" });
  f.setTime("2026-11-01T02:00:00Z");
  f.setTime(payment.payTime);
  const first = await store.enqueuePayment(payment);
  assert.equal(first.decision.hitMerchantId, "m2", "latest scanned merchant replaces checkout ownership");
  f.setTime("2026-11-01T04:00:00Z");
  await store.rotateQr({ merchantId: "m1", id: "replacement-qr", scene: "c=replaced", imageUrl: "https://example.test/qr.png", reason: "更换测试码", operatorId: "super", requestId: "rotate-source-qr" });
  await store.saveRule({ ...merchant("m1"), ratioT1: "0.1000", refundWindowDays: 9, expectedVersion: 1 });
  await store.upsertMerchant({ merchantId: "m1", status: "CLOSED" });
  await store.recordRefund({ orderId: payment.orderId, refundNo: "before-maturity", amount: "100.00" });
  const restarted = f.newStore();
  await restarted.refreshPendingBatch({ limit: 100 });
  const refreshed = await restarted.getJob(payment.orderId);
  assert.equal(refreshed.decisionJson.hitMerchantId, "m2");
  assert.equal(refreshed.decisionJson.ratio, "0.0500", "payment-time rule is retained");
  assert.equal(refreshed.availableAt, "2026-11-04T03:00:00.000Z");
  assert.deepEqual(refreshed.decisionJson.orderSource, orderSource);
  f.setTime("2026-11-04T03:00:00Z");
  const outcomes = await Promise.all([restarted.processJob(payment.orderId), restarted.processJob(payment.orderId)]);
  assert.equal(outcomes.filter(result => !result.existed).length, 1);
  const snapshot = await restarted.getSnapshot(payment.orderId);
  assert.equal(snapshot.hitMerchantId, "m2"); assert.equal(snapshot.splitAmount, "20.00");
  assert.equal(snapshot.baseAmount, "400.00"); assert.equal(snapshot.engineVersion, "2.0.0");
  assert.deepEqual(snapshot.candidateJson.orderSource, orderSource);
  assert.equal((await restarted.listDetails({ merchantId: "m1" })).total, 0);
  assert.equal((await restarted.listDetails({ merchantId: "m2" })).sum.netAmount, "20.00");
  const correction = await restarted.correctSnapshot(payment.orderId, { reason: "核验冻结的订单来源", requestId: "source-correction", operatorId: "super" });
  assert.equal(correction.changed, false); assert.equal(correction.state.hitMerchantId, "m2");
  assert.deepEqual(correction.state.orderSource, orderSource);
  const refund = { orderId: payment.orderId, refundNo: "after-maturity", amount: "400.00" };
  await Promise.all([restarted.recordRefund(refund), restarted.recordRefund(refund)]);
  const ledger = await restarted.listDetails({ merchantId: "m2", all: true });
  assert.equal(ledger.sum.netAmount, "0.00");
  assert.equal(ledger.list.filter(detail => detail.direction === 1).length, 1);
  assert.equal(ledger.list.filter(detail => detail.direction === 2).length, 1);
  assert.deepEqual(await restarted.getSnapshot(payment.orderId), snapshot, "refunds and explicit review preserve the immutable original snapshot");
});

test("a checkout merchant closed before payment cannot hand its order to another binding or become eligible after reopening", async () => {
  const { f, store } = await ready();
  f.setTime("2026-11-01T01:30:00Z"); await store.upsertMerchant({ merchantId: "m1", status: "CLOSED" });
  f.setTime(payment.payTime);
  const queued = await store.enqueuePayment(payment);
  assert.equal(queued.decision.hitMerchantId, "0");
  assert.equal(queued.decision.hitReason, "ORDER_SOURCE_INVALIDATED");
  f.setTime("2026-11-02T00:00:00Z"); await store.upsertMerchant({ merchantId: "m1", status: "OPEN" });
  await f.newStore().refreshPendingBatch({ limit: 100 });
  assert.equal((await store.getJob(payment.orderId)).decisionJson.hitMerchantId, "0");
  f.setTime("2026-11-04T03:00:00Z"); await store.processJob(payment.orderId);
  assert.equal((await store.getSnapshot(payment.orderId)).splitAmount, "0.00");
  assert.equal((await store.listDetails()).total, 0);
});

test("payment retries preserve source evidence and reject a changed merchant, QR, scene or checkout time", async () => {
  const { f, store } = await ready(); f.setTime(payment.payTime);
  const original = await store.enqueuePayment(payment);
  const reordered = { at: "2026-11-01T09:00:00+08:00", scene: "c=m1", qrId: "qr-m1", merchantId: "m1" };
  assert.equal((await f.newStore().enqueuePayment({ ...payment, orderSource: reordered })).existed, true);
  assert.equal((await store.enqueuePayment({ ...payment, orderSource: undefined })).existed, true);
  for (const change of [{ merchantId: "m2" }, { qrId: "qr-m2" }, { scene: "c=m2" }, { at: "2026-11-01T01:00:01Z" }]) {
    await assert.rejects(store.enqueuePayment({ ...payment, orderSource: { ...orderSource, ...change } }), { code: "SHARE_4090" });
  }
  assert.deepEqual((await store.getJob(payment.orderId)).decisionJson, original.decision);
  assert.equal(f.tables().job.length, 1);
});

test("an existing job without source evidence is not silently backfilled or rewritten by a retry", async () => {
  const { f, store } = await ready(); f.setTime(payment.payTime);
  const old = await store.enqueuePayment({ ...payment, orderSource: undefined });
  assert.equal(old.decision.hitMerchantId, "0");
  const retry = await store.enqueuePayment(payment);
  assert.equal(retry.existed, true); assert.equal(retry.decision.hitMerchantId, "0");
  assert.equal(retry.decision.orderSource, undefined);
  assert.equal((await store.getJob(payment.orderId)).decisionJson.orderSource, undefined);
});

test("future order source evidence fails before persisting any accounting job", async () => {
  const { f, store } = await ready(); f.setTime(payment.payTime);
  await assert.rejects(store.enqueuePayment({ ...payment, orderSource: { ...orderSource, at: "2026-11-01T03:00:01Z" } }), { code: "SHARE_4001" });
  assert.equal(f.tables().job.length, 0); assert.equal(f.tables().detail.length, 0);
});

test("closing and reopening a merchant requires fresh order evidence rather than reviving an earlier checkout", async () => {
  const { f, store } = await ready();
  f.setTime("2026-11-01T01:30:00Z"); await store.upsertMerchant({ merchantId: "m1", status: "CLOSED" });
  f.setTime("2026-11-01T02:00:00Z"); await store.upsertMerchant({ merchantId: "m1", status: "OPEN" });
  f.setTime(payment.payTime);
  const old = await store.enqueuePayment(payment);
  assert.equal(old.decision.hitMerchantId, "0"); assert.equal(old.decision.hitReason, "ORDER_SOURCE_INVALIDATED");
  assert.equal(old.decision.orderSourceInvalidated, true);
  const newer = await store.enqueuePayment({ ...payment, orderId: "after-reopen", orderSource: { ...orderSource, at: "2026-11-01T02:30:00Z" } });
  assert.equal(newer.decision.hitMerchantId, "m1");
  await f.newStore().refreshPendingBatch({ limit: 100 });
  assert.equal((await store.getJob(payment.orderId)).decisionJson.hitReason, "ORDER_SOURCE_INVALIDATED");
  f.setTime("2026-11-04T03:00:00Z"); await store.processJob(payment.orderId);
  assert.equal((await store.getSnapshot(payment.orderId)).splitAmount, "0.00");
});

test("user invalidation without any binding invalidates earlier checkout evidence but permits a later verified checkout", async () => {
  const { f, store } = await ready();
  f.setTime("2026-11-01T01:30:00Z");
  const invalidated = await store.invalidateUser("u", { requestId: "invalidate-source-user", operatorId: "super", reason: "测试注销" });
  assert.equal(invalidated.bindingsInvalidated, 0);
  f.setTime(payment.payTime);
  const queued = await store.enqueuePayment(payment);
  assert.equal(queued.decision.hitMerchantId, "0"); assert.equal(queued.decision.hitReason, "ORDER_SOURCE_INVALIDATED");
  const newer = await store.enqueuePayment({ ...payment, orderId: "fresh-source-after-user-event", orderSource: { ...orderSource, at: "2026-11-01T02:30:00Z" } });
  assert.equal(newer.decision.hitMerchantId, "m1");
  await f.newStore().refreshPendingBatch({ limit: 100 });
  assert.equal((await store.getJob(payment.orderId)).decisionJson.orderSourceInvalidated, true);
});
