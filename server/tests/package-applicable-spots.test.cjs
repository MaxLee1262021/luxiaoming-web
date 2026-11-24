"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rpc = require("../lib/rpc.cjs");
const createSource = require("./fixtures/jsonSource.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const { publicOrderProjection } = require("../lib/orderWorkflow.cjs");

const identity = { identity: { kind: "public", openid: "owner" } };
const ids = (spots) => spots.map((spot) => spot._id);

async function fixture(t, seriesId = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-package-spots-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { jsonFile: path.join(dir, "db.json") };
  const source = createSource(config);
  await source.create("cities", { id: "city", name: "长沙", status: "运营中" });
  for (const id of ["a", "b", "c", "d", "e", "f", "unrelated"]) {
    await source.create("spots", { id, name: `打卡点 ${id}`, cityId: "city", internalNote: "DO NOT EXPOSE" });
  }
  await source.create("series", { id: "first-style", name: "第一风格", spotIds: ["a"] });
  await source.create("series", { id: "other-style", name: "另一风格", spotIds: ["c"] });
  await source.create("albums", { id: "multi-photo", name: "多点照片", seriesId: "first-style", spotId: "a", spotIds: ["a", "b"], price: 99, depositRatio: 0 });
  await source.create("albums", { id: "inherited-photo", name: "风格继承照片", seriesId: "other-style", price: 99, depositRatio: 0 });
  await source.create("albums", { id: "extra-photo", name: "另购照片", spotId: "f", price: 99, depositRatio: 0 });
  await source.create("packages", { id: "video", name: "视频", productKind: "video_single", type: "video", spotIds: ["d", "b"], price: 99, depositRatio: 0 });
  await source.create("peripherals", { id: "gift", name: "周边", spotIds: ["e", "a"], price: 99, depositRatio: 0 });
  await source.create("packages", { id: "bundle", name: "跨风格套餐", productKind: "package", seriesId, price: 199, depositRatio: 0,
    // The saved point and target are deliberately incomplete: authoritative
    // product relationships must retain all secondary and inherited points.
    spotId: "a", includedItems: [
      { type: "album", productId: "multi-photo", target: { albumId: "multi-photo", spotId: "a" } },
      { type: "album", productId: "inherited-photo" },
      { type: "video", productId: "video" },
      { type: "peripheral", productId: "gift" }
    ] });
  await source.create("siteConfig", { id: "global", bookingNotice: ["Synthetic booking notice"], bookingNoticeVersion: "v1" });
  return { source, restart: () => createSource(config) };
}

for (const seriesId of ["", "first-style"]) {
  test(`package detail includes every product point with ${seriesId || "no style"}`, async (t) => {
    const { source } = await fixture(t, seriesId);
    const result = await rpc(source, "getSeriesDetail", { packageId: "bundle" });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(ids(result.data.currentPackage.applicableSpots), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(ids(result.data.spots).sort(), ["a", "b", "c", "d", "e"]);
    assert.equal(result.data.currentPackage.includedItems.length, 4);
    assert.equal(result.data.currentPackage.includedItems[0].name, "多点照片");
    assert.doesNotMatch(JSON.stringify(result), /DO NOT EXPOSE/);
  });
}

test("checkout freezes authoritative point names for each item and the full order, ignoring forged client locations", async (t) => {
  const data = await fixture(t);
  // This fixture's bundle includes a real peripheral, so checkout now needs
  // the same owned address and inventory facts as production fulfillment.
  await data.source.update("peripherals", "gift", { stock: 5 });
  const { serviceFor, createMemoryStore } = require("../lib/physicalCommerce.cjs");
  const physical = serviceFor(data.source, { store: createMemoryStore() });
  const address = await physical.executePublic("saveShippingAddress", { recipient: "客户", phone: "13800000000", province: "湖南省", city: "长沙市", district: "岳麓区", detail: "测试街道一号房" }, { openid: "owner" });
  const created = await rpc(data.source, "createBooking", { data: {
    name: "客户", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1", current: true },
    shippingAddressId: address.id,
    items: [
      { packageId: "bundle", applicableSpots: [{ _id: "unrelated", name: "伪造地点" }], spotIds: ["unrelated"] },
      { albumId: "extra-photo" }
    ], idempotencyKey: "package-spots-order-0001"
  } }, identity);
  assert.equal(created.success, true, JSON.stringify(created));
  const order = await data.restart().get("orders", created.orderId);
  assert.deepEqual(ids(order.applicableSpots), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(order.packageSnapshot.applicableSpots, order.applicableSpots);
  assert.deepEqual(ids(order.items[0].applicableSpots), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(order.items[1].applicableSpots), ["f"]);
  assert.equal(order.items[0].applicableSpots[0].name, "打卡点 a");
  for (const collection of ["orders", "bookingRequests"]) {
    const split = schema.splitDocument(collection, { ...order, id: "roundtrip" });
    const restored = schema.hydrateDocument(collection, { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
    assert.deepEqual(restored.applicableSpots, order.applicableSpots);
    assert.deepEqual(restored.packageSnapshot.applicableSpots, order.applicableSpots);
    assert.deepEqual(restored.products[0].applicableSpots, order.items[0].applicableSpots);
  }

  await data.source.update("spots", "a", { name: "后来改名", isShow: false });
  await data.source.update("packages", "bundle", { isShow: false, includedItems: [], spotIds: ["unrelated"] });
  const detail = await rpc(data.source, "getOrderDetail", { orderId: created.orderId }, identity);
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.deepEqual(detail.data.applicableSpots, order.applicableSpots);
  assert.equal(detail.data.applicableSpotsSource, "snapshot");
  assert.deepEqual(detail.data.items[0].applicableSpots, order.items[0].applicableSpots);
  const list = await rpc(data.source, "getMyOrders", {}, identity);
  assert.deepEqual(list.data[0].applicableSpots, order.applicableSpots);
  const forbidden = await rpc(data.source, "getOrderDetail", { orderId: created.orderId }, { identity: { kind: "public", openid: "other" } });
  assert.equal(forbidden.success, false);
});

test("legacy orders supplement missing points from the visible catalogue without rewriting the stored order", async (t) => {
  const { source } = await fixture(t);
  const legacy = await source.create("orders", { id: "legacy", openid: "owner", packageId: "bundle", spotId: "a", spotName: "打卡点 a",
    totalAmount: 199, depositDue: 0, status: "deposit_paid", workflowStage: "awaiting_dispatch",
    items: [{ packageId: "bundle", name: "旧订单套餐", price: 199 }] });
  const detail = await rpc(source, "getOrderDetail", { orderId: "legacy" }, identity);
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.deepEqual(ids(detail.data.applicableSpots), ["a", "b", "c", "d", "e"]);
  assert.equal(detail.data.applicableSpotsSource, "catalog");
  assert.deepEqual(await source.get("orders", "legacy"), legacy);
  const list = await rpc(source, "getMyOrders", {}, identity);
  assert.deepEqual(list.data[0].applicableSpots, detail.data.applicableSpots);
});

test("an explicit empty or existing snapshot stays authoritative and only safe location fields are public", () => {
  for (const applicableSpots of [[], [{ _id: "a", name: "原地点", internalNote: "PRIVATE", phone: "13800000000" }]]) {
    const projected = publicOrderProjection({ id: "order", applicableSpots, packageSnapshot: { applicableSpots: [{ _id: "b", name: "其他地点" }] }, products: [{ applicableSpots }] });
    assert.deepEqual(projected.applicableSpots, applicableSpots.length ? [{ _id: "a", name: "原地点" }] : []);
    assert.deepEqual(projected.products[0].applicableSpots, projected.applicableSpots);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|13800000000/);
  }
});

test("booking catalogue carries all eligible points and a hidden dependency cannot leak through package detail", async (t) => {
  const { source } = await fixture(t);
  const available = await rpc(source, "getBookingData", {});
  assert.equal(available.success, true, JSON.stringify(available));
  assert.deepEqual(ids(available.data.packages.find((row) => row._id === "bundle").applicableSpots), ["a", "b", "c", "d", "e"]);
  await source.update("spots", "e", { isShow: false });
  const detail = await rpc(source, "getSeriesDetail", { packageId: "bundle" });
  assert.equal(detail.success, false);
  const unavailable = await rpc(source, "getBookingData", {});
  assert.equal(unavailable.data.packages.some((row) => row._id === "bundle"), false);
  assert.equal(unavailable.data.spots.some((row) => row._id === "e"), false);
});

test("an explicit empty checkout snapshot never consults a changed catalogue", async (t) => {
  const { source } = await fixture(t);
  await source.create("orders", { id: "empty-snapshot", openid: "owner", packageId: "bundle", totalAmount: 199,
    depositDue: 0, status: "deposit_paid", packageSnapshot: { applicableSpots: [] } });
  const originalList = source.list.bind(source);
  source.list = async (key) => {
    assert.ok(!["packages", "albums", "series", "spots", "cities", "peripherals"].includes(key), `must not read ${key}`);
    return originalList(key);
  };
  const detail = await rpc(source, "getOrderDetail", { orderId: "empty-snapshot" }, identity);
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.deepEqual(detail.data.applicableSpots, []);
  assert.equal(detail.data.applicableSpotsSource, "snapshot");
});

test("legacy selected shooting points do not expand today's eligible package range", async (t) => {
  const { source } = await fixture(t);
  await source.create("orders", { id: "old-selected-point", openid: "owner", packageId: "bundle", spotId: "unrelated", spotName: "原拍摄地点",
    totalAmount: 199, depositDue: 0, status: "deposit_paid",
    items: [{ packageId: "bundle", name: "旧套餐", spotId: "unrelated", spotName: "原拍摄地点", price: 199 }] });
  const detail = await rpc(source, "getOrderDetail", { orderId: "old-selected-point" }, identity);
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.deepEqual(ids(detail.data.applicableSpots), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(detail.data.items[0].applicableSpots, detail.data.applicableSpots);
  assert.equal(detail.data.applicableSpotsSource, "catalog");
  assert.equal(detail.data.spotName, "原拍摄地点");
});

test("legacy shooting points stay separate when a current product is explicitly unbound or unavailable", async (t) => {
  const { source } = await fixture(t);
  await source.update("albums", "extra-photo", { spotId: "", spotIds: [], spotBindingExplicit: true });
  await source.create("orders", { id: "old-unbound-point", openid: "owner", spotId: "f", spotName: "原拍摄地点 f",
    totalAmount: 99, depositDue: 0, status: "deposit_paid",
    items: [{ albumId: "extra-photo", spotId: "f", spotName: "原拍摄地点 f", name: "旧照片", price: 99 }] });
  const current = await rpc(source, "getOrderDetail", { orderId: "old-unbound-point" }, identity);
  assert.equal(current.success, true, JSON.stringify(current));
  assert.deepEqual(current.data.applicableSpots, []);
  assert.deepEqual(current.data.items[0].applicableSpots, []);
  assert.equal(current.data.applicableSpotsSource, "catalog");
  assert.equal(current.data.spotName, "原拍摄地点 f");

  await source.update("albums", "extra-photo", { isShow: false });
  const unavailable = await rpc(source, "getOrderDetail", { orderId: "old-unbound-point" }, identity);
  assert.equal(unavailable.success, true, JSON.stringify(unavailable));
  assert.deepEqual(unavailable.data.applicableSpots, []);
  assert.equal(unavailable.data.spotName, "原拍摄地点 f");
});
