"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");

async function fixture(t) {
  const rows = { staff: [{ id: "admin", account: "admin", role: "super", status: "active" },
    { id: "editor", account: "editor", role: "content", status: "active" }, { id: "service", account: "service", role: "service", status: "active" }],
    albums: [{ id: "photo", name: "Test photo", tags: ["测试标签"], price: 100, isShow: false, depositRate: 80 }],
    packages: [{ id: "video", name: "Test video", tags: ["测试标签"], price: 100, type: "video", productKind: "video_single", isShow: false, depositPercent: 80 }], logs: [] };
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

test("privacy settings save independently, record the server time and reach the public RPC", async t => {
  const f = await fixture(t);
  const before = Date.now();
  const result = await f.request("/api/doc/siteConfig/global", { privacyPolicy: {
    title: " 测试隐私标题 ", content: " 第一段\r\n\r\n· 第二段 ", updateTime: "client-supplied-time"
  } }, "editor");
  assert.equal(result.status, 200, JSON.stringify(result));
  const saved = await f.source.get("siteConfig", "global");
  assert.equal(saved.privacyPolicy.title, "测试隐私标题");
  assert.equal(saved.privacyPolicy.content, "第一段\n\n· 第二段");
  assert.equal(saved.privacyText, saved.privacyPolicy.content);
  assert.deepEqual(saved.privacyPolicy.sections, []);
  assert.ok(Date.parse(saved.privacyPolicy.updateTime) >= before && Date.parse(saved.privacyPolicy.updateTime) <= Date.now());
  assert.equal(Object.hasOwn(saved, "customPrice"), false);
  assert.equal(Object.hasOwn(saved, "bookingNotice"), false);
  const exposed = (await rpc(f.source, "getPrivacyPolicy", {})).data;
  assert.deepEqual(exposed, { title: saved.privacyPolicy.title, content: saved.privacyText, updateTime: saved.privacyPolicy.updateTime });
  const module = await f.request("/api/modules/bookingConfig?keys=siteConfig", undefined, "editor");
  assert.deepEqual(module.body.collections.siteConfig.privacyPolicy, saved.privacyPolicy);
  assert.equal((await f.request("/api/doc/siteConfig/global", { privacyPolicy: { title: "Denied", content: "Denied" } }, "service")).status, 403);
  assert.deepEqual(await f.source.get("siteConfig", "global"), saved);
});

test("privacy text replaces stale sections and preserves the booking draft and unrelated settings", async t => {
  const f = await fixture(t);
  await f.source.create("siteConfig", { id: "global", customPrice: { depositRatio: 0.3, extension: "keep" },
    bookingNotice: ["Terms"], bookingNoticeVersion: "v1", search: { hotwords: ["keep"] },
    wechat: { corpSecret: "TEST_ONLY_SECRET" }, privacyText: "Legacy policy", privacyPolicy: {
      title: "Old", sections: [{ title: "Old section", paragraphs: ["Old paragraph"] }]
    } });
  const result = await f.request("/api/doc/siteConfig/global", { privacyPolicy: { title: "New title", content: "New body" } }, "editor");
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(JSON.stringify(result.body).includes("TEST_ONLY_SECRET"), false);
  const saved = await f.source.get("siteConfig", "global");
  assert.deepEqual(saved.customPrice, { depositRatio: 0.3, extension: "keep" });
  assert.deepEqual(saved.bookingNotice, ["Terms"]); assert.equal(saved.bookingNoticeVersion, "v1");
  assert.deepEqual(saved.search.hotwords, ["keep"]); assert.equal(saved.wechat.corpSecret, "TEST_ONLY_SECRET");
  assert.deepEqual(saved.privacyPolicy.sections, []);
  assert.equal((await rpc(f.source, "getPrivacyPolicy", {})).data.content, "New body");
  // Later booking saves must not replace the independently saved policy.
  assert.equal((await f.request("/api/doc/siteConfig/global", { customPrice: { depositRatio: 0.5 } }, "editor")).status, 200);
  assert.deepEqual((await f.source.get("siteConfig", "global")).privacyPolicy, saved.privacyPolicy);
});

test("invalid privacy drafts are rejected before changing any persisted settings", async t => {
  const f = await fixture(t);
  await f.source.create("siteConfig", { id: "global", privacyText: "Existing body", search: { hotwords: ["keep"] } });
  const original = await f.source.get("siteConfig", "global");
  for (const privacyPolicy of [null, [], "body", {}, { title: " ", content: "body" },
    { title: "x".repeat(129), content: "body" }, { title: "Title", content: " " },
    { title: "Title", content: [] }, { title: "Title", content: "x".repeat(20001) }]) {
    const result = await f.request("/api/doc/siteConfig/global", { privacyPolicy, search: { hotwords: ["must not save"] } }, "editor");
    assert.equal(result.status, 400, JSON.stringify(privacyPolicy));
    assert.deepEqual(await f.source.get("siteConfig", "global"), original);
  }
  assert.equal((await f.request("/api/doc/siteConfig/global", { privacyPolicy: { title: "x".repeat(128), content: "文".repeat(20000) } }, "editor")).status, 200);
});

test("privacy reads support legacy text and structured sections while explicit canonical text wins", async t => {
  const f = await fixture(t);
  assert.equal((await rpc(f.source, "getPrivacyPolicy", {})).data.content, "");
  await f.source.create("siteConfig", { id: "global", privacyText: "Legacy body" });
  assert.equal((await rpc(f.source, "getPrivacyPolicy", {})).data.content, "Legacy body");
  const sections = [{ title: "Heading", paragraphs: ["Paragraph"], secretToken: "TEST_ONLY_SECRET" }, { title: "Content shape", content: "Paragraph 2" }];
  await f.source.update("siteConfig", "global", { privacyPolicy: { title: "Structured", sections } });
  const structured = (await rpc(f.source, "getPrivacyPolicy", {})).data;
  assert.equal(structured.content, "");
  assert.deepEqual(structured.sections, [{ title: "Heading", paragraphs: ["Paragraph"] }, { title: "Content shape", content: "Paragraph 2" }]);
  await f.source.update("siteConfig", "global", { privacyPolicy: { title: "Canonical", content: "Current body", sections } });
  const canonical = (await rpc(f.source, "getPrivacyPolicy", {})).data;
  assert.equal(canonical.content, "Current body"); assert.equal(Object.hasOwn(canonical, "sections"), false);
  await f.source.update("siteConfig", "global", { privacyPolicy: { title: "Empty canonical", content: "", sections } });
  const empty = (await rpc(f.source, "getPrivacyPolicy", {})).data;
  assert.equal(empty.content, ""); assert.equal(Object.hasOwn(empty, "sections"), false);
});

test("privacy settings survive the normalized MySQL split and hydration contract", async () => {
  const schema = require("../lib/mysqlSchema.cjs");
  const policy = { title: "测试标题", content: "正文第一段\n正文第二段", updateTime: "2026-11-17T02:00:00.000Z", sections: [] };
  const split = schema.splitDocument("siteConfig", { id: "global", privacyPolicy: policy, privacyText: policy.content });
  const restored = schema.hydrateDocument("siteConfig", { id: "global", ...split.columns }, { collection_values: split.attributes, ...split.relations });
  assert.equal(restored.privacyText, policy.content); assert.deepEqual(restored.privacyPolicy, policy);
});
