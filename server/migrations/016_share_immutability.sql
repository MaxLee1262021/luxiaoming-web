-- Run only through the explicit maintenance migration, never at API startup.
-- Single-statement triggers work on MySQL 5.7 and 8.0 without DELIMITER blocks.
DROP TRIGGER IF EXISTS lxm_share_snapshot_no_update;
CREATE TRIGGER lxm_share_snapshot_no_update BEFORE UPDATE ON lxm_share_snapshot FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Merchant share snapshots are immutable';
DROP TRIGGER IF EXISTS lxm_share_snapshot_no_delete;
CREATE TRIGGER lxm_share_snapshot_no_delete BEFORE DELETE ON lxm_share_snapshot FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Merchant share snapshots are immutable';
DROP TRIGGER IF EXISTS lxm_share_audit_no_update;
CREATE TRIGGER lxm_share_audit_no_update BEFORE UPDATE ON lxm_share_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Merchant share audits are append-only';
DROP TRIGGER IF EXISTS lxm_share_audit_no_delete;
CREATE TRIGGER lxm_share_audit_no_delete BEFORE DELETE ON lxm_share_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Merchant share audits are append-only';
DROP TRIGGER IF EXISTS lxm_share_correction_no_update;
CREATE TRIGGER lxm_share_correction_no_update BEFORE UPDATE ON lxm_share_correction FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Merchant share corrections are append-only';
DROP TRIGGER IF EXISTS lxm_share_correction_no_delete;
CREATE TRIGGER lxm_share_correction_no_delete BEFORE DELETE ON lxm_share_correction FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Merchant share corrections are append-only';
