"use strict";

// Only the new desk consumes these projections. Existing workbench summaries,
// lists and all mutation guards keep their original behavior.
const c = require("./svcCore.cjs");
const workflow = require("./orderWorkflow.cjs");
const MANAGERS = new Set(["super", "admin", "administrator"]);
const SUPERVISORS = new Set(["supervisor", "service_supervisor"]);
const ACTIVE = new Set(["claimed", "confirmed", "shooting", "final_pending"]);
const OCCUPIED = new Set(["confirmed", "shooting", "final_pending"]);
// Existing API and UI use several historical completion aliases. None of
// these completed records belongs in the new unfinished-work queue.
const TERMINAL_TICKETS = new Set(["completed", "closed", "done", "已完", "已完成", "已结案", "已结束", "已关闭", "已完结", "完成"]);
const SERVICE_STATUSES = new Set(["new", "reserved", ...ACTIVE, "done", "refunded", "canceled"]);
const GENERAL_PATH = "/api/kf/workbench/general";
const QUEUE_PATH = GENERAL_PATH + "/queues";
const OCCUPANCY = /^\/api\/kf\/photographers\/([^/]+)\/occupancy$/;

function isGeneralPath(path) { return path === GENERAL_PATH || path === QUEUE_PATH || OCCUPANCY.test(path); }
function validateInput(path, input) {
  if (path === GENERAL_PATH) {
    if (!["", "pool", "mine", "pending", "today"].includes(c.text(input.card)) || !["all", "pool", "mine", "reserved"].includes(c.text(input.tab) || "all") || input.status && !SERVICE_STATUSES.has(c.text(input.status))) throw c.fail(4014, "总工作台筛选参数无效");
  }
  if (path === QUEUE_PATH && !["reschedule", "complaints"].includes(c.text(input.queue))) throw c.fail(4014, "总工作台队列参数无效");
  if (OCCUPANCY.test(path)) occupancyWindow(input);
}
function activeOrder(order) { return order && !order.deleted && !order.isDeleted && order.orderType !== "physical" && order.order_type !== "physical" && order.transactionType !== "physical"; }
function dayOf(value) { return Number.isFinite(c.millis(value)) ? c.stamp(value).slice(0, 10) : ""; }
function scopeName(session) { return MANAGERS.has(session.role) ? "管理员授权范围" : SUPERVISORS.has(session.role) ? "本人及直属客服授权范围" : session.role === "finance" ? "财务授权范围" : "本人及可认领公共池"; }
function assertRole(session) { if (![...MANAGERS, ...SUPERVISORS, "service", "finance"].includes(session.role)) throw c.fail(403, "无总工作台访问权限"); }
function queues(context) {
  const { state, session, me, allowed, present } = context;
  const orders = state.orders.filter(activeOrder);
  const review = ["super", "service"].includes(session.role);
  const handleAftersales = MANAGERS.has(session.role) || ["service", "finance"].includes(session.role);
  const identity = new Set([String(me?.staff_status === "active" ? me.id : ""), String(session.subjectId || session.authzUserId || session.accountId || "")].filter(Boolean));
  const reschedule = review ? orders.filter(order => order.rescheduleRequest?.status === "pending" && (session.role === "super" || !order.assignee_id || identity.has(String(order.assignee_id))))
    .sort((a, b) => String(a.rescheduleRequest.requestedAt || "").localeCompare(String(b.rescheduleRequest.requestedAt || "")) || String(a.order_no).localeCompare(String(b.order_no))) : [];
  const byId = new Map(orders.filter(order => allowed(order)).map(order => [String(order.id), order]));
  const byNo = new Map(orders.filter(order => allowed(order)).map(order => [String(order.order_no), order]));
  const complaints = handleAftersales ? (state.afterSales || []).filter(ticket => ticket && !ticket.deleted && !ticket.isDeleted && !workflow.isAutomaticOrderRefund(ticket)
    && !TERMINAL_TICKETS.has(c.text(ticket.status).toLowerCase()) && (byId.has(String(ticket.orderId)) || byNo.has(String(ticket.order_no || ticket.orderNo))))
    .sort((a, b) => (c.millis(b.createdAt || b.createTime) || 0) - (c.millis(a.createdAt || a.createTime) || 0) || String(b.id).localeCompare(String(a.id))) : [];
  return { review, handleAftersales, reschedule, complaints,
    presentReschedule: order => ({ ...present(order), canReviewReschedule: true }),
    presentComplaint: ticket => ({ ...ticket, order: present(byId.get(String(ticket.orderId)) || byNo.get(String(ticket.order_no || ticket.orderNo))) }) };
}
function general(context) {
  const { state, input, session, at, me, all, own, pool, filterOrders, present, reserveSeconds } = context;
  assertRole(session);
  const base = { keyword: input.keyword, type: input.type || input.category, photo: input.photo };
  const available = filterOrders(all.filter(activeOrder), base);
  const authorised = filterOrders(own.filter(activeOrder), base);
  const views = {
    pool: filterOrders(pool.filter(activeOrder), base),
    mine: authorised.filter(order => me && String(order.assignee_id) === String(me.id) && ACTIVE.has(order.service_status)),
    pending: authorised.filter(order => order.service_status === "claimed"),
    today: authorised.filter(order => ["confirmed", "shooting"].includes(order.service_status) && dayOf(order.schedule_time) === at.slice(0, 10))
  };
  const queue = queues(context);
  let rows;
  const card = c.text(input.card), tab = c.text(input.tab) || "all";
  if (card) rows = views[card];
  else if (tab === "pool") rows = views.pool;
  else if (tab === "mine") rows = views.mine;
  else if (tab === "reserved") rows = authorised.filter(order => order.service_status === "reserved");
  else rows = available;
  // A selected card owns its state predicate. A stale status query cannot
  // silently reduce the rows beneath a card's full snapshot count.
  if (!card && input.status) rows = rows.filter(order => order.service_status === c.text(input.status));
  const ordered = [...rows];
  if (card === "today") ordered.sort((a, b) => c.millis(a.schedule_time) - c.millis(b.schedule_time) || String(a.order_no).localeCompare(String(b.order_no)));
  else if (tab === "reserved" && !card) ordered.sort((a, b) => (reserveSeconds(a) ?? Infinity) - (reserveSeconds(b) ?? Infinity) || String(a.order_no).localeCompare(String(b.order_no)));
  else ordered.sort((a, b) => Number(dayOf(b.schedule_time) === at.slice(0, 10) && ["confirmed", "shooting"].includes(b.service_status)) - Number(dayOf(a.schedule_time) === at.slice(0, 10) && ["confirmed", "shooting"].includes(a.service_status))
    || (c.millis(b.created_at || b.createdAt || b.paid_at) || 0) - (c.millis(a.created_at || a.createdAt || a.paid_at) || 0) || String(b.order_no).localeCompare(String(a.order_no)));
  const result = c.paginate(ordered, input);
  const reservations = own.filter(order => activeOrder(order) && order.service_status === "reserved")
    .sort((a, b) => (reserveSeconds(a) ?? Infinity) - (reserveSeconds(b) ?? Infinity) || String(a.order_no).localeCompare(String(b.order_no)));
  const reserved = c.paginate(reservations, { page: input.reserved_page || 1, size: input.reserved_size || 20 });
  return { ...result, list: result.list.map(present),
    cards: { pool: views.pool.length, mine: views.mine.length, pending: views.pending.length, today: views.today.length,
      reschedule: queue.review ? queue.reschedule.length : null, complaints: queue.handleAftersales ? queue.complaints.length : null },
    reserved: { ...reserved, list: reserved.list.map(present) }, server_time: at, data_scope: scopeName(session),
    capabilities: { review_reschedule: queue.review, handle_aftersales: queue.handleAftersales } };
}
function queueResult(context) {
  assertRole(context.session);
  const data = queues(context), which = c.text(context.input.queue), reschedule = which === "reschedule";
  if (reschedule ? !data.review : !data.handleAftersales) throw c.fail(403, reschedule ? "无改期审核权限" : "无售后处理权限");
  const result = c.paginate(reschedule ? data.reschedule : data.complaints, context.input);
  return { ...result, list: result.list.map(reschedule ? data.presentReschedule : data.presentComplaint), queue: which, server_time: context.at, data_scope: scopeName(context.session) };
}
function occupancyWindow(input) {
  const from = c.text(input.from), days = input.days == null || input.days === "" ? 14 : Number(input.days);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(from) ? c.millis(from + " 00:00:00") : NaN;
  if (!Number.isFinite(start) || c.stamp(start).slice(0, 10) !== from || !Number.isInteger(days) || days < 1 || days > 14) throw c.fail(4014, "档期查询须提供有效日期及1至14天窗口");
  return { from, days, start, end: start + days * 86400000 };
}
function occupancy(context) {
  const { state, path, input, session, allowed } = context;
  assertRole(session);
  let photoId;
  try { photoId = decodeURIComponent(OCCUPANCY.exec(path)[1]); } catch (_) { throw c.fail(4014, "摄影师标识无效"); }
  const photographer = state.photographers.find(photo => String(photo.id) === photoId && photo.status === "active");
  if (!photographer) throw c.fail(404, "摄影师不存在或已离职");
  const window = occupancyWindow(input);
  const items = state.orders.filter(order => activeOrder(order) && allowed(order) && String(order.photo_id) === photoId && OCCUPIED.has(order.service_status)
    && c.millis(order.schedule_time) >= window.start && c.millis(order.schedule_time) < window.end)
    .sort((a, b) => c.millis(a.schedule_time) - c.millis(b.schedule_time) || String(a.order_no).localeCompare(String(b.order_no)))
    .map(order => ({ order_no: order.order_no, appointment_at: c.stamp(order.schedule_time), service_status: order.service_status, duration_hours: null }));
  return { photo_id: photographer.id, from: window.from, days: window.days, items, scope_limited: true, data_scope: scopeName(session) };
}
function execute(context) { return context.path === GENERAL_PATH ? general(context) : context.path === QUEUE_PATH ? queueResult(context) : occupancy(context); }
module.exports = { isGeneralPath, validateInput, execute, GENERAL_PATH, QUEUE_PATH, OCCUPANCY };
