"use strict";

const { recordDatabaseOperation } = require("./observability.cjs");
const PLANS = Object.freeze({
  rules: ["profiles", "rules"],
  preview: ["ledgers"],
  ledger: ["profiles", "ledgers", "adjustments"],
  parties: ["profiles", "rules", "ledgers", "logs"],
  settlements: ["profiles", "settlements", "logs"],
  mine: ["profiles", "rules", "ledgers", "adjustments", "settlements"],
  assignment: ["profiles"],
});
function inValues(column, values) {
  const ids = [...new Set(values.filter(value => value !== undefined && value !== null).map(String))];
  return ids.length ? { sql: `${column} IN (${ids.map(() => "?").join(",")})`, params: ids } : { sql: "0=1", params: [] };
}
async function loadPhotoRead(conn, context, { TABLES, projection, normalize }) {
  const keys = PLANS[context.kind];
  if (!keys) return null;
  const state = { ...Object.fromEntries(Object.keys(TABLES).map(key => [key, []])), assignments: [], orders: [], phones: [] };
  const query = async (sql, params = []) => {
    const started = process.hrtime.bigint();
    try { return (await conn.query(sql, params))[0]; }
    finally { recordDatabaseOperation(Number(process.hrtime.bigint() - started) / 1e6); }
  };
  for (const key of keys) {
    const [table,,names] = TABLES[key];
    const clauses = [], params = [];
    if (key === "rules" || key === "ledgers") clauses.push("beneficiary_type='photo'");
    if (key === "adjustments") clauses.push("plan_id LIKE 'photo:%'");
    if (context.owner && !(key === "profiles" && context.allProfiles)) {
      const field = key === "profiles" ? "id" : ["rules", "ledgers"].includes(key) ? "party_id" : key === "adjustments" ? "staff_id" : "photo_id";
      if (key === "rules") { clauses.push("(party_id=? OR party_id IS NULL OR party_id='')"); params.push(context.owner); }
      else { clauses.push(`${field}=?`); params.push(context.owner); }
    }
    state[key] = (await query(projection(table, names) + (clauses.length ? " WHERE " + clauses.join(" AND ") : ""), params)).map(normalize);
  }
  if (["rules", "parties", "assignment"].includes(context.kind)) {
    for (const profile of state.profiles) { profile.pending_count = 0; profile.pending_orders = []; }
    if (state.profiles.length) {
      const owner = "COALESCE(NULLIF(photo_id,''),photographerId)";
      const filter = inValues(owner, state.profiles.map(profile => profile.id));
      const pending = (await query(`SELECT id,orderNo order_no,${owner} AS photo_owner,CASE WHEN service_status IN ('claimed','confirmed','shooting','final_pending') THEN service_status WHEN workflowStage='awaiting_final_payment' THEN 'final_pending' WHEN workflowStage='shooting' THEN 'shooting' ELSE 'confirmed' END status,DATE_FORMAT(schedule_time,'%Y-%m-%d %H:%i:%s') schedule_time FROM lxm_orders WHERE ${filter.sql} AND (service_status IN ('claimed','confirmed','shooting','final_pending') OR (COALESCE(service_status,'new') IN ('new','reserved') AND workflowStage IN ('awaiting_shoot','shooting','awaiting_final_payment')))`, filter.params)).map(normalize);
      // PH identifiers are ASCII and MySQL's established columns compare them
      // case-insensitively. Keep batch grouping consistent with the original
      // per-profile COUNT even for a legacy lower-case order owner value.
      const byId = new Map(state.profiles.map(profile => [String(profile.id).toLowerCase(), profile]));
      for (const row of pending) {
        const profile = byId.get(String(row.photo_owner).toLowerCase()); if (!profile) continue;
        const { photo_owner, ...order } = row;
        profile.pending_orders.push(order); profile.pending_count++;
      }
    }
  }
  if (["ledger", "mine"].includes(context.kind) && state.ledgers.length) {
    const selected = inValues("orderNo", state.ledgers.map(row => row.biz_no));
    state.orders = (await query(projection("lxm_orders", "done_at schedule_time requested_time") + " WHERE COALESCE(NULLIF(photo_id,''),photographerId,'')<>'' AND " + selected.sql, selected.params)).map(normalize);
  }
  return state;
}
module.exports = { PLANS, inValues, loadPhotoRead };
