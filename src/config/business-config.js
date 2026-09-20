window.LXM_CONFIG = {
  groups: ["经营中心", "订单履约", "财务管理", "渠道增长", "内容管理", "内容运营", "系统安全"],
  // Menu records may use a custom key, but the target page must be one of
  // these registered route keys. Keep this catalog aligned with the API.
  routeMenuKeys: ["dashboard", "orders", "afterSales", "tasks", "addonServices", "financeReview", "reconciliation", "staff", "distributors", "shops", "contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "miniConfig", "guides", "permissions", "logs", "trash"],
  menus: [
    { key: "dashboard", label: "经营看板", group: "经营中心" },
    { key: "orders", label: "订单管理", group: "订单履约" },
    { key: "afterSales", label: "售后服务", group: "订单履约" },
    { key: "financeReview", label: "财务审核", group: "财务管理" },
    { key: "reconciliation", label: "月度对账", group: "财务管理" },
    { key: "tasks", label: "拍摄任务", group: "订单履约" },
    { key: "staff", label: "人员管理", group: "渠道增长" },
    { key: "distributors", label: "分销管理", group: "渠道增长" },
    { key: "shops", label: "商家管理", group: "渠道增长" },
    { key: "contentOverview", label: "内容总览", group: "内容管理" },
    { key: "spots", label: "打卡点", group: "内容管理" },
    { key: "cities", label: "城市", group: "内容管理" },
    { key: "series", label: "拍摄风格", group: "内容管理" },
    { key: "albums", label: "照片留影", group: "内容管理" },
    { key: "samples", label: "素材库", group: "内容运营" },
    { key: "contentTags", label: "标签管理", group: "内容运营" },
    { key: "packages", label: "旅拍套餐", group: "内容管理" },
    { key: "videoSingles", label: "视频摄像", group: "内容管理" },
    { key: "shelfProducts", label: "商品上下架", group: "内容运营" },
    { key: "productAudit", label: "商品审核", group: "内容运营" },
    { key: "addonServices", label: "增值服务", group: "订单履约" },
    { key: "peripherals", label: "影像周边", group: "内容管理" },
    { key: "miniDecor", label: "小程序首页", group: "内容管理" },
    { key: "miniConfig", label: "小程序全局配置", group: "内容管理" },
    { key: "guides", label: "旅拍灵感", group: "内容管理" },
    { key: "permissions", label: "权限管理", group: "系统安全" },
    { key: "logs", label: "操作日志", group: "系统安全" },
    { key: "trash", label: "回收站", group: "系统安全" }
  ],
  roles: {
    super: {
      name: "系统超管",
      home: "dashboard",
      scope: "all",
      staffId: "st1",
      menus: ["dashboard", "orders", "afterSales", "tasks", "addonServices", "financeReview", "reconciliation", "staff", "distributors", "shops", "contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "miniConfig", "guides", "permissions", "logs", "trash"]
    },
    distributor: {
      name: "分销员",
      home: "dashboard",
      scope: "distributor",
      distributorId: "dist2",
      staffId: "st8",
      menus: ["dashboard", "orders", "shops"]
    },
    agent: {
      name: "渠道代理",
      home: "dashboard",
      scope: "agent",
      agentId: "agent1",
      menus: ["dashboard", "orders", "shops"]
    },
    service: {
      name: "客服",
      home: "orders",
      scope: "orders",
      staffId: "st2",
      menus: ["dashboard", "orders", "afterSales", "addonServices"]
    },
    finance: {
      name: "财务",
      home: "financeReview",
      scope: "finance",
      staffId: "st9",
      menus: ["dashboard", "orders", "afterSales", "financeReview", "reconciliation"]
    },
    photo: {
      name: "摄影师",
      home: "tasks",
      scope: "selfTask",
      staffId: "st4",
      menus: ["tasks"]
    },
    merchant: {
      name: "商家",
      home: "dashboard",
      scope: "shop",
      shopId: "shop1",
      menus: ["dashboard", "orders"]
    },
    content: {
      name: "内容运营",
      home: "spots",
      scope: "content",
      staffId: "st6",
      menus: ["contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "miniConfig", "guides"]
    }
  },
  orderStatuses: [
    { value: "new", label: "待支付", color: "#F59E0B", customer: "待支付" },
    { value: "pending", label: "待支付", color: "#F59E0B", customer: "待支付" },
    { value: "contacted", label: "待支付", color: "#F59E0B", customer: "待支付" },
    { value: "deposit_pending", label: "待支付", color: "#F97316", customer: "待支付" },
    { value: "deposit_paid", label: "待安排摄影师", color: "#10B981", customer: "待安排摄影师" },
    { value: "confirmed", label: "待支付", color: "#F59E0B", customer: "待支付" },
    { value: "assigned", label: "待安排摄影师", color: "#3B82F6", customer: "待安排摄影师" },
    { value: "shooting", label: "待安排摄影师", color: "#3B82F6", customer: "待安排摄影师" },
    { value: "retouching", label: "已拍摄", color: "#F97316", customer: "已拍摄" },
    { value: "editing", label: "已拍摄", color: "#F97316", customer: "已拍摄" },
    { value: "delivered", label: "已交付", color: "#10B981", customer: "已交付" },
    { value: "final_pending", label: "已拍摄", color: "#F97316", customer: "已拍摄" },
    { value: "paid", label: "已支付", color: "#10B981", customer: "已支付" },
    { value: "completed", label: "已交付", color: "#10B981", customer: "已交付" },
    { value: "cancelled", label: "已取消", color: "#6B7280", customer: "已取消" },
    { value: "canceled", label: "已取消", color: "#6B7280", customer: "已取消" }
  ],
  visibleStatus: [
    { value: "待支付", label: "待支付" },
    { value: "待安排摄影师", label: "待安排摄影师" },
    { value: "已拍摄", label: "已拍摄" },
    { value: "已支付", label: "已支付" },
    { value: "已交付", label: "已交付" },
    { value: "reserved", label: "待支付" },
    { value: "confirmed", label: "待安排摄影师" },
    { value: "scheduled", label: "待安排摄影师" },
    { value: "shooting", label: "待安排摄影师" },
    { value: "retouching", label: "已拍摄" },
    { value: "editing", label: "已拍摄" },
    { value: "delivered", label: "已交付" },
    { value: "done", label: "已交付" }
  ],
  settlementCycles: ["周结", "月结", "季度结"]
};
