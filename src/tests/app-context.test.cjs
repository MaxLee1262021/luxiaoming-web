"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

async function fixture() {
  const notices = [], confirmations = [], errors = [];
  const controls = { acceptLeave: true, uploadBusy: false };
  let provided;
  const helpers = {
    ElMessage: Object.fromEntries(["warning", "error", "success"].map((type) => [type, (message) => notices.push({ type, message })])),
    ElMessageBox: { async confirm(...args) { confirmations.push(args); if (!controls.acceptLeave) throw new Error("cancel"); } }
  };
  const base = {
    state: { active: "guides", authSource: "demo", filters: {}, role: "super" },
    data: { guides: [], spots: [], series: [], albums: [], packages: [] },
    can: () => true, isServerConnected: () => false
  };
  const Vue = {
    reactive: (value) => value, computed: (read) => ({ get value() { return read(); } }),
    ref: (value) => ({ value }), watch() {}, onMounted() {}, onBeforeUnmount() {}, nextTick: () => Promise.resolve(),
    provide(key, value) { assert.equal(key, "lxm"); provided = value; },
    createApp(options) { return { component() {}, use() {}, mount() { options.setup(); } }; }
  };
  const window = {
    Vue, LXM_APP_PARTS: [() => base],
    LXM_PAGES: { register(page) { window.page = page; }, components: () => ({}) },
    LXM_UPLOAD: { busy: () => controls.uploadBusy }, addEventListener() {}, removeEventListener() {}
  };
  const sandbox = { window, Vue, ElementPlus: helpers, LXM_VIEWS: { app: "<div></div>" }, LXM_CONFIG: {}, LXM_SERVICE: {},
    console: { error: (error) => errors.push(error) }, document: { getElementById: () => null } };
  vm.createContext(sandbox);
  // Exercise the production assembly boundary rather than injecting UI helpers
  // straight into a page fixture, which would hide a missing provide export.
  vm.runInContext(read("src/app.js"), sandbox);
  await new Promise(setImmediate);
  assert.deepEqual(errors, []);
  assert.ok(provided, "the root app provides its assembled view model");
  vm.runInContext(read("src/views/operationConfig/guide/guide.js"), sandbox);
  const page = window.page.setup(provided);
  return { provided, helpers, page, controls, notices, confirmations };
}

test("the production app context provides message and confirmation helpers to routed pages", async () => {
  const f = await fixture();
  assert.equal(f.provided.ElMessage, f.helpers.ElMessage);
  assert.equal(f.provided.ElMessageBox, f.helpers.ElMessageBox);
  assert.equal(typeof f.provided.ElMessageBox.confirm, "function");
});

test("returning to the list after a completed upload prompts and honors the decision using the actual provided context", async () => {
  const f = await fixture();
  f.page.ui.mode = "edit";
  f.page.ui.form = { contentHtml: '<p>已上传</p><img src="/api/media/uploaded-image">' };
  f.page.markDirty();
  f.controls.acceptLeave = false;
  await f.page.backToList();
  assert.equal(f.confirmations.length, 1, "the confirmation must open instead of swallowing a missing-helper exception");
  assert.equal(f.page.ui.mode, "edit");
  assert.equal(f.page.ui.form.contentHtml, '<p>已上传</p><img src="/api/media/uploaded-image">');
  assert.equal(f.page.ui.dirty, true);
  f.controls.acceptLeave = true;
  await f.page.backToList();
  assert.equal(f.confirmations.length, 2);
  assert.equal(f.page.ui.mode, "list");
});

test("an unchanged editor returns directly without opening a discard confirmation", async () => {
  const f = await fixture();
  f.page.ui.mode = "edit";
  f.page.ui.dirty = false;
  await f.page.backToList();
  assert.equal(f.page.ui.mode, "list");
  assert.equal(f.confirmations.length, 0);
});

test("unexpected confirmation failures surface a message and retain the draft", async () => {
  const f = await fixture();
  f.page.ui.mode = "edit";
  f.page.markDirty();
  f.helpers.ElMessageBox.confirm = async () => { throw new Error("dialog unavailable"); };
  await f.page.backToList();
  assert.equal(f.page.ui.mode, "edit");
  assert.ok(f.notices.some((notice) => notice.type === "error"));
});

test("returning during an upload displays the wait message instead of throwing through the provided context", async () => {
  const f = await fixture();
  f.page.ui.mode = "edit";
  f.page.markDirty();
  f.controls.uploadBusy = true;
  await f.page.backToList();
  assert.equal(f.page.ui.mode, "edit");
  assert.equal(f.confirmations.length, 0);
  assert.ok(f.notices.some((notice) => notice.type === "warning" && notice.message.includes("上传完成")));
});
