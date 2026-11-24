"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const { createSvcMemoryStore, createSvcStore, TABLES } = require("../lib/svcStore.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const session = { kind: "admin", role: "service", authzUserId: "service-account" };
const manager = { ...session, role: "super" };
const at = "2026-11-13 12:00:00";
function initial(finalDue = 70) {
  return { staff: [{ id: "service", account_id: "service-account", staff_status: "active" }],
    orders: [{ id: "order", orderNo: "FINAL-1", order_no: "FINAL-1", openid: "customer", customer_openid: "customer",
      category: "photo", service_status: "shooting", status: "shooting", workflowStage: "shooting", assignee_id: "service",
      photo_id: "photo", photographerId: "photo", svc_paid_processed: 1, paid_at: "2026-11-12 12:00:00", depositPaidAt: "2026-11-12 12:00:00",
      totalAmount: 30 + finalDue, depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue,
      shootingStartedAt: "2026-11-13 11:00:00" }] };
}
function fixture(finalDue) {
  const store = createSvcMemoryStore(initial(finalDue)), ledgerCalls = [];
  const app = createSvcWorkbench({ store, clock: () => at, benefit: { ensureLedger(state, order, time, type = "service") {
    ledgerCalls.push({ no: order.order_no, time, type });
  } } });
  return { store, app, ledgerCalls,
    finish: () => app.execute("POST", "/api/kf/orders/FINAL-1/shoot/finish", { expected_status: "shooting" }, manager) };
}
function sqlFixture(orderInput = initial().orders[0]) {
  const split = schema.splitDocument("orders", orderInput);
  const columns = new Set(schema.definition("orders").columns.map(column => column.name));
  const order = { id: orderInput.id, ...split.columns }, writes = [];
  const tables = Object.fromEntries(Object.values(TABLES).map(([table]) => [table, []]));
  tables.svc_staff = initial().staff;
  tables.lxm_orders = [order];
  tables.lxm_collection_values = split.attributes.map(row => ({ collection_name: "orders", record_id: order.id, ...row }));
  tables.lxm_order_payment_records = split.relations.order_payment_records || [];
  const source = { transaction: async work => work({ query: async (sql, params = []) => {
    const table = /FROM `lxm_orders`/.test(sql) ? "lxm_orders" : /(?:FROM|INTO|UPDATE)\s+`?([a-z_]+)`?/i.exec(sql)?.[1];
    if (/^UPDATE lxm_orders/.test(sql)) {
      writes.push({ sql, params });
      const fields = [...sql.matchAll(/`([^`]+)`=\?/g)].map(match => match[1]);
      for (const [index, field] of fields.entries()) {
        assert.ok(columns.has(field), "unknown lxm_orders column: " + field);
        if (field === "service_status") assert.ok(params[index].length <= 16);
        order[field] = params[index];
      }
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO/.test(sql)) {
      const fields = sql.match(/\(([^)]+)\)\s+VALUES/)[1].split(",").map(field => field.replace(/`/g, "").trim());
      const row = Object.fromEntries(fields.map((field, index) => [field, params[index]]));
      if (table === "lxm_collection_values") {
        writes.push({ sql, params });
        const index = tables[table].findIndex(old => ["collection_name", "record_id", "path", "ordinal"].every(key => old[key] === row[key]));
        if (index >= 0) tables[table][index] = row; else tables[table].push(row);
      } else tables[table].push(row);
      return [{ affectedRows: 1 }];
    }
    const rows = table === "lxm_collection_values" ? tables[table].filter(row => params.includes(row.record_id) && params.includes(row.path)) : tables[table] || [];
    return [structuredClone(rows)];
  } }) };
  return { store: createSvcStore(source), order, tables, writes };
}

