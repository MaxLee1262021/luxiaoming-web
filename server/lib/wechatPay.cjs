"use strict";

// WeChat Pay API v3 adapter. Credentials remain outside the repository and
// are loaded from the server environment only.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const {
  WORKFLOW_STAGES,
  canonicalStage,
  depositDue,
  finalDue,
  hasConfirmedPayment,
  makePaymentId,
  normalizePaymentStatus,
  roundMoney,
  selectionConfirmed,
  withOrderMutex,
} = require("./orderWorkflow.cjs");

const API_HOST = "api.mch.weixin.qq.com";
const API_PATH = "/v3/pay/transactions/jsapi";
const SUCCESS_TRADE_STATE = "SUCCESS";
const TERMINAL_UNPAID_STATES = new Set(["CLOSED", "PAYERROR", "REVOKED"]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
]);

function diagnosticToken(value, pattern) {
  const match = typeof value === "string" && value.match(pattern);
  return match && match[0] === value ? value : "";
}

class WechatPayError extends Error {
  constructor(message, { code = "WECHAT_PAY_ERROR", statusCode = 502, providerCode, providerRequestId, networkCode } = {}) {
    super(message);
    this.name = "WechatPayError";
    this.code = code;
    this.statusCode = statusCode;
    const safeProviderCode = diagnosticToken(providerCode, /^[A-Z][A-Z0-9_]{0,63}$/);
    const safeRequestId = diagnosticToken(providerRequestId, /^[A-Za-z0-9_-]{1,128}$/);
    if (safeProviderCode) this.providerCode = safeProviderCode;
    if (safeRequestId) this.providerRequestId = safeRequestId;
    if (NETWORK_ERROR_CODES.has(networkCode)) this.networkCode = networkCode;
  }
}

