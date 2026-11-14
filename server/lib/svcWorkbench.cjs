"use strict";

const c = require("./svcCore.cjs");
const workflow = require("./orderWorkflow.cjs");
const { fail, text, stamp, millis, add, nextId, uid, activeConfig, paginate } = c;
const FINAL = new Set(["refunded", "canceled"]);
const MANAGERS = new Set(["super", "admin", "administrator"]);
const SUPERVISORS = new Set(["supervisor", "service_supervisor"]);
function actor(session) { return text(session.authzUserId || session.accountId || session.subjectId || session.id || session.account); }
function staffOf(state, session) { const id = text(session.staff_id || session.staffId); return state.staff.find(s => id ? String(s.id) === id : String(s.account_id) === actor(session)); }
function scopes(state, session) {
  if (MANAGERS.has(session.role)) return null;
  const me = staffOf(state, session);
  if (!me) return new Set();
  const ids = [String(me.id)];
  if (SUPERVISORS.has(session.role)) for (const member of state.staff) if (String(member.supervisor_id) === String(me.id)) ids.push(String(member.id));
  return new Set(ids);
}
function currentResp(complaint) { return complaint && complaint.rejudge_log && complaint.rejudge_log.length ? complaint.rejudge_log.at(-1).to : complaint && complaint.resp; }
function accessible(state, order, session, pool = false) {
  if (MANAGERS.has(session.role) || session.role === "finance") return true;
  if (session.role === "photo") return String(order.photo_id) === text(session.staff_id || session.staffId || session.subjectId);
  if (pool && order.service_status === "new") return ["service", ...SUPERVISORS].includes(session.role);
  const ids = scopes(state, session); return ids && (ids.has(String(order.assignee_id)) || ids.has(String(order.reserve_staff_id)));
}
function intakeAccessible(state, order, session) {
  return accessible(state, order, session, true) || (["service", ...SUPERVISORS].includes(session.role) && !order.assignee_id && !order.reserve_staff_id);
}
function canActForStaff(state, session, staffId) {
  if (MANAGERS.has(session.role)) return true;
  const me = staffOf(state, session);
  if (!me || me.staff_status !== "active") return false;
  if (String(me.id) === String(staffId)) return true;
  return SUPERVISORS.has(session.role) && state.staff.some(row => String(row.id) === String(staffId) && String(row.supervisor_id || "") === String(me.id));
}
function operationLog(state, order, action, session, at, reason = "") {
  state.operationLogs ||= [];
  state.operationLogs.push({ id: nextId(state, "operationLogs"), order_no: order.order_no, action, staff_id: order.assignee_id || order.reserve_staff_id || null, operator: actor(session), reason, created_at: at });
}
function orderBy(state, no) { const order = state.orders.find(o => o.order_no === no || String(o.id) === no); if (!order) throw fail(4003, "订单不存在"); return order; }
function notification(state, key, type, order, recipient, message, at) {
  if (state.notifications.some(n => n.event_key === key)) return;
  state.notifications.push({ id: uid(), event_key: key, event_type: type, order_no: order && order.order_no || null, recipient_id: recipient || null, message, status: "pending", attempts: 0, next_attempt_at: at, created_at: at });
}
function bindingLog(state, order, from, to, action, reason, operator, at) { state.bindingLogs.push({ id: nextId(state, "bindingLogs"), openid: order.customer_openid, order_no: order.order_no, from_staff: from || null, to_staff: to || null, action, reason, operator, created_at: at }); }
function releaseBinding(state, order, reason, operator, at, force = false) {
  if (!order.customer_openid) return;
  if (!force && state.orders.some(o => o.customer_openid === order.customer_openid && o.service_status === "reserved")) return;
  const binding = state.bindings.find(b => b.openid === order.customer_openid && b.status === "active"); if (!binding) return;
  binding.status = "released"; binding.release_reason = reason; binding.released_at = at; binding.updated_at = at;
  bindingLog(state, order, binding.staff_id, null, "release", reason, operator, at);
}
function bind(state, order, staffId, reason, operator, at) {
  if (!order.customer_openid) return null;
  const complaint = state.complaints.find(x => x.order_no === order.order_no);
  if (currentResp(complaint) === "service") { releaseBinding(state, order, "complaint", operator, at, true); return null; }
  const cfg = activeConfig(state, order.paid_at || at);
  const existing = state.bindings.find(b => b.openid === order.customer_openid && b.status === "active");
  if (existing && String(existing.staff_id) !== String(staffId)) { existing.status = "released"; existing.release_reason = "manual"; existing.released_at = at; existing.updated_at = at; }
  const row = existing && String(existing.staff_id) === String(staffId) ? existing : { id: nextId(state, "bindings"), openid: order.customer_openid, staff_id: String(staffId), status: "active", created_at: at };
  Object.assign(row, { source_order_no: order.order_no, bound_at: at, expire_at: add(at, cfg.protect_days), updated_at: at });
  if (row !== existing) state.bindings.push(row);
  bindingLog(state, order, existing && existing.staff_id, staffId, !existing ? "bind" : String(existing.staff_id) === String(staffId) ? "renew" : "transfer", reason, operator, at);
  return row;
}
function reflow(state, reserve, reason, operator, at) {
  const order = orderBy(state, reserve.order_no);
  if (order.service_status !== "reserved" || !["holding", "started"].includes(reserve.status)) return false;
  operationLog(state, order, reason === "timeout" ? "reserve_timeout" : "reserve_giveup", { id: operator }, at, reason);
  reserve.status = reason === "timeout" ? "timeout" : "givenup"; reserve.end_at = at;
  order.service_status = "new"; order.reserve_staff_id = null; order.assignee_id = null; order.reflow_from = reserve.staff_id;
  releaseBinding(state, order, reason, operator, at);
  notification(state, `reserve-${reason}:${order.order_no}`, "reserve_reflow", order, reserve.staff_id, `订单 ${order.order_no} 已${reason === "timeout" ? "超时回流" : "主动放弃"}`, at);
  return true;
}
function stateEnteredAt(state, order, index) {
  const actions = { new: ["reserve_timeout", "reserve_giveup"], claimed: ["claim", "reserve_take"], confirmed: ["slot_confirm"], shooting: ["shoot_start"], final_pending: ["shoot_finish"], done: ["order_complete", "receipt_confirmed", "shoot_finish"], refunded: ["refund"] }[order.service_status] || [];
  const logs = index ? index.operationLogs.get(order.order_no) || [] : (state.operationLogs || []).filter(row => row.order_no === order.order_no);
  const latest = logs.filter(row => actions.includes(row.action)).reduce((last, row) => millis(row.created_at) > millis(last || 0) ? row.created_at : last, null);
  return latest || order.status_changed_at || (order.service_status === "done" ? order.done_at : null) || order.paid_at || order.created_at || order.createdAt || null;
}
function visibleOrder(state, order, at, index) {
  const reserve = index ? index.reserves.get(order.order_no) : state.reserves.find(r => r.order_no === order.order_no && ["holding", "started"].includes(r.status));
  const staff = index ? index.staff.get(String(order.assignee_id || order.reserve_staff_id)) : state.staff.find(s => String(s.id) === String(order.assignee_id || order.reserve_staff_id));
  const ledger = index ? index.ledger.get(JSON.stringify([order.order_no, String(order.assignee_id)])) : state.ledger.find(l => l.biz_no === order.order_no && l.beneficiary_type === "service" && String(l.party_id) === String(order.assignee_id));
  const photo=(state.photographers||[]).find(person=>String(person.id)===String(order.photo_id));
  const source=reserve&&(state.reserveSources||state.orders).find(row=>String(row.order_no||row.orderNo)===String(reserve.source_order_no));
  const sourceDoneAt=source&&(source.done_at||source.completedAt);
  const enteredAt = stateEnteredAt(state, order, index);
  const reservations = index ? index.reservationHistory.get(order.order_no) || [] : state.reserves.filter(row => row.order_no === order.order_no);
  return { ...order,photo_name:photo?.name || order.photographer || null,assignee_name: staff && staff.name || "", commission_fen: ledger ? Number(ledger.commission_fen) : null,
    commission_basis_amount_fen: ledger ? Number(ledger.net_amount_fen) : Number(order.service_net_amount_fen ?? order.net_amount_fen ?? 0),
    ledger_status: ledger && ledger.status || null, rate_bp: ledger && ledger.rate_bp || null, rate_mode: ledger && ledger.rate_mode || null,
    rescheduled: !!(order.requested_time && order.schedule_time && order.requested_time !== order.schedule_time),
    status_changed_at: enteredAt,
    stay_minutes: enteredAt && Number.isFinite(millis(enteredAt)) ? Math.max(0, Math.floor((millis(at) - millis(enteredAt)) / 60000)) : 0,
    reflow_count: Math.max(Number(order.reflow_count) || 0, reservations.filter(row => ["timeout", "givenup"].includes(row.status)).length, order.reflow_from ? 1 : 0),
    ...(reserve ? { reserve_status: reserve.status, status: reserve.status, reserve_defer: reserve.status === "holding", ...reserve,source_done_at:sourceDoneAt&&Number.isFinite(millis(sourceDoneAt))?stamp(sourceDoneAt):null,hold_minutes: Math.round((millis(reserve.reserve_expire_at) - millis(reserve.reserve_start_at)) / 60000), left_seconds: c.leftSeconds(reserve, at) } : {}),
    // Keep order status distinct from reservation status.
    service_status: order.service_status, order_no: order.order_no,
  };
}
function filterOrders(rows, input) { const keyword = text(input.keyword).toLowerCase(), type = text(input.type || input.category); return rows.filter(o => (!type || o.category === type) && (!input.photo || String(o.photo_id) === String(input.photo)) && (!input.status || o.service_status === input.status) && (!keyword || [o.order_no, o.customer_openid, o.customer_name, o.product_name].some(v => text(v).toLowerCase().includes(keyword)))); }
function readIndex(state) {
  const index = { staff: new Map(), reserves: new Map(), reservationHistory: new Map(), ledger: new Map(), order: new Map(), adjustments: new Map(), bindingLogs: new Map(), operationLogs: new Map() };
  for (const row of state.staff) if (!index.staff.has(String(row.id))) index.staff.set(String(row.id), row);
  for (const row of state.reserves) {
    if (["holding", "started"].includes(row.status) && !index.reserves.has(row.order_no)) index.reserves.set(row.order_no, row);
    if (!index.reservationHistory.has(row.order_no)) index.reservationHistory.set(row.order_no, []);
    index.reservationHistory.get(row.order_no).push(row);
  }
  for (const row of state.ledger) if (row.beneficiary_type === "service") { const key = JSON.stringify([row.biz_no, String(row.party_id)]); if (!index.ledger.has(key)) index.ledger.set(key, row); }
  for (const row of state.orders) for (const key of [row.order_no, String(row.id)]) if (!index.order.has(key)) index.order.set(key, row);
  for (const row of state.adjustments) { if (!index.adjustments.has(row.order_no)) index.adjustments.set(row.order_no, []); index.adjustments.get(row.order_no).push(row); }
  for (const row of state.bindingLogs) { if (!index.bindingLogs.has(row.openid)) index.bindingLogs.set(row.openid, []); index.bindingLogs.get(row.openid).push(row); }
  for (const row of state.operationLogs || []) { if (!index.operationLogs.has(row.order_no)) index.operationLogs.set(row.order_no, []); index.operationLogs.get(row.order_no).push(row); }
  return index;
}

