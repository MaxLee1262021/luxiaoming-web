"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const { createShareService, qrScene } = require("../lib/merchantShare.cjs");
const { fixture: shareSqlFixture, merchant } = require("./fixtures/shareSql.cjs");
const { projectShareScan, mergeScanRecords, readScanRecords } = require("../lib/scanRecords.cjs");

const fact = (id, merchantId = "m1", scanAt = "2026-11-12T16:30:00.000Z") => ({
  id, merchantId, qrId: `qr-${merchantId}`, scanAt,
  userId: "PRIVATE_VERIFIED_VISITOR", deviceId: "PRIVATE_DEVICE", clientScanAt: "2020-01-01T00:00:00Z", launchType: 1047,
});

test("share scan projection uses Shanghai server date and hour without exposing identity or client clocks", () => {
  const scan = projectShareScan(fact("7"));
  assert.equal(scan.date, "2026-11-13");
  assert.equal(scan.businessDate, "2026-11-13");
  assert.equal(scan.hour, 0);
  assert.equal(scan.scanTime, "2026-11-12T16:30:00.000Z");
  assert.equal(scan.visitorHash, crypto.createHash("sha256").update("PRIVATE_VERIFIED_VISITOR").digest("hex"));
  assert.equal(scan.visitorKind, "wechat");
  assert.equal(scan.shopId, "m1");
  assert.equal(scan.codeId, "qr-m1");
  assert.doesNotMatch(JSON.stringify(scan), /PRIVATE_|2020-01-01|userId|deviceId|clientScanAt/);
  assert.equal(projectShareScan(fact("8", "m1", "2026-11-13 23:15:00")).hour, 23);
});

test("merge keeps separate real visits and legacy identifiers while deduplicating an explicitly linked fact", () => {
  const facts = [fact("7"), fact("8"), fact("7")];
  const legacy = [
    { id: "7", shopId: "m1", date: "2026-11-10", visitorHash: "legacy" },
    { id: "old-mirror", shareScanId: "7" },
    { id: "share_scan:8", scanSource: "merchant_share" },
  ];
  const result = mergeScanRecords(legacy, facts);
  assert.deepEqual(result.map(row => row.id), ["share_scan:7", "share_scan:8", "7"]);
  assert.equal(new Set(result.filter(row => row.visitorKind === "wechat").map(row => row.visitorHash)).size, 1);
  assert.equal(legacy.length, 3, "reading never modifies the legacy list");
});

test("only an absent share schema uses legacy facts; storage failures cannot masquerade as zero new scans", async () => {
  const legacy = [{ id: "old", date: "2026-11-01" }];
  const source = { async list(key) { assert.equal(key, "scans"); return legacy; } };
  assert.deepEqual(await readScanRecords(source), legacy);
  const fail = code => ({ async listScanRecords() { throw Object.assign(new Error("test storage failure"), { code }); } });
  assert.deepEqual(await readScanRecords(source, fail("ER_NO_SUCH_TABLE")), legacy);
  await assert.rejects(readScanRecords(source, fail("ECONNRESET")), { code: "ECONNRESET" });
});

