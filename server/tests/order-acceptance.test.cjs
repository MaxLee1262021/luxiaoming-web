"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");

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
    siteConfig: { global: { id: "global", customPrice: { depositRatio: 30 } } },
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
  return { identity: { kind: "public", openid } };
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
  const order = await source.get("orders", created.orderId);
  assert.equal(order.openid, "owner");
  assert.equal(order.workflowStage, workflow.WORKFLOW_STAGES.AWAITING_DEPOSIT);
  assert.equal(order.date, "");
  assert.equal(order.timePeriod, "");
  assert.deepEqual(order.paymentRecords, []);
  assert.match(order.orderNo, /^LS\d{8}[A-F0-9]{10}$/);

  const repeated = await rpc(source, "createBooking", { data: request }, publicIdentity("owner"));
  assert.equal(repeated.success, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.orderId, created.orderId);
  assert.equal(Object.keys(source.collections.orders).length, 1);

  const reusedByAnotherOwner = await rpc(source, "createBooking", { data: request }, publicIdentity("other-owner"));
  assert.equal(reusedByAnotherOwner.success, false);

  const noSlot = await rpc(source, "createBooking", {
    data: { ...request, idempotencyKey: "booking-owner-0002", date: "", timePeriod: "" },
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
  source.collections.orders.completed = { ...confirmedOrder("completed"), openid: "owner", status: "delivered", depositPaid: 30, finalPaid: 70, depositFinanceStatus: "confirmed", finalFinanceStatus: "confirmed", selectionStatus: "confirmed", selectionConfirmedAt: "2026-09-20T10:00:00.000Z", deliveryRecord: { method: "wechat" }, deliveredAt: "2026-09-20T11:00:00.000Z", paymentRecords: [{ id: "completed-deposit", phase: "deposit", amount: 30, status: "confirmed" }, { id: "completed-final", phase: "final", amount: 70, status: "confirmed" }] };

  const pending = await rpc(source, "getMyOrders", { data: { status: "pending_payment", page: 1, pageSize: 20 } }, publicIdentity("owner"));
  assert.deepEqual(pending.data.map((row) => row.id), ["confirmation"]);
  const confirmed = await rpc(source, "getMyOrders", { data: { status: "awaiting_photographer", page: 1, pageSize: 20 } }, publicIdentity("owner"));
  assert.deepEqual(new Set(confirmed.data.map((row) => row.id)), new Set(["dispatch", "assigned"]));
  const completed = await rpc(source, "getMyOrders", { data: { status: "delivered", page: 1, pageSize: 20 } }, publicIdentity("owner"));
  assert.deepEqual(completed.data.map((row) => row.id), ["completed"]);
});