function text(value) { return String(value || "").trim(); }
function itemId(value) { return String(value && (value.id || value._id) || ""); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function headerValue(headers = {}, name) {
  const target = String(name).toLowerCase();
  const found = Object.keys(headers || {}).find((key) => key.toLowerCase() === target);
  const value = found ? headers[found] : "";
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}
function asPem(value) { return text(value).replace(/\\n/g, "\n"); }

function readPem(inline, filePath, label, errors) {
  const value = asPem(inline);
  if (value) return value;
  const path = text(filePath);
  if (!path) return "";
  try { return fs.readFileSync(path, "utf8"); }
  catch (_) {
    errors.push(`${label} unreadable`);
    return "";
  }
}

function platformVerifiersFromEnvironment(env, errors) {
  const raw = text(env.WECHAT_PAY_PLATFORM_VERIFIERS);
  if (!raw) return [];
  let entries;
  try { entries = JSON.parse(raw); }
  catch (_) {
    errors.push("WECHAT_PAY_PLATFORM_VERIFIERS invalid JSON");
    return [];
  }
  if (!Array.isArray(entries)) {
    errors.push("WECHAT_PAY_PLATFORM_VERIFIERS must be an array");
    return [];
  }
  return entries.map((entry, index) => {
    const value = entry && typeof entry === "object" ? entry : {};
    const label = `WECHAT_PAY_PLATFORM_VERIFIERS[${index}]`;
    return {
      serialNo: text(value.serialNo || value.serial || value.id),
      publicKey: readPem(value.publicKey, value.publicKeyPath, `${label}.publicKeyPath`, errors),
      certificate: readPem(value.certificate, value.certificatePath, `${label}.certificatePath`, errors),
    };
  });
}

function configFromEnvironment(env = process.env) {
  const errors = [];
  const explicitAppId = text(env.WECHAT_PAY_APP_ID || env.WECHAT_APP_ID);
  const loginAppId = text(env.WX_APP_ID);
  const appId = explicitAppId || loginAppId;
  if (explicitAppId && loginAppId && explicitAppId !== loginAppId) {
    errors.push("WECHAT_PAY_APP_ID must match WX_APP_ID");
  }
  const merchantPrivateKey = readPem(
    env.WECHAT_PAY_MCH_PRIVATE_KEY,
    env.WECHAT_PAY_MCH_PRIVATE_KEY_PATH,
    "WECHAT_PAY_MCH_PRIVATE_KEY_PATH",
    errors,
  );
  const publicKeyPem = readPem(
    env.WECHAT_PAY_PLATFORM_PUBLIC_KEY,
    env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH,
    "WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH",
    errors,
  );
  const certificatePem = readPem(
    "",
    env.WECHAT_PAY_PLATFORM_CERT_PATH,
    "WECHAT_PAY_PLATFORM_CERT_PATH",
    errors,
  );
  const platformVerifiers = platformVerifiersFromEnvironment(env, errors);
  return {
    mchId: text(env.WECHAT_PAY_MCH_ID || env.WECHAT_MCH_ID),
    appId,
    merchantSerialNo: text(env.WECHAT_PAY_MCH_SERIAL_NO || env.WECHAT_MCH_SERIAL_NO),
    merchantPrivateKey,
    apiV3Key: text(env.WECHAT_PAY_API_V3_KEY),
    notifyUrl: text(env.WECHAT_PAY_NOTIFY_URL),
    refundNotifyUrl: text(env.WECHAT_PAY_REFUND_NOTIFY_URL),
    platformPublicKeyId: text(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID),
    platformPublicKey: publicKeyPem,
    platformCertificateSerialNo: text(env.WECHAT_PAY_PLATFORM_CERT_SERIAL_NO),
    platformCertificate: certificatePem,
    platformVerifiers,
    apiHost: text(env.WECHAT_PAY_API_HOST) || API_HOST,
    timeoutMs: Number(env.WECHAT_PAY_TIMEOUT_MS || 10000),
    initialErrors: errors,
  };
}

function normalizeConfig(input = {}) {
  const config = { ...input };
  const errors = Array.isArray(config.initialErrors) ? [...config.initialErrors] : [];
  const appendMissing = (value, label) => { if (!text(value)) errors.push(`${label} missing`); };
  appendMissing(config.mchId, "WECHAT_PAY_MCH_ID");
  appendMissing(config.appId, "WECHAT_PAY_APP_ID");
  appendMissing(config.merchantSerialNo, "WECHAT_PAY_MCH_SERIAL_NO");
  appendMissing(config.merchantPrivateKey, "WECHAT_PAY_MCH_PRIVATE_KEY_PATH");
  appendMissing(config.apiV3Key, "WECHAT_PAY_API_V3_KEY");
  appendMissing(config.notifyUrl, "WECHAT_PAY_NOTIFY_URL");

  let merchantPrivateKey = null;
  if (text(config.merchantPrivateKey)) {
    try { merchantPrivateKey = crypto.createPrivateKey(config.merchantPrivateKey); }
    catch (_) { errors.push("merchant private key invalid"); }
  }

  const rawVerifiers = [
    ...(Array.isArray(config.platformVerifiers) ? config.platformVerifiers : []),
    {
      serialNo: text(config.platformPublicKeyId),
      publicKey: config.platformPublicKey,
      certificate: "",
    },
    {
      serialNo: text(config.platformCertificateSerialNo),
      publicKey: "",
      certificate: config.platformCertificate,
    },
  ].filter((entry) => entry && (text(entry.serialNo) || text(entry.publicKey) || text(entry.certificate)));
  const platformVerifiers = new Map();
  for (const entry of rawVerifiers) {
    const serialNo = text(entry.serialNo);
    if (!serialNo) { errors.push("platform verifier serial missing"); continue; }
    try {
      const publicKey = text(entry.publicKey)
        ? crypto.createPublicKey(entry.publicKey)
        : text(entry.certificate)
          ? new crypto.X509Certificate(entry.certificate).publicKey
          : null;
      if (!publicKey) { errors.push("platform verifier key missing"); continue; }
      const key = serialNo.toUpperCase();
      const existing = platformVerifiers.get(key);
      if (existing) {
        const same = Buffer.compare(
          Buffer.from(existing.export({ type: "spki", format: "der" })),
          Buffer.from(publicKey.export({ type: "spki", format: "der" })),
        ) === 0;
        if (!same) errors.push("platform verifier serial duplicated");
      } else {
        platformVerifiers.set(key, publicKey);
      }
    } catch (_) { errors.push("platform verifier invalid"); }
  }
  if (!platformVerifiers.size) errors.push("platform public key or certificate missing");
  const platformSerialNo = text(config.platformSerialNo || config.platformPublicKeyId || config.platformCertificateSerialNo) || Array.from(platformVerifiers.keys())[0] || "";
  if (platformSerialNo && !platformVerifiers.has(platformSerialNo.toUpperCase())) errors.push("primary platform verifier missing");

  if (Buffer.byteLength(text(config.apiV3Key), "utf8") !== 32) errors.push("WECHAT_PAY_API_V3_KEY must be 32 bytes");
  let notifyUrl = null;
  try {
    notifyUrl = new URL(text(config.notifyUrl));
    if (notifyUrl.protocol !== "https:" || notifyUrl.search || notifyUrl.hash) throw new Error("invalid");
  } catch (_) {
    errors.push("WECHAT_PAY_NOTIFY_URL must be a public HTTPS URL without a query string");
  }
  let refundNotifyUrl = null;
  try {
    refundNotifyUrl = new URL(text(config.refundNotifyUrl) || (notifyUrl && new URL("/api/payments/wechat/refund-notify", notifyUrl).toString()));
    if (refundNotifyUrl.protocol !== "https:" || refundNotifyUrl.search || refundNotifyUrl.hash) throw new Error("invalid");
  } catch (_) { errors.push("WECHAT_PAY_REFUND_NOTIFY_URL must be a public HTTPS URL without a query string"); }
  if (!/^[A-Za-z0-9.-]+$/.test(text(config.apiHost))) errors.push("WECHAT_PAY_API_HOST invalid");

  const timeout = Number(config.timeoutMs);
  return {
    configured: errors.length === 0,
    errors: [...new Set(errors)],
    mchId: text(config.mchId),
    appId: text(config.appId),
    merchantSerialNo: text(config.merchantSerialNo),
    merchantPrivateKey,
    apiV3Key: text(config.apiV3Key),
    notifyUrl: notifyUrl && notifyUrl.toString(),
    refundNotifyUrl: refundNotifyUrl && refundNotifyUrl.toString(),
    platformVerifiers,
    platformSerialNo,
    apiHost: text(config.apiHost) || API_HOST,
    timeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 1000), 30000) : 10000,
  };
}

function randomNonce() { return crypto.randomBytes(16).toString("hex"); }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

function createOutTradeNo(orderId, paymentId) {
  // API v3 accepts 6-32 alphanumeric characters. The hash avoids exposing an
  // internal order id and gives every payment attempt a stable, unique key.
  return `LXM${sha256(`${orderId}:${paymentId}`).slice(0, 29)}`;
}

function amountInFen(value) {
  const amount = roundMoney(value);
  const fen = Math.round(amount * 100);
  if (!Number.isFinite(fen) || fen <= 0 || Math.abs(fen / 100 - amount) > 0.000001) {
    throw new WechatPayError("Payment amount invalid", { code: "WECHAT_PAY_AMOUNT_INVALID", statusCode: 400 });
  }
  return fen;
}

