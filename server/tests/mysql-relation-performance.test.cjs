"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../lib/mysqlSchema.cjs");
const createMysqlSource = require("../lib/mysqlSource.cjs");

function fixture(key, documents) {
  const physical = documents.map((document) => {
    const split = schema.splitDocument(key, document);
    return { id: document.id, split, row: { id: document.id, ...split.columns } };
  });
  const columns = new Map(schema.ALL_KEYS.map((name) => [
    schema.tableName(name), schema.definition(name).columns.map((column) => column.name)
  ]));
  const statistics = { active: 0, peak: 0, relationReads: [], transactionPeak: 0, rollback: false };
  let transactionActive = false;
  let transactionReads = 0;

  async function reply(sql, params = [], dedicated = false) {
    if (sql.includes("information_schema.columns")) {
      if (sql.includes("table_name IN")) return [params.flatMap(table_name => (columns.get(String(table_name)) || []).map(column_name => ({ table_name,column_name })))];
      return [(columns.get(String(params[0])) || []).map((column_name) => ({ column_name }))];
    }
    if (sql.startsWith("INSERT ")) throw new Error("stop-before-write");
    if (sql.startsWith(`SELECT * FROM \`${schema.tableName(key)}\``)) {
      const selected = sql.includes("WHERE id=?") ? physical.filter((item) => item.id === params[0]) : physical;
      return [selected.map((item) => item.row)];
    }
    const table = (sql.match(/FROM `([^`]+)`/) || [])[1];
    const relationName = (schema.RELATION_BY_KEY[key] || []).find((name) => schema.RELATIONS[name].table === table);
    assert.ok(table === schema.RELATIONS.collection_values.table || relationName, `unexpected SQL: ${sql}`);
    if (dedicated) {
      assert.equal(transactionActive, true, "a dedicated runtime read must stay in its transaction");
      transactionReads++;
      statistics.transactionPeak = Math.max(statistics.transactionPeak, transactionReads);
    } else {
      statistics.active++;
      statistics.peak = Math.max(statistics.peak, statistics.active);
    }
    const ids = table === schema.RELATIONS.collection_values.table ? params.slice(1) : params;
    statistics.relationReads.push({ table, ids, dedicated });
    // Resolve on the next event-loop turn, exposing whether independent reads
    // were started together without relying on elapsed-time assertions.
    await new Promise(setImmediate);
    const rows = physical.filter((item) => ids.includes(item.id)).flatMap((item) => table === schema.RELATIONS.collection_values.table
      ? item.split.attributes.map((attribute) => ({ ...attribute, collection_name: key, record_id: item.id }))
      : item.split.relations[relationName] || []);
    if (dedicated) transactionReads--;
    else statistics.active--;
    return [rows];
  }
  const connection = {
    async query(sql, params) { return reply(sql, params, true); },
    async beginTransaction() { transactionActive = true; },
    async commit() { transactionActive = false; },
    async rollback() { transactionActive = false; statistics.rollback = true; },
    release() {}
  };
  const pool = {
    async query(sql, params) { return reply(sql, params); },
    async getConnection() { return connection; }
  };
  const source = createMysqlSource({ pool, autoMigrate: false, relationBatchSize: 2, logger: { warn() {}, error() {} } });
  return { source, statistics };
}

test("album list reads each relation batch concurrently and preserves record isolation", async (t) => {
  const { source, statistics } = fixture("albums", [
    { id: "album-a", name: "A", photoIds: ["photo-a"], tags: ["A-tag"], custom: "A-only" },
    { id: "album-b", name: "B", photoIds: ["photo-b"], tags: ["B-tag"], custom: "B-only" },
    { id: "album-c", name: "C", photoIds: ["photo-c"], tags: ["C-tag"], custom: "C-only" }
  ]);
  t.after(() => source.close());
  const rows = await source.list("albums");
  assert.equal(statistics.peak, 3, "attributes and the two album relations should share one round trip");
  assert.equal(statistics.relationReads.length, 6, "three records use two bounded batches, not per-record queries");
  assert.ok(statistics.relationReads.every((read) => read.ids.length <= 2));
  assert.deepEqual(rows.map((row) => ({ id: row.id, photoIds: row.photoIds, tags: row.tags, custom: row.custom })), [
    { id: "album-a", photoIds: ["photo-a"], tags: ["A-tag"], custom: "A-only" },
    { id: "album-b", photoIds: ["photo-b"], tags: ["B-tag"], custom: "B-only" },
    { id: "album-c", photoIds: ["photo-c"], tags: ["C-tag"], custom: "C-only" }
  ]);
});

test("home config relation reads start together and retain configured banner order", async (t) => {
  const { source, statistics } = fixture("homeConfig", [{
    id: "homeStats", activityNotice: "notice", hotSearchKeywords: ["旅拍"],
    homeBanners: [
      { id: "second-name-first", type: "image", url: "https://cdn.test/first.jpg" },
      { id: "first-name-second", type: "image", url: "https://cdn.test/second.jpg" }
    ]
  }]);
  t.after(() => source.close());
  const config = await source.get("homeConfig", "homeStats");
  assert.equal(statistics.peak, 7, "the six config relations and attributes should share one round trip");
  assert.deepEqual(config.homeBanners.map((banner) => banner.url), ["https://cdn.test/first.jpg", "https://cdn.test/second.jpg"]);
  assert.deepEqual(config.hotSearchKeywords, ["旅拍"]);
  assert.equal(config.activityNotice, "notice");
});

test("transaction hydration remains serial on its dedicated connection", async (t) => {
  const { source, statistics } = fixture("albums", [{ id: "album-a", name: "A", photoIds: ["photo-a"], tags: ["A-tag"] }]);
  t.after(() => source.close());
  await assert.rejects(source.update("albums", "album-a", { name: "updated" }), /stop-before-write/);
  assert.equal(statistics.peak, 0, "no transactional relation read may escape to the pool");
  assert.equal(statistics.transactionPeak, 1, "the transaction connection must preserve query order");
  assert.equal(statistics.relationReads.length, 3);
  assert.ok(statistics.relationReads.every((read) => read.dedicated));
  assert.equal(statistics.rollback, true);
});
