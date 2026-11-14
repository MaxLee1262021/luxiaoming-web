"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function fixture(role = "super") {
  const writes = [], exports = [], picks = [];
  const order = {
    id: "ledger-order", orderNo: "ORDER-LEDGER", customer: "游客", phone: "13800000000",
    status: "deposit_paid", sourceType: "manual", assigneeId: "service-1", depositPaid: 30,
    totalAmount: 100, finalPaid: 0, priceAdjustReason: "保持原价格", products: [], followRecords: []
  };
  const ctx = {
    state: {
      active: "orders", role, currentStaffId: "service-1", orderReadonly: false, orderDrawer: false,
      currentOrder: order, filters: {}, selectedOrderIds: [order.id], transferForm: { batch: false },
      batchNoteText: "备注", moneyDraft: 10, listPage: {}, addonDialog: false, selectedAddonKeys: []
    },
    data: Object.fromEntries(["orders", "afterSales", "shops", "staff", "distributors", "packages", "albums", "peripherals", "addonServices", "spots", "cities", "agents", "series", "samples"].map((key) => [key, key === "orders" ? [order] : []])),
    roleProfile: { value: { staffId: "service-1", scope: role === "super" ? "all" : "orders", name: "当前账号", menus: ["orders", "financeReview", "afterSales"] } },
    currentStaff: { value: null }, selectedOrders: { value: [order] },
    computed: (getter) => ({ get value() { return getter(); } }), reactive: (value) => value,
    watch() {}, onMounted() {}, statusDict: [],
    ElMessage: Object.fromEntries(["error", "warning", "info", "success"].map((key) => [key, () => {}])),
    ElMessageBox: { confirm: async () => {} },
    openExportDialog: (type) => exports.push(type)
  };
  const window = {
    LXM_APP_PARTS: [], LXM_CLOUD_MODE: "mysql", LXM_AUTH: { hasSession: () => true },
    LXM_CLOUD: {
      orderAction: async (id, action, payload) => { writes.push({ id, action, payload }); return { ...order }; },
      create: async (...args) => { writes.push(args); return { id: "unexpected" }; }
    },
    LXM_UPLOAD: { jobs: [], busy: () => false, ready: () => true, pick: (options) => picks.push(options), single: async (_key, action) => action() }
  };
  const sandbox = { window, LXMFormat: { nowText: () => "2026-11-13 12:00:00" } };
  vm.runInNewContext(read("src/config/business-config.js"), sandbox);
  const config = sandbox.LXM_CONFIG = window.LXM_CONFIG;
  ctx.statusDict = config.orderStatuses;
  vm.runInNewContext(read("src/utils/action-confirm.js"), sandbox);
  for (const file of ["02-order-basis.js", "04-scope-rows.js", "06-orders.js", "07-service-flow.js", "09-addons.js", "17-misc-pager.js", "18-files.js"]) {
    vm.runInNewContext(read(`src/app/${file}`), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  }
  return { ctx, order, config, writes, exports, picks };
}

test("原订单路由对超管及客服均只读，保留列表筛选、金额和导出", () => {
  for (const role of ["super", "service"]) {
    const { ctx, order, config, exports } = fixture(role);
    assert.equal(config.menus.find((item) => item.key === "orders").label, "订单流水");
    assert.equal(ctx.isOrderLedgerReadonly(), true);
    assert.equal(ctx.canEditOrder(), false);
    assert.equal(ctx.canClaimOrder({ ...order, assigneeId: "" }), false);
    ctx.openOrder(order, { readonly: false });
    assert.equal(ctx.state.orderReadonly, true, "explicit false must not bypass the ledger restriction");
    assert.equal(ctx.state.orderLedgerDetail, true);
    assert.equal(ctx.canManageOrderRecords(order), false);
    assert.equal(ctx.canOpenOrderForEdit(order), false);
    assert.equal(ctx.scopedOrders.value.length, 1);
    assert.equal(ctx.money(ctx.paid(order)), "¥30.00");
    ctx.state.filters.keyword = "missing";
    assert.equal(ctx.scopedOrders.value.length, 0);
    ctx.state.filters.keyword = "ORDER-LEDGER";
    assert.equal(ctx.scopedOrders.value.length, 1);
    ctx.exportOrders();
    assert.deepEqual(exports, ["orderDetail"]);
  }
});

