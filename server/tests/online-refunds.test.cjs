"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createWechatPay, refundAmountInFen, enqueueMerchantShare, drainMerchantShare } = require("../lib/wechatPay.cjs");
const { startRefund, applyRefundResult } = require("../lib/onlineRefunds.cjs");
const { createTestRefundGateway } = require("./helpers/wechatPay.cjs");
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function source() {
  const rows = { orders: {}, afterSales: {}, logs: {} };
  return { rows,
    async get(key, id) { return copy(rows[key]?.[id]) || null; },
    async list(key) { return Object.values(rows[key] || {}).map(copy); },
    async create(key, row) { rows[key] ||= {}; rows[key][row.id] = copy(row); return copy(row); },
    async update(key, id, patch) { if (!rows[key]?.[id]) return null; return copy(rows[key][id] = { ...rows[key][id], ...copy(patch) }); },
    async compareAndUpdate(key, id, expected, patch) {
      if (!rows[key]?.[id] || !Object.entries(expected).every(([field, value]) => JSON.stringify(rows[key][id][field]) === JSON.stringify(value))) return null;
      return this.update(key, id, patch);
    },
  };
}
function order(extra = {}) {
  return { id: "order", openid: "customer", statusLogs: [], followRecords: [], status: "deposit_paid", workflowStage: "awaiting_dispatch", depositPaid: 100,
    depositFinanceStatus: "已审", afterSaleId: "ticket", afterSaleStatus: "pending",
    paymentRecords: [{ id: "pay", provider: "wechat_pay", phase: "deposit", status: "confirmed", amount: 100, outTradeNo: "PAY123456", externalTransactionId: "WXTX123456" }], ...extra };
}
function ticket(extra = {}) { return { id: "ticket", orderId: "order", refundPhase: "deposit", reviewLane: "pre_dispatch", refundAmount: 100, financeStatus: "已审", refundStatus: "pending_review", reason: "行程变更申请退款", ...extra }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function timely(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("receipt waited for share attribution work")), 500); })]); }
  finally { clearTimeout(timer); }
}
function finalOrder() {
  return order({ status: "shooting", workflowStage: "shooting", depositDue: 100, finalDue: 40, finalPaid: 0, totalAmount: 140,
    shootingCompletedAt: "2026-11-06T03:00:00Z", afterSaleId: "", afterSaleStatus: "",
    paymentRecords: [...order().paymentRecords, { id: "final", phase: "final", amount: 40, status: "pending", provider: "wechat_pay", outTradeNo: "FINAL_PAY_123456", sessionStartAt: "2026-11-06T03:00:00.000Z", sessionId: "trusted-original-session" }] });
}
function finalTransaction() { return { appid: config.appId, mchid: config.mchId, outTradeNo: "FINAL_PAY_123456", transactionId: "WXFINAL1",
  tradeState: "SUCCESS", tradeType: "JSAPI", amountTotal: 4000, amountCurrency: "CNY", payerOpenid: "customer", successTime: "2026-11-06T12:00:00+08:00" }; }
function result(request, status = "PROCESSING") {
  return { refundNo: request.refundNo, refundId: `wx-${request.refundNo}`, outTradeNo: request.payment.outTradeNo,
    transactionId: request.payment.externalTransactionId, amount: refundAmountInFen(request.amount), total: refundAmountInFen(request.payment.amount),
    currency: "CNY", status, ...(status === "SUCCESS" ? { successTime: "2026-11-06T12:00:00+08:00" } : {}) };
}
function provider() {
  const created = [], existing = new Map();
  return { created, existing, isConfigured: () => true,
    async queryRefund(id) { if (!existing.has(id)) throw Object.assign(new Error("not found"), { code: "WECHAT_PAY_REFUND_NOT_FOUND" }); return copy(existing.get(id)); },
    async createRefund(request) { created.push(request); const value = result(request); existing.set(value.refundNo, value); return copy(value); },
  };
}
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = { mchId: "1900000001", appId: "wx123", merchantSerialNo: "MCH_SERIAL", apiV3Key: "0123456789abcdef0123456789abcdef",
  merchantPrivateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }), platformPublicKeyId: "PUB_KEY_ID_TEST",
  platformPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }), notifyUrl: "https://example.test/api/payments/wechat/notify", apiHost: "api.mch.weixin.qq.com" };
