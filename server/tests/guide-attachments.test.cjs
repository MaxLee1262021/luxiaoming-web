"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const createApi = require("../lib/api.cjs");
const { ATTACHMENT_TYPES, detectAttachmentType } = require("../lib/guideAttachments.cjs");
const { validateInput } = require("../lib/fileService.cjs");
const { sanitizeGuideHtml, guideAttachmentLinks } = require("../lib/guideContent.cjs");

const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

function zip(entries) {
  const files = [], directory = [];
  let offset = 0;
  function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ -1) >>> 0; }
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), packed = zlib.deflateRawSync(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    files.push(local, filename, packed); directory.push(central, filename); offset += local.length + filename.length + packed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

function office(extension, extra = {}) {
  const [main, type] = ({ docx: ["word/document.xml", "wordprocessingml.document"], xlsx: ["xl/workbook.xml", "spreadsheetml.sheet"], pptx: ["ppt/presentation.xml", "presentationml.presentation"] })[extension];
  return zip({ "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`, "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', [main]: "<document/>", ...extra });
}

async function fixture(t) {
  const rows = {
    staff: [{ id: "editor", account: "editor", role: "content", status: "启用" }],
    cities: [{ id: "city", enabled: true }], spots: [{ id: "spot", name: "江边", cityId: "city", isShow: true }],
    guides: [], mediaFiles: [], samples: [], logs: []
  };
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find((row) => row.id === id) || null); },
    async create(key, row) { (rows[key] ||= []).push(structuredClone(row)); return structuredClone(row); },
    async update(key, id, patch) { const row = (rows[key] || []).find((row) => row.id === id); if (!row) return null; Object.assign(row, structuredClone(patch)); return structuredClone(row); }
  };
  const auth = { async init() {}, async getSession(token) { return token === "editor" ? { kind: "admin", role: "content", account: "editor", subjectId: "editor" } : null; } };
  const objects = new Map(), reads = [];
  const adapter = {
    allocation(id, extension) { return { bucket: "fixture", objectKey: `${id}.${extension}` }; },
    async signUpload() { return { uploadUrl: "https://oss.invalid", fields: {} }; },
    async inspect(asset) { return { size: objects.get(asset.id).length, bytes: objects.get(asset.id), mimeType: asset.mimeType, fileId: asset.id, acl: "private", etag: "fixture" }; },
    async signRead(asset, options) { reads.push({ asset, options }); return { url: `https://oss.invalid/${asset.id}?temporary=yes` }; }
  };
  const handler = createApi(source, "json", { auth, fileAdapter: adapter });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  async function request(path, body, method = "POST", admin = true) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "Bearer editor" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text(); return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  async function upload(mimeType, bytes, extra = {}) {
    const intent = await request("/api/files/upload-intent", { purpose: "content", collection: "guides", mimeType, fileName: `拍摄说明.${ATTACHMENT_TYPES[mimeType]}`, size: bytes.length, ...extra });
    assert.equal(intent.status, 200, JSON.stringify(intent.body));
    const id = intent.body.data.fileId; objects.set(id, bytes);
    const complete = await request(`/api/files/${id}/complete`, {});
    return { id, complete };
  }
  return { rows, request, upload, reads };
}

test("guide attachment upload detects PDF, modern Office and UTF-8 text while preserving descriptor metadata", async (t) => {
  const f = await fixture(t);
  for (const [mime, extension] of Object.entries(ATTACHMENT_TYPES)) {
    const bytes = extension === "pdf" ? pdf : ["txt", "csv"].includes(extension) ? Buffer.from("拍摄地点,到达时间\n江边,下午六点") : office(extension);
    const { complete } = await f.upload(mime, bytes);
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    const file = complete.body.data;
    assert.equal(file.type, "file"); assert.equal(file.name, `拍摄说明.${extension}`); assert.equal(file.mimeType, mime); assert.equal(file.size, bytes.length);
    assert.match(file.url, /^\/api\/media\/file_[a-f0-9]{40}$/);
  }
});

