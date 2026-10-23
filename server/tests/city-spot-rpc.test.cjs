"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");

function makeSource(overrides = {}) {
  const collections = {
    homeConfig: [{ id: "homeStats", recommendations: { hotSpotIds: ["spot-pending", "spot-active"] } }],
    config: [],
    cities: [
      { id: "city-changsha", name: "长沙", code: "cs", status: "运营中", visible: true, sort: 20, latitude: 28.195, longitude: 112.95, coordType: "gcj02" },
      { id: "city-yueyang", name: "岳阳", code: "yy", enabled: false, status: "停用", visible: true, sort: 10, latitude: 29.357, longitude: 113.129, coordType: "gcj02" },
      { id: "city-hidden", name: "隐藏城市", status: "运营中", visible: false }
    ],
    shops: [
      { id: "shop-cs", cityId: "city-changsha", visible: true },
      { id: "shop-yy", city: "岳阳", visible: true }
    ],
    spots: [
      {
        id: "spot-active", name: "橘子洲江景", cityId: "city-changsha", city: "旧名称",
        district: "岳麓区", latitude: 28.1863, longitude: 112.9498, coordType: "gcj02",
        tags: ["江景", "日落"], hotScore: 99, checkinCount: 312, sort: 3, isShow: true, status: "启用"
      },
      { id: "spot-legacy", name: "老街夜景", city: "长沙", hotScore: 70, isShow: true, status: "启用" },
      { id: "spot-pending", name: "岳阳楼", cityId: "city-yueyang", latitude: 29.357, longitude: 113.129, isShow: true, status: "启用" },
      { id: "spot-hidden-city", name: "不应展示", cityId: "city-hidden", isShow: true, status: "启用" },
      { id: "spot-unassigned", name: "未归属点位", isShow: true, status: "启用" },
      { id: "spot-offline", name: "下架点位", cityId: "city-changsha", isShow: false, status: "停用" }
    ],
    series: [
      { id: "series-active", name: "城市夜景", spotIds: ["spot-active"], isShow: true, status: "启用" },
      { id: "series-hidden", name: "隐藏风格", spotIds: ["spot-active"], isShow: false, status: "停用" },
      { id: "series-pending", name: "岳阳风格", spotIds: ["spot-pending"], isShow: true, status: "启用" }
    ],
    albums: [
      { id: "album-active", name: "公开照片", seriesId: "series-active", isShow: true, status: "上架" },
      { id: "album-pending", name: "筹备照片", seriesId: "series-pending", isShow: true, status: "上架" }
    ],
    samples: [],
    packages: [
      { id: "package-active", name: "公开套餐", spotId: "spot-active", isShow: true, status: "上架" },
      { id: "package-pending", name: "筹备套餐", spotId: "spot-pending", isShow: true, status: "上架" },
      { id: "package-inherit-pending", name: "继承筹备系列的套餐", seriesId: "series-pending", isShow: true, status: "上架" },
      { id: "package-global", name: "全城套餐", isShow: true, status: "上架" }
    ],
    peripherals: [
      { id: "peripheral-pending", name: "筹备点位周边", spotId: "spot-pending", isShow: true, status: "上架" },
      { id: "peripheral-global", name: "全城周边", isShow: true, status: "上架" }
    ],
    guides: [
      { id: "guide-multi", name: "多点攻略", spotIds: ["spot-active", "spot-pending"], isShow: true, status: "启用" },
      { id: "guide-pending", name: "筹备攻略", spotId: "spot-pending", isShow: true, status: "启用" },
      { id: "guide-inherit-pending", name: "继承筹备系列的攻略", seriesId: "series-pending", isShow: true, status: "启用" }
    ]
  };

  Object.assign(collections, overrides);

  const rows = (key) => collections[key] || [];
  return {
    async list(key) { return rows(key).map((item) => ({ ...item, spotIds: Array.isArray(item.spotIds) ? item.spotIds.slice() : item.spotIds })); },
    async get(key, id) { return rows(key).find((item) => String(item.id || item._id) === String(id)) || null; }
  };
}

