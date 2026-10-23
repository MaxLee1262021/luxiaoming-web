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
    canManageOrderRecords,
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
    isCreatedBooking,
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
  AWAITING_DISPATCH: "reserved",
  AWAITING_SHOOT: "dispatch",
  SHOOTING: "shooting",
  SELECTION_PENDING: "shooting",
  AWAITING_DELIVERY: "shooting",
  AWAITING_FINAL_PAYMENT: "shooting",
  PAID: "completed",
  DELIVERED: "completed",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

const serviceFlowSteps = [
  { key: "reserved", label: "已预约", note: "定金已支付，等待客服安排摄影师" },
  { key: "dispatch", label: "待拍摄", note: "人工确认时间、地点后填写派单记录" },
  { key: "shoot", label: "拍摄中", note: "客服在确认摄影师到场后登记开始拍摄" },
  { key: "completed", label: "已完成", note: "尾款支付回调后自动完成，可继续补充交付记录" },
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
  if (!isCreatedBooking(order)) return "";
  const status = String(order.status || "").trim().toLowerCase();
  if (["cancelled", "canceled", "terminated", "deleted"].includes(status)) return WORKFLOW_STAGES.CANCELLED;
  if (status === "completed" || status === "paid" || order.businessStatus === "completed") return WORKFLOW_STAGES.COMPLETED;
  if (["shooting", "final_pending", "editing", "retouching"].includes(status) || order.shootingStartedAt || order.shootingCompletedAt) return WORKFLOW_STAGES.SHOOTING;
  if (status === "assigned" || order.dispatchRecord || order.dispatchStatus === "assigned" || order.photographerId) return WORKFLOW_STAGES.AWAITING_SHOOT;
  if (["deposit_paid", "reserved"].includes(status) || order.businessStatus === "reserved" || order.workflowStage === "awaiting_dispatch" || order.workflowStage === "reserved") return WORKFLOW_STAGES.AWAITING_DISPATCH;
  return isPhaseConfirmed(order, "deposit") || Number(order.depositPaid || 0) > 0 ? WORKFLOW_STAGES.AWAITING_DISPATCH : "";
}

function serviceFlowIndex(order) {
  const stage = workflowStageOf(order);
  if (stage === WORKFLOW_STAGES.COMPLETED) return 3;
  if (stage === WORKFLOW_STAGES.SHOOTING) return 2;
  if (stage === WORKFLOW_STAGES.AWAITING_SHOOT) return 1;
  if (stage === WORKFLOW_STAGES.AWAITING_DISPATCH) return 0;
  return -1;
}

function serviceFlowCurrent(order) {
  return serviceFlowSteps[serviceFlowIndex(order)] || { key: "", label: "-", note: "" };
}

function serviceFlowClass(index, order) {
  const current = serviceFlowIndex(order);
  return { done: index < current, active: index === current };
}

function serviceInternalStatusLabel(order) {
  if (!order) return "-";
  if (isOrderCancelledStatus(order)) return "已取消";
  if (workflowStageOf(order) === WORKFLOW_STAGES.COMPLETED) return "已完成";
  return serviceFlowCurrent(order).label;
}

function serviceCustomerStatusLabel(order) {
  if (!order) return "-";
  if (!isCreatedBooking(order)) return "-";
  const customerStatus = String(order.customerStatus || "").trim();
  if (["已预约", "待拍摄", "拍摄中", "已完成", "已取消"].includes(customerStatus)) return customerStatus;
  const stage = workflowStageOf(order);
  if (isOrderCompletedStatus(order) || order.businessStatus === "completed") return "已完成";
  if (stage === WORKFLOW_STAGES.SHOOTING) return "拍摄中";
  if (isSelectionConfirmed(order) || order.shootingCompletedAt || hasDeliveryRecord(order)) return "已预约";
  if (isPhaseConfirmed(order, "deposit") || [WORKFLOW_STAGES.AWAITING_DISPATCH, WORKFLOW_STAGES.AWAITING_SHOOT].includes(stage)) return stage === WORKFLOW_STAGES.AWAITING_SHOOT ? "待拍摄" : "已预约";
  return (LXM_CONFIG.visibleStatus.find((item) => item.value === customerStatus) || {}).label
    || customerStatus
    || statusMeta(order.status).customer
    || "-";
}

function canAcceptOrder() { return false; }