async function apiFixture(t) {
  const facts = [fact("7"), fact("8", "m2", "2026-11-13T01:00:00Z")];
  const rows = {
    staff: [
      { id: "admin", account: "admin", role: "super", status: "active" },
      { id: "channel", account: "channel", role: "distributor", distributorId: "d1", status: "active" },
    ],
    shops: [{ id: "m1", shopId: "m1", distributorId: "d1", status: "active" }, { id: "m2", shopId: "m2", distributorId: "d2", status: "active" }],
    scans: [{ id: "7", shopId: "m1", date: "2026-11-10", visitorHash: "legacy" }],
  };
  let writes = 0, failCode = "";
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async listMany(keys) { return Object.fromEntries(await Promise.all(keys.map(async key => [key, await source.list(key)]))); },
    async get(key, id) { return structuredClone((rows[key] || []).find(row => row.id === id) || null); },
    async create(key, row) { if (key === "logs") return row; writes++; throw Error("read must not create facts"); },
    async update() { writes++; throw Error("read must not update facts"); },
  };
  const store = { async listScanRecords() {
    if (failCode) throw Object.assign(new Error("test storage failure"), { code: failCode });
    return structuredClone(facts);
  } };
  const sessions = {
    admin: { kind: "admin", role: "super", subjectType: "staff", subjectId: "admin", account: "admin" },
    channel: { kind: "admin", role: "distributor", subjectType: "staff", subjectId: "channel", account: "channel", distributorId: "d1" },
    visitor: { kind: "public", openid: "PRIVATE_VERIFIED_VISITOR" },
  };
  const auth = { async init() {}, async getSession(token) { return structuredClone(sessions[token] || null); } };
  const handler = createApi(source, "json", { auth, shareOptions: { store }, logger: { info() {}, warn() {}, error() {} } });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return {
    facts, writes: () => writes, fail: code => { failCode = code; },
    async request(route, token = "admin", body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("collection, module and aggregate APIs share current real scan facts and retain channel authorization", async t => {
  const f = await apiFixture(t);
  const all = await f.request("/api/collection/scans");
  assert.equal(all.status, 200); assert.equal(all.body.length, 3);
  assert.deepEqual(all.body.map(row => row.id), ["share_scan:8", "share_scan:7", "7"]);
  assert.doesNotMatch(JSON.stringify(all.body), /PRIVATE_/);
  const own = await f.request("/api/collection/scans", "channel");
  assert.equal(own.status, 200); assert.deepEqual(own.body.map(row => row.shopId), ["m1", "m1"]);
  assert.equal((await f.request("/api/collection/scans/share_scan%3A8", "channel")).status, 404);
  assert.equal((await f.request("/api/collection/scans/share_scan%3A7", "channel")).body.shareScanId, "7");
  for (const module of ["dashboard", "operations"]) {
    const listed = await f.request(`/api/modules/${module}?keys=scans`, "channel");
    assert.equal(listed.status, 200); assert.equal(listed.body.collections.scans.length, 2);
  }
  assert.equal((await f.request("/api/dashboard", "channel")).body.scans, 2);
  assert.equal((await f.request("/api/rpc/getDashboard", "admin", {})).body.scans, 3);
  assert.equal((await f.request("/api/collection/scans", "")).status, 401);
  assert.equal((await f.request("/api/collection/scans", "visitor")).status, 401);
  f.facts.push(fact("9", "m1", "2026-11-13T02:00:00Z"));
  assert.equal((await f.request("/api/modules/dashboard?keys=scans")).body.collections.scans.length, 4);
  assert.equal((await f.request("/api/dashboard")).body.scans, 4);
  assert.equal(f.writes(), 0);
});

test("scan API exposes storage unavailability and supports pre-installation legacy records", async t => {
  const f = await apiFixture(t);
  f.fail("ECONNRESET");
  assert.equal((await f.request("/api/collection/scans")).status, 503);
  assert.equal((await f.request("/api/modules/dashboard?keys=scans")).status, 503);
  assert.equal((await f.request("/api/dashboard")).status, 503);
  f.fail("ER_NO_SUCH_TABLE");
  assert.equal((await f.request("/api/collection/scans")).body.length, 1);
  assert.equal((await f.request("/api/dashboard")).body.scans, 1);
  assert.equal(f.writes(), 0);
});

test("actual scan writes before commission activation reach dashboard modules without creating attribution bindings", async t => {
  const sql = shareSqlFixture();
  const store = sql.newStore();
  await store.ensureSchema();
  const scene = qrScene("ABCDEF123456");
  await store.onboardMerchant(merchant("m1", { qr: { id: "qr-m1", scene, imageUrl: "data:image/png;base64,iVBORw0KGgo=" } }));
  const rows = {
    staff: [{ id: "admin", role: "super", account: "admin", status: "active" }],
    shops: [{ id: "m1", shopId: "m1", name: "门店m1", status: "active" }],
    scans: [{ id: "old-scan", shopId: "m1", date: "2026-11-01" }],
  };
  const source = {
    ...sql.source,
    async list(key) { return structuredClone(rows[key] || []); },
    async listMany(keys) { return Object.fromEntries(await Promise.all(keys.map(async key => [key, await source.list(key)]))); },
    async get(key, id) { return structuredClone((rows[key] || []).find(row => row.id === id) || null); },
  };
  let at = "2026-11-12T16:30:00.000Z";
  const service = createShareService(source, { store, enableAt: "2099-01-01T00:00:00Z", clock: () => new Date(at) });
  const identity = { kind: "public", openid: "PRIVATE_SQL_VISITOR" };
  sql.setTime(at);
  const first = await service.reportScan(identity, { scene, launchType: 1, requestKey: "actual-visit-1" });
  assert.equal(first.recorded, true);
  const retry = await service.reportScan(identity, { scene, launchType: 1, requestKey: "actual-visit-1" });
  assert.equal(retry.deduped, true);
  at = "2026-11-12T16:30:07.000Z"; sql.setTime(at);
  assert.equal((await service.reportScan(identity, { scene, launchType: 2, requestKey: "actual-visit-2" })).recorded, true);
  assert.equal(sql.tables().scan.length, 2);
  assert.equal(sql.tables().binding.length, 0);
  assert.equal(sql.tables().binding_event.length, 0);
  const stats = await store.getMerchantStats("m1");
  assert.equal(stats.scanCount, 2);
  assert.deepEqual(stats.dailyScans, [{ date: "2026-11-13", count: 2 }]);

  const auth = { async init() {}, async getSession() { return { kind: "admin", role: "super", subjectId: "admin", subjectType: "staff", account: "admin" }; } };
  const handler = createApi(source, "json", { auth, shareService: service, logger: { info() {}, warn() {}, error() {} } });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async route => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { Authorization: "Bearer TEST_ONLY" } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const module = await request("/api/modules/dashboard?keys=scans");
  assert.equal(module.collections.scans.length, 3);
  assert.equal(module.collections.scans.filter(row => row.businessDate === "2026-11-13").length, 2);
  assert.equal((await request("/api/dashboard")).scans, 3);
  assert.equal((await request("/api/collection/scans")).length, 3);
  module.collections.scans[0].shopId = "browser-change";
  assert.equal((await store.listScanRecords())[0].merchantId, "m1");
  assert.equal(sql.tables().scan.length, 2, "viewing and refreshing statistics never writes scans");
  assert.equal(sql.tables().binding_event.length, 0);
  assert.equal(rows.scans.length, 1, "the bridge does not copy share facts into legacy storage");
});
