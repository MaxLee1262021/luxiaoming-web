// 自托管 RPC：完整复刻原小程序云函数（getHomeData / getSpots / createBooking / ...）。
// 小程序端把 wx.cloud.callFunction({name,data}) 改为 wx.request POST /api/rpc/{name}，
// 请求体形如 { data: {...} }（也兼容直接传 {...}），这里用自托管数据源实现原函数逻辑。
// 集合映射：云开发 travel_photos -> samples，bookings -> orders，config/homeStats -> homeConfig/homeStats。
// openid：云函数用 cloud.getWXContext().OPENID；自托管由 login 接口下发，小程序每次请求注入 data.openid。
const crypto = require("crypto");
const https = require("https");
const {
  WORKFLOW_STAGES,
  roundMoney,
  normalizeRatio,
  depositDue,
  finalDue,
  hasConfirmedPayment,
  isServiceConfirmed,
  hasDeliveryRecord,
  hasActiveAfterSale,
  customerCancellation,
  normalizePaymentStatus,
  canonicalStage,
  publicOrderProjection,
  makePaymentId,
  withOrderMutex,
  privateFileId,
  privateFileIds,
} = require("./orderWorkflow.cjs");

function isDataSourceFailure(error) {
  return !!(error && (["DATA_SOURCE_UNAVAILABLE", "DATA_SOURCE_CONFIG_INVALID", "DATA_SOURCE_INVALID"].includes(error.code)
    || /^(?:ER_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EACCES|EROFS|ENOSPC)/i.test(String(error.code || ""))));
}
function publicRpcError(error, fallback = "请求失败") {
  if (isDataSourceFailure(error)) return "数据服务暂不可用，请稍后重试";
  const message = String(error && error.message || "").trim();
  // Do not expose SQL statements, filesystem paths, SDK request ids, or
  // connection details through an anonymous RPC response.
  if (!message || /(?:select\s|insert\s|update\s|delete\s|table\s|column\s|[A-Za-z]:\\|\/var\/|\/srv\/|redis|mysql|socket|request[_ -]?id)/i.test(message)) return fallback;
  return message.slice(0, 160);
}
const AFTER_SALE_TERMINAL_STATUSES = new Set(["completed", "closed", "done", "已完", "已完成", "已结案", "已结束"]);
function isAfterSaleTerminalStatus(value) {
  return AFTER_SALE_TERMINAL_STATUSES.has(String(value || "").trim().toLowerCase());
}
function relatedAfterSaleTickets(order = {}, tickets = []) {
  const merged = [];
  const seen = new Set();
  for (const ticket of [...(Array.isArray(tickets) ? tickets : []), ...(Array.isArray(order.afterSales) ? order.afterSales : [])]) {
    if (!ticket || typeof ticket !== "object") continue;
    const key = String(ticket.id || ticket._id || `inline_${merged.length}`);
    if (seen.has(key)) continue;
    seen.add(key); merged.push(ticket);
  }
  return merged;
}
function activeAfterSaleTicket(ticket) {
  return !!ticket && !isAfterSaleTerminalStatus(ticket.status);
}
function testPaymentEnabled() {
  return String(process.env.TEST_PAYMENT_ENABLED || "").trim().toLowerCase() === "true"
    || String(process.env.PAYMENT_MODE || "").trim().toLowerCase() === "test";
}
async function restoreOrderSnapshot(source, id, original) {
  if (!source || !id || !original) return null;
  if (typeof source.replace === "function") {
    const replaced = await source.replace("orders", id, original);
    if (replaced) return replaced;
  }
  return source.update("orders", id, original);
}

module.exports = async function rpc(source, name, body = {}, ctx = {}) {
  const data = body.data || body; // 兼容 {data:{...}} 与直接传 {...}
  const identity = ctx.identity || null;
  // openid is trusted only when it was resolved by the API layer from a
  // verified public session. A caller-supplied body.openid is never used.
  const openid = identity && identity.kind === "public" ? String(identity.openid || "") : "";
  const withIdentity = (value = data) => ({ ...(value || {}), openid });
  switch (name) {
    case "login": return await rpcLogin(source, data, ctx);
    case "bindPhone":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcBindPhone(source, withIdentity(), ctx);
    case "getMyProfile":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcGetMyProfile(source, openid, ctx);
    case "updateMyProfile":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcUpdateMyProfile(source, openid, data, ctx);
    case "getMyAfterSales":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcGetMyAfterSales(source, openid, data, ctx);
    case "getHomeData": return await rpcGetHomeData(source, data);
    case "getDashboard": return await source.dashboard();
    case "getOrderStatusCount":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcOrderStatusCount(source, openid);
    case "getSpots": return await rpcGetSpots(source, data);
    case "getBookingData": return await rpcGetBookingData(source);
    case "getSeriesList": return await rpcGetSeriesList(source, data);
    case "getSeriesDetail": return await rpcGetSeriesDetail(source, data);
    case "getPhotoCollection": return await rpcGetPhotoCollection(source, data);
    case "getPeripherals": return await rpcGetPeripherals(source, data);
    case "getGuides":
    case "listGuides": return await rpcGetGuides(source, data);
    case "getGuide": return await rpcGetGuide(source, data);
    case "getMyOrders":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcGetMyOrders(source, openid, data, ctx);
    case "getOrderDetail":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcGetOrderDetail(source, openid, data, ctx);
    case "createPayment":
    case "createPaymentIntent":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcCreatePaymentIntent(source, openid, data);
    case "testPayment":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcTestPayment(source, openid, data);
    case "getPaymentStatus":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcGetPaymentStatus(source, openid, data);
    case "createBooking":
    case "createOrder": return await rpcCreateBooking(source, withIdentity(), ctx);
    case "updateOrderStatus":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcUpdateOrderStatus(source, openid, data);
    case "cancelOrder":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcCancelOrder(source, openid, data);
    case "submitAfterSale":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcSubmitAfterSale(source, openid, data, ctx);
    case "resolveMerchantCode": return await rpcResolveMerchantCode(source, data);
    case "generateMerchantQR": return await source.generateMerchantCode(data);
    case "getCities": return await rpcGetCities(source);
    case "getPrivacyPolicy": return await rpcGetPrivacyPolicy(source);
    case "getSearchConfig": return await rpcGetSearchConfig(source);
    case "getBookingConfig": return await rpcGetBookingConfig(source);
    case "getFootprintConfig": return await rpcGetFootprintConfig(source);
    case "getCorpConfig": return await rpcGetCorpConfig(source);
    case "getVideoSingles": return await rpcGetVideoSingles(source, data);
    default:
      return { success: false, message: "未知云函数: " + name };
  }
};

/* ============================ 共享工具 ============================ */
function getItemId(item = {}) { return item._id || item.id || ""; }
const ARRAY_RESTORE_FIELDS = new Set(["products", "productItems", "items", "addons", "statusLogs", "followRecords", "paymentRecords", "contactPhones", "extraWechats", "logs"]);
const BOOLEAN_RESTORE_FIELDS = new Set(["deleted", "isDeleted", "refundConfirmed", "riskBlocked", "frozen"]);
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

function pickConfiguredList(source = [], ids = [], limit = 8) {
  const list = Array.isArray(source) ? source : [];
  const configIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!configIds.length) return list.slice(0, limit);
  const picked = configIds.map(id => list.find(item => item && getItemId(item) === id)).filter(Boolean);
  const pickedIds = new Set(picked.map(getItemId));
  return [...picked, ...list.filter(item => item && !pickedIds.has(getItemId(item)))].slice(0, limit);
}

function normalizeStatus(value) { return String(value || "").trim().toLowerCase(); }

// 与云函数 getHomeData 一致的可见性判断（含审核态 + 增值服务排除）
function isPublicVisible(item) {
  if (!item || item.isDeleted === true || item.deleted === true || item.isShow === false || item.visible === false || item.enabled === false) return false;
  const hiddenStatuses = ["draft", "pending", "reviewing", "rejected", "offline", "disabled", "down", "草稿", "待审", "待审核", "驳回", "下架", "停用", "禁用", "已下架", "已下架商品"];
  const passAuditStatuses = ["approved", "pass", "passed", "published", "online", "已上", "已上架", "审核通过", "通过"];
  const status = normalizeStatus(item.status || item.saleStatus || item.shelfStatus);
  const statusRaw = String(item.status || item.saleStatus || item.shelfStatus || "").trim();
  const auditStatus = normalizeStatus(item.auditStatus || item.reviewStatus);
  if (status && hiddenStatuses.includes(status)) return false;
  if (statusRaw && hiddenStatuses.includes(statusRaw)) return false;
  if (auditStatus && !passAuditStatuses.includes(auditStatus)) return false;
  if (item.isValueAdded === true || item.isAddOn === true || item.productType === "addon" || item.serviceType === "addon") return false;
  return true;
}

// 列表型函数用的简化可见性判断（无增值服务排除，与 getSpots 等一致）
function isVisibleSimple(item) {
  if (!item || item.isDeleted === true || item.deleted === true || item.isShow === false || item.visible === false || item.enabled === false) return false;
  const badStatuses = ["draft", "pending", "reviewing", "rejected", "offline", "disabled", "down", "草稿", "待审", "待审核", "驳回", "下架", "停用", "禁用", "已下", "已下架", "已下架商品"];
  const passAuditStatuses = ["approved", "pass", "passed", "published", "online", "已上", "已上架", "审核通过", "通过"];
  const status = String(item.status || item.saleStatus || "").toLowerCase();
  const auditStatus = String(item.auditStatus || item.reviewStatus || "").toLowerCase();
  if (status && badStatuses.includes(status)) return false;
  if (auditStatus && !passAuditStatuses.includes(auditStatus)) return false;
  return true;
}

function identityValues(value) {
  if (value === undefined || value === null || value === "") return new Set();
  if (typeof value !== "object") return new Set([String(value)]);
  return new Set([
    value._id,
    value.id,
    value.cityId,
    value.cityCode,
    value.code,
    value.cityName,
    value.name,
    value.city
  ].filter((item) => item !== undefined && item !== null && String(item) !== "").map(String));
}

function spotCityValues(spot = {}) {
  return new Set([
    spot.cityId,
    spot.cityCode,
    spot.cityName,
    spot.city
  ].filter((item) => item !== undefined && item !== null && String(item) !== "").map(String));
}

function identitiesOverlap(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function isPublicCity(city) {
  return !!city && city.deleted !== true && city.isDeleted !== true && city.visible !== false;
}

function isEnabledCity(city = {}) {
  if (!isPublicCity(city)) return false;
  const status = String(city.status || "").trim().toLowerCase();
  // The admin city toggle writes status. A stale legacy enabled=true value
  // must never keep a city public after an operator moves it to preparation.
  if (["筹备中", "停用", "未开通", "disabled", "offline", "closed"].includes(status)) return false;
  return city.enabled !== false;
}

function cityForSpot(spot, cities = []) {
  const spotValues = spotCityValues(spot);
  if (!spotValues.size) return null;
  return cities.find((city) => identitiesOverlap(spotValues, identityValues(city))) || null;
}

function numberInRange(value, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizedCoordinates(item = {}) {
  const latitude = numberInRange(item.latitude, -90, 90);
  const longitude = numberInRange(item.longitude, -180, 180);
  if (latitude === null || longitude === null) {
    return { latitude: null, longitude: null, coordType: String(item.coordType || "gcj02").toLowerCase() };
  }
  const coordType = String(item.coordType || "gcj02").trim().toLowerCase();
  return {
    latitude,
    longitude,
    coordType: ["gcj02", "wgs84", "bd09"].includes(coordType) ? coordType : "gcj02"
  };
}

function toPublicSpotRow(spot = {}, city = null, seriesCount = 0) {
  const coordinates = normalizedCoordinates(spot);
  const cityId = city ? getItemId(city) : String(spot.cityId || "");
  return {
    _id: getItemId(spot),
    name: String(spot.name || ""),
    cityId,
    city: city ? String(city.name || spot.city || "") : String(spot.city || spot.cityName || ""),
    cityCode: city ? String(city.code || city.cityCode || "") : String(spot.cityCode || ""),
    district: String(spot.district || spot.area || ""),
    cover: spot.cover || spot.coverUrl || spot.image || "",
    coverUrl: spot.coverUrl || spot.cover || spot.image || "",
    description: spot.description || spot.desc || spot.intro || "",
    address: String(spot.address || ""),
    tags: normalizeSpotTags(spot),
    hotScore: Number(spot.hotScore || 0),
    visitCount: Number(firstNonEmpty(spot.visitCount, spot.checkinCount, spot.peopleCount, spot.scanCount, 0)),
    checkinCount: Number(firstNonEmpty(spot.checkinCount, spot.visitCount, spot.peopleCount, spot.scanCount, 0)),
    seriesCount: Number(seriesCount || 0),
    sort: Number(spot.sort || 0),
    shopId: String(spot.shopId || ""),
    ...coordinates
  };
}

function canonicalPublicItem(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const id = String(getItemId(item) || "");
  if (!id) return { ...item };
  return { ...item, id: item.id || id, _id: id };
}

// A product, guide, or series with no point binding is a global item. When it
// is bound to more than one point, only retain the points that the storefront
// can actually open. This keeps old id-only JSON rows compatible while
// preventing an unavailable city from leaking through a related product.
function seriesSpotScopeMap(rows = []) {
  const scopes = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const id = String(getItemId(row) || "");
    if (id) scopes.set(id, packageSpotIds(row));
  }
  return scopes;
}

function projectPublicSpotScope(item = {}, publicSpotIds = new Set(), options = {}) {
  const source = canonicalPublicItem(item);
  const directSpotIds = packageSpotIds(source);
  const scopes = options.seriesSpotScopes instanceof Map ? options.seriesSpotScopes : null;
  const inheritedSpotIds = !directSpotIds.length && source.seriesId && scopes
    ? (scopes.get(String(source.seriesId)) || [])
    : [];
  const spotIds = directSpotIds.length ? directSpotIds : inheritedSpotIds;
  if (!spotIds.length) return source;
  const allowed = spotIds.filter((id) => publicSpotIds.has(String(id)));
  if (!allowed.length) return null;

  const output = { ...source };
  const hasSpotIds = Array.isArray(source.spotIds);
  if (hasSpotIds || Object.prototype.hasOwnProperty.call(source, "spotIds") || inheritedSpotIds.length) output.spotIds = allowed;
  const currentSpotId = source.spotId === undefined || source.spotId === null || source.spotId === "" ? "" : String(source.spotId);
  if (currentSpotId) output.spotId = allowed.includes(currentSpotId) ? currentSpotId : allowed[0];
  else if (hasSpotIds || inheritedSpotIds.length) output.spotId = allowed[0];
  return output;
}

function projectPublicSpotScopedRows(rows, publicSpotIds, options = {}) {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => projectPublicSpotScope(item, publicSpotIds, options))
    .filter(Boolean);
}

async function listPublicSpots(source, filters = {}) {
  const [citiesRaw, spotsRaw, seriesRaw] = await Promise.all([
    source.list("cities"),
    source.list("spots"),
    source.list("series")
  ]);
  const configuredCities = (Array.isArray(citiesRaw) ? citiesRaw : [])
    .filter((city) => city && city.deleted !== true && city.isDeleted !== true);
  const cities = configuredCities.filter(isPublicCity);
  const series = (Array.isArray(seriesRaw) ? seriesRaw : []).filter(isVisibleSimple);
  const cityFilterValues = identityValues(filters.cityId || filters.city || "");
  // Older data sets predate city management. Preserve their existing point
  // display until an operator creates a public city configuration; once there
  // is such configuration, city visibility/status becomes authoritative.
  const hasCityConfiguration = configuredCities.length > 0;

  return (Array.isArray(spotsRaw) ? spotsRaw : [])
    .filter(isVisibleSimple)
    .map((spot) => {
      const city = cityForSpot(spot, cities);
      if (hasCityConfiguration && (!city || !isEnabledCity(city))) return null;
      const spotCityIdentity = city ? identityValues(city) : spotCityValues(spot);
      if (cityFilterValues.size && !identitiesOverlap(spotCityIdentity, cityFilterValues)) return null;
      const spotId = getItemId(spot);
      const seriesCount = series.filter((item) => packageSpotIds(item).includes(String(spotId))).length;
      return toPublicSpotRow(spot, city, seriesCount);
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.hotScore || 0) - Number(left.hotScore || 0)
      || Number(left.sort || 0) - Number(right.sort || 0)
      || String(left.name || "").localeCompare(String(right.name || ""), "zh-Hans-CN"));
}

