"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const createSource = require("./fixtures/jsonSource.cjs");

function spot(id, sort, extra = {}) {
  return { id, _id: id, name: id.toUpperCase(), cityId: "city-a", sort, status: "启用", isShow: true,
    address: "测试地址", intro: "测试点位介绍", tag: "推荐", tags: ["风景"], cover: "https://test.invalid/spot.jpg", ...extra };
}

async function fixture(t, spots = [spot("a", 1), spot("b", 2), spot("c", 3), spot("d", 4), spot("e", 5)]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-spot-order-"));
  const file = path.join(dir, "db.json");
  const collections = {
    staff: { admin: { id: "admin", role: "super", status: "启用" }, editor: { id: "editor", role: "content", status: "启用" }, viewer: { id: "viewer", role: "service", status: "启用" } },
    cities: { "city-a": { id: "city-a", name: "甲城", status: "启用" }, "city-b": { id: "city-b", name: "乙城", status: "启用" } },
    spots: Object.fromEntries(spots.map(row => [row.id, row])),
    series: {}, albums: {}, packages: {}, peripherals: {}, guides: {}, tagLibrary: {}, trash: {}, logs: {}
  };
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
    assert.ok(path.resolve(dir).startsWith(path.resolve(path.join(os.tmpdir(), "lxm-spot-order-"))), "cleanup stays inside the named test fixture");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function request(id, body, { method = "PUT", token = "admin" } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/collection/spots${id ? `/${id}` : ""}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  const snapshot = async () => (await source.list("spots")).sort((a, b) => a.id.localeCompare(b.id));
  const ranked = async () => (await source.list("spots")).filter(row => !row.deleted && !row.isDeleted && row.sort > 0)
    .sort((a, b) => a.sort - b.sort).map(row => [row.id, row.sort]);
  return { source, request, snapshot, ranked, file };
}

test("moving fifth to third inserts it and moves every following point, including a later downward move", async t => {
  const f = await fixture(t);
  assert.equal(typeof f.source.applySpotMutation, "function", "use the adapter's atomic point mutation");
  const moved = await f.request("e", { sort: 3 }, { token: "editor" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await f.ranked(), [["a", 1], ["b", 2], ["e", 3], ["c", 4], ["d", 5]]);
  assert.deepEqual(new Map(moved.body.__spotOrder.map(row => [row.id, row.sort])), new Map([["e", 3], ["c", 4], ["d", 5]]));
  const down = await f.request("b", { sort: 4 });
  assert.equal(down.status, 200);
  assert.deepEqual(await f.ranked(), [["a", 1], ["e", 2], ["c", 3], ["b", 4], ["d", 5]]);
});

test("an explicit same-value rank request inserts ahead of a legacy tied point", async t => {
  const f = await fixture(t, [spot("a", 1), spot("b", 1), spot("c", 9)]);
  const moved = await f.request("b", { sort: 1 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await f.ranked(), [["b", 1], ["a", 2], ["c", 3]]);
});

test("ranked creation inserts, an excessive target appends, and clearing a rank compacts its siblings", async t => {
  const f = await fixture(t);
  const created = await f.request("", spot("new", 2), { method: "POST" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(await f.ranked(), [["a", 1], ["new", 2], ["b", 3], ["c", 4], ["d", 5], ["e", 6]]);
  const appended = await f.request("new", { sort: 2147483647 });
  assert.equal(appended.status, 200);
  assert.equal(appended.body.sort, 6);
  const cleared = await f.request("c", { sort: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.sort, 0);
  assert.deepEqual(await f.ranked(), [["a", 1], ["b", 2], ["d", 3], ["e", 4], ["new", 5]]);
});

test("insertion resolves legacy gaps and tied ranks in stable order while leaving unranked and deleted points alone", async t => {
  const f = await fixture(t, [spot("a", 1), spot("b", 3, { hotScore: 1 }), spot("c", 3, { hotScore: 9 }),
    spot("d", 8), spot("e", 0), spot("unranked", 0), spot("deleted", 2, { deleted: true, isDeleted: true })]);
  const moved = await f.request("e", { sort: 2 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await f.ranked(), [["a", 1], ["e", 2], ["c", 3], ["b", 4], ["d", 5]]);
  assert.equal((await f.source.get("spots", "unranked")).sort, 0);
  assert.equal((await f.source.get("spots", "deleted")).sort, 2);
});

test("rank changes are global across cities and include hidden points; ordinary edits do not normalize legacy ties", async t => {
  const f = await fixture(t, [spot("a", 1), spot("b", 2, { cityId: "city-b", isShow: false, status: "停用" }),
    spot("c", 2), spot("d", 7), spot("e", 8, { cityId: "city-b" })]);
  const saved = await f.request("c", { sort: 2, intro: "修改介绍", __spotOrder: [{ id: "b", sort: 900 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual((await f.snapshot()).map(row => [row.id, row.sort]), [["a", 1], ["b", 2], ["c", 2], ["d", 7], ["e", 8]]);
  assert.equal((await f.source.get("spots", "c")).__spotOrder, undefined, "response metadata cannot be written back");
  assert.equal((await f.request("e", { sort: 1 })).status, 200);
  const ranked = await f.ranked();
  assert.deepEqual(ranked.map(([, sort]) => sort), [1, 2, 3, 4, 5]);
  assert.equal(ranked[0][0], "e");
  assert.ok(ranked.find(row => row[0] === "b"), "hidden points retain their position in the same global order");
});

test("deleting compacts ranks and restoring inserts at the retained rank", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("c", { isShow: false, status: "停用" })).status, 200);
  const deleted = await f.request("c", undefined, { method: "DELETE" });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await f.source.get("spots", "c")).sort, 3, "retain deleted point's slot as the restore target");
  assert.deepEqual(await f.ranked(), [["a", 1], ["b", 2], ["d", 3], ["e", 4]]);
  const restored = await f.request("c", { deleted: false, isDeleted: false, isShow: false });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(await f.ranked(), [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]);
});

test("an audit failure restores the entire previous order after an atomic adapter write", async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const originalCreate = f.source.create;
  f.source.create = async (key, value) => {
    if (key === "logs") throw new Error("audit unavailable");
    return originalCreate(key, value);
  };
  const failed = await f.request("e", { sort: 1, intro: "不应留下的介绍" });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /已回滚/);
  assert.deepEqual(await f.snapshot(), before);
  const restarted = createSource({ backend: "json", jsonFile: f.file });
  assert.deepEqual((await restarted.list("spots")).sort((a, b) => a.id.localeCompare(b.id)), before, "rollback is persisted");
  await restarted.close();
});

test("fallback adapters roll back a partial sibling failure and never acknowledge a partial order", async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  f.source.applySpotMutation = undefined;
  const originalUpdate = f.source.update;
  let spotWrites = 0;
  f.source.update = async (key, id, patch) => {
    if (key === "spots" && ++spotWrites === 2) throw new Error("second point write failed");
    return originalUpdate(key, id, patch);
  };
  const failed = await f.request("e", { sort: 1 });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /已回滚/);
  assert.ok(spotWrites >= 2);
  assert.deepEqual(await f.snapshot(), before);
});

test("rank edits require content permission and concurrent insertions keep a single consecutive sequence", async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  assert.equal((await f.request("e", { sort: 1 }, { token: "viewer" })).status, 403);
  assert.deepEqual(await f.snapshot(), before);
  const results = await Promise.all(["x", "y", "z"].map(id => f.request("", spot(id, 1), { method: "POST", token: "editor" })));
  assert.deepEqual(results.map(result => result.status), [201, 201, 201], JSON.stringify(results));
  const ranked = await f.ranked();
  assert.deepEqual(ranked.map(([, sort]) => sort), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(new Set(ranked.slice(0, 3).map(([id]) => id)), new Set(["x", "y", "z"]));
  assert.deepEqual(ranked.slice(3).map(([id]) => id), ["a", "b", "c", "d", "e"]);
});
