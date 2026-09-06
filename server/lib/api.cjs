// HTTP API for the admin console and the public mini-program RPC bridge.
// Admin routes are protected by opaque Bearer sessions. Public RPC is kept
// separate and private order operations require a verified public session.
const url = require("url");
const crypto = require("crypto");
const { createAuthStore, parseBearer } = require("./auth.cjs");

const ALL_KEYS = [
  "cities", "agents", "distributors", "shops", "staff", "spots", "series",
  "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary",
  "guides", "stories", "scans", "orders", "afterSales", "reconciliationTransfers",
  "financeSettings", "monthlyClosings", "adjustmentRecords", "homeConfig", "logs", "trash",
  "merchantCodes", "siteConfig", "userProfiles", "config"
];
const KEY_SET = new Set(ALL_KEYS);
const PASSWORD_KEYS = new Set(["staff", "shops", "distributors", "agents"]);
const CONTENT_KEYS = new Set([
  "cities", "spots", "series", "albums", "samples", "packages", "addonServices",
  "peripherals", "tagLibrary", "guides", "stories", "homeConfig", "siteConfig"
]);
const ORDER_KEYS = new Set(["orders", "afterSales"]);
const FINANCE_KEYS = new Set(["reconciliationTransfers", "financeSettings", "monthlyClosings", "adjustmentRecords"]);

// RPC names intended for the mini-program. Unknown names are admin-only and
// are rejected unless an authenticated admin policy explicitly allows them.
const PUBLIC_RPC_NAMES = new Set([
  "login", "bindPhone", "getHomeData", "getSpots", "getBookingData", "getSeriesList",
  "getSeriesDetail", "getPhotoCollection", "getPeripherals", "getGuides", "getMyOrders",
  "getOrderDetail", "getOrderStatusCount", "createBooking", "createOrder", "updateOrderStatus",
  "submitAfterSale", "resolveMerchantCode", "getCities", "getPrivacyPolicy", "getSearchConfig",
  "getBookingConfig", "getFootprintConfig", "getCorpConfig", "getVideoSingles"
]);
const PUBLIC_PRIVATE_RPC = new Set([
  "bindPhone", "getMyOrders", "getOrderDetail", "getOrderStatusCount", "createBooking", "createOrder", "updateOrderStatus", "submitAfterSale"
]);
const ADMIN_RPC_ACTIONS = { getDashboard: "dashboard", generateMerchantQR: "shopEdit" };

const ROLE_ALIASES = { admin: "super", administrator: "super", photographer: "photo" };
const ROLE_ACTIONS = {
  super: new Set(["*"]),
  service: new Set(["view", "dashboard", "orderEdit", "assign", "transfer", "cancelOrder", "export"]),
  finance: new Set(["view", "dashboard", "financeReview", "export"]),
  photo: new Set(["view", "shootUpdate"]),
  merchant: new Set(["view", "export"]),
  distributor: new Set(["view", "export"]),
  content: new Set(["view", "contentEdit"]),
  agent: new Set(["view", "export"])
};
const ACTION_PERMISSION_ALIAS = {
  orderEdit: "orderStatus", assign: "dispatch", transfer: "dispatch", cancelOrder: "orderStatus",
  financeReview: "financeReview", shopEdit: "shop", contentEdit: "content", shootUpdate: "orderStatus"
};
const ROLE_READ_KEYS = {
  service: new Set([...ORDER_KEYS, "shops", "distributors", "cities", "packages", "peripherals", "addonServices", "logs"]),
  finance: new Set([...ORDER_KEYS, ...FINANCE_KEYS, "shops", "distributors", "logs"]),
  photo: new Set(["orders", "packages", "spots", "series", "albums", "logs"]),
  merchant: new Set(["shops", "orders", "merchantCodes", "scans", "packages", "albums", "spots", "series"]),
  distributor: new Set(["distributors", "shops", "orders", "merchantCodes", "scans", "packages", "albums", "spots", "series"]),
  content: new Set([...CONTENT_KEYS, "logs"]),
  agent: new Set(["agents", "distributors", "shops", "orders", "merchantCodes", "scans", "logs"])
};
const ROLE_WRITE_KEYS = {
  service: new Set(["orders", "afterSales", "logs"]),
  finance: new Set(["orders", "afterSales", ...FINANCE_KEYS, "logs"]),
  photo: new Set(["orders", "logs"]),
  merchant: new Set(["merchantCodes", "logs"]),
  distributor: new Set(["logs"]),
  content: new Set([...CONTENT_KEYS, "logs"]),
  agent: new Set(["logs"])
};
const ORDER_SERVICE_FIELDS = new Set([
  "customer", "contactName", "phone", "contactPhone", "contactPhones", "wechat", "contactWechat",
  "appointmentAt", "time", "timePeriod", "timeSlot", "customerRemark", "internalNote", "assigneeId",
  "photographerId", "status", "customerStatus", "statusLogs", "followRecords", "sourceName", "sourceType",
  "sourceScene", "shopId", "distributorId", "afterSaleStatus", "afterSaleReason", "afterSaleCreateTime", "afterSaleId",
  "totalAmount", "price", "priceAdjustReason", "depositPaid", "finalPaid", "finalDiscountAmount", "finalDiscountReason",
  "depositFinanceStatus", "finalFinanceStatus", "depositPaidAt", "finalPaidAt", "paymentVerify"
]);
const ORDER_FINANCE_FIELDS = new Set([
  "depositFinanceStatus", "finalFinanceStatus", "depositPaid", "finalPaid", "depositPaidAt", "finalPaidAt",
  "finalDiscountAmount", "finalDiscountReason", "paymentVerify", "refundAmount", "financeStatus", "statusLogs",
  "followRecords", "internalNote", "status", "customerStatus", "afterSaleStatus", "afterSaleId"
]);
const ORDER_PHOTO_FIELDS = new Set(["status", "customerStatus", "statusLogs", "followRecords", "completedAt"]);
const ORDER_MERCHANT_FIELDS = new Set(["customerRemark"]);

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return "lxm1$" + salt + "$" + hash;
}