function canDispatchOrder(order = state.currentOrder) {
  return !!order && canEditCurrentOrder(order) && !state.orderReadonly && !isOrderAfterSaleLocked(order)
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
    && [WORKFLOW_STAGES.AWAITING_DISPATCH, WORKFLOW_STAGES.AWAITING_SHOOT].includes(workflowStageOf(order));
}
function defaultCustomerStatusForOrderStatus(status) {
  const map = {
    reserved: "已预约", deposit_paid: "已预约", assigned: "待拍摄",
    awaiting_shoot: "待拍摄", shooting: "拍摄中", retouching: "拍摄中",
    delivered: "拍摄中", final_pending: "拍摄中", paid: "已完成",
    completed: "已完成", cancelled: "已取消", canceled: "已取消",
  };
  return map[status] || "";
}
function canUseOrderExceptionTools(order = state.currentOrder) {
  return !!order && state.role === "super" && !state.orderReadonly;
}
function openOrderExceptionDialog(order = state.currentOrder) {
  if (!canUseOrderExceptionTools(order)) return ElMessage.error("只有超管可以使用订单异常处理");
  state.currentOrder = order;
  state.exceptionForm = {
    status: order.status || "deposit_paid",
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
  if (!canSetServiceFlowStep(step, order)) return ElMessage.info(serviceFlowDisabledReason(step, order));
  if (step.key === "dispatch") return openDispatchDialog(order);
  if (step.key === "shoot") return startShooting(order);
}
function canSetServiceFlowStep(step, order = state.currentOrder) {
  if (!step || !order || !canEditCurrentOrder() || state.orderReadonly || isOrderAfterSaleLocked(order)) return false;
  const current = serviceFlowIndex(order);
  const target = serviceFlowSteps.findIndex((item) => item.key === step.key);
  const stage = workflowStageOf(order);
  if (step.key === "dispatch") return stage === WORKFLOW_STAGES.AWAITING_DISPATCH && canDispatchOrder(order);
  if (step.key === "shoot") return stage === WORKFLOW_STAGES.AWAITING_SHOOT && canStartTask(order);
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
  const stage = workflowStageOf(order);
  if (step.key === "reserved") return "定金已支付，等待客服安排摄影师";
  if (step.key === "dispatch") return "等待客服确认拍摄安排";
  if (step.key === "shoot" && stage !== WORKFLOW_STAGES.AWAITING_SHOOT) return "请先完成派单后再开始拍摄";
  if (step.key === "completed") return "尾款支付回调后自动完成";
  return "";
}
function dispatchDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权安排摄影";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能安排或改派摄影师";
  if (workflowStageOf(order) !== WORKFLOW_STAGES.AWAITING_DISPATCH) return "订单当前不在待派单阶段";
  return "";
}
function rescheduleDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权改期";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能改期拍摄";
  if (![WORKFLOW_STAGES.AWAITING_DISPATCH, WORKFLOW_STAGES.AWAITING_SHOOT].includes(workflowStageOf(order))) return "拍摄开始后需走异常或售后流程调整";
  return "";
}
function isSelectionConfirmed(order = state.currentOrder) {
  return !!order && (String(order.selectionStatus || "").toLowerCase() === "confirmed" || !!order.selectionConfirmedAt);
}
function canRegisterDepositPaymentAction(order = state.currentOrder) {
  return false;
}
function depositPaymentActionDisabledReason() { return "定金由游客支付，支付回调自动确认到账"; }
function canRegisterFinalPayment(order = state.currentOrder) {
  return false;
}
function finalPaymentDisabledReason() { return "拍摄中游客可支付尾款，回调后自动完成订单"; }
function hasDeliveryRecord(order = state.currentOrder) {
  return !!order && (!!order.deliveryRecord || !!order.deliveredAt || !!order.deliveryRecords?.length);
}
function canCompleteWorkflow(order = state.currentOrder) {
  return false;
}
function completeDisabledReason() { return "订单由尾款支付回调自动完成，后台不能手动改为完成"; }
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
function openCompleteOrderDialog() { return ElMessage.info(completeDisabledReason()); }
function confirmCompleteOrder() { return ElMessage.info(completeDisabledReason()); }
async function saveOrder() {
  if (!canEditCurrentOrder()) return ElMessage.error("请先领取订单；已完成订单仅可补充交付或跟进记录");
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能保存客服处理信息");
  if (!String(state.currentOrder?.customer || "").trim() || !String(state.currentOrder?.phone || "").trim()) return ElMessage.warning("请先填写客户姓名和手机号");
  const original = JSON.parse(JSON.stringify(state.currentOrder));
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
  if (!canEditCurrentOrder()) return ElMessage.error("请先领取订单后调整商品或优惠");
  if (!["couponAmount", "totalAmount"].includes(field)) return ElMessage.warning("已收款金额由支付回调记录，不可编辑");
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
async function confirmPaymentRegistration() { return ElMessage.info("收款由微信支付回调确认，后台不登记收款状态"); }
function confirmFinalPaymentWithCheck() { return ElMessage.info(finalPaymentDisabledReason()); }
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
    confirmationMethod: order.dispatchRecord?.confirmationMethod || "",
    customerConfirmationNote: order.dispatchRecord?.customerConfirmationNote || "",
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
  if (!String(form.confirmationMethod || "").trim()) return ElMessage.warning("请选择与游客确认的沟通方式");
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
      confirmationMethod: String(form.confirmationMethod).trim(),
      customerConfirmationNote: String(form.customerConfirmationNote || "").trim(),
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
        if (canService && nextAssigneeId && nextAssigneeId !== order.assigneeId) await persistOrderAction(order, "transfer", { assigneeId: nextAssigneeId, reason: text });
        if (canPhoto && nextPhotographerId && nextPhotographerId !== order.photographerId) await persistOrderAction(order, "assign", { photographerId: nextPhotographerId, reason: text });
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
  return ["service", "super"].includes(state.role) && canEditCurrentOrder() && !state.orderReadonly;
}

