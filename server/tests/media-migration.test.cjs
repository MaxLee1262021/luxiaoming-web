"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");
const { findMedia, sourceKind, isPublicAddress, inventory, applyManifest, rollbackManifest } = require("../lib/mediaMigration.cjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
function fixture() {
  const data = { spots: { one: { id: "one", name: "Keep", cover: dataUrl, sort: 12, latitude: 20 } },
    orders: { order1: { id: "order1", status: "delivered", deliveredAt: "2026-01-01", photos: [dataUrl] } },
    homeConfig: { home: { id: "home", homeBanners: [{ id: "one", url: dataUrl }, { id: "two", url: dataUrl }], exploreBanners: [{ id: "explore", url: dataUrl }] } } };
  const source = {
    async list(k) { return structuredClone(Object.values(data[k] || {})); },
    async get(k, id) { return structuredClone(data[k]?.[id] || null); },
    async create(k, doc) { (data[k] ||= {})[doc.id] = structuredClone(doc); return structuredClone(doc); },
    async update(k, id, patch) { Object.assign(data[k][id], structuredClone(patch)); return structuredClone(data[k][id]); },
    async compareAndUpdate(k, id, expected, patch) {
      if (!Object.entries(expected).every(([f, v]) => isDeepStrictEqual(data[k]?.[id]?.[f], v))) return null;
      return this.update(k, id, patch);
    },
  };
  let puts = 0; const objects = new Map();
  const adapter = {
    allocation(id, ext, purpose) { return { bucket: "test", objectKey: `${purpose}/${id}.${ext}` }; },
    async inspect(asset) { if (!objects.has(asset.id)) throw Object.assign(new Error(), { code: "FILE_MISSING" }); return { bytes: png, size: png.length, mimeType: "image/png", fileId: asset.id, sha256: asset.sha256, acl: "private" }; },
    async put(asset) { puts++; objects.set(asset.id, true); },
  };
  return { data, source, adapter, puts: () => puts };
}
test("inventory limits itself to media paths and classifies unrecoverable SVG/temporary URLs", () => {
  const doc = { id: "one", cover: dataUrl, url: "https://business.example/info", navigation: { url: "/pages/something" }, statusLogs: [{ cover: dataUrl }] };
  assert.deepEqual(findMedia("spots", doc).map(e => e.path), [["cover"]]);
  assert.equal(sourceKind("data:image/svg+xml;utf8,%3Csvg%3E"), "placeholder-svg");
  assert.equal(sourceKind("blob:http://localhost/file"), "unrecoverable-local");
  assert.equal(sourceKind("wxfile://temp.png"), "unrecoverable-local");
  assert.equal(sourceKind("线下凭证001"), "identifier");
});
test("migration preserves non-media fields and banner ordering; private references never become public URLs", async () => {
  const { source, adapter, data, puts } = fixture(); const manifest = await inventory(source);
  await applyManifest(source, adapter, manifest);
  assert.equal(data.spots.one.name, "Keep"); assert.equal(data.spots.one.latitude, 20);
  assert.match(data.spots.one.cover, /^\/api\/media\/file_/);
  assert.equal(data.orders.order1.status, "delivered"); assert.equal(data.orders.order1.deliveredAt, "2026-01-01");
  assert.match(data.orders.order1.photos[0], /^oss-file:file_/);
  assert.deepEqual(data.homeConfig.home.homeBanners.map(b => b.id), ["one", "two"]);
  const uploaded = puts(); await applyManifest(source, adapter, manifest); assert.equal(puts(), uploaded);
  assert.ok(manifest.entries.every(e => e.status === "migrated"));
  await rollbackManifest(source, manifest); assert.equal(data.spots.one.cover, dataUrl); assert.equal(data.orders.order1.photos[0], dataUrl);
  assert.equal(puts(), uploaded);
});
test("failed uploads retain old values and a resumable manifest", async () => {
  const { source, adapter, data } = fixture(); const manifest = await inventory(source);
  const originalPut = adapter.put; adapter.put = async () => { throw Object.assign(new Error(), { code: "FILE_STORAGE" }); };
  await applyManifest(source, adapter, manifest);
  assert.equal(data.spots.one.cover, dataUrl); assert.ok(manifest.entries.every(e => e.status === "failed"));
  adapter.put = originalPut; await applyManifest(source, adapter, manifest);
  assert.match(data.spots.one.cover, /^\/api\/media/); assert.ok(manifest.entries.every(e => e.status === "migrated"));
});
test("migration and rollback refuse to overwrite concurrent media edits", async () => {
  const { source, adapter, data } = fixture(); const manifest = await inventory(source);
  const originalCAS = source.compareAndUpdate.bind(source);
  source.compareAndUpdate = async (k, id, expected, patch) => { if (k === "spots") data.spots.one.cover = "https://new.example/edited.png"; return originalCAS(k, id, expected, patch); };
  await applyManifest(source, adapter, manifest);
  assert.equal(data.spots.one.cover, "https://new.example/edited.png");
  assert.equal(manifest.entries.find(e => e.collection === "spots").status, "conflict");
  data.orders.order1.photos = ["customer-new-photo"];
  await rollbackManifest(source, manifest);
  assert.deepEqual(data.orders.order1.photos, ["customer-new-photo"]);
});
test("private/local/link-local/reserved source addresses are blocked", () => {
  for (const address of ["127.0.0.1", "10.1.1.1", "192.168.0.1", "172.16.4.1", "169.254.169.254", "100.100.100.200", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
});

test("unclassified order and trash media never becomes anonymous content", async () => {
  const order = { id: "private-order", image: dataUrl, customer: { avatarUrl: dataUrl }, photos: [dataUrl],
    productItems: [{ cover: dataUrl }] };
  const entries = findMedia("orders", order);
  assert.equal(entries.find(e => e.path.join(".") === "image").status, "needs-review");
  assert.equal(entries.find(e => e.path.join(".") === "customer.avatarUrl").status, "needs-review");
  assert.equal(entries.find(e => e.path.join(".") === "photos.0").purpose, "order-delivery");
  assert.equal(entries.find(e => e.path.join(".") === "productItems.0.cover").purpose, "content");
  const trash = findMedia("trash", { id: "trash-private", cover: dataUrl, sourceKey: "orders", source: order });
  assert.equal(trash.find(e => e.path.join(".") === "cover").status, "needs-review");
  assert.equal(trash.find(e => e.path.join(".") === "source.photos.0").purpose, "order-delivery");
  const f = fixture();
  f.data.orders[order.id] = order;
  const manifest = await inventory(f.source);
  await applyManifest(f.source, f.adapter, manifest);
  assert.equal(f.data.orders[order.id].image, dataUrl);
  assert.equal(f.data.orders[order.id].customer.avatarUrl, dataUrl);
  assert.match(f.data.orders[order.id].photos[0], /^oss-file:/);
});

test("resume finds a pending asset inserted before the first manifest checkpoint and retains its allocation", async () => {
  const f = fixture();
  const manifest = await inventory(f.source);
  manifest.entries = manifest.entries.filter(e => e.collection === "spots");
  const checkpoint = structuredClone(manifest);
  let saved = false;
  await applyManifest(f.source, f.adapter, manifest, { save: async () => {
    if (!saved) { saved = true; throw new Error("simulate_checkpoint_failure"); }
  } });
  const asset = Object.values(f.data.mediaFiles)[0];
  const originalKey = asset.objectKey;
  f.adapter.allocation = (id, ext, purpose) => ({ bucket: "test", objectKey: `next-month/${purpose}/${id}.${ext}` });
  const originalPut = f.adapter.put;
  const uploadKeys = [];
  f.adapter.put = async (entry) => { uploadKeys.push(entry.objectKey); return originalPut(entry); };
  await applyManifest(f.source, f.adapter, checkpoint);
  assert.deepEqual(uploadKeys, [originalKey]);
  assert.equal(f.data.mediaFiles[asset.id].objectKey, originalKey);
  assert.equal(checkpoint.entries[0].status, "migrated");
  assert.equal(f.data.spots.one.cover, `/api/media/${asset.id}`);
});

test("rollback resumes after its database commit without reporting a false conflict", async () => {
  const f = fixture();
  const manifest = await inventory(f.source);
  manifest.entries = manifest.entries.filter(e => e.collection === "spots");
  await applyManifest(f.source, f.adapter, manifest);
  const persistedBeforeRollback = structuredClone(manifest);
  await assert.rejects(rollbackManifest(f.source, manifest, async () => { throw new Error("checkpoint-interrupted"); }), /checkpoint-interrupted/);
  assert.equal(f.data.spots.one.cover, dataUrl);
  f.data.spots.one.name = "New unrelated customer edit";
  await rollbackManifest(f.source, persistedBeforeRollback);
  assert.equal(persistedBeforeRollback.records[0].status, "rolled-back");
  assert.equal(persistedBeforeRollback.entries[0].status, "rolled-back");
  assert.equal(f.data.spots.one.name, "New unrelated customer edit");
});

test("rollback of a prepared checkpoint marks verified entries restored and cannot reapply them on resume", async () => {
  const f = fixture();
  const manifest = await inventory(f.source);
  manifest.entries = manifest.entries.filter(e => e.collection === "spots");
  const originalCAS = f.source.compareAndUpdate.bind(f.source);
  f.source.compareAndUpdate = async (...args) => {
    const result = await originalCAS(...args);
    if (args[0] === "spots") throw new Error("crash-after-business-commit");
    return result;
  };
  await assert.rejects(applyManifest(f.source, f.adapter, manifest), /crash-after-business-commit/);
  assert.equal(manifest.records[0].status, "prepared");
  assert.equal(manifest.entries[0].status, "verified");
  f.source.compareAndUpdate = originalCAS;
  await rollbackManifest(f.source, manifest);
  assert.equal(manifest.entries[0].status, "rolled-back");
  assert.equal(f.data.spots.one.cover, dataUrl);
  await applyManifest(f.source, f.adapter, manifest);
  assert.equal(f.data.spots.one.cover, dataUrl);
});

test("resume rejects reuse of another record's migrated asset", async () => {
  const f = fixture();
  const manifest = await inventory(f.source);
  const pending = structuredClone(manifest);
  await applyManifest(f.source, f.adapter, manifest);
  const spotAsset = manifest.entries.find(e => e.collection === "spots").assetId;
  const entry = pending.entries.find(e => e.collection === "orders");
  pending.entries = [entry];
  entry.assetId = spotAsset;
  f.data.orders.order1.photos = [dataUrl];
  await applyManifest(f.source, f.adapter, pending);
  assert.equal(entry.status, "failed");
  assert.equal(entry.error, "migration_asset_scope_mismatch");
  assert.equal(f.data.orders.order1.photos[0], dataUrl);
});
