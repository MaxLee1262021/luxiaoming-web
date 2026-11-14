"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

function fixture(role = "service", { useLocalPersistence = false, loadOrders = false } = {}) {
  const calls = [];
  const window = { LXM_APP_PARTS: [] };
  const config = { roles: { service: {}, super: {} }, menus: [{ key: "orders" }, { key: "tasks" }], visibleStatus: [] };
  const state = { role, currentStaffId: "s1", orderReadonly: false, currentOrder: null, filters: {}, transferForm: { batch: false }, timelineCategoryFilter: "" };
  const ctx = {
    state, data: { orders: [], afterSales: [], shops: [], staff: [], distributors: [], packages: [], albums: [], peripherals: [], addonServices: [], spots: [], cities: [], agents: [], series: [], samples: [] },
    roleProfile: { value: { staffId: "s1", scope: "orders", menus: ["orders", "tasks"] } },
    computed: (fn) => ({ get value() { return fn(); } }), currentStaff: { value: null }, schedulePersist() {},
    statusDict: [{ value: "reserved", label: "待确认" }, { value: "awaiting_shoot", label: "待拍摄" }, { value: "shooting", label: "拍摄中" }, { value: "completed", label: "已完成" }],
    ElMessage: { error() {}, warning() {}, info() {}, success() {} }, ElMessageBox: { confirm: async () => {} }, selectedOrders: { value: [] },
    onMounted() {},
  };
  const sandbox = { window, LXM_CONFIG: config, LXMFormat: { nowText: () => "2026-10-14 10:00:00", date: () => "2026-10-14" }, navigator: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/utils/action-confirm.js"), "utf8"), sandbox);
  const files = ["02-order-basis.js", "04-scope-rows.js", ...(loadOrders ? ["06-orders.js"] : []), "07-service-flow.js"];
  for (const file of files) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
    if (file === "02-order-basis.js" && !useLocalPersistence) ctx.persistOrderAction = async (order, action, payload) => { calls.push({ action, payload }); return order; };
  }
  return { ctx, calls, window };
}

function refundReviewFixture() {
  const f = fixture("super", { loadOrders: true });
  f.ctx.state.logs = [];
  f.ctx.isServerConnected = () => true;
  const order = { id: "refund-order", orderNo: "REFUND-ONE", status: "deposit_paid", depositDue: 30, depositPaid: 30 };
  const ticket = { id: "refund-ticket", orderId: order.id, refundAmount: 30, financeStatus: "待审", status: "pending", logs: [] };
  const row = { id: "refund-review", afterSaleId: ticket.id, orderId: order.id, status: "待审" };
  f.ctx.data.orders.push(order);
  f.ctx.data.afterSales.push(ticket);
  f.ctx.state.currentFinanceReview = { ...row };
  Object.assign(f.window, { LXM_CLOUD_MODE: "mysql", LXM_AUTH: { hasSession: () => true } });
  f.window.LXM_CLOUD = { async afterSaleAction(id, action, payload) {
    f.calls.push({ id, action, payload });
    return { ticket: { ...ticket, financeStatus: payload.approved ? "已审" : "已驳", refundStatus: payload.approved ? "processing" : "rejected", refundConfirmed: false, status: "pending", customerVisibleStatus: payload.approved ? "微信退款处理中" : "处理" }, order: { ...order } };
  } };
  return { ...f, order, ticket, row };
}

test("order and refund amounts retain cents in the admin display", () => {
  const { ctx } = fixture();
  const order = { totalAmount: 0.1, depositPaid: 0.04, depositPaymentStatus: "confirmed", depositFinanceStatus: "已审", finalPaid: 0 };
  assert.equal(ctx.money(order.totalAmount), "¥0.10");
  assert.equal(ctx.money(order.depositPaid), "¥0.04");
  assert.equal(ctx.money(ctx.financePaid(order)), "¥0.04");
  assert.equal(ctx.money(ctx.due(order)), "¥0.06");
  assert.equal(ctx.money({ refundAmount: 0.04 }.refundAmount), "¥0.04");
  assert.equal(order.depositPaid, 0.04, "formatting does not change the recorded payment");
});

test("currency formatting keeps two decimal places for totals, adjustments and missing values", () => {
  const { ctx } = fixture();
  for (const [amount, expected] of [[0, "¥0.00"], [0.01, "¥0.01"], [0.99, "¥0.99"],
    [1, "¥1.00"], [1234.56, "¥1,234.56"], ["0.04", "¥0.04"], [-0.04, "¥-0.04"],
    [0.1 + 0.2, "¥0.30"], [undefined, "¥0.00"], [null, "¥0.00"], [NaN, "¥0.00"]]) {
    assert.equal(ctx.money(amount), expected, String(amount));
  }
});

