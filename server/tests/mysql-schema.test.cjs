"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("../lib/mysqlSchema.cjs");
const migrationRunner = require("../../scripts/migrate-mysql.cjs");
const mysqlPermission = require("../lib/mysqlPermissionStore.cjs");

const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_authz.sql"), "utf8");
const normalizedMigration = fs.readFileSync(path.join(__dirname, "..", "migrations", "002_business_normalized.sql"), "utf8");

test("normalized migration has no opaque business/auth payload columns", () => {
  assert.doesNotMatch(migration, /\b(?:doc|meta|extra)\s+(?:JSON|MEDIUMTEXT|LONGTEXT)\b/i);
  assert.doesNotMatch(migration, /CREATE TABLE[^;]+\bdoc\b/i);
  assert.doesNotMatch(migration, /\b(?:JSON|MEDIUMTEXT|LONGTEXT)\b/i);
  for (const key of schema.ALL_KEYS) assert.match(migration, new RegExp("CREATE TABLE IF NOT EXISTS \\`lxm_" + key + "\\`", "i"));
  assert.match(migration, /lxm_collection_values/);
  assert.match(migration, /lxm_order_products/);
  assert.match(migration, /lxm_log_order_exception_snapshots/);
  assert.doesNotMatch(migration, /`snapshot`\s+TEXT/i);
  assert.match(migration, /`snapshotText`\s+VARCHAR\(500\)/i);
  assert.match(migration, /lxm_home_page_modules/);
  for (const sql of [migration, normalizedMigration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `lxm_home_banners`[\s\S]*?banner_id VARCHAR\(128\) NULL/i);
  }
  assert.match(migration, /lxm_auth_user_permissions/);
  for (const relation of Object.values(schema.RELATIONS)) assert.match(migration, new RegExp("CREATE TABLE IF NOT EXISTS [`]?" + relation.table + "", "i"));
});

test("document splitter keeps scalar columns and typed relation leaves", () => {
  const input = {
    id: "ord_test",
    orderNo: "T-1",
    totalAmount: 321.5,
    settlementObservationReleased: false,
    products: [{ id: "pkg-1", type: "package", price: 321.5, snapshot: { name: "快照", serviceTags: ["精修"] } }],
    statusLogs: [{ action: "创建", from: "", to: "pending" }],
    source: { shopId: "shop-1", channel: "qr" },
    customField: { enabled: true, values: [] }
  };
  const split = schema.splitDocument("orders", input);
  assert.equal(split.id, "ord_test");
  assert.equal(split.columns.orderNo, "T-1");
  assert.equal(split.columns.totalAmount, 321.5);
  assert.equal(split.columns.settlementObservationReleased, false);
  assert.ok(split.relations.order_products.length === 1);
  assert.ok(split.attributes.some((row) => row.path === "customField.enabled" && row.value_type === "boolean"));
  assert.ok(split.attributes.some((row) => row.path === "customField.values" && row.value_type === "array"));
  const row = { id: split.id, ...split.columns };
  const restored = schema.hydrateDocument("orders", row, { collection_values: split.attributes, ...split.relations });
  assert.equal(restored.orderNo, input.orderNo);
  assert.equal(restored.totalAmount, input.totalAmount);
  assert.equal(restored.products[0].id, "pkg-1");
  assert.deepEqual(restored.products[0].snapshot.serviceTags, ["精修"]);
  assert.equal(restored.customField.enabled, true);
  assert.deepEqual(restored.customField.values, []);
});

test("credential-shaped fields are excluded from business leaves", () => {
  const split = schema.splitDocument("staff", { id: "staff-test", account: "tester", password: "never-store", profile: { token: "never-store" }, note: "ok" });
  assert.equal(Object.prototype.hasOwnProperty.call(split.columns, "password"), false);
  assert.equal(split.attributes.some((row) => /password|token/i.test(row.path)), false);
});

