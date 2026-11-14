"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const rpc = require("../../server/lib/rpc.cjs");
const schema = require("../../server/lib/mysqlSchema.cjs");

const root = path.resolve(__dirname, "../..");
const plain = (value) => JSON.parse(JSON.stringify(value));
const homeKeys = ["features", "bookingAlbums", "videoProducts", "hotPackages"];

function editorFixture(homeConfig = {}, rows = {}) {
  const writes = [], messages = [];
  const window = {
    LXM_UPLOAD: { ready: () => true },
    LXM_CLOUD_MODE: "mysql", LXM_AUTH: { hasSession: () => true }, LXM_API_STATE: { reachable: true },
    LXM_CLOUD: { upsertDoc: async (key, id, value) => { writes.push({ key, id, value: plain(value) }); return { ok: true }; } }
  };
  const data = Object.fromEntries(["cities", "spots", "series", "samples", "albums", "packages", "peripherals", "guides", "stories"].map((key) => [key, []]));
  Object.assign(data, rows);
  const ctx = {
    data, state: { homeConfig: plain(homeConfig) },
    computed: (getter) => ({ get value() { return getter(); } }),
    scopedOrders: { value: [] }, productStatus: (row) => row.status || "上架", log() {},
    ElMessage: Object.fromEntries(["success", "warning", "error", "info"].map((key) => [key, (message) => messages.push({ key, message })]))
  };
  const sandbox = { window, console };
  for (const file of ["12-content-edit.js", "14-page-config.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox, { filename: file });
  }
  for (const factory of window.LXM_APP_PARTS) Object.assign(ctx, factory(ctx));
  return { ctx, writes, messages, window };
}

function publicSource(config, rows = {}) {
  const collections = {
    homeConfig: [{ ...plain(config), id: "homeStats" }], config: [],
    cities: [{ id: "cs", name: "长沙", enabled: true, visible: true, status: "运营中" }],
    spots: [{ id: "spot", name: "橘子洲", cityId: "cs", isShow: true, status: "启用", hotScore: 100 }],
    series: [], albums: [], samples: [], packages: [], peripherals: [], guides: [], shops: [], merchantCodes: [],
    ...plain(rows)
  };
  return {
    async list(key) { return plain(collections[key] || []); },
    async get(key, id) { return plain((collections[key] || []).find((row) => String(row.id || row._id) === String(id)) || null); }
  };
}

async function publicHome(config, rows) {
  const response = await rpc(publicSource(config, rows), "getHomeData", { cityId: "cs" });
  assert.equal(response.success, true, response.error);
  return response.data;
}

test("外部链接保存至 MySQL 并通过公开接口完整返回，两页独立保留地址", async () => {
  const linkUrl = "https://example.com/travel?product=123&from=banner#details";
  const fixture = editorFixture({
    homeBanners: [{ _id: "home-link", url: "/home.jpg", targetType: "external", targetId: "stale-id", linkUrl: ` ${linkUrl} ` }],
    exploreBanners: [{ _id: "explore-link", url: "/explore.mp4", type: "video", targetType: "external", linkUrl: "https://example.com/inspiration" }]
  });
  assert.equal(await fixture.ctx.saveHomeConfig(), true);
  const saved = fixture.writes[0].value;
  assert.equal(saved.homeBanners[0].targetType, "external");
  assert.equal(saved.homeBanners[0].targetId, "");
  assert.equal(saved.homeBanners[0].linkUrl, linkUrl);
  assert.equal(saved.editorConfig.homeBanners[0].linkUrl, linkUrl);
  const split = schema.splitDocument("homeConfig", { ...saved, id: "homeStats" });
  const normalized = schema.hydrateDocument("homeConfig", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  const home = await publicHome(normalized);
  assert.equal(home.banners[0].targetType, "external");
  assert.equal(home.banners[0].linkUrl, linkUrl);
  assert.equal(home.exploreBanners[0].targetType, "external");
  assert.equal(home.exploreBanners[0].linkUrl, "https://example.com/inspiration");
  fixture.ctx.state.homeConfig.homeBanners[0].targetType = "guides";
  const changed = fixture.ctx.buildMiniProgramHomeConfig();
  assert.equal(changed.homeBanners[0].linkUrl, "");
  assert.equal(changed.homeBanners[0].targetId, "");
});

test("公开轮播显式清空链接和目标时不会复活历史别名", async () => {
  const home = await publicHome({
    banners: [{ _id: "external", url: "/banner.jpg", targetType: "external", linkUrl: "", jumpUrl: "https://old.example/path" },
      { _id: "package", url: "/package.jpg", targetType: "package", targetId: "", jumpId: "deleted-package" }]
  });
  assert.equal(home.banners[0].linkUrl, "");
  assert.equal(home.banners[1].targetId, "");
});

test("首页四个开关经保存合同和公开 RPC 独立生效，旧页面配置不再覆盖", async () => {
  const fixture = editorFixture({
    enabledModules: ["guides", "albums", "videoProducts", "mainPush"],
    pageModules: { home: { enabledModules: ["features", "bookingAlbums", "videoProducts", "hotPackages"] } }
  });
  assert.deepEqual(plain(fixture.ctx.homeModuleOptions.map((row) => row.key)), homeKeys);
  for (const key of homeKeys) {
    assert.equal(fixture.ctx.isHomeModuleEnabled(key), true);
    fixture.ctx.toggleHomeModule(key);
  }
  let result = await publicHome(fixture.ctx.buildMiniProgramHomeConfig());
  for (const key of homeKeys) assert.equal(result.modules.find((row) => row.key === key).visible, false);
  fixture.ctx.toggleHomeModule("bookingAlbums");
  result = await publicHome(fixture.ctx.buildMiniProgramHomeConfig());
  for (const key of homeKeys) assert.equal(result.modules.find((row) => row.key === key).visible, key === "bookingAlbums");
  fixture.ctx.toggleHomeModule("spots");
  assert.equal(fixture.ctx.isHomeModuleEnabled("bookingAlbums"), true);
});

test("已保存的公开显隐合同优先于旧 enabledModules 快照", async () => {
  const fixture = editorFixture({
    enabledModules: ["guides", "albums", "videoProducts", "mainPush"],
    homeModules: homeKeys.map((key) => ({ key, visible: false, enabled: false }))
  });
  const home = await publicHome(fixture.ctx.buildMiniProgramHomeConfig());
  for (const key of homeKeys) assert.equal(home.modules.find((row) => row.key === key).visible, false);
});

test("首页选择的照片和套餐推荐传给公开 RPC，打卡点保持热度排名", async () => {
  const rows = {
    spots: Array.from({ length: 8 }, (_, index) => ({ id: `spot-${index}`, cityId: "cs", name: `点位${index}`, isShow: true, status: "启用", hotScore: index })),
    albums: ["first", "picked"].map((id) => ({ id: `album-${id}`, name: id, spotId: "spot-7", status: "上架", isShow: true })),
    packages: ["first", "picked"].map((id, index) => ({ id: `package-${id}`, name: id, spotId: "spot-7", status: "上架", isShow: true, type: "photo", hotScore: 99 - index }))
  };
  const fixture = editorFixture({ featuredAlbumIds: ["album-picked"], featuredPackageIds: ["package-picked"] }, rows);
  const home = await publicHome(fixture.ctx.buildMiniProgramHomeConfig(), rows);
  assert.equal(home.albums[0]._id, "album-picked");
  assert.equal(home.packages[0]._id, "package-picked");
  assert.deepEqual(home.pageConfig.recommendations.hotPackageIds, ["package-picked"]);
  assert.deepEqual(home.pageConfig.recommendations.featuredAlbumIds, ["album-picked"]);
  assert.deepEqual(home.spots.map((row) => row._id), Array.from({ length: 8 }, (_, index) => `spot-${7 - index}`));
});

test("清空自定义轮播后不会回退已退役的选中样片或公开样片", async () => {
  const samples = [{ id: "old-sample", _id: "old-sample", url: "/old-sample.jpg", isShowcase: true }];
  const fixture = editorFixture({
    homeBanners: [{ _id: "blank", url: "", type: "image" }],
    carouselIds: ["old-sample"]
  }, { samples });
  const config = fixture.ctx.buildMiniProgramHomeConfig();
  const home = await publicHome(config, { samples });
  assert.deepEqual(home.banners, []);
  assert.deepEqual(plain(config.carouselIds), []);
  assert.equal(config.bannerConfigVersion, 1);
});

test("有效自定义轮播优先于样片，并只公开前六张", async () => {
  const homeBanners = Array.from({ length: 8 }, (_, index) => ({ _id: `custom-${index}`, url: `/custom-${index}.jpg`, targetType: "none" }));
  const fixture = editorFixture({ homeBanners, carouselIds: ["sample"] }, { samples: [{ id: "sample", url: "/sample.jpg" }] });
  const home = await publicHome(fixture.ctx.buildMiniProgramHomeConfig());
  assert.deepEqual(home.banners.map((row) => row._id), homeBanners.slice(0, 6).map((row) => row._id));
});

test("更换旧轮播素材和选择不跳转会清理优先级更高的旧媒体及链接别名", async () => {
  const fixture = editorFixture({ homeBanners: [{
    _id: "legacy", url: "/new.jpg", imageUrl: "/old.jpg", targetType: "none", targetId: "old-target",
    linkUrl: "https://old.test", jumpUrl: "https://old-jump.test", pagePath: "/pages/old/old"
  }] });
  const home = await publicHome(fixture.ctx.buildMiniProgramHomeConfig());
  assert.equal(home.banners[0].url, "/new.jpg");
  assert.equal(home.banners[0].targetType, "none");
  assert.equal(home.banners[0].targetId, "");
  assert.equal(home.banners[0].linkUrl, "");
  for (const key of ["imageUrl", "jumpUrl", "pagePath"]) assert.equal(home.banners[0][key], undefined);
  assert.equal(fixture.ctx.state.homeConfig.homeBanners[0].imageUrl, "/old.jpg", "构建合同不得原地修改未保存的编辑值");
});

test("保存轮播不重建详情、板块显隐或推荐配置", async () => {
  const exploreBanners = [{ _id: "explore", url: "/explore.jpg", targetType: "guide", targetId: "guide" }];
  const pageModules = { albumDetail: { bannerIds: ["photo"], sampleIds: ["second", "first"], enabledModules: ["samples"] }, spotList: { title: "既有筛选", categories: [{ name: "夜景", value: "night" }] } };
  const recommendations = { hotSpotIds: ["spot-7"], peripheralIds: ["peripheral"] };
  const fixture = editorFixture({ exploreBanners, pageModules, recommendations, enabledModules: ["features"], homeModules: [] }, {
    spots: Array.from({ length: 8 }, (_, index) => ({ id: `spot-${index}` }))
  });
  await fixture.ctx.saveHomeConfig();
  assert.equal(fixture.writes.length, 1);
  const write = fixture.writes[0];
  assert.equal(write.key, "homeConfig"); assert.equal(write.id, "homeStats");
  assert.equal(write.value.exploreBanners[0]._id, "explore");
  assert.equal(write.value.exploreBanners[0].targetType, "guide");
  assert.equal(write.value.exploreBanners[0].targetId, "guide");
  assert.deepEqual(write.value.pageModules, pageModules);
  assert.deepEqual(write.value.recommendations, recommendations);
  assert.deepEqual(write.value.enabledModules, ["features"]);
  assert.deepEqual(write.value.homeModules, []);
  write.value.pageModules.albumDetail.sampleIds.reverse();
  assert.deepEqual(fixture.ctx.state.homeConfig.pageModules.albumDetail.sampleIds, ["second", "first"]);
});

test("两页删除最后一张轮播保存到 MySQL 后，不会被旧编辑快照或公开样片复活", async () => {
  const staleBanner = { _id: "deleted", url: "/deleted.jpg", targetType: "package", targetId: "deleted-package" };
  const fixture = editorFixture({
    banners: [staleBanner], homeBanners: [], exploreBanners: [], carouselIds: [],
    homeModules: homeKeys.map((key) => ({ key, visible: false, enabled: false })),
    enabledModules: ["guides", "albums", "mainPush", "videoProducts"],
    featuredPackageIds: [], featuredAlbumIds: [],
    recommendations: { hotPackageIds: ["deleted-package"], featuredAlbumIds: ["deleted-album"] },
    editorConfig: { homeBanners: [staleBanner], banners: [staleBanner], exploreBanners: [staleBanner], carouselIds: ["deleted-sample"] }
  });
  await fixture.ctx.saveHomeConfig();
  assert.equal(fixture.writes.length, 1);
  const saved = fixture.writes[0].value;
  const split = schema.splitDocument("homeConfig", { ...saved, id: "homeStats" });
  const restored = schema.hydrateDocument("homeConfig", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  const home = await publicHome(restored, { samples: [{ _id: "showcase", url: "/showcase.jpg", isShowcase: true }] });
  assert.deepEqual(home.banners, []);
  assert.deepEqual(home.exploreBanners, []);
  assert.equal(restored.bannerConfigVersion, 1);
  assert.deepEqual(home.pageConfig.recommendations.hotPackageIds, ["deleted-package"]);
  assert.deepEqual(home.pageConfig.recommendations.featuredAlbumIds, ["deleted-album"]);
  for (const key of homeKeys) assert.equal(home.modules.find((row) => row.key === key).visible, false);
  assert.deepEqual(saved.editorConfig.banners, []);
  assert.deepEqual(saved.editorConfig.homeBanners, []);
  assert.deepEqual(saved.editorConfig.exploreBanners, []);
});

test("MySQL 首次保存轮播不会生成已经移除的板块配置", async () => {
  const initial = schema.hydrateDocument("homeConfig", { id: "homeStats" }, {});
  assert.deepEqual(initial.homeModules, []);
  assert.deepEqual(initial.enabledModules, []);
  const fixture = editorFixture(initial);
  for (const key of homeKeys) assert.equal(fixture.ctx.isHomeModuleEnabled(key), true);
  await fixture.ctx.saveHomeConfig();
  const split = schema.splitDocument("homeConfig", { ...fixture.writes[0].value, id: "homeStats" });
  const restored = schema.hydrateDocument("homeConfig", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  const home = await publicHome(restored);
  assert.deepEqual(home.modules, []);
  assert.deepEqual(restored.homeModules, []);
  assert.deepEqual(restored.enabledModules, []);
});

test("显式清空轮播地址和目标 ID 不从历史 imageUrl/linkId/jumpId 复活", async () => {
  const fixture = editorFixture({
    homeBanners: [
      { _id: "removed-media", type: "image", url: "", imageUrl: "/stale.jpg", targetType: "none" },
      { _id: "kept-media", type: "image", url: "/new.jpg", imageUrl: "/old.jpg", targetType: "package", targetId: "", linkId: "stale-link", jumpId: "stale-jump" }
    ]
  });
  const home = await publicHome(fixture.ctx.buildMiniProgramHomeConfig());
  assert.deepEqual(home.banners.map((row) => row._id), ["kept-media"]);
  assert.equal(home.banners[0].url, "/new.jpg");
  assert.equal(home.banners[0].targetId, "");
  assert.equal(home.banners[0].linkId, undefined);
  assert.equal(home.banners[0].jumpId, undefined);
});

test("首页与探索轮播独立限六张，图片视频及排序经过 MySQL 和公开 RPC 保持一致", async () => {
  const makeBanners = (group) => Array.from({ length: 8 }, (_, index) => ({
    _id: `${group}-${index}`, type: index % 2 ? "video" : "image",
    url: `/${group}-${index}.${index % 2 ? "mp4" : "jpg"}`, cover: `/${group}-${index}-cover.jpg`,
    targetType: "spot", targetId: `spot-${index}`
  }));
  const fixture = editorFixture({ homeBanners: makeBanners("home"), exploreBanners: makeBanners("explore") });
  assert.equal(await fixture.ctx.saveHomeConfig(), true);
  const saved = fixture.writes[0].value;
  const split = schema.splitDocument("homeConfig", { ...saved, id: "homeStats" });
  const restored = schema.hydrateDocument("homeConfig", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  const home = await publicHome(restored);
  for (const [field, group] of [["banners", "home"], ["exploreBanners", "explore"]]) {
    assert.deepEqual(home[field].map((row) => row._id), Array.from({ length: 6 }, (_, index) => `${group}-${index}`));
    assert.equal(home[field][1].type, "video");
    assert.equal(home[field][1].url, `/${group}-1.mp4`);
    assert.equal(home[field][1].cover, `/${group}-1-cover.jpg`);
    assert.equal(home[field][1].targetId, "spot-1");
  }
});

for (const clearedGroup of ["homeBanners", "exploreBanners"]) test(`清空 ${clearedGroup} 不影响另一页面的轮播`, async () => {
  const fixture = editorFixture({
    homeBanners: [{ _id: "home", url: "/home.jpg", targetType: "album", targetId: "photo" }],
    exploreBanners: [{ _id: "explore", url: "/explore.jpg", targetType: "guide", targetId: "guide" }]
  });
  fixture.ctx.state.homeConfig[clearedGroup] = [];
  const home = await publicHome(fixture.ctx.buildMiniProgramHomeConfig());
  assert.deepEqual(home[clearedGroup === "homeBanners" ? "banners" : "exploreBanners"], []);
  const kept = home[clearedGroup === "homeBanners" ? "exploreBanners" : "banners"];
  assert.equal(kept.length, 1);
  assert.equal(kept[0]._id, clearedGroup === "homeBanners" ? "explore" : "home");
  assert.equal(kept[0].targetType, clearedGroup === "homeBanners" ? "guide" : "album");
});

test("探索轮播选择不跳转后清理旧链接和目标，退役的城市/显隐/文案不再限制展示", async () => {
  const fixture = editorFixture({ exploreBanners: [{
    _id: "explore", mediaType: "video", videoUrl: "/new.mp4", poster: "/cover.jpg",
    targetType: "none", targetId: "stale", linkType: "package", jumpId: "stale",
    linkUrl: "/pages/explore/explore", jumpUrl: "https://stale.test", pagePath: "/pages/my/my",
    cityId: "hz", cityIds: ["hz"], city: "杭州", cityName: "杭州", cities: ["杭州"],
    title: "旧标题", visible: false, enabled: false, isShow: false, status: "下架", deleted: true
  }] });
  const saved = fixture.ctx.buildMiniProgramHomeConfig();
  const home = await publicHome(saved);
  assert.equal(home.exploreBanners.length, 1);
  const banner = home.exploreBanners[0];
  assert.equal(banner.url, "/new.mp4");
  assert.equal(banner.cover, "/cover.jpg");
  assert.equal(banner.targetType, "none");
  assert.equal(banner.targetId, "");
  assert.equal(banner.linkUrl, "");
  for (const field of ["cityId", "cityIds", "city", "cityName", "cities", "title", "visible", "enabled", "isShow", "status", "deleted", "jumpId", "linkType", "pagePath", "jumpUrl", "videoUrl"]) {
    assert.equal(banner[field], undefined, field);
  }
  assert.equal(fixture.ctx.state.homeConfig.exploreBanners[0].cityId, "hz", "构建不得修改未保存编辑值");
});

test("服务端保存失败返回 false 且不显示成功提示", async () => {
  const fixture = editorFixture({ homeBanners: [{ _id: "home", url: "/home.jpg" }] });
  fixture.window.LXM_CLOUD.upsertDoc = async () => { throw new Error("write failed"); };
  assert.equal(await fixture.ctx.saveHomeConfig(), false);
  assert.equal(fixture.messages.some((row) => row.key === "success"), false);
  assert.equal(fixture.messages.some((row) => row.key === "error" && row.message.includes("write failed")), true);
});

function cloudFixture(document, fallback = false) {
  const values = new Map(), listeners = new Map();
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => plain(body) });
  const window = {
    location: { href: "https://admin.test/", origin: "https://admin.test" }, console: { warn() {} },
    sessionStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) || []), handler]); },
    dispatchEvent(event) { for (const handler of listeners.get(event.type) || []) handler(event); }
  };
  window.fetch = async (input) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname === "/api/health") return response({ ok: true, mode: "mysql" });
    if (url.pathname.startsWith("/api/modules/")) {
      if (fallback) return response({ error: "legacy server" }, 404);
      const collections = Object.fromEntries(String(url.searchParams.get("keys")).split(",").map((key) => [key, key === "homeConfig" ? document : []]));
      return response({ collections, skippedKeys: [] });
    }
    if (url.pathname === "/api/collection/homeConfig/homeStats") return response(document);
    if (url.pathname.startsWith("/api/collection/")) return response([]);
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const sandbox = { window, console, URL, Headers, Request, CustomEvent };
  for (const file of ["src/config/api.js", "src/api/cloud.js"]) vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: file });
  const data = Object.fromEntries(window.LXM_API_CONFIG.dataKeys.map((key) => [key, []]));
  const state = { homeConfig: {} };
  window.LXM_AUTH.setSession({ token: "test-token", role: "super" });
  return { window, data, state };
}

