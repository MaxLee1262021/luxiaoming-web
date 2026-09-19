"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
function fixture(options = {}) {
  const requests = [], sent = [], messages = [];
  let completeCount = 0;
  class FormData { constructor() { this.values = []; } append(...entry) { this.values.push(entry); } }
  class XHR {
    constructor() { this.upload = {}; sent.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() { throw new Error("Application headers must never reach OSS"); }
    send(form) {
      this.form = form;
      this.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 });
      this.status = options.failFirstUpload && sent.length === 1 ? 403 : 204;
      this.onload();
    }
  }
  const window = {
    Vue: { reactive: (value) => value },
    location: { href: "https://admin.example.test/" },
    open() { throw new Error("Preview must not open a download window"); },
    ElementPlus: { ElMessage: { error: (text) => messages.push(text), warning: (text) => messages.push(text) } },
    LXM_API_CONFIG: { base: "/api" },
    LXM_HTTP: { async request(url, init) {
      requests.push({ url, ...init, body: JSON.parse(init.body) });
      if (url.endsWith("upload-intent")) return { ok: true, json: async () => ({ ok: true, data: { fileId: "f1", uploadUrl: "https://example.oss-cn-hangzhou.aliyuncs.com", fields: { key: "private/orders/f1.png", policy: "short-lived" } } }) };
      if (url.endsWith("complete")) {
        completeCount++;
        if (options.failFirstComplete && completeCount === 1) return { ok: false, json: async () => ({ error: "暂时不可用" }) };
        return { ok: true, json: async () => ({ ok: true, data: { fileId: "f1", id: "f1", name: "photo.png", url: "/api/media/f1", type: "image", size: 100 } }) };
      }
      if (url.endsWith("access")) return { ok: true, json: async () => ({ ok: true, data: { url: "https://oss.example.test/private.png?signature=temporary", name: "私有成片", type: options.previewType || "image", mimeType: options.previewType === "video" ? "video/mp4" : "image/png" } }) };
      throw new Error("Unexpected endpoint");
    } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/api/upload.js"), "utf8"), { window, URL, Map, Set, XMLHttpRequest: XHR, FormData });
  return { upload: window.LXM_UPLOAD, requests, sent, messages };
}
const png = { name: "photo.png", type: "image/png", size: 100 };
test("direct upload sends business metadata only to API; updates model after completion", async () => {
  const f = fixture(); let cover = "old.jpg";
  await f.upload.upload(png, { purpose: "content", collection: "samples", onUploaded(file) { cover = file.url; } });
  assert.equal(cover, "/api/media/f1");
  assert.deepEqual(f.requests.map((item) => item.url), ["/api/files/upload-intent", "/api/files/f1/complete"]);
  assert.equal(f.requests[0].body.collection, "samples");
  assert.equal(f.sent[0].withCredentials, false);
  assert.equal(f.sent[0].form.values.at(-1)[0], "file");
  assert.equal(f.upload.jobs[0].status, "done");
});
test("upload failure keeps original reference; retry obtains fresh intent", async () => {
  const f = fixture({ failFirstUpload: true }); let cover = "old.jpg";
  await f.upload.upload(png, { purpose: "content", collection: "samples", onUploaded(file) { cover = file.url; } });
  assert.equal(cover, "old.jpg"); assert.equal(f.upload.ready(), false);
  await f.upload.retry(f.upload.jobs[0].id);
  assert.equal(cover, "/api/media/f1"); assert.equal(f.upload.ready(), true);
  assert.equal(f.requests.filter((item) => item.url.endsWith("upload-intent")).length, 2);
});
test("completion retry reuses uploaded object and does not duplicate binary transfer", async () => {
  const f = fixture({ failFirstComplete: true }); let calls = 0;
  await f.upload.upload(png, { purpose: "order-delivery", orderId: "o1", onUploaded() { calls++; } });
  assert.equal(calls, 0);
  await f.upload.retry(f.upload.jobs[0].id);
  assert.equal(calls, 1); assert.equal(f.sent.length, 1);
});
test("business attachment failure retries binding without duplicate object upload", async () => {
  const f = fixture(); let calls = 0;
  await f.upload.upload(png, { purpose: "order-delivery", orderId: "o1", onUploaded() { if (++calls === 1) throw new Error("草稿保存失败"); } });
  await f.upload.retry(f.upload.jobs[0].id);
  assert.equal(calls, 2); assert.equal(f.sent.length, 1); assert.equal(f.requests.length, 2);
});
test("file type and size restrictions reject before any network request", async () => {
  const f = fixture();
  for (const file of [{ ...png, size: 21 * 1024 * 1024 }, { ...png, type: "image/svg+xml" }, { ...png, size: 0 }]) await f.upload.upload(file, { purpose: "content" });
  assert.equal(f.requests.length, 0);
  assert.throws(() => f.upload.validate({ ...png, size: 6 * 1024 * 1024 }, { purpose: "avatar" }));
  assert.doesNotThrow(() => f.upload.validate({ ...png, size: 49 * 1024 * 1024 }, { purpose: "order-delivery" }));
  assert.equal(f.upload.persistable({ images: ["blob:temporary"] }), false);
  assert.equal(f.upload.persistable({ cover: "https://example.com/photo.jpg" }), true);
});
test("submission guard suppresses duplicate concurrent requests", async () => {
  const f = fixture(); let calls = 0, finish;
  const first = f.upload.single("save", async () => { calls++; await new Promise((resolve) => { finish = resolve; }); });
  await f.upload.single("save", () => { calls++; });
  assert.equal(calls, 1); finish(); await first;
  await f.upload.single("save", () => { calls++; }); assert.equal(calls, 2);
});
test("private preview embeds signed image/video and removes URL when closed", async () => {
  for (const type of ["image", "video"]) {
    const f = fixture({ previewType: type });
    await f.upload.open({ fileId: "f1", name: "成片" });
    assert.equal(f.upload.preview.open, true);
    assert.equal(f.upload.preview.type, type);
    assert.match(f.upload.preview.url, /signature=temporary/);
    assert.equal(f.requests[0].body.download, false);
    f.upload.closePreview();
    assert.equal(f.upload.preview.url, ""); assert.equal(f.upload.preview.open, false);
  }
});
test("album and video editors unwrap computed lists and expose first loaded item", () => {
  for (const [file, rowsKey, selectedKey] of [["album/album.js", "albumRows", "selectedAlbum"], ["videoSingle/videoSingle.js", "videoSingleRows", "selectedVideoSingle"]]) {
    let definition;
    const Vue = { ref: (value) => ({ value }), computed: (fn) => ({ get value() { return fn(); } }), unref: (value) => value?.value ?? value };
    const window = { Vue, LXM_PAGES: { register: (value) => { definition = value; } } };
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/views/content", file), "utf8"), { window, LXM_API: { remoteOn: () => false } });
    const result = definition.setup({ [rowsKey]: { value: [{ id: "loaded-record" }] } });
    assert.equal(result[selectedKey].value.id, "loaded-record");
  }
});
test("content audit timestamp formatter exists and handles invalid dates", () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/utils/format.js"), "utf8"), { window });
  assert.match(window.LXMFormat.dateTime("2026-09-17T03:04:05"), /^2026-09-17 03:04:05$/);
  assert.equal(window.LXMFormat.dateTime("invalid"), "");
});
function businessFixture(role = "photo") {
  const calls = [], notices = [], picks = [];
  const ctx = {
    state: { role, orderReadonly: false, orderDrawer: false }, data: { orders: [] },
    reactive: (value) => value, computed: (fn) => ({ get value() { return fn(); } }),
    roleProfile: { value: { staffId: "p1" } }, can: () => true,
    ElMessage: { warning: (text) => notices.push(text), success: (text) => notices.push(text) },
    ElMessageBox: { confirm: async () => {} },
    isOrderAfterSaleLocked: () => false, hasDeliveryRecord: (order) => !!order.deliveredAt,
    workflowStageOf: (order) => order.workflowStage,
    canDeliverOrder: (order) => ["service", "super"].includes(role) && order?.selectionStatus === "confirmed",
    async persistOrderAction(order, action, payload) {
      calls.push({ action, payload });
      if (action === "deliverydraft") { order.deliveryDraftFileIds = payload.fileIds; order.deliveryDraftFiles = payload.fileIds.map((id) => ({ fileId: id, name: id })); }
      return order;
    }
  };
  const window = { LXM_APP_PARTS: [], LXM_UPLOAD: { jobs: [], busy: () => false, ready: () => true, pick: (options) => picks.push(options), temporary: () => false, single: async (key, action) => action() } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/18-files.js"), "utf8"), { window });
  const result = window.LXM_APP_PARTS[0](ctx);
  return { ctx, ui: result, calls, notices, picks };
}
test("photographer draft upload checks task ownership and preserves existing draft files", async () => {
  const f = businessFixture();
  const order = { id: "o1", photographerId: "p1", shootingCompletedAt: "now", deliveryDraftFileIds: ["old"] };
  assert.equal(f.ui.canUploadDelivery(order), true);
  assert.equal(f.ui.canUploadDelivery({ ...order, photographerId: "p2" }), false);
  assert.equal(f.ui.canUploadDelivery({ ...order, shootingCompletedAt: "" }), false);
  f.ui.uploadDelivery(order);
  assert.equal(f.picks[0].purpose, "order-delivery"); assert.equal(f.picks[0].orderId, "o1");
  await f.picks[0].onUploaded({ fileId: "new" });
  assert.deepEqual(Array.from(f.calls[0].payload.fileIds), ["old", "new"]);
  f.ui.deliverOrder({ ...order, selectionStatus: "confirmed" });
  assert.equal(f.ui.deliveryDialog.open, false);
});
test("customer service publishes selected draft IDs; uploaded media updates captured editor", async () => {
  const f = businessFixture("service");
  const order = { id: "o1", selectionStatus: "confirmed", deliveryDraftFileIds: ["f1", "f2"] };
  f.ui.deliverOrder(order); f.ui.deliveryDialog.selected = ["f2"];
  await f.ui.publishDelivery(false);
  assert.equal(f.calls[0].action, "deliver");
  assert.deepEqual(Array.from(f.calls[0].payload.fileIds), ["f2"]);
  assert.equal(f.calls[0].payload.deliveryMethod, "小程序成片");
  const original = { id: "p1", cover: "old" }, other = { id: "p2", cover: "keep" };
  f.ui.contentFile(original, "cover", "packages");
  f.ctx.state.editContent = other;
  await f.picks[0].onUploaded({ url: "/api/media/f3" });
  assert.equal(original.cover, "/api/media/f3"); assert.equal(other.cover, "keep");
});
test("financial evidence is bound to an existing order and persisted evidence cannot be removed", async () => {
  const f = businessFixture("finance");
  f.ctx.state.adjustmentForm = { orderNo: "N1" };
  f.ui.uploadFinanceAttachment(); assert.equal(f.picks.length, 0);
  f.ctx.data.orders.push({ id: "o1", orderNo: "N1" }); f.ui.uploadFinanceAttachment();
  assert.equal(f.picks[0].purpose, "finance"); assert.equal(f.picks[0].collection, "adjustmentRecords");
  assert.equal(f.picks[0].orderId, "o1");
  const form = { attachmentFileIds: ["saved", "new"], existingAttachmentFileIds: ["saved"] };
  f.ui.removeAttachment(form, "saved"); f.ui.removeAttachment(form, "new");
  assert.deepEqual(Array.from(form.attachmentFileIds), ["saved"]);
});
test("changed Vue templates compile with the shipped Vue runtime", () => {
  const sandbox = { window: {}, console: { ...console, info() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "public/vendor/vue.global.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src/layout/app-shell.js"), "utf8"), sandbox);
  const templates = [sandbox.window.LXM_VIEWS.app, ...[
    "src/views/content/package/package.html", "src/views/content/videoSingle/videoSingle.html",
    "src/views/finance/reconciliation/reconciliation.html", "src/views/operationConfig/mini-decor/mini-decor.html", "src/views/orders/task/task.html", "src/views/content/photo/photo.html"
  ].map((name) => fs.readFileSync(path.join(root, name), "utf8"))];
  const entities = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
  for (const template of templates) assert.equal(typeof sandbox.Vue.compile(template, {
    decodeEntities: (value) => value.replace(/&(?:lt|gt|amp|quot|#39);/g, (match) => entities[match]),
    onError(error) { throw error; }
  }), "function");
});
