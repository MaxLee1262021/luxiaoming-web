"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const { createTestWechatPay, createTestRefundGateway, confirmTestPayment } = require("./helpers/wechatPay.cjs");

const TEST_WECHAT_PAY = createTestWechatPay();

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeSource() {
  const collections = {
    packages: {
      "package-1": { id: "package-1", name: "Package", price: 100, depositRatio: 30, status: "published" },
    },
    albums: {},
    peripherals: {},
    spots: {},
    series: {},
    shops: {},
    merchantCodes: {},
    siteConfig: { global: { id: "global", bookingNotice: ["Synthetic test booking notice"], bookingNoticeVersion: "v1.0", customPrice: { depositRatio: 30 } } },
    orders: {},
    afterSales: {},
    logs: {},
    staff: {
      super: { id: "super", account: "super", role: "super", status: "active" },
      service: { id: "service", account: "service", role: "service", status: "active" },
      finance: { id: "finance", account: "finance", role: "finance", status: "active" },
      photo: { id: "photo", account: "photo", role: "photo", status: "active" },
      "photo-other": { id: "photo-other", account: "photo-other", role: "photo", status: "active" },
    },
  };
  let sequence = 0;
  return {
    collections,
    async list(key) { return Object.values(collections[key] || {}).map(clone); },
    async get(key, id) { return clone(collections[key] && collections[key][String(id)]) || null; },
    async create(key, document) {
      const id = String(document.id || document._id || `${key}-${++sequence}`);
      collections[key] ||= {};
      if (collections[key][id]) {
        const error = new Error("duplicate record"); error.code = "DUPLICATE_RECORD"; throw error;
      }
      if (key === "orders" && document.orderNo && Object.values(collections.orders).some((row) => row.orderNo === document.orderNo)) {
        const error = new Error("duplicate order number"); error.code = "ER_DUP_ENTRY"; throw error;
      }
      collections[key][id] = { ...clone(document), id, _id: id };
      return clone(collections[key][id]);
    },
    async update(key, id, patch) {
      const current = collections[key] && collections[key][String(id)];
      if (!current) return null;
      collections[key][String(id)] = { ...current, ...clone(patch), id: String(id), _id: String(id) };
      return clone(collections[key][String(id)]);
    },
    async remove(key, id) {
      if (!collections[key] || !collections[key][String(id)]) return false;
      delete collections[key][String(id)];
      return true;
    },
  };
}

function publicIdentity(openid) {
  return { identity: { kind: "public", openid }, wechatPay: TEST_WECHAT_PAY };
}

function confirmedOrder(id, openid = "owner") {
  const snapshot = {
    appointmentAt: "2026-12-20",
    timePeriod: "morning",
    appointmentLocation: "test location",
    peopleCount: 2,
    serviceContent: "portrait service",
    totalAmount: 100,
    depositRatio: 0.3,
    depositDue: 30,
    finalDue: 70,
  };
  return {
    id,
    _id: id,
    orderNo: `ORDER-${id}`,
    openid,
    status: "confirmed",
    totalAmount: 100,
    totalPrice: 100,
    price: 100,
    depositRatio: 0.3,
    depositDue: 30,
    finalDue: 70,
    depositPaid: 0,
    finalPaid: 0,
    appointmentAt: "2026-12-20",
    timePeriod: "morning",
    appointmentLocation: "test location",
    peopleCount: 2,
    serviceContent: "portrait service",
    serviceConfirmedAt: "2026-09-18T00:00:00.000Z",
    confirmationSnapshot: snapshot,
    paymentRecords: [{ id: `${id}-deposit`, phase: "deposit", amount: 30, status: "not_created" }],
    statusLogs: [],
    followRecords: [],
  };
}

function depositPaidOrder(id, openid = "owner") {
  return {
    ...confirmedOrder(id, openid),
    status: "deposit_paid",
    depositPaid: 30,
    depositFinanceStatus: "confirmed",
    paymentRecords: [{ id: `${id}-deposit-confirmed`, phase: "deposit", amount: 30, status: "confirmed", provider: "manual" }],
  };
}

