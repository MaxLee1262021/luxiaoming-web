"use strict";

// Canonical MySQL schema metadata for the business collections.  The HTTP
// layer keeps the legacy document-shaped contract, while this module maps
// scalar fields to columns and nested values to relation/attribute rows.
// No business table uses a whole-document payload column; unmodeled leaves
// are stored one typed value per path for an explicit, non-JSON extension lane.

const ALL_KEYS = Object.freeze([
  "cities", "agents", "distributors", "shops", "staff", "spots", "series",
  "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary",
  "guides", "stories", "scans", "orders", "afterSales", "reconciliationTransfers",
  "financeSettings", "monthlyClosings", "adjustmentRecords", "homeConfig", "logs", "trash",
  "merchantCodes", "siteConfig", "userProfiles", "config"
]);

const KEY_SET = new Set(ALL_KEYS);
const TABLES = Object.freeze(Object.fromEntries(ALL_KEYS.map((key) => [key, `lxm_${key}`])));
const SENSITIVE_FIELDS = new Set(["password", "passwordHash", "password_hash", "secret", "token", "authorization"]);
const SENSITIVE_FIELD_PATTERN = /password|token|secret|private.?key|authorization/i;
function isSensitiveField(value) { return SENSITIVE_FIELDS.has(String(value)) || SENSITIVE_FIELD_PATTERN.test(String(value)); }
// Finance settings are a deliberately closed singleton. Its public contract
// is represented by scalar columns below; accepting arbitrary typed leaves
// would allow an unrelated config document to be copied into this record.
const FINANCE_DOCUMENT_FIELDS = new Set(["settlementObservationDays", "largeSettlementThreshold", "currency"]);

const S = {
  id: "VARCHAR(128) NOT NULL",
  short: "VARCHAR(255) NULL",
  key: "VARCHAR(128) NULL",
  ref: "VARCHAR(128) NULL",
  status: "VARCHAR(64) NULL",
  text: "TEXT NULL",
  money: "DECIMAL(18,2) NULL",
  number: "DECIMAL(20,6) NULL",
  integer: "INT NULL",
  bool: "TINYINT(1) NULL",
  time: "VARCHAR(64) NULL",
  created: "DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)",
  updated: "DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)"
};

function columns(names, type = S.short) {
  return names.map((name) => ({ name, type }));
}
function withBase(list, options = {}) {
  const out = [
    { name: "id", type: S.id },
    ...(list || []).map((item) => typeof item === "string" ? { name: item, type: S.short } : item),
  ];
  if (options.lifecycle !== false) {
    out.push({ name: "deleted", type: S.bool }, { name: "isDeleted", type: S.bool });
  }
  out.push({ name: "createdAt", type: S.time }, { name: "updatedAt", type: S.time });
  const seen = new Set();
  return { columns: out.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  }) };
}

// Column names intentionally follow the public document keys. This avoids a
// lossy alias layer for existing callers; internal audit columns use snake case.
const COLLECTIONS = {
  cities: withBase([
    { name: "name", type: S.short }, { name: "mode", type: S.short }, { name: "status", type: S.short },
    { name: "code", type: S.short }, { name: "cityId", type: S.short }, { name: "description", type: S.text },
    { name: "sort", type: S.integer }, { name: "enabled", type: S.bool }, { name: "visible", type: S.bool },
    { name: "latitude", type: S.number }, { name: "longitude", type: S.number }, { name: "coordType", type: S.short }
  ]),
  agents: withBase([
    { name: "name", type: S.short }, { name: "account", type: S.short }, { name: "phone", type: S.short },
    { name: "email", type: S.short }, { name: "role", type: S.short }, { name: "status", type: S.short },
    { name: "city", type: S.short }, { name: "cityId", type: S.short }, { name: "agentId", type: S.short },
    { name: "shopId", type: S.short }, { name: "distributorId", type: S.short }, { name: "commissionRate", type: S.number },
    { name: "settlementCycle", type: S.short }, { name: "visible", type: S.bool }
  ], { lifecycle: true }),
  distributors: withBase([
    { name: "name", type: S.short }, { name: "contact", type: S.short }, { name: "phone", type: S.short },
    { name: "email", type: S.short }, { name: "account", type: S.short }, { name: "role", type: S.short },
    { name: "status", type: S.short }, { name: "city", type: S.short }, { name: "cityId", type: S.short },
    { name: "agentId", type: S.short }, { name: "distributorId", type: S.short }, { name: "commissionRate", type: S.number },
    { name: "settlementCycle", type: S.short }, { name: "visible", type: S.bool }
  ]),
  shops: withBase([
    { name: "name", type: S.short }, { name: "logo", type: S.text }, { name: "city", type: S.short },
    { name: "cityId", type: S.short }, { name: "district", type: S.short }, { name: "shopId", type: S.short },
    { name: "shopCode", type: S.short }, { name: "scene", type: S.short }, { name: "qrPosition", type: S.short },
    { name: "commissionRate", type: S.number }, { name: "shareRatio", type: S.number }, { name: "settlementCycle", type: S.short },
    { name: "account", type: S.short }, { name: "contact", type: S.short }, { name: "phone", type: S.short },
    { name: "email", type: S.short }, { name: "address", type: S.text }, { name: "status", type: S.short },
    { name: "agentId", type: S.short }, { name: "visible", type: S.bool }
  ]),
  staff: withBase([
    { name: "name", type: S.short }, { name: "account", type: S.short }, { name: "phone", type: S.short },
    { name: "email", type: S.short }, { name: "role", type: S.short }, { name: "status", type: S.short },
    { name: "city", type: S.short }, { name: "cityId", type: S.short }, { name: "agentId", type: S.short },
    { name: "distributorId", type: S.short }, { name: "shopId", type: S.short }, { name: "commissionRate", type: S.number },
    { name: "settlementCycle", type: S.short }, { name: "visible", type: S.bool }
  ]),
  spots: withBase([
    { name: "name", type: S.short }, { name: "city", type: S.short }, { name: "cityId", type: S.short },
    { name: "cityCode", type: S.short }, { name: "district", type: S.short }, { name: "tag", type: S.short },
    { name: "hotScore", type: S.number }, { name: "sort", type: S.integer },
    { name: "intro", type: S.text }, { name: "description", type: S.text }, { name: "address", type: S.text },
    { name: "checkinCount", type: S.integer }, { name: "visitCount", type: S.integer }, { name: "image", type: S.text },
    { name: "cover", type: S.text }, { name: "coverUrl", type: S.text }, { name: "shopId", type: S.short },
    { name: "latitude", type: S.number }, { name: "longitude", type: S.number }, { name: "coordType", type: S.short },
    { name: "status", type: S.short }, { name: "enabled", type: S.bool }, { name: "isShow", type: S.bool }, { name: "visible", type: S.bool }
  ]),
  series: withBase([
    { name: "spotId", type: S.short }, { name: "name", type: S.short }, { name: "intro", type: S.text },
    { name: "style", type: S.short }, { name: "productType", type: S.short }, { name: "soldCount", type: S.integer },
    { name: "minPrice", type: S.money }, { name: "maxPrice", type: S.money }, { name: "status", type: S.short },
    { name: "isHot", type: S.bool }, { name: "cover", type: S.text }, { name: "visible", type: S.bool }
  ]),
  albums: withBase([
    { name: "spotId", type: S.short }, { name: "seriesId", type: S.short }, { name: "name", type: S.short },
    { name: "price", type: S.money }, { name: "intro", type: S.text }, { name: "description", type: S.text },
    { name: "photoCount", type: S.integer }, { name: "shootingNotes", type: S.text }, { name: "status", type: S.short },
    { name: "isShow", type: S.bool }, { name: "isSellable", type: S.bool }, { name: "allowMaterialUse", type: S.bool },
    { name: "photoMaterialEnabled", type: S.bool }, { name: "videoMaterialEnabled", type: S.bool },
    { name: "cover", type: S.text }, { name: "visible", type: S.bool }
  ]),
  samples: withBase([
    { name: "name", type: S.short }, { name: "type", type: S.short }, { name: "mediaType", type: S.short },
    { name: "albumId", type: S.short }, { name: "seriesId", type: S.short }, { name: "spotId", type: S.short },
    { name: "status", type: S.short }, { name: "isShow", type: S.bool }, { name: "isShowcase", type: S.bool },
    { name: "isFeatured", type: S.bool }, { name: "isRecommend", type: S.bool }, { name: "url", type: S.text },
    { name: "image", type: S.text }, { name: "cover", type: S.text }, { name: "visible", type: S.bool }
  ]),
  packages: withBase([
    { name: "spotId", type: S.short }, { name: "seriesId", type: S.short }, { name: "albumId", type: S.short },
    { name: "name", type: S.short }, { name: "title", type: S.short }, { name: "type", type: S.short },
    { name: "productKind", type: S.short }, { name: "serviceType", type: S.short }, { name: "originalPrice", type: S.money },
    { name: "price", type: S.money }, { name: "specialPrice", type: S.money }, { name: "weekdayPrice", type: S.money },
    { name: "weekendSurcharge", type: S.money }, { name: "holidaySurcharge", type: S.money }, { name: "aerialExtraPrice", type: S.money },
    { name: "depositRatio", type: S.number }, { name: "duration", type: S.integer }, { name: "durationText", type: S.short },
    { name: "retouchCount", type: S.integer }, { name: "videoDuration", type: S.integer }, { name: "finishedVideoCount", type: S.integer },
    { name: "hasAerial", type: S.bool }, { name: "fullEdit", type: S.bool }, { name: "deliveryCycle", type: S.short },
    { name: "hotScore", type: S.number }, { name: "isHot", type: S.bool }, { name: "isMainPush", type: S.bool },
    { name: "mainPush", type: S.bool }, { name: "isShow", type: S.bool }, { name: "status", type: S.short },
    { name: "intro", type: S.text }, { name: "description", type: S.text }, { name: "cover", type: S.text },
    { name: "videoUrl", type: S.text }, { name: "previewVideoUrl", type: S.text }, { name: "isVideoSingle", type: S.bool },
    { name: "bookingLimit", type: S.integer }, { name: "advanceBookingDays", type: S.integer }, { name: "holidayQuota", type: S.integer },
    { name: "timeSlotLimit", type: S.integer }, { name: "scheduledOnAt", type: S.time }, { name: "scheduledOffAt", type: S.time },
    { name: "auditStatus", type: S.short }, { name: "auditType", type: S.short }, { name: "auditSubmitAt", type: S.time },
    { name: "auditSubmitter", type: S.short }, { name: "auditReviewer", type: S.short }, { name: "auditReviewedAt", type: S.time },
    { name: "auditRejectReason", type: S.text }, { name: "visible", type: S.bool }
  ]),
  addonServices: withBase([
    { name: "name", type: S.short }, { name: "category", type: S.short }, { name: "cate", type: S.short },
    { name: "price", type: S.money }, { name: "enabled", type: S.bool }, { name: "isShow", type: S.bool },
    { name: "intro", type: S.text }, { name: "description", type: S.text }, { name: "spotId", type: S.short },
    { name: "seriesId", type: S.short }, { name: "albumId", type: S.short }, { name: "eligibility", type: S.short },
    { name: "orderScope", type: S.short }, { name: "maxQuantity", type: S.integer }, { name: "holidaySurcharge", type: S.money },
    { name: "financeReviewRequired", type: S.bool }, { name: "includeInOrderAmount", type: S.bool }, { name: "status", type: S.short },
    { name: "visible", type: S.bool }
  ]),
  peripherals: withBase([
    { name: "name", type: S.short }, { name: "category", type: S.short }, { name: "cate", type: S.short },
    { name: "price", type: S.money }, { name: "enabled", type: S.bool }, { name: "isShow", type: S.bool },
    { name: "intro", type: S.text }, { name: "description", type: S.text }, { name: "image", type: S.text },
    { name: "cover", type: S.text }, { name: "mode", type: S.short }, { name: "spotId", type: S.short },
    { name: "stock", type: S.integer }, { name: "stockQty", type: S.integer }, { name: "isHot", type: S.bool },
    { name: "isNew", type: S.bool }, { name: "deliveryCycle", type: S.short }, { name: "scheduledOnAt", type: S.time },
    { name: "scheduledOffAt", type: S.time }, { name: "auditStatus", type: S.short }, { name: "auditType", type: S.short },
    { name: "auditSubmitAt", type: S.time }, { name: "auditSubmitter", type: S.short }, { name: "auditReviewer", type: S.short },
    { name: "auditReviewedAt", type: S.time }, { name: "auditRejectReason", type: S.text }, { name: "status", type: S.short },
    { name: "visible", type: S.bool }
  ]),
  tagLibrary: withBase([
    { name: "name", type: S.short }, { name: "category", type: S.short }, { name: "status", type: S.short },
    { name: "sort", type: S.integer }, { name: "scope", type: S.short }, { name: "color", type: S.short },
    { name: "description", type: S.text }
  ]),
  guides: withBase([
    { name: "name", type: S.short }, { name: "title", type: S.short }, { name: "description", type: S.text },
    { name: "intro", type: S.text }, { name: "status", type: S.short }, { name: "tag", type: S.short },
    { name: "spotId", type: S.short }, { name: "seriesId", type: S.short }, { name: "targetPackageId", type: S.short },
    { name: "isHot", type: S.bool }, { name: "readCount", type: S.integer }, { name: "score", type: S.number },
    { name: "cover", type: S.text }, { name: "image", type: S.text }, { name: "coverUrl", type: S.text },
    { name: "isShow", type: S.bool }, { name: "visible", type: S.bool }
  ]),
  stories: withBase([
    { name: "name", type: S.short }, { name: "title", type: S.short }, { name: "subtitle", type: S.short },
    { name: "description", type: S.text }, { name: "intro", type: S.text }, { name: "status", type: S.short },
    { name: "tag", type: S.short }, { name: "spotId", type: S.short }, { name: "seriesId", type: S.short },
    { name: "isHot", type: S.bool }, { name: "readCount", type: S.integer }, { name: "score", type: S.number },
    { name: "cover", type: S.text }, { name: "image", type: S.text }, { name: "isShow", type: S.bool },
    { name: "visible", type: S.bool }
  ]),
  scans: withBase([
    { name: "date", type: S.short }, { name: "hour", type: S.integer }, { name: "shopId", type: S.short },
    { name: "distributorId", type: S.short }, { name: "sourceType", type: S.short }, { name: "sourceName", type: S.short },
    { name: "scene", type: S.short }, { name: "openid", type: S.short }, { name: "orderId", type: S.short },
    { name: "status", type: S.short }
  ]),
  orders: withBase([
    { name: "orderNo", type: S.short }, { name: "bookingIdempotencyKey", type: S.key }, { name: "openid", type: S.short }, { name: "_openid", type: S.short },
    { name: "customer", type: S.text }, { name: "name", type: S.short }, { name: "contactName", type: S.short },
    { name: "phone", type: S.short }, { name: "contactPhone", type: S.short }, { name: "customerPhone", type: S.short },
    { name: "wechat", type: S.short }, { name: "contactWechat", type: S.short }, { name: "customerWechat", type: S.short },
    { name: "shopId", type: S.short }, { name: "shopCode", type: S.short }, { name: "distributorId", type: S.short },
    { name: "sourceType", type: S.short }, { name: "sourceName", type: S.short }, { name: "sourceScene", type: S.short },
    { name: "sourceChannel", type: S.short }, { name: "sourceCodeId", type: S.short }, { name: "scene", type: S.short },
    { name: "spotId", type: S.short }, { name: "spotName", type: S.short }, { name: "seriesId", type: S.short },
    { name: "seriesName", type: S.short }, { name: "packageId", type: S.short }, { name: "packageName", type: S.short },
    { name: "date", type: S.short }, { name: "appointmentAt", type: S.time }, { name: "bookingDate", type: S.short },
    { name: "bookingTime", type: S.short }, { name: "timePeriod", type: S.short }, { name: "timeSlot", type: S.short },
    { name: "time", type: S.short }, { name: "message", type: S.text }, { name: "price", type: S.money },
    { name: "totalPrice", type: S.money }, { name: "totalAmount", type: S.money }, { name: "depositRatio", type: S.number }, { name: "depositDue", type: S.money }, { name: "finalDue", type: S.money },
    { name: "depositPaid", type: S.money }, { name: "depositPaidAt", type: S.time }, { name: "depositConfirmedAt", type: S.time }, { name: "depositConfirmedBy", type: S.ref }, { name: "finalPaid", type: S.money },
    { name: "finalPaidAt", type: S.time }, { name: "finalConfirmedAt", type: S.time }, { name: "finalConfirmedBy", type: S.ref }, { name: "finalDiscountAmount", type: S.money }, { name: "finalDiscountReason", type: S.text },
    { name: "priceAdjustReason", type: S.text }, { name: "bookingMode", type: S.short }, { name: "status", type: S.short },
    { name: "customerStatus", type: S.short }, { name: "workflowStage", type: S.status }, { name: "dispatchStatus", type: S.status }, { name: "depositRefundable", type: S.bool }, { name: "depositRefundableAt", type: S.time }, { name: "assigneeId", type: S.short }, { name: "serviceUser", type: S.short },
    { name: "serviceUserId", type: S.short }, { name: "photographer", type: S.short }, { name: "photographerId", type: S.short },
    { name: "photographerCommissionRate", type: S.number }, { name: "completedAt", type: S.time }, { name: "deliveredAt", type: S.time }, { name: "deliveredBy", type: S.ref }, { name: "deliveryMethod", type: S.status },
    { name: "finishedAt", type: S.time }, { name: "completedTime", type: S.time }, { name: "serviceNote", type: S.text },
    { name: "deliveryNote", type: S.text }, { name: "customerRemark", type: S.text }, { name: "internalNote", type: S.text },
    { name: "paymentVerify", type: S.short }, { name: "depositFinanceStatus", type: S.short }, { name: "finalFinanceStatus", type: S.short }, { name: "depositPaymentStatus", type: S.status }, { name: "finalPaymentStatus", type: S.status },
    { name: "financeStatus", type: S.short }, { name: "refundAmount", type: S.money }, { name: "refundConfirmed", type: S.bool },
    // Workflow detail facts below deliberately use lxm_collection_values.
    // The established orders table is already wide on MySQL 5.7; storing these
    // sparse values as typed leaves avoids a row-size migration failure while
    // retaining their document keys during split/hydrate.
    { name: "afterSaleStatus", type: S.short }, { name: "afterSaleReason", type: S.text }, { name: "afterSaleCreateTime", type: S.time },
    { name: "afterSaleId", type: S.short }, { name: "riskBlocked", type: S.bool }, { name: "riskFlag", type: S.short },
    { name: "frozen", type: S.bool }, { name: "freezeReason", type: S.text }, { name: "riskReason", type: S.text },
    { name: "settlementObservationReleased", type: S.bool }, { name: "settlementObservationReleasedAt", type: S.time },
    { name: "settlementObservationReleasedBy", type: S.short }, { name: "createdBy", type: S.short }, { name: "createdById", type: S.short },
    { name: "createTime", type: S.time }, { name: "updateTime", type: S.time }, { name: "updatedAt", type: S.time }
  ]),
  afterSales: withBase([
    { name: "orderId", type: S.short }, { name: "orderNo", type: S.short }, { name: "openid", type: S.short },
    { name: "type", type: S.short }, { name: "customer", type: S.text }, { name: "packageName", type: S.short },
    { name: "reason", type: S.text }, { name: "status", type: S.short }, { name: "customerVisibleStatus", type: S.short },
    { name: "submitSource", type: S.short }, { name: "assigneeId", type: S.short }, { name: "refundAmount", type: S.money },
    { name: "amount", type: S.money }, { name: "refundConfirmed", type: S.bool }, { name: "financeStatus", type: S.short },
    { name: "approvedBy", type: S.short }, { name: "approvedAt", type: S.time }, { name: "financeReviewedBy", type: S.short },
    { name: "financeReviewedAt", type: S.time }, { name: "createdBy", type: S.short }, { name: "createdById", type: S.short },
    { name: "createdAt", type: S.time }, { name: "updatedAt", type: S.time }
  ]),
  reconciliationTransfers: withBase([
    { name: "key", type: S.short }, { name: "month", type: S.short }, { name: "period", type: S.short },
    { name: "settlementCycle", type: S.short }, { name: "objectType", type: S.short }, { name: "objectId", type: S.short },
    { name: "objectName", type: S.short }, { name: "amount", type: S.money }, { name: "status", type: S.short },
    { name: "operator", type: S.short }, { name: "operatorId", type: S.short }, { name: "time", type: S.time },
    { name: "method", type: S.short }, { name: "voucherNo", type: S.short }, { name: "note", type: S.text },
    { name: "payStatus", type: S.short }, { name: "paidBy", type: S.short }, { name: "paidAt", type: S.time },
    { name: "sealedBy", type: S.short }, { name: "sealedAt", type: S.time }, { name: "sealNote", type: S.text },
    { name: "unsealedBy", type: S.short }, { name: "unsealedAt", type: S.time }, { name: "unsealNote", type: S.text }
  ]),
  financeSettings: withBase([
    { name: "settlementObservationDays", type: S.integer }, { name: "largeSettlementThreshold", type: S.money },
    { name: "currency", type: S.short }
  ], { lifecycle: false }),
  monthlyClosings: withBase([
    { name: "month", type: S.short }, { name: "status", type: S.short }, { name: "operator", type: S.short },
    { name: "operatorId", type: S.short }, { name: "time", type: S.time }, { name: "note", type: S.text },
    { name: "unlockedBy", type: S.short }, { name: "unlockedAt", type: S.time }
  ]),
  adjustmentRecords: withBase([
    { name: "orderNo", type: S.short }, { name: "orderId", type: S.short }, { name: "time", type: S.time },
    { name: "type", type: S.short }, { name: "amount", type: S.money }, { name: "targetType", type: S.short },
    { name: "targetName", type: S.short }, { name: "operator", type: S.short }, { name: "operatorId", type: S.short },
    { name: "approvalStatus", type: S.short }, { name: "approvedBy", type: S.short }, { name: "approvedAt", type: S.time },
    { name: "note", type: S.text }, { name: "attachment", type: S.text }, { name: "offsetStatus", type: S.short }
  ]),
  homeConfig: withBase([
    { name: "activity", type: S.short }, { name: "cityName", type: S.short }, { name: "shopServiceText", type: S.short },
    { name: "heroSubtitle", type: S.text }, { name: "trustOrders", type: S.integer }, { name: "trustRate", type: S.short },
    { name: "notice", type: S.text }, { name: "updatedAt", type: S.time }
  ], { lifecycle: false }),
  logs: withBase([
    { name: "time", type: S.time }, { name: "user", type: S.short }, { name: "operator", type: S.short },
    { name: "operatorId", type: S.short }, { name: "action", type: S.short }, { name: "target", type: S.short },
    { name: "targetType", type: S.short }, { name: "targetId", type: S.short }, { name: "detail", type: S.text },
    { name: "module", type: S.short }, { name: "level", type: S.short }, { name: "amount", type: S.short },
    // `snapshot` is kept as a public API field, but structured order
    // snapshots are stored in log_order_exception_snapshots. Plain text audit
    // summaries use a bounded scalar column instead of a JSON blob.
    { name: "objectType", type: S.short }, { name: "objectName", type: S.short }, { name: "snapshotText", type: "VARCHAR(500) NULL" },
    { name: "source", type: S.short }, { name: "createTime", type: S.time }
  ]),
  trash: withBase([
    { name: "refId", type: S.short }, { name: "sourceKey", type: S.short }, { name: "sourceId", type: S.short },
    { name: "type", type: S.short }, { name: "name", type: S.short }, { name: "reason", type: S.text },
    { name: "operator", type: S.short }, { name: "operatorId", type: S.short }, { name: "time", type: S.time },
    { name: "deletedAt", type: S.time }, { name: "restorable", type: S.bool }
  ]),
  merchantCodes: withBase([
    { name: "shopId", type: S.short }, { name: "shopName", type: S.short }, { name: "distributorId", type: S.short },
    { name: "placementType", type: S.short }, { name: "placementLabel", type: S.short }, { name: "scene", type: S.short },
    { name: "scanCount", type: S.integer }, { name: "orderCount", type: S.integer }, { name: "dealCount", type: S.integer },
    { name: "qrImage", type: S.text }, { name: "status", type: S.short }, { name: "createTime", type: S.time },
    { name: "lastScanTime", type: S.time }
  ]),
  siteConfig: withBase([
    { name: "customPrice_baseHours", type: S.number }, { name: "customPrice_singlePersonPrice", type: S.money },
    { name: "customPrice_perExtraPerson", type: S.money }, { name: "customPrice_note", type: S.text },
    { name: "privacyText", type: S.text }, { name: "wechatCorpId", type: S.short }, { name: "wechatAppId", type: S.short },
    { name: "wechatGuideText", type: S.text }, { name: "footprintEnabled", type: S.bool }, { name: "footprintTotal", type: S.integer },
    { name: "footprintTitle", type: S.short }, { name: "footprintRewardText", type: S.text }, { name: "updatedAt", type: S.time }
  ], { lifecycle: false }),
  userProfiles: withBase([
    { name: "openid", type: S.short }, { name: "unionid", type: S.short }, { name: "phone", type: S.short },
    { name: "dev", type: S.bool }, { name: "nickname", type: S.short }, { name: "avatarUrl", type: S.text },
    { name: "updateTime", type: S.time }
  ], { lifecycle: false }),
  config: withBase([
    { name: "configKey", type: S.short }, { name: "valueText", type: S.text }, { name: "valueNumber", type: S.number },
    { name: "valueBool", type: S.bool }, { name: "status", type: S.short }, { name: "updatedAt", type: S.time }
  ], { lifecycle: false })
};

