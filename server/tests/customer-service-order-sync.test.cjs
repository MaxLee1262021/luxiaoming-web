"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const { isDeepStrictEqual } = require("node:util");
const { createTestWechatPay, createTestRefundGateway } = require("./helpers/wechatPay.cjs");

const owner = { identity: { kind: "public", openid: "sync-owner" } };
const at = "2026-11-13 12:00:00";
function sourceFor(read, store) {
  const source = {
    async list(key) { return key === "orders" ? structuredClone(read()) : []; },
    async get(key, id) { return (await this.list(key)).find(row => row.id === id) || null; },
  };
  if (store) {
    source.create = async (key, row) => structuredClone(row);
    source.update = async (key, id, patch) => store.transaction(state => {
      const row = state[key].find(item => item.id === id);
      if (!row) return null;
      return Object.assign(row, structuredClone(patch));
    });
    source.compareAndUpdate = async (key, id, expected, patch) => store.transaction(state => {
      const row = state[key].find(item => item.id === id);
      if (!row || Object.entries(expected).some(([field, value]) => !isDeepStrictEqual(row[field], value))) return null;
      return Object.assign(row, structuredClone(patch));
    });
  }
  return source;
}
async function assertPublicCompleted(source, expectedIds, finalPaid = 0) {
  const all = await rpc(source, "getMyOrders", { data: {} }, owner);
  const completed = await rpc(source, "getMyOrders", { data: { businessStatus: "completed" } }, owner);
  const counts = await rpc(source, "getOrderStatusCount", {}, owner);
  assert.equal(all.success, true);
  assert.equal(completed.success, true);
  assert.equal(counts.success, true);
  assert.deepEqual(all.data.map(row => row.id).sort(), [...expectedIds].sort());
  assert.deepEqual(completed.data.map(row => row.id).sort(), [...expectedIds].sort());
  assert.equal(counts.data.completed, expectedIds.length);
  assert.equal(counts.data.businessStatus.completed, expectedIds.length);
  for (const id of expectedIds) {
    const detail = await rpc(source, "getOrderDetail", { data: { orderId: id } }, owner);
    assert.equal(detail.success, true);
    for (const row of [all.data.find(row => row.id === id), completed.data.find(row => row.id === id), detail.data]) {
      assert.equal(row.businessStatus, "completed");
      assert.equal(row.workflowStage, "completed");
      assert.equal(row.statusText, "已完成");
      assert.equal(row.canPay, false);
      assert.equal(row.canCancel, false);
      assert.equal(row.finalPaid, finalPaid, "completion must preserve the actual final receipt");
      if (finalPaid > 0) assert.equal(row.finalPaymentStatus, "confirmed");
      else assert.notEqual(row.finalPaymentStatus, "confirmed");
    }
  }
}

