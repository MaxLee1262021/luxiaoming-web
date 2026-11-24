"use strict";

const crypto = require("node:crypto");
const text = value => String(value == null ? "" : value).trim();
const TOKEN_ERRORS = new Set([40001, 40014, 42001]);
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_@.\-]{0,63}$/;

// Deliberately never retain a fetch error, URL, response body or provider errmsg:
// those can contain the contact secret, access token or personal information.
class WecomContactsError extends Error {
  constructor(code, message, providerCode) {
    super(message);
    this.name = "WecomContactsError";
    this.code = code;
    this.userMessage = message;
    this.statusCode = 503;
    if (Number.isInteger(providerCode)) this.providerCode = providerCode;
  }
}
function rejected(code) {
  const messages = {
    40001: "企业微信通讯录凭证无效，请检查通讯录同步 Secret",
    40013: "企业微信企业 ID 无效，请检查配置",
    40014: "企业微信访问凭证无效，请稍后重试",
    42001: "企业微信访问凭证已过期，请稍后重试",
    48002: "企业微信通讯录接口未启用，请检查通讯录同步权限",
    60003: "企业微信客服部门不存在，请检查部门 ID",
    60011: "企业微信通讯录操作权限不足，请检查通讯录同步权限",
    60020: "服务器 IP 未在企业微信可信 IP 范围内，请检查配置",
    60021: "企业微信成员不在通讯录可见范围内，请检查权限",
    60123: "企业微信客服部门无效，请检查部门 ID",
  };
  return new WecomContactsError("WECOM_API_REJECTED", messages[code] || `企业微信接口未完成操作（错误码 ${code}），请检查配置后重试`, code);
}

