-- Canonical relational schema (version 2).
-- Every lxm_<collection> table stores declared scalar columns only.
-- Repeated values and nested structures are represented by typed relation
-- rows or leaf paths in lxm_collection_values. All statements are idempotent.
-- lxm_auth_*_normalized are scalar-only cutover projections for legacy
-- account/menu metadata, and the attribute tables hold one typed leaf per row.
CREATE TABLE IF NOT EXISTS lxm_schema_version (
  version INT NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `lxm_cities` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `mode` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `code` VARCHAR(255) NULL,
  `cityId` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `sort` INT NULL,
  `enabled` TINYINT(1) NULL,
  `visible` TINYINT(1) NULL,
  `latitude` DECIMAL(20,6) NULL,
  `longitude` DECIMAL(20,6) NULL,
  `coordType` VARCHAR(255) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_agents` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `account` VARCHAR(255) NULL,
  `phone` VARCHAR(255) NULL,
  `email` VARCHAR(255) NULL,
  `role` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `city` VARCHAR(255) NULL,
  `cityId` VARCHAR(255) NULL,
  `agentId` VARCHAR(255) NULL,
  `shopId` VARCHAR(255) NULL,
  `distributorId` VARCHAR(255) NULL,
  `commissionRate` DECIMAL(20,6) NULL,
  `settlementCycle` VARCHAR(255) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_distributors` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `contact` VARCHAR(255) NULL,
  `phone` VARCHAR(255) NULL,
  `email` VARCHAR(255) NULL,
  `account` VARCHAR(255) NULL,
  `role` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `city` VARCHAR(255) NULL,
  `cityId` VARCHAR(255) NULL,
  `agentId` VARCHAR(255) NULL,
  `distributorId` VARCHAR(255) NULL,
  `commissionRate` DECIMAL(20,6) NULL,
  `settlementCycle` VARCHAR(255) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_shops` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `logo` TEXT NULL,
  `city` VARCHAR(255) NULL,
  `cityId` VARCHAR(255) NULL,
  `district` VARCHAR(255) NULL,
  `shopId` VARCHAR(255) NULL,
  `shopCode` VARCHAR(255) NULL,
  `scene` VARCHAR(255) NULL,
  `qrPosition` VARCHAR(255) NULL,
  `commissionRate` DECIMAL(20,6) NULL,
  `shareRatio` DECIMAL(20,6) NULL,
  `settlementCycle` VARCHAR(255) NULL,
  `account` VARCHAR(255) NULL,
  `contact` VARCHAR(255) NULL,
  `phone` VARCHAR(255) NULL,
  `email` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `status` VARCHAR(255) NULL,
  `agentId` VARCHAR(255) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_staff` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `account` VARCHAR(255) NULL,
  `phone` VARCHAR(255) NULL,
  `email` VARCHAR(255) NULL,
  `role` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `city` VARCHAR(255) NULL,
  `cityId` VARCHAR(255) NULL,
  `agentId` VARCHAR(255) NULL,
  `distributorId` VARCHAR(255) NULL,
  `shopId` VARCHAR(255) NULL,
  `commissionRate` DECIMAL(20,6) NULL,
  `settlementCycle` VARCHAR(255) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_spots` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `city` VARCHAR(255) NULL,
  `cityId` VARCHAR(255) NULL,
  `cityCode` VARCHAR(255) NULL,
  `district` VARCHAR(255) NULL,
  `tag` VARCHAR(255) NULL,
  `hotScore` DECIMAL(20,6) NULL,
  `sort` INT NULL,
  `intro` TEXT NULL,
  `description` TEXT NULL,
  `address` TEXT NULL,
  `checkinCount` INT NULL,
  `visitCount` INT NULL,
  `image` TEXT NULL,
  `cover` TEXT NULL,
  `coverUrl` TEXT NULL,
  `shopId` VARCHAR(255) NULL,
  `latitude` DECIMAL(20,6) NULL,
  `longitude` DECIMAL(20,6) NULL,
  `coordType` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `enabled` TINYINT(1) NULL,
  `isShow` TINYINT(1) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_series` (
  `id` VARCHAR(128) NOT NULL,
  `spotId` VARCHAR(255) NULL,
  `name` VARCHAR(255) NULL,
  `intro` TEXT NULL,
  `style` VARCHAR(255) NULL,
  `productType` VARCHAR(255) NULL,
  `soldCount` INT NULL,
  `minPrice` DECIMAL(18,2) NULL,
  `maxPrice` DECIMAL(18,2) NULL,
  `status` VARCHAR(255) NULL,
  `isHot` TINYINT(1) NULL,
  `cover` TEXT NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_albums` (
  `id` VARCHAR(128) NOT NULL,
  `spotId` VARCHAR(255) NULL,
  `seriesId` VARCHAR(255) NULL,
  `name` VARCHAR(255) NULL,
  `price` DECIMAL(18,2) NULL,
  `intro` TEXT NULL,
  `description` TEXT NULL,
  `photoCount` INT NULL,
  `shootingNotes` TEXT NULL,
  `status` VARCHAR(255) NULL,
  `isShow` TINYINT(1) NULL,
  `isSellable` TINYINT(1) NULL,
  `allowMaterialUse` TINYINT(1) NULL,
  `photoMaterialEnabled` TINYINT(1) NULL,
  `videoMaterialEnabled` TINYINT(1) NULL,
  `cover` TEXT NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_samples` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `type` VARCHAR(255) NULL,
  `mediaType` VARCHAR(255) NULL,
  `albumId` VARCHAR(255) NULL,
  `seriesId` VARCHAR(255) NULL,
  `spotId` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `isShow` TINYINT(1) NULL,
  `isShowcase` TINYINT(1) NULL,
  `isFeatured` TINYINT(1) NULL,
  `isRecommend` TINYINT(1) NULL,
  `url` TEXT NULL,
  `image` TEXT NULL,
  `cover` TEXT NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_packages` (
  `id` VARCHAR(128) NOT NULL,
  `spotId` VARCHAR(255) NULL,
  `seriesId` VARCHAR(255) NULL,
  `albumId` VARCHAR(255) NULL,
  `name` VARCHAR(255) NULL,
  `title` VARCHAR(255) NULL,
  `type` VARCHAR(255) NULL,
  `productKind` VARCHAR(255) NULL,
  `serviceType` VARCHAR(255) NULL,
  `originalPrice` DECIMAL(18,2) NULL,
  `price` DECIMAL(18,2) NULL,
  `specialPrice` DECIMAL(18,2) NULL,
  `weekdayPrice` DECIMAL(18,2) NULL,
  `weekendSurcharge` DECIMAL(18,2) NULL,
  `holidaySurcharge` DECIMAL(18,2) NULL,
  `aerialExtraPrice` DECIMAL(18,2) NULL,
  `depositRatio` DECIMAL(20,6) NULL,
  `duration` INT NULL,
  `durationText` VARCHAR(255) NULL,
  `retouchCount` INT NULL,
  `videoDuration` INT NULL,
  `finishedVideoCount` INT NULL,
  `hasAerial` TINYINT(1) NULL,
  `fullEdit` TINYINT(1) NULL,
  `deliveryCycle` VARCHAR(255) NULL,
  `hotScore` DECIMAL(20,6) NULL,
  `isHot` TINYINT(1) NULL,
  `isMainPush` TINYINT(1) NULL,
  `mainPush` TINYINT(1) NULL,
  `isShow` TINYINT(1) NULL,
  `status` VARCHAR(255) NULL,
  `intro` TEXT NULL,
  `description` TEXT NULL,
  `cover` TEXT NULL,
  `videoUrl` TEXT NULL,
  `previewVideoUrl` TEXT NULL,
  `isVideoSingle` TINYINT(1) NULL,
  `bookingLimit` INT NULL,
  `advanceBookingDays` INT NULL,
  `holidayQuota` INT NULL,
  `timeSlotLimit` INT NULL,
  `scheduledOnAt` VARCHAR(64) NULL,
  `scheduledOffAt` VARCHAR(64) NULL,
  `auditStatus` VARCHAR(255) NULL,
  `auditType` VARCHAR(255) NULL,
  `auditSubmitAt` VARCHAR(64) NULL,
  `auditSubmitter` VARCHAR(255) NULL,
  `auditReviewer` VARCHAR(255) NULL,
  `auditReviewedAt` VARCHAR(64) NULL,
  `auditRejectReason` TEXT NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_addonServices` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `cate` VARCHAR(255) NULL,
  `price` DECIMAL(18,2) NULL,
  `enabled` TINYINT(1) NULL,
  `isShow` TINYINT(1) NULL,
  `intro` TEXT NULL,
  `description` TEXT NULL,
  `spotId` VARCHAR(255) NULL,
  `seriesId` VARCHAR(255) NULL,
  `albumId` VARCHAR(255) NULL,
  `eligibility` VARCHAR(255) NULL,
  `orderScope` VARCHAR(255) NULL,
  `maxQuantity` INT NULL,
  `holidaySurcharge` DECIMAL(18,2) NULL,
  `financeReviewRequired` TINYINT(1) NULL,
  `includeInOrderAmount` TINYINT(1) NULL,
  `status` VARCHAR(255) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_peripherals` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `cate` VARCHAR(255) NULL,
  `price` DECIMAL(18,2) NULL,
  `enabled` TINYINT(1) NULL,
  `isShow` TINYINT(1) NULL,
  `intro` TEXT NULL,
  `description` TEXT NULL,
  `image` TEXT NULL,
  `cover` TEXT NULL,
  `mode` VARCHAR(255) NULL,
  `spotId` VARCHAR(255) NULL,
  `stock` INT NULL,
  `stockQty` INT NULL,
  `isHot` TINYINT(1) NULL,
  `isNew` TINYINT(1) NULL,
  `deliveryCycle` VARCHAR(255) NULL,
  `scheduledOnAt` VARCHAR(64) NULL,
  `scheduledOffAt` VARCHAR(64) NULL,
  `auditStatus` VARCHAR(255) NULL,
  `auditType` VARCHAR(255) NULL,
  `auditSubmitAt` VARCHAR(64) NULL,
  `auditSubmitter` VARCHAR(255) NULL,
  `auditReviewer` VARCHAR(255) NULL,
  `auditReviewedAt` VARCHAR(64) NULL,
  `auditRejectReason` TEXT NULL,
  `status` VARCHAR(255) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_tagLibrary` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `sort` INT NULL,
  `scope` VARCHAR(255) NULL,
  `color` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_guides` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `title` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `intro` TEXT NULL,
  `status` VARCHAR(255) NULL,
  `tag` VARCHAR(255) NULL,
  `spotId` VARCHAR(255) NULL,
  `seriesId` VARCHAR(255) NULL,
  `targetPackageId` VARCHAR(255) NULL,
  `isHot` TINYINT(1) NULL,
  `readCount` INT NULL,
  `score` DECIMAL(20,6) NULL,
  `cover` TEXT NULL,
  `image` TEXT NULL,
  `coverUrl` TEXT NULL,
  `isShow` TINYINT(1) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_stories` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NULL,
  `title` VARCHAR(255) NULL,
  `subtitle` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `intro` TEXT NULL,
  `status` VARCHAR(255) NULL,
  `tag` VARCHAR(255) NULL,
  `spotId` VARCHAR(255) NULL,
  `seriesId` VARCHAR(255) NULL,
  `isHot` TINYINT(1) NULL,
  `readCount` INT NULL,
  `score` DECIMAL(20,6) NULL,
  `cover` TEXT NULL,
  `image` TEXT NULL,
  `isShow` TINYINT(1) NULL,
  `visible` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_scans` (
  `id` VARCHAR(128) NOT NULL,
  `date` VARCHAR(255) NULL,
  `hour` INT NULL,
  `shopId` VARCHAR(255) NULL,
  `distributorId` VARCHAR(255) NULL,
  `sourceType` VARCHAR(255) NULL,
  `sourceName` VARCHAR(255) NULL,
  `scene` VARCHAR(255) NULL,
  `openid` VARCHAR(255) NULL,
  `orderId` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_orders` (
  `id` VARCHAR(128) NOT NULL,
  `orderNo` VARCHAR(255) NULL,
  `bookingIdempotencyKey` VARCHAR(128) NULL,
  `openid` VARCHAR(255) NULL,
  `_openid` VARCHAR(255) NULL,
  `customer` TEXT NULL,
  `name` VARCHAR(255) NULL,
  `contactName` VARCHAR(255) NULL,
  `phone` VARCHAR(255) NULL,
  `contactPhone` VARCHAR(255) NULL,
  `customerPhone` VARCHAR(255) NULL,
  `wechat` VARCHAR(255) NULL,
  `contactWechat` VARCHAR(255) NULL,
  `customerWechat` VARCHAR(255) NULL,
  `shopId` VARCHAR(255) NULL,
  `shopCode` VARCHAR(255) NULL,
  `distributorId` VARCHAR(255) NULL,
  `sourceType` VARCHAR(255) NULL,
  `sourceName` VARCHAR(255) NULL,
  `sourceScene` VARCHAR(255) NULL,
  `sourceChannel` VARCHAR(255) NULL,
  `sourceCodeId` VARCHAR(255) NULL,
  `scene` VARCHAR(255) NULL,
  `spotId` VARCHAR(255) NULL,
  `spotName` VARCHAR(255) NULL,
  `seriesId` VARCHAR(255) NULL,
  `seriesName` VARCHAR(255) NULL,
  `packageId` VARCHAR(255) NULL,
  `packageName` VARCHAR(255) NULL,
  `date` VARCHAR(255) NULL,
  `appointmentAt` VARCHAR(64) NULL,
  `bookingDate` VARCHAR(255) NULL,
  `bookingTime` VARCHAR(255) NULL,
  `timePeriod` VARCHAR(255) NULL,
  `timeSlot` VARCHAR(255) NULL,
  `time` VARCHAR(255) NULL,
  `message` TEXT NULL,
  `price` DECIMAL(18,2) NULL,
  `totalPrice` DECIMAL(18,2) NULL,
  `totalAmount` DECIMAL(18,2) NULL,
  `depositRatio` DECIMAL(20,6) NULL,
  `depositDue` DECIMAL(18,2) NULL,
  `depositPaid` DECIMAL(18,2) NULL,
  `depositPaidAt` VARCHAR(64) NULL,
  `depositConfirmedAt` VARCHAR(64) NULL,
  `depositConfirmedBy` VARCHAR(128) NULL,
  `finalDue` DECIMAL(18,2) NULL,
  `finalPaid` DECIMAL(18,2) NULL,
  `finalPaidAt` VARCHAR(64) NULL,
  `finalConfirmedAt` VARCHAR(64) NULL,
  `finalConfirmedBy` VARCHAR(128) NULL,
  `finalDiscountAmount` DECIMAL(18,2) NULL,
  `finalDiscountReason` TEXT NULL,
  `priceAdjustReason` TEXT NULL,
  `bookingMode` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `customerStatus` VARCHAR(255) NULL,
  `workflowStage` VARCHAR(64) NULL,
  `dispatchStatus` VARCHAR(64) NULL,
  `depositRefundable` TINYINT(1) NULL,
  `depositRefundableAt` VARCHAR(64) NULL,
  `assigneeId` VARCHAR(255) NULL,
  `serviceUser` VARCHAR(255) NULL,
  `serviceUserId` VARCHAR(255) NULL,
  `photographer` VARCHAR(255) NULL,
  `photographerId` VARCHAR(255) NULL,
  `photographerCommissionRate` DECIMAL(20,6) NULL,
  `completedAt` VARCHAR(64) NULL,
  `deliveredAt` VARCHAR(64) NULL,
  `deliveredBy` VARCHAR(128) NULL,
  `deliveryMethod` VARCHAR(64) NULL,
  `finishedAt` VARCHAR(64) NULL,
  `completedTime` VARCHAR(64) NULL,
  `serviceNote` TEXT NULL,
  `deliveryNote` TEXT NULL,
  `customerRemark` TEXT NULL,
  `internalNote` TEXT NULL,
  `paymentVerify` VARCHAR(255) NULL,
  `depositFinanceStatus` VARCHAR(255) NULL,
  `finalFinanceStatus` VARCHAR(255) NULL,
  `depositPaymentStatus` VARCHAR(64) NULL,
  `finalPaymentStatus` VARCHAR(64) NULL,
  `financeStatus` VARCHAR(255) NULL,
  `refundAmount` DECIMAL(18,2) NULL,
  `refundConfirmed` TINYINT(1) NULL,
  `afterSaleStatus` VARCHAR(255) NULL,
  `afterSaleReason` TEXT NULL,
  `afterSaleCreateTime` VARCHAR(64) NULL,
  `afterSaleId` VARCHAR(255) NULL,
  `riskBlocked` TINYINT(1) NULL,
  `riskFlag` VARCHAR(255) NULL,
  `frozen` TINYINT(1) NULL,
  `freezeReason` TEXT NULL,
  `riskReason` TEXT NULL,
  `settlementObservationReleased` TINYINT(1) NULL,
  `settlementObservationReleasedAt` VARCHAR(64) NULL,
  `settlementObservationReleasedBy` VARCHAR(255) NULL,
  `createdBy` VARCHAR(255) NULL,
  `createdById` VARCHAR(255) NULL,
  `createTime` VARCHAR(64) NULL,
  `updateTime` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order_booking_idempotency` (`bookingIdempotencyKey`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_afterSales` (
  `id` VARCHAR(128) NOT NULL,
  `orderId` VARCHAR(255) NULL,
  `orderNo` VARCHAR(255) NULL,
  `openid` VARCHAR(255) NULL,
  `type` VARCHAR(255) NULL,
  `customer` TEXT NULL,
  `packageName` VARCHAR(255) NULL,
  `reason` TEXT NULL,
  `status` VARCHAR(255) NULL,
  `customerVisibleStatus` VARCHAR(255) NULL,
  `submitSource` VARCHAR(255) NULL,
  `assigneeId` VARCHAR(255) NULL,
  `refundAmount` DECIMAL(18,2) NULL,
  `amount` DECIMAL(18,2) NULL,
  `refundConfirmed` TINYINT(1) NULL,
  `financeStatus` VARCHAR(255) NULL,
  `approvedBy` VARCHAR(255) NULL,
  `approvedAt` VARCHAR(64) NULL,
  `financeReviewedBy` VARCHAR(255) NULL,
  `financeReviewedAt` VARCHAR(64) NULL,
  `createdBy` VARCHAR(255) NULL,
  `createdById` VARCHAR(255) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_reconciliationTransfers` (
  `id` VARCHAR(128) NOT NULL,
  `key` VARCHAR(255) NULL,
  `month` VARCHAR(255) NULL,
  `period` VARCHAR(255) NULL,
  `settlementCycle` VARCHAR(255) NULL,
  `objectType` VARCHAR(255) NULL,
  `objectId` VARCHAR(255) NULL,
  `objectName` VARCHAR(255) NULL,
  `amount` DECIMAL(18,2) NULL,
  `status` VARCHAR(255) NULL,
  `operator` VARCHAR(255) NULL,
  `operatorId` VARCHAR(255) NULL,
  `time` VARCHAR(64) NULL,
  `method` VARCHAR(255) NULL,
  `voucherNo` VARCHAR(255) NULL,
  `note` TEXT NULL,
  `payStatus` VARCHAR(255) NULL,
  `paidBy` VARCHAR(255) NULL,
  `paidAt` VARCHAR(64) NULL,
  `sealedBy` VARCHAR(255) NULL,
  `sealedAt` VARCHAR(64) NULL,
  `sealNote` TEXT NULL,
  `unsealedBy` VARCHAR(255) NULL,
  `unsealedAt` VARCHAR(64) NULL,
  `unsealNote` TEXT NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_financeSettings` (
  `id` VARCHAR(128) NOT NULL,
  `settlementObservationDays` INT NULL,
  `largeSettlementThreshold` DECIMAL(18,2) NULL,
  `currency` VARCHAR(255) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_monthlyClosings` (
  `id` VARCHAR(128) NOT NULL,
  `month` VARCHAR(255) NULL,
  `status` VARCHAR(255) NULL,
  `operator` VARCHAR(255) NULL,
  `operatorId` VARCHAR(255) NULL,
  `time` VARCHAR(64) NULL,
  `note` TEXT NULL,
  `unlockedBy` VARCHAR(255) NULL,
  `unlockedAt` VARCHAR(64) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_adjustmentRecords` (
  `id` VARCHAR(128) NOT NULL,
  `orderNo` VARCHAR(255) NULL,
  `orderId` VARCHAR(255) NULL,
  `time` VARCHAR(64) NULL,
  `type` VARCHAR(255) NULL,
  `amount` DECIMAL(18,2) NULL,
  `targetType` VARCHAR(255) NULL,
  `targetName` VARCHAR(255) NULL,
  `operator` VARCHAR(255) NULL,
  `operatorId` VARCHAR(255) NULL,
  `approvalStatus` VARCHAR(255) NULL,
  `approvedBy` VARCHAR(255) NULL,
  `approvedAt` VARCHAR(64) NULL,
  `note` TEXT NULL,
  `attachment` TEXT NULL,
  `offsetStatus` VARCHAR(255) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_homeConfig` (
  `id` VARCHAR(128) NOT NULL,
  `activity` VARCHAR(255) NULL,
  `cityName` VARCHAR(255) NULL,
  `shopServiceText` VARCHAR(255) NULL,
  `heroSubtitle` TEXT NULL,
  `trustOrders` INT NULL,
  `trustRate` VARCHAR(255) NULL,
  `notice` TEXT NULL,
  `updatedAt` VARCHAR(64) NULL,
  `createdAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_logs` (
  `id` VARCHAR(128) NOT NULL,
  `time` VARCHAR(64) NULL,
  `user` VARCHAR(255) NULL,
  `operator` VARCHAR(255) NULL,
  `operatorId` VARCHAR(255) NULL,
  `action` VARCHAR(255) NULL,
  `target` VARCHAR(255) NULL,
  `targetType` VARCHAR(255) NULL,
  `targetId` VARCHAR(255) NULL,
  `detail` TEXT NULL,
  `module` VARCHAR(255) NULL,
  `level` VARCHAR(255) NULL,
  `amount` VARCHAR(255) NULL,
  `objectType` VARCHAR(255) NULL,
  `objectName` VARCHAR(255) NULL,
  `snapshotText` VARCHAR(500) NULL,
  `source` VARCHAR(255) NULL,
  `createTime` VARCHAR(64) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_log_order_exception_snapshots` (
  log_id VARCHAR(128) NOT NULL,
  before_status VARCHAR(64) NULL,
  after_status VARCHAR(64) NULL,
  before_customer_status VARCHAR(64) NULL,
  after_customer_status VARCHAR(64) NULL,
  before_source_type VARCHAR(64) NULL,
  after_source_type VARCHAR(64) NULL,
  before_shop_id VARCHAR(128) NULL,
  after_shop_id VARCHAR(128) NULL,
  before_distributor_id VARCHAR(128) NULL,
  after_distributor_id VARCHAR(128) NULL,
  before_risk_blocked TINYINT(1) NULL,
  after_risk_blocked TINYINT(1) NULL,
  PRIMARY KEY (log_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_trash` (
  `id` VARCHAR(128) NOT NULL,
  `refId` VARCHAR(255) NULL,
  `sourceKey` VARCHAR(255) NULL,
  `sourceId` VARCHAR(255) NULL,
  `type` VARCHAR(255) NULL,
  `name` VARCHAR(255) NULL,
  `reason` TEXT NULL,
  `operator` VARCHAR(255) NULL,
  `operatorId` VARCHAR(255) NULL,
  `time` VARCHAR(64) NULL,
  `deletedAt` VARCHAR(64) NULL,
  `restorable` TINYINT(1) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_merchantCodes` (
  `id` VARCHAR(128) NOT NULL,
  `shopId` VARCHAR(255) NULL,
  `shopName` VARCHAR(255) NULL,
  `distributorId` VARCHAR(255) NULL,
  `placementType` VARCHAR(255) NULL,
  `placementLabel` VARCHAR(255) NULL,
  `scene` VARCHAR(255) NULL,
  `scanCount` INT NULL,
  `orderCount` INT NULL,
  `dealCount` INT NULL,
  `qrImage` TEXT NULL,
  `status` VARCHAR(255) NULL,
  `createTime` VARCHAR(64) NULL,
  `lastScanTime` VARCHAR(64) NULL,
  `deleted` TINYINT(1) NULL,
  `isDeleted` TINYINT(1) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_siteConfig` (
  `id` VARCHAR(128) NOT NULL,
  `customPrice_baseHours` DECIMAL(20,6) NULL,
  `customPrice_singlePersonPrice` DECIMAL(18,2) NULL,
  `customPrice_perExtraPerson` DECIMAL(18,2) NULL,
  `customPrice_note` TEXT NULL,
  `privacyText` TEXT NULL,
  `wechatCorpId` VARCHAR(255) NULL,
  `wechatAppId` VARCHAR(255) NULL,
  `wechatGuideText` TEXT NULL,
  `footprintEnabled` TINYINT(1) NULL,
  `footprintTotal` INT NULL,
  `footprintTitle` VARCHAR(255) NULL,
  `footprintRewardText` TEXT NULL,
  `updatedAt` VARCHAR(64) NULL,
  `createdAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_userProfiles` (
  `id` VARCHAR(128) NOT NULL,
  `openid` VARCHAR(255) NULL,
  `unionid` VARCHAR(255) NULL,
  `phone` VARCHAR(255) NULL,
  `dev` TINYINT(1) NULL,
  `nickname` VARCHAR(255) NULL,
  `avatarUrl` TEXT NULL,
  `updateTime` VARCHAR(64) NULL,
  `createdAt` VARCHAR(64) NULL,
  `updatedAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_config` (
  `id` VARCHAR(128) NOT NULL,
  `configKey` VARCHAR(255) NULL,
  `valueText` TEXT NULL,
  `valueNumber` DECIMAL(20,6) NULL,
  `valueBool` TINYINT(1) NULL,
  `status` VARCHAR(255) NULL,
  `updatedAt` VARCHAR(64) NULL,
  `createdAt` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_updated_at` (`updatedAt`),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_account_permissions` (
  collection_name VARCHAR(32) NOT NULL,
  account_id VARCHAR(128) NOT NULL,
  permission_key VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_name, account_id, permission_key),
  KEY idx_account_permission (collection_name, permission_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_shop_distributors` (
  shop_id VARCHAR(128) NOT NULL,
  distributor_id VARCHAR(128) NOT NULL,
  rate DECIMAL(7,4) NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, distributor_id),
  KEY idx_shop_distributor_distributor (distributor_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_shop_agents` (
  shop_id VARCHAR(128) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, agent_id),
  KEY idx_shop_agent_agent (agent_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_series_spots` (
  series_id VARCHAR(128) NOT NULL,
  spot_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, spot_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_album_samples` (
  album_id VARCHAR(128) NOT NULL,
  sample_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (album_id, sample_id),
  KEY idx_album_sample_sample (sample_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_album_tags` (
  album_id VARCHAR(128) NOT NULL,
  tag VARCHAR(255) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (album_id, tag),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_package_spots` (
  package_id VARCHAR(128) NOT NULL,
  spot_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (package_id, spot_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_package_tags` (
  package_id VARCHAR(128) NOT NULL,
  tag_type VARCHAR(32) NOT NULL,
  tag VARCHAR(255) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (package_id, tag_type, tag),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_package_exclusions` (
  package_id VARCHAR(128) NOT NULL,
  excluded_package_id VARCHAR(128) NOT NULL,
  relation_type VARCHAR(32) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (package_id, excluded_package_id, relation_type),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_package_included_items` (
  package_id VARCHAR(128) NOT NULL,
  item_no INT NOT NULL,
  item_type VARCHAR(32) NULL,
  item_name VARCHAR(255) NULL,
  item_price DECIMAL(18,2) NULL,
  target_page VARCHAR(128) NULL,
  target_product_id VARCHAR(128) NULL,
  target_series_id VARCHAR(128) NULL,
  target_album_id VARCHAR(128) NULL,
  target_spot_id VARCHAR(128) NULL,
  PRIMARY KEY (package_id, item_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_addon_package_defaults` (
  addon_id VARCHAR(128) NOT NULL,
  package_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (addon_id, package_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_peripheral_spots` (
  peripheral_id VARCHAR(128) NOT NULL,
  spot_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (peripheral_id, spot_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_peripheral_specs` (
  peripheral_id VARCHAR(128) NOT NULL,
  spec_no INT NOT NULL,
  spec_text VARCHAR(255) NOT NULL,
  PRIMARY KEY (peripheral_id, spec_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_peripheral_images` (
  peripheral_id VARCHAR(128) NOT NULL,
  image_no INT NOT NULL,
  image_url TEXT NULL,
  PRIMARY KEY (peripheral_id, image_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_contacts` (
  order_id VARCHAR(128) NOT NULL,
  contact_no INT NOT NULL,
  phone VARCHAR(64) NULL,
  wechat VARCHAR(255) NULL,
  PRIMARY KEY (order_id, contact_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_source` (
  order_id VARCHAR(128) NOT NULL,
  shop_id VARCHAR(128) NULL,
  distributor_id VARCHAR(128) NULL,
  scene VARCHAR(255) NULL,
  source_type VARCHAR(64) NULL,
  channel VARCHAR(64) NULL,
  code_id VARCHAR(128) NULL,
  PRIMARY KEY (order_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_package_snapshot` (
  order_id VARCHAR(128) NOT NULL,
  snapshot_id VARCHAR(128) NULL,
  package_id VARCHAR(128) NULL,
  name VARCHAR(255) NULL,
  original_price DECIMAL(18,2) NULL,
  price DECIMAL(18,2) NULL,
  is_main_push TINYINT(1) NULL,
  PRIMARY KEY (order_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_package_snapshot_tags` (
  order_id VARCHAR(128) NOT NULL,
  tag_no INT NOT NULL,
  tag VARCHAR(255) NOT NULL,
  PRIMARY KEY (order_id, tag_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_products` (
  order_id VARCHAR(128) NOT NULL,
  item_no INT NOT NULL,
  product_id VARCHAR(128) NULL,
  product_type VARCHAR(64) NULL,
  package_id VARCHAR(128) NULL,
  peripheral_id VARCHAR(128) NULL,
  price DECIMAL(18,2) NULL,
  quantity DECIMAL(12,3) NULL,
  spot_id VARCHAR(128) NULL,
  series_id VARCHAR(128) NULL,
  album_id VARCHAR(128) NULL,
  name VARCHAR(255) NULL,
  PRIMARY KEY (order_id, item_no),
  KEY idx_order_product (product_id, product_type),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_product_snapshots` (
  order_id VARCHAR(128) NOT NULL,
  item_no INT NOT NULL,
  snapshot_id VARCHAR(128) NULL,
  name VARCHAR(255) NULL,
  original_price DECIMAL(18,2) NULL,
  price DECIMAL(18,2) NULL,
  is_main_push TINYINT(1) NULL,
  PRIMARY KEY (order_id, item_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_product_snapshot_tags` (
  order_id VARCHAR(128) NOT NULL,
  item_no INT NOT NULL,
  tag_no INT NOT NULL,
  tag VARCHAR(255) NOT NULL,
  PRIMARY KEY (order_id, item_no, tag_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_addons` (
  order_id VARCHAR(128) NOT NULL,
  item_no INT NOT NULL,
  addon_id VARCHAR(128) NULL,
  addon_type VARCHAR(64) NULL,
  name VARCHAR(255) NULL,
  price DECIMAL(18,2) NULL,
  quantity DECIMAL(12,3) NULL,
  PRIMARY KEY (order_id, item_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_status_logs` (
  order_id VARCHAR(128) NOT NULL,
  log_no INT NOT NULL,
  time VARCHAR(64) NULL,
  operator VARCHAR(255) NULL,
  operator_id VARCHAR(128) NULL,
  action TEXT NULL,
  type VARCHAR(64) NULL,
  from_status VARCHAR(64) NULL,
  to_status VARCHAR(64) NULL,
  create_time VARCHAR(64) NULL,
  PRIMARY KEY (order_id, log_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_follow_records` (
  order_id VARCHAR(128) NOT NULL,
  record_no INT NOT NULL,
  type VARCHAR(64) NULL,
  action TEXT NULL,
  operator VARCHAR(255) NULL,
  operator_id VARCHAR(128) NULL,
  note TEXT NULL,
  reason TEXT NULL,
  from_status VARCHAR(64) NULL,
  to_status VARCHAR(64) NULL,
  create_time VARCHAR(64) NULL,
  PRIMARY KEY (order_id, record_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_order_payment_records` (
  order_id VARCHAR(128) NOT NULL,
  record_no INT NOT NULL,
  payment_id VARCHAR(128) NULL,
  phase VARCHAR(32) NULL,
  payment_type VARCHAR(64) NULL,
  amount DECIMAL(18,2) NULL,
  status VARCHAR(64) NULL,
  attempt INT NULL,
  provider VARCHAR(64) NULL,
  idempotency_key VARCHAR(128) NULL,
  confirmation_idempotency_key VARCHAR(128) NULL,
  external_transaction_id VARCHAR(160) NULL,
  operator VARCHAR(255) NULL,
  operator_id VARCHAR(128) NULL,
  paid_at VARCHAR(64) NULL,
  record_created_at VARCHAR(64) NULL,
  record_updated_at VARCHAR(64) NULL,
  admin_registered_at VARCHAR(64) NULL,
  note TEXT NULL,
  PRIMARY KEY (order_id, record_no),
  KEY idx_order_payment_phase (order_id, phase),
  UNIQUE KEY uq_order_payment_id (payment_id),
  UNIQUE KEY uq_order_payment_idempotency (idempotency_key),
  UNIQUE KEY uq_order_payment_confirmation_key (confirmation_idempotency_key),
  UNIQUE KEY uq_order_payment_transaction (external_transaction_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_after_sale_logs` (
  after_sale_id VARCHAR(128) NOT NULL,
  log_no INT NOT NULL,
  message TEXT NULL,
  time VARCHAR(64) NULL,
  operator VARCHAR(255) NULL,
  operator_id VARCHAR(128) NULL,
  PRIMARY KEY (after_sale_id, log_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_reconciliation_transfer_orders` (
  transfer_id VARCHAR(128) NOT NULL,
  order_no INT NOT NULL,
  order_id VARCHAR(128) NULL,
  order_number VARCHAR(128) NULL,
  PRIMARY KEY (transfer_id, order_no),
  KEY idx_transfer_order_id (order_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_home_modules` (
  config_id VARCHAR(128) NOT NULL,
  module_key VARCHAR(128) NOT NULL,
  title VARCHAR(255) NULL,
  subtitle VARCHAR(255) NULL,
  more_text VARCHAR(255) NULL,
  enabled TINYINT(1) NULL,
  visible TINYINT(1) NULL,
  sort_no INT NULL,
  PRIMARY KEY (config_id, module_key),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_home_ids` (
  config_id VARCHAR(128) NOT NULL,
  group_key VARCHAR(128) NOT NULL,
  item_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (config_id, group_key, item_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_home_quick_nav` (
  config_id VARCHAR(128) NOT NULL,
  nav_no INT NOT NULL,
  target_type VARCHAR(128) NULL,
  label VARCHAR(255) NULL,
  icon VARCHAR(255) NULL,
  PRIMARY KEY (config_id, nav_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_home_banners` (
  config_id VARCHAR(128) NOT NULL,
  banner_group VARCHAR(32) NOT NULL,
  banner_no INT NOT NULL,
  banner_id VARCHAR(128) NULL,
  type VARCHAR(32) NULL,
  url TEXT NULL,
  cover TEXT NULL,
  title VARCHAR(255) NULL,
  target_type VARCHAR(128) NULL,
  target_id VARCHAR(128) NULL,
  link_url TEXT NULL,
  effective_time VARCHAR(64) NULL,
  PRIMARY KEY (config_id, banner_group, banner_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_home_page_modules` (
  config_id VARCHAR(128) NOT NULL,
  page_key VARCHAR(128) NOT NULL,
  module_key VARCHAR(128) NOT NULL,
  title VARCHAR(255) NULL,
  enabled TINYINT(1) NULL,
  sort_no INT NULL,
  PRIMARY KEY (config_id, page_key, module_key),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_home_page_links` (
  config_id VARCHAR(128) NOT NULL,
  page_key VARCHAR(128) NOT NULL,
  link_type VARCHAR(64) NOT NULL,
  item_id VARCHAR(128) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (config_id, page_key, link_type, item_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_site_booking_notices` (
  config_id VARCHAR(128) NOT NULL,
  notice_no INT NOT NULL,
  notice_text TEXT NOT NULL,
  PRIMARY KEY (config_id, notice_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_site_hotwords` (
  config_id VARCHAR(128) NOT NULL,
  word_no INT NOT NULL,
  word VARCHAR(255) NOT NULL,
  PRIMARY KEY (config_id, word_no),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_trash_source_attributes` (
  trash_id VARCHAR(128) NOT NULL,
  path VARCHAR(512) NOT NULL,
  ordinal INT NOT NULL DEFAULT 0,
  value_type VARCHAR(16) NOT NULL,
  value_text TEXT NULL,
  value_number DECIMAL(20,6) NULL,
  value_bool TINYINT(1) NULL,
  value_time VARCHAR(64) NULL,
  PRIMARY KEY (trash_id, path, ordinal),
  KEY idx_trash_attr_path (path),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_collection_values` (
  collection_name VARCHAR(64) NOT NULL,
  record_id VARCHAR(128) NOT NULL,
  path VARCHAR(512) NOT NULL,
  ordinal INT NOT NULL DEFAULT 0,
  value_type VARCHAR(16) NOT NULL,
  value_text TEXT NULL,
  value_number DECIMAL(20,6) NULL,
  value_bool TINYINT(1) NULL,
  value_time VARCHAR(64) NULL,
  PRIMARY KEY (collection_name, record_id, path, ordinal),
  KEY idx_business_attr_path (collection_name, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_menus_normalized` (
  id VARCHAR(64) NOT NULL,
  menu_key VARCHAR(128) NOT NULL,
  parent_key VARCHAR(128) NULL,
  name VARCHAR(128) NOT NULL,
  path VARCHAR(255) NOT NULL,
  icon VARCHAR(64) NULL,
  sort_no INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  group_name VARCHAR(128) NULL,
  menu_type VARCHAR(32) NOT NULL DEFAULT 'menu',
  route_key VARCHAR(128) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_menu_normalized_key (menu_key),
  KEY idx_auth_menu_normalized_parent (parent_key),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_users_normalized` (
  id VARCHAR(64) NOT NULL,
  account VARCHAR(128) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  phone VARCHAR(64) NULL,
  email VARCHAR(255) NULL,
  subject_type VARCHAR(32) NULL,
  subject_id VARCHAR(128) NULL,
  legacy_key VARCHAR(64) NULL,
  legacy_id VARCHAR(128) NULL,
  shop_id VARCHAR(128) NULL,
  distributor_id VARCHAR(128) NULL,
  agent_id VARCHAR(128) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_user_normalized_account (account),
  KEY idx_auth_user_normalized_role (role_id),
  KEY idx_auth_user_normalized_subject (subject_type, subject_id),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_menu_attributes` (
  `menu_id` VARCHAR(128) NOT NULL,
  `attribute_key` VARCHAR(128) NOT NULL,
  `ordinal` INT NOT NULL DEFAULT 0,
  `value_type` VARCHAR(16) NOT NULL,
  `value_text` TEXT NULL,
  `value_number` DECIMAL(20,6) NULL,
  `value_bool` TINYINT(1) NULL,
  PRIMARY KEY (`menu_id`, `attribute_key`, `ordinal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_user_attributes` (
  `user_id` VARCHAR(128) NOT NULL,
  `attribute_key` VARCHAR(128) NOT NULL,
  `ordinal` INT NOT NULL DEFAULT 0,
  `value_type` VARCHAR(16) NOT NULL,
  `value_text` TEXT NULL,
  `value_number` DECIMAL(20,6) NULL,
  `value_bool` TINYINT(1) NULL,
  PRIMARY KEY (`user_id`, `attribute_key`, `ordinal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Canonical authorization tables. Metadata and subject bindings are scalar
-- columns; per-user permissions remain rows in a relation table.
CREATE TABLE IF NOT EXISTS `lxm_auth_menus` (
  id VARCHAR(128) NOT NULL,
  menu_key VARCHAR(128) NOT NULL,
  parent_key VARCHAR(128) NULL,
  name VARCHAR(128) NOT NULL,
  path VARCHAR(255) NOT NULL,
  icon VARCHAR(64) NULL,
  sort_no INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  meta_group VARCHAR(64) NULL,
  meta_type VARCHAR(64) NULL,
  meta_label VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_menu_key (menu_key),
  KEY idx_auth_menu_parent (parent_key),
  KEY idx_auth_menu_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_roles` (
  id VARCHAR(128) NOT NULL,
  role_key VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  description VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_role_key (role_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_role_menus` (
  role_id VARCHAR(128) NOT NULL,
  menu_key VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, menu_key),
  KEY idx_auth_rm_menu (menu_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_role_permissions` (
  role_id VARCHAR(128) NOT NULL,
  permission_key VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, permission_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_user_permissions` (
  user_id VARCHAR(128) NOT NULL,
  permission_key VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, permission_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lxm_auth_users` (
  id VARCHAR(128) NOT NULL,
  account VARCHAR(128) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  phone VARCHAR(64) NULL,
  email VARCHAR(255) NULL,
  legacy_key VARCHAR(64) NULL,
  legacy_id VARCHAR(128) NULL,
  subject_type VARCHAR(64) NULL,
  subject_id VARCHAR(128) NULL,
  shop_id VARCHAR(128) NULL,
  distributor_id VARCHAR(128) NULL,
  agent_id VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_user_account (account),
  KEY idx_auth_user_role (role_id),
  KEY idx_auth_user_status (status),
  KEY idx_auth_user_subject (subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
