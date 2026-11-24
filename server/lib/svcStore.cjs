"use strict";

const { isDeepStrictEqual } = require("node:util");
const c = require("./svcCore.cjs");
const workflow = require("./orderWorkflow.cjs");
const schema = require("./mysqlSchema.cjs");
// Exact typed tables are shared by the two modules. A single InnoDB lock gives
// multi-process serialization; SQL rollback covers orders, accounting and logs.
// The initial repository favors correctness. It never substitutes demo data.
const TABLES = Object.freeze({
  staff: ["svc_staff", "id", "id name phone joined_at base_salary rate_mode supervisor_id staff_status account_id rate_review_date settlement_cycle link_valid_days observe_days wecom_userid wecom_department_id wecom_sync_status wecom_sync_message wecom_sync_started_at wecom_synced_at created_at updated_at"],
  staffLogs: ["svc_staff_profile_log", "id", "id staff_id action from_tags to_tags from_review_date to_review_date reason operator created_at"],
  operationLogs: ["svc_operation_log", "id", "id order_no action staff_id operator reason created_at"],
  receiptLogs: ["svc_receipt_log", "id", "id order_no received_at operator created_at"],
  configs: ["svc_config", "id", "id ver rebuy_on protect_days hold_minutes quiet_start quiet_end slot_remind_h observe_days link_valid_days offset_cap_bp offset_periods holiday_dates workday_dates eff_at operator created_at"],
  bindings: ["svc_binding", "id", "id openid staff_id source_order_no bound_at expire_at status release_reason released_at created_at updated_at"],
  reserves: ["svc_reserve", "id", "id order_no openid staff_id source_order_no paid_at is_quiet reserve_start_at reserve_expire_at status end_at created_at"],
  bindingLogs: ["svc_binding_log", "id", "id openid order_no from_staff to_staff action reason operator created_at"],
  slotLogs: ["svc_slot_log", "id", "id order_no from_time to_time reason channel operator created_at"],
  assignLogs: ["svc_assign_log", "id", "id order_no action from_photo to_photo reason channel zero_amount operator created_at"],
  complaints: ["svc_complaint", "id", "id order_no resp reason effect rejudge_log created_at"],
  adjustments: ["svc_adjust", "id", "id order_no staff_id action amount_fen settle_id carried plan_id period note operator created_at"],
  rules: ["benefit_rule", "id", "id ver beneficiary_type party_id rate_photo_bp rate_video_bp rate_combo_bp rate_peripheral_bp rule_mode eff_at reason operator created_at"],
  ledger: ["benefit_ledger", "id", "id biz_no beneficiary_type party_id category net_amount_fen rate_bp rate_mode rule_ver commission_fen observe_days status zero_reason customer_openid is_rebuy paid_at done_at settle_id created_at updated_at"],
  settlements: ["svc_settlement", "settle_id", "settle_id period staff_id item_count amount_fen base_salary_fen offset_fen makeup_fen payable_fen status appeal_until confirmed_at paid_at voucher_url acknowledged_at created_at"],
  appeals: ["svc_appeal", "id", "id settle_id ledger_id staff_id submitted_by reason evidence_url status l1_note l1_by l1_at l2_note l2_by l2_at revise_amount_fen created_at"],
  events: ["svc_payment_event", "order_no", "order_no paid_at processed_at"],
  links: ["svc_link", "id", "id order_no staff_id product_id url expires_at created_at"],
  notifications: ["svc_notification", "id", "id event_key event_type order_no recipient_id message status attempts next_attempt_at created_at sent_at failure_note"],
});
const APPEND_ONLY = new Set(["configs", "bindingLogs", "slotLogs", "assignLogs", "adjustments", "rules", "events", "links", "staffLogs", "receiptLogs", "operationLogs"]);
const JSON_FIELDS = new Set(["rejudge_log", "holiday_dates", "workday_dates", "from_tags", "to_tags"]);
const SERVICE_FIELDS = "customer_openid requested_time schedule_time service_status assignee_id photo_id done_at reserve_staff_id is_rebuy reflow_from svc_paid_processed".split(" ");
const ORDER_WORKFLOW_FIELDS = ["shootingStartedAt", "shootingCompletedAt", "status", "workflowStage", "completedAt"];
const REQUESTED_TIME_FACT_PATHS = ["intentDate", "intentTimePeriod"];
const ORDER_FACT_PATHS = [...REQUESTED_TIME_FACT_PATHS, "customerArrivedAt", "customerArrivedBy", "shootingStartedAt", "shootingCompletedAt", "shootingCompleted", "completionSource", "paymentReviewRequired", "selectionStatus", "selectionConfirmedAt", "selectionAcknowledgedAt"];
function normal(row) { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? c.stamp(value) : JSON_FIELDS.has(key) && typeof value === "string" ? JSON.parse(value) : typeof value === "bigint" ? String(value) : value])); }
function fen(value) { const s = String(value == null ? "0" : value); if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) return 0; const negative = s[0] === "-", [whole, frac = ""] = (negative ? s.slice(1) : s).split("."); const v = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0")); const result = Number(negative ? -v : v); if (!Number.isSafeInteger(result)) throw c.fail(4014, "订单金额超出安全范围"); return result; }
function orderTime(...values) { const value = values.find(value => value != null && value !== "" && Number.isFinite(c.millis(value))); return value == null ? null : c.stamp(value); }
function intentTime(order) {
  const date = c.text(order.intentDate), time = c.text(order.intentTimePeriod);
  // An intent such as "上午" has no exact clock time. Preserve its original
  // text, but never invent a datetime or treat the intent as a confirmed slot.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return null;
  const value = `${date} ${time.length === 5 ? time + ":00" : time}`;
  return Number.isFinite(c.millis(value)) && c.stamp(value) === value ? value : null;
}
function explicitNumber(value) { return value != null && typeof value !== "boolean" && String(value).trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null; }
function depositWaived(order) {
  // Missing legacy payment metadata is unknown, rather than a zero deposit.
  for (const key of ["depositDue", "depositFrozenAmount", "depositAmount"]) {
    const amount = explicitNumber(order[key]); if (amount !== null) return amount === 0;
  }
  for (const value of [order.depositRatio, order.depositRate, order.packageSnapshot?.depositRatio]) {
    const ratio = explicitNumber(value); if (ratio !== null) return ratio === 0;
  }
  return false;
}
function serviceStatus(order, assignee, photo) {
  const current = c.text(order.service_status).toLowerCase(), legacy = c.text(order.status).toLowerCase();
  if (["refunded", "已退款"].includes(legacy) || current === "refunded") return "refunded";
  const stage = workflow.canonicalStage(order);
  if (current === "canceled" || stage === workflow.WORKFLOW_STAGES.CANCELLED || ["canceled", "cancelled"].includes(order.workflowStage)) return "canceled";
  if (current === "done" || order.done_at || order.completedAt || [workflow.WORKFLOW_STAGES.COMPLETED, workflow.WORKFLOW_STAGES.DELIVERED].includes(stage) || order.workflowStage === "completed") return "done";
  if (current === "final_pending" || stage === workflow.WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT || order.workflowStage === "awaiting_final_payment") return "final_pending";
  // A migrated DEFAULT 'new' must not reopen a historical service in progress.
  if (["reserved", "claimed", "confirmed", "shooting"].includes(current)) return current;
  if (stage === workflow.WORKFLOW_STAGES.SHOOTING || order.workflowStage === "shooting") return "shooting";
  if (photo || stage === workflow.WORKFLOW_STAGES.AWAITING_SHOOT || order.workflowStage === "awaiting_shoot") return "confirmed";
  return assignee ? "claimed" : "new";
}
function orderRow(raw) {
  const r = normal(raw);
  const payments = (Array.isArray(r.paymentRecords) ? r.paymentRecords : []).filter(row => workflow.normalizePaymentStatus(row?.status) === "confirmed" && Number(row.amount) > 0);
  const phasePaid = phase => Number(r[phase + "Paid"]) > 0 && (!r[phase + "FinanceStatus"] || workflow.normalizePaymentStatus(r[phase + "FinanceStatus"]) === "confirmed");
  const paid = orderTime(r.depositPaidAt, r.depositConfirmedAt, r.finalPaidAt, r.finalConfirmedAt, r.paid_at, r.paidAt,
    ...payments.flatMap(row => [row.paidAt, row.paid_at, row.confirmedAt, row.successTime]));
  const hasPaid = !!paid || phasePaid("deposit") || phasePaid("final") || payments.length > 0;
  const waived = depositWaived(r), paymentStatus = hasPaid ? "paid" : waived ? "waived" : "unpaid";
  const request = r.appointmentAt || (r.bookingDate && /^\d{2}:\d{2}/.test(r.bookingTime || "") ? `${r.bookingDate} ${r.bookingTime.slice(0, 5)}:00` : null);
  const hasIntent = !!(c.text(r.intentDate) || c.text(r.intentTimePeriod));
  const requested = r.requested_time || intentTime(r) || (!hasIntent && request && Number.isFinite(c.millis(request)) ? c.stamp(request) : null);
  const assignee = r.assignee_id || r.assigneeId || r.serviceUserId || null, photo = r.photo_id || r.photographerId || null;
  const status = serviceStatus(r, assignee, photo);
  return { ...r, order_no: r.orderNo || r.order_no, customer_openid: r.customer_openid || r.openid || r._openid || null,
    customer_name: r.contactName || r.name || r.customer || "—", phone: r.contactPhone || r.phone || r.customerPhone || "",
    paid_at: paid, created_at: orderTime(r.createdAt, r.createTime, r.created_at),
    has_paid: hasPaid, deposit_waived: waived, payment_status: paymentStatus, payment_status_label: {paid:"已支付",unpaid:"未支付",waived:"免定金"}[paymentStatus],
    net_amount_fen: Math.max(0, fen(r.totalAmount ?? r.totalPrice ?? r.price) - fen(r.finalDiscountAmount) - fen(r.refundAmount)),
    service_net_amount_fen: Math.max(0, fen(r.depositPaid)), commission_basis: "paid_deposit",
    category: r.category || (r.packageId ? "combo" : "photo"), product_name: r.product_name || r.packageName || r.spotName || "旅拍订单",
    merchant_name: r.merchant_name || r.shopId || "", requested_time: requested,
    service_status: status, assignee_id: assignee,
    schedule_time: orderTime(r.schedule_time, ["confirmed", "shooting", "final_pending", "done"].includes(status) ? request : null),
    photo_id: photo, done_at: r.done_at || r.completedAt || null,
    service_managed: r.service_managed === true || Number(r.svc_paid_processed) === 1,
  };
}
async function sql(conn, statement, params = []) {
  const started=process.hrtime.bigint();
  try {const [result] = await conn.query(statement, params); return result;}
  finally {require("./observability.cjs").recordDatabaseOperation(Number(process.hrtime.bigint()-started)/1e6);}
}
// DATETIME stores Beijing wall time. Format it on the server so mysql2 never
// interprets it in the deployment host's timezone (Linux may run in UTC).
const DATE_COLUMNS = new Set(['joined_at','appeal_until','rate_review_date','from_review_date','to_review_date']);
const TIME_COLUMNS = new Set(['bound_at','expire_at','released_at','paid_at','reserve_start_at','reserve_expire_at','end_at','created_at','updated_at','processed_at','eff_at','done_at','confirmed_at','acknowledged_at','l1_at','l2_at','expires_at','next_attempt_at','sent_at','requested_time','schedule_time','from_time','to_time','received_at']);
function projection(table, fields) {
  const aliases=fields.filter(key=>DATE_COLUMNS.has(key)||TIME_COLUMNS.has(key)).map(key=>`, DATE_FORMAT(\`${key}\`, '${DATE_COLUMNS.has(key)?'%Y-%m-%d':'%Y-%m-%d %H:%i:%s'}') AS \`${key}\``).join('');
  return `SELECT *${aliases} FROM \`${table}\``;
}
async function hydrateOrderRows(conn, rows, { paths = ORDER_FACT_PATHS, includePayments = true } = {}) {
  const attributes = new Map(), payments = new Map();
  const ids = [...new Set(rows.map(row => String(row.id)))];
  for (let start = 0; start < ids.length; start += 200) {
    const batch = ids.slice(start, start + 200), placeholders = batch.map(() => "?").join(",");
    const leaves = await sql(conn, `SELECT record_id,path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM lxm_collection_values WHERE collection_name=? AND record_id IN (${placeholders}) AND path IN (${paths.map(() => "?").join(",")})`, ["orders", ...batch, ...paths]);
    for (const row of leaves) { const id = String(row.record_id); if (!attributes.has(id)) attributes.set(id, []); attributes.get(id).push(row); }
    const records = includePayments ? await sql(conn, `SELECT * FROM lxm_order_payment_records WHERE order_id IN (${placeholders}) ORDER BY order_id,record_no`, batch) : [];
    for (const row of records) { const id = String(row.order_id); if (!payments.has(id)) payments.set(id, []); payments.get(id).push(row); }
  }
  return rows.map(row => {
    const id = String(row.id), output = { ...row };
    // Only the transaction's workflow guards need these sparse facts. Keep
    // physical values and existing service response keys exactly as read.
    schema.hydrateAttributeRows(output, (attributes.get(id) || []).filter(leaf => paths.includes(leaf.path)));
    const records = payments.get(id) || [];
    if (records.length) output.paymentRecords = schema.hydrateDocument("orders", { id }, { order_payment_records: records }).paymentRecords;
    return output;
  });
}
async function load(conn, workflowFacts = true) {
  const state = {};
  for (const [key, [table,,fields]] of Object.entries(TABLES)) state[key] = (await sql(conn, projection(table,fields.split(' ')))).map(normal);
  state.accounts=(await sql(conn,'SELECT id,account,status FROM lxm_auth_users')).map(normal);
  for(const staff of state.staff){const account=state.accounts.find(row=>String(row.id)===String(staff.account_id));if(account?.account)staff.account=account.account;}
  const tags = await sql(conn,'SELECT staff_id,tag FROM svc_staff_tag ORDER BY staff_id,tag_index');
  for (const staff of state.staff) staff.assessment_tags = tags.filter(row=>String(row.staff_id)===String(staff.id)).map(row=>row.tag);
  const orderRows = await sql(conn, projection('lxm_orders',SERVICE_FIELDS) + " WHERE COALESCE(deleted,0)=0 AND COALESCE(isDeleted,0)=0");
  state.orders = (await hydrateOrderRows(conn, orderRows, workflowFacts ? {} : { paths: REQUESTED_TIME_FACT_PATHS, includePayments: false })).map(orderRow);
  const products = await sql(conn, "SELECT order_id,product_type,name,product_id FROM lxm_order_products ORDER BY item_no");
  for (const order of state.orders) { const product = products.find(p => String(p.order_id) === String(order.id)); if (product) { const type = c.text(product.product_type).toLowerCase(); order.category = /peripheral|周边/.test(type) ? "peripheral" : /video|视频/.test(type) ? "video" : /package|combo|套餐/.test(type) || order.packageId ? "combo" : "photo"; order.product_name = product.name || order.product_name; order.product_id = product.product_id; } }
  state.photoNative = true;
  state.photographers = await loadPhotographers(conn);
  return state;
}
async function loadPhotographers(conn) {
  let profiles = [];
  try { profiles = (await sql(conn,"SELECT id,name,status FROM photo_profile")).map(normal); }
  catch (error) { if (error.code !== "ER_NO_SUCH_TABLE") throw error; }
  const legacy = (await sql(conn, "SELECT id,name,role,status FROM lxm_staff WHERE COALESCE(deleted,0)=0 AND COALESCE(isDeleted,0)=0")).filter(p => /photo|摄影/.test(p.role || "")).map(p => ({ ...p, status: /终止|停用|ended|disabled|terminated|paused/.test(p.status || "") ? "ended" : "active" }));
  return [...profiles,...legacy.filter(row=>!profiles.some(profile=>String(profile.id)===String(row.id)))];
}
function dbValue(key, value) { return JSON_FIELDS.has(key) && value != null ? JSON.stringify(value) : value == null ? null : value; }
function lockedLedger(old, row) { for (const key of ["biz_no", "beneficiary_type", "party_id", "category", "net_amount_fen", "rate_bp", "rate_mode", "rule_ver", "commission_fen", "paid_at", "observe_days"]) if (String(old[key] ?? "") !== String(row[key] ?? "")) throw c.fail(5005, "分成金额与规则快照不可修改"); }
async function flush(conn, previous, state) {
  for (const [key, [table, pk, fields]] of Object.entries(TABLES)) {
    const oldRows = new Map(previous[key].map(row => [String(row[pk]), row]));
    if (previous[key].some(old => !state[key].some(row => String(row[pk]) === String(old[pk])))) throw c.fail(5005, `${table}记录不可删除`);
    for (const row of state[key]) {
      const old = oldRows.get(String(row[pk]));
      if (old && isDeepStrictEqual(old, row)) continue;
      if (old && APPEND_ONLY.has(key)) throw c.fail(5005, `${table}仅允许追加`);
      if (old && key === "ledger") lockedLedger(old, row);
      if (old && key === "complaints" && (old.resp !== row.resp || old.reason !== row.reason)) throw c.fail(5005, "原始客诉判责不可覆盖");
      if (old && key === "settlements" && old.status !== "draft") for (const field of ["period", "staff_id", "item_count", "amount_fen", "base_salary_fen", "offset_fen", "makeup_fen", "payable_fen"]) if (String(old[field] ?? "") !== String(row[field] ?? "")) throw c.fail(5005, "已确认结算单不可修改金额");
      if (old && key === "appeals" && (old.reason !== row.reason || old.evidence_url !== row.evidence_url)) throw c.fail(5005, "原始申诉不可覆盖");
      const names = fields.split(" ").filter(field => Object.hasOwn(row, field) && (!old || field !== pk) && (!old || !isDeepStrictEqual(old[field], row[field])));
      if (!names.length) continue;
      if (old) await sql(conn, `UPDATE \`${table}\` SET ${names.map(n => `\`${n}\`=?`).join(",")} WHERE \`${pk}\`=?`, [...names.map(n => dbValue(n, row[n])), row[pk]]);
      else if (key === "reserves") await sql(conn, `INSERT INTO \`${table}\` (${names.map(n => `\`${n}\``).join(",")}) VALUES (${names.map(() => "?").join(",")}) ON DUPLICATE KEY UPDATE id=id`, names.map(n => dbValue(n, row[n])));
      else await sql(conn, `INSERT INTO \`${table}\` (${names.map(n => `\`${n}\``).join(",")}) VALUES (${names.map(() => "?").join(",")})`, names.map(n => dbValue(n, row[n])));
    }
  }
  for (const staff of state.staff) {
    const old = previous.staff.find(row=>String(row.id)===String(staff.id));
    if (isDeepStrictEqual(old?.assessment_tags || [],staff.assessment_tags || [])) continue;
    await sql(conn,'DELETE FROM svc_staff_tag WHERE staff_id=?',[staff.id]);
    for (const [index,tag] of (staff.assessment_tags || []).entries()) await sql(conn,'INSERT INTO svc_staff_tag (staff_id,tag_index,tag) VALUES (?,?,?)',[staff.id,index,tag]);
  }
  for (const order of state.orders) {
    const old = previous.orders.find(r => String(r.id) === String(order.id));
    if (!old) throw c.fail(4014, "工作台不能创建订单");
    const changes = [...SERVICE_FIELDS, ...ORDER_WORKFLOW_FIELDS].filter(key => !isDeepStrictEqual(old[key], order[key]));
    if (!changes.length) continue;
    const values = Object.fromEntries(changes.map(key => [key, order[key] ?? null]));
    if (changes.includes("svc_paid_processed")) { values.customer_openid = order.customer_openid; values.requested_time = order.requested_time; }
    // Keep pre-existing customer/order views in sync without changing payment fields.
    if (changes.includes("assignee_id")) { values.assigneeId = order.assignee_id; values.serviceUserId = order.assignee_id; }
    if (changes.includes("photo_id")) values.photographerId = order.photo_id;
    if (changes.includes("schedule_time")) { values.appointmentAt = order.schedule_time; values.bookingDate = order.schedule_time && order.schedule_time.slice(0, 10); values.bookingTime = order.schedule_time && order.schedule_time.slice(11, 16); }
    if (changes.includes("done_at") && !order.completedAt) values.completedAt = order.done_at;
    // The shared schema stores sparse workflow timestamps as typed leaves.
    // Patch only the changed paths; replacing all attributes would erase
    // unrelated payment, consent and fulfillment facts on the same order.
    const split = schema.splitDocument("orders", { id: order.id, ...values });
    const names = Object.keys(split.columns);
    if (names.length) await sql(conn, `UPDATE lxm_orders SET ${names.map(n => `\`${n}\`=?`).join(",")} WHERE id=?`, [...names.map(n => split.columns[n]), order.id]);
    const attributeFields = ["collection_name", "record_id", "path", "ordinal", "value_type", "value_text", "value_number", "value_bool", "value_time"];
    for (const leaf of split.attributes) {
      const attribute = { collection_name: "orders", record_id: String(order.id), ...leaf };
      await sql(conn, `INSERT INTO lxm_collection_values (${attributeFields.map(name => `\`${name}\``).join(",")}) VALUES (${attributeFields.map(() => "?").join(",")}) ON DUPLICATE KEY UPDATE ${attributeFields.slice(4).map(name => `\`${name}\`=VALUES(\`${name}\`)`).join(",")}`, attributeFields.map(name => attribute[name] ?? null));
    }
  }
  // A single photo writer owns the four zeroing branches and no-observation
  // policy. Run only after service order/assignment/complaint writes, but before
  // this transaction commits. Failure rolls all of those writes back together.
  const changedComplaints = new Set(state.complaints.filter(row=>!isDeepStrictEqual(previous.complaints.find(old=>String(old.id)===String(row.id)),row)).map(row=>row.order_no));
  let photoService;
  const photoOrder = (order,complaints) => {
    const complaint = complaints.find(row=>row.order_no===order.order_no);
    const history = complaint && complaint.rejudge_log || [];
    const resp = history.length ? history.at(-1).to : complaint && complaint.resp;
    return {...order,no:order.order_no,zero_reason:resp==="photo"?"complaint_photo":null};
  };
  for (const order of state.orders) {
    const old = previous.orders.find(row=>String(row.id)===String(order.id));
    if (![order.photo_id,old && old.photo_id].some(id=>/^PH\d{8}$/.test(String(id || "")))) continue;
    if (!changedComplaints.has(order.order_no) && !SERVICE_FIELDS.some(key=>!isDeepStrictEqual(old && old[key],order[key]))) continue;
    photoService ||= require("./photoShare.cjs").createPhotoShareService({source:{transaction:work=>work(conn)}});
    await photoService.syncOrderTx(conn,photoOrder(order,state.complaints),old && photoOrder(old,previous.complaints),"service-workbench");
  }
}
function createSvcStore(source) {
  if (!source || typeof source.transaction !== "function") throw c.fail("SVC_STORAGE_UNAVAILABLE", "客服模块需要MySQL事务存储");
  async function transaction(work) {
    return source.transaction(async conn => {
      await sql(conn, "SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE");
      const state = await load(conn), before = structuredClone(state);
      const result = await work(state, conn); await flush(conn, before, state); return result;
    });
  }
  return { transaction, hasManualClaims: orderNo => source.transaction(async conn => {
    const specific = orderNo !== undefined && orderNo !== null;
    if (specific && !String(orderNo).trim()) return false;
    const rows = await sql(conn, "SELECT EXISTS(SELECT 1 FROM svc_operation_log WHERE action='claim'" + (specific ? " AND order_no=?" : "") + " LIMIT 1) AS has_manual_claims", specific ? [String(orderNo)] : []);
    return Number(rows[0]?.has_manual_claims) === 1;
  }), read: (work,context) => source.transaction(async conn => {
    const helpers = {TABLES,SERVICE_FIELDS,REQUESTED_TIME_FACT_PATHS,normal,orderRow,projection,loadPhotographers,hydrateOrderRows};
    const selected = context && (await require("./svcReadStore.cjs").loadWorkbench(conn,context,helpers) || await require("./svcCommissionReadStore.cjs").loadCommission(conn,context,helpers));
    return work(selected || await load(conn, false));
  }) };
}
// Explicit isolated test store. Runtime never selects this adapter.
function createSvcMemoryStore(initial = {}) {
  let state = { ...Object.fromEntries(Object.keys(TABLES).map(key => [key, []])), orders: [], photographers: [], ...structuredClone(initial) }, tail = Promise.resolve();
  return { hasManualClaims: async orderNo => orderNo != null && !String(orderNo).trim() ? false : state.operationLogs.some(row => row.action === "claim" && (orderNo == null || String(row.order_no) === String(orderNo))),
    read: async fn => fn(structuredClone(state)), transaction(fn) { const run = tail.then(async () => { const copy = structuredClone(state), result = await fn(copy); state = copy; return structuredClone(result); }); tail = run.catch(() => {}); return run; }, snapshot: () => structuredClone(state) };
}
module.exports = { TABLES, SERVICE_FIELDS, createSvcStore, createSvcMemoryStore, orderRow, fen, projection };
