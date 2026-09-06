// 内容编辑、云端写回与首页装修
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    activeMenu,
    albumName,
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
    peripheralModeText,
    productStatus,
    seriesName,
    shelfRowKey,
    shelfRows,
    spotName,
    state,
    switchMenu
  } = ctx;

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
    : { __key: "packages", id: `pkg_vs_${Date.now()}`, title: "", name: "", seriesId: (data.series[0] && data.series[0].id) || "", spotId: (data.spots[0] && data.spots[0].id) || "", cover: LXM_SVG("短视频", "封面"), videoUrl: "", previewVideoUrl: "", type: "video", productKind: "video_single", isVideoSingle: true, durationText: "", price: 0, status: "上架", isShow: true, isMainPush: false, tags: [], intro: "" };
  state.videoSingleDialog = true;
}
function saveVideoSingle() {
  const form = state.videoSingleForm;
  if (!form) return;
  if (!form.title && !form.name) return ElMessage.warning("请填写短视频名称");
  form.title = form.title || form.name;
  form.name = form.name || form.title;
  form.type = "video";
  form.isVideoSingle = true;
  form.productKind = "video_single";
  const source = data.packages.find((item) => item.id === form.id);
  if (source) {
    Object.assign(source, form);
    log("编辑短视频", "短视频", form.title);
    ElMessage.success("已保存短视频");
  } else {
    data.packages.unshift({ ...form });
    log("新增短视频", "短视频", form.title);
    ElMessage.success("已新增短视频");
  }
  state.videoSingleDialog = false;
  if (isServerConnected()) pushContentToCloud("packages", source || form);
}
function deleteVideoSingle(row) {
  const source = data.packages.find((item) => item.id === row.id) || row;
  source.deleted = true;
  source.status = "下架";
  state.trash.unshift({ id: `trash-vs-${source.id}-${Date.now()}`, type: "短视频", name: source.title || source.name, reason: "删除短视频", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } });
  log("删除短视频进入回收站", "短视频", source.title || source.name);
  syncDeleteToServer("packages", source.id);
  ElMessage.success("短视频已进入回收站，可由超管恢复");
}
function toggleVideoSingleShelf(row) {
  const source = data.packages.find((item) => item.id === row.id) || row;
  const next = videoSingleStatus(source) === "下架";
  source.isShow = next;
  source.status = next ? "上架" : "下架";
  log(next ? "短视频上架" : "短视频下架", "短视频", source.title || source.name);
  if (isServerConnected()) pushContentToCloud("packages", source);
  ElMessage.success(`${source.title || source.name} 已${next ? "上架" : "下架"}`);
}
// ===== 拍摄风格：降级为分类词表管理（保留 seriesId 外键，去除内容实体属性）=====
function openSeries(row = null) {
  state.seriesForm = row
    ? { ...row }
    : { id: `ser${Date.now()}`, name: "", style: "", intro: "", cover: LXM_SVG("拍摄风格", "分类封面"), spotId: (data.spots[0] && data.spots[0].id) || "", spotIds: [(data.spots[0] && data.spots[0].id) || ""], productType: "photo", isHot: false, status: "启用" };
  state.seriesDialog = true;
}
function saveSeries() {
  const form = state.seriesForm;
  if (!form || !form.name) return ElMessage.warning("请填写拍摄风格名称");
  const source = data.series.find((item) => item.id === form.id);
  if (source) {
    Object.assign(source, form);
    log("编辑拍摄风格", "拍摄风格", form.name);
    ElMessage.success("已保存拍摄风格");
  } else {
    data.series.unshift({ ...form });
    log("新增拍摄风格", "拍摄风格", form.name);
    ElMessage.success("已新增拍摄风格");
  }
  state.seriesDialog = false;
}
function requestDeleteSeries(row) {
  const refAlbums = data.albums.filter((a) => a.seriesId === row.id).length;
  const refPackages = data.packages.filter((p) => p.seriesId === row.id).length;
  const refVideos = (data.packages || []).filter((v) => v.isVideoSingle && v.seriesId === row.id).length;
  if (refAlbums + refPackages + refVideos > 0) {
    return ElMessage.warning(`该拍摄风格仍被引用：照片单品 ${refAlbums}、套餐 ${refPackages}、短视频 ${refVideos}，不能直接删除`);
  }
  const source = data.series.find((item) => item.id === row.id) || row;
  source.deleted = true;
  state.trash.unshift({ id: `trash-ser-${source.id}-${Date.now()}`, type: "拍摄风格", name: source.name, reason: "删除拍摄风格", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } });
  log("删除拍摄风格进入回收站", "拍摄风格", source.name);
  syncDeleteToServer("series", source.id);
  ElMessage.success("拍摄风格已进入回收站，可由超管恢复");
}

