-- DEV-SHR-003. Requires 017_customer_service.sql and 018_service_benefit.sql.
-- Shared rule/ledger/assignment/adjustment contracts remain owned by those migrations.
ALTER TABLE lxm_orders ADD KEY idx_photo_status (photo_id,service_status);
CREATE TABLE IF NOT EXISTS photo_profile (
 id VARCHAR(32) PRIMARY KEY,
 name VARCHAR(32) NOT NULL,
 phone VARCHAR(20) NOT NULL,
 agree_no VARCHAR(32) NOT NULL,
 rate_mode VARCHAR(10) NOT NULL DEFAULT 'custom',
 status VARCHAR(10) NOT NULL DEFAULT 'active',
 dispute_days INT NOT NULL DEFAULT 5,
 wait_days INT NOT NULL DEFAULT 3,
 cycle VARCHAR(10) NOT NULL DEFAULT 'monthly',
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uk_phone (phone), KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS photo_settlement (
 settle_id VARCHAR(32) PRIMARY KEY,
 period CHAR(7) NOT NULL,
 photo_id VARCHAR(32) NOT NULL,
 item_count INT NOT NULL DEFAULT 0,
 amount_fen BIGINT NOT NULL DEFAULT 0,
 offset_fen BIGINT NOT NULL DEFAULT 0,
 payable_fen BIGINT NOT NULL DEFAULT 0,
 status VARCHAR(12) NOT NULL DEFAULT 'draft',
 dispute_until DATE NULL,
 pushed_at DATETIME NULL,
 accepted_at DATETIME NULL,
 paid_at DATETIME NULL,
 voucher_url VARCHAR(255) NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uk_period_photo (period,photo_id), KEY idx_status (status,period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS photo_profile_log (
 id BIGINT PRIMARY KEY AUTO_INCREMENT,
 photo_id VARCHAR(32) NOT NULL,
 action VARCHAR(16) NOT NULL,
 detail VARCHAR(500) NOT NULL,
 operator VARCHAR(64) NOT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_photo (photo_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