function openServiceConfirmationDialog() { return ElMessage.info("预约订单在客人支付定金后自动创建"); }
function confirmServiceConfirmation() { return openServiceConfirmationDialog(); }
function acceptOrder() { return openServiceConfirmationDialog(); }

async function startShooting(order = state.currentOrder) {
  if (!canStartTask(order)) return ElMessage.warning("当前订单未完成派单或已开始拍摄");
  try {
    await persistOrderAction(order, "start", { reason: "客服确认摄影师已到场，开始拍摄" });
    log("开始拍摄", order.orderNo, "客服确认摄影师到场并开始拍摄");
    ElMessage.success("已记录开始拍摄");
  } catch (_) {}
}

async function completeShooting(order = state.currentOrder) {
  return ElMessage.info("拍摄完成由客服在交付/跟进记录中维护，支付回调负责完成订单主状态");
}

function canConfirmOfflineSelection(order = state.currentOrder) {
  return false;
}

function confirmOfflineSelection() { return ElMessage.info("本版无需选片确认，尾款从拍摄中开放"); }
function canDeliverOrder(order = state.currentOrder) {
  return canManageOrderRecords(order) && !state.orderReadonly
    && [WORKFLOW_STAGES.SHOOTING, WORKFLOW_STAGES.COMPLETED].includes(workflowStageOf(order));
}

function deliverOrder() { return ElMessage.info("请使用独立交付记录表单登记交付"); }
async function updateTaskStatus(order, status) {
  return ElMessage.warning("摄影师任务台仅供查看，拍摄状态由客服在订单管理中登记");
}
function taskStatusOf(order = {}) {
  return String(order && order.taskStatus || "pending_acceptance").trim().toLowerCase() || "pending_acceptance";
}
function isOwnPhotographyTask(order = {}) {
  return state.role === "photo"
    && String(order && order.photographerId || "") === String(roleProfile.value.staffId || "");
}
function isTaskDrawerReadonly(order = {}) {
  return !!(state.orderReadonly && state.orderDrawer && state.currentOrder === order);
}
function canAcceptTask(order) {
  return false;
}
async function acceptTask(order) {
  if (!canAcceptTask(order)) return ElMessage.warning("当前任务不能接受，请确认任务仍归属本人且未冻结");
  try {
    await persistOrderAction(order, "taskaccept", { reason: "摄影师已接受拍摄任务" });
    log("摄影师接受任务", order.orderNo, "已接受任务，可按确认安排开始拍摄");
    ElMessage.success("已接受拍摄任务");
  } catch (_) {}
}
function canStartTask(order) {
  return !!order && canManageOrderRecords(order) && !state.orderReadonly
    && !isOrderAfterSaleLocked(order) && workflowStageOf(order) === WORKFLOW_STAGES.AWAITING_SHOOT;
}
function canCompleteTask(order) {
  return false;
}
function canRejectTask(order) {
  return false;
}
function rejectTask(order) {
  if (!can("shootUpdate")) return ElMessage.error("当前角色无权处理拍摄任务");
  if (!canRejectTask(order)) return ElMessage.warning("当前任务不能标记无法履约，售后中、已开拍或非本人任务不可操作");
  ElMessageBox.prompt(`请说明无法履约原因。订单 ${order.orderNo} 会退回客服待重新安排摄影师，不会取消客户订单。`, "标记无法履约", {
    type: "warning",
    confirmButtonText: "确认无法履约",
    cancelButtonText: "暂不提交",
    inputPlaceholder: "例如档期冲突、身体原因、设备故障",
    inputValidator: (value) => String(value || "").trim().length >= 2 || "请填写至少 2 个字的原因",
  }).then(async ({ value }) => {
    const photographer = staffName(order.photographerId);
    try {
      const reason = String(value || "").trim();
      await persistOrderAction(order, "unable", { reason: `${photographer} 无法履约：${reason}` });
      log("摄影师无法履约", order.orderNo, `${photographer} 无法履约，待客服重新派单`);
      ElMessage.success("已标记无法履约，订单已退回客服重新安排摄影师");
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
    openServiceConfirmationDialog,
    confirmServiceConfirmation,
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
    taskStatusOf,
    canAcceptTask,
    acceptTask,
    startShooting,
    completeShooting,
    canStartTask,
    canCompleteTask,
    canRejectTask,
    rejectTask,
    cancelOrder
  };
});
