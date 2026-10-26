"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createSource = require("../lib/dbSource.cjs");
const rpc = require("../lib/rpc.cjs");
const { finalizePaidBooking } = require("../lib/bookingRequests.cjs");

const owner = { identity: { kind: "public", openid: "customer-owner" } };
const stranger = { identity: { kind: "public", openid: "customer-other" } };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-order-center-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { backend: "json", jsonFile: path.join(directory, "db.json") };
  return { source: createSource(config), restart: () => createSource(config), file: config.jsonFile };
}

function payment(outTradeNo, phase = "deposit", patch = {}) {
  return {
    id: `payment-${outTradeNo}`, phase, provider: "wechat_pay", status: "confirmed",
    amount: phase === "deposit" ? 30 : 70, outTradeNo,
    idempotencyKey: `private-request-${outTradeNo}`, externalTransactionId: `private-transaction-${outTradeNo}`,
    ...patch,
  };
}

function order(id = "order-one", patch = {}) {
  return {
    id, orderNo: `LS-${id}`, openid: owner.identity.openid,
    status: "deposit_paid", workflowStage: "awaiting_dispatch",
    totalAmount: 100, depositDue: 30, finalDue: 70,
    depositPaid: 30, depositFinanceStatus: "已审",
    items: [{ productId: "photo-package", name: "旅拍套餐", price: 100, quantity: 1, internalNote: "private-item-note" }],
    paymentRecords: [payment("DEPOSIT_ONE")], ...patch,
  };
}

function booking(id = "booking-one", patch = {}) {
  return {
    ...order(id), bookingStatus: "pending_payment", status: "deposit_pending",
    workflowStage: "awaiting_deposit", depositPaid: 0, depositFinanceStatus: "待审",
    paymentRecords: [payment("BOOKING_ONE", "deposit", { status: "pending" })],
    ...patch,
  };
}

function detail(source, data, identity = owner) {
  return rpc(source, "getOrderDetail", { data }, identity);
}

function assertRejected(result) {
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.data, undefined);
}

function assertPublicOrder(result, expectedId) {
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data._id, expectedId);
  assert.equal(result.data.orderNo.length > 0, true);
  const forbidden = new Set(["openid", "_openid", "customerOpenid", "paymentRecords", "internalNote", "source", "sourceCodeId", "bookingIdempotencyKey"]);
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `Private field returned: ${key}`);
      walk(child);
    }
  };
  walk(result.data);
  assert.doesNotMatch(JSON.stringify(result.data), /private-request-|private-transaction-|private-item-note|private-source-marker/);
}

test("WeChat deposit and final transactions open the same public order after a source restart", async (t) => {
  const f = fixture(t);
  const saved = await f.source.create("orders", order("paid-order", {
    finalPaid: 70, finalFinanceStatus: "已审", status: "completed", workflowStage: "completed",
    paymentRecords: [payment("DEPOSIT_123"), payment("FINAL_123", "final")],
    internalNote: "private-item-note", source: { codeId: "private-source-marker" },
    customerOpenid: "private-other-alias", bookingIdempotencyKey: "private-request-booking",
  }));
  const source = f.restart();
  for (const query of [
    { outTradeNo: "DEPOSIT_123" }, { outTradeNo: "FINAL_123" },
    { out_trade_no: "FINAL_123" }, { outTradeNo: " FINAL_123 ", out_trade_no: "FINAL_123" },
  ]) {
    const result = await detail(source, query);
    assertPublicOrder(result, saved.id);
    assert.equal(result.data.paidAmount, 100);
  }
});

test("legacy _openid ownership and existing business-order links remain supported", async (t) => {
  const { source } = fixture(t);
  const saved = await source.create("orders", order("legacy-order", { openid: undefined, _openid: owner.identity.openid }));
  for (const query of [{ outTradeNo: "DEPOSIT_ONE" }, { orderId: saved.id }, { orderNo: saved.orderNo }]) {
    assertPublicOrder(await detail(source, query), saved.id);
    assertRejected(await detail(source, query, stranger));
  }
});

test("a transaction number never replaces an authenticated customer session", async (t) => {
  const { source } = fixture(t);
  await source.create("orders", order());
  for (const context of [{}, { identity: { kind: "admin", openid: owner.identity.openid } }, stranger]) {
    const result = await rpc(source, "getOrderDetail", {
      openid: owner.identity.openid,
      data: { outTradeNo: "DEPOSIT_ONE", openid: owner.identity.openid },
    }, context);
    assertRejected(result);
  }
});

