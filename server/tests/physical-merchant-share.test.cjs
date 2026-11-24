"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const physical = require("../lib/physicalCommerce.cjs"), share = require("../lib/merchantShare.cjs");
const { createShareWorker } = require("../lib/shareWorker.cjs");

async function fixture() {
  let clock = new Date("2026-11-18T00:00:00Z"), rejectPayment = false;
  const products = [{ id: "album", name: "相册", status: "已上", isShow: true, price: 100, stock: 10, shippingFee: 8 }];
  const source = { list: async key => key === "peripherals" ? products : [], transaction: async () => { throw new Error("No real SQL in this test"); } };
  const scene = share.qrScene("0123456789ABCD"), qr = { id: "qr-a", merchantId: "merchant-a", scene, status: "ACTIVE", createdAt: "2026-11-01T00:00:00Z" };
  const events = [], refundEvents = [], jobs = new Map();
  const shareStore = {
    getQrByScene: async value => value === scene ? qr : null,
    getMerchant: async () => ({ id: "merchant-a", name: "真实门店", status: "OPEN" }),
    enqueuePayment: async event => { if (rejectPayment) throw Object.assign(new Error("temporarily unavailable"), { code: "TEMPORARY_SHARE_FAILURE" }); if (!jobs.has(event.orderId)) { jobs.set(event.orderId, event); events.push(event); } return { existed: jobs.has(event.orderId), job: event }; },
    recordRefund: async event => { if (!refundEvents.some(row => row.refundNo === event.refundNo)) refundEvents.push(event); return { accepted: true }; },
  };
  share.serviceFor(source, { store: shareStore, enableAt: "2026-11-01T00:00:00Z", clock: () => clock });
  const store = physical.createMemoryStore();
  const wechatPay = { isConfigured: () => true, createJsapiTransaction: async () => ({ prepayId: "prepay", paymentParams: {} }),
    createRefund: async ({ payment, refundNo, amount }) => ({ refundNo, refundId: "wx-refund", outTradeNo: payment.outTradeNo, transactionId: payment.externalTransactionId, status: "SUCCESS", amount: Math.round(amount * 100), total: payment.amountFen, successTime: clock.toISOString() }) };
  const service = physical.serviceFor(source, { store, wechatPay, now: () => clock });
  const user = { kind: "public", openid: "buyer", sessionId: "trusted-session", createdAt: clock.toISOString() }, admin = { role: "super", id: "admin" };
  const pub = (action, input) => service.executePublic(action, input, user);
  await service.executeAdmin("saveConfig", { enabled: true, enabledProductIds: ["album"] }, admin);
  const catalog = await pub("getPhysicalCatalog"), address = await pub("saveShippingAddress", { recipient: "测试客户", phone: "13800000000", province: "湖南省", city: "长沙市", district: "岳麓区", detail: "测试路1号" });
  async function checkout(extra = {}, key = "checkout") {
    const input = { checkoutSource: "direct", items: [{ productId: "album", skuId: catalog.items[0].skus[0].id, quantity: 1 }], addressId: address.id, ...extra };
    const quote = await pub("previewPhysicalCheckout", input);
    return pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: key });
  }
  async function pay(order) {
    await pub("createPhysicalPayment", { orderId: order.id, sessionId: "forged" });
    const payment = store.snapshot().payments.find(row => row.orderId === order.id);
    const event = { outTradeNo: payment.outTradeNo, tradeState: "SUCCESS", transactionId: `wx-${order.id}`, amountTotal: payment.amountFen, amountCurrency: "CNY", payerOpenid: "buyer", successTime: clock.toISOString() };
    await service.confirmPayment(event); await service.confirmPayment(event);
    return event;
  }
  return { service, source, store, events, refundEvents, qr, scene, checkout, pay, pub, admin, advance: ms => { clock = new Date(clock.getTime() + ms); }, rejectPayment: value => { rejectPayment = value; } };
}

