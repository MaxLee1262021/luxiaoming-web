// 服务流程、派单、转派、改期与收款
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    addFollowLog,
    addOrderTimeline,
    can,
    canCompleteOrderPayment,
    canEditCurrentOrder,
    canEditOrder,
    currentOperatorName,
    distributorName,
    due,
    expectedFinalAmount,
    finalGap,
    financePendingAmount,
    isDepositRegistrationConfirmed,
    isOrderCancelledStatus,
    isOrderCompletedStatus,
    isOrderAfterSaleLocked,
    log,
    money,
    normalizeReviewStatus,
    orderSourceName,
    orderSourceType,
    orderSourceTypeText,
    paid,
    persistOrderAction,
    photographerDisplayName,
    roleProfile,
    selectedOrders,
    serviceOwnerName,
    shopName,
    staffName,
    state,
    statusMeta
  } = ctx;

const WORKFLOW_STAGES = Object.freeze({
  AWAITING_DEPOSIT: "awaiting_deposit",
  AWAITING_DISPATCH: "awaiting_dispatch",
  AWAITING_SHOOT: "awaiting_shoot",
  SHOOTING: "shooting",
  SELECTION_PENDING: "selection_pending",
  AWAITING_FINAL_PAYMENT: "awaiting_final_payment",
  PAID: "paid",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

const serviceFlowSteps = [
  { key: "awaiting_deposit", label: "订金", note: "等待订金到账确认" },
  { key: "dispatch", label: "派单", note: "确认时间、地点和人数后安排摄影师" },
  { key: "shoot", label: "拍摄", note: "摄影师开始拍摄并登记完成" },
  { key: "selection", label: "选片", note: "线下选片确认后可登记成片交付" },
  { key: "deliver", label: "交付", note: "线下选片确认后登记成片交付" },
  { key: "final", label: "尾款", note: "交付记录完成后登记尾款" },
  { key: "complete", label: "完成", note: "交付与款项均确认后结束订单" },
];

function paymentDue(order = {}, phase = "deposit") {
  const field = phase === "deposit" ? "depositDue" : "finalDue";
  const explicit = Number(order[field]);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return phase === "final" ? expectedFinalAmount(order) : 0;
}

function isPhaseConfirmed(order = {}, phase = "deposit") {
  const dueAmount = paymentDue(order, phase);
  if (dueAmount <= 0) return true;
  const paidField = phase === "deposit" ? "depositPaid" : "finalPaid";
  const financeField = phase === "deposit" ? "depositFinanceStatus" : "finalFinanceStatus";
  const paymentField = phase === "deposit" ? "depositPaymentStatus" : "finalPaymentStatus";
  const paymentState = String(order[paymentField] || "").trim().toLowerCase();
  return Number(order[paidField] || 0) >= dueAmount
    && (normalizeReviewStatus(order[financeField]) === "已审" || ["confirmed", "paid", "success", "succeeded"].includes(paymentState));
}

function workflowStageOf(order = {}) {
  const declared = String(order.workflowStage || "").trim();
  if (Object.values(WORKFLOW_STAGES).includes(declared)) {
    return declared === WORKFLOW_STAGES.DELIVERED && isOrderCompletedStatus(order)
      ? WORKFLOW_STAGES.COMPLETED
      : declared;
  }
  const status = String(order.status || "").trim().toLowerCase();
  if (["cancelled", "canceled", "terminated", "deleted"].includes(status)) return WORKFLOW_STAGES.CANCELLED;
  if (status === "completed") return WORKFLOW_STAGES.COMPLETED;
  if (status === "delivered" || order.deliveryRecord || order.deliveredAt) return WORKFLOW_STAGES.DELIVERED;
  const selectionConfirmed = String(order.selectionStatus || "").toLowerCase() === "confirmed" || !!order.selectionConfirmedAt;
  if (selectionConfirmed && isPhaseConfirmed(order, "final")) return WORKFLOW_STAGES.PAID;
  if (selectionConfirmed) return WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT;
  if (order.shootingCompletedAt || ["final_pending", "editing", "retouching"].includes(status)) return WORKFLOW_STAGES.SELECTION_PENDING;
  if (status === "shooting" || order.shootingStartedAt) return WORKFLOW_STAGES.SHOOTING;
  if (status === "assigned" || order.dispatchRecord || order.dispatchStatus === "assigned" || order.photographerId) return WORKFLOW_STAGES.AWAITING_SHOOT;
  if (status === "deposit_pending" || (paymentDue(order, "deposit") > 0 && !isPhaseConfirmed(order, "deposit"))) return WORKFLOW_STAGES.AWAITING_DEPOSIT;
  return WORKFLOW_STAGES.AWAITING_DISPATCH;
}

function serviceFlowIndex(order) {
  const stage = workflowStageOf(order);
  if (stage === WORKFLOW_STAGES.COMPLETED) return 6;
  if (hasDeliveryRecord(order)) return isPhaseConfirmed(order, "final") ? 6 : 5;
  if (isSelectionConfirmed(order)) return 4;
  if (stage === WORKFLOW_STAGES.AWAITING_DEPOSIT) return 0;
  if (stage === WORKFLOW_STAGES.AWAITING_DISPATCH) return 1;
  if ([WORKFLOW_STAGES.AWAITING_SHOOT, WORKFLOW_STAGES.SHOOTING].includes(stage)) return 2;
  if (stage === WORKFLOW_STAGES.SELECTION_PENDING) return 3;
  if ([WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT, WORKFLOW_STAGES.PAID].includes(stage)) return 5;
  if (stage === WORKFLOW_STAGES.DELIVERED) return 5;
  return 0;
}

function serviceFlowCurrent(order) {
  return serviceFlowSteps[serviceFlowIndex(order)] || serviceFlowSteps[0];
}

function serviceFlowClass(index, order) {
  const current = serviceFlowIndex(order);
  return { done: index < current, active: index === current };
}

function serviceInternalStatusLabel(order) {
  if (!order) return "-";
  if (workflowStageOf(order) === WORKFLOW_STAGES.COMPLETED) return "已完成";
  return serviceFlowCurrent(order).label;
}

function serviceCustomerStatusLabel(order) {
  if (!order) return "-";
  const customerStatus = String(order.customerStatus || "").trim();
  return (LXM_CONFIG.visibleStatus.find((item) => item.value === customerStatus) || {}).label
    || customerStatus
    || statusMeta(order.status).customer
    || "-";
}

function canAcceptOrder(order = state.currentOrder) {
  return !!order && canEditCurrentOrder() && !state.orderReadonly && !isOrderAfterSaleLocked(order)
    && ["new", "pending"].includes(String(order.status || "").toLowerCase());
}

function canDispatchOrder(order = state.currentOrder) {
  return !!order && canEditCurrentOrder() && !state.orderReadonly && !isOrderAfterSaleLocked(order)
    && workflowStageOf(order) === WORKFLOW_STAGES.AWAITING_DISPATCH;
}
function canTransferCustomerService(order = state.currentOrder) {
  if (!order && state.transferForm.batch) return selectedOrders.value.some((item) => canTransferCustomerService(item));
  if (!order || state.orderReadonly || isOrderAfterSaleLocked(order)) return false;
  if (state.role === "super") return !["completed", "cancelled", "canceled"].includes(order.status);
  return state.role === "service" && order.assigneeId === roleProfile.value.staffId && !["completed", "cancelled", "canceled"].includes(order.status);
}
function canTransferPhotographer(order = state.currentOrder) {
  if (!order && state.transferForm.batch) return selectedOrders.value.some((item) => canTransferPhotographer(item));
  return !!order && state.role === "super" && !state.orderReadonly && !isOrderAfterSaleLocked(order) && !["completed", "cancelled", "canceled"].includes(order.status);
}
function canTransferOrder(order = state.currentOrder) {
  if (!order && selectedOrders.value?.length) return selectedOrders.value.some((item) => canTransferCustomerService(item) || canTransferPhotographer(item));
  return canTransferCustomerService(order) || canTransferPhotographer(order);
}
function canRescheduleOrder(order = state.currentOrder) {
  return !!order && canEditCurrentOrder() && !state.orderReadonly && !isOrderAfterSaleLocked(order)
    && [WORKFLOW_STAGES.AWAITING_DEPOSIT, WORKFLOW_STAGES.AWAITING_DISPATCH, WORKFLOW_STAGES.AWAITING_SHOOT].includes(workflowStageOf(order));
}
function defaultCustomerStatusForOrderStatus(status) {
  const map = {
    pending: "reserved",
    new: "reserved",
    contacted: "confirmed",
    deposit_pending: "reserved",
    deposit_paid: "confirmed",
    assigned: "confirmed",
    confirmed: "confirmed",
    shooting: "shooting",
    retouching: "shooting",
    delivered: "done",
    final_pending: "done",
    completed: "done",
    cancelled: "reserved",
  };
  return map[status] || "reserved";
}
function canUseOrderExceptionTools(order = state.currentOrder) {
  return !!order && state.role === "super" && !state.orderReadonly;
}
function openOrderExceptionDialog(order = state.currentOrder) {
  if (!canUseOrderExceptionTools(order)) return ElMessage.error("只有超管可以使用订单异常处理");
  state.currentOrder = order;
  state.exceptionForm = {
    status: order.status || "pending",
    customerStatus: order.customerStatus || defaultCustomerStatusForOrderStatus(order.status),
    sourceType: orderSourceType(order),
    shopId: order.shopId || "",
    distributorId: order.distributorId || "",
    clearRisk: false,
    reason: "",
  };
  state.exceptionDialog = true;
}
async function confirmOrderException() {
  const order = state.currentOrder;
  const form = state.exceptionForm;
  if (!canUseOrderExceptionTools(order)) return ElMessage.error("只有超管可以提交异常处理");
  if (!String(form.reason || "").trim()) return ElMessage.warning("请填写异常处理原因，便于后续审计追溯");
  const original = JSON.parse(JSON.stringify(order));
  const before = {
    status: order.status,
    customerStatus: order.customerStatus,
    sourceType: orderSourceType(order),
    shopId: order.shopId || "",
    distributorId: order.distributorId || "",
    riskBlocked: !!(order.riskBlocked || order.riskFlag || order.frozen || order.freezeReason),
  };
  order.status = form.status || order.status;
  order.customerStatus = form.customerStatus || defaultCustomerStatusForOrderStatus(order.status);
  order.sourceType = form.sourceType || order.sourceType || "";
  if (order.sourceType === "headquarter") {
    order.shopId = "";
    order.distributorId = "";
    order.sourceName = "总部自有二维";
    order.sourceScene = "总部铺码";
  } else {
    order.shopId = form.shopId || "";
    order.distributorId = form.distributorId || "";
    order.sourceName = orderSourceName(order);
    order.sourceScene = orderSourceTypeText(order);
  }
  if (form.clearRisk) {
    order.riskBlocked = false;
    order.riskFlag = false;
    order.frozen = false;
    order.freezeReason = "";
    order.riskReason = "";
  }
  const after = {
    status: order.status,
    customerStatus: order.customerStatus,
    sourceType: orderSourceType(order),
    shopId: order.shopId || "",
    distributorId: order.distributorId || "",
    riskBlocked: !!(order.riskBlocked || order.riskFlag || order.frozen || order.freezeReason),
  };
  const text = `超管异常处理：状"${statusMeta(before.status).label} -> ${statusMeta(after.status).label}；来"${before.sourceType || "-"} -> ${after.sourceType || "-"}；商"${shopName(before.shopId)} -> ${shopName(after.shopId)}；分销"${distributorName(before.distributorId)} -> ${distributorName(after.distributorId)}；原因：${form.reason}`;
  try {
    await persistOrderAction(order, "update", {
      fields: {
        status: order.status,
        customerStatus: order.customerStatus,
        sourceType: order.sourceType,
        sourceName: order.sourceName,
        sourceScene: order.sourceScene,
        shopId: order.shopId,
        distributorId: order.distributorId,
        riskBlocked: order.riskBlocked,
        riskFlag: order.riskFlag,
        frozen: order.frozen,
        freezeReason: order.freezeReason,
        riskReason: order.riskReason,
      },
      reason: form.reason,
    });
    addOrderTimeline(order, text, currentOperatorName());
    log("订单异常处理", order.orderNo, text, currentOperatorName(), { module: "订单履约", level: "", objectType: "订单", objectName: order.orderNo, snapshot: JSON.stringify({ before, after }) });
    state.exceptionDialog = false;
    ElMessage.success("异常处理已完成，并写入审计日");
  } catch (_) {
    Object.keys(order).forEach((key) => { if (!(key in original)) delete order[key]; });
    Object.assign(order, original);
  }
}
async function addOrderContact(type) {
  const order = state.currentOrder;
  if (!order) return;
  if (!canEditCurrentOrder()) return ElMessage.error("当前订单不能新增联系方式");
  const key = type === "phone" ? "phone" : "wechat";
  const listKey = type === "phone" ? "extraPhones" : "extraWechats";
  const label = type === "phone" ? "手机" : "微信";
  const value = String(state.contactDraft[key] || "").trim();
  if (!value) return ElMessage.warning(`请填写新${label}`);
  const original = JSON.parse(JSON.stringify(order));
  order[listKey] = order[listKey] || [];
  if ([order[key], ...order[listKey]].filter(Boolean).includes(value)) return ElMessage.warning(`${label}已存在`);
  order[listKey].push(value);
  if (type === "phone") order.contactPhones = [...new Set([order.phone, ...(order.contactPhones || []), ...order.extraPhones].filter(Boolean))];
  try {
    await persistOrderAction(order, "update", { fields: { contactPhones: order.contactPhones || [], extraWechats: order.extraWechats || [] }, reason: `新增客户${label}` });
  } catch (_) {
    Object.keys(order).forEach((field) => { if (!(field in original)) delete order[field]; });
    Object.assign(order, original);
    return;
  }
  state.contactDraft[key] = "";
  addOrderTimeline(order, `新增客户${label}：${value}`, currentOperatorName());
  ElMessage.success(`已新增${label}`);
}
function serviceFlowBadgeClass(order, type) {
  if (!order) return "";
  if (isOrderCompletedStatus(order)) return "completed";
  if (type === "customer" && ["done", "delivered"].includes(order.customerStatus)) return "delivered";
  if (["done", "delivered"].includes(order.customerStatus)) return "delivered";
  return order.status || "";
}
async function setServiceFlowStep(step) {
  if (!step) return;
  const order = state.currentOrder;
  if (!canSetServiceFlowStep(step, order)) return ElMessage.warning(serviceFlowDisabledReason(step, order) || "当前状态不能重复点击或跳转，请按订单流程顺序推进");
  if (step.key === "shoot") return openDispatchDialog(order);
  if (step.key === "selection") return completeShooting(order);
  if (step.key === "deliver") return confirmOfflineSelection(order);
  if (step.key === "final") return deliverOrder(order);
  if (step.key === "complete") return openCompleteOrderDialog(order);
}
function canSetServiceFlowStep(step, order = state.currentOrder) {
  if (!step || !order || !canEditCurrentOrder() || state.orderReadonly || isOrderAfterSaleLocked(order)) return false;
  const current = serviceFlowIndex(order);
  const target = serviceFlowSteps.findIndex((item) => item.key === step.key);
  if (step.key === "complete" && target === current) return canCompleteWorkflow(order);
  if (target !== current + 1) return false;
  const stage = workflowStageOf(order);
  if (step.key === "shoot") return stage === WORKFLOW_STAGES.AWAITING_DISPATCH && canDispatchOrder(order);
  if (step.key === "selection") return stage === WORKFLOW_STAGES.SHOOTING && canCompleteTask(order);
  if (step.key === "deliver") return stage === WORKFLOW_STAGES.SELECTION_PENDING && canConfirmOfflineSelection(order);
  if (step.key === "final") return isSelectionConfirmed(order) && canDeliverOrder(order);
  return false;
}
function serviceFlowDisabledReason(step, order = state.currentOrder) {
  if (!step || !order) return "暂无订单";
  if (!canEditOrder()) return "当前角色没有推进订单状态权";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，订单状态已锁定";
  if (isOrderCompletedStatus(order)) return "订单已完成，不能重复推进";
  const current = serviceFlowIndex(order);
  const target = serviceFlowSteps.findIndex((item) => item.key === step.key);
  if (step.key === "complete" && target === current && canCompleteWorkflow(order)) return "";
  if (target <= current) return "当前或历史状态不能重复点";
  if (target > current + 1) return "请按订单流程顺序推进";
  const stage = workflowStageOf(order);
  if (step.key === "dispatch") return "等待订金到账确认后进入待派单";
  if (step.key === "shoot" && stage !== WORKFLOW_STAGES.AWAITING_DISPATCH) return "当前订单尚未满足派单条件";
  if (step.key === "selection" && stage === WORKFLOW_STAGES.AWAITING_SHOOT) return "请先开始拍摄";
  if (step.key === "selection") return "拍摄开始后才能登记拍摄完成";
  if (step.key === "deliver") return "拍摄完成后才能确认线下选片";
  if (step.key === "final") return "线下选片确认后才能登记成片交付";
  if (step.key === "complete") return "交付记录及全部款项确认后才能完成订单";
  return "";
}
function dispatchDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权安排摄影";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能安排或改派摄影师";
  if (workflowStageOf(order) === WORKFLOW_STAGES.AWAITING_DEPOSIT) return "订金到账确认后才能派单";
  if (workflowStageOf(order) !== WORKFLOW_STAGES.AWAITING_DISPATCH) return "订单当前不在待派单阶段";
  return "";
}
function rescheduleDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权改期";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能改期拍摄";
  if (![WORKFLOW_STAGES.AWAITING_DEPOSIT, WORKFLOW_STAGES.AWAITING_DISPATCH, WORKFLOW_STAGES.AWAITING_SHOOT].includes(workflowStageOf(order))) return "拍摄开始后需走异常或售后流程调整";
  return "";
}
function isSelectionConfirmed(order = state.currentOrder) {
  return !!order && (String(order.selectionStatus || "").toLowerCase() === "confirmed" || !!order.selectionConfirmedAt);
}
function canRegisterDepositPaymentAction(order = state.currentOrder) {
  if (!order || !canEditCurrentOrder() || state.orderReadonly || isOrderAfterSaleLocked(order)) return false;
  return workflowStageOf(order) === WORKFLOW_STAGES.AWAITING_DEPOSIT
    && paymentDue(order, "deposit") > 0
    && !["待审", "已审"].includes(normalizeReviewStatus(order.depositFinanceStatus));
}
function depositPaymentActionDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditCurrentOrder()) return "当前订单不可登记订金";
  if (state.orderReadonly) return "当前为只读查看模式";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，暂不能登记订金";
  if (workflowStageOf(order) !== WORKFLOW_STAGES.AWAITING_DEPOSIT) return "订单当前不在订金登记阶段";
  if (paymentDue(order, "deposit") <= 0) return "当前订单无需收取订金";
  if (["待审", "已审"].includes(normalizeReviewStatus(order.depositFinanceStatus))) return "订金已提交或已通过财务审核";
  return "";
}
function canRegisterFinalPayment(order = state.currentOrder) {
  if (!order || !canEditCurrentOrder() || state.orderReadonly || isOrderAfterSaleLocked(order)) return false;
  if (!isSelectionConfirmed(order)) return false;
  if (!hasDeliveryRecord(order)) return false;
  if (!isPhaseConfirmed(order, "deposit")) return false;
  return paymentDue(order, "final") > 0 && !["待审", "已审"].includes(normalizeReviewStatus(order.finalFinanceStatus));
}
function finalPaymentDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditCurrentOrder()) return "当前订单不可登记尾款";
  if (state.orderReadonly) return "当前为只读查看模式";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，暂不能登记尾款";
  if (!isSelectionConfirmed(order)) return "线下选片确认后才能登记尾款";
  if (!hasDeliveryRecord(order)) return "请先登记成片交付，再登记尾款";
  if (!isPhaseConfirmed(order, "deposit")) return "定金必须财务审核通过后才能登记尾款";
  if (paymentDue(order, "final") <= 0) return "当前没有需要登记的应收尾款";
  if (["待审", "已审"].includes(normalizeReviewStatus(order.finalFinanceStatus))) return "尾款已提交或已通过财务审核";
  return "";
}
function hasDeliveryRecord(order = state.currentOrder) {
  return !!order && (!!order.deliveryRecord || !!order.deliveredAt || ["delivered", "completed"].includes(String(order.status || "").toLowerCase()));
}
function canCompleteWorkflow(order = state.currentOrder) {
  return !!order && !isOrderCompletedStatus(order) && !isOrderCancelledStatus(order)
    && hasDeliveryRecord(order) && isPhaseConfirmed(order, "deposit") && isPhaseConfirmed(order, "final");
}
function completeDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权完成订单";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能完成订单";
  if (isOrderCompletedStatus(order)) return "订单已完成，不能重复操作";
  if (!hasDeliveryRecord(order)) return "请先登记成片交付";
  if (!isPhaseConfirmed(order, "deposit")) return "定金必须财务审核通过";
  if (!isPhaseConfirmed(order, "final")) return "尾款必须财务审核通过";
  return "";
}
function cancelDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!can("cancelOrder")) return "当前角色无权取消订单";
  if (!canEditCurrentOrder()) return "当前订单不可取消";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能取消订单";
  if (isOrderCompletedStatus(order)) return "已完成订单只能通过售后退款和财务冲正处理";
  return "";
}
async function setOrderStatus(status, customerStatus, label) {
  if (!state.currentOrder) return;
  if (status === "confirmed") return acceptOrder(state.currentOrder);
  if (status === "shooting") return startShooting(state.currentOrder);
  if (status === "delivered") return deliverOrder(state.currentOrder);
  if (status === "completed") return openCompleteOrderDialog(state.currentOrder);
  return ElMessage.warning("请使用订单流程中的专用操作推进状态");
}
function openCompleteOrderDialog(order = state.currentOrder) {
  if (!order) return;
  if (!canEditOrder()) return ElMessage.error("当前角色无权完成订单");
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单售后处理中，暂不能完成订单");
  if (!canCompleteWorkflow(order)) return ElMessage.warning(completeDisabledReason(order));
  state.currentOrder = order;
  state.completeOrderNote = "";
  state.completeOrderDialog = true;
}
function confirmCompleteOrder() {
  const order = state.currentOrder;
  if (!order) return;
  if (!canEditOrder()) return ElMessage.error("当前角色无权完成订单");
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单售后处理中，暂不能完成订单");
  if (!canCompleteWorkflow(order)) return ElMessage.warning(completeDisabledReason(order));
  const note = String(state.completeOrderNote || "").trim();
  const reason = note ? `客服确认交付与款项均已完成：${note}` : "客服确认交付与款项均已完成";
  persistOrderAction(order, "complete", { reason })
    .then(() => {
      log("订单完成", order.orderNo, `已确认交付及收款，累计实收 ${money(paid(order))}`);
      state.completeOrderDialog = false;
      state.completeOrderNote = "";
      ElMessage.success("订单已完成");
    })
    .catch(() => {});
}
async function saveOrder() {
  if (!canEditOrder()) return ElMessage.error("当前角色无权保存客服处理信息");
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能保存客服处理信息");
  if (!String(state.currentOrder?.customer || "").trim() || !String(state.currentOrder?.phone || "").trim()) return ElMessage.warning("请先填写客户姓名和手机号");
  const original = JSON.parse(JSON.stringify(state.currentOrder));
  if (state.role === "service" && !state.currentOrder.assigneeId) state.currentOrder.assigneeId = roleProfile.value.staffId || state.currentStaffId || "";
  state.saving = true;
  try {
    const order = state.currentOrder;
    const fields = {
      customer: String(order.customer || "").trim(),
      contactName: String(order.customer || "").trim(),
      phone: String(order.phone || "").trim(),
      contactPhone: String(order.phone || "").trim(),
      wechat: String(order.wechat || "").trim(),
      contactWechat: String(order.wechat || "").trim(),
      appointmentAt: order.appointmentAt || "",
      timePeriod: order.timePeriod || "",
      internalNote: order.internalNote || "",
      assigneeId: order.assigneeId || "",
    };
    await persistOrderAction(order, "update", { fields, reason: "确认客户信息" });
    state.moneyEdit = "";
    state.moneyDraft = 0;
    log("确认客户信息", order.orderNo, `状态：${statusMeta(order.status).label}，负责客服：${serviceOwnerName(order)}，待收：${money(due(order))}`);
    ElMessage.success("客户信息已保存，操作日志已记");
  } catch (_) {
    // persistOrderAction has already shown the server failure; do not report success.
    Object.keys(state.currentOrder).forEach((key) => { if (!(key in original)) delete state.currentOrder[key]; });
    Object.assign(state.currentOrder, original);
  } finally {
    state.saving = false;
  }
}
function moneyFieldMeta(field) {
  return {
    couponAmount: { label: "优惠", reason: "优惠减免原因" },
    totalAmount: { label: "订单总价", reason: "改价/优惠原因" },
    depositPaid: { label: "已收定金", reason: "定金调整原因" },
    finalPaid: { label: "已收尾款", reason: "尾款调整原因" }
  }[field] || { label: "金额", reason: "调整原因" };
}
function enableMoneyEdit(field) {
  if (!canEditOrder()) return ElMessage.error("当前角色无权调整金额");
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能调整金额");
  if (field === "depositPaid" && Number(state.currentOrder?.depositPaid || 0) > 0) return ElMessage.warning("定金已收后不可更");
  state.moneyEdit = field;
  state.moneyDraft = field === "couponAmount" ? Number(state.currentOrder.finalDiscountAmount || 0) : Number(state.currentOrder[field] || 0);
  addOrderTimeline(state.currentOrder, `开启${moneyFieldMeta(field).label}调整，等待填写原因`);
  ElMessage.warning(`已开启${moneyFieldMeta(field).label}调整，请填写原因并确认`);
}
async function confirmMoneyEdit(field) {
  if (!state.currentOrder) return;
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能调整金额");
  const meta = moneyFieldMeta(field);
  const next = Number(state.moneyDraft || 0);
  if (!state.currentOrder.priceAdjustReason) return ElMessage.warning(`请先填写${meta.reason}`);
  const previous = field === "couponAmount" ? Number(state.currentOrder.finalDiscountAmount || 0) : Number(state.currentOrder[field] || 0);
  const beforeValues = {
    totalAmount: state.currentOrder.totalAmount,
    depositPaid: state.currentOrder.depositPaid,
    finalPaid: state.currentOrder.finalPaid,
    finalDiscountAmount: state.currentOrder.finalDiscountAmount,
    finalDiscountReason: state.currentOrder.finalDiscountReason,
    priceAdjustReason: state.currentOrder.priceAdjustReason,
  };
  if (field !== "couponAmount") state.currentOrder[field] = next;
  if (field === "couponAmount") {
    const maxCoupon = Math.max(Number(state.currentOrder.totalAmount || 0) - Number(state.currentOrder.depositPaid || 0), 0);
    if (next > maxCoupon) return ElMessage.warning(`优惠券金额不能超过当前可优惠金额 ${money(maxCoupon)}`);
    state.currentOrder.finalDiscountAmount = next;
    state.currentOrder.finalDiscountReason = state.currentOrder.priceAdjustReason;
    if (!["待审", "已审"].includes(normalizeReviewStatus(state.currentOrder.finalFinanceStatus))) {
      state.currentOrder.finalPaid = 0;
    }
  }
  if (field === "finalPaid") {
    const expectedFinal = Math.max(Number(state.currentOrder.totalAmount || 0) - Number(state.currentOrder.depositPaid || 0), 0);
    state.currentOrder.finalDiscountAmount = Math.max(expectedFinal - next, 0);
    state.currentOrder.finalDiscountReason = state.currentOrder.priceAdjustReason;
  }
  if (field === "totalAmount") {
    state.currentOrder.finalDiscountAmount = 0;
    state.currentOrder.finalDiscountReason = "";
  }
  state.moneyEdit = "";
  state.moneyDraft = 0;
  const discountText = (field === "finalPaid" || field === "couponAmount") && state.currentOrder.finalDiscountAmount > 0 ? `；优惠券减免 ${money(state.currentOrder.finalDiscountAmount)}` : "";
  const order = state.currentOrder;
  const fields = { [field === "couponAmount" ? "finalDiscountAmount" : field]: field === "couponAmount" ? order.finalDiscountAmount : order[field], priceAdjustReason: order.priceAdjustReason || "" };
  if (field === "couponAmount" || field === "finalPaid" || field === "totalAmount") {
    fields.finalDiscountReason = order.finalDiscountReason || order.priceAdjustReason || "";
  }
  try {
    await persistOrderAction(order, "update", { fields, reason: order.priceAdjustReason || `${meta.label}调整` });
    addOrderTimeline(order, `确认${meta.label}调整 ${money(previous)} 调整为 ${money(next)}${discountText}；原因：${order.priceAdjustReason}`);
    ElMessage.success(`${meta.label}已确认保存`);
  } catch (_) {
    Object.assign(order, beforeValues);
  }
}
async function confirmPaymentRegistration(field) {
  const order = state.currentOrder;
  if (!order) return;
  if (!canEditCurrentOrder()) return ElMessage.error("当前状态不能登记收");
  const phase = field === "depositPaid" ? "deposit" : "final";
  if (phase === "final" && !canRegisterFinalPayment(order)) return ElMessage.warning(finalPaymentDisabledReason(order));
  if (phase === "deposit" && workflowStageOf(order) !== WORKFLOW_STAGES.AWAITING_DEPOSIT) return ElMessage.warning("订单当前不在订金登记阶段");
  const statusField = field === "depositPaid" ? "depositFinanceStatus" : "finalFinanceStatus";
  const timeField = field === "depositPaid" ? "depositPaidAt" : "finalPaidAt";
  if (normalizeReviewStatus(order[statusField]) === "待审") return ElMessage.warning(`${moneyFieldMeta(field).label}已提交财务审核，请等待财务确认`);
  if (normalizeReviewStatus(order[statusField]) === "已审") return ElMessage.warning(`${moneyFieldMeta(field).label}已通过财务审核，如需修改请点击改价并填写原因`);
  const beforeRegistration = { [field]: order[field], [statusField]: order[statusField], [timeField]: order[timeField] };
  const amount = paymentDue(order, phase);
  if (amount <= 0) return ElMessage.warning(`当前没有需要登记的${moneyFieldMeta(field).label}`);
  order[field] = amount;
  const orderId = String(order.id || order._id || "order");
  const idempotencyKey = `admin-${orderId}-${phase}-${Date.now().toString(36)}`.slice(0, 128);
  const reason = `客服登记${moneyFieldMeta(field).label} ${money(amount)}，待财务审核`;
  try {
    await persistOrderAction(order, "payment", { phase, amount, paymentStatus: "pending", idempotencyKey, reason });
    addOrderTimeline(order, `客服确认登记${moneyFieldMeta(field).label} ${money(amount)}，待财务审核`, currentOperatorName());
    log("登记收款", order.orderNo, `${moneyFieldMeta(field).label} ${money(amount)} 待财务审核`);
    ElMessage.success(`${moneyFieldMeta(field).label}已登记，待财务审核确认`);
  } catch (_) {
    Object.assign(order, beforeRegistration);
  }
}
function confirmFinalPaymentWithCheck() {
  const order = state.currentOrder;
  if (!order) return;
  if (!canRegisterFinalPayment(order)) return ElMessage.warning(finalPaymentDisabledReason(order));
  const amount = paymentDue(order, "final");
  ElMessageBox.confirm(
    `确认将本单应收尾款 ${money(amount)} 登记为已收尾款，并提交财务审核？\n订单总价 ${money(order.totalAmount)}\n已确认定金 ${money(order.depositPaid)}\n线下选片已确认：${isSelectionConfirmed(order) ? "是" : "否"}`,
    "确认尾款登记",
    {
      type: "warning",
      confirmButtonText: "确认登记尾款",
      cancelButtonText: "再核对一下",
    }
  ).then(() => confirmPaymentRegistration("finalPaid")).catch(() => {});
}
function cancelMoneyEdit() {
  state.moneyEdit = "";
  state.moneyDraft = 0;
  ElMessage.info("已取消本次金额调");
}
function openDispatchDialog(order = state.currentOrder) {
  if (!order) return;
  if (!canDispatchOrder(order)) return ElMessage.error(dispatchDisabledReason(order));
  state.currentOrder = order;
  state.dispatchForm = {
    photographerId: order.photographerId || "",
    appointmentAt: order.appointmentAt || order.date || "",
    timePeriod: order.timePeriod || order.time || "",
    appointmentLocation: order.appointmentLocation || order.shootLocation || order.location || order.spotName || "",
    peopleCount: Math.max(1, Number(order.peopleCount || order.participantCount || 1) || 1),
    note: "",
  };
  state.dispatchDialog = true;
}
async function confirmDispatchPhotographer() {
  const order = state.currentOrder;
  if (!order) return;
  if (!canDispatchOrder(order)) return ElMessage.error(dispatchDisabledReason(order));
  const form = state.dispatchForm;
  if (!form.photographerId) return ElMessage.warning("请选择摄影师");
  if (!String(form.appointmentAt || "").trim()) return ElMessage.warning("请填写确认拍摄时间");
  if (!String(form.appointmentLocation || "").trim()) return ElMessage.warning("请填写确认拍摄地点");
  if (!Number.isInteger(Number(form.peopleCount)) || Number(form.peopleCount) < 1) return ElMessage.warning("参与人数至少为 1 人");
  const previous = photographerDisplayName(order.photographerId);
  const next = photographerDisplayName(form.photographerId);
  const note = String(form.note || "").trim();
  const reason = note || "客服确认拍摄安排并派单";
  try {
    await persistOrderAction(order, "assign", {
      photographerId: form.photographerId,
      appointmentAt: String(form.appointmentAt).trim(),
      timePeriod: String(form.timePeriod || "").trim(),
      appointmentLocation: String(form.appointmentLocation).trim(),
      peopleCount: Number(form.peopleCount),
      reason
    });
    log("安排摄影", order.orderNo, `${previous} -> ${next}；时间：${form.appointmentAt}；地点：${form.appointmentLocation}；人数：${form.peopleCount}${note ? `；备注：${note}` : ""}`);
    state.dispatchDialog = false;
    ElMessage.success("摄影师已安排，操作已保存");
  } catch (_) {}
}
function openTransferDialog(order = state.currentOrder) {
  const isBatch = !order && selectedOrders.value.length > 0;
  if (!order && !isBatch) return ElMessage.warning("请先选择需要转派的订单");
  if (!isBatch && !canTransferOrder(order)) return ElMessage.error("当前订单无可执行的转派权");
  if (isBatch && !selectedOrders.value.some((item) => canTransferCustomerService(item) || canTransferPhotographer(item))) return ElMessage.error("已选订单暂无可转派");
  state.currentOrder = isBatch ? null : order;
  state.transferForm = {
    assigneeId: isBatch ? "" : order.assigneeId || "",
    photographerId: isBatch ? "" : order.photographerId || "",
    note: "",
    batch: isBatch,
  };
  state.transferDialog = true;
}
async function confirmTransferOrder() {
  const rows = state.transferForm.batch ? selectedOrders.value : [state.currentOrder].filter(Boolean);
  if (!rows.length) return;
  let changed = 0;
  for (const order of rows) {
    const parts = [];
    const canService = canTransferCustomerService(order);
    const canPhoto = canTransferPhotographer(order);
    const nextAssigneeId = state.transferForm.assigneeId;
    const nextPhotographerId = state.transferForm.photographerId;
    if (canService && nextAssigneeId && nextAssigneeId !== order.assigneeId) {
      const previousService = staffName(order.assigneeId);
      const nextService = staffName(nextAssigneeId);
      parts.push(`转客服：${previousService} -> ${nextService}`);
    }
    if (canPhoto && nextPhotographerId && nextPhotographerId !== order.photographerId) {
      const previousPhoto = photographerDisplayName(order.photographerId);
      const nextPhoto = photographerDisplayName(nextPhotographerId);
      parts.push(`转摄影师 ${previousPhoto} -> ${nextPhoto}`);
    }
    if (parts.length) {
      const note = state.transferForm.note ? `；原因：${state.transferForm.note}` : "";
      const text = `${parts.join("")}${note}`;
      try {
        const fields = {};
        if (canService && nextAssigneeId && nextAssigneeId !== order.assigneeId) fields.assigneeId = nextAssigneeId;
        if (canPhoto && nextPhotographerId && nextPhotographerId !== order.photographerId) fields.photographerId = nextPhotographerId;
        await persistOrderAction(order, "update", { fields, reason: text });
        log("订单转派", order.orderNo, text, currentOperatorName(), { module: "订单履约", level: "", objectType: "订单", objectName: order.orderNo });
        changed += 1;
      } catch (_) {}
    }
  }
  if (!changed) {
    return ElMessage.warning("请选择新的客服或摄影师");
  }
  state.transferDialog = false;
  state.selectedOrderIds = [];
  ElMessage.success(`已完"${changed} 单转派，并写入操作时间线`);
}
function openRescheduleDialog(order = state.currentOrder) {
  if (!order) return;
  if (!canRescheduleOrder(order)) return ElMessage.error("拍摄开始后不可在客服处理页改期，请走售后或异常流程");
  state.currentOrder = order;
  state.rescheduleForm = {
    appointmentAt: order.appointmentAt || "",
    timePeriod: order.timePeriod || "待客服确",
    reason: "",
  };
  state.rescheduleDialog = true;
}
async function confirmReschedule() {
  const order = state.currentOrder;
  if (!order) return;
  if (!canRescheduleOrder(order)) return ElMessage.error("拍摄开始后不可在客服处理页改期，请走售后或异常流程");
  if (!state.rescheduleForm.appointmentAt) return ElMessage.warning("请选择新的拍摄时间");
  const previous = `${order.appointmentAt || "-"} ${order.timePeriod || ""}`.trim();
  const next = `${state.rescheduleForm.appointmentAt} ${state.rescheduleForm.timePeriod || ""}`.trim();
  const reason = state.rescheduleForm.reason ? `；原因：${state.rescheduleForm.reason}` : "";
  try {
    await persistOrderAction(order, "reschedule", { appointmentAt: state.rescheduleForm.appointmentAt, timePeriod: state.rescheduleForm.timePeriod || "待客服确认", reason: reason || "客服调整拍摄时间" });
    log("改期拍摄", order.orderNo, `${previous} -> ${next}${reason}`);
    state.rescheduleDialog = false;
    ElMessage.success("拍摄时间已改期，操作已保存");
  } catch (_) {}
}
async function recordScheduleChange() {
  if (!state.currentOrder) return;
  if (!canEditOrder()) return ElMessage.error("当前角色无权修改预约时间");
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能修改预约时间");
  try {
    await persistOrderAction(state.currentOrder, "reschedule", { appointmentAt: state.currentOrder.appointmentAt, timePeriod: state.currentOrder.timePeriod || "待客服确认", reason: "客服确认预约时间" });
    ElMessage.success("预约时间改动已保存");
  } catch (_) {}
}

