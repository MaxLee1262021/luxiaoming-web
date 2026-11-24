"use strict";

const crypto = require("crypto");
const workflow = require("./orderWorkflow.cjs");
const { startRefund } = require("./onlineRefunds.cjs");
const idOf = value => String(value && (value.id || value._id) || "");
const ownerOf = order => String(order.openid || order._openid || order.customer_openid || "");
const attemptsOf = ticket => Array.isArray(ticket.refundAttempts) ? ticket.refundAttempts : [];
const terminalTicket = ticket => ["completed", "closed", "done", "已完", "已完成", "已结案", "已结束"].includes(String(ticket.status || "").trim().toLowerCase());
const cents = value => Math.round(workflow.roundMoney(value) * 100);
const money = value => value / 100;
function fail(message) { return { success: false, error: message }; }
function expectedOrder(order) {
  return Object.fromEntries(["openid", "_openid", "customer_openid", "deleted", "isDeleted", "status", "workflowStage", "businessStatus", "service_status", "schedule_time", "photographerId", "photo_id", "dispatchRecord", "dispatchRecords", "dispatchHistory", "dispatchStatus", "depositRefundable", "paymentReviewRequired", "afterSaleStatus", "afterSaleId", "customerArrivedAt", "shootingStartedAt", "shootingCompletedAt", "paymentRecords", "depositPaid", "depositFinanceStatus", "finalPaid", "finalFinanceStatus", "statusLogs", "followRecords", "customerCancelIdempotencyKey", "rescheduleRequest"].map(key => [key, order[key]]));
}
async function saveOrder(source, order, patch) {
  return typeof source.compareAndUpdate === "function"
    ? source.compareAndUpdate("orders", idOf(order), expectedOrder(order), patch)
    : source.update("orders", idOf(order), patch);
}
function paidCents(order) {
  return ["deposit", "final"].reduce((total, phase) => {
    const confirmed = (order.paymentRecords || []).filter(row => row && row.phase === phase && workflow.normalizePaymentStatus(row.status) === "confirmed");
    const records = confirmed.reduce((sum, row) => sum + cents(row.amount), 0);
    const field = workflow.normalizePaymentStatus(order[`${phase}FinanceStatus`] || order[`${phase}PaymentStatus`]) === "confirmed" ? cents(order[`${phase}Paid`]) : 0;
    return total + Math.max(records, field);
  }, 0);
}
function refundFacts(tickets) {
  let successful = 0, online = 0, reserved = 0;
  const activeIds = [];
  for (const ticket of tickets) {
    const attempts = attemptsOf(ticket);
    if (attempts.length) {
      const received = attempts.filter(row => row.status === "SUCCESS").reduce((sum, row) => sum + Number(row.amountFen || 0), 0);
      successful += received; online += received;
      const pending = attempts.filter(row => !["SUCCESS", "CLOSED"].includes(row.status));
      reserved += pending.reduce((sum, row) => sum + Number(row.amountFen || 0), 0);
      if (pending.length || attempts.some(row => row.sharePending)) activeIds.push(idOf(ticket));
    } else if (ticket.refundConfirmed === true || ["manual_refunded", "refunded", "已退款", "已人工退款"].includes(ticket.refundStatus)) successful += cents(ticket.refundAmount);
  }
  return { successful, online, reserved, activeIds };
}
function resultFor(order, extra = {}) {
  const refundStatus = order.customerCancellationRefundStatus || "not_required";
  return { success: true, data: { orderId: idOf(order), status: "cancelled", workflowStage: workflow.WORKFLOW_STAGES.CANCELLED,
    refundStatus, refundAmount: Number(order.customerCancellationRefundAmount || 0), refundTicketId: order.customerCancelRefundTicketId || "",
    refundPending: !["not_required", "refunded"].includes(refundStatus), ...extra } };
}

// A confirmed close stops a late payment. If payment won the race, return its
// verified receipt to the caller so confirmTransaction can take its own lock.
async function closeLivePayments(source, order, provider) {
  const pending = (order.paymentRecords || []).filter(row => row && workflow.normalizePaymentStatus(row.status) === "pending"
    && (row.provider || row.idempotencyKey || row.externalTransactionId));
  if (!pending.length) return { order };
  if (!provider?.isConfigured() || typeof provider.queryTransaction !== "function" || typeof provider.closeTransaction !== "function") return { error: "支付结果确认中，请稍后重试取消" };
  let current = order;
  for (const payment of pending) {
    if (payment.provider !== "wechat_pay" || !payment.outTradeNo) return { error: "支付凭据待核验，请联系客服取消" };
    let transaction;
    try {
      transaction = await provider.queryTransaction(payment.outTradeNo);
      if (transaction.tradeState === "SUCCESS") return { transaction };
      if (!["CLOSED", "PAYERROR", "REVOKED"].includes(transaction.tradeState)) {
        try { await provider.closeTransaction(payment.outTradeNo); }
        catch (_) {
          transaction = await provider.queryTransaction(payment.outTradeNo);
          if (transaction.tradeState === "SUCCESS") return { transaction };
          if (!["CLOSED", "PAYERROR", "REVOKED"].includes(transaction.tradeState)) return { error: "支付结果确认中，请稍后重试取消" };
        }
      }
    } catch (_) { return { error: "支付结果确认中，请稍后重试取消" }; }
    const now = new Date().toISOString();
    const saved = await saveOrder(source, current, { paymentRecords: (current.paymentRecords || []).map(row => row.outTradeNo === payment.outTradeNo
      ? { ...row, status: "failed", tradeState: "CLOSED", cancelledAt: now, updatedAt: now } : row), updateTime: now });
    if (!saved) return { retry: true };
    current = saved;
  }
  return { order: current };
}