test("visitor arrival opens final payment; only the verified receipt completes both order views", async t => {
  const store = createSvcMemoryStore({
    staff: [{ id: "service", account_id: "service-account", staff_status: "active" }],
    orders: [{ id: "service-order", orderNo: "SYNC-1", order_no: "SYNC-1", customer_openid: "sync-owner",
      status: "deposit_paid", workflowStage: "awaiting_dispatch", service_status: "confirmed", svc_paid_processed: 1,
      assignee_id: "service", photo_id: "photo", photographerId: "photo", category: "photo", net_amount_fen: 10000,
      schedule_time: "2026-11-13 11:00:00", paid_at: "2026-11-12 10:00:00",
      totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70,
      paymentRecords: [], statusLogs: [], followRecords: [] }],
  });
  const app = createSvcWorkbench({ store, benefit: {}, clock: () => at });
  const source = sourceFor(() => store.snapshot().orders, store);
  require("../lib/customerService.cjs").serviceFor(source, { store, benefit: {} });
  t.after(() => require("../lib/wechatPay.cjs").drainMerchantShare(source));
  assert.equal((await rpc(source, "confirmOrderArrival", { data: { orderId: "service-order" } }, owner)).success, true);
  const shooting = await rpc(source, "getMyOrders", { data: { businessStatus: "shooting" } }, owner);
  assert.equal(shooting.data[0].businessStatus, "shooting");
  assert.equal(shooting.data[0].workflowStage, "shooting");
  assert.equal(store.snapshot().orders[0].service_status, "shooting");
  assert.equal(store.snapshot().orders[0].done_at || null, null);
  assert.equal(store.snapshot().orders[0].completedAt || null, null);
  const detail = await rpc(source, "getOrderDetail", { data: { orderId: "service-order" } }, owner);
  assert.equal(detail.data.workflowStage, "shooting");
  assert.equal(detail.data.businessStatus, "shooting");
  assert.equal(detail.data.shootingCompleted, false);
  assert.equal(detail.data.canPayFinal, true);
  const counts = await rpc(source, "getOrderStatusCount", {}, owner);
  assert.equal(counts.data.businessStatus.completed, 0);
  assert.equal(counts.data.businessStatus.shooting, 1);
  assert.equal((await rpc(source, "getMyOrders", { data: { businessStatus: "completed" } }, owner)).data.length, 0);
  assert.equal(store.snapshot().bindings.length, 0, "shooting completion must not start customer protection");
  const saved = store.snapshot().orders[0];
  assert.equal(saved.status, "shooting");
  assert.equal(saved.finalPaid, undefined);
  assert.equal(saved.finalFinanceStatus, undefined);
  assert.deepEqual(saved.paymentRecords, []);
  const intent = await rpc(source, "createPayment", { data: { orderId: "service-order", phase: "final", selectionAccepted: true, idempotencyKey: "service-final-payment-0001" } }, { ...owner, wechatPay: createTestWechatPay() });
  assert.equal(intent.success, true, JSON.stringify(intent));
  assert.equal((await rpc(source, "getOrderDetail", { data: { orderId: "service-order" } }, owner)).data.businessStatus, "shooting");
  const payment = store.snapshot().orders[0].paymentRecords[0];
  const gateway = createTestRefundGateway(source);
  const transaction = { appid: "wx1234567890abcdef", mchid: "1900000109", outTradeNo: payment.outTradeNo,
    transactionId: "sync-final-receipt", tradeState: "SUCCESS", tradeType: "JSAPI", payerOpenid: "sync-owner", amountTotal: 7000, amountCurrency: "CNY" };
  await gateway.confirmTransaction(source, transaction);
  await assertPublicCompleted(source, ["service-order"], 70);
  assert.equal(store.snapshot().orders[0].service_status, "done");
  assert.ok(store.snapshot().orders[0].done_at);
  assert.equal(store.snapshot().bindings.length, 1);
  const completeLogCount = store.snapshot().operationLogs.filter(row => row.action === "order_complete").length;
  assert.equal(completeLogCount, 1);
  await gateway.confirmTransaction(source, transaction);
  assert.equal(store.snapshot().operationLogs.filter(row => row.action === "order_complete").length, completeLogCount);
  assert.equal(store.snapshot().bindings.length, 1);
});

test("zero-balance service orders wait for customer acknowledgement and complete without a WeChat charge", async t => {
  const store = createSvcMemoryStore({
    staff: [{ id: "service", account_id: "service-account", staff_status: "active" }],
    orders: [{ id: "zero-order", orderNo: "SYNC-ZERO", order_no: "SYNC-ZERO", customer_openid: "sync-owner",
      status: "shooting", service_status: "shooting", svc_paid_processed: 1, assignee_id: "service", photo_id: "photo",
      category: "photo", paid_at: "2026-11-12 10:00:00", totalAmount: 100, depositDue: 100, depositPaid: 100, depositFinanceStatus: "confirmed", finalDue: 0,
      paymentRecords: [], statusLogs: [], followRecords: [] }]
  });
  const source = sourceFor(() => store.snapshot().orders, store);
  const app = require("../lib/customerService.cjs").serviceFor(source, { store, benefit: {}, clock: () => at }).workbench;
  t.after(() => require("../lib/wechatPay.cjs").drainMerchantShare(source));
  const before = await rpc(source, "getOrderDetail", { data: { orderId: "zero-order" } }, owner);
  assert.equal(before.data.businessStatus, "shooting");
  assert.equal(before.data.canPay, false);
  assert.equal(before.data.canConfirmCompletion, true);
  assert.equal(store.snapshot().bindings.length, 0);
  const data = { orderId: "zero-order", phase: "final", confirmCompletion: true, idempotencyKey: "zero-service-completion-0001" };
  assert.equal((await rpc(source, "createPayment", { data }, owner)).success, false, "customer consent is required");
  const result = await rpc(source, "createPayment", { data: { ...data, selectionAccepted: true } }, owner);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.provider, "zero_balance");
  assert.equal(result.data.invokeWeChatPay, false);
  const saved = store.snapshot().orders[0];
  assert.equal(saved.service_status, "done");
  assert.equal(saved.finalPaid, 0);
  assert.equal(saved.paymentRecords.length, 1);
  assert.equal(saved.paymentRecords[0].externalTransactionId, undefined);
  assert.equal(store.snapshot().bindings.length, 1);
  assert.equal((await rpc(source, "getOrderDetail", { data: { orderId: "zero-order" } }, owner)).data.businessStatus, "completed");
  const repeated = await rpc(source, "createPayment", { data: { ...data, selectionAccepted: true } }, owner);
  assert.equal(repeated.data.idempotent, true);
  assert.equal(store.snapshot().operationLogs.filter(row => row.action === "order_complete").length, 1);
  const complete = app.onCompleted;
  try {
    app.onCompleted = async () => { throw new Error("temporary completion sink failure"); };
    const pending = await rpc(source, "getPaymentStatus", { data: { orderId: "zero-order", phase: "final" } }, owner);
    assert.equal(pending.success, true);
    assert.equal(pending.data.status, "confirmed", "a completion retry cannot hide the persisted receipt");
    assert.equal(pending.data.syncPending, true);
  } finally { app.onCompleted = complete; }
  const recovered = await rpc(source, "getPaymentStatus", { data: { orderId: "zero-order", phase: "final" } }, owner);
  assert.equal(recovered.success, true);
  assert.equal(recovered.data.syncPending, undefined);
  assert.equal(store.snapshot().operationLogs.filter(row => row.action === "order_complete").length, 1);
});