test("refund approval submits online refund without manual proof or claiming success", async () => {
  const f = refundReviewFixture();
  f.ctx.ElMessageBox.prompt = async () => { assert.fail("online refund must not ask for manual transaction proof"); };
  await f.ctx.applyRefundReview(f.row, true);
  assert.equal(f.calls[0].payload.refundTransactionId, undefined);
  assert.equal(f.calls[0].payload.refundMethod, undefined);
  assert.equal(f.calls[0].payload.approved, true);
  assert.equal(f.ticket.refundStatus, "processing");
  assert.equal(f.ticket.refundConfirmed, false);
  assert.equal(f.ticket.status, "pending");
  assert.equal(f.order.status, "deposit_paid");
});

test("only a confirmed refund response applies cancellation and the successful refund state", async () => {
  const f = refundReviewFixture();
  f.window.LXM_CLOUD.afterSaleAction = async () => ({ ticket: { ...f.ticket, financeStatus: "已审", refundConfirmed: true, refundStatus: "refunded", status: "completed" }, order: { ...f.order, status: "cancelled" } });
  await f.ctx.applyRefundReview(f.row, true);
  assert.equal(f.ticket.refundConfirmed, true);
  assert.equal(f.ticket.refundStatus, "refunded");
  assert.equal(f.order.status, "cancelled");
});

test("rejecting a refund does not request transaction proof", async () => {
  const f = refundReviewFixture();
  f.ctx.ElMessageBox.prompt = async () => { assert.fail("refund rejection must not ask for payment proof"); };
  await f.ctx.applyRefundReview(f.row, false);
  assert.equal(f.calls[0].payload.approved, false);
  assert.equal(f.calls[0].payload.refundTransactionId, undefined);
  assert.equal(f.order.status, "deposit_paid");
});

test("a failed online refund review preserves all visible state instead of claiming completion", async () => {
  const f = refundReviewFixture();
  f.ctx.ElMessageBox.prompt = async () => ({ value: "refund-proof-1" });
  f.window.LXM_CLOUD.afterSaleAction = async () => { throw new Error("review unavailable"); };
  await f.ctx.applyRefundReview(f.row, true);
  assert.equal(f.ticket.refundTransactionId, undefined);
  assert.equal(f.ticket.financeStatus, "待审");
  assert.equal(f.row.status, "待审");
  assert.equal(f.ctx.state.currentFinanceReview.status, "待审");
  assert.equal(f.order.status, "deposit_paid");
});

test("service ownership permits claim queue viewing but forbids edits until claimed", () => {
  const { ctx } = fixture();
  const queued = { id: "q", status: "deposit_paid" };
  assert.equal(ctx.inRoleScope(queued), true);
  assert.equal(ctx.canClaimOrder(queued), true);
  assert.equal(ctx.canEditCurrentOrder(queued), false);
  assert.equal(ctx.canManageOrderRecords(queued), false);
  assert.equal(ctx.inRoleScope({ ...queued, assigneeId: "s2", staffId: "s1" }), false);
  const owned = { ...queued, assigneeId: "s1" };
  assert.equal(ctx.canEditCurrentOrder(owned), true);
  assert.equal(ctx.canManageOrderRecords({ ...owned, status: "completed" }), true);
  assert.equal(ctx.canEditCurrentOrder({ ...owned, status: "completed" }), false);
});

test("paid reservations begin the four service stages and retain final-payment behavior", () => {
  const { ctx } = fixture();
  assert.deepEqual(Array.from(ctx.serviceFlowSteps, (step) => step.key), ["reserved", "dispatch", "shoot", "completed"]);
  assert.deepEqual(Array.from(ctx.serviceFlowSteps, (step) => step.label), ["待确认", "待拍摄", "拍摄中", "已完成"]);
  const cases = [["deposit_paid", 0], ["assigned", 1], ["shooting", 2], ["completed", 3]];
  for (const [status, index] of cases) assert.equal(ctx.serviceFlowIndex({ status, ...(status === "assigned" ? { photographerId: "photo-1" } : {}) }), index, status);
  assert.equal(ctx.workflowStageOf({ status: "shooting", deliveryRecord: { method: "现场交付" } }), "shooting");
  assert.equal(ctx.workflowStageOf({ status: "completed", deliveryRecord: null }), "completed");
  assert.equal(ctx.canRegisterFinalPayment({ status: "shooting" }), false);
  assert.equal(ctx.canCompleteWorkflow({ status: "shooting" }), false);
});

test("disconnected fulfilment rejects all writes without inventing order state", async () => {
  const { ctx } = fixture("service", { useLocalPersistence: true });
  const order = { id: "full-flow", status: "deposit_paid", assigneeId: "s1", totalAmount: 100, depositPaid: 30 };
  const before = JSON.stringify(order);
  for (const action of ["assign", "start", "shootcomplete", "selectionconfirm", "deliver", "complete", "cancel", "followup", "note", "payment"]) {
    await assert.rejects(ctx.persistOrderAction(order, action, { photographerId: "photo-1", fields: { totalAmount: 999 }, phase: "final", paymentStatus: "confirmed" }), /真实后端连接不可用/);
    assert.equal(JSON.stringify(order), before);
  }
});

