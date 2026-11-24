"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createService } = require("../lib/physicalCommerce.cjs");
const { createMemoryStore, createMysqlStore, TABLES } = require("../lib/physicalStore.cjs");

function seed() {
  const order = (id, owner, status, date) => ({ id, orderNo: `NO-${id}`, openid: owner, status, createdAt: date,
    items: [{ id: `${id}-item`, quantity: 2, refundedQuantity: 0, priceFen: 100, amountFen: 200 }],
    goodsAmountFen: 200, shippingFeeFen: 50, totalAmountFen: 250, refundedFen: 0, checkoutKey: "private-key", address: {} });
  return {
    config: [{ id: "settings", afterSaleDays: 9, returnDays: 3, wechatReceiptRequired: true, carrierOptions: [{ code: "ems", name: "EMS" }] }],
    addresses: [{ id: "a1", openid: "buyer", isDefault: false }, { id: "a2", openid: "buyer", isDefault: true }, { id: "a3", openid: "other", isDefault: true }],
    orders: [order("one", "buyer", "awaiting_receipt", "2026-11-01"), order("two", "buyer", "completed", "2026-11-02"), order("three", "buyer", "pending_payment", "2026-11-03"), order("foreign", "other", "completed", "2026-11-04")],
    payments: [{ id: "p1", orderId: "one", status: "confirmed", externalTransactionId: "wx-one" }, { id: "p2", orderId: "two", status: "pending" }, { id: "p3", orderId: "two", status: "confirmed", externalTransactionId: "wx-two" }],
    shipments: [{ id: "s1", orderId: "one", kind: "outbound", active: true, phone: "13800000000", subscriptionSalt: "private", events: [{ context: "联系电话13800000000" }] }, { id: "return", orderId: "one", kind: "return", active: true, events: [] }, { id: "foreign-shipment", orderId: "foreign", kind: "outbound", active: true }],
    afterSales: [{ id: "as1", orderId: "one", openid: "buyer", status: "completed", amountFen: 100, returnShipmentId: "return", secret: "hidden" }, { id: "as2", orderId: "two", openid: "buyer", status: "requested", amountFen: 100 }, { id: "as3", orderId: "foreign", openid: "other", status: "requested", amountFen: 200 }],
    audit: [{ id: "audit", orderId: "foreign", detail: { private: true } }],
  };
}
function service(store) { return createService({ store, now: () => new Date("2026-11-23T00:00:00Z"), catalogSource: async () => [{ id: "product", name: "相册", price: 10, stock: 3, shippingFee: 0, status: "已上", isShow: true }] }); }
function legacyStore(store) { return { transaction: callback => store.transaction(callback) }; }
function errorShape(error) { return { message: error.message, code: error.code, statusCode: error.statusCode }; }

test("public pure reads preserve legacy responses, ownership, pagination, filters and errors", async () => {
  const current = createMemoryStore(seed()), legacy = createMemoryStore(seed());
  const fast = service(current), before = service(legacyStore(legacy));
  const cases = [["getShippingAddresses", {}], ["getPhysicalOrders", {}], ["getPhysicalOrders", { page: 2, pageSize: 1 }],
    ["getPhysicalOrders", { status: "completed" }], ["getPhysicalOrders", { afterSale: true }], ["getPhysicalOrderCounts", {}],
    ["getPhysicalOrder", { orderId: "one" }], ["getPhysicalOrder", { orderNo: "NO-two" }], ["getPhysicalOrder", { id: "foreign" }],
    ["getPhysicalOrder", { orderId: "missing" }], ["getPhysicalAfterSales", {}], ["getPhysicalAfterSales", { orderId: "one" }],
    ["getPhysicalAfterSales", { orderId: "foreign" }], ["getPhysicalOrders", { page: -1 }], ["getPhysicalOrders", { pageSize: 101 }]];
  for (const [action, input] of cases) {
    const result = await Promise.allSettled([fast.executePublic(action, input, { openid: "buyer" }), before.executePublic(action, input, { openid: "buyer" })]);
    assert.equal(result[0].status, result[1].status, action);
    if (result[0].status === "fulfilled") assert.deepEqual(result[0].value, result[1].value, action + JSON.stringify(input));
    else assert.deepEqual(errorShape(result[0].reason), errorShape(result[1].reason), action);
  }
  assert.deepEqual(current.snapshot(), seedWithBlanks(seed()));
});
function seedWithBlanks(value) { return createMemoryStore(value).snapshot(); }