test("shooting completion waits for final receipt without binding or starting commission observation", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, f.finish));
  assert.equal(results[0].service_status, "final_pending");
  assert.equal(results[1].idempotent, true);
  let state = f.store.snapshot(), row = state.orders[0];
  assert.equal(row.shootingCompletedAt, at);
  assert.equal(row.workflowStage, "awaiting_final_payment");
  assert.equal(row.status, "final_pending");
  assert.equal(row.done_at, undefined);
  assert.equal(row.completedAt, undefined);
  assert.equal(state.operationLogs.filter(log => log.action === "shoot_finish").length, 1);
  assert.deepEqual(state.bindings, []);
  assert.deepEqual(f.ledgerCalls, []);
  assert.equal(workflow.publicOrderProjection(row).canPayFinal, true);
  await assert.rejects(f.app.onCompleted({ orderNo: "FINAL-1", finalPaid: 70, finalFinanceStatus: "confirmed" }), { code: 4003 });
  assert.deepEqual(f.store.snapshot(), state, "caller-provided payment fields cannot complete an unpaid order");
  await f.store.transaction(state => Object.assign(state.orders[0], { finalPaid: 70, finalFinanceStatus: "confirmed",
    status: "completed", workflowStage: "completed", completedAt: at, service_status: "done", done_at: at }));
  const complete = await f.app.onCompleted({ orderNo: "FINAL-1" });
  assert.equal(complete.service_status, "done");
  assert.equal(complete.bound, true);
  assert.equal(f.ledgerCalls.length, 1);
  state = f.store.snapshot();
  assert.equal(state.bindings.length, 1);
  assert.equal(state.operationLogs.filter(log => log.action === "order_complete").length, 1);
  assert.equal((await f.app.onCompleted({ id: "order" })).duplicate, true);
  assert.equal((await f.finish()).idempotent, true);
  assert.deepEqual(f.store.snapshot(), state);
  assert.equal(f.ledgerCalls.length, 1);
  await assert.rejects(f.app.execute("POST", "/api/kf/orders/FINAL-1/shoot/start", { expected_status: "done" }, manager), { code: 4003 });
});

test("a zero balance still waits for the customer's explicit zero-balance acknowledgement", async () => {
  const f = fixture(0);
  await f.finish();
  assert.equal(f.store.snapshot().orders[0].service_status, "final_pending");
  assert.deepEqual(f.ledgerCalls, []);
  await assert.rejects(f.app.onCompleted({ orderNo: "FINAL-1", confirmCompletion: true }), { code: 4003 });
  await f.store.transaction(state => Object.assign(state.orders[0], { completedAt: "2026-11-13T04:00:00.000Z", completionSource: "manual" }));
  await assert.rejects(f.app.onCompleted({ orderNo: "FINAL-1" }), { code: 4003 });
  // The SQL workbench reads typed order columns rather than the payment-record
  // relation, so the exact persisted zero-balance source is also an acknowledgement.
  await f.store.transaction(state => Object.assign(state.orders[0], { status: "completed", workflowStage: "completed",
    completedAt: "2026-11-13T04:00:00.000Z", completionSource: "zero_balance" }));
  assert.equal((await f.app.onCompleted({ orderNo: "FINAL-1" })).service_status, "done");
  assert.equal(f.store.snapshot().orders[0].done_at, at, "the SQL DATETIME uses Beijing wall time");
  assert.equal(f.store.snapshot().orders[0].completedAt, "2026-11-13T04:00:00.000Z");
  assert.equal(f.store.snapshot().orders[0].finalPaid, undefined);
  assert.equal(f.store.snapshot().orders[0].finalFinanceStatus, undefined);
});

test("cancellation and review guards prevent completion side effects even with a confirmed final receipt", async () => {
  for (const patch of [{ service_status: "refunded" }, { service_status: "canceled" }, { paymentReviewRequired: true }]) {
    const f = fixture(); await f.finish();
    await f.store.transaction(state => Object.assign(state.orders[0], { finalPaid: 70, finalFinanceStatus: "confirmed", ...patch }));
    const before = f.store.snapshot();
    await assert.rejects(f.app.onCompleted({ orderNo: "FINAL-1" }), { code: 4003 });
    assert.deepEqual(f.store.snapshot(), before);
    assert.deepEqual(f.ledgerCalls, []);
  }
});

