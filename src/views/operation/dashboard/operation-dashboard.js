// 经营看板：KPI、扫描转化、风险提醒、排行 — 数据与计算全部由 05-dashboard.js 暴露的 ctx 字段提供，
// setup 只负责把这些字段透传给模板，并把模板用到的、ctx 上没有的辅助函数本地补齐。
window.LXM_PAGES.register({
  key: "dashboard",
  component: "LxmPageOperationDashboard",
  group: "operation",
  title: "Operation Dashboard",
  description: "KPI cards, scan conversion, reminders, rankings",
  styleScope: "page-route-operation-dashboard",
  setup(ctx) {
    const Vue = window.Vue;
    const { money, switchMenu, state, data } = ctx;

    // 模板用到的所有 ctx 字段一次性解构（不存在则保持 undefined，模板里有 v-if 兜底）
    const {
      dashboard, dashboardDelta, dashboardScopeLabel, dashboardProductSummary,
      dashboardProductCategoryRows, dashboardProductPieStyle,
      dashboardDailySalesRows, dashboardSpotRevenueRows, dashboardSlowProducts,
      dashboardRiskAlerts, dashboardTrendPoints,
      openDashboardProduct, openDashboardSpot,
      openRankPreview, openReminderPreview, openReconciliationDetail,
      selectDashboardShop, setDashboardDrill, clearDashboardScope,
      exportDashboardProductSales
    } = ctx;

    // 模板用到但 ctx 没暴露的 4 个函数 — 本地兜底实现（不阻塞渲染）
    function dashboardTrendArea(type = "revenue") {
      // 取折线点 + 闭合到 x 轴形成填充区域
      const points = (typeof dashboardTrendPoints === "function") ? dashboardTrendPoints(type) : "";
      if (!points) return "";
      const list = points.split(" ");
      if (list.length < 2) return points;
      const first = list[0].split(",")[0];
      const last = list[list.length - 1].split(",")[0];
      return `${points} ${last},230 ${first},230`;
    }

    function dashboardSetDateShortcut(kind) {
      // 时间快捷：近 7/30/90 天，更新 state.filters.dashboardDate
      if (!state.filters) state.filters = {};
      const map = { "7d": 7, "30d": 30, "90d": 90 };
      state.filters.dashboardDays = map[kind] || 30;
      if (typeof ctx.refreshDashboard === "function") ctx.refreshDashboard();
    }

    function switchDashboardTab(name) {
      if (!state.dashboardTab) state.dashboardTab = "overview";
      state.dashboardTab = name;
    }

    function handleDashboardRiskAlert(row) {
      if (!row) return;
      // 点击告警：跳到对应商品/点位详情
      if (row.kind === "product" || row.category) return openDashboardProduct && openDashboardProduct(row);
      if (row.spotId) return openDashboardSpot && openDashboardSpot({ id: row.spotId });
      if (row.reminder) return openReminderPreview && openReminderPreview(row);
    }

    return {
      // 数据
      dashboard, dashboardDelta, dashboardScopeLabel,
      dashboardProductSummary, dashboardProductCategoryRows, dashboardProductPieStyle,
      dashboardDailySalesRows, dashboardSpotRevenueRows, dashboardSlowProducts,
      dashboardRiskAlerts,
      // 函数
      dashboardTrendPoints, dashboardTrendArea,
      dashboardSetDateShortcut, switchDashboardTab, handleDashboardRiskAlert,
      openDashboardProduct, openDashboardSpot, openRankPreview, openReminderPreview,
      openReconciliationDetail, selectDashboardShop, setDashboardDrill, clearDashboardScope,
      exportDashboardProductSales,
      money, switchMenu, state, data
    };
  }
});
