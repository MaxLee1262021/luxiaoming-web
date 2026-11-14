"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const createApi = require("../lib/api.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const { prepareGuideForSave, sanitizeGuideHtml, guideMedia, sortGuides } = require("../lib/guideContent.cjs");
const { pointDeletionPlan } = require("../lib/contentPolicy.cjs");

async function fixture(t) {
  const rows = {
    staff: [{ id: "editor", account: "editor", role: "content", status: "启用" }],
    cities: [{ id: "city", name: "长沙", enabled: true }],
    spots: [{ id: "spot", cityId: "city", name: "橘子洲", cover: "https://test.invalid/spot.jpg" }, { id: "other", cityId: "city" }],
    series: [{ id: "style", spotIds: ["spot"] }],
    albums: [{ id: "photo", name: "江边留影", seriesId: "style", status: "上架" }],
    packages: [
      { id: "package", name: "日落套餐", spotIds: ["spot", "other"], status: "上架" },
      { id: "video", name: "江边短片", spotId: "spot", type: "video", isVideoSingle: true, status: "上架" },
      { id: "wrong", name: "别处拍摄", spotId: "other", status: "上架" }
    ],
    guides: [], logs: []
  };
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find((item) => String(item.id) === String(id)) || null); },
    async create(key, body) { const row = structuredClone({ ...body, id: body.id || `${key}-${Date.now()}` }); (rows[key] ||= []).push(row); return structuredClone(row); },
    async update(key, id, body) { const row = (rows[key] || []).find((item) => item.id === id); if (!row) return null; Object.assign(row, structuredClone(body)); return structuredClone(row); }
  };
  const auth = { async init() {}, async getSession(token) { return token === "editor" ? { kind: "admin", role: "content", subjectId: "editor", account: "editor" } : null; } };
  const handler = createApi(source, "json", { auth });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  async function request(route, body, method = "POST", admin = true) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "Bearer editor" } : {}) }, body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  }
  return { rows, source, request };
}

const guide = (extra = {}) => ({
  id: "guide", title: "日落时分这样拍", status: "启用", content: "机位在江边\n建议日落前半小时到达", cover: "https://test.invalid/cover.jpg", spotId: "spot",
  mediaType: "image", mediaItems: [{ url: "https://test.invalid/image", type: "image" }],
  targetProductType: "album", targetProductId: "photo", ...extra
});

function miniPage(rawGuide) {
  const miniRoot = path.resolve(__dirname, "../../../luxiaoming_交付包/miniprogram");
  const apiModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(miniRoot, "api/guide.js"), "utf8"), {
    module: apiModule,
    require(name) {
      if (name === "../utils/demoData") return {};
      if (name === "../api/client" || name === "./client") return { callCloud: async () => ({ success: true, data: rawGuide }) };
      if (name === "../config/env") return { isExplicitDemoMode: () => false };
      if (name === "../utils/guideContent") return require(path.join(miniRoot, "utils/guideContent.js"));
      throw new Error(name);
    }
  });
  let page;
  let navigation;
  let preview;
  vm.runInNewContext(fs.readFileSync(path.join(miniRoot, "pages/guideDetail/guideDetail.js"), "utf8"), {
    getApp: () => ({ captureSource: () => ({ shopId: "shop-a", scene: "渠道来源" }) }),
    Page: (config) => { page = config; }, console,
    wx: { navigateTo: (value) => { navigation = value; }, previewImage: (value) => { preview = value; } },
    require(name) {
      if (name === "../../api/guide") return apiModule.exports;
      if (name === "../../utils/query") return require(path.join(miniRoot, "utils/query.js"));
      if (name === "../../utils/guideContent") return require(path.join(miniRoot, "utils/guideContent.js"));
      if (name === "../../utils/product") return require(path.join(miniRoot, "utils/product.js"));
      if (name === "../../service/guideAttachments") return require(path.join(miniRoot, "service/guideAttachments.js"));
      throw new Error(name);
    }
  });
  page.data = structuredClone(page.data);
  page.setData = (patch) => Object.assign(page.data, patch);
  return { page, navigation: () => navigation, preview: () => preview };
}

