# MySQL 表与字段字典

> 本字典由 `scripts/generate-mysql-dictionary.cjs` 从 `mysqlSchema.cjs` 和 `mysqlDescriptions.cjs` 生成。数据库中的 `TABLE_COMMENT` / `COLUMN_COMMENT` 由 `npm run migrate:mysql -- --apply` 同步。

共 82 张表。字段描述覆盖业务表、关系表、权限表、媒体表、收藏表和系统元数据表。

## lxm_account_permissions

**表描述：** 账号集合权限关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `collection_name` | `VARCHAR(32) NOT NULL` | 业务集合名称 |
| `account_id` | `VARCHAR(128) NOT NULL` | 账号标识 |
| `permission_key` | `VARCHAR(128) NOT NULL` | 权限业务键 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |

## lxm_addonServices

**表描述：** 旅拍增值服务

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `category` | `VARCHAR(255) NULL` | 分类 |
| `cate` | `VARCHAR(255) NULL` | 字段：cate |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `enabled` | `TINYINT(1) NULL` | 是否启用 |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `intro` | `TEXT NULL` | 简介 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `seriesId` | `VARCHAR(255) NULL` | 系列标识 |
| `albumId` | `VARCHAR(255) NULL` | 照片商品标识 |
| `eligibility` | `VARCHAR(255) NULL` | 字段：eligibility |
| `orderScope` | `VARCHAR(255) NULL` | 字段：order Scope |
| `maxQuantity` | `INT NULL` | 字段：max Quantity |
| `holidaySurcharge` | `DECIMAL(18,2) NULL` | 字段：holiday Surcharge |
| `financeReviewRequired` | `TINYINT(1) NULL` | 字段：finance Review Required |
| `includeInOrderAmount` | `TINYINT(1) NULL` | 字段：include In Order Amount |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_addon_package_defaults

**表描述：** 增值服务默认套餐关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `addon_id` | `VARCHAR(128) NOT NULL` | 增值服务标识 |
| `package_id` | `VARCHAR(128) NOT NULL` | 套餐标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_adjustmentRecords

**表描述：** 财务调账记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `orderNo` | `VARCHAR(255) NULL` | 订单号 |
| `orderId` | `VARCHAR(255) NULL` | 订单标识 |
| `time` | `VARCHAR(64) NULL` | 发生时间 |
| `type` | `VARCHAR(255) NULL` | 记录类型 |
| `amount` | `DECIMAL(18,2) NULL` | 金额 |
| `targetType` | `VARCHAR(255) NULL` | 字段：target Type |
| `targetName` | `VARCHAR(255) NULL` | 字段：target Name |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operatorId` | `VARCHAR(255) NULL` | 操作人标识 |
| `approvalStatus` | `VARCHAR(255) NULL` | 字段：approval Status |
| `approvedBy` | `VARCHAR(255) NULL` | 字段：approved By |
| `approvedAt` | `VARCHAR(64) NULL` | 字段：approved At |
| `note` | `TEXT NULL` | 备注 |
| `attachment` | `TEXT NULL` | 字段：attachment |
| `offsetStatus` | `VARCHAR(255) NULL` | 字段：offset Status |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_afterSales

**表描述：** 订单售后工单

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `orderId` | `VARCHAR(255) NULL` | 订单标识 |
| `orderNo` | `VARCHAR(255) NULL` | 订单号 |
| `openid` | `VARCHAR(255) NULL` | 微信用户唯一标识 |
| `type` | `VARCHAR(255) NULL` | 记录类型 |
| `customer` | `TEXT NULL` | 字段：customer |
| `packageName` | `VARCHAR(255) NULL` | 套餐名称 |
| `reason` | `TEXT NULL` | 原因说明 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `customerVisibleStatus` | `VARCHAR(255) NULL` | 字段：customer Visible Status |
| `submitSource` | `VARCHAR(255) NULL` | 字段：submit Source |
| `assigneeId` | `VARCHAR(255) NULL` | 客服负责人标识 |
| `refundAmount` | `DECIMAL(18,2) NULL` | 退款金额 |
| `amount` | `DECIMAL(18,2) NULL` | 金额 |
| `refundConfirmed` | `TINYINT(1) NULL` | 字段：refund Confirmed |
| `financeStatus` | `VARCHAR(255) NULL` | 财务审核状态 |
| `approvedBy` | `VARCHAR(255) NULL` | 字段：approved By |
| `approvedAt` | `VARCHAR(64) NULL` | 字段：approved At |
| `financeReviewedBy` | `VARCHAR(255) NULL` | 字段：finance Reviewed By |
| `financeReviewedAt` | `VARCHAR(64) NULL` | 字段：finance Reviewed At |
| `createdBy` | `VARCHAR(255) NULL` | 字段：created By |
| `createdById` | `VARCHAR(255) NULL` | 字段：created By Id |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_after_sale_logs

**表描述：** 售后处理日志

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `after_sale_id` | `VARCHAR(128) NOT NULL` | 售后工单标识 |
| `log_no` | `INT NOT NULL` | 日志序号 |
| `message` | `TEXT NULL` | 消息内容 |
| `time` | `VARCHAR(64) NULL` | 发生时间 |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operator_id` | `VARCHAR(128) NULL` | 操作人标识 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_agents

**表描述：** 代理人账号与组织信息

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `account` | `VARCHAR(255) NULL` | 登录账号 |
| `phone` | `VARCHAR(255) NULL` | 联系电话 |
| `email` | `VARCHAR(255) NULL` | 电子邮箱 |
| `role` | `VARCHAR(255) NULL` | 角色 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `city` | `VARCHAR(255) NULL` | 城市名称 |
| `cityId` | `VARCHAR(255) NULL` | 城市标识 |
| `agentId` | `VARCHAR(255) NULL` | 代理人标识 |
| `shopId` | `VARCHAR(255) NULL` | 门店标识 |
| `distributorId` | `VARCHAR(255) NULL` | 分销商标识 |
| `commissionRate` | `DECIMAL(20,6) NULL` | 字段：commission Rate |
| `settlementCycle` | `VARCHAR(255) NULL` | 字段：settlement Cycle |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_album_samples

**表描述：** 照片商品与样片关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `album_id` | `VARCHAR(128) NOT NULL` | 照片商品标识 |
| `sample_id` | `VARCHAR(128) NOT NULL` | 样片标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_album_tags

**表描述：** 照片商品标签关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `album_id` | `VARCHAR(128) NOT NULL` | 照片商品标识 |
| `tag` | `VARCHAR(255) NOT NULL` | 标签 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_albums

**表描述：** 照片留影商品

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `seriesId` | `VARCHAR(255) NULL` | 系列标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `intro` | `TEXT NULL` | 简介 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `photoCount` | `INT NULL` | 照片数量 |
| `shootingNotes` | `TEXT NULL` | 字段：shooting Notes |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `isSellable` | `TINYINT(1) NULL` | 字段：is Sellable |
| `allowMaterialUse` | `TINYINT(1) NULL` | 字段：allow Material Use |
| `photoMaterialEnabled` | `TINYINT(1) NULL` | 字段：photo Material Enabled |
| `videoMaterialEnabled` | `TINYINT(1) NULL` | 字段：video Material Enabled |
| `cover` | `TEXT NULL` | 封面地址 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_menu_attributes

**表描述：** 菜单扩展属性

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `menu_id` | `VARCHAR(255)` | 菜单标识 |
| `attribute_key` | `VARCHAR(255)` | 属性键 |
| `ordinal` | `VARCHAR(255)` | 属性序号 |
| `value_type` | `VARCHAR(255)` | 属性值类型 |
| `value_text` | `VARCHAR(255)` | 文本属性值 |
| `value_number` | `VARCHAR(255)` | 数值属性值 |
| `value_bool` | `VARCHAR(255)` | 布尔属性值 |

## lxm_auth_menus

