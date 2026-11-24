"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createKuaidi100, validateShipment } = require("../lib/kuaidi100.cjs");
const { createWechatShipping } = require("../lib/wechatShipping.cjs");
const { createPhysicalWorker } = require("../lib/physicalWorker.cjs");

const clock = () => new Date("2026-11-15T04:00:00.000Z");
const shipment = () => ({ id: "sh_test", version: 2, carrierCode: "shunfeng", trackingNo: "SF1234567890", phone: "13800138000", subscriptionSalt: "test-subscription-salt-32-characters", active: true });
const kdEnv = { KUAIDI100_KEY: "test-key", KUAIDI100_CUSTOMER: "test-customer", KUAIDI100_CALLBACK_URL: "https://example.test/api/physical/logistics/kuaidi100/notify" };
const wxEnv = { WECHAT_SHIPPING_ENABLED: "true", WX_APP_ID: "wx-test", WECHAT_PAY_MCH_ID: "merchant-test", WECHAT_SHIPPING_CARRIER_MAP: '{"shunfeng":"SF"}' };
const order = () => ({ id: "o_test", orderNo: "PW_TEST", openid: "test-openid", payment: { externalTransactionId: "wx-transaction", outTradeNo: "physical-pay" }, items: [{ name: "相册", quantity: 2 }] });
const wxOrder = state => ({ errcode: 0, order: { transaction_id: "wx-transaction", merchant_trade_no: "physical-pay", merchant_id: "merchant-test", openid: "test-openid", order_state: state,
  shipping: { finish_shipping: true, finish_shipping_count: 1, shipping_list: [{ tracking_no: "SF1234567890", express_company: "SF", upload_time: 1794715200 }] } } });
const trackedShipment = () => ({ ...shipment(), collectedAt: "2026-11-15T03:30:00Z", wechatUploadRequestAt: clock().toISOString(), wechatUploadedAt: clock().toISOString() });

test("shipping number accepts carrier letters and rejects empty/markup values", () => {
  assert.deepEqual(validateShipment(shipment()), { company: "shunfeng", number: "SF1234567890" });
  for (const number of ["", "   ", "<script>", "SF123\n45"]) assert.throws(() => validateShipment({ ...shipment(), trackingNo: number }), { code: "PHYSICAL_TRACKING_INVALID" });
});

test("subscription uses the persisted salt and version callback identity", async () => {
  let request;
  const provider = createKuaidi100({ env: kdEnv, request: async input => { request = input; return { result: true, returnCode: "200" }; } });
  const result = await provider.subscribe(shipment());
  const param = JSON.parse(new URLSearchParams(request.body).get("param"));
  assert.equal(result.status, "subscribed"); assert.equal(param.parameters.salt, shipment().subscriptionSalt);
  assert.equal(new URL(param.parameters.callbackurl).searchParams.get("subscriptionId"), "sh_test:2");
  assert.equal(param.parameters.phone, "13800138000");
  assert.equal(param.company, "shunfeng");
  await assert.rejects(provider.subscribe({ ...shipment(), subscriptionSalt: "" }), { code: "KUAIDI100_SUBSCRIPTION_INVALID" });
});

test("duplicate subscription and depleted quota never claim a healthy new tracking version", async () => {
  for (const providerCode of ["501", "601"]) {
    const provider = createKuaidi100({ env: kdEnv, request: async () => ({ result: false, returnCode: providerCode }) });
    await assert.rejects(provider.subscribe(shipment()), error => error.providerCode === providerCode && error.retryable === false);
  }
});

test("notification verifies signature and stored shipment before projecting deduplicated events", () => {
  const provider = createKuaidi100({ env: {}, clock });
  const event = { ftime: "2026-11-15 10:00:00", context: "运输中" };
  const param = JSON.stringify({ status: "shutdown", lastResult: { com: "shunfeng", nu: "SF1234567890", state: "3", data: [event, { ftime: "2026-11-15 11:00:00", context: "已签收" }, event] } });
  const sign = crypto.createHash("md5").update(param + shipment().subscriptionSalt).digest("hex").toUpperCase();
  const normalized = provider.parseNotification({ param, sign }, shipment());
  assert.equal(normalized.signed, true); assert.equal(normalized.events.length, 2); assert.equal(normalized.events[0].context, "已签收");
  assert.equal(normalized.collectedAt, null, "signing time cannot be fabricated as collection time");
  assert.equal(normalized.shipmentId, "sh_test"); assert.equal(normalized.version, 2);
  assert.throws(() => provider.parseNotification({ param: param + " ", sign }, shipment()), { code: "KUAIDI100_SIGNATURE_INVALID" });
  assert.throws(() => provider.parseNotification({ param, sign }, { ...shipment(), trackingNo: "SF0000000000" }), { code: "KUAIDI100_SHIPMENT_MISMATCH" });
  assert.throws(() => provider.parseNotification({ param, sign }, { ...shipment(), subscriptionSalt: "changed-secret-32-characters" }), { code: "KUAIDI100_SIGNATURE_INVALID" });
});