// Refund requests must never silently round an amount with a third decimal.
function refundAmountInFen(value) {
  const raw = typeof value === "number" ? String(value) : text(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new WechatPayError("Refund amount invalid", { code: "WECHAT_PAY_REFUND_AMOUNT_INVALID", statusCode: 400 });
  const [whole, fraction = ""] = raw.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new WechatPayError("Refund amount invalid", { code: "WECHAT_PAY_REFUND_AMOUNT_INVALID", statusCode: 400 });
  return Number(result);
}

const MERCHANT_SHARE_WORK = new WeakMap();
function enqueueMerchantShare(source, order) {
  const orderId = itemId(order);
  if (!source || !orderId || source.bookingRequestSource) return { scheduled: false };
  let pending = MERCHANT_SHARE_WORK.get(source);
  if (!pending) { pending = new Map(); MERCHANT_SHARE_WORK.set(source, pending); }
  if (pending.has(orderId)) return { scheduled: true, existed: true, orderId };
  let finish;
  const work = { promise: new Promise(resolve => { finish = resolve; }) };
  pending.set(orderId, work);
  const run = async () => {
    let result;
    try {
      // The callback's only responsibility was persisting the paid receipt and
      // retry marker. Read its authoritative facts after leaving that path;
      // neither caller-supplied money nor rule/binding work runs in the callback.
      const saved = await source.get("orders", orderId);
      if (!saved || !saved.shareEnqueuePending) result = { orderId, skipped: true, reason: "NO_PENDING_RECEIPT" };
      else {
        const delivered = await require("./merchantShare.cjs").enqueuePaidOrder(source, saved);
        const patch = { shareEnqueuePending: false };
        const cleared = typeof source.compareAndUpdate === "function"
          ? await source.compareAndUpdate("orders", orderId, { shareEnqueuePending: true, paymentRecords: saved.paymentRecords,
            depositPaid: saved.depositPaid, finalPaid: saved.finalPaid, finalPaidAt: saved.finalPaidAt, completedAt: saved.completedAt }, patch)
          : await source.update("orders", orderId, patch);
        // Explicit skips (not enabled / before launch) also finish old markers.
        // A changed receipt or storage error keeps its marker for the worker.
        result = { orderId, delivered: true, markerCleared: !!cleared, ...(delivered?.skipped ? { skipped: true, reason: delivered.reason } : {}) };
      }
    } catch (error) {
      result = { orderId, failed: true, code: String(error?.code || "SHARE_ENQUEUE_FAILED") };
    } finally {
      if (pending.get(orderId) === work) pending.delete(orderId);
      finish(result);
    }
  };
  try { setImmediate(run); }
  catch (_) { pending.delete(orderId); finish({ orderId, failed: true, code: "SHARE_SCHEDULE_FAILED" }); return { scheduled: false, orderId }; }
  return { scheduled: true, existed: false, orderId };
}

async function drainMerchantShare(source) {
  const results = [];
  const pending = MERCHANT_SHARE_WORK.get(source);
  while (pending && pending.size) results.push(...await Promise.all([...pending.values()].map(work => work.promise)));
  return results;
}

function refundFromResponse(value = {}) {
  return {
    refundNo: text(value.out_refund_no), refundId: text(value.refund_id),
    outTradeNo: text(value.out_trade_no), transactionId: text(value.transaction_id),
    mchId: text(value.mchid), status: text(value.status || value.refund_status).toUpperCase(),
    amount: Number(value.amount && value.amount.refund), total: Number(value.amount && value.amount.total),
    currency: text(value.amount && value.amount.currency || "CNY").toUpperCase(),
    successTime: text(value.success_time), raw: value,
  };
}

function paymentDescription(order = {}, phase = "") {
  const name = text(order.packageName || order.confirmationSnapshot && (order.confirmationSnapshot.name || order.confirmationSnapshot.packageName) || "旅拍服务")
    .replace(/[\r\n\t]+/g, " ");
  const suffix = phase === "full" ? "商品全款" : phase === "final" ? "尾款" : "订金";
  return `麓小鸣旅拍-${name}-${suffix}`.slice(0, 127);
}

function defaultTransport({ hostname, method, path, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname, method, path, headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ statusCode: Number(response.statusCode || 0), headers: response.headers || {}, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("Wechat Pay request timed out"), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    request.end(body || "");
  });
}

function publicMessage(error, fallback = "微信支付服务暂不可用，请稍后重试") {
  if (error && error.code === "WECHAT_PAY_CONFIG_INVALID") return "微信支付暂未配置，请联系客服";
  if (error && error.code === "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID") return "微信支付服务响应校验失败，请稍后重试";
  if (error && error.code === "WECHAT_PAY_NETWORK_ERROR") return "微信支付网络连接异常，请稍后重试";
  if (error && error.code === "WECHAT_PAY_API_ERROR") {
    // Only documented API v3 codes select customer-facing messages. Never
    // display the provider's message/detail, which can contain request data.
    switch (error.providerCode) {
      case "SIGN_ERROR": return "微信支付商户签名校验失败，请联系客服";
      case "NO_AUTH": return "商户微信支付权限不足，请联系客服";
      case "APPID_MCHID_NOT_MATCH": return "小程序与支付商户未正确关联，请联系客服";
      case "MCH_NOT_EXISTS": return "微信支付商户配置异常，请联系客服";
      case "FREQUENCY_LIMITED": return "微信支付请求频繁，请稍后重试";
      case "SYSTEM_ERROR": return "微信支付服务繁忙，请稍后重试";
    }
  }
  return fallback;
}

function paymentRecordFor(order = {}, outTradeNo) {
  const expected = text(outTradeNo);
  const matches = (Array.isArray(order.paymentRecords) ? order.paymentRecords : []).filter((record) => text(record && record.outTradeNo) === expected);
  return matches.length === 1 ? matches[0] : null;
}

function orderedPaymentMatch(order = {}, outTradeNo) {
  const record = paymentRecordFor(order, outTradeNo);
  return record ? { order, record } : null;
}

