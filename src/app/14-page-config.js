// 页面装修与小程序预览
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    computed,
    data,
    log,
    productStatus,
    scopedOrders,
    state
  } = ctx;

const homeModuleOptions = [
  { key: "mainPush", label: "主推套餐", desc: "展示跨全部打卡点的主推套餐" },
  { key: "spots", label: "热门打卡", desc: "展示城市核心拍摄地点" },
  { key: "albums", label: "照片单品", desc: "展示可预约的照片单品商品" },
  { key: "videoProducts", label: "城市短视频", desc: "展示短视频与短视频" },
  { key: "peripherals", label: "摄影周边", desc: "展示相册、打印、相框等周边" },
  { key: "guides", label: "攻略故事", desc: "展示攻略和城市故事内容" },
];
const homePreview = computed(() => {
  const enabled = state.homeConfig.enabledModules || [];
  const carouselIds = state.homeConfig.carouselIds || [];
  const packageIds = state.homeConfig.featuredPackageIds || [];
  const albumIds = state.homeConfig.featuredAlbumIds || [];
  const peripheralIds = state.homeConfig.featuredPeripheralIds || [];
  return {
    carousel: data.samples.filter((item) => carouselIds.includes(item.id)).slice(0, 4),
    packages: data.packages.filter((item) => item.isMainPush || packageIds.includes(item.id)).slice(0, 3),
    spots: data.spots.slice(0, 3),
    albums: data.albums.filter((item) => albumIds.includes(item.id)).slice(0, 3),
    peripherals: data.peripherals.filter((item) => peripheralIds.includes(item.id)).slice(0, 3),
    guides: [...data.guides.slice(0, 1), ...data.stories.slice(0, 1)],
    has: (key) => enabled.includes(key),
  };
});
const miniPreviewPages = [
  { key: "home", label: "首页", desc: "首页推荐、轮播、核心入口" },
  { key: "spotList", label: "全部打卡点", desc: "按点位进入相关风格系列和商品" },
  { key: "seriesList", label: "风格系列", desc: "风格系列和照片单品" },
  { key: "packageList", label: "套餐列表", desc: "照片套餐与短视频" },
  { key: "albumDetail", label: "照片单品", desc: "九宫格样片预览与预约" },
  { key: "peripherals", label: "摄影周边", desc: "旅拍周边商品展示" },
  { key: "my", label: "我的", desc: "订单、客服、预约须知" }
];
const pageConfigPages = [
  { key: "home", label: "首页", desc: "轮播、推荐位、入口、首页模块排序" },
  { key: "spotList", label: "全部打卡点页", desc: "筛选、排序、打卡点卡片" },
  { key: "spotDetail", label: "打卡点详情页", desc: "顶部轮播、拍摄服务、打卡攻略、关联套餐" },
  { key: "seriesList", label: "风格系列页", desc: "风格筛选、照片单品、照片套餐" },
  { key: "seriesDetail", label: "风格系列详情页", desc: "风格轮播、主推套餐、推荐套餐、照片单品" },
  { key: "albumList", label: "照片单品列表页", desc: "照片单品筛选、风格标签、预约入口" },
  { key: "albumDetail", label: "照片单品详情页", desc: "轮播、照片/视频素材、描述、价格、拍摄说明、推荐内容" },
  { key: "videoList", label: "城市短视频页", desc: "打卡点筛选、短视频、短视频" },
  { key: "videoDetail", label: "短视频详情页", desc: "视频样片、拍摄说明、短视频推荐内容" },
  { key: "packageList", label: "套餐列表页", desc: "照片套餐、短视频、打卡点筛选" },
  { key: "packageDetail", label: "照片套餐详情页", desc: "包含的照片单品、适用打卡点、价格、说明、推荐内容" },
  { key: "videoPackageDetail", label: "短视频详情页", desc: "包含短视频、赠送照片、拍摄说明、相关推荐" },
  { key: "booking", label: "预约填写页", desc: "已选项目、手机号、联系人、加购篮、预约须知" },
  { key: "my", label: "我的页面", desc: "订单入口、客服、预约须知、品牌介绍" },
  { key: "orders", label: "订单列表/详情", desc: "订单状态、售后、取消、订单详情模块" },
  { key: "peripherals", label: "旅拍周边页", desc: "周边展厅、单品、DIY、相关推荐" },
  { key: "guides", label: "旅拍灵感/攻略页", desc: "攻略故事、关联套餐跳转" },
  { key: "brand", label: "品牌介绍/预约须知", desc: "品牌介绍、拍摄流程、服务条款" }
];
const pageModuleOptions = {
  home: [
    { key: "banner", label: "首页轮播" },
    { key: "entryGrid", label: "快捷入口" },
    { key: "hotSpots", label: "预约打卡点" },
    { key: "features", label: "特色专区" },
    { key: "bookingAlbums", label: "旅拍预约" },
    { key: "videoProducts", label: "城市短视频" },
    { key: "hotPackages", label: "热门套餐" },
    { key: "peripherals", label: "旅拍周边" }
  ],
  spotList: [
    { key: "filters", label: "筛选栏" },
    { key: "spotCards", label: "打卡点卡片" }
  ],
  spotDetail: [
    { key: "banner", label: "顶部轮播" },
    { key: "serviceIntro", label: "拍摄服务说明" },
    { key: "guide", label: "打卡攻略" },
    { key: "relatedPackages", label: "关联套餐" }
  ],
  seriesList: [
    { key: "filters", label: "风格筛选" },
    { key: "seriesCards", label: "风格系列卡片" },
    { key: "albums", label: "照片单品" },
    { key: "photoPackages", label: "照片套餐" }
  ],
  seriesDetail: [
    { key: "banner", label: "风格轮播" },
    { key: "mainPackage", label: "主推套餐" },
    { key: "albums", label: "照片单品" },
    { key: "recommendPackages", label: "推荐套餐" }
  ],
  albumList: [
    { key: "seriesFilter", label: "风格标签筛选" },
    { key: "spotFilter", label: "打卡点筛选" },
    { key: "albumCards", label: "照片单品卡片" }
  ],
  albumDetail: [
    { key: "banner", label: "顶部轮播" },
    { key: "samples", label: "素材库（照片/短视频）" },
    { key: "shootingNote", label: "拍摄说明" },
    { key: "recommendContent", label: "推荐内容" }
  ],
  videoList: [
    { key: "spotFilter", label: "打卡点筛选" },
    { key: "videoSingles", label: "短视频" },
    { key: "videoPackages", label: "短视频" }
  ],
  videoDetail: [
    { key: "video", label: "短视频" },
    { key: "shootingNote", label: "拍摄说明" },
    { key: "recommendVideos", label: "推荐短视频" },
    { key: "recommendContent", label: "推荐内容" }
  ],
  packageList: [
    { key: "spotFilter", label: "打卡点筛选" },
    { key: "photoPackages", label: "照片套餐" },
    { key: "videoPackages", label: "短视频" }
  ],
  packageDetail: [
    { key: "banner", label: "顶部轮播" },
    { key: "includedAlbums", label: "包含照片单品" },
    { key: "spotScope", label: "适用打卡点" },
    { key: "bookingRule", label: "预约规则" },
    { key: "recommendContent", label: "推荐内容" }
  ],
  videoPackageDetail: [
    { key: "videoSamples", label: "短视频" },
    { key: "includedVideos", label: "包含短视频" },
    { key: "giftAlbums", label: "赠送照片/样片" },
    { key: "bookingRule", label: "预约规则" },
    { key: "recommendVideos", label: "推荐短视频" }
  ],
  booking: [
    { key: "selectedItems", label: "已选项目" },
    { key: "contact", label: "联系人/手机号" },
    { key: "basket", label: "加购篮" },
    { key: "notice", label: "预约须知" }
  ],
  my: [
    { key: "orderStatus", label: "订单状态入口" },
    { key: "customerService", label: "联系客服" },
    { key: "bookingNotice", label: "预约须知" },
    { key: "brandIntro", label: "品牌介绍" }
  ],
  orders: [
    { key: "statusTabs", label: "状态筛选" },
    { key: "orderCards", label: "订单卡片" },
    { key: "afterSale", label: "售后入口" },
    { key: "cancelRule", label: "取消规则" }
  ],
  peripherals: [
    { key: "hero", label: "展厅首屏" },
    { key: "productCards", label: "周边商品" },
    { key: "diyEntry", label: "DIY入口" },
    { key: "recommendPackages", label: "搭配套餐" }
  ],
  guides: [
    { key: "categoryFilter", label: "分类筛选" },
    { key: "guideCards", label: "攻略卡片" },
    { key: "relatedPackage", label: "关联套餐跳转" }
  ],
  brand: [
    { key: "brandStory", label: "品牌介绍" },
    { key: "shootingFlow", label: "拍摄流程" },
    { key: "bookingNotice", label: "预约须知" },
    { key: "contact", label: "客服入口" }
  ]
};
function makeDefaultPageConfig(key) {
  const page = pageConfigPages.find((item) => item.key === key) || pageConfigPages[0];
  const cfg = {
    title: page.label,
    enabledModules: (pageModuleOptions[key] || []).map((item) => item.key),
    bannerIds: [],
    packageIds: [],
    albumIds: [],
    videoIds: [],
    guideIds: [],
    peripheralIds: []
  };
  // 「全部打卡点页」的筛选标签 / 排序选项：默认带一组合理值，运营可在后台编辑、增删。
  // 注意：categories 的 value 是拿去和打卡点名称/描述/地址/标签做"包含匹配"的关键词（如"古风"要能匹配到打了古风标签的打卡点），
  // 与小程序端 allSpots 的 DEFAULT_CATEGORIES / DEFAULT_SORT_OPTIONS 保持一致；运营可改，但改 value 需确保其能匹配到真实打卡点数据。
  if (key === "spotList") {
    cfg.categories = [
      { name: "全部", value: "" },
      { name: "地标大片", value: "地标" },
      { name: "夜景旅拍", value: "夜景" },
      { name: "老街漫步", value: "老街" },
      { name: "古风写真", value: "古风" },
      { name: "亲子旅拍", value: "亲子" }
    ];
    cfg.sortOptions = [
      { name: "热门优先", value: "hot" },
      { name: "最新整理", value: "new" },
      { name: "名称排序", value: "name" }
    ];
  }
  return cfg;
}
function ensurePageConfig(key = state.pageConfigActive) {
  const pages = state.homeConfig.pageModules || (state.homeConfig.pageModules = {});
  if (!pages[key]) pages[key] = makeDefaultPageConfig(key);
  return pages[key];
}
const activePageConfigMeta = computed(() => pageConfigPages.find((item) => item.key === state.pageConfigActive) || pageConfigPages[0]);
const activePageConfig = computed(() => ensurePageConfig(activePageConfigMeta.value.key));
const activePageModuleOptions = computed(() => pageModuleOptions[activePageConfigMeta.value.key] || []);
const publicMiniPreview = computed(() => {
  const publicPackages = data.packages.filter((item) => !item.deleted && productStatus(item) === "上架");
  const publicAlbums = data.albums.filter((item) => !item.deleted && (item.isShow !== false));
  const publicSamples = data.samples.filter((item) => !item.deleted && (item.isShow !== false));
  const publicPeripherals = data.peripherals.filter((item) => !item.deleted && productStatus(item) === "上架");
  const publicSpots = data.spots.filter((item) => !item.deleted && (item.isShow !== false));
  const publicGuides = data.guides.filter((item) => !item.deleted && item.status !== "草稿");
  const videoProducts = publicPackages.filter((item) => item.type === "video" || item.productType === "video" || item.displayType === "video");
  return {
    packages: publicPackages,
    albums: publicAlbums,
    samples: publicSamples,
    peripherals: publicPeripherals,
    spots: publicSpots,
    guides: publicGuides,
    videoProducts,
    summary: [
      { label: "公开打卡点", value: publicSpots.length },
      { label: "在售套餐", value: publicPackages.length },
      { label: "照片单品", value: publicAlbums.length },
      { label: "短视频商品", value: videoProducts.length }
    ]
  };
});
const activePageRelationGroups = computed(() => {
  const preview = publicMiniPreview.value;
  return [
    { field: "bannerIds", title: "轮播/样片素材", limit: 6, rows: preview.samples, price: false },
    { field: "packageIds", title: "关联套餐", limit: 8, rows: preview.packages, price: true },
    { field: "albumIds", title: "关联照片单品", limit: 8, rows: preview.albums, price: true },
    { field: "videoIds", title: "关联短视频", limit: 8, rows: preview.videoProducts, price: true },
    { field: "guideIds", title: "关联攻略/内容", limit: 6, rows: preview.guides, price: false },
    { field: "peripheralIds", title: "关联周边", limit: 6, rows: preview.peripherals, price: true }
  ];
});
const miniPreviewCurrentPage = computed(() => miniPreviewPages.find((item) => item.key === state.miniPreviewPage) || miniPreviewPages[0]);
const miniPreviewCurrentPackage = computed(() => data.packages.find((item) => item.id === state.miniPreviewCurrentId) || publicMiniPreview.value.packages[0] || {});
const miniPreviewCurrentAlbum = computed(() => data.albums.find((item) => item.id === state.miniPreviewCurrentId) || publicMiniPreview.value.albums[0] || {});
const miniPreviewCurrentSeries = computed(() => data.series.find((item) => item.id === state.miniPreviewCurrentId) || data.series[0] || {});
const miniPreviewCurrentOrder = computed(() => scopedOrders.value.find((item) => item.id === state.miniPreviewCurrentId) || scopedOrders.value[0] || {});
const miniPreviewSpotSeries = computed(() => data.series.filter((item) => !state.miniPreviewCurrentId || item.spotId === state.miniPreviewCurrentId || (item.spotIds || []).includes(state.miniPreviewCurrentId)));
const miniPreviewSeriesAlbums = computed(() => data.albums.filter((item) => item.seriesId === miniPreviewCurrentSeries.value.id));
const miniPreviewAlbumSamples = computed(() => data.samples.filter((item) => item.albumId === miniPreviewCurrentAlbum.value.id || (miniPreviewCurrentAlbum.value.photoIds || []).includes(item.id)).slice(0, 9));
function miniPreviewGo(page, id = "") {
  state.miniPreviewHistory.push({ page: state.miniPreviewPage, id: state.miniPreviewCurrentId });
  state.miniPreviewPage = page;
  state.miniPreviewCurrentId = id || "";
}
function miniPreviewBack() {
  const previous = state.miniPreviewHistory.pop();
  if (!previous) return miniPreviewReset();
  state.miniPreviewPage = previous.page;
  state.miniPreviewCurrentId = previous.id;
}
function miniPreviewReset() {
  state.miniPreviewPage = "home";
  state.miniPreviewCurrentId = "";
  state.miniPreviewHistory = [];
}
function selectPageConfig(key) {
  state.pageConfigActive = key;
  ensurePageConfig(key);
}
function togglePageModule(key) {
  const config = ensurePageConfig();
  const list = config.enabledModules || (config.enabledModules = []);
  const index = list.indexOf(key);
  if (index >= 0) list.splice(index, 1);
  else list.push(key);
  log("调整页面模块", activePageConfigMeta.value.label, key);
}
function togglePageRelation(field, id, limit = 8) {
  const config = ensurePageConfig();
  const list = config[field] || (config[field] = []);
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  else {
    if (list.length >= limit) return ElMessage.warning(`最多选择 ${limit} 个`);
    list.push(id);
  }
}

  return {
    homeModuleOptions,
    homePreview,
    miniPreviewPages,
    pageConfigPages,
    pageModuleOptions,
    makeDefaultPageConfig,
    ensurePageConfig,
    activePageConfigMeta,
    activePageConfig,
    activePageModuleOptions,
    publicMiniPreview,
    activePageRelationGroups,
    miniPreviewCurrentPage,
    miniPreviewCurrentPackage,
    miniPreviewCurrentAlbum,
    miniPreviewCurrentSeries,
    miniPreviewCurrentOrder,
    miniPreviewSpotSeries,
    miniPreviewSeriesAlbums,
    miniPreviewAlbumSamples,
    miniPreviewGo,
    miniPreviewBack,
    miniPreviewReset,
    selectPageConfig,
    togglePageModule,
    togglePageRelation
  };
});
