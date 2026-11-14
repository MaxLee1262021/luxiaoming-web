"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");

function fixture(overrides = {}) {
  const rows = {
    cities: [
      { id: "cs", name: "长沙", enabled: true, sort: 1 },
      { id: "hz", name: "杭州", enabled: true, sort: 2 },
      { id: "empty", name: "重庆", enabled: true, sort: 3 }
    ],
    spots: [
      { id: "a", cityId: "cs", name: "江边", status: "启用", isShow: true, sort: 2 },
      { id: "b", cityId: "hz", name: "西湖", status: "启用", isShow: true, sort: 1 }
    ],
    series: [{ id: "style", name: "自然", spotIds: ["a", "b"] }],
    albums: [
      { id: "photo", name: "江边留影", spotId: "a", seriesId: "style", price: 100, status: "上架" },
      { id: "manual", name: "单独隐藏", spotId: "a", price: 80, isShow: false }
    ],
    packages: [
      { id: "video", name: "西湖视频", spotId: "b", productKind: "video_single", type: "video", price: 200, status: "上架" },
      { id: "bundle", name: "双城套餐", seriesId: "style", spotIds: ["outdated"], price: 450, isHot: true, status: "上架",
        includedItems: [{ type: "album", albumId: "photo", price: 100, quantity: 2 }, { type: "video", productId: "video", price: 200 }] }
    ],
    peripherals: [{ id: "gift", name: "照片礼物", cityId: "cs", spotId: "a", price: 20, status: "上架" }],
    guides: [{ id: "guide", title: "江边灵感", spotId: "a", status: "启用", content: "日落" }],
    shops: [{ id: "shop", name: "杭州店", cityId: "hz", city: "杭州", status: "合作中" }],
    merchantCodes: [{ id: "code", shopId: "shop", cityId: "hz", city: "杭州", status: "启用" }],
    homeConfig: [{ id: "homeStats", defaultCityId: "cs", banners: [
      { id: "cs-banner", url: "https://example.test/cs.jpg", cityId: "cs" },
      { id: "hz-banner", url: "https://example.test/hz.jpg", cityIds: ["hz"] }
    ], exploreBanners: [
      { id: "cs-explore", url: "https://example.test/cs-explore.jpg", city: "长沙" },
      { id: "hz-explore", url: "https://example.test/hz-explore.jpg", cityId: "hz" }
    ] }],
    samples: [{ id: "fallback", isShowcase: true, cityId: "cs", url: "https://example.test/fallback.jpg" }],
    orders: [{ id: "historic", openid: "visitor", status: "已完成", packageId: "bundle", totalPrice: 450,
      products: [{ productId: "bundle", name: "双城套餐", price: 450, quantity: 1 }] }],
    ...overrides
  };
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find((row) => String(row.id) === String(id)) || null); }
  };
  return { rows, source };
}

test("public peripheral lists and package references expose display fields without inventory management data", async () => {
  const { rows, source } = fixture();
  const management = { stock: 123, stockQty: 123, totalStock: 123, stockWarning: 5, productCode: "PRIVATE-PRODUCT", shippingFee: 8, sales: 10, salesCount: 10, soldCount: 10, soldAmount: 200,
    skus: [{ spec: "6寸", skuCode: "PRIVATE-SKU", price: 20, stock: 123 }] };
  Object.assign(rows.peripherals[0], management, { specMode: "multiple", specs: ["6寸"], unit: "件" });
  rows.packages[1].includedItems.push({ type: "peripheral", peripheralId: "gift", ...management, snapshot: { ...management, specs: ["6寸"] } });
  const before = structuredClone(rows);
  for (const [name, data] of [["getPeripherals", {}], ["getHomeData", { cityId: "cs" }], ["getBookingData", {}], ["getSeriesDetail", { packageId: "bundle" }], ["getPhotoCollection", { seriesId: "style", spotId: "a" }]]) {
    const result = await rpc(source, name, data);
    assert.equal(result.success, true, JSON.stringify({ name, result }));
    const inspect = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        // Packages may legitimately retain their own soldCount, so inspect
        // peripheral records and package peripheral lines rather than every row.
        if (value.id === "gift" || value.peripheralId === "gift" || value.snapshot && value.snapshot.specs) {
          assert.ok(!Object.prototype.hasOwnProperty.call(management, key), `${name} leaks ${key}`);
          if (key === "snapshot") for (const hidden of Object.keys(management)) assert.equal(child[hidden], undefined, `${name} snapshot ${hidden}`);
        }
        inspect(child);
      }
    };
    inspect(result.data);
    assert.ok(!JSON.stringify(result).includes("PRIVATE-SKU"), name);
    assert.ok(!JSON.stringify(result).includes("PRIVATE-PRODUCT"), name);
  }
  const peripheral = (await rpc(source, "getPeripherals", {})).data.find((row) => row.id === "gift");
  assert.deepEqual(peripheral.specs, ["6寸"]); assert.equal(peripheral.price, 20); assert.equal(peripheral.unit, "件");
  assert.deepEqual(rows, before, "公共投影不修改库存或原始商品");
});

