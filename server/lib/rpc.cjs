// 自托管 RPC：完整复刻原小程序云函数（getHomeData / getSpots / createBooking / ...）。
// 小程序端把 wx.cloud.callFunction({name,data}) 改为 wx.request POST /api/rpc/{name}，
// 请求体形如 { data: {...} }（也兼容直接传 {...}），这里用自托管数据源实现原函数逻辑。
// 集合映射：云开发 travel_photos -> samples，bookings -> orders，config/homeStats -> homeConfig/homeStats。
// openid：云函数用 cloud.getWXContext().OPENID；自托管由 login 接口下发，小程序每次请求注入 data.openid。
const crypto = require("crypto");
const https = require("https");

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
    case "getGuides": return await rpcGetGuides(source, data);
    case "getMyOrders":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcGetMyOrders(source, openid, data);
    case "getOrderDetail":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcGetOrderDetail(source, openid, data);
    case "createBooking":
    case "createOrder": return await rpcCreateBooking(source, withIdentity(), ctx);
    case "updateOrderStatus":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcUpdateOrderStatus(source, openid, data);
    case "submitAfterSale":
      if (!openid) return { success: false, error: "请先完成微信登录" };
      return await rpcSubmitAfterSale(source, openid, data);
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
  if (!item || item.isDeleted === true || item.deleted === true || item.isShow === false || item.visible === false) return false;
  const hiddenStatuses = ["draft", "pending", "reviewing", "rejected", "offline", "disabled", "down", "草稿", "待审", "待审核", "驳回", "下架", "停用", "禁用", "已下架"];
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
  if (!item || item.isDeleted === true || item.isShow === false) return false;
  const badStatuses = ["draft", "pending", "reviewing", "rejected", "offline", "disabled", "down", "草稿", "待审", "待审核", "驳回", "下架", "停用", "禁用", "已下"];
  const passAuditStatuses = ["approved", "pass", "passed", "published", "online", "已上", "已上架", "审核通过", "通过"];
  const status = String(item.status || item.saleStatus || "").toLowerCase();
  const auditStatus = String(item.auditStatus || item.reviewStatus || "").toLowerCase();
  if (status && badStatuses.includes(status)) return false;
  if (auditStatus && !passAuditStatuses.includes(auditStatus)) return false;
  return true;
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

function normalizeTags(item) {
  if (Array.isArray(item.serviceTags)) return item.serviceTags;
  if (Array.isArray(item.tags)) return item.tags;
  if (Array.isArray(item.styles)) return item.styles;
  if (typeof item.serviceTags === "string") return item.serviceTags.split(/[，,|]/).filter(Boolean);
  if (typeof item.tags === "string") return item.tags.split(/[，,|]/).filter(Boolean);
  return [];
}

function isVideoProduct(item) { return item && (item.serviceType === "video" || item.type === "video" || item.productType === "video"); }

function filterMediaByPackage(mediaList, currentPackage) {
  if (!currentPackage) return mediaList;
  const targetType = isVideoProduct(currentPackage) ? "video" : "image";
  return (mediaList || []).filter(item => (item.type || item.mediaType || "image") === targetType);
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
    return (await source.get("siteConfig", "global"))
      || (await source.get("siteConfig", "homeStats"))
      || (await source.get("config", "global"))
      || {};
  } catch (e) { return {}; }
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

/* 城市：探索页城市列表。enabled=false 时小程序端显示“（敬请期待）”，不剔除 */
async function rpcGetCities(source) {
  try {
    const cities = (await source.list("cities")).filter(c => c && c.isDeleted !== true);
    const shops = (await source.list("shops")).filter(s => s && s.isDeleted !== true);
    const list = cities.map(c => {
      const statusText = String(c.status || "").trim();
      const enabled = c.enabled === true || (c.enabled !== false && (!statusText || statusText === "运营中" || statusText === "营业中"));
      const name = c.name || c.cityName || "";
      const cityId = getItemId(c);
      const shopsCount = shops.filter(s => s.cityId === cityId || s.city === name || s.cityName === name).length;
      return { _id: cityId, name, code: c.code || c.cityCode || "", enabled, shopsCount };
    });
    return { success: true, data: list };
  } catch (err) {
    return { success: false, error: err.message, data: [] };
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
    if (Array.isArray(pp.sections) && pp.sections.length) data.sections = pp.sections;
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
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
    return { success: false, error: err.message };
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
    return { success: false, error: err.message };
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
    return { success: false, error: err.message };
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
    return { success: false, error: err.message };
  }
}

/* 短视频单品列表：与旅拍套餐并列的独立商品种类，支持 limit / spotId / seriesId 筛选 */
async function rpcGetVideoSingles(source, data = {}) {
  try {
    const limit = Math.min(Number(data.limit) || 50, 100);
    let list = (await source.list("packages"))
      .filter(p => isVideoSingleProduct(p) && isVisibleSimple(p))
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0) || String(b.createTime || "").localeCompare(String(a.createTime || "")));
    if (data.spotId) list = list.filter(p => p.spotId === data.spotId || (Array.isArray(p.spotIds) && p.spotIds.includes(data.spotId)));
    if (data.seriesId) list = list.filter(p => p.seriesId === data.seriesId || (Array.isArray(p.seriesIds) && p.seriesIds.includes(data.seriesId)));
    return { success: true, data: list.slice(0, limit).map(normalizeVideoSinglePackage) };
  } catch (err) {
    return { success: false, error: err.message, data: [] };
  }
}

