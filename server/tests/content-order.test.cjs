"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const createSource = require("./fixtures/jsonSource.cjs");
const createMysqlSource = require("../lib/mysqlSource.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const order = require("../lib/contentOrder.cjs");

const photo = (id, sort, extra = {}) => ({ id, _id: id, name: id, sort, tags: ["清新"], price: 100, isShow: false, ...extra });
const defaults = () => ({
  albums: [photo("a", 1), photo("b", 2), photo("c", 3), photo("d", 4)],
  packages: [photo("v1", 1, { productKind: "video_single" }), photo("p1", 1, { productKind: "package" }),
    photo("v2", 2, { productKind: "video_single" }), photo("p2", 2, { productKind: "package" })],
  guides: [{ id: "g1", title: "置顶", isTop: true, updatedAt: 1000, sort: 1 }, { id: "g2", title: "第二", updatedAt: 2000, sort: 2 }]
});

async function fixture(t, initial = defaults()) {
  const prefix = path.join(os.tmpdir(), "lxm-content-order-");
  const directory = fs.mkdtempSync(prefix);
  const file = path.join(directory, "db.json");
  const collections = Object.fromEntries(Object.entries({
    staff: [{ id: "admin", role: "super", status: "启用" }, { id: "editor", role: "content", status: "启用" }, { id: "viewer", role: "service", status: "启用" }],
    spots: [], cities: [], series: [], peripherals: [], tagLibrary: [], logs: [], trash: [], ...initial
  }).map(([key, rows]) => [key, Object.fromEntries(rows.map(row => [row.id, row]))]));
  fs.writeFileSync(file, JSON.stringify({ collections }));
  const source = createSource({ backend: "json", jsonFile: file });
  const auth = { async init() {}, async getSession(token) {
    const role = { admin: "super", editor: "content", viewer: "service" }[token];
    return role ? { kind: "admin", role, subjectId: token, account: token } : null;
  } };
  const handler = createApi(source, "json", { auth });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await source.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(key, id, body, method = "PUT", token = "admin") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/collection/${key}${id ? `/${id}` : ""}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  return { source, file, request, ordered: async (key, target) => order.ordered(key, await source.list(key), target).map(row => [row.id, row.sort]) };
}

test("升序/降序 insert one place, shift siblings, and persist the same order after restart", async t => {
  const f = await fixture(t);
  const up = await f.request("albums", "d", { sortDirection: -1 });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.sort, 3);
  assert.deepEqual(new Map(up.body.__contentOrder.map(row => [row.id, row.sort])), new Map([["a", 1], ["b", 2], ["c", 4], ["d", 3]]));
  assert.deepEqual(await f.ordered("albums"), [["a", 1], ["b", 2], ["d", 3], ["c", 4]]);
  assert.equal((await f.request("albums", "b", { sortDirection: 1 })).status, 200);
  assert.deepEqual(await f.ordered("albums"), [["a", 1], ["d", 2], ["b", 3], ["c", 4]]);
  const restart = createSource({ backend: "json", jsonFile: f.file });
  assert.deepEqual(order.ordered("albums", await restart.list("albums")).map(row => row.id), ["a", "d", "b", "c"]);
  await restart.close();
});

