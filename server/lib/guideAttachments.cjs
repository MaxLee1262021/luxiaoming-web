"use strict";

const zlib = require("zlib");
const ATTACHMENT_TYPES = Object.freeze({
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv"
});
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
const isGuideAttachment = (asset = {}) => Object.prototype.hasOwnProperty.call(ATTACHMENT_TYPES, asset.mimeType);

function utf8Text(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || /<(?:!doctype\s+html|html|script|svg|iframe|object|embed)\b/i.test(text)) return "";
    return text;
  } catch (_) { return ""; }
}

// Modern Office files are ZIP packages. Inspect the central directory and
// bounded content-types XML, rather than trusting a filename or PK prefix.
function officeType(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 22 || b.readUInt32LE(0) !== 0x04034b50) return "";
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) { end = i; break; }
  }
  if (end === -1 || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6)) return "";
  const count = b.readUInt16LE(end + 10), directorySize = b.readUInt32LE(end + 12), directory = b.readUInt32LE(end + 16);
  if (!count || count > 10000 || directory + directorySize > end || count !== b.readUInt16LE(end + 8)) return "";
  let cursor = directory, contentTypes = "", unpacked = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directory + directorySize || b.readUInt32LE(cursor) !== 0x02014b50) return "";
    const flags = b.readUInt16LE(cursor + 8), method = b.readUInt16LE(cursor + 10);
    const compressed = b.readUInt32LE(cursor + 20), expanded = b.readUInt32LE(cursor + 24);
    const nameLength = b.readUInt16LE(cursor + 28), extraLength = b.readUInt16LE(cursor + 30), commentLength = b.readUInt16LE(cursor + 32);
    const local = b.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > directory + directorySize || flags & 1 || ![0, 8].includes(method) || local + 30 > directory || b.readUInt32LE(local) !== 0x04034b50) return "";
    const name = b.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (!name || names.has(name) || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")
      || /(?:vbaProject\.bin|\.(?:exe|dll|js|vbs|cmd|bat|ps1|html?|svg))$/i.test(name)) return "";
    names.add(name); unpacked += expanded;
    if (unpacked > 100 * 1024 * 1024) return "";
    const data = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (data + compressed > directory) return "";
    if (name === "[Content_Types].xml") {
      if (expanded > 1024 * 1024) return "";
      try {
        const xml = method === 8 ? zlib.inflateRawSync(b.subarray(data, data + compressed), { maxOutputLength: 1024 * 1024 }) : b.subarray(data, data + compressed);
        if (xml.length !== expanded) return "";
        contentTypes = utf8Text(xml);
      } catch (_) { return ""; }
    }
    cursor = next;
  }
  if (cursor !== directory + directorySize || !names.has("_rels/.rels") || !/<Types\b/.test(contentTypes)) return "";
  for (const [extension, main, contentType] of [
    ["docx", "word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
    ["xlsx", "xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
    ["pptx", "ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"]
  ]) {
    if (names.has(main) && contentTypes.includes(contentType)) return Object.keys(ATTACHMENT_TYPES).find((mime) => ATTACHMENT_TYPES[mime] === extension);
  }
  return "";
}

function detectAttachmentType(bytes, expected) {
  const b = Buffer.from(bytes || []);
  if (!b.length || b.length > MAX_ATTACHMENT_SIZE) return "";
  if (b.toString("ascii", 0, 5) === "%PDF-" && /%%EOF\s*$/.test(b.subarray(Math.max(0, b.length - 2048)).toString("ascii"))) return "application/pdf";
  const office = officeType(b);
  if (office) return office;
  if (["text/plain", "text/csv"].includes(expected) && utf8Text(b).trim()) return expected;
  return "";
}

module.exports = { ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE, isGuideAttachment, detectAttachmentType };