test("physical checkout validates the QR merchant and full payment queues only goods with trusted session", async () => {
  const f = await fixture(), order = await f.checkout({ scene: f.scene, shopId: "forged-merchant", codeId: "forged-code" });
  assert.equal(order.source.shopId, "merchant-a"); assert.equal(order.source.sourceCodeId, "qr-a");
  assert.equal(f.events.length, 0);
  await f.pay(order);
  assert.equal(f.store.snapshot().tasks.filter(row => row.type === "merchant_share_payment").length, 1);
  await f.service.processPendingTasks(); await f.service.processPendingTasks();
  assert.equal(f.events.length, 1); assert.equal(f.events[0].paidTotal, "100.00");
  assert.equal(f.events[0].sessionId, "trusted-session");
  assert.equal(f.events[0].orderSource.merchantId, "merchant-a");
  const normalized = await f.service.getShareOrder(order.id);
  assert.equal(normalized.paidAmount, 108); assert.equal(normalized.finalPaid, 100);
  assert.equal(normalized.paymentRecords[0].provider, "wechat_pay");
});

test("bare shop ids cannot claim physical source; invalid issued scenes do not reserve stock", async () => {
  const f = await fixture(), order = await f.checkout({ shopId: "forged" });
  assert.equal(order.source.shopId, ""); assert.equal(order.source.sourceType, "direct");
  const before = f.store.snapshot().inventory[0].reserved;
  await assert.rejects(f.checkout({ scene: "SINVALID" }, "bad"));
  assert.equal(f.store.snapshot().inventory[0].reserved, before);
});

test("physical commission retries durably and successful refunds exclude returned shipping", async () => {
  const f = await fixture(), order = await f.checkout(); await f.pay(order);
  f.rejectPayment(true); await f.service.processPendingTasks();
  assert.equal(f.store.snapshot().tasks.find(row => row.type === "merchant_share_payment").status, "retry");
  f.rejectPayment(false); f.advance(120000); await f.service.processPendingTasks();
  assert.equal(f.events.length, 1);
  const sale = await f.pub("createPhysicalAfterSale", { orderId: order.id, reason: "退回商品及运费" });
  await f.service.executeAdmin("reviewAfterSale", { orderId: order.id, afterSaleId: sale.id, approved: true, shippingRefundAmount: 8 }, f.admin);
  assert.equal((await f.pub("getPhysicalOrder", { orderId: order.id })).refundedAmount, 108);
  await f.service.processPendingTasks(); await f.service.processPendingTasks();
  assert.equal(f.refundEvents.length, 1); assert.equal(f.refundEvents[0].amount, "100.00");
  assert.equal((await f.service.getShareRefunds(order.id))[0].amount, "100.00");
});

test("package fulfillment children never produce an additional merchant commission", async () => {
  const f = await fixture();
  await f.store.transaction(state => {
    state.orders.push({ id: "physical_pkg_child", orderType: "physical", paymentMode: "package", status: "awaiting_shipment", openid: "buyer", items: [], goodsAmountFen: 0 });
    state.payments.push({ id: "parent-payment", orderId: "physical_pkg_child", provider: "wechat_pay", status: "confirmed", amountFen: 10000, confirmedAt: "2026-11-18T00:00:00Z" });
  });
  await f.service.processPendingTasks();
  assert.deepEqual(await f.service.listShareOrders(), []); assert.equal(await f.service.getShareOrder("physical_pkg_child"), null);
  assert.equal(f.events.length, 0); assert.equal(f.store.snapshot().tasks.length, 0);
});

test("mixed or partially unknown product cities never assign a physical order to one city bucket", async () => {
  const f = await fixture(), order = await f.checkout();
  for (const cities of [["CS", "ZZ"], ["CS", ""], ["", ""]]) {
    await f.store.transaction(state => { state.orders.find(row => row.id === order.id).items = cities.map(cityId => ({ cityId, name: "城市统计用商品" })); });
    assert.equal((await f.service.getShareOrder(order.id)).cityId, "");
    assert.equal((await f.service.listShareOrders()).length, 1, "unbucketed orders remain in overall merchant statistics");
  }
});

