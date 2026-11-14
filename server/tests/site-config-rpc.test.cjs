"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");

function fixture(site) {
  const collections = { siteConfig: site ? [{ id: "global", ...site }] : [],
    packages: [{ id: "photo", name: "Configured photo", price: 100, depositRatio: 30, status: "published" }] };
  const writes = [];
  return { writes, collections,
    async list(key) { return structuredClone(collections[key] || []); },
    async get(key, id) { return structuredClone((collections[key] || []).find((row) => String(row.id) === String(id)) || null); },
    async create(key, value) { const row = { ...value, id: value.id || `${key}-${writes.length}` }; writes.push({ key, row }); (collections[key] ||= []).push(row); return structuredClone(row); },
    async update(key, id, patch) { const row = (collections[key] || []).find((item) => item.id === id); if (!row) return null; Object.assign(row, patch); return structuredClone(row); },
  };
}

test("unconfigured site RPCs return empty business values without invented prices, stamps or consent", async () => {
  const source = fixture();
  const booking = (await rpc(source, "getBookingConfig", {})).data;
  assert.deepEqual(booking.customPrice, { single: null, extraPerPerson: null });
  assert.equal(booking.depositRatio, null);
  assert.equal(booking.bookingNotice, ""); assert.equal(booking.bookingNoticeVersion, ""); assert.equal(booking.agreementVersion, "");
  const footprint = (await rpc(source, "getFootprintConfig", {})).data;
  assert.equal(footprint.enabled, false); assert.equal(footprint.rewardText, ""); assert.deepEqual(footprint.stamps, []);
  const corp = (await rpc(source, "getCorpConfig", {})).data;
  assert.equal(corp.corpId, ""); assert.equal(corp.customerServiceUrl, "");
  assert.equal(source.writes.length, 0);
});

test("site RPCs expose only the configured prices, stamp catalogue and customer service link aliases", async () => {
  const site = { bookingNotice: ["Configured notice"], bookingNoticeVersion: "configured-v3", customPrice: { singlePersonPrice: 79.5, perExtraPerson: 0, depositRatio: 30 },
    footprint: { enabled: true, title: "Configured title", rewardText: "Configured reward", stamps: [{ key: "real", char: "旅", name: "Configured place", spotIds: ["a"] }] },
    customerServiceUrl: "https://example.test/top", wechat: { corpId: "configured-corp", customerServiceUrl: "https://example.test/nested" } };
  const source = fixture(site);
  const booking = (await rpc(source, "getBookingConfig", {})).data;
  assert.deepEqual(booking.customPrice, { single: 79.5, extraPerPerson: 0 });
  assert.equal(booking.depositRatio, 0.3);
  assert.equal(booking.bookingNotice, "1. Configured notice"); assert.equal(booking.bookingNoticeVersion, "configured-v3");
  const footprint = (await rpc(source, "getFootprintConfig", {})).data;
  assert.equal(footprint.enabled, true); assert.equal(footprint.stamps.length, 1); assert.equal(footprint.stamps[0].name, "Configured place");
  assert.equal((await rpc(source, "getCorpConfig", {})).data.customerServiceUrl, "https://example.test/nested");
  for (const [field, nested] of [["customerServiceUrl", false], ["kfUrl", true], ["kfUrl", false], ["serviceUrl", true], ["serviceUrl", false]]) {
    const config = nested ? { wechat: { [field]: "https://example.test/configured" } } : { [field]: "https://example.test/configured" };
    assert.equal((await rpc(fixture(config), "getCorpConfig", {})).data.customerServiceUrl, "https://example.test/configured");
  }
  for (const field of ["depositRatio", "depositRate", "depositPercent"]) {
    assert.equal((await rpc(fixture({ customPrice: { [field]: 50 } }), "getBookingConfig", {})).data.depositRatio, 0.5);
  }
  for (const value of [null, "", false, [], "NaN", -1, 101]) {
    assert.equal((await rpc(fixture({ customPrice: { depositRatio: value } }), "getBookingConfig", {})).data.depositRatio, null);
  }
});

