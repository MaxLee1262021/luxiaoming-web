"use strict";
const createRealWechatPay = require("../../lib/wechatPay.cjs").createWechatPay;

function createTestWechatPay() {
  return {
    isConfigured() { return true; },
    createOutTradeNo(orderId, paymentId) {
      return `TEST${String(orderId)}${String(paymentId)}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32).padEnd(6, "0");
    },
    async createJsapiTransaction({ payment }) {
      const prepayId = `test-prepay-${payment.id}`.slice(0, 120);
      return { prepayId, paymentParams: this.buildMiniProgramPaymentParams(prepayId) };
    },
    buildMiniProgramPaymentParams(prepayId) {
      return {
        timeStamp: "1700000000",
        nonceStr: "test-payment-nonce",
        package: `prepay_id=${prepayId}`,
        signType: "RSA",
        paySign: "test-payment-signature",
      };
    },
    async queryTransaction(outTradeNo) {
      return { outTradeNo, tradeState: "NOTPAY", transactionId: "", amountTotal: 0 };
    },
    async closeTransaction() { return true; },
    async confirmTransaction() { throw new Error("not expected in this test gateway"); },
    publicMessage() { return "微信支付服务暂不可用，请稍后重试"; },
  };
}

let confirmationGateway;
function createConfirmationGateway() {
  if (confirmationGateway) return confirmationGateway;
  const crypto = require("node:crypto");
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  confirmationGateway = createRealWechatPay({
    config: { apiHost: "api.mch.weixin.qq.com", mchId: "1900000109", appId: "wx1234567890abcdef", merchantSerialNo: "TEST_SERIAL",
      merchantPrivateKey: keys.privateKey.export({ type: "pkcs1", format: "pem" }), apiV3Key: "0123456789abcdef0123456789abcdef",
      notifyUrl: "https://example.test/notify", platformPublicKeyId: "PUB_KEY_ID_3000000001", platformPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }) },
    transport: async () => { throw new Error("Network access is forbidden in fixture payment confirmations"); },
  });
  return confirmationGateway;
}

// Tests supply a synthetic successful provider transaction to the real amount,
// owner, phase and idempotency validation. No runtime RPC can invoke this helper.
async function confirmTestPayment(source, body = {}, ctx = {}) {
  const rpc = require("../../lib/rpc.cjs");
  const data = body.data || body;
  const context = { ...ctx, wechatPay: createTestWechatPay() };
  const prepared = await rpc(source, "createPayment", body, context);
  if (!prepared.success) return prepared;
  const record = await source.get(data.bookingId ? "bookingRequests" : "orders", data.bookingId || data.orderId);
  const payments = (record && record.paymentRecords || []).filter((payment) => payment.phase === data.phase && payment.provider === "wechat_pay");
  const payment = payments[payments.length - 1];
  if (!payment) return prepared;
  await createConfirmationGateway().confirmTransaction(source, {
    appid: "wx1234567890abcdef", mchid: "1900000109", outTradeNo: payment.outTradeNo, transactionId: `fixture-${payment.outTradeNo}`,
    tradeState: "SUCCESS", tradeType: "JSAPI", payerOpenid: ctx.identity && ctx.identity.openid,
    amountTotal: Math.round(payment.amount * 100), amountCurrency: "CNY",
  });
  return rpc(source, "getPaymentStatus", body, context);
}

let refundKeys;
function createTestRefundGateway(source, options = {}) {
  const crypto = require("node:crypto");
  refundKeys ||= crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serial = "PUB_KEY_ID_REFUND_TEST", replies = new Map(), requests = [];
  const gateway = createRealWechatPay({ config: {
    apiHost: "api.mch.weixin.qq.com", mchId: "1900000109", appId: "wx1234567890abcdef", merchantSerialNo: "TEST_SERIAL",
    merchantPrivateKey: refundKeys.privateKey.export({ type: "pkcs8", format: "pem" }), apiV3Key: "0123456789abcdef0123456789abcdef",
    notifyUrl: "https://example.test/api/payments/wechat/notify", platformPublicKeyId: serial,
    platformPublicKey: refundKeys.publicKey.export({ type: "spki", format: "pem" }),
  }, transport: async (request) => {
    requests.push(request);
    if (options.onRequest) await options.onRequest(request);
    let value;
    if (request.method === "POST" && request.path === "/v3/refund/domestic/refunds") {
      const body = JSON.parse(request.body);
      const orders = await source.list("orders");
      const payment = orders.flatMap((order) => order.paymentRecords || []).find((row) => row.externalTransactionId === body.transaction_id);
      if (!payment) throw new Error("Synthetic transport rejected unknown original transaction");
      value = replies.get(body.out_refund_no) || {
        mchid: "1900000109", refund_id: `wx-${body.out_refund_no}`, out_refund_no: body.out_refund_no,
        out_trade_no: payment.outTradeNo, transaction_id: body.transaction_id,
        status: options.status || "SUCCESS", amount: body.amount,
        ...((options.status || "SUCCESS") === "SUCCESS" ? { success_time: new Date().toISOString() } : {}),
      };
      replies.set(body.out_refund_no, value);
    } else if (request.method === "GET" && request.path.startsWith("/v3/refund/domestic/refunds/")) {
      value = replies.get(decodeURIComponent(request.path.split("/").pop()));
      if (!value) return { statusCode: 404, body: JSON.stringify({ code: "RESOURCE_NOT_EXISTS" }), headers: {} };
    } else throw new Error("Unexpected real-provider protocol in synthetic refund transport");
    const raw = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000)), nonce = "refund-test-nonce";
    return { statusCode: 200, body: raw, headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-serial": serial,
      "wechatpay-signature": crypto.sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), refundKeys.privateKey).toString("base64") } };
  } });
  gateway.refundRequests = requests;
  gateway.refundReplies = replies;
  return gateway;
}

module.exports = { createTestWechatPay, confirmTestPayment, createTestRefundGateway };
