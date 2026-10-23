"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createSource = require("../lib/dbSource.cjs");
const rpc = require("../lib/rpc.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const { createWechatPay } = require("../lib/wechatPay.cjs");
const { createTestWechatPay } = require("./helpers/wechatPay.cjs");
const input = { name: "客户", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1.0", current: true }, items: [{ packageId: "package" }], idempotencyKey: "booking-checkout-0001" };
const identity = { identity: { kind: "public", openid: "owner" } };
const otherIdentity = { identity: { kind: "public", openid: "other" } };

async function fixture(t, ratio = 30) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-checkout-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const cfg = { backend: "json", jsonFile: path.join(dir, "db.json") };
  const source = createSource(cfg);
  await source.create("packages", { id: "package", name: "服务套餐", price: 100, depositRatio: ratio, status: "已上架" });
  return { source, restart: () => createSource(cfg) };
}

function realGateway() {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { apiHost: "api.mch.weixin.qq.com", mchId: "1900000109", appId: "wx1234567890abcdef", merchantSerialNo: "TEST_SERIAL", merchantPrivateKey: keys.privateKey.export({ type: "pkcs1", format: "pem" }), apiV3Key: "0123456789abcdef0123456789abcdef", notifyUrl: "https://example.test/notify", platformPublicKeyId: "PUB_KEY_ID_3000000001", platformPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
  return createWechatPay({ config, transport: async () => { throw new Error("network not expected"); } });
}

async function prepare(source) {
  const booking = await rpc(source, "createBooking", { data: input }, identity);
  assert.equal(booking.success, true, JSON.stringify(booking));
  const result = await rpc(source, "createPayment", { data: { bookingId: booking.bookingId, phase: "deposit", idempotencyKey: "checkout-payment-0001" } }, { ...identity, wechatPay: createTestWechatPay() });
  assert.equal(result.success, true, JSON.stringify(result));
  const draft = await source.get("bookingRequests", booking.bookingId);
  return { booking, draft, payment: draft.paymentRecords[0], result };
}

function transaction(payment, patch = {}) {
  return { appid: "wx1234567890abcdef", mchid: "1900000109", outTradeNo: payment.outTradeNo, transactionId: "wx-checkout-transaction", tradeState: "SUCCESS", tradeType: "JSAPI", payerOpenid: "owner", amountTotal: 3000, amountCurrency: "CNY", ...patch };
}

test("checkout stores only a private payment request; client fields and another owner cannot create an order", async (t) => {
  const { source } = await fixture(t);
  const { booking, result } = await prepare(source);
  assert.equal(booking.bookingStatus, "pending_payment");
  assert.equal(booking.paymentRequired, true);
  assert.equal(booking.depositDue, 30);
  assert.equal(booking.totalAmount, 100);
  assert.equal(booking.orderId, undefined);
  assert.equal(result.data.orderId, undefined);
  assert.equal((await source.list("orders")).length, 0);
  assert.equal((await source.dashboard()).orders, 0);
  assert.equal((await rpc(source, "getMyOrders", {}, identity)).total, 0);
  assert.equal((await rpc(source, "getOrderDetail", { data: { orderId: booking.bookingId } }, identity)).success, false);
  for (const name of ["createPayment", "getPaymentStatus", "testPayment"]) {
    const forbidden = await rpc(source, name, { data: { bookingId: booking.bookingId, phase: "deposit", idempotencyKey: "other-payment-0001" } }, otherIdentity);
    assert.equal(forbidden.success, false);
  }
  const tampered = await rpc(source, "createPayment", { data: { bookingId: booking.bookingId, phase: "deposit", amount: 0.01, idempotencyKey: "tamper-payment-0001" } }, identity);
  assert.equal(tampered.success, false);
  const forged = await rpc(source, "getPaymentStatus", { data: { bookingId: booking.bookingId, phase: "deposit", status: "confirmed", depositPaid: 30, paymentSuccess: true } }, identity);
  assert.equal(forged.data.bookingStatus, "pending_payment");
  assert.equal((await source.list("orders")).length, 0);
});

test("verified deposit callbacks create one paid order across retries, concurrency and a source restart", async (t) => {
  const fixtureData = await fixture(t);
  const { booking, payment } = await prepare(fixtureData.source);
  const source = fixtureData.restart();
  const gateway = realGateway();
  await assert.rejects(gateway.confirmTransaction(source, transaction(payment, { amountTotal: 1 })), { code: "WECHAT_PAY_AMOUNT_MISMATCH" });
  await assert.rejects(gateway.confirmTransaction(source, transaction(payment, { payerOpenid: "other" })), { code: "WECHAT_PAY_PAYER_MISMATCH" });
  assert.equal((await source.list("orders")).length, 0);
  const callbacks = await Promise.all([gateway.confirmTransaction(source, transaction(payment)), gateway.confirmTransaction(source, transaction(payment))]);
  assert.equal(callbacks[0].order.id, callbacks[1].order.id);
  assert.equal((await source.list("orders")).length, 1);
  const order = callbacks[0].order;
  assert.equal(order.status, "deposit_paid");
  assert.equal(order.workflowStage, "awaiting_dispatch");
  assert.equal(order.businessStatus, "reserved");
  assert.equal(order.depositPaid, 30);
  assert.equal(order.bookingId, booking.bookingId);
  assert.equal(order.paymentRecords.length, 1);
  assert.equal(order.paymentRecords[0].externalTransactionId, "wx-checkout-transaction");
  const status = await rpc(source, "getPaymentStatus", { data: { bookingId: booking.bookingId, phase: "deposit" } }, identity);
  assert.equal(status.data.bookingStatus, "confirmed");
  assert.equal(status.data.orderId, order.id);
  assert.equal(status.data.order.statusText, "已预约");
  const repeated = await rpc(source, "createBooking", { data: input }, identity);
  assert.equal(repeated.orderId, order.id);
  assert.equal(repeated.bookingStatus, "confirmed");
  const replay = await gateway.confirmTransaction(fixtureData.restart(), transaction(payment));
  assert.equal(replay.order.id, order.id);
  assert.equal((await source.list("orders")).length, 1);
});

test("terminal unpaid transactions never create an order; paid drafts recover an interrupted promotion", async (t) => {
  const { source } = await fixture(t);
  const { booking, payment } = await prepare(source);
  const gateway = realGateway();
  await gateway.confirmTransaction(source, transaction(payment, { tradeState: "CLOSED", transactionId: "" }));
  assert.equal((await source.list("orders")).length, 0);
  assert.equal((await source.get("bookingRequests", booking.bookingId)).paymentRecords[0].status, "failed");
  // An authenticated successful callback may race the terminal query. The
  // signed success remains authoritative and must be recoverable after a DB
  // error between storing payment confirmation and inserting the order.
  const originalCreate = source.create;
  source.create = async (key, document) => { if (key === "orders") throw new Error("temporary persistence failure"); return originalCreate(key, document); };
  await assert.rejects(gateway.confirmTransaction(source, transaction(payment)));
  assert.equal((await source.list("orders")).length, 0);
  source.create = originalCreate;
  const status = await rpc(source, "getPaymentStatus", { data: { bookingId: booking.bookingId, phase: "deposit" } }, identity);
  assert.equal(status.data.bookingStatus, "confirmed");
  assert.equal((await source.list("orders")).length, 1);
});

test("configured zero deposit creates a reservation immediately and stays idempotent", async (t) => {
  const { source } = await fixture(t, 0);
  const first = await rpc(source, "createBooking", { data: input }, identity);
  const repeated = await rpc(source, "createOrder", { data: input }, identity);
  assert.equal(first.bookingStatus, "confirmed");
  assert.equal(first.paymentRequired, false);
  assert.equal(first.orderId, repeated.orderId);
  assert.equal(first.order.businessStatus, "reserved");
  assert.equal((await source.list("bookingRequests")).length, 0);
  assert.equal((await source.list("orders")).length, 1);
  assert.deepEqual((await source.get("orders", first.orderId)).paymentRecords, []);
});

test("booking snapshots and payment recovery fields round-trip through normalized MySQL metadata", () => {
  const document = { id: "draft", bookingStatus: "pending_payment", openid: "owner", depositDue: 30, totalAmount: 100, agreementSnapshot: { version: "notice-2", current: true }, items: [{ packageId: "package", price: 100, depositRatio: 0.3 }], source: { shopId: "shop", sourceCodeId: "code" }, paymentRecords: [{ id: "pay", phase: "deposit", amount: 30, status: "pending", provider: "wechat_pay", idempotencyKey: "request-payment-key", outTradeNo: "LXMBOOKING123", prepayId: "prepay", prepayCreatedAt: "2026-10-16T00:00:00Z" }], statusLogs: [], followRecords: [] };
  const split = schema.splitDocument("bookingRequests", document);
  const restored = schema.hydrateDocument("bookingRequests", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  for (const field of ["agreementSnapshot", "items", "source", "paymentRecords", "statusLogs", "followRecords"]) assert.deepEqual(restored[field], document[field]);
  assert.equal(split.relations.booking_payment_records[0].out_trade_no, "LXMBOOKING123");
  assert.match(schema.schemaStatements().join("\n"), /UNIQUE KEY uq_booking_payment_trade \(out_trade_no\)/);
});

test("callback fails closed when an unrelated formal order claims a booking trade number", async (t) => {
  const { source } = await fixture(t);
  const { payment } = await prepare(source);
  await source.create("orders", { id: "conflict", openid: "other", depositDue: 30, paymentRecords: [{ ...payment }] });
  await assert.rejects(realGateway().confirmTransaction(source, transaction(payment)), { code: "WECHAT_PAY_PAYMENT_AMBIGUOUS" });
  assert.equal((await source.list("orders")).length, 1);
  assert.equal((await source.list("bookingRequests"))[0].paymentRecords[0].status, "pending");
});

test("MySQL payment uniqueness conflicts roll back instead of overwriting another owner's relation", async () => {
  const createMysqlSource = require("../lib/mysqlSource.cjs");
  for (const [collection, relationTable] of [["bookingRequests", "lxm_booking_payment_records"], ["orders", "lxm_order_payment_records"]]) {
    let rolledBack = 0;
    let committed = 0;
    let attemptedPaymentInsert = "";
    let mainRowWritten = false;
    const query = async (sql, params = []) => {
      if (sql.includes("information_schema.columns")) {
        const definition = Object.entries(schema.TABLES).find(([, table]) => table === params[0]);
        return [(definition ? schema.definition(definition[0]).columns : []).map((column) => ({ column_name: column.name }))];
      }
      if (sql.startsWith(`INSERT INTO \`${relationTable}\``)) {
        attemptedPaymentInsert = sql;
        throw Object.assign(new Error("duplicate payment key belonging to another owner"), { code: "ER_DUP_ENTRY", errno: 1062 });
      }
      if (sql.startsWith(`INSERT INTO \`lxm_${collection}\``)) mainRowWritten = true;
      return [{ affectedRows: 1 }];
    };
    const connection = { query, async beginTransaction() {}, async commit() { committed += 1; }, async rollback() { rolledBack += 1; mainRowWritten = false; }, release() {} };
    const source = createMysqlSource({ autoMigrate: false, pool: { query, async getConnection() { return connection; } } });
    await assert.rejects(source.create(collection, { id: "second-owner", openid: "other", paymentRecords: [{ id: "payment", phase: "deposit", amount: 30, status: "pending", idempotencyKey: "shared-request-key", outTradeNo: "SHAREDTRADENO" }] }), { code: "DUPLICATE_RECORD" });
    assert.ok(attemptedPaymentInsert, "must exercise the live payment relation writer");
    assert.doesNotMatch(attemptedPaymentInsert, /ON DUPLICATE KEY UPDATE/i);
    assert.equal(rolledBack, 1);
    assert.equal(committed, 0);
    assert.equal(mainRowWritten, false, "the new owner's snapshot must roll back with the conflicting index");
    await source.close();
  }
});

test("a failed secondary booking audit cannot delete a concurrently issued real prepay", async (t) => {
  const { source } = await fixture(t);
  const originalCreate = source.create;
  let issuedPrepay = null;
  source.create = async (key, document) => {
    if (key === "logs" && document.action === "创建预约支付请求") {
      const bookingId = document.targetId;
      issuedPrepay = await rpc(source, "createPayment", { data: { bookingId, phase: "deposit", idempotencyKey: "concurrent-prepay-key" } }, { ...identity, wechatPay: createTestWechatPay() });
      assert.equal(issuedPrepay.success, true);
      throw new Error("secondary audit temporarily unavailable");
    }
    return originalCreate(key, document);
  };
  const booking = await rpc(source, "createBooking", { data: input }, identity);
  assert.equal(booking.success, true);
  assert.equal(booking.bookingStatus, "pending_payment");
  const draft = await source.get("bookingRequests", booking.bookingId);
  assert.ok(draft, "the persisted prepay reference must survive the failed audit");
  assert.ok(draft.paymentRecords[0].prepayId);
  assert.equal((await source.list("orders")).length, 0);
  await realGateway().confirmTransaction(source, transaction(draft.paymentRecords[0]));
  assert.equal((await source.list("orders")).length, 1);
});

test("owner can discard an unpaid checkout without deleting its payment history", async (t) => {
  const { source } = await fixture(t);
  const booking = await rpc(source, "createBooking", { data: input }, identity);
  assert.equal((await rpc(source, "cancelBooking", { data: { bookingId: booking.bookingId } }, otherIdentity)).success, false);
  const cancelled = await rpc(source, "cancelBooking", { data: { bookingId: booking.bookingId } }, identity);
  assert.equal(cancelled.data.bookingStatus, "cancelled");
  assert.equal(cancelled.data.paymentRequired, false);
  assert.equal((await rpc(source, "cancelBooking", { data: { bookingId: booking.bookingId } }, identity)).data.idempotent, true);
  assert.ok(await source.get("bookingRequests", booking.bookingId));
  const refused = await rpc(source, "createPayment", { data: { bookingId: booking.bookingId, phase: "deposit", idempotencyKey: "after-cancel-payment" } }, { ...identity, wechatPay: createTestWechatPay() });
  assert.equal(refused.success, false);
  assert.equal((await rpc(source, "createBooking", { data: input }, identity)).bookingStatus, "cancelled");
  const replacement = await rpc(source, "createBooking", { data: { ...input, phone: "13900000000", idempotencyKey: "replacement-booking-key" } }, identity);
  assert.equal(replacement.bookingStatus, "pending_payment");
  assert.notEqual(replacement.bookingId, booking.bookingId);
  assert.equal((await source.list("orders")).length, 0);
});

test("cancel closes every issued trade, blocks new issuance and preserves a late trusted success", async (t) => {
  const { source } = await fixture(t);
  const { booking, draft, payment } = await prepare(source);
  const second = { ...payment, id: "second-payment", idempotencyKey: "second-payment-key", outTradeNo: "SECONDWECHATTRADENO" };
  await source.update("bookingRequests", booking.bookingId, { paymentRecords: [payment, second] });
  const queried = [];
  const closed = [];
  const gateway = createTestWechatPay();
  gateway.queryTransaction = async (outTradeNo) => {
    queried.push(outTradeNo);
    const simultaneous = await rpc(source, "createPayment", { data: { bookingId: booking.bookingId, phase: "deposit", idempotencyKey: "during-cancel-key" } }, { ...identity, wechatPay: gateway });
    assert.equal(simultaneous.success, false);
    return { outTradeNo, tradeState: "NOTPAY" };
  };
  gateway.closeTransaction = async (outTradeNo) => { closed.push(outTradeNo); };
  const cancelled = await rpc(source, "cancelBooking", { data: { bookingId: booking.bookingId } }, { ...identity, wechatPay: gateway });
  assert.equal(cancelled.data.bookingStatus, "cancelled");
  assert.deepEqual(queried, [payment.outTradeNo, second.outTradeNo]);
  assert.deepEqual(closed, queried);
  const saved = await source.get("bookingRequests", booking.bookingId);
  assert.equal(saved.paymentRecords.length, draft.paymentRecords.length + 1);
  assert.equal(saved.paymentRecords.every((row) => row.tradeState === "CLOSED"), true);
  assert.equal((await source.list("orders")).length, 0);
  // A provider-verified late success is stronger than our earlier terminal
  // snapshot. It must retain the money and create the original paid booking.
  await realGateway().confirmTransaction(source, transaction(payment));
  const repeated = await rpc(source, "cancelBooking", { data: { bookingId: booking.bookingId } }, identity);
  assert.equal(repeated.data.bookingStatus, "confirmed");
  assert.ok(repeated.data.orderId);
  assert.equal((await source.list("orders")).length, 1);
});

test("query and close failures, including an in-flight missing trade, keep checkout editable only after a safe retry", async (t) => {
  const { source } = await fixture(t);
  const { booking, payment } = await prepare(source);
  for (const failure of ["query", "close", "inflight"]) {
    const gateway = createTestWechatPay();
    if (failure === "query") gateway.queryTransaction = async () => { throw new Error("temporary query failure"); };
    if (failure === "close") gateway.closeTransaction = async () => { throw new Error("temporary close failure"); };
    if (failure === "inflight") {
      await source.update("bookingRequests", booking.bookingId, { paymentRecords: [{ ...payment, prepayId: undefined }] });
      gateway.queryTransaction = async () => { throw Object.assign(new Error("not created yet"), { code: "WECHAT_PAY_TRANSACTION_NOT_FOUND" }); };
    }
    const response = await rpc(source, "cancelBooking", { data: { bookingId: booking.bookingId } }, { ...identity, wechatPay: gateway });
    assert.equal(response.success, false, failure);
    assert.equal((await source.get("bookingRequests", booking.bookingId)).bookingStatus, "pending_payment");
    assert.equal((await source.list("orders")).length, 0);
  }
});

test("cancel reconciles an already paid provider transaction instead of discarding the checkout", async (t) => {
  const { source } = await fixture(t);
  const { booking, payment } = await prepare(source);
  const gateway = realGateway();
  gateway.queryTransaction = async () => transaction(payment);
  const response = await rpc(source, "cancelBooking", { data: { bookingId: booking.bookingId } }, { ...identity, wechatPay: gateway });
  assert.equal(response.data.bookingStatus, "confirmed");
  assert.ok(response.data.orderId);
  assert.equal((await source.list("orders")).length, 1);
});
