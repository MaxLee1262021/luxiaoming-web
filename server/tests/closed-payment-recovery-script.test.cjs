"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseArgs, runRecovery } = require("../../scripts/recover-closed-wechat-payment.cjs");

const options = { root: "/opt/luxiaoming-admin", orderNo: "SYNTHETIC-ORDER" };

function fixture(state = "CLOSED") {
  let closes = 0, confirms = 0, queries = 0;
  const record = { id: "synthetic-payment", phase: "final", status: "pending", provider: "wechat_pay", outTradeNo: "SYNTHETICORIGINALTRADE" };
  const order = { id: "synthetic-order", orderNo: options.orderNo, contactPhone: "private-phone", openid: "private-openid", paymentRecords: [record] };
  const transaction = { outTradeNo: record.outTradeNo, tradeState: state, appid: "synthetic-app", mchid: "synthetic-merchant" };
  const source = {
    async list(key) { assert.equal(key, "orders"); return [structuredClone(order)]; },
    async get(key, id) { assert.equal(key, "orders"); assert.equal(id, order.id); return structuredClone(order); },
    async close() { closes++; },
  };
  const gateway = {
    isConfigured: () => true,
    async queryTransaction(value) { assert.equal(value, record.outTradeNo); queries++; return transaction; },
    async confirmTransaction(suppliedSource, suppliedTransaction) {
      assert.equal(suppliedSource, source);
      assert.equal(suppliedTransaction, transaction);
      confirms++;
      record.status = "failed";
      record.tradeState = state;
    },
    async createJsapiTransaction() { assert.fail("must never create a transaction"); },
    async closeTransaction() { assert.fail("must never close a transaction"); },
  };
  return { source, gateway, record, transaction, counts: () => ({ closes, confirms, queries }) };
}

test("recovery requires an explicit installation root and order number; amount inputs are rejected", () => {
  assert.throws(() => parseArgs(["--order-no", "SYNTHETIC"]), { code: "PAYMENT_RECOVERY_ARGUMENTS_INVALID" });
  assert.throws(() => parseArgs(["--root", "/opt/luxiaoming-admin"]), { code: "PAYMENT_RECOVERY_ARGUMENTS_INVALID" });
  assert.throws(() => parseArgs(["--root", "/opt/luxiaoming-admin", "--order-no", "SYNTHETIC", "--amount", "1"]), { code: "PAYMENT_RECOVERY_ARGUMENTS_INVALID" });
  assert.equal(parseArgs(["--root", "/opt/luxiaoming-admin", "--order-no", "SYNTHETIC"]).apply, false);
});

test("default dry-run queries only the original trade and closes its source without writes or PII output", async () => {
  const f = fixture();
  const result = await runRecovery(options, f);
  assert.deepEqual(result, { ok: true, dryRun: true, applied: false, localStatus: "pending", tradeState: "CLOSED" });
  assert.deepEqual(f.counts(), { closes: 1, confirms: 0, queries: 1 });
  assert.equal(f.record.status, "pending");
  assert.doesNotMatch(JSON.stringify(result), /private-|SYNTHETICORIGINALTRADE/);
});

for (const state of ["CLOSED", "PAYERROR", "REVOKED"]) {
  test(`apply delegates verified ${state} to the existing gateway and re-reads local status`, async () => {
    const f = fixture(state);
    const result = await runRecovery({ ...options, apply: true }, f);
    assert.deepEqual(result, { ok: true, dryRun: false, applied: true, localStatus: "failed", tradeState: state });
    assert.deepEqual(f.counts(), { closes: 1, confirms: 1, queries: 1 });
  });
}

for (const state of ["SUCCESS", "NOTPAY", "USERPAYING"]) {
  test(`${state} remains in its existing flow even with apply requested`, async () => {
    const f = fixture(state);
    const result = await runRecovery({ ...options, apply: true }, f);
    assert.equal(result.code, "PAYMENT_RECOVERY_EXISTING_FLOW_REQUIRED");
    assert.equal(result.applied, false);
    assert.equal(f.record.status, "pending");
    assert.deepEqual(f.counts(), { closes: 1, confirms: 0, queries: 1 });
  });
}

test("merchant identity validation failures leave the payment pending and close the source", async () => {
  const f = fixture();
  f.gateway.confirmTransaction = async () => {
    throw Object.assign(new Error("private merchant information"), { code: "WECHAT_PAY_NOTIFICATION_MISMATCH" });
  };
  const result = await runRecovery({ ...options, apply: true }, f);
  assert.equal(result.ok, false);
  assert.equal(result.code, "WECHAT_PAY_NOTIFICATION_MISMATCH");
  assert.equal(result.localStatus, "pending");
  assert.equal(f.counts().closes, 1);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("SQL errors retain their safe code without disclosing the SQL or original exception", async () => {
  const f = fixture();
  f.gateway.confirmTransaction = async () => {
    throw Object.assign(new Error("private SQL SELECT password FROM sensitive"), { code: "ER_BAD_FIELD_ERROR", sql: "private SQL", providerCode: "SYSTEM_ERROR", providerRequestId: "safe-request-123", httpStatus: 500 });
  };
  const result = await runRecovery({ ...options, apply: true }, f);
  assert.equal(result.code, "ER_BAD_FIELD_ERROR");
  assert.equal(result.providerCode, "SYSTEM_ERROR");
  assert.equal(result.providerRequestId, "safe-request-123");
  assert.equal(result.httpStatus, 500);
  assert.equal(result.localStatus, "pending");
  assert.equal(f.counts().closes, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|password|SELECT/);
});

test("a mismatched provider trade number cannot reach the write path", async () => {
  const f = fixture();
  f.transaction.outTradeNo = "OTHERTRADE123";
  const result = await runRecovery({ ...options, apply: true }, f);
  assert.equal(result.code, "WECHAT_PAY_TRANSACTION_MISMATCH");
  assert.equal(result.localStatus, "pending");
  assert.deepEqual(f.counts(), { closes: 1, confirms: 0, queries: 1 });
});

test("ambiguous pending final intents fail closed before any provider query", async () => {
  const f = fixture();
  f.source.list = async () => [{ id: "synthetic-order", orderNo: options.orderNo, paymentRecords: [f.record, { ...f.record, id: "other", outTradeNo: "OTHERSYNTHETICTRADE" }] }];
  const result = await runRecovery({ ...options, apply: true }, f);
  assert.equal(result.code, "PAYMENT_RECOVERY_INTENT_AMBIGUOUS");
  assert.deepEqual(f.counts(), { closes: 1, confirms: 0, queries: 0 });
});
