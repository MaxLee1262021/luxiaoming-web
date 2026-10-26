"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const createSource = require("../lib/dbSource.cjs");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const { createWechatPay } = require("../lib/wechatPay.cjs");
const { createTestWechatPay } = require("./helpers/wechatPay.cjs");

const identity = { identity: { kind: "public", openid: "lifecycle-owner" } };
const bookingInput = {
  name: "生命周期测试游客", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午",
  agreement: { version: "v1.0", current: true }, items: [{ packageId: "lifecycle-package" }], idempotencyKey: "customer-lifecycle-booking",
};

function callbackGateway() {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return createWechatPay({
    config: {
      apiHost: "api.mch.weixin.qq.com", mchId: "1900000109", appId: "wx1234567890abcdef", merchantSerialNo: "LOCAL_TEST_SERIAL",
      merchantPrivateKey: keys.privateKey.export({ type: "pkcs1", format: "pem" }), apiV3Key: "0123456789abcdef0123456789abcdef",
      notifyUrl: "https://example.test/notify", platformPublicKeyId: "LOCAL_TEST_PUBLIC_KEY",
      platformPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    },
    transport: async () => { throw new Error("Lifecycle regression tests must not access the network"); },
  });
}

function successTransaction(payment, amount) {
  return {
    appid: "wx1234567890abcdef", mchid: "1900000109", outTradeNo: payment.outTradeNo,
    transactionId: `verified-${payment.phase}-${payment.id}`, tradeState: "SUCCESS", tradeType: "JSAPI",
    payerOpenid: identity.identity.openid, amountTotal: amount * 100, amountCurrency: "CNY",
  };
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-customer-lifecycle-"));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const source = createSource({ backend: "json", jsonFile: path.join(directory, "db.json") });
  await source.create("packages", { id: "lifecycle-package", name: "旅拍套餐", price: 100, depositRatio: 30, status: "已上架" });
  for (const role of ["super", "finance", "photo"]) await source.create("staff", { id: `lifecycle-${role}`, account: `lifecycle-${role}`, role, status: "active" });
  const sessions = Object.fromEntries(["super", "finance", "photo"].map((role) => [`${role}-token`, {
    kind: "admin", subjectId: `lifecycle-${role}`, account: `lifecycle-${role}`, role, menuKeys: ["orders", "afterSales", "financeReview", "tasks"],
  }]));
  const auth = { async init() {}, async getSession(token) { return sessions[token] || null; } };
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (role, orderId, body, afterSale = false) => {
    const response = await fetch(`${base}/api/${afterSale ? "after-sales" : "orders"}/${orderId}/action`, {
      method: "POST", headers: { Authorization: `Bearer ${role}-token`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { source, post, gateway: callbackGateway(), paymentContext: { ...identity, wechatPay: createTestWechatPay() } };
}

async function createPaidBooking(source, gateway, paymentContext, input = bookingInput) {
  const booking = await rpc(source, "createBooking", { data: input }, identity);
  assert.equal(booking.success, true, JSON.stringify(booking));
  assert.equal(booking.bookingStatus, "pending_payment");
  assert.equal((await source.list("orders")).length, 0);
  const intent = await rpc(source, "createPayment", { data: {
    bookingId: booking.bookingId, phase: "deposit", idempotencyKey: "lifecycle-deposit-payment",
    status: "assigned", photographerId: "lifecycle-photo", dispatchRecord: { next: { photographerId: "lifecycle-photo" } },
  } }, paymentContext);
  assert.equal(intent.success, true, JSON.stringify(intent));
  assert.equal((await source.list("orders")).length, 0);
  const forged = await rpc(source, "getPaymentStatus", { data: {
    bookingId: booking.bookingId, phase: "deposit", status: "completed", depositPaid: 30, finalPaid: 70,
  } }, identity);
  assert.equal(forged.data.bookingStatus, "pending_payment");
  // Old records can contain a placeholder dispatch object. Persist it before
  // promotion to exercise the real checkout-to-order boundary.
  await source.update("bookingRequests", booking.bookingId, { dispatchRecord: {} });
  const draft = await source.get("bookingRequests", booking.bookingId);
  const callback = await gateway.confirmTransaction(source, successTransaction(draft.paymentRecords[0], 30));
  assert.equal(callback.order.status, "deposit_paid");
  assert.equal(callback.order.workflowStage, "awaiting_dispatch");
  assert.equal(callback.order.photographerId, "");
  return callback.order.id;
}

async function assertPublicState(source, orderId, businessStatus, text, refundable = false) {
  const detail = await rpc(source, "getOrderDetail", { data: { orderId } }, identity);
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.equal(detail.data.businessStatus, businessStatus);
  assert.equal(detail.data.statusText, text);
  assert.equal(detail.data.canRefundDeposit, refundable);
  assert.equal(detail.data.refundableDepositAmount, refundable ? 30 : 0);
  const counters = await rpc(source, "getOrderStatusCount", {}, identity);
  assert.equal(counters.success, true);
  for (const status of ["reserved", "awaiting_shoot", "shooting", "completed"]) {
    const list = await rpc(source, "getMyOrders", { data: { businessStatus: status } }, identity);
    assert.equal(list.success, true);
    assert.deepEqual(list.data.map((order) => order.id), status === businessStatus ? [orderId] : []);
    assert.equal(counters.data.businessStatus[status], status === businessStatus ? 1 : 0);
    assert.equal(counters.data[status], list.total);
  }
  return detail.data;
}

test("customer order advances only after deposit, valid assignment, manual start and completed shooting plus final payment", async (t) => {
  const { source, post, gateway, paymentContext } = await fixture(t);
  const orderId = await createPaidBooking(source, gateway, paymentContext, {
    ...bookingInput, status: "assigned", photographerId: "lifecycle-photo", dispatchStatus: "assigned",
    dispatchRecord: { next: { photographerId: "lifecycle-photo" } }, shootingStartedAt: "2026-10-26T00:00:00Z",
    depositPaid: 30, depositFinanceStatus: "confirmed", finalPaid: 70, finalFinanceStatus: "confirmed",
  });
  const reserved = await assertPublicState(source, orderId, "reserved", "待确认", true);
  assert.equal(reserved.workflowStage, "awaiting_dispatch");
  assert.equal(reserved.canPayFinal, false);
  assert.equal((await post("super", orderId, { action: "start", reason: "未安排摄影师尝试开拍" })).status, 409);
  assert.equal((await post("super", orderId, { action: "assign", reason: "缺少摄影师的无效安排" })).status, 400);
  await assertPublicState(source, orderId, "reserved", "待确认", true);
  const assigned = await post("super", orderId, {
    action: "assign", photographerId: "lifecycle-photo", confirmedShootDate: "2026-12-20", confirmedShootTime: "10:00",
    confirmedShootLocation: "橘子洲集合点", participantCount: 2, confirmationMethod: "客服人工确认", customerConfirmationNote: "游客确认档期", reason: "已与摄影师和游客确认",
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const awaitingShoot = await assertPublicState(source, orderId, "awaiting_shoot", "待拍摄");
  assert.equal(awaitingShoot.workflowStage, "awaiting_shoot");
  assert.equal((await source.get("orders", orderId)).shootingStartedAt || "", "");
  const prematureFinal = await rpc(source, "createPayment", { data: {
    orderId, phase: "final", selectionAccepted: true, idempotencyKey: "lifecycle-before-start-final",
  } }, paymentContext);
  assert.equal(prematureFinal.success, false);
  const started = await post("super", orderId, { action: "start", reason: "员工手动确认开始拍摄" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const shooting = await assertPublicState(source, orderId, "shooting", "拍摄中");
  assert.equal(shooting.canPayFinal, false);
  const duringShootFinal = await rpc(source, "createPayment", { data: {
    orderId, phase: "final", selectionAccepted: true, idempotencyKey: "lifecycle-during-shoot-final",
  } }, paymentContext);
  assert.equal(duringShootFinal.success, false);
  const shot = await post("super", orderId, { action: "shootcomplete", reason: "员工确认本次拍摄完成" });
  assert.equal(shot.status, 200, JSON.stringify(shot.body));
  const awaitingFinal = await assertPublicState(source, orderId, "shooting", "拍摄中");
  assert.equal(awaitingFinal.workflowStage, "awaiting_final_payment");
  assert.equal(awaitingFinal.canPayFinal, true);
  const finalIntent = await rpc(source, "createPayment", { data: {
    orderId, phase: "final", selectionAccepted: true, idempotencyKey: "lifecycle-final-payment",
  } }, paymentContext);
  assert.equal(finalIntent.success, true, JSON.stringify(finalIntent));
  await assertPublicState(source, orderId, "shooting", "拍摄中");
  const beforeFinal = await source.get("orders", orderId);
  const finalRecord = beforeFinal.paymentRecords.find((record) => record.phase === "final" && record.provider === "wechat_pay");
  await gateway.confirmTransaction(source, successTransaction(finalRecord, 70));
  const completed = await assertPublicState(source, orderId, "completed", "已完成");
  assert.equal(completed.workflowStage, "completed");
  assert.equal(completed.canPayFinal, false);
  const saved = await source.get("orders", orderId);
  assert.equal(saved.status, "completed");
  assert.equal(saved.depositPaid, 30);
  assert.equal(saved.finalPaid, 70);
  assert.ok(saved.completedAt);
  assert.equal(saved.paymentRecords.filter((record) => record.status === "confirmed").length, 2);
});

test("a paid booking supports reviewed deposit refund before any photographer is arranged", async (t) => {
  const { source, post, gateway, paymentContext } = await fixture(t);
  const orderId = await createPaidBooking(source, gateway, paymentContext);
  await assertPublicState(source, orderId, "reserved", "待确认", true);
  const submitted = await rpc(source, "submitAfterSale", { data: { orderId, type: "定金退款", reason: "行程调整申请全额退还定金" } }, identity);
  assert.equal(submitted.success, true, JSON.stringify(submitted));
  const reviewed = await post("finance", submitted.data.ticketId, {
    action: "review", approved: true, reason: "核实未派单并人工退还定金", refundTransactionId: "lifecycle-manual-refund-proof",
  }, true);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const detail = await rpc(source, "getOrderDetail", { data: { orderId } }, identity);
  assert.equal(detail.data.businessStatus, "cancelled");
  assert.equal(detail.data.canRefundDeposit, false);
  assert.equal((await source.get("orders", orderId)).depositPaid, 30);
});

test("an assigned status marker without a photographer does not advance the public lifecycle", async (t) => {
  const { source, gateway, paymentContext } = await fixture(t);
  const orderId = await createPaidBooking(source, gateway, paymentContext);
  await source.update("orders", orderId, { status: "assigned", dispatchStatus: "assigned", photographerId: "", dispatchRecord: {} });
  const detail = await rpc(source, "getOrderDetail", { data: { orderId } }, identity);
  assert.equal(detail.success, true);
  assert.equal(detail.data.businessStatus, "reserved");
  assert.equal(detail.data.workflowStage, "awaiting_dispatch");
  assert.equal(detail.data.statusText, "待确认");
});
