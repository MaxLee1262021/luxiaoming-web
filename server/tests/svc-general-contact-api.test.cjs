"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const createApi = require("../lib/api.cjs");
const { SvcGeneralContactError } = require("../lib/svcGeneralContact.cjs");
const path = "/api/kf/orders/CONTACT-HTTP-001/contact";
const newMenu = { menuKey: "general-only", name: "总工作台", status: "active", meta: { routeKey: "svcGeneralWorkbench" } };
const oldMenu = { menuKey: "old-only", name: "工作台概览", status: "active", meta: { routeKey: "svcWorkbench" } };

async function fixture(t) {
  const users = new Map(), policies = new Map(), sessions = {};
  for (const [token, role, menu] of [["service", "service", newMenu], ["legacy", "service", oldMenu], ["finance", "finance", newMenu], ["supervisor", "service_supervisor", newMenu], ["denied", "service", newMenu]]) {
    const id = `auth-${token}`;
    users.set(id, { id, account: token, roleId: `role-${role}`, status: "active", extra: { subjectId: `legacy-business-${token}`, subjectType: "staff" } });
    policies.set(id, { role: { id: `role-${role}`, roleKey: role, name: role, status: "active" }, menuKeys: [menu.menuKey], menuRows: [newMenu, oldMenu] });
    sessions[token] = { kind: "admin", role, authzUserId: id, subjectId: `stale-subject-${token}`, account: token };
  }
  sessions.public = { kind: "public", openid: "public-test" };
  const auth = { async init() {}, async getSession(token) { return structuredClone(sessions[token] || null); }, async revokeSession() {} };
  const permissionStore = {
    required: true, async init() {}, async getUser(id) { return structuredClone(users.get(id) || null); },
    async getPolicyForUser(user) { return structuredClone(policies.get(user.id) || null); },
  };
  const mappingQueries = [], prepared = [], workbenchCalls = [], logs = [];
  let mappings = new Map([["auth-service", "operator.current"], ["auth-supervisor", "supervisor.current"]]);
  let order = { order_no: "CONTACT-HTTP-001", assignee_id: "ORDER-OWNER-IS-NOT-OPERATOR", customer_openid: "openid-http-test", wecom_external_userid: "wm_HTTP_TEST_CUSTOMER", can_generate_link: true };
  let providerFailure, detailFailure;
  const source = {
    async list() { return []; }, async get() { return null; },
    async transaction(fn) { return fn({ async query(sql, params) {
      mappingQueries.push({ sql, params: structuredClone(params) });
      return [mappings.has(params[0]) ? [{ wecom_userid: mappings.get(params[0]) }] : []];
    } }); },
  };
  const workbench = { async execute(method, route, input, session) {
    workbenchCalls.push({ method, route, input, session });
    if (detailFailure) throw detailFailure;
    if (session.account === "denied") return { ...order, can_generate_link: false };
    return structuredClone(order);
  } };
  const svcGeneralContact = { async prepare(value) {
    prepared.push(structuredClone(value));
    if (providerFailure) throw providerFailure;
    return { kind: "wecom_jsapi", status: "ready_to_open", params: { externalUserIds: [order.wecom_external_userid] }, config_signature: { signature: "test-signature" }, message: "准备完成，尚未打开会话" };
  } };
  const logger = Object.fromEntries(["info", "warn", "error", "debug"].map(level => [level, (...args) => logs.push({ level, args })]));
  const handler = createApi(source, "json", { auth, permissionStore, customerService: { workbench }, svcGeneralContact, logger });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(token = "service", body = { pageUrl: "https://admin.example.test/#svcGeneralWorkbench" }, method = "POST", route = path) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { "User-Agent": "CONTACT-HTTP wxwork/4.1", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined || ["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }
  return { request, prepared, mappingQueries, workbenchCalls, logs,
    setMappings(value) { mappings = value; }, setOrder(value) { order = value; },
    setProviderFailure(value) { providerFailure = value; }, setDetailFailure(value) { detailFailure = value; },
    setPolicy(token, value) { policies.set(`auth-${token}`, value); }, getPolicy(token) { return structuredClone(policies.get(`auth-${token}`)); },
  };
}

test("contact HTTP route authorizes a new-menu-only service session and prepares a capability without claiming delivery", async t => {
  const f = await fixture(t);
  const result = await f.request();
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.code, 0);
  assert.equal(result.cacheControl, "no-store");
  assert.equal(result.body.data.kind, "wecom_jsapi"); assert.equal(result.body.data.status, "ready_to_open");
  assert.equal(result.body.data.contacted, undefined); assert.equal(result.body.data.delivered, undefined); assert.equal(result.body.data.url, undefined);
  assert.equal(f.prepared.length, 1);
  assert.deepEqual(f.workbenchCalls.map(call => [call.method, call.route]), [["GET", "/api/kf/orders/CONTACT-HTTP-001"]]);
  assert.equal(f.prepared[0].pageUrl, "https://admin.example.test/#svcGeneralWorkbench");
  assert.match(f.prepared[0].userAgent, /CONTACT-HTTP wxwork/);
});

test("contact route uses the refreshed authenticated account mapping, never order assignee or forged body identity", async t => {
  const f = await fixture(t);
  const result = await f.request("supervisor", {
    pageUrl: "https://admin.example.test/", staff_id: "ORDER-OWNER-IS-NOT-OPERATOR", wecom_userid: "attacker.member", customer_openid: "attacker-customer", external_userid: "wm_ATTACKER_CUSTOMER", userAgent: "spoofed-agent", phone: "13900139021",
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(f.mappingQueries[0].params, ["auth-supervisor"]);
  assert.match(f.mappingQueries[0].sql, /m\.staff_id=\?/); assert.match(f.mappingQueries[0].sql, /m\.status='ACTIVE'/); assert.match(f.mappingQueries[0].sql, /u\.status='active'/);
  assert.equal(f.prepared[0].staff.wecom_userid, "supervisor.current");
  assert.equal(f.prepared[0].order.wecom_external_userid, "wm_HTTP_TEST_CUSTOMER");
  assert.notEqual(f.prepared[0].userAgent, "spoofed-agent");
  assert.equal(JSON.stringify(result).includes("13900139021"), false);
});

test("old-menu-only, revoked, spoofed route grants and finance roles cannot invoke the new contact provider", async t => {
  const f = await fixture(t);
  for (const token of ["legacy", "finance"]) assert.equal((await f.request(token)).status, 403, token);
  const revoked = f.getPolicy("service"); revoked.menuKeys = []; f.setPolicy("service", revoked);
  assert.equal((await f.request()).status, 403);
  f.setPolicy("service", { ...revoked, menuKeys: ["svcGeneralWorkbench"], menuRows: [{ menuKey: "svcGeneralWorkbench", status: "active", meta: { routeKey: "orders" } }] });
  assert.equal((await f.request()).status, 403, "matching identifier for a different route is insufficient");
  assert.deepEqual(f.prepared, []); assert.deepEqual(f.mappingQueries, []);
});

test("missing sessions and wrong HTTP methods fail before resolving an order or provider", async t => {
  const f = await fixture(t);
  for (const token of [null, "unknown", "public"]) assert.equal((await f.request(token)).status, 401, String(token));
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await f.request("service", undefined, method)).status, 405, method);
  assert.deepEqual(f.prepared, []); assert.deepEqual(f.workbenchCalls, []); assert.deepEqual(f.mappingQueries, []);
});

test("authorized detail with no contact/follow capability and inaccessible orders are refused", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("denied")).status, 403);
  const error = Object.assign(new Error("无权查看他人订单"), { code: 403, statusCode: 403 });
  f.setDetailFailure(error);
  assert.equal((await f.request()).status, 403);
  assert.deepEqual(f.prepared, []); assert.deepEqual(f.mappingQueries, []);
});

