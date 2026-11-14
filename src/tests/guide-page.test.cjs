"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (rows) => Array.from(rows, (row) => row.id || row._id);
const computed = (read) => ({ get value() { return read(); } });

// These tests exercise state transitions and save requests with controlled HTML.
// Browser DOM editing and sanitizer coverage live in browser QA / guide-flow.
function documentStub() {
  return { createElement() {
    return {
      innerHTML: "", childNodes: [],
      get textContent() { return this.innerHTML.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " "); },
      querySelectorAll() {
        return Array.from(this.innerHTML.matchAll(/<(img|video)\b[^>]*\bsrc="([^"]+)"[^>]*>/g), (match) => ({
          tagName: match[1].toUpperCase(), getAttribute(name) { return name === "src" ? match[2] : ""; }, querySelector() { return null; }
        }));
      }
    };
  } };
}

async function fixture() {
  const messages = [], mutations = [], saves = [], loaded = [], loadOptions = [], listeners = new Map(), unmounts = [];
  const controls = { connected: true, canEdit: true, uploadBusy: false, confirm: true };
  const window = {
    Vue: { computed, ref: (value) => ({ value }), reactive: (value) => value,
      nextTick: () => Promise.resolve(),
      watch(read, callback, options) { if (options?.immediate) callback(read()); },
      onBeforeUnmount(callback) { unmounts.push(callback); } },
    LXM_UPLOAD: { busy: () => controls.uploadBusy, ready: () => !controls.uploadBusy },
    LXM_PAGES: { register(page) { window.page = page; } },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const ctx = {
    state: { active: "guides", authSource: "server", filters: {}, role: "super" },
    data: {
      guides: [], spots: [{ id: "a", name: "江边", city: "长沙" }, { id: "b", name: "古城", city: "长沙" }],
      series: [{ id: "style-a", spotIds: ["a"] }],
      albums: [{ id: "photo", name: "照片留影", seriesId: "style-a", status: "上架" }, { id: "off", name: "下架照片", spotId: "a", status: "下架" }],
      packages: [{ id: "package", name: "套餐", spotId: "b", status: "上架" }, { id: "video", name: "短片", type: "video", isVideoSingle: true, spotId: "a", status: "上架" }]
    },
    can: () => controls.canEdit, isServerConnected: () => controls.connected,
    ElMessage: Object.fromEntries(["warning", "success", "error"].map((type) => [type, (message) => messages.push({ type, message })])),
    ElMessageBox: { async confirm() { if (!controls.confirm) throw new Error("cancel"); } },
    async loadAuthenticatedData(key, options) { loaded.push(key); loadOptions.push(plain(options)); return { ok: true }; },
    async persistContentMutation(key, row, previous) { mutations.push({ key, row: plain(row), previous: previous && plain(previous) }); return true; },
    async pushContentToCloud(key, payload) { saves.push({ key, payload: plain(payload) }); return payload; },
    async persistTrashRecord() { return true; },
    currentOperatorName: () => "管理员", log() {}
  };
  vm.runInNewContext(source("src/views/operationConfig/guide/guide.js"), { window, document: documentStub(), console });
  const page = window.page.setup(ctx);
  await new Promise(setImmediate);
  return { ctx, page, controls, messages, mutations, saves, loaded, loadOptions, listeners, unmounts };
}

function validForm(page, extra = {}) {
  page.ui.mode = "edit";
  page.ui.form = { title: "江边旅拍", cover: "/api/media/cover", contentHtml: "<p>傍晚去江边拍照。</p>", spotIds: ["a"], isShow: true, ...extra };
  page.ui.dirty = true;
}

test("guide setup joins navigation loading and explicit reload requests fresh data", async () => {
  const f = await fixture();
  assert.deepEqual(f.loadOptions, [{ force: true, joinPending: true }]);
  await f.page.loadGuideData();
  assert.deepEqual(f.loadOptions[1], { force: true, joinPending: false });
});

test("guide list treats publication and visibility independently, with pins before update time", async () => {
  const f = await fixture();
  f.ctx.data.guides.push(
    { id: "new", title: "新发布", status: "已发布", isShow: true, spotIds: ["a"], updatedAt: "2026-11-04T09:00:00Z" },
    { id: "hidden", title: "隐藏发布", status: "已发布", isShow: false, spotIds: ["b"], updatedAt: "2026-11-03T09:00:00Z" },
    { id: "pin", title: "置顶草稿", status: "草稿", isShow: true, isTop: true, spotIds: ["a", "b"], updatedAt: "2026-11-01T09:00:00Z" },
    { id: "deleted", deleted: true }
  );
  assert.deepEqual(ids(f.page.guideRows.value), ["pin", "new", "hidden"]);
  assert.equal(f.page.guideTotal.value, 3);
  f.page.ui.filter = "published";
  assert.deepEqual(ids(f.page.guideRows.value), ["new", "hidden"]);
  f.page.ui.filter = "draft";
  assert.deepEqual(ids(f.page.guideRows.value), ["pin"]);
  const draft = f.ctx.data.guides[2];
  await f.page.toggleGuide(draft);
  assert.equal(draft.status, "草稿");
  assert.equal(draft.isShow, false, JSON.stringify({ ui: f.page.ui, messages: f.messages }));
  assert.equal(f.page.isPublished(draft), false);
  await f.page.pinGuide(f.ctx.data.guides[0]);
  assert.equal(f.ctx.data.guides[0].isTop, true);
  f.page.ui.filter = "all";
  f.ctx.state.filters.contentSpotId = "b";
  f.ctx.state.filters.keyword = "古城";
  assert.deepEqual(ids(f.page.guideRows.value), ["pin", "hidden"]);
});

test("multiple points offer their own available products and retain one product across all groups", async () => {
  const f = await fixture();
  assert.deepEqual(f.loaded, ["guides"]);
  await f.page.openEditor(null, { spotId: "a" });
  f.page.addSpot(f.ctx.data.spots[1]);
  assert.deepEqual(plain(f.page.ui.form.spotIds), ["a", "b"]);
  assert.deepEqual(ids(f.page.productsForSpot("a")), ["photo", "video"]);
  const photo = f.page.productsForSpot("a")[0], product = f.page.productsForSpot("b")[0];
  f.page.selectProduct("a", photo);
  f.page.selectProduct("b", product);
  assert.equal(f.page.ui.form.targetProductId, "package");
  assert.equal(f.page.ui.form.targetProductSpotId, "b");
  f.page.removeSpot("a");
  assert.equal(f.page.ui.form.targetProductId, "package");
  f.page.removeSpot("b");
  assert.equal(f.page.ui.form.targetProductId, "");
  assert.equal(f.page.ui.form.targetProductType, "");
  assert.equal(f.page.ui.form.targetProductSpotId, "");
  assert.equal(f.page.ui.form.spotId, "");
});

test("failed visibility and pin writes restore exact record keys and values", async () => {
  const f = await fixture();
  const row = { id: "guide", title: "历史文章", status: "已发布" };
  const before = plain(row);
  f.ctx.persistContentMutation = async () => false;
  await f.page.toggleGuide(row);
  assert.deepEqual(row, before);
  await f.page.pinGuide(row);
  assert.deepEqual(row, before);
  assert.equal(f.page.ui.saving, false);
  assert.equal(f.messages.some((message) => message.type === "success"), false);
});

test("failed recycle-bin persistence restores the record and sends explicit deletion rollback flags", async () => {
  const f = await fixture();
  const row = { id: "guide", title: "历史文章", status: "已发布", isShow: false };
  const before = plain(row);
  f.ctx.persistTrashRecord = async () => false;
  await f.page.deleteGuide(row);
  assert.deepEqual(row, before);
  assert.equal(f.mutations.length, 2);
  assert.equal(f.mutations[0].row.deleted, true);
  assert.equal(f.mutations[1].row.deleted, false);
  assert.equal(f.mutations[1].row.isDeleted, false);
  assert.equal(f.page.ui.saving, false);
  assert.ok(f.messages.some((message) => message.type === "error"));
});

test("real-session disconnection blocks saving, pinning, visibility and deletion before local mutation", async () => {
  const f = await fixture();
  validForm(f.page);
  const row = { id: "guide", status: "已发布", isShow: false }, before = plain(row);
  f.controls.connected = false;
  assert.equal(await f.page.saveArticle(true), false);
  await f.page.toggleGuide(row);
  await f.page.pinGuide(row);
  await f.page.deleteGuide(row);
  assert.deepEqual(row, before);
  assert.equal(f.ctx.data.guides.length, 0);
  assert.equal(f.saves.length, 0);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.page.ui.dirty, true);
  assert.equal(f.messages.some((message) => message.type === "success"), false);
});

