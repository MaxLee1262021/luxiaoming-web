"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const createApi = require("../lib/api.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const rpc = require("../lib/rpc.cjs");
const { createWechatPay } = require("../lib/wechatPay.cjs");

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function makeKeys() {
  const merchant = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    merchant,
    platform,
    config: {
      mchId: "1900000109",
      appId: "wx1234567890abcdef",
      merchantSerialNo: "MERCHANT_SERIAL_001",
      merchantPrivateKey: merchant.privateKey.export({ type: "pkcs1", format: "pem" }),
      apiV3Key: "0123456789abcdef0123456789abcdef",
      notifyUrl: "https://api.example.test/api/payments/wechat/notify",
      platformPublicKeyId: "PUB_KEY_ID_3000000001",
      platformPublicKey: platform.publicKey.export({ type: "spki", format: "pem" }),
      apiHost: "api.mch.weixin.qq.com",
    },
  };
}

function signedHeaders(privateKey, serial, body, timestamp = String(Math.floor(Date.now() / 1000)), nonce = "platform-nonce-123") {
  const message = `${timestamp}\n${nonce}\n${body}\n`;
  return {
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": nonce,
    "wechatpay-serial": serial,
    "wechatpay-signature": crypto.sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64"),
  };
}

function encryptedNotification(keys, transaction) {
  const associatedData = "transaction";
  const nonce = "0123456789ab";
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keys.config.apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const body = JSON.stringify({
    id: "event-001",
    event_type: "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource",
    resource: { original_type: "transaction", algorithm: "AEAD_AES_256_GCM", nonce, associated_data: associatedData, ciphertext },
  });
  return {
    body,
    headers: signedHeaders(keys.platform.privateKey, keys.config.platformPublicKeyId, body),
  };
}

function makeSource(order) {
  const collections = { orders: { [order.id]: clone(order) }, logs: {} };
  let sequence = 0;
  return {
    collections,
    async list(key) { return Object.values(collections[key] || {}).map(clone); },
    async get(key, id) { return clone(collections[key] && collections[key][String(id)]) || null; },
    async create(key, document) {
      const id = String(document.id || document._id || `${key}-${++sequence}`);
      collections[key] ||= {};
      collections[key][id] = { ...clone(document), id, _id: id };
      return clone(collections[key][id]);
    },
    async update(key, id, patch) {
      if (!collections[key] || !collections[key][String(id)]) return null;
      collections[key][String(id)] = { ...collections[key][String(id)], ...clone(patch), id: String(id), _id: String(id) };
      return clone(collections[key][String(id)]);
    },
    async compareAndUpdate(key, id, expected, patch) {
      const current = collections[key] && collections[key][String(id)];
      if (!current || !Object.entries(expected).every(([field, value]) => JSON.stringify(current[field]) === JSON.stringify(value))) return null;
      return this.update(key, id, patch);
    },
  };
}

function pendingOrder() {
  return {
    id: "order-1",
    _id: "order-1",
    orderNo: "ORDER-1",
    openid: "openid-1",
    status: "new",
    totalAmount: 100,
    depositDue: 30,
    finalDue: 70,
    paymentRecords: [{
      id: "payment-1",
      phase: "deposit",
      amount: 30,
      status: "pending",
      provider: "wechat_pay",
      outTradeNo: "LXM0123456789ABCDEF0123456789ABC",
      idempotencyKey: "payment-key-0001",
      prepayId: "wx-prepay-001",
    }],
    statusLogs: [],
    followRecords: [],
  };
}

test("JSAPI prepay request is signed and produces mini-program payment parameters", async () => {
  const keys = makeKeys();
  let captured = null;
  const gateway = createWechatPay({
    config: keys.config,
    transport: async (request) => {
      captured = request;
      const authorization = String(request.headers.Authorization || "");
      const signature = /signature="([^"]+)"/.exec(authorization)[1];
      const timestamp = /timestamp="([^"]+)"/.exec(authorization)[1];
      const nonce = /nonce_str="([^"]+)"/.exec(authorization)[1];
      const signed = `${request.method}\n${request.path}\n${timestamp}\n${nonce}\n${request.body}\n`;
      assert.equal(crypto.verify("RSA-SHA256", Buffer.from(signed), keys.merchant.publicKey, Buffer.from(signature, "base64")), true);
      const body = JSON.stringify({ prepay_id: "wx-prepay-001" });
      return { statusCode: 200, body, headers: signedHeaders(keys.platform.privateKey, keys.config.platformPublicKeyId, body) };
    },
  });

  const result = await gateway.createJsapiTransaction({
    order: { packageName: "城市旅拍" },
    phase: "deposit",
    payment: { amount: 30, outTradeNo: "LXM0123456789ABCDEF0123456789ABC" },
    openid: "openid-1",
  });
  assert.equal(gateway.isConfigured(), true);
  assert.equal(captured.path, "/v3/pay/transactions/jsapi");
  assert.deepEqual(JSON.parse(captured.body).amount, { total: 3000, currency: "CNY" });
  assert.equal(result.paymentParams.package, "prepay_id=wx-prepay-001");
  assert.equal(result.paymentParams.signType, "RSA");
});

