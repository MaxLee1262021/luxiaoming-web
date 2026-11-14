// 全局状态与菜单角色基础：业务数据只由认证后的真实接口载入
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
  currentStaffId: "",
  active: "dashboard",
  svcCreateRequested: false,
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
  dashboardTab: "traffic",
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
  orderDrawer: false,
  orderReadonly: false,
  orderLedgerDetail: false,
  orderWorkMode: "service",
  currentOrder: null,
  orderSection: "info",
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
    confirmationMethod: "",
    customerConfirmationNote: "",
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
  sidebarGroupCollapsed: {},
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
  merchantCodeStats: { scans: 0, unique: 0, dailyUnique: 0, todayUnique: 0, orders: 0, deals: 0, codeCount: 0 },
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
  homeConfig: {},
  siteConfig: {},
  logs: [],
  trash: [],
});

const data = reactive({
  cities: [],
  agents: [],
  distributors: [],
  shops: [],
  staff: [],
  spots: [],
  series: [],
  albums: [],
  samples: [],
  packages: [],
  addonServices: [],
  peripherals: [],
  videoSingles: [],
  tagLibrary: [],
  guides: [],
  stories: [],
  scans: [],
  orders: [],
  afterSales: [],
  reconciliationTransfers: [],
  monthlyClosings: [],
  adjustmentRecords: [],
  financeSettings: {}
});

// 连接状态来自真实服务的健康探测，不恢复浏览器中的历史业务快照。
window.addEventListener("lxm-cloud-mode", (e) => { state.cloudMode = e.detail || "unavailable"; });
setTimeout(() => { if (!state.cloudMode || state.cloudMode === "checking") state.cloudMode = window.LXM_CLOUD_MODE || "unavailable"; }, 1000);

// 修复：模板中引用了以下 state 属性但未初始化，会导致对应页面渲染即崩溃（点击无反应）。
// 在此补上默认值，保证照片单品 / 商品上下架等页面正常渲染。
if (!Array.isArray(state.albumUploadQueue)) state.albumUploadQueue = [];
if (state.lastShelfBatchResult === undefined) state.lastShelfBatchResult = null;

const contentKeys = ["spots", "series", "albums", "samples", "shelfProducts", "packages", "videoProducts", "contentTags", "addonServices", "peripherals", "guides", "stories", "homeConfig", "cities"];
const statusDict = LXM_CONFIG.orderStatuses.filter((status) => ["reserved", "awaiting_shoot", "shooting", "completed", "cancelled"].includes(status.value));
const serviceStatusDict = computed(() => statusDict.filter((status) => !["completed", "cancelled"].includes(status.value)));
const roleProfile = computed(() => {
  state.menuRevision;
  return LXM_CONFIG.roles[state.role] || LXM_CONFIG.roles.super;
});
const currentStaff = computed(() => data.staff.find((s) => s.id === state.currentStaffId) || null);
const canPreviewRoles = computed(() => false);
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
    .map((item, index) => ({ ...item, _index: index, navigable: item.containerOnly !== true && allowed.has(String(item.key)), children: [] }));
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
  // Keep top-level navigation in the configured order despite saved menu sort values.
  const groupOrder = new Map((LXM_CONFIG.groups || []).map((group, index) => [group, index]));
  return [...sections.values()]
    .sort((left, right) => (groupOrder.get(left.label) ?? Number.MAX_SAFE_INTEGER) - (groupOrder.get(right.label) ?? Number.MAX_SAFE_INTEGER))
    .map((section) => {
      // Commission management keeps its agreed task order even when a saved
      // server definition still carries the previous menu positions.
      if (section.items.some((item) => item.navigationOrder !== undefined)) {
        section.items.sort((left, right) => Number(left.navigationOrder ?? Number.MAX_SAFE_INTEGER) - Number(right.navigationOrder ?? Number.MAX_SAFE_INTEGER));
      }
      return section;
    });
});
const activeMenu = computed(() => {
  state.menuRevision;
  return menus.value.find((menu) => menu.key === state.active)
    || menus.value[0]
    || { key: "", label: "", group: "" };
});
const isSidebarSectionCollapsed = (section) => state.sidebarGroupCollapsed[section.label] === true;
function toggleSidebarSection(section) {
  state.sidebarGroupCollapsed[section.label] = !isSidebarSectionCollapsed(section);
}
function expandSidebarForMenu(key) {
  const section = sidebarSections.value.find((row) => row.items.some((item) => item.key === key || item.children.some((child) => child.key === key)));
  if (section) state.sidebarGroupCollapsed[section.label] = false;
}
ctx.watch?.(() => [state.active, state.menuRevision, state.role, activeMenu.value.group], () => expandSidebarForMenu(state.active));
const activeRouteKey = computed(() => {
  const key = activeMenu.value && (activeMenu.value.routeKey || activeMenu.value.targetKey || activeMenu.value.key);
  return key === "videoProducts" ? "packages" : (key || "");
});
const groupLabelOf = (groupKey) => String(groupKey || "").trim();
const menuParent = (menu) => LXM_CONFIG.menus.find((item) => item.key === (menu.parentKey || menu.parentId));
const breadcrumbTrail = computed(() => [groupLabelOf(activeMenu.value.group), menuParent(activeMenu.value)?.label, activeMenu.value.label].filter(Boolean));
const searchedMenus = computed(() => {
  state.menuRevision;
  const keyword = (state.menuSearch || "").trim().toLowerCase();
  if (!keyword) return [];
  return LXM_CONFIG.menus
    .filter((m) => roleProfile.value.menus.includes(m.key) && isMenuEnabled(m))
    .filter((m) => [m.label, groupLabelOf(m.group), menuParent(m)?.label || ''].some((label) => label.toLowerCase().includes(keyword)))
    .slice(0, 12)
    .map((m) => ({ key: m.key, label: m.label, groupLabel: [groupLabelOf(m.group), menuParent(m)?.label].filter(Boolean).join(' · ') }));
});
function menuIcon(key) {
  return (window.LXM_MENU_ICONS || {})[key] || "";
}
function goMenuFromSearch(item) {
  state.menuSearch = "";
  if (item && item.key) {
    expandSidebarForMenu(item.key);
    ctx.switchMenu(item.key);
  }
}
const photographers = computed(() => {
  const profiles = ctx.photoState?.options || [];
  const known = new Set(profiles.map((row) => row.id));
  return [...profiles.filter((row) => row.status === "active"), ...data.staff.filter((row) => row.role === "photo" && !known.has(row.id))];
});
const services = computed(() => data.staff.filter((s) => s.role === "service"));
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
    contentKeys,
    statusDict,
    serviceStatusDict,
    roleProfile,
    currentStaff,
    canPreviewRoles,
    menus,
    sidebarSections,
    isSidebarSectionCollapsed,
    toggleSidebarSection,
    expandSidebarForMenu,
    activeMenu,
    activeRouteKey,
    groupLabelOf,
    breadcrumbTrail,
    searchedMenus,
    menuIcon,
    goMenuFromSearch,
    photographers,
    services,
    visibleCities,
    visibleDistributors
  };
});
