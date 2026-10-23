"use strict";

// MySQL data dictionary owned by the server schema.  The runtime schema keeps
// the public document keys, while this module owns human-readable table and
// column comments used by DBAs, migrations and generated documentation.

const TABLE_DESCRIPTIONS = Object.freeze({
  cities: "城市主数据",
  agents: "代理人账号与组织信息",
  distributors: "分销商账号与组织信息",
  shops: "门店与商家配置",
  staff: "后台员工账号与组织信息",
  spots: "旅拍打卡点",
  series: "旅拍内容系列",
  albums: "照片留影商品",
  samples: "照片与视频样片",
  packages: "旅拍套餐与视频商品",
  addonServices: "旅拍增值服务",
  peripherals: "影像周边商品",
  tagLibrary: "内容标签库",
  guides: "旅拍攻略",
  stories: "旅拍故事内容",
  scans: "商家码扫码记录",
  orders: "客户预约订单",
  bookingRequests: "预约支付草稿",
  afterSales: "订单售后工单",
  reconciliationTransfers: "财务对账划拨记录",
  financeSettings: "财务结算配置",
  monthlyClosings: "月度结账记录",
  adjustmentRecords: "财务调账记录",
  homeConfig: "小程序首页配置",
  logs: "后台审计日志",
  trash: "软删除回收站记录",
  merchantCodes: "商家入口码",
  siteConfig: "小程序站点配置",
  userProfiles: "小程序用户资料",
  config: "系统配置项",
  mediaFiles: "文件上传与媒体资产登记",
  user_favorites: "用户收藏记录",
  schema_version: "数据库规范化版本记录",
  auth_menus: "后台权限菜单",
  auth_roles: "后台权限角色",
  auth_role_menus: "角色菜单授权关系",
  auth_role_permissions: "角色权限授权关系",
  auth_user_permissions: "用户直接权限关系",
  auth_users: "后台认证用户",
  auth_menus_normalized: "规范化菜单投影",
  auth_users_normalized: "规范化用户投影",
  auth_menu_attributes: "菜单扩展属性",
  auth_user_attributes: "用户扩展属性",
  account_permissions: "账号集合权限关系",
  shop_distributors: "门店与分销商关系",
  shop_agents: "门店与代理人关系",
  series_spots: "系列与打卡点关系",
  album_samples: "照片商品与样片关系",
  album_tags: "照片商品标签关系",
  package_spots: "套餐与打卡点关系",
  package_tags: "套餐标签关系",
  package_exclusions: "套餐互斥关系",
  package_included_items: "套餐包含商品快照",
  addon_package_defaults: "增值服务默认套餐关系",
  peripheral_spots: "周边商品与打卡点关系",
  peripheral_specs: "周边商品规格",
  peripheral_images: "周边商品图片",
  order_contacts: "订单联系人列表",
  order_source: "订单来源归因",
  order_package_snapshot: "订单套餐快照",
  order_package_snapshot_tags: "订单套餐标签快照",
  order_products: "订单商品明细",
  order_product_snapshots: "订单商品快照",
  order_product_snapshot_tags: "订单商品标签快照",
  order_addons: "订单增值服务明细",
  order_status_logs: "订单状态流转日志",
  order_follow_records: "订单跟进记录",
  order_payment_records: "订单支付记录",
  booking_payment_records: "预约草稿支付记录",
  log_order_exception_snapshots: "订单异常审计快照",
  after_sale_logs: "售后处理日志",
  transfer_orders: "对账划拨订单关系",
  reconciliation_transfer_orders: "对账划拨订单关系",
  home_modules: "首页模块配置",
  home_ids: "首页配置引用项",
  home_quick_nav: "首页快捷导航",
  home_banners: "首页与页面横幅",
  home_page_modules: "页面模块配置",
  home_page_links: "页面推荐链接",
  site_booking_notices: "预约须知条目",
  site_hotwords: "搜索热词",
  trash_source_attributes: "回收站来源扩展属性",
  collection_values: "业务集合扩展属性"
});