/* 订单状态分组与文案（与云函数一致） */
const STATUS_GROUPS = {
  pending: ["pending", "new", "contacted", "deposit_pending"],
  confirmed: ["deposit_paid", "confirmed", "assigned"],
  shooting: ["shooting"],
  editing: ["editing", "final_pending"],
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
  return ["editing", "final_pending", "delivered", "completed", "canceled", "cancelled"].includes(status);
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
  if (appid && secret && code) {
    try {
      const r = await wxGetJson(`/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`);
      if (r.openid) {
        await source.upsert("userProfiles", r.openid, { openid: r.openid, updateTime: new Date().toISOString() });
        return { success: true, openid: r.openid };
      }
      return { success: false, message: "微信登录失败: " + (r.errmsg || r.errcode || "未知错误") };
    } catch (e) {
      return { success: false, message: "微信登录请求失败: " + e.message };
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
      const tokenRes = await wxGetJson(`/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`);
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

    let banners = [];
    if (Array.isArray(config.carouselIds) && config.carouselIds.length) {
      const sampleMap = {};
      (await source.list("samples")).forEach(s => { if (s) sampleMap[getItemId(s)] = s; });
      banners = config.carouselIds
        .map(id => sampleMap[String(id)] || sampleMap[id])
        .filter(Boolean)
        .map(item => ({
          _id: item._id, url: item.url || item.cover || item.image || "", type: item.type || "image", mediaType: item.type || "image",
          cover: item.cover || item.poster || item.url || "", description: item.description || "",
          tag: item.tag || "", targetType: item.targetType || "", targetId: item.targetId || "", linkUrl: item.linkUrl || ""
        }));
    }
    if (!banners.length) banners = normalizeConfigBanners(config);
    if (!banners.length) {
      const showcase = (await source.list("samples")).filter(s => s.isShowcase && !s.isDeleted).slice(0, 6);
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

    const rawSpots = (await source.list("spots")).filter(isVisibleSimple);
    const spots = pickConfiguredList(rawSpots, recommendations.hotSpotIds || recommendations.spotIds, 12);

    const rawSeries = (await source.list("series")).filter(isVisibleSimple);
    const albums = (await source.list("albums")).filter(isVisibleSimple);
    const configuredAlbums = pickConfiguredList(albums, recommendations.featuredAlbumIds || recommendations.albumIds, 20);

    const albumCountMap = {};
    configuredAlbums.forEach(a => { if (a.seriesId) albumCountMap[a.seriesId] = (albumCountMap[a.seriesId] || 0) + 1; });
    const series = rawSeries.map(item => {
      const spotIds = Array.isArray(item.spotIds) ? item.spotIds : (item.spotId ? [item.spotId] : []);
      const firstSpot = spots.find(sp => sp._id === spotIds[0] || sp.id === spotIds[0]);
      return { ...item, albumCount: albumCountMap[item._id] || 0, firstSpotName: firstSpot ? firstSpot.name : "", spotCount: spotIds.length, packageCount: Array.isArray(item.packageIds) ? item.packageIds.length : 0 };
    });

    const rawPackages = (await source.list("packages")).filter(isVisibleSimple)
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0)).slice(0, 100);
    const packages = pickConfiguredList(rawPackages, recommendations.hotPackageIds || recommendations.packageIds, 20);
    // 短视频单品（独立商品种类）随首页一并下发，小程序端与 getVideoSingles 同源合并
    const videoSingles = rawPackages.filter(isVideoSingleProduct).slice(0, 50).map(normalizeVideoSinglePackage);

    const guides = pickConfiguredList(
      (await source.list("guides")).filter(isVisibleSimple).sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || ""))).slice(0, 20),
      recommendations.guideIds, 8
    );
    const peripherals = pickConfiguredList(
      (await source.list("peripherals")).filter(isVisibleSimple).slice(0, 20),
      recommendations.peripheralIds, 8
    );

    let shopInfo = {};
    if (data.shopId) {
      const shop = await source.get("shops", data.shopId);
      if (shop && shop.name) shopInfo = { name: shop.name, logo: shop.logo || "", description: shop.description || "" };
    }
    if (!shopInfo.name) shopInfo = { name: "鹿小鸣旅拍", logo: "", description: "长沙专业旅拍" };

    return { success: true, data: { shopInfo, activityText, banners, exploreBanners, spots, series, albums: configuredAlbums, packages, videoSingles, guides, peripherals, modules, quickNav: config.quickNav || [], pageConfig: { homeModules: modules, recommendations, pageModules } } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ============================ 打卡点 ============================ */
async function rpcGetSpots(source, data = {}) {
  try {
    const limit = Math.min(Number(data.limit) || 100, 100);
    const list = (await source.list("spots"))
      .filter(isVisibleSimple)
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0) || String(b.createTime || "").localeCompare(String(a.createTime || "")))
      .slice(0, limit)
      .map(item => ({
        _id: item._id, name: item.name || "",
        cover: item.cover || item.coverUrl || item.image || "",
        coverUrl: item.coverUrl || item.cover || item.image || "",
        description: item.description || item.desc || item.intro || "",
        address: item.address || "",
        tags: Array.isArray(item.tags) ? item.tags : (item.tag ? [item.tag] : []),
        hotScore: item.hotScore || 0,
        visitCount: item.visitCount || item.peopleCount || item.scanCount || 0,
        shopId: item.shopId || ""
      }));
    return { success: true, data: list };
  } catch (err) {
    return { success: false, error: err.message || "获取打卡点失败", data: [] };
  }
}