test("legacy completion facts remain visible even when deposit receipt metadata is missing", async () => {
  const orders = [{ completedAt: at }, { done_at: at }, { service_status: "done" }, { status: "completed" }]
    .map((facts, index) => ({ id: `legacy-${index}`, openid: "sync-owner", status: "new", totalAmount: 100,
      depositDue: 30, finalDue: 70, ...facts }));
  const source = sourceFor(() => orders);
  await assertPublicCompleted(source, orders.map(row => row.id));
  const hiddenDraft = { id: "unpaid", openid: "sync-owner", status: "new", totalAmount: 100, depositDue: 30, finalDue: 70 };
  orders.push(hiddenDraft);
  assert.equal(workflow.isUnpaidBooking(hiddenDraft), true);
  await assertPublicCompleted(source, orders.slice(0, -1).map(row => row.id));
});

test("service cancellation and refunds override old completion facts and payment review still blocks completion", async () => {
  for (const service_status of ["canceled", "cancelled", "refunded"]) {
    const row = { id: "terminal", status: "deposit_paid", service_status, completedAt: at, done_at: at,
      totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70 };
    const projected = workflow.publicOrderProjection(row);
    assert.equal(projected.businessStatus, "cancelled");
    assert.equal(projected.workflowStage, "cancelled");
    assert.equal(projected.legacyBusinessStatus, "cancelled");
    assert.equal(projected.canPay, false);
  }
  const reviewed = { id: "review", status: "deposit_paid", service_status: "done", completedAt: at, done_at: at,
    paymentReviewRequired: true, totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70 };
  const projected = workflow.publicOrderProjection(reviewed);
  assert.notEqual(projected.businessStatus, "completed");
  assert.notEqual(projected.workflowStage, "completed");
  assert.equal(projected.canPay, false);
});

test("customer_openid fallback preserves explicit ownership and never accepts caller-supplied identity", async () => {
  const orders = [
    { id: "service-owned", customer_openid: "sync-owner" },
    { id: "primary-owner", openid: "other-owner", customer_openid: "sync-owner" },
    { id: "legacy-owner", _openid: "other-owner", customer_openid: "sync-owner" },
    { id: "unbound", contactPhone: "13800000000" },
  ].map(row => ({ ...row, status: "completed", totalAmount: 100, depositDue: 30, finalDue: 70 }));
  const source = sourceFor(() => orders);
  await assertPublicCompleted(source, ["service-owned"]);
  for (const id of ["primary-owner", "legacy-owner", "unbound"]) {
    const detail = await rpc(source, "getOrderDetail", { data: { orderId: id, openid: "other-owner" } }, owner);
    assert.equal(detail.success, false);
  }
  const anonymous = await rpc(source, "getMyOrders", { data: { openid: "sync-owner" } });
  assert.equal(anonymous.success, false);
});
