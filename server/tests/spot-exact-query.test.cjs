"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");

function fixture() {
  const rows = {
    cities: [{ id: "cs", name: "长沙", status: "运营中" }, { id: "hz", name: "杭州", status: "运营中" },
      { id: "off", name: "停用城市", enabled: false }],
    spots: [
      ...Array.from({ length: 125 }, (_, index) => ({ id: `point-${index + 1}`, name: `点位${index + 1}`, cityId: "cs", hotScore: 1000 - index })),
      { id: "hidden", name: "隐藏点位", cityId: "cs", isShow: false },
      { id: "deleted", name: "删除点位", cityId: "cs", deleted: true },
      { id: "other-city", name: "另一城市点位", cityId: "hz" },
      { id: "off-city", name: "停用城市点位", cityId: "off" }
    ],
    series: []
  };
  return { async list(key) { return structuredClone(rows[key] || []); } };
}

test("exact point queries find targets beyond the default 100-point window and retain the array contract", async () => {
  const source = fixture();
  const normal = await rpc(source, "getSpots", { cityId: "cs" });
  assert.equal(normal.success, true);
  assert.equal(normal.data.length, 100);
  assert.equal(normal.data.some((row) => row._id === "point-125"), false);
  for (const query of [{ spotId: "point-125" }, { id: "point-125" }, { spotId: "point-125", limit: 1 }]) {
    const exact = await rpc(source, "getSpots", { cityId: "cs", ...query });
    assert.equal(exact.success, true, JSON.stringify(exact));
    assert.deepEqual(exact.data.map((row) => row._id), ["point-125"]);
    assert.equal(exact.data[0].cityId, "cs");
  }
  const subsequent = await rpc(source, "getSpots", { cityId: "cs" });
  assert.deepEqual(subsequent.data, normal.data, "exact lookup cannot change regular list ordering or limits");
});

test("exact point queries never revive hidden, deleted, disabled-city, missing or cross-city points", async () => {
  const source = fixture();
  for (const spotId of ["hidden", "deleted", "off-city", "missing", "other-city"]) {
    const exact = await rpc(source, "getSpots", { cityId: "cs", spotId });
    assert.equal(exact.success, true, JSON.stringify(exact));
    assert.deepEqual(exact.data, [], spotId);
  }
  assert.deepEqual((await rpc(source, "getSpots", { city: "杭州", id: "point-125" })).data, []);
  assert.deepEqual((await rpc(source, "getSpots", { cityId: "hz", id: "other-city" })).data.map((row) => row._id), ["other-city"]);
});