**表描述：** 后台权限菜单

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128)` | 记录唯一标识 |
| `menu_key` | `VARCHAR(128)` | 菜单业务键 |
| `parent_key` | `VARCHAR(128)` | 父级菜单键 |
| `name` | `VARCHAR(128)` | 名称 |
| `path` | `VARCHAR(255)` | 菜单路径或扩展属性路径 |
| `icon` | `VARCHAR(64)` | 菜单图标 |
| `sort_no` | `INT` | 关系排序号 |
| `status` | `VARCHAR(32)` | 业务状态 |
| `meta_group` | `VARCHAR(255)` | 菜单元数据分组 |
| `meta_type` | `VARCHAR(255)` | 菜单元数据类型 |
| `meta_label` | `VARCHAR(255)` | 菜单元数据标签 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_menus_normalized

**表描述：** 规范化菜单投影

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128)` | 记录唯一标识 |
| `menu_key` | `VARCHAR(128)` | 菜单业务键 |
| `parent_key` | `VARCHAR(128)` | 父级菜单键 |
| `name` | `VARCHAR(128)` | 名称 |
| `path` | `VARCHAR(255)` | 菜单路径或扩展属性路径 |
| `icon` | `VARCHAR(64)` | 菜单图标 |
| `sort_no` | `INT` | 关系排序号 |
| `status` | `VARCHAR(32)` | 业务状态 |
| `group_name` | `VARCHAR(255)` | 菜单分组 |
| `menu_type` | `VARCHAR(255)` | 菜单类型 |
| `route_key` | `VARCHAR(255)` | 路由业务键 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_role_menus

**表描述：** 角色菜单授权关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `role_id` | `VARCHAR(128)` | 角色标识 |
| `menu_key` | `VARCHAR(128)` | 菜单业务键 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_role_permissions

**表描述：** 角色权限授权关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `role_id` | `VARCHAR(128)` | 角色标识 |
| `permission_key` | `VARCHAR(128)` | 权限业务键 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_roles

**表描述：** 后台权限角色

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128)` | 记录唯一标识 |
| `role_key` | `VARCHAR(64)` | 角色业务键 |
| `name` | `VARCHAR(128)` | 名称 |
| `status` | `VARCHAR(32)` | 业务状态 |
| `description` | `VARCHAR(255)` | 面向用户的详细描述 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_user_attributes

**表描述：** 用户扩展属性

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `user_id` | `VARCHAR(128)` | 用户标识 |
| `attribute_key` | `VARCHAR(255)` | 属性键 |
| `ordinal` | `VARCHAR(255)` | 属性序号 |
| `value_type` | `VARCHAR(255)` | 属性值类型 |
| `value_text` | `VARCHAR(255)` | 文本属性值 |
| `value_number` | `VARCHAR(255)` | 数值属性值 |
| `value_bool` | `VARCHAR(255)` | 布尔属性值 |

## lxm_auth_user_permissions

**表描述：** 用户直接权限关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `user_id` | `VARCHAR(128)` | 用户标识 |
| `permission_key` | `VARCHAR(128)` | 权限业务键 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_users

**表描述：** 后台认证用户

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128)` | 记录唯一标识 |
| `account` | `VARCHAR(128)` | 登录账号 |
| `display_name` | `VARCHAR(128)` | 显示名称 |
| `password_hash` | `VARCHAR(255)` | 密码哈希 |
| `role_id` | `VARCHAR(128)` | 角色标识 |
| `status` | `VARCHAR(32)` | 业务状态 |
| `phone` | `VARCHAR(64)` | 联系电话 |
| `email` | `VARCHAR(255)` | 电子邮箱 |
| `legacy_key` | `VARCHAR(64)` | 旧系统集合键 |
| `legacy_id` | `VARCHAR(128)` | 旧系统记录标识 |
| `subject_type` | `VARCHAR(64)` | 主体类型 |
| `subject_id` | `VARCHAR(128)` | 主体标识 |
| `shop_id` | `VARCHAR(128)` | 门店标识 |
| `distributor_id` | `VARCHAR(128)` | 分销商标识 |
| `agent_id` | `VARCHAR(128)` | 代理人标识 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_auth_users_normalized

