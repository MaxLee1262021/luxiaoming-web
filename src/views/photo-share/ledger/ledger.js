window.LXM_PAGES.register({ key: "photoLedger", component: "LxmPagePhotoLedger", group: "photoShare", title: "分成明细", setup(ctx) { Vue.onMounted(() => ctx.photoEnter("ledger")); return {}; } });
