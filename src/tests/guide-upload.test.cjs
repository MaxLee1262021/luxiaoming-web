"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const nextTurn = () => new Promise(setImmediate);
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (value) => String(value).replace(/&(amp|quot|lt|gt|nbsp);/g, (_, name) => ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " " })[name]);
const voidTags = new Set(["br", "hr", "img", "source", "input"]);

// Small DOM test double, limited to the editor's standard node/range operations.
// It avoids network/browser dependencies; visual browser acceptance is separate.
function makeDocument() {
  const inputs = [];
  let selection;
  class Node {
    constructor(tagName, text) {
      this.nodeType = tagName ? 1 : 3; this.tagName = tagName?.toUpperCase();
      this.data = text || ""; this.childNodes = []; this.parentNode = null; this._attrs = {};
    }
    get attributes() { return Object.entries(this._attrs).map(([name, value]) => ({ name, value })); }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get parentElement() { return this.parentNode; }
    get isConnected() { return this === document.body || document.body.contains(this); }
    get className() { return this.getAttribute("class") || ""; }
    set className(value) { this.setAttribute("class", value); }
    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", value); }
    get lastChild() { return this.childNodes.at(-1) || null; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
    get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join(""); }
    set textContent(value) { this.childNodes = []; if (value) this.appendChild(new Node(null, String(value))); }
    get innerHTML() { return this.childNodes.map((node) => node.outerHTML).join(""); }
    set innerHTML(html) { this.childNodes = []; parse(String(html), this); }
    get outerHTML() {
      if (this.nodeType === 3) return escape(this.data);
      const tag = this.tagName.toLowerCase();
      return `<${tag}${Object.entries(this._attrs).map(([name, value]) => ` ${name}="${escape(value)}"`).join("")}>`
        + (voidTags.has(tag) ? "" : this.innerHTML + `</${tag}>`);
    }
    set outerHTML(html) { const fragment = new Node("fragment"); fragment.innerHTML = html; this.replaceWith(...fragment.childNodes); }
    get dataset() {
      const node = this;
      return new Proxy({}, { get(_, name) { return node.getAttribute("data-" + name.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase())); },
        set(_, name, value) { node.setAttribute("data-" + name.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase()), value); return true; } });
    }
    setAttribute(name, value) { this._attrs[name] = String(value); }
    getAttribute(name) { return Object.hasOwn(this._attrs, name) ? this._attrs[name] : null; }
    removeAttribute(name) { delete this._attrs[name]; }
    appendChild(node) { node.remove(); this.childNodes.push(node); node.parentNode = this; return node; }
    append(...nodes) { nodes.forEach((node) => this.appendChild(typeof node === "string" ? new Node(null, node) : node)); }
    insertBefore(node, before) {
      node.remove(); const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node); node.parentNode = this; return node;
    }
    removeChild(node) { node.remove(); return node; }
    remove() { if (this.parentNode) { const parent = this.parentNode; parent.childNodes.splice(parent.childNodes.indexOf(this), 1); this.parentNode = null; } }
    replaceWith(...nodes) { const parent = this.parentNode; if (!parent) return; const next = this.nextSibling; this.remove(); nodes.forEach((node) => parent.insertBefore(node, next)); }
    contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
    matches(selector) {
      const match = selector.match(/^(?:([\w-]+))?(?:\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\])?$/);
      if (selector.startsWith("#")) return this.getAttribute("id") === selector.slice(1);
      if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
      return this.nodeType === 1 && !!match && (!match[1] || this.tagName.toLowerCase() === match[1].toLowerCase())
        && (!match[2] || this.getAttribute(match[2]) !== null && (match[3] === undefined || this.getAttribute(match[2]) === match[3]));
    }
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((value) => value.trim());
      return this.childNodes.flatMap((node) => [...(selectors.some((part) => node.matches(part)) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() {}
    click() { this.clicked = true; }
    addEventListener() {}
    removeEventListener() {}
  }
  function parse(html, parent) {
    const stack = [parent];
    for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith("<!--")) continue;
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      const open = token.match(/^<([\w-]+)\b([^>]*)>/);
      if (!open) { stack.at(-1).appendChild(new Node(null, decode(token))); continue; }
      const node = new Node(open[1]);
      for (const attr of open[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
      stack.at(-1).appendChild(node);
      if (!voidTags.has(open[1].toLowerCase()) && !token.endsWith("/>")) stack.push(node);
    }
  }
  class Range {
    constructor() { this.startContainer = document.body; this.startOffset = 0; this.endContainer = this.startContainer; this.endOffset = 0; }
    get commonAncestorContainer() { return this.startContainer; }
    cloneRange() { const range = new Range(); Object.assign(range, this); return range; }
    selectNodeContents(node) { this.startContainer = this.endContainer = node; this.startOffset = 0; this.endOffset = node.childNodes.length; }
    selectNode(node) { this.startContainer = this.endContainer = node.parentNode; this.startOffset = this.startContainer.childNodes.indexOf(node); this.endOffset = this.startOffset + 1; }
    collapse(start) { if (start) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; } else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; } }
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    setStartAfter(node) { this.setStart(node.parentNode, node.parentNode.childNodes.indexOf(node) + 1); }
    setEndAfter(node) { this.setEnd(node.parentNode, node.parentNode.childNodes.indexOf(node) + 1); }
    deleteContents() { if (this.startContainer === this.endContainer) this.startContainer.childNodes.slice(this.startOffset, this.endOffset).forEach((node) => node.remove()); this.collapse(true); }
    insertNode(node) { this.startContainer.insertBefore(node, this.startContainer.childNodes[this.startOffset]); }
    createContextualFragment(html) { const node = new Node("fragment"); node.innerHTML = html; return node; }
  }
  const document = {
    body: new Node("body"),
    createElement(tag) { const node = new Node(tag); if (tag === "input") { node.files = []; inputs.push(node); } return node; },
    createTextNode(text) { return new Node(null, text); },
    createRange: () => new Range(),
    caretRangeFromPoint() { return selection.getRangeAt(0).cloneRange(); },
    querySelector(selector) { return document.body.querySelector(selector); },
    getElementById(id) { return document.body.querySelector("#" + id); },
    execCommand(command, _, html) {
      assert.equal(command, "insertHTML"); const range = selection.getRangeAt(0); range.deleteContents();
      const fragment = range.createContextualFragment(html), nodes = [...fragment.childNodes];
      const before = range.startContainer.childNodes[range.startOffset];
      nodes.forEach((node) => range.startContainer.insertBefore(node, before));
      if (nodes.length) { range.setStartAfter(nodes.at(-1)); range.endContainer = range.startContainer; range.endOffset = range.startOffset; }
      return true;
    }
  };
  selection = { ranges: [], get rangeCount() { return this.ranges.length; }, get anchorNode() { return this.ranges[0]?.startContainer; },
    getRangeAt(index) { return this.ranges[index]; }, removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges = [range]; } };
  function caret(node, offset) { const range = document.createRange(); range.selectNodeContents(node); range.setStart(node, offset); range.collapse(true); selection.addRange(range); }
  return { document, selection, caret, inputs };
}

