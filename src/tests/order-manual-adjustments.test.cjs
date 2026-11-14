"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}) {
  const writes = [], notices = [];
  const addon = { id: "extra", key: "service-extra", type: "service", name: "加片", price: 20, enabled: true };
  const order = {
    id: "order-1", orderNo: "ORDER-1", sourceType: "manual", status: "deposit_paid", assigneeId: "service-1",
    totalAmount: 120, depositPaid: 30, finalPaid: 0, finalDiscountAmount: 0, priceAdjustReason: "客户确认",
    products: [{ id: "package-1", type: "package", name: "旅拍套餐", price: 100 }, clone(addon)],
    addons: [clone(addon)], ...overrides
  };
  const state = {
    currentOrder: order, role: "service", orderReadonly: false, filters: {}, listPage: {},
    moneyEdit: "", moneyDraft: 10, selectedAddonKeys: [addon.key], addonDialog: false,
    addonOpen: { common: false, root: false, point: {}, seriesRoot: {}, series: {} }
  };
  const ctx = {
    state, data: { orders: [order], afterSales: [], packages: [], albums: [], addonServices: [addon], peripherals: [], samples: [], spots: [] },
    roleProfile: { value: { staffId: "service-1", name: "客服", menus: ["orders"] } }, currentStaff: { value: null },
    statusDict: [], computed: (getter) => ({ get value() { return getter(); } }), watch() {},
    ElMessage: Object.fromEntries(["error", "warning", "info", "success"].map((kind) => [kind, (message) => notices.push({ kind, message })]))
  };
  const window = { LXM_APP_PARTS: [] };
  const sandbox = { window, LXM_CONFIG: { menus: [{ key: "orders" }] }, LXMFormat: { nowText: () => "2026-11-05 10:00:00" } };
  // Match production factory order: the mutation entry points resolve the later permissions module at call time.
  for (const file of ["02-order-basis.js", "07-service-flow.js", "09-addons.js", "17-misc-pager.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
    if (file === "02-order-basis.js") ctx.persistOrderAction = async (row, action, payload) => {
      writes.push({ id: row.id, action, payload: clone(payload) });
      return row;
    };
  }
  return { ctx, order, addon, writes, notices };
}

const productActions = {
  open: (f) => f.ctx.openAddonDialog(),
  add: (f) => f.ctx.confirmAddon(),
  replace: (f) => f.ctx.replaceOrderProduct({ id: "package-2", name: "新套餐", type: "package", price: 200 }),
  gift: (f) => f.ctx.giftOrderAddon(f.addon),
  remove: (f) => f.ctx.removeAddon(f.addon)
};

test("小程序及二维码订单无法通过操作函数增删、赠送或替换商品", async () => {
  for (const sourceType of ["natural", "shop", "headquarter", undefined]) {
    for (const [action, invoke] of Object.entries(productActions)) {
      const f = fixture({ sourceType });
      const before = JSON.stringify(f.order);
      assert.equal(f.ctx.canManageOrderAddons(f.order), false);
      await invoke(f);
      assert.equal(JSON.stringify(f.order), before, `${sourceType}/${action} must retain the order`);
      assert.equal(f.writes.length, 0, `${sourceType}/${action} must not request a write`);
      assert.equal(f.ctx.state.addonDialog, false);
    }
  }
});

test("普通订单不能开启或直接提交价格、优惠调整", async () => {
  for (const sourceType of ["natural", "shop", "headquarter", undefined]) {
    for (const field of ["totalAmount", "couponAmount"]) {
      const f = fixture({ sourceType });
      const before = JSON.stringify(f.order);
      f.ctx.enableMoneyEdit(field);
      assert.equal(f.ctx.state.moneyEdit, "");
      await f.ctx.confirmMoneyEdit(field);
      assert.equal(JSON.stringify(f.order), before);
      assert.equal(f.writes.length, 0);
    }
  }
});