function canOperateShootStage(order) {
  if (!order || isOrderAfterSaleLocked(order) || isOrderCancelledStatus(order) || isOrderCompletedStatus(order)) return false;
  if (state.role === "photo") {
    return can("shootUpdate") && String(order.photographerId || "") === String(roleProfile.value.staffId || "");
  }
  return canEditCurrentOrder() && !state.orderReadonly;
}

async function acceptOrder(order = state.currentOrder) {
  if (!canAcceptOrder(order)) return ElMessage.warning("当前订单无需重复接单或暂不可接单");
  try {
    await persistOrderAction(order, "accept", { reason: "客服已接单并开始联系客户" });
    log("客服接单", order.orderNo, "已接单，等待订金到账确认");
    ElMessage.success("已接单，后续等待订金到账确认");
  } catch (_) {}
}

async function startShooting(order = state.currentOrder) {
  if (!canStartTask(order)) return ElMessage.warning("当前订单未完成派单或已开始拍摄");
  try {
    await persistOrderAction(order, "start", { reason: "摄影师开始拍摄服务" });
    log("开始拍摄", order.orderNo, "摄影师已开始拍摄");
    ElMessage.success("已记录开始拍摄");
  } catch (_) {}
}

async function completeShooting(order = state.currentOrder) {
  if (!canCompleteTask(order)) return ElMessage.warning("只有拍摄中的订单可以登记拍摄完成");
  try {
    await persistOrderAction(order, "shootcomplete", { reason: "摄影师已完成拍摄，等待线下选片确认" });
    log("拍摄完成", order.orderNo, "拍摄已完成，等待线下选片确认");
    ElMessage.success("已记录拍摄完成，等待线下选片确认");
  } catch (_) {}
}