test("service confirmation is a required server snapshot and generic order writes cannot bypass it", async (t) => {
  const source = makeSource();
  source.collections.orders.order = {
    id: "order",
    orderNo: "ORDER-CONFIRM",
    openid: "owner",
    status: "new",
    totalAmount: 100,
    totalPrice: 100,
    price: 100,
    depositRatio: 0.3,
    depositDue: 30,
    finalDue: 70,
    paymentRecords: [],
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

  const incomplete = await post("/api/orders/order/action", { action: "accept", reason: "confirm" });
  assert.equal(incomplete.status, 400);
  const accepted = await post("/api/orders/order/action", {
    action: "accept",
    reason: "confirmed itinerary",
    appointmentAt: "2026-12-20",
    timePeriod: "morning",
    appointmentLocation: "test location",
    peopleCount: 2,
    serviceContent: "portrait service",
    totalAmount: 120,
    depositRatio: 0.25,
    priceAdjustReason: "seasonal adjustment",
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.workflowStage, workflow.WORKFLOW_STAGES.AWAITING_DEPOSIT);
  const persisted = await source.get("orders", "order");
  assert.equal(persisted.confirmationSnapshot.totalAmount, 120);
  assert.equal(persisted.confirmationSnapshot.depositDue, 30);
  assert.equal(persisted.confirmationSnapshot.finalDue, 90);
  source.collections.packages["package-1"].price = 999;
  source.collections.packages["package-1"].depositRatio = 90;
  assert.deepEqual((await source.get("orders", "order")).confirmationSnapshot, persisted.confirmationSnapshot);

  const intent = await rpc(source, "createPayment", {
    data: { orderId: "order", phase: "deposit", idempotencyKey: "confirmation-intent-0001" },
  }, publicIdentity("owner"));
  assert.equal(intent.success, true);
  const reconfirm = await post("/api/orders/order/action", {
    action: "accept",
    reason: "change snapshot",
    appointmentAt: "2026-12-21",
    timePeriod: "afternoon",
    appointmentLocation: "other location",
    peopleCount: 3,
    serviceContent: "other service",
    totalAmount: 200,
    depositRatio: 0.5,
    priceAdjustReason: "not allowed after intent",
  });
  assert.equal(reconfirm.status, 409);

  const genericWrite = await post("/api/collection/orders/order", { status: "completed" }, "PUT");
  assert.equal(genericWrite.status, 403);
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
  assert.equal(afterConfirmation.success, false);

  source.collections.orders.afterSale = { id: "afterSale", orderNo: "AFTER-SALE", openid: "owner", status: "new", totalAmount: 100, depositDue: 30, finalDue: 70, afterSaleStatus: "pending", paymentRecords: [] };
  source.collections.afterSales.ticket = { id: "ticket", orderId: "afterSale", status: "pending" };
  const frozen = await rpc(source, "cancelOrder", {
    data: { orderId: "afterSale", reason: "support open", idempotencyKey: "cancel-after-sale-0001" },
  }, publicIdentity("owner"));
  assert.equal(frozen.success, false);
});

test("test payment is opt-in, owner-only, phase-gated, idempotent, and auditable", { concurrency: false }, async (t) => {
  const source = makeSource();
  source.collections.orders.deposit = confirmedOrder("deposit", "owner");
  source.collections.orders.finalBeforeDelivery = {
    ...confirmedOrder("final-before-delivery", "owner"),
    status: "final_pending",
    depositPaid: 30,
    depositFinanceStatus: "confirmed",
    selectionStatus: "confirmed",
    selectionConfirmedAt: "2026-09-18T01:00:00.000Z",
    paymentRecords: [{ id: "deposit-confirmed", phase: "deposit", amount: 30, status: "confirmed", provider: "manual" }],
  };
  source.collections.orders.frozen = confirmedOrder("frozen", "owner");
  source.collections.afterSales.frozenTicket = { id: "frozen-ticket", orderId: "frozen", status: "pending" };

  const sessions = {
    "owner-token": { kind: "public", openid: "owner" },
    "other-token": { kind: "public", openid: "other" },
  };
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]); } };
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const paymentRequest = async (token, data) => {
    const response = await fetch(`${base}/api/rpc/testPayment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };

  await withPaymentEnvironment({ TEST_PAYMENT_ENABLED: undefined, PAYMENT_MODE: undefined }, async () => {
    const disabled = await paymentRequest("owner-token", { orderId: "deposit", phase: "deposit", idempotencyKey: "test-payment-0001" });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.success, false);
    assert.equal((await source.get("orders", "deposit")).depositPaid, 0);
  });

  await withPaymentEnvironment({ TEST_PAYMENT_ENABLED: "true", PAYMENT_MODE: undefined }, async () => {
    assert.equal((await paymentRequest("", { orderId: "deposit", phase: "deposit", idempotencyKey: "test-payment-0001" })).status, 401);
    const foreign = await paymentRequest("other-token", { orderId: "deposit", phase: "deposit", idempotencyKey: "test-payment-0001" });
    assert.equal(foreign.body.success, false);
    const wrongPhase = await paymentRequest("owner-token", { orderId: "final-before-delivery", phase: "final", idempotencyKey: "test-final-0001" });
    assert.equal(wrongPhase.body.success, false);
    const afterSaleFrozen = await paymentRequest("owner-token", { orderId: "frozen", phase: "deposit", idempotencyKey: "test-frozen-0001" });
    assert.equal(afterSaleFrozen.body.success, false);

    const paid = await paymentRequest("owner-token", { orderId: "deposit", phase: "deposit", idempotencyKey: "test-payment-0001" });
    assert.equal(paid.body.success, true, JSON.stringify(paid.body));
    assert.equal(paid.body.data.provider, "test_payment");
    assert.equal(paid.body.data.testPayment, true);
    assert.equal(paid.body.data.invokeWeChatPay, false);
    const replay = await paymentRequest("owner-token", { orderId: "deposit", phase: "deposit", idempotencyKey: "test-payment-0001" });
    assert.equal(replay.body.success, true);
    assert.equal(replay.body.data.idempotent, true);
  });

  const paidOrder = await source.get("orders", "deposit");
  const records = paidOrder.paymentRecords.filter((record) => record.phase === "deposit");
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "test_payment");
  assert.match(records[0].externalTransactionId, /^test:/);
  assert.equal(records[0].status, "confirmed");
  assert.equal(workflow.hasConfirmedPayment(paidOrder, "deposit"), true);
  assert.equal(workflow.canonicalStage(paidOrder), workflow.WORKFLOW_STAGES.AWAITING_DISPATCH);
  const auditRows = Object.values(source.collections.logs).filter((row) => row.auditEvent === "test_payment");
  assert.equal(auditRows.length, 1);
  assert.match(auditRows[0].detail, /provider=test_payment/);
});

test("dispatch conflicts, publication gates, and manual refunds enforce server-side facts", async (t) => {
  const source = makeSource();
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
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
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
  const startBeforeAccept = await post("photo-token", "/api/orders/task/action", { action: "start", reason: "direct start after assignment" });
  assert.equal(startBeforeAccept.status, 200, JSON.stringify(startBeforeAccept.body));
  const crossPhotographerAccept = await post("other-photo-token", "/api/orders/task/action", { action: "taskaccept", reason: "wrong photographer" });
  assert.equal(crossPhotographerAccept.status, 403);
  const serviceComplete = await post("service-token", "/api/orders/task/action", { action: "shootcomplete", reason: "service must not complete task" });
  assert.equal(serviceComplete.status, 403);
  const completedTask = await post("photo-token", "/api/orders/task/action", { action: "shootcomplete", reason: "complete accepted task" });
  assert.equal(completedTask.status, 200, JSON.stringify(completedTask.body));
  const unableTask = await post("photo-token", "/api/orders/unable/action", { action: "unable", reason: "photographer unavailable" });
  assert.equal(unableTask.status, 200, JSON.stringify(unableTask.body));
  const unableOrder = await source.get("orders", "unable");
  assert.equal(unableOrder.photographerId, "");
  assert.equal(unableOrder.dispatchStatus, "pending_reassignment");
  assert.equal(unableOrder.taskStatus, "unable");
  assert.equal(workflow.canonicalStage(unableOrder), workflow.WORKFLOW_STAGES.AWAITING_DISPATCH);
  assert.ok(unableOrder.dispatchRecords.some((record) => record.type === "unable" && record.reason === "photographer unavailable"));

  const selected = await post("photo-token", "/api/orders/selection/action", { action: "selectionConfirm", reason: "selection completed" });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const selectedOrder = await source.get("orders", "selection");
  assert.equal(workflow.canonicalStage(selectedOrder), workflow.WORKFLOW_STAGES.AWAITING_FINAL_PAYMENT);
  const finalIntent = await rpc(source, "createPayment", {
    data: { orderId: "selection", phase: "final", idempotencyKey: "final-before-publication-0001" },
  }, publicIdentity("owner"));
  assert.equal(finalIntent.success, true, JSON.stringify(finalIntent));
  const finalConfirmed = await post("finance-token", "/api/orders/selection/action", {
    action: "payment", phase: "final", paymentStatus: "confirmed", amount: 70,
    externalTransactionId: "selection-final-tx-0001", idempotencyKey: "selection-final-confirm-0001", reason: "confirm final payment",
  });
  assert.equal(finalConfirmed.status, 200, JSON.stringify(finalConfirmed.body));
  const published = await post("super-token", "/api/orders/selection/action", {
    action: "deliver", deliveryMethod: "enterprise_wechat", reason: "publish completed files",
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(workflow.canonicalStage(await source.get("orders", "selection")), workflow.WORKFLOW_STAGES.DELIVERED);

  const overConfirmedFunds = await post("super-token", "/api/after-sales/refund-ticket/action", {
    action: "complete", reason: "request too much", refundAmount: 31, refundConfirmed: true,
  });
  assert.equal(overConfirmedFunds.status, 409);
  const requestRefund = await post("super-token", "/api/after-sales/refund-ticket/action", {
    action: "complete", reason: "request manual refund", refundAmount: 20, refundConfirmed: true,
  });
  assert.equal(requestRefund.status, 200, JSON.stringify(requestRefund.body));
  assert.equal((await source.get("afterSales", "refund-ticket")).financeStatus, "待审");
  const missingRefundReference = await post("finance-token", "/api/after-sales/refund-ticket/action", {
    action: "review", approved: true, reason: "approve manual refund",
  });
  assert.equal(missingRefundReference.status, 400);
  const approvedRefund = await post("finance-token", "/api/after-sales/refund-ticket/action", {
    action: "review", approved: true, reason: "approve manual refund", refundTransactionId: "refund-reference-0001", refundMethod: "manual",
  });
  assert.equal(approvedRefund.status, 200, JSON.stringify(approvedRefund.body));
  const paidRefund = await source.get("afterSales", "refund-ticket");
  assert.equal(paidRefund.refundStatus, "manual_refunded");
  assert.equal(paidRefund.refundTransactionId, "refund-reference-0001");

  const requestDuplicateRefund = await post("super-token", "/api/after-sales/refund-duplicate-ticket/action", {
    action: "complete", reason: "request duplicate reference", refundAmount: 10, refundConfirmed: true,
  });
  assert.equal(requestDuplicateRefund.status, 200);
  const duplicateRefundReference = await post("finance-token", "/api/after-sales/refund-duplicate-ticket/action", {
    action: "review", approved: true, reason: "approve duplicate reference", refundTransactionId: "refund-reference-0001", refundMethod: "manual",
  });
  assert.equal(duplicateRefundReference.status, 409);
});