**表描述：** 规范化用户投影

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128)` | 记录唯一标识 |
| `account` | `VARCHAR(128)` | 登录账号 |
| `display_name` | `VARCHAR(128)` | 显示名称 |
| `password_hash` | `VARCHAR(255)` | 密码哈希 |
| `role_id` | `VARCHAR(128)` | 角色标识 |
| `status` | `VARCHAR(32)` | 业务状态 |
| `phone` | `VARCHAR(64)` | 联系电话 |
| `email` | `VARCHAR(255)` | 电子邮箱 |
| `subject_type` | `VARCHAR(64)` | 主体类型 |
| `subject_id` | `VARCHAR(128)` | 主体标识 |
| `legacy_key` | `VARCHAR(64)` | 旧系统集合键 |
| `legacy_id` | `VARCHAR(128)` | 旧系统记录标识 |
| `shop_id` | `VARCHAR(128)` | 门店标识 |
| `distributor_id` | `VARCHAR(128)` | 分销商标识 |
| `agent_id` | `VARCHAR(128)` | 代理人标识 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_bookingRequests

**表描述：** 预约支付草稿

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `openid` | `VARCHAR(128) NULL` | 微信用户唯一标识 |
| `bookingIdempotencyKey` | `VARCHAR(128) NULL` | 预约幂等键 |
| `confirmedOrderId` | `VARCHAR(128) NULL` | 字段：confirmed Order Id |
| `bookingStatus` | `VARCHAR(64) NULL` | 字段：booking Status |
| `status` | `VARCHAR(64) NULL` | 业务状态 |
| `workflowStage` | `VARCHAR(64) NULL` | 履约阶段 |
| `totalAmount` | `DECIMAL(18,2) NULL` | 订单应收总额 |
| `depositDue` | `DECIMAL(18,2) NULL` | 定金应收金额 |
| `depositPaid` | `DECIMAL(18,2) NULL` | 已收定金 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_booking_payment_records

**表描述：** 预约草稿支付记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `booking_id` | `VARCHAR(128) NOT NULL` | 字段：booking id |
| `record_no` | `INT NOT NULL` | 记录序号 |
| `payment_id` | `VARCHAR(128) NULL` | 支付记录标识 |
| `idempotency_key` | `VARCHAR(128) NULL` | 支付幂等键 |
| `out_trade_no` | `VARCHAR(32) NULL` | 微信支付商户订单号 |
| `external_transaction_id` | `VARCHAR(160) NULL` | 第三方支付交易号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_cities

**表描述：** 城市主数据

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `mode` | `VARCHAR(255) NULL` | 字段：mode |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `code` | `VARCHAR(255) NULL` | 字段：code |
| `cityId` | `VARCHAR(255) NULL` | 城市标识 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `sort` | `INT NULL` | 展示排序 |
| `enabled` | `TINYINT(1) NULL` | 是否启用 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `latitude` | `DECIMAL(20,6) NULL` | 纬度 |
| `longitude` | `DECIMAL(20,6) NULL` | 经度 |
| `coordType` | `VARCHAR(255) NULL` | 坐标系类型 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_collection_values

**表描述：** 业务集合扩展属性

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `collection_name` | `VARCHAR(64) NOT NULL` | 业务集合名称 |
| `record_id` | `VARCHAR(128) NOT NULL` | 父记录标识 |
| `path` | `VARCHAR(512) NOT NULL` | 菜单路径或扩展属性路径 |
| `ordinal` | `INT NOT NULL DEFAULT 0` | 属性序号 |
| `value_type` | `VARCHAR(16) NOT NULL` | 属性值类型 |
| `value_text` | `TEXT NULL` | 文本属性值 |
| `value_number` | `DECIMAL(20,6) NULL` | 数值属性值 |
| `value_bool` | `TINYINT(1) NULL` | 布尔属性值 |
| `value_time` | `VARCHAR(64) NULL` | 时间属性值 |

## lxm_config

**表描述：** 系统配置项

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `configKey` | `VARCHAR(255) NULL` | 字段：config Key |
| `valueText` | `TEXT NULL` | 字段：value Text |
| `valueNumber` | `DECIMAL(20,6) NULL` | 字段：value Number |
| `valueBool` | `TINYINT(1) NULL` | 字段：value Bool |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_distributors

**表描述：** 分销商账号与组织信息

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `contact` | `VARCHAR(255) NULL` | 字段：contact |
| `phone` | `VARCHAR(255) NULL` | 联系电话 |
| `email` | `VARCHAR(255) NULL` | 电子邮箱 |
| `account` | `VARCHAR(255) NULL` | 登录账号 |
| `role` | `VARCHAR(255) NULL` | 角色 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `city` | `VARCHAR(255) NULL` | 城市名称 |
| `cityId` | `VARCHAR(255) NULL` | 城市标识 |
| `agentId` | `VARCHAR(255) NULL` | 代理人标识 |
| `distributorId` | `VARCHAR(255) NULL` | 分销商标识 |
| `commissionRate` | `DECIMAL(20,6) NULL` | 字段：commission Rate |
| `settlementCycle` | `VARCHAR(255) NULL` | 字段：settlement Cycle |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_financeSettings

**表描述：** 财务结算配置

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `settlementObservationDays` | `INT NULL` | 字段：settlement Observation Days |
| `largeSettlementThreshold` | `DECIMAL(18,2) NULL` | 字段：large Settlement Threshold |
| `currency` | `VARCHAR(255) NULL` | 字段：currency |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_guides

**表描述：** 旅拍攻略

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `title` | `VARCHAR(255) NULL` | 标题 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `intro` | `TEXT NULL` | 简介 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `tag` | `VARCHAR(255) NULL` | 标签 |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `seriesId` | `VARCHAR(255) NULL` | 系列标识 |
| `targetPackageId` | `VARCHAR(255) NULL` | 字段：target Package Id |
| `isHot` | `TINYINT(1) NULL` | 是否热门 |
| `readCount` | `INT NULL` | 阅读次数 |
| `score` | `DECIMAL(20,6) NULL` | 评分 |
| `cover` | `TEXT NULL` | 封面地址 |
| `image` | `TEXT NULL` | 图片地址 |
| `coverUrl` | `TEXT NULL` | 封面地址 |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_homeConfig

**表描述：** 小程序首页配置

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `activity` | `VARCHAR(255) NULL` | 字段：activity |
| `cityName` | `VARCHAR(255) NULL` | 字段：city Name |
| `shopServiceText` | `VARCHAR(255) NULL` | 字段：shop Service Text |
| `heroSubtitle` | `TEXT NULL` | 字段：hero Subtitle |
| `trustOrders` | `INT NULL` | 字段：trust Orders |
| `trustRate` | `VARCHAR(255) NULL` | 字段：trust Rate |
| `notice` | `TEXT NULL` | 字段：notice |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_home_banners

**表描述：** 首页与页面横幅

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `banner_group` | `VARCHAR(32) NOT NULL` | 横幅分组 |
| `banner_no` | `INT NOT NULL` | 横幅序号 |
| `banner_id` | `VARCHAR(128) NULL` | 横幅标识 |
| `type` | `VARCHAR(32) NULL` | 记录类型 |
| `url` | `TEXT NULL` | 资源地址 |
| `cover` | `TEXT NULL` | 封面地址 |
| `title` | `VARCHAR(255) NULL` | 标题 |
| `target_type` | `VARCHAR(128) NULL` | 目标类型 |
| `target_id` | `VARCHAR(128) NULL` | 目标标识 |
| `link_url` | `TEXT NULL` | 跳转链接 |
| `effective_time` | `VARCHAR(64) NULL` | 生效时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_home_ids

**表描述：** 首页配置引用项

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `group_key` | `VARCHAR(128) NOT NULL` | 配置分组键 |
| `item_id` | `VARCHAR(128) NOT NULL` | 商品或关联项标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_home_modules

**表描述：** 首页模块配置

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `module_key` | `VARCHAR(128) NOT NULL` | 模块业务键 |
| `title` | `VARCHAR(255) NULL` | 标题 |
| `subtitle` | `VARCHAR(255) NULL` | 副标题 |
| `more_text` | `VARCHAR(255) NULL` | 字段：more text |
| `enabled` | `TINYINT(1) NULL` | 是否启用 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `sort_no` | `INT NULL` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_home_page_links

**表描述：** 页面推荐链接

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `page_key` | `VARCHAR(128) NOT NULL` | 字段：page key |
| `link_type` | `VARCHAR(64) NOT NULL` | 链接类型 |
| `item_id` | `VARCHAR(128) NOT NULL` | 商品或关联项标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_home_page_modules

**表描述：** 页面模块配置

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `page_key` | `VARCHAR(128) NOT NULL` | 字段：page key |
| `module_key` | `VARCHAR(128) NOT NULL` | 模块业务键 |
| `title` | `VARCHAR(255) NULL` | 标题 |
| `enabled` | `TINYINT(1) NULL` | 是否启用 |
| `sort_no` | `INT NULL` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_home_quick_nav

**表描述：** 首页快捷导航

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `nav_no` | `INT NOT NULL` | 导航序号 |
| `target_type` | `VARCHAR(128) NULL` | 目标类型 |
| `label` | `VARCHAR(255) NULL` | 字段：label |
| `icon` | `VARCHAR(255) NULL` | 菜单图标 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_log_order_exception_snapshots

**表描述：** 订单异常审计快照

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `log_id` | `VARCHAR(128) NOT NULL` | 审计日志标识 |
| `before_status` | `VARCHAR(64) NULL` | 字段：before status |
| `after_status` | `VARCHAR(64) NULL` | 字段：after status |
| `before_customer_status` | `VARCHAR(64) NULL` | 字段：before customer status |
| `after_customer_status` | `VARCHAR(64) NULL` | 字段：after customer status |
| `before_source_type` | `VARCHAR(64) NULL` | 字段：before source type |
| `after_source_type` | `VARCHAR(64) NULL` | 字段：after source type |
| `before_shop_id` | `VARCHAR(128) NULL` | 字段：before shop id |
| `after_shop_id` | `VARCHAR(128) NULL` | 字段：after shop id |
| `before_distributor_id` | `VARCHAR(128) NULL` | 字段：before distributor id |
| `after_distributor_id` | `VARCHAR(128) NULL` | 字段：after distributor id |
| `before_risk_blocked` | `TINYINT(1) NULL` | 字段：before risk blocked |
| `after_risk_blocked` | `TINYINT(1) NULL` | 字段：after risk blocked |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_logs

**表描述：** 后台审计日志

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `time` | `VARCHAR(64) NULL` | 发生时间 |
| `user` | `VARCHAR(255) NULL` | 字段：user |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operatorId` | `VARCHAR(255) NULL` | 操作人标识 |
| `action` | `VARCHAR(255) NULL` | 操作动作 |
| `target` | `VARCHAR(255) NULL` | 字段：target |
| `targetType` | `VARCHAR(255) NULL` | 字段：target Type |
| `targetId` | `VARCHAR(255) NULL` | 字段：target Id |
| `detail` | `TEXT NULL` | 字段：detail |
| `module` | `VARCHAR(255) NULL` | 字段：module |
| `level` | `VARCHAR(255) NULL` | 字段：level |
| `amount` | `VARCHAR(255) NULL` | 金额 |
| `objectType` | `VARCHAR(255) NULL` | 字段：object Type |
| `objectName` | `VARCHAR(255) NULL` | 字段：object Name |
| `snapshotText` | `VARCHAR(500) NULL` | 字段：snapshot Text |
| `source` | `VARCHAR(255) NULL` | 字段：source |
| `createTime` | `VARCHAR(64) NULL` | 创建时间 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_mediaFiles

