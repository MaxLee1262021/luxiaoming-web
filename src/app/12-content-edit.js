// 内容编辑、云端写回与首页装修
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    activeMenu,
    albumName,
    cityById,
    cityName,
    computed,
    contentKeys,
    contentList,
    currentOperatorName,
    data,
    effectiveContentKey,
    log,
    markProductAudit,
    money,
    openProduct,
    packageAuditText,
    packagesBySeries,
    persistTrashRecord,
    peripheralModeText,
    productStatus,
    seriesName,
    shelfRowKey,
    shelfRows,
    sameCity,
    spotName,
    state,
    switchMenu
  } = ctx;

// Home package cards reserve three title lines: 260rpx / 28rpx = 9 characters per line.
const PACKAGE_TITLE_LIMIT = 27;
function normalizePackageTitle(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function packageTitleLength(value) { return normalizePackageTitle(value).length; }
function isPackageTitleLimited(row = {}) {
  if (row.__key && row.__key !== "packages") return false;
  if (row.isVideoSingle === true || row.productKind === "video_single") return false;
  if (row.isVideoSingle === false || ["package", "bundle"].includes(row.productKind)
    || [row.includedItems, row.items].some((items) => Array.isArray(items) && items.length)) return true;
  return ![row.type, row.serviceType, row.productType].some((value) => /video|视频/.test(String(value || "")));
}
function packageTitleError(row, previous = null) {
  if (!isPackageTitleLimited(row)) return "";
  const visible = (value) => typeof ctx.contentManualVisible === "function" ? ctx.contentManualVisible(value)
    : value && value.isShow !== false && !["草稿", "下架", "停用", "隐藏", "已隐藏", "已下架"].includes(value.status);
  const changed = !previous || normalizePackageTitle(row.name) !== normalizePackageTitle(previous.name);
  const publishing = previous && !visible(previous) && visible(row);
  return (changed || publishing) && packageTitleLength(row.name) > PACKAGE_TITLE_LIMIT
    ? `套餐名称最多 ${PACKAGE_TITLE_LIMIT} 个字符，请缩短至首页三行以内` : "";
}

// 商品编辑仅使用摄影师姓名投影，不依赖派单或分成管理权限。
state.contentPhotographers = { rows: [], loading: false, error: "" };
const contentPhotographerOptions = computed(() => state.contentPhotographers.rows);
const contentPhotographersLoading = computed(() => state.contentPhotographers.loading);
const contentPhotographersError = computed(() => state.contentPhotographers.error);
let contentPhotographersRequest = null;
let contentPhotographersEpoch = 0;
function clearContentPhotographers() {
  contentPhotographersEpoch += 1;
  contentPhotographersRequest = null;
  state.contentPhotographers = { rows: [], loading: false, error: "" };
}
function contentPhotographerName(row = {}) {
  const id = String(row.recommendedPhotographerId || "");
  if (!id) return "未设置";
  return contentPhotographerOptions.value.find((item) => item.id === id)?.name
    || row.recommendedPhotographerName || "摄影师档案不可用";
}
function loadContentPhotographers() {
  if (!window.LXM_AUTH?.hasSession?.()) return Promise.resolve(false);
  if (contentPhotographersRequest) return contentPhotographersRequest;
  const epoch = contentPhotographersEpoch;
  state.contentPhotographers.loading = true;
  state.contentPhotographers.error = "";
  const base = String(window.LXM_API_CONFIG?.base || "/api").replace(/\/$/, "");
  contentPhotographersRequest = Promise.resolve().then(async () => {
    try {
      const response = await window.LXM_HTTP.request(`${base}/content/photographers`);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || body?.msg || "摄影师名单加载失败");
      if (!Array.isArray(body?.rows)) throw new Error("摄影师名单返回格式无效");
      if (epoch !== contentPhotographersEpoch) return false;
      state.contentPhotographers.rows = body.rows.filter((item) => item && item.id && item.name)
        .map((item) => ({ id: String(item.id), name: String(item.name) }));
      return true;
    } catch (error) {
      if (epoch === contentPhotographersEpoch) state.contentPhotographers.error = error.message || "摄影师名单加载失败";
      return false;
    } finally {
      if (epoch === contentPhotographersEpoch) {
        state.contentPhotographers.loading = false;
        contentPhotographersRequest = null;
      }
    }
  });
  return contentPhotographersRequest;
}

function contentCover(title, subtitle) {
  return "/images/placeholder.png";
}

const DEFAULT_AMAP_CENTER = { longitude: 112.938814, latitude: 28.228209, coordType: "gcj02" };
const spotDraftSort = new WeakMap();
let amapPickerController = null;
let amapPickerRequest = 0;
let amapPickerSearchRequest = 0;

function coordinateNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function gcjCoordinate(value) {
  if (!value || String(value.coordType || "gcj02").toLowerCase() !== "gcj02") return null;
  const latitude = coordinateNumber(value.latitude);
  const longitude = coordinateNumber(value.longitude);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, coordType: "gcj02" };
}

function amapPickerCoordinateText(position = state.amapPicker && state.amapPicker.selection) {
  const latitude = coordinateNumber(position && position.latitude);
  const longitude = coordinateNumber(position && position.longitude);
  if (latitude === null || longitude === null) return "尚未选择坐标";
  const coordType = String(position && position.coordType || "gcj02").toUpperCase().replace("GCJ02", "GCJ-02").replace("WGS84", "WGS-84").replace("BD09", "BD-09");
  return `经 ${longitude.toFixed(6)}，纬 ${latitude.toFixed(6)} · ${coordType}`;
}

function amapPickerAddressText() {
  if (state.amapPicker.resolvingAddress) return "正在解析详细地址";
  return String(state.amapPicker.address || "").trim() || "尚未解析详细地址";
}

function amapCoordinateSystemText(record = {}) {
  const coordType = String(record.coordType || "gcj02").trim().toLowerCase();
  if (coordType === "gcj02") return "GCJ-02（微信/高德地图）";
  const name = coordType === "wgs84" ? "WGS-84" : coordType === "bd09" ? "BD-09" : coordType.toUpperCase();
  return `历史坐标：${name}（请地图重新选点）`;
}

function destroyAmapPicker() {
  if (!amapPickerController) return;
  try { amapPickerController.destroy(); } catch (_) {}
  amapPickerController = null;
}

function resetAmapPickerState() {
  amapPickerSearchRequest += 1;
  Object.assign(state.amapPicker, {
    loading: false,
    error: "",
    selection: null,
    address: "",
    district: "",
    resolvingAddress: false,
    searchKeyword: "",
    searching: false,
    searchError: "",
    searchResults: []
  });
}

function amapPickerFallbackCenter() {
  const source = state.editContent || {};
  const city = cityById(source.cityId || source.city) || {};
  return gcjCoordinate(city) || DEFAULT_AMAP_CENTER;
}

function amapPickerSearchCity() {
  const source = state.editContent || {};
  const city = cityById(source.cityId || source.city) || {};
  return String(city.name || source.city || "").trim();
}

function amapPickerSearchResultText(place) {
  const values = [place && place.address, place && place.district, place && place.city]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(values)].join(" · ") || "可定位地点";
}

function clearAmapPickerSearchResults() {
  amapPickerSearchRequest += 1;
  state.amapPicker.searching = false;
  state.amapPicker.searchError = "";
  state.amapPicker.searchResults = [];
}

async function searchAmapPicker() {
  const keyword = String(state.amapPicker.searchKeyword || "").trim();
  const controller = amapPickerController;
  if (!keyword) {
    clearAmapPickerSearchResults();
    return;
  }
  if (!controller || typeof controller.searchPlaces !== "function") {
    state.amapPicker.searchError = "地图尚未准备好，请稍后重试。";
    return;
  }

  const request = ++amapPickerSearchRequest;
  Object.assign(state.amapPicker, { searching: true, searchError: "", searchResults: [] });
  try {
    const results = await controller.searchPlaces(keyword);
    if (request !== amapPickerSearchRequest || !state.amapPicker.open || controller !== amapPickerController) return;
    const searchResults = Array.isArray(results) ? results : [];
    Object.assign(state.amapPicker, {
      searching: false,
      searchResults,
      searchError: searchResults.length ? "" : "未找到可定位的地点，请更换关键词或直接在地图上选点。"
    });
  } catch (error) {
    if (request !== amapPickerSearchRequest || !state.amapPicker.open || controller !== amapPickerController) return;
    Object.assign(state.amapPicker, {
      searching: false,
      searchResults: [],
      searchError: (error && error.userMessage) || "地点搜索失败，请更换关键词或直接在地图上选点。"
    });
  }
}

function selectAmapPickerSearchResult(place) {
  const controller = amapPickerController;
  if (!controller || typeof controller.selectSearchResult !== "function") {
    state.amapPicker.searchError = "地图尚未准备好，请稍后重试。";
    return;
  }
  try {
    controller.selectSearchResult(place);
    Object.assign(state.amapPicker, {
      searchKeyword: String(place && place.name || state.amapPicker.searchKeyword || "").trim(),
      searchError: "",
      searchResults: []
    });
  } catch (error) {
    state.amapPicker.searchError = (error && error.userMessage) || "无法定位该地点，请直接在地图上选点。";
  }
}

async function mountAmapPicker() {
  const picker = window.LXM_AMAP_PICKER;
  const request = ++amapPickerRequest;
  destroyAmapPicker();
  Object.assign(state.amapPicker, { loading: true, error: "" });

  if (!picker || typeof picker.mount !== "function") {
    state.amapPicker.loading = false;
    state.amapPicker.error = "高德地图模块未加载，仍可手动填写经纬度。";
    return;
  }

  const status = typeof picker.getStatus === "function" ? picker.getStatus() : {};
  if (!status.enabled || !status.configured) {
    state.amapPicker.loading = false;
    const reason = window.LXM_AMAP_CONFIG && window.LXM_AMAP_CONFIG.reason;
    state.amapPicker.error = reason === "AMAP_PROXY_UNCONFIGURED"
      ? "高德地图安全代理未配置，仍可手动填写经纬度。"
      : "未配置高德地图 Key，仍可手动填写经纬度。";
    return;
  }

  await Vue.nextTick();
  const container = document.getElementById("lxm-amap-coordinate-picker");
  if (!container || !state.amapPicker.open || request !== amapPickerRequest) return;

  try {
    const current = gcjCoordinate(state.editContent);
    const controller = await picker.mount(container, {
      initialPosition: current,
      fallbackCenter: amapPickerFallbackCenter(),
      searchCity: amapPickerSearchCity(),
      onPick(position) {
        if (request !== amapPickerRequest || !state.amapPicker.open) return;
        amapPickerSearchRequest += 1;
        Object.assign(state.amapPicker, {
          selection: position,
          address: "",
          district: "",
          resolvingAddress: true,
          searching: false,
          searchError: "",
          searchResults: []
        });
      },
      onAddress(address) {
        if (request !== amapPickerRequest || !state.amapPicker.open) return;
        Object.assign(state.amapPicker, {
          address: String(address && address.address || "").trim(),
          district: String(address && address.district || "").trim(),
          resolvingAddress: false
        });
      },
      onAddressError() {
        if (request !== amapPickerRequest || !state.amapPicker.open) return;
        state.amapPicker.resolvingAddress = false;
      }
    });
    if (request !== amapPickerRequest || !state.amapPicker.open) {
      try { controller.destroy(); } catch (_) {}
      return;
    }
    amapPickerController = controller;
    state.amapPicker.selection = controller.getPosition() || current || null;
    state.amapPicker.loading = false;
    setTimeout(() => {
      if (request === amapPickerRequest && amapPickerController) amapPickerController.resize();
    }, 80);
  } catch (error) {
    if (request !== amapPickerRequest) return;
    destroyAmapPicker();
    state.amapPicker.loading = false;
    state.amapPicker.error = (error && error.userMessage) || "高德地图加载失败，仍可手动填写经纬度。";
  }
}