/* ============================ 预约页基础数据 ============================ */
async function rpcGetBookingData(source) {
  try {
    const spots = (await source.list("spots")).filter(isVisibleSimple);
    const rawSeries = (await source.list("series")).filter(isVisibleSimple);
    const allPackages = (await source.list("packages")).filter(isVisibleSimple);
    const albums = (await source.list("albums")).filter(isVisibleSimple);
    const photos = (await source.list("samples"));
    const albumCountMap = {};
    albums.forEach(a => { if (a.seriesId) albumCountMap[a.seriesId] = (albumCountMap[a.seriesId] || 0) + 1; });
    const photoCountMap = {};
    photos.forEach(p => { if (p.albumId) photoCountMap[p.albumId] = (photoCountMap[p.albumId] || 0) + 1; });
    const allSeries = rawSeries.map(s => ({
      ...s,
      albumCount: albumCountMap[s._id] || 0,
      packageCount: Array.isArray(s.packageIds) ? s.packageIds.length : 0,
      firstSpotName: (() => { if (s.spotIds && s.spotIds.length) { const sp = spots.find(x => x._id === s.spotIds[0]); return sp ? sp.name : ""; } return ""; })()
    }));
    const hotPackages = allPackages.filter(p => p.isHot || p.isMainPush || p.mainPush);
    return { success: true, data: { spots, allSeries, albums, hotPackages, allPackages } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ============================ 系列列表 ============================ */
async function rpcGetSeriesList(source, data = {}) {
  try {
    const { type, spotId, page = 1, pageSize = 10 } = data;
    let list = (await source.list("series")).filter(isVisibleSimple);
    if (type) list = list.filter(s => s.productType === type || s.type === type);
    if (spotId) list = list.filter(s => (Array.isArray(s.spotIds) && s.spotIds.includes(spotId)) || s.spotId === spotId);
    list.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));
    const total = list.length;
    const start = (Number(page) - 1) * Number(pageSize);
    const paged = list.slice(start, start + Number(pageSize)).map(s => ({
      ...s, spotCount: Array.isArray(s.spotIds) ? s.spotIds.length : 0, packageCount: Array.isArray(s.packageIds) ? s.packageIds.length : 0
    }));
    return { success: true, data: paged, total, page: Number(page), pageSize: Number(pageSize) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ============================ 系列详情 ============================ */
async function rpcGetSeriesDetail(source, data = {}) {
  try {
    const { seriesId: inputSeriesId, packageId = "", spotId = "" } = data;
    let seriesId = inputSeriesId || "";
    let currentPackage = null;

    if (packageId) {
      currentPackage = await source.get("packages", packageId);
      if (currentPackage && !isVisibleSimple(currentPackage)) return { success: false, error: "套餐已下架" };
      if (!seriesId && currentPackage) seriesId = currentPackage.seriesId || (Array.isArray(currentPackage.seriesIds) ? currentPackage.seriesIds[0] : "");
    }
    if (!seriesId && packageId) {
      const byPkg = (await source.list("series")).find(s => (Array.isArray(s.packageIds) && s.packageIds.includes(packageId)) || s.packageId === packageId || (Array.isArray(s.packages) && s.packages.includes(packageId)));
      if (byPkg) seriesId = byPkg._id;
    }
    if (!seriesId) {
      if (currentPackage) return buildPackageOnlyResponse(currentPackage, spotId);
      return { success: false, error: "缺少套餐或系列ID" };
    }

    const series = await source.get("series", seriesId);
    if (!series || !isVisibleSimple(series)) return { success: false, error: "系列不存在" };

    const seriesSpotIds = Array.isArray(series.spotIds) ? series.spotIds : (series.spotId ? [series.spotId] : []);
    const currentSpotId = spotId || seriesSpotIds[0] || "";

    let spots = [];
    if (seriesSpotIds.length) {
      const allSpots = await source.list("spots");
      spots = seriesSpotIds.map(id => allSpots.find(s => s._id === id || s.id === id)).filter(Boolean).map(s => ({
        _id: s._id, name: s.name || "", cover: normalizeImage(s), address: s.address || "", description: s.description || s.desc || ""
      }));
    }

    const allSamples = (await source.list("samples")).filter(s => s.seriesId === seriesId && !s.isDeleted);
    const samples = allSamples.filter(s => s.isShowcase).slice(0, 8);
    const photos = allSamples.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || ""))).slice(0, 30);

    const albums = (await source.list("albums")).filter(a => a.seriesId === seriesId && a.isShow !== false && !a.isDeleted)
      .sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || ""))).slice(0, 30)
      .map(a => ({ ...a, cover: normalizeImage(a), sampleUrls: a.sampleUrls || a.photos || [], photoCount: a.photoCount || (a.sampleUrls ? a.sampleUrls.length : 0) }));

    const allPackages = (await source.list("packages")).filter(isVisibleSimple)
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0));
    const mainPushPackages = allPackages.filter(p => p.isMainPush === true || p.isFeatured === true)
      .map(p => ({ ...p, serviceTags: normalizeTags(p), cover: normalizeImage(p) }));
    const mainPushIds = mainPushPackages.map(p => p._id);
    const spotPackages = allPackages.filter(p => {
      const belongs = p.spotId === currentSpotId || (Array.isArray(p.spotIds) && p.spotIds.includes(currentSpotId));
      return belongs && !mainPushIds.includes(p._id);
    }).map(p => ({ ...p, serviceTags: normalizeTags(p), cover: normalizeImage(p) }));
    const seriesPackages = allPackages.filter(p => p.seriesId === seriesId || (Array.isArray(series.packageIds) && series.packageIds.includes(p._id)))
      .map(p => ({ ...p, serviceTags: normalizeTags(p), cover: normalizeImage(p) }));
    if (currentPackage && !seriesPackages.some(p => p._id === currentPackage._id)) {
      seriesPackages.unshift({ ...currentPackage, serviceTags: normalizeTags(currentPackage), cover: normalizeImage(currentPackage) });
    }

    const prices = [...albums.map(a => Number(a.price || 0)), ...mainPushPackages.map(p => Number(p.price || 0)), ...spotPackages.map(p => Number(p.price || 0))].filter(p => p > 0);
    const recommendedVideos = isVideoProduct(currentPackage) ? await getRecommendedVideos(source, { currentPackage: currentPackage || {}, series, currentSpotId }) : [];

    const seriesStyles = Array.isArray(series.styles) ? series.styles : (series.style ? [series.style] : normalizeTags(series));
    return {
      success: true,
      data: {
        series: { ...series, cover: normalizeImage(series), styles: seriesStyles, minPrice: prices.length ? Math.min(...prices) : (series.minPrice || 0), maxPrice: prices.length ? Math.max(...prices) : (series.maxPrice || 0) },
        currentPackage: currentPackage ? { ...currentPackage, serviceTags: normalizeTags(currentPackage), cover: normalizeImage(currentPackage) } : null,
        currentSpotId,
        spots,
        samples: filterMediaByPackage(samples, currentPackage),
        photos: filterMediaByPackage(photos, currentPackage),
        recommendedVideos,
        albums,
        packages: seriesPackages,
        mainPushPackages,
        spotPackages
      }
    };
  } catch (err) {
    return { success: false, error: err.message || "获取系列详情失败" };
  }
}

