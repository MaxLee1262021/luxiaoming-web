"use strict";

const crypto = require("node:crypto");
const { PhysicalProviderError, requestJson } = require("./physicalHttp.cjs");
const text = value => String(value == null ? "" : value).trim();
const md5 = value => crypto.createHash("md5").update(value, "utf8").digest("hex").toUpperCase();
const STATES = Object.freeze({ "0": "in_transit", "1": "collected", "2": "exception", "3": "signed", "4": "returned", "5": "out_for_delivery", "6": "returned", "7": "in_transit", "8": "in_transit", "10": "exception", "14": "refused" });

function validateShipment(shipment = {}) {
  const company = text(shipment.carrierCode || shipment.companyCode).toLowerCase();
  const number = text(shipment.trackingNo);
  if (!/^[a-z0-9_]{2,48}$/.test(company)) throw new PhysicalProviderError("请选择有效快递公司", { code: "PHYSICAL_CARRIER_INVALID", statusCode: 400 });
  // Carrier numbers may contain letters; never force numeric-only identifiers.
  if (!/^[A-Za-z0-9-]{6,32}$/.test(number)) throw new PhysicalProviderError("请填写有效物流单号", { code: "PHYSICAL_TRACKING_INVALID", statusCode: 400 });
  return { company, number };
}

function trackingIdentity(shipment) {
  return `${text(shipment.id)}:${Number(shipment.version || 1)}`;
}

function normalizeSnapshot(snapshot, shipment, { monitorStatus = "polling", now = new Date(), trusted = true } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new PhysicalProviderError("物流结果格式异常", { code: "KUAIDI100_SNAPSHOT_INVALID" });
  const expected = validateShipment(shipment);
  const company = text(snapshot.com).toLowerCase(), number = text(snapshot.nu);
  if (company !== expected.company || number !== expected.number) throw new PhysicalProviderError("物流结果与当前运单不匹配", { code: "KUAIDI100_SHIPMENT_MISMATCH", statusCode: 409 });
  const events = (Array.isArray(snapshot.data) ? snapshot.data : []).slice(0, 500).map(item => ({
    time: text(item.ftime || item.time), context: text(item.context).slice(0, 4000), status: text(item.status).slice(0, 100),
    statusCode: text(item.statusCode).slice(0, 40), location: text(item.location || item.areaName).slice(0, 200),
  })).filter(item => item.time && item.context);
  const unique = new Map(events.map(item => [`${item.time}\0${item.context}\0${item.statusCode}`, item]));
  const resultEvents = [...unique.values()].sort((left, right) => right.time.localeCompare(left.time));
  const collectionEvents = resultEvents.filter(item => /揽收|已收件|已揽件/.test(item.status));
  const collectedAt = collectionEvents.length ? collectionEvents[collectionEvents.length - 1].time
    : String(snapshot.state) === "1" && resultEvents.length ? resultEvents[0].time : null;
  return {
    provider: "kuaidi100", trusted, shipmentId: text(shipment.id), version: Number(shipment.version || 1),
    company, number, monitorStatus, logisticsStatus: STATES[String(snapshot.state)] || "unknown",
    signed: String(snapshot.state) === "3", collectedAt, events: resultEvents,
    snapshotHash: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    snapshot, queriedAt: new Date(now).toISOString(),
  };
}