// 历史 seed 的 modules 可能是「字符串数组」（如 ["主推套餐"]），映射到标准模块 key，
// 避免被 {...item} 展开成 {0:"主",1:"推",...} 的空对象导致首页板块渲染异常。
// 标准写入（admin saveHomeConfig 输出 homeModules 对象数组）路径不受影响。
const LEGACY_MODULE_LABEL_KEY = {
  "主推套餐": "hotPackages",
  "热门打卡点": "hotSpots",
  "照片单品": "bookingAlbums",
  "摄影周边": "peripherals",
  "攻略故事": "features"
};
function normalizeConfigModules(config = {}) {
  const modules = Array.isArray(config.homeModules) ? config.homeModules : (Array.isArray(config.modules) ? config.modules : []);
  return modules.map((item, index) => {
    if (typeof item === "string") {
      const key = LEGACY_MODULE_LABEL_KEY[item] || ("mod_" + (index + 1));
      return { key, title: item, subtitle: "", enabled: true, visible: true, sort: (index + 1) * 10 };
    }
    return { ...item, visible: item.visible !== false && item.enabled !== false, sort: Number(item.sort || (index + 1) * 10) };
  });
}

function normalizeConfigBanners(config = {}) {
  const banners = Array.isArray(config.banners) && config.banners.length
    ? config.banners
    : (Array.isArray(config.homeBanners) ? config.homeBanners : []);
  return banners.map((item, index) => ({
    ...item,
    _id: item._id || item.id || `banner-${index + 1}`,
    type: item.type || item.mediaType || "image",
    mediaType: item.mediaType || item.type || "image",
    url: item.url || item.imageUrl || item.imgUrl || item.videoUrl || item.fileID || item.fileId || "",
    cover: item.cover || item.poster || item.imageUrl || item.imgUrl || item.url || "",
    targetType: item.targetType || item.linkType || item.jumpType || "",
    targetId: item.targetId || item.linkId || item.jumpId || "",
    linkUrl: item.linkUrl || item.jumpUrl || item.targetUrl || ""
  })).filter(item => item.url || item.cover);
}

function normalizeImage(item) { return item.cover || item.coverUrl || item.image || item.url || "/images/placeholder.png"; }

const PUBLIC_HIDDEN_FIELD = /^(?:password|passwordHash|secret|secretId|secretKey|token|internalNote|internalCost|costPrice|operatorId|auditStatus|reviewer|approvedBy|privateUrl|auditNote|internalSecret|source|sourceCodeId|sourceScene|paymentRecords|bookingIdempotencyKey|packageSnapshot|customer|contact|openid|unionid|userId|phone|mobile|telephone|wechat|email|idCard|bankAccount|extraPhones|extraWechats)$/i;
function isPublicHiddenField(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return PUBLIC_HIDDEN_FIELD.test(key) || normalized.startsWith("password") || normalized.startsWith("secret")
    || normalized.endsWith("token") || /^(?:internal|private|audit)/.test(normalized)
    || normalized.includes("credential") || normalized.includes("authorization")
    || normalized.includes("openid") || normalized.includes("unionid") || normalized.includes("wechat")
    || normalized === "userid" || normalized.endsWith("userid")
    || normalized === "phone" || normalized.endsWith("phone") || normalized === "mobile" || normalized.endsWith("mobile")
    || normalized === "telephone" || normalized.endsWith("telephone") || normalized === "email" || normalized.endsWith("email")
    || ["internalnote", "internalcost", "costprice", "operatorid", "auditstatus", "reviewer", "approvedby", "privateurl", "auditnote", "sourcecodeid", "sourcescene", "paymentrecords", "bookingidempotencykey", "packagesnapshot", "customer", "contact", "idcard", "bankaccount"].includes(normalized);
}
function publicContentRow(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => publicContentRow(item, seen)).filter((item) => item !== undefined);
  const out = {};
  const id = String(getItemId(value) || "");
  if (id) {
    out.id = String(value.id || id);
    out._id = id;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" || key === "_id") continue;
    if (isPublicHiddenField(key)) continue;
    const next = publicContentRow(child, seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function normalizeTags(item) {
  if (Array.isArray(item.serviceTags)) return item.serviceTags;
  if (Array.isArray(item.tags)) return item.tags;
  if (Array.isArray(item.styles)) return item.styles;
  if (typeof item.serviceTags === "string") return item.serviceTags.split(/[，,|]/).filter(Boolean);
  if (typeof item.tags === "string") return item.tags.split(/[，,|]/).filter(Boolean);
  return [];
}

function normalizeSpotTags(item = {}) {
  const split = (value) => Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/[，,|]/) : [];
  const values = [
    ...split(item.tags),
    ...split(item.styles),
    ...split(item.tag)
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return [...new Set(values)];
}

function isVideoProduct(item) {
  if (!item || typeof item !== "object") return false;
  const values = [item.serviceType, item.type, item.productType, item.productKind, item.category]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toLowerCase());
  return values.some((value) => /video|短视频|视频/.test(value));
}

function boolValue(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function packageIsMainPush(item = {}) {
  return boolValue(item.isMainPush) || boolValue(item.mainPush) || boolValue(item.isFeatured);
}

function packageIsHot(item = {}) {
  return boolValue(item.isHot) || boolValue(item.isHotSale) || boolValue(item.hot);
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function packageSpotIds(item = {}) {
  const values = [];
  if (Array.isArray(item.spotIds)) values.push(...item.spotIds);
  if (item.spotId !== undefined && item.spotId !== null && item.spotId !== "") values.push(item.spotId);
  return [...new Set(values.filter((value) => value !== undefined && value !== null && String(value) !== "").map(String))];
}

function packageItemType(item = {}) {
  const target = item.target && typeof item.target === "object" ? item.target : {};
  const raw = String(item.type || item.productType || item.category || target.page || "").trim().toLowerCase();
  if (/video|视频/.test(raw)) return "video";
  if (/peripheral|accessor|周边|相册|实物/.test(raw) && !/photo|照片/.test(raw)) return "peripheral";
  if (/album|photo|照片|写真|拍照|collection/.test(raw)) return "album";
  if (target.page === "videoProductDetail") return "video";
  if (target.page === "peripheral") return "peripheral";
  if (target.page === "photoCollection") return "album";
  return item.type || item.productType || "service";
}

function normalizePackageIncludedItems(item = {}, context = {}) {
  const declared = [];
  const primary = Array.isArray(item.includedItems) ? item.includedItems : [];
  const alias = Array.isArray(item.items) ? item.items : [];
  const length = Math.max(primary.length, alias.length);
  for (let index = 0; index < length; index += 1) {
    const merged = { ...(alias[index] && typeof alias[index] === "object" ? alias[index] : {}), ...(primary[index] && typeof primary[index] === "object" ? primary[index] : {}) };
    if (!Object.keys(merged).length) {
      const value = primary[index] !== undefined ? primary[index] : alias[index];
      if (value !== undefined && value !== null) merged.name = String(value);
    }
    declared.push(merged);
  }

  const albums = Array.isArray(context.albums) ? context.albums : [];
  const videos = Array.isArray(context.videos) ? context.videos : [];
  const peripherals = Array.isArray(context.peripherals) ? context.peripherals : [];
  const findById = (rows, id) => rows.find((row) => row && String(getItemId(row)) === String(id || ""));
  const normalized = declared.map((raw) => {
    const type = packageItemType(raw);
    const target = raw.target && typeof raw.target === "object" && !Array.isArray(raw.target) ? { ...raw.target } : {};
    const directId = raw.productId || raw.albumId || raw.peripheralId || raw.videoId || target.productId || target.albumId || target.peripheralId || "";
    const related = type === "album" ? findById(albums, raw.albumId || target.albumId || directId)
      : type === "video" ? findById(videos, raw.productId || raw.videoId || target.productId || directId)
        : type === "peripheral" ? findById(peripherals, raw.peripheralId || target.peripheralId || target.id || directId) : null;
    const id = directId || (related && getItemId(related)) || "";
    const result = {
      ...raw,
      type,
      name: String(firstNonEmpty(raw.name, raw.title, related && (related.name || related.title)) || "未命名产品"),
      price: raw.price !== undefined && raw.price !== null && raw.price !== ""
        ? Number(raw.price)
        : (related && Number(related.specialPrice || related.price || 0)) || 0,
      cover: firstNonEmpty(raw.cover, raw.image, related && normalizeImage(related)) || "/images/placeholder.png",
      target
    };
    if (type === "album") {
      if (id && !result.albumId) result.albumId = id;
      if (id && !target.albumId) target.albumId = id;
      if (!target.seriesId) target.seriesId = raw.seriesId || (related && related.seriesId) || item.seriesId || "";
      if (!target.spotId) target.spotId = raw.spotId || (related && related.spotId) || item.spotId || "";
      target.page = target.page || "photoCollection";
    } else if (type === "video") {
      if (id && !result.productId) result.productId = id;
      if (id && !target.productId) target.productId = id;
      if (!target.seriesId) target.seriesId = raw.seriesId || (related && related.seriesId) || item.seriesId || "";
      if (!target.spotId) target.spotId = raw.spotId || (related && related.spotId) || item.spotId || "";
      target.page = target.page || "videoProductDetail";
    } else if (type === "peripheral") {
      if (id && !result.peripheralId) result.peripheralId = id;
      if (id && !target.peripheralId) target.peripheralId = id;
      // The mini-program's peripheral route historically reads target.id;
      // keep it as an alias alongside the canonical peripheralId.
      if (id && !target.id) target.id = id;
      target.page = target.page || "peripheral";
    }
    return result;
  });

  // Older seeded packages only carry albumId. Materialize one navigable item
  // so the public detail page still has useful package content before an
  // operator opens the advanced editor and adds explicit includedItems.
  if (!normalized.length && item.albumId) {
    const album = findById(albums, item.albumId);
    const albumId = String(item.albumId);
    normalized.push({
      type: "album",
      name: String(firstNonEmpty(album && album.name, "照片留影")),
      price: Number(album && (album.specialPrice || album.price) || 0),
      cover: firstNonEmpty(album && normalizeImage(album), "/images/placeholder.png"),
      albumId,
      target: {
        page: "photoCollection",
        albumId,
        seriesId: String(firstNonEmpty(item.seriesId, album && album.seriesId) || ""),
        spotId: String(firstNonEmpty(item.spotId, album && album.spotId) || "")
      }
    });
  }
  return normalized;
}

function normalizePublicPackage(item = {}, context = {}) {
  const source = item && typeof item === "object" ? item : {};
  const id = getItemId(source);
  const video = isVideoProduct(source);
  const tags = [...new Set(normalizeTags(source).map((tag) => String(tag).trim()).filter(Boolean))];
  const spotIds = packageSpotIds(source);
  const description = String(firstNonEmpty(source.description, source.intro, source.desc) || "");
  const includedItems = normalizePackageIncludedItems(source, context);
  const serviceText = tags.join(" ");
  const durationMatch = serviceText.match(/(?:拍摄|时长)\s*(\d+)\s*分钟/);
  const retouchMatch = serviceText.match(/精修\s*(\d+)\s*张/);
  const videoDurationMatch = serviceText.match(/(?:视频|成片)\s*(\d+)\s*(?:秒|s)/i);
  const videoCountMatch = serviceText.match(/(\d+)\s*条/);
  const mainPush = packageIsMainPush(source);
  const hot = packageIsHot(source);
  const normalized = {
    ...source,
    id,
    _id: id,
    type: source.type || (video ? "video" : "photo"),
    serviceType: source.serviceType || (video ? "video" : "photo"),
    productType: source.productType || (video ? "video" : "photo"),
    spotId: String(firstNonEmpty(source.spotId, spotIds[0]) || ""),
    spotIds,
    intro: description,
    description,
    tags: tags.slice(),
    serviceTags: tags.slice(),
    includedItems: includedItems.map((value) => ({ ...value, target: value.target ? { ...value.target } : value.target })),
    items: includedItems.map((value) => ({ ...value, target: value.target ? { ...value.target } : value.target })),
    isMainPush: mainPush,
    mainPush,
    isFeatured: source.isFeatured === undefined ? mainPush : boolValue(source.isFeatured),
    isHot: hot,
    isHotSale: source.isHotSale === undefined ? hot : boolValue(source.isHotSale),
    cover: normalizeImage(source)
  };
  if (normalized.duration === undefined && durationMatch) normalized.duration = Number(durationMatch[1]);
  if (normalized.retouchCount === undefined && retouchMatch) normalized.retouchCount = Number(retouchMatch[1]);
  if (video && normalized.videoDuration === undefined && videoDurationMatch) normalized.videoDuration = Number(videoDurationMatch[1]);
  if (video && normalized.finishedVideoCount === undefined && videoCountMatch) normalized.finishedVideoCount = Number(videoCountMatch[1]);
  return normalized;
}

function filterMediaByPackage(mediaList, currentPackage) {
  if (!currentPackage) return mediaList;
  const targetType = isVideoProduct(currentPackage) ? "video" : "image";
  return (mediaList || []).filter(item => {
    const type = String(item.type || item.mediaType || "image").toLowerCase();
    return (type === "photo" ? "image" : type) === targetType;
  });
}

function normalizeVideoSample(item) {
  return {
    ...item,
    _id: item._id,
    title: item.title || item.name || item.description || "短视频样片",
    cover: item.cover || item.poster || item.coverUrl || item.image || item.url || "/images/placeholder.png",
    url: item.videoUrl || item.previewVideoUrl || item.url || item.fileID || item.fileId || "",
    videoUrl: item.videoUrl || item.previewVideoUrl || item.url || item.fileID || item.fileId || "",
    type: "video",
    mediaType: "video",
    durationText: item.durationText || item.videoDuration || item.duration || "",
    spotName: item.spotName || ""
  };
}

/* ============================ 全局配置 / 城市 / 短视频单品 ============================ */
// 站点全局配置存 siteConfig('global') 一篇文档。注意命名双形态（RPC 层双向归一，两种写法都生效）：
//   后台「小程序配置」编辑页写：customPrice{singlePersonPrice,perExtraPerson} / search.hotwords /
//     privacyText / wechat.corpId / bookingNotice（字符串数组）/ footprint{enabled,title,rewardText}
//   契约 / 小程序端读：customPrice{single,extraPerPerson} / search.hotWords /
//     privacyPolicy.content / corpId / bookingNotice（带编号字符串）/ footprint.stamps
function firstDefined(...vals) {
  for (const v of vals) { if (v !== undefined && v !== null && v !== "") return v; }
  return undefined;
}

const SITE_DEFAULTS = {
  customPrice: { single: 200, extraPerPerson: 100 },
  bookingNotice: "1. 建议提前预约，方便安排摄影师和拍摄路线。\n2. 拍摄当天请准时到达约定地点。\n3. 如遇天气原因，可联系客服协商改期。\n4. 照片和短视频交付周期以旅拍套餐详情为准。",
  searchHotWords: [],
  footprint: {
    title: "我的旅拍足迹",
    rewardText: "下单旅拍，集城市印章，领定制礼品。",
    // 默认长沙章册：与小程序 service/footprint.js 内置默认一致，后台未配置时下发给前端
    stamps: [
      { key: "mountain", char: "山", name: "岳麓山", keywords: ["岳麓", "麓山", "爱晚亭"], spotIds: [] },
      { key: "river", char: "水", name: "湘江边", keywords: ["湘江", "杜甫江阁", "渔人码头", "江滩", "洋湖"], spotIds: [] },
      { key: "isle", char: "洲", name: "橘子洲", keywords: ["橘子洲", "橘洲"], spotIds: [] },
      { key: "city", char: "城", name: "老长沙", keywords: ["太平", "文和友", "IFS", "国金", "五一广场", "潮宗街", "坡子街", "天心阁", "解放西"], spotIds: [] }
    ]
  }
};

// 读 siteConfig('global')：集合 / 文档不存在或异常时返回 {}，由各 RPC 用默认值兜底
async function getSiteGlobal(source) {
  try {
    const canonical = (await source.get("siteConfig", "global"))
      || (await source.get("siteConfig", "homeStats"))
      || (await source.get("config", "global"))
    const rows = await source.list("siteConfig");
    return mergeSiteConfigFragments(canonical, rows);
  } catch (e) {
    if (isDataSourceFailure(e)) throw e;
    return {};
  }
}

function mergeSiteConfigFragments(canonical, rows) {
  const merged = canonical && typeof canonical === "object" ? { ...canonical } : {};
  const fragments = {};
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id || row._id || "");
    if (!id || id === "global" || id === "homeStats") continue;
    const fragment = { ...row };
    delete fragment.id;
    delete fragment._id;
    fragments[id] = normalizeSiteConfigFragment(id, fragment);
  }
  const hasValue = (value) => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
  const mergeObject = (name, fragment) => {
    if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) return;
    const current = merged[name] && typeof merged[name] === "object" && !Array.isArray(merged[name]) ? merged[name] : {};
    merged[name] = { ...fragment, ...Object.fromEntries(Object.entries(current).filter(([key, value]) => !["id", "_id"].includes(key) && hasValue(value))) };
  };
  if (!hasValue(merged.bookingNotice) && fragments.bookingNotice !== undefined) merged.bookingNotice = fragments.bookingNotice;
  if (!hasValue(merged.privacyText) && fragments.privacyText !== undefined) merged.privacyText = fragments.privacyText;
  if (!hasValue(merged.customPrice) || Object.values(merged.customPrice || {}).every((value) => !hasValue(value))) mergeObject("customPrice", fragments.customPrice);
  else mergeObject("customPrice", fragments.customPrice);
  const currentSearch = merged.search && typeof merged.search === "object" && !Array.isArray(merged.search) ? merged.search : {};
  if (!hasValue(currentSearch.hotwords)) mergeObject("search", fragments.search);
  else mergeObject("search", fragments.search);
  if (!hasValue(merged.wechat) || Object.values(merged.wechat || {}).every((value) => !hasValue(value))) mergeObject("wechat", fragments.wechat);
  else mergeObject("wechat", fragments.wechat);
  if (!hasValue(merged.footprint) || Object.values(merged.footprint || {}).every((value) => !hasValue(value))) mergeObject("footprint", fragments.footprint);
  else mergeObject("footprint", fragments.footprint);
  for (const [id, fragment] of Object.entries(fragments)) if (!(id in merged) && !["bookingNotice", "privacyText", "customPrice", "search", "wechat", "footprint"].includes(id)) merged[id] = fragment;
  return merged;
}

