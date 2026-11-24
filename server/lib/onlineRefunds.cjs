"use strict";

// A refund application is not money movement. Only a signed WeChat SUCCESS
// response/query/notification confirms funds and publishes a share reversal.
const crypto = require("crypto");
const { withOrderMutex, hasEffectiveDispatch, WORKFLOW_STAGES } = require("./orderWorkflow.cjs");
const { refundAmountInFen, WechatPayError } = require("./wechatPay.cjs");
const idOf = (value) => String(value && (value.id || value._id) || "");
const nowIso = () => new Date().toISOString();
const attemptsOf = (ticket) => Array.isArray(ticket.refundAttempts) ? ticket.refundAttempts : [];
const successfulFen = (ticket) => attemptsOf(ticket).filter((row) => row.status === "SUCCESS").reduce((sum, row) => sum + row.amountFen, 0);
function reject(message, code = "ONLINE_REFUND_INVALID", statusCode = 409) { throw new WechatPayError(message, { code, statusCode }); }

async function saveTicket(source, ticket, patch) {
  const saved = typeof source.compareAndUpdate === "function"
    ? await source.compareAndUpdate("afterSales", idOf(ticket), { refundAttempts: ticket.refundAttempts, financeStatus: ticket.financeStatus, refundStatus: ticket.refundStatus }, patch)
    : await source.update("afterSales", idOf(ticket), patch);
  if (!saved) reject("退款状态已变化，请刷新后重试", "ONLINE_REFUND_CONCURRENT", 503);
  return saved;
}

async function reservePlan(source, orderId, plan, ticketId) {
  for (let retry = 0; retry < 4; retry += 1) {
    const order = await source.get("orders", orderId);
    const existing = Array.isArray(order.onlineRefundReservations) ? order.onlineRefundReservations : [];
    const merged = [...existing];
    for (const item of plan) {
      if (existing.some((row) => row.refundNo === item.refundNo)) continue;
      const reserved = merged.filter((row) => row.outTradeNo === item.outTradeNo && row.status !== "CLOSED").reduce((sum, row) => sum + row.amountFen, 0);
      if (reserved + item.amountFen > item.totalFen) reject("微信可退余额已被另一申请占用", "ONLINE_REFUND_EXCEEDS_PAID");
      merged.push({ refundNo: item.refundNo, ticketId, outTradeNo: item.outTradeNo, amountFen: item.amountFen, status: "CREATED" });
    }
    const patch = { onlineRefundReservations: merged };
    const saved = typeof source.compareAndUpdate === "function"
      ? await source.compareAndUpdate("orders", orderId, { onlineRefundReservations: order.onlineRefundReservations }, patch)
      : await source.update("orders", orderId, patch);
    if (saved) return;
  }
  reject("退款余额并发占用，请稍后重试", "ONLINE_REFUND_CONCURRENT", 503);
}