function createKuaidi100(options = {}) {
  const env = options.env || process.env, request = options.request || requestJson;
  const key = text(env.KUAIDI100_KEY), customer = text(env.KUAIDI100_CUSTOMER);
  const callback = text(env.KUAIDI100_CALLBACK_URL);
  const clock = options.clock || (() => new Date());
  const timeoutMs = Math.max(1000, Math.min(Number(env.KUAIDI100_TIMEOUT_MS) || 8000, 30000));
  function configurationErrors() {
    const missing = [];
    if (!key) missing.push("KUAIDI100_KEY");
    if (!customer) missing.push("KUAIDI100_CUSTOMER");
    try { const url = new URL(callback); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(); }
    catch (_) { missing.push("KUAIDI100_CALLBACK_URL"); }
    return missing;
  }
  function assertConfig() {
    if (configurationErrors().length) throw new PhysicalProviderError("快递100尚未完成配置", { code: "KUAIDI100_NOT_CONFIGURED", statusCode: 503 });
  }
  function providerError(result = {}) {
    const providerCode = text(result.returnCode || result.status || result.code);
    const retryable = ["500", "503", "429"].includes(providerCode);
    const code = ["600", "601"].includes(providerCode) ? "KUAIDI100_ACCOUNT_UNAVAILABLE" : "KUAIDI100_REJECTED";
    return new PhysicalProviderError(code === "KUAIDI100_ACCOUNT_UNAVAILABLE" ? "快递100授权或可用额度异常，请联系管理员" : "快递100未接受本次请求，请核对快递公司和单号", { code, retryable, providerCode });
  }
  async function subscribe(shipment) {
    assertConfig(); const { company, number } = validateShipment(shipment);
    if (!shipment.id || !Number.isInteger(Number(shipment.version || 1)) || Number(shipment.version || 1) < 1 || text(shipment.subscriptionSalt).length < 16) {
      throw new PhysicalProviderError("运单订阅记录不完整", { code: "KUAIDI100_SUBSCRIPTION_INVALID", statusCode: 409 });
    }
    const callbackUrl = new URL(callback); callbackUrl.searchParams.set("subscriptionId", trackingIdentity(shipment));
    const parameters = { callbackurl: callbackUrl.toString(), salt: shipment.subscriptionSalt, resultv2: "1" };
    if (shipment.phone) parameters.phone = text(shipment.phone);
    const param = { company, number, key, parameters };
    if (shipment.from) param.from = text(shipment.from);
    if (shipment.to) param.to = text(shipment.to);
    const result = await request({ url: "https://poll.kuaidi100.com/poll", method: "POST", timeoutMs,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ schema: "json", param: JSON.stringify(param) }).toString() });
    if (result.result === true && String(result.returnCode) === "200") return { status: "subscribed", subscriptionId: trackingIdentity(shipment), duplicate: false };
    // A duplicate result proves only that a subscription exists, not that its
    // callback or secret matches this version. Do not silently mark it healthy.
    throw providerError(result);
  }
  async function query(shipment) {
    assertConfig(); const { company, number } = validateShipment(shipment);
    const param = { com: company, num: number, resultv2: "1", show: "0", order: "desc" };
    if (shipment.phone) param.phone = text(shipment.phone);
    const payload = JSON.stringify(param);
    const result = await request({ url: "https://poll.kuaidi100.com/poll/query.do", method: "POST", timeoutMs,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ customer, sign: md5(payload + key + customer), param: payload }).toString() });
    if (String(result.status) !== "200") throw providerError(result);
    return normalizeSnapshot(result, shipment, { now: clock() });
  }
  function parseNotification(body, shipment) {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? Object.fromEntries(new URLSearchParams(String(body))) : body || {};
    if (typeof data.param !== "string" || Buffer.byteLength(data.param) > 1048576 || !/^[a-fA-F0-9]{32}$/.test(text(data.sign)) || text(shipment && shipment.subscriptionSalt).length < 16) {
      throw new PhysicalProviderError("物流通知验证失败", { code: "KUAIDI100_SIGNATURE_INVALID", statusCode: 401 });
    }
    const actual = Buffer.from(text(data.sign).toUpperCase(), "ascii");
    const expected = Buffer.from(md5(data.param + shipment.subscriptionSalt), "ascii");
    if (!crypto.timingSafeEqual(actual, expected)) throw new PhysicalProviderError("物流通知验证失败", { code: "KUAIDI100_SIGNATURE_INVALID", statusCode: 401 });
    let parsed;
    try { parsed = JSON.parse(data.param); }
    catch (_) { throw new PhysicalProviderError("物流通知格式错误", { code: "KUAIDI100_NOTIFICATION_INVALID", statusCode: 400 }); }
    if (!parsed.lastResult && parsed.status === "abort") {
      const expectedShipment = validateShipment(shipment);
      return { provider: "kuaidi100", trusted: true, monitorOnly: true, shipmentId: text(shipment.id), version: Number(shipment.version || 1),
        company: expectedShipment.company, number: expectedShipment.number, monitorStatus: "abort",
        providerMessage: text(parsed.message).slice(0, 300), suggestedCarrier: text(parsed.comNew),
        snapshot: parsed, snapshotHash: crypto.createHash("sha256").update(data.param).digest("hex"), queriedAt: new Date(clock()).toISOString() };
    }
    if (!parsed.lastResult) throw new PhysicalProviderError("物流通知缺少运单结果", { code: "KUAIDI100_NOTIFICATION_INVALID", statusCode: 400 });
    return { ...normalizeSnapshot(parsed.lastResult, shipment, { monitorStatus: text(parsed.status), now: clock() }),
      suggestedCarrier: text(parsed.comNew), providerMessage: text(parsed.message).slice(0, 300),
      snapshotHash: crypto.createHash("sha256").update(data.param).digest("hex") };
  }
  return { isConfigured: () => configurationErrors().length === 0, configurationErrors, subscribe, query, parseNotification, validateShipment, trackingIdentity };
}

module.exports = { createKuaidi100, validateShipment, trackingIdentity, normalizeSnapshot };
