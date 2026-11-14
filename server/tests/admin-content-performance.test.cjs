"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const createApi = require("../lib/api.cjs");

const CONTENT_KEYS = new Set(["guides", "spots", "series", "albums", "packages", "peripherals"]);

async function fixture(t) {
  const rows = {
    staff: [
      { id: "editor", account: "editor", role: "content", status: "启用" },
      { id: "service", account: "service", role: "service", status: "启用" }
    ],
    spots: [{ id: "a", name: "江边", isShow: true }, { id: "b", name: "旧街", isShow: false }],
    series: [{ id: "style", name: "江景", spotIds: ["a"] }],
    albums: [{ id: "photo", name: "江边留影", seriesId: "style", isShow: true }],
    packages: [
      { id: "video", name: "旧街视频", productKind: "video_single", type: "video", spotId: "b", isShow: true },
      { id: "bundle", name: "两地点套餐", isShow: true, includedItems: [{ type: "album", albumId: "photo" }, { type: "video", productId: "video" }] },
      { id: "with-peripheral", name: "带相框套餐", isShow: true, includedItems: [{ type: "album", albumId: "photo" }, { type: "peripheral", peripheralId: "frame" }] }
    ],
    peripherals: [{ id: "frame", name: "相框", isShow: false }],
    guides: [
      { id: "rich", title: "多点位灵感", status: "已发布", isShow: true, spotIds: ["a", "b"], contentHtml: "<p>完整正文</p>", mediaItems: [{ type: "image", url: "https://test.invalid/guide.jpg" }] },
      { id: "legacy", title: "旧版多点位", status: "已发布", isShow: true, spotIds: ["a", "b"], content: "旧版正文" },
      { id: "inherited", title: "旧版系列关联", status: "已发布", isShow: true, seriesId: "style", content: "继承系列点位" }
    ]
  };
  const reads = [];
  let readHook = null;
  const source = {
    async list(key) {
      reads.push({ method: "list", key });
      const snapshot = structuredClone(rows[key] || []);
      if (readHook) await readHook(key);
      return snapshot;
    },
    async get(key, id) {
      reads.push({ method: "get", key, id });
      return structuredClone((rows[key] || []).find((row) => String(row.id) === String(id)) || null);
    }
  };
  const auth = {
    async init() {},
    async getSession(token) {
      return ["editor", "service"].includes(token)
        ? { kind: "admin", role: token === "editor" ? "content" : "service", subjectId: token, account: token }
        : null;
    }
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const handler = createApi(source, "json", { auth, logger });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (route, token = "editor") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { status: response.status, body: await response.json() };
  };
  return { rows, reads, request, setReadHook(hook) { readHook = hook; } };
}

function assertContentReads(reads, expected) {
  const actual = reads.filter((read) => CONTENT_KEYS.has(read.key)).map((read) => `${read.method}:${read.key}`);
  assert.deepEqual(actual.sort(), expected.slice().sort());
}

test("guide menu shares each content collection read and preserves package and article projections", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.rows);
  const result = await f.request("/api/modules/content?keys=guides,spots,series,albums,packages");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertContentReads(f.reads, ["list:guides", "list:spots", "list:series", "list:albums", "list:packages", "list:peripherals"]);
  const collections = result.body.collections;
  assert.deepEqual(Object.keys(collections).sort(), ["guides", "spots", "series", "albums", "packages"].sort());
  assert.equal(collections.guides.find((row) => row.id === "rich").effectiveVisible, true);
  assert.equal(collections.guides.find((row) => row.id === "legacy").effectiveVisible, false);
  assert.equal(collections.guides.find((row) => row.id === "inherited").effectiveVisible, true);
  const bundle = collections.packages.find((row) => row.id === "bundle");
  assert.deepEqual(bundle.effectiveSpotIds, ["a", "b"]);
  assert.equal(bundle.effectiveVisible, false);
  assert.ok(bundle.visibilityReasons.some((reason) => reason.includes("旧街视频")));
  const peripheralBundle = collections.packages.find((row) => row.id === "with-peripheral");
  assert.deepEqual(peripheralBundle.effectiveSpotIds, ["a"]);
  assert.equal(peripheralBundle.effectiveVisible, false);
  assert.ok(peripheralBundle.visibilityReasons.some((reason) => reason.includes("相框")));
  assert.deepEqual(f.rows, before, "admin projections cannot mutate stored documents");
});

