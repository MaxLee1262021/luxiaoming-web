"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createWechatPay, WechatPayError, publicMessage } = require("../lib/wechatPay.cjs");

// Synthetic keys and an injected transport keep these diagnostics tests fully
// isolated from runtime credentials, external payment APIs and persistence.
const merchant = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  mchId: "1900000109", appId: "wx1234567890abcdef", merchantSerialNo: "TEST_MERCHANT_SERIAL",
  merchantPrivateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }),
  apiV3Key: "0123456789abcdef0123456789abcdef", notifyUrl: "https://example.test/payments/notify",
  platformPublicKeyId: "PUB_KEY_ID_TEST_DIAGNOSTICS",
  platformPublicKey: platform.publicKey.export({ type: "spki", format: "pem" }),
  apiHost: "api.mch.weixin.qq.com",
};
const hidden = "private-request-data-do-not-display";

function gatewayFor(response) {
  return createWechatPay({ config, transport: async () => response });
}

function createPayment(gateway) {
  return gateway.createJsapiTransaction({ order: { packageName: "测试项目" }, phase: "final",
    payment: { amount: 70, outTradeNo: "LXM_DIAGNOSTIC_TEST_TRADE" }, openid: "synthetic-openid" });
}

async function rejected(promise) {
  try { await promise; }
  catch (error) { assert(error instanceof WechatPayError); return error; }
  assert.fail("Expected a controlled payment error");
}

function safeError(error) {
  const fields = JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(error).map(key => [key, error[key]])));
  assert(!fields.includes(hidden), "Error fields must not retain provider messages, bodies, details or transport causes");
  for (const field of ["cause", "response", "headers", "raw", "body", "detail", "providerMessage"]) {
    assert.equal(Object.hasOwn(error, field), false, `Unexpected raw diagnostic field: ${field}`);
  }
  assert(!publicMessage(error).includes(hidden));
}

test("documented API v3 errors select controlled messages and preserve safe diagnostic identifiers", async () => {
  // Official ordinary-merchant mini-program API v3 error tables:
  // https://pay.wechatpay.cn/doc/v3/merchant/4012791897
  // https://pay.wechatpay.cn/doc/v3/merchant/4012791900
  const cases = [
    [401, "SIGN_ERROR", "微信支付商户签名校验失败，请联系客服"],
    [403, "NO_AUTH", "商户微信支付权限不足，请联系客服"],
    [400, "APPID_MCHID_NOT_MATCH", "小程序与支付商户未正确关联，请联系客服"],
    [400, "MCH_NOT_EXISTS", "微信支付商户配置异常，请联系客服"],
    [429, "FREQUENCY_LIMITED", "微信支付请求频繁，请稍后重试"],
    [500, "SYSTEM_ERROR", "微信支付服务繁忙，请稍后重试"],
  ];
  for (const [statusCode, code, message] of cases) {
    const gateway = gatewayFor({ statusCode, headers: { "Request-ID": "test-request_123-ABC", Authorization: hidden },
      body: JSON.stringify({ code, message: hidden, detail: { field: hidden, value: hidden } }) });
    const error = await rejected(createPayment(gateway));
    assert.equal(error.code, "WECHAT_PAY_API_ERROR");
    assert.equal(error.httpStatus, statusCode);
    assert.equal(error.providerCode, code);
    assert.equal(error.providerRequestId, "test-request_123-ABC");
    assert.equal(error.message, "Wechat Pay API rejected request");
    assert.equal(gateway.publicMessage(error), message);
    safeError(error);
  }
});

test("an unknown provider code remains diagnostic data and never becomes a displayed message", async () => {
  const error = await rejected(createPayment(gatewayFor({ statusCode: 400,
    headers: { "rEqUeSt-Id": "unknown-code-request" },
    body: JSON.stringify({ code: "UNRECOGNIZED_PROVIDER_CODE", message: hidden }) })));
  assert.equal(error.providerCode, "UNRECOGNIZED_PROVIDER_CODE");
  assert.equal(error.providerRequestId, "unknown-code-request");
  assert.equal(publicMessage(error), "微信支付服务暂不可用，请稍后重试");
  assert.equal(publicMessage(error, "受控备用提示"), "受控备用提示");
  safeError(error);
});

