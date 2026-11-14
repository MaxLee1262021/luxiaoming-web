-- NULL preserves the shared configuration for existing profiles and old clients.
ALTER TABLE svc_staff
 ADD COLUMN link_valid_days TINYINT UNSIGNED NULL DEFAULT NULL
 COMMENT '客服个人链接有效期（1至30天），空值沿用共用配置',
 ADD COLUMN observe_days TINYINT UNSIGNED NULL DEFAULT NULL
 COMMENT '客服个人结算等待期（0至30天），空值沿用共用配置';
