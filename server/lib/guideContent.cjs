"use strict";

const { effectivePackageSpotIds, createContentContext } = require("./contentPolicy.cjs");
const { ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE, isGuideAttachment } = require("./guideAttachments.cjs");

const idOf = (item) => String(item && (item.id || item._id) || "");
const videoUrl = (url) => /\.(mp4|mov|webm)(\?|$)|\/video\//i.test(String(url || ""));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const uniqueIds = (ids) => [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
const htmlTags = new Set("p div span h1 h2 h3 h4 h5 h6 b strong i em u s strike blockquote ul ol li br hr pre code img video source a".split(" "));
const voidTags = new Set(["br", "hr", "img", "source"]);
const decodeEntities = (text) => String(text).replace(/&#(x[0-9a-f]+|[0-9]+);?|&(amp|quot|apos|lt|gt|nbsp);/gi, (match, code, name) => {
  if (name) return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " })[name.toLowerCase()];
  const n = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
});
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function safeMediaUrl(value) {
  const url = decodeEntities(value).trim();
  // Reconstruct attributes rather than copying markup or permitting executable
  // URL schemes. Blob/data URLs from the demo must be uploaded before saving.
  if (/[\u0000-\u0020\u007f\\]/.test(url)) return "";
  if (/^\/(?!\/)/.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return "";
  try { const parsed = new URL(url); return parsed.hostname && !parsed.username && !parsed.password ? url : ""; } catch (_) { return ""; }
}

function htmlAttributes(raw) {
  const out = {};
  const re = /([^\s=<>/'"`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>`]+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    if (!has(out, name)) out[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return out;
}

function attachmentAttributes(attrs) {
  const href = decodeEntities(attrs.href || "").trim();
  const match = href.match(/^\/api\/media\/(file_[a-f0-9]{32,48})(?:\?download=(?:1|true))?$/);
  if (!match || attrs["data-file-id"] && decodeEntities(attrs["data-file-id"]) !== match[1]) return null;
  const name = decodeEntities(attrs["data-file-name"] || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
  const type = decodeEntities(attrs["data-file-type"] || "").toLowerCase();
  const size = Number(attrs["data-file-size"] || 0);
  if (!name || !Object.prototype.hasOwnProperty.call(ATTACHMENT_TYPES, type) || !Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_SIZE) return null;
  return { fileId: match[1], url: `/api/media/${match[1]}`, name, size, mimeType: type, type: "file" };
}

function attachmentMarkup(file) {
  return ` href="${escapeHtml(file.url)}" data-file-id="${escapeHtml(file.fileId)}" data-file-name="${escapeHtml(file.name)}" data-file-size="${file.size}" data-file-type="${escapeHtml(file.mimeType)}"`;
}

function sanitizeGuideHtml(input) {
  const tokens = String(input || "").match(/<!--[\s\S]*?(?:-->|$)|<[^>]*(?:>|$)|[^<]+/g) || [];
  const output = [];
  const stack = [];
  const blocked = [];
  for (const token of tokens) {
    if (token.startsWith("<!--")) continue;
    if (token[0] !== "<") { if (!blocked.length) output.push(escapeHtml(decodeEntities(token))); continue; }
    const match = token.match(/^<\s*(\/?)\s*([a-z][a-z0-9]*)\b([\s\S]*?)>$/i);
    if (!match) { if (!blocked.length) output.push(escapeHtml(token)); continue; }
    const closing = !!match[1], tag = match[2].toLowerCase();
    if (blocked.length) {
      if (closing && tag === blocked[blocked.length - 1]) blocked.pop();
      else if (!closing && tag === blocked[blocked.length - 1]) blocked.push(tag);
      continue;
    }
    if (/^(script|style|iframe|object|embed|svg|math|template|noscript|textarea|title|xmp|plaintext)$/.test(tag)) { if (!closing && tag !== "embed") blocked.push(tag); continue; }
    if (!htmlTags.has(tag)) continue;
    if (closing) {
      const index = stack.lastIndexOf(tag);
      if (index !== -1) while (stack.length > index) output.push(`</${stack.pop()}>`);
      continue;
    }
    const attrs = htmlAttributes(match[3]);
    let attributes = "";
    if (tag === "a") {
      const file = attachmentAttributes(attrs);
      if (!file) continue;
      attributes = attachmentMarkup(file);
    }
    if (["img", "video", "source"].includes(tag)) {
      const src = safeMediaUrl(attrs.src || "");
      if (src) attributes += ` src="${escapeHtml(src)}"`;
      else if (tag !== "video") continue;
      const poster = tag === "video" && safeMediaUrl(attrs.poster || "");
      if (poster) attributes += ` poster="${escapeHtml(poster)}"`;
      if (tag === "img" && attrs.alt) attributes += ` alt="${escapeHtml(decodeEntities(attrs.alt))}"`;
      if (tag === "video") attributes += ' controls="controls"';
    }
    output.push(`<${tag}${attributes}>`);
    if (!voidTags.has(tag)) stack.push(tag);
  }
  while (stack.length) output.push(`</${stack.pop()}>`);
  return output.join("");
}

function guideAttachmentLinks(html) {
  const files = [];
  for (const match of String(html || "").matchAll(/<a\b([^>]*)>/gi)) {
    const file = attachmentAttributes(htmlAttributes(match[1]));
    if (file) files.push(file);
  }
  return files;
}

async function verifyGuideAttachments(source, html) {
  const files = guideAttachmentLinks(html);
  const verified = new Map();
  for (const file of files) {
    const asset = await source.get("mediaFiles", file.fileId);
    if (!asset || !["ready", "bound"].includes(asset.status) || asset.purpose !== "content" || asset.collection !== "guides" || asset.visibility !== "public" || !isGuideAttachment(asset)) return { error: "附件不存在、尚未上传完成或不属于旅拍灵感" };
    verified.set(file.fileId, { fileId: asset.id || asset._id, url: `/api/media/${asset.id || asset._id}`, name: asset.name, size: asset.size, mimeType: asset.mimeType, type: "file" });
  }
  return { html: html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    const file = attachmentAttributes(htmlAttributes(attrs));
    return file && verified.has(file.fileId) ? `<a${attachmentMarkup(verified.get(file.fileId))}>` : match;
  }), attachments: [...verified.values()] };
}

function guideText(html) {
  return decodeEntities(String(html || "").replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|h[1-6]|li|blockquote|pre)>/gi, "\n").replace(/<[^>]*>/g, "")).replace(/\u200b/g, "").trim();
}

