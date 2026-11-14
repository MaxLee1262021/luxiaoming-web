"use strict";

const { recordDatabaseOperation } = require("./observability.cjs");
const PLANS = Object.freeze({
  "/rule": { keys: ["staff", "rules", "configs", "bindingLogs"], tags: true },
  "/ledger": { keys: ["staff", "ledger", "settlements"], orders: true },
  "/ledger/export": { keys: ["staff", "ledger", "settlements"], orders: true },
  "/me": { keys: ["staff", "ledger", "settlements", "appeals", "rules", "configs", "adjustments"], orders: true, tags: true },
  "/staff": { keys: ["staff", "rules", "staffLogs", "ledger", "configs"], tags: true },
  "/settlement": { keys: ["staff", "settlements"] },
  "/appeal": { keys: ["staff", "appeals"] },
});
function inValues(column, values) {
  const ids = [...new Set(values.filter(value => value !== undefined && value !== null).map(String))];
  return ids.length ? { sql: `${column} IN (${ids.map(() => "?").join(",")})`, params: ids } : { sql: "0=1", params: [] };
}
function scopeIds(staff, session) {
  if (session.kind !== "public" && ["super", "admin", "administrator", "finance"].includes(session.role)) return null;
  const direct = String(session.staffId || session.staff_id || session.subjectId || "");
  const me = staff.find(row => row.id === direct || row.account_id && row.account_id === session.authzUserId)?.id || direct;
  if (["supervisor", "service_supervisor", "serviceManager"].includes(session.role)) return staff.filter(row => String(row.supervisor_id || "") === String(me) || row.id === me).map(row => row.id);
  return [me];
}
async function loadCommission(conn, context, {TABLES, SERVICE_FIELDS, normal, orderRow, projection}) {
  const path = String(context.path || "").replace(/^\/api\/svc/, "").replace(/\/$/, "") || "/";
  if (!String(context.path || "").startsWith("/api/svc")) return null;
  const match = path.match(/^\/settlement\/([^/]+)$/);
  const plan = PLANS[path] || (match ? { keys: ["staff", "settlements", "ledger", "adjustments"], orders: true } : null);
  if (!plan) return null;
  const state = { ...Object.fromEntries(Object.keys(TABLES).map(key => [key, []])), orders: [], photographers: [], photoNative: true };
  const query = async (sql, params = []) => {
    const started = process.hrtime.bigint();
    try { return (await conn.query(sql, params))[0]; }
    finally { recordDatabaseOperation(Number(process.hrtime.bigint() - started) / 1e6); }
  };
  const table = async (key, clauses = [], params = []) => {
    const [name,,fields] = TABLES[key];
    state[key] = (await query(projection(name, fields.split(" ")) + (clauses.length ? " WHERE " + clauses.join(" AND ") : ""), params)).map(normal);
  };
  await table("staff");
  const allowed = scopeIds(state.staff, context.session || {});
  if(['/staff','/me'].includes(path)){
    const people=state.staff.filter(row=>(!allowed||allowed.includes(row.id))&&row.account_id);
    if(people.length){const linked=inValues('id',people.map(row=>row.account_id));
      const accounts=await query('SELECT id,account FROM lxm_auth_users WHERE '+linked.sql,linked.params);
      for(const person of people){const account=accounts.find(account=>String(account.id)===String(person.account_id))?.account;if(account)person.account=account;}
    }
  }
  for (const key of plan.keys) {
    if (key === "staff") continue;
    const clauses = [], params = [];
    if (key === "ledger" && !match) clauses.push("beneficiary_type='service'");
    if (match && ["ledger", "settlements", "adjustments"].includes(key)) { clauses.push("settle_id=?"); params.push(match[1]); }
    if (allowed && ["ledger", "settlements", "appeals", "staffLogs", "adjustments"].includes(key)) {
      const selected = inValues(key === "ledger" ? "party_id" : "staff_id", allowed); clauses.push(selected.sql); params.push(...selected.params);
    }
    if(allowed&&key==='bindingLogs'){const from=inValues('from_staff',allowed),to=inValues('to_staff',allowed);clauses.push('('+from.sql+' OR '+to.sql+')');params.push(...from.params,...to.params);}
    await table(key, clauses, params);
  }
  if (plan.tags && state.staff.length) {
    const tags = await query("SELECT staff_id,tag FROM svc_staff_tag ORDER BY staff_id,tag_index");
    const byStaff = new Map();
    for (const row of tags) { const id = String(row.staff_id); if (!byStaff.has(id)) byStaff.set(id, []); byStaff.get(id).push(row.tag); }
    for (const staff of state.staff) staff.assessment_tags = byStaff.get(String(staff.id)) || [];
  }
  if (plan.orders && state.ledger.length) {
    const selected = inValues("orderNo", state.ledger.map(row => row.biz_no));
    state.orders = (await query(projection("lxm_orders", SERVICE_FIELDS) + " WHERE COALESCE(deleted,0)=0 AND COALESCE(isDeleted,0)=0 AND " + selected.sql, selected.params)).map(orderRow);
    if (state.orders.length) {
      const filter = inValues("order_id", state.orders.map(row => row.id));
      const products = await query("SELECT order_id,product_type,name,product_id FROM lxm_order_products WHERE " + filter.sql + " ORDER BY item_no", filter.params);
      const first = new Map(); for (const product of products) if (!first.has(String(product.order_id))) first.set(String(product.order_id), product);
      for (const order of state.orders) {
        const product = first.get(String(order.id)); if (!product) continue;
        const type = String(product.product_type || "").trim().toLowerCase();
        order.category = /peripheral|周边/.test(type) ? "peripheral" : /video|视频/.test(type) ? "video" : /package|combo|套餐/.test(type) || order.packageId ? "combo" : "photo";
        order.product_name = product.name || order.product_name; order.product_id = product.product_id;
      }
    }
  }
  return state;
}
module.exports = { PLANS, inValues, scopeIds, loadCommission };