async function fixture(options = {}) {
  const dom = makeDocument(), messages = [], requests = [], sends = [], saves = [], unmounts = [], byId = new Map();
  let sequence = 0;
  const controls = { connected: true, hold: null, holdComplete: null, failNames: new Set(options.failNames || []) };
  class FormData { constructor() { this.values = []; } append(...entry) { this.values.push(entry); } }
  class XHR {
    constructor() { this.upload = {}; }
    open(method, url) { this.url = url; }
    send(form) {
      const file = form.values.find(([key]) => key === "file")[1]; sends.push(file.name);
      this.status = controls.failNames.delete(file.name) ? 503 : 204;
      this.onload();
    }
  }
  const vue = { reactive: (value) => value, ref: (value) => ({ value }), computed: (read) => ({ get value() { return read(); } }),
    nextTick: () => Promise.resolve(), watch() {}, onBeforeUnmount(callback) { unmounts.push(callback); } };
  const window = { Vue: vue, LXM_PAGES: { register(page) { window.page = page; } },
    location: { href: "https://admin.example.test/" }, LXM_API_CONFIG: { base: "/api" },
    ElementPlus: { ElMessage: { warning: (message) => messages.push(message), error: (message) => messages.push(message) } },
    addEventListener() {}, removeEventListener() {}, getSelection: () => dom.selection,
    LXM_HTTP: { async request(url, init) {
      const body = JSON.parse(init.body || "{}"); requests.push({ url, body });
      let result;
      if (url.endsWith("upload-intent")) {
        const id = `file_${(++sequence).toString(16).padStart(32, "0")}`; byId.set(id, body);
        if (controls.hold) await controls.hold;
        result = { fileId: id, uploadUrl: `https://oss.example.test/${id}`, fields: { key: id } };
      } else if (url.endsWith("/complete")) {
        if (controls.holdComplete) await controls.holdComplete;
        const id = url.split("/").at(-2), file = byId.get(id);
        result = { fileId: id, id, name: file.fileName, size: file.size, mimeType: file.mimeType,
          type: file.mimeType.startsWith("image/") ? "image" : file.mimeType.startsWith("video/") ? "video" : "file", url: `/api/media/${id}` };
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => ({ ok: true, data: result }) };
    } }
  };
  const ctx = { state: { active: "guides", authSource: "demo", filters: {}, role: "super" },
    data: { guides: [], spots: [{ id: "spot", name: "江边" }], series: [], albums: [], packages: [] },
    can: () => true, isServerConnected: () => controls.connected,
    ElMessage: { warning: (message) => messages.push(message), error: (message) => messages.push(message), success() {} },
    ElMessageBox: { confirm: async () => true }, log() {},
    async pushContentToCloud(key, payload) { saves.push(clone(payload)); return payload; } };
  const sandbox = { window, document: dom.document, URL, Map, Set, XMLHttpRequest: XHR, FormData, console };
  vm.runInNewContext(source("src/api/upload.js"), sandbox);
  vm.runInNewContext(source("src/views/operationConfig/guide/guide.js"), sandbox);
  const page = window.page.setup(ctx), editor = dom.document.createElement("div");
  dom.document.body.appendChild(editor); page.editorRef.value = editor;
  await page.openEditor(null, { spotId: "spot" });
  Object.assign(page.ui.form, { title: "江边旅拍", cover: "/api/media/cover" });
  editor.innerHTML = "<p>前文</p><p>后文</p>";
  dom.caret(editor, 1); page.rememberSelection();
  const settle = async () => { for (let i = 0; i < 40; i++) { await nextTurn(); if (!window.LXM_UPLOAD.busy()) break; } };
  return { ...dom, window, page, ctx, editor, controls, messages, requests, sends, saves, unmounts, upload: window.LXM_UPLOAD, settle };
}

