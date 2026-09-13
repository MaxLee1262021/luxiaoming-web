// 内容货架、审核、日志与标签
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    albumDependencySummary,
    albumName,
    computed,
    currentOperatorName,
    data,
    inferLogLevel,
    inferLogModule,
    log,
    money,
    packagesByAlbum,
    packagesByPeripheral,
    packagesReferencingPackage,
    peripheralDependencySummary,
    persistTrashRecord,
    productStatus,
    seriesBySpot,
    seriesName,
    spotDependencySummary,
    spotName,
    spotRows,
    state
  } = ctx;

async function persistMutation(key, row, previous = null) {
  if (typeof ctx.persistContentMutation !== "function") return true;
  return ctx.persistContentMutation(key, row, previous);
}
function restoreRecord(source, previous = {}) {
  Object.keys(source || {}).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(previous, key)) delete source[key];
  });
  Object.assign(source, previous);
}
async function addTrash(key, source, previous, row) {
  if (await persistTrashRecord(row)) return true;
  restoreRecord(source, previous);
  await persistMutation(key, source, null);
  return false;
}

function contentList(key = state.active) {
  return { cities: data.cities, spots: data.spots, series: data.series, albums: data.albums, samples: data.samples, packages: data.packages, addonServices: data.addonServices, peripherals: data.peripherals, guides: data.guides, stories: data.stories }[key] || [];
}
function shelfRows() {
  [...data.albums, ...data.packages, ...data.peripherals].filter((item) => !item.deleted).forEach((item) => {
    if (item.isShow === undefined) item.isShow = productStatus(item) !== "下架";
  });
  const attachSales = (row) => {
    const matched = data.orders.filter((order) => !order.deleted && (order.products || []).some((product) => product.id === row.id && product.type === row.type));
    return {
      ...row,
      shelfPrice: Number(row.specialPrice || row.price || 0),
      soldCount: matched.length,
      soldAmount: matched.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    };
  };
  const albums = data.albums.filter((item) => !item.deleted).map((item) => attachSales({ ...item, __key: "albums", __source: item, type: "album", status: productStatus(item), isShow: item.isShow !== false }));
  const packages = data.packages.filter((item) => !item.deleted).map((item) => attachSales({ ...item, __key: "packages", __source: item, type: item.type === "video" ? "video" : "package", status: productStatus(item), isShow: item.isShow !== false }));
  const peripherals = data.peripherals.filter((item) => !item.deleted).map((item) => attachSales({ ...item, __key: "peripherals", __source: item, type: "peripheral", status: productStatus(item), isShow: item.isShow !== false }));
  return [...albums, ...packages, ...peripherals];
}
function shelfRowKey(row) {
  return `${row?.__key || "product"}-${row?.id || ""}`;
}
function packageTypeText(row) {
  return row?.type === "video" ? "短视频套" : "照片套餐";
}
function packageAuditText(row) {
  if (row?.auditStatus) return row.auditStatus;
  if (row?.status === "草稿") return "草稿";
  if (row?.status === "待审") return "待审";
  return productStatus(row) === "上架" ? "已上" : "已下";
}
function packageServiceText(row) {
  if (row?.type === "video") {
    return [
      row.videoDuration ? `${row.videoDuration}秒成片` : "成片时长待配",
      row.finishedVideoCount ? `${row.finishedVideoCount}条成片` : "成片数量待配",
      row.hasAerial ? "含航" : "不含航拍",
      row.deliveryCycle || "交付周期待配",
    ].join(" / ");
  }
  return [
    row.duration ? `${row.duration}分钟拍摄` : "拍摄时长待配",
    row.retouchCount ? `精修${row.retouchCount}张` : (row.serviceTags || []).find((tag) => String(tag).includes("精修")) || "精修张数待配",
    row.deliveryCycle || "交付周期待配",
  ].join(" / ");
}
function packagePriceText(row) {
  const deposit = row?.depositRatio ? `${row.depositRatio}%定金` : "定金比例待配";
  const finalRule = row?.finalPaymentRule || "尾款按订单完成前确认";
  return `${money(row?.specialPrice || row?.price || 0)} / ${deposit} / ${finalRule}`;
}
function packageBookingText(row) {
  if (row?.type === "video") return `日限"${row.timeSlotLimit || row.bookingLimit || "待配"}，提"${row.advanceBookingDays || 3} 天预约`;
  return `日限"${row.bookingLimit || "待配"}，节假日配额 ${row.holidayQuota || "待配"}`;
}
const packageSummary = computed(() => {
  const allRows = data.packages.filter((row) => !row.deleted);
  const rows = state.active === "packages" ? allRows.filter((row) => row.type !== "video") : allRows;
  const saleRows = rows.filter((row) => productStatus(row) === "上架" && row.isShow !== false);
  const videoRows = rows.filter((row) => row.type === "video");
  const photoRows = rows.filter((row) => row.type !== "video");
  return {
    total: rows.length,
    photo: photoRows.length,
    video: videoRows.length,
    onSale: saleRows.length,
    mainPush: rows.filter((row) => row.isMainPush || row.mainPush).length,
    needAudit: rows.filter((row) => ["待审", "草稿", "驳回"].includes(row.auditStatus || row.status)).length,
    revenue: shelfRows().filter((row) => row.__key === "packages" && (state.active !== "videoProducts" || row.type === "video")).reduce((sum, row) => sum + Number(row.soldAmount || 0), 0),
  };
});
const shelfSummary = computed(() => {
  const rows = shelfRows();
  const valid = rows.filter((row) => !["草稿", "待审"].includes(row.auditStatus || row.status));
  const sumBy = (predicate, field = "soldAmount") => valid.filter(predicate).reduce((sum, row) => sum + Number(row[field] || 0), 0);
  return {
    total: rows.length,
    onSale: valid.filter((row) => productStatus(row) === "上架" && row.isShow !== false).length,
    photoRevenue: sumBy((row) => row.__key === "packages" && row.type !== "video"),
    videoRevenue: sumBy((row) => row.type === "video"),
    peripheralRevenue: sumBy((row) => row.__key === "peripherals"),
    soldCount: sumBy(() => true, "soldCount"),
    pendingAudit: rows.filter((row) => ["待审", "草稿"].includes(row.auditStatus || row.status)).length,
  };
});
function auditProductRows() {
  return [
    ...data.packages.map((row) => ({ ...row, __key: "packages", __source: row, auditType: row.auditType || "商品配置变更" })),
    ...data.albums.map((row) => ({ ...row, __key: "albums", __source: row, auditType: row.auditType || "照片单品售卖变更" })),
    ...data.peripherals.map((row) => ({ ...row, __key: "peripherals", __source: row, auditType: row.auditType || "周边货架变更" })),
  ].filter((row) => !row.deleted);
}
const productAuditRows = computed(() => {
  let rows = auditProductRows();
  if (state.filters.contentStatus) rows = rows.filter((row) => (row.auditStatus || ctx.shelfAuditText(row)) === state.filters.contentStatus);
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(kw));
  }
  return rows.sort((a, b) => (a.auditStatus === "待审" ? -1 : 1) - (b.auditStatus === "待审" ? -1 : 1));
});
const productAuditSummary = computed(() => {
  const rows = auditProductRows();
  return {
    total: rows.length,
    pending: rows.filter((row) => row.auditStatus === "待审").length,
    rejected: rows.filter((row) => row.auditStatus === "驳回").length,
    draft: rows.filter((row) => row.auditStatus === "草稿" || row.status === "草稿").length,
    approved: rows.filter((row) => ["已上", "已下"].includes(row.auditStatus)).length,
  };
});
const operationLogRows = computed(() => {
  let rows = state.logs.map((row) => ({
    ...row,
    moduleText: row.module || inferLogModule(row.action, row.target),
    levelText: row.level || inferLogLevel(row.action, row.detail),
  }));
  if (state.filters.logUser) rows = rows.filter((row) => row.user === state.filters.logUser);
  if (state.filters.logModule) rows = rows.filter((row) => row.moduleText === state.filters.logModule);
  if (state.filters.logLevel) rows = rows.filter((row) => row.levelText === state.filters.logLevel);
  if (state.filters.logAction) rows = rows.filter((row) => row.moduleText === state.filters.logAction || row.action.includes(state.filters.logAction));
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(kw));
  }
  return rows;
});
const operationLogSummary = computed(() => {
  const rows = state.logs.map((row) => ({ ...row, moduleText: row.module || inferLogModule(row.action, row.target), levelText: row.level || inferLogLevel(row.action, row.detail) }));
  return {
    total: rows.length,
    content: rows.filter((row) => row.moduleText === "内容商品").length,
    finance: rows.filter((row) => row.moduleText === "财务审计").length,
    high: rows.filter((row) => row.levelText === "").length,
    today: rows.filter((row) => String(row.time || "").includes(LXMFormat.date(new Date()))).length,
  };
});
function markProductAudit(row, type = "商品配置变更") {
  if (!row) return;
  row.auditStatus = "待审";
  row.auditType = type;
  row.auditSubmitAt = LXMFormat.dateTime(new Date());
  row.auditSubmitter = currentOperatorName();
  row.auditReason = type;
  log("提交商品审核", row.name || row.title || "未命名商", type);
}
async function submitProductAudit(row, type = "商品配置变更") {
  const source = row?.__source || row;
  const previous = source ? { ...source } : null;
  markProductAudit(source, type);
  const key = row?.__key || source?.__key || (data.packages.includes(source) ? "packages" : data.albums.includes(source) ? "albums" : "peripherals");
  if (source && !(await persistMutation(key, source, previous))) return;
  ElMessage.success("已提交商品审核，审核通过前不会作为最新正式配置发");
}
async function reviewProductAudit(row, approved) {
  const source = row?.__source || row;
  if (!source) return;
  const previous = { ...source };
  source.auditStatus = approved ? (productStatus(source) === "上架" ? "已上" : "已下") : "驳回";
  source.auditReviewer = currentOperatorName();
  source.auditReviewedAt = LXMFormat.dateTime(new Date());
  if (!approved) source.auditRejectReason = state.auditRejectReason || "配置不符合商品运营规";
  const key = row?.__key || source?.__key || (data.packages.includes(source) ? "packages" : data.albums.includes(source) ? "albums" : "peripherals");
  if (!(await persistMutation(key, source, previous))) return;
  log(approved ? "商品审核通过" : "商品审核驳回", source.name || "未命名商", `${source.auditType || "商品配置变更"} / ${approved ? "通过" : source.auditRejectReason}`);
  state.auditRejectReason = "";
  ElMessage.success(approved ? "商品审核已通过" : "商品审核已驳");
}
function tagUsageCount(tagName) {
  if (!tagName) return 0;
  const pools = [...data.spots, ...data.albums, ...data.packages, ...data.peripherals, ...data.guides, ...data.stories];
  return pools.reduce((count, row) => {
    const tags = [row.tag, ...(row.tags || []), ...(row.serviceTags || [])].filter(Boolean).map(String);
    return count + tags.filter((tag) => tag === tagName).length;
  }, 0);
}
const tagRows = computed(() => {
  let rows = data.tagLibrary.filter((row) => !row.deleted).sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
  if (state.tagCategoryFilter) rows = rows.filter((row) => row.category === state.tagCategoryFilter);
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(kw));
  }
  return rows.map((row) => ({ ...row, usageCount: tagUsageCount(row.name) }));
});
const tagSummary = computed(() => {
  const rows = data.tagLibrary.filter((row) => !row.deleted);
  return {
    total: rows.length,
    enabled: rows.filter((row) => row.status !== "停用").length,
    style: rows.filter((row) => row.category === "风格").length,
    scene: rows.filter((row) => row.category === "场景").length,
    crowd: rows.filter((row) => row.category === "人群").length,
    activity: rows.filter((row) => row.category === "活动").length,
    used: rows.reduce((sum, row) => sum + tagUsageCount(row.name), 0),
  };
});
const albumRows = computed(() => {
  let rows = data.albums.filter((album) => !album.deleted).map((album) => {
    if (album.isSellable === undefined) album.isSellable = productStatus(album) !== "下架";
    if (album.allowMaterialUse === undefined) album.allowMaterialUse = true;
    return { ...album, summary: albumDependencySummary(album) };
  });
  if (state.filters.contentSpotId) rows = rows.filter((row) => row.spotId === state.filters.contentSpotId || seriesBySpot(state.filters.contentSpotId).some((series) => series.id === row.seriesId));
  if (state.filters.contentSeriesId) rows = rows.filter((row) => row.seriesId === state.filters.contentSeriesId);
  if (state.filters.contentStatus) rows = rows.filter((row) => productStatus(row) === state.filters.contentStatus || row.status === state.filters.contentStatus);
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(kw));
  }
  return rows;
});
const albumSummary = computed(() => ({
  total: data.albums.length,
  sellable: data.albums.filter((row) => row.isSellable !== false && productStatus(row) !== "下架").length,
  materialEnabled: data.albums.filter((row) => row.allowMaterialUse !== false).length,
  photoSamples: data.samples.filter((row) => row.type !== "video").length,
  videoSamples: data.samples.filter((row) => row.type === "video").length,
  linkedPackages: data.albums.reduce((sum, row) => sum + packagesByAlbum(row.id).length, 0),
}));
function tagOptions(category = "") {
  return data.tagLibrary.filter((row) => row.status !== "停用" && (!category || row.category === category)).sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
}
function tagCategoryText(row) {
  return `${row.category || "未分"} · ${row.scope || "全模"}`;
}
function openTag(row = null) {
  state.editTag = row ? { ...row } : { id: "", name: "", category: "风格", status: "启用", sort: 100, scope: "照片单品/套餐/货架", color: "#E0662A" };
  state.tagDialog = true;
}
async function saveTag() {
  const row = state.editTag;
  if (!row?.name) return ElMessage.warning("请填写标签名");
  if (!row.category) return ElMessage.warning("请选择标签分类");
  const payload = { ...row, sort: Number(row.sort || 0) };
  let target;
  let previous = null;
  if (payload.id) {
    const index = data.tagLibrary.findIndex((item) => item.id === payload.id);
    if (index >= 0) { target = data.tagLibrary[index]; previous = { ...target }; Object.assign(target, payload); }
    else { target = payload; data.tagLibrary.unshift(target); }
  } else {
    payload.id = `tag${Date.now()}`;
    target = payload;
    data.tagLibrary.unshift(target);
  }
  if (target && !(await persistMutation("tagLibrary", target, previous))) {
    if (previous) Object.assign(target, previous);
    else data.tagLibrary = data.tagLibrary.filter((item) => item !== target);
    return;
  }
  state.tagDialog = false;
  log("保存标签", "标签管理", `${payload.category} / ${payload.name}`);
  ElMessage.success("标签已保存，套餐、照片单品、周边可统一复用");
}
async function toggleTagStatus(row) {
  const previous = { ...row };
  row.status = row.status === "停用" ? "启用" : "停用";
  if (!(await persistMutation("tagLibrary", row, previous))) return;
  log(row.status === "停用" ? "停用标签" : "启用标签", "标签管理", row.name);
  ElMessage.success(`${row.name} ${row.status}`);
}
function replaceTagUsage(row) {
  ElMessage.info(`已进入批量替换流程占位：${row.name} 当前引用 ${tagUsageCount(row.name)} 次`);
  log("批量替换标签", "标签管理", `${row.name} / ${tagUsageCount(row.name)} 次引用`);
}
async function toggleAlbumSellable(album) {
  if (!album) return;
  const source = data.albums.find((item) => item.id === album.id) || album;
  const previous = { ...source };
  const next = album.isSellable !== false;
  const linked = packagesByAlbum(album.id);
  source.isSellable = next;
  source.isShow = next;
  source.status = next ? "上架" : "下架";
  markProductAudit(source, next ? "照片单品上架售卖" : "照片单品下架售卖");
  if (!(await persistMutation("albums", source, previous))) return;
  if (!next && linked.length) ElMessage.warning(`照片单品已下架，但仍有 ${linked.length} 个套餐引用其素材，请检查前端展示风险`);
  else ElMessage.success(`${album.name} ${next ? "开启售卖" : "下架售卖"}`);
  log(next ? "开启照片单品售卖" : "下架照片单品售卖", "照片单品", `${album.name} / 关联套餐 ${linked.length}`);
}
async function toggleAlbumMaterialUse(album) {
  if (!album) return;
  const source = data.albums.find((item) => item.id === album.id) || album;
  const previous = { ...source };
  const next = album.allowMaterialUse !== false;
  source.allowMaterialUse = next;
  markProductAudit(source, next ? "开启素材展" : "关闭素材展示");
  if (!(await persistMutation("albums", source, previous))) return;
  log(next ? "允许照片单品素材展示" : "关闭照片单品素材展示", "照片单品", album.name);
  ElMessage.success(`${album.name} ${next ? "允许套餐引用素材" : "禁止套餐引用素材"}`);
}
async function uploadAlbumSample(album, type = "photo") {
  if (!album) return;
  const sample = {
    id: `sample${Date.now()}`,
    name: type === "video" ? "新视频样" : "新图片样",
    type,
    spotId: album.spotId || "",
    seriesId: album.seriesId || "",
    albumId: album.id,
    status: "启用",
    isShowcase: true,
    url: LXM_SVG(type === "video" ? "视频样片" : "图片样片", "后台上传预览"),
  };
  data.samples.unshift(sample);
  if (!(await persistMutation("samples", sample))) {
    data.samples = data.samples.filter((item) => item !== sample);
    return;
  }
  log(type === "video" ? "上传视频样片" : "上传图片样片", album.name, sample.name);
  ElMessage.success(`${sample.name} 已加"${album.name}`);
}
async function requestDeleteAlbum(album) {
  const summary = albumDependencySummary(album);
  if (!summary.canDelete) return ElMessage.warning(`该照片单品仍被 ${summary.packages} 个套餐引用，且有关联订单 ${summary.orders} 单，不能直接删除`);
  try {
    await ElMessageBox.confirm(`删除后「${album.name}」将进入回收站，30 天内可在回收站恢复。确认删除吗？`, "删除照片单品", { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "再想想", confirmButtonClass: "el-button--danger" });
  } catch (e) { return; }
  const source = data.albums.find((item) => item.id === album.id) || album;
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  source.isShow = false;
  source.status = "下架";
  if (!(await persistMutation("albums", source, previous))) return;
  if (!(await addTrash("albums", source, previous, { id: `trash${Date.now()}`, type: "照片单品", sourceKey: "albums", name: album.name, reason: "删除照片单品", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } }))) return;
  log("删除照片单品进入回收", "照片单品", album.name);
  ElMessage.success("照片单品已进入回收站，可在 30 天内恢复");
}
function openAlbumReplace(album = null) {
  state.albumReplaceForm = { fromAlbumId: album?.id || "", toAlbumId: "" };
  state.albumReplaceDialog = true;
}
async function submitAlbumReplace() {
  const form = state.albumReplaceForm;
  if (!form.fromAlbumId || !form.toAlbumId) return ElMessage.warning("请选择原照片单品和替换照片单品");
  if (form.fromAlbumId === form.toAlbumId) return ElMessage.warning("替换照片单品不能和原照片单品相同");
  const fromAlbum = data.albums.find((item) => item.id === form.fromAlbumId);
  const toAlbum = data.albums.find((item) => item.id === form.toAlbumId);
  if (!fromAlbum || !toAlbum) return ElMessage.warning("照片单品数据不存在，请刷新后重试");
  const rows = packagesByAlbum(form.fromAlbumId);
  const originals = rows.map((pkg) => [pkg, { ...pkg }]);
  rows.forEach((pkg) => {
    if (pkg.albumId === form.fromAlbumId) pkg.albumId = form.toAlbumId;
    if (Array.isArray(pkg.albumIds)) pkg.albumIds = pkg.albumIds.map((id) => id === form.fromAlbumId ? form.toAlbumId : id);
    if (Array.isArray(pkg.includedItems)) pkg.includedItems = pkg.includedItems.map((item) => {
      if (!item || item.type !== "album") return item;
      const next = { ...item, target: { ...(item.target || {}) } };
      if (next.albumId === form.fromAlbumId) next.albumId = form.toAlbumId;
      if (next.productId === form.fromAlbumId) next.productId = form.toAlbumId;
      if (next.target.albumId === form.fromAlbumId) next.target.albumId = form.toAlbumId;
      if (next.target.productId === form.fromAlbumId) next.target.productId = form.toAlbumId;
      return next;
    });
    pkg.spotId = pkg.spotId || toAlbum.spotId;
    pkg.seriesId = pkg.seriesId || toAlbum.seriesId;
  });
  for (const [pkg, previous] of originals) {
    if (!(await persistMutation("packages", pkg, previous))) {
      originals.forEach(([target, original]) => Object.assign(target, original));
      return;
    }
  }
  state.albumReplaceDialog = false;
  log("批量替换套餐绑定照片单品", "照片单品", `${fromAlbum.name} -> ${toAlbum.name} / ${rows.length} 个套餐`);
  ElMessage.success(`已替"${rows.length} 个套餐的绑定照片单品`);
}
async function togglePeripheralShelf(row) {
  const source = data.peripherals.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  const next = productStatus(source) === "下架";
  source.isShow = next;
  source.enabled = source.isShow !== false;
  source.status = source.isShow === false ? "下架" : "上架";
  source.auditStatus = source.status === "上架" ? "已上" : "已下";
  markProductAudit(source, source.status === "上架" ? "周边上架" : "周边下架");
  if (!(await persistMutation("peripherals", source, previous))) return;
  log(source.status === "上架" ? "周边上架" : "周边下架", "摄影周边", source.name);
  ElMessage.success(`${source.name} ${source.status}`);
}
async function setPeripheralMode(row, mode) {
  const source = data.peripherals.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  source.mode = mode;
  if (mode === "全城通用") {
    source.spotId = "";
    source.spotIds = [];
  } else if (!source.spotId) {
    source.spotId = data.spots[0]?.id || "";
  }
  markProductAudit(source, "调整周边关联模式");
  if (!(await persistMutation("peripherals", source, previous))) return;
  log("调整周边关联模式", "摄影周边", `${source.name} / ${mode}`);
  ElMessage.success(`${source.name} 已设置为${mode}`);
}
async function requestDeletePeripheral(row) {
  const summary = peripheralDependencySummary(row);
  const packageRefs = packagesByPeripheral(row.id).length;
  if (!summary.canDelete || packageRefs) return ElMessage.warning(`该周边仍有 ${summary.orders} 个关联订单或 ${packageRefs} 个套餐引用，不能直接删除`);
  const source = data.peripherals.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  source.isShow = false;
  source.status = "下架";
  if (!(await persistMutation("peripherals", source, previous))) return;
  if (!(await addTrash("peripherals", source, previous, { id: `trash${Date.now()}`, type: "摄影周边", sourceKey: "peripherals", name: row.name, reason: "删除周边商品", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } }))) return;
  log("删除周边进入回收", "摄影周边", row.name);
  ctx.syncDeleteToServer("peripherals", row.id);
  ElMessage.success("周边商品已进入回收站");
}
async function requestDeletePackage(row) {
  const source = data.packages.find((item) => item.id === row.id) || row;
  const orders = data.orders.filter((order) => !order.deleted && (order.products || []).some((product) => product.id === source.id));
  const packageRefs = packagesReferencingPackage(source.id).filter((item) => item.id !== source.id).length;
  if (orders.length || packageRefs) return ElMessage.warning(`该套餐已"${orders.length} 个关联订单或 ${packageRefs} 个套餐引用，不能直接删除，请先下架并保留历史订单追溯`);
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  source.isShow = false;
  source.status = "下架";
  source.auditStatus = "已下";
  if (!(await persistMutation("packages", source, previous))) return;
  if (!(await addTrash("packages", source, previous, {
    id: `trash-package-${source.id}-${Date.now()}`,
    type: source.type === "video" ? "短视频套" : "照片套餐",
    sourceKey: "packages",
    name: source.name,
    reason: "删除套餐商品",
    time: LXMFormat.nowText(),
    deletedAt: LXMFormat.dateTime(new Date()),
    operator: currentOperatorName(),
    restorable: true,
    source: { ...source },
  }))) return;
  log("删除套餐进入回收", "套餐设置", source.name, currentOperatorName(), { module: "内容商品", level: "", objectType: source.type === "video" ? "短视频套" : "照片套餐", objectName: source.name });
  ElMessage.success("套餐已进入回收站，可由超管恢");
}
async function requestDeleteAddon(row) {
  const source = data.addonServices.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  source.enabled = false;
  if (!(await persistMutation("addonServices", source, previous))) return;
  if (!(await addTrash("addonServices", source, previous, {
    id: `trash-addon-${source.id}-${Date.now()}`,
    type: "增值服",
    sourceKey: "addonServices",
    name: source.name,
    reason: "删除内部增值服",
    time: LXMFormat.nowText(),
    deletedAt: LXMFormat.dateTime(new Date()),
    operator: currentOperatorName(),
    restorable: true,
    source: { ...source },
  }))) return;
  log("删除增值服务进入回收站", "增值服", source.name, currentOperatorName(), { module: "内容商品", level: "", objectType: "增值服", objectName: source.name });
  ElMessage.success("增值服务已进入回收站，可由超管恢复");
}
async function toggleAddonEnabled(row) {
  const source = data.addonServices.find((item) => item.id === row.id) || row;
  const previous = { ...source };
  source.enabled = source.enabled === false;
  if (row.enabled !== undefined && row.enabled !== source.enabled) source.enabled = row.enabled;
  if (!(await persistMutation("addonServices", source, previous))) return;
  log(source.enabled ? "启用增值服" : "停用增值服", "增值服", source.name);
  ElMessage.success(`${source.name} ${source.enabled ? "启用" : "停用"}`);
}
function packageMutualText(row) {
  const ids = row?.mutualExclusionIds || [];
  if (!ids.length) return "未设置互";
  return ids.map((id) => (data.packages.find((pkg) => pkg.id === id) || {}).name || id).join("");
}
function effectiveContentKey() {
  if (state.active === "shelfProducts") return "shelfProducts";
  if (state.active === "videoProducts") return "packages";
  if (state.active !== "spots") return state.active;
  if (state.contentScope.type === "spot") return "series";
  if (state.contentScope.type === "video") return "packages";
  if (state.contentScope.type === "series") return "albums";
  if (state.contentScope.type === "album") return "samples";
  return "spots";
}
const contentRows = computed(() => {
  const key = effectiveContentKey();
  let list = key === "shelfProducts" ? shelfRows() : contentList(key).filter((row) => !row.deleted);
  const scope = state.contentScope;
  if (state.active === "videoProducts") list = list.filter((r) => r.type === "video");
  if ((state.active === "shelfProducts" || state.active === "packages") && state.filters.shelfType) {
    list = list.filter((r) => state.filters.shelfType === "video" ? r.type === "video" : (state.active === "packages" ? r.type !== "video" : r.__key === state.filters.shelfType && r.type !== "video"));
  }
  if (state.active === "spots" && scope.type === "spot") list = list.filter((r) => r.spotId === scope.id || (r.spotIds || []).includes(scope.id));
  else if (scope.type === "spot") list = list.filter((r) => r.id === scope.id || r.spotId === scope.id);
  if (state.active === "spots" && scope.type === "series") list = list.filter((r) => r.seriesId === scope.id);
  else if (scope.type === "series") list = list.filter((r) => r.id === scope.id || r.seriesId === scope.id);
  if (state.active === "spots" && scope.type === "album") list = list.filter((r) => r.albumId === scope.id);
  else if (scope.type === "album") list = list.filter((r) => r.id === scope.id || r.albumId === scope.id);
  if (scope.type === "package") list = list.filter((r) => r.spotId === scope.id && (r.type === "photo" || r.type === undefined));
  if (scope.type === "video") list = list.filter((r) => r.spotId === scope.id && r.type === "video");
  if (state.filters.contentSpotId) list = list.filter((r) => r.id === state.filters.contentSpotId || r.spotId === state.filters.contentSpotId || (r.spotIds || []).includes(state.filters.contentSpotId));
  if (state.filters.contentSeriesId) list = list.filter((r) => r.id === state.filters.contentSeriesId || r.seriesId === state.filters.contentSeriesId);
  if (state.filters.contentStatus) list = list.filter((r) => productStatus(r) === state.filters.contentStatus || (r.status || (r.enabled === false ? "停用" : "启用")) === state.filters.contentStatus);
  if (state.filters.keyword) {
    const kw = state.filters.keyword.toLowerCase();
    list = list.filter((r) => JSON.stringify(r).toLowerCase().includes(kw));
  }
  return list;
});
function contentPanelTitle() {
  if (state.active === "shelfProducts") return "商品上下架统一货架";
  if (state.active === "packages") return "套餐设置";
  if (state.active === "addonServices") return "增值服务";
  if (state.active === "peripherals") return "摄影周边";
  if (state.contentScope.type === "spot") return `${spotName(state.contentScope.id)} · 拍摄风格`;
  if (state.contentScope.type === "video") return `${spotName(state.contentScope.id)} · 短视频`;
  if (state.contentScope.type === "series") return `${seriesName(state.contentScope.id)} · 照片单品`;
  if (state.contentScope.type === "album") return `${albumName(state.contentScope.id)} · 样片`;
  return "打卡点设置";
}
function contentPanelDesc() {
  if (state.active === "shelfProducts") return "统一管理公开售卖商品，用于上下架、价格和标签调整；内部加购服务不进入公开货架。";
  if (state.active === "packages") return "套餐是独立商品，可关联打卡点，支持照片套餐和短视频。";
  if (state.active === "addonServices") return "增值服务用于客服订单内部加购，不作为小程序公开商品展示。";
  if (state.active === "peripherals") return "摄影周边独立维护，可在首页和我的页面露出。";
  if (state.active !== "spots") return "内容运营素材独立维护。";
  if (state.contentScope.type === "spot") return "拍摄风格用于描述风格主题，不单独标价。";
  if (state.contentScope.type === "video") return "短视频绑定当前打卡点，可独立定价和上下架。";
  if (state.contentScope.type === "series") return "照片单品可作为样片素材或可售商品。";
  if (state.contentScope.type === "album") return "照片单品内样片用于展示风格，支持上传、预览和排序。";
  return "打卡点下管理拍摄风格，拍摄风格下管理照片单品，照片单品下管理素材。";
}
const contentFlowSteps = computed(() => [
  { title: "1. 创建打卡点", desc: "维护城市、封面、热门标记", active: state.active === "spots" && !state.contentScope.type },
  { title: "2. 添加拍摄风格", desc: "拍摄风格是分类标签，不标价", active: state.active === "spots" && state.contentScope.type === "spot" },
  { title: "3. 创建照片单品", desc: "照片单品才是可售商品，需要定价", active: state.active === "spots" && state.contentScope.type === "series" },
  { title: "4. 配置套餐/短视频", desc: "照片套餐与短视频都关联打卡点", active: state.active === "packages" || (state.active === "spots" && state.contentScope.type === "video") },
  { title: "5. 商品上下架", desc: "统一调整公开商品状态和标签", active: state.active === "shelfProducts" },
]);
const contentSummary = computed(() => {
  const rows = contentRows.value;
  const shelf = state.active === "shelfProducts" ? shelfRows() : rows;
  return {
    total: rows.length,
    shown: rows.filter((r) => productStatus(r) !== "下架" && r.enabled !== false && r.isShow !== false).length,
    mainPush: rows.filter((r) => r.isMainPush || r.mainPush).length,
    priced: rows.filter((r) => r.price || r.specialPrice).length,
    hidden: shelf.filter((r) => productStatus(r) === "下架" || r.enabled === false || r.isShow === false).length,
    soldAmount: rows.reduce((sum, r) => sum + Number(r.soldAmount || 0), 0),
  };
});
function selectContentScope(type, id) {
  state.contentScope = { type, id };
}
function selectSpot(id) {
  state.contentScope = { type: "spot", id };
  state.filters.contentSpotId = id;
}
function spotRowId(row) {
  if (!row || typeof row !== "object") return "";
  const value = row.id !== undefined && row.id !== null && row.id !== "" ? row.id : row._id;
  return value === undefined || value === null ? "" : String(value);
}
function findSpotSource(row) {
  const id = spotRowId(row);
  return id ? data.spots.find((item) => spotRowId(item) === id) || null : null;
}
async function toggleSpotVisible(spot) {
  const source = findSpotSource(spot);
  if (!source) return ElMessage.warning("打卡点不存在或已删除，请刷新后重试");
  const previous = { ...source };
  source.isShow = source.isShow === false;
  source.status = source.isShow === false ? "停用" : "启用";
  if (!(await persistMutation("spots", source, previous))) {
    restoreRecord(source, previous);
    return;
  }
  log(source.isShow === false ? "关闭打卡点展" : "开启打卡点展示", "打卡点设", source.name);
  ElMessage.success(`${source.name} ${source.isShow === false ? "关闭展示" : "开启展示"}`);
}
async function batchSetSpotVisible(visible, rows = spotRows.value) {
  const candidates = Array.isArray(rows) ? rows : spotRows.value;
  if (!candidates.length) return ElMessage.warning("当前筛选条件下没有可处理的打卡点");
  const changed = [];
  candidates.forEach((spotRow) => {
    const source = findSpotSource(spotRow);
    if (source) {
      changed.push([source, { ...source }]);
      source.isShow = visible;
      source.status = visible ? "启用" : "停用";
    }
  });
  for (const [source, previous] of changed) {
    if (!(await persistMutation("spots", source, previous))) {
      restoreRecord(source, previous);
      return;
    }
  }
  log(visible ? "批量开启打卡点展示" : "批量关闭打卡点展示", "打卡点设置", `${changed.length} 个点位`);
  ElMessage.success(`已${visible ? "开启" : "关闭"}当前筛选点位展示`);
}
async function requestDeleteSpot(spot) {
  const source = findSpotSource(spot);
  if (!source) return ElMessage.warning("打卡点不存在或已删除，请刷新后重试");
  const sourceId = spotRowId(source);
  const summary = spotDependencySummary(source.id ? source : { ...source, id: sourceId });
  if (!summary.canDelete) {
    return ElMessage.warning(`该点位仍有关联数据：拍摄风格 ${summary.series}、照片单品 ${summary.albums}、商品 ${summary.products}、订单 ${summary.orders}，不能直接删除`);
  }
  const previous = { ...source };
  source.deleted = true;
  source.isDeleted = true;
  source.status = "停用";
  const synced = await persistMutation("spots", source, previous);
  if (!synced) {
    restoreRecord(source, previous);
    return;
  }
  if (!(await addTrash("spots", source, previous, { id: `trash-spot-${sourceId}-${Date.now()}`, type: "打卡", sourceKey: "spots", name: source.name, reason: "删除打卡", time: LXMFormat.nowText(), deletedAt: LXMFormat.dateTime(new Date()), operator: currentOperatorName(), restorable: true, source: { ...source } }))) return;
  log("删除打卡点进入回收站", "打卡点设", source.name);
  ElMessage.success("打卡点已进入回收站，可在 30 天内恢复");
}
// ===== 短视频（独立内容类型，自包含，不进入 spots 层级 contentRows 体系）=====

  return {
    contentList,
    shelfRows,
    shelfRowKey,
    packageTypeText,
    packageAuditText,
    packageServiceText,
    packagePriceText,
    packageBookingText,
    packageSummary,
    shelfSummary,
    auditProductRows,
    productAuditRows,
    productAuditSummary,
    operationLogRows,
    operationLogSummary,
    markProductAudit,
    submitProductAudit,
    reviewProductAudit,
    tagUsageCount,
    tagRows,
    tagSummary,
    albumRows,
    albumSummary,
    tagOptions,
    tagCategoryText,
    openTag,
    saveTag,
    toggleTagStatus,
    replaceTagUsage,
    toggleAlbumSellable,
    toggleAlbumMaterialUse,
    uploadAlbumSample,
    requestDeleteAlbum,
    openAlbumReplace,
    submitAlbumReplace,
    togglePeripheralShelf,
    setPeripheralMode,
    requestDeletePeripheral,
    requestDeletePackage,
    requestDeleteAddon,
    toggleAddonEnabled,
    packageMutualText,
    effectiveContentKey,
    contentRows,
    contentPanelTitle,
    contentPanelDesc,
    contentFlowSteps,
    contentSummary,
    selectContentScope,
    selectSpot,
    toggleSpotVisible,
    batchSetSpotVisible,
    requestDeleteSpot
  };
});
