"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");

async function fixture(t, config) {
  const rows = { staff: [
    { id: "admin", account: "admin", role: "super", status: "active" },
    { id: "editor", account: "editor", role: "content", status: "active" },
    { id: "service", account: "service", role: "service", status: "active" }
  ], siteConfig: config ? [{ ...structuredClone(config), id: "global" }] : [], logs: [] };
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find(row => String(row.id || row._id) === String(id)) || null); },
    async create(key, value) { const row = { ...structuredClone(value), id: value.id || `${key}-${(rows[key] || []).length}` }; (rows[key] ||= []).push(row); return structuredClone(row); },
    async update(key, id, patch) { const row = (rows[key] || []).find(row => row.id === id); if (!row) return null; Object.assign(row, structuredClone(patch)); return structuredClone(row); },
    async upsert(key, id, patch) { return await this.get(key, id) ? this.update(key, id, patch) : this.create(key, { ...patch, id }); },
    async remove(key, id) { rows[key] = (rows[key] || []).filter(row => row.id !== id); return true; }
  };
  const auth = { async init() {}, async getSession(token) { const row = rows.staff.find(row => row.id === token); return row ? { kind: "admin", role: row.role, subjectId: row.id, account: row.account } : null; } };
  const handler = createApi(source, "json", { auth });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (path, body, token = "editor", method = body === undefined ? "GET" : "PUT") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  return { source, request };
}

test("success tips save independently, preserve line breaks and round-trip to the public booking RPC", async t => {
  const f = await fixture(t);
  const saved = await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: "  第一段\r\n\r\n  第二段\r第三段  " });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const expected = "第一段\n\n  第二段\n第三段";
  const stored = await f.source.get("siteConfig", "global");
  assert.equal(stored.bookingSuccessTips, expected);
  assert.equal(Object.hasOwn(stored, "bookingNotice"), false);
  assert.equal(Object.hasOwn(stored, "customPrice"), false);
  const read = await f.request("/api/doc/siteConfig/global");
  assert.equal(read.body.bookingSuccessTips, expected);
  const module = await f.request("/api/modules/bookingConfig?keys=siteConfig");
  assert.equal(module.body.collections.siteConfig.bookingSuccessTips, expected);
  const publicRead = await f.request("/api/rpc/getBookingConfig", {}, null, "POST");
  assert.equal(publicRead.status, 200, JSON.stringify(publicRead));
  assert.equal(publicRead.body.success, true);
  assert.equal(publicRead.body.data.bookingSuccessTips, expected);
});

test("tips changes do not require a notice version or overwrite unrelated configuration", async t => {
  const initial = {
    bookingNotice: ["Terms"], bookingNoticeVersion: "v1", customPrice: { depositRatio: 0.3, extension: "keep" },
    privacyPolicy: { title: "Policy", content: "Keep policy" }, search: { hotwords: ["keep"] },
    wechat: { corpSecret: "TEST_ONLY_SECRET" }
  };
  const f = await fixture(t, initial);
  const result = await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: "New tips" });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(await f.source.get("siteConfig", "global"), { ...initial, id: "global", bookingSuccessTips: "New tips" });
  assert.equal(JSON.stringify(result.body).includes("TEST_ONLY_SECRET"), false);
  const exposed = (await rpc(f.source, "getBookingConfig", {})).data;
  assert.equal(exposed.bookingSuccessTips, "New tips");
  assert.equal(exposed.bookingNoticeVersion, "v1");
  assert.equal(JSON.stringify(exposed).includes("TEST_ONLY_SECRET"), false);
  assert.equal((await f.request("/api/doc/siteConfig/global", { customPrice: { depositRatio: 0.5 } })).status, 200);
  assert.equal((await f.source.get("siteConfig", "global")).bookingSuccessTips, "New tips");
});

test("missing, cleared and historical invalid tips return an empty string for the client fallback", async t => {
  const f = await fixture(t);
  assert.equal((await rpc(f.source, "getBookingConfig", {})).data.bookingSuccessTips, "");
  assert.equal((await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: "Configured tips" })).status, 200);
  assert.equal((await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: " \r\n " })).status, 200);
  assert.equal((await f.source.get("siteConfig", "global")).bookingSuccessTips, "");
  assert.equal((await rpc(f.source, "getBookingConfig", {})).data.bookingSuccessTips, "");
  await f.source.update("siteConfig", "global", { bookingSuccessTips: { text: "Invalid historical value" } });
  assert.equal((await rpc(f.source, "getBookingConfig", {})).data.bookingSuccessTips, "");
});

test("invalid and oversized success tips are rejected before any configuration or audit write", async t => {
  const f = await fixture(t, { bookingSuccessTips: "Keep", search: { hotwords: ["keep"] } });
  const original = await f.source.get("siteConfig", "global");
  for (const bookingSuccessTips of [null, false, 123, [], ["text"], {}, "字".repeat(20001)]) {
    const result = await f.request("/api/doc/siteConfig/global", { bookingSuccessTips, search: { hotwords: ["must not save"] } });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(await f.source.get("siteConfig", "global"), original);
    assert.deepEqual(await f.source.list("logs"), []);
  }
  const boundary = "文".repeat(20000);
  assert.equal((await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: boundary })).status, 200);
  assert.equal((await rpc(f.source, "getBookingConfig", {})).data.bookingSuccessTips, boundary);
});

test("unauthorized roles and anonymous requests cannot change success tips", async t => {
  const f = await fixture(t, { bookingSuccessTips: "Keep" });
  const original = await f.source.get("siteConfig", "global");
  assert.equal((await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: "Denied" }, "service")).status, 403);
  assert.equal((await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: "Denied" }, null)).status, 401);
  assert.deepEqual(await f.source.get("siteConfig", "global"), original);
  assert.equal((await f.request("/api/doc/siteConfig/global", { bookingSuccessTips: "Admin tips" }, "admin")).status, 200);
});

test("success tips survive the existing normalized MySQL split and hydration without a migration", () => {
  const schema = require("../lib/mysqlSchema.cjs");
  for (const bookingSuccessTips of ["第一段\n\n第二段", ""]) {
    const split = schema.splitDocument("siteConfig", { id: "global", bookingSuccessTips });
    const restored = schema.hydrateDocument("siteConfig", { id: "global", ...split.columns }, { collection_values: split.attributes, ...split.relations });
    assert.equal(restored.bookingSuccessTips, bookingSuccessTips);
  }
});