const png = (name) => ({ name, type: "image/png", size: 120 });
const mp4 = { name: "旅拍.mp4", type: "video/mp4", size: 1024 };
const pdf = { name: "拍摄说明.pdf", type: "application/pdf", size: 512 };

test("image picker uploads selected images in order into the original caret position", async () => {
  const f = await fixture();
  f.page.pickFiles("image");
  const picker = f.inputs.at(-1); assert.equal(picker.clicked, true); assert.equal(picker.multiple, true);
  let release; f.controls.hold = new Promise((resolve) => { release = resolve; });
  picker.files = [png("一.png"), png("二.png")]; picker.onchange();
  assert.equal(f.upload.busy(), true);
  assert.equal(await f.page.saveArticle(true), false);
  f.caret(f.editor, f.editor.childNodes.length); f.page.rememberSelection();
  release(); await f.settle();
  const html = f.editor.innerHTML;
  assert.deepEqual(f.sends, ["一.png", "二.png"]);
  assert.ok(html.indexOf("前文") < html.indexOf("/api/media/file_00000000000000000000000000000001"));
  assert.ok(html.indexOf("/api/media/file_00000000000000000000000000000001") < html.indexOf("/api/media/file_00000000000000000000000000000002"));
  assert.ok(html.indexOf("/api/media/file_00000000000000000000000000000002") < html.indexOf("后文"));
  assert.equal(f.saves.length, 0);
  assert.doesNotMatch(html, /blob:|data:image/);
});

