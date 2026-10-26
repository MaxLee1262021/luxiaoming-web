"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function makeSource() {
  const order = {
    id: "booking", _id: "booking", orderNo: "ORDER-BOOKING", openid: "owner", assigneeId: "service",
    status: "deposit_paid", workflowStage: "awaiting_dispatch", totalAmount: 100, depositDue: 30, finalDue: 70,
    depositPaid: 30, depositFinanceStatus: "confirmed", finalPaid: 0,
    paymentRecords: [{ id: "deposit-paid", phase: "deposit", amount: 30, status: "confirmed", provider: "wechat_pay", externalTransactionId: "deposit-tx" }],
    dispatchStatus: "pending", afterSaleStatus: "pending", afterSaleId: "deposit-refund", followRecords: [], statusLogs: [],
  };
  const ticket = {
    id: "deposit-refund", _id: "deposit-refund", orderId: "booking", openid: "owner",
    type: "定金退款", submitSource: "mini_program", reviewLane: "pre_dispatch", refundPhase: "deposit",
    refundAmount: 30, refundStatus: "pending_review", refundConfirmed: false, financeStatus: "待审", status: "pending", logs: [],
  };
  const collections = {
    orders: { booking: order }, afterSales: { "deposit-refund": ticket }, logs: {},
    staff: Object.fromEntries(["super", "finance", "service", "photo"].map((role) => [role, { id: role, account: role, role, status: "active" }])),
  };
  let sequence = 0;
  return {
    collections,
    async list(key) { return Object.values(collections[key] || {}).map(clone); },
    async get(key, id) { return clone(collections[key]?.[String(id)]) || null; },
    async create(key, document) {
      const id = String(document.id || document._id || `${key}-${++sequence}`);
      collections[key] ||= {};
      collections[key][id] = { ...clone(document), id, _id: id };
      return clone(collections[key][id]);
    },
    async update(key, id, patch) {
      if (!collections[key]?.[String(id)]) return null;
      collections[key][String(id)] = { ...collections[key][String(id)], ...clone(patch) };
      return clone(collections[key][String(id)]);
    },
    async remove(key, id) { delete collections[key]?.[String(id)]; return true; },
  };
}

