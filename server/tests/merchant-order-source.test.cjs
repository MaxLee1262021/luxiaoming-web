"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rpc = require("../lib/rpc.cjs");
const createSource = require("./fixtures/jsonSource.cjs");
const { fixture: shareFixture } = require("./fixtures/shareSql.cjs");
const { serviceFor, qrScene } = require("../lib/merchantShare.cjs");
const { confirmTestPayment } = require("./helpers/wechatPay.cjs");
const identity = { identity: { kind: "public", openid: "synthetic-customer" } };
const scene = qrScene("0123456789ABCD");
const input = { name: "合成测试客户", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1", current: true }, items: [{ packageId: "package" }] };

async function fixture(t, depositRatio = 0, mirror = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-merchant-origin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = createSource({ jsonFile: path.join(dir, "db.json") });
  await source.create("siteConfig", { id: "global", bookingNotice: ["合成测试须知"], bookingNoticeVersion: "v1" });
  await source.create("packages", { id: "package", name: "合成测试套餐", price: 100, depositRatio, status: "已上架" });
  if (mirror) await source.create("shops", { id: "merchant-new", name: "扫码商家", cityId: "city-real", city: "长沙", distributorId: "dist-real" });
  await source.create("shops", { id: "merchant-old", name: "旧商家" });
  await source.create("merchantCodes", { id: "code-old", shopId: "merchant-old", scene: "c=code-old", status: "active" });
  const sql = shareFixture(), store = sql.newStore();
  await store.ensureSchema();
  await store.upsertMerchant({ merchantId: "merchant-new", name: "扫码商家", status: "OPEN" });
  await store.saveQr({ merchantId: "merchant-new", id: "qr-new", scene, imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "合成测试", operatorId: "test" });
  // A future activation date must not disable order-origin resolution.
  serviceFor(source, { store, enableAt: "2099-01-01T00:00:00Z" });
  const book = (extra = {}) => rpc(source, "createBooking", { data: { ...input, ...extra } }, identity);
  return { source, store, sql, book };
}

test("new QR scene overrides stale or forged merchant fields without waiting for scan reporting", async (t) => {
  const { source, sql, book } = await fixture(t);
  const result = await book({ scene, shopId: "merchant-old", codeId: "code-old", sourceName: "伪造商家", cityId: "forged-city", distributorId: "forged-dist" });
  assert.equal(result.success, true, JSON.stringify(result));
  const order = await source.get("orders", result.orderId);
  assert.equal(order.shopId, "merchant-new");
  assert.equal(order.sourceName, "扫码商家");
  assert.equal(order.sourceType, "merchant_qrcode");
  assert.equal(order.sourceChannel, "merchant_qrcode");
  assert.equal(order.sourceCodeId, "qr-new");
  assert.equal(order.scene, scene);
  assert.equal(order.source.shopId, "merchant-new");
  assert.equal(order.source.cityId, "city-real");
  assert.equal(order.distributorId, "dist-real");
  for (const key of ["scan", "binding", "binding_event", "snapshot", "detail"]) assert.equal(sql.tables()[key].length, 0, key);
});

test("paid order keeps the merchant frozen at checkout even when QR is replaced before payment", async (t) => {
  const { source, store, book } = await fixture(t, 30);
  const result = await book({ scene, idempotencyKey: "merchant-checkout-0001" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.bookingStatus, "pending_payment");
  const draft = await source.get("bookingRequests", result.bookingId);
  assert.equal(draft.shopId, "merchant-new");
  await store.rotateQr({ merchantId: "merchant-new", id: "qr-next", scene: qrScene("ABCDEF01234567"), imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "合成换码", operatorId: "test", requestId: "rotate-once" });
  const paid = await confirmTestPayment(source, { data: { bookingId: result.bookingId, phase: "deposit", idempotencyKey: "merchant-payment-0001" } }, identity);
  assert.equal(paid.success, true, JSON.stringify(paid));
  const order = await source.get("orders", paid.data.orderId);
  assert.equal(order.shopId, "merchant-new");
  assert.equal(order.sourceCodeId, "qr-new");
  assert.equal(order.sourceName, "扫码商家");
  assert.equal(order.scene, scene);
  const retry = await book({ scene: qrScene("FFFFFFFFFFFFFF"), idempotencyKey: "merchant-checkout-0001" });
  assert.equal(retry.orderId, order.id);
  assert.equal((await source.list("orders")).length, 1);
});

test("an authenticated customer's latest binding survives rotation for a new checkout without recording another scan", async (t) => {
  const { source, store, sql, book } = await fixture(t);
  sql.setTime("2026-11-01T00:01:00Z");
  await store.reportScan({ userId: identity.identity.openid, scene, requestKey: "bound-before-rotation" });
  sql.setTime("2026-11-01T00:02:00Z");
  await store.rotateQr({ merchantId: "merchant-new", id: "qr-next", scene: qrScene("ABCDEF01234567"), imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "换码保留归属", operatorId: "test", requestId: "rotate-restored" });
  const result = await book({ scene });
  assert.equal(result.success, true, JSON.stringify(result));
  const order = await source.get("orders", result.orderId);
  assert.equal(order.shopId, "merchant-new"); assert.equal(order.sourceCodeId, "qr-new");
  const evidence = await require("../lib/merchantOrderEvidence.cjs").orderSourceEvidence(source, store, order, new Date(Date.now() + 1000).toISOString());
  assert.equal(evidence.merchantId, "merchant-new"); assert.equal(evidence.qrId, "qr-new");
  assert.equal(sql.tables().scan.length, 1); assert.equal(sql.tables().binding_event.length, 1);
  const freshScan = await rpc(source, "reportShareScan", { data: { scene, requestKey: "new-scan-disabled-code" } }, identity);
  assert.equal(freshScan.success, false); assert.equal(sql.tables().scan.length, 1);
  const impersonated = await rpc(source, "createBooking", { data: { ...input, scene, openid: identity.identity.openid } }, { identity: { kind: "public", openid: "different-customer" } });
  assert.equal(impersonated.success, false); assert.match(impersonated.error, /二维码/);
});

test("a disabled restored code cannot claim an older merchant after a new scan or user invalidation", async (t) => {
  const { source, store, sql, book } = await fixture(t);
  sql.setTime("2026-11-01T00:01:00Z");
  await store.reportScan({ userId: identity.identity.openid, scene });
  sql.setTime("2026-11-01T00:02:00Z");
  await store.rotateQr({ merchantId: "merchant-new", id: "qr-next", scene: qrScene("ABCDEF01234567"), imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "换码", operatorId: "test", requestId: "rotate-latest-only" });
  await store.invalidateUser(identity.identity.openid, { requestId: "invalidate-old-owner", operatorId: "test", reason: "测试失效" });
  assert.equal((await book({ scene })).success, false);
  await store.upsertMerchant({ merchantId: "merchant-old", name: "另一商家", status: "OPEN" });
  const otherScene = qrScene("FFFFFFFFFFFFFF");
  await store.saveQr({ merchantId: "merchant-old", id: "qr-other", scene: otherScene, imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "新商家", operatorId: "test" });
  sql.setTime("2026-11-01T00:03:00Z");
  await store.reportScan({ userId: identity.identity.openid, scene: qrScene("ABCDEF01234567") });
  sql.setTime("2026-11-01T00:04:00Z");
  await store.reportScan({ userId: identity.identity.openid, scene: otherScene });
  const switched = await book({ scene });
  assert.equal(switched.success, false); assert.match(switched.error, /二维码/);
  assert.equal((await source.list("orders")).length, 0);
});

test("a direct booking stays natural after an earlier scan; legacy QR bookings still resolve", async (t) => {
  const { source, book } = await fixture(t);
  assert.equal((await rpc(source, "reportShareScan", { data: { scene, requestKey: "earlier-scan" } }, identity)).success, true);
  const direct = await book({ sourceName: "伪造商家", sourceType: "merchant_qrcode" });
  assert.equal(direct.success, true, JSON.stringify(direct));
  const natural = await source.get("orders", direct.orderId);
  assert.equal(natural.shopId, ""); assert.equal(natural.sourceCodeId, "");
  assert.equal(natural.sourceType, "direct"); assert.equal(natural.sourceName, "");
  const legacy = await book({ scene: "c=code-old", codeId: "code-old" });
  assert.equal(legacy.success, true, JSON.stringify(legacy));
  const old = await source.get("orders", legacy.orderId);
  assert.equal(old.shopId, "merchant-old"); assert.equal(old.sourceType, "merchant_qrcode");
});

test("the authoritative merchant name survives a missing legacy shop mirror", async (t) => {
  const { source, book } = await fixture(t, 0, false);
  const result = await book({ scene });
  assert.equal(result.success, true, JSON.stringify(result));
  const order = await source.get("orders", result.orderId);
  assert.equal(order.shopId, "merchant-new"); assert.equal(order.sourceName, "扫码商家");
});

test("invalid, disabled and closed-merchant QR entries cannot fall back to natural or stale sources", async (t) => {
  const { source, sql, store, book } = await fixture(t);
  const rejected = async (value) => {
    const result = await book({ scene: value, codeId: "code-old", shopId: "merchant-old" });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.match(result.error, /二维码/);
    assert.equal((await source.list("orders")).length, 0);
  };
  await rejected(scene.slice(0, -1) + (scene.endsWith("Z") ? "Y" : "Z"));
  await rejected(qrScene("FFFFFFFFFFFFFF"));
  sql.tables().qr[0].status = "DISABLED";
  await rejected(scene);
  sql.tables().qr[0].status = "ACTIVE";
  for (const status of ["CLOSED", "DISABLED", "TERMINATED", "CANCELLED"]) {
    sql.tables().merchant[0].status = status;
    await rejected(scene);
  }
  sql.tables().merchant[0].status = "OPEN";
  store.getQrByScene = async () => { throw new Error("PRIVATE_DATABASE_DETAILS"); };
  const unavailable = await book({ scene, codeId: "code-old" });
  assert.equal(unavailable.success, false);
  assert.equal(unavailable.error, "来源信息暂不可用，请稍后重试");
});
