"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createApi = require("../lib/api.cjs");
const createSource = require("./fixtures/jsonSource.cjs");
const GENERAL = "/api/kf/workbench/general";
const REVIEW = GENERAL + "/reschedule-review";
const newMenu = { menuKey: "general-grant", status: "active", meta: { routeKey: "svcGeneralWorkbench" } };
const oldMenu = { menuKey: "legacy-grant", status: "active", meta: { routeKey: "svcWorkbench" } };
const ordersMenu = { menuKey: "orders-grant", status: "active", meta: { routeKey: "orders" } };

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-general-api-test-"));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = createSource({ jsonFile: path.join(directory, "db.json") });
  const users = new Map(), policies = new Map(), sessions = {};
  for (const [token, role, menu] of [["service", "service", newMenu], ["legacy", "service", oldMenu], ["finance", "finance", newMenu], ["supervisor", "service_supervisor", newMenu], ["other", "service", newMenu], ["admin", "super", newMenu]]) {
    const id = "auth-" + token;
    users.set(id, { id, account: token, roleId: "role-" + role, status: "active", extra: { subjectId: id, subjectType: "staff" } });
    policies.set(id, { role: { id: "role-" + role, roleKey: role, status: "active" }, menuKeys: [menu.menuKey], menuRows: [newMenu, oldMenu, ordersMenu] });
    sessions[token] = { kind: "admin", role, authzUserId: id, subjectId: "stale-identity", account: token };
  }
  sessions.public = { kind: "public", openid: "customer" };
  const auth = { async init() {}, async getSession(token) { return structuredClone(sessions[token] || null); }, async revokeSession() {} };
  const permissionStore = {
    required: true, async init() {}, async getUser(id) { return structuredClone(users.get(id) || null); },
    async getPolicyForUser(user) { return structuredClone(policies.get(user.id) || null); }
  };
  const pending = (id, assigneeId = "auth-service", extra = {}) => ({ id, orderNo: "RES-" + id, openid: "customer-" + id, status: "deposit_paid", service_status: "confirmed",
    assigneeId, assignee_id: assigneeId, totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70,
    appointmentAt: "2099-01-01 10:00:00", schedule_time: "2099-01-01 10:00:00", timePeriod: "10:00",
    rescheduleRequest: { id: "request-" + id, status: "pending", appointmentAt: "2099-02-20", timePeriod: "14:30", reason: "行程调整", requestedAt: "2026-11-19T10:00:00Z" }, ...extra });
  for (const value of [pending("new-review"), pending("old-review"), pending("foreign", "auth-other"), pending("unassigned", null), pending("started", "auth-service", { status: "shooting", service_status: "shooting", shootingStartedAt: "2026-11-19T10:00:00Z" })]) await source.create("orders", value);
  const workbenchCalls = [];
  const workbench = { async execute(method, route, input, session) {
    workbenchCalls.push({ method, route, input, session });
    return { list: [], total: 0, cards: { pool: 0, mine: 0, pending: 0, today: 0, reschedule: ["super", "service"].includes(session.role) ? 0 : null, complaints: 0 },
      capabilities: { review_reschedule: ["super", "service"].includes(session.role) }, summary: { pool: 0 } };
  } };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const handler = createApi(source, "json", { auth, permissionStore, customerService: { workbench }, logger });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(route = GENERAL, token = "service", body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined || ["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }
  return { source, request, workbenchCalls, policy(token) { return structuredClone(policies.get("auth-" + token)); }, setPolicy(token, value) { policies.set("auth-" + token, value); } };
}
const payload = (id = "new-review", extra = {}) => ({ order_id: id, requestId: "request-" + id, approved: true, reason: "已与客人沟通确认改期", ...extra });

test("new general read endpoints require their menu while old overview retains the old-menu path", async t => {
  const f = await fixture(t);
  const routes = [GENERAL, GENERAL + "/queues?queue=reschedule", "/api/kf/photographers/p1/occupancy?from=2026-11-20&days=14"];
  for (const route of routes) {
    const rejected = await f.request(route, "legacy");
    assert.equal(rejected.status, 403, JSON.stringify(rejected));
  }
  assert.equal(f.workbenchCalls.length, 0, "legacy-only grants fail before domain work");
  for (const route of routes) {
    const result = await f.request(route);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.code, 0);
    assert.equal(result.cacheControl, "no-store");
  }
  const old = await f.request("/api/kf/workbench/overview?mode=workbench", "legacy");
  assert.equal(old.status, 200);
  assert.equal(old.body.code, 0);
  assert.equal(f.workbenchCalls.at(-1).route, "/api/kf/workbench/overview");
});

