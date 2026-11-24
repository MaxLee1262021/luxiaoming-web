"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createService, createMemoryStore } = require("../lib/physicalCommerce.cjs");
const admin = { role: "super", id: "admin", name: "管理员" }, buyer = { openid: "buyer" };
async function fixture({ stock = 5, shipping, logistics } = {}) {
  const products = [
    { id: "album", name: "相册精装本", status: "已上", isShow: true, isCustom: true, requiresPhotos: true, price: 129, stock, shippingFee: 0, specs: ["8寸"] },
    { id: "frame", name: "相框", status: "已上", isShow: true, specMode: "multiple", skus: [{ id: "white", spec: "白色", stock: 3, price: 89 }, { id: "black", spec: "黑色", stock: 2, price: 99 }], shippingFee: 0 },
    { id: "hidden", name: "下架商品", status: "下架", isShow: false, price: 10, stock: 5 }
  ];
  const store = createMemoryStore(), service = createService({ store, catalogSource: async () => products, now: () => new Date("2026-11-17T00:00:00Z"), shipping, logistics });
  const pub = (action, data = {}, identity = buyer) => service.executePublic(action, data, identity), adm = (action, data = {}) => service.executeAdmin(action, data, admin);
  const address = await pub("saveShippingAddress", { recipient: "测试用户", phone: "13800000000", province: "湖南省", city: "长沙市", district: "岳麓区", detail: "测试街道1号房" });
  const prepare = (lines = [{ productId: "album", quantity: 1 }]) => service.preparePackageFulfillment(lines, address.id, buyer.openid);
  const parent = async (patch = {}) => ({ id: "booking-a", bookingStatus: "pending_payment", openid: buyer.openid, totalAmount: 100, depositDue: 20, finalDue: 80, physicalFulfillmentSnapshot: await prepare(), ...patch });
  return { products, store, service, pub, adm, address, prepare, parent };
}
function fullyPaid(parent, patch = {}) {
  return { ...parent, id: "service-a", bookingId: parent.bookingId || parent.id, bookingStatus: "confirmed", orderNo: "LS_PACKAGE_A", status: "completed", completedAt: "2026-11-17T00:00:00Z", depositPaid: 20, depositFinanceStatus: "已审", finalPaid: 80, finalFinanceStatus: "已审", paymentRecords: [
    { id: "deposit", provider: "wechat_pay", phase: "deposit", status: "confirmed", amount: 20, outTradeNo: "LXMDEPOSIT", externalTransactionId: "WX_DEPOSIT" },
    { id: "final", provider: "wechat_pay", phase: "final", status: "confirmed", amount: 80, outTradeNo: "LXMFINAL", externalTransactionId: "WX_FINAL" }
  ], ...patch };
}

test("package snapshot permits custom goods without standalone sale and snapshots catalog price, quantity and owned address", async () => {
  const f = await fixture();
  const snapshot = await f.prepare([{ productId: "album", quantity: 2, priceFen: 1, name: "伪造" }, { productId: "album", quantity: 1 }, { productId: "frame", skuId: "black", quantity: 2 }]);
  assert.equal(snapshot.items.length, 2);
  assert.deepEqual(snapshot.items[0], { productId: "album", skuId: snapshot.items[0].skuId, quantity: 3, name: "相册精装本", spec: "8寸", cover: "", priceFen: 12900, amountFen: 38700, shippingFeeFen: 0, deliveryCycle: "" });
  assert.equal(snapshot.items[1].spec, "黑色"); assert.equal(snapshot.items[1].priceFen, 9900);
  assert.ok(snapshot.items.every(row => row.skuId.startsWith("sku_")));
  assert.equal(snapshot.address.phone, "13800000000"); assert.equal(snapshot.address.openid, undefined);
  assert.ok(f.store.snapshot().inventory.length > 0); assert.equal(f.store.snapshot().orders.length, 0);
  await assert.rejects(f.service.preparePackageFulfillment([{ productId: "album", quantity: 1 }], f.address.id, "other"), error => error.code === "PHYSICAL_PACKAGE_ADDRESS_REQUIRED");
  await assert.rejects(f.prepare([{ productId: "frame", quantity: 1 }]), error => error.code === "PHYSICAL_PACKAGE_SKU_REQUIRED");
  await assert.rejects(f.prepare([{ productId: "frame", skuId: "unknown", quantity: 1 }]), /明确的规格/);
  await assert.rejects(f.prepare([{ productId: "hidden", quantity: 1 }]), /已下架/);
  await assert.rejects(f.prepare([{ productId: "album", quantity: 1.5 }]), /数量/);
  assert.equal(await f.service.preparePackageFulfillment([], "", ""), null);
});

