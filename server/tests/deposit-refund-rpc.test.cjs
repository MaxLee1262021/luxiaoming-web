"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createSource = require("../lib/dbSource.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");

const owner = { identity: { kind: "public", openid: "refund-owner" } };
function order(patch = {}) {
  return {
    id: "refund-order", openid: "refund-owner", orderNo: "REFUND-ONE", status: "deposit_paid",
    totalAmount: 100, depositDue: 30, depositPaid: 30, finalDue: 70,
    depositFinanceStatus: "confirmed",
    paymentRecords: [{ id: "deposit", phase: "deposit", amount: 30, status: "confirmed", provider: "wechat_pay" }],
    ...patch,
  };
}
function refunded(patch = {}) {
  return { id: "prior-refund", orderId: "refund-order", status: "completed", refundPhase: "deposit",
    refundAmount: 10, financeStatus: "已审", refundStatus: "manual_refunded", ...patch };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-deposit-refund-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return createSource({ backend: "json", jsonFile: path.join(directory, "db.json") });
}
function submit(source, patch = {}, identity = owner) {
  return rpc(source, "submitAfterSale", { data: { orderId: "refund-order", type: "定金退款", refundPhase: "deposit", reason: "行程有变申请退定金", ...patch } }, identity);
}

test("paid deposits expose the refund action only before any photographer assignment", () => {
  assert.equal(workflow.publicOrderProjection(order()).canRefundDeposit, true);
  assert.equal(workflow.publicOrderProjection(order()).canAfterSale, true);
  assert.equal(workflow.publicOrderProjection(order()).refundableDepositAmount, 30);
  assert.equal(workflow.publicOrderProjection(order({ depositPaid: 0 })).canRefundDeposit, true, "confirmed payment record is authoritative");
  assert.equal(workflow.publicOrderProjection(order({ depositPaid: 0 })).depositPaid, 30);
  for (const patch of [{ dispatchRecord: {} }, { dispatchRecord: { next: {} } }, { status: "assigned", dispatchStatus: "assigned", photographerId: "" }]) {
    const projected = workflow.publicOrderProjection(order(patch));
    assert.equal(projected.businessStatus, "reserved");
    assert.equal(projected.statusText, "待确认");
    assert.equal(projected.canRefundDeposit, true);
    assert.equal(projected.dispatchStatus, "pending");
  }
  for (const patch of [
    { photographerId: "photo" }, { status: "assigned", photographerId: "photo" }, { dispatchStatus: "assigned", photographerId: "photo" },
    { dispatchStatus: "pending_reassignment" }, { depositRefundable: false },
    { dispatchRecord: { next: { photographerId: "photo" } } },
    { dispatchRecords: [{ previous: { photographerId: "photo" }, next: { photographerId: "" } }] },
    { shootingStartedAt: "2026-10-26T00:00:00Z" }, { status: "cancelled" },
    { paymentReviewRequired: true }, { afterSaleStatus: "pending" },
    { depositDue: 0, depositPaid: 0, paymentRecords: [] },
    { depositDue: 0, depositPaid: 30, depositFinanceStatus: "pending", paymentRecords: [] },
    { status: "deposit_pending", depositPaid: 0, depositFinanceStatus: "pending", paymentRecords: [] },
  ]) assert.equal(workflow.publicOrderProjection(order(patch)).canRefundDeposit, false, JSON.stringify(patch));
});

test("refundable deposit deducts this order's confirmed refunds regardless of a legacy phase label", () => {
  const tickets = [refunded(), refunded({ id: "other", orderId: "other-order", refundAmount: 300 }),
    refunded({ id: "final", refundPhase: "final", refundAmount: 5 }),
    refunded({ id: "rejected", financeStatus: "已驳", refundAmount: 30 })];
  const projected = workflow.publicOrderProjection(order(), { afterSales: tickets });
  assert.equal(projected.canRefundDeposit, true);
  assert.equal(projected.refundableDepositAmount, 15);
  assert.equal(workflow.canRefundDeposit(order(), [refunded({ refundAmount: 30 })]), false);
  const active = workflow.publicOrderProjection(order(), { afterSales: [{ orderId: "refund-order", status: "pending" }] });
  assert.equal(active.canRefundDeposit, false);
  assert.equal(active.afterSaleActive, true);
  assert.equal(active.afterSaleStatus, "pending");
});