test("new read menu revocation and misleading route grants take effect on the next request", async t => {
  const f = await fixture(t);
  assert.equal((await f.request()).status, 200);
  const policy = f.policy("service"); policy.menuKeys = []; f.setPolicy("service", policy);
  assert.equal((await f.request()).status, 403);
  f.setPolicy("service", { ...policy, menuKeys: ["svcGeneralWorkbench"], menuRows: [{ menuKey: "svcGeneralWorkbench", status: "active", meta: { routeKey: "orders" } }] });
  assert.equal((await f.request()).status, 403);
  assert.equal(f.workbenchCalls.length, 1);
});

test("new-menu-only service reviews its own pending request through the dedicated endpoint", async t => {
  const f = await fixture(t);
  const before = await f.source.get("orders", "new-review");
  const result = await f.request(REVIEW, "service", payload());
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.code, 0);
  assert.equal(result.body.data.order.rescheduleRequest.status, "approved");
  assert.equal(result.body.data.order.appointmentAt, "2099-02-20 14:30:00");
  assert.equal(result.body.data.order.schedule_time, "2099-02-20 14:30:00");
  assert.equal(result.body.data.order.service_status, before.service_status);
  assert.equal(result.body.data.order.depositPaid, before.depositPaid);
  assert.equal(result.body.data.order.rescheduleRecords.length, 1);
  assert.equal(result.body.data.order.rescheduleRequest.reviewedBy, "auth-service", "refreshed subject is used for audit");
  const retry = await f.request(REVIEW, "service", payload());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.idempotent, true);
  assert.equal((await f.source.get("orders", "new-review")).rescheduleRecords.length, 1);
});

test("dedicated review rejects missing/old grants, public sessions, finance and supervisors before writing", async t => {
  const f = await fixture(t), before = await f.source.get("orders", "new-review");
  for (const token of [null, "unknown", "public"]) assert.equal((await f.request(REVIEW, token, payload())).status, 401, String(token));
  for (const token of ["legacy", "finance", "supervisor"]) assert.equal((await f.request(REVIEW, token, payload())).status, 403, token);
  const revoked = f.policy("service"); revoked.menuKeys = []; f.setPolicy("service", revoked);
  assert.equal((await f.request(REVIEW, "service", payload())).status, 403);
  assert.deepEqual(await f.source.get("orders", "new-review"), before);
});

test("new review preserves ownership and original reason/request/state validation", async t => {
  const f = await fixture(t);
  const foreign = await f.source.get("orders", "foreign");
  assert.equal((await f.request(REVIEW, "service", payload("foreign"))).status, 403);
  assert.deepEqual(await f.source.get("orders", "foreign"), foreign);
  for (const extra of [{ reason: "短" }, { reason: "长".repeat(501) }, { approved: "true" }]) assert.equal((await f.request(REVIEW, "service", payload("new-review", extra))).status, 400);
  assert.equal((await f.request(REVIEW, "service", payload("new-review", { requestId: "stale-request" }))).status, 409);
  assert.equal((await f.request(REVIEW, "service", payload("started"))).status, 409);
  assert.equal((await f.request(REVIEW, "service", payload("missing"))).status, 404);
  assert.equal((await f.source.get("orders", "new-review")).rescheduleRequest.status, "pending");
  const rejected = await f.request(REVIEW, "service", payload("new-review", { approved: false, reason: "客人与摄影师尚未确认" }));
  assert.equal(rejected.status, 200, JSON.stringify(rejected));
  assert.equal(rejected.body.data.order.rescheduleRequest.status, "rejected");
  assert.equal(rejected.body.data.order.schedule_time, "2099-01-01 10:00:00");
});

test("new review keeps the old unassigned-request rule and explicit HTTP method requirement", async t => {
  const f = await fixture(t);
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await f.request(REVIEW, "service", undefined, method)).status, 405, method);
  const result = await f.request(REVIEW, "service", payload("unassigned"));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.code, 0);
  assert.equal(result.body.data.order.rescheduleRequest.status, "approved");
  assert.deepEqual(f.workbenchCalls, [], "dedicated review goes to original customerReschedule service instead of generic desk writes");
});

test("new review authorization does not open the legacy order-action menu gate", async t => {
  const f = await fixture(t), oldRoute = "/api/orders/old-review/action", oldPayload = { action: "reviewreschedule", ...payload("old-review") };
  const before = await f.source.get("orders", "old-review");
  const denied = await f.request(oldRoute, "service", oldPayload);
  assert.equal(denied.status, 403, JSON.stringify(denied));
  assert.deepEqual(await f.source.get("orders", "old-review"), before);
  assert.equal((await f.request(REVIEW, "service", payload())).status, 200, "new route is independently authorized");
  assert.equal((await f.request(oldRoute, "service", oldPayload)).status, 403, "new success does not alter old menu policy");
  const policy = f.policy("service"); policy.menuKeys.push(ordersMenu.menuKey); f.setPolicy("service", policy);
  const oldAllowed = await f.request(oldRoute, "service", oldPayload);
  assert.equal(oldAllowed.status, 200, JSON.stringify(oldAllowed));
  assert.equal(oldAllowed.body.data.rescheduleRequest.status, "approved");
});
