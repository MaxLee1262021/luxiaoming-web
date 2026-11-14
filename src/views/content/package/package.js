// 旅拍套餐管理：按城市、打卡点逐项组合商品，沿用小程序的商品与价格契约。
window.LXM_PAGES.register({
  key: "packages",
  component: "LxmPagePackage",
  group: "content",
  title: "Package",
  description: "Travel photo package management",
  styleScope: "page-route-package",
  setup(ctx) {
    const Vue = window.Vue;
    const {
      data, can, money, requestDeletePackage, persistContentMutation
    } = ctx;
    const notify = (type, message) => {
      try {
        if (window.ElMessage && typeof window.ElMessage[type] === "function") window.ElMessage[type](message);
        else if (window.ElMessage) window.ElMessage(message);
      } catch (_) {}
    };

    const loading = Vue.ref(false);
    const keyword = Vue.ref("");
    const spotFilter = Vue.computed({
      get: () => ctx.state.filters.contentSpotId || "",
      set: (value) => { ctx.state.filters.contentSpotId = value || ""; }
    });
    const visibilityFilter = Vue.ref("");
    const dialogVisible = Vue.ref(false);
    const saving = Vue.ref(false);
    const form = Vue.ref(null);
    const goodsSpotFilter = Vue.ref("");
    const picker = Vue.reactive({ city: "", spotId: "", productKey: "", peripheralId: "", productKeys: [], peripheralIds: [] });
    const tagInput = Vue.ref("");
    const tagPresets = ["主推", "爆款", "新品", "活动"];
    const pendingIds = Vue.ref([]);
    let initialDraft = "";

    function rowId(row = {}) { return String(row.id || row._id || ""); }
    function clone(value) {
      try { return structuredClone(value); }
      catch (_) { return JSON.parse(JSON.stringify(value || {})); }
    }
    function restoreRecord(source, previous) {
      Object.keys(source).forEach((key) => { if (!(key in previous)) delete source[key]; });
      Object.assign(source, previous);
    }
    function manualVisible(row = {}) {
      return typeof ctx.contentManualVisible === "function" ? ctx.contentManualVisible(row) : row.isShow !== false;
    }
    function visibilityHint(row = {}) {
      return manualVisible(row) && !isVisible(row) ? "已开启展示，但关联商品或打卡点不可见，套餐暂不展示" : "";
    }
    function tagsOf(row = {}) {
      const raw = Array.isArray(row.serviceTags) ? row.serviceTags : (Array.isArray(row.tags) ? row.tags : []);
      return raw.map((item) => String(item || "").trim()).filter(Boolean);
    }
    function spotIdsOf(row = {}) {
      if (typeof ctx.contentSpotIds === "function") return ctx.contentSpotIds(row);
      const ids = [
        ...(Array.isArray(row.spotIds) ? row.spotIds : []),
        row.spotId
      ].filter(Boolean).map(String);
      return [...new Set(ids)];
    }
    function isVisible(row = {}) {
      if (typeof ctx.contentEffectiveVisible === "function") return ctx.contentEffectiveVisible(row);
      if (!row || row.deleted || row.isDeleted || row.isShow === false) return false;
      if (["下架", "草稿", "待审", "待审核", "驳回", "停用"].includes(String(row.status || ""))) return false;
      const auditStatus = String(row.auditStatus || row.reviewStatus || "");
      return !auditStatus || ["已上", "已上架", "审核通过", "通过", "approved", "pass", "passed", "published", "online"].includes(auditStatus);
    }
    function normalizeRow(row = {}) {
      const source = row && typeof row === "object" ? row : {};
      const ids = spotIdsOf(source);
      const description = String(source.description ?? source.intro ?? "").trim();
      const serviceTags = tagsOf(source);
      const rawDepositRatio = Number(source.depositRatio ?? source.depositRate ?? source.depositPercent ?? 30);
      const depositRatio = Number.isFinite(rawDepositRatio)
        ? Math.min(100, Math.max(0, rawDepositRatio <= 1 ? rawDepositRatio * 100 : rawDepositRatio))
        : 30;
      return {
        ...source,
        id: rowId(source),
        _id: rowId(source),
        type: "photo",
        productType: "photo",
        serviceType: "photo",
        category: "photo_package",
        spotId: String(source.spotId || ids[0] || ""),
        spotIds: ids,
        description,
        intro: description,
        shootingNotes: String(source.shootingNotes ?? "").trim(),
        serviceTags,
        depositRatio,
        tags: Array.isArray(source.tags) ? source.tags : [],
        isMainPush: source.isMainPush === true || source.mainPush === true,
        mainPush: source.isMainPush === true || source.mainPush === true,
        includedItems: Array.isArray(source.includedItems) ? source.includedItems : (Array.isArray(source.items) ? source.items : []),
        items: Array.isArray(source.items) ? source.items : (Array.isArray(source.includedItems) ? source.includedItems : [])
      };
    }
    function packageSpotNames(row = {}) {
      const names = spotIdsOf(row)
        .map((id) => (data.spots || []).find((spot) => String(spot.id || spot._id) === String(id)))
        .filter(Boolean)
        .map((spot) => spot.name || "")
        .filter(Boolean);
      return names.length ? names.join("、") : "全城通用";
    }
    function packageAlbumName(row = {}) {
      const album = (data.albums || []).find((item) => String(item.id || item._id) === String(row.albumId || ""));
      return album ? album.name : "未关联";
    }
    function statusText(row = {}) { return isVisible(row) ? "已上架" : "已下架"; }
    function priceText(row = {}) {
      const price = Number(row.price ?? row.specialPrice ?? 0);
      const original = Number(row.originalPrice || 0);
      return { price: money(price), original: original > price ? money(original) : "" };
    }
    function canEdit() { return !!(typeof can === "function" && can("contentEdit")); }
    function currentRows() {
      return (data.packages || [])
        .filter((row) => row && row.type !== "video" && !row.deleted && !row.isDeleted)
        .map(normalizeRow);
    }
    const tableRows = Vue.computed(() => {
      const term = String(keyword.value || "").trim().toLowerCase();
      return currentRows().filter((row) => {
        if (spotFilter.value && !spotIdsOf(row).includes(String(spotFilter.value))) return false;
        if (visibilityFilter.value === "visible" && !isVisible(row)) return false;
        if (visibilityFilter.value === "hidden" && isVisible(row)) return false;
        if (!term) return true;
        return [row.name, row.description, (row.tags || []).join("、"), tagsOf(row).join("、"), itemDetails(row), packageSpotNames(row), packageAlbumName(row)]
          .join(" ").toLowerCase().includes(term);
      });
    });
    const summary = Vue.computed(() => {
      const rows = currentRows();
      return {
        total: rows.length,
        visible: rows.filter(isVisible).length,
        hidden: rows.filter((row) => !isVisible(row)).length,
        mainPush: rows.filter((row) => row.isMainPush).length
      };
    });

    function buildForm(row = null) {
      const source = row ? normalizeRow(row) : {
        id: "", name: "", cover: "", price: 0, originalPrice: 0,
        description: "", spotIds: [], spotId: "", seriesId: "", albumId: "",
        depositRatio: 30, isShow: true, includedItems: []
      };
      const sourceItems = (source.includedItems || []).length ? source.includedItems : createAlbumItem(source);
      const items = sourceItems.map(normalizeIncludedItem);
      const originalPrice = sumItems(items);
      return {
        ...clone(source),
        includedItems: items,
        originalPrice,
        priceManuallySet: source.priceManuallySet === true || (items.length > 0 && Number(source.price || 0) !== originalPrice),
        tagText: (Array.isArray(source.tags) ? source.tags : []).join("、"),
        spotIds: spotIdsOf(source),
        isShow: typeof ctx.contentManualVisible === "function" ? ctx.contentManualVisible(source) : isVisible(source)
      };
    }
    function openCreate() {
      if (!canEdit()) return;
      form.value = buildForm();
      resetPicker();
      initialDraft = JSON.stringify(form.value);
      dialogVisible.value = true;
    }
    function openEdit(row) {
      form.value = buildForm(row);
      resetPicker();
      initialDraft = JSON.stringify(form.value);
      dialogVisible.value = true;
    }
    async function confirmDiscard() {
      if (saving.value || window.LXM_UPLOAD?.busy?.()) return false;
      if (!canEdit() || (JSON.stringify(form.value) === initialDraft && !tagInput.value.trim())) return true;
      const messageBox = ctx.ElMessageBox || window.ElMessageBox;
      if (typeof messageBox?.confirm !== "function") return true;
      try {
        await messageBox.confirm("有尚未保存的修改，确定放弃并关闭吗？", "放弃修改", {
          type: "warning", confirmButtonText: "放弃修改", cancelButtonText: "继续编辑"
        });
        return true;
      } catch (_) { return false; }
    }
    async function closeDialog() {
      if (await confirmDiscard()) dialogVisible.value = false;
    }
    async function beforeDialogClose(done) {
      if (await confirmDiscard()) done();
    }
    function resetPicker() {
      Object.assign(picker, { city: "", spotId: "", productKey: "", peripheralId: "", productKeys: [], peripheralIds: [] });
      goodsSpotFilter.value = "";
      tagInput.value = "";
    }
    function resetEditor() {
      if (dialogVisible.value) return;
      form.value = null;
      initialDraft = "";
      resetPicker();
    }
    function normalizeTagInput(value) {
      return [...new Set(String(value || "").split(/[，,、|\n]/).map((item) => item.trim()).filter(Boolean))];
    }
    const formTags = Vue.computed(() => normalizeTagInput(form.value?.tagText));
    function addTag(value = tagInput.value) {
      if (!canEdit() || saving.value || !form.value) return false;
      const tag = String(value || "").trim();
      if (!tag) return false;
      if (tag.length > 8 || /[，,、|\n]/.test(tag)) { notify("warning", "每个标签最多 8 个字，请逐个添加"); return false; }
      if (formTags.value.includes(tag)) {
        if (arguments.length && tagPresets.includes(tag)) { removeTag(formTags.value.indexOf(tag)); return true; }
        notify("warning", "该标签已存在"); return false;
      }
      if (formTags.value.length >= 6) { notify("warning", "最多添加 6 个标签"); return false; }
      form.value.tagText = [...formTags.value, tag].join("、");
      tagInput.value = "";
      return true;
    }
    function removeTag(index) {
      if (!canEdit() || saving.value || !form.value) return;
      const tags = [...formTags.value];
      tags.splice(index, 1);
      form.value.tagText = tags.join("、");
    }
    function createAlbumItem(record) {
      if (!record.albumId) return [];
      const album = (data.albums || []).find((item) => String(item.id || item._id) === String(record.albumId));
      return [{
        type: "album",
        name: album && album.name ? album.name : "照片留影",
        albumId: record.albumId,
        price: 0,
        target: {
          page: "photoCollection",
          albumId: record.albumId,
          seriesId: record.seriesId || (album && album.seriesId) || "",
          spotId: record.spotId || (album && album.spotId) || ""
        }
      }];
    }
    function productOptions(type) {
      const pool = type === "album" ? data.albums : type === "video" ? data.packages : data.peripherals;
      return (pool || []).filter((item) => item && !item.deleted && !item.isDeleted && (type !== "video" || item.type === "video")).map((item) => {
        const id = rowId(item);
        const spotIds = spotIdsOf(item);
        const spotId = spotIds[0] || "";
        const target = type === "album" ? { page: "photoCollection", albumId: id, seriesId: item.seriesId || "", spotId }
          : type === "video" ? { page: "videoProductDetail", productId: id, spotId }
            : { page: "peripheral", id, peripheralId: id };
        return { id, name: item.name || item.title || itemTypeLabel(type), price: Number(item.price ?? item.specialPrice ?? 0), spotId, spotIds, target };
      });
    }
    function productRecord(type, id) {
      const pool = type === "album" ? data.albums : type === "video" ? data.packages : data.peripherals;
      return (pool || []).find((row) => rowId(row) === String(id));
    }
    function activeSpots() { return (data.spots || []).filter((row) => row && !row.deleted && !row.isDeleted); }
    function cityOfSpot(spot = {}) {
      const city = (data.cities || []).find((row) => [rowId(row), row.code, row.name].filter(Boolean).map(String).includes(String(spot.cityId || spot.city || "")));
      return city ? { value: rowId(city), label: city.name || city.city || rowId(city) }
        : { value: String(spot.cityId || spot.city || "__unknown__"), label: spot.city || "未归属城市" };
    }
    const cityOptions = Vue.computed(() => {
      const options = new Map();
      activeSpots().forEach((spot) => { const city = cityOfSpot(spot); options.set(city.value, city); });
      return [...options.values()];
    });
    const spotProducts = Vue.computed(() => ["album", "video"].flatMap((type) => productOptions(type).map((option) => ({
      ...option, type, key: `${type}:${option.id}`, typeLabel: itemTypeLabel(type),
      spotIds: spotIdsOf(productRecord(type, option.id))
    }))));
    const pickerSpots = Vue.computed(() => {
      const spots = activeSpots().filter((spot) => !picker.city || cityOfSpot(spot).value === picker.city)
        .map((spot) => ({ id: rowId(spot), name: spot.name || "未命名打卡点" }));
      if (!picker.city && spotProducts.value.some((option) => !option.spotIds.length)) spots.push({ id: "__unbound__", name: "未关联打卡点（通用商品）" });
      return spots;
    });
    const spotProductOptions = Vue.computed(() => {
      if (!picker.spotId || !pickerSpots.value.some((spot) => spot.id === picker.spotId)) return [];
      return spotProducts.value.filter((option) => picker.spotId === "__unbound__" ? !option.spotIds.length : option.spotIds.includes(picker.spotId));
    });
    // 周边独立于城市与打卡点筛选；旧周边的真实关联仍由原商品决定。
    const peripheralOptions = Vue.computed(() => productOptions("peripheral"));
    function changePickerCity() { picker.spotId = ""; changePickerSpot(); }
    function changePickerSpot() { picker.productKey = ""; picker.productKeys = []; }
    function isProductIncluded(type, id) {
      return (form.value?.includedItems || []).some((item) => item.type === type && String(item.productId) === String(id));
    }
    function appendProduct(type, option) {
      if (!canEdit() || saving.value || !form.value || !option) return false;
      if (form.value.includedItems.some((item) => item.type === type && String(item.productId) === option.id)) {
        notify("warning", "该商品已在套餐中，可直接调整数量");
        return false;
      }
      form.value.includedItems.push(normalizeIncludedItem({ type, productId: option.id, quantity: 1 }));
      recalculatePrice();
      notify("success", `已添加：${option.name}`);
      return true;
    }
    function addSpotProduct() {
      const option = spotProductOptions.value.find((row) => row.key === picker.productKey);
      if (!option) return notify("warning", "请先选择打卡点和商品");
      return appendProduct(option.type, option);
    }
    function addPeripheralProduct() {
      const option = peripheralOptions.value.find((row) => row.id === picker.peripheralId);
      if (!option) return notify("warning", "请选择影像周边商品");
      return appendProduct("peripheral", option);
    }
    function appendProducts(entries) {
      if (!canEdit() || saving.value || !form.value) return false;
      const items = form.value.includedItems;
      const existingRows = entries.map(({ type, option }) => items.find((item) => item.type === type && String(item.productId) === option.id));
      if (existingRows.some((item) => item && (!Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1 || !Number.isSafeInteger(Number(item.quantity) + 1)))) {
        notify("warning", "请先为已选商品填写有效的整数数量");
        return false;
      }
      let increased = 0;
      entries.forEach(({ type, option }, index) => {
        const existing = existingRows[index];
        if (existing) {
          existing.quantity = Number(existing.quantity) + 1;
          increased += 1;
        } else {
          items.push(normalizeIncludedItem({ type, productId: option.id, quantity: 1 }));
        }
      });
      recalculatePrice();
      notify("success", `已添加 ${entries.length} 件商品${increased ? `，其中 ${increased} 件已累计数量` : ""}，可继续切换城市或打卡点添加`);
      return true;
    }
    function addSpotProducts() {
      if (!canEdit() || saving.value || !form.value) return false;
      const keys = [...new Set(picker.productKeys || [])];
      if (!keys.length) return notify("warning", "请先选择打卡点及一个或多个商品");
      const entries = keys.map((key) => {
        const option = spotProductOptions.value.find((row) => row.key === key);
        return option ? { type: option.type, option } : null;
      });
      if (entries.some((entry) => !entry)) return notify("warning", "所选商品不在当前打卡点或已被删除，请重新选择");
      if (!appendProducts(entries)) return false;
      picker.productKeys = [];
      return true;
    }
    function addPeripheralProducts() {
      if (!canEdit() || saving.value || !form.value) return false;
      const ids = [...new Set(picker.peripheralIds || [])];
      if (!ids.length) return notify("warning", "请选择一个或多个影像周边商品");
      const entries = ids.map((id) => {
        const option = peripheralOptions.value.find((row) => row.id === id);
        return option ? { type: "peripheral", option } : null;
      });
      if (entries.some((entry) => !entry)) return notify("warning", "所选周边已被删除，请重新选择");
      if (!appendProducts(entries)) return false;
      picker.peripheralIds = [];
      return true;
    }
    function itemTypeLabel(type) { return ({ album: "照片留影", video: "视频摄像", peripheral: "影像周边" })[type] || "商品"; }
    function itemLocation(item = {}) {
      const product = productRecord(item.type, item.productId || item.albumId || item.peripheralId || item.target?.albumId || item.target?.productId || item.target?.peripheralId);
      const ids = product ? spotIdsOf(product) : [item.spotId || item.target?.spotId].filter(Boolean).map(String);
      const names = ids.map((id) => activeSpots().find((spot) => rowId(spot) === id)).filter(Boolean)
        .map((spot) => `${cityOfSpot(spot).label} · ${spot.name}`);
      return names.join(" / ") || (item.type === "peripheral" ? "通用影像周边" : "未关联打卡点");
    }
    function groupItems(row = {}) {
      const groups = new Map();
      (row.includedItems || row.items || []).forEach((raw) => {
        const item = normalizeIncludedItem(raw);
        const label = itemLocation(item);
        const key = `${item.type === "peripheral" ? "peripheral" : "spot"}:${label}`;
        if (!groups.has(key)) groups.set(key, { key, label, peripheral: item.type === "peripheral", items: [] });
        groups.get(key).items.push({ ...item, typeLabel: itemTypeLabel(item.type), spotName: label });
      });
      return [...groups.values()];
    }
    const selectedQuantity = Vue.computed(() => (form.value?.includedItems || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0));
    function setItemQuantity() { recalculatePrice(); }
    function filteredProductOptions(type, selectedId = "") {
      const options = productOptions(type);
      if (!goodsSpotFilter.value) return options;
      const pool = type === "album" ? data.albums : type === "video" ? data.packages : data.peripherals;
      return options.filter((option) => option.id === selectedId || spotIdsOf((pool || []).find((row) => rowId(row) === option.id) || {}).includes(String(goodsSpotFilter.value)));
    }
    function cardCover(row = {}) {
      if (row.cover) return row.cover;
      for (const item of row.includedItems || row.items || []) {
        const pool = item.type === "album" ? data.albums : item.type === "video" ? data.packages : data.peripherals;
        const id = String(item.productId || item.albumId || item.peripheralId || item.target?.albumId || item.target?.productId || item.target?.peripheralId || "");
        const product = (pool || []).find((candidate) => rowId(candidate) === id);
        if (product && (product.cover || product.image || product.poster)) return product.cover || product.image || product.poster;
      }
      return "";
    }
    function packageSaving(row = {}) { return Math.max(0, Math.round((Number(row.originalPrice || 0) - Number(row.price || 0)) * 100) / 100); }
    function previewVisible(row) {
      const preview = { ...row, status: row.isShow === false ? "下架" : "上架", auditStatus: row.isShow === false ? "已下" : "已上", includedItems: row.includedItems || [], items: row.includedItems || [] };
      for (const key of ["enabled", "visible", "isSellable"]) if (key in preview) preview[key] = row.isShow !== false;
      delete preview.effectiveVisible; delete preview.visibilityReasons; delete preview.effectiveSpotIds;
      return isVisible(preview);
    }
    function addIncludedItem() {
      if (!canEdit() || saving.value || !form.value) return;
      if (!Array.isArray(form.value.includedItems)) form.value.includedItems = [];
      form.value.includedItems.push({ type: "album", productId: "", name: "", price: 0, quantity: 1, target: {} });
      recalculatePrice();
    }
    function removeIncludedItem(index) {
      if (!canEdit() || saving.value) return;
      if (form.value && Array.isArray(form.value.includedItems)) form.value.includedItems.splice(index, 1);
      recalculatePrice();
    }
    function syncIncludedItem(item) {
      if (!canEdit() || saving.value) return;
      const option = productOptions(item.type).find((candidate) => candidate.id === String(item.productId || ""));
      if (!option) { resetIncludedItem(item); return; }
      item.name = option.name;
      item.price = option.price;
      item.target = option.target;
      item.spotId = option.spotId;
      recalculatePrice();
    }
    function resetIncludedItem(item) {
      if (!canEdit() || saving.value || !item) return;
      item.productId = "";
      item.name = "";
      item.price = 0;
      item.spotId = "";
      item.target = {};
      recalculatePrice();
    }
    function normalizeIncludedItem(item = {}) {
      const target = item.target || {};
      const productId = String(item.productId || item.albumId || item.peripheralId || target.albumId || target.peripheralId || target.productId || target.id || "");
      const option = productOptions(item.type).find((entry) => entry.id === productId) || productOptions(item.type).find((entry) => entry.name === item.name);
      return { ...clone(item), ...(option ? { productId: option.id, name: option.name, price: option.price, spotId: option.spotId, spotIds: option.spotIds, target: clone(option.target) } : { productId }), quantity: Number(item.quantity ?? item.qty ?? 1) };
    }
    function sumItems(items = []) {
      return items.reduce((sum, item) => sum + Math.round(Number(item.price || 0) * 100) * Number(item.quantity ?? 1), 0) / 100;
    }
    function recalculatePrice(force = false) {
      if (!form.value) return;
      form.value.originalPrice = sumItems(form.value.includedItems);
      if (force) form.value.priceManuallySet = false;
      if (!form.value.priceManuallySet) form.value.price = form.value.originalPrice;
    }
    function setManualPrice() { if (form.value) form.value.priceManuallySet = true; }
    function itemDetails(row = {}) {
      return (row.includedItems || row.items || []).map((item) => `${({ album: "照片留影", video: "视频摄像", peripheral: "影像周边" })[item.type] || "商品"} · ${item.name || "未选择"} × ${item.quantity ?? 1}`).join("；");
    }
    function formSpotNames() {
      return packageSpotNames({ includedItems: form.value?.includedItems || [] });
    }
    function buildRecord(source, original = null) {
      const includedItems = (source.includedItems || []).map(normalizeIncludedItem);
      const spotIds = [...new Set(includedItems.flatMap((item) => item.spotIds || [item.spotId]).filter(Boolean).map(String))];
      const price = Math.max(0, Number(source.price || 0));
      const originalPrice = sumItems(includedItems);
      const ratioInput = Number(source.depositRatio);
      // 表单使用百分数，存储使用 0–1 比例，避免 1% 被读取为 100%。
      const depositRatio = Number.isFinite(ratioInput)
        ? Math.min(100, Math.max(0, ratioInput)) / 100
        : 0.3;
      const description = String(source.description ?? source.intro ?? "").trim();
      const tags = normalizeTagInput(source.tagText);
      const id = source.id || `pkg_${Date.now().toString(36)}`;
      const record = {
        ...(original ? clone(original) : {}),
        id,
        _id: id,
        name: String(source.name || "").trim(),
        type: "photo",
        productType: "photo",
        serviceType: "photo",
        category: "photo_package",
        cover: String(source.cover || "").trim(),
        price,
        specialPrice: price,
        originalPrice,
        includedItems,
        items: includedItems.map(clone),
        priceManuallySet: source.priceManuallySet === true,
        depositRatio,
        description,
        intro: description,
        shootingNotes: String(source.shootingNotes ?? "").trim(),
        spotIds,
        spotId: spotIds[0] || "",
        seriesId: String(source.seriesId || ""),
        albumId: String(source.albumId || ""),
        tags,
        isShow: source.isShow !== false,
        status: source.isShow === false ? "下架" : "上架",
        auditStatus: source.isShow === false ? "已下" : "已上"
      };
      for (const key of ["enabled", "visible", "isSellable"]) if (key in record) record[key] = record.isShow;
      record.includedItems = (record.includedItems || []).map((item) => {
        const option = productOptions(item.type).find((candidate) => candidate.id === String(item.productId || item.id || ""))
          || productOptions(item.type).find((candidate) => candidate.name === item.name);
        return option ? { ...item, productId: option.id, name: option.name, price: option.price, target: option.target, spotId: option.spotId } : item;
      });
      record.items = record.includedItems.map((item) => clone(item));
      if (!spotIds.length && record.includedItems.length) {
        record.spotIds = [...new Set(record.includedItems.map((item) => String(item.spotId || "")).filter(Boolean))];
        record.spotId = record.spotIds[0] || "";
      }
      return record;
    }
    async function persist(record, previous = null) {
      if (typeof persistContentMutation !== "function") { notify("error", "服务端保存接口不可用，请刷新后重试"); return false; }
      return persistContentMutation("packages", record, previous);
    }
    async function saveForm() {
      if (!canEdit() || saving.value || !window.LXM_UPLOAD.ready()) return false;
      const source = form.value;
      if (!source) return;
      if (tagInput.value.trim() && !addTag()) return;
      if (!String(source.name || "").trim()) return notify("warning", "请填写套餐名称");
      if (!Number.isFinite(Number(source.price)) || Number(source.price) < 0) return notify("warning", "请填写正确的售价");
      if (!(source.includedItems || []).length) return notify("warning", "请至少选择一个组合商品");
      if (source.includedItems.some((item) => !item.productId || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1)) return notify("warning", "请为每项选择商品并填写大于零的整数数量");
      if (source.includedItems.some((item) => !productOptions(item.type).some((option) => option.id === String(item.productId)))) return notify("warning", "套餐中有已删除或不可用的商品，请移除后重新选择");
      if (!Number.isFinite(Number(source.depositRatio)) || Number(source.depositRatio) < 0 || Number(source.depositRatio) > 100) return notify("warning", "订金比例应为 0 到 100");
      const existing = source.id ? (data.packages || []).find((item) => rowId(item) === String(source.id)) : null;
      const previous = existing ? clone(existing) : null;
      const record = buildRecord(source, existing);
      saving.value = true;
      try {
        if (typeof ctx.ensureContentTags === "function" && !(await ctx.ensureContentTags(record, "packages"))) return false;
        if (existing) {
          Object.assign(existing, record);
          if (!(await persist(existing, previous))) {
            restoreRecord(existing, previous);
            return false;
          }
        } else {
          if (!(await persist(record, null))) return false;
          data.packages.unshift(record);
        }
        if (!existing) resetFilters();
        dialogVisible.value = false;
        resetEditor();
        notify("success", "套餐已保存，已返回列表");
        return true;
      } catch (error) {
        if (existing) restoreRecord(existing, previous);
        notify("error", error?.message || "套餐保存失败，请重试");
        return false;
      } finally {
        saving.value = false;
      }
    }
    async function toggleVisible(row) {
      if (!canEdit() || pendingIds.value.includes(rowId(row))) return;
      const source = (data.packages || []).find((item) => rowId(item) === rowId(row));
      if (!source) return;
      const previous = clone(source);
      const next = !(typeof ctx.contentManualVisible === "function" ? ctx.contentManualVisible(source) : isVisible(source));
      pendingIds.value.push(rowId(row));
      try {
        source.isShow = next;
        source.status = next ? "上架" : "下架";
        source.auditStatus = next ? "已上" : "已下";
        // 兼容旧数据中的展示别名，避免打开开关后仍被旧 false 值隐藏。
        for (const key of ["enabled", "visible", "isSellable"]) if (key in source) source[key] = next;
        if (await persist(source, previous)) {
          notify("success", next ? (isVisible(source) ? "套餐已开启，小程序可见" : "已开启展示，关联商品或打卡点不可见时套餐仍将隐藏") : "套餐已隐藏，小程序不可见");
        } else restoreRecord(source, previous);
      } catch (error) {
        restoreRecord(source, previous);
        notify("error", error?.message || "展示状态更新失败，请重试");
      } finally {
        pendingIds.value = pendingIds.value.filter((id) => id !== rowId(row));
      }
    }
    async function toggleMainPush(row) {
      if (!canEdit() || pendingIds.value.includes(rowId(row))) return;
      const source = (data.packages || []).find((item) => rowId(item) === rowId(row));
      if (!source) return;
      const previous = clone(source);
      pendingIds.value.push(rowId(row));
      try {
        source.isMainPush = !(source.isMainPush || source.mainPush);
        source.mainPush = source.isMainPush;
        if (await persist(source, previous)) notify("success", source.isMainPush ? "已设为首页主推" : "已取消首页主推");
        else restoreRecord(source, previous);
      } catch (error) {
        restoreRecord(source, previous);
        notify("error", error?.message || "主推状态更新失败，请重试");
      } finally {
        pendingIds.value = pendingIds.value.filter((id) => id !== rowId(row));
      }
    }
    async function refreshPackages() {
      if (loading.value || pendingIds.value.length || saving.value) return;
      if (!window.LXM_CLOUD || typeof window.LXM_CLOUD.getColl !== "function" || !window.LXM_AUTH?.hasSession?.()) {
        return notify("warning", "请登录后刷新真实套餐数据");
      }
      loading.value = true;
      try {
        const rows = await window.LXM_CLOUD.getColl("packages");
        const packages = (Array.isArray(rows) ? rows : []).filter(Boolean);
        data.packages.splice(0, data.packages.length, ...packages);
        notify("success", `已刷新 ${packages.filter((row) => row.type !== "video").length} 个套餐`);
      } catch (error) {
        notify("error", (error && error.message) || "套餐数据刷新失败");
      } finally {
        loading.value = false;
      }
    }
    function resetFilters() {
      keyword.value = "";
      spotFilter.value = "";
      visibilityFilter.value = "";
    }

    return {
      data, can, money, requestDeletePackage,
      loading, keyword, spotFilter, visibilityFilter, dialogVisible, saving, form, goodsSpotFilter,
      picker, tagInput, tagPresets, formTags, addTag, removeTag, pendingIds,
      cityOptions, pickerSpots, spotProductOptions, peripheralOptions, changePickerCity, changePickerSpot,
      addSpotProduct, addPeripheralProduct, groupItems, selectedQuantity, setItemQuantity, itemTypeLabel, itemLocation,
      addSpotProducts, addPeripheralProducts, isProductIncluded,
      manualVisible, visibilityHint, beforeDialogClose, resetEditor,
      tableRows, summary, canEdit, packageSpotNames, packageAlbumName, statusText,
      priceText, openCreate, openEdit, closeDialog, saveForm,
      uploadPackageCover: () => ctx.contentFile(form.value, "cover", "packages"),
      toggleVisible, toggleMainPush, refreshPackages, resetFilters,
      productOptions, filteredProductOptions, cardCover, packageSaving, previewVisible, addIncludedItem, removeIncludedItem, syncIncludedItem, resetIncludedItem,
      recalculatePrice, setManualPrice, itemDetails, formSpotNames
    };
  }
});
