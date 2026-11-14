"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createSource = require("./fixtures/jsonSource.cjs");
const createMysqlSource = require("../lib/mysqlSource.cjs");
const schema = require("../lib/mysqlSchema.cjs");

function spots() {
  return ["a", "b", "c", "d", "e"].map((id, index) => ({ id, name: id.toUpperCase(), sort: index + 1,
    cityId: index < 3 ? "city-a" : "city-b", tags: ["风景"], customNote: `保留-${id}` }));
}
function sorted(rows) {
  return rows.filter(row => !row.deleted && !row.isDeleted && row.sort > 0).sort((a, b) => a.sort - b.sort).map(row => row.id);
}
function tempDirectory(t) {
  const prefix = path.join(os.tmpdir(), "lxm-spot-order-source-");
  const directory = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)), "cleanup must stay in its temporary fixture");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function jsonFixture(t, rows = spots()) {
  const directory = tempDirectory(t);
  const file = path.join(directory, "db.json");
  fs.writeFileSync(file, JSON.stringify({ collections: { spots: Object.fromEntries(rows.map(row => [row.id, row])) } }), "utf8");
  const config = { backend: "json", jsonFile: file };
  return { source: createSource(config), file, restart: () => createSource(config) };
}

test("JSON inserts 5th point at 3rd and persists every shifted rank together", async t => {
  const { source, restart } = jsonFixture(t);
  const result = await source.applySpotMutation("e", { sort: 3, name: "E新名称" });
  assert.equal(result.saved.sort, 3);
  assert.equal(result.saved.name, "E新名称");
  assert.deepEqual(result.changes.map(change => change.id), ["c", "d", "e"]);
  assert.deepEqual(result.changes.map(change => change.before.sort), [3, 4, 5]);
  assert.deepEqual(sorted(await source.list("spots")), ["a", "b", "e", "c", "d"]);
  assert.deepEqual((await restart().list("spots")).map(row => [row.id, row.sort]), [["a", 1], ["b", 2], ["c", 4], ["d", 5], ["e", 3]]);
  assert.equal((await source.get("spots", "c")).customNote, "保留-c");
  assert.deepEqual((await source.get("spots", "d")).tags, ["风景"]);
});

test("JSON inserts new points, compacts clears/deletes, and restores at the retained position", async t => {
  const hidden = { id: "hidden", sort: 2, isShow: false };
  const blank = { id: "blank", sort: 0 };
  const deleted = { id: "deleted", sort: 3, deleted: true };
  const { source } = jsonFixture(t, [{ id: "a", sort: 1 }, hidden, { id: "c", sort: 3 }, blank, deleted]);
  const added = await source.applySpotMutation("new", { sort: 2, name: "新增" }, { create: true });
  assert.equal(added.saved.sort, 2);
  assert.equal(added.changes.at(-1).before, null);
  assert.deepEqual(sorted(await source.list("spots")), ["a", "new", "hidden", "c"]);
  await source.applySpotMutation("a", { sort: "" });
  assert.deepEqual(sorted(await source.list("spots")), ["new", "hidden", "c"]);
  assert.equal((await source.get("spots", "a")).sort, 0);
  const removed = await source.applySpotMutation("hidden", { deleted: true, isDeleted: true });
  assert.equal(removed.saved.sort, 2, "deleted points retain their place for restoration");
  assert.deepEqual(sorted(await source.list("spots")), ["new", "c"]);
  await source.applySpotMutation("hidden", { deleted: false, isDeleted: false });
  assert.deepEqual(sorted(await source.list("spots")), ["new", "hidden", "c"]);
  assert.equal((await source.get("spots", "blank")).sort, 0);
  assert.deepEqual(await source.get("spots", "deleted"), { ...deleted, _id: deleted.id });
});