async function locatePayment(source, outTradeNo) {
  if (!source.bookingRequestSource) {
    const bookingSource = require("./bookingRequests.cjs").bookingPaymentSource(source);
    const booking = await bookingSource.findOrderByPaymentOutTradeNo(outTradeNo);
    if (booking) {
      // A promoted order intentionally retains its deposit transaction. An
      // unrelated order claiming the same trade number must fail closed.
      const order = typeof source.findOrderByPaymentOutTradeNo === "function"
        ? await source.findOrderByPaymentOutTradeNo(outTradeNo)
        : (await source.list("orders") || []).find((candidate) => paymentRecordFor(candidate, outTradeNo));
      if (order && String(order.bookingId || "") !== itemId(booking)) throw new WechatPayError("Payment trade number conflict", { code: "WECHAT_PAY_PAYMENT_AMBIGUOUS", statusCode: 409 });
      const match = orderedPaymentMatch(booking, outTradeNo);
      if (!match) throw new WechatPayError("Payment record ambiguous", { code: "WECHAT_PAY_PAYMENT_AMBIGUOUS", statusCode: 409 });
      return { ...match, booking: true };
    }
  }
  if (source && typeof source.findOrderByPaymentOutTradeNo === "function") {
    const order = await source.findOrderByPaymentOutTradeNo(outTradeNo);
    const match = order ? orderedPaymentMatch(order, outTradeNo) : null;
    if (match) return match;
  }
  const rows = await source.list("orders");
  const matches = (Array.isArray(rows) ? rows : []).map((order) => orderedPaymentMatch(order, outTradeNo)).filter(Boolean);
  if (matches.length !== 1) {
    throw new WechatPayError("Payment order not found", { code: matches.length ? "WECHAT_PAY_PAYMENT_AMBIGUOUS" : "WECHAT_PAY_PAYMENT_NOT_FOUND", statusCode: 404 });
  }
  return matches[0];
}

function expectedOrderFields(order = {}) {
  return {
    ...(order.bookingStatus ? { bookingStatus: order.bookingStatus } : {}),
    paymentRecords: Array.isArray(order.paymentRecords) ? order.paymentRecords : [],
    statusLogs: Array.isArray(order.statusLogs) ? order.statusLogs : [],
    followRecords: Array.isArray(order.followRecords) ? order.followRecords : [],
    status: order.status,
    workflowStage: order.workflowStage,
    depositPaid: order.depositPaid,
    depositFinanceStatus: order.depositFinanceStatus,
    finalPaid: order.finalPaid,
    finalFinanceStatus: order.finalFinanceStatus,
    service_status: order.service_status,
    done_at: order.done_at,
    completedAt: order.completedAt,
    shootingCompletedAt: order.shootingCompletedAt,
    paymentReviewRequired: order.paymentReviewRequired,
  };
}

async function compareAndUpdate(source, id, expected, patch) {
  if (source && typeof source.compareAndUpdate === "function") {
    return source.compareAndUpdate("orders", id, expected, patch);
  }
  return source.update("orders", id, patch);
}

function validPaymentPhase(phase) { return phase === "deposit" || phase === "final"; }

function canConfirmPhase(order, phase) {
  // Cancellation closes future issuance, never erases a provider-verified
  // payment that arrives late. The amount and payer checks still run first.
  if (phase === "deposit" && ["cancelled", "cancelling"].includes(order.bookingStatus)) return true;
  if (phase === "deposit") return canonicalStage(order) === WORKFLOW_STAGES.AWAITING_DEPOSIT;
  // The final payment itself acknowledges the customer's selection. The only
  // server-side prerequisite is that the visitor has entered shooting and
  // any required deposit has already settled.
  return [WORKFLOW_STAGES.SHOOTING, WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT].includes(canonicalStage(order))
    && (!depositDue(order) || hasConfirmedPayment(order, "deposit"));
}

function transactionFromNotification(value = {}) {
  const amount = value && value.amount && typeof value.amount === "object" ? value.amount : {};
  return {
    appid: text(value.appid),
    mchid: text(value.mchid),
    outTradeNo: text(value.out_trade_no),
    transactionId: text(value.transaction_id),
    tradeState: text(value.trade_state).toUpperCase(),
    successTime: text(value.success_time),
    payerOpenid: text(value.payer && value.payer.openid),
    amountTotal: Number(amount.total),
    amountCurrency: text(amount.currency).toUpperCase(),
    tradeType: text(value.trade_type).toUpperCase(),
    raw: value,
  };
}

function validateTransaction(config, transaction, { requireSuccessfulFields = true } = {}) {
  if (!transaction.outTradeNo || (requireSuccessfulFields && (!transaction.transactionId || !Number.isInteger(transaction.amountTotal)
    || transaction.amountCurrency !== "CNY" || transaction.tradeType !== "JSAPI" || !transaction.payerOpenid))) {
    throw new WechatPayError("Payment notification malformed", { code: "WECHAT_PAY_NOTIFICATION_INVALID", statusCode: 400 });
  }
  if (transaction.appid !== config.appId || transaction.mchid !== config.mchId) {
    throw new WechatPayError("Payment notification merchant mismatch", { code: "WECHAT_PAY_NOTIFICATION_MISMATCH", statusCode: 400 });
  }
}