function headers(body) {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "fixture-nonce";
  return { "wechatpay-serial": config.platformPublicKeyId, "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce,
    "wechatpay-signature": crypto.sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey).toString("base64") };
}
function notification(value) {
  const nonce = "0123456789ab", aad = "refund";
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(config.apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const body = JSON.stringify({ event_type: `REFUND.${value.refund_status}`, resource_type: "encrypt-resource",
    resource: { algorithm: "AEAD_AES_256_GCM", original_type: "refund", nonce, associated_data: aad, ciphertext } });
  return { body, headers: headers(body) };
}
function raw(value) {
  return { mchid: config.mchId, out_refund_no: value.refundNo, refund_id: value.refundId, out_trade_no: value.outTradeNo,
    transaction_id: value.transactionId, status: value.status, refund_status: value.status, success_time: value.successTime,
    amount: { refund: value.amount, total: value.total, currency: "CNY" } };
}

test("refund money validation accepts exact cents and rejects rounding, negatives and unsafe integers", () => {
  assert.equal(refundAmountInFen("0.01"), 1);
  assert.equal(refundAmountInFen(100.1), 10010);
  for (const value of [0, -1, "1.001", "1e2", "NaN", "9007199254740992.00"]) assert.throws(() => refundAmountInFen(value));
});

test("API v3 refund requests use signed integer amounts and verify signed response identities", async () => {
  const payment = order().paymentRecords[0];
  let request;
  const gateway = createWechatPay({ config, transport: async (input) => {
    request = input;
    const payload = JSON.parse(input.body);
    const body = JSON.stringify(raw(result({ refundNo: payload.out_refund_no, amount: payload.amount.refund / 100, payment })));
    return { statusCode: 200, body, headers: headers(body) };
  } });
  assert.equal(gateway.isConfigured(), true, gateway.configurationErrors().join(","));
  const value = await gateway.createRefund({ payment, refundNo: "REFUND_123456", amount: "25.12", reason: "退款" });
  assert.equal(value.status, "PROCESSING");
  assert.equal(request.path, "/v3/refund/domestic/refunds");
  assert.match(request.headers.Authorization, /^WECHATPAY2/);
  assert.equal(request.headers.Accept, "application/json");
  assert.match(request.headers["User-Agent"], /^[A-Za-z0-9._-]+\/\d+\.\d+\.\d+$/);
  assert.deepEqual(JSON.parse(request.body).amount, { refund: 2512, total: 10000, currency: "CNY" });
  assert.equal(JSON.parse(request.body).notify_url, "https://example.test/api/payments/wechat/refund-notify");
  await assert.rejects(() => gateway.createRefund({ payment, refundNo: "REFUND_123456", amount: "100.01" }));
});

test("a refund blocked by request headers recovers the CREATED attempt with the original number and cents", async () => {
  const db = source();
  const payment = { ...order().paymentRecords[0], amount: 0.09 };
  await db.create("orders", order({ depositPaid: 0.09, paymentRecords: [payment] }));
  await db.create("afterSales", ticket({ refundAmount: 0.09 }));
  const rejectedRequests = [];
  const rejectedGateway = createWechatPay({ config, transport: async request => {
    rejectedRequests.push(request);
    return { statusCode: 400, headers: {}, body: JSON.stringify({ code: "INVALID_REQUEST", message: "Http头缺少Accept或User-Agent" }) };
  } });
  await assert.rejects(() => startRefund(db, "ticket", { wechatPay: rejectedGateway }),
    error => error.code === "WECHAT_PAY_API_ERROR" && error.providerCode === "INVALID_REQUEST");
  assert.deepEqual(rejectedRequests.map(request => request.method), ["GET"], "an invalid request must not trigger a refund POST");
  const pending = await db.get("afterSales", "ticket");
  assert.equal(pending.refundError, "WECHAT_PAY_API_ERROR");
  assert.equal(pending.refundAttempts[0].status, "CREATED");
  const originalRefundNo = pending.refundAttempts[0].refundNo;
  const gateway = createTestRefundGateway(db, { onRequest(request) {
    assert.equal(request.headers.Accept, "application/json");
    assert.match(request.headers["User-Agent"], /^[A-Za-z0-9._-]+\/\d+\.\d+\.\d+$/);
  } });
  const recovered = await startRefund(db, "ticket", { wechatPay: gateway });
  assert.deepEqual(gateway.refundRequests.map(request => request.method), ["GET", "POST"]);
  assert.equal(gateway.refundRequests[0].path, `/v3/refund/domestic/refunds/${originalRefundNo}`);
  const submitted = JSON.parse(gateway.refundRequests[1].body);
  assert.equal(submitted.out_refund_no, originalRefundNo);
  assert.deepEqual(submitted.amount, { refund: 9, total: 9, currency: "CNY" });
  assert.equal(recovered.refundConfirmed, true);
  assert.equal(recovered.refundError, "");
  assert.equal(recovered.refundedAmount, 0.09);
  assert.equal(recovered.refundAttempts.length, 1);
  assert.equal(recovered.refundAttempts[0].refundNo, originalRefundNo);
  assert.equal((await gateway.queryRefund(originalRefundNo)).status, "SUCCESS");
  await startRefund(db, "ticket", { wechatPay: gateway });
  assert.equal(gateway.refundRequests.filter(request => request.method === "POST").length, 1, "recovery must not refund twice");
});

test("processing is not a completed refund; verified callbacks are idempotent and cancel only on success", async () => {
  const db = source(), pay = provider();
  await db.create("orders", order()); await db.create("afterSales", ticket());
  const pending = await startRefund(db, "ticket", { wechatPay: pay });
  assert.equal(pending.refundStatus, "processing"); assert.equal(pending.refundConfirmed, false);
  assert.equal((await db.get("orders", "order")).status, "deposit_paid");
  const reply = { ...pay.existing.get(pending.refundAttempts[0].refundNo), status: "SUCCESS", successTime: "2026-11-06T12:00:00+08:00" };
  const gateway = createWechatPay({ config, transport: async () => { throw new Error("no network"); } });
  const event = notification(raw(reply));
  assert.throws(() => gateway.parseRefundNotification(event.headers, event.body + " "));
  const wrong = notification({ ...raw(reply), mchid: "foreign-merchant" });
  assert.throws(() => gateway.parseRefundNotification(wrong.headers, wrong.body));
  await gateway.confirmRefundCallback(db, event.headers, event.body);
  await gateway.confirmRefundCallback(db, event.headers, event.body);
  const saved = await db.get("afterSales", "ticket"), savedOrder = await db.get("orders", "order");
  assert.equal(saved.refundConfirmed, true); assert.equal(saved.refundedAmount, 100);
  assert.equal(savedOrder.onlineRefundedAmount, 100); assert.equal(savedOrder.status, "cancelled");
  assert.equal(savedOrder.depositPaid, 100, "original receipt evidence remains unchanged");
  await applyRefundResult(db, { ...reply, status: "PROCESSING" });
  assert.equal((await db.get("afterSales", "ticket")).refundStatus, "refunded");
  await startRefund(db, "ticket", { wechatPay: pay });
  assert.equal(pay.created.length, 1, "retry never issues a second refund");
});

test("a timeout preserves the refund number and later query confirms instead of resubmitting", async () => {
  const db = source(), pay = provider();
  await db.create("orders", order()); await db.create("afterSales", ticket());
  const normal = pay.createRefund.bind(pay);
  pay.createRefund = async (request) => { const value = await normal(request); pay.existing.set(value.refundNo, { ...value, status: "SUCCESS", successTime: "2026-11-06T12:00:00+08:00" }); throw Object.assign(new Error("timeout"), { code: "WECHAT_PAY_NETWORK_ERROR" }); };
  await assert.rejects(() => startRefund(db, "ticket", { wechatPay: pay }));
  assert.equal((await db.get("afterSales", "ticket")).refundConfirmed, false);
  const recovered = await startRefund(db, "ticket", { wechatPay: pay });
  assert.equal(recovered.refundConfirmed, true); assert.equal(pay.created.length, 1);
});

test("multi-payment refunds retain successful partial amounts and reject concurrent over-refunds", async () => {
  const db = source(), pay = provider();
  const base = order({ status: "completed", workflowStage: "completed", paymentRecords: [
    { ...order().paymentRecords[0], amount: 40 },
    { ...order().paymentRecords[0], id: "final", phase: "final", amount: 60, outTradeNo: "PAYFINAL123", externalTransactionId: "WXFINAL123" },
  ] });
  await db.create("orders", base); await db.create("afterSales", ticket({ refundPhase: "all", reviewLane: "general", refundAmount: 80 }));
  let created = 0;
  const normal = pay.createRefund.bind(pay);
  pay.createRefund = async (request) => { const reply = await normal(request); if (++created === 1) { reply.status = "SUCCESS"; reply.successTime = "2026-11-06T12:00:00+08:00"; pay.existing.set(reply.refundNo, reply); } return reply; };
  const partial = await startRefund(db, "ticket", { wechatPay: pay });
  assert.equal(partial.refundConfirmed, false); assert.equal(partial.refundedAmount, 60);
  assert.equal((await db.get("orders", "order")).onlineRefundedAmount, 60);
  await db.create("afterSales", ticket({ id: "other", refundPhase: "all", reviewLane: "general", refundAmount: 30 }));
  await assert.rejects(() => startRefund(db, "other", { wechatPay: pay }), /可退余额/);
  const remaining = partial.refundAttempts.find((row) => row.status === "PROCESSING");
  const reply = { ...pay.existing.get(remaining.refundNo), status: "SUCCESS", successTime: "2026-11-07T12:00:00+08:00" };
  await applyRefundResult(db, reply);
  assert.equal((await db.get("orders", "order")).onlineRefundedAmount, 80);
});

test("assignment blocks executing a pre-dispatch deposit refund before any provider request", async () => {
  const db = source(), pay = provider();
  await db.create("orders", order({ photographerId: "photographer" })); await db.create("afterSales", ticket());
  await assert.rejects(() => startRefund(db, "ticket", { wechatPay: pay }), /摄影师已安排/);
  assert.equal(pay.created.length, 0);
});

test("final payment persists a share retry marker and idempotent callback retries enqueue without recalculation", async () => {
  const db = source(), jobs = [];
  let unavailable = true;
  require("../lib/merchantShare.cjs").serviceFor(db, { enableAt: "2026-01-01T00:00:00Z", store: {
    async enqueuePayment(input) { if (unavailable) throw new Error("share storage down"); jobs.push(input); return { queued: true }; },
  } });
  const value = order({ status: "shooting", workflowStage: "shooting", depositDue: 100, finalDue: 40, finalPaid: 0, totalAmount: 140,
    shootingCompletedAt: "2026-11-06T03:00:00Z", afterSaleId: "", afterSaleStatus: "",
    paymentRecords: [...order().paymentRecords, { id: "final", phase: "final", amount: 40, status: "pending", provider: "wechat_pay", outTradeNo: "FINAL_PAY_123456", sessionStartAt: "2026-11-06T03:00:00.000Z", sessionId: "trusted-callback-original-session" }] });
  await db.create("orders", value);
  const gateway = createWechatPay({ config, transport: async () => { throw new Error("no network"); } });
  const transaction = { appid: config.appId, mchid: config.mchId, outTradeNo: "FINAL_PAY_123456", transactionId: "WXFINAL1",
    tradeState: "SUCCESS", tradeType: "JSAPI", amountTotal: 4000, amountCurrency: "CNY", payerOpenid: "customer", successTime: "2026-11-06T12:00:00+08:00" };
  await gateway.confirmTransaction(db, transaction);
  assert.equal((await db.get("orders", "order")).status, "completed", "share outage does not reject receipt");
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true);
  await drainMerchantShare(db);
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true, "a background failure preserves the durable retry marker");
  assert.equal(jobs.length, 0);
  unavailable = false;
  await gateway.confirmTransaction(db, transaction);
  await drainMerchantShare(db);
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, false);
  assert.equal((await db.get("orders", "order")).finalPaymentSessionStartAt, "2026-11-06T03:00:00.000Z", "callback preserves the request session rather than its own receive time");
  assert.equal((await db.get("orders", "order")).finalPaymentSessionId, "trusted-callback-original-session");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].paidTotal, "140.00");
  assert.equal(jobs[0].payTime, transaction.successTime);
});

