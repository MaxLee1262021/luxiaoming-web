window.LXM_PAGES.register({
  key: "miniDecor", component: "LxmPageMiniDecor", group: "operationConfig",
  title: "小程序轮播配置", description: "首页和探索页轮播素材及点击跳转", styleScope: "page-route-mini-decor",
  setup(ctx) {
    const { state, data, can, ElMessage, validateMediaUrl } = ctx;
    const { computed, ref, watch } = window.Vue;
    const activePage = ref("home"), previewIndex = ref(0), saving = ref(false);
    const pages = [{ key: "home", field: "homeBanners", label: "首页轮播" }, { key: "explore", field: "exploreBanners", label: "探索页轮播" }];
    const currentPage = computed(() => pages.find(page => page.key === activePage.value) || pages[0]);
    const idOf = row => String(row && (row.id || row._id) || "");
    const nameOf = row => row ? (row.name || row.title || "未命名") : "";
    const visible = row => {
      if (!row) return false;
      const enabled = typeof ctx.contentEffectiveVisible === "function" ? ctx.contentEffectiveVisible(row)
        : !row.deleted && !row.isDeleted && row.isShow !== false && !["草稿", "下架", "停用"].includes(row.status);
      const audit = String(row.auditStatus || row.reviewStatus || "").trim().toLowerCase();
      return enabled && (!audit || ["approved", "pass", "passed", "published", "online", "已上", "已上架", "审核通过", "通过"].includes(audit));
    };
    const isVideo = row => [row.type, row.mediaType, row.productType, row.serviceType, row.productKind].some(value => /video|视频/.test(String(value || "").toLowerCase()));
    const isVideoSingle = row => typeof ctx.isVideoSingleProduct === "function" ? ctx.isVideoSingleProduct(row)
      : isVideo(row) && (row.isVideoSingle === true || row.productKind === "video_single");
    // Import old sample selections into the editable list; explicit empty lists stay empty.
    function importLegacySamples() {
      const config = state.homeConfig;
      if (!config || config.bannerConfigVersion || (config.homeBanners || []).length || !(config.carouselIds || []).length) return;
      const samples = config.carouselIds.map(id => (data.samples || []).find(row => idOf(row) === String(id)))
        .filter(row => visible(row) && (row.url || row.cover)).slice(0, 6);
      if (!samples.length) return;
      config.homeBanners = samples.map(row => ({ _id: idOf(row), type: isVideo(row) ? "video" : "image",
        url: row.url || row.cover, cover: row.cover || row.poster || "", targetType: row.targetType || "none", targetId: row.targetId || "" }));
      config.carouselIds = [];
    }
    watch(() => [state.homeConfig, data.samples], importLegacySamples, { immediate: true });
    const banners = computed(() => state.homeConfig[currentPage.value.field] || []);
    const previewBanner = computed(() => banners.value[Math.min(previewIndex.value, banners.value.length - 1)] || null);
    watch(activePage, () => { previewIndex.value = 0; });
    const jumpPresets = [
      { value: "none", label: "不跳转" }, { value: "package", label: "旅拍套餐详情" },
      { value: "album", label: "照片留影详情" }, { value: "video", label: "视频摄像详情" },
      { value: "peripheral", label: "影像周边商品" }, { value: "guide", label: "旅拍灵感详情" },
      { value: "guides", label: "旅拍灵感列表" }, { value: "external", label: "外部链接页" },
      { value: "spot", label: "打卡点详情" }, { value: "package_list", label: "旅拍套餐搜索" },
      { value: "photo_list", label: "照片留影搜索" }, { value: "explore", label: "探索地图" },
      { value: "booking", label: "预约填写" }, { value: "my", label: "我的" }
    ];
    const bannerTargetNeedsId = banner => ["package", "album", "video", "spot", "peripheral", "guide"].includes(banner.targetType);
    function bannerTargetRows(banner) {
      const rows = ({ package: (data.packages || []).filter(row => visible(row) && !isVideo(row) && !isVideoSingle(row)),
        album: (data.albums || []).filter(visible), video: (data.packages || []).filter(row => visible(row) && isVideoSingle(row)),
        spot: (data.spots || []).filter(visible), peripheral: (data.peripherals || []).filter(visible), guide: (data.guides || []).filter(visible) })[banner.targetType] || [];
      if (banner.targetId && !rows.some(row => idOf(row) === String(banner.targetId))) return [{ id: banner.targetId, name: "当前目标不可用（请重新选择）", unavailable: true }, ...rows];
      return rows;
    }
    function changeBannerTarget(banner) {
      banner.targetId = ""; banner.linkUrl = "";
      for (const key of ["linkId", "jumpId", "linkType", "jumpType", "jumpUrl", "targetUrl", "path", "pagePath"]) delete banner[key];
    }
    function externalBannerUrl(value) {
      const url = String(value || "").trim();
      if (!/^https:\/\//i.test(url) || /[\s\\<>"'\u0000-\u001f\u007f]/.test(url)) return "";
      try {
        const parsed = new URL(url);
        const validHost = parsed.hostname.length <= 253 && parsed.hostname.split(".")
          .every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
        return validHost && !parsed.username && !parsed.password && parsed.port !== "0" ? parsed.href : "";
      } catch (_) { return ""; }
    }
    function jumpLabel(banner) {
      if (!banner) return "";
      const preset = jumpPresets.find(item => item.value === banner.targetType);
      if (!preset) return "不跳转";
      if (banner.targetType === "external") return preset.label + " · " + (banner.linkUrl || "请填写链接地址");
      const target = bannerTargetRows(banner).find(row => idOf(row) === String(banner.targetId));
      return preset.label + (bannerTargetNeedsId(banner) ? " · " + (target ? nameOf(target) : "请选择目标") : "");
    }
    function addBanner() {
      if (!can("contentEdit")) return;
      const list = state.homeConfig[currentPage.value.field] || (state.homeConfig[currentPage.value.field] = []);
      if (list.length >= 6) return ElMessage.warning("每个页面最多配置 6 张轮播");
      list.push({ _id: currentPage.value.key + "-" + Date.now() + "-" + list.length, type: "image", mediaType: "image", url: "", cover: "", targetType: "none", targetId: "", linkUrl: "" });
      previewIndex.value = list.length - 1;
    }
    function moveBanner(index, delta) {
      if (!can("contentEdit")) return;
      const list = banners.value, next = index + delta;
      if (index < 0 || index >= list.length || next < 0 || next >= list.length) return;
      [list[index], list[next]] = [list[next], list[index]]; previewIndex.value = next;
    }
    function removeBanner(index) {
      if (!can("contentEdit") || index < 0 || index >= banners.value.length) return;
      banners.value.splice(index, 1); previewIndex.value = Math.max(0, Math.min(previewIndex.value, banners.value.length - 1));
    }
    function uploadBannerMedia(index, mediaType) {
      const banner = banners.value[index];
      if (!banner || !can("contentEdit")) return;
      window.LXM_UPLOAD.pick({ purpose: "content", collection: "homeConfig", recordId: "homeStats",
        imagesOnly: mediaType !== "video", videoOnly: mediaType === "video",
        onUploaded(file) {
          if (mediaType === "cover") { banner.cover = file.url; return; }
          banner.type = mediaType; banner.mediaType = mediaType; banner.url = file.url;
          banner.cover = mediaType === "image" ? file.url : "";
        }
      });
    }
    async function saveBanners() {
      if (!can("contentEdit") || saving.value) return;
      for (const page of pages) for (const [index, banner] of (state.homeConfig[page.field] || []).entries()) {
        if (!String(banner.url || "").trim()) return ElMessage.warning(`${page.label}第 ${index + 1} 张请上传素材或删除空轮播`);
        if (banner.targetType === "external" && !externalBannerUrl(banner.linkUrl)) {
          return ElMessage.warning(`${page.label}第 ${index + 1} 张请填写有效的 HTTPS 外部链接`);
        }
        if (bannerTargetNeedsId(banner)) {
          const target = bannerTargetRows(banner).find(row => idOf(row) === String(banner.targetId));
          if (!target || target.unavailable) return ElMessage.warning(`${page.label}第 ${index + 1} 张请选择有效的跳转目标`);
        }
      }
      for (const page of pages) for (const banner of state.homeConfig[page.field] || []) {
        if (banner.targetType === "external") banner.linkUrl = externalBannerUrl(banner.linkUrl);
      }
      saving.value = true;
      try { return await ctx.saveHomeConfig(); } finally { saving.value = false; }
    }
    return { state, can, validateMediaUrl, activePage, pages, currentPage, banners, previewIndex, previewBanner, saving,
      idOf, nameOf, jumpPresets, bannerTargetNeedsId, bannerTargetRows, changeBannerTarget, jumpLabel,
      addBanner, moveBanner, removeBanner, uploadBannerMedia, saveBanners };
  }
});