test("guide file anchors bind verified assets, expose real metadata and sign anonymous downloads", async (t) => {
  const f = await fixture(t), uploaded = await f.upload("application/pdf", pdf);
  assert.equal(uploaded.complete.status, 200);
  const file = uploaded.complete.body.data;
  const html = `<p>先查看说明</p><a href="${file.url}?download=1" data-file-id="${file.fileId}" data-file-name="伪造文件名.pdf" data-file-size="1" data-file-type="text/plain" onclick="alert(1)">拍摄说明</a><p>再出发</p>`;
  const saved = await f.request("/api/collection/guides", { id: "guide", title: "拍摄附件", cover: "https://test.invalid/cover.jpg", contentHtml: html, spotIds: ["spot"], status: "已发布", isShow: true });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(f.rows.mediaFiles[0].status, "bound");
  assert.doesNotMatch(saved.body.contentHtml, /onclick|伪造文件名|data-file-size="1"/);
  assert.match(saved.body.contentHtml, /data-file-name="拍摄说明.pdf"/);
  const detail = await f.request("/api/rpc/getGuide", { id: "guide" }, "POST", false);
  assert.equal(detail.body.data.attachments[0].mimeType, "application/pdf");
  assert.equal(detail.body.data.attachments[0].size, pdf.length);
  const downloaded = await f.request(`${file.url}?download=1`, undefined, "GET", false);
  assert.equal(downloaded.status, 302); assert.match(downloaded.headers.get("location"), /^https:\/\/oss.invalid/);
  assert.equal(f.reads.at(-1).options.download, true);
  const head = await f.request(file.url, undefined, "HEAD", false);
  assert.equal(head.status, 302); assert.equal(f.reads.at(-1).options.download, true); assert.equal(f.reads.at(-1).options.method, "HEAD");
  const access = await f.request(`/api/files/${file.fileId}/access`, {});
  assert.equal(access.body.data.type, "file"); assert.equal(f.reads.at(-1).options.download, true);
  assert.equal((await f.request("/api/collection/samples", { id: "bad-sample", url: file.url })).status, 403);
  assert.equal((await f.request("/api/doc/homeConfig/homeStats", { banners: [{ url: file.url }] }, "PUT")).status, 403);
  assert.equal((await f.request("/api/collection/guides/guide", { cover: file.url }, "PUT")).status, 400);
  const pending = await f.request("/api/files/upload-intent", { purpose: "content", collection: "guides", fileName: "待传.pdf", mimeType: "application/pdf", size: pdf.length });
  const pendingId = pending.body.data.fileId;
  const unreadyHtml = `<a href="/api/media/${pendingId}" data-file-name="待传.pdf" data-file-size="${pdf.length}" data-file-type="application/pdf">待传</a>`;
  assert.equal((await f.request("/api/collection/guides/guide", { contentHtml: unreadyHtml }, "PUT")).status, 400);
  const removed = await f.request("/api/collection/guides/guide", { contentHtml: "<p>移除全部附件</p>" }, "PUT");
  assert.deepEqual(removed.body.attachments, []);
});

test("attachment formats and size are isolated from other collections, purposes and executable files", () => {
  const input = { purpose: "content", collection: "guides", fileName: "guide.pdf", mimeType: "application/pdf", size: pdf.length };
  for (const patch of [{ collection: "samples" }, { collection: "albums" }, { purpose: "order-delivery", orderId: "order" }, { purpose: "after-sale", orderId: "order" }, { purpose: "finance" }, { purpose: "avatar" }, { fileName: "guide.exe" }, { fileName: "guide.html", mimeType: "text/html" }, { fileName: "guide.svg", mimeType: "image/svg+xml" }, { fileName: "guide.doc", mimeType: "application/msword" }]) assert.throws(() => validateInput({ ...input, ...patch }), { code: "FILE_TYPE" });
  assert.throws(() => validateInput({ ...input, size: 20 * 1024 * 1024 + 1 }), { code: "FILE_SIZE" });
  assert.equal(detectAttachmentType(office("docx"), "application/pdf"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  for (const bytes of [Buffer.from("PK\x03\x04fake"), zip({ "fake.txt": "hello" }), office("docx", { "word/vbaProject.bin": "macro" }), office("docx", { "../evil.exe": "exe" })]) assert.equal(detectAttachmentType(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "");
  for (const bytes of [Buffer.from("<html>fake</html>"), Buffer.from("<svg onload='alert(1)'/>"), Buffer.from([0x50, 0x00, 0x80]), Buffer.from("#!/bin/sh\u0000")]) assert.equal(detectAttachmentType(bytes, "text/plain"), "");
});

test("attachment completion rejects renamed content and cannot expose unverified assets", async (t) => {
  const f = await fixture(t);
  for (const [mime, bytes] of [["application/pdf", Buffer.from("<html>fake PDF</html>")], ["application/pdf", office("docx")], ["text/plain", Buffer.from([0, 1, 2, 3])]]) {
    const { id, complete } = await f.upload(mime, bytes);
    assert.equal(complete.status, 400, JSON.stringify(complete.body));
    assert.equal(f.rows.mediaFiles.find((row) => row.id === id).status, "rejected");
    assert.equal((await f.request(`/api/media/${id}`, undefined, "GET", false)).status, 404);
  }
});

test("attachment anchor sanitizer drops arbitrary links, unsafe metadata and mismatched identities", () => {
  const id = `file_${"a".repeat(40)}`;
  const link = `<a href="/api/media/${id}" data-file-id="${id}" data-file-name="行程.pdf" data-file-size="123" data-file-type="application/pdf" onclick="alert(1)">行程.pdf</a>`;
  const clean = sanitizeGuideHtml(link);
  assert.equal(guideAttachmentLinks(clean)[0].name, "行程.pdf");
  assert.equal(sanitizeGuideHtml(clean), clean);
  assert.doesNotMatch(clean, /onclick/);
  for (const bad of [link.replace(`/api/media/${id}`, "javascript:alert(1)"), link.replace(`/api/media/${id}`, `https://evil.invalid/api/media/${id}`), link.replace(`data-file-id="${id}"`, `data-file-id="file_${"b".repeat(40)}"`), link.replace("application/pdf", "text/html")]) assert.equal(guideAttachmentLinks(sanitizeGuideHtml(bad)).length, 0);
});
