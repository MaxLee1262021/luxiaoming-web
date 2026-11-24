"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture() {
  const window = { LXM_APP_PARTS: [] };
  const data = { shops: [], distributors: [] };
  const ctx = {
    data,
    computed: getter => ({ get value() { return getter(); } }),
    state: {}, roleProfile: { value: {} }, currentStaff: { value: null }, statusDict: []
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/02-order-basis.js"), "utf8"), { window });
  Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  return ctx;
}

test("direct mini-program orders keep their natural source", () => {
  const ctx = fixture();
  for (const order of [{}, { sourceType: "direct", shopId: "", source: { shopId: "" } }]) {
    assert.equal(ctx.orderSourceType(order), "natural");
    assert.equal(ctx.orderSourceName(order), "小程序自然来");
  }
});

test("merchant QR orders show the current merchant name ahead of source snapshots", () => {
  const ctx = fixture();
  ctx.data.shops.push({ id: "merchant-1", shopId: "SHOP-1", name: "麓山门店" });
  for (const order of [
    { shopId: "merchant-1", sourceType: "merchant_qrcode", sourceName: "旧门店名称", source: { shopName: "旧快照" } },
    { source: { shopId: "SHOP-1", shopName: "旧快照" } }
  ]) {
    assert.equal(ctx.orderSourceType(order), "shop");
    assert.equal(ctx.orderSourceName(order), "麓山门店");
  }
});

test("merchant source names fall back to the saved snapshot when shop data is unavailable", () => {
  const ctx = fixture();
  assert.equal(ctx.orderSourceName({ shopId: "merchant-1", sourceName: "岳麓门店", source: { shopName: "嵌套旧名称" } }), "岳麓门店");
  assert.equal(ctx.orderSourceName({ source: { shopId: "merchant-2", shopName: "橘洲门店" } }), "橘洲门店");
  assert.equal(ctx.orderSourceName({ shopId: "merchant-3" }), "merchant-3");
});

test("distributor source chains retain the merchant snapshot when shop data is unavailable", () => {
  const ctx = fixture();
  ctx.data.distributors.push({ id: "distributor-1", name: "长沙分销员" });
  assert.equal(ctx.orderSourceName({ shopId: "merchant-1", sourceName: "岳麓门店", distributorId: "distributor-1" }), "长沙分销员 / 岳麓门店");
});

test("manual and headquarters source labels retain their existing behavior", () => {
  const ctx = fixture();
  assert.equal(ctx.orderSourceName({ sourceType: "manual" }), "客服手动创建");
  assert.equal(ctx.orderSourceName({ sourceType: "manual", sourceName: "客服补单" }), "客服补单");
  assert.equal(ctx.orderSourceName({ sourceType: "headquarter", sourceName: "总部活动" }), "总部活动");
});