async function startApi(t, source) {
  const sessions = Object.fromEntries(["super", "finance", "service"].map((role) => [`${role}-token`, {
    kind: "admin", subjectId: role, account: role, role, menuKeys: ["orders", "afterSales", "financeReview", "tasks"],
  }]));
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]); } };
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (role, body, route = "/api/after-sales/deposit-refund/action") => {
    const response = await fetch(base + route, {
      method: "POST", headers: { Authorization: `Bearer ${role}-token`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

const approve = (extra = {}) => ({ action: "review", approved: true, reason: "摄影师安排前退还定金", refundTransactionId: "manual-refund-proof", ...extra });
const confirmedRefund = (orderId, amount, phase = "deposit") => ({ id: `prior-${orderId}`, orderId, refundAmount: amount, refundPhase: phase, financeStatus: "已审", refundStatus: "manual_refunded", status: "已完" });

test("pre-dispatch deposit refund cancels the order once and preserves confirmed payment evidence", async (t) => {
  const source = makeSource();
  source.collections.afterSales.other = confirmedRefund("unrelated-order", 999);
  const paymentBefore = clone(source.collections.orders.booking.paymentRecords);
  const post = await startApi(t, source);
  const results = await Promise.all([post("finance", approve()), post("super", approve())]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const saved = await source.get("orders", "booking");
  const ticket = await source.get("afterSales", "deposit-refund");
  assert.equal(ticket.refundStatus, "manual_refunded");
  assert.equal(ticket.refundConfirmed, true);
  assert.equal(ticket.refundTransactionId, "manual-refund-proof");
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.workflowStage, workflow.WORKFLOW_STAGES.CANCELLED);
  assert.equal(workflow.canonicalStage(saved), workflow.WORKFLOW_STAGES.CANCELLED);
  assert.equal(workflow.businessStatusForOrder(saved), "cancelled");
  assert.equal(saved.cancellationSource, "pre_dispatch_deposit_refund");
  assert.ok(saved.cancelledAt);
  assert.equal(saved.isDeleted || saved.deleted || false, false);
  assert.equal(saved.depositPaid, 30);
  assert.equal(saved.depositFinanceStatus, "confirmed");
  assert.deepEqual(saved.paymentRecords, paymentBefore);
  assert.equal(saved.statusLogs.filter((entry) => entry.to === "cancelled").length, 1);
  assert.equal(Object.values(source.collections.logs).filter((entry) => entry.action === "售后review").length, 1);
  const retry = await post("super", approve({ refundTransactionId: "different-proof" }));
  assert.equal(retry.status, 409);
  assert.deepEqual(await source.get("orders", "booking"), saved);
  const assignment = await post("super", {
    action: "assign", photographerId: "photo", confirmedShootDate: "2026-12-20", confirmedShootTime: "10:00",
    confirmedShootLocation: "橘子洲集合点", participantCount: 2, confirmationMethod: "客服微信", customerConfirmationNote: "游客已确认", reason: "退款后尝试派单",
  }, "/api/orders/booking/action");
  assert.equal(assignment.status, 409);
  const payment = await rpc(source, "createPayment", { data: { orderId: "booking", phase: "deposit", idempotencyKey: "refund-repay-attempt" } }, { identity: { kind: "public", openid: "owner" } });
  assert.equal(payment.success, false);
});

test("pre-dispatch refund still requires external manual refund proof", async (t) => {
  const source = makeSource();
  const beforeOrder = clone(source.collections.orders.booking);
  const beforeTicket = clone(source.collections.afterSales["deposit-refund"]);
  const post = await startApi(t, source);
  const result = await post("finance", approve({ refundTransactionId: "" }));
  assert.equal(result.status, 400);
  assert.deepEqual(await source.get("orders", "booking"), beforeOrder);
  assert.deepEqual(await source.get("afterSales", "deposit-refund"), beforeTicket);
});

test("mini-program request and finance review share the pre-dispatch refund contract", async (t) => {
  const source = makeSource();
  delete source.collections.afterSales["deposit-refund"];
  Object.assign(source.collections.orders.booking, { afterSaleStatus: "", afterSaleId: "" });
  const submitted = await rpc(source, "submitAfterSale", { data: {
    orderId: "booking", type: "定金退款", refundAmount: 999, reason: "行程变更申请退还定金",
  } }, { identity: { kind: "public", openid: "owner" } });
  assert.equal(submitted.success, true, JSON.stringify(submitted));
  const ticket = await source.get("afterSales", submitted.data.ticketId);
  assert.equal(ticket.refundAmount, 30);
  assert.equal(ticket.reviewLane, "pre_dispatch");
  const post = await startApi(t, source);
  const reviewed = await post("finance", approve(), `/api/after-sales/${ticket.id}/action`);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal((await source.get("orders", "booking")).status, "cancelled");
});

test("review rechecks assignment and fulfillment changes after the request", async (t) => {
  for (const changed of [
    { photographerId: "photo", dispatchStatus: "assigned" },
    { depositRefundable: false, dispatchRecords: [{ type: "assign", next: { photographerId: "photo" } }] },
    { status: "shooting", shootingStartedAt: "2026-10-26T01:00:00Z" },
    { paymentReviewRequired: true },
  ]) {
    await t.test(JSON.stringify(changed), async (subtest) => {
      const source = makeSource();
      Object.assign(source.collections.orders.booking, changed);
      const beforeOrder = clone(source.collections.orders.booking);
      const beforeTicket = clone(source.collections.afterSales["deposit-refund"]);
      const post = await startApi(subtest, source);
      const result = await post("finance", approve());
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.deepEqual(await source.get("orders", "booking"), beforeOrder);
      assert.deepEqual(await source.get("afterSales", "deposit-refund"), beforeTicket);
    });
  }
});

test("refund approval uses remaining deposit for this order and rejects stale or partial amounts", async (t) => {
  for (const amount of [30, 19, 0, -1]) {
    await t.test(`requested ${amount}`, async (subtest) => {
      const source = makeSource();
      source.collections.afterSales.prior = confirmedRefund("booking", 10);
      source.collections.afterSales["deposit-refund"].refundAmount = amount;
      const post = await startApi(subtest, source);
      const result = await post("finance", approve());
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal((await source.get("orders", "booking")).status, "deposit_paid");
      assert.equal((await source.get("afterSales", "deposit-refund")).financeStatus, "待审");
    });
  }
  await t.test("the exact remaining amount succeeds", async (subtest) => {
    const source = makeSource();
    source.collections.afterSales.prior = confirmedRefund("booking", 10);
    source.collections.afterSales["deposit-refund"].refundAmount = 20;
    const post = await startApi(subtest, source);
    const result = await post("finance", approve());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await source.get("orders", "booking")).status, "cancelled");
  });
  await t.test("previous refunds with another phase cannot exceed the deposit actually received", async (subtest) => {
    const source = makeSource();
    source.collections.afterSales.prior = confirmedRefund("booking", 10, "final");
    const post = await startApi(subtest, source);
    const result = await post("finance", approve());
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal((await source.get("orders", "booking")).status, "deposit_paid");
    assert.equal((await source.get("afterSales", "deposit-refund")).financeStatus, "待审");
  });
});

test("service cannot alter the computed mini-program deposit refund amount", async (t) => {
  const source = makeSource();
  const post = await startApi(t, source);
  const result = await post("service", { action: "complete", refundAmount: 20, reason: "尝试修改系统退款金额" });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((await source.get("afterSales", "deposit-refund")).refundAmount, 30);
});

test("rejected deposit refund leaves the paid booking active", async (t) => {
  const source = makeSource();
  const post = await startApi(t, source);
  const result = await post("finance", { action: "review", approved: false, reason: "退款凭证尚未确认" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await source.get("orders", "booking")).status, "deposit_paid");
  assert.equal((await source.get("afterSales", "deposit-refund")).refundStatus, "rejected");
});

test("refund audit failure restores both the order and ticket before retry", async (t) => {
  const source = makeSource();
  const beforePayment = clone(source.collections.orders.booking.paymentRecords);
  const create = source.create;
  source.create = async (key, document) => { if (key === "logs") throw new Error("audit unavailable"); return create(key, document); };
  const post = await startApi(t, source);
  const failed = await post("finance", approve());
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  let saved = await source.get("orders", "booking");
  assert.equal(saved.status, "deposit_paid");
  assert.equal(saved.cancelledAt || "", "");
  assert.deepEqual(saved.paymentRecords, beforePayment);
  assert.deepEqual(saved.statusLogs, []);
  assert.equal((await source.get("afterSales", "deposit-refund")).financeStatus, "待审");
  source.create = create;
  const retried = await post("finance", approve());
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  saved = await source.get("orders", "booking");
  assert.equal(saved.status, "cancelled");
  assert.deepEqual(saved.paymentRecords, beforePayment);
});

test("service-exception refund totals stay scoped to their own order", async (t) => {
  const source = makeSource();
  Object.assign(source.collections.orders.booking, { photographerId: "photo", dispatchStatus: "assigned", depositRefundable: false });
  Object.assign(source.collections.afterSales["deposit-refund"], { type: "退款申请", reviewLane: "service_exception", refundAmount: 20 });
  source.collections.afterSales.other = confirmedRefund("unrelated-order", 999);
  const post = await startApi(t, source);
  const completed = await post("super", { action: "complete", refundAmount: 30, reason: "人工核实服务例外退款" });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const result = await post("finance", approve());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await source.get("afterSales", "deposit-refund")).refundStatus, "manual_refunded");
  assert.equal((await source.get("orders", "booking")).status, "deposit_paid");
});
