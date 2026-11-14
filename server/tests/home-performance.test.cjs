"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");

function fixture(overrides = {}) {
  const rows = {
    homeConfig: [{ id: "homeStats", bannerConfigVersion: 1, banners: [] }],
    cities: [{ id: "cs", name: "长沙", status: "运营中" }, { id: "hz", name: "杭州", status: "运营中" }],
    spots: [{ id: "a", name: "江边", cityId: "cs", isShow: true }, { id: "b", name: "西湖", cityId: "hz", isShow: true },
      { id: "hidden-point", name: "隐藏点位", cityId: "cs", isShow: false }],
    series: [{ id: "style", name: "城市夜景", spotIds: ["a"], cover: "https://images.test/style.jpg" }],
    albums: [{ id: "photo", name: "江边留影", seriesId: "style", photoCount: 12, price: 399,
      sampleUrls: ["https://images.test/preview.jpg"], cover: "https://images.test/cover.jpg", intro: "拍摄说明",
      makeupIncluded: true, retouchMode: "count", retouchCount: 3, tags: ["夜景"], styleTags: ["自然"], status: "上架" }],
    packages: [], peripherals: [], guides: [], samples: [],
    ...overrides
  };
  const reads = [];
  return { rows, reads, source: {
    async list(key) { reads.push({ method: "list", key }); return structuredClone(rows[key] || []); },
    async get(key, id) { reads.push({ method: "get", key, id }); return structuredClone((rows[key] || []).find((row) => String(row.id) === String(id)) || null); }
  } };
}

test("home includes complete album card metadata matching detail with one collection read and no per-album lookup", async () => {
  const { source, rows, reads } = fixture();
  const before = structuredClone(rows);
  const home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(home.success, true, JSON.stringify(home));
  assert.equal(home.data.albumMetadataComplete, true);
  assert.equal(home.data.albums.length, 1);
  for (const key of new Set(reads.filter((read) => read.method === "list").map((read) => read.key))) {
    assert.equal(reads.filter((read) => read.method === "list" && read.key === key).length, 1, `repeated ${key} query`);
  }
  assert.equal(reads.some((read) => read.method === "get" && read.key === "albums"), false);
  assert.equal(reads.some((read) => read.key === "samples"), false, "modern albums and explicit banners need no sample catalogue");
  const detail = await rpc(source, "getPhotoCollection", { albumId: "photo" });
  assert.equal(detail.success, true, JSON.stringify(detail));
  for (const key of ["_id", "albumId", "name", "seriesId", "seriesName", "spotId", "spotName", "cover", "coverImage", "sampleUrls", "photoCount", "price", "retouchMode", "retouchCount", "makeupIncluded", "tags", "intro", "shootingNotes"]) {
    assert.deepEqual(home.data.albums[0][key], detail.data.collections[0][key], key);
  }
  assert.deepEqual(home.data.albums[0].styleTags, ["自然"]);
  assert.equal(home.data.albums[0].spot, undefined, "cards do not repeat the full point payload");
  assert.deepEqual(rows, before, "public metadata never modifies stored products");
});

test("legacy album previews use linked photoIds, filter hidden images, and preserve explicit empty previews and point unlinking", async () => {
  const { source, reads } = fixture({
    albums: [
      { id: "legacy", name: "旧版照片", seriesId: "style", photoCount: 8, photoIds: ["linked-photo"], status: "上架" },
      { id: "cleared", name: "清空图片", seriesId: "style", sampleUrls: [], photoCount: 0, spotBindingExplicit: true, spotId: "", spotIds: [] }
    ],
    samples: [
      { id: "linked-photo", url: "https://images.test/linked.jpg", spotId: "a", createTime: "2026-11-02" },
      { id: "album-photo", albumId: "legacy", url: "https://images.test/album.jpg", spotId: "a", createTime: "2026-11-01" },
      { id: "hidden-photo", albumId: "legacy", url: "https://images.test/hidden.jpg", isShow: false },
      { id: "hidden-point-photo", albumId: "legacy", url: "https://images.test/hidden-point.jpg", spotId: "hidden-point" },
      { id: "album-video", albumId: "legacy", type: "video", url: "https://images.test/video.mp4" },
      { id: "cleared-photo", albumId: "cleared", url: "https://images.test/removed.jpg" }
    ]
  });
  const home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(home.success, true, JSON.stringify(home));
  assert.equal(reads.filter((read) => read.key === "samples").length, 1);
  const legacy = home.data.albums.find((album) => album.id === "legacy");
  assert.deepEqual(legacy.sampleUrls, ["https://images.test/linked.jpg", "https://images.test/album.jpg"]);
  assert.equal(legacy.cover, legacy.sampleUrls[0]);
  assert.equal(legacy.photoCount, 8, "preview length never replaces configured delivery count");
  const detail = await rpc(source, "getPhotoCollection", { albumId: "legacy" });
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.deepEqual(legacy.sampleUrls, detail.data.collections[0].sampleUrls);
  const cleared = home.data.albums.find((album) => album.id === "cleared");
  assert.deepEqual(cleared.sampleUrls, []);
  assert.equal(cleared.cover, "");
  assert.equal(cleared.spotId, "");
  assert.equal(cleared.spotBindingExplicit, true);
  assert.equal(cleared.photoCount, 0);
});

