"use strict";

const { depositDue, finalDue, hasConfirmedPayment, businessStatusLabel } = require("./orderWorkflow.cjs");
const VERSION = "onsite-payment-v2";
const cancelled = (order) => order.deleted || order.isDeleted || ["canceled", "cancelled", "terminated", "deleted", "已取消"].includes(String(order.status || "").toLowerCase());

function migrationPatch(order) {
  if (order.orderFlowVersion === VERSION) return null;
  const patch = { orderFlowVersion: VERSION };
  if (cancelled(order)) return patch;
  const paidDeposit = hasConfirmedPayment(order, "deposit");
  const zeroFinal = finalDue(order) <= 0;
  const finalConfirmed = hasConfirmedPayment(order, "final") && (!zeroFinal || !!(order.selectionConfirmedAt || order.selectionAcknowledgedAt || order.completionSource));
  if (paidDeposit) {
    patch.depositFrozenAmount = order.depositFrozenAmount ?? depositDue(order);
    patch.depositFrozenAt = order.depositFrozenAt || order.depositConfirmedAt || order.depositPaidAt || order.createTime || "";
  }
  if (order.intentDate === undefined) patch.intentDate = order.expectedDate || order.requestedDate || "";
  if (order.intentTimePeriod === undefined) patch.intentTimePeriod = order.expectedTimePeriod || order.requestedTimePeriod || "";
  if (finalConfirmed) {
    patch.status = "completed";
    patch.workflowStage = "completed";
    patch.completedAt = order.completedAt || order.finalConfirmedAt || order.finalPaidAt
      || (order.paymentRecords || []).find((row) => row.phase === "final" && ["confirmed", "paid", "success"].includes(String(row.status).toLowerCase()))?.paidAt || order.updateTime || order.createTime || "";
    patch.completionSource = order.completionSource || "legacy_verified_final";
    patch.businessStatus = "completed";
    patch.businessStatusText = "已完成";
    patch.customerStatus = "已完成";
  } else {
    const hadCompletion = !!(order.completedAt || ["completed", "done", "paid", "delivered"].includes(String(order.status).toLowerCase()) || order.deliveryRecord || order.deliveredAt);
    if (hadCompletion) {
      patch.migrationReviewRequired = true;
      patch.migrationReviewReason = "历史完成或交付记录缺少已确认尾款，请人工核对";
      patch.paymentReviewRequired = true;
    }
    const stage = order.shootingStartedAt || order.shootingCompletedAt || ["shooting", "final_pending", "editing", "retouching"].includes(String(order.status).toLowerCase()) ? "shooting"
      : order.photographerId || order.dispatchRecord ? "awaiting_shoot" : paidDeposit ? "awaiting_dispatch" : "awaiting_deposit";
    patch.workflowStage = stage;
    patch.businessStatus = stage === "awaiting_dispatch" ? "reserved" : stage === "awaiting_deposit" ? "pending_payment" : stage;
    patch.customerStatus = businessStatusLabel(patch.businessStatus);
    patch.businessStatusText = patch.customerStatus;
  }
  return patch;
}

async function migrateSource(source, options = {}) {
  const rows = await source.list("orders");
  const report = { apply: options.apply === true, total: rows.length, changed: 0, reviewRequired: [], conflicts: [] };
  for (const order of rows) {
    const id = String(order.id || order._id);
    const patch = migrationPatch(order);
    if (!patch) continue;
    report.changed += 1;
    if (patch.migrationReviewRequired) report.reviewRequired.push({ orderId: id, reason: patch.migrationReviewReason });
    if (!report.apply) continue;
    const updated = typeof source.compareAndUpdate === "function"
      ? await source.compareAndUpdate("orders", id, order, patch)
      : await source.update("orders", id, patch);
    if (!updated) report.conflicts.push(id);
  }
  return report;
}
module.exports = { VERSION, migrationPatch, migrateSource };