test("order mutations apply only the acknowledged server response", async () => {
  const f = fixture("service", { useLocalPersistence: true });
  const order = { id: "ack", status: "deposit_paid", depositPaid: 30 };
  Object.assign(f.window, { LXM_CLOUD_MODE: "mysql", LXM_AUTH: { hasSession: () => true }, LXM_API_STATE: { reachable: true }, LXM_CLOUD: {
    orderAction: async (id, action, payload) => { f.calls.push({ id, action, payload }); return { id, status: "assigned", photographerId: "server-photo", depositRefundable: false }; }
  } });
  await f.ctx.persistOrderAction(order, "assign", { photographerId: "requested-photo" });
  assert.equal(f.calls[0].payload.photographerId, "requested-photo");
  assert.equal(order.photographerId, "server-photo");
  assert.equal(order.status, "assigned");
  assert.equal(order.depositRefundable, false);
  const before = JSON.stringify(order);
  f.window.LXM_CLOUD.orderAction = async () => { throw new Error("保存失败"); };
  await assert.rejects(f.ctx.persistOrderAction(order, "unassign"), /保存失败/);
  assert.equal(JSON.stringify(order), before);
});

test("unpaid legacy rows stay outside orders, reminders and service actions", () => {
  const { ctx } = fixture();
  const paid = { id: "paid", orderNo: "PAID", status: "deposit_paid", depositDue: 100, depositPaid: 100, assigneeId: "s1" };
  const legacy = ["pending_payment", "new", "pending", "contacted", "confirmed", "deposit_pending"]
    .map((status) => ({ id: status, orderNo: status, status, customerStatus: "reserved", depositDue: 100, depositPaid: 0, assigneeId: "s1" }));
  ctx.data.orders = [paid, ...legacy];
  assert.deepEqual(Array.from(ctx.scopedOrders.value, (row) => row.id), ["paid"]);
  assert.deepEqual(Array.from(ctx.reminderBaseOrders.value, (row) => row.id), ["paid"]);
  for (const order of legacy) {
    assert.equal(ctx.orderBusinessStatus(order), "");
    assert.equal(ctx.serviceFlowIndex(order), -1);
    assert.equal(ctx.serviceCustomerStatusLabel(order), "-");
    assert.equal(ctx.canManageOrderRecords(order), false);
    assert.equal(ctx.canDispatchOrder(order), false);
    assert.equal(ctx.canClaimOrder({ ...order, assigneeId: "" }), false);
  }
  assert.equal(ctx.orderBusinessStatus({ status: "confirmed", depositPaid: 100 }), "reserved");
  assert.equal(ctx.orderBusinessStatus({ status: "deposit_paid", depositDue: 0, depositPaid: 0 }), "reserved");
  assert.equal(ctx.orderBusinessStatus({ status: "completed", depositDue: 100, depositPaid: 0, refundedAmount: 100 }), "completed");
  assert.equal(ctx.orderBusinessStatus({}), "");
});

test("current service starts shooting, completed orders remain eligible for independent delivery", async () => {
  const { ctx, calls } = fixture();
  const assigned = { id: "o1", status: "assigned", photographerId: "photo-1", assigneeId: "s1" };
  ctx.state.currentOrder = assigned;
  assert.equal(ctx.canStartTask(assigned), true);
  await ctx.startShooting(assigned);
  assert.equal(calls[0].action, "start");
  const completed = { ...assigned, status: "completed" };
  assert.equal(ctx.canDeliverOrder(completed), true);
  const photo = fixture("photo");
  assert.equal(photo.ctx.canStartTask(assigned), false);
  assert.equal(photo.ctx.canDeliverOrder(completed), false);
});

test("service transfer uses the dedicated command and followup list excludes audit timelines", async () => {
  const { ctx, calls } = fixture();
  const order = { id: "o1", status: "deposit_paid", assigneeId: "s1", followRecords: [{ id: "f1", type: "customer_followup", followupType: "delivery", content: "交付后跟进" }, { id: "a1", type: "后台订单操作", action: "开始拍摄" }] };
  ctx.state.currentOrder = order;
  ctx.state.transferForm = { assigneeId: "s2", photographerId: "", batch: false, note: "客服交接" };
  await ctx.confirmTransferOrder();
  assert.equal(calls[0].action, "transfer");
  assert.equal(calls[0].payload.assigneeId, "s2");
  assert.deepEqual(Array.from(ctx.orderFollowRecords(order), (row) => row.id), ["f1"]);
});