test("twenty home albums still read shared collections once and later requests see visibility and city changes", async () => {
  const albums = Array.from({ length: 20 }, (_, index) => ({ id: `photo-${index}`, name: `照片${index}`, seriesId: "style", sampleUrls: [`https://images.test/${index}.jpg`], photoCount: 6 }));
  const { source, rows, reads } = fixture({ albums });
  const home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(home.success, true, JSON.stringify(home));
  assert.equal(home.data.albums.length, 20);
  assert.equal(reads.filter((read) => read.key === "albums").length, 1, "album count cannot cause N+1 reads");
  assert.equal(reads.filter((read) => read.key === "series").length, 1);
  assert.equal(reads.some((read) => read.key === "samples"), false);
  rows.albums[0].sampleUrls = ["https://images.test/updated.jpg"];
  rows.albums[1].isShow = false;
  const changed = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(changed.data.albums.length, 19);
  assert.deepEqual(changed.data.albums.find((row) => row.id === "photo-0").sampleUrls, ["https://images.test/updated.jpg"]);
  assert.deepEqual((await rpc(source, "getHomeData", { cityId: "hz" })).data.albums, []);
  rows.spots[0].isShow = false;
  assert.deepEqual((await rpc(source, "getHomeData", { cityId: "cs" })).data.albums, []);
});

test("a standalone album and an album in a hidden style keep the detail metadata fallback", async () => {
  const { source } = fixture({
    series: [{ id: "hidden-style", name: "已隐藏风格", cover: "https://images.test/hidden-style.jpg", spotIds: ["hidden-point"], isShow: false }],
    albums: [{ id: "standalone", name: "独立照片", sampleUrls: [] },
      { id: "unlinked", name: "解绑照片", seriesId: "hidden-style", spotBindingExplicit: true, spotIds: [], spotId: "" }]
  });
  const home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(home.success, true, JSON.stringify(home));
  for (const album of home.data.albums) {
    const detail = await rpc(source, "getPhotoCollection", { albumId: album.id });
    assert.equal(detail.success, true, JSON.stringify(detail));
    for (const key of ["seriesName", "cover", "sampleUrls", "spotId", "spotName"]) assert.deepEqual(album[key], detail.data.collections[0][key], `${album.id}: ${key}`);
  }
  assert.ok(!JSON.stringify(home.data.albums).includes("hidden-style.jpg"));
});

test("global album previews keep globally available images without changing the selected-city shelves", async () => {
  const { source } = fixture({
    series: [{ id: "style", name: "杭州风格", cover: "https://images.test/hz-style.jpg", spotIds: ["b"] }],
    albums: [{ id: "global-photo", name: "通用照片", seriesId: "style", spotBindingExplicit: true, spotId: "", spotIds: [] }],
    samples: [{ id: "global-preview", albumId: "global-photo", spotId: "b", url: "https://images.test/global-preview.jpg" }]
  });
  const home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(home.success, true, JSON.stringify(home));
  assert.deepEqual(home.data.spots.map((spot) => spot._id), ["a"]);
  assert.deepEqual(home.data.series, []);
  assert.equal(home.data.albums[0].spotId, "");
  const detail = await rpc(source, "getPhotoCollection", { albumId: "global-photo" });
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.deepEqual(home.data.albums[0].sampleUrls, detail.data.collections[0].sampleUrls);
  assert.deepEqual(home.data.albums[0].sampleUrls, ["https://images.test/global-preview.jpg"]);
});