test("原订单操作被直接调用时也不能写入、上传或改变订单", async () => {
  for (const role of ["super", "service"]) {
    const f = fixture(role), { ctx, order } = f;
    ctx.openOrder(order);
    const before = JSON.stringify(order);
    const actions = [
      () => ctx.batchCancelOrders(), () => ctx.openBatchNoteDialog(), () => ctx.confirmBatchNote(),
      () => ctx.claimOrder({ ...order, assigneeId: "" }), () => ctx.cancelOrder(order),
      () => ctx.openTransferDialog(order), () => ctx.confirmTransferOrder(),
      () => ctx.openOrderExceptionDialog(order), () => ctx.openAfterSaleSubmit(order), () => ctx.submitAfterSale(),
      () => ctx.addFollowLog("不应保存"), () => ctx.saveOrder(),
      () => ctx.openDispatchDialog(), () => ctx.startShooting(order), () => ctx.completeShooting(order),
      () => ctx.openAddonDialog(), () => ctx.replaceOrderProduct({ id: "changed", price: 200 }),
      () => ctx.enableMoneyEdit("totalAmount"), () => ctx.confirmMoneyEdit("totalAmount"),
      () => ctx.uploadDelivery({ ...order, status: "shooting", shootingStartedAt: "now" }),
      () => ctx.deliverOrder(order)
    ];
    for (const action of actions) await action();
    await assert.rejects(ctx.persistOrderAction(order, "note", { reason: "不应保存" }), /订单流水仅供查询与统计/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.picks, []);
    assert.equal(JSON.stringify(order), before);
    assert.equal(ctx.state.batchNoteDialog, undefined);
    assert.equal(ctx.state.transferDialog, undefined);
    assert.equal(ctx.state.exceptionDialog, undefined);
    assert.equal(ctx.state.afterSaleSubmitDialog, undefined);
    assert.equal(ctx.state.addonDialog, false);
  }
});

test("流水详情在切换菜单后仍只读，新开的独立财务详情恢复自身工作流", async () => {
  const { ctx, order, writes } = fixture();
  ctx.openOrder(order);
  ctx.state.active = "financeReview";
  assert.equal(ctx.isOrderLedgerReadonly(), true);
  await assert.rejects(ctx.persistOrderAction(order, "payment"), /订单流水仅供查询与统计/);
  ctx.openOrder(order, { mode: "finance" });
  assert.equal(ctx.state.orderLedgerDetail, false);
  assert.equal(ctx.state.orderReadonly, false);
  assert.equal(ctx.state.orderWorkMode, "finance");
  await ctx.persistOrderAction(order, "payment", { phase: "final" });
  assert.equal(writes.length, 1);
});

test("自定义菜单指向 orders 时同样只读，原编辑实现可由配置恢复", () => {
  const { ctx, order, config } = fixture();
  config.menus.push({ key: "custom-ledger", routeKey: "orders" });
  ctx.state.active = "custom-ledger";
  assert.equal(ctx.isOrderLedgerReadonly(), true);
  ctx.openOrder(order);
  assert.equal(ctx.state.orderReadonly, true);
  config.orderLedgerReadOnly = false;
  ctx.openOrder(order);
  assert.equal(ctx.state.orderReadonly, false);
  assert.equal(ctx.canEditOrder(), true);
  assert.equal(ctx.canManageOrderRecords(order), true);
  assert.equal(ctx.canManageOrderAddons(order), true);
  assert.equal(ctx.canUseOrderExceptionTools(order), true);
});
