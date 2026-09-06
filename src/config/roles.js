// 角色、默认视角和权限分组配置。
const roleProfiles = {
  admin: { name: "林鹿鸣", role: "超管", scope: "全部数据", shopId: "", menus: ["dashboard", "orders", "accounts", "roles", "shops", "packages", "albums", "series", "spots", "photos", "contentOps", "config", "logs", "trash"] },
  service: { name: "小林", role: "客服", scope: "全部订单", shopId: "", menus: ["dashboard", "orders", "accounts", "packages", "shops", "logs"] },
  photographer: { name: "阿南", role: "摄影师", scope: "仅自己的拍摄任务", shopId: "", menus: ["photographerHome", "orders"] },
  merchant: { name: "茶颜店长", role: "商家", scope: "仅本商家渠道", shopId: "shop001", menus: ["merchantHome", "orders", "shops"] },
  content: { name: "安安", role: "内容运营", scope: "内容与首页装修", shopId: "", menus: ["dashboard", "contentOps", "photos", "guides", "stories", "peripherals", "config"] }
};

const permissionGroups = {
  dashboard: ["查看经营数据", "查看渠道分析", "查看财务数据"],
  orders: ["查看订单", "联系客户", "记录定金", "确认定金", "派单", "开始拍摄", "记录交付", "确认尾款", "取消订单", "导出订单"],
  accounts: ["查看账号", "新增账号", "编辑账号", "停用账号", "重置登录"],
  roles: ["查看角色", "新增自定义角色", "编辑权限", "设置数据范围", "删除角色"],
  shops: ["查看商家", "新增商家", "编辑商家", "查看经营数据", "结算管理", "生成二维码"],
  goods: ["套餐", "照片单品", "拍摄风格", "打卡点", "上下架", "主推设置"],
  content: ["样片上传", "攻略管理", "故事管理", "周边管理", "首页配置", "发布审核"],
  system: ["操作日志", "回收站", "彻底删除", "系统配置"]
};
