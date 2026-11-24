"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const createApi = require("../lib/api.cjs");

async function fixture(t, options = {}) {
  const staff = [
    { id: "admin", account: "admin", role: "super", status: "active" },
    { id: "service", account: "service", role: "service", status: "active" },
    { id: "content", account: "content", role: "content", status: "active" },
    { id: "finance", account: "finance", role: "finance", status: "active" },
  ];
  const sessions = Object.fromEntries(staff.map(row => [row.id, {
    kind: "admin", role: row.role, subjectId: row.id, account: row.account,
  }]));
  sessions.public = { kind: "public", openid: "customer" };
  const source = {
    async list(key) { return key === "staff" ? structuredClone(staff) : []; },
    async get(key, id) { return key === "staff" ? structuredClone(staff.find(row => row.id === id) || null) : null; },
    async create(key, row) { return structuredClone(row); },
  };
  const calls = [];
  let failure;
  const productLinksService = {
    async catalog() {
      calls.push({ action: "catalog" });
      if (failure) throw failure;
      return { items: [{ id: "photo", type: "album", name: "照片留影" }] };
    },
    async generate(body) {
      calls.push({ action: "generate", body });
      if (failure) throw failure;
      return { urlLink: "https://wxaurl.cn/test-product", productId: body.id };
    },
  };
  const users = new Map();
  let policy = {
    role: { id: "role-operator", roleKey: "operator", name: "外链操作员", status: "active" },
    menuKeys: ["custom-links"],
    menuRows: [{ menuKey: "custom-links", name: "商品小程序外链", status: "active", meta: { routeKey: "productLinks" } }],
  };
  const permissionStore = options.normalized ? {
    required: true,
    async init() {},
    async getUser(id) { return structuredClone(users.get(id) || null); },
    async getPolicyForUser() { return structuredClone(policy); },
  } : null;
  if (options.normalized) {
    users.set("operator-user", { id: "operator-user", account: "operator", roleId: "role-operator", status: "active" });
    sessions.operator = { kind: "admin", authzUserId: "operator-user", role: "operator", subjectId: "operator-user", account: "operator" };
  }
  const auth = { async init() {}, async getSession(token) { return structuredClone(sessions[token] || null); }, async revokeSession() {} };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const handler = createApi(source, "json", { auth, permissionStore, productLinksService, logger });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(path, token = "admin", body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: options.rawBody ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }
  return { request, calls, setFailure(error) { failure = error; }, setPolicy(value) { policy = value; }, getPolicy() { return structuredClone(policy); } };
}

test("product link endpoints require an admin session and grant legacy customer service access", async t => {
  const f = await fixture(t);
  for (const token of [null, "public", "unknown"]) {
    assert.equal((await f.request("/api/product-links/catalog", token)).status, 401);
    assert.equal((await f.request("/api/product-links/generate", token, { id: "photo", type: "album" })).status, 401);
  }
  for (const token of ["content", "finance"]) {
    assert.equal((await f.request("/api/product-links/catalog", token)).status, 403);
    assert.equal((await f.request("/api/product-links/generate", token, { id: "photo", type: "album" })).status, 403);
  }
  assert.deepEqual(f.calls, [], "unauthorized requests never invoke the link provider");
  for (const token of ["admin", "service"]) {
    const catalog = await f.request("/api/product-links/catalog", token);
    assert.equal(catalog.status, 200, JSON.stringify(catalog));
    assert.equal(catalog.body.items[0].id, "photo");
    assert.equal(catalog.cacheControl, "no-store");
    const generated = await f.request("/api/product-links/generate", token, { id: "photo", type: "album", expireDays: 30 });
    assert.equal(generated.status, 200, JSON.stringify(generated));
    assert.equal(generated.body.urlLink, "https://wxaurl.cn/test-product");
    assert.equal(generated.cacheControl, "no-store");
  }
  assert.deepEqual(f.calls.filter(call => call.action === "generate").map(call => call.body), [
    { id: "photo", type: "album", expireDays: 30 }, { id: "photo", type: "album", expireDays: 30 },
  ]);
});

