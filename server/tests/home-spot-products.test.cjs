"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");

function fixture(overrides = {}) {
  const rows = {
    cities: [{ id: "cs", name: "长沙", status: "运营中" }, { id: "hz", name: "杭州", status: "运营中" },
      { id: "off-city", name: "停用城市", enabled: false }],
    spots: [{ id: "a", name: "第一点", cityId: "cs", sort: 1 }, { id: "b", name: "第二点", cityId: "cs", sort: 2 },
      { id: "other-city", name: "杭州点", cityId: "hz" }, { id: "hidden", cityId: "cs", isShow: false }, { id: "off-point", cityId: "off-city" }],
    homeConfig: [{ id: "homeStats", bannerConfigVersion: 1, banners: [] }],
    series: [{ id: "style-a", name: "第一风格", spotIds: ["a"] }, { id: "style-b", name: "第二风格", spotIds: ["b"] }],
    albums: [{ id: "photo-a", seriesId: "style-a", sampleUrls: ["https://images.test/a.jpg"], photoCount: 6 },
      { id: "photo-b", seriesId: "style-b", sampleUrls: ["https://images.test/b.jpg"], photoCount: 8 }],
    packages: [{ id: "package-a", name: "第一套餐", spotId: "a", productKind: "package" },
      { id: "package-b", name: "第二套餐", spotId: "b", productKind: "package" },
      { id: "video-b", name: "第二视频", spotId: "b", productKind: "video_single", type: "video", videoUrl: "https://images.test/b.mp4" }],
    peripherals: [{ id: "gift-b", name: "影像周边", spotId: "b", status: "上架" }],
    samples: [], guides: [],
    ...overrides
  };
  const reads = [];
  return { rows, reads, source: {
    async list(key) { reads.push({ method: "list", key }); return structuredClone(rows[key] || []); },
    async get(key, id) { reads.push({ method: "get", key }); return structuredClone((rows[key] || []).find((row) => String(row.id) === String(id)) || null); }
  } };
}

const ids = (rows) => rows.map((row) => row.id).sort();
function assertEmpty(products) {
  assert.equal(products.spotId, "");
  for (const key of ["series", "albums", "packages", "videoSingles", "peripherals"]) assert.deepEqual(products[key], [], key);
}

test("initial home includes first ranking point products and accepts an existing selected point on refresh", async () => {
  const { source, reads } = fixture();
  const first = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.data.spotProductsAvailable, true);
  assert.equal(first.data.spotProducts.spotId, "a");
  assert.deepEqual(ids(first.data.spotProducts.albums), ["photo-a"]);
  const refreshed = await rpc(source, "getHomeData", { cityId: "cs", spotId: "b" });
  assert.equal(refreshed.data.spotProducts.spotId, "b");
  assert.deepEqual(ids(refreshed.data.spotProducts.series), ["style-b"]);
  assert.deepEqual(ids(refreshed.data.spotProducts.albums), ["photo-b"]);
  assert.deepEqual(ids(refreshed.data.spotProducts.packages), ["package-b"]);
  assert.deepEqual(ids(refreshed.data.spotProducts.videoSingles), ["video-b"]);
  assert.deepEqual(ids(refreshed.data.spotProducts.peripherals), ["gift-b"]);
  assert.equal(refreshed.data.spotProducts.albumMetadataComplete, true);
  assert.equal(refreshed.data.spotProducts.albums[0].photoCount, 8);
  assert.equal(refreshed.data.spotProducts.albums[0].spotName, "第二点");
  // Two separate requests see fresh data, but neither repeats the underlying
  // list query while building recommendations, visibility and point shelves.
  for (const key of ["cities", "spots", "series", "albums", "packages", "peripherals"]) {
    assert.equal(reads.filter((read) => read.method === "list" && read.key === key).length, 2, key);
  }
});