function canConfirmOfflineSelection(order = state.currentOrder) {
  return !!order && canOperateShootStage(order)
    && workflowStageOf(order) === WORKFLOW_STAGES.SELECTION_PENDING;
}

function confirmOfflineSelection(order = state.currentOrder) {
  if (!canConfirmOfflineSelection(order)) return ElMessage.warning("拍摄完成后才能登记线下选片确认");
  ElMessageBox.confirm("确认已完成线下选片并允许登记成片交付？该操作会写入订单时间线。", "确认线下选片", {
    type: "warning",
    confirmButtonText: "确认选片",
    cancelButtonText: "暂不确认",
  }).then(async () => {
    try {
      await persistOrderAction(order, "selectionconfirm", { reason: "线下选片已确认，等待登记成片交付" });
      log("线下选片确认", order.orderNo, "已确认线下选片，等待登记成片交付");
      ElMessage.success("已确认线下选片，可继续登记成片交付");
    } catch (_) {}
  }).catch(() => {});
}

function canDeliverOrder(order = state.currentOrder) {
  return !!order && canOperateShootStage(order) && isSelectionConfirmed(order) && !hasDeliveryRecord(order);
}

function deliverOrder(order = state.currentOrder) {
  if (!canDeliverOrder(order)) return ElMessage.warning("请先完成线下选片确认后再登记交付");
  ElMessageBox.confirm("确认成片已通过企业微信交付给客户？交付记录完成后将开放尾款登记。", "登记成片交付", {
    type: "warning",
    confirmButtonText: "确认交付",
    cancelButtonText: "暂不交付",
  }).then(async () => {
    try {
      await persistOrderAction(order, "deliver", {
        deliveryMethod: "企业微信",
        reason: "成片已通过企业微信交付客户"
      });
      log("成片交付", order.orderNo, "已通过企业微信登记成片交付");
      ElMessage.success("已登记成片交付");
    } catch (_) {}
  }).catch(() => {});
}