test("product link permission follows the granted route and observes revocation on the next request", async t => {
  const f = await fixture(t, { normalized: true });
  assert.equal((await f.request("/api/product-links/catalog", "operator")).status, 200);
  assert.equal((await f.request("/api/product-links/generate", "operator", { id: "photo", type: "album" })).status, 200);

  const revoked = f.getPolicy(); revoked.menuKeys = [];
  f.setPolicy(revoked);
  assert.equal((await f.request("/api/product-links/catalog", "operator")).status, 403);
  assert.equal((await f.request("/api/product-links/generate", "operator", { id: "photo", type: "album" })).status, 403);

  f.setPolicy({ ...revoked, menuKeys: ["productLinks"], menuRows: [
    { menuKey: "productLinks", name: "Different page", status: "active", meta: { routeKey: "orders" } },
  ] });
  assert.equal((await f.request("/api/product-links/catalog", "operator")).status, 403, "a coincidental menu identifier must not grant another route");
  assert.equal(f.calls.length, 2, "revoked and spoofed grants never reach the provider");
});

test("product link HTTP routes enforce the catalog and generation methods", async t => {
  const f = await fixture(t);
  for (const [path, method] of [
    ["/api/product-links/catalog", "POST"], ["/api/product-links/catalog", "PUT"],
    ["/api/product-links/generate", "GET"], ["/api/product-links/generate", "DELETE"],
  ]) {
    const result = await f.request(path, "admin", undefined, method);
    assert.equal(result.status, 405, `${method} ${path}`);
    assert.equal(result.cacheControl, "no-store");
  }
  for (const path of ["/api/product-links", "/api/product-links/unknown", "/api/product-links/catalog/extra", "/api/product-links/generate/extra"]) {
    const result = await f.request(path);
    assert.equal(result.status, 404, path);
    assert.equal(result.cacheControl, "no-store");
  }
  assert.deepEqual(f.calls, []);
});

test("product link errors expose only approved public messages and never provider diagnostics", async t => {
  const f = await fixture(t);
  const { ERROR_MESSAGES } = require("../lib/productLinks.cjs");
  const code = Object.keys(ERROR_MESSAGES)[0];
  assert.ok(code, "the link service defines public error messages");
  const secret = "TEST_PROVIDER_SECRET access_token=private-token SQL /srv/private.env";
  f.setFailure(Object.assign(new Error(secret), { code, statusCode: 400 }));
  const known = await f.request("/api/product-links/generate", "admin", { id: "photo", type: "album" });
  assert.equal(known.status, 400);
  assert.deepEqual(known.body, { code, error: ERROR_MESSAGES[code] });
  assert.equal(known.cacheControl, "no-store");

  f.setFailure(Object.assign(new Error(secret), { code: "PROVIDER_RAW_DIAGNOSTIC", statusCode: 400 }));
  for (const [path, body] of [["/api/product-links/catalog", undefined], ["/api/product-links/generate", { id: "photo", type: "album" }]]) {
    const unknown = await f.request(path, "service", body);
    assert.equal(unknown.status, 503);
    assert.deepEqual(unknown.body, { code: "PRODUCT_LINK_UNAVAILABLE", error: "商品外链服务暂不可用，请稍后重试" });
    assert.equal(unknown.cacheControl, "no-store");
    assert.equal(JSON.stringify(unknown.body).includes(secret), false);
  }
});

test("malformed product-link JSON returns a prompt validation error without reaching the provider", { timeout: 5000 }, async t => {
  const f = await fixture(t, { rawBody: true });
  const result = await f.request("/api/product-links/generate", "admin", '{"id":');
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "PRODUCT_LINK_INPUT_INVALID");
  assert.deepEqual(f.calls, []);
});
