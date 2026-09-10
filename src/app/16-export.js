// 当前页组件与数据导出
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    activeMenu,
    activeRouteKey,
    adjustmentRecordRows,
    afterSaleRows,
    cityRank,
    commission,
    computed,
    confirmedRefund,
    currentOperatorName,
    dashboard,
    distributorName,
    distributorRateForShop,
    financeDue,
    financeReviewRows,
    log,
    menus,
    netOrderAmount,
    orderDistributorIds,
    orderShop,
    orderSourceName,
    orderSourceTypeText,
    photographers,
    reconciliation,
    reconciliationHoldRows,
    reconciliationSummary,
    reconciliationTransferMonth,
    reconciliationTransferRows,
    roleProfile,
    scopedOrders,
    scopedScans,
    scopedShops,
    servicePerformanceRows,
    services,
    settlementIncomeType,
    shopName,
    shopRank,
    staffName,
    state,
    statusMeta,
    taskOrders,
    visibleDistributors,
    visiblePhone,
    visibleReconciliationSettlementRows
  } = ctx;

const activePageComponent = computed(() => window.LXM_PAGES?.componentNameFor(activeRouteKey.value) || "LxmPageDashboard");
const activePageMeta = computed(() => window.LXM_PAGES?.pageFor(activeRouteKey.value) || {});
const exportOptions = computed(() => {
  const all = [
    { key: "dashboardSummary", menu: "dashboard", name: "经营汇总报表", desc: "导出当前经营看板核心指标、扫码转化、收款进度。", rows: 1, roles: ["super", "agent", "distributor", "merchant", "service", "finance"] },
    { key: "scanDetail", menu: "dashboard", name: "扫码明细报表", desc: "导出扫码日期、时段、城市、代理、分销员、商家、二维码位置和转化状态。", rows: scopedScans.value.length, roles: ["super", "agent", "distributor", "merchant"] },
    { key: "convertedOrders", menu: "dashboard", name: "扫码转化订单", desc: "导出由扫码产生的预约订单、成交额、已收和待收。", rows: scopedOrders.value.filter((o) => scopedScans.value.some((s) => s.orderId === o.id)).length, roles: ["super", "agent", "distributor", "merchant", "service", "finance"] },
    { key: "orderDetail", menu: "orders", name: "订单明细报表", desc: "导出当前筛选范围内全部订单明细。", rows: scopedOrders.value.length, roles: ["super", "agent", "distributor", "merchant", "service", "finance"] },
    { key: "taskOrders", menu: "tasks", name: "我的任务报表", desc: "导出当前摄影师账号可见的拍摄任务、预约时间、订单状态和售后标识。", rows: taskOrders.value.length, roles: ["photo"] },
    { key: "shopRank", menu: "shops", name: "商家来源排行", desc: "导出商家扫码、订单、成交额排行。", rows: shopRank.value.length, roles: ["super", "agent", "distributor"] },
    { key: "cityRank", menu: "dashboard", name: "城市排行报表", desc: "导出各城市商家数、订单数、成交额。", rows: cityRank.value.length, roles: ["super", "agent"] },
    { key: "financeReview", menu: "financeReview", name: "财务审核报表", desc: "导出预约定金、收尾款、退款审核明细和审核状态。", rows: financeReviewRows.value.length, roles: ["super", "finance"] },
    { key: "reconciliationPlatform", menu: "reconciliation", name: "全平台月度汇总表", desc: "仅超管/财务可导出，包含全量订单、分账、退款、冲正、结算数据。", rows: scopedOrders.value.length + visibleReconciliationSettlementRows.value.length + adjustmentRecordRows.value.length, roles: ["super", "finance"] },
    { key: "auditLogs", menu: "logs", name: "操作审计日志", desc: "导出当前后台操作日志，包含财务审计风险级别和金额字段。", rows: state.logs.length, roles: ["super", "finance"] },
    { key: "afterSales", menu: "afterSales", name: "售后服务报表", desc: "导出售后处理中与已完成售后记录、退款审核状态和关联订单。", rows: afterSaleRows.value.length, roles: ["super", "agent", "distributor", "service", "finance"] },
  ];
  const roleAllowed = state.role === "super" ? all : all.filter((item) => roleProfile.value.menus.includes(item.menu) && item.roles.includes(state.role));
  if (state.exportScopeMenu === "dashboard") return roleAllowed;
  return roleAllowed.filter((item) => item.menu === state.exportScopeMenu);
});
const selectedExportOption = computed(() => exportOptions.value.find((item) => item.key === state.exportType) || exportOptions.value[0] || null);
const reconciliationExportTargetOptions = computed(() => {
  const groups = [];
  if (["super", "finance"].includes(state.role)) {
    groups.push({ label: "全部可见对象", value: "", type: "", id: "" });
    scopedShops.value.forEach((row) => groups.push({ label: `商家 · ${row.name}`, value: `shop:${row.id}`, type: "shop", id: row.id }));
    visibleDistributors.value.forEach((row) => groups.push({ label: `分销"· ${row.name}`, value: `distributor:${row.id}`, type: "distributor", id: row.id }));
    photographers.value.forEach((row) => groups.push({ label: `摄影"· ${row.name}`, value: `photo:${row.id}`, type: "photo", id: row.id }));
    services.value.forEach((row) => groups.push({ label: `客服 · ${row.name}`, value: `service:${row.id}`, type: "service", id: row.id }));
  }
  return groups;
});
const exportTargetValue = computed({
  get() {
    return state.exportTargetType && state.exportTargetId ? `${state.exportTargetType}:${state.exportTargetId}` : "";
  },
  set(value) {
    const [type, id] = String(value || "").split(":");
    state.exportTargetType = type || "";
    state.exportTargetId = id || "";
  },
});
function selectedReconciliationExportRows() {
  const type = state.exportTargetType;
  const id = state.exportTargetId;
  if (["super", "finance"].includes(state.role)) {
    if (!type || !id) return visibleReconciliationSettlementRows.value;
    if (type === "service") return servicePerformanceRows.value.filter((row) => row.id === id);
    return visibleReconciliationSettlementRows.value.filter((row) => row.type === type && row.id === id);
  }
  return visibleReconciliationSettlementRows.value;
}
function selectedReconciliationExportTransfers() {
  const type = state.exportTargetType;
  const id = state.exportTargetId;
  if (["super", "finance"].includes(state.role)) {
    if (!type || !id) return reconciliationTransferRows.value;
    if (type === "service") return [];
    return reconciliationTransferRows.value.filter((row) => row.objectId === id);
  }
  return reconciliationTransferRows.value;
}
function selectedReconciliationExportOrders() {
  const type = state.exportTargetType;
  const id = state.exportTargetId;
  if (["super", "finance"].includes(state.role) && type === "service" && id) {
    return scopedOrders.value.filter((order) => order.assigneeId === id);
  }
  const ids = new Set();
  selectedReconciliationExportRows().forEach((row) => (row.orderIds || []).forEach((orderId) => ids.add(orderId)));
  selectedReconciliationExportTransfers().forEach((row) => (row.orderIds || []).forEach((orderId) => ids.add(orderId)));
  return scopedOrders.value.filter((order) => ids.has(order.id));
}
function selectedReconciliationExportSummaryRows() {
  const rows = selectedReconciliationExportRows();
  const transfers = selectedReconciliationExportTransfers();
  const orders = selectedReconciliationExportOrders();
  const accruedAmount = rows.reduce((sum, row) => sum + Number(row.commission || row.performanceAmount || 0), 0);
  const settledAmount = transfers.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const netAmount = rows.reduce((sum, row) => sum + Number(row.amount || row.completedAmount || 0), 0);
  return [
    { "指标": "核对对象数量", "金额": "", "数量": rows.length, "说明": "当前导出范围内的结算主体或客服业绩对象数" },
    { "指标": "关联订单数量", "金额": "", "数量": orders.length, "说明": "当前主体对账单覆盖的订单数量" },
    { "指标": "入池净", "金额": netAmount, "数量": "", "说明": "满足入池条件后的净额；客服口径展示经手已完成净" },
    { "指标": "应计分成/业绩", "金额": accruedAmount, "数量": "", "说明": "商家、分销员、摄影师为应计分成；客服仅为经手业绩" },
    { "指标": "已确认结", "金额": settledAmount, "数量": transfers.length, "说明": "已生成结算台账的实结分成金额" },
    { "指标": "待确认结", "金额": Math.max(accruedAmount - settledAmount, 0), "数量": "", "说明": "应计金额 - 已确认结算金" },
  ];
}
const exportPreviewRowsCount = computed(() => {
  if (state.exportType === "reconciliationPersonal") return selectedReconciliationExportRows().length + selectedReconciliationExportTransfers().length + selectedReconciliationExportOrders().length;
  return selectedExportOption.value?.rows || 0;
});
function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}
function xmlEscape(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function downloadCsvFile(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  rows.forEach((row) => lines.push(headers.map((key) => csvEscape(row[key])).join(",")));
  const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
function downloadExcelWorkbook(filename, sheets) {
  const worksheets = sheets.map((sheet) => {
    const headers = sheet.headers || [];
    const rows = sheet.rows || [];
    const headerXml = `<Row>${headers.map((key) => `<Cell><Data ss:Type="String">${xmlEscape(key)}</Data></Cell>`).join("")}</Row>`;
    const rowsXml = rows.map((row) => `<Row>${headers.map((key) => {
      const value = row[key];
      const isNumber = typeof value === "number" && Number.isFinite(value);
      return `<Cell><Data ss:Type="${isNumber ? "Number" : "String"}">${xmlEscape(value)}</Data></Cell>`;
    }).join("")}</Row>`).join("");
    return `<Worksheet ss:Name="${xmlEscape(String(sheet.name || "Sheet").slice(0, 31))}"><Table>${headerXml}${rowsXml}</Table></Worksheet>`;
  }).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${worksheets}</Workbook>`;
  const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
function orderExportRow(order) {
  return {
    "订单": order.orderNo,
    "客户": order.customer,
    "手机": visiblePhone(order),
    "订单来源": orderSourceTypeText(order),
    "来源名称": orderSourceName(order),
    "商家": shopName(order.shopId),
    "分销": orderDistributorIds(order).map((id) => `${distributorName(id)} ${distributorRateForShop(orderShop(order), id)}%`).join("、") || "总部直营",
    "客服": staffName(order.assigneeId),
    "摄影": staffName(order.photographerId),
    "预约时间": order.appointmentAt,
    "订单状": statusMeta(order.status).label,
    "收入类型": settlementIncomeType(order),
    "订单总额": Number(order.totalAmount || 0),
    "已审退": confirmedRefund(order),
    "入池净": netOrderAmount(order),
    "财务待收": financeDue(order),
  };
}
function settlementExportRow(row) {
  return {
    "主体类型": row.typeName || row.objectType,
    "主体名称": row.name || row.objectName,
    "入池净": Number(row.amount || 0),
    "分成比例": row.rateText || (row.rateValue !== undefined ? `${row.rateValue}%` : ""),
    "应计金额": Number(row.commission || row.amount || 0),
    "结算周期": row.settlementCycle || "",
    "结算范围": row.settlementPeriod || row.period || "",
    "结算状": row.transferStatus || row.status || "",
    "封存时间": row.sealedAt || "",
    "封存": row.sealedBy || "",
    "关联订单": (row.orderNos || []).join(""),
  };
}
function servicePerformanceExportRow(row) {
  return {
    "主体类型": "客服",
    "主体名称": row.name,
    "经手订单": Number(row.totalOrders || 0),
    "可分订单": Number(row.orders || 0),
    "经手成交": Number(row.performanceAmount || 0),
    "已完成净额": Number(row.completedAmount || 0),
    "待收/暂缓": Number(row.pendingFollowAmount || 0),
    "分成比例": "不参与分成",
    "结算周期": "-",
    "结算状态": "仅业绩统计",
  };
}
function reconciliationCompositeExportRows(includePlatform = false) {
  const rows = [];
  rows.push({ "报表模块": "业务汇总", "主体类型": "汇总", "主体名称": "实际可分账净额", "金额": reconciliationSummary.value.eligibleAmount, "数量": reconciliationSummary.value.eligibleOrders, "说明": "全部入池条件通过后的订单实收基数合计" });
  rows.push({ "报表模块": "业务汇总", "主体类型": "汇总", "主体名称": "总部收入", "金额": reconciliationSummary.value.headquarterAmount, "数量": "", "说明": "实际可分账净额 - 商家应计 - 分销应计 - 摄影应计" });
  visibleReconciliationSettlementRows.value.forEach((row) => rows.push({
    "报表模块": "分账应计明细",
    "主体类型": row.typeName,
    "主体名称": row.name,
    "金额": Number(row.commission || row.settlementAmount || row.amount || 0),
    "数量": row.orders || row.orderCount || 0,
    "分成比例": row.rateText || "-",
    "结算周期": row.settlementCycle,
    "结算范围": row.period || row.settlementPeriod,
    "结算状态": row.transferStatus || row.status || "",
    "说明": `入池净额 ${Number(row.amount || 0)}，关联订单 ${(row.orderNos || []).join("、")}`,
  }));
  reconciliationHoldRows.value.forEach((row) => rows.push({ "报表模块": "暂缓订单", "主体类型": "订单", "主体名称": row.orderNo, "金额": Number(row.totalAmount || 0), "数量": 1, "结算状态": "暂缓", "说明": `${row.customer} / ${orderSourceTypeText(row)} / ${row.holdReason}` }));
  if (includePlatform) {
    reconciliationTransferRows.value.forEach((row) => rows.push({ "报表模块": "结算台账", "主体类型": row.objectType, "主体名称": row.objectName, "金额": Number(row.amount || 0), "数量": (row.orderNos || []).length, "结算周期": row.settlementCycle, "结算范围": row.period, "结算状态": row.status, "说明": `${row.time} ${row.operator}确认，${row.method || ""} ${row.voucherNo || ""}` }));
    adjustmentRecordRows.value.forEach((row) => rows.push({ "报表模块": "冲正台账", "主体类型": row.targetType, "主体名称": row.targetName, "金额": Number(row.amount || 0), "数量": 1, "结算状态": row.approvalStatus, "说明": `${row.type} / ${row.orderNo} / ${row.note || ""}` }));
  }
  return rows;
}
function reconciliationWorkbookSheets(includePlatform = false) {
  const summaryRows = [
    { "指标": "本月订单总额", "金额": reconciliationSummary.value.totalAmount, "数量": reconciliationSummary.value.totalOrders, "说明": "筛选范围内订单原始成交金额合计" },
    { "指标": "实际可分账净额", "金额": reconciliationSummary.value.eligibleAmount, "数量": reconciliationSummary.value.eligibleOrders, "说明": "全部入池条件通过后的订单实收基数合计" },
    { "指标": "预计可入分账池", "金额": reconciliationSummary.value.estimatedAmount, "数量": reconciliationSummary.value.estimatedOrders, "说明": "预算参考，不允许直接结算" },
    { "指标": "总部收入", "金额": reconciliationSummary.value.headquarterAmount, "数量": "", "说明": "实际可分账净额 - 商家应计 - 分销应计 - 摄影应计" },
  ];
  return [
    { name: "业务汇总", headers: ["指标", "金额", "数量", "说明"], rows: summaryRows },
    { name: "分账应计明细", headers: ["主体类型", "主体名称", "入池净额", "分成比例", "应计金额", "结算周期", "结算范围", "结算状态", "封存时间", "封存人", "关联订单"], rows: visibleReconciliationSettlementRows.value.map(settlementExportRow) },
    { name: "暂缓订单", headers: ["订单", "客户", "订单来源", "商家", "订单总额", "暂缓原因", "预约时间", "订单状态"], rows: reconciliationHoldRows.value.map((row) => ({ "订单": row.orderNo, "客户": row.customer, "订单来源": orderSourceTypeText(row), "商家": shopName(row.shopId), "订单总额": Number(row.totalAmount || 0), "暂缓原因": row.holdReason, "预约时间": row.appointmentAt, "订单状态": statusMeta(row.status).label })) },
  ];
}
function reconciliationPersonalWorkbookSheets() {
  const rows = selectedReconciliationExportRows();
  const isServiceExport = state.exportTargetType === "service" || rows.some((row) => row.type === "service");
  const detailRows = isServiceExport ? rows.map(servicePerformanceExportRow) : rows.map(settlementExportRow);
  const detailHeaders = isServiceExport
    ? ["主体类型", "主体名称", "经手订单", "可分订单", "经手成交", "已完成净额", "待收/暂缓", "分成比例", "结算周期", "结算状态"]
    : ["主体类型", "主体名称", "入池净额", "分成比例", "应计金额", "结算周期", "结算范围", "结算状态", "封存时间", "封存人", "关联订单"];
  return [
    { name: "主体摘要", headers: ["指标", "金额", "数量", "说明"], rows: selectedReconciliationExportSummaryRows() },
    { name: isServiceExport ? "客服业绩" : "分账应计", headers: detailHeaders, rows: detailRows },
    { name: "关联订单", headers: ["订单", "客户", "手机", "订单来源", "来源名称", "商家", "分销", "客服", "摄影", "预约时间", "订单状态", "收入类型", "订单总额", "已审退款", "入池净额", "财务待收"], rows: selectedReconciliationExportOrders().map(orderExportRow) },
  ];
}
function exportRowsForOption(key) {
  if (key === "reconciliation" || key === "reconciliationPlatform") return { headers: ["报表模块", "主体类型", "主体名称", "金额", "数量", "分成比例", "结算周期", "结算范围", "结算状态", "说明"], rows: reconciliationCompositeExportRows(key === "reconciliationPlatform"), sheets: reconciliationWorkbookSheets(key === "reconciliationPlatform") };
  if (key === "reconciliationPersonal") {
    const rows = selectedReconciliationExportRows();
    if (state.exportTargetType === "service") return { headers: ["主体类型", "主体名称", "经手订单", "可分订单", "经手成交", "已完成净额", "待收/暂缓", "分成比例", "结算周期", "结算状态"], rows: rows.map(servicePerformanceExportRow), sheets: reconciliationPersonalWorkbookSheets() };
    return { headers: ["主体类型", "主体名称", "入池净额", "分成比例", "应计金额", "结算周期", "结算范围", "结算状态", "封存时间", "封存人", "关联订单"], rows: rows.map(settlementExportRow), sheets: reconciliationPersonalWorkbookSheets() };
  }
  if (key === "servicePerformancePersonal") return { headers: ["主体类型", "主体名称", "经手订单", "可分订单", "经手成交", "已完成净额", "待收/暂缓", "分成比例", "结算周期", "结算状态"], rows: servicePerformanceRows.value.map(servicePerformanceExportRow) };
  if (key === "reconciliationHold") return { headers: ["订单", "客户", "订单来源", "商家", "订单总额", "暂缓原因", "预约时间", "订单状态"], rows: reconciliationHoldRows.value.map((row) => ({ "订单": row.orderNo, "客户": row.customer, "订单来源": orderSourceTypeText(row), "商家": shopName(row.shopId), "订单总额": Number(row.totalAmount || 0), "暂缓原因": row.holdReason, "预约时间": row.appointmentAt, "订单状态": statusMeta(row.status).label })) };
  if (key === "financeReview") return { headers: ["订单", "客户", "审核项目", "金额", "状态", "提交时间", "备注"], rows: financeReviewRows.value.map((row) => ({ "订单": row.orderNo, "客户": row.customer, "审核项目": row.type, "金额": Number(row.amount || 0), "状态": row.status, "提交时间": row.createdAt, "备注": row.note })) };
  return { headers: ["订单", "客户", "手机", "订单来源", "来源名称", "商家", "分销", "客服", "摄影", "预约时间", "订单状态", "订单总额", "已审退款", "入池净额", "财务待收"], rows: scopedOrders.value.map(orderExportRow) };
}
function openExportDialog(defaultType = "") {
  const currentMenu = activeMenu.value?.key || state.active || "dashboard";
  state.exportScopeMenu = currentMenu === "dashboard" ? "dashboard" : currentMenu;
  const options = exportOptions.value;
  if (!options.length) return ElMessage.warning("当前页面暂无可导出的报表");
  const preferred = defaultType || (activeMenu.value.key === "reconciliation" && ["merchant", "distributor", "photo"].includes(state.role) ? "reconciliationPersonal" : activeMenu.value.key === "reconciliation" ? "reconciliation" : "dashboardSummary");
  state.exportType = options.some((item) => item.key === preferred) ? preferred : options[0].key;
  if (state.exportType !== "reconciliationPersonal") {
    state.exportTargetType = "";
    state.exportTargetId = "";
  }
  state.exportDialog = true;
}
function confirmExport() {
  const option = selectedExportOption.value;
  if (!option) return ElMessage.warning("当前角色暂无可导出的报表");
  const payload = exportRowsForOption(option.key);
  const month = reconciliationTransferMonth();
  const targetName = state.exportType === "reconciliationPersonal" && state.exportTargetType ? `-${(reconciliationExportTargetOptions.value.find((item) => item.value === exportTargetValue.value) || {}).label || "指定对象"}` : "";
  const ext = payload.sheets ? "xls" : "csv";
  const safeName = `${option.name}${targetName}-${month}-${LXMFormat.date(new Date())}.${ext}`.replace(/[\\/:*?"<>|]/g, "-");
  if (payload.sheets) downloadExcelWorkbook(safeName, payload.sheets);
  else downloadCsvFile(safeName, payload.headers, payload.rows);
  log("导出报表", option.name, `当前筛选范围导出 ${payload.rows.length} 条`, currentOperatorName(), { module: activeMenu.value.key === "reconciliation" ? "财务审计" : "系统操作", level: "中", objectType: "报表", objectName: option.name, snapshot: targetName || "当前筛选范围" });
  state.exportDialog = false;
  ElMessage.success(`已导出：${option.name}，共 ${payload.rows.length} 条`);
}
function exportCsv() {
  openExportDialog();
}

// ===== 补全模板引用但未实现的辅助函数（修复页面渲染崩溃 / 按钮无响应） =====

  return {
    activePageComponent,
    activePageMeta,
    exportOptions,
    selectedExportOption,
    reconciliationExportTargetOptions,
    exportTargetValue,
    selectedReconciliationExportRows,
    selectedReconciliationExportTransfers,
    selectedReconciliationExportOrders,
    selectedReconciliationExportSummaryRows,
    exportPreviewRowsCount,
    csvEscape,
    xmlEscape,
    downloadCsvFile,
    downloadExcelWorkbook,
    orderExportRow,
    settlementExportRow,
    servicePerformanceExportRow,
    reconciliationCompositeExportRows,
    reconciliationWorkbookSheets,
    reconciliationPersonalWorkbookSheets,
    exportRowsForOption,
    openExportDialog,
    confirmExport,
    exportCsv
  };
});
