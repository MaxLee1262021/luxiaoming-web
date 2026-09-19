// 全局状态、本地持久化与菜单角色基础
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    computed,
    reactive
  } = ctx;

const state = reactive({
  authed: false,
  cloudMode: "checking",
  loading: false,
  saving: false,
  dataLoading: false,
  menuDataLoadingKey: "",
  menuDataRequestId: 0,
  login: { account: "", password: "" },
  loginRole: "",
  currentAccount: "",
  changePwd: { open: false, oldPwd: "", newPwd: "", confirmPwd: "", loading: false },
  role: "super",
  previewRole: "super",
  currentStaffId: "st1",
  active: "dashboard",
  dashboardShortcut: "",
  advFiltersOpen: false,
  orderPage: 1,
  orderPageSize: 12,
  orderRefreshing: false,
  listPage: ["staff","shops","distributors","tags","trash","cities","logs","shelf","tasks","afterSaleActive","afterSaleRecords","financeReview","financeReviewRecords","productAudit","reconSettlement","reconHold","reconTransfer","reconAdjustments"].reduce((o, k) => (o[k] = { page: 1, size: 12 }, o), {}),
  filters: {
    dateRange: "",
    cityId: "",
    agentId: "",
    distributorId: "",
    shopId: "",
    sourceType: "",
    status: "",
    financeStatus: "",
    afterSaleStatus: "",
    refundStatus: "",
    transferStatus: "",
    rescheduleStatus: "",
    assigneeId: "",
    photographerId: "",
    productType: "",
    logUser: "",
    logModule: "",
    logLevel: "",
    logAction: "",
    keyword: "",
    settlementStatus: "",
    staffRole: "",
    reconcileMonth: "",
    contentStatus: "",
    contentSpotId: "",
    contentSeriesId: "",
    shelfType: "",
  },
  dashboardDrill: "",
  dashboardCityId: "",
  dashboardShopId: "",
  dashboardProductDetailsOpen: true,
  metricDialog: false,
  metricFilters: { cityId: "", shopId: "", scene: "", status: "", keyword: "" },
  exportDialog: false,
  exportType: "dashboardSummary",
  exportScopeMenu: "dashboard",
  exportTargetType: "",
  exportTargetId: "",
  reconciliationTab: "settlement",
  reconciliationFiltersExpanded: false,
  reconciliationCompactMode: false,
  reconciliationFilterPresets: [
    { id: "preset-settle", name: "待结算对", filters: { settlementStatus: "待结" } },
    { id: "preset-hq", name: "总部二维码订", filters: { sourceType: "headquarter" } },
  ],
  reconciliationDialog: false,
  adjustmentDialog: false,
  adjustmentForm: { orderNo: "", type: "结算后退", amount: 0, targetType: "商家", targetName: "", note: "", attachment: "" },
  reconciliationDetail: { title: "", desc: "", rows: [], amountLabel: "金额", record: null },
  settlementDialog: false,
  settlementForm: { amount: 0, method: "", voucherNo: "", note: "", selectedOrderIds: [] },
  settlementTarget: null,
  selectedReconciliationKeys: [],
  selectedShelfKeys: [],
  scopeCollapsed: false,
  selectedOrderIds: [],
  manualOrderDialog: false,
  manualOrderForm: {
    customer: "",
    phone: "",
    wechat: "",
    sourceType: "manual",
    shopId: "",
    distributorId: "",
    productId: "",
    productType: "package",
    appointmentAt: "",
    timePeriod: "待客服确",
    internalNote: "",
  },
  orderDrawer: false,
  orderReadonly: false,
  orderWorkMode: "service",
  currentOrder: null,
  confirmationDialog: false,
  confirmationForm: {
    appointmentAt: "",
    timePeriod: "",
    appointmentLocation: "",
    peopleCount: 1,
    serviceContent: "",
    totalAmount: 0,
    depositRatioPercent: 0,
    finalDiscountAmount: 0,
    priceAdjustReason: "",
    reason: ""
  },
  dispatchDialog: false,
  dispatchForm: {
    photographerId: "",
    appointmentAt: "",
    timePeriod: "",
    appointmentLocation: "",
    peopleCount: 1,
    note: ""
  },
  transferDialog: false,
  transferForm: { assigneeId: "", photographerId: "", note: "", batch: false },
  batchNoteDialog: false,
  batchNoteText: "",
  exceptionDialog: false,
  exceptionForm: { status: "", customerStatus: "", sourceType: "", shopId: "", distributorId: "", clearRisk: false, reason: "" },
  rescheduleDialog: false,
  rescheduleForm: { appointmentAt: "", timePeriod: "待客服确认", reason: "" },
  contactDraft: { phone: "", wechat: "" },
  currentFinanceReview: null,
  completeOrderDialog: false,
  completeOrderNote: "",
  afterSaleSubmitDialog: false,
  afterSaleForm: { type: "退款申请", reason: "", refundAmount: 0 },
  currentAfterSale: null,
  afterSaleProcessForm: { action: "协商处理", note: "", refundAmount: 0, refundConfirmed: false },
  moneyEdit: "",
  moneyDraft: 0,
  followText: "",
  productDialog: false,
  currentProduct: null,
  rankPreviewDialog: false,
  rankPreview: null,
  reminderPreviewDialog: false,
  reminderPreview: null,
  addonDialog: false,
  addonKeyword: "",
  addonScope: { type: "common", id: "" },
  addonOpen: { common: true, commonPeripheral: true, commonService: true, root: true, contentRoot: true, navContent: true, navProduct: true, point: {}, seriesRoot: {}, series: {} },
  sidebarCollapsed: false,
  menuSearch: "",
  menuRevision: 0,
  selectedAddonKeys: [],
  imagePreview: false,
  zoomUrl: "",
  timelineDialog: false,
  timelineCategoryFilter: "",
  staffDialog: false,
  editStaff: null,
  distributorDialog: false,
  editDistributor: null,
  shopDialog: false,
  editShop: null,
  qrDialog: false,
  currentShop: null,
  qrPositions: [
    { type: "counter", label: "吧台" },
    { type: "table", label: "桌子" },
    { type: "menu", label: "菜单" },
    { type: "room", label: "房间" }
  ],
  qrPlacementType: "counter",
  qrCustomLabel: "",
  qrGenerating: false,
  qrPreview: null,
  merchantCodes: [],
  merchantCodeStats: { scans: 0, orders: 0, deals: 0, codeCount: 0 },
  tagDialog: false,
  editTag: null,
  tagCategoryFilter: "",
  albumReplaceDialog: false,
  albumReplaceForm: { fromAlbumId: "", toAlbumId: "" },
  auditRejectReason: "",
  miniPreviewPage: "home",
  miniPreviewCurrentId: "",
  miniPreviewHistory: [],
  pageConfigActive: "spotDetail",
  contentScope: { type: "", id: "" },
  contentDialog: false,
  editContent: null,
  amapPicker: {
    open: false,
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
  },
  videoSingleDialog: false,
  videoSingleForm: null,
  seriesDialog: false,
  seriesForm: null,
  homeConfig: { ...LXM_DATA.homeConfig },
  siteConfig: { ...LXM_DATA.siteConfig },
  logs: [...LXM_DATA.logs],
  trash: [...LXM_DATA.trash],
});

