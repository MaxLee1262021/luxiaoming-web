"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createShareService } = require("../lib/merchantShare.cjs");
const NOW = "2026-11-15T12:00:00Z";
const owner = { kind: "admin", role: "merchant", shopId: "owned-shop" };

function order(id, patch = {}) {
  return { id, orderNo: `PRIVATE-ORDER-${id}`, createdAt: "2026-11-10T00:00:00Z", shopId: "owned-shop", source: { shopId: "owned-shop" },
    totalAmount: 100, depositDue: 30, finalDue: 70, depositPaid: "30.00", depositFinanceStatus: "confirmed", finalPaid: "0.00", workflowStage: "awaiting_final_payment",
    openid: "PRIVATE_OPENID", name: "PRIVATE_CUSTOMER", phone: "13800138000", address: "PRIVATE_ADDRESS", products: [{ name: "PRIVATE_PRODUCT" }], ...patch };
}
function paidOrder(id, patch = {}) {
  return order(id, { finalPaid: "70.00", finalPaidAt: "2026-11-12T00:00:00Z", workflowStage: "completed",
    paymentRecords: [{ phase: "final", amount: 70, status: "confirmed", provider: "wechat_pay" }], ...patch });
}
function fixture(orders = [], overrides = {}) {
  const calls = { jobs: [], snapshots: [], filters: [] }, jobs = new Map(), snapshots = new Map();
  const source = { list: async key => { assert.equal(key, "orders"); return orders; }, create() { throw new Error("read-only projection cannot write"); }, update() { throw new Error("read-only projection cannot write"); } };
  let physicalStore;
  if (overrides.physical) {
    const physical = require("../lib/physicalCommerce.cjs");
    physicalStore = physical.createMemoryStore(overrides.physical);
    physical.serviceFor(source, { store: physicalStore });
  }
  const store = {
    getMerchant: async id => ({ id, name: "本店", status: "OPEN" }),
    getRules: async () => [{ ratioT1: "0.1000", ratioT2: "0.0500", ttlHours: 720, refundWindowDays: 3 }],
    listDetails: async query => { calls.filters.push(query); return { list: [], total: 3, orderCount: 2, sum: { netAmount: "12.00" } }; },
    getMerchantStats: async () => ({ boundUsers: 4, accT1Amount: "15.00", accT2Amount: "0.00", monthOrders: 99 }),
    getJob: async id => { calls.jobs.push(id); return jobs.get(id) || null; },
    getEffectiveAttribution: async id => { calls.snapshots.push(id); return { state: snapshots.get(id) || null }; },
    ...overrides.store,
  };
  const service = createShareService(source, { clock: () => new Date(NOW), enableAt: "2026-11-01T00:00:00Z", ...overrides, store });
  return { service, store, jobs, snapshots, calls, physicalStore };
}

