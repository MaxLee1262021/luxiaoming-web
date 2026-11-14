-- Choices confirmed by the new-staff dropdown. Existing profiles keep 月结.
ALTER TABLE svc_staff
 ADD COLUMN settlement_cycle VARCHAR(12) NOT NULL DEFAULT '月结'
 COMMENT '档案结算周期：月结/半月结/周结/隔天结';
