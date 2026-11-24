"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sourceFactory = require("./fixtures/jsonSource.cjs");
const { requestOrderRefund } = require("../lib/customerCancellation.cjs");
const { createTestRefundGateway } = require("./helpers/wechatPay.cjs");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-refund-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = sourceFactory({ jsonFile: path.join(directory, "db.json") });
  await source.create("orders", {
    id: "race-order", orderNo: "REFUND-RACE", openid: "owner", status: "deposit_paid",
    workflowStage: "awaiting_dispatch", totalAmount: 100, depositDue: 30,
    depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70,
    paymentRecords: [{ id: "deposit", phase: "deposit", provider: "wechat_pay", amount: 30,
      status: "confirmed", outTradeNo: "REFUND_RACE_DEPOSIT", externalTransactionId: "WX_REFUND_RACE" }],
    statusLogs: [], followRecords: [],
  });
  return { source, wechatPay: createTestRefundGateway(source, { status: "PROCESSING" }) };
}
const request = fixture => requestOrderRefund(fixture.source, "owner", {
  orderId: "race-order", idempotencyKey: "refund-race-request", reason: "行程调整申请退款",
}, { wechatPay: fixture.wechatPay });
const posts = fixture => fixture.wechatPay.refundRequests.filter(row => row.method === "POST");

test("a staff after-sale created during refund preflight stays in its finance workflow", async t => {
  const f = await fixture(t), list = f.source.list.bind(f.source);
  let reads = 0;
  f.source.list = async key => {
    if (key === "afterSales" && ++reads === 2) {
      // Another process creates and associates a staff issue after the first
      // refund eligibility check, while the customer's request is still live.
      await f.source.create("afterSales", {
        id: "staff-issue", orderId: "race-order", type: "退款申请", status: "pending",
        reviewLane: "service_exception", refundAmount: 20, financeStatus: "未提交",
      });
      await f.source.update("orders", "race-order", { afterSaleId: "staff-issue", afterSaleStatus: "pending" });
    }
    return list(key);
  };
  const response = await request(f);
  assert.equal(response.success, false, JSON.stringify(response));
  const saved = await f.source.get("orders", "race-order");
  assert.equal(saved.status, "deposit_paid");
  assert.equal(saved.afterSaleId, "staff-issue");
  assert.equal(saved.afterSaleStatus, "pending");
  const ticket = await f.source.get("afterSales", "staff-issue");
  assert.equal(ticket.status, "pending");
  assert.equal(ticket.financeStatus, "未提交");
  assert.notEqual(ticket.refundStatus, "superseded");
  assert.equal((await list("afterSales")).length, 1, "no automatic ledger was created");
  assert.equal(posts(f).length, 0);
});

test("a guard change at the cancellation write rejects the stale refund and removes its orphan ledger", async t => {
  for (const patch of [
    { afterSaleId: "late-issue", afterSaleStatus: "pending" },
    { paymentReviewRequired: true },
    { depositRefundable: false },
  ]) await t.test(JSON.stringify(patch), async subtest => {
    const f = await fixture(subtest), compare = f.source.compareAndUpdate.bind(f.source);
    let injected = false;
    f.source.compareAndUpdate = async (key, id, expected, update) => {
      if (!injected && key === "orders" && update.status === "cancelled") {
        injected = true;
        await f.source.update("orders", id, patch);
      }
      return compare(key, id, expected, update);
    };
    const response = await request(f);
    assert.equal(injected, true, "the race reached the final cancellation CAS");
    assert.equal(response.success, false, JSON.stringify(response));
    const saved = await f.source.get("orders", "race-order");
    assert.equal(saved.status, "deposit_paid");
    assert.equal(saved.depositPaid, 30);
    for (const [field, value] of Object.entries(patch)) assert.equal(saved[field], value);
    assert.deepEqual(await f.source.list("afterSales"), [], "an uncommitted automatic ledger cannot be reconciled later");
    assert.equal(posts(f).length, 0);
  });
});