test("memory reads isolate callback mutations and await an already pending write", async () => {
  const store = createMemoryStore(seed());
  let release; const held = new Promise(resolve => { release = resolve; });
  const write = store.transaction(async state => { await held; state.addresses[0].isDefault = true; });
  const read = store.read(state => { const value = state.addresses[0].isDefault; state.addresses[0].isDefault = "not committed"; return value; }, { addresses: { owner: "buyer" } });
  release(); await write;
  assert.equal(await read, true);
  assert.equal(store.snapshot().addresses[0].isDefault, true);
});

test("address writes retain their legacy result and committed state after optimized reads", async () => {
  const fastStore = createMemoryStore(seed()), oldStore = createMemoryStore(seed());
  const fast = service(fastStore), old = service(legacyStore(oldStore)), identity = { openid: "buyer" };
  await fast.executePublic("getShippingAddresses", {}, identity);
  const input = { id: "a1", recipient: "更新收件人", phone: "13800000000", province: "湖南", city: "长沙", district: "岳麓", detail: "测试地址一号", isDefault: true };
  assert.deepEqual(await fast.executePublic("saveShippingAddress", input, identity), await old.executePublic("saveShippingAddress", input, identity));
  assert.deepEqual(fastStore.snapshot(), oldStore.snapshot());
  assert.deepEqual(await fast.executePublic("getShippingAddresses", {}, identity), await old.executePublic("getShippingAddresses", {}, identity));
});

test("catalog, cart, preview and writes retain their transaction path and inventory initialization", async () => {
  const base = createMemoryStore(); let reads = 0, writes = 0;
  const store = { read: (...args) => { reads++; return base.read(...args); }, transaction: (...args) => { writes++; return base.transaction(...args); } };
  const svc = service(store), identity = { openid: "buyer" };
  await svc.executePublic("getPhysicalCatalog", {}, identity);
  assert.equal(base.snapshot().inventory.length, 1, "catalog still initializes valid stock");
  await svc.executePublic("getPhysicalCart", {}, identity);
  await svc.executePublic("saveShippingAddress", { recipient: "测试", phone: "13800000000", province: "湖南", city: "长沙", district: "岳麓", detail: "测试地址一号" }, identity);
  assert.equal(reads, 0); assert.ok(writes >= 3);
  const snapshot = base.snapshot();
  await svc.executePublic("getShippingAddresses", {}, identity);
  assert.equal(reads, 1); assert.deepEqual(base.snapshot(), snapshot);
});

