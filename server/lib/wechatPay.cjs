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

class WechatPayError extends Error {
  constructor(message, { code = "WECHAT_PAY_ERROR", statusCode = 502 } = {}) {
    super(message);
    this.name = "WechatPayError";
    this.code = code;
    this.statusCode = statusCode;
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

function paymentDescription(order = {}, phase = "") {
  const name = text(order.packageName || order.confirmationSnapshot && (order.confirmationSnapshot.name || order.confirmationSnapshot.packageName) || "旅拍服务")
    .replace(/[\r\n\t]+/g, " ");
  const suffix = phase === "final" ? "尾款" : "订金";
  return `鹿小鸣旅拍-${name}-${suffix}`.slice(0, 127);
}

function defaultTransport({ hostname, method, path, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname, method, path, headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ statusCode: Number(response.statusCode || 0), headers: response.headers || {}, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error("Wechat Pay request timed out")));
    request.on("error", reject);
    request.end(body || "");
  });
}

function publicMessage(error, fallback = "微信支付服务暂不可用，请稍后重试") {
  if (error && error.code === "WECHAT_PAY_CONFIG_INVALID") return "微信支付暂未配置，请联系客服";
  if (error && error.code === "WECHAT_PAY_RESPONSE_SIGNATURE_INVALID") return "微信支付服务响应校验失败，请稍后重试";
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
    paymentRecords: Array.isArray(order.paymentRecords) ? order.paymentRecords : [],
    statusLogs: Array.isArray(order.statusLogs) ? order.statusLogs : [],
    followRecords: Array.isArray(order.followRecords) ? order.followRecords : [],
    status: order.status,
    workflowStage: order.workflowStage,
    depositPaid: order.depositPaid,
    depositFinanceStatus: order.depositFinanceStatus,
    finalPaid: order.finalPaid,
    finalFinanceStatus: order.finalFinanceStatus,
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
  if (phase === "deposit") return canonicalStage(order) === WORKFLOW_STAGES.AWAITING_DEPOSIT;
  return selectionConfirmed(order) && (!depositDue(order) || hasConfirmedPayment(order, "deposit"));
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

function createTestGateway() {
  function buildMiniProgramPaymentParams(prepayId) {
    return {
      timeStamp: "1700000000",
      nonceStr: "wechat-pay-test-nonce",
      package: `prepay_id=${prepayId}`,
      signType: "RSA",
      paySign: "wechat-pay-test-signature",
    };
  }
  return {
    isConfigured: () => true,
    configurationErrors: () => [],
    configSummary: () => ({ configured: true, testStub: true }),
    createOutTradeNo,
    async createJsapiTransaction({ payment }) {
      const prepayId = `test-prepay-${text(payment && payment.id)}`.slice(0, 120);
      return { outTradeNo: text(payment && payment.outTradeNo), prepayId, paymentParams: buildMiniProgramPaymentParams(prepayId) };
    },
    buildMiniProgramPaymentParams,
    async queryTransaction(outTradeNo) { return { outTradeNo: text(outTradeNo), tradeState: "NOTPAY", transactionId: "", amountTotal: 0 }; },
    async closeTransaction() { return true; },
    async parseNotification() { throw new WechatPayError("Test gateway does not accept payment notifications", { code: "WECHAT_PAY_NOTIFICATION_INVALID", statusCode: 400 }); },
    async confirmTransaction() { throw new WechatPayError("Test gateway does not confirm transactions", { code: "WECHAT_PAY_TRANSACTION_NOT_SUCCESS", statusCode: 409 }); },
    publicMessage,
  };
}

function createWechatPay(options = {}) {
  const environment = options.env || process.env;
  if (options.testStub === true || (environment.NODE_ENV === "test"
    && String(environment.LXM_ALLOW_TEST_JSON_SOURCE || "").toLowerCase() === "true"
    && String(environment.WECHAT_PAY_MOCK_MODE || "").toLowerCase() === "true")) {
    return createTestGateway();
  }
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
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: buildAuthorization(method, path, body),
          "Wechatpay-Serial": config.platformSerialNo,
        },
      });
    } catch (error) {
      throw new WechatPayError("Wechat Pay network request failed", { code: "WECHAT_PAY_NETWORK_ERROR", statusCode: 502 });
    }
    const statusCode = Number(response && response.statusCode || 0);
    const rawBody = String(response && response.body || "");
    if (statusCode < 200 || statusCode >= 300) {
      const error = new WechatPayError("Wechat Pay API rejected request", { code: "WECHAT_PAY_API_ERROR", statusCode: 502 });
      error.httpStatus = statusCode;
      throw error;
    }
    if (!rawBody && allowEmptyResponse) return null;
    verifySignature(response.headers || {}, rawBody);
    try { return JSON.parse(rawBody); }
    catch (_) { throw new WechatPayError("Wechat Pay response invalid", { code: "WECHAT_PAY_RESPONSE_INVALID", statusCode: 502 }); }
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
      if (error && error.code === "WECHAT_PAY_API_ERROR" && error.httpStatus === 404) error.code = "WECHAT_PAY_TRANSACTION_NOT_FOUND";
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
    if (transaction.tradeState !== SUCCESS_TRADE_STATE) {
      if (TERMINAL_UNPAID_STATES.has(transaction.tradeState)) return markTerminalPayment(source, transaction);
      throw new WechatPayError("Wechat Pay transaction is not successful", { code: "WECHAT_PAY_TRANSACTION_NOT_SUCCESS", statusCode: 409 });
    }
    const initial = await locatePayment(source, transaction.outTradeNo);
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
        if (transaction.payerOpenid && text(order.openid || order._openid) && transaction.payerOpenid !== text(order.openid || order._openid)) {
          throw new WechatPayError("Payment payer mismatch", { code: "WECHAT_PAY_PAYER_MISMATCH", statusCode: 400 });
        }
        if (normalizePaymentStatus(record.status) === "confirmed") {
          if (text(record.externalTransactionId) && text(record.externalTransactionId) !== transaction.transactionId) {
            throw new WechatPayError("Payment transaction mismatch", { code: "WECHAT_PAY_TRANSACTION_MISMATCH", statusCode: 400 });
          }
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
        return { order: updated, payment, idempotent: false };
      }
      throw new WechatPayError("Payment state changed concurrently", { code: "WECHAT_PAY_CONCURRENT_UPDATE", statusCode: 503 });
    });
  }

  return {
    isConfigured: () => config.configured,
    configurationErrors: () => [...config.errors],
    configSummary: () => ({ configured: config.configured, appId: config.appId, mchId: config.mchId, notifyUrl: config.notifyUrl || "" }),
    createOutTradeNo,
    createJsapiTransaction,
    buildMiniProgramPaymentParams,
    queryTransaction,
    closeTransaction,
    parseNotification,
    confirmTransaction,
    publicMessage,
  };
}

module.exports = {
  WechatPayError,
  amountInFen,
  configFromEnvironment,
  createOutTradeNo,
  createWechatPay,
  publicMessage,
  transactionFromNotification,
};
