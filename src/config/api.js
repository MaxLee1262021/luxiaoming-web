// 后台 ↔ 接口 的连接配置
// base: 接口基地址。集成服务器同源提供网页与 /api，用相对路径即可；
//       若以后后台部署到别的域名，把这里改成完整地址（如 https://admin.your.com/api）
// dataKeys / stateKeys: 后台数据池支持的全部键，对应 src/app.js 里 data / state 的对象键。
// 它们只用于识别和写回；登录后不会自动全量请求。实际读取范围由 menuData 决定。
window.LXM_API_CONFIG = {
  base: "/api",
  dataKeys: [
    "cities", "agents", "distributors", "shops", "staff", "spots", "series",
    "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary",
    "guides", "stories", "scans", "orders", "afterSales", "reconciliationTransfers",
    "financeSettings", "monthlyClosings", "adjustmentRecords"
  ],
  stateKeys: ["homeConfig", "logs", "trash"],
  // docKeys: 按固定 id 存的「单文档配置」，不是集合数组。
  //   siteConfig -> 固定 id "global"，doc 本身即编辑器模型（约拍定价/预约须知/隐私/企微/热词/章册）。
  docKeys: ["siteConfig"],
  // 菜单数据包：进入菜单时才按此表读取，且每次菜单切换都重新请求该菜单的数据。
  // 业务接口只拉当前页面和其打开的订单/编辑器所需引用，避免登录阶段扫完所有集合。
  menuData: {
    dashboard: ["cities", "agents", "distributors", "shops", "staff", "spots", "series", "albums", "packages", "addonServices", "peripherals", "scans", "orders", "afterSales"],
    performance: ["orders", "shops", "scans", "cities", "agents", "distributors", "staff"],
    trace: ["orders", "scans", "shops"],
    orders: ["orders", "afterSales", "shops", "cities", "distributors", "agents", "staff", "packages", "albums", "peripherals", "addonServices", "spots", "series", "samples"],
    receive: ["orders", "afterSales", "shops", "staff", "packages", "albums", "peripherals", "addonServices"],
    dispatch: ["orders", "afterSales", "shops", "staff", "packages", "albums", "peripherals", "addonServices"],
    tasks: ["orders", "afterSales", "staff", "shops", "packages", "albums", "peripherals", "addonServices"],
    afterSales: ["afterSales", "orders", "staff", "shops", "cities", "distributors", "agents", "packages", "albums", "peripherals", "addonServices"],
    financeReview: ["orders", "afterSales", "shops", "staff"],
    reconciliation: ["orders", "afterSales", "shops", "distributors", "agents", "staff", "cities", "reconciliationTransfers", "monthlyClosings", "adjustmentRecords", "financeSettings"],
    report: ["orders", "afterSales", "shops", "distributors", "agents", "staff", "cities", "reconciliationTransfers", "monthlyClosings", "adjustmentRecords", "financeSettings"],
    staff: ["staff", "cities"],
    distributors: ["distributors", "shops", "agents"],
    shops: ["shops", "distributors", "agents", "cities"],
    contentOverview: ["cities", "spots", "series", "samples", "albums", "packages", "peripherals", "guides"],
    spots: ["spots", "cities", "series", "albums", "packages", "peripherals", "orders"],
    cities: ["cities", "spots", "shops"],
    series: ["series", "spots", "albums", "packages"],
    albums: ["albums", "samples", "series", "spots", "packages", "orders", "tagLibrary"],
    samples: ["samples", "albums", "spots", "series", "tagLibrary"],
    contentTags: ["tagLibrary", "spots", "albums", "packages", "peripherals", "guides", "stories"],
    packages: ["packages", "spots", "series", "albums", "peripherals", "samples", "orders", "addonServices", "tagLibrary"],
    videoSingles: ["packages", "spots", "series"],
    shelfProducts: ["packages", "albums", "peripherals", "orders"],
    productAudit: ["packages", "albums", "peripherals"],
    addonServices: ["addonServices", "packages", "albums", "peripherals", "samples"],
    peripherals: ["peripherals", "spots", "series", "packages", "orders"],
    miniDecor: ["homeConfig", "spots", "series", "samples", "albums", "packages", "peripherals", "guides", "stories"],
    miniConfig: ["siteConfig"],
    guides: ["guides", "spots", "series"],
    stories: ["stories"],
    logs: ["logs"],
    trash: ["trash"],
    // 权限页有独立的 /api/permissions/* 接口，并在组件挂载时按菜单加载。
    permissions: []
  }
};