test("invalid, missing and conflicting payment identifiers do not fall back to a supplied order ID", async (t) => {
  const { source } = fixture(t);
  const saved = await source.create("orders", order());
  const invalid = ["", " ", "${商品订单号}", "x".repeat(33), "trade/no", "交易号", 123, null, {}, ["DEPOSIT_ONE"]];
  for (const outTradeNo of invalid) assertRejected(await detail(source, { orderId: saved.id, outTradeNo }));
  for (const query of [
    {}, { outTradeNo: "UNKNOWN", orderId: saved.id },
    { outTradeNo: "DEPOSIT_ONE", out_trade_no: "DIFFERENT" },
    { outTradeNo: "DEPOSIT_ONE", out_trade_no: 123 },
    { outTradeNo: "DEPOSIT_ONE", orderId: "another-order" },
    { outTradeNo: "DEPOSIT_ONE", orderNo: "another-number" },
    { out_trade_no: "DEPOSIT_ONE", orderId: saved.id, orderNo: "another-number" },
  ]) assertRejected(await detail(source, query));
  assertPublicOrder(await detail(source, { outTradeNo: "DEPOSIT_ONE", orderId: saved.id, orderNo: saved.orderNo }), saved.id);
});

test("only WeChat payment records participate in transaction-number navigation", async (t) => {
  const { source } = fixture(t);
  for (const provider of ["manual", "test_payment", "mock", ""]) {
    await source.create("orders", order(`provider-${provider || "empty"}`, {
      paymentRecords: [payment(`TRADE_${provider || "empty"}`, "deposit", { provider })],
    }));
    assertRejected(await detail(source, { outTradeNo: `TRADE_${provider || "empty"}` }));
  }
});

test("duplicate transaction numbers across persisted orders or within one order fail closed", async (t) => {
  const { source } = fixture(t);
  await source.create("orders", order("first"));
  await source.create("orders", order("second"));
  assertRejected(await detail(source, { outTradeNo: "DEPOSIT_ONE", orderId: "first" }));
  await source.remove("orders", "second");
  await source.update("orders", "first", { paymentRecords: [payment("DEPOSIT_ONE"), payment("DEPOSIT_ONE", "final")] });
  assertRejected(await detail(source, { outTradeNo: "DEPOSIT_ONE" }));
});

test("duplicated booking transactions fail closed without promoting either draft", async (t) => {
  const { source } = fixture(t);
  const confirmed = { paymentRecords: [payment("BOOKING_ONE")], depositPaid: 30, depositFinanceStatus: "已审" };
  await source.create("bookingRequests", booking("first", confirmed));
  await source.create("bookingRequests", booking("second", confirmed));
  assertRejected(await detail(source, { outTradeNo: "BOOKING_ONE" }));
  assert.deepEqual(await source.list("orders"), []);
  await source.remove("bookingRequests", "second");
  await source.update("bookingRequests", "first", { paymentRecords: [payment("BOOKING_ONE"), payment("BOOKING_ONE", "deposit", { id: "duplicate-payment" })] });
  assertRejected(await detail(source, { outTradeNo: "BOOKING_ONE" }));
  assert.deepEqual(await source.list("orders"), []);
});

test("the retained booking deposit and its promoted order form one valid transaction link", async (t) => {
  const { source } = fixture(t);
  const draft = await source.create("bookingRequests", booking("promoted", {
    paymentRecords: [payment("PROMOTED_DEPOSIT")], depositPaid: 30, depositFinanceStatus: "已审",
  }));
  const promoted = await finalizePaidBooking(source, draft.id);
  assert.ok(promoted);
  await source.update("orders", promoted.id, { paymentRecords: [...promoted.paymentRecords, payment("PROMOTED_FINAL", "final")] });
  for (const outTradeNo of ["PROMOTED_DEPOSIT", "PROMOTED_FINAL"]) {
    assertPublicOrder(await detail(source, { outTradeNo, orderId: promoted.id, orderNo: promoted.orderNo }), promoted.id);
  }
  assertRejected(await detail(source, { outTradeNo: "PROMOTED_DEPOSIT", orderId: draft.id }));
  assert.equal((await source.list("orders")).length, 1);
});

test("an unrelated order cannot claim the transaction number of a paid booking", async (t) => {
  const { source } = fixture(t);
  const draft = await source.create("bookingRequests", booking("conflicted", {
    paymentRecords: [payment("CONFLICTED_TRADE")], depositPaid: 30, depositFinanceStatus: "已审",
  }));
  await source.create("orders", order("unrelated", { paymentRecords: [payment("CONFLICTED_TRADE")] }));
  const before = await source.get("bookingRequests", draft.id);
  assertRejected(await detail(source, { outTradeNo: "CONFLICTED_TRADE" }));
  assert.deepEqual(await source.get("bookingRequests", draft.id), before);
  assert.deepEqual((await source.list("orders")).map((row) => row.id), ["unrelated"]);
});

test("a copied booking link also requires matching ownership and confirmed-order identity", async (t) => {
  const { source } = fixture(t);
  const draft = await source.create("bookingRequests", booking("linked", {
    paymentRecords: [payment("LINKED_TRADE")], depositPaid: 30, depositFinanceStatus: "已审",
  }));
  const promoted = await finalizePaidBooking(source, draft.id);
  await source.update("bookingRequests", draft.id, { confirmedOrderId: "different-order" });
  assertRejected(await detail(source, { outTradeNo: "LINKED_TRADE" }));
  await source.update("bookingRequests", draft.id, { confirmedOrderId: promoted.id, openid: stranger.identity.openid });
  assertRejected(await detail(source, { outTradeNo: "LINKED_TRADE" }));
});

