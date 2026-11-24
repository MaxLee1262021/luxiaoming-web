"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const { createSvcMemoryStore, createSvcStore, TABLES } = require("../lib/svcStore.cjs");
const { planFor } = require("../lib/svcReadStore.cjs");
const PATH = "/api/kf/workbench/general";
const AT = "2026-11-20 10:00:00";
const service = { kind: "admin", role: "service", authzUserId: "account-mine", subjectId: "account-mine" };
const supervisor = { kind: "admin", role: "service_supervisor", authzUserId: "account-lead", subjectId: "account-lead" };
const admin = { kind: "admin", role: "super", authzUserId: "admin" };
function order(id, status = "claimed", staff = "mine", extra = {}) {
  return { id, order_no: id, service_status: status, assignee_id: staff, paid_at: "2026-11-19 10:00:00", svc_paid_processed: 1,
    service_managed: true, category: "photo", product_name: "测试商品", created_at: "2026-11-19 10:00:00", ...extra };
}
function initial() {
  return { staff: [{ id: "lead", account_id: "account-lead", staff_status: "active" }, { id: "mine", account_id: "account-mine", supervisor_id: "lead", staff_status: "active" }, { id: "other", account_id: "account-other", staff_status: "active" }],
    orders: [], afterSales: [], photographers: [{ id: "p1", name: "测试摄影师", status: "active" }, { id: "p-ended", status: "ended" }] };
}
function fixture(state = initial(), clock = AT) {
  const store = createSvcMemoryStore(state), app = createSvcWorkbench({ store, clock: () => clock });
  return { store, app, get: (input = {}, session = service) => app.execute("GET", PATH, input, session), queue: (queue, input = {}, session = service) => app.execute("GET", PATH + "/queues", { queue, ...input }, session) };
}

test("all four card counts equal the complete selected result beyond current pages and old six-item todo", async () => {
  const state = initial();
  for (let index = 0; index < 125; index++) state.orders.push(order("mine-" + index));
  for (let index = 0; index < 12; index++) state.orders.push(order("pool-" + index, "new", null));
  state.orders.push(order("unpaid", "new", null, { paid_at: null, depositPaid: 0 }), order("already-owned-new", "new", "other"),
    order("physical", "claimed", "mine", { orderType: "physical" }), order("legacy-service-peripheral", "claimed", "mine", { category: "peripheral" }),
    order("outside", "claimed", "other"), order("today-confirmed", "confirmed", "mine", { photo_id: "p1", schedule_time: "2026-11-20 14:00:00" }),
    order("today-shooting", "shooting", "mine", { photo_id: "p1", schedule_time: "2026-11-20 12:00:00" }),
    order("today-final", "final_pending", "mine", { photo_id: "p1", schedule_time: "2026-11-20 13:00:00" }),
    order("tomorrow", "confirmed", "mine", { schedule_time: "2026-11-21 14:00:00" }));
  const f = fixture(state), before = f.store.snapshot();
  for (const card of ["pool", "mine", "pending", "today"]) {
    const result = await f.get({ card, page: 2, size: 3, status: "canceled" });
    assert.equal(result.total, result.cards[card]);
    assert.ok(result.list.length <= 3);
    assert.ok(!result.list.some(row => row.order_no === "physical" || row.order_no === "outside"));
  }
  const result = await f.get();
  assert.equal(result.cards.pool, 12);
  assert.equal(result.cards.pending, 126);
  assert.equal(result.cards.mine, 130);
  assert.equal(result.cards.today, 2);
  const today = await f.get({ card: "today" });
  assert.deepEqual(today.list.map(row => row.order_no), ["today-shooting", "today-confirmed"]);
  assert.deepEqual(f.store.snapshot(), before, "new reads do not replay payments or mutate any business fact");
});

test("base filters share the four card predicates and mine remains self-only for a supervisor", async () => {
  const state = initial();
  state.orders = [order("lead-active", "claimed", "lead", { product_name: "视频主产品", category: "video", photo_id: "p1" }),
    order("child-active", "claimed", "mine", { product_name: "视频主产品", category: "video", photo_id: "p1" }),
    order("lead-done", "done", "lead", { product_name: "视频主产品", category: "video", photo_id: "p1" }),
    order("lead-other-filter", "claimed", "lead", { product_name: "照片", photo_id: "p1" }),
    order("outside", "claimed", "other", { product_name: "视频主产品", category: "video", photo_id: "p1" })];
  const f = fixture(state), filter = { keyword: "主产品", type: "video", photo: "p1" };
  const result = await f.get(filter, supervisor);
  assert.equal(result.cards.mine, 1);
  assert.equal(result.cards.pending, 2);
  assert.equal(result.cards.reschedule, null);
  assert.equal(result.cards.complaints, null, "existing supervisor role does not gain after-sales mutation authority");
  const mine = await f.get({ ...filter, card: "mine" }, supervisor);
  assert.deepEqual(mine.list.map(row => row.order_no), ["lead-active"]);
  assert.equal(mine.total, mine.cards.mine);
});

