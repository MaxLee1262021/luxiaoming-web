"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createSource = require("./fixtures/jsonSource.cjs");
const rpc = require("../lib/rpc.cjs");
const { createMemoryStore, serviceFor } = require("../lib/physicalCommerce.cjs");
const { createTestWechatPay, confirmTestPayment } = require("./helpers/wechatPay.cjs");
const identity = { identity: { kind: "public", openid: "owner" } };
const user = { openid: "owner" };
const baseInput = { name: "客户", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1.0", current: true }, items: [{ packageId: "package", quantity: 2 }], idempotencyKey: "bundle-checkout-0001" };

async function fixture(t, ratio = 30) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-bundle-rpc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = createSource({ backend: "json", jsonFile: path.join(dir, "db.json") });
  await source.create("siteConfig", { id: "global", bookingNotice: ["Synthetic booking notice"], bookingNoticeVersion: "v1.0" });
  await source.create("packages", { id: "package", name: "旅拍含相册", price: 100, depositRatio: ratio, status: "已上架", includedItems: [{ type: "peripheral", productId: "album", quantity: 2 }] });
  await source.create("peripherals", { id: "album", name: "相册精装本", status: "已上架", isShow: true, price: 29.90, stock: 10, shippingFee: 0, isCustom: true });
  const store = createMemoryStore();
  const physical = serviceFor(source, { store });
  const address = await physical.executePublic("saveShippingAddress", { recipient: "收件人", phone: "13800000000", province: "湖南省", city: "长沙市", district: "天心区", detail: "测试街道一号房", isDefault: true }, user);
  return { source, store, physical, input: { ...baseInput, shippingAddressId: address.id } };
}

async function deposit(f) {
  const booking = await rpc(f.source, "createBooking", { data: f.input }, identity);
  assert.equal(booking.success, true, JSON.stringify(booking));
  const result = await confirmTestPayment(f.source, { data: { bookingId: booking.bookingId, phase: "deposit", idempotencyKey: "bundle-deposit-0001" } }, identity);
  assert.equal(result.success, true, JSON.stringify(result));
  const order = (await f.source.list("orders"))[0];
  assert.ok(order);
  return { booking, order };
}

test("package checkout requires an owned address and freezes server-side included quantities", async t => {
  const f = await fixture(t);
  for (const shippingAddressId of [undefined, "someone-elses-address"]) {
    const rejected = await rpc(f.source, "createBooking", { data: { ...f.input, shippingAddressId } }, identity);
    assert.equal(rejected.success, false);
    assert.equal((await f.source.list("bookingRequests")).length, 0);
  }
  const result = await rpc(f.source, "createBooking", { data: { ...f.input, physicalFulfillmentSnapshot: { items: [] }, items: [{ packageId: "package", quantity: 2, includedItems: [] }] } }, identity);
  assert.equal(result.success, true, JSON.stringify(result));
  const draft = await f.source.get("bookingRequests", result.bookingId);
  assert.equal(draft.physicalFulfillmentSnapshot.items.length, 1);
  assert.equal(draft.physicalFulfillmentSnapshot.items[0].quantity, 4);
  const schema = require("../lib/mysqlSchema.cjs"), split = schema.splitDocument("bookingRequests", draft);
  const hydrated = schema.hydrateDocument("bookingRequests", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  assert.deepEqual(hydrated.physicalFulfillmentSnapshot, draft.physicalFulfillmentSnapshot);
});

test("verified full package payment deducts stock once and exposes a shippable child through service detail", async t => {
  const f = await fixture(t), { order } = await deposit(f);
  assert.equal(f.store.snapshot().inventory[0].reserved, 4);
  assert.equal(f.store.snapshot().inventory[0].onHand, 10, "deposit alone does not sell included stock");
  assert.equal(f.store.snapshot().orders[0].status, "pending_payment");
  // Later catalog changes cannot alter this booking's promised quantities.
  await f.source.update("packages", "package", { includedItems: [] });
  await f.source.update("orders", order.id, { status: "shooting", workflowStage: "shooting", customerArrivedAt: new Date().toISOString() });
  const result = await confirmTestPayment(f.source, { data: { orderId: order.id, phase: "final", selectionAccepted: true, idempotencyKey: "bundle-final-0001" } }, identity);
  assert.equal(result.success, true, JSON.stringify(result));
  for (let i = 0; i < 2; i++) {
    const detail = await rpc(f.source, "getOrderDetail", { data: { orderId: order.id } }, identity);
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.equal(detail.data.physicalOrders.length, 1);
    assert.equal(detail.data.physicalOrders[0].status, "awaiting_shipment");
    assert.equal(detail.data.physicalOrders[0].items[0].quantity, 4);
  }
  const state = f.store.snapshot();
  assert.equal(state.inventory[0].onHand, 6);
  assert.equal(state.inventory[0].reserved, 0);
  assert.equal(state.inventory[0].sold, 4);
  assert.equal(state.orders.length, 1);
  const forbidden = await rpc(f.source, "getOrderDetail", { data: { orderId: order.id } }, { identity: { kind: "public", openid: "other" } });
  assert.equal(forbidden.success, false);
  const child = state.orders[0];
  const shipped = await f.physical.executeAdmin("ship", { orderId: child.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }, { role: "super", id: "admin" });
  assert.equal(shipped.status, "awaiting_receipt");
  assert.equal(f.store.snapshot().shipments[0].items[0].quantity, 4);
  assert.ok(f.store.snapshot().tasks.some(task => task.type === "subscribe"));
  assert.ok(f.store.snapshot().tasks.some(task => task.type === "wechat_shipping"));
});

test("a package paid entirely as deposit ships after verified deposit and cancellation restores unshipped stock", async t => {
  const f = await fixture(t, 100), { order } = await deposit(f);
  assert.equal(f.store.snapshot().orders[0].status, "awaiting_shipment");
  assert.equal(f.store.snapshot().inventory[0].onHand, 6);
  const cancelled = await f.source.update("orders", order.id, { status: "cancelled", workflowStage: "cancelled", service_status: "canceled" });
  await require("../lib/customerService.cjs").onCancelled(f.source, cancelled);
  assert.equal(f.store.snapshot().orders[0].status, "closed");
  assert.equal(f.store.snapshot().inventory[0].onHand, 10);
  await require("../lib/customerService.cjs").onCancelled(f.source, cancelled);
  assert.equal(f.store.snapshot().inventory[0].onHand, 10);
});

test("stock conflicts block a payable package intent and booking cancellation releases its reservation", async t => {
  const f = await fixture(t);
  const first = await rpc(f.source, "createBooking", { data: f.input }, identity);
  const prepared = await rpc(f.source, "createPayment", { data: { bookingId: first.bookingId, phase: "deposit", idempotencyKey: "bundle-pending-0001" } }, { ...identity, wechatPay: createTestWechatPay() });
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  assert.equal(f.store.snapshot().inventory[0].reserved, 4);
  const second = await rpc(f.source, "createBooking", { data: { ...f.input, items: [{ packageId: "package", quantity: 4 }], idempotencyKey: "bundle-checkout-0002" } }, identity);
  assert.equal(second.success, false, "8 items cannot be promised with only 6 available");
  const cancelled = await rpc(f.source, "cancelBooking", { data: { bookingId: first.bookingId } }, { ...identity, wechatPay: createTestWechatPay() });
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));
  assert.equal(f.store.snapshot().inventory[0].reserved, 0);
  assert.equal(f.store.snapshot().inventory[0].onHand, 10);
});
