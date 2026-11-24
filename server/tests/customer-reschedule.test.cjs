"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const createSource = require("./fixtures/jsonSource.cjs");
const rpc = require("../lib/rpc.cjs"), createApi = require("../lib/api.cjs");
const { reviewCustomerReschedule } = require("../lib/customerReschedule.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const owner = { identity: { kind: "public", openid: "reschedule-owner" } };
const manager = { kind: "admin", role: "super", subjectId: "manager", account: "manager" };
async function fixture(t, patch = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-customer-reschedule-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = createSource({ backend: "json", jsonFile: path.join(directory, "db.json") });
  await source.create("orders", { id: "reschedule", orderNo: "RES-1", openid: owner.identity.openid, status: "deposit_paid",
    totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70,
    appointmentAt: "2099-01-01 10:00:00", timePeriod: "10:00", ...patch });
  return source;
}
const application = patch => ({ orderId: "reschedule", appointmentAt: "2099-02-20", timePeriod: "14:30", reason: "行程调整申请改期", idempotencyKey: "reschedule-request-1", ...patch });
const request = (source, patch = {}, context = owner) => rpc(source, "requestOrderReschedule", { data: application(patch) }, context);
const review = async (source, approved = true, extra = {}, session = manager) => {
  const order = await source.get("orders", "reschedule");
  return reviewCustomerReschedule(source, order, { requestId: order.rescheduleRequest.id, approved, reason: "已与客人沟通确认", ...extra }, session);
};
async function api(t, source) {
  const auth = { async init() {}, async getSession(token) { return { owner: owner.identity, admin: manager,
    finance: { kind: "admin", role: "finance", subjectId: "finance", account: "finance" } }[token] || null; } };
  await source.create("staff", { id: "manager", account: "manager", role: "super", status: "active" });
  await source.create("staff", { id: "finance", account: "finance", role: "finance", status: "active" });
  const handler = createApi(source, "json", { auth, permissionStore: null, sourceStatus: { ready: true } });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (token, pathname, data) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
}

test("owner submits one pending reschedule and no schedule changes until admin approval", async t => {
  const source = await fixture(t), before = await source.get("orders", "reschedule");
  assert.equal(workflow.publicOrderProjection(before).canReschedule, true);
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(source)));
  responses.forEach(result => assert.equal(result.success, true, JSON.stringify(result)));
  assert.equal(new Set(responses.map(result => result.data.rescheduleRequest.id)).size, 1);
  const pending = await source.get("orders", "reschedule");
  assert.equal(pending.appointmentAt, before.appointmentAt);
  assert.equal(pending.timePeriod, before.timePeriod);
  assert.equal(pending.statusLogs.length, 1);
  assert.equal(pending.rescheduleRequest.status, "pending");
  const detail = await rpc(source, "getOrderDetail", { data: { orderId: "reschedule" } }, owner);
  assert.equal(detail.data.canReschedule, false);
  assert.equal(detail.data.rescheduleRequest.requestedBy, undefined);
  assert.equal(detail.data.rescheduleRequest.idempotencyKey, undefined);
  assert.equal((await request(source, { idempotencyKey: "reschedule-another-2" })).success, false);
  assert.equal((await request(source, { reason: "变更同一个请求的内容" })).success, false);
  await review(source);
  const approved = await source.get("orders", "reschedule");
  assert.equal(approved.rescheduleRequest.status, "approved");
  assert.equal(approved.appointmentAt, "2099-02-20 14:30:00");
  assert.equal(approved.confirmedDate, "2099-02-20");
  assert.equal(approved.rescheduleRecords.length, 1);
  assert.equal(approved.depositPaid, before.depositPaid);
  assert.equal((await review(source)).idempotent, true);
});

test("authentication, ownership, valid future dates and pre-shoot state are enforced", async t => {
  const source = await fixture(t);
  for (const context of [{}, { identity: { kind: "admin", openid: owner.identity.openid } }, { identity: { kind: "public", openid: "other" } }]) assert.equal((await request(source, {}, context)).success, false);
  for (const patch of [{ appointmentAt: "2099-02-30" }, { appointmentAt: "2099-13-01" }, { appointmentAt: "2020-01-01" }, { timePeriod: "24:00" }, { timePeriod: "noon" }, { reason: "短" }]) assert.equal((await request(source, patch)).success, false, JSON.stringify(patch));
  for (const patch of [{ status: "shooting" }, { service_status: "shooting" }, { shootingStartedAt: "2026-11-15T01:00:00Z" }, { customerArrivedAt: "2026-11-15T01:00:00Z" }, { status: "completed" }, { status: "cancelled" }, { orderType: "physical" }]) {
    const f = await fixture(t, patch);
    assert.equal(workflow.publicOrderProjection(await f.get("orders", "reschedule")).canReschedule, false);
    assert.equal((await request(f)).success, false, JSON.stringify(patch));
  }
  assert.equal((await source.get("orders", "reschedule")).rescheduleRequest, undefined);
});