test("zero final balance queues the paid whole order exactly once on acknowledgement", async () => {
  const db = source(), jobs = [], clicks = [];
  require("../lib/merchantShare.cjs").serviceFor(db, { enableAt: "2026-01-01T00:00:00Z", store: {
    async enqueuePayment(input) { jobs.push(input); return { queued: true }; },
    async getCsLink(linkId) { return { linkId, wecomUserId: "verified-wecom-staff", staffId: "platform-staff", status: "ACTIVE", expiresAt: new Date(Date.now() + 86400000).toISOString() }; },
    async reportClick(input) { clicks.push(input); return { click: { id: "verified-click" } }; },
  } });
  await db.create("orders", order({ status: "shooting", workflowStage: "shooting", depositDue: 100, finalDue: 0, totalAmount: 100,
    shootingCompletedAt: "2026-11-06T03:00:00Z", afterSaleId: "", afterSaleStatus: "" }));
  const rpc = require("../lib/rpc.cjs");
  const body = { data: { orderId: "order", phase: "final", selectionAccepted: true, idempotencyKey: "zero-balance-key", sessionStartAt: "1900-01-01T00:00:00Z", sessionId: "forged-body-session" } };
  const ctx = { identity: { kind: "public", openid: "customer", createdAt: Date.parse("2026-11-06T03:00:00Z"), sessionId: "trusted-zero-session" } };
  const click = await rpc(db, "reportShareClick", { data: { linkId: "server-issued-link", staffWecomId: "verified-wecom-staff", sessionId: "forged-body-session" } }, ctx);
  assert.equal(click.success, true, JSON.stringify(click));
  assert.equal(clicks[0].sessionId, ctx.identity.sessionId, "click and final payment must use the same trusted session identity");
  const first = await rpc(db, "createPayment", body, ctx), second = await rpc(db, "createPayment", body, ctx);
  assert.equal(first.success, true, JSON.stringify(first)); assert.equal(second.success, true);
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true);
  await drainMerchantShare(db);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].paidTotal, "100.00");
  const saved = await db.get("orders", "order");
  assert.equal(saved.finalPaymentSessionStartAt, "2026-11-06T03:00:00.000Z");
  assert.equal(saved.paymentRecords.find(row => row.provider === "zero_balance").sessionStartAt, "2026-11-06T03:00:00.000Z");
  assert.equal(saved.finalPaymentSessionId, "trusted-zero-session");
  assert.equal(saved.paymentRecords.find(row => row.provider === "zero_balance").sessionId, "trusted-zero-session");
  assert.equal(jobs[0].sessionId, clicks[0].sessionId, "only-session attribution receives the click's session in the actual queued event");
});

