// 照片留影：编辑草稿与商品列表分离，所有字段统一保存后生效。
window.LXM_PAGES.register({
  key: "albums", component: "LxmPageAlbum", group: "content", title: "Album",
  description: "Photo product management", styleScope: "page-route-album",
  setup(ctx) {
    const Vue = window.Vue;
    const {
      contentPhotographerOptions = Vue.ref([]), contentPhotographersLoading = Vue.ref(false),
      contentPhotographersError = Vue.ref(""), contentPhotographerName = () => "未设置",
      loadContentPhotographers = () => {}
    } = ctx;
    loadContentPhotographers();
    const tip = (message) => {
      const notify = window.ElementPlus?.ElMessage || window.ElMessage || ctx.ElMessage || ctx.toast;
      if (notify) notify(message);
    };
    const clone = (row) => JSON.parse(JSON.stringify(row));
    const idOf = (row) => String(row && (row.id || row._id) || "");
    const emptyDeposit = (value) => value === null || value === undefined || typeof value === "string" && value.trim() === "";
    function albumDepositPercent(row = {}) {
      const value = Object.prototype.hasOwnProperty.call(row, "depositRatio") ? row.depositRatio : row.depositRate ?? row.depositPercent ?? row.depositPercentage;
      if (emptyDeposit(value) || !["number", "string"].includes(typeof value)) return undefined;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 100) return undefined;
      return Number((number <= 1 ? number * 100 : number).toFixed(6));
    }
    function albumDepositLabel(row = {}, draft = false) {
      const percent = draft ? row.depositRatioPercent : albumDepositPercent(row);
      return emptyDeposit(percent) ? "使用全局比例" : `${percent}%`;
    }
    const selectedAlbumId = Vue.ref("");
    const selectedAlbum = Vue.ref(null);
    const editorOpen = Vue.ref(false);
    const creating = Vue.ref(false);
    const remoteOn = Vue.ref(true);
    const remoteLoading = Vue.ref(false);
    const saving = Vue.ref(false);
    const viewMode = Vue.ref("cards");
    const selectedPhotoUrls = Vue.ref([]);
    const photoUploadBusy = Vue.computed(() => !!window.LXM_UPLOAD?.busy?.());
    const photoCount = Vue.computed(() => selectedAlbum.value ? ctx.albumPhotoUrls(selectedAlbum.value).length : 0);
    const allPhotosSelected = Vue.computed(() => photoCount.value > 0 && ctx.albumPhotoUrls(selectedAlbum.value).every((url) => selectedPhotoUrls.value.includes(url)));
    const remoteError = Vue.ref("");
    const serverConnected = () => typeof ctx.isServerConnected === "function" ? ctx.isServerConnected()
      : !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE === "mysql" && window.LXM_API_STATE?.reachable === true);
    const listSource = Vue.computed(() => Vue.unref(ctx.albumRows) || []);
    const selectedSource = Vue.computed(() => creating.value ? null : (ctx.data.albums || []).find((row) => !row.deleted && !row.isDeleted && idOf(row) === selectedAlbumId.value) || listSource.value[0] || null);

    function resetAlbumDraft() {
      if (saving.value || photoUploadBusy.value) return;
      selectedPhotoUrls.value = [];
      const source = selectedSource.value;
      if (!source) { selectedAlbum.value = null; return; }
      const draft = clone(source);
      draft.recommendedPhotographerId = String(draft.recommendedPhotographerId || "");
      draft.shootingNotes = String(draft.shootingNotes ?? draft.intro ?? "");
      draft.tags = Array.isArray(draft.tags) ? draft.tags.slice() : String(draft.tags || "").split(/[，,、|\n]/).map((tag) => tag.trim()).filter(Boolean);
      draft.retouchMode = typeof ctx.albumRetouchMode === "function" ? ctx.albumRetouchMode(draft)
        : ["count", "included", "excluded"].includes(draft.retouchMode) ? draft.retouchMode : Number(draft.retouchCount) > 0 ? "count" : "excluded";
      draft.makeupIncluded = draft.makeupIncluded === true;
      draft.photoCountText = photoCountLabel(source);
      draft.retouchText = retouchLabel(source);
      draft.makeupText = makeupLabel(source);
      draft.seriesId = String(draft.seriesId || draft.seriesName || "");
      draft.photoCount = ctx.albumPhotoUrls(draft).length;
      draft.depositRatioPercent = albumDepositPercent(source);
      if (typeof ctx.hydrateProductSpot === "function") ctx.hydrateProductSpot(draft);
      draft.spotId = String(draft.spotId || (draft.spotIds || [])[0] || "");
      draft.spotBindingExplicit = true;
      draft.isShow = draft.isShow !== false;
      draft.isSellable = draft.isSellable !== false;
      draft.allowMaterialUse = draft.allowMaterialUse !== false;
      // 派生可见性仅用于已保存记录，预览按当前草稿重新计算。
      delete draft.effectiveVisible;
      delete draft.visibilityReasons;
      selectedAlbum.value = draft;
    }
    resetAlbumDraft();
    Vue.watch(selectedSource, () => { if (!creating.value) resetAlbumDraft(); });
    function selectAlbum(row) { if (!saving.value && !photoUploadBusy.value && row) { creating.value = false; selectedAlbumId.value = idOf(row); resetAlbumDraft(); editorOpen.value = true; } }
    function createAlbum() {
      if (!ctx.can("contentEdit") || saving.value || photoUploadBusy.value) return;
      creating.value = true;
      selectedPhotoUrls.value = [];
      selectedAlbum.value = { name: "", recommendedPhotographerId: "", seriesId: "", seriesName: "", tags: [], sampleUrls: [], cover: "", shootingNotes: "", price: 0, depositRatioPercent: undefined, photoCount: 0, photoCountText: "", retouchText: "", makeupText: "", retouchMode: "excluded", retouchCount: 0, makeupIncluded: false, spotId: "", spotIds: [], spotBindingExplicit: true, isShow: false, isSellable: true, allowMaterialUse: true };
      ctx.applyAlbumShootingTemplate?.(selectedAlbum.value);
      editorOpen.value = true;
    }
    function closeEditor() { if (!saving.value && !photoUploadBusy.value) { editorOpen.value = false; creating.value = false; resetAlbumDraft(); } }
    function isSelected(row) { return idOf(selectedSource.value) === idOf(row); }
    function changeAlbumSpot() {
      const draft = selectedAlbum.value;
      if (!draft) return;
      draft.spotIds = draft.spotId ? [String(draft.spotId)] : [];
      draft.spotBindingExplicit = true;
      if (typeof ctx.markContentSpotChange === "function") ctx.markContentSpotChange(draft);
    }
    function photoCountLabel(row = {}) {
      return typeof row.photoCountText === "string" && row.photoCountText.trim() || `${Number(row.photoCount) || 0} 张照片`;
    }
    function makeupLabel(row = {}) {
      return typeof row.makeupText === "string" && row.makeupText.trim() || (row.makeupIncluded === true ? "包含" : "不包含");
    }
    function retouchLabel(row = {}) {
      if (typeof row.retouchText === "string" && row.retouchText.trim()) return row.retouchText.trim();
      const mode = row.retouchMode || (Number(row.retouchCount) > 0 ? "count" : row.retouchIncluded === true ? "included" : "excluded");
      return mode === "included" ? "包含修图" : mode === "excluded" ? "不含修图" : "修图 " + Number(row.retouchCount || 0) + " 张";
    }
    function previewVisible(row) {
      const preview = { ...row, status: row.isShow === false ? "下架" : "上架", spotIds: row.spotId ? [String(row.spotId)] : [], spotBindingExplicit: true };
      return typeof ctx.contentEffectiveVisible === "function" ? ctx.contentEffectiveVisible(preview) : row.isShow !== false;
    }
    const activeSeries = () => (ctx.data.series || []).filter((row) => !row.deleted && !row.isDeleted);
    const albumSeriesOptions = Vue.computed(() => {
      const options = activeSeries().map((row) => ({ value: idOf(row), label: String(row.name || "") }));
      const names = new Set(options.map((option) => option.label));
      for (const name of (ctx.data.albums || []).filter((row) => !row.deleted && !row.isDeleted).map((row) => row.seriesName)) {
        const label = String(name || "").trim();
        if (label && !names.has(label)) { names.add(label); options.push({ value: label, label }); }
      }
      return options;
    });
    function albumSeriesLabel(row) {
      if (!row) return "未设置";
      const series = activeSeries().find((item) => idOf(item) === String(row.seriesId || ""));
      return String(series?.name || row.seriesName || row.seriesId || "未设置");
    }
    function changeAlbumSeries(value) {
      if (!selectedAlbum.value || !ctx.can("contentEdit") || saving.value || photoUploadBusy.value) return;
      const series = activeSeries().find((row) => idOf(row) === String(value || ""));
      selectedAlbum.value.seriesName = String(series?.name || value || "").trim();
    }
    function uploadAlbumPhotos(directory = false) {
      if (!selectedAlbum.value || !ctx.can("contentEdit") || saving.value || photoUploadBusy.value) return;
      ctx.contentFile(selectedAlbum.value, "sampleUrls", "albums", false, true, directory);
    }
    function togglePhotoSelection(url, checked) {
      if (saving.value || photoUploadBusy.value || !ctx.can("contentEdit") || !selectedAlbum.value || !ctx.albumPhotoUrls(selectedAlbum.value).includes(url)) return;
      selectedPhotoUrls.value = checked ? [...new Set([...selectedPhotoUrls.value, url])] : selectedPhotoUrls.value.filter((item) => item !== url);
    }
    function toggleAllPhotos(checked) {
      if (saving.value || photoUploadBusy.value || !ctx.can("contentEdit")) return;
      selectedPhotoUrls.value = checked && selectedAlbum.value ? ctx.albumPhotoUrls(selectedAlbum.value).slice() : [];
    }
    function removePhoto(url) {
      if (saving.value || photoUploadBusy.value || !ctx.can("contentEdit") || !selectedAlbum.value) return;
      ctx.removeAlbumPhoto(selectedAlbum.value, url);
      selectedPhotoUrls.value = selectedPhotoUrls.value.filter((item) => item !== url);
    }
    function removeSelectedPhotos() {
      if (saving.value || photoUploadBusy.value || !ctx.can("contentEdit") || !selectedAlbum.value) return;
      selectedPhotoUrls.value.forEach((url) => ctx.removeAlbumPhoto(selectedAlbum.value, url));
      selectedPhotoUrls.value = [];
    }
    Vue.watch(() => selectedAlbum.value && ctx.albumPhotoUrls(selectedAlbum.value).join("\n"), () => {
      if (selectedAlbum.value) selectedAlbum.value.photoCount = photoCount.value;
      selectedPhotoUrls.value = selectedPhotoUrls.value.filter((url) => selectedAlbum.value && ctx.albumPhotoUrls(selectedAlbum.value).includes(url));
    });
    const albumTagOptions = Vue.computed(() => {
      const names = ["主推", "爆款", "新品", ...(typeof ctx.tagOptions === "function" ? ctx.tagOptions().map((row) => row.name) : []),
        ...(ctx.data.albums || []).filter((row) => !row.deleted && !row.isDeleted).flatMap((row) => Array.isArray(row.tags) ? row.tags : [])];
      return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))];
    });
    async function refreshFromServer() {
      if (saving.value || photoUploadBusy.value) return false;
      remoteLoading.value = true;
      remoteError.value = "";
      try {
        const list = await LXM_API.loadCollection("albums");
        if (!Array.isArray(list)) throw new Error("后端未返回有效的照片留影列表");
        ctx.data.albums = list.filter((row) => row && !row.deleted && !row.isDeleted);
        remoteOn.value = true;
        LXM_API.setRemote(true);
        resetAlbumDraft();
        tip("已载入 " + ctx.data.albums.length + " 条照片留影商品");
        return true;
      } catch (error) {
        remoteError.value = error.message || "请稍后重试";
        tip("载入失败：" + remoteError.value);
        return false;
      } finally { remoteLoading.value = false; }
    }
    function toggleRemote(event) {
      if (saving.value || photoUploadBusy.value) return;
      if (event?.target) event.target.checked = true;
      remoteOn.value = true;
      LXM_API.setRemote(true);
      return refreshFromServer();
    }
    async function saveSelectedAlbum() {
      if (saving.value || photoUploadBusy.value || !selectedAlbum.value || !ctx.can("contentEdit")) return false;
      if (!serverConnected() || remoteError.value || remoteLoading.value) return tip("真实后端连接不可用，请刷新后重试");
      if (window.LXM_UPLOAD?.ready && !window.LXM_UPLOAD.ready()) return false;
      const source = selectedSource.value;
      const payload = clone(selectedAlbum.value);
      payload.recommendedPhotographerId = String(payload.recommendedPhotographerId || "");
      const previous = source ? clone(source) : null;
      payload.name = String(payload.name || "").trim();
      if (!payload.name) return tip("请填写照片留影名称");
      payload.tags = [...new Set((Array.isArray(payload.tags) ? payload.tags : typeof payload.tags === "string" ? payload.tags.split(/[，,、|\r\n]/) : [])
        .filter((tag) => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))];
      if (!payload.tags.length) return tip("请至少添加一个标签");
      payload.sampleUrls = ctx.albumPhotoUrls(payload);
      payload.photoCount = payload.sampleUrls.length;
      if (!payload.photoCount) return tip("请至少上传一张商品照片");
      if (!payload.sampleUrls.includes(payload.cover)) ctx.setAlbumCover(payload, payload.sampleUrls[0]);
      if (payload.price === null || payload.price === "" || !Number.isFinite(Number(payload.price)) || Number(payload.price) < 0) return tip("请填写有效的商品价格");
      payload.price = Number(payload.price);
      for (const [field, label] of [["photoCountText", "照片张数"], ["retouchText", "修图"], ["makeupText", "妆造"]]) {
        payload[field] = String(payload[field] ?? "").trim();
        if (payload[field].length > 160) return tip(`${label}不能超过160个字符`);
      }
      const depositPercent = selectedAlbum.value.depositRatioPercent;
      if (!emptyDeposit(depositPercent) && (!["number", "string"].includes(typeof depositPercent) || !Number.isFinite(Number(depositPercent)) || Number(depositPercent) < 0 || Number(depositPercent) > 100)) {
        tip("定金比例应为 0 到 100，或留空使用全局比例");
        return false;
      }
      payload.depositRatio = emptyDeposit(depositPercent) ? null : Number(depositPercent) / 100;
      for (const alias of ["depositRatioPercent", "depositRate", "depositPercent", "depositPercentage"]) delete payload[alias];
      const selectedSeries = activeSeries().find((row) => idOf(row) === String(payload.seriesId || ""));
      payload.seriesName = String(selectedSeries?.name || payload.seriesId || payload.seriesName || "").trim();
      payload.seriesId = selectedSeries ? idOf(selectedSeries) : "";
      if (payload.seriesName.length > 160) return tip("风格系列名称不能超过160个字");
      if (!payload.id && !payload._id) { payload.id = `album_${Date.now().toString(36)}`; payload._id = payload.id; }
      payload.shootingNotes = String(payload.shootingNotes || "").trim();
      payload.intro = payload.shootingNotes;
      payload.spotIds = payload.spotId ? [String(payload.spotId)] : [];
      payload.spotBindingExplicit = true;
      payload.status = payload.isShow ? "上架" : "下架";
      payload.auditStatus = payload.isShow ? "已上" : "已下";
      delete payload.summary;
      delete payload.originalPrice;
      delete payload.specialPrice;
      saving.value = true;
      try {
        const ok = typeof ctx.persistContentMutation === "function"
          ? await ctx.persistContentMutation("albums", payload, previous)
          : !!(await LXM_API.saveDoc("albums", payload));
        if (!ok) return false;
        if (source) {
          Object.keys(source).forEach((key) => { if (!(key in payload) && key !== "summary") delete source[key]; });
          Object.assign(source, payload);
        } else {
          ctx.data.albums.unshift(payload);
          ctx.clearContentFilters?.();
        }
        selectedAlbumId.value = idOf(payload);
        creating.value = false;
        editorOpen.value = false;
        // Saving is still locked; rebuild the selected draft after releasing the lock.
        tip("照片留影已保存到后端");
        return true;
      } catch (error) { tip("保存失败：" + error.message); return false; }
      finally { saving.value = false; if (!editorOpen.value) resetAlbumDraft(); }
    }
    return {
      contentPhotographerOptions, contentPhotographersLoading, contentPhotographersError, contentPhotographerName, loadContentPhotographers,
      selectedAlbumId, selectedAlbum, selectedSource, listSource, remoteOn, remoteLoading, remoteError, saving, editorOpen, creating, createAlbum, closeEditor,
      viewMode, selectedPhotoUrls, allPhotosSelected, togglePhotoSelection, toggleAllPhotos, removeSelectedPhotos, removePhoto, photoCount, uploadAlbumPhotos, photoUploadBusy,
      albumSeriesOptions, albumSeriesLabel, changeAlbumSeries, albumDepositLabel,
      albumTagOptions, photoCountLabel, retouchLabel, makeupLabel, previewVisible, isSelected, selectAlbum, changeAlbumSpot, resetAlbumDraft, refreshFromServer, toggleRemote, saveSelectedAlbum
    };
  }
});
