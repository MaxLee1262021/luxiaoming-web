"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
function page(file, ctx) {
  const window = { Vue: { computed: (get) => ({ get value() { return get(); } }), unref: (value) => value?.value ?? value }, LXM_PAGES: { register(definition) { window.page = definition; } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), { window });
  return window.page.setup(ctx);
}
test("转化追溯只计真实扫码和确认付款订单，不推算浏览量", () => {
  const ctx = { scopedScans: { value: [{ id: "scan" }] }, scopedOrders: { value: [{ id: "paid", paid: true }, { id: "done", businessStatus: "completed" }] },
    paymentConfirmed: (row) => !!row.paid, orderBusinessStatus: (row) => row.businessStatus };
  const view = page("src/views/operation/trace/operation-trace.js", ctx);
  const counts = () => Array.from(view.traceFunnel.value, (row) => row.count);
  assert.deepEqual(counts(), [1, null, 2, 1, 1]);
  ctx.scopedScans.value = []; ctx.scopedOrders.value = [];
  assert.deepEqual(counts(), [0, null, 0, 0, 0]);
});
test("经营分析按订单创建日期统计，商品条形图比例不使用固定倍数", () => {
  const ctx = { scopedOrders: { value: [] }, data: { packages: [], albums: [], peripherals: [] },
    contentEffectiveVisible: (row) => row.isShow !== false, isVideoSingleProduct: (row) => row.isVideoSingle === true };
  const view = page("src/views/operation/performance/operation-performance.js", ctx);
  assert.equal(view.performanceTrend.value.length, 7);
  assert.ok(view.performanceTrend.value.every((row) => row.v === 0 && row.percent === 0));
  const today = view.performanceTrend.value[6].d;
  ctx.scopedOrders.value = [{ createdAt: `${today}T08:00:00` }, { createdAt: `${today}T10:00:00` }, { appointmentAt: today }, { createdAt: "2020-01-01" }];
  assert.equal(view.performanceTrend.value[6].v, 2);
  ctx.data.packages = [{ id: "package" }, { id: "video", isVideoSingle: true }, { id: "deleted", deleted: true }];
  ctx.data.albums = [{ id: "photo" }, { id: "hidden", isShow: false }]; ctx.data.peripherals = [{ id: "gift" }];
  assert.deepEqual(Array.from(view.performanceProducts.value, (row) => row.count), [1, 1, 1, 1]);
  assert.ok(view.performanceProducts.value.every((row) => row.percent === 25));
});
test("旧本地数据源偏好不能启用本地读写，空集合由真实API原样返回", async () => {
  let authenticated = false;
  const calls = [];
  const window = { LXM_AUTH: { hasSession: () => authenticated }, LXM_CLOUD: {
    async getColl(key) { calls.push(["read", key]); return []; },
    async update(key, id, doc) { calls.push(["update", key, id]); return { ...doc, saved: true }; }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/api/lxmApi.js"), "utf8"), { window, localStorage: { getItem: () => "0", removeItem() {} } });
  const api = window.LXM_API;
  assert.equal(api.remoteOn(), true); assert.equal(api.setRemote(false), true);
  await assert.rejects(api.loadCollection("peripherals"), /登录/);
  await assert.rejects(api.saveDoc("peripherals", { id: "item" }), /登录/);
  assert.equal(calls.length, 0);
  authenticated = true;
  assert.deepEqual(await api.loadCollection("peripherals"), []);
  assert.equal((await api.saveDoc("peripherals", { id: "item" })).saved, true);
  assert.deepEqual(calls, [["read", "peripherals"], ["update", "peripherals", "item"]]);
});