test("final receipt and ten replays return before stalled share work; only one delivery runs and the marker clears after success", async t => {
  const db = source(), gate = deferred(), started = deferred(), jobs = [];
  t.after(async () => { gate.resolve(); await drainMerchantShare(db); });
  require("../lib/merchantShare.cjs").serviceFor(db, { enableAt: "2026-01-01T00:00:00Z", store: {
    async enqueuePayment(input) { jobs.push(input); started.resolve(); await gate.promise; return { queued: true }; },
  } });
  await db.create("orders", finalOrder());
  const gateway = createWechatPay({ config, transport: async () => { throw new Error("no network"); } });
  const result = await timely(gateway.confirmTransaction(db, finalTransaction()));
  assert.equal(result.order.status, "completed"); assert.equal(result.order.finalPaid, 40);
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true);
  await timely(started.promise);
  const replayed = await timely(Promise.all(Array.from({ length: 10 }, () => gateway.confirmTransaction(db, finalTransaction()))));
  assert.equal(replayed.every(row => row.idempotent), true);
  assert.equal(jobs.length, 1, "callbacks cannot start parallel attribution for one order");
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true, "a pending share promise cannot clear the marker");
  gate.resolve(); await drainMerchantShare(db);
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, false);
});

test("zero-balance completion and replay return before share timeout; failure keeps the marker and a later retry can deliver", async t => {
  const db = source(), gate = deferred(), started = deferred();
  t.after(async () => { gate.resolve(); await drainMerchantShare(db); });
  let tries = 0, unavailable = true;
  require("../lib/merchantShare.cjs").serviceFor(db, { enableAt: "2026-01-01T00:00:00Z", store: {
    async enqueuePayment() { tries++; if (unavailable) { started.resolve(); await gate.promise; } return { queued: true }; },
  } });
  await db.create("orders", order({ status: "shooting", workflowStage: "shooting", depositDue: 100, finalDue: 0, totalAmount: 100,
    shootingCompletedAt: "2026-11-06T03:00:00Z", afterSaleId: "", afterSaleStatus: "" }));
  const rpc = require("../lib/rpc.cjs");
  const body = { data: { orderId: "order", phase: "final", selectionAccepted: true, idempotencyKey: "nonblocking-zero-key" } };
  const context = { identity: { kind: "public", openid: "customer" } };
  assert.equal((await timely(rpc(db, "createPayment", body, context))).success, true);
  await timely(started.promise);
  assert.equal((await timely(rpc(db, "createPayment", body, context))).success, true);
  assert.equal(tries, 1);
  assert.equal((await db.get("orders", "order")).status, "completed");
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true);
  gate.reject(Object.assign(new Error("synthetic share timeout"), { code: "ETIMEDOUT" }));
  const failures = await drainMerchantShare(db);
  assert.equal(failures[0].failed, true); assert.equal(failures[0].code, "ETIMEDOUT");
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true);
  unavailable = false;
  assert.equal((await timely(rpc(db, "createPayment", body, context))).success, true);
  await drainMerchantShare(db);
  assert.equal(tries, 2); assert.equal((await db.get("orders", "order")).shareEnqueuePending, false);
});

