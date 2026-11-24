"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("../lib/packageFulfillment.cjs");
const { createMemoryStore, serviceFor } = require("../lib/physicalCommerce.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const at = "2026-11-17T02:00:00.000Z";

function fixture() {
  const products = [
    { id: "album", name: "相册精装本", status: "已上", isShow: true, price: 129.50, stock: 30, specs: ["8寸"], isCustom: true },
    { id: "frame", name: "相框", status: "已上", isShow: true, specMode: "multiple", skus: [{ id: "small", spec: "6寸", price: 89, stock: 10 }, { id: "large", spec: "8寸", price: 119, stock: 10 }] },
  ];
  const rows = {
    packages: [{ id: "package", includedItems: [{ type: "album", albumId: "photo" }, { type: "peripheral", productId: "album", quantity: 2 }] }],
    orders: [], bookingRequests: [],
  };
  const source = {
    async list(key) { return clone(rows[key] || []); },
    async get(key, id) { return clone((rows[key] || []).find(row => row.id === id) || null); },
    async compareAndUpdate(key, id, expected, patch) {
      const row = (rows[key] || []).find(item => item.id === id);
      if (!row || Object.entries(expected).some(([field, value]) => JSON.stringify(row[field]) !== JSON.stringify(value))) return null;
      Object.assign(row, clone(patch)); return clone(row);
    },
  };
  const store = createMemoryStore();
  const physical = serviceFor(source, { store, catalogSource: async () => products, now: () => new Date(at) });
  async function ready() {
    const address = await physical.executePublic("saveShippingAddress", { recipient: "客户", phone: "13800000000", province: "湖南省", city: "长沙市", district: "岳麓区", detail: "测试街道12号房" }, { openid: "buyer" });
    const snapshot = await bridge.prepare(source, [{ packageId: "package", quantity: 3, includedItems: [{ type: "peripheral", productId: "frame", quantity: 99 }] }], address.id, "buyer");
    const draft = { id: "booking-one", orderNo: "LSBOOKING", bookingStatus: "pending_payment", status: "new", workflowStage: "awaiting_deposit", openid: "buyer", totalAmount: 100, depositDue: 30, finalDue: 70, depositPaid: 0, finalPaid: 0, paymentRecords: [], physicalFulfillmentSnapshot: snapshot, createdAt: at };
    return { address, snapshot, draft };
  }
  function paid(draft, override = {}) {
    return { ...draft, id: "formal-one", bookingId: draft.id, bookingStatus: "confirmed", status: "completed", workflowStage: "completed", depositPaid: 30, finalPaid: 70, depositFinanceStatus: "已审", finalFinanceStatus: "已审", completedAt: at, ...override };
  }
  return { source, products, rows, store, physical, ready, paid };
}

test("canonical package expansion merges aliases once and multiplies each included quantity", () => {
  const pkgs = [{ _id: "pkg", items: [
    { type: "peripheral", peripheralId: "album", qty: 2, target: { skuId: "old" } },
    { type: "accessory", target: { id: "frame", skuId: "small" }, quantity: 3 },
    { type: "album", albumId: "photo" },
  ], includedItems: [ { quantity: 4, target: { skuId: "new" } } ] }];
  const lines = bridge.collectLines([{ packageId: "pkg", quantity: 2, includedItems: [{ type: "peripheral", productId: "forged" }] }], pkgs);
  assert.deepEqual(lines, [{ productId: "album", quantity: 8, skuId: "new" }, { productId: "frame", quantity: 6, skuId: "small" }]);
  assert.deepEqual(bridge.collectLines([{ productType: "peripheral", productId: "legacy-addon", quantity: 1 }], []), [], "legacy add-on policy is owned by the existing booking flow");
});

test("invalid package quantities and missing product relationships cannot silently become one item", () => {
  for (const quantity of [0, -1, 0.5, "bad", 10000]) {
    assert.throws(() => bridge.collectLines([{ packageId: "pkg", quantity: 1 }], [{ id: "pkg", includedItems: [{ type: "peripheral", productId: "album", quantity }] }]), { code: "PACKAGE_FULFILLMENT_INVALID" });
    assert.throws(() => bridge.collectLines([{ packageId: "pkg", quantity }], [{ id: "pkg", includedItems: [] }]), { code: "PACKAGE_FULFILLMENT_INVALID" });
  }
  assert.throws(() => bridge.collectLines([{ packageId: "missing" }], []), { code: "PACKAGE_FULFILLMENT_INVALID" });
  assert.throws(() => bridge.collectLines([{ packageId: "pkg" }], [{ id: "pkg", includedItems: [{ type: "peripheral", name: "unlinked" }] }]), { code: "PACKAGE_FULFILLMENT_INVALID" });
});

test("orders without included physical goods keep the existing flow and need no physical store", async () => {
  const source = { async list(key) { assert.equal(key, "packages"); return [{ id: "photo", includedItems: [{ type: "album", albumId: "photos" }] }]; } };
  assert.equal(await bridge.prepare(source, [{ packageId: "photo" }], "", "buyer"), null);
  assert.equal(await bridge.prepare({}, [{ custom: true }], "", "buyer"), null);
  assert.equal(await bridge.reserve({}, { id: "legacy" }), null);
  assert.equal(await bridge.sync({}, { id: "legacy" }), null);
  assert.deepEqual(await bridge.orders({}, { id: "legacy" }, "buyer"), []);
});

test("prepare freezes authoritative goods, quantity, address and price with standalone shop disabled", async () => {
  const f = fixture(), { address, snapshot } = await f.ready();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].productId, "album");
  assert.equal(snapshot.items[0].quantity, 6);
  assert.equal(snapshot.items[0].priceFen, 12950);
  assert.equal(snapshot.items[0].amountFen, 77700);
  assert.equal(snapshot.address.id, address.id);
  assert.equal(f.store.snapshot().orders.length, 0, "validating checkout does not yet reserve inventory");
  assert.equal(f.store.snapshot().inventory[0].reserved, 0);
  await assert.rejects(bridge.prepare(f.source, [{ packageId: "package" }], address.id, "other-buyer"), { code: "PHYSICAL_PACKAGE_ADDRESS_REQUIRED" });
  f.rows.packages[0].includedItems = [{ type: "peripheral", productId: "frame" }];
  await assert.rejects(bridge.prepare(f.source, [{ packageId: "package" }], address.id, "buyer"), { code: "PHYSICAL_PACKAGE_SKU_REQUIRED" });
  f.rows.packages[0].includedItems[0].target = { skuId: "small" };
  const specified = await bridge.prepare(f.source, [{ packageId: "package", quantity: 2 }], address.id, "buyer");
  assert.equal(specified.items[0].spec, "6寸");
  assert.equal(specified.items[0].quantity, 2);
});

