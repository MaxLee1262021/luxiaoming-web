"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createSource = require("./fixtures/jsonSource.cjs");
const { fixture: sqlFixture, merchant } = require("./fixtures/shareSql.cjs");
const { serviceFor, qrScene, enqueuePaidOrder } = require("../lib/merchantShare.cjs");
const { orderSourceEvidence } = require("../lib/merchantOrderEvidence.cjs");
const { confirmTestPayment } = require("./helpers/wechatPay.cjs");
const { drainMerchantShare } = require("../lib/wechatPay.cjs");
const rpc = require("../lib/rpc.cjs");
const identity = { identity: { kind: "public", openid: "synthetic-customer" } };
const scene = qrScene("0123456789ABCD");

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-origin-commission-"));
  const source = createSource({ jsonFile: path.join(dir, "db.json") });
  t.after(async () => { await drainMerchantShare(source); fs.rmSync(dir, { recursive: true, force: true }); });
  const sql = sqlFixture(), store = sql.newStore();
  await store.ensureSchema();
  await store.onboardMerchant(merchant("m1", { ratioT1: "0.1000", qr: { id: "qr-m1", scene, imageUrl: "data:image/png;base64,iVBORw0KGgo=" } }));
  await source.create("shops", { id: "m1", name: "合成门店" });
  await source.create("siteConfig", { id: "global", bookingNotice: ["合成预约须知"], bookingNoticeVersion: "v1" });
  await source.create("packages", { id: "pkg", name: "合成套餐", price: 100, depositRatio: 30, status: "已上架" });
  sql.setTime(new Date().toISOString());
  const service = serviceFor(source, { store, enableAt: "2026-11-01T00:00:00Z" });
  return { source, sql, store, service };
}

test("merchant QR booking survives online deposit/final receipts and produces one merchant ledger entry after the refund window without scan delivery", async (t) => {
  const { source, sql, store, service } = await fixture(t);
  const booking = await rpc(source, "createBooking", { data: {
    scene, name: "合成客户", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午",
    agreement: { version: "v1", current: true }, items: [{ packageId: "pkg" }], idempotencyKey: "origin-booking-0001",
  } }, identity);
  assert.equal(booking.success, true, JSON.stringify(booking));
  const deposit = await confirmTestPayment(source, { data: { bookingId: booking.bookingId, phase: "deposit", idempotencyKey: "origin-deposit-0001" } }, identity);
  assert.equal(deposit.success, true, JSON.stringify(deposit));
  const orderId = deposit.data.orderId;
  assert.equal(await store.getJob(orderId), null, "deposit alone does not generate commission");
  await source.update("orders", orderId, { status: "final_pending", workflowStage: "awaiting_final_payment", shootingCompletedAt: new Date().toISOString() });
  const final = await confirmTestPayment(source, { data: { orderId, phase: "final", selectionAccepted: true, idempotencyKey: "origin-final-0001" } }, identity);
  assert.equal(final.success, true, JSON.stringify(final));
  const delivered = await drainMerchantShare(source);
  assert.equal(delivered.some(result => result.failed), false, JSON.stringify(delivered));
  const saved = await source.get("orders", orderId);
  const job = await store.getJob(orderId);
  assert.ok(job); assert.equal(job.decisionJson.hitMerchantId, "m1");
  assert.equal(job.decisionJson.hitReason, "ORDER_SOURCE");
  assert.equal(job.paidTotal, "100.00");
  assert.equal(sql.tables().binding.length, 0); assert.equal(sql.tables().scan.length, 0);
  assert.equal((await store.processJob(orderId)).pending, true);
  let mine = await service.mine({}, { kind: "admin", role: "merchant", shopId: "m1" });
  assert.equal(mine.orderTotal, 1); assert.equal(mine.orders[0].status, "observing");
  assert.equal(mine.total, 0); assert.equal(mine.stats.monthAmount, "0.00");
  const retried = await enqueuePaidOrder(source, saved);
  assert.equal(retried.existed, true);
  sql.setTime(job.availableAt);
  await Promise.all([store.processJob(orderId), store.processJob(orderId)]);
  const snapshot = await store.getSnapshot(orderId);
  assert.equal(snapshot.hitMerchantId, "m1"); assert.equal(snapshot.splitAmount, "10.00");
  assert.equal(sql.tables().detail.length, 1);
  const { periodAt } = require("../lib/shareEngine.cjs");
  mine = await service.mine({ period: periodAt(saved.createTime) }, { kind: "admin", role: "merchant", shopId: "m1" });
  assert.equal(mine.orders[0].status, "posted");
  const posted = await service.mine({ period: periodAt(job.availableAt) }, { kind: "admin", role: "merchant", shopId: "m1" });
  assert.equal(posted.sum.netAmount, "10.00");
  const serialized = JSON.stringify(mine);
  for (const value of ["synthetic-customer", "13800000000", "合成客户", "合成套餐", saved.orderNo]) assert.equal(serialized.includes(value), false, value);
});

