"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const { listContentPhotographers } = require("../lib/contentPhotographers.cjs");

async function fixture(t) {
  const profiles = Array.from({ length: 121 }, (_, i) => ({ id: `PH${20260001 + i}`, name: `摄影师${i}`, status: i % 2 ? "paused" : "ended", phone: "13800138000", rates: { photo: 9999 } }));
  const rows = {
    staff: [
      ...["super", "content", "service", "finance"].map(role => ({ id: role, role, account: role, status: "active" })),
      { id: "legacy-photo", name: "老摄影师", role: "photographer", status: "disabled", phone: "13800138000" },
      { id: "deleted-photo", name: "已删除摄影师", role: "photo", deleted: true },
      { id: profiles[0].id, name: "过期姓名", role: "photo" },
      { id: "not-photo", name: "其他人员", role: "service" }
    ],
    albums: [], packages: [], spots: [], series: [], peripherals: [], guides: [], tagLibrary: [], logs: []
  };
  let failure;
  const queries = [];
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find(row => row.id === id) || null); },
    async create(key, body) { const row = structuredClone(body); (rows[key] ||= []).push(row); return structuredClone(row); },
    async update(key, id, patch) { const row = (rows[key] || []).find(row => row.id === id); if (!row) return null; Object.assign(row, structuredClone(patch)); return structuredClone(row); },
    async remove(key, id) { const index = (rows[key] || []).findIndex(row => row.id === id); if (index < 0) return false; rows[key].splice(index, 1); return true; },
    async transaction(callback) { return callback({ async query(sql) { queries.push(sql); if (failure) throw failure; assert.equal(sql, "SELECT id,name FROM photo_profile ORDER BY id"); return [structuredClone(profiles)]; } }); }
  };
  let grant = "albums", grantedRole = "operator";
  const permissionStore = {
    required: true, async init() {},
    async getUser(id) { return { id, account: "operator", status: "active", roleId: "operator-role" }; },
    async getPolicyForUser() { return { role: { id: "operator-role", roleKey: grantedRole, status: "active" }, menuKeys: grant ? ["custom-product-menu"] : [], menuRows: grant ? [{ menuKey: "custom-product-menu", name: "商品", status: "active", meta: { routeKey: grant } }] : [] }; }
  };
  const auth = { async init() {}, async getSession(token) {
    if (token === "operator") return { kind: "admin", authzUserId: "operator", subjectId: "operator" };
    if (token === "public") return { kind: "public", openid: "tourist" };
    const staff = rows.staff.find(row => row.id === token);
    return staff ? { kind: "admin", role: staff.role, subjectId: staff.id, account: staff.account } : null;
  } };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const handler = createApi(source, "json", { auth, permissionStore, logger });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(path = "/api/content/photographers", token = "content", body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { source, rows, profiles, queries, request, setGrant(value) { grant = value; }, setRole(value) { grantedRole = value; }, setFailure(value) { failure = value; } };
}

test("product selectors return all photographer names, including non-active and legacy profiles, without private fields", async t => {
  const f = await fixture(t);
  const result = await f.request();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.rows.length, 122, "the catalogue must not stop at the commission list page size");
  assert.deepEqual(result.body.rows.find(row => row.id === f.profiles[0].id), { id: f.profiles[0].id, name: f.profiles[0].name });
  assert.deepEqual(result.body.rows.find(row => row.id === "legacy-photo"), { id: "legacy-photo", name: "老摄影师" });
  assert.ok(result.body.rows.every(row => Object.keys(row).sort().join(",") === "id,name"));
  assert.doesNotMatch(JSON.stringify(result.body), /13800138000|rates|deleted-photo|not-photo/);
});

