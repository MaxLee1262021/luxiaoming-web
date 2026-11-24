"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rpc = require("../lib/rpc.cjs");
const { createFileService } = require("../lib/fileService.cjs");
const { memoryFixture, startHttp } = require("./read-projection-batch-fixture.cjs");

function metadataReads(fixture) { return fixture.reads.filter(read => read.key === "mediaFiles"); }
function metadataIds(fixture) { return metadataReads(fixture).flatMap(read => read.ids || []); }

test("admin module shares metadata across records and collections without changing projection order or stored rows", async t => {
  const f = memoryFixture();
  const before = structuredClone(f.rows);
  const { request } = await startHttp(t, f);
  const result = await request("/api/modules/orders?keys=orders,afterSales");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.collections.orders.map(row => row.id), before.orders.map(row => row.id));
  const order = result.body.collections.orders[0];
  assert.deepEqual(order.deliverFiles.map(row => row.fileId), f.fileIds.slice(0, 2));
  assert.equal(order.deliverFiles[0].name, "recorded-name.png", "recorded descriptor fields still override metadata");
  assert.equal(order.deliverFiles[1].name, "stored-1.png");
  assert.equal(order.deliveryDraftFiles[0].fileId, f.fileIds[2]);
  assert.equal(result.body.collections.afterSales[0].internalAttachments[0].fileId, f.fileIds[3]);
  assert.deepEqual(metadataIds(f).sort(), f.fileIds.slice().sort(), "each unique descriptor is fetched once inside the response");
  assert.ok(metadataReads(f).every(read => read.method === "getMany"), "metadata lookups use the batched adapter when available");
  assert.deepEqual(f.rows, before, "read projection leaves the source documents unchanged");
});

test("legacy collection reads retain fresh metadata on the next request and keep fallback adapters working", async t => {
  const f = memoryFixture(3, { batched: false });
  const { request } = await startHttp(t, f);
  let result = await request("/api/collection/orders");
  assert.equal(result.status, 200);
  assert.deepEqual(metadataIds(f).sort(), f.fileIds.slice(0, 3).sort());
  f.rows.mediaFiles[1].name = "updated.png";
  f.reads.length = 0;
  result = await request("/api/collection/orders");
  assert.equal(result.body[0].deliverFiles[1].name, "updated.png");
  assert.deepEqual(metadataIds(f).sort(), f.fileIds.slice(0, 3).sort(), "later HTTP requests read the source again");
});

test("denied admin module keys do not resolve private file metadata", async t => {
  const f = memoryFixture();
  const { request } = await startHttp(t, f);
  const result = await request("/api/modules/orders?keys=orders,afterSales", "content");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.collections, {});
  assert.deepEqual(metadataReads(f), []);
});

test("public order list batches only visible delivery metadata and preserves owner scope and pagination", async () => {
  const f = memoryFixture(24);
  const before = structuredClone(f.rows);
  const context = { identity: { kind: "public", openid: "customer" }, files: f.files };
  const result = await rpc(f.source, "getMyOrders", { page: 2, pageSize: 7 }, context);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.total, 24);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 7);
  assert.deepEqual(result.data.map(row => row.id), [16, 15, 14, 13, 12, 11, 10].map(id => `order-${id}`));
  assert.ok(result.data.every(row => row.deliveryDraftFileIds === undefined));
  assert.deepEqual(result.data[0].deliverFiles.map(row => row.fileId), f.fileIds.slice(0, 2));
  assert.deepEqual(metadataIds(f).sort(), f.fileIds.slice(0, 2).sort());
  assert.ok(metadataReads(f).every(read => read.method === "getMany"));
  assert.deepEqual(f.rows, before);
});