test("package fulfillment freezes SKU styles and requires an unambiguous same-size variant", async () => {
  const f = await fixture();
  f.products[0].skuStyle = "可横可竖";
  f.products[1].skus = [
    { id: "white", spec: "8寸", style: "两宫格", stock: 3, price: 89 },
    { id: "black", spec: "8寸", style: "单幅/四宫格", stock: 2, price: 99 }
  ];
  await assert.rejects(f.prepare([{ productId: "frame", spec: "8寸", quantity: 1 }]), error => error.code === "PHYSICAL_PACKAGE_SKU_REQUIRED");
  const snapshot = await f.prepare([{ productId: "album", quantity: 1 }, { productId: "frame", spec: "8寸", style: "两宫格", quantity: 1 }]);
  assert.equal(snapshot.items[0].specLabel, "8寸【可横可竖】");
  assert.equal(snapshot.items[1].style, "两宫格"); assert.equal(snapshot.items[1].specLabel, "8寸【两宫格】");
  const combined = await f.prepare([{ productId: "frame", spec: "8寸【单幅/四宫格】", quantity: 1 }]);
  assert.equal(combined.items[0].style, "单幅/四宫格");
  const parent = await f.parent({ physicalFulfillmentSnapshot: snapshot });
  f.products[0].skuStyle = "已更新样式";
  f.products[1].skus[0].style = "已更新样式";
  const reserved = await f.service.reservePackageFulfillment(parent);
  assert.deepEqual(reserved.items.map(item => item.style), ["可横可竖", "两宫格"]);
  const child = await f.service.syncPackageFulfillment(fullyPaid(parent));
  assert.deepEqual(child.items.map(item => item.specLabel), ["8寸【可横可竖】", "8寸【两宫格】"]);
});

test("concurrent duplicate reservation and paid sync create one child and deduct multiplied package stock once", async () => {
  const f = await fixture(), parent = await f.parent({ physicalFulfillmentSnapshot: await f.prepare([{ productId: "album", quantity: 4 }]) });
  const reservations = await Promise.all(Array.from({ length: 8 }, () => f.service.reservePackageFulfillment(parent)));
  assert.equal(new Set(reservations.map(row => row.id)).size, 1);
  assert.equal(f.store.snapshot().inventory.find(row => row.productId === "album").reserved, 4);
  const depositOnly = await f.service.syncPackageFulfillment({ ...parent, depositPaid: 20, depositFinanceStatus: "已审" });
  assert.equal(depositOnly.status, "pending_payment");
  const paid = fullyPaid(parent), result = await Promise.all(Array.from({ length: 8 }, () => f.service.syncPackageFulfillment(paid)));
  assert.ok(result.every(row => row.status === "awaiting_shipment"));
  const state = f.store.snapshot(), stock = state.inventory.find(row => row.productId === "album"), child = state.orders[0];
  assert.equal(state.orders.length, 1); assert.equal(stock.onHand, 1); assert.equal(stock.reserved, 0); assert.equal(stock.sold, 4);
  assert.equal(child.parentOrderId, "service-a"); assert.equal(child.parentBookingId, "booking-a"); assert.equal(child.parentOrderNo, "LS_PACKAGE_A");
  assert.equal(child.totalAmountFen, 0); assert.equal(child.goodsAmountFen, 0); assert.equal(child.items[0].referencePriceFen, 12900); assert.equal(child.items[0].amountFen, 0);
  assert.equal(state.payments.length, 0); assert.equal(child.parentPayment.externalTransactionId, "WX_FINAL");
  assert.equal(await f.service.findPayment("LXMFINAL"), null);
  assert.equal(result[0].parentPayment, undefined); assert.equal(result[0].paymentTransactionId, "WX_FINAL");
  assert.ok(!result[0].allowedActions.some(action => ["pay", "cancel", "afterSale"].includes(action)));
  assert.equal((await f.service.packageFulfillmentOrders(paid, "other")).length, 0);
  assert.equal((await f.service.packageFulfillmentOrders(paid, "buyer")).length, 1);
});

