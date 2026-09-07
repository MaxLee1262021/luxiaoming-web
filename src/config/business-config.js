window.LXM_CONFIG = {
  groups: ["经营中心", "订单履约", "财务管理", "渠道增长", "内容管理", "内容运营", "系统安全"],
  navSections: [
    { key: "biz", label: "经营中心", desc: "数据、业绩、经营追踪", items: ["dashboard"] },
    { key: "fulfill", label: "订单履约", desc: "客服接单、拍摄任务、售后处理、增值服务", items: ["orders", "afterSales", "tasks", "addonServices"] },
    { key: "finance", label: "财务管理", desc: "财务审核、月度对账、报表导出", items: ["financeReview", "reconciliation"] },
    { key: "channel", label: "渠道增长", desc: "人员、分销、商家管理", items: ["staff", "distributors", "shops"] },
    {
      key: "content",
      label: "内容管理",
      desc: "上传与管理小程序客人侧内容",
      items: [
        { key: "contentOverview", label: "内容总览", level: 1 },
        { key: "miniDecor", label: "小程序首页", level: 1 },
        { key: "miniConfig", label: "小程序全局配置", level: 1 },
        { key: "albums", label: "照片留影", level: 1 },
        { key: "videoSingles", label: "视频摄像", level: 1 },
        { key: "packages", label: "旅拍套餐", level: 1 },
        { key: "peripherals", label: "影像周边", level: 1 },
        { key: "guides", label: "旅拍灵感", level: 1 },
        { key: "samples", label: "素材库", level: 1 },
        { key: "spots", label: "打卡点", level: 1 },
        { key: "cities", label: "城市", level: 1 },
        { key: "series", label: "拍摄风格", level: 1 }
      ]
    },
    {
      key: "contentOps",
      label: "内容运营",
      desc: "不与客人见面对应的内部运营项（默认隐藏，不影响小程序客人侧）",
      hidden: true,
      items: [
        { key: "contentTags", label: "标签管理", level: 1 },
        { key: "shelfProducts", label: "商品上下架", level: 1 },
        { key: "productAudit", label: "商品审核", level: 1 }
      ]
    },
    { key: "system", label: "系统安全", desc: "日志、回收站", items: ["logs", "trash"] }
  ],
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
    { key: "logs", label: "操作日志", group: "系统安全" },
    { key: "trash", label: "回收站", group: "系统安全" }
  ],
  roles: {
    super: {
      name: "系统超管",
      home: "dashboard",
      scope: "all",
      staffId: "st1",
      menus: ["dashboard", "orders", "afterSales", "financeReview", "reconciliation", "staff", "distributors", "shops", "contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "miniConfig", "guides", "logs", "trash"],
      actions: ["*"]
    },
    distributor: {
      name: "分销员",
      home: "dashboard",
      scope: "distributor",
      distributorId: "dist2",
      staffId: "st8",
      menus: ["dashboard", "orders", "shops"],
      actions: ["view", "dashboard", "export"]
    },
    agent: {
      name: "渠道代理",
      home: "dashboard",
      scope: "agent",
      agentId: "agent1",
      menus: ["dashboard", "orders", "shops"],
      actions: ["view", "dashboard", "export"]
    },
    service: {
      name: "客服",
      home: "orders",
      scope: "orders",
      staffId: "st2",
      menus: ["dashboard", "orders", "afterSales", "addonServices"],
      actions: ["view", "orderEdit", "assign", "transfer", "cancelOrder", "export"]
    },
    finance: {
      name: "财务",
      home: "financeReview",
      scope: "finance",
      staffId: "st9",
      menus: ["dashboard", "orders", "afterSales", "financeReview", "reconciliation"],
      actions: ["view", "financeReview", "export"]
    },
    photo: {
      name: "摄影师",
      home: "tasks",
      scope: "selfTask",
      staffId: "st4",
      menus: ["tasks"],
      actions: ["view", "shootUpdate"]
    },
    merchant: {
      name: "商家",
      home: "dashboard",
      scope: "shop",
      shopId: "shop1",
      menus: ["dashboard", "orders"],
      actions: ["view", "dashboard", "export"]
    },
    content: {
      name: "内容运营",
      home: "spots",
      scope: "content",
      staffId: "st6",
      menus: ["contentOverview", "spots", "cities", "series", "albums", "samples", "contentTags", "packages", "videoSingles", "shelfProducts", "productAudit", "peripherals", "miniDecor", "miniConfig", "guides"],
      actions: ["view", "contentEdit"]
    }
  },
  orderStatuses: [
    { value: "pending", label: "待确认", color: "#F59E0B", customer: "已预约，待确认" },
    { value: "confirmed", label: "已确认", color: "#10B981", customer: "预约已确认" },
    { value: "shooting", label: "拍摄中", color: "#3B82F6", customer: "拍摄中" },
    { value: "retouching", label: "修片中", color: "#F97316", customer: "修片中" },
    { value: "completed", label: "已完成", color: "#6B7280", customer: "已完成" },
    { value: "cancelled", label: "已取消", color: "#6B7280", customer: "已取消" }
  ],
  visibleStatus: [
    { value: "reserved", label: "已预约，待确认" },
    { value: "confirmed", label: "已确认预约" },
    { value: "scheduled", label: "已安排拍摄" },
    { value: "shooting", label: "拍摄中" },
    { value: "retouching", label: "修片中" },
    { value: "delivered", label: "成片已交付" },
    { value: "done", label: "已完成" }
  ],
  settlementCycles: ["周结", "月结", "季度结"],
  permissionMatrix: [
    { key: "dashboardAll", name: "查看总部数据看板", super: true },
    { key: "dashboardShop", name: "查看商家数据看板", super: true, distributor: true, merchant: true, agent: true },
    { key: "orderAll", name: "查看全部订单", super: true, service: true, finance: true },
    { key: "orderSelf", name: "查看自己订单", super: true, distributor: true, photo: true, merchant: true },
    { key: "orderStatus", name: "更改订单状态", super: true, service: true, photo: true },
    { key: "dispatch", name: "派单", super: true, service: true },
    { key: "financeReview", name: "财务核对与退款审核", super: true, finance: true },
    { key: "staff", name: "管理员工", super: true },
    { key: "shop", name: "管理商家", super: true },
    { key: "content", name: "管理内容与商品", super: true, content: true },
    { key: "system", name: "系统配置", super: true }
  ]
};
