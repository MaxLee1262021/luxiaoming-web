"use strict";

const https = require("node:https");
const rpc = require("./rpc.cjs");
const requestReadSource = require("./requestReadSource.cjs");

const ERROR_MESSAGES = Object.freeze({
  PRODUCT_LINK_INPUT_INVALID: "请选择有效的商品和链接有效期（1、7 或 30 天）",
  PRODUCT_LINK_NOT_FOUND: "商品不存在或已删除，请刷新列表",
  PRODUCT_LINK_UNAVAILABLE: "该商品当前无法在小程序访问，请检查上下架、审核及关联内容",
  PRODUCT_LINK_CATALOG_UNAVAILABLE: "商品目录暂不可用，请稍后重试",
  PRODUCT_LINK_CREDENTIALS_MISSING: "请先配置微信小程序 AppID 和 AppSecret",
  PRODUCT_LINK_TOKEN_REJECTED: "微信授权失败，请检查小程序凭据及服务器 IP 白名单",
  PRODUCT_LINK_API_UNAVAILABLE: "微信外链服务暂不可用，请稍后重试",
  PRODUCT_LINK_API_TIMEOUT: "微信外链请求超时，请稍后重试",
  PRODUCT_LINK_RESPONSE_INVALID: "微信外链服务返回无效结果，请稍后重试",
  PRODUCT_LINK_PAGE_INVALID: "微信拒绝生成外链，请确认对应小程序页面已发布且环境配置正确",
  PRODUCT_LINK_QUOTA_EXCEEDED: "微信外链生成额度或频率已达上限，请稍后重试",
  PRODUCT_LINK_API_REJECTED: "微信拒绝生成外链，请检查小程序 URL Link 权限及接口配置",
});
function linkError(code, statusCode = 503) {
  return Object.assign(new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.PRODUCT_LINK_API_UNAVAILABLE), {
    code: Object.hasOwn(ERROR_MESSAGES, code) ? code : "PRODUCT_LINK_API_UNAVAILABLE", statusCode,
  });
}
const ROUTES = Object.freeze({
  album: { collection: "albums", label: "照片留影", path: "pages/photoCollection/photoCollection", param: "albumId" },
  video: { collection: "packages", label: "视频摄像", path: "pages/videoProductDetail/videoProductDetail", param: "productId" },
  package: { collection: "packages", label: "旅拍套餐", path: "pages/photoPackageDetail/photoPackageDetail", param: "packageId" },
  peripheral: { collection: "peripherals", label: "周边商品", path: "pages/peripherals/peripherals", param: "id" },
});
const idOf = row => String(row && (row.id || row._id) || "");
const deleted = row => !row || row.deleted === true || row.isDeleted === true;
function isVideo(row) {
  return (row.isVideoSingle === true || row.productKind === "video_single")
    && [row.serviceType, row.type, row.productType, row.productKind, row.category].some(value => /video|短视频|视频/.test(String(value || "").toLowerCase()));
}
// The photo package page removes rows classified as video by the mini-program.
// Legacy video packages without the explicit single-product marker therefore
// have no supported destination and must not produce a misleading photo link.
function excludedFromPhotoDetail(row = {}) {
  if (["photo_single", "photo_package", "video_single", "peripheral"].includes(row.category)) return row.category === "video_single";
  const words = [row.category, row.serviceType, row.productType, row.type, row.displayType, row.productKind, row.kind, row.goodsType]
    .map(value => String(value || "").trim().toLowerCase());
  return !!row.videoId || row.isVideo === true || words.some(value => /video|短视频|视频/.test(value) || value.includes("single"));
}
function environment(env) { return ["release", "trial", "develop"].includes(env.WX_ENV_VERSION) ? env.WX_ENV_VERSION : "release"; }
function configured(env) { return !!(String(env.WX_APP_ID || "").trim() && String(env.WX_APP_SECRET || "").trim()); }
function safeText(value, limit) { return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : ""; }
function priceOf(row) {
  const values = row.specMode === "multiple" && Array.isArray(row.skus) && row.skus.length ? row.skus.map(sku => sku.price) : [row.price];
  const prices = values.filter(value => ["number", "string"].includes(typeof value) && String(value).trim() !== "").map(Number).filter(value => Number.isFinite(value) && value >= 0);
  return prices.length ? Math.min(...prices) : null;
}
function validLink(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && ["wxaurl.cn", "wxmpurl.cn"].includes(url.hostname) && url.pathname.length > 1;
  } catch (_) { return false; }
}

