// 演示版模拟数据。正式接入后由接口服务替换。
const LXM_INITIAL_STATE = {
  current: "dashboard",
  currentRole: "admin",
  orderStatus: "all",
  selectedOrderId: "",
  menus: [
    { key: "dashboard", icon: "📊", label: "数据概览", desc: "经营、订单、财务、渠道的精细化看板" },
    { key: "orders", icon: "📋", label: "订单管理", desc: "客服联系、定金、派单、拍摄、交付、尾款全流程" },
    { key: "photographerHome", icon: "📷", label: "我的任务", desc: "摄影师登录后只看自己的拍摄任务" },
    { key: "merchantHome", icon: "🏪", label: "商家看板", desc: "商家登录后查看本店扫码、订单、成交和结算" },
    { key: "accounts", icon: "👥", label: "账号管理", desc: "超管、客服、摄影师、商家、内容运营账号" },
    { key: "roles", icon: "🔑", label: "角色权限", desc: "角色名称可自定义，权限可细分到动作和数据范围" },
    { key: "shops", icon: "🏪", label: "商家管理", desc: "合作商家、一店一码、月成交、分账和结算" },
    { key: "packages", icon: "📦", label: "套餐管理", desc: "套餐商品、主推设置、上下架和价格" },
    { key: "albums", icon: "📸", label: "照片单品", desc: "独立售卖的照片单品商品" },
    { key: "series", icon: "🎨", label: "拍摄风格管理", desc: "拍摄风格与适用打卡点" },
    { key: "spots", icon: "📍", label: "打卡点管理", desc: "长沙地标、拍摄点和商家渠道" },
    { key: "photos", icon: "🖼", label: "素材库", desc: "照片/视频素材、首页轮播素材" },
    { key: "contentOps", icon: "🧭", label: "内容运营", desc: "攻略、故事、周边、活动公告和发布排期" },
    { key: "guides", icon: "📖", label: "攻略管理", desc: "打卡攻略内容维护" },
    { key: "stories", icon: "📚", label: "故事管理", desc: "长沙故事内容维护" },
    { key: "peripherals", icon: "🛍", label: "周边管理", desc: "摄影周边商品维护" },
    { key: "config", icon: "⚙", label: "首页配置", desc: "轮播素材、活动公告和首页运营位" },
    { key: "logs", icon: "📝", label: "操作日志", desc: "后台关键操作审计" },
    { key: "trash", icon: "🗑", label: "回收站", desc: "软删除数据恢复与清理" }
  ],
  orders: [
    {
      id: "LS202606270018", status: "new", customer: "周女士", phone: "138****6721", wechat: "zhou_photo",
      product: "古风单人写真", amount: 399, depositRequired: 100, depositPaid: 0, finalPaid: 0,
      shopId: "shop001", shop: "茶颜悦色橘洲店", spot: "橘子洲头", date: "2026-06-28 上午 10:00",
      photographer: "", serviceUser: "小林", source: "扫码预约", contactNote: "", deliveryNote: "",
      logs: ["游客提交预约", "系统锁定来源商家：茶颜悦色橘洲店"]
    },
    {
      id: "LS202606270021", status: "deposit_pending", customer: "陈先生", phone: "186****5290", wechat: "chen908",
      product: "情侣双人写真", amount: 699, depositRequired: 200, depositPaid: 0, finalPaid: 0,
      shopId: "shop002", shop: "IFS 文创集合店", spot: "IFS 国金中心", date: "2026-06-28 下午 15:30",
      photographer: "", serviceUser: "小林", source: "扫码预约", contactNote: "客户确认下午拍摄，待转定金。",
      deliveryNote: "", logs: ["客服已联系客户", "已说明定金 200 元，等待客户付款"]
    },
    {
      id: "LS202606260117", status: "assigned", customer: "李同学", phone: "151****3208", wechat: "lixx",
      product: "短视频打卡", amount: 599, depositRequired: 200, depositPaid: 200, finalPaid: 0,
      shopId: "shop003", shop: "麓山咖啡", spot: "岳麓山", date: "2026-06-27 下午 16:00",
      photographer: "阿南", serviceUser: "小林", source: "扫码预约", contactNote: "客户已付定金，确认岳麓山东门集合。",
      deliveryNote: "", logs: ["客服确认定金到账", "客服手动派单给摄影师阿南"]
    },
    {
      id: "LS202606260188", status: "final_pending", customer: "赵女士", phone: "139****1187", wechat: "zhao_city",
      product: "夜景氛围写真", amount: 499, depositRequired: 100, depositPaid: 100, finalPaid: 0,
      shopId: "shop004", shop: "超级文和友伴手礼", spot: "超级文和友", date: "2026-06-26 晚上 19:30",
      photographer: "鹿川", serviceUser: "小林", source: "扫码预约", contactNote: "客户偏复古夜景。",
      deliveryNote: "成片已由鹿川微信发给客服，客服已转发客户，待尾款 399 元。", logs: ["已完成拍摄", "摄影师微信交付成片", "客服已转发客户"]
    },
    {
      id: "LS202606250086", status: "completed", customer: "王女士", phone: "139****8881", wechat: "wangxi",
      product: "小清新照片单品 E", amount: 299, depositRequired: 100, depositPaid: 100, finalPaid: 199,
      shopId: "shop001", shop: "茶颜悦色橘洲店", spot: "橘子洲头", date: "2026-06-25 上午 09:30",
      photographer: "小禾", serviceUser: "小林", source: "扫码预约", contactNote: "客户喜欢自然光。",
      deliveryNote: "成片已通过微信发送给客户。", logs: ["定金到账", "已派单", "已拍摄", "已交付", "尾款到账", "订单完成"]
    }
  ],
  photographers: [
    { name: "阿南", phone: "152****2811", role: "摄影师", status: "启用", tags: ["古风", "夜景"], today: 2, monthOrders: 46, rating: 4.9 },
    { name: "鹿川", phone: "187****0119", role: "摄影师", status: "启用", tags: ["情侣", "短视频"], today: 1, monthOrders: 38, rating: 4.8 },
    { name: "小禾", phone: "136****7720", role: "摄影师", status: "启用", tags: ["小清新", "亲子"], today: 0, monthOrders: 31, rating: 4.9 }
  ],
  accounts: [
    { name: "林鹿鸣", phone: "138****1000", role: "超管", login: "微信 openid 已绑定", status: "启用", shop: "-", editable: false },
    { name: "小林", phone: "177****9090", role: "客服", login: "手机号验证码", status: "启用", shop: "-", editable: true },
    { name: "阿南", phone: "152****2811", role: "摄影师", login: "手机号验证码", status: "启用", shop: "-", editable: true },
    { name: "茶颜店长", phone: "188****4012", role: "商家", login: "手机号验证码", status: "启用", shop: "茶颜悦色橘洲店", editable: true },
    { name: "安安", phone: "166****7012", role: "内容运营", login: "手机号验证码", status: "启用", shop: "-", editable: true }
  ],
  roles: [
    { name: "超管", scope: "全部数据", custom: false, allowed: ["*"] },
    { name: "客服主管", scope: "全部订单", custom: true, allowed: ["orders:查看订单", "orders:联系客户", "orders:记录定金", "orders:确认定金", "orders:派单", "orders:确认尾款", "orders:导出订单"] },
    { name: "商家运营", scope: "仅自己渠道", custom: true, allowed: ["dashboard:查看经营数据", "orders:查看订单", "shops:查看经营数据"] },
    { name: "内容运营", scope: "内容与首页装修", custom: true, allowed: ["content:样片上传", "content:攻略管理", "content:故事管理", "content:首页配置"] }
  ],
  shops: [
    { id: "shop001", name: "茶颜悦色橘洲店", logo: "茶", manager: "茶颜店长", scanToday: 86, scanMonth: 3860, ordersMonth: 264, amountMonth: 92400, commissionRate: 12, settlement: "月结", settled: 72400, pendingSettle: 20000, status: "合作中" },
    { id: "shop002", name: "IFS 文创集合店", logo: "文", manager: "IFS 店长", scanToday: 64, scanMonth: 2350, ordersMonth: 151, amountMonth: 53820, commissionRate: 10, settlement: "半月结", settled: 42000, pendingSettle: 11820, status: "合作中" },
    { id: "shop003", name: "麓山咖啡", logo: "咖", manager: "麓山店长", scanToday: 41, scanMonth: 1710, ordersMonth: 98, amountMonth: 33660, commissionRate: 15, settlement: "月结", settled: 26000, pendingSettle: 7660, status: "合作中" },
    { id: "shop004", name: "超级文和友伴手礼", logo: "友", manager: "文和友店长", scanToday: 73, scanMonth: 2980, ordersMonth: 193, amountMonth: 69400, commissionRate: 12, settlement: "月结", settled: 59000, pendingSettle: 10400, status: "合作中" }
  ],
  packages: [
    { name: "古风单人写真", spot: "橘子洲头", type: "拍照", originalPrice: 599, price: 399, deposit: 100, isMainPush: true, isShow: true, tags: ["精修 9 张", "当天预览", "古风妆造"] },
    { name: "情侣双人写真", spot: "IFS 国金中心", type: "拍照", originalPrice: 899, price: 699, deposit: 200, isMainPush: false, isShow: true, tags: ["双人同行", "精修 12 张"] },
    { name: "短视频打卡", spot: "岳麓山", type: "短视频", originalPrice: 799, price: 599, deposit: 200, isMainPush: true, isShow: true, tags: ["15 秒短片", "竖屏交付"] },
    { name: "夜景氛围写真", spot: "超级文和友", type: "拍照", originalPrice: 699, price: 499, deposit: 100, isMainPush: false, isShow: true, tags: ["夜景", "复古港风"] }
  ],
  albums: [
    { name: "古风照片单品 A", series: "古风系列", spot: "橘子洲头", price: 299, count: 18, isShow: true },
    { name: "小清新照片单品 E", series: "小清新系列", spot: "岳麓山", price: 299, count: 24, isShow: true },
    { name: "短视频照片单品 F", series: "短视频系列", spot: "IFS 国金中心", price: 399, count: 12, isShow: true }
  ],
  contentItems: [
    { type: "攻略", title: "橘子洲头日落机位", status: "已发布", owner: "安安", views: 2680, plan: "本周置顶" },
    { type: "故事", title: "在湘江边，把风也拍进去", status: "已发布", owner: "安安", views: 1380, plan: "首页故事位" },
    { type: "周边", title: "照片打印套装", status: "上架", owner: "安安", views: "¥39", plan: "套餐加购" },
    { type: "活动", title: "暑期旅拍立减 50", status: "排期中", owner: "安安", views: "7月1日上线", plan: "首页滚动条" }
  ]
};
