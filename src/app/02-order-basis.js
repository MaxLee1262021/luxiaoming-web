// 权限、金额计算、日志与订单领域基础函数
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    computed,
    currentStaff,
    data,
    roleProfile,
    schedulePersist,
    state,
    statusDict
  } = ctx;

const CONTENT_EDIT_ROUTES = new Set([
  "contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags",
  "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "addonServices",
  "miniDecor", "miniConfig", "guides", "stories"
]);
const MENU_ACTION_ROUTES = {
  dashboard: ["dashboard"],
  dashboardAll: ["dashboard"],
  dashboardShop: ["dashboard"],
  orderAll: ["orders"],
  orderSelf: ["orders", "tasks"],
  orderStatus: ["orders"],
  orderEdit: ["orders"],
  assign: ["orders"],
  transfer: ["orders"],
  cancelOrder: ["orders"],
  dispatch: ["orders"],
  financeReview: ["financeReview", "reconciliation"],
  staff: ["staff"],
  shop: ["shops"],
  shopEdit: ["shops"],
  shopCreate: ["shops"],
  distributorEdit: ["shops", "distributors"],
  shootUpdate: ["tasks"],
  export: ["dashboard", "orders", "afterSales", "tasks", "shops", "financeReview", "reconciliation", "logs"],
  permissionManage: ["permissions"]
};
const BUILTIN_ACTION_CAPS = {
  super: new Set(["*"]),
  service: new Set(["view", "dashboard", "orderEdit", "assign", "transfer", "cancelOrder", "export"]),
  finance: new Set(["view", "dashboard", "financeReview", "export"]),
  photo: new Set(["view", "shootUpdate"]),
  merchant: new Set(["view", "dashboard", "export"]),
  distributor: new Set(["view", "dashboard", "export"]),
  content: new Set(["view", "contentEdit"]),
  agent: new Set(["view", "dashboard", "export"])
};
function grantedRouteKeys() {
  const allowed = new Set((roleProfile.value.menus || []).map(String));
  return new Set((LXM_CONFIG.menus || [])
    .filter((menu) => menu && allowed.has(String(menu.key)) && !["停用", "disabled", "inactive"].includes(String(menu.status || "").trim().toLowerCase()))
    .map((menu) => String(menu.routeKey || menu.targetKey || menu.key)));
}
function can(action) {
  const routes = grantedRouteKeys();
  if (!routes.size) return false;
  if (action === "*") return state.role === "super";
  const capability = action === "content" ? "contentEdit" : action;
  const roleCaps = BUILTIN_ACTION_CAPS[state.role];
  if (roleCaps && !roleCaps.has("*") && !roleCaps.has(capability)) return false;
  if (capability === "view") return true;
  if (capability === "contentEdit") return [...CONTENT_EDIT_ROUTES].some((route) => routes.has(route));
  if (capability === "permissionManage") return state.role === "super" && routes.has("permissions");
  return (MENU_ACTION_ROUTES[capability] || []).some((route) => routes.has(route));
}
function roleName(key) {
  return (LXM_CONFIG.roles[key] || {}).name || key;
}
function money(n) {
  return "¥" + Math.round(Number(n || 0)).toLocaleString("zh-CN");
}
function paid(order) {
  return Number(order?.depositPaid || 0) + Number(order?.finalPaid || 0);
}
function financePaid(order) {
  const deposit = normalizeReviewStatus(order?.depositFinanceStatus) === "已审" ? Number(order.depositPaid || 0) : 0;
  const final = normalizeReviewStatus(order?.finalFinanceStatus) === "已审" ? Number(order.finalPaid || 0) : 0;
  return deposit + final;
}
function orderDiscount(order) {
  return Number(order?.finalDiscountAmount || 0);
}
function expectedFinalAmount(order) {
  return Math.max(Number(order?.totalAmount || 0) - Number(order?.depositPaid || 0) - orderDiscount(order), 0);
}
function finalGap(order) {
  return Math.max(expectedFinalAmount(order) - Number(order?.finalPaid || 0), 0);
}
function financePendingAmount(order) {
  const deposit = normalizeReviewStatus(order?.depositFinanceStatus) === "已审" ? 0 : Number(order?.depositPaid || 0);
  const final = normalizeReviewStatus(order?.finalFinanceStatus) === "已审" ? 0 : Number(order?.finalPaid || 0);
  return deposit + final;
}
function due(order) {
  return finalGap(order);
}
function financeDue(order) {
  return Math.max(Number(order?.totalAmount || 0) - financePaid(order) - orderDiscount(order), 0);
}
function confirmedRefund(order) {
  return data.afterSales
    .filter((item) => item.orderId === order?.id && normalizeAfterSaleStatus(item.status) === "已完成" && normalizeReviewStatus(item.financeStatus) === "已审" && Number(item.refundAmount || item.amount || 0) > 0)
    .reduce((sum, item) => sum + Number(item.refundAmount || item.amount || 0), Number(order?.refundAmount || 0));
}
function retainedCancelledAmount(order) {
  if (!isOrderCancelledStatus(order)) return 0;
  return Math.max(financePaid(order) - confirmedRefund(order), 0);
}
function isRetainedCancelledOrder(order) {
  return retainedCancelledAmount(order) > 0;
}
function netOrderAmount(order) {
  if (isRetainedCancelledOrder(order)) return retainedCancelledAmount(order);
  return Math.max(financePaid(order) - confirmedRefund(order), 0);
}
function auditedReceiptBase(order) {
  return financePaid(order) - confirmedRefund(order);
}
function settlementIncomeType(order) {
  return isRetainedCancelledOrder(order) ? "中止留存收入" : "正常完成收入";
}
function inferLogModule(action = "", target = "") {
  const text = `${action} ${target}`;
  if (/结算|分账|对账|关账|封存|解封|冲正|调账|导出|退款|财务/.test(text)) return "财务审计";
  if (/订单|客服|派单|改期|交付|尾款|定金/.test(text)) return "订单履约";
  if (/商品|套餐|周边|打卡|上下架|内容/.test(text)) return "内容商品";
  if (/商家|分销|人员|权限|账号/.test(text)) return "渠道人员";
  return "系统操作";
}
function inferLogLevel(action = "", detail = "") {
  const text = `${action} ${detail}`;
  if (/冲正|解锁|解封|关账|封存|退款|大额|删除|清空|风控/.test(text)) return "高";
  if (/结算|审核|导出|修改|恢复|提前结束/.test(text)) return "中";
  return "低";
}
function log(action, target, detail, operator = roleProfile.value.name, meta = {}) {
  const module = meta.module || inferLogModule(action, target);
  const level = meta.level || inferLogLevel(action, detail);
  const entry = {
    id: meta.id || `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    time: LXMFormat.nowText(),
    user: operator,
    action,
    target,
    detail,
    module,
    level,
    amount: meta.amount ?? "",
    objectType: meta.objectType || "",
    objectName: meta.objectName || target,
    snapshot: meta.snapshot || "",
  };
  state.logs.unshift(entry);
  const session = window.LXM_AUTH?.getSession?.();
  const dynamicRole = !!(session && (session.roleId || session.permissionsConfigured || session.permissionSource));
  const canWriteAudit = !dynamicRole || (Array.isArray(session?.menuKeys) && session.menuKeys.includes("logs"));
  if (ctx.isServerConnected() && canWriteAudit) {
    // 联网模式：审计日志实时写回服务端 logs 集合（fire-and-forget，失败不阻塞操作、不重复弹窗）。
    window.LXM_CLOUD.create("logs", entry).catch(() => {});
  } else if (!(window.LXM_CLOUD && window.LXM_CLOUD.loadAdminData)) {
    schedulePersist();
  }
  return entry;
}
function currentOperatorName() {
  return currentStaff.value?.name || roleProfile.value.name;
}
function resetPageState() {
  Object.assign(state.filters, {
    dateRange: "",
    cityId: "",
    agentId: "",
    distributorId: "",
    shopId: "",
    sourceType: "",
    status: "",
    financeStatus: "",
    afterSaleStatus: "",
    refundStatus: "",
    transferStatus: "",
    rescheduleStatus: "",
    assigneeId: "",
    photographerId: "",
    productType: "",
    logUser: "",
    logModule: "",
    logLevel: "",
    logAction: "",
    keyword: "",
    staffRole: "",
    reconcileMonth: "",
    contentStatus: "",
    contentSpotId: "",
    contentSeriesId: "",
  });
  state.selectedOrderIds = [];
  state.dashboardDrill = "";
  state.contentScope = { type: "", id: "" };
}
function timelineText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  return `${item.time} ${item.operator} ${item.action}`;
}
function addOrderTimeline(order, action, operator) {
  if (!order) return;
  const actor = operator || currentOperatorName();
  const item = { time: LXMFormat.nowText(), operator: actor, action };
  order.statusLogs = order.statusLogs || [];
  order.statusLogs.unshift(item);
  log("订单操作", order.orderNo, action, actor);
  return item;
}

// Critical fulfilment actions must be acknowledged by the server.  The helper
// keeps the UI object in sync with the authoritative response and makes a
// failed write visible instead of leaving a success-only local mutation.
async function persistOrderAction(order, action, payload = {}) {
  const id = order && (order.id || order._id);
  if (!id) throw new Error("订单缺少标识，无法保存");
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  const connected = window.LXM_AUTH && window.LXM_AUTH.hasSession && window.LXM_AUTH.hasSession()
    && window.LXM_CLOUD_MODE !== "mock" && reachable !== false;
  if (!connected || !window.LXM_CLOUD || !window.LXM_CLOUD.orderAction) {
    if (payload && payload.fields && typeof payload.fields === "object") Object.assign(order, payload.fields);
    if (action === "assign" && payload.photographerId) {
      order.photographerId = payload.photographerId;
      if (["pending", "new"].includes(order.status)) { order.status = "confirmed"; order.customerStatus = "confirmed"; }
    }
    if (action === "accept") {
      Object.assign(order, {
        appointmentAt: payload.appointmentAt || order.appointmentAt || "",
        timePeriod: payload.timePeriod || order.timePeriod || "",
        appointmentLocation: payload.appointmentLocation || order.appointmentLocation || "",
        peopleCount: payload.peopleCount || order.peopleCount || 1,
        serviceNote: payload.serviceContent || order.serviceNote || "",
        totalAmount: payload.totalAmount === undefined ? order.totalAmount : payload.totalAmount,
        depositRatio: payload.depositRatio === undefined ? order.depositRatio : payload.depositRatio,
        finalDiscountAmount: payload.finalDiscountAmount === undefined ? order.finalDiscountAmount : payload.finalDiscountAmount,
        priceAdjustReason: payload.priceAdjustReason || order.priceAdjustReason || "",
        serviceConfirmedAt: LXMFormat.nowText(),
        status: "confirmed",
        customerStatus: "confirmed",
        workflowStage: "awaiting_deposit"
      });
    }
    if (action === "start") { order.status = "shooting"; order.customerStatus = "shooting"; }
    if (action === "assign") {
      Object.assign(order, {
        photographerId: payload.photographerId || order.photographerId || "",
        appointmentAt: payload.appointmentAt || order.appointmentAt || "",
        appointmentLocation: payload.appointmentLocation || order.appointmentLocation || "",
        peopleCount: payload.peopleCount || order.peopleCount || 1,
        dispatchStatus: "assigned",
        depositRefundable: false,
        workflowStage: "awaiting_shoot",
        status: "assigned",
        customerStatus: "待安排摄影师"
      });
    }
    if (action === "shootcomplete") {
      Object.assign(order, { status: "final_pending", workflowStage: "selection_pending", shootingCompletedAt: LXMFormat.nowText(), selectionStatus: "pending", customerStatus: "已拍摄" });
    }
    if (action === "selectionconfirm") {
      Object.assign(order, { status: "final_pending", workflowStage: "awaiting_final_payment", selectionStatus: "confirmed", selectionConfirmedAt: LXMFormat.nowText(), customerStatus: "已拍摄" });
    }
    if (action === "payment" && payload.phase === "deposit" && String(payload.paymentStatus || "") === "confirmed") {
      Object.assign(order, { status: "deposit_paid", workflowStage: "awaiting_dispatch", customerStatus: "待安排摄影师", depositRefundable: false });
    }
    if (action === "payment" && payload.phase === "final" && String(payload.paymentStatus || "") === "confirmed") {
      Object.assign(order, { status: "paid", workflowStage: "paid", customerStatus: "已支付" });
    }
    if (action === "deliver") { order.status = "delivered"; order.workflowStage = "delivered"; order.customerStatus = "已交付"; }
    if (action === "complete") { order.status = "completed"; order.customerStatus = "done"; }
    if (action === "cancel") { order.status = "cancelled"; order.customerStatus = "已取消"; order.deleted = true; order.isDeleted = true; }
    if (action === "unassign") { order.photographerId = ""; order.status = "confirmed"; order.customerStatus = "confirmed"; }
    if (action === "note" && payload.reason) order.internalNote = [order.internalNote, payload.reason].filter(Boolean).join("\n");
    if (!(window.LXM_CLOUD && window.LXM_CLOUD.loadAdminData)) schedulePersist();
    return null;
  }
  try {
    const updated = await window.LXM_CLOUD.orderAction(id, action, payload);
    if (updated && typeof updated === "object") Object.assign(order, updated);
    return updated;
  } catch (error) {
    const message = (error && error.message) || "订单保存失败";
    ElMessage.error(message);
    throw error;
  }
}
function statusMeta(value) {
  return statusDict.find((s) => s.value === value) || statusDict[0];
}
const COMPLETED_ORDER_STATUSES = new Set(["completed", "done", "已完成", "已完"]);
const CANCELLED_ORDER_STATUSES = new Set(["cancelled", "canceled", "terminated", "已取消", "已中止", "中止"]);
function orderStatusValue(value) { return value && typeof value === "object" ? value.status : value; }
function isOrderCompletedStatus(value) { return COMPLETED_ORDER_STATUSES.has(String(orderStatusValue(value) || "").trim().toLowerCase()); }
function isOrderCancelledStatus(value) { return CANCELLED_ORDER_STATUSES.has(String(orderStatusValue(value) || "").trim().toLowerCase()); }
function isOrderTerminalStatus(value) { return isOrderCompletedStatus(value) || isOrderCancelledStatus(value); }
function cityName(id) {
  return cityById(id).name || "-";
}
function cityIdentitySet(value) {
  if (value === undefined || value === null) return new Set();
  if (typeof value !== "object") return new Set([String(value)]);
  return new Set([value.id, value._id, value.cityId, value.code, value.name, value.city]
    .filter((item) => item !== undefined && item !== null && String(item) !== "").map(String));
}
function identitiesOverlap(left, right) {
  for (const id of left) if (right.has(id)) return true;
  return false;
}
function sameCity(left, right) {
  const a = cityIdentitySet(left); const b = cityIdentitySet(right);
  if (identitiesOverlap(a, b)) return true;
  const leftCity = cityById(left); const rightCity = cityById(right);
  return !!leftCity.id && !!rightCity.id && String(leftCity.id) === String(rightCity.id);
}
function cityById(value) {
  const target = cityIdentitySet(value);
  return data.cities.find((city) => identitiesOverlap(cityIdentitySet(city), target)) || {};
}
function agentName(id) {
  return (data.agents.find((a) => a.id === id) || {}).name || "-";
}
function distributorName(id) {
  return (data.distributors.find((d) => d.id === id) || {}).name || "-";
}
function shopName(id) {
  return shopById(id).name || "-";
}
function shopIdentitySet(value) {
  if (value === undefined || value === null) return new Set();
  if (typeof value !== "object") return new Set([String(value)]);
  const ids = [value.id, value._id, value.shopId, value.shopCode];
  if (value.source && typeof value.source === "object") ids.push(value.source.shopId, value.source.shopCode);
  return new Set(ids.filter((item) => item !== undefined && item !== null && String(item) !== "").map(String));
}
function sameShop(left, right) {
  const a = shopIdentitySet(left); const b = shopIdentitySet(right);
  if (identitiesOverlap(a, b)) return true;
  const leftShop = shopById(left); const rightShop = shopById(right);
  return !!leftShop.id && !!rightShop.id && String(leftShop.id) === String(rightShop.id);
}
function shopById(value) {
  const target = shopIdentitySet(value);
  return data.shops.find((shop) => identitiesOverlap(shopIdentitySet(shop), target)) || {};
}
function isHeadquarterSource(row) {
  return row?.sourceType === "headquarter";
}
function orderSourceType(order) {
  if (!order) return "natural";
  if (order.sourceType === "manual") return "manual";
  if (order.sourceType === "headquarter") return "headquarter";
  if (order.shopId || order.source?.shopId) return "shop";
  return "natural";
}
function orderSourceTypeText(order) {
  return ({
    shop: "商家二维",
    headquarter: "总部二维",
    manual: "客服手动创建",
    natural: "小程序自然来源",
  })[orderSourceType(order)] || "未知来源";
}
function orderSourceName(order) {
  if (!order) return "-";
  if (isHeadquarterSource(order)) return order.sourceName || "总部自有二维";
  if (orderSourceType(order) === "manual") return order.sourceName || "客服手动创建";
  if (orderSourceType(order) === "natural") return order.sourceName || "小程序自然来";
  const distIds = orderDistributorIds(order);
  const shopId = order.shopId || order.source?.shopId;
  if (distIds.length) return `${distIds.map(distributorName).join("、")} / ${shopName(shopId)}`;
  return shopName(shopId);
}
function staffName(id) {
  return (data.staff.find((s) => s.id === id) || {}).name || "总部摄影";
}
function spotName(id) {
  return (data.spots.find((s) => s.id === id) || {}).name || "-";
}
function seriesName(id) {
  return (data.series.find((s) => s.id === id) || {}).name || "-";
}
function albumName(id) {
  return (data.albums.find((a) => a.id === id) || {}).name || "-";
}
function seriesBySpot(id) {
  return data.series.filter((s) => s.spotId === id || (s.spotIds || []).includes(id));
}
function albumsBySeries(id) {
  return data.albums.filter((a) => a.seriesId === id);
}
function samplesByAlbum(id, type = "") {
  const albumId = String(id || "");
  const album = data.albums.find((item) => String(item && (item.id || item._id) || "") === albumId);
  const relationIds = new Set((Array.isArray(album?.photoIds) ? album.photoIds : []).map(String));
  return data.samples.filter((sample) => {
    const sampleId = String(sample && (sample.id || sample._id) || "");
    const belongs = String(sample?.albumId || "") === albumId || relationIds.has(sampleId);
    return belongs && (!type || sample.type === type);
  });
}
function packagesByAlbum(id) {
  return data.packages.filter((item) => item.albumId === id || (item.albumIds || []).includes(id)
    || (Array.isArray(item.includedItems) && item.includedItems.some((included) => included && included.type === "album" && (included.target?.albumId === id || included.albumId === id || included.productId === id))));
}
function packagesBySeries(id) {
  return data.packages.filter((item) => item.seriesId === id || (item.seriesIds || []).includes(id)
    || (Array.isArray(item.includedItems) && item.includedItems.some((included) => included && (included.seriesId === id || included.target?.seriesId === id))));
}
function packagesByPeripheral(id) {
  return data.packages.filter((item) => Array.isArray(item.includedItems) && item.includedItems.some((included) => included && included.type === "peripheral" && (included.peripheralId === id || included.productId === id || included.target?.peripheralId === id || included.target?.productId === id)));
}
function packagesReferencingPackage(id) {
  return data.packages.filter((item) => Array.isArray(item.includedItems) && item.includedItems.some((included) => included && (included.packageId === id || included.productId === id || included.target?.packageId === id || included.target?.productId === id)));
}
function albumOrderRows(id) {
  const packageIds = packagesByAlbum(id).map((item) => item.id);
  return data.orders.filter((order) => !order.deleted && (order.products || []).some((product) => product.id === id || packageIds.includes(product.id)));
}
function albumRevenue(id) {
  return albumOrderRows(id).reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
}
function peripheralOrderRows(id) {
  return data.orders.filter((order) => !order.deleted && (order.products || []).some((product) => product.id === id));
}
function peripheralModeText(row) {
  return row?.spotId || (row?.spotIds || []).length ? "定点专属" : "全城通用";
}
function peripheralStockStatus(row) {
  const stock = Number(row?.stock ?? row?.stockQty ?? 0);
  if (stock <= 0) return "缺货";
  if (stock <= 10) return "低库";
  return "库存正常";
}
function peripheralDependencySummary(row) {
  if (!row) return { orders: 0, revenue: 0, canDelete: true };
  const orders = peripheralOrderRows(row.id);
  return { orders: orders.length, revenue: orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0), canDelete: orders.length === 0 };
}
const peripheralRows = computed(() => {
  let rows = data.peripherals.filter((row) => !row.deleted).map((row) => {
    if (row.mode === undefined) row.mode = peripheralModeText(row);
    if (row.stock === undefined) row.stock = Number(row.stockQty ?? 30);
    if (row.specs === undefined) row.specs = row.spec || "标准";
    if (row.deliveryCycle === undefined) row.deliveryCycle = "3-5天发";
    if (row.auditStatus === undefined) row.auditStatus = productStatus(row) === "上架" ? "已上" : "已下";
    return { ...row, summary: peripheralDependencySummary(row) };
  });
  if (state.filters.contentSpotId) rows = rows.filter((row) => row.spotId === state.filters.contentSpotId || (row.spotIds || []).includes(state.filters.contentSpotId) || peripheralModeText(row) === "全城通用");
  if (state.filters.contentStatus) rows = rows.filter((row) => productStatus(row) === state.filters.contentStatus || row.status === state.filters.contentStatus);
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(kw));
  }
  return rows;
});
const peripheralSummary = computed(() => ({
  total: data.peripherals.filter((row) => !row.deleted).length,
  onSale: data.peripherals.filter((row) => !row.deleted && productStatus(row) === "上架").length,
  spotOnly: data.peripherals.filter((row) => !row.deleted && peripheralModeText(row) === "定点专属").length,
  cityWide: data.peripherals.filter((row) => !row.deleted && peripheralModeText(row) === "全城通用").length,
  lowStock: data.peripherals.filter((row) => !row.deleted && peripheralStockStatus(row) !== "库存正常").length,
  revenue: data.peripherals.reduce((sum, row) => sum + peripheralDependencySummary(row).revenue, 0),
}));
function addonEligibilityText(row) {
  return ({ photo: "仅拍照订", video: "仅短视频订单", all: "全订单通用" })[row?.eligibility || row?.orderScope || "all"] || "全订单通用";
}
function addonFinanceText(row) {
  return row?.financeReviewRequired === false ? "免财务审" : "需财务审核";
}
const addonRows = computed(() => {
  let rows = data.addonServices.filter((row) => !row.deleted).map((row) => {
    if (row.eligibility === undefined) row.eligibility = row.orderScope || "all";
    if (row.maxQuantity === undefined) row.maxQuantity = 1;
    if (row.holidaySurcharge === undefined) row.holidaySurcharge = 0;
    if (row.financeReviewRequired === undefined) row.financeReviewRequired = true;
    if (row.includeInOrderAmount === undefined) row.includeInOrderAmount = true;
    return row;
  });
  if (state.filters.contentSpotId) rows = rows.filter((row) => !row.spotId || row.spotId === state.filters.contentSpotId);
  if (state.filters.contentStatus) rows = rows.filter((row) => (row.enabled === false ? "停用" : "启用") === state.filters.contentStatus);
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(kw));
  }
  return rows;
});
const addonSummary = computed(() => ({
  total: data.addonServices.filter((row) => !row.deleted).length,
  enabled: data.addonServices.filter((row) => !row.deleted && row.enabled !== false).length,
  photoOnly: data.addonServices.filter((row) => (row.eligibility || row.orderScope) === "photo").length,
  videoOnly: data.addonServices.filter((row) => (row.eligibility || row.orderScope) === "video").length,
  financeRequired: data.addonServices.filter((row) => row.financeReviewRequired !== false).length,
  avgPrice: data.addonServices.reduce((sum, row) => sum + Number(row.price || 0), 0) / (data.addonServices.length || 1),
}));
function albumDependencySummary(album) {
  if (!album) return { photoSamples: 0, videoSamples: 0, packages: 0, onSalePackages: 0, orders: 0, revenue: 0, canDelete: true };
  const packages = packagesByAlbum(album.id);
  const orders = albumOrderRows(album.id);
  const onSalePackages = packages.filter((item) => productStatus(item) === "上架").length;
  return {
    photoSamples: samplesByAlbum(album.id, "photo").length,
    videoSamples: samplesByAlbum(album.id, "video").length,
    packages: packages.length,
    onSalePackages,
    orders: orders.length,
    revenue: albumRevenue(album.id),
    canDelete: packages.length + orders.length === 0,
  };
}
function selectedSpot() {
  const id = state.contentScope.type === "spot" ? state.contentScope.id : state.filters.contentSpotId || data.spots[0]?.id;
  return data.spots.find((spot) => spot.id === id) || data.spots[0] || null;
}
function albumsBySpot(id) {
  return data.albums.filter((album) => album.spotId === id || seriesBySpot(id).some((series) => series.id === album.seriesId));
}
function packagesBySpot(id, type = "") {
  return data.packages.filter((item) => (item.spotId === id || (item.spotIds || []).includes(id)) && (!type || (type === "video" ? item.type === "video" : item.type !== "video")));
}
function peripheralsBySpot(id) {
  return data.peripherals.filter((item) => item.spotId === id || (item.spotIds || []).includes(id) || item.mode === "全城通用" || item.scope === "全城通用");
}
function spotOrderRows(id) {
  const productIds = new Set([
    ...packagesBySpot(id).map((item) => item.id),
    ...albumsBySpot(id).map((item) => item.id),
    ...peripheralsBySpot(id).map((item) => item.id),
  ]);
  return data.orders.filter((order) => !order.deleted && (order.products || []).some((product) => productIds.has(product.id)));
}
function spotRevenue(id) {
  return spotOrderRows(id).reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
}
function spotDependencySummary(spot = selectedSpot()) {
  if (!spot) return { series: 0, albums: 0, photoPackages: 0, videoPackages: 0, peripherals: 0, products: 0, orders: 0, revenue: 0, canDelete: true };
  const series = seriesBySpot(spot.id).length;
  const albums = albumsBySpot(spot.id).length;
  const photoPackages = packagesBySpot(spot.id, "photo").length;
  const videoPackages = packagesBySpot(spot.id, "video").length;
  const peripherals = peripheralsBySpot(spot.id).length;
  const orders = spotOrderRows(spot.id).length;
  const products = photoPackages + videoPackages + peripherals;
  return { series, albums, photoPackages, videoPackages, peripherals, products, orders, revenue: spotRevenue(spot.id), canDelete: series + albums + products + orders === 0 };
}
const spotRows = computed(() => {
  let rows = data.spots.filter((spot) => !spot.deleted).map((spot) => ({ ...spot, summary: spotDependencySummary(spot) }));
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    rows = rows.filter((spot) => JSON.stringify(spot).toLowerCase().includes(kw));
  }
  if (state.filters.contentStatus) rows = rows.filter((spot) => (spot.status || "启用") === state.filters.contentStatus);
  return rows;
});
function orderShop(order) {
  return shopById(order && (order.shopId || (order.source && order.source.shopId)));
}
function normalizeDateText(value) {
  if (!value) return "";
  if (value instanceof Date) return LXMFormat.date(value);
  return String(value).slice(0, 10);
}
function inDateRange(value) {
  const range = state.filters.dateRange;
  if (!range || !range.length || !range[0] || !range[1]) return true;
  const current = normalizeDateText(value);
  const start = normalizeDateText(range[0]);
  const end = normalizeDateText(range[1]);
  return current >= start && current <= end;
}
function inRoleScope(orderOrShop) {
  const scope = roleProfile.value.scope;
  const shop = orderOrShop && (orderOrShop.shopId || orderOrShop.source?.shopId)
    ? orderShop(orderOrShop)
    : (orderOrShop || {});
  if (scope === "all" || scope === "content" || scope === "finance") return true;
  if (scope === "orders") return orderOrShop.assigneeId === roleProfile.value.staffId || orderOrShop.staffId === roleProfile.value.staffId;
  if (scope === "agent") return shop.agentId === (state.loginRole === "super" && state.filters.agentId ? state.filters.agentId : roleProfile.value.agentId);
  if (scope === "city") return sameCity(shop, roleProfile.value.cityId);
  if (scope === "distributor") return (orderOrShop.distributorId || orderOrShop.source?.distributorId) === roleProfile.value.distributorId || (shop.distributorIds || []).includes(roleProfile.value.distributorId) || shop.distributorId === roleProfile.value.distributorId;
  if (scope === "shop") return sameShop(shop, roleProfile.value.shopId) || sameShop(orderOrShop, roleProfile.value.shopId);
  if (scope === "selfTask") return orderOrShop.photographerId === roleProfile.value.staffId;
  return true;
}
function canManageShopBinding() {
  return ["super", "finance"].includes(state.role) || can("*") || (can("shopEdit") && state.role !== "distributor");
}
function scanInRoleScope(scan) {
  if (!scan) return false;
  if (["super", "finance"].includes(state.role)) return true;
  if (state.role === "merchant") return sameShop(scan, roleProfile.value.shopId);
  if (state.role === "distributor") return scan.distributorId === roleProfile.value.distributorId || (orderShop(scan).distributorIds || []).includes(roleProfile.value.distributorId) || orderShop(scan).distributorId === roleProfile.value.distributorId;
  if (state.role === "photo") {
    const order = data.orders.find((item) => item.id === scan.orderId);
    return order?.photographerId === roleProfile.value.staffId;
  }
  return inRoleScope(scan);
}
function resolveProduct(p) {
  if (!p) return {};
  const map = {
    package: data.packages,
    video: data.packages,
    album: data.albums,
    service: data.addonServices,
    peripheral: data.peripherals,
    sample: data.samples,
  };
  return (map[p.type] || []).find((i) => i.id === p.id) || p;
}
function productName(p) {
  return p?.name || resolveProduct(p).name || "-";
}
function productPrice(p) {
  const item = resolveProduct(p);
  return Number(p?.price || item.specialPrice || item.price || 0);
}
function productStatus(row) {
  if (!row) return "下架";
  if (row.isShow === false || row.enabled === false) return "下架";
  if (["上架", "下架", "草稿"].includes(row.status)) return row.status;
  if (["启用", "发布"].includes(row.status)) return "上架";
  return "上架";
}
function visiblePhone(order) {
  if (!order?.phone) return "-";
  if (state.role === "merchant") return order.phone.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2");
  if (state.role === "photo") return "仅客服可";
  return order.phone;
}
function visibleWechat(order) {
  if (!order?.wechat) return "-";
  if (state.role === "merchant" || state.role === "photo") return "仅客服可";
  return order.wechat;
}
function serviceOwnerName(order) {
  return staffName(order?.assigneeId || roleProfile.value.staffId || state.currentStaffId);
}
function photographerDisplayName(id) {
  return id ? staffName(id) : "总部摄影";
}
function canEditOrder() {
  return can("orderEdit");
}
function canViewOrderSource() {
  return !["photo", "merchant"].includes(state.role);
}
function commission(order, type) {
  const shop = orderShop(order);
  const amount = netOrderAmount(order);
  if (type === "shop") {
    if (!(order?.shopId || order?.source?.shopId) || isHeadquarterSource(order)) return 0;
    return amount * Number(shop.commissionRate || shop.shareRatio || 0) / 100;
  }
  if (type === "distributor") {
    const ids = orderDistributorIds(order);
    if (!ids.length) return 0;
    const rates = (shop.distributorRates && typeof shop.distributorRates === "object") ? shop.distributorRates : {};
    return ids.reduce((sum, id) => {
      const d = data.distributors.find((item) => item.id === id);
      const rate = rates[id] != null ? Number(rates[id]) : Number(d?.commissionRate || 0);
      return sum + amount * rate / 100;
    }, 0);
  }
  if (type === "agent") {
    const a = data.agents.find((item) => item.id === shop.agentId);
    return amount * Number(a?.commissionRate || 0) / 100;
  }
  if (type === "photo") {
    const staff = data.staff.find((item) => item.id === order?.photographerId);
    return amount * Number(order?.photographerCommissionRate || staff?.commissionRate || 20) / 100;
  }
  return 0;
}
function commissionRateFor(type, id) {
  if (type === "shop") {
    const shop = shopById(id);
    return Number(shop.commissionRate || shop.shareRatio || 0);
  }
  if (type === "distributor") {
    const distributor = data.distributors.find((item) => item.id === id) || {};
    return Number(distributor.commissionRate || 0);
  }
  if (type === "photo") {
    const staff = data.staff.find((item) => item.id === id) || {};
    return Number(staff.commissionRate || 20);
  }
  return 0;
}
function commissionRateText(type, id) {
  const label = ({ shop: "商家分成", distributor: "分销分成", photo: "摄影师分" })[type] || "分成";
  return `${commissionRateFor(type, id)}%`;
}
function orderSplit(order) {
  const netAmount = netOrderAmount(order);
  const shopAmount = commission(order, "shop");
  const distributorAmount = commission(order, "distributor");
  const photographerAmount = commission(order, "photo");
  return {
    netAmount,
    shopAmount,
    distributorAmount,
    photographerAmount,
    headquarterAmount: Math.max(netAmount - shopAmount - distributorAmount - photographerAmount, 0),
  };
}
function orderDistributorIds(order) {
  if (order && Array.isArray(order.distributorIds) && order.distributorIds.length) return order.distributorIds;
  const shop = orderShop(order);
  if (shop && Array.isArray(shop.distributorIds) && shop.distributorIds.length) return shop.distributorIds;
  if (shop && shop.distributorId) return [shop.distributorId];
  if (order && (order.distributorId || order.source?.distributorId)) return [order.distributorId || order.source.distributorId];
  return [];
}
function orderDistributorSplits(order) {
  const amount = netOrderAmount(order);
  const shop = orderShop(order);
  const rates = (shop.distributorRates && typeof shop.distributorRates === "object") ? shop.distributorRates : {};
  return orderDistributorIds(order).map((id) => {
    const d = data.distributors.find((item) => item.id === id) || {};
    const rate = rates[id] != null ? Number(rates[id]) : Number(d.commissionRate || 0);
    return { distributorId: id, name: d.name || distributorName(id), rate, amount: amount * rate / 100 };
  });
}
function distributorRateForShop(shop, distributorId) {
  const rates = shop && shop.distributorRates && typeof shop.distributorRates === "object" ? shop.distributorRates : {};
  if (rates[distributorId] != null) return Number(rates[distributorId]);
  const d = data.distributors.find((x) => x.id === distributorId);
  return d ? Number(d.commissionRate || 0) : 0;
}
function syncShopDistributorRates() {
  const shop = state.editShop;
  if (!shop) return;
  shop.distributorRates = shop.distributorRates && typeof shop.distributorRates === "object" ? shop.distributorRates : {};
  const ids = Array.isArray(shop.distributorIds) ? shop.distributorIds : [];
  Object.keys(shop.distributorRates).forEach((k) => { if (!ids.includes(k)) delete shop.distributorRates[k]; });
  ids.forEach((id) => {
    if (shop.distributorRates[id] == null) {
      const d = data.distributors.find((x) => x.id === id);
      shop.distributorRates[id] = d ? Number(d.commissionRate || 0) : 0;
    }
  });
}
function orderAfterSales(order) {
  return data.afterSales.filter((item) => item.orderId === order.id);
}
function activeAfterSales(order) {
  return orderAfterSales(order).filter((item) => normalizeAfterSaleStatus(item.status) !== "已完成");
}
function isOrderAfterSaleLocked(order = state.currentOrder) {
  return !!order && activeAfterSales(order).length > 0;
}
function canEditCurrentOrder() {
  return canEditOrder() && !isOrderCompletedStatus(state.currentOrder) && !isOrderCancelledStatus(state.currentOrder) && !isOrderAfterSaleLocked(state.currentOrder);
}
function afterSaleBadge(order) {
  const rows = orderAfterSales(order);
  if (!rows.length) return "";
  const active = activeAfterSales(order);
  return active.length ? `售后${active.length}处理中` : `售后${rows.length}已结案`;
}
function orderFinanceStatus(order) {
  const rows = orderFinanceReviews(order);
  if (!rows.length) return "未提";
  if (rows.some((row) => normalizeReviewStatus(row.status) === "已驳")) return "已驳";
  if (rows.some((row) => normalizeReviewStatus(row.status) === "待审")) return "待审";
  if (rows.every((row) => normalizeReviewStatus(row.status) === "已审")) return "已审";
  return "未提";
}
function orderRefundStatus(order) {
  const rows = orderAfterSales(order).filter((row) => Number(row.refundAmount || row.amount || 0) > 0);
  if (!rows.length) return "无退";
  if (rows.some((row) => normalizeReviewStatus(row.financeStatus) === "待审" || normalizeReviewStatus(row.status) === "待审")) return "待审";
  if (rows.some((row) => normalizeReviewStatus(row.financeStatus) === "已驳")) return "已驳";
  if (rows.every((row) => normalizeReviewStatus(row.financeStatus) === "已审")) return "已审";
  return "待审";
}
function hasTransferRecord(order) {
  return orderTimelineRows(order).some((row) => /转客服|转摄影师|订单转派|交接|改派/.test(row.action || ""));
}
function hasRescheduleRecord(order) {
  return orderTimelineRows(order).some((row) => /改期|改约|预约时间/.test(row.action || ""));
}
function orderTimelineRows(order) {
  if (!order) return [];
  const baseRows = (order.statusLogs || order.logs || []).map((item, index) => {
    if (typeof item === "string") return { time: item.slice(0, 16) || "-", operator: "系统记录", action: item.slice(17) || item, sort: `${item}-${index}` };
    return { ...item, sort: `${item.time || ""}-${index}` };
  });
  const afterSaleRows = orderAfterSales(order).flatMap((row) => (row.logs || []).map((text, index) => ({
    time: row.updatedAt || row.approvedAt || row.createdAt || "-",
    operator: row.assigneeId ? staffName(row.assigneeId) : "售后服务",
    action: `售后${row.status}「${row.type}」${text}`,
    sort: `${row.updatedAt || row.approvedAt || row.createdAt || ""}-as-${row.id}-${index}`,
  })));
  return [...baseRows, ...afterSaleRows].sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
}
// 售后状态归一化：把不同时期的写法统一成 待处理 / 处理中 / 已完成 / 待超管审核，供筛选与标签判断使用
function normalizeAfterSaleStatus(status) {
  const value = String(status || "").trim();
  if (!value) return "待处理";
  if (["待处理", "待客服处理", "待跟进", "待响应"].includes(value)) return "待处理";
  if (["处理中", "跟进中", "处理进行中"].includes(value)) return "处理中";
  if (["已完成", "已结案", "已完结", "完成"].includes(value)) return "已完成";
  if (value.includes("超管")) return "待超管审核";
  return value;
}
// 财务审核状态归一化：统一成 未提 / 待审 / 已审 / 已驳（已锁单独保留，配合财务锁定判断）
function normalizeReviewStatus(status) {
  const value = String(status || "").trim();
  if (!value) return "未提";
  if (["待审", "待审核", "待财务审", "待财务审核", "待确认"].includes(value)) return "待审";
  if (["已审", "已审核", "已通过", "财务已核对", "已入账"].includes(value)) return "已审";
  if (["已驳", "已驳回", "已退回"].includes(value)) return "已驳";
  if (value.includes("锁")) return "已锁";
  return value;
}
// 时间线行分类：优先使用记录自带的 category，否则按操作内容推导，保证筛选页签有值可用
function orderTimelineCategoryOf(row) {
  const own = String((row && row.category) || "").trim();
  if (own) return own;
  const action = String((row && row.action) || "");
  if (/售后|退款/.test(action)) return "售后";
  if (/定金|尾款|收款|优惠券|调价|金额/.test(action)) return "收款";
  if (/派单|摄影师|安排/.test(action)) return "派单";
  if (/转客服|转摄影师|转派|交接|改派/.test(action)) return "转派";
  if (/改期|改约|预约时间/.test(action)) return "改期";
  if (/成片|交付/.test(action)) return "交付";
  if (/取消|中止/.test(action)) return "取消";
  if (/完成|结案/.test(action)) return "完成";
  return "记录";
}
// 时间线筛选项：当前订单时间线里出现过的分类，去重且保持首次出现顺序
function orderTimelineCategoryOptions(order) {
  const seen = [];
  for (const row of orderTimelineRows(order)) {
    const cat = orderTimelineCategoryOf(row);
    if (!seen.includes(cat)) seen.push(cat);
  }
  return seen;
}
// 时间线行（按筛选分类过滤，可带条数上限）：抽屉内默认收拢最近几条，弹窗里看全部
function filteredOrderTimelineRows(order, limit) {
  const rows = orderTimelineRows(order);
  const filter = String(state.timelineCategoryFilter || "").trim();
  const filtered = filter ? rows.filter((row) => orderTimelineCategoryOf(row) === filter) : rows;
  return Number(limit) > 0 ? filtered.slice(0, Number(limit)) : filtered;
}
// 复制订单信息：一键把订单关键信息整理成文本，方便客服粘贴到企业微信或内部记录
function copyOrderWechatInfo(order) {
  if (!order) return;
  const lines = [
    `订单号：${order.orderNo || "-"}`,
    `客户：${order.customer || "-"}`,
    `手机号：${order.phone || visiblePhone(order)}`,
    `微信号：${order.wechat || visibleWechat(order)}`,
    `拍摄时间：${order.appointmentAt || "待确认"}${order.timePeriod ? `（${order.timePeriod}）` : ""}`,
    `客人可见状态：${(statusMeta(order.status) || {}).customer || "-"}`,
    `订单总价：${money(order.totalAmount)}`,
    `已收定金：${money(order.depositPaid)}`,
    `已收尾款：${money(order.finalPaid)}`,
  ];
  const text = lines.join("\n");
  const done = () => ElMessage.success("订单信息已复制，可粘贴到企业微信或内部记录");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try { document.execCommand("copy"); done(); } catch (e) { ElMessage.error("复制失败，请手动记录订单信息"); }
  document.body.removeChild(textarea);
}
function orderFinanceReviews(order) {
  if (!order) return [];
  const rows = [];
  if (Number(order.depositPaid || 0) > 0) rows.push({
    id: `deposit-${order.id}`,
    orderId: order.id,
    orderNo: order.orderNo,
    customer: order.customer,
    shopId: order.shopId,
    type: "预约定金",
    amount: Number(order.depositPaid || 0),
    status: order.depositFinanceStatus || "未提",
    source: "order",
    field: "depositFinanceStatus",
    createdAt: order.depositPaidAt || order.updatedAt || order.appointmentAt,
    note: "客服登记定金后，由财务核对微信线下收款记录"
  });
  if (Number(order.finalPaid || 0) > 0) rows.push({
    id: `final-${order.id}`,
    orderId: order.id,
    orderNo: order.orderNo,
    customer: order.customer,
    shopId: order.shopId,
    type: "收尾款",
    amount: Number(order.finalPaid || 0),
    status: order.finalFinanceStatus || "未提",
    source: "order",
    field: "finalFinanceStatus",
    createdAt: order.finalPaidAt || order.updatedAt || order.appointmentAt,
    note: "客服登记尾款后，由财务核对尾款到账和订单完成口径"
  });
  return rows;
}
function hasBlockingAfterSale(order) {
  return orderAfterSales(order).some((item) => {
    if (Number(item.refundAmount || item.amount || 0) > 0) return normalizeReviewStatus(item.financeStatus) !== "已审";
    return normalizeAfterSaleStatus(item.status) !== "已完成";
  });
}
function hasRiskBlock(order) {
  return !!(order?.riskBlocked || order?.riskFlag || order?.frozen || order?.freezeReason);
}
function settlementObservationDays() {
  const days = Number(data.financeSettings?.settlementObservationDays || 3);
  return Math.min(Math.max(days, 1), 15);
}
function largeSettlementThreshold() {
  const amount = Number(data.financeSettings?.largeSettlementThreshold || 5000);
  return Math.max(amount, 0);
}
async function normalizeFinanceSettings() {
  data.financeSettings.settlementObservationDays = settlementObservationDays();
  data.financeSettings.largeSettlementThreshold = largeSettlementThreshold();
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  const remote = !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD?.upsertDoc
    && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
  if (remote) {
    try {
      const saved = await window.LXM_CLOUD.upsertDoc("financeSettings", "global", {
        settlementObservationDays: data.financeSettings.settlementObservationDays,
        largeSettlementThreshold: data.financeSettings.largeSettlementThreshold,
      });
      if (saved && typeof saved === "object") Object.assign(data.financeSettings, saved);
    } catch (error) {
      return ElMessage.error((error && error.message) || "财务参数保存失败，请稍后重试");
    }
  }
  ElMessage.success("财务参数已更新，后续分账校验将按新参数计");
}
function parseBusinessTime(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const normalized = String(value).replace(/\./g, "-").replace(/\//g, "-");
  const date = new Date(normalized.length <= 10 ? `${normalized} 23:59:59` : normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
function orderCompletedAt(order) {
  if (!order || !isOrderCompletedStatus(order)) return null;
  const explicit = parseBusinessTime(order.completedAt || order.deliveredAt || order.finishedAt || order.completedTime);
  if (explicit) return explicit;
  const rows = orderTimelineRows(order);
  const matched = rows.find((item) => /完成|交付/.test(item.action || ""));
  return parseBusinessTime(matched?.time) || parseBusinessTime(order.updatedAt) || parseBusinessTime(order.appointmentAt);
}
function settlementAvailableAt(order) {
  const completedAt = orderCompletedAt(order);
  if (!completedAt) return null;
  return new Date(completedAt.getTime() + settlementObservationDays() * 24 * 60 * 60 * 1000);
}
function isSettlementObservationPending(order) {
  if (order?.settlementObservationReleased) return false;
  const availableAt = settlementAvailableAt(order);
  return isOrderCompletedStatus(order) && !!availableAt && Date.now() < availableAt.getTime();
}
function settlementObservationText(order) {
  if (order?.settlementObservationReleased) return `订单静置期已由超管提前结束：${order.settlementObservationReleasedAt || "-"}`;
  const availableAt = settlementAvailableAt(order);
  if (!availableAt) return `交付后预计 ${settlementObservationDays()} 天订单静置期`;
  const pad = (n) => String(n).padStart(2, "0");
  const text = `${availableAt.getFullYear()}-${pad(availableAt.getMonth() + 1)}-${pad(availableAt.getDate())} ${pad(availableAt.getHours())}:${pad(availableAt.getMinutes())}`;
  return isSettlementObservationPending(order) ? `订单静置期中，预计 ${text} 后可分账` : `订单静置期已满，${text} 后可分账`;
}
function canReleaseSettlementObservation(order) {
  return state.role === "super" && !ctx.isReconciliationClosed.value && isOrderCompletedStatus(order) && !order.settlementObservationReleased && isSettlementObservationPending(order);
}
function reconciliationBlockReasons(order, options = {}) {
  const afterSales = orderAfterSales(order);
  const observationHold = isOrderCompletedStatus(order) && isSettlementObservationPending(order);
  const refundPending = afterSales.some((item) => Number(item.refundAmount || item.amount || 0) > 0 && normalizeReviewStatus(item.financeStatus) !== "已审");
  const afterSalePending = afterSales.some((item) => normalizeAfterSaleStatus(item.status) !== "已完成");
  const reasons = [];
  if (!isOrderCompletedStatus(order) && !isRetainedCancelledOrder(order)) reasons.push(`订单未完成：${statusMeta(order.status).label}`);
  if (auditedReceiptBase(order) < 0) reasons.push("订单实收为负");
  if (isOrderCompletedStatus(order) && financeDue(order) > 0) reasons.push("收款待财务审");
  if (observationHold) reasons.push(settlementObservationText(order));
  if (options.includeReleasedNote && order.settlementObservationReleased && !observationHold) reasons.push(settlementObservationText(order));
  if (refundPending) reasons.push("退款待财务审核");
  if (afterSalePending) reasons.push("存在未结案售后");
  if (hasRiskBlock(order)) reasons.push(order.freezeReason || order.riskReason || "订单存在人工冻结或风控拦截");
  return reasons;
}
function releaseSettlementObservation(order) {
  if (ctx.isReconciliationClosed.value) return ElMessage.warning("当前月份已关账，不能提前结束订单静置");
  if (!canReleaseSettlementObservation(order)) return ElMessage.warning("当前订单不符合提前结束静置期条件");
  ElMessageBox.confirm(`确认提前结束订单 ${order.orderNo} 的订单静置期？确认后若收款已审核且无未结案售后，将立即进入实际可分账口径。`, "提前结束订单静置", {
    type: "warning",
    confirmButtonText: "确认结束静置",
    cancelButtonText: "暂不处理",
  }).then(async () => {
    const original = JSON.parse(JSON.stringify(order));
    order.settlementObservationReleased = true;
    order.settlementObservationReleasedAt = LXMFormat.nowText();
    order.settlementObservationReleasedBy = currentOperatorName();
    try {
      await persistOrderAction(order, "update", {
        fields: {
          settlementObservationReleased: true,
          settlementObservationReleasedAt: order.settlementObservationReleasedAt,
          settlementObservationReleasedBy: order.settlementObservationReleasedBy,
        },
        reason: "超管提前结束订单静置期",
      });
    } catch (_) {
      Object.keys(order).forEach((key) => { if (!(key in original)) delete order[key]; });
      Object.assign(order, original);
      return;
    }
    addOrderTimeline(order, `超管提前结束订单静置期，订单可按财务审核状态进入月度对账`, currentOperatorName());
    log("提前结束订单静置", order.orderNo, `${order.customer} / ${money(order.totalAmount)}`);
    if (state.reconciliationDetail.type === "observation") {
      state.reconciliationDetail.rows = state.reconciliationDetail.rows.filter((row) => row.id !== order.id);
    }
    const remainingReasons = reconciliationBlockReasons(order);
    if (remainingReasons.length) {
      ElMessage.warning(`订单静置期已结束，但仍暂缓：${remainingReasons.join("")}`);
    } else {
      ElMessage.success("订单静置期已提前结束，订单已进入实际可分账口");
    }
  }).catch(() => {});
}
function isReconciliationEligible(order) {
  const normalCompleted = isOrderCompletedStatus(order) && financeDue(order) <= 0 && !isSettlementObservationPending(order);
  const retainedCancelled = isRetainedCancelledOrder(order);
  return auditedReceiptBase(order) >= 0 && (normalCompleted || retainedCancelled) && !hasBlockingAfterSale(order) && !hasRiskBlock(order);
}
function isOrderDeliveredForSettlement(order) {
  return !!order && (isOrderCompletedStatus(order) || ["done", "delivered"].includes(order.customerStatus));
}
function isEstimatedReconciliationOrder(order) {
  if (!order) return false;
  if (isReconciliationEligible(order)) return true;
  return isOrderDeliveredForSettlement(order)
    && financeDue(order) <= 0
    && !hasBlockingAfterSale(order)
    && !hasRiskBlock(order);
}
function isDepositRegistrationConfirmed(order) {
  if (!order) return false;
  return Number(order.depositPaid || 0) > 0 && normalizeReviewStatus(order.depositFinanceStatus) === "已审";
}
function canConfirmFinalPayment(order) {
  if (!order) return false;
  return canEditCurrentOrder()
    && expectedFinalAmount(order) > 0
    && isDepositRegistrationConfirmed(order)
    && !["待审", "已审"].includes(normalizeReviewStatus(order.finalFinanceStatus));
}
function canCompleteOrderPayment(order) {
  if (!order) return false;
  return isDepositRegistrationConfirmed(order)
    && Number(order.finalPaid || 0) > 0
    && normalizeReviewStatus(order.finalFinanceStatus) === "已审";
}

// 登录：优先走后端 /api/auth/login（scrypt 校验，前端不持有明文密码）。
// 若后端不可达（如直接双击打开 index.html 的 mock 模式），回退到本地演示数据比对，保证 demo 可登录。

  return {
    can,
    roleName,
    money,
    paid,
    financePaid,
    orderDiscount,
    expectedFinalAmount,
    finalGap,
    financePendingAmount,
    due,
    financeDue,
    confirmedRefund,
    retainedCancelledAmount,
    isRetainedCancelledOrder,
    netOrderAmount,
    auditedReceiptBase,
    settlementIncomeType,
    inferLogModule,
    inferLogLevel,
    log,
    currentOperatorName,
    persistOrderAction,
    resetPageState,
    timelineText,
    addOrderTimeline,
    statusMeta,
    isOrderCompletedStatus,
    isOrderCancelledStatus,
    isOrderTerminalStatus,
    cityName,
    agentName,
    distributorName,
    shopName,
    shopIdentitySet,
    sameShop,
    shopById,
    cityIdentitySet,
    sameCity,
    cityById,
    isHeadquarterSource,
    orderSourceType,
    orderSourceTypeText,
    orderSourceName,
    staffName,
    spotName,
    seriesName,
    albumName,
    seriesBySpot,
    albumsBySeries,
    samplesByAlbum,
    packagesByAlbum,
    packagesBySeries,
    packagesByPeripheral,
    packagesReferencingPackage,
    albumOrderRows,
    albumRevenue,
    peripheralOrderRows,
    peripheralModeText,
    peripheralStockStatus,
    peripheralDependencySummary,
    peripheralRows,
    peripheralSummary,
    addonEligibilityText,
    addonFinanceText,
    addonRows,
    addonSummary,
    albumDependencySummary,
    selectedSpot,
    albumsBySpot,
    packagesBySpot,
    peripheralsBySpot,
    spotOrderRows,
    spotRevenue,
    spotDependencySummary,
    spotRows,
    orderShop,
    normalizeDateText,
    inDateRange,
    inRoleScope,
    canManageShopBinding,
    scanInRoleScope,
    resolveProduct,
    productName,
    productPrice,
    productStatus,
    visiblePhone,
    visibleWechat,
    serviceOwnerName,
    photographerDisplayName,
    canEditOrder,
    canViewOrderSource,
    commission,
    commissionRateFor,
    commissionRateText,
    orderSplit,
    orderDistributorIds,
    orderDistributorSplits,
    distributorRateForShop,
    syncShopDistributorRates,
    orderAfterSales,
    activeAfterSales,
    isOrderAfterSaleLocked,
    canEditCurrentOrder,
    afterSaleBadge,
    orderFinanceStatus,
    orderRefundStatus,
    hasTransferRecord,
    hasRescheduleRecord,
    orderTimelineRows,
    orderTimelineCategoryOf,
    orderTimelineCategoryOptions,
    filteredOrderTimelineRows,
    normalizeAfterSaleStatus,
    normalizeReviewStatus,
    copyOrderWechatInfo,
    orderFinanceReviews,
    hasBlockingAfterSale,
    hasRiskBlock,
    settlementObservationDays,
    largeSettlementThreshold,
    normalizeFinanceSettings,
    parseBusinessTime,
    orderCompletedAt,
    settlementAvailableAt,
    isSettlementObservationPending,
    settlementObservationText,
    canReleaseSettlementObservation,
    reconciliationBlockReasons,
    releaseSettlementObservation,
    isReconciliationEligible,
    isOrderDeliveredForSettlement,
    isEstimatedReconciliationOrder,
    isDepositRegistrationConfirmed,
    canConfirmFinalPayment,
    canCompleteOrderPayment
  };
});