**表描述：** 文件上传与媒体资产登记

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `purpose` | `VARCHAR(64) NULL` | 字段：purpose |
| `status` | `VARCHAR(64) NULL` | 业务状态 |
| `visibility` | `VARCHAR(64) NULL` | 字段：visibility |
| `ownerKind` | `VARCHAR(64) NULL` | 字段：owner Kind |
| `ownerId` | `VARCHAR(128) NULL` | 字段：owner Id |
| `collection` | `VARCHAR(128) NULL` | 字段：collection |
| `recordId` | `VARCHAR(128) NULL` | 字段：record Id |
| `orderId` | `VARCHAR(128) NULL` | 订单标识 |
| `bucket` | `VARCHAR(128) NULL` | 字段：bucket |
| `region` | `VARCHAR(128) NULL` | 字段：region |
| `extension` | `VARCHAR(128) NULL` | 字段：extension |
| `etag` | `VARCHAR(128) NULL` | 字段：etag |
| `sha256` | `VARCHAR(128) NULL` | 字段：sha256 |
| `migrationRunId` | `VARCHAR(128) NULL` | 字段：migration Run Id |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `mimeType` | `VARCHAR(255) NULL` | 字段：mime Type |
| `rejection` | `VARCHAR(255) NULL` | 字段：rejection |
| `objectKey` | `TEXT NULL` | 字段：object Key |
| `size` | `INT NULL` | 字段：size |
| `createTime` | `VARCHAR(64) NULL` | 创建时间 |
| `expiresAt` | `VARCHAR(64) NULL` | 字段：expires At |
| `completedAt` | `VARCHAR(64) NULL` | 完成时间 |
| `boundAt` | `VARCHAR(64) NULL` | 字段：bound At |
| `deletedAt` | `VARCHAR(64) NULL` | 字段：deleted At |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_merchantCodes

**表描述：** 商家入口码

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `shopId` | `VARCHAR(255) NULL` | 门店标识 |
| `shopName` | `VARCHAR(255) NULL` | 字段：shop Name |
| `distributorId` | `VARCHAR(255) NULL` | 分销商标识 |
| `placementType` | `VARCHAR(255) NULL` | 字段：placement Type |
| `placementLabel` | `VARCHAR(255) NULL` | 字段：placement Label |
| `scene` | `VARCHAR(255) NULL` | 字段：scene |
| `scanCount` | `INT NULL` | 字段：scan Count |
| `orderCount` | `INT NULL` | 字段：order Count |
| `dealCount` | `INT NULL` | 字段：deal Count |
| `qrImage` | `TEXT NULL` | 字段：qr Image |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `createTime` | `VARCHAR(64) NULL` | 创建时间 |
| `lastScanTime` | `VARCHAR(64) NULL` | 字段：last Scan Time |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_monthlyClosings

**表描述：** 月度结账记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `month` | `VARCHAR(255) NULL` | 字段：month |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operatorId` | `VARCHAR(255) NULL` | 操作人标识 |
| `time` | `VARCHAR(64) NULL` | 发生时间 |
| `note` | `TEXT NULL` | 备注 |
| `unlockedBy` | `VARCHAR(255) NULL` | 字段：unlocked By |
| `unlockedAt` | `VARCHAR(64) NULL` | 字段：unlocked At |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_addons

**表描述：** 订单增值服务明细

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `item_no` | `INT NOT NULL` | 明细序号 |
| `addon_id` | `VARCHAR(128) NULL` | 增值服务标识 |
| `addon_type` | `VARCHAR(64) NULL` | 增值服务类型 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `quantity` | `DECIMAL(12,3) NULL` | 数量 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_contacts

**表描述：** 订单联系人列表

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `contact_no` | `INT NOT NULL` | 联系人序号 |
| `phone` | `VARCHAR(64) NULL` | 联系电话 |
| `wechat` | `VARCHAR(255) NULL` | 字段：wechat |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_follow_records

**表描述：** 订单跟进记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `record_no` | `INT NOT NULL` | 记录序号 |
| `type` | `VARCHAR(64) NULL` | 记录类型 |
| `action` | `TEXT NULL` | 操作动作 |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operator_id` | `VARCHAR(128) NULL` | 操作人标识 |
| `note` | `TEXT NULL` | 备注 |
| `reason` | `TEXT NULL` | 原因说明 |
| `from_status` | `VARCHAR(64) NULL` | 原状态 |
| `to_status` | `VARCHAR(64) NULL` | 目标状态 |
| `create_time` | `VARCHAR(64) NULL` | 字段：create time |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_package_snapshot

**表描述：** 订单套餐快照

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `snapshot_id` | `VARCHAR(128) NULL` | 快照标识 |
| `package_id` | `VARCHAR(128) NULL` | 套餐标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `original_price` | `DECIMAL(18,2) NULL` | 字段：original price |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `is_main_push` | `TINYINT(1) NULL` | 字段：is main push |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_package_snapshot_tags

**表描述：** 订单套餐标签快照

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `tag_no` | `INT NOT NULL` | 标签序号 |
| `tag` | `VARCHAR(255) NOT NULL` | 标签 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_payment_records

**表描述：** 订单支付记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `record_no` | `INT NOT NULL` | 记录序号 |
| `payment_id` | `VARCHAR(128) NULL` | 支付记录标识 |
| `phase` | `VARCHAR(32) NULL` | 支付阶段 |
| `payment_type` | `VARCHAR(64) NULL` | 字段：payment type |
| `amount` | `DECIMAL(18,2) NULL` | 金额 |
| `status` | `VARCHAR(64) NULL` | 业务状态 |
| `attempt` | `INT NULL` | 支付尝试次数 |
| `provider` | `VARCHAR(64) NULL` | 支付服务商 |
| `idempotency_key` | `VARCHAR(128) NULL` | 支付幂等键 |
| `confirmation_idempotency_key` | `VARCHAR(128) NULL` | 支付确认幂等键 |
| `out_trade_no` | `VARCHAR(32) NULL` | 微信支付商户订单号 |
| `prepay_id` | `VARCHAR(128) NULL` | 预支付交易标识 |
| `trade_state` | `VARCHAR(32) NULL` | 第三方交易状态 |
| `prepay_created_at` | `VARCHAR(64) NULL` | 字段：prepay created at |
| `failure_reason` | `VARCHAR(64) NULL` | 失败原因 |
| `external_transaction_id` | `VARCHAR(160) NULL` | 第三方支付交易号 |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operator_id` | `VARCHAR(128) NULL` | 操作人标识 |
| `paid_at` | `VARCHAR(64) NULL` | 支付完成时间 |
| `record_created_at` | `VARCHAR(64) NULL` | 字段：record created at |
| `record_updated_at` | `VARCHAR(64) NULL` | 字段：record updated at |
| `admin_registered_at` | `VARCHAR(64) NULL` | 字段：admin registered at |
| `note` | `TEXT NULL` | 备注 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_product_snapshot_tags

**表描述：** 订单商品标签快照

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `item_no` | `INT NOT NULL` | 明细序号 |
| `tag_no` | `INT NOT NULL` | 标签序号 |
| `tag` | `VARCHAR(255) NOT NULL` | 标签 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_product_snapshots

**表描述：** 订单商品快照

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `item_no` | `INT NOT NULL` | 明细序号 |
| `snapshot_id` | `VARCHAR(128) NULL` | 快照标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `original_price` | `DECIMAL(18,2) NULL` | 字段：original price |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `is_main_push` | `TINYINT(1) NULL` | 字段：is main push |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_products

**表描述：** 订单商品明细

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `item_no` | `INT NOT NULL` | 明细序号 |
| `product_id` | `VARCHAR(128) NULL` | 字段：product id |
| `product_type` | `VARCHAR(64) NULL` | 字段：product type |
| `package_id` | `VARCHAR(128) NULL` | 套餐标识 |
| `peripheral_id` | `VARCHAR(128) NULL` | 周边商品标识 |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `quantity` | `DECIMAL(12,3) NULL` | 数量 |
| `spot_id` | `VARCHAR(128) NULL` | 打卡点标识 |
| `series_id` | `VARCHAR(128) NULL` | 系列标识 |
| `album_id` | `VARCHAR(128) NULL` | 照片商品标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_source

**表描述：** 订单来源归因

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `shop_id` | `VARCHAR(128) NULL` | 门店标识 |
| `distributor_id` | `VARCHAR(128) NULL` | 分销商标识 |
| `scene` | `VARCHAR(255) NULL` | 字段：scene |
| `source_type` | `VARCHAR(64) NULL` | 字段：source type |
| `channel` | `VARCHAR(64) NULL` | 字段：channel |
| `code_id` | `VARCHAR(128) NULL` | 字段：code id |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_order_status_logs

**表描述：** 订单状态流转日志

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `order_id` | `VARCHAR(128) NOT NULL` | 订单标识 |
| `log_no` | `INT NOT NULL` | 日志序号 |
| `time` | `VARCHAR(64) NULL` | 发生时间 |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operator_id` | `VARCHAR(128) NULL` | 操作人标识 |
| `action` | `TEXT NULL` | 操作动作 |
| `type` | `VARCHAR(64) NULL` | 记录类型 |
| `from_status` | `VARCHAR(64) NULL` | 原状态 |
| `to_status` | `VARCHAR(64) NULL` | 目标状态 |
| `create_time` | `VARCHAR(64) NULL` | 字段：create time |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_orders

