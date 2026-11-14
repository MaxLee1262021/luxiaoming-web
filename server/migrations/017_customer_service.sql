-- ① 订单表扩展：只加列，不改既有语义
ALTER TABLE lxm_orders
  ADD COLUMN svc_paid_processed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '支付事件已进入客服工作台（切换隔离标记）',
  ADD COLUMN customer_openid  VARCHAR(64) NULL COMMENT '客户 openid，小程序授权取得',
  ADD COLUMN requested_time   DATETIME NULL COMMENT '用户下单提交的期望拍摄时间，客服不可改',
  ADD COLUMN schedule_time    DATETIME NULL COMMENT '客服确认的拍摄时间，改期改这里',
  ADD COLUMN service_status   VARCHAR(16) NOT NULL DEFAULT 'new'
      COMMENT 'new/reserved/claimed/confirmed/shooting/done/refunded/canceled',
  ADD COLUMN assignee_id      VARCHAR(32) NULL COMMENT '归属客服，认领后写入',
  ADD COLUMN photo_id         VARCHAR(32) NULL COMMENT '最终承接摄影师',
  ADD COLUMN done_at          DATETIME NULL COMMENT '完成登记时刻',
  ADD COLUMN reserve_staff_id VARCHAR(32) NULL COMMENT '复购预占客服',
  ADD COLUMN is_rebuy         TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否复购单',
  ADD COLUMN reflow_from      VARCHAR(32) NULL COMMENT '回流来源客服，仅回流单有值',
  ADD KEY idx_openid (customer_openid),
  ADD KEY idx_status_assignee (service_status, assignee_id),
  ADD KEY idx_reserve (reserve_staff_id, service_status);

-- ② 客户绑定（一人一绑：生成列做唯一索引，解除后置 NULL 允许重建）
CREATE TABLE svc_binding (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  openid VARCHAR(64) NOT NULL,
  staff_id VARCHAR(32) NOT NULL,
  source_order_no VARCHAR(32) NOT NULL COMMENT '建立/续期这一次的服务单',
  bound_at DATETIME NOT NULL,
  expire_at DATETIME NOT NULL,
  status VARCHAR(10) NOT NULL COMMENT 'active/released/expired',
  active_flag VARCHAR(64) GENERATED ALWAYS AS (IF(status='active', openid, NULL)) STORED,
  release_reason VARCHAR(16) NULL COMMENT 'timeout/giveup/complaint/manual',
  released_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_openid_active (active_flag),
  KEY idx_staff (staff_id, status)
) COMMENT '客户-客服绑定';

-- ③ 复购预占（订单级，一张单最多一行）
CREATE TABLE svc_reserve (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(32) NOT NULL,
  openid VARCHAR(64) NOT NULL,
  staff_id VARCHAR(32) NOT NULL,
  source_order_no VARCHAR(32) NOT NULL COMMENT '上次服务单',
  paid_at DATETIME NOT NULL,
  is_quiet TINYINT(1) NOT NULL DEFAULT 0 COMMENT '支付时刻是否落在静默期',
  reserve_start_at DATETIME NOT NULL COMMENT '白天=paid_at；夜间=次日静默结束',
  reserve_expire_at DATETIME NOT NULL COMMENT '= reserve_start_at + hold_minutes',
  status VARCHAR(10) NOT NULL COMMENT 'holding/started/taken/givenup/timeout',
  end_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order (order_no),
  KEY idx_scan (status, reserve_start_at, reserve_expire_at),
  KEY idx_staff (staff_id, status)
) COMMENT '复购预占';

-- ④ 绑定流水（只增，不可改删）
CREATE TABLE svc_binding_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  openid VARCHAR(64) NOT NULL,
  order_no VARCHAR(32) NULL,
  from_staff VARCHAR(32) NULL,
  to_staff VARCHAR(32) NULL,
  action VARCHAR(16) NOT NULL COMMENT 'bind/renew/transfer/release',
  reason VARCHAR(255) NULL,
  operator VARCHAR(64) NOT NULL COMMENT 'system 或 账号',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_openid (openid, created_at)
) COMMENT '客户绑定流水';

-- ⑤ 改期留痕
CREATE TABLE svc_slot_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(32) NOT NULL,
  from_time DATETIME NULL,
  to_time DATETIME NOT NULL,
  reason VARCHAR(64) NOT NULL,
  channel VARCHAR(10) NOT NULL COMMENT 'wechat/phone/face',
  operator VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order (order_no, created_at)
) COMMENT '改期记录（含确认时调整）';