const data = reactive({
  cities: LXM_DATA.cities,
  agents: LXM_DATA.agents || [],
  distributors: LXM_DATA.distributors || [],
  shops: LXM_DATA.shops || [],
  staff: LXM_DATA.staff,
  spots: LXM_DATA.spots,
  series: LXM_DATA.series,
  albums: LXM_DATA.albums,
  samples: LXM_DATA.samples,
  packages: LXM_DATA.packages,
  addonServices: LXM_DATA.addonServices,
  peripherals: LXM_DATA.peripherals,
  videoSingles: LXM_DATA.videoSingles || [],
  tagLibrary: LXM_DATA.tagLibrary || [
    { id: "tag1", name: "清新自然", category: "风格", status: "启用", sort: 10, scope: "照片单品/套餐", color: "#E0662A" },
    { id: "tag2", name: "复古胶片", category: "风格", status: "启用", sort: 20, scope: "照片单品/套餐", color: "#EE2C2C" },
    { id: "tag3", name: "情侣出游", category: "人群", status: "启用", sort: 30, scope: "套餐", color: "#dc2626" },
    { id: "tag4", name: "亲子旅拍", category: "人群", status: "启用", sort: 40, scope: "套餐", color: "#1F9254" },
    { id: "tag5", name: "热门打卡", category: "场景", status: "启用", sort: 50, scope: "打卡/货架", color: "#ea580c" },
    { id: "tag6", name: "暑期活动", category: "活动", status: "启用", sort: 60, scope: "货架", color: "#0891b2" }
  ],
  guides: LXM_DATA.guides,
  stories: LXM_DATA.stories,
  scans: LXM_DATA.scans,
  orders: LXM_DATA.orders,
  afterSales: LXM_DATA.afterSales || [],
  reconciliationTransfers: LXM_DATA.reconciliationTransfers || [],
  financeSettings: { settlementObservationDays: 3, largeSettlementThreshold: 5000, ...(LXM_DATA.financeSettings || {}) },
  monthlyClosings: LXM_DATA.monthlyClosings || [],
  adjustmentRecords: LXM_DATA.adjustmentRecords || [],
});