test("城市和打卡点公共 RPC 按后台城市配置投影", async () => {
  const source = makeSource();

  const cities = await rpc(source, "getCities", { data: {} });
  assert.equal(cities.success, true);
  assert.deepEqual(cities.data.map((item) => item._id), ["city-changsha"]);
  assert.equal(cities.data[0].enabled, true);
  assert.equal(cities.data[0].spotCount, 2);
  assert.equal(cities.data.some((item) => item._id === "city-yueyang"), false);
  assert.equal(cities.data[0].shopsCount, 1);
  assert.equal(cities.data.some((item) => item._id === "city-hidden"), false);

  const spots = await rpc(source, "getSpots", { data: {} });
  assert.equal(spots.success, true);
  assert.deepEqual(spots.data.map((item) => item._id), ["spot-active", "spot-legacy"]);
  const active = spots.data.find((item) => item._id === "spot-active");
  assert.deepEqual(
    {
      cityId: active.cityId,
      city: active.city,
      district: active.district,
      latitude: active.latitude,
      longitude: active.longitude,
      coordType: active.coordType,
      seriesCount: active.seriesCount,
      checkinCount: active.checkinCount,
      visitCount: active.visitCount
    },
    {
      cityId: "city-changsha",
      city: "长沙",
      district: "岳麓区",
      latitude: 28.1863,
      longitude: 112.9498,
      coordType: "gcj02",
      seriesCount: 1,
      checkinCount: 312,
      visitCount: 312
    }
  );

  const byCity = await rpc(source, "getSpots", { data: { cityId: "city-changsha" } });
  assert.deepEqual(byCity.data.map((item) => item._id), ["spot-active", "spot-legacy"]);
  const pending = await rpc(source, "getSpots", { data: { cityId: "city-yueyang" } });
  assert.deepEqual(pending.data, []);

  const home = await rpc(source, "getHomeData", { data: {} });
  assert.equal(home.success, true);
  assert.deepEqual(home.data.spots.map((item) => item._id), ["spot-active", "spot-legacy"]);
  assert.deepEqual(home.data.packages.map((item) => item._id).sort(), ["package-active", "package-global"]);
  assert.deepEqual(home.data.albums.map((item) => item._id), ["album-active"]);
  assert.deepEqual(home.data.peripherals.map((item) => item._id), ["peripheral-global"]);
  assert.deepEqual(home.data.guides.map((item) => item._id), ["guide-multi"]);
  assert.deepEqual(home.data.guides[0].spotIds, ["spot-active"]);

  const cityHome = await rpc(source, "getHomeData", { data: { cityId: "city-changsha" } });
  assert.equal(cityHome.success, true);
  assert.equal(cityHome.data.cityId, "city-changsha");
  assert.equal(cityHome.data.city, "长沙");
  assert.deepEqual(cityHome.data.spots.map((item) => item._id), ["spot-active", "spot-legacy"]);
  assert.deepEqual(cityHome.data.packages.map((item) => item._id).sort(), ["package-active", "package-global"]);

  const pendingHome = await rpc(source, "getHomeData", { data: { city: "岳阳" } });
  assert.equal(pendingHome.success, true);
  assert.deepEqual(pendingHome.data.spots, []);

  const booking = await rpc(source, "getBookingData", { data: {} });
  assert.equal(booking.success, true);
  assert.deepEqual(booking.data.spots.map((item) => item._id), ["spot-active", "spot-legacy"]);
  assert.deepEqual(booking.data.allPackages.map((item) => item._id).sort(), ["package-active", "package-global"]);
  assert.deepEqual(booking.data.albums.map((item) => item._id), ["album-active"]);

  const activeGuides = await rpc(source, "getGuides", { data: { spotId: "spot-active" } });
  assert.deepEqual(activeGuides.data.map((item) => item._id), ["guide-multi"]);
  assert.deepEqual(activeGuides.data[0].spotIds, ["spot-active"]);
  assert.equal(activeGuides.data[0].id, "guide-multi");
  const pendingGuide = await rpc(source, "getGuide", { data: { id: "guide-pending" } });
  assert.equal(pendingGuide.success, false);

  const pendingSeries = await rpc(source, "getSeriesDetail", { data: { seriesId: "series-pending" } });
  assert.equal(pendingSeries.success, false);
  const pendingCollection = await rpc(source, "getPhotoCollection", { data: { seriesId: "series-pending" } });
  assert.equal(pendingCollection.success, false);
  const pendingPackage = await rpc(source, "getSeriesDetail", { data: { packageId: "package-inherit-pending" } });
  assert.equal(pendingPackage.success, false);
});