function buildPackageOnlyResponse(currentPackage, spotId = "") {
  const normalizedPackage = { ...currentPackage, serviceTags: normalizeTags(currentPackage), cover: normalizeImage(currentPackage) };
  const price = Number(currentPackage.price || 0);
  return {
    success: true,
    data: {
      series: { _id: "", name: currentPackage.name || "套餐详情", cover: normalizeImage(currentPackage), styles: normalizeTags(currentPackage), intro: currentPackage.description || currentPackage.intro || "", minPrice: price, maxPrice: price, soldCount: currentPackage.soldCount || 0 },
      currentPackage: normalizedPackage,
      currentSpotId: spotId || currentPackage.spotId || "",
      spots: [],
      samples: [{ _id: "package-cover", url: normalizeImage(currentPackage), type: "image" }],
      photos: [],
      albums: [],
      packages: [normalizedPackage],
      mainPushPackages: [normalizedPackage],
      spotPackages: []
    }
  };
}

async function getRecommendedVideos(source, { currentPackage = {}, series = {}, currentSpotId = "" }) {
  const configuredIds = [
    ...(currentPackage.recommendedVideoIds || []), ...(currentPackage.recommendVideoIds || []),
    ...(series.recommendedVideoIds || []), ...(series.recommendVideoIds || [])
  ].filter(Boolean);
  let found = [];
  if (configuredIds.length) found = (await source.list("samples")).filter(s => configuredIds.includes(s._id) && (s.type || s.mediaType) === "video");
  if (!found.length) {
    const seriesId = series._id || "";
    found = (await source.list("samples")).filter(s => (s.type || s.mediaType) === "video" && (s.seriesId === seriesId || s.spotId === currentSpotId || s.isRecommend === true || s.isFeatured === true));
  }
  return found.map(normalizeVideoSample);
}