test("public after-sale projection shares evidence metadata but never loads internal evidence", async () => {
  const f = memoryFixture();
  const context = { identity: { kind: "public", openid: "customer" }, files: f.files };
  const result = await rpc(f.source, "getMyAfterSales", { orderId: "order-0" }, context);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(result.data.map(row => row.id), ["ticket-1", "ticket-2", "internal-ticket"]);
  assert.deepEqual(result.data[0].attachments.map(row => row.fileId), f.fileIds.slice(0, 2));
  assert.deepEqual(result.data[1].attachments.map(row => row.fileId), f.fileIds.slice(0, 2).reverse());
  assert.deepEqual(result.data[2].attachments, []);
  assert.equal(result.data[2].reason, "");
  assert.deepEqual(metadataIds(f).sort(), f.fileIds.slice(0, 2).sort());
  assert.ok(!JSON.stringify(result).includes("private/"));
  f.reads.length = 0;
  const denied = await rpc(f.source, "getMyAfterSales", { orderId: "foreign" }, context);
  assert.equal(denied.success, false);
  assert.deepEqual(metadataReads(f), []);
});

test("injected read-only descriptor services retain their receiver and may ignore the optional source", async t => {
  const f = memoryFixture(3);
  const calls = [];
  const files = Object.freeze({
    async describe(id) {
      assert.equal(this, files);
      calls.push(id);
      return { id, fileId: id, name: "custom.png", type: "image", size: 128 };
    },
  });
  const { request } = await startHttp(t, f, undefined, { fileService: files });
  const admin = await request("/api/collection/orders");
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.deepEqual(calls.slice().sort(), f.fileIds.slice(0, 3).sort());
  calls.length = 0;
  const result = await rpc(f.source, "getMyOrders", { pageSize: 3 }, { identity: { kind: "public", openid: "customer" }, files });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls.slice().sort(), f.fileIds.slice(0, 2).sort());
});

test("read-scoped descriptions preserve missing/deleted validation while file authorization keeps live reads", async () => {
  const f = memoryFixture();
  let projectionReads = 0;
  let authorizations = 0;
  const files = createFileService({ source: f.source, adapter: { async signRead() { return { url: "https://files.invalid/signed" }; } },
    async authorize() { authorizations++; return true; } });
  const readSource = { async get(key, id) { projectionReads++; return f.source.get(key, id); } };
  await files.describe(f.fileIds[0], readSource);
  assert.equal(projectionReads, 1);
  f.rows.mediaFiles[0].status = "deleted";
  await assert.rejects(files.access({ kind: "admin", subjectId: "super" }, f.fileIds[0]), error => error.statusCode === 404);
  assert.equal(authorizations, 0);
  assert.equal(projectionReads, 1, "access never reuses a description's read source");
  await assert.rejects(files.describe(f.fileIds[0], readSource), error => error.statusCode === 404);
  await assert.rejects(files.describe(`file_${"f".repeat(40)}`, readSource), error => error.statusCode === 404);
  const beforeInvalid = projectionReads;
  await assert.rejects(files.describe("invalid-file", readSource), error => error.statusCode === 404);
  assert.equal(projectionReads, beforeInvalid, "invalid identifiers never reach the source");
});

test("separate concurrent HTTP responses do not share an in-flight metadata cache", async t => {
  const f = memoryFixture(1);
  const { request } = await startHttp(t, f);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let reads = 0;
  f.setReadHook(async key => { if (key === "mediaFiles" && ++reads === 1) { started(); await held; } });
  const firstPending = request("/api/collection/orders");
  await firstStarted;
  try {
    f.rows.mediaFiles[2].name = "new-draft.png";
    const second = await request("/api/collection/orders");
    assert.equal(second.status, 200);
    assert.equal(second.body[0].deliveryDraftFiles[0].name, "new-draft.png");
  } finally { release(); }
  const first = await firstPending;
  assert.equal(first.status, 200);
  assert.equal(first.body[0].deliveryDraftFiles[0].name, "stored-2.png");
  assert.equal(metadataIds(f).filter(id => id === f.fileIds[2]).length, 2);
});
