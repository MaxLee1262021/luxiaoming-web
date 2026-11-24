"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");
const order = require("../../src/utils/content-order.js");

function fixture() {
  const products = (prefix, extra = {}) => [3, 1, 2].map((sort) => ({
    id: `${prefix}-${sort}`, name: `${prefix} ${sort}`, sort, hotScore: sort * 100,
    spotId: "point", seriesId: "style", sampleUrls: [], ...extra
  }));
  const rows = {
    cities: [{ id: "city", name: "长沙" }], spots: [{ id: "point", cityId: "city" }],
    series: [{ id: "style", spotId: "point" }],
    homeConfig: [{ id: "homeStats", bannerConfigVersion: 1, banners: [],
      recommendations: { featuredAlbumIds: ["album-3", "album-2", "album-1"], hotPackageIds: ["package-3", "package-2", "package-1"] } }],
    albums: products("album"),
    packages: [...products("package", { type: "photo", isHot: true, isMainPush: true }),
      ...products("video", { type: "video", productKind: "video_single" })],
    guides: products("guide", { status: "已发布" }).map((row) => ({ ...row,
      title: row.name, isTop: row.sort === 3, readCount: row.sort * 10, score: row.sort,
      updatedAt: `2026-11-0${row.sort}` })),
    peripherals: [], samples: []
  };
  rows.albums.push({ id: "hidden-album", sort: 1, isShow: false });
  return { rows, source: {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find((row) => row.id === id) || null); }
  } };
}
const ids = (rows) => rows.map((row) => row.id || row._id);
const expected = (prefix) => [1, 2, 3].map((position) => `${prefix}-${position}`);

test("public home, selected point, booking and video lists honor each category's insertion positions before heat and configured recommendation order", async () => {
  const { source } = fixture();
  const home = await rpc(source, "getHomeData", { cityId: "city", spotId: "point" });
  assert.equal(home.success, true, JSON.stringify(home));
  assert.deepEqual(ids(home.data.albums), expected("album"));
  assert.deepEqual(ids(home.data.hotPackages), expected("package"));
  assert.deepEqual(ids(home.data.videoSingles), expected("video"));
  assert.deepEqual(ids(home.data.guides), expected("guide"));
  for (const [key, prefix] of [["albums", "album"], ["packages", "package"], ["videoSingles", "video"]]) {
    assert.deepEqual(ids(home.data.spotProducts[key]), expected(prefix));
  }
  const point = await rpc(source, "getHomeData", { cityId: "city", spotId: "point", spotProductsOnly: true });
  assert.deepEqual(point.data.spotProducts, home.data.spotProducts);
  const booking = await rpc(source, "getBookingData", {});
  assert.deepEqual(ids(booking.data.albums), expected("album"));
  assert.deepEqual(ids(booking.data.packages.filter((row) => row.type === "photo")), expected("package"));
  assert.deepEqual(ids(booking.data.packages.filter((row) => row.type === "video")), expected("video"));
  const video = await rpc(source, "getVideoSingles", { spotId: "point", limit: 2 });
  assert.deepEqual(ids(video.data), expected("video").slice(0, 2));
});

test("detail recommendations retain manual order and fresh public requests observe a completed insertion", async () => {
  const { source, rows } = fixture();
  const detail = await rpc(source, "getSeriesDetail", { seriesId: "style" });
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.deepEqual(ids(detail.data.albums), expected("album"));
  assert.deepEqual(ids(detail.data.mainPushPackages), expected("package"));
  const plan = order.insertion("albums", rows.albums, "album-3", 1);
  for (const change of plan.changes) Object.assign(rows.albums.find((row) => row.id === change.id), change);
  const latest = await rpc(source, "getBookingData", {});
  assert.deepEqual(ids(latest.data.albums), ["album-3", "album-1", "album-2"]);
  assert.deepEqual(ids(latest.data.packages.filter((row) => row.type === "video")), expected("video"));
});

test("guide default order follows positions while explicit numeric metrics keep priority and point visibility", async () => {
  const { source } = fixture();
  const normal = await rpc(source, "listGuides", { spotId: "point" });
  assert.deepEqual(ids(normal.data), expected("guide"));
  for (const sortBy of ["readCount", "score"]) {
    const ranked = await rpc(source, "listGuides", { spotId: "point", sortBy });
    assert.deepEqual(ids(ranked.data), expected("guide").reverse());
  }
});