async function continueRefunds(source, order, ctx) {
  for (const ticketId of order.customerCancelRefundTicketIds || []) {
    try { await startRefund(source, ticketId, { wechatPay: ctx.wechatPay, approved: true, operatorId: "customer_self_cancel", lockHeld: true }); }
    catch (error) {
      const receiptInvalid = ["ONLINE_REFUND_EXCEEDS_PAID", "ONLINE_REFUND_LEGACY_CONFLICT", "ONLINE_REFUND_PAYMENT_AMBIGUOUS"].includes(error.code);
      await source.update("afterSales", ticketId, { refundError: String(error.code || "WECHAT_PAY_REFUND_PENDING"), updatedAt: new Date().toISOString(),
        ...(receiptInvalid ? { refundStatus: "refund_failed", customerVisibleStatus: "退款凭据待核验，请联系客服" } : { customerVisibleStatus: "自动退款处理中" }) });
    }
  }
  let current = await source.get("orders", idOf(order));
  const tickets = (await source.list("afterSales")).filter(ticket => String(ticket.orderId) === idOf(order));
  const facts = refundFacts(tickets);
  const received = Math.max(0, facts.online - cents(current.customerCancellationRefundBaselineOnlineAmount));
  const target = cents(current.customerCancellationRefundAmount);
  const failed = tickets.some(ticket => (current.customerCancelRefundTicketIds || []).includes(idOf(ticket)) && ticket.refundStatus === "refund_failed");
  const status = target <= 0 ? (paidCents(current) > 0 ? "refunded" : "not_required") : received >= target ? "refunded" : failed ? "refund_failed" : "processing";
  current = await source.update("orders", idOf(order), { customerCancellationRefundStatus: status, refundStatus: status });
  return current;
}

