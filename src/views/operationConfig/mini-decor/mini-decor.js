// 小程序装修预览页：所有数据/计算由 12-content-edit.js + 14-page-config.js 暴露的 ctx 字段提供；
// setup 只做字段透传 + 4 个模板用到的、ctx 上没有的本地辅助函数（避免 undefined.xxx 连锁崩溃）。
// 注意：装修编辑功能（添加 banner / 排序）的完整逻辑在 #812 拆分时遗漏，
// 本版本先用 stub 保不崩；真实编辑功能会在下一批"内容/装修体验优化"中补齐。
window.LXM_PAGES.register({
  key: "miniDecor",
  component: "LxmPageMiniDecor",
  group: "operationConfig",
  title: "小程序装修预览",
  description: "后台内部装修预览",
  styleScope: "page-route-mini-decor",
  setup(ctx) {
    // 把 ctx 上所有需要的字段都解构出来
    const {
      // 通用
      state, data, log, money, statusMeta, switchMenu, can,
      // 12-content-edit.js
      toggleHomeModule, toggleHomeSelection, saveHomeConfig, exportHomeConfigJson, uploadHomeMaterial,
      // 14-page-config.js
      publicMiniPreview, miniPreviewPages, miniPreviewCurrentPage, miniPreviewCurrentPackage,
      miniPreviewCurrentSeries, miniPreviewCurrentAlbum, miniPreviewCurrentOrder,
      miniPreviewSeriesAlbums, miniPreviewAlbumSamples,
      miniPreviewReset, miniPreviewGo, miniPreviewBack,
      pageConfigPages, selectPageConfig, togglePageModule, togglePageRelation,
      activePageConfig, activePageConfigMeta, activePageModuleOptions, activePageRelationGroups,
      // scopedOrders 等
      scopedOrders
    } = ctx;

    // 模板用到但 ctx 上没暴露的辅助函数 — 本地 stub（保不崩）
    function homeModuleOptions() {
      // 常用首页板块选项
      return [
        { key: "hero", label: "顶部主标题" },
        { key: "quickNav", label: "快捷入口" },
        { key: "notice", label: "活动公告" },
        { key: "carousel", label: "样片轮播" },
        { key: "packages", label: "旅拍套餐" },
        { key: "albums", label: "照片留影" },
        { key: "videoSingles", label: "视频摄像" },
        { key: "peripherals", label: "影像周边" },
        { key: "guides", label: "旅拍灵感" }
      ];
    }

    function quickNavPresets() {
      // 快捷入口预设
      return [
        { targetType: "albums", label: "照片留影" },
        { targetType: "videoSingles", label: "视频摄像" },
        { targetType: "packages", label: "旅拍套餐" },
        { targetType: "peripherals", label: "影像周边" },
        { targetType: "guides", label: "旅拍灵感" },
        { targetType: "spots", label: "打卡点" }
      ];
    }

    function firstHomeBanner() {
      const list = (state.homeConfig && state.homeConfig.homeBanners) || [];
      return list[0] || null;
    }

    function addHomeBanner() {
      const c = state.homeConfig || (state.homeConfig = {});
      c.homeBanners = c.homeBanners || [];
      c.homeBanners.push({
        _id: "b" + Date.now(),
        title: "新首页 Banner",
        image: "",
        targetType: "package",
        targetId: ""
      });
    }

    function addExploreBanner() {
      const c = state.homeConfig || (state.homeConfig = {});
      c.exploreBanners = c.exploreBanners || [];
      c.exploreBanners.push({
        _id: "eb" + Date.now(),
        title: "新探索页 Banner",
        image: "",
        targetType: "spot",
        targetId: ""
      });
    }

    function moveHomeBanner(i, delta) {
      const list = (state.homeConfig && state.homeConfig.homeBanners) || [];
      const j = i + delta;
      if (j < 0 || j >= list.length) return;
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }

    function moveExploreBanner(i, delta) {
      const list = (state.homeConfig && state.homeConfig.exploreBanners) || [];
      const j = i + delta;
      if (j < 0 || j >= list.length) return;
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }

    function addQuickNav(targetType) {
      const c = state.homeConfig || (state.homeConfig = {});
      c.quickNav = c.quickNav || [];
      c.quickNav.push({ targetType, label: targetType });
    }

    function moveQuickNav(i, delta) {
      const list = (state.homeConfig && state.homeConfig.quickNav) || [];
      const j = i + delta;
      if (j < 0 || j >= list.length) return;
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }

    return {
      // 通用
      state, data, log, money, statusMeta, switchMenu, can,
      // 12 / 14 模块暴露的
      toggleHomeModule, toggleHomeSelection, saveHomeConfig, exportHomeConfigJson, uploadHomeMaterial,
      publicMiniPreview, miniPreviewPages, miniPreviewCurrentPage, miniPreviewCurrentPackage,
      miniPreviewCurrentSeries, miniPreviewCurrentAlbum, miniPreviewCurrentOrder,
      miniPreviewSeriesAlbums, miniPreviewAlbumSamples,
      miniPreviewReset, miniPreviewGo, miniPreviewBack,
      pageConfigPages, selectPageConfig, togglePageModule, togglePageRelation,
      activePageConfig, activePageConfigMeta, activePageModuleOptions, activePageRelationGroups,
      scopedOrders,
      // 本地 stub
      homeModuleOptions, quickNavPresets, firstHomeBanner,
      addHomeBanner, addExploreBanner, moveHomeBanner, moveExploreBanner,
      addQuickNav, moveQuickNav
    };
  }
});