test("background delivery re-reads stored receipt amounts instead of trusting its caller snapshot", async () => {
  const db = source(), jobs = [];
  require("../lib/merchantShare.cjs").serviceFor(db, { enableAt: "2026-01-01T00:00:00Z", store: { async enqueuePayment(input) { jobs.push(input); return { queued: true }; } } });
  const saved = finalOrder();
  Object.assign(saved, { status: "completed", finalPaid: 40, finalPaidAt: "2026-11-06T04:00:00Z", shareEnqueuePending: true });
  Object.assign(saved.paymentRecords.find(row => row.phase === "final"), { status: "confirmed" });
  await db.create("orders", saved);
  const scheduled = enqueueMerchantShare(db, { ...saved, depositPaid: 99999, finalPaid: 99999 });
  assert.equal(scheduled.scheduled, true); assert.equal(jobs.length, 0, "even module loading and DB reads are deferred");
  await db.update("orders", "order", { customer: "fresh stored customer" });
  await drainMerchantShare(db);
  assert.equal(jobs[0].paidTotal, "140.00"); assert.equal(jobs[0].display.customer, "fresh stored customer");
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, false);
});

test("old receipts before enable time finish their marker asynchronously without running attribution", async () => {
  const db = source();
  require("../lib/merchantShare.cjs").serviceFor(db, { enableAt: "2099-01-01T00:00:00Z", store: { async enqueuePayment() { assert.fail("pre-launch receipt must be skipped"); } } });
  const saved = finalOrder();
  Object.assign(saved, { status: "completed", finalPaid: 40, finalPaidAt: "2026-11-06T04:00:00Z", shareEnqueuePending: true });
  Object.assign(saved.paymentRecords.find(row => row.phase === "final"), { status: "confirmed" });
  await db.create("orders", saved);
  enqueueMerchantShare(db, saved);
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, true);
  const delivered = await drainMerchantShare(db);
  assert.equal(delivered[0].skipped, true); assert.equal(delivered[0].reason, "BEFORE_ENABLE");
  assert.equal((await db.get("orders", "order")).shareEnqueuePending, false);
});