test("ordinary tracking query signs request and rejects mismatched returned tracking numbers", async () => {
  let sent;
  const provider = createKuaidi100({ env: kdEnv, clock, request: async input => { sent = new URLSearchParams(input.body); return { status: "200", com: "shunfeng", nu: "SF1234567890", state: "0", data: [] }; } });
  const result = await provider.query(shipment());
  assert.equal(result.logisticsStatus, "in_transit");
  assert.equal(sent.get("sign"), crypto.createHash("md5").update(sent.get("param") + kdEnv.KUAIDI100_KEY + kdEnv.KUAIDI100_CUSTOMER).digest("hex").toUpperCase());
  const bad = createKuaidi100({ env: kdEnv, request: async () => ({ status: "200", com: "shunfeng", nu: "other-number", data: [] }) });
  await assert.rejects(bad.query(shipment()), { code: "KUAIDI100_SHIPMENT_MISMATCH" });
});

test("signed subscription abort preserves tracking by reporting monitor-only failure", () => {
  const provider = createKuaidi100({ env: {}, clock });
  const param = JSON.stringify({ status: "abort", message: "3天查询无记录" });
  const sign = crypto.createHash("md5").update(param + shipment().subscriptionSalt).digest("hex");
  const result = provider.parseNotification({ param, sign }, shipment());
  assert.equal(result.monitorOnly, true); assert.equal(result.monitorStatus, "abort");
  assert.equal(result.events, undefined); assert.equal(result.logisticsStatus, undefined);
});

test("WeChat upload requires actual handover evidence and a separate carrier mapping", async () => {
  let calls = 0, body;
  const provider = createWechatShipping({ env: wxEnv, clock, tokenProvider: async () => "test-token", request: async input => { calls++; body = JSON.parse(input.body); return { errcode: 0 }; } });
  await assert.rejects(provider.upload(shipment(), order()), { code: "WECHAT_SHIPPING_AWAITING_HANDOVER" });
  assert.equal(calls, 0);
  const result = await provider.upload(trackedShipment(), order());
  assert.equal(body.logistics_type, 1); assert.equal(body.delivery_mode, 1); assert.equal(body.shipping_list[0].express_company, "SF");
  assert.equal(body.shipping_list[0].contact.receiver_contact, "****8000"); assert.equal(body.payer.openid, "test-openid");
  assert.equal(result.uploadedAt, clock().toISOString());
  await provider.upload(trackedShipment(), order()); assert.equal(body.upload_time, result.uploadedAt, "retries use the saved version upload time");
  const unmapped = createWechatShipping({ env: { ...wxEnv, WECHAT_SHIPPING_CARRIER_MAP: "{}" }, tokenProvider: async () => "x" });
  await assert.rejects(unmapped.upload(trackedShipment(), order()), { code: "WECHAT_SHIPPING_CARRIER_UNMAPPED" });
});

test("WeChat receipt needs exact trusted payment, payer, carrier, tracking and uploaded version", async () => {
  const provider = response => createWechatShipping({ env: wxEnv, clock, tokenProvider: async () => "test-token", request: async () => response });
  const good = await provider(wxOrder(3)).queryReceipt(order(), trackedShipment());
  assert.equal(good.received, true); assert.equal(good.mode, "unknown"); assert.equal(good.confirmedAt, null);
  for (const state of [1, 2, 4, 5, 6]) assert.equal((await provider(wxOrder(state)).queryReceipt(order(), trackedShipment())).received, false, `state ${state} does not prove receipt`);
  assert.equal((await provider(wxOrder(3)).queryReceipt(order(), { ...trackedShipment(), trackingNo: "SF9999999999" })).received, false);
  assert.equal((await provider(wxOrder(3)).queryReceipt(order(), { ...trackedShipment(), wechatUploadedAt: "2026-11-15T05:00:00Z" })).received, false);
  assert.equal((await provider(wxOrder(3)).queryReceipt(order(), shipment())).received, false, "missing upload association must not complete current version");
  const wrong = wxOrder(3); wrong.order.openid = "another-user";
  await assert.rejects(provider(wrong).queryReceipt(order(), trackedShipment()), { code: "WECHAT_SHIPPING_ORDER_MISMATCH" });
  const complaint = wxOrder(3); complaint.order.in_complaint = true;
  assert.equal((await provider(complaint).queryReceipt(order(), trackedShipment())).received, false);
});

test("physical worker never overlaps ticks and stop drains pending work", async () => {
  let release, calls = 0;
  const service = { processPendingTasks: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
  const worker = createPhysicalWorker({}, { service, env: {} });
  const first = worker.runOnce(), second = worker.runOnce();
  await Promise.resolve(); assert.equal(calls, 1);
  let stopped = false; const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release({ processed: 1 }); await Promise.all([first, second, stopping]); assert.equal(stopped, true);
  assert.deepEqual(await worker.runOnce(), { skipped: true });
});
