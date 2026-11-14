"use strict";

// The sole rate resolver and integer-money calculator for both service screens.
const CATEGORIES = Object.freeze(["photo", "video", "combo", "peripheral"]);
const CATEGORY_NAMES = Object.freeze({ photo: "照片单", video: "视频单", combo: "套餐单", peripheral: "周边单" });
const DAY = 86400000;
function failure(code, message, status = 200, data) {
  const error = new Error(message); error.code = code; error.status = status; error.data = data; return error;
}
function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const text = String(value || "");
  const local = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(text);
  const parsed = Date.parse(local ? text.replace(" ", "T") + (text.length === 10 ? "T00:00:00" : "") + "+08:00" : text);
  if (!Number.isFinite(parsed)) throw failure(4014, "时间格式无效");
  return parsed;
}
function localTime(value) { return new Date(timestamp(value) + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "); }
function periodAt(value) { return localTime(value).slice(0, 7); }
function nextDay(value) { const day = localTime(value).slice(0, 10); return localTime(timestamp(day) + DAY); }
function integer(value, label = "金额") {
  if ((typeof value === "number" && !Number.isSafeInteger(value)) || !/^-?\d+$/.test(String(value))) throw failure(4014, label + "必须为安全整数");
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) throw failure(4014, label + "超出支持范围");
  return amount;
}
function commissionFen(netAmountFen, rateBp) {
  const net = integer(netAmountFen), bp = integer(rateBp, "比例");
  if (bp < 0n || bp > 10000n) throw failure(5001, "比例必须在 0–100% 之间");
  const result = (net < 0n ? 0n : net) * bp / 10000n;
  return Number(result);
}
function ratesOf(input) {
  const rates = {};
  for (const category of CATEGORIES) {
    const value = input && (input[category + "_bp"] ?? input["rate_" + category + "_bp"]);
    if (value === undefined || value === null || value === "") throw failure(5008, "单人比例必须四类一次给全");
    const bp = Number(integer(value, "比例"));
    if (bp < 0 || bp > 10000 || bp % 10 !== 0) throw failure(5001, CATEGORY_NAMES[category] + "的比例须为0–100%，步长0.1%");
    rates["rate_" + category + "_bp"] = bp;
  }
  return rates;
}
function rateBpOf(rules, staffId, category, paidAt, beneficiaryType = "service") {
  if (!CATEGORIES.includes(category)) throw failure(4014, "类目无效");
  const at = timestamp(paidAt);
  const eligible = rules.filter(row => row.beneficiary_type === beneficiaryType && timestamp(row.eff_at) <= at)
    .sort((a, b) => timestamp(b.eff_at) - timestamp(a.eff_at) || Number(b.ver) - Number(a.ver));
  const personal = eligible.find(row => String(row.party_id || "") === String(staffId) && row.party_id != null);
  const rule = personal && personal.rule_mode !== "global" ? personal : eligible.find(row => row.party_id == null || row.party_id === "");
  if (!rule) throw failure(5011, "无可用统一比例版本，请先初始化比例");
  return { bp: Number(rule["rate_" + category + "_bp"]), mode: rule === personal ? "custom" : "global", ver: Number(rule.ver) };
}
function statusOf(ledger, order, now, config = {}) {
  // Confirmed snapshots must never be demoted by a later order/refund event.
  if (ledger.status === "settled") return "settled";
  if (ledger.zero_reason) return "void";
  if (order.service_status !== "done" || !ledger.done_at) return "est";
  if (order.complaint_resp === "unknown" || order.resp === "unknown") return "obs";
  return timestamp(ledger.done_at) + Number(config.observe_days ?? 7) * DAY <= timestamp(now) ? "settleable" : "obs";
}
function duePeriod(ledger, config = {}) { return periodAt(timestamp(ledger.done_at) + Number(config.observe_days ?? 7) * DAY); }
function sumFen(rows, field) { return Number(integer(rows.reduce((sum, row) => sum + integer(row[field] || 0), 0n))); }
function money(value) {
  const amount = integer(value); const abs = amount < 0n ? -amount : amount;
  return (amount < 0n ? "-" : "") + (abs / 100n).toString() + "." + (abs % 100n).toString().padStart(2, "0");
}
function addWorkdays(value, count, holidays = [], workdays = []) {
  let day = timestamp(localTime(value).slice(0, 10));
  const off = new Set(holidays), on = new Set(workdays);
  for (let done = 0; done < count;) {
    day += DAY;
    const date = localTime(day).slice(0, 10), week = new Date(day + 8 * 3600000).getUTCDay();
    if (on.has(date) || (week !== 0 && week !== 6 && !off.has(date))) done++;
  }
  return localTime(day).slice(0, 10);
}
function safeCsv(value) {
  let text = String(value == null ? "" : value);
  if (/^[\s]*[=+@]/.test(text) || /^[\s]*-/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

module.exports = { CATEGORIES, CATEGORY_NAMES, DAY, failure, timestamp, localTime, periodAt, nextDay, integer, commissionFen, ratesOf, rateBpOf, statusOf, duePeriod, sumFen, money, addWorkdays, safeCsv };
