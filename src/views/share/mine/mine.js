window.LXM_PAGES.register({
  key: "shareMine", component: "LxmPageShareMine", group: "share", title: "我的分成", styleScope: "page-route-mine",
  setup(ctx) { Vue.onMounted(() => ctx.shareEnter("mine")); return {}; }
});