test("point shelves include newly uploaded products beyond all global recommendation limits without truncating the selected point", async () => {
  const { source, rows, reads } = fixture();
  rows.albums = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `a-photo-${i}`, spotId: "a", sampleUrls: [] })),
    ...Array.from({ length: 25 }, (_, i) => ({ id: `b-photo-${i}`, spotId: "b", sampleUrls: [], photoCount: 6 }))
  ];
  rows.packages = [
    ...Array.from({ length: 130 }, (_, i) => ({ id: `a-video-${i}`, spotId: "a", productKind: "video_single", type: "video", hotScore: 1000 - i })),
    ...Array.from({ length: 55 }, (_, i) => ({ id: `b-video-${i}`, spotId: "b", productKind: "video_single", type: "video", hotScore: 1 })),
    ...Array.from({ length: 25 }, (_, i) => ({ id: `b-package-${i}`, spotId: "b", productKind: "package", hotScore: 0 }))
  ];
  rows.peripherals = [
    ...Array.from({ length: 25 }, (_, i) => ({ id: `a-gift-${i}`, spotId: "a" })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `b-gift-${i}`, name: "最新影像周边", spotId: "b" }))
  ];
  const home = await rpc(source, "getHomeData", { cityId: "cs", spotId: "b" });
  assert.equal(home.success, true, JSON.stringify(home));
  assert.equal(home.data.albums.some((row) => row.spotId === "b"), false, "global featured window remains bounded");
  assert.equal(home.data.packages.some((row) => row.spotId === "b"), false);
  assert.equal(home.data.peripherals.some((row) => row.spotId === "b"), false);
  for (const [key, count] of [["albums", 25], ["videoSingles", 55], ["packages", 25], ["peripherals", 12]]) {
    assert.equal(home.data.spotProducts[key].length, count, key);
    assert.ok(home.data.spotProducts[key].every((row) => row.spotId === "b"), key);
  }
  reads.length = 0;
  const only = await rpc(source, "getHomeData", { cityId: "cs", spotId: "b", spotProductsOnly: true });
  assert.deepEqual(only.data.spotProducts, home.data.spotProducts);
  assert.deepEqual(Object.keys(only.data).sort(), ["city", "cityId", "spotProducts", "spotProductsAvailable"]);
  assert.equal(reads.some((read) => ["homeConfig", "config", "shops", "samples"].includes(read.key)), false, "point refresh does not reread unrelated decoration or photos");
  for (const key of ["cities", "spots", "series", "albums", "packages", "peripherals"]) {
    assert.equal(reads.filter((read) => read.method === "list" && read.key === key).length, 1, key);
  }
});