test("package and standalone checkout compete for the same inventory without overselling", async () => {
  const f = await fixture({ stock: 1 }); f.products[0].isCustom = false; f.products[0].requiresPhotos = false;
  await f.adm("saveConfig", { enabled: true, enabledProductIds: ["album"] });
  const parent = await f.parent(), snapshot = parent.physicalFulfillmentSnapshot;
  const input = { checkoutSource: "direct", items: [{ productId: "album", skuId: snapshot.items[0].skuId, quantity: 1 }], addressId: f.address.id };
  const quote = await f.pub("previewPhysicalCheckout", input);
  const results = await Promise.allSettled([f.service.reservePackageFulfillment(parent), f.pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "competing-checkout" })]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  const stock = f.store.snapshot().inventory.find(row => row.productId === "album"); assert.equal(stock.onHand, 1); assert.equal(stock.reserved, 1); assert.equal(f.store.snapshot().orders.length, 1);
});

test("unverified, partial and review-held parent money never deducts package stock", async () => {
  const f = await fixture(), parent = await f.parent();
  await f.service.reservePackageFulfillment(parent);
  const unverified = fullyPaid(parent, { paymentRecords: [], depositFinanceStatus: "待审", finalFinanceStatus: "待审" });
  assert.equal((await f.service.syncPackageFulfillment(unverified)).status, "pending_payment");
  const partial = fullyPaid(parent, { finalPaid: 10, finalFinanceStatus: "待审", paymentRecords: [{ phase: "deposit", status: "confirmed", amount: 20 }] });
  assert.equal((await f.service.syncPackageFulfillment(partial)).status, "pending_payment");
  assert.equal((await f.service.syncPackageFulfillment(fullyPaid(parent, { paymentReviewRequired: true }))).status, "pending_payment");
  const stock = f.store.snapshot().inventory.find(row => row.productId === "album"); assert.equal(stock.onHand, 5); assert.equal(stock.reserved, 1); assert.equal(stock.sold, 0);
});

test("cancelled parent releases or restocks unshipped child idempotently and cannot be revived", async () => {
  const f = await fixture(), parent = await f.parent();
  await f.service.reservePackageFulfillment(parent);
  await Promise.all(Array.from({ length: 3 }, () => f.service.releasePackageFulfillment({ ...parent, status: "cancelled" })));
  let stock = f.store.snapshot().inventory.find(row => row.productId === "album"); assert.equal(stock.reserved, 0); assert.equal(stock.onHand, 5);
  assert.equal((await f.service.syncPackageFulfillment(fullyPaid(parent))).status, "closed");
  const second = await f.parent({ id: "booking-b" }); await f.service.syncPackageFulfillment(fullyPaid(second));
  stock = f.store.snapshot().inventory.find(row => row.productId === "album"); assert.equal(stock.onHand, 4); assert.equal(stock.sold, 1);
  await f.service.syncPackageFulfillment({ ...fullyPaid(second), status: "refunded" }); await f.service.releasePackageFulfillment(fullyPaid(second));
  stock = f.store.snapshot().inventory.find(row => row.productId === "album"); assert.equal(stock.onHand, 5); assert.equal(stock.sold, 0);
});

test("expired unpaid reservation can reopen the same child only after stock is rechecked", async () => {
  const f = await fixture({ stock: 1 }), parent = await f.parent();
  const first = await f.service.reservePackageFulfillment(parent);
  await f.service.releasePackageFulfillment({ ...parent, physicalReleaseReason: "unpaid_expired" });
  const secondParent = await f.parent({ id: "booking-b" }), second = await f.service.reservePackageFulfillment(secondParent);
  await assert.rejects(f.service.reservePackageFulfillment(parent), error => error.code === "PHYSICAL_STOCK");
  await f.service.releasePackageFulfillment({ ...secondParent, status: "cancelled" });
  const reopened = await f.service.reservePackageFulfillment(parent); assert.equal(reopened.id, first.id); assert.equal(reopened.status, "pending_payment"); assert.notEqual(second.id, first.id);
});

