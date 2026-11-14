"use strict";

// GET endpoints load the facts they actually display. They never acquire the
// accounting writer lock, replay payments, or cache an authorization decision.
const MANAGERS = new Set(["super", "admin", "administrator"]);
const SUPERVISORS = new Set(["supervisor", "service_supervisor"]);
const LIST = /^\/api\/kf\/orders\/(all|pool|mine|reserved)$/;
const DETAIL = /^\/api\/kf\/orders\/([^/]+)$/;
const RELATED = ["ledger", "reserves", "operationLogs"];
const {recordDatabaseOperation} = require("./observability.cjs");
function planFor(path) {
  if (path === "/api/kf/rebuy/config") return { keys: ["configs"] };
  if (path === "/api/kf/photographers") return { keys: [], photographers: true };
  if (path === "/api/kf/staff") return { keys: ["staff"] };
  if (path === "/api/kf/rebuy/bindings") return { keys: ["staff", "bindings", "bindingLogs"], bindings: true };
  if (path === "/api/kf/workbench/summary") return { keys: ["staff", "complaints", ...RELATED], orders: true, managed: true, summary: true };
  if (path === "/api/kf/workbench/overview") return { keys: ["staff", "complaints", ...RELATED], orders: true, managed: true, products: true, summary: true };
  if (path === "/api/kf/workbench/todo") return { keys: ["staff", "complaints", ...RELATED], orders: true, managed: true, products: true };
  if (LIST.test(path)) return { keys: ["staff", ...RELATED], orders: true, managed: true, products: true };
  if (path === "/api/kf/link/resolve") return { keys: ["staff", ...RELATED], orders: true, products: true, resolve: true };
  if (path === "/api/kf/complaints") return { keys: ["staff", "complaints", "adjustments", ...RELATED], orders: true, products: true };
  if (DETAIL.test(path)) return { keys: ["staff", ...RELATED, "configs", "slotLogs", "assignLogs", "bindingLogs", "adjustments", "receiptLogs", "complaints", "bindings"], orders: true, products: true, detail: true };
  return null;
}
function scopeIds(staff, session) {
  if (MANAGERS.has(session.role)) return null;
  const explicit = String(session.staff_id || session.staffId || "");
  const actor = String(session.authzUserId || session.accountId || session.subjectId || session.id || session.account || "");
  const me = staff.find(row => explicit ? String(row.id) === explicit : String(row.account_id) === actor);
  if (!me) return [];
  return [String(me.id), ...(SUPERVISORS.has(session.role) ? staff.filter(row => String(row.supervisor_id) === String(me.id)).map(row => String(row.id)) : [])];
}
function inValues(column, values) {
  const unique = [...new Set(values.filter(value => value !== null && value !== undefined).map(String))];
  return unique.length ? { sql: `${column} IN (${unique.map(() => "?").join(",")})`, params: unique } : { sql: "0=1", params: [] };
}
function orderScope(staff, session, pool) {
  if (MANAGERS.has(session.role) || session.role === "finance") return { sql: "1=1", params: [] };
  if (session.role === "photo") return { sql: "COALESCE(NULLIF(o.photo_id,''),o.photographerId)=?", params: [String(session.staff_id || session.staffId || session.subjectId || "")] };
  const ids = scopeIds(staff, session);
  const owner = inValues("COALESCE(NULLIF(o.assignee_id,''),NULLIF(o.assigneeId,''),o.serviceUserId)", ids);
  const reserved = inValues("o.reserve_staff_id", ids);
  const publicPool = pool && (session.role === "service" || SUPERVISORS.has(session.role));
  return { sql: `(${owner.sql} OR ${reserved.sql}${publicPool ? " OR o.service_status='new' OR o.service_status IS NULL OR o.service_status=''" : ""})`, params: [...owner.params, ...reserved.params] };
}
function mergeProducts(state, products) {
  const first = new Map();
  for (const product of products) if (!first.has(String(product.order_id))) first.set(String(product.order_id), product);
  for (const order of state.orders) {
    const product = first.get(String(order.id)); if (!product) continue;
    const type = String(product.product_type || "").trim().toLowerCase();
    order.category = /peripheral|周边/.test(type) ? "peripheral" : /video|视频/.test(type) ? "video" : /package|combo|套餐/.test(type) || order.packageId ? "combo" : "photo";
    order.product_name = product.name || order.product_name; order.product_id = product.product_id;
  }
}
async function loadWorkbench(conn, context, {TABLES, SERVICE_FIELDS, normal, orderRow, projection, loadPhotographers}) {
  const plan = planFor(context.path); if (!plan) return null;
  const intakeAll = context.path === "/api/kf/orders/all" || context.path === "/api/kf/workbench/overview" && context.input?.mode === "intake" && (!context.input.tab || context.input.tab === "all");
  const state = { ...Object.fromEntries(Object.keys(TABLES).map(key => [key, []])), orders: [], photographers: [], photoNative: true };
  const query = async (sql, params = []) => {
    const started=process.hrtime.bigint();
    try {return (await conn.query(sql, params))[0];}
    finally {recordDatabaseOperation(Number(process.hrtime.bigint()-started)/1e6);}
  };
  const table = async (key, clause = "", params = []) => {
    const [name,,fields] = TABLES[key];
    state[key] = (await query(projection(name, fields.split(" ")) + clause, params)).map(normal);
  };
  if (plan.keys.includes("staff")) await table("staff");
  if (plan.photographers) { state.photographers = await loadPhotographers(conn); return state; }
  if (plan.orders) {
    // Exact detail lookup must distinguish an existing inaccessible order
    // (403) from an unknown order (4003). Authorization still runs before any
    // detail is returned; only list queries need SQL owner narrowing.
    const session = context.session || {};
    const scope = plan.resolve || plan.detail ? {sql:"1=1",params:[]} : orderScope(state.staff, session, true);
    // The all-orders view also includes unassigned historical terminal orders.
    // Existing owner/team restrictions still apply to assigned orders.
    if (intakeAll && (session.role === "service" || SUPERVISORS.has(session.role))) scope.sql = `(${scope.sql} OR (COALESCE(NULLIF(o.assignee_id,''),NULLIF(o.assigneeId,''),NULLIF(o.serviceUserId,'')) IS NULL AND COALESCE(o.reserve_staff_id,'')=''))`;
    let clause = " WHERE COALESCE(o.deleted,0)=0 AND COALESCE(o.isDeleted,0)=0";
    const params = [...scope.params]; clause += " AND " + scope.sql;
    // Order/event tables may use different collations. The outer binary value
    // avoids collation errors and keeps event identity case-sensitive, as the
    // original JS event lookup is. The event primary-key column stays bare.
    const managed = "EXISTS (SELECT 1 FROM svc_payment_event pe WHERE pe.order_no=BINARY o.orderNo)";
    const explicitlyClaimed = "EXISTS (SELECT 1 FROM svc_operation_log cl WHERE cl.order_no=BINARY o.orderNo AND cl.action='claim')";
    // Public candidates must remain visible even before payment attribution
    // has entered the service module. The domain projection checks actual
    // payment readiness and canonical status; ownership and writes stay scoped.
    const publicCandidate = "(COALESCE(NULLIF(o.service_status,''),'new')='new' AND COALESCE(NULLIF(o.assignee_id,''),NULLIF(o.assigneeId,''),NULLIF(o.serviceUserId,'')) IS NULL AND COALESCE(o.reserve_staff_id,'')='')";
    if (plan.managed && !intakeAll) clause += ` AND (COALESCE(o.svc_paid_processed,0)<>0 OR ${managed} OR ${explicitlyClaimed} OR o.depositDue=0 OR o.depositRatio=0 OR ${publicCandidate})`;
    if (plan.detail) { const no = decodeURIComponent(DETAIL.exec(context.path)[1]); clause += " AND (o.id=? OR o.orderNo=?)"; params.push(no, no); }
    if (plan.resolve) {
      // SQL may use a case-insensitive collation. A superset is safe: the
      // existing exact-match/candidate policy is still applied in JS.
      const text = String(context.input?.no || "").trim();
      clause += " AND LOCATE(?,o.orderNo)>0"; params.push(text);
    }
    const select = projection("lxm_orders", SERVICE_FIELDS).replace(" FROM `lxm_orders`", `, ${managed} AS _svc_event_managed FROM \`lxm_orders\` o`);
    const orderRows = await query(select + clause + " ORDER BY o.id", params);
    state.events = orderRows.filter(row=>row._svc_event_managed).map(row=>({order_no:row.orderNo}));
    state.orders = orderRows.map(row=>{const {_svc_event_managed,...order}=row;return orderRow(order);});
    if (plan.products && state.orders.length) {
      const ids = inValues("order_id", state.orders.map(order => order.id));
      mergeProducts(state, await query("SELECT order_id,product_type,name,product_id FROM lxm_order_products WHERE " + ids.sql + " ORDER BY item_no", ids.params));
    }
  }
  const orderNos = state.orders.map(order => order.order_no);
  if(plan.products&&state.orders.some(order=>order.photo_id))state.photographers=await loadPhotographers(conn);
  const ids = scopeIds(state.staff, context.session || {});
  for (const key of plan.keys) {
    if (key === "staff") continue;
    if (key === "ledger" && plan.summary) {
      const owner = ids === null ? { sql: "1=1", params: [] } : inValues("party_id", ids);
      const related = context.path === "/api/kf/workbench/overview" ? inValues("biz_no",orderNos) : {sql:"0=1",params:[]};
      await table(key, " WHERE beneficiary_type='service' AND (" + owner.sql + " OR " + related.sql + ")", [...owner.params,...related.params]); continue;
    }
    if (key === "configs") { await table(key); continue; }
    if (key === "bindings" && plan.bindings) {
      const owner = ids === null ? { sql: "1=1", params: [] } : inValues("staff_id", ids);
      await table(key, " WHERE " + owner.sql, owner.params); continue;
    }
    let filter;
    if (key === "bindingLogs" || key === "bindings") filter = inValues("openid", plan.bindings ? state.bindings.map(row => row.openid) : state.orders.map(order => order.customer_openid));
    else filter = inValues(key === "ledger" ? "biz_no" : "order_no", orderNos);
    if (filter.sql === "0=1") continue;
    const extra = key === "ledger" && !plan.detail ? " AND beneficiary_type='service'" : "";
    await table(key, " WHERE " + filter.sql + extra, filter.params);
  }
  const sourceOrders=inValues('orderNo',state.reserves.map(row=>row.source_order_no).filter(Boolean));
  if(sourceOrders.sql!=='0=1')state.reserveSources=await query("SELECT orderNo,DATE_FORMAT(done_at,'%Y-%m-%d %H:%i:%s') done_at,completedAt FROM lxm_orders WHERE "+sourceOrders.sql,sourceOrders.params);
  return state;
}
module.exports = {planFor,scopeIds,inValues,orderScope,mergeProducts,loadWorkbench};