const COLUMN_DESCRIPTIONS = Object.freeze({
  id: "记录唯一标识",
  openid: "微信用户唯一标识",
  _openid: "兼容旧字段的微信用户标识",
  name: "名称",
  title: "标题",
  subtitle: "副标题",
  description: "面向用户的详细描述",
  intro: "简介",
  status: "业务状态",
  enabled: "是否启用",
  visible: "是否可见",
  isShow: "是否在小程序展示",
  isDeleted: "是否已删除",
  deleted: "软删除标记",
  createdAt: "创建时间",
  updatedAt: "最后更新时间",
  createTime: "创建时间",
  updateTime: "更新时间",
  created_at: "创建时间",
  updated_at: "最后更新时间",
  sort: "展示排序",
  sort_no: "关系排序号",
  statusLogs: "状态流转记录",
  followRecords: "跟进记录",
  phone: "联系电话",
  contactPhone: "联系人电话",
  customerPhone: "客户电话",
  email: "电子邮箱",
  account: "登录账号",
  password_hash: "密码哈希",
  role: "角色",
  role_id: "角色标识",
  menu_key: "菜单业务键",
  permission_key: "权限业务键",
  parent_key: "父级菜单键",
  path: "菜单路径或扩展属性路径",
  value_type: "属性值类型",
  value_text: "文本属性值",
  value_number: "数值属性值",
  value_bool: "布尔属性值",
  value_time: "时间属性值",
  city: "城市名称",
  cityId: "城市标识",
  cityCode: "城市编码",
  district: "行政区域",
  latitude: "纬度",
  longitude: "经度",
  coordType: "坐标系类型",
  spotId: "打卡点标识",
  spotName: "打卡点名称",
  seriesId: "系列标识",
  seriesName: "系列名称",
  albumId: "照片商品标识",
  packageId: "套餐标识",
  package_id: "套餐标识",
  album_id: "照片商品标识",
  series_id: "系列标识",
  spot_id: "打卡点标识",
  sample_id: "样片标识",
  order_id: "订单标识",
  transfer_id: "对账划拨标识",
  after_sale_id: "售后工单标识",
  log_id: "审计日志标识",
  packageName: "套餐名称",
  productId: "商品标识",
  productType: "商品类型",
  type: "记录类型",
  category: "分类",
  tag: "标签",
  tags: "标签列表",
  cover: "封面地址",
  coverUrl: "封面地址",
  image: "图片地址",
  url: "资源地址",
  link_url: "跳转链接",
  price: "销售价格",
  originalPrice: "原价",
  totalPrice: "订单原价总额",
  totalAmount: "订单应收总额",
  amount: "金额",
  quantity: "数量",
  stock: "库存数量",
  stockQty: "库存数量",
  duration: "服务时长",
  durationText: "服务时长文案",
  deliveryCycle: "交付周期",
  videoDuration: "视频时长",
  photoCount: "照片数量",
  readCount: "阅读次数",
  score: "评分",
  hotScore: "热度分",
  soldCount: "售出数量",
  isHot: "是否热门",
  isMainPush: "是否主推",
  isFeatured: "是否精选",
  isRecommend: "是否推荐",
  sourceType: "来源类型",
  sourceName: "来源名称",
  sourceScene: "来源场景",
  sourceChannel: "来源渠道",
  sourceCodeId: "来源入口码标识",
  shopId: "门店标识",
  shopCode: "门店编码",
  distributorId: "分销商标识",
  agentId: "代理人标识",
  staffId: "员工标识",
  orderId: "订单标识",
  orderNo: "订单号",
  bookingIdempotencyKey: "预约幂等键",
  appointmentAt: "预约时间",
  bookingDate: "预约日期",
  bookingTime: "预约时段",
  timePeriod: "时间段",
  timeSlot: "时间槽",
  workflowStage: "履约阶段",
  customerStatus: "客户侧状态",
  dispatchStatus: "派单状态",
  assigneeId: "客服负责人标识",
  photographerId: "摄影师标识",
  depositRatio: "定金比例",
  depositDue: "定金应收金额",
  depositPaid: "已收定金",
  finalDue: "尾款应收金额",
  finalPaid: "已收尾款",
  paymentStatus: "支付状态",
  paymentType: "支付类型",
  paymentId: "支付记录标识",
  out_trade_no: "微信支付商户订单号",
  external_transaction_id: "第三方支付交易号",
  idempotency_key: "支付幂等键",
  refundAmount: "退款金额",
  refundStatus: "退款状态",
  financeStatus: "财务审核状态",
  deliveryMethod: "交付方式",
  deliveredAt: "交付时间",
  completedAt: "完成时间",
  message: "客户留言",
  customerRemark: "客户备注",
  internalNote: "内部备注",
  serviceNote: "服务备注",
  deliveryNote: "交付备注",
  operator: "操作人名称",
  operator_id: "操作人标识",
  operatorId: "操作人标识",
  action: "操作动作",
  reason: "原因说明",
  note: "备注",
  snapshot_id: "快照标识",
  item_id: "商品或关联项标识",
  record_id: "父记录标识",
  collection_name: "业务集合名称",
  config_id: "配置记录标识",
  module_key: "模块业务键",
  target_type: "目标类型",
  target_id: "目标标识",
  effective_time: "生效时间",
  favorite_key: "用户收藏复合键",
  type_label: "收藏类型名称",
  itemId: "收藏内容标识"
  ,account_id: "账号标识"
  ,permission_key: "权限业务键"
  ,collection_name: "业务集合名称"
  ,record_id: "父记录标识"
  ,config_id: "配置记录标识"
  ,group_key: "配置分组键"
  ,item_no: "明细序号"
  ,item_type: "明细类型"
  ,item_name: "明细名称"
  ,item_price: "明细价格"
  ,target_page: "目标页面"
  ,target_product_id: "目标商品标识"
  ,target_series_id: "目标系列标识"
  ,target_album_id: "目标照片商品标识"
  ,target_spot_id: "目标打卡点标识"
  ,addon_id: "增值服务标识"
  ,addon_type: "增值服务类型"
  ,peripheral_id: "周边商品标识"
  ,spec_no: "规格序号"
  ,spec_text: "规格文本"
  ,image_no: "图片序号"
  ,image_url: "图片地址"
  ,contact_no: "联系人序号"
  ,snapshot_id: "快照标识"
  ,tag_no: "标签序号"
  ,tag_type: "标签类型"
  ,notice_no: "须知序号"
  ,notice_text: "须知内容"
  ,word_no: "热词序号"
  ,word: "热词内容"
  ,banner_no: "横幅序号"
  ,banner_group: "横幅分组"
  ,banner_id: "横幅标识"
  ,link_type: "链接类型"
  ,nav_no: "导航序号"
  ,route_key: "路由业务键"
  ,display_name: "显示名称"
  ,password: "登录密码（仅兼容字段）"
  ,icon: "菜单图标"
  ,group_name: "菜单分组"
  ,menu_type: "菜单类型"
  ,role_key: "角色业务键"
  ,attribute_key: "属性键"
  ,ordinal: "属性序号"
  ,value_type: "属性值类型"
  ,value_text: "文本属性值"
  ,value_number: "数值属性值"
  ,value_bool: "布尔属性值"
  ,value_time: "时间属性值"
  ,record_no: "记录序号"
  ,log_no: "日志序号"
  ,payment_id: "支付记录标识"
  ,phase: "支付阶段"
  ,attempt: "支付尝试次数"
  ,provider: "支付服务商"
  ,confirmation_idempotency_key: "支付确认幂等键"
  ,prepay_id: "预支付交易标识"
  ,trade_state: "第三方交易状态"
  ,failure_reason: "失败原因"
  ,paid_at: "支付完成时间"
  ,message: "消息内容"
  ,time: "发生时间"
  ,from_status: "原状态"
  ,to_status: "目标状态"
  ,shop_id: "门店标识"
  ,distributor_id: "分销商标识"
  ,agent_id: "代理人标识"
  ,role_id: "角色标识"
  ,user_id: "用户标识"
  ,menu_id: "菜单标识"
  ,meta_group: "菜单元数据分组"
  ,meta_type: "菜单元数据类型"
  ,meta_label: "菜单元数据标签"
  ,legacy_key: "旧系统集合键"
  ,legacy_id: "旧系统记录标识"
  ,subject_type: "主体类型"
  ,subject_id: "主体标识"
  ,created_at: "创建时间"
  ,updated_at: "最后更新时间"
  ,applied_at: "版本应用时间"
});