function requestDeleteCity(row) {
  const refShops = data.shops.filter((s) => s.cityId === row.id).length;
  const source = data.cities.find((item) => item.id === row.id) || row;
  source.deleted = true;
  source.status = "筹备中";
  state.trash.unshift({ id: `trash-city-${source.id}-${Date.now()}`, type: "城市", name: source.name, reason: "删除城市", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } });
  log("删除城市进入回收站", "城市管理", source.name);
  syncDeleteToServer("cities", source.id);
  ElMessage.success(refShops > 0 ? `城市已进入回收站（仍有 ${refShops} 个商家引用，恢复后自动归位）` : "城市已进入回收站，可由超管恢复");
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
function openContentFromScope() {
  if (state.active === "shelfProducts") return switchMenu("packages");
  if (state.active !== "spots") return openContent();
  const scope = state.contentScope;
  if (scope.type === "spot") return openContentQuick("series", { spotId: scope.id });
  if (scope.type === "video") return openContentQuick("packages", { spotId: scope.id, type: "video", keepInSpot: true });
  if (scope.type === "series") {
    const ser = data.series.find((s) => s.id === scope.id) || {};
    return openContentQuick("albums", { spotId: ser.spotId || (ser.spotIds || [])[0] || "spot1", seriesId: scope.id });
  }
  if (scope.type === "album") {
    const alb = data.albums.find((a) => a.id === scope.id) || {};
    return openContentQuick("samples", { spotId: alb.spotId || "spot1", seriesId: alb.seriesId || "ser1", albumId: scope.id });
  }
  return openContentQuick("spots");
}
function relationText(row) {
  return [spotName(row.spotId), seriesName(row.seriesId), albumName(row.albumId)].filter((v) => v && v !== "-").join(" / ") || "全局";
}
function openContent(row = null) {
  const rowKey = row && data.cities.some((item) => item.id === row.id) ? "cities" : row && data.spots.some((item) => item.id === row.id) ? "spots" : row && data.series.some((item) => item.id === row.id) ? "series" : row && data.albums.some((item) => item.id === row.id) ? "albums" : row && data.samples.some((item) => item.id === row.id) ? "samples" : row && data.packages.some((item) => item.id === row.id) ? "packages" : row && data.peripherals.some((item) => item.id === row.id) ? "peripherals" : "";
  const key = row?.__key || rowKey || (row && state.active === "spots" ? effectiveContentKey() : state.active === "videoProducts" ? "packages" : state.active);
  const defaults = {
    spots: { name: "", cityId: "city1", tag: "推荐", tags: [], styles: [], address: "", description: "", hotScore: 8.5, checkinCount: 0, sort: 10, intro: "", status: "启用", isShow: true, image: "", cover: LXM_SVG("新打卡点", "后台上传预览") },
    series: { name: "", spotId: "spot1", spotIds: ["spot1"], style: "清新", styles: ["清新"], tags: [], intro: "", productType: "photo", soldCount: 0, minPrice: 0, maxPrice: 0, packageIds: [], status: "启用", cover: LXM_SVG("新系", "拍摄风格封面") },
    albums: { name: "", spotId: "spot1", seriesId: "ser1", price: 699, intro: "", photoCount: 0, shootingNotes: "", status: "启用", cover: LXM_SVG("新合", "照片单品") },
    samples: { name: "", type: "photo", spotId: "spot1", seriesId: "ser1", albumId: "alb1", status: "启用", url: LXM_SVG("新样", "上传预览") },
    packages: { name: "", type: "photo", spotId: "spot1", seriesId: "ser1", albumId: "alb1", originalPrice: 999, price: 699, specialPrice: 699, isMainPush: false, isShow: true, status: "上架", intro: "", description: "", serviceTags: ["精修9"], cover: LXM_SVG("新套", "套餐封面") },
    addonServices: { name: "", category: "修图", price: 199, enabled: true, intro: "增值服务，仅客服处理订单时添加" },
    peripherals: { name: "", category: "相册", price: 99, enabled: true, isShow: true, intro: "", specs: [], isNew: false, images: [], cover: LXM_SVG("新周", "摄影周边") },
    guides: { name: "", title: "", description: "", targetPackageId: "", status: "草稿", tag: "攻略", isHot: false, readCount: 0, score: "4.9", spotId: "spot1", seriesId: "ser1", cover: LXM_SVG("新攻", "内容运营") },
    stories: { name: "", title: "", subtitle: "", status: "草稿", tag: "故事", spotId: "spot1", cover: LXM_SVG("新故", "品牌故事") },
    cities: { name: "", mode: "直营", status: "运营中" },
  };
  const sourceRow = row?.__source || row;
  state.editContent = sourceRow ? { ...sourceRow, __key: key } : { ...(defaults[key] || {}), id: "", __key: key };
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
  if (key === "series" && payload.spotId && (!payload.spotIds || !payload.spotIds.length)) payload.spotIds = [payload.spotId];
  if (key === "packages") {
    payload.specialPrice = Number(payload.specialPrice || payload.price || 0);
    payload.serviceType = payload.type || "photo";
    payload.productType = payload.type || "photo";
    // 详情说明：小程序读 description（与周边保持一致），intro 仅为占位兼容旧数据
    payload.description = payload.description ?? payload.intro ?? "";
    delete payload.intro;
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
        if (item.type === "album") {
          const a = (data.albums || []).find((x) => x.name === item.name);
          item.target = { page: "photoCollection", seriesId: a ? a.seriesId : (item.target && item.target.seriesId) || "", albumId: a ? a.id : "" };
        } else if (item.type === "video") {
          const v = (data.packages || []).find((x) => x.name === item.name && x.type === "video");
          item.target = { page: "videoProductDetail", productId: v ? v.id : "", seriesId: v ? v.seriesId : "", spotId: v ? (v.spotId || (v.spotIds || [])[0]) : "" };
        } else if (item.type === "peripheral") {
          const p = (data.peripherals || []).find((x) => x.name === item.name);
          item.target = { page: "peripheral", peripheralId: p ? p.id : "" };
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
  if (payload.id) {
    const index = target.findIndex((item) => item.id === payload.id);
    if (index >= 0) Object.assign(target[index], payload);
    if (["packages", "albums", "peripherals"].includes(key)) markProductAudit(target[index], "商品资料编辑");
  } else {
    payload.id = `${key}${Date.now()}`;
    if (["packages", "albums", "peripherals"].includes(key)) {
      payload.auditStatus = "待审";
      payload.auditType = "新增商品";
      payload.auditSubmitAt = LXMFormat.dateTime(new Date());
      payload.auditSubmitter = currentOperatorName();
    }
    target.unshift(payload);
  }
  state.contentDialog = false;
  log("保存内容", activeMenu.value.label, payload.name || payload.title);
  if (isServerConnected()) {
    await pushContentToCloud(key, payload);
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
      res = await window.LXM_CLOUD.update(key, payload.id, doc);
      if (!res || res.error) res = await window.LXM_CLOUD.create(key, doc);
    } else {
      res = await window.LXM_CLOUD.create(key, doc);
    }
    if (res && res.error) throw new Error(res.error);
    if (res && res._id) payload.id = res._id;
    ElMessage.success("内容已同步到服务端（小程序将读取最新内容）");
  } catch (e) {
    ElMessage.warning("已本地保存，但同步服务端失败：" + (e && e.message ? e.message : e));
  }
}
// 是否已连接自托管/云服务端（/api/health 返回的 mode 不是 mock 即视为已连接）。
function isServerConnected() {
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  return !!(window.LXM_CLOUD && window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
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
function syncShelfPrice(row) {
  if (!row?.__source) return;
  row.__source.price = Number(row.shelfPrice || 0);
  if (row.__key === "packages") row.__source.specialPrice = Number(row.shelfPrice || 0);
  markProductAudit(row.__source, "调整货架价格");
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
function toggleShelf(row) {
  if (!row?.__source) return;
  row.__source.status = row.__source.isShow === false ? "下架" : "上架";
  if (row.__key === "peripherals") row.__source.enabled = row.__source.isShow !== false;
  markProductAudit(row.__source, row.__source.status === "上架" ? "商品上架" : "商品下架");
  log(row.__source.isShow === false ? "商品下架" : "商品上架", row.name, shelfTypeText(row.__key, row));
  ElMessage.success(`${row.name} ${row.__source.isShow === false ? "下架" : "上架"}`);
}
function saveShelfInline(row, field) {
  if (!row?.__source) return;
  markProductAudit(row.__source, `调整货架${field}`);
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
function applyShelfBatchAction(action) {
  const rows = selectedShelfSources();
  if (!rows.length) return ElMessage.warning("请先勾选需要批量处理的商品");
  const actionText = { on: "批量上架", off: "批量下架", main: "批量设主", tag: "批量打标", schedule: "批量配置定时" }[action] || "批量操作";
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
function uploadHomeMaterial() {
  const sample = { id: `sample${Date.now()}`, name: "首页新轮播素", type: "photo", albumId: "alb1", seriesId: "ser1", spotId: "spot1", isShowcase: true, url: LXM_SVG("首页新素", "即时预览") };
  data.samples.unshift(sample);
  state.homeConfig.carouselIds = [sample.id, ...(state.homeConfig.carouselIds || [])].slice(0, 6);
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
    banners: carouselIds.map((id, index) => {
      const s = data.samples.find((x) => x.id === id) || {};
      return {
        id,
        sort: index + 1,
        type: "image",
        url: s.url || "",
        cover: s.cover || s.url || "",
        targetType: "package_list",
        targetId: "",
        linkUrl: ""
      };
    }),
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
    exploreBanners: (state.homeConfig.exploreBanners || []).map((b) => ({
      _id: b._id || 'exp-banner-' + Date.now(),
      type: b.type === 'video' ? 'video' : 'image',
      url: b.url || '',
      cover: b.cover || '',
      title: b.title || '',
      targetType: b.targetType || 'none',
      targetId: b.targetId || '',
      linkUrl: b.linkUrl || ''
    })),
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
    wechat: c.wechat || {},
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
    relationText,
    openContent,
    openContentQuick,
    addIncludedItem,
    saveContent,
    pushContentToCloud,
    isServerConnected,
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