test("global, explicit-unbound and multi-point products stay available while hidden or other-city inventory cannot leak", async () => {
  const { source, rows } = fixture();
  rows.albums.push(
    { id: "global", sampleUrls: [] },
    { id: "unbound", seriesId: "style-a", spotBindingExplicit: true, spotId: "", spotIds: [], sampleUrls: [] },
    { id: "multi", spotIds: ["a", "b"], sampleUrls: [] },
    { id: "other", spotId: "other-city", sampleUrls: [] },
    { id: "hidden-photo", spotId: "b", isShow: false },
    { id: "hidden-point-photo", spotId: "hidden" }
  );
  rows.packages.push({ id: "global-package", productKind: "package" }, { id: "hidden-package", spotId: "b", isShow: false },
    { id: "mixed-hidden", includedItems: [{ type: "album", albumId: "hidden-photo" }] });
  rows.peripherals.push({ id: "unbound-gift", seriesId: "style-a", spotBindingExplicit: true, spotId: "", stock: 99, productCode: "INTERNAL-CODE", internalNote: "PRIVATE" },
    { id: "citywide-gift", spotId: "a", mode: "全城通用" },
    { id: "hidden-citywide-gift", spotId: "hidden", mode: "全城通用" },
    { id: "rejected-gift", spotId: "b", auditStatus: "rejected" }, { id: "other-city-gift", spotId: "other-city", mode: "全城通用" });
  const result = await rpc(source, "getHomeData", { cityId: "cs", spotId: "b", spotProductsOnly: true });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(ids(result.data.spotProducts.albums), ["global", "multi", "photo-b", "unbound"]);
  assert.deepEqual(ids(result.data.spotProducts.packages), ["global-package", "package-b"]);
  assert.deepEqual(ids(result.data.spotProducts.peripherals), ["citywide-gift", "gift-b", "unbound-gift"]);
  assert.equal(result.data.spotProducts.albums.find((row) => row.id === "unbound").spotId, "");
  assert.ok(!JSON.stringify(result).includes("INTERNAL-CODE"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(result.data.spotProducts.peripherals.find((row) => row.id === "unbound-gift").stock, undefined);
});

test("hidden, invalid, disabled-city and cross-city point requests return empty shelves without falling back", async () => {
  const { source } = fixture();
  for (const spotId of ["hidden", "missing", "other-city", "off-point"]) {
    for (const spotProductsOnly of [true, false]) {
      const result = await rpc(source, "getHomeData", { cityId: "cs", spotId, spotProductsOnly });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.spotProductsAvailable, true);
      assertEmpty(result.data.spotProducts);
    }
  }
  const noId = await rpc(source, "getHomeData", { cityId: "cs", spotProductsOnly: true });
  assertEmpty(noId.data.spotProducts);
});

test("point refresh sees new uploads and publishing changes immediately without retaining stale shelves", async () => {
  const { source, rows } = fixture();
  const request = { cityId: "cs", spotId: "b", spotProductsOnly: true };
  assert.deepEqual(ids((await rpc(source, "getHomeData", request)).data.spotProducts.peripherals), ["gift-b"]);
  rows.peripherals.push({ id: "new-gift", spotId: "b", status: "上架" });
  rows.peripherals[0].isShow = false;
  assert.deepEqual(ids((await rpc(source, "getHomeData", request)).data.spotProducts.peripherals), ["new-gift"]);
  rows.spots.find((row) => row.id === "b").isShow = false;
  assertEmpty((await rpc(source, "getHomeData", request)).data.spotProducts);
});

test("overlapping point-only flags cannot skip public product dependency visibility", async () => {
  const { source, rows } = fixture();
  rows.albums.push({ id: "private-photo", spotId: "b", isShow: false, sampleUrls: [] });
  rows.packages.push({ id: "invalid-bundle", spotId: "b", productKind: "package", includedItems: [{ type: "album", albumId: "private-photo" }] });
  const request = { cityId: "cs", spotId: "b", spotProductsOnly: true };
  const normal = await rpc(source, "getHomeData", request);
  const overlapping = await rpc(source, "getHomeData", { ...request, spotsOnly: true });
  assert.equal(overlapping.success, true);
  assert.deepEqual(overlapping.data.spotProducts, normal.data.spotProducts);
  assert.equal(overlapping.data.spotProducts.packages.some((row) => row.id === "invalid-bundle"), false);
  assert.equal(overlapping.data.spotProducts.albums.some((row) => row.id === "private-photo"), false);
});

test("home can omit point catalogues without reading legacy point previews outside the search window", async () => {
  const { source, rows, reads } = fixture();
  rows.albums = [
    ...Array.from({ length: 20 }, (_, index) => ({ id: `search-photo-${index}`, sort: index + 1, spotId: "b", sampleUrls: [], photoCount: 6 })),
    { id: "legacy-point-photo", spotId: "a", photoCount: 9 }
  ];
  rows.samples = [{ id: "legacy-preview", albumId: "legacy-point-photo", spotId: "a", url: "https://images.test/legacy-point.jpg" }];
  const ranking = await rpc(source, "getHomeData", { cityId: "cs", includeSpotProducts: false });
  assert.equal(ranking.success, true, JSON.stringify(ranking));
  assert.equal(Object.hasOwn(ranking.data, "spotProductsAvailable"), false);
  assert.equal(Object.hasOwn(ranking.data, "spotProducts"), false);
  assert.deepEqual(ranking.data.spots.map((row) => row.id), ["a", "b"]);
  assert.equal(ranking.data.albums.length, 20, "bounded search catalogue is preserved");
  assert.equal(ranking.data.albumMetadataComplete, true);
  assert.equal(ranking.data.albums[0].photoCount, 6);
  assert.equal(reads.some((read) => read.key === "samples"), false, "omitted point catalogue cannot trigger legacy preview queries");
  for (const key of ["cities", "spots", "series", "albums", "packages", "peripherals"]) {
    assert.equal(reads.filter((read) => read.method === "list" && read.key === key).length, 1, key);
  }
  reads.length = 0;
  const compatible = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(compatible.data.spotProductsAvailable, true, "older clients retain the default embedded catalogue");
  assert.equal(compatible.data.spotProducts.spotId, "a");
  assert.deepEqual(ids(compatible.data.spotProducts.albums), ["legacy-point-photo"]);
  assert.deepEqual(compatible.data.spotProducts.albums[0].sampleUrls, ["https://images.test/legacy-point.jpg"]);
  assert.equal(reads.filter((read) => read.key === "samples").length, 1);
});

test("explicit point-only calls keep working when the embedded point catalogue is disabled", async () => {
  const { source } = fixture();
  const only = await rpc(source, "getHomeData", { cityId: "cs", spotId: "b", spotProductsOnly: true, includeSpotProducts: false });
  assert.equal(only.success, true, JSON.stringify(only));
  assert.equal(only.data.spotProductsAvailable, true);
  assert.equal(only.data.spotProducts.spotId, "b");
  assert.deepEqual(ids(only.data.spotProducts.albums), ["photo-b"]);
  assert.deepEqual(ids(only.data.spotProducts.peripherals), ["gift-b"]);
});

test("public video catalogues preserve configured tags independently of empty or stale service tags", async () => {
  const cases = [
    { id: "new-tags", tags: ["测试爆款", "电影感"], serviceTags: [], expectedTags: ["测试爆款", "电影感"], expectedServiceTags: [] },
    { id: "stale-services", tags: ["测试爆款"], serviceTags: ["旧服务标签"], expectedTags: ["测试爆款"], expectedServiceTags: ["旧服务标签"] },
    { id: "cleared-tags", tags: [], serviceTags: ["旧服务标签"], expectedTags: [], expectedServiceTags: ["旧服务标签"] },
    { id: "legacy-tags-only", tags: ["测试爆款"], expectedTags: ["测试爆款"], expectedServiceTags: ["测试爆款"] },
    { id: "legacy-services", serviceTags: ["旧记录标签"], expectedTags: ["旧记录标签"], expectedServiceTags: ["旧记录标签"] },
    { id: "string-tags", tags: " 测试爆款，电影感|测试爆款 ", serviceTags: " 独立服务，独立服务 ", expectedTags: ["测试爆款", "电影感"], expectedServiceTags: ["独立服务"] }
  ];
  const { source } = fixture({ packages: cases.map(({ expectedTags, expectedServiceTags, ...row }) => ({
    ...row, name: row.id, spotId: "b", type: "video", productKind: "video_single",
    videoUrl: `https://images.test/${row.id}.mp4`, isMainPush: true
  })) });
  const [home, point, videos, booking] = await Promise.all([
    rpc(source, "getHomeData", { cityId: "cs", spotId: "b" }),
    rpc(source, "getHomeData", { cityId: "cs", spotId: "b", spotProductsOnly: true }),
    rpc(source, "getVideoSingles", { spotId: "b" }),
    rpc(source, "getBookingData", {})
  ]);
  for (const result of [home, point, videos, booking]) assert.equal(result.success, true, JSON.stringify(result));
  const catalogues = [home.data.videoSingles, home.data.spotProducts.videoSingles,
    point.data.spotProducts.videoSingles, videos.data, booking.data.allPackages];
  for (const catalogue of catalogues) {
    for (const expected of cases) {
      const product = catalogue.find(row => row.id === expected.id);
      assert.ok(product, expected.id);
      assert.deepEqual(product.tags, expected.expectedTags, `${expected.id}: configured tags must not be replaced by serviceTags`);
      assert.deepEqual(product.serviceTags, expected.expectedServiceTags, `${expected.id}: service tags retain their own content`);
    }
  }
});

test("separating configured tags preserves photo package service descriptions and derived quantities", async () => {
  const { source } = fixture({ packages: [{ id: "photo-package", name: "胶片套餐", spotId: "b", seriesId: "style-b",
    type: "photo", productKind: "package", tags: ["胶片"], serviceTags: ["拍摄60分钟", "精修12张"] }] });
  const [home, booking, detail] = await Promise.all([
    rpc(source, "getHomeData", { cityId: "cs", spotId: "b" }),
    rpc(source, "getBookingData", {}),
    rpc(source, "getSeriesDetail", { packageId: "photo-package", seriesId: "style-b", spotId: "b" })
  ]);
  for (const result of [home, booking, detail]) assert.equal(result.success, true, JSON.stringify(result));
  for (const product of [home.data.packages[0], home.data.spotProducts.packages[0], booking.data.allPackages[0], detail.data.currentPackage]) {
    assert.deepEqual(product.tags, ["胶片"]);
    assert.deepEqual(product.serviceTags, ["拍摄60分钟", "精修12张"]);
    assert.equal(product.duration, 60);
    assert.equal(product.retouchCount, 12);
  }
});
