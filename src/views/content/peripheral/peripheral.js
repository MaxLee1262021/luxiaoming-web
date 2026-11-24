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
    const physicalCanConfigureSales = Vue.computed(() => ["super", "admin"].includes(ctx.state.role));
    const physicalSales = Vue.reactive({ dialog: "", busy: false, loading: false, error: "", config: {}, products: [] });
    async function physicalSalesApi(action, body) {
      const response = await window.LXM_HTTP.request("/api/physical/admin/" + action, body == null ? { method: "GET" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok || payload.code !== 0) throw new Error(payload.msg || payload.error || "实物服务暂不可用");
      return payload.data;
    }
    function physicalSalesProducts(catalog) { return Array.isArray(catalog) ? catalog : catalog.items || catalog.products || []; }
    function physicalSalesMessage(type, message) {
      const notify = ctx.ElMessage || window.ElementPlus?.ElMessage || window.ElMessage;
      if (typeof notify?.[type] === "function") notify[type](message);
      else tip(message);
    }
    function physicalSalesError(error) {
      physicalSales.error = error.message;
      physicalSalesMessage("error", error.message);
    }
    async function physicalConfigure() {
      if (!physicalCanConfigureSales.value || physicalSales.loading || physicalSales.busy) return;
      physicalSales.loading = true; physicalSales.error = "";
      try {
        const [config, catalog] = await Promise.all([physicalSalesApi("config"), physicalSalesApi("catalog")]);
        physicalSales.config = clone({ ...config, enabledProductIds: config.enabledProductIds || [],
          allowedProvinces: config.allowedProvinces || [], productPolicies: config.productPolicies || {} });
        physicalSales.products = physicalSalesProducts(catalog);
        for (const product of physicalSales.products) physicalSales.config.productPolicies[product.id] ||= { fulfillmentMode: product.fulfillmentMode || "stock" };
        physicalSales.dialog = "config";
      } catch (error) { physicalSalesError(error); }
      finally { physicalSales.loading = false; }
    }
    async function physicalSaveConfig() {
      if (!physicalCanConfigureSales.value || physicalSales.busy || physicalSales.loading) return;
      physicalSales.busy = true; physicalSales.error = "";
      try {
        await physicalSalesApi("saveConfig", physicalSales.config);
        physicalSales.dialog = "";
        physicalSalesMessage("success", "销售配置已保存");
      } catch (error) { physicalSalesError(error); }
      finally { physicalSales.busy = false; }
    }
    async function physicalAdjustStock(sku) {
      if (!physicalCanConfigureSales.value || physicalSales.busy || physicalSales.loading) return;
      let delta, reason;
      physicalSales.busy = true; physicalSales.error = "";
      try {
        delta = Number((await ctx.ElMessageBox.prompt("填正整数入库，负整数出库；不能低于有效预占数量。", "库存调整", { inputPattern: /^-?[1-9]\d*$/, inputErrorMessage: "请输入非零整数" })).value);
        reason = (await ctx.ElMessageBox.prompt("填写本次盘点或出入库原因", "库存调整原因", { inputPattern: /.{3,}/, inputErrorMessage: "请填写调整依据" })).value;
      } catch (_) { physicalSales.busy = false; return; }
      try {
        await physicalSalesApi("adjustStock", { skuId: sku.skuId || sku.id, version: sku.inventoryVersion, delta, reason });
        physicalSalesMessage("success", "库存已调整");
        physicalSales.products = physicalSalesProducts(await physicalSalesApi("catalog"));
      } catch (error) { physicalSalesError(error); }
      finally { physicalSales.busy = false; }
    }
    const MAX_STOCK = 2147483647;
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
    const validMoney = (value) => numeric(value) && Number(value) >= 0 && Number(value) <= 10000000
      && Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) <= 1e-6;
    const validPrice = (value) => validMoney(value) && Math.round(Number(value) * 100) > 0;
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
    function skuLabel(row = {}, fallback = "默认规格") {
      const spec = String(row.spec || "").trim() || fallback;
      const style = String(row.style || "").trim();
      return style ? `${style} / ${spec}` : spec;
    }
    function styleText(row = {}) {
      const styles = row.specMode === "multiple" ? (row.skus || []).map((sku) => String(sku.style || "").trim()) : [String(row.skuStyle || "").trim()];
      return [...new Set(styles.filter(Boolean))].join(" / ") || "未设置";
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
    function shippingText(row = {}) {
      return !validMoney(row.shippingFee) ? "待填写" : Number(row.shippingFee) === 0 ? "免运费" : ctx.money(Number(row.shippingFee));
    }
    function clearPeripheralFilters() { stockFilter.value = ""; if (ctx.clearContentFilters) ctx.clearContentFilters(); }
    function changeSpecMode(mode) {
      const draft = selectedPeripheral.value;
      if (!draft || !ctx.can("contentEdit") || saving.value) return;
      if (mode === "multiple" && !draft.skus.length) {
        draft.skus.push({ skuCode: "", spec: toList(draft.specs).join(" / "), style: String(draft.skuStyle || "").trim(), price: draft.price, stock: draft.stock });
      }
      if (mode === "single" && draft.skus.length) {
        const summary = salesSummary({ ...draft, specMode: "multiple" });
        const styles = [...new Set(draft.skus.map((sku) => String(sku.style || "").trim()))];
        draft.skuStyle = styles.length === 1 ? styles[0] : "";
        // 保留既有单规格转换格式，展示顺序的调整不改写历史规格内容。
        draft.specs = [...new Set(draft.skus.map((sku) => {
          const spec = String(sku.spec || "").trim(), style = String(sku.style || "").trim();
          return styles.length === 1 || !style ? spec : `${spec}【${style}】`;
        }).filter(Boolean))];
        if (summary.price !== null) draft.price = summary.price;
        if (summary.stock !== null) draft.stock = summary.stock;
      }
    }
    function addSku() {
      const draft = selectedPeripheral.value;
      if (!draft || !ctx.can("contentEdit") || saving.value) return;
      if (draft.skus.length >= 100) return tip("每个商品最多添加 100 个规格");
      draft.skus.push({ skuCode: "", spec: "", style: "", price: draft.price, stock: undefined });
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
      if (!["single", "multiple"].includes(payload.specMode)) return "请选择规格模式";
      if (!validStock(payload.stockWarning)) return "预警库存须为 0 至 2147483647 的整数";
      if (!validMoney(payload.shippingFee)) return "请填写有效的运费金额（0 表示包邮，最多两位小数且不超过 10000000 元）";
      payload.stockWarning = Number(payload.stockWarning);
      payload.shippingFee = Math.round(Number(payload.shippingFee) * 100) / 100;
      if (payload.specMode === "multiple") {
        if (!Array.isArray(payload.skus) || !payload.skus.length || payload.skus.length > 100) return "请设置 1 至 100 个商品规格";
        const specs = new Set(), codes = new Set();
        for (let index = 0; index < payload.skus.length; index += 1) {
          const sku = payload.skus[index];
          sku.spec = String(sku.spec || "").trim(); sku.style = String(sku.style || "").trim(); sku.skuCode = String(sku.skuCode || "").trim();
          if (!sku.spec) return `请填写第 ${index + 1} 行的规格名称`;
          if (sku.spec.length > 160) return `第 ${index + 1} 行规格名称不能超过 160 个字符`;
          if (sku.style.length > 80) return `第 ${index + 1} 行样式不能超过 80 个字符`;
          if (sku.skuCode.length > 128) return `第 ${index + 1} 行规格编码不能超过 128 个字符`;
          const specKey = JSON.stringify([sku.spec, sku.style]);
          if (specs.has(specKey)) return `规格名称与样式「${skuLabel(sku)}」重复`;
          if (sku.skuCode && codes.has(sku.skuCode)) return `规格编码「${sku.skuCode}」重复`;
          if (!validPrice(sku.price)) return `请填写第 ${index + 1} 行的有效售价（须大于 0，最多两位小数且不超过 10000000 元）`;
          if (!validStock(sku.stock)) return `第 ${index + 1} 行库存须为 0 至 2147483647 的整数`;
          specs.add(specKey); if (sku.skuCode) codes.add(sku.skuCode);
          sku.price = Math.round(Number(sku.price) * 100) / 100; sku.stock = Number(sku.stock);
        }
        const summary = salesSummary(payload);
        if (summary.stock === null) return "规格总库存不能超过 2147483647";
        payload.specs = payload.skus.map((sku) => sku.spec);
        payload.price = summary.price; payload.stock = summary.stock;
      } else {
        payload.specMode = "single";
        payload.skuStyle = String(payload.skuStyle || "").trim();
        if (payload.skuStyle.length > 80) return "样式不能超过 80 个字符";
        if (!validPrice(payload.price)) return "请填写有效的商品售价（须大于 0，最多两位小数且不超过 10000000 元）";
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
      draft.skuStyle = String(draft.skuStyle || "");
      draft.specMode = draft.specMode === "multiple" ? "multiple" : "single";
      draft.skus = Array.isArray(draft.skus) ? draft.skus.map((sku) => ({ ...sku, style: String(sku.style || "") })) : [];
      draft.stock = draft.stock ?? draft.stockQty ?? undefined;
      draft.stockWarning = draft.stockWarning ?? 5;
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
      selectedPeripheral.value = { name: "", productCode: "", unit: "件", category: "相框", specMode: "single", specs: [], skuStyle: "", skus: [], price: undefined, stock: undefined, stockWarning: 5, shippingFee: undefined, tags: [], cover: "", images: [], videos: [], intro: "", deliveryCycle: "", spotId: "", spotIds: [], spotBindingExplicit: true, isShow: true, internalOnly: false, retouchIncluded: false, editingIncluded: false, isHot: false };
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
      let payload = clone(selectedPeripheral.value);
      const source = ctx.data.peripherals.find((row) => idOf(row) === selectedPeripheralId.value);
      const baseline = source && normalizeDraft(source);
      // Pure withdrawal stays available for incomplete historical products.
      // Normal editor saves always validate the full draft, including hidden products.
      const visibilityOnlyHide = baseline && (payload.isShow === false || payload.internalOnly)
        && Object.keys(payload).every((field) => ["isShow", "internalOnly"].includes(field)
          || JSON.stringify(payload[field]) === JSON.stringify(baseline[field]));
      if (visibilityOnlyHide) {
        payload = { id: idOf(source), _id: idOf(source), isShow: payload.isShow, internalOnly: payload.internalOnly };
      } else {
        payload.name = String(payload.name || "").trim();
        if (!payload.name) return tip("请填写商品名称");
        const salesError = normalizeSales(payload);
        if (salesError) return tip(salesError);
        payload.specs = [...new Set(toList(payload.specs))];
        payload.cover = String(payload.cover || "").trim();
        payload.images = mediaList(payload.images); payload.videos = mediaList(payload.videos);
        if (!payload.cover && !payload.images.length && !payload.videos.length) return tip("请至少上传一份商品素材（首图、照片或视频）");
        payload.tags = [...new Set(toList(payload.tags))];
        payload.intro = String(payload.intro || "").trim();
        if (!payload.intro) return tip("请填写商品说明");
        payload.description = payload.intro;
        payload.image = payload.cover; payload.cate = payload.category || "";
        payload.spotIds = payload.spotId ? [String(payload.spotId)] : []; payload.spotBindingExplicit = true;
        payload.mode = payload.spotId ? "定点专属" : "全城通用";
      }
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
      physicalSales, physicalCanConfigureSales, physicalConfigure, physicalSaveConfig, physicalAdjustStock,
      listSource, peripheralTags, previewVisible, selectPeripheral, createPeripheral, closeEditor, resetDraft, changeSpot, removeMedia,
      salesSummary, stockState, stockText, styleText, specText, skuLabel, priceText, shippingText, clearPeripheralFilters, changeSpecMode, addSku, removeSku,
      refreshFromServer, toggleRemote, saveSelectedPeripheral };
  }
});