function refundPlan(order, ticket, allTickets, options = {}) {
  const requested = options.requestedFen || refundAmountInFen(ticket.refundAmount);
  const phase = String(ticket.refundPhase || "").toLowerCase();
  const payments = (order.paymentRecords || []).filter((row) => row && row.provider === "wechat_pay"
    && ["confirmed", "paid", "success", "已审"].includes(String(row.status).toLowerCase())
    && row.outTradeNo && row.externalTransactionId && (!phase || phase === "all" || row.phase === phase));
  if (new Set(payments.map((row) => row.outTradeNo)).size !== payments.length
    || new Set(payments.map((row) => row.externalTransactionId)).size !== payments.length) reject("支付凭据重复，请先核对原交易", "ONLINE_REFUND_PAYMENT_AMBIGUOUS");
  const used = new Map();
  for (const other of allTickets) {
    if (String(other.orderId) !== idOf(order)) continue;
    if (idOf(other) === idOf(ticket)) {
      if (options.generation) for (const row of attemptsOf(other).filter(row => row.status === "SUCCESS")) used.set(row.outTradeNo, (used.get(row.outTradeNo) || 0) + row.amountFen);
      continue;
    }
    for (const row of attemptsOf(other)) {
      // Unknown/abnormal outcomes remain reserved until a provider query says
      // CLOSED. Never issue a second refund to "fix" an uncertain first one.
      if (row.status !== "CLOSED") used.set(row.outTradeNo, (used.get(row.outTradeNo) || 0) + row.amountFen);
    }
    if (!attemptsOf(other).length && (other.refundConfirmed === true || ["manual_refunded", "refunded", "已退款", "已人工退款"].includes(other.refundStatus)) && Number(other.refundAmount) > 0) {
      // A historical manual refund cannot safely be attributed to one online
      // transaction. Explicit reconciliation is required before more refunds.
      reject("订单存在历史线下退款，需先核对微信可退余额", "ONLINE_REFUND_LEGACY_CONFLICT");
    }
  }
  let remaining = requested;
  const plan = [];
  for (const payment of [...payments].sort((a, b) => String(a.phase === "final" ? 0 : 1).localeCompare(String(b.phase === "final" ? 0 : 1)))) {
    const totalFen = refundAmountInFen(payment.amount);
    const amountFen = Math.min(remaining, Math.max(totalFen - (used.get(payment.outTradeNo) || 0), 0));
    if (!amountFen) continue;
    plan.push({ refundNo: `LXMR${crypto.createHash("sha256").update(`${idOf(ticket)}:${payment.outTradeNo}${options.generation ? `:retry:${options.generation}` : ""}`).digest("hex").slice(0, 40)}`,
      paymentId: idOf(payment), outTradeNo: payment.outTradeNo, transactionId: payment.externalTransactionId,
      amountFen, totalFen, phase: payment.phase, status: "CREATED", createdAt: nowIso() });
    remaining -= amountFen;
    if (!remaining) break;
  }
  if (remaining) reject("退款金额超过已验证的微信支付可退余额", "ONLINE_REFUND_EXCEEDS_PAID");
  return plan;
}

async function publishRefunds(source, ticket, order) {
  let current = ticket;
  for (const row of attemptsOf(current)) {
    if (row.status !== "SUCCESS" || !row.sharePending) continue;
    try {
      await require("./merchantShare.cjs").recordOrderRefund(source, {
        order, refundNo: row.refundNo, amount: (row.amountFen / 100).toFixed(2), refundedAt: row.successTime,
      });
      await require('./customerService.cjs').onRefund(source,order);
      current = await saveTicket(source, current, { refundAttempts: attemptsOf(current).map((value) => value.refundNo === row.refundNo ? { ...value, sharePending: false } : value) });
    } catch (_) {
      // SUCCESS + sharePending is durable and retried by syncRefund/recovery.
    }
  }
  return current;
}