/* ============================ 样片合集详情 ============================ */
async function rpcGetPhotoCollection(source, data = {}) {
  const { seriesId, spotId } = data;
  if (!seriesId) return { success: false, error: "缺少系列ID" };
  try {
    const series = await source.get("series", seriesId);
    if (!series || !isVisibleSimple(series)) return { success: false, error: "系列不存在" };

    let spots = [];
    if (series.spotIds && series.spotIds.length) {
      const allSpots = await source.list("spots");
      spots = series.spotIds.map(id => allSpots.find(s => s._id === id || s.id === id)).filter(Boolean).map(s => ({ _id: s._id, name: s.name }));
    }
    series.spots = spots;

    const samplesAll = (await source.list("samples")).filter(s => s.seriesId === seriesId && !s.isDeleted);
    series.samples = samplesAll.filter(s => s.isShowcase).slice(0, 5);
    const photos = samplesAll.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));

    let packages = [];
    if (series.packageIds && series.packageIds.length) {
      const byIds = await source.list("packages");
      packages = byIds.filter(p => series.packageIds.includes(p._id) && isVisibleSimple(p));
    }
    let featuredPackages = (await source.list("packages")).filter(p => p.isFeatured === true && isVisibleSimple(p))
      .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0)).slice(0, 10);
    let spotPackages = [];
    if (series.spotIds && series.spotIds.length) {
      const targetSpotId = spotId || series.spotIds[0];
      spotPackages = (await source.list("packages")).filter(p => p.spotId === targetSpotId && isVisibleSimple(p))
        .sort((a, b) => (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0)).slice(0, 10);
    }
    const albums = await source.list("albums");
    const firstAlbum = albums.find(a => a.seriesId === seriesId && isVisibleSimple(a));
    const albumPrice = firstAlbum ? (firstAlbum.price || 0) : 0;

    const collection = {
      seriesId: series._id, seriesName: series.name || "", intro: series.intro || "",
      spotName: photos.length ? (photos[0].spotName || "") : (spots.length ? spots[0].name : ""),
      spotId: series.spotIds ? series.spotIds[0] : "",
      albumId: "", coverImage: photos.length ? photos[0].url : (series.cover || "/images/placeholder.png"),
      sampleUrls: photos.map(p => p.url), photoCount: photos.length, price: albumPrice
    };

    return { success: true, data: { series, photos, packages, featuredPackages, spotPackages, collections: [collection] } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ============================ 周边 / 攻略 ============================ */
async function rpcGetPeripherals(source, data = {}) {
  try {
    const { cate } = data;
    let list = (await source.list("peripherals")).filter(isVisibleSimple);
    if (cate) list = list.filter(p => p.category === cate || p.cate === cate);
    list.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));
    return { success: true, data: list };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function rpcGetGuides(source, data = {}) {
  try {
    const { spotId } = data;
    let list = (await source.list("guides")).filter(g => g.isDeleted !== true && g.isShow !== false);
    if (spotId) list = list.filter(g => g.spotId === spotId);
    list.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));
    return { success: true, data: list };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ============================ 我的订单 ============================ */
function getOrderOpenid(order) { return order.openid || order._openid || ""; }

async function rpcGetMyOrders(source, openid, data = {}) {
  try {
    if (!openid) return { success: false, error: "请先完成微信登录" };
    const { status, page = 1, pageSize = 10 } = data;
    let list = await source.list("orders");
    list = list.filter(o => !o.isDeleted && !o.deleted && (!openid || getOrderOpenid(o) === openid));
    if (status && STATUS_GROUPS[status]) {
      const allowed = STATUS_GROUPS[status];
      list = list.filter(o => allowed.includes(o.status) || allowed.includes(o.customerStatus));
    }
    list.sort((a, b) => String(b.createTime || b.appointmentAt || "").localeCompare(String(a.createTime || a.appointmentAt || "")));
    const total = list.length;
    const start = (Number(page) - 1) * Number(pageSize);
    const paged = list.slice(start, start + Number(pageSize)).map(o => {
      const computed = customerStatusText(o.status);
      const customerStatus = shouldUseComputedStatus(o.status) ? computed : (o.customerStatus || computed);
      return { ...o, customerStatus, statusText: customerStatus };
    });
    return { success: true, data: paged, total, page: Number(page), pageSize: Number(pageSize) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function findOrder(source, orderId, orderNo) {
  if (orderId) return await source.get("orders", orderId);
  const all = await source.list("orders");
  return all.find(o => o.orderNo === orderNo) || null;
}

async function rpcGetOrderDetail(source, openid, data = {}) {
  const { orderId, orderNo = "" } = data;
  if (!orderId && !orderNo) return { success: false, error: "缺少订单ID" };
  try {
    if (!openid) return { success: false, error: "请先完成微信登录" };
    const order = await findOrder(source, orderId, orderNo);
    if (!order || order.isDeleted || order.deleted) return { success: false, error: "订单不存在" };
    if (openid && getOrderOpenid(order) !== openid) return { success: false, error: "无权限" };

    const d = { ...order };
    d.customerStatus = shouldUseComputedStatus(d.status) ? customerStatusText(d.status) : (d.customerStatus || customerStatusText(d.status));
    d.paidAmount = Number(d.depositPaid || d.depositAmount || 0) + Number(d.finalPaid || 0);
    d.dueAmount = Math.max(Number(d.totalPrice || d.price || d.totalAmount || 0) - d.paidAmount, 0);
    return {
      success: true,
      data: {
        _id: getItemId(d), orderNo: d.orderNo, status: d.status, statusText: d.customerStatus, customerStatus: d.customerStatus,
        packageName: d.packageName || (d.packageSnapshot && d.packageSnapshot.packageName) || (d.products && d.products[0] && d.products[0].name) || "",
        packagePrice: d.totalPrice || d.price || d.totalAmount || 0,
        productItems: d.productItems || d.items || d.products || [],
        spotName: d.spotName || "", seriesName: d.seriesName || "",
        date: d.date || d.appointmentAt || "", timePeriod: d.timePeriod || d.time || "",
        type: d.type || (d.packageSnapshot && d.packageSnapshot.serviceType) || "photo",
        contactName: d.contactName || d.name || d.customer || "",
        contactPhone: d.contactPhone || d.phone || "",
        contactWechat: d.contactWechat || d.wechat || "",
        message: d.message || d.customerRemark || "",
        paidAmount: d.paidAmount, dueAmount: d.dueAmount
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function rpcOrderStatusCount(source, openid) {
  try {
    if (!openid) return { success: false, error: "请先完成微信登录" };
    const all = (await source.list("orders")).filter(o => !o.isDeleted && !o.deleted && (!openid || getOrderOpenid(o) === openid));
    const groups = { pending: ["pending", "new", "contacted", "deposit_pending"], shooting: ["shooting"], editing: ["editing", "final_pending"], completed: ["delivered", "completed"] };
    const result = {};
    for (const key of Object.keys(groups)) {
      result[key] = all.filter(o => groups[key].includes(o.status) || groups[key].includes(o.customerStatus)).length;
    }
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
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
  const [packages, albums, peripherals, site] = await Promise.all([
    source.list("packages"),
    source.list("albums"),
    source.list("peripherals"),
    getSiteGlobal(source),
  ]);
  const packageMap = new Map((packages || []).map((row) => [getItemId(row), row]));
  const albumMap = new Map((albums || []).map((row) => [getItemId(row), row]));
  const peripheralMap = new Map((peripherals || []).map((row) => [getItemId(row), row]));
  const customConfig = site && site.customPrice ? site.customPrice : {};
  let total = 0;
  const resolved = [];
  for (const input of items) {
    const item = input && typeof input === "object" ? { ...input } : {};
    let product = null;
    let productType = "";
    if (item.packageId) { product = packageMap.get(String(item.packageId)); productType = "package"; }
    else if (item.albumId) { product = albumMap.get(String(item.albumId)); productType = "album"; }
    else if (item.peripheralId) { product = peripheralMap.get(String(item.peripheralId)); productType = "peripheral"; }
    if (item.custom === true) {
      const count = Math.min(Math.max(Number(item.participantCount || item.count || 1), 1), 20);
      const base = Number(customConfig.singlePersonPrice ?? customConfig.single ?? 200);
      const extra = Number(customConfig.perExtraPerson ?? customConfig.extraPerPerson ?? 100);
      item.price = Math.max(0, base + Math.max(count - 1, 0) * extra);
      item.participantCount = count;
      productType = "custom";
    } else {
      if (!product || !isVisibleSimple(product)) return { error: "预约商品不存在或已下架" };
      const canonicalId = getItemId(product);
      if (productType === "package") item.packageId = canonicalId;
      if (productType === "album") item.albumId = canonicalId;
      if (productType === "peripheral") item.peripheralId = canonicalId;
      item.name = item.name || product.name || product.title || "";
      item.price = Number(product.specialPrice || product.price || product.salePrice || 0);
    }
    item.productType = item.productType || productType;
    if (!Number.isFinite(Number(item.price)) || Number(item.price) < 0) return { error: "预约商品价格无效" };
    total += Number(item.price);
    resolved.push(item);
  }
  return { items: resolved, totalPrice: total };
}

async function rpcCreateBooking(source, data = {}) {
  const openid = data.openid || "";
  const {
    shopId, spotId, seriesId, packageId, name, phone, contactPhones = [], wechat, date, timePeriod, timeSlot, time, message, price, scene, items = [], totalPrice, codeId, placementType, placementLabel
  } = data;
  if (!openid) return { success: false, error: "请先完成微信登录" };
  const itemList = Array.isArray(items) ? items : [];
  const normalizedItems = itemList.length ? itemList : [{ spotId: spotId || "", seriesId: seriesId || "", albumId: data.albumId || "", packageId: packageId || "", price: price || 0 }];
  const packageIds = Array.from(new Set(normalizedItems.map(i => i.packageId).filter(Boolean)));
  const timeValue = time || timePeriod || timeSlot || "";
  if (!String(name || "").trim() || !String(phone || "").trim() || !String(date || "").trim() || !String(timeValue || "").trim()) {
    return { success: false, error: "请完整填写姓名、手机号、预约日期和时间" };
  }
  const hasBookingItem = !!packageId || !!data.albumId || !!seriesId || normalizedItems.some(item => item && (item.custom === true || item.packageId || item.albumId || item.seriesId));
  if (!hasBookingItem) return { success: false, error: "请选择预约拍摄项目" };
  const src = buildSource({ shopId, scene, codeId, placementType, placementLabel });
  const normalizedContactPhones = [phone, ...(contactPhones || [])].map(String).map(s => s.trim()).filter((s, i, l) => s && l.indexOf(s) === i);

  const now = new Date();
  const dateStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, "0")}${now.getDate().toString().padStart(2, "0")}`;
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  const orderNo = `LS${dateStr}${rand}`;

  try {
    const resolvedItems = await resolveBookingItems(source, normalizedItems);
    if (resolvedItems.error) return { success: false, error: resolvedItems.error };
    const bookingItems = resolvedItems.items;
    const serverTotalPrice = resolvedItems.totalPrice;
    let pkgNameMap = {};
    if (packageIds.length) {
      const pkgs = (await source.list("packages")).filter(p => packageIds.includes(getItemId(p)));
      if (pkgs.length !== packageIds.length) return { success: false, error: "部分套餐不存在或已下架" };
      pkgNameMap = Object.fromEntries(pkgs.map(p => [getItemId(p), p.name || ""]));
      for (const pkg of pkgs) {
        if (!isVisibleSimple(pkg)) return { success: false, error: `${pkg.name || "套餐"}暂不可预约` };
        const conflict = [...(pkg.mutexPackageIds || []), ...(pkg.conflictPackageIds || []), ...(pkg.exclusivePackageIds || [])].find(id => packageIds.includes(id));
        if (conflict) return { success: false, error: "所选套餐不可同时预约，请分开下单" };
        const minAdvance = Number(pkg.minAdvanceDays || pkg.advanceBookingDays || pkg.advanceDays || 0);
        if (minAdvance > 0 && daysUntil(date) < minAdvance) return { success: false, error: `${pkg.name || "套餐"}需至少提前${minAdvance}天预约` };
        const dayLimit = Number(pkg.dailyLimit || pkg.maxDailyBookings || pkg.appointmentLimit || 0);
        if (dayLimit > 0) {
          const active = (await source.list("orders")).filter(o => !o.isDeleted && ACTIVE_ORDER_STATUSES.includes(o.status) && o.date === date && orderHasPackage(o, getItemId(pkg)) && orderMatchesTime(o, timeValue));
          if (active.length >= dayLimit) return { success: false, error: `${pkg.name || "套餐"}当前日期预约已满` };
        }
      }
    }

    const doc = {
      openid,
      shopId: src.shopId || "",
      scene: scene || "",
      source: src,
      sourceCodeId: src.sourceCodeId || "",
      sourceType: src.sourceType,
      sourceChannel: src.channel,
      distributorId: src.distributorId,
      spotId: spotId || (normalizedItems[0] && normalizedItems[0].spotId) || "",
      spotName: (normalizedItems[0] && normalizedItems[0].spotName) || "",
      seriesId: seriesId || (normalizedItems[0] && normalizedItems[0].seriesId) || "",
      seriesName: (normalizedItems[0] && normalizedItems[0].seriesName) || "",
      packageId,
      packageName: (normalizedItems[0] && normalizedItems[0].packageName) || (packageId && pkgNameMap[packageId]) || "",
      name,
      contactName: name,
      phone,
      contactPhone: phone,
      contactPhones: normalizedContactPhones,
      wechat: wechat || "",
      contactWechat: wechat || "",
      date,
      timePeriod: timeValue,
      timeSlot: timeValue,
      time: timeValue,
      message: message || "",
      items: bookingItems,
      productItems: bookingItems,
      packageSnapshot: bookingItems[0] || {},
      price: serverTotalPrice,
      totalPrice: serverTotalPrice,
      depositDue: 0,
      depositPaid: 0,
      finalPaid: 0,
      bookingMode: "consult",
      status: "new",
      customerStatus: "预约待确认",
      serviceUser: "", serviceUserId: "", photographer: "", photographerId: "",
      serviceNote: "", deliveryNote: "",
      paymentRecords: [],
      followRecords: [{ type: "客户预约", operator: "系统", note: message ? ("客户备注：" + message) : "客户提交预约", createTime: new Date().toISOString() }],
      orderNo,
      isDeleted: false,
      createTime: new Date().toISOString()
    };
    const created = await source.create("orders", doc);
    return { success: true, orderId: getItemId(created), orderNo };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ============================ 订单状态变更（客人自助取消/删除） ============================ */
const GUEST_CANCELABLE = ["pending", "new", "deposit_paid"];
async function rpcUpdateOrderStatus(source, openid, data = {}) {
  if (!openid) return { success: false, error: "请先完成微信登录" };
  const { orderId, newStatus, note = "" } = data;
  if (!orderId || !newStatus) return { success: false, error: "参数不全" };
  try {
    const order = await source.get("orders", orderId);
    if (!order || order.isDeleted || order.deleted) return { success: false, error: "订单不存在" };
    const owner = getOrderOpenid(order);

    if (newStatus === "canceled" && GUEST_CANCELABLE.includes(order.status) && owner === openid) {
      return await applyStatusChange(source, { orderId, beforeStatus: order.status, newStatus, operatorName: "客人自助", openid, note });
    }
    if (newStatus === "deleted" && ["canceled", "cancelled"].includes(order.status) && owner === openid) {
      await source.update("orders", orderId, { isDeleted: true, status: "deleted", customerStatus: "已删除", updateTime: new Date().toISOString() });
      return { success: true };
    }
    return { success: false, error: "该状态变更需由客服在后台操作" };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
async function applyStatusChange(source, { orderId, beforeStatus, newStatus, operatorName, openid, note = "" }) {
  const order = await source.get("orders", orderId);
  const follow = { type: "状态变更", operator: operatorName, operatorId: openid, note: note || `${beforeStatus || "空"} -> ${newStatus}`, from: beforeStatus || "", to: newStatus, createTime: new Date().toISOString() };
  const updated = await source.update("orders", orderId, {
    status: newStatus, customerStatus: customerStatusText(newStatus), updateTime: new Date().toISOString(),
    followRecords: [...(order.followRecords || []), follow]
  });
  await source.create("logs", { action: "updateOrderStatus", operator: openid, operatorName: operatorName || "", targetType: "order", targetId: orderId, detail: `状态由${beforeStatus || "空"}更新为${newStatus}`, createTime: new Date().toISOString() });
  return { success: true, customerStatus: customerStatusText(newStatus) };
}

/* ============================ 售后 ============================ */
async function rpcSubmitAfterSale(source, openid, data = {}) {
  if (!openid) return { success: false, error: "请先完成微信登录" };
  const { orderId = "", orderNo = "", packageName = "", reason = "", type = "退款申请" } = data;
  const normalizedReason = String(reason || "").trim();
  if (!orderId && !orderNo) return { success: false, error: "缺少订单信息" };
  if (normalizedReason.length < 5) return { success: false, error: "售后原因至少填写 5 个字" };
  try {
    const order = await findOrder(source, orderId, orderNo);
    if (!order || order.isDeleted || order.deleted) return { success: false, error: "订单不存在" };
    if (openid && getOrderOpenid(order) !== openid) return { success: false, error: "无权限申请该订单售后" };
    const orderKey = getItemId(order);
    // A customer can submit only one active ticket per order. This keeps retries
    // idempotent when the mobile network repeats the request.
    let tickets = [];
    try { tickets = await source.list("afterSales"); } catch (_) { tickets = []; }
    const duplicate = (Array.isArray(tickets) ? tickets : []).find((ticket) =>
      ticket && String(ticket.orderId || "") === String(orderKey) &&
      String(ticket.openid || ticket.operatorId || "") === String(openid) &&
      !["completed", "closed", "已完", "已结案"].includes(String(ticket.status || ""))
    );
    if (duplicate) return { success: true, data: { status: duplicate.status || "pending", ticketId: getItemId(duplicate), existed: true } };
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
      logs: [],
      createdAt: now,
      updatedAt: now,
    };
    await source.create("afterSales", ticket);
    const updated = await source.update("orders", orderKey, {
      afterSaleStatus: "pending", afterSaleReason: normalizedReason, afterSaleCreateTime: now,
      afterSaleId: ticketId,
      followRecords: [...(order.followRecords || []), { type: "afterSale", status: "pending", reason: normalizedReason, packageName: packageName || order.packageName || "", operator: "customer", operatorId: openid, createTime: now }]
    });
    await source.create("logs", { action: "submitAfterSale", operator: openid, targetType: "order", targetId: orderKey, detail: normalizedReason, createTime: now });
    return { success: true, data: { status: updated.afterSaleStatus, ticketId } };
  } catch (err) {
    return { success: false, error: err.message || "提交失败" };
  }
}

/* ============================ 商家码解析 ============================ */
async function rpcResolveMerchantCode(source, data = {}) {
  const c = data.c || "";
  const codeId = c.startsWith("c=") ? c.slice(2) : c;
  const codes = await source.list("merchantCodes");
  const code = codes.find(x => x._id === codeId || x.scene === ("c=" + codeId) || x.codeId === codeId);
  if (!code) return { success: false, message: "二维码无效或已失效" };
  try {
    const id = getItemId(code);
    if (id && typeof source.update === "function") {
      await source.update("merchantCodes", id, { scanCount: (Number(code.scanCount) || 0) + 1, lastScanTime: new Date().toISOString() });
    }
  } catch (_) { /* scan metrics must not block a valid landing */ }
  return { success: true, shopId: code.shopId, shopName: code.shopName, placementType: code.placementType, placementLabel: code.placementLabel, codeId: getItemId(code), scene: code.scene };
}
