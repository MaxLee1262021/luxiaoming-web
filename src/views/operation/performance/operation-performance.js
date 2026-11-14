window.LXM_PAGES.register({
  key: "performance",
  component: "LxmPageOperationPerformance",
  group: "operation",
  title: "Performance",
  description: "Performance analysis extension page",
  styleScope: "page-route-operation-performance",
  setup(ctx) {
    const Vue = window.Vue;
    const performanceTrend = Vue.computed(() => {
      const now = new Date();
      const rows = Vue.unref(ctx.scopedOrders) || [];
      const series = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + index);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const count = rows.filter((order) => String(order.createdAt || order.createTime || "").slice(0, 10) === key).length;
        return { d: key, v: count };
      });
      const maximum = Math.max(...series.map((item) => item.v), 1);
      return series.map((item) => ({ ...item, percent: item.v / maximum * 100 }));
    });
    const performanceProducts = Vue.computed(() => {
      const active = (list) => (list || []).filter((row) => !row.deleted && !row.isDeleted && ctx.contentEffectiveVisible(row));
      const packages = active(ctx.data.packages);
      const products = [
        { name: "照片套餐", count: packages.filter((row) => !ctx.isVideoSingleProduct(row)).length },
        { name: "短视频", count: packages.filter((row) => ctx.isVideoSingleProduct(row)).length },
        { name: "照片单品", count: active(ctx.data.albums).length },
        { name: "影像周边", count: active(ctx.data.peripherals).length }
      ];
      const total = products.reduce((sum, item) => sum + item.count, 0);
      return products.map((item) => ({ ...item, percent: total ? item.count / total * 100 : 0 }));
    });
    return { performanceTrend, performanceProducts };
  }
});