// No upstream response, request URL, credentials or token is returned in errors.
// Both the socket timeout and total deadline are bounded, including slow bodies.
function requestJson(url, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const deadline = setTimeout(() => {
      const error = linkError("PRODUCT_LINK_API_TIMEOUT");
      finish(error); if (req) req.destroy(error);
    }, 10000);
    try {
      req = https.request(url, { ...options, timeout: 8000 }, response => {
        const chunks = []; let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > 64 * 1024) {
            const error = linkError("PRODUCT_LINK_RESPONSE_INVALID");
            finish(error); response.destroy(error); req.destroy(error);
          } else chunks.push(chunk);
        });
        response.on("error", () => finish(linkError("PRODUCT_LINK_API_UNAVAILABLE")));
        response.on("aborted", () => finish(linkError("PRODUCT_LINK_API_UNAVAILABLE")));
        response.on("end", () => finish(null, { status: response.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on("error", () => finish(linkError("PRODUCT_LINK_API_UNAVAILABLE")));
      req.on("timeout", () => {
        const error = linkError("PRODUCT_LINK_API_TIMEOUT"); finish(error); req.destroy(error);
      });
      req.end(body || undefined);
    } catch (_) { finish(linkError("PRODUCT_LINK_API_UNAVAILABLE")); }
  });
}

