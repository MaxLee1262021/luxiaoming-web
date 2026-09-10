// HTTP API for the admin console and the public mini-program RPC bridge.
// Admin routes are protected by opaque Bearer sessions. Public RPC is kept
// separate and private order operations require a verified public session.
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
const DOCUMENT_KEYS = new Set(["homeConfig", "siteConfig", "config", "financeSettings"]);
const AFTER_SALE_TERMINAL_STATUSES = new Set(["completed", "closed", "done", "已完", "已完成", "已结案", "已结束"]);
function isAfterSaleTerminalStatus(value) {
  return AFTER_SALE_TERMINAL_STATUSES.has(String(value || "").trim().toLowerCase());
}
function isOrderCompletedStatus(value) {
  return ["completed", "done", "已完成", "已完", "已交付"].includes(String(value || "").trim().toLowerCase());
}
function isOrderCancelledStatus(value) {
  return ["cancelled", "canceled", "terminated", "已取消", "已中止", "中止"].includes(String(value || "").trim().toLowerCase());
}
const PASSWORD_KEYS = new Set(["staff", "shops", "distributors", "agents"]);
const CONTENT_KEYS = new Set([
  "cities", "spots", "series", "albums", "samples", "packages", "addonServices",
  "peripherals", "tagLibrary", "guides", "stories", "homeConfig", "siteConfig"
]);
const ORDER_KEYS = new Set(["orders", "afterSales"]);
const FINANCE_KEYS = new Set(["reconciliationTransfers", "financeSettings", "monthlyClosings", "adjustmentRecords"]);
const FINANCE_DEFAULTS = { settlementObservationDays: 3, largeSettlementThreshold: 5000 };
const FINANCE_DOCUMENT_FIELDS = new Set(["settlementObservationDays", "largeSettlementThreshold", "currency"]);

// RPC names intended for the mini-program. Unknown names are admin-only and
// are rejected unless an authenticated admin policy explicitly allows them.
const PUBLIC_RPC_NAMES = new Set([
  "login", "bindPhone", "getHomeData", "getSpots", "getBookingData", "getSeriesList",
  "getSeriesDetail", "getPhotoCollection", "getPeripherals", "getGuides", "listGuides", "getGuide", "getMyOrders",
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
  merchant: new Set(["view", "dashboard", "export"]),
  distributor: new Set(["view", "dashboard", "export"]),
  content: new Set(["view", "contentEdit"]),
  agent: new Set(["view", "dashboard", "export"])
};
const ACTION_PERMISSION_ALIAS = {
  orderEdit: "orderStatus", assign: "dispatch", transfer: "dispatch", cancelOrder: "orderStatus",
  financeReview: "financeReview", shopEdit: "shop", contentEdit: "content", shootUpdate: "orderStatus"
};
const DYNAMIC_PERMISSION_ALIASES = {
  view: ["view", "read", "*.view", "system.view", "menu.view"],
  dashboard: ["dashboard", "dashboard.view", "dashboardAll", "dashboardShop"],
  orderEdit: ["orderEdit", "order.edit", "order.write", "orderStatus"],
  assign: ["assign", "dispatch", "order.assign"],
  transfer: ["transfer", "dispatch", "order.transfer"],
  cancelOrder: ["cancelOrder", "orderStatus", "order.cancel"],
  financeReview: ["financeReview", "finance.review", "finance.audit"],
  shopEdit: ["shopEdit", "shop", "shop.edit"],
  contentEdit: ["contentEdit", "content", "content.edit"],
  shootUpdate: ["shootUpdate", "order.shoot", "orderStatus"],
  export: ["export", "report.export"],
  permissionManage: ["permissionManage", "permission.manage", "authz.manage", "system.permission.manage"],
};
// A permission menu can use its own identifier, but it must target a page the
// bundled admin client can render. This supports real menu CRUD without
// creating navigation entries that lead nowhere.
const ROUTE_MENU_KEYS = new Set([
  "dashboard", "orders", "afterSales", "tasks", "addonServices", "financeReview", "reconciliation",
  "staff", "distributors", "shops", "contentOverview", "spots", "cities", "series", "albums", "samples",
  "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor",
  "miniConfig", "guides", "permissions", "logs", "trash"
]);
// These sets include read-only reference collections needed to render a
// granted workflow (for example staff names in order dispatch). Navigation
// visibility is separate from these data dependencies.
const ROLE_READ_KEYS = {
  service: new Set([...ORDER_KEYS, "shops", "distributors", "cities", "packages", "albums", "spots", "series", "samples", "peripherals", "addonServices", "staff"]),
  finance: new Set([...ORDER_KEYS, ...FINANCE_KEYS, "shops", "distributors", "agents", "staff", "cities", "scans", "packages", "albums", "spots", "series", "samples", "peripherals", "addonServices"]),
  photo: new Set(["orders", "packages", "spots", "series", "albums", "samples", "peripherals", "addonServices", "shops", "cities", "staff"]),
  merchant: new Set(["shops", "orders", "merchantCodes", "scans", "packages", "albums", "spots", "series", "samples", "peripherals", "addonServices"]),
  distributor: new Set(["distributors", "shops", "orders", "merchantCodes", "scans", "packages", "albums", "spots", "series", "samples", "peripherals", "addonServices", "staff"]),
  content: new Set([...CONTENT_KEYS]),
  agent: new Set(["agents", "distributors", "shops", "orders", "merchantCodes", "scans", "packages", "albums", "spots", "series", "samples", "peripherals", "addonServices", "staff"])
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
  "extraPhones", "extraWechats", "products", "productItems", "items", "addons",
  "appointmentAt", "time", "timePeriod", "timeSlot", "customerRemark", "internalNote", "assigneeId",
  "photographerId", "status", "customerStatus", "statusLogs", "followRecords", "sourceName", "sourceType",
  "sourceScene", "shopId", "distributorId", "afterSaleStatus", "afterSaleReason", "afterSaleCreateTime", "afterSaleId",
  "totalAmount", "price", "priceAdjustReason", "depositPaid", "finalPaid", "finalDiscountAmount", "finalDiscountReason",
  "depositFinanceStatus", "finalFinanceStatus", "depositPaidAt", "finalPaidAt", "paymentVerify",
  "riskBlocked", "riskFlag", "frozen", "freezeReason", "riskReason"
]);
const ORDER_FINANCE_FIELDS = new Set([
  "depositFinanceStatus", "finalFinanceStatus", "depositPaid", "finalPaid", "depositPaidAt", "finalPaidAt",
  "finalDiscountAmount", "finalDiscountReason", "paymentVerify", "refundAmount", "financeStatus", "statusLogs",
  "followRecords", "internalNote", "status", "customerStatus", "afterSaleStatus", "afterSaleId"
]);
const ORDER_PHOTO_FIELDS = new Set(["status", "customerStatus", "statusLogs", "followRecords", "completedAt"]);
const ORDER_MERCHANT_FIELDS = new Set(["customerRemark"]);
const IMMUTABLE_ORDER_FIELDS = new Set(["id", "_id", "openid", "_openid", "createTime"]);
const ORDER_WORKFLOW_FIELDS = new Set([
  "status", "customerStatus", "depositPaid", "finalPaid", "depositFinanceStatus", "finalFinanceStatus",
  "depositPaidAt", "finalPaidAt", "paymentVerify", "financeStatus", "refundAmount", "refundConfirmed",
  "sourceType", "sourceName", "sourceScene", "sourceCodeId", "shopId", "distributorId", "riskBlocked",
  "riskFlag", "frozen", "freezeReason", "riskReason", "isDeleted", "deleted", "afterSaleStatus",
  "afterSaleReason", "afterSaleCreateTime", "afterSaleId", "settlementObservationReleased",
  "settlementObservationReleasedAt", "settlementObservationReleasedBy"
]);
const ORDER_UPDATE_FIELDS = {
  service: new Set([
    "customer", "contactName", "phone", "contactPhone", "contactPhones", "extraPhones", "extraWechats", "wechat", "contactWechat",
    "appointmentAt", "time", "timePeriod", "timeSlot", "customerRemark", "internalNote", "assigneeId",
    "photographerId", "priceAdjustReason", "totalAmount", "products", "productItems", "items", "addons", "finalDiscountAmount", "finalDiscountReason", "depositPaid", "finalPaid",
    "depositFinanceStatus", "finalFinanceStatus"
  ]),
  finance: new Set(["depositFinanceStatus", "finalFinanceStatus"]),
  photo: new Set(["completedAt", "deliveryNote"]),
};
const ORDER_SERVICE_LOCKED_FIELDS = new Set([
  "customer", "contactName", "phone", "contactPhone", "contactPhones", "extraPhones", "extraWechats", "wechat", "contactWechat",
  "appointmentAt", "time", "timePeriod", "timeSlot", "customerRemark", "assigneeId", "photographerId",
  "totalAmount", "products", "productItems", "items", "addons", "finalDiscountAmount", "finalDiscountReason", "priceAdjustReason", "depositPaid", "finalPaid",
  "depositFinanceStatus", "finalFinanceStatus", "depositPaidAt", "finalPaidAt"
]);

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
  const seen = new WeakSet();
  function scrub(node) {
    if (!node || typeof node !== "object") return node;
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) return node.map(scrub).filter((item) => item !== undefined);
    const out = {};
    for (const [field, child] of Object.entries(node)) {
      if (isSecretFieldName(field)) continue;
      const next = scrub(child);
      if (next !== undefined) out[field] = next;
    }
    return out;
  }
  return scrub(value);
}

function normalizeRole(role) {
  const key = String(role || "").trim().toLowerCase();
  return ROLE_ALIASES[key] || key;
}

function roleActions(session) { return ROLE_ACTIONS[normalizeRole(session && session.role)] || new Set(); }
function hasAction(session, action) {
  const custom = Array.isArray(session && (session.permissionKeys || session.permissions))
    ? (session.permissionKeys || session.permissions).filter(Boolean).map(String)
    : [];
  const dynamicConfigured = !!(session && (session.permissionSource === "mysql" || session.permissionSource === "json-authz" || session.permissionsConfigured === true && session.roleId));
  if (dynamicConfigured) {
    if (custom.includes("*")) return true;
    const aliases = DYNAMIC_PERMISSION_ALIASES[action] || [action];
    return aliases.some((key) => custom.includes(key));
  }
  const actions = roleActions(session);
  if (actions.has("*")) return true;
  if (!actions.has(action)) return false;
  // Every role's baseline `view` capability remains available even when the
  // staff record lists only extra mutable actions (legacy records omit view).
  if (action === "view" || action === "dashboard") return true;
  const legacyCustom = Array.isArray(session && session.permissions) ? session.permissions.filter(Boolean) : [];
  if (session && session.permissionsConfigured === true && !legacyCustom.length) return false;
  if (!legacyCustom.length || legacyCustom.includes("*")) return true;
  return legacyCustom.includes(action) || (ACTION_PERMISSION_ALIAS[action] && legacyCustom.includes(ACTION_PERMISSION_ALIAS[action]));
}
function sessionHasMenu(session, candidate) {
  const target = String(candidate || "");
  const granted = Array.isArray(session && session.menuKeys) ? session.menuKeys.map(String) : [];
  if (granted.includes(target)) return true;
  const definitions = Array.isArray(session && session.menuDefinitions) ? session.menuDefinitions : [];
  return definitions.some((menu) => {
    const key = String(menu && (menu.key || menu.menuKey) || "");
    const routeKey = String(menu && (menu.routeKey || menu.targetKey || menu.key || menu.menuKey) || "");
    return granted.includes(key) && routeKey === target;
  });
}
function canReadKey(session, key) {
  if (!KEY_SET.has(key)) return false;
  const role = normalizeRole(session.role);
  // A super administrator retains the platform-wide data view even when a
  // navigation item is hidden; menu toggles are presentation controls for
  // this role, while non-super roles remain grant-scoped below.
  if (role === "super") return hasAction(session, "view");
  if (!hasAction(session, "view")) return false;
  if (dynamicRole(session) && (!Array.isArray(session.menuKeys) || !session.menuKeys.length)) return false;
  if (Array.isArray(session.menuKeys) && session.menuKeys.length) {
    const aliases = {
      afterSales: ["afterSales", "service"], financeSettings: ["financeSettings", "reconciliation"],
      monthlyClosings: ["monthlyClosings", "reconciliation"], adjustmentRecords: ["adjustmentRecords", "reconciliation"],
      reconciliationTransfers: ["reconciliationTransfers", "reconciliation"], logs: ["logs", "permissions"],
      staff: ["staff", "permissions"], agents: ["agents", "permissions"], distributors: ["distributors", "permissions"],
      tagLibrary: ["tagLibrary", "contentTags"], homeConfig: ["homeConfig", "miniDecor"], siteConfig: ["siteConfig", "miniConfig"],
    };
    const hasGrantedMenu = (aliases[key] || [key]).some((candidate) => sessionHasMenu(session, candidate));
    // Built-in roles may need hidden reference collections for an already
    // granted page. Custom roles stay strictly menu-scoped.
    if (!hasGrantedMenu && !ROLE_READ_KEYS[role]?.has(key)) return false;
  }
  return dynamicRole(session) ? customReadAllowed(session, key) : !!(ROLE_READ_KEYS[role] || new Set()).has(key);
}
function canWriteKey(session, key) {
  if (!KEY_SET.has(key)) return false;
  if (normalizeRole(session.role) === "super") return canReadKey(session, key) && hasAction(session, "view");
  if (dynamicRole(session) && !canReadKey(session, key)) return false;
  const role = normalizeRole(session.role);
  const action = FINANCE_KEYS.has(key) || (role === "finance" && ORDER_KEYS.has(key)) ? "financeReview"
    : role === "photo" && key === "orders" ? "shootUpdate"
      : key === "staff" || key === "shops" || key === "merchantCodes" ? "shopEdit"
        : key === "orders" || key === "afterSales" ? "orderEdit"
          : key === "logs" ? "view" : "contentEdit";
  return hasAction(session, action) && (!!(ROLE_WRITE_KEYS[role] || new Set()).has(key) || dynamicRole(session));
}
function dynamicRole(session) {
  return !!(session && (session.permissionSource === "mysql" || session.permissionSource === "json-authz" || session.roleId));
}
function customDynamicRole(session) {
  const role = normalizeRole(session && session.role);
  return dynamicRole(session) && role !== "super" && !ROLE_READ_KEYS[role];
}
function customReadAllowed(session, key) {
  if (!customDynamicRole(session)) return true;
  if (["orders", "afterSales"].includes(key)) return hasAction(session, "orderAll") || hasAction(session, "orderSelf");
  if (FINANCE_KEYS.has(key)) return hasAction(session, "financeReview");
  if (CONTENT_KEYS.has(key)) return hasAction(session, "contentEdit") || hasAction(session, "content");
  if (["shops", "merchantCodes", "scans"].includes(key)) return hasAction(session, "shopEdit");
  return false;
}

function getRowId(row) { return String((row && (row.id || row._id)) || ""); }
const ARRAY_RESTORE_FIELDS = new Set(["products", "productItems", "items", "addons", "statusLogs", "followRecords", "paymentRecords", "contactPhones", "extraWechats", "logs", "permissions", "orderIds", "orderNos"]);
const BOOLEAN_RESTORE_FIELDS = new Set(["deleted", "isDeleted", "refundConfirmed", "riskBlocked", "frozen", "settlementObservationReleased"]);
async function restoreChangedFields(source, key, id, snapshot, changedFields) {
  const original = snapshot && typeof snapshot === "object" ? snapshot : {};
  const patch = {};
  for (const field of new Set(Array.isArray(changedFields) ? changedFields.map(String) : [])) {
    if (Object.prototype.hasOwnProperty.call(original, field)) patch[field] = original[field];
    else if (ARRAY_RESTORE_FIELDS.has(field)) patch[field] = [];
    else if (BOOLEAN_RESTORE_FIELDS.has(field)) patch[field] = false;
    else patch[field] = null;
  }
  if (!Object.keys(patch).length) return true;
  return !!(await source.update(key, String(id), patch));
}
function shopIdentityValues(row) {
  return [row && row.id, row && row._id, row && row.shopId, row && row.shopCode].filter(Boolean).map(String);
}
function orderShopId(row) {
  return row && (row.shopId || row.shopCode || row.source && typeof row.source === "object" && row.source.shopId) || "";
}
function orderDistributorId(row) {
  return row && (row.distributorId || row.source && typeof row.source === "object" && row.source.distributorId) || "";
}
function shopMatches(row, session) {
  if (!row || !session) return false;
  const ids = new Set([session.shopId, session.shopCode].filter(Boolean).map(String));
  return shopIdentityValues(row).some((id) => ids.has(id));
}
async function merchantOwnedShopIds(source, session) {
  const rows = await source.list("shops");
  return new Set((Array.isArray(rows) ? rows : []).filter((row) => shopMatches(row, session)).flatMap(shopIdentityValues));
}
function maskPhone(value) {
  const text = String(value || "");
  return text.length >= 7 ? text.slice(0, 3) + "****" + text.slice(-4) : "***";
}

function credentialDigest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function isDisabledStatus(value) {
  return ["停用", "已停用", "禁用", "disabled", "inactive", "terminated", "已终止", "终止合作", "暂停合作"].includes(String(value || "").trim().toLowerCase());
}