for (const fallback of [false, true]) test(`重新进入首页配置从${fallback ? "旧服务单文档" : "模块数据包"}读回游客实际使用的合同`, async () => {
  const document = {
    homeBanners: [{ _id: "public", url: "/public.jpg", targetType: "none" }],
    homeModules: homeKeys.map((key) => ({ key, visible: false, enabled: false })),
    recommendations: { hotPackageIds: ["public-package"], featuredAlbumIds: ["public-album"] },
    exploreBanners: [{ _id: "explore", url: "/explore.jpg" }],
    editorConfig: {
      homeBanners: [{ _id: "stale", url: "/stale.jpg" }], enabledModules: ["guides", "albums", "mainPush", "videoProducts"],
      featuredPackageIds: ["stale-package"], featuredAlbumIds: ["stale-album"]
    }
  };
  const fixture = cloudFixture(document, fallback);
  const loaded = await fixture.window.LXM_CLOUD.loadMenuData("miniDecor", fixture.data, fixture.state);
  assert.equal(loaded.ok, true); assert.equal(loaded.loaded.includes("homeConfig"), true);
  const editor = editorFixture(plain(fixture.state.homeConfig));
  const home = await publicHome(editor.ctx.buildMiniProgramHomeConfig());
  assert.equal(home.banners[0]._id, "public");
  assert.deepEqual(home.pageConfig.recommendations.hotPackageIds, ["public-package"]);
  assert.deepEqual(home.pageConfig.recommendations.featuredAlbumIds, ["public-album"]);
  for (const key of homeKeys) assert.equal(home.modules.find((row) => row.key === key).visible, false);
  assert.equal(fixture.state.homeConfig.exploreBanners[0]._id, "explore");
});