**表描述：** 客户预约订单

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `orderNo` | `VARCHAR(255) NULL` | 订单号 |
| `bookingIdempotencyKey` | `VARCHAR(128) NULL` | 预约幂等键 |
| `openid` | `VARCHAR(255) NULL` | 微信用户唯一标识 |
| `_openid` | `VARCHAR(255) NULL` | 兼容旧字段的微信用户标识 |
| `customer` | `TEXT NULL` | 字段：customer |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `contactName` | `VARCHAR(255) NULL` | 字段：contact Name |
| `phone` | `VARCHAR(255) NULL` | 联系电话 |
| `contactPhone` | `VARCHAR(255) NULL` | 联系人电话 |
| `customerPhone` | `VARCHAR(255) NULL` | 客户电话 |
| `wechat` | `VARCHAR(255) NULL` | 字段：wechat |
| `contactWechat` | `VARCHAR(255) NULL` | 字段：contact Wechat |
| `customerWechat` | `VARCHAR(255) NULL` | 字段：customer Wechat |
| `shopId` | `VARCHAR(255) NULL` | 门店标识 |
| `shopCode` | `VARCHAR(255) NULL` | 门店编码 |
| `distributorId` | `VARCHAR(255) NULL` | 分销商标识 |
| `sourceType` | `VARCHAR(255) NULL` | 来源类型 |
| `sourceName` | `VARCHAR(255) NULL` | 来源名称 |
| `sourceScene` | `VARCHAR(255) NULL` | 来源场景 |
| `sourceChannel` | `VARCHAR(255) NULL` | 来源渠道 |
| `sourceCodeId` | `VARCHAR(255) NULL` | 来源入口码标识 |
| `scene` | `VARCHAR(255) NULL` | 字段：scene |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `spotName` | `VARCHAR(255) NULL` | 打卡点名称 |
| `seriesId` | `VARCHAR(255) NULL` | 系列标识 |
| `seriesName` | `VARCHAR(255) NULL` | 系列名称 |
| `packageId` | `VARCHAR(255) NULL` | 套餐标识 |
| `packageName` | `VARCHAR(255) NULL` | 套餐名称 |
| `date` | `VARCHAR(255) NULL` | 字段：date |
| `appointmentAt` | `VARCHAR(64) NULL` | 预约时间 |
| `bookingDate` | `VARCHAR(255) NULL` | 预约日期 |
| `bookingTime` | `VARCHAR(255) NULL` | 预约时段 |
| `timePeriod` | `VARCHAR(255) NULL` | 时间段 |
| `timeSlot` | `VARCHAR(255) NULL` | 时间槽 |
| `time` | `VARCHAR(255) NULL` | 发生时间 |
| `message` | `TEXT NULL` | 消息内容 |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `totalPrice` | `DECIMAL(18,2) NULL` | 订单原价总额 |
| `totalAmount` | `DECIMAL(18,2) NULL` | 订单应收总额 |
| `depositRatio` | `DECIMAL(20,6) NULL` | 定金比例 |
| `depositDue` | `DECIMAL(18,2) NULL` | 定金应收金额 |
| `finalDue` | `DECIMAL(18,2) NULL` | 尾款应收金额 |
| `depositPaid` | `DECIMAL(18,2) NULL` | 已收定金 |
| `depositPaidAt` | `VARCHAR(64) NULL` | 字段：deposit Paid At |
| `depositConfirmedAt` | `VARCHAR(64) NULL` | 字段：deposit Confirmed At |
| `depositConfirmedBy` | `VARCHAR(128) NULL` | 字段：deposit Confirmed By |
| `finalPaid` | `DECIMAL(18,2) NULL` | 已收尾款 |
| `finalPaidAt` | `VARCHAR(64) NULL` | 字段：final Paid At |
| `finalConfirmedAt` | `VARCHAR(64) NULL` | 字段：final Confirmed At |
| `finalConfirmedBy` | `VARCHAR(128) NULL` | 字段：final Confirmed By |
| `finalDiscountAmount` | `DECIMAL(18,2) NULL` | 字段：final Discount Amount |
| `finalDiscountReason` | `TEXT NULL` | 字段：final Discount Reason |
| `priceAdjustReason` | `TEXT NULL` | 字段：price Adjust Reason |
| `bookingMode` | `VARCHAR(255) NULL` | 字段：booking Mode |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `customerStatus` | `VARCHAR(255) NULL` | 客户侧状态 |
| `workflowStage` | `VARCHAR(64) NULL` | 履约阶段 |
| `dispatchStatus` | `VARCHAR(64) NULL` | 派单状态 |
| `depositRefundable` | `TINYINT(1) NULL` | 字段：deposit Refundable |
| `depositRefundableAt` | `VARCHAR(64) NULL` | 字段：deposit Refundable At |
| `assigneeId` | `VARCHAR(255) NULL` | 客服负责人标识 |
| `serviceUser` | `VARCHAR(255) NULL` | 字段：service User |
| `serviceUserId` | `VARCHAR(255) NULL` | 字段：service User Id |
| `photographer` | `VARCHAR(255) NULL` | 字段：photographer |
| `photographerId` | `VARCHAR(255) NULL` | 摄影师标识 |
| `photographerCommissionRate` | `DECIMAL(20,6) NULL` | 字段：photographer Commission Rate |
| `completedAt` | `VARCHAR(64) NULL` | 完成时间 |
| `deliveredAt` | `VARCHAR(64) NULL` | 交付时间 |
| `deliveredBy` | `VARCHAR(128) NULL` | 字段：delivered By |
| `deliveryMethod` | `VARCHAR(64) NULL` | 交付方式 |
| `finishedAt` | `VARCHAR(64) NULL` | 字段：finished At |
| `completedTime` | `VARCHAR(64) NULL` | 字段：completed Time |
| `serviceNote` | `TEXT NULL` | 服务备注 |
| `deliveryNote` | `TEXT NULL` | 交付备注 |
| `customerRemark` | `TEXT NULL` | 客户备注 |
| `internalNote` | `TEXT NULL` | 内部备注 |
| `paymentVerify` | `VARCHAR(255) NULL` | 字段：payment Verify |
| `depositFinanceStatus` | `VARCHAR(255) NULL` | 字段：deposit Finance Status |
| `finalFinanceStatus` | `VARCHAR(255) NULL` | 字段：final Finance Status |
| `depositPaymentStatus` | `VARCHAR(64) NULL` | 字段：deposit Payment Status |
| `finalPaymentStatus` | `VARCHAR(64) NULL` | 字段：final Payment Status |
| `financeStatus` | `VARCHAR(255) NULL` | 财务审核状态 |
| `refundAmount` | `DECIMAL(18,2) NULL` | 退款金额 |
| `refundConfirmed` | `TINYINT(1) NULL` | 字段：refund Confirmed |
| `afterSaleStatus` | `VARCHAR(255) NULL` | 字段：after Sale Status |
| `afterSaleReason` | `TEXT NULL` | 字段：after Sale Reason |
| `afterSaleCreateTime` | `VARCHAR(64) NULL` | 字段：after Sale Create Time |
| `afterSaleId` | `VARCHAR(255) NULL` | 字段：after Sale Id |
| `riskBlocked` | `TINYINT(1) NULL` | 字段：risk Blocked |
| `riskFlag` | `VARCHAR(255) NULL` | 字段：risk Flag |
| `frozen` | `TINYINT(1) NULL` | 字段：frozen |
| `freezeReason` | `TEXT NULL` | 字段：freeze Reason |
| `riskReason` | `TEXT NULL` | 字段：risk Reason |
| `settlementObservationReleased` | `TINYINT(1) NULL` | 字段：settlement Observation Released |
| `settlementObservationReleasedAt` | `VARCHAR(64) NULL` | 字段：settlement Observation Released At |
| `settlementObservationReleasedBy` | `VARCHAR(255) NULL` | 字段：settlement Observation Released By |
| `createdBy` | `VARCHAR(255) NULL` | 字段：created By |
| `createdById` | `VARCHAR(255) NULL` | 字段：created By Id |
| `createTime` | `VARCHAR(64) NULL` | 创建时间 |
| `updateTime` | `VARCHAR(64) NULL` | 更新时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_package_exclusions