test("a background marker write failure keeps the receipt retryable after a successful share insert", async () => {
  const db = source();
  require("../lib/merchantShare.cjs").serviceFor(db, { enableAt: "2026-01-01T00:00:00Z", store: { async enqueuePayment() { return { queued: true }; } } });
  const saved = finalOrder();
  Object.assign(saved, { status: "completed", finalPaid: 40, finalPaidAt: "2026-11-06T04:00:00Z", shareEnqueuePending: true });
  Object.assign(saved.paymentRecords.find(row => row.phase === "final"), { status: "confirmed" });
  await db.create("orders", saved);
  const update = db.update.bind(db);
  db.update = async (key, id, patch) => { if (patch.shareEnqueuePending === false) throw Object.assign(new Error("synthetic marker storage failure"), { code: "ECONNRESET" }); return update(key, id, patch); };
  enqueueMerchantShare(db, saved);
  const failures = await drainMerchantShare(db);
  assert.equal(failures[0].failed, true); assert.equal((await db.get("orders", "order")).shareEnqueuePending, true);
});

test("final prepay captures only the verified public session and does not replace it on a reused intent", async () => {
  const db = source();
  await db.create("orders", order({ status: "shooting", workflowStage: "shooting", depositDue: 100, finalDue: 40, finalPaid: 0,
    shootingCompletedAt: "2026-11-06T03:00:00Z", afterSaleId: "", afterSaleStatus: "" }));
  const rpc = require("../lib/rpc.cjs");
  const body = { data: { orderId: "order", phase: "final", selectionAccepted: true, idempotencyKey: "session-final-key", createdAt: "1900-01-01", sessionStartAt: "1900-01-01", sessionId: "forged-body-session" } };
  const ctx = { identity: { kind: "public", openid: "customer", createdAt: Date.parse("2026-11-06T03:00:00Z"), sessionId: "trusted-original-session" }, wechatPay: require("./helpers/wechatPay.cjs").createTestWechatPay() };
  const first = await rpc(db, "createPayment", body, ctx);
  assert.equal(first.success, true, JSON.stringify(first));
  const second = await rpc(db, "createPayment", body, { ...ctx, identity: { ...ctx.identity, createdAt: Date.parse("2026-11-06T04:00:00Z"), sessionId: "another-trusted-session" } });
  assert.equal(second.success, true, JSON.stringify(second));
  const saved = await db.get("orders", "order");
  assert.equal(saved.finalPaymentSessionStartAt, "2026-11-06T03:00:00.000Z");
  assert.equal(saved.paymentRecords.find(row => row.phase === "final").sessionStartAt, "2026-11-06T03:00:00.000Z");
  assert.equal(saved.finalPaymentSessionId, "trusted-original-session");
  assert.equal(saved.paymentRecords.find(row => row.phase === "final").sessionId, "trusted-original-session");
});