test("JSON leaves order untouched on ordinary edits and rejects duplicate/missing mutations", async t => {
  const { source } = jsonFixture(t, [{ id: "a", sort: 7 }, { id: "b", sort: 7 }, { id: "c", sort: 25 }]);
  await source.applySpotMutation("a", { name: "新名称" });
  const unchanged = await source.applySpotMutation("b", { sort: "7" });
  assert.equal(unchanged.changes.length, 1);
  assert.deepEqual((await source.list("spots")).map(row => row.sort), [7, 7, 25]);
  assert.equal(await source.applySpotMutation("missing", { sort: 1 }), null);
  await assert.rejects(source.applySpotMutation("a", { sort: 1 }, { create: true }), { code: "DUPLICATE_RECORD" });
  assert.deepEqual((await source.list("spots")).map(row => row.sort), [7, 7, 25]);
});

test("concurrent JSON moves use the latest complete order and maintain unique consecutive ranks", async t => {
  const { source, restart } = jsonFixture(t);
  await Promise.all([source.applySpotMutation("e", { sort: 3 }), source.applySpotMutation("a", { sort: 4 })]);
  assert.deepEqual(sorted(await source.list("spots")), ["b", "e", "c", "a", "d"]);
  assert.deepEqual(sorted(await restart().list("spots")), ["b", "e", "c", "a", "d"]);
  assert.deepEqual((await source.list("spots")).map(row => row.sort).sort(), [1, 2, 3, 4, 5]);
});

test("explicit reorder resolves legacy ties even when the requested stored rank is unchanged", async t => {
  const { source } = jsonFixture(t, [{ id: "a", name: "A", sort: 1 }, { id: "b", name: "B", sort: 1 }, { id: "c", name: "C", sort: 9 }]);
  const result = await source.applySpotMutation("b", { sort: 1 }, { reorder: true });
  assert.equal(result.saved.sort, 1);
  assert.deepEqual(sorted(await source.list("spots")), ["b", "a", "c"]);
  assert.deepEqual((await source.list("spots")).map(row => row.sort), [2, 1, 3]);
});

test("JSON reorder writes one staged file and failed persistence restores cache and disk", async t => {
  const { source, file } = jsonFixture(t);
  const originalWrite = fs.writeFileSync;
  let writes = 0;
  let fail = true;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (String(target).startsWith(file + ".")) {
      writes++;
      if (fail) throw new Error("injected persistence failure");
    }
    return originalWrite(target, ...args);
  });
  const diskBefore = fs.readFileSync(file, "utf8");
  await assert.rejects(source.applySpotMutation("e", { sort: 2, customNote: "不可保留" }), /injected persistence failure/);
  assert.equal(writes, 1);
  assert.equal(fs.readFileSync(file, "utf8"), diskBefore);
  assert.deepEqual(sorted(await source.list("spots")), ["a", "b", "c", "d", "e"]);
  assert.equal((await source.get("spots", "e")).customNote, "保留-e");
  fail = false;
  await source.applySpotMutation("e", { sort: 2 });
  assert.equal(writes, 2, "a successful reorder also performs exactly one staged write");
  assert.deepEqual(sorted(await source.list("spots")), ["a", "e", "b", "c", "d"]);
});

test("JSON reorder rejects failed atomic publication without copying over the original file", async t => {
  const { source, file } = jsonFixture(t);
  const before = fs.readFileSync(file, "utf8");
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === file) throw new Error("injected publication failure");
    return originalRename(from, to);
  });
  const copy = t.mock.method(fs, "copyFileSync", () => { throw new Error("must not copy an atomic batch"); });
  await assert.rejects(source.applySpotMutation("e", { sort: 2 }), /injected publication failure/);
  assert.equal(copy.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(sorted(await source.list("spots")), ["a", "b", "c", "d", "e"]);
});

