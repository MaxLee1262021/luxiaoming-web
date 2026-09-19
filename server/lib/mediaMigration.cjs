"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const { isDeepStrictEqual } = require("util");
const { detectType } = require("./fileService.cjs");

const PUBLIC_COLLECTIONS = new Set(["cities", "shops", "spots", "series", "albums", "samples", "packages", "peripherals", "guides", "stories", "merchantCodes", "homeConfig", "siteConfig", "config"]);
const COLLECTIONS = [...PUBLIC_COLLECTIONS, "orders", "afterSales", "adjustmentRecords", "userProfiles", "trash"];
const MEDIA_FIELDS = new Set(["cover", "coverUrl", "image", "imageUrl", "imgUrl", "videoUrl", "previewVideoUrl", "poster", "thumbnail", "thumb", "avatarUrl", "qrImage", "logo", "fileID", "fileId"]);
const MEDIA_ARRAYS = new Set(["images", "photos", "sampleUrls", "deliverFiles", "attachments"]);
const URL_CONTAINERS = /(?:^|\.)(?:banners|homeBanners|exploreBanners|samples|photos|images|deliverFiles|attachments)(?:\.|$)/;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));

function sourceKind(value) {
  if (/^\/api\/media\/file_|^oss-file:file_/.test(value)) return "already";
  if (/^data:image\/svg\+xml/i.test(value)) return "placeholder-svg";
  if (/^data:/i.test(value)) return "data";
  if (/^(?:blob:|wxfile:|file:|[a-z]:[\\/])/i.test(value)) return "unrecoverable-local";
  if (/^cloud:\/\//i.test(value)) return "cloud";
  if (/^https?:\/\//i.test(value)) return "http";
  if (/^(?:\/?(?:public|images|uploads|assets)\/|\.\.?\/)/.test(value)) return "local";
  return "identifier";
}

function findMedia(collection, document) {
  const entries = [];
  function walk(value, parts = [], context = document, logicalCollection = collection) {
    if (parts.length > 24) return;
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor", "logs", "statusLogs", "followRecords", "snapshotText", "password", "token", "secret", "openid", "_openid"].includes(key)) continue;
      const fieldPath = [...parts, key];
      const arrayParent = Array.isArray(value) ? parts[parts.length - 1] : "";
      const isUrl = key === "url" && (logicalCollection === "samples" || URL_CONTAINERS.test(parts.join(".")));
      if (typeof item === "string" && item.trim() && (MEDIA_FIELDS.has(key) || MEDIA_ARRAYS.has(arrayParent) || isUrl || (logicalCollection === "adjustmentRecords" && key === "attachment"))) {
        const kind = sourceKind(item);
        if (kind === "identifier" || kind === "already") continue;
        let purpose = "content";
        let requiresReview = false;
        const joined = fieldPath.join(".");
        if (logicalCollection === "userProfiles") purpose = "avatar";
        else if (logicalCollection === "orders") {
          purpose = "order-delivery";
          if (!/(?:^|\.)(?:deliverFiles|photos)(?:\.|$)/.test(joined)) {
            // Product snapshots copy already-public catalogue artwork. Unknown
            // order media can contain customer evidence and must never become
            // anonymous content merely because its field is named "image".
            if (/(?:^|\.)(?:products|productItems|items|packageSnapshot)(?:\.|$)/.test(joined)) purpose = "content";
            else requiresReview = true;
          }
        }
        else if (logicalCollection === "afterSales") purpose = "after-sale";
        else if (logicalCollection === "adjustmentRecords") purpose = "finance";
        else if (!PUBLIC_COLLECTIONS.has(logicalCollection)) requiresReview = true;
        const recordId = String(document.id || document._id || "");
        entries.push({ collection, recordId, path: fieldPath, original: item, originalHash: sha(item), kind, purpose,
          mediaCollection: logicalCollection,
          orderId: purpose === "order-delivery" ? String(context.id || context._id || recordId) : String(context.orderId || ""),
          ownerKind: purpose === "avatar" ? "public" : "admin",
          ownerId: purpose === "avatar" ? String(context.openid || context._openid || context.id || "") : "media-migration",
          status: requiresReview ? "needs-review" : ["placeholder-svg", "unrecoverable-local"].includes(kind) ? "needs-original" : "pending" });
      } else if (item && typeof item === "object") {
        if (collection === "trash" && key === "source") walk(item, fieldPath, item, String(document.sourceKey || ""));
        else walk(item, fieldPath, context, logicalCollection);
      }
    }
  }
  walk(document);
  return entries;
}

async function inventory(source) {
  const manifest = { version: 1, runId: `oss-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`, createdAt: new Date().toISOString(), allowedHosts: [], entries: [], records: [] };
  for (const collection of COLLECTIONS) {
    const rows = await source.list(collection);
    for (const document of rows) manifest.entries.push(...findMedia(collection, document));
  }
  manifest.allowedHosts = [...new Set(manifest.entries.filter(e => e.kind === "http").map(e => new URL(e.original).hostname))].sort();
  return manifest;
}

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254
      || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && [0, 168].includes(p[1])
      || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 198 && [18, 19, 51].includes(p[1])
      || p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  return net.isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
}

