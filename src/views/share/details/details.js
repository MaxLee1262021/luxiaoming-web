window.LXM_PAGES.register({
  key: "shareDetails", component: "LxmPageShareDetails", group: "share", title: "分成明细", styleScope: "page-route-details",
  setup(ctx) { Vue.onMounted(() => ctx.shareEnter("details")); return {}; }
});