test("legacy siteConfig fragments stay fragment-shaped during hydration", () => {
  const split = schema.splitDocument("siteConfig", {
    id: "bookingNotice",
    0: "提前一天预约",
    1: "雨天可改期"
  });
  const restored = schema.hydrateDocument("siteConfig", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  assert.deepEqual({ 0: restored[0], 1: restored[1] }, { 0: "提前一天预约", 1: "雨天可改期" });
  assert.equal(Object.prototype.hasOwnProperty.call(restored, "search"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(restored, "bookingNotice"), false);
});

test("modeled nested paths are stored once in their relation", () => {
  const split = schema.splitDocument("orders", {
    id: "order-modeled",
    products: [{ id: "pkg-1", type: "package", price: 699, custom: "kept" }],
    contactPhones: ["13800000000"],
    source: { shopId: "shop-1", channel: "qr", custom: "kept" }
  });
  assert.equal(split.attributes.some((row) => /^products\[0\]\.(id|type|price)$/.test(row.path)), false);
  assert.equal(split.attributes.some((row) => row.path === "contactPhones[0]"), false);
  assert.equal(split.attributes.some((row) => row.path === "products[0].custom"), true);
  assert.equal(split.attributes.some((row) => row.path === "source.custom"), true);
});

test("structured log snapshots use explicit columns and reject unknown JSON", () => {
  const snapshot = JSON.stringify({
    before: { status: "pending", customerStatus: "待处理", sourceType: "qr", shopId: "shop-1", distributorId: "dist-1", riskBlocked: false },
    after: { status: "done", customerStatus: "已完成", sourceType: "manual", shopId: "shop-2", distributorId: "dist-2", riskBlocked: true }
  });
  const split = schema.splitDocument("logs", { id: "log-snapshot", snapshot });
  assert.equal(Object.prototype.hasOwnProperty.call(split.columns, "snapshotText"), false);
  assert.equal(split.attributes.some((row) => row.path === "snapshot"), false);
  assert.equal(split.relations.log_order_exception_snapshots.length, 1);
  const restored = schema.hydrateDocument("logs", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  assert.deepEqual(JSON.parse(restored.snapshot), JSON.parse(snapshot));
  assert.throws(() => schema.splitDocument("logs", { id: "log-bad", snapshot: '{"unknown":true}' }), /日志快照/);
  assert.throws(() => schema.splitDocument("logs", { id: "log-array", snapshot: "[1,2]" }), /日志快照/);
  const plain = schema.splitDocument("logs", { id: "log-text", snapshot: "导出范围" });
  assert.equal(plain.columns.snapshotText, "导出范围");
  const alias = schema.splitDocument("logs", { id: "log-alias", snapshotText: snapshot });
  assert.equal(Object.prototype.hasOwnProperty.call(alias.columns, "snapshotText"), false);
  assert.equal(alias.relations.log_order_exception_snapshots.length, 1);
});

test("migration row builder keeps omitted scalar fields untouched on upsert", () => {
  const row = migrationRunner.sqlRow("orders", "order-partial", { orderNo: "O-1" });
  assert.deepEqual(row, { id: "order-partial", orderNo: "O-1" });
});

test("home relation hydration preserves explicit sequence order", () => {
  const restored = schema.hydrateDocument("homeConfig", { id: "homeStats" }, {
    collection_values: [],
    home_page_links: [
      { config_id: "homeStats", page_key: "home", link_type: "bannerIds", item_id: "b2", sort_no: 1 },
      { config_id: "homeStats", page_key: "home", link_type: "bannerIds", item_id: "b1", sort_no: 0 }
    ]
  });
  assert.deepEqual(restored.pageModules.home.bannerIds, ["b1", "b2"]);
});

test("MySQL permission projections preserve user timestamps", () => {
  const user = mysqlPermission.safeUser({ id: "u", updatedAt: new Date("2026-01-02T03:04:05.006Z"), nested: { createdAt: new Date("2026-01-02T03:04:05.006Z") }, passwordHash: "hidden" });
  assert.equal(user.updatedAt, "2026-01-02T03:04:05.006Z");
  assert.equal(user.nested.createdAt, "2026-01-02T03:04:05.006Z");
  assert.equal(Object.prototype.hasOwnProperty.call(user, "passwordHash"), false);
});

test("MySQL permission attributes reject prototype-polluting paths", () => {
  const leaves = [];
  const input = { safe: "kept", nested: Object.create(null) };
  input.nested["__proto__"] = { polluted: "no" };
  mysqlPermission.__test.flatten(input, "extra", leaves);
  assert.ok(leaves.some((row) => row.path === "extra.safe"));
  assert.equal(leaves.some((row) => /(?:^|\.)__(?:proto)__(?:\.|$)|(?:^|\.)(?:constructor|prototype)(?:\.|$)/.test(row.path)), false);

  const restored = mysqlPermission.__test.hydrateAttributes([
    { path: "__proto__.polluted", value_type: "string", value_text: "no" },
    { path: "safe.value", value_type: "string", value_text: "kept" }
  ]);
  assert.equal(({}).polluted, undefined);
  assert.equal(restored.safe.value, "kept");
});

test("finance settings stay a closed scalar singleton", () => {
  const split = schema.splitDocument("financeSettings", {
    id: "global",
    settlementObservationDays: 4,
    largeSettlementThreshold: 9000,
    siteConfig: { privacyText: "must not cross collections" },
    nested: { value: "must not become a finance leaf" }
  });
  assert.deepEqual(split.attributes, []);
  const restored = schema.hydrateDocument("financeSettings", {
    id: "global",
    ...split.columns
  }, {
    collection_values: [{ path: "siteConfig.privacyText", value_type: "string", value_text: "stale" }]
  });
  assert.equal(restored.settlementObservationDays, 4);
  assert.equal(restored.largeSettlementThreshold, 9000);
  assert.equal(Object.prototype.hasOwnProperty.call(restored, "siteConfig"), false);
});

test("legacy order and package aliases materialize without losing item identity", () => {
  const order = schema.splitDocument("orders", {
    orderId: "order-alias",
    customerName: "客人",
    scheduleAt: "2026-09-10T10:00:00+08:00",
    amountTotal: 800,
    paidDeposit: 200,
    paidFinal: 600,
    remark: "备注",
    products: [{ id: "canonical", type: "package" }],
    productItems: [{ packageId: "pkg-alias", productId: "pkg-alias", productType: "package", qty: 2, packageName: "套餐" }]
  });
  assert.equal(order.id, "order-alias");
  assert.equal(order.columns.customer, "客人");
  assert.equal(order.columns.appointmentAt, "2026-09-10T10:00:00+08:00");
  assert.equal(order.columns.totalAmount, 800);
  assert.equal(order.columns.depositPaid, 200);
  assert.equal(order.columns.finalPaid, 600);
  assert.equal(order.columns.customerRemark, "备注");
  assert.equal(order.relations.order_products[0].product_id, "canonical");
  assert.equal(order.relations.order_products[0].quantity, 2);
  const row = { id: order.id, ...order.columns };
  const restored = schema.hydrateDocument("orders", row, { collection_values: order.attributes, ...order.relations });
  assert.equal(restored.products[0].id, "canonical");
  assert.equal(restored.products[0].productId, "canonical");
  assert.equal(restored.products[0].qty, 2);
  assert.equal(restored.items[0].packageId, "pkg-alias");
  assert.equal(restored.customerName, "客人");
  assert.equal(restored.scheduleAt, "2026-09-10T10:00:00+08:00");
  const pkg = schema.splitDocument("packages", { id: "pkg-alias", comboPrice: 499, items: [{ type: "photo", name: "精修" }] });
  const pkgRestored = schema.hydrateDocument("packages", { id: pkg.id, ...pkg.columns }, { collection_values: pkg.attributes, ...pkg.relations });
  assert.equal(pkg.columns.price, 499);
  assert.equal(pkgRestored.includedItems[0].name, "精修");
  assert.equal(pkgRestored.comboPrice, 499);
});

test("hydration synchronizes deleted lifecycle aliases", () => {
  const restored = schema.hydrateDocument("packages", { id: "deleted-package", isDeleted: 1 }, { collection_values: [] });
  assert.equal(restored.deleted, true);
  assert.equal(restored.isDeleted, true);
  const active = schema.hydrateDocument("packages", { id: "active-package", deleted: 0 }, { collection_values: [] });
  assert.equal(active.deleted, false);
  assert.equal(active.isDeleted, false);
});

test("alias-only updates are canonicalized before merging an existing document", () => {
  const current = { id: "order-update", totalAmount: 100, products: [{ id: "old", type: "package", quantity: 1 }] };
  const patch = schema.normalizeDocumentAliases("orders", { amountTotal: 200, productItems: [{ productId: "new", productType: "package", qty: 3 }] });
  const next = { ...current, ...patch, id: current.id };
  const split = schema.splitDocument("orders", next);
  assert.equal(split.columns.totalAmount, 200);
  assert.equal(split.relations.order_products[0].product_id, "new");
  assert.equal(split.relations.order_products[0].quantity, 3);
});

test("home banner aliases materialize into the dedicated relation table", () => {
  const split = schema.splitDocument("homeConfig", {
    id: "homeStats",
    homeBanners: [],
    editorConfig: {
      activity: "首页标题",
      homeBanners: [{ _id: "hero-1", image: "https://cdn.test/hero.jpg", jumpType: "package", jumpId: "pkg-1" }],
      exploreBanners: [],
      quickNav: [{ targetType: "package_list", label: "套餐" }]
    }
  });
  assert.equal(split.relations.home_banners.length, 1);
  assert.equal(split.relations.home_banners[0].banner_group, "homeBanners");
  assert.equal(split.relations.home_banners[0].banner_id, "hero-1");
  assert.equal(split.relations.home_banners[0].url, "https://cdn.test/hero.jpg");
  assert.equal(split.relations.home_banners[0].target_type, "package");
  assert.equal(split.attributes.some((row) => row.path.startsWith("editorConfig.homeBanners")), false);
  assert.equal(split.attributes.some((row) => /^homeBanners\[0\]\.(?:_id|id)$/.test(row.path)), false);
  const restored = schema.hydrateDocument("homeConfig", { id: split.id, ...split.columns }, {
    collection_values: split.attributes,
    ...split.relations
  });
  assert.equal(restored.banners[0].url, "https://cdn.test/hero.jpg");
  assert.equal(restored.homeBanners[0]._id, "hero-1");
  assert.equal(restored.homeBanners[0].id, "hero-1");
  assert.equal(restored.editorConfig.homeBanners[0].targetType, "package");
  assert.equal(restored.quickNav[0].label, "套餐");
});

test("home materialized fields do not leave typed attribute duplicates for empty relations", () => {
  const split = schema.splitDocument("homeConfig", {
    id: "home-empty-relations",
    homeBanners: [],
    exploreBanners: [],
    quickNav: [],
    homeModules: [],
    pageModules: {
      home: { title: "首页", enabledModules: ["banner"], bannerIds: [], packageIds: [] },
      booking: { title: "预约", enabledModules: [], guideIds: [] }
    },
    recommendations: { hotPackageIds: [], guideIds: [] }
  });
  assert.equal(split.relations.home_page_modules[0].title, "首页");
  assert.equal(split.attributes.some((row) => /^(homeBanners|exploreBanners|quickNav|homeModules)$/.test(row.path)), false);
  assert.equal(split.attributes.some((row) => /^pageModules\.(?:home|booking)\.(?:title|enabledModules|bannerIds|packageIds|guideIds)/.test(row.path)), false);
  assert.equal(split.attributes.some((row) => /^recommendations\.(?:hotPackageIds|guideIds)/.test(row.path)), false);
});

test("account aliases and order product aliases remain relational", () => {
  const staff = schema.splitDocument("staff", {
    id: "staff-relational", permissionKeys: ["view", "orderEdit"], subjectType: "staff", subjectId: "staff-relational"
  });
  assert.deepEqual(staff.relations.account_permissions.map((row) => row.permission_key), ["view", "orderEdit"]);
  assert.equal(staff.attributes.some((row) => /^(permissionKeys|subjectType|subjectId)/.test(row.path)), false);
  const shop = schema.splitDocument("shops", { id: "shop-relational", distributorIds: [], distributorRates: {} });
  assert.equal(shop.attributes.some((row) => /^(distributorIds|distributorRates)/.test(row.path)), false);
  const order = schema.splitDocument("orders", {
    id: "order-photo-package", items: [{ packageId: "pkg-photo", productType: "photo", price: 88, qty: 2 }]
  });
  assert.equal(order.attributes.some((row) => /^items\[0\]\.(packageId|price)/.test(row.path)), false);
  const restored = schema.hydrateDocument("orders", { id: order.id }, { collection_values: order.attributes, ...order.relations });
  assert.equal(restored.items[0].packageId, "pkg-photo");
  assert.equal(restored.items[0].qty, 2);
});