async function applyUnlocked(source, input) {
  const tickets = await source.list("afterSales");
  const matches = tickets.filter((ticket) => attemptsOf(ticket).some((row) => row.refundNo === input.refundNo));
  if (matches.length !== 1) reject("退款单不存在或不唯一", "ONLINE_REFUND_NOT_FOUND", 404);
  let ticket = matches[0];
  const order = await source.get("orders", ticket.orderId);
  if (!order) reject("退款关联订单不存在", "ONLINE_REFUND_ORDER_NOT_FOUND", 404);
  const attempt = attemptsOf(ticket).find((row) => row.refundNo === input.refundNo);
  if (input.outTradeNo !== attempt.outTradeNo || input.transactionId !== attempt.transactionId
    || input.amount !== attempt.amountFen || input.total !== attempt.totalFen || input.currency !== "CNY"
    || !input.refundId || !["SUCCESS", "PROCESSING", "ABNORMAL", "CLOSED"].includes(input.status)
    || (attempt.refundId && input.refundId !== attempt.refundId)
    || (input.status === "SUCCESS" && !Number.isFinite(Date.parse(input.successTime)))) reject("微信退款结果与申请不一致", "ONLINE_REFUND_MISMATCH", 400);
  // A replayed PROCESSING or CLOSED result cannot erase confirmed money.
  if (attempt.status !== "SUCCESS") {
    const attempts = attemptsOf(ticket).map((row) => row.refundNo === input.refundNo ? {
      ...row, status: input.status, refundId: input.refundId, updatedAt: nowIso(),
      ...(input.status === "SUCCESS" ? { successTime: input.successTime, sharePending: true } : {}),
    } : row);
    const automatic = ticket.reviewLane === "customer_self_cancel";
    const done = automatic ? attempts.filter(row => row.status === "SUCCESS").reduce((sum, row) => sum + row.amountFen, 0) >= refundAmountInFen(ticket.refundAmount) : attempts.every((row) => row.status === "SUCCESS");
    const failed = attempts.some((row) => row.status === "ABNORMAL") || attempts.some(row => row.status === "CLOSED") && (!automatic || !attempts.some(row => ["CREATED", "PROCESSING"].includes(row.status)));
    ticket = await saveTicket(source, ticket, {
      refundAttempts: attempts, refundStatus: done ? "refunded" : failed ? "refund_failed" : "processing",
      refundConfirmed: done, refundedAmount: attempts.filter((row) => row.status === "SUCCESS").reduce((sum, row) => sum + row.amountFen, 0) / 100,
      ...(done ? { refundConfirmedAt: input.successTime, refundConfirmedBy: "wechat_pay", refundTransactionId: attempts.map((row) => row.refundId).join(","), status: "已完", customerVisibleStatus: "已退款", completedAt: nowIso() }
        : { status: "处理", customerVisibleStatus: failed ? "退款异常，处理中" : "微信退款处理中" }),
      refundMethod: "微信原路退款", financeStatus: "已审", updatedAt: nowIso(), refundError: "",
    });
  }
  let savedOrder;
  for (let retry = 0; retry < 4; retry += 1) {
    const currentOrder = await source.get("orders", idOf(order));
    // Reload after saving the receipt and guard the aggregate with CAS: two
    // server instances confirming different partial refunds must not lose one.
    const allTickets = await source.list("afterSales");
    const totalRefundedFen = allTickets.filter((value) => String(value.orderId) === idOf(order)).reduce((sum, value) => sum + successfulFen(value), 0);
    const patch = { onlineRefundedAmount: totalRefundedFen / 100, shareRefundPending: true, updateTime: nowIso() };
    if (currentOrder.cancellationSource === "customer_self_cancel") {
      const receivedSinceCancel = totalRefundedFen - Math.round(Number(currentOrder.customerCancellationRefundBaselineOnlineAmount || 0) * 100);
      const expectedRefund = Math.round(Number(currentOrder.customerCancellationRefundAmount || 0) * 100);
      const failed = allTickets.some(value => (currentOrder.customerCancelRefundTicketIds || []).includes(idOf(value)) && value.refundStatus === "refund_failed");
      const refundStatus = receivedSinceCancel >= expectedRefund ? "refunded" : failed ? "refund_failed" : "processing";
      Object.assign(patch, { customerCancellationRefundStatus: refundStatus, refundStatus });
    }
    if (ticket.refundConfirmed && String(currentOrder.afterSaleId || "") === idOf(ticket)) patch.afterSaleStatus = "completed";
    if (ticket.refundConfirmed && ticket.reviewLane === "pre_dispatch" && ticket.refundPhase === "deposit") {
      Object.assign(patch, { status: "cancelled", workflowStage: WORKFLOW_STAGES.CANCELLED, customerStatus: "已取消",
        cancelledAt: currentOrder.cancelledAt || nowIso(), cancellationSource: currentOrder.cancellationSource || "pre_dispatch_deposit_refund", cancelReason: currentOrder.cancelReason || ticket.reason || "定金已原路退款" });
      if (currentOrder.status !== "cancelled") {
        const timeline = { id: `refund_cancel_${idOf(ticket)}`, type: "微信退款", action: "定金原路退款成功，取消订单", from: currentOrder.status, to: "cancelled", operator: "wechat_pay", createTime: nowIso() };
        patch.statusLogs = [...(currentOrder.statusLogs || []), timeline];
        patch.followRecords = [...(currentOrder.followRecords || []), timeline];
      }
    }
    const expected = { onlineRefundedAmount: currentOrder.onlineRefundedAmount, status: currentOrder.status, afterSaleStatus: currentOrder.afterSaleStatus, statusLogs: currentOrder.statusLogs };
    savedOrder = typeof source.compareAndUpdate === "function" ? await source.compareAndUpdate("orders", idOf(order), expected, patch) : await source.update("orders", idOf(order), patch);
    if (savedOrder) break;
  }
  if (!savedOrder) reject("退款已由微信确认，订单汇总待重试更新", "ONLINE_REFUND_CONCURRENT", 503);
  // Reservations remain conservative if a crash occurs before this write;
  // replaying the same provider result safely releases a CLOSED request.
  const latestOrder = await source.get("orders", idOf(order));
  if (Array.isArray(latestOrder.onlineRefundReservations)) {
    const reservations = latestOrder.onlineRefundReservations.map((row) => row.refundNo === input.refundNo ? { ...row, status: attempt.status === "SUCCESS" ? "SUCCESS" : input.status } : row);
    if (typeof source.compareAndUpdate === "function") await source.compareAndUpdate("orders", idOf(order), { onlineRefundReservations: latestOrder.onlineRefundReservations }, { onlineRefundReservations: reservations });
    else await source.update("orders", idOf(order), { onlineRefundReservations: reservations });
  }
  ticket = await publishRefunds(source, ticket, savedOrder);
  const all = await source.list("afterSales");
  if (!all.some((value) => String(value.orderId) === idOf(order) && idOf(value) !== idOf(ticket) && attemptsOf(value).some((row) => row.sharePending))
    && !attemptsOf(ticket).some((row) => row.sharePending)) await source.update("orders", idOf(order), { shareRefundPending: false });
  return ticket;
}