test("target positions move directly from 30 to 3, to the front, and backwards with one persisted order", async t => {
  const albums = Array.from({ length: 30 }, (_, index) => photo(`photo-${index + 1}`, index + 1));
  const f = await fixture(t, { albums });
  const move = await f.request("albums", "photo-30", { targetPosition: 3 }, "PUT", "editor");
  assert.equal(move.status, 200, JSON.stringify(move.body));
  assert.equal(move.body.sort, 3);
  assert.equal(move.body.targetPosition, undefined);
  const expected = ["photo-1", "photo-2", "photo-30", ...albums.slice(2, 29).map(row => row.id)];
  assert.deepEqual(await f.ordered("albums"), expected.map((id, index) => [id, index + 1]));
  assert.deepEqual(new Map(move.body.__contentOrder.map(row => [row.id, row.sort])), new Map(expected.map((id, index) => [id, index + 1])));
  assert.equal((await f.request("albums", "photo-30", { targetPosition: 1 })).status, 200);
  assert.deepEqual((await f.ordered("albums")).slice(0, 4), [["photo-30", 1], ["photo-1", 2], ["photo-2", 3], ["photo-3", 4]]);
  assert.equal((await f.request("albums", "photo-30", { targetPosition: 30 })).status, 200);
  assert.deepEqual(await f.ordered("albums"), albums.map(row => [row.id, row.sort]));
  assert.equal((await f.request("albums", "photo-30", { targetPosition: 30 })).status, 200);
  const stored = await f.source.list("albums");
  assert.equal(stored.some(row => Object.hasOwn(row, "targetPosition")), false);
  const restart = createSource({ backend: "json", jsonFile: f.file });
  assert.deepEqual(order.ordered("albums", await restart.list("albums")).map(row => [row.id, row.sort]), albums.map(row => [row.id, row.sort]));
  await restart.close();
});