test("historical QR rotation after checkout keeps its source proof; mismatched and unpersisted sources fail closed", async () => {
  const at = "2026-11-15T01:00:00Z", payTime = "2026-11-15T02:00:00Z";
  const order = { id: "order", shopId: "m1", sourceType: "merchant_qrcode", sourceCodeId: "qr-m1", scene,
    source: { shopId: "m1", sourceType: "merchant_qrcode", codeId: "qr-m1", scene, validatedAt: at } };
  const source = { get: async () => structuredClone(order) };
  const qr = { id: "qr-m1", merchantId: "m1", scene, status: "DISABLED", createdAt: "2026-11-01T00:00:00Z", disabledAt: "2026-11-15T01:30:00Z" };
  const store = { getQrByScene: async () => qr };
  const evidence = await orderSourceEvidence(source, store, order, payTime);
  assert.equal(evidence.merchantId, "m1"); assert.equal(evidence.at, "2026-11-15T01:00:00.000Z");
  for (const patch of [{ merchantId: "other" }, { id: "other" }, { disabledAt: at }, { createdAt: "2026-11-15T01:01:00Z" }]) {
    const changed = { ...qr, ...patch };
    await assert.rejects(orderSourceEvidence(source, { getQrByScene: async () => changed }, order, payTime), { code: "SHARE_ORDER_SOURCE_INVALID" });
  }
  await assert.rejects(orderSourceEvidence({ get: async () => null }, store, order, payTime), { code: "SHARE_ORDER_SOURCE_INVALID" });
  const older = structuredClone(order);
  delete older.source.validatedAt;
  older.bookingId = "original-booking";
  older.createTime = "2026-11-15T01:45:00Z";
  const legacySource = { get: async (key) => key === "orders" ? older : { createTime: at } };
  assert.equal((await orderSourceEvidence(legacySource, store, older, payTime)).at, "2026-11-15T01:00:00.000Z", "older orders use the private checkout time preceding QR rotation");
  order.source.codeId = "forged";
  await assert.rejects(orderSourceEvidence(source, store, order, payTime), { code: "SHARE_ORDER_SOURCE_INVALID" });
  assert.equal(await orderSourceEvidence(source, store, { scene: "c=legacy" }, payTime), null);
});

test("normalized MySQL preserves the checkout verification timestamp through booking and order storage", () => {
  const schema = require("../lib/mysqlSchema.cjs");
  const origin = { shopId: "m1", distributorId: "", codeId: "qr-m1", sourceCodeId: "qr-m1", sourceType: "merchant_qrcode", channel: "merchant_qrcode", scene,
    shopName: "合成商家", validatedAt: "2026-11-15T01:00:00.000Z" };
  for (const collection of ["bookingRequests", "orders"]) {
    const document = { id: "synthetic-order", shopId: "m1", sourceCodeId: "qr-m1", sourceType: "merchant_qrcode", sourceName: "合成商家", source: origin };
    const split = schema.splitDocument(collection, document);
    const restored = schema.hydrateDocument(collection, { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
    assert.deepEqual(restored.source, origin);
    assert.equal(restored.sourceName, "合成商家");
  }
});