test("pasted video and dropped document become native video and a persistent file anchor", async () => {
  const f = await fixture(); let prevented = false;
  await f.page.pasteContent({ preventDefault() { prevented = true; }, clipboardData: { files: [mp4] } });
  await f.settle(); assert.equal(prevented, true);
  assert.ok(f.editor.querySelector("video[src]"));
  await f.page.dropFiles({ dataTransfer: { files: [pdf] }, clientX: 100, clientY: 20 });
  await f.settle();
  const anchor = f.editor.querySelector("a[data-file-id]");
  assert.ok(anchor); assert.equal(anchor.textContent.includes(pdf.name), true);
  assert.equal(anchor.getAttribute("href"), "/api/media/file_00000000000000000000000000000002?download=1");
  const form = f.page.collectForm();
  assert.match(form.contentHtml, /data-file-id="file_00000000000000000000000000000002"/);
  assert.match(form.contentHtml, /拍摄说明\.pdf/);
  assert.match(form.contentHtml, /<video[^>]*src="\/api\/media\/file_00000000000000000000000000000001"/);
  assert.equal(form.attachments[0].fileId, "file_00000000000000000000000000000002");
  assert.equal(form.attachments[0].name, pdf.name);
  assert.equal(form.attachments[0].size, pdf.size);
  assert.equal(form.attachments[0].mimeType, pdf.type);
});

test("picker remembers its opening position even if a later selection changes before files are chosen", async () => {
  const f = await fixture();
  f.page.pickFiles("video"); const picker = f.inputs.at(-1);
  f.caret(f.editor, f.editor.childNodes.length); f.page.rememberSelection();
  picker.files = [mp4]; picker.onchange(); await f.settle();
  const html = f.editor.innerHTML;
  assert.ok(html.indexOf("前文") < html.indexOf("<video"));
  assert.ok(html.indexOf("<video") < html.indexOf("后文"));
});

test("authenticated schema-incomplete health allows uploads while article persistence stays blocked", async () => {
  const f = await fixture();
  f.ctx.state.authSource = "server"; f.controls.connected = false;
  f.window.LXM_AUTH = { hasSession: () => true };
  f.window.LXM_API_STATE = { transportReachable: true, dataError: "schema_incomplete" };
  f.page.pickFiles("image"); const picker = f.inputs.at(-1);
  picker.files = [png("新字段待更新.png")]; picker.onchange(); await f.settle();
  assert.equal(f.editor.querySelectorAll("img").length, 1);
  assert.equal(await f.page.saveArticle(true), false);
  assert.equal(f.saves.length, 0);
  assert.ok(f.messages.some((message) => message.includes("数据库")));
});

test("a health change before upload completion keeps the uploaded result at its marker", async () => {
  const f = await fixture();
  f.ctx.state.authSource = "server";
  let release; f.controls.holdComplete = new Promise((resolve) => { release = resolve; });
  f.page.pickFiles("image"); const picker = f.inputs.at(-1);
  picker.files = [png("完成前断线.png")]; picker.onchange(); await nextTurn();
  assert.ok(f.requests.some((request) => request.url.endsWith("/complete")));
  f.controls.connected = false;
  release(); await f.settle();
  assert.equal(f.upload.jobs[0].status, "done");
  assert.equal(f.editor.querySelectorAll("img").length, 1);
  assert.equal(f.editor.querySelector("span[data-guide-upload]"), null);
  assert.equal(await f.page.saveArticle(true), false);
  assert.equal(f.saves.length, 0);
});

