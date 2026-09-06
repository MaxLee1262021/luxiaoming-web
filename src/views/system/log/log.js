window.LXM_PAGES.register({
  key: "logs",
  component: "LxmPageLog",
  group: "system",
  title: "操作日志",
  description: "后台审计日志查询与导出",
  styleScope: "page-route-log",
  setup(ctx) {
    const logActionOptions = Vue.computed(() => [
      ...new Set(ctx.state.logs.map((item) => item.action).filter(Boolean)),
    ]);
    return { logActionOptions };
  },
});