test("missing current account mapping is actionable and does not use an order owner's member ID", async t => {
  const f = await fixture(t); f.setMappings(new Map([["ORDER-OWNER-IS-NOT-OPERATOR", "another.member"]]));
  const result = await f.request();
  assert.equal(result.status, 409); assert.match(result.body.msg, /当前登录客服.*映射/);
  assert.deepEqual(f.mappingQueries[0].params, ["auth-service"]); assert.deepEqual(f.prepared, []);
});

test("safe contact configuration errors remain actionable while unknown provider diagnostics and data are hidden", async t => {
  const f = await fixture(t);
  f.setProviderFailure(new SvcGeneralContactError("WECOM_GENERAL_DISABLED", "总工作台企微直接联系尚未启用，请联系管理员配置", 503));
  const configured = await f.request();
  assert.equal(configured.status, 503); assert.equal(configured.body.code, "WECOM_GENERAL_DISABLED"); assert.match(configured.body.msg, /尚未启用/);
  const secret = "PRIVATE_CONTACT_SECRET token=PRIVATE_CONTACT_TOKEN 13900139021";
  for (const fields of [{ code: "UNTRUSTED_PROVIDER_ERROR", statusCode: 503 }, { code: "UNTRUSTED_PROVIDER_ERROR", statusCode: 400 }, { code: 4014, statusCode: 200 }]) {
    f.setProviderFailure(Object.assign(new Error(secret), { ...fields, data: { diagnostic: secret } }));
    const unknown = await f.request();
    assert.equal(unknown.status, 503); assert.equal(unknown.body.code, "SVC_UNAVAILABLE");
    assert.equal(JSON.stringify(unknown.body).includes(secret), false); assert.equal(unknown.body.data, undefined);
  }
  assert.equal(JSON.stringify(f.logs).includes(secret), false);
});