test("target positions count hidden siblings globally, exclude deleted rows, and skip ordinary publication edits", async t => {
  const f = await fixture(t, { albums: [photo("visible", 0, { isShow: true, tags: undefined, hotScore: 30 }),
    photo("hidden", 0, { hotScore: 20 }), photo("moving", 0, { hotScore: 10 }), photo("deleted", 1, { deleted: true })] });
  const result = await f.request("albums", "moving", { targetPosition: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(await f.ordered("albums"), [["moving", 1], ["visible", 2], ["hidden", 3]]);
  assert.equal((await f.source.get("albums", "visible")).tags, undefined);
  assert.equal((await f.source.get("albums", "visible")).isShow, true);
  assert.equal((await f.source.get("albums", "hidden")).isShow, false);
  assert.equal((await f.source.get("albums", "deleted")).sort, 1);
  assert.equal((await f.request("albums", "moving", { targetPosition: 4 })).status, 400);
  assert.equal((await f.request("albums", "deleted", { targetPosition: 1 })).status, 409);
});

test("video singles and bundles keep independent orders even when both are stored in packages", async t => {
  const f = await fixture(t);
  const beforeAlbums = await f.source.list("albums");
  assert.equal((await f.request("packages", "v2", { sortDirection: -1 })).status, 200);
  assert.deepEqual(await f.ordered("packages", { productKind: "video_single" }), [["v2", 1], ["v1", 2]]);
  assert.deepEqual(await f.ordered("packages", { productKind: "package" }), [["p1", 1], ["p2", 2]]);
  assert.equal((await f.request("packages", "p2", { sortDirection: -1 })).status, 200);
  assert.deepEqual(await f.ordered("packages", { productKind: "package" }), [["p2", 1], ["p1", 2]]);
  assert.deepEqual(await f.source.list("albums"), beforeAlbums);
});

test("direct positions isolate video singles, legacy videos, bundles and other collections", async t => {
  const initial = defaults();
  initial.packages.push(photo("legacy1", 1, { type: "video" }), photo("legacy2", 2, { type: "video" }));
  const f = await fixture(t, initial);
  const beforeAlbums = await f.source.list("albums");
  const beforeGuides = await f.source.list("guides");
  const beforePackages = await f.source.list("packages");
  assert.equal((await f.request("packages", "v2", { targetPosition: 3 })).status, 400, "the bound is the video-single group size, not the shared table size");
  assert.deepEqual(await f.source.list("packages"), beforePackages);
  assert.equal((await f.request("packages", "v2", { targetPosition: 1 })).status, 200);
  assert.deepEqual(await f.ordered("packages", { productKind: "video_single" }), [["v2", 1], ["v1", 2]]);
  assert.deepEqual(await f.ordered("packages", { type: "video" }), [["legacy1", 1], ["legacy2", 2]]);
  assert.deepEqual(await f.ordered("packages", { productKind: "package" }), [["p1", 1], ["p2", 2]]);
  assert.equal((await f.request("packages", "legacy2", { targetPosition: 1 })).status, 200);
  assert.equal((await f.request("packages", "p1", { targetPosition: 2 })).status, 200);
  assert.deepEqual(await f.ordered("packages", { productKind: "video_single" }), [["v2", 1], ["v1", 2]]);
  assert.deepEqual(await f.ordered("packages", { type: "video" }), [["legacy2", 1], ["legacy1", 2]]);
  assert.deepEqual(await f.ordered("packages", { productKind: "package" }), [["p2", 1], ["p1", 2]]);
  assert.deepEqual(await f.source.list("albums"), beforeAlbums);
  assert.deepEqual(await f.source.list("guides"), beforeGuides);
});

test("target positions reject invalid values, mixed fields, unsupported collections, methods and viewers without writes", async t => {
  const f = await fixture(t);
  const before = await f.source.list("albums");
  for (const targetPosition of [0, -1, 1.5, "2", null, true, {}, [], 5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await f.request("albums", "d", { targetPosition });
    assert.equal(result.status, 400, JSON.stringify({ targetPosition, result }));
  }
  for (const body of [{ targetPosition: 1, sortDirection: -1 }, { targetPosition: 1, name: "不能保存" },
    { targetPosition: 1, sort: 2 }, { targetPosition: 1, __contentOrder: [] }, { targetPosition: 1, deleted: true }]) {
    assert.equal((await f.request("albums", "d", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.request("albums", "", { targetPosition: 1 }, "POST")).status, 400);
  assert.equal((await f.request("albums", "", { targetPosition: 1 })).status, 400);
  assert.equal((await f.request("spots", "none", { targetPosition: 1 })).status, 400);
  assert.equal((await f.request("albums", "d", { targetPosition: 1 }, "PUT", "viewer")).status, 403);
  assert.deepEqual(await f.source.list("albums"), before);
  assert.equal((await f.source.list("logs")).some(row => row.action === "调整商品排序"), false);
  const plan = order.planContentMutation("albums", before, "d", { name: "普通编辑", targetPosition: 1 });
  assert.equal(plan.saved.sort, 4, "ordinary mutation patches cannot become reorder commands");
  assert.equal(plan.saved.targetPosition, undefined);
  assert.equal(plan.saved.name, "普通编辑");
});

test("sorting legacy visible products skips publication repair and preserves fields; hidden records participate globally", async t => {
  const f = await fixture(t, { albums: [photo("a", 0, { hotScore: 9, tags: undefined, isShow: true }),
    photo("b", undefined, { hotScore: 8, tags: undefined }), photo("c", -4, { hotScore: 7 }), photo("deleted", 1, { deleted: true })] });
  const response = await f.request("albums", "c", { sortDirection: -1 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(await f.ordered("albums"), [["a", 1], ["c", 2], ["b", 3]]);
  assert.equal((await f.source.get("albums", "a")).isShow, true);
  assert.equal((await f.source.get("albums", "a")).tags, undefined);
  assert.equal((await f.source.get("albums", "c")).sortDirection, undefined);
  assert.equal((await f.source.get("albums", "deleted")).sort, 1);
});

test("guide manual order overrides pin fallback without touching article timestamps or publication", async t => {
  const f = await fixture(t);
  const result = await f.request("guides", "g2", { sortDirection: -1 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(await f.ordered("guides"), [["g2", 1], ["g1", 2]]);
  assert.equal((await f.source.get("guides", "g1")).isTop, true);
  assert.equal((await f.source.get("guides", "g2")).updatedAt, 2000);
});

test("pin and unpin insert existing guides within a manual order while ordinary edits retain positions", async t => {
  const f = await fixture(t, { guides: [
    { id: "g1", _id: "g1", title: "原置顶", isTop: true, updatedAt: 1000, sort: 1 },
    { id: "g2", _id: "g2", title: "普通", isTop: false, updatedAt: 2000, sort: 2 },
    { id: "g3", _id: "g3", title: "新置顶", isTop: false, updatedAt: 3000, sort: 3 },
    { id: "g4", _id: "g4", title: "末尾", isTop: false, updatedAt: 4000, sort: 4 }
  ] });
  const pinned = await f.request("guides", "g3", { isTop: true });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal(pinned.body.sort, 1);
  assert.deepEqual(await f.ordered("guides"), [["g3", 1], ["g1", 2], ["g2", 3], ["g4", 4]]);
  assert.deepEqual(new Map(pinned.body.__contentOrder.map(row => [row.id, row.sort])), new Map([["g1", 2], ["g2", 3], ["g3", 1], ["g4", 4]]));
  assert.equal((await f.source.get("guides", "g3")).updatedAt, 3000);
  assert.equal((await f.request("guides", "g3", { isTop: true, category: "更新分类" })).status, 200);
  assert.deepEqual(await f.ordered("guides"), [["g3", 1], ["g1", 2], ["g2", 3], ["g4", 4]]);
  assert.equal((await f.request("guides", "g3", { isTop: false })).status, 200);
  assert.deepEqual(await f.ordered("guides"), [["g1", 1], ["g3", 2], ["g2", 3], ["g4", 4]]);
  assert.equal((await f.request("guides", "g1", { isTop: false })).status, 200);
  assert.deepEqual(await f.ordered("guides"), [["g1", 1], ["g3", 2], ["g2", 3], ["g4", 4]]);
});

test("guide pinning preserves legacy fallback and creation does not become a pin reorder", async t => {
  const legacy = [{ id: "g1", title: "旧文章", isTop: false, updatedAt: 1000 }, { id: "g2", title: "新文章", isTop: false, updatedAt: 2000 }];
  const f = await fixture(t, { guides: legacy });
  const pinned = await f.request("guides", "g1", { isTop: true });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal((await f.source.get("guides", "g1")).sort, undefined);
  assert.equal((await f.source.get("guides", "g2")).sort, undefined);
  assert.deepEqual(order.ordered("guides", await f.source.list("guides")).map(row => row.id), ["g1", "g2"]);
  const rows = [{ id: "g1", title: "已排序", sort: 1 }, { id: "g2", title: "第二", sort: 2 }];
  const plan = order.planContentMutation("guides", rows, "new", { title: "新置顶", isTop: true }, { create: true });
  assert.equal(plan.saved.sort, 3);
  assert.deepEqual(plan.changes.map(change => [change.id, change.after.sort]), [["new", 3]]);
});

test("stale full editor saves retain the committed order and strip response/control metadata", async t => {
  const f = await fixture(t);
  const stale = await f.source.get("albums", "c");
  assert.equal((await f.request("albums", "c", { sortDirection: -1 })).status, 200);
  const edit = await f.request("albums", "c", { ...stale, name: "改名", __contentOrder: [{ id: "a", sort: 88 }] });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.sort, 2);
  assert.equal(edit.body.name, "改名");
  assert.deepEqual(await f.ordered("albums"), [["a", 1], ["c", 2], ["b", 3], ["d", 4]]);
  assert.equal((await f.source.get("albums", "c")).__contentOrder, undefined);
});

test("creation appends to an existing order; deletion compacts and restoration inserts in the retained slot", async t => {
  const f = await fixture(t);
  const created = await f.request("albums", "", photo("new", 1), "POST");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.sort, 5, "creation cannot use an editor snapshot to replace the manual order");
  assert.equal((await f.request("albums", "b", undefined, "DELETE")).status, 200);
  assert.deepEqual(await f.ordered("albums"), [["a", 1], ["c", 2], ["d", 3], ["new", 4]]);
  assert.equal((await f.source.get("albums", "b")).sort, 2);
  assert.equal((await f.request("albums", "b", { deleted: false, isDeleted: false, isShow: false })).status, 200);
  assert.deepEqual(await f.ordered("albums"), [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["new", 5]]);
});

test("invalid/mixed commands and viewer writes are rejected; boundaries and concurrent requests keep contiguous ranks", async t => {
  const f = await fixture(t);
  const before = await f.source.list("albums");
  for (const body of [{ sortDirection: 0 }, { sortDirection: "1" }, { sortDirection: -1, name: "不应写入" }]) {
    assert.equal((await f.request("albums", "c", body)).status, 400);
  }
  assert.equal((await f.request("albums", "c", { sortDirection: -1 }, "PUT", "viewer")).status, 403);
  assert.deepEqual(await f.source.list("albums"), before);
  assert.equal((await f.request("albums", "a", { sortDirection: -1 })).status, 200);
  assert.equal((await f.request("albums", "d", { sortDirection: 1 })).status, 200);
  assert.deepEqual(await f.source.list("albums"), before);
  const moved = await Promise.all([f.request("albums", "c", { sortDirection: -1 }), f.request("albums", "c", { sortDirection: -1 })]);
  assert.deepEqual(moved.map(result => result.status), [200, 200]);
  assert.deepEqual(await f.ordered("albums"), [["c", 1], ["a", 2], ["b", 3], ["d", 4]]);
});

test("a sibling persistence failure or audit failure restores the complete catalog order", async t => {
  const f = await fixture(t);
  const before = await f.source.list("albums");
  const update = f.source.update;
  let writes = 0;
  f.source.update = async (key, id, body) => {
    if (key === "albums" && ++writes === 2) throw new Error("injected rank persistence failure");
    return update(key, id, body);
  };
  const failed = await f.request("albums", "c", { sortDirection: -1 });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /已回滚/);
  assert.deepEqual(await f.source.list("albums"), before);
  f.source.update = update;
  const create = f.source.create;
  f.source.create = async (key, body) => { if (key === "logs") throw new Error("audit unavailable"); return create(key, body); };
  assert.equal((await f.request("albums", "c", { sortDirection: -1 })).status, 503);
  assert.deepEqual(await f.source.list("albums"), before);
});

test("direct moves roll back every shifted sibling on persistence or audit failure", async t => {
  const f = await fixture(t);
  const before = await f.source.list("albums");
  const update = f.source.update;
  let writes = 0;
  f.source.update = async (key, id, body) => {
    if (key === "albums" && ++writes === 2) throw new Error("injected direct-move persistence failure");
    return update(key, id, body);
  };
  assert.equal((await f.request("albums", "d", { targetPosition: 1 })).status, 503);
  assert.deepEqual(await f.source.list("albums"), before);
  f.source.update = update;
  const create = f.source.create;
  f.source.create = async (key, body) => { if (key === "logs") throw new Error("audit unavailable"); return create(key, body); };
  assert.equal((await f.request("albums", "d", { targetPosition: 1 })).status, 503);
  assert.deepEqual(await f.source.list("albums"), before);
});

test("shared video pools retain the existing public RPC and mini-program classification", () => {
  const miniProduct = require("../../../luxiaoming_交付包/miniprogram/utils/product.js");
  const rpcText = fs.readFileSync(path.resolve(__dirname, "../lib/rpc.cjs"), "utf8");
  const rpcFunction = name => rpcText.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
  const rpcVideoSingle = new Function(`${rpcFunction("isVideoProduct")}\n${rpcFunction("isVideoSingleProduct")}\nreturn isVideoSingleProduct;`)();
  const cases = [null, {}, { type: "video" }, { serviceType: "视频" }, { productType: "video" }, { isVideoSingle: true, productKind: "bundle" },
    { isVideoSingle: false, type: "video" }, { productKind: "package", type: "video" }, { type: "video", albumId: "a" },
    { type: "video", includedItems: [{ type: "album", albumId: "a" }] }, { type: "video", items: [{ productType: "peripheral" }] },
    { type: "video", items: [{ target: { page: "photo" } }] }, { type: "video", includedItems: [{ type: "mystery" }] },
    { type: "VIDEO", isVideoSingle: true }, { type: "photo", isVideoSingle: true }, { productKind: "video_single" },
    { category: "video", isVideoSingle: true }, { type: "video", productKind: "bundle", isVideoSingle: true }];
  for (const row of cases) {
    assert.equal(order.isVideoSingle(row), miniProduct.isVideoSingle(row), JSON.stringify(row));
    assert.equal(order.isVideoSingle(row), rpcVideoSingle(row), JSON.stringify(row));
  }
  assert.equal(order.group("packages", { type: "video" }), "legacyVideos");
  assert.equal(order.group("packages", { productKind: "video_single" }), "videoSingles");
  assert.equal(order.group("packages", { productKind: "package" }), "packages");
  const ties = [photo("c", 9), photo("a", 2), photo("b", 2)];
  assert.deepEqual(order.ordered("albums", ties).map(row => row.id), ["a", "b", "c"]);
});

test("responses reconcile a stale second operator even when that operator's stale sibling did not move again", async t => {
  const f = await fixture(t);
  const firstClient = await f.source.list("albums");
  const secondClient = structuredClone(firstClient);
  const reconcile = (rows, result) => {
    for (const entry of result.body.__contentOrder) Object.assign(rows.find(row => row.id === entry.id), { sort: entry.sort });
  };
  const first = await f.request("albums", "b", { sortDirection: -1 });
  assert.equal(first.status, 200);
  reconcile(firstClient, first);
  assert.deepEqual(order.ordered("albums", firstClient).map(row => row.id), ["b", "a", "c", "d"]);
  const second = await f.request("albums", "c", { sortDirection: -1 });
  assert.equal(second.status, 200);
  assert.ok(second.body.__contentOrder.some(row => row.id === "b" && row.sort === 1), "the first client's earlier move is included despite no write to b in this command");
  reconcile(secondClient, second);
  assert.deepEqual(order.ordered("albums", secondClient).map(row => [row.id, row.sort]), [["b", 1], ["c", 2], ["a", 3], ["d", 4]]);
  assert.deepEqual(await f.ordered("albums"), order.ordered("albums", secondClient).map(row => [row.id, row.sort]));
});

function mysqlFixture() {
  let documents = [{ id: "g1", sort: 1, title: "第一", customNote: "保留", updatedAt: 1000 }, { id: "g2", sort: 2, title: "第二", updatedAt: 2000 }];
  let snapshot;
  let active = false;
  let writes = 0;
  let failAt = 0;
  const events = [];
  const columns = new Map(schema.ALL_KEYS.map(key => [schema.tableName(key), schema.definition(key).columns.map(column => column.name)]));
  const conn = {
    async beginTransaction() { assert.equal(active, false); active = true; snapshot = structuredClone(documents); events.push("begin"); },
    async commit() { active = false; events.push("commit"); },
    async rollback() { documents = snapshot; active = false; events.push("rollback"); },
    release() {},
    async query(sql, params = []) {
      if (sql.includes("information_schema.columns")) return [sql.includes("table_name IN") ? params.flatMap(table_name => (columns.get(String(table_name)) || []).map(column_name => ({ table_name, column_name }))) : (columns.get(String(params[0])) || []).map(column_name => ({ column_name }))];
      assert.equal(active, true, "rank reads and writes must share the transaction connection");
      if (sql.includes("SELECT * FROM `lxm_guides` ORDER BY id FOR UPDATE")) {
        events.push("lock");
        return [documents.map(row => ({ id: row.id, ...schema.splitDocument("guides", row).columns }))];
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM `lxm_collection_values`")) {
        return [documents.filter(row => params.slice(1).includes(row.id)).flatMap(row => schema.splitDocument("guides", row).attributes.map(attribute => ({ ...attribute, collection_name: "guides", record_id: row.id })))];
      }
      if (sql.startsWith("INSERT INTO `lxm_guides`")) {
        if (++writes === failAt) throw new Error("injected SQL rank failure");
        const names = sql.match(/^INSERT INTO `lxm_guides` \(([^)]+)\)/)[1].split(",").map(name => name.trim().replaceAll("`", ""));
        const row = Object.fromEntries(names.map((name, index) => [name, params[index]]));
        Object.assign(documents.find(item => item.id === row.id), row);
        events.push("write:" + row.id);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("DELETE FROM `lxm_collection_values`")) {
        const index = documents.findIndex(row => row.id === params[1]);
        documents[index] = { id: documents[index].id, ...schema.splitDocument("guides", documents[index]).columns };
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO `lxm_collection_values`")) {
        const names = sql.match(/^INSERT INTO `lxm_collection_values` \(([^)]+)\)/)[1].split(",").map(name => name.trim().replaceAll("`", ""));
        const attribute = Object.fromEntries(names.map((name, index) => [name, params[index]]));
        const index = documents.findIndex(row => row.id === attribute.record_id);
        const split = schema.splitDocument("guides", documents[index]);
        documents[index] = schema.hydrateDocument("guides", { id: documents[index].id, ...split.columns }, { collection_values: [...split.attributes, attribute] });
        return [{ affectedRows: 1 }];
      }
      throw new Error("Unexpected content order SQL: " + sql);
    }
  };
  const pool = { async getConnection() { return conn; }, async query() { throw new Error("No runtime pool reads outside transaction"); } };
  return { source: createMysqlSource({ pool, autoMigrate: false, logger: { warn() {}, error() {} } }), events,
    rows: () => structuredClone(documents), failAt: value => { failAt = value; } };
}

test("MySQL locks the latest complete collection and commits all shifted ranks atomically", async t => {
  const f = mysqlFixture();
  t.after(() => f.source.close());
  const result = await f.source.applyContentMutation("guides", "g2", {}, { direction: -1 });
  assert.equal(result.saved.sort, 1);
  assert.deepEqual(order.ordered("guides", f.rows()).map(row => row.id), ["g2", "g1"]);
  assert.deepEqual(f.events, ["begin", "lock", "write:g1", "write:g2", "commit"]);
  assert.equal(f.rows().find(row => row.id === "g1").customNote, "保留");
  assert.equal(f.rows().find(row => row.id === "g2").updatedAt, 2000);
});

test("MySQL rolls back the entire order when a later sibling write fails", async t => {
  const f = mysqlFixture();
  t.after(() => f.source.close());
  const before = f.rows();
  f.failAt(2);
  await assert.rejects(f.source.applyContentMutation("guides", "g2", {}, { direction: -1 }), /injected SQL rank failure/);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.events.includes("rollback"), true);
  assert.equal(f.events.includes("commit"), false);
});

test("MySQL direct moves validate against locked rows and preserve atomic commits and rollback", async t => {
  await t.test("direct insertion commits all ranks in the existing transaction", async t => {
    const f = mysqlFixture();
    t.after(() => f.source.close());
    const result = await f.source.applyContentMutation("guides", "g2", {}, { targetPosition: 1 });
    assert.equal(result.saved.sort, 1);
    assert.deepEqual(order.ordered("guides", f.rows()).map(row => row.id), ["g2", "g1"]);
    assert.deepEqual(f.events, ["begin", "lock", "write:g1", "write:g2", "commit"]);
    assert.equal(f.rows().find(row => row.id === "g1").customNote, "保留");
    assert.equal(f.rows().find(row => row.id === "g2").updatedAt, 2000);
  });
  await t.test("an out-of-range target is rejected before any write", async t => {
    const f = mysqlFixture();
    t.after(() => f.source.close());
    const before = f.rows();
    await assert.rejects(f.source.applyContentMutation("guides", "g2", {}, { targetPosition: 3 }), { code: "CONTENT_ORDER_INVALID", statusCode: 400 });
    assert.deepEqual(f.rows(), before);
    assert.deepEqual(f.events, ["begin", "lock", "rollback"]);
  });
  await t.test("a later write failure rolls back every rank", async t => {
    const f = mysqlFixture();
    t.after(() => f.source.close());
    const before = f.rows();
    f.failAt(2);
    await assert.rejects(f.source.applyContentMutation("guides", "g2", {}, { targetPosition: 1 }), /injected SQL rank failure/);
    assert.deepEqual(f.rows(), before);
    assert.equal(f.events.includes("rollback"), true);
    assert.equal(f.events.includes("commit"), false);
  });
});
