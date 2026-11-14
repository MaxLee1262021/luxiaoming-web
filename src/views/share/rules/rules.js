window.LXM_PAGES.register({
  key: "shareRules", component: "LxmPageShareRules", group: "share", title: "配置列表", styleScope: "page-route-rules",
  setup(ctx) { Vue.onMounted(() => ctx.shareEnter("rules")); return {}; }
});