test("mixed package derives points from its products and hides as a whole while preserving manual choices", async () => {
  const { rows, source } = fixture();
  rows.peripherals[0].spotId = "b";
  rows.peripherals[0].cityId = "hz";
  rows.packages[1].includedItems.push({ type: "peripheral", peripheralId: "gift" });
  let home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(home.success, true);
  assert.deepEqual(home.data.packages.find((row) => row.id === "bundle").spotIds, ["a"]);
  assert.equal(home.data.packages.find((row) => row.id === "bundle").includedItems[1].target.spotId, "b", "跨城套餐中的视频保留实际商品点位");
  assert.equal(home.data.packages.find((row) => row.id === "bundle").includedItems[2].peripheralId, "gift", "跨城套餐保留另一城市的周边，不能裁剪成残缺明细");
  const bookable = await rpc(source, "getBookingData", {});
  const bundle = bookable.data.packages.find((row) => row.id === "bundle");
  assert.deepEqual(bundle.spotIds, ["a", "b"]);
  assert.equal(bundle.includedItems[0].quantity, 2);
  assert.equal(bundle.price, 450, "手动售价保持不变");

  rows.spots[0].isShow = false;
  home = await rpc(source, "getHomeData", { cityId: "hz" });
  assert.equal(home.data.packages.some((row) => row.id === "bundle"), false, "一个点位隐藏时另一城市也不能展示残缺套餐");
  assert.deepEqual((await rpc(source, "getGuides", {})).data, []);
  assert.equal((await rpc(source, "getPhotoCollection", { albumId: "photo" })).success, false);
  assert.equal((await rpc(source, "getSeriesDetail", { packageId: "bundle" })).success, false);

  rows.spots[0].isShow = true;
  home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.ok(home.data.packages.some((row) => row.id === "bundle"));
  assert.ok(home.data.albums.some((row) => row.id === "photo"));
  assert.equal(home.data.albums.some((row) => row.id === "manual"), false);
  assert.equal(rows.albums[1].isShow, false);
  assert.deepEqual(rows.packages[1].spotIds, ["outdated"], "公开投影不会修改持久化关联");
});

test("each unavailable constituent suppresses the entire package; deletion markers stay private", async () => {
  for (const [key, id] of [["albums", "photo"], ["packages", "video"], ["peripherals", "gift"]]) {
    const { rows, source } = fixture();
    rows.packages[1].includedItems.push({ type: "peripheral", peripheralId: "gift" });
    rows[key].find((row) => row.id === id).isShow = false;
    const home = await rpc(source, "getHomeData", { cityId: "cs" });
    assert.equal(home.data.packages.some((row) => row.id === "bundle"), false, key);
  }
  const { rows, source } = fixture();
  rows.packages[1].deletedSpotIds = ["a"];
  rows.albums[0].spotId = "";
  const home = await rpc(source, "getHomeData", { cityId: "hz" });
  assert.equal(home.data.packages.some((row) => row.id === "bundle"), false);
  const orders = await rpc(source, "getMyOrders", {}, { identity: { kind: "public", openid: "visitor" } });
  assert.equal(orders.success, true);
  assert.equal(orders.data[0].totalAmount, 450);
  assert.equal(rows.orders[0].products[0].name, "双城套餐");
});