test("merchant associated orders show payment and commission progress without adding expected commission to posted totals", async () => {
  const f = fixture([order("1001"), paidOrder("1002"), paidOrder("1003"), paidOrder("1004"), paidOrder("1005"), paidOrder("1006"), paidOrder("1007")]);
  f.jobs.set("1002", { status: "PENDING", availableAt: "2026-11-16T00:00:00Z", decisionJson: { hitMerchantId: "owned-shop" } });
  f.jobs.set("1003", { status: "PENDING", availableAt: "2026-11-14T00:00:00Z", decisionJson: { hitMerchantId: "owned-shop" } });
  f.jobs.set("1006", { status: "FAILED" });
  f.snapshots.set("1004", { hitMerchantId: "owned-shop", splitAmount: "10.00", status: "EFFECTIVE" });
  f.snapshots.set("1005", { hitMerchantId: "PRIVATE_OTHER_MERCHANT", splitAmount: "99.00", status: "EFFECTIVE" });
  f.snapshots.set("1007", { hitMerchantId: "owned-shop", splitAmount: "0.00", status: "VOID" });
  const result = await f.service.mine({}, owner);
  assert.equal(result.orderTotal, 6); assert.deepEqual(result.orderStats, { total: 6 });
  const rows = Object.fromEntries(result.orders.map(row => [row.orderNo.slice(-4), row]));
  assert.equal(rows["1001"].status, "awaiting_final_payment"); assert.equal(rows["1001"].paidAmount, "30.00");
  assert.equal(rows["1002"].status, "observing"); assert.equal(rows["1002"].paidAmount, "100.00");
  assert.equal(rows["1003"].status, "pending"); assert.equal(rows["1004"].status, "posted");
  assert.equal(rows["1005"], undefined, "another merchant's posted attribution cannot remain in the checkout merchant's list"); assert.equal(rows["1006"].status, "review");
  assert.equal(rows["1007"].statusText, "已核算（分成为0）");
  assert.equal(result.stats.monthAmount, "12.00"); assert.equal(result.stats.monthOrders, 2);
  assert.equal(result.total, 3); assert.deepEqual(result.list, []);
  const json = JSON.stringify(result);
  for (const secret of ["PRIVATE-ORDER-", "PRIVATE_OPENID", "PRIVATE_CUSTOMER", "13800138000", "PRIVATE_ADDRESS", "PRIVATE_PRODUCT", "PRIVATE_OTHER_MERCHANT", "99.00"]) assert.equal(json.includes(secret), false, secret);
  for (const row of result.orders) assert.deepEqual(Object.keys(row).sort(), ["createdAt", "orderNo", "paidAmount", "status", "statusText"].sort());
});

test("order ownership ignores query impersonation and paginates after resolving authoritative accounting facts", async () => {
  const f = fixture([
    order("1001"), order("1002", { shopId: "", source: { shopId: "owned-shop" } }),
    order("1003", { shopId: "other-shop", source: { shopId: "owned-shop" } }),
    order("1004", { shopId: "other-shop", source: { shopId: "other-shop" } }),
    order("1005", { isDeleted: true }), order("1006", { orderType: "physical" }),
    order("1007", { workflowStage: "awaiting_deposit", depositPaid: 0 }),
    order("1008", { createdAt: "2026-10-31T15:59:59Z" }),
    order("1009", { createdAt: "2026-10-31T16:00:00Z" }),
  ]);
  const result = await f.service.mine({ merchantId: "other-shop", userId: "PRIVATE_OPENID", orderPage: 2, orderSize: 1 }, owner);
  assert.equal(result.merchant.merchantId, "owned-shop"); assert.equal(result.orderTotal, 3);
  assert.equal(result.orders.length, 1); assert.equal(result.orders[0].orderNo, "****1001");
  assert.deepEqual(f.calls.jobs, ["1004", "1003", "1002", "1001", "1009"]); assert.deepEqual(f.calls.snapshots, f.calls.jobs);
  assert.equal(f.calls.filters[0].merchantId, "owned-shop");
  const october = await f.service.mine({ period: "2026-10" }, owner);
  assert.equal(october.orderTotal, 1); assert.equal(october.orders[0].orderNo, "****1008");
  assert.equal(october.stats.monthOrders, 2, "selected-period ledger orderCount wins over current-month statistics");
  assert.equal(f.calls.filters.at(-1).period, "2026-10");
});

test("unactivated commission remains visible as a business notice while historical posted facts stay posted", async () => {
  const f = fixture([paidOrder("1001"), paidOrder("1002")], { enableAt: "2099-01-01T00:00:00Z" });
  f.snapshots.set("1002", { hitMerchantId: "owned-shop", splitAmount: "10.00" });
  const result = await f.service.mine({}, owner);
  assert.match(result.notices[0], /商家分成尚未启用/);
  assert.equal(result.orders.find(row => row.orderNo === "****1001").status, "review");
  assert.equal(result.orders.find(row => row.orderNo === "****1002").status, "posted");
  assert.equal(result.stats.monthAmount, "12.00");
});