test("a shipping-only refund has no goods reversal and completes its delivery task", async () => {
  const f = await fixture(), order = await f.checkout(); await f.pay(order);
  await f.store.transaction(state => state.refunds.push({ id: "shipping-only", orderId: order.id, refundNo: "shipping-only", amountFen: 800, shippingRefundFen: 800, status: "SUCCESS", updatedAt: "2026-11-18T00:00:00Z" }));
  await f.service.processPendingTasks();
  assert.equal(f.refundEvents.length, 0); assert.deepEqual(await f.service.getShareRefunds(order.id), []);
  assert.equal(f.store.snapshot().tasks.find(row => row.type === "merchant_share_refund").status, "done");
});

test("share worker reads physical refunds before maturity and projects attribution into dedicated commerce storage", async () => {
  const f = await fixture(), order = await f.checkout(); await f.pay(order);
  const sale = await f.pub("createPhysicalAfterSale", { orderId: order.id, reason: "退款" });
  await f.service.executeAdmin("reviewAfterSale", { orderId: order.id, afterSaleId: sale.id, approved: true, shippingRefundAmount: 8 }, f.admin);
  const repairs = [];
  const worker = createShareWorker(f.source, { physicalService: f.service, service: { settings: () => ({ enabled: true, enableAt: "2026-11-01T00:00:00Z" }), store: {
    reconcileRefundReversals: async (id, facts) => { repairs.push({ id, ...facts }); return { repairedAmount: "0.00", factsAdded: 0 }; },
    getEffectiveAttribution: async () => ({ state: { splitType: "T2", staffId: "staff", sourceReason: "CS_LINK" }, revisionNo: 2 }),
  } } });
  const result = await worker.refundScan({ full: false, orders: [{ id: order.id }] });
  assert.equal(result.failed, 0); assert.equal(repairs[0].refunds[0].amount, "100.00");
  await worker.synchronizeAttribution({ payloadJson: { orderId: order.id } });
  const projected = await f.service.getShareOrder(order.id);
  assert.equal(projected.shareOrderSource, "SERVICE"); assert.equal(projected.shareAttributionRevision, 2);
  await f.service.markShareAttribution(order.id, { shareOrderSource: "SELF", shareAttributionRevision: 1 });
  assert.equal((await f.service.getShareOrder(order.id)).shareOrderSource, "SERVICE");
});