function openAmapPicker() {
  if (!state.editContent || state.editContent.__key !== "spots") return;
  Object.assign(state.amapPicker, {
    open: true,
    loading: false,
    error: "",
    selection: gcjCoordinate(state.editContent),
    address: "",
    district: "",
    resolvingAddress: false,
    searchKeyword: "",
    searching: false,
    searchError: "",
    searchResults: []
  });
  mountAmapPicker();
}

function retryAmapPicker() {
  if (!state.amapPicker.open) return;
  mountAmapPicker();
}

function closeAmapPicker() {
  amapPickerRequest += 1;
  amapPickerSearchRequest += 1;
  destroyAmapPicker();
  state.amapPicker.open = false;
}

function onAmapPickerClosed() {
  amapPickerRequest += 1;
  destroyAmapPicker();
  resetAmapPickerState();
}

function applyAmapPickerCoordinate() {
  const position = gcjCoordinate(state.amapPicker.selection);
  if (!position || !state.editContent) return ElMessage.warning("请先在地图上选择坐标");
  Object.assign(state.editContent, position);
  const address = String(state.amapPicker.address || "").trim();
  const district = String(state.amapPicker.district || "").trim();
  if (address) state.editContent.address = address;
  if (district) state.editContent.district = district;
  closeAmapPicker();
  ElMessage.success(address ? "已填充地图坐标和详细地址" : "已填充高德地图坐标");
}

function normalizeMapCoordinates(record, label) {
  const hasLatitude = record.latitude !== undefined && record.latitude !== null && String(record.latitude).trim() !== "";
  const hasLongitude = record.longitude !== undefined && record.longitude !== null && String(record.longitude).trim() !== "";
  if (hasLatitude !== hasLongitude) return label + "的经纬度需要同时填写";
  if (!hasLatitude) {
    record.latitude = null;
    record.longitude = null;
    record.coordType = String(record.coordType || "gcj02").toLowerCase();
    return "";
  }
  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return label + "纬度需在 -90 到 90 之间";
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return label + "经度需在 -180 到 180 之间";
  const coordType = String(record.coordType || "gcj02").toLowerCase();
  if (!["gcj02", "wgs84", "bd09"].includes(coordType)) return "请选择有效的坐标系";
  record.latitude = latitude;
  record.longitude = longitude;
  record.coordType = coordType;
  return "";
}

async function addTrash(key, source, previous, row) {
  if (await persistTrashRecord(row)) {
    if (window.LXM_AUTH?.hasSession?.() && typeof ctx.loadAuthenticatedData === "function") {
      await ctx.loadAuthenticatedData(state.active, { force: true });
      await ctx.loadAuthenticatedData("trash", { force: true });
    }
    return true;
  }
  Object.assign(source, previous);
  await persistContentMutation(key, source, previous);
  return false;
}

function isVideoSingleProduct(row) {
  if (!row || row.deleted === true || row.isDeleted === true) return false;
  if (window.LXM_CONTENT_ORDER) return window.LXM_CONTENT_ORDER.isVideoSingle(row);
  const video = [row.serviceType, row.type, row.productType, row.productKind, row.category]
    .some((value) => value !== undefined && value !== null && /video|短视频|视频/.test(String(value).trim().toLowerCase()));
  return video && (row.isVideoSingle === true || row.productKind === "video_single");
}
function filterVideoSingleRows(rows) {
  let list = (Array.isArray(rows) ? rows : []).filter(isVideoSingleProduct);
  const f = state.filters;
  if (f.contentSpotId) list = list.filter((row) => {
    const ids = typeof ctx.contentSpotIds === "function" ? ctx.contentSpotIds(row) : [row.spotId, ...(row.spotIds || [])].filter(Boolean).map(String);
    return ids.includes(String(f.contentSpotId));
  });
  if (f.contentSeriesId) list = list.filter((r) => r.seriesId === f.contentSeriesId || (r.seriesIds || []).includes(f.contentSeriesId));
  if (f.contentStatus) list = list.filter((r) => videoSingleStatus(r) === f.contentStatus || (r.status || (r.isShow === false ? "下架" : "上架")) === f.contentStatus);
  if (f.keyword) {
    const kw = (f.keyword || "").toLowerCase();
    list = list.filter((r) => (r.title || r.name || "").toLowerCase().includes(kw) || (r.tags || []).join(",").toLowerCase().includes(kw));
  }
  return ctx.sortedContentRows ? ctx.sortedContentRows("packages", list) : list;
}
const videoSingleRows = computed(() => filterVideoSingleRows(data.packages));
function videoSingleWriteAllowed() {
  if (!isServerConnected()) {
    ElMessage.warning("真实后端连接不可用，请恢复连接后重试");
    return false;
  }
  return true;
}
function videoSingleStatus(row) {
  if (row.status) return row.status;
  return row.isShow === false ? "下架" : "上架";
}
function contentVideoUrl(row = {}) {
  for (const value of [row.previewVideoUrl, row.videoUrl, ...(Array.isArray(row.videos) ? row.videos : [])]) {
    const media = typeof value === "string" ? { url: value } : value || {};
    const candidate = media.videoUrl || media.url || media.src;
    const url = typeof candidate === "string" ? candidate.trim() : "";
    const type = String(media.mediaType || media.mimeType || media.type || "").toLowerCase();
    if (url && !/\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic)(?:[?#]|$)|^data:image\//i.test(url) && !/^(?:image|photo)/.test(type)) return url;
  }
  return "";
}
function openVideoSingle(row = null) {
  // 短视频统一存进 packages 集合（type=video + isVideoSingle），小程序读 packages 作为视频商品，无需另接。
  state.videoSingleForm = row
    ? { ...row, __key: "packages", title: row.title || row.name, name: row.name || row.title, tags: Array.isArray(row.tags) ? [...row.tags] : [] }
    : { __key: "packages", id: `pkg_vs_${Date.now()}`, title: "", name: "", seriesId: "", spotId: "", videoUrl: "", previewVideoUrl: "", type: "video", productKind: "video_single", isVideoSingle: true, durationText: "", videoDuration: 0, finishedVideoCount: 1, hasAerial: false, fullEdit: true, makeupIncluded: false, deliveryCycle: "1–3 个工作日", shootingNotes: "", price: 0, status: "上架", isShow: true, isMainPush: false, tags: [], intro: "" };
  state.videoSingleForm.recommendedPhotographerId = String(row?.recommendedPhotographerId || "");
  loadContentPhotographers();
  state.videoSingleDialog = true;
  hydrateProductSpot(state.videoSingleForm);
}
async function saveVideoSingle() {
  if (!videoSingleWriteAllowed()) return false;
  const form = state.videoSingleForm;
  if (!form) return;
  if (!form.title && !form.name) return ElMessage.warning("请填写短视频名称");
  form.title = form.title || form.name;
  form.name = form.title;
  form.type = "video";
  form.isVideoSingle = true;
  form.productKind = "video_single";
  form.isShow = (form.status || "上架") === "上架";
  form.finishedVideoCount = Number(form.finishedVideoCount || 0);
  form.videoDuration = Number(form.videoDuration || 0);
  form.durationText = String(form.durationText || (form.videoDuration ? `${form.videoDuration}秒` : "")).trim();
  form.deliveryCycle = String(form.deliveryCycle || "1–3 个工作日").trim();
  form.shootingNotes = String(form.shootingNotes || form.intro || "").trim();
  normalizeSingleProduct(form, "packages");
  const source = data.packages.find((item) => (item.id || item._id) === (form.id || form._id));
  const validation = validateContentPublishing("packages", form, source, { forceTags: true });
  if (validation) { ElMessage.warning(validation); return false; }
  if (!(await ensureContentTags(form, "packages"))) return false;
  const previous = source ? { ...source } : null;
  const target = source || { ...form };
  if (source) {
    Object.assign(source, form);
  } else {
    data.packages.unshift(target);
  }
  if (!(await persistContentMutation("packages", target, previous))) {
    if (!source) data.packages = data.packages.filter((item) => item !== target);
    return false;
  }
  log(source ? "编辑短视频" : "新增短视频", "短视频", form.title);
  state.videoSingleDialog = false;
  ElMessage.success(source ? "已保存短视频" : "已新增短视频");
  return true;
}
async function deleteVideoSingle(row) {
  if (!videoSingleWriteAllowed()) return false;
  const source = data.packages.find((item) => (item.id || item._id) === (row.id || row._id)) || row;
  if (ctx.contentDeleteAllowed && !ctx.contentDeleteAllowed(source)) return false;
  if (!ctx.contentDeleteAllowed && (state.role !== "super" || (source.isShow !== false && !["草稿", "下架", "停用"].includes(source.status)))) {
    ElMessage.warning("仅超级管理员可删除已隐藏的视频商品");
    return false;
  }
  const previous = { ...source, deleted: source.deleted === true, isDeleted: source.isDeleted === true };
  source.deleted = true;
  source.isDeleted = true;
  source.isShow = false;
  source.status = "下架";
  if (!(await persistContentMutation("packages", source, previous))) return false;
  if (!(await addTrash("packages", source, previous, { id: `trash-vs-${source.id || source._id}-${Date.now()}`, type: "短视频", sourceKey: "packages", name: source.title || source.name, reason: "删除短视频", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } }))) return false;
  log("删除短视频进入回收站", "短视频", source.title || source.name);
  ElMessage.success("短视频已进入回收站，可由超管恢复");
  return true;
}
async function toggleVideoSingleShelf(row) {
  if (!videoSingleWriteAllowed()) return false;
  const source = data.packages.find((item) => (item.id || item._id) === (row.id || row._id)) || row;
  const previous = { ...source };
  const next = videoSingleStatus(source) === "下架";
  source.isShow = next;
  source.status = next ? "上架" : "下架";
  if (!(await persistContentMutation("packages", source, previous))) return false;
  log(next ? "短视频上架" : "短视频下架", "短视频", source.title || source.name);
  ElMessage.success(`${source.title || source.name} 已${next ? "上架" : "下架"}`);
  return true;
}
// ===== 拍摄风格：降级为分类词表管理（保留 seriesId 外键，去除内容实体属性）=====
function normalizeSeriesSpotRelations(row) {
  if (!row || typeof row !== "object") return row;
  const ids = [
    ...(Array.isArray(row.spotIds) ? row.spotIds : []),
    row.spotId
  ].filter(Boolean).map(String);
  row.spotIds = [...new Set(ids)];
  row.spotId = row.spotIds[0] || "";
  return row;
}
function openSeries(row = null) {
  state.seriesForm = row
    ? { ...row }
    : { id: `ser${Date.now()}`, name: "", style: "", intro: "", cover: contentCover("拍摄风格", "分类封面"), spotId: (data.spots[0] && data.spots[0].id) || "", spotIds: [(data.spots[0] && data.spots[0].id) || ""], productType: "photo", isHot: false, status: "启用" };
  normalizeSeriesSpotRelations(state.seriesForm);
  state.seriesDialog = true;
}
async function saveSeries() {
  const form = state.seriesForm;
  if (!form || !form.name) return ElMessage.warning("请填写拍摄风格名称");
  normalizeSeriesSpotRelations(form);
  const source = data.series.find((item) => item.id === form.id);
  const previous = source ? { ...source } : null;
  const target = source || { ...form };
  if (source) {
    Object.assign(source, form);
  } else {
    data.series.unshift(target);
  }
  if (!(await persistContentMutation("series", target, previous))) {
    if (!source) data.series = data.series.filter((item) => item !== target);
    return;
  }
  log(source ? "编辑拍摄风格" : "新增拍摄风格", "拍摄风格", form.name);
  state.seriesDialog = false;
  ElMessage.success(source ? "已保存拍摄风格" : "已新增拍摄风格");
}
async function requestDeleteSeries(row) {
  const refAlbums = data.albums.filter((a) => a.seriesId === row.id).length;
  const linkedPackageIds = new Set(Array.isArray(row.packageIds) ? row.packageIds.map(String) : []);
  const relatedPackages = [...new Map([
    ...packagesBySeries(row.id),
    ...(data.packages || []).filter((item) => linkedPackageIds.has(String(item.id || item._id || "")))
  ].map((item) => [String(item.id || item._id || ""), item])).values()];
  const refPackages = relatedPackages.filter((item) => item.type !== "video").length;
  const refVideos = relatedPackages.filter((item) => item.type === "video").length;
  if (refAlbums + refPackages + refVideos > 0) {
    return ElMessage.warning("该拍摄风格仍被引用：照片单品 " + refAlbums + "、套餐 " + refPackages + "、短视频 " + refVideos + "，不能直接删除");
  }
  const source = data.series.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  if (!(await persistContentMutation("series", source, previous))) return;
  if (!(await addTrash("series", source, previous, { id: `trash-ser-${source.id}-${Date.now()}`, type: "拍摄风格", sourceKey: "series", name: source.name, reason: "删除拍摄风格", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } }))) return;
  log("删除拍摄风格进入回收站", "拍摄风格", source.name);
  ElMessage.success("拍摄风格已进入回收站，可由超管恢复");
}