async function cancelUnlocked(source, openid, data, ctx) {
  let order = await source.get("orders", data.orderId);
  if (!order || order.deleted || order.isDeleted || ownerOf(order) !== openid) return fail("订单不存在或无权限");
  if (workflow.canonicalStage(order) === workflow.WORKFLOW_STAGES.CANCELLED) {
    if (order.cancellationSource !== "customer_self_cancel" && order.customerCancelIdempotencyKey !== data.idempotencyKey) return fail("订单已取消");
    return resultFor(await continueRefunds(source, order, ctx), { idempotent: true });
  }
  if (ctx.refundOnly) {
    const tickets = await source.list("afterSales");
    if (!workflow.canApplyRefund(order, tickets)) return fail("当前订单不能申请自动退款，请刷新订单或联系客服");
  }
  const eligibility = workflow.customerCancellation(order);
  if (!eligibility.canCancel) return fail(eligibility.reason || "当前订单不支持自助取消");
  const closed = await closeLivePayments(source, order, ctx.wechatPay);
  if (closed.error) return fail(closed.error);
  if (closed.transaction || closed.retry) return closed;
  order = closed.order;
  // Closing/querying may take time. The final CAS includes assignment, shooting
  // and payment facts so another process cannot schedule this stale snapshot.
  const all = await source.list("afterSales");
  const tickets = all.filter(ticket => String(ticket.orderId) === data.orderId);
  if (ctx.refundOnly && !workflow.canApplyRefund(order, tickets)) return fail("订单已有售后或状态变化，请刷新订单或联系客服");
  const facts = refundFacts(tickets), paid = paidCents(order);
  const amount = Math.max(0, paid - facts.successful), unreserved = Math.max(0, amount - facts.reserved);
  const now = new Date().toISOString();
  const ticketId = `cancel_${crypto.createHash("sha256").update(data.orderId).digest("hex").slice(0, 40)}`;
  // Audit precedes durable cancellation and all provider requests. A recorded
  // attempt remains truthful if a concurrent assignment wins the final CAS.
  await source.create("logs", { id: workflow.makePaymentId("audit"), action: "客户申请取消订单并自动退款", operator: "customer", operatorId: openid,
    targetType: "order", targetId: data.orderId, detail: data.reason, auditEvent: "customer_cancel_request", immutable: true, createTime: now });
  let createdTicket = false;
  if (unreserved > 0) {
    const existing = await source.get("afterSales", ticketId);
    if (existing && (String(existing.orderId) !== data.orderId || cents(existing.refundAmount) !== unreserved)) return fail("退款记录待核验，请稍后重试");
    if (!existing) { await source.create("afterSales", { id: ticketId, _id: ticketId, orderId: data.orderId, orderNo: order.orderNo || "", type: "取消订单自动退款",
      reviewLane: "customer_self_cancel", refundPhase: "all", refundAmount: money(unreserved), financeStatus: "已审", financeReviewer: "customer_self_cancel",
      refundStatus: "processing", refundConfirmed: false, status: "处理", customerVisibleStatus: "自动退款处理中", reason: data.reason,
      submitSource: "customer_self_cancel", openid, automaticApproval: true, approvedAt: now, createdAt: now, updatedAt: now }); createdTicket = true; }
  }
  const ids = [...new Set([...facts.activeIds, ...(unreserved > 0 ? [ticketId] : [])])];
  const event = { id: workflow.makePaymentId("timeline"), type: "客户取消", action: "客户自助取消订单", from: order.status || "new", to: "cancelled", operator: "customer", operatorId: openid, reason: data.reason, createTime: now };
  const status = amount > 0 ? "processing" : paid > 0 ? "refunded" : "not_required";
  const supersededTickets = tickets.filter(ticket => idOf(ticket) !== ticketId && !terminalTicket(ticket) && cents(ticket.refundAmount) > 0 && !attemptsOf(ticket).length);
  const patch = { status: "cancelled", workflowStage: workflow.WORKFLOW_STAGES.CANCELLED, businessStatus: "cancelled", businessStatusText: "已取消", customerStatus: "已取消",
    service_status: "canceled", customerCancelIdempotencyKey: data.idempotencyKey, cancellationSource: "customer_self_cancel", cancelReason: data.reason,
    cancelledAt: now, cancelledBy: openid, updateTime: now, svcPaymentPending: false, reserve_staff_id: null, customerCancellationServicePending: true,
    customerCancellationRefundStatus: status, refundStatus: status, customerCancellationRefundAmount: money(amount), customerCancellationRefundBaselineOnlineAmount: money(facts.online),
    customerCancelRefundTicketId: ids[0] || "", customerCancelRefundTicketIds: ids,
    ...(supersededTickets.some(ticket => idOf(ticket) === String(order.afterSaleId || "")) ? { afterSaleStatus: "closed" } : {}),
    statusLogs: [...(order.statusLogs || []), event], followRecords: [...(order.followRecords || []), event],
    ...(order.rescheduleRequest?.status === "pending" ? { rescheduleRequest: { ...order.rescheduleRequest, status: "cancelled", reviewedAt: now, reviewReason: "订单已取消" } } : {}) };
  let saved = await saveOrder(source, order, patch);
  if (!saved) {
    const latest = await source.get("orders", data.orderId);
    if (createdTicket && !(latest?.customerCancelRefundTicketIds || []).includes(ticketId)) await source.remove("afterSales", ticketId);
    return { retry: true };
  }
  // Supersede unexecuted refund applications. Provider reservations already in
  // flight remain intact and are included in this cancellation's refund total.
  for (const ticket of supersededTickets) {
    await source.update("afterSales", idOf(ticket), { status: "closed", financeStatus: "已驳", refundStatus: "superseded", customerVisibleStatus: "已转为取消订单自动退款", supersededBy: unreserved > 0 ? ticketId : null, updatedAt: now });
  }
  try {
    await require("./customerService.cjs").onCancelled(source, saved);
    saved = await source.update("orders", data.orderId, { customerCancellationServicePending: false });
  } catch (_) { /* Refund retries and service reservation tasks repair this projection. */ }
  return resultFor(await continueRefunds(source, saved, ctx));
}

async function cancelCustomerOrder(source, openid, input = {}, ctx = {}) {
  const data = { orderId: String(input.orderId || "").trim(), idempotencyKey: String(input.idempotencyKey || input.requestId || "").trim(), reason: String(input.reason || input.note || "").trim() };
  if (!openid) return fail("请先完成微信登录");
  if (!data.orderId || !data.idempotencyKey) return fail("取消订单需要订单 ID 和请求标识");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(data.idempotencyKey)) return fail("取消请求标识无效");
  if (data.reason.length < 2 || data.reason.length > 500) return fail("请填写 2 至 500 个字的取消原因");
  try {
    for (let retry = 0; retry < 4; retry++) {
      const result = await workflow.withOrderMutex(`order:${data.orderId}`, () => cancelUnlocked(source, openid, data, ctx));
      if (result.transaction) {
        if (typeof ctx.wechatPay?.confirmTransaction !== "function") return fail("支付结果确认中，请稍后重试取消");
        await ctx.wechatPay.confirmTransaction(source, result.transaction);
        continue;
      }
      if (result.retry) continue;
      return result;
    }
    return fail("订单状态已变化，请刷新后重试");
  } catch (_) { return fail("取消订单暂未完成，请稍后重试"); }
}

module.exports = { cancelCustomerOrder,
  requestOrderRefund: (source, openid, input, ctx = {}) => cancelCustomerOrder(source, openid, input, { ...ctx, refundOnly: true }) };
