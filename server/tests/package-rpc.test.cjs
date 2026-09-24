"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");

function makeSource() {
  const collections = {
    homeConfig: [{ id: "homeStats", recommendations: { hotPackageIds: ["pkg-main"] } }],
    config: [],
    siteConfig: [],
    spots: [
      { id: "spot-1", name: "江边", isShow: true, status: "启用" },
      { id: "spot-2", name: "老街", isShow: true, status: "启用" }
    ],
    series: [
      { id: "series-1", name: "夜景", spotIds: ["spot-1", "spot-2"], isShow: true, status: "启用" },
      { id: "series-2", name: "其它系列", spotIds: ["spot-2"], isShow: true, status: "启用" }
    ],
    albums: [{ id: "album-1", name: "夜景照片留影", seriesId: "series-1", spotId: "spot-1", price: 399, isShow: true, status: "上架" }],
    peripherals: [{ id: "peripheral-1", name: "定制相册", price: 99, isShow: true, status: "上架" }],
    samples: [],
    guides: [],
    packages: [
      {
        id: "pkg-main", name: "城市夜景套餐", type: "photo", price: 699, originalPrice: 999,
        isMainPush: true, isShow: true, status: "上架", spotIds: ["spot-1"], seriesId: "series-1",
        albumId: "album-1", intro: "含妆造建议与夜景拍摄服务", serviceTags: ["拍摄60分钟", "精修12张"]
      },
      {
        id: "pkg-multi", name: "双点漫游套餐", type: "photo", price: 899, originalPrice: 1099,
        isHot: true, isShow: true, status: "上架", spotIds: ["spot-1", "spot-2"], seriesId: "series-1",
        includedItems: [{ type: "peripheral", name: "定制相册", peripheralId: "peripheral-1", price: 0 }]
      },
      {
        id: "pkg-global-promoted", name: "全局主推套餐", type: "photo", price: 599,
        isMainPush: true, isShow: true, status: "上架"
      },
      {
        id: "pkg-other-series-promoted", name: "其它系列热门套餐", type: "photo", price: 799,
        isHot: true, isShow: true, status: "上架", spotIds: ["spot-2"], seriesId: "series-2"
      },
      { id: "pkg-hidden", name: "下架套餐", type: "photo", price: 1, isShow: false, status: "下架" },
      { id: "video-1", name: "夜景短片", type: "video", productKind: "video_single", price: 299, isShow: true, status: "上架", spotId: "spot-1" }
    ]
  };
  const rows = (key) => collections[key] || [];
  return {
    async list(key) { return rows(key).map((item) => ({ ...item })); },
    async get(key, id) { return rows(key).find((item) => String(item.id || item._id) === String(id)) || null; }
  };
}

test("套餐公共 RPC 投影统一主推、详情和多点位字段", async () => {
  const source = makeSource();

  const home = await rpc(source, "getHomeData", { data: {} });
  assert.equal(home.success, true);
  assert.equal(home.data.hotPackages[0]._id, "pkg-main");
  assert.ok(home.data.hotPackages.some((item) => item._id === "pkg-multi"));
  assert.equal(home.data.packages.some((item) => item._id === "pkg-hidden"), false);
  const main = home.data.packages.find((item) => item._id === "pkg-main");
  assert.equal(main.description, "含妆造建议与夜景拍摄服务");
  assert.equal(main.intro, main.description);
  assert.equal(main.duration, 60);
  assert.equal(main.retouchCount, 12);
  assert.equal(main.includedItems[0].target.albumId, "album-1");

  const detail = await rpc(source, "getSeriesDetail", { data: { seriesId: "series-1", packageId: "pkg-multi", spotId: "spot-2" } });
  assert.equal(detail.success, true);
  assert.equal(detail.data.currentPackage._id, "pkg-multi");
  assert.equal(detail.data.currentPackage.includedItems[0].target.peripheralId, "peripheral-1");
  assert.equal(detail.data.currentPackage.includedItems[0].target.id, "peripheral-1");
  assert.ok(detail.data.spotPackages.some((item) => item._id === "pkg-multi"));
  assert.equal(detail.data.mainPushPackages.some((item) => item._id === "pkg-global-promoted"), false);
  assert.equal(detail.data.spotPackages.some((item) => item._id === "pkg-other-series-promoted"), false);

  const collection = await rpc(source, "getPhotoCollection", { data: { seriesId: "series-1", spotId: "spot-2" } });
  assert.equal(collection.success, true);
  assert.ok(collection.data.featuredPackages.some((item) => item._id === "pkg-main"));
  assert.ok(collection.data.spotPackages.some((item) => item._id === "pkg-multi"));
  assert.equal(collection.data.featuredPackages.some((item) => item._id === "pkg-global-promoted"), false);
  assert.equal(collection.data.featuredPackages.some((item) => item._id === "pkg-other-series-promoted"), false);
  assert.equal(collection.data.spotPackages.some((item) => item._id === "pkg-other-series-promoted"), false);

  const missingDetail = await rpc(source, "getSeriesDetail", { data: { seriesId: "series-1", packageId: "pkg-missing", spotId: "spot-1" } });
  assert.deepEqual(missingDetail, { success: false, error: "套餐不存在" });
});

test("photo and image sample labels both remain visible in photo package details", async () => {
  const source = makeSource();
  const list = source.list.bind(source);
  source.list = async (key) => key === "samples" ? [
    { id: "uploaded-photo", seriesId: "series-1", albumId: "album-1", spotId: "spot-1", type: "photo", url: "/api/media/file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", isShow: true },
    { id: "legacy-image", seriesId: "series-1", albumId: "album-1", spotId: "spot-1", type: "image", url: "https://images.invalid/legacy.png", isShow: true },
    { id: "video-sample", seriesId: "series-1", albumId: "album-1", spotId: "spot-1", type: "video", url: "https://images.invalid/video.mp4", isShow: true },
  ] : list(key);
  const detail = await rpc(source, "getSeriesDetail", { data: { seriesId: "series-1", packageId: "pkg-main", spotId: "spot-1" } });
  assert.equal(detail.success, true);
  assert.deepEqual(detail.data.photos.map((photo) => photo.id || photo._id).sort(), ["legacy-image", "uploaded-photo"]);
});