function verifyPassword(stored, plain) {
  if (!stored) return false;
  if (!String(stored).startsWith("lxm1$")) return String(stored) === String(plain);
  const parts = String(stored).split("$");
  if (parts.length !== 3 || !/^[0-9a-f]+$/i.test(parts[1]) || !/^[0-9a-f]+$/i.test(parts[2])) return false;
  try {
    const actual = crypto.scryptSync(String(plain), parts[1], 64);
    const expected = Buffer.from(parts[2], "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}

function validatePasswordStrength(pwd) {
  if (typeof pwd !== "string" || pwd.length < 8) return { ok: false, reason: "新密码至少 8 位" };
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) return { ok: false, reason: "新密码需同时包含字母和数字" };
  return { ok: true };
}

function sanitizePasswordBody(key, body) {
  if (PASSWORD_KEYS.has(key) && body && typeof body.password === "string" && body.password && !body.password.startsWith("lxm1$")) body.password = hashPassword(body.password);
  return body;
}

function passwordPolicyError(key, body) {
  if (!PASSWORD_KEYS.has(key) || !body || typeof body.password !== "string" || !body.password || body.password.startsWith("lxm1$")) return "";
  const result = validatePasswordStrength(body.password);
  return result.ok ? "" : result.reason;
}

function stripPassword(key, value) {
  if (!PASSWORD_KEYS.has(key) || value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => stripPassword(key, item));
  if (typeof value !== "object") return value;
  const { password, ...rest } = value;
  return rest;
}

function normalizeRole(role) {
  const key = String(role || "").trim().toLowerCase();
  return ROLE_ALIASES[key] || key;
}

function roleActions(session) { return ROLE_ACTIONS[normalizeRole(session && session.role)] || new Set(); }
function hasAction(session, action) {
  const actions = roleActions(session);
  if (actions.has("*")) return true;
  if (!actions.has(action)) return false;
  // Every role's baseline `view` capability remains available even when the
  // staff record lists only extra mutable actions (legacy records omit view).
  if (action === "view" || action === "dashboard") return true;
  const custom = Array.isArray(session && session.permissions) ? session.permissions.filter(Boolean) : [];
  if (!custom.length || custom.includes("*")) return true;
  return custom.includes(action) || (ACTION_PERMISSION_ALIAS[action] && custom.includes(ACTION_PERMISSION_ALIAS[action]));
}
function canReadKey(session, key) {
  if (!KEY_SET.has(key)) return false;
  if (normalizeRole(session.role) === "super") return hasAction(session, "view");
  return hasAction(session, "view") && !!(ROLE_READ_KEYS[normalizeRole(session.role)] || new Set()).has(key);
}
function canWriteKey(session, key) {
  if (!KEY_SET.has(key)) return false;
  if (normalizeRole(session.role) === "super") return true;
  const role = normalizeRole(session.role);
  const action = FINANCE_KEYS.has(key) || (role === "finance" && ORDER_KEYS.has(key)) ? "financeReview"
    : role === "photo" && key === "orders" ? "shootUpdate"
      : key === "staff" || key === "shops" || key === "merchantCodes" ? "shopEdit"
        : key === "orders" || key === "afterSales" ? "orderEdit"
          : key === "logs" ? "view" : "contentEdit";
  return hasAction(session, action) && !!(ROLE_WRITE_KEYS[role] || new Set()).has(key);
}

function getRowId(row) { return String((row && (row.id || row._id)) || ""); }
function shopMatches(row, session) {
  if (!row || !session) return false;
  const ids = new Set([session.shopId, session.shopCode].filter(Boolean).map(String));
  return ids.has(String(row.id || "")) || ids.has(String(row._id || "")) || ids.has(String(row.shopId || ""));
}
function maskPhone(value) {
  const text = String(value || "");
  return text.length >= 7 ? text.slice(0, 3) + "****" + text.slice(-4) : "***";
}

async function filterRows(source, session, key, value) {
  const rows = Array.isArray(value) ? value : (value && typeof value === "object" ? Object.values(value) : []);
  const role = normalizeRole(session.role);
  if (role === "super" || role === "finance" || role === "content") return rows;
  if (role === "service") return rows;
  if (role === "photo") return key === "orders" ? rows.filter((row) => row && row.photographerId === session.subjectId) : rows;
  if (role === "merchant") {
    if (["shops", "merchantCodes", "scans"].includes(key)) return rows.filter((row) => shopMatches(row, session));
    if (key === "orders") return rows.filter((row) => shopMatches({ shopId: row && row.shopId }, session));
    return rows;
  }
  if (role === "distributor" || role === "agent") {
    let shops = [];
    try { shops = await source.list("shops"); } catch (_) {}
    const ownedShopIds = new Set(shops.filter((shop) => role === "distributor"
      ? shop && (shop.distributorId === session.subjectId || (Array.isArray(shop.distributorIds) && shop.distributorIds.includes(session.subjectId)))
      : shop && shop.agentId === session.subjectId
    ).flatMap((shop) => [shop.id, shop._id, shop.shopId].filter(Boolean).map(String)));
    if (key === "distributors" || key === "agents") return rows.filter((row) => getRowId(row) === String(session.subjectId));
    if (["shops", "merchantCodes", "scans"].includes(key)) return rows.filter((row) => ownedShopIds.has(String(row && (row.id || row._id || row.shopId))));
    if (key === "orders") return rows.filter((row) => ownedShopIds.has(String(row && row.shopId)) || (role === "distributor" && row && row.distributorId === session.subjectId));
  }
  return rows;
}

function redactRow(key, row, session) {
  let out = stripPassword(key, row);
  if (!out || typeof out !== "object") return out;
  const role = normalizeRole(session.role);
  if (key === "orders") {
    out = { ...out };
    if (["merchant", "distributor", "agent"].includes(role)) {
      if (out.phone) out.phone = maskPhone(out.phone);
      if (out.contactPhone) out.contactPhone = maskPhone(out.contactPhone);
      delete out.wechat; delete out.contactWechat; delete out.openid; delete out._openid;
      delete out.internalNote; delete out.paymentRecords;
    }
    if (role === "photo") {
      delete out.phone; delete out.contactPhone; delete out.wechat; delete out.contactWechat;
      delete out.openid; delete out._openid; delete out.internalNote; delete out.paymentRecords;
    }
  }
  return out;
}

function safeErrorStatus(error) {
  if (!error) return 500;
  if (["AUTH_STORE_UNAVAILABLE", "DATA_SOURCE_UNAVAILABLE", "DATA_SOURCE_CONFIG_INVALID", "DATA_SOURCE_INVALID"].includes(error.code)) return 503;
  if (["DUPLICATE_RECORD", "ER_DUP_ENTRY"].includes(error.code)) return 409;
  if (error.code === "REQUEST_TOO_LARGE") return 413;
  if (["INVALID_JSON", "DATA_KEY_INVALID"].includes(error.code)) return 400;
  return 500;
}
function publicError(error, status) {
  if (status === 409) return "记录已存在";
  if (status === 413) return "请求体过大";
  if (status === 400) return error && error.code === "DATA_KEY_INVALID" ? "不支持的数据集合" : "请求参数无效";
  if (status === 503) return "服务暂不可用，请稍后重试";
  return "服务器内部错误";
}
function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}
function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("请求体过大"); error.code = "REQUEST_TOO_LARGE"; fail(error);
        try { req.destroy(); } catch (_) {}
      } else chunks.push(chunk);
    });
    req.on("error", () => { const error = new Error("请求读取失败"); error.code = "INVALID_JSON"; fail(error); });
    req.on("end", () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        settled = true; resolve(raw ? JSON.parse(raw) : {});
      } catch (_) { const error = new Error("请求 JSON 无效"); error.code = "INVALID_JSON"; fail(error); }
    });
  });
}
function decodePart(value) {
  try { return decodeURIComponent(String(value || "")); }
  catch (_) { const error = new Error("路径参数无效"); error.code = "DATA_KEY_INVALID"; throw error; }
}