function isActiveStatusForScope(row) {
  return !!row && row.isDeleted !== true && row.deleted !== true && !isDisabledStatus(row.status);
}
const PHONE_FIELDS = ["phone", "contactPhone", "customerPhone", "customer_phone"];
const PHONE_LIST_FIELDS = ["contactPhones", "extraPhones", "phones"];
const WECHAT_FIELDS = ["wechat", "contactWechat", "customerWechat", "customer_wechat", "extraWechats", "wechats"];
const IDENTITY_FIELDS = ["openid", "_openid", "customerOpenid", "customer_openid", "userOpenid", "user_openid"];
const INTERNAL_FIELDS = ["internalNote", "paymentRecords", "source", "sourceCodeId", "sourceScene", "statusLogs", "followRecords"];
const CONFIG_SENSITIVE_KEY = /(?:password|secret|token|private.?key|webhook|mch.?key|api.?key|credential|authorization|openid|unionid|internal|private|audit|phone|mobile|telephone|wechat|customer)/i;
const CONFIG_SECRET_KEY = /(?:password|secret|token|private.?key|webhook|mch.?key|api.?key|credential|authorization|openid|unionid|internal|private|audit|phone|mobile|telephone|wechat|customer)/i;
const CONFIG_CREDENTIAL_KEY = /^(?:corp.?id|app.?id|secret|token|private.?key|webhook|mch.?key|api.?key|credential|authorization)$/i;
function normalizedFieldName(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function isSecretFieldName(value) {
  const key = normalizedFieldName(value);
  return key.startsWith("password") || key.startsWith("secret") || key === "token" || key.endsWith("token")
    || key === "authorization" || key.includes("credential") || key.includes("privatekey") || key.includes("apikey")
    || key.includes("accesskey") || key.includes("webhook");
}
function isPhoneFieldName(value) {
  const key = normalizedFieldName(value);
  return key === "phone" || key.endsWith("phone") || key === "mobile" || key.endsWith("mobile") || key === "telephone" || key.endsWith("telephone");
}
function isWechatFieldName(value) {
  const key = normalizedFieldName(value);
  return key.includes("wechat") || key === "wxid" || key.endsWith("wxid");
}
function isIdentityFieldName(value) {
  const key = normalizedFieldName(value);
  return key.includes("openid") || key.includes("unionid") || key === "userid" || key.endsWith("userid");
}

function scrubRestrictedOrderValue(value, role, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubRestrictedOrderValue(item, role, seen)).filter((item) => item !== undefined);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    if (INTERNAL_FIELDS.some((field) => field.toLowerCase() === lower)
      || isIdentityFieldName(key) || isWechatFieldName(key)) continue;
    if (isPhoneFieldName(key) || PHONE_FIELDS.some((field) => field.toLowerCase() === lower) || PHONE_LIST_FIELDS.some((field) => field.toLowerCase() === lower)) {
      if (role === "photo") continue;
      out[key] = Array.isArray(child) ? child.map(maskPhone) : maskPhone(child);
      continue;
    }
    const next = scrubRestrictedOrderValue(child, role, seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function redactConfigValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactConfigValue(item, seen)).filter((item) => item !== undefined);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (normalizedFieldName(key) === "wechat" && child && typeof child === "object" && !Array.isArray(child)) {
      const safeWechat = {};
      for (const [field, item] of Object.entries(child)) {
        if (CONFIG_CREDENTIAL_KEY.test(field) || CONFIG_SECRET_KEY.test(field)) continue;
        const nextWechat = redactConfigValue(item, seen);
        if (nextWechat !== undefined) safeWechat[field] = nextWechat;
      }
      out[key] = safeWechat;
      continue;
    }
    if (CONFIG_SENSITIVE_KEY.test(key)) continue;
    const next = redactConfigValue(child, seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}
function containsConfigSensitive(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsConfigSensitive(item, seen));
  return Object.entries(value).some(([key, child]) => {
    // `wechat` is a public config container; only its credential fields are
    // restricted for content operators. User-facing guide text remains editable.
    const container = ["wechat", "search", "customprice", "footprint"].includes(normalizedFieldName(key));
    if (!container && (CONFIG_CREDENTIAL_KEY.test(key) || CONFIG_SECRET_KEY.test(key) && !/^guide.?text$/i.test(key))) return true;
    return containsConfigSensitive(child, seen);
  });
}

async function filterRows(source, session, key, value) {
  const rows = Array.isArray(value) ? value : (value && typeof value === "object" ? Object.values(value) : []);
  const role = normalizeRole(session.role);
  // Custom roles receive no implicit headquarters scope. Their explicitly
  // granted action keys decide both the module and the row set.
  if (customDynamicRole(session)) {
    if (["orders", "afterSales"].includes(key)) {
      if (hasAction(session, "orderAll")) return rows;
      if (hasAction(session, "orderSelf")) return rows.filter((row) => row && [row.createdById, row.assigneeId, row.photographerId, row.staffId].some((id) => String(id || "") === String(session.subjectId || "")));
      return [];
    }
    if (FINANCE_KEYS.has(key)) return hasAction(session, "financeReview") ? rows : [];
    if (CONTENT_KEYS.has(key)) return (hasAction(session, "contentEdit") || hasAction(session, "content")) ? rows : [];
    if (["shops", "merchantCodes", "scans"].includes(key)) return hasAction(session, "shopEdit") ? rows : [];
    return [];
  }
  if (role === "super" || role === "finance" || role === "content") return rows;
  if (role === "service") return rows;
  if (role === "photo") return key === "orders" ? rows.filter((row) => row && String(row.photographerId || "") === String(session.subjectId || "")) : rows;
  if (role === "merchant") {
    if (key === "shops") return rows.filter((row) => shopMatches(row, session));
    if (["merchantCodes", "scans"].includes(key)) {
      const ownedShopIds = await merchantOwnedShopIds(source, session);
      return rows.filter((row) => ownedShopIds.has(String(row && (row.shopId || row.shopCode || row.shop_id) || "")) || shopMatches(row, session));
    }
    if (key === "orders") {
      const ownedShopIds = await merchantOwnedShopIds(source, session);
      return rows.filter((row) => ownedShopIds.has(String(orderShopId(row))) || shopMatches({ shopId: orderShopId(row) }, session));
    }
    if (key === "afterSales") {
      const orders = await source.list("orders");
      const ownedShopIds = await merchantOwnedShopIds(source, session);
      const ownedOrderIds = new Set((Array.isArray(orders) ? orders : []).filter((order) => ownedShopIds.has(String(orderShopId(order))) || shopMatches({ shopId: orderShopId(order) }, session)).map(getRowId));
      return rows.filter((row) => ownedOrderIds.has(String(row && row.orderId || "")));
    }
    return rows;
  }
  if (role === "distributor" || role === "agent") {
    let shops = [];
    shops = await source.list("shops");
    // A distributor/agent login document may have an account id that differs
    // from the business relation id stored on shops/orders. Keep both trusted
    // server-derived ids in the scope set so a valid account is never filtered
    // to an empty dashboard after an identity migration.
    const relationField = role === "distributor" ? "distributorId" : "agentId";
    const relationId = session[relationField] || session.subjectId || "";
    const scopeIds = new Set([relationId, session.subjectId].filter(Boolean).map(String));
    const ownedShopIds = new Set(shops.filter((shop) => role === "distributor"
      ? shop && (scopeIds.has(String(shop.distributorId || "")) || (Array.isArray(shop.distributorIds) && shop.distributorIds.map(String).some((id) => scopeIds.has(id))))
      : shop && (scopeIds.has(String(shop.agentId || "")) || (Array.isArray(shop.agentIds) && shop.agentIds.map(String).some((id) => scopeIds.has(id))))
    ).flatMap((shop) => [shop.id, shop._id, shop.shopId].filter(Boolean).map(String)));
    if (key === "distributors") {
      return role === "distributor"
        ? rows.filter((row) => scopeIds.has(getRowId(row)))
        : rows.filter((row) => row && (scopeIds.has(String(row.agentId || "")) || scopeIds.has(String(row.agentID || ""))));
    }
    if (key === "agents") return role === "agent" ? rows.filter((row) => scopeIds.has(getRowId(row))) : [];
    if (key === "shops") return rows.filter((row) => ownedShopIds.has(String(row && (row.id || row._id || row.shopId))));
    if (["merchantCodes", "scans"].includes(key)) return rows.filter((row) => row && (
      ownedShopIds.has(String(row.shopId || row.shopCode || row.shop_id || ""))
      || scopeIds.has(String(row[relationField] || ""))
      || (role === "distributor" && Array.isArray(row.distributorIds) && row.distributorIds.map(String).some((id) => scopeIds.has(id)))
    ));
    if (key === "orders") return rows.filter((row) => row && (
      ownedShopIds.has(String(orderShopId(row)))
      || scopeIds.has(String(row[relationField] || (relationField === "distributorId" ? orderDistributorId(row) : "") || ""))
      || (role === "distributor" && Array.isArray(row.distributorIds) && row.distributorIds.map(String).some((id) => scopeIds.has(id)))
    ));
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
      PHONE_FIELDS.forEach((field) => { if (out[field]) out[field] = maskPhone(out[field]); });
      PHONE_LIST_FIELDS.forEach((field) => { if (Array.isArray(out[field])) out[field] = out[field].map(maskPhone); });
      [...WECHAT_FIELDS, ...IDENTITY_FIELDS].forEach((field) => { delete out[field]; });
      delete out.internalNote; delete out.paymentRecords;
    }
    if (role === "photo") {
      [...PHONE_FIELDS, ...PHONE_LIST_FIELDS, ...WECHAT_FIELDS, ...IDENTITY_FIELDS].forEach((field) => { delete out[field]; });
      delete out.internalNote; delete out.paymentRecords;
    }
    if (["merchant", "distributor", "agent", "photo"].includes(role)) out = scrubRestrictedOrderValue(out, role) || {};
  }
  if (key === "afterSales" && !["super", "finance"].includes(role)) {
    out = { ...out };
    [...WECHAT_FIELDS, ...IDENTITY_FIELDS].forEach((field) => { delete out[field]; });
    PHONE_FIELDS.forEach((field) => { if (out[field]) out[field] = maskPhone(out[field]); });
    PHONE_LIST_FIELDS.forEach((field) => { if (Array.isArray(out[field])) out[field] = out[field].map(maskPhone); });
    out = scrubRestrictedOrderValue(out, role) || {};
  }
  if (key === "siteConfig" && role === "content") out = redactConfigValue(out) || {};
  return out;
}

