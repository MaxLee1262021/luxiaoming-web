"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createService, createMemoryStore } = require("../lib/physicalCommerce.cjs");
const { createKuaidi100 } = require("../lib/kuaidi100.cjs");
const { createWechatShipping } = require("../lib/wechatShipping.cjs");

function fixture() {
  const at = "2026-11-15T04:00:00.000Z", salt = "isolated-subscription-salt-at-least-16";
  const store = createMemoryStore({ orders: [{ id: "test-order", orderNo: "PT_LOGISTICS", openid: "buyer-test", status: "awaiting_receipt", version: 4,
    totalAmountFen: 10000, goodsAmountFen: 9000, shippingFeeFen: 1000, refundedFen: 0,
    items: [{ id: "line-test", name: "相册", priceFen: 9000, quantity: 1, refundedQuantity: 0 }] }],
    shipments: [{ id: "ship-test", orderId: "test-order", kind: "outbound", version: 1, active: true,
      carrierCode: "shunfeng", trackingNo: "SF1234567890", subscriptionSalt: salt, dispatchConfirmedAt: at,
      wechatUploadRequestAt: at, wechatUploadedAt: at, logisticsStatus: "awaiting_collection", events: [] }],
    payments: [{ id: "pay-test", orderId: "test-order", status: "confirmed", outTradeNo: "PT_PAY", externalTransactionId: "wx-trans-test" }] });
  const logistics = createKuaidi100({ env: {}, clock: () => new Date(at) });
  const service = createService({ store, catalogSource: async () => [], logistics, now: () => new Date(at) });
  const signed = body => { const param = JSON.stringify(body); return { param, sign: crypto.createHash("md5").update(param + salt).digest("hex").toUpperCase() }; };
  const snapshot = (state, context) => signed({ status: state === "3" ? "shutdown" : "polling", lastResult: { com: "shunfeng", nu: "SF1234567890", state, data: [{ ftime: "2026-11-15 12:00:00", context }] } });
  return { at, store, service, logistics, signed, snapshot };
}

test("real K100 parsing preserves subscription version, shipment identity and business state", async () => {
  const f = fixture();
  await f.service.receiveLogisticsNotification("ship-test:1", f.snapshot("1", "快递已揽收"));
  await f.service.receiveLogisticsNotification("ship-test:1", f.snapshot("3", "快递已签收"));
  const state = f.store.snapshot();
  assert.equal(state.shipments[0].version, 1, "snapshot writes cannot invalidate callback identity");
  assert.equal(state.shipments[0].logisticsStatus, "signed"); assert.equal(state.orders[0].status, "awaiting_receipt");
  const again = await f.service.receiveLogisticsNotification("ship-test:1", f.snapshot("3", "快递已签收"));
  assert.equal(again.duplicate, true);
});

test("signed monitor abort keeps reliable events and withdrawal isolates old callbacks", async () => {
  const f = fixture();
  await f.service.receiveLogisticsNotification("ship-test:1", f.snapshot("0", "运输中"));
  await f.service.receiveLogisticsNotification("ship-test:1", f.signed({ status: "abort", message: "跟踪中止" }));
  assert.equal(f.store.snapshot().shipments[0].logisticsStatus, "in_transit");
  assert.equal(f.store.snapshot().shipments[0].events[0].context, "运输中");
  assert.equal(f.store.snapshot().shipments[0].monitorStatus, "abort");
  await f.store.transaction(state => { state.shipments[0].active = false; state.orders[0].status = "closed"; });
  const result = await f.service.receiveLogisticsNotification("ship-test:1", f.snapshot("3", "迟到签收"));
  assert.equal(result.archived, true); assert.equal(f.store.snapshot().orders[0].status, "closed");
  assert.equal(f.store.snapshot().shipments[0].events[0].context, "运输中");
});

test("verified WeChat receipt completes only current matching package and remains frozen during after-sale", async () => {
  const f = fixture();
  const shipping = createWechatShipping({ env: { WECHAT_SHIPPING_ENABLED: "true", WX_APP_ID: "wx-test", WECHAT_SHIPPING_CARRIER_MAP: '{"shunfeng":"SF"}' },
    clock: () => new Date(f.at), tokenProvider: async () => "test-token", request: async () => ({ errcode: 0, order: {
      transaction_id: "wx-trans-test", merchant_trade_no: "PT_PAY", openid: "buyer-test", order_state: 3,
      shipping: { finish_shipping: true, shipping_list: [{ tracking_no: "SF1234567890", express_company: "SF", upload_time: 1794715200 }] }
    } }) });
  const state = f.store.snapshot(), order = { ...state.orders[0], payment: state.payments[0] };
  const update = await shipping.queryReceipt(order, state.shipments[0]);
  assert.equal(update.received, true);
  await f.store.transaction(data => { data.afterSales.push({ id: "sale-test", orderId: order.id, status: "pending" }); });
  await f.service.applyWechatReceipt({ ...update, orderId: order.id });
  assert.equal(f.store.snapshot().orders[0].status, "awaiting_receipt");
  assert.equal(f.store.snapshot().orders[0].platformReceipt.received, true);
  await f.store.transaction(data => { data.afterSales[0].status = "rejected"; });
  await f.service.applyWechatReceipt({ ...update, orderId: order.id });
  assert.equal(f.store.snapshot().orders[0].status, "completed");
  const count = f.store.snapshot().audit.filter(item => item.action === "receipt").length;
  await f.service.applyWechatReceipt({ ...update, orderId: order.id });
  assert.equal(f.store.snapshot().audit.filter(item => item.action === "receipt").length, count);
});