async function withPaymentEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("booking uses the verified owner, leaves shooting time for manual confirmation, and rejects ambiguous order numbers", async () => {
  const source = makeSource();
  const request = {
    expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1.0", current: true },
    name: "Customer",
    phone: "13800000000",
    items: [{ packageId: "package-1" }],
    idempotencyKey: "booking-owner-0001",
    openid: "spoofed-owner",
  };
  const unauthenticated = await rpc(source, "createBooking", { data: request });
  assert.equal(unauthenticated.success, false);

  const created = await rpc(source, "createBooking", { data: request }, publicIdentity("owner"));
  assert.equal(created.success, true);
  const order = await source.get("bookingRequests", created.bookingId);
  assert.equal(order.openid, "owner");
  assert.equal(order.workflowStage, workflow.WORKFLOW_STAGES.AWAITING_DEPOSIT);
  assert.equal(order.date, "");
  assert.equal(order.timePeriod, "");
  assert.deepEqual(order.paymentRecords, []);
  assert.match(order.orderNo, /^LS\d{8}[A-F0-9]{10}$/);

  const repeated = await rpc(source, "createBooking", { data: request }, publicIdentity("owner"));
  assert.equal(repeated.success, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.bookingId, created.bookingId);
  assert.equal(Object.keys(source.collections.orders).length, 0);
  assert.equal((await source.list("bookingRequests")).length, 1);

  const reusedByAnotherOwner = await rpc(source, "createBooking", { data: request }, publicIdentity("other-owner"));
  assert.equal(reusedByAnotherOwner.success, false);

  const noSlot = await rpc(source, "createBooking", {
    data: { expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "v1.0", current: true }, ...request, idempotencyKey: "booking-owner-0002", date: "", timePeriod: "" },
  }, publicIdentity("owner"));
  assert.equal(noSlot.success, true);

  source.collections.orders["duplicate-a"] = { id: "duplicate-a", orderNo: "DUPLICATE-ORDER", openid: "owner", status: "new" };
  source.collections.orders["duplicate-b"] = { id: "duplicate-b", orderNo: "DUPLICATE-ORDER", openid: "owner", status: "new" };
  const ambiguous = await rpc(source, "getOrderDetail", { data: { orderNo: "DUPLICATE-ORDER" } }, publicIdentity("owner"));
  assert.equal(ambiguous.success, false);
  assert.match(ambiguous.error, /订单号/);

  const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_authz.sql"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `lxm_orders`[\s\S]*?UNIQUE KEY `uq_order_number` \(`orderNo`\)/);
});

test("public status filters use the five customer-facing business states", async () => {
  const source = makeSource();
  source.collections.orders.confirmation = { id: "confirmation", openid: "owner", status: "new", totalAmount: 100, depositDue: 30, finalDue: 70 };
  source.collections.orders.dispatch = {
    ...confirmedOrder("dispatch"),
    openid: "owner",
    status: "deposit_paid",
    depositPaid: 30,
    depositFinanceStatus: "confirmed",
    paymentRecords: [{ id: "dispatch-deposit", phase: "deposit", amount: 30, status: "confirmed", provider: "manual" }],
  };
  source.collections.orders.assigned = {
    ...confirmedOrder("assigned"),
    openid: "owner",
    status: "assigned",
    depositPaid: 30,
    depositFinanceStatus: "confirmed",
    photographerId: "photo",
    dispatchRecord: { id: "dispatch-record" },
    paymentRecords: [{ id: "assigned-deposit", phase: "deposit", amount: 30, status: "confirmed", provider: "manual" }],
  };
  source.collections.orders.completed = { ...confirmedOrder("completed"), openid: "owner", status: "delivered", depositPaid: 30, finalPaid: 70, depositFinanceStatus: "confirmed", finalFinanceStatus: "confirmed", selectionStatus: "confirmed", selectionConfirmedAt: "2026-09-20T10:00:00.000Z", deliveryRecord: { method: "wechat" }, deliveredAt: "2026-09-20T11:00:00.000Z", paymentRecords: [{ id: "completed-deposit", phase: "deposit", amount: 30, status: "confirmed" }, { id: "completed-final", phase: "final", selectionAccepted: true, amount: 70, status: "confirmed" }] };

  const pending = await rpc(source, "getMyOrders", { data: { status: "pending_payment", page: 1, pageSize: 20 } }, publicIdentity("owner"));
  assert.deepEqual(pending.data.map((row) => row.id), []);
  const confirmed = await rpc(source, "getMyOrders", { data: { status: "reserved", page: 1, pageSize: 20 } }, publicIdentity("owner"));
  assert.deepEqual(new Set(confirmed.data.map((row) => row.id)), new Set(["dispatch"]));
  const completed = await rpc(source, "getMyOrders", { data: { status: "delivered", page: 1, pageSize: 20 } }, publicIdentity("owner"));
  assert.deepEqual(completed.data.map((row) => row.id), ["completed"]);
});

