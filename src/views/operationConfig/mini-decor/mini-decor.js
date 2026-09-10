// 小程序装修预览页：所有数据/计算由 12-content-edit.js + 14-page-config.js 暴露的 ctx 字段提供；
// setup 只做字段透传和装修页的轻量交互辅助；持久化仍由 saveHomeConfig 统一完成。
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
      state, data, log, money, statusMeta, switchMenu, can, ElMessage,
      // 12-content-edit.js
      toggleHomeModule, toggleHomeSelection, saveHomeConfig, exportHomeConfigJson, uploadHomeMaterial,
      // 14-page-config.js
      publicMiniPreview, miniPreviewPages, miniPreviewCurrentPage, miniPreviewCurrentPackage,
      miniPreviewCurrentSeries, miniPreviewCurrentAlbum, miniPreviewCurrentOrder,
      miniPreviewSeriesAlbums, miniPreviewAlbumSamples,
      miniPreviewReset, miniPreviewGo, miniPreviewBack,
      pageConfigPages, selectPageConfig, togglePageModule, togglePageRelation,
      activePageConfig, activePageConfigMeta, activePageModuleOptions, activePageRelationGroups,
      homeModuleOptions: configuredHomeModuleOptions,
      // scopedOrders 等
      scopedOrders
    } = ctx;

    // Reuse the canonical module keys from 14-page-config.js.  The old local
    // labels (packages/albums/...) were not understood by buildMiniProgramHomeConfig.
    const homeModuleOptions = Array.isArray(configuredHomeModuleOptions)
      ? configuredHomeModuleOptions
      : [
        { key: "mainPush", label: "主推套餐", desc: "展示跨全部打卡点的主推套餐" },
        { key: "spots", label: "热门打卡", desc: "展示城市核心拍摄地点" },
        { key: "albums", label: "照片单品", desc: "展示可预约的照片单品商品" },
        { key: "videoProducts", label: "城市短视频", desc: "展示短视频商品" },
        { key: "peripherals", label: "摄影周边", desc: "展示旅拍周边商品" },
        { key: "guides", label: "攻略故事", desc: "展示攻略和城市故事内容" }
      ];

    const quickNavPresets = [
      { targetType: "all_spots", label: "打卡点" },
      { targetType: "package_list", label: "旅拍套餐" },
      { targetType: "videos", label: "视频摄像" },
      { targetType: "peripherals", label: "影像周边" },
      { targetType: "guides", label: "旅拍灵感" },
      { targetType: "my", label: "我的订单" }
    ];

    const homeBannerJumpPresets = [
      { value: "none", label: "不跳转" },
      { value: "package", label: "套餐详情" },
      { value: "album", label: "照片单品" },
      { value: "video", label: "短视频" },
      { value: "spot", label: "打卡点" },
      { value: "peripheral", label: "摄影周边" },
      { value: "guide", label: "攻略" },
      { value: "link", label: "外部链接" }
    ];
    const exploreBannerJumpPresets = homeBannerJumpPresets;

    function notify(type, message) {
      try {
        if (ElMessage && typeof ElMessage[type] === "function") ElMessage[type](message);
        else if (ElMessage) ElMessage(message);
      } catch (_) {}
    }

    function pageConfigValue() {
      if (activePageConfig && (activePageConfig.__v_isRef || Object.prototype.hasOwnProperty.call(activePageConfig, "value"))) return activePageConfig.value || {};
      return activePageConfig || {};
    }

    function quickNavPreviewPage(item) {
      const key = String(item && (item.targetType || item.type || "") || "").trim().toLowerCase();
      return ({
        all_spots: "spotList", spots: "spotList", spot: "spotList", spot_list: "spotList",
        package_list: "packageList", packages: "packageList", package: "packageDetail",
        albums: "albumDetail", album: "albumDetail", videos: "videoList", videosingles: "videoList",
        video: "videoDetail", peripherals: "peripherals", guides: "guides", my: "my"
      })[key] || "home";
    }

    function updateQuickNavLabel(index, value) {
      const list = state.homeConfig && Array.isArray(state.homeConfig.quickNav) ? state.homeConfig.quickNav : [];
      if (!list[index]) return;
      list[index].label = String(value == null ? "" : value);
    }

    function removeQuickNav(index) {
      const list = state.homeConfig && Array.isArray(state.homeConfig.quickNav) ? state.homeConfig.quickNav : [];
      if (index >= 0 && index < list.length) list.splice(index, 1);
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
        type: "image",
        mediaType: "image",
        url: "",
        cover: "",
        targetType: "none",
        targetId: "",
        linkUrl: ""
      });
    }

    function addExploreBanner() {
      const c = state.homeConfig || (state.homeConfig = {});
      c.exploreBanners = c.exploreBanners || [];
      c.exploreBanners.push({
        _id: "eb" + Date.now(),
        title: "新探索页 Banner",
        type: "image",
        mediaType: "image",
        url: "",
        cover: "",
        targetType: "none",
        targetId: "",
        linkUrl: ""
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

    function removeHomeBanner(index) {
      const list = (state.homeConfig && state.homeConfig.homeBanners) || [];
      if (index >= 0 && index < list.length) list.splice(index, 1);
    }

    function removeExploreBanner(index) {
      const list = (state.homeConfig && state.homeConfig.exploreBanners) || [];
      if (index >= 0 && index < list.length) list.splice(index, 1);
    }

    function pickBannerMedia(collection, index, mediaType) {
      const list = (state.homeConfig && state.homeConfig[collection]) || [];
      const banner = list[index];
      if (!banner || typeof document === "undefined") return;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = mediaType === "video" ? "video/*" : "image/*";
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        // Main-table media columns are TEXT; reject data URLs that cannot fit
        // instead of persisting a value that MySQL will truncate or reject.
        if (typeof FileReader === "undefined") {
          notify("warning", "当前浏览器不支持本地素材读取，请填写 URL");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result || "");
          if (url.length > 60000) {
            notify("warning", "素材编码后过大，请填写可访问的对象存储 URL");
            return;
          }
          banner.type = mediaType;
          banner.mediaType = mediaType;
          banner.url = url;
          if (mediaType === "image") banner.cover = url;
        };
        reader.onerror = () => notify("error", "素材读取失败，请改用 URL");
        reader.readAsDataURL(file);
      };
      input.click();
    }

    function uploadHomeBannerMedia(index, mediaType) {
      pickBannerMedia("homeBanners", index, mediaType);
    }

    function uploadExploreBannerMedia(index, mediaType) {
      pickBannerMedia("exploreBanners", index, mediaType);
    }

    function addSpotCategory() {
      const config = pageConfigValue();
      if (!Array.isArray(config.categories)) config.categories = [];
      config.categories.push({ name: "新筛选标签", value: "" });
    }

    function removeSpotCategory(index) {
      const config = pageConfigValue();
      if (index > 0 && Array.isArray(config.categories)) config.categories.splice(index, 1);
    }

    function addSpotSort() {
      const config = pageConfigValue();
      if (!Array.isArray(config.sortOptions)) config.sortOptions = [];
      config.sortOptions.push({ name: "新排序", value: "name" });
    }

    function removeSpotSort(index) {
      const config = pageConfigValue();
      if (index >= 0 && Array.isArray(config.sortOptions)) config.sortOptions.splice(index, 1);
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
      homeModuleOptions, quickNavPresets, homeBannerJumpPresets, exploreBannerJumpPresets,
      firstHomeBanner, quickNavPreviewPage, updateQuickNavLabel, removeQuickNav,
      addHomeBanner, addExploreBanner, moveHomeBanner, moveExploreBanner,
      removeHomeBanner, removeExploreBanner, uploadHomeBannerMedia, uploadExploreBannerMedia,
      addQuickNav, moveQuickNav, addSpotCategory, removeSpotCategory, addSpotSort, removeSpotSort
    };
  }
});
