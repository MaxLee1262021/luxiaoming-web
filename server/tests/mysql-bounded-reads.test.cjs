"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./mysql-bounded-reads-fixture.cjs");

const documents = {
  cities: [{ id: "same", name: "长沙", custom: "city" }],
  staff: [{ id: "same", name: "客服", custom: "staff" }],
  albums: Array.from({ length: 7 }, (_, index) => ({ id: `album-${index}`, name: `相册${index}`, photoIds: ["photo-2", "photo-1"], tags: ["night", "city"], custom: { order: index } })),
  orders: [
    { id: "Order-A", status: "pending", custom: { leaf: ["a", "b"] }, products: [{ id: "product", type: "package", name: "套餐", quantity: 1, snapshot: { name: "下单时套餐", serviceTags: ["旧标签"] } }], paymentRecords: [{ id: "pay", phase: "deposit", amount: 10, status: "confirmed" }], statusLogs: [{ action: "已支付", createTime: "2026-11-23 10:00:00" }], followRecords: [{ note: "已联系" }], packageSnapshot: { id: "package", name: "原始快照" } },
    { id: "café", status: "confirmed", products: [], custom: "accent alias" },
    { id: "0", name: "zero" }
  ]
};

test("bounded lists retain every row, requested collection order, nested relations and typed-leaf overrides", async () => {
  const f = fixture(documents);
  f.physical.get("orders")[0].split.attributes.push({ path: "status", ordinal: 0, value_type: "string", value_text: "confirmed" });
  const expected = {};
  for (const key of ["orders", "cities", "staff", "albums"]) {
    expected[key] = [];
    for (const document of documents[key]) expected[key].push(await f.source.get(key, document.id));
    assert.deepEqual(await f.source.list(key), expected[key]);
  }
  assert.deepEqual(await f.source.listMany(["orders", "cities", "staff", "albums", "orders"]), expected);
  assert.equal(expected.orders[0].status, "confirmed", "typed leaves still override stale columns");
  assert.deepEqual(expected.albums[6].photoIds, ["photo-2", "photo-1"]);
  const result = await f.source.listMany(["orders"]);
  result.orders[0].products[0].name = "consumer edit";
  assert.deepEqual((await f.source.listMany(["orders"])).orders, expected.orders, "no cross-request document reuse");
});

test("listMany bounds pending typed-leaf batches instead of eagerly scheduling the entire history", async () => {
  const f = fixture({ albums: Array.from({ length: 91 }, (_, index) => ({ id: `a-${index}`, name: String(index), tags: ["one"], custom: index })) }, { batchSize: 2, connectionLimit: 3 });
  const result = await f.source.listMany(["albums"]);
  assert.equal(result.albums.length, 91);
  assert.equal(f.stats.attributePeak, 2, "bounded work still overlaps independent batches without queuing every relation fanout");
  assert.ok(f.stats.queries.filter(query => query.sql.includes("FROM `lxm_collection_values`")).every(query => query.params.length <= 3), "every EAV batch contains at most two IDs plus its collection");
  assert.deepEqual(result.albums.map(row => row.custom), Array.from({ length: 91 }, (_, index) => index));
});

test("getMany aligns missing, duplicate, case/accent/space aliases and numeric IDs with independent get calls", async () => {
  const f = fixture(documents);
  const ids = ["Order-A", "missing", "order-a", "Order-A", "cafe", "café ", 0, "0", "x' OR 1=1 --"];
  const expected = await Promise.all(ids.map(id => f.source.get("orders", String(id))));
  const actual = await f.source.getMany("orders", ids);
  assert.deepEqual(actual, expected);
  assert.equal(actual[1], null);
  assert.equal(actual.at(-1), null);
  actual[0].products[0].name = "isolated";
  assert.equal(actual[2].products[0].name, "套餐");
  assert.equal(actual[3].products[0].name, "套餐");
  assert.notEqual(actual[6], actual[7]);
  assert.ok(actual.filter(Boolean).every(row => !Object.hasOwn(row, "__read_index")));
});

test("getMany uses bounded indexed batches, never reads a full main table and does not retry missing IDs", async () => {
  const f = fixture({ cities: Array.from({ length: 257 }, (_, index) => ({ id: `c-${index}`, name: String(index), custom: { index } })) }, { batchSize: 500 });
  const ids = [...Array.from({ length: 257 }, (_, index) => `c-${index}`), "missing"];
  const result = await f.source.getMany("cities", ids);
  assert.equal(result.length, ids.length);
  assert.equal(result.at(-1), null);
  const main = f.stats.queries.filter(query => query.sql.includes("FROM `lxm_cities`"));
  assert.equal(main.length, 3, "258 independent gets need three main-table network round trips");
  assert.ok(main.every(query => query.params.length <= 100 && !query.sql.includes("ORDER BY id")));
  const attributes = f.stats.queries.filter(query => query.sql.includes("FROM `lxm_collection_values`"));
  assert.equal(attributes.length, 3);
  assert.deepEqual(result.slice(0, -1).map(row => row.custom.index), Array.from({ length: 257 }, (_, index) => index));
});

test("getMany retains get hydration for empty stored IDs and historical relation-owner case variants", async () => {
  const f = fixture({ orders: [...documents.orders, { id: "", name: "empty key", custom: { leaf: 1 }, products: [{ id: "empty-product", name: "empty-key product" }] }] });
  const first = f.physical.get("orders")[0];
  first.attributeOwner = "order-a";
  first.split.relations.order_products[0].order_id = "order-a";
  const ids = ["Order-A", "order-a", "", " "];
  const expected = await Promise.all(ids.map(id => f.source.get("orders", id)));
  assert.deepEqual(await f.source.getMany("orders", ids), expected);
  assert.deepEqual(expected[0].custom, { leaf: ["a", "b"] });
  assert.equal(expected[2].products[0].name, "empty-key product");
});

test("getMany validates identifiers before SQL and fails closed on missing schema or relation failure", async () => {
  const f = fixture(documents);
  await assert.rejects(f.source.getMany("lxm_auth_users", ["one"]), { code: "DATA_KEY_INVALID" });
  await assert.rejects(f.source.getMany("orders", "one"), { code: "DATA_SOURCE_INVALID" });
  assert.deepEqual(await f.source.getMany("orders", []), []);
  assert.equal(f.stats.queries.length, 0);
  f.stats.failRelation = true;
  await assert.rejects(f.source.getMany("orders", ["Order-A"]), { code: "QA_RELATION_FAILURE" });
  const missing = fixture({}, { missing: ["orders"] });
  await assert.rejects(missing.source.getMany("orders", ["one"]), { code: "SCHEMA_MISSING" });
});

test("legacy batch reads retain get sanitization and reject malformed payloads", async () => {
  const f = fixture({ albums: [{ id: "Legacy", name: "旧相册", tags: ["原始标签"], password: "excluded", custom: { nested: 1 } }] }, { legacy: ["albums"] });
  const ids = ["legacy", "missing", "Legacy"];
  assert.deepEqual(await f.source.getMany("albums", ids), await Promise.all(ids.map(id => f.source.get("albums", id))));
  assert.deepEqual((await f.source.listMany(["albums"])).albums, await f.source.list("albums"));
  f.physical.get("albums")[0].doc = "invalid JSON";
  await assert.rejects(f.source.getMany("albums", ["Legacy"]), { code: "DATA_SOURCE_INVALID" });
});