test("城市 enabled 兼容旧 JSON/MySQL 的显式 false 值", async () => {
  for (const enabled of [false, 0, "0", "false"]) {
    const source = makeSource({
      cities: [
        { id: "city-active", name: "长沙", code: "cs", status: "启用", enabled: true, visible: true },
        { id: "city-disabled", name: "停用城市", code: "off", status: "启用", enabled, visible: true }
      ]
    });
    const result = await rpc(source, "getCities", { data: {} });
    assert.equal(result.success, true);
    assert.deepEqual(result.data.map((item) => item._id), ["city-active"]);
  }
});

test("首页热榜按后台热榜排序展示公开点位并限制前五名", async () => {
  const source = makeSource({
    spots: [
      { id: "hot-5", name: "第五名", cityId: "city-changsha", sort: 5, isShow: true, status: "启用" },
      { id: "hot-3-z", name: "乙点位", cityId: "city-changsha", sort: 3, hotScore: 999, isShow: true, status: "启用" },
      { id: "hot-2", name: "第二名", cityId: "city-changsha", sort: 2, isShow: true, status: "启用" },
      { id: "hot-3-a", name: "甲点位", cityId: "city-changsha", sort: 3, hotScore: 1, isShow: true, status: "启用" },
      { id: "hot-1", name: "第一名", cityId: "city-changsha", sort: 1, isShow: true, status: "启用" },
      { id: "hot-6", name: "第六名", cityId: "city-changsha", sort: 6, isShow: true, status: "启用" },
      { id: "hot-hidden", name: "隐藏点位", cityId: "city-changsha", sort: 0, isShow: false, status: "停用" },
      { id: "hot-yueyang", name: "其他城市", cityId: "city-yueyang", sort: 1, isShow: true, status: "启用" }
    ]
  });

  const home = await rpc(source, "getHomeData", { data: { cityId: "city-changsha" } });
  assert.equal(home.success, true);
  assert.deepEqual(home.data.hotSpots.map((item) => item._id), ["hot-1", "hot-2", "hot-3-a", "hot-3-z", "hot-5"]);
  assert.equal(home.data.hotSpots.length, 5);
  assert.equal(home.data.hotSpots[0].sort, 1);
  assert.equal(home.data.hotSpots[2].name, "甲点位");
});

test("首页热榜将未配置或非正数排序的公开点位放在末尾", async () => {
  const source = makeSource({
    spots: [
      { id: "hot-unset", name: "未配置", cityId: "city-changsha", isShow: true, status: "启用" },
      { id: "hot-negative", name: "负数", cityId: "city-changsha", sort: -1, isShow: true, status: "启用" },
      { id: "hot-positive", name: "已配置", cityId: "city-changsha", sort: 8, isShow: true, status: "启用" }
    ]
  });

  const home = await rpc(source, "getHomeData", { data: { cityId: "city-changsha" } });
  assert.equal(home.success, true);
  assert.deepEqual(home.data.hotSpots.map((item) => item._id), ["hot-positive", "hot-negative", "hot-unset"]);
});