test("admin publishes point-linked guides; mini-program opens each selected product and retains source", async (t) => {
  const f = await fixture(t);
  for (const [type, id, pagePath, queryKey] of [
    ["album", "photo", "photoCollection", "albumId"],
    ["package", "package", "photoPackageDetail", "packageId"],
    ["video", "video", "videoProductDetail", "productId"]
  ]) {
    const input = guide({ id: `guide-${type}`, targetProductType: type, targetProductId: id });
    const saved = await f.request("/api/collection/guides", input);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const detail = await f.request("/api/rpc/getGuide", { id: input.id }, "POST", false);
    assert.equal(detail.body.success, true);
    assert.equal(detail.body.data.bookingProduct.id, id);
    assert.equal(detail.body.data.spotName, "橘子洲");
    assert.equal(detail.body.data.spotCover, "https://test.invalid/spot.jpg");
    const mini = miniPage(detail.body.data);
    mini.page.setData({ id: input.id, shopId: "shop-a", scene: "渠道来源" });
    await mini.page.loadDetail();
    mini.page.goBookingProduct();
    const url = new URL(mini.navigation().url, "https://mini.invalid");
    assert.equal(url.pathname, `/pages/${pagePath}/${pagePath}`);
    assert.equal(url.searchParams.get(queryKey), id);
    assert.equal(url.searchParams.get("spotId"), "spot");
    assert.equal(url.searchParams.get("shopId"), "shop-a");
    assert.equal(url.searchParams.get("scene"), "渠道来源");
    mini.page.previewImage({ currentTarget: { dataset: { url: input.mediaItems[0].url } } });
    assert.equal(mini.preview().current, input.mediaItems[0].url);
  }
  const list = await f.request("/api/rpc/listGuides", { spotId: "other" }, "POST", false);
  assert.equal(list.body.data.length, 0);
});

test("server rejects cross-point and mismatched target types and revalidates point changes on PUT", async (t) => {
  const f = await fixture(t);
  for (const input of [guide({ targetProductType: "package", targetProductId: "wrong" }), guide({ targetProductType: "video", targetProductId: "package" })]) {
    const res = await f.request("/api/collection/guides", input);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /打卡点|商品/);
  }
  assert.equal((await f.request("/api/collection/guides", guide())).status, 201);
  assert.equal((await f.request("/api/collection/guides/guide", { spotId: "other" }, "PUT")).status, 400);
  assert.equal((await f.source.get("guides", "guide")).spotId, "spot");
  const clear = await f.request("/api/collection/guides/guide", { targetProductId: "", targetProductType: "" }, "PUT");
  assert.equal(clear.status, 200, JSON.stringify(clear.body));
  const detail = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
  assert.equal(detail.body.data.bookingProduct, null);
});

test("unavailable products hide booking; unpublished guides stay private", async (t) => {
  const f = await fixture(t);
  await f.request("/api/collection/guides", guide());
  for (const patch of [{ status: "下架" }, { deleted: true }, { isSellable: false }, { spotId: "other", seriesId: "" }]) {
    f.rows.albums[0] = { id: "photo", name: "留影", spotId: "spot", status: "上架", ...patch };
    const res = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.bookingProduct, null);
  }
  await f.request("/api/collection/guides/guide", { status: "草稿", targetProductId: "", targetProductType: "" }, "PUT");
  assert.equal((await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false)).body.success, false);
});

