// 经营看板与预警
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    addonRows,
    agentName,
    cityName,
    commission,
    computed,
    data,
    due,
    financeDue,
    inRoleScope,
    isHeadquarterSource,
    isOrderAfterSaleLocked,
    normalizeDateText,
    orderDistributorIds,
    orderShop,
    orderSourceName,
    orderSplit,
    peripheralStockStatus,
    productName,
    productStatus,
    reminderBaseOrders,
    roleProfile,
    scanInRoleScope,
    scopedOrders,
    scopedScans,
    scopedShops,
    shopName,
    spotName,
    state,
    statusDict,
    statusMeta,
    switchMenu,
    visibleCities
  } = ctx;

const dashboard = computed(() => {
  const orders = scopedOrders.value;
  const scans = scopedScans.value;
  const convertedOrders = orders.filter((o) => scans.some((s) => s.orderId === o.id));
  return {
    scans: scans.length,
    unique: new Set(scans.map((s) => s.openid)).size,
    browseOnly: scans.filter((s) => !s.orderId).length,
    conversion: convertedOrders.length,
    orders: convertedOrders.length,
    shops: scopedShops.value.length,
    amount: convertedOrders.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0),
    deposit: convertedOrders.reduce((sum, o) => sum + (o.depositFinanceStatus === "已审" ? Number(o.depositPaid || 0) : 0), 0),
    finalPaid: convertedOrders.reduce((sum, o) => sum + (o.finalFinanceStatus === "已审" ? Number(o.finalPaid || 0) : 0), 0),
    due: convertedOrders.reduce((sum, o) => sum + financeDue(o), 0),
    shopCommission: convertedOrders.reduce((sum, o) => sum + orderSplit(o).shopAmount, 0),
    distributorCommission: convertedOrders.reduce((sum, o) => sum + orderSplit(o).distributorAmount, 0),
    agentCommission: convertedOrders.reduce((sum, o) => sum + commission(o, "agent"), 0),
    photographerCommission: convertedOrders.reduce((sum, o) => sum + orderSplit(o).photographerAmount, 0),
    headquarterAmount: convertedOrders.reduce((sum, o) => sum + orderSplit(o).headquarterAmount, 0),
  };
});
const dashboardDelta = computed(() => {
  const range = state.filters.dateRange;
  if (!range || !range.length || !range[0] || !range[1]) return null;
  const toDay = (text) => {
    const parts = normalizeDateText(text).split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  };
  const start = toDay(range[0]);
  const end = toDay(range[1]);
  if (!start || !end || end < start) return null;
  const dayMs = 86400000;
  const prevEnd = new Date(start.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (end.getTime() - start.getTime()));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const prevRange = [fmt(prevStart), fmt(prevEnd)];
  const inPrev = (value) => {
    const cur = normalizeDateText(value);
    return !!cur && cur >= prevRange[0] && cur <= prevRange[1];
  };
  const delta = (now, prev) => {
    if (!prev) return { text: "上期无数据", trend: "flat" };
    const pct = Math.round(((now - prev) / prev) * 1000) / 10;
    if (pct === 0) return { text: "持平", trend: "flat" };
    return pct > 0 ? { text: `↑ ${Math.abs(pct)}%`, trend: "up" } : { text: `↓ ${Math.abs(pct)}%`, trend: "down" };
  };
  const prevScans = data.scans.filter((s) => scanInRoleScope(s) && inPrev(s.date) && (!state.filters.shopId || s.shopId === state.filters.shopId));
  const prevOrders = data.orders.filter((o) => !o.deleted && inRoleScope(o) && inPrev(o.appointmentAt) && (!state.filters.shopId || o.shopId === state.filters.shopId));
  const prevConverted = prevOrders.filter((o) => prevScans.some((s) => s.orderId === o.id));
  return {
    label: `对比 ${prevRange[0]} ~ ${prevRange[1]}`,
    scans: delta(scopedScans.value.length, prevScans.length),
    orders: delta(dashboard.value.orders, prevConverted.length),
    amount: delta(dashboard.value.amount, prevConverted.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0)),
  };
});
const reminders = computed(() => statusDict.map((s) => ({
  status: s.value,
  label: s.label,
  color: s.color,
  count: reminderBaseOrders.value.filter((o) => o.status === s.value).length,
})));
const activeAdvFilterCount = computed(() => ["financeStatus", "afterSaleStatus", "refundStatus", "transferStatus", "rescheduleStatus", "sourceType", "distributorId", "shopId", "assigneeId", "photographerId", "productType"].filter((key) => state.filters[key]).length);
const messageRows = computed(() => {
  const pending = scopedOrders.value.filter((o) => o.status === "pending");
  const dueList = scopedOrders.value.filter((o) => financeDue(o) > 0 && o.status !== "pending");
  const unassigned = scopedOrders.value.filter((o) => ["confirmed", "shooting"].includes(o.status) && !o.photographerId);
  const todayScans = scopedScans.value.filter((s) => s.date === "2026-06-29");
  return [
    { type: "新预约", count: pending.length, text: "待客服联系确认细节", action: "pending" },
    { type: "待收尾款", count: dueList.length, text: "已产生待收尾款的订单", action: "due" },
    { type: "待派摄影", count: unassigned.length, text: "已接单但未安排摄影师", action: "unassigned" },
    { type: "今日扫码", count: todayScans.length, text: "扫码明细可在看板下钻查看", action: "scan" },
  ].filter((m) => m.count > 0);
});
const selectedOrders = computed(() => scopedOrders.value.filter((o) => state.selectedOrderIds.includes(o.id)));
const selectedOrderBatchSummary = computed(() => {
  const rows = selectedOrders.value;
  return {
    total: rows.length,
    accept: rows.filter(ctx.canBatchAcceptOrder).length,
    note: rows.filter((order) => !isOrderAfterSaleLocked(order) && !["completed", "cancelled"].includes(order.status)).length,
    locked: rows.filter((order) => isOrderAfterSaleLocked(order)).length,
    completed: rows.filter((order) => ["completed", "cancelled"].includes(order.status)).length,
  };
});
const dashboardScopeShops = computed(() => scopedShops.value.filter((shop) => {
  if (state.dashboardCityId && shop.cityId !== state.dashboardCityId) return false;
  if (state.dashboardShopId && shop.id !== state.dashboardShopId) return false;
  return true;
}));
const dashboardScopeScans = computed(() => scopedScans.value.filter((scan) => {
  const shop = orderShop({ shopId: scan.shopId });
  if (state.dashboardCityId && shop.cityId !== state.dashboardCityId) return false;
  if (state.dashboardShopId && scan.shopId !== state.dashboardShopId) return false;
  return true;
}));
const shopRank = computed(() => scopedShops.value.filter((shop) => !state.dashboardCityId || shop.cityId === state.dashboardCityId).map((shop) => {
  const orders = data.orders.filter((o) => o.shopId === shop.id && !o.deleted);
  const scans = data.scans.filter((s) => s.shopId === shop.id);
  return { ...shop, orderCount: orders.length, scanCount: scans.length, amount: orders.reduce((n, o) => n + Number(o.totalAmount || 0), 0) };
}).sort((a, b) => b.amount - a.amount));
const cityRank = computed(() => visibleCities.value.map((city) => {
  const shops = scopedShops.value.filter((s) => s.cityId === city.id);
  const shopIds = new Set(shops.map((s) => s.id));
  const orders = data.orders.filter((o) => shopIds.has(o.shopId) && !o.deleted);
  return { ...city, shops: shops.length, orders: orders.length, amount: orders.reduce((s, o) => s + o.totalAmount, 0) };
}).sort((a, b) => b.amount - a.amount));
const scanHeat = computed(() => Array.from({ length: 24 }, (_, hour) => ({ hour, count: dashboardScopeScans.value.filter((s) => s.hour === hour).length })));
const scanLineMax = computed(() => Math.max(...scanHeat.value.map((item) => Number(item.count || 0)), 1));
const scanLinePoints = computed(() => scanHeat.value.map((item, index) => {
  const x = 8 + (index / 23) * 224;
  const y = 104 - (Number(item.count || 0) / scanLineMax.value) * 86;
  return { ...item, x, y };
}));
const scanLinePolyline = computed(() => scanLinePoints.value.map((item) => `${item.x.toFixed(1)},${item.y.toFixed(1)}`).join(" "));
const scanLineArea = computed(() => `8,112 ${scanLinePolyline.value} 232,112`);
const scanLinePeak = computed(() => scanLinePoints.value.slice().sort((a, b) => Number(b.count || 0) - Number(a.count || 0))[0] || { hour: 0, count: 0, x: 8, y: 104 });
const drillTitle = computed(() => ({
  scan: "扫码明细：按城市、代理、分销员、商家和二维码位置分",
  conversion: "扫码转化订单明细",
  deposit: "已收定金订单",
  final: "已收尾款订单",
  due: "待收尾款订单",
  amount: "成交额订单明"
}[state.dashboardDrill] || "点击上方数据卡片查看追溯明细"));
const drillRows = computed(() => {
  if (!state.dashboardDrill) return [];
  const metricFilters = state.metricFilters;
  if (state.dashboardDrill === "scan") {
    let rows = scopedScans.value.map((s) => {
      const shop = orderShop({ shopId: s.shopId });
      const order = data.orders.find((item) => item.id === s.orderId);
      return {
        ...s,
        date: s.date,
        cityId: shop.cityId,
        agentId: shop.agentId,
        distributorId: s.distributorId || order?.distributorId || "",
        distributorIds: orderDistributorIds(order || { shopId: s.shopId }),
        sourceName: orderSourceName(order || s),
        status: s.orderId ? "已转" : "浏览未下",
        scanCount: 1,
        orderNo: order?.orderNo || "-",
        customer: order?.customer || "-",
        totalAmount: order?.totalAmount || 0,
      };
    });
    rows = rows.filter((row) => {
      const shop = orderShop({ shopId: row.shopId });
      if (metricFilters.cityId && shop.cityId !== metricFilters.cityId) return false;
      if (metricFilters.shopId && row.shopId !== metricFilters.shopId) return false;
      if (metricFilters.scene && row.scene !== metricFilters.scene) return false;
      if (metricFilters.status && row.status !== metricFilters.status) return false;
      if (metricFilters.keyword && !JSON.stringify({ ...row, shop: shopName(row.shopId), source: orderSourceName(row), city: cityName(shop.cityId) }).includes(metricFilters.keyword)) return false;
      return true;
    });
    return rows;
  }
  let rows = scopedOrders.value.filter((o) => scopedScans.value.some((s) => s.orderId === o.id));
  if (state.dashboardDrill === "conversion") rows = rows.filter((o) => scopedScans.value.some((s) => s.orderId === o.id));
  if (state.dashboardDrill === "deposit") rows = rows.filter((o) => Number(o.depositPaid) > 0);
  if (state.dashboardDrill === "final") rows = rows.filter((o) => Number(o.finalPaid) > 0);
  if (state.dashboardDrill === "due") rows = rows.filter((o) => financeDue(o) > 0);
  return rows.map((o) => ({ ...o, date: o.appointmentAt.slice(0, 10), scene: isHeadquarterSource(o) ? (o.sourceScene || "总部二维") : orderShop(o).qrPosition, sourceName: orderSourceName(o), status: statusMeta(o.status).label })).filter((row) => {
    const shop = orderShop(row);
    if (metricFilters.cityId && shop.cityId !== metricFilters.cityId) return false;
    if (metricFilters.shopId && row.shopId !== metricFilters.shopId) return false;
    if (metricFilters.scene && row.scene !== metricFilters.scene) return false;
    if (metricFilters.status && row.status !== metricFilters.status) return false;
    if (metricFilters.keyword && !JSON.stringify({ ...row, shop: shopName(row.shopId), source: orderSourceName(row), city: cityName(shop.cityId), products: (row.products || []).map(productName) }).includes(metricFilters.keyword)) return false;
    return true;
  });
});
const scanMetricSummary = computed(() => {
  const rows = state.dashboardDrill === "scan" ? drillRows.value : [];
  const converted = rows.filter((row) => row.orderId);
  return {
    scans: rows.length,
    unique: new Set(rows.map((row) => row.openid)).size,
    browseOnly: rows.filter((row) => !row.orderId).length,
    converted: converted.length,
    shops: new Set(rows.map((row) => row.shopId)).size,
    scenes: new Set(rows.map((row) => row.scene)).size,
    amount: converted.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0),
  };
});
function dashboardProductCategory(product = {}, source = null) {
  const id = product.id || product.productId || source?.id || "";
  const pkg = source || data.packages.find((item) => item.id === id);
  if (pkg) return pkg.type === "video" || product.type === "video" ? "video" : "photo";
  if (data.albums.some((item) => item.id === id)) return "album";
  if (data.peripherals.some((item) => item.id === id)) return "peripheral";
  if (data.addonServices.some((item) => item.id === id)) return "addon";
  if (product.productType === "service" || product.category === "addon") return "addon";
  if (product.productType === "peripheral") return "peripheral";
  if (product.type === "video") return "video";
  return "photo";
}
function dashboardCategoryLabel(key) {
  return { photo: "照片套餐", video: "短视频", album: "可售照片单品", peripheral: "摄影周边", addon: "增值服务" }[key] || "商品";
}
function dashboardCategoryColor(key) {
  return { photo: "#E0662A", video: "#FF8D52", album: "#1F9254", peripheral: "#EE2C2C", addon: "#1F9254" }[key] || "#64748b";
}
const dashboardProductSalesRows = computed(() => {
  const rows = [];
  scopedOrders.value
    .filter((order) => !["cancelled", "canceled"].includes(order.status) && Number(order.totalAmount || 0) > 0)
    .forEach((order) => {
      const products = Array.isArray(order.products) && order.products.length ? order.products : [{ id: order.productId, name: productName(order.productId), price: order.totalAmount }];
      const orderTotal = Number(order.totalAmount || 0);
      const sumProductPrice = products.reduce((sum, product) => sum + Number(product.price || product.specialPrice || product.amount || 0), 0);
      products.forEach((product) => {
        const id = product.id || product.productId || product.name || order.id;
        const source = data.packages.find((item) => item.id === id) || data.albums.find((item) => item.id === id) || data.peripherals.find((item) => item.id === id) || data.addonServices.find((item) => item.id === id) || null;
        const category = dashboardProductCategory(product, source);
        const rawAmount = Number(product.price || product.specialPrice || product.amount || 0);
        const amount = rawAmount || (sumProductPrice ? Math.round(orderTotal * rawAmount / sumProductPrice) : Math.round(orderTotal / products.length));
        const spotId = product.spotId || source?.spotId || order.spotId || "";
        rows.push({
          key: `${category}-${id}`,
          id,
          orderId: order.id,
          orderNo: order.orderNo,
          name: product.name || source?.name || productName(id),
          category,
          categoryLabel: dashboardCategoryLabel(category),
          revenue: amount,
          orders: 1,
          status: productStatus(source || product),
          spotId,
          spotName: spotName(spotId),
          source: source || product,
          date: String(order.appointmentAt || order.createdAt || "").slice(0, 10),
        });
      });
    });
  return rows;
});
const dashboardProductSummary = computed(() => {
  const rows = dashboardProductSalesRows.value;
  const publicRows = rows.filter((row) => row.category !== "addon");
  const addonRows = rows.filter((row) => row.category === "addon");
  return {
    publicRevenue: publicRows.reduce((sum, row) => sum + Number(row.revenue || 0), 0),
    publicOrders: new Set(publicRows.map((row) => row.orderId)).size,
    addonRevenue: addonRows.reduce((sum, row) => sum + Number(row.revenue || 0), 0),
    addonOrders: new Set(addonRows.map((row) => row.orderId)).size,
  };
});
const dashboardProductCategoryRows = computed(() => ["photo", "video", "album", "peripheral", "addon"].map((key) => {
  const rows = dashboardProductSalesRows.value.filter((row) => row.category === key);
  return {
    key,
    label: dashboardCategoryLabel(key),
    color: dashboardCategoryColor(key),
    revenue: rows.reduce((sum, row) => sum + Number(row.revenue || 0), 0),
    orders: new Set(rows.map((row) => row.orderId)).size,
  };
}));
const dashboardProductPieStyle = computed(() => {
  const rows = dashboardProductCategoryRows.value;
  const total = rows.reduce((sum, row) => sum + row.revenue, 0) || 1;
  let cursor = 0;
  const stops = rows.map((row) => {
    const start = cursor;
    cursor += row.revenue / total * 100;
    return `${row.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  return { background: `conic-gradient(${stops.join(", ")})` };
});
const dashboardHotProducts = computed(() => {
  const map = new Map();
  dashboardProductSalesRows.value.filter((row) => row.category !== "addon").forEach((row) => {
    const item = map.get(row.key) || { ...row, revenue: 0, orders: 0 };
    item.revenue += Number(row.revenue || 0);
    item.orders += 1;
    map.set(row.key, item);
  });
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
});
const dashboardSlowProducts = computed(() => {
  const soldKeys = new Set(dashboardProductSalesRows.value.map((row) => row.key));
  return [
    ...data.packages.filter((item) => !item.deleted).map((item) => ({ key: `${item.type === "video" ? "video" : "photo"}-${item.id}`, source: item, name: item.name, categoryLabel: item.type === "video" ? "短视频" : "照片套餐", spotName: spotName(item.spotId), risk: "近30天0成交" })),
    ...data.albums.filter((item) => !item.deleted && item.isSellable !== false).map((item) => ({ key: `album-${item.id}`, source: item, name: item.name, categoryLabel: "可售照片单品", spotName: spotName(item.spotId), risk: "近30天0成交" })),
    ...data.peripherals.filter((item) => !item.deleted).map((item) => ({ key: `peripheral-${item.id}`, source: item, name: item.name, categoryLabel: "摄影周边", spotName: spotName(item.spotId), risk: Number(item.stock ?? item.stockQty ?? 0) <= 5 ? "库存不足" : "近30天0成交" })),
  ].filter((item) => !soldKeys.has(item.key) || item.risk === "库存不足").slice(0, 10);
});
const dashboardSpotRevenueRows = computed(() => {
  const map = new Map();
  dashboardProductSalesRows.value.filter((row) => row.spotId).forEach((row) => {
    const item = map.get(row.spotId) || { id: row.spotId, name: spotName(row.spotId), revenue: 0, orders: 0 };
    item.revenue += Number(row.revenue || 0);
    item.orders += 1;
    map.set(row.spotId, item);
  });
  const rows = Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  const max = Math.max(...rows.map((row) => row.revenue), 1);
  return rows.map((row) => ({ ...row, percent: Math.max(6, Math.round(row.revenue / max * 100)) }));
});
const dashboardDailySalesRows = computed(() => {
  const map = new Map();
  dashboardProductSalesRows.value.forEach((row) => {
    const date = row.date || "未排期";
    const item = map.get(date) || { date, revenue: 0, orders: 0 };
    item.revenue += Number(row.revenue || 0);
    item.orders += 1;
    map.set(date, item);
  });
  return Array.from(map.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
});
const dashboardPeripheralSales = computed(() => {
  const top = dashboardHotProducts.value.filter((row) => row.category === "peripheral").slice(0, 5);
  const lowStock = data.peripherals.filter((item) => !item.deleted && Number(item.stock ?? item.stockQty ?? 0) <= 5);
  return {
    outbound: top.reduce((sum, row) => sum + Number(row.orders || 0), 0),
    stock: data.peripherals.reduce((sum, item) => sum + Number(item.stock ?? item.stockQty ?? 0), 0),
    lowStock,
    top,
  };
});
const dashboardRiskAlerts = computed(() => [
  ...dashboardSlowProducts.value.slice(0, 3).map((row) => ({ type: "商品风险", level: "warning", title: row.name, desc: row.risk })),
  ...dashboardPeripheralSales.value.lowStock.slice(0, 3).map((row) => ({ type: "库存风险", level: "danger", title: row.name, desc: peripheralStockStatus(row) })),
]);
function dashboardTrendPoints(type = "revenue") {
  const rows = dashboardDailySalesRows.value;
  if (!rows.length) return "10,110 230,110";
  const max = Math.max(...rows.map((row) => Number(row[type] || 0)), 1);
  return rows.map((row, index) => {
    const x = rows.length === 1 ? 120 : 10 + index * (220 / (rows.length - 1));
    const y = 110 - Number(row[type] || 0) / max * 90;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}
function openDashboardProduct(row) {
  const source = row?.source || row;
  if (row?.category === "peripheral" || data.peripherals.some((item) => item.id === source?.id)) return switchMenu("peripherals");
  if (row?.category === "album" || data.albums.some((item) => item.id === source?.id)) return switchMenu("albums");
  if (row?.category === "video" || source?.type === "video") return switchMenu("videoSingles");
  return switchMenu("packages");
}
function openDashboardSpot(row) {
  if (row?.id) state.filters.contentSpotId = row.id;
  switchMenu("spots", { preserveFilters: true });
}
function exportDashboardProductSales() {
  ctx.exportCsv("商品售卖明细", dashboardProductSalesRows.value.map((row) => ({
    商品名称: row.name,
    品类: row.categoryLabel,
    点位: row.spotName || "-",
    订单号: row.orderNo,
    金额: row.revenue,
    状态: row.status,
  })));
}
const metricScenes = computed(() => Array.from(new Set(scopedScans.value.map((scan) => scan.scene).filter(Boolean))));
function resetMetricFilters() {
  state.metricFilters = { cityId: "", shopId: "", scene: "", status: "", keyword: "" };
}
function heatColor(count) {
  if (count >= 4) return "#FF6B6B";
  if (count >= 2) return "#ffb3a6";
  if (count >= 1) return "#ffe1dd";
  return "#f4f6f9";
}
function drillRowClick(row) {
  const order = row.orderNo ? row : data.orders.find((o) => o.id === row.orderId);
  if (order) ctx.openOrder(order, { readonly: true });
}
function setDashboardDrill(type) {
  state.dashboardDrill = type;
  resetMetricFilters();
  state.metricDialog = true;
}
const dashboardScopeLabel = computed(() => {
  if (state.role === "merchant") return `当前商家：${shopName(roleProfile.value.shopId)}`;
  if (state.dashboardShopId) return `当前商家：${shopName(state.dashboardShopId)}`;
  if (state.dashboardCityId) return `当前城市：${cityName(state.dashboardCityId)}`;
  if (state.role === "agent") return `当前代理后台：${agentName(roleProfile.value.agentId)} · ${cityName(roleProfile.value.cityId)}`;
  return "全部城市 / 全部商家";
});
function selectDashboardCity(row) {
  state.dashboardCityId = row.id;
  state.dashboardShopId = "";
  ElMessage.success(`已切换到${row.name}，商家排行与扫码热力已联动`);
}
function selectDashboardShop(row) {
  state.dashboardCityId = row.cityId || state.dashboardCityId;
  state.dashboardShopId = row.id;
  ElMessage.success(`已切换到${row.name}，扫码热力已联动`);
}
function clearDashboardScope(type = "all") {
  if (type === "city") {
    state.dashboardCityId = "";
    state.dashboardShopId = "";
  } else if (type === "shop") {
    state.dashboardShopId = "";
  } else {
    state.dashboardCityId = "";
    state.dashboardShopId = "";
  }
}
function rankOrders(type, id) {
  return scopedOrders.value.filter((order) => {
    const shop = orderShop(order);
    if (type === "shop") return order.shopId === id;
    if (type === "city") return shop.cityId === id;
    return false;
  });
}
function openRankPreview(type, row) {
  const orders = rankOrders(type, row.id);
  const scans = type === "shop"
    ? scopedScans.value.filter((scan) => scan.shopId === row.id)
    : scopedScans.value.filter((scan) => orderShop({ shopId: scan.shopId }).cityId === row.id);
  state.rankPreview = {
    type,
    id: row.id,
    name: row.name,
    subtitle: type === "shop" ? `${cityName(row.cityId)} · ${row.qrPosition || row.scene || "商家二维"}` : `${row.shops || 0} 个商家`,
    scans: scans.length,
    orders: orders.length,
    amount: orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    rows: orders.map((order) => ({ ...order, statusText: statusMeta(order.status).label })),
  };
  state.rankPreviewDialog = true;
}
function clearRankFilter(type = "all") {
  if (type === "shop" || type === "all") state.filters.shopId = "";
  if (type === "city" || type === "all") state.filters.cityId = "";
  ElMessage.success(type === "all" ? "已恢复查看全部排行数" : "已清空当前排行筛");
}
function confirmRankJump() {
  if (!state.rankPreview) return;
  if (state.rankPreview.type === "shop") {
    state.filters.shopId = state.rankPreview.id;
    state.filters.cityId = "";
  }
  if (state.rankPreview.type === "city") {
    state.filters.cityId = state.rankPreview.id;
    state.filters.shopId = "";
  }
  state.rankPreviewDialog = false;
  switchMenu("orders", { preserveFilters: true });
}
function sumOrders(rows, type) {
  return rows.reduce((sum, o) => {
    if (type === "total") return sum + Number(o.totalAmount || 0);
    if (type === "deposit") return sum + Number(o.depositPaid || 0);
    if (type === "final") return sum + Number(o.finalPaid || 0);
    if (type === "due") return sum + financeDue(o);
    return sum;
  }, 0);
}
function clearOrderFilters() {
  Object.assign(state.filters, { dateRange: "", cityId: "", agentId: "", distributorId: "", shopId: "", sourceType: "", status: "", financeStatus: "", afterSaleStatus: "", refundStatus: "", transferStatus: "", rescheduleStatus: "", assigneeId: "", photographerId: "", productType: "", keyword: "" });
  state.selectedOrderIds = [];
}
function openReminderPreview(row) {
  const rows = reminderBaseOrders.value.filter((order) => order.status === row.status);
  state.reminderPreview = {
    ...row,
    rows,
    amount: rows.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    dueAmount: rows.reduce((sum, order) => sum + financeDue(order), 0),
  };
  state.reminderPreviewDialog = true;
}
function confirmReminderJump() {
  if (!state.reminderPreview) return;
  clearOrderFilters();
  state.filters.status = state.reminderPreview.status;
  state.reminderPreviewDialog = false;
  switchMenu("orders", { preserveFilters: true });
}

  return {
    dashboard,
    dashboardDelta,
    reminders,
    activeAdvFilterCount,
    messageRows,
    selectedOrders,
    selectedOrderBatchSummary,
    dashboardScopeShops,
    dashboardScopeScans,
    shopRank,
    cityRank,
    scanHeat,
    scanLineMax,
    scanLinePoints,
    scanLinePolyline,
    scanLineArea,
    scanLinePeak,
    drillTitle,
    drillRows,
    scanMetricSummary,
    dashboardProductCategory,
    dashboardCategoryLabel,
    dashboardCategoryColor,
    dashboardProductSalesRows,
    dashboardProductSummary,
    dashboardProductCategoryRows,
    dashboardProductPieStyle,
    dashboardHotProducts,
    dashboardSlowProducts,
    dashboardSpotRevenueRows,
    dashboardDailySalesRows,
    dashboardPeripheralSales,
    dashboardRiskAlerts,
    dashboardTrendPoints,
    openDashboardProduct,
    openDashboardSpot,
    exportDashboardProductSales,
    metricScenes,
    resetMetricFilters,
    heatColor,
    drillRowClick,
    setDashboardDrill,
    dashboardScopeLabel,
    selectDashboardCity,
    selectDashboardShop,
    clearDashboardScope,
    rankOrders,
    openRankPreview,
    clearRankFilter,
    confirmRankJump,
    sumOrders,
    clearOrderFilters,
    openReminderPreview,
    confirmReminderJump
  };
});