function createWechatPay(options = {}) {
  const environment = options.env || process.env;
  const config = normalizeConfig(options.config || configFromEnvironment(environment));
  const transport = options.transport || defaultTransport;

  function assertConfigured() {
    if (!config.configured) {
      throw new WechatPayError("Wechat Pay is not configured", { code: "WECHAT_PAY_CONFIG_INVALID", statusCode: 503 });
    }
  }

  function sign(message) {
    return crypto.sign("RSA-SHA256", Buffer.from(message, "utf8"), config.merchantPrivateKey).toString("base64");
  }

  function buildAuthorization(method, path, body) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = randomNonce();
    const message = `${method}\n${path}\n${timestamp}\n${nonceStr}\n${body || ""}\n`;
    const signature = sign(message);
    return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${config.merchantSerialNo}",signature="${signature}"`;
  }

  function verifySignature(headers, rawBody, { checkTimestamp = false } = {}) {
    const timestamp = headerValue(headers, "wechatpay-timestamp");
    const nonce = headerValue(headers, "wechatpay-nonce");
    const serial = headerValue(headers, "wechatpay-serial");
    const signature = headerValue(headers, "wechatpay-signature");
    if (!timestamp || !nonce || !serial || !signature) {
      throw new WechatPayError("Wechat Pay signature headers missing", { code: "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID", statusCode: 502 });
    }
    const platformPublicKey = config.platformVerifiers.get(text(serial).toUpperCase());
    if (!platformPublicKey) {
      throw new WechatPayError("Wechat Pay platform key serial mismatch", { code: "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID", statusCode: 502 });
    }
    if (checkTimestamp) {
      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds) || Math.abs(Date.now() - seconds * 1000) > 5 * 60 * 1000) {
        throw new WechatPayError("Wechat Pay notification expired", { code: "WECHAT_PAY_NOTIFICATION_EXPIRED", statusCode: 401 });
      }
    }
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
    const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`, "utf8"), raw, Buffer.from("\n", "utf8")]);
    const verified = crypto.verify("RSA-SHA256", message, platformPublicKey, Buffer.from(signature, "base64"));
    if (!verified) {
      throw new WechatPayError("Wechat Pay signature invalid", { code: "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID", statusCode: 401 });
    }
  }

  async function signedRequest(method, path, payload = "", { allowEmptyResponse = false } = {}) {
    assertConfigured();
    const body = payload || "";
    let response;
    try {
      response = await transport({
        hostname: config.apiHost,
        method,
        path,
        body,
        timeoutMs: config.timeoutMs,
        headers: {
          Accept: "application/json",
          "User-Agent": "luxiaoming-admin/1.0.0",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: buildAuthorization(method, path, body),
          "Wechatpay-Serial": config.platformSerialNo,
        },
      });
    } catch (error) {
      throw new WechatPayError("Wechat Pay network request failed", {
        code: "WECHAT_PAY_NETWORK_ERROR", statusCode: 502, networkCode: error && error.code,
      });
    }
    const statusCode = Number(response && response.statusCode || 0);
    const rawBody = String(response && response.body || "");
    const providerRequestId = diagnosticToken(headerValue(response && response.headers, "Request-ID"), /^[A-Za-z0-9_-]{1,128}$/);
    if (statusCode < 200 || statusCode >= 300) {
      let providerCode;
      try { providerCode = JSON.parse(rawBody)?.code; } catch (_) { /* A proxy error may not be JSON. */ }
      const error = new WechatPayError("Wechat Pay API rejected request", {
        code: "WECHAT_PAY_API_ERROR", statusCode: 502, providerCode, providerRequestId,
      });
      error.httpStatus = statusCode;
      throw error;
    }
    if (!rawBody && allowEmptyResponse) return null;
    try { verifySignature(response.headers || {}, rawBody); }
    catch (error) {
      if (error instanceof WechatPayError) {
        if (providerRequestId) error.providerRequestId = providerRequestId;
        error.httpStatus = statusCode;
      }
      throw error;
    }
    try { return JSON.parse(rawBody); }
    catch (_) { throw new WechatPayError("Wechat Pay response invalid", { code: "WECHAT_PAY_RESPONSE_INVALID", statusCode: 502, providerRequestId }); }
  }

  function buildMiniProgramPaymentParams(prepayId) {
    assertConfigured();
    const value = text(prepayId);
    if (!value || value.length > 128) {
      throw new WechatPayError("Prepay id invalid", { code: "WECHAT_PAY_PREPAY_INVALID", statusCode: 502 });
    }
    const timeStamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = randomNonce();
    const packageValue = `prepay_id=${value}`;
    const paySign = sign(`${config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`);
    return { timeStamp, nonceStr, package: packageValue, signType: "RSA", paySign };
  }

  async function createJsapiTransaction({ order, phase, payment, openid }) {
    assertConfigured();
    const outTradeNo = text(payment && payment.outTradeNo);
    if (!outTradeNo || outTradeNo.length > 32 || !/^[A-Za-z0-9_-]+$/.test(outTradeNo)) {
      throw new WechatPayError("Merchant trade number invalid", { code: "WECHAT_PAY_OUT_TRADE_NO_INVALID", statusCode: 500 });
    }
    const body = JSON.stringify({
      appid: config.appId,
      mchid: config.mchId,
      description: paymentDescription(order, phase),
      out_trade_no: outTradeNo,
      notify_url: config.notifyUrl,
      amount: { total: amountInFen(payment && payment.amount), currency: "CNY" },
      payer: { openid: text(openid) },
      ...(phase === "full" && order.expiresAt ? { time_expire: new Date(order.expiresAt).toISOString() } : {}),
    });
    if (!text(openid)) throw new WechatPayError("Payer openid missing", { code: "WECHAT_PAY_OPENID_MISSING", statusCode: 400 });
    const response = await signedRequest("POST", API_PATH, body);
    const prepayId = text(response && response.prepay_id);
    if (!prepayId) throw new WechatPayError("Wechat Pay prepay id missing", { code: "WECHAT_PAY_PREPAY_INVALID", statusCode: 502 });
    return { outTradeNo, prepayId, paymentParams: buildMiniProgramPaymentParams(prepayId) };
  }

  async function queryTransaction(outTradeNo) {
    assertConfigured();
    const value = text(outTradeNo);
    if (!value || value.length > 32) throw new WechatPayError("Merchant trade number invalid", { code: "WECHAT_PAY_OUT_TRADE_NO_INVALID", statusCode: 400 });
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(value)}?mchid=${encodeURIComponent(config.mchId)}`;
    try {
      const response = await signedRequest("GET", path, "");
      return transactionFromNotification(response);
    } catch (error) {
      if (error && error.code === "WECHAT_PAY_API_ERROR" && error.httpStatus === 404 && error.providerCode === "ORDER_NOT_EXIST") {
        error.code = "WECHAT_PAY_TRANSACTION_NOT_FOUND";
      }
      throw error;
    }
  }

  async function closeTransaction(outTradeNo) {
    assertConfigured();
    const value = text(outTradeNo);
    if (!value || value.length > 32) throw new WechatPayError("Merchant trade number invalid", { code: "WECHAT_PAY_OUT_TRADE_NO_INVALID", statusCode: 400 });
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(value)}/close`;
    await signedRequest("POST", path, JSON.stringify({ mchid: config.mchId }), { allowEmptyResponse: true });
    return true;
  }

  function validateRefund(result, { notification = false } = {}) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(result.refundNo) || !result.refundId || !result.outTradeNo || !result.transactionId
      || !["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"].includes(result.status)
      || !Number.isSafeInteger(result.amount) || result.amount <= 0 || !Number.isSafeInteger(result.total)
      || result.total < result.amount || result.currency !== "CNY"
      || (result.status === "SUCCESS" && !Number.isFinite(Date.parse(result.successTime)))
      || ((notification || result.mchId) && result.mchId !== config.mchId)) {
      throw new WechatPayError("Refund response mismatch", { code: "WECHAT_PAY_REFUND_MISMATCH", statusCode: 400 });
    }
    return result;
  }

  async function createRefund({ payment, refundNo, amount, reason = "" }) {
    assertConfigured();
    if (!payment || payment.provider !== "wechat_pay" || normalizePaymentStatus(payment.status) !== "confirmed"
      || !text(payment.outTradeNo) || !text(payment.externalTransactionId)) {
      throw new WechatPayError("Verified online payment required", { code: "WECHAT_PAY_REFUND_PAYMENT_INVALID", statusCode: 409 });
    }
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(text(refundNo))) throw new WechatPayError("Refund number invalid", { code: "WECHAT_PAY_REFUND_INVALID", statusCode: 400 });
    const refund = refundAmountInFen(amount);
    const total = refundAmountInFen(payment.amount);
    if (refund > total) throw new WechatPayError("Refund exceeds payment", { code: "WECHAT_PAY_REFUND_AMOUNT_INVALID", statusCode: 400 });
    const result = validateRefund(refundFromResponse(await signedRequest("POST", "/v3/refund/domestic/refunds", JSON.stringify({
      transaction_id: text(payment.externalTransactionId), out_refund_no: text(refundNo),
      ...(text(reason) ? { reason: text(reason).slice(0, 80) } : {}), notify_url: config.refundNotifyUrl,
      amount: { refund, total, currency: "CNY" },
    }))));
    if (result.refundNo !== text(refundNo) || result.amount !== refund || result.total !== total
      || result.outTradeNo !== text(payment.outTradeNo) || result.transactionId !== text(payment.externalTransactionId)) {
      throw new WechatPayError("Refund request response mismatch", { code: "WECHAT_PAY_REFUND_MISMATCH", statusCode: 400 });
    }
    return result;
  }

  async function queryRefund(refundNo) {
    const value = text(refundNo);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(value)) throw new WechatPayError("Refund number invalid", { code: "WECHAT_PAY_REFUND_INVALID", statusCode: 400 });
    try {
      const result = validateRefund(refundFromResponse(await signedRequest("GET", `/v3/refund/domestic/refunds/${encodeURIComponent(value)}`, "")));
      if (result.refundNo !== value) throw new WechatPayError("Refund number mismatch", { code: "WECHAT_PAY_REFUND_MISMATCH", statusCode: 400 });
      return result;
    } catch (error) {
      if (error && error.code === "WECHAT_PAY_API_ERROR" && error.httpStatus === 404) error.code = "WECHAT_PAY_REFUND_NOT_FOUND";
      throw error;
    }
  }

  function parseRefundNotification(headers, rawBody) {
    assertConfigured();
    verifySignature(headers, rawBody, { checkTimestamp: true });
    try {
      const envelope = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
      const event = text(envelope.event_type);
      const resource = envelope.resource;
      if (!["REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED"].includes(event)
        || envelope.resource_type !== "encrypt-resource" || !resource || resource.original_type !== "refund"
        || resource.algorithm !== "AEAD_AES_256_GCM" || !text(resource.nonce) || !text(resource.ciphertext)) throw new Error("invalid refund resource");
      const ciphertext = Buffer.from(resource.ciphertext, "base64");
      if (ciphertext.length <= 16) throw new Error("invalid cipher");
      const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(config.apiV3Key, "utf8"), Buffer.from(resource.nonce, "utf8"));
      decipher.setAAD(Buffer.from(String(resource.associated_data || ""), "utf8"));
      decipher.setAuthTag(ciphertext.subarray(-16));
      const result = validateRefund(refundFromResponse(JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8"))), { notification: true });
      if (event !== `REFUND.${result.status}`) throw new Error("refund event mismatch");
      return result;
    } catch (error) {
      if (error instanceof WechatPayError) throw error;
      throw new WechatPayError("Refund notification invalid", { code: "WECHAT_PAY_REFUND_NOTIFICATION_INVALID", statusCode: 400 });
    }
  }

  async function confirmRefundCallback(source, headers, rawBody) {
    const refund = parseRefundNotification(headers, rawBody);
    if (String(refund.refundNo || "").startsWith("PR")) {
      const physical = require("./physicalCommerce.cjs").serviceFor(source, { wechatPay: api });
      if (await physical.findRefund(refund.refundNo)) return physical.confirmRefund(refund);
      throw new WechatPayError("Physical refund not found", { code: "WECHAT_PAY_REFUND_NOT_FOUND", statusCode: 404 });
    }
    return require("./onlineRefunds.cjs").applyRefundResult(source, refund);
  }

  function parseNotification(headers, rawBody) {
    assertConfigured();
    verifySignature(headers, rawBody, { checkTimestamp: true });
    let envelope;
    try { envelope = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody); }
    catch (_) { throw new WechatPayError("Wechat Pay notification JSON invalid", { code: "WECHAT_PAY_NOTIFICATION_INVALID", statusCode: 400 }); }
    if (text(envelope && envelope.event_type) !== "TRANSACTION.SUCCESS" || text(envelope && envelope.resource_type) !== "encrypt-resource") {
      throw new WechatPayError("Wechat Pay notification type unsupported", { code: "WECHAT_PAY_NOTIFICATION_INVALID", statusCode: 400 });
    }
    const resource = envelope && envelope.resource;
    if (!resource || resource.algorithm !== "AEAD_AES_256_GCM" || text(resource.original_type) !== "transaction" || !text(resource.nonce) || !text(resource.ciphertext)) {
      throw new WechatPayError("Wechat Pay notification resource invalid", { code: "WECHAT_PAY_NOTIFICATION_INVALID", statusCode: 400 });
    }
    try {
      const ciphertext = Buffer.from(text(resource.ciphertext), "base64");
      const authTag = ciphertext.subarray(-16);
      const encrypted = ciphertext.subarray(0, -16);
      if (authTag.length !== 16) throw new Error("tag");
      const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(config.apiV3Key, "utf8"), Buffer.from(text(resource.nonce), "utf8"));
      decipher.setAAD(Buffer.from(String(resource.associated_data || ""), "utf8"));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      const transaction = transactionFromNotification(JSON.parse(plaintext));
      validateTransaction(config, transaction);
      return transaction;
    } catch (error) {
      if (error instanceof WechatPayError) throw error;
      throw new WechatPayError("Wechat Pay notification decrypt failed", { code: "WECHAT_PAY_NOTIFICATION_DECRYPT_FAILED", statusCode: 400 });
    }
  }

  async function markTerminalPayment(source, transaction) {
    const initial = await locatePayment(source, transaction.outTradeNo);
    if (initial.booking) return markTerminalPayment(require("./bookingRequests.cjs").bookingPaymentSource(source), transaction);
    const orderId = itemId(initial.order);
    return withOrderMutex(`order:${orderId}`, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const order = await source.get("orders", orderId);
        const record = paymentRecordFor(order, transaction.outTradeNo);
        if (!order || !record) throw new WechatPayError("Payment order not found", { code: "WECHAT_PAY_PAYMENT_NOT_FOUND", statusCode: 404 });
        if (normalizePaymentStatus(record.status) !== "pending") return { order, payment: record, idempotent: true };
        const now = new Date().toISOString();
        const updatedRecord = { ...record, status: "failed", tradeState: transaction.tradeState, updatedAt: now };
        const records = (Array.isArray(order.paymentRecords) ? order.paymentRecords : []).map((row) => itemId(row) === itemId(record) ? updatedRecord : row);
        const timeline = { id: makePaymentId("timeline"), type: "支付", action: transaction.tradeState === "CLOSED" ? "微信支付已关闭" : "微信支付未完成", createTime: now };
        const patch = {
          paymentRecords: records,
          statusLogs: [...(Array.isArray(order.statusLogs) ? order.statusLogs : []), timeline],
          followRecords: [...(Array.isArray(order.followRecords) ? order.followRecords : []), timeline],
          updateTime: now,
        };
        const updated = await compareAndUpdate(source, orderId, expectedOrderFields(order), patch);
        if (updated) return { order: updated, payment: updatedRecord, idempotent: false };
      }
      throw new WechatPayError("Payment state changed concurrently", { code: "WECHAT_PAY_CONCURRENT_UPDATE", statusCode: 503 });
    });
  }

  async function confirmTransaction(source, input) {
    assertConfigured();
    const transaction = input && (input.raw || input.outTradeNo || input.tradeState) ? input : transactionFromNotification(input);
    validateTransaction(config, transaction, { requireSuccessfulFields: transaction.tradeState === SUCCESS_TRADE_STATE });
    if (String(transaction.outTradeNo || "").startsWith("PG")) {
      const physical = require("./physicalCommerce.cjs").serviceFor(source, { wechatPay: api });
      if (await physical.findPayment(transaction.outTradeNo)) return physical.confirmPayment(transaction);
      throw new WechatPayError("Physical payment not found", { code: "WECHAT_PAY_PAYMENT_NOT_FOUND", statusCode: 404 });
    }
    if (transaction.tradeState !== SUCCESS_TRADE_STATE) {
      if (TERMINAL_UNPAID_STATES.has(transaction.tradeState)) return markTerminalPayment(source, transaction);
      throw new WechatPayError("Wechat Pay transaction is not successful", { code: "WECHAT_PAY_TRANSACTION_NOT_SUCCESS", statusCode: 409 });
    }
    const initial = await locatePayment(source, transaction.outTradeNo);
    if (initial.booking) {
      const { bookingPaymentSource, finalizePaidBooking } = require("./bookingRequests.cjs");
      const result = await confirmTransaction(bookingPaymentSource(source), transaction);
      const order = await finalizePaidBooking(source, itemId(initial.order));
      if (!order) throw new WechatPayError("Paid booking could not be finalized", { code: "WECHAT_PAY_CONCURRENT_UPDATE", statusCode: 503 });
      return { ...result, order };
    }
    const orderId = itemId(initial.order);
    return withOrderMutex(`order:${orderId}`, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const order = await source.get("orders", orderId);
        const record = paymentRecordFor(order, transaction.outTradeNo);
        if (!order || !record || record.provider !== "wechat_pay") {
          throw new WechatPayError("Payment record not found", { code: "WECHAT_PAY_PAYMENT_NOT_FOUND", statusCode: 404 });
        }
        const phase = text(record.phase).toLowerCase();
        if (!validPaymentPhase(phase) || amountInFen(record.amount) !== transaction.amountTotal) {
          throw new WechatPayError("Payment amount mismatch", { code: "WECHAT_PAY_AMOUNT_MISMATCH", statusCode: 400 });
        }
        if (transaction.payerOpenid && text(order.openid || order._openid || order.customer_openid) && transaction.payerOpenid !== text(order.openid || order._openid || order.customer_openid)) {
          throw new WechatPayError("Payment payer mismatch", { code: "WECHAT_PAY_PAYER_MISMATCH", statusCode: 400 });
        }
        if (normalizePaymentStatus(record.status) === "confirmed") {
          if (text(record.externalTransactionId) && text(record.externalTransactionId) !== transaction.transactionId) {
            throw new WechatPayError("Payment transaction mismatch", { code: "WECHAT_PAY_TRANSACTION_MISMATCH", statusCode: 400 });
          }
          if (phase === "final") {
            if (order.shareEnqueuePending) enqueueMerchantShare(source, order);
            await require('./customerService.cjs').onCompleted(source,order);
          }
          if (phase === 'deposit') await require('./customerService.cjs').queuePaid(source,order);
          return { order, payment: record, idempotent: true };
        }
        if (!canConfirmPhase(order, phase)) {
          throw new WechatPayError("Payment phase invalid", { code: "WECHAT_PAY_PHASE_INVALID", statusCode: 409 });
        }
        const now = new Date().toISOString();
        const paidAt = transaction.successTime || now;
        const payment = {
          ...record,
          status: "confirmed",
          externalTransactionId: transaction.transactionId,
          tradeState: SUCCESS_TRADE_STATE,
          paidAt,
          confirmedAt: now,
          confirmationIdempotencyKey: record.confirmationIdempotencyKey || `wechat:${transaction.transactionId}`,
          updatedAt: now,
        };
        const records = (Array.isArray(order.paymentRecords) ? order.paymentRecords : []).map((row) => itemId(row) === itemId(record) ? payment : row);
        const paidField = phase === "deposit" ? "depositPaid" : "finalPaid";
        const financeField = phase === "deposit" ? "depositFinanceStatus" : "finalFinanceStatus";
        const paidAtField = phase === "deposit" ? "depositPaidAt" : "finalPaidAt";
        const confirmedAtField = phase === "deposit" ? "depositConfirmedAt" : "finalConfirmedAt";
        const confirmedByField = phase === "deposit" ? "depositConfirmedBy" : "finalConfirmedBy";
        const timeline = { id: makePaymentId("timeline"), type: "微信支付", action: phase === "deposit" ? "微信支付订金成功" : "微信支付尾款成功", createTime: now };
        const patch = {
          paymentRecords: records,
          [paidField]: roundMoney(record.amount),
          [financeField]: "已审",
          [paidAtField]: paidAt,
          [confirmedAtField]: now,
          [confirmedByField]: "wechat_pay",
          [phase + "PaymentStatus"]: "confirmed",
          status: phase === "deposit" ? "deposit_paid" : "paid",
          statusLogs: [...(Array.isArray(order.statusLogs) ? order.statusLogs : []), timeline],
          followRecords: [...(Array.isArray(order.followRecords) ? order.followRecords : []), timeline],
          updateTime: now,
        };
        if (phase === "final") {
          patch.shareEnqueuePending = true;
          patch.finalPaymentSessionStartAt = record.sessionStartAt || order.finalPaymentSessionStartAt || null;
          patch.finalPaymentSessionId = record.sessionId || order.finalPaymentSessionId || "";
          const selectionAt = order.selectionConfirmedAt || now;
          patch.selectionStatus = "confirmed";
          patch.selectionConfirmedAt = selectionAt;
          patch.selectionAcknowledgedAt = selectionAt;
          patch.selectionConfirmedBy = order.selectionConfirmedBy || "wechat_pay";
          patch.selectionMethod = order.selectionMethod || "payment_acknowledgement";
          patch.selectionRecord = order.selectionRecord || {
            method: "payment_acknowledgement",
            confirmedAt: selectionAt,
            confirmedBy: order.selectionConfirmedBy || "wechat_pay",
          };
          patch.shootingCompletedAt = order.shootingCompletedAt || now;
          patch.status = "completed";
          patch.workflowStage = WORKFLOW_STAGES.COMPLETED;
          patch.completedAt = order.completedAt || now;
          patch.completionSource = order.completionSource || "wechat_pay_final";
          patch.businessStatus = "completed";
          patch.businessStatusText = "已完成";
          patch.publicStatus = "completed";
          patch.publicStatusText = "已完成";
          patch.customerStatus = "已完成";
          patch.service_status = "done";
          patch.done_at = order.done_at || require('./svcCore.cjs').stamp(patch.completedAt);
        }
        const updated = await compareAndUpdate(source, orderId, expectedOrderFields(order), patch);
        if (!updated) continue;
        try {
          await source.create("logs", {
            action: "微信支付到账确认",
            operator: "wechat_pay",
            operatorId: "wechat_pay",
            targetType: "order",
            targetId: orderId,
            detail: `${phase} transaction=${transaction.transactionId}`,
            auditEvent: "wechat_pay",
            immutable: true,
            createTime: now,
          });
        } catch (_) {
          // The paid state is authoritative and must not be rolled back if a
          // secondary audit sink is temporarily unavailable.
        }
        if (phase === "final") {
          enqueueMerchantShare(source, updated);
          // This hook is idempotent. A temporary workbench failure leaves the
          // verified receipt intact and is retried by the next notification.
          await require('./customerService.cjs').onCompleted(source,updated);
        }
        if (phase === 'deposit') await require('./customerService.cjs').queuePaid(source,updated);
        return { order: updated, payment, idempotent: false };
      }
      throw new WechatPayError("Payment state changed concurrently", { code: "WECHAT_PAY_CONCURRENT_UPDATE", statusCode: 503 });
    });
  }

  const api = {
    isConfigured: () => config.configured,
    configurationErrors: () => [...config.errors],
    configSummary: () => ({ configured: config.configured, appId: config.appId, mchId: config.mchId, notifyUrl: config.notifyUrl || "" }),
    createOutTradeNo,
    createJsapiTransaction,
    buildMiniProgramPaymentParams,
    queryTransaction,
    closeTransaction,
    createRefund,
    queryRefund,
    parseRefundNotification,
    confirmRefundCallback,
    parseNotification,
    confirmTransaction,
    publicMessage,
  };
  return api;
}

module.exports = {
  WechatPayError,
  amountInFen,
  refundAmountInFen,
  refundFromResponse,
  enqueueMerchantShare,
  drainMerchantShare,
  configFromEnvironment,
  createOutTradeNo,
  createWechatPay,
  publicMessage,
  transactionFromNotification,
};