test("provider error codes reject whitespace, control characters, objects and excessive lengths", async () => {
  for (const code of ["SIGN_ERROR\n", "SIGN_ERROR\r\n" + hidden, "sign_error", "A".repeat(65),
    { value: "SIGN_ERROR", private: hidden }, 123, null]) {
    const error = await rejected(createPayment(gatewayFor({ statusCode: 401, headers: {},
      body: JSON.stringify({ code, message: hidden }) })));
    assert.equal(Object.hasOwn(error, "providerCode"), false);
    assert.equal(publicMessage(error), "微信支付服务暂不可用，请稍后重试");
    safeError(error);
  }
});

test("provider request IDs reject newlines, punctuation and excessive lengths", async () => {
  for (const requestId of ["request-id\n", "request-id\r\n" + hidden, "request id", "request/id", "A".repeat(129)]) {
    const error = await rejected(createPayment(gatewayFor({ statusCode: 500, headers: { "Request-ID": requestId },
      body: JSON.stringify({ code: "SYSTEM_ERROR", message: hidden }) })));
    assert.equal(Object.hasOwn(error, "providerRequestId"), false);
    safeError(error);
  }
});

test("only a documented missing-order response permits transaction-not-found recovery", async () => {
  const gateway = gatewayFor({ statusCode: 404, headers: { "Request-ID": "missing-order-request" },
    body: JSON.stringify({ code: "ORDER_NOT_EXIST", message: hidden }) });
  const error = await rejected(gateway.queryTransaction("LXM_DIAGNOSTIC_TEST_TRADE"));
  assert.equal(error.code, "WECHAT_PAY_TRANSACTION_NOT_FOUND");
  assert.equal(error.httpStatus, 404);
  assert.equal(error.providerCode, "ORDER_NOT_EXIST");
  assert.equal(error.providerRequestId, "missing-order-request");
  safeError(error);

  for (const [statusCode, body] of [[404, `<html>${hidden}</html>`], [404, JSON.stringify({ code: "RESOURCE_NOT_EXISTS", message: hidden })],
    [404, JSON.stringify({ message: hidden })], [400, JSON.stringify({ code: "ORDER_NOT_EXIST", message: hidden })]]) {
    const other = await rejected(gatewayFor({ statusCode, headers: {}, body }).queryTransaction("LXM_DIAGNOSTIC_TEST_TRADE"));
    assert.equal(other.code, "WECHAT_PAY_API_ERROR", "A proxy 404 or another provider error must preserve the uncertain payment");
    safeError(other);
  }
});

test("network failures retain only allowlisted system codes and no transport error contents", async () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "CERT_HAS_EXPIRED", "PRIVATE_SECRET", "ECONNRESET\n", undefined]) {
    const gateway = createWechatPay({ config, transport: async () => {
      throw Object.assign(new Error(hidden), { code, hostname: hidden, cause: new Error(hidden), request: hidden });
    } });
    const error = await rejected(createPayment(gateway));
    assert.equal(error.code, "WECHAT_PAY_NETWORK_ERROR");
    const safeCode = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "CERT_HAS_EXPIRED"].includes(code);
    assert.equal(error.networkCode, safeCode ? code : undefined);
    assert.equal(publicMessage(error), "微信支付网络连接异常，请稍后重试");
    safeError(error);
  }
});

test("response-signature errors preserve a safe request ID without weakening verification", async () => {
  const error = await rejected(createPayment(gatewayFor({ statusCode: 200,
    headers: { "Request-ID": "signature-failure-request" }, body: JSON.stringify({ prepay_id: hidden }) })));
  assert.equal(error.code, "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID");
  assert.equal(error.httpStatus, 200);
  assert.equal(error.providerRequestId, "signature-failure-request");
  assert.equal(publicMessage(error), "微信支付服务响应校验失败，请稍后重试");
  safeError(error);
});

test("close-order failures retain diagnostic codes while an empty 204 still succeeds", async () => {
  const error = await rejected(gatewayFor({ statusCode: 403, headers: { "Request-ID": "close-error-request" },
    body: JSON.stringify({ code: "NO_AUTH", message: hidden }) }).closeTransaction("LXM_DIAGNOSTIC_TEST_TRADE"));
  assert.equal(error.providerCode, "NO_AUTH");
  assert.equal(error.providerRequestId, "close-error-request");
  assert.equal(error.httpStatus, 403);
  safeError(error);
  assert.equal(await gatewayFor({ statusCode: 204, headers: {}, body: "" }).closeTransaction("LXM_DIAGNOSTIC_TEST_TRADE"), true);
});
