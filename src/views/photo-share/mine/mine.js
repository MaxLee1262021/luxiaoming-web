window.LXM_PAGES.register({ key: "photoMine", component: "LxmPagePhotoMine", group: "photoShare", title: "摄影端", setup(ctx) { Vue.onMounted(() => ctx.photoEnter("mine")); return {}; } });