test("failed dependency loading blocks writes until a successful explicit retry", async () => {
  const f = await fixture();
  validForm(f.page);
  f.ctx.loadAuthenticatedData = async () => ({ ok: false, failed: ["packages"] });
  await f.page.loadGuideData();
  assert.ok(f.page.ui.loadError);
  assert.equal(await f.page.saveArticle(true), false);
  assert.equal(f.saves.length, 0);
  f.ctx.loadAuthenticatedData = async () => ({ ok: true });
  await f.page.loadGuideData();
  assert.equal(f.page.ui.loadError, "");
  assert.equal(await f.page.saveArticle(true), true);
  assert.equal(f.saves.length, 1);
});

test("legacy demo sessions cannot save locally without a real server connection", async () => {
  const f = await fixture();
  validForm(f.page);
  f.ctx.state.authSource = "demo";
  f.controls.connected = false;
  assert.equal(await f.page.saveArticle(false), false);
  assert.equal(f.ctx.data.guides.length, 0);
  assert.equal(f.saves.length, 0);
  assert.ok(f.messages.some((message) => message.type === "warning" && message.message.includes("连接不可用")));
  assert.equal(f.page.frontVisible({ isShow: "false" }), false);
  assert.equal(f.page.frontVisible({ visible: "0" }), false);
  assert.equal(f.page.frontVisible({ enabled: 0 }), false);
});

