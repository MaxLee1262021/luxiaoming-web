"use strict";

// Package contents are resolved once from the server's catalog at checkout.
// Payment retries and fulfillment use that frozen snapshot, never a later edit
// to the package or client-supplied includedItems/prices.
const { canonicalStage, hasConfirmedPayment, normalizePaymentStatus } = require("./orderWorkflow.cjs");
const { serviceFor } = require("./physicalCommerce.cjs");
const text = value => String(value == null ? "" : value).trim();
const idOf = row => text(row && (row.id || row._id));
const baseSource = source => source.bookingRequestSource || source;
const hasSnapshot = parent => !!parent?.physicalFulfillmentSnapshot?.items?.length;

function invalid(message) {
  throw Object.assign(new Error(message), { code: "PACKAGE_FULFILLMENT_INVALID", statusCode: 400 });
}
function quantity(value, label) {
  const result = value === undefined || value === null ? 1 : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 9801) invalid(`${label}必须为有效的正整数`);
  return result;
}
function itemType(row = {}) {
  const target = row.target && typeof row.target === "object" ? row.target : {};
  const value = text(row.type || row.productType || row.category || target.page).toLowerCase();
  if (/video|视频/.test(value)) return "video";
  if (/peripheral|accessor|周边|相册|实物/.test(value) && !/photo|照片/.test(value)) return "peripheral";
  if (/album|photo|照片|写真|拍照|collection/.test(value)) return "album";
  return value;
}
function declaredItems(pkg) {
  const primary = Array.isArray(pkg.includedItems) ? pkg.includedItems : [];
  const alias = Array.isArray(pkg.items) ? pkg.items : [];
  return Array.from({ length: Math.max(primary.length, alias.length) }, (_, index) => ({
    ...(alias[index] && typeof alias[index] === "object" ? alias[index] : {}),
    ...(primary[index] && typeof primary[index] === "object" ? primary[index] : {}),
  }));
}
function peripheralLine(row, multiplier) {
  const target = row.target && typeof row.target === "object" ? row.target : {};
  const productId = text(row.peripheralId || target.peripheralId || row.productId || target.productId || target.id);
  if (!productId) invalid("套餐周边商品关联缺失，请联系商家完善套餐");
  const count = quantity(row.quantity ?? row.qty, "套餐周边数量") * multiplier;
  if (!Number.isSafeInteger(count) || count > 9801) invalid("套餐周边数量超出支持范围");
  const skuId = text(row.skuId || row.specId || row.skuCode || target.skuId || target.specId || target.skuCode);
  const spec = text(row.spec || target.spec);
  const style = row.style !== undefined ? row.style : target.style;
  return { productId, quantity: count, ...(skuId ? { skuId } : {}), ...(spec ? { spec } : {}), ...(style !== undefined ? { style: text(style) } : {}) };
}

function collectLines(bookingItems = [], packages = []) {
  const packageMap = new Map(packages.map(row => [idOf(row), row]));
  const lines = [];
  for (const item of bookingItems) {
    if (!item || typeof item !== "object") continue;
    const packageId = text(item.packageId || (text(item.productType || item.type) === "package" ? item.productId : ""));
    if (packageId) {
      const pkg = packageMap.get(packageId);
      if (!pkg) invalid("预约套餐不存在，请刷新后重新选择");
      const multiplier = quantity(item.quantity ?? item.qty, "套餐购买数量");
      for (const included of declaredItems(pkg)) if (itemType(included) === "peripheral") lines.push(peripheralLine(included, multiplier));
    }
  }
  return lines;
}

