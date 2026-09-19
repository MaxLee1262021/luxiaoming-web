"use strict";

// Shared order facts for the public RPC and the protected admin action API.
// Legacy `status` values remain on the order for compatibility; workflowStage
// is the stable customer-facing lifecycle used by new clients.

const WORKFLOW_STAGES = Object.freeze({
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  AWAITING_DEPOSIT: "awaiting_deposit",
  AWAITING_DISPATCH: "awaiting_dispatch",
  AWAITING_SHOOT: "awaiting_shoot",
  SHOOTING: "shooting",
  SELECTION_PENDING: "selection_pending",
  AWAITING_DELIVERY: "awaiting_delivery",
  AWAITING_FINAL_PAYMENT: "awaiting_final_payment",
  PAID: "paid",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

const PAYMENT_PHASES = new Set(["deposit", "final"]);
const PAYMENT_CONFIRMED = new Set([
  "confirmed", "paid", "success", "succeeded", "approved", "passed",
  "已审", "已审核", "已通过", "财务已核对", "财务已核对到账", "已入账", "已到账", "到账",
]);
const PAYMENT_PENDING = new Set([
  "pending", "processing", "待审", "待审核", "待财务审", "待财务审核", "待确认", "待支付", "支付中",
]);
const PAYMENT_FAILED = new Set([
  "failed", "rejected", "denied", "refunded", "已驳", "已驳回", "已退回", "失败", "已退款",
]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "terminated", "deleted", "已取消", "已中止", "中止"]);
const COMPLETED_STATUSES = new Set(["completed", "done", "已完成", "已完"]);
const DELIVERED_STATUSES = new Set(["delivered", "已交付"]);

// Serializes mutations in a process. MySQL writes are transactional; JSON
// writes are atomic at the file level, and this mutex prevents duplicate
// payment intents from being created by concurrent requests in one process.
const ORDER_MUTEXES = new Map();
async function withOrderMutex(key, callback) {
  const mutexKey = String(key || "order:global");
  const previous = ORDER_MUTEXES.get(mutexKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  ORDER_MUTEXES.set(mutexKey, current);
  await previous;
  try { return await callback(); }
  finally {
    release();
    if (ORDER_MUTEXES.get(mutexKey) === current) ORDER_MUTEXES.delete(mutexKey);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
function idOf(value) { return String(value && (value.id || value._id) || ""); }
function textValue(value, fallback = "") {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}
function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
}
function normalizeRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  const ratio = number > 1 ? number / 100 : number;
  return Math.min(Math.max(ratio, 0), 1);
}
function orderTotal(order = {}) {
  return roundMoney(order.totalAmount ?? order.totalPrice ?? order.price ?? 0);
}
function depositDue(order = {}) {
  const explicit = Number(order.depositDue);
  if (Number.isFinite(explicit) && explicit >= 0) return roundMoney(explicit);
  const ratio = normalizeRatio(order.depositRatio ?? order.depositRate ?? order.packageSnapshot?.depositRatio);
  return roundMoney(orderTotal(order) * ratio);
}
function finalDue(order = {}) {
  const explicit = Number(order.finalDue);
  if (Number.isFinite(explicit) && explicit >= 0) return roundMoney(explicit);
  const discount = roundMoney(order.finalDiscountAmount);
  const hasDepositSnapshot = order.depositDue !== undefined && order.depositDue !== null
    || order.depositAmount !== undefined && order.depositAmount !== null;
  const recordedDeposit = Number(order.depositPaid);
  const depositBase = hasDepositSnapshot
    ? roundMoney(order.depositDue ?? order.depositAmount)
    : (Number.isFinite(recordedDeposit) && recordedDeposit >= 0 ? roundMoney(recordedDeposit) : 0);
  return roundMoney(Math.max(orderTotal(order) - depositBase - discount, 0));
}
function recordsFor(order = {}) { return Array.isArray(order.paymentRecords) ? order.paymentRecords : []; }
function latestPayment(order, phase) {
  const rows = recordsFor(order).filter((record) => String(record && record.phase || "") === String(phase || ""));
  return rows.length ? rows[rows.length - 1] : null;
}
function normalizePaymentStatus(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  if (PAYMENT_CONFIRMED.has(raw) || PAYMENT_CONFIRMED.has(lower)) return "confirmed";
  if (PAYMENT_FAILED.has(raw) || PAYMENT_FAILED.has(lower)) return "failed";
  if (PAYMENT_PENDING.has(raw) || PAYMENT_PENDING.has(lower)) return "pending";
  return lower || "pending";
}
function legacyPaymentVerified(order, phase) {
  const text = String(order.paymentVerify || "").trim();
  if (!text || /(未|待|驳|拒|失败)/.test(text)) return false;
  if (!/(核销|核对|到账|入账|已审)/.test(text)) return false;
  return !text.includes("定金") && !text.includes("尾款") || text.includes(phase === "deposit" ? "定金" : "尾款");
}
function hasConfirmedPayment(order = {}, phase) {
  if (!PAYMENT_PHASES.has(String(phase || ""))) return false;
  const due = phase === "deposit" ? depositDue(order) : finalDue(order);
  // A zero final balance is settled only after selection confirmation; a
  // zero-deposit order is immediately eligible for dispatch.
  if (due <= 0) return phase === "deposit"
    || String(order.selectionStatus || "").toLowerCase() === "confirmed"
    || !!order.selectionConfirmedAt;
  const paidField = phase === "deposit" ? "depositPaid" : "finalPaid";
  const statusField = phase === "deposit" ? "depositFinanceStatus" : "finalFinanceStatus";
  const fieldAmount = Number(order[paidField]);
  if (Number.isFinite(fieldAmount) && fieldAmount >= due
    && (normalizePaymentStatus(order[statusField]) === "confirmed" || legacyPaymentVerified(order, phase))) return true;
  return recordsFor(order).some((record) => String(record && record.phase || "") === phase
    && normalizePaymentStatus(record.status) === "confirmed" && roundMoney(record.amount) >= due);
}
function isServiceConfirmed(order = {}) {
  const snapshot = order.confirmationSnapshot;
  if (!order.serviceConfirmedAt || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  return !!(
    String(snapshot.appointmentAt || "").trim()
    && String(snapshot.timePeriod || snapshot.time || "").trim()
    && String(snapshot.appointmentLocation || "").trim()
    && Number.isInteger(Number(snapshot.peopleCount)) && Number(snapshot.peopleCount) > 0
    && String(snapshot.serviceContent || "").trim()
    && Number.isFinite(Number(snapshot.totalAmount)) && Number(snapshot.totalAmount) >= 0
    && Number.isFinite(Number(snapshot.depositRatio))
    && Number.isFinite(Number(snapshot.depositDue)) && Number(snapshot.depositDue) >= 0
    && Number.isFinite(Number(snapshot.finalDue)) && Number(snapshot.finalDue) >= 0
  );
}
function hasDeliveryRecord(order = {}) {
  return !!(order && (order.deliveryRecord || order.deliveredAt));
}
function hasActiveAfterSale(order = {}) {
  const status = String(order.afterSaleStatus || "").trim().toLowerCase();
  if (!status) return false;
  return !["completed", "closed", "done", "已完", "已完成", "已结案", "已结束"].includes(status);
}
function hasPaymentIntent(order = {}, phase = "") {
  return recordsFor(order).some((record) => (!phase || String(record && record.phase || "") === phase)
    && !!(record && (record.idempotencyKey || record.confirmationIdempotencyKey || record.provider || record.externalTransactionId)));
}
function customerCancellation(order = {}) {
  const stage = canonicalStage(order);
  if (stage === WORKFLOW_STAGES.CANCELLED) return { canCancel: false, rule: "before_service_confirmation_and_payment_intent", reason: "订单已取消" };
  if (stage === WORKFLOW_STAGES.COMPLETED) return { canCancel: false, rule: "before_service_confirmation_and_payment_intent", reason: "已完成订单需通过售后处理" };
  if (hasActiveAfterSale(order)) return { canCancel: false, rule: "before_service_confirmation_and_payment_intent", reason: "订单存在处理中售后" };
  if (isServiceConfirmed(order)) return { canCancel: false, rule: "before_service_confirmation_and_payment_intent", reason: "客服联系确认后请通过售后申请处理" };
  if (hasPaymentIntent(order) || hasConfirmedPayment(order, "deposit") || Number(order.depositPaid || 0) > 0) {
    return { canCancel: false, rule: "before_service_confirmation_and_payment_intent", reason: "已创建或确认订金支付，请通过售后申请处理" };
  }
  if (stage !== WORKFLOW_STAGES.AWAITING_CONFIRMATION) return { canCancel: false, rule: "before_service_confirmation_and_payment_intent", reason: "当前订单不支持自助取消" };
  return { canCancel: true, rule: "before_service_confirmation_and_payment_intent", reason: "" };
}
function canonicalStage(order = {}) {
  const status = String(order.status || "").trim().toLowerCase();
  if (CANCELLED_STATUSES.has(status) || order.isDeleted || order.deleted) return WORKFLOW_STAGES.CANCELLED;
  if (COMPLETED_STATUSES.has(status)) return WORKFLOW_STAGES.COMPLETED;
  if (DELIVERED_STATUSES.has(status) || hasDeliveryRecord(order)) {
    // Delivery can precede the final payment. Keep the persisted delivery
    // record visible while exposing the actionable customer stage as final
    // payment until finance confirms the balance.
    if (finalDue(order) > 0 && !hasConfirmedPayment(order, "final")) return WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT;
    return WORKFLOW_STAGES.DELIVERED;
  }
  const selectionConfirmed = String(order.selectionStatus || "").toLowerCase() === "confirmed" || !!order.selectionConfirmedAt;
  if ((["paid", "final_paid"].includes(status) && hasConfirmedPayment(order, "final"))
    || (selectionConfirmed && hasConfirmedPayment(order, "final"))) return WORKFLOW_STAGES.PAID;
  if (selectionConfirmed) return WORKFLOW_STAGES.AWAITING_DELIVERY;
  if (order.shootingCompletedAt || ["final_pending", "editing", "retouching"].includes(status)) return WORKFLOW_STAGES.SELECTION_PENDING;
  if (status === "shooting" || order.shootingStartedAt) return WORKFLOW_STAGES.SHOOTING;
  if (order.dispatchRecord || order.dispatchStatus === "assigned" || order.photographerId || status === "assigned") return WORKFLOW_STAGES.AWAITING_SHOOT;
  if (hasConfirmedPayment(order, "deposit")) return WORKFLOW_STAGES.AWAITING_DISPATCH;
  if (!isServiceConfirmed(order)) return WORKFLOW_STAGES.AWAITING_CONFIRMATION;
  if (depositDue(order) <= 0) return WORKFLOW_STAGES.AWAITING_DISPATCH;
  return WORKFLOW_STAGES.AWAITING_DEPOSIT;
}
function customerStatusForStage(stage) {
  return {
    [WORKFLOW_STAGES.AWAITING_CONFIRMATION]: "待客服联系确认",
    [WORKFLOW_STAGES.AWAITING_DEPOSIT]: "待支付订金",
    [WORKFLOW_STAGES.AWAITING_DISPATCH]: "待安排摄影师",
    [WORKFLOW_STAGES.AWAITING_SHOOT]: "已安排待拍摄",
    [WORKFLOW_STAGES.SHOOTING]: "拍摄中",
    [WORKFLOW_STAGES.SELECTION_PENDING]: "待线下选片确认",
    [WORKFLOW_STAGES.AWAITING_DELIVERY]: "待发布成片",
    [WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT]: "待支付尾款",
    [WORKFLOW_STAGES.PAID]: "已支付待交付",
    [WORKFLOW_STAGES.DELIVERED]: "已交付",
    [WORKFLOW_STAGES.COMPLETED]: "已完成",
    [WORKFLOW_STAGES.CANCELLED]: "已取消",
  }[stage] || "处理中";
}

function safeItem(item = {}) {
  return {
    id: idOf(item),
    packageId: textValue(item.packageId),
    albumId: textValue(item.albumId),
    peripheralId: textValue(item.peripheralId),
    name: textValue(item.name, textValue(item.title)),
    title: textValue(item.title),
    productType: textValue(item.productType, textValue(item.type)),
    price: roundMoney(item.price),
    quantity: Math.max(1, Math.min(99, Math.floor(Number(item.quantity || item.qty || item.count || 1) || 1))),
  };
}
function publicDeliveryRecord(value, fallback = {}) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  const out = {};
  for (const field of ["method", "deliveredAt", "note"]) {
    if (record[field] !== undefined && (typeof record[field] === "string" || typeof record[field] === "number")) out[field] = String(record[field]);
  }
  return out;
}
function privateFileId(value) {
  return typeof value === "string" ? (value.match(/^oss-file:(file_[a-f0-9]{32,48})$/) || [])[1] || "" : "";
}
function privateFileIds(value, output = new Set()) {
  if (typeof value === "string") {
    const id = privateFileId(value); if (id) output.add(id);
  } else if (Array.isArray(value)) value.forEach((item) => privateFileIds(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => privateFileIds(item, output));
  return [...output];
}
function publicDeliveryFiles(value) {
  if (!Array.isArray(value)) return [];
  const fields = ["id", "_id", "fileId", "name", "title", "url", "downloadUrl", "cover", "type", "mediaType", "size", "duration"];
  return value.map((item) => {
    if (typeof item === "string") {
      const fileId = privateFileId(item);
      return fileId ? { id: fileId, fileId } : item.startsWith("oss-file:") ? null : item;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const out = {};
    fields.forEach((field) => {
      if (typeof item[field] === "string" && item[field].startsWith("oss-file:")) return;
      if (item[field] !== undefined && (typeof item[field] !== "object" || item[field] === null)) out[field] = item[field];
    });
    const fileId = privateFileId(item.fileId) || privateFileId(item.url) || privateFileId(item.downloadUrl) || privateFileId(item.fileID);
    if (fileId) { out.id = fileId; out.fileId = fileId; delete out.url; delete out.downloadUrl; }
    return out;
  }).filter(Boolean);
}
function publicStatusTimeline(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(-30).map((item) => {
    if (typeof item === "string") {
      return { type: "订单进度", action: String(item).split(/[：:]/, 1)[0].slice(0, 120) };
    }
    if (!item || typeof item !== "object") return null;
    // Action entries often append an internal reason after a colon. The
    // customer projection deliberately keeps only the public action label.
    const rawAction = String(item.action || item.type || "订单进度");
    const action = rawAction.split(/[：:]/, 1)[0].slice(0, 120);
    const time = textValue(item.createTime, textValue(item.time));
    return {
      type: textValue(item.type, "订单进度").slice(0, 64),
      action,
      ...(time ? { createTime: time, time } : {}),
    };
  }).filter(Boolean);
}
function publicOrderProjection(order = {}, options = {}) {
  const stage = canonicalStage(order);
  const total = orderTotal(order);
  const depositConfirmed = hasConfirmedPayment(order, "deposit");
  const finalConfirmed = hasConfirmedPayment(order, "final");
  const deposit = depositConfirmed ? roundMoney(order.depositPaid) : 0;
  const final = finalConfirmed ? roundMoney(order.finalPaid) : 0;
  const hasIntentIdentity = (record) => !!(record && (record.idempotencyKey || record.provider || record.externalTransactionId));
  const pendingAmount = (phase) => recordsFor(order)
    .filter((record) => String(record && record.phase || "") === phase && normalizePaymentStatus(record.status) === "pending" && hasIntentIdentity(record))
    .reduce((sum, record) => Math.max(sum, roundMoney(record.amount)), 0);
  const pendingDeposit = pendingAmount("deposit") || (!depositConfirmed && normalizePaymentStatus(order.depositFinanceStatus) === "pending" ? roundMoney(order.depositPaid) : 0);
  const pendingFinal = pendingAmount("final") || (!finalConfirmed && normalizePaymentStatus(order.finalFinanceStatus) === "pending" ? roundMoney(order.finalPaid) : 0);
  const paymentStatusFor = (phase) => {
    if (hasConfirmedPayment(order, phase)) return "confirmed";
    const latest = latestPayment(order, phase);
    if (latest && normalizePaymentStatus(latest.status) === "pending" && !hasIntentIdentity(latest)) return "not_created";
    if (latest) return normalizePaymentStatus(latest.status);
    const statusField = phase === "deposit" ? order.depositFinanceStatus : order.finalFinanceStatus;
    if (statusField) return normalizePaymentStatus(statusField);
    const due = phase === "deposit" ? depositDue(order) : finalDue(order);
    return due <= 0 ? "not_required" : "not_created";
  };
  const depositPaymentStatus = paymentStatusFor("deposit");
  const finalPaymentStatus = paymentStatusFor("final");
  const paymentPhase = stage === WORKFLOW_STAGES.AWAITING_DEPOSIT ? "deposit"
    : [WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT, WORKFLOW_STAGES.DELIVERED].includes(stage) ? "final" : "";
  const activePaymentStatus = paymentPhase === "deposit" ? depositPaymentStatus : paymentPhase === "final" ? finalPaymentStatus : "none";
  const items = Array.isArray(order.productItems) ? order.productItems : (Array.isArray(order.items) ? order.items : []);
  const snapshot = order.packageSnapshot && typeof order.packageSnapshot === "object" ? order.packageSnapshot : {};
  const cancellation = customerCancellation(order);
  const afterSaleActive = hasActiveAfterSale(order);
  const deliveryPublished = hasDeliveryRecord(order);
  const canPayDeposit = stage === WORKFLOW_STAGES.AWAITING_DEPOSIT && !afterSaleActive && !hasConfirmedPayment(order, "deposit") && depositDue(order) > 0;
  const canPayFinal = stage === WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT && deliveryPublished && !afterSaleActive && !hasConfirmedPayment(order, "final") && finalDue(order) > 0;
  const output = {
    _id: idOf(order),
    orderNo: String(order.orderNo || ""),
    status: String(order.status || "new"),
    workflowStage: stage,
    statusText: customerStatusForStage(stage),
    customerStatus: customerStatusForStage(stage),
    packageName: textValue(order.packageName, textValue(snapshot.name, textValue(snapshot.packageName, "预约项目"))),
    packagePrice: total,
    totalAmount: total,
    productItems: items.map(safeItem),
    spotName: textValue(order.spotName),
    seriesName: textValue(order.seriesName),
    type: textValue(order.type, textValue(snapshot.serviceType, "photo")),
    contactName: textValue(order.contactName, textValue(order.name)),
    contactPhone: textValue(order.contactPhone, textValue(order.phone)),
    contactWechat: textValue(order.contactWechat, textValue(order.wechat)),
    message: textValue(order.message, textValue(order.customerRemark, textValue(order.remark))),
    paidAmount: roundMoney(deposit + final),
    dueAmount: roundMoney(Math.max(total - deposit - final, 0)),
    pendingPaymentAmount: roundMoney(pendingDeposit + pendingFinal),
    pendingDepositAmount: pendingDeposit,
    pendingFinalAmount: pendingFinal,
    depositDue: depositDue(order),
    depositPaid: deposit,
    finalDue: finalDue(order),
    finalPaid: final,
    paymentStage: paymentPhase || stage,
    paymentPhase,
    paymentStatus: activePaymentStatus,
    paymentPending: activePaymentStatus === "pending" || (paymentPhase === "deposit" ? pendingDeposit > 0 : paymentPhase === "final" && pendingFinal > 0),
    paymentPendingAmount: roundMoney(pendingDeposit + pendingFinal),
    depositPaymentStatus,
    finalPaymentStatus,
    serviceConfirmed: isServiceConfirmed(order),
    serviceConfirmedAt: textValue(order.serviceConfirmedAt),
    deliveryPublished,
    canPayDeposit,
    canPayFinal,
    canPay: canPayDeposit || canPayFinal,
    canCancel: cancellation.canCancel,
    cancelRule: cancellation.rule,
    cancelReason: cancellation.reason,
    canAfterSale: !afterSaleActive && stage !== WORKFLOW_STAGES.CANCELLED,
    afterSaleActive,
    selectionStatus: textValue(order.selectionStatus, order.selectionConfirmedAt ? "confirmed" : "pending"),
    dispatchStatus: textValue(order.dispatchStatus, order.photographerId ? "assigned" : "pending"),
    statusTimeline: publicStatusTimeline(order.statusLogs),
    date: textValue(order.date, textValue(order.appointmentAt)),
    appointmentAt: textValue(order.appointmentAt),
    appointmentLocation: textValue(order.appointmentLocation, textValue(order.shootLocation, textValue(order.location))),
    peopleCount: Number(order.peopleCount || order.participantCount || 0) || undefined,
    timePeriod: textValue(order.timePeriod, textValue(order.time)),
    deliverFiles: [WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT, WORKFLOW_STAGES.DELIVERED, WORKFLOW_STAGES.COMPLETED].includes(stage) && deliveryPublished
      ? publicDeliveryFiles(order.deliverFiles || order.photos) : [],
  };
  if ([WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT, WORKFLOW_STAGES.DELIVERED, WORKFLOW_STAGES.COMPLETED].includes(stage) && deliveryPublished) output.deliveryRecord = publicDeliveryRecord(order.deliveryRecord, { method: textValue(order.deliveryMethod), deliveredAt: textValue(order.deliveredAt), note: textValue(order.deliveryNote) });
  if (options.detail) output.createdAt = order.createTime || order.createdAt || "";
  return output;
}

const AUDIT_FIELDS = [
  "status", "workflowStage", "totalAmount", "totalPrice", "price", "depositRatio", "finalDiscountAmount", "finalDiscountReason", "priceAdjustReason",
  "depositDue", "depositPaid", "depositFinanceStatus", "finalDue", "finalPaid", "finalFinanceStatus", "photographerId", "assigneeId",
  "appointmentAt", "timePeriod", "time", "appointmentLocation", "peopleCount", "dispatchStatus", "taskStatus", "taskAcceptedAt", "taskAcceptedBy", "selectionStatus", "shootingStartedAt", "shootingCompletedAt",
  "selectionConfirmedAt", "selectionConfirmedBy", "selectionNote", "deliveryMethod", "deliveredAt", "deliveredBy", "deliveryNote", "deliveryRecord",
  "serviceConfirmedAt", "serviceConfirmedBy", "serviceConfirmReason", "serviceContent", "confirmationSnapshot", "customerCancelIdempotencyKey", "cancelledAt", "cancelledBy",
  "deliveryDraftFileIds", "deliverFiles",
  "dispatchRecord", "dispatchRecords", "paymentRecords", "sourceType", "sourceName", "sourceScene", "shopId", "distributorId", "riskBlocked", "riskFlag", "frozen",
  "freezeReason", "riskReason", "settlementObservationReleased", "settlementObservationReleasedAt", "settlementObservationReleasedBy",
];
function auditPaymentRecord(record = {}) {
  return {
    id: idOf(record), phase: String(record.phase || ""), amount: roundMoney(record.amount), status: String(record.status || ""), attempt: Number(record.attempt || 0) || 0,
    externalTransactionId: String(record.externalTransactionId || ""), idempotencyKey: String(record.idempotencyKey || ""), confirmationIdempotencyKey: String(record.confirmationIdempotencyKey || ""),
    operator: String(record.operator || ""), operatorId: String(record.operatorId || ""), createdAt: String(record.createdAt || ""), updatedAt: String(record.updatedAt || ""),
  };
}
function auditFacts(order = {}) {
  const facts = { workflowStage: canonicalStage(order) };
  for (const field of AUDIT_FIELDS) {
    if (field === "workflowStage" || !Object.prototype.hasOwnProperty.call(order, field)) continue;
    facts[field] = field === "paymentRecords" ? recordsFor(order).slice(-50).map(auditPaymentRecord) : clone(order[field]);
  }
  facts.depositDue = depositDue(order); facts.finalDue = finalDue(order);
  facts.depositPaid = roundMoney(order.depositPaid); facts.finalPaid = roundMoney(order.finalPaid);
  return facts;
}
function diffFacts(before, after) {
  const left = auditFacts(before); const right = auditFacts(after); const changed = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) changed[key] = { before: left[key] ?? null, after: right[key] ?? null };
  }
  return changed;
}
function makePaymentId(prefix = "pay") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  WORKFLOW_STAGES,
  PAYMENT_PHASES,
  PAYMENT_CONFIRMED,
  PAYMENT_PENDING,
  PAYMENT_FAILED,
  COMPLETED_STATUSES,
  clone,
  idOf,
  roundMoney,
  normalizeRatio,
  orderTotal,
  depositDue,
  finalDue,
  recordsFor,
  latestPayment,
  hasConfirmedPayment,
  isServiceConfirmed,
  hasDeliveryRecord,
  hasActiveAfterSale,
  hasPaymentIntent,
  customerCancellation,
  normalizePaymentStatus,
  canonicalStage,
  customerStatusForStage,
  publicDeliveryRecord,
  privateFileId,
  privateFileIds,
  publicDeliveryFiles,
  publicStatusTimeline,
  publicOrderProjection,
  auditFacts,
  diffFacts,
  makePaymentId,
  withOrderMutex,
};