**表描述：** 套餐互斥关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `package_id` | `VARCHAR(128) NOT NULL` | 套餐标识 |
| `excluded_package_id` | `VARCHAR(128) NOT NULL` | 字段：excluded package id |
| `relation_type` | `VARCHAR(32) NOT NULL` | 字段：relation type |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_package_included_items

**表描述：** 套餐包含商品快照

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `package_id` | `VARCHAR(128) NOT NULL` | 套餐标识 |
| `item_no` | `INT NOT NULL` | 明细序号 |
| `item_type` | `VARCHAR(32) NULL` | 明细类型 |
| `item_name` | `VARCHAR(255) NULL` | 明细名称 |
| `item_price` | `DECIMAL(18,2) NULL` | 明细价格 |
| `target_page` | `VARCHAR(128) NULL` | 目标页面 |
| `target_product_id` | `VARCHAR(128) NULL` | 目标商品标识 |
| `target_series_id` | `VARCHAR(128) NULL` | 目标系列标识 |
| `target_album_id` | `VARCHAR(128) NULL` | 目标照片商品标识 |
| `target_spot_id` | `VARCHAR(128) NULL` | 目标打卡点标识 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_package_spots

**表描述：** 套餐与打卡点关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `package_id` | `VARCHAR(128) NOT NULL` | 套餐标识 |
| `spot_id` | `VARCHAR(128) NOT NULL` | 打卡点标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_package_tags

**表描述：** 套餐标签关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `package_id` | `VARCHAR(128) NOT NULL` | 套餐标识 |
| `tag_type` | `VARCHAR(32) NOT NULL` | 标签类型 |
| `tag` | `VARCHAR(255) NOT NULL` | 标签 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_packages

**表描述：** 旅拍套餐与视频商品

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `seriesId` | `VARCHAR(255) NULL` | 系列标识 |
| `albumId` | `VARCHAR(255) NULL` | 照片商品标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `title` | `VARCHAR(255) NULL` | 标题 |
| `type` | `VARCHAR(255) NULL` | 记录类型 |
| `productKind` | `VARCHAR(255) NULL` | 字段：product Kind |
| `serviceType` | `VARCHAR(255) NULL` | 字段：service Type |
| `originalPrice` | `DECIMAL(18,2) NULL` | 原价 |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `specialPrice` | `DECIMAL(18,2) NULL` | 字段：special Price |
| `weekdayPrice` | `DECIMAL(18,2) NULL` | 字段：weekday Price |
| `weekendSurcharge` | `DECIMAL(18,2) NULL` | 字段：weekend Surcharge |
| `holidaySurcharge` | `DECIMAL(18,2) NULL` | 字段：holiday Surcharge |
| `aerialExtraPrice` | `DECIMAL(18,2) NULL` | 字段：aerial Extra Price |
| `depositRatio` | `DECIMAL(20,6) NULL` | 定金比例 |
| `duration` | `INT NULL` | 服务时长 |
| `durationText` | `VARCHAR(255) NULL` | 服务时长文案 |
| `retouchCount` | `INT NULL` | 字段：retouch Count |
| `videoDuration` | `INT NULL` | 视频时长 |
| `finishedVideoCount` | `INT NULL` | 字段：finished Video Count |
| `hasAerial` | `TINYINT(1) NULL` | 字段：has Aerial |
| `fullEdit` | `TINYINT(1) NULL` | 字段：full Edit |
| `deliveryCycle` | `VARCHAR(255) NULL` | 交付周期 |
| `hotScore` | `DECIMAL(20,6) NULL` | 热度分 |
| `isHot` | `TINYINT(1) NULL` | 是否热门 |
| `isMainPush` | `TINYINT(1) NULL` | 是否主推 |
| `mainPush` | `TINYINT(1) NULL` | 字段：main Push |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `intro` | `TEXT NULL` | 简介 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `cover` | `TEXT NULL` | 封面地址 |
| `videoUrl` | `TEXT NULL` | 字段：video Url |
| `previewVideoUrl` | `TEXT NULL` | 字段：preview Video Url |
| `isVideoSingle` | `TINYINT(1) NULL` | 字段：is Video Single |
| `bookingLimit` | `INT NULL` | 字段：booking Limit |
| `advanceBookingDays` | `INT NULL` | 字段：advance Booking Days |
| `holidayQuota` | `INT NULL` | 字段：holiday Quota |
| `timeSlotLimit` | `INT NULL` | 字段：time Slot Limit |
| `scheduledOnAt` | `VARCHAR(64) NULL` | 字段：scheduled On At |
| `scheduledOffAt` | `VARCHAR(64) NULL` | 字段：scheduled Off At |
| `auditStatus` | `VARCHAR(255) NULL` | 字段：audit Status |
| `auditType` | `VARCHAR(255) NULL` | 字段：audit Type |
| `auditSubmitAt` | `VARCHAR(64) NULL` | 字段：audit Submit At |
| `auditSubmitter` | `VARCHAR(255) NULL` | 字段：audit Submitter |
| `auditReviewer` | `VARCHAR(255) NULL` | 字段：audit Reviewer |
| `auditReviewedAt` | `VARCHAR(64) NULL` | 字段：audit Reviewed At |
| `auditRejectReason` | `TEXT NULL` | 字段：audit Reject Reason |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_peripheral_images

**表描述：** 周边商品图片

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `peripheral_id` | `VARCHAR(128) NOT NULL` | 周边商品标识 |
| `image_no` | `INT NOT NULL` | 图片序号 |
| `image_url` | `TEXT NULL` | 图片地址 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_peripheral_specs

**表描述：** 周边商品规格

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `peripheral_id` | `VARCHAR(128) NOT NULL` | 周边商品标识 |
| `spec_no` | `INT NOT NULL` | 规格序号 |
| `spec_text` | `VARCHAR(255) NOT NULL` | 规格文本 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_peripheral_spots

**表描述：** 周边商品与打卡点关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `peripheral_id` | `VARCHAR(128) NOT NULL` | 周边商品标识 |
| `spot_id` | `VARCHAR(128) NOT NULL` | 打卡点标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_peripherals

**表描述：** 影像周边商品

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `category` | `VARCHAR(255) NULL` | 分类 |
| `cate` | `VARCHAR(255) NULL` | 字段：cate |
| `price` | `DECIMAL(18,2) NULL` | 销售价格 |
| `enabled` | `TINYINT(1) NULL` | 是否启用 |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `intro` | `TEXT NULL` | 简介 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `image` | `TEXT NULL` | 图片地址 |
| `cover` | `TEXT NULL` | 封面地址 |
| `mode` | `VARCHAR(255) NULL` | 字段：mode |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `stock` | `INT NULL` | 库存数量 |
| `stockQty` | `INT NULL` | 库存数量 |
| `isHot` | `TINYINT(1) NULL` | 是否热门 |
| `isNew` | `TINYINT(1) NULL` | 字段：is New |
| `deliveryCycle` | `VARCHAR(255) NULL` | 交付周期 |
| `scheduledOnAt` | `VARCHAR(64) NULL` | 字段：scheduled On At |
| `scheduledOffAt` | `VARCHAR(64) NULL` | 字段：scheduled Off At |
| `auditStatus` | `VARCHAR(255) NULL` | 字段：audit Status |
| `auditType` | `VARCHAR(255) NULL` | 字段：audit Type |
| `auditSubmitAt` | `VARCHAR(64) NULL` | 字段：audit Submit At |
| `auditSubmitter` | `VARCHAR(255) NULL` | 字段：audit Submitter |
| `auditReviewer` | `VARCHAR(255) NULL` | 字段：audit Reviewer |
| `auditReviewedAt` | `VARCHAR(64) NULL` | 字段：audit Reviewed At |
| `auditRejectReason` | `TEXT NULL` | 字段：audit Reject Reason |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_reconciliationTransfers

