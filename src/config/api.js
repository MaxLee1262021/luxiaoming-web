// 后台 ↔ 接口 的连接配置
// base: 接口基地址。集成服务器同源提供网页与 /api，用相对路径即可；
//       若以后后台部署到别的域名，把这里改成完整地址（如 https://admin.your.com/api）
// dataKeys / stateKeys: 后台数据池用到的键，对应 src/app.js 里 data / state 的对象键。
//   后台启动时会逐个向接口拉取这些键的真实数据，替换原来的本地演示数据。
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
  docKeys: ["siteConfig"]
};
