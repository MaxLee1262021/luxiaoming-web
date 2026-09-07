// 后台数据池键名(key) → 云数据库集合名(collection) 的映射。
// 演示模式下后台按 key 取数（与 mock 键名一致），无需此映射；
// 切换到真实云模式时，后端用此映射把 key 翻译成真实集合名。
// 待你部署时按真实云函数/集合核对，标注"待确认"的为推断值。
module.exports = {
  samples: "travel_photos",
  orders: "bookings",
  // 售后工单必须使用独立集合，不能把整张 bookings 订单集合当作工单读取。
  afterSales: "afterSales",
  staff: "users",
  scans: "scanRecords",
  homeConfig: "config", // 存于 config 文档(homeStats)中
  addonServices: "peripherals", // 待确认：增值服务可能独立集合或并入 config
  // 以下 key 与集合同名：spots, series, albums, packages, peripherals,
  // guides, stories, shops, cities, agents, distributors, logs, trash(软删除标记)
};