function createSvcWorkbench(options = {}) {
  const store = options.store || require("./svcStore.cjs").createSvcStore(options.source);
  const benefit = options.benefit || require("./svcCommission.cjs");
  const clock = options.clock || (() => new Date());
  const now = () => stamp(clock());
  function canWrite(session, kind) {
    if (MANAGERS.has(session.role)) return;
    if (kind === "config") throw fail(403, "仅超级管理员可操作");
    if (kind === "rejudge" && !SUPERVISORS.has(session.role)) throw fail(403, "仅主管或超级管理员可改判");
    if (kind === "complaint" && session.role === "finance") return;
    if (session.role !== "service" && !SUPERVISORS.has(session.role)) throw fail(403, "无操作权限");
  }
  function checkOrder(state, no, input, session, expected) {
    const order = orderBy(state, no);
    if (!accessible(state, order, session, true)) throw fail(403, "无权操作他人订单");
    if (input.expected_status == null || input.expected_status !== order.service_status) throw fail(4003, "订单状态已变化，请刷新", { service_status: order.service_status });
    if (FINAL.has(order.service_status) || expected && !expected.includes(order.service_status)) throw fail(4003, "当前状态不允许此操作");
    return order;
  }
  function activeStaff(state, session) { const me = staffOf(state, session); if (!me || me.staff_status !== "active") throw fail(403, "请先关联在职客服档案后接单"); return me; }
  async function completeOrder(state, order, at, operator = "system") {
    const zeroBalanceAcknowledged = workflow.finalDue(order) > 0
      || order.completionSource === "zero_balance" && !!order.completedAt
      || (Array.isArray(order.paymentRecords) ? order.paymentRecords : [])
      .some(record => record.phase === "final" && record.provider === "zero_balance" && Number(record.amount) === 0 && workflow.normalizePaymentStatus(record.status) === "confirmed");
    if (FINAL.has(order.service_status) || workflow.canonicalStage(order) === workflow.WORKFLOW_STAGES.CANCELLED
      || order.paymentReviewRequired || !workflow.hasConfirmedPayment(order, "final") || !zeroBalanceAcknowledged) throw fail(4003, "尾款尚未确认，订单不可完成");
    if (!workflow.hasCompletedShooting(order)) throw fail(4003, "请先确认拍摄完成");
    if ((state.operationLogs || []).some(row => row.order_no === order.order_no && row.action === "order_complete")) return { ...visibleOrder(state, order, at), duplicate: true, idempotent: true };
    const completedAt = order.completedAt || order.done_at || at;
    const doneAt = stamp(completedAt);
    Object.assign(order, { service_status: "done", done_at: doneAt, status: "completed", workflowStage: workflow.WORKFLOW_STAGES.COMPLETED, completedAt });
    if (benefit.ensureLedger) await benefit.ensureLedger(state, order, at);
    if (benefit.ensureLedger && state.rules.some(row => row.beneficiary_type === "photo")) await benefit.ensureLedger(state, order, at, "photo");
    const binding = order.assignee_id ? bind(state, order, order.assignee_id, "尾款确认完成服务", operator, doneAt) : null;
    const ledger = state.ledger.find(row => row.biz_no === order.order_no && row.beneficiary_type === "service" && String(row.party_id) === String(order.assignee_id));
    operationLog(state, order, "order_complete", { id: operator }, doneAt);
    return { ...visibleOrder(state, order, at), bound: !!binding, bind_expire_at: binding && binding.expire_at || null,
      observe_until: ledger ? add(doneAt, Number(ledger.observe_days ?? c.staffTiming(state.staff.find(staff => String(staff.id) === String(order.assignee_id)), activeConfig(state, order.paid_at)).observe_days)) : null };
  }
  async function onCompleted(input) {
    const no = text(input.order_no || input.orderNo || input.no || input.id), at = now();
    return store.transaction(async state => completeOrder(state, orderBy(state, no), at));
  }
  async function onPaid(input) {
    const no = text(input.order_no || input.orderNo || input.no || input.id), at = now();
    return store.transaction(async state => {
      const order = orderBy(state, no);
      if (state.events.some(e => e.order_no === order.order_no) || state.reserves.some(r => r.order_no === order.order_no)) return { duplicate: true, order_no: order.order_no };
      const paidAt = input.paid_at || input.depositPaidAt || order.paid_at;
      if (!paidAt || !Number.isFinite(millis(paidAt))) throw fail(4014, "支付事件缺少有效支付时间");
      order.paid_at = stamp(paidAt);
      if (input.customer_openid || input.openid || input._openid) order.customer_openid = input.customer_openid || input.openid || input._openid;
      state.events.push({ order_no: order.order_no, paid_at: order.paid_at, processed_at: at });
      order.svc_paid_processed = 1; order.service_managed = true;
      if (FINAL.has(order.service_status) || !["new", "reserved"].includes(order.service_status) || order.assignee_id) return { skipped: true, order_no: order.order_no };
      const cfg = activeConfig(state, order.paid_at);
      if (!order.customer_openid || !Number(cfg.rebuy_on)) return { reserved: false, order_no: order.order_no };
      const binding = state.bindings.find(b => b.openid === order.customer_openid && b.status === "active" && millis(b.expire_at) > millis(order.paid_at));
      if (!binding) return { reserved: false, order_no: order.order_no };
      const staff = state.staff.find(s => String(s.id) === String(binding.staff_id));
      if (!staff || staff.staff_status !== "active") { releaseBinding(state, order, "manual", "system", at, true); return { reserved: false, order_no: order.order_no }; }
      const reserve = { id: nextId(state, "reserves"), order_no: order.order_no, openid: order.customer_openid, staff_id: binding.staff_id, source_order_no: binding.source_order_no, paid_at: order.paid_at, ...c.reserveWindow(order.paid_at, cfg), created_at: at };
      state.reserves.push(reserve); order.service_status = "reserved"; order.reserve_staff_id = binding.staff_id; order.is_rebuy = 1;
      notification(state, `rebuy:${order.order_no}`, "rebuy_reserved", order, binding.staff_id, `复购订单 ${order.order_no} 已预占`, at);
      return { reserved: true, ...reserve };
    });
  }
  async function onRefund(input) {
    const no = typeof input === "string" ? input : text(input.order_no || input.orderNo || input.id), at = now();
    return store.transaction(async state => {
      const order = orderBy(state, no); if (order.service_status === "refunded") return { duplicate: true };
      if (order.service_status === "canceled") throw fail(4003, "已取消订单不可回退");
      operationLog(state, order, "refund", { id: "system" }, at);
      order.service_status = "refunded";
      order.reserve_staff_id = null;
      const reserve = state.reserves.find(r => r.order_no === order.order_no && ["holding", "started"].includes(r.status));
      if (reserve) { reserve.status = "canceled"; reserve.end_at = at; }
      if (benefit.onRefund) await benefit.onRefund(state, order, at);
      return { order_no: order.order_no, service_status: "refunded" };
    });
  }
  async function complaintTx(state, input, session, at, order) {
    const existing = state.complaints.find(r => r.order_no === order.order_no);
    if (existing) throw fail(4010, "该单已有客诉，可直接改判", { id: existing.id, complaint_id: existing.id });
    if (!["service", "photo", "user", "unknown"].includes(input.resp)) throw fail(4014, "请选择责任方");
    const row = { id: nextId(state, "complaints"), order_no: order.order_no, resp: input.resp, reason: c.requireReason(input), effect: "none", rejudge_log: [], created_at: at };
    state.complaints.push(row);
    if (benefit.applyComplaint) await benefit.applyComplaint(state, order, null, input.resp, at, actor(session));
    if (input.resp === "service") { releaseBinding(state, order, "complaint", actor(session), at, true); row.effect = state.ledger.some(l => l.biz_no === order.order_no && l.status === "settled") ? "offset_planned" : "void"; }
    notification(state, `complaint:${row.id}`, "complaint_created", order, order.assignee_id, `订单 ${order.order_no} 新增售后登记`, at);
    return row;
  }
  async function execute(method, path, input = {}, session = {}) {
    method = method.toUpperCase(); path = path.split("?")[0].replace(/\/$/, "");
    if (!session.role || session.kind && session.kind !== "admin") throw fail(401, "请先登录后台");
    if (![...MANAGERS, ...SUPERVISORS, "service", "finance", "photo"].includes(session.role)) throw fail(403, "当前角色无客服工作台访问权限");
    const at = now();
    const read = method === "GET";
    if (read && path === "/api/kf/workbench/overview" && (!['workbench','intake'].includes(input.mode || 'workbench') || input.mode === 'intake' && !['all','pool','mine'].includes(input.tab || 'all'))) throw fail(4014, "工作台视图参数无效");
    return (read ? store.read : store.transaction)(async state => {
      const ids = scopes(state, session);
      const me = staffOf(state, session);
      // These indexes belong only to this GET snapshot. Mutations keep using
      // live arrays so a just-claimed/assigned order is presented accurately.
      const index = read ? readIndex(state) : null;
      const allowed = (order, pool = false) => {
        if (!read) return accessible(state, order, session, pool);
        if (MANAGERS.has(session.role) || session.role === "finance") return true;
        if (session.role === "photo") return String(order.photo_id) === text(session.staff_id || session.staffId || session.subjectId);
        if (pool && order.service_status === "new") return ["service", ...SUPERVISORS].includes(session.role);
        return ids && (ids.has(String(order.assignee_id)) || ids.has(String(order.reserve_staff_id)));
      };
      const canAct = staffId => read ? MANAGERS.has(session.role) || !!me && me.staff_status === "active" && (String(me.id) === String(staffId) || SUPERVISORS.has(session.role) && String(index.staff.get(String(staffId))?.supervisor_id || "") === String(me.id)) : canActForStaff(state, session, staffId);
      const eventOrders = new Set(state.events.map(e => e.order_no));
      const claimedOrders = read ? new Set((state.operationLogs || []).filter(log => log.action === "claim").map(log => log.order_no)) : null;
      // An explicit claim is a durable admission to service fulfillment. It
      // does not stand in for a payment callback or replay rebuy attribution.
      const isManaged = order => !!(order.service_managed || Number(order.svc_paid_processed) === 1 || eventOrders.has(order.order_no) || order.deposit_waived || (claimedOrders ? claimedOrders.has(order.order_no) : (state.operationLogs || []).some(log => log.order_no === order.order_no && log.action === "claim")));
      const ready = order => !!order.deposit_waived || !!order.paid_at && (order.depositPaid == null || Number(order.depositPaid) > 0 || Number(order.finalPaid) > 0);
      const hasReservation = order => index ? index.reserves.has(order.order_no) : state.reserves.some(row => row.order_no === order.order_no && ['holding','started'].includes(row.status));
      const claimCandidate = order => ready(order) && order.service_status === "new" && !order.assignee_id && !order.reserve_staff_id && !hasReservation(order);
      const operator = MANAGERS.has(session.role) || session.role === "service" || SUPERVISORS.has(session.role);
      const present = order => {
        const operable = isManaged(order) && ready(order) && !FINAL.has(order.service_status);
        return { ...visibleOrder(state, order, at, index), is_mine: !!me && String(order.assignee_id || order.reserve_staff_id) === String(me.id),
          can_claim: operator && claimCandidate(order) && allowed(order, true),
          can_complaint: isManaged(order) && ready(order) && (operator || session.role === "finance") && allowed(order),
          can_rejudge: (MANAGERS.has(session.role) || SUPERVISORS.has(session.role)) && allowed(order),
          can_generate_link: operable && !!order.assignee_id && canAct(order.assignee_id), can_operate: operable && operator && allowed(order, true) };
      };
      const all = state.orders.filter(o => allowed(o, true) || (["service", ...SUPERVISORS].includes(session.role) && !o.assignee_id && !o.reserve_staff_id));
      const managed = state.orders.filter(isManaged);
      const pool = all.filter(claimCandidate);
      const own = managed.filter(o => allowed(o));
      const reserveSeconds = order => { const reserve = index ? index.reserves.get(order.order_no) : state.reserves.find(r => r.order_no === order.order_no && ["holding", "started"].includes(r.status)); return reserve ? c.leftSeconds(reserve, at) : undefined; };
      const summary = () => {
        const day = at.slice(0, 10), currentMonth = at.slice(0, 7), ownNos = new Set(own.map(o => o.order_no));
        return { pool: pool.length, pending: own.filter(o => o.service_status === "claimed").length,assign_pending:own.filter(o=>o.service_status==='confirmed'&&!o.photo_id&&o.category!=='peripheral').length,shooting_pending:own.filter(o=>o.service_status==='shooting'&&o.category!=='peripheral').length,final_pending:own.filter(o=>o.service_status==='final_pending').length,today_shooting: own.filter(o => (o.schedule_time || "").startsWith(day) && ["confirmed", "shooting"].includes(o.service_status)).length, reserved: own.filter(o => o.service_status === "reserved").length, complaints: state.complaints.filter(r => currentResp(r) === "unknown" && ownNos.has(r.order_no)).length,
          commission_fen: state.ledger.filter(l => l.beneficiary_type === "service" && (ids === null || ids.has(String(l.party_id))) && (l.paid_at || "").startsWith(currentMonth) && l.status !== "void").reduce((sum, l) => sum + Number(l.commission_fen), 0) };
      };
      const todo = () => {
        const pendingComplaints = new Map(state.complaints.filter(row => currentResp(row) === "unknown").map(row => [row.order_no, row]));
        const rows = own.filter(o => ["reserved", "claimed", "confirmed", "shooting", "final_pending"].includes(o.service_status) || pendingComplaints.has(o.order_no)).map(order => {
          const left = reserveSeconds(order), urgent = order.service_status === "reserved" && left != null && left <= 600;
          const complaint = pendingComplaints.get(order.order_no);
          if (urgent) return { order, left, priority: 0, title: "接这单", suggested_action: "reserve_take" };
          if (complaint) return { order, left, complaint, priority: 2, title: "复核客诉判责", suggested_action: "rejudge" };
          if (order.service_status === "reserved") return { order, left, priority: left == null ? 6 : 3, title: left == null ? "夜间预占待起算，可提前接单" : "复购预占待接单", suggested_action: "reserve_take" };
          if (order.category === "peripheral") return { order, priority: 4, title: "跟进实物收货", suggested_action: "receipt_confirm" };
          if (order.service_status === "final_pending") return { order, priority: 5, title: "跟进尾款支付", suggested_action: "detail" };
          if (order.service_status === "claimed") return { order, priority: 3, title: "企微确认拍摄时间", suggested_action: "slot_confirm" };
          if (order.service_status === "confirmed" && !order.photo_id) return { order, priority: 4, title: "登记派单摄影师", suggested_action: "assign" };
          return { order, priority: 5, title: order.service_status === "shooting" ? "跟进拍摄进展" : "跟进拍摄到场", suggested_action: order.service_status === "shooting" ? "shoot_finish" : "shoot_start" };
        });
        if (operator) rows.push(...pool.sort((a, b) => millis(a.paid_at || a.created_at) - millis(b.paid_at || b.created_at) || String(a.order_no).localeCompare(String(b.order_no))).slice(0, 6).map(order => ({ order, priority: 1, title: "认领并联系客户", suggested_action: "claim" })));
        rows.sort((a, b) => a.priority - b.priority || (a.left ?? Infinity) - (b.left ?? Infinity) || millis(stateEnteredAt(state, a.order, index)) - millis(stateEnteredAt(state, b.order, index)) || String(a.order.order_no).localeCompare(String(b.order.order_no)));
        const result = paginate(rows, input);
        return { ...result, list: result.list.map(({ order, priority, title, suggested_action, complaint }) => ({ ...present(order), priority, title, suggested_action, ...(complaint ? { complaint_id: complaint.id, current_resp: currentResp(complaint), stay_minutes: Math.max(0, Math.floor((millis(at) - millis(complaint.rejudge_log?.at(-1)?.at || complaint.created_at)) / 60000)) } : {}) })) };
      };
      const orderList = (view, query = input) => {
        const rows = filterOrders(view === "all" ? all : view === "pool" ? pool : own.filter(o => view === "reserved" ? o.service_status === "reserved" : o.service_status !== "reserved").filter(o => query.view === "active" ? ["claimed", "confirmed", "shooting", "final_pending"].includes(o.service_status) : query.view === "done" ? o.service_status === "done" : true), query);
        if (view === "reserved") rows.sort((a, b) => (reserveSeconds(a) ?? Infinity) - (reserveSeconds(b) ?? Infinity)); else rows.sort((a, b) => (millis(b.created_at || b.createdAt || b.paid_at) || 0) - (millis(a.created_at || a.createdAt || a.paid_at) || 0) || String(b.order_no).localeCompare(String(a.order_no)));
        const result = paginate(rows, query); return { ...result, list: result.list.map(present) };
      };
      const configShape = () => ({ active: activeConfig(state, at), latest: [...state.configs].sort((a, b) => Number(b.ver) - Number(a.ver))[0] || { ...c.DEFAULT_CONFIG }, versions: [...state.configs].sort((a, b) => Number(b.ver) - Number(a.ver)) });
      if (path === "/api/kf/rebuy/config") { if (read) return configShape(); canWrite(session, "config"); return c.saveConfig(state, input, actor(session), at); }
      if (path === "/api/kf/photographers" && read) return { list: state.photographers.filter(p => p.status === "active") };
      if (path === "/api/kf/staff" && read) {
        if (![...MANAGERS, ...SUPERVISORS].includes(session.role)) throw fail(403, "仅主管或超级管理员可代办选人");
        return { list: state.staff.filter(row => row.staff_status === "active" && canActForStaff(state, session, row.id)).map(row => ({ id: row.id, name: row.name, is_self: String(row.id) === String(me?.id || "") })) };
      }
      if (path === "/api/kf/rebuy/bindings" && read) {
        const rows = state.bindings.filter(b => ids === null || ids.has(String(b.staff_id))).filter(b => !input.status || b.status === input.status).sort((a, b) => millis(b.expire_at) - millis(a.expire_at));
        const result = paginate(rows, input);
        return { ...result, list: result.list.map(b => ({ ...b, staff_name: index.staff.get(String(b.staff_id))?.name || "", logs: [...(index.bindingLogs.get(b.openid) || [])].sort((a, b) => millis(b.created_at) - millis(a.created_at)) })) };
      }
      if (path === "/api/kf/workbench/summary" && read) {
        return summary();
      }
      if (path === "/api/kf/workbench/todo" && read) {
        return todo();
      }
      if (path === "/api/kf/workbench/overview" && read) {
        const mode = input.mode || "workbench";
        const list = mode === "intake" ? orderList(input.tab || "all") : todo();
        return { summary: mode === "workbench" ? summary() : {}, ...list, reserved: orderList("reserved", { page: 1, size: 100 }) };
      }
      if (/^\/api\/kf\/orders\/(all|pool|mine|reserved)$/.test(path) && read) {
        return orderList(path.split("/").at(-1));
      }
      if (path === "/api/kf/link/resolve" && read) {
        const query = text(input.no); if (!query) throw fail(4012, "订单号未匹配，链接必须挂在一张真实订单上");
        const exact = state.orders.filter(o => o.order_no === query);
        if (exact.length !== 1) throw fail(4012, "订单号未匹配，链接必须挂在一张真实订单上", { candidates: state.orders.filter(o => text(o.order_no).includes(query) && accessible(state, o, session)).slice(0, 10).map(o => o.order_no) });
        const me = staffOf(state, session), row = exact[0], mine = me && String(row.assignee_id) === String(me.id), delegated = !!row.assignee_id && canActForStaff(state, session, row.assignee_id);
        if (!delegated) return { order_no: row.order_no, is_mine: false, can_generate_link: false, message: "非本人或直属组订单，不可生成链接" };
        return { ...present(row), is_mine: !!mine };
      }
      if (path === "/api/kf/link/generate" && method === "POST") {
        canWrite(session, "order"); const order = orderBy(state, text(input.order_no || input.no));
        if (!order.assignee_id || !canActForStaff(state, session, order.assignee_id)) throw fail(4011, "非本人或直属组订单，不可生成链接");
        if (!isManaged(order) || !ready(order)) throw fail(4003, "该订单暂不可操作");
        const owner = state.staff.find(row => String(row.id) === String(order.assignee_id));
        if (!owner || owner.staff_status !== "active") throw fail(4011, "归属客服已暂停或终止，不可生成链接");
        if (FINAL.has(order.service_status)) throw fail(4003, "终态订单不可生成链接");
        if (!options.linkProvider) throw fail(503, "请先配置企业微信客服映射与小程序发链通道");
        const cfg = c.staffTiming(owner, activeConfig(state, at)), id = uid(), expires = add(at, cfg.link_valid_days);
        const generated = await options.linkProvider({ order, staff: owner, session, id, expires_at: expires });
        const url = text(generated.url || generated.path); if (!url) throw fail(503, "发链通道未返回有效链接");
        const row = { id, order_no: order.order_no, staff_id: owner.id, product_id: order.product_id || order.packageId || null, url, expires_at: expires, created_at: at };
        state.links.push(row); operationLog(state, order, "link_generate", session, at); return { ...row, ...generated };
      }
      if (path === "/api/kf/complaints") {
        if (read) {
          const accessibleNos = new Set(state.orders.filter(o => allowed(o)).map(o => o.order_no));
          const rows = state.complaints.filter(r => accessibleNos.has(r.order_no)).filter(r => !input.resp || currentResp(r) === input.resp)
            .filter(r => { const order = index.order.get(r.order_no); return !input.keyword || [r.order_no, Object.hasOwn(r,"customer_openid") ? r.customer_openid : order?.customer_openid, r.reason, Object.hasOwn(r,"product_name") ? r.product_name : order?.product_name].some(v => text(v).includes(text(input.keyword))); })
            .sort((a, b) => millis(b.created_at) - millis(a.created_at));
          const result = paginate(rows, input);
          return { ...result, list: result.list.map(r => ({ ...present(index.order.get(r.order_no)), ...r, current_resp: currentResp(r), adjustments: index.adjustments.get(r.order_no) || [] })) };
        }
        canWrite(session, "complaint"); const order = orderBy(state, text(input.order_no)); if (!accessible(state, order, session)) throw fail(403, "无权登记他人订单售后"); if (!isManaged(order) || !ready(order)) throw fail(4003, "该订单暂不可操作"); return complaintTx(state, input, session, at, order);
      }
      const rejudge = /^\/api\/kf\/complaints\/([^/]+)\/rejudge$/.exec(path);
      if (rejudge && method === "POST") {
        canWrite(session, "rejudge"); const complaint = state.complaints.find(r => r.order_no === decodeURIComponent(rejudge[1]) || String(r.id) === rejudge[1]); if (!complaint) throw fail(4014, "客诉记录不存在");
        if (!["service", "photo", "user", "unknown"].includes(input.resp)) throw fail(4014, "请选择责任方");
        const oldResp = currentResp(complaint), why = c.requireReason(input), order = orderBy(state, complaint.order_no);
        if (!accessible(state, order, session)) throw fail(403, "无权改判其他组订单");
        if (oldResp === input.resp) throw fail(4014, "判责未发生变化");
        complaint.rejudge_log ||= []; complaint.rejudge_log.push({ from: oldResp, to: input.resp, why, by: actor(session), at });
        if (benefit.applyComplaint) await benefit.applyComplaint(state, order, oldResp, input.resp, at, actor(session));
        if (input.resp === "service") releaseBinding(state, order, "complaint", actor(session), at, true);
        complaint.effect = input.resp === "service" ? state.ledger.some(l => l.biz_no === order.order_no && l.status === "settled") ? "offset_planned" : "void" : "none";
        notification(state, `rejudge:${complaint.id}:${complaint.rejudge_log.length}`, "complaint_rejudged", order, order.assignee_id, `订单 ${order.order_no} 判责已变更，差异随下期结算`, at);
        return complaint;
      }
      const match = /^\/api\/kf\/orders\/([^/]+)(?:\/(.+))?$/.exec(path);
      if (!match) throw fail(404, "客服工作台接口不存在");
      const no = decodeURIComponent(match[1]), action = match[2];
      if (read && !action) {
        const order = orderBy(state, no); if (!intakeAccessible(state, order, session)) throw fail(403, "无权查看他人订单");
        const timeline = [...state.slotLogs.filter(l => l.order_no === order.order_no).map(l => ({ ...l, action: "reschedule" })), ...state.assignLogs.filter(l => l.order_no === order.order_no), ...state.bindingLogs.filter(l => l.order_no === order.order_no), ...state.adjustments.filter(l => l.order_no === order.order_no), ...(state.receiptLogs || []).filter(l => l.order_no === order.order_no).map(l => ({ ...l, action: "receipt_confirmed" })), ...(state.operationLogs || []).filter(l => l.order_no === order.order_no)].sort((a, b) => millis(b.created_at) - millis(a.created_at));
        const row = present(order); if (!MANAGERS.has(session.role) && session.role === "photo") for (const key of ["commission_fen", "rate_bp", "rate_mode"]) delete row[key];
        const reservation=state.reserves.find(r=>r.order_no===order.order_no),cfg=activeConfig(state,order.paid_at || at);
        const photoLedger=state.ledger.find(l=>l.biz_no===order.order_no&&l.beneficiary_type==='photo'&&String(l.party_id)===String(order.photo_id));
        const photoCommission=photoLedger ? photoLedger.status==='void'||photoLedger.zero_reason ? 0 : Number(photoLedger.commission_fen) : null;
        const serviceLedger=state.ledger.find(l=>l.biz_no===order.order_no&&l.beneficiary_type==='service'&&String(l.party_id)===String(order.assignee_id));
        const effectiveService=serviceLedger?serviceLedger.status==='void'?0:Number(serviceLedger.commission_fen):null;
        const reflow=state.operationLogs.filter(l=>l.order_no===order.order_no&&['reserve_giveup','reserve_timeout'].includes(l.action)).sort((a,b)=>millis(b.created_at)-millis(a.created_at))[0];
        return { ...row,slot_remind_h:cfg.slot_remind_h,reminder_at:Number(cfg.slot_remind_h)>0&&order.schedule_time?add(order.schedule_time,-Number(cfg.slot_remind_h),3600000):null,
          reserve_source_order_no:reservation?.source_order_no || null,reserve_staff_name:state.staff.find(person=>String(person.id)===String(reservation?.staff_id))?.name || null,
          reflow_name:state.staff.find(person=>String(person.id)===String(order.reflow_from))?.name || null,reflow_at:reflow?.created_at || reservation?.end_at || null,
          photo_commission_fen:session.role==='photo'?null:photoCommission,margin_share_percent:session.role==='photo'||photoCommission===null||effectiveService===null||Number(order.net_amount_fen)<=0?null:Number(((photoCommission+effectiveService)/Number(order.net_amount_fen)*100).toFixed(1)),margin_alert_percent:cfg.gross_margin_warn_pct ?? null,
          timeline, complaint: state.complaints.find(r => r.order_no === order.order_no) || null, bindings: state.bindings.filter(b => b.openid === order.customer_openid), commission: session.role === "photo" ? null : serviceLedger || null };
      }
      if (method !== "POST") throw fail(404, "客服工作台接口不存在");
      canWrite(session, action === "aftersale" ? "complaint" : "order");
      const actionOrder = orderBy(state, no);
      if (!ready(actionOrder) || action !== "claim" && !isManaged(actionOrder)) throw fail(4003, "该订单尚未进入客服流程或未支付，请核验后再操作");
      // A competing claim receives its precise current owner rather than stale-state text.
      if (action === "claim") {
        const order = orderBy(state, no);
        if (FINAL.has(order.service_status)) throw fail(4003, "当前状态不允许认领");
        if (order.service_status === "reserved" || order.reserve_staff_id || state.reserves.some(row => row.order_no === order.order_no && ["holding", "started"].includes(row.status))) throw fail(4002, "该单在他人复购预占期内");
        if (order.assignee_id) { const owner = state.staff.find(s => String(s.id) === String(order.assignee_id)); throw fail(4001, `认领失败：该单已被 ${owner?.name || "其他客服"} 认领`); }
        if (order.service_status !== "new") throw fail(4003, "当前状态不允许认领");
        if (!ready(order)) throw fail(4003, "未支付订单不可认领");
        if (input.expected_status !== "new") throw fail(4003, "订单状态已变化，请刷新");
        const requestedId = (MANAGERS.has(session.role) || SUPERVISORS.has(session.role)) && input.staff_id ? text(input.staff_id) : null;
        const targetId = requestedId || String(activeStaff(state, session).id), target = state.staff.find(row => String(row.id) === targetId), rebind = !!order.reflow_from;
        if (!target || target.staff_status !== "active" || !canActForStaff(state, session, targetId)) throw fail(403, "只能代本人或直属在职客服认领");
        const manuallyAdmitted = !isManaged(order);
        order.assignee_id = String(target.id); order.service_status = "claimed";
        operationLog(state, order, "claim", session, at, manuallyAdmitted ? "已支付订单手动接入客服流程" : "");
        if (rebind) bind(state, order, target.id, "回流单重新承接", actor(session), at);
        if (benefit.ensureLedger) await benefit.ensureLedger(state, order, at);
        return { order_no: order.order_no, status: "claimed", service_status: "claimed", assignee_id: target.id, rebind };
      }
      if (action === "reserve/take" || action === "reserve/giveup") {
        const order = orderBy(state, no), reserve = state.reserves.find(r => r.order_no === order.order_no);
        if (order.service_status !== "reserved" || !reserve || !["holding", "started"].includes(reserve.status)) throw fail(4005, "该单已不在预占中");
        if (!canActForStaff(state, session, reserve.staff_id)) throw fail(4002, "该单在他人预占期内");
        const owner = state.staff.find(row => String(row.id) === String(reserve.staff_id));
        if (!owner || owner.staff_status !== "active") throw fail(4003, "归属客服已暂停或终止，不可接单");
        if (input.expected_status !== "reserved") throw fail(4003, "订单状态已变化，请刷新");
        if (action === "reserve/giveup") { reflow(state, reserve, "giveup", actor(session), at); return present(order); }
        if (millis(at) >= millis(reserve.reserve_expire_at)) throw fail(4004, "预占已超时");
        reserve.status = "taken"; reserve.end_at = at; order.service_status = "claimed"; order.assignee_id = owner.id; order.reserve_staff_id = null;
        bind(state, order, owner.id, "接单续期", actor(session), at); if (benefit.ensureLedger) await benefit.ensureLedger(state, order, at); operationLog(state, order, "reserve_take", session, at); return present(order);
      }
      if (action === "receipt/confirm") {
        const order = orderBy(state, no);
        if (!isManaged(order)) throw fail(4003, "该订单尚未进入客服工作台");
        if (!accessible(state, order, session) || !order.assignee_id) throw fail(403, "无权完成他人订单");
        if (order.category !== "peripheral") throw fail(4003, "仅纯实物订单使用收货完成");
        if (input.received !== true) throw fail(4014, "请确认客户已实际收货");
        const existing = (state.receiptLogs || []).find(row => row.order_no === order.order_no);
        if (order.service_status === "done" && existing) return { ...present(order), idempotent: true, received_at: existing.received_at };
        checkOrder(state, no, input, session, ["claimed", "confirmed", "shooting"]);
        order.service_status = "done"; order.done_at = at;
        state.receiptLogs ||= []; state.receiptLogs.push({ id: nextId(state, "receiptLogs"), order_no: order.order_no, received_at: at, operator: actor(session), created_at: at });
        if (benefit.ensureLedger) await benefit.ensureLedger(state, order, at);
        const binding = bind(state, order, order.assignee_id, "客户收货完成", actor(session), at), ledger = state.ledger.find(row => row.biz_no === order.order_no && row.beneficiary_type === "service" && String(row.party_id) === String(order.assignee_id));
        notification(state, `receipt:${order.order_no}`, "receipt_confirmed", order, order.assignee_id, `订单 ${order.order_no} 已确认客户收货，开始提成观察期`, at);
        return { ...present(order), received_at: at, bound: !!binding, bind_expire_at: binding && binding.expire_at || null, observe_until: add(at, Number(ledger?.observe_days ?? c.staffTiming(state.staff.find(staff => String(staff.id) === String(order.assignee_id)), activeConfig(state, order.paid_at)).observe_days)) };
      }
      if (action === "shoot/finish") {
        const existing = orderBy(state, no);
        if (!accessible(state, existing, session)) throw fail(403, "无权操作他人订单");
        if (FINAL.has(existing.service_status) || workflow.canonicalStage(existing) === workflow.WORKFLOW_STAGES.CANCELLED) throw fail(4003, "当前状态不允许此操作");
        if (["final_pending", "done"].includes(existing.service_status)) return { ...present(existing), idempotent: true };
      }
      const order = checkOrder(state, no, input, session, action === "slot/confirm" ? ["claimed"] : action === "assign" ? ["confirmed"] : action === "slot/reschedule" || action === "transfer" ? ["claimed", "confirmed", "shooting"] : action === "shoot/start" ? ["confirmed"] : action === "shoot/finish" ? ["shooting"] : ["claimed", "confirmed", "shooting", "final_pending", "done"]);
      if (action === "slot/confirm" || action === "slot/reschedule") {
        const newTime = c.futureTime(input.new_time || input.schedule_time, at), from = order.schedule_time || order.requested_time;
        if (input.channel != null) c.requireChannel(input);
        if (newTime === order.schedule_time && action === "slot/reschedule") throw fail(4014, "拍摄时间未发生变化");
        if (action === "slot/reschedule" || from && from !== newTime) state.slotLogs.push({ id: nextId(state, "slotLogs"), order_no: order.order_no, from_time: from || null, to_time: newTime, reason: c.requireReason(input,64), channel: c.requireChannel(input), operator: actor(session), created_at: at });
        order.schedule_time = newTime; if (action === "slot/confirm") order.service_status = "confirmed";
        if (action === "slot/confirm") operationLog(state, order, "slot_confirm", session, at, input.channel ? `沟通渠道：${input.channel}` : "");
        for (const notice of state.notifications) if (notice.event_type === "slot_reminder" && notice.order_no === order.order_no && notice.status === "pending" && notice.event_key !== `reminder:${order.order_no}:${newTime}`) notice.status = "canceled";
        notification(state, `slot:${order.order_no}:${newTime}`, "slot_changed", order, order.photo_id || order.assignee_id, `拍摄时间确认：${newTime}`, at);
      } else if (action === "assign" || action === "transfer") {
        if (order.category === "peripheral") throw fail(4003, "纯实物订单无需派单摄影师，请在客户收货后登记完成");
        const to = text(input.to_photo || input.photo_id), photographer = state.photographers.find(p => String(p.id) === to && p.status === "active");
        if (!photographer) throw fail(4009, "目标摄影师已终止合作或不存在");
        if (order.photo_id === to) throw fail(4014, "请选择不同摄影师");
        if (action === "transfer" && !order.photo_id || action === "assign" && order.photo_id) throw fail(4003, "当前派单状态已变化");
        const previous = order.photo_id;
        state.assignLogs.push({ id: nextId(state, "assignLogs"), order_no: order.order_no, action, from_photo: previous || null, to_photo: to, reason: c.requireReason(input,64), channel: c.requireChannel(input), zero_amount: action === "transfer" ? 1 : 0, operator: actor(session), created_at: at });
        order.photo_id = to; if (action === "transfer" && benefit.transferPhoto) await benefit.transferPhoto(state, order, previous, at);
        else if (benefit.ensureLedger && state.rules.some(r => r.beneficiary_type === "photo")) await benefit.ensureLedger(state, order, at, "photo");
        notification(state, `assign:${order.order_no}:${state.assignLogs.at(-1).id}`, "photographer_assigned", order, to, `订单 ${order.order_no} 已登记派单`, at);
      } else if (action === "shoot/start") { if (order.category === "peripheral") throw fail(4003, "纯实物订单请在客户收货后登记完成"); if (!order.photo_id || !order.schedule_time) throw fail(4003, "请先确认时间并登记摄影师"); order.service_status = "shooting"; order.status = "shooting"; order.workflowStage = workflow.WORKFLOW_STAGES.SHOOTING; order.shootingStartedAt ||= at; operationLog(state, order, "shoot_start", session, at); }
      else if (action === "shoot/finish") {
        if (order.category === "peripheral") throw fail(4003, "纯实物订单请使用收货完成");
        if (!order.photo_id) throw fail(4003, "未登记摄影师，不可完成");
        order.shootingCompletedAt ||= at;
        order.status = "final_pending"; order.workflowStage = workflow.WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT;
        order.service_status = "final_pending";
        operationLog(state, order, "shoot_finish", session, at);
        if (!order.paymentReviewRequired && workflow.hasConfirmedPayment(order, "final")) return completeOrder(state, order, at, actor(session));
        return { ...present(order), bound: false, bind_expire_at: null, observe_until: null };
      } else if (action === "aftersale") return complaintTx(state, input, session, at, order);
      else throw fail(404, "客服工作台接口不存在");
      return present(order);
    }, read ? { path, input, session } : undefined);
  }
  async function runTasks() {
    const at = now();
    const result = await store.transaction(async state => {
      const totals = { started: 0, reflowed: 0, expired: 0, reminded: 0, settleable: 0, alerts: [] };
      for (const reserve of state.reserves) {
        const order = state.orders.find(o => o.order_no === reserve.order_no);
        if (!order || order.service_status !== "reserved") { if (["holding", "started"].includes(reserve.status)) totals.alerts.push({ order_no: reserve.order_no, message: "预占与订单状态不一致，请核验" }); continue; }
        if (["holding", "started"].includes(reserve.status) && millis(reserve.reserve_expire_at) + 30 * 60000 < millis(at)) totals.alerts.push({ order_no: reserve.order_no, message: "预占超过时效30分钟，已自动补跑回流" });
        if (reserve.status === "holding" && millis(reserve.reserve_start_at) <= millis(at)) { reserve.status = "started"; totals.started++; }
        if (["holding", "started"].includes(reserve.status) && order.service_status === "reserved" && millis(reserve.reserve_start_at) <= millis(at) && millis(reserve.reserve_expire_at) <= millis(at)) { if (reflow(state, reserve, "timeout", "system", at)) totals.reflowed++; }
      }
      for (const binding of state.bindings) if (binding.status === "active" && millis(binding.expire_at) <= millis(at)) {
        binding.status = "expired"; binding.updated_at = at; totals.expired++;
        bindingLog(state, { customer_openid: binding.openid, order_no: binding.source_order_no }, binding.staff_id, null, "release", "保护期到期", "system", at);
      }
      for (const order of state.orders) {
        if (!["confirmed", "shooting"].includes(order.service_status) || !order.schedule_time) continue;
        const cfg = activeConfig(state, order.paid_at || at), reminder = millis(order.schedule_time) - Number(cfg.slot_remind_h) * 3600000;
        if (!Number(cfg.slot_remind_h) || reminder > millis(at) + 600000 || reminder < millis(at) - 660000) continue;
        const key = `reminder:${order.order_no}:${order.schedule_time}`;
        if (state.notifications.some(n => n.event_key === key)) continue;
        notification(state, key, "slot_reminder", order, order.assignee_id, `订单 ${order.order_no} 将于 ${order.schedule_time} 拍摄`, at); totals.reminded++;
      }
      for (const ledger of state.ledger) if (ledger.beneficiary_type === "service" && ledger.status === "obs" && ledger.done_at && millis(add(ledger.done_at, Number(ledger.observe_days ?? activeConfig(state, ledger.paid_at).observe_days))) <= millis(at)) {
        const complaint = state.complaints.find(r => r.order_no === ledger.biz_no);
        if (currentResp(complaint) === "unknown") { if (millis(complaint.created_at) + 30 * c.DAY <= millis(at)) totals.alerts.push({ order_no: ledger.biz_no, message: "客诉超过30天待主管判责" }); continue; }
        if (currentResp(complaint) === "service" || state.orders.find(o => o.order_no === ledger.biz_no)?.service_status === "refunded") continue;
        ledger.status = "settleable"; ledger.updated_at = at; totals.settleable++;
      }
      return totals;
    });
    if (options.notifier) await deliverNotifications();
    return result;
  }
  async function deliverNotifications() {
    const at = now(), pending = await store.read(state => state.notifications.filter(n => !String(n.event_type || "").startsWith("photo_") && n.status === "pending" && millis(n.next_attempt_at) <= millis(at)).slice(0, 100));
    for (const notice of pending) {
      let error = null; try { await options.notifier(notice); } catch (e) { error = e; }
      await store.transaction(state => { const row = state.notifications.find(n => n.id === notice.id); if (!row || row.status !== "pending") return; row.attempts = Number(row.attempts) + 1; if (!error) { row.status = "sent"; row.sent_at = at; } else { row.status = row.attempts >= 3 ? "dead" : "pending"; row.failure_note = text(error.message).slice(0, 500); row.next_attempt_at = add(at, [5, 25, 125][Math.min(row.attempts - 1, 2)], 1000); } });
    }
  }
  return { store, execute, onPaid, onCompleted, onRefund, runTasks, deliverNotifications };
}
module.exports = { createSvcWorkbench, actor, staffOf, scopes, accessible, currentResp, bind, reflow, visibleOrder, canActForStaff };