test("workbench SQL persistence saves shooting completion and customer workflow together without changing receipt fields", async () => {
  const f = sqlFixture({ ...initial().orders[0], deleted: 0, isDeleted: 0, unrelatedInternalFact: "keep" });
  const app = createSvcWorkbench({ store: f.store, benefit: {}, clock: () => at });
  await app.execute("POST", "/api/kf/orders/FINAL-1/shoot/finish", { expected_status: "shooting" }, manager);
  assert.equal(f.order.service_status, "final_pending");
  assert.equal(f.order.status, "final_pending");
  assert.equal(f.order.workflowStage, "awaiting_final_payment");
  assert.equal(Object.hasOwn(f.order, "shootingCompletedAt"), false, "sparse timestamps are not physical order columns");
  const reloaded = await f.store.transaction(state => structuredClone(state.orders[0]));
  assert.equal(reloaded.shootingCompletedAt, at);
  assert.equal(reloaded.shootingStartedAt, "2026-11-13 11:00:00");
  assert.equal(reloaded.deleted, 0, "workflow hydration must preserve physical flag types");
  for (const field of ["_id", "items", "addons", "paymentRecords"]) assert.equal(Object.hasOwn(reloaded, field), false, "workflow guards must not add response defaults: " + field);
  assert.equal(f.tables.lxm_collection_values.find(row => row.path === "unrelatedInternalFact").value_text, "keep");
  const columnWrite = f.writes.find(write => /^UPDATE/.test(write.sql));
  assert.doesNotMatch(columnWrite.sql, /Paid|Finance|payment|done_at|completedAt|shootingCompletedAt/);
  assert.ok(f.writes.some(write => /^INSERT INTO lxm_collection_values/.test(write.sql) && write.params.includes("shootingCompletedAt")));
  Object.assign(f.order, { finalPaid: 70, finalFinanceStatus: "confirmed", status: "completed", workflowStage: "completed", completedAt: "2026-11-13T04:00:00.000Z", service_status: "done", done_at: at });
  assert.equal((await app.onCompleted({ orderNo: "FINAL-1" })).bound, true);
  assert.equal((await app.onCompleted({ orderNo: "FINAL-1" })).duplicate, true);
  assert.equal(f.tables.svc_operation_log.filter(row => row.action === "order_complete").length, 1);
});

test("SQL completion hydrates review holds, zero-balance acknowledgement and payment records", async () => {
  const input = { ...initial(0).orders[0], service_status: "done", status: "completed", workflowStage: "completed",
    completedAt: "2026-11-13T04:00:00.000Z", shootingCompletedAt: at, completionSource: "zero_balance", paymentReviewRequired: true,
    paymentRecords: [{ phase: "final", amount: 0, status: "confirmed", provider: "zero_balance" }] };
  const f = sqlFixture(input), app = createSvcWorkbench({ store: f.store, benefit: {}, clock: () => at });
  const reloaded = await f.store.transaction(state => structuredClone(state.orders[0]));
  assert.equal(reloaded.completionSource, "zero_balance");
  assert.equal(reloaded.paymentReviewRequired, true);
  assert.equal(reloaded.paymentRecords[0].provider, "zero_balance");
  await assert.rejects(app.onCompleted({ orderNo: "FINAL-1" }), { code: 4003 });
  assert.equal(f.tables.svc_binding.length, 0);
  f.tables.lxm_collection_values.find(row => row.path === "paymentReviewRequired").value_bool = 0;
  assert.equal((await app.onCompleted({ orderNo: "FINAL-1" })).service_status, "done");
  assert.equal(f.order.finalPaid, undefined);
  assert.equal(f.order.done_at, at);
});

test("scoped SQL order details read visitor arrival separately and allow recording the later actual start", async () => {
  const arrivedAt = "2026-11-13T03:30:00.000Z";
  const f = sqlFixture({ ...initial().orders[0], schedule_time: "2026-11-13 11:00:00", shootingStartedAt: undefined, customerArrivedAt: arrivedAt, customerArrivedBy: "visitor" });
  const app = createSvcWorkbench({ store: f.store, benefit: {}, clock: () => at });
  const before = await app.execute("GET", "/api/kf/orders/FINAL-1", {}, session);
  assert.equal(before.customerArrivedAt, arrivedAt);
  assert.equal(before.shootingStartedAt, undefined);
  assert.equal(before.timeline.find(row => row.action === "customer_arrival").created_at, arrivedAt);
  assert.equal(before.timeline.find(row => row.action === "customer_arrival").operator, "visitor");
  await app.execute("POST", "/api/kf/orders/FINAL-1/shoot/start", { expected_status: "confirmed" }, manager);
  const after = await app.execute("GET", "/api/kf/orders/FINAL-1", {}, session);
  assert.equal(after.customerArrivedAt, arrivedAt);
  assert.equal(after.shootingStartedAt, at);
  assert.equal(after.timeline.filter(row => row.action === "customer_arrival").length, 1);
  assert.equal(after.timeline.filter(row => row.action === "shoot_start").length, 1);
});