function normalizeSiteConfigFragment(id, fragment) {
  const numericKeys = Object.keys(fragment).every((key) => /^\d+$/.test(key));
  if (id === "bookingNotice" && numericKeys) return Object.keys(fragment).sort((a, b) => Number(a) - Number(b)).map((key) => fragment[key]);
  if (id === "privacyText" && numericKeys) return Object.keys(fragment).sort((a, b) => Number(a) - Number(b)).map((key) => fragment[key]).join("");
  return fragment;
}

// 预约须知归一化：编辑页存字符串数组（一行一条），小程序端要单个带编号字符串；已有编号的行不重复加
function normalizeBookingNotice(site = {}) {
  if (typeof site.bookingNotice === "string" && site.bookingNotice.trim()) return site.bookingNotice.trim();
  if (Array.isArray(site.bookingNotice) && site.bookingNotice.length) {
    return site.bookingNotice
      .map(line => String(line || "").trim())
      .filter(Boolean)
      .map((line, i) => (/^\d+\s*[.、)]/.test(line) ? line : (i + 1) + ". " + line))
      .join("\n");
  }
  return SITE_DEFAULTS.bookingNotice;
}

// 短视频单品可见性：packages 里 type 为视频且是单品形态（isVideoSingle / productKind 任一标记）
function isVideoSingleProduct(p) {
  return !!p && isVideoProduct(p) && (p.isVideoSingle === true || p.productKind === "video_single");
}

function normalizeVideoSinglePackage(p = {}) {
  return {
    ...p,
    _id: getItemId(p),
    serviceTags: normalizeTags(p),
    cover: normalizeImage(p),
    isVideoSingle: true,
    productKind: "video_single"
  };
}

/* 城市：探索页城市列表。筹备中城市仍下发为“敬请期待”，visible=false 才完全隐藏。 */
async function rpcGetCities(source) {
  try {
    const [citiesRaw, shopsRaw, spotsRaw] = await Promise.all([
      source.list("cities"),
      source.list("shops"),
      source.list("spots")
    ]);
    const cities = (Array.isArray(citiesRaw) ? citiesRaw : []).filter(isPublicCity);
    const shops = (Array.isArray(shopsRaw) ? shopsRaw : []).filter((item) => item && item.isDeleted !== true && item.deleted !== true && item.visible !== false);
    const spots = (Array.isArray(spotsRaw) ? spotsRaw : []).filter(isVisibleSimple);
    const list = cities.map((city) => {
      const coordinates = normalizedCoordinates(city);
      const cityId = getItemId(city);
      const cityValues = identityValues(city);
      const shopsCount = shops.filter((shop) => identitiesOverlap(spotCityValues(shop), cityValues)).length;
      const spotCount = spots.filter((spot) => identitiesOverlap(spotCityValues(spot), cityValues)).length;
      return {
        _id: cityId,
        name: String(city.name || city.cityName || ""),
        code: String(city.code || city.cityCode || ""),
        status: String(city.status || ""),
        enabled: isEnabledCity(city),
        shopsCount,
        spotCount,
        description: String(city.description || city.desc || ""),
        sort: Number(city.sort || city.order || 0),
        ...coordinates
      };
    }).sort((left, right) => Number(left.sort || 0) - Number(right.sort || 0)
      || String(left.name || "").localeCompare(String(right.name || ""), "zh-Hans-CN"));
    return { success: true, data: list.map((item) => publicContentRow(item)) };
  } catch (err) {
    return { success: false, error: publicRpcError(err), data: [] };
  }
}

/* 隐私政策：未配置完整条款时下发空 content，小程序端回退内置的完整默认 5 段正文（避免占位文案上屏） */
async function rpcGetPrivacyPolicy(source) {
  try {
    const site = await getSiteGlobal(source);
    const pp = site.privacyPolicy && typeof site.privacyPolicy === "object" ? site.privacyPolicy : {};
    const content = String(firstDefined(pp.content, site.privacyText) ?? "").trim();
    const data = {
      title: String(pp.title || "隐私政策"),
      content,
      updateTime: String(pp.updateTime || site.updateTime || "")
    };
    if (Array.isArray(pp.sections) && pp.sections.length) data.sections = publicContentRow(pp.sections);
    return { success: true, data };
  } catch (err) {
    if (isDataSourceFailure(err)) throw err;
    return { success: false, error: publicRpcError(err) };
  }
}

/* 搜索热词：hotWords / hotwords 两种命名合并去重（保序），空则返回空数组由前端回退默认词 */
async function rpcGetSearchConfig(source) {
  try {
    const site = await getSiteGlobal(source);
    const search = site.search && typeof site.search === "object" ? site.search : {};
    const merged = [
      ...(Array.isArray(search.hotWords) ? search.hotWords : []),
      ...(Array.isArray(search.hotwords) ? search.hotwords : [])
    ].map(w => String(w || "").trim()).filter(Boolean);
    const seen = new Set();
    const hotWords = merged.filter(w => { if (seen.has(w)) return false; seen.add(w); return true; });
    return { success: true, data: { hotWords } };
  } catch (err) {
    if (isDataSourceFailure(err)) throw err;
    return { success: false, error: publicRpcError(err) };
  }
}

/* 预约配置：约拍定制定价 + 预约须知（bookingInfo 页与约拍定制入口共用） */
async function rpcGetBookingConfig(source) {
  try {
    const site = await getSiteGlobal(source);
    const cp = site.customPrice && typeof site.customPrice === "object" ? site.customPrice : {};
    const single = Number(firstDefined(cp.single, cp.singlePersonPrice, SITE_DEFAULTS.customPrice.single));
    const extraPerPerson = Number(firstDefined(cp.extraPerPerson, cp.perExtraPerson, SITE_DEFAULTS.customPrice.extraPerPerson));
    return {
      success: true,
      data: {
        customPrice: { single, extraPerPerson },
        bookingNotice: normalizeBookingNotice(site)
      }
    };
  } catch (err) {
    if (isDataSourceFailure(err)) throw err;
    return { success: false, error: publicRpcError(err) };
  }
}

/* 足迹章册：编辑页只维护标题/奖励文案，stamps 后台无编辑器——未配置时下发默认长沙章册（非空，前端才会接受） */
async function rpcGetFootprintConfig(source) {
  try {
    const site = await getSiteGlobal(source);
    const fp = site.footprint && typeof site.footprint === "object" ? site.footprint : {};
    const stamps = (Array.isArray(fp.stamps) ? fp.stamps : [])
      .filter(s => s && typeof s === "object")
      .map((item, index) => ({
        key: item.key || ("stamp-" + (index + 1)),
        char: String(item.char || item.name || "章").slice(0, 1),
        name: item.name || "",
        keywords: Array.isArray(item.keywords) ? item.keywords : [],
        spotIds: Array.isArray(item.spotIds) ? item.spotIds : []
      }));
    return {
      success: true,
      data: {
        enabled: fp.enabled !== false,
        title: String(fp.title || SITE_DEFAULTS.footprint.title),
        rewardText: String(fp.rewardText || SITE_DEFAULTS.footprint.rewardText),
        stamps: stamps.length ? stamps : SITE_DEFAULTS.footprint.stamps
      }
    };
  } catch (err) {
    if (isDataSourceFailure(err)) throw err;
    return { success: false, error: publicRpcError(err) };
  }
}

/* 企微客服：corpId 优先 wechat.corpId（编辑页命名），兜底顶层 corpId（契约命名） */
async function rpcGetCorpConfig(source) {
  try {
    const site = await getSiteGlobal(source);
    const wechat = site.wechat && typeof site.wechat === "object" ? site.wechat : {};
    return {
      success: true,
      data: {
        corpId: String(firstDefined(wechat.corpId, site.corpId) ?? "").trim(),
        appId: String(firstDefined(wechat.appId, site.appId) ?? "").trim(),
        guideText: String(firstDefined(wechat.guideText, site.guideText) ?? "").trim()
      }
    };
  } catch (err) {
    if (isDataSourceFailure(err)) throw err;
    return { success: false, error: publicRpcError(err) };
  }
}

/* 短视频单品列表：与旅拍套餐并列的独立商品种类，支持 limit / spotId / seriesId 筛选 */
async function rpcGetVideoSingles(source, data = {}) {
  try {
    const limit = Math.min(Number(data.limit) || 50, 100);
    const publicSpots = await listPublicSpots(source);
    const publicSpotIds = new Set(publicSpots.map((item) => String(getItemId(item))));
    const seriesSpotScopes = seriesSpotScopeMap(await source.list("series"));
    let list = projectPublicSpotScopedRows(
      (await source.list("packages")).filter((item) => isVideoSingleProduct(item) && isVisibleSimple(item)),
      publicSpotIds,
      { seriesSpotScopes }
    )
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0) || String(b.createTime || "").localeCompare(String(a.createTime || "")));
    if (data.spotId) list = list.filter((item) => packageSpotIds(item).includes(String(data.spotId)));
    if (data.seriesId) list = list.filter(p => p.seriesId === data.seriesId || (Array.isArray(p.seriesIds) && p.seriesIds.includes(data.seriesId)));
    return { success: true, data: list.slice(0, limit).map(normalizeVideoSinglePackage).map((item) => publicContentRow(item)) };
  } catch (err) {
    return { success: false, error: publicRpcError(err), data: [] };
  }
}

/* 订单状态分组与文案（与云函数一致） */
const STATUS_GROUPS = {
  pending: ["pending", "new", "contacted", "deposit_pending"],
  deposit: ["deposit_pending"],
  confirmed: ["deposit_paid", "confirmed", "assigned"],
  shooting: ["shooting"],
  editing: ["editing", "retouching", "final_pending"],
  final: ["final_pending", "awaiting_final_payment"],
  paid: ["paid"],
  completed: ["delivered", "completed"],
  canceled: ["canceled", "cancelled"]
};
function customerStatusText(status) {
  if (STATUS_GROUPS.pending.includes(status)) return "预约待确认";
  if (STATUS_GROUPS.confirmed.includes(status)) return "已确认拍摄";
  if (STATUS_GROUPS.shooting.includes(status)) return "拍摄中";
  if (STATUS_GROUPS.editing.includes(status)) return "修片/交付中";
  if (STATUS_GROUPS.completed.includes(status)) return "已完成";
  if (STATUS_GROUPS.canceled.includes(status)) return "已取消";
  return "预约处理中";
}
function shouldUseComputedStatus(status) {
  return ["editing", "retouching", "final_pending", "delivered", "completed", "canceled", "cancelled"].includes(status);
}