test("saving a multi-point article preserves hidden state and moves draft to published explicitly", async () => {
  const f = await fixture();
  validForm(f.page, { spotIds: ["a", "b"], isShow: false, targetProductType: "package", targetProductId: "package", targetProductSpotId: "b" });
  assert.equal(await f.page.saveArticle(false), true);
  assert.equal(f.saves[0].payload.status, "草稿");
  assert.deepEqual(f.saves[0].payload.spotIds, ["a", "b"]);
  assert.equal(f.saves[0].payload.spotId, "a");
  assert.equal(f.saves[0].payload.targetProductSpotId, "b");
  assert.equal(f.saves[0].payload.isShow, false);
  assert.equal(f.page.ui.mode, "edit");
  assert.equal(await f.page.saveArticle(true), true);
  assert.equal(f.ctx.data.guides.length, 1);
  assert.equal(f.ctx.data.guides[0].status, "已发布");
  assert.equal(f.ctx.data.guides[0].isShow, false);
  assert.equal(f.page.ui.mode, "list");
});

test("pending save prevents duplicate requests and leaving; failed save keeps the editable draft", async () => {
  const f = await fixture();
  validForm(f.page);
  let finish;
  f.ctx.pushContentToCloud = async (key, payload) => {
    f.saves.push({ key, payload: plain(payload) });
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = f.page.saveArticle(true);
  assert.equal(f.page.ui.saving, true);
  assert.equal(await f.page.saveArticle(true), false);
  assert.equal(await f.ctx.state.guideLeaveGuard(), false);
  await f.page.backToList();
  assert.equal(f.page.ui.mode, "edit");
  assert.equal(f.saves.length, 1);
  finish(null);
  assert.equal(await first, false);
  assert.equal(f.page.ui.saving, false);
  assert.equal(f.page.ui.dirty, true);
  assert.equal(f.page.ui.form.title, "江边旅拍");
  assert.equal(f.ctx.data.guides.length, 0);
});

test("late save responses cannot populate runtime data after unmount or session loss", async () => {
  for (const abandon of ["unmount", "session"]) {
    const f = await fixture();
    validForm(f.page);
    let finish, saved;
    f.ctx.pushContentToCloud = async (key, payload) => {
      saved = payload;
      return new Promise((resolve) => { finish = resolve; });
    };
    const pending = f.page.saveArticle(true);
    if (abandon === "unmount") f.unmounts.forEach((callback) => callback());
    else f.ctx.state.authSource = "";
    finish(saved);
    assert.equal(await pending, false);
    assert.equal(f.ctx.data.guides.length, 0);
    assert.equal(f.messages.some((message) => message.type === "success"), false);
  }
});

test("leave guard respects confirmation, ongoing uploads and browser/unmount lifecycle", async () => {
  const f = await fixture();
  validForm(f.page);
  f.controls.confirm = false;
  assert.equal(await f.ctx.state.guideLeaveGuard(), false);
  await f.page.backToList();
  assert.equal(f.page.ui.mode, "edit");
  f.controls.confirm = true;
  f.controls.uploadBusy = true;
  assert.equal(await f.ctx.state.guideLeaveGuard(), false);
  f.controls.uploadBusy = false;
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  f.listeners.get("beforeunload")(event);
  assert.equal(prevented, true);
  await f.page.backToList();
  assert.equal(f.page.ui.mode, "list");
  f.unmounts.forEach((callback) => callback());
  assert.equal(f.ctx.state.guideLeaveGuard, null);
  assert.equal(f.listeners.has("beforeunload"), false);
});

function authFixture() {
  const loads = [], loadOptions = [], logoutCalls = [];
  const config = { menus: [{ key: "guides" }, { key: "spots" }], roles: { super: { menus: ["guides", "spots"] } } };
  const window = {
    LXM_APP_PARTS: [], addEventListener() {},
    LXM_AUTH: { getSession: () => null, hasSession: () => true, logout() { logoutCalls.push(true); return Promise.resolve(); } },
    LXM_CLOUD: { async loadMenuData(key, data, state, options) { loads.push(key); loadOptions.push(plain(options)); return { ok: true }; } }
  };
  const ctx = { data: {}, state: { active: "guides", filters: {}, login: {}, menuRevision: 0 },
    ElMessage: { warning() {}, error() {}, success() {} }, roleProfile: { value: config.roles.super },
    contentKeys: ["guides", "spots"], log() {}, canPreviewRoles: { value: true } };
  vm.runInNewContext(source("src/app/03-auth.js"), { window, LXM_CONFIG: config, console });
  Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  Object.assign(ctx.state, { authSource: "server", authed: true, currentAccount: "管理员" });
  return { ctx, window, loads, loadOptions, logoutCalls };
}

test("authenticated guide loading forwards pending sharing only when requested", async () => {
  const f = authFixture();
  await f.ctx.loadAuthenticatedData("guides", { force: true, joinPending: true });
  await f.ctx.switchMenu("spots");
  assert.deepEqual(f.loadOptions, [{ force: true, joinPending: true }, { force: true, joinPending: false }]);
  assert.equal(f.ctx.state.dataLoading, false);
  assert.equal(f.ctx.state.menuDataLoadingKey, "");
});

test("an earlier authenticated load cannot clear a later load's indicator or replace its notice", async () => {
  const f = authFixture(), replies = [];
  f.window.LXM_CLOUD.loadMenuData = () => new Promise((resolve) => replies.push(resolve));
  const earlier = f.ctx.loadAuthenticatedData("guides");
  const later = f.ctx.loadAuthenticatedData("spots");
  f.ctx.state.authNotice = "当前提示";
  replies[0]({ ok: true, failed: ["guides"] });
  await earlier;
  assert.equal(f.ctx.state.dataLoading, true);
  assert.equal(f.ctx.state.menuDataLoadingKey, "spots");
  assert.equal(f.ctx.state.authNotice, "当前提示");
  replies[1]({ ok: true, failed: ["spots"] });
  await later;
  assert.equal(f.ctx.state.dataLoading, false);
  assert.equal(f.ctx.state.authNotice, "菜单数据部分加载失败：spots");
});

test("menu navigation waits for the guide leave decision before changing the route or loading data", async () => {
  const f = authFixture();
  let answer;
  f.ctx.state.guideLeaveGuard = () => new Promise((resolve) => { answer = resolve; });
  const blocked = f.ctx.switchMenu("spots");
  assert.equal(f.ctx.state.active, "guides");
  assert.deepEqual(f.loads, []);
  answer(false);
  await blocked;
  assert.equal(f.ctx.state.active, "guides");
  assert.deepEqual(f.loads, []);
  f.ctx.state.guideLeaveGuard = async () => true;
  await f.ctx.switchMenu("spots");
  assert.equal(f.ctx.state.active, "spots");
  assert.deepEqual(f.loads, ["spots"]);
});

test("logout preserves the session and runtime data until the guide leave guard accepts", async () => {
  const f = authFixture();
  f.ctx.data.guides = [{ id: "saved-guide" }];
  f.ctx.state.guideLeaveGuard = async () => false;
  await f.ctx.logout();
  assert.equal(f.ctx.state.authed, true);
  assert.equal(f.ctx.state.currentAccount, "管理员");
  assert.deepEqual(ids(f.ctx.data.guides), ["saved-guide"]);
  assert.equal(f.logoutCalls.length, 0);
  f.ctx.state.guideLeaveGuard = async () => true;
  await f.ctx.logout();
  assert.equal(f.ctx.state.authed, false);
  assert.equal(f.ctx.state.currentAccount, "");
  assert.deepEqual(ids(f.ctx.data.guides), []);
  assert.equal(f.logoutCalls.length, 1);
});