function safeErrorStatus(error) {
  if (!error) return 500;
  if (["AUTH_STORE_UNAVAILABLE", "DATA_SOURCE_UNAVAILABLE", "DATA_SOURCE_CONFIG_INVALID", "DATA_SOURCE_INVALID"].includes(error.code)) return 503;
  if (error.code === "DATA_TOO_LARGE") return 400;
  if (["DUPLICATE_RECORD", "ER_DUP_ENTRY"].includes(error.code)) return 409;
  if (/^(?:ER_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EACCES|EROFS|ENOSPC)/i.test(String(error.code || ""))) return 503;
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
  const permissionStore = options.permissionStore || null;
  const sourceStatus = options.sourceStatus || { configured: true, ready: true, persistent: mode !== "mock" };
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const productionLike = ["production", "prod", "staging"].includes(nodeEnv);
  const devContext = ["development", "test"].includes(nodeEnv) && ["json", "mock"].includes(mode);
  const allowDevOpenid = productionLike || !devContext ? false : (options.allowDevOpenid !== undefined
    ? !!options.allowDevOpenid
    : (process.env.ALLOW_DEV_OPENID !== undefined ? process.env.ALLOW_DEV_OPENID === "true" : true));
  const allowedOrigins = String(process.env.ADMIN_CORS_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  let authInit = null;
  let permissionInit = null;
  function initAuth() {
    if (!authInit) authInit = Promise.resolve().then(() => typeof auth.init === "function" ? auth.init() : auth).catch((error) => { authInit = null; throw error; });
    return authInit;
  }
  function initPermissions() {
    if (!permissionStore) return Promise.resolve(null);
    if (!permissionInit) permissionInit = Promise.resolve().then(() => typeof permissionStore.init === "function" ? permissionStore.init() : permissionStore).catch((error) => { permissionInit = null; throw error; });
    return permissionInit;
  }
  async function refreshAdminSession(session, token) {
    if (!session || session.kind !== "admin") return session;
    if (permissionStore && session.authzUserId) {
      const user = await permissionStore.getUser(session.authzUserId);
      if (!user || isDisabledStatus(user.status)) return null;
      const userVersion = authzVersion(user.updatedAt);
      if (session.authzUpdatedAt && session.authzUpdatedAt !== userVersion) return null;
      const policy = await permissionStore.getPolicyForUser(user);
      if (!policy || !policy.role || isDisabledStatus(policy.role.status)) return null;
      const role = normalizeRole(policy.role.roleKey || policy.role.code);
      if (!role) return null;
      const extra = user.extra && typeof user.extra === "object" ? user.extra : {};
      const subjectType = extra.subjectType || (extra.legacyKey === "shops" ? "merchant" : extra.legacyKey === "distributors" ? "distributor" : extra.legacyKey === "agents" ? "agent" : "staff");
      const subjectId = String(extra.subjectId || extra.legacyId || session.subjectId || user.id);
      const menuDefinitions = typeof permissionStore.listMenus === "function" ? await permissionStore.listMenus() : [];
      return {
        ...session,
        role,
        roleName: policy.role && policy.role.name ? policy.role.name : (session.roleName || role),
        roleId: policy.role && policy.role.id ? policy.role.id : user.roleId,
        menuKeys: Array.isArray(policy.menuKeys) ? policy.menuKeys.map(String) : [],
        menuDefinitions: (Array.isArray(menuDefinitions) ? menuDefinitions : []).map((menu) => ({
          key: String(menu.menuKey || menu.key || menu.id || ""), label: String(menu.name || menu.label || menu.menuKey || menu.key || ""),
          group: String((menu.meta && menu.meta.group) || menu.group || ""), path: String(menu.path || ""), icon: String(menu.icon || ""),
          routeKey: String((menu.meta && (menu.meta.routeKey || menu.meta.targetKey)) || menu.routeKey || menu.targetKey || menu.menuKey || menu.key || menu.id || ""),
          sort: Number(menu.sortNo ?? menu.sort ?? 0), status: permissionStatus(menu.status)
        })).filter((menu) => menu.key),
        permissionKeys: Array.isArray(policy.permissionKeys) ? policy.permissionKeys.map(String) : [],
        permissions: Array.isArray(policy.permissionKeys) ? policy.permissionKeys.map(String) : [],
        permissionsConfigured: true,
        permissionSource: permissionStore.backend === "mysql" ? "mysql" : "json-authz",
        authzUpdatedAt: userVersion,
        subjectType,
        subjectId,
        account: user.account || session.account,
        shopId: subjectType === "merchant" ? String(extra.shopId || subjectId) : String(extra.shopId || session.shopId || ""),
        shopCode: String(extra.shopCode || session.shopCode || ""),
        distributorId: subjectType === "distributor" ? subjectId : String(extra.distributorId || session.distributorId || ""),
        agentId: subjectType === "agent" ? subjectId : String(extra.agentId || session.agentId || ""),
      };
    }
    const key = session.subjectType === "merchant" ? "shops" : session.subjectType === "distributor" ? "distributors" : session.subjectType === "agent" ? "agents" : "staff";
    const current = await source.get(key, session.subjectId);
    if (!current || current.isDeleted || current.deleted || isDisabledStatus(current.status)) return null;
    const role = session.subjectType === "merchant" ? "merchant" : normalizeRole(current.role || session.role);
    if (!ROLE_ACTIONS[role]) return null;
    // Password changes and permission edits invalidate older browser sessions
    // on their next request without requiring a session index in Redis.
    if (session.credentialDigest && session.credentialDigest !== credentialDigest(current.password)) return null;
    const permissionsConfigured = Array.isArray(current.permissionKeys) || Array.isArray(current.permissions);
    const permissions = Array.isArray(current.permissionKeys)
      ? current.permissionKeys
      : (Array.isArray(current.permissions) ? current.permissions : (Array.isArray(session.permissions) ? session.permissions : []));
    const subjectId = String(current.id || current._id || session.subjectId);
    return {
      ...session,
      role,
      permissions,
      permissionsConfigured,
      account: current.account || session.account,
      subjectId,
      shopId: session.subjectType === "merchant" ? String(current.id || current._id || current.shopId || "") : String(current.shopId || session.shopId || ""),
      shopCode: session.subjectType === "merchant" ? String(current.shopId || session.shopCode || "") : String(session.shopCode || ""),
      distributorId: session.subjectType === "distributor" ? subjectId : String(current.distributorId || session.distributorId || ""),
      agentId: session.subjectType === "agent" ? subjectId : String(current.agentId || session.agentId || ""),
    };
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
    let permission = { backend: mode === "mysql" ? "mysql" : "json", configured: !!permissionStore, ready: true, persistent: false };
    if (permissionStore && typeof permissionStore.health === "function") {
      try { permission = await permissionStore.health(); }
      catch (_) { permission = { backend: mode, configured: true, ready: false, persistent: mode === "mysql", error: "unavailable" }; }
    }
    const ready = data.ready !== false && sessions.ready !== false && permission.ready !== false;
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
      permissions: permission,
      auth: authInfo,
      redis: { configured: sessions.backend === "redis", ready: sessions.backend === "redis" ? sessions.ready : false }
    };
  }
  async function scopedDashboard(session) {
    const [ordersRaw, shopsRaw, scansRaw, spotsRaw, albumsRaw, seriesRaw] = await Promise.all([
      source.list("orders"), source.list("shops"), source.list("scans"),
      source.list("spots"), source.list("albums"), source.list("series")
    ]);
    const orders = (await filterRows(source, session, "orders", ordersRaw)).filter((row) => row && !row.deleted && !row.isDeleted);
    const shops = await filterRows(source, session, "shops", shopsRaw);
    const scans = await filterRows(source, session, "scans", scansRaw);
    const role = normalizeRole(session.role);
    const canSeeContentCounts = ["super", "finance", "content"].includes(role);
    const byStatus = {};
    orders.forEach((row) => { const status = row.status || "unknown"; byStatus[status] = (byStatus[status] || 0) + 1; });
    return {
      spots: canSeeContentCounts ? spotsRaw.filter((row) => row && !row.deleted && !row.isDeleted).length : 0,
      albums: canSeeContentCounts ? albumsRaw.filter((row) => row && !row.deleted && !row.isDeleted).length : 0,
      series: canSeeContentCounts ? seriesRaw.filter((row) => row && !row.deleted && !row.isDeleted).length : 0,
      orders: orders.length,
      shops: shops.length,
      scans: scans.filter((row) => row && !row.deleted && !row.isDeleted).length,
      byStatus,
    };
  }
  async function scopedHome(session) {
    const role = normalizeRole(session.role);
    // The operational home endpoint is an aggregate view. Only the
    // super-admin needs the editable global configuration here; every other
    // role receives scoped statistics and must use its dedicated pages for
    // content/configuration reads.
    if (role !== "super") return { stats: await scopedDashboard(session) };
    const config = (await source.get("homeConfig", "homeStats")) || (await source.get("config", "homeStats")) || {};
    return { ...config, stats: await scopedDashboard(session) };
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
  async function auditMutation(session, action, key, id, detail = "") {
    if (key === "logs") return true;
    try {
      await source.create("logs", {
        action, operator: session.account, operatorId: session.subjectId,
        targetType: key, targetId: id || "", detail: String(detail || "").slice(0, 500), createTime: new Date().toISOString()
      });
      return true;
    } catch (_) { return false; }
  }
  async function requireSession(req, res, pathname, kind = "admin") {
    await initAuth();
    if (kind === "admin" && permissionStore) {
      try { await initPermissions(); }
      catch (e) {
        if (permissionStore.required || safeErrorStatus(e) === 503) { json(res, 503, { error: "权限数据服务暂不可用" }); return null; }
      }
    }
    const token = parseBearer(req);
    if (!token) { await auditDenied(null, pathname, "缺少 Authorization Bearer 会话"); json(res, 401, { error: "未登录或会话已过期" }); return null; }
    let session;
    try { session = await auth.getSession(token); }
    catch (e) { if (e && e.code === "AUTH_STORE_UNAVAILABLE") { json(res, 503, { error: "认证服务暂不可用" }); return null; } throw e; }
    if (!session || (kind === "admin" && session.kind !== "admin") || (kind === "public" && session.kind !== "public")) {
      await auditDenied(session, pathname, "会话类型或凭据无效"); json(res, 401, { error: "未登录或会话已过期" }); return null;
    }
    if (kind === "admin") {
      try { session = await refreshAdminSession(session, token); }
      catch (e) { if (e && e.code === "DATA_SOURCE_UNAVAILABLE") { json(res, 503, { error: "数据服务暂不可用" }); return null; } throw e; }
      if (!session) {
        try { await auth.revokeSession(token); } catch (_) {}
        await auditDenied(null, pathname, "账号已停用或凭据已变更");
        json(res, 401, { error: "账号已停用或会话已失效，请重新登录" });
        return null;
      }
    }
    return session;
  }
  function forbidden(res, session, pathname, detail = "当前角色无权访问") {
    auditDenied(session, pathname, detail); json(res, 403, { error: detail });
  }
  function dynamicActionKeys(permissionKeys = []) {
    const keys = new Set((Array.isArray(permissionKeys) ? permissionKeys : []).map(String));
    if (keys.has("*")) return ["*"];
    const output = new Set(keys);
    const aliases = {
      view: ["view", "read", "*.view", "system.view"], dashboard: ["dashboard", "dashboard.view"],
      orderEdit: ["orderEdit", "order.edit", "order.write", "orderStatus"], assign: ["assign", "dispatch", "order.assign"],
      transfer: ["transfer", "order.transfer"], cancelOrder: ["cancelOrder", "order.cancel"], financeReview: ["financeReview", "finance.review", "finance.audit"],
      shopEdit: ["shopEdit", "shop", "shop.edit"], contentEdit: ["contentEdit", "content", "content.edit"], shootUpdate: ["shootUpdate", "order.shoot", "orderStatus"],
      export: ["export", "report.export"], permissionManage: ["permissionManage", "permission.manage", "authz.manage", "system.permission.manage"]
    };
    Object.entries(aliases).forEach(([action, candidates]) => { if (candidates.some((candidate) => keys.has(candidate))) output.add(action); });
    return [...output];
  }
  function authzSubject(user, policy) {
    const extra = user && user.extra && typeof user.extra === "object" ? user.extra : {};
    const roleKey = normalizeRole(policy && policy.role && (policy.role.roleKey || policy.role.code));
    const legacyKey = extra.legacyKey || (extra.subjectType === "merchant" ? "shops" : extra.subjectType === "distributor" ? "distributors" : extra.subjectType === "agent" ? "agents" : "staff");
    const subjectType = extra.subjectType || (legacyKey === "shops" ? "merchant" : legacyKey === "distributors" ? "distributor" : legacyKey === "agents" ? "agent" : "staff");
    const subjectId = String(extra.subjectId || extra.legacyId || user.id || "");
    return { roleKey, legacyKey, subjectType, subjectId, extra };
  }
  function authzVersion(value) {
    if (!value) return "";
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }
  async function handlePermissionLogin(req, res, account, password, lockKey) {
    if (!permissionStore || !permissionStore.required) return false;
    await initPermissions();
    const user = await permissionStore.authenticate(account, password);
    if (!user) {
      const result = await auth.recordLoginFailure(lockKey);
      if (result.blocked) return json(res, 429, { ok: false, error: "账号或密码错（失败次数过多，账号已临时锁定）" });
      return json(res, 401, { ok: false, error: "账号或密码错" });
    }
    if (isDisabledStatus(user.status)) return json(res, 403, { ok: false, error: "该账号已被停用，请联系管理员启用后再登录" });
    const policy = await permissionStore.getPolicyForUser(user);
    const subject = authzSubject(user, policy);
    if (!policy || !policy.role || !subject.roleKey || isDisabledStatus(policy.role.status)) return json(res, 403, { ok: false, error: "该账号绑定的角色不存在或已停用" });
    const permissionKeys = Array.isArray(policy.permissionKeys) ? [...new Set(policy.permissionKeys.map(String))] : [];
    const menuKeys = Array.isArray(policy.menuKeys) ? [...new Set(policy.menuKeys.map(String))] : [];
    const menuDefinitions = typeof permissionStore.listMenus === "function" ? await permissionStore.listMenus() : [];
    const sessionPayload = {
      kind: "admin", authzUserId: String(user.id), authzUpdatedAt: authzVersion(user.updatedAt), subjectType: subject.subjectType,
      subjectId: subject.subjectId, account: user.account, name: user.name, role: subject.roleKey,
      roleName: policy.role && policy.role.name ? policy.role.name : subject.roleKey,
      roleId: policy.role && policy.role.id ? policy.role.id : user.roleId, menuKeys, permissionKeys,
      menuDefinitions: (Array.isArray(menuDefinitions) ? menuDefinitions : []).map((menu) => ({
        key: String(menu.menuKey || menu.key || menu.id || ""), label: String(menu.name || menu.label || menu.menuKey || menu.key || ""),
        group: String((menu.meta && menu.meta.group) || menu.group || ""), path: String(menu.path || ""), icon: String(menu.icon || ""),
        routeKey: String((menu.meta && (menu.meta.routeKey || menu.meta.targetKey)) || menu.routeKey || menu.targetKey || menu.menuKey || menu.key || menu.id || ""),
        sort: Number(menu.sortNo ?? menu.sort ?? 0), status: permissionStatus(menu.status)
      })).filter((menu) => menu.key),
      permissions: permissionKeys, permissionsConfigured: true, permissionSource: permissionStore.backend === "mysql" ? "mysql" : "json-authz",
      shopId: subject.subjectType === "merchant" ? String(subject.extra.shopId || subject.subjectId) : String(subject.extra.shopId || ""),
      shopCode: String(subject.extra.shopCode || ""), distributorId: subject.subjectType === "distributor" ? subject.subjectId : String(subject.extra.distributorId || ""),
      agentId: subject.subjectType === "agent" ? subject.subjectId : String(subject.extra.agentId || "")
    };
    await auth.clearLoginFailures(lockKey);
    const session = await auth.createSession(sessionPayload);
    return json(res, 200, {
      ok: true, role: sessionPayload.role, roleName: sessionPayload.roleName, roleId: sessionPayload.roleId || "", account: user.account, name: user.name || account,
      staffId: sessionPayload.subjectId, shopId: sessionPayload.shopId, distributorId: sessionPayload.distributorId, agentId: sessionPayload.agentId,
      menus: menuKeys, menuKeys, menuDefinitions: sessionPayload.menuDefinitions, permissions: permissionKeys, permissionKeys, actions: dynamicActionKeys(permissionKeys),
      token: session.token, expiresAt: session.expiresAt, expiresIn: Math.floor(session.ttlMs / 1000)
    });
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
      if (permissionStore && permissionStore.required) return await handlePermissionLogin(req, res, account, password, lockKey);
      const staffList = await source.list("staff");
      const shopList = await source.list("shops");
      let distributorList = [];
      let agentList = [];
      try { distributorList = await source.list("distributors"); } catch (_) {}
      try { agentList = await source.list("agents"); } catch (_) {}
      const accountRecords = [
        ...(Array.isArray(staffList) ? staffList : []).map((item) => ({ item, key: "staff", subjectType: "staff", role: normalizeRole(item && item.role || "") })),
        ...(Array.isArray(shopList) ? shopList : []).map((item) => ({ item, key: "shops", subjectType: "merchant", role: "merchant" })),
        ...(Array.isArray(distributorList) ? distributorList : []).map((item) => ({ item, key: "distributors", subjectType: "distributor", role: "distributor" })),
        ...(Array.isArray(agentList) ? agentList : []).map((item) => ({ item, key: "agents", subjectType: "agent", role: "agent" }))
      ].filter((entry) => entry.item && entry.item.account === account);
      if (accountRecords.length > 1) return json(res, 409, { ok: false, error: "账号配置冲突，请联系管理员" });
      const matched = accountRecords.find((entry) => verifyPassword(entry.item.password, password));
      const candidate = matched && matched.item;
      if (candidate && isDisabledStatus(candidate.status)) {
        await auditDenied({ account }, "/api/auth/login", "账号当前已停用");
        return json(res, 403, { ok: false, error: "该账号已被停用，请联系管理员启用后再登录" });
      }
      if (!candidate) {
        const result = await auth.recordLoginFailure(lockKey);
        if (result.blocked) return json(res, 429, { ok: false, error: "账号或密码错（失败次数过多，账号已临时锁定）" });
        return json(res, 401, { ok: false, error: "账号或密码错" });
      }
      await auth.clearLoginFailures(lockKey);
      const role = matched.role;
      if (!ROLE_ACTIONS[role]) return json(res, 403, { ok: false, error: "账号角色未配置" });
      const subjectId = String(candidate.id || candidate._id || "");
      // Migrate legacy plaintext credentials before issuing the session so the
      // credential fingerprint remains stable for subsequent session checks.
      if (candidate.password && !String(candidate.password).startsWith("lxm1$")) {
        try {
          const migrated = hashPassword(password);
          const saved = await source.update(matched.key, subjectId, { password: migrated });
          if (saved) candidate.password = migrated;
        } catch (_) {}
      }
      const sessionPayload = {
        kind: "admin", subjectType: matched.subjectType, subjectId, account, role,
        permissions: Array.isArray(candidate.permissionKeys) ? candidate.permissionKeys : (Array.isArray(candidate.permissions) ? candidate.permissions : []),
        permissionsConfigured: Array.isArray(candidate.permissionKeys) || Array.isArray(candidate.permissions),
        credentialDigest: credentialDigest(candidate.password),
        shopId: matched.subjectType === "merchant" ? String(candidate.id || candidate._id || candidate.shopId || "") : String(candidate.shopId || ""),
        shopCode: matched.subjectType === "merchant" ? String(candidate.shopId || "") : "",
        distributorId: matched.subjectType === "distributor" ? subjectId : String(candidate.distributorId || ""),
        agentId: matched.subjectType === "agent" ? subjectId : String(candidate.agentId || "")
      };
      const session = await auth.createSession(sessionPayload);
      return json(res, 200, {
        ok: true,
        role,
        account,
        name: candidate.name || account,
        staffId: subjectId,
        shopId: sessionPayload.shopId || "",
        distributorId: sessionPayload.distributorId || "",
        agentId: sessionPayload.agentId || "",
        permissions: Array.isArray(sessionPayload.permissions) ? sessionPayload.permissions : [],
        actions: [...roleActions(sessionPayload)],
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
    if (result && result.success === false) {
      let unavailable = !!(sourceStatus && sourceStatus.ready === false);
      if (!unavailable && source && typeof source.health === "function") {
        try { const sourceHealth = await source.health(); unavailable = sourceHealth && sourceHealth.ready === false; } catch (_) { unavailable = true; }
      }
      if (unavailable) return json(res, 503, { success: false, error: "数据服务暂不可用，请稍后重试" });
    }
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
    if (Object.keys(body || {}).some((field) => IMMUTABLE_ORDER_FIELDS.has(field))) return false;
    if (role === "super") return true;
    if (role === "finance") {
      const allowedFinance = key === "orders" ? ORDER_FINANCE_FIELDS : new Set(["status", "customerVisibleStatus", "financeStatus", "refundAmount", "approvedBy", "approvedAt", "logs", "updatedAt"]);
      return Object.keys(body || {}).every((field) => allowedFinance.has(field));
    }
    if (!(await filterRows(source, session, key, [current])).length) return false;
    const allowed = role === "service" ? (key === "orders" ? ORDER_SERVICE_FIELDS : new Set(["status", "customerVisibleStatus", "assigneeId", "logs", "updatedAt", "financeStatus", "refundAmount"])) : role === "photo" ? ORDER_PHOTO_FIELDS : role === "merchant" ? ORDER_MERCHANT_FIELDS : new Set();
    return Object.keys(body || {}).every((field) => allowed.has(field));
  }
  async function readConfigDocument(key, id) {
    let value = await source.get(key, id);
    if (key === "financeSettings" && id === "global") {
      if (value && typeof value === "object") {
        const clean = Object.fromEntries(Object.entries(value).filter(([field]) => FINANCE_DOCUMENT_FIELDS.has(field)));
        return { ...FINANCE_DEFAULTS, ...clean, id: "global", _id: "global" };
      }
    }
    if (key === "siteConfig" && id === "global") {
      const rows = await source.list("siteConfig");
      const merged = mergeSiteConfigFragments(value, rows);
      return Object.keys(merged).length ? { ...merged, id: "global", _id: "global" } : value;
    }
    if (value || key !== "financeSettings" || id !== "global") return value;
    // Finance settings and site configuration are separate documents. Never
    // use siteConfig fragments as a fallback for a missing finance singleton.
    const rows = await source.list("financeSettings");
    const assembled = {};
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!row || typeof row !== "object") continue;
      const fragmentId = String(row.id || row._id || "");
      if (!fragmentId || fragmentId === "global") continue;
      const fragment = { ...row };
      delete fragment.id;
      delete fragment._id;
      if (Object.prototype.hasOwnProperty.call(fragment, "value") && Object.keys(fragment).length === 1 && FINANCE_DOCUMENT_FIELDS.has(fragmentId)) assembled[fragmentId] = fragment.value;
      else Object.assign(assembled, Object.fromEntries(Object.entries(fragment).filter(([field]) => FINANCE_DOCUMENT_FIELDS.has(field))));
    }
    return { ...FINANCE_DEFAULTS, ...assembled, id: "global", _id: "global" };
  }
  function normalizeConfigFragment(id, fragment) {
    const numericKeys = Object.keys(fragment).every((key) => /^\d+$/.test(key));
    if (id === "bookingNotice" && numericKeys) return Object.keys(fragment).sort((a, b) => Number(a) - Number(b)).map((key) => fragment[key]);
    if (id === "privacyText" && numericKeys) return Object.keys(fragment).sort((a, b) => Number(a) - Number(b)).map((key) => fragment[key]).join("");
    return fragment;
  }
  function mergeSiteConfigFragments(canonical, rows) {
    const merged = canonical && typeof canonical === "object" ? { ...canonical } : {};
    const fragments = {};
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!row || typeof row !== "object") continue;
      const fragmentId = String(row.id || row._id || "");
      if (!fragmentId || fragmentId === "global" || fragmentId === "homeStats") continue;
      const fragment = { ...row };
      delete fragment.id;
      delete fragment._id;
      fragments[fragmentId] = normalizeConfigFragment(fragmentId, fragment);
    }
    const hasValue = (value) => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
    const mergeObject = (name, fragment) => {
      if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) return;
      const current = merged[name] && typeof merged[name] === "object" && !Array.isArray(merged[name]) ? merged[name] : {};
      merged[name] = { ...fragment, ...Object.fromEntries(Object.entries(current).filter(([key, value]) => !["id", "_id"].includes(key) && hasValue(value))) };
    };
    if (!hasValue(merged.bookingNotice) && fragments.bookingNotice !== undefined) merged.bookingNotice = fragments.bookingNotice;
    if (!hasValue(merged.privacyText) && fragments.privacyText !== undefined) merged.privacyText = fragments.privacyText;
    mergeObject("customPrice", fragments.customPrice);
    mergeObject("search", fragments.search);
    mergeObject("wechat", fragments.wechat);
    mergeObject("footprint", fragments.footprint);
    for (const [fragmentId, fragment] of Object.entries(fragments)) if (!(fragmentId in merged) && !["bookingNotice", "privacyText", "customPrice", "search", "wechat", "footprint"].includes(fragmentId)) merged[fragmentId] = fragment;
    return merged;
  }
  function financeApproved(value) {
    return normalizeFinanceStatus(value) === "已审";
  }
  function normalizeFinanceStatus(value) {
    const status = String(value || "").trim().toLowerCase();
    if (["已审", "已审核", "已通过", "财务已核对", "财务已核对到账", "已入账", "approved", "passed"].includes(status)) return "已审";
    if (["待审", "待审核", "待财务审", "待财务审核", "待确认", "pending"].includes(status)) return "待审";
    if (["已驳", "已驳回", "已退回", "rejected", "denied"].includes(status)) return "已驳";
    return String(value || "").trim();
  }
  function settlementType(value) {
    const key = String(value || "").trim().toLowerCase();
    if (["商家", "shop", "merchant"].includes(key)) return { key: "shop", label: "商家", collection: "shops" };
    if (["分销", "分销员", "distributor"].includes(key)) return { key: "distributor", label: "分销", collection: "distributors" };
    if (["摄影", "摄影师", "photo", "photographer"].includes(key)) return { key: "photo", label: "摄影", collection: "staff" };
    return null;
  }
  function entityIds(entity) {
    return new Set([entity && entity.id, entity && entity._id, entity && entity.shopId, entity && entity.shopCode,
      entity && entity.code, entity && entity.distributorId, entity && entity.agentId].filter(Boolean).map(String));
  }
  async function findSettlementEntity(type, id) {
    const wanted = String(id || "").trim();
    if (!wanted) return null;
    let direct = await source.get(type.collection, wanted);
    if (direct) return direct;
    const rows = await source.list(type.collection);
    return (Array.isArray(rows) ? rows : []).find((row) => entityIds(row).has(wanted)) || null;
  }
  function orderDistributorIds(order, shop) {
    const direct = Array.isArray(order && order.distributorIds) ? order.distributorIds : [];
    if (direct.length) return direct.map(String);
    const sourceDistributor = order && order.source && typeof order.source === "object" ? order.source.distributorId : "";
    if (sourceDistributor) return [String(sourceDistributor)];
    const shopIds = Array.isArray(shop && shop.distributorIds) ? shop.distributorIds : [];
    if (shopIds.length) return shopIds.map(String);
    if (shop && shop.distributorId) return [String(shop.distributorId)];
    return order && order.distributorId ? [String(order.distributorId)] : [];
  }
  function settlementOrderNet(order, tickets) {
    const verifiedPaid = (financeApproved(order.depositFinanceStatus) ? Number(order.depositPaid || 0) : 0)
      + (financeApproved(order.finalFinanceStatus) ? Number(order.finalPaid || 0) : 0);
    const orderRefund = Number(order.refundAmount || 0);
    const ticketRefund = (Array.isArray(tickets) ? tickets : [])
      .filter((ticket) => ticket && isAfterSaleTerminalStatus(ticket.status) && financeApproved(ticket.financeStatus))
      .reduce((sum, ticket) => sum + Number(ticket.refundAmount || ticket.amount || 0), 0);
    return Math.max(verifiedPaid - orderRefund - ticketRefund, 0);
  }
  function settlementDate(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  async function validateSettlementTransfer(body, session) {
    const type = settlementType(body.objectType);
    if (!type) return { error: "结算主体类型无效", status: 400 };
    const month = String(body.month || "").trim();
    if (month && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return { error: "结算月份格式无效", status: 400 };
    const cycle = String(body.settlementCycle || "").trim();
    if (cycle && !["周结", "月结", "季度结"].includes(cycle)) return { error: "结算周期无效", status: 400 };
    if (body.period !== undefined && String(body.period || "").trim().length > 80) return { error: "结算周期描述过长", status: 400 };
    const transferKey = String(body.key || "").trim();
    if (!transferKey) return { error: "缺少结算批次标识", status: 400 };
    let existingTransfers;
    try { existingTransfers = await source.list("reconciliationTransfers"); }
    catch (_) { return { error: "结算记录暂不可用", status: 503 }; }
    const activeTransfers = (Array.isArray(existingTransfers) ? existingTransfers : [])
      .filter((row) => row && !["已驳", "cancelled", "已取消"].includes(String(row.status || "").trim()));
    if (activeTransfers.some((row) => String(row.key || "") === transferKey)) return { error: "该结算批次已存在，不能重复提交", status: 409 };

    let entity;
    try { entity = await findSettlementEntity(type, body.objectId); }
    catch (_) { return { error: "结算主体数据暂不可用", status: 503 }; }
    if (!entity || !isActiveStatusForScope(entity)) return { error: "结算主体不存在或已停用", status: 404 };
    if (type.key === "photo" && normalizeRole(entity.role) !== "photo") return { error: "结算主体不是有效摄影师", status: 409 };
    const canonicalEntityId = getRowId(entity);
    let observationDays = 0;
    try {
      const setting = (await source.get("financeSettings", "global")) || (await source.list("financeSettings")).find((row) => row && (row.settlementObservationDays !== undefined || row.observationDays !== undefined));
      observationDays = Math.min(Math.max(Number(setting && (setting.settlementObservationDays ?? setting.observationDays) || 0), 0), 30);
    } catch (_) { return { error: "财务参数暂不可用，无法安全结算", status: 503 }; }
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
    if (!orderIds.length) return { error: "结算必须关联订单", status: 400 };
    if (orderIds.length > 500) return { error: "单次结算最多关联 500 笔订单", status: 400 };
    if (new Set(orderIds).size !== orderIds.length) return { error: "结算订单不能重复", status: 400 };
    let orders;
    let tickets;
    try {
      orders = await Promise.all(orderIds.map((orderId) => source.get("orders", orderId)));
      tickets = await source.list("afterSales");
    } catch (_) { return { error: "订单数据暂不可用", status: 503 }; }
    if (orders.some((order) => !order || order.deleted || order.isDeleted)) return { error: "结算订单无效或已删除", status: 409 };
    const allTickets = Array.isArray(tickets) ? tickets : [];
    const orderNos = [];
    let expectedAmount = 0;
    for (const order of orders) {
      let shop = null;
      const orderShopId = order.shopId || (order.source && typeof order.source === "object" ? order.source.shopId : "") || "";
      try { shop = orderShopId ? await findSettlementEntity({ collection: "shops" }, String(orderShopId)) : null; }
      catch (_) { return { error: "商家数据暂不可用", status: 503 }; }
      const entitySet = entityIds(entity);
      const relationOk = type.key === "shop"
        ? entitySet.has(String(orderShopId))
        : type.key === "distributor"
          ? orderDistributorIds(order, shop).some((id) => entitySet.has(id))
          : entitySet.has(String(order.photographerId || ""));
      if (!relationOk) return { error: "结算主体与关联订单不匹配", status: 409 };
      const orderTickets = allTickets.filter((ticket) => ticket && String(ticket.orderId || "") === getRowId(order));
      if (Array.isArray(order.afterSales)) orderTickets.push(...order.afterSales.filter((ticket) => ticket && !orderTickets.includes(ticket)));
      if (orderTickets.some((ticket) => !isAfterSaleTerminalStatus(ticket.status))) return { error: "订单存在处理中售后，暂不能结算", status: 409 };
      if (orderTickets.some((ticket) => Number(ticket.refundAmount || ticket.amount || 0) > 0 && !financeApproved(ticket.financeStatus))) return { error: "订单退款尚未完成财务审核，暂不能结算", status: 409 };
      if (!isOrderCompletedStatus(order.status) && !isOrderCancelledStatus(order.status)) {
        return { error: "只有已完成或有留存实收的中止订单可以结算", status: 409 };
      }
      if (order.riskBlocked || order.riskFlag || order.frozen || order.freezeReason || order.riskReason) return { error: "订单存在风控冻结，暂不能结算", status: 409 };
      if (isOrderCompletedStatus(order.status) && !order.settlementObservationReleased && observationDays > 0) {
        const completedAt = settlementDate(order.completedAt || order.deliveredAt || order.finishedAt || order.completedTime || order.updatedAt);
        if (completedAt && Date.now() < completedAt.getTime() + observationDays * 24 * 60 * 60 * 1000) return { error: "订单仍在结算静置期，暂不能结算", status: 409 };
      }
      const net = settlementOrderNet(order, orderTickets);
      if (net <= 0) return { error: "订单没有已审核实收，不能结算", status: 409 };
      if (isOrderCompletedStatus(order.status)) {
        const total = Number(order.totalAmount || order.totalPrice || order.price || 0);
        const discount = Number(order.finalDiscountAmount || 0);
        if (total > 0 && net + Number(orderRefundForSettlement(order, orderTickets)) + discount < total - 0.01) {
          return { error: "订单仍有未完成收款或审核，暂不能结算", status: 409 };
        }
      }
      const rate = type.key === "shop"
        ? Number(entity.commissionRate || entity.shareRatio || 0)
        : type.key === "distributor"
          ? Number((shop && shop.distributorRates && shop.distributorRates[canonicalEntityId]) ?? entity.commissionRate ?? 0)
          : Number(order.photographerCommissionRate ?? entity.commissionRate ?? 20);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { error: "结算比例配置无效", status: 409 };
      expectedAmount += net * rate / 100;
      orderNos.push(String(order.orderNo || order.id || order._id || ""));
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { error: "结算金额无效", status: 400 };
    const roundedExpected = Math.round(expectedAmount * 100) / 100;
    // The core batch must equal the server-computed commission. Exceptional
    // corrections belong in the approved adjustment ledger, not a forged
    // lower/higher transfer amount.
    if (Math.abs(amount - roundedExpected) > 0.01) return { error: "结算金额必须等于订单实际可结算分成，请通过冲正台账处理差异", status: 409 };
    const suppliedNos = Array.isArray(body.orderNos) ? body.orderNos.map((value) => String(value || "").trim()).filter(Boolean) : [];
    if (suppliedNos.length && (suppliedNos.length !== orderNos.length || suppliedNos.some((value, index) => value !== orderNos[index]))) {
      return { error: "关联订单号与订单记录不一致", status: 409 };
    }
    const overlap = new Set(orderIds);
    if (activeTransfers.some((row) => String(row.objectType || "") === type.label && String(row.objectId || "") === canonicalEntityId
      && (String(row.month || "") === String(body.month || "") || String(row.period || "") === String(body.period || ""))
      && (Array.isArray(row.orderIds) ? row.orderIds.some((id) => overlap.has(String(id))) : false))) {
      return { error: "关联订单已在本结算周期确认，不能重复结算", status: 409 };
    }
    body.objectType = type.label;
    body.objectId = canonicalEntityId;
    body.objectName = String(entity.name || body.objectName || canonicalEntityId).slice(0, 160);
    body.amount = roundedExpected;
    body.orderIds = orderIds;
    body.orderNos = orderNos;
    return { ok: true, expectedAmount: roundedExpected };
  }
  function orderRefundForSettlement(order, tickets) {
    return Number(order.refundAmount || 0) + (Array.isArray(tickets) ? tickets
      .filter((ticket) => ticket && isAfterSaleTerminalStatus(ticket.status) && financeApproved(ticket.financeStatus))
      .reduce((sum, ticket) => sum + Number(ticket.refundAmount || ticket.amount || 0), 0) : 0);
  }
  function permissionAdminAllowed(session) {
    // Keep the authority-of-authority boundary explicit. Role grants can
    // mint further privileges, so only the system super administrator may
    // change menus, roles, or login accounts.
    return normalizeRole(session && session.role) === "super" && hasAction(session, "view");
  }
  function permissionStatus(value, fallback = "active") {
    const text = String(value || "").trim().toLowerCase();
    if (["停用", "禁用", "inactive", "disabled", "deleted"].includes(text)) return "disabled";
    return text === "" ? fallback : "active";
  }
  function permissionStatusLabel(value) { return permissionStatus(value) === "disabled" ? "停用" : "启用"; }
  function permissionMenuOutput(row = {}) {
    const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
    const key = String(row.menuKey || row.key || row.id || "");
    const routeKey = String(row.routeKey || row.targetKey || meta.routeKey || meta.targetKey || key);
    return {
      ...row, id: String(row.id || key), key, menuKey: key, label: row.label || row.name || key, name: row.name || row.label || key,
      parentKey: row.parentKey || row.parentId || meta.parentKey || "", parentId: row.parentId || row.parentKey || meta.parentKey || "",
      group: row.group || meta.group || "", path: row.path || `/${key}`, icon: row.icon || meta.icon || "", sort: Number(row.sort ?? row.sortNo ?? meta.sort ?? 0), sortNo: Number(row.sortNo ?? row.sort ?? meta.sort ?? 0),
      routeKey, targetKey: routeKey, type: row.type || meta.type || "menu", status: permissionStatusLabel(row.status), enabled: permissionStatus(row.status) !== "disabled", meta
    };
  }
  async function permissionMenus() {
    const rows = permissionStore && typeof permissionStore.listMenus === "function" ? await permissionStore.listMenus() : [];
    return (Array.isArray(rows) ? rows : []).map(permissionMenuOutput).sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
  }
  async function permissionRoles() {
    const rows = permissionStore && typeof permissionStore.listRoles === "function" ? await permissionStore.listRoles() : [];
    const output = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row.id || "");
      const grants = permissionStore && typeof permissionStore.getRoleGrants === "function" ? await permissionStore.getRoleGrants(id) : { menuKeys: [], permissionKeys: [] };
      const key = String(row.roleKey || row.code || row.key || id);
      output.push({ ...row, id, key, roleKey: key, name: row.name || key, status: permissionStatusLabel(row.status), menus: [...new Set((grants.menuKeys || []).map(String))], menuKeys: [...new Set((grants.menuKeys || []).map(String))], actions: [...new Set((grants.permissionKeys || []).map(String))], permissionKeys: [...new Set((grants.permissionKeys || []).map(String))] });
    }
    return output;
  }
  async function permissionUsers() {
    const rows = permissionStore && typeof permissionStore.listUsers === "function" ? await permissionStore.listUsers() : [];
    const roles = await permissionRoles();
    const roleMap = new Map(roles.map((row) => [String(row.id), row]));
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const role = roleMap.get(String(row.roleId || row.role || ""));
      const roleKey = role ? role.roleKey : String(row.role || row.roleId || "");
      const extra = row.extra && typeof row.extra === "object" ? row.extra : {};
      return { ...row, id: String(row.id || row._id || ""), name: row.name || row.displayName || row.account, role: roleKey, roleId: role ? role.id : row.roleId, roleName: role ? role.name : roleKey, status: permissionStatusLabel(row.status), permissionKeys: Array.isArray(row.permissionKeys) ? row.permissionKeys : (Array.isArray(extra.permissionKeys) ? extra.permissionKeys : []) };
    });
  }
  async function validateRoleGrants(roleKey, sourceMenus, sourcePermissions) {
    const menuKeys = [...new Set((Array.isArray(sourceMenus) ? sourceMenus : []).map(String).filter(Boolean))];
    const permissionKeys = [...new Set((Array.isArray(sourcePermissions) ? sourcePermissions : []).map(String).filter(Boolean))];
    if (roleKey === "super" && !permissionKeys.includes("*")) return { ok: false, status: 409, error: "超级管理员必须保留全部权限" };
    if (roleKey !== "super" && permissionKeys.some((key) => key === "*" || ["permissionManage", "permission.manage", "authz.manage", "system.permission.manage"].includes(key))) return { ok: false, status: 403, error: "只有超级管理员可以授予权限管理能力" };
    const validMenus = new Set((await permissionMenus()).filter((menu) => menu.enabled !== false).map((menu) => String(menu.key)));
    if (menuKeys.some((key) => !validMenus.has(key))) return { ok: false, status: 400, error: "授权菜单不存在或已停用" };
    return { ok: true, menuKeys, permissionKeys };
  }
  async function permissionUserContext(userId) {
    const user = await permissionStore.getUser(userId);
    if (!user) return null;
    const roles = await permissionRoles();
    const role = roles.find((item) => String(item.id) === String(user.roleId) || String(item.roleKey) === String(user.roleId) || String(item.roleKey) === String(user.role)) || null;
    const extra = user.extra && typeof user.extra === "object" ? user.extra : {};
    const legacyKey = ["staff", "shops", "distributors", "agents"].includes(String(extra.legacyKey)) ? String(extra.legacyKey) : "staff";
    const legacyId = String(extra.legacyId || user.id || userId);
    return { user, roles, role, extra, legacyKey, legacyId };
  }
  async function assertPermissionUserMutable(res, session, context, deletingOrDisabling) {
    if (!context) { json(res, 404, { error: "人员不存在" }); return false; }
    const { user, role, roles } = context;
    if (String(user.id) === String(session.authzUserId || "") || String(user.account) === String(session.account)) {
      json(res, 409, { error: deletingOrDisabling ? "不能删除或停用当前登录账号" : "不能修改当前登录账号状态" });
      return false;
    }
    if (deletingOrDisabling && role && role.roleKey === "super") {
      const activeSupers = (await permissionStore.listUsers()).filter((item) => {
        const itemRole = roles.find((candidate) => String(candidate.id) === String(item.roleId) || String(candidate.roleKey) === String(item.roleId) || String(candidate.roleKey) === String(item.role));
        return itemRole && itemRole.roleKey === "super" && !isDisabledStatus(item.status);
      });
      if (activeSupers.length <= 1) { json(res, 409, { error: "至少保留一个启用中的超级管理员" }); return false; }
    }
    return true;
  }
  async function setPermissionUserStatus(res, session, userId, status) {
    const context = await permissionUserContext(userId);
    if (!(await assertPermissionUserMutable(res, session, context, permissionStatus(status) === "disabled"))) return null;
    const normalized = permissionStatus(status);
    const legacyBefore = await source.get(context.legacyKey, context.legacyId).catch(() => null);
    const authBefore = typeof permissionStore.getUserState === "function" ? await permissionStore.getUserState(userId) : context.user;
    const updated = await permissionStore.updateUser(userId, { status: normalized });
    if (!updated) { json(res, 404, { error: "人员不存在" }); return null; }
    try {
      if (legacyBefore) await source.update(context.legacyKey, context.legacyId, { status: normalized === "disabled" ? "停用" : "启用" });
    } catch (_) {
      try { await permissionStore.restoreUserState(userId, authBefore); } catch (__) {}
      json(res, 503, { error: "账号状态已回滚，业务数据服务暂不可用，请稍后重试" });
      return null;
    }
    await auditMutation(session, normalized === "disabled" ? "停用权限人员" : "启用权限人员", "authz_users", userId, `权限中心${normalized === "disabled" ? "停用" : "启用"}账号`);
    return updated;
  }
  async function deletePermissionUser(res, session, userId) {
    const context = await permissionUserContext(userId);
    if (!(await assertPermissionUserMutable(res, session, context, true))) return null;
    const legacyBefore = await source.get(context.legacyKey, context.legacyId).catch(() => null);
    try {
      if (legacyBefore && !(await source.remove(context.legacyKey, context.legacyId))) throw Object.assign(new Error("业务人员不存在"), { code: "NOT_FOUND" });
      const removed = await permissionStore.deleteUser(userId);
      if (!removed) throw Object.assign(new Error("人员不存在"), { code: "NOT_FOUND" });
    } catch (_) {
      try { if (legacyBefore) await source.create(context.legacyKey, legacyBefore); } catch (__) {}
      json(res, 503, { error: "人员删除未完成，已尽力恢复业务数据，请稍后重试" });
      return null;
    }
    await auditMutation(session, "删除权限人员", "authz_users", userId, "权限中心删除人员账号");
    return { ok: true, id: userId };
  }
  async function permissionRoute(req, res, parts, session, pathname) {
    if (!permissionStore) return json(res, 503, { error: "权限数据服务未初始化" });
    if (!permissionAdminAllowed(session)) return forbidden(res, session, pathname, "只有权限管理员可以配置菜单、角色和人员");
    try { await initPermissions(); } catch (_) { return json(res, 503, { error: "权限数据服务暂不可用" }); }
    const resource = String(parts[1] || "").toLowerCase();
    const idPart = parts[2] ? decodePart(parts[2]) : "";
    const action = String(parts[3] || "").toLowerCase();
    if (req.method === "GET") {
      if (!resource) {
        const snapshot = await permissionStore.snapshot();
        const permissions = [...new Set((Array.isArray(snapshot.rolePermissions) ? snapshot.rolePermissions : []).map((row) => String(row.permissionKey || row.permission_key || "")).filter(Boolean))].sort();
        return json(res, 200, { menus: await permissionMenus(), roles: await permissionRoles(), users: await permissionUsers(), permissions });
      }
      if (resource === "menus") return json(res, 200, await permissionMenus());
      if (resource === "roles") {
        if (idPart && action === "grants") {
          const roles = await permissionRoles(); const row = roles.find((item) => item.id === idPart || item.roleKey === idPart);
          return row ? json(res, 200, { roleId: row.id, menuKeys: row.menuKeys, permissionKeys: row.permissionKeys }) : json(res, 404, { error: "角色不存在" });
        }
        return json(res, 200, await permissionRoles());
      }
      if (resource === "users" || resource === "staff") return json(res, 200, await permissionUsers());
      return json(res, 404, { error: "权限资源不存在" });
    }
    if (!["POST", "PUT", "DELETE"].includes(req.method)) return json(res, 405, { error: "方法不支持" });
    if ((resource === "users" || resource === "staff") && ["disable", "enable"].includes(action)) {
      if (req.method !== "POST") return json(res, 405, { error: "请使用 POST 更新人员状态" });
      const updated = await setPermissionUserStatus(res, session, idPart, action === "disable" ? "disabled" : "active");
      if (!updated) return;
      return json(res, 200, { ...updated, status: permissionStatusLabel(updated.status) });
    }
    if (req.method === "DELETE") {
      if (!idPart) return json(res, 400, { error: "缺少权限记录 id" });
      if (resource === "users" || resource === "staff") {
        const deleted = await deletePermissionUser(res, session, idPart);
        if (!deleted) return;
        return json(res, 200, deleted);
      }
      if (resource === "menus") {
        const current = await permissionStore.getMenu(idPart);
        if (!current) return json(res, 404, { error: "菜单不存在" });
        const menuKey = String(current.menuKey || current.key || idPart);
        const roles = await permissionRoles();
        if (roles.some((role) => (role.menus || []).map(String).includes(menuKey))) return json(res, 409, { error: "菜单仍被角色授权，不能删除" });
        if ((await permissionMenus()).some((menu) => String(menu.parentKey || menu.parentId || "") === menuKey)) return json(res, 409, { error: "菜单仍包含下级菜单，不能删除" });
        const ok = await permissionStore.deleteMenu(idPart);
        if (ok) await auditMutation(session, "删除权限菜单", "authz_menus", idPart, "权限中心删除菜单");
        return json(res, ok ? 200 : 404, { ok });
      }
      if (resource === "roles") {
        const roles = await permissionRoles(); const current = roles.find((item) => item.id === idPart || item.roleKey === idPart);
        if (current && ["super", "admin"].includes(String(current.roleKey))) return json(res, 409, { error: "系统角色不可删除" });
        const users = await permissionStore.listUsers();
        if ((Array.isArray(users) ? users : []).some((user) => String(user.roleId || user.role || "") === String(idPart) || String(user.roleId || "") === String(current && current.roleKey || ""))) return json(res, 409, { error: "角色仍绑定人员，不能删除" });
        const ok = await permissionStore.deleteRole(idPart);
        if (ok) await auditMutation(session, "删除权限角色", "authz_roles", idPart, "权限中心删除角色");
        return json(res, ok ? 200 : 404, { ok });
      }
      return json(res, 404, { error: "权限资源不存在" });
    }
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "请求体无效" });
    if (resource === "menus") {
      const current = idPart ? await permissionStore.getMenu(idPart) : null;
      const key = String(body.key || body.menuKey || (current && (current.menuKey || current.key)) || body.id || "").trim();
      const name = String(body.name || body.label || (current && (current.name || current.label)) || "").trim();
      if (!/^[A-Za-z][A-Za-z0-9_.-]{1,127}$/.test(key) || !name) return json(res, 400, { error: "菜单标识或名称无效" });
      if (current && String(current.menuKey || current.key || "") !== key) return json(res, 409, { error: "已有菜单不允许修改标识" });
      const currentMeta = current && current.meta && typeof current.meta === "object" ? current.meta : {};
      const routeKey = String(body.routeKey || body.targetKey || currentMeta.routeKey || currentMeta.targetKey || (current && (current.routeKey || current.targetKey)) || key).trim();
      if (!ROUTE_MENU_KEYS.has(routeKey)) return json(res, 400, { error: "目标页面必须是已注册后台页面" });
      const parentKey = String(body.parentKey || body.parentId || (current && (current.parentKey || current.parentId)) || "").slice(0, 128) || null;
      if (parentKey) {
        const menus = await permissionMenus();
        const byKey = new Map(menus.map((menu) => [String(menu.key), menu]));
        if (!byKey.has(parentKey)) return json(res, 400, { error: "上级菜单不存在" });
        const seen = new Set([key]);
        let cursor = parentKey;
        while (cursor) {
          if (seen.has(cursor)) return json(res, 400, { error: "菜单层级不能形成循环" });
          seen.add(cursor);
          const row = byKey.get(cursor);
          cursor = row && row.parentKey ? String(row.parentKey) : "";
        }
      }
      const payload = { id: idPart || body.id || `menu_${key}`, menuKey: key, key, name: name.slice(0, 128), path: String(body.path || (current && current.path) || `/${routeKey}`).slice(0, 255), icon: String(body.icon || (current && current.icon) || "").slice(0, 64), parentKey, sortNo: Math.max(0, Math.min(9999, Number(body.sortNo ?? body.sort ?? (current && (current.sortNo ?? current.sort)) ?? 0) || 0)), status: body.status === undefined ? permissionStatus(current && current.status) : permissionStatus(body.status), meta: { ...currentMeta, group: String(body.group ?? currentMeta.group ?? (current && current.group) ?? "").slice(0, 64), type: String(body.type ?? currentMeta.type ?? (current && current.type) ?? "menu").slice(0, 24), routeKey } };
      const saved = idPart ? await permissionStore.updateMenu(idPart, payload) : await permissionStore.createMenu(payload);
      if (!saved) return json(res, 404, { error: "菜单不存在" });
      await auditMutation(session, idPart ? "更新权限菜单" : "新增权限菜单", "authz_menus", saved.id || payload.id, "权限中心菜单配置");
      return json(res, idPart ? 200 : 201, permissionMenuOutput(saved));
    }
    if (resource === "roles") {
      if (action === "grants" && idPart) {
        const roles = await permissionRoles(); const current = roles.find((item) => item.id === idPart || item.roleKey === idPart);
        if (!current) return json(res, 404, { error: "角色不存在" });
        const grants = await validateRoleGrants(current.roleKey, Array.isArray(body.menuKeys) ? body.menuKeys : body.menus, Array.isArray(body.permissionKeys) ? body.permissionKeys : body.actions);
        if (!grants.ok) return json(res, grants.status, { error: grants.error });
        const saved = await permissionStore.setRoleGrants(current.id, grants);
        await auditMutation(session, "更新角色授权", "authz_roles", current.id, "权限中心角色菜单与操作权限变更");
        return json(res, 200, { roleId: current.id, menuKeys: grants.menuKeys, permissionKeys: grants.permissionKeys, ...saved });
      }
      const currentRole = idPart ? (await permissionRoles()).find((item) => item.id === idPart || item.roleKey === idPart) : null;
      const key = String(body.key || body.roleKey || body.code || (currentRole && (currentRole.roleKey || currentRole.key)) || "").trim();
      const name = String(body.name || (currentRole && currentRole.name) || "").trim();
      if (!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(key) || !name) return json(res, 400, { error: "角色标识或名称无效" });
      const payload = { id: idPart || body.id || `role_${key}`, roleKey: key, key, name: name.slice(0, 128), description: String(body.description ?? (currentRole && currentRole.description) ?? "").slice(0, 500), status: body.status === undefined ? permissionStatus(currentRole && currentRole.status) : permissionStatus(body.status) };
      if (currentRole && currentRole.roleKey === "super" && key !== "super") return json(res, 409, { error: "系统超级管理员角色不允许修改标识" });
      if (currentRole && currentRole.roleKey === "super" && payload.status === "disabled") {
        const activeSupers = (await permissionStore.listUsers()).filter((user) => String(user.roleId || "") === String(currentRole.id) && !isDisabledStatus(user.status));
        if (activeSupers.length <= 1) return json(res, 409, { error: "至少保留一个启用中的超级管理员" });
      }
      const grantsProvided = Array.isArray(body.menuKeys) || Array.isArray(body.menus) || Array.isArray(body.permissionKeys) || Array.isArray(body.actions);
      const grants = grantsProvided ? await validateRoleGrants(key, body.menuKeys || body.menus, body.permissionKeys || body.actions) : null;
      if (grants && !grants.ok) return json(res, grants.status, { error: grants.error });
      const saved = idPart ? await permissionStore.updateRole(idPart, payload) : await permissionStore.createRole(payload);
      if (!saved) return json(res, 404, { error: "角色不存在" });
      if (grants) {
        try { await permissionStore.setRoleGrants(saved.id, grants); }
        catch (error) {
          try {
            if (currentRole) await permissionStore.updateRole(saved.id, { roleKey: currentRole.roleKey, name: currentRole.name, description: currentRole.description, status: permissionStatus(currentRole.status) });
            else await permissionStore.deleteRole(saved.id);
          } catch (_) {}
          throw error;
        }
      }
      await auditMutation(session, idPart ? "更新权限角色" : "新增权限角色", "authz_roles", saved.id || payload.id, "权限中心角色配置");
      const all = await permissionRoles();
      return json(res, idPart ? 200 : 201, all.find((item) => item.id === String(saved.id || payload.id)) || { ...saved, key });
    }
    if (resource === "users" || resource === "staff") {
      const existingUser = idPart ? await permissionStore.getUser(idPart) : null;
      const existingExtra = existingUser && existingUser.extra && typeof existingUser.extra === "object" ? existingUser.extra : {};
      const account = String(body.account || body.username || (existingUser && existingUser.account) || "").trim();
      const name = String(body.name || body.displayName || (existingUser && (existingUser.name || existingUser.displayName)) || account).trim();
      const roles = await permissionRoles();
      const existingRole = existingUser && roles.find((item) => String(item.id) === String(existingUser.roleId) || String(item.roleKey) === String(existingUser.roleId) || String(item.roleKey) === String(existingUser.role));
      const roleKey = String(body.role || body.roleKey || (existingRole && existingRole.roleKey) || (existingUser && existingUser.role) || "service").trim();
      if (!/^[A-Za-z0-9_.@-]{2,128}$/.test(account) || !name || !roleKey) return json(res, 400, { error: "人员账号、姓名或角色无效" });
      const role = roles.find((item) => item.roleKey === roleKey || item.id === roleKey);
      if (!role || role.status === "停用") return json(res, 400, { error: "绑定角色不存在或已停用" });
      if (role.roleKey === "super" && normalizeRole(session.role) !== "super") return json(res, 403, { error: "只有超级管理员可以绑定超级管理员角色" });
      const password = body.password === undefined ? "" : String(body.password);
      if (!idPart && !password) return json(res, 400, { error: "新增人员必须设置密码" });
      if (password && (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))) return json(res, 400, { error: "密码至少 8 位且同时包含字母和数字" });
      const userId = idPart || String(body.id || `staff_${crypto.randomBytes(8).toString("hex")}`);
      const requestedPermissions = Array.isArray(body.permissionKeys) ? body.permissionKeys : Array.isArray(body.permissions) ? body.permissions : (Array.isArray(existingUser && existingUser.permissionKeys) ? existingUser.permissionKeys : (Array.isArray(existingExtra.permissionKeys) ? existingExtra.permissionKeys : []));
      const inferredSubjectType = existingExtra.subjectType || (existingExtra.legacyKey === "shops" ? "merchant" : existingExtra.legacyKey === "distributors" ? "distributor" : existingExtra.legacyKey === "agents" ? "agent" : "staff");
      const inferredLegacyKey = existingExtra.legacyKey || (inferredSubjectType === "merchant" ? "shops" : inferredSubjectType === "distributor" ? "distributors" : inferredSubjectType === "agent" ? "agents" : "staff");
      const extra = { ...existingExtra, ...(body.extra && typeof body.extra === "object" ? body.extra : {}), permissionKeys: [...new Set(requestedPermissions.map(String).filter(Boolean))], subjectType: String(body.subjectType || inferredSubjectType), subjectId: String(body.subjectId || existingExtra.subjectId || userId), legacyKey: inferredLegacyKey, legacyId: String(existingExtra.legacyId || userId), distributorId: String(body.distributorId ?? existingExtra.distributorId ?? ""), agentId: String(body.agentId ?? existingExtra.agentId ?? ""), shopId: String(body.shopId ?? existingExtra.shopId ?? "") };
      const payload = { id: userId, account, name, displayName: name, roleId: role.id, role: role.roleKey, status: body.status === undefined ? permissionStatus(existingUser && existingUser.status) : permissionStatus(body.status), phone: String(body.phone ?? (existingUser && existingUser.phone) ?? "").slice(0, 64), email: String(body.email ?? (existingUser && existingUser.email) ?? "").slice(0, 255), extra, permissionKeys: requestedPermissions };
      const superRole = roles.find((item) => item.roleKey === "super");
      const existingIsSuper = !!(existingUser && ((superRole && String(existingUser.roleId || "") === String(superRole.id)) || String(existingUser.role || "") === "super"));
      if (existingIsSuper && (role.roleKey !== "super" || payload.status === "disabled")) {
        const activeSupers = (await permissionStore.listUsers()).filter((user) => {
          const userRole = String(user.roleId || user.role || "");
          return (superRole && userRole === String(superRole.id)) || userRole === "super";
        }).filter((user) => !isDisabledStatus(user.status));
        if (activeSupers.length <= 1) return json(res, 409, { error: "至少保留一个启用中的超级管理员" });
      }
      if (password) payload.password = password;
      const previousAuthzUser = existingUser;
      const previousAuthzState = idPart && typeof permissionStore.getUserState === "function" ? await permissionStore.getUserState(idPart) : null;
      const previousLegacy = idPart ? await source.get(String(existingExtra.legacyKey || "staff"), String(existingExtra.legacyId || userId)).catch(() => null) : null;
      const saved = idPart ? await permissionStore.updateUser(idPart, payload) : await permissionStore.createUser(payload);
      if (!saved) return json(res, 404, { error: "人员不存在" });
      // Subject identity is authorization metadata and belongs only to
      // lxm_auth_users. The business projection retains its operational
      // scope fields without duplicating auth-only values into generic leaves.
      const legacy = { id: userId, name, account, role: role.roleKey, status: payload.status, phone: payload.phone, email: payload.email, permissionKeys: payload.permissionKeys, permissions: payload.permissionKeys, shopId: extra.shopId, distributorId: extra.distributorId, agentId: extra.agentId };
      try {
        const legacyKey = String(extra.legacyKey || "staff");
        const legacyId = String(extra.legacyId || userId);
        const old = previousLegacy || await source.get(legacyKey, legacyId);
        const legacyPayload = { ...legacy, id: legacyId };
        if (old) await source.update(legacyKey, legacyId, legacyPayload); else await source.create(legacyKey, legacyPayload);
      } catch (_) {
        try {
          if (previousAuthzState && typeof permissionStore.restoreUserState === "function") await permissionStore.restoreUserState(idPart, previousAuthzState);
          else if (previousAuthzUser) await permissionStore.updateUser(idPart, previousAuthzUser);
          else await permissionStore.deleteUser(userId);
        } catch (__) {}
        return json(res, 503, { error: "人员资料已回滚，业务数据服务暂不可用，请稍后重试" });
      }
      await auditMutation(session, idPart ? "更新权限人员" : "新增权限人员", "authz_users", saved.id || userId, "权限中心人员账号配置");
      return json(res, idPart ? 200 : 201, { ...saved, role: role.roleKey, roleName: role.name, status: permissionStatusLabel(saved.status), permissionKeys: payload.permissionKeys });
    }
    return json(res, 404, { error: "权限资源不存在" });
  }
  async function collectionRoute(req, res, parts, session, pathname) {
    const key = decodePart(parts[1]); const id = parts[2] ? decodePart(parts[2]) : "";
    if (!KEY_SET.has(key)) { const e = new Error("不支持的数据集合"); e.code = "DATA_KEY_INVALID"; throw e; }
    const method = req.method;
    if (method === "GET") {
      if (!canReadKey(session, key)) return forbidden(res, session, pathname);
      if (id) {
        let value = await readConfigDocument(key, id);
        // Older JSON installs stored the singleton under homeStats. Keep read
        // compatibility while the next editor save writes siteConfig/global.
        if (!value && key === "siteConfig" && id === "global") value = await source.get(key, "homeStats");
        const rows = await filterRows(source, session, key, value ? [value] : []);
        if (!rows.length) return json(res, 404, { error: "未找到记录" });
        return json(res, 200, redactRow(key, rows[0], session));
      }
      const value = await source.list(key); const rows = await filterRows(source, session, key, value);
      return json(res, 200, rows.map((row) => redactRow(key, row, session)));
    }
    if (!["POST", "PUT", "DELETE"].includes(method)) return json(res, 405, { error: "方法不支持" });
    const contentTrashPost = key === "trash" && normalizeRole(session.role) === "content" && method === "POST";
    if (!canWriteKey(session, key) && !contentTrashPost) return forbidden(res, session, pathname);
    if (key === "logs" && method !== "POST" && normalizeRole(session.role) !== "super") return forbidden(res, session, pathname, "审计日志只能由超管维护");
    if (DOCUMENT_KEYS.has(key)) return json(res, 405, { error: "配置文档必须通过固定文档接口写入" });
    if (ORDER_KEYS.has(key) && ["PUT", "DELETE"].includes(method)) {
      return forbidden(res, session, pathname, "订单和售后变更必须通过专用操作接口");
    }
    if (FINANCE_KEYS.has(key) && method === "DELETE") {
      return forbidden(res, session, pathname, "财务凭证不能直接删除");
    }
    if (FINANCE_KEYS.has(key) && normalizeRole(session.role) !== "super") {
      const role = normalizeRole(session.role);
      const financeWriteAllowed = role === "finance"
        && ((key === "reconciliationTransfers" && ["POST", "PUT"].includes(method))
          || (key === "adjustmentRecords" && method === "POST"));
      if (!financeWriteAllowed) return forbidden(res, session, pathname, "财务凭证必须通过专用审核流程写入");
    }
    if (key === "merchantCodes" && method === "DELETE" && normalizeRole(session.role) !== "super") {
      return forbidden(res, session, pathname, "商家码只能由超管停用或清理");
    }
    if (method === "DELETE") {
      if (!id) return json(res, 400, { error: "缺少记录 id" });
      const current = await source.get(key, id);
      if (!current || !(await filterRows(source, session, key, [current])).length) return json(res, 404, { error: "未找到记录" });
      const ok = await source.remove(key, id);
      if (ok && permissionStore && permissionStore.required && PASSWORD_KEYS.has(key)) {
        try { await permissionStore.disableUser(id); }
        catch (_) {
          try { await source.create(key, current); } catch (__) {}
          return json(res, 503, { error: "账号已回滚，权限数据服务暂不可用，请稍后重试" });
        }
      }
      if (ok && !(await auditMutation(session, "删除数据", key, id, "管理端删除记录"))) {
        try { await source.create(key, current); } catch (_) {}
        if (permissionStore && permissionStore.required && PASSWORD_KEYS.has(key)) {
          try { await permissionStore.syncLegacyAccount(key, current); } catch (_) {}
        }
        return json(res, 503, { error: "记录已回滚，审计日志暂不可用，请稍后重试" });
      }
      return json(res, ok ? 200 : 404, { ok });
    }
    const body = await readBody(req);
    if (!body || Array.isArray(body) || typeof body !== "object") return json(res, 400, { error: "请求体无效" });
    if (contentTrashPost) {
      const validated = await validateContentTrashPost(body);
      if (validated.error) return json(res, validated.status, { error: validated.error });
      body.sourceKey = validated.sourceKey;
      body.sourceId = validated.sourceId;
      body.source = validated.current;
      body.restorable = true;
    }
    let permissionCredential = "";
    if (PASSWORD_KEYS.has(key)) {
      if (normalizeRole(session.role) !== "super") return forbidden(res, session, pathname, "只有系统超管可以管理账号");
      const policyErr = passwordPolicyError(key, body); if (policyErr) return json(res, 400, { error: policyErr });
      sanitizePasswordBody(key, body);
      if (permissionStore && permissionStore.required && method === "POST" && !body.password) return json(res, 400, { error: "新增账号必须设置登录密码" });
      if (permissionStore && permissionStore.required && body.password) {
        permissionCredential = String(body.password);
        delete body.password;
        delete body.passwordHash;
        delete body.password_hash;
      }
      if (Array.isArray(body.permissionKeys)) {
        body.permissions = [...new Set(body.permissionKeys.map(String))];
        delete body.permissionKeys;
      }
    }
    if (key === "siteConfig" && normalizeRole(session.role) === "content" && containsConfigSensitive(body)) {
      return forbidden(res, session, pathname, "内容运营不能修改集成凭据");
    }
    if (key === "reconciliationTransfers") {
      const role = normalizeRole(session.role);
      if (method === "POST") {
        const allowed = new Set(["id", "_id", "key", "month", "period", "settlementPeriod", "settlementCycle", "objectType", "objectId", "objectName", "amount", "status", "orderIds", "orderNos", "method", "voucherNo", "note"]);
        Object.keys(body).forEach((field) => { if (!allowed.has(field)) delete body[field]; });
        const validation = await validateSettlementTransfer(body, session);
        if (!validation.ok) return json(res, validation.status || 409, { error: validation.error });
        body.id = String(body.id || `transfer_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`).slice(0, 64);
        body._id = body.id;
        body.status = "已确";
        body.operator = session.account;
        body.operatorId = session.subjectId;
        body.time = new Date().toISOString();
      } else if (method === "PUT") {
        const allowed = new Set(["status", "payStatus", "paidBy", "paidAt", "sealedBy", "sealedAt", "sealNote", "unsealedBy", "unsealedAt", "unsealNote", "voucherNo", "note"]);
        if (Object.keys(body).some((field) => !allowed.has(field))) return forbidden(res, session, pathname, "结算记录只能通过专用字段更新");
        if (role === "finance" && Object.keys(body).some((field) => ["unsealedBy", "unsealedAt", "unsealNote"].includes(field))) return forbidden(res, session, pathname, "财务不能解封结算记录");
        const currentTransfer = await source.get("reconciliationTransfers", id);
        if (!currentTransfer) return json(res, 404, { error: "结算记录不存在" });
        if (String(currentTransfer.status || "") === "已封") return forbidden(res, session, pathname, "已封存结算记录不可修改");
        if (role === "finance" && body.status && body.status !== "已封") return forbidden(res, session, pathname, "财务只能封存已确认结算记录");
        if (body.status === "已封" && !String(body.sealNote || "").trim()) return json(res, 400, { error: "封存必须填写复核说明" });
        if (body.payStatus && !["", "已打", "待打"].includes(String(body.payStatus))) return json(res, 400, { error: "打款状态无效" });
        if (body.status && !["已确", "已封"].includes(String(body.status))) return json(res, 400, { error: "结算记录状态无效" });
        if (body.payStatus === "已打") { body.paidBy = session.account; body.paidAt = new Date().toISOString(); }
        else { delete body.paidBy; delete body.paidAt; }
        if (body.status === "已封") { body.sealedBy = session.account; body.sealedAt = new Date().toISOString(); }
        if (body.unsealNote) { body.unsealedBy = session.account; body.unsealedAt = new Date().toISOString(); }
      }
    }
    if (key === "adjustmentRecords" && method === "POST") {
      const allowed = new Set(["id", "_id", "orderNo", "orderId", "type", "amount", "targetType", "targetName", "note", "attachment", "offsetStatus"]);
      Object.keys(body).forEach((field) => { if (!allowed.has(field)) delete body[field]; });
      const amount = Number(body.amount || 0);
      if (!Number.isFinite(amount) || amount === 0 || !String(body.note || "").trim()) return json(res, 400, { error: "冲正金额和备注不能为空" });
      let order = null;
      try {
        order = body.orderId ? await source.get("orders", String(body.orderId)) : null;
        if (!order && body.orderNo) order = (await source.list("orders")).find((row) => row && row.orderNo === String(body.orderNo));
      } catch (_) { return json(res, 503, { error: "订单数据暂不可用" }); }
      if (!order || order.isDeleted || order.deleted) return json(res, 404, { error: "冲正记录必须关联有效订单" });
      const orderAmount = Number(order.totalAmount || order.totalPrice || order.price || 0);
      if (orderAmount > 0 && Math.abs(amount) > orderAmount) return json(res, 409, { error: "冲正金额不能超过订单金额" });
      body.amount = -Math.abs(amount);
      body.orderId = getRowId(order);
      body.orderNo = order.orderNo || body.orderNo || "";
      body.id = String(body.id || `adjust_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`).slice(0, 64);
      body._id = body.id;
      body.approvalStatus = normalizeRole(session.role) === "super" ? "已审" : "待审";
      body.operator = session.account;
      body.operatorId = session.subjectId;
      body.time = new Date().toISOString();
      if (body.approvalStatus === "已审") {
        body.approvedBy = session.account;
        body.approvedAt = body.time;
      }
    }
    if (key === "adjustmentRecords" && method === "PUT") {
      if (normalizeRole(session.role) !== "super") return forbidden(res, session, pathname, "只有超管可以审批冲正记录");
      const allowed = new Set(["approvalStatus", "approvedBy", "approvedAt", "note"]);
      if (Object.keys(body).some((field) => !allowed.has(field))) return forbidden(res, session, pathname, "冲正记录只能更新审批字段");
      if (body.approvalStatus && !["待审", "已审", "已驳"].includes(String(body.approvalStatus))) return json(res, 400, { error: "审批状态无效" });
      if (body.approvalStatus) { body.approvedBy = session.account; body.approvedAt = new Date().toISOString(); }
    }
    if (key === "monthlyClosings" && method === "POST") {
      const month = String(body.month || "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { error: "关账月份格式无效" });
      const existing = await source.list("monthlyClosings");
      if ((Array.isArray(existing) ? existing : []).some((row) => row && String(row.month || "") === month && row.status === "已关")) return json(res, 409, { error: "该月份已关账" });
      body.id = String(body.id || `closing_${month}`).slice(0, 64);
      body._id = body.id;
      body.status = "已关";
      body.operator = session.account;
      body.operatorId = session.subjectId;
      body.time = new Date().toISOString();
    }
    if (key === "logs") {
      body.user = session.account;
      body.operator = session.account;
      body.operatorId = session.subjectId;
      body.time = new Date().toISOString();
      body.action = String(body.action || "后台操作").slice(0, 120);
      body.target = String(body.target || body.targetType || "").slice(0, 160);
      body.detail = String(body.detail || "").slice(0, 500);
      body.level = ["低", "中", "高"].includes(String(body.level || "")) ? String(body.level) : "低";
      body.source = "admin-client";
      delete body.password; delete body.token; delete body.authorization;
    }
    if (key === "afterSales" && method === "POST") {
      const role = normalizeRole(session.role);
      if (!["super", "service"].includes(role)) return forbidden(res, session, pathname, "只有客服或超管可以创建售后工单");
      const orderId = String(body.orderId || "");
      const order = orderId ? await source.get("orders", orderId) : null;
      if (!order || order.isDeleted || order.deleted) return json(res, 404, { error: "关联订单不存在" });
      if (!(await filterRows(source, session, "orders", [order])).length) return forbidden(res, session, pathname, "不能为未授权订单创建售后工单");
      let tickets;
      try { tickets = await source.list("afterSales"); } catch (_) { return json(res, 503, { error: "售后数据暂不可用" }); }
      if ((Array.isArray(tickets) ? tickets : []).some((ticket) => ticket && String(ticket.orderId || "") === orderId && !isAfterSaleTerminalStatus(ticket.status))) {
        return json(res, 409, { error: "该订单已有处理中售后工单" });
      }
      const refundAmount = Number(body.refundAmount || 0);
      const paidAmount = Number(order.depositPaid || 0) + Number(order.finalPaid || 0);
      const totalAmount = Number(order.totalAmount || order.totalPrice || order.price || 0);
      if (!Number.isFinite(refundAmount) || refundAmount < 0 || refundAmount > (paidAmount > 0 ? paidAmount : totalAmount)) return json(res, 409, { error: "退款金额不能超过订单可退金额" });
      const allowedFields = new Set(["id", "_id", "orderId", "orderNo", "customer", "packageName", "type", "reason", "refundAmount", "submitSource", "assigneeId"]);
      Object.keys(body).forEach((field) => { if (!allowedFields.has(field)) delete body[field]; });
      body.orderId = orderId;
      body.orderNo = order.orderNo || body.orderNo || "";
      body.customer = order.customer || order.contactName || order.name || "";
      body.packageName = body.packageName || order.packageName || "";
      body.status = "待处";
      body.customerVisibleStatus = "已提";
      body.financeStatus = refundAmount > 0 ? "待审" : "无需财务审核";
      body.refundAmount = refundAmount;
      body.submitSource = "后台提交";
      if (body.assigneeId) {
        const staffRows = await source.list("staff");
        const validAssignee = (Array.isArray(staffRows) ? staffRows : []).some((staff) => staff
          && String(staff.id || staff._id) === String(body.assigneeId)
          && normalizeRole(staff.role) === "service" && isActiveStatusForScope(staff));
        if (!validAssignee) return json(res, 409, { error: "客服账号不存在或已停用" });
      } else if (order.assigneeId) body.assigneeId = order.assigneeId;
      body.id = String(body.id || `as_admin_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`).slice(0, 64);
      body._id = body.id;
      body.createdAt = new Date().toISOString();
      body.updatedAt = body.createdAt;
      body.logs = [`${session.account}提交售后：${String(body.reason || "").trim()}`];
      delete body.refundConfirmed;
      delete body.openid; delete body._openid;
      delete body.approvedBy; delete body.approvedAt; delete body.financeReviewedBy; delete body.financeReviewedAt;
      body.createdBy = session.account;
    }
    if (key === "orders" && method === "POST") {
      // The customer identity is assigned by the public booking RPC. Admin
      // manual orders are intentionally unowned and cannot impersonate a user.
      delete body.openid;
      delete body._openid;
      body.createdBy = session.account;
      body.createdById = session.subjectId;
      body.createTime = body.createTime || new Date().toISOString();
      if (normalizeRole(session.role) !== "super") {
        body.status = "new";
        body.customerStatus = "预约待确认";
        body.depositPaid = 0;
        body.finalPaid = 0;
        body.depositFinanceStatus = "";
        body.finalFinanceStatus = "";
        delete body.source;
        delete body.sourceCodeId;
        delete body.distributorId;
        delete body.afterSaleStatus;
        delete body.afterSaleId;
      }
    }
    if (method === "PUT") {
      if (!id) return json(res, 400, { error: "缺少记录 id" });
      // Order status, payment, assignment and deletion changes must go through
      // /api/orders/:id/action so the server can enforce the state machine and
      // append an audit timeline. Generic collection PUT is intentionally not
      // an alternate workflow command.
      if (key === "orders") return forbidden(res, session, pathname, "订单变更必须通过专用操作接口");
      if (!(await enforceOrderPatch(session, key, id, body))) return forbidden(res, session, pathname, "当前角色不能修改该记录或字段");
      const current = await source.get(key, id);
      if (!current || !(await filterRows(source, session, key, [current])).length) return json(res, 404, { error: "未找到记录" });
      const updated = await source.update(key, id, body);
      if (updated && permissionStore && permissionStore.required && PASSWORD_KEYS.has(key)) {
        try { await permissionStore.syncLegacyAccount(key, permissionCredential ? { ...updated, password: permissionCredential } : updated); }
        catch (_) {
          try { await restoreChangedFields(source, key, id, current, Object.keys(body)); } catch (__) {}
          return json(res, 503, { error: "人员资料已回滚，权限数据服务暂不可用，请稍后重试" });
        }
      }
      if (updated && FINANCE_KEYS.has(key)) {
        if (!(await auditMutation(session, "更新财务记录", key, id, "服务端财务记录变更"))) {
          try { await restoreChangedFields(source, key, id, current, Object.keys(body)); } catch (__) {}
          return json(res, 503, { error: "财务记录已回滚，审计日志暂不可用，请稍后重试" });
        }
      } else if (updated && key !== "logs") {
        await auditMutation(session, "更新数据", key, id, "管理端更新记录");
      }
      return json(res, updated ? 200 : 404, updated ? redactRow(key, updated, session) : { error: "未找到记录" });
    }
    if (key === "orders" && !["super", "service"].includes(normalizeRole(session.role))) return forbidden(res, session, pathname, "当前角色不能创建订单");
    const created = await source.create(key, body);
    if (created && permissionStore && permissionStore.required && PASSWORD_KEYS.has(key)) {
      try { await permissionStore.syncLegacyAccount(key, permissionCredential ? { ...created, password: permissionCredential } : created); }
      catch (_) {
        try { await source.remove(key, getRowId(created)); } catch (__) {}
        return json(res, 503, { error: "人员资料已回滚，权限数据服务暂不可用，请稍后重试" });
      }
    }
    let linkedOrder = null;
    let orderBefore = null;
    if (key === "afterSales") {
      const now = new Date().toISOString();
      try {
        const order = await source.get("orders", String(body.orderId));
        orderBefore = order && JSON.parse(JSON.stringify(order));
        linkedOrder = await source.update("orders", String(body.orderId), {
          afterSaleStatus: "pending", afterSaleReason: String(body.reason || "").trim(), afterSaleCreateTime: now,
          afterSaleId: getRowId(created),
          followRecords: [...(Array.isArray(order && order.followRecords) ? order.followRecords : []), { type: "afterSale", status: "pending", reason: String(body.reason || "").trim(), operator: session.account, operatorId: session.subjectId, createTime: now }],
          statusLogs: [...(Array.isArray(order && order.statusLogs) ? order.statusLogs : []), { type: "售后提交", action: "后台创建售后工单", operator: session.account, operatorId: session.subjectId, createTime: now }],
          updateTime: now,
        });
        if (!linkedOrder) throw new Error("关联订单保存失败");
        await source.create("logs", { action: "创建售后", operator: session.account, operatorId: session.subjectId, targetType: "afterSale", targetId: getRowId(created), detail: String(body.reason || "").trim(), createTime: now });
      } catch (error) {
        try { await source.remove(key, getRowId(created)); } catch (_) {}
        if (orderBefore) {
          try { await restoreChangedFields(source, "orders", String(body.orderId), orderBefore, ["afterSaleStatus", "afterSaleReason", "afterSaleCreateTime", "afterSaleId", "followRecords", "statusLogs", "updateTime"]); } catch (_) {}
        }
        return json(res, 503, { error: "售后已回滚，关联或审计保存失败，请稍后重试" });
      }
    }
    if (key === "orders") {
      try {
        await source.create("logs", { action: "创建订单", operator: session.account, operatorId: session.subjectId, targetType: "order", targetId: getRowId(created), detail: "后台手工建单", createTime: new Date().toISOString() });
      } catch (_) {
        try { await source.remove(key, getRowId(created)); } catch (__) {}
        return json(res, 503, { error: "订单已回滚，审计日志暂不可用，请稍后重试" });
      }
    }
    if (FINANCE_KEYS.has(key)) {
      try {
        await source.create("logs", { action: "创建财务记录", operator: session.account, operatorId: session.subjectId, targetType: key, targetId: getRowId(created), detail: "服务端财务记录创建", createTime: new Date().toISOString() });
      } catch (_) {
        try { await source.remove(key, getRowId(created)); } catch (__) {}
        return json(res, 503, { error: "财务记录已回滚，审计日志暂不可用，请稍后重试" });
      }
    }
    if (key !== "logs" && key !== "orders" && key !== "afterSales" && !FINANCE_KEYS.has(key)) {
      await auditMutation(session, "创建数据", key, getRowId(created), "管理端创建记录");
    }
    const response = redactRow(key, created, session);
    if (key === "afterSales" && response && typeof response === "object") response.order = redactRow("orders", linkedOrder, session);
    return json(res, 201, response);
  }
  async function docRoute(req, res, parts, session, pathname) {
    const key = decodePart(parts[1]); const id = decodePart(parts[2]);
    if (!DOCUMENT_KEYS.has(key) || !id) { const e = new Error("文档参数无效"); e.code = "DATA_KEY_INVALID"; throw e; }
    if (key === "financeSettings" && id !== "global") return json(res, 404, { error: "财务参数文档不存在" });
    if (req.method === "GET") {
      if (!canReadKey(session, key)) return forbidden(res, session, pathname);
      let value = await readConfigDocument(key, id);
      if (!value && key === "siteConfig" && id === "global") value = await source.get(key, "homeStats");
      return json(res, 200, redactRow(key, value, session));
    }
    if (req.method !== "PUT") return json(res, 405, { error: "方法不支持" });
    if (!canWriteKey(session, key)) return forbidden(res, session, pathname);
    const body = await readBody(req); if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "请求体无效" });
    const previousDocument = await readConfigDocument(key, id);
    if (key === "siteConfig" && normalizeRole(session.role) === "content" && containsConfigSensitive(body)) return forbidden(res, session, pathname, "内容运营不能修改集成凭据");
    let previousFinanceSettings = null;
    if (key === "financeSettings") {
      const role = normalizeRole(session.role);
      if (! ["super", "finance"].includes(role)) return forbidden(res, session, pathname, "当前角色不能修改财务参数");
      const allowed = new Set(["settlementObservationDays", "largeSettlementThreshold"]);
      if (Object.keys(body).some((field) => !allowed.has(field))) return forbidden(res, session, pathname, "财务参数字段无效");
      previousFinanceSettings = await readConfigDocument(key, id) || FINANCE_DEFAULTS;
      const current = previousFinanceSettings;
      Object.assign(body, { ...FINANCE_DEFAULTS, ...current, ...body });
      const days = Number(body.settlementObservationDays);
      const threshold = Number(body.largeSettlementThreshold);
      if (!Number.isInteger(days) || days < 1 || days > 15 || !Number.isFinite(threshold) || threshold < 0 || threshold > 100000000) return json(res, 400, { error: "财务参数范围无效" });
      body.settlementObservationDays = days;
      body.largeSettlementThreshold = Math.round(threshold * 100) / 100;
    }
    const saved = await source.upsert(key, id, body);
    if (key === "financeSettings" && !(await auditMutation(session, "更新财务参数", key, id, "服务端财务参数变更"))) {
       try { await restoreChangedFields(source, key, id, previousFinanceSettings || FINANCE_DEFAULTS, Object.keys(body)); } catch (_) {}
      return json(res, 503, { error: "财务参数已回滚，审计日志暂不可用，请稍后重试" });
    }
    if (key !== "financeSettings" && !(await auditMutation(session, "更新配置文档", key, id, "服务端配置文档变更"))) {
      try {
        if (previousDocument) await restoreChangedFields(source, key, id, previousDocument, Object.keys(body));
        else await source.remove(key, id);
      } catch (_) {}
      return json(res, 503, { error: "配置文档已回滚，审计日志暂不可用，请稍后重试" });
    }
    return json(res, 200, redactRow(key, saved, session));
  }

  async function orderActionRoute(req, res, parts, session, pathname) {
    if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
    const orderId = decodePart(parts[1]);
    if (!orderId) return json(res, 400, { error: "缺少订单 id" });
    const current = await source.get("orders", orderId);
    if (!current) return json(res, 404, { error: "订单不存在" });
    if (!(await filterRows(source, session, "orders", [current])).length) return forbidden(res, session, pathname, "当前角色不能操作该订单");
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "请求体无效" });
    const action = String(body.action || "").trim().toLowerCase();
    if ((current.isDeleted || current.deleted) && action !== "restore") return json(res, 404, { error: "订单不存在" });
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
      restore: ["super"],
      note: ["super", "service"],
      update: ["super", "service", "finance", "photo"],
    };
    if (!actionRoles[action] || !actionRoles[action].includes(role)) return forbidden(res, session, pathname, "当前角色不能执行该订单操作");
    const actionPermission = role === "super" ? "*" : ["photo"].includes(role) ? "shootUpdate" : ["finance"].includes(role) ? "financeReview" : "orderEdit";
    if (actionPermission !== "*" && !hasAction(session, actionPermission)) return forbidden(res, session, pathname, "当前账号未授予该订单操作权限");

    if (["accept", "assign", "unassign", "reschedule", "start", "deliver", "complete", "cancel"].includes(action)) {
      let activeTickets;
      try {
        activeTickets = (await source.list("afterSales")).filter((ticket) => ticket && String(ticket.orderId || "") === String(orderId) && !isAfterSaleTerminalStatus(ticket.status));
      } catch (_) {
        return json(res, 503, { error: "售后数据暂不可用，无法安全推进订单" });
      }
      if (activeTickets.length) return json(res, 409, { error: "订单存在处理中售后，暂不能推进该操作" });
    }

    const now = new Date().toISOString();
    const beforeStatus = String(current.status || "new");
    const patch = {};
    let label = "";
    const reason = String(body.reason || body.note || "").trim();
    const requireReason = ["accept", "assign", "unassign", "reschedule", "start", "deliver", "complete", "cancel", "restore", "note", "update"].includes(action);
    if (requireReason && reason.length < 2) return json(res, 400, { error: "请填写操作原因" });
    const canTransition = (allowedFrom, next) => {
      if (!allowedFrom.includes(beforeStatus)) return false;
      if (beforeStatus === next) return true;
      patch.status = next;
      patch.customerStatus = next === "confirmed" ? "confirmed" : next === "shooting" ? "shooting" : next === "delivered" || next === "completed" ? "done" : next === "cancelled" ? "已取消" : current.customerStatus;
      return true;
    };
    if (action === "restore") {
      if (!current.isDeleted && !current.deleted) return json(res, 409, { error: "订单当前未在回收站" });
      patch.status = "new";
      patch.customerStatus = "预约待确认";
      patch.isDeleted = false;
      patch.deleted = false;
      label = "恢复订单";
    } else if (action === "accept") {
      if (!canTransition(["new", "pending"], "confirmed")) return json(res, 409, { error: "订单当前状态不能接单" });
      if (role === "service" && !current.assigneeId) patch.assigneeId = session.subjectId;
      label = "客服接单";
    } else if (action === "assign") {
      const photographerId = String(body.photographerId || "").trim();
      if (!photographerId) return json(res, 400, { error: "请选择摄影师" });
      const staffRows = await source.list("staff");
      const photographer = (Array.isArray(staffRows) ? staffRows : []).find((staff) =>
        staff && String(staff.id || staff._id) === photographerId && normalizeRole(staff.role) === "photo" && isActiveStatusForScope(staff)
      );
      if (!photographer) return json(res, 400, { error: "摄影师账号不存在或已停用" });
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
      if (!canTransition(["shooting", "retouching", "editing"], "delivered")) return json(res, 409, { error: "订单当前状态不能标记交付" });
      if (Number(current.finalPaid || 0) > 0 && !financeApproved(current.finalFinanceStatus)) return json(res, 409, { error: "尾款尚未完成财务审核，不能标记交付" });
      patch.deliveryNote = reason;
      label = "标记成片交付";
    } else if (action === "complete") {
      if (!canTransition(["delivered", "shooting", "editing", "final_pending"], "completed")) return json(res, 409, { error: "订单当前状态不能完成" });
      if (Number(current.depositPaid || 0) > 0 && !financeApproved(current.depositFinanceStatus)) return json(res, 409, { error: "定金尚未完成财务审核，不能完成订单" });
      if (Number(current.finalPaid || 0) > 0 && !financeApproved(current.finalFinanceStatus)) return json(res, 409, { error: "尾款尚未完成财务审核，不能完成订单" });
      patch.completedAt = now;
      label = "完成订单";
    } else if (action === "cancel") {
      if (isOrderCompletedStatus(beforeStatus) || isOrderCancelledStatus(beforeStatus)) return json(res, 409, { error: "订单当前状态不能取消" });
      try {
        const activeTickets = (await source.list("afterSales")).filter((ticket) => ticket && String(ticket.orderId || "") === String(orderId) && !isAfterSaleTerminalStatus(ticket.status));
        if (activeTickets.length) return json(res, 409, { error: "订单存在处理中售后，不能取消" });
      } catch (_) { return json(res, 503, { error: "售后数据暂不可用，无法安全取消订单" }); }
      patch.status = "cancelled";
      patch.customerStatus = "已取消";
      patch.isDeleted = true;
      patch.deleted = true;
      label = "取消订单";
    } else if (action === "note") {
      patch.internalNote = [current.internalNote, reason].filter(Boolean).join("\n");
      label = "补充订单备注";
    } else if (action === "update") {
      const requested = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : {};
      if (Object.keys(requested).some((field) => IMMUTABLE_ORDER_FIELDS.has(field))) return json(res, 400, { error: "订单标识字段不可修改" });
      const allowed = role === "super" ? new Set([...ORDER_SERVICE_FIELDS, ...ORDER_WORKFLOW_FIELDS]) : (ORDER_UPDATE_FIELDS[role] || new Set());
      const rejected = Object.keys(requested).filter((key) => !allowed.has(key));
      if (rejected.length) return forbidden(res, session, pathname, "当前角色不能直接更新订单流程字段，请使用专用操作");
      if (role === "service" && Object.keys(requested).some((field) => ORDER_SERVICE_LOCKED_FIELDS.has(field))) {
        let activeTickets = [];
        try {
          activeTickets = (await source.list("afterSales")).filter((ticket) => ticket
            && String(ticket.orderId || "") === String(orderId)
            && !isAfterSaleTerminalStatus(ticket.status));
        } catch (_) { return json(res, 503, { error: "售后数据暂不可用，无法安全修改订单" }); }
        if (activeTickets.length) return json(res, 409, { error: "订单存在处理中售后，暂不能修改履约或金额字段" });
        if (isOrderCompletedStatus(beforeStatus) || isOrderCancelledStatus(beforeStatus) || beforeStatus === "deleted") {
          return json(res, 409, { error: "已完成或已取消订单不能修改履约或金额字段" });
        }
      }
      for (const [key, value] of Object.entries(requested)) patch[key] = value;
      if (role !== "super") {
        if (Object.prototype.hasOwnProperty.call(requested, "status") && String(requested.status) !== beforeStatus) return json(res, 409, { error: "订单状态必须通过专用操作接口变更" });
        if (Object.prototype.hasOwnProperty.call(requested, "customerStatus") && String(requested.customerStatus) !== String(current.customerStatus || "")) return json(res, 409, { error: "客人状态必须由订单流程自动计算" });
        const total = Number(Object.prototype.hasOwnProperty.call(requested, "totalAmount")
          ? requested.totalAmount
          : (current.totalAmount || current.totalPrice || current.price || 0));
        const discount = Number(Object.prototype.hasOwnProperty.call(requested, "finalDiscountAmount")
          ? requested.finalDiscountAmount
          : (current.finalDiscountAmount || 0));
        if (!Number.isFinite(total) || total < 0 || !Number.isFinite(discount) || discount < 0 || discount > total) return json(res, 400, { error: "订单金额或优惠金额无效" });
        for (const field of ["depositPaid", "finalPaid"]) {
          if (Object.prototype.hasOwnProperty.call(requested, field)) {
            const amount = Number(requested[field]);
            if (!Number.isFinite(amount) || amount < 0 || (total > 0 && amount > total)) return json(res, 400, { error: "收款金额无效" });
          }
        }
        const proposedDeposit = Object.prototype.hasOwnProperty.call(requested, "depositPaid") ? Number(requested.depositPaid) : Number(current.depositPaid || 0);
        const proposedFinal = Object.prototype.hasOwnProperty.call(requested, "finalPaid") ? Number(requested.finalPaid) : Number(current.finalPaid || 0);
        if (proposedDeposit + proposedFinal > Math.max(total - discount, 0)) return json(res, 409, { error: "定金和尾款合计不能超过订单应收" });
        if (["appointmentAt", "time", "timePeriod", "timeSlot"].some((field) => Object.prototype.hasOwnProperty.call(requested, field))
          && !["new", "pending", "contacted", "deposit_pending", "deposit_paid", "confirmed", "assigned", "shooting"].includes(beforeStatus)) {
          return json(res, 409, { error: "当前订单状态不能修改拍摄时间" });
        }
        if (role === "service" && (isOrderCompletedStatus(beforeStatus) || isOrderCancelledStatus(beforeStatus) || beforeStatus === "deleted")
          && ["totalAmount", "finalDiscountAmount", "finalDiscountReason", "priceAdjustReason", "depositPaid", "finalPaid", "depositPaidAt", "finalPaidAt", "depositFinanceStatus", "finalFinanceStatus"].some((field) => Object.prototype.hasOwnProperty.call(requested, field))) {
          return json(res, 409, { error: "已完成或已取消订单不能再调整金额" });
        }
        for (const field of ["depositFinanceStatus", "finalFinanceStatus"]) {
          if (Object.prototype.hasOwnProperty.call(requested, field)) {
            const value = normalizeFinanceStatus(requested[field]);
            if (role === "service" && value !== "待审") return forbidden(res, session, pathname, "客服只能登记为待财务审核");
            if (role === "finance" && !["待审", "已审", "已驳"].includes(value)) return json(res, 400, { error: "财务审核状态无效" });
            const amountField = field === "depositFinanceStatus" ? "depositPaid" : "finalPaid";
            if (["已审", "已驳"].includes(value) && Number(current[amountField] || 0) <= 0) return json(res, 409, { error: "没有对应收款，不能审核" });
            patch[field] = value;
            if (role === "finance") {
              patch.financeReviewedBy = session.account;
              patch.financeReviewedAt = now;
            }
          }
        }
        if (role === "service") {
          if (Object.prototype.hasOwnProperty.call(requested, "depositPaid")) {
            patch.depositFinanceStatus = "待审";
            patch.depositPaidAt = now;
          }
          if (Object.prototype.hasOwnProperty.call(requested, "finalPaid")) {
            patch.finalFinanceStatus = "待审";
            patch.finalPaidAt = now;
          }
        }
        if (role === "finance" && Object.prototype.hasOwnProperty.call(requested, "finalFinanceStatus")
          && normalizeFinanceStatus(requested.finalFinanceStatus) === "已驳" && isOrderCompletedStatus(beforeStatus)) {
          patch.status = "shooting";
          patch.customerStatus = "shooting";
        }
        if (Object.prototype.hasOwnProperty.call(requested, "photographerId") && requested.photographerId) {
          const staffRows = await source.list("staff");
          const valid = (Array.isArray(staffRows) ? staffRows : []).some((staff) => staff
            && String(staff.id || staff._id) === String(requested.photographerId)
            && normalizeRole(staff.role) === "photo" && isActiveStatusForScope(staff));
          if (!valid) return json(res, 409, { error: "摄影师账号不存在或已停用" });
        }
        if (Object.prototype.hasOwnProperty.call(requested, "assigneeId") && requested.assigneeId) {
          const staffRows = await source.list("staff");
          const valid = (Array.isArray(staffRows) ? staffRows : []).some((staff) => staff
            && String(staff.id || staff._id) === String(requested.assigneeId)
            && normalizeRole(staff.role) === "service" && isActiveStatusForScope(staff));
          if (!valid) return json(res, 409, { error: "客服账号不存在或已停用" });
        }
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "没有可更新的订单字段" });
      label = "更新订单信息";
    }
    const timeline = { type: "后台订单操作", action: `${label}${reason ? `：${reason}` : ""}`, operator: session.account, operatorId: session.subjectId, from: beforeStatus, to: patch.status || beforeStatus, createTime: now };
    patch.statusLogs = [...(Array.isArray(current.statusLogs) ? current.statusLogs : []), timeline];
    patch.followRecords = [...(Array.isArray(current.followRecords) ? current.followRecords : []), timeline];
    patch.updateTime = now;
    const updated = await source.update("orders", orderId, patch);
    if (!updated) return json(res, 404, { error: "订单不存在" });
    try {
      await source.create("logs", { action: label, operator: session.account, operatorId: session.subjectId, targetType: "order", targetId: orderId, detail: reason || `${beforeStatus} -> ${updated.status}`, createTime: now });
    } catch (_) {
      try { await restoreChangedFields(source, "orders", orderId, current, Object.keys(patch)); } catch (__) {}
      return json(res, 503, { error: "订单已回滚，审计日志暂不可用，请稍后重试" });
    }
    if (action === "cancel") {
      try {
        await source.create("trash", { id: `trash_${orderId}_${Date.now()}`, refId: orderId, type: "订单", name: updated.orderNo || orderId, reason, operator: session.account, time: now, restorable: true });
      } catch (_) {
        try { await restoreChangedFields(source, "orders", orderId, current, Object.keys(patch)); } catch (__) {}
        return json(res, 503, { error: "订单已回滚，回收站记录保存失败，请稍后重试" });
      }
    }
    return json(res, 200, { ok: true, auditRecorded: true, data: redactRow("orders", updated, session) });
  }
  async function afterSaleActionRoute(req, res, parts, session, pathname) {
    if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
    const ticketId = decodePart(parts[1]);
    if (!ticketId) return json(res, 400, { error: "缺少售后工单 id" });
    const current = await source.get("afterSales", ticketId);
    if (!current) return json(res, 404, { error: "售后工单不存在" });
    const orderId = String(current.orderId || "");
    const order = orderId ? await source.get("orders", orderId) : null;
    if (!order || order.isDeleted || order.deleted) return json(res, 404, { error: "关联订单不存在" });
    if (!(await filterRows(source, session, "orders", [order])).length) return forbidden(res, session, pathname, "当前角色不能处理该售后工单");
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "请求体无效" });
    const action = String(body.action || "").trim().toLowerCase();
    if ((current.isDeleted || current.deleted) && action !== "restore") return json(res, 404, { error: "订单不存在" });
    const role = normalizeRole(session.role);
    if (!["open", "follow", "complete", "review"].includes(action)) return json(res, 400, { error: "售后操作无效" });
    if (action === "review" ? !["super", "finance"].includes(role) : !["super", "service"].includes(role)) {
      return forbidden(res, session, pathname, "当前角色不能执行该售后操作");
    }
    const reason = String(body.reason || body.note || "").trim();
    if (reason.length < 2) return json(res, 400, { error: "请填写售后处理说明" });
    if (isAfterSaleTerminalStatus(current.status) && action !== "review") return json(res, 409, { error: "该售后已结案，不能重复处理" });
    const now = new Date().toISOString();
    const patch = { updatedAt: now };
    let orderAfterSaleStatus = current.status || "处理";
    if (action === "review") {
      const decisionStatus = normalizeFinanceStatus(body.status);
      const hasDecision = typeof body.approved === "boolean" || ["已审", "已驳"].includes(decisionStatus);
      if (!hasDecision) return json(res, 400, { error: "请明确选择通过或驳回" });
      const approved = body.approved === true || decisionStatus === "已审";
      const currentFinanceStatus = normalizeFinanceStatus(current.financeStatus || "待审");
      if (role === "finance" && currentFinanceStatus !== "待审") return json(res, 409, { error: "该售后已审核，不能重复处理" });
      if (!["待审", "已审", "已驳"].includes(currentFinanceStatus)) return json(res, 409, { error: "该售后当前不在财务审核队列" });
      patch.financeStatus = approved ? "已审" : "已驳";
      patch.financeReviewedBy = session.account;
      patch.financeReviewedAt = now;
      patch.status = approved ? "已完" : "处理";
      patch.customerVisibleStatus = approved ? "已完" : "处理";
      orderAfterSaleStatus = patch.status;
    } else if (action === "open") {
      patch.status = current.status || "待处";
      patch.customerVisibleStatus = current.customerVisibleStatus || "已提";
      orderAfterSaleStatus = "pending";
    } else {
      const refundAmount = Number(body.refundAmount || 0);
      if (!Number.isFinite(refundAmount) || refundAmount < 0) return json(res, 400, { error: "退款金额无效" });
      if (refundAmount > 0) {
        const paidAmount = Number(order.depositPaid || 0) + Number(order.finalPaid || 0);
        const totalAmount = Number(order.totalAmount || order.totalPrice || order.price || 0);
        const refundableLimit = paidAmount > 0 ? paidAmount : totalAmount;
        if (refundAmount > refundableLimit) return json(res, 409, { error: "退款金额不能超过订单可退金额" });
        if (body.refundConfirmed !== true) return json(res, 400, { error: "请先确认退款金额" });
        patch.refundAmount = refundAmount;
        patch.refundConfirmed = true;
        patch.financeStatus = "待审";
        patch.status = "待财务审";
        patch.customerVisibleStatus = "处理";
        orderAfterSaleStatus = "待财务审";
      } else if (action === "complete") {
        if (normalizeFinanceStatus(current.financeStatus) === "待审") return json(res, 409, { error: "退款待财务审核，不能直接结案" });
        patch.refundAmount = 0;
        patch.refundConfirmed = true;
        patch.financeStatus = current.financeStatus || "无需财务审核";
        patch.status = "已完";
        patch.customerVisibleStatus = "已完";
        orderAfterSaleStatus = "已完";
      } else {
        patch.status = "处理";
        patch.customerVisibleStatus = "处理";
        orderAfterSaleStatus = "处理";
      }
    }
    const logLine = `${session.account} ${action === "review" ? "财务审核" : action === "complete" ? "处理完成" : "跟进"}：${reason}`;
    patch.logs = [logLine, ...(Array.isArray(current.logs) ? current.logs : [])].slice(0, 100);
    let updatedTicket;
    let updatedOrder;
    let orderPatch;
    try {
      updatedTicket = await source.update("afterSales", ticketId, patch);
      if (!updatedTicket) throw new Error("售后工单已不存在");
      orderPatch = {
        afterSaleStatus: orderAfterSaleStatus,
        afterSaleId: ticketId,
        followRecords: [...(Array.isArray(order.followRecords) ? order.followRecords : []), {
          type: "afterSale", status: orderAfterSaleStatus, reason, operator: session.account, operatorId: session.subjectId, createTime: now
        }],
        statusLogs: [...(Array.isArray(order.statusLogs) ? order.statusLogs : []), {
          type: "售后处理", action: logLine, operator: session.account, operatorId: session.subjectId, from: order.status, to: order.status, createTime: now
        }],
        updateTime: now,
      };
      updatedOrder = await source.update("orders", orderId, orderPatch);
      if (!updatedOrder) throw new Error("关联订单保存失败");
    } catch (error) {
      try { if (updatedTicket) await restoreChangedFields(source, "afterSales", ticketId, current, Object.keys(patch)); } catch (_) {}
      try { if (updatedOrder && orderPatch) await restoreChangedFields(source, "orders", orderId, order, Object.keys(orderPatch)); } catch (_) {}
      return json(res, 503, { error: "售后已回滚，关联订单保存失败，请稍后重试" });
    }
    try {
      await source.create("logs", { action: `售后${action}`, operator: session.account, operatorId: session.subjectId, targetType: "afterSale", targetId: ticketId, detail: reason, createTime: now });
    } catch (_) {
      try { await restoreChangedFields(source, "afterSales", ticketId, current, Object.keys(patch)); } catch (__) {}
      try { if (orderPatch) await restoreChangedFields(source, "orders", orderId, order, Object.keys(orderPatch)); } catch (__) {}
      return json(res, 503, { error: "售后已回滚，审计日志暂不可用，请稍后重试" });
    }
    const safeTicket = redactRow("afterSales", updatedTicket, session);
    return json(res, 200, { ok: true, data: {
      ...safeTicket,
      ticketId: ticketId,
      ticket: safeTicket,
      order: redactRow("orders", updatedOrder, session),
    } });
  }
  async function merchantRoute(req, res, parsed, session, pathname) {
    const role = normalizeRole(session.role);
    if (!hasAction(session, "view") || !["super", "merchant", "distributor", "agent"].includes(role)) return forbidden(res, session, pathname);
    const requested = String(parsed.query.shopId || ""); let shopId = requested;
    if (role === "merchant") {
      const own = [session.shopId, session.shopCode].filter(Boolean).map(String);
      let ownedShop = null;
      if (requested && !own.includes(requested)) {
        try {
          const candidates = await source.list("shops");
          ownedShop = (Array.isArray(candidates) ? candidates : []).find((item) => shopMatches(item, session) && shopMatches(item, { shopId: requested, shopCode: requested }));
        } catch (_) {}
        if (!ownedShop) return forbidden(res, session, pathname, "不能访问其他商家数据");
      }
      // Merchant-code documents historically store the external shopCode while
      // order rows use the internal shop id. Resolve both forms before querying.
      try {
        const shops = await source.list("shops");
        const row = ownedShop || (Array.isArray(shops) ? shops : []).find((item) => shopMatches(item, session));
        shopId = (row && (row.shopId || row.id || row._id)) || session.shopCode || session.shopId || "";
      } catch (_) { shopId = session.shopCode || session.shopId || ""; }
    }
    if (["distributor", "agent"].includes(role)) {
      let shops = [];
      try { shops = await source.list("shops"); } catch (_) { return json(res, 503, { error: "商家数据暂不可用" }); }
      const subjectIds = new Set([
        role === "distributor" ? session.distributorId : session.agentId,
        session.subjectId,
      ].filter(Boolean).map(String));
      const owned = (Array.isArray(shops) ? shops : []).filter((shop) => {
        if (!isActiveStatusForScope(shop)) return false;
        if (role === "distributor") {
          return subjectIds.has(String(shop.distributorId || ""))
            || (Array.isArray(shop.distributorIds) && shop.distributorIds.map(String).some((id) => subjectIds.has(id)));
        }
        return subjectIds.has(String(shop.agentId || ""))
          || (Array.isArray(shop.agentIds) && shop.agentIds.map(String).some((id) => subjectIds.has(id)));
      });
      const ownedIds = new Set(owned.flatMap((shop) => [shop.id, shop._id, shop.shopId].filter(Boolean).map(String)));
      if (requested && !ownedIds.has(requested)) return forbidden(res, session, pathname, "不能访问未授权商家数据");
      if (!requested) {
        if (owned.length !== 1) return forbidden(res, session, pathname, "请指定授权商家");
        shopId = String(owned[0].shopId || owned[0].id || owned[0]._id || "");
      }
    }
    if (role !== "super" && !shopId) return forbidden(res, session, pathname, "请指定授权商家");
    if (pathname.includes("/generate")) {
      if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
      if (!(role === "super" || role === "merchant") || !hasAction(session, "shopEdit")) return forbidden(res, session, pathname, "当前角色无权生成商家码");
      const body = await readBody(req); const target = String(body.shopId || shopId || "");
      if (role === "merchant" && !shopMatches({ shopId: target }, session) && !shopMatches({ id: target }, session)) return forbidden(res, session, pathname, "不能为其他商家生成二维码");
      return json(res, 200, await source.generateMerchantCode({ ...body, shopId: target }));
    }
    if (pathname.endsWith("/stats")) return json(res, 200, await source.merchantCodeStats(shopId));
    return json(res, 200, await source.listMerchantCodes(shopId));
  }
  async function validateContentTrashPost(body) {
    const allowed = new Set(["cities", "spots", "series", "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary"]);
    const sourceKey = String(body && body.sourceKey || "");
    const sourceDocument = body && body.source && typeof body.source === "object" && !Array.isArray(body.source) ? body.source : null;
    const sourceId = String(sourceDocument && (sourceDocument.id || sourceDocument._id) || body && (body.sourceId || body.refId) || "");
    if (!allowed.has(sourceKey) || !sourceId || !sourceDocument) return { error: "回收站源记录无效", status: 400 };
    const current = await source.get(sourceKey, sourceId).catch(() => null);
    if (!current || !(current.deleted === true || current.isDeleted === true)) return { error: "源记录尚未软删除", status: 409 };
    return { sourceKey, sourceId, current };
  }
  return async function handle(req, res, pathname) {
    const rid = crypto.randomBytes(8).toString("hex"); res.setHeader("X-Request-Id", rid); setHeaders(req, res);
    let parsed;
    try {
      const parsedUrl = new URL(req.url || pathname || "/", `http://${req.headers && req.headers.host || "localhost"}`);
      parsed = { pathname: parsedUrl.pathname, query: Object.fromEntries(parsedUrl.searchParams.entries()) };
    } catch (_) {
      parsed = { pathname: pathname || "/", query: {} };
    }
    const parts = parsed.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
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
          name: session.name || session.account,
          role: session.role,
          roleName: session.roleName || session.role,
          roleId: session.roleId || "",
          staffId: session.subjectId,
          shopId: session.shopId || "",
          distributorId: session.distributorId || "",
          agentId: session.agentId || "",
          permissions: Array.isArray(session.permissions) ? session.permissions : [],
          permissionKeys: Array.isArray(session.permissionKeys) ? session.permissionKeys : (Array.isArray(session.permissions) ? session.permissions : []),
          actions: dynamicActionKeys(Array.isArray(session.permissionKeys) ? session.permissionKeys : session.permissions),
          menus: Array.isArray(session.menuKeys) ? session.menuKeys : [],
          menuKeys: Array.isArray(session.menuKeys) ? session.menuKeys : [],
          menuDefinitions: Array.isArray(session.menuDefinitions) ? session.menuDefinitions : [],
          permissionsConfigured: session.permissionsConfigured === true,
          permissionSource: session.permissionSource || "",
          expiresAt: session.expiresAt,
        });
      }
      if (parts[0] === "auth" && parts[1] === "change-password") {
        const session = await requireSession(req, res, "/api/auth/change-password", "admin"); if (!session) return;
        if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
        const body = await readBody(req); const oldPassword = String(body.oldPassword || ""); const newPassword = String(body.newPassword || "");
        if (!oldPassword || !newPassword) return json(res, 400, { ok: false, error: "请完整填写原密码和新密码" });
        const strength = validatePasswordStrength(newPassword); if (!strength.ok || newPassword === oldPassword) return json(res, 400, { ok: false, error: strength.ok ? "新密码不能与原密码相同" : strength.reason });
        const key = session.subjectType === "merchant" ? "shops" : session.subjectType === "distributor" ? "distributors" : session.subjectType === "agent" ? "agents" : "staff";
        if (permissionStore && permissionStore.required && session.authzUserId) {
          const authenticated = await permissionStore.authenticate(session.account, oldPassword);
          if (!authenticated) return json(res, 401, { ok: false, error: "原密码不正确" });
          await permissionStore.updateUser(session.authzUserId, { password: newPassword });
          // The MySQL business projection intentionally has no credential
          // field; the normalized auth table is the sole password authority.
        } else {
          const current = await source.get(key, session.subjectId);
          if (!current || !verifyPassword(current.password, oldPassword)) return json(res, 401, { ok: false, error: "原密码不正确" });
          await source.update(key, session.subjectId, { password: hashPassword(newPassword) });
        }
        try { await source.create("logs", { action: "修改密码", operator: session.account, operatorId: session.subjectId, targetType: key, targetId: session.subjectId, detail: "账号本人修改登录密码", createTime: new Date().toISOString() }); } catch (_) {}
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
        if (name === "getDashboard") return json(res, 200, await scopedDashboard(session));
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
        return await orderActionRoute(req, res, parts, session, `/api/${parts.join("/")}`);
      }
      if (parts[0] === "after-sales" && parts[1] && parts[2] === "action") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin");
        if (!session) return;
        return await afterSaleActionRoute(req, res, parts, session, `/api/${parts.join("/")}`);
      }
      if (parts[0] === "dashboard" || (parts[0] === "orders" && parts[1] === "stats") || parts[0] === "home") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin"); if (!session) return;
        if (parts[0] === "dashboard" || parts[0] === "orders") {
          if (!hasAction(session, "dashboard")) return forbidden(res, session, `/api/${parts.join("/")}`);
          const aggregate = await scopedDashboard(session);
          if (parts[0] === "dashboard") return json(res, 200, aggregate);
          return json(res, 200, aggregate.byStatus);
        }
        if (!hasAction(session, "dashboard")) return forbidden(res, session, `/api/${parts.join("/")}`);
        return json(res, 200, await scopedHome(session));
      }
      if (parts[0] === "merchant-code" || parts[0] === "merchant-codes") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin"); if (!session) return;
        return await merchantRoute(req, res, parsed, session, `/api/${parts.join("/")}`);
      }
      if (parts[0] === "permissions" || parts[0] === "permission") {
        const session = await requireSession(req, res, `/api/${parts.join("/")}`, "admin"); if (!session) return;
        return await permissionRoute(req, res, parts, session, `/api/${parts.join("/")}`);
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