/* ============================ 登录 / 手机号 ============================ */
function wxGetJson(pathAndQuery) {
  return new Promise((resolve, reject) => {
    https.get("https://api.weixin.qq.com" + pathAndQuery, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
function wxPostJson(pathAndQuery, payload) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.weixin.qq.com", path: pathAndQuery, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.write(bodyStr); req.end();
  });
}

async function rpcLogin(source, data = {}, ctx = {}) {
  const code = data.code || "";
  const appid = process.env.WX_APP_ID || "";
  const secret = process.env.WX_APP_SECRET || "";
  if (appid || secret) {
    if (!appid || !secret || !code) return { success: false, message: "微信登录参数不完整" };
    try {
      const r = await wxGetJson(`/sns/jscode2session?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`);
      if (r.openid) {
        await source.upsert("userProfiles", r.openid, { openid: r.openid, updateTime: new Date().toISOString() });
        return { success: true, openid: r.openid };
      }
      return { success: false, message: "微信登录失败，请稍后重试" };
    } catch (e) {
      return { success: false, message: "微信登录服务暂不可用，请稍后重试" };
    }
  }
  // Development fallback is explicit and uses one fixed synthetic identity. A
  // caller cannot select an arbitrary openid and impersonate another user.
  if (!ctx.allowDevOpenid) {
    return { success: false, message: "微信登录服务未配置" };
  }
  const devOpenid = "dev_openid";
  await source.upsert("userProfiles", devOpenid, { openid: devOpenid, dev: true, updateTime: new Date().toISOString() });
  return { success: true, openid: devOpenid, dev: true, message: "开发模式：未配置微信 AppID/Secret，使用本地匿名 openid" };
}

async function rpcBindPhone(source, data = {}, ctx = {}) {
  const openid = data.openid || "";
  if (!openid) return { success: false, message: "缺少 openid" };
  const appid = process.env.WX_APP_ID || "";
  const secret = process.env.WX_APP_SECRET || "";
  let phone = "";
  if (appid && secret && data.code) {
    try {
      const tokenRes = await wxGetJson(`/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`);
      if (tokenRes.access_token) {
        const phoneRes = await wxPostJson(`/wxa/business/getuserphonenumber?access_token=${tokenRes.access_token}`, { code: data.code });
        phone = (phoneRes && phoneRes.phone_info && phoneRes.phone_info.phoneNumber) || "";
      }
    } catch (e) { /* 落到兜底 */ }
  }
  if (!phone && ctx.allowDevOpenid && data.phone) phone = String(data.phone).trim();
  if (!phone) return { success: false, message: "手机号获取失败（开发期可传 data.phone）" };
  await source.upsert("userProfiles", openid, { openid, phone, updateTime: new Date().toISOString() });
  return { success: true, data: { openid, phone } };
}

async function rpcGetMyProfile(source, openid, ctx = {}) {
  const profile = await source.get("userProfiles", openid);
  let avatarUrl = "";
  const avatarFileId = String(profile && profile.avatarFileId || privateFileId(profile && profile.avatarUrl) || privateFileId(profile && profile.userInfo && profile.userInfo.avatarUrl) || "");
  if (avatarFileId && ctx.files) avatarUrl = (await ctx.files.access({ kind: "public", openid }, avatarFileId, {})).url;
  // This customer-facing endpoint is deliberately an explicit projection. Do
  // not spread the stored profile because it may grow private fields later.
  return {
    success: true,
    data: {
      openid,
      phone: String(profile && profile.phone || "").trim(),
      ...(avatarFileId ? { avatarFileId, avatarUrl, userInfo: { avatarUrl } } : {}),
    },
  };
}

async function rpcUpdateMyProfile(source, openid, data, ctx) {
  try {
    const avatarFileId = String(data.avatarFileId || "");
    if (!avatarFileId || !ctx.files) return { success: false, error: "请选择已上传完成的头像" };
    await ctx.files.assertFiles({ kind: "public", openid }, [avatarFileId], { purpose: "avatar" });
    await source.upsert("userProfiles", openid, { openid, avatarFileId, updateTime: new Date().toISOString() });
    await ctx.files.markBound([avatarFileId]);
    return await rpcGetMyProfile(source, openid, ctx);
  } catch (error) { return { success: false, error: publicRpcError(error, "头像保存失败") }; }
}

async function publicFileDescriptors(ids, ctx) {
  if (!ctx.files) return [];
  return Promise.all((Array.isArray(ids) ? ids : []).map(async (id) => {
    const descriptor = await ctx.files.describe(id);
    const out = { id: descriptor.fileId || descriptor.id, fileId: descriptor.fileId || descriptor.id };
    for (const field of ["name", "type", "size", "mimeType"]) if (descriptor[field] !== undefined) out[field] = descriptor[field];
    return out;
  }));
}

async function rpcGetMyAfterSales(source, openid, data, ctx) {
  try {
    const order = await findOrder(source, String(data.orderId || ""), String(data.orderNo || ""));
    if (!order || order.isDeleted || order.deleted || getOrderOpenid(order) !== openid) return { success: false, error: "订单不存在或无权限" };
    const tickets = (await source.list("afterSales")).filter((ticket) => ticket && !ticket.isDeleted && !ticket.deleted && String(ticket.orderId || "") === String(getItemId(order)));
    const rows = await Promise.all(tickets.map(async (ticket) => {
      const own = String(ticket.openid || ticket._openid || "") === openid;
      const ids = [...new Set([...(ticket.attachmentFileIds || []), ...privateFileIds([ticket.attachment, ticket.attachments, ticket.images])])];
      return { id: getItemId(ticket), ticketId: getItemId(ticket), type: own ? String(ticket.type || "售后申请") : "售后处理",
        reason: own ? String(ticket.reason || "") : "", status: ticket.status, customerVisibleStatus: ticket.customerVisibleStatus,
        createdAt: ticket.createdAt, attachments: own ? await publicFileDescriptors(ids, ctx) : [] };
    }));
    return { success: true, data: rows };
  } catch (error) { return { success: false, error: publicRpcError(error, "售后记录加载失败") }; }
}

/* ============================ 首页 ============================ */
async function rpcGetHomeData(source, data = {}) {
  try {
    const config = (await source.get("homeConfig", "homeStats")) || (await source.get("config", "homeStats")) || {};
    const activityText = config.activityNotice || config.activityText || config.notice || "";
    const modules = normalizeConfigModules(config);
    // 兼容后台装修页的两种存储契约：
    //   现网写法：carouselIds（样片ID数组，存在顶层）+ 顶层 featuredXxxIds（相关推荐）
    //   标准写法：banners/homeBanners（轮播对象数组）+ recommendations.*（嵌套相关推荐）
    // 这里两种都读，让装修页现有的配置真正生效。
    const recNested = config.recommendations || {};
    const recommendations = {
      hotSpotIds: recNested.hotSpotIds || recNested.spotIds,
      featuredAlbumIds: recNested.featuredAlbumIds || recNested.albumIds || config.featuredAlbumIds,
      hotPackageIds: recNested.hotPackageIds || recNested.packageIds || config.featuredPackageIds,
      guideIds: recNested.guideIds,
      peripheralIds: recNested.peripheralIds || config.featuredPeripheralIds
    };
    const pageModules = config.pageModules || {};

    let banners = normalizeConfigBanners(config).slice(0, 6);
    if (!banners.length && Array.isArray(config.carouselIds) && config.carouselIds.length) {
      const sampleMap = {};
      (await source.list("samples")).filter(isVisibleSimple).forEach(s => { if (s) sampleMap[getItemId(s)] = s; });
      banners = config.carouselIds
        .map(id => sampleMap[String(id)] || sampleMap[id])
        .filter(Boolean)
        .map(item => ({
          _id: item._id, url: item.url || item.cover || item.image || "", type: item.type || "image", mediaType: item.type || "image",
          cover: item.cover || item.poster || item.url || "", description: item.description || "",
          tag: item.tag || "", targetType: item.targetType || "", targetId: item.targetId || "", linkUrl: item.linkUrl || ""
        }));
    }
    if (!banners.length) {
      const showcase = (await source.list("samples")).filter(s => s.isShowcase && isVisibleSimple(s)).slice(0, 6);
      banners = showcase.map(item => ({
        _id: item._id, url: item.url, type: item.type || "image", mediaType: item.type || "image",
        cover: item.cover || item.poster || item.url || "", description: item.description || "",
        tag: item.tag || "", targetType: item.targetType || "", targetId: item.targetId || "", linkUrl: item.linkUrl || ""
      }));
    }

    // 探索页轮播：与首页轮播「单独一套」，互不干扰。后台在 homeConfig.exploreBanners 独立配置（banner 对象数组）。
    let exploreBanners = []
    if (Array.isArray(config.exploreBanners) && config.exploreBanners.length) {
      exploreBanners = normalizeConfigBanners({ banners: config.exploreBanners }).slice(0, 6)
    }

    const rawSpots = await listPublicSpots(source);
    const spots = pickConfiguredList(rawSpots, recommendations.hotSpotIds || recommendations.spotIds, 12);

    const publicSpotIds = new Set(rawSpots.map((item) => String(getItemId(item))));
    const sourceSeries = await source.list("series");
    const seriesSpotScopes = seriesSpotScopeMap(sourceSeries);
    const rawSeries = projectPublicSpotScopedRows(
      sourceSeries.filter(isVisibleSimple),
      publicSpotIds
    );
    const rawPackages = projectPublicSpotScopedRows(
      (await source.list("packages")).filter(isVisibleSimple),
      publicSpotIds,
      { seriesSpotScopes }
    ).sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0)).slice(0, 100);
    const albums = projectPublicSpotScopedRows((await source.list("albums")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const allPeripherals = projectPublicSpotScopedRows((await source.list("peripherals")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const configuredAlbums = pickConfiguredList(albums, recommendations.featuredAlbumIds || recommendations.albumIds, 20);
    const packageContext = { albums, videos: rawPackages, peripherals: allPeripherals };

    const albumCountMap = {};
    configuredAlbums.forEach(a => { if (a.seriesId) albumCountMap[a.seriesId] = (albumCountMap[a.seriesId] || 0) + 1; });
    const series = rawSeries.map(item => {
      const spotIds = packageSpotIds(item);
      const firstSpot = spots.find(sp => String(getItemId(sp)) === String(spotIds[0] || ""));
      const packageCount = rawPackages.filter((pkg) => String(pkg.seriesId || "") === String(getItemId(item)) || (Array.isArray(item.packageIds) && item.packageIds.map(String).includes(String(getItemId(pkg))))).length;
      return { ...item, albumCount: albumCountMap[getItemId(item)] || 0, firstSpotName: firstSpot ? firstSpot.name : "", spotCount: spotIds.length, packageCount };
    });

    const packageRows = pickConfiguredList(rawPackages, recommendations.hotPackageIds || recommendations.packageIds, 20)
      .map((item) => normalizePublicPackage(item, packageContext));
    const configuredHotIds = Array.isArray(recommendations.hotPackageIds) ? recommendations.hotPackageIds : [];
    const hotSource = configuredHotIds.length
      ? pickConfiguredList(rawPackages, configuredHotIds, 20)
      : (rawPackages.filter((item) => packageIsHot(item) || packageIsMainPush(item)).length
        ? rawPackages.filter((item) => packageIsHot(item) || packageIsMainPush(item))
        : rawPackages);
    const hotPackages = hotSource.filter((item) => !isVideoProduct(item)).slice(0, 20)
      .map((item) => normalizePublicPackage(item, packageContext));
    // 短视频单品（独立商品种类）随首页一并下发，小程序端与 getVideoSingles 同源合并
    const videoSingles = rawPackages.filter(isVideoSingleProduct).slice(0, 50)
      .map((item) => normalizeVideoSinglePackage(normalizePublicPackage(item, packageContext)));

    const guides = pickConfiguredList(
      projectPublicSpotScopedRows(
        (await source.list("guides")).filter(isVisibleSimple),
        publicSpotIds,
        { seriesSpotScopes }
      ).sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || ""))).slice(0, 20),
      recommendations.guideIds, 8
    );
    const peripherals = pickConfiguredList(
      allPeripherals.slice(0, 20),
      recommendations.peripheralIds, 8
    );

    let shopInfo = {};
    if (data.shopId) {
      const shopRows = await source.list("shops");
      const shop = (Array.isArray(shopRows) ? shopRows : []).find((row) => matchesShopId(row, data.shopId));
      if (shop && shop.name) shopInfo = { name: shop.name, logo: shop.logo || "", description: shop.description || "" };
    }
    if (!shopInfo.name) shopInfo = { name: "鹿小鸣旅拍", logo: "", description: "长沙专业旅拍" };

    return { success: true, data: {
      shopInfo,
      activityText,
      banners: publicContentRow(banners),
      exploreBanners: publicContentRow(exploreBanners),
      spots: publicContentRow(spots),
      series: publicContentRow(series),
      albums: publicContentRow(configuredAlbums),
      packages: publicContentRow(packageRows),
      hotPackages: publicContentRow(hotPackages),
      videoSingles: publicContentRow(videoSingles),
      guides: publicContentRow(guides),
      peripherals: publicContentRow(peripherals),
      modules: publicContentRow(modules),
      quickNav: publicContentRow(config.quickNav || []),
      pageConfig: { homeModules: publicContentRow(modules), recommendations: publicContentRow(recommendations), pageModules: publicContentRow(pageModules) }
    } };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

/* ============================ 打卡点 ============================ */
async function rpcGetSpots(source, data = {}) {
  try {
    const limit = Math.min(Number(data.limit) || 100, 100);
    const list = (await listPublicSpots(source, data)).slice(0, limit);
    return { success: true, data: publicContentRow(list) };
  } catch (err) {
    return { success: false, error: publicRpcError(err, "获取打卡点失败"), data: [] };
  }
}

/* ============================ 预约页基础数据 ============================ */
async function rpcGetBookingData(source) {
  try {
    const spots = await listPublicSpots(source);
    const publicSpotIds = new Set(spots.map((item) => String(getItemId(item))));
    const sourceSeries = await source.list("series");
    const seriesSpotScopes = seriesSpotScopeMap(sourceSeries);
    const rawSeries = projectPublicSpotScopedRows(
      sourceSeries.filter(isVisibleSimple),
      publicSpotIds
    );
    const allPackages = projectPublicSpotScopedRows((await source.list("packages")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const albums = projectPublicSpotScopedRows((await source.list("albums")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const photos = projectPublicSpotScopedRows((await source.list("samples")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const peripherals = projectPublicSpotScopedRows((await source.list("peripherals")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const packageContext = { albums, videos: allPackages, peripherals };
    const albumCountMap = {};
    albums.forEach(a => { if (a.seriesId) albumCountMap[a.seriesId] = (albumCountMap[a.seriesId] || 0) + 1; });
    const photoCountMap = {};
    photos.forEach(p => { if (p.albumId) photoCountMap[p.albumId] = (photoCountMap[p.albumId] || 0) + 1; });
    const allSeries = rawSeries.map(s => ({
      ...s,
      albumCount: albumCountMap[getItemId(s)] || 0,
      packageCount: allPackages.filter((p) => String(p.seriesId || "") === String(getItemId(s)) || (Array.isArray(s.packageIds) && s.packageIds.map(String).includes(String(getItemId(p))))).length,
      firstSpotName: (() => { const spotIds = packageSpotIds(s); const sp = spots.find((item) => String(getItemId(item)) === String(spotIds[0] || "")); return sp ? sp.name : ""; })()
    }));
    const packageRows = allPackages.map((item) => normalizePublicPackage(item, packageContext));
    const hotPackages = allPackages.filter((item) => packageIsHot(item) || packageIsMainPush(item))
      .map((item) => normalizePublicPackage(item, packageContext));
    return { success: true, data: {
      spots: publicContentRow(spots),
      allSeries: publicContentRow(allSeries),
      albums: publicContentRow(albums),
      hotPackages: publicContentRow(hotPackages),
      allPackages: publicContentRow(packageRows),
      packages: publicContentRow(packageRows),
      allPeripherals: publicContentRow(peripherals),
      peripherals: publicContentRow(peripherals)
    } };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

/* ============================ 系列列表 ============================ */
async function rpcGetSeriesList(source, data = {}) {
  try {
    const { type, spotId, page = 1, pageSize = 10 } = data;
    const publicSpots = await listPublicSpots(source);
    const publicSpotIds = new Set(publicSpots.map((item) => String(getItemId(item))));
    const sourceSeries = await source.list("series");
    const seriesSpotScopes = seriesSpotScopeMap(sourceSeries);
    let list = projectPublicSpotScopedRows(sourceSeries.filter(isVisibleSimple), publicSpotIds);
    const allPackages = projectPublicSpotScopedRows((await source.list("packages")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    if (type) list = list.filter(s => s.productType === type || s.type === type);
    if (spotId) list = list.filter((item) => packageSpotIds(item).includes(String(spotId)));
    list.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));
    const total = list.length;
    const start = (Number(page) - 1) * Number(pageSize);
    const paged = list.slice(start, start + Number(pageSize)).map(s => ({
      ...s, spotCount: packageSpotIds(s).length, packageCount: allPackages.filter((p) => String(p.seriesId || "") === String(getItemId(s)) || (Array.isArray(s.packageIds) && s.packageIds.map(String).includes(String(getItemId(p))))).length
    }));
    return { success: true, data: paged.map((item) => publicContentRow(item)), total, page: Number(page), pageSize: Number(pageSize) };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

/* ============================ 系列详情 ============================ */
async function rpcGetSeriesDetail(source, data = {}) {
  try {
    const { seriesId: inputSeriesId, packageId = "", spotId = "" } = data;
    let seriesId = inputSeriesId || "";
    let currentPackage = null;
    const publicSpots = await listPublicSpots(source);
    const publicSpotIds = new Set(publicSpots.map((item) => String(getItemId(item))));
    const sourceSeries = await source.list("series");
    const seriesSpotScopes = seriesSpotScopeMap(sourceSeries);

    if (packageId) {
      currentPackage = await source.get("packages", packageId);
      if (currentPackage && !isVisibleSimple(currentPackage)) return { success: false, error: "套餐已下架" };
      if (currentPackage) {
        currentPackage = projectPublicSpotScope(currentPackage, publicSpotIds, { seriesSpotScopes });
        if (!currentPackage) return { success: false, error: "套餐不存在" };
      }
      if (!seriesId && currentPackage) seriesId = currentPackage.seriesId || (Array.isArray(currentPackage.seriesIds) ? currentPackage.seriesIds[0] : "");
    }
    if (!seriesId && packageId) {
      const byPkg = sourceSeries.find(s => (Array.isArray(s.packageIds) && s.packageIds.includes(packageId)) || s.packageId === packageId || (Array.isArray(s.packages) && s.packages.includes(packageId)));
      if (byPkg) seriesId = getItemId(byPkg);
    }
    if (!seriesId) {
      const requestedSpotId = String(spotId || "");
      const selectedSpotId = requestedSpotId && publicSpotIds.has(requestedSpotId)
        ? requestedSpotId
        : packageSpotIds(currentPackage)[0] || "";
      if (currentPackage) return buildPackageOnlyResponse(currentPackage, selectedSpotId);
      return { success: false, error: "缺少套餐或系列ID" };
    }

    let series = await source.get("series", seriesId);
    if (!series || !isVisibleSimple(series)) return { success: false, error: "系列不存在" };
    series = projectPublicSpotScope(series, publicSpotIds);
    if (!series) return { success: false, error: "系列不存在" };

    const seriesSpotIds = packageSpotIds(series);
    const requestedSpotId = String(spotId || "");
    const currentSpotId = requestedSpotId && publicSpotIds.has(requestedSpotId) && (!seriesSpotIds.length || seriesSpotIds.includes(requestedSpotId))
      ? requestedSpotId
      : seriesSpotIds[0] || "";

    let spots = [];
    if (seriesSpotIds.length) {
      spots = seriesSpotIds.map(id => publicSpots.find(s => String(getItemId(s)) === String(id))).filter(Boolean).map(s => ({
        _id: getItemId(s), name: s.name || "", cityId: s.cityId || "", city: s.city || "",
        cover: normalizeImage(s), address: s.address || "", description: s.description || s.desc || "",
        district: s.district || "", latitude: s.latitude, longitude: s.longitude, coordType: s.coordType || "gcj02"
      }));
    }

    const allSamples = projectPublicSpotScopedRows(
      (await source.list("samples")).filter(s => s.seriesId === seriesId && isVisibleSimple(s)),
      publicSpotIds,
      { seriesSpotScopes }
    );
    const samples = allSamples.filter(s => s.isShowcase).slice(0, 8);
    const photos = allSamples.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || ""))).slice(0, 30);

    const albums = projectPublicSpotScopedRows(
      (await source.list("albums")).filter(a => a.seriesId === seriesId && isVisibleSimple(a)),
      publicSpotIds,
      { seriesSpotScopes }
    )
      .sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || ""))).slice(0, 30)
      .map(a => ({ ...a, cover: normalizeImage(a), sampleUrls: a.sampleUrls || a.photos || [], photoCount: a.photoCount || (a.sampleUrls ? a.sampleUrls.length : 0) }));

    const allPackages = projectPublicSpotScopedRows((await source.list("packages")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes })
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0));
    const [allVisibleAlbums, allPeripherals] = await Promise.all([
      source.list("albums").then((rows) => projectPublicSpotScopedRows(rows.filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes })),
      source.list("peripherals").then((rows) => projectPublicSpotScopedRows(rows.filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes }))
    ]);
    const packageContext = { albums: allVisibleAlbums, videos: allPackages, peripherals: allPeripherals };
    const packageRows = allPackages.map((item) => normalizePublicPackage(item, packageContext));
    const currentPackageRow = currentPackage ? normalizePublicPackage(currentPackage, packageContext) : null;
    const mainPushIds = new Set(packageRows.filter(packageIsMainPush).map((item) => getItemId(item)));
    const mainPushPackages = packageRows.filter(packageIsMainPush);
    const spotPackages = packageRows.filter((item) => {
      const belongs = currentSpotId && packageSpotIds(item).includes(String(currentSpotId));
      return belongs && !mainPushIds.has(getItemId(item));
    });
    const configuredSeriesPackageIds = new Set((Array.isArray(series.packageIds) ? series.packageIds : []).map(String));
    const seriesPackages = packageRows.filter((item) => String(item.seriesId || "") === String(seriesId) || configuredSeriesPackageIds.has(String(getItemId(item))));
    if (currentPackageRow && !seriesPackages.some((item) => getItemId(item) === getItemId(currentPackageRow))) {
      seriesPackages.unshift(currentPackageRow);
    }

    const prices = [...albums.map(a => Number(a.price || 0)), ...mainPushPackages.map(p => Number(p.price || 0)), ...spotPackages.map(p => Number(p.price || 0))].filter(p => p > 0);
    const recommendedVideos = isVideoProduct(currentPackage) ? await getRecommendedVideos(source, { currentPackage: currentPackage || {}, series, currentSpotId, publicSpotIds, seriesSpotScopes }) : [];

    const seriesStyles = Array.isArray(series.styles) ? series.styles : (series.style ? [series.style] : normalizeTags(series));
    return {
      success: true,
      data: {
        series: publicContentRow({ ...series, cover: normalizeImage(series), styles: seriesStyles, minPrice: prices.length ? Math.min(...prices) : (series.minPrice || 0), maxPrice: prices.length ? Math.max(...prices) : (series.maxPrice || 0) }),
        currentPackage: currentPackageRow ? publicContentRow(currentPackageRow) : null,
        currentSpotId,
        spots: publicContentRow(spots),
        samples: publicContentRow(filterMediaByPackage(samples, currentPackage)),
        photos: publicContentRow(filterMediaByPackage(photos, currentPackage)),
        recommendedVideos: publicContentRow(recommendedVideos),
        albums: publicContentRow(albums),
        packages: publicContentRow(seriesPackages),
        mainPushPackages: publicContentRow(mainPushPackages),
        spotPackages: publicContentRow(spotPackages)
      }
    };
  } catch (err) {
    return { success: false, error: publicRpcError(err, "获取系列详情失败") };
  }
}

function buildPackageOnlyResponse(currentPackage, spotId = "") {
  const normalizedPackage = normalizePublicPackage(currentPackage);
  const safePackage = publicContentRow(normalizedPackage);
  const price = Number(currentPackage.price || 0);
  return {
    success: true,
    data: {
      series: { _id: "", name: currentPackage.name || "套餐详情", cover: normalizeImage(currentPackage), styles: normalizeTags(currentPackage), intro: currentPackage.description || currentPackage.intro || "", minPrice: price, maxPrice: price, soldCount: currentPackage.soldCount || 0 },
      currentPackage: safePackage,
      currentSpotId: spotId || currentPackage.spotId || "",
      spots: [],
      samples: [{ _id: "package-cover", url: normalizeImage(currentPackage), type: "image" }],
      photos: [],
      albums: [],
      packages: [safePackage],
      mainPushPackages: [safePackage],
      spotPackages: []
    }
  };
}

async function getRecommendedVideos(source, { currentPackage = {}, series = {}, currentSpotId = "", publicSpotIds = null, seriesSpotScopes = null }) {
  const configuredIds = [
    ...(currentPackage.recommendedVideoIds || []), ...(currentPackage.recommendVideoIds || []),
    ...(series.recommendedVideoIds || []), ...(series.recommendVideoIds || [])
  ].filter(Boolean);
  let found = [];
  if (configuredIds.length) found = (await source.list("samples")).filter(s => configuredIds.map(String).includes(String(getItemId(s))) && isVisibleSimple(s) && (s.type || s.mediaType) === "video");
  if (!found.length) {
    const seriesId = series._id || "";
    found = (await source.list("samples")).filter(s => isVisibleSimple(s) && (s.type || s.mediaType) === "video" && (s.seriesId === seriesId || s.spotId === currentSpotId || s.isRecommend === true || s.isFeatured === true));
  }
  return (publicSpotIds ? projectPublicSpotScopedRows(found, publicSpotIds, { seriesSpotScopes }) : found).map(normalizeVideoSample);
}

/* ============================ 样片合集详情 ============================ */
async function rpcGetPhotoCollection(source, data = {}) {
  const { seriesId, spotId } = data;
  if (!seriesId) return { success: false, error: "缺少系列ID" };
  try {
    const publicSpots = await listPublicSpots(source);
    const publicSpotIds = new Set(publicSpots.map((item) => String(getItemId(item))));
    const seriesSpotScopes = seriesSpotScopeMap(await source.list("series"));
    let series = await source.get("series", seriesId);
    if (!series || !isVisibleSimple(series)) return { success: false, error: "系列不存在" };
    series = projectPublicSpotScope(series, publicSpotIds);
    if (!series) return { success: false, error: "系列不存在" };

    const seriesSpotIds = packageSpotIds(series);
    let spots = [];
    if (seriesSpotIds.length) {
      spots = seriesSpotIds.map(id => publicSpots.find(s => String(getItemId(s)) === String(id))).filter(Boolean).map(s => ({
        _id: getItemId(s), name: s.name, cityId: s.cityId || "", city: s.city || "",
        district: s.district || "", latitude: s.latitude, longitude: s.longitude, coordType: s.coordType || "gcj02"
      }));
    }
    series.spots = spots;

    const samplesAll = projectPublicSpotScopedRows(
      (await source.list("samples")).filter(s => s.seriesId === seriesId && isVisibleSimple(s)),
      publicSpotIds,
      { seriesSpotScopes }
    );
    series.samples = samplesAll.filter(s => s.isShowcase).slice(0, 5);
    const photos = samplesAll.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));

    const packagesAll = projectPublicSpotScopedRows((await source.list("packages")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const albums = projectPublicSpotScopedRows((await source.list("albums")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const peripherals = projectPublicSpotScopedRows((await source.list("peripherals")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    const packageContext = { albums, videos: packagesAll, peripherals };
    const publicPackages = packagesAll.map((item) => normalizePublicPackage(item, packageContext));
    const configuredPackageIds = new Set((Array.isArray(series.packageIds) ? series.packageIds : []).map(String));
    const packages = publicPackages.filter((p) => String(p.seriesId || "") === String(seriesId) || configuredPackageIds.has(String(getItemId(p))));
    const featuredPackages = publicPackages.filter((p) => packageIsMainPush(p) || packageIsHot(p))
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0)).slice(0, 10);
    let spotPackages = [];
    if (seriesSpotIds.length) {
      const requestedSpotId = String(spotId || "");
      const targetSpotId = requestedSpotId && publicSpotIds.has(requestedSpotId) && seriesSpotIds.includes(requestedSpotId)
        ? requestedSpotId
        : seriesSpotIds[0];
      spotPackages = publicPackages.filter((p) => packageSpotIds(p).includes(String(targetSpotId)))
        .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0)).slice(0, 10);
    }
    const firstAlbum = albums.find(a => a.seriesId === seriesId && isVisibleSimple(a));
    const albumPrice = firstAlbum ? (firstAlbum.price || 0) : 0;

    const collection = {
      seriesId: series._id, seriesName: series.name || "", intro: series.intro || "",
      spotName: photos.length ? (photos[0].spotName || "") : (spots.length ? spots[0].name : ""),
      spotId: seriesSpotIds[0] || "",
      albumId: "", coverImage: photos.length ? photos[0].url : (series.cover || "/images/placeholder.png"),
      sampleUrls: photos.map(p => p.url), photoCount: photos.length, price: albumPrice
    };

    return { success: true, data: {
      series: publicContentRow(series),
      photos: publicContentRow(photos),
      packages: publicContentRow(packages),
      featuredPackages: publicContentRow(featuredPackages),
      spotPackages: publicContentRow(spotPackages),
      collections: publicContentRow([collection])
    } };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

/* ============================ 周边 / 攻略 ============================ */
async function rpcGetPeripherals(source, data = {}) {
  try {
    const { cate } = data;
    const publicSpots = await listPublicSpots(source);
    const publicSpotIds = new Set(publicSpots.map((item) => String(getItemId(item))));
    const seriesSpotScopes = seriesSpotScopeMap(await source.list("series"));
    let list = projectPublicSpotScopedRows((await source.list("peripherals")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    if (cate) list = list.filter(p => p.category === cate || p.cate === cate);
    list.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));
    return { success: true, data: list.map((item) => publicContentRow(item)) };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

async function rpcGetGuides(source, data = {}) {
  try {
    const { spotId } = data;
    const publicSpots = await listPublicSpots(source);
    const publicSpotIds = new Set(publicSpots.map((item) => String(getItemId(item))));
    const seriesSpotScopes = seriesSpotScopeMap(await source.list("series"));
    let list = projectPublicSpotScopedRows((await source.list("guides")).filter(isVisibleSimple), publicSpotIds, { seriesSpotScopes });
    if (spotId) list = list.filter((item) => packageSpotIds(item).includes(String(spotId)));
    list.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));
    return { success: true, data: list.map((item) => publicContentRow(item)) };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

async function rpcGetGuide(source, data = {}) {
  const id = String(data.id || data.guideId || "").trim();
  if (!id) return { success: false, error: "缺少攻略 ID" };
  try {
    const guide = await source.get("guides", id);
    if (!guide || !isVisibleSimple(guide)) return { success: false, error: "攻略不存在" };
    const publicSpots = await listPublicSpots(source);
    const publicSpotIds = new Set(publicSpots.map((item) => String(getItemId(item))));
    const seriesSpotScopes = seriesSpotScopeMap(await source.list("series"));
    const projected = projectPublicSpotScope(guide, publicSpotIds, { seriesSpotScopes });
    if (!projected) return { success: false, error: "攻略不存在" };
    return { success: true, data: publicContentRow(projected) };
  } catch (error) {
    return { success: false, error: publicRpcError(error, "攻略读取失败") };
  }
}

/* ============================ 我的订单 ============================ */
function getOrderOpenid(order) { return order.openid || order._openid || ""; }

// Public order responses are an explicit customer-facing projection. Do not
// spread the persisted order here: internal notes, payment records, source
// attribution and alternate identity/contact aliases are admin-only fields.
const PUBLIC_ORDER_ITEM_FIELDS = [
  "id", "_id", "name", "title", "price", "quantity", "qty", "count", "productType", "productId",
  "packageId", "packageName", "albumId", "albumName", "seriesId", "seriesName",
  "spotId", "spotName", "type", "duration", "cover", "coverUrl", "image"
];
function projectPublicDeliveryFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return null;
    const out = {};
    ["id", "_id", "fileId", "name", "title", "url", "downloadUrl", "cover", "type", "mediaType", "size", "duration"].forEach((field) => {
      if (item[field] !== undefined) out[field] = item[field];
    });
    return out;
  }).filter(Boolean);
}
function projectPublicOrder(order = {}) {
  const projected = publicOrderProjection(order, { detail: true });
  const paymentTestModeEnabled = testPaymentEnabled();
  return {
    ...projected,
    id: projected._id,
    items: projected.productItems,
    afterSaleStatus: typeof order.afterSaleStatus === "string" ? order.afterSaleStatus : "",
    bookingMode: typeof order.bookingMode === "string" ? order.bookingMode : "consult",
    paymentTestModeEnabled,
    canRunTestPayment: paymentTestModeEnabled && projected.canPay === true,
  };
}
async function enrichPublicOrderFiles(order, ctx) {
  if (!ctx.files || !Array.isArray(order.deliverFiles)) return order;
  order.deliverFiles = await Promise.all(order.deliverFiles.map(async (entry) => {
    if (!entry || typeof entry !== "object" || !/^file_[a-f0-9]{32,48}$/.test(String(entry.fileId || ""))) return entry;
    const descriptors = await publicFileDescriptors([entry.fileId], ctx);
    return { ...descriptors[0], ...entry };
  }));
  return order;
}

async function rpcGetMyOrders(source, openid, data = {}, ctx = {}) {
  try {
    if (!openid) return { success: false, error: "请先完成微信登录" };
    const { status } = data;
    const page = Math.max(1, Math.floor(Number(data.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(data.pageSize) || 10)));
    let list = await source.list("orders");
    list = list.filter(o => !o.isDeleted && !o.deleted && (!openid || getOrderOpenid(o) === openid));
    if (status && STATUS_GROUPS[status]) {
      const allowed = STATUS_GROUPS[status];
      const stageMap = {
        pending: [WORKFLOW_STAGES.AWAITING_CONFIRMATION],
        deposit: [WORKFLOW_STAGES.AWAITING_DEPOSIT],
        confirmed: [WORKFLOW_STAGES.AWAITING_DISPATCH, WORKFLOW_STAGES.AWAITING_SHOOT],
        shooting: [WORKFLOW_STAGES.SHOOTING],
        editing: [WORKFLOW_STAGES.SELECTION_PENDING, WORKFLOW_STAGES.AWAITING_DELIVERY],
        final: [WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT],
        paid: [WORKFLOW_STAGES.PAID],
        completed: [WORKFLOW_STAGES.DELIVERED, WORKFLOW_STAGES.COMPLETED],
        canceled: [WORKFLOW_STAGES.CANCELLED],
      };
      list = Object.prototype.hasOwnProperty.call(stageMap, status)
        ? list.filter((order) => stageMap[status].includes(canonicalStage(order)))
        : list.filter((order) => allowed.includes(order.status) || allowed.includes(order.customerStatus));
    }
    list.sort((a, b) => String(b.createTime || b.appointmentAt || "").localeCompare(String(a.createTime || a.appointmentAt || "")));
    const total = list.length;
    const start = (page - 1) * pageSize;
    const paged = await Promise.all(list.slice(start, start + pageSize).map((o) => enrichPublicOrderFiles(projectPublicOrder(o), ctx)));
    return { success: true, data: paged, total, page, pageSize };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

async function findOrder(source, orderId, orderNo) {
  if (orderId) {
    const order = await source.get("orders", orderId);
    if (order && orderNo && String(order.orderNo || "") !== String(orderNo)) {
      const error = new Error("订单 ID 与订单号不一致"); error.code = "ORDER_IDENTIFIER_MISMATCH"; throw error;
    }
    return order;
  }
  const all = await source.list("orders");
  const matched = (Array.isArray(all) ? all : []).filter((order) => String(order && order.orderNo || "") === String(orderNo || ""));
  if (matched.length > 1) {
    const error = new Error("订单号存在重复记录，请联系平台处理"); error.code = "ORDER_NO_AMBIGUOUS"; throw error;
  }
  return matched[0] || null;
}

async function rpcGetOrderDetail(source, openid, data = {}, ctx = {}) {
  const { orderId, orderNo = "" } = data;
  if (!orderId && !orderNo) return { success: false, error: "缺少订单ID" };
  try {
    if (!openid) return { success: false, error: "请先完成微信登录" };
    const order = await findOrder(source, orderId, orderNo);
    if (!order || order.isDeleted || order.deleted) return { success: false, error: "订单不存在" };
    if (openid && getOrderOpenid(order) !== openid) return { success: false, error: "无权限" };

    const d = await enrichPublicOrderFiles(projectPublicOrder(order), ctx);
    return {
      success: true,
      data: { ...d, statusText: d.customerStatus }
    };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

async function rpcOrderStatusCount(source, openid) {
  try {
    if (!openid) return { success: false, error: "请先完成微信登录" };
    const all = (await source.list("orders")).filter(o => !o.isDeleted && !o.deleted && (!openid || getOrderOpenid(o) === openid));
    const groups = {
      pending: [WORKFLOW_STAGES.AWAITING_CONFIRMATION],
      deposit: [WORKFLOW_STAGES.AWAITING_DEPOSIT],
      confirmed: [WORKFLOW_STAGES.AWAITING_DISPATCH, WORKFLOW_STAGES.AWAITING_SHOOT],
      shooting: [WORKFLOW_STAGES.SHOOTING],
      editing: [WORKFLOW_STAGES.SELECTION_PENDING, WORKFLOW_STAGES.AWAITING_DELIVERY],
      final: [WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT],
      paid: [WORKFLOW_STAGES.PAID],
      completed: [WORKFLOW_STAGES.DELIVERED, WORKFLOW_STAGES.COMPLETED],
      canceled: [WORKFLOW_STAGES.CANCELLED],
    };
    const result = {};
    for (const key of Object.keys(groups)) {
      result[key] = all.filter(o => groups[key].includes(canonicalStage(o))).length;
    }
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

/* ============================ 创建订单 ============================ */
const ACTIVE_ORDER_STATUSES = ["pending", "new", "contacted", "deposit_pending", "deposit_paid", "confirmed", "assigned", "shooting", "delivered", "final_pending"];

function parseScene(scene = "") {
  if (!scene) return {};
  let decoded = scene;
  try { decoded = decodeURIComponent(scene); } catch (e) {}
  return decoded.split("&").reduce((r, pair) => { const [k, v = ""] = pair.split("="); if (k) r[k] = v; return r; }, {});
}
function buildSource({ shopId, scene, codeId, placementType, placementLabel }) {
  const sp = parseScene(scene);
  const sourceShopId = shopId || sp.shopId || "";
  const distributorId = sp.distributorId || sp.distributor || sp.promoterId || "";
  const sourceType = sp.sourceType || sp.channel || (sourceShopId ? "merchant_qrcode" : "direct");
  const sourceCodeId = String(codeId || sp.c || sp.codeId || "").trim();
  return {
    shopId: sourceShopId,
    distributorId,
    codeId: sourceCodeId,
    sourceCodeId,
    placementType: String(placementType || sp.placementType || "").trim(),
    placementLabel: String(placementLabel || sp.placementLabel || "").trim(),
    scene: scene || "",
    sourceType,
    channel: sourceType,
  };
}
function isActiveMerchantCode(row) {
  if (!row || row.isDeleted === true || row.deleted === true) return false;
  return !["disabled", "inactive", "expired", "停用", "失效", "已失效", "下架", "已下架"].includes(String(row.status || "").trim().toLowerCase());
}
function isActiveShop(row) {
  if (!row || row.isDeleted === true || row.deleted === true) return false;
  return !["disabled", "inactive", "terminated", "停用", "已停用", "终止合作", "已终止", "暂停合作"].includes(String(row.status || "").trim().toLowerCase());
}
function matchesShopId(shop, value) {
  const target = String(value || "");
  return !!target && [shop && shop.id, shop && shop._id, shop && shop.shopId].filter(Boolean).map(String).includes(target);
}
async function validateBookingSource(source, input = {}) {
  const requested = buildSource(input);
  const requestedCodeId = String(requested.sourceCodeId || "").trim();
  let shops = [];
  let codes = [];
  try {
    shops = await source.list("shops");
    codes = await source.list("merchantCodes");
  } catch (_) {
    return { error: "来源信息暂不可用，请稍后重试" };
  }
  const activeShops = (Array.isArray(shops) ? shops : []).filter(isActiveShop);
  if (requestedCodeId) {
    const code = (Array.isArray(codes) ? codes : []).find((row) => isActiveMerchantCode(row)
      && (getItemId(row) === requestedCodeId || String(row.codeId || "") === requestedCodeId || String(row.scene || "") === `c=${requestedCodeId}`));
    if (!code) return { error: "二维码无效或已失效" };
    const codeShopId = String(code.shopId || code.shopCode || "");
    const shop = activeShops.find((row) => matchesShopId(row, codeShopId));
    if (!shop) return { error: "二维码对应商家不存在或已停用" };
    const distributorId = String(code.distributorId || (Array.isArray(code.distributorIds) ? code.distributorIds[0] : "")
      || shop.distributorId || (Array.isArray(shop.distributorIds) ? shop.distributorIds[0] : "") || "");
    const authoritativeSource = buildSource({
        shopId: codeShopId,
        scene: String(code.scene || input.scene || `c=${requestedCodeId}`),
        codeId: getItemId(code),
        placementType: code.placementType,
        placementLabel: code.placementLabel,
      });
    authoritativeSource.sourceType = "merchant_qrcode";
    authoritativeSource.channel = "merchant_qrcode";
    return {
      source: authoritativeSource,
      shop,
      code,
      distributorId,
    };
  }
  if (requested.shopId) {
    const shop = activeShops.find((row) => matchesShopId(row, requested.shopId));
    if (!shop) return { error: "商家不存在或已停用" };
    const canonical = String(shop.shopId || shop.id || shop._id || requested.shopId);
    return {
      source: buildSource({ ...input, shopId: canonical, scene: "", codeId: "" }),
      shop,
      distributorId: String(shop.distributorId || (Array.isArray(shop.distributorIds) ? shop.distributorIds[0] : "") || ""),
    };
  }
  // Direct bookings cannot claim a distributor or merchant code supplied by a
  // client. Keep only the neutral direct source marker.
  return { source: buildSource({ ...input, shopId: "", scene: "", codeId: "" }), distributorId: "" };
}
function orderHasPackage(order, packageId) {
  if (order.packageId === packageId) return true;
  const items = [...(Array.isArray(order.items) ? order.items : []), ...(Array.isArray(order.productItems) ? order.productItems : [])];
  return items.some(i => i && i.packageId === packageId);
}
function orderMatchesTime(order, timeValue) {
  if (!timeValue) return true;
  return [order.time, order.timePeriod, order.timeSlot].includes(timeValue);
}
function daysUntil(dateText) {
  if (!dateText) return 0;
  const target = new Date(`${dateText}T00:00:00+08:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((target.getTime() - today.getTime()) / 86400000);
}

async function resolveBookingItems(source, items) {
  const [packages, albums, peripherals, spots, series, site] = await Promise.all([
    source.list("packages"), source.list("albums"), source.list("peripherals"),
    source.list("spots"), source.list("series"), getSiteGlobal(source),
  ]);
  const packageMap = new Map((packages || []).map((row) => [getItemId(row), row]));
  const albumMap = new Map((albums || []).map((row) => [getItemId(row), row]));
  const peripheralMap = new Map((peripherals || []).map((row) => [getItemId(row), row]));
  const spotMap = new Map((spots || []).map((row) => [getItemId(row), row]));
  const seriesMap = new Map((series || []).map((row) => [getItemId(row), row]));
  const customConfig = site && site.customPrice && typeof site.customPrice === "object" ? site.customPrice : {};
  const configuredSiteRatio = customConfig.depositRatio ?? customConfig.depositRate ?? customConfig.depositPercent;
  const siteRatio = configuredSiteRatio === undefined || configuredSiteRatio === null || configuredSiteRatio === ""
    ? 0.3 : normalizeRatio(configuredSiteRatio);
  let total = 0;
  let depositAmount = 0;
  const resolved = [];
  for (const rawInput of (Array.isArray(items) ? items : [])) {
    const raw = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
    const item = {
      packageId: raw.packageId == null ? "" : String(raw.packageId).slice(0, 128),
      albumId: raw.albumId == null ? "" : String(raw.albumId).slice(0, 128),
      peripheralId: raw.peripheralId == null ? "" : String(raw.peripheralId).slice(0, 128),
      productId: raw.productId == null ? "" : String(raw.productId).slice(0, 128),
      spotId: raw.spotId == null ? "" : String(raw.spotId).slice(0, 128),
      seriesId: raw.seriesId == null ? "" : String(raw.seriesId).slice(0, 128),
      name: typeof raw.name === "string" ? raw.name.trim().slice(0, 160) : "",
      title: typeof raw.title === "string" ? raw.title.trim().slice(0, 160) : "",
      requestedSpot: typeof raw.requestedSpot === "string" ? raw.requestedSpot.trim().slice(0, 160) : "",
      custom: raw.custom === true,
      participantCount: Number.isFinite(Number(raw.participantCount ?? raw.count)) ? Math.min(Math.max(Math.floor(Number(raw.participantCount ?? raw.count)), 1), 20) : undefined,
      quantity: Number.isFinite(Number(raw.quantity ?? raw.qty ?? raw.count)) ? Math.min(Math.max(Math.floor(Number(raw.quantity ?? raw.qty ?? raw.count)), 1), 99) : 1,
    };
    const explicitIds = [item.packageId, item.albumId, item.peripheralId].filter(Boolean);
    if (item.custom && explicitIds.length) return { error: "定制项目不能同时携带标准商品" };
    let product = null;
    let productType = String(raw.productType || raw.type || "").trim().toLowerCase();
    const productId = item.productId || item.packageId || item.albumId || item.peripheralId || (raw.id || "");
    if (["video", "photo", "package", "video_package", "photo_package", "photo_single"].includes(productType) && productId) {
      product = packageMap.get(String(productId)); productType = "package";
    } else if (["album", "sample", "photo_album"].includes(productType) && productId) {
      product = albumMap.get(String(productId)); productType = "album";
    } else if (["peripheral", "addon", "accessory"].includes(productType) && productId) {
      product = peripheralMap.get(String(productId)); productType = "peripheral";
    } else if (item.packageId || productType === "package") {
      product = packageMap.get(String(item.packageId || productId)); productType = "package";
    } else if (item.albumId || productType === "album") {
      product = albumMap.get(String(item.albumId || productId)); productType = "album";
    } else if (item.peripheralId || productType === "peripheral") {
      product = peripheralMap.get(String(item.peripheralId || productId)); productType = "peripheral";
    }
    if (!product && productId) {
      product = packageMap.get(String(productId));
      if (product) productType = "package";
      else { product = albumMap.get(String(productId)); if (product) productType = "album"; }
      if (!product) { product = peripheralMap.get(String(productId)); if (product) productType = "peripheral"; }
    }
    if (item.custom === true) {
      const count = item.participantCount || 1;
      const base = Number(customConfig.singlePersonPrice ?? customConfig.single ?? 200);
      const extra = Number(customConfig.perExtraPerson ?? customConfig.extraPerPerson ?? 100);
      item.price = Math.max(0, base + Math.max(count - 1, 0) * extra);
      item.participantCount = count;
      item.name = "约拍定制";
      item.title = item.name;
      item.packageName = item.name;
      productType = "custom";
      item.depositRatio = siteRatio;
    } else {
      if (!product || !isVisibleSimple(product)) return { error: "预约商品不存在或已下架" };
      const canonicalId = getItemId(product);
      item.packageId = productType === "package" ? canonicalId : "";
      item.albumId = productType === "album" ? canonicalId : "";
      item.peripheralId = productType === "peripheral" ? canonicalId : "";
      item.productId = canonicalId;
      item.name = String(product.name || product.title || item.name || "").slice(0, 160);
      item.title = item.name;
      item.price = Number(product.specialPrice || product.price || product.salePrice || 0);
      const productDeposit = product.depositRatio ?? product.depositRate ?? product.depositPercent ?? product.depositPercentage;
      item.depositRatio = productDeposit == null ? siteRatio : normalizeRatio(productDeposit);
    }
    const productSpotId = product && (product.spotId || (Array.isArray(product.spotIds) ? product.spotIds[0] : ""));
    const productSeriesId = product && product.seriesId;
    const resolvedSpotId = productSpotId || (spotMap.has(item.spotId) ? item.spotId : "");
    const resolvedSeriesId = productSeriesId || (seriesMap.has(item.seriesId) ? item.seriesId : "");
    const resolvedSpot = spotMap.get(String(resolvedSpotId || ""));
    const resolvedSeries = seriesMap.get(String(resolvedSeriesId || ""));
    item.spotId = String(resolvedSpotId || "");
    item.seriesId = String(resolvedSeriesId || "");
    item.spotName = String((resolvedSpot && resolvedSpot.name) || (product && product.spotName) || (item.custom ? item.requestedSpot : "")).slice(0, 160);
    item.seriesName = String((resolvedSeries && resolvedSeries.name) || (product && product.seriesName) || "").slice(0, 160);
    if (productType === "package") item.packageName = item.name;
    if (productType === "album") item.albumName = item.name;
    if (productType === "peripheral") item.peripheralName = item.name;
    item.productType = productType || "service";
    const quantity = Math.min(Math.max(Number(item.quantity || 1), 1), 99);
    item.quantity = quantity; item.qty = quantity;
    if (!Number.isFinite(Number(item.price)) || Number(item.price) < 0) return { error: "预约商品价格无效" };
    const lineTotal = roundMoney(Number(item.price) * quantity);
    total = roundMoney(total + lineTotal);
    depositAmount = roundMoney(depositAmount + lineTotal * normalizeRatio(item.depositRatio));
    resolved.push(item);
  }
  return { items: resolved, totalPrice: total, depositAmount, depositRatio: total > 0 ? normalizeRatio(depositAmount / total) : 0 };
}

async function rpcCreateBooking(source, data = {}) {
  return withOrderMutex("order:global", async () => rpcCreateBookingUnlocked(source, data));
}

function generatedOrderNo(dateText) {
  return `LS${String(dateText || "").replace(/[^0-9]/g, "").slice(0, 8)}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

async function rpcCreateBookingUnlocked(source, data = {}) {
  const openid = String(data.openid || "").trim();
  if (!openid) return { success: false, error: "请先完成微信登录" };
  const bookingKey = String(data.idempotencyKey || data.requestId || "").trim();
  if (bookingKey && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(bookingKey)) return { success: false, error: "预约请求标识无效" };
  try {
    if (bookingKey) {
      const existing = await source.list("orders");
      const same = (Array.isArray(existing) ? existing : []).filter((row) => String(row && row.bookingIdempotencyKey || "") === bookingKey);
      const owned = same.find((row) => getOrderOpenid(row) === openid && !row.isDeleted && !row.deleted);
      if (owned) return { success: true, orderId: getItemId(owned), orderNo: String(owned.orderNo || ""), idempotent: true };
      if (same.some((row) => getOrderOpenid(row) && getOrderOpenid(row) !== openid)) return { success: false, error: "预约请求标识已被使用" };
    }
    const {
      shopId, spotId, seriesId, packageId, name: rawName, phone, contactPhones = [], wechat,
      date: rawDate, expectedDate, timePeriod, expectedTimePeriod, timeSlot, time, message, price, scene, items = [], productItems,
      codeId, placementType, placementLabel,
    } = data;
    const name = String(rawName || data.customerName || "").trim();
    const scheduleRaw = String(rawDate || expectedDate || data.scheduleAt || data.bookingDate || "").trim();
    let date = scheduleRaw;
    let scheduleTime = "";
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(scheduleRaw)) { date = scheduleRaw.slice(0, 10); scheduleTime = scheduleRaw.slice(11, 16); }
    const primaryPackageId = String(packageId || data.packageId || "").trim();
    const itemList = Array.isArray(items) && items.length ? items : (Array.isArray(productItems) ? productItems : []);
    const normalizedItems = itemList.length
      ? itemList
      : [{ spotId: spotId || "", seriesId: seriesId || "", albumId: data.albumId || "", packageId: primaryPackageId, productId: data.productId || "", productType: data.productType || "", price: price || 0 }];
    const timeValue = String(time || timePeriod || expectedTimePeriod || timeSlot || data.bookingTime || scheduleTime || "").trim();
    if (!name || !phone) return { success: false, error: "请完整填写姓名和手机号" };
    if (!/^1[3-9]\d{9}$/.test(String(phone).trim())) return { success: false, error: "手机号格式不正确" };
    if (!date || !timeValue) return { success: false, error: "请填写期望拍摄日期和时段，客服确认后才生效" };
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00+08:00`).getTime()))) return { success: false, error: "预约日期格式不正确" };
    const hasBookingItem = !!primaryPackageId || !!data.albumId || !!seriesId
      || normalizedItems.some((item) => item && (item.custom === true || item.packageId || item.albumId || item.peripheralId || item.productId || item.seriesId));
    if (!hasBookingItem) return { success: false, error: "请选择预约拍摄项目" };
    const sourceResult = await validateBookingSource(source, { shopId, scene, codeId, placementType, placementLabel });
    if (sourceResult.error) return { success: false, error: sourceResult.error };
    const src = { ...sourceResult.source, distributorId: sourceResult.distributorId || sourceResult.source.distributorId || "" };
    const normalizedContactPhones = [phone, ...(Array.isArray(contactPhones) ? contactPhones : [])]
      .map(String).map((value) => value.trim()).filter((value, index, list) => value && list.indexOf(value) === index);
    const resolvedItems = await resolveBookingItems(source, normalizedItems);
    if (resolvedItems.error) return { success: false, error: resolvedItems.error };
    const bookingItems = resolvedItems.items;
    if (!bookingItems.some((item) => item && (item.custom === true || String(item.productType || "").toLowerCase() !== "peripheral"))) {
      return { success: false, error: "影像周边需搭配拍摄项目一起预约" };
    }
    const packageIds = Array.from(new Set(bookingItems.filter((item) => item && item.packageId).map((item) => String(item.packageId))));
    const firstItem = bookingItems[0] || {};
    const serverTotalPrice = roundMoney(resolvedItems.totalPrice);
    const depositAmount = roundMoney(resolvedItems.depositAmount ?? serverTotalPrice * normalizeRatio(resolvedItems.depositRatio));
    const depositRatio = serverTotalPrice > 0 ? normalizeRatio(depositAmount / serverTotalPrice) : 0;
    const finalAmount = roundMoney(Math.max(serverTotalPrice - depositAmount, 0));
    let pkgNameMap = {};
    if (packageIds.length) {
      const pkgs = (await source.list("packages")).filter((row) => packageIds.includes(getItemId(row)));
      if (pkgs.length !== packageIds.length) return { success: false, error: "部分套餐不存在或已下架" };
      pkgNameMap = Object.fromEntries(pkgs.map((row) => [getItemId(row), row.name || row.title || ""]));
      for (const pkg of pkgs) {
        if (!isVisibleSimple(pkg)) return { success: false, error: `${pkg.name || "套餐"}暂不可预约` };
        const conflict = [...(pkg.mutexPackageIds || []), ...(pkg.conflictPackageIds || []), ...(pkg.exclusivePackageIds || [])].find((id) => packageIds.includes(String(id)));
        if (conflict) return { success: false, error: "所选套餐不可同时预约，请分开下单" };
        const minAdvance = Number(pkg.minAdvanceDays || pkg.advanceBookingDays || pkg.advanceDays || 0);
        if (date && minAdvance > 0 && daysUntil(date) < minAdvance) return { success: false, error: `${pkg.name || "套餐"}需至少提前${minAdvance}天预约` };
        const dayLimit = Number(pkg.dailyLimit || pkg.maxDailyBookings || pkg.appointmentLimit || 0);
        if (date && dayLimit > 0) {
          const active = (await source.list("orders")).filter((row) => !row.isDeleted && !row.deleted && ACTIVE_ORDER_STATUSES.includes(row.status)
            && String(row.date || row.bookingDate || row.appointmentAt || "").slice(0, 10) === date
            && orderHasPackage(row, getItemId(pkg)) && orderMatchesTime(row, timeValue));
          const activeQuantity = active.reduce((sum, row) => {
            const rows = Array.isArray(row.items) ? row.items : (Array.isArray(row.productItems) ? row.productItems : []);
            const quantity = rows.filter((item) => item && String(item.packageId || "") === getItemId(pkg)).reduce((count, item) => count + Math.max(1, Number(item.quantity || item.qty || 1)), 0);
            return sum + (quantity || (String(row.packageId || "") === getItemId(pkg) ? 1 : 0));
          }, 0);
          const requestedQuantity = bookingItems.filter((item) => item && String(item.packageId || "") === getItemId(pkg)).reduce((count, item) => count + Math.max(1, Number(item.quantity || item.qty || 1)), 0);
          if (activeQuantity + Math.max(1, requestedQuantity) > dayLimit) return { success: false, error: `${pkg.name || "套餐"}当前日期预约已满` };
        }
      }
    }
    const now = new Date().toISOString();
    const dateStr = now.slice(0, 10).replace(/-/g, "");
    let orderNo = generatedOrderNo(dateStr);
    const doc = {
      ...(bookingKey ? { bookingIdempotencyKey: bookingKey } : {}),
      openid, shopId: src.shopId || "", scene: src.scene || "", source: src,
      sourceCodeId: src.sourceCodeId || "", sourceType: src.sourceType, sourceChannel: src.channel, distributorId: src.distributorId || "",
      spotId: String(firstItem.spotId || spotId || ""), spotName: String(firstItem.spotName || "").slice(0, 160),
      seriesId: String(firstItem.seriesId || seriesId || ""), seriesName: String(firstItem.seriesName || "").slice(0, 160),
      packageId: String(firstItem.packageId || primaryPackageId || ""), packageName: String(firstItem.packageName || pkgNameMap[firstItem.packageId] || firstItem.name || "").slice(0, 160),
      name, customer: name, customerName: name, contactName: name, phone: String(phone).trim(), contactPhone: String(phone).trim(), customerPhone: String(phone).trim(), contactPhones: normalizedContactPhones,
      wechat: String(wechat || ""), contactWechat: String(wechat || ""), date: date || "", timePeriod: timeValue, timeSlot: timeValue, time: timeValue,
      message: String(message || data.remark || data.customerRemark || "").slice(0, 2000),
      remark: String(message || data.remark || data.customerRemark || "").slice(0, 2000),
      items: bookingItems, products: bookingItems, productItems: bookingItems,
      packageSnapshot: { ...(firstItem || {}), items: bookingItems.map((item) => ({ ...item, price: roundMoney(item.price), depositRatio: normalizeRatio(item.depositRatio) })), totalPrice: serverTotalPrice, depositRatio },
      price: serverTotalPrice, totalPrice: serverTotalPrice, totalAmount: serverTotalPrice, amountTotal: serverTotalPrice,
      depositRatio, depositDue: depositAmount, finalDue: finalAmount,
      depositPaid: 0, finalPaid: 0, bookingMode: "consult", workflowStage: WORKFLOW_STAGES.AWAITING_CONFIRMATION,
      status: "new", customerStatus: "待客服联系确认", dispatchStatus: "pending", depositRefundable: true, selectionStatus: "not_started",
      serviceUser: "", serviceUserId: "", photographer: "", photographerId: "", serviceNote: "", deliveryNote: "", participantCount: Number(data.participantCount || firstItem.participantCount || 0) || undefined,
      paymentRecords: [],
      statusLogs: [{ type: "客户预约", action: "提交预约申请", operator: "系统", operatorId: openid, from: "", to: "new", workflowStage: WORKFLOW_STAGES.AWAITING_CONFIRMATION, createTime: now }],
      followRecords: [{ type: "客户预约", action: "create", operator: "系统", note: message ? `客户备注：${message}` : "客户提交预约", createTime: now }],
      orderNo, bookingDate: date || "", bookingTime: timeValue, scheduleAt: date ? `${date}${timeValue ? ` ${timeValue}` : ""}` : "",
      isDeleted: false, deleted: false, createTime: now, createdAt: now,
    };
    let created;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existingOrderNos = await source.list("orders");
      if ((Array.isArray(existingOrderNos) ? existingOrderNos : []).some((row) => String(row && row.orderNo || "") === orderNo)) {
        orderNo = generatedOrderNo(dateStr);
        continue;
      }
      try { doc.orderNo = orderNo; created = await source.create("orders", doc); break; }
      catch (error) {
        if (!error || !["DUPLICATE_RECORD", "ER_DUP_ENTRY"].includes(error.code)) throw error;
        if (bookingKey) {
          const existing = await source.list("orders");
          const same = (Array.isArray(existing) ? existing : []).filter((row) => String(row && row.bookingIdempotencyKey || "") === bookingKey);
          const owned = same.find((row) => getOrderOpenid(row) === openid && !row.isDeleted && !row.deleted);
          if (owned) return { success: true, orderId: getItemId(owned), orderNo: String(owned.orderNo || ""), idempotent: true };
          if (same.length) return { success: false, error: "预约请求标识已被使用" };
        }
        orderNo = generatedOrderNo(dateStr);
      }
    }
    if (!created) return { success: false, error: "订单号生成冲突，请稍后重试" };
    try {
      await source.create("logs", { action: "创建订单", operator: "customer", operatorId: openid, targetType: "order", targetId: getItemId(created), detail: "小程序提交预约", auditEvent: "mutation", immutable: true, createTime: now });
    } catch (_) {
      try { await source.remove("orders", getItemId(created)); } catch (__) {}
      return { success: false, error: "订单未创建，审计服务暂不可用" };
    }
    return { success: true, orderId: getItemId(created), orderNo, order: projectPublicOrder(created) };
  } catch (err) {
    return { success: false, error: publicRpcError(err) };
  }
}

function publicPaymentSummary(order, phase, record = null) {
  const normalizedPhase = String(phase || "").toLowerCase();
  const due = normalizedPhase === "deposit" ? depositDue(order) : finalDue(order);
  const paidField = normalizedPhase === "deposit" ? "depositPaid" : "finalPaid";
  const paid = hasConfirmedPayment(order, normalizedPhase) ? roundMoney(order[paidField]) : 0;
  const status = hasConfirmedPayment(order, normalizedPhase)
    ? "confirmed"
    : record ? normalizePaymentStatus(record.status) : "not_created";
  return {
    orderId: getItemId(order), phase: normalizedPhase,
    amount: roundMoney(record && record.amount != null ? record.amount : due),
    due: roundMoney(due), paid, status, workflowStage: canonicalStage(order),
    canRetry: !["confirmed", "pending", "not_required"].includes(status),
    paymentId: record ? getItemId(record) : "",
  };
}

async function rpcCreatePaymentIntent(source, openid, data = {}) {
  const phase = String(data.phase || data.paymentPhase || "").trim().toLowerCase();
  if (!["deposit", "final"].includes(phase)) return { success: false, error: "支付阶段必须是 deposit 或 final" };
  const requestedKey = String(data.idempotencyKey || data.requestId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestedKey)) return { success: false, error: "请提供有效的支付请求标识" };
  const initial = await findOrder(source, data.orderId, data.orderNo);
  if (!initial || initial.isDeleted || initial.deleted) return { success: false, error: "订单不存在" };
  if (getOrderOpenid(initial) !== openid) return { success: false, error: "无权限操作该订单" };
  const orderKey = getItemId(initial);
  return withOrderMutex(`order:${orderKey}`, async () => {
    const order = await source.get("orders", orderKey);
    if (!order || order.isDeleted || order.deleted || getOrderOpenid(order) !== openid) return { success: false, error: "订单不存在或无权限" };
    const records = Array.isArray(order.paymentRecords) ? order.paymentRecords : [];
    const usesKey = (record, key) => String(record && record.idempotencyKey || "") === key
      || String(record && record.confirmationIdempotencyKey || "") === key;
    const existing = records.find((record) => usesKey(record, requestedKey));
    if (existing) {
      if (String(existing.phase || "") !== phase) return { success: false, error: "支付请求标识已用于其他支付阶段" };
      const existingStatus = normalizePaymentStatus(existing.status);
      if (["pending", "confirmed"].includes(existingStatus)) {
        return { success: true, data: { ...publicPaymentSummary(order, phase, existing), provider: String(existing.provider || "wechat_pay_placeholder"), requiresFinanceConfirmation: existingStatus !== "confirmed", invokeWeChatPay: false, idempotent: true } };
      }
      return { success: false, error: "该支付请求已失败，请更换请求标识重试" };
    }
    const allOrders = await source.list("orders");
    const conflict = (Array.isArray(allOrders) ? allOrders : []).some((candidate) => {
      if (!candidate || getItemId(candidate) === orderKey) return false;
      return (Array.isArray(candidate.paymentRecords) ? candidate.paymentRecords : []).some((record) => usesKey(record, requestedKey));
    });
    if (conflict) return { success: false, error: "支付请求标识已用于其他订单" };
    if (order.riskBlocked || order.riskFlag || order.frozen || order.freezeReason || order.riskReason) return { success: false, error: "订单存在风控冻结，暂不能发起支付" };
    let tickets = [];
    try { tickets = await source.list("afterSales"); } catch (_) { return { success: false, error: "售后数据暂不可用，请稍后重试" }; }
    if (relatedAfterSaleTickets(order, tickets).some((ticket) => activeAfterSaleTicket(ticket)
      && (!ticket.orderId || String(ticket.orderId) === String(orderKey)))) return { success: false, error: "订单存在处理中售后，暂不能创建支付单" };
    const stage = canonicalStage(order);
    if (phase === "deposit" && (!isServiceConfirmed(order) || stage !== WORKFLOW_STAGES.AWAITING_DEPOSIT)) return { success: false, error: "客服确认服务快照后才能创建订金支付单" };
    if (phase === "final" && (!hasDeliveryRecord(order) || stage !== WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT)) return { success: false, error: "成片发布后才能创建尾款支付单" };
    const due = phase === "deposit" ? depositDue(order) : finalDue(order);
    if (due <= 0) return { success: false, error: "当前支付阶段无需收款" };
    const suppliedAmount = data.amount == null ? due : Number(data.amount);
    if (!Number.isFinite(suppliedAmount) || Math.abs(roundMoney(suppliedAmount) - roundMoney(due)) > 0.009) return { success: false, error: "支付金额与订单应收不一致" };
    if (hasConfirmedPayment(order, phase)) return { success: false, error: "该支付阶段已确认到账" };
    const activePending = records.find((record) => String(record.phase || "") === phase && normalizePaymentStatus(record.status) === "pending" && String(record.idempotencyKey || ""));
    if (activePending) return { success: true, data: { ...publicPaymentSummary(order, phase, activePending), provider: String(activePending.provider || "wechat_pay_placeholder"), requiresFinanceConfirmation: true, invokeWeChatPay: false, idempotent: true, reused: true } };
    const now = new Date().toISOString();
    const placeholder = records.find((record) => String(record.phase || "") === phase
      && ["pending", "not_created"].includes(normalizePaymentStatus(record.status)) && !String(record.idempotencyKey || ""));
    const payment = {
      ...(placeholder || {}), id: getItemId(placeholder) || makePaymentId("payment"), phase, amount: roundMoney(due), status: "pending",
      attempt: Number(placeholder && placeholder.attempt || 0) || (records.filter((record) => String(record.phase || "") === phase).length + 1),
      idempotencyKey: requestedKey, provider: "wechat_pay_placeholder", operator: "customer", operatorId: openid,
      createdAt: placeholder && placeholder.createdAt || now, updatedAt: now,
    };
    const nextRecords = placeholder ? records.map((record) => record === placeholder ? payment : record) : [...records, payment];
    const original = JSON.parse(JSON.stringify(order));
    const timeline = { id: makePaymentId("timeline"), type: "支付", action: phase === "deposit" ? "创建订金支付单" : "创建尾款支付单", operator: "游客", operatorId: openid, createTime: now };
    let updated;
    try {
      updated = await source.update("orders", orderKey, { paymentRecords: nextRecords, statusLogs: [...(Array.isArray(order.statusLogs) ? order.statusLogs : []), timeline], followRecords: [...(Array.isArray(order.followRecords) ? order.followRecords : []), timeline], updateTime: now });
    } catch (error) {
      // A MySQL unique constraint can win a cross-process race after the
      // in-memory check above. Re-read the authoritative record and turn the
      // matching request into the same idempotent result a retry receives.
      if (error && ["DUPLICATE_RECORD", "ER_DUP_ENTRY"].includes(error.code)) {
        const latest = await source.get("orders", orderKey).catch(() => null);
        const matched = latest && (Array.isArray(latest.paymentRecords) ? latest.paymentRecords : []).find((record) => usesKey(record, requestedKey));
        if (matched && String(matched.phase || "") === phase) {
          return { success: true, data: { ...publicPaymentSummary(latest, phase, matched), provider: String(matched.provider || "wechat_pay_placeholder"), requiresFinanceConfirmation: !hasConfirmedPayment(latest, phase), invokeWeChatPay: false, idempotent: true } };
        }
      }
      throw error;
    }
    if (!updated) return { success: false, error: "订单保存失败，请稍后重试" };
    try {
      await source.create("logs", { action: "创建支付单", operator: openid, operatorId: openid, targetType: "order", targetId: orderKey, detail: `${phase} payment intent`, auditEvent: "payment_intent", immutable: true, createTime: now });
    } catch (_) {
      try { await restoreOrderSnapshot(source, orderKey, original); } catch (__) {}
      return { success: false, error: "支付单未创建，审计服务暂不可用" };
    }
    return { success: true, data: { ...publicPaymentSummary(updated, phase, payment), provider: "wechat_pay_placeholder", requiresFinanceConfirmation: true, invokeWeChatPay: false, paymentParams: null, message: "微信支付入口已预留，当前不会唤起微信支付；请等待客服/财务确认到账" } };
  });
}

async function rpcTestPayment(source, openid, data = {}) {
  if (!testPaymentEnabled()) return { success: false, error: "测试支付未启用" };
  const phase = String(data.phase || data.paymentPhase || "").trim().toLowerCase();
  if (!['deposit', 'final'].includes(phase)) return { success: false, error: "支付阶段必须是 deposit 或 final" };
  const idempotencyKey = String(data.idempotencyKey || data.requestId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(idempotencyKey)) return { success: false, error: "请提供有效的测试支付请求标识" };
  try {
    const initial = await findOrder(source, data.orderId, data.orderNo);
    if (!initial || initial.isDeleted || initial.deleted) return { success: false, error: "订单不存在" };
    if (getOrderOpenid(initial) !== openid) return { success: false, error: "无权限操作该订单" };
    const orderKey = getItemId(initial);
    return await withOrderMutex(`order:${orderKey}`, async () => {
      const order = await source.get("orders", orderKey);
      if (!order || order.isDeleted || order.deleted || getOrderOpenid(order) !== openid) return { success: false, error: "订单不存在或无权限" };
      const records = Array.isArray(order.paymentRecords) ? order.paymentRecords : [];
      const usesKey = (record, key) => String(record && record.idempotencyKey || "") === key || String(record && record.confirmationIdempotencyKey || "") === key;
      const exact = records.find((record) => usesKey(record, idempotencyKey));
      if (exact) {
        if (String(exact.phase || "") !== phase) return { success: false, error: "测试支付请求标识已用于其他支付阶段" };
        if (normalizePaymentStatus(exact.status) === "confirmed" && String(exact.provider || "") === "test_payment") {
          return { success: true, data: { ...publicPaymentSummary(order, phase, exact), provider: "test_payment", testPayment: true, requiresFinanceConfirmation: false, invokeWeChatPay: false, idempotent: true } };
        }
        return { success: false, error: "测试支付请求标识已被使用" };
      }
      let tickets = [];
      try { tickets = await source.list("afterSales"); } catch (_) { return { success: false, error: "售后数据暂不可用，请稍后重试" }; }
      if (relatedAfterSaleTickets(order, tickets).some((ticket) => activeAfterSaleTicket(ticket)
        && (!ticket.orderId || String(ticket.orderId) === String(orderKey)))) return { success: false, error: "订单存在处理中售后，暂不能测试支付" };
      const stage = canonicalStage(order);
      if (phase === "deposit" && (!isServiceConfirmed(order) || stage !== WORKFLOW_STAGES.AWAITING_DEPOSIT)) return { success: false, error: "客服确认服务快照后才能测试支付订金" };
      if (phase === "final" && (!hasDeliveryRecord(order) || stage !== WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT)) return { success: false, error: "成片发布后才能测试支付尾款" };
      const due = phase === "deposit" ? depositDue(order) : finalDue(order);
      if (due <= 0) return { success: false, error: "当前支付阶段无需收款" };
      const allOrders = await source.list("orders");
      if ((Array.isArray(allOrders) ? allOrders : []).some((candidate) => getItemId(candidate) !== orderKey
        && (Array.isArray(candidate.paymentRecords) ? candidate.paymentRecords : []).some((record) => usesKey(record, idempotencyKey)))) {
        return { success: false, error: "测试支付请求标识已用于其他订单" };
      }
      if (hasConfirmedPayment(order, phase)) return { success: false, error: "该支付阶段已确认到账" };
      const now = new Date().toISOString();
      const externalTransactionId = `test:${crypto.createHash("sha256").update(`${orderKey}:${phase}:${idempotencyKey}`).digest("hex").slice(0, 40)}`;
      const reusable = records.find((record) => String(record && record.phase || "") === phase
        && ["not_created", "pending"].includes(normalizePaymentStatus(record.status)));
      const payment = {
        ...(reusable || {}), id: getItemId(reusable) || makePaymentId("testpay"), phase, amount: due, status: "confirmed",
        attempt: Number(reusable && reusable.attempt || 0) || (records.filter((record) => String(record && record.phase || "") === phase).length + 1),
        idempotencyKey, confirmationIdempotencyKey: idempotencyKey, provider: "test_payment", externalTransactionId,
        operator: "test_payment", operatorId: openid, testPayment: true, paidAt: now, confirmedAt: now, createdAt: reusable && reusable.createdAt || now, updatedAt: now,
      };
      const nextRecords = reusable ? records.map((record) => record === reusable ? payment : record) : [...records, payment];
      const paidField = phase === "deposit" ? "depositPaid" : "finalPaid";
      const financeField = phase === "deposit" ? "depositFinanceStatus" : "finalFinanceStatus";
      const paidAtField = phase === "deposit" ? "depositPaidAt" : "finalPaidAt";
      const confirmedAtField = phase === "deposit" ? "depositConfirmedAt" : "finalConfirmedAt";
      const confirmedByField = phase === "deposit" ? "depositConfirmedBy" : "finalConfirmedBy";
      const original = JSON.parse(JSON.stringify(order));
      const timeline = { id: makePaymentId("timeline"), type: "测试支付", action: phase === "deposit" ? "确认测试订金支付" : "确认测试尾款支付", operator: "test_payment", operatorId: openid, createTime: now };
      const patch = {
        paymentRecords: nextRecords, [paidField]: due, [financeField]: "已审", [paidAtField]: now,
        [confirmedAtField]: now, [confirmedByField]: "test_payment", [phase + "PaymentStatus"]: "confirmed",
        status: phase === "deposit" ? "deposit_paid" : "delivered",
        statusLogs: [...(Array.isArray(order.statusLogs) ? order.statusLogs : []), timeline],
        followRecords: [...(Array.isArray(order.followRecords) ? order.followRecords : []), timeline], updateTime: now,
      };
      const updated = await source.update("orders", orderKey, patch);
      if (!updated) return { success: false, error: "订单保存失败，请稍后重试" };
      try {
        await source.create("logs", { action: "确认测试支付", operator: "test_payment", operatorId: openid, targetType: "order", targetId: orderKey, detail: `${phase} provider=test_payment`, auditEvent: "test_payment", immutable: true, createTime: now });
      } catch (_) {
        try { await restoreOrderSnapshot(source, orderKey, original); } catch (__) {}
        return { success: false, error: "测试支付未确认，审计服务暂不可用" };
      }
      return { success: true, data: { ...publicPaymentSummary(updated, phase, payment), provider: "test_payment", testPayment: true, requiresFinanceConfirmation: false, invokeWeChatPay: false } };
    });
  } catch (error) {
    return { success: false, error: publicRpcError(error, "测试支付失败") };
  }
}

async function rpcGetPaymentStatus(source, openid, data = {}) {
  const phase = String(data.phase || data.paymentPhase || "").trim().toLowerCase();
  if (!["deposit", "final"].includes(phase)) return { success: false, error: "支付阶段必须是 deposit 或 final" };
  const order = await findOrder(source, data.orderId, data.orderNo);
  if (!order || order.isDeleted || order.deleted) return { success: false, error: "订单不存在" };
  if (getOrderOpenid(order) !== openid) return { success: false, error: "无权限查看该订单" };
  const records = (Array.isArray(order.paymentRecords) ? order.paymentRecords : []).filter((record) => String(record.phase || "") === phase);
  const confirmed = records.filter((record) => normalizePaymentStatus(record.status) === "confirmed").slice(-1)[0] || null;
  const latest = confirmed || (records.length ? records[records.length - 1] : null);
  const intent = latest && (latest.idempotencyKey || latest.provider) ? latest : null;
  return { success: true, data: { ...publicPaymentSummary(order, phase, intent), provider: intent && intent.provider || "wechat_pay_placeholder", requiresFinanceConfirmation: !hasConfirmedPayment(order, phase), invokeWeChatPay: false } };
}

/* ============================ 订单状态变更（客人自助取消/删除） ============================ */
async function rpcUpdateOrderStatus(source, openid, data = {}) {
  const requested = String(data.newStatus || data.status || "").trim().toLowerCase();
  if (["canceled", "cancelled"].includes(requested)) return rpcCancelOrder(source, openid, data);
  return { success: false, error: "用户端不支持直接修改订单状态，请联系客户服务" };
}
async function rpcCancelOrder(source, openid, data = {}) {
  if (!openid) return { success: false, error: "请先完成微信登录" };
  const orderId = String(data.orderId || "").trim();
  const idempotencyKey = String(data.idempotencyKey || data.requestId || "").trim();
  const reason = String(data.reason || data.note || "").trim();
  if (!orderId || !idempotencyKey) return { success: false, error: "取消订单需要订单 ID 和请求标识" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(idempotencyKey)) return { success: false, error: "取消请求标识无效" };
  if (reason.length < 2) return { success: false, error: "请填写取消原因" };
  try {
    const initial = await source.get("orders", orderId);
    if (!initial || initial.isDeleted || initial.deleted || getOrderOpenid(initial) !== openid) return { success: false, error: "订单不存在或无权限" };
    return await withOrderMutex(`order:${orderId}`, async () => {
      const order = await source.get("orders", orderId);
      if (!order || order.isDeleted || order.deleted || getOrderOpenid(order) !== openid) return { success: false, error: "订单不存在或无权限" };
      if (canonicalStage(order) === WORKFLOW_STAGES.CANCELLED) {
        if (String(order.customerCancelIdempotencyKey || "") === idempotencyKey) {
          return { success: true, data: { orderId, status: "cancelled", workflowStage: WORKFLOW_STAGES.CANCELLED, idempotent: true } };
        }
        return { success: false, error: "订单已取消" };
      }
      const eligibility = customerCancellation(order);
      if (!eligibility.canCancel) return { success: false, error: eligibility.reason || "当前订单不支持自助取消" };
      let tickets = [];
      try { tickets = await source.list("afterSales"); } catch (_) { return { success: false, error: "售后数据暂不可用，请稍后重试" }; }
      if ((Array.isArray(tickets) ? tickets : []).some((ticket) => ticket && String(ticket.orderId || "") === orderId && !isAfterSaleTerminalStatus(ticket.status))) {
        return { success: false, error: "订单存在处理中售后，暂不能取消" };
      }
      const now = new Date().toISOString();
      const original = JSON.parse(JSON.stringify(order));
      const timeline = { id: makePaymentId("timeline"), type: "客户取消", action: "客户自助取消订单", operator: "customer", operatorId: openid, from: String(order.status || "new"), to: "cancelled", reason, createTime: now };
      const patch = {
        status: "cancelled", workflowStage: WORKFLOW_STAGES.CANCELLED, customerStatus: "已取消", customerCancelIdempotencyKey: idempotencyKey,
        cancelReason: reason, cancelledAt: now, cancelledBy: openid, updateTime: now,
        statusLogs: [...(Array.isArray(order.statusLogs) ? order.statusLogs : []), timeline],
        followRecords: [...(Array.isArray(order.followRecords) ? order.followRecords : []), timeline],
      };
      const updated = await source.update("orders", orderId, patch);
      if (!updated) return { success: false, error: "订单保存失败，请稍后重试" };
      try {
        await source.create("logs", { action: "客户取消订单", operator: "customer", operatorId: openid, targetType: "order", targetId: orderId, detail: reason, auditEvent: "customer_cancel", immutable: true, createTime: now });
      } catch (_) {
        try { await restoreChangedFields(source, "orders", orderId, original, Object.keys(patch)); } catch (__) {}
        return { success: false, error: "订单未取消，审计服务暂不可用" };
      }
      return { success: true, data: { orderId, status: "cancelled", workflowStage: WORKFLOW_STAGES.CANCELLED } };
    });
  } catch (error) {
    return { success: false, error: publicRpcError(error, "取消订单失败") };
  }
}

/* ============================ 售后 ============================ */
async function rpcSubmitAfterSale(source, openid, data = {}, ctx = {}) {
  if (!openid) return { success: false, error: "请先完成微信登录" };
  try {
    const order = await findOrder(source, String(data.orderId || ""), String(data.orderNo || ""));
    if (!order || getOrderOpenid(order) !== openid) return { success: false, error: "订单不存在或无权限" };
    return await withOrderMutex(`after-sale:${String(getItemId(order))}`, () => rpcSubmitAfterSaleUnlocked(source, openid, { ...data, orderId: getItemId(order) }, ctx));
  } catch (error) { return { success: false, error: publicRpcError(error, "提交失败") }; }
}
async function rpcSubmitAfterSaleUnlocked(source, openid, data = {}, ctx = {}) {
  if (!openid) return { success: false, error: "请先完成微信登录" };
  const { orderId = "", orderNo = "", packageName = "", reason = "", type = "退款申请" } = data;
  const normalizedReason = String(reason || "").trim();
  if (!orderId && !orderNo) return { success: false, error: "缺少订单信息" };
  if (normalizedReason.length < 5) return { success: false, error: "售后原因至少填写 5 个字" };
  try {
    const order = await findOrder(source, orderId, orderNo);
    if (!order || order.isDeleted || order.deleted) return { success: false, error: "订单不存在" };
    if (openid && getOrderOpenid(order) !== openid) return { success: false, error: "无权限申请该订单售后" };
    if (canonicalStage(order) === WORKFLOW_STAGES.CANCELLED) return { success: false, error: "已取消订单不能重复发起售后" };
    const orderKey = getItemId(order);
    // A customer can submit only one active ticket per order. This keeps retries
    // idempotent when the mobile network repeats the request.
    let tickets = [];
    try { tickets = await source.list("afterSales"); } catch (_) { return { success: false, error: "售后数据暂不可用，请稍后重试" }; }
    const duplicate = (Array.isArray(tickets) ? tickets : []).find((ticket) =>
      ticket && String(ticket.orderId || "") === String(orderKey) &&
      !isAfterSaleTerminalStatus(ticket.status)
    );
    if (duplicate) return { success: true, data: { status: duplicate.status || "pending", ticketId: getItemId(duplicate), existed: true } };
    const attachmentFileIds = data.attachmentFileIds === undefined ? [] : data.attachmentFileIds;
    if (!Array.isArray(attachmentFileIds) || attachmentFileIds.length > 9 || attachmentFileIds.some((id) => typeof id !== "string" || !id)) return { success: false, error: "售后凭证列表无效，最多上传 9 张图片" };
    if (attachmentFileIds.length) {
      if (!ctx.files) return { success: false, error: "文件服务暂不可用" };
      await ctx.files.assertFiles({ kind: "public", openid }, attachmentFileIds, { purpose: "after-sale", orderId: orderKey });
    }
    const now = new Date().toISOString();
    const ticketId = `as_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const ticket = {
      id: ticketId,
      _id: ticketId,
      orderId: orderKey,
      orderNo: order.orderNo || orderNo || "",
      openid,
      type: String(type || "退款申请").trim() || "退款申请",
      status: "pending",
      customerVisibleStatus: "处理中",
      reason: normalizedReason,
      packageName: packageName || order.packageName || "",
      submitSource: "mini_program",
      attachmentFileIds: [...new Set(attachmentFileIds)],
      logs: [],
      createdAt: now,
      updatedAt: now,
    };
    let createdTicket = false;
    let updated = null;
    try {
      await source.create("afterSales", ticket);
      createdTicket = true;
      updated = await source.update("orders", orderKey, {
        afterSaleStatus: "pending", afterSaleReason: normalizedReason, afterSaleCreateTime: now,
        afterSaleId: ticketId,
        followRecords: [...(order.followRecords || []), { type: "afterSale", status: "pending", reason: normalizedReason, packageName: packageName || order.packageName || "", operator: "customer", operatorId: openid, createTime: now }],
        statusLogs: [...(order.statusLogs || []), { type: "售后提交", action: "客户提交售后申请", operator: "customer", operatorId: openid, from: order.status, to: order.status, createTime: now }],
        updateTime: now,
      });
      if (!updated) throw new Error("关联订单保存失败");
      await source.create("logs", { action: "submitAfterSale", operator: openid, targetType: "order", targetId: orderKey, detail: normalizedReason, createTime: now });
    } catch (error) {
      if (createdTicket) { try { await source.remove("afterSales", ticketId); } catch (_) {} }
      if (updated) { try { await restoreChangedFields(source, "orders", orderKey, order, ["afterSaleStatus", "afterSaleReason", "afterSaleCreateTime", "afterSaleId", "followRecords", "statusLogs", "updateTime"]); } catch (_) {} }
      return { success: false, error: publicRpcError(error, "提交失败") };
    }
    if (attachmentFileIds.length) await ctx.files.markBound(attachmentFileIds);
    return { success: true, data: { status: updated.afterSaleStatus, ticketId } };
  } catch (err) {
    return { success: false, error: publicRpcError(err, "提交失败") };
  }
}

/* ============================ 商家码解析 ============================ */
async function rpcResolveMerchantCode(source, data = {}) {
  const c = data.c || "";
  const codeId = c.startsWith("c=") ? c.slice(2) : c;
  const codes = await source.list("merchantCodes");
  const code = codes.find(x => isActiveMerchantCode(x) && (getItemId(x) === codeId || x.scene === ("c=" + codeId) || x.codeId === codeId));
  if (!code) return { success: false, message: "二维码无效或已失效" };
  try {
    const shops = await source.list("shops");
    const shopId = String(code.shopId || code.shopCode || "");
    if (shopId && !(Array.isArray(shops) ? shops : []).some((shop) => isActiveShop(shop) && matchesShopId(shop, shopId))) {
      return { success: false, message: "二维码对应商家不存在或已停用" };
    }
  } catch (_) {
    return { success: false, message: "商家数据暂不可用，请稍后重试" };
  }
  try {
    const id = getItemId(code);
    if (id && typeof source.update === "function") {
      await source.update("merchantCodes", id, { scanCount: (Number(code.scanCount) || 0) + 1, lastScanTime: new Date().toISOString() });
    }
  } catch (_) { /* scan metrics must not block a valid landing */ }
  return { success: true, shopId: code.shopId, shopName: code.shopName, placementType: code.placementType, placementLabel: code.placementLabel, codeId: getItemId(code), scene: code.scene };
}
