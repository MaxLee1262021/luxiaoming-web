"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFileService, validateInput, detectType } = require("../lib/fileService.cjs");
const { createOssStorage } = require("../lib/ossStorage.cjs");
const schema = require("../lib/mysqlSchema.cjs");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const user = { kind: "admin", subjectId: "editor", role: "content" };
const input = { purpose: "content", collection: "samples", fileName: "picture.png", mimeType: "image/png", size: png.length };
function setup() {
  const rows = new Map(); let now = new Date(); let bad = {};
  const source = {
    async get(_, id) { return rows.get(id) && { ...rows.get(id) }; },
    async create(_, a) { rows.set(a.id, { ...a }); return a; },
    async update(_, id, patch) { const r = { ...rows.get(id), ...patch }; rows.set(id, r); return r; },
    async compareAndUpdate(_, id, expected, patch) { if (rows.get(id).status !== expected.status) return null; return this.update(_, id, patch); },
  };
  const adapter = {
    allocation(id, ext, purpose) { return { bucket: "test", objectKey: `${purpose}/${id}.${ext}` }; },
    async signUpload() { return { uploadUrl: "https://test.oss.invalid", fields: {}, expiresAt: now.toISOString() }; },
    async inspect(a) { return { size: a.size, mimeType: a.mimeType, bytes: png, acl: "private", fileId: a.id, etag: "one", ...bad }; },
    async signRead(a, options) { return { url: `https://test.invalid/${a.id}?download=${!!options.download}`, expiresAt: now.toISOString() }; },
    async remove() {},
  };
  const service = createFileService({ source, adapter, clock: () => now,
    authorize: async (s, a) => s.subjectId === a.ownerId || (s.kind === "admin" && s.role === "super") });
  return { service, rows, setBad: v => { bad = v; }, advance: () => { now = new Date(now.getTime() + 25 * 3600000); } };
}
test("private storage V4 policy binds key, exact size, MIME and forbids overwrite without exposing secret", async () => {
  const secret = "synthetic-unit-test-secret";
  const adapter = createOssStorage({ env: { OSS_BUCKET: "unit-test", OSS_REGION: "cn-shanghai", OSS_ACCESS_KEY_ID: "test-id", OSS_ACCESS_KEY_SECRET: secret } });
  const id = `file_${"a".repeat(40)}`;
  const asset = { ...input, id, mimeType: input.mimeType, ...adapter.allocation(id, "png", "content") };
  const signed = await adapter.signUpload(asset);
  const policy = JSON.parse(Buffer.from(signed.fields.policy, "base64").toString());
  assert.match(signed.fields["x-oss-credential"], /\/cn-shanghai\/oss\/aliyun_v4_request$/);
  assert.ok(policy.conditions.some(c => c.key === asset.objectKey));
  assert.ok(policy.conditions.some(c => c["x-oss-forbid-overwrite"] === "true"));
  assert.ok(policy.conditions.some(c => c["x-oss-object-acl"] === "private"));
  assert.ok(policy.conditions.some(c => Array.isArray(c) && c[0] === "content-length-range" && c[1] === png.length && c[2] === png.length));
  assert.ok(!JSON.stringify(signed).includes(secret));
});
test("upload completion is idempotent; public URL is stable; bound files cannot be removed", async () => {
  const { service } = setup();
  const intent = await service.createIntent(user, input);
  const ready = await service.complete(user, intent.fileId);
  assert.equal(ready.url, `/api/media/${intent.fileId}`);
  assert.deepEqual(await service.complete(user, intent.fileId), ready);
  await service.assertFiles(user, [intent.fileId], { purpose: "content", collection: "samples" });
  await service.markBound([intent.fileId]);
  await assert.rejects(service.remove(user, intent.fileId), { code: "FILE_IN_USE" });
  assert.ok((await service.publicAccess(intent.fileId)).url);
});
test("permission checks apply to intent, completion, access and binding", async () => {
  const { service } = setup();
  await assert.rejects(service.createIntent(null, input), { code: "FILE_SESSION" });
  const { fileId } = await service.createIntent(user, input);
  const other = { kind: "admin", subjectId: "different" };
  await assert.rejects(service.complete(other, fileId), { code: "FILE_FORBIDDEN" });
  await assert.rejects(service.access(other, fileId), { code: "FILE_FORBIDDEN" });
  await service.complete(user, fileId);
  await assert.rejects(service.assertFiles(other, [fileId], { purpose: "content" }), { code: "FILE_FORBIDDEN" });
  await assert.rejects(service.assertFiles(user, [fileId], { purpose: "avatar" }), { code: "FILE_SCOPE" });
});
test("private completed objects never have anonymous URLs", async () => {
  const { service } = setup();
  const { fileId } = await service.createIntent(user, { ...input, purpose: "after-sale", orderId: "order-1" });
  const ready = await service.complete(user, fileId);
  assert.equal(ready.url, undefined);
  await assert.rejects(service.publicAccess(fileId), { code: "FILE_NOT_FOUND" });
  await assert.rejects(service.assertFiles(user, [fileId], { purpose: "after-sale", orderId: "order-2" }), { code: "FILE_SCOPE" });
});
test("validate actual bytes, metadata, size, ACL and expired/removed intents", async () => {
  for (const mismatch of [{ bytes: Buffer.from("<script>bad</script>") }, { acl: "public-read" }, { fileId: "other" }, { size: 1 }, { mimeType: "text/html" }]) {
    const { service, setBad } = setup(); const { fileId } = await service.createIntent(user, input); setBad(mismatch);
    await assert.rejects(service.complete(user, fileId), { code: "FILE_INVALID_CONTENT" });
    await assert.rejects(service.publicAccess(fileId), { code: "FILE_NOT_FOUND" });
  }
  const { service, advance } = setup(); const a = await service.createIntent(user, input); advance();
  await assert.rejects(service.complete(user, a.fileId), { code: "FILE_EXPIRED" });
  const b = await service.createIntent(user, input); await service.remove(user, b.fileId);
  await assert.rejects(service.complete(user, b.fileId), { code: "FILE_NOT_FOUND" });
});
test("reject invalid formats and limits, preserve file registry through normalized SQL mapping", () => {
  for (const mimeType of ["image/svg+xml", "text/html", "application/pdf", "image/gif"]) assert.throws(() => validateInput({ ...input, mimeType }), { code: "FILE_TYPE" });
  assert.throws(() => validateInput({ ...input, size: 21 * 1024 * 1024 }), { code: "FILE_SIZE" });
  assert.throws(() => validateInput({ ...input, purpose: "avatar", size: 6 * 1024 * 1024 }), { code: "FILE_SIZE" });
  assert.throws(() => validateInput({ ...input, purpose: "after-sale", mimeType: "video/mp4", orderId: "one" }), { code: "FILE_TYPE" });
  assert.equal(detectType(png), "image/png");
  const doc = { ...input, id: "file_sample", objectKey: "luxiaoming/prod/test.png", ownerId: "test", status: "ready" };
  const split = schema.splitDocument("mediaFiles", doc);
  assert.equal(split.columns.objectKey, doc.objectKey);
  assert.equal(split.columns.ownerId, doc.ownerId);
  assert.equal(schema.hydrateDocument("mediaFiles", { id: doc.id, ...split.columns }, { collection_values: split.attributes }).objectKey, doc.objectKey);
});
