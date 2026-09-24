"use strict";

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

module.exports = { createTestWechatPay };
