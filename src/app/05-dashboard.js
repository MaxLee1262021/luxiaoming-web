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
    cityById,
    commission,
    computed,
    data,
    due,
    financeDue,
    inRoleScope,
    isHeadquarterSource,
    isCreatedBooking,
    isOrderCancelledStatus,
    isOrderCompletedStatus,
    isOrderAfterSaleLocked,
    normalizeDateText,
    normalizeReviewStatus,
    orderDistributorIds,
    orderBusinessStatus,
    orderShop,
    orderSourceName,
    orderSplit,
    peripheralStockStatus,
    productName,
    productStatus,
    reminderBaseOrders,
    roleProfile,
    sameCity,
    sameShop,
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

// Read-only ledger projection. It contains no extra order/customer payload;
// every drill-down below still intersects the existing authorized order pool.
const shareAnalytics = ctx.reactive ? ctx.reactive({ ready: false, loading: false, error: "", merchants: [], orderAttributions: [], totalAmount: null, cityScope: "", scanScope: "", bindingScope: "" })
  : { ready: false, loading: false, error: "", merchants: [], orderAttributions: [], totalAmount: null, cityScope: "", scanScope: "", bindingScope: "" };
let analyticsRequest = 0;
function canReadShareAnalytics() { return state.role === "super" || !!ctx.can?.("shareView"); }
function clearShareAnalytics() {
  analyticsRequest += 1; Object.assign(shareAnalytics, { ready: false, loading: false, error: "", merchants: [], orderAttributions: [], totalAmount: null, cityScope: "", scanScope: "", bindingScope: "" });
}
function analyticsQuery() {
  const query = {};
  const route = typeof ctx.menuRouteKey === "function" ? ctx.menuRouteKey(state.active) : state.active;
  if (["reconciliation", "report"].includes(route)) query.period = state.filters.reconcileMonth || LXMFormat.date(new Date()).slice(0, 7);
  else if (Array.isArray(state.filters.dateRange) && state.filters.dateRange[0]) { query.startDate = state.filters.dateRange[0]; query.endDate = state.filters.dateRange[1] || state.filters.dateRange[0]; }
  if (state.filters.shopId) query.merchantId = state.filters.shopId;
  const cityId = typeof ctx.statisticsCityId === "function" ? ctx.statisticsCityId() : state.filters.cityId;
  if (cityId) query.cityId = cityId;
  return new URLSearchParams(query).toString();
}
async function loadShareAnalytics() {
  clearShareAnalytics();
  if (!state.authed || !window.LXM_AUTH?.hasSession?.() || !canReadShareAnalytics()) return;
  const requestId = analyticsRequest; shareAnalytics.loading = true;
  try {
    const response = await window.LXM_HTTP.request(`/api/share/analytics?${analyticsQuery()}`);
    const body = await response.json();
    if (!response.ok || body.code !== undefined && ![0, "0"].includes(body.code)) throw new Error(body.msg || body.error || "商家分成统计加载失败");
    if (requestId !== analyticsRequest) return;
    const result = body.data?.data ?? body.data ?? body;
    Object.assign(shareAnalytics, { ready: true, merchants: result.merchants || [], orderAttributions: result.orderAttributions || [], totalAmount: result.totalAmount ?? "0.00", cityScope: result.cityScope || "", scanScope: result.scanScope || "", bindingScope: result.bindingScope || "" });
  } catch (error) { if (requestId === analyticsRequest) shareAnalytics.error = error.message || "商家分成统计暂不可用"; }
  finally { if (requestId === analyticsRequest) shareAnalytics.loading = false; }
}
async function refreshDashboard() {
  if (!state.authed || !window.LXM_AUTH?.hasSession?.()) return;
  await Promise.all([ctx.loadAuthenticatedData?.("dashboard", { force: true }), loadShareAnalytics()]);
}
function shareAttribution(order) {
  const id = String(typeof order === "string" ? order : order?.id || order?._id || "");
  return shareAnalytics.ready ? shareAnalytics.orderAttributions.find((row) => String(row.orderId) === id) || null : null;
}
function shareAmountForOrders(orders, field) {
  if (!shareAnalytics.ready) return null;
  const ids = new Set(orders.map((order) => String(order.id || order._id)));
  const rows = shareAnalytics.orderAttributions.filter((row) => ids.has(String(row.orderId)));
  if (rows.some((row) => row[field] === undefined || row[field] === null || !Number.isFinite(Number(row[field])))) return null;
  // Aggregate persisted cents; never multiply an order by a current rule.
  return rows.reduce((sum, row) => sum + Math.round(Number(row[field]) * 100), 0) / 100;
}
function shareLedgerForOrders(orders) { return shareAmountForOrders(orders, "ledgerAmount"); }
function shareBalanceForOrders(orders) { return shareAmountForOrders(orders, "amount"); }
function shareHeadquarterForOrders(orders) {
  if (!shareAnalytics.ready) return null;
  const merchantBalance = shareBalanceForOrders(orders);
  if (merchantBalance === null) return null;
  return orders.reduce((sum, order) => {
    const split = orderSplit(order);
    return sum + Number(split.netAmount || 0) - Number(split.distributorAmount || 0) - Number(split.photographerAmount || 0);
  }, 0) - merchantBalance;
}
const shareSourceDistribution = computed(() => {
  if (!shareAnalytics.ready) return [];
  const groups = [{ key: "T1", label: "商家自主订单", count: 0 }, { key: "T2", label: "商家客服订单", count: 0 }, { key: "platform", label: "归平台", count: 0 }, { key: "pending", label: "尚未生成分成", count: 0 }];
  scopedOrders.value.forEach((order) => {
    const hit = shareAttribution(order);
    const key = !hit || hit.pending ? "pending" : !hit.merchantId || String(hit.merchantId) === "0" ? "platform" : hit.splitType === "T2" ? "T2" : "T1";
    groups.find((row) => row.key === key).count += 1;
  });
  return groups;
});
if (ctx.watch) ctx.watch(() => JSON.stringify([state.authed, state.role, state.currentAccount, state.active, state.filters.reconcileMonth, state.filters.dateRange, state.filters.shopId, state.filters.cityId, state.dashboardCityId]), () => {
  const route = typeof ctx.menuRouteKey === "function" ? ctx.menuRouteKey(state.active) : state.active;
  if (["dashboard", "performance", "reconciliation", "report"].includes(route)) loadShareAnalytics(); else clearShareAnalytics();
});
window.addEventListener?.("lxm-auth-expired", clearShareAnalytics);
window.addEventListener?.("lxm-auth-changed", clearShareAnalytics);

