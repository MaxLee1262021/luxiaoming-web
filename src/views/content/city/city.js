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
    function isCityEnabled(city = {}) {
      const status = String(city.status || "").trim().toLowerCase();
      const enabled = city.enabled !== undefined && city.enabled !== null && String(city.enabled).trim() !== ""
        ? city.enabled
        : city.isEnabled;
      if (city.visible === false || city.visible === 0 || String(city.visible || "").trim().toLowerCase() === "false") return false;
      if (enabled !== undefined && enabled !== null && String(enabled).trim() !== ""
        && [false, 0, "0", "false", "no", "off"].includes(typeof enabled === "string" ? enabled.trim().toLowerCase() : enabled)) return false;
      if (["禁用", "停用", "筹备中", "未开通", "未启用", "关闭", "已停用", "disabled", "offline", "closed", "inactive", "unavailable"].includes(status)) return false;
      return true;
    }
    // Keep the old helper available for pages/tests that consumed the initial
    // city page API while making the new business meaning explicit.
    const isCityActive = isCityEnabled;
    const cityRows = computed(() => {
      const kw = (cityKeyword.value || "").toLowerCase();
      const sf = cityStatusFilter.value;
      const source = (ctx.visibleCities && ctx.visibleCities.value) || ctx.data.cities || [];
      return source.filter((c) => {
        if (c.deleted) return false;
        if (kw && ![c.name, c.code, c.cityId, c.description, c.desc].filter(Boolean).join(" ").toLowerCase().includes(kw)) return false;
        const active = isCityActive(c);
        if (["启用", "运营中"].includes(sf) && !active) return false;
        if (["禁用", "停用", "筹备中"].includes(sf) && active) return false;
        return true;
      }).map((city) => ({ ...city, summary: cityDependencySummary(city) }));
    });
    const citySummary = computed(() => ({
      total: cityRows.value.length,
      active: cityRows.value.filter(isCityActive).length,
      spots: cityRows.value.reduce((sum, city) => sum + citySpotCount(city), 0),
      shops: cityRows.value.reduce((sum, city) => sum + cityShopCount(city), 0)
    }));

    function cityStatusType(city) {
      return isCityEnabled(city) ? "success" : "info";
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
    async function toggleCityEnabled(city) {
      const source = (ctx.data.cities || []).find((item) => String(item.id || item._id) === String(city.id || city._id));
      if (!source) return;
      const previous = { ...source };
      const next = !isCityEnabled(source);
      source.status = next ? "启用" : "停用";
      source.enabled = next;
      // visible is kept in sync for older public RPCs that only understand
      // the visibility field. A disabled city must disappear from the mini
      // program city picker and from all city-scoped content.
      source.visible = next;
      const saved = typeof ctx.persistContentMutation === "function"
        ? await ctx.persistContentMutation("cities", source, previous)
        : true;
      if (!saved) {
        Object.assign(source, previous);
        return;
      }
      if (typeof ctx.log === "function") ctx.log(next ? "启用城市" : "禁用城市", "城市管理", source.name || source.id);
      if (ctx.ElMessage) ctx.ElMessage.success(next ? "城市已启用，小程序将展示该城市内容" : "城市已禁用，小程序将隐藏该城市内容");
    }
    const toggleCityVisible = toggleCityEnabled;
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
      isCityEnabled,
      cityStatusType,
      citySpotCount,
      cityShopCount,
      resetCityFilters,
      toggleCityVisible,
      toggleCityEnabled,
      viewCitySpots
    };
  }
});