test("历史公开轮播只有 banners 时导入自定义编辑列表，保存后继续展示", async () => {
  const document = {
    banners: [{ _id: "legacy-public", url: "/legacy.jpg", targetType: "none" }],
    homeBanners: [], carouselIds: [],
    editorConfig: { carouselIds: ["stale-sample"], homeBanners: [] }
  };
  const fixture = cloudFixture(document);
  await fixture.window.LXM_CLOUD.loadMenuData("miniDecor", fixture.data, fixture.state);
  assert.equal(fixture.state.homeConfig.homeBanners[0]._id, "legacy-public");
  const editor = editorFixture(plain(fixture.state.homeConfig));
  const home = await publicHome(editor.ctx.buildMiniProgramHomeConfig());
  assert.equal(home.banners[0]._id, "legacy-public");
});

test("旧样片轮播读回统一导入可编辑列表，并保留既有跳转", async () => {
  const document = {
    banners: [{ _id: "sample", url: "/sample.jpg", targetType: "package_list" }],
    homeBanners: [], carouselIds: ["sample"],
    editorConfig: { homeBanners: [], carouselIds: ["sample"] }
  };
  const fixture = cloudFixture(document);
  await fixture.window.LXM_CLOUD.loadMenuData("miniDecor", fixture.data, fixture.state);
  assert.deepEqual(plain(fixture.state.homeConfig.carouselIds), []);
  assert.equal(fixture.state.homeConfig.homeBanners[0]._id, "sample");
  assert.equal(fixture.state.homeConfig.homeBanners[0].targetType, "package_list");
  const editor = editorFixture(plain(fixture.state.homeConfig), { samples: [{ id: "sample", url: "/updated-sample.jpg" }] });
  const home = await publicHome(editor.ctx.buildMiniProgramHomeConfig());
  assert.equal(home.banners[0].url, "/sample.jpg");
  assert.equal(home.banners[0].targetType, "package_list");
});