async function applyRefundResult(source, input, options = {}) {
  const tickets = await source.list("afterSales");
  const ticket = tickets.find((value) => attemptsOf(value).some((row) => row.refundNo === input.refundNo));
  if (!ticket) reject("退款单不存在", "ONLINE_REFUND_NOT_FOUND", 404);
  return options.lockHeld ? applyUnlocked(source, input) : withOrderMutex(`order:${ticket.orderId}`, () => applyUnlocked(source, input));
}

async function startUnlocked(source, ticketId, options) {
  const provider = options.wechatPay;
  if (!provider || !provider.isConfigured() || typeof provider.createRefund !== "function" || typeof provider.queryRefund !== "function") reject("微信退款通道暂未配置", "ONLINE_REFUND_UNAVAILABLE", 503);
  let ticket = await source.get("afterSales", ticketId);
  if (!ticket || ticket.isDeleted || ticket.deleted) reject("售后工单不存在", "ONLINE_REFUND_NOT_FOUND", 404);
  if (options.approved !== true && !["已审", "approved", "passed"].includes(String(ticket.financeStatus))) reject("退款需先通过审核", "ONLINE_REFUND_NOT_APPROVED");
  const order = await source.get("orders", ticket.orderId);
  if (!order) reject("关联订单不存在", "ONLINE_REFUND_ORDER_NOT_FOUND", 404);
  if (ticket.reviewLane === "customer_self_cancel"
    && (order.cancellationSource !== "customer_self_cancel" || !["cancelled", "canceled"].includes(order.status)
      || !(order.customerCancelRefundTicketIds || []).includes(ticketId))) reject("取消订单退款尚未就绪", "ONLINE_REFUND_CANCEL_NOT_READY");
  if (order.cancellationSource === "customer_self_cancel" && order.customerCancellationServicePending) {
    try { await require("./customerService.cjs").onCancelled(source, order); await source.update("orders", idOf(order), { customerCancellationServicePending: false }); }
    catch (_) { /* Refund processing does not depend on the secondary service projection. */ }
  }
  // A verified CLOSED receipt proves no funds moved for that attempt. Only
  // automatic customer cancellation creates a fresh request for the remainder;
  // unknown and ABNORMAL outcomes retain their original number for queries.
  const attempts = attemptsOf(ticket);
  if (ticket.reviewLane === "customer_self_cancel" && attempts.some(row => row.status === "CLOSED")
    && !attempts.some(row => !["SUCCESS", "CLOSED"].includes(row.status)) && successfulFen(ticket) < refundAmountInFen(ticket.refundAmount)) {
    const plan = refundPlan(order, ticket, await source.list("afterSales"), { requestedFen: refundAmountInFen(ticket.refundAmount) - successfulFen(ticket), generation: attempts.filter(row => row.status === "CLOSED").length });
    await reservePlan(source, idOf(order), plan, ticketId);
    ticket = await saveTicket(source, ticket, { refundAttempts: [...attempts, ...plan], refundStatus: "processing", status: "处理", customerVisibleStatus: "自动重试微信退款", updatedAt: nowIso() });
  }
  if (!attemptsOf(ticket).length) {
    if (ticket.reviewLane === "pre_dispatch" && hasEffectiveDispatch(order)) reject("摄影师已安排，不能执行安排前定金退款", "ONLINE_REFUND_DISPATCHED");
    const plan = refundPlan(order, ticket, await source.list("afterSales"));
    await reservePlan(source, idOf(order), plan, ticketId);
    ticket = await saveTicket(source, ticket, { refundAttempts: plan, financeStatus: "已审", financeReviewer: options.operatorId || "", refundStatus: "processing", refundConfirmed: false, status: "处理", customerVisibleStatus: "微信退款处理中", updatedAt: nowIso() });
  }
  for (const row of attemptsOf(ticket)) {
    if (row.status === "SUCCESS") {
      // A process may have died after saving the verified receipt but before
      // cancelling the order/updating its aggregate or publishing reversal.
      ticket = await applyUnlocked(source, { refundNo: row.refundNo, refundId: row.refundId, outTradeNo: row.outTradeNo,
        transactionId: row.transactionId, amount: row.amountFen, total: row.totalFen, currency: "CNY", status: "SUCCESS", successTime: row.successTime });
      continue;
    }
    if (row.status === "CLOSED") continue;
    let result;
    try {
      // Query first even for CREATED: a prior submission can have succeeded
      // remotely before the server crashed or lost the HTTPS response.
      try { result = await provider.queryRefund(row.refundNo); }
      catch (error) { if (error.code !== "WECHAT_PAY_REFUND_NOT_FOUND") throw error; }
      if (!result) result = await provider.createRefund({ payment: order.paymentRecords.find((value) => value.outTradeNo === row.outTradeNo), refundNo: row.refundNo, amount: (row.amountFen / 100).toFixed(2), reason: ticket.reason || "售后退款" });
      ticket = await applyUnlocked(source, result);
    } catch (error) {
      // Retain the immutable request number/amount for later query and retry.
      ticket = await source.get("afterSales", ticketId);
      await source.update("afterSales", ticketId, { refundError: String(error.code || "WECHAT_PAY_REFUND_PENDING"), updatedAt: nowIso(), customerVisibleStatus: "退款结果确认中" });
      throw error;
    }
  }
  return publishRefunds(source, await source.get("afterSales", ticketId), await source.get("orders", ticket.orderId));
}

