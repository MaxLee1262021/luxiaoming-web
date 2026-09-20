// 旅拍套餐管理：只保留小程序实际消费的商品字段，使用表格完成日常维护。
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
    const spotFilter = Vue.ref("");
    const visibilityFilter = Vue.ref("");
    const dialogVisible = Vue.ref(false);
    const saving = Vue.ref(false);
    const form = Vue.ref(null);

    function rowId(row = {}) { return String(row.id || row._id || ""); }
    function clone(value) {
      try { return structuredClone(value); }
      catch (_) { return JSON.parse(JSON.stringify(value || {})); }
    }
    function tagsOf(row = {}) {
      const raw = Array.isArray(row.serviceTags) ? row.serviceTags : (Array.isArray(row.tags) ? row.tags : []);
      return raw.map((item) => String(item || "").trim()).filter(Boolean);
    }
    function spotIdsOf(row = {}) {
      const ids = [
        ...(Array.isArray(row.spotIds) ? row.spotIds : []),
        row.spotId
      ].filter(Boolean).map(String);
      return [...new Set(ids)];
    }
    function isVisible(row = {}) {
      if (!row || row.deleted || row.isDeleted || row.isShow === false) return false;
      if (["下架", "草稿", "待审", "待审核", "驳回", "停用"].includes(String(row.status || ""))) return false;
      const auditStatus = String(row.auditStatus || row.reviewStatus || "");
      return !auditStatus || ["已上", "已上架", "审核通过", "通过", "approved", "pass", "passed", "published", "online"].includes(auditStatus);
    }
    function normalizeRow(row = {}) {
      const source = row && typeof row === "object" ? row : {};
      const ids = spotIdsOf(source);
      const description = String(source.description || source.intro || "").trim();
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
        serviceTags,
        depositRatio,
        tags: Array.isArray(source.tags) && source.tags.length ? source.tags : serviceTags.slice(),
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
      const price = Number(row.price || row.specialPrice || 0);
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
        return [row.name, row.description, tagsOf(row).join("、"), packageSpotNames(row), packageAlbumName(row)]
          .join(" ").toLowerCase().includes(term);
      });
    });
    const summary = Vue.computed(() => {
      const rows = currentRows();
      return {
        total: rows.length,
        visible: rows.filter(isVisible).length,
        mainPush: rows.filter((row) => row.isMainPush).length
      };
    });

    function buildForm(row = null) {
      const source = row ? normalizeRow(row) : {
        id: "", name: "", cover: "", price: 0, originalPrice: 0,
        description: "", spotIds: [], spotId: "", seriesId: "", albumId: "",
        serviceTags: [], depositRatio: 30, isShow: true, isMainPush: false, includedItems: []
      };
      return {
        ...clone(source),
        serviceTagsText: tagsOf(source).join("、"),
        spotIds: spotIdsOf(source),
        isShow: isVisible(source)
      };
    }
    function openCreate() {
      form.value = buildForm();
      dialogVisible.value = true;
    }
    function openEdit(row) {
      form.value = buildForm(row);
      dialogVisible.value = true;
    }
    function closeDialog() {
      if (!saving.value) dialogVisible.value = false;
    }
    function normalizeTagInput(value) {
      return [...new Set(String(value || "").split(/[，,、|\n]/).map((item) => item.trim()).filter(Boolean))];
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
    function buildRecord(source, original = null) {
      const spotIds = [...new Set((Array.isArray(source.spotIds) ? source.spotIds : []).filter(Boolean).map(String))];
      const price = Math.max(0, Number(source.price || 0));
      const originalPrice = Math.max(0, Number(source.originalPrice || 0));
      const ratioInput = Number(source.depositRatio);
      const depositRatio = Number.isFinite(ratioInput)
        ? Math.min(100, Math.max(0, ratioInput <= 1 ? ratioInput * 100 : ratioInput))
        : 30;
      const description = String(source.description || source.intro || "").trim();
      const serviceTags = normalizeTagInput(source.serviceTagsText);
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
        depositRatio,
        description,
        intro: description,
        spotIds,
        spotId: spotIds[0] || "",
        seriesId: String(source.seriesId || ""),
        albumId: String(source.albumId || ""),
        serviceTags,
        tags: serviceTags.slice(),
        isShow: source.isShow !== false,
        isMainPush: source.isMainPush === true,
        mainPush: source.isMainPush === true,
        status: source.isShow === false ? "下架" : "上架",
        auditStatus: source.isShow === false ? "已下" : "已上"
      };
      const previousAlbumId = original && String(original.albumId || "");
      if (!Array.isArray(record.includedItems) || !record.includedItems.length || previousAlbumId !== record.albumId) {
        record.includedItems = createAlbumItem(record);
        record.items = record.includedItems.map((item) => clone(item));
      }
      return record;
    }
    async function persist(record, previous = null) {
      if (typeof persistContentMutation !== "function") return true;
      return persistContentMutation("packages", record, previous);
    }
    async function saveForm() {
      if (saving.value || !window.LXM_UPLOAD.ready()) return;
      const source = form.value;
      if (!source) return;
      if (!String(source.name || "").trim()) return notify("warning", "请填写套餐名称");
      if (!Number.isFinite(Number(source.price)) || Number(source.price) < 0) return notify("warning", "请填写正确的售价");
      const existing = source.id ? (data.packages || []).find((item) => rowId(item) === String(source.id)) : null;
      const previous = existing ? clone(existing) : null;
      const record = buildRecord(source, existing);
      saving.value = true;
      try {
        if (existing) {
          Object.assign(existing, record);
          if (!(await persist(existing, previous))) {
            Object.assign(existing, previous);
            return;
          }
        } else {
          if (!(await persist(record, null))) return;
          data.packages.unshift(record);
        }
        dialogVisible.value = false;
        notify("success", "套餐已保存，小程序将读取最新内容");
      } finally {
        saving.value = false;
      }
    }
    async function toggleVisible(row) {
      const source = (data.packages || []).find((item) => rowId(item) === rowId(row));
      if (!source) return;
      const previous = clone(source);
      const next = !isVisible(source);
      source.isShow = next;
      source.status = next ? "上架" : "下架";
      source.auditStatus = next ? "已上" : "已下";
      if (await persist(source, previous)) notify("success", next ? "套餐已上架，小程序可见" : "套餐已下架，小程序不可见");
      else Object.assign(source, previous);
    }
    async function toggleMainPush(row) {
      const source = (data.packages || []).find((item) => rowId(item) === rowId(row));
      if (!source) return;
      const previous = clone(source);
      source.isMainPush = !source.isMainPush;
      source.mainPush = source.isMainPush;
      if (await persist(source, previous)) notify("success", source.isMainPush ? "已设为首页主推" : "已取消首页主推");
      else Object.assign(source, previous);
    }
    async function refreshPackages() {
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
      loading, keyword, spotFilter, visibilityFilter, dialogVisible, saving, form,
      tableRows, summary, canEdit, packageSpotNames, packageAlbumName, statusText,
      priceText, openCreate, openEdit, closeDialog, saveForm,
      uploadPackageCover: () => ctx.contentFile(form.value, "cover", "packages"),
      toggleVisible, toggleMainPush, refreshPackages, resetFilters
    };
  }
});
