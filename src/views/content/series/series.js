window.LXM_PAGES.register({
  key: "series",
  component: "LxmPageSeries",
  group: "content",
  title: "Series",
  description: "Photo style series management",
  styleScope: "page-route-series",
  setup(ctx) {
    const { ref, computed, watch } = window.Vue;
    const seriesTypeFilter = ref("");

    function idOf(row) {
      return String((row && (row.id || row._id)) || "");
    }
    function spotIdsOf(row) {
      return [...new Set([
        ...(Array.isArray(row && row.spotIds) ? row.spotIds : []),
        row && row.spotId
      ].filter(Boolean).map(String))];
    }
    function seriesStyles(row) {
      return [...new Set([
        ...(Array.isArray(row && row.styles) ? row.styles : []),
        ...(Array.isArray(row && row.tags) ? row.tags : []),
        row && row.style
      ].map((item) => String(item || "").trim()).filter(Boolean))];
    }
    function seriesSpotNames(row) {
      return spotIdsOf(row)
        .map((id) => (ctx.data.spots || []).find((spot) => idOf(spot) === id))
        .filter(Boolean)
        .map((spot) => spot.name || "")
        .filter(Boolean);
    }
    function isSeriesVisible(row = {}) {
      return row.isShow !== false && !["停用", "下架", "草稿"].includes(String(row.status || ""));
    }
    function seriesStatusText(row) {
      return isSeriesVisible(row) ? "启用" : "停用";
    }
    function productTypeText(row) {
      return row.productType === "video" ? "短视频类" : "拍照类";
    }
    function seriesDependencySummary(row) {
      const seriesId = idOf(row);
      const albums = (ctx.data.albums || []).filter((album) => !album.deleted && !album.isDeleted && String(album.seriesId || "") === seriesId).length;
      const explicitPackageIds = new Set(Array.isArray(row.packageIds) ? row.packageIds.map(String) : []);
      const relationPackages = typeof ctx.packagesBySeries === "function" ? ctx.packagesBySeries(seriesId) : [];
      const packages = [...new Map([
        ...relationPackages,
        ...(ctx.data.packages || []).filter((item) => explicitPackageIds.has(idOf(item)))
      ].filter((item) => item && !item.deleted && !item.isDeleted).map((item) => [idOf(item), item])).values()];
      const videos = packages.filter((item) => item.type === "video").length;
      return { albums, packages: packages.length - videos, videos };
    }
    const seriesTableRows = computed(() => {
      const keyword = String(ctx.state.filters.keyword || "").trim().toLowerCase();
      const spotId = String(ctx.state.filters.contentSpotId || "");
      const status = String(ctx.state.filters.contentStatus || "");
      const type = seriesTypeFilter.value;
      return (ctx.data.series || []).filter((row) => {
        if (!row || row.deleted || row.isDeleted) return false;
        if (keyword && ![row.name, row.intro, row.style, seriesStyles(row).join(" ")].filter(Boolean).join(" ").toLowerCase().includes(keyword)) return false;
        if (spotId && !spotIdsOf(row).includes(spotId)) return false;
        if (status && seriesStatusText(row) !== status) return false;
        if (type && String(row.productType || "photo") !== type) return false;
        return true;
      }).map((row) => ({ ...row, summary: seriesDependencySummary(row) }));
    });
    const seriesSummary = computed(() => ({
      total: seriesTableRows.value.length,
      active: seriesTableRows.value.filter(isSeriesVisible).length,
      photo: seriesTableRows.value.filter((row) => row.productType !== "video").length,
      video: seriesTableRows.value.filter((row) => row.productType === "video").length,
      albums: seriesTableRows.value.reduce((sum, row) => sum + Number((row.summary || {}).albums || 0), 0)
    }));

    function resetSeriesFilters() {
      seriesTypeFilter.value = "";
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentSpotId = "";
      ctx.state.filters.contentSeriesId = "";
      ctx.state.filters.contentStatus = "";
    }
    function goToAlbums(row) {
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentSpotId = "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSeriesId = idOf(row);
      ctx.switchMenu("albums");
    }
    function goToShelf(row) {
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentSpotId = "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSeriesId = idOf(row);
      ctx.switchMenu("shelfProducts");
    }
    async function toggleSeriesVisible(row) {
      const source = (ctx.data.series || []).find((item) => idOf(item) === idOf(row));
      if (!source) return;
      const previous = { ...source, spotIds: Array.isArray(source.spotIds) ? source.spotIds.slice() : [] };
      const next = !isSeriesVisible(source);
      source.status = next ? "启用" : "停用";
      source.isShow = next;
      const saved = typeof ctx.persistContentMutation === "function"
        ? await ctx.persistContentMutation("series", source, previous)
        : true;
      if (!saved) {
        Object.assign(source, previous);
        return;
      }
      if (typeof ctx.log === "function") ctx.log(next ? "启用拍摄风格" : "停用拍摄风格", "拍摄风格", source.name || source.id);
      if (ctx.ElMessage) ctx.ElMessage.success(next ? "拍摄风格已启用" : "拍摄风格已停用");
    }

    const resetPager = () => { ctx.pager("series").page = 1; };
    watch([
      seriesTypeFilter,
      () => ctx.state.filters.keyword,
      () => ctx.state.filters.contentSpotId,
      () => ctx.state.filters.contentStatus
    ], resetPager);
    watch(() => seriesTableRows.value.length, resetPager);

    return {
      seriesTypeFilter,
      seriesTableRows,
      seriesSummary,
      seriesStyles,
      seriesSpotNames,
      isSeriesVisible,
      seriesStatusText,
      productTypeText,
      resetSeriesFilters,
      goToAlbums,
      goToShelf,
      toggleSeriesVisible
    };
  }
});
