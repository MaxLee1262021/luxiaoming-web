window.LXM_PAGES.register({
  key: "trace",
  component: "LxmPageOperationTrace",
  group: "operation",
  title: "Trace",
  description: "Operation trace extension page",
  styleScope: "page-route-operation-trace",
  setup(ctx) {
    const Vue = window.Vue;
    const rows = (key) => Vue.unref(ctx[key]) || [];
    const traceFunnel = Vue.computed(() => {
      const orders = rows("scopedOrders");
      return [
        { k: "scan", t: "扫码访问", count: rows("scopedScans").length },
        { k: "browse", t: "浏览详情", count: null },
        { k: "book", t: "提交预约", count: orders.length },
        { k: "pay", t: "支付定金", count: orders.filter((order) => ctx.paymentConfirmed(order, "deposit")).length },
        { k: "done", t: "拍摄完成", count: orders.filter((order) => ctx.orderBusinessStatus(order) === "completed").length }
      ];
    });
    return { traceFunnel };
  }
});