for (const fallback of [false, true]) test(`两页轮播从${fallback ? "旧服务" : "模块数据包"}回读统一媒体及跳转别名`, async () => {
  const fixture = cloudFixture({
    homeBanners: [{ id: "home", mediaType: "image", imgUrl: "/home.jpg", linkType: "photo_collection", linkId: "photo" }],
    exploreBanners: [{ id: "explore", mediaType: "video", videoUrl: "/explore.mp4", poster: "/explore-cover.jpg", jumpType: "videoSingle", jumpId: "video" }]
  }, fallback);
  await fixture.window.LXM_CLOUD.loadMenuData("miniDecor", fixture.data, fixture.state);
  assert.equal(fixture.state.homeConfig.homeBanners[0].url, "/home.jpg");
  assert.equal(fixture.state.homeConfig.homeBanners[0].targetType, "album");
  assert.equal(fixture.state.homeConfig.homeBanners[0].targetId, "photo");
  const explore = fixture.state.homeConfig.exploreBanners[0];
  assert.equal(explore.type, "video");
  assert.equal(explore.url, "/explore.mp4");
  assert.equal(explore.cover, "/explore-cover.jpg");
  assert.equal(explore.targetType, "video");
  assert.equal(explore.targetId, "video");
});

test("新版显式空轮播回读不被旧 public banners 或 editorConfig 复活", async () => {
  const stale = [{ id: "stale", url: "/stale.jpg" }];
  const fixture = cloudFixture({
    bannerConfigVersion: 1, homeBanners: [], exploreBanners: [], banners: stale, carouselIds: [],
    editorConfig: { homeBanners: stale, exploreBanners: stale, carouselIds: ["stale"] }
  });
  await fixture.window.LXM_CLOUD.loadMenuData("miniDecor", fixture.data, fixture.state);
  assert.deepEqual(plain(fixture.state.homeConfig.homeBanners), []);
  assert.deepEqual(plain(fixture.state.homeConfig.exploreBanners), []);
  const home = await publicHome(editorFixture(plain(fixture.state.homeConfig)).ctx.buildMiniProgramHomeConfig());
  assert.deepEqual(home.banners, []);
  assert.deepEqual(home.exploreBanners, []);
});