function tableComment(key) {
  return TABLE_DESCRIPTIONS[key] || TABLE_DESCRIPTIONS[String(key).replace(/^lxm_/, "")] || `业务表：${key}`;
}

function columnComment(name) {
  if (COLUMN_DESCRIPTIONS[name]) return COLUMN_DESCRIPTIONS[name];
  const text = String(name).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return `字段：${text}`;
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function descriptionForTable(table, key = "") {
  return tableComment(key || table);
}

function quoteIdentifier(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_]+$/.test(text)) throw new Error(`非法 MySQL 标识符: ${text}`);
  return `\`${text}\``;
}

function parseColumnNames(definition) {
  return (definition && Array.isArray(definition.columns) ? definition.columns : [])
    .map(column => typeof column === "string" ? String(column).trim().split(/\s+/, 1)[0] : column.name)
    .filter(Boolean);
}

function knownTableNames(schema) {
  const names = new Set(["lxm_schema_version", "lxm_user_favorites"]);
  for (const key of schema.ALL_KEYS || []) names.add(schema.tableName(key));
  for (const relation of Object.values(schema.RELATIONS || {})) names.add(relation.table);
  for (const table of Object.values(schema.AUTH_CORE || {})) names.add(table);
  for (const table of Object.values(schema.AUTH_ATTRIBUTE_TABLES || {})) names.add(table);
  for (const definition of Object.values(schema.AUTH_NORMALIZED || {})) names.add(definition.table);
  return [...names];
}

