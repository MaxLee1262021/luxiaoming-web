// 对账与结算核心
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    agentName,
    cityName,
    commission,
    commissionRateFor,
    commissionRateText,
    computed,
    confirmedRefund,
    currentOperatorName,
    data,
    distributorName,
    distributorRows,
    due,
    financeDue,
    financePaid,
    financePendingAmount,
    hasBlockingAfterSale,
    inDateRange,
    inRoleScope,
    isEstimatedReconciliationOrder,
    isOrderCancelledStatus,
    isOrderCompletedStatus,
    isReconciliationEligible,
    isRetainedCancelledOrder,
    isSettlementObservationPending,
    largeSettlementThreshold,
    log,
    money,
    netOrderAmount,
    normalizeDateText,
    normalizeReviewStatus,
    openOrderById,
    orderDistributorIds,
    orderShop,
    orderSplit,
    paid,
    photographers,
    retainedCancelledAmount,
    roleProfile,
    sameShop,
    scopedOrders,
    scopedShops,
    selectedOrders,
    services,
    shopName,
    staffName,
    state,
    statusMeta
  } = ctx;

function remoteReconciliationEnabled() {
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  return !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD && window.LXM_CLOUD.create && window.LXM_CLOUD.update
    && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
}
async function saveReconciliationRecord(key, row, mode = "create") {
  if (!remoteReconciliationEnabled()) return row;
  const id = row && (row.id || row._id);
  let payload = row;
  if (mode === "update") {
    const fields = key === "reconciliationTransfers"
      ? state.role === "finance"
        ? (row && row.status === "已封" ? ["status", "sealNote"] : ["payStatus", "voucherNo", "note"])
        : ["status", "payStatus", "paidBy", "paidAt", "sealedBy", "sealedAt", "sealNote", "unsealedBy", "unsealedAt", "unsealNote", "voucherNo", "note"]
      : key === "adjustmentRecords"
        ? ["approvalStatus", "approvedBy", "approvedAt", "note"]
        : ["status", "operator", "time", "note", "unlockedBy", "unlockedAt"];
    payload = Object.fromEntries(fields.filter((field) => row && row[field] !== undefined).map((field) => [field, row[field]]));
  }
  const saved = mode === "update"
    ? await window.LXM_CLOUD.update(key, id, payload)
    : await window.LXM_CLOUD.create(key, row);
  if (!saved || saved.error) throw new Error((saved && saved.error) || "财务记录保存失败");
  return saved;
}