function createWecomContacts(options = {}) {
  const env = options.env || process.env, request = options.fetch || globalThis.fetch;
  const enabled = ["true", "1"].includes(text(env.WECOM_CONTACT_SYNC_ENABLED).toLowerCase());
  const corpId = text(env.WECOM_CORP_ID), secret = text(env.WECOM_CONTACT_SECRET);
  const departmentId = Number(text(env.WECOM_CUSTOMER_SERVICE_DEPARTMENT_ID) || "2");
  const timeoutMs = Math.floor(Math.max(1000, Math.min(Number(env.WECOM_CONTACT_TIMEOUT_MS) || 10000, 30000)));
  const clock = options.clock || Date.now;
  const now = () => new Date(clock()).getTime();
  let token = "", tokenExpiresAt = 0, tokenRequest;

  function assertConfig() {
    if (!enabled) throw new WecomContactsError("WECOM_DISABLED", "企业微信自动邀请尚未启用，请检查服务端配置");
    if (!corpId || !secret || !Number.isSafeInteger(departmentId) || departmentId <= 0 || departmentId > 0xffffffff) {
      throw new WecomContactsError("WECOM_NOT_CONFIGURED", "企业微信通讯录配置不完整，请检查企业 ID、通讯录同步 Secret 和客服部门 ID");
    }
  }
  async function requestJson(path, { credential, query, body, operationSignal } = {}) {
    const params = new URLSearchParams(query || {});
    if (credential) params.set("access_token", credential);
    const signal = operationSignal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), operationSignal]) : AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await request(`https://qyapi.weixin.qq.com/cgi-bin/${path}?${params}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal, redirect: "error",
      });
    } catch (_) {
      throw new WecomContactsError("WECOM_NETWORK_ERROR", "企业微信连接失败或超时，请稍后重试");
    }
    if (!response.ok) throw new WecomContactsError("WECOM_HTTP_ERROR", "企业微信服务暂不可用，请稍后重试");
    let data;
    try { data = await response.json(); }
    catch (_) {
      if (signal.aborted) throw new WecomContactsError("WECOM_NETWORK_ERROR", "企业微信连接失败或超时，请稍后重试");
      throw new WecomContactsError("WECOM_RESPONSE_INVALID", "企业微信返回内容异常，请稍后重试");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new WecomContactsError("WECOM_RESPONSE_INVALID", "企业微信返回内容异常，请稍后重试");
    }
    return data;
  }
  async function accessToken(invalidToken, operationSignal) {
    if (invalidToken && token === invalidToken) { token = ""; tokenExpiresAt = 0; }
    if (token && now() < tokenExpiresAt) return token;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const data = await requestJson("gettoken", { query: { corpid: corpId, corpsecret: secret }, operationSignal });
      if (Number.isInteger(data.errcode) && data.errcode !== 0) throw rejected(data.errcode);
      if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw new WecomContactsError("WECOM_TOKEN_INVALID", "企业微信授权结果异常，请检查通讯录同步配置");
      }
      token = data.access_token;
      // Never cache beyond a short provider lifetime, even if it is <120 sec.
      tokenExpiresAt = now() + Math.max(0, data.expires_in - Math.min(120, data.expires_in / 10)) * 1000;
      return token;
    })();
    try { return await tokenRequest; } finally { tokenRequest = undefined; }
  }
  async function api(path, args = {}, operationSignal, retried = false) {
    const credential = await accessToken(undefined, operationSignal);
    const data = await requestJson(path, { ...args, credential, operationSignal });
    if (!Number.isInteger(data.errcode)) throw new WecomContactsError("WECOM_RESPONSE_INVALID", "企业微信返回内容异常，请稍后重试");
    if (TOKEN_ERRORS.has(data.errcode) && !retried) {
      await accessToken(credential, operationSignal);
      return api(path, args, operationSignal, true);
    }
    if (data.errcode !== 0) throw rejected(data.errcode);
    return data;
  }
  async function assertDepartment(operationSignal) {
    // user/create can silently create a nonexistent department. Validate first
    // so an incorrect ID cannot create an unrelated organisation node.
    const data = await api("department/simplelist", { query: { id: String(departmentId) } }, operationSignal);
    if (!Array.isArray(data.department_id) || !data.department_id.some(row => Number(row.id) === departmentId)) {
      throw new WecomContactsError("WECOM_DEPARTMENT_MISSING", "企业微信客服部门不存在或不可见，请检查部门 ID 与权限");
    }
  }
  async function departmentsFor(userid, operationSignal) {
    const departments = new Set(), cursors = new Set();
    let cursor = "";
    // A user can have multiple rows on different pages. Read the entire list
    // before updating, otherwise existing department memberships can be lost.
    for (let page = 0; page < 100; page++) {
      const data = await api("user/list_id", { body: { ...(cursor ? { cursor } : {}), limit: 10000 } }, operationSignal);
      if (!Array.isArray(data.dept_user)) throw new WecomContactsError("WECOM_RESPONSE_INVALID", "企业微信部门成员列表异常，请稍后重试");
      for (const row of data.dept_user) if (text(row.userid).toLowerCase() === userid.toLowerCase()) {
        if (!Number.isSafeInteger(row.department) || row.department < 0 || row.department > 0xffffffff) {
          throw new WecomContactsError("WECOM_RESPONSE_INVALID", "企业微信成员部门数据异常，请稍后重试");
        }
        departments.add(row.department);
      }
      if (data.next_cursor != null && typeof data.next_cursor !== "string") {
        throw new WecomContactsError("WECOM_RESPONSE_INVALID", "企业微信分页结果异常，请稍后重试");
      }
      cursor = data.next_cursor || "";
      if (!cursor) return [...departments];
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    throw new WecomContactsError("WECOM_PAGINATION_LIMIT", "企业微信通讯录分页未完成，请稍后重试或联系管理员");
  }
  async function ensureMember(input = {}) {
    assertConfig();
    const name = text(input.name), phone = text(input.phone);
    if (!name || Array.from(name).length > 64 || !/^1[3-9]\d{9}$/.test(phone) || input.userid && !USER_ID.test(text(input.userid))) {
      throw new WecomContactsError("WECOM_CONTACT_INVALID", "客服姓名、手机号或企业微信成员 ID 无效");
    }
    // Bound a full attempt, including pagination and token refresh, so an old
    // worker cannot continue indefinitely after its local synchronization lease.
    const operationSignal = AbortSignal.timeout(60000);
    await assertDepartment(operationSignal);
    // Stable across retries and even a local transaction/response failure.
    let userid = text(input.userid) || "lxm_cs_" + crypto.createHash("sha256").update(phone).digest("hex").slice(0, 32);
    let confirmedId = "";
    try {
      try {
        await api("user/create", { body: { userid, name, mobile: phone, department: [departmentId], to_invite: false } }, operationSignal);
        confirmedId = userid;
      } catch (error) {
        if (![60102, 60104].includes(error.providerCode)) throw error;
        // Only look up known-existing phone numbers: failed getuserid lookups
        // count toward the enterprise's daily error quota.
        const existing = await api("user/getuserid", { body: { mobile: phone } }, operationSignal);
        if (!USER_ID.test(text(existing.userid))) throw new WecomContactsError("WECOM_MEMBER_NOT_RESOLVED", "企业微信已有成员无法关联，请管理员核验手机号与成员 ID");
        userid = text(existing.userid); confirmedId = userid;
        const departments = await departmentsFor(userid, operationSignal);
        if (!departments.length) throw new WecomContactsError("WECOM_MEMBER_NOT_VISIBLE", "企业微信成员部门不可见，请检查通讯录同步权限");
        if (!departments.includes(departmentId)) {
          const assigned = departments.filter(id => id !== 0); // 0 is the unassigned-department placeholder.
          if (assigned.length >= 100) throw new WecomContactsError("WECOM_DEPARTMENT_LIMIT", "该企业微信成员已达到部门数量上限，请管理员调整");
          await api("user/update", { body: { userid, department: [...assigned, departmentId] } }, operationSignal);
        }
      }
      // Successful submission does not prove receipt or activation. New IPs
      // cannot use user/get with the contact-sync secret to read activation.
      const invited = await api("batch/invite", { body: { user: [userid] } }, operationSignal);
      if (invited.invaliduser != null && (!Array.isArray(invited.invaliduser) || invited.invaliduser.length)) {
        throw new WecomContactsError("WECOM_INVITE_REJECTED", "企业微信成员已处理，但邀请未被接受，请检查成员状态与通讯录权限后重试");
      }
      return { userid, departmentId, invitationStatus: "submitted" };
    } catch (error) {
      if (error instanceof WecomContactsError && confirmedId) error.userid = confirmedId;
      throw error;
    }
  }
  return { enabled, ensureMember };
}

module.exports = { createWecomContacts, WecomContactsError };
