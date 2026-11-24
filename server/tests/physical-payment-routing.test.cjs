"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createWechatPay } = require("../lib/wechatPay.cjs");
const { createMemoryStore, serviceFor } = require("../lib/physicalCommerce.cjs");
test('real payment validator routes full payment to physical facts without completing service or touching service collections', async () => {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const gateway = createWechatPay({ config: { apiHost: 'api.mch.weixin.qq.com', appId: 'wx1234567890abcdef', mchId: '1900000109', merchantSerialNo: 'TEST_SERIAL', merchantPrivateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }), apiV3Key: '0123456789abcdef0123456789abcdef', notifyUrl: 'https://example.test/notify', platformPublicKeyId: 'PUB_KEY_ID_TEST', platformPublicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) }, transport: async () => { throw new Error('network prohibited'); } });
  const source = { list: async () => { throw new Error('physical payment cannot read or enroll service orders'); } };
  const store = createMemoryStore({
    orders: [{ id: 'physical-one', orderNo: 'PGONE', openid: 'buyer', status: 'pending_payment', orderType: 'physical', version: 1, totalAmountFen: 1000, goodsAmountFen: 1000, shippingFeeFen: 0, refundedFen: 0, items: [{ id: 'item-one', skuId: 'sku-one', quantity: 1, priceFen: 1000, amountFen: 1000, refundedQuantity: 0 }] }],
    inventory: [{ id: 'sku-one', skuId: 'sku-one', onHand: 1, reserved: 1, sold: 0, version: 1 }],
    payments: [{ id: 'pay-one', outTradeNo: 'PGPAYMENT123', orderId: 'physical-one', phase: 'full', provider: 'wechat_pay', status: 'pending', amountFen: 1000, amount: 10 }],
  });
  serviceFor(source, { store, wechatPay: gateway });
  const transaction = { appid: 'wx1234567890abcdef', mchid: '1900000109', outTradeNo: 'PGPAYMENT123', transactionId: 'REAL_VALIDATOR_TEST', tradeState: 'SUCCESS', tradeType: 'JSAPI', payerOpenid: 'buyer', amountTotal: 1000, amountCurrency: 'CNY' };
  const result = await gateway.confirmTransaction(source, transaction);
  assert.equal(result.order.status, 'awaiting_shipment');
  assert.equal(store.snapshot().inventory[0].onHand, 0);
  const again = await gateway.confirmTransaction(source, transaction);
  assert.equal(again.idempotent, true);
  assert.equal(store.snapshot().inventory[0].sold, 1);
  await assert.rejects(gateway.confirmTransaction(source, { ...transaction, amountTotal: 1 }), /金额|amount/i);
  assert.equal(store.snapshot().orders[0].status, 'awaiting_shipment');
});
