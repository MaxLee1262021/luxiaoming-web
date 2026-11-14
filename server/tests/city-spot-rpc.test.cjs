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
      { id: "peripheral-global", name: "全城周边", isShow: true, status: "上架", storeProductId: "store-global" },
      { id: "peripheral-unlinked", name: "未绑定小店周边", isShow: true, status: "上架" },
      { id: "peripheral-offline", name: "下架周边", isShow: true, status: "下架", storeProductId: "store-offline" },
      { id: "peripheral-hidden", name: "隐藏周边", isShow: false, status: "上架" },
      { id: "peripheral-deleted", name: "删除周边", isShow: true, status: "上架", deleted: true },
      { id: "peripheral-is-deleted", name: "回收周边", isShow: true, status: "上架", isDeleted: true }
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
  assert.deepEqual(home.data.peripherals.map((item) => item._id), ["peripheral-global", "peripheral-unlinked"]);
  const peripherals = await rpc(source, "getPeripherals", { data: {} });
  assert.equal(peripherals.success, true);
  assert.deepEqual(peripherals.data.map((item) => item._id), ["peripheral-global", "peripheral-unlinked"]);
  assert.equal(peripherals.data[0].storeProductId, "store-global");
  assert.deepEqual(home.data.guides, [], "关联点位未开放时整篇灵感隐藏");

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
  assert.deepEqual(booking.data.allPeripherals.map((item) => item._id), ["peripheral-global", "peripheral-unlinked"]);

  const activeGuides = await rpc(source, "getGuides", { data: { spotId: "spot-active" } });
  assert.deepEqual(activeGuides.data, []);
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

test("公开城市按创建时间正序返回，同时间按 ID 稳定排序并兼容时间格式", async () => {
  const cities = [
    { id: "cities1793432401916", name: "重庆", status: "启用", sort: -10, isDefault: true, createdAt: "2026-10-31T07:40:02.874Z" },
    { _id: "cities1793432417145", name: "成都", enabled: true, sort: -20, default: true, createTime: 1793432418.137 },
    { id: "city1", name: "长沙", status: "运营中", sort: 99, createdAt: new Date("2026-09-09T08:41:16.801Z") },
    { id: "city-tie-b", name: "同时间乙", enabled: true, createdAt: "2026-10-01T08:00:00+08:00" },
    { id: "city-tie-a", name: "同时间甲", enabled: true, createdAt: "1790812800000" },
    { id: "city0", name: "停用城市", status: "停用", enabled: true, createdAt: "2020-01-01" },
    { id: "city00", name: "隐藏城市", enabled: true, visible: false, createdAt: "2020-01-01" },
    { id: "city000", name: "已删除城市", enabled: true, deleted: true, createdAt: "2020-01-01" }
  ];
  for (const input of [cities, cities.slice().reverse()]) {
    const result = await rpc(makeSource({ cities: input }), "getCities", {});
    assert.equal(result.success, true);
    assert.deepEqual(result.data.map((row) => row._id), ["city1", "city-tie-a", "city-tie-b", "cities1793432401916", "cities1793432417145"]);
    assert.equal(result.data[0].name, "长沙");
  }
});

test("无创建时间的遗留城市优先，同为无时间时按 ID 稳定兜底", async () => {
  const cities = [
    { id: "new-city", name: "新城市", enabled: true, createdAt: "2026-10-31" },
    { id: "old-b", name: "旧城市乙", enabled: true, createdAt: "invalid" },
    { id: "old-a", name: "旧城市甲", enabled: true }
  ];
  for (const input of [cities, cities.slice().reverse()]) {
    const result = await rpc(makeSource({ cities: input }), "getCities", {});
    assert.deepEqual(result.data.map((row) => row._id), ["old-a", "old-b", "new-city"]);
    const home = await rpc(makeSource({ cities: input }), "getHomeData", {});
    assert.equal(home.data.cityId, "old-a");
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

function homeSpots(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `spot-${String(index + 1).padStart(3, "0")}`,
    name: `点位${String(index + 1).padStart(3, "0")}`,
    cityId: "city-changsha", hotScore: count - index, sort: index + 1, isShow: true, status: "启用",
    ...overrides
  }));
}

