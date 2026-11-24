-- Keep external provisioning separate from local account creation. Existing
-- profiles remain unsynchronized until an administrator explicitly retries.
-- Same shared mapping definition as 015; service-only installations may not
-- have installed merchant sharing. Preserve all existing bindings.
CREATE TABLE IF NOT EXISTS lxm_share_staff_map (
  wecom_userid VARCHAR(128) NOT NULL PRIMARY KEY,
  staff_id VARCHAR(128) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE svc_staff
 ADD COLUMN wecom_userid VARCHAR(128) NULL DEFAULT NULL,
 ADD COLUMN wecom_department_id BIGINT UNSIGNED NULL DEFAULT NULL,
 ADD COLUMN wecom_sync_status VARCHAR(16) NULL DEFAULT NULL,
 ADD COLUMN wecom_sync_message VARCHAR(255) NULL DEFAULT NULL,
 ADD COLUMN wecom_sync_started_at DATETIME NULL DEFAULT NULL,
 ADD COLUMN wecom_synced_at DATETIME NULL DEFAULT NULL;
