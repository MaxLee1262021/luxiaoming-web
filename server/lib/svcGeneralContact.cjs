"use strict";

const crypto = require("node:crypto");
const text = value => String(value == null ? "" : value).trim();
const SDK_URL = "https://wwcdn.weixin.qq.com/node/wework/wwopen/js/wecom-jssdk-2.4.0.js";
const TOKEN_ERRORS = new Set([40001, 40014, 42001]);
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9_@.\-]{0,127}$/;
const EXTERNAL_ID = /^w[om][A-Za-z0-9_-]{3,126}$/;

// Never attach provider bodies, raw URLs, credentials or customer records to an
// exception. API errors can otherwise expose them through existing loggers.
class SvcGeneralContactError extends Error {
  constructor(code, message, statusCode = 503, providerCode) {
    super(message);
    this.name = "SvcGeneralContactError";
    this.code = code;
    this.userMessage = message;
    this.statusCode = statusCode;
    if (Number.isInteger(providerCode)) this.providerCode = providerCode;
  }
}
const error = (code, message, status = 503) => new SvcGeneralContactError(code, message, status);
function rejected(code) {
  const message = {
    40013: "企业微信企业 ID 无效，请检查总工作台联系配置",
    48002: "该应用未获客户联系接口权限，请检查企微应用设置",
    60011: "该应用无权访问客户联系信息，请检查可见范围",
    60020: "服务器 IP 不在企业微信可信 IP 范围内，请检查企微配置",
    84061: "该客户不在当前应用可见范围内",
  }[code] || `企业微信联系准备未完成（错误码 ${code}），请检查配置后重试`;
  return new SvcGeneralContactError("WECOM_GENERAL_API_REJECTED", message, 503, code);
}
function sign(ticket, nonceStr, timestamp, url) {
  return crypto.createHash("sha1").update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`).digest("hex");
}

function createSvcGeneralContact(options = {}) {
  const env = options.env || process.env;
  const request = options.fetch || globalThis.fetch;
  const clock = options.clock || Date.now;
  const nonce = options.nonce || (() => crypto.randomBytes(16).toString("hex"));
  const now = () => new Date(clock()).getTime();
  const cache = new Map(), inFlight = new Map();
  const enabled = () => ["1", "true"].includes(text(env.WECOM_GENERAL_CONTACT_ENABLED).toLowerCase());

  function config() {
    if (!enabled()) throw error("WECOM_GENERAL_DISABLED", "总工作台企微直接联系尚未启用，请联系管理员配置");
    const corpId = text(env.WECOM_CORP_ID);
    const agentId = text(env.WECOM_GENERAL_CONTACT_AGENT_ID);
    const secret = text(env.WECOM_GENERAL_CONTACT_SECRET);
    const origins = text(env.WECOM_GENERAL_CONTACT_ORIGINS).split(",").map(text).filter(Boolean);
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(corpId) || !/^[1-9]\d{0,11}$/.test(agentId) || !secret || !origins.length) {
      throw error("WECOM_GENERAL_NOT_CONFIGURED", "总工作台企微联系配置不完整，请检查企业 ID、应用 ID、应用 Secret 和可信页面来源");
    }
    const allowedOrigins = new Set();
    for (const origin of origins) {
      let parsed;
      try { parsed = new URL(origin); } catch (_) { throw error("WECOM_GENERAL_NOT_CONFIGURED", "总工作台企微联系可信页面来源配置无效"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw error("WECOM_GENERAL_NOT_CONFIGURED", "总工作台企微联系可信页面来源须为 HTTPS origin");
      }
      allowedOrigins.add(parsed.origin);
    }
    return { corpId, agentId, secret, allowedOrigins, timeoutMs: Math.max(1000, Math.min(Number(env.WECOM_GENERAL_CONTACT_TIMEOUT_MS) || 10000, 30000)) };
  }
  function pageUrl(value, cfg) {
    if (typeof value !== "string" || value.length > 4096 || value !== value.trim() || /[\r\n\t\0]/.test(value)) throw error("WECOM_GENERAL_URL_INVALID", "企微联系页面地址无效，请刷新总工作台后重试", 400);
    let url;
    try { url = new URL(value); } catch (_) { throw error("WECOM_GENERAL_URL_INVALID", "企微联系页面地址无效，请刷新总工作台后重试", 400); }
    if (url.protocol !== "https:" || url.username || url.password || !cfg.allowedOrigins.has(url.origin)) {
      throw error("WECOM_GENERAL_URL_FORBIDDEN", "当前页面不在企微联系可信来源范围内，请从已配置的应用入口打开", 403);
    }
    // The SDK signs the exact URL before '#', without sorting its query string.
    return value.split("#", 1)[0];
  }
  function externalId(order) {
    let id = text(order?.wecom_external_userid || order?.wecomExternalUserId || order?.customerExternalUserId || order?.external_userid);
    if (!id) {
      let mappings = {};
      try { mappings = JSON.parse(text(env.WECOM_GENERAL_CONTACT_CUSTOMERS_JSON) || "{}"); }
      catch (_) { throw error("WECOM_GENERAL_MAPPING_INVALID", "总工作台企微客户映射配置无效，请联系管理员检查"); }
      if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) throw error("WECOM_GENERAL_MAPPING_INVALID", "总工作台企微客户映射配置须为对象");
      const openid = text(order?.customer_openid || order?.openid || order?._openid);
      if (openid && Object.hasOwn(mappings, openid)) id = text(mappings[openid]);
    }
    if (!id) throw error("WECOM_GENERAL_CUSTOMER_UNMAPPED", "该订单客户尚未关联企业微信外部联系人，请完成客户映射后重试", 409);
    if (!EXTERNAL_ID.test(id)) throw error("WECOM_GENERAL_CUSTOMER_INVALID", "该订单客户的企业微信外部联系人标识无效，请核验客户映射", 409);
    return id;
  }
  async function requestJson(path, query, cfg, signal) {
    let response, data;
    try {
      response = await request(`https://qyapi.weixin.qq.com/cgi-bin/${path}?${new URLSearchParams(query)}`, { method: "GET", signal, redirect: "error" });
    } catch (_) { throw error("WECOM_GENERAL_NETWORK_ERROR", "企业微信连接失败或超时，请稍后重试"); }
    if (!response?.ok) throw error("WECOM_GENERAL_HTTP_ERROR", "企业微信服务暂不可用，请稍后重试");
    try { data = await response.json(); }
    catch (_) { throw error(signal.aborted ? "WECOM_GENERAL_NETWORK_ERROR" : "WECOM_GENERAL_RESPONSE_INVALID", "企业微信返回结果不可用，请稍后重试"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw error("WECOM_GENERAL_RESPONSE_INVALID", "企业微信返回结果异常，请稍后重试");
    return data;
  }
  async function cached(key, load) {
    const entry = cache.get(key);
    if (entry && now() < entry.expiresAt) return entry.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      const data = await load();
      if (typeof data.value !== "string" || !data.value || data.value.length > 4096 || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0) {
        throw error("WECOM_GENERAL_CREDENTIAL_INVALID", "企业微信返回的调用凭证无效，请检查应用配置");
      }
      cache.set(key, { value: data.value, expiresAt: now() + Math.max(0, data.expiresIn - Math.min(120, data.expiresIn / 10)) * 1000 });
      return data.value;
    })();
    inFlight.set(key, promise);
    try { return await promise; } finally { inFlight.delete(key); }
  }
  async function token(cfg, signal) {
    return cached("token", async () => {
      const data = await requestJson("gettoken", { corpid: cfg.corpId, corpsecret: cfg.secret }, cfg, signal);
      if (data.errcode != null && (!Number.isInteger(data.errcode) || data.errcode !== 0)) throw rejected(Number(data.errcode));
      return { value: data.access_token, expiresIn: data.expires_in };
    });
  }
  async function api(path, query, cfg, signal, retry = true) {
    const credential = await token(cfg, signal);
    const data = await requestJson(path, { ...query, access_token: credential }, cfg, signal);
    if (!Number.isInteger(data.errcode)) throw error("WECOM_GENERAL_RESPONSE_INVALID", "企业微信返回结果异常，请稍后重试");
    if (TOKEN_ERRORS.has(data.errcode) && retry) {
      if (cache.get("token")?.value === credential) cache.delete("token");
      return api(path, query, cfg, signal, false);
    }
    if (data.errcode !== 0) throw rejected(data.errcode);
    return data;
  }
  async function assertFollowing(customerId, staffId, cfg, signal) {
    let cursor = "";
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const data = await api("externalcontact/get", { external_userid: customerId, ...(cursor ? { cursor } : {}) }, cfg, signal);
      if (data.external_contact?.external_userid !== customerId || !Array.isArray(data.follow_user)) throw error("WECOM_GENERAL_RESPONSE_INVALID", "企业微信客户关系返回结果异常，请核验后重试");
      if (data.follow_user.some(row => row?.userid === staffId)) return;
      const next = text(data.next_cursor);
      if (!next) throw error("WECOM_GENERAL_NOT_FOLLOWING", "当前登录客服尚未添加该客户为企微外部联系人，无法直接打开该客户会话", 403);
      if (seen.has(next)) throw error("WECOM_GENERAL_RESPONSE_INVALID", "企业微信客户关系分页结果异常，请稍后重试");
      seen.add(next); cursor = next;
    }
    throw error("WECOM_GENERAL_RELATION_LIMIT", "客户关系数量过多，未能完整核验当前客服，请稍后重试");
  }
  async function ticket(kind, cfg, signal) {
    return cached(kind, async () => {
      const data = await api(kind === "corp_ticket" ? "get_jsapi_ticket" : "ticket/get", kind === "corp_ticket" ? {} : { type: "agent_config" }, cfg, signal);
      return { value: data.ticket, expiresIn: data.expires_in };
    });
  }

  // Caller must first enforce the new menu and existing order visibility/action
  // permissions. Only trusted server-derived order/staff records enter here.
  async function prepare({ order, staff, pageUrl: inputUrl, userAgent } = {}) {
    const cfg = config();
    if (!/wxwork/i.test(text(userAgent))) throw error("WECOM_GENERAL_CLIENT_REQUIRED", "请在企业微信客户端中打开总工作台后联系客人，普通浏览器无法直接打开外部联系人会话", 409);
    const url = pageUrl(inputUrl, cfg);
    const staffId = text(staff?.wecom_userid);
    if (!STAFF_ID.test(staffId) || staff?.staff_status && staff.staff_status !== "active") throw error("WECOM_GENERAL_STAFF_UNMAPPED", "当前登录客服尚未配置有效的企微成员映射，请联系管理员核验", 409);
    const customerId = externalId(order);
    const signal = AbortSignal.timeout(cfg.timeoutMs);
    await assertFollowing(customerId, staffId, cfg, signal);
    const [corpTicket, agentTicket] = await Promise.all([ticket("corp_ticket", cfg, signal), ticket("agent_ticket", cfg, signal)]);
    const nonceStr = nonce(), timestamp = Math.floor(now() / 1000);
    return {
      kind: "wecom_jsapi", status: "ready_to_open", sdk_url: SDK_URL,
      corp_id: cfg.corpId, agent_id: Number(cfg.agentId),
      config_signature: { timestamp, nonceStr, signature: sign(corpTicket, nonceStr, timestamp, url) },
      agent_signature: { timestamp, nonceStr, signature: sign(agentTicket, nonceStr, timestamp, url) },
      params: { userIds: [], externalUserIds: [customerId], groupName: "", chatId: "" },
      message: "企微会话调用信息已准备，请在客户端完成打开；此结果不表示消息已送达或已联系到客人",
    };
  }
  return { prepare, get enabled() { return enabled(); } };
}

module.exports = { createSvcGeneralContact, SvcGeneralContactError, SDK_URL };
