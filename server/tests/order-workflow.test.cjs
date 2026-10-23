"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rpc = require("../lib/rpc.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const createApi = require("../lib/api.cjs");
const { createTestWechatPay } = require("./helpers/wechatPay.cjs");

const TEST_WECHAT_PAY = createTestWechatPay();

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeSource() {
  const collections = {
    packages: {
      "package-1": { id: "package-1", name: "测试套餐", price: 100, depositRatio: 30, status: "已上架" },
    },
    albums: {}, peripherals: {}, spots: {}, series: {}, shops: {}, merchantCodes: {},
    siteConfig: { global: { id: "global", customPrice: { depositRatio: 30 } } },
    orders: {}, afterSales: { unrelated: { id: "unrelated", orderId: "other-order", status: "pending" } }, logs: {},
    staff: { admin: { id: "admin", account: "admin", name: "Admin", role: "super", status: "启用", password: "test" } },
  };
  let sequence = 0;
  return {
    collections,
    async list(key) { return Object.values(collections[key] || {}).map(clone); },
    async get(key, id) { return clone(collections[key] && collections[key][id]); },
    async create(key, document) {
      const id = String(document.id || document._id || `${key}-${++sequence}`);
      collections[key] = collections[key] || {};
      if (collections[key][id]) {
        const error = new Error("duplicate"); error.code = "DUPLICATE_RECORD"; throw error;
      }
      collections[key][id] = { ...clone(document), id, _id: id };
      return clone(collections[key][id]);
    },
    async update(key, id, patch) {
      if (!collections[key] || !collections[key][id]) return null;
      collections[key][id] = { ...collections[key][id], ...clone(patch), id, _id: id };
      return clone(collections[key][id]);
    },
    async remove(key, id) {
      if (!collections[key] || !collections[key][id]) return false;
      delete collections[key][id]; return true;
    },
  };
}

function publicIdentity(openid = "customer-openid") {
  return { identity: { kind: "public", openid }, wechatPay: TEST_WECHAT_PAY };
}

