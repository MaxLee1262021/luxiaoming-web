window.LXM_PAGES.register({
  key: "cities",
  component: "LxmPageCity",
  group: "content",
  title: "Cities",
  description: "Multi-city operation config for mini program",
  styleScope: "page-route-city",
  setup(ctx) {
    const { ref, computed, watch } = window.Vue;
    const cityKeyword = ref("");
    const cityStatusFilter = ref("");

    function cityKeys(row) {
      if (!row || typeof row !== "object") return new Set(row ? [String(row)] : []);
      return new Set([row.id, row._id, row.cityId, row.code, row.name, row.city]
        .filter((item) => item !== undefined && item !== null && String(item) !== "")
        .map(String));
    }
    function belongsToCity(record, city) {
      const target = cityKeys(city);
      return [...cityKeys(record)].some((key) => target.has(key));
    }
    function cityDependencySummary(city) {
      const spots = (ctx.data.spots || []).filter((spot) => spot && !spot.deleted && !spot.isDeleted && belongsToCity(spot, city)).length;
      const shops = (ctx.data.shops || []).filter((shop) => shop && !shop.deleted && !shop.isDeleted && belongsToCity(shop, city)).length;
      return { spots, shops };
    }
    const cityRows = computed(() => {
      const kw = (cityKeyword.value || "").toLowerCase();
      const sf = cityStatusFilter.value;
      const source = (ctx.visibleCities && ctx.visibleCities.value) || ctx.data.cities || [];
      return source.filter((c) => {
        if (c.deleted) return false;
        if (kw && ![c.name, c.code, c.cityId, c.description, c.desc].filter(Boolean).join(" ").toLowerCase().includes(kw)) return false;
        const active = isCityActive(c);
        if (sf === "运营中" && !active) return false;
        if (sf === "筹备中" && active) return false;
        return true;
      }).map((city) => ({ ...city, summary: cityDependencySummary(city) }));
    });
    const citySummary = computed(() => ({
      total: cityRows.value.length,
      active: cityRows.value.filter(isCityActive).length,
      spots: cityRows.value.reduce((sum, city) => sum + citySpotCount(city), 0),
      shops: cityRows.value.reduce((sum, city) => sum + cityShopCount(city), 0)
    }));

    function isCityActive(city = {}) {
      return city.enabled !== false && city.status !== "筹备中" && city.status !== "停用" && city.visible !== false;
    }
    function cityStatusType(city) {
      return isCityActive(city) ? "success" : "info";
    }
    function citySpotCount(city) {
      return Number(city && city.summary && city.summary.spots !== undefined ? city.summary.spots : cityDependencySummary(city).spots);
    }
    function cityShopCount(city) {
      return Number(city && city.summary && city.summary.shops !== undefined ? city.summary.shops : cityDependencySummary(city).shops);
    }
    function resetCityFilters() {
      cityKeyword.value = "";
      cityStatusFilter.value = "";
    }
    async function toggleCityVisible(city) {
      const source = (ctx.data.cities || []).find((item) => String(item.id || item._id) === String(city.id || city._id));
      if (!source) return;
      const previous = { ...source };
      const next = !isCityActive(source);
      source.status = next ? "运营中" : "筹备中";
      source.enabled = next;
      // 筹备中城市仍下发给小程序并显示“敬请期待”；删除才会完全隐藏。
      source.visible = true;
      const saved = typeof ctx.persistContentMutation === "function"
        ? await ctx.persistContentMutation("cities", source, previous)
        : true;
      if (!saved) {
        Object.assign(source, previous);
        return;
      }
      if (typeof ctx.log === "function") ctx.log(next ? "开通城市" : "调整城市为筹备中", "城市管理", source.name || source.id);
      if (ctx.ElMessage) ctx.ElMessage.success(next ? "城市已开通，小程序可按配置开放" : "城市已调整为筹备中");
    }
    function viewCitySpots(city) {
      ctx.state.filters.keyword = city.name || city.code || "";
      ctx.state.filters.contentStatus = "";
      ctx.state.filters.contentSpotId = "";
      ctx.switchMenu("spots");
    }

    const resetPager = () => { ctx.pager("cities").page = 1; };
    watch([cityKeyword, cityStatusFilter], resetPager);
    watch(() => cityRows.value.length, resetPager);
    return {
      cityRows,
      citySummary,
      cityKeyword,
      cityStatusFilter,
      isCityActive,
      cityStatusType,
      citySpotCount,
      cityShopCount,
      resetCityFilters,
      toggleCityVisible,
      viewCitySpots
    };
  }
});
