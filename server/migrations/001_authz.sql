-- Project Hub v1 MySQL baseline. Every statement is idempotent and may be
-- executed independently by scripts/migrate-mysql.cjs.
CREATE TABLE IF NOT EXISTS lxm_business_documents (
  collection_name VARCHAR(64) NOT NULL,
  id VARCHAR(128) NOT NULL,
  doc JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (collection_name, id),
  KEY idx_business_updated (updated_at)
);

-- Existing dbSource keys retain the lxm_<key> contract for zero-downtime
-- cutover. Records are JSON documents so legacy payloads remain lossless.
CREATE TABLE IF NOT EXISTS lxm_cities (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_agents (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_distributors (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_shops (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_staff (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_spots (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_series (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_albums (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_samples (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_packages (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_addonServices (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_peripherals (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_tagLibrary (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_guides (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_stories (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_scans (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_orders (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_afterSales (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_reconciliationTransfers (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_financeSettings (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_monthlyClosings (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_adjustmentRecords (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_homeConfig (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_logs (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_trash (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_merchantCodes (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_siteConfig (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_userProfiles (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);
CREATE TABLE IF NOT EXISTS lxm_config (id VARCHAR(128) PRIMARY KEY, doc JSON NOT NULL, updated_at DATETIME(3) NOT NULL);

CREATE TABLE IF NOT EXISTS lxm_auth_menus (
  id VARCHAR(64) PRIMARY KEY,
  menu_key VARCHAR(128) NOT NULL UNIQUE,
  parent_key VARCHAR(128) NULL,
  name VARCHAR(128) NOT NULL,
  path VARCHAR(255) NOT NULL,
  icon VARCHAR(64) NULL,
  sort_no INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  meta JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_auth_menu_parent (parent_key), KEY idx_auth_menu_status (status)
);

CREATE TABLE IF NOT EXISTS lxm_auth_roles (
  id VARCHAR(64) PRIMARY KEY,
  role_key VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  description VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS lxm_auth_role_menus (
  role_id VARCHAR(64) NOT NULL,
  menu_key VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (role_id, menu_key),
  KEY idx_auth_rm_menu (menu_key)
);

CREATE TABLE IF NOT EXISTS lxm_auth_role_permissions (
  role_id VARCHAR(64) NOT NULL,
  permission_key VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS lxm_auth_users (
  id VARCHAR(64) PRIMARY KEY,
  account VARCHAR(128) NOT NULL UNIQUE,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  phone VARCHAR(64) NULL,
  email VARCHAR(255) NULL,
  extra JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_auth_user_role (role_id), KEY idx_auth_user_status (status)
);

INSERT INTO lxm_auth_roles (id, role_key, name, status, description, created_at, updated_at)
VALUES
 ('role_super','super','超级管理员','active','全部菜单与权限',NOW(3),NOW(3)),
 ('role_service','service','订单客服','active','订单与售后处理',NOW(3),NOW(3)),
 ('role_finance','finance','财务','active','收款、退款与对账',NOW(3),NOW(3)),
 ('role_content','content','内容运营','active','内容与首页配置',NOW(3),NOW(3)),
 ('role_photo','photo','摄影师','active','拍摄订单处理',NOW(3),NOW(3)),
 ('role_merchant','merchant','商家','active','门店与商家码',NOW(3),NOW(3)),
 ('role_distributor','distributor','分销商','active','所属门店订单',NOW(3),NOW(3)),
 ('role_agent','agent','代理商','active','代理业务查看',NOW(3),NOW(3))
ON DUPLICATE KEY UPDATE name=VALUES(name),status=VALUES(status),description=VALUES(description),updated_at=VALUES(updated_at);

INSERT INTO lxm_auth_menus (id,menu_key,parent_key,name,path,icon,sort_no,status,meta,created_at,updated_at)
VALUES
 ('menu_dashboard','dashboard',NULL,'经营看板','/dashboard','dashboard',10,'active',JSON_OBJECT(),NOW(3),NOW(3)),
 ('menu_orders','orders',NULL,'订单管理','/orders','shopping-bag',20,'active',JSON_OBJECT(),NOW(3),NOW(3)),
 ('menu_service','service',NULL,'售后服务','/service','headphones',30,'active',JSON_OBJECT(),NOW(3),NOW(3)),
 ('menu_content','content',NULL,'内容管理','/content','image',40,'active',JSON_OBJECT(),NOW(3),NOW(3)),
 ('menu_reconciliation','reconciliation',NULL,'财务对账','/reconciliation','wallet',50,'active',JSON_OBJECT(),NOW(3),NOW(3)),
 ('menu_accounts','accounts',NULL,'账号与权限','/accounts','users',60,'active',JSON_OBJECT(),NOW(3),NOW(3)),
 ('menu_settings','settings',NULL,'系统设置','/settings','settings',70,'active',JSON_OBJECT(),NOW(3),NOW(3))
ON DUPLICATE KEY UPDATE name=VALUES(name),path=VALUES(path),status=VALUES(status),sort_no=VALUES(sort_no),updated_at=VALUES(updated_at);

INSERT INTO lxm_auth_menus (id,menu_key,parent_key,name,path,icon,sort_no,status,meta,created_at,updated_at) VALUES
 ('menu_afterSales','afterSales',NULL,'售后服务','/after-sales','headphones',21,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_financeReview','financeReview',NULL,'财务审核','/finance-review','check',31,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_tasks','tasks',NULL,'拍摄任务','/tasks','camera',22,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_staff','staff',NULL,'人员管理','/staff','users',61,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_distributors','distributors',NULL,'分销管理','/distributors','share',62,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_shops','shops',NULL,'商家管理','/shops','store',63,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_contentOverview','contentOverview',NULL,'内容总览','/content','image',41,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_spots','spots',NULL,'打卡点','/spots','map',42,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_cities','cities',NULL,'城市','/cities','map-pin',43,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_series','series',NULL,'拍摄风格','/series','layers',44,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_albums','albums',NULL,'照片留影','/albums','image',45,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_samples','samples',NULL,'素材库','/samples','folder',46,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_contentTags','contentTags',NULL,'标签管理','/content-tags','tag',47,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_packages','packages',NULL,'旅拍套餐','/packages','package',48,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_videoSingles','videoSingles',NULL,'视频摄像','/video-singles','video',49,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_shelfProducts','shelfProducts',NULL,'商品上下架','/shelf-products','box',50,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_productAudit','productAudit',NULL,'商品审核','/product-audit','check',51,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_addonServices','addonServices',NULL,'增值服务','/addon-services','plus',23,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_peripherals','peripherals',NULL,'影像周边','/peripherals','gift',52,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_miniDecor','miniDecor',NULL,'小程序首页','/mini-decor','home',53,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_miniConfig','miniConfig',NULL,'小程序全局配置','/mini-config','settings',54,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_guides','guides',NULL,'旅拍灵感','/guides','book',55,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_logs','logs',NULL,'操作日志','/logs','file-text',71,'active',JSON_OBJECT(),NOW(3),NOW(3)),('menu_trash','trash',NULL,'回收站','/trash','trash',72,'active',JSON_OBJECT(),NOW(3),NOW(3))
ON DUPLICATE KEY UPDATE name=VALUES(name),path=VALUES(path),status=VALUES(status),sort_no=VALUES(sort_no),updated_at=VALUES(updated_at);

INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key,created_at) VALUES
 ('role_super','dashboard',NOW(3)),('role_super','orders',NOW(3)),('role_super','service',NOW(3)),('role_super','content',NOW(3)),('role_super','reconciliation',NOW(3)),('role_super','accounts',NOW(3)),('role_super','settings',NOW(3)),
 ('role_service','dashboard',NOW(3)),('role_service','orders',NOW(3)),('role_service','service',NOW(3)),
 ('role_finance','dashboard',NOW(3)),('role_finance','orders',NOW(3)),('role_finance','service',NOW(3)),('role_finance','reconciliation',NOW(3)),
 ('role_content','dashboard',NOW(3)),('role_content','content',NOW(3)),
 ('role_photo','dashboard',NOW(3)),('role_photo','orders',NOW(3)),
 ('role_merchant','dashboard',NOW(3)),('role_merchant','orders',NOW(3)),
 ('role_distributor','dashboard',NOW(3)),('role_distributor','orders',NOW(3)),
 ('role_agent','dashboard',NOW(3)),('role_agent','orders',NOW(3));

INSERT IGNORE INTO lxm_auth_role_permissions (role_id,permission_key,created_at) VALUES
 ('role_super','*',NOW(3)),('role_service','order.view',NOW(3)),('role_service','order.edit',NOW(3)),('role_finance','finance.review',NOW(3)),('role_content','content.edit',NOW(3)),('role_photo','order.shoot',NOW(3)),('role_merchant','merchant.code',NOW(3)),('role_distributor','order.view',NOW(3)),('role_agent','order.view',NOW(3));