test("首页热榜首次返回 20 条，后续每页追加直至耗尽，支持超过 100 个点位", async (t) => {
  for (const total of [0, 7, 20, 65, 125]) {
    await t.test(`${total} 个公开点位`, async () => {
      const rows = homeSpots(total);
      const source = makeSource({ spots: rows.slice().reverse() });
      const first = await rpc(source, "getHomeData", { data: {} });
      assert.equal(first.success, true);
      assert.deepEqual(first.data.spots.map((spot) => spot._id), rows.slice(0, 20).map((spot) => spot.id));
      assert.deepEqual(first.data.spotPagination, {
        offset: 0, limit: 20, nextOffset: Math.min(total, 20), hasMore: total > 20, total
      });
      assert.equal(first.data.hotSpots.length, Math.min(total, 5));
      assert.ok(Array.isArray(first.data.packages));

      const ids = first.data.spots.map((spot) => spot._id);
      let pagination = first.data.spotPagination;
      while (pagination.hasMore) {
        const page = await rpc(source, "getHomeData", { data: {
          spotsOnly: true, spotOffset: pagination.nextOffset, spotLimit: 20
        } });
        assert.equal(page.success, true);
        assert.deepEqual(Object.keys(page.data).sort(), ["spotPagination", "spots"]);
        assert.deepEqual(page.spotPagination, undefined);
        assert.deepEqual(page.data.spots.map((spot) => spot._id), rows.slice(ids.length, ids.length + 20).map((spot) => spot.id));
        assert.equal(page.data.spotPagination.offset, ids.length);
        assert.equal(page.data.spotPagination.nextOffset, ids.length + page.data.spots.length);
        assert.equal(page.data.spotPagination.total, total);
        assert.ok(page.data.spots.length > 0);
        ids.push(...page.data.spots.map((spot) => spot._id));
        pagination = page.data.spotPagination;
      }
      assert.deepEqual(ids, rows.map((spot) => spot.id));
      assert.equal(new Set(ids).size, total);
      assert.equal(pagination.nextOffset, total);

      const exhausted = await rpc(source, "getHomeData", { data: { spotsOnly: true, spotOffset: total + 10 } });
      assert.equal(exhausted.success, true);
      assert.deepEqual(exhausted.data.spots, []);
      assert.deepEqual(exhausted.data.spotPagination, {
        offset: total + 10, limit: 20, nextOffset: total + 10, hasMore: false, total
      });
    });
  }
});

test("首页热榜分页归一化非法参数并限制每页 1 至 100 条", async () => {
  const source = makeSource({ spots: homeSpots(125) });
  const cases = [
    [{}, 0, 20],
    [{ spotOffset: "20", spotLimit: "30" }, 20, 30],
    [{ spotOffset: -20, spotLimit: 0 }, 0, 1],
    [{ spotOffset: -1, spotLimit: -10 }, 0, 1],
    [{ spotOffset: 5, spotLimit: 1000 }, 5, 100],
    [{ spotOffset: 1.5, spotLimit: 2.5 }, 0, 20],
    [{ spotOffset: "bad", spotLimit: "bad" }, 0, 20],
    [{ spotOffset: Infinity, spotLimit: NaN }, 0, 20],
    [{ spotOffset: null, spotLimit: null }, 0, 20],
    [{ spotOffset: "", spotLimit: " " }, 0, 20],
    [{ spotOffset: true, spotLimit: false }, 0, 20],
    [{ spotOffset: [20], spotLimit: [10] }, 0, 20],
    [{ spotOffset: {}, spotLimit: {} }, 0, 20],
    [{ spotOffset: Number.MAX_SAFE_INTEGER + 1, spotLimit: Number.MAX_SAFE_INTEGER + 1 }, 0, 20]
  ];
  for (const [params, offset, limit] of cases) {
    const page = await rpc(source, "getHomeData", { data: { spotsOnly: true, ...params } });
    assert.equal(page.success, true);
    assert.deepEqual(page.data.spotPagination, {
      offset, limit, nextOffset: offset + limit, hasMore: offset + limit < 125, total: 125
    });
    assert.equal(page.data.spots.length, limit);
    assert.equal(page.data.spots[0]._id, `spot-${String(offset + 1).padStart(3, "0")}`);
  }
});

