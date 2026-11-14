"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { diagnose, diagnosticTransport, parseOptions } = require("../../scripts/diagnose-wechat-payment.cjs");

function fixture() {
  const queries = [], calls = [];
  const payment = { phase: "final", amount: "0.21", status: "pending", provider: "wechat_pay", idempotency_key: "private-request-key",
    out_trade_no: "private-trade-no", prepay_id: null, record_created_at: "2026-11-14T01:14:39Z" };
  const connection = {
    async query(sql) { queries.push(sql); assert.equal(sql, "SET TRANSACTION READ ONLY"); },
    async beginTransaction() { calls.push("begin"); },
    async execute(sql) {
      queries.push(sql);
      assert.match(sql, /^SELECT /);
      return [sql.includes("FROM lxm_orders ") ? [{ id: "private-order-id", status: "final_pending", workflowStage: "awaiting_final_payment" }] : [payment]];
    },
    async rollback() { calls.push("rollback"); }, async end() { calls.push("end"); },
  };
  const gateway = { isConfigured: () => true,
    async queryTransaction(outTradeNo) { assert.equal(outTradeNo, payment.out_trade_no); calls.push("query"); return { tradeState: "NOTPAY", payerOpenid: "private-openid" }; } };
  return { payment, queries, calls, gateway, dependencies: { connect: async () => connection, createGateway: () => gateway } };
}

test("payment diagnostic rolls back its read-only transaction before querying the original trade", async () => {
  const f = fixture();
  const result = await diagnose({ orderNo: "LS-DIAGNOSTIC", phase: "final" }, f.dependencies);
  assert.deepEqual(f.calls, ["begin", "rollback", "end", "query"]);
  assert.equal(result.query.tradeState, "NOTPAY");
  assert.equal(result.query.verifiedResponse, true);
  assert.equal(result.payments[0].hasPrepayId, false);
  assert.doesNotMatch(JSON.stringify(result), /private-request-key|private-trade-no|private-order-id|private-openid/);
});

test("payment diagnostic reports safe errors without exception text or local transaction changes", async () => {
  const f = fixture();
  f.gateway.queryTransaction = async () => { throw Object.assign(new Error("private credentials and response body"), { code: "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID" }); };
  const result = await diagnose({ orderNo: "LS-DIAGNOSTIC", phase: "final" }, f.dependencies);
  assert.equal(result.query.errorCode, "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID");
  assert.doesNotMatch(JSON.stringify(result), /private credentials/);
  assert.equal(f.payment.status, "pending");
});

test("diagnostic transport rejects mutations and alternate destinations before opening a network request", async () => {
  const transport = diagnosticTransport({});
  for (const request of [
    { hostname: "api.mch.weixin.qq.com", method: "POST", path: "/v3/pay/transactions/jsapi" },
    { hostname: "example.test", method: "GET", path: "/v3/pay/transactions/out-trade-no/TRADE?mchid=123" },
    { hostname: "api.mch.weixin.qq.com", method: "GET", path: "/other" },
  ]) await assert.rejects(transport(request), { code: "DIAGNOSTIC_WRITE_FORBIDDEN" });
});

test("diagnostic requires an explicit order and a recognized phase", () => {
  assert.throws(() => parseOptions([]), { code: "DIAGNOSTIC_ARGUMENTS_INVALID" });
  assert.throws(() => parseOptions(["--order-no", "LS1", "--phase", "refund"]), { code: "DIAGNOSTIC_ARGUMENTS_INVALID" });
  assert.equal(parseOptions(["--order-no", "LS1"]).phase, "final");
});