async function updateTaskStatus(order, status) {
  if (!can("shootUpdate")) return ElMessage.error("当前角色无权更新拍摄任务");
  if (status === "shooting") return startShooting(order);
  if (status === "completed") return completeShooting(order);
  return ElMessage.warning("请使用拍摄任务提供的专用履约操作");
}
function canStartTask(order) {
  return canOperateShootStage(order) && workflowStageOf(order) === WORKFLOW_STAGES.AWAITING_SHOOT;
}
function canCompleteTask(order) {
  return canOperateShootStage(order) && workflowStageOf(order) === WORKFLOW_STAGES.SHOOTING;
}
function canRejectTask(order) {
  return !!order && workflowStageOf(order) === WORKFLOW_STAGES.AWAITING_SHOOT
    && String(order.photographerId || "") === String(roleProfile.value.staffId || "")
    && !isOrderAfterSaleLocked(order);
}
function rejectTask(order) {
  if (!can("shootUpdate")) return ElMessage.error("当前角色无权处理拍摄任务");
  if (!canRejectTask(order)) return ElMessage.warning("当前任务不能取消接单，已完成、售后中或非本人任务不可取消接单");
  ElMessageBox.confirm(`确认取消接单 ${order.orderNo}？订单会退回客服待重新安排摄影师，不会取消客人订单。`, "取消接单确认", {
    type: "warning",
    confirmButtonText: "确认取消接单",
    cancelButtonText: "暂不取消",
  }).then(async () => {
    const photographer = staffName(order.photographerId);
    try {
      await persistOrderAction(order, "unassign", { reason: `${photographer} 取消接单` });
      log("摄影师取消接", order.orderNo, `${photographer} 取消接单，待客服重新派单`);
      ElMessage.success("已取消接单，订单已退回客服重新安排摄影师");
    } catch (_) {}
  }).catch(() => {});
}
function cancelOrder(order) {
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单售后处理中，暂不能取消订单");
  if (!can("cancelOrder")) return ElMessage.error("当前角色无权取消订单");
  if (isOrderCompletedStatus(order)) return ElMessage.warning("已完成订单不能取");
  ElMessageBox.confirm("取消订单后进入回收站。客服不能永久删除，只有超管可在回收站处理。是否继续？", "二次确认", { type: "warning", confirmButtonText: "确认取消订单", cancelButtonText: "暂不取消" }).then(async () => {
    try {
      await persistOrderAction(order, "cancel", { reason: "客服取消订单" });
      ctx.addTrashLocal?.({ id: `trash-${order.id}-${Date.now()}`, refId: order.id, type: "订单", name: order.orderNo, reason: "取消订单", time: LXMFormat.nowText(), operator: roleProfile.value.name, restorable: true });
      log("取消订单", order.orderNo, "订单进入回收站");
      state.orderDrawer = false;
      ElMessage.success("订单已取消并进入回收站");
    } catch (_) {}
  }).catch(() => {});
}

  return {
    WORKFLOW_STAGES,
    serviceFlowSteps,
    workflowStageOf,
    paymentDue,
    isPhaseConfirmed,
    serviceFlowIndex,
    serviceFlowCurrent,
    serviceFlowClass,
    serviceInternalStatusLabel,
    serviceCustomerStatusLabel,
    canAcceptOrder,
    acceptOrder,
    canDispatchOrder,
    canTransferCustomerService,
    canTransferPhotographer,
    canTransferOrder,
    canRescheduleOrder,
    defaultCustomerStatusForOrderStatus,
    canUseOrderExceptionTools,
    openOrderExceptionDialog,
    confirmOrderException,
    addOrderContact,
    serviceFlowBadgeClass,
    setServiceFlowStep,
    canSetServiceFlowStep,
    serviceFlowDisabledReason,
    dispatchDisabledReason,
    rescheduleDisabledReason,
    finalPaymentDisabledReason,
    canRegisterDepositPaymentAction,
    depositPaymentActionDisabledReason,
    canRegisterFinalPayment,
    isSelectionConfirmed,
    hasDeliveryRecord,
    canConfirmOfflineSelection,
    confirmOfflineSelection,
    canDeliverOrder,
    deliverOrder,
    canCompleteWorkflow,
    completeDisabledReason,
    cancelDisabledReason,
    setOrderStatus,
    openCompleteOrderDialog,
    confirmCompleteOrder,
    saveOrder,
    moneyFieldMeta,
    enableMoneyEdit,
    confirmMoneyEdit,
    confirmPaymentRegistration,
    confirmFinalPaymentWithCheck,
    cancelMoneyEdit,
    openDispatchDialog,
    confirmDispatchPhotographer,
    openTransferDialog,
    confirmTransferOrder,
    openRescheduleDialog,
    confirmReschedule,
    recordScheduleChange,
    updateTaskStatus,
    startShooting,
    completeShooting,
    canStartTask,
    canCompleteTask,
    canRejectTask,
    rejectTask,
    cancelOrder
  };
});
