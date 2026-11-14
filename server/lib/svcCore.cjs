"use strict";

const crypto = require("node:crypto");
const DAY = 86400000;
const ZONE = 8 * 3600000;
const DEFAULT_CONFIG = Object.freeze({ ver: 0, rebuy_on: 1, protect_days: 5, hold_minutes: 60, quiet_start: "22:00", quiet_end: "09:00", slot_remind_h: 2, observe_days: 7, link_valid_days: 7, offset_cap_bp: 3000, offset_periods: 3 });
function fail(code, msg, data) { return Object.assign(new Error(msg), { code, data, statusCode: Number(code) >= 400 && Number(code) < 600 ? Number(code) : 200 }); }
function text(v) { return String(v == null ? "" : v).trim(); }
function uid() { return crypto.randomBytes(16).toString("hex"); }
function nextId(state, key) { return String((state[key] || []).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1); }
function millis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const s = text(value);
  if (!s) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s) ? s.replace(" ", "T") + "+08:00" : s);
}
function stamp(value = new Date()) { const t = millis(value); if (!Number.isFinite(t)) throw fail(4014, "时间格式无效"); return new Date(t + ZONE).toISOString().slice(0, 19).replace("T", " "); }
function add(value, amount, unit = DAY) { return stamp(millis(value) + amount * unit); }
function period(value = new Date()) { return stamp(value).slice(0, 7); }
function nextMidnight(value) { return stamp(millis(stamp(value).slice(0, 10) + " 00:00:00") + DAY); }
function minuteOf(value) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw fail(4014, "时间须为 HH:MM"); return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }
function inQuiet(t, a, b) { t = typeof t === "number" ? t : minuteOf(t); a = typeof a === "number" ? a : minuteOf(a); b = typeof b === "number" ? b : minuteOf(b); if (a === b) throw fail(4013, "静默期起止不能相同，等于全天静默"); return a < b ? t >= a && t < b : t >= a || t < b; }
function reserveWindow(paidAt, cfg) {
  const paid = stamp(paidAt), quiet = inQuiet(paid.slice(11, 16), cfg.quiet_start, cfg.quiet_end);
  let start = paid;
  if (quiet) { start = paid.slice(0, 10) + " " + cfg.quiet_end + ":00"; if (millis(start) <= millis(paid)) start = add(start, 1); }
  return { is_quiet: quiet ? 1 : 0, reserve_start_at: start, reserve_expire_at: add(start, Number(cfg.hold_minutes), 60000), status: quiet ? "holding" : "started" };
}
function leftSeconds(reserve, at) { return reserve.status === "holding" ? null : Math.max(0, Math.floor((millis(reserve.reserve_expire_at) - millis(at)) / 1000)); }
function activeConfig(state, at) { return { ...DEFAULT_CONFIG, ...state.configs.filter(r => millis(r.eff_at) <= millis(at)).sort((a, b) => millis(b.eff_at) - millis(a.eff_at) || Number(b.ver) - Number(a.ver))[0] }; }
function staffTiming(staff, config = DEFAULT_CONFIG) {
  return { link_valid_days: Number(staff?.link_valid_days ?? config.link_valid_days ?? DEFAULT_CONFIG.link_valid_days),
    observe_days: Number(staff?.observe_days ?? config.observe_days ?? DEFAULT_CONFIG.observe_days) };
}
function validateStaffTiming(input) {
  const values = {};
  for (const [key, label, min] of [["link_valid_days", "链接有效期", 1], ["observe_days", "结算等待期", 0]]) {
    const value = input[key];
    if (value == null) { values[key] = null; continue; }
    if (!["number", "string"].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > 30) {
      throw fail(4014, `${label}须为${min}–30天的整数`, { field: key });
    }
    values[key] = Number(value);
  }
  return values;
}
function validateConfig(input, previous = DEFAULT_CONFIG) {
  const cfg = { ...previous };
  for (const [key, min, max] of [["protect_days", 1, 30], ["hold_minutes", 10, 1440], ["slot_remind_h", 0, 48], ["observe_days", 0, 30], ["link_valid_days", 1, 30], ["offset_cap_bp", 0, 3000], ["offset_periods", 1, 3]]) {
    if (Object.hasOwn(input, key)) { const v = Number(input[key]); if (!Number.isInteger(v) || v < min || v > max) throw fail(4014, `${key} 须为 ${min}–${max} 的整数`, { field: key }); cfg[key] = v; }
  }
  if (Object.hasOwn(input, "rebuy_on")) { if (![true, false, 0, 1, "0", "1"].includes(input.rebuy_on)) throw fail(4014, "rebuy_on 无效"); cfg.rebuy_on = input.rebuy_on === true || String(input.rebuy_on) === "1" ? 1 : 0; }
  for (const key of ["quiet_start", "quiet_end"]) if (Object.hasOwn(input, key)) { minuteOf(input[key]); cfg[key] = input[key]; }
  for (const key of ["holiday_dates", "workday_dates"]) if (Object.hasOwn(input, key)) {
    if (!Array.isArray(input[key]) || input[key].length > 366 || input[key].some(day => typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(millis(day + " 00:00:00")) || stamp(day + " 00:00:00").slice(0, 10) !== day)) throw fail(4014, `${key} 须为有效日期数组（最多366天）`);
    cfg[key] = [...new Set(input[key])].sort();
  }
  if ((cfg.holiday_dates || []).some(day => (cfg.workday_dates || []).includes(day))) throw fail(4014, "同一天不能同时设为放假和补班");
  inQuiet(0, cfg.quiet_start, cfg.quiet_end);
  return cfg;
}
function saveConfig(state, input, operator, at) {
  const latest = [...state.configs].sort((a, b) => Number(b.ver) - Number(a.ver))[0];
  if (input.ver == null || Number(input.ver) !== Number(latest && latest.ver || 0)) throw fail(5003, "配置已被他人修改，请刷新");
  const cfg = validateConfig(input, latest || DEFAULT_CONFIG);
  const row = { ...cfg, id: nextId(state, "configs"), ver: Number(latest && latest.ver || 0) + 1, eff_at: nextMidnight(at), operator: text(operator), created_at: stamp(at) };
  state.configs.push(row); return row;
}
function requireReason(input, max = 500) { const reason = text(input.reason); if (!reason || reason.length > max) throw fail(4014, `请填写原因（最多${max}字）`); return reason; }
function requireChannel(input) { if (!["wechat", "phone", "face"].includes(input.channel)) throw fail(4014, "请选择微信、电话或当面沟通渠道"); return input.channel; }
function futureTime(value, at) { if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text(value)) || !Number.isFinite(millis(value)) || stamp(value) !== value || millis(value) <= millis(at)) throw fail(4008, "新的拍摄时间必须晚于当前时间"); return value; }
function paginate(rows, input) { const page = Math.max(1, Math.floor(Number(input.page) || 1)), size = Math.min(100, Math.max(1, Math.floor(Number(input.size) || 20))); return { list: rows.slice((page - 1) * size, page * size), total: rows.length, page, size }; }
module.exports = { DAY, DEFAULT_CONFIG, fail, text, uid, nextId, millis, stamp, add, period, nextMidnight, minuteOf, inQuiet, reserveWindow, leftSeconds, activeConfig, staffTiming, validateStaffTiming, validateConfig, saveConfig, requireReason, requireChannel, futureTime, paginate };