function mysqlFixture(initial = spots()) {
  let documents = initial.map(row => structuredClone(row));
  let snapshot;
  let active = false;
  const events = [];
  let writes = 0;
  let failAt = 0;
  const columns = new Map(schema.ALL_KEYS.map(key => [schema.tableName(key), schema.definition(key).columns.map(column => column.name)]));
  function physicalRows() { return documents.map(document => ({ id: document.id, ...schema.splitDocument("spots", document).columns })); }
  const conn = {
    async beginTransaction() { assert.equal(active, false); active = true; snapshot = structuredClone(documents); events.push("begin"); },
    async commit() { assert.equal(active, true); active = false; events.push("commit"); },
    async rollback() { documents = snapshot; active = false; events.push("rollback"); },
    release() { events.push("release"); },
    async query(sql, params = []) {
      if (sql.includes("information_schema.columns")) return [sql.includes("table_name IN") ? params.flatMap(table_name=>(columns.get(String(table_name)) || []).map(column_name=>({table_name,column_name}))) : (columns.get(String(params[0])) || []).map(column_name => ({ column_name }))];
      assert.equal(active, true, "every runtime read and write must use the transaction connection");
      if (sql.includes("SELECT * FROM `lxm_spots` ORDER BY id FOR UPDATE")) { events.push("lock"); return [physicalRows().sort((a, b) => a.id.localeCompare(b.id))]; }
      if (sql.includes("FROM `lxm_collection_values`") && sql.startsWith("SELECT")) {
        const ids = params.slice(1);
        return [documents.filter(row => ids.includes(row.id)).flatMap(row => schema.splitDocument("spots", row).attributes.map(attribute => ({ ...attribute, collection_name: "spots", record_id: row.id })))];
      }
      if (sql.startsWith("INSERT INTO `lxm_spots`")) {
        writes++;
        if (writes === failAt) throw new Error("injected second rank failure");
        const names = sql.match(/^INSERT INTO `lxm_spots` \(([^)]+)\)/)[1].split(",").map(name => name.trim().replaceAll("`", ""));
        const row = Object.fromEntries(names.map((name, index) => [name, params[index]]));
        const index = documents.findIndex(item => item.id === row.id);
        const current = index < 0 ? {} : documents[index];
        const next = { ...current, ...row };
        if (index < 0) documents.push(next); else documents[index] = next;
        events.push("write:" + row.id);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("DELETE FROM `lxm_collection_values`")) {
        const index = documents.findIndex(row => row.id === params[1]);
        const split = schema.splitDocument("spots", documents[index]);
        documents[index] = { id: documents[index].id, ...split.columns };
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO `lxm_collection_values`")) {
        const names = sql.match(/^INSERT INTO `lxm_collection_values` \(([^)]+)\)/)[1].split(",").map(name => name.trim().replaceAll("`", ""));
        const attribute = Object.fromEntries(names.map((name, index) => [name, params[index]]));
        const index = documents.findIndex(row => row.id === attribute.record_id);
        const split = schema.splitDocument("spots", documents[index]);
        documents[index] = schema.hydrateDocument("spots", { id: documents[index].id, ...split.columns }, { collection_values: [...split.attributes, attribute] });
        return [{ affectedRows: 1 }];
      }
      throw new Error("Unexpected MySQL spot mutation query: " + sql);
    }
  };
  const pool = { async getConnection() { return conn; }, async query() { throw new Error("runtime must not use the pool outside its transaction"); } };
  const source = createMysqlSource({ pool, autoMigrate: false, logger: { warn() {}, error() {} } });
  return { source, events, rows: () => structuredClone(documents), failAt: value => { failAt = value; } };
}

test("MySQL locks the complete latest order and commits point plus shifted ranks in one transaction", async t => {
  const f = mysqlFixture();
  t.after(() => f.source.close());
  const result = await f.source.applySpotMutation("e", { sort: 3, name: "E新名称" });
  assert.equal(result.saved.sort, 3);
  assert.deepEqual(sorted(f.rows()), ["a", "b", "e", "c", "d"]);
  assert.deepEqual(f.events.filter(event => event === "begin" || event === "lock" || event === "commit" || event.startsWith("write:")), ["begin", "lock", "write:c", "write:d", "write:e", "commit"]);
  assert.equal(f.rows().find(row => row.id === "d").customNote, "保留-d");
  assert.deepEqual(f.rows().find(row => row.id === "e").tags, ["风景"]);
});

test("MySQL rolls all rank writes back if a later rank persistence fails", async t => {
  const f = mysqlFixture();
  t.after(() => f.source.close());
  f.failAt(2);
  await assert.rejects(f.source.applySpotMutation("e", { sort: 3 }), /injected second rank failure/);
  assert.deepEqual(f.rows(), spots());
  assert.equal(f.events.includes("commit"), false);
  assert.equal(f.events.includes("rollback"), true);
});

