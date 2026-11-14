"use strict";

// Money stays in integer cents and ratios in 1/10000 units until formatting.
// This module has no I/O: callers supply immutable facts as of the final payment.
const ENGINE_VERSION = "1.1.0";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_CENTS = 999999999999n;

function shareError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
function id(value, label = "标识") {
  const result = String(value == null ? "" : value).trim();
  if (!result || result.length > 128) throw shareError("SHARE_4001", `${label}无效`);
  return result;
}
function decimalInteger(value, digits, label, { signed = false } = {}) {
  const raw = String(value == null ? "" : value).trim();
  const match = raw.match(signed ? /^(-?)(\d+)(?:\.(\d+))?$/ : /^(\d+)(?:\.(\d+))?$/);
  if (!match) throw shareError("SHARE_4001", `${label}格式无效`);
  const negative = signed && match[1] === "-";
  const whole = match[signed ? 2 : 1];
  const fraction = match[signed ? 3 : 2] || "";
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) throw shareError("SHARE_4001", `${label}精度无效`);
  const result = BigInt(whole) * (10n ** BigInt(digits)) + BigInt((fraction.slice(0, digits)).padEnd(digits, "0") || "0");
  return negative ? -result : result;
}
function moneyToCents(value, { signed = false } = {}) {
  const cents = decimalInteger(value, 2, "金额", { signed });
  if (cents > MAX_CENTS || cents < -MAX_CENTS) throw shareError("SHARE_4001", "金额超出范围");
  return Number(cents);
}
function formatMoney(value) {
  const cents = BigInt(value);
  const absolute = cents < 0 ? -cents : cents;
  return `${cents < 0 ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
function ratioToUnits(value, { maximum = 5000 } = {}) {
  const result = decimalInteger(value, 4, "分成比例");
  if (result > BigInt(maximum)) throw shareError("SHARE_4001", "分成比例须为0%至50%，精确到0.01%");
  return Number(result);
}
function formatRatio(units) { return (Number(units) / 10000).toFixed(4); }
function roundDivide(numerator, denominator) {
  const n = BigInt(numerator); const d = BigInt(denominator);
  if (d <= 0n || n < 0n) throw shareError("SHARE_4001", "金额计算参数无效");
  return (n * 2n + d) / (d * 2n);
}
function time(value, label = "时间") {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  let raw = String(value == null ? "" : value).trim();
  // Document/DB local datetimes consistently mean Asia/Shanghai, regardless of host TZ.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)) raw = raw.replace(" ", "T") + "+08:00";
  const result = Date.parse(raw);
  if (!Number.isFinite(result)) throw shareError("SHARE_4001", `${label}无效`);
  return result;
}
function iso(value) { return new Date(time(value)).toISOString(); }
function periodAt(value) { return new Date(time(value) + 8 * HOUR).toISOString().slice(0, 7); }
function positiveInt(value, fallback, maximum, label) {
  const candidate = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) throw shareError("SHARE_4001", `${label}须为1至${maximum}的整数`);
  return candidate;
}
function refundDays(value = 3) {
  const result = Number(value == null ? 3 : value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 365) throw shareError("SHARE_4001", "退款窗口须为0至365的整数天");
  return result;
}
function validateRule(input) {
  const reason = String(input.reason || "").trim();
  if (!reason || reason.length > 255) throw shareError("SHARE_4001", "变更原因必填且最多255字");
  return {
    merchantId: id(input.merchantId, "商家"),
    ratioT1: formatRatio(ratioToUnits(input.ratioT1)),
    ratioT2: formatRatio(ratioToUnits(input.ratioT2)),
    ttlHours: positiveInt(input.ttlHours, 720, 87600, "客服订单分成时效"),
    refundWindowDays: refundDays(input.refundWindowDays),
    reason,
    operatorId: id(input.operatorId, "操作人"),
  };
}
function compareSequence(a, b) {
  const left = String(a || "0"); const right = String(b || "0");
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
  return left.localeCompare(right);
}
function newest(a, b, timeKey, sequenceKey = "id") {
  return time(b[timeKey]) - time(a[timeKey]) || compareSequence(b[sequenceKey], a[sequenceKey]);
}
function historicalRule(rules, merchantId, at) {
  const cutoff = time(at);
  return (rules || []).filter(rule => String(rule.merchantId) === String(merchantId)
    && time(rule.effectiveFrom || rule.effectiveAt) <= cutoff
    && !["VOID", "REJECTED"].includes(String(rule.status || "").toUpperCase()))
    .sort((a, b) => time(b.effectiveFrom || b.effectiveAt) - time(a.effectiveFrom || a.effectiveAt)
      || Number(b.versionNo || 0) - Number(a.versionNo || 0))[0] || null;
}
// Separate entry points make accidentally using payment time for TTL visible in review.
function resolveRatioAt(rules, merchantId, payTime) {
  return historicalRule(rules, merchantId, payTime);
}
function resolveTtlAt(rules, merchantId, scanTime, defaultTtlHours = 720) {
  const rule = historicalRule(rules, merchantId, scanTime);
  return { ttlHours: rule ? Number(rule.ttlHours) : defaultTtlHours, ruleVersion: rule ? Number(rule.versionNo) : 0 };
}
function resolveSource({ event, clicks = [], options = {} }) {
  const pay = time(event.payTime || event.finalPaidAt);
  const attrDays = options.csAttrDays == null ? 7 : Number(options.csAttrDays);
  if (!Number.isSafeInteger(attrDays) || attrDays < 0 || attrDays > 365) throw shareError("SHARE_4001", "客服归因天数无效");
  const since = attrDays === 0 ? (event.sessionStartAt ? time(event.sessionStartAt) : pay) : pay - attrDays * DAY;
  const click = clicks.filter(row => String(row.userId) === String(event.userId)
    && time(row.clickAt) <= pay && time(row.clickAt) >= since
    && (attrDays !== 0 || (event.sessionId && String(row.sessionId) === String(event.sessionId))))
    .sort((a, b) => newest(a, b, "clickAt"))[0];
  if (!click) return { splitType: "T1", staffId: null, csClickId: null, sourceReason: "NONE", sourceFlag: "" };
  if (!click.staffId) return { splitType: "T1", staffId: null, csClickId: String(click.id), sourceReason: "CS_LINK_MISSING", sourceFlag: "cs_link_missing" };
  return { splitType: "T2", staffId: String(click.staffId), csClickId: String(click.id), sourceReason: "CS_LINK", sourceFlag: "" };
}
function activeMerchant(row) {
  return !!row && !row.deleted && !row.isDeleted && !["CLOSED", "DISABLED", "INACTIVE", "TERMINATED", "CANCELLED", "停业", "关店", "停用", "已停用", "终止合作", "注销"].includes(String(row.status || "OPEN").toUpperCase());
}
function decideAtPayment({ event, bindings = [], rules = [], selfOrders = [], clicks = [], merchants = [], options = {} }) {
  const orderId = id(event.orderId, "订单"); const userId = id(event.userId, "用户");
  const payTime = iso(event.payTime || event.finalPaidAt); const pay = time(payTime);
  if (options.enableAt && pay < time(options.enableAt)) return { skipped: true, code: "SHARE_4230", orderId };
  const source = resolveSource({ event: { ...event, userId, payTime }, clicks, options });
  const limit = positiveInt(options.candidateLimit, 20, 100, "候选数");
  const merchantMap = new Map(merchants.map(row => [String(row.id || row.merchantId), row]));
  // Include an inactive latest binding for T1: closing that store must never
  // resurrect an earlier store as the user's current merchant.
  const ordered = bindings.filter(row => String(row.userId) === userId && time(row.lastScanAt) <= pay)
    .sort((a, b) => newest(a, b, "lastScanAt", "lastScanId"));
  const valid = row => ["1", "ACTIVE"].includes(String(row.status == null ? 1 : row.status).toUpperCase())
    && activeMerchant(merchantMap.get(String(row.merchantId)));
  let candidates = []; let hit = null; let reason = "NO_BINDING";
  if (source.splitType === "T1") {
    const current = ordered[0];
    if (current && valid(current)) {
      hit = current; reason = "BINDING";
      candidates = [{ merchantId: String(current.merchantId), lastScanAt: iso(current.lastScanAt), lastScanId: String(current.lastScanId), inWindow: true }];
    }
  } else {
    const recent = ordered.filter(valid);
    candidates = recent.slice(0, limit).map(binding => {
      const ttl = resolveTtlAt(rules, binding.merchantId, binding.lastScanAt, options.defaultTtlHours || 720);
      const end = time(binding.lastScanAt) + ttl.ttlHours * HOUR;
      const inWindow = ttl.ttlHours > 0 && pay <= end;
      const eligible = inWindow ? selfOrders.filter(order => String(order.userId) === userId
        && String(order.hitMerchantId || order.merchantId) === String(binding.merchantId)
        && String(order.orderId) !== orderId && order.splitType === "T1"
        && order.paid !== false && !order.fullyRefunded && time(order.payTime) <= pay
        && (!order.fullRefundAt || time(order.fullRefundAt) > pay)) : [];
      eligible.sort((a, b) => newest(a, b, "payTime", "orderId"));
      return { merchantId: String(binding.merchantId), lastScanAt: iso(binding.lastScanAt), lastScanId: String(binding.lastScanId),
        ttlHours: ttl.ttlHours, ttlRuleVersion: ttl.ruleVersion, windowEnd: new Date(end).toISOString(), inWindow,
        hasSelfOrder: eligible.length > 0, lastSelfOrderAt: eligible[0] ? iso(eligible[0].payTime) : null };
    });
    const inWindow = candidates.filter(candidate => candidate.inWindow);
    hit = inWindow.find(candidate => candidate.hasSelfOrder) || inWindow[0] || null;
    reason = hit ? hit.hasSelfOrder ? "D_LATEST_SCAN" : "C_LATEST_SCAN" : "NO_MERCHANT_IN_WINDOW";
  }
  const merchantId = hit ? String(hit.merchantId) : "0";
  const rule = hit ? resolveRatioAt(rules, merchantId, payTime) : null;
  const ratio = rule ? source.splitType === "T1" ? rule.ratioT1 : rule.ratioT2 : "0.0000";
  const ratioUnits = ratioToUnits(ratio);
  const merchant = merchantMap.get(merchantId);
  const windowDays = refundDays(rule && rule.refundWindowDays != null ? rule.refundWindowDays : merchant ? merchant.refundWindowDays : options.defaultRefundWindowDays);
  return { orderId, userId, payTime,
    sessionId: event.sessionId ? id(event.sessionId, "支付会话") : null,
    sessionStartAt: event.sessionStartAt ? iso(event.sessionStartAt) : null,
    ...source, hitMerchantId: merchantId, hitReason: reason,
    ratio: formatRatio(ratioUnits), ruleVersion: rule ? Number(rule.versionNo) : 0, engineVersion: ENGINE_VERSION,
    refundWindowDays: windowDays, availableAt: new Date(pay + windowDays * DAY).toISOString(),
    candidateJson: { candidates, candidateLimit: limit, truncated: source.splitType === "T2" && ordered.filter(valid).length > limit,
      platformReason: hit ? null : reason } };
}
function finalizeDecision(decision, { paidTotal, refundedAmount = "0.00" }) {
  if (decision.skipped) return { ...decision };
  const paid = moneyToCents(paidTotal); const refunded = moneyToCents(refundedAmount);
  if (refunded > paid) throw shareError("SHARE_4001", "成功退款金额超过整单实付");
  const base = paid - refunded;
  const units = ratioToUnits(decision.ratio);
  const amount = Number(roundDivide(BigInt(base) * BigInt(units), 10000n));
  if (amount > base) throw shareError("SHARE_4221", "分成金额超过基数", 422);
  return { ...decision, paidTotal: formatMoney(paid), refundedBeforeSnapshot: formatMoney(refunded),
    baseAmount: formatMoney(base), splitAmount: formatMoney(amount), status: base <= 0 ? "VOID" : "EFFECTIVE",
    shouldWriteDetail: base > 0 && amount > 0 && decision.hitMerchantId !== "0" };
}
function judgeShare(input) {
  return finalizeDecision(decideAtPayment(input), { paidTotal: input.event.paidTotal,
    refundedAmount: input.event.refundedAmount || "0.00" });
}
function calculateRefund({ snapshot, cumulativeRefundAmount, alreadyReversed = "0.00" }) {
  const original = moneyToCents(snapshot.splitAmount); const base = moneyToCents(snapshot.baseAmount);
  const before = moneyToCents(snapshot.refundedBeforeSnapshot || "0.00");
  const cumulative = moneyToCents(cumulativeRefundAmount);
  const paid = moneyToCents(snapshot.paidTotal);
  if (cumulative > paid) throw shareError("SHARE_4001", "累计成功退款超过整单实付");
  const postSnapshot = Math.max(0, cumulative - before);
  const target = base <= 0 ? 0 : postSnapshot >= base ? original : Number(roundDivide(BigInt(original) * BigInt(postSnapshot), BigInt(base)));
  const reversed = moneyToCents(alreadyReversed);
  return { targetReversedAmount: formatMoney(target), reverseAmount: formatMoney(Math.max(0, target - reversed)), fullyRefunded: cumulative >= paid };
}

module.exports = { ENGINE_VERSION, HOUR, DAY, shareError, id, moneyToCents, formatMoney, ratioToUnits, formatRatio,
  roundDivide, time, iso, periodAt, positiveInt, refundDays, validateRule, compareSequence, resolveRatioAt, resolveTtlAt,
  resolveSource, activeMerchant, decideAtPayment, finalizeDecision, judgeShare, calculateRefund };