test("guide-only module avoids product catalogues regardless of article count", async (t) => {
  const f = await fixture(t);
  f.rows.guides.push(...Array.from({ length: 100 }, (_, index) => ({
    id: `bulk-${index}`, title: `灵感 ${index}`, status: "已发布", spotId: "a", contentHtml: `<p>正文 ${index}</p>`
  })));
  const result = await f.request("/api/modules/content?keys=guides");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.collections.guides.length, 103);
  assertContentReads(f.reads, ["list:guides", "list:spots", "list:series"]);
  assert.equal(result.body.collections.guides.find((row) => row.id === "inherited").effectiveVisible, true);
});

test("legacy collection list and detail only load guide visibility dependencies", async (t) => {
  const f = await fixture(t);
  const list = await f.request("/api/collection/guides");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assertContentReads(f.reads, ["list:guides", "list:spots", "list:series"]);
  f.reads.length = 0;
  const detail = await f.request("/api/collection/guides/rich");
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.contentHtml, "<p>完整正文</p>");
  assert.deepEqual(detail.body.mediaItems, [{ type: "image", url: "https://test.invalid/guide.jpg" }]);
  assert.equal(detail.body.effectiveVisible, true);
  assertContentReads(f.reads, ["get:guides", "list:spots", "list:series"]);
});

test("spot-only reads do not scan guides or product catalogues", async (t) => {
  const f = await fixture(t);
  const result = await f.request("/api/modules/content?keys=spots");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertContentReads(f.reads, ["list:spots"]);
  assert.equal(result.body.collections.spots.find((row) => row.id === "a").effectiveVisible, true);
  assert.equal(result.body.collections.spots.find((row) => row.id === "b").effectiveVisible, false);
  f.reads.length = 0;
  const detail = await f.request("/api/collection/spots/a");
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assertContentReads(f.reads, ["get:spots"]);
});

test("unauthenticated and denied guide reads do not query content data", async (t) => {
  const f = await fixture(t);
  const unauthenticated = await f.request("/api/modules/content?keys=guides", "invalid");
  assert.equal(unauthenticated.status, 401);
  assertContentReads(f.reads, []);
  const denied = await f.request("/api/modules/content?keys=guides", "service");
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  assert.deepEqual(denied.body.collections, {});
  assert.deepEqual(denied.body.skippedKeys, ["guides"]);
  assertContentReads(f.reads, []);
  const deniedCollection = await f.request("/api/collection/guides", "service");
  assert.equal(deniedCollection.status, 403);
  assertContentReads(f.reads, []);
});

test("later requests read current article and point visibility without reusing a response cache", async (t) => {
  const f = await fixture(t);
  const first = await f.request("/api/modules/content?keys=guides");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.collections.guides.find((row) => row.id === "rich").effectiveVisible, true);
  f.rows.spots[0].isShow = false;
  f.rows.guides[0].title = "更新后的标题";
  f.reads.length = 0;
  const second = await f.request("/api/modules/content?keys=guides");
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const changed = second.body.collections.guides.find((row) => row.id === "rich");
  assert.equal(changed.title, "更新后的标题");
  assert.equal(changed.effectiveVisible, false);
  assertContentReads(f.reads, ["list:guides", "list:spots", "list:series"]);
  assert.equal(first.body.collections.guides.find((row) => row.id === "rich").title, "多点位灵感");
});

test("concurrent admin requests keep independent in-flight visibility reads", async (t) => {
  const f = await fixture(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let spotReads = 0;
  f.setReadHook(async (key) => {
    if (key === "spots" && ++spotReads === 1) { notifyStarted(); await held; }
  });
  const firstPending = f.request("/api/modules/content?keys=guides");
  await started;
  try {
    f.rows.spots[0].isShow = false;
    const second = await f.request("/api/modules/content?keys=guides");
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.collections.guides.find((row) => row.id === "rich").effectiveVisible, false);
  } finally { release(); }
  const first = await firstPending;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.collections.guides.find((row) => row.id === "rich").effectiveVisible, true);
  assert.equal(spotReads, 2, "each HTTP request owns its own pending read");
});