test("package expansion preserves same-size SKU styles and codes through inventory reservation", async () => {
  const f = fixture(), { address } = await f.ready();
  f.products[1].skus = [
    { spec: "8寸", style: "横版", skuCode: "FRAME-H", price: 89, stock: 10 },
    { spec: "8寸", style: "竖版", skuCode: "FRAME-V", price: 119, stock: 10 }
  ];
  f.rows.packages[0].includedItems = [
    { type: "peripheral", productId: "frame", spec: "8寸", style: "横版", quantity: 2 },
    { type: "peripheral", productId: "frame", target: { skuCode: "FRAME-V", spec: "8寸", style: "竖版" }, quantity: 1 }
  ];
  const snapshot = await bridge.prepare(f.source, [{ packageId: "package", quantity: 2 }], address.id, "buyer");
  assert.equal(snapshot.items.length, 2);
  assert.deepEqual(snapshot.items.map((item) => [item.style, item.quantity, item.priceFen]), [["横版", 4, 8900], ["竖版", 2, 11900]]);
  assert.notEqual(snapshot.items[0].skuId, snapshot.items[1].skuId);
  const child = await bridge.reserve(f.source, { id: "multi-style", openid: "buyer", physicalFulfillmentSnapshot: snapshot });
  assert.deepEqual(child.items.map((item) => [item.specLabel, item.quantity]), [["8寸【横版】", 4], ["8寸【竖版】", 2]]);
  for (const item of snapshot.items) assert.equal(f.store.snapshot().inventory.find((row) => row.skuId === item.skuId).reserved, item.quantity);
});

test("verified full payment uses the frozen package snapshot across catalog edits and promotion retries", async () => {
  const f = fixture(), { draft } = await f.ready();
  const proxy = Object.create(f.source); proxy.bookingRequestSource = f.source;
  const reserved = await bridge.reserve(proxy, draft);
  assert.equal(reserved.status, "pending_payment");
  assert.equal(f.store.snapshot().inventory[0].reserved, 6);
  const deposited = f.paid(draft, { status: "deposit_paid", workflowStage: "awaiting_dispatch", finalPaid: 0, finalFinanceStatus: "" });
  await bridge.sync(f.source, deposited);
  assert.equal(f.store.snapshot().inventory[0].onHand, 30, "deposit alone holds stock without treating goods as sold");
  f.rows.packages[0].includedItems = [{ type: "peripheral", productId: "frame", quantity: 99 }];
  f.products[0].name = "改名后的商品"; f.products[0].price = 999;
  f.source.list = async () => { throw new Error("payment fulfillment must not reload a mutable catalog"); };
  const parent = f.paid(draft);
  const children = await Promise.all([bridge.sync(f.source, parent), bridge.sync(proxy, parent)]);
  assert.equal(children[0].id, reserved.id);
  assert.equal(children[1].status, "awaiting_shipment");
  const state = f.store.snapshot();
  assert.equal(state.orders.length, 1);
  assert.equal(state.inventory[0].onHand, 24);
  assert.equal(state.inventory[0].reserved, 0);
  assert.equal(state.inventory[0].sold, 6);
  assert.equal(state.orders[0].items[0].name, "相册精装本");
  assert.equal(state.orders[0].items[0].referencePriceFen, 12950);
  assert.equal(state.orders[0].items[0].quantity, 6);
  assert.equal(state.orders[0].totalAmountFen, 0, "included goods create no duplicate charge");
  assert.equal((await bridge.orders(proxy, parent, "buyer"))[0].parentOrderId, "formal-one");
  await assert.rejects(bridge.orders(f.source, parent, "other-buyer"), { code: "PHYSICAL_FORBIDDEN" });
});

