"use strict";

const crypto = require("crypto");
const https = require("https");
const { withOrderMutex, hasConfirmedPayment, isUnpaidBooking } = require("./orderWorkflow.cjs");

const idOf = (row) => String(row && (row.id || row._id) || "");
function businessDate(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function active(row) {
  return !!row && !row.deleted && !row.isDeleted
    && !["disabled", "inactive", "expired", "停用", "已停用", "失效", "已失效", "终止合作"].includes(String(row.status || "").toLowerCase());
}
function requestBinary(url, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ...options, timeout: 8000 }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(new Error("微信小程序码响应过大"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on("error", () => reject(new Error("微信小程序码服务暂不可用")));
    request.on("timeout", () => request.destroy(new Error("微信小程序码请求超时")));
    request.end(body || undefined);
  });
}
function createQrProvider(options = {}) {
  const env = options.env || process.env;
  const request = options.request || requestBinary;
  let cachedToken = ""; let expiresAt = 0;
  return async function generate(scene) {
    const appId = String(env.WX_APP_ID || "").trim();
    const secret = String(env.WX_APP_SECRET || "").trim();
    if (!appId || !secret) throw new Error("请配置微信小程序凭据后生成门店码");
    if (!/^c=[A-Za-z0-9_-]{1,30}$/.test(scene)) throw new Error("小程序码来源参数无效");
    if (!cachedToken || Date.now() >= expiresAt) {
      const response = await request(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`);
      let result;
      try { result = JSON.parse(response.body.toString("utf8")); } catch (_) { throw new Error("微信凭据服务返回无效结果"); }
      if (response.status !== 200 || !result.access_token) throw new Error("微信小程序凭据验证失败");
      cachedToken = result.access_token;
      expiresAt = Date.now() + Math.max(Number(result.expires_in || 7200) - 120, 0) * 1000;
    }
    const version = ["release", "trial", "develop"].includes(env.WX_ENV_VERSION) ? env.WX_ENV_VERSION : "release";
    const body = JSON.stringify({ scene, page: "pages/scanEntry/scanEntry", check_path: version === "release", env_version: version, width: 280 });
    const response = await request(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(cachedToken)}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, body);
    const bytes = response.body;
    const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (response.status !== 200 || (!png && !jpeg)) {
      cachedToken = "";
      throw new Error("微信小程序码生成失败，请检查已发布落地页和微信配置");
    }
    const image = `data:image/${png ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
    if (Buffer.byteLength(image) > 60000) throw new Error("小程序码图片超出存储限制，请重试");
    return image;
  };
}
const defaultProvider = createQrProvider();

async function generateMerchantCode(source, input = {}, options = {}) {
  const requested = String(input.shopId || "").trim();
  if (!requested) return { success: false, error: "缺少 shopId" };
  const shops = await source.list("shops");
  const shop = (shops || []).find((row) => active(row) && [row.id, row._id, row.shopId].filter(Boolean).map(String).includes(requested));
  if (!shop) return { success: false, error: "门店不存在或已停用" };
  const shopId = String(shop.shopId || idOf(shop));
  return withOrderMutex(`merchant:${shopId}`, async () => {
    const codes = (await source.list("merchantCodes") || []).filter((row) => String(row.shopId || "") === shopId);
    const valid = codes.find((row) => active(row) && row.placementType === "fixed_shop" && /^data:image\/(?:png|jpeg);base64,/.test(row.qrImage || ""));
    if (valid) return { success: true, existed: true, codeId: idOf(valid), ...valid };
    // The deterministic primary key prevents two instances from allocating
    // different active codes for the same canonical shop.
    const codeId = `Q${crypto.createHash("sha256").update(shopId).digest("hex").slice(0, 24)}`;
    const scene = `c=${codeId}`;
    let qrImage;
    try { qrImage = await (options.provider || defaultProvider)(scene); }
    catch (error) { return { success: false, error: error.message || "门店码生成失败" }; }
    const now = new Date().toISOString();
    const existing = await source.get("merchantCodes", codeId);
    const doc = { ...(existing || {}), id: codeId, _id: codeId, shopId, shopName: shop.name || "", placementType: "fixed_shop", placementLabel: "门店统一码", fixedShopCode: true, scene, qrImage, status: "active", deleted: false, isDeleted: false, scanCount: Number(existing && existing.scanCount || 0), createTime: existing && existing.createTime || now, updateTime: now };
    if (existing) await source.update("merchantCodes", codeId, doc);
    else {
      try { await source.create("merchantCodes", doc); }
      catch (error) {
        if (!await source.get("merchantCodes", codeId)) throw error;
      }
    }
    for (const old of codes) if (idOf(old) !== codeId && active(old)) {
      await source.update("merchantCodes", idOf(old), { status: "disabled", replacedBy: codeId, updateTime: now });
    }
    return { success: true, existed: !!existing, codeId, ...doc };
  });
}

async function listMerchantCodes(source, shopId = "") {
  const codes = (await source.list("merchantCodes") || []).filter(active).filter((row) => !shopId || String(row.shopId || "") === String(shopId));
  const orders = (await source.list("orders") || []).filter((order) => !isUnpaidBooking(order));
  return codes.map((code) => {
    const rows = orders.filter((order) => !order.deleted && !order.isDeleted && String(order.sourceCodeId || order.source && order.source.codeId || "") === idOf(code));
    return { ...code, orderCount: rows.length, dealCount: rows.filter((order) => hasConfirmedPayment(order, "final") && !!(order.completedAt || order.finalConfirmedAt || order.finalPaidAt)).length };
  });
}
async function merchantCodeStats(source, shopId = "", date = businessDate()) {
  const codes = await listMerchantCodes(source, shopId);
  const scans = (await source.list("scans") || []).filter(active).filter((row) => !shopId || String(row.shopId || "") === String(shopId));
  const byDate = new Map();
  for (const scan of scans) {
    const day = scan.businessDate || businessDate(scan.createTime || scan.date);
    if (!day) continue;
    let bucket = byDate.get(day);
    if (!bucket) { bucket = { date: day, scans: 0, anonymousScans: 0, visitors: new Set() }; byDate.set(day, bucket); }
    bucket.scans += 1;
    if (scan.openid || scan.visitorKind === "wechat") bucket.visitors.add(scan.visitorHash || scan.openid);
    else bucket.anonymousScans += 1;
  }
  const daily = [...byDate.values()].map(({ visitors, ...row }) => ({ ...row, unique: visitors.size })).sort((a, b) => a.date.localeCompare(b.date));
  const selected = daily.find((row) => row.date === date) || { date, scans: 0, unique: 0, anonymousScans: 0 };
  return { scans: scans.length, orders: codes.reduce((sum, code) => sum + code.orderCount, 0), deals: codes.reduce((sum, code) => sum + code.dealCount, 0), codeCount: codes.length, todayUnique: selected.unique, dailyUnique: selected.unique, unique: selected.unique, anonymousScans: selected.anonymousScans, date, daily };
}

module.exports = { businessDate, active, createQrProvider, generateMerchantCode, listMerchantCodes, merchantCodeStats };
