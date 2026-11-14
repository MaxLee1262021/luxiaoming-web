"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");

async function fixture(t) {
  const rows = { staff: [{ id: "admin", account: "admin", role: "super", status: "active" },
    { id: "editor", account: "editor", role: "content", status: "active" }, { id: "service", account: "service", role: "service", status: "active" }],
    albums: [{ id: "photo", name: "Test photo", price: 100, isShow: false, depositRate: 80 }],
    packages: [{ id: "video", name: "Test video", price: 100, type: "video", productKind: "video_single", isShow: false, depositPercent: 80 }], logs: [] };
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
  const request = async (path, body, token = "admin") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? "GET" : "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { source, rows, request };
}

test("new booking configuration can be created from an empty authorized module and read by the mini-program", async t => {
  const f = await fixture(t);
  const initial = await f.request("/api/modules/bookingConfig?keys=siteConfig", undefined, "editor");
  assert.equal(initial.status, 200); assert.deepEqual(initial.body.collections.siteConfig, {});
  const ungranted = await f.request("/api/modules/bookingConfig?keys=siteConfig", undefined, "service");
  assert.ok(!Object.hasOwn(ungranted.body.collections, "siteConfig")); assert.ok(ungranted.body.skippedKeys.includes("siteConfig"));
  const result = await f.request("/api/doc/siteConfig/global", { customPrice: { single: null, extraPerPerson: null, depositRatio: 0.3 }, bookingNotice: [" Booking terms "], bookingNoticeVersion: " v1 " }, "editor");
  assert.equal(result.status, 200, JSON.stringify(result));
  const config = (await rpc(f.source, "getBookingConfig", {})).data;
  assert.equal(config.depositRatio, 0.3); assert.equal(config.bookingNoticeVersion, "v1"); assert.equal(config.bookingNotice, "1. Booking terms");
  assert.deepEqual(config.customPrice, { single: null, extraPerPerson: null });
  const denied = await f.request("/api/doc/siteConfig/global", { customPrice: { depositRatio: 0.8 } }, "service");
  assert.equal(denied.status, 403);
});

test("booking configuration patches preserve unrelated fields and clear price aliases without leaking integration secrets", async t => {
  const f = await fixture(t);
  await f.source.create("siteConfig", { id: "global", customPrice: { singlePersonPrice: 200, perExtraPerson: 80, extension: "keep" },
    search: { hotwords: ["keep"] }, wechat: { corpSecret: "TEST_ONLY_SECRET", guideText: "keep" }, bookingNotice: ["Terms"], bookingNoticeVersion: "v1" });
  const result = await f.request("/api/doc/siteConfig/global", { customPrice: { single: null, extraPerPerson: 0, depositRatio: 0.01 } }, "editor");
  assert.equal(result.status, 200, JSON.stringify(result)); assert.ok(!JSON.stringify(result.body).includes("TEST_ONLY_SECRET"));
  const saved = await f.source.get("siteConfig", "global");
  assert.deepEqual(saved.search.hotwords, ["keep"]); assert.equal(saved.wechat.corpSecret, "TEST_ONLY_SECRET");
  assert.equal(saved.customPrice.extension, "keep"); assert.equal(saved.customPrice.singlePersonPrice, null); assert.equal(saved.customPrice.perExtraPerson, 0);
  const config = (await rpc(f.source, "getBookingConfig", {})).data;
  assert.deepEqual(config.customPrice, { single: null, extraPerPerson: 0 }); assert.equal(config.depositRatio, 0.01);
  assert.equal((await f.request("/api/doc/siteConfig/global", { wechat: { corpSecret: "replacement" } }, "editor")).status, 403);
});

test("booking config validates ranges and notice versions before changing persisted data", async t => {
  const f = await fixture(t);
  const initial = { customPrice: { depositRatio: 0.3 }, bookingNotice: ["Terms"], bookingNoticeVersion: "v1" };
  assert.equal((await f.request("/api/doc/siteConfig/global", initial)).status, 200);
  const original = await f.source.get("siteConfig", "global");
  for (const invalid of [{ customPrice: { depositRatio: null } }, { customPrice: { depositRatio: false } }, { customPrice: { depositRatio: 101 } }, { customPrice: { single: -1 } }, { customPrice: { single: 0 } },
    { bookingNotice: [] }, { bookingNoticeVersion: "" }, { bookingNotice: ["Changed"], bookingNoticeVersion: "v1" }]) {
    const result = await f.request("/api/doc/siteConfig/global", invalid);
    assert.equal(result.status, 400, JSON.stringify(invalid)); assert.deepEqual(await f.source.get("siteConfig", "global"), original);
  }
  assert.equal((await f.request("/api/doc/siteConfig/global", { bookingNotice: ["Changed"], bookingNoticeVersion: "v2" })).status, 200);
});

test("photo and video deposit overrides round-trip canonical fractions, retain zero and clear legacy overrides", async t => {
  const f = await fixture(t);
  for (const [key, id] of [["albums", "photo"], ["packages", "video"]]) {
    const path = `/api/collection/${key}/${id}`;
    for (const value of [0.01, 0, null, ""]) {
      const result = await f.request(path, { depositRatio: value }, "editor");
      assert.equal(result.status, 200, JSON.stringify(result));
      const saved = await f.source.get(key, id);
      assert.equal(saved.depositRatio, value === "" ? null : value); assert.equal(saved.depositRate, null); assert.equal(saved.depositPercent, null); assert.equal(saved.depositPercentage, null);
    }
    const before = await f.source.get(key, id);
    for (const depositRatio of [-1, 101, false, [], "NaN"]) {
      assert.equal((await f.request(path, { depositRatio })).status, 400); assert.deepEqual(await f.source.get(key, id), before);
    }
  }
});
