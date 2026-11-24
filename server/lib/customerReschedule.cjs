"use strict";

const workflow = require("./orderWorkflow.cjs");
const idOf = workflow.idOf;
const ownerOf = order => String(order.openid || order._openid || order.customer_openid || "");
function fail(message, statusCode = 409) { return Object.assign(new Error(message), { code: "ORDER_RESCHEDULE_INVALID", statusCode }); }
function schedule(data, now = new Date()) {
  const appointmentAt = String(data.appointmentAt || "").trim(), timePeriod = String(data.timePeriod || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentAt) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timePeriod)) throw fail("请选择有效的拍摄日期和时间", 400);
  const date = new Date(`${appointmentAt}T${timePeriod}:00+08:00`);
  if (!Number.isFinite(date.getTime())) throw fail("请选择有效的拍摄日期和时间", 400);
  const beijing = new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
  if (beijing !== `${appointmentAt}T${timePeriod}` || date.getTime() <= new Date(now).getTime()) throw fail("申请的拍摄时间必须晚于当前时间", 400);
  return { appointmentAt, timePeriod, scheduleTime: `${appointmentAt} ${timePeriod}:00` };
}
function expected(order, extra = []) {
  return Object.fromEntries([...new Set(["openid", "_openid", "customer_openid", "status", "workflowStage", "businessStatus", "service_status", "photographerId", "photo_id", "assigneeId", "assignee_id", "appointmentAt", "schedule_time", "shootingStartedAt", "shootingCompletedAt", "customerArrivedAt", "completedAt", "done_at", "deleted", "isDeleted", "rescheduleRequest", "rescheduleRecords", "statusLogs", "followRecords", ...extra])].map(key => [key, order[key]]));
}
async function save(source, order, patch) {
  if (typeof source.compareAndUpdate !== "function") throw fail("订单服务暂不可用，请稍后重试", 503);
  return source.compareAndUpdate("orders", idOf(order), expected(order, Object.keys(patch)), patch);
}
function publicRequest(order) {
  const projection = workflow.publicOrderProjection(order);
  return { orderId: idOf(order), rescheduleRequest: projection.rescheduleRequest, canReschedule: projection.canReschedule };
}
async function requestCustomerReschedule(source, openid, data = {}) {
  const orderId = String(data.orderId || "").trim(), key = String(data.idempotencyKey || "").trim();
  const reason = String(data.reason || "").trim();
  if (!openid) throw fail("请先完成微信登录", 401);
  if (!orderId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(key)) throw fail("改期需要订单 ID 和有效请求标识", 400);
  if (reason.length < 2 || reason.length > 500) throw fail("请填写 2 至 500 字的改期原因", 400);
  const desired = schedule(data, new Date(0));
  return workflow.withOrderMutex(`order:${orderId}`, async () => {
    for (let retry = 0; retry < 3; retry++) {
      const order = await source.get("orders", orderId);
      if (!order || order.deleted || order.isDeleted || ownerOf(order) !== openid) throw fail("订单不存在或无权限", 404);
      const previous = order.rescheduleRequest;
      const existing = [previous, ...(order.rescheduleRequestHistory || [])].find(request => request?.idempotencyKey === key);
      if (existing) {
        if (existing.appointmentAt !== desired.appointmentAt || existing.timePeriod !== desired.timePeriod || existing.reason !== reason) throw fail("请求标识已用于其他改期申请");
        return { ...publicRequest({ ...order, rescheduleRequest: existing }), canReschedule: workflow.rescheduleAllowed(order) && previous?.status !== "pending", idempotent: true };
      }
      if (!workflow.rescheduleAllowed(order)) throw fail("当前订单已开始拍摄或已结束，不能申请改期");
      schedule(data);
      if (previous?.status === "pending") throw fail("已有改期申请待后台处理，请勿重复提交");
      const currentTime = String(order.schedule_time || order.appointmentAt || "").replace("T", " ");
      if (currentTime.slice(0, 10) === desired.appointmentAt && (String(order.timePeriod || order.bookingTime || "").slice(0, 5) || currentTime.slice(11, 16)) === desired.timePeriod) throw fail("申请时间与当前拍摄时间相同");
      const at = new Date().toISOString();
      const request = { id: workflow.makePaymentId("reschedule_request"), status: "pending", appointmentAt: desired.appointmentAt,
        timePeriod: desired.timePeriod, reason, requestedAt: at, requestedBy: openid, idempotencyKey: key };
      const log = { id: workflow.makePaymentId("timeline"), type: "客户改期申请", action: "客人申请改期，等待后台审核", reason, createTime: at, operator: "customer", operatorId: openid };
      const patch = { rescheduleRequest: request, rescheduleRequestHistory: [...(order.rescheduleRequestHistory || []), ...(previous ? [previous] : [])],
        statusLogs: [...(order.statusLogs || []), log], followRecords: [...(order.followRecords || []), log], updateTime: at };
      const updated = await save(source, order, patch);
      if (!updated) continue;
      // The immutable application and timeline share the same CAS write. No
      // date is changed here, even when a separate audit sink is unavailable.
      return publicRequest(updated);
    }
    throw fail("订单状态已变化，请刷新后重新申请");
  });
}
async function reviewerAllowed(source, order, session) {
  if (session.role === "super") return true;
  if (session.role !== "service") return false;
  const ids = [String(session.subjectId || "")];
  const assignee = String(order.assignee_id || order.assigneeId || "");
  if (!assignee) return true;
  if (ids.includes(assignee)) return true;
  if (typeof source.transaction === "function") {
    const staffRows = await source.transaction(async conn => {
      const [rows] = await conn.query("SELECT id FROM svc_staff WHERE account_id=? AND staff_status='active'", [session.subjectId]); return rows;
    });
    return staffRows.some(row => String(row.id) === assignee);
  }
  let staffRows = [];
  try { staffRows = await source.list("svcStaff"); }
  catch (error) { if (error.code !== "DATA_KEY_INVALID") throw error; }
  return staffRows.some(row => String(row.account_id) === String(session.subjectId) && row.staff_status === "active" && String(row.id) === assignee);
}
async function reviewCustomerReschedule(source, current, data, session) {
  if (!await reviewerAllowed(source, current, session)) throw fail("无权审核其他客服的改期申请", 403);
  const approved = data.approved;
  const requestId = String(data.requestId || ""), reason = String(data.reason || "").trim();
  if (typeof approved !== "boolean" || !requestId || reason.length < 2 || reason.length > 500) throw fail("请填写审核结论和 2 至 500 字处理说明", 400);
  const request = current.rescheduleRequest;
  if (!request || request.id !== requestId) throw fail("改期申请已变化，请刷新后重试");
  const target = approved ? "approved" : "rejected";
  if (request.status === target) return { order: current, idempotent: true };
  if (request.status !== "pending") throw fail("该改期申请已处理");
  const patch = {}, at = new Date().toISOString();
  if (approved) {
    if (!workflow.rescheduleAllowed(current)) throw fail("订单已开始拍摄或已结束，不能同意改期");
    const desired = schedule(request);
    const photographer = String(current.photographerId || current.photo_id || "");
    if (photographer) {
      const others = await source.list("orders");
      if (others.some(order => idOf(order) !== idOf(current) && String(order.photographerId || order.photo_id || "") === photographer
        && ![workflow.WORKFLOW_STAGES.CANCELLED, workflow.WORKFLOW_STAGES.COMPLETED].includes(workflow.canonicalStage(order))
        && String(order.schedule_time || order.appointmentAt || order.date || "").slice(0, 10) === desired.appointmentAt
        && (String(order.timePeriod || order.bookingTime || "").slice(0, 5) || String(order.schedule_time || order.appointmentAt || "").slice(11, 16)) === desired.timePeriod)) throw fail("摄影师在申请时间已有任务，请协调其他时间后重新申请");
    }
    Object.assign(patch, { appointmentAt: desired.scheduleTime, date: desired.appointmentAt, bookingDate: desired.appointmentAt,
      confirmedDate: desired.appointmentAt, bookingTime: desired.timePeriod, timePeriod: desired.timePeriod, time: desired.timePeriod, confirmedTimePeriod: desired.timePeriod });
    for (const key of ["confirmationSnapshot", "confirmedSnapshot", "serviceSnapshot", "orderSnapshot", "packageSnapshot"]) {
      if (current[key] && typeof current[key] === "object" && !Array.isArray(current[key])) {
        patch[key] = { ...current[key], appointmentAt: desired.scheduleTime, date: desired.appointmentAt, bookingDate: desired.appointmentAt, timePeriod: desired.timePeriod, time: desired.timePeriod };
      }
    }
    // Both the legacy order page and the service workbench consume this row.
    // Do not promote claimed/new orders to confirmed merely by rescheduling.
    if (current.svc_paid_processed || current.service_managed || current.service_status || current.schedule_time) patch.schedule_time = desired.scheduleTime;
    patch.rescheduleRecords = [...(current.rescheduleRecords || []), { id: request.id, previous: { appointmentAt: current.appointmentAt || "", timePeriod: current.timePeriod || "", schedule_time: current.schedule_time || "" },
      next: { appointmentAt: desired.appointmentAt, timePeriod: desired.timePeriod }, reason: request.reason, reviewReason: reason, operatorId: session.subjectId, operator: session.account, createTime: at }];
  }
  patch.rescheduleRequest = { ...request, status: target, reviewReason: reason, reviewedBy: session.subjectId, reviewedAt: at };
  const log = { id: workflow.makePaymentId("timeline"), type: "改期审核", action: approved ? "后台同意改期" : "后台拒绝改期", reason, createTime: at, operatorId: session.subjectId, operator: session.account };
  Object.assign(patch, { statusLogs: [...(current.statusLogs || []), log], followRecords: [...(current.followRecords || []), log], updateTime: at });
  const updated = await save(source, current, patch);
  if (!updated) throw fail("订单状态已变化，请刷新后重新审核");
  return { order: updated, idempotent: false };
}

module.exports = { requestCustomerReschedule, reviewCustomerReschedule, reviewerAllowed, schedule, expected };
