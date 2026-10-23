"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

function fixture(role = "service") {
  const calls = [];
  const window = { LXM_APP_PARTS: [] };
  const config = { roles: { service: {}, super: {} }, menus: [{ key: "orders" }, { key: "tasks" }], visibleStatus: [] };
  const state = { role, currentStaffId: "s1", orderReadonly: false, currentOrder: null, filters: {}, transferForm: { batch: false }, timelineCategoryFilter: "" };
  const ctx = {
    state, data: { orders: [], afterSales: [], shops: [], staff: [], distributors: [], packages: [], albums: [], peripherals: [], addonServices: [], spots: [], cities: [], agents: [], series: [], samples: [] },
    roleProfile: { value: { staffId: "s1", scope: "orders", menus: ["orders", "tasks"] } },
    computed: (fn) => ({ get value() { return fn(); } }), currentStaff: { value: null }, schedulePersist() {},
    statusDict: [{ value: "reserved", label: "已预约" }, { value: "awaiting_shoot", label: "待拍摄" }, { value: "shooting", label: "拍摄中" }, { value: "completed", label: "已完成" }],
    ElMessage: { error() {}, warning() {}, info() {}, success() {} }, ElMessageBox: { confirm: async () => {} }, selectedOrders: { value: [] },
  };
  const sandbox = { window, LXM_CONFIG: config, LXMFormat: { nowText: () => "2026-10-14 10:00:00", date: () => "2026-10-14" }, navigator: {} };
  for (const file of ["02-order-basis.js", "04-scope-rows.js", "07-service-flow.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
    if (file === "02-order-basis.js") ctx.persistOrderAction = async (order, action, payload) => { calls.push({ action, payload }); return order; };
  }
  return { ctx, calls };
}

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
  const cases = [["deposit_paid", 0], ["assigned", 1], ["shooting", 2], ["completed", 3]];
  for (const [status, index] of cases) assert.equal(ctx.serviceFlowIndex({ status }), index, status);
  assert.equal(ctx.workflowStageOf({ status: "shooting", deliveryRecord: { method: "现场交付" } }), "shooting");
  assert.equal(ctx.workflowStageOf({ status: "completed", deliveryRecord: null }), "completed");
  assert.equal(ctx.canRegisterFinalPayment({ status: "shooting" }), false);
  assert.equal(ctx.canCompleteWorkflow({ status: "shooting" }), false);
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
  const assigned = { id: "o1", status: "assigned", assigneeId: "s1" };
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
