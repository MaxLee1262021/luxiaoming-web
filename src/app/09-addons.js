// 增值服务与商品查看
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    addOrderTimeline,
    albumName,
    computed,
    data,
    isOrderAfterSaleLocked,
    productName,
    productPrice,
    resolveProduct,
    seriesName,
    spotName,
    state
  } = ctx;

function addonProducts() {
  const packages = data.packages.filter((p) => p.status !== "下架" && p.isShow !== false).map((p) => ({ ...p, type: p.type === "video" ? "video" : "package", key: `${p.type === "video" ? "video" : "package"}-${p.id}`, price: p.specialPrice || p.price, images: [p.cover] }));
  const albums = data.albums.map((a) => ({ ...a, type: "album", key: `album-${a.id}`, images: data.samples.filter((s) => s.albumId === a.id).map((s) => s.url), price: a.price }));
  const servicesList = data.addonServices.filter((s) => s.enabled).map((s) => ({ ...s, type: "service", key: `service-${s.id}`, cover: LXM_SVG(s.name, "通用加购服务") }));
  const peripherals = data.peripherals.filter((p) => p.enabled).map((p) => ({ ...p, type: "peripheral", key: `peripheral-${p.id}`, images: [p.cover] }));
  return [...packages, ...albums, ...servicesList, ...peripherals];
}
const filteredAddons = computed(() => addonProducts().filter((item) => {
  const scope = state.addonScope;
  if (scope.type === "common" && !["service", "peripheral"].includes(item.type)) return false;
  if (scope.type === "peripheral" && item.type !== "peripheral") return false;
  if (scope.type === "service" && !(item.type === "service" && ["修图", "加片", "改期"].includes(item.category))) return false;
  if (scope.type === "global" && !(item.type === "package" && (item.mainPush || item.isMainPush))) return false;
  if (scope.type === "point" && item.spotId !== scope.id) return false;
  if (scope.type === "package" && !(item.type === "package" && item.spotId === scope.id && !(item.mainPush || item.isMainPush))) return false;
  if (scope.type === "video" && !(item.type === "video" && item.spotId === scope.id)) return false;
  if (scope.type === "series" && item.seriesId !== scope.id) return false;
  if (scope.type === "album" && item.id !== scope.id && item.albumId !== scope.id) return false;
  if (state.addonKeyword && !JSON.stringify(item).includes(state.addonKeyword)) return false;
  return true;
}));
function toggleNode(group, id) {
  if (id) state.addonOpen[group][id] = !state.addonOpen[group][id];
  else state.addonOpen[group] = !state.addonOpen[group];
}
function selectAddon(type, id = "") {
  state.addonScope = { type, id };
  if (["peripheral", "service"].includes(type)) state.addonOpen.common = true;
}
function addonScopeTitle() {
  const scope = state.addonScope;
  if (scope.type === "common") return "通用加购：摄影周边 / 增值服务";
  if (scope.type === "peripheral") return "摄影周边：相册 / 打印 / 相框 / DIY";
  if (scope.type === "service") return "增值服务：修图 / 加片 / 改期";
  if (scope.type === "global") return "全局主推套餐：不受打卡点限制";
  if (scope.type === "point") return `打卡点全部商品：${spotName(scope.id)}`;
  if (scope.type === "package") return `打卡点套餐：${spotName(scope.id)}`;
  if (scope.type === "video") return `短视频：${spotName(scope.id)}`;
  if (scope.type === "series") return `拍摄风格内容：${seriesName(scope.id)}`;
  if (scope.type === "album") return `照片单品：${albumName(scope.id)}`;
  return "加购商品";
}
function openAddonDialog() {
  const order = state.currentOrder;
  if (!order) return;
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单售后处理中，暂不能调整加购商品");
  state.selectedAddonKeys = (order.addons || []).map((a) => a.key || `${a.type}-${a.id}`);
  const first = order.products[0] || {};
  state.addonOpen.common = true;
  state.addonOpen.root = true;
  if (first.spotId) state.addonOpen.point[first.spotId] = true;
  if (first.spotId) state.addonOpen.seriesRoot[first.spotId] = true;
  if (first.seriesId) state.addonOpen.series[first.seriesId] = true;
  state.addonScope = first.seriesId ? { type: "series", id: first.seriesId } : { type: "common", id: "" };
  state.addonDialog = true;
}
function toggleAddon(item) {
  const idx = state.selectedAddonKeys.indexOf(item.key);
  if (idx >= 0) state.selectedAddonKeys.splice(idx, 1);
  else state.selectedAddonKeys.push(item.key);
}
function confirmAddon() {
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能调整加购商品");
  const selected = addonProducts().filter((i) => state.selectedAddonKeys.includes(i.key));
  const base = state.currentOrder.products.filter((p) => !p.key);
  const addons = selected.map((i) => ({ id: i.id, key: i.key, type: i.type, name: i.name, price: i.price || 0, spotId: i.spotId, seriesId: i.seriesId, albumId: i.albumId }));
  state.currentOrder.addons = addons;
  state.currentOrder.products = [...base, ...addons];
  state.currentOrder.totalAmount = state.currentOrder.products.reduce((sum, p) => sum + productPrice(p), 0);
  state.addonDialog = false;
  addOrderTimeline(state.currentOrder, `调整加购商品：${addons.map((i) => i.name).join("、") || "清空加购"}`);
  ElMessage.success("加购商品已同步到订单");
}
function removeAddon(item) {
  if (!state.currentOrder || !item?.key) return;
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，暂不能取消加购商品");
  const removedName = productName(item);
  state.currentOrder.addons = (state.currentOrder.addons || []).filter((p) => (p.key || `${p.type}-${p.id}`) !== item.key);
  state.currentOrder.products = state.currentOrder.products.filter((p) => (p.key || `${p.type}-${p.id}`) !== item.key);
  state.currentOrder.totalAmount = state.currentOrder.products.reduce((sum, p) => sum + productPrice(p), 0);
  addOrderTimeline(state.currentOrder, `取消加购商品：${removedName}`);
  ElMessage.success("已取消该加购商品，并同步重算订单总价");
}
function productTypeText(type) {
  return ({ package: "套餐", video: "短视", album: "照片单品", service: "加购服务", peripheral: "摄影周边" })[type] || type;
}
function openProduct(p) {
  const item = resolveProduct(p);
  const type = p.type === "video" ? "video" : p.type || item.type;
  const images = item.images || (item.id && data.samples.filter((s) => s.albumId === item.id).map((s) => s.url)) || [item.cover].filter(Boolean);
  state.currentProduct = { ...item, ...p, type, name: p.name || item.name, price: productPrice(p), images: images.length ? images : [item.cover].filter(Boolean) };
  state.productDialog = true;
}
function zoomImage(url) {
  if (!url) return;
  state.zoomUrl = url;
  state.imagePreview = true;
}


  return {
    addonProducts,
    filteredAddons,
    toggleNode,
    selectAddon,
    addonScopeTitle,
    openAddonDialog,
    toggleAddon,
    confirmAddon,
    removeAddon,
    productTypeText,
    openProduct,
    zoomImage
  };
});