test("photographer choices follow product menu grants without opening commission or staff permissions", async t => {
  const f = await fixture(t);
  for (const token of [null, "unknown", "public"]) assert.equal((await f.request(undefined, token)).status, 401);
  for (const token of ["service", "finance"]) assert.equal((await f.request(undefined, token)).status, 403);
  assert.deepEqual(f.queries, [], "unauthorized requests must not query photographer profiles");
  for (const grant of ["albums", "packages", "videoSingles"]) {
    f.setGrant(grant);
    assert.equal((await f.request(undefined, "operator")).status, 200, grant);
  }
  for (const grant of ["spots", "photoParty", "staff", ""]) {
    f.setGrant(grant);
    assert.equal((await f.request(undefined, "operator")).status, 403, grant);
  }
  f.setGrant("albums"); f.setRole("finance");
  assert.equal((await f.request(undefined, "operator")).status, 200, "a granted product list can resolve names without content-edit capability");
  f.setRole("distributor");
  assert.equal((await f.request(undefined, "operator")).status, 403, "external identities cannot acquire the directory through a product menu");
  assert.equal((await f.request(undefined, "super")).status, 200);
  assert.equal((await f.request(undefined, "content", {}, "POST")).status, 405);
});

test("photographer directory failures stay unavailable instead of returning incomplete legacy choices", async t => {
  const f = await fixture(t);
  f.setFailure(new Error("SQL unavailable PRIVATE"));
  const result = await f.request();
  assert.equal(result.status, 503);
  assert.match(result.body.error, /暂不可用/);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE|legacy-photo/);
});

test("all three product types create, update, list, and clear a recommended photographer while rejecting fabricated identities", async t => {
  const f = await fixture(t), id = f.profiles[0].id;
  const products = [
    ["albums", { name: "照片留影", cover: "https://test.invalid/photo.jpg", shootingNotes: "拍摄说明", photoCount: 3, retouchCount: 0, price: 10 }],
    ["packages", { name: "视频摄像", type: "video", productKind: "video_single", videoUrl: "https://test.invalid/video.mp4", shootingNotes: "拍摄说明", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "3天", price: 10 }],
    ["packages", { name: "旅拍套餐", type: "photo", productKind: "package", price: 10 }]
  ];
  for (const [index, [key, product]] of products.entries()) {
    const productId = `product-${index}`, collection = `/api/collection/${key}`, item = `${collection}/${productId}`;
    const created = await f.request(collection, "content", { ...product, id: productId, tags: ["推荐"], isShow: false, recommendedPhotographerId: ` ${id} `, recommendedPhotographerName: "伪造姓名" });
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal(created.body.recommendedPhotographerId, id);
    assert.equal(created.body.recommendedPhotographerName, undefined);
    assert.equal((await f.request(item, "content", { name: `${product.name}更新` }, "PUT")).body.recommendedPhotographerId, id);
    assert.equal((await f.request(collection)).body.find(row => row.id === productId).recommendedPhotographerId, id);
    for (const value of ["not-photo", "deleted-photo", "missing", [id], { id }, true, 123, "x".repeat(129)]) {
      const invalid = await f.request(item, "content", { recommendedPhotographerId: value }, "PUT");
      assert.equal(invalid.status, 400, JSON.stringify(invalid));
      assert.equal((await f.source.get(key, productId)).recommendedPhotographerId, id);
    }
    const changed = await f.request(item, "content", { recommendedPhotographerId: "legacy-photo" }, "PUT");
    assert.equal(changed.status, 200, JSON.stringify(changed));
    assert.equal(changed.body.recommendedPhotographerId, "legacy-photo");
    const cleared = await f.request(item, "content", { recommendedPhotographerId: "" }, "PUT");
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    assert.equal(cleared.body.recommendedPhotographerId, "");
  }
});

test("recommended photographer IDs round-trip through typed SQL storage without a schema migration", () => {
  for (const [key, type] of [["albums", "album"], ["packages", "video"], ["packages", "photo"]]) {
    for (const recommendedPhotographerId of ["PH20260001", ""]) {
      const input = { id: "product", type, recommendedPhotographerId };
      const split = schema.splitDocument(key, input);
      assert.ok(split.attributes.some(row => row.path === "recommendedPhotographerId" && row.value_type === "string"));
      const restored = schema.hydrateDocument(key, { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
      assert.equal(restored.recommendedPhotographerId, recommendedPhotographerId);
    }
  }
});

test("legacy-only sources preserve their photographer catalogue", async () => {
  assert.deepEqual(await listContentPhotographers({ async list() { return [{ id: "legacy", role: "photo", name: "摄影师" }]; } }), [{ id: "legacy", name: "摄影师" }]);
});