test("SQL lists, details and confirmation hydrate original customer intent and preserve it after manual adjustment", async () => {
  const requested = "2026-12-20 15:30:00", adjusted = "2026-12-21 16:00:00";
  const f = sqlFixture({ ...initial().orders[0], service_status: "claimed", status: "deposit_paid", workflowStage: "awaiting_dispatch",
    photo_id: null, photographerId: null, intentDate: "2026-12-20", intentTimePeriod: "15:30", unrelatedInternalFact: "keep" });
  const app = createSvcWorkbench({ store: f.store, benefit: {}, clock: () => at });
  for (const endpoint of ["/api/kf/orders/all", "/api/kf/workbench/overview", "/api/kf/workbench/general"]) {
    const row = (await app.execute("GET", endpoint, {}, session)).list.find(row => row.order_no === "FINAL-1");
    assert.equal(row.requested_time, requested, endpoint);
    assert.equal(row.schedule_time, null, endpoint);
  }
  const before = await app.execute("GET", "/api/kf/orders/FINAL-1", {}, session);
  assert.equal(before.requested_time, requested);
  assert.equal(before.intentDate, "2026-12-20");
  assert.equal(before.intentTimePeriod, "15:30");
  await assert.rejects(app.execute("POST", "/api/kf/orders/FINAL-1/slot/confirm",
    { expected_status: "claimed", new_time: adjusted, channel: "phone" }, session), { code: 4014 });
  assert.equal(f.order.service_status, "claimed");
  assert.equal(f.writes.length, 0);
  await app.execute("POST", "/api/kf/orders/FINAL-1/slot/confirm",
    { expected_status: "claimed", new_time: adjusted, reason: "客人行程调整", channel: "phone" }, session);
  const after = await app.execute("GET", "/api/kf/orders/FINAL-1", {}, session);
  assert.equal(after.service_status, "confirmed");
  assert.equal(after.requested_time, requested);
  assert.equal(after.schedule_time, adjusted);
  assert.equal(after.intentDate, before.intentDate);
  assert.equal(after.intentTimePeriod, before.intentTimePeriod);
  assert.equal(f.tables.svc_slot_log.length, 1);
  assert.equal(f.tables.svc_slot_log[0].from_time, requested);
  assert.equal(f.tables.svc_slot_log[0].to_time, adjusted);
  assert.equal(f.tables.svc_slot_log[0].reason, "客人行程调整");
  assert.equal(f.tables.lxm_collection_values.find(row => row.path === "unrelatedInternalFact").value_text, "keep");
});

test("confirming the submitted customer intent requires no adjustment reason or reschedule log", async () => {
  const requested = "2026-12-20 15:30:00";
  const f = sqlFixture({ ...initial().orders[0], service_status: "claimed", status: "deposit_paid", workflowStage: "awaiting_dispatch",
    photo_id: null, photographerId: null, intentDate: "2026-12-20", intentTimePeriod: "15:30" });
  const app = createSvcWorkbench({ store: f.store, benefit: {}, clock: () => at });
  await app.execute("POST", "/api/kf/orders/FINAL-1/slot/confirm", { expected_status: "claimed", new_time: requested, channel: "wechat" }, session);
  const after = await app.execute("GET", "/api/kf/orders/FINAL-1", {}, session);
  assert.equal(after.requested_time, requested);
  assert.equal(after.schedule_time, requested);
  assert.equal(f.tables.svc_slot_log.length, 0);
});
