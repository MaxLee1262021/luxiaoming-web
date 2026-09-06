window.LXM_PAGES.register({
  key: "cities",
  component: "LxmPageCity",
  group: "content",
  title: "Cities",
  description: "Multi-city operation config for mini program",
  styleScope: "page-route-city",
  setup(ctx) {
    const { ref, computed, watch } = Vue;
    const cityKeyword = ref("");
    const cityStatusFilter = ref("");
    const cityRows = computed(() => {
      const kw = (cityKeyword.value || "").toLowerCase();
      const sf = cityStatusFilter.value;
      return (ctx.visibleCities.value || []).filter((c) => {
        if (c.deleted) return false;
        if (kw && !(c.name || "").toLowerCase().includes(kw)) return false;
        if (sf && c.status !== sf) return false;
        return true;
      });
    });
    watch(() => cityRows.value.length, () => { ctx.pager("cities").page = 1; });
    return { cityRows, cityKeyword, cityStatusFilter };
  }
});
