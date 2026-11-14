-- Independent merchant referral ledger. Identity columns deliberately match
-- existing VARCHAR identifiers. Run explicitly before enabling the new module.
CREATE TABLE IF NOT EXISTS lxm_share_merchant (
  onboard_request_hash CHAR(64) NULL,
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  name VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  refund_window_days INT NOT NULL DEFAULT 3,
  contact VARCHAR(255) NULL,
  phone VARCHAR(64) NULL,
  address TEXT NULL,
  account VARCHAR(128) NULL,
  business_license_no VARCHAR(128) NULL,
  invoice_title VARCHAR(255) NULL,
  tax_no VARCHAR(128) NULL,
  bank_name VARCHAR(255) NULL,
  bank_account VARCHAR(128) NULL,
  account_holder VARCHAR(255) NULL,
  cooperation_confirmed TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_merchant_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_merchant_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  merchant_id VARCHAR(128) NOT NULL,
  name VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  status VARCHAR(20) NOT NULL,
  refund_window_days INT NOT NULL,
  event_at DATETIME(3) NOT NULL,
  KEY idx_share_merchant_history (merchant_id,event_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_rule (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  merchant_id VARCHAR(128) NOT NULL,
  version_no INT NOT NULL,
  ratio_t1 DECIMAL(7,4) NOT NULL,
  ratio_t2 DECIMAL(7,4) NOT NULL,
  ttl_hours INT NOT NULL DEFAULT 720,
  refund_window_days INT NOT NULL DEFAULT 3,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  reason VARCHAR(255) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  effective_from DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_rule_version (merchant_id,version_no),
  KEY idx_share_rule_time (merchant_id,effective_from,version_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_qr (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  merchant_id VARCHAR(128) NOT NULL,
  qr_seq INT NOT NULL,
  scene VARCHAR(32) NOT NULL,
  image_url MEDIUMTEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  active_flag TINYINT NULL,
  reason VARCHAR(255) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  rotate_request_key VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL,
  disabled_at DATETIME(3) NULL,
  UNIQUE KEY uk_share_qr_scene (scene),
  UNIQUE KEY uk_share_qr_active (merchant_id,active_flag),
  UNIQUE KEY uk_share_qr_seq (merchant_id,qr_seq),
  UNIQUE KEY uk_share_qr_request (merchant_id,rotate_request_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_scan (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  merchant_id VARCHAR(128) NOT NULL,
  qr_id VARCHAR(128) NOT NULL,
  scene VARCHAR(32) NOT NULL,
  request_key VARCHAR(128) NULL,
  launch_type TINYINT NOT NULL DEFAULT 1,
  device_id VARCHAR(128) NULL,
  client_scan_at VARCHAR(64) NULL,
  scan_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_scan_request (request_key),
  KEY idx_share_scan_user (user_id,scan_at,id),
  KEY idx_share_scan_merchant_qr (merchant_id,qr_id,scan_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_user_lock (
  user_id VARCHAR(128) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_order_lock (
  order_id VARCHAR(128) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_binding (
  user_id VARCHAR(128) NOT NULL,
  merchant_id VARCHAR(128) NOT NULL,
  first_scan_at DATETIME(3) NOT NULL,
  last_scan_at DATETIME(3) NOT NULL,
  last_scan_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id,merchant_id),
  KEY idx_share_binding_pick (user_id,status,last_scan_at,last_scan_id),
  KEY idx_share_binding_merchant (merchant_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_binding_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  merchant_id VARCHAR(128) NOT NULL,
  scan_id BIGINT UNSIGNED NOT NULL,
  scan_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL,
  event_at DATETIME(3) NOT NULL,
  KEY idx_share_binding_asof (user_id,event_at,id),
  KEY idx_share_binding_event_merchant (merchant_id,event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_click (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  staff_id VARCHAR(128) NULL,
  staff_wecom_id VARCHAR(128) NULL,
  link_id VARCHAR(128) NULL,
  session_id VARCHAR(128) NULL,
  request_key VARCHAR(128) NULL,
  click_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_click_request (request_key),
  KEY idx_share_click_pick (user_id,click_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_staff_map (
  wecom_userid VARCHAR(128) NOT NULL PRIMARY KEY,
  staff_id VARCHAR(128) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_cs_link (
  link_id VARCHAR(128) NOT NULL PRIMARY KEY,
  staff_id VARCHAR(128) NOT NULL,
  wecom_user_id VARCHAR(128) NULL,
  expires_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  operator_id VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  request_key VARCHAR(128) NULL,
  UNIQUE KEY uk_share_cs_link_request (operator_id,request_key),
  KEY idx_share_cs_link_staff (staff_id,status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_job (
  order_id VARCHAR(128) NOT NULL PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  paid_total DECIMAL(12,2) NOT NULL,
  pay_time DATETIME(3) NOT NULL,
  available_at DATETIME(3) NOT NULL,
  decision_json JSON NOT NULL,
  display_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  last_error VARCHAR(255) NULL,
  snapshot_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_share_job_due (status,next_attempt_at,pay_time),
  KEY idx_share_job_pending_pick (status,pay_time,order_id),
  KEY idx_share_job_user_time (user_id,pay_time,order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_pending_cursor (
  cursor_name VARCHAR(64) NOT NULL PRIMARY KEY,
  last_pay_time DATETIME(3) NULL,
  last_order_id VARCHAR(128) NULL,
  cycle_no INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_user_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  request_key VARCHAR(128) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  event_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_user_invalidation (user_id,request_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_snapshot (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  staff_id VARCHAR(128) NULL,
  cs_click_id BIGINT UNSIGNED NULL,
  split_type VARCHAR(8) NOT NULL,
  judge_time DATETIME(3) NOT NULL,
  hit_merchant_id VARCHAR(128) NOT NULL,
  hit_reason VARCHAR(40) NOT NULL,
  candidate_json JSON NOT NULL,
  ratio DECIMAL(7,4) NOT NULL,
  rule_version INT NOT NULL,
  engine_version VARCHAR(16) NOT NULL,
  paid_total DECIMAL(12,2) NOT NULL,
  refunded_before_snapshot DECIMAL(12,2) NOT NULL,
  base_amount DECIMAL(12,2) NOT NULL,
  split_amount DECIMAL(12,2) NOT NULL,
  refund_window_days INT NOT NULL,
  available_at DATETIME(3) NOT NULL,
  source_flag VARCHAR(64) NULL,
  source_reason VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL,
  display_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_snapshot_order (order_id),
  KEY idx_share_snapshot_merchant (hit_merchant_id,judge_time),
  KEY idx_share_snapshot_user (user_id,judge_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_detail (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  detail_no VARCHAR(64) NOT NULL,
  snapshot_id BIGINT UNSIGNED NOT NULL,
  order_id VARCHAR(128) NOT NULL,
  merchant_id VARCHAR(128) NOT NULL,
  split_type VARCHAR(8) NOT NULL,
  direction TINYINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  base_amount DECIMAL(12,2) NOT NULL,
  ratio DECIMAL(7,4) NOT NULL,
  period CHAR(7) NOT NULL,
  refund_no VARCHAR(128) NULL,
  entry_key VARCHAR(191) NOT NULL,
  entry_type VARCHAR(32) NOT NULL DEFAULT 'POST',
  revision_no INT NOT NULL DEFAULT 0,
  correction_id BIGINT UNSIGNED NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'EFFECTIVE',
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_detail_no (detail_no),
  UNIQUE KEY uk_share_detail_entry (entry_key),
  UNIQUE KEY uk_share_detail_refund (snapshot_id,refund_no),
  KEY idx_share_detail_merchant (merchant_id,period,split_type),
  KEY idx_share_detail_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_correction (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(128) NOT NULL,
  snapshot_id BIGINT UNSIGNED NOT NULL,
  revision_no INT NOT NULL,
  request_key VARCHAR(128) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  changed TINYINT NOT NULL,
  previous_state_json JSON NOT NULL,
  next_state_json JSON NOT NULL,
  previous_balance DECIMAL(12,2) NOT NULL,
  corrected_balance DECIMAL(12,2) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_correction_request (request_key),
  UNIQUE KEY uk_share_correction_revision (order_id,revision_no),
  KEY idx_share_correction_order (order_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_correction_quota (
  period CHAR(7) NOT NULL PRIMARY KEY,
  used_count INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_refund (
  refund_no VARCHAR(128) NOT NULL PRIMARY KEY,
  order_id VARCHAR(128) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  refund_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_share_refund_order (order_id,refund_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_key VARCHAR(191) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_share_outbox_event (event_key),
  KEY idx_share_outbox_due (status,next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_failure (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(128) NOT NULL,
  error_code VARCHAR(64) NOT NULL,
  message VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_at DATETIME(3) NOT NULL,
  KEY idx_share_failure_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action VARCHAR(64) NOT NULL,
  subject_id VARCHAR(128) NOT NULL,
  operator_id VARCHAR(128) NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_share_audit_subject (subject_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_schedule (
  task_name VARCHAR(64) NOT NULL PRIMARY KEY,
  slot_at DATETIME(3) NOT NULL,
  next_slot_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL,
  lease_token VARCHAR(64) NULL,
  lease_until DATETIME(3) NULL,
  next_attempt_at DATETIME(3) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_schedule_run (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_name VARCHAR(64) NOT NULL,
  slot_at DATETIME(3) NOT NULL,
  lease_token VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  skipped_slots INT NOT NULL DEFAULT 0,
  result_json JSON NULL,
  error_code VARCHAR(64) NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  UNIQUE KEY uk_share_schedule_token (lease_token),
  KEY idx_share_schedule_history (task_name,slot_at,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_metric (
  slot_at DATETIME(3) NOT NULL PRIMARY KEY,
  metric_date CHAR(10) NOT NULL,
  metrics_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_observation (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  metric_key VARCHAR(64) NOT NULL,
  subject_hash VARCHAR(64) NULL,
  success TINYINT NOT NULL,
  value_number DECIMAL(20,6) NULL,
  value_text VARCHAR(255) NULL,
  occurred_at DATETIME(3) NOT NULL,
  KEY idx_share_observation_metric (metric_key,occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS lxm_share_risk (
  entity_type VARCHAR(20) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  risk_code VARCHAR(64) NOT NULL,
  priority VARCHAR(8) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (entity_type,entity_id,risk_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