test("physical payment reaches the real share store: restored rotated source, latest scan at payment, snapshot and refund reversal", async () => {
  const { fixture: sqlFixture, merchant } = require("./fixtures/shareSql.cjs");
  const sql = sqlFixture(), ledger = sql.newStore(); await ledger.ensureSchema();
  const sceneA = share.qrScene("00000000000001"), sceneB = share.qrScene("00000000000002"), sceneNewA = share.qrScene("00000000000003");
  await ledger.onboardMerchant(merchant("a", { ratioT1: "0.1000", refundWindowDays: 0, qr: { id: "qr-a", scene: sceneA, imageUrl: "data:image/png;base64,iVBORw0KGgo=" } }));
  await ledger.onboardMerchant(merchant("b", { ratioT1: "0.2000", refundWindowDays: 0, qr: { id: "qr-b", scene: sceneB, imageUrl: "data:image/png;base64,iVBORw0KGgo=" } }));
  sql.setTime("2026-11-01T01:00:00Z"); await ledger.reportScan({ userId: "buyer", scene: sceneA });
  sql.setTime("2026-11-02T01:00:00Z");
  await ledger.rotateQr({ merchantId: "a", id: "qr-a-new", scene: sceneNewA, imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "换码", operatorId: "admin", requestId: "rotate-a" });
  let clock = "2026-11-18T00:00:00Z"; sql.setTime(clock);
  const product = { id: "goods", name: "相册", status: "已上", isShow: true, price: 100, stock: 2, shippingFee: 8, cityId: "CS" };
  const source = { ...sql.source, list: async key => key === "peripherals" ? [product] : [] };
  const shareService = share.serviceFor(source, { store: ledger, enableAt: "2026-11-01T00:00:00Z", clock: () => new Date(clock) });
  const commerceStore = physical.createMemoryStore(), admin = { role: "super", id: "admin" }, user = { kind: "public", openid: "buyer" };
  const wechatPay = { isConfigured: () => true, createJsapiTransaction: async () => ({ prepayId: "prepay", paymentParams: {} }),
    createRefund: async ({ payment, refundNo, amount }) => ({ refundNo, refundId: "wx-refund", outTradeNo: payment.outTradeNo, transactionId: payment.externalTransactionId, status: "SUCCESS", amount: Math.round(amount * 100), total: payment.amountFen, successTime: clock }) };
  const commerce = physical.serviceFor(source, { store: commerceStore, wechatPay, now: () => new Date(clock) });
  const pub = (action, input) => commerce.executePublic(action, input, user);
  await commerce.executeAdmin("saveConfig", { enabled: true, enabledProductIds: ["goods"] }, admin);
  const catalog = await pub("getPhysicalCatalog"), address = await pub("saveShippingAddress", { recipient: "合成客户", phone: "13800000000", province: "湖南省", city: "株洲市", district: "天元区", detail: "合成测试路1号" });
  const input = { checkoutSource: "direct", items: [{ productId: "goods", skuId: catalog.items[0].id && catalog.items[0].skus[0].id, quantity: 1 }], addressId: address.id, scene: sceneA, shopId: "forged" };
  const quote = await pub("previewPhysicalCheckout", input), order = await pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "rotated-checkout" });
  assert.equal(order.source.shopId, "a"); assert.ok(order.source.bindingScanId);
  assert.equal(sql.tables().scan.length, 1, "restored disabled scene never manufactures a fresh scan");
  clock = "2026-11-18T00:01:00Z"; sql.setTime(clock); await ledger.reportScan({ userId: "buyer", scene: sceneB });
  await assert.rejects(pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "stale-rotated-after-switch" }), { code: "PHYSICAL_SOURCE_INVALID" });
  clock = "2026-11-18T00:02:00Z"; sql.setTime(clock);
  await pub("createPhysicalPayment", { orderId: order.id });
  const payment = commerceStore.snapshot().payments[0];
  await commerce.confirmPayment({ outTradeNo: payment.outTradeNo, tradeState: "SUCCESS", transactionId: "wx-real-share-fixture", amountTotal: 10800, amountCurrency: "CNY", payerOpenid: "buyer", successTime: clock });
  clock = "2026-11-18T00:03:00Z"; sql.setTime(clock); await ledger.reportScan({ userId: "buyer", scene: sceneNewA });
  await commerce.processPendingTasks();
  const job = await ledger.getJob(order.id);
  assert.equal(job.paidTotal, "100.00"); assert.equal(job.decisionJson.hitMerchantId, "b", "only scans at or before payment apply");
  await ledger.processJob(order.id);
  const snapshot = await ledger.getSnapshot(order.id);
  assert.equal(snapshot.hitMerchantId, "b"); assert.equal(snapshot.splitAmount, "20.00");
  const analytics = await shareService.analytics({ cityId: "CS" }, { kind: "admin", role: "super" });
  assert.equal(analytics.orderAttributions[0].orderId, order.id); assert.equal(analytics.totalAmount, "20.00");
  assert.equal((await shareService.analytics({ cityId: "株洲市" }, { kind: "admin", role: "super" })).orderAttributions.length, 0, "shipping city never supplies business city");
  const sale = await pub("createPhysicalAfterSale", { orderId: order.id, reason: "退回全部商品及运费" });
  await commerce.executeAdmin("reviewAfterSale", { orderId: order.id, afterSaleId: sale.id, approved: true, shippingRefundAmount: 8 }, admin);
  await commerce.processPendingTasks(); await commerce.processPendingTasks();
  const rows = await ledger.listDetails({ all: true });
  assert.deepEqual(rows.list.map(row => row.amount).sort(), ["-20.00", "20.00"]);
  assert.equal(rows.sum.netAmount, "0.00"); assert.equal(sql.tables().snapshot.length, 1); assert.equal(sql.tables().refund.length, 1);
  assert.equal(sql.tables().scan.length, 3, "checkout and repeated commission delivery do not add scans");
});
