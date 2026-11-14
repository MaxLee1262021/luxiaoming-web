-- Confirmed business replies, 2026-11-11. Additive, reentrant through migrator.
ALTER TABLE svc_staff ADD COLUMN rate_review_date DATE NULL COMMENT '手工维护的下次比例复核日期';
ALTER TABLE svc_appeal ADD COLUMN submitted_by VARCHAR(128) NULL COMMENT '实际提交人，主管代办仍保留原客服';
CREATE TABLE IF NOT EXISTS svc_staff_tag (
 staff_id VARCHAR(32) NOT NULL, tag_index INT NOT NULL, tag VARCHAR(32) NOT NULL,
 PRIMARY KEY (staff_id,tag_index), UNIQUE KEY uk_staff_tag (staff_id,tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS svc_staff_profile_log (
 id BIGINT PRIMARY KEY AUTO_INCREMENT, staff_id VARCHAR(32) NOT NULL,
 action VARCHAR(32) NOT NULL, from_tags JSON NULL, to_tags JSON NULL,
 from_review_date DATE NULL, to_review_date DATE NULL,
 reason VARCHAR(500) NOT NULL, operator VARCHAR(128) NOT NULL, created_at DATETIME NOT NULL,
 KEY idx_staff (staff_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS svc_operation_log (
 id BIGINT PRIMARY KEY AUTO_INCREMENT, order_no VARCHAR(128) NOT NULL,
 action VARCHAR(64) NOT NULL, staff_id VARCHAR(32) NULL, operator VARCHAR(128) NOT NULL,
 reason VARCHAR(500) NULL, created_at DATETIME NOT NULL,
 KEY idx_order (order_no,created_at), KEY idx_staff (staff_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS svc_receipt_log (
 id BIGINT PRIMARY KEY AUTO_INCREMENT, order_no VARCHAR(128) NOT NULL,
 received_at DATETIME NOT NULL, operator VARCHAR(128) NOT NULL, created_at DATETIME NOT NULL,
 UNIQUE KEY uk_order (order_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
