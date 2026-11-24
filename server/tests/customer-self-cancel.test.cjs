"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const sourceFactory = require("./fixtures/jsonSource.cjs");
const { cancelCustomerOrder } = require("../lib/customerCancellation.cjs");
const { applyRefundResult, reconcilePendingRefunds } = require("../lib/onlineRefunds.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
function order(patch = {}) {
  return { id: "cancel-order", orderNo: "CANCEL-ONE", openid: "customer", status: "deposit_paid", depositDue: 30, depositPaid: 30,
    depositFinanceStatus: "confirmed", totalAmount: 100, finalDue: 70, statusLogs: [], followRecords: [],
    paymentRecords: [{ id: "deposit", phase: "deposit", provider: "wechat_pay", amount: 30, status: "confirmed", outTradeNo: "PAY_CANCEL_ONE", externalTransactionId: "WX_CANCEL_ONE" }], ...patch };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-customer-cancel-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return sourceFactory({ jsonFile: path.join(directory, "db.json") });
}
function provider() {
  const existing = new Map(), created = [];
  return { created, existing, isConfigured: () => true,
    async queryRefund(number) { if (!existing.has(number)) throw Object.assign(new Error("not found"), { code: "WECHAT_PAY_REFUND_NOT_FOUND" }); return clone(existing.get(number)); },
    async createRefund(request) {
      created.push(request);
      const result = { refundNo: request.refundNo, refundId: `wx-${request.refundNo}`, outTradeNo: request.payment.outTradeNo,
        transactionId: request.payment.externalTransactionId, amount: Math.round(Number(request.amount) * 100), total: Math.round(Number(request.payment.amount) * 100), currency: "CNY", status: "PROCESSING" };
      existing.set(result.refundNo, result); return clone(result);
    } };
}
const input = patch => ({ orderId: "cancel-order", reason: "行程调整取消订单", idempotencyKey: "cancel-request-001", ...patch });
const cancel = (db, pay, patch, owner = "customer") => cancelCustomerOrder(db, owner, input(patch), { wechatPay: pay });

test("paid cancellation automatically approves one real-provider refund without a finance review", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order());
  const responses = await Promise.all(Array.from({ length: 8 }, () => cancel(db, pay)));
  for (const response of responses) { assert.equal(response.success, true, JSON.stringify(response)); assert.equal(response.data.refundStatus, "processing"); assert.equal(response.data.refundAmount, 30); }
  assert.equal(pay.created.length, 1);
  const saved = await db.get("orders", "cancel-order"), tickets = await db.list("afterSales");
  assert.equal(saved.status, "cancelled"); assert.equal(saved.service_status, "canceled");
  assert.equal(saved.depositPaid, 30, "original payment receipt remains immutable");
  assert.equal(tickets.length, 1); assert.equal(tickets[0].financeStatus, "已审"); assert.equal(tickets[0].automaticApproval, true);
  assert.equal(tickets[0].refundConfirmed, false, "PROCESSING does not claim money arrived");
  const response = { ...pay.existing.values().next().value, status: "SUCCESS", successTime: new Date().toISOString() };
  await applyRefundResult(db, response);
  assert.equal((await db.get("orders", "cancel-order")).customerCancellationRefundStatus, "refunded");
  const replay = await cancel(db, pay, { idempotencyKey: "different-device-key" });
  assert.equal(replay.success, true); assert.equal(replay.data.refundStatus, "refunded"); assert.equal(pay.created.length, 1);
});

test("unpaid cancellation closes order and pending reschedule without creating a refund", async t => {
  const db = fixture(t), pay = provider();
  await db.create("orders", order({ status: "deposit_pending", depositPaid: 0, depositFinanceStatus: "pending", paymentRecords: [], rescheduleRequest: { id: "req", status: "pending" } }));
  const response = await cancel(db, pay);
  assert.equal(response.success, true); assert.equal(response.data.refundStatus, "not_required"); assert.equal(response.data.refundAmount, 0);
  assert.equal(pay.created.length, 0); assert.deepEqual(await db.list("afterSales"), []);
  assert.equal((await db.get("orders", "cancel-order")).rescheduleRequest.status, "cancelled");
});