test("booking is payable without a customer-selected shooting time and deposit intent is idempotent", async () => {
  const source = makeSource();
  const booking = await rpc(source, "createBooking", {
    data: { expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1.0", current: true },
      name: "测试用户", phone: "13800000000", items: [{ packageId: "package-1" }],
      idempotencyKey: "booking-test-0001",
    },
  }, publicIdentity());
  assert.equal(booking.success, true);
  const order = await source.get("bookingRequests", booking.bookingId);
  assert.equal(order.date, "");
  assert.equal(order.time, "");
  assert.equal(order.depositRatio, 0.3);
  assert.equal(order.depositDue, 30);
  assert.equal(order.finalDue, 70);
  assert.equal(order.workflowStage, workflow.WORKFLOW_STAGES.AWAITING_DEPOSIT);
  assert.deepEqual(order.paymentRecords, []);
  assert.equal(order.customer, "测试用户");
  assert.equal(order.products[0].packageId, "package-1");

  const repeatedBooking = await rpc(source, "createBooking", {
    data: { expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1.0", current: true }, name: "测试用户", phone: "13800000000", items: [{ packageId: "package-1" }], idempotencyKey: "booking-test-0001" },
  }, publicIdentity());
  assert.equal(repeatedBooking.success, true);
  assert.equal(repeatedBooking.idempotent, true);
  assert.equal(repeatedBooking.bookingId, booking.bookingId);

  const intent = await rpc(source, "createPayment", {
    data: { bookingId: booking.bookingId, phase: "deposit", amount: 30, idempotencyKey: "payment-test-0001" },
  }, publicIdentity());
  assert.equal(intent.success, true);
  assert.equal(intent.data.status, "pending");
  assert.equal(intent.data.provider, "wechat_pay");
  assert.equal(intent.data.invokeWeChatPay, true);
  assert.ok(intent.data.paymentParams);

  const repeatIntent = await rpc(source, "createPaymentIntent", {
    data: { bookingId: booking.bookingId, phase: "deposit", amount: 30, idempotencyKey: "payment-test-0001" },
  }, publicIdentity());
  assert.equal(repeatIntent.success, true);
  assert.equal(repeatIntent.data.idempotent, true);

  assert.equal(booking.bookingStatus, "pending_payment");
  assert.equal(booking.orderId, undefined);
  assert.equal(intent.data.orderId, undefined);
  assert.equal((await source.list("orders")).length, 0);
  const publicDetail = await rpc(source, "getOrderDetail", { data: { orderId: booking.bookingId } }, publicIdentity());
  assert.equal(publicDetail.success, false);

});

test("payment relation round-trips all workflow identifiers through normalized MySQL storage", () => {
  const payment = {
    id: "payment-1", phase: "final", selectionAccepted: true, type: "wechat", amount: 70, status: "confirmed", attempt: 2,
    provider: "manual", idempotencyKey: "payment-test-0002", confirmationIdempotencyKey: "confirm-test-0002",
    externalTransactionId: "wx-transaction-2", operator: "finance", operatorId: "finance-1",
    paidAt: "2026-09-12T10:00:00.000Z", createdAt: "2026-09-12T09:00:00.000Z", updatedAt: "2026-09-12T10:00:00.000Z",
    adminRegisteredAt: "2026-09-12T09:30:00.000Z", note: "已核对到账",
  };
  const split = schema.splitDocument("orders", { id: "order-payment", workflowStage: "delivered", depositRatio: 0.3, depositDue: 30, finalDue: 70, paymentRecords: [payment] });
  const relation = split.relations.order_payment_records[0];
  assert.equal(relation.phase, "final");
  assert.equal(relation.payment_id, "payment-1");
  assert.equal(relation.idempotency_key, "payment-test-0002");
  assert.equal(relation.external_transaction_id, "wx-transaction-2");
  const restored = schema.hydrateDocument("orders", { id: split.id, ...split.columns }, { collection_values: split.attributes, ...split.relations });
  assert.equal(restored.workflowStage, "delivered");
  assert.equal(restored.finalDue, 70);
  assert.deepEqual(restored.paymentRecords[0], { ...payment, paymentType: "wechat" });
});

test("completed orders remain in the customer-facing completed state and timeline omits private operators and notes", () => {
  const output = workflow.publicOrderProjection({
    id: "completed-order", status: "completed", totalAmount: 100, depositDue: 30, finalDue: 70,
    depositPaid: 30, finalPaid: 70, depositFinanceStatus: "已审", finalFinanceStatus: "已审",
    statusLogs: [{ type: "后台订单操作", action: "完成订单：内部备注", operator: "admin", operatorId: "staff-1", note: "private", createTime: "2026-09-12T10:00:00.000Z" }],
  }, { detail: true });
  assert.equal(output.workflowStage, workflow.WORKFLOW_STAGES.COMPLETED);
  assert.equal(output.statusText, "已完成");
  assert.equal(output.paymentPhase, "");
  assert.deepEqual(output.statusTimeline, [{ type: "后台订单操作", action: "完成订单", createTime: "2026-09-12T10:00:00.000Z", time: "2026-09-12T10:00:00.000Z" }]);
  assert.equal(JSON.stringify(output).includes("staff-1"), false);
  assert.equal(JSON.stringify(output).includes("private"), false);
});

test("legacy delivery before final payment remains actionable but private to the customer", () => {
  const output = workflow.publicOrderProjection({
    id: "delivered-unpaid", status: "delivered", totalAmount: 100, depositDue: 30, finalDue: 70,
    depositPaid: 30, depositFinanceStatus: "已审", selectionStatus: "confirmed", selectionConfirmedAt: "2026-09-12T09:00:00.000Z",
    deliveryRecord: { method: "wechat", deliveredAt: "2026-09-12T10:00:00.000Z", deliveredBy: "staff-1", note: "private delivery note" },
    deliveredAt: "2026-09-12T10:00:00.000Z",
  });
  assert.equal(output.workflowStage, workflow.WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT);
  assert.equal(output.paymentPhase, "final");
  assert.equal(output.paymentStatus, "not_created");
  assert.equal(output.deliveryRecord, undefined);
  assert.deepEqual(output.deliverFiles, []);
});

test("booking rejects a peripheral-only cart even when the client bypasses its form validation", async () => {
  const source = makeSource();
  source.collections.peripherals["peripheral-1"] = { id: "peripheral-1", name: "定制相册", price: 50, status: "已上架" };
  const result = await rpc(source, "createBooking", {
    data: { expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1.0", current: true }, name: "测试用户", phone: "13800000000", date: "2026-12-20", timePeriod: "上午", items: [{ peripheralId: "peripheral-1" }], idempotencyKey: "booking-test-0003" },
  }, publicIdentity());
  assert.equal(result.success, false);
  assert.equal(result.error, "影像周边需搭配拍摄项目一起预约");
});

test("customer order filters and counts use the five business states", async () => {
  const source = makeSource();
  source.collections.orders = {
    pending: { id: "pending", openid: "customer-openid", status: "new", totalAmount: 100, depositDue: 30, finalDue: 70 },
    dispatch: {
      id: "dispatch", openid: "customer-openid", status: "deposit_paid", totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "已审", finalDue: 70,
      paymentRecords: [{ id: "dispatch-deposit", phase: "deposit", amount: 30, status: "confirmed" }],
    },
    shot: { id: "shot", openid: "customer-openid", status: "final_pending", totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "已审", finalDue: 70, shootingCompletedAt: "2026-09-12T09:00:00.000Z", selectionStatus: "confirmed", selectionConfirmedAt: "2026-09-12T09:30:00.000Z" },
    paid: { id: "paid", openid: "customer-openid", status: "paid", totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "已审", finalDue: 70, finalPaid: 70, finalFinanceStatus: "已审", selectionStatus: "confirmed", selectionConfirmedAt: "2026-09-12T09:30:00.000Z", paymentRecords: [{ id: "paid-deposit", phase: "deposit", amount: 30, status: "confirmed" }, { id: "paid-final", phase: "final", selectionAccepted: true, amount: 70, status: "confirmed" }] },
    delivered: { id: "delivered", openid: "customer-openid", status: "delivered", totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "已审", finalDue: 70, finalPaid: 70, finalFinanceStatus: "已审", selectionStatus: "confirmed", selectionConfirmedAt: "2026-09-12T09:30:00.000Z", deliveryRecord: { method: "wechat" }, deliveredAt: "2026-09-12T10:00:00.000Z", paymentRecords: [{ id: "delivered-deposit", phase: "deposit", amount: 30, status: "confirmed" }, { id: "delivered-final", phase: "final", selectionAccepted: true, amount: 70, status: "confirmed" }] },
  };
  for (const [status, expected] of [["pending_payment", []], ["reserved", ["dispatch"]], ["awaiting_shoot", []], ["shooting", ["shot"]], ["completed", ["paid", "delivered"]]]) {
    const result = await rpc(source, "getMyOrders", { data: { status, page: 1, pageSize: 20 } }, publicIdentity());
    assert.deepEqual(new Set(result.data.map((row) => row.id)), new Set(expected));
  }
  const counts = await rpc(source, "getOrderStatusCount", { data: {} }, publicIdentity());
  assert.deepEqual(counts.data.businessStatus, { pending_payment: 0, reserved: 1, awaiting_shoot: 0, shooting: 1, completed: 2 });
});

test("manual order creation cannot bypass the paid checkout", async () => {
  const source = makeSource();
  source.collections.packages["package-1"].depositRatio = 50;
  const auth = {
    async init() {},
    async getSession(token) { return token === "admin-token" ? { kind: "admin", account: "admin", name: "Admin", role: "super", subjectId: "admin", menuKeys: ["orders"], expiresAt: Date.now() + 60000 } : null; },
    async createSession() { return { token: "unused", expiresAt: Date.now() + 60000, ttlMs: 60000 }; },
    async recordLoginFailure() { return { blocked: false }; }, async clearLoginFailures() {}, async health() { return { backend: "memory", ready: true }; },
  };
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
  const request = require("node:http");
  const server = request.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/collection/orders`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token" },
      body: JSON.stringify({ orderNo: "MANUAL-1", totalAmount: 100, products: [{ id: "package-1", type: "package" }], depositRatio: 1, depositPaid: 100, finalPaid: 100, status: "completed" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await source.list("orders")).length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
