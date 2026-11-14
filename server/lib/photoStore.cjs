"use strict";

// Native SQL only. Snapshot mutation is committed as individual typed rows;
// production never falls back to browser/JSON data when the DB is unavailable.
const fs = require("node:fs");
const path = require("node:path");
const { failure, localTime } = require("./svcBenefit.cjs");
const TABLES = Object.freeze({
  profiles: ["photo_profile", "id", "id name phone agree_no rate_mode status dispute_days wait_days cycle created_at"],
  settlements: ["photo_settlement", "settle_id", "settle_id period photo_id item_count amount_fen offset_fen payable_fen status dispute_until pushed_at accepted_at paid_at voucher_url created_at"],
  logs: ["photo_profile_log", "id", "id photo_id action detail operator created_at"],
  rules: ["benefit_rule", "id", "id ver beneficiary_type party_id rule_mode rate_photo_bp rate_video_bp rate_combo_bp rate_peripheral_bp eff_at reason operator created_at"],
  ledgers: ["benefit_ledger", "id", "id biz_no beneficiary_type party_id category net_amount_fen rate_bp rate_mode rule_ver commission_fen observe_days status zero_reason customer_openid is_rebuy paid_at done_at settle_id created_at updated_at"],
  adjustments: ["svc_adjust", "id", "id order_no staff_id action amount_fen settle_id carried plan_id period note operator created_at"],
  notifications: ["svc_notification", "id", "id event_key event_type order_no recipient_id message status attempts next_attempt_at created_at sent_at failure_note"],
});
const DATE_FIELDS = new Set(["created_at", "updated_at", "eff_at", "paid_at", "done_at", "pushed_at", "accepted_at", "dispute_until", "next_attempt_at", "sent_at", "schedule_time", "requested_time"]);
function projection(table, names) { return "SELECT *" + names.split(" ").filter(name => DATE_FIELDS.has(name)).map(name => `,DATE_FORMAT(\`${name}\`,'${name === "dispute_until" ? "%Y-%m-%d" : "%Y-%m-%d %H:%i:%s"}') AS \`${name}\``).join("") + " FROM " + table; }
async function query(conn, sql, values = []) { return (await conn.query(sql, values))[0]; }
function normalize(row) {
  // DATETIME business fields are projected as literal wall-clock strings by
  // SQL. This fallback is only for actual JS instants supplied by other
  // adapters/metadata, which carry their own offset and may be converted.
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? (k.endsWith("until") ? localTime(v).slice(0, 10) : localTime(v)) : typeof v === "bigint" ? String(v) : v]));
}
function createPhotoStore(source, options = {}) {
  if (!source || typeof source.transaction !== "function") throw failure(4399, "摄影师分成必须使用 MySQL 事务存储", 503);
  async function load(conn, lock) {
    // This is also the service-workbench lock; both workers allocate versions
    // from the SAME global benefit_rule sequence under the same lock.
    if (lock) await query(conn, "SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE");
    const state = {};
    for (const [key, [table, , names]] of Object.entries(TABLES)) {
      // Shared IDs are global; load the common tables without a photo filter so
      // MAX(id)+1 never collides with another beneficiary's allocated identity.
      const where = "";
      state[key] = (await query(conn, `${projection(table, names)}${where}${lock ? " FOR UPDATE" : ""}`)).map(normalize);
    }
    state.assignments = (await query(conn, "SELECT *,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at FROM svc_assign_log ORDER BY created_at,id")).map(normalize);
    state.orders = (await query(conn, `${projection("lxm_orders", "done_at schedule_time requested_time")} WHERE COALESCE(NULLIF(photo_id,''),photographerId,'')<>''`)).map(normalize);
    state.phones = [];
    for (const table of ["lxm_staff", "lxm_agents", "lxm_distributors", "lxm_shops", "lxm_userProfiles", "lxm_auth_users", "svc_staff"]) {
      const list = await query(conn, `SELECT phone FROM ${table} WHERE phone IS NOT NULL AND phone<>''`);
      state.phones.push(...list.map(row => String(row.phone)));
    }
    // Runtime counts are facts queried from orders. No count is persisted in
    // photo_profile, not even when a caller uses a stale list to request end.
    for (const profile of state.profiles) {
      const condition = "COALESCE(NULLIF(photo_id,''),photographerId)=? AND (service_status IN ('claimed','confirmed','shooting','final_pending') OR (COALESCE(service_status,'new') IN ('new','reserved') AND workflowStage IN ('awaiting_shoot','shooting','awaiting_final_payment')))";
      const rows = await query(conn, `SELECT COUNT(*) count FROM lxm_orders WHERE ${condition}`, [profile.id]);
      profile.pending_count = Number(rows[0].count);
      profile.pending_orders = (await query(conn, `SELECT id,orderNo order_no,CASE WHEN service_status IN ('claimed','confirmed','shooting','final_pending') THEN service_status WHEN workflowStage='awaiting_final_payment' THEN 'final_pending' WHEN workflowStage='shooting' THEN 'shooting' ELSE 'confirmed' END status,DATE_FORMAT(schedule_time,'%Y-%m-%d %H:%i:%s') schedule_time FROM lxm_orders WHERE ${condition}`, [profile.id])).map(normalize);
    }
    return state;
  }
  async function flush(conn, before, state) {
    for (const [key, [table, pk, names]] of Object.entries(TABLES)) {
      const allowed = names.split(" ");
      const old = new Map(before[key].map(row => [String(row[pk]), row]));
      for (const row of state[key]) {
        const previous = old.get(String(row[pk]));
        if (previous && key === "settlements" && previous.status !== "draft") for (const field of ["period", "photo_id", "item_count", "amount_fen", "offset_fen", "payable_fen"]) if (String(previous[field] ?? "") !== String(row[field] ?? "")) throw failure(4306, "已推送对账单金额不可修改");
        if (previous && key === "rules" && JSON.stringify(row) !== JSON.stringify(previous)) throw failure(4399, "比例历史不可修改");
        const fields = allowed.filter(field => row[field] !== undefined && (!previous || JSON.stringify(previous[field]) !== JSON.stringify(row[field])));
        if (!fields.length) continue;
        if (previous) {
          if (key === "logs" || key === "adjustments") throw failure(4399, "留痕流水不可改删");
          const change = fields.filter(field => field !== pk);
          if (change.length) await query(conn, `UPDATE ${table} SET ${change.map(field => `\`${field}\`=?`).join(",")} WHERE \`${pk}\`=?`, [...change.map(field => row[field]), row[pk]]);
        } else await query(conn, `INSERT INTO ${table} (${fields.map(field => `\`${field}\``).join(",")}) VALUES (${fields.map(() => "?").join(",")})`, fields.map(field => row[field]));
      }
    }
  }
  async function withState(work, config = {}) {
    const exec = async conn => {
      const selected = config.readOnly && config.kind && await require("./photoReadStore.cjs").loadPhotoRead(conn, config, { TABLES, projection, normalize });
      const state = selected || await load(conn, !config.readOnly), before = config.readOnly ? null : structuredClone(state);
      const result = await work(state, { conn });
      if (!config.readOnly) await flush(conn, before, state);
      return result;
    };
    if (config.conn) return exec(config.conn);
    for (let attempt = 0; ; attempt++) {
      try { return await source.transaction(exec); }
      catch (error) {
        if (attempt < 3 && ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code)) continue;
        if (error.code === "ER_DUP_ENTRY" && /uk_phone/.test(error.message)) throw failure(4301, "手机号全平台唯一，已存在");
        throw error;
      }
    }
  }
  async function ensureSchema() {
    const file = path.join(__dirname, "../migrations/019_photo_share.sql");
    for (const sql of fs.readFileSync(file, "utf8").replace(/^--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean)) await source.transaction(async conn => {
      if (/^ALTER TABLE/.test(sql)) { const indexes = await query(conn, "SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='lxm_orders' AND index_name='idx_photo_status'"); if (indexes.length) return; }
      await query(conn, sql);
    });
    return { ready: true, migration: "019_photo_share" };
  }
  return { withState, ensureSchema, source, options };
}
module.exports = { createPhotoStore, TABLES, query, normalize, projection };