// === 接入真实数据（鹿小鸣云环境 / 演示模式，由 server 决定） ===
// 后台启动后逐键从 /api 拉取数据写入响应式数据池；拉取失败则保留本地默认值。
// 顶栏「连接状态」徽标：监听 cloud.js 健康探测结果（/api/health 返回 mode），
// 把 mode 同步进响应式 state，使徽标实时反映「已连真实库 / 演示模式」，避免运营误以为改动没保存。
window.addEventListener("lxm-cloud-mode", (e) => { state.cloudMode = e.detail || "mock"; });
setTimeout(() => { if (!state.cloudMode || state.cloudMode === "checking") state.cloudMode = window.LXM_CLOUD_MODE || "mock"; }, 1000);
// ===== 演示模式本地持久化（无云密钥也能完整体验管理流程）=====
// 仅演示模式生效；接真实云后由 /api 接管，本地存储自动让位。
const LXM_STORAGE_KEY = "lxm_admin_local_v1";
const LXM_PERSIST_KEYS = ["cities","spots","series","albums","samples","packages","addonServices","peripherals","tagLibrary","guides","stories"];
let _lxmPersistTimer = null;
function lxmSafeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (k, v) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return undefined;
      seen.add(v);
    }
    return v;
  });
}
function persistData() {
  try {
    const snap = {};
    LXM_PERSIST_KEYS.forEach((k) => { if (data[k]) snap[k] = data[k]; });
    snap.__homeConfig = state.homeConfig;
    snap.__siteConfig = state.siteConfig;
    localStorage.setItem(LXM_STORAGE_KEY, lxmSafeStringify(snap));
  } catch (e) { /* 隐私模式或配额超限，忽略 */ }
}
function hydrateFromStorage() {
  try {
    const raw = localStorage.getItem(LXM_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    LXM_PERSIST_KEYS.forEach((k) => {
      // 防御：剔除 undefined / null 空槽 + 非对象条目，避免历史脏数据让模板 v-for :key="s.id" 报 "Cannot read properties of undefined"
      if (Array.isArray(saved[k])) data[k] = saved[k].filter((item) => item && typeof item === "object");
    });
    if (saved.__homeConfig && typeof saved.__homeConfig === "object") state.homeConfig = saved.__homeConfig;
    if (saved.__siteConfig && typeof saved.__siteConfig === "object") state.siteConfig = saved.__siteConfig;
  } catch (e) { /* 本地数据损坏，忽略并回退演示数据 */ }
}
function schedulePersist() {
  if (_lxmPersistTimer) clearTimeout(_lxmPersistTimer);
  _lxmPersistTimer = setTimeout(persistData, 400);
}
if (!(window.LXM_CLOUD && window.LXM_CLOUD.loadAdminData)) {
  hydrateFromStorage();
}

// 修复：模板中引用了以下 state 属性但未初始化，会导致对应页面渲染即崩溃（点击无反应）。
// 在此补上默认值，保证照片单品 / 商品上下架等页面正常渲染。
if (!Array.isArray(state.albumUploadQueue)) state.albumUploadQueue = [];
if (state.lastShelfBatchResult === undefined) state.lastShelfBatchResult = null;

const contentKeys = ["spots", "series", "albums", "samples", "shelfProducts", "packages", "videoProducts", "contentTags", "addonServices", "peripherals", "guides", "stories", "homeConfig", "cities"];
const statusDict = LXM_CONFIG.orderStatuses;
const serviceStatusDict = computed(() => statusDict.filter((status) => !["completed", "cancelled"].includes(status.value)));
const roleProfile = computed(() => {
  state.menuRevision;
  return LXM_CONFIG.roles[state.role] || LXM_CONFIG.roles.super;
});
const currentStaff = computed(() => data.staff.find((s) => s.id === state.currentStaffId) || null);
const canPreviewRoles = computed(() => state.loginRole === "super");
const isMenuEnabled = (menu) => !["停用", "disabled", "inactive"].includes(String(menu?.status || "").trim().toLowerCase());
const menus = computed(() => {
  state.menuRevision;
  return LXM_CONFIG.menus.filter((m) => roleProfile.value.menus.includes(m.key) && isMenuEnabled(m));
});
const sidebarSections = computed(() => {
  state.menuRevision;
  const allowed = new Set((roleProfile.value.menus || []).map(String));
  const rows = (LXM_CONFIG.menus || [])
    .filter((item) => item && isMenuEnabled(item) && (allowed.has(String(item.key)) || item.containerOnly === true))
    .map((item, index) => ({ ...item, _index: index, navigable: allowed.has(String(item.key)), children: [] }));
  const byKey = new Map(rows.map((item) => [String(item.key), item]));
  const parentKeyOf = (item) => String(item.parentKey || item.parentId || "").trim();
  const sortRows = (items) => items.sort((left, right) => {
    const leftSort = Number(left.sort ?? left.sortNo ?? 0);
    const rightSort = Number(right.sort ?? right.sortNo ?? 0);
    return leftSort - rightSort || left._index - right._index || String(left.key).localeCompare(String(right.key));
  });
  const roots = [];
  rows.forEach((item) => {
    const parent = byKey.get(parentKeyOf(item));
    // A malformed legacy third level is flattened rather than rendered as a
    // third navigation level. The server rejects new records of that shape.
    if (parent && !parentKeyOf(parent)) parent.children.push(item);
    else roots.push(item);
  });
  const sections = new Map();
  sortRows(roots).forEach((item) => {
    sortRows(item.children);
    item.children = item.children.filter((child) => child.navigable);
    if (!item.navigable && !item.children.length) return;
    const group = String(item.group || "其他功能").trim() || "其他功能";
    if (!sections.has(group)) sections.set(group, { key: `group-${group}`, label: group, items: [] });
    sections.get(group).items.push(item);
  });
  return [...sections.values()];
});
const activeMenu = computed(() => {
  state.menuRevision;
  return menus.value.find((menu) => menu.key === state.active)
    || menus.value[0]
    || { key: "", label: "", group: "" };
});
const activeRouteKey = computed(() => {
  const key = activeMenu.value && (activeMenu.value.routeKey || activeMenu.value.targetKey || activeMenu.value.key);
  return key === "videoProducts" ? "packages" : (key || "");
});
const groupLabelOf = (groupKey) => String(groupKey || "").trim();
const breadcrumbTrail = computed(() => [groupLabelOf(activeMenu.value.group), activeMenu.value.label].filter(Boolean));
const searchedMenus = computed(() => {
  state.menuRevision;
  const keyword = (state.menuSearch || "").trim().toLowerCase();
  if (!keyword) return [];
  return LXM_CONFIG.menus
    .filter((m) => roleProfile.value.menus.includes(m.key) && isMenuEnabled(m))
    .filter((m) => m.label.toLowerCase().includes(keyword) || groupLabelOf(m.group).toLowerCase().includes(keyword))
    .slice(0, 12)
    .map((m) => ({ key: m.key, label: m.label, groupLabel: groupLabelOf(m.group) }));
});
function menuIcon(key) {
  return (window.LXM_MENU_ICONS || {})[key] || "";
}
function goMenuFromSearch(item) {
  state.menuSearch = "";
  if (item && item.key) ctx.switchMenu(item.key);
}
const photographers = computed(() => data.staff.filter((s) => s.role === "photo"));
const services = computed(() => data.staff.filter((s) => s.role === "service"));
const manualOrderProducts = computed(() => [
  ...data.packages.filter((item) => ctx.productStatus(item) === "上架").map((item) => ({ ...item, productType: "package" })),
  ...data.addonServices.filter((item) => item.enabled !== false).map((item) => ({ ...item, productType: "service" })),
  ...data.peripherals.filter((item) => ctx.productStatus(item) === "上架").map((item) => ({ ...item, productType: "peripheral" })),
]);
const visibleCities = computed(() => {
  if (!(state.role === "agent" && state.loginRole !== "super")) return data.cities;
  const target = String(roleProfile.value.cityId || "");
  return data.cities.filter((city) => [city.id, city._id, city.cityId, city.code, city.name, city.city].filter(Boolean).map(String).includes(target));
});
const visibleDistributors = computed(() => {
  if (state.role === "agent") {
    const agentId = state.loginRole === "super" && state.filters.agentId ? state.filters.agentId : roleProfile.value.agentId;
    return data.distributors.filter((d) => d.agentId === agentId);
  }
  if (state.role === "distributor") return data.distributors.filter((d) => d.id === roleProfile.value.distributorId);
  return data.distributors;
});


  return {
    state,
    data,
    LXM_STORAGE_KEY,
    LXM_PERSIST_KEYS,
    lxmSafeStringify,
    persistData,
    hydrateFromStorage,
    schedulePersist,
    contentKeys,
    statusDict,
    serviceStatusDict,
    roleProfile,
    currentStaff,
    canPreviewRoles,
    menus,
    sidebarSections,
    activeMenu,
    activeRouteKey,
    groupLabelOf,
    breadcrumbTrail,
    searchedMenus,
    menuIcon,
    goMenuFromSearch,
    photographers,
    services,
    manualOrderProducts,
    visibleCities,
    visibleDistributors
  };
});