test("package children reject independent payment, cancellation and refunds and accept owned pending address changes", async () => {
  const f = await fixture(), parent = await f.parent(), child = await f.service.reservePackageFulfillment(parent);
  for (const action of ["createPhysicalPayment", "cancelPhysicalOrder", "createPhysicalAfterSale"]) await assert.rejects(f.pub(action, { orderId: child.id, reason: "test" }), error => error.code === "PHYSICAL_PACKAGE_PAYMENT_MANAGED");
  const address = await f.pub("saveShippingAddress", { recipient: "新收货人", phone: "13900000000", province: "湖南省", city: "长沙市", district: "芙蓉区", detail: "新的街道6号房" });
  const updated = await f.pub("requestPhysicalAddressChange", { orderId: child.id, addressId: address.id, version: child.version }); assert.equal(updated.address.recipient, "新收货人");
  const paid = await f.service.syncPackageFulfillment(fullyPaid(parent)); assert.equal(paid.address.recipient, "新收货人");
  await assert.rejects(f.adm("reviewAfterSale", { orderId: child.id, afterSaleId: "x", approved: true }), error => error.code === "PHYSICAL_PACKAGE_PAYMENT_MANAGED");
  await f.service.processPendingTasks(); assert.equal((await f.pub("getPhysicalOrder", { orderId: child.id })).status, "awaiting_shipment");
});

test("paid package uses existing physical shipment, tracking tasks and receipt; parent cancellation after shipping freezes without restocking", async () => {
  const uploads = [], f = await fixture({ shipping: { isConfigured: () => true, async upload(shipment, order) { uploads.push({ shipment, order }); return { uploadedAt: "2026-11-17T00:00:00Z" }; }, async queryReceipt() { return { received: false }; } }, logistics: { isConfigured: () => true, async subscribe() { return { status: "subscribed" }; } } });
  const parent = fullyPaid(await f.parent()), child = await f.service.syncPackageFulfillment(parent);
  const shipped = await f.adm("ship", { orderId: child.id, carrierCode: "shunfeng", trackingNo: "SF12345678", version: child.version }); assert.equal(shipped.status, "awaiting_receipt");
  await f.service.processPendingTasks(); assert.equal(uploads.length, 1); assert.equal(uploads[0].order.payment.externalTransactionId, "WX_FINAL");
  assert.equal(f.store.snapshot().tasks.filter(row => row.status === "done").length, 2);
  const tracking = await f.pub("getPhysicalLogistics", { orderId: child.id }); assert.equal(tracking.shipment.trackingNo, "SF12345678");
  await f.service.syncPackageFulfillment({ ...parent, status: "cancelled" });
  const held = await f.pub("getPhysicalOrder", { orderId: child.id }); assert.equal(held.parentCancellationPending, true); assert.ok(!held.allowedActions.includes("confirmReceipt"));
  await assert.rejects(f.pub("confirmPhysicalReceipt", { orderId: child.id, received: true }), /售后或改址/);
  assert.equal(f.store.snapshot().inventory.find(row => row.productId === "album").onHand, 4);
  await f.adm("withdrawShipment", { orderId: child.id, packageIntercepted: true, reason: "已核实包裹仍在仓库，取消交运" });
  const closed = await f.service.releasePackageFulfillment({ ...parent, status: "cancelled" }); assert.equal(closed.status, "closed");
  const stock = f.store.snapshot().inventory.find(row => row.productId === "album"); assert.equal(stock.onHand, 5); assert.equal(stock.sold, 0);
});

test("offline and zero-price packages retain ordinary logistics without creating WeChat payment or upload", async () => {
  const f = await fixture(); await f.adm("saveConfig", { wechatReceiptRequired: true });
  const parent = fullyPaid(await f.parent(), { paymentRecords: [] }), child = await f.service.syncPackageFulfillment(parent); assert.equal(child.receiptSyncRequired, false);
  const shipped = await f.adm("ship", { orderId: child.id, carrierCode: "shunfeng", trackingNo: "SF87654321" });
  assert.equal(shipped.status, "awaiting_receipt"); assert.equal(f.store.snapshot().tasks.some(row => row.type === "wechat_shipping"), false);
  const completed = await f.pub("confirmPhysicalReceipt", { orderId: child.id, received: true }); assert.equal(completed.status, "completed");
  const free = await f.parent({ id: "free", totalAmount: 0, depositDue: 0, finalDue: 0 });
  assert.equal((await f.service.syncPackageFulfillment(free)).status, "pending_payment");
  assert.equal((await f.service.syncPackageFulfillment({ ...free, status: "completed", completedAt: "2026-11-17T00:00:00Z" })).status, "awaiting_shipment");
});
