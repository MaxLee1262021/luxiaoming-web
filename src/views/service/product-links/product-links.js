window.LXM_PAGES.register({
  key: "productLinks", component: "LxmPageProductLinks", group: "service",
  title: "商品小程序外链", description: "查看服务与商品，生成直达小程序详情页的链接", styleScope: "page-route-product-links",
  setup(ctx) {
    const { ref, reactive, computed, watch, onMounted, onUnmounted } = window.Vue;
    const items = ref([]), loading = ref(true), loadError = ref(""), configured = ref(false), environment = ref("release");
    const filters = reactive({ keyword: "", type: "", status: "", page: 1, size: 20 });
    const expireDays = ref(30), busyKey = ref(""), copying = ref(false), dialogOpen = ref(false), generated = ref(null);
    const types = [{ value: "album", label: "照片留影" }, { value: "video", label: "视频摄像" }, { value: "package", label: "旅拍套餐" }, { value: "peripheral", label: "周边商品" }];
    let alive = true, loadSequence = 0;
    const rowKey = row => JSON.stringify([row.type, row.id]);
    const envLabel = value => ({ release: "正式版", trial: "体验版", develop: "开发版" })[value] || value || "正式版";
    const typeCounts = computed(() => types.map(type => ({ ...type, count: items.value.filter(row => row.type === type.value).length })));
    const statuses = computed(() => [...new Map(items.value.map(row => [row.status, { value: row.status, label: row.statusLabel || row.status }])).values()].filter(row => row.value));
    const filtered = computed(() => {
      const keyword = filters.keyword.trim().toLowerCase();
      return items.value.filter(row => (!filters.type || row.type === filters.type) && (!filters.status || row.status === filters.status)
        && (!keyword || [row.name, row.id].some(value => String(value || "").toLowerCase().includes(keyword))));
    });
    const rows = computed(() => filtered.value.slice((filters.page - 1) * filters.size, filters.page * filters.size));
    const money = value => value == null || value === "" || !Number.isFinite(Number(value)) ? "—" : "¥" + Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const time = value => {
      const date = new Date(value);
      return !value || !Number.isFinite(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    };
    function cover(row) {
      const value = String(row.cover || "").trim();
      return /^(https?:\/\/|\/(?!\/))/.test(value) ? value : "";
    }
    async function api(action, method = "GET", body) {
      const response = await window.LXM_HTTP.request("/api/product-links/" + action, {
        method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})
      });
      let payload;
      try { payload = await response.json(); } catch (_) { throw new Error("服务返回异常，请稍后重试"); }
      if (!response.ok || payload?.error || payload?.code != null && payload.code !== 0) throw new Error(payload?.msg || payload?.error || "服务暂不可用，请稍后重试");
      return payload?.code === 0 && payload.data ? payload.data : payload;
    }
    async function load() {
      const sequence = ++loadSequence;
      loading.value = true; loadError.value = ""; generated.value = null; dialogOpen.value = false;
      try {
        const result = await api("catalog");
        if (!alive || sequence !== loadSequence) return;
        if (!Array.isArray(result?.items)) throw new Error("商品列表返回异常，请重新加载");
        items.value = result.items; configured.value = result.configured === true; environment.value = result.environment || "release";
        filters.page = 1;
      } catch (error) {
        if (alive && sequence === loadSequence) { items.value = []; configured.value = false; loadError.value = error.message || "商品加载失败，请稍后重试"; }
      } finally { if (alive && sequence === loadSequence) loading.value = false; }
    }
    function unavailable(row) {
      if (loading.value || loadError.value) return "请先成功加载商品列表";
      if (!configured.value) return "请联系管理员配置微信小程序凭据";
      return row.canGenerate === true ? "" : row.disabledReason || "当前商品暂不可生成外链";
    }
    async function generate(row) {
      if (busyKey.value) return;
      const reason = unavailable(row);
      if (reason) return ctx.ElMessage.warning(reason);
      const key = rowKey(row), days = expireDays.value;
      busyKey.value = key; generated.value = null; dialogOpen.value = false;
      try {
        const result = await api("generate", "POST", { type: row.type, id: row.id, expireDays: days });
        if (!alive) return;
        if (!/^https:\/\//i.test(result?.url || "")) throw new Error("微信未返回有效的外链，请重试");
        generated.value = { ...result, name: row.name, typeLabel: row.typeLabel, expireDays: days };
        dialogOpen.value = true;
      } catch (error) { if (alive) ctx.ElMessage.error("生成失败：" + (error.message || "请稍后重试")); }
      finally { if (alive) busyKey.value = ""; }
    }
    function fallbackCopy(text) {
      const active = document.activeElement;
      const input = document.createElement("textarea");
      input.value = text; input.readOnly = true; input.setAttribute("aria-hidden", "true");
      input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(input);
      try { input.select(); input.setSelectionRange(0, text.length); return document.execCommand("copy"); }
      finally { input.remove(); if (active && typeof active.focus === "function") active.focus(); }
    }
    async function copy() {
      if (!generated.value?.url || copying.value) return;
      copying.value = true;
      try {
        let copied = false;
        if (window.navigator?.clipboard?.writeText) {
          try { await window.navigator.clipboard.writeText(generated.value.url); copied = true; } catch (_) {}
        }
        if (!copied) copied = fallbackCopy(generated.value.url);
        if (!copied) throw new Error("请选中链接后手动复制");
        ctx.ElMessage.success("链接已复制");
      } catch (_) { ctx.ElMessage.warning("自动复制失败，请选中链接后手动复制"); }
      finally { copying.value = false; }
    }
    function reset() { filters.keyword = ""; filters.type = ""; filters.status = ""; filters.page = 1; }
    watch(() => [filters.keyword, filters.type, filters.status, filters.size], () => { filters.page = 1; });
    onMounted(load);
    onUnmounted(() => { alive = false; loadSequence += 1; });
    return { items, rows, filters, filtered, statuses, types, typeCounts, loading, loadError, configured, environment, envLabel,
      expireDays, busyKey, rowKey, copying, dialogOpen, generated, cover, money, time, load, unavailable, generate, copy, reset };
  }
});