test("owner and durable assignment/shooting facts guard cancellation before provider calls", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order());
  assert.equal((await cancel(db, pay, {}, "stranger")).success, false);
  assert.equal((await cancel(db, pay, {}, "")).success, false);
  for (const patch of [{ photographerId: "photo" }, { photo_id: "photo" }, { shootingStartedAt: new Date().toISOString() }, { customerArrivedAt: new Date().toISOString() },
    { status: "completed" }, { dispatchRecords: [{ next: { photographerId: "photo" } }] }, { dispatchHistory: [{ previous: { photographerId: "photo" } }] }, { dispatchStatus: "pending_reassignment" }]) {
    await db.remove("orders", "cancel-order"); await db.create("orders", order(patch));
    assert.equal((await cancel(db, pay)).success, false, JSON.stringify(patch));
  }
  assert.equal(pay.created.length, 0); assert.deepEqual(await db.list("afterSales"), []);
});

test("legacy offline receipts lacking a verified WeChat transaction expose a refund exception", async t => {
  const db = fixture(t), pay = provider();
  await db.create("orders", order({ paymentRecords: [] }));
  const response = await cancel(db, pay);
  assert.equal(response.success, true);
  assert.equal(response.data.refundStatus, "refund_failed");
  assert.equal(response.data.refundAmount, 30);
  assert.equal((await db.get("orders", "cancel-order")).status, "cancelled");
  assert.equal((await db.list("afterSales"))[0].refundConfirmed, false);
  assert.equal(pay.created.length, 0);
});

test("gateway outages retain cancellation and retryable approved refund without reporting refunded", async t => {
  const db = fixture(t); await db.create("orders", order());
  const response = await cancel(db, null);
  assert.equal(response.success, true); assert.equal(response.data.refundStatus, "processing");
  const ticket = (await db.list("afterSales"))[0]; assert.deepEqual(ticket.refundAttempts, undefined); assert.equal(ticket.refundConfirmed, false);
  const pay = provider(); await reconcilePendingRefunds(db, { wechatPay: pay });
  assert.equal(pay.created.length, 1, "background worker retries even before any provider attempt was possible");
  const retry = await cancel(db, pay, { idempotencyKey: "new-device-request" });
  assert.equal(retry.success, true); assert.equal(retry.data.refundTicketId, ticket.id); assert.equal(pay.created.length, 1);
});

test("a lost provider response retries the original refund number rather than paying twice", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order());
  const normal = pay.createRefund;
  pay.createRefund = async request => { const result = await normal(request); pay.existing.set(result.refundNo, { ...result, status: "SUCCESS", successTime: new Date().toISOString() }); throw Object.assign(new Error("timeout"), { code: "WECHAT_PAY_NETWORK_ERROR" }); };
  assert.equal((await cancel(db, pay)).data.refundStatus, "processing");
  const replay = await cancel(db, pay);
  assert.equal(replay.data.refundStatus, "refunded"); assert.equal(pay.created.length, 1);
});

test("known abnormal refund stays visibly failed; confirmed CLOSED allows a new automatic request", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order());
  await cancel(db, pay);
  const original = pay.existing.values().next().value;
  const abnormal = { ...original, status: "ABNORMAL" }; pay.existing.set(original.refundNo, abnormal);
  await applyRefundResult(db, abnormal);
  assert.equal((await cancel(db, pay)).data.refundStatus, "refund_failed"); assert.equal(pay.created.length, 1, "uncertain funds keep the same request number");
  const closed = { ...original, status: "CLOSED" }; pay.existing.set(original.refundNo, closed);
  await applyRefundResult(db, closed);
  assert.equal((await db.get("orders", "cancel-order")).customerCancellationRefundStatus, "refund_failed");
  await reconcilePendingRefunds(db, { wechatPay: pay });
  assert.equal(pay.created.length, 2); assert.notEqual(pay.created[0].refundNo, pay.created[1].refundNo);
  const next = pay.existing.get(pay.created[1].refundNo);
  await applyRefundResult(db, { ...next, status: "SUCCESS", successTime: new Date().toISOString() });
  assert.equal((await db.get("orders", "cancel-order")).customerCancellationRefundStatus, "refunded");
  assert.equal((await db.get("afterSales", (await db.get("orders", "cancel-order")).customerCancelRefundTicketId)).refundedAmount, 30);
});