-- ⑥ 派单与转派
CREATE TABLE svc_assign_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(32) NOT NULL,
  action VARCHAR(10) NOT NULL COMMENT 'assign/transfer',
  from_photo VARCHAR(32) NULL,
  to_photo VARCHAR(32) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  channel VARCHAR(10) NOT NULL,
  zero_amount TINYINT(1) NOT NULL DEFAULT 0 COMMENT '原摄影师该单是否置零',
  operator VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order (order_no, created_at)
) COMMENT '派单 / 转派记录';

-- ⑦ 客诉（一单一条，改判进 rejudge_log JSON）
CREATE TABLE svc_complaint (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(32) NOT NULL,
  resp VARCHAR(10) NOT NULL COMMENT 'service/photo/user/unknown',
  reason VARCHAR(500) NOT NULL,
  effect VARCHAR(20) NULL COMMENT 'void/offset_planned/offset_done/none',
  rejudge_log JSON NULL COMMENT '[{from,to,why,by,at}]',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order (order_no),
  KEY idx_resp (resp)
) COMMENT '客诉与判责';

-- ⑧ 调账（补发 / 撤销 / 冲抵 / 置零）
CREATE TABLE svc_adjust (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(32) NOT NULL,
  staff_id VARCHAR(32) NOT NULL,
  action VARCHAR(20) NOT NULL COMMENT 'makeup/cancel_offset/restore/offset_plan/void',
  amount_fen BIGINT NOT NULL COMMENT '正补发，负冲抵，0 仅留痕',
  settle_id VARCHAR(32) NULL COMMENT '冲抵/补发落在哪一期',
  carried INT NOT NULL DEFAULT 0 COMMENT '已结转期数，上限 3',
  plan_id VARCHAR(64) NULL,
  period CHAR(7) NULL,
  note VARCHAR(500) NULL,
  operator VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_staff (staff_id, created_at)
) COMMENT '调账流水（只增）';

-- ⑨ 复购与时效参数（版本化，只增）
CREATE TABLE svc_config (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ver INT NOT NULL,
  rebuy_on TINYINT(1) NOT NULL DEFAULT 1,
  protect_days INT NOT NULL DEFAULT 5,
  hold_minutes INT NOT NULL DEFAULT 60,
  quiet_start CHAR(5) NOT NULL DEFAULT '22:00',
  quiet_end CHAR(5) NOT NULL DEFAULT '09:00',
  slot_remind_h INT NOT NULL DEFAULT 2,
  observe_days INT NOT NULL DEFAULT 7,
  link_valid_days INT NOT NULL DEFAULT 7,
  offset_cap_bp INT NOT NULL DEFAULT 3000,
  offset_periods INT NOT NULL DEFAULT 3,
  holiday_dates JSON NULL,
  workday_dates JSON NULL,
  eff_at DATETIME NOT NULL COMMENT '生效时点：保存后次日 00:00',
  operator VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ver (ver)
) COMMENT '复购与时效参数';

-- ⑩ 客服档案扩展
CREATE TABLE svc_staff (
 id VARCHAR(32) PRIMARY KEY, name VARCHAR(64) NOT NULL, phone VARCHAR(32) NOT NULL,
 joined_at DATE NULL, base_salary INT NOT NULL DEFAULT 0, rate_mode VARCHAR(10) NOT NULL DEFAULT 'global',
 supervisor_id VARCHAR(32) NULL, staff_status VARCHAR(10) NOT NULL DEFAULT 'active', account_id VARCHAR(128) NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL, UNIQUE KEY uk_account (account_id)
) COMMENT '客服档案（关联既有账号，不复制认证凭据）';

-- Infrastructure additions: no business payload JSON; queue retries and idempotency are durable.
CREATE TABLE svc_runtime_lock (id INT PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO svc_runtime_lock (id) VALUES (1);
CREATE TABLE svc_payment_event (order_no VARCHAR(128) PRIMARY KEY, paid_at DATETIME NOT NULL, processed_at DATETIME NOT NULL);
CREATE TABLE svc_link (id VARCHAR(32) PRIMARY KEY, order_no VARCHAR(128) NOT NULL, staff_id VARCHAR(32) NOT NULL,
 product_id VARCHAR(128) NULL, url VARCHAR(2048) NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL);
CREATE TABLE svc_notification (id VARCHAR(32) PRIMARY KEY, event_key VARCHAR(255) NOT NULL,
 event_type VARCHAR(64) NOT NULL, order_no VARCHAR(128) NULL, recipient_id VARCHAR(128) NULL,
 message VARCHAR(1000) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
 next_attempt_at DATETIME NOT NULL, created_at DATETIME NOT NULL, sent_at DATETIME NULL, failure_note VARCHAR(500) NULL,
 UNIQUE KEY uk_event (event_key), KEY idx_retry (status, next_attempt_at));