module.exports = function createApi(source, mode, options = {}) {
  const auth = options.auth || createAuthStore();
  const sourceStatus = options.sourceStatus || { configured: true, ready: true, persistent: mode !== "mock" };
  const allowDevOpenid = options.allowDevOpenid !== undefined
    ? !!options.allowDevOpenid
    : (process.env.ALLOW_DEV_OPENID !== undefined
      ? process.env.ALLOW_DEV_OPENID === "true"
      : process.env.NODE_ENV !== "production" && ["json", "mock"].includes(mode));
  const allowedOrigins = String(process.env.ADMIN_CORS_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  let authInit = null;
  function initAuth() {
    if (!authInit) authInit = Promise.resolve(typeof auth.init === "function" ? auth.init() : auth);
    return authInit;
  }
  function setHeaders(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin");
    const origin = req && req.headers && req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    }
  }
  async function health() {
    let data = { backend: (source && source.backend) || mode, ...sourceStatus };
    try { if (source && typeof source.health === "function") data = { ...sourceStatus, ...(await source.health()) }; }
    catch (_) { data = { backend: (source && source.backend) || mode, ...sourceStatus, ready: false, error: "unavailable" }; }
    let sessions;
    try { sessions = await auth.health(); }
    catch (_) { sessions = { backend: auth.kind || "unknown", configured: true, ready: false, error: "unavailable", required: true }; }
    const ready = data.ready !== false && sessions.ready !== false;
    const authInfo = {
      required: true,
      sessionStore: sessions.backend || "unknown",
      ready: sessions.ready !== false,
      persistent: sessions.persistent === true
    };
    return {
      ok: ready,
      mode,
      data,
      dataStore: data,
      sessions,
      auth: authInfo,
      redis: { configured: sessions.backend === "redis", ready: sessions.backend === "redis" ? sessions.ready : false }
    };
  }
  async function auditDenied(session, pathname, detail) {
    try {
      if (!source || typeof source.create !== "function") return;
      await source.create("logs", {
        id: `security-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
        time: new Date().toISOString(), user: (session && session.account) || "anonymous",
        action: "访问拦截", target: pathname, detail: String(detail || "权限不足").slice(0, 200), module: "系统安全", level: "高"
      });
    } catch (_) {}
  }
  async function requireSession(req, res, pathname, kind = "admin") {
    await initAuth();
    const token = parseBearer(req);
    if (!token) { await auditDenied(null, pathname, "缺少 Authorization Bearer 会话"); json(res, 401, { error: "未登录或会话已过期" }); return null; }
    let session;
    try { session = await auth.getSession(token); }
    catch (e) { if (e && e.code === "AUTH_STORE_UNAVAILABLE") { json(res, 503, { error: "认证服务暂不可用" }); return null; } throw e; }
    if (!session || (kind === "admin" && session.kind !== "admin") || (kind === "public" && session.kind !== "public")) {
      await auditDenied(session, pathname, "会话类型或凭据无效"); json(res, 401, { error: "未登录或会话已过期" }); return null;
    }
    return session;
  }
  function forbidden(res, session, pathname, detail = "当前角色无权访问") {
    auditDenied(session, pathname, detail); json(res, 403, { error: detail });
  }
  async function handleLogin(req, res, body) {
    await initAuth();
    const account = String(body && body.account || "").trim();
    const password = String(body && body.password || "");
    if (!account || !password) return json(res, 401, { ok: false, error: "请输入账号和密码" });
    if (account.length > 128 || password.length > 256) return json(res, 401, { ok: false, error: "账号或密码错" });
    const lockKey = `${String(req.socket && req.socket.remoteAddress || "unknown")}::${account.toLowerCase()}`;
    try {
      if (typeof auth.isLoginLocked === "function") {
        const lock = await auth.isLoginLocked(lockKey);
        if (lock && lock.lockedUntil > Date.now()) return json(res, 429, { ok: false, error: "失败次数过多，账号已临时锁定" });
      }
      const staffList = await source.list("staff");
      const shopList = await source.list("shops");
      const staff = (Array.isArray(staffList) ? staffList : []).find((item) => item && item.account === account && verifyPassword(item.password, password));
      const merchant = (Array.isArray(shopList) ? shopList : []).find((item) => item && item.account === account && verifyPassword(item.password, password));
      if (staff && merchant) return json(res, 409, { ok: false, error: "账号配置冲突，请联系管理员" });
      const candidate = staff || merchant;
      if (staff && ["停用", "disabled", "禁用"].includes(String(staff.status || "").toLowerCase())) {
        await auditDenied({ account }, "/api/auth/login", "人员账号已停用");
        return json(res, 403, { ok: false, error: "该账号已被停用，请联系管理员启用后再登录" });
      }
      if (merchant && ["暂停合作", "已终止", "停用", "disabled", "禁用"].includes(String(merchant.status || "").toLowerCase())) {
        await auditDenied({ account }, "/api/auth/login", "商家合作状态不允许登录");
        return json(res, 403, { ok: false, error: "该商家合作已暂停或终止，账号暂无法登录" });
      }
      if (!candidate) {
        const result = await auth.recordLoginFailure(lockKey);
        if (result.blocked) return json(res, 429, { ok: false, error: "账号或密码错（失败次数过多，账号已临时锁定）" });
        return json(res, 401, { ok: false, error: "账号或密码错" });
      }
      await auth.clearLoginFailures(lockKey);
      const role = merchant ? "merchant" : normalizeRole(staff.role || "");
      if (!ROLE_ACTIONS[role]) return json(res, 403, { ok: false, error: "账号角色未配置" });
      const subjectId = String(candidate.id || candidate._id || "");
      const session = await auth.createSession({
        kind: "admin", subjectType: merchant ? "merchant" : "staff", subjectId, account, role,
        permissions: Array.isArray(candidate.permissions) ? candidate.permissions : (Array.isArray(candidate.permissionKeys) ? candidate.permissionKeys : []),
        shopId: merchant ? String(merchant.id || merchant._id || merchant.shopId || "") : String(candidate.shopId || ""),
        shopCode: merchant ? String(merchant.shopId || "") : "", distributorId: String(candidate.distributorId || ""), agentId: String(candidate.agentId || "")
      });
      return json(res, 200, {
        ok: true,
        role,
        account,
        name: candidate.name || account,
        staffId: subjectId,
        shopId: session.shopId || "",
        distributorId: session.distributorId || "",
        agentId: session.agentId || "",
        permissions: Array.isArray(session.permissions) ? session.permissions : [],
        actions: [...roleActions(session)],
        token: session.token,
        expiresAt: session.expiresAt,
        expiresIn: Math.floor(session.ttlMs / 1000),
      });
    } catch (e) {
      if (safeErrorStatus(e) === 503) return json(res, 503, { ok: false, error: "认证或数据服务暂不可用" });
      throw e;
    }
  }
  async function handlePublicRpc(req, res, name, body, pathname) {
    const rpc = require("./rpc.cjs");
    let session = null;
    if (PUBLIC_PRIVATE_RPC.has(name)) {
      session = await requireSession(req, res, pathname, "public");
      if (!session) return;
    } else if (name === "createBooking" || name === "createOrder") {
      const token = parseBearer(req);
      if (token) {
        try { session = await auth.getSession(token); }
        catch (e) { if (e.code === "AUTH_STORE_UNAVAILABLE") return json(res, 503, { success: false, error: "认证服务暂不可用" }); }
        if (session && session.kind !== "public") session = null;
      }
    }
    const data = body && body.data && typeof body.data === "object" ? body.data : (body || {});
    const safeBody = { ...(body || {}), data: { ...(data || {}) } };
    delete safeBody.openid; delete safeBody.data.openid;
    if (session) { safeBody.openid = session.openid; safeBody.data.openid = session.openid; }
    const result = await rpc(source, name, safeBody, { req, res, identity: session ? { kind: "public", openid: session.openid } : null, allowDevOpenid });
    if (name === "login" && result && result.success && result.openid) {
      const created = await auth.createSession({ kind: "public", subjectType: "wx", openid: String(result.openid) });
      result.token = created.token; result.userToken = created.token; result.expiresAt = created.expiresAt; result.expiresIn = Math.floor(created.ttlMs / 1000);
    }
    return json(res, 200, result);
  }
  async function enforceOrderPatch(session, key, id, body) {
    if (!ORDER_KEYS.has(key)) return true;
    const current = await source.get(key, id);
    if (!current) return true;
    const role = normalizeRole(session.role);
    if (role === "super") return true;
    if (role === "finance") {
      const allowedFinance = key === "orders" ? ORDER_FINANCE_FIELDS : new Set(["status", "customerVisibleStatus", "financeStatus", "refundAmount", "approvedBy", "approvedAt", "logs", "updatedAt"]);
      return Object.keys(body || {}).every((field) => allowedFinance.has(field));
    }
    if (!(await filterRows(source, session, key, [current])).length) return false;
    const allowed = role === "service" ? (key === "orders" ? ORDER_SERVICE_FIELDS : new Set(["status", "customerVisibleStatus", "assigneeId", "logs", "updatedAt", "financeStatus", "refundAmount"])) : role === "photo" ? ORDER_PHOTO_FIELDS : role === "merchant" ? ORDER_MERCHANT_FIELDS : new Set();
    return Object.keys(body || {}).every((field) => allowed.has(field));
  }
  async function collectionRoute(req, res, parts, session, pathname) {
    const key = decodePart(parts[1]); const id = parts[2] ? decodePart(parts[2]) : "";
    if (!KEY_SET.has(key)) { const e = new Error("不支持的数据集合"); e.code = "DATA_KEY_INVALID"; throw e; }
    const method = req.method;
    if (method === "GET") {
      if (!canReadKey(session, key)) return forbidden(res, session, pathname);
      if (id) {
        const value = await source.get(key, id); const rows = await filterRows(source, session, key, value ? [value] : []);
        if (!rows.length) return json(res, 404, { error: "未找到记录" });
        return json(res, 200, redactRow(key, rows[0], session));
      }
      const value = await source.list(key); const rows = await filterRows(source, session, key, value);
      return json(res, 200, rows.map((row) => redactRow(key, row, session)));
    }
    if (!["POST", "PUT", "DELETE"].includes(method)) return json(res, 405, { error: "方法不支持" });
    if (!canWriteKey(session, key)) return forbidden(res, session, pathname);
    if (method === "DELETE") {
      if (!id) return json(res, 400, { error: "缺少记录 id" });
      const current = await source.get(key, id);
      if (!current || !(await filterRows(source, session, key, [current])).length) return json(res, 404, { error: "未找到记录" });
      const ok = await source.remove(key, id); return json(res, ok ? 200 : 404, { ok });
    }
    const body = await readBody(req);
    if (!body || Array.isArray(body) || typeof body !== "object") return json(res, 400, { error: "请求体无效" });
    if (PASSWORD_KEYS.has(key)) {
      if (normalizeRole(session.role) !== "super") return forbidden(res, session, pathname, "只有系统超管可以管理账号");
      const policyErr = passwordPolicyError(key, body); if (policyErr) return json(res, 400, { error: policyErr });
      sanitizePasswordBody(key, body);
    }
    if (key === "logs") { body.user = session.account; body.operator = session.account; body.time = body.time || new Date().toISOString(); delete body.password; delete body.token; }
    if (method === "PUT") {
      if (!id) return json(res, 400, { error: "缺少记录 id" });
      if (!(await enforceOrderPatch(session, key, id, body))) return forbidden(res, session, pathname, "当前角色不能修改该记录或字段");
      const current = await source.get(key, id);
      if (!current || !(await filterRows(source, session, key, [current])).length) return json(res, 404, { error: "未找到记录" });
      const updated = await source.update(key, id, body); return json(res, updated ? 200 : 404, updated ? redactRow(key, updated, session) : { error: "未找到记录" });
    }
    if (key === "orders" && !["super", "service"].includes(normalizeRole(session.role))) return forbidden(res, session, pathname, "当前角色不能创建订单");
    const created = await source.create(key, body); return json(res, 201, redactRow(key, created, session));
  }
  async function docRoute(req, res, parts, session, pathname) {
    const key = decodePart(parts[1]); const id = decodePart(parts[2]);
    if (!KEY_SET.has(key) || !id) { const e = new Error("文档参数无效"); e.code = "DATA_KEY_INVALID"; throw e; }
    if (req.method === "GET") { if (!canReadKey(session, key)) return forbidden(res, session, pathname); return json(res, 200, redactRow(key, await source.get(key, id), session)); }
    if (req.method !== "PUT") return json(res, 405, { error: "方法不支持" });
    if (!canWriteKey(session, key)) return forbidden(res, session, pathname);
    const body = await readBody(req); if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "请求体无效" });
    return json(res, 200, redactRow(key, await source.upsert(key, id, body), session));
  }

  async function orderActionRoute(req, res, parts, session, pathname) {
    if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
    const orderId = decodePart(parts[1]);
    if (!orderId) return json(res, 400, { error: "缺少订单 id" });
    const current = await source.get("orders", orderId);
    if (!current || current.isDeleted || current.deleted) return json(res, 404, { error: "订单不存在" });
    if (!(await filterRows(source, session, "orders", [current])).length) return forbidden(res, session, pathname, "当前角色不能操作该订单");
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "请求体无效" });
    const action = String(body.action || "").trim().toLowerCase();
    const role = normalizeRole(session.role);
    const actionRoles = {
      accept: ["super", "service"],
      assign: ["super", "service"],
      unassign: ["super", "photo"],
      reschedule: ["super", "service"],
      start: ["super", "service", "photo"],
      deliver: ["super", "service", "photo"],
      complete: ["super", "service"],
      cancel: ["super", "service"],
      note: ["super", "service"],
      update: ["super", "service", "finance", "photo"],
    };
    if (!actionRoles[action] || !actionRoles[action].includes(role)) return forbidden(res, session, pathname, "当前角色不能执行该订单操作");
    const actionPermission = role === "super" ? "*" : ["photo"].includes(role) ? "shootUpdate" : ["finance"].includes(role) ? "financeReview" : "orderEdit";
    if (actionPermission !== "*" && !hasAction(session, actionPermission)) return forbidden(res, session, pathname, "当前账号未授予该订单操作权限");

    const now = new Date().toISOString();
    const beforeStatus = String(current.status || "new");
    const patch = {};
    let label = "";
    const reason = String(body.reason || body.note || "").trim();
    const requireReason = ["accept", "assign", "unassign", "reschedule", "start", "deliver", "complete", "cancel", "note", "update"].includes(action);
    if (requireReason && reason.length < 2) return json(res, 400, { error: "请填写操作原因" });
    const canTransition = (allowedFrom, next) => {
      if (beforeStatus === next) return true;
      if (!allowedFrom.includes(beforeStatus)) return false;
      patch.status = next;
      patch.customerStatus = next === "confirmed" ? "confirmed" : next === "shooting" ? "shooting" : next === "delivered" || next === "completed" ? "done" : next === "cancelled" ? "已取消" : current.customerStatus;
      return true;
    };
    if (action === "accept") {
      if (!canTransition(["new", "pending"], "confirmed")) return json(res, 409, { error: "订单当前状态不能接单" });
      if (role === "service" && !current.assigneeId) patch.assigneeId = session.subjectId;
      label = "客服接单";
    } else if (action === "assign") {
      const photographerId = String(body.photographerId || "").trim();
      if (!photographerId) return json(res, 400, { error: "请选择摄影师" });
      if (!canTransition(["new", "pending", "confirmed"], "confirmed")) return json(res, 409, { error: "订单当前状态不能派单" });
      patch.photographerId = photographerId;
      label = "安排摄影师";
    } else if (action === "unassign") {
      if (role === "photo" && String(current.photographerId || "") !== String(session.subjectId)) return forbidden(res, session, pathname, "只能取消自己的拍摄任务");
      if (!["confirmed", "shooting"].includes(beforeStatus)) return json(res, 409, { error: "订单当前状态不能取消接单" });
      patch.photographerId = "";
      patch.status = "confirmed";
      patch.customerStatus = "confirmed";
      label = "摄影师取消接单";
    } else if (action === "reschedule") {
      if (!canTransition(["new", "pending", "confirmed"], beforeStatus)) return json(res, 409, { error: "订单当前状态不能改期" });
      const appointmentAt = String(body.appointmentAt || "").trim();
      if (!appointmentAt) return json(res, 400, { error: "请选择新的拍摄时间" });
      patch.appointmentAt = appointmentAt;
      if (body.timePeriod) patch.timePeriod = String(body.timePeriod).trim();
      label = "改期拍摄";
    } else if (action === "start") {
      if (role === "photo" && String(current.photographerId || "") !== String(session.subjectId)) return forbidden(res, session, pathname, "只能开始自己的拍摄任务");
      if (!canTransition(["confirmed", "assigned"], "shooting")) return json(res, 409, { error: "订单当前状态不能开始拍摄" });
      label = "开始拍摄";
    } else if (action === "deliver") {
      if (role === "photo" && String(current.photographerId || "") !== String(session.subjectId)) return forbidden(res, session, pathname, "只能交付自己的拍摄任务");
      if (!canTransition(["shooting", "retouching"], "delivered")) return json(res, 409, { error: "订单当前状态不能标记交付" });
      patch.deliveryNote = reason;
      label = "标记成片交付";
    } else if (action === "complete") {
      if (!canTransition(["delivered", "shooting", "final_pending"], "completed")) return json(res, 409, { error: "订单当前状态不能完成" });
      patch.completedAt = now;
      label = "完成订单";
    } else if (action === "cancel") {
      if (["completed", "cancelled", "canceled"].includes(beforeStatus)) return json(res, 409, { error: "订单当前状态不能取消" });
      patch.status = "cancelled";
      patch.customerStatus = "已取消";
      patch.isDeleted = true;
      patch.deleted = true;
      label = "取消订单";
    } else if (action === "note") {
      patch.internalNote = [current.internalNote, reason].filter(Boolean).join("\n");
      label = "补充订单备注";
    } else if (action === "update") {
      const allowed = role === "finance" ? ORDER_FINANCE_FIELDS : role === "photo" ? ORDER_PHOTO_FIELDS : ORDER_SERVICE_FIELDS;
      for (const [key, value] of Object.entries(body.fields && typeof body.fields === "object" ? body.fields : {})) if (allowed.has(key)) patch[key] = value;
      if (!Object.keys(patch).length) return json(res, 400, { error: "没有可更新的订单字段" });
      label = "更新订单信息";
    }
    const timeline = { type: "后台订单操作", action: `${label}${reason ? `：${reason}` : ""}`, operator: session.account, operatorId: session.subjectId, from: beforeStatus, to: patch.status || beforeStatus, createTime: now };
    patch.statusLogs = [...(Array.isArray(current.statusLogs) ? current.statusLogs : []), timeline];
    patch.followRecords = [...(Array.isArray(current.followRecords) ? current.followRecords : []), timeline];
    patch.updateTime = now;
    const updated = await source.update("orders", orderId, patch);
    if (!updated) return json(res, 404, { error: "订单不存在" });
    await source.create("logs", { action: label, operator: session.account, operatorId: session.subjectId, targetType: "order", targetId: orderId, detail: reason || `${beforeStatus} -> ${updated.status}`, createTime: now });
    if (action === "cancel") {
      try {
        await source.create("trash", { id: `trash_${orderId}_${Date.now()}`, refId: orderId, type: "订单", name: updated.orderNo || orderId, reason, operator: session.account, time: now, restorable: true });
      } catch (_) { /* the order flag remains authoritative if trash projection fails */ }
    }
    return json(res, 200, { ok: true, data: redactRow("orders", updated, session) });
  }
  async function merchantRoute(req, res, parsed, session, pathname) {
    const role = normalizeRole(session.role);
    if (!hasAction(session, "view") || !["super", "merchant", "distributor", "agent"].includes(role)) return forbidden(res, session, pathname);
    const requested = String(parsed.query.shopId || ""); let shopId = requested;
    if (role === "merchant") {
      const own = [session.shopId, session.shopCode].filter(Boolean).map(String);
      if (requested && !own.includes(requested)) return forbidden(res, session, pathname, "不能访问其他商家数据");
      // Merchant-code documents historically store the external shopCode while
      // order rows use the internal shop id. Resolve both forms before querying.
      try {
        const shops = await source.list("shops");
        const row = (Array.isArray(shops) ? shops : []).find((item) => shopMatches(item, session));
        shopId = (row && (row.shopId || row.id || row._id)) || session.shopCode || session.shopId || "";
      } catch (_) { shopId = session.shopCode || session.shopId || ""; }
    }
    if (role !== "super" && !shopId) return forbidden(res, session, pathname, "请指定授权商家");
    if (pathname.includes("/generate")) {
      if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
      if (!(role === "super" || role === "merchant") || !hasAction(session, "shopEdit")) return forbidden(res, session, pathname, "当前角色无权生成商家码");
      const body = await readBody(req); const target = String(body.shopId || shopId || "");
      if (role === "merchant" && ![String(session.shopId), String(session.shopCode)].includes(target)) return forbidden(res, session, pathname, "不能为其他商家生成二维码");
      return json(res, 200, await source.generateMerchantCode({ ...body, shopId: target }));
    }
    if (pathname.endsWith("/stats")) return json(res, 200, await source.merchantCodeStats(shopId));
    return json(res, 200, await source.listMerchantCodes(shopId));
  }
  return async function handle(req, res, pathname) {
    const rid = crypto.randomBytes(8).toString("hex"); res.setHeader("X-Request-Id", rid); setHeaders(req, res);
    const parsed = url.parse(req.url || pathname || "/", true); const parts = parsed.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    try {
      if (req.method === "OPTIONS") {
        const origin = req.headers && req.headers.origin;
        if (origin && !allowedOrigins.includes(origin)) return json(res, 403, { error: "跨域来源不被允许" });
        res.statusCode = 204; return res.end();
      }
      if (parts[0] === "health") { const payload = await health(); return json(res, payload.ok ? 200 : 503, payload); }
      if (parts[0] === "auth" && parts[1] === "login") { if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" }); return await handleLogin(req, res, await readBody(req)); }
      if (parts[0] === "auth" && parts[1] === "logout") {
        if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" }); await initAuth(); const token = parseBearer(req);
        try { if (token) await auth.revokeSession(token); } catch (e) { if (e.code === "AUTH_STORE_UNAVAILABLE") return json(res, 503, { error: "认证服务暂不可用" }); throw e; }
        return json(res, 200, { ok: true });
      }
      if (parts[0] === "auth" && parts[1] === "me") {
        const session = await requireSession(req, res, "/api/auth/me", "admin");
        if (!session) return;
        return json(res, 200, {
          ok: true,
          account: session.account,
          role: session.role,
          staffId: session.subjectId,
          shopId: session.shopId || "",
          distributorId: session.distributorId || "",
          agentId: session.agentId || "",
          permissions: Array.isArray(session.permissions) ? session.permissions : [],
          expiresAt: session.expiresAt,
        });
      }
      if (parts[0] === "auth" && parts[1] === "change-password") {
        const session = await requireSession(req, res, "/api/auth/change-password", "admin"); if (!session) return;
        if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
        const body = await readBody(req); const oldPassword = String(body.oldPassword || ""); const newPassword = String(body.newPassword || "");
        if (!oldPassword || !newPassword) return json(res, 400, { ok: false, error: "请完整填写原密码和新密码" });
        const strength = validatePasswordStrength(newPassword); if (!strength.ok || newPassword === oldPassword) return json(res, 400, { ok: false, error: strength.ok ? "新密码不能与原密码相同" : strength.reason });
        const key = session.subjectType === "merchant" ? "shops" : "staff"; const current = await source.get(key, session.subjectId);
        if (!current || !verifyPassword(current.password, oldPassword)) return json(res, 401, { ok: false, error: "原密码不正确" });
        await source.update(key, session.subjectId, { password: hashPassword(newPassword) });
        try { await auth.revokeSession(parseBearer(req)); } catch (_) {}
        return json(res, 200, { ok: true, reauthenticate: true });
      }
      if (parts[0] === "rpc") {
        const name = decodePart(parts[1]); if (!name) return json(res, 400, { error: "缺少函数名" });
        if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
        const body = await readBody(req);
        if (name === "login" || PUBLIC_RPC_NAMES.has(name)) return await handlePublicRpc(req, res, name, body, `/api/rpc/${name}`);
        const session = await requireSession(req, res, `/api/rpc/${name}`, "admin"); if (!session) return;
        const action = ADMIN_RPC_ACTIONS[name]; if (!action || !hasAction(session, action)) return forbidden(res, session, `/api/rpc/${name}`);
        const result = await require("./rpc.cjs")(source, name, body || {}, { req, res, identity: { kind: "admin", ...session }, allowDevOpenid });
        return json(res, 200, result);
      }
      if (parts[0] === "meta" && parts[1] === "keys") {
        const session = await requireSession(req, res, "/api/meta/keys", "admin"); if (!session) return;
        return json(res, 200, { keys: ALL_KEYS.filter((key) => canReadKey(session, key) || canWriteKey(session, key)) });
      }
      if (parts[0] === "orders" && parts[1] && parts[2] === "action") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin");
        if (!session) return;
        return orderActionRoute(req, res, parts, session, `/api/${parts.join("/")}`);
      }
      if (parts[0] === "dashboard" || (parts[0] === "orders" && parts[1] === "stats") || parts[0] === "home") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin"); if (!session) return;
        if (parts[0] === "dashboard" || parts[0] === "orders") {
          if (!hasAction(session, "dashboard")) return forbidden(res, session, `/api/${parts.join("/")}`);
          if (parts[0] === "dashboard") return json(res, 200, await source.dashboard());
          return json(res, 200, await source.orderStats());
        }
        if (!hasAction(session, "view")) return forbidden(res, session, `/api/${parts.join("/")}`);
        return json(res, 200, await source.homeData());
      }
      if (parts[0] === "merchant-code" || parts[0] === "merchant-codes") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin"); if (!session) return;
        return await merchantRoute(req, res, parsed, session, `/api/${parts.join("/")}`);
      }
      if (parts[0] === "collection") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin"); if (!session) return;
        return await collectionRoute(req, res, parts, session, `/api/${parts.join("/")}`);
      }
      if (parts[0] === "doc") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin"); if (!session) return;
        return await docRoute(req, res, parts, session, `/api/${parts.join("/")}`);
      }
      return json(res, 404, { error: "未知接口" });
    } catch (e) {
      const status = safeErrorStatus(e);
      if (status >= 500) console.error(`[api:${rid}]`, e && e.code ? e.code : "request_failed");
      if (!res.writableEnded) json(res, status, { error: publicError(e, status), requestId: rid });
    }
  };
};

module.exports.ALL_KEYS = ALL_KEYS;
module.exports.PASSWORD_KEYS = PASSWORD_KEYS;