const dashboard = computed(() => {
  const orders = scopedOrders.value;
  const scans = scopedScans.value;
  const convertedOrders = orders.filter((o) => scans.some((s) => s.orderId === o.id));
  const visitorKey = (scan) => String(scan && (scan.visitorHash || scan.visitorId || scan.openid || scan.unionid || scan.sessionId || scan.id || "") || "").trim();
  return {
    scans: scans.length,
    unique: new Set(scans.map(visitorKey).filter(Boolean)).size,
    browseOnly: scans.filter((s) => !s.orderId).length,
    conversion: convertedOrders.length,
    orders: convertedOrders.length,
    shops: scopedShops.value.length,
    amount: convertedOrders.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0),
    deposit: convertedOrders.reduce((sum, o) => sum + (normalizeReviewStatus(o.depositFinanceStatus) === "已审" ? Number(o.depositPaid || 0) : 0), 0),
    finalPaid: convertedOrders.reduce((sum, o) => sum + (normalizeReviewStatus(o.finalFinanceStatus) === "已审" ? Number(o.finalPaid || 0) : 0), 0),
    due: convertedOrders.reduce((sum, o) => sum + financeDue(o), 0),
    shopCommission: shareLedgerForOrders(orders),
    distributorCommission: convertedOrders.reduce((sum, o) => sum + orderSplit(o).distributorAmount, 0),
    agentCommission: convertedOrders.reduce((sum, o) => sum + commission(o, "agent"), 0),
    photographerCommission: convertedOrders.reduce((sum, o) => sum + orderSplit(o).photographerAmount, 0),
    headquarterAmount: shareHeadquarterForOrders(convertedOrders),
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
  const prevScans = data.scans.filter((s) => scanInRoleScope(s) && inPrev(s.date) && (!state.filters.shopId || sameShop(s, state.filters.shopId)));
  const prevOrders = data.orders.filter((o) => isCreatedBooking(o) && !o.deleted && inRoleScope(o) && inPrev(o.appointmentAt)
    && (!state.filters.shopId || (ctx.usesShareStatisticsFilters?.() ? ctx.matchesStatisticsMerchant?.(o, state.filters.shopId) : sameShop(o, state.filters.shopId)))
    && (!state.filters.cityId || (ctx.usesShareStatisticsFilters?.() ? ctx.matchesOrderBusinessCity?.(o, state.filters.cityId) : sameCity(orderShop(o), state.filters.cityId))));
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
  count: reminderBaseOrders.value.filter((o) => orderBusinessStatus(o) === s.value).length,
})));
const activeAdvFilterCount = computed(() => ["financeStatus", "afterSaleStatus", "refundStatus", "transferStatus", "rescheduleStatus", "sourceType", "distributorId", "shopId", "assigneeId", "photographerId", "productType"].filter((key) => state.filters[key]).length);
const messageRows = computed(() => {
  const pending = scopedOrders.value.filter((o) => orderBusinessStatus(o) === "reserved" && !o.assigneeId);
  const dueList = scopedOrders.value.filter((o) => financeDue(o) > 0);
  const unassigned = scopedOrders.value.filter((o) => orderBusinessStatus(o) === "reserved" && !o.photographerId);
  const today = LXMFormat.date(new Date());
  const todayScans = scopedScans.value.filter((s) => normalizeDateText(s.businessDate || s.date || s.createTime || s.scanTime) === today);
  return [
    { type: "新预约", count: pending.length, text: "待客服联系确认细节", action: "pending" },
    { type: "待收尾款", count: dueList.length, text: "已产生待收尾款的订单", action: "due" },
    { type: "待派摄影", count: unassigned.length, text: "已支付定金但未安排摄影师", action: "unassigned" },
    { type: "今日扫码", count: todayScans.length, text: "扫码明细可在看板下钻查看", action: "scan" },
  ].filter((m) => m.count > 0);
});
const selectedOrders = computed(() => scopedOrders.value.filter((o) => state.selectedOrderIds.includes(o.id)));
const selectedOrderBatchSummary = computed(() => {
  const rows = selectedOrders.value;
  return {
    total: rows.length,
    accept: rows.filter(ctx.canBatchAcceptOrder).length,
      note: rows.filter((order) => !isOrderAfterSaleLocked(order) && !isOrderCompletedStatus(order) && !isOrderCancelledStatus(order)).length,
    locked: rows.filter((order) => isOrderAfterSaleLocked(order)).length,
      completed: rows.filter((order) => isOrderCompletedStatus(order) || isOrderCancelledStatus(order)).length,
  };
});
const dashboardScopeShops = computed(() => scopedShops.value.filter((shop) => {
  if (state.dashboardCityId && shareAnalytics.ready && !shareAnalytics.merchants.some((merchant) => String(merchant.merchantId) === String(shop.id || shop._id))) return false;
  if (state.dashboardShopId && !sameShop(shop, state.dashboardShopId)) return false;
  return true;
}));
const dashboardScopeScans = computed(() => scopedScans.value.filter((scan) => {
  if (state.dashboardShopId && !sameShop(scan, state.dashboardShopId)) return false;
  return true;
}));
const shopRank = computed(() => !shareAnalytics.ready ? [] : shareAnalytics.merchants.map((merchant) => {
  const shop = scopedShops.value.find((row) => String(row.id || row._id) === String(merchant.merchantId));
  return { ...(shop || {}), ...merchant, id: String(merchant.merchantId), amount: Number(merchant.totalAmount || 0), ledgerReadOnly: true };
}).sort((a, b) => b.amount - a.amount));
const cityRank = computed(() => visibleCities.value.map((city) => {
  const orders = scopedOrders.value.filter((order) => ctx.matchesOrderBusinessCity?.(order, city));
  const merchants = new Set(orders.map((order) => shareAttribution(order)?.merchantId).filter((id) => id && String(id) !== "0"));
  return { ...city, shops: merchants.size, orders: orders.length, amount: orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0) };
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
  amount: "成交额订单明细"
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
        cityId: cityById(shop).id || shop.cityId || shop.city || "",
        agentId: shop.agentId,
        distributorId: s.distributorId || order?.distributorId || "",
        distributorIds: orderDistributorIds(order || { shopId: s.shopId }),
        sourceName: orderSourceName(order || s),
        status: s.orderId ? "已转化" : "浏览未下单",
        scanCount: 1,
        orderNo: order?.orderNo || "-",
        customer: order?.customer || "-",
        totalAmount: order?.totalAmount || 0,
      };
    });
    rows = rows.filter((row) => {
      const shop = orderShop({ shopId: row.shopId });
      if (metricFilters.cityId && !sameCity(shop, metricFilters.cityId)) return false;
      if (metricFilters.shopId && !sameShop(row, metricFilters.shopId)) return false;
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
    if (metricFilters.cityId && !ctx.matchesOrderBusinessCity?.(row, metricFilters.cityId)) return false;
    if (metricFilters.shopId && !ctx.matchesStatisticsMerchant?.(row, metricFilters.shopId)) return false;
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
    unique: new Set(rows.map((row) => String(row.visitorHash || row.visitorId || row.openid || row.unionid || row.sessionId || row.id || "")).filter(Boolean)).size,
    browseOnly: rows.filter((row) => !row.orderId).length,
    converted: converted.length,
    shops: new Set(rows.map((row) => row.shopId)).size,
    scenes: new Set(rows.map((row) => row.scene)).size,
    amount: converted.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0),
  };
});
const recentScanSources = computed(() => scopedScans.value
  .slice()
  .sort((a, b) => String(b.scanTime || b.createTime || b.businessDate || b.date || "").localeCompare(String(a.scanTime || a.createTime || a.businessDate || a.date || "")))
  .slice(0, 8)
  .map((scan) => {
    const order = scan.orderId ? data.orders.find((item) => String(item.id || item._id) === String(scan.orderId)) : null;
    return {
      ...scan,
      sourceName: orderSourceName(order || scan),
      shopName: shopName(scan.shopId || order?.shopId),
      date: normalizeDateText(scan.businessDate || scan.date || scan.scanTime || scan.createTime),
      converted: !!scan.orderId,
    };
  }));
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
  const active = data.peripherals.filter((item) => item && !item.deleted && !item.isDeleted);
  const quantity = (value) => value !== null && value !== undefined && String(value).trim() !== ""
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const stockOf = (item) => quantity(item.stock ?? item.stockQty);
  const lowStock = active.filter((item) => {
    const stock = stockOf(item);
    return stock !== null && stock <= (quantity(item.stockWarning) ?? 5);
  });
  // 订单数量不能充当出库事实；缺少实际出库字段时保持未采集。
  const outbound = active.map((item) => quantity(item.outboundQty ?? item.shippedQty));
  return {
    outbound: outbound.some((value) => value !== null) ? outbound.reduce((sum, value) => sum + (value ?? 0), 0) : null,
    stock: active.reduce((sum, item) => sum + (stockOf(item) ?? 0), 0),
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
  if (state.dashboardCityId) return `消费城市：${cityName(state.dashboardCityId)}；扫码记录不按消费城市拆分`;
  if (state.role === "agent") return `当前代理后台：${agentName(roleProfile.value.agentId)} · ${cityName(roleProfile.value.cityId)}`;
  return "全部城市 / 全部商家";
});
function selectDashboardCity(row) {
  state.dashboardCityId = row.id;
  state.dashboardShopId = "";
  ElMessage.success(`已按${row.name}的消费订单更新排行，扫码仍按门店记录展示`);
}
function selectDashboardShop(row) {
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
    if (type === "shop") return String(shareAttribution(order)?.merchantId || "") === String(id);
    if (type === "city") return !!ctx.matchesOrderBusinessCity?.(order, id);
    return false;
  });
}
function openRankPreview(type, row) {
  const orders = rankOrders(type, row.id);
  state.rankPreview = {
    type,
    id: row.id,
    name: row.name,
    subtitle: type === "shop" ? "按新分成归属展示；扫码为当前有效码的门店累计，不按消费城市拆分" : `${row.shops || 0} 个归属商家；扫码不按消费城市拆分`,
    scans: type === "shop" ? Number(row.scanCount || 0) : "—",
    orders: orders.length,
    amount: type === "shop" ? Number(row.totalAmount || 0) : orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
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
    if (!ctx.shareState || !ctx.can?.("shareView")) return ElMessage.warning("当前账号没有分成明细权限");
    ctx.shareState.detailQuery.merchantId = state.rankPreview.id;
    ctx.shareState.detailQuery.period = state.filters.reconcileMonth || "";
    ctx.shareState.detailQuery.page = 1;
    state.rankPreviewDialog = false;
    const menu = (LXM_CONFIG.menus || []).find((row) => String(row.routeKey || row.targetKey || row.key) === "shareDetails" && (roleProfile.value.menus || []).includes(row.key));
    return switchMenu(menu?.key || "shareDetails");
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
  const rows = reminderBaseOrders.value.filter((order) => orderBusinessStatus(order) === row.status);
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
    shareAnalytics, loadShareAnalytics, refreshDashboard, clearShareAnalytics, canReadShareAnalytics, shareAttribution, shareLedgerForOrders, shareBalanceForOrders, shareHeadquarterForOrders, shareSourceDistribution,
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
    recentScanSources,
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