test("missing frozen source cannot be inferred from a prior customer scan, and unavailable progress never leaks internal errors", async () => {
  const missing = fixture([paidOrder("1001", { shopId: "", source: {}, latestScanMerchantId: "owned-shop" })]);
  const empty = await missing.service.mine({}, owner);
  assert.equal(empty.orderTotal, 0); assert.deepEqual(empty.orders, []);
  assert.ok(empty.notices.some(notice => notice.includes("核对来源")));
  const unavailable = fixture([paidOrder("1002")], { store: { getJob: async () => { throw new Error("PRIVATE_DATABASE_DETAILS"); } } });
  const result = await unavailable.service.mine({}, owner);
  assert.equal(result.orderTotal, 0); assert.deepEqual(result.orders, []);
  assert.ok(result.notices.some(notice => notice.includes("暂不可用")));
  assert.equal(JSON.stringify(result).includes("PRIVATE_DATABASE_DETAILS"), false);
});

test("failed attribution reads cannot expose a paid order to its former checkout merchant", async () => {
  for (const unavailable of ["job", "snapshot"]) {
    const f = fixture([paidOrder("PRIVATE-5001")], { store: unavailable === "job"
      ? { getJob: async () => { throw new Error("PRIVATE_JOB_FAILURE"); } }
      : { getEffectiveAttribution: async () => { throw new Error("PRIVATE_SNAPSHOT_FAILURE"); } } });
    f.jobs.set("PRIVATE-5001", { status: "PENDING", decisionJson: { hitMerchantId: "new-merchant" } });
    f.snapshots.set("PRIVATE-5001", { hitMerchantId: "new-merchant", splitAmount: "10.00" });
    const result = await f.service.mine({}, owner);
    assert.equal(result.orderTotal, 0); assert.deepEqual(result.orders, []);
    assert.ok(result.notices.some(notice => notice.includes("暂不可用")));
    for (const privateText of ["5001", "100.00", "new-merchant", "PRIVATE_JOB_FAILURE", "PRIVATE_SNAPSHOT_FAILURE"]) assert.equal(JSON.stringify(result).includes(privateText), false, privateText);
  }
});

test("manual final receipts require review and malformed order pagination is rejected", async () => {
  const f = fixture([paidOrder("1001", { paymentRecords: [{ phase: "final", status: "confirmed", amount: 70, provider: "manual" }] })]);
  const result = await f.service.mine({}, owner); assert.equal(result.orders[0].status, "review");
  await assert.rejects(f.service.mine({ orderSize: 101 }, owner), { code: "SHARE_4001" });
  await assert.rejects(f.service.mine({ orderPage: -1 }, owner), { code: "SHARE_4001" });
});

test("payment attribution moves progress to the latest merchant across checkout origins before pagination", async () => {
  const f = fixture([
    paidOrder("2001", { shopId: "old-shop", source: { shopId: "old-shop" } }),
    paidOrder("2002", { shopId: "old-shop", source: { shopId: "old-shop" } }),
    paidOrder("2003"), paidOrder("2004"),
  ]);
  f.jobs.set("2001", { status: "PENDING", availableAt: "2026-11-16T00:00:00Z", decisionJson: { hitMerchantId: "owned-shop" } });
  f.snapshots.set("2002", { hitMerchantId: "owned-shop", splitAmount: "10.00" });
  f.jobs.set("2003", { status: "PENDING", decisionJson: { hitMerchantId: "new-other-shop" } });
  f.snapshots.set("2004", { hitMerchantId: null, splitAmount: "0.00" });
  const first = await f.service.mine({ orderPage: 1, orderSize: 1 }, owner);
  const second = await f.service.mine({ orderPage: 2, orderSize: 1 }, owner);
  assert.equal(first.orderTotal, 2); assert.equal(second.orderTotal, 2);
  assert.equal(first.orders[0].orderNo, "****2002"); assert.equal(first.orders[0].status, "posted");
  assert.equal(second.orders[0].orderNo, "****2001"); assert.equal(second.orders[0].status, "observing");
  for (const result of [first, second]) {
    assert.equal(JSON.stringify(result).includes("old-shop"), false);
    assert.equal(result.stats.monthAmount, "12.00", "read-only progress does not add expected commission to the ledger");
  }
});