test("normalized payment records retain WeChat transaction identifiers", () => {
  const payment = {
    id: "payment-identifier-1",
    phase: "deposit",
    amount: 30,
    status: "pending",
    provider: "wechat_pay",
    outTradeNo: "LXM0123456789ABCDEF0123456789ABC",
    prepayId: "wx-prepay-001",
    tradeState: "NOTPAY",
    prepayCreatedAt: "2026-09-21T10:00:00.000Z",
    failureReason: "",
  };
  const split = schema.splitDocument("orders", { id: "order-payment-identifiers", paymentRecords: [payment] });
  const row = split.relations.order_payment_records[0];
  assert.equal(row.out_trade_no, payment.outTradeNo);
  assert.equal(row.prepay_id, payment.prepayId);
  const restored = schema.hydrateDocument("orders", { id: split.id, ...split.columns }, { collection_values: split.attributes, order_payment_records: [row] });
  assert.equal(restored.paymentRecords[0].outTradeNo, payment.outTradeNo);
  assert.equal(restored.paymentRecords[0].prepayId, payment.prepayId);
});

test("verified callback decrypts once, confirms the server order, and rejects wrong amounts", async () => {
  const keys = makeKeys();
  const gateway = createWechatPay({ config: keys.config });
  const source = makeSource(pendingOrder());
  let indexedLookups = 0;
  source.findOrderByPaymentOutTradeNo = async (outTradeNo) => {
    indexedLookups += 1;
    return outTradeNo === "LXM0123456789ABCDEF0123456789ABC" ? source.get("orders", "order-1") : null;
  };
  const transaction = {
    appid: keys.config.appId,
    mchid: keys.config.mchId,
    out_trade_no: "LXM0123456789ABCDEF0123456789ABC",
    transaction_id: "4200000001202609210000000001",
    trade_state: "SUCCESS",
    trade_type: "JSAPI",
    success_time: "2026-09-21T10:00:00+08:00",
    payer: { openid: "openid-1" },
    amount: { total: 3000, currency: "CNY" },
  };
  const notification = encryptedNotification(keys, transaction);
  const parsed = gateway.parseNotification(notification.headers, notification.body);
  const first = await gateway.confirmTransaction(source, parsed);
  assert.equal(first.idempotent, false);
  assert.equal(indexedLookups, 1, "payment confirmation must use the out_trade_no lookup when the source supports it");
  const saved = await source.get("orders", "order-1");
  assert.equal(saved.status, "deposit_paid");
  assert.equal(saved.depositPaid, 30);
  assert.equal(saved.paymentRecords[0].status, "confirmed");
  assert.equal(saved.paymentRecords[0].externalTransactionId, transaction.transaction_id);
  assert.equal((await gateway.confirmTransaction(source, parsed)).idempotent, true);

  const missingPayer = encryptedNotification(keys, { ...transaction, payer: {} });
  assert.throws(() => gateway.parseNotification(missingPayer.headers, missingPayer.body), { code: "WECHAT_PAY_NOTIFICATION_INVALID" });

  const invalid = encryptedNotification(keys, { ...transaction, out_trade_no: "LXM0123456789ABCDEF0123456789ABC", transaction_id: "4200000001202609210000000002", amount: { total: 2999, currency: "CNY" } });
  await assert.rejects(() => gateway.confirmTransaction(source, gateway.parseNotification(invalid.headers, invalid.body)), { code: "WECHAT_PAY_AMOUNT_MISMATCH" });
});

test("stale prepay attempts are closed and made retryable instead of remaining pending", async () => {
  const order = pendingOrder();
  order.paymentRecords[0].prepayCreatedAt = "2020-01-01T00:00:00.000Z";
  const source = makeSource(order);
  let closeCount = 0;
  const gateway = {
    isConfigured() { return true; },
    async queryTransaction(outTradeNo) { return { outTradeNo, tradeState: "NOTPAY" }; },
    async closeTransaction() { closeCount += 1; return true; },
    async confirmTransaction() { throw new Error("NOTPAY must not confirm"); },
  };
  const result = await rpc(source, "getPaymentStatus", { data: { orderId: order.id, phase: "deposit" } }, {
    identity: { kind: "public", openid: "openid-1" },
    wechatPay: gateway,
  });
  assert.equal(closeCount, 1);
  assert.equal(result.success, true);
  assert.equal(result.data.status, "failed");
  assert.equal((await source.get("orders", order.id)).paymentRecords[0].failureReason, "prepay_expired");
});