async function requestDeleteCity(row) {
  const source = data.cities.find((item) => item.id === row.id) || row;
  const refSpots = data.spots.filter((spot) => !spot.deleted && !spot.isDeleted && sameCity(spot, source)).length;
  const refShops = data.shops.filter((shop) => !shop.deleted && !shop.isDeleted && sameCity(shop, source)).length;
  if (refSpots || refShops) {
    return ElMessage.warning("该城市仍有关联打卡点 " + refSpots + "、合作门店 " + refShops + "，请先迁移关联资料后再删除");
  }
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  source.status = "筹备中";
  source.visible = false;
  if (!(await persistContentMutation("cities", source, previous))) return;
  if (!(await addTrash("cities", source, previous, { id: `trash-city-${source.id}-${Date.now()}`, type: "城市", sourceKey: "cities", name: source.name, reason: "删除城市", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } }))) return;
  log("删除城市进入回收站", "城市管理", source.name);
  ElMessage.success("城市已进入回收站，可由超管恢复");
}

function contentCreateLabel() {
  if (state.active === "shelfProducts") return "新增商品";
  if (state.active === "spots") {
    if (state.contentScope.type === "series") return "新增照片单品";
    if (state.contentScope.type === "album") return "新增样片";
    if (state.contentScope.type === "video") return "新增短视频";
    if (state.contentScope.type === "spot") return "新增拍摄风格";
    return "新增打卡";
  }
  return "新增";
}
function contentQuickActions() {
  if (state.active === "shelfProducts") return [
    { label: "去新增套", action: () => switchMenu("packages") },
    { label: "去新增短视频", action: () => switchMenu("spots") },
    { label: "去新增合", action: () => switchMenu("spots") },
  ];
  if (state.active === "packages") return [
    { label: "新增套餐", action: () => openContentQuick("packages") },
    { label: "去商品上下架", action: () => switchMenu("shelfProducts") },
  ];
  if (state.active === "peripherals") return [
    { label: "新增周边", action: () => openContentQuick("peripherals") },
    { label: "去商品上下架", action: () => switchMenu("shelfProducts") },
  ];
  if (state.active === "addonServices") return [
    { label: "新增增值服", action: () => openContentQuick("addonServices") },
  ];
  if (state.active === "spots") return [
    { label: contentCreateLabel(), action: () => openContentFromScope() },
    { label: "去套餐设", action: () => switchMenu("packages") },
    { label: "去商品上下架", action: () => switchMenu("shelfProducts") },
  ];
  return [{ label: contentCreateLabel(), action: () => openContentFromScope() }];
}
function contentRecordId(item) {
  return String((item && (item.id || item._id)) || "");
}
function firstActiveContentId(list) {
  return contentRecordId((list || []).find((item) => item && !item.deleted && !item.isDeleted));
}
function openContentFromScope() {
  if (state.active === "shelfProducts") return switchMenu("packages");
  if (state.active !== "spots") return openContent();
  const scope = state.contentScope;
  if (scope.type === "spot") return openContentQuick("series", { spotId: scope.id });
  if (scope.type === "video") return openContentQuick("packages", { spotId: scope.id, type: "video", keepInSpot: true });
  if (scope.type === "series") {
    const ser = data.series.find((item) => contentRecordId(item) === String(scope.id)) || {};
    return openContentQuick("albums", { spotId: ser.spotId || (ser.spotIds || [])[0] || firstActiveContentId(data.spots), seriesId: scope.id });
  }
  if (scope.type === "album") {
    const alb = data.albums.find((item) => contentRecordId(item) === String(scope.id)) || {};
    return openContentQuick("samples", {
      spotId: alb.spotId || firstActiveContentId(data.spots),
      seriesId: alb.seriesId || firstActiveContentId(data.series),
      albumId: scope.id
    });
  }
  return openContentQuick("spots");
}
function relationText(row) {
  return [spotName(row.spotId), seriesName(row.seriesId), albumName(row.albumId)].filter((v) => v && v !== "-").join(" / ") || "全局";
}
function guideMediaItems(row = {}) {
  const items = Array.isArray(row.mediaItems) ? row.mediaItems : (Array.isArray(row.mediaUrls) ? row.mediaUrls : []);
  return items.filter(Boolean).map((item) => {
    const url = typeof item === "string" ? item : item.url;
    return { url, type: item.type || (row.mediaType === "video" || /\.(mp4|mov|webm)(\?|$)|\/video\//i.test(url) ? "video" : "image") };
  }).filter((item) => item.url);
}
function guideProductMatchesSpot(product, spotId) {
  let ids = [...(Array.isArray(product.spotIds) ? product.spotIds : []), product.spotId].filter(Boolean).map(String);
  if (!ids.length && product.seriesId) {
    const parent = (data.series || []).find((item) => contentRecordId(item) === String(product.seriesId));
    if (parent) ids = [...(Array.isArray(parent.spotIds) ? parent.spotIds : []), parent.spotId].filter(Boolean).map(String);
  }
  return !!spotId && ids.includes(String(spotId));
}
const guideProductOptions = computed(() => {
  const spotId = state.editContent?.spotId;
  const rows = [
    ...(data.albums || []).map((item) => ({ ...item, targetType: "album", typeLabel: "照片留影" })),
    ...(data.packages || []).map((item) => ({ ...item, targetType: isVideoSingleProduct(item) ? "video" : "package", typeLabel: isVideoSingleProduct(item) ? "视频摄像" : "旅拍套餐" }))
  ];
  return rows.filter((item) => !item.deleted && !item.isDeleted && item.isShow !== false && item.visible !== false && item.enabled !== false && item.isSellable !== false
    && !["草稿", "待审", "待审核", "驳回", "下架", "停用", "禁用", "已下", "已下架", "已下架商品", "draft", "pending", "reviewing", "rejected", "offline", "disabled", "down"].includes(String(item.status || item.saleStatus || "").toLowerCase())
    && (!(item.auditStatus || item.reviewStatus) || ["已上", "已上架", "审核通过", "通过", "approved", "pass", "passed", "published", "online"].includes(String(item.auditStatus || item.reviewStatus).toLowerCase()))
    && (!spotId || guideProductMatchesSpot(item, spotId)))
    .map((item) => ({ value: `${item.targetType}:${contentRecordId(item)}`, id: contentRecordId(item), type: item.targetType, label: `${item.typeLabel} · ${item.name || item.title}` }));
});
const guideTargetValue = computed({
  get: () => state.editContent?.targetProductId ? `${state.editContent.targetProductType}:${state.editContent.targetProductId}` : "",
  set(value) {
    const option = guideProductOptions.value.find((item) => item.value === value);
    Object.assign(state.editContent, { targetProductId: option?.id || "", targetProductType: option?.type || "", targetPackageId: "" });
  }
});
function changeGuideSpot() {
  guideTargetValue.value = "";
}
function moveGuideMedia(index, direction) {
  const items = state.editContent.mediaItems;
  const next = index + direction;
  if (!items || next < 0 || next >= items.length) return;
  [items[index], items[next]] = [items[next], items[index]];
}
function removeGuideMedia(index) {
  state.editContent.mediaItems.splice(index, 1);
  state.editContent.mediaUrls = state.editContent.mediaItems.map((item) => item.url);
}
function albumRetouchMode(row = {}) {
  return ["count", "included", "excluded"].includes(row.retouchMode) ? row.retouchMode
    : Number(row.retouchCount) > 0 ? "count" : row.retouchIncluded === true ? "included" : "excluded";
}
function albumPhotoUrls(row = {}) {
  if (Array.isArray(row.sampleUrls) && !row.sampleUrls.length) return [];
  const urlOf = (item) => typeof item === "string" ? item : item && item.type !== "video" ? item.url || item.cover || item.image || "" : "";
  const own = Array.isArray(row.sampleUrls) ? row.sampleUrls : [
    ...(Array.isArray(row.photos) ? row.photos : []), ...(Array.isArray(row.images) ? row.images : []),
    ...(data.samples || []).filter((item) => !item.deleted && !item.isDeleted && item.type !== "video"
      && (String(item.albumId || "") === String(row.id || row._id || "") && !!(row.id || row._id)
        || (row.photoIds || []).includes(item.id || item._id)))
  ];
  return [...new Set([row.cover || row.coverImage || row.coverUrl || row.image, ...own.map(urlOf)].filter(Boolean))];
}
function setAlbumCover(row, url) {
  if (!row || !ctx.can("contentEdit")) return;
  const urls = albumPhotoUrls(row);
  row.sampleUrls = [...new Set([url, ...urls].filter(Boolean))];
  row.cover = url || "";
  row.coverUrl = row.cover;
  row.coverImage = row.cover;
  row.image = row.cover;
  row.photoCount = row.sampleUrls.length;
}
function addAlbumPhoto(row, url) {
  if (!row || !url || !ctx.can("contentEdit")) return;
  row.sampleUrls = [...new Set([...albumPhotoUrls(row), url])];
  if (!row.cover) setAlbumCover(row, url);
  row.photoCount = row.sampleUrls.length;
}
function removeAlbumPhoto(row, url) {
  if (!row || !ctx.can("contentEdit")) return;
  row.sampleUrls = albumPhotoUrls(row).filter((item) => item !== url);
  if ([row.cover, row.coverImage, row.coverUrl, row.image].includes(url)) {
    row.cover = row.sampleUrls[0] || "";
    row.coverUrl = row.cover;
    row.coverImage = row.cover;
    row.image = row.cover;
  }
  row.photoCount = row.sampleUrls.length;
}
function replaceAlbumPhoto(row, url) {
  if (!row || !ctx.can("contentEdit")) return;
  const urls = albumPhotoUrls(row);
  window.LXM_UPLOAD.pick({ purpose: "content", collection: "albums", recordId: row.id || row._id || undefined, imagesOnly: true,
    onUploaded(file) {
      if (!albumPhotoUrls(row).includes(url)) return;
      const current = albumPhotoUrls(row);
      row.sampleUrls = [...new Set(current.map((item) => item === url ? file.url : item))];
      row.photoCount = row.sampleUrls.length;
      if (row.cover === url || !row.cover && urls[0] === url) {
        row.cover = file.url; row.coverImage = file.url; row.coverUrl = file.url; row.image = file.url;
      }
    }
  });
}
function applyAlbumShootingTemplate(row) {
  if (!row || !ctx.can("contentEdit")) return;
  row.shootingNotes = `本次拍摄的取景、风格以本商品样片展示为参考标准，成片氛围与取景思路对标样片效果。
📷拍摄内容：按照套餐约定时长、底片数量，在对应景点内拍摄，包含摄影师引导摆拍与自然抓拍。
⏰拍摄时长：以套餐标注时长为准。
👔穿搭建议：可参考商品样片风格搭配服装，配色简洁会更加上镜。
💡温馨提示
1. 下单后请联系鹿小鸣客服沟通拍摄细节，确认具体档期，客服将为您提供全程服务；
2. 拍摄效果参考样片风格，受当日光线、人流、个人气质等因素影响，成片无法和样片完全一致；
3. 拍摄点位如需门票、场地费，由客人自行承担；
4. 拍摄时请遵守景区、街区管理规定，文明拍摄；
5. 拍摄前可以把喜欢的画面、想法提前和摄影师、客服沟通；
6. 建议穿着舒适方便行走的鞋子，做好防晒、防蚊等准备。`;
  row.intro = row.shootingNotes;
}
function openContent(row = null, requestedKey = "") {
  const matchesRow = (list) => row && (list || []).some((item) => contentRecordId(item) && contentRecordId(item) === contentRecordId(row));
  const defaultSpotId = firstActiveContentId(data.spots);
  const defaultSeriesId = firstActiveContentId(data.series);
  const defaultAlbumId = firstActiveContentId(data.albums);
  const rowKey = matchesRow(data.cities) ? "cities" : matchesRow(data.spots) ? "spots" : matchesRow(data.series) ? "series" : matchesRow(data.albums) ? "albums" : matchesRow(data.samples) ? "samples" : matchesRow(data.packages) ? "packages" : matchesRow(data.peripherals) ? "peripherals" : matchesRow(data.guides) ? "guides" : "";
  const key = requestedKey || row?.__key || rowKey || (row && state.active === "spots" ? effectiveContentKey() : state.active === "videoProducts" ? "packages" : state.active);
  if (key === "guides") {
    state.contentDialog = false;
    state.active = "guides";
    state.guideEditorRequest = { row: row?.__source || row, requestedAt: Date.now() };
    return;
  }
  const defaults = {
    spots: { name: "", cityId: "", cover: "", tag: "推荐", tags: [], styles: [], address: "", district: "", latitude: null, longitude: null, coordType: "gcj02", hotScore: 8.5, sort: 0, status: "启用", isShow: true },
    series: { name: "", spotId: defaultSpotId, spotIds: defaultSpotId ? [defaultSpotId] : [], style: "清新", styles: ["清新"], tags: [], intro: "", productType: "photo", soldCount: 0, minPrice: 0, maxPrice: 0, packageIds: [], status: "启用", cover: contentCover("新系", "拍摄风格封面") },
    albums: { name: "", spotId: "", spotIds: [], spotBindingExplicit: true, seriesId: defaultSeriesId, price: 0, intro: "", photoCount: 0, photoCountText: "", retouchText: "", makeupText: "", shootingNotes: "", retouchMode: "excluded", retouchCount: 0, makeupIncluded: false, isShow: false, isSellable: true, allowMaterialUse: true, status: "下架", cover: "", sampleUrls: [] },
    samples: { name: "", type: "photo", spotId: defaultSpotId, seriesId: defaultSeriesId, albumId: defaultAlbumId, status: "启用", url: contentCover("新样", "上传预览") },
    packages: { name: "", type: "photo", spotId: defaultSpotId, seriesId: defaultSeriesId, albumId: defaultAlbumId, originalPrice: 999, price: 699, specialPrice: 699, isMainPush: false, isShow: true, status: "上架", intro: "", description: "", serviceTags: ["精修9"], cover: contentCover("新套", "套餐封面") },
    addonServices: { name: "", category: "修图", price: 199, enabled: true, intro: "增值服务，仅客服处理订单时添加" },
    peripherals: { name: "", category: "相册", price: 99, enabled: true, isShow: true, internalOnly: false, serviceKind: "", intro: "", specs: [], isNew: false, images: [], cover: contentCover("新周", "摄影周边"), storeProductId: "", storeProductPromotionLink: "" },
    guides: { name: "", title: "", description: "", content: "", mediaUrls: [], mediaType: "image", status: "草稿", tag: "旅拍灵感", isHot: false, isTop: false, readCount: 0, score: "4.9", spotId: defaultSpotId, cover: contentCover("新灵感", "旅拍灵感") },
    stories: { name: "", title: "", subtitle: "", status: "草稿", tag: "故事", spotId: defaultSpotId, cover: contentCover("新故", "品牌故事") },
    cities: { name: "", mode: "直营", status: "启用", enabled: true, visible: true, latitude: null, longitude: null, coordType: "gcj02" },
  };
  const sourceRow = row?.__source || row;
  state.editContent = sourceRow ? { ...sourceRow, __key: key } : { ...(defaults[key] || {}), id: "", __key: key };
  if (["albums", "packages"].includes(key)) {
    state.editContent.recommendedPhotographerId = String(state.editContent.recommendedPhotographerId || "");
    loadContentPhotographers();
  }
  if (key === "spots") spotDraftSort.set(state.editContent, state.editContent.sort);
  if (key === "cities") {
    const status = String(state.editContent.status || "").trim().toLowerCase();
    const enabled = state.editContent.enabled !== undefined && state.editContent.enabled !== null && String(state.editContent.enabled).trim() !== ""
      ? state.editContent.enabled
      : state.editContent.isEnabled;
    const visible = state.editContent.visible;
    state.editContent.enabled = ![false, 0, "0", "false", "no", "off"].includes(typeof enabled === "string" ? enabled.trim().toLowerCase() : enabled)
      && ![false, 0, "0", "false", "no", "off"].includes(typeof visible === "string" ? visible.trim().toLowerCase() : visible)
      && !["禁用", "停用", "筹备中", "未开通", "未启用", "关闭", "已停用", "disabled", "offline", "closed", "inactive", "unavailable"].includes(status);
    state.editContent.status = state.editContent.enabled ? "启用" : "停用";
  }
  if (key === "spots") {
    state.editContent.cover = [state.editContent.cover, state.editContent.coverUrl, state.editContent.coverImage, state.editContent.image]
      .find((value) => typeof value === "string" && value.trim())?.trim() || "";
    state.editContent.intro = state.editContent.intro || state.editContent.description || "";
    const city = cityById(state.editContent.cityId || state.editContent.city);
    if (city && (city.id || city._id)) {
      state.editContent.cityId = city.id || city._id;
      state.editContent.city = city.name || state.editContent.city || "";
    } else if (!sourceRow) {
      const defaultCity = (data.cities || []).find((item) => item && !item.deleted && !item.isDeleted);
      if (defaultCity) {
        state.editContent.cityId = defaultCity.id || defaultCity._id || "";
        state.editContent.city = defaultCity.name || "";
      }
    // 新建点位默认直接展示；状态/展示开关只在点位列表维护。
    if (!sourceRow) {
      state.editContent.status = "启用";
      state.editContent.isShow = true;
    }
    }
  }
  if (key === "series") normalizeSeriesSpotRelations(state.editContent);
  if (key === "packages") {
    if (!sourceRow && state.active === "videoProducts") state.editContent.type = "video";
    if (!sourceRow && state.editContent.type === "video") {
      state.editContent.spotId = "";
      state.editContent.spotIds = [];
    }
    Object.assign(state.editContent, {
      depositRatio: state.editContent.depositRatio ?? 30,
      finalPaymentRule: state.editContent.finalPaymentRule || "拍摄完成前确认尾",
      weekdayPrice: state.editContent.weekdayPrice ?? state.editContent.specialPrice ?? state.editContent.price ?? 0,
      weekendSurcharge: state.editContent.weekendSurcharge ?? 0,
      holidaySurcharge: state.editContent.holidaySurcharge ?? 0,
      aerialExtraPrice: state.editContent.aerialExtraPrice ?? 0,
      duration: state.editContent.duration ?? 60,
      retouchCount: state.editContent.retouchCount ?? 9,
      videoDuration: state.editContent.videoDuration ?? 30,
      finishedVideoCount: state.editContent.finishedVideoCount ?? 1,
      hasAerial: state.editContent.hasAerial ?? false,
      fullEdit: state.editContent.fullEdit ?? true,
      deliveryCycle: state.editContent.deliveryCycle || "1–3 个工作日",
      hotScore: state.editContent.hotScore ?? 80,
      isHot: state.editContent.isHot ?? false,
      spotIds: state.editContent.spotIds || (state.editContent.spotId ? [state.editContent.spotId] : []),
      giftItems: state.editContent.giftItems || [],
      videoUrl: state.editContent.videoUrl || "",
      previewVideoUrl: state.editContent.previewVideoUrl || "",
      productKind: state.editContent.productKind || (state.editContent.type === "video" ? "video_single" : ""),
      bookingLimit: state.editContent.bookingLimit ?? 8,
      advanceBookingDays: state.editContent.advanceBookingDays ?? 3,
      holidayQuota: state.editContent.holidayQuota ?? 5,
      timeSlotLimit: state.editContent.timeSlotLimit ?? 4,
      mutualExclusionIds: state.editContent.mutualExclusionIds || [],
      includedItems: Array.isArray(state.editContent.includedItems) ? state.editContent.includedItems : [],
      scheduledOnAt: state.editContent.scheduledOnAt || "",
      scheduledOffAt: state.editContent.scheduledOffAt || "",
      auditStatus: state.editContent.auditStatus || packageAuditText(state.editContent),
    });
  }
  if (key === "guides") {
    state.editContent.mediaItems = guideMediaItems(state.editContent);
    state.editContent.mediaUrls = state.editContent.mediaItems.map((item) => item.url);
    state.editContent.mediaType = state.editContent.mediaItems.length && state.editContent.mediaItems.every((item) => item.type === "video") ? "video" : (state.editContent.mediaType || "image");
    state.editContent.isTop = state.editContent.isTop ?? state.editContent.isHot ?? false;
    state.editContent.spotId = state.editContent.spotId || state.editContent.spotIds?.[0] || "";
    state.editContent.targetProductId = state.editContent.targetProductId ?? state.editContent.targetPackageId ?? "";
    state.editContent.targetProductType = state.editContent.targetProductType ?? (state.editContent.targetPackageId ? "package" : "");
    if (Array.isArray(state.editContent.content)) state.editContent.content = state.editContent.content.join("\n\n");
  }
  if (key === "albums") {
    Object.assign(state.editContent, {
      isSellable: state.editContent.isSellable ?? productStatus(state.editContent) !== "下架",
      allowMaterialUse: state.editContent.allowMaterialUse ?? true,
      tags: state.editContent.tags || (state.editContent.tag ? [state.editContent.tag] : []),
      photoMaterialEnabled: state.editContent.photoMaterialEnabled ?? true,
      videoMaterialEnabled: state.editContent.videoMaterialEnabled ?? true,
      isShow: state.editContent.isShow ?? productStatus(state.editContent) !== "下架",
      retouchCount: state.editContent.retouchCount ?? 0,
      makeupIncluded: state.editContent.makeupIncluded ?? false,
      photoCount: state.editContent.photoCount ?? 0,
      photoCountText: state.editContent.photoCountText ?? `${Number(state.editContent.photoCount) || 0} 张照片`,
      retouchText: state.editContent.retouchText ?? (albumRetouchMode(state.editContent) === "count" ? `${Number(state.editContent.retouchCount)} 张` : albumRetouchMode(state.editContent) === "included" ? "包含" : "不包含"),
      makeupText: state.editContent.makeupText ?? (state.editContent.makeupIncluded === true ? "包含" : "不包含"),
      shootingNotes: state.editContent.shootingNotes ?? state.editContent.intro ?? "",
      retouchMode: albumRetouchMode(state.editContent),
    });
    state.editContent.sampleUrls = albumPhotoUrls(state.editContent);
    state.editContent.tags = [...state.editContent.tags];
  }
  if (["albums", "peripherals"].includes(key) || key === "packages" && state.editContent.type === "video") hydrateProductSpot(state.editContent);
  if (key === "peripherals") {
    Object.assign(state.editContent, {
      mode: state.editContent.mode || peripheralModeText(state.editContent),
      specs: state.editContent.specs || state.editContent.spec || "标准",
      retouchIncluded: state.editContent.retouchIncluded ?? false,
      editingIncluded: state.editContent.editingIncluded ?? false,
      isHot: state.editContent.isHot ?? false,
      deliveryCycle: state.editContent.deliveryCycle || "3-5天发",
      scheduledOnAt: state.editContent.scheduledOnAt || "",
      scheduledOffAt: state.editContent.scheduledOffAt || "",
      storeProductId: state.editContent.storeProductId || "",
      storeProductPromotionLink: state.editContent.storeProductPromotionLink || "",
      auditStatus: state.editContent.auditStatus || (productStatus(state.editContent) === "上架" ? "已上" : "已下"),
      internalOnly: state.editContent.internalOnly === true,
      serviceKind: state.editContent.serviceKind || "",
    });
  }
  if (key === "addonServices") {
    Object.assign(state.editContent, {
      eligibility: state.editContent.eligibility || state.editContent.orderScope || "all",
      maxQuantity: state.editContent.maxQuantity ?? 1,
      holidaySurcharge: state.editContent.holidaySurcharge ?? 0,
      financeReviewRequired: state.editContent.financeReviewRequired ?? true,
      includeInOrderAmount: state.editContent.includeInOrderAmount ?? true,
      defaultForPackageIds: state.editContent.defaultForPackageIds || [],
    });
  }
  state.contentDialog = true;
  log(row ? "打开内容编辑" : "打开内容新增", activeMenu.value.label, row?.name || "新内");
}
function openContentQuick(key, relations = {}) {
  if (!contentKeys.includes(key)) return;
  const keepInSpot = Boolean(relations.keepInSpot);
  const cleanRelations = { ...relations };
  delete cleanRelations.keepInSpot;
  if (key === "guides") {
    state.contentDialog = false;
    state.active = "guides";
    state.guideEditorRequest = { row: null, relations: cleanRelations, requestedAt: Date.now() };
    return;
  }
  if (!keepInSpot && !["series", "albums", "samples"].includes(key)) state.active = key;
  if (keepInSpot) {
    const previousActive = state.active;
    state.active = key;
    openContent(null, key);
    state.active = previousActive;
  } else {
    openContent(null, key);
  }
  Object.assign(state.editContent, cleanRelations);
  if (key === "series" && relations.spotId) state.editContent.spotIds = [relations.spotId];
  if (key === "albums" && relations.spotId) state.contentScope = { type: "series", id: relations.seriesId || "" };
  if (key === "packages" && cleanRelations.type === "video" && cleanRelations.spotId) state.contentScope = { type: "video", id: cleanRelations.spotId };
}
function addIncludedItem() {
  if (!state.editContent) return;
  if (!Array.isArray(state.editContent.includedItems)) state.editContent.includedItems = [];
  state.editContent.includedItems.push({ type: "album", name: "", price: 0, target: { page: "photoCollection" } });
}
async function saveContent() {
  if (!isServerConnected()) return ElMessage.error("真实后端连接不可用，内容未保存");
  if (!window.LXM_UPLOAD.ready()) return;
  const row = state.editContent;
  if (!row) return;
  if (!row.name && !row.title) return ElMessage.warning("请填写名称或标题");
  const key = row.__key;
  if (key === "spots" && isSpotOrderSaving()) return ElMessage.warning("打卡点排序正在保存，请稍后再试");
  const target = contentList(key);
  const payload = { ...row };
  delete payload.__key;
  if (key === "packages" && isPackageTitleLimited(payload)) {
    const previous = target.find((item) => String(item.id || item._id) === String(payload.id || payload._id));
    const titleError = packageTitleError(payload, previous);
    if (titleError) return ElMessage.warning(titleError);
    payload.name = normalizePackageTitle(payload.name);
  }
  if (key === "series") normalizeSeriesSpotRelations(payload);
  if (key === "spots") {
    const city = cityById(payload.cityId || payload.city);
    if (city && (city.id || city._id)) {
      payload.cityId = city.id || city._id;
      payload.city = city.name || payload.city || "";
    }
    if (!payload.cityId) return ElMessage.warning("请选择所属城市");
    payload.district = String(payload.district || "").trim();
    const coordinateError = normalizeMapCoordinates(payload, "打卡点");
    if (coordinateError) return ElMessage.warning(coordinateError);
    const hotRank = Number(payload.sort);
    payload.sort = Number.isFinite(hotRank) && Number.isInteger(hotRank) && hotRank > 0 ? hotRank : 0;
  }
  if (key === "cities") {
    const falseLike = (value) => [false, 0, "0", "false", "no", "off"].includes(typeof value === "string" ? value.trim().toLowerCase() : value);
    payload.enabled = !falseLike(payload.enabled);
    payload.status = payload.enabled ? "启用" : "停用";
    // Keep visibility synchronized for public RPCs and legacy data sources.
    payload.visible = payload.enabled;
    const coordinateError = normalizeMapCoordinates(payload, "城市中心");
    if (coordinateError) return ElMessage.warning(coordinateError);
  }
  if (key === "packages") {
    payload.specialPrice = Number(payload.specialPrice || payload.price || 0);
    payload.serviceType = payload.type || "photo";
    payload.productType = payload.type || "photo";
    // Keep both field names in sync. Older JSON data and the compact package
    // editor still use intro, while the mini-program detail reads description.
    payload.description = String(payload.description || payload.intro || "").trim();
    payload.intro = payload.description;
    const packageSpotIds = [
      ...(Array.isArray(payload.spotIds) ? payload.spotIds : []),
      payload.spotId
    ].filter(Boolean).map(String);
    payload.spotIds = [...new Set(packageSpotIds)];
    payload.spotId = String(payload.spotId || payload.spotIds[0] || "");
    if (payload.type !== "video" || payload.productKind !== "video_single") {
      delete payload.videoUrl;
      delete payload.previewVideoUrl;
    }
    if (payload.type !== "video" || !payload.productKind) delete payload.productKind;
    ["originalPrice", "price", "weekdayPrice", "weekendSurcharge", "holidaySurcharge", "aerialExtraPrice", "depositRatio", "duration", "retouchCount", "videoDuration", "finishedVideoCount", "bookingLimit", "advanceBookingDays", "holidayQuota", "timeSlotLimit"].forEach((field) => {
      if (payload[field] !== undefined && payload[field] !== "") payload[field] = Number(payload[field] || 0);
    });
    // 套餐包含：按名称+类型自动补齐小程序跳转 target（album→photoCollection / video→videoProductDetail / peripheral→peripheral）
    if (Array.isArray(payload.includedItems)) {
      payload.includedItems = payload.includedItems.map((it) => {
        const item = { ...it };
        const currentTarget = item.target && typeof item.target === "object" ? { ...item.target } : {};
        if (item.type === "album") {
          const a = (data.albums || []).find((x) => x.id === (currentTarget.albumId || item.albumId) || x.name === item.name);
          item.target = { page: "photoCollection", seriesId: a ? a.seriesId : currentTarget.seriesId || item.seriesId || "", albumId: a ? a.id : currentTarget.albumId || item.albumId || "" };
        } else if (item.type === "video") {
          const v = (data.packages || []).find((x) => x.id === (currentTarget.productId || item.productId) && x.type === "video") || (data.packages || []).find((x) => x.name === item.name && x.type === "video");
          item.target = { page: "videoProductDetail", productId: v ? v.id : currentTarget.productId || item.productId || "", seriesId: v ? v.seriesId : currentTarget.seriesId || item.seriesId || "", spotId: v ? (v.spotId || (v.spotIds || [])[0]) : currentTarget.spotId || item.spotId || "" };
        } else if (item.type === "peripheral") {
          const p = (data.peripherals || []).find((x) => x.id === (currentTarget.peripheralId || item.peripheralId || currentTarget.productId || item.productId) || x.name === item.name);
          const peripheralId = p ? p.id : currentTarget.peripheralId || item.peripheralId || currentTarget.productId || item.productId || "";
          item.target = { page: "peripheral", id: peripheralId, peripheralId };
          item.peripheralId = peripheralId;
        }
        return item;
      });
    }
  }
  if (key === "albums") {
    ["price", "photoCount", "retouchCount"].forEach((field) => {
      if (payload[field] !== undefined && payload[field] !== "") payload[field] = Number(payload[field] || 0);
    });
    payload.isShow = payload.isShow !== false;
    payload.isSellable = payload.isSellable !== false;
    payload.status = payload.isSellable ? (payload.status || "启用") : "下架";
    payload.shootingNotes = String(payload.shootingNotes ?? payload.intro ?? "").trim();
    payload.intro = payload.shootingNotes;
    delete payload.originalPrice;
    delete payload.specialPrice;
  }
  if (key === "peripherals") {
    ["price"].forEach((field) => {
      if (payload[field] !== undefined && payload[field] !== "") payload[field] = Number(payload[field] || 0);
    });
    payload.image = payload.cover || payload.image || "";
    if (payload.category) payload.cate = payload.category;
    if (payload.intro !== undefined && payload.description === undefined) payload.description = payload.intro;
    // specs：小程序读数组 specs[]，后台多选/新建统一转数组（逗号/斜杠拆分兜底）
    if (typeof payload.specs === "string") {
      payload.specs = payload.specs.split(/[,，/]/).map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(payload.specs)) payload.specs = [];
    payload.internalOnly = payload.internalOnly === true;
    if (payload.internalOnly) payload.isShow = false;
    if (payload.mode === "全城通用") {
      payload.spotId = "";
      payload.spotIds = [];
    }
  }
  if (key === "guides") {
    payload.title = String(payload.title || payload.name || "").trim();
    payload.name = payload.title;
    payload.description = payload.description ?? payload.intro ?? "";
    if (payload.cover) { payload.image = payload.cover; payload.coverUrl = payload.cover; }
    if (payload.readCount !== undefined && payload.readCount !== "") payload.readCount = Number(payload.readCount || 0);
    if (!payload.score) payload.score = "4.9";
    payload.isTop = payload.isTop === true;
    payload.isHot = payload.isTop;
    payload.mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems.map((item) => ({ ...item })) : [];
    payload.mediaUrls = payload.mediaItems.map((item) => item.url);
    payload.mediaType = payload.mediaType === "video" ? "video" : "image";
    payload.spotIds = payload.spotId ? [payload.spotId] : [];
    payload.seriesId = "";
    payload.targetProductId = payload.targetProductId || "";
    payload.targetProductType = payload.targetProductType || "";
    payload.targetPackageId = ["package", "video"].includes(payload.targetProductType) ? payload.targetProductId : "";
    if (payload.targetProductId && !guideProductOptions.value.some((item) => item.id === payload.targetProductId && item.type === payload.targetProductType)) return ElMessage.warning("预约同款商品已失效或不属于所选打卡点，请重新选择");
    if (payload.mediaItems.some((item) => item.type !== payload.mediaType)) return ElMessage.warning("请移除原媒体后再切换图文 / 视频类型");
    if (!["草稿", "下架", "停用", "禁用"].includes(payload.status || "草稿")) {
      if (!String(payload.content || payload.description || "").trim() || !payload.mediaItems.length) return ElMessage.warning("发布前请填写正文并上传图片或视频");
    }
  }
  if (key === "spots") {
    payload.cover = String(payload.cover || "").trim();
    payload.image = payload.cover;
    payload.coverUrl = payload.cover;
    payload.coverImage = payload.cover;
    payload.description = payload.intro;
  }
  if (key === "addonServices") {
    ["price", "maxQuantity", "holidaySurcharge"].forEach((field) => {
      if (payload[field] !== undefined && payload[field] !== "") payload[field] = Number(payload[field] || 0);
    });
  }
  if (key === "series") {
    payload.price = undefined;
    payload.originalPrice = undefined;
    payload.specialPrice = undefined;
  }
  const isNew = !payload.id;
  if (isNew) {
    payload.id = `${key}${Date.now()}`;
    payload._id = payload.id;
    if (["packages", "albums", "peripherals"].includes(key)) {
      payload.auditStatus = "待审";
      payload.auditType = "新增商品";
      payload.auditSubmitAt = LXMFormat.dateTime(new Date());
      payload.auditSubmitter = currentOperatorName();
    }
  } else if (["packages", "albums", "peripherals"].includes(key)) {
    payload.auditStatus = "待审";
    payload.auditType = "商品资料编辑";
    payload.auditSubmitAt = LXMFormat.dateTime(new Date());
    payload.auditSubmitter = currentOperatorName();
    payload.auditReason = "商品资料编辑";
  }
  let persisted = payload;
  normalizeSingleProduct(payload, key);
  const validation = validateContentPublishing(key, payload, target.find((item) => String(item.id || item._id) === String(payload.id || payload._id)), { forceTags: true });
  if (validation) return ElMessage.warning(validation);
  if (!(await ensureContentTags(payload, key))) return;
  if (key === "spots") {
    if (isSpotOrderSaving()) return ElMessage.warning("打卡点排序正在保存，请稍后再试");
    state.spotSortSaving = true;
  }
  try {
    const currentSpot = key === "spots" && target.find(item => String(item.id || item._id) === String(payload.id || payload._id));
    const preserveSpotSort = currentSpot && spotDraftSort.has(row)
      && window.LXM_SPOT_ORDER.rank(row.sort) === window.LXM_SPOT_ORDER.rank(spotDraftSort.get(row));
    if (preserveSpotSort) payload.sort = currentSpot.sort;
    persisted = await pushContentToCloud(key, payload, { preserveSpotSort });
    if (!persisted) return;
    Object.assign(payload, persisted);
    if (!isNew) {
      const index = target.findIndex((item) => item.id === payload.id);
      if (index >= 0) Object.assign(target[index], payload);
    } else {
      target.unshift(payload);
    }
    state.contentDialog = false;
    log("保存内容", activeMenu.value.label, payload.name || payload.title);
    ElMessage.success("内容已保存到真实后端");
  } finally {
    if (key === "spots") state.spotSortSaving = false;
  }
}

function isSpotOrderSaving() { return !!state.spotSortSaving; }

function applySpotOrderResponse(response) {
  const { __spotOrder, ...saved } = response || {};
  if (Array.isArray(__spotOrder)) {
    const sources = new Map((data.spots || []).map(row => [String(row.id || row._id), row]));
    for (const entry of __spotOrder) {
      const source = sources.get(String(entry.id));
      if (source) source.sort = entry.sort;
    }
  }
  return saved;
}

async function persistSpotSort(spot, requested) {
  if (!isServerConnected()) { ElMessage.error("真实后端连接不可用，排序未保存"); return false; }
  if (isSpotOrderSaving() || !ctx.can("contentEdit")) return false;
  const id = String(spot && (spot.id || spot._id) || "");
  const source = (data.spots || []).find(row => String(row.id || row._id) === id);
  if (!source || source.deleted || source.isDeleted) return false;
  state.spotSortSaving = true;
  try {
    // 排序和同级调整由服务端统一提交。
    const result = await window.LXM_CLOUD.update("spots", id, { sort: requested });
    if (!result || result.error) throw new Error(result && result.error || "排序保存失败");
    Object.assign(source, applySpotOrderResponse(result));
    return true;
  } catch (error) {
    ElMessage.error(error && error.message || "排序保存失败，请稍后重试");
    return false;
  } finally {
    state.spotSortSaving = false;
  }
}
// 将内容保存到真实数据库，采用服务端确认的数据更新界面。
// 新增项在 saveContent 里已预置 payload.id，服务端可能还没有该 id，先 update 失败则回退 create。
async function pushContentToCloud(key, payload, options = {}) {
  if (!["albums", "packages", "guides"].includes(key)) return pushContentToCloudUnlocked(key, payload, options);
  if (state.contentSortSaving) { ElMessage.warning("内容或排序正在保存，请稍后再试"); return null; }
  state.contentSortSaving = true;
  try { return await pushContentToCloudUnlocked(key, payload, options); }
  finally { state.contentSortSaving = false; }
}
async function pushContentToCloudUnlocked(key, payload, options = {}) {
  if (!isServerConnected()) { ElMessage.error("真实后端连接不可用，内容未保存"); return null; }
  try {
    const doc = { ...payload, isDeleted: false };
    if (["albums", "packages", "guides"].includes(key)) delete doc.sort;
    if (key === "spots" && options.preserveSpotSort) delete doc.sort;
    let res;
    if (payload.id) {
      try {
        res = await window.LXM_CLOUD.update(key, payload.id, doc);
      } catch (error) {
        if (!error || error.status !== 404) throw error;
        res = await window.LXM_CLOUD.create(key, doc);
      }
    } else {
      res = await window.LXM_CLOUD.create(key, doc);
    }
    if (!confirmedContentSave(res)) throw new Error(res && res.error || "服务端未确认内容保存");
    const id = String((res && (res.id || res._id)) || payload.id || "");
    const saved = key === "spots" ? applySpotOrderResponse(res)
      : ["albums", "packages", "guides"].includes(key) && ctx.applyContentOrderResponse ? ctx.applyContentOrderResponse(key, res) : res.id || res._id ? res : {};
    return { ...payload, ...(saved && typeof saved === "object" ? saved : {}), id, _id: id };
  } catch (e) {
    ElMessage.error("服务端保存失败，未修改本地内容：" + (e && e.message ? e.message : e));
    return null;
  }
}
// 只有经过真实数据库健康探测并持有有效会话时，才允许业务写入。
function isServerConnected() {
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  return !!(window.LXM_CLOUD && window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE === "mysql" && reachable !== false);
}
function confirmedContentSave(result) {
  return !!(result && typeof result === "object" && !Array.isArray(result) && !result.error && result.ok !== false
    && (result.ok === true || result.id || result._id));
}
function configuredProductTags(value) {
  const tags = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[，,、|\r\n]/) : [];
  return [...new Set(tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))];
}
function taglessHideOnly(row, previous, raw = row) {
  if (!previous || (typeof ctx.contentManualVisible === "function" ? ctx.contentManualVisible(row) : row.isShow !== false && !["草稿", "下架", "停用"].includes(row.status))) return false;
  const statusFields = new Set(["isShow", "visible", "enabled", "isSellable", "status", "saleStatus", "shelfStatus", "auditStatus", "reviewStatus", "deleted", "isDeleted"]);
  const projectedFields = new Set(["id", "_id", "__key", "__source", "effectiveVisible", "visibilityReasons"]);
  return Object.keys(raw).every((field) => projectedFields.has(field) || statusFields.has(field) || JSON.stringify(raw[field]) === JSON.stringify(previous[field]));
}
function peripheralWithdrawalPatch(raw, previous) {
  if (!previous || !(previous.id || previous._id)) return null;
  const row = { ...previous, ...raw };
  const visible = typeof ctx.contentManualVisible === "function" ? ctx.contentManualVisible(row) : row.isShow !== false && !["草稿", "下架", "停用"].includes(row.status);
  if (visible && row.internalOnly !== true) return null;
  const fields = new Set(["isShow", "visible", "enabled", "isSellable", "status", "saleStatus", "shelfStatus", "auditStatus", "reviewStatus", "internalOnly", "auditType", "auditSubmitAt", "auditSubmitter", "auditReason"]);
  const projected = new Set(["id", "_id", "__key", "__source", "effectiveVisible", "visibilityReasons", "effectiveSpotIds", "deletedSpotIds"]);
  if (!Object.keys(raw).some((field) => fields.has(field))
    || !Object.keys(raw).every((field) => projected.has(field) || fields.has(field) || JSON.stringify(raw[field]) === JSON.stringify(previous[field]))) return null;
  return Object.fromEntries(Object.entries(raw).filter(([field]) => fields.has(field)));
}
function validateContentPublishing(key, row, previous = null, options = {}) {
  // Guide publication is validated by the dedicated editor and server. List
  // visibility/pinning must also work for text-only, media-only and legacy notes.
  if (key === "guides") return "";
  if (key === "packages") {
    const titleError = packageTitleError(row, previous);
    if (titleError) return titleError;
  }
  const visible = (value) => typeof ctx.contentManualVisible === "function" ? ctx.contentManualVisible(value) : value && value.isShow !== false && !["草稿", "下架", "停用"].includes(value.status);
  if (["albums", "packages"].includes(key) && !configuredProductTags(row.tags).length
    && (options.forceTags || !taglessHideOnly(row, previous, options.raw || row))) return "请至少添加一个标签";
  if (key === "albums") {
    for (const [field, label] of [["photoCountText", "照片张数"], ["retouchText", "修图"], ["makeupText", "妆造"]]) {
      if (row[field] != null && (typeof row[field] !== "string" || row[field].trim().length > 160)) return `${label}应为不超过160个字符的文字`;
    }
    if (row.photoCount !== undefined && (row.photoCount === null || row.photoCount === "" || !Number.isSafeInteger(Number(row.photoCount)) || Number(row.photoCount) < (visible(row) ? 1 : 0))) return "请填写有效的整数照片张数";
    if (!String(row.retouchText || "").trim() && albumRetouchMode(row) === "count" && (row.retouchCount === undefined || !Number.isSafeInteger(Number(row.retouchCount)) || Number(row.retouchCount) < 1)) return "请填写正整数的修图张数";
  }
  if (!visible(row) || (previous && visible(previous))) return "";
  const text = (value) => String(value ?? "").trim();
  const label = { spots: "打卡点", albums: "照片留影", packages: row.type === "video" ? "视频摄像" : "套餐", peripherals: "影像周边", guides: "旅拍灵感" }[key];
  if (!label) return "";
  if (!text(row.name || row.title)) return `请填写${label}名称`;
  if (key === "spots") {
    if (!row.cityId) return "请选择所属城市";
    if (!text(row.address)) return "请填写打卡点详细地址";
    if (!text(row.intro || row.description)) return "请填写打卡点介绍";
    if (!text(row.tag) && !(row.operationTags || []).length) return "请选择或输入运营标签";
    if (!(row.tags || []).length && !(row.contentTags || []).length && !(row.styles || []).length) return "请选择或输入内容标签";
  }
  const product = ["albums", "peripherals"].includes(key) || key === "packages" && row.type === "video";
  if (product) {
    if (row.price === "" || row.price === undefined || !Number.isFinite(Number(row.price)) || Number(row.price) < 0) return "请填写有效单价";
    if (!text(row.shootingNotes || row.intro || row.description)) return `请填写${key === "peripherals" ? "产品" : "拍摄"}说明`;
  }
  if (key === "albums" && (!Number.isSafeInteger(Number(row.photoCount)) || Number(row.photoCount) < 1)) return "请填写正整数的照片张数";
  if (key === "packages" && row.type === "video") {
    if (!(Number(row.videoDuration) > 0) && !text(row.durationText)) return "请填写成片时长";
    if (!Number.isInteger(Number(row.finishedVideoCount)) || Number(row.finishedVideoCount) < 1) return "请填写成片数量";
    if (!text(row.deliveryCycle)) return "请填写交付周期";
    if (!contentVideoUrl(row)) return "请上传商品视频";
  }
  if (key === "peripherals") {
    if (!(row.images || row.mediaUrls || []).length && !(row.videos || []).length && !text(row.cover || row.image)) return "请上传影像周边素材";
  }
  if (["spots", "albums"].includes(key) && !text(row.cover || row.image || row.coverUrl)) return "请上传首图或封面";
  return "";
}
async function ensureContentTags(row = {}, key = "") {
  if (key === "tagLibrary" || !["spots", "albums", "packages", "peripherals", "guides", "series"].includes(key)) return true;
  const requested = [
    { name: row.tag, category: "运营" },
    ...(Array.isArray(row.operationTags) ? row.operationTags : []).map((name) => ({ name, category: "运营" })),
    ...(Array.isArray(row.contentTags) ? row.contentTags : []).map((name) => ({ name, category: "内容" })),
    ...(Array.isArray(row.styleTags) ? row.styleTags : []).map((name) => ({ name, category: "风格" })),
    ...(Array.isArray(row.tags) ? row.tags : []).map((name) => ({ name, category: key === "spots" ? "内容" : "风格" })),
    ...(Array.isArray(row.styles) ? row.styles : []).map((name) => ({ name, category: "风格" })),
    ...(Array.isArray(row.serviceTags) ? row.serviceTags : []).map((name) => ({ name, category: "风格" }))
  ];
  for (const entry of requested) {
    const name = String(entry.name || "").trim();
    if (!name || (data.tagLibrary || []).some((tag) => !tag.deleted && !tag.isDeleted && tag.name === name && tag.category === entry.category)) continue;
    const tag = { id: `tag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name, category: entry.category, status: "启用", sort: 0 };
    if (!(await persistContentMutation("tagLibrary", tag))) return false;
    if (!Array.isArray(data.tagLibrary)) data.tagLibrary = [];
    data.tagLibrary.push(tag);
  }
  return true;
}
function hydrateProductSpot(row) {
  if (!row || row.__spotSelectionChanged || row.spotId || row.spotBindingExplicit === true) return row;
  if ((row.spotIds || []).length) { row.spotId = String(row.spotIds[0]); return row; }
  if (!row.seriesId) return row;
  const series = (data.series || []).find((item) => String(item.id || item._id) === String(row.seriesId));
  const ids = series ? [...new Set([series.spotId, ...(series.spotIds || [])].filter(Boolean).map(String))] : [];
  if (ids.length === 1) { row.spotId = ids[0]; row.spotIds = ids; }
  return row;
}
function markContentSpotChange(row) { if (row && (!row.__key || ["albums", "packages", "peripherals"].includes(row.__key))) row.__spotSelectionChanged = true; }
function normalizeSingleProduct(row, key) {
  if (["albums", "packages"].includes(key) && Object.prototype.hasOwnProperty.call(row, "recommendedPhotographerId")) {
    row.recommendedPhotographerId = String(row.recommendedPhotographerId || "");
  }
  if (!["albums", "peripherals"].includes(key) && !(key === "packages" && row.type === "video")) return;
  hydrateProductSpot(row);
  row.spotId = String(row.spotId || "");
  row.spotIds = row.spotId ? [row.spotId] : [];
  if (row.__spotSelectionChanged) row.spotBindingExplicit = true;
  delete row.__spotSelectionChanged;
  const spot = (data.spots || []).find((entry) => String(entry.id || entry._id) === row.spotId);
  if (spot && spot.cityId) row.cityId = spot.cityId;
  if (key === "packages") {
    row.makeupIncluded = row.makeupIncluded === true;
    row.hasAerial = row.hasAerial === true;
    row.fullEdit = row.fullEdit === true;
    row.videoDuration = Number(row.videoDuration || 0);
    if (row.videoDuration) row.durationText = `${row.videoDuration}秒`;
    row.finishedVideoCount = Number(row.finishedVideoCount ?? 1);
    row.deliveryCycle = String(row.deliveryCycle || "1–3 个工作日");
  }
  if (key === "albums") {
    row.makeupIncluded = row.makeupIncluded === true;
    for (const field of ["photoCountText", "retouchText", "makeupText"]) {
      if (row[field] !== undefined) row[field] = String(row[field] ?? "").trim();
    }
    row.retouchMode = albumRetouchMode(row);
    row.retouchCount = row.retouchMode === "count" ? Number(row.retouchCount ?? 0) : 0;
    row.shootingNotes = String(row.shootingNotes ?? row.intro ?? "").trim();
    row.intro = row.shootingNotes;
    if (row.isShow === false) row.status = "下架";
    else if (["下架", "已下架", "隐藏", "停用"].includes(row.status)) row.status = "上架";
    const series = (data.series || []).find((item) => String(item.id || item._id) === String(row.seriesId || ""));
    row.seriesName = series ? String(series.name || "") : String(row.seriesName || "").trim();
    if (Array.isArray(row.sampleUrls)) row.photoCount = albumPhotoUrls(row).length;
    delete row.originalPrice;
    delete row.specialPrice;
  }
  if (key === "peripherals") {
    row.retouchIncluded = row.retouchIncluded === true;
    row.editingIncluded = row.editingIncluded === true;
    row.description = String(row.intro ?? row.description ?? "").trim();
    if (row.isShow === false) row.status = "下架";
    else if (row.status === "下架") row.status = "上架";
  }
}
async function persistContentMutation(key, source, previous = null) {
  if (!source || !(source.id || source._id)) return false;
  if (["albums", "packages", "guides"].includes(key)) {
    if (state.contentSortSaving) {
      if (previous) Object.assign(source, previous);
      ElMessage.warning("内容或排序正在保存，请稍后再试");
      return false;
    }
    state.contentSortSaving = true;
    try { return await persistContentMutationUnlocked(key, source, previous); }
    finally { state.contentSortSaving = false; }
  }
  if (key !== "spots") return persistContentMutationUnlocked(key, source, previous);
  if (isSpotOrderSaving()) {
    if (previous) Object.assign(source, previous);
    ElMessage.warning("打卡点排序正在保存，请稍后再试");
    return false;
  }
  // Visibility changes share this lock so their replies cannot overwrite a newer rank.
  state.spotSortSaving = true;
  try { return await persistContentMutationUnlocked(key, source, previous); }
  finally { state.spotSortSaving = false; }
}
async function persistContentMutationUnlocked(key, source, previous = null) {
  if (!isServerConnected()) {
    if (previous) { Object.keys(source).forEach((field) => { if (!(field in previous)) delete source[field]; }); Object.assign(source, previous); }
    ElMessage.error("真实后端连接不可用，修改未保存");
    return false;
  }
  const raw = { ...source };
  if (key === "packages" && isPackageTitleLimited(source)) source.name = normalizePackageTitle(source.name);
  // A withdrawal must stay a partial visibility update. Product normalization
  // would otherwise add empty material and default flags to legacy products.
  const withdrawal = key === "peripherals" && peripheralWithdrawalPatch(raw, previous);
  if (!withdrawal) normalizeSingleProduct(source, key);
  const validation = withdrawal ? "" : validateContentPublishing(key, source, previous, { raw });
  if (validation) {
    if (previous) Object.assign(source, previous);
    ElMessage.warning(validation);
    return false;
  }
  if (!withdrawal && !(await ensureContentTags(source, key))) return false;
  const id = source.id || source._id;
  const payload = { ...(withdrawal || source), id, _id: id };
  delete payload.__key;
  delete payload.__source;
  delete payload.id;
  delete payload._id;
  if (["albums", "packages", "guides"].includes(key)) delete payload.sort;
  if (key === "spots" && previous && window.LXM_SPOT_ORDER.rank(source.sort) === window.LXM_SPOT_ORDER.rank(previous.sort)) delete payload.sort;
  try {
    let saved;
    try {
      saved = await window.LXM_CLOUD.update(key, id, payload);
    } catch (error) {
      if (!error || error.status !== 404) throw error;
      saved = await window.LXM_CLOUD.create(key, { ...payload, id });
    }
    if (!confirmedContentSave(saved)) throw new Error((saved && saved.error) || "内容保存失败");
    if (["albums", "packages", "guides"].includes(key) && ctx.applyContentOrderResponse) saved = ctx.applyContentOrderResponse(key, saved);
    if (saved.id || saved._id) Object.assign(source, key === "spots" ? applySpotOrderResponse(saved) : saved);
    return true;
  } catch (error) {
    if (previous) Object.assign(source, previous);
    ElMessage.error((error && error.message) || "内容保存失败，请稍后重试");
    return false;
  }
}
// 软删除必须由真实后端确认。
async function syncDeleteToServer(key, id) {
  if (!isServerConnected() || !id) { ElMessage.error("真实后端连接不可用，删除未保存"); return false; }
  try {
    await window.LXM_CLOUD.update(key, id, { isDeleted: true, status: "停用", isShow: false });
  } catch (e) {
    ElMessage.error("删除未保存：" + (e && e.message || e));
    return false;
  }
}
function shelfTypeText(key, row = null) {
  if (key === "packages" && row?.type === "video") return "短视频产";
  return { albums: "照片单品", packages: "照片套餐", peripherals: "摄影周边" }[key] || "商品";
}
async function syncShelfPrice(row) {
  if (!row?.__source) return;
  if (row.__key === "peripherals" && row.__source.specMode === "multiple") {
    row.shelfPrice = Number(row.__source.price || 0);
    ElMessage.warning("多规格商品请在商品管理中修改各规格售价");
    return false;
  }
  const previous = { ...row.__source };
  row.__source.price = Number(row.shelfPrice || 0);
  if (row.__key === "packages") row.__source.specialPrice = Number(row.shelfPrice || 0);
  markProductAudit(row.__source, "调整货架价格");
  if (!(await persistContentMutation(row.__key, row.__source, previous))) return;
  log("调整商品价格", row.name, `${shelfTypeText(row.__key, row)} ${money(row.__source.price)}`);
  ElMessage.success("商品价格已保存到真实后端");
}
function uploadContentCover(event) {
  const input = event && event.target;
  const file = input && input.files && input.files[0];
  if (!file) return;
  const target = state.editContent;
  if (!target) return;
  window.LXM_UPLOAD.upload(file, { purpose: "content", collection: target.__key, recordId: target.id || undefined, imagesOnly: true,
    onUploaded(result) {
      target.cover = result.url;
      if (target.__key === "samples" && target.type !== "video") target.url = result.url;
      ElMessage.success("图片已上传，保存后生效");
    }
  });
  if (input) input.value = "";
}
function applyCoverUrl(event) {
  const value = (event && event.target ? event.target.value : event || "").trim();
  if (!state.editContent) return;
  if (window.LXM_UPLOAD.temporary(value)) return ElMessage.warning("本地图片请使用上传按钮");
  state.editContent.cover = value;
  if (state.editContent.__key === "samples" && state.editContent.type !== "video") state.editContent.url = value;
}
async function toggleShelf(row) {
  if (!row?.__source) return;
  const previous = { ...row.__source };
  row.__source.status = row.__source.isShow === false ? "下架" : "上架";
  if (row.__key === "peripherals") row.__source.enabled = row.__source.isShow !== false;
  markProductAudit(row.__source, row.__source.status === "上架" ? "商品上架" : "商品下架");
  if (!(await persistContentMutation(row.__key, row.__source, previous))) return;
  log(row.__source.isShow === false ? "商品下架" : "商品上架", row.name, shelfTypeText(row.__key, row));
  ElMessage.success(`${row.name} ${row.__source.isShow === false ? "下架" : "上架"}`);
}
async function saveShelfInline(row, field) {
  if (!row?.__source) return;
  const previous = { ...row.__source };
  markProductAudit(row.__source, `调整货架${field}`);
  if (!(await persistContentMutation(row.__key, row.__source, previous))) return;
  log("调整商品货架", row.name, `${field}：${row.__source.tag || "-"}`);
  ElMessage.success("商品货架信息已更");
}
function shelfRecommendationText(row) {
  if (row?.__source?.isMainPush || row?.isMainPush || row?.mainPush) return "首页主推";
  if (row?.tag) return row.tag;
  if (row?.__key === "albums") return "照片单品";
  if (row?.__key === "peripherals") return "周边货架";
  return row?.type === "video" ? "短视频专" : "套餐列表";
}
function shelfAuditText(row) {
  if (row?.auditStatus) return row.auditStatus;
  if (row?.status === "草稿" || row?.status === "待审" || row?.status === "驳回") return row.status;
  return productStatus(row) === "上架" ? "已上" : "已下";
}
function shelfStatusType(row) {
  const status = shelfAuditText(row);
  if (status === "已上" || productStatus(row) === "上架") return "success";
  if (status === "待审") return "warning";
  if (status === "草稿") return "info";
  if (status === "驳回") return "danger";
  return "info";
}
function onShelfSelectionChange(rows) {
  state.selectedShelfKeys = (rows || []).map(shelfRowKey);
}
function selectedShelfSources() {
  const keys = new Set(state.selectedShelfKeys || []);
  return shelfRows().filter((row) => keys.has(shelfRowKey(row)) && row.__source);
}
async function applyShelfBatchAction(action) {
  const rows = selectedShelfSources();
  if (!rows.length) return ElMessage.warning("请先勾选需要批量处理的商品");
  const actionText = { on: "批量上架", off: "批量下架", main: "批量设主", tag: "批量打标", schedule: "批量配置定时" }[action] || "批量操作";
  const originals = rows.map((row) => [row.__source, { ...row.__source }]);
  rows.forEach((row) => {
    if (action === "on") {
      row.__source.isShow = true;
      row.__source.status = "上架";
    }
    if (action === "off") {
      row.__source.isShow = false;
      row.__source.status = "下架";
    }
    if (action === "main") row.__source.isMainPush = true;
    if (action === "tag") row.__source.tag = row.__source.tag || "运营推荐";
    if (action === "schedule") row.__source.scheduledOnAt = row.__source.scheduledOnAt || "下个运营档期";
    markProductAudit(row.__source, actionText || "批量货架操作");
  });
  for (const [source, previous] of originals) {
    const row = rows.find((item) => item.__source === source);
    if (!(await persistContentMutation(row.__key, source, previous))) {
      originals.forEach(([target, original]) => Object.assign(target, original));
      return;
    }
  }
  log(actionText, "商品货架", `${rows.length} 个商品`);
  ElMessage.success(`${actionText}已应用到 ${rows.length} 个商品`);
}
function previewContent(row) {
  const key = row?.__key || effectiveContentKey();
  openProduct({ ...row, type: key === "albums" ? "album" : key === "packages" ? (row.type === "video" ? "video" : "package") : "sample" });
}
function clearContentFilters() {
  Object.assign(state.filters, { keyword: "", contentStatus: "", contentSpotId: "", contentSeriesId: "", shelfType: "" });
  state.contentScope = { type: "", id: "" };
}
async function uploadHomeMaterial() {
  window.LXM_UPLOAD.pick({ purpose: "content", collection: "samples", imagesOnly: true, multiple: true, async onUploaded(file) {
  const sample = {
    id: `sample_${file.fileId || file.id}`,
    name: file.name,
    type: "photo",
    albumId: firstActiveContentId(data.albums),
    seriesId: firstActiveContentId(data.series),
    spotId: firstActiveContentId(data.spots),
    isShowcase: true,
    url: file.url,
    cover: file.url
  };
  if (!data.samples.some((item) => item.id === sample.id)) data.samples.unshift(sample);
  if (!(await persistContentMutation("samples", sample))) {
    data.samples = data.samples.filter((item) => item !== sample);
    throw new Error("样片资料保存失败，请重试");
  }
  state.homeConfig.carouselIds = [sample.id, ...(state.homeConfig.carouselIds || []).filter((id) => id !== sample.id)].slice(0, 6);
  if (isServerConnected()) await saveHomeConfig(true);
  log("上传首页素材", "首页配置", sample.name);
  ElMessage.success("首页轮播素材已上传");
  } });
}
const HOME_MODULE_ALIASES = { features: "guides", bookingAlbums: "albums", hotPackages: "mainPush" };
function isHomeModuleEnabled(key) {
  const config = state.homeConfig || {};
  const modules = Array.isArray(config.homeModules) ? config.homeModules : config.modules;
  const current = Array.isArray(modules) && modules.find((item) => item && item.key === key);
  if (current) return current.visible !== false && current.enabled !== false;
  if (Array.isArray(modules)) return true;
  if (Array.isArray(config.enabledModules)) {
    return config.enabledModules.includes(key) || config.enabledModules.includes(HOME_MODULE_ALIASES[key]);
  }
  return true;
}
function toggleHomeModule(key) {
  const options = ctx.homeModuleOptions || [];
  if (!options.some((item) => item.key === key)) return;
  const next = !isHomeModuleEnabled(key);
  const modules = options.map((item, index) => {
    const visible = item.key === key ? next : isHomeModuleEnabled(item.key);
    const previous = (state.homeConfig.homeModules || []).find((row) => row.key === item.key) || {};
    return { ...previous, key: item.key, title: item.label, visible, enabled: visible, sort: (index + 1) * 10 };
  });
  state.homeConfig.homeModules = modules;
  state.homeConfig.enabledModules = modules.filter((item) => item.visible).map((item) => item.key);
  log("调整首页模块", "首页配置", options.find((item) => item.key === key).label);
}
function toggleHomeSelection(field, id, limit = 6) {
  const list = state.homeConfig[field] || (state.homeConfig[field] = []);
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  else {
    if (list.length >= limit) return ElMessage.warning(`最多选择 ${limit} 个`);
    list.push(id);
  }
}
function buildMiniProgramHomeConfig() {
  // Only the two carousels are editable here. Keep other saved settings intact.
  const config = JSON.parse(JSON.stringify(state.homeConfig || {}));
  delete config.editorConfig;
  const targetAliases = {
    photo_package: "package", photo: "album", photo_collection: "album", video_single: "video", video_product: "video",
    packages: "package_list", spots: "explore", spot_list: "explore", all_spots: "explore", videos: "explore",
    video_list: "explore", guide_list: "guides", peripherals: "peripheral", albums: "photo_list",
    album_list: "photo_list", booking_albums: "photo_list", photos: "photo_list", static: "none"
  };
  const supportedTargets = new Set(["none", "package", "package_list", "album", "photo_list", "video", "spot", "peripheral", "guide", "guides", "external", "explore", "booking", "my"]);
  const detailTargets = new Set(["package", "album", "video", "spot", "peripheral", "guide"]);
  const normalizeBanner = (b, index, group) => {
    b = b || {};
    const type = (b.type || b.mediaType) === "video" ? "video" : "image";
    const rawTarget = String(b.targetType ?? b.linkType ?? b.jumpType ?? "none").trim()
      .replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
    const target = targetAliases[rawTarget] || rawTarget;
    const targetType = supportedTargets.has(target) ? target : "none";
    // Use a field allowlist: retired city, visibility, copy and link aliases
    // must not invisibly restrict a banner or override the selected behavior.
    return {
      _id: b._id || b.id || `${group}-banner-${index + 1}`,
      type, mediaType: type,
      url: String(b.url ?? (type === "video" ? b.videoUrl || b.fileID || b.fileId || "" : b.imageUrl || b.imgUrl || b.image || b.src || b.fileID || b.fileId || b.cover || "")).trim(),
      cover: String(b.cover ?? b.poster ?? "").trim(),
      targetType,
      targetId: detailTargets.has(targetType) ? String(b.targetId ?? b.linkId ?? b.jumpId ?? "").trim() : "",
      linkUrl: targetType === "external" ? String(b.linkUrl ?? b.jumpUrl ?? b.targetUrl ?? "").trim() : ""
    };
  };
  const normalizeList = (rows, group) => (Array.isArray(rows) ? rows : [])
    .filter((b) => b && typeof b === "object")
    .map((b, index) => normalizeBanner(b, index, group)).filter((b) => b.url).slice(0, 6);
  const homeBanners = normalizeList(Array.isArray(config.homeBanners) ? config.homeBanners : config.banners, "home");
  return {
    ...config,
    bannerConfigVersion: 1,
    banners: homeBanners,
    homeBanners,
    exploreBanners: normalizeList(config.exploreBanners, "explore"),
    carouselIds: []
  };
}
function exportHomeConfigJson() {
  const payload = buildMiniProgramHomeConfig();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `luxiaoming-home-config-${LXMFormat.date(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  log("导出小程序首页配置", "首页配置", state.homeConfig.activity);
  ElMessage.success("已导出小程序首页配置 JSON");
}
async function saveHomeConfig(fromUpload = false) {
  if (!isServerConnected()) {
    const error = new Error("真实后端连接不可用，轮播配置未保存");
    if (fromUpload === true) throw error;
    ElMessage.error(error.message); return false;
  }
  if (fromUpload !== true && !window.LXM_UPLOAD.ready()) return false;
  log("保存小程序轮播配置", "小程序轮播", "首页轮播、探索页轮播");
  const payload = buildMiniProgramHomeConfig();
  // Both envelopes must agree, including deliberately cleared arrays. The
  // storage adapter otherwise backfills them from the old editor snapshot.
  payload.editorConfig = JSON.parse(JSON.stringify(payload));
  try {
    const res = await window.LXM_CLOUD.upsertDoc("homeConfig", "homeStats", payload);
    if (!confirmedContentSave(res)) throw new Error(res && res.error || "服务端未确认轮播配置保存");
    const tip = "已保存到真实后端";
    ElMessage.success("小程序轮播配置" + tip);
    return true;
  } catch (e) {
    if (fromUpload === true) throw e;
    ElMessage.error("保存失败，请重试：" + (e && e.message ? e.message : e));
    return false;
  }
}
// 小程序全局配置保存：把约拍定价 / 预约须知 / 隐私政策 / 企微 / 搜索热词 / 足迹章册 写入 config/global
async function saveSiteConfig() {
  if (!isServerConnected()) { ElMessage.error("真实后端连接不可用，全局配置未保存"); return false; }
  const c = state.siteConfig || {};
  const payload = {
    _id: "global",
    customPrice: c.customPrice || {},
    bookingNotice: Array.isArray(c.bookingNotice) ? c.bookingNotice : [],
    privacyText: c.privacyText || "",
    // Content operators may edit the user-facing guide text, but never send
    // integration credentials back through the config endpoint.
    wechat: state.role === "content" ? { guideText: c.wechat?.guideText || "" } : (c.wechat || {}),
    search: {
      hotwords: Array.isArray(c.search?.hotwords) ? c.search.hotwords : []
    },
    footprint: c.footprint || {},
    updatedAt: new Date().toISOString()
  };
  try {
    const res = await window.LXM_CLOUD.upsertDoc("siteConfig", "global", payload);
    if (!confirmedContentSave(res)) throw new Error(res && res.error || "服务端未确认全局配置保存");
    const tip = "已保存到真实后端";
    ElMessage.success("小程序全局配置" + tip);
    return true;
  } catch (e) {
    ElMessage.error("保存失败，修改未生效：" + (e && e.message ? e.message : e));
    return false;
  }
}

  return {
    contentPhotographerOptions,
    contentPhotographersLoading,
    contentPhotographersError,
    contentPhotographerName,
    loadContentPhotographers,
    clearContentPhotographers,
    packageTitleLimit: PACKAGE_TITLE_LIMIT,
    normalizePackageTitle,
    packageTitleLength,
    isPackageTitleLimited,
    packageTitleError,
    albumRetouchMode,
    albumPhotoUrls,
    setAlbumCover,
    addAlbumPhoto,
    removeAlbumPhoto,
    replaceAlbumPhoto,
    applyAlbumShootingTemplate,
    ensureContentTags,
    validateContentPublishing,
    hydrateProductSpot,
    markContentSpotChange,
    videoSingleRows,
    isVideoSingleProduct,
    filterVideoSingleRows,
    videoSingleStatus,
    contentVideoUrl,
    openVideoSingle,
    saveVideoSingle,
    deleteVideoSingle,
    toggleVideoSingleShelf,
    openSeries,
    saveSeries,
    requestDeleteSeries,
    requestDeleteCity,
    contentCreateLabel,
    contentQuickActions,
    openContentFromScope,
    amapPickerCoordinateText,
    amapPickerAddressText,
    amapCoordinateSystemText,
    amapPickerSearchResultText,
    openAmapPicker,
    retryAmapPicker,
    clearAmapPickerSearchResults,
    searchAmapPicker,
    selectAmapPickerSearchResult,
    closeAmapPicker,
    onAmapPickerClosed,
    applyAmapPickerCoordinate,
    relationText,
    guideProductOptions,
    guideTargetValue,
    changeGuideSpot,
    moveGuideMedia,
    removeGuideMedia,
    openContent,
    openContentQuick,
    addIncludedItem,
    saveContent,
    pushContentToCloud,
    isServerConnected,
    persistContentMutation,
    persistSpotSort,
    isSpotOrderSaving,
    syncDeleteToServer,
    shelfTypeText,
    syncShelfPrice,
    uploadContentCover,
    applyCoverUrl,
    toggleShelf,
    saveShelfInline,
    shelfRecommendationText,
    shelfAuditText,
    shelfStatusType,
    onShelfSelectionChange,
    selectedShelfSources,
    applyShelfBatchAction,
    previewContent,
    clearContentFilters,
    uploadHomeMaterial,
    isHomeModuleEnabled,
    toggleHomeModule,
    toggleHomeSelection,
    buildMiniProgramHomeConfig,
    exportHomeConfigJson,
    saveHomeConfig,
    saveSiteConfig
  };
});