const RELATIONS = {
  account_permissions: {
    table: "lxm_account_permissions",
    columns: ["collection_name VARCHAR(32) NOT NULL", "account_id VARCHAR(128) NOT NULL", "permission_key VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (collection_name, account_id, permission_key)",
    indexes: ["KEY idx_account_permission (collection_name, permission_key)"],
    collections: ["agents", "distributors", "shops", "staff"]
  },
  shop_distributors: {
    table: "lxm_shop_distributors",
    columns: ["shop_id VARCHAR(128) NOT NULL", "distributor_id VARCHAR(128) NOT NULL", "rate DECIMAL(7,4) NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (shop_id, distributor_id)",
    indexes: ["KEY idx_shop_distributor_distributor (distributor_id)"]
  },
  shop_agents: {
    table: "lxm_shop_agents",
    columns: ["shop_id VARCHAR(128) NOT NULL", "agent_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (shop_id, agent_id)",
    indexes: ["KEY idx_shop_agent_agent (agent_id)"]
  },
  series_spots: {
    table: "lxm_series_spots",
    columns: ["series_id VARCHAR(128) NOT NULL", "spot_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (series_id, spot_id)"
  },
  album_samples: {
    table: "lxm_album_samples",
    columns: ["album_id VARCHAR(128) NOT NULL", "sample_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (album_id, sample_id)",
    indexes: ["KEY idx_album_sample_sample (sample_id)"]
  },
  album_tags: {
    table: "lxm_album_tags",
    columns: ["album_id VARCHAR(128) NOT NULL", "tag VARCHAR(255) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (album_id, tag)"
  },
  package_spots: {
    table: "lxm_package_spots",
    columns: ["package_id VARCHAR(128) NOT NULL", "spot_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (package_id, spot_id)"
  },
  package_tags: {
    table: "lxm_package_tags",
    columns: ["package_id VARCHAR(128) NOT NULL", "tag_type VARCHAR(32) NOT NULL", "tag VARCHAR(255) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (package_id, tag_type, tag)"
  },
  package_exclusions: {
    table: "lxm_package_exclusions",
    columns: ["package_id VARCHAR(128) NOT NULL", "excluded_package_id VARCHAR(128) NOT NULL", "relation_type VARCHAR(32) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (package_id, excluded_package_id, relation_type)"
  },
  package_included_items: {
    table: "lxm_package_included_items",
    columns: ["package_id VARCHAR(128) NOT NULL", "item_no INT NOT NULL", "item_type VARCHAR(32) NULL", "item_name VARCHAR(255) NULL", "item_price DECIMAL(18,2) NULL", "target_page VARCHAR(128) NULL", "target_product_id VARCHAR(128) NULL", "target_series_id VARCHAR(128) NULL", "target_album_id VARCHAR(128) NULL", "target_spot_id VARCHAR(128) NULL"],
    primary: "PRIMARY KEY (package_id, item_no)"
  },
  addon_package_defaults: {
    table: "lxm_addon_package_defaults",
    columns: ["addon_id VARCHAR(128) NOT NULL", "package_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (addon_id, package_id)"
  },
  peripheral_spots: {
    table: "lxm_peripheral_spots",
    columns: ["peripheral_id VARCHAR(128) NOT NULL", "spot_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (peripheral_id, spot_id)"
  },
  peripheral_specs: {
    table: "lxm_peripheral_specs",
    columns: ["peripheral_id VARCHAR(128) NOT NULL", "spec_no INT NOT NULL", "spec_text VARCHAR(255) NOT NULL"],
    primary: "PRIMARY KEY (peripheral_id, spec_no)"
  },
  peripheral_images: {
    table: "lxm_peripheral_images",
    columns: ["peripheral_id VARCHAR(128) NOT NULL", "image_no INT NOT NULL", "image_url TEXT NULL"],
    primary: "PRIMARY KEY (peripheral_id, image_no)"
  },
  order_contacts: {
    table: "lxm_order_contacts",
    columns: ["order_id VARCHAR(128) NOT NULL", "contact_no INT NOT NULL", "phone VARCHAR(64) NULL", "wechat VARCHAR(255) NULL"],
    primary: "PRIMARY KEY (order_id, contact_no)"
  },
  order_source: {
    table: "lxm_order_source",
    columns: ["order_id VARCHAR(128) NOT NULL", "shop_id VARCHAR(128) NULL", "distributor_id VARCHAR(128) NULL", "scene VARCHAR(255) NULL", "source_type VARCHAR(64) NULL", "channel VARCHAR(64) NULL", "code_id VARCHAR(128) NULL"],
    primary: "PRIMARY KEY (order_id)"
  },
  order_package_snapshot: {
    table: "lxm_order_package_snapshot",
    columns: ["order_id VARCHAR(128) NOT NULL", "snapshot_id VARCHAR(128) NULL", "package_id VARCHAR(128) NULL", "name VARCHAR(255) NULL", "original_price DECIMAL(18,2) NULL", "price DECIMAL(18,2) NULL", "is_main_push TINYINT(1) NULL"],
    primary: "PRIMARY KEY (order_id)"
  },
  order_package_snapshot_tags: {
    table: "lxm_order_package_snapshot_tags",
    columns: ["order_id VARCHAR(128) NOT NULL", "tag_no INT NOT NULL", "tag VARCHAR(255) NOT NULL"],
    primary: "PRIMARY KEY (order_id, tag_no)"
  },
  order_products: {
    table: "lxm_order_products",
    columns: ["order_id VARCHAR(128) NOT NULL", "item_no INT NOT NULL", "product_id VARCHAR(128) NULL", "product_type VARCHAR(64) NULL", "package_id VARCHAR(128) NULL", "peripheral_id VARCHAR(128) NULL", "price DECIMAL(18,2) NULL", "quantity DECIMAL(12,3) NULL", "spot_id VARCHAR(128) NULL", "series_id VARCHAR(128) NULL", "album_id VARCHAR(128) NULL", "name VARCHAR(255) NULL"],
    primary: "PRIMARY KEY (order_id, item_no)",
    indexes: ["KEY idx_order_product (product_id, product_type)"]
  },
  order_product_snapshots: {
    table: "lxm_order_product_snapshots",
    columns: ["order_id VARCHAR(128) NOT NULL", "item_no INT NOT NULL", "snapshot_id VARCHAR(128) NULL", "name VARCHAR(255) NULL", "original_price DECIMAL(18,2) NULL", "price DECIMAL(18,2) NULL", "is_main_push TINYINT(1) NULL"],
    primary: "PRIMARY KEY (order_id, item_no)"
  },
  order_product_snapshot_tags: {
    table: "lxm_order_product_snapshot_tags",
    columns: ["order_id VARCHAR(128) NOT NULL", "item_no INT NOT NULL", "tag_no INT NOT NULL", "tag VARCHAR(255) NOT NULL"],
    primary: "PRIMARY KEY (order_id, item_no, tag_no)"
  },
  order_addons: {
    table: "lxm_order_addons",
    columns: ["order_id VARCHAR(128) NOT NULL", "item_no INT NOT NULL", "addon_id VARCHAR(128) NULL", "addon_type VARCHAR(64) NULL", "name VARCHAR(255) NULL", "price DECIMAL(18,2) NULL", "quantity DECIMAL(12,3) NULL"],
    primary: "PRIMARY KEY (order_id, item_no)"
  },
  order_status_logs: {
    table: "lxm_order_status_logs",
    columns: ["order_id VARCHAR(128) NOT NULL", "log_no INT NOT NULL", "time VARCHAR(64) NULL", "operator VARCHAR(255) NULL", "operator_id VARCHAR(128) NULL", "action TEXT NULL", "type VARCHAR(64) NULL", "from_status VARCHAR(64) NULL", "to_status VARCHAR(64) NULL", "create_time VARCHAR(64) NULL"],
    primary: "PRIMARY KEY (order_id, log_no)"
  },
  order_follow_records: {
    table: "lxm_order_follow_records",
    columns: ["order_id VARCHAR(128) NOT NULL", "record_no INT NOT NULL", "type VARCHAR(64) NULL", "action TEXT NULL", "operator VARCHAR(255) NULL", "operator_id VARCHAR(128) NULL", "note TEXT NULL", "reason TEXT NULL", "from_status VARCHAR(64) NULL", "to_status VARCHAR(64) NULL", "create_time VARCHAR(64) NULL"],
    primary: "PRIMARY KEY (order_id, record_no)"
  },
  order_payment_records: {
    table: "lxm_order_payment_records",
    columns: [
      "order_id VARCHAR(128) NOT NULL", "record_no INT NOT NULL", "payment_id VARCHAR(128) NULL",
      "phase VARCHAR(32) NULL", "payment_type VARCHAR(64) NULL", "amount DECIMAL(18,2) NULL", "status VARCHAR(64) NULL",
      "attempt INT NULL", "provider VARCHAR(64) NULL", "idempotency_key VARCHAR(128) NULL", "confirmation_idempotency_key VARCHAR(128) NULL",
      "external_transaction_id VARCHAR(160) NULL", "operator VARCHAR(255) NULL", "operator_id VARCHAR(128) NULL",
      "paid_at VARCHAR(64) NULL", "record_created_at VARCHAR(64) NULL", "record_updated_at VARCHAR(64) NULL", "admin_registered_at VARCHAR(64) NULL", "note TEXT NULL"
    ],
    primary: "PRIMARY KEY (order_id, record_no)",
    indexes: [
      "KEY idx_order_payment_phase (order_id, phase)",
      "UNIQUE KEY uq_order_payment_id (payment_id)",
      "UNIQUE KEY uq_order_payment_idempotency (idempotency_key)",
      "UNIQUE KEY uq_order_payment_confirmation_key (confirmation_idempotency_key)",
      "UNIQUE KEY uq_order_payment_transaction (external_transaction_id)"
    ]
  },
  log_order_exception_snapshots: {
    table: "lxm_log_order_exception_snapshots",
    columns: [
      "log_id VARCHAR(128) NOT NULL",
      "before_status VARCHAR(64) NULL", "after_status VARCHAR(64) NULL",
      "before_customer_status VARCHAR(64) NULL", "after_customer_status VARCHAR(64) NULL",
      "before_source_type VARCHAR(64) NULL", "after_source_type VARCHAR(64) NULL",
      "before_shop_id VARCHAR(128) NULL", "after_shop_id VARCHAR(128) NULL",
      "before_distributor_id VARCHAR(128) NULL", "after_distributor_id VARCHAR(128) NULL",
      "before_risk_blocked TINYINT(1) NULL", "after_risk_blocked TINYINT(1) NULL"
    ],
    primary: "PRIMARY KEY (log_id)"
  },
  after_sale_logs: {
    table: "lxm_after_sale_logs",
    columns: ["after_sale_id VARCHAR(128) NOT NULL", "log_no INT NOT NULL", "message TEXT NULL", "time VARCHAR(64) NULL", "operator VARCHAR(255) NULL", "operator_id VARCHAR(128) NULL"],
    primary: "PRIMARY KEY (after_sale_id, log_no)"
  },
  transfer_orders: {
    table: "lxm_reconciliation_transfer_orders",
    columns: ["transfer_id VARCHAR(128) NOT NULL", "order_no INT NOT NULL", "order_id VARCHAR(128) NULL", "order_number VARCHAR(128) NULL"],
    primary: "PRIMARY KEY (transfer_id, order_no)",
    indexes: ["KEY idx_transfer_order_id (order_id)"]
  },
  home_modules: {
    table: "lxm_home_modules",
    columns: ["config_id VARCHAR(128) NOT NULL", "module_key VARCHAR(128) NOT NULL", "title VARCHAR(255) NULL", "subtitle VARCHAR(255) NULL", "more_text VARCHAR(255) NULL", "enabled TINYINT(1) NULL", "visible TINYINT(1) NULL", "sort_no INT NULL"],
    primary: "PRIMARY KEY (config_id, module_key)"
  },
  home_ids: {
    table: "lxm_home_ids",
    columns: ["config_id VARCHAR(128) NOT NULL", "group_key VARCHAR(128) NOT NULL", "item_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (config_id, group_key, item_id)"
  },
  home_quick_nav: {
    table: "lxm_home_quick_nav",
    columns: ["config_id VARCHAR(128) NOT NULL", "nav_no INT NOT NULL", "target_type VARCHAR(128) NULL", "label VARCHAR(255) NULL", "icon VARCHAR(255) NULL"],
    primary: "PRIMARY KEY (config_id, nav_no)"
  },
  home_banners: {
    table: "lxm_home_banners",
    columns: ["config_id VARCHAR(128) NOT NULL", "banner_group VARCHAR(32) NOT NULL", "banner_no INT NOT NULL", "banner_id VARCHAR(128) NULL", "type VARCHAR(32) NULL", "url TEXT NULL", "cover TEXT NULL", "title VARCHAR(255) NULL", "target_type VARCHAR(128) NULL", "target_id VARCHAR(128) NULL", "link_url TEXT NULL", "effective_time VARCHAR(64) NULL"],
    primary: "PRIMARY KEY (config_id, banner_group, banner_no)"
  },
  home_page_modules: {
    table: "lxm_home_page_modules",
    columns: ["config_id VARCHAR(128) NOT NULL", "page_key VARCHAR(128) NOT NULL", "module_key VARCHAR(128) NOT NULL", "title VARCHAR(255) NULL", "enabled TINYINT(1) NULL", "sort_no INT NULL"],
    primary: "PRIMARY KEY (config_id, page_key, module_key)"
  },
  home_page_links: {
    table: "lxm_home_page_links",
    columns: ["config_id VARCHAR(128) NOT NULL", "page_key VARCHAR(128) NOT NULL", "link_type VARCHAR(64) NOT NULL", "item_id VARCHAR(128) NOT NULL", "sort_no INT NOT NULL DEFAULT 0"],
    primary: "PRIMARY KEY (config_id, page_key, link_type, item_id)"
  },
  site_booking_notices: {
    table: "lxm_site_booking_notices",
    columns: ["config_id VARCHAR(128) NOT NULL", "notice_no INT NOT NULL", "notice_text TEXT NOT NULL"],
    primary: "PRIMARY KEY (config_id, notice_no)"
  },
  site_hotwords: {
    table: "lxm_site_hotwords",
    columns: ["config_id VARCHAR(128) NOT NULL", "word_no INT NOT NULL", "word VARCHAR(255) NOT NULL"],
    primary: "PRIMARY KEY (config_id, word_no)"
  },
  trash_source_attributes: {
    table: "lxm_trash_source_attributes",
    columns: ["trash_id VARCHAR(128) NOT NULL", "path VARCHAR(512) NOT NULL", "ordinal INT NOT NULL DEFAULT 0", "value_type VARCHAR(16) NOT NULL", "value_text TEXT NULL", "value_number DECIMAL(20,6) NULL", "value_bool TINYINT(1) NULL", "value_time VARCHAR(64) NULL"],
    primary: "PRIMARY KEY (trash_id, path, ordinal)",
    indexes: ["KEY idx_trash_attr_path (path)"]
  },
  collection_values: {
    table: "lxm_collection_values",
    columns: ["collection_name VARCHAR(64) NOT NULL", "record_id VARCHAR(128) NOT NULL", "path VARCHAR(512) NOT NULL", "ordinal INT NOT NULL DEFAULT 0", "value_type VARCHAR(16) NOT NULL", "value_text TEXT NULL", "value_number DECIMAL(20,6) NULL", "value_bool TINYINT(1) NULL", "value_time VARCHAR(64) NULL"],
    primary: "PRIMARY KEY (collection_name, record_id, path, ordinal)",
    indexes: ["KEY idx_business_attr_path (collection_name, path)"]
  }
};

const RELATION_BY_KEY = {
  agents: ["account_permissions"],
  distributors: ["account_permissions"],
  shops: ["account_permissions", "shop_distributors", "shop_agents"],
  staff: ["account_permissions"],
  series: ["series_spots"],
  albums: ["album_samples", "album_tags"],
  packages: ["package_spots", "package_tags", "package_exclusions", "package_included_items"],
  addonServices: ["addon_package_defaults"],
  peripherals: ["peripheral_spots", "peripheral_specs", "peripheral_images"],
  orders: ["order_contacts", "order_source", "order_package_snapshot", "order_package_snapshot_tags", "order_products", "order_product_snapshots", "order_product_snapshot_tags", "order_addons", "order_status_logs", "order_follow_records", "order_payment_records"],
  afterSales: ["after_sale_logs"],
  logs: ["log_order_exception_snapshots"],
  reconciliationTransfers: ["transfer_orders"],
  homeConfig: ["home_modules", "home_ids", "home_quick_nav", "home_banners", "home_page_modules", "home_page_links"],
  siteConfig: ["site_booking_notices", "site_hotwords"],
  trash: ["trash_source_attributes"]
};

const COLLECTION_VALUES_TABLE = "lxm_collection_values";
const RELATION_TABLES = Object.freeze(Object.fromEntries(Object.entries(RELATIONS).map(([name, definition]) => [name, definition.table])));

const AUTH_ATTRIBUTE_TABLES = Object.freeze({
  menus: "lxm_auth_menu_attributes",
  users: "lxm_auth_user_attributes"
});

// Companion auth projections used during cutover from the legacy flexible
// columns. The existing role/menu grant tables remain compatible; these two
// projections make menu metadata and user subject bindings scalar-only.
const AUTH_NORMALIZED = {
  menus: {
    table: "lxm_auth_menus_normalized",
    columns: [
      "id VARCHAR(64) NOT NULL", "menu_key VARCHAR(128) NOT NULL", "parent_key VARCHAR(128) NULL",
      "name VARCHAR(128) NOT NULL", "path VARCHAR(255) NOT NULL", "icon VARCHAR(64) NULL",
      "sort_no INT NOT NULL DEFAULT 0", "status VARCHAR(32) NOT NULL DEFAULT 'active'",
      "group_name VARCHAR(128) NULL", "menu_type VARCHAR(32) NOT NULL DEFAULT 'menu'", "route_key VARCHAR(128) NULL"
    ],
    primary: "PRIMARY KEY (id)",
    indexes: ["UNIQUE KEY uq_auth_menu_normalized_key (menu_key)", "KEY idx_auth_menu_normalized_parent (parent_key)"]
  },
  users: {
    table: "lxm_auth_users_normalized",
    columns: [
      "id VARCHAR(64) NOT NULL", "account VARCHAR(128) NOT NULL", "display_name VARCHAR(128) NOT NULL",
      "password_hash VARCHAR(255) NOT NULL", "role_id VARCHAR(64) NOT NULL", "status VARCHAR(32) NOT NULL DEFAULT 'active'",
      "phone VARCHAR(64) NULL", "email VARCHAR(255) NULL", "subject_type VARCHAR(32) NULL", "subject_id VARCHAR(128) NULL",
      "legacy_key VARCHAR(64) NULL", "legacy_id VARCHAR(128) NULL", "shop_id VARCHAR(128) NULL",
      "distributor_id VARCHAR(128) NULL", "agent_id VARCHAR(128) NULL"
    ],
    primary: "PRIMARY KEY (id)",
    indexes: ["UNIQUE KEY uq_auth_user_normalized_account (account)", "KEY idx_auth_user_normalized_role (role_id)", "KEY idx_auth_user_normalized_subject (subject_type, subject_id)"]
  }
};

// Canonical authorization tables used by the live permission store.  They are
// kept here as part of the schema source so an automatic MySQL bootstrap cannot
// create business tables without the matching scalar auth tables.
const AUTH_CORE = Object.freeze({
  menus: "lxm_auth_menus",
  roles: "lxm_auth_roles",
  roleMenus: "lxm_auth_role_menus",
  rolePermissions: "lxm_auth_role_permissions",
  userPermissions: "lxm_auth_user_permissions",
  users: "lxm_auth_users"
});

function authCoreStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS \`${AUTH_CORE.menus}\` (id VARCHAR(128) NOT NULL, menu_key VARCHAR(128) NOT NULL, parent_key VARCHAR(128) NULL, name VARCHAR(128) NOT NULL, path VARCHAR(255) NOT NULL, icon VARCHAR(64) NULL, sort_no INT NOT NULL DEFAULT 0, status VARCHAR(32) NOT NULL DEFAULT 'active', meta_group VARCHAR(64) NULL, meta_type VARCHAR(64) NULL, meta_label VARCHAR(128) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(id), UNIQUE KEY uq_auth_menu_key(menu_key), KEY idx_auth_menu_parent(parent_key), KEY idx_auth_menu_status(status)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS \`${AUTH_CORE.roles}\` (id VARCHAR(128) NOT NULL, role_key VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', description VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(id), UNIQUE KEY uq_auth_role_key(role_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS \`${AUTH_CORE.roleMenus}\` (role_id VARCHAR(128) NOT NULL, menu_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(role_id,menu_key), KEY idx_auth_rm_menu(menu_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS \`${AUTH_CORE.rolePermissions}\` (role_id VARCHAR(128) NOT NULL, permission_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(role_id,permission_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS \`${AUTH_CORE.userPermissions}\` (user_id VARCHAR(128) NOT NULL, permission_key VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(user_id,permission_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS \`${AUTH_CORE.users}\` (id VARCHAR(128) NOT NULL, account VARCHAR(128) NOT NULL, display_name VARCHAR(128) NOT NULL, password_hash VARCHAR(255) NOT NULL, role_id VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', phone VARCHAR(64) NULL, email VARCHAR(255) NULL, legacy_key VARCHAR(64) NULL, legacy_id VARCHAR(128) NULL, subject_type VARCHAR(64) NULL, subject_id VARCHAR(128) NULL, shop_id VARCHAR(128) NULL, distributor_id VARCHAR(128) NULL, agent_id VARCHAR(128) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(id), UNIQUE KEY uq_auth_user_account(account), KEY idx_auth_user_role(role_id), KEY idx_auth_user_status(status), KEY idx_auth_user_subject(subject_type,subject_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];
}

function assertKey(key) {
  if (!KEY_SET.has(key)) {
    const error = new Error("不支持的数据集合");
    error.code = "DATA_KEY_INVALID";
    throw error;
  }
  return key;
}
function tableName(key) { return `lxm_${assertKey(key)}`; }
function definition(key) { return COLLECTIONS[assertKey(key)]; }
function relationNames(key) { return (RELATION_BY_KEY[key] || []).slice(); }
function relationDefinition(name) {
  if (!RELATIONS[name]) throw new Error(`未知关系表: ${name}`);
  return RELATIONS[name];
}

function quoteIdentifier(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_]+$/.test(text)) throw new Error("非法标识符");
  return `\`${text}\``;
}

function statementForTable(table, defs, options = {}) {
  const body = defs.columns.slice();
  if (defs.primary) body.push(defs.primary);
  (defs.indexes || []).forEach((index) => body.push(index));
  if (options.audit !== false) {
    body.push("created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
    body.push("updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (\n  ${body.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

function schemaStatements() {
  const statements = ["CREATE TABLE IF NOT EXISTS `lxm_schema_version` (version INT NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"];
  for (const key of ALL_KEYS) {
    const def = definition(key);
    const cols = def.columns.map((item) => `${quoteIdentifier(item.name)} ${item.type}`);
    cols.push("PRIMARY KEY (`id`)", "KEY `idx_updated_at` (`updatedAt`)");
    statements.push(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(def.table || tableName(key))} (\n  ${cols.join(",\n  ")},\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  for (const relation of Object.values(RELATIONS)) {
    statements.push(statementForTable(relation.table, relation, { audit: relation !== RELATIONS.collection_values && relation !== RELATIONS.account_permissions }));
  }
  statements.push(...authCoreStatements());
  for (const auth of Object.values(AUTH_NORMALIZED)) statements.push(statementForTable(auth.table, auth, { audit: true }));
  statements.push(
    "CREATE TABLE IF NOT EXISTS `lxm_auth_menu_attributes` (\n  `menu_id` VARCHAR(128) NOT NULL,\n  `attribute_key` VARCHAR(128) NOT NULL,\n  `ordinal` INT NOT NULL DEFAULT 0,\n  `value_type` VARCHAR(16) NOT NULL,\n  `value_text` TEXT NULL,\n  `value_number` DECIMAL(20,6) NULL,\n  `value_bool` TINYINT(1) NULL,\n  PRIMARY KEY (`menu_id`, `attribute_key`, `ordinal`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS `lxm_auth_user_attributes` (\n  `user_id` VARCHAR(128) NOT NULL,\n  `attribute_key` VARCHAR(128) NOT NULL,\n  `ordinal` INT NOT NULL DEFAULT 0,\n  `value_type` VARCHAR(16) NOT NULL,\n  `value_text` TEXT NULL,\n  `value_number` DECIMAL(20,6) NULL,\n  `value_bool` TINYINT(1) NULL,\n  PRIMARY KEY (`user_id`, `attribute_key`, `ordinal`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
  );
  return statements;
}

async function ensureSchema(conn) {
  if (!conn || typeof conn.query !== "function") throw new TypeError("需要 MySQL connection");
  for (const sql of schemaStatements()) await conn.query(sql);
  return { version: 2, tables: schemaStatements().length };
}

function fieldMap(key) {
  const map = new Map(definition(key).columns.map((item) => [item.name, item.type]));
  return map;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (value && typeof value === "object") return "object";
  return "undefined";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const LOG_SNAPSHOT_KEYS = Object.freeze(["status", "customerStatus", "sourceType", "shopId", "distributorId", "riskBlocked"]);
const LOG_SNAPSHOT_KEY_SET = new Set(LOG_SNAPSHOT_KEYS);

// Order exception snapshots historically arrived as a JSON string on the
// public log object. Keep that wire shape, but only accept the known six
// before/after fields and materialize them into a dedicated relation table.
function normalizeLogSnapshot(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (value === undefined || value === null || value === "") return { kind: "text", text: value == null ? "" : String(value) };
  let parsed = value;
  let parsedFromJson = false;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { kind: "text", text: String(value) };
    try { parsed = JSON.parse(text); parsedFromJson = true; }
    catch (_) { return { kind: "text", text: String(value) }; }
  }
  if (!parsed || typeof parsed !== "object") return { kind: "text", text: String(value) };
  if (Array.isArray(parsed)) {
    const error = new Error("日志快照数组结构不受支持"); error.code = parsedFromJson ? "LOG_SNAPSHOT_UNSUPPORTED" : "LOG_SNAPSHOT_INVALID"; throw error;
  }
  const sides = {};
  for (const side of ["before", "after"]) {
    const source = parsed[side];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      const error = new Error("日志快照结构无效"); error.code = "LOG_SNAPSHOT_INVALID"; throw error;
    }
    for (const key of Object.keys(source)) {
      if (!LOG_SNAPSHOT_KEY_SET.has(key)) {
        const error = new Error(`日志快照字段不受支持: ${key}`); error.code = "LOG_SNAPSHOT_UNSUPPORTED"; throw error;
      }
      if (source[key] !== null && typeof source[key] === "object") {
        const error = new Error(`日志快照字段必须为标量: ${key}`); error.code = "LOG_SNAPSHOT_UNSUPPORTED"; throw error;
      }
    }
    sides[side] = source;
  }
  for (const key of Object.keys(parsed)) if (!["before", "after"].includes(key)) {
    const error = new Error(`日志快照顶层字段不受支持: ${key}`); error.code = "LOG_SNAPSHOT_UNSUPPORTED"; throw error;
  }
  return { kind: "structured", value: { before: sides.before, after: sides.after } };
}

function logSnapshotRelation(logId, value) {
  const normalized = normalizeLogSnapshot(value);
  if (normalized.kind !== "structured") return null;
  const row = { log_id: String(logId) };
  for (const side of ["before", "after"]) for (const key of LOG_SNAPSHOT_KEYS) {
    const column = `${side}_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;
    const item = normalized.value[side][key];
    row[column] = key === "riskBlocked" ? (item == null ? null : item === true || item === 1 || item === "1" || String(item).toLowerCase() === "true" ? 1 : 0) : item == null ? null : String(item);
  }
  return row;
}

function pushLeaf(attributes, path, value, ordinal = 0) {
  const type = valueType(value);
  if (type === "object" || type === "array" || type === "undefined") return;
  attributes.push({
    path,
    ordinal,
    value_type: type,
    value_text: type === "string" ? value : null,
    value_number: type === "number" && Number.isFinite(value) ? value : null,
    value_bool: type === "boolean" ? (value ? 1 : 0) : null,
    value_time: null
  });
}

function flattenLeaves(value, path, out, ordinal = 0) {
  const leaf = String(path || "").split(".").pop().replace(/\[\d+\]/g, "");
  if (isSensitiveField(leaf)) return;
  if (value instanceof Date) { pushLeaf(out, path, value.toISOString(), ordinal); return; }
  if (Buffer.isBuffer(value)) { pushLeaf(out, path, value.toString("utf8"), ordinal); return; }
  if (Array.isArray(value)) {
    if (!value.length) {
      out.push({ path, ordinal, value_type: "array", value_text: null, value_number: null, value_bool: null, value_time: null });
      return;
    }
    // Carry the array index in the path. A single ordinal column cannot
    // represent nested arrays of objects without losing their boundaries.
    value.forEach((item, index) => flattenLeaves(item, `${path}[${index}]`, out, 0));
    return;
  }
  if (value && typeof value === "object") {
    if (!Object.keys(value).length) {
      out.push({ path, ordinal, value_type: "object", value_text: null, value_number: null, value_bool: null, value_time: null });
      return;
    }
    for (const [key, child] of Object.entries(value)) flattenLeaves(child, path ? `${path}.${key}` : key, out, 0);
    return;
  }
  pushLeaf(out, path, value, ordinal);
}

function knownNestedKeys(key) {
  const values = {
    shops: ["distributorIds", "distributorRates", "agentIds"],
    series: ["spotIds"],
    albums: ["photoIds", "tags"],
    packages: ["spotIds", "tags", "serviceTags", "mutualExclusionIds", "mutexPackageIds", "conflictPackageIds", "exclusivePackageIds", "includedItems", "items"],
    addonServices: ["defaultForPackageIds"],
    peripherals: ["spotIds", "specs", "images"],
    orders: ["contactPhones", "extraPhones", "extraWechats", "source", "packageSnapshot", "products", "productItems", "items", "addons", "statusLogs", "followRecords", "paymentRecords"],
    afterSales: ["logs"],
    logs: ["snapshot"],
    reconciliationTransfers: ["orderIds", "orderNos"],
    homeConfig: ["modules", "enabledModules", "carouselIds", "featuredPackageIds", "featuredAlbumIds", "featuredPeripheralIds", "banners", "exploreBanners", "homeBanners", "quickNav", "pageModules", "homeModules", "recommendations"],
    siteConfig: ["customPrice", "bookingNotice", "wechat", "search", "footprint"],
    trash: ["source"],
  };
  return new Set(values[key] || []);
}

function arrayPath(path, field) {
  const escaped = String(field).replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&");
  const match = String(path || "").match(new RegExp(`^${escaped}\\[(\\d+)\\](?:\\.(.*))?$`));
  return match ? { index: Number(match[1]), rest: match[2] || "" } : null;
}

function objectPath(path, field) {
  const prefix = `${field}.`;
  return String(path || "").startsWith(prefix) ? String(path).slice(prefix.length) : null;
}

function hasArrayItems(input, field) { return Array.isArray(input[field]); }
function coversArrayContainer(path, field, input) { return String(path || "") === field && hasArrayItems(input, field); }
function coversPrimitiveArray(path, field, input) { const match = arrayPath(path, field); return coversArrayContainer(path, field, input) || !!(match && !match.rest && hasArrayItems(input, field)); }
function coversObjectContainer(path, field, input) {
  return String(path || "") === field && input[field] && typeof input[field] === "object" && !Array.isArray(input[field]);
}
function coversObjectFields(path, field, fields, input) {
  const rest = objectPath(path, field);
  return !!(rest && input[field] && typeof input[field] === "object" && !Array.isArray(input[field]) && fields.has(rest));
}
function coversArrayFields(path, field, fields, input) {
  const match = arrayPath(path, field);
  return !!(match && match.rest && fields.has(match.rest) && hasArrayItems(input, field));
}

// Dedicated relation tables are authoritative for the paths below. Unknown
// leaves remain in lxm_collection_values so adding a future extension does not
// silently discard data, while modeled values are not duplicated there.
function isMaterializedPath(key, path, input) {
  const top = String(path || "").split(/[.\[]/, 1)[0];
  if (!knownNestedKeys(key).has(top)) return false;
  const primitive = (field) => coversPrimitiveArray(path, field, input);
  const objectFields = (field, fields) => coversObjectFields(path, field, fields, input);
  const arrayFields = (field, fields) => coversArrayFields(path, field, fields, input);
  if (key === "shops") return primitive("distributorIds") || primitive("agentIds")
    || coversObjectContainer(path, "distributorRates", input) || objectFields("distributorRates", new Set(Object.keys(input.distributorRates || {})));
  if (key === "series") return primitive("spotIds");
  if (key === "albums") return primitive("photoIds") || primitive("tags");
  if (key === "packages") {
    if (["spotIds", "tags", "serviceTags", "mutualExclusionIds", "mutexPackageIds", "conflictPackageIds", "exclusivePackageIds"].some(primitive)) return true;
    const itemFields = new Set(["type", "name", "price", "target.page", "target.productId", "target.peripheralId", "target.seriesId", "target.albumId", "target.spotId"]);
    return coversArrayContainer(path, "includedItems", input) || coversArrayContainer(path, "items", input)
      || arrayFields("includedItems", itemFields) || arrayFields("items", itemFields);
  }
  if (key === "addonServices") return primitive("defaultForPackageIds");
  if (key === "peripherals") return primitive("spotIds") || primitive("specs") || primitive("images");
  if (key === "orders") {
    if (["contactPhones", "extraPhones", "extraWechats"].some((field) => primitive(field))) return true;
    if (["products", "productItems", "items", "addons", "statusLogs", "followRecords", "paymentRecords"].some((field) => coversArrayContainer(path, field, input))) return true;
    if (objectFields("source", new Set(["shopId", "distributorId", "scene", "sourceType", "channel", "codeId"]))) return true;
    const source = ["products", "productItems", "items"].map((field) => arrayPath(path, field)).find(Boolean);
    if (source && source.rest) {
      const rest = source.rest;
      if (["id", "productId", "packageId", "albumId", "peripheralId", "type", "productType", "price", "quantity", "qty", "spotId", "seriesId", "name"].includes(rest)) return true;
      if (/^snapshot\.(id|name|originalPrice|price|isMainPush)$/.test(rest)) return true;
      if (/^snapshot\.serviceTags\[\d+\]$/.test(rest)) return true;
    }
    if (objectFields("packageSnapshot", new Set(["id", "packageId", "name", "originalPrice", "price", "isMainPush"]))) return true;
    if (objectPath(path, "packageSnapshot")?.startsWith("serviceTags[")) return true;
    const addon = arrayPath(path, "addons");
    if (addon && addon.rest && ["id", "addonId", "type", "productType", "name", "price", "quantity", "qty", "count"].includes(addon.rest)) return true;
    const status = arrayPath(path, "statusLogs");
    if (status && status.rest && ["time", "operator", "operatorId", "action", "type", "from", "to", "createTime"].includes(status.rest)) return true;
    const follow = arrayPath(path, "followRecords");
    if (follow && follow.rest && ["type", "action", "operator", "operatorId", "note", "reason", "from", "to", "createTime"].includes(follow.rest)) return true;
    const payment = arrayPath(path, "paymentRecords");
    if (payment && payment.rest && ["id", "phase", "type", "paymentType", "amount", "status", "attempt", "provider", "idempotencyKey", "confirmationIdempotencyKey", "externalTransactionId", "operator", "operatorId", "paidAt", "createdAt", "updatedAt", "adminRegisteredAt", "note"].includes(payment.rest)) return true;
    return false;
  }
  if (key === "afterSales") {
    const log = arrayPath(path, "logs");
    if (coversArrayContainer(path, "logs", input)) return true;
    if (!log || !Array.isArray(input.logs) || !input.logs.length) return false;
    const item = input.logs[log.index];
    if (!log.rest) return typeof item === "string";
    return !!(item && typeof item === "object" && ["message", "detail", "note", "time", "operator", "operatorId"].includes(log.rest));
  }
  if (key === "reconciliationTransfers") return primitive("orderIds") || primitive("orderNos");
  if (key === "homeConfig") {
    if (["modules", "enabledModules", "carouselIds", "featuredPackageIds", "featuredAlbumIds", "featuredPeripheralIds"].some(primitive)) return true;
    const module = arrayPath(path, "homeModules");
    if (coversArrayContainer(path, "homeModules", input) || module && module.rest && ["key", "id", "title", "subtitle", "moreText", "enabled", "visible", "sort"].includes(module.rest)) return true;
    for (const group of ["banners", "homeBanners", "exploreBanners"]) {
      const banner = arrayPath(path, group);
      if (coversArrayContainer(path, group, input) || banner && banner.rest && ["id", "_id", "type", "url", "cover", "title", "targetType", "targetId", "linkUrl", "effectiveTime"].includes(banner.rest)) return true;
    }
    const nav = arrayPath(path, "quickNav");
    if (coversArrayContainer(path, "quickNav", input) || nav && nav.rest && ["targetType", "label", "icon"].includes(nav.rest)) return true;
    const page = objectPath(path, "pageModules");
    if (page) {
      const title = page.match(/^([^.]+)\.title$/);
      if (title && input.pageModules && input.pageModules[title[1]] && Object.prototype.hasOwnProperty.call(input.pageModules[title[1]], "title")) return true;
      const match = page.match(/^([^.]+)\.(enabledModules|bannerIds|packageIds|albumIds|videoIds|guideIds|peripheralIds)(?:\[\d+\])?$/);
      if (match && Array.isArray(input.pageModules?.[match[1]]?.[match[2]])) return true;
    }
    const recommendation = objectPath(path, "recommendations");
    const recommendationMatch = recommendation && recommendation.match(/^([^.]+)(?:\[\d+\])?$/);
    if (recommendationMatch && Array.isArray(input.recommendations?.[recommendationMatch[1]])) return true;
    return false;
  }
  if (key === "siteConfig") {
    if (primitive("bookingNotice")) return true;
    const hotword = objectPath(path, "search");
    if (hotword && /^hotwords\[\d+\]$/.test(hotword)) return true;
    if (input.id === "global") {
      if (/^customPrice\.(baseHours|singlePersonPrice|perExtraPerson|note)$/.test(path)) return true;
      if (/^wechat\.(corpId|appId|guideText)$/.test(path)) return true;
      if (/^footprint\.(enabled|total|title|rewardText)$/.test(path)) return true;
    }
    return false;
  }
  if (key === "trash") return !!(input.source && typeof input.source === "object" && !Array.isArray(input.source) && (String(path).startsWith("source.") || String(path) === "source"));
  return false;
}

function normalizeDocumentAliases(key, document) {
  const input = document && typeof document === "object" && !Array.isArray(document) ? { ...document } : {};
  if (input.deleted !== undefined && input.isDeleted === undefined) input.isDeleted = input.deleted;
  if (input.isDeleted !== undefined && input.deleted === undefined) input.deleted = input.isDeleted;
  if (key === "orders") {
    if (input.id === undefined && input._id === undefined && input.orderId !== undefined) input.id = input.orderId;
    const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
    if (firstDefined(input.customer, input.customerName, input.contactName, input.name) !== undefined && firstDefined(input.customer) === undefined) input.customer = firstDefined(input.customerName, input.contactName, input.name);
    if (firstDefined(input.contactName, input.customerName, input.customer) !== undefined && firstDefined(input.contactName) === undefined) input.contactName = firstDefined(input.customerName, input.customer);
    if (firstDefined(input.appointmentAt, input.scheduleAt, input.date) !== undefined && firstDefined(input.appointmentAt) === undefined) {
      const timePart = firstDefined(input.time, input.timePeriod, input.timeSlot, input.bookingTime);
      input.appointmentAt = firstDefined(input.scheduleAt, input.date && timePart ? `${input.date} ${timePart}` : input.date);
    }
    if (firstDefined(input.totalAmount, input.amountTotal, input.totalPrice, input.price) !== undefined && firstDefined(input.totalAmount) === undefined) input.totalAmount = firstDefined(input.amountTotal, input.totalPrice, input.price);
    if (firstDefined(input.depositPaid, input.paidDeposit) !== undefined && firstDefined(input.depositPaid) === undefined) input.depositPaid = firstDefined(input.paidDeposit);
    if (firstDefined(input.finalPaid, input.paidFinal) !== undefined && firstDefined(input.finalPaid) === undefined) input.finalPaid = firstDefined(input.paidFinal);
    if (firstDefined(input.customerRemark, input.remark, input.message) !== undefined && firstDefined(input.customerRemark) === undefined) input.customerRemark = firstDefined(input.remark, input.message);
    const aliasRows = [input.productItems, input.items].filter(Array.isArray);
    if (Array.isArray(input.products)) {
      // Some historical orders carried both names. Merge each index before
      // materialization so packageId/productId/qty and custom item leaves are
      // retained even when the canonical array is also present.
      if (aliasRows.length) {
        const length = Math.max(input.products.length, ...aliasRows.map((rows) => rows.length));
        input.products = Array.from({ length }, (_, index) => {
          const merged = Object.assign({}, ...aliasRows.map((rows) => rows[index] || {}));
          for (const [field, value] of Object.entries(input.products[index] || {})) if (value !== undefined) merged[field] = value;
          return merged;
        });
      }
    } else if (aliasRows.length) {
      const length = Math.max(...aliasRows.map((rows) => rows.length));
      input.products = Array.from({ length }, (_, index) => Object.assign({}, ...aliasRows.map((rows) => rows[index] || {})));
    }
    if (Array.isArray(input.extraPhones)) {
      input.contactPhones = [...new Set([input.phone, input.contactPhone, input.customerPhone, ...(Array.isArray(input.contactPhones) ? input.contactPhones : []), ...input.extraPhones].filter(Boolean).map(String))];
    }
    if (Array.isArray(input.products)) {
      input.products = input.products.map((item) => {
        const normalized = item && typeof item === "object" ? { ...item } : {};
        if (normalized.id === undefined && normalized.productId !== undefined) normalized.id = normalized.productId;
        if (normalized.id === undefined && normalized.packageId !== undefined) normalized.id = normalized.packageId;
        if (normalized.id === undefined && normalized.albumId !== undefined) normalized.id = normalized.albumId;
        if (normalized.id === undefined && normalized.peripheralId !== undefined) normalized.id = normalized.peripheralId;
        if (normalized.type === undefined && normalized.productType !== undefined) normalized.type = normalized.productType;
        if (normalized.quantity === undefined && normalized.qty !== undefined) normalized.quantity = normalized.qty;
        return normalized;
      });
    }
  }
  if (key === "packages") {
    if (Array.isArray(input.includedItems) && Array.isArray(input.items)) {
      const length = Math.max(input.includedItems.length, input.items.length);
      input.includedItems = Array.from({ length }, (_, index) => {
        const merged = { ...(input.items[index] || {}) };
        for (const [field, value] of Object.entries(input.includedItems[index] || {})) if (value !== undefined) merged[field] = value;
        return merged;
      });
    } else if (!Array.isArray(input.includedItems) && Array.isArray(input.items)) input.includedItems = input.items;
    if (Array.isArray(input.includedItems)) {
      input.includedItems = input.includedItems.map((item) => {
        const normalized = item && typeof item === "object" ? { ...item } : {};
        if (normalized.type === undefined && normalized.productType !== undefined) normalized.type = normalized.productType;
        if (!normalized.target || typeof normalized.target !== "object" || Array.isArray(normalized.target)) normalized.target = {};
        if (normalized.target.productId === undefined && normalized.productId !== undefined) normalized.target.productId = normalized.productId;
        if (normalized.target.peripheralId === undefined && normalized.peripheralId !== undefined) normalized.target.peripheralId = normalized.peripheralId;
        return normalized;
      });
    }
    if (input.price === undefined && input.comboPrice !== undefined) input.price = input.comboPrice;
  }
  if (["agents", "distributors", "shops", "staff"].includes(key)) {
    // Subject identity is stored by the normalized authorization tables. It
    // is not a business-collection attribute and should not be mirrored into
    // lxm_collection_values during account projection updates.
    delete input.permissions;
    delete input.permissionKeys;
    delete input.subjectType;
    delete input.subjectId;
  }
  if (key === "homeConfig") {
    // The admin editor keeps its working model under editorConfig while the
    // public mini-program contract uses top-level relation-friendly fields.
    // Promote those fields before splitting so they are written to the
    // dedicated home_* relation tables instead of an opaque nested payload.
    const editor = input.editorConfig && typeof input.editorConfig === "object" && !Array.isArray(input.editorConfig)
      ? input.editorConfig
      : null;
    const relationFields = [
      "modules", "enabledModules", "carouselIds", "featuredPackageIds", "featuredAlbumIds",
      "featuredPeripheralIds", "homeBanners", "banners", "exploreBanners", "quickNav",
      "pageModules", "homeModules", "recommendations"
    ];
    if (editor) {
      for (const field of relationFields) {
        const current = input[field];
        const candidate = editor[field];
        const emptyCurrent = current === undefined
          || (Array.isArray(current) && current.length === 0 && Array.isArray(candidate) && candidate.length > 0)
          || (current && typeof current === "object" && !Array.isArray(current)
            && candidate && typeof candidate === "object" && !Array.isArray(candidate)
            && Object.keys(current).length === 0 && Object.keys(candidate).length > 0);
        if (emptyCurrent && candidate !== undefined) {
          const value = candidate;
          input[field] = Array.isArray(value) ? value.slice() : value && typeof value === "object" ? { ...value } : value;
        }
      }
      // Avoid storing a second copy of materialized arrays below
      // editorConfig.*. Non-modeled editor-only leaves remain typed attrs.
      const editorRest = { ...editor };
      relationFields.forEach((field) => { delete editorRest[field]; });
      if (Object.keys(editorRest).length) input.editorConfig = editorRest;
      else delete input.editorConfig;
    }
    // `banners` is the public RPC name while `homeBanners` is the advanced
    // editor lane. They are kept as separate relation groups so a configured
    // advanced banner never overwrites the sample-carousel fallback.
  }
  if (key === "siteConfig") {
    for (const field of ["customPrice", "wechat", "footprint", "search"]) {
      if (!input[field] || typeof input[field] !== "object" || Array.isArray(input[field])) continue;
      input[field] = { ...input[field] };
      delete input[field].id;
      delete input[field]._id;
    }
  }
  return input;
}

function splitDocument(key, document = {}) {
  assertKey(key);
  const input = normalizeDocumentAliases(key, document);
  const id = String(input.id || input._id || "");
  const columns = {};
  const captured = new Set(["id", "_id"]);
  if (key === "orders") ["orderId", "customerName", "scheduleAt", "amountTotal", "paidDeposit", "paidFinal", "remark", "productItems", "items", "extraPhones"].forEach((name) => captured.add(name));
  if (key === "packages") ["items", "comboPrice"].forEach((name) => captured.add(name));
  if (key === "homeConfig") ["banners"].forEach((name) => captured.add(name));
  for (const item of definition(key).columns) {
    if (item.name === "id") continue;
    if (Object.prototype.hasOwnProperty.call(input, item.name)) {
      const value = input[item.name];
      if (value === null || typeof value !== "object") {
        columns[item.name] = value;
        captured.add(item.name);
      }
    }
  }
  if (key === "logs" && (Object.prototype.hasOwnProperty.call(input, "snapshot") || Object.prototype.hasOwnProperty.call(input, "snapshotText"))) {
    const snapshotInput = Object.prototype.hasOwnProperty.call(input, "snapshot") ? input.snapshot : input.snapshotText;
    const snapshot = normalizeLogSnapshot(snapshotInput);
    // Keep the public `snapshot` key out of generic leaves. Structured values
    // are written to the dedicated relation; ordinary text is bounded in the
    // scalar snapshotText column.
    captured.add("snapshot");
    captured.add("snapshotText");
    if (snapshot.kind === "structured") delete columns.snapshotText;
    if (snapshot.kind === "text") {
      const text = String(snapshot.text || "");
      if (text.length > 500) { const error = new Error("日志快照摘要超过 500 字"); error.code = "LOG_SNAPSHOT_TOO_LONG"; throw error; }
      columns.snapshotText = text;
    }
  }
  if (key === "logs" && columns.snapshotText != null && String(columns.snapshotText).length > 500) {
    const error = new Error("日志快照摘要超过 500 字"); error.code = "LOG_SNAPSHOT_TOO_LONG"; throw error;
  }
  const attributes = [];
  for (const [field, value] of Object.entries(input)) {
    if (captured.has(field) || isSensitiveField(field)) continue;
    if (key === "financeSettings") continue;
    flattenLeaves(value, field, attributes);
  }
  if (key === "siteConfig") {
    const custom = input.customPrice && typeof input.customPrice === "object" ? input.customPrice : {};
    const wechat = input.wechat && typeof input.wechat === "object" ? input.wechat : {};
    const footprint = input.footprint && typeof input.footprint === "object" ? input.footprint : {};
    for (const [name, value] of [
      ["customPrice_baseHours", custom.baseHours], ["customPrice_singlePersonPrice", custom.singlePersonPrice],
      ["customPrice_perExtraPerson", custom.perExtraPerson], ["customPrice_note", custom.note],
      ["privacyText", input.privacyText], ["wechatCorpId", wechat.corpId], ["wechatAppId", wechat.appId],
      ["wechatGuideText", wechat.guideText], ["footprintEnabled", footprint.enabled], ["footprintTotal", footprint.total],
      ["footprintTitle", footprint.title], ["footprintRewardText", footprint.rewardText]
    ]) if (value !== undefined) columns[name] = value;
  }
  const relations = materializeRelations(key, input);
  return { id, columns, relations, attributes: attributes.filter((row) => !isMaterializedPath(key, row.path, input)) };
}

function materializeRelations(key, input) {
  const out = {};
  const add = (name, rows) => { if (rows.length) out[name] = (out[name] || []).concat(rows); };
  if (key === "shops") {
    const ids = Array.isArray(input.distributorIds) ? input.distributorIds : [];
    const rates = input.distributorRates && typeof input.distributorRates === "object" ? input.distributorRates : {};
    add("shop_distributors", ids.map((id, index) => ({ shop_id: String(input.id || input._id || ""), distributor_id: String(id), rate: rates[id] == null ? null : Number(rates[id]), sort_no: index })));
    const agents = Array.isArray(input.agentIds) ? input.agentIds : (input.agentId ? [input.agentId] : []);
    add("shop_agents", agents.map((id, index) => ({ shop_id: String(input.id || input._id || ""), agent_id: String(id), sort_no: index })));
  }
  if (key === "series") add("series_spots", (Array.isArray(input.spotIds) ? input.spotIds : (input.spotId ? [input.spotId] : [])).map((id, index) => ({ series_id: String(input.id || input._id || ""), spot_id: String(id), sort_no: index })));
  if (key === "albums") {
    add("album_samples", (Array.isArray(input.photoIds) ? input.photoIds : []).map((id, index) => ({ album_id: String(input.id || input._id || ""), sample_id: String(id), sort_no: index })));
    add("album_tags", (Array.isArray(input.tags) ? input.tags : []).map((tag, index) => ({ album_id: String(input.id || input._id || ""), tag: String(tag), sort_no: index })));
  }
  if (key === "packages") {
    const packageId = String(input.id || input._id || "");
    add("package_spots", (Array.isArray(input.spotIds) ? input.spotIds : (input.spotId ? [input.spotId] : [])).map((id, index) => ({ package_id: packageId, spot_id: String(id), sort_no: index })));
    for (const tagType of ["tags", "serviceTags"]) add("package_tags", (Array.isArray(input[tagType]) ? input[tagType] : []).map((tag, index) => ({ package_id: packageId, tag_type: tagType, tag: String(tag), sort_no: index })));
    for (const relationType of ["mutualExclusionIds", "mutexPackageIds", "conflictPackageIds", "exclusivePackageIds"]) add("package_exclusions", (Array.isArray(input[relationType]) ? input[relationType] : []).map((id, index) => ({ package_id: packageId, excluded_package_id: String(id), relation_type: relationType, sort_no: index })));
    add("package_included_items", (Array.isArray(input.includedItems) ? input.includedItems : []).map((item, index) => {
      const target = item && item.target && typeof item.target === "object" ? item.target : {};
      return { package_id: packageId, item_no: index, item_type: item && item.type || null, item_name: item && item.name || null, item_price: numberOrNull(item && item.price), target_page: target.page || null, target_product_id: target.productId || target.peripheralId || null, target_series_id: target.seriesId || null, target_album_id: target.albumId || null, target_spot_id: target.spotId || null };
    }));
  }
  if (key === "addonServices") add("addon_package_defaults", (Array.isArray(input.defaultForPackageIds) ? input.defaultForPackageIds : []).map((id, index) => ({ addon_id: String(input.id || input._id || ""), package_id: String(id), sort_no: index })));
  if (key === "peripherals") {
    const peripheralId = String(input.id || input._id || "");
    add("peripheral_spots", (Array.isArray(input.spotIds) ? input.spotIds : (input.spotId ? [input.spotId] : [])).map((id, index) => ({ peripheral_id: peripheralId, spot_id: String(id), sort_no: index })));
    const specs = Array.isArray(input.specs) ? input.specs : input.specs == null ? [] : [input.specs];
    add("peripheral_specs", specs.map((spec, index) => ({ peripheral_id: peripheralId, spec_no: index, spec_text: String(spec) })));
    add("peripheral_images", (Array.isArray(input.images) ? input.images : []).map((url, index) => ({ peripheral_id: peripheralId, image_no: index, image_url: String(url) })));
  }
  if (key === "orders") {
    const orderId = String(input.id || input._id || "");
    const phones = Array.isArray(input.contactPhones) ? input.contactPhones : [];
    const wechats = Array.isArray(input.extraWechats) ? input.extraWechats : [];
    add("order_contacts", [...phones.map((phone, index) => ({ order_id: orderId, contact_no: index, phone: String(phone), wechat: null })), ...wechats.map((wechat, index) => ({ order_id: orderId, contact_no: phones.length + index, phone: null, wechat: String(wechat) }))]);
    if (input.source && typeof input.source === "object") add("order_source", [{ order_id: orderId, shop_id: input.source.shopId || null, distributor_id: input.source.distributorId || null, scene: input.source.scene || null, source_type: input.source.sourceType || null, channel: input.source.channel || null, code_id: input.source.codeId || input.sourceCodeId || null }]);
    const snapshot = input.packageSnapshot && typeof input.packageSnapshot === "object" ? input.packageSnapshot : {};
    if (Object.keys(snapshot).length) add("order_package_snapshot", [{ order_id: orderId, snapshot_id: snapshot.id || null, package_id: snapshot.packageId || snapshot.id || null, name: snapshot.name || null, original_price: snapshot.originalPrice == null ? null : Number(snapshot.originalPrice), price: snapshot.price == null ? null : Number(snapshot.price), is_main_push: snapshot.isMainPush == null ? null : (snapshot.isMainPush ? 1 : 0) }]);
    add("order_package_snapshot_tags", (Array.isArray(snapshot.serviceTags) ? snapshot.serviceTags : []).map((tag, index) => ({ order_id: orderId, tag_no: index, tag: String(tag) })));
    const products = Array.isArray(input.products) ? input.products : (Array.isArray(input.productItems) ? input.productItems : (Array.isArray(input.items) ? input.items : []));
    add("order_products", products.map((item, index) => ({ order_id: orderId, item_no: index, product_id: item && (item.id || item.productId || item.packageId || item.albumId || item.peripheralId) || null, product_type: item && (item.type || item.productType) || null, package_id: item && item.packageId || null, peripheral_id: item && item.peripheralId || null, price: numberOrNull(item && item.price), quantity: numberOrNull(item && (item.quantity ?? item.qty)), spot_id: item && item.spotId || null, series_id: item && item.seriesId || null, album_id: item && item.albumId || null, name: item && item.name || null })));
    add("order_product_snapshots", products.filter((item) => item && item.snapshot && typeof item.snapshot === "object").map((item, index) => ({ order_id: orderId, item_no: products.indexOf(item), snapshot_id: item.snapshot.id || null, name: item.snapshot.name || null, original_price: item.snapshot.originalPrice == null ? null : Number(item.snapshot.originalPrice), price: item.snapshot.price == null ? null : Number(item.snapshot.price), is_main_push: item.snapshot.isMainPush == null ? null : (item.snapshot.isMainPush ? 1 : 0) })));
    add("order_product_snapshot_tags", products.flatMap((item, itemIndex) => (item && item.snapshot && Array.isArray(item.snapshot.serviceTags) ? item.snapshot.serviceTags : []).map((tag, tagIndex) => ({ order_id: orderId, item_no: itemIndex, tag_no: tagIndex, tag: String(tag) }))));
    add("order_addons", (Array.isArray(input.addons) ? input.addons : []).map((item, index) => ({ order_id: orderId, item_no: index, addon_id: item && (item.id || item.addonId) || null, addon_type: item && (item.type || item.productType) || null, name: item && item.name || null, price: numberOrNull(item && item.price), quantity: numberOrNull(item && (item.quantity ?? item.qty ?? item.count)) })));
    add("order_status_logs", (Array.isArray(input.statusLogs) ? input.statusLogs : []).map((item, index) => ({ order_id: orderId, log_no: index, time: item && item.time || null, operator: item && item.operator || null, operator_id: item && item.operatorId || null, action: item && item.action || (typeof item === "string" ? item : null), type: item && item.type || null, from_status: item && item.from || null, to_status: item && item.to || null, create_time: item && item.createTime || null })));
    add("order_follow_records", (Array.isArray(input.followRecords) ? input.followRecords : []).map((item, index) => ({ order_id: orderId, record_no: index, type: item && item.type || null, action: item && item.action || null, operator: item && item.operator || null, operator_id: item && item.operatorId || null, note: item && item.note || null, reason: item && item.reason || null, from_status: item && item.from || null, to_status: item && item.to || null, create_time: item && item.createTime || null })));
    add("order_payment_records", (Array.isArray(input.paymentRecords) ? input.paymentRecords : []).map((item, index) => ({
      order_id: orderId, record_no: index, payment_id: item && (item.id || item._id) || null,
      phase: item && item.phase || null, payment_type: item && (item.type || item.paymentType) || null,
      amount: numberOrNull(item && item.amount), status: item && item.status || null, attempt: numberOrNull(item && item.attempt), provider: item && item.provider || null,
      idempotency_key: item && item.idempotencyKey || null, confirmation_idempotency_key: item && item.confirmationIdempotencyKey || null,
      external_transaction_id: item && item.externalTransactionId || null, operator: item && item.operator || null, operator_id: item && item.operatorId || null,
      paid_at: item && item.paidAt || null, record_created_at: item && item.createdAt || null, record_updated_at: item && item.updatedAt || null,
      admin_registered_at: item && item.adminRegisteredAt || null, note: item && item.note || null
    })));
  }
  if (key === "afterSales") {
    const ticketId = String(input.id || input._id || "");
    add("after_sale_logs", (Array.isArray(input.logs) ? input.logs : []).map((item, index) => ({ after_sale_id: ticketId, log_no: index, message: typeof item === "string" ? item : item && (item.message || item.detail || item.note) || null, time: item && item.time || null, operator: item && item.operator || null, operator_id: item && item.operatorId || null })));
  }
  if (key === "logs" && (Object.prototype.hasOwnProperty.call(input, "snapshot") || Object.prototype.hasOwnProperty.call(input, "snapshotText"))) {
    const snapshotInput = Object.prototype.hasOwnProperty.call(input, "snapshot") ? input.snapshot : input.snapshotText;
    const relation = logSnapshotRelation(String(input.id || input._id || ""), snapshotInput);
    if (relation) add("log_order_exception_snapshots", [relation]);
  }
  if (key === "reconciliationTransfers") {
    const ids = Array.isArray(input.orderIds) ? input.orderIds : [];
    const nos = Array.isArray(input.orderNos) ? input.orderNos : [];
    add("transfer_orders", Array.from({ length: Math.max(ids.length, nos.length) }, (_, index) => ({ transfer_id: String(input.id || input._id || ""), order_no: index, order_id: ids[index] == null ? null : String(ids[index]), order_number: nos[index] == null ? null : String(nos[index]) })));
  }
  if (key === "siteConfig") {
    const id = String(input.id || input._id || "global");
    add("site_booking_notices", (Array.isArray(input.bookingNotice) ? input.bookingNotice : []).map((text, index) => ({ config_id: id, notice_no: index, notice_text: String(text) })));
    add("site_hotwords", (Array.isArray(input.search && input.search.hotwords) ? input.search.hotwords : []).map((word, index) => ({ config_id: id, word_no: index, word: String(word) })));
  }
  if (key === "trash" && input.source && typeof input.source === "object") {
    const trashId = String(input.id || input._id || "");
    const leaves = [];
    flattenLeaves(input.source, "source", leaves);
    add("trash_source_attributes", leaves.map((row) => ({ trash_id: trashId, path: row.path, ordinal: row.ordinal, value_type: row.value_type, value_text: row.value_text, value_number: row.value_number, value_bool: row.value_bool, value_time: row.value_time })));
  }
  if (key === "homeConfig") {
    const configId = String(input.id || input._id || "homeStats");
    const scalarGroups = [
      ["modules", input.modules], ["enabledModules", input.enabledModules], ["carouselIds", input.carouselIds],
      ["featuredPackageIds", input.featuredPackageIds], ["featuredAlbumIds", input.featuredAlbumIds],
      ["featuredPeripheralIds", input.featuredPeripheralIds]
    ];
    for (const [group, list] of scalarGroups) add("home_ids", (Array.isArray(list) ? list : []).map((id, index) => ({ config_id: configId, group_key: group, item_id: String(id), sort_no: index })));
    add("home_modules", (Array.isArray(input.homeModules) ? input.homeModules : []).map((item, index) => ({ config_id: configId, module_key: String(item && (item.key || item.id) || index), title: item && item.title || null, subtitle: item && item.subtitle || null, more_text: item && item.moreText || null, enabled: item && item.enabled != null ? (item.enabled ? 1 : 0) : null, visible: item && item.visible != null ? (item.visible ? 1 : 0) : null, sort_no: item && item.sort != null ? Number(item.sort) : index })));
    for (const group of ["banners", "homeBanners", "exploreBanners"]) add("home_banners", (Array.isArray(input[group]) ? input[group] : []).map((item, index) => ({ config_id: configId, banner_group: group, banner_no: index, banner_id: item && (item._id || item.id) || null, type: item && (item.type || item.mediaType) || null, url: item && (item.url || item.image || item.imageUrl) || null, cover: item && (item.cover || item.poster) || null, title: item && item.title || null, target_type: item && (item.targetType || item.linkType || item.jumpType) || null, target_id: item && (item.targetId || item.linkId || item.jumpId) || null, link_url: item && (item.linkUrl || item.jumpUrl || item.targetUrl) || null, effective_time: item && item.effectiveTime || null })));
    add("home_quick_nav", (Array.isArray(input.quickNav) ? input.quickNav : []).map((item, index) => ({ config_id: configId, nav_no: index, target_type: item && item.targetType || null, label: item && item.label || null, icon: item && item.icon || null })));
    const pages = input.pageModules && typeof input.pageModules === "object" ? input.pageModules : {};
    for (const [pageKey, page] of Object.entries(pages)) {
      if (!page || typeof page !== "object") continue;
      const enabled = Array.isArray(page.enabledModules) ? page.enabledModules : [];
      add("home_page_modules", enabled.map((moduleKey, index) => ({ config_id: configId, page_key: pageKey, module_key: String(moduleKey), title: page.title || null, enabled: 1, sort_no: index })));
      for (const linkType of ["bannerIds", "packageIds", "albumIds", "videoIds", "guideIds", "peripheralIds"]) add("home_page_links", (Array.isArray(page[linkType]) ? page[linkType] : []).map((itemId, index) => ({ config_id: configId, page_key: pageKey, link_type: linkType, item_id: String(itemId), sort_no: index })));
    }
    const recommendations = input.recommendations && typeof input.recommendations === "object" ? input.recommendations : {};
    for (const [linkType, list] of Object.entries(recommendations)) add("home_page_links", (Array.isArray(list) ? list : []).map((itemId, index) => ({ config_id: configId, page_key: "recommendations", link_type: linkType, item_id: String(itemId), sort_no: index })));
  }
  return out;
}

function asBoolean(value) { return value === null || value === undefined ? value : value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true"; }
function attributeValue(row) {
  if (!row) return undefined;
  if (row.value_type === "array") return [];
  if (row.value_type === "object") return {};
  if (row.value_type === "number") return row.value_number == null ? null : Number(row.value_number);
  if (row.value_type === "boolean") return !!Number(row.value_bool);
  if (row.value_type === "null") return null;
  return row.value_text;
}
function setPath(target, path, value) {
  const tokens = [];
  String(path || "").replace(/([^.[\]]+)|\[(\d+)\]/g, (_, key, index) => tokens.push(index === undefined ? key : Number(index)));
  if (!tokens.length) return;
  let cursor = target;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]; const next = tokens[index + 1];
    if (cursor[token] === undefined || cursor[token] === null || typeof cursor[token] !== "object") cursor[token] = typeof next === "number" ? [] : {};
    cursor = cursor[token];
  }
  cursor[tokens[tokens.length - 1]] = value;
}
function hydrateAttributeRows(output, rows) {
  for (const row of (Array.isArray(rows) ? rows : [])) setPath(output, row.path, attributeValue(row));
  return output;
}
function compactObject(value) {
  if (Array.isArray(value)) return value.map(compactObject);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) if (child !== null && child !== undefined) output[key] = compactObject(child);
  return output;
}
function hydrateDocument(key, row, relationRows = {}) {
  assertKey(key);
  if (!row) return null;
  const output = { id: String(row.id), _id: String(row.id) };
  for (const item of definition(key).columns) {
    if (item.name === "id" || row[item.name] === undefined || row[item.name] === null) continue;
    const value = row[item.name];
    if (key === "logs" && item.name === "snapshotText") { output.snapshot = value; continue; }
    if (item.type.includes("TINYINT")) output[item.name] = asBoolean(value);
    else if (/(?:INT|DECIMAL)/i.test(item.type)) output[item.name] = value == null ? value : Number(value);
    else output[item.name] = value;
  }
  if (Object.prototype.hasOwnProperty.call(output, "deleted") || Object.prototype.hasOwnProperty.call(output, "isDeleted")) {
    const deleted = output.deleted === true || output.isDeleted === true;
    output.deleted = deleted;
    output.isDeleted = deleted;
  }
  const attributeRows = key === "financeSettings"
    ? []
    : (relationRows[COLLECTION_VALUES_TABLE] || relationRows.collection_values || relationRows.business_attributes);
  hydrateAttributeRows(output, attributeRows);
  const rows = (name) => {
    if (!Array.isArray(relationRows[name])) return [];
    const preferred = ["sort_no", "item_no", "record_no", "log_no", "tag_no", "nav_no", "banner_no", "notice_no", "word_no", "image_no", "spec_no", "ordinal"];
    return relationRows[name].slice().sort((left, right) => {
      for (const column of preferred) {
        if (left[column] === undefined && right[column] === undefined) continue;
        const a = left[column] == null ? 0 : Number(left[column]);
        const b = right[column] == null ? 0 : Number(right[column]);
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
      }
      return 0;
    });
  };
  if (key === "shops") {
    const rel = rows("shop_distributors"); output.distributorIds = rel.map((r) => r.distributor_id);
    output.distributorRates = { ...(output.distributorRates && typeof output.distributorRates === "object" ? output.distributorRates : {}), ...Object.fromEntries(rel.filter((r) => r.rate !== null && r.rate !== undefined).map((r) => [r.distributor_id, Number(r.rate)])) };
    const agents = rows("shop_agents").map((r) => r.agent_id); if (agents.length) { output.agentIds = agents; output.agentId = output.agentId || agents[0]; }
  }
  if (key === "series") output.spotIds = rows("series_spots").sort((a, b) => a.sort_no - b.sort_no).map((r) => r.spot_id);
  if (key === "albums") {
    output.photoIds = rows("album_samples").sort((a, b) => a.sort_no - b.sort_no).map((r) => r.sample_id);
    const tags = rows("album_tags").sort((a, b) => a.sort_no - b.sort_no).map((r) => r.tag);
    if (tags.length || Object.prototype.hasOwnProperty.call(output, "tags")) output.tags = tags;
  }
  if (key === "packages") {
    output.spotIds = rows("package_spots").sort((a, b) => a.sort_no - b.sort_no).map((r) => r.spot_id);
    for (const type of ["tags", "serviceTags"]) output[type] = rows("package_tags").filter((r) => r.tag_type === type).sort((a, b) => a.sort_no - b.sort_no).map((r) => r.tag);
    for (const type of ["mutualExclusionIds", "mutexPackageIds", "conflictPackageIds", "exclusivePackageIds"]) output[type] = rows("package_exclusions").filter((r) => r.relation_type === type).sort((a, b) => a.sort_no - b.sort_no).map((r) => r.excluded_package_id);
    const existingIncluded = Array.isArray(output.includedItems) ? output.includedItems : (Array.isArray(output.items) ? output.items : []);
    const existingItems = Array.isArray(output.items) ? output.items : null;
    const includedRows = rows("package_included_items").sort((a, b) => a.item_no - b.item_no);
    const normalizedIncluded = includedRows.length
      ? includedRows.map((r) => ({ ...(existingIncluded[r.item_no] || {}), type: r.item_type, name: r.item_name, price: r.item_price == null ? undefined : Number(r.item_price), target: { ...((existingIncluded[r.item_no] && existingIncluded[r.item_no].target) || {}), page: r.target_page, productId: r.target_product_id, peripheralId: r.item_type === "peripheral" ? r.target_product_id : undefined, seriesId: r.target_series_id, albumId: r.target_album_id, spotId: r.target_spot_id } }))
      : existingIncluded;
    output.includedItems = normalizedIncluded;
    output.items = existingItems
      ? normalizedIncluded.map((item, index) => compactObject({ ...(existingItems[index] || {}), ...item }))
      : normalizedIncluded;
    if (output.comboPrice === undefined && output.price !== undefined) output.comboPrice = output.price;
  }
  if (key === "addonServices") output.defaultForPackageIds = rows("addon_package_defaults").sort((a, b) => a.sort_no - b.sort_no).map((r) => r.package_id);
  if (key === "peripherals") {
    output.spotIds = rows("peripheral_spots").sort((a, b) => a.sort_no - b.sort_no).map((r) => r.spot_id);
    output.specs = rows("peripheral_specs").sort((a, b) => a.spec_no - b.spec_no).map((r) => r.spec_text);
    output.images = rows("peripheral_images").sort((a, b) => a.image_no - b.image_no).map((r) => r.image_url);
  }
  if (key === "orders") {
    const source = rows("order_source")[0]; if (source) {
      output.source = compactObject({ ...(output.source && typeof output.source === "object" ? output.source : {}), shopId: source.shop_id || "", distributorId: source.distributor_id || "", scene: source.scene || "", sourceType: source.source_type || "", channel: source.channel || "", codeId: source.code_id || undefined });
      if (!output.shopId && source.shop_id) output.shopId = source.shop_id;
      if (!output.distributorId && source.distributor_id) output.distributorId = source.distributor_id;
      if (!output.sourceType && source.source_type) output.sourceType = source.source_type;
      if (!output.sourceScene && source.scene) output.sourceScene = source.scene;
      if (!output.sourceChannel && source.channel) output.sourceChannel = source.channel;
      if (!output.sourceCodeId && source.code_id) output.sourceCodeId = source.code_id;
    }
    const packageSnapshot = rows("order_package_snapshot")[0];
    if (packageSnapshot) {
      const snapshotTags = rows("order_package_snapshot_tags").sort((a, b) => a.tag_no - b.tag_no).map((r) => r.tag);
      const existingSnapshot = output.packageSnapshot && typeof output.packageSnapshot === "object" ? output.packageSnapshot : {};
      output.packageSnapshot = compactObject({ ...existingSnapshot, id: packageSnapshot.snapshot_id, packageId: packageSnapshot.package_id && packageSnapshot.package_id !== packageSnapshot.snapshot_id ? packageSnapshot.package_id : undefined, name: packageSnapshot.name, originalPrice: packageSnapshot.original_price == null ? undefined : Number(packageSnapshot.original_price), price: packageSnapshot.price == null ? undefined : Number(packageSnapshot.price), isMainPush: packageSnapshot.is_main_push == null ? undefined : !!Number(packageSnapshot.is_main_push), serviceTags: snapshotTags.length || Object.prototype.hasOwnProperty.call(existingSnapshot, "serviceTags") ? snapshotTags : undefined });
    }
    const contacts = rows("order_contacts").sort((a, b) => a.contact_no - b.contact_no);
    output.contactPhones = contacts.map((r) => r.phone).filter(Boolean);
    output.extraPhones = output.contactPhones.slice(1);
    if (contacts.some((r) => r.wechat)) output.extraWechats = contacts.map((r) => r.wechat).filter(Boolean);
    const existingProducts = Array.isArray(output.products) ? output.products : (Array.isArray(output.productItems) ? output.productItems : (Array.isArray(output.items) ? output.items : []));
    const existingProductItems = Array.isArray(output.productItems) ? output.productItems : null;
    const existingItems = Array.isArray(output.items) ? output.items : null;
    const productRows = rows("order_products").sort((a, b) => a.item_no - b.item_no);
    const normalizedProducts = productRows.length
      ? productRows.map((r) => {
        const existing = existingProducts[r.item_no] || {};
        const productType = r.product_type || existing.type || existing.productType;
        const packageLike = ["package", "photo", "video", "video_package", "photo_package", "photo_single"].includes(String(productType || "").toLowerCase());
        return compactObject({ ...existing, id: r.product_id || existing.id || existing.productId || existing.packageId, productId: existing.productId || r.product_id, packageId: existing.packageId || r.package_id || (packageLike ? r.product_id : undefined), peripheralId: existing.peripheralId || r.peripheral_id || (String(productType || "").toLowerCase() === "peripheral" ? r.product_id : undefined), type: productType, productType: existing.productType || r.product_type, price: r.price == null ? existing.price : Number(r.price), quantity: r.quantity == null ? (existing.quantity ?? existing.qty) : Number(r.quantity), qty: r.quantity == null ? (existing.qty ?? existing.quantity) : Number(r.quantity), spotId: r.spot_id || existing.spotId, seriesId: r.series_id || existing.seriesId, albumId: r.album_id || existing.albumId, name: r.name || existing.name });
      })
      : existingProducts;
    output.products = normalizedProducts;
    // Keep historical public names and unknown per-item leaves without
    // allowing an alias array to overwrite the normalized relation object.
    output.productItems = existingProductItems
      ? normalizedProducts.map((item, index) => compactObject({ ...(existingProductItems[index] || {}), ...item }))
      : normalizedProducts;
    output.items = existingItems
      ? normalizedProducts.map((item, index) => compactObject({ ...(existingItems[index] || {}), ...item }))
      : normalizedProducts;
    for (const snapshot of rows("order_product_snapshots")) {
      const product = output.products[snapshot.item_no]; if (!product) continue;
      const productTags = rows("order_product_snapshot_tags").filter((r) => r.item_no === snapshot.item_no).sort((a, b) => a.tag_no - b.tag_no).map((r) => r.tag);
      const existingProductSnapshot = product.snapshot && typeof product.snapshot === "object" ? product.snapshot : {};
      product.snapshot = compactObject({ ...existingProductSnapshot, id: snapshot.snapshot_id, name: snapshot.name, originalPrice: snapshot.original_price == null ? undefined : Number(snapshot.original_price), price: snapshot.price == null ? undefined : Number(snapshot.price), isMainPush: snapshot.is_main_push == null ? undefined : !!Number(snapshot.is_main_push), serviceTags: productTags.length || Object.prototype.hasOwnProperty.call(existingProductSnapshot, "serviceTags") ? productTags : undefined });
    }
    const existingAddons = Array.isArray(output.addons) ? output.addons : [];
    output.addons = rows("order_addons").sort((a, b) => a.item_no - b.item_no).map((r) => compactObject({ ...(existingAddons[r.item_no] || {}), id: r.addon_id, addonId: r.addon_id, type: r.addon_type, productType: r.addon_type, name: r.name, price: r.price == null ? undefined : Number(r.price), quantity: r.quantity == null ? undefined : Number(r.quantity), qty: r.quantity == null ? undefined : Number(r.quantity), count: r.quantity == null ? undefined : Number(r.quantity) }));
    const existingStatusLogs = Array.isArray(output.statusLogs) ? output.statusLogs : [];
    output.statusLogs = rows("order_status_logs").sort((a, b) => a.log_no - b.log_no).map((r) => compactObject({ ...(existingStatusLogs[r.log_no] || {}), time: r.time, operator: r.operator, operatorId: r.operator_id, action: r.action, type: r.type, from: r.from_status, to: r.to_status, createTime: r.create_time }));
    const existingFollow = Array.isArray(output.followRecords) ? output.followRecords : [];
    output.followRecords = rows("order_follow_records").sort((a, b) => a.record_no - b.record_no).map((r) => compactObject({ ...(existingFollow[r.record_no] || {}), type: r.type, action: r.action, operator: r.operator, operatorId: r.operator_id, note: r.note, reason: r.reason, from: r.from_status, to: r.to_status, createTime: r.create_time }));
    const existingPayments = Array.isArray(output.paymentRecords) ? output.paymentRecords : [];
    output.paymentRecords = rows("order_payment_records").sort((a, b) => a.record_no - b.record_no).map((r) => compactObject({
      ...(existingPayments[r.record_no] || {}), id: r.payment_id || existingPayments[r.record_no] && (existingPayments[r.record_no].id || existingPayments[r.record_no]._id),
      phase: r.phase, type: r.payment_type, paymentType: r.payment_type, amount: r.amount == null ? undefined : Number(r.amount), status: r.status,
      attempt: r.attempt == null ? undefined : Number(r.attempt), provider: r.provider, idempotencyKey: r.idempotency_key,
      confirmationIdempotencyKey: r.confirmation_idempotency_key, externalTransactionId: r.external_transaction_id,
      operator: r.operator, operatorId: r.operator_id, paidAt: r.paid_at, createdAt: r.record_created_at || r.paid_at,
      updatedAt: r.record_updated_at || r.record_created_at || r.paid_at, adminRegisteredAt: r.admin_registered_at, note: r.note
    }));
    // Preserve the field names used by the original mini-program contract in
    // addition to the admin-facing canonical names.
    output.orderId = output.id;
    if (output.customer !== undefined) output.customerName = output.customer;
    if (output.appointmentAt !== undefined) output.scheduleAt = output.appointmentAt;
    if (output.totalAmount !== undefined) output.amountTotal = output.totalAmount;
    if (output.depositPaid !== undefined) output.paidDeposit = output.depositPaid;
    if (output.finalPaid !== undefined) output.paidFinal = output.finalPaid;
    if (output.customerRemark !== undefined) output.remark = output.customerRemark;
  }
  if (key === "afterSales") { const existingLogs = Array.isArray(output.logs) ? output.logs : []; output.logs = rows("after_sale_logs").sort((a, b) => a.log_no - b.log_no).map((r, index) => typeof existingLogs[index] === "object" && existingLogs[index] ? compactObject({ ...existingLogs[index], message: r.message, time: r.time, operator: r.operator, operatorId: r.operator_id }) : r.message); }
  if (key === "logs") {
    const snapshot = rows("log_order_exception_snapshots")[0];
    if (snapshot) {
      const before = {
        status: snapshot.before_status, customerStatus: snapshot.before_customer_status,
        sourceType: snapshot.before_source_type, shopId: snapshot.before_shop_id,
        distributorId: snapshot.before_distributor_id, riskBlocked: snapshot.before_risk_blocked == null ? undefined : !!Number(snapshot.before_risk_blocked)
      };
      const after = {
        status: snapshot.after_status, customerStatus: snapshot.after_customer_status,
        sourceType: snapshot.after_source_type, shopId: snapshot.after_shop_id,
        distributorId: snapshot.after_distributor_id, riskBlocked: snapshot.after_risk_blocked == null ? undefined : !!Number(snapshot.after_risk_blocked)
      };
      output.snapshot = JSON.stringify({ before: compactObject(before), after: compactObject(after) });
    }
  }
  if (key === "reconciliationTransfers") { const rel = rows("transfer_orders").sort((a, b) => a.order_no - b.order_no); output.orderIds = rel.map((r) => r.order_id).filter(Boolean); output.orderNos = rel.map((r) => r.order_number).filter(Boolean); }
  // Legacy seeds keep each site setting in a separate fragment row.  Only the
  // canonical singleton is allowed to synthesize composite config objects;
  // doing this for fragments would pollute the fragment assembler and turn
  // numeric privacy/notice keys into non-numeric objects.
  if (key === "siteConfig" && ["global", "homeStats"].includes(String(output.id))) {
    output.bookingNotice = rows("site_booking_notices").sort((a, b) => a.notice_no - b.notice_no).map((r) => r.notice_text);
    output.search = { ...(output.search && typeof output.search === "object" ? output.search : {}), hotwords: rows("site_hotwords").sort((a, b) => a.word_no - b.word_no).map((r) => r.word) };
    output.customPrice = { ...(output.customPrice && typeof output.customPrice === "object" ? output.customPrice : {}), baseHours: row.customPrice_baseHours == null ? undefined : Number(row.customPrice_baseHours), singlePersonPrice: row.customPrice_singlePersonPrice == null ? undefined : Number(row.customPrice_singlePersonPrice), perExtraPerson: row.customPrice_perExtraPerson == null ? undefined : Number(row.customPrice_perExtraPerson), note: row.customPrice_note };
    output.wechat = { ...(output.wechat && typeof output.wechat === "object" ? output.wechat : {}), corpId: row.wechatCorpId || "", appId: row.wechatAppId || "", guideText: row.wechatGuideText || "" };
    output.footprint = { ...(output.footprint && typeof output.footprint === "object" ? output.footprint : {}), enabled: asBoolean(row.footprintEnabled), total: row.footprintTotal == null ? undefined : Number(row.footprintTotal), title: row.footprintTitle, rewardText: row.footprintRewardText };
  }
  if (key === "trash") {
    const attrs = rows("trash_source_attributes");
    if (attrs.length) { output.source = output.source && typeof output.source === "object" ? output.source : {}; hydrateAttributeRows(output, attrs); }
  }
  if (key === "homeConfig") {
    const id = String(output.id || "homeStats");
    const ids = rows("home_ids");
    for (const group of ["modules", "enabledModules", "carouselIds", "featuredPackageIds", "featuredAlbumIds", "featuredPeripheralIds"]) output[group] = ids.filter((r) => r.config_id === id && r.group_key === group).sort((a, b) => a.sort_no - b.sort_no).map((r) => r.item_id);
    const existingHomeModules = Array.isArray(output.homeModules) ? output.homeModules : [];
    output.homeModules = rows("home_modules").sort((a, b) => Number(a.sort_no || 0) - Number(b.sort_no || 0)).map((r) => compactObject({ ...(existingHomeModules.find((item) => String(item && (item.key || item.id) || "") === String(r.module_key)) || {}), key: r.module_key, title: r.title, subtitle: r.subtitle, moreText: r.more_text, enabled: asBoolean(r.enabled), visible: asBoolean(r.visible), sort: r.sort_no }));
    const existingBannerAlias = Array.isArray(output.banners) ? output.banners : [];
    for (const group of ["banners", "homeBanners", "exploreBanners"]) {
      const existingBanners = Array.isArray(output[group]) ? output[group] : [];
      const relationBanners = rows("home_banners").filter((r) => r.banner_group === group).sort((a, b) => a.banner_no - b.banner_no);
      output[group] = relationBanners.length
        ? relationBanners.map((r, index) => {
          const existing = existingBanners[index] || {};
          const bannerId = r.banner_id || existing._id || existing.id;
          return compactObject({ ...existing, _id: bannerId, id: bannerId, type: r.type, mediaType: r.type, url: r.url, cover: r.cover, title: r.title, targetType: r.target_type, targetId: r.target_id, linkUrl: r.link_url, effectiveTime: r.effective_time });
        })
        : existingBanners;
    }
    // Older records used only homeBanners for the public carousel. Preserve
    // that read contract when the new explicit `banners` group is absent.
    if ((!Array.isArray(output.banners) || !output.banners.length) && existingBannerAlias.length === 0 && Array.isArray(output.homeBanners) && output.homeBanners.length) output.banners = output.homeBanners;
    const existingQuickNav = Array.isArray(output.quickNav) ? output.quickNav : [];
    output.quickNav = rows("home_quick_nav").sort((a, b) => a.nav_no - b.nav_no).map((r, index) => compactObject({ ...(existingQuickNav[index] || {}), targetType: r.target_type, label: r.label, icon: r.icon }));
    output.pageModules = output.pageModules && typeof output.pageModules === "object" ? output.pageModules : {};
    for (const module of rows("home_page_modules")) {
      const page = output.pageModules[module.page_key] || (output.pageModules[module.page_key] = { title: module.title || "" });
      if (!Array.isArray(page.enabledModules)) page.enabledModules = [];
      page.enabledModules.push(module.module_key);
    }
    const recommendations = {};
    for (const link of rows("home_page_links")) {
      if (link.page_key === "recommendations") {
        const list = recommendations[link.link_type] || (recommendations[link.link_type] = []);
        list.push(link.item_id);
        continue;
      }
      const page = output.pageModules[link.page_key] || (output.pageModules[link.page_key] = { title: "" });
      if (!Array.isArray(page.enabledModules)) page.enabledModules = [];
      const list = page[link.link_type] || (page[link.link_type] = []);
      if (!Array.isArray(list)) page[link.link_type] = [];
      page[link.link_type].push(link.item_id);
    }
    if (Object.keys(recommendations).length || Object.prototype.hasOwnProperty.call(output, "recommendations")) output.recommendations = recommendations;
    for (const page of Object.values(output.pageModules)) {
      if (!page || typeof page !== "object") continue;
      for (const [name, value] of Object.entries(page)) if (Array.isArray(value)) page[name] = [...new Set(value)];
    }
    // Keep the editor's round-trip document shape for clients that save the
    // `editorConfig` envelope, while the materialized top-level fields remain
    // the source of truth for the public contract.
    if (output.editorConfig && typeof output.editorConfig === "object" && !Array.isArray(output.editorConfig)) {
      output.editorConfig = {
        ...output.editorConfig,
        modules: output.modules,
        enabledModules: output.enabledModules,
        carouselIds: output.carouselIds,
        featuredPackageIds: output.featuredPackageIds,
        featuredAlbumIds: output.featuredAlbumIds,
        featuredPeripheralIds: output.featuredPeripheralIds,
        homeBanners: output.homeBanners,
        exploreBanners: output.exploreBanners,
        quickNav: output.quickNav,
        pageModules: output.pageModules,
        homeModules: output.homeModules,
        recommendations: output.recommendations
      };
    }
  }
  return output;
}

module.exports = {
  VERSION: 2,
  SCHEMA_VERSION: 2,
  ALL_KEYS,
  BUSINESS_KEYS: ALL_KEYS,
  TABLES,
  COLLECTIONS,
  RELATIONS,
  RELATION_TABLES,
  RELATION_BY_KEY,
  AUTH_ATTRIBUTE_TABLES,
  AUTH_NORMALIZED,
  AUTH_CORE,
  authCoreStatements,
  SENSITIVE_FIELDS,
  isSensitiveField,
  assertKey,
  tableName,
  quoteIdentifier,
  definition,
  relationNames,
  relationDefinition,
  schemaStatements,
  ensureSchema,
  splitDocument,
  normalizeDocumentAliases,
  materializeRelations,
  hydrateDocument,
  flattenLeaves,
  hydrateAttributeRows,
  COLLECTION_VALUES_TABLE,
  FINANCE_DOCUMENT_FIELDS,
  normalizeLogSnapshot,
  logSnapshotRelation
};