test("reschedule and real unfinished after-sale queues have matching full counts and original role limits", async () => {
  const state = initial();
  state.orders = [order("mine-request", "confirmed", "mine", { rescheduleRequest: { id: "r1", status: "pending", requestedAt: "2026-11-19T10:00:00Z" } }),
    order("unassigned-request", "new", null, { rescheduleRequest: { id: "r2", status: "pending", requestedAt: "2026-11-19T09:00:00Z" } }),
    order("other-request", "confirmed", "other", { rescheduleRequest: { id: "r3", status: "pending" } }),
    order("reviewed", "confirmed", "mine", { rescheduleRequest: { id: "r4", status: "approved" } })];
  for (let index = 0; index < 125; index++) state.afterSales.push({ id: "ticket-" + index, orderId: "mine-request", status: index % 2 ? "待财务审" : "处理中", reason: "真实售后" });
  state.afterSales.push({ id: "outside", orderId: "other-request", status: "处理中" }, { id: "closed", orderId: "mine-request", status: "已结案" },
    { id: "automatic", orderId: "mine-request", status: "处理中", submitSource: "customer_self_cancel" },
    { id: "automatic-lane", orderId: "mine-request", status: "处理中", reviewLane: "customer_self_cancel" },
    { id: "deleted", orderId: "mine-request", status: "处理中", deleted: 1 });
  for (const status of ["已关闭", "已完结", "完成", "已结束", "closed", "completed", "done"]) state.afterSales.push({ id: "terminal-" + status, orderId: "mine-request", status });
  state.complaints = [{ id: "unrelated-responsibility", order_no: "mine-request", resp: "unknown" }];
  const f = fixture(state), result = await f.get({ keyword: "does-not-match" });
  assert.equal(result.cards.reschedule, 2);
  assert.equal(result.cards.complaints, 125, "unknown responsibility records are not the after-sales total");
  const requests = await f.queue("reschedule", { page: 1, size: 1 });
  assert.equal(requests.total, result.cards.reschedule);
  assert.equal(requests.list[0].order_no, "unassigned-request");
  assert.equal(requests.list[0].canReviewReschedule, true);
  const tickets = await f.queue("complaints", { page: 2, size: 100 });
  assert.equal(tickets.total, result.cards.complaints);
  assert.equal(tickets.list.length, 25);
  assert.equal(tickets.list[0].order.order_no, "mine-request");
  await assert.rejects(f.queue("reschedule", {}, supervisor), { code: 403 });
  await assert.rejects(f.queue("complaints", {}, supervisor), { code: 403 });
  const administrator = await f.get({}, admin);
  assert.equal(administrator.cards.reschedule, 3);
  assert.equal(administrator.cards.complaints, 126);
});

test("a paused staff profile cannot grant pending reschedule authority through its business ID", async () => {
  const state = initial(); state.staff.find(row => row.id === "mine").staff_status = "paused";
  state.orders = [order("mine-request", "confirmed", "mine", { rescheduleRequest: { id: "r1", status: "pending" } }),
    order("unassigned", "new", null, { rescheduleRequest: { id: "r2", status: "pending" } })];
  const f = fixture(state), result = await f.get();
  assert.equal(result.cards.reschedule, 1);
  assert.deepEqual((await f.queue("reschedule")).list.map(row => row.order_no), ["unassigned"]);
});

test("reservations retain an independent full total and the main reserved view can paginate past 100", async () => {
  const state = initial();
  for (let i = 0; i < 125; i++) {
    const no = "reserved-" + String(i).padStart(3, "0");
    state.orders.push(order(no, "reserved", null, { reserve_staff_id: "mine" }));
    (state.reserves ||= []).push({ id: no, order_no: no, staff_id: "mine", status: "holding", reserve_start_at: "2026-11-21 09:00:00", reserve_expire_at: "2026-11-21 10:00:00" });
  }
  const f = fixture(state), result = await f.get({ keyword: "not-present" });
  assert.equal(result.reserved.total, 125);
  assert.equal(result.reserved.list.length, 20);
  assert.equal(result.reserved.list[0].left_seconds, null);
  const last = await f.get({ tab: "reserved", page: 2, size: 100 });
  assert.equal(last.total, 125);
  assert.equal(last.list.length, 25);
  assert.equal(last.cards.mine, 0);
});

