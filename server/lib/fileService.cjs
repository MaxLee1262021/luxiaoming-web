"use strict";

const crypto = require("crypto");
const path = require("path");
const { createOssStorage, fileError } = require("./ossStorage.cjs");

const MiB = 1024 * 1024;
const TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" });
const PURPOSES = new Set(["content", "avatar", "order-delivery", "after-sale", "finance"]);
const READY = new Set(["ready", "bound"]);
function ownerId(session) { return String(session && (session.kind === "public" ? session.openid : session.subjectId || session.authzUserId || session.account) || ""); }
function owns(session, asset) { return asset.ownerKind === session.kind && asset.ownerId === ownerId(session); }
function fileIdFromUrl(value) { return typeof value === "string" ? (value.match(/^(?:https?:\/\/[^/]+)?\/api\/media\/(file_[a-f0-9]{32,48})(?:\?.*)?$/) || [])[1] || "" : ""; }
function descriptor(asset) {
  return { id: asset.id, fileId: asset.id, name: asset.name, type: asset.mimeType.startsWith("video/") ? "video" : "image",
    mimeType: asset.mimeType, size: asset.size, status: asset.status,
    ...(asset.visibility === "public" && READY.has(asset.status) ? { url: `/api/media/${asset.id}` } : {}) };
}
function detectType(bytes) {
  const b = Buffer.from(bytes || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 16 && b.toString("ascii", 4, 8) === "ftyp" && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash|MSNV)/.test(b.toString("ascii", 8, 12))) return "video/mp4";
  return "";
}
function validateInput(input) {
  if (!input || !PURPOSES.has(input.purpose)) throw fileError("PURPOSE", "请选择有效的文件用途");
  const mimeType = String(input.mimeType || "").split(";")[0].toLowerCase();
  if (!TYPES[mimeType] || (mimeType === "video/mp4" && !["content", "order-delivery"].includes(input.purpose))) throw fileError("TYPE", "请选择 JPG、PNG、WebP 图片或适用场景的 MP4 视频");
  const limit = mimeType === "video/mp4" ? 500 * MiB : input.purpose === "avatar" ? 5 * MiB : input.purpose === "order-delivery" ? 50 * MiB : 20 * MiB;
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 1) throw fileError("SIZE", "不能上传空文件");
  if (size > limit) throw fileError("SIZE", `文件不能超过 ${limit / MiB} MB`, 413);
  const name = path.basename(String(input.fileName || input.name || "").replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
  if (!name) throw fileError("NAME", "缺少文件名称");
  const fields = {};
  for (const key of ["collection", "recordId", "orderId"]) {
    fields[key] = String(input[key] || "");
    if (fields[key].length > 128 || /[\x00-\x1f]/.test(fields[key])) throw fileError("SCOPE", "文件关联记录无效");
  }
  if (input.purpose === "content" && !fields.collection) throw fileError("SCOPE", "缺少素材所属集合");
  if (["order-delivery", "after-sale"].includes(input.purpose) && !fields.orderId) throw fileError("SCOPE", "缺少关联订单");
  return { ...fields, name, mimeType, extension: TYPES[mimeType], size, purpose: input.purpose, visibility: input.purpose === "content" ? "public" : "private" };
}