test("stale creation records without a prepay id become retryable after a missing trade lookup", async () => {
  const order = pendingOrder();
  delete order.paymentRecords[0].prepayId;
  order.paymentRecords[0].createdAt = "2020-01-01T00:00:00.000Z";
  const source = makeSource(order);
  const gateway = {
    isConfigured() { return true; },
    async queryTransaction() {
      const error = new Error("not found");
      error.code = "WECHAT_PAY_TRANSACTION_NOT_FOUND";
      throw error;
    },
    async closeTransaction() { throw new Error("must not close a missing trade"); },
  };
  const result = await rpc(source, "getPaymentStatus", { data: { orderId: order.id, phase: "deposit" } }, {
    identity: { kind: "public", openid: "openid-1" },
    wechatPay: gateway,
  });
  assert.equal(result.data.status, "failed");
  assert.equal((await source.get("orders", order.id)).paymentRecords[0].failureReason, "prepay_not_found");
});

test("closed transaction queries without success-only fields mark the payment failed", async () => {
  const keys = makeKeys();
  const gateway = createWechatPay({ config: keys.config });
  const source = makeSource(pendingOrder());
  const result = await gateway.confirmTransaction(source, {
    appid: keys.config.appId,
    mchid: keys.config.mchId,
    outTradeNo: "LXM0123456789ABCDEF0123456789ABC",
    tradeState: "CLOSED",
  });
  assert.equal(result.idempotent, false);
  assert.equal((await source.get("orders", "order-1")).paymentRecords[0].status, "failed");
});

test("platform verifier rotation accepts a previous serial during overlap", async () => {
  const keys = makeKeys();
  const previous = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const previousSerial = "PUB_KEY_ID_3000000000";
  const gateway = createWechatPay({
    config: {
      ...keys.config,
      platformVerifiers: [{ serialNo: previousSerial, publicKey: previous.publicKey.export({ type: "spki", format: "pem" }) }],
    },
    transport: async () => {
      const body = JSON.stringify({ prepay_id: "wx-prepay-rotation" });
      return { statusCode: 200, body, headers: signedHeaders(previous.privateKey, previousSerial, body) };
    },
  });
  const result = await gateway.createJsapiTransaction({
    order: { packageName: "城市旅拍" },
    phase: "deposit",
    payment: { amount: 30, outTradeNo: "LXM0123456789ABCDEF0123456789ABC" },
    openid: "openid-1",
  });
  assert.equal(result.prepayId, "wx-prepay-rotation");
});

test("payment notification route preserves raw body for verification", async (t) => {
  const keys = makeKeys();
  const gateway = createWechatPay({ config: keys.config });
  const source = makeSource(pendingOrder());
  const handler = createApi(source, "json", { wechatPay: gateway, sourceStatus: { ready: true }, permissionStore: null, auth: { async init() {} } });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const notification = encryptedNotification(keys, {
    appid: keys.config.appId,
    mchid: keys.config.mchId,
    out_trade_no: "LXM0123456789ABCDEF0123456789ABC",
    transaction_id: "4200000001202609210000000003",
    trade_state: "SUCCESS",
    trade_type: "JSAPI",
    payer: { openid: "openid-1" },
    amount: { total: 3000, currency: "CNY" },
  });
  // The callback body stays byte-for-byte signed. This exceeds the former
  // 128 KiB implementation cap and includes UTF-8 text outside ciphertext.
  const envelope = JSON.parse(notification.body);
  envelope.summary = "支付通知";
  envelope.padding = "x".repeat(130 * 1024);
  notification.body = JSON.stringify(envelope);
  notification.headers = signedHeaders(keys.platform.privateKey, keys.config.platformPublicKeyId, notification.body);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/wechat/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...notification.headers },
    body: notification.body,
  });
  assert.equal(response.status, 204);
  const rejected = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/wechat/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "wechatpay-timestamp": String(Math.floor(Date.now() / 1000)), "wechatpay-nonce": "bad", "wechatpay-serial": keys.config.platformPublicKeyId, "wechatpay-signature": "bad" },
    body: notification.body,
  });
  assert.equal(rejected.status, 401);
});