test("extensionless uploaded video keeps its type through SQL roundtrip, RPC and mini-program", async (t) => {
  const f = await fixture(t);
  const input = guide({ mediaType: "video", mediaItems: [{ url: "https://test.invalid/media/file_123", type: "video" }] });
  const prepared = await prepareGuideForSave(f.source, input);
  assert.equal(prepared.error, undefined);
  const split = schema.splitDocument("guides", prepared.guide);
  const hydrated = schema.hydrateDocument("guides", { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  assert.equal(hydrated.targetProductId, "photo");
  assert.equal(hydrated.mediaItems[0].type, "video");
  f.rows.guides.push(hydrated);
  const detail = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
  const mini = miniPage(detail.body.data);
  mini.page.setData({ id: "guide" });
  await mini.page.loadDetail();
  assert.equal(mini.page.data.mediaItems[0].type, "video");
  assert.equal(mini.page.data.mediaItems[0].url, input.mediaItems[0].url);
  assert.match((await prepareGuideForSave(f.source, guide({ mediaItems: input.mediaItems }))).error, /切换类型/);
  assert.equal((await prepareGuideForSave(f.source, guide({ mediaType: "video", mediaItems: [...input.mediaItems, ...input.mediaItems] }))).guide.mediaItems.length, 2);
});

test("incomplete drafts remain private; publishing validates point and media, and removing media stays removed", async (t) => {
  const f = await fixture(t);
  const saved = await f.request("/api/collection/guides", { id: "draft", title: "待完善" });
  assert.equal(saved.status, 201);
  assert.equal((await f.source.get("guides", "draft")).status, "草稿");
  assert.equal((await f.request("/api/rpc/getGuide", { id: "draft" }, "POST", false)).body.success, false);
  assert.equal((await f.request("/api/collection/guides/draft", { status: "启用" }, "PUT")).status, 400);
  assert.equal((await f.request("/api/collection/guides/draft", { status: "启用", spotId: "spot" }, "PUT")).status, 400);
  const current = guide();
  const prepared = await prepareGuideForSave(f.source, current);
  const cleared = await prepareGuideForSave(f.source, { status: "草稿", mediaItems: [] }, prepared.guide);
  assert.deepEqual(cleared.guide.mediaUrls, []);
  assert.equal((await prepareGuideForSave(f.source, { status: "启用" }, cleared.guide)).guide, undefined);
});

const richGuide = (extra = {}) => guide({
  contentHtml: '<h2>江边日落</h2><p>先拍一张</p><img src="https://test.invalid/body.jpg"><blockquote>再记录一段短片</blockquote><video src="https://test.invalid/clip.mp4" controls></video><p>最后散步</p>',
  spotIds: ["spot", "other"], targetProductType: "package", targetProductId: "wrong", targetProductSpotId: "other",
  status: "已发布", isShow: true, ...extra
});

test("rich articles preserve mixed media order, multiple points and booking at the selected product point", async (t) => {
  const f = await fixture(t);
  const saved = await f.request("/api/collection/guides", richGuide());
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const stored = await f.source.get("guides", "guide");
  assert.deepEqual(stored.spotIds, ["spot", "other"]);
  assert.equal(stored.spotId, "spot");
  assert.equal(stored.targetProductSpotId, "other");
  assert.equal(stored.mediaType, "rich");
  assert.deepEqual(stored.mediaItems.map((media) => media.type), ["image", "video"]);
  assert.equal(stored.content.includes("最后散步"), true);
  assert.equal(stored.content.includes("<h2>"), false);
  const split = schema.splitDocument("guides", stored);
  const hydrated = schema.hydrateDocument("guides", { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  assert.equal(hydrated.contentHtml, stored.contentHtml);
  assert.equal(hydrated.targetProductSpotId, "other");
  assert.deepEqual(hydrated.spotIds, stored.spotIds);
  assert.equal((await f.request("/api/collection/guides/guide", { title: "" }, "PUT")).status, 400, "清空已有标题不能恢复旧名称");
  const detail = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
  assert.deepEqual(detail.body.data.spots.map((spot) => spot.id), ["spot", "other"]);
  assert.equal(detail.body.data.bookingProduct.spotId, "other");
  const mini = miniPage(detail.body.data);
  mini.page.setData({ id: "guide", shopId: "shop-a", scene: "来源" });
  await mini.page.loadDetail();
  mini.page.goBookingProduct();
  assert.equal(new URL(mini.navigation().url, "https://mini.invalid").searchParams.get("spotId"), "other");
  assert.equal((await f.request("/api/rpc/listGuides", { spotId: "other" }, "POST", false)).body.data[0].id, "guide");
  assert.equal((await f.request("/api/collection/guides/guide", { targetProductSpotId: "spot" }, "PUT")).status, 400);
});

test("publication, storefront visibility and pinning remain independent across detail, list and home", async (t) => {
  const f = await fixture(t);
  for (const data of [richGuide({ id: "old-pinned", isTop: true, updatedAt: "2020-01-01T00:00:00Z" }), richGuide({ id: "newer", updatedAt: "2030-01-01T00:00:00Z" })]) {
    assert.equal((await f.request("/api/collection/guides", data)).status, 201);
  }
  assert.equal((await f.request("/api/rpc/getGuides", {}, "POST", false)).body.data[0].id, "old-pinned");
  assert.equal((await f.request("/api/rpc/getHomeData", {}, "POST", false)).body.data.guides[0].id, "old-pinned");
  assert.equal((await f.request("/api/collection/guides/newer", { isShow: false }, "PUT")).body.status, "已发布");
  assert.equal((await f.request("/api/rpc/getGuide", { id: "newer" }, "POST", false)).body.success, false);
  await f.request("/api/collection/guides/newer", { status: "草稿", isShow: true }, "PUT");
  assert.equal((await f.request("/api/rpc/getGuide", { id: "newer" }, "POST", false)).body.success, false);
  assert.deepEqual((await f.request("/api/rpc/getHomeData", {}, "POST", false)).body.data.guides.map((row) => row.id), ["old-pinned"]);
  assert.equal((await f.request("/api/collection/guides/newer", { status: "已发布" }, "PUT")).status, 200);
  assert.equal((await f.request("/api/rpc/getGuide", { id: "newer" }, "POST", false)).body.success, true);
  f.rows.guides.push({ id: "legacy", title: "历史内容", status: "已发布", spotId: "spot", visible: false, enabled: false, targetProductId: "deleted-product", targetProductType: "album" });
  assert.equal((await f.request("/api/collection/guides/legacy", { isShow: false }, "PUT")).status, 200);
  assert.equal((await f.request("/api/collection/guides/legacy", { isTop: true }, "PUT")).status, 200);
  assert.equal((await f.request("/api/collection/guides/legacy", { isShow: true }, "PUT")).status, 200);
  const legacy = await f.source.get("guides", "legacy");
  assert.equal(legacy.visible, true);
  assert.equal(legacy.enabled, true);
  assert.equal((await f.request("/api/rpc/getGuide", { id: "legacy" }, "POST", false)).body.success, true);
});

test("rich-text saves validate title, cover, body and points for drafts and published articles", async (t) => {
  const f = await fixture(t);
  for (const status of ["草稿", "已发布"]) {
    for (const invalid of [{ title: "" }, { title: "字".repeat(51) }, { cover: "" }, { contentHtml: "<p><br></p>" }, { spotIds: [] }, { spotIds: ["deleted"] }, { contentHtml: '<img src="javascript:alert(1)">' }, { contentHtml: "&".repeat(13000) }]) {
      const prepared = await prepareGuideForSave(f.source, richGuide({ targetProductType: "", targetProductId: "", status, ...invalid }));
      assert.ok(prepared.error, JSON.stringify(invalid));
    }
    assert.equal((await prepareGuideForSave(f.source, richGuide({ status, contentHtml: "<p>只写文字也可以</p>" }))).error, undefined);
    assert.equal((await prepareGuideForSave(f.source, richGuide({ status, contentHtml: '<img src="https://test.invalid/photo.jpg">' }))).error, undefined);
  }
});

test("unsafe markup is rebuilt from an allowlist and valid extensionless video survives", () => {
  const dirty = '<script>alert(1)</script><svg><a onload="alert(1)">bad</a></svg><p onclick="alert(1)" style="background:url(javascript:alert(1))">安全 &amp; 正文</p><img src="jav&#x61;script:alert(1)" onerror="alert(1)"><img src="data:image/svg+xml,test"><img src="https://test.invalid/safe.jpg" onerror="alert(1)"><video src="/api/media/file_123" poster="javascript:evil()" autoplay controls></video><iframe src="https://evil.invalid">bad</iframe>';
  const clean = sanitizeGuideHtml(dirty);
  assert.equal(clean, '<p>安全 &amp; 正文</p><img src="https://test.invalid/safe.jpg"><video src="/api/media/file_123" controls="controls"></video>');
  assert.equal(sanitizeGuideHtml(clean), clean);
  assert.deepEqual(guideMedia({ contentHtml: clean }).map((item) => item.type), ["image", "video"]);
  for (const unsafe of ['<IMG SRC="https://test.invalid/x\" onerror=alert(1)">', '<math><mtext><img src=x onerror=alert(1)></mtext></math>', '<video><source src="//evil.invalid/video.mp4"></video>', '<img src="java\nscript:alert(1)">', '<img src="&#47;&#47;evil.invalid/x">']) {
    assert.doesNotMatch(sanitizeGuideHtml(unsafe), /onerror|javascript:|\/\/evil\.invalid|<math/);
  }
});

test("multi-point guides retain available points and only lose booking when its own point disappears", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/collection/guides", richGuide())).status, 201);
  f.rows.spots[0].isShow = false;
  const detail = (await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false)).body;
  assert.equal(detail.success, true);
  assert.deepEqual(detail.data.spotIds, ["other"]);
  assert.equal(detail.data.bookingProduct.spotId, "other");
  assert.deepEqual((await f.request("/api/rpc/listGuides", { spotId: "spot" }, "POST", false)).body.data, []);
  const guide = f.rows.guides[0];
  let plan = pointDeletionPlan("spot", { guides: [guide] });
  assert.deepEqual(plan[0].patch.spotIds, ["other"]);
  assert.equal(Object.hasOwn(plan[0].patch, "targetProductId"), false);
  plan = pointDeletionPlan("other", { guides: [guide] });
  assert.equal(plan[0].patch.targetProductId, "");
  assert.equal(plan[0].patch.targetProductSpotId, "");
  f.rows.spots[0].isShow = true;
  f.rows.spots[1].isShow = false;
  const noBooking = (await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false)).body;
  assert.equal(noBooking.success, true);
  assert.equal(noBooking.data.bookingProduct, null);
});

test("guide package targets use effective constituent points despite missing or stale package bindings", async (t) => {
  const f = await fixture(t);
  f.rows.albums.push({ id: "other-photo", name: "别处留影", spotId: "other", status: "上架", price: 100 });
  // Legacy bundles may only carry constituent references. Their effective
  // points also change when an included product is moved by another editor.
  f.rows.packages.push({ id: "bundle", name: "组合套餐", status: "上架", includedItems: [{ type: "album", albumId: "other-photo" }] });
  const saved = await f.request("/api/collection/guides", richGuide({ targetProductId: "bundle" }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  let detail = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
  assert.equal(detail.body.data.bookingProduct.spotId, "other");
  f.rows.packages.at(-1).spotId = "spot";
  f.rows.packages.at(-1).spotIds = ["spot"];
  assert.equal((await prepareGuideForSave(f.source, richGuide({ targetProductId: "bundle" }))).error, undefined, "实际商品点位应覆盖套餐旧字段");
  detail = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
  assert.equal(detail.body.data.bookingProduct.spotId, "other");
  f.rows.albums.at(-1).spotId = "spot";
  detail = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
  assert.equal(detail.body.data.bookingProduct, null, "关联商品换点后旧预约关联失效");
  const wrong = await prepareGuideForSave(f.source, richGuide({ targetProductId: "bundle" }));
  assert.match(wrong.error, /打卡点/);
  const moved = await prepareGuideForSave(f.source, richGuide({ targetProductId: "bundle", targetProductSpotId: "spot" }));
  assert.equal(moved.error, undefined);
});

test("guide pinning precedes chronological ordering across numeric, numeric-string and ISO timestamps", () => {
  const rows = [
    { id: "invalid", updatedAt: "invalid" },
    { id: "numeric", updatedAt: Date.parse("2026-02-01T00:00:00Z") },
    { id: "iso", createdAt: "2026-01-01T00:00:00Z" },
    { id: "numeric-string", updateTime: String(Date.parse("2026-03-01T00:00:00Z")) },
    { id: "pinned", isTop: true, createTime: "2020-01-01T00:00:00Z" }
  ];
  assert.deepEqual(rows.sort(sortGuides).map((row) => row.id), ["pinned", "numeric-string", "numeric", "iso", "invalid"]);
});
