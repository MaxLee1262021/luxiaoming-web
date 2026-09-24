"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../lib/mysqlSchema.cjs");
const createMysqlSource = require("../lib/mysqlSource.cjs");
const createMysqlPermissionStore = require("../lib/mysqlPermissionStore.cjs");

function relationColumns() {
  return new Map(Object.values(schema.RELATIONS).map((relation) => [
    relation.table,
    relation.columns.map((column) => String(column).trim().split(/\s+/, 1)[0])
  ]));
}

function metadataSourcePool() {
  const collectionColumns = new Map(schema.ALL_KEYS.map((key) => [
    schema.tableName(key),
    schema.definition(key).columns.map((column) => column.name)
  ]));
  const relations = relationColumns();

  return {
    async query(sql, params = []) {
      if (sql.includes("information_schema.columns")) {
        const table = String(params[0]);
        const columns = table === "lxm_business_documents"
          ? []
          : collectionColumns.get(table) || relations.get(table) || [];
        return [columns.map((column) => ({ COLUMN_NAME: column }))];
      }
      if (sql.includes("information_schema.tables")) return [[{ count: params.length }]];
      if (sql.includes("information_schema.statistics")) return [[{ COLUMN_NAME: "updatedAt", INDEX_NAME: "idx_updated_at" }]];
      if (sql.includes("FROM `lxm_collection_values`")) return [[{ count: 0 }]];
      if (sql.includes("LEFT JOIN")) return [[{ count: 0 }]];
      throw new Error(`Unexpected source metadata query: ${sql}`);
    }
  };
}

function metadataPermissionPool() {
  const columns = new Map([
    ["lxm_auth_menus", ["id", "menu_key", "meta_group", "meta_type", "meta_label"]],
    ["lxm_auth_users", ["id", "account", "password_hash", "role_id", "legacy_key", "subject_type", "subject_id"]]
  ]);

  return {
    async query(sql, params = []) {
      if (sql === "SELECT 1 AS ok") return [[{ ok: 1 }]];
      if (sql.includes("information_schema.tables")) return [[{ count: 8 }]];
      if (sql.includes("information_schema.columns")) {
        const names = columns.get(String(params[0])) || [];
        return [names.map((name) => ({ COLUMN_NAME: name }))];
      }
      if (sql.includes("information_schema.statistics") && sql.includes("table_name IN")) {
        return [[
          { TABLE_NAME: "lxm_auth_menus", INDEX_NAME: "menu_key", NON_UNIQUE: 0, COLUMN_NAME: "menu_key" },
          { TABLE_NAME: "lxm_auth_roles", INDEX_NAME: "role_key", NON_UNIQUE: 0, COLUMN_NAME: "role_key" },
          { TABLE_NAME: "lxm_auth_users", INDEX_NAME: "account", NON_UNIQUE: 0, COLUMN_NAME: "account" }
        ]];
      }
      if (sql.includes("information_schema.statistics")) return [[{ COLUMN_NAME: "subject_type" }]];
      throw new Error(`Unexpected permission metadata query: ${sql}`);
    }
  };
}

test("MySQL business health accepts uppercase information_schema metadata fields", async () => {
  const source = createMysqlSource({ pool: metadataSourcePool(), autoMigrate: false });
  try {
    const health = await source.health();
    assert.equal(health.ready, true);
    assert.equal(health.error, undefined);
    assert.equal(health.tables, schema.ALL_KEYS.length);
  } finally {
    await source.close();
  }
});

test("MySQL permission health accepts uppercase information_schema metadata fields", async () => {
  const store = createMysqlPermissionStore({ pool: metadataPermissionPool(), autoMigrate: false });
  try {
    const health = await store.health();
    assert.equal(health.ready, true);
    assert.equal(health.normalized, true);
    assert.equal(health.error, undefined);
  } finally {
    await store.close();
  }
});

test("batched relation hydration groups rows without cross-record leakage", () => {
  const grouped = createMysqlSource.groupRelationRows(
    ["order-a", "order-b"],
    [
      { record_id: "order-a", path: "custom.flag", value_type: "boolean", value_bool: 1 },
      { record_id: "order-b", path: "custom.note", value_type: "string", value_text: "ok" },
    ],
    {
      order_products: {
        parentColumn: "order_id",
        rows: [
          { order_id: "order-a", item_no: 0, product_id: "pkg-a" },
          { order_id: "order-b", item_no: 0, product_id: "pkg-b" },
        ],
      },
    },
  );
  assert.equal(grouped.get("order-a")[schema.COLLECTION_VALUES_TABLE].length, 1);
  assert.equal(grouped.get("order-b")[schema.COLLECTION_VALUES_TABLE].length, 1);
  assert.deepEqual(grouped.get("order-a").order_products.map((row) => row.product_id), ["pkg-a"]);
  assert.deepEqual(grouped.get("order-b").order_products.map((row) => row.product_id), ["pkg-b"]);
});