function createUrlLinkProvider(options = {}) {
  const env = options.env || process.env;
  const request = options.request || requestJson;
  const now = options.now || Date.now;
  let token = "", tokenExpiresAt = 0, tokenPending = null, credentialKey = "";
  async function send(url, requestOptions, body) {
    let response;
    try { response = await request(url, requestOptions, body); }
    catch (error) { throw linkError(error?.code === "PRODUCT_LINK_API_TIMEOUT" ? error.code : "PRODUCT_LINK_API_UNAVAILABLE"); }
    if (!response || !Buffer.isBuffer(response.body) || response.body.length > 64 * 1024) throw linkError("PRODUCT_LINK_RESPONSE_INVALID");
    let result;
    try { result = JSON.parse(response.body.toString("utf8")); } catch (_) { throw linkError("PRODUCT_LINK_RESPONSE_INVALID"); }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw linkError("PRODUCT_LINK_RESPONSE_INVALID");
    if (response.status !== 200) throw linkError("PRODUCT_LINK_API_UNAVAILABLE");
    return result;
  }
  async function getToken() {
    if (!configured(env)) throw linkError("PRODUCT_LINK_CREDENTIALS_MISSING");
    const credentials = `${env.WX_APP_ID}\n${env.WX_APP_SECRET}`;
    if (credentialKey !== credentials) { credentialKey = credentials; token = ""; tokenExpiresAt = 0; tokenPending = null; }
    if (token && now() < tokenExpiresAt) return token;
    if (!tokenPending) {
      const pending = (async () => {
        const result = await send(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(String(env.WX_APP_ID).trim())}&secret=${encodeURIComponent(String(env.WX_APP_SECRET).trim())}`);
        if (!result.access_token || typeof result.access_token !== "string" || result.errcode) throw linkError("PRODUCT_LINK_TOKEN_REJECTED");
        // A concurrent configuration rotation must not populate the new cache.
        if (credentialKey === credentials) {
          token = result.access_token;
          const ttl = Number(result.expires_in);
          tokenExpiresAt = now() + Math.max(0, Math.min(Number.isFinite(ttl) ? ttl : 7200, 7200) - 120) * 1000;
        }
        return result.access_token;
      })();
      tokenPending = pending;
      pending.finally(() => { if (tokenPending === pending) tokenPending = null; }).catch(() => {});
    }
    return tokenPending;
  }
  return async function generate(target) {
    const body = JSON.stringify({ path: target.path, query: target.query, expire_type: 1, expire_interval: target.expireDays, env_version: target.environment });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const credential = await getToken();
      const result = await send(`https://api.weixin.qq.com/wxa/generate_urllink?access_token=${encodeURIComponent(credential)}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, body);
      const code = Number(result.errcode || 0);
      if ([40001, 40014, 42001].includes(code) && attempt === 0) {
        if (token === credential) { token = ""; tokenExpiresAt = 0; }
        continue;
      }
      if (code) {
        if ([40001, 40014, 42001].includes(code)) throw linkError("PRODUCT_LINK_TOKEN_REJECTED");
        if ([45009, 45011, 44990, 44991].includes(code)) throw linkError("PRODUCT_LINK_QUOTA_EXCEEDED", 429);
        if ([40165, 40212, 41030].includes(code)) throw linkError("PRODUCT_LINK_PAGE_INVALID", 400);
        throw linkError("PRODUCT_LINK_API_REJECTED");
      }
      if (!validLink(result.url_link)) throw linkError("PRODUCT_LINK_RESPONSE_INVALID");
      return result.url_link;
    }
    throw linkError("PRODUCT_LINK_TOKEN_REJECTED");
  };
}

function createProductLinksService(source, options = {}) {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const provider = options.provider || createUrlLinkProvider(options);
  const cache = new Map(), pending = new Map();

  async function loadCatalog() {
    // Reuse the exact public projection used by the mini-program, including
    // city/point visibility and bundle dependencies, without a second policy.
    const snapshot = requestReadSource(source);
    let rows, publicResult;
    try {
      [rows, publicResult] = await Promise.all([
        Promise.all(["albums", "packages", "peripherals"].map(key => snapshot.list(key))),
        rpc(snapshot, "getBookingData", {}),
      ]);
    } catch (_) { throw linkError("PRODUCT_LINK_CATALOG_UNAVAILABLE"); }
    if (!publicResult?.success || !publicResult.data) throw linkError("PRODUCT_LINK_CATALOG_UNAVAILABLE");
    const publicData = publicResult.data;
    const visible = {
      album: new Set((publicData.albums || []).map(idOf)),
      video: new Set((publicData.allPackages || []).filter(isVideo).map(idOf)),
      package: new Set((publicData.allPackages || []).filter(row => !isVideo(row) && !excludedFromPhotoDetail(row)).map(idOf)),
      peripheral: new Set((publicData.peripherals || []).map(idOf)),
    };
    const raw = [
      ...(rows[0] || []).map(row => ({ row, type: "album" })),
      ...(rows[1] || []).map(row => ({ row, type: isVideo(row) ? "video" : "package" })),
      ...(rows[2] || []).map(row => ({ row, type: "peripheral" })),
    ].filter(({ row }) => !deleted(row) && idOf(row));
    // A bundle with a stale series relation can appear in booking data but its
    // detail rejects that series. Check the actual detail contract as well.
    await Promise.all(raw.filter(({ row, type }) => type === "package" && visible.package.has(idOf(row))).map(async ({ row }) => {
      const detail = await rpc(snapshot, "getSeriesDetail", { packageId: idOf(row) });
      if (!detail?.success || idOf(detail.data?.currentPackage) !== idOf(row)) visible.package.delete(idOf(row));
    }));
    return raw.map(({ row, type }) => {
      const canGenerate = visible[type].has(idOf(row));
      const cover = [row.cover, row.coverUrl, row.coverImage, row.poster, row.image].find(value => typeof value === "string" && value.trim()) || "";
      return {
        id: idOf(row), type, typeLabel: ROUTES[type].label,
        name: safeText(row.name || row.title, 180) || "未命名商品", cover,
        price: priceOf(row), summary: safeText(row.summary || row.description || row.intro || row.desc || row.shootingNotes, 240),
        status: canGenerate ? "available" : "unavailable", statusLabel: canGenerate ? "可访问" : "暂不可访问",
        canGenerate, disabledReason: canGenerate ? "" : ERROR_MESSAGES.PRODUCT_LINK_UNAVAILABLE,
      };
    });
  }
  async function catalog() {
    return { items: await loadCatalog(), configured: configured(env), environment: environment(env) };
  }
  async function generate(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw linkError("PRODUCT_LINK_INPUT_INVALID", 400);
    const { type, id } = input;
    const daysValue = input.expireDays === undefined ? 30 : input.expireDays;
    const expireDays = Number(daysValue);
    if (!Object.hasOwn(ROUTES, type) || typeof id !== "string" || !id || id !== id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)
      || !["number", "string"].includes(typeof daysValue) || ![1, 7, 30].includes(expireDays)) throw linkError("PRODUCT_LINK_INPUT_INVALID", 400);
    const row = (await loadCatalog()).find(item => item.type === type && item.id === id);
    if (!row) throw linkError("PRODUCT_LINK_NOT_FOUND", 404);
    if (!row.canGenerate) throw linkError("PRODUCT_LINK_UNAVAILABLE", 409);
    if (!configured(env)) throw linkError("PRODUCT_LINK_CREDENTIALS_MISSING");
    const route = ROUTES[type];
    const target = { path: route.path, query: `${route.param}=${encodeURIComponent(id)}`, expireDays, environment: environment(env) };
    if (target.query.length > 1024) throw linkError("PRODUCT_LINK_INPUT_INVALID", 400);
    const key = JSON.stringify([String(env.WX_APP_ID).trim(), target]);
    // Availability was checked afresh before either a reused link or a pending
    // result can be returned. Cache is process-local and holds generated URLs only.
    for (const [cachedKey, result] of cache) if (Date.parse(result.expiresAt) <= now() + 60000) cache.delete(cachedKey);
    if (cache.has(key)) return { ...cache.get(key) };
    if (!pending.has(key)) {
      const promise = (async () => {
        const createdAt = now();
        const url = await provider(target);
        if (!validLink(url)) throw linkError("PRODUCT_LINK_RESPONSE_INVALID");
        const result = { url, expiresAt: new Date(createdAt + expireDays * 86400000).toISOString(), path: target.path, query: target.query, environment: target.environment };
        cache.set(key, result);
        if (cache.size > 1000) cache.delete(cache.keys().next().value);
        return result;
      })();
      pending.set(key, promise);
      promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); }).catch(() => {});
    }
    return { ...await pending.get(key) };
  }
  return { catalog, generate };
}

module.exports = { createProductLinksService, createUrlLinkProvider, ERROR_MESSAGES };