function knownColumnNames(schema, table) {
  if (table === "lxm_schema_version") return ["version", "applied_at"];
  if (table === "lxm_user_favorites") return ["openid", "favorite_key", "type", "item_id", "type_label", "title", "cover", "price", "spot", "spot_id", "url", "created_at", "updated_at"];
  const key = (schema.ALL_KEYS || []).find(item => schema.tableName(item) === table);
  if (key) return [...schema.definition(key).columns.map(column => column.name), "created_at", "updated_at"];
  const relation = Object.values(schema.RELATIONS || {}).find(item => item.table === table);
  if (relation) {
    const columns = parseColumnNames(relation);
    if (table !== "lxm_account_permissions" && table !== "lxm_collection_values") columns.push("created_at", "updated_at");
    return [...new Set(columns)];
  }
  const auth = Object.values(schema.AUTH_NORMALIZED || {}).find(item => item.table === table);
  if (auth) return [...parseColumnNames(auth), "created_at", "updated_at"];
  const authColumns = {
    lxm_auth_menus: ["id", "menu_key", "parent_key", "name", "path", "icon", "sort_no", "status", "meta_group", "meta_type", "meta_label", "created_at", "updated_at"],
    lxm_auth_roles: ["id", "role_key", "name", "status", "description", "created_at", "updated_at"],
    lxm_auth_role_menus: ["role_id", "menu_key", "created_at"],
    lxm_auth_role_permissions: ["role_id", "permission_key", "created_at"],
    lxm_auth_user_permissions: ["user_id", "permission_key", "created_at"],
    lxm_auth_users: ["id", "account", "display_name", "password_hash", "role_id", "status", "phone", "email", "legacy_key", "legacy_id", "subject_type", "subject_id", "shop_id", "distributor_id", "agent_id", "created_at", "updated_at"],
    lxm_auth_menu_attributes: ["menu_id", "attribute_key", "ordinal", "value_type", "value_text", "value_number", "value_bool"],
    lxm_auth_user_attributes: ["user_id", "attribute_key", "ordinal", "value_type", "value_text", "value_number", "value_bool"]
  };
  const columns = authColumns[table] || [];
  const noAudit = new Set(["lxm_auth_menu_attributes", "lxm_auth_user_attributes", "lxm_account_permissions", "lxm_collection_values"]);
  if (!noAudit.has(table) && table !== "lxm_schema_version") columns.push("created_at", "updated_at");
  return [...new Set(columns)];
}