function sortGuides(a, b) {
  const time = (value) => {
    const number = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value || "")) ? Number(value) : Date.parse(value || "");
    return Number.isFinite(number) ? number : 0;
  };
  return Number(!!b.isTop) - Number(!!a.isTop)
    || time(b.updatedAt || b.updateTime || b.createTime || b.createdAt) - time(a.updatedAt || a.updateTime || a.createTime || a.createdAt);
}

function guideMedia(guide = {}) {
  if (typeof guide.contentHtml === "string") {
    const items = [];
    const html = sanitizeGuideHtml(guide.contentHtml);
    const re = /<(img|video|source)\b([^>]*)>/gi;
    let match;
    while ((match = re.exec(html))) {
      const url = safeMediaUrl(htmlAttributes(match[2]).src || "");
      if (url) items.push({ url, type: match[1].toLowerCase() === "img" ? "image" : "video" });
    }
    return items;
  }
  const items = Array.isArray(guide.mediaItems)
    ? guide.mediaItems : (Array.isArray(guide.mediaUrls) ? guide.mediaUrls : []);
  return items.map((item) => {
    const url = String(typeof item === "string" ? item : item && item.url || "").trim();
    const type = item && item.type || (guide.mediaType === "video" || videoUrl(url) ? "video" : "image");
    return { url, type: type === "video" ? "video" : "image" };
  }).filter((item) => item.url);
}

function guideTarget(guide = {}) {
  return {
    type: String(guide.targetProductType ?? (guide.targetPackageId ? "package" : "")),
    id: String(guide.targetProductId ?? guide.targetPackageId ?? "")
  };
}

function belongsToSpot(product = {}, spotId, series = [], packageContext = null) {
  if (packageContext) return !!spotId && effectivePackageSpotIds(product, packageContext).includes(String(spotId));
  let ids = [...(Array.isArray(product.spotIds) ? product.spotIds : []), product.spotId].filter(Boolean).map(String);
  if (!ids.length && product.spotBindingExplicit !== true && product.seriesId) {
    const parent = series.find((item) => idOf(item) === String(product.seriesId));
    if (parent) ids = [...(Array.isArray(parent.spotIds) ? parent.spotIds : []), parent.spotId].filter(Boolean).map(String);
  }
  return !!spotId && ids.includes(String(spotId));
}

function matchesTargetType(product, type) {
  if (type === "album") return true;
  const video = [product.type, product.serviceType, product.productType, product.productKind, product.category]
    .some((value) => /video|短视频|视频/i.test(String(value || "")));
  const videoSingle = video && (product.productKind === "video_single" || product.isVideoSingle === true);
  return type === "video" ? videoSingle : type === "package" && !videoSingle;
}

