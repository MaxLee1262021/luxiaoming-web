"use strict";

const { PhysicalProviderError, requestJson } = require("./physicalHttp.cjs");
const text = value => String(value == null ? "" : value).trim();
const maskPhone = value => { const digits = text(value); return digits.length >= 4 ? `****${digits.slice(-4)}` : ""; };
function paymentFor(order = {}) {
  const payments = order.payments || order.paymentRecords || [];
  return order.payment || [...payments].reverse().find(item => item.status === "confirmed" || item.status === "paid") || {};
}
function paymentIdentity(order = {}) {
  const payment = paymentFor(order);
  return {
    transactionId: text(order.transactionId || order.externalTransactionId || payment.externalTransactionId || payment.transactionId),
    outTradeNo: text(order.outTradeNo || payment.outTradeNo),
    openid: text(order.openid || order.customerOpenid || order.customer_openid),
  };
}
function createWechatShipping(options = {}) {
  const env = options.env || process.env, request = options.request || requestJson;
  const appId = text(env.WX_APP_ID || env.WECHAT_APP_ID || env.WECHAT_PAY_APP_ID);
  const appSecret = text(env.WX_APP_SECRET);
  const enabled = ["1", "true"].includes(text(env.WECHAT_SHIPPING_ENABLED).toLowerCase());
  const merchantId = text(env.WECHAT_PAY_MCH_ID || env.WECHAT_MCH_ID);
  const clock = options.clock || (() => new Date());
  const timeoutMs = Math.max(1000, Math.min(Number(env.WECHAT_SHIPPING_TIMEOUT_MS) || 8000, 30000));
  let token = "", tokenExpiresAt = 0, tokenRequest = null;
  let carrierMap = {}, carrierMapInvalid = false;
  try {
    carrierMap = JSON.parse(text(env.WECHAT_SHIPPING_CARRIER_MAP) || "{}");
    if (!carrierMap || typeof carrierMap !== "object" || Array.isArray(carrierMap)) throw new Error();
  } catch (_) { carrierMapInvalid = true; }
  function configurationErrors() {
    const missing = [];
    if (!enabled) missing.push("WECHAT_SHIPPING_ENABLED");
    if (!appId) missing.push("WX_APP_ID");
    const paymentAppId = text(env.WECHAT_PAY_APP_ID || env.WECHAT_APP_ID);
    if (paymentAppId && text(env.WX_APP_ID) && paymentAppId !== text(env.WX_APP_ID)) missing.push("WECHAT_PAY_APP_ID must match WX_APP_ID");
    if (!appSecret && !options.tokenProvider) missing.push("WX_APP_SECRET");
    if (carrierMapInvalid) missing.push("WECHAT_SHIPPING_CARRIER_MAP");
    return missing;
  }
  function assertConfig() {
    if (configurationErrors().length) throw new PhysicalProviderError("微信发货管理尚未配置", { code: "WECHAT_SHIPPING_NOT_CONFIGURED", statusCode: 503 });
  }
  function carrierCode(shipment = {}) {
    // WeChat IDs and kuaidi100 codes are separate dictionaries. Never pass a
    // kuaidi100 lower-case code as an assumed WeChat provider ID.
    const code = text(shipment.wechatCarrierCode || carrierMap[shipment.carrierCode || shipment.companyCode]);
    if (!/^[A-Za-z0-9_-]{2,128}$/.test(code)) throw new PhysicalProviderError("此快递公司尚未配置微信物流编码", { code: "WECHAT_SHIPPING_CARRIER_UNMAPPED", statusCode: 409 });
    return code;
  }
  async function accessToken() {
    if (options.tokenProvider) return text(await options.tokenProvider());
    if (token && new Date(clock()).getTime() < tokenExpiresAt) return token;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const result = await request({ url: `https://api.weixin.qq.com/cgi-bin/token?${new URLSearchParams({ grant_type: "client_credential", appid: appId, secret: appSecret })}`, method: "GET", body: "", timeoutMs });
      if (!result.access_token) throw new PhysicalProviderError("微信授权获取失败", { code: "WECHAT_SHIPPING_TOKEN", retryable: ["-1", "45009"].includes(String(result.errcode)), providerCode: result.errcode });
      token = result.access_token;
      tokenExpiresAt = new Date(clock()).getTime() + Math.max(60, Number(result.expires_in || 7200) - 120) * 1000;
      return token;
    })();
    try { return await tokenRequest; } finally { tokenRequest = null; }
  }
  async function post(path, body) {
    assertConfig();
    const credential = await accessToken();
    if (!credential) throw new PhysicalProviderError("微信授权获取失败", { code: "WECHAT_SHIPPING_TOKEN" });
    const result = await request({ url: `https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(credential)}`, method: "POST", timeoutMs,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (Number(result.errcode || 0) !== 0) {
      if ([40001, 40014, 42001].includes(Number(result.errcode))) { token = ""; tokenExpiresAt = 0; }
      throw new PhysicalProviderError("微信发货管理请求未成功", { code: "WECHAT_SHIPPING_REJECTED", providerCode: result.errcode,
        retryable: [-1, 45009, 40001, 40014, 42001].includes(Number(result.errcode)) });
    }
    return result;
  }
  function identity(order) {
    const value = paymentIdentity(order);
    if ((!value.transactionId && (!merchantId || !value.outTradeNo)) || !value.openid) throw new PhysicalProviderError("微信支付关联信息不完整", { code: "WECHAT_SHIPPING_PAYMENT_MISSING", statusCode: 409 });
    return value;
  }
  async function upload(shipment, order) {
    assertConfig(); const expected = identity(order), expressCompany = carrierCode(shipment);
    const collected = ["collected", "in_transit", "out_for_delivery", "signed"].includes(shipment.logisticsStatus);
    if (!shipment.handedOverAt && !shipment.handoverConfirmedAt && !shipment.collectedAt && !collected) {
      throw new PhysicalProviderError("待核实实际交运后同步微信发货", { code: "WECHAT_SHIPPING_AWAITING_HANDOVER", statusCode: 409, retryable: true });
    }
    const trackingNo = text(shipment.trackingNo);
    if (!trackingNo || trackingNo.length > 128 || /[\r\n<>]/.test(trackingNo)) throw new PhysicalProviderError("物流单号不合法", { code: "PHYSICAL_TRACKING_INVALID", statusCode: 400 });
    const orderKey = expected.transactionId ? { order_number_type: 2, transaction_id: expected.transactionId }
      : { order_number_type: 1, mchid: merchantId, out_trade_no: expected.outTradeNo };
    const itemDesc = (order.items || order.products || []).map(item => `${text(item.name || item.nameSnapshot || item.productName)} × ${Number(item.quantity || 1)}`).join("；").slice(0, 120) || "影像周边";
    const phone = maskPhone(shipment.phone || shipment.address && shipment.address.phone || order.addressSnapshot && order.addressSnapshot.phone);
    const shippingItem = { tracking_no: trackingNo, express_company: expressCompany, item_desc: itemDesc };
    if (phone) shippingItem.contact = { receiver_contact: phone };
    const requestAt = shipment.wechatUploadRequestAt || shipment.dispatchConfirmedAt;
    if (!requestAt || !Number.isFinite(new Date(requestAt).getTime())) throw new PhysicalProviderError("微信发货请求版本未保存", { code: "WECHAT_SHIPPING_REQUEST_VERSION_MISSING", statusCode: 409 });
    // Persist before the external call. Retrying the same shipment must retain
    // its upload_time, rather than turning a lost response into a new shipping.
    const uploadTime = new Date(requestAt).toISOString();
    await post("/wxa/sec/order/upload_shipping_info", { order_key: orderKey, logistics_type: 1, delivery_mode: 1,
      shipping_list: [shippingItem], upload_time: uploadTime, payer: { openid: expected.openid } });
    return { status: "uploaded", shipmentId: String(shipment.id), version: Number(shipment.version || 1),
      trackingNo, wechatCarrierCode: expressCompany, uploadedAt: uploadTime, transactionId: expected.transactionId, outTradeNo: expected.outTradeNo };
  }
  async function queryReceipt(order, shipment = order.shipment) {
    const expected = identity(order);
    const result = await post("/wxa/sec/order/get_order", expected.transactionId ? { transaction_id: expected.transactionId }
      : { merchant_id: merchantId, merchant_trade_no: expected.outTradeNo });
    const value = result.order || {};
    if (!value.openid || value.openid !== expected.openid || (expected.transactionId && value.transaction_id !== expected.transactionId)
      || (!expected.transactionId && (value.merchant_trade_no !== expected.outTradeNo || value.merchant_id !== merchantId))) {
      throw new PhysicalProviderError("微信收货结果与支付订单不匹配", { code: "WECHAT_SHIPPING_ORDER_MISMATCH", statusCode: 409 });
    }
    const expectedCarrier = shipment ? carrierCode(shipment) : "";
    const uploadedAt = shipment && (shipment.wechatUploadedAt || shipment.wechatUpload && shipment.wechatUpload.uploadedAt);
    const expectedUploadSecond = uploadedAt ? Math.floor(new Date(uploadedAt).getTime() / 1000) : NaN;
    const matches = shipment && shipment.active !== false && Number.isFinite(expectedUploadSecond) && value.shipping && value.shipping.finish_shipping === true
      && (value.shipping.shipping_list || []).length === 1
      && value.shipping.shipping_list.some(item => text(item.tracking_no) === text(shipment.trackingNo) && text(item.express_company) === expectedCarrier
        && Number(item.upload_time) === expectedUploadSecond);
    // get_order documents state 3 as receipt confirmation. State 4 is trade
    // completion and state 6 settlement pending: neither proves a new receipt.
    const receiptConfirmed = Number(value.order_state) === 3;
    return {
      provider: "wechat_shipping", trusted: true, received: receiptConfirmed && !!matches && !value.in_complaint,
      platformReceiptConfirmed: receiptConfirmed, shipmentMatches: !!matches, inComplaint: !!value.in_complaint,
      shipmentId: shipment && String(shipment.id) || null, version: shipment && Number(shipment.version || 1) || null,
      orderNo: text(order.orderNo || order.order_no), outTradeNo: text(value.merchant_trade_no), transactionId: text(value.transaction_id),
      openid: value.openid, orderState: Number(value.order_state), mode: "unknown", confirmedAt: null,
      observedAt: new Date(clock()).toISOString(), finishShippingCount: Number(value.shipping && value.shipping.finish_shipping_count || 0),
    };
  }
  return { isConfigured: () => configurationErrors().length === 0, configured: () => configurationErrors().length === 0,
    configurationErrors, upload, queryReceipt, query: (input, shipment) => input && input.order ? queryReceipt(input.order, input.shipment) : queryReceipt(input, shipment),
    carrierCode, paymentIdentity };
}

module.exports = { createWechatShipping, paymentIdentity, maskPhone };