async function startRefund(source, ticketId, options = {}) {
  const ticket = await source.get("afterSales", ticketId);
  if (!ticket) reject("售后工单不存在", "ONLINE_REFUND_NOT_FOUND", 404);
  return options.lockHeld ? startUnlocked(source, ticketId, options) : withOrderMutex(`order:${ticket.orderId}`, () => startUnlocked(source, ticketId, options));
}

async function reconcilePendingRefunds(source, options = {}) {
  if (!options.wechatPay || !options.wechatPay.isConfigured()) return { processed: 0, failed: 0, disabled: true };
  const candidates = (await source.list("afterSales")).filter((ticket) => attemptsOf(ticket).some((row) =>
    ["CREATED", "PROCESSING", "ABNORMAL"].includes(row.status) || (row.status === "SUCCESS" && row.sharePending))
    || ticket.reviewLane === "customer_self_cancel" && ticket.financeStatus === "已审"
      && (ticket.refundStatus === "processing" && !attemptsOf(ticket).length || ticket.refundStatus === "refund_failed" && attemptsOf(ticket).some(row => row.status === "CLOSED")))
    .sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")))
    .slice(0, Math.max(1, Math.min(Number(options.limit) || 50, 200)));
  const summary = { processed: 0, failed: 0 };
  for (const ticket of candidates) {
    try { await startRefund(source, idOf(ticket), options); summary.processed += 1; }
    catch (_) { summary.failed += 1; }
  }
  return summary;
}

module.exports = { startRefund, syncRefund: startRefund, reconcilePendingRefunds, applyRefundResult, successfulFen };