test("assigned service orders keep legacy snapshots and workbench schedule synchronized", async t => {
  const source = await fixture(t, { photographerId: "photo", photo_id: "photo", status: "assigned", service_status: "confirmed", svc_paid_processed: 1,
    schedule_time: "2099-01-01 10:00:00", packageSnapshot: { name: "旅拍", date: "2099-01-01", timePeriod: "10:00", price: 100 }, confirmationSnapshot: { date: "2099-01-01", time: "10:00", totalAmount: 100 } });
  assert.equal((await request(source)).success, true);
  await review(source);
  const order = await source.get("orders", "reschedule");
  assert.equal(order.schedule_time, "2099-02-20 14:30:00");
  assert.equal(order.confirmationSnapshot.date, "2099-02-20");
  assert.equal(order.packageSnapshot.timePeriod, "14:30");
  assert.equal(order.packageSnapshot.price, 100);
  assert.equal(order.service_status, "confirmed");
  assert.equal(order.photographerId, "photo");
});

test("rejection leaves the existing date intact and approval revalidates shooting/concurrent changes", async t => {
  const source = await fixture(t);
  await request(source);
  await source.update("orders", "reschedule", { service_status: "shooting", status: "shooting" });
  await assert.rejects(review(source), /开始拍摄/);
  await review(source, false);
  assert.equal((await source.get("orders", "reschedule")).appointmentAt, "2099-01-01 10:00:00");
  const f = await fixture(t);
  await request(f);
  const compare = f.compareAndUpdate.bind(f);
  f.compareAndUpdate = async (...args) => { await f.update("orders", "reschedule", { status: "shooting" }); return compare(...args); };
  await assert.rejects(review(f), /状态已变化/);
  const order = await f.get("orders", "reschedule");
  assert.equal(order.rescheduleRequest.status, "pending");
  assert.equal(order.appointmentAt, "2099-01-01 10:00:00");
});

test("protected HTTP approval rejects customer and finance role and accepts configured admin", async t => {
  const source = await fixture(t), post = await api(t, source);
  const pending = await post("owner", "/api/rpc/requestOrderReschedule", { data: application() });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.success, true);
  const payload = { action: "reviewreschedule", requestId: pending.body.data.rescheduleRequest.id, approved: true, reason: "已沟通可以改期" };
  for (const token of ["owner", "finance", ""]) {
    const result = await post(token, "/api/orders/reschedule/action", payload);
    assert.ok([401, 403].includes(result.status), JSON.stringify(result));
  }
  const approved = await post("admin", "/api/orders/reschedule/action", payload);
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal(approved.body.data.rescheduleRequest.status, "approved");
});

test("review cannot overwrite another service agent's request or collide with photographer's task", async t => {
  const source = await fixture(t, { assigneeId: "another-service", photographerId: "photo" });
  await request(source);
  await assert.rejects(review(source, true, {}, { role: "service", subjectId: "own-service" }), /无权/);
  await source.create("orders", { id: "busy", openid: "other", photographerId: "photo", status: "assigned", depositDue: 0, appointmentAt: "2099-02-20 14:30:00", timePeriod: "14:30" });
  await assert.rejects(review(source), /已有任务/);
});

test("MySQL customer actions take the service lock before revalidating the order row", async () => {
  const schema = require("../lib/mysqlSchema.cjs"), createMysqlSource = require("../lib/mysqlSource.cjs");
  for (const patch of [{ rescheduleRequest: { id: "pending", status: "approved" } }, { cancellationSource: "customer_self_cancel", status: "cancelled" }]) {
    const events = [], tables = new Map(schema.ALL_KEYS.map(key => [schema.tableName(key), schema.definition(key).columns.map(column => column.name)]));
    let row = { id: "racing-order", status: "deposit_paid" };
    async function query(sql, params = []) {
      if (sql.includes("information_schema.columns")) return [params.flatMap(table => (tables.get(table) || []).map(column => ({ TABLE_NAME: table, COLUMN_NAME: column })))];
      if (sql === "SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE") {
        events.push("service-lock");
        // A different process finishes shooting/start while we wait for the
        // service lock. Only the later locked row read may grant this action.
        row = { ...row, status: "shooting" }; return [[{ id: 1 }]];
      }
      if (sql.startsWith("SELECT * FROM `lxm_orders`")) { events.push("order-lock"); return [[row]]; }
      if (sql.startsWith("SELECT")) return [[]];
      throw new Error("Stale customer action must not write: " + sql);
    }
    const connection = { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    const source = createMysqlSource({ pool: { query, async getConnection() { return connection; } }, autoMigrate: false, logger: { warn() {}, error() {} } });
    assert.equal(await source.compareAndUpdate("orders", row.id, { status: "deposit_paid" }, patch), null);
    assert.deepEqual(events, ["service-lock", "order-lock"]);
  }
});