test("paid bookings reject retired service confirmation and generic order writes cannot bypass payment", async (t) => {
  const source = makeSource();
  source.collections.orders.order = {
    id: "order",
    orderNo: "ORDER-CONFIRM",
    openid: "owner",
    status: "deposit_paid",
    depositPaid: 30, depositFinanceStatus: "confirmed",
    totalAmount: 100,
    totalPrice: 100,
    price: 100,
    depositRatio: 0.3,
    depositDue: 30,
    finalDue: 70,
    paymentRecords: [{ id: "paid-checkout", phase: "deposit", amount: 30, status: "confirmed" }],
    productItems: [{ packageId: "package-1", price: 100 }],
  };
  const sessions = {
    "super-token": { kind: "admin", subjectId: "super", account: "super", role: "super", menuKeys: ["orders"] },
  };
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]); } };
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, method = "POST") => {
    const response = await fetch(base + route, {
      method,
      headers: { Authorization: "Bearer super-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const retiredConfirmation = await post("/api/orders/order/action", { action: "accept", reason: "paid checkout already created the booking" });
  assert.equal(retiredConfirmation.status, 409);

  const genericWrite = await post("/api/collection/orders/order", { status: "completed" }, "PUT");
  assert.equal(genericWrite.status, 403);

  source.collections.orders.superFinance = confirmedOrder("superFinance");
  const legacyUnpaid = await post("/api/orders/superFinance/action", {
    action: "payment", phase: "deposit", paymentStatus: "confirmed", amount: 30,
    idempotencyKey: "super-approve-deposit-0001", externalTransactionId: "super-deposit-tx-0001", reason: "legacy unpaid booking",
  });
  assert.equal(legacyUnpaid.status, 403);
});

test("customer cancellation uses one guarded contract for both public RPC names", async () => {
  const source = makeSource();
  source.collections.orders.fresh = { id: "fresh", orderNo: "FRESH", openid: "owner", status: "new", totalAmount: 100, depositDue: 30, finalDue: 70, paymentRecords: [] };
  const cancelled = await rpc(source, "cancelOrder", {
    data: { orderId: "fresh", reason: "schedule changed", idempotencyKey: "cancel-fresh-0001" },
  }, publicIdentity("owner"));
  assert.equal(cancelled.success, true);
  const repeatedByLegacyRoute = await rpc(source, "updateOrderStatus", {
    data: { orderId: "fresh", newStatus: "canceled", reason: "schedule changed", idempotencyKey: "cancel-fresh-0001" },
  }, publicIdentity("owner"));
  assert.equal(repeatedByLegacyRoute.success, true);
  assert.equal(repeatedByLegacyRoute.data.idempotent, true);

  source.collections.orders.confirmed = confirmedOrder("confirmed", "owner");
  const afterConfirmation = await rpc(source, "cancelOrder", {
    data: { orderId: "confirmed", reason: "too late", idempotencyKey: "cancel-confirmed-0001" },
  }, publicIdentity("owner"));
  assert.equal(afterConfirmation.success, true);

  source.collections.orders.afterSale = { id: "afterSale", orderNo: "AFTER-SALE", openid: "owner", status: "new", totalAmount: 100, depositDue: 30, finalDue: 70, afterSaleStatus: "pending", paymentRecords: [] };
  source.collections.afterSales.ticket = { id: "ticket", orderId: "afterSale", status: "pending" };
  const beforeScheduleWithSupport = await rpc(source, "cancelOrder", {
    data: { orderId: "afterSale", reason: "support open", idempotencyKey: "cancel-after-sale-0001" },
  }, publicIdentity("owner"));
  assert.equal(beforeScheduleWithSupport.success, true, "an open support request does not prevent cancellation before scheduling");
  assert.equal(source.collections.orders.afterSale.status, "cancelled");
});

test("runtime payment flags cannot enable simulated confirmations or fake WeChat gateways", { concurrency: false }, async () => {
  const source = makeSource();
  source.collections.orders.deposit = confirmedOrder("deposit", "owner");
  const before = clone(source.collections.orders.deposit);
  for (const environment of [
    { NODE_ENV: "test", DATA_MODE: "json", LXM_ALLOW_TEST_JSON_SOURCE: "true", TEST_PAYMENT_ENABLED: "true", PAYMENT_MODE: "mock", WECHAT_PAY_MOCK_MODE: "true" },
    { NODE_ENV: "production", DATA_MODE: "mysql", TEST_PAYMENT_ENABLED: "true", PAYMENT_MODE: "test", WECHAT_PAY_MOCK_MODE: "true" },
  ]) {
    await withPaymentEnvironment(environment, async () => {
      const gateway = require("../lib/wechatPay.cjs").createWechatPay({ env: environment, testStub: true });
      assert.equal(gateway.isConfigured(), false, "runtime environment flags cannot manufacture a configured gateway");
      const context = { identity: { kind: "public", openid: "owner" }, wechatPay: gateway };
      const testResult = await rpc(source, "testPayment", { orderId: "deposit", phase: "deposit", idempotencyKey: "retired-test-payment" }, context);
      assert.equal(testResult.success, false);
      const result = await rpc(source, "createPayment", { orderId: "deposit", phase: "deposit", idempotencyKey: "real-config-required" }, context);
      assert.equal(result.success, false); assert.match(result.error, /微信支付.*配置/);
      assert.deepEqual(source.collections.orders.deposit, before, "failed real payment cannot change payment facts");
    });
  }
});

test("dispatch conflicts, publication gates, and online refunds enforce server-side facts", async (t) => {
  const source = makeSource();
  t.after(() => require("../lib/wechatPay.cjs").drainMerchantShare(source));
  source.collections.orders["dispatch-target"] = depositPaidOrder("dispatch-target", "owner");
  source.collections.orders["busy-photographer"] = {
    ...depositPaidOrder("busy-photographer", "other-owner"),
    status: "assigned",
    photographerId: "photo",
    appointmentAt: "2026-12-20",
    timePeriod: "morning",
    appointmentLocation: "test location",
    peopleCount: 2,
    dispatchRecord: { id: "busy-dispatch" },
  };
  source.collections.orders.selection = {
    ...depositPaidOrder("selection", "owner"),
    status: "final_pending",
    photographerId: "photo",
    shootingStartedAt: "2026-09-18T01:00:00.000Z",
    shootingCompletedAt: "2026-09-18T02:00:00.000Z",
    selectionStatus: "pending",
  };
  source.collections.orders.task = {
    ...depositPaidOrder("task", "owner"),
    status: "assigned",
    photographerId: "photo",
    dispatchStatus: "pending_acceptance",
    taskStatus: "pending_acceptance",
    dispatchRecord: { id: "task-dispatch" },
    dispatchRecords: [{ id: "task-dispatch", type: "assign", reason: "initial assignment" }],
  };
  source.collections.orders.unable = {
    ...depositPaidOrder("unable", "owner"),
    status: "assigned",
    photographerId: "photo",
    dispatchStatus: "pending_acceptance",
    taskStatus: "pending_acceptance",
    dispatchRecord: { id: "unable-dispatch" },
    dispatchRecords: [{ id: "unable-dispatch", type: "assign", reason: "initial assignment" }],
  };
  source.collections.orders.refund = depositPaidOrder("refund", "owner");
  source.collections.orders["refund-duplicate"] = depositPaidOrder("refund-duplicate", "other-owner");
  for (const id of ["refund", "refund-duplicate"]) Object.assign(source.collections.orders[id].paymentRecords[0], {
    provider: "wechat_pay", outTradeNo: `PAY_${id}`, externalTransactionId: `WX_TX_${id}`,
  });
  source.collections.afterSales["refund-ticket"] = { id: "refund-ticket", orderId: "refund", status: "处理", financeStatus: "", refundAmount: 0, logs: [] };
  source.collections.afterSales["refund-duplicate-ticket"] = { id: "refund-duplicate-ticket", orderId: "refund-duplicate", status: "处理", financeStatus: "", refundAmount: 0, logs: [] };

  const sessions = {
    "super-token": { kind: "admin", subjectId: "super", account: "super", role: "super", menuKeys: ["orders", "afterSales"] },
    "service-token": { kind: "admin", subjectId: "service", account: "service", role: "service", menuKeys: ["orders"] },
    "photo-token": { kind: "admin", subjectId: "photo", account: "photo", role: "photo", menuKeys: ["tasks"] },
    "other-photo-token": { kind: "admin", subjectId: "photo-other", account: "photo-other", role: "photo", menuKeys: ["tasks"] },
    "finance-token": { kind: "admin", subjectId: "finance", account: "finance", role: "finance", menuKeys: ["financeReview", "afterSales"] },
  };
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]); } };
  const wechatPay = createTestRefundGateway(source);
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null, wechatPay });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (token, route, body) => {
    const response = await fetch(base + route, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const conflictingDispatch = await post("super-token", "/api/orders/dispatch-target/action", {
    action: "assign", photographerId: "photo", appointmentAt: "2026-12-20", timePeriod: "morning",
    appointmentLocation: "test location", peopleCount: 2, enforceScheduleConflict: true, reason: "conflicting assignment",
  });
  assert.equal(conflictingDispatch.status, 409, JSON.stringify(conflictingDispatch.body));
  assert.equal((await source.get("orders", "dispatch-target")).photographerId || "", "");

  const serviceStart = await post("service-token", "/api/orders/task/action", { action: "start", reason: "service must not start task" });
  assert.equal(serviceStart.status, 403);
  const startBeforeAccept = await post("super-token", "/api/orders/task/action", { action: "start", reason: "direct start after assignment" });
  assert.equal(startBeforeAccept.status, 200, JSON.stringify(startBeforeAccept.body));
  const crossPhotographerAccept = await post("other-photo-token", "/api/orders/task/action", { action: "taskaccept", reason: "wrong photographer" });
  assert.equal(crossPhotographerAccept.status, 401);
  const serviceComplete = await post("service-token", "/api/orders/task/action", { action: "shootcomplete", reason: "service must not complete task" });
  assert.equal(serviceComplete.status, 403);
  const completedTask = await post("super-token", "/api/orders/task/action", { action: "shootcomplete", reason: "complete accepted task" });
  assert.equal(completedTask.status, 200, JSON.stringify(completedTask.body));
  const unableTask = await post("super-token", "/api/orders/unable/action", { action: "unable", reason: "photographer unavailable" });
  assert.equal(unableTask.status, 200, JSON.stringify(unableTask.body));
  const unableOrder = await source.get("orders", "unable");
  assert.equal(unableOrder.photographerId, "");
  assert.equal(unableOrder.dispatchStatus, "pending_reassignment");
  assert.equal(unableOrder.taskStatus, "unable");
  assert.equal(workflow.canonicalStage(unableOrder), workflow.WORKFLOW_STAGES.AWAITING_DISPATCH);
  assert.ok(unableOrder.dispatchRecords.some((record) => record.type === "unable" && record.reason === "photographer unavailable"));

  const selected = await post("super-token", "/api/orders/selection/action", { action: "selectionConfirm", reason: "selection completed" });
  assert.equal(selected.status, 409, JSON.stringify(selected.body));
  const selectedOrder = await source.get("orders", "selection");
  assert.equal(workflow.canonicalStage(selectedOrder), workflow.WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT);
  const finalIntent = await rpc(source, "createPayment", {
    data: { orderId: "selection", phase: "final", selectionAccepted: true, idempotencyKey: "final-before-publication-0001" },
  }, publicIdentity("owner"));
  assert.equal(finalIntent.success, true, JSON.stringify(finalIntent));
  const beforeManualConfirmation = await source.get("orders", "selection");
  const finalConfirmed = await post("finance-token", "/api/orders/selection/action", {
    action: "payment", phase: "final", selectionAccepted: true, paymentStatus: "confirmed", amount: 70,
    externalTransactionId: "selection-final-tx-0001", idempotencyKey: "selection-final-confirm-0001", reason: "confirm final payment",
  });
  assert.equal(finalConfirmed.status, 409, JSON.stringify(finalConfirmed.body));
  assert.deepEqual(await source.get("orders", "selection"), beforeManualConfirmation, "a supplied manual transaction id cannot confirm an online payment");
  const onlineConfirmed = await confirmTestPayment(source, { data: {
    orderId: "selection", phase: "final", selectionAccepted: true, idempotencyKey: "final-before-publication-0001",
  } }, publicIdentity("owner"));
  assert.equal(onlineConfirmed.success, true, JSON.stringify(onlineConfirmed));
  const onlineOrder = await source.get("orders", "selection");
  const onlineReceipt = onlineOrder.paymentRecords.find(record => record.phase === "final" && record.status === "confirmed");
  assert.equal(onlineReceipt.provider, "wechat_pay");
  assert.match(onlineReceipt.externalTransactionId, /^fixture-/);
  assert.equal(onlineOrder.finalPaid, 70);
  const published = await post("super-token", "/api/orders/selection/action", {
    action: "deliver", deliveryMethod: "enterprise_wechat", reason: "publish completed files",
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(workflow.canonicalStage(await source.get("orders", "selection")), workflow.WORKFLOW_STAGES.COMPLETED);

  for (const ticketId of ["refund-ticket", "refund-duplicate-ticket"]) {
    const contact = await post("super-token", `/api/after-sales/${ticketId}/action`, {
      action: "follow", customerContacted: true, reason: "contacted customer and agreed refund proposal",
    });
    assert.equal(contact.status, 200, JSON.stringify(contact.body));
  }
  const overConfirmedFunds = await post("super-token", "/api/after-sales/refund-ticket/action", {
    action: "complete", reason: "request too much", refundAmount: 31, refundConfirmed: true,
  });
  assert.equal(overConfirmedFunds.status, 409);
  const requestRefund = await post("super-token", "/api/after-sales/refund-ticket/action", {
    action: "complete", reason: "request online refund", refundAmount: 20, refundConfirmed: true,
  });
  assert.equal(requestRefund.status, 200, JSON.stringify(requestRefund.body));
  assert.equal((await source.get("afterSales", "refund-ticket")).financeStatus, "待审");
  assert.equal((await source.get("afterSales", "refund-ticket")).refundConfirmed, false, "a client supplied confirmation cannot move money");
  const approvedRefund = await post("finance-token", "/api/after-sales/refund-ticket/action", {
    action: "review", approved: true, reason: "approve online refund",
  });
  assert.equal(approvedRefund.status, 200, JSON.stringify(approvedRefund.body));
  const paidRefund = await source.get("afterSales", "refund-ticket");
  assert.equal(paidRefund.refundStatus, "refunded");
  assert.match(paidRefund.refundTransactionId, /^wx-LXMR/);

  const requestDuplicateRefund = await post("super-token", "/api/after-sales/refund-duplicate-ticket/action", {
    action: "complete", reason: "request another order refund", refundAmount: 10, refundConfirmed: true,
  });
  assert.equal(requestDuplicateRefund.status, 200);
  const duplicateRefundReference = await post("finance-token", "/api/after-sales/refund-duplicate-ticket/action", {
    action: "review", approved: true, reason: "approve another online refund", refundTransactionId: paidRefund.refundTransactionId, refundMethod: "manual",
  });
  assert.equal(duplicateRefundReference.status, 200, JSON.stringify(duplicateRefundReference.body));
  const otherRefund = await source.get("afterSales", "refund-duplicate-ticket");
  assert.notEqual(otherRefund.refundTransactionId, paidRefund.refundTransactionId, "a supplied manual reference cannot impersonate the provider refund id");
  assert.equal(otherRefund.refundMethod, "微信原路退款");
  const refundPosts = wechatPay.refundRequests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));
  assert.equal(refundPosts.length, 2);
  assert.notEqual(refundPosts[0].out_refund_no, refundPosts[1].out_refund_no);
  assert.notEqual(refundPosts[0].transaction_id, refundPosts[1].transaction_id);
});
