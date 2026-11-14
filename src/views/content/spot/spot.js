window.LXM_PAGES.register({
  key: "spots",
  component: "LxmPageSpot",
  group: "content",
  title: "Spot",
  description: "Photo spot management",
  styleScope: "page-route-spot",
  setup(ctx) {
    const { ref, computed, watch } = window.Vue;
    const spotCityFilter = ref("");
    const spotSortSavingIds = ref([]);

    function idOf(row) {
      return String((row && (row.id || row._id)) || "");
    }
    function cityKeys(row) {
      if (!row || typeof row !== "object") return new Set(row ? [String(row)] : []);
      return new Set([row.id, row._id, row.cityId, row.code, row.name, row.city]
        .filter((item) => item !== undefined && item !== null && String(item) !== "")
        .map(String));
    }
    function isInCity(spot, cityId) {
      if (!cityId) return true;
      const city = (ctx.data.cities || []).find((item) => idOf(item) === String(cityId));
      const target = cityKeys(city || cityId);
      return [...cityKeys(spot)].some((key) => target.has(key));
    }

    const spotCityOptions = computed(() => (ctx.data.cities || []).filter((city) => city && !city.deleted && !city.isDeleted));
    const emptyAssets = { albums: 0, videos: 0, packages: 0, guides: 0 };
    const assetCountsBySpot = computed(() => {
      const counts = new Map();
      const packages = (ctx.data.packages || []).filter((row) => row && !row.deleted && !row.isDeleted);
      const isVideo = (row) => typeof ctx.isVideoSingleProduct === "function"
        ? ctx.isVideoSingleProduct(row)
        : row.isVideoSingle === true || row.productKind === "video_single";
      const pools = {
        albums: ctx.data.albums || [],
        videos: packages.filter(isVideo),
        packages: packages.filter((row) => row.type !== "video"),
        guides: ctx.data.guides || []
      };
      for (const [key, rows] of Object.entries(pools)) {
        for (const row of rows) {
          if (!row || row.deleted || row.isDeleted) continue;
          const ids = typeof ctx.contentSpotIds === "function" ? ctx.contentSpotIds(row)
            : [row.spotId, ...(Array.isArray(row.spotIds) ? row.spotIds : [])];
          for (const spotId of new Set(ids.filter(Boolean).map(String))) {
            if (!counts.has(spotId)) counts.set(spotId, { ...emptyAssets });
            counts.get(spotId)[key] += 1;
          }
        }
      }
      return counts;
    });
    function spotAssets(spot) { return assetCountsBySpot.value.get(idOf(spot)) || emptyAssets; }
    const spotTableRows = computed(() => {
      const rows = (ctx.spotRows && ctx.spotRows.value) || [];
      return rows.filter((spot) => spot && !spot.deleted && !spot.isDeleted && isInCity(spot, spotCityFilter.value)).slice().sort(window.LXM_SPOT_ORDER.compare);
    });
    const spotSummary = computed(() => ({
      total: spotTableRows.value.length,
      visible: spotTableRows.value.filter(isSpotVisible).length,
      guides: spotTableRows.value.reduce((sum, spot) => sum + spotAssets(spot).guides, 0),
      products: spotTableRows.value.reduce((sum, spot) => {
        const assets = spotAssets(spot);
        return sum + assets.albums + assets.videos + assets.packages;
      }, 0)
    }));
    function spotRankText(spot) {
      const rank = window.LXM_SPOT_ORDER.rank(spot.sort);
      return rank ? String(rank) : "—";
    }

    function isSpotSortSaving(spot) {
      return spotSortSavingIds.value.length > 0 || ctx.isSpotOrderSaving();
    }
    function spotSource(spot) {
      const id = idOf(spot);
      return id && (ctx.data.spots || []).find((row) => idOf(row) === id);
    }
    function nextSpotSort(spot, direction) {
      const rows = window.LXM_SPOT_ORDER.ordered(ctx.data.spots);
      const index = rows.findIndex(row => idOf(row) === idOf(spot));
      if (index < 0) return 1;
      return Math.max(1, Math.min(rows.length, index + 1 + direction));
    }
    function spotSortDisabled(spot, direction) {
      const source = spotSource(spot);
      return !ctx.can("contentEdit") || ![-1, 1].includes(direction) || !source || source.deleted || source.isDeleted
        || isSpotSortSaving(source) || (window.LXM_SPOT_ORDER.rank(source.sort) > 0
          && window.LXM_SPOT_ORDER.ordered(ctx.data.spots).findIndex(row => idOf(row) === idOf(source)) + 1 === nextSpotSort(source, direction));
    }
    async function changeSpotSort(spot, direction) {
      if (!ctx.can("contentEdit") || ![-1, 1].includes(direction)) return false;
      const id = idOf(spot);
      // Table rows include derived fields; persist only the canonical record.
      const source = spotSource(spot);
      if (spotSortDisabled(spot, direction)) return false;
      const previous = source.sort;
      const next = nextSpotSort(source, direction);
      spotSortSavingIds.value = [...spotSortSavingIds.value, id];
      try {
        if (!(await ctx.persistSpotSort(source, next))) return false;
      } catch (error) {
        if (ctx.ElMessage) ctx.ElMessage.error((error && error.message) || "排序保存失败，请稍后重试");
        return false;
      } finally {
        spotSortSavingIds.value = spotSortSavingIds.value.filter((item) => item !== id);
      }
      if (typeof ctx.log === "function") ctx.log("调整打卡点排序", "打卡点设置", `${source.name || id} · ${previous ?? "未设置"} → ${source.sort}`);
      if (ctx.ElMessage) ctx.ElMessage.success(`已插入第 ${source.sort} 位，其他打卡点已同步重排`);
      return true;
    }

    function spotCityName(spot) {
      const name = typeof ctx.cityName === "function" ? ctx.cityName(spot.cityId || spot.city) : "";
      return name && name !== "-" ? name : (spot.city || "未归属");
    }
    function spotTags(spot) {
      return [...new Set([
        ...(Array.isArray(spot.tags) ? spot.tags : []),
        ...(Array.isArray(spot.styles) ? spot.styles : []),
        spot.tag
      ].map((item) => String(item || "").trim()).filter(Boolean))];
    }
    function isSpotVisible(spot = {}) {
      return spot.isShow !== false && !["停用", "下架", "草稿"].includes(String(spot.status || ""));
    }
    function spotStatusText(spot) {
      if (isSpotVisible(spot)) return "展示中";
      return spot.status === "草稿" ? "草稿" : "已隐藏";
    }

    function resetSpotFilters() {
      spotCityFilter.value = "";
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSpotId = "";
    }
    function goToAssets(spot, key) {
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSeriesId = "";
      ctx.state.filters.shelfType = "";
      ctx.state.filters.contentSpotId = idOf(spot);
      ctx.state.contentScope = { type: "", id: "" };
      return ctx.switchMenu(key, { preserveFilters: true });
    }
    const goToAlbums = (spot) => goToAssets(spot, "albums");
    const goToVideos = (spot) => goToAssets(spot, "videoSingles");
    const goToPackages = (spot) => goToAssets(spot, "packages");
    const goToGuides = (spot) => goToAssets(spot, "guides");

    const resetPager = () => { ctx.pager("spots").page = 1; };
    watch([
      spotCityFilter,
      () => ctx.state.filters.keyword,
      () => ctx.state.filters.contentStatus,
      () => ctx.state.filters.contentSpotId
    ], resetPager);
    watch(() => spotTableRows.value.length, resetPager);

    return {
      spotCityFilter,
      spotCityOptions,
      spotTableRows,
      spotSummary,
      spotCityName,
      spotRankText,
      isSpotSortSaving,
      spotSortDisabled,
      changeSpotSort,
      spotAssets,
      spotTags,
      isSpotVisible,
      spotStatusText,
      resetSpotFilters,
      goToAlbums,
      goToVideos,
      goToPackages,
      goToGuides
    };
  }
});