test("refund plans, reservations and retry markers survive normalized MySQL metadata roundtrip", () => {
  const schema = require("../lib/mysqlSchema.cjs");
  for (const [key, value] of [["orders", { ...order(), shareEnqueuePending: true, shareRefundPending: true, onlineRefundedAmount: 0.04,
    onlineRefundReservations: [{ refundNo: "REFUND_12345", ticketId: "ticket", outTradeNo: "PAY123456", amountFen: 4, status: "CREATED" }] }],
    ["afterSales", { ...ticket(), refundAttempts: [{ refundNo: "REFUND_12345", amountFen: 4, totalFen: 10000, status: "SUCCESS", sharePending: true }], refundedAmount: 0.04, refundError: "pending" }]]) {
    if (key === "orders") { value.finalPaymentSessionStartAt = "2026-11-06T03:00:00.000Z"; value.paymentRecords[0].sessionStartAt = value.finalPaymentSessionStartAt; value.finalPaymentSessionId = "trusted-session"; value.paymentRecords[0].sessionId = value.finalPaymentSessionId; }
    const split = schema.splitDocument(key, value);
    const restored = schema.hydrateDocument(key, { id: split.id, ...split.columns }, { collection_values: split.attributes, ...Object.fromEntries(Object.entries(split.relations).map(([name, rows]) => [name, rows])) });
    if (key === "orders") {
      assert.equal(restored.shareEnqueuePending, true); assert.equal(restored.shareRefundPending, true); assert.equal(restored.onlineRefundedAmount, 0.04);
      assert.deepEqual(restored.onlineRefundReservations, value.onlineRefundReservations);
      assert.equal(restored.finalPaymentSessionStartAt, value.finalPaymentSessionStartAt);
      assert.equal(restored.paymentRecords[0].sessionStartAt, value.finalPaymentSessionStartAt);
      assert.equal(restored.finalPaymentSessionId, value.finalPaymentSessionId);
      assert.equal(restored.paymentRecords[0].sessionId, value.finalPaymentSessionId);
    } else { assert.deepEqual(restored.refundAttempts, value.refundAttempts); assert.equal(restored.refundedAmount, 0.04); }
  }
});

