"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const ids = (rows) => Array.from(rows, (row) => row.id || row._id);

function fixture() {
  const computed = (definition) => typeof definition === "function"
    ? { get value() { return definition(); } }
    : { get value() { return definition.get(); }, set value(value) { definition.set(value); } };
  const Vue = { computed, ref: (value) => ({ value }), reactive: (value) => value };
  const window = { Vue, LXM_APP_PARTS: [], LXM_AUTH: { hasSession: () => false }, LXM_PAGES: { register(page) { window.page = page; } } };
  const data = {
    spots: [{ id: "a", name: "点A" }, { _id: "b", name: "点B" }],
    series: [{ _id: "style-a", name: "江景", spotIds: ["a"] }],
    albums: [
      { id: "photo-a", name: "A照片", spotId: "a", isShow: false },
      { id: "photo-inherited", name: "继承照片", seriesId: "style-a" },
      { id: "photo-b", name: "B照片", spotIds: ["b"] },
      { id: "photo-override", name: "改绑照片", spotId: "b", seriesId: "style-a" },
      { id: "photo-unbound", name: "解绑照片", spotId: "", spotIds: [], spotBindingExplicit: true, seriesId: "style-a" },
      { id: "photo-clearing", name: "待解绑照片", __spotSelectionChanged: true, seriesId: "style-a" },
      { id: "photo-deleted", spotId: "a", deleted: true }
    ],
    packages: [
      { id: "video-a", type: "video", isVideoSingle: true, spotId: "a", isShow: false },
      { id: "video-inherited", type: "video", productKind: "video_single", seriesId: "style-a" },
      { id: "video-b", type: "video", isVideoSingle: true, spotIds: ["b"], seriesId: "style-a" },
      { id: "video-unbound", type: "video", isVideoSingle: true, spotBindingExplicit: true, seriesId: "style-a" },
      { id: "video-deleted", type: "video", isVideoSingle: true, spotId: "a", isDeleted: true },
      { id: "legacy-video", type: "video", spotId: "a" },
      { id: "package-a", name: "A套餐", type: "photo", includedItems: [{ type: "album", productId: "photo-a" }], isShow: false },
      { id: "package-mixed", name: "跨点套餐", type: "photo", includedItems: [{ type: "album", productId: "photo-b" }, { type: "video", productId: "video-inherited" }] },
      { id: "package-b", name: "B套餐", type: "photo", spotId: "b" },
      { id: "package-deleted", type: "photo", spotId: "a", deleted: true }
    ],
    guides: [
      { id: "guide-a", title: "江景灵感", spotId: "a", status: "下架" },
      { id: "guide-inherited", title: "江景攻略", seriesId: "style-a" },
      { id: "guide-b", title: "江景以外", spotIds: ["b"] },
      { id: "guide-unbound", seriesId: "style-a", spotBindingExplicit: true },
      { id: "guide-deleted", spotId: "a", isDeleted: true }
    ],
    cities: [], samples: [], peripherals: [], tagLibrary: [], stories: [], orders: [], addonServices: []
  };
  const ctx = {
    data, computed, state: { active: "spots", filters: {}, role: "super" },
    can: () => true, money: (value) => value, productStatus: (row) => row.isShow === false ? "下架" : "上架",
    albumDependencySummary: () => ({}), seriesBySpot: (id) => data.series.filter((row) => (row.spotIds || []).includes(id))
  };
  const sandbox = { window, console };
  for (const file of ["11-content-lists.js", "12-content-edit.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  }
  const page = (file) => {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox);
    return window.page.setup(ctx);
  };
  return { ctx, page };
}

test("照片点位筛选包含直接与旧风格继承关联，排除已改绑和明确解绑记录", () => {
  const { ctx } = fixture();
  ctx.state.filters.contentSpotId = "a";
  assert.deepEqual(ids(ctx.albumRows.value), ["photo-a", "photo-inherited"]);
  ctx.state.filters.contentSpotId = "b";
  assert.deepEqual(ids(ctx.albumRows.value), ["photo-b", "photo-override"]);
  ctx.state.filters.contentSpotId = "";
  assert.equal(ctx.albumRows.value.length, 6, "隐藏内容仍可管理，删除内容不显示");
});

test("视频点位筛选沿用同一关联规则，支持风格继承和点位数组并排除已解绑记录", () => {
  const { ctx } = fixture();
  ctx.state.filters.contentSpotId = "a";
  assert.deepEqual(ids(ctx.filterVideoSingleRows(ctx.data.packages)), ["video-a", "video-inherited"]);
  ctx.state.filters.contentSpotId = "b";
  assert.deepEqual(ids(ctx.filterVideoSingleRows(ctx.data.packages)), ["video-b"]);
  ctx.state.filters.contentSpotId = "";
  assert.deepEqual(ids(ctx.filterVideoSingleRows(ctx.data.packages)), ["video-a", "video-inherited", "video-b", "video-unbound"]);
});

test("套餐点位筛选接受导航传入值和后续切换，重置解除关联筛选且组合点位可继承", () => {
  const { ctx, page } = fixture();
  ctx.state.filters.contentSpotId = "a";
  const packages = page("src/views/content/package/package.js");
  assert.equal(packages.spotFilter.value, "a");
  assert.deepEqual(ids(packages.tableRows.value), ["package-a", "package-mixed"]);
  ctx.state.filters.contentSpotId = "b";
  assert.equal(packages.spotFilter.value, "b", "页面已创建时再次跳转也会使用新点位");
  assert.deepEqual(ids(packages.tableRows.value), ["package-mixed", "package-b"]);
  packages.spotFilter.value = "a";
  assert.equal(ctx.state.filters.contentSpotId, "a", "手动切换同步共享筛选");
  packages.resetFilters();
  assert.equal(ctx.state.filters.contentSpotId, "");
  assert.deepEqual(ids(packages.tableRows.value), ["package-a", "package-mixed", "package-b"]);
});

test("空组合明细保留旧套餐点位，非空别名明细仍会派生组合点位", () => {
  const { ctx } = fixture();
  assert.deepEqual(Array.from(ctx.contentSpotIds({ spotId: "b", includedItems: [], items: [] })), ["b"]);
  assert.deepEqual(Array.from(ctx.contentSpotIds({ spotId: "b", includedItems: [], items: [{ type: "album", productId: "photo-a" }] })), ["a"]);
});

test("旅拍灵感按跳转点位和关键词共同筛选，点位切换不会混入其他内容", () => {
  const { ctx, page } = fixture();
  const guides = page("src/views/operationConfig/guide/guide.js");
  ctx.state.filters.contentSpotId = "a";
  assert.deepEqual(ids(guides.guideRows.value), ["guide-a", "guide-inherited"]);
  ctx.state.filters.keyword = "攻略";
  assert.deepEqual(ids(guides.guideRows.value), ["guide-inherited"]);
  ctx.state.filters.contentSpotId = "b";
  assert.deepEqual(ids(guides.guideRows.value), []);
  ctx.state.filters.keyword = "";
  assert.deepEqual(ids(guides.guideRows.value), ["guide-b"]);
  ctx.state.filters.contentSpotId = "";
  assert.equal(guides.guideRows.value.length, 4);
});
