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
    isOrderAfterSaleLocked,
    log,
    money,
    orderSourceName,
    orderSourceType,
    orderSourceTypeText,
    paid,
    photographerDisplayName,
    roleProfile,
    selectedOrders,
    serviceOwnerName,
    shopName,
    staffName,
    state,
    statusMeta
  } = ctx;

const serviceFlowSteps = [
  { key: "pending", label: "待确", status: "pending", customerStatus: "reserved", note: "待客服联系客人确认拍摄日期、时间、地点和需求" },
  { key: "confirmed", label: "已接", status: "confirmed", customerStatus: "confirmed", note: "客服已确认预约信息，可继续安排摄影师和拍摄任务" },
  { key: "shooting", label: "拍摄", status: "shooting", customerStatus: "shooting", note: "订单进入拍摄履约阶段，继续跟进成片交付" },
  { key: "delivered", label: "已交", status: "shooting", customerStatus: "done", note: "成片已交付给客人，可继续核对收款、售后与交付记录" },
];
function serviceFlowIndex(order) {
  if (!order) return 0;
  if (order.status === "completed") return 3;
  if (["done", "delivered"].includes(order.customerStatus)) return 3;
  if (order.status === "shooting") return 2;
  if (order.status === "confirmed") return 1;
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
  if (order.status === "completed") return "已完";
  if (["done", "delivered"].includes(order.customerStatus)) return "已交";
  return serviceFlowCurrent(order).label;
}
function serviceCustomerStatusLabel(order) {
  if (!order) return "-";
  if (["done", "delivered"].includes(order.customerStatus)) return "已完";
  return (LXM_CONFIG.visibleStatus.find((s) => s.value === order.customerStatus) || {}).label || statusMeta(order.status).customer || "-";
}
function canDispatchOrder(order = state.currentOrder) {
  return !!order && canEditCurrentOrder() && ["pending", "confirmed"].includes(order.status) && !["done", "delivered"].includes(order.customerStatus);
}
function canTransferCustomerService(order = state.currentOrder) {
  if (!order && state.transferForm.batch) return selectedOrders.value.some((item) => canTransferCustomerService(item));
  if (!order || state.orderReadonly || isOrderAfterSaleLocked(order)) return false;
  if (state.role === "super") return !["completed", "cancelled"].includes(order.status);
  return state.role === "service" && order.assigneeId === roleProfile.value.staffId && !["completed", "cancelled"].includes(order.status);
}
function canTransferPhotographer(order = state.currentOrder) {
  if (!order && state.transferForm.batch) return selectedOrders.value.some((item) => canTransferPhotographer(item));
  return !!order && state.role === "super" && !state.orderReadonly && !isOrderAfterSaleLocked(order) && !["completed", "cancelled"].includes(order.status);
}
function canTransferOrder(order = state.currentOrder) {
  if (!order && selectedOrders.value?.length) return selectedOrders.value.some((item) => canTransferCustomerService(item) || canTransferPhotographer(item));
  return canTransferCustomerService(order) || canTransferPhotographer(order);
}
function canRescheduleOrder(order = state.currentOrder) {
  return !!order && canEditCurrentOrder() && ["pending", "confirmed"].includes(order.status) && !["done", "delivered"].includes(order.customerStatus);
}
function defaultCustomerStatusForOrderStatus(status) {
  const map = {
    pending: "reserved",
    confirmed: "confirmed",
    shooting: "shooting",
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
function confirmOrderException() {
  const order = state.currentOrder;
  const form = state.exceptionForm;
  if (!canUseOrderExceptionTools(order)) return ElMessage.error("只有超管可以提交异常处理");
  if (!String(form.reason || "").trim()) return ElMessage.warning("请填写异常处理原因，便于后续审计追溯");
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
  addOrderTimeline(order, text, currentOperatorName());
  log("订单异常处理", order.orderNo, text, currentOperatorName(), { module: "订单履约", level: "", objectType: "订单", objectName: order.orderNo, snapshot: JSON.stringify({ before, after }) });
  state.exceptionDialog = false;
  ElMessage.success("异常处理已完成，并写入审计日");
}
function addOrderContact(type) {
  const order = state.currentOrder;
  if (!order) return;
  if (!canEditCurrentOrder()) return ElMessage.error("当前订单不能新增联系方式");
  const key = type === "phone" ? "phone" : "wechat";
  const listKey = type === "phone" ? "extraPhones" : "extraWechats";
  const label = type === "phone" ? "手机" : "微信";
  const value = String(state.contactDraft[key] || "").trim();
  if (!value) return ElMessage.warning(`请填写新${label}`);
  order[listKey] = order[listKey] || [];
  if ([order[key], ...order[listKey]].filter(Boolean).includes(value)) return ElMessage.warning(`${label}已存在`);
  order[listKey].push(value);
  state.contactDraft[key] = "";
  addOrderTimeline(order, `新增客户${label}：${value}`, currentOperatorName());
  ElMessage.success(`已新增${label}`);
}
function serviceFlowBadgeClass(order, type) {
  if (!order) return "";
  if (order.status === "completed") return "completed";
  if (type === "customer" && ["done", "delivered"].includes(order.customerStatus)) return "delivered";
  if (["done", "delivered"].includes(order.customerStatus)) return "delivered";
  return order.status || "";
}
function setServiceFlowStep(step) {
  if (!step) return;
  if (!canSetServiceFlowStep(step, state.currentOrder)) return ElMessage.warning(serviceFlowDisabledReason(step, state.currentOrder) || "当前状态不能重复点击或跳转，请按订单流程顺序推");
  setOrderStatus(step.status, step.customerStatus, `客服处理状态更新：${step.label} ${step.note}`);
}
function canSetServiceFlowStep(step, order = state.currentOrder) {
  if (!step || !order || !canEditCurrentOrder()) return false;
  if (isOrderAfterSaleLocked(order)) return false;
  const current = serviceFlowIndex(order);
  const target = serviceFlowSteps.findIndex((item) => item.key === step.key);
  if (step.key === "delivered" && !canCompleteOrderPayment(order)) return false;
  return target === current + 1;
}
function serviceFlowDisabledReason(step, order = state.currentOrder) {
  if (!step || !order) return "暂无订单";
  if (!canEditOrder()) return "当前角色没有推进订单状态权";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，订单状态已锁定";
  if (order.status === "completed") return "订单已完成，不能重复推进";
  const current = serviceFlowIndex(order);
  const target = serviceFlowSteps.findIndex((item) => item.key === step.key);
  if (target <= current) return "当前或历史状态不能重复点";
  if (target > current + 1) return "请按订单流程顺序推进";
  if (step.key === "delivered" && !canCompleteOrderPayment(order)) return "尾款必须财务审核通过后，才能标记已交";
  return "";
}
function dispatchDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权安排摄影";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能安排或改派摄影师";
  if (!["pending", "confirmed"].includes(order.status) || ["done", "delivered"].includes(order.customerStatus)) return "拍摄开始后普通客服不能改派摄影师";
  return "";
}
function rescheduleDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权改期";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能改期拍摄";
  if (!["pending", "confirmed"].includes(order.status) || ["done", "delivered"].includes(order.customerStatus)) return "拍摄中或已交付订单需超管异常流程处理";
  return "";
}
function finalPaymentDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditCurrentOrder()) return "当前订单不可登记尾款";
  if (expectedFinalAmount(order) <= 0) return "当前没有需要登记的应收尾款";
  if (!isDepositRegistrationConfirmed(order)) return "定金必须财务审核通过后才能确认尾";
  if (["待审", "已审"].includes(order.finalFinanceStatus)) return "尾款已提交或已通过财务审核";
  return "";
}
function completeDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!canEditOrder()) return "当前角色无权完成订单";
  if (state.orderReadonly) return "当前为只读查看模";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能完成订单";
  if (order.status === "completed") return "订单已完成，不能重复操作";
  if (!isDepositRegistrationConfirmed(order)) return "定金必须财务审核通过";
  if (!canCompleteOrderPayment(order)) return "尾款必须财务审核通过";
  return "";
}
function cancelDisabledReason(order = state.currentOrder) {
  if (!order) return "暂无订单";
  if (!can("cancelOrder")) return "当前角色无权取消订单";
  if (!canEditCurrentOrder()) return "当前订单不可取消";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，不能取消订单";
  if (order.status === "completed") return "已完成订单只能通过售后退款和财务冲正处理";
  return "";
}
function setOrderStatus(status, customerStatus, label) {
  if (!state.currentOrder) return;
  if (!canEditOrder()) return ElMessage.error("当前角色无权编辑客服处理状");
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能更改订单状");
  state.currentOrder.status = status;
  state.currentOrder.customerStatus = customerStatus;
  addFollowLog(label || `订单状态更新为 ${statusMeta(status).label}`);
}
function openCompleteOrderDialog(order = state.currentOrder) {
  if (!order) return;
  if (!canEditOrder()) return ElMessage.error("当前角色无权完成订单");
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单售后处理中，暂不能完成订单");
  if (!isDepositRegistrationConfirmed(order)) return ElMessage.warning("请先完成定金财务审核，审核通过后才能完成订");
  if (!canCompleteOrderPayment(order)) return ElMessage.warning("请先完成尾款财务审核，审核通过后才能完成订");
  state.currentOrder = order;
  state.completeOrderNote = "";
  state.completeOrderDialog = true;
}
function confirmCompleteOrder() {
  const order = state.currentOrder;
  if (!order) return;
  if (!canEditOrder()) return ElMessage.error("当前角色无权完成订单");
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单售后处理中，暂不能完成订单");
  if (!isDepositRegistrationConfirmed(order)) {
    ElMessage.warning("请先完成定金财务审核，审核通过后才能完成订");
    return;
  }
  if (!canCompleteOrderPayment(order)) {
    ElMessage.warning("请先完成尾款财务审核，审核通过后才能完成订");
    return;
  }
  const tailGap = finalGap(order);
  if (expectedFinalAmount(order) > 0 && Number(order.finalPaid || 0) <= 0) {
    ElMessage.warning("请先完成尾款财务审核，再提交订单完成");
    return;
  }
  const finishOrder = () => {
  order.status = "completed";
  order.customerStatus = "done";
  const note = state.completeOrderNote ? `；核对备注：${state.completeOrderNote}` : "";
  const pendingText = tailGap > 0 ? `；尾款差"${money(tailGap)}，需继续跟进或添加优惠券登记优惠原因` : "";
  addOrderTimeline(order, `订单完成确认：客服已核对交付，财务需复核收款${pendingText}${note}`);
  log("订单完成", order.orderNo, `客服登记实收 ${money(paid(order))}，财务待审核入账 ${money(financePendingAmount(order))}`);
  state.completeOrderDialog = false;
  state.completeOrderNote = "";
  ElMessage.success("订单已完成；未通过财务审核的金额不会进入月度对");
  };
  if (tailGap > 0) {
    ElMessageBox.confirm(`当前应收尾款 ${money(expectedFinalAmount(order))}，客服已登记尾款 ${money(order.finalPaid)}，仍有尾款差"${money(tailGap)}。若是优惠，请先添加优惠券填写优惠原因；若确认仍要完成订单，将在时间线记录该差额。是否继续？`, "尾款未对平确", {
      type: "warning",
      confirmButtonText: "确认完成",
      cancelButtonText: "返回核对",
    }).then(finishOrder).catch(() => {});
    return;
  }
  finishOrder();
}
function saveOrder() {
  if (!canEditOrder()) return ElMessage.error("当前角色无权保存客服处理信息");
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能保存客服处理信息");
  if (!String(state.currentOrder?.customer || "").trim() || !String(state.currentOrder?.phone || "").trim()) return ElMessage.warning("请先填写客户姓名和手机号");
  if (state.role === "service" && !state.currentOrder.assigneeId) state.currentOrder.assigneeId = roleProfile.value.staffId || state.currentStaffId || "";
  state.saving = true;
  setTimeout(() => {
    state.saving = false;
    if (state.currentOrder) {
      state.currentOrder.totalAmount = Number(state.currentOrder.totalAmount || 0);
      state.currentOrder.depositPaid = Number(state.currentOrder.depositPaid || 0);
      state.currentOrder.finalPaid = Number(state.currentOrder.finalPaid || 0);
      state.moneyEdit = "";
      state.moneyDraft = 0;
      addOrderTimeline(state.currentOrder, `确认客户信息，待"${money(due(state.currentOrder))}`);
      log("确认客户信息", state.currentOrder.orderNo, `状态：${statusMeta(state.currentOrder.status).label}，负责客服：${serviceOwnerName(state.currentOrder)}，待收：${money(due(state.currentOrder))}`);
    }
    ElMessage.success("客户信息已确认，操作日志已记");
  }, 220);
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
function confirmMoneyEdit(field) {
  if (!state.currentOrder) return;
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能调整金额");
  const meta = moneyFieldMeta(field);
  const next = Number(state.moneyDraft || 0);
  if (!state.currentOrder.priceAdjustReason) return ElMessage.warning(`请先填写${meta.reason}`);
  const previous = field === "couponAmount" ? Number(state.currentOrder.finalDiscountAmount || 0) : Number(state.currentOrder[field] || 0);
  if (field !== "couponAmount") state.currentOrder[field] = next;
  if (field === "couponAmount") {
    const maxCoupon = Math.max(Number(state.currentOrder.totalAmount || 0) - Number(state.currentOrder.depositPaid || 0), 0);
    if (next > maxCoupon) return ElMessage.warning(`优惠券金额不能超过当前可优惠金额 ${money(maxCoupon)}`);
    state.currentOrder.finalDiscountAmount = next;
    state.currentOrder.finalDiscountReason = state.currentOrder.priceAdjustReason;
    if (!["待审", "已审"].includes(state.currentOrder.finalFinanceStatus)) {
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
  addOrderTimeline(state.currentOrder, `确认${meta.label}调整 ${money(previous)} 调整为 ${money(next)}${discountText}；原因：${state.currentOrder.priceAdjustReason}`);
  ElMessage.success(`${meta.label}已确认修改`);
}
function confirmPaymentRegistration(field) {
  const order = state.currentOrder;
  if (!order) return;
  if (!canEditCurrentOrder()) return ElMessage.error("当前状态不能登记收");
  if (field === "finalPaid" && !isDepositRegistrationConfirmed(order)) {
    return ElMessage.warning("请先完成定金财务审核，审核通过后才能确认尾");
  }
  const statusField = field === "depositPaid" ? "depositFinanceStatus" : "finalFinanceStatus";
  const timeField = field === "depositPaid" ? "depositPaidAt" : "finalPaidAt";
  if (order[statusField] === "待审") return ElMessage.warning(`${moneyFieldMeta(field).label}已提交财务审核，请等待财务确认`);
  if (order[statusField] === "已审") return ElMessage.warning(`${moneyFieldMeta(field).label}已通过财务审核，如需修改请点击改价并填写原因`);
  if (field === "finalPaid") {
    order.finalPaid = expectedFinalAmount(order);
  }
  const amount = Number(order[field] || 0);
  if (amount <= 0) return ElMessage.warning(`请先填写${moneyFieldMeta(field).label}金额`);
  if (field === "finalPaid" && finalGap(order) > 0) return ElMessage.warning(`尾款差额仍有 ${money(finalGap(order))}，请先添加优惠券或重新核对应收尾款`);
  order[statusField] = "待审";
  order[timeField] = LXMFormat.nowText();
  addOrderTimeline(order, `客服确认登记${moneyFieldMeta(field).label} ${money(amount)}，待财务审核`, currentOperatorName());
  log("登记收款", order.orderNo, `${moneyFieldMeta(field).label} ${money(amount)} 待财务审核`);
  ElMessage.success(`${moneyFieldMeta(field).label}已登记，待财务审核确认`);
}
function confirmFinalPaymentWithCheck() {
  const order = state.currentOrder;
  if (!order) return;
  if (!isDepositRegistrationConfirmed(order)) return ElMessage.warning("请先完成定金财务审核，审核通过后才能确认尾");
  const amount = expectedFinalAmount(order);
  if (amount <= 0) return ElMessage.warning("当前没有需要确认的应收尾款");
  ElMessageBox.confirm(
    `确认将本单应收尾款 ${money(amount)} 登记为已收尾款，并提交财务审核？\n订单总价 ${money(order.totalAmount)}\n已收定金 ${money(order.depositPaid)}\n优惠券减免：${money(order.finalDiscountAmount || 0)}`,
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
  if (!canDispatchOrder(order)) return ElMessage.error("拍摄开始后不可在客服处理页安排或改派摄影师");
  state.currentOrder = order;
  state.dispatchForm = {
    photographerId: order.photographerId || "",
    note: "",
  };
  state.dispatchDialog = true;
}
function confirmDispatchPhotographer() {
  const order = state.currentOrder;
  if (!order) return;
  if (!canDispatchOrder(order)) return ElMessage.error("拍摄开始后不可在客服处理页安排或改派摄影师");
  if (!state.dispatchForm.photographerId) return ElMessage.warning("请选择摄影");
  const previous = photographerDisplayName(order.photographerId);
  const next = photographerDisplayName(state.dispatchForm.photographerId);
  order.photographerId = state.dispatchForm.photographerId;
  if (order.status === "pending") {
    order.status = "confirmed";
    order.customerStatus = "confirmed";
  }
  const note = state.dispatchForm.note ? `；备注：${state.dispatchForm.note}` : "";
  addOrderTimeline(order, `安排摄影师：${previous} "${next}${note}`, currentOperatorName());
  log("安排摄影", order.orderNo, `${previous} "${next}${note}`);
  state.dispatchDialog = false;
  ElMessage.success("摄影师已安排，订单已留痕");
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
function confirmTransferOrder() {
  const rows = state.transferForm.batch ? selectedOrders.value : [state.currentOrder].filter(Boolean);
  if (!rows.length) return;
  let changed = 0;
  rows.forEach((order) => {
    const parts = [];
    if (canTransferCustomerService(order) && state.transferForm.assigneeId && state.transferForm.assigneeId !== order.assigneeId) {
      const previousService = staffName(order.assigneeId);
      const nextService = staffName(state.transferForm.assigneeId);
      order.assigneeId = state.transferForm.assigneeId;
      parts.push(`转客服：${previousService} -> ${nextService}`);
    }
    if (canTransferPhotographer(order) && state.transferForm.photographerId && state.transferForm.photographerId !== order.photographerId) {
      const previousPhoto = photographerDisplayName(order.photographerId);
      const nextPhoto = photographerDisplayName(state.transferForm.photographerId);
      order.photographerId = state.transferForm.photographerId;
      parts.push(`转摄影师 ${previousPhoto} -> ${nextPhoto}`);
    }
    if (parts.length) {
      const note = state.transferForm.note ? `；原因：${state.transferForm.note}` : "";
      const text = `${parts.join("")}${note}`;
      addOrderTimeline(order, text, currentOperatorName());
      log("订单转派", order.orderNo, text, currentOperatorName(), { module: "订单履约", level: "", objectType: "订单", objectName: order.orderNo });
      changed += 1;
    }
  });
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
function confirmReschedule() {
  const order = state.currentOrder;
  if (!order) return;
  if (!canRescheduleOrder(order)) return ElMessage.error("拍摄开始后不可在客服处理页改期，请走售后或异常流程");
  if (!state.rescheduleForm.appointmentAt) return ElMessage.warning("请选择新的拍摄时间");
  const previous = `${order.appointmentAt || "-"} ${order.timePeriod || ""}`.trim();
  order.appointmentAt = state.rescheduleForm.appointmentAt;
  order.timePeriod = state.rescheduleForm.timePeriod || "待客服确";
  const next = `${order.appointmentAt} ${order.timePeriod || ""}`.trim();
  const reason = state.rescheduleForm.reason ? `；原因：${state.rescheduleForm.reason}` : "";
  addOrderTimeline(order, `改期拍摄 ${previous} 调整为 ${next}${reason}`, currentOperatorName());
  log("改期拍摄", order.orderNo, `${previous} "${next}${reason}`);
  state.rescheduleDialog = false;
  ElMessage.success("拍摄时间已改期，操作日志已记");
}
function recordScheduleChange() {
  if (!state.currentOrder) return;
  if (!canEditOrder()) return ElMessage.error("当前角色无权修改预约时间");
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能修改预约时间");
  addOrderTimeline(state.currentOrder, `预约时间调整"${state.currentOrder.appointmentAt} ${state.currentOrder.timePeriod || ""}`.trim());
  ElMessage.success("预约时间改动已记");
}
function updateTaskStatus(order, status) {
  if (!can("shootUpdate")) return ElMessage.error("当前角色无权更新拍摄任务");
  if (status === "shooting" && !canStartTask(order)) return ElMessage.warning("当前订单不能重复开始拍摄，只有已接单且未开始的任务可以开始拍");
  if (status === "completed" && !canCompleteTask(order)) return ElMessage.warning("当前订单不能重复标记完成，只有拍摄中的任务可以标记完");
  order.status = status;
  if (status === "shooting") order.customerStatus = "shooting";
  if (status === "completed") order.customerStatus = "done";
  addOrderTimeline(order, `摄影师更新为 ${statusMeta(status).label}`);
  ElMessage.success("任务状态已更新");
}
function canStartTask(order) {
  return !!order && order.status === "confirmed" && !isOrderAfterSaleLocked(order);
}
function canCompleteTask(order) {
  return !!order && order.status === "shooting" && !isOrderAfterSaleLocked(order);
}
function canRejectTask(order) {
  return !!order && ["confirmed", "shooting"].includes(order.status) && order.photographerId === roleProfile.value.staffId && !isOrderAfterSaleLocked(order);
}
function rejectTask(order) {
  if (!can("shootUpdate")) return ElMessage.error("当前角色无权处理拍摄任务");
  if (!canRejectTask(order)) return ElMessage.warning("当前任务不能取消接单，已完成、售后中或非本人任务不可取消接单");
  ElMessageBox.confirm(`确认取消接单 ${order.orderNo}？订单会退回客服待重新安排摄影师，不会取消客人订单。`, "取消接单确认", {
    type: "warning",
    confirmButtonText: "确认取消接单",
    cancelButtonText: "暂不取消",
  }).then(() => {
    const photographer = staffName(order.photographerId);
    order.photographerId = "";
    order.status = "confirmed";
    order.customerStatus = "confirmed";
    addOrderTimeline(order, `${photographer} 取消接单，订单退回客服重新安排摄影师`, photographer);
    log("摄影师取消接", order.orderNo, `${photographer} 取消接单，待客服重新派单`);
    ElMessage.success("已取消接单，订单已退回客服重新安排摄影师");
  }).catch(() => {});
}
function cancelOrder(order) {
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单售后处理中，暂不能取消订单");
  if (!can("cancelOrder")) return ElMessage.error("当前角色无权取消订单");
  if (order.status === "completed") return ElMessage.warning("已完成订单不能取");
  ElMessageBox.confirm("取消订单后进入回收站。客服不能永久删除，只有超管可在回收站处理。是否继续？", "二次确认", { type: "warning", confirmButtonText: "确认取消订单", cancelButtonText: "暂不取消" }).then(() => {
    addOrderTimeline(order, "取消订单，订单进入回收站");
    order.deleted = true;
    order.status = "cancelled";
    state.trash.unshift({ id: `trash-${order.id}-${Date.now()}`, refId: order.id, type: "订单", name: order.orderNo, reason: "取消订单", time: LXMFormat.nowText(), operator: roleProfile.value.name, restorable: true });
    log("取消订单", order.orderNo, "订单进入回收");
    state.orderDrawer = false;
  }).catch(() => {});
}

  return {
    serviceFlowSteps,
    serviceFlowIndex,
    serviceFlowCurrent,
    serviceFlowClass,
    serviceInternalStatusLabel,
    serviceCustomerStatusLabel,
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
    canStartTask,
    canCompleteTask,
    canRejectTask,
    rejectTask,
    cancelOrder
  };
});