test("an in-flight payment is closed before cancellation; ambiguous payment results keep it active", async t => {
  const db = fixture(t), pay = provider();
  const pending = order({ status: "deposit_pending", depositPaid: 0, depositFinanceStatus: "pending", paymentRecords: [{ ...order().paymentRecords[0], status: "pending", externalTransactionId: "", idempotencyKey: "pay-001" }] });
  await db.create("orders", pending);
  let closed = 0; pay.queryTransaction = async () => ({ tradeState: "NOTPAY" }); pay.closeTransaction = async () => { closed++; };
  const response = await cancel(db, pay);
  assert.equal(response.success, true); assert.equal(response.data.refundStatus, "not_required"); assert.equal(closed, 1);
  assert.equal((await db.get("orders", "cancel-order")).paymentRecords[0].tradeState, "CLOSED");
  await db.remove("orders", "cancel-order"); await db.create("orders", pending);
  pay.queryTransaction = async () => { throw new Error("network"); };
  assert.equal((await cancel(db, pay)).success, false); assert.equal((await db.get("orders", "cancel-order")).status, "deposit_pending");
});

test("payment racing cancellation is confirmed outside the mutex and automatically refunded", async t => {
  const db = fixture(t), pay = provider();
  await db.create("orders", order({ status: "deposit_pending", depositPaid: 0, depositFinanceStatus: "pending", paymentRecords: [{ ...order().paymentRecords[0], status: "pending" }] }));
  pay.queryTransaction = async () => ({ outTradeNo: "PAY_CANCEL_ONE", tradeState: "SUCCESS" });
  pay.closeTransaction = async () => { throw new Error("already paid"); };
  pay.confirmTransaction = async () => workflow.withOrderMutex("order:cancel-order", async () => {
    const current = await db.get("orders", "cancel-order");
    await db.update("orders", current.id, { status: "deposit_paid", depositPaid: 30, depositFinanceStatus: "confirmed", paymentRecords: [{ ...current.paymentRecords[0], status: "confirmed" }] });
  });
  const response = await cancel(db, pay); assert.equal(response.success, true); assert.equal(response.data.refundAmount, 30); assert.equal(pay.created.length, 1);
});

test("pending support refund is superseded and a prior partial receipt reduces the automatic refund", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order({ afterSaleStatus: "pending", afterSaleId: "support" }));
  await db.create("afterSales", { id: "support", orderId: "cancel-order", type: "定金退款", status: "pending", financeStatus: "待审", refundAmount: 30 });
  await db.create("afterSales", { id: "prior", orderId: "cancel-order", status: "completed", refundAmount: 10, refundConfirmed: true, refundStatus: "refunded",
    refundAttempts: [{ refundNo: "prior-refund", status: "SUCCESS", outTradeNo: "PAY_CANCEL_ONE", amountFen: 1000 }] });
  const response = await cancel(db, pay);
  assert.equal(response.success, true); assert.equal(response.data.refundAmount, 20); assert.equal(pay.created[0].amount, "20.00");
  assert.equal((await db.get("afterSales", "support")).refundStatus, "superseded");
  await applyRefundResult(db, { ...pay.existing.values().next().value, status: "SUCCESS", successTime: new Date().toISOString() });
  assert.equal((await db.get("orders", "cancel-order")).customerCancellationRefundStatus, "refunded");
});

