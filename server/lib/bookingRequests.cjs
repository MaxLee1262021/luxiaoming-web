"use strict";

// A checkout is deliberately separate from a fulfillment order. Payment code
// can operate on the same document shape without exposing unpaid checkouts to
// order lists, dispatch, finance totals or customer order history.
const crypto = require("crypto");
const { hasConfirmedPayment, depositDue, withOrderMutex } = require("./orderWorkflow.cjs");
const itemId = (row) => String(row && (row.id || row._id) || "");

function bookingPaymentSource(source) {
  if (source.bookingRequestSource) return source;
  const adapter = Object.create(source);
  Object.defineProperty(adapter, "bookingRequestSource", { value: source });
  for (const method of ["list", "get", "create", "update", "compareAndUpdate", "replace", "remove", "upsert"]) {
    if (typeof source[method] === "function") adapter[method] = (key, ...args) => source[method](key === "orders" ? "bookingRequests" : key, ...args);
  }
  adapter.findOrderByPaymentOutTradeNo = async (outTradeNo) => {
    if (typeof source.findBookingByPaymentOutTradeNo === "function") return source.findBookingByPaymentOutTradeNo(outTradeNo);
    const rows = await source.list("bookingRequests");
    const matches = (rows || []).filter((row) => (row.paymentRecords || []).some((payment) => payment.outTradeNo === outTradeNo));
    if (matches.length > 1) throw new Error("支付记录存在冲突，请联系客服");
    return matches[0] || null;
  };
  return adapter;
}

function orderIdForBooking(bookingId) {
  return `order_${crypto.createHash("sha256").update(String(bookingId)).digest("hex").slice(0, 40)}`;
}

async function finalizePaidBooking(source, bookingId) {
  const base = source.bookingRequestSource || source;
  return withOrderMutex(`booking:finalize:${bookingId}`, async () => {
    const booking = await base.get("bookingRequests", bookingId);
    if (!booking || booking.isDeleted || booking.deleted || !hasConfirmedPayment(booking, "deposit")) return null;
    const orderId = orderIdForBooking(bookingId);
    let order = await base.get("orders", orderId);
    if (!order) {
      const now = new Date().toISOString();
      const document = {
        ...booking, id: orderId, _id: orderId, bookingId,
        bookingStatus: "confirmed", status: "deposit_paid", workflowStage: "awaiting_dispatch",
        businessStatus: "reserved", customerStatus: "已预约", businessStatusText: "已预约",
        publicStatus: "reserved", publicStatusText: "已预约", confirmedAt: now,
        createTime: now, createdAt: now, updateTime: now,
        statusLogs: [...(booking.statusLogs || []), { type: "客户预约", action: "定金支付完成，预约成功", operator: "系统", createTime: now }],
      };
      delete document.confirmedOrderId;
      try { order = await base.create("orders", document); }
      catch (error) {
        // Deterministic primary key is the cross-process idempotency barrier.
        if (!["DUPLICATE_RECORD", "ER_DUP_ENTRY"].includes(error && error.code)) throw error;
        order = await base.get("orders", orderId);
        if (!order || order.bookingId !== bookingId) throw error;
      }
    }
    if (String(booking.openid || booking._openid || "") !== String(order.openid || order._openid || "") || !hasConfirmedPayment(order, "deposit")) throw new Error("预约确认记录不一致");
    if (booking.bookingStatus !== "confirmed" || booking.confirmedOrderId !== orderId) {
      await base.update("bookingRequests", bookingId, { bookingStatus: "confirmed", confirmedOrderId: orderId, confirmedAt: order.confirmedAt || new Date().toISOString() });
    }
    return order;
  });
}

function bookingResult(booking, order, projection) {
  const status = order ? "confirmed" : ["cancelled", "cancelling"].includes(booking.bookingStatus) ? booking.bookingStatus : "pending_payment";
  return {
    bookingId: itemId(booking), bookingStatus: status,
    paymentRequired: status === "pending_payment" && depositDue(booking) > 0,
    depositDue: depositDue(booking), totalAmount: Number(booking.totalAmount || booking.totalPrice || 0),
    ...(order ? { orderId: itemId(order), orderNo: String(order.orderNo || ""), order: projection ? projection(order) : order } : {}),
  };
}

module.exports = { bookingPaymentSource, finalizePaidBooking, bookingResult, orderIdForBooking };