test("首页热榜每页与总数均在公开城市和点位过滤后计算", async () => {
  const source = makeSource({
    homeConfig: [{ id: "homeStats", recommendations: { hotSpotIds: ["hidden-point", "disabled-city", "hidden-city"] } }],
    cities: [
      { id: "city-changsha", name: "长沙", code: "cs", status: "运营中", visible: true },
      { id: "city-public", name: "另一个城市", code: "other", status: "运营中", visible: true },
      { id: "city-disabled", name: "停用城市", status: "停用", visible: true },
      { id: "city-hidden", name: "隐藏城市", status: "运营中", visible: false }
    ],
    spots: [
      ...homeSpots(25),
      ...homeSpots(25, { cityId: "city-public" }).map((spot) => ({ ...spot, id: `other-${spot.id}` })),
      { id: "hidden-point", name: "隐藏点位", cityId: "city-changsha", isShow: false, hotScore: 9999 },
      { id: "deleted-point", name: "删除点位", cityId: "city-changsha", deleted: true, hotScore: 9999 },
      { id: "offline-point", name: "下架点位", cityId: "city-changsha", status: "下架", hotScore: 9999 },
      { id: "unapproved-point", name: "待审核点位", cityId: "city-changsha", auditStatus: "pending", hotScore: 9999 },
      { id: "disabled-city", name: "停用城市点位", cityId: "city-disabled", hotScore: 9999 },
      { id: "hidden-city", name: "隐藏城市点位", cityId: "city-hidden", hotScore: 9999 },
      { id: "no-city", name: "未归属城市点位", hotScore: 9999 }
    ]
  });
  const first = await rpc(source, "getHomeData", { data: { cityId: "city-changsha" } });
  const second = await rpc(source, "getHomeData", { data: { cityCode: "cs", spotOffset: 20, spotsOnly: true } });
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.spots.length, 20);
  assert.deepEqual(first.data.spotPagination, { offset: 0, limit: 20, nextOffset: 20, hasMore: true, total: 25 });
  assert.deepEqual(second.data.spots.map((spot) => spot._id), homeSpots(25).slice(20).map((spot) => spot.id));
  assert.deepEqual(second.data.spotPagination, { offset: 20, limit: 20, nextOffset: 25, hasMore: false, total: 25 });
  const all = await rpc(source, "getHomeData", { data: { spotsOnly: true, spotLimit: 100 } });
  assert.equal(all.data.spots.length, 25, "未切换城市时只返回默认城市");
  assert.equal(all.data.spotPagination.total, 25);
  for (const cityId of ["city-disabled", "city-hidden", "unknown-city"]) {
    const page = await rpc(source, "getHomeData", { data: { cityId, spotsOnly: true } });
    assert.deepEqual(page.data.spots, []);
    assert.equal(page.data.spotPagination.total, 0);
    assert.equal(page.data.spotPagination.hasMore, false);
  }
});

