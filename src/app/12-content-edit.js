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

function contentCover(title, subtitle) {
  return typeof LXM_SVG === "function" ? LXM_SVG(title, subtitle) : "";
}

const DEFAULT_AMAP_CENTER = { longitude: 112.938814, latitude: 28.228209, coordType: "gcj02" };
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
  if (await persistTrashRecord(row)) return true;
  Object.assign(source, previous);
  await persistContentMutation(key, source, null);
  return false;
}

const videoSingleRows = computed(() => {
  // 短视频统一存进 packages 集合（type=video + isVideoSingle），小程序读 packages 作为视频商品，无需另接
  let list = data.packages.filter((r) => !r.deleted && r.type === "video" && r.isVideoSingle);
  const f = state.filters;
  if (f.contentSpotId) list = list.filter((r) => r.spotId === f.contentSpotId || (r.spotIds || []).includes(f.contentSpotId));
  if (f.contentSeriesId) list = list.filter((r) => r.seriesId === f.contentSeriesId);
  if (f.contentStatus) list = list.filter((r) => videoSingleStatus(r) === f.contentStatus || (r.status || (r.isShow === false ? "下架" : "上架")) === f.contentStatus);
  if (f.keyword) {
    const kw = (f.keyword || "").toLowerCase();
    list = list.filter((r) => (r.title || r.name || "").toLowerCase().includes(kw) || (r.tags || []).join(",").toLowerCase().includes(kw));
  }
  return list;
});
function videoSingleStatus(row) {
  if (row.status) return row.status;
  return row.isShow === false ? "下架" : "上架";
}
function openVideoSingle(row = null) {
  // 短视频统一存进 packages 集合（type=video + isVideoSingle），小程序读 packages 作为视频商品，无需另接。
  state.videoSingleForm = row
    ? { ...row, __key: "packages", title: row.title || row.name, name: row.name || row.title, tags: Array.isArray(row.tags) ? [...row.tags] : [] }
    : { __key: "packages", id: `pkg_vs_${Date.now()}`, title: "", name: "", seriesId: (data.series[0] && data.series[0].id) || "", spotId: (data.spots[0] && data.spots[0].id) || "", cover: contentCover("短视频", "封面"), videoUrl: "", previewVideoUrl: "", type: "video", productKind: "video_single", isVideoSingle: true, durationText: "", price: 0, status: "上架", isShow: true, isMainPush: false, tags: [], intro: "" };
  state.videoSingleDialog = true;
}
async function saveVideoSingle() {
  const form = state.videoSingleForm;
  if (!form) return;
  if (!form.title && !form.name) return ElMessage.warning("请填写短视频名称");
  form.title = form.title || form.name;
  form.name = form.name || form.title;
  form.type = "video";
  form.isVideoSingle = true;
  form.productKind = "video_single";
  const source = data.packages.find((item) => item.id === form.id);
  const previous = source ? { ...source } : null;
  const target = source || { ...form };
  if (source) {
    Object.assign(source, form);
  } else {
    data.packages.unshift(target);
  }
  if (isServerConnected() && !(await persistContentMutation("packages", target, previous))) {
    if (!source) data.packages = data.packages.filter((item) => item !== target);
    return;
  }
  log(source ? "编辑短视频" : "新增短视频", "短视频", form.title);
  state.videoSingleDialog = false;
  ElMessage.success(source ? "已保存短视频" : "已新增短视频");
}
async function deleteVideoSingle(row) {
  const source = data.packages.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  source.isShow = false;
  source.status = "下架";
  if (!(await persistContentMutation("packages", source, previous))) return;
  if (!(await addTrash("packages", source, previous, { id: `trash-vs-${source.id}-${Date.now()}`, type: "短视频", sourceKey: "packages", name: source.title || source.name, reason: "删除短视频", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } }))) return;
  log("删除短视频进入回收站", "短视频", source.title || source.name);
  ElMessage.success("短视频已进入回收站，可由超管恢复");
}
async function toggleVideoSingleShelf(row) {
  const source = data.packages.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  const next = videoSingleStatus(source) === "下架";
  source.isShow = next;
  source.status = next ? "上架" : "下架";
  if (isServerConnected() && !(await persistContentMutation("packages", source, previous))) return;
  log(next ? "短视频上架" : "短视频下架", "短视频", source.title || source.name);
  ElMessage.success(`${source.title || source.name} 已${next ? "上架" : "下架"}`);
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
  if (isServerConnected() && !(await persistContentMutation("series", target, previous))) {
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
function openContent(row = null) {
  const matchesRow = (list) => row && (list || []).some((item) => contentRecordId(item) && contentRecordId(item) === contentRecordId(row));
  const defaultSpotId = firstActiveContentId(data.spots);
  const defaultSeriesId = firstActiveContentId(data.series);
  const defaultAlbumId = firstActiveContentId(data.albums);
  const rowKey = matchesRow(data.cities) ? "cities" : matchesRow(data.spots) ? "spots" : matchesRow(data.series) ? "series" : matchesRow(data.albums) ? "albums" : matchesRow(data.samples) ? "samples" : matchesRow(data.packages) ? "packages" : matchesRow(data.peripherals) ? "peripherals" : "";
  const key = row?.__key || rowKey || (row && state.active === "spots" ? effectiveContentKey() : state.active === "videoProducts" ? "packages" : state.active);
  const defaults = {
    spots: { name: "", cityId: "", tag: "推荐", tags: [], styles: [], address: "", district: "", latitude: null, longitude: null, coordType: "gcj02", description: "", hotScore: 8.5, checkinCount: 0, sort: 10, intro: "", status: "启用", isShow: true, image: "", cover: contentCover("新打卡点", "后台上传预览") },
    series: { name: "", spotId: defaultSpotId, spotIds: defaultSpotId ? [defaultSpotId] : [], style: "清新", styles: ["清新"], tags: [], intro: "", productType: "photo", soldCount: 0, minPrice: 0, maxPrice: 0, packageIds: [], status: "启用", cover: contentCover("新系", "拍摄风格封面") },
    albums: { name: "", spotId: defaultSpotId, seriesId: defaultSeriesId, price: 699, intro: "", photoCount: 0, shootingNotes: "", status: "启用", cover: contentCover("新合", "照片单品") },
    samples: { name: "", type: "photo", spotId: defaultSpotId, seriesId: defaultSeriesId, albumId: defaultAlbumId, status: "启用", url: contentCover("新样", "上传预览") },
    packages: { name: "", type: "photo", spotId: defaultSpotId, seriesId: defaultSeriesId, albumId: defaultAlbumId, originalPrice: 999, price: 699, specialPrice: 699, isMainPush: false, isShow: true, status: "上架", intro: "", description: "", serviceTags: ["精修9"], cover: contentCover("新套", "套餐封面") },
    addonServices: { name: "", category: "修图", price: 199, enabled: true, intro: "增值服务，仅客服处理订单时添加" },
    peripherals: { name: "", category: "相册", price: 99, enabled: true, isShow: true, intro: "", specs: [], isNew: false, images: [], cover: contentCover("新周", "摄影周边") },
    guides: { name: "", title: "", description: "", targetPackageId: "", status: "草稿", tag: "攻略", isHot: false, readCount: 0, score: "4.9", spotId: defaultSpotId, seriesId: defaultSeriesId, cover: contentCover("新攻", "内容运营") },
    stories: { name: "", title: "", subtitle: "", status: "草稿", tag: "故事", spotId: defaultSpotId, cover: contentCover("新故", "品牌故事") },
    cities: { name: "", mode: "直营", status: "运营中", visible: true, latitude: null, longitude: null, coordType: "gcj02" },
  };
  const sourceRow = row?.__source || row;
  state.editContent = sourceRow ? { ...sourceRow, __key: key } : { ...(defaults[key] || {}), id: "", __key: key };
  if (key === "spots") {
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
    }
  }
  if (key === "series") normalizeSeriesSpotRelations(state.editContent);
  if (key === "packages") {
    if (!sourceRow && state.active === "videoProducts") state.editContent.type = "video";
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
      deliveryCycle: state.editContent.deliveryCycle || "3天内交付",
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
  if (key === "albums") {
    Object.assign(state.editContent, {
      isSellable: state.editContent.isSellable ?? productStatus(state.editContent) !== "下架",
      allowMaterialUse: state.editContent.allowMaterialUse ?? true,
      tags: state.editContent.tags || (state.editContent.tag ? [state.editContent.tag] : []),
      photoMaterialEnabled: state.editContent.photoMaterialEnabled ?? true,
      videoMaterialEnabled: state.editContent.videoMaterialEnabled ?? true,
    });
  }
  if (key === "peripherals") {
    Object.assign(state.editContent, {
      mode: state.editContent.mode || peripheralModeText(state.editContent),
      specs: state.editContent.specs || state.editContent.spec || "标准",
      stock: state.editContent.stock ?? state.editContent.stockQty ?? 30,
      isHot: state.editContent.isHot ?? false,
      deliveryCycle: state.editContent.deliveryCycle || "3-5天发",
      scheduledOnAt: state.editContent.scheduledOnAt || "",
      scheduledOffAt: state.editContent.scheduledOffAt || "",
      auditStatus: state.editContent.auditStatus || (productStatus(state.editContent) === "上架" ? "已上" : "已下"),
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
  if (!keepInSpot && !["series", "albums", "samples"].includes(key)) state.active = key;
  if (keepInSpot) {
    const previousActive = state.active;
    state.active = key;
    openContent();
    state.active = previousActive;
  } else {
    openContent();
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
  const row = state.editContent;
  if (!row) return;
  if (!row.name && !row.title) return ElMessage.warning("请填写名称或标题");
  const key = row.__key;
  const target = contentList(key);
  const payload = { ...row };
  delete payload.__key;
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
  }
  if (key === "cities") {
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
  if (key === "peripherals") {
    ["price", "stock"].forEach((field) => {
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
    if (payload.mode === "全城通用") {
      payload.spotId = "";
      payload.spotIds = [];
    }
  }
  if (key === "guides") {
    payload.title = payload.title || payload.name || "";
    payload.description = payload.description ?? payload.intro ?? "";
    if (payload.cover) { payload.image = payload.cover; payload.coverUrl = payload.cover; }
    if (payload.readCount !== undefined && payload.readCount !== "") payload.readCount = Number(payload.readCount || 0);
    if (!payload.score) payload.score = "4.9";
  }
  if (key === "spots") {
    payload.image = payload.cover || payload.image || "";
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
  if (isServerConnected()) {
    persisted = await pushContentToCloud(key, payload);
    if (!persisted) return;
    Object.assign(payload, persisted);
  }
  if (!isNew) {
    const index = target.findIndex((item) => item.id === payload.id);
    if (index >= 0) Object.assign(target[index], payload);
  } else {
    target.unshift(payload);
  }
  state.contentDialog = false;
  log("保存内容", activeMenu.value.label, payload.name || payload.title);
  if (isServerConnected()) {
    ElMessage.success("内容已同步到服务端，小程序将读取最新内容");
  } else {
    ElMessage.success("内容已保存到本地（未连接服务端，启动后台后将自动同步）");
  }
}
// 自托管 / 云模式：把内容写回服务端数据源（db.json / 云数据库），从而真正控制小程序展示。
// 新增项在 saveContent 里已预置 payload.id，服务端可能还没有该 id，先 update 失败则回退 create。
async function pushContentToCloud(key, payload) {
  try {
    const doc = { ...payload, isDeleted: false };
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
    if (res && res.error) throw new Error(res.error);
    const id = String((res && (res.id || res._id)) || payload.id || "");
    return { ...payload, ...(res && typeof res === "object" ? res : {}), id, _id: id };
  } catch (e) {
    ElMessage.error("服务端保存失败，未修改本地内容：" + (e && e.message ? e.message : e));
    return null;
  }
}
// 是否已连接自托管/云服务端（/api/health 返回的 mode 不是 mock 即视为已连接）。
function isServerConnected() {
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  return !!(window.LXM_CLOUD && window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
}
async function persistContentMutation(key, source, previous = null) {
  if (!source || !(source.id || source._id) || !isServerConnected()) return true;
  const id = source.id || source._id;
  const payload = { ...source, id, _id: id };
  delete payload.__key;
  delete payload.__source;
  delete payload.id;
  delete payload._id;
  try {
    let saved;
    try {
      saved = await window.LXM_CLOUD.update(key, id, payload);
    } catch (error) {
      if (!error || error.status !== 404) throw error;
      saved = await window.LXM_CLOUD.create(key, payload);
    }
    if (!saved || saved.error) throw new Error((saved && saved.error) || "内容保存失败");
    Object.assign(source, saved);
    return true;
  } catch (error) {
    if (previous) Object.assign(source, previous);
    ElMessage.error((error && error.message) || "内容保存失败，请稍后重试");
    return false;
  }
}
// 删除：软删除同步到服务端（小程序按 isDeleted 过滤，删除项不再展示）。失败仅告警，不影响本地回收站。
async function syncDeleteToServer(key, id) {
  if (!isServerConnected() || !id) return;
  try {
    await window.LXM_CLOUD.update(key, id, { isDeleted: true, status: "停用", isShow: false });
  } catch (e) {
    console.warn("[cloud] 同步删除失败（不影响本地回收站）", key, id, e);
  }
}
function shelfTypeText(key, row = null) {
  if (key === "packages" && row?.type === "video") return "短视频产";
  return { albums: "照片单品", packages: "照片套餐", peripherals: "摄影周边" }[key] || "商品";
}
async function syncShelfPrice(row) {
  if (!row?.__source) return;
  const previous = { ...row.__source };
  row.__source.price = Number(row.shelfPrice || 0);
  if (row.__key === "packages") row.__source.specialPrice = Number(row.shelfPrice || 0);
  markProductAudit(row.__source, "调整货架价格");
  if (!(await persistContentMutation(row.__key, row.__source, previous))) return;
  log("调整商品价格", row.name, `${shelfTypeText(row.__key, row)} ${money(row.__source.price)}`);
  ElMessage.success("商品价格已更新到货架演示数据");
}
function uploadContentCover(event) {
  const input = event && event.target;
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) { ElMessage.warning("请选择图片文件"); if (input) input.value = ""; return; }
  if (file.size > 2 * 1024 * 1024) { ElMessage.warning("图片需小于 2MB"); if (input) input.value = ""; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const encodedSize = typeof dataUrl === "string" ? (typeof TextEncoder === "function" ? new TextEncoder().encode(dataUrl).length : dataUrl.length) : 0;
    if (encodedSize > 60000) {
      ElMessage.warning("图片编码超过数据库字段上限，请压缩图片或填写可访问的图片地址");
      return;
    }
    if (!state.editContent) return;
    state.editContent.cover = dataUrl;
    if (state.editContent.__key === "samples") state.editContent.url = dataUrl;
    ElMessage.success("封面已加载，保存后生效");
  };
  reader.onerror = () => ElMessage.error("图片读取失败");
  reader.readAsDataURL(file);
  if (input) input.value = "";
}
function applyCoverUrl(event) {
  const value = (event && event.target ? event.target.value : event || "").trim();
  if (!state.editContent) return;
  state.editContent.cover = value;
  if (state.editContent.__key === "samples") state.editContent.url = value;
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
  const sample = {
    id: `sample${Date.now()}`,
    name: "首页新轮播素",
    type: "photo",
    albumId: firstActiveContentId(data.albums),
    seriesId: firstActiveContentId(data.series),
    spotId: firstActiveContentId(data.spots),
    isShowcase: true,
    url: contentCover("首页新素", "即时预览")
  };
  data.samples.unshift(sample);
  if (!(await persistContentMutation("samples", sample))) {
    data.samples = data.samples.filter((item) => item !== sample);
    return;
  }
  state.homeConfig.carouselIds = [sample.id, ...(state.homeConfig.carouselIds || [])].slice(0, 6);
  if (isServerConnected()) await saveHomeConfig();
  log("上传首页素材", "首页配置", sample.name);
  ElMessage.success("演示版已添加一张首页轮播素材");
}
function toggleHomeModule(key) {
  const list = state.homeConfig.enabledModules || (state.homeConfig.enabledModules = []);
  const index = list.indexOf(key);
  if (index >= 0) list.splice(index, 1);
  else list.push(key);
  log("调整首页模块", "首页配置", ctx.homeModuleOptions.find((item) => item.key === key)?.label || key);
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
  const enabledModules = state.homeConfig.enabledModules || [];
  const carouselIds = state.homeConfig.carouselIds || [];
  const featuredPackageIds = state.homeConfig.featuredPackageIds || [];
  const featuredAlbumIds = state.homeConfig.featuredAlbumIds || [];
  const featuredPeripheralIds = state.homeConfig.featuredPeripheralIds || [];
  const configuredHomeBanners = Array.isArray(state.homeConfig.homeBanners)
    ? state.homeConfig.homeBanners.map((b, index) => ({
      _id: b && (b._id || b.id) || `home-banner-${index + 1}`,
      type: b && (b.type || b.mediaType) === "video" ? "video" : "image",
      url: b && (b.url || b.image || b.imageUrl) || "",
      cover: b && (b.cover || b.poster) || "",
      title: b && b.title || "",
      targetType: b && (b.targetType || b.linkType || b.jumpType) || "none",
      targetId: b && (b.targetId || b.linkId || b.jumpId) || "",
      linkUrl: b && (b.linkUrl || b.jumpUrl || b.targetUrl) || "",
      effectiveTime: b && b.effectiveTime || ""
    }))
    : [];
  const configuredExploreBanners = Array.isArray(state.homeConfig.exploreBanners)
    ? state.homeConfig.exploreBanners.map((b, index) => ({
      _id: b && (b._id || b.id) || `explore-banner-${index + 1}`,
      type: b && (b.type || b.mediaType) === "video" ? "video" : "image",
      url: b && (b.url || b.image || b.imageUrl) || "",
      cover: b && (b.cover || b.poster) || "",
      title: b && b.title || "",
      targetType: b && (b.targetType || b.linkType || b.jumpType) || "none",
      targetId: b && (b.targetId || b.linkId || b.jumpId) || "",
      linkUrl: b && (b.linkUrl || b.jumpUrl || b.targetUrl) || "",
      effectiveTime: b && b.effectiveTime || ""
    }))
    : [];
  const sampleBanners = carouselIds.map((id, index) => {
    const s = data.samples.find((x) => x.id === id) || {};
    return {
      _id: id,
      id,
      sort: index + 1,
      type: "image",
      url: s.url || "",
      cover: s.cover || s.url || "",
      targetType: "package_list",
      targetId: "",
      linkUrl: ""
    };
  });
  const pageModules = ctx.pageConfigPages.reduce((map, page) => {
    map[page.key] = {
      ...ctx.makeDefaultPageConfig(page.key),
      ...((state.homeConfig.pageModules || {})[page.key] || {})
    };
    return map;
  }, {});
  const moduleDefinitions = [
    { key: "hotSpots", legacyKey: "spots", title: "预约打卡点", subtitle: "点击进入点位详情，只看该点位相关产品" },
    { key: "features", legacyKey: "guides", title: "特色专区", subtitle: "旅拍灵感、攻略故事、周边内容入口" },
    { key: "bookingAlbums", legacyKey: "albums", title: "照片单品", subtitle: "照片单品商品，进入对应风格系列" },
    { key: "videoProducts", legacyKey: "videoProducts", title: "城市短视频", subtitle: "短视频商品与套餐独立展示" },
    { key: "hotPackages", legacyKey: "mainPush", title: "热门套餐", subtitle: "照片套餐与短视频分别进入对应详情" },
    { key: "peripherals", legacyKey: "peripherals", title: "旅拍周边", subtitle: "相册、冲印、纪念小物等补充商品" }
  ];
  const isModuleEnabled = (item) => enabledModules.includes(item.key) || enabledModules.includes(item.legacyKey);
  return {
    cityName: state.homeConfig.cityName,
    shopServiceText: state.homeConfig.shopServiceText,
    activityNotice: state.homeConfig.notice,
    hero: {
      title: state.homeConfig.activity,
      subtitle: state.homeConfig.heroSubtitle,
      trustOrders: state.homeConfig.trustOrders,
      trustRate: state.homeConfig.trustRate
    },
    // Advanced home banners take precedence when they have media; the
    // sample-carousel remains the public fallback when the editor list is
    // empty or still contains only blank placeholders.
    banners: configuredHomeBanners.some((b) => b.url || b.cover) ? configuredHomeBanners : sampleBanners,
    homeBanners: configuredHomeBanners,
    homeModules: moduleDefinitions.map((item, index) => ({
      key: item.key,
      title: item.title,
      subtitle: item.subtitle,
      moreText: item.moreText || "",
      enabled: isModuleEnabled(item),
      visible: isModuleEnabled(item),
      sort: (index + 1) * 10
    })),
    recommendations: {
      hotSpotIds: data.spots.slice(0, 6).map((item) => item.id || item._id),
      hotPackageIds: featuredPackageIds,
      featuredAlbumIds,
      peripheralIds: featuredPeripheralIds,
      guideIds: data.guides.slice(0, 4).map((item) => item.id || item._id)
    },
    pageModules,
    // 探索页轮播：与首页轮播「单独一套」，后台在 mini-decor 独立配置，互不干扰
    exploreBanners: configuredExploreBanners,
    // 首页快捷入口（可后台配置的"导航"）：tabBar 不可运行时改，这里用首页快捷入口承载
    quickNav: state.homeConfig.quickNav || []
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
async function saveHomeConfig() {
  log("保存首页装修配置", "小程序装修", state.homeConfig.activity);
  const payload = buildMiniProgramHomeConfig();
  // 把后台编辑器模型一并存进文档：小程序只读顶部字段，自动忽略 editorConfig，
  // 后台读回时用它无损还原（避免两套结构互相覆盖）。
  payload.editorConfig = state.homeConfig;
  try {
    // cloud 模式：写入小程序云环境 config/homeStats，游客端小程序实时生效；
    // mock 模式（npm run server）：写入本地演示库，供后台内部预览/回读。
    const res = await window.LXM_CLOUD.upsertDoc("homeConfig", "homeStats", payload);
    if (res && res.error) throw new Error(res.error);
    const tip = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE !== "mock"
      ? "已保存到服务端（真实数据，小程序将读取）"
      : "已保存到本地演示，连接服务端后可同步到小程序";
    ElMessage.success("小程序首页装修" + tip);
  } catch (e) {
    // 纯静态演示（npm run dev 无 /api 服务）时，本地快照仍会保留编辑内容，刷新不丢
    ElMessage.warning("已保存到本地，连接服务端后可同步到小程序：" + (e && e.message ? e.message : e));
  }
}
// 小程序全局配置保存：把约拍定价 / 预约须知 / 隐私政策 / 企微 / 搜索热词 / 足迹章册 写入 config/global
async function saveSiteConfig() {
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
    if (res && res.error) throw new Error(res.error);
    const tip = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE !== "mock" ? "已保存到服务端（真实数据，小程序将读取）" : "已保存到本地演示，连接服务端后可同步到小程序";
    ElMessage.success("小程序全局配置" + tip);
  } catch (e) {
    ElMessage.warning("已保存到本地，连接服务端后可同步到小程序：" + (e && e.message ? e.message : e));
  }
}

  return {
    videoSingleRows,
    videoSingleStatus,
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
    openContent,
    openContentQuick,
    addIncludedItem,
    saveContent,
    pushContentToCloud,
    isServerConnected,
    persistContentMutation,
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
    toggleHomeModule,
    toggleHomeSelection,
    buildMiniProgramHomeConfig,
    exportHomeConfigJson,
    saveHomeConfig,
    saveSiteConfig
  };
});
