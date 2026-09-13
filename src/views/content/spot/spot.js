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
    const spotTableRows = computed(() => {
      const rows = (ctx.spotRows && ctx.spotRows.value) || [];
      return rows.filter((spot) => isInCity(spot, spotCityFilter.value));
    });
    const spotSummary = computed(() => ({
      total: spotTableRows.value.length,
      visible: spotTableRows.value.filter(isSpotVisible).length,
      series: spotTableRows.value.reduce((sum, spot) => sum + Number((spot.summary || {}).series || 0), 0),
      products: spotTableRows.value.reduce((sum, spot) => sum + Number((spot.summary || {}).products || 0), 0)
    }));

    function spotCityName(spot) {
      const name = typeof ctx.cityName === "function" ? ctx.cityName(spot.cityId || spot.city) : "";
      return name && name !== "-" ? name : (spot.city || "未归属");
    }
    function spotLocationText(spot = {}) {
      const latitude = Number(spot.latitude);
      const longitude = Number(spot.longitude);
      const coordinate = Number.isFinite(latitude) && Number.isFinite(longitude)
        ? latitude.toFixed(6) + ", " + longitude.toFixed(6)
        : "坐标待配置";
      return (spot.district || "未设区域") + " · " + coordinate;
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
    function goToSeries(spot) {
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSeriesId = "";
      ctx.state.filters.contentSpotId = idOf(spot);
      ctx.switchMenu("series");
    }
    function goToAlbums(spot) {
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSeriesId = "";
      ctx.state.filters.contentSpotId = idOf(spot);
      ctx.switchMenu("albums");
    }
    function goToShelf(spot) {
      ctx.state.filters.keyword = "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSeriesId = "";
      ctx.state.filters.contentSpotId = idOf(spot);
      ctx.switchMenu("shelfProducts");
    }

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
      spotLocationText,
      spotTags,
      isSpotVisible,
      spotStatusText,
      resetSpotFilters,
      goToSeries,
      goToAlbums,
      goToShelf
    };
  }
});