function createFileService({ source, authorize = async () => false, adapter = createOssStorage(), clock = () => new Date() } = {}) {
  if (!source) throw new Error("fileService requires source");
  const locks = new Map();
  async function lock(id, task) {
    const previous = locks.get(id) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => held);
    locks.set(id, tail);
    await previous.catch(() => {});
    try { return await task(); } finally { release(); if (locks.get(id) === tail) locks.delete(id); }
  }
  async function get(id) {
    if (!/^file_[a-f0-9]{32,48}$/.test(String(id))) throw fileError("NOT_FOUND", "文件不存在", 404);
    const asset = await source.get("mediaFiles", id);
    if (!asset || asset.status === "deleted") throw fileError("NOT_FOUND", "文件不存在", 404);
    return asset;
  }
  async function allow(session, asset, action) {
    if (!session || !ownerId(session)) throw fileError("SESSION", "请先登录", 401);
    if (!(await authorize(session, asset, action))) throw fileError("FORBIDDEN", "无权操作该文件", 403);
  }
  async function transition(asset, patch) {
    const updated = typeof source.compareAndUpdate === "function"
      ? await source.compareAndUpdate("mediaFiles", asset.id, { status: asset.status }, patch)
      : await source.update("mediaFiles", asset.id, patch);
    if (!updated) throw fileError("CONFLICT", "文件状态已变化，请刷新后重试", 409);
    return updated;
  }
  async function inspectReady(asset) {
    const result = await adapter.inspect(asset);
    if (Number(result.size) !== Number(asset.size) || result.mimeType !== asset.mimeType || detectType(result.bytes) !== asset.mimeType
      || result.fileId !== asset.id || result.acl !== "private") {
      // Mark invalid content; signed policy forbids overwrite, so retry needs a new intent.
      await transition(asset, { status: "rejected", rejection: "file_mismatch" });
      throw fileError("INVALID_CONTENT", "实际文件格式、大小或权限与上传申请不一致", 400);
    }
    return result;
  }
  const service = {
    async createIntent(session, input) {
      const info = validateInput(input);
      const date = clock();
      const id = `file_${crypto.randomBytes(20).toString("hex")}`;
      const asset = { ...info, id, ownerKind: session && session.kind, ownerId: ownerId(session), status: "pending",
        createTime: date.toISOString(), expiresAt: new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString() };
      await allow(session, asset, "upload");
      Object.assign(asset, adapter.allocation(id, info.extension, info.purpose, date));
      const signature = await adapter.signUpload(asset);
      await source.create("mediaFiles", asset);
      return { fileId: id, ...signature };
    },
    async complete(session, id) {
      return lock(id, async () => {
        const asset = await get(id);
        await allow(session, asset, "complete");
        if (!owns(session, asset)) throw fileError("FORBIDDEN", "只能确认本人上传的文件", 403);
        if (READY.has(asset.status)) return descriptor(asset);
        if (asset.status !== "pending" || new Date(asset.expiresAt) < clock()) throw fileError("EXPIRED", "上传申请已失效，请重新上传", 409);
        const inspected = await inspectReady(asset);
        return descriptor(await transition(asset, { status: "ready", etag: inspected.etag, completedAt: clock().toISOString() }));
      });
    },
    async access(session, id, options = {}) {
      const asset = await get(id);
      await allow(session, asset, "access");
      if (!READY.has(asset.status)) throw fileError("NOT_READY", "文件尚未上传完成", 409);
      return { ...await adapter.signRead(asset, options), name: asset.name, mimeType: asset.mimeType,
        type: asset.mimeType.startsWith("video/") ? "video" : "image" };
    },
    async publicAccess(id, options = {}) {
      const asset = await get(id);
      if (asset.visibility !== "public" || asset.purpose !== "content" || !READY.has(asset.status)) throw fileError("NOT_FOUND", "文件不存在", 404);
      return adapter.signRead(asset, options);
    },
    async describe(id) { return descriptor(await get(id)); },
    async assertFiles(session, ids, scope = {}) {
      if (!Array.isArray(ids) || ids.length > 500 || new Set(ids).size !== ids.length) throw fileError("IDS", "文件列表无效或重复");
      const results = [];
      for (const id of ids) {
        const asset = await get(id);
        if (!READY.has(asset.status)) throw fileError("NOT_READY", "请等待所有文件上传完成", 409);
        for (const key of ["purpose", "orderId", "collection"]) {
          if (scope[key] !== undefined && String(asset[key] || "") !== String(scope[key])) throw fileError("SCOPE", "文件用途或所属记录不匹配", 403);
        }
        if (scope.recordId && asset.recordId && String(scope.recordId) !== asset.recordId) throw fileError("SCOPE", "文件所属记录不匹配", 403);
        await allow(session, asset, "bind");
        results.push(descriptor(asset));
      }
      return results;
    },
    async markBound(ids) {
      for (const id of ids) await lock(id, async () => {
        const asset = await get(id);
        if (asset.status === "bound") return;
        if (asset.status !== "ready") throw fileError("NOT_READY", "文件尚未就绪", 409);
        await transition(asset, { status: "bound", boundAt: clock().toISOString() });
      });
    },
    async remove(session, id) {
      return lock(id, async () => {
        const asset = await get(id);
        await allow(session, asset, "delete");
        // Once a file has been validated it may be between business validation
        // and commit in another process. Never physically delete it here.
        if (!owns(session, asset) || READY.has(asset.status)) throw fileError("IN_USE", "已确认的文件需在核对业务引用后清理，不能直接删除", 409);
        // Retain an inaccessible tombstone until any issued upload policy expires.
        // A late direct upload cannot revive this file through complete().
        await transition(asset, { status: "deleted", deletedAt: clock().toISOString() });
        await adapter.remove(asset);
        return { fileId: id, deleted: true };
      });
    },
    adapter,
  };
  return service;
}

module.exports = { createFileService, validateInput, detectType, descriptor, fileIdFromUrl, ownerId, owns };
