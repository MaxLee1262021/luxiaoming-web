"use strict";

const { time, compareSequence } = require("./shareEngine.cjs");
const text = value => String(value == null ? "" : value).trim();
function invalid() {
  return Object.assign(new Error("订单商家来源凭证不一致，请核查"), { code: "SHARE_ORDER_SOURCE_INVALID", statusCode: 409 });
}

async function currentMerchantBinding(store, userId, merchantId, at) {
  if (!text(userId) || typeof store.getBindingsAsOf !== "function") return null;
  const bindings = await store.getBindingsAsOf(text(userId), at);
  const latest = (bindings || []).filter(row => text(row.userId) === text(userId) && time(row.lastScanAt) <= time(at))
    .sort((a, b) => time(b.lastScanAt) - time(a.lastScanAt) || compareSequence(b.lastScanId, a.lastScanId))[0];
  return latest && text(latest.merchantId) === text(merchantId)
    && ["1", "ACTIVE"].includes(String(latest.status == null ? 1 : latest.status).toUpperCase()) ? latest : null;
}

// Only a persisted, server-validated share QR origin can supplement missing
// scan delivery. Never infer an order's merchant from the user's latest scan.
async function orderSourceEvidence(source, store, input, payTime) {
  const candidate = input.source || {};
  const scene = text(candidate.scene || input.scene);
  if (!/^S[A-Za-z0-9]+$/.test(scene)) return null;
  const orderId = text(input.id || input._id);
  const order = orderId && typeof source.get === "function" ? await source.get("orders", orderId) : null;
  if (!order) throw invalid();
  const origin = order.source || {};
  const merchantId = text(order.shopId || origin.shopId);
  const qrId = text(order.sourceCodeId || origin.sourceCodeId || origin.codeId);
  if (order.sourceType !== "merchant_qrcode" || origin.sourceType !== "merchant_qrcode"
    || !merchantId || !qrId || text(origin.scene) !== scene
    || (order.scene && text(order.scene) !== scene)
    || (origin.shopId && text(origin.shopId) !== merchantId)
    || (origin.codeId && text(origin.codeId) !== qrId)
    || (origin.sourceCodeId && text(origin.sourceCodeId) !== qrId)) throw invalid();
  require("./merchantShare.cjs").validateScene(scene);
  const qr = await store.getQrByScene(scene);
  if (!qr || text(qr.id) !== qrId || text(qr.merchantId) !== merchantId) throw invalid();
  // Formal order creation follows deposit confirmation; use the original
  // checkout time, retained inside source or the private booking request.
  const booking = !origin.validatedAt && order.bookingId ? await source.get("bookingRequests", order.bookingId) : null;
  const at = origin.validatedAt || booking?.createTime || booking?.createdAt || order.createTime || order.createdAt;
  if (!at || time(at) > time(payTime) || (qr.createdAt && time(qr.createdAt) > time(at))) throw invalid();
  if ((qr.disabledAt && time(qr.disabledAt) <= time(at)) || (qr.status !== "ACTIVE" && !qr.disabledAt)) {
    // A previous valid scan survives code rotation. Recheck the persisted
    // order owner's current binding at checkout; presenting an old scene
    // alone never authorizes a new binding or a fresh scan.
    if (qr.status !== "DISABLED" || !qr.disabledAt
      || !await currentMerchantBinding(store, order.openid || order._openid, merchantId, at)) throw invalid();
  }
  return { merchantId, qrId, scene, at: new Date(time(at)).toISOString() };
}

module.exports = { orderSourceEvidence, currentMerchantBinding };
