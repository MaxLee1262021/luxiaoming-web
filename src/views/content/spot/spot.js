// 打卡点管理页：所有模板字段都来自 ctx，无需本地状态。
window.LXM_PAGES.register({
  key: "spots",
  component: "LxmPageSpot",
  group: "content",
  title: "Spot",
  description: "Photo spot management",
  styleScope: "page-route-spot",
  setup(ctx) {
    return {};
  }
});