function reconciliation(type) {
  let rows = [];
  if (type === "shop") rows = scopedShops.value;
  if (type === "agent") rows = data.agents.filter((a) => state.role !== "agent" || a.id === roleProfile.value.agentId);
  if (type === "distributor") rows = data.distributors.filter((d) => state.role !== "distributor" || d.id === roleProfile.value.distributorId);
  if (type === "service") rows = data.staff.filter((s) => s.role === "service");
  if (type === "photo") rows = data.staff.filter((s) => s.role === "photo");
  return rows.map((row) => {
    const allMatchedOrders = scopedOrders.value.filter((o) => {
      const shop = orderShop(o);
      if (type === "shop") return sameShop(o, row);
      if (type === "agent") return shop.agentId === row.id;
      if (type === "distributor") return o.distributorId === row.id || orderDistributorIds(o).includes(row.id);
      if (type === "service") return o.assigneeId === row.id;
      if (type === "photo") return o.photographerId === row.id;
      return false;
    });
    const orders = allMatchedOrders.filter(isReconciliationEligible);
      const pendingOrders = allMatchedOrders.filter((order) => !isOrderCompletedStatus(order) && !isReconciliationEligible(order) && !isRetainedCancelledOrder(order));
      const observationOrders = allMatchedOrders.filter((order) => isOrderCompletedStatus(order) && isSettlementObservationPending(order));
      const blockedOrders = allMatchedOrders.filter((order) => isOrderCompletedStatus(order) && !isSettlementObservationPending(order) && hasBlockingAfterSale(order));
    return {
      id: row.id,
      type,
      typeName: ({ shop: "商家", agent: "城市代理", distributor: "分销", service: "客服", photo: "摄影" })[type],
      name: row.name,
      totalOrders: allMatchedOrders.length,
      orders: orders.length,
      pendingOrders: pendingOrders.length,
      observationOrders: observationOrders.length,
      blockedOrders: blockedOrders.length,
      totalAmount: allMatchedOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0),
      pendingAmount: pendingOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0),
      observationAmount: observationOrders.reduce((s, o) => s + netOrderAmount(o), 0),
      blockedAmount: blockedOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0),
      refundAmount: allMatchedOrders.reduce((s, o) => s + confirmedRefund(o), 0),
      amount: orders.reduce((s, o) => s + netOrderAmount(o), 0),
      paid: orders.reduce((s, o) => s + paid(o), 0),
      due: orders.reduce((s, o) => s + financeDue(o), 0),
      commission: orders.reduce((s, o) => s + (
        type === "shop" ? orderSplit(o).shopAmount
          : type === "distributor" ? orderSplit(o).distributorAmount
          : type === "photo" ? orderSplit(o).photographerAmount
          : commission(o, type)
      ), 0),
      rateValue: commissionRateFor(type, row.id),
      rateText: ["shop", "distributor", "photo"].includes(type) ? commissionRateText(type, row.id) : "",
      orderIds: orders.map((o) => o.id),
      orderNos: orders.map((o) => o.orderNo),
    };
  });
}
function reconciliationTransferMonth() {
  return state.filters.reconcileMonth || LXMFormat.date(new Date()).slice(0, 7);
}
function currentClosingRecord() {
  return data.monthlyClosings.find((item) => item.month === reconciliationTransferMonth()) || null;
}
const reconciliationClosingRecord = computed(() => currentClosingRecord());
const isReconciliationClosed = computed(() => reconciliationClosingRecord.value?.status === "已关");
function canCloseReconciliationMonth() {
  return state.role === "super";
}
function closeReconciliationMonth() {
  if (!canCloseReconciliationMonth()) return ElMessage.warning("只有超管可以执行月度关账");
  const month = reconciliationTransferMonth();
  if (currentClosingRecord()?.status === "已关") return ElMessage.warning("当前月份已关");
  ElMessageBox.confirm(`确认封存 ${month} 的对账期数据？封存后，本对账期内已经确认的结算记录、实际分账金额和静置期处理都会锁定，避免财务确认后又被改动。仍在订单静置期内的订单不会计入本期实际结算，等静置期满且审核通过后，进入对应商家/摄影"分销员的下一次结算周期。`, "封存对账", {
    type: "warning",
    confirmButtonText: "确认封存",
    cancelButtonText: "先不封存",
  }).then(async () => {
    const record = { id: `closing-${month}`, month, status: "已关", operator: currentOperatorName(), time: LXMFormat.nowText(), note: "月度对账已完成并锁定" };
    try { Object.assign(record, await saveReconciliationRecord("monthlyClosings", record, "create") || {}); }
    catch (error) { return ElMessage.error((error && error.message) || "月度关账保存失败，请稍后重试"); }
    data.monthlyClosings.unshift(record);
    log("月度关账", month, "锁定当月分账与结算操", currentOperatorName(), { module: "财务审计", level: "", objectType: "对账", objectName: month });
    ElMessage.success("月度对账单已封存，关键财务操作已锁定");
  }).catch(() => {});
}
function unlockReconciliationMonth() {
  if (state.role !== "super") return ElMessage.warning("只有超管可以解锁月份");
  const record = currentClosingRecord();
  if (!record || record.status !== "已关") return ElMessage.warning("当前月份未关");
  ElMessageBox.confirm(`确认解锁 ${record.month} 月度对账？请仅在财务调账审批后操作。`, "月度解锁确认", {
    type: "warning",
    confirmButtonText: "确认解锁",
    cancelButtonText: "取消",
  }).then(async () => {
    const original = JSON.parse(JSON.stringify(record));
    record.status = "未关";
    record.unlockedBy = currentOperatorName();
    record.unlockedAt = LXMFormat.nowText();
    try { Object.assign(record, await saveReconciliationRecord("monthlyClosings", record, "update") || {}); }
    catch (error) { Object.assign(record, original); return ElMessage.error((error && error.message) || "月度解锁保存失败，请稍后重试"); }
    log("月度解锁", record.month, "超管解锁月度对账", currentOperatorName(), { module: "财务审计", level: "", objectType: "对账", objectName: record.month });
    ElMessage.success("月份已解锁");
  }).catch(() => {});
}
function formatDateObject(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function parseMonthStart(monthText) {
  const matched = String(monthText || "").match(/^(\d{4})-(\d{1,2})/);
  const now = new Date();
  const year = matched ? Number(matched[1]) : now.getFullYear();
  const month = matched ? Number(matched[2]) - 1 : now.getMonth();
  return new Date(year, month, 1);
}
function settlementCycleFor(row) {
  if (row.type === "shop") return (data.shops.find((item) => item.id === row.id) || {}).settlementCycle || "月结";
  if (row.type === "distributor") return (data.distributors.find((item) => item.id === row.id) || {}).settlementCycle || "月结";
  if (row.type === "photo") return (data.staff.find((item) => item.id === row.id) || {}).settlementCycle || "月结";
  return "月结";
}
function settlementPeriodFor(cycle) {
  const monthStart = parseMonthStart(reconciliationTransferMonth());
  if (String(cycle || "").includes("周")) {
    const base = state.filters.reconcileMonth ? monthStart : new Date();
    const day = base.getDay() || 7;
    const start = new Date(base);
    start.setDate(base.getDate() - day + 1);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return `${formatDateObject(start)} 至 ${formatDateObject(end)}`;
  }
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  return `${formatDateObject(monthStart)} 至 ${formatDateObject(monthEnd)}`;
}
function settlementBatchKey(row) {
  const cycle = row.settlementCycle || settlementCycleFor(row);
  return `${settlementPeriodFor(cycle)}-${cycle}-${row.type}-${row.id}`;
}
function settlementBatchRecord(row) {
  const key = settlementBatchKey(row);
  return data.reconciliationTransfers.find((item) => item.key === key && ["已确", "已封"].includes(item.status));
}
function withTransferStatus(row) {
  const cycle = settlementCycleFor(row);
  const record = settlementBatchRecord({ ...row, settlementCycle: cycle });
  const amount = Number(row.commission || row.settlementAmount || 0);
  return {
    ...row,
    settlementCycle: cycle,
    settlementPeriod: settlementPeriodFor(cycle),
    transferKey: settlementBatchKey({ ...row, settlementCycle: cycle }),
    transferRecord: record || null,
    transferStatus: record?.status === "已封" ? "已封" : record ? "已结" : amount > 0 ? "待结" : "无需结算",
    transferText: record?.status === "已封"
      ? `${record.sealedBy || record.operator} · ${record.sealedAt || record.time}`
      : record ? `${record.operator} · ${record.time}` : amount > 0 ? `${cycle}待确认` : "无应计金",
    transferredAmount: record ? Number(record.amount || 0) : 0,
    pendingTransferAmount: record ? 0 : amount,
  };
}
const reconciliationSettlementRows = computed(() => [
  ...reconciliation("shop").map((row) => ({ ...row, typeName: "商家", rateText: commissionRateText("shop", row.id) })),
  ...reconciliation("distributor").map((row) => ({ ...row, typeName: "分销", rateText: commissionRateText("distributor", row.id) })),
  ...photographerSettlementRows.value,
].map(withTransferStatus));
const visibleReconciliationSettlementRows = computed(() => {
  let rows = [];
  if (["super", "finance"].includes(state.role)) rows = reconciliationSettlementRows.value;
  else if (state.role === "merchant") rows = reconciliationSettlementRows.value.filter((row) => row.type === "shop" && sameShop(row, roleProfile.value.shopId));
  else if (state.role === "distributor") rows = reconciliationSettlementRows.value.filter((row) => row.type === "distributor" && row.id === roleProfile.value.distributorId);
  else if (state.role === "photo") rows = reconciliationSettlementRows.value.filter((row) => row.type === "photo" && row.id === roleProfile.value.staffId);
  if (state.filters.settlementStatus) rows = rows.filter((row) => row.transferStatus === state.filters.settlementStatus);
  return rows;
});
const selectedReconciliationRows = computed(() => {
  const keys = new Set(state.selectedReconciliationKeys || []);
  return visibleReconciliationSettlementRows.value.filter((row) => keys.has(row.transferKey));
});
const servicePerformanceRows = computed(() => reconciliation("service")
  .filter((row) => state.role !== "service" || row.id === roleProfile.value.staffId)
  .map((row) => ({
  ...row,
  typeName: "客服",
  metricName: "经手业绩",
  performanceAmount: row.totalAmount,
  completedAmount: row.amount,
  pendingFollowAmount: row.pendingAmount + row.blockedAmount + row.due,
})));
const photographerSettlementRows = computed(() => reconciliation("photo")
  .filter((row) => state.role !== "photo" || row.id === roleProfile.value.staffId)
  .map((row) => ({
  ...row,
  typeName: "摄影",
  rateText: commissionRateText("photo", row.id),
  settlementAmount: row.commission,
})));
const reconciliationSummary = computed(() => {
  const baseOrders = scopedOrders.value;
  const eligibleOrders = baseOrders.filter(isReconciliationEligible);
  const pendingOrders = baseOrders.filter((order) => !isOrderCompletedStatus(order) && !isEstimatedReconciliationOrder(order) && !isRetainedCancelledOrder(order));
  const retainedCancelledOrders = eligibleOrders.filter(isRetainedCancelledOrder);
  const observationOrders = baseOrders.filter((order) => isOrderCompletedStatus(order) && isSettlementObservationPending(order));
  const estimatedOrders = baseOrders.filter(isEstimatedReconciliationOrder);
  const estimatedExtraOrders = estimatedOrders.filter((order) => !isReconciliationEligible(order));
  const blockedOrders = baseOrders.filter((order) => isOrderCompletedStatus(order) && !isSettlementObservationPending(order) && hasBlockingAfterSale(order));
  const rows = reconciliation("shop");
  const distributorRows = reconciliation("distributor");
  const photoRows = reconciliation("photo");
  const eligibleSplits = eligibleOrders.map(orderSplit);
  const observationSplits = observationOrders.map(orderSplit);
  const estimatedSplits = estimatedOrders.map(orderSplit);
  const eligibleAmount = eligibleSplits.reduce((sum, split) => sum + split.netAmount, 0);
  const shopCommissionAmount = rows.reduce((sum, row) => sum + row.commission, 0);
  const distributorCommissionAmount = distributorRows.reduce((sum, row) => sum + row.commission, 0);
  const photographerCommissionAmount = photoRows.reduce((sum, row) => sum + row.commission, 0);
  const headquarterAmount = eligibleSplits.reduce((sum, split) => sum + split.headquarterAmount, 0);
  const transferredAmount = visibleReconciliationSettlementBatchRows.value.reduce((sum, row) => sum + Number(row.transferredAmount || 0), 0);
  const pendingTransferAmount = visibleReconciliationSettlementBatchRows.value.reduce((sum, row) => sum + Number(row.pendingTransferAmount || 0), 0);
  const scopedRefundRows = data.afterSales.filter((row) => {
    const order = data.orders.find((item) => item.id === row.orderId);
    return Number(row.refundAmount || row.amount || 0) > 0 && order && inRoleScope(order) && inDateRange(order.appointmentAt) && (!state.filters.shopId || sameShop(order, state.filters.shopId));
  });
  const observationAmount = observationSplits.reduce((sum, split) => sum + split.netAmount, 0);
  const estimatedAmount = estimatedSplits.reduce((sum, split) => sum + split.netAmount, 0);
  const estimatedShopCommissionAmount = estimatedSplits.reduce((sum, split) => sum + split.shopAmount, 0);
  const estimatedDistributorCommissionAmount = estimatedSplits.reduce((sum, split) => sum + split.distributorAmount, 0);
  const estimatedPhotographerCommissionAmount = estimatedSplits.reduce((sum, split) => sum + split.photographerAmount, 0);
  const estimatedHeadquarterAmount = estimatedSplits.reduce((sum, split) => sum + split.headquarterAmount, 0);
  const confirmedSettlementRows = reconciliationTransferRows.value.filter((row) => ["已确", "已封"].includes(row.status));
  const confirmedSettlementOrderIds = new Set();
  confirmedSettlementRows.forEach((row) => (row.orderIds || []).forEach((orderId) => confirmedSettlementOrderIds.add(orderId)));
  const confirmedSettlementAmount = confirmedSettlementRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return {
    totalOrders: baseOrders.length,
    eligibleOrders: eligibleOrders.length,
    pendingOrders: pendingOrders.length,
    observationOrders: observationOrders.length,
    blockedOrders: blockedOrders.length,
    retainedCancelledOrders: retainedCancelledOrders.length,
    totalAmount: baseOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    pendingAmount: pendingOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    observationAmount,
    blockedAmount: blockedOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    eligibleAmount,
    retainedCancelledAmount: retainedCancelledOrders.reduce((sum, order) => sum + netOrderAmount(order), 0),
    estimatedAmount,
    estimatedOrders: estimatedOrders.length,
    estimatedExtraOrders: estimatedExtraOrders.length,
    shopCommissionAmount,
    distributorCommissionAmount,
    photographerCommissionAmount,
    headquarterAmount,
    estimatedShopCommissionAmount,
    estimatedDistributorCommissionAmount,
    estimatedPhotographerCommissionAmount,
    estimatedHeadquarterAmount,
    transferredAmount,
    pendingTransferAmount,
    confirmedSettlementAmount,
    confirmedSettlementOrders: confirmedSettlementOrderIds.size,
    confirmedSettlementBatches: confirmedSettlementRows.length,
    reviewedRefundAmount: scopedRefundRows.filter((row) => normalizeReviewStatus(row.financeStatus) === "已审").reduce((sum, row) => sum + Number(row.refundAmount || row.amount || 0), 0),
    pendingRefundAmount: scopedRefundRows.filter((row) => normalizeReviewStatus(row.financeStatus) !== "已审").reduce((sum, row) => sum + Number(row.refundAmount || row.amount || 0), 0),
    pendingRefundOrders: scopedRefundRows.filter((row) => normalizeReviewStatus(row.financeStatus) !== "已审").length,
  };
});
const reconciliationDifferenceRows = computed(() => {
  const baseOrders = scopedOrders.value;
  const eligibleOrders = baseOrders.filter(isReconciliationEligible);
  const totalOrderAmount = baseOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
  const reviewedPaidAmount = baseOrders.reduce((sum, order) => sum + financePaid(order), 0);
  const settlementAccrued = reconciliationSummary.value.shopCommissionAmount + reconciliationSummary.value.distributorCommissionAmount + reconciliationSummary.value.photographerCommissionAmount;
  const settlementPaid = reconciliationSummary.value.transferredAmount;
  const rows = [
    { type: "收款差异", amount: Math.max(totalOrderAmount - reviewedPaidAmount - reconciliationSummary.value.reviewedRefundAmount, 0), desc: "订单总额 - 财务已审核收款 - 已审核退款。用于提示客服或财务继续核对收款。", level: "danger" },
    { type: "分账差异", amount: Math.max(reconciliationSummary.value.estimatedAmount - reconciliationSummary.value.eligibleAmount, 0), desc: "预计可分账净额 - 实际可分账净额。主要来自订单静置期、售后、退款待审或未完成订单。", level: "warning" },
    { type: "结算差异", amount: Math.max(settlementAccrued - settlementPaid, 0), desc: "系统计提应计总额 - 已实际结算金额。用于提示财务待打款或待确认批次。", level: "warning" },
  ];
  return rows.filter((row) => Number(row.amount || 0) > 0 || eligibleOrders.length > 0);
});
const activeReconciliationAlerts = computed(() => reconciliationDifferenceRows.value.filter((row) => Number(row.amount || 0) > 0));
function openReconciliationDifference(row) {
  if (!row) return;
  const label = row.type || "对账差异";
  let rows = [];
  let amountLabel = "差异金额";
  if (label.includes("收款")) {
    rows = scopedOrders.value.filter((order) => financeDue(order) > 0 || financePendingAmount(order) > 0);
    amountLabel = "待审/待收";
  } else if (label.includes("分账")) {
    rows = ctx.reconciliationHoldRows.value;
    amountLabel = "暂缓净";
  } else if (label.includes("结算")) {
    rows = visibleReconciliationSettlementBatchRows.value
      .filter((item) => Number(item.pendingTransferAmount || item.pendingAmount || 0) > 0)
      .flatMap((item) => {
        const orderIds = new Set(item.orderIds || []);
        return scopedOrders.value
          .filter((order) => orderIds.has(order.id))
          .map((order) => ({
            ...order,
            settlementSubjectType: item.typeName,
            settlementSubjectName: item.name,
            settlementPeriod: item.settlementPeriod || item.period,
            settlementCycle: item.settlementCycle,
            settlementDueAmount: settlementOrderAmount(order, item),
          }));
      });
    amountLabel = "待结";
  }
  state.reconciliationDetail = {
    title: label,
    desc: row.desc || "当前差异明细，供财务核对定位",
    rows,
    amountLabel,
    type: label.includes("结算") ? "settlementDue" : label.includes("收款") ? "due" : "eligible",
  };
  state.reconciliationDialog = true;
}
const adjustmentRecordRows = computed(() => data.adjustmentRecords.filter((row) => {
  if (!["super", "finance"].includes(state.role)) return false;
  const month = reconciliationTransferMonth();
  return !month || String(row.time || "").startsWith(month);
}).sort((a, b) => String(b.time || "").localeCompare(String(a.time || ""))));
function openAdjustmentDialog(row = null) {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以发起冲正调");
  state.adjustmentForm = {
    orderNo: row?.orderNo || "",
    type: row?.type || "结算后退",
    amount: Math.abs(Number(row?.amount || 0)),
    targetType: row?.targetType || "商家",
    targetName: row?.targetName || "",
    note: row?.note || "",
    attachment: row?.attachment || "",
    attachmentFileIds: (row?.attachmentFileIds || []).slice(),
    attachmentFiles: (row?.attachments || []).slice(),
  };
  state.adjustmentDialog = true;
}
async function submitAdjustmentRecord() {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("当前角色无权发起冲正调账");
  const form = state.adjustmentForm;
  if (!form.orderNo || !Number(form.amount || 0) || !form.targetName || !form.note) return ElMessage.warning("请填写订单号、冲正金额、扣减主体和备注");
  const order = data.orders.find((item) => item.orderNo === form.orderNo || item.id === form.orderNo);
  const record = {
    id: `adj-${Date.now()}`,
    orderNo: order?.orderNo || form.orderNo,
    orderId: order?.id || "",
    time: LXMFormat.nowText(),
    type: form.type,
    amount: -Math.abs(Number(form.amount || 0)),
    targetType: form.targetType,
    targetName: form.targetName,
    operator: currentOperatorName(),
    approvalStatus: state.role === "super" ? "已审" : "待审",
    offsetStatus: "优先抵扣下一期待结算",
    note: form.note,
    attachment: form.attachment || "线下凭证待补",
    attachmentFileIds: (form.attachmentFileIds || []).slice(),
  };
  try { Object.assign(record, await saveReconciliationRecord("adjustmentRecords", record, "create") || {}); }
  catch (error) { return ElMessage.error((error && error.message) || "冲正记录保存失败，请稍后重试"); }
  data.adjustmentRecords.unshift(record);
    log("发起冲正调账", form.orderNo, `${form.targetType} ${form.targetName} / ${money(form.amount)}`, currentOperatorName(), { module: "财务审计", level: "", amount: Number(form.amount || 0), objectType: form.targetType, objectName: form.targetName });
  state.adjustmentDialog = false;
  ElMessage.success(state.role === "super" ? "冲正记录已审批入" : "冲正记录已提交，等待超管审批");
}
function openAdjustmentOrder(row) {
  if (!row?.orderId && !row?.orderNo) return ElMessage.warning("当前冲正记录未关联有效订");
  openOrderById(row.orderId || row.orderNo, { readonly: true, mode: "finance" });
}
// 中止留存订单冲正：从对账「中止留存收入」明细发起，预填订单号与留存净额，走统一冲正调账弹窗
function openRetentionAdjustment(row) {
  if (!canUseHeadquarterReconciliation.value) return ElMessage.warning("只有超管或财务可以对中止留存订单发起冲正");
  if (!row || (!row.orderNo && !row.id)) return ElMessage.warning("当前留存记录未关联有效订单");
  openAdjustmentDialog({
    orderNo: row.orderNo || row.id,
    type: "红字冲正",
    amount: Math.max(netOrderAmount(row), 0),
    targetType: "商家",
    targetName: shopName(row.shopId) || "",
    note: `中止留存订单冲正：${row.orderNo || row.id}，留存净额 ${money(Math.max(netOrderAmount(row), 0))}`,
  });
}
function approveAdjustmentRecord(row) {
  if (state.role !== "super") return ElMessage.warning("只有超管可以审批冲正调账");
  if (!row || row.approvalStatus === "已审") return;
  ElMessageBox.confirm(`确认审批 ${row.orderNo} 的冲正调"${money(Math.abs(Number(row.amount || 0)))}？`, "冲正审批确认", {
    type: "warning",
    confirmButtonText: "确认审批",
    cancelButtonText: "取消",
  }).then(async () => {
    const original = JSON.parse(JSON.stringify(row));
    row.approvalStatus = "已审";
    row.approvedBy = currentOperatorName();
    row.approvedAt = LXMFormat.nowText();
    try { Object.assign(row, await saveReconciliationRecord("adjustmentRecords", row, "update") || {}); }
    catch (error) { Object.assign(row, original); return ElMessage.error((error && error.message) || "冲正审批保存失败，请稍后重试"); }
    log("审批冲正调账", row.orderNo, `${row.targetType} ${row.targetName} / ${money(Math.abs(Number(row.amount || 0)))}`, currentOperatorName(), { module: "财务审计", level: "", amount: Math.abs(Number(row.amount || 0)), objectType: row.targetType, objectName: row.targetName });
    ElMessage.success("冲正调账已审");
  }).catch(() => {});
}
const reconciliationSettlementBatchRows = computed(() => reconciliationSettlementRows.value
  .filter((row) => Number(row.commission || 0) > 0)
  .map((row) => ({
    ...row,
    key: settlementBatchKey(row),
    period: settlementPeriodFor(row.settlementCycle),
    amount: Number(row.commission || 0),
    status: row.transferStatus,
    settledAmount: row.transferredAmount,
    pendingAmount: row.pendingTransferAmount,
    reminder: row.transferStatus === "已结" ? "已生成结算记" : `${row.settlementCycle}待结算，请财务按周期确认`,
  })));
const visibleReconciliationSettlementBatchRows = computed(() => visibleReconciliationSettlementRows.value
  .filter((row) => Number(row.commission || 0) > 0)
  .map((row) => ({
    ...row,
    key: settlementBatchKey(row),
    period: settlementPeriodFor(row.settlementCycle),
    amount: Number(row.commission || 0),
    status: row.transferStatus,
    settledAmount: row.transferredAmount,
    pendingAmount: row.pendingTransferAmount,
    reminder: row.transferStatus === "已结" ? "已生成结算记" : `${row.settlementCycle}待结算，请财务按周期确认`,
  })));
function canSeeSettlementRecord(row) {
  if (["super", "finance"].includes(state.role)) return true;
  if (state.role === "merchant") return row.objectType === "商家" && sameShop({ id: row.objectId, shopId: row.objectId }, roleProfile.value.shopId);
  if (state.role === "distributor") return row.objectType === "分销" && row.objectId === roleProfile.value.distributorId;
  if (state.role === "photo") return row.objectType === "摄影" && row.objectId === roleProfile.value.staffId;
  return false;
}
const reconciliationTransferRows = computed(() => data.reconciliationTransfers.filter((row) => row.month === reconciliationTransferMonth() && canSeeSettlementRecord(row)).sort((a, b) => String(b.time || "").localeCompare(String(a.time || ""))));
function settlementRecordStage(row) {
  if (!row) return "待确";
  if (row.status === "已封") return "已封";
  if (row.paidAt || row.payStatus === "已打") return "已打款待复核";
  if (row.status === "已确") return "已确认待打款";
  return row.status || "待确";
}
function settlementRecordStageType(row) {
  const stage = settlementRecordStage(row);
  if (stage === "已封") return "success";
  if (stage === "已打款待复核") return "warning";
  if (stage === "已确认待打款") return "primary";
  return "info";
}
function settlementPeriodEndDate(periodText) {
  const matches = String(periodText || "").match(/\d{4}-\d{2}-\d{2}/g);
  if (!matches?.length) return null;
  return new Date(`${matches[matches.length - 1]} 23:59:59`);
}
function settlementDueText(row) {
  const end = settlementPeriodEndDate(row.settlementPeriod || row.period);
  if (!end) return "按周期待确认";
  const now = new Date();
  const diffDays = Math.floor((now - end) / (24 * 60 * 60 * 1000));
  if (diffDays > 0) return `已超"${diffDays} 天`;
  if (diffDays === 0) return "今日到期";
  return `${Math.abs(diffDays)} 天后到期`;
}
const settlementDueReminderRows = computed(() => visibleReconciliationSettlementBatchRows.value
  .filter((row) => row.transferStatus === "待结" && Number(row.pendingTransferAmount || row.pendingAmount || row.commission || 0) > 0)
  .map((row) => ({
    ...row,
    dueText: settlementDueText(row),
    orderCount: (row.orderIds || []).length,
    dueAmount: Number(row.pendingTransferAmount || row.pendingAmount || row.commission || 0),
  }))
  .sort((a, b) => String(a.settlementPeriod || "").localeCompare(String(b.settlementPeriod || ""))));
function markSettlementPaid(row) {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以确认打");
  if (!row || row.status === "已封") return ElMessage.warning("已封存账单不能重复确认打");
  ElMessageBox.confirm(`确认 ${row.objectType}「${row.objectName}」${row.period} 已完成打款？`, "确认打款", {
    type: "warning",
    confirmButtonText: "确认已打",
    cancelButtonText: "取消",
  }).then(async () => {
    const original = JSON.parse(JSON.stringify(row));
    row.payStatus = "已打";
    row.paidBy = currentOperatorName();
    row.paidAt = LXMFormat.nowText();
    try { Object.assign(row, await saveReconciliationRecord("reconciliationTransfers", row, "update") || {}); }
    catch (error) { Object.assign(row, original); return ElMessage.error((error && error.message) || "打款记录保存失败，请稍后重试"); }
    log("确认结算打款", row.objectName, `${row.objectType} / ${row.period} / ${money(row.amount)}`, currentOperatorName(), { module: "财务审计", level: "", amount: Number(row.amount || 0), objectType: row.objectType, objectName: row.objectName, snapshot: (row.orderNos || []).join("") });
    ElMessage.success("已记录打款，当前进入待复核封存阶");
  }).catch(() => {});
}
function sealSettlementRecord(row) {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以封存账");
  if (!row) return;
  if (row.status === "已封") return ElMessage.warning("该结算记录已封存");
  ElMessageBox.confirm(`确认复核并封存 ${row.objectType}「${row.objectName}」${row.period}？封存后金额、订单范围和凭证记录锁定。`, "复核封存", {
    type: "warning",
    confirmButtonText: "确认封存",
    cancelButtonText: "取消",
  }).then(async () => {
    const original = JSON.parse(JSON.stringify(row));
    row.status = "已封";
    row.sealedBy = currentOperatorName();
    row.sealedAt = LXMFormat.nowText();
    row.sealNote = row.sealNote || "结算记录复核封存";
    try { Object.assign(row, await saveReconciliationRecord("reconciliationTransfers", row, "update") || {}); }
    catch (error) { Object.assign(row, original); return ElMessage.error((error && error.message) || "封存记录保存失败，请稍后重试"); }
    log("封存结算记录", row.objectName, `${row.objectType} / ${row.period} / ${money(row.amount)}`, currentOperatorName(), { module: "财务审计", level: "", amount: Number(row.amount || 0), objectType: row.objectType, objectName: row.objectName, snapshot: (row.orderNos || []).join("") });
    ElMessage.success("结算记录已复核封");
  }).catch(() => {});
}
const reconciliationFilterSummary = computed(() => {
  const parts = [];
  parts.push(state.filters.reconcileMonth ? `月份：${state.filters.reconcileMonth}` : "月份：当前演示数据");
  parts.push(state.filters.cityId ? `城市：${cityName(state.filters.cityId)}` : ["super", "finance"].includes(state.role) ? "城市：总部全部" : "城市：全部可用");
  if (state.filters.shopId) parts.push(`商家：${shopName(state.filters.shopId)}`);
  if (state.filters.agentId) parts.push(`代理分店：${agentName(state.filters.agentId)}`);
  if (state.filters.distributorId) parts.push(`分销员：${distributorName(state.filters.distributorId)}`);
  if (state.filters.sourceType) parts.push(`来源"{({ shop: "商家二维", headquarter: "总部二维", manual: "客服手动创建", natural: "小程序自然来源" })[state.filters.sourceType] || state.filters.sourceType}`);
  return parts.join(" · ");
});
const reconciliationFilterTags = computed(() => {
  const tags = [];
  const sourceText = { shop: "商家二维", headquarter: "总部二维", manual: "客服手动创建", natural: "小程序自然来源" };
  if (state.filters.reconcileMonth) tags.push({ key: "reconcileMonth", label: `月份：${state.filters.reconcileMonth}` });
  if (state.filters.dateRange?.length) tags.push({ key: "dateRange", label: `日期：${normalizeDateText(state.filters.dateRange[0])} 至 ${normalizeDateText(state.filters.dateRange[1])}` });
  if (state.filters.status) tags.push({ key: "status", label: `订单状态：${statusMeta(state.filters.status).label}` });
  if (state.filters.sourceType) tags.push({ key: "sourceType", label: `来源：${sourceText[state.filters.sourceType] || state.filters.sourceType}` });
  if (state.filters.shopId) tags.push({ key: "shopId", label: `商家：${shopName(state.filters.shopId)}` });
  if (state.filters.distributorId) tags.push({ key: "distributorId", label: `分销员：${distributorName(state.filters.distributorId)}` });
  if (state.filters.photographerId) tags.push({ key: "photographerId", label: `摄影师：${staffName(state.filters.photographerId)}` });
  if (state.filters.assigneeId) tags.push({ key: "assigneeId", label: `客服：${staffName(state.filters.assigneeId)}` });
  if (state.filters.settlementStatus) tags.push({ key: "settlementStatus", label: `结算状态：${state.filters.settlementStatus}` });
  if (state.filters.keyword) tags.push({ key: "keyword", label: `关键词：${state.filters.keyword}` });
  return tags;
});
function clearReconciliationFilter(key) {
  if (!key) return;
  state.filters[key] = "";
}
function reconciliationFilterSnapshot() {
  const keys = ["reconcileMonth", "dateRange", "cityId", "agentId", "distributorId", "shopId", "sourceType", "status", "assigneeId", "photographerId", "keyword", "settlementStatus"];
  return keys.reduce((memo, key) => {
    const value = state.filters[key];
    if (Array.isArray(value)) memo[key] = [...value];
    else memo[key] = value || "";
    return memo;
  }, {});
}
function saveReconciliationFilterPreset() {
  ElMessageBox.prompt("给当前筛选条件起一个名字，方便下次快速套用", "保存筛选模", {
    confirmButtonText: "保存模板",
    cancelButtonText: "取消",
    inputPlaceholder: "例如：本周待结算商家",
    inputValidator: (value) => !!String(value || "").trim() || "请填写模板名",
  }).then(({ value }) => {
    state.reconciliationFilterPresets.unshift({
      id: `preset-${Date.now()}`,
      name: String(value || "").trim(),
      filters: reconciliationFilterSnapshot(),
    });
    ElMessage.success("筛选模板已保存");
  }).catch(() => {});
}
function applyReconciliationFilterPreset(preset) {
  if (!preset?.filters) return;
  Object.assign(state.filters, preset.filters);
  ElMessage.success(`已套用筛选模板：${preset.name}`);
}
function removeReconciliationFilterPreset(preset) {
  if (!preset) return;
  state.reconciliationFilterPresets = state.reconciliationFilterPresets.filter((item) => item.id !== preset.id);
  ElMessage.success("筛选模板已删除");
}
function applyReconciliationQuickScope(scope) {
  const map = {
    eligible: { tab: "settlement", type: "eligible", label: "实际可分账订" },
    estimated: { tab: "settlement", type: "estimated", label: "预计可入池订" },
    observation: { tab: "hold", type: "observation", label: "订单静置期暂" },
    blocked: { tab: "hold", type: "blocked", label: "售后/退款暂" },
    retained: { tab: "settlement", type: "retained", label: "中止留存收入" },
  };
  const item = map[scope];
  if (!item) return;
  state.reconciliationTab = item.tab;
  ctx.openReconciliationDetail(item.type, item.label);
}
const canUseHeadquarterReconciliation = computed(() => ["super", "finance"].includes(state.role));
const reconciliationObjectSummary = computed(() => ({
  shops: reconciliation("shop").filter((row) => row.totalOrders > 0).length,
  distributors: reconciliation("distributor").filter((row) => row.totalOrders > 0).length,
  agents: reconciliation("agent").filter((row) => row.totalOrders > 0).length,
  services: reconciliation("service").filter((row) => row.totalOrders > 0).length,
  photographers: reconciliation("photo").filter((row) => row.totalOrders > 0).length,
}));
const reconciliationTabBadges = computed(() => ({
  settlement: visibleReconciliationSettlementRows.value.length,
  overview: ctx.reconciliationFocus.value.rows.length,
  hold: ctx.reconciliationHoldRows.value.length,
  records: reconciliationTransferRows.value.length,
  service: servicePerformanceRows.value.length,
  adjustments: adjustmentRecordRows.value.length,
}));
function resetReconciliationFilters() {
  const cleared = { reconcileMonth: "", dateRange: "", cityId: "", agentId: "", distributorId: "", shopId: "", sourceType: "", status: "", assigneeId: "", photographerId: "", keyword: "", settlementStatus: "" };
  if (!canUseHeadquarterReconciliation.value) {
    Object.assign(state.filters, cleared);
    ElMessage.success("已恢复当前角色自己的月度核对");
    return;
  }
  Object.assign(state.filters, cleared);
  ElMessage.success("已恢复总部全部对账口径");
}
const settlementDialogOrders = computed(() => {
  const ids = new Set(state.settlementTarget?.orderIds || []);
  return scopedOrders.value.filter((order) => ids.has(order.id));
});
const selectedSettlementDialogOrders = computed(() => {
  const ids = new Set(state.settlementForm.selectedOrderIds || []);
  return settlementDialogOrders.value.filter((order) => ids.has(order.id));
});
function settlementOrderAmount(order, target = state.settlementTarget) {
  if (!order || !target) return 0;
  if (target.type === "shop") return orderSplit(order).shopAmount;
  if (target.type === "distributor") return orderSplit(order).distributorAmount;
  if (target.type === "photo") return orderSplit(order).photographerAmount;
  if (target.type === "service") return 0;
  return commission(order, target.type);
}
function refreshSettlementFormAmount() {
  const amount = selectedSettlementDialogOrders.value.reduce((sum, order) => sum + settlementOrderAmount(order), 0);
  state.settlementForm.amount = Math.round(amount * 100) / 100;
}
function confirmSettlementBatch(row) {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以确认结");
  if (isReconciliationClosed.value) return ElMessage.warning("当前月份已关账，不能确认结算");
  const amount = Number(row.amount || row.commission || row.settlementAmount || 0);
  if (amount <= 0) return ElMessage.warning("当前批次没有需要确认的结算金额");
  if (settlementBatchRecord(row)) return ElMessage.warning("该对象当前结算周期已确认，不能重复确");
  state.settlementTarget = row;
  state.settlementForm = {
    amount,
    method: "",
    voucherNo: "",
    note: "",
    selectedOrderIds: [...(row.orderIds || [])],
  };
  state.settlementDialog = true;
}
function onReconciliationSelectionChange(rows) {
  state.selectedReconciliationKeys = (rows || []).map((row) => row.transferKey);
}
async function createSettlementRecordFromRow(row, extra = {}) {
  const selectedOrders = scopedOrders.value.filter((order) => (row.orderIds || []).includes(order.id));
  const amount = Number(row.amount || row.commission || row.settlementAmount || 0);
  const record = {
    id: `transfer-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    key: settlementBatchKey(row),
    month: reconciliationTransferMonth(),
    period: row.period || row.settlementPeriod,
    settlementCycle: row.settlementCycle,
    objectType: row.typeName,
    objectId: row.id,
    objectName: row.name,
    amount,
    status: "已确",
    operator: currentOperatorName(),
    time: LXMFormat.nowText(),
    orderIds: selectedOrders.map((order) => order.id),
    orderNos: selectedOrders.map((order) => order.orderNo),
    method: extra.method || "批量确认",
    voucherNo: extra.voucherNo || "",
    note: `${row.rateText || "按比例"} · ${row.settlementCycle}；批量结算 ${selectedOrders.length} 单${extra.note ? `；备注：${extra.note}` : ""}`,
  };
  try {
    const saved = await saveReconciliationRecord("reconciliationTransfers", record, "create");
    Object.assign(record, saved || {});
    data.reconciliationTransfers.unshift(record);
    return record;
  } catch (error) {
    ElMessage.error((error && error.message) || "结算记录保存失败，请稍后重试");
    return null;
  }
}
function batchConfirmSettlement() {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以批量确认结算");
  if (isReconciliationClosed.value) return ElMessage.warning("当前月份已封存，不能批量确认结算");
  const rows = selectedReconciliationRows.value.filter((row) => ["待结", "待结算"].includes(row.transferStatus) && Number(row.commission || 0) > 0);
  if (!rows.length) return ElMessage.warning("请先勾选待结算对象");
  const largeRows = rows.filter((row) => Number(row.commission || 0) >= largeSettlementThreshold() && largeSettlementThreshold() > 0);
  if (largeRows.length) return ElMessage.warning(`已选对象包含 ${largeRows.length} 个大额结算，请逐个打开确认结算并填写凭证与备注`);
  ElMessageBox.confirm(`确认批量结算 ${rows.length} 个对象？系统会为每个对象生成独立结算记录。`, "批量确认结算", {
    type: "warning",
    confirmButtonText: "确认批量结算",
    cancelButtonText: "取消",
  }).then(async () => {
    const created = [];
    for (const row of rows) {
      const record = await createSettlementRecordFromRow(row, { method: "批量确认" });
      if (record) created.push(record);
    }
    if (created.length !== rows.length) return;
    state.selectedReconciliationKeys = [];
    log("批量确认结算", "月度对账", `${rows.length} 个结算对象生成记录`, currentOperatorName(), { module: "财务审计", level: "高", amount: rows.reduce((sum, row) => sum + Number(row.commission || 0), 0), objectType: "批量结算", objectName: "月度对账" });
    ElMessage.success(`已生成 ${rows.length} 条结算记录`);
  }).catch(() => {});
}
function batchSealSettlement() {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以批量封存账");
  if (isReconciliationClosed.value) return ElMessage.warning("当前月份已整体封存，不能批量封存单个账单");
  const rows = selectedReconciliationRows.value.filter((row) => row.transferStatus === "已结" && row.transferRecord);
  if (!rows.length) return ElMessage.warning("请先勾选已结算但未封存的对");
  ElMessageBox.confirm(`确认批量封存 ${rows.length} 个结算对象账单？封存后原始结算记录锁定，后续调整走冲正台账。`, "批量封存账单", {
    type: "warning",
    confirmButtonText: "确认封存",
    cancelButtonText: "取消",
  }).then(async () => {
    const originals = rows.map((row) => [row.transferRecord, JSON.parse(JSON.stringify(row.transferRecord))]);
    rows.forEach((row) => {
      row.transferRecord.status = "已封";
      row.transferRecord.sealedBy = currentOperatorName();
      row.transferRecord.sealedAt = LXMFormat.nowText();
      row.transferRecord.sealNote = "批量封存账单";
    });
    try {
      for (const [record] of originals) await saveReconciliationRecord("reconciliationTransfers", record, "update");
    } catch (error) {
      originals.forEach(([record, original]) => Object.assign(record, original));
      return ElMessage.error((error && error.message) || "批量封存保存失败，请稍后重试");
    }
    state.selectedReconciliationKeys = [];
    log("批量封存账单", "月度对账", `${rows.length} 个结算对象账单已封存`, currentOperatorName(), { module: "财务审计", level: "", amount: rows.reduce((sum, row) => sum + Number(row.commission || 0), 0), objectType: "批量封存", objectName: "月度对账" });
    ElMessage.success(`已批量封"${rows.length} 个账单`);
  }).catch(() => {});
}
async function submitSettlementBatch() {
  const row = state.settlementTarget;
  if (!row) return;
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以确认结");
  if (isReconciliationClosed.value) return ElMessage.warning("当前月份已封存，不能确认结算");
  if (settlementBatchRecord(row)) return ElMessage.warning("该对象当前结算周期已确认，不能重复确");
  const selectedOrders = selectedSettlementDialogOrders.value;
  if (!selectedOrders.length) return ElMessage.warning("请至少选择一笔结算订");
  const amount = Number(state.settlementForm.amount || 0);
  if (amount <= 0) return ElMessage.warning("请填写本次实结分成金");
  if (largeSettlementThreshold() > 0 && amount >= largeSettlementThreshold() && (!state.settlementForm.voucherNo || !state.settlementForm.note)) {
    return ElMessage.warning(`本次结算达到大额复核阈"${money(largeSettlementThreshold())}，请填写凭证号和备注`);
  }
  const record = {
    id: `transfer-${Date.now()}`,
    key: settlementBatchKey(row),
    month: reconciliationTransferMonth(),
    period: row.period || row.settlementPeriod,
    settlementCycle: row.settlementCycle,
    objectType: row.typeName,
    objectId: row.id,
    objectName: row.name,
    amount,
    status: "已确",
    operator: currentOperatorName(),
    time: LXMFormat.nowText(),
    orderIds: selectedOrders.map((order) => order.id),
    orderNos: selectedOrders.map((order) => order.orderNo),
    method: state.settlementForm.method || "未填",
    voucherNo: state.settlementForm.voucherNo || "",
    note: `${row.rateText || "按比例"} · ${row.settlementCycle}；批量结算 ${selectedOrders.length} 单${state.settlementForm.note ? `；备注：${state.settlementForm.note}` : ""}`,
  };
  try {
    const saved = await saveReconciliationRecord("reconciliationTransfers", record, "create");
    Object.assign(record, saved || {});
  } catch (error) {
    return ElMessage.error((error && error.message) || "结算批次保存失败，请稍后重试");
  }
  data.reconciliationTransfers.unshift(record);
  log("确认结算批次", row.name, `${record.objectType} ${money(amount)} / ${record.period} / ${record.orderNos.length} 单`, currentOperatorName(), { module: "财务审计", level: "", amount, objectType: record.objectType, objectName: record.objectName, snapshot: record.orderNos.join("") });
  state.settlementDialog = false;
  state.settlementTarget = null;
  ElMessage.success("结算批次已记录，并可在确认记录中查看关联订单");
}
function closeSettlementBatch(row) {
  if (!["super", "finance"].includes(state.role)) return ElMessage.warning("只有超管或财务可以封存结算账");
  if (isReconciliationClosed.value) return ElMessage.warning("当前月份已整体封存，不能重复封存单个结算对象");
  const record = settlementBatchRecord(row);
  if (!record) return ElMessage.warning("请先确认该对象本周期结算，再封存账单");
  if (record.status === "已封") return ElMessage.warning("该对象本周期账单已封");
  ElMessageBox.confirm(`确认封存 ${row.typeName}「${row.name}」${row.settlementPeriod} 的结算账单？封存后该批次的实结金额、订单范围和凭证记录将锁定。仍在订单静置期内的订单不会进入本批次，静置期满且审核通过后会自动进入下一次可结算周期。`, "封存结算账单", {
    type: "warning",
    confirmButtonText: "确认封存",
    cancelButtonText: "暂不封存",
  }).then(async () => {
    const original = JSON.parse(JSON.stringify(record));
    record.status = "已封";
    record.sealedBy = currentOperatorName();
    record.sealedAt = LXMFormat.nowText();
    record.sealNote = "按结算对象与结算周期封存账单";
    try { Object.assign(record, await saveReconciliationRecord("reconciliationTransfers", record, "update") || {}); }
    catch (error) { Object.assign(record, original); return ElMessage.error((error && error.message) || "封存结算保存失败，请稍后重试"); }
    log("封存结算账单", row.name, `${row.typeName} / ${record.period} / ${money(record.amount)}`, currentOperatorName(), { module: "财务审计", level: "", amount: Number(record.amount || 0), objectType: row.typeName, objectName: row.name, snapshot: (record.orderNos || []).join("") });
    ElMessage.success("该结算对象本周期账单已封存，可在结算确认记录中查");
  }).catch(() => {});
}
function unlockSettlementBatch(row) {
  if (state.role !== "super") return ElMessage.warning("只有超管可以解封单主体账");
  const record = settlementBatchRecord(row);
  if (!record || record.status !== "已封") return ElMessage.warning("当前账单未封存，无需解封");
  ElMessageBox.prompt(`请输入解封 ${row.typeName}「${row.name}」${row.settlementPeriod} 账单的审批说明。解封后必须完成调整并重新封存。`, "解封结算账单", {
    type: "warning",
    inputType: "textarea",
    inputPlaceholder: "填写审批单号、审批人或调整原",
    confirmButtonText: "确认解封",
    cancelButtonText: "取消",
    inputValidator: (value) => !!String(value || "").trim() || "请填写解封审批说",
  }).then(async ({ value }) => {
    const original = JSON.parse(JSON.stringify(record));
    record.status = "已确";
    record.unsealedBy = currentOperatorName();
    record.unsealedAt = LXMFormat.nowText();
    record.unsealNote = value;
    try { Object.assign(record, await saveReconciliationRecord("reconciliationTransfers", record, "update") || {}); }
    catch (error) { Object.assign(record, original); return ElMessage.error((error && error.message) || "解封结算保存失败，请稍后重试"); }
    log("解封结算账单", row.name, `${row.typeName} / ${record.period} / ${value}`, currentOperatorName(), { module: "财务审计", level: "", amount: Number(record.amount || 0), objectType: row.typeName, objectName: row.name, snapshot: value });
    ElMessage.success("账单已解封，请完成调整后重新封存");
  }).catch(() => {});
}
function openSettlementRecordOrders(row) {
  const ids = new Set(row.orderIds || []);
  const nos = new Set(row.orderNos || []);
  const rows = data.orders.filter((order) => ids.has(order.id) || nos.has(order.orderNo));
  state.reconciliationDetail = {
    title: `${row.objectName} · 结算订单`,
    desc: `${row.period} · ${row.objectType}实结分成 ${money(row.amount)}，状态：${row.status || "已确"}，共 ${rows.length} 单。`,
    rows,
    amountLabel: "实结分成金额",
    type: row.objectType === "商家" ? "shop" : row.objectType === "分销" ? "distributor" : row.objectType === "摄影" ? "photo" : "eligible",
    record: row,
  };
  state.reconciliationDialog = true;
}

  return {
    reconciliation,
    reconciliationTransferMonth,
    currentClosingRecord,
    reconciliationClosingRecord,
    isReconciliationClosed,
    canCloseReconciliationMonth,
    closeReconciliationMonth,
    unlockReconciliationMonth,
    formatDateObject,
    parseMonthStart,
    settlementCycleFor,
    settlementPeriodFor,
    settlementBatchKey,
    settlementBatchRecord,
    withTransferStatus,
    reconciliationSettlementRows,
    visibleReconciliationSettlementRows,
    selectedReconciliationRows,
    servicePerformanceRows,
    photographerSettlementRows,
    reconciliationSummary,
    reconciliationDifferenceRows,
    activeReconciliationAlerts,
    openReconciliationDifference,
    adjustmentRecordRows,
    openAdjustmentDialog,
    submitAdjustmentRecord,
    openAdjustmentOrder,
    openRetentionAdjustment,
    approveAdjustmentRecord,
    reconciliationSettlementBatchRows,
    visibleReconciliationSettlementBatchRows,
    canSeeSettlementRecord,
    reconciliationTransferRows,
    settlementRecordStage,
    settlementRecordStageType,
    settlementPeriodEndDate,
    settlementDueText,
    settlementDueReminderRows,
    markSettlementPaid,
    sealSettlementRecord,
    reconciliationFilterSummary,
    reconciliationFilterTags,
    clearReconciliationFilter,
    reconciliationFilterSnapshot,
    saveReconciliationFilterPreset,
    applyReconciliationFilterPreset,
    removeReconciliationFilterPreset,
    applyReconciliationQuickScope,
    canUseHeadquarterReconciliation,
    reconciliationObjectSummary,
    reconciliationTabBadges,
    resetReconciliationFilters,
    settlementDialogOrders,
    selectedSettlementDialogOrders,
    settlementOrderAmount,
    refreshSettlementFormAmount,
    confirmSettlementBatch,
    onReconciliationSelectionChange,
    createSettlementRecordFromRow,
    batchConfirmSettlement,
    batchSealSettlement,
    submitSettlementBatch,
    closeSettlementBatch,
    unlockSettlementBatch,
    openSettlementRecordOrders
  };
});
