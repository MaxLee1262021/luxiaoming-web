window.LXM_CONFIG = {
  // 暂停原订单管理的编辑能力；保留原实现，恢复时关闭此只读开关。
  orderLedgerReadOnly: true,
  groups: ["经营中心", "订单履约", "内容管理", "客服工作台", "客服分成管理", "摄影师分成管理", "商家分成管理", "财务管理", "内容运营", "系统安全", "渠道增长"],
  // Menu records may use a custom key, but the target page must be one of
  // these registered route keys. Keep this catalog aligned with the API.
  routeMenuKeys: ["photoMine", "dashboard", "orders", "afterSales", "tasks", "addonServices", "financeReview", "reconciliation", "staff", "distributors", "shareRules", "shareDetails", "shareMine", "photoRules", "photoLedger", "photoSettlement", "photoParty", "contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "bookingConfig", "guides", "permissions", "logs", "trash"],
  menus: [
    { key: "dashboard", label: "经营看板", group: "经营中心", navigationOrder: 0 },
    { key: "orders", label: "订单流水", group: "订单履约", navigationOrder: 0 },
    { key: "afterSales", label: "售后服务", group: "订单履约", navigationOrder: 1 },
    { key: "financeReview", label: "财务审核", group: "财务管理", navigationOrder: 0 },
    { key: "reconciliation", label: "月度对账", group: "财务管理", navigationOrder: 1 },
    { key: "tasks", label: "拍摄任务", group: "订单履约", navigationOrder: 2 },
    { key: "staff", label: "人员管理", group: "渠道增长" },
    { key: "distributors", label: "分销管理", group: "渠道增长" },
    { key: "shareRules", label: "配置列表", group: "商家分成管理", navigationOrder: 0 },
    { key: "shareDetails", label: "分成明细", group: "商家分成管理", navigationOrder: 1 },
    { key: "shareMine", label: "商家端", group: "商家分成管理", navigationOrder: 2 },
    { key: "photoRules", label: "分成配置", group: "摄影师分成管理", navigationOrder: 0 },
    { key: "photoLedger", label: "分成明细", group: "摄影师分成管理", navigationOrder: 1 },
    { key: "photoParty", label: "摄影师列表", group: "摄影师分成管理", navigationOrder: 2 },
    { key: "photoSettlement", label: "结算管理", group: "摄影师分成管理", navigationOrder: 3 },
    { key: "photoMine", label: "摄影端", group: "摄影师分成管理", navigationOrder: 4 },
    { key: "contentOverview", label: "内容总览", group: "内容管理", navigationOrder: 0 },
    { key: "spots", label: "打卡点管理", group: "内容管理", navigationOrder: 2 },
    { key: "cities", label: "城市列表", group: "内容管理", navigationOrder: 1 },
    { key: "series", label: "拍摄风格", group: "内容管理" },
    { key: "albums", label: "照片留影", group: "内容管理", navigationOrder: 3 },
    { key: "samples", label: "素材库", group: "内容运营", navigationOrder: 0 },
    { key: "contentTags", label: "标签管理", group: "内容运营", navigationOrder: 1 },
    { key: "packages", label: "旅拍套餐", group: "内容管理", navigationOrder: 5 },
    { key: "videoSingles", label: "视频摄像", group: "内容管理", navigationOrder: 4 },
    { key: "guides", label: "旅拍灵感", group: "内容管理", navigationOrder: 7 },
    { key: "shelfProducts", label: "商品上下架", group: "内容运营" },
    { key: "productAudit", label: "商品审核", group: "内容运营" },
    { key: "addonServices", label: "增值服务", group: "订单履约" },
    { key: "peripherals", label: "周边商品", group: "内容管理", navigationOrder: 6 },
    { key: "miniDecor", label: "轮播配置", group: "内容管理", navigationOrder: 9 },
    { key: "bookingConfig", label: "预约配置", group: "内容管理", navigationOrder: 8 },
    { key: "permissions", label: "权限管理", group: "系统安全", navigationOrder: 0 },
    { key: "logs", label: "操作日志", group: "系统安全", navigationOrder: 1 },
    { key: "trash", label: "回收站", group: "系统安全", navigationOrder: 2 }
  ],
  roles: {
    super: {
      name: "系统超管",
      home: "dashboard",
      scope: "all",
      staffId: "",
      menus: ["dashboard", "orders", "afterSales", "tasks", "addonServices", "financeReview", "reconciliation", "staff", "distributors", "shareRules", "shareDetails", "shareMine", "photoRules", "photoLedger", "photoSettlement", "photoParty", "photoMine", "contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "bookingConfig", "guides", "permissions", "logs", "trash"]
    },
    distributor: {
      name: "分销员",
      home: "dashboard",
      scope: "distributor",
      distributorId: "",
      staffId: "",
      menus: ["dashboard", "orders"]
    },
    agent: {
      name: "渠道代理",
      home: "dashboard",
      scope: "agent",
      agentId: "",
      menus: ["dashboard", "orders"]
    },
    service: {
      name: "客服",
      home: "orders",
      scope: "orders",
      staffId: "",
      menus: ["dashboard", "orders", "tasks", "afterSales", "addonServices", "shareRules", "shareDetails"]
    },
    finance: {
      name: "财务",
      home: "financeReview",
      scope: "finance",
      staffId: "",
      menus: ["dashboard", "orders", "afterSales", "financeReview", "reconciliation", "shareRules", "shareDetails"]
    },
    photo: {
      name: "摄影师",
      home: "photoMine",
      scope: "selfPhoto",
      staffId: "",
      menus: ["photoMine"]
    },
    merchant: {
      name: "商家",
      home: "shareMine",
      scope: "shop",
      shopId: "",
      menus: ["shareMine"]
    },
    content: {
      name: "内容运营",
      home: "spots",
      scope: "content",
      staffId: "",
      menus: ["contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "bookingConfig", "guides"]
    }
  },
  orderStatuses: [
    { value: "reserved", label: "已预约", color: "#10B981", customer: "已预约" },
    { value: "awaiting_shoot", label: "已定档", color: "#3B82F6", customer: "已定档" },
    { value: "deposit_paid", label: "已预约", color: "#10B981", customer: "已预约" },
    { value: "assigned", label: "已定档", color: "#3B82F6", customer: "已定档" },
    { value: "shooting", label: "拍摄中", color: "#3B82F6", customer: "拍摄中" },
    { value: "retouching", label: "拍摄中", color: "#F97316", customer: "拍摄中" },
    { value: "editing", label: "拍摄中", color: "#F97316", customer: "拍摄中" },
    { value: "delivered", label: "拍摄中", color: "#10B981", customer: "拍摄中" },
    { value: "final_pending", label: "拍摄中", color: "#F97316", customer: "拍摄中" },
    { value: "paid", label: "已完成", color: "#10B981", customer: "已完成" },
    { value: "completed", label: "已完成", color: "#10B981", customer: "已完成" },
    { value: "cancelled", label: "已取消", color: "#6B7280", customer: "已取消" },
    { value: "canceled", label: "已取消", color: "#6B7280", customer: "已取消" }
  ],
  visibleStatus: [
    { value: "reserved", label: "已预约" },
    { value: "awaiting_shoot", label: "已定档" },
    { value: "shooting", label: "拍摄中" },
    { value: "completed", label: "已完成" },
    { value: "cancelled", label: "已取消" },
    // Legacy customerStatus values remain accepted on imported orders; the
    // display label uses the current business-state vocabulary.
    { value: "scheduled", label: "已定档" },
    { value: "retouching", label: "拍摄中" },
    { value: "editing", label: "拍摄中" },
    { value: "delivered", label: "拍摄中" },
    { value: "done", label: "已完成" }
  ],
  settlementCycles: ["周结", "月结", "季度结"]
};