test("仅加载热榜的分页跳过轮播、商品和门店集合", async () => {
  const base = makeSource({
    homeConfig: [{ id: "homeStats", carouselIds: ["sample-banner"] }], spots: homeSpots(45)
  });
  const reads = [];
  const source = {
    get: base.get,
    async list(key) {
      reads.push(key);
      assert.ok(["cities", "spots", "series", "shops"].includes(key), `分页不应读取 ${key}`);
      return base.list(key);
    }
  };
  const page = await rpc(source, "getHomeData", { data: { spotsOnly: true, spotOffset: 20, shopId: "shop-cs" } });
  assert.equal(page.success, true);
  assert.equal(page.data.spots.length, 20);
  assert.deepEqual(page.data.spotPagination, { offset: 20, limit: 20, nextOffset: 40, hasMore: true, total: 45 });
  assert.ok(reads.includes("shops"), "分页仍按扫码商家定位默认城市");
  assert.equal(reads.includes("samples"), false);
  assert.deepEqual(Object.keys(page.data).sort(), ["spotPagination", "spots"]);
});

test("首页推荐先去重再分页，同热度同名称的点位按 ID 保持稳定顺序", async () => {
  const rows = homeSpots(45, { name: "同名点位", hotScore: 10, sort: 1 });
  const base = makeSource({
    homeConfig: [{ id: "homeStats", recommendations: {
      hotSpotIds: ["spot-045", "spot-021", "spot-045", "missing", "hidden"]
    } }],
    spots: [...rows, { ...rows[20] }, { id: "hidden", cityId: "city-changsha", isShow: false }]
  });
  let reverse = false;
  const source = {
    get: base.get,
    async list(key) {
      const values = await base.list(key);
      if (key !== "spots") return values;
      reverse = !reverse;
      return reverse ? values.reverse() : values;
    }
  };
  const ids = [];
  for (const spotOffset of [0, 20, 40]) {
    const page = await rpc(source, "getHomeData", { data: { spotOffset, spotsOnly: spotOffset > 0 } });
    assert.equal(page.success, true);
    assert.equal(page.data.spotPagination.total, 45);
    ids.push(...page.data.spots.map((spot) => spot._id));
  }
  assert.deepEqual(ids, ["spot-045", "spot-021", ...rows.map((spot) => spot.id).filter((id) => !["spot-045", "spot-021"].includes(id))]);
  assert.equal(new Set(ids).size, 45);
});

test("首页分页扩展不改变 getSpots 既有数组返回和 100 条上限", async () => {
  const source = makeSource({ spots: homeSpots(125) });
  const spots = await rpc(source, "getSpots", { data: { spotOffset: 20, spotLimit: 20, spotsOnly: true } });
  assert.equal(spots.success, true);
  assert.ok(Array.isArray(spots.data));
  assert.equal(spots.data.length, 100);
  assert.equal(spots.data[0]._id, "spot-001");
  assert.equal(spots.spotPagination, undefined);
});

test("首页和打卡点详情统一封面优先级，兼容空白、旧字段和无效历史值", async () => {
  const cases = [
    { fields: { cover: " /api/media/canonical ", coverUrl: "/api/media/old" }, expected: "/api/media/canonical" },
    { fields: { cover: "   ", coverUrl: " /api/media/legacy-url " }, expected: "/api/media/legacy-url" },
    { fields: { cover: {}, coverUrl: "", coverImage: " /api/media/legacy-cover-image " }, expected: "/api/media/legacy-cover-image" },
    { fields: { cover: "", coverUrl: " ", coverImage: 1, image: " /api/media/legacy-image " }, expected: "/api/media/legacy-image" },
    { fields: { cover: " ", image: null }, expected: "" }
  ];
  const spots = cases.map(({ fields }, index) => ({ id: `cover-${index}`, name: `封面${index}`, cityId: "city-changsha", isShow: true, ...fields }));
  const source = makeSource({ spots });
  const home = await rpc(source, "getHomeData", { cityId: "city-changsha" });
  const detail = await rpc(source, "getSpots", { cityId: "city-changsha" });
  assert.equal(home.success, true); assert.equal(detail.success, true);
  for (let index = 0; index < cases.length; index += 1) {
    for (const list of [home.data.spots, detail.data]) {
      const row = list.find((spot) => spot._id === `cover-${index}`);
      assert.equal(row.cover, cases[index].expected);
      assert.equal(row.coverUrl, cases[index].expected);
    }
  }
});