test("retry replaces a failed image at its original position before later successful images", async () => {
  const f = await fixture({ failNames: ["一.png"] });
  f.page.pickFiles("image"); const picker = f.inputs.at(-1);
  picker.files = [png("一.png"), png("二.png")]; picker.onchange(); await f.settle();
  assert.equal(f.upload.jobs[0].status, "failed");
  assert.equal(f.upload.ready(), false);
  f.caret(f.editor, f.editor.childNodes.length); f.page.rememberSelection();
  await f.upload.retry(f.upload.jobs[0].id);
  assert.equal(f.upload.ready(), true);
  const html = f.editor.innerHTML;
  assert.ok(html.indexOf("/api/media/file_00000000000000000000000000000003") < html.indexOf("/api/media/file_00000000000000000000000000000002"));
  assert.ok(html.indexOf("/api/media/file_00000000000000000000000000000002") < html.indexOf("后文"));
  assert.equal(f.editor.querySelectorAll("img").length, 2);
});

test("a file chooser opened for a previous draft cannot upload into the replacement draft", async () => {
  const f = await fixture();
  f.page.pickFiles("image"); const picker = f.inputs.at(-1);
  await f.page.backToList(); await f.page.openEditor(null, { spotId: "spot" });
  picker.files = [png("旧草稿.png")]; picker.onchange(); await f.settle();
  assert.equal(f.requests.length, 0);
  assert.equal(f.editor.querySelectorAll("img").length, 0);
});

test("upload callbacks and retries cannot insert into a new editor after the previous page unmounts", async () => {
  const f = await fixture({ failNames: ["失败.png"] });
  f.page.pickFiles("image"); const picker = f.inputs.at(-1);
  picker.files = [png("失败.png")]; picker.onchange(); await f.settle();
  const original = f.editor.innerHTML;
  f.unmounts.forEach((callback) => callback());
  f.editor.innerHTML = "<p>另一篇正文</p>";
  await f.upload.retry(f.upload.jobs[0].id);
  assert.equal(f.editor.innerHTML, "<p>另一篇正文</p>");
  assert.notEqual(original, f.editor.innerHTML);
});

test("document uploads accept the guide attachment allowlist and reject oversized, executable or other-collection files", async () => {
  const f = await fixture();
  const scope = { purpose: "content", collection: "guides", documentsOnly: true };
  assert.doesNotThrow(() => f.upload.validate(pdf, scope));
  assert.doesNotThrow(() => f.upload.validate({ ...pdf, type: "" }, scope));
  assert.throws(() => f.upload.validate({ ...pdf, size: 21 * 1024 * 1024 }, scope));
  assert.throws(() => f.upload.validate({ name: "app.exe", type: "application/octet-stream", size: 50 }, scope));
  assert.throws(() => f.upload.validate({ ...pdf, type: "text/html" }, scope));
  assert.throws(() => f.upload.validate(pdf, { purpose: "content", collection: "albums" }));
  assert.equal(f.requests.length, 0);
});

test("dismissing a failed upload removes its placeholder and allows saving the remaining article", async () => {
  const f = await fixture({ failNames: ["取消.png"] });
  f.page.pickFiles("image"); const picker = f.inputs.at(-1);
  picker.files = [png("取消.png")]; picker.onchange(); await f.settle();
  assert.equal(f.upload.ready(), false);
  assert.ok(f.editor.querySelector("span[data-guide-upload]"));
  f.upload.dismiss(f.upload.jobs[0].id);
  assert.equal(f.editor.querySelector("span[data-guide-upload]"), null);
  assert.equal(f.upload.ready(), true);
  assert.equal(await f.page.saveArticle(false), true);
  assert.doesNotMatch(f.saves[0].contentHtml, /data-guide-upload/);
});
