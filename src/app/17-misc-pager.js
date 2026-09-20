// 订单工作流元信息与通用分页
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    activeAfterSaleRows,
    adjustmentRecordRows,
    afterSaleRecordRows,
    canEditCurrentOrder,
    computed,
    contentRows,
    currentOperatorName,
    data,
    distributorRows,
    financeReviewOrderRows,
    financeReviewRecordRows,
    hasRiskBlock,
    isOrderAfterSaleLocked,
    isOrderCancelledStatus,
    isOrderCompletedStatus,
    isOrderTerminalStatus,
    log,
    normalizeReviewStatus,
    operationLogRows,
    persistContentMutation,
    persistTrashRecord,
    productAuditRows,
    reconciliationHoldRows,
    reconciliationTransferRows,
    scopedShops,
    spotDependencySummary,
    staffRows,
    state,
    statusMeta,
    switchMenu,
    syncDeleteToServer,
    tagRows,
    taskOrders,
    visibleReconciliationSettlementRows,
    watch
  } = ctx;

const WORKFLOW_STATUS_META = {
  awaiting_confirmation: { label: "待支付", color: "#F97316" },
  awaiting_deposit: { label: "待支付", color: "#F97316" },
  awaiting_dispatch: { label: "待安排摄影师", color: "#F59E0B" },
  awaiting_shoot: { label: "待安排摄影师", color: "#3B82F6" },
  shooting: { label: "待安排摄影师", color: "#3B82F6" },
  selection_pending: { label: "已拍摄", color: "#F97316" },
  awaiting_delivery: { label: "已拍摄", color: "#F97316" },
  awaiting_final_payment: { label: "已拍摄", color: "#F97316" },
  paid: { label: "已支付", color: "#10B981" },
  delivered: { label: "已交付", color: "#10B981" },
  completed: { label: "已交付", color: "#10B981" },
  cancelled: { label: "已取消", color: "#6B7280" }
};
function orderWorkflowStatusMeta(row) {
  const stage = String(row && row.workflowStage || "");
  return WORKFLOW_STATUS_META[stage] || statusMeta(row && row.status);
}
function orderWorkflowStatusLabel(row) { return (orderWorkflowStatusMeta(row) || {}).label || "-"; }
function isFinanceLocked(order) {
  if (!order) return false;
  return Boolean(order.financeLocked) || order.finalFinanceStatus === "已锁" || order.depositFinanceStatus === "已锁";
}
function canOpenOrderForEdit(order) {
  if (!order) return false;
  return !isOrderCompletedStatus(order) && !isOrderCancelledStatus(order) && !isFinanceLocked(order);
}
// 订单锁定原因汇总：订单抽屉顶部「订单锁定提醒」横幅的数据来源。
// 汇总财务锁定 / 售后处理中 / 风控冻结 / 已完结已取消四类原因，让客服一眼看清当前为什么不能改。
function orderLockReasons(order) {
  if (!order) return [];
  const reasons = [];
  if (isFinanceLocked(order)) reasons.push("财务已锁定：收款核对期间金额与状态暂不可修改");
  if (isOrderAfterSaleLocked(order)) reasons.push("售后处理中：完结、取消、转派与金额修改暂不可用");
  if (hasRiskBlock(order)) reasons.push(`风控冻结：${order.freezeReason || "存在风险标记，请联系管理员核实"}`);
  if (isOrderCompletedStatus(order)) reasons.push("订单已完成：仅支持查看与补充记录");
  if (isOrderCancelledStatus(order)) reasons.push("订单已取消：仅保留历史信息，不可再修改");
  return reasons;
}
// 是否可调整订单加购商品：编辑权限 + 订单未完结未取消 + 无售后/财务/风控锁
function canManageOrderAddons(order) {
  if (!order) return false;
  if (!canEditCurrentOrder()) return false;
  if (isOrderTerminalStatus(order)) return false;
  if (isOrderAfterSaleLocked(order) || isFinanceLocked(order) || hasRiskBlock(order)) return false;
  return true;
}
// 是否可登记定金：编辑权限 + 定金未在审/已审 + 订单未完结未取消 + 无锁定
function canRegisterDepositPayment(order) {
  if (!order) return false;
  if (!canEditCurrentOrder()) return false;
  if (["待审", "已审"].includes(normalizeReviewStatus(order.depositFinanceStatus))) return false;
  if (isOrderTerminalStatus(order)) return false;
  if (isOrderAfterSaleLocked(order) || isFinanceLocked(order) || hasRiskBlock(order)) return false;
  return true;
}
// 定金登记不可用原因：与 canRegisterDepositPayment 一一对应，用于按钮悬浮提示
function depositPaymentDisabledReason(order) {
  if (!order) return "当前没有打开的订单";
  if (!canEditCurrentOrder()) return "当前角色或订单状态不允许编辑收款";
  const status = normalizeReviewStatus(order.depositFinanceStatus);
  if (status === "待审") return "定金已提交财务审核，请等待财务确认";
  if (status === "已审") return "定金已通过财务审核，如需调整请联系财务处理";
  if (isOrderTerminalStatus(order)) return "订单已完结或取消，不能再登记定金";
  if (isOrderAfterSaleLocked(order)) return "售后处理中，收款暂不可修改";
  if (isFinanceLocked(order)) return "财务已锁定该订单，收款暂不可修改";
  if (hasRiskBlock(order)) return "订单风控冻结中，请联系管理员核实";
  return "可填写定金金额并确认登记";
}
function selectedOrderActionDisabledReason(rows, action) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `请先选择订单再执行${action || "操作"}`;
  const locked = list.find((o) => isFinanceLocked(o));
  if (locked) return `订单 ${locked.orderNo} 已被财务锁定，无法${action || "操作"}`;
  return "";
}
function taskActionDisabledReason(task) {
  if (!task) return "任务不存在";
  if (task.status === "done") return "任务已完成";
  if (task.status === "processing") return "任务进行中";
  return "";
}
const orderDateShortcuts = [
  { text: "今天", value: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return [d, d]; } },
  { text: "昨天", value: () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return [d, d]; } },
  { text: "近 7 天", value: () => { const e = new Date(); const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - 6); return [s, e]; } },
  { text: "近 30 天", value: () => { const e = new Date(); const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - 29); return [s, e]; } },
  { text: "本月", value: () => { const e = new Date(); const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(1); return [s, e]; } },
];
function dashboardSetDateShortcut(range) {
  if (!range) return;
  const start = new Date();
  const end = new Date();
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  if (range === "yesterday") { start.setDate(start.getDate() - 1); end.setTime(start.getTime()); }
  else if (range === "7") start.setDate(start.getDate() - 6);
  else if (range === "30") start.setDate(start.getDate() - 29);
  else if (range === "month") start.setDate(1);
  else if (range === "custom") { state.dashboardShortcut = "custom"; return; }
  state.dashboardShortcut = range;
  state.filters.dateRange = [start, end];
  state.dashboardDateRange = state.filters.dateRange;
}
function handleDashboardRiskAlert(alert) {
  if (!alert) return;
  ElMessageBox.alert(alert.detail || alert.message || "检测到风险预警，请关注。", alert.title || "风控提醒", { type: "warning" });
}
function logSnapshotSummary(snapshot) {
  if (!snapshot) return "暂无快照";
  return `${snapshot.operator || "系统"} 于 ${snapshot.time || snapshot.createdAt || "-"} 操作 ${snapshot.action || ""}`;
}
function showLogSnapshot(snapshot) {
  ElMessageBox.alert(logSnapshotSummary(snapshot), "操作快照", { type: "info" });
}
function trashRestoreCheck(item) {
  if (!item) return "回收项不存在";
  if (item.restored) return "该记录已恢复";
  if (item.restorable === false) return "该记录不可恢复";
  return "";
}
function openContentLogs(key) {
  state.logFilterKey = key || "";
  switchMenu("logs");
}
function openSpotRelation(spot) {
  if (!spot) return;
  const summary = spotDependencySummary(spot);
  const lines = [
    `打卡点：${spot.name}`,
    `关联拍摄风格：${summary.series || 0}`,
    `关联照片单品：${summary.albums || 0}`,
    `关联商品：${summary.products || 0}`,
    `关联订单：${summary.orders || 0}`,
  ];
  ElMessageBox.alert(lines.join("<br>"), `打卡点「${spot.name}」关联关系`, { dangerouslyUseHTMLString: true, type: "info" });
}
function shelfVisibilityState(item) {
  if (!item) return { label: "未知", color: "#94a3b8" };
  if (item.visible === false || item.status === "下架" || item.status === "停用") return { label: "已下架", color: "#94a3b8" };
  if (item.status === "待审") return { label: "待审核", color: "#F59E0B" };
  return { label: "已上架", color: "#10B981" };
}
function focusPackageModule(id) { state.packageModuleFocus = id || ""; }
function packageModuleOpen(id) { state.packageModuleOpenId = id || ""; state.packageModuleDialog = true; }
function setPackageModules(list) {
  if (!state.editContent) return;
  state.editContent.modules = Array.isArray(list) ? list.slice() : [];
}
function togglePackageModule(m) {
  if (!state.editContent) return;
  if (!Array.isArray(state.editContent.modules)) state.editContent.modules = [];
  const key = m && (m.id || m);
  const idx = state.editContent.modules.findIndex((x) => (x && (x.id || x)) === key);
  if (idx >= 0) state.editContent.modules.splice(idx, 1);
  else state.editContent.modules.push(m);
}
async function moveAlbumSample(sample, targetAlbumId) {
  if (!sample) return;
  if (!targetAlbumId) return ElMessage.warning("请选择目标照片单品后再移动");
  const album = (data.albums || []).find((a) => a.id === targetAlbumId);
  if (!album) return ElMessage.warning("目标照片单品不存在");
  const sampleId = sample.id || sample._id;
  const previousAlbumId = sample.albumId || (data.albums || []).find((candidate) => (candidate.photoIds || []).map(String).includes(String(sampleId)))?.id;
  const oldAlbum = previousAlbumId && String(previousAlbumId) !== String(targetAlbumId)
    ? (data.albums || []).find((candidate) => String(candidate.id || candidate._id || "") === String(previousAlbumId))
    : null;
  const previousSample = { ...sample };
  const previousOldAlbum = oldAlbum ? { ...oldAlbum, photoIds: Array.isArray(oldAlbum.photoIds) ? [...oldAlbum.photoIds] : [] } : null;
  const previousAlbum = { ...album, photoIds: Array.isArray(album.photoIds) ? [...album.photoIds] : [] };
  sample.albumId = targetAlbumId;
  if (album.seriesId !== undefined) sample.seriesId = album.seriesId;
  if (album.spotId !== undefined) sample.spotId = album.spotId;
  if (oldAlbum) {
    oldAlbum.photoIds = (oldAlbum.photoIds || []).filter((id) => String(id) !== String(sampleId || ""));
  }
  if (!Array.isArray(album.photoIds)) album.photoIds = [];
  if (!album.photoIds.map(String).includes(String(sampleId || ""))) album.photoIds.push(sampleId);
  const rollback = async () => {
    Object.assign(sample, previousSample);
    if (oldAlbum && previousOldAlbum) { Object.assign(oldAlbum, previousOldAlbum); }
    Object.assign(album, previousAlbum);
    await persistContentMutation("samples", sample, null);
    if (oldAlbum && previousOldAlbum) await persistContentMutation("albums", oldAlbum, null);
    await persistContentMutation("albums", album, null);
  };
  if (!(await persistContentMutation("samples", sample, previousSample))) return;
  if (oldAlbum && !(await persistContentMutation("albums", oldAlbum, previousOldAlbum))) { await rollback(); return; }
  if (!(await persistContentMutation("albums", album, previousAlbum))) { await rollback(); return; }
  log("移动样片", "照片单品", `${sample.name || sample.id} -> ${album.name}`);
  ElMessage.success("样片已移动到目标照片单品");
}
async function requestDeleteSample(sample) {
  if (!sample) return;
  const previous = { ...sample };
  sample.deleted = true;
  sample.isDeleted = true;
  if (!(await persistContentMutation("samples", sample, previous))) return;
  if (!(await persistTrashRecord({ id: `trash${Date.now()}`, type: "样片", sourceKey: "samples", name: sample.name || "样片", reason: "删除样片", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...sample } }))) {
    Object.assign(sample, previous);
    await persistContentMutation("samples", sample, null);
    return;
  }
  log("删除样片进入回收站", "照片单品", sample.name || "样片");
  ElMessage.success("样片已进入回收站，可在 30 天内恢复");
}
function undoTagReplacement(tag) {
  if (!tag || !tag._replacedBy) return ElMessage.info("该标签没有可撤销的替换");
  tag._replacedBy = null;
  tag.replaced = false;
  log("撤销标签替换", "标签管理", tag.name || "标签");
  ElMessage.success("已撤销标签替换");
}
function auditChangeSummary(audit) {
  if (!audit) return "暂无审核记录";
  return `${audit.operator || "系统"} 于 ${audit.time || "-"} ${audit.action || "审核"}：${audit.detail || ""}`;
}
function showProductAuditCompare(audit) {
  ElMessageBox.alert(auditChangeSummary(audit), "商品审核变更对比", { type: "info" });
}