function makeColumnDefinition(column) {
  const type = String(column.column_type || column.COLUMN_TYPE || "VARCHAR(255)");
  const nullable = String(column.is_nullable || column.IS_NULLABLE || "YES").toUpperCase() === "NO" ? " NOT NULL" : " NULL";
  const extra = String(column.extra || column.EXTRA || "").toLowerCase();
  let defaultClause = "";
  const value = column.column_default !== undefined ? column.column_default : column.COLUMN_DEFAULT;
  if (value !== undefined && value !== null) {
    const raw = String(value);
    defaultClause = /^CURRENT_TIMESTAMP(?:\([^)]*\))?$/i.test(raw) || /^(?:0|1|-?\d+(?:\.\d+)?)$/.test(raw)
      ? ` DEFAULT ${raw}`
      : ` DEFAULT ${sqlString(raw)}`;
  }
  const autoIncrement = extra.includes("auto_increment") ? " AUTO_INCREMENT" : "";
  return `${quoteIdentifier(column.column_name || column.COLUMN_NAME)} ${type}${nullable}${defaultClause}${autoIncrement}`;
}

async function applyMysqlDescriptions(conn, options = {}) {
  if (!conn || typeof conn.query !== "function") throw new TypeError("需要 MySQL connection");
  const schema = require("./mysqlSchema.cjs");
  const statements = [];
  const known = knownTableNames(schema);
  const existing = await conn.query(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND LOWER(table_name) IN (${known.map(() => "?").join(",")})`, known.map(name => String(name).toLowerCase()));
  const tableRows = existing[0] || [];
  const existingNames = new Map(tableRows.map(row => {
    const name = row.name || row.TABLE_NAME;
    return [String(name).toLowerCase(), name];
  }));
  for (const table of known) {
    const actualTable = existingNames.get(String(table).toLowerCase());
    if (!actualTable) continue;
    const rowsResult = await conn.query("SELECT COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,COLUMN_DEFAULT AS column_default,EXTRA AS extra FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ORDINAL_POSITION", [actualTable]);
    const rows = rowsResult[0] || [];
    const parts = [`COMMENT=${sqlString(descriptionForTable(table))}`];
    for (const row of rows) {
      const name = row.column_name || row.COLUMN_NAME;
      parts.push(`MODIFY COLUMN ${makeColumnDefinition(row)} COMMENT ${sqlString(columnComment(name))}`);
    }
    const statement = `ALTER TABLE ${quoteIdentifier(actualTable)} ${parts.join(", ")}`;
    statements.push(statement);
    if (!options.dryRun) await conn.query(statement);
  }
  return { tables: statements.length, statements };
}

module.exports = {
  TABLE_DESCRIPTIONS,
  COLUMN_DESCRIPTIONS,
  tableComment,
  columnComment,
  descriptionForTable,
  knownTableNames,
  knownColumnNames,
  applyMysqlDescriptions,
  sqlString
};