test("reconciliation favors the formal order over its stale draft and never reserves every abandoned checkout", async () => {
  const f = fixture(), { draft } = await f.ready();
  await bridge.reserve(f.source, draft);
  const full = f.paid(draft);
  f.rows.orders.push(full);
  f.rows.bookingRequests.push({ ...draft, bookingStatus: "cancelled", status: "cancelled" });
  f.rows.bookingRequests.push({ ...draft, id: "never-paid", createdAt: at, paymentRecords: [{ phase: "deposit", status: "pending", provider: "wechat_pay", outTradeNo: "UNCERTAIN" }] });
  const result = await bridge.reconcile(f.source, { now: "2026-11-18T02:00:00Z" });
  assert.equal(result.synced, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(f.store.snapshot().orders.length, 1);
  assert.equal(f.store.snapshot().orders[0].status, "awaiting_shipment");
  assert.equal(f.store.snapshot().inventory[0].sold, 6);
  f.rows.orders[0] = { ...full, status: "cancelled", workflowStage: "cancelled" };
  await bridge.reconcile(f.source);
  await bridge.reconcile(f.source);
  assert.equal(f.store.snapshot().orders[0].status, "closed");
  assert.equal(f.store.snapshot().inventory[0].onHand, 30);
  assert.equal(f.store.snapshot().inventory[0].sold, 0);
});

test("one corrupt package snapshot cannot block recovery of other paid packages", async () => {
  const f = fixture(), { draft } = await f.ready();
  f.rows.orders.push(f.paid(draft));
  f.rows.orders.push(f.paid({ ...draft, id: "bad-booking", physicalFulfillmentSnapshot: { ...draft.physicalFulfillmentSnapshot, items: [{ ...draft.physicalFulfillmentSnapshot.items[0], skuId: "missing" }] } }, { id: "bad-order", bookingId: "bad-booking" }));
  const result = await bridge.reconcile(f.source);
  assert.equal(result.synced, 1);
  assert.deepEqual(result.failures, [{ parentId: "bad-order", code: "PHYSICAL_STOCK" }]);
  assert.equal(f.store.snapshot().inventory[0].onHand, 24);
});

test("unpaid expiry claims cancellation before releasing stock and refuses an uncertain provider trade", async () => {
  const f = fixture(), { draft } = await f.ready();
  f.rows.bookingRequests.push(draft);
  await bridge.reserve(f.source, draft);
  const result = await bridge.reconcile(f.source, { now: "2026-11-18T02:00:00Z" });
  assert.equal(result.released, 1);
  assert.equal(f.rows.bookingRequests[0].bookingStatus, "cancelled");
  assert.equal(f.rows.bookingRequests[0].cancellationSource, "unpaid_expired");
  assert.equal(f.store.snapshot().inventory[0].reserved, 0);
  await bridge.reserve(f.source, f.rows.bookingRequests[0]);
  assert.equal(f.store.snapshot().inventory[0].reserved, 0, "the cancelled draft cannot reopen its stock hold");
  const uncertain = { ...draft, id: "uncertain", bookingStatus: "pending_payment", paymentRecords: [{ id: "pay", provider: "wechat_pay", outTradeNo: "UNCERTAIN", status: "failed" }] };
  f.rows.bookingRequests = [uncertain];
  await bridge.reserve(f.source, uncertain);
  const uncertainResult = await bridge.reconcile(f.source, { now: "2026-11-18T02:00:00Z" });
  assert.equal(uncertainResult.skipped, 1);
  assert.equal(f.store.snapshot().inventory[0].reserved, 6, "local failure cannot prove the provider did not accept payment");
});

test("concurrent payment issuance defeats an expiry claim and keeps its stock reserved", async () => {
  const f = fixture(), { draft } = await f.ready();
  f.rows.bookingRequests.push(draft);
  await bridge.reserve(f.source, draft);
  const cas = f.source.compareAndUpdate;
  f.source.compareAndUpdate = async (...args) => {
    f.rows.bookingRequests[0].paymentRecords = [{ phase: "deposit", status: "pending", provider: "wechat_pay", outTradeNo: "RACING" }];
    return cas(...args);
  };
  const result = await bridge.reconcile(f.source, { now: "2026-11-18T02:00:00Z" });
  assert.equal(result.skipped, 1);
  assert.equal(result.released, 0);
  assert.equal(f.rows.bookingRequests[0].bookingStatus, "pending_payment");
  assert.equal(f.store.snapshot().inventory[0].reserved, 6);
  assert.deepEqual(await bridge.reconcile({}), { synced: 0, released: 0, skipped: 0, failures: [] });
});