// 通用列表分页：每张主列表一个 key，pagedList 给表格切片；筛选结果行数变化时自动回到第 1 页
function pager(key, size = 12) {
  if (!state.listPage[key]) state.listPage[key] = { page: 1, size };
  return state.listPage[key];
}
function pagedList(key, rows) {
  const cfg = pager(key);
  const list = Array.isArray(rows) ? rows : [];
  const pages = Math.max(1, Math.ceil(list.length / cfg.size));
  if (cfg.page > pages) cfg.page = pages;
  return list.slice((cfg.page - 1) * cfg.size, cfg.page * cfg.size);
}
function onListPageSizeChange(key, size) {
  const cfg = pager(key);
  cfg.size = size;
  cfg.page = 1;
}
const pagerWatchSources = {
  staff: staffRows, shops: scopedShops, distributors: distributorRows, tags: tagRows,
  trash: computed(() => state.trash), logs: operationLogRows, shelf: contentRows, tasks: taskOrders,
  afterSaleActive: activeAfterSaleRows, afterSaleRecords: afterSaleRecordRows,
  financeReview: financeReviewOrderRows, financeReviewRecords: financeReviewRecordRows,
  productAudit: productAuditRows, reconSettlement: visibleReconciliationSettlementRows,
  reconHold: reconciliationHoldRows, reconTransfer: reconciliationTransferRows,
  reconAdjustments: adjustmentRecordRows
};
Object.entries(pagerWatchSources).forEach(([key, source]) => {
  watch(() => source.value.length, () => { if (state.listPage[key]) state.listPage[key].page = 1; });
});


  return {
    orderWorkflowStatusMeta,
    orderWorkflowStatusLabel,
    isFinanceLocked,
    canOpenOrderForEdit,
    orderLockReasons,
    canManageOrderAddons,
    canRegisterDepositPayment,
    depositPaymentDisabledReason,
    selectedOrderActionDisabledReason,
    taskActionDisabledReason,
    orderDateShortcuts,
    dashboardSetDateShortcut,
    handleDashboardRiskAlert,
    logSnapshotSummary,
    showLogSnapshot,
    trashRestoreCheck,
    openContentLogs,
    openSpotRelation,
    shelfVisibilityState,
    focusPackageModule,
    packageModuleOpen,
    setPackageModules,
    togglePackageModule,
    moveAlbumSample,
    requestDeleteSample,
    undoTagReplacement,
    auditChangeSummary,
    showProductAuditCompare,
    pager,
    pagedList,
    onListPageSizeChange,
    pagerWatchSources
  };
});