test("recovery repairs an interrupted success projection without issuing or deducting a second refund", async () => {
  const db = source(), pay = provider();
  await db.create("orders", order()); await db.create("afterSales", ticket());
  const normalRefund = pay.createRefund.bind(pay);
  pay.createRefund = async (request) => {
    const reply = { ...await normalRefund(request), status: "SUCCESS", successTime: "2026-11-06T12:00:00+08:00" };
    pay.existing.set(reply.refundNo, reply); return reply;
  };
  const compare = db.compareAndUpdate.bind(db);
  let projectionUnavailable = true;
  db.compareAndUpdate = async (key, id, expected, patch) => {
    if (key === "orders" && "onlineRefundedAmount" in patch && projectionUnavailable) throw new Error("interrupted after verified receipt");
    return compare(key, id, expected, patch);
  };
  await assert.rejects(() => startRefund(db, "ticket", { wechatPay: pay }));
  assert.equal((await db.get("afterSales", "ticket")).refundConfirmed, true, "the signed receipt survives a projection failure");
  assert.equal((await db.get("orders", "order")).status, "deposit_paid");
  projectionUnavailable = false;
  const recovered = await require("../lib/onlineRefunds.cjs").reconcilePendingRefunds(db, { wechatPay: pay });
  assert.equal(recovered.processed, 1);
  assert.equal((await db.get("orders", "order")).status, "cancelled");
  assert.equal((await db.get("orders", "order")).onlineRefundedAmount, 100);
  assert.equal(pay.created.length, 1);
});