test("a booking requires persisted notice text and an explicit current version, including old v1.0 clients", async () => {
  const input = { name: "Test visitor", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午",
    agreement: { version: "v1.0", current: true }, items: [{ packageId: "photo" }], idempotencyKey: "site-config-booking" };
  const identity = { identity: { kind: "public", openid: "owner" } };
  for (const config of [{}, { bookingNoticeVersion: "v1.0" }, { bookingNotice: ["Configured notice"] }]) {
    const source = fixture(config);
    const result = await rpc(source, "createBooking", input, identity);
    assert.equal(result.success, false); assert.match(result.error, /须知或版本尚未配置/);
    assert.equal(source.writes.length, 0);
  }
  const source = fixture({ bookingNotice: ["Configured notice"], bookingNoticeVersion: "configured-v3" });
  assert.equal((await rpc(source, "createBooking", input, identity)).success, false);
  const result = await rpc(source, "createBooking", { ...input, agreement: { version: "configured-v3", current: true } }, identity);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(source.writes.some((write) => write.key === "bookingRequests"));
});

test("bookings use photo/video overrides, inherit global ratios after canonical clearing, and create zero-deposit orders without payment", async () => {
  const input = { name: "Test visitor", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1", current: true } };
  const identity = { identity: { kind: "public", openid: "owner" } };
  for (const [key, itemKey] of [["albums", "albumId"], ["packages", "packageId"]]) {
    for (const [override, expected] of [[0.01, 1], [0.5, 50], [null, 30], ["", 30], [0, 0]]) {
      const source = fixture({ bookingNotice: ["Terms"], bookingNoticeVersion: "v1", customPrice: { depositRatio: 0.3 } });
      source.collections[key] = [{ id: "product", name: "Configured product", price: 100, status: "published", depositRatio: override, depositRate: 0.8,
        ...(key === "packages" ? { type: "video", isVideoSingle: true, productKind: "video_single", videoUrl: "https://example.test/test.mp4" } : {}) }];
      const result = await rpc(source, "createBooking", { ...input, items: [{ [itemKey]: "product" }], idempotencyKey: `product-${key}-${String(override)}` }, identity);
      assert.equal(result.success, true, JSON.stringify(result));
      const write = source.writes.find(write => ["bookingRequests", "orders"].includes(write.key));
      assert.equal(write.row.depositDue, expected); assert.equal(write.row.items[0].depositRatio, expected / 100);
      assert.equal(write.key, expected === 0 ? "orders" : "bookingRequests");
      assert.deepEqual(write.row.paymentRecords, []);
      const publicData = (await rpc(source, "getBookingData", {})).data;
      const product = (key === "albums" ? publicData.albums : publicData.allPackages).find(row => row.id === "product");
      assert.ok(product, JSON.stringify(publicData)); assert.equal(product.depositRatio, override);
    }
  }
});

test("canonical custom price clearing cannot be bypassed by legacy prices", async () => {
  const source = fixture({ bookingNotice: ["Terms"], bookingNoticeVersion: "v1", customPrice: { single: null, singlePersonPrice: 200, extraPerPerson: null, perExtraPerson: 80, depositRatio: 0.3 } });
  const config = (await rpc(source, "getBookingConfig", {})).data;
  assert.deepEqual(config.customPrice, { single: null, extraPerPerson: null });
  const result = await rpc(source, "createBooking", { name: "Test visitor", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1", current: true },
    items: [{ custom: true, participantCount: 1 }], idempotencyKey: "cleared-custom" }, { identity: { kind: "public", openid: "owner" } });
  assert.equal(result.success, false); assert.match(result.error, /定制项目价格或定金配置缺失/); assert.equal(source.writes.length, 0);
});