test("a refund already in flight is retained and only the unpaid remainder is newly requested", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order({ afterSaleStatus: "processing", afterSaleId: "existing" }));
  const old = { refundNo: "PREEXISTING_REFUND", refundId: "WX_EXISTING", outTradeNo: "PAY_CANCEL_ONE", transactionId: "WX_CANCEL_ONE", amount: 1000, total: 3000, currency: "CNY", status: "PROCESSING" };
  pay.existing.set(old.refundNo, old);
  await db.create("afterSales", { id: "existing", orderId: "cancel-order", status: "处理", refundPhase: "deposit", reviewLane: "pre_dispatch", refundAmount: 10, financeStatus: "已审", refundStatus: "processing",
    refundAttempts: [{ refundNo: old.refundNo, refundId: old.refundId, outTradeNo: old.outTradeNo, transactionId: old.transactionId, amountFen: 1000, totalFen: 3000, status: "PROCESSING" }] });
  const response = await cancel(db, pay);
  assert.equal(response.success, true); assert.equal(response.data.refundAmount, 30); assert.equal(pay.created.length, 1); assert.equal(pay.created[0].amount, "20.00");
  await applyRefundResult(db, { ...old, status: "SUCCESS", successTime: new Date().toISOString() });
  let saved = await db.get("orders", "cancel-order");
  assert.equal(saved.cancellationSource, "customer_self_cancel"); assert.equal(saved.customerCancellationRefundStatus, "processing");
  const next = pay.existing.get(pay.created[0].refundNo);
  await applyRefundResult(db, { ...next, status: "SUCCESS", successTime: new Date().toISOString() });
  saved = await db.get("orders", "cancel-order"); assert.equal(saved.customerCancellationRefundStatus, "refunded"); assert.equal(saved.onlineRefundedAmount, 30);
});

test("audit failure cannot cancel or initiate a refund; orphaned auto ticket cannot run", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order());
  const create = db.create.bind(db); db.create = async (key, row) => { if (key === "logs") throw new Error("audit down"); return create(key, row); };
  assert.equal((await cancel(db, pay)).success, false);
  assert.equal((await db.get("orders", "cancel-order")).status, "deposit_paid");
  await reconcilePendingRefunds(db, { wechatPay: pay }); assert.equal(pay.created.length, 0);
});

test("assignment arriving before the cancellation CAS prevents stale cancellation and funds", async t => {
  const db = fixture(t), pay = provider(); await db.create("orders", order());
  const compare = db.compareAndUpdate.bind(db); let injected = false;
  db.compareAndUpdate = async (key, id, expected, patch) => {
    if (!injected && key === "orders" && patch.status === "cancelled") { injected = true; await db.update(key, id, { photographerId: "late-photo", status: "assigned" }); }
    return compare(key, id, expected, patch);
  };
  assert.equal((await cancel(db, pay)).success, false); assert.equal(pay.created.length, 0);
  assert.equal((await db.get("orders", "cancel-order")).photographerId, "late-photo");
});

test("service cancellation clears held reservations and a later verified refund completes independently", async () => {
  const { createSvcMemoryStore } = require("../lib/svcStore.cjs"), { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
  const store = createSvcMemoryStore({ orders: [{ id: "cancel-order", order_no: "CANCEL-ONE", service_status: "reserved", reserve_staff_id: "staff" }], reserves: [{ id: "hold", order_no: "CANCEL-ONE", status: "holding" }] });
  const app = createSvcWorkbench({ store, benefit: { onRefund() {} } });
  await app.onCancelled("CANCEL-ONE"); await app.onCancelled("CANCEL-ONE");
  assert.equal(store.snapshot().reserves[0].status, "canceled"); assert.equal(store.snapshot().operationLogs.length, 1);
  await assert.rejects(app.onRefund("CANCEL-ONE"));
  await app.onRefund({ order_no: "CANCEL-ONE", customerCancelled: true });
  assert.equal(store.snapshot().orders[0].service_status, "refunded");
});
