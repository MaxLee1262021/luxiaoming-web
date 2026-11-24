"use strict";

// The merchant order list is a read-only, redacted progress view. It never
// creates commission facts or adds expected amounts to the posted ledger.
const { moneyToCents, formatMoney, periodAt, time, iso, positiveInt } = require("./shareEngine.cjs");
const { canonicalStage, hasConfirmedPayment, normalizePaymentStatus, isUnpaidBooking } = require("./orderWorkflow.cjs");
const STATUS_TEXT = {
  awaiting_final_payment: "待付尾款", observing: "退款观察期", pending: "待入账", posted: "已入账", review: "需核查",
};
function str(value) { return String(value == null ? "" : value).trim(); }
function createdAt(order) {
  try { return iso(order.createdAt || order.createTime); } catch (_) { return ""; }
}
function orderMerchant(order) {
  // A frozen top-level source wins over a conflicting nested legacy source.
  return str(order.shopId || order.source?.shopId);
}
function attributedMerchant(order, job, effective) {
  // Accounting freezes the merchant at payment. A later scan can therefore
  // differ from the order's checkout source, including a platform-only result.
  if (effective?.state) return str(effective.state.hitMerchantId);
  if (job?.decisionJson && Object.prototype.hasOwnProperty.call(job.decisionJson, "hitMerchantId")) return str(job.decisionJson.hitMerchantId);
  return orderMerchant(order);
}
function finalReceipt(order) {
  return [...(Array.isArray(order.paymentRecords) ? order.paymentRecords : [])].reverse().find(row => row
    && row.phase === "final" && normalizePaymentStatus(row.status) === "confirmed"
    && ["wechat_pay", "zero_balance"].includes(row.provider));
}
function progress(order, job, effective, merchantId, options) {
  const state = effective?.state;
  if (state) {
    if (str(state.hitMerchantId) !== merchantId) return { status: "review" };
    const amount = moneyToCents(state.splitAmount || "0.00");
    return { status: "posted", ...(amount === 0 ? { statusText: "已核算（分成为0）" } : {}) };
  }
  if (job?.status === "FAILED" || canonicalStage(order) === "cancelled" || order.orderType === "physical" && order.status === "closed") return { status: "review" };
  if (job) {
    const attributed = str(job.decisionJson?.hitMerchantId);
    if (attributed && attributed !== merchantId) return { status: "review" };
    if (job.status !== "PENDING") return { status: "review" };
    return { status: time(job.availableAt) > time(options.now) ? "observing" : "pending" };
  }
  if (!options.enabled || !options.configured) return { status: "review" };
  const receipt = finalReceipt(order);
  if (!receipt) {
    if (order.orderType === "physical") return order.finalPaidAt ? { status: "review" } : { status: "awaiting_final_payment", statusText: "待付款" };
    return { status: hasConfirmedPayment(order, "final") || order.finalPaidAt ? "review" : "awaiting_final_payment" };
  }
  if (order.orderType !== "physical" && !hasConfirmedPayment(order, "final")) return { status: "awaiting_final_payment" };
  const payTime = order.finalPaidAt || receipt.paidAt || receipt.confirmedAt || order.completedAt;
  if (options.enableAt && (!payTime || time(payTime) < time(options.enableAt))) return { status: "review" };
  return { status: "pending" };
}

async function merchantOrders(source, store, merchantId, query = {}, options = {}) {
  const page = positiveInt(query.orderPage, 1, 1000000, "关联订单页码");
  const size = positiveInt(query.orderSize, 20, 100, "关联订单页大小");
  const notices = [];
  if (!options.enabled) notices.push("商家分成尚未启用，已关联订单可在此查看；分成请联系平台确认。");
  const rows = await source.list("orders");
  let physical = [];
  try {
    const service = require("./physicalCommerce.cjs").serviceFor(source);
    if (typeof service.listShareOrders === "function") physical = await service.listShareOrders();
  } catch (error) {
    // Legacy-only stores have no independent physical commerce tables.
    if (error.code !== "PHYSICAL_STORE_UNAVAILABLE") notices.push("实物订单的分成进度暂不可用，请刷新重试或联系平台核对。");
  }
  const candidates = [...(Array.isArray(rows) ? rows.filter(order => order?.orderType !== "physical") : []), ...(Array.isArray(physical) ? physical : [])].filter(order => {
    if (!order || order.deleted || order.isDeleted || order.paymentMode === "package"
      || order.orderType !== "physical" && isUnpaidBooking(order)) return false;
    const stamp = createdAt(order);
    return !!stamp && (!query.period || periodAt(stamp) === query.period);
  }).sort((a, b) => time(createdAt(b)) - time(createdAt(a)) || str(b.id || b._id).localeCompare(str(a.id || a._id)));
  let unavailable = false;
  const selected = [];
  // Read authoritative ownership before pagination, with bounded concurrency.
  // Only the final allowlisted page ever leaves this module.
  for (let offset = 0; offset < candidates.length; offset += 20) {
    const batch = await Promise.all(candidates.slice(offset, offset + 20).map(async order => {
      const id = str(order.id || order._id);
      try {
        const [job, effective] = await Promise.all([
          store.getJob(id),
          typeof store.getEffectiveAttribution === "function" ? store.getEffectiveAttribution(id)
            : store.getSnapshot(id).then(state => ({ state })),
        ]);
        if (attributedMerchant(order, job, effective) !== merchantId) return null;
        return { order, current: progress(order, job, effective, merchantId, options) };
      } catch (_) {
        // Checkout ownership cannot authorize access when the authoritative
        // payment attribution is unavailable: it may belong to another shop.
        unavailable = true;
        return null;
      }
    }));
    selected.push(...batch.filter(Boolean));
  }
  if (!selected.length) notices.push("所选月份暂无归属本店的订单；已完成但未显示的订单请联系平台核对来源。");
  const orders = selected.slice((page - 1) * size, page * size).map(({ order, current }) => {
    const id = str(order.id || order._id);
    let paidAmount;
    try { paidAmount = order.orderType === "physical" && order.paidAmount !== undefined
      ? formatMoney(moneyToCents(order.paidAmount))
      : formatMoney(moneyToCents(order.depositPaid || "0.00") + moneyToCents(order.finalPaid || "0.00")); }
    catch (_) { current = { status: "review" }; paidAmount = null; }
    // Explicit allowlist: never spread an order, job or attribution snapshot.
    return {
      orderNo: `****${str(order.orderNo || id).slice(-4)}`, createdAt: createdAt(order), paidAmount,
      status: current.status, statusText: current.statusText || STATUS_TEXT[current.status],
    };
  });
  if (unavailable) notices.push("部分订单的分成进度暂不可用，请刷新重试或联系平台核对。");
  return { orders, orderTotal: selected.length, orderPage: page, orderSize: size, orderStats: { total: selected.length }, notices };
}

module.exports = { merchantOrders };
