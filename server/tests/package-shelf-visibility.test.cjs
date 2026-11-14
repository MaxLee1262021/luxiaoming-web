"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");
const { createContentContext, effectiveContentVisibility, ownContentVisible, prepareContentPatch } = require("../lib/contentPolicy.cjs");

function fixture() {
  const rows = {
    cities: [{ id: "city", name: "长沙", status: "运营中" }],
    spots: [{ id: "spot", name: "广场", cityId: "city", isShow: true, status: "启用" }],
    series: [{ id: "style", name: "自然", spotIds: ["spot"] }],
    albums: [{ id: "album", name: "照片留影", seriesId: "style", spotId: "spot", price: 100, isShow: true, status: "上架", auditStatus: "已上" }],
    packages: [
      { id: "video", name: "短视频", type: "video", productKind: "video_single", seriesId: "style", spotId: "spot", price: 88.1,
        isShow: true, status: "上架", auditStatus: "已下" },
      { id: "bundle", name: "照片和短视频", seriesId: "style", price: 199, isShow: true, status: "上架", auditStatus: "已上", isMainPush: true,
        includedItems: [{ type: "album", albumId: "album" }, { type: "video", productId: "video" }] }
    ],
    peripherals: [], guides: []
  };
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find((row) => row.id === id) || null); }
  };
  const save = async (key, id, body) => {
    const row = rows[key].find((item) => item.id === id);
    const patch = await prepareContentPatch(source, key, body, row);
    Object.assign(row, patch);
    return row;
  };
  return { rows, source, save };
}

test("reopening a video synchronizes its approved shelf state and restores the package with current prices", async () => {
  const { rows, source, save } = fixture();
  const bundle = rows.packages[1];
  assert.equal(effectiveContentVisibility("packages", bundle, await createContentContext(source)).effectiveVisible, false,
    "the admin must not claim a package is visible when its video is blocked by a stale audit shelf state");
  const initial = await rpc(source, "getHomeData", { cityId: "city" });
  assert.equal(initial.success, true);
  assert.deepEqual(initial.data.packages, []);
  assert.equal((await rpc(source, "getSeriesDetail", { packageId: "bundle" })).success, false);

  await save("packages", "video", { isShow: false, status: "下架" });
  assert.equal(rows.packages[0].auditStatus, "已下");
  await save("packages", "video", { isShow: true, status: "上架", price: 66 });
  assert.equal(rows.packages[0].auditStatus, "已上");
  await save("packages", "bundle", { price: 1 });
  assert.equal(effectiveContentVisibility("packages", bundle, await createContentContext(source)).effectiveVisible, true);

  for (const [name, data] of [
    ["getHomeData", { cityId: "city" }], ["getBookingData", {}],
    ["getSeriesDetail", { packageId: "bundle", spotId: "spot" }],
    ["getPhotoCollection", { albumId: "album", seriesId: "style", spotId: "spot" }]
  ]) {
    const result = await rpc(source, name, data);
    assert.equal(result.success, true, JSON.stringify({ name, result }));
    const item = result.data.packages.find((row) => row.id === "bundle");
    assert.ok(item, name);
    assert.equal(item.price, 1, `${name} sees the new package price on its next request`);
    assert.equal(item.includedItems.find((row) => row.type === "video").price, 66, name);
  }
  const videos = await rpc(source, "getVideoSingles", {});
  assert.equal(videos.success, true);
  assert.equal(videos.data.find((row) => row.id === "video").price, 66);
  const home = await rpc(source, "getHomeData", { cityId: "city" });
  assert.equal(home.data.videoSingles.find((row) => row.id === "video").price, 66);
  assert.equal(home.data.spotProducts.packages.find((row) => row.id === "bundle").price, 1);

  await save("packages", "bundle", { isShow: false, status: "下架" });
  assert.equal(rows.packages[1].auditStatus, "已下");
  const hidden = await rpc(source, "getHomeData", { cityId: "city" });
  assert.equal(hidden.data.packages.some((row) => row.id === "bundle"), false);
  assert.equal(hidden.data.videoSingles.some((row) => row.id === "video"), true, "hiding the package keeps its independent video visible");
});

test("explicit product shelf changes synchronize existing terminal aliases without adding an audit", async () => {
  const { source } = fixture();
  const emptyContext = { spots: [], series: [], albums: [], packages: [], peripherals: [], guides: [] };
  for (const key of ["albums", "packages", "peripherals"]) {
    for (const field of ["auditStatus", "reviewStatus"]) {
      const current = { id: "product", type: "video", productKind: "video_single", isShow: false, status: "下架", [field]: "已下" };
      const shown = await prepareContentPatch(source, key, { isShow: true, status: "上架" }, current, emptyContext);
      assert.equal(shown[field], "已上", `${key} ${field}`);
      const hidden = await prepareContentPatch(source, key, { isShow: false }, { ...current, ...shown }, emptyContext);
      assert.equal(hidden[field], "已下", `${key} ${field}`);
      const statusOnly = await prepareContentPatch(source, key, { status: "上架" }, { ...current, isShow: true }, emptyContext);
      assert.equal(statusOnly[field], "已上", `${key} ${field}`);
      const priceOnly = await prepareContentPatch(source, key, { price: 1 }, current, emptyContext);
      assert.equal(Object.hasOwn(priceOnly, field), false, "a price edit does not reopen a hidden product");
    }
    for (const auditStatus of [undefined, ""]) {
      const patch = await prepareContentPatch(source, key, { isShow: true, status: "上架" }, { id: "product", auditStatus }, emptyContext);
      assert.equal(Object.hasOwn(patch, "auditStatus"), false, `${key} retains an absent or empty audit`);
    }
  }
});

test("shelf toggles cannot approve pending, rejected, or unknown reviews or hide a review behind another alias", async () => {
  for (const field of ["auditStatus", "reviewStatus"]) {
    for (const audit of ["待审", "待审核", "驳回", "pending", "reviewing", "rejected", "unknown"]) {
      const { rows, source, save } = fixture();
      const video = rows.packages[0];
      delete video.auditStatus;
      video[field] = audit;
      video[field === "auditStatus" ? "reviewStatus" : "auditStatus"] = "已下";
      await save("packages", "video", { isShow: true, status: "上架" });
      assert.equal(video[field], audit, `${field}=${audit} is never automatically approved`);
      assert.equal(ownContentVisible(video), false);
      const context = await createContentContext(source);
      assert.equal(effectiveContentVisibility("packages", rows.packages[1], context).effectiveVisible, false);
      const home = await rpc(source, "getHomeData", { cityId: "city" });
      assert.equal(home.success, true);
      assert.deepEqual(home.data.packages, []);
      assert.deepEqual(home.data.videoSingles, []);
    }
  }
});