async function downloadPublic(url, allowedHosts, maxSize = 500 * 1024 * 1024, redirects = 0) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port)) || !allowedHosts.includes(u.hostname)) throw new Error("source_host_not_allowed");
  const addresses = await dns.lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error("source_address_not_public");
  return new Promise((resolve, reject) => {
    const request = (u.protocol === "https:" ? https : http).get(u, {
      timeout: 30000,
      lookup: (_host, opts, callback) => opts.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      headers: { "User-Agent": "LuxiaomingMediaMigration/1.0", Accept: "image/jpeg,image/png,image/webp,video/mp4" },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) return reject(new Error("too_many_redirects"));
        downloadPublic(new URL(response.headers.location, u).href, allowedHosts, maxSize, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`source_http_${response.statusCode}`)); return; }
      if (Number(response.headers["content-length"]) > maxSize) { response.destroy(); reject(new Error("source_too_large")); return; }
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > maxSize) { response.destroy(); reject(new Error("source_too_large")); } else chunks.push(chunk); });
      response.on("error", () => reject(new Error("source_read_failed")));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.on("timeout", () => request.destroy(new Error("source_timeout")));
    request.on("error", () => reject(new Error("source_fetch_failed")));
  });
}

async function readSource(entry, { allowedHosts, staticRoots = [], cloudRead } = {}) {
  if (entry.kind === "data") {
    const match = entry.original.match(/^data:([^,]*),(.*)$/s);
    if (!match) throw new Error("invalid_data_url");
    return /;base64/i.test(match[1]) ? Buffer.from(match[2], "base64") : Buffer.from(decodeURIComponent(match[2]));
  }
  if (entry.kind === "http") return downloadPublic(entry.original, allowedHosts || []);
  if (entry.kind === "cloud") {
    if (!cloudRead) throw new Error("cloud_read_credentials_required");
    return cloudRead(entry.original);
  }
  if (entry.kind === "local") {
    for (const root of staticRoots) {
      const absoluteRoot = fs.realpathSync(root);
      const target = path.resolve(root, entry.original.replace(/^\//, "").replace(/^public\//, ""));
      if (!fs.existsSync(target)) continue;
      const real = fs.realpathSync(target);
      if (!real.startsWith(absoluteRoot + path.sep) || !fs.statSync(real).isFile()) continue;
      if (fs.statSync(real).size > 500 * 1024 * 1024) throw new Error("source_too_large");
      return fs.readFileSync(real);
    }
    throw new Error("source_file_missing");
  }
  throw new Error("original_file_required");
}

function valueAt(doc, parts) { return parts.reduce((value, key) => value == null ? undefined : value[key], doc); }
function parentAt(doc, parts) { return valueAt(doc, parts.slice(0, -1)); }
function replacement(entry, asset) {
  if (entry.purpose === "content") return `/api/media/${asset.id}`;
  return `oss-file:${asset.id}`;
}

async function applyManifest(source, adapter, manifest, { save = async () => {}, read = readSource, staticRoots = [], cloudRead } = {}) {
  const groups = new Map();
  for (const entry of manifest.entries) {
    const key = `${entry.collection}:${entry.recordId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const entries of groups.values()) {
    const { collection, recordId } = entries[0];
    const document = await source.get(collection, recordId);
    if (!document) { for (const e of entries) if (e.status !== "migrated") e.status = "record-missing"; await save(manifest); continue; }
    const next = clone(document); const touched = new Set(); const done = [];
    for (const entry of entries) {
      if (["migrated", "needs-original", "needs-review", "rolled-back"].includes(entry.status)) continue;
      if (valueAt(document, entry.path) === entry.target && entry.assetId) {
        entry.status = "migrated";
        const recovered = await source.get("mediaFiles", entry.assetId);
        if (recovered && recovered.status === "ready") await source.update("mediaFiles", entry.assetId, { status: "bound", boundAt: new Date().toISOString() });
        for (const record of manifest.records) {
          if (record.status === "prepared" && record.collection === collection && record.recordId === recordId
            && Object.entries(record.after).every(([key, value]) => JSON.stringify(document[key]) === JSON.stringify(value))) record.status = "applied";
        }
        continue;
      }
      if (valueAt(document, entry.path) !== entry.original) { entry.status = "conflict"; continue; }
      try {
        // The database insert may have succeeded before its manifest checkpoint
        // was persisted. Recover the deterministic ID even without assetId.
        const id = entry.assetId || `file_${sha(`${manifest.runId}:${collection}:${recordId}:${entry.path.join(".")}`).slice(0, 40)}`;
        let asset = await source.get("mediaFiles", id);
        if (asset && (asset.migrationRunId !== manifest.runId || asset.collection !== entry.mediaCollection
          || String(asset.recordId) !== String(recordId) || asset.purpose !== entry.purpose
          || asset.visibility !== (entry.purpose === "content" ? "public" : "private")
          || String(asset.orderId || "") !== String(entry.orderId || ""))) throw new Error("migration_asset_scope_mismatch");
        if (!asset || !["ready", "bound"].includes(asset.status)) {
          const bytes = await read(entry, { allowedHosts: manifest.allowedHosts, staticRoots, cloudRead });
          const mimeType = detectType(bytes);
          if (!mimeType) throw new Error("unsupported_or_placeholder_content");
          const sizeLimit = mimeType === "video/mp4" ? 500 * 1024 * 1024 : entry.purpose === "order-delivery" ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
          if (!bytes.length || bytes.length > sizeLimit) throw new Error("source_too_large");
          const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" }[mimeType];
          const allocation = asset && asset.objectKey
            ? { bucket: asset.bucket, region: asset.region, objectKey: asset.objectKey }
            : adapter.allocation(id, extension, entry.purpose);
          if (asset && asset.sha256 && asset.sha256 !== sha(bytes)) throw new Error("source_changed_since_first_upload");
          asset = { id, name: `migrated-${id.slice(-10)}.${extension}`, extension, mimeType, size: bytes.length,
            purpose: entry.purpose, visibility: entry.purpose === "content" ? "public" : "private",
            collection: entry.mediaCollection, recordId, orderId: entry.orderId, ownerKind: entry.ownerKind, ownerId: entry.ownerId,
            status: "pending", createTime: new Date().toISOString(), migrationRunId: manifest.runId, sha256: sha(bytes),
            ...allocation };
          if (!await source.get("mediaFiles", id)) await source.create("mediaFiles", asset);
          entry.assetId = id; entry.target = replacement(entry, asset); entry.status = "uploading"; await save(manifest);
          // Recovery after interruption first checks whether the immutable object
          // was already uploaded, preventing overwrite or duplicate objects.
          let verified;
          try { verified = await adapter.inspect(asset); } catch (error) { if (error.code !== "FILE_MISSING") throw error; }
          if (!verified) { await adapter.put(asset, bytes); verified = await adapter.inspect(asset); }
          if (verified.size !== bytes.length || verified.mimeType !== mimeType || verified.fileId !== id || verified.sha256 !== asset.sha256 || verified.acl !== "private" || detectType(verified.bytes) !== mimeType) throw new Error("target_verification_failed");
          asset = await source.update("mediaFiles", id, { status: "ready", etag: verified.etag, completedAt: new Date().toISOString() });
        }
        entry.assetId = asset.id; entry.target = replacement(entry, asset);
        parentAt(next, entry.path)[entry.path[entry.path.length - 1]] = entry.target;
        touched.add(entry.path[0]); done.push(entry); entry.status = "verified";
      } catch (error) {
        entry.status = "failed";
        entry.error = String(error.code && String(error.code).startsWith("FILE_") ? error.code : error.message || "migration_failed").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90);
      }
      await save(manifest);
    }
    if (done.length) {
      const before = Object.fromEntries([...touched].map(key => [key, document[key]]));
      const after = Object.fromEntries([...touched].map(key => [key, next[key]]));
      const record = { collection, recordId, before, after, status: "prepared" };
      manifest.records.push(record); await save(manifest);
      const updated = await source.compareAndUpdate(collection, recordId, before, after);
      record.status = updated ? "applied" : "conflict";
      for (const entry of done) {
        entry.status = updated ? "migrated" : "conflict";
        if (updated) await source.update("mediaFiles", entry.assetId, { status: "bound", boundAt: new Date().toISOString() });
      }
      await save(manifest);
    } else await save(manifest);
  }
  return manifest;
}

async function rollbackManifest(source, manifest, save = async () => {}) {
  for (const record of [...manifest.records].reverse()) {
    if (!["applied", "prepared"].includes(record.status)) continue;
    const current = await source.get(record.collection, record.recordId);
    // A previous rollback can commit before its manifest checkpoint. Treat an
    // exact original image as recovered, without overwriting later edits.
    const alreadyRestored = current && Object.entries(record.before).every(([key, value]) => isDeepStrictEqual(current[key], value));
    const updated = alreadyRestored || await source.compareAndUpdate(record.collection, record.recordId, record.after, record.before);
    record.status = updated ? "rolled-back" : "rollback-conflict";
    for (const entry of manifest.entries.filter(e => e.collection === record.collection && e.recordId === record.recordId
      && Object.prototype.hasOwnProperty.call(record.after, e.path[0]) && valueAt(record.after, e.path) === e.target)) {
      // Prepared checkpoints contain verified entries if apply crashed between
      // the business commit and marking individual entries as migrated.
      if (["migrated", "verified", "conflict", "rollback-conflict"].includes(entry.status)) entry.status = record.status;
    }
    await save(manifest);
  }
  return manifest;
}
function summary(manifest) {
  const states = {}; const kinds = {}; const collections = {};
  for (const e of manifest.entries) { states[e.status] = (states[e.status] || 0) + 1; kinds[e.kind] = (kinds[e.kind] || 0) + 1; collections[e.collection] = (collections[e.collection] || 0) + 1; }
  return { runId: manifest.runId, totalReferences: manifest.entries.length, states, kinds, collections };
}
module.exports = { findMedia, inventory, sourceKind, isPublicAddress, readSource, applyManifest, rollbackManifest, summary, COLLECTIONS };