test("photographer occupancy is a limited, China-time read snapshot with no customer data", async () => {
  const state = initial();
  const add = (no, status, time, owner = "mine", extra = {}) => state.orders.push(order(no, status, owner, { photo_id: "p1", schedule_time: time, phone: "13900001234", customer_name: "不要下发", ...extra }));
  add("confirmed", "confirmed", "2026-11-20 06:00:00");
  add("shooting", "shooting", "2026-11-21 12:00:00");
  add("final", "final_pending", "2026-12-03 23:59:59");
  add("end-exclusive", "confirmed", "2026-12-04 00:00:00");
  add("before", "confirmed", "2026-11-19 23:59:59");
  add("outside-owner", "confirmed", "2026-11-21 14:00:00", "other");
  add("not-confirmed", "claimed", "2026-11-20 14:00:00");
  add("done", "done", "2026-11-20 14:00:00");
  add("physical", "confirmed", "2026-11-20 14:00:00", "mine", { orderType: "physical" });
  const f = fixture(state), before = f.store.snapshot();
  const result = await f.app.execute("GET", "/api/kf/photographers/p1/occupancy", { from: "2026-11-20", days: 14 }, service);
  assert.equal(result.scope_limited, true);
  assert.deepEqual(result.items.map(row => row.order_no), ["confirmed", "shooting", "final"]);
  for (const row of result.items) assert.deepEqual(Object.keys(row), ["order_no", "appointment_at", "service_status", "duration_hours"]);
  assert.doesNotMatch(JSON.stringify(result), /13900001234|不要下发/);
  assert.deepEqual(f.store.snapshot(), before);
  await assert.rejects(f.app.execute("GET", "/api/kf/photographers/p-ended/occupancy", { from: "2026-11-20", days: 14 }, service), { code: 404 });
  await assert.rejects(f.app.execute("GET", "/api/kf/photographers/unknown/occupancy", { from: "2026-11-20", days: 14 }, service), { code: 404 });
  await assert.rejects(f.app.execute("GET", "/api/kf/photographers/p1/occupancy", { from: "2026-02-30", days: 14 }, service), { code: 4014 });
  await assert.rejects(f.app.execute("GET", "/api/kf/photographers/p1/occupancy", { from: "2026-11-20", days: 15 }, service), { code: 4014 });
});

test("today uses the server China date and invalid new filters do not alter old endpoint behavior", async () => {
  const state = initial(); state.orders = [order("china-today", "confirmed", "mine", { schedule_time: "2026-11-20 08:00:00" })];
  const f = fixture(state, "2026-11-19T18:00:00.000Z");
  const oldBefore = await f.app.execute("GET", "/api/kf/workbench/overview", {}, service);
  assert.equal((await f.get({ card: "today" })).cards.today, 1);
  assert.equal((await f.get()).server_time, "2026-11-20 02:00:00");
  await assert.rejects(f.get({ card: "not-a-card" }), { code: 4014 });
  await assert.rejects(f.queue("not-a-queue"), { code: 4014 });
  await assert.rejects(f.get({}, { ...service, role: "photo", subjectId: "p1" }), { code: 403 });
  assert.deepEqual(await f.app.execute("GET", "/api/kf/workbench/overview", {}, service), oldBefore);
});

test("production SQL new read plans hydrate pending requests and true after-sale facts without locks or writes", async () => {
  const db = Object.fromEntries(Object.values(TABLES).map(([table]) => [table, []]));
  Object.assign(db, { lxm_orders: [{ id: "sql-order", orderNo: "SQL-ORDER", service_status: "confirmed", assignee_id: "mine", svc_paid_processed: 1, depositPaidAt: "2026-11-19 10:00:00", depositPaid: 100, schedule_time: "2026-11-20 14:00:00", photo_id: "p1" }],
    lxm_order_products: [], photo_profile: [{ id: "p1", name: "测试摄影师", status: "active" }], lxm_staff: [],
    lxm_afterSales: [{ id: "ticket-open", orderId: "sql-order", status: "处理中" }, { id: "ticket-auto", orderId: "sql-order", status: "处理中" }],
    lxm_collection_values: [
      { collection_name: "orders", record_id: "sql-order", path: "rescheduleRequest.id", value_type: "string", value_text: "request-sql" },
      { collection_name: "orders", record_id: "sql-order", path: "rescheduleRequest.status", value_type: "string", value_text: "pending" },
      { collection_name: "afterSales", record_id: "ticket-auto", path: "reviewLane", value_type: "string", value_text: "customer_self_cancel" }
    ] });
  db.svc_staff = initial().staff;
  const calls = [];
  const source = { transaction: work => work({ query: async (sql, params = []) => {
    calls.push({ sql, params }); assert.match(sql, /^SELECT/); assert.doesNotMatch(sql, /FOR UPDATE/);
    const table = sql.includes("FROM `lxm_orders` o") ? "lxm_orders" : sql.match(/\bFROM\s+`?(\w+)`?/i)?.[1];
    let rows = structuredClone(db[table] || []);
    if (table === "lxm_collection_values") rows = rows.filter(row => row.collection_name === params[0] && params.includes(row.record_id) && params.includes(row.path));
    return [rows];
  } }) };
  const f = createSvcWorkbench({ store: createSvcStore(source), clock: () => AT });
  const result = await f.execute("GET", PATH, {}, service);
  assert.equal(result.cards.reschedule, 1);
  assert.equal(result.cards.complaints, 1);
  assert.ok(calls.some(row => row.params.includes("rescheduleRequest.status")));
  assert.ok(calls.some(row => row.sql.includes("`lxm_afterSales`")));
  assert.ok(!planFor("/api/kf/workbench/overview").general);
  const occupancy = await f.execute("GET", "/api/kf/photographers/p1/occupancy", { from: "2026-11-20", days: 14 }, service);
  assert.equal(occupancy.items.length, 1);
});
