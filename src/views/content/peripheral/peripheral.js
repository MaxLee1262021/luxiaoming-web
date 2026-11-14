// 周边编辑使用独立草稿，保存成功后才写回商品列表。
window.LXM_PAGES.register({
  key: "peripherals", component: "LxmPagePeripheral", group: "content", title: "商品管理（影像周边）",
  description: "Photo peripheral product management", styleScope: "page-route-peripheral",
  setup(ctx) {
    const Vue = window.Vue;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const idOf = (row) => String(row && (row.id || row._id) || "");
    const tip = (message) => {
      const notify = ctx.ElMessage || window.ElementPlus?.ElMessage || window.ElMessage;
      if (typeof notify === "function") notify(message);
      return false;
    };
    const editorOpen = Vue.ref(false), selectedPeripheral = Vue.ref(null), saving = Vue.ref(false);
    const selectedPeripheralId = Vue.ref("");
    const remoteOn = Vue.ref(true);
    const remoteLoading = Vue.ref(false), remoteError = Vue.ref("");
    const stockFilter = Vue.ref("");
    const MAX_STOCK = 2147483647;
    const salesFields = ["specMode", "productCode", "unit", "price", "stock", "stockQty", "stockWarning", "shippingFee", "specs", "skus"];
    const connected = () => typeof ctx.isServerConnected === "function" ? ctx.isServerConnected() : !!window.LXM_AUTH?.hasSession?.();
    const listSource = Vue.computed(() => (ctx.data.peripherals || []).filter((row) => row && !row.deleted && !row.isDeleted)
      .filter((row) => !ctx.state.filters.contentSpotId || (typeof ctx.contentSpotIds === "function" ? ctx.contentSpotIds(row) : [row.spotId]).includes(ctx.state.filters.contentSpotId))
      .filter((row) => !ctx.state.filters.contentStatus || ctx.productStatus(row) === ctx.state.filters.contentStatus)
      .filter((row) => !stockFilter.value || stockState(row).key === stockFilter.value)
      .filter((row) => !ctx.state.filters.keyword || JSON.stringify(row).toLowerCase().includes(String(ctx.state.filters.keyword).toLowerCase())));
    const peripheralTags = Vue.computed(() => [...new Set([
      ...(typeof ctx.tagOptions === "function" ? ctx.tagOptions("风格").map((tag) => tag.name) : []),
      ...(ctx.data.peripherals || []).flatMap((row) => Array.isArray(row.tags) ? row.tags : [])
    ])]);
    function toList(value) { return (Array.isArray(value) ? value.map(String) : String(value || "").split(/[,，、\n]/)).map((item) => item.trim()).filter(Boolean); }
    const numeric = (value) => ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value));
    const validStock = (value) => numeric(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= MAX_STOCK;
    const validMoney = (value) => numeric(value) && Number(value) >= 0 && Number.isSafeInteger(Math.round(Number(value) * 100));
    function salesSummary(row = {}) {
      if (row.specMode === "multiple") {
        const skus = Array.isArray(row.skus) ? row.skus : [];
        const total = skus.reduce((sum, sku) => sum + (validStock(sku.stock) ? Number(sku.stock) : 0), 0);
        return {
          price: skus.length && skus.every((sku) => validMoney(sku.price)) ? Math.min(...skus.map((sku) => Number(sku.price))) : null,
          stock: skus.length && skus.every((sku) => validStock(sku.stock)) && total <= MAX_STOCK ? total : null,
          count: skus.length
        };
      }
      const stock = row.stock ?? row.stockQty;
      return { price: validMoney(row.price) ? Number(row.price) : null, stock: validStock(stock) ? Number(stock) : null, count: 1 };
    }
    function stockState(row = {}) {
      const stock = salesSummary(row).stock;
      const warning = validStock(row.stockWarning) ? Number(row.stockWarning) : 5;
      if (stock === null) return { key: "unset", text: "未设置", stock };
      if (stock === 0) return { key: "empty", text: "缺货", stock };
      if (stock <= warning) return { key: "low", text: "库存预警", stock };
      return { key: "normal", text: "库存充足", stock };
    }
    function specText(row = {}) {
      return row.specMode === "multiple" ? `${(row.skus || []).length} 个规格` : toList(row.specs).join(" / ") || "默认规格";
    }
    function priceText(row = {}) {
      const price = salesSummary(row).price;
      return price === null ? "待填写" : `${ctx.money(price)}${row.specMode === "multiple" ? " 起" : ""}`;
    }
    function stockText(row = {}) {
      const stock = salesSummary(row).stock;
      return stock === null ? "未设置" : `${stock} ${row.unit || "件"}`;
    }
    function clearPeripheralFilters() { stockFilter.value = ""; if (ctx.clearContentFilters) ctx.clearContentFilters(); }
    function changeSpecMode(mode) {
      const draft = selectedPeripheral.value;
      if (!draft || !ctx.can("contentEdit") || saving.value) return;
      if (mode === "multiple" && !draft.skus.length) {
        draft.skus.push({ skuCode: "", spec: toList(draft.specs).join(" / "), price: draft.price, stock: draft.stock });
      }
      if (mode === "single" && draft.skus.length) {
        const summary = salesSummary({ ...draft, specMode: "multiple" });
        draft.specs = [...new Set(draft.skus.map((sku) => String(sku.spec || "").trim()).filter(Boolean))];
        if (summary.price !== null) draft.price = summary.price;
        if (summary.stock !== null) draft.stock = summary.stock;
      }
    }
    function addSku() {
      const draft = selectedPeripheral.value;
      if (!draft || !ctx.can("contentEdit") || saving.value) return;
      if (draft.skus.length >= 100) return tip("每个商品最多添加 100 个规格");
      draft.skus.push({ skuCode: "", spec: "", price: draft.price, stock: 0 });
    }
    function removeSku(index) {
      const draft = selectedPeripheral.value;
      if (!draft || !ctx.can("contentEdit") || saving.value || draft.skus.length <= 1) return;
      draft.skus.splice(index, 1);
    }
    function normalizeSales(payload) {
      payload.productCode = String(payload.productCode || "").trim();
      payload.unit = String(payload.unit || "").trim();
      if (payload.productCode.length > 128) return "商品编码不能超过 128 个字符";
      if (!payload.unit) return "请填写销售单位";
      if (payload.unit.length > 20) return "销售单位不能超过 20 个字符";
      if (!validStock(payload.stockWarning)) return "预警库存须为 0 至 2147483647 的整数";
      if (!validMoney(payload.shippingFee)) return "请填写有效的运费金额";
      payload.stockWarning = Number(payload.stockWarning);
      payload.shippingFee = Math.round(Number(payload.shippingFee) * 100) / 100;
      if (payload.specMode === "multiple") {
        if (!Array.isArray(payload.skus) || !payload.skus.length || payload.skus.length > 100) return "请设置 1 至 100 个商品规格";
        const specs = new Set(), codes = new Set();
        for (let index = 0; index < payload.skus.length; index += 1) {
          const sku = payload.skus[index];
          sku.spec = String(sku.spec || "").trim(); sku.skuCode = String(sku.skuCode || "").trim();
          if (!sku.spec) return `请填写第 ${index + 1} 行的规格名称`;
          if (sku.spec.length > 160) return `第 ${index + 1} 行规格名称不能超过 160 个字符`;
          if (sku.skuCode.length > 128) return `第 ${index + 1} 行规格编码不能超过 128 个字符`;
          if (specs.has(sku.spec)) return `规格名称「${sku.spec}」重复`;
          if (sku.skuCode && codes.has(sku.skuCode)) return `规格编码「${sku.skuCode}」重复`;
          if (!validMoney(sku.price)) return `请填写第 ${index + 1} 行的有效售价`;
          if (!validStock(sku.stock)) return `第 ${index + 1} 行库存须为 0 至 2147483647 的整数`;
          specs.add(sku.spec); if (sku.skuCode) codes.add(sku.skuCode);
          sku.price = Math.round(Number(sku.price) * 100) / 100; sku.stock = Number(sku.stock);
        }
        const summary = salesSummary(payload);
        if (summary.stock === null) return "规格总库存不能超过 2147483647";
        payload.specs = payload.skus.map((sku) => sku.spec);
        payload.price = summary.price; payload.stock = summary.stock;
      } else {
        payload.specMode = "single";
        if (!validMoney(payload.price)) return "请填写有效的商品售价";
        if (!validStock(payload.stock)) return "请填写库存，须为 0 至 2147483647 的整数";
        payload.price = Math.round(Number(payload.price) * 100) / 100;
        payload.stock = Number(payload.stock); payload.skus = [];
      }
      payload.stockQty = payload.stock;
      return "";
    }
    function mediaList(value) {
      const entries = Array.isArray(value) ? value : value ? [value] : [];
      return [...new Set(entries.map((item) => typeof item === "string" ? item : item && (item.url || item.src || item.videoUrl || item.imageUrl || item.fileUrl) || "")
        .map((url) => String(url).trim()).filter(Boolean))];
    }
    function previewVisible(row) {
      const preview = { ...row, status: row.isShow === false || row.internalOnly ? "下架" : "上架", spotIds: row.spotId ? [String(row.spotId)] : [], spotBindingExplicit: true };
      return typeof ctx.contentEffectiveVisible === "function" ? ctx.contentEffectiveVisible(preview) : row.isShow !== false && !row.internalOnly;
    }
    function normalizeDraft(row) {
      const draft = clone(row);
      if (ctx.hydrateProductSpot) ctx.hydrateProductSpot(draft);
      draft.tags = toList(draft.tags); draft.specs = toList(draft.specs);
      draft.productCode = String(draft.productCode || ""); draft.unit = String(draft.unit || "件");
      draft.specMode = draft.specMode === "multiple" ? "multiple" : "single";
      draft.skus = Array.isArray(draft.skus) ? draft.skus.map((sku) => ({ ...sku })) : [];
      draft.stock = draft.stock ?? draft.stockQty ?? undefined;
      draft.stockWarning = draft.stockWarning ?? 5; draft.shippingFee = draft.shippingFee ?? 0;
      draft.images = mediaList(draft.images); draft.videos = mediaList(draft.videos);
      draft.intro = String(draft.intro ?? draft.description ?? "");
      draft.cover = draft.cover || draft.image || draft.images[0] || "";
      draft.spotId = draft.spotId || (draft.spotIds || [])[0] || "";
      draft.isShow = draft.isShow !== false && !["草稿", "下架", "隐藏"].includes(draft.status);
      delete draft.effectiveVisible; delete draft.visibilityReasons;
      return draft;
    }
    function selectPeripheral(row) {
      if (saving.value) return;
      selectedPeripheralId.value = idOf(row);
      selectedPeripheral.value = normalizeDraft(row);
      editorOpen.value = true;
    }
    function createPeripheral() {
      if (!ctx.can("contentEdit") || saving.value) return;
      selectedPeripheralId.value = "";
      selectedPeripheral.value = { name: "", productCode: "", unit: "件", category: "相框", specMode: "single", specs: [], skus: [], price: 0, stock: 0, stockWarning: 5, shippingFee: 0, tags: [], cover: "", images: [], videos: [], intro: "", deliveryCycle: "", spotId: "", spotIds: [], spotBindingExplicit: true, isShow: true, internalOnly: false, retouchIncluded: false, editingIncluded: false, isHot: false };
      editorOpen.value = true;
    }
    function closeEditor() { if (!saving.value) { editorOpen.value = false; selectedPeripheral.value = null; } }
    function resetDraft() {
      const source = ctx.data.peripherals.find((row) => idOf(row) === selectedPeripheralId.value);
      if (source) selectedPeripheral.value = normalizeDraft(source);
      else createPeripheral();
    }
    function changeSpot() {
      const row = selectedPeripheral.value;
      row.spotIds = row.spotId ? [String(row.spotId)] : [];
      row.spotBindingExplicit = true;
      row.mode = row.spotId ? "定点专属" : "全城通用";
      if (ctx.markContentSpotChange) ctx.markContentSpotChange(row);
    }
    function removeMedia(field, url) {
      const draft = selectedPeripheral.value;
      draft[field] = (draft[field] || []).filter((item) => item !== url);
      if (field === "images" && draft.cover === url) draft.cover = draft.images[0] || "";
    }
    async function refreshFromServer() {
      if (saving.value) return false;
      remoteLoading.value = true; remoteError.value = "";
      try {
        const rows = await LXM_API.loadCollection("peripherals");
        if (!Array.isArray(rows)) throw new Error("周边数据格式不正确");
        ctx.data.peripherals = rows; remoteOn.value = true; LXM_API.setRemote(true);
        return true;
      } catch (error) { remoteError.value = error.message; tip("载入失败：" + error.message); return false; }
      finally { remoteLoading.value = false; }
    }
    function toggleRemote(event) {
      if (event?.target) event.target.checked = true;
      remoteOn.value = true; LXM_API.setRemote(true);
      return refreshFromServer();
    }
    async function saveSelectedPeripheral() {
      if (!selectedPeripheral.value || saving.value || !ctx.can("contentEdit")) return false;
      if (!connected() || remoteLoading.value || remoteError.value) return tip("真实后端连接不可用，请刷新后重试");
      if (window.LXM_UPLOAD?.ready && !window.LXM_UPLOAD.ready()) return false;
      const payload = clone(selectedPeripheral.value);
      payload.name = String(payload.name || "").trim();
      if (!payload.name) return tip("请填写商品名称");
      const source = ctx.data.peripherals.find((row) => idOf(row) === selectedPeripheralId.value);
      const baseline = source && normalizeDraft(source);
      // Hiding an existing product must not require backfilling historical sales
      // data. Send a partial update only when those fields were left untouched.
      const preserveSales = baseline && (payload.isShow === false || payload.internalOnly)
        && salesFields.every((field) => JSON.stringify(payload[field]) === JSON.stringify(baseline[field]));
      if (preserveSales) salesFields.forEach((field) => { delete payload[field]; });
      else {
        const salesError = normalizeSales(payload);
        if (salesError) return tip(salesError);
        payload.specs = [...new Set(toList(payload.specs))];
      }
      payload.tags = [...new Set(toList(payload.tags))];
      payload.intro = String(payload.intro || "").trim(); payload.description = payload.intro;
      payload.image = payload.cover || ""; payload.cate = payload.category || "";
      payload.spotIds = payload.spotId ? [String(payload.spotId)] : []; payload.spotBindingExplicit = true;
      payload.mode = payload.spotId ? "定点专属" : "全城通用";
      payload.status = payload.isShow && !payload.internalOnly ? "上架" : "下架";
      payload.auditStatus = payload.status === "上架" ? "已上" : "已下";
      const previous = source ? clone(source) : null;
      if (!idOf(payload)) { payload.id = `peripheral_${Date.now().toString(36)}`; payload._id = payload.id; }
      saving.value = true;
      try {
        const ok = typeof ctx.persistContentMutation === "function" ? await ctx.persistContentMutation("peripherals", payload, previous)
          : !!(await LXM_API.saveDoc("peripherals", payload));
        if (!ok) return false;
        if (source) Object.assign(source, payload); else ctx.data.peripherals.unshift(payload);
        editorOpen.value = false; selectedPeripheral.value = null;
        tip("商品已保存到后端");
        return true;
      } catch (error) { tip("保存失败：" + error.message); return false; }
      finally { saving.value = false; }
    }
    return { editorOpen, selectedPeripheral, selectedPeripheralId, remoteOn, remoteLoading, remoteError, saving, stockFilter,
      listSource, peripheralTags, previewVisible, selectPeripheral, createPeripheral, closeEditor, resetDraft, changeSpot, removeMedia,
      salesSummary, stockState, stockText, specText, priceText, clearPeripheralFilters, changeSpecMode, addSku, removeSku,
      refreshFromServer, toggleRemote, saveSelectedPeripheral };
  }
});