function sqlFixture(initial, { schemaRow = true, missingTable = "" } = {}) {
  const calls = [], data = seedWithBlanks(initial);
  const connection = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (/^SELECT version FROM lxm_physical_mutex/.test(sql)) {
      if (missingTable === "lxm_physical_mutex") throw Object.assign(new Error("Missing table lxm_physical_mutex"), { code: "ER_NO_SUCH_TABLE" });
      return [schemaRow ? [{ version: 0 }] : []];
    }
    const match = sql.match(/^SELECT body FROM `([^`]+)`/);
    if (!match) throw new Error("Unexpected SQL: " + sql);
    const name = Object.keys(TABLES).find(key => TABLES[key] === match[1]);
    if (missingTable === match[1]) throw Object.assign(new Error("Missing table " + missingTable), { code: "ER_NO_SUCH_TABLE" });
    // Deliberately include rows that SQL would exclude. The adapter must retain
    // JS's exact case/type/ownership semantics after the SQL coarse filter.
    return [data[name].map(body => ({ body: JSON.stringify(body), owner_id: "stale-index-owner", order_id: "stale-index-order" }))];
  } };
  return { store: createMysqlStore({ transaction: work => work(connection) }), calls, data };
}
test("MySQL pure reads select only required tables with parameterized authoritative body scopes", async () => {
  const f = sqlFixture(seed()), svc = service(f.store), baseline = service(legacyStore(createMemoryStore(seed())));
  const identity = { openid: "buyer" };
  assert.deepEqual(await svc.executePublic("getPhysicalOrders", {}, identity), await baseline.executePublic("getPhysicalOrders", {}, identity));
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls[0].sql, "SELECT version FROM lxm_physical_mutex WHERE id='commerce'");
  const bodies = f.calls.slice(1);
  assert.deepEqual(bodies.map(call => call.sql.match(/FROM `([^`]+)`/)[1]), ["lxm_physical_config", "lxm_physical_orders", "lxm_physical_after_sales", "lxm_physical_payments", "lxm_physical_shipments"]);
  assert.ok(bodies.every(call => /^SELECT body/.test(call.sql) && / WHERE /.test(call.sql)));
  assert.ok(f.calls.every(call => !/FOR UPDATE|INSERT|DELETE|UPDATE /.test(call.sql)));
  assert.match(bodies[1].sql, /JSON_EXTRACT\(body,'\$\.openid'\)/);
  assert.deepEqual(bodies[1].values, ["buyer"]);
  for (const call of bodies.slice(2)) { assert.match(call.sql, /JSON_EXTRACT\(body,'\$\.orderId'\)/); assert.deepEqual(call.values, ["one", "two", "three"]); }
  assert.ok(f.calls.every(call => !/owner_id|order_id|lookup_key/.test(call.sql)), "stale index projections cannot hide or leak rows");
});

test("MySQL address and detail reads preserve strict case/type and identity not-found behavior", async () => {
  const initial = seed(); initial.addresses.push({ id: "upper", openid: "BUYER" }, { id: "numeric", openid: 123 });
  const f = sqlFixture(initial), svc = service(f.store);
  assert.equal((await svc.executePublic("getShippingAddresses", {}, { openid: "buyer" })).items.length, 2);
  assert.equal((await svc.executePublic("getShippingAddresses", {}, { openid: "123" })).items.length, 0);
  const untrusted = "buyer' OR 1=1 --";
  assert.deepEqual((await svc.executePublic("getShippingAddresses", {}, { openid: untrusted })).items, []);
  assert.equal(f.calls.at(-1).values[0], untrusted); assert.ok(!f.calls.at(-1).sql.includes(untrusted));
  await assert.rejects(svc.executePublic("getPhysicalOrder", { orderId: "foreign" }, { openid: "buyer" }), { code: "PHYSICAL_NOT_FOUND", statusCode: 404 });
  await assert.rejects(svc.executePublic("getPhysicalOrder", { orderId: "ONE" }, { openid: "buyer" }), { code: "PHYSICAL_NOT_FOUND", statusCode: 404 });
  const own = await svc.executePublic("getPhysicalOrder", { orderNo: "NO-one" }, { openid: "buyer" });
  assert.equal(own.id, "one"); assert.equal(own.shipment.phone, undefined); assert.equal(own.shipment.subscriptionSalt, undefined);
  assert.equal(own.paymentTransactionId, "wx-one");
  assert.ok(f.calls.every(call => !/FOR UPDATE/.test(call.sql)));
});

test("MySQL empty user scope skips related table reads and legacy transactions keep their mutex", async () => {
  const f = sqlFixture(seed()), svc = service(f.store);
  assert.deepEqual(await svc.executePublic("getPhysicalOrderCounts", {}, { openid: "missing" }), { orderType: "physical", total: 0, pending_payment: 0, awaiting_shipment: 0, awaiting_receipt: 0, completed: 0, closed: 0, afterSale: 0 });
  assert.equal(f.calls.length, 2);
  f.calls.length = 0;
  assert.equal(await f.store.transaction(() => "same write path"), "same write path");
  assert.match(f.calls[0].sql, /lxm_physical_mutex.*FOR UPDATE/);
  assert.equal(f.calls.filter(call => /^SELECT body/.test(call.sql)).length, 11);
});