**表描述：** 财务对账划拨记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `key` | `VARCHAR(255) NULL` | 字段：key |
| `month` | `VARCHAR(255) NULL` | 字段：month |
| `period` | `VARCHAR(255) NULL` | 字段：period |
| `settlementCycle` | `VARCHAR(255) NULL` | 字段：settlement Cycle |
| `objectType` | `VARCHAR(255) NULL` | 字段：object Type |
| `objectId` | `VARCHAR(255) NULL` | 字段：object Id |
| `objectName` | `VARCHAR(255) NULL` | 字段：object Name |
| `amount` | `DECIMAL(18,2) NULL` | 金额 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operatorId` | `VARCHAR(255) NULL` | 操作人标识 |
| `time` | `VARCHAR(64) NULL` | 发生时间 |
| `method` | `VARCHAR(255) NULL` | 字段：method |
| `voucherNo` | `VARCHAR(255) NULL` | 字段：voucher No |
| `note` | `TEXT NULL` | 备注 |
| `payStatus` | `VARCHAR(255) NULL` | 字段：pay Status |
| `paidBy` | `VARCHAR(255) NULL` | 字段：paid By |
| `paidAt` | `VARCHAR(64) NULL` | 字段：paid At |
| `sealedBy` | `VARCHAR(255) NULL` | 字段：sealed By |
| `sealedAt` | `VARCHAR(64) NULL` | 字段：sealed At |
| `sealNote` | `TEXT NULL` | 字段：seal Note |
| `unsealedBy` | `VARCHAR(255) NULL` | 字段：unsealed By |
| `unsealedAt` | `VARCHAR(64) NULL` | 字段：unsealed At |
| `unsealNote` | `TEXT NULL` | 字段：unseal Note |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_reconciliation_transfer_orders

**表描述：** 对账划拨订单关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `transfer_id` | `VARCHAR(128) NOT NULL` | 对账划拨标识 |
| `order_no` | `INT NOT NULL` | 字段：order no |
| `order_id` | `VARCHAR(128) NULL` | 订单标识 |
| `order_number` | `VARCHAR(128) NULL` | 字段：order number |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_samples

**表描述：** 照片与视频样片

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `type` | `VARCHAR(255) NULL` | 记录类型 |
| `mediaType` | `VARCHAR(255) NULL` | 字段：media Type |
| `albumId` | `VARCHAR(255) NULL` | 照片商品标识 |
| `seriesId` | `VARCHAR(255) NULL` | 系列标识 |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `isShowcase` | `TINYINT(1) NULL` | 字段：is Showcase |
| `isFeatured` | `TINYINT(1) NULL` | 是否精选 |
| `isRecommend` | `TINYINT(1) NULL` | 是否推荐 |
| `url` | `TEXT NULL` | 资源地址 |
| `image` | `TEXT NULL` | 图片地址 |
| `cover` | `TEXT NULL` | 封面地址 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_scans

**表描述：** 商家码扫码记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `date` | `VARCHAR(255) NULL` | 字段：date |
| `hour` | `INT NULL` | 字段：hour |
| `shopId` | `VARCHAR(255) NULL` | 门店标识 |
| `distributorId` | `VARCHAR(255) NULL` | 分销商标识 |
| `sourceType` | `VARCHAR(255) NULL` | 来源类型 |
| `sourceName` | `VARCHAR(255) NULL` | 来源名称 |
| `scene` | `VARCHAR(255) NULL` | 字段：scene |
| `openid` | `VARCHAR(255) NULL` | 微信用户唯一标识 |
| `orderId` | `VARCHAR(255) NULL` | 订单标识 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_schema_version

**表描述：** 数据库规范化版本记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `version` | `INT` | 字段：version |
| `applied_at` | `DATETIME(3)` | 版本应用时间 |

## lxm_series

**表描述：** 旅拍内容系列

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `intro` | `TEXT NULL` | 简介 |
| `style` | `VARCHAR(255) NULL` | 字段：style |
| `productType` | `VARCHAR(255) NULL` | 商品类型 |
| `soldCount` | `INT NULL` | 售出数量 |
| `minPrice` | `DECIMAL(18,2) NULL` | 字段：min Price |
| `maxPrice` | `DECIMAL(18,2) NULL` | 字段：max Price |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `isHot` | `TINYINT(1) NULL` | 是否热门 |
| `cover` | `TEXT NULL` | 封面地址 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_series_spots

**表描述：** 系列与打卡点关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `series_id` | `VARCHAR(128) NOT NULL` | 系列标识 |
| `spot_id` | `VARCHAR(128) NOT NULL` | 打卡点标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_shop_agents

**表描述：** 门店与代理人关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `shop_id` | `VARCHAR(128) NOT NULL` | 门店标识 |
| `agent_id` | `VARCHAR(128) NOT NULL` | 代理人标识 |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_shop_distributors

**表描述：** 门店与分销商关系

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `shop_id` | `VARCHAR(128) NOT NULL` | 门店标识 |
| `distributor_id` | `VARCHAR(128) NOT NULL` | 分销商标识 |
| `rate` | `DECIMAL(7,4) NULL` | 字段：rate |
| `sort_no` | `INT NOT NULL DEFAULT 0` | 关系排序号 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_shops

**表描述：** 门店与商家配置

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `logo` | `TEXT NULL` | 字段：logo |
| `city` | `VARCHAR(255) NULL` | 城市名称 |
| `cityId` | `VARCHAR(255) NULL` | 城市标识 |
| `district` | `VARCHAR(255) NULL` | 行政区域 |
| `shopId` | `VARCHAR(255) NULL` | 门店标识 |
| `shopCode` | `VARCHAR(255) NULL` | 门店编码 |
| `scene` | `VARCHAR(255) NULL` | 字段：scene |
| `qrPosition` | `VARCHAR(255) NULL` | 字段：qr Position |
| `commissionRate` | `DECIMAL(20,6) NULL` | 字段：commission Rate |
| `shareRatio` | `DECIMAL(20,6) NULL` | 字段：share Ratio |
| `settlementCycle` | `VARCHAR(255) NULL` | 字段：settlement Cycle |
| `account` | `VARCHAR(255) NULL` | 登录账号 |
| `contact` | `VARCHAR(255) NULL` | 字段：contact |
| `phone` | `VARCHAR(255) NULL` | 联系电话 |
| `email` | `VARCHAR(255) NULL` | 电子邮箱 |
| `address` | `TEXT NULL` | 字段：address |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `agentId` | `VARCHAR(255) NULL` | 代理人标识 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_siteConfig

**表描述：** 小程序站点配置

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `customPrice_baseHours` | `DECIMAL(20,6) NULL` | 字段：custom Price base Hours |
| `customPrice_singlePersonPrice` | `DECIMAL(18,2) NULL` | 字段：custom Price single Person Price |
| `customPrice_perExtraPerson` | `DECIMAL(18,2) NULL` | 字段：custom Price per Extra Person |
| `customPrice_note` | `TEXT NULL` | 字段：custom Price note |
| `privacyText` | `TEXT NULL` | 字段：privacy Text |
| `wechatCorpId` | `VARCHAR(255) NULL` | 字段：wechat Corp Id |
| `wechatAppId` | `VARCHAR(255) NULL` | 字段：wechat App Id |
| `wechatGuideText` | `TEXT NULL` | 字段：wechat Guide Text |
| `footprintEnabled` | `TINYINT(1) NULL` | 字段：footprint Enabled |
| `footprintTotal` | `INT NULL` | 字段：footprint Total |
| `footprintTitle` | `VARCHAR(255) NULL` | 字段：footprint Title |
| `footprintRewardText` | `TEXT NULL` | 字段：footprint Reward Text |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_site_booking_notices

**表描述：** 预约须知条目

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `notice_no` | `INT NOT NULL` | 须知序号 |
| `notice_text` | `TEXT NOT NULL` | 须知内容 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_site_hotwords

**表描述：** 搜索热词

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `config_id` | `VARCHAR(128) NOT NULL` | 配置记录标识 |
| `word_no` | `INT NOT NULL` | 热词序号 |
| `word` | `VARCHAR(255) NOT NULL` | 热词内容 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_spots

**表描述：** 旅拍打卡点

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `city` | `VARCHAR(255) NULL` | 城市名称 |
| `cityId` | `VARCHAR(255) NULL` | 城市标识 |
| `cityCode` | `VARCHAR(255) NULL` | 城市编码 |
| `district` | `VARCHAR(255) NULL` | 行政区域 |
| `tag` | `VARCHAR(255) NULL` | 标签 |
| `hotScore` | `DECIMAL(20,6) NULL` | 热度分 |
| `sort` | `INT NULL` | 展示排序 |
| `intro` | `TEXT NULL` | 简介 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `address` | `TEXT NULL` | 字段：address |
| `checkinCount` | `INT NULL` | 字段：checkin Count |
| `visitCount` | `INT NULL` | 字段：visit Count |
| `image` | `TEXT NULL` | 图片地址 |
| `cover` | `TEXT NULL` | 封面地址 |
| `coverUrl` | `TEXT NULL` | 封面地址 |
| `shopId` | `VARCHAR(255) NULL` | 门店标识 |
| `latitude` | `DECIMAL(20,6) NULL` | 纬度 |
| `longitude` | `DECIMAL(20,6) NULL` | 经度 |
| `coordType` | `VARCHAR(255) NULL` | 坐标系类型 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `enabled` | `TINYINT(1) NULL` | 是否启用 |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_staff

**表描述：** 后台员工账号与组织信息

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `account` | `VARCHAR(255) NULL` | 登录账号 |
| `phone` | `VARCHAR(255) NULL` | 联系电话 |
| `email` | `VARCHAR(255) NULL` | 电子邮箱 |
| `role` | `VARCHAR(255) NULL` | 角色 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `city` | `VARCHAR(255) NULL` | 城市名称 |
| `cityId` | `VARCHAR(255) NULL` | 城市标识 |
| `agentId` | `VARCHAR(255) NULL` | 代理人标识 |
| `distributorId` | `VARCHAR(255) NULL` | 分销商标识 |
| `shopId` | `VARCHAR(255) NULL` | 门店标识 |
| `commissionRate` | `DECIMAL(20,6) NULL` | 字段：commission Rate |
| `settlementCycle` | `VARCHAR(255) NULL` | 字段：settlement Cycle |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_stories

**表描述：** 旅拍故事内容

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `title` | `VARCHAR(255) NULL` | 标题 |
| `subtitle` | `VARCHAR(255) NULL` | 副标题 |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `intro` | `TEXT NULL` | 简介 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `tag` | `VARCHAR(255) NULL` | 标签 |
| `spotId` | `VARCHAR(255) NULL` | 打卡点标识 |
| `seriesId` | `VARCHAR(255) NULL` | 系列标识 |
| `isHot` | `TINYINT(1) NULL` | 是否热门 |
| `readCount` | `INT NULL` | 阅读次数 |
| `score` | `DECIMAL(20,6) NULL` | 评分 |
| `cover` | `TEXT NULL` | 封面地址 |
| `image` | `TEXT NULL` | 图片地址 |
| `isShow` | `TINYINT(1) NULL` | 是否在小程序展示 |
| `visible` | `TINYINT(1) NULL` | 是否可见 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_tagLibrary

**表描述：** 内容标签库

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `category` | `VARCHAR(255) NULL` | 分类 |
| `status` | `VARCHAR(255) NULL` | 业务状态 |
| `sort` | `INT NULL` | 展示排序 |
| `scope` | `VARCHAR(255) NULL` | 字段：scope |
| `color` | `VARCHAR(255) NULL` | 字段：color |
| `description` | `TEXT NULL` | 面向用户的详细描述 |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_trash

**表描述：** 软删除回收站记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `refId` | `VARCHAR(255) NULL` | 字段：ref Id |
| `sourceKey` | `VARCHAR(255) NULL` | 字段：source Key |
| `sourceId` | `VARCHAR(255) NULL` | 字段：source Id |
| `type` | `VARCHAR(255) NULL` | 记录类型 |
| `name` | `VARCHAR(255) NULL` | 名称 |
| `reason` | `TEXT NULL` | 原因说明 |
| `operator` | `VARCHAR(255) NULL` | 操作人名称 |
| `operatorId` | `VARCHAR(255) NULL` | 操作人标识 |
| `time` | `VARCHAR(64) NULL` | 发生时间 |
| `deletedAt` | `VARCHAR(64) NULL` | 字段：deleted At |
| `restorable` | `TINYINT(1) NULL` | 字段：restorable |
| `deleted` | `TINYINT(1) NULL` | 软删除标记 |
| `isDeleted` | `TINYINT(1) NULL` | 是否已删除 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_trash_source_attributes

**表描述：** 回收站来源扩展属性

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `trash_id` | `VARCHAR(128) NOT NULL` | 字段：trash id |
| `path` | `VARCHAR(512) NOT NULL` | 菜单路径或扩展属性路径 |
| `ordinal` | `INT NOT NULL DEFAULT 0` | 属性序号 |
| `value_type` | `VARCHAR(16) NOT NULL` | 属性值类型 |
| `value_text` | `TEXT NULL` | 文本属性值 |
| `value_number` | `DECIMAL(20,6) NULL` | 数值属性值 |
| `value_bool` | `TINYINT(1) NULL` | 布尔属性值 |
| `value_time` | `VARCHAR(64) NULL` | 时间属性值 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_userProfiles

**表描述：** 小程序用户资料

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | `VARCHAR(128) NOT NULL` | 记录唯一标识 |
| `openid` | `VARCHAR(255) NULL` | 微信用户唯一标识 |
| `unionid` | `VARCHAR(255) NULL` | 字段：unionid |
| `phone` | `VARCHAR(255) NULL` | 联系电话 |
| `dev` | `TINYINT(1) NULL` | 字段：dev |
| `nickname` | `VARCHAR(255) NULL` | 字段：nickname |
| `avatarUrl` | `TEXT NULL` | 字段：avatar Url |
| `updateTime` | `VARCHAR(64) NULL` | 更新时间 |
| `createdAt` | `VARCHAR(64) NULL` | 创建时间 |
| `updatedAt` | `VARCHAR(64) NULL` | 最后更新时间 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |

## lxm_user_favorites

**表描述：** 用户收藏记录

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `openid` | `VARCHAR(128)` | 微信用户唯一标识 |
| `favorite_key` | `VARCHAR(256)` | 用户收藏复合键 |
| `type` | `VARCHAR(64)` | 记录类型 |
| `item_id` | `VARCHAR(128)` | 商品或关联项标识 |
| `type_label` | `VARCHAR(255)` | 收藏类型名称 |
| `title` | `VARCHAR(255)` | 标题 |
| `cover` | `TEXT` | 封面地址 |
| `price` | `DECIMAL(18,2)` | 销售价格 |
| `spot` | `VARCHAR(255)` | 字段：spot |
| `spot_id` | `VARCHAR(128)` | 打卡点标识 |
| `url` | `TEXT` | 资源地址 |
| `created_at` | `DATETIME(3)` | 创建时间 |
| `updated_at` | `DATETIME(3)` | 最后更新时间 |