async function prepareGuideForSave(source, patch, current = {}) {
  const guide = { ...current, ...patch };
  // isShow is the current editor's visibility setting. Keep historical aliases
  // in sync so a stale visible/enabled=false cannot defeat a later show action.
  const visibilityField = ["isShow", "visible", "enabled"].find((key) => has(patch, key));
  if (visibilityField) {
    const value = patch[visibilityField];
    const visible = !(value === false || value === 0 || ["false", "0"].includes(String(value).trim().toLowerCase()));
    guide.isShow = visible; guide.visible = visible; guide.enabled = visible;
  }
  const editingFields = ["title", "name", "cover", "content", "description", "contentHtml", "mediaItems", "mediaUrls", "mediaType", "spotId", "spotIds", "targetProductType", "targetProductId", "targetPackageId", "targetProductSpotId"];
  const contentChanged = !idOf(current) || editingFields.some((key) => has(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(current[key]));
  const publishing = has(patch, "status") && patch.status !== current.status && !["草稿", "下架", "停用", "禁用", "draft", "offline", "disabled"].includes(String(patch.status).toLowerCase());
  // Visibility and pinning are independent of publication. Old records may
  // predate required fields and remain operable until their content is edited.
  if (idOf(current) && !contentChanged && !publishing) return { guide };
  guide.title = String(has(patch, "title") ? patch.title ?? "" : guide.title || guide.name || "").trim();
  guide.name = guide.title;
  guide.status = String(guide.status || "草稿").trim();
  guide.spotIds = uniqueIds(has(patch, "spotIds") ? (Array.isArray(patch.spotIds) ? patch.spotIds : [])
    : has(patch, "spotId") ? [patch.spotId] : [...(Array.isArray(guide.spotIds) ? guide.spotIds : []), guide.spotId]);
  guide.spotId = guide.spotIds[0] || "";
  // Explicit point bindings must not restore a different point via old styles.
  guide.seriesId = "";
  const target = guideTarget(guide);
  let targetSpotId = String(guide.targetProductSpotId || "");
  if (target.id || target.type) {
    if (!["album", "package", "video"].includes(target.type) || !target.id) return { error: "请选择有效的预约同款商品" };
    const product = await source.get(target.type === "album" ? "albums" : "packages", target.id);
    const packageContext = target.type === "package" ? await createContentContext(source) : null;
    const series = packageContext ? packageContext.series : await source.list("series");
    if (!has(patch, "targetProductSpotId") && (!targetSpotId || !guide.spotIds.includes(targetSpotId))) targetSpotId = guide.spotIds.find((id) => product && belongsToSpot(product, id, series, packageContext)) || "";
    if (!product || product.deleted || product.isDeleted || !matchesTargetType(product, target.type)
      || !guide.spotIds.includes(targetSpotId) || !belongsToSpot(product, targetSpotId, series, packageContext)) return { error: "预约同款商品必须属于所选打卡点，请重新选择" };
  }
  guide.targetProductSpotId = target.id ? targetSpotId : "";
  guide.targetProductType = target.type;
  guide.targetProductId = target.id;
  guide.targetPackageId = ["package", "video"].includes(target.type) ? target.id : "";
  const rich = typeof guide.contentHtml === "string";
  if (rich) {
    if (Buffer.byteLength(guide.contentHtml, "utf8") > 60000) return { error: "正文内容过长，请精简到 60KB 以内" };
    guide.contentHtml = sanitizeGuideHtml(guide.contentHtml);
    const attachments = await verifyGuideAttachments(source, guide.contentHtml);
    if (attachments.error) return attachments;
    guide.contentHtml = attachments.html;
    guide.attachments = attachments.attachments;
    if (Buffer.byteLength(guide.contentHtml, "utf8") > 60000) return { error: "正文内容过长，请精简到 60KB 以内" };
    guide.content = guideText(guide.contentHtml);
    guide.description = guide.content.slice(0, 500);
  }
  guide.mediaItems = guideMedia(guide);
  guide.mediaUrls = guide.mediaItems.map((item) => item.url);
  guide.mediaType = rich ? "rich" : guide.mediaType === "video" ? "video" : "image";
  if (!rich && guide.mediaItems.some((item) => item.type !== guide.mediaType)) return { error: "图文灵感请上传图片，视频灵感请上传视频；切换类型前请移除原媒体" };
  const published = !["草稿", "下架", "停用", "禁用", "draft", "offline", "disabled"].includes(String(guide.status || "草稿").toLowerCase());
  if (rich || published) {
    if (!guide.title) return { error: "请填写旅拍灵感标题" };
    if (rich && guide.title.length > 50) return { error: "标题不能超过 50 个字" };
    if (rich && !safeMediaUrl(guide.cover || "")) return { error: "请上传首页封面图" };
    if (rich && !guide.spotIds.length) return { error: "请至少关联一个打卡点" };
    for (const spotId of guide.spotIds) {
      const spot = await source.get("spots", spotId);
      if (!spot || spot.deleted || spot.isDeleted) return { error: "请选择有效的打卡点" };
    }
    if (rich ? !guide.content && !guide.mediaItems.length : !String(guide.content || guide.description || "").trim() || !guide.mediaItems.length) return { error: rich ? "正文内容不能为空" : "发布前请填写正文并上传图片或视频" };
  }
  return { guide };
}

module.exports = { guideMedia, guideTarget, belongsToSpot, matchesTargetType, prepareGuideForSave, sanitizeGuideHtml, guideText, safeMediaUrl, sortGuides, guideAttachmentLinks };
