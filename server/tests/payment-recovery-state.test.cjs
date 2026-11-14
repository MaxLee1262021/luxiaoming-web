"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isDeepStrictEqual } = require("node:util");
const rpc = require("../lib/rpc.cjs");
const { createTestWechatPay } = require("./helpers/wechatPay.cjs");

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const staleTime = "2020-01-01T00:00:00.000Z";

function finalOrder(payment = {}) {
  return {
    id: "recovery-final-order", _id: "recovery-final-order", openid: "synthetic-owner",
    status: "final_pending", workflowStage: "awaiting_final_payment", service_status: "final_pending",
    shootingCompletedAt: staleTime, totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed",
    finalDue: 70, finalPaid: 0,
    paymentRecords: [{ id: "recovery-final-intent", phase: "final", amount: 70, status: "pending",
      provider: "wechat_pay", idempotencyKey: "original-recovery-intent", outTradeNo: "SYNTHETICFINALTRADE",
      createdAt: staleTime, ...payment }],
    statusLogs: [], followRecords: [],
  };
}

function fixture(order = finalOrder()) {
  const collections = { orders: { [order.id]: clone(order) }, logs: {} };
  let sequence = 0;
  const source = {
    async list(key) { return Object.values(collections[key] || {}).map(clone); },
    async get(key, id) { return clone(collections[key] && collections[key][id]) || null; },
    async create(key, value) {
      const id = value.id || `${key}-${++sequence}`;
      collections[key] ||= {};
      collections[key][id] = { ...clone(value), id };
      return clone(collections[key][id]);
    },
    async update(key, id, patch) {
      if (!collections[key] || !collections[key][id]) return null;
      collections[key][id] = { ...collections[key][id], ...clone(patch) };
      return clone(collections[key][id]);
    },
    async compareAndUpdate(key, id, expected, patch) {
      const current = collections[key] && collections[key][id];
      if (!current || !Object.entries(expected).every(([field, value]) => isDeepStrictEqual(current[field], value))) return null;
      return this.update(key, id, patch);
    },
  };
  const gateway = createTestWechatPay();
  const ctx = { identity: { kind: "public", openid: order.openid }, wechatPay: gateway };
  return {
    source, gateway,
    read: () => source.get("orders", order.id),
    status: () => rpc(source, "getPaymentStatus", { data: { orderId: order.id, phase: "final" } }, ctx),
    create: (key = "new-recovery-intent") => rpc(source, "createPayment", {
      data: { orderId: order.id, phase: "final", selectionAccepted: true, idempotencyKey: key },
    }, ctx),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("an old finance placeholder receives a fresh payment grace period during prepay creation", async () => {
  const f = fixture(finalOrder({ provider: undefined, idempotencyKey: undefined, outTradeNo: undefined }));
  const started = deferred(), release = deferred();
  const before = Date.now();
  let queries = 0;
  f.gateway.createJsapiTransaction = async () => {
    started.resolve();
    await release.promise;
    return { prepayId: "fresh-prepay" };
  };
  f.gateway.queryTransaction = async () => {
    queries++;
    throw Object.assign(new Error("Synthetic trade is not created yet"), { code: "WECHAT_PAY_TRANSACTION_NOT_FOUND" });
  };
  const creation = f.create();
  await started.promise;
  const inFlight = await f.read();
  assert(Date.parse(inFlight.paymentRecords[0].createdAt) >= before, "intent creation must not inherit the old finance timestamp");
  const status = await f.status();
  release.resolve();
  const created = await creation;
  assert.equal(queries, 1, "only the normal status query runs during the grace period");
  assert.equal(status.success, true);
  assert.equal(status.data.status, "pending");
  assert.equal(created.success, true);
  assert.equal(created.data.invokeWeChatPay, true);
  assert.equal((await f.read()).paymentRecords[0].status, "pending");
});

for (const terminalStatus of ["failed", "confirmed"]) {
  test(`a delayed prepay response does not overwrite a concurrently ${terminalStatus} payment`, async () => {
    const f = fixture(finalOrder({ provider: undefined, idempotencyKey: undefined, outTradeNo: undefined }));
    const started = deferred(), release = deferred();
    f.gateway.createJsapiTransaction = async () => {
      started.resolve();
      await release.promise;
      return { prepayId: "late-prepay-must-not-be-saved" };
    };
    const creation = f.create();
    await started.promise;
    const inFlight = await f.read();
    await f.source.update("orders", inFlight.id, {
      paymentRecords: inFlight.paymentRecords.map(payment => ({ ...payment, status: terminalStatus })),
      ...(terminalStatus === "confirmed" ? { finalPaid: 70, finalFinanceStatus: "confirmed" } : {}),
    });
    release.resolve();
    const result = await creation;
    const saved = await f.read();
    assert.equal(saved.paymentRecords[0].status, terminalStatus);
    assert.equal(saved.paymentRecords[0].prepayId, undefined);
    if (terminalStatus === "confirmed") {
      assert.equal(result.success, true);
      assert.equal(result.data.status, "confirmed");
      assert.equal(result.data.invokeWeChatPay, false);
    } else {
      assert.equal(result.success, false);
      assert.match(result.error, /已失效/);
    }
  });
}

for (const operation of ["status", "create"]) {
  for (const stage of ["query", "close"]) {
    test(`${operation} exposes a controlled ${stage} recovery failure without replacing the pending transaction`, async t => {
      const f = fixture();
      const diagnostics = [];
      t.mock.method(console, "warn", line => { diagnostics.push(JSON.parse(line)); });
      const upstream = Object.assign(new Error("private upstream message and SQL must not escape"), {
        code: stage === "query" ? "WECHAT_PAY_SIGNATURE_INVALID" : "WECHAT_PAY_API_ERROR",
        providerCode: "SIGN_ERROR", providerRequestId: "safe-provider-request-123", httpStatus: 403,
        token: "private-token", openid: "private-openid", outTradeNo: "private-trade", prepayId: "private-prepay",
      });
      let queries = 0, closes = 0, creates = 0;
      f.gateway.queryTransaction = async () => {
        queries++;
        if (stage === "query") throw upstream;
        return { tradeState: "NOTPAY", outTradeNo: "SYNTHETICFINALTRADE" };
      };
      f.gateway.closeTransaction = async () => { closes++; throw upstream; };
      f.gateway.createJsapiTransaction = async () => { creates++; throw new Error("must not create another transaction"); };
      f.gateway.publicMessage = () => "微信支付配置异常，请联系客服";
      const original = await f.read();
      const result = await f[operation]();
      assert.deepEqual(result, { success: false, error: "微信支付配置异常，请联系客服", code: upstream.code });
      assert.equal(queries, 1, "a recovery error must not fall through into a duplicate query");
      assert.equal(closes, stage === "close" ? 1 : 0);
      assert.equal(creates, 0);
      assert.deepEqual((await f.read()).paymentRecords, original.paymentRecords);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].event, "payment.recovery.failed");
      const { timestamp, level, service, event, ...fields } = diagnostics[0];
      assert.deepEqual(fields, { code: upstream.code, providerCode: "SIGN_ERROR", providerRequestId: "safe-provider-request-123", httpStatus: 403 });
      assert.doesNotMatch(JSON.stringify({ result, diagnostics }), /private-|SQL/);
    });
  }
}