async function prepare(source, bookingItems = [], shippingAddressId, openid) {
  const base = baseSource(source);
  const hasPackages = bookingItems.some(item => item && (item.packageId || text(item.productType || item.type) === "package"));
  const lines = collectLines(bookingItems, hasPackages ? await base.list("packages") || [] : []);
  if (!lines.length) return null;
  return serviceFor(base).preparePackageFulfillment(lines, shippingAddressId, openid);
}
async function reserve(source, parent) {
  if (!hasSnapshot(parent)) return null;
  return serviceFor(baseSource(source)).reservePackageFulfillment(parent);
}
async function sync(source, parent) {
  if (!hasSnapshot(parent)) return null;
  return serviceFor(baseSource(source)).syncPackageFulfillment(parent);
}
async function release(source, parent) {
  if (!hasSnapshot(parent)) return null;
  return serviceFor(baseSource(source)).releasePackageFulfillment(parent);
}
async function orders(source, parent, openid) {
  if (!hasSnapshot(parent)) return [];
  if (openid && text(parent.openid || parent._openid || parent.customer_openid) !== text(openid)) {
    throw Object.assign(new Error("无权限查看该套餐的实物订单"), { code: "PHYSICAL_FORBIDDEN", statusCode: 403 });
  }
  return serviceFor(baseSource(source)).packageFulfillmentOrders(parent, openid);
}

function cancelled(parent) {
  return [parent.bookingStatus, parent.status, parent.businessStatus, parent.publicStatus].some(value =>
    ["cancelled", "canceled", "closed", "refunded", "已取消", "已退款"].includes(text(value).toLowerCase())) || canonicalStage(parent) === "cancelled";
}
function clearlyUnpaidExpired(parent, now) {
  if (parent.bookingStatus !== "pending_payment" || hasConfirmedPayment(parent, "deposit")) return false;
  const createdAt = Date.parse(parent.createdAt || parent.createTime || "");
  if (!Number.isFinite(createdAt) || now - createdAt < 30 * 60000) return false;
  // An uncertain WeChat payment may still arrive. Keep its stock held until
  // the normal cancellation flow closes/queries that transaction; elapsed
  // time alone is never evidence that money was not received.
  return !(parent.paymentRecords || []).some(payment => {
    if (["pending", "confirmed"].includes(normalizePaymentStatus(payment.status))) return true;
    // A failed local JSAPI request can still have reached the payment
    // provider. Only a terminal provider fact makes that trade safe to free.
    return payment.provider === "wechat_pay" && payment.outTradeNo
      && !["CLOSED", "PAYERROR", "REVOKED"].includes(text(payment.tradeState).toUpperCase());
  });
}

async function reconcile(source, options = {}) {
  const base = baseSource(source);
  const result = { synced: 0, released: 0, skipped: 0, failures: [] };
  if (typeof base.list !== "function") return result;
  const [formalRows, bookingRows] = await Promise.all([base.list("orders"), base.list("bookingRequests")]);
  const formal = (formalRows || []).filter(hasSnapshot);
  const promoted = new Set(formal.map(row => text(row.bookingId)).filter(Boolean));
  const drafts = (bookingRows || []).filter(row => hasSnapshot(row) && !promoted.has(idOf(row)));
  const now = Number(options.now === undefined ? Date.now() : new Date(options.now).getTime());
  for (const parent of [...formal, ...drafts]) {
    try {
      if (cancelled(parent)) { await release(base, parent); result.released += 1; }
      else if (drafts.includes(parent)) {
        if (hasConfirmedPayment(parent, "deposit")) { await sync(base, parent); result.synced += 1; }
        else if (clearlyUnpaidExpired(parent, now) && typeof base.compareAndUpdate === "function") {
          // Claim expiry before releasing stock. The payment writer compares
          // the same bookingStatus/paymentRecords fields, so it cannot issue
          // a payable trade using the snapshot whose inventory we just freed.
          const expired = await base.compareAndUpdate("bookingRequests", idOf(parent),
            { bookingStatus: parent.bookingStatus, paymentRecords: parent.paymentRecords },
            { bookingStatus: "cancelled", cancellationSource: "unpaid_expired", cancelledAt: new Date(now).toISOString() });
          if (expired) { await release(base, { ...expired, physicalReleaseReason: "unpaid_expired" }); result.released += 1; }
          else result.skipped += 1;
        } else result.skipped += 1;
      } else { await sync(base, parent); result.synced += 1; }
    } catch (error) {
      // One bad historical snapshot cannot prevent recovery of other paid
      // packages. Only stable identifiers/error codes leave this boundary.
      result.failures.push({ parentId: idOf(parent), code: error.code || "PACKAGE_FULFILLMENT_SYNC_FAILED" });
    }
  }
  return result;
}

module.exports = { prepare, reserve, sync, release, orders, reconcile, collectLines };