function physicalOrder(id, patch = {}) {
  return { id, orderNo: `PRIVATE-PHYSICAL-${id}`, openid: "PRIVATE_PHYSICAL_CUSTOMER", createdAt: "2026-11-10T00:00:00Z",
    orderType: "physical", paymentMode: "standalone", status: "awaiting_shipment", source: { shopId: "owned-shop" },
    shopId: "owned-shop", goodsAmountFen: 12900, shippingFeeFen: 800, totalAmountFen: 13700,
    paidAt: "2026-11-12T00:00:00Z", items: [{ id: "private-item", name: "PRIVATE_PHYSICAL_PRODUCT", quantity: 1, amountFen: 12900 }],
    address: { recipient: "PRIVATE_RECIPIENT", phone: "13800138000", detail: "PRIVATE_ADDRESS" }, ...patch };
}
function physicalPayment(orderId) {
  return { id: `pay-${orderId}`, orderId, status: "confirmed", provider: "wechat_pay", amountFen: 13700, paidAt: "2026-11-12T00:00:00Z", confirmedAt: "2026-11-12T00:00:00Z", externalTransactionId: "PRIVATE_TRANSACTION" };
}

test("independent physical orders share merchant progress with service orders while package children are counted only in their parent", async () => {
  const f = fixture([paidOrder("3001")], { physical: {
    orders: [physicalOrder("3002"), physicalOrder("3003", { status: "pending_payment", paidAt: undefined }), physicalOrder("3004", { paymentMode: "package", parentOrderId: "3001" }), physicalOrder("3005", { shopId: "other-shop", source: { shopId: "other-shop" } })],
    payments: [physicalPayment("3002"), physicalPayment("3004"), physicalPayment("3005")],
  } });
  f.jobs.set("3002", { status: "PENDING", availableAt: "2026-11-16T00:00:00Z", decisionJson: { hitMerchantId: "owned-shop" } });
  const before = f.physicalStore.snapshot();
  const result = await f.service.mine({}, owner);
  assert.equal(result.orderTotal, 3);
  assert.deepEqual(result.orders.map(row => row.orderNo), ["****3003", "****3002", "****3001"]);
  assert.equal(result.orders[0].statusText, "待付款"); assert.equal(result.orders[0].paidAmount, "0.00");
  assert.equal(result.orders[1].status, "observing"); assert.equal(result.orders[1].paidAmount, "137.00", "display actual money including shipping without changing the commission base");
  assert.equal(result.stats.monthAmount, "12.00");
  assert.deepEqual(f.physicalStore.snapshot(), before, "merchant progress never writes transaction or commission facts");
  for (const secret of ["PRIVATE-PHYSICAL-", "PRIVATE_PHYSICAL_CUSTOMER", "PRIVATE_PHYSICAL_PRODUCT", "PRIVATE_RECIPIENT", "13800138000", "PRIVATE_ADDRESS", "PRIVATE_TRANSACTION"]) assert.equal(JSON.stringify(result).includes(secret), false, secret);
  for (const row of result.orders) assert.deepEqual(Object.keys(row).sort(), ["createdAt", "orderNo", "paidAmount", "status", "statusText"].sort());
});

test("a physical order's posted merchant wins over checkout merchant and the ledger stays visible after full refund", async () => {
  const f = fixture([], { physical: {
    orders: [physicalOrder("4001", { shopId: "old-shop", source: { shopId: "old-shop" }, status: "closed", refundedFen: 13700 }), physicalOrder("4002")],
    payments: [physicalPayment("4001"), physicalPayment("4002")],
  } });
  f.snapshots.set("4001", { hitMerchantId: "owned-shop", splitAmount: "12.90" });
  f.jobs.set("4002", { status: "PENDING", decisionJson: { hitMerchantId: "other-shop" } });
  const result = await f.service.mine({}, owner);
  assert.equal(result.orderTotal, 1);
  assert.equal(result.orders[0].orderNo, "****4001");
  assert.equal(result.orders[0].status, "posted");
  assert.equal(result.orders[0].paidAmount, "137.00");
  assert.equal(result.stats.monthAmount, "12.00", "refund net comes from ledger facts rather than recalculating progress rows");
});