test("an unknown recovery exception uses the fallback response and excludes unsafe diagnostic fields", async t => {
  const f = fixture();
  const diagnostics = [];
  t.mock.method(console, "warn", line => { diagnostics.push(JSON.parse(line)); });
  f.gateway.publicMessage = undefined;
  f.gateway.queryTransaction = async () => {
    throw Object.assign(new Error("private-exception"), { code: "private-code with spaces", providerCode: "private-provider code", providerRequestId: "private-request\nheader", httpStatus: 900 });
  };
  const result = await f.status();
  assert.equal(result.success, false);
  assert.equal(result.code, "WECHAT_PAY_RECOVERY_FAILED");
  assert.match(result.error, /支付状态查询失败/);
  assert.doesNotMatch(JSON.stringify({ result, diagnostics }), /private-/);
  assert.equal((await f.read()).paymentRecords[0].status, "pending");
});

test("a payment still being authorized remains pending and is never closed or recreated", async () => {
  const f = fixture();
  let closes = 0, creates = 0;
  f.gateway.queryTransaction = async () => ({ tradeState: "USERPAYING", outTradeNo: "SYNTHETICFINALTRADE" });
  f.gateway.closeTransaction = async () => { closes++; };
  f.gateway.createJsapiTransaction = async () => { creates++; };
  const status = await f.status();
  assert.equal(status.success, true);
  assert.equal(status.data.status, "pending");
  assert.equal(status.data.syncPending, true);
  const result = await f.create();
  assert.deepEqual(result, { success: false, error: "支付状态同步中，请稍后重试" });
  assert.equal(closes, 0);
  assert.equal(creates, 0);
  assert.equal((await f.read()).paymentRecords[0].status, "pending");
});

test("a database write-back error retains only its safe cause code in server diagnostics", async t => {
  const f = fixture();
  const diagnostics = [];
  t.mock.method(console, "warn", line => diagnostics.push(JSON.parse(line)));
  f.gateway.queryTransaction = async () => ({ tradeState: "CLOSED", outTradeNo: "SYNTHETICFINALTRADE" });
  f.gateway.confirmTransaction = async () => { throw Object.assign(new Error("private SQL and customer data"), { code: "ER_BAD_FIELD_ERROR" }); };
  const result = await f.status();
  assert.equal(result.success, false);
  assert.equal(result.code, "WECHAT_PAY_RECOVERY_FAILED");
  assert.equal(diagnostics[0].causeCode, "ER_BAD_FIELD_ERROR");
  assert.doesNotMatch(JSON.stringify({ result, diagnostics }), /private SQL/);
  assert.equal((await f.read()).paymentRecords[0].status, "pending");
});
