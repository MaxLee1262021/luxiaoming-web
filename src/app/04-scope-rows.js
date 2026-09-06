// 作用域数据行（商家/订单/任务/售后/扫码）
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    activeAfterSales,
    computed,
    data,
    hasRescheduleRecord,
    hasTransferRecord,
    inDateRange,
    inRoleScope,
    orderAfterSales,
    orderDistributorIds,
    orderFinanceStatus,
    orderRefundStatus,
    orderShop,
    orderSourceType,
    productName,
    resolveProduct,
    roleProfile,
    scanInRoleScope,
    shopName,
    state,
    statusMeta
  } = ctx;

const scopedShops = computed(() => {
  let list = data.shops.filter(inRoleScope);
  if (state.filters.cityId) list = list.filter((s) => s.cityId === state.filters.cityId);
  if (state.filters.agentId) list = list.filter((s) => s.agentId === state.filters.agentId);
  if (state.filters.keyword) list = list.filter((s) => JSON.stringify(s).includes(state.filters.keyword));
  return list;
});
const scopedOrders = computed(() => {
  let list = data.orders.filter((o) => !o.deleted && inRoleScope(o));
  list = list.filter((o) => inDateRange(o.appointmentAt));
  if (state.filters.cityId) list = list.filter((o) => orderShop(o).cityId === state.filters.cityId);
  if (state.filters.agentId) list = list.filter((o) => orderShop(o).agentId === state.filters.agentId);
  if (state.filters.distributorId) list = list.filter((o) => o.distributorId === state.filters.distributorId || orderDistributorIds(o).includes(state.filters.distributorId));
  if (state.filters.shopId) list = list.filter((o) => o.shopId === state.filters.shopId);
  if (state.filters.sourceType) list = list.filter((o) => orderSourceType(o) === state.filters.sourceType);
  if (state.filters.status) list = list.filter((o) => o.status === state.filters.status);
  if (state.filters.financeStatus) list = list.filter((o) => orderFinanceStatus(o) === state.filters.financeStatus);
  if (state.filters.afterSaleStatus) {
    list = list.filter((o) => {
      const rows = orderAfterSales(o);
      if (state.filters.afterSaleStatus === "none") return rows.length === 0;
      if (state.filters.afterSaleStatus === "active") return activeAfterSales(o).length > 0;
      if (state.filters.afterSaleStatus === "done") return rows.length > 0 && activeAfterSales(o).length === 0;
      return true;
    });
  }
  if (state.filters.refundStatus) list = list.filter((o) => orderRefundStatus(o) === state.filters.refundStatus);
  if (state.filters.transferStatus) list = list.filter((o) => state.filters.transferStatus === "has" ? hasTransferRecord(o) : !hasTransferRecord(o));
  if (state.filters.rescheduleStatus) list = list.filter((o) => state.filters.rescheduleStatus === "has" ? hasRescheduleRecord(o) : !hasRescheduleRecord(o));
  if (state.filters.assigneeId) list = list.filter((o) => o.assigneeId === state.filters.assigneeId);
  if (state.filters.photographerId) list = list.filter((o) => o.photographerId === state.filters.photographerId);
  if (state.filters.productType) list = list.filter((o) => o.products.some((p) => p.type === state.filters.productType || resolveProduct(p).type === state.filters.productType));
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    list = list.filter((o) => JSON.stringify({ ...o, shop: shopName(o.shopId), products: o.products.map(productName) }).toLowerCase().includes(kw));
  }
  return list;
});
const reminderBaseOrders = computed(() => {
  let list = data.orders.filter((o) => !o.deleted && inRoleScope(o));
  list = list.filter((o) => inDateRange(o.appointmentAt));
  if (state.filters.cityId) list = list.filter((o) => orderShop(o).cityId === state.filters.cityId);
  if (state.filters.agentId) list = list.filter((o) => orderShop(o).agentId === state.filters.agentId);
  if (state.filters.distributorId) list = list.filter((o) => o.distributorId === state.filters.distributorId || orderDistributorIds(o).includes(state.filters.distributorId));
  if (state.filters.shopId) list = list.filter((o) => o.shopId === state.filters.shopId);
  if (state.filters.sourceType) list = list.filter((o) => orderSourceType(o) === state.filters.sourceType);
  if (state.filters.assigneeId) list = list.filter((o) => o.assigneeId === state.filters.assigneeId);
  if (state.filters.photographerId) list = list.filter((o) => o.photographerId === state.filters.photographerId);
  if (state.filters.productType) list = list.filter((o) => o.products.some((p) => p.type === state.filters.productType || resolveProduct(p).type === state.filters.productType));
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    list = list.filter((o) => JSON.stringify({ ...o, shop: shopName(o.shopId), products: o.products.map(productName) }).toLowerCase().includes(kw));
  }
  return list;
});
const taskOrders = computed(() => data.orders.filter((o) => !o.deleted && o.photographerId === roleProfile.value.staffId));
function afterSaleOrder(row) {
  return data.orders.find((order) => order.id === row.orderId) || {};
}
const afterSaleRows = computed(() => {
  let list = data.afterSales.filter((row) => {
    const order = afterSaleOrder(row);
    return order.id && inRoleScope(order);
  });
  if (state.filters.status) list = list.filter((row) => row.status === state.filters.status);
  if (state.filters.productType) list = list.filter((row) => row.type === state.filters.productType);
  if (state.filters.assigneeId) list = list.filter((row) => row.assigneeId === state.filters.assigneeId);
  if (state.filters.keyword) list = list.filter((row) => JSON.stringify({ ...row, order: afterSaleOrder(row), shop: shopName(afterSaleOrder(row).shopId) }).includes(state.filters.keyword));
  return list.map((row) => {
    const order = afterSaleOrder(row);
    return {
      ...row,
      orderNo: order.orderNo,
      shopId: order.shopId,
      amount: Number(row.refundAmount || row.amount || 0),
      orderStatus: statusMeta(order.status).label,
      customerVisibleStatus: row.customerVisibleStatus || row.status,
      submitSource: row.submitSource || "后台提交",
    };
  });
});
const activeAfterSaleRows = computed(() => afterSaleRows.value.filter((row) => row.status !== "已完"));
const afterSaleRecordRows = computed(() => afterSaleRows.value.filter((row) => row.status === "已完"));
const afterSaleSummary = computed(() => ({
  total: activeAfterSaleRows.value.length,
  pending: activeAfterSaleRows.value.filter((row) => ["待处", "待超管审", "待财务审"].includes(row.status)).length,
  processing: activeAfterSaleRows.value.filter((row) => row.status === "处理").length,
  done: afterSaleRecordRows.value.length,
}));
const scopedScans = computed(() => {
  return data.scans.filter((s) => scanInRoleScope(s) && inDateRange(s.date) && (!state.filters.shopId || s.shopId === state.filters.shopId));
});

  return {
    scopedShops,
    scopedOrders,
    reminderBaseOrders,
    taskOrders,
    afterSaleOrder,
    afterSaleRows,
    activeAfterSaleRows,
    afterSaleRecordRows,
    afterSaleSummary,
    scopedScans
  };
});