test("QR city controls home, ranking and banners, explicit choice wins, empty cities do not fall back", async () => {
  const { source } = fixture();
  const fromCode = await rpc(source, "getHomeData", { codeId: "code" });
  assert.equal(fromCode.data.cityId, "hz");
  assert.deepEqual(fromCode.data.spots.map((row) => row.id), ["b"]);
  assert.deepEqual(fromCode.data.banners.map((row) => row.id), ["hz-banner"]);
  assert.deepEqual(fromCode.data.exploreBanners.map((row) => row.id), ["hz-explore"]);
  const fromShop = await rpc(source, "getHomeData", { shopId: "shop" });
  assert.equal(fromShop.data.cityId, "hz");
  const explicit = await rpc(source, "getHomeData", { codeId: "code", cityId: "cs" });
  assert.equal(explicit.data.cityId, "cs");
  assert.deepEqual(explicit.data.banners.map((row) => row.id), ["cs-banner"]);
  assert.equal((await rpc(source, "getHomeData", {})).data.cityId, "cs");
  for (const cityId of ["empty", "not-created"]) {
    const empty = await rpc(source, "getHomeData", { cityId });
    assert.deepEqual(empty.data.spots, []);
    assert.deepEqual(empty.data.hotSpots, []);
    assert.deepEqual(empty.data.banners, []);
    assert.deepEqual(empty.data.exploreBanners, []);
    assert.deepEqual(empty.data.packages, []);
    assert.deepEqual(empty.data.albums, []);
  }
});

test("home defaults to the earliest created enabled city while explicit and QR cities keep priority", async () => {
  const cities = [
    { id: "cities1793432401916", name: "重庆", enabled: true, sort: -10, isDefault: true, default: true, createdAt: "2026-10-31T07:40:02.874Z" },
    { id: "city0", name: "停用城市", enabled: true, status: "停用", sort: -99, createdAt: "2020-01-01" },
    { id: "city1", name: "长沙", status: "运营中", sort: 99, createdAt: "2026-09-09T08:41:16.801Z" }
  ];
  const otherCityId = "cities1793432401916";
  for (const input of [cities, cities.slice().reverse()]) {
    const { source } = fixture({
      cities: input,
      spots: [
        { id: "changsha", cityId: "city1", name: "长沙点位", status: "启用" },
        { id: "chongqing", cityId: otherCityId, name: "洪崖洞", status: "启用" },
        { id: "disabled", cityId: "city0", name: "不可展示点位", status: "启用" }
      ],
      homeConfig: [{ id: "homeStats", defaultCityId: otherCityId, defaultCity: "重庆", cityName: "重庆" }],
      shops: [{ id: "shop", cityId: otherCityId, city: "重庆", status: "合作中" }],
      merchantCodes: [{ id: "code", shopId: "shop", cityId: otherCityId, city: "重庆", status: "启用" }]
    });
    const home = await rpc(source, "getHomeData", {});
    assert.equal(home.success, true);
    assert.equal(home.data.cityId, "city1");
    assert.equal(home.data.city, "长沙");
    assert.deepEqual(home.data.spots.map((row) => row._id), ["changsha"]);
    const page = await rpc(source, "getHomeData", { spotsOnly: true });
    assert.deepEqual(page.data.spots.map((row) => row._id), ["changsha"]);
    assert.equal(page.data.spotPagination.total, 1);
    const cityList = await rpc(source, "getCities", {});
    assert.equal(cityList.data[0]._id, home.data.cityId);
    for (const request of [{ cityId: otherCityId }, { codeId: "code" }, { shopId: "shop" }]) {
      const chosen = await rpc(source, "getHomeData", request);
      assert.equal(chosen.data.cityId, otherCityId);
      assert.deepEqual(chosen.data.spots.map((row) => row._id), ["chongqing"]);
    }
    assert.equal((await rpc(source, "getHomeData", { codeId: "code", cityId: "city1" })).data.cityId, "city1");
    const disabled = await rpc(source, "getHomeData", { cityId: "city0" });
    assert.equal(disabled.data.cityId, "city0");
    assert.deepEqual(disabled.data.spots, []);
    assert.equal(disabled.data.spotPagination.total, 0);
  }
});

test("an explicitly unbound photo retains its style without inheriting hidden point constraints", async () => {
  const { rows, source } = fixture();
  rows.spots[0].isShow = false;
  rows.albums = [{ id: "unbound", name: "无点位照片", seriesId: "style", spotBindingExplicit: true,
    spotId: "", spotIds: [], price: 99, status: "上架" }];
  const home = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.deepEqual(home.data.albums.map((item) => item.id), ["unbound"]);
  assert.equal(home.data.albums[0].spotId, "");
  const detail = await rpc(source, "getPhotoCollection", { albumId: "unbound" });
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.equal(detail.data.collections[0].spotId, "");
  assert.deepEqual(detail.data.series.spots, []);
});