test("an authenticated owner recovers a paid booking once; foreign or inconsistent links have no side effects", async (t) => {
  const f = fixture(t);
  const draft = await f.source.create("bookingRequests", booking("interrupted", {
    openid: undefined, _openid: owner.identity.openid,
    paymentRecords: [payment("RECOVER_DEPOSIT")], depositPaid: 30, depositFinanceStatus: "已审",
  }));
  const before = fs.readFileSync(f.file, "utf8");
  const source = f.restart();
  assertRejected(await detail(source, { outTradeNo: "RECOVER_DEPOSIT", openid: owner.identity.openid }, stranger));
  assertRejected(await detail(source, { outTradeNo: "RECOVER_DEPOSIT", orderId: "wrong-order" }));
  assertRejected(await detail(source, { outTradeNo: "RECOVER_DEPOSIT", orderNo: "wrong-order-number" }));
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.deepEqual(await source.list("orders"), []);
  assert.deepEqual(await source.get("bookingRequests", draft.id), draft);
  const results = await Promise.all([
    detail(source, { outTradeNo: "RECOVER_DEPOSIT" }),
    detail(source, { out_trade_no: "RECOVER_DEPOSIT", orderNo: draft.orderNo }),
  ]);
  const first = results[0];
  for (const result of results) assertPublicOrder(result, first.data._id);
  const orders = await source.list("orders");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].bookingId, draft.id);
  assert.equal((await source.get("bookingRequests", draft.id)).confirmedOrderId, orders[0].id);
  assertPublicOrder(await detail(f.restart(), { outTradeNo: "RECOVER_DEPOSIT" }), orders[0].id);
  assert.equal((await source.list("orders")).length, 1);
});

test("unconfirmed and deleted booking requests stay private and never become formal orders", async (t) => {
  const { source } = fixture(t);
  for (const [id, patch] of [
    ["pending", {}],
    ["failed", { paymentRecords: [payment("BOOKING_ONE", "deposit", { status: "failed" })] }],
    ["cancelled", { bookingStatus: "cancelled" }],
    ["deleted", { deleted: true, paymentRecords: [payment("BOOKING_ONE")], depositPaid: 30, depositFinanceStatus: "已审" }],
    ["is-deleted", { isDeleted: true, paymentRecords: [payment("BOOKING_ONE")], depositPaid: 30, depositFinanceStatus: "已审" }],
  ]) {
    const draft = await source.create("bookingRequests", booking(id, patch));
    const before = await source.get("bookingRequests", id);
    assertRejected(await detail(source, { outTradeNo: "BOOKING_ONE" }));
    assert.deepEqual(await source.get("bookingRequests", id), before);
    assert.deepEqual(await source.list("orders"), []);
    await source.remove("bookingRequests", draft.id);
  }
});

test("deleted orders and orders still awaiting a deposit are not exposed by payment links", async (t) => {
  const { source } = fixture(t);
  for (const [id, patch] of [
    ["deleted", { deleted: true }], ["is-deleted", { isDeleted: true }],
    ["unpaid", { status: "deposit_pending", workflowStage: "awaiting_deposit", depositPaid: 0, depositFinanceStatus: "待审", paymentRecords: [payment("DEPOSIT_ONE", "deposit", { status: "pending" })] }],
  ]) {
    await source.create("orders", order(id, patch));
    assertRejected(await detail(source, { outTradeNo: "DEPOSIT_ONE" }));
    await source.remove("orders", id);
  }
});

test("indexed transaction lookups are used for both collections without scanning source data", async (t) => {
  const { source } = fixture(t);
  const draft = await source.create("bookingRequests", booking("indexed", {
    paymentRecords: [payment("INDEXED_DEPOSIT")], depositPaid: 30, depositFinanceStatus: "已审",
  }));
  const promoted = await finalizePaidBooking(source, draft.id);
  const calls = [];
  source.findOrderByPaymentOutTradeNo = async (outTradeNo) => {
    calls.push(["order", outTradeNo]);
    return outTradeNo === "INDEXED_DEPOSIT" ? source.get("orders", promoted.id) : null;
  };
  source.findBookingByPaymentOutTradeNo = async (outTradeNo) => {
    calls.push(["booking", outTradeNo]);
    return outTradeNo === "INDEXED_DEPOSIT" ? source.get("bookingRequests", draft.id) : null;
  };
  source.list = async () => { throw new Error("Unexpected collection scan"); };
  assertPublicOrder(await detail(source, { outTradeNo: "INDEXED_DEPOSIT" }), promoted.id);
  assertRejected(await detail(source, { outTradeNo: "MISSING_INDEXED" }));
  assert.deepEqual(calls, [
    ["order", "INDEXED_DEPOSIT"], ["booking", "INDEXED_DEPOSIT"],
    ["order", "MISSING_INDEXED"], ["booking", "MISSING_INDEXED"],
  ]);
});