test("手动录入订单也不能通过直接确认函数修改支付事实或其他字段", async () => {
  for (const field of ["depositPaid", "finalPaid", "status", "depositPaymentStatus"]) {
    const f = fixture();
    const before = JSON.stringify(f.order);
    f.ctx.enableMoneyEdit(field);
    assert.equal(f.ctx.state.moneyEdit, "");
    await f.ctx.confirmMoneyEdit(field);
    assert.equal(JSON.stringify(f.order), before);
    assert.equal(f.writes.length, 0);
  }
});

test("手动录入订单保留商品操作并通过原有更新命令保存", async () => {
  for (const [action, invoke] of Object.entries(productActions)) {
    const f = fixture();
    assert.equal(f.ctx.canManageOrderAddons(f.order), true);
    await invoke(f);
    if (action === "open") {
      assert.equal(f.ctx.state.addonDialog, true);
      assert.equal(f.writes.length, 0);
    } else {
      assert.equal(f.writes.length, 1, action);
      assert.equal(f.writes[0].action, "update");
      assert.ok(f.writes[0].payload.fields.products.length > 0);
      if (action === "replace") assert.equal(f.order.products[0].id, "package-2");
      if (action === "gift") assert.ok(f.order.products.some((row) => row.gift && row.price === 0));
      if (action === "remove") assert.equal(f.order.products.some((row) => row.key === f.addon.key), false);
    }
    assert.equal(f.order.depositPaid, 30);
    assert.equal(f.order.finalPaid, 0);
  }
});

test("手动录入订单仍可调整总价和优惠，支付金额保持原值", async () => {
  for (const [field, next, savedField] of [["totalAmount", 200, "totalAmount"], ["couponAmount", 10, "finalDiscountAmount"]]) {
    const f = fixture();
    f.ctx.enableMoneyEdit(field);
    assert.equal(f.ctx.state.moneyEdit, field);
    f.ctx.state.moneyDraft = next;
    await f.ctx.confirmMoneyEdit(field);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].payload.fields[savedField], next);
    assert.equal(f.order[savedField], next);
    assert.equal(f.order.depositPaid, 30);
    assert.equal(f.order.finalPaid, 0);
  }
});

test("手动录入商品权限检查传入的订单，保留归属、锁定、只读和终态限制", () => {
  const f = fixture();
  const unowned = { ...f.order, id: "other-owner", assigneeId: "service-2" };
  assert.equal(f.ctx.canManageOrderAddons(unowned), false);
  f.ctx.state.currentOrder = unowned;
  assert.equal(f.ctx.canManageOrderAddons(f.order), true, "must inspect the argument instead of the open order");
  for (const patch of [{ financeLocked: true }, { riskBlocked: true }, { status: "completed" }, { status: "cancelled" }]) {
    assert.equal(f.ctx.canManageOrderAddons({ ...f.order, ...patch }), false);
  }
  f.ctx.data.afterSales.push({ id: "af-1", orderId: f.order.id, status: "处理中" });
  assert.equal(f.ctx.canManageOrderAddons(f.order), false);
  f.ctx.data.afterSales = [];
  f.ctx.state.orderReadonly = true;
  assert.equal(f.ctx.canManageOrderAddons(f.order), false);
});

test("开启调整后权限或订单来源变化，确认时重新检查并拒绝写入", async () => {
  for (const change of [
    (f) => { f.order.sourceType = "natural"; },
    (f) => { f.order.financeLocked = true; },
    (f) => { f.ctx.state.orderReadonly = true; }
  ]) {
    const f = fixture();
    f.ctx.enableMoneyEdit("couponAmount");
    assert.equal(f.ctx.state.moneyEdit, "couponAmount");
    f.ctx.state.moneyDraft = 20;
    change(f);
    const before = JSON.stringify(f.order);
    await f.ctx.confirmMoneyEdit("couponAmount");
    await f.ctx.confirmAddon();
    assert.equal(JSON.stringify(f.order), before);
    assert.equal(f.writes.length, 0);
  }
});