test("owner submits one pending full-deposit refund with a server-calculated amount", async (t) => {
  const source = fixture(t);
  await source.create("orders", order());
  await source.create("afterSales", refunded());
  await source.create("afterSales", refunded({ id: "other", orderId: "other-order", refundAmount: 300 }));
  const requests = await Promise.all([submit(source, { refundAmount: 9999, financeStatus: "已审", refundConfirmed: true }), submit(source)]);
  requests.forEach((result) => assert.equal(result.success, true, JSON.stringify(result)));
  assert.equal(requests[0].data.ticketId, requests[1].data.ticketId);
  const ticket = await source.get("afterSales", requests[0].data.ticketId);
  assert.equal(ticket.refundAmount, 20);
  assert.equal(ticket.refundPhase, "deposit");
  assert.equal(ticket.reviewLane, "pre_dispatch");
  assert.equal(ticket.financeStatus, "待审");
  assert.equal(ticket.refundConfirmed, false);
  assert.equal(ticket.refundStatus, "pending_review");
  assert.equal((await source.list("afterSales")).length, 3);
  const saved = await source.get("orders", "refund-order");
  assert.equal(saved.status, "deposit_paid", "request submission does not claim cancellation or money movement");
  assert.equal(saved.depositPaid, 30);
  const detail = await rpc(source, "getOrderDetail", { data: { orderId: saved.id } }, owner);
  assert.equal(detail.data.canRefundDeposit, false);
  assert.equal(detail.data.afterSaleActive, true);
  assert.equal(detail.data.afterSaleStatus, "pending");
});

test("refund requests require the order owner and recheck assignment on the server", async (t) => {
  const source = fixture(t);
  await source.create("orders", order());
  for (const identity of [{}, { identity: { kind: "public", openid: "stranger" } }]) {
    assert.equal((await submit(source, {}, identity)).success, false);
  }
  for (const patch of [{ photographerId: "photo" }, { depositRefundable: false, photographerId: "" },
    { dispatchRecords: [{ next: { photographerId: "photo" } }] }]) {
    await source.update("orders", "refund-order", patch);
    assert.equal((await submit(source)).success, false);
  }
  assert.deepEqual(await source.list("afterSales"), []);
});

test("refund eligibility is consistent in public detail and list after prior refunds", async (t) => {
  const source = fixture(t);
  await source.create("orders", order());
  await source.create("afterSales", refunded({ refundAmount: 30 }));
  const detail = await rpc(source, "getOrderDetail", { data: { orderId: "refund-order" } }, owner);
  const list = await rpc(source, "getMyOrders", { data: {} }, owner);
  for (const projected of [detail.data, list.data[0]]) {
    assert.equal(projected.canRefundDeposit, false);
    assert.equal(projected.refundableDepositAmount, 0);
  }
  assert.equal((await submit(source)).success, false);
});

test("another active support ticket cannot be reported as a submitted deposit refund", async (t) => {
  const source = fixture(t);
  await source.create("orders", order());
  await source.create("afterSales", { id: "complaint", orderId: "refund-order", type: "投诉反馈", status: "pending" });
  const response = await submit(source);
  assert.equal(response.success, false);
  assert.match(response.error, /已有处理中售后/);
  assert.equal((await source.list("afterSales")).length, 1);
});

test("an unavailable refund ledger disables the action and rejects submission", async (t) => {
  const source = fixture(t);
  await source.create("orders", order());
  const originalList = source.list.bind(source);
  source.list = async (key) => { if (key === "afterSales") throw new Error("unavailable"); return originalList(key); };
  const detail = await rpc(source, "getOrderDetail", { data: { orderId: "refund-order" } }, owner);
  assert.equal(detail.success, true);
  assert.equal(detail.data.canRefundDeposit, false);
  assert.equal((await submit(source)).success, false);
});

test("audit failure rolls back the refund ticket and order association", async (t) => {
  const source = fixture(t);
  await source.create("orders", order());
  const originalCreate = source.create.bind(source);
  source.create = async (key, row) => { if (key === "logs") throw new Error("audit unavailable"); return originalCreate(key, row); };
  assert.equal((await submit(source)).success, false);
  assert.deepEqual(await source.list("afterSales"), []);
  const saved = await source.get("orders", "refund-order");
  assert.equal(saved.afterSaleStatus, null);
  assert.equal(saved.afterSaleId, null);
  assert.equal(workflow.canRefundDeposit(saved), true);
});