test("MySQL after-sale reads only load owned tickets and their referenced return shipments", async () => {
  const f = sqlFixture(seed()), svc = service(f.store);
  const actual = await svc.executePublic("getPhysicalAfterSales", { orderId: "one" }, { openid: "buyer" });
  const expected = await service(legacyStore(createMemoryStore(seed()))).executePublic("getPhysicalAfterSales", { orderId: "one" }, { openid: "buyer" });
  assert.deepEqual(actual, expected); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[2].values, ["buyer", "one"]);
  assert.match(f.calls[2].sql, /\$\.openid/); assert.match(f.calls[2].sql, /\$\.orderId/);
  assert.deepEqual(f.calls[3].values, ["return"]); assert.match(f.calls[3].sql, /\$\.id/);
});

test("MySQL more than 500 owned orders use one relation query per table with bounded IN groups", async () => {
  const initial = seed();
  for (let i = 0; i < 501; i++) initial.orders.push({ ...initial.orders[0], id: `many-${i}`, orderNo: `M-${i}` });
  const f = sqlFixture(initial), identity = { openid: "buyer" };
  const actual = await service(f.store).executePublic("getPhysicalOrders", { pageSize: 20, page: 2 }, identity);
  const expected = await service(legacyStore(createMemoryStore(initial))).executePublic("getPhysicalOrders", { pageSize: 20, page: 2 }, identity);
  assert.deepEqual(actual, expected);
  assert.equal(f.calls.length, 6);
  for (const call of f.calls.slice(3)) {
    assert.equal(call.values.length, 504);
    const groups = [...call.sql.matchAll(/ IN \((CAST\(\? AS BINARY\)(?:,CAST\(\? AS BINARY\))*)\)/g)];
    assert.equal(groups.length, 2);
    assert.ok(groups.every(group => (group[1].match(/\?/g) || []).length <= 500));
    assert.match(call.sql, / OR /);
  }
});

test("MySQL incomplete schema keeps the legacy error contract without a read lock", async () => {
  for (const options of [{ schemaRow: false }, { missingTable: "lxm_physical_mutex" }, { missingTable: "lxm_physical_addresses" }]) {
    const fast = sqlFixture(seed(), options), old = sqlFixture(seed(), options);
    const identity = { openid: "buyer" };
    const results = await Promise.allSettled([
      service(fast.store).executePublic("getShippingAddresses", {}, identity),
      service(legacyStore(old.store)).executePublic("getShippingAddresses", {}, identity),
    ]);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.deepEqual(errorShape(results[0].reason), errorShape(results[1].reason));
    assert.ok(fast.calls.every(call => !/FOR UPDATE|INSERT|DELETE|UPDATE /.test(call.sql)));
  }
});

test("MySQL oversized relation predicates fall back to one scan and retain strict scope filtering", async () => {
  const initial = seed();
  for (let i = 0; i < 5001; i++) initial.orders.push({ ...initial.orders[0], id: `large-${i}`, orderNo: `L-${i}` });
  const f = sqlFixture(initial), identity = { openid: "buyer" };
  const actual = await service(f.store).executePublic("getPhysicalOrders", { pageSize: 20 }, identity);
  const expected = await service(legacyStore(createMemoryStore(initial))).executePublic("getPhysicalOrders", { pageSize: 20 }, identity);
  assert.deepEqual(actual, expected);
  assert.equal(f.calls.length, 6);
  for (const call of f.calls.slice(3)) {
    assert.match(call.sql, /^SELECT body FROM `[^`]+`$/);
    assert.deepEqual(call.values, []);
  }
});

test("MySQL total SQL byte budget also bounds a moderate number of unusually long identities", async () => {
  const initial = seed();
  for (let i = 0; i < 1001; i++) initial.orders.push({ ...initial.orders[0], id: `wide-${i}-` + "x".repeat(400), orderNo: `W-${i}` });
  const f = sqlFixture(initial), identity = { openid: "buyer" };
  const actual = await service(f.store).executePublic("getPhysicalOrders", {}, identity);
  const expected = await service(legacyStore(createMemoryStore(initial))).executePublic("getPhysicalOrders", {}, identity);
  assert.deepEqual(actual, expected); assert.equal(f.calls.length, 6);
  assert.ok(f.calls.slice(3).every(call => !call.sql.includes(" WHERE ") && call.values.length === 0));
});
