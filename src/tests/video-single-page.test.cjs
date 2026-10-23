"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const ids = (rows) => Array.from(rows, (row) => row.id || row._id);
const single = (id, extra = {}) => ({ id, title: id, type: "video", isVideoSingle: true, status: "上架", isShow: true, ...extra });

function fixture(options = {}) {
  const messages = [];
  const writes = [];
  const trash = [];
  const uploads = [];
  const mounted = [];
  const unmounted = [];
  const watchers = [];
  let connected = options.connected !== false;
  let session = options.remote !== false;
  let remoteStored = options.remoteStored === true;
  let serverRows = clone(options.serverRows || []);
  let load = async () => clone(serverRows);
  let failWrites = false;
  let failTrash = false;
  const computed = (getter) => ({ get value() { return getter(); } });
  const Vue = {
    ref: (value) => ({ value }), computed,
    onMounted: (callback) => mounted.push(callback),
    onBeforeUnmount: (callback) => unmounted.push(callback),
    watch(getter, callback) { watchers.push({ getter, callback, previous: getter() }); }
  };
  const message = (value) => messages.push(value);
  Object.assign(message, { warning: message, error: message, success: message });
  const api = {
    remoteOn: () => remoteStored,
    setRemote: (value) => { remoteStored = value; },
    async loadCollection(key) {
      assert.equal(key, "packages");
      assert.equal(remoteStored, true, "enable remote before the guarded collection request");
      return load();
    }
  };
  const window = {
    Vue, LXM_API: api, ElMessage: message,
    LXM_AUTH: { hasSession: () => session },
    get LXM_CLOUD_MODE() { return connected ? "mysql" : "mock"; },
    LXM_API_STATE: { get reachable() { return connected; } },
    LXM_UPLOAD: { ready: () => true, single: async (_key, callback) => callback(), upload: (file, options) => uploads.push({ file, ...options }) },
    LXM_PAGES: { register(page) { window.page = page; } },
    LXM_CLOUD: {
      async update(key, id, payload) {
        if (failWrites) throw new Error("模拟保存失败");
        writes.push({ key, id, payload: clone(payload) });
        const existing = serverRows.find((row) => (row.id || row._id) === id);
        if (existing) Object.assign(existing, clone(payload));
        return { ...payload, id, _id: id };
      }
    }
  };
  const ctx = {
    computed, ElMessage: message,
    data: { packages: clone(options.localRows || []), series: [], spots: [] },
    state: { authSource: session ? "server" : "demo", filters: {}, videoSingleDialog: false },
    log() {}, currentOperatorName: () => "测试管理员",
    money: (value) => value, seriesName: (value) => value, spotName: (value) => value,
    persistTrashRecord: async (row) => { if (failTrash) return false; trash.push(row); return true; }
  };
  const sandbox = { window, LXM_API: api, console, LXMFormat: { nowText: () => "2026-10-22", dateTime: () => "2026-10-22" } };
  vm.runInNewContext(read("src/app/12-content-edit.js"), sandbox, { filename: "12-content-edit.js" });
  Object.assign(ctx, window.LXM_APP_PARTS[0](ctx));
  vm.runInNewContext(read("src/views/content/videoSingle/videoSingle.js"), sandbox, { filename: "videoSingle.js" });
  const page = window.page.setup(ctx);
  return {
    ctx, page, writes, messages, trash, uploads,
    mount: async () => { for (const callback of mounted) await callback(); },
    unmount: () => unmounted.forEach((callback) => callback()),
    setConnected: (value) => { connected = value; },
    setLoad: (callback) => { load = callback; },
    setRows: (rows) => { serverRows = clone(rows); },
    failWrites: () => { failWrites = true; },
    failTrash: () => { failTrash = true; },
    async expireSession() {
      session = false;
      ctx.state.authSource = "";
      for (const watcher of watchers) {
        const next = watcher.getter();
        if (next !== watcher.previous) await watcher.callback(next, watcher.previous);
        watcher.previous = next;
      }
    }
  };
}

test("local and remote video singles accept either explicit marker and exclude legacy packages and deleted rows", async () => {
  const rows = [
    single("flag"),
    { id: "kind", type: "video", productKind: "video_single" },
    { id: "category", category: "短视频", isVideoSingle: true },
    { id: "legacy", type: "video" },
    single("deleted", { deleted: true }),
    single("isDeleted", { isDeleted: true }),
    { id: "photo", type: "photo", isVideoSingle: true },
    { id: "truthy", type: "video", isVideoSingle: "true" }
  ];
  const f = fixture({ remote: false, localRows: rows });
  assert.deepEqual(ids(f.page.listSource.value), ["flag", "kind", "category"]);
  assert.deepEqual(ids(f.ctx.videoSingleRows.value), ["flag", "kind", "category"]);
  f.setRows(rows);
  await f.page.toggleRemote();
  assert.deepEqual(ids(f.page.listSource.value), ["flag", "kind", "category"]);
  assert.equal(f.page.videoSingleSummary.value.total, 3);
});

test("six real off-shelf rows share the same statistics, list, and editor instead of showing zero local totals", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => single(`real-${index}`, { status: "下架", isShow: false }));
  const f = fixture({ serverRows: rows });
  assert.equal(f.page.remoteOn.value, true, "authenticated servers override a stale local switch preference");
  assert.equal(f.page.listSource.value.length, 0, "remote loading never exposes demo rows");
  await f.mount();
  assert.equal(f.page.videoSingleSummary.value.total, 6);
  assert.equal(f.page.videoSingleSummary.value.onSale, 0);
  assert.equal(f.page.listSource.value.length, 6);
  assert.equal(f.ctx.videoSingleRows.value.length, 6);
  assert.equal(f.page.selectedVideoSingle.value, f.ctx.data.packages[0]);
  const event = { target: { checked: false } };
  f.page.toggleRemote(event);
  assert.equal(f.page.remoteOn.value, true);
  assert.equal(event.target.checked, true, "keep the checkbox consistent when a real session cannot switch to demo");
});

test("remote loading, empty responses, and failures never fall back to bundled demo rows", async () => {
  const f = fixture({ localRows: [single("demo")] });
  assert.equal(f.page.listSource.value.length, 0);
  f.setLoad(async () => { throw new Error("接口不可用"); });
  await f.mount();
  assert.equal(f.page.remoteOn.value, true);
  assert.equal(f.page.videoSingleSummary.value.total, 0);
  assert.equal(f.page.selectedVideoSingle.value, null);
  assert.equal(f.ctx.data.packages[0].id, "demo", "retained shared data must stay hidden on a failed remote load");
  assert.match(f.page.remoteError.value, /接口不可用/);
  f.page.openVideoSingle();
  assert.equal(f.ctx.state.videoSingleDialog, false);
  assert.equal(await f.page.saveSelectedVideoSingle(), false);
  f.setLoad(async () => []);
  assert.equal(await f.page.refreshFromServer(), true);
  assert.equal(f.page.remoteError.value, "");
  assert.equal(f.page.videoSingleSummary.value.total, 0);
  assert.equal(f.ctx.data.packages.length, 0);
});

test("remote filters drive totals and selected rows together, including spotIds, seriesIds, tags, and status", async () => {
  const f = fixture({ serverRows: [
    single("night", { spotIds: ["spot-1"], seriesIds: ["series-1"], tags: ["夜景"], isMainPush: true }),
    single("draft", { spotId: "spot-1", seriesId: "series-1", status: "草稿" }),
    single("pending", { status: "待审核", mainPush: true }),
    single("hidden", { isShow: false }),
    single("audit-pending", { auditStatus: "待审核" }),
    single("invisible", { visible: false }),
    single("disabled", { enabled: false }),
    single("audit-passed", { auditStatus: "approved" })
  ] });
  await f.mount();
  assert.equal(f.page.videoSingleSummary.value.onSale, 2, "drafts, failed audits, review rows and hidden/disabled rows are not on sale");
  assert.equal(f.page.videoSingleSummary.value.pending, 2);
  assert.equal(f.page.videoSingleSummary.value.mainPush, 2);
  Object.assign(f.ctx.state.filters, { contentSpotId: "spot-1", contentSeriesId: "series-1", contentStatus: "上架", keyword: "夜景" });
  assert.deepEqual(ids(f.page.listSource.value), ["night"]);
  assert.equal(f.page.videoSingleSummary.value.total, 1);
  assert.equal(f.page.selectedVideoSingle.value.id, "night");
  f.ctx.state.filters.keyword = "无结果";
  assert.equal(f.page.videoSingleSummary.value.total, 0);
  assert.equal(f.page.selectedVideoSingle.value, null);
  f.ctx.state.filters = {};
  assert.equal(f.page.videoSingleSummary.value.total, 8);
});

test("only an explicit demo context can turn off remote mode, restoring its own original data", async () => {
  const f = fixture({ remote: false, localRows: [single("demo")], serverRows: [single("real")] });
  assert.deepEqual(ids(f.page.listSource.value), ["demo"]);
  await f.page.toggleRemote();
  assert.deepEqual(ids(f.page.listSource.value), ["real"]);
  f.page.toggleRemote();
  assert.equal(f.page.remoteOn.value, false);
  assert.deepEqual(ids(f.ctx.data.packages), ["demo"]);
  const server = fixture({ serverRows: [single("server")] });
  await server.mount();
  await server.expireSession();
  server.page.toggleRemote();
  assert.equal(server.page.remoteOn.value, true, "an expired server session cannot relabel server rows as demo data");
});

test("save, shelf changes, delete, advanced edits, and additions update the same fetched data pool", async () => {
  const f = fixture({ serverRows: [single("a"), { _id: "b", title: "b", type: "video", productKind: "video_single", status: "上架" }] });
  await f.mount();
  const a = f.page.selectedVideoSingle.value;
  a.title = "更新名称";
  a.status = "草稿";
  assert.equal(await f.page.saveSelectedVideoSingle(), true);
  assert.equal(f.writes.at(-1).payload.name, "更新名称");
  assert.equal(f.writes.at(-1).payload.isShow, false);
  assert.equal(f.page.videoSingleSummary.value.onSale, 1);
  assert.equal(await f.page.toggleVideoSingleShelf(a), true);
  assert.equal(a.status, "下架");
  assert.equal(await f.page.toggleVideoSingleShelf(a), true);
  assert.equal(f.page.videoSingleSummary.value.onSale, 2);
  assert.equal(await f.page.deleteVideoSingle(a), true);
  assert.deepEqual(ids(f.page.listSource.value), ["b"]);
  assert.equal(f.page.videoSingleSummary.value.total, 1);
  assert.equal(f.page.selectedVideoSingle.value.id, "b");
  assert.equal(f.trash.length, 1);
  f.page.openVideoSingle(f.page.selectedVideoSingle.value);
  f.ctx.state.videoSingleForm.title = "高级编辑";
  assert.equal(await f.ctx.saveVideoSingle(), true);
  assert.equal(f.page.selectedVideoSingle.value.title, "高级编辑");
  f.page.openVideoSingle();
  f.ctx.state.videoSingleForm.title = "新单品";
  assert.equal(await f.ctx.saveVideoSingle(), true);
  assert.equal(f.page.videoSingleSummary.value.total, 2);
  assert.equal(f.page.listSource.value[0].title, "新单品");
});

test("disconnected real sessions block both page actions and an already open advanced dialog", async () => {
  const f = fixture({ serverRows: [single("real")] });
  await f.mount();
  const row = f.page.selectedVideoSingle.value;
  f.page.openVideoSingle(row);
  f.ctx.state.videoSingleForm.title = "不能本地保存";
  f.setConnected(false);
  assert.equal(await f.page.saveSelectedVideoSingle(), false);
  assert.equal(await f.page.deleteVideoSingle(row), false);
  assert.equal(await f.page.toggleVideoSingleShelf(row), false);
  assert.equal(await f.ctx.saveVideoSingle(), false);
  assert.equal(await f.ctx.deleteVideoSingle(row), false);
  assert.equal(await f.ctx.toggleVideoSingleShelf(row), false);
  assert.equal(f.writes.length, 0);
  assert.equal(row.title, "real");
  assert.equal(row.deleted, undefined);
  assert.equal(f.ctx.state.videoSingleDialog, true);
});

test("failed persistence restores delete and shelf state in the shared list", async () => {
  const f = fixture({ serverRows: [single("real")] });
  await f.mount();
  const row = f.page.selectedVideoSingle.value;
  f.failWrites();
  assert.equal(await f.page.deleteVideoSingle(row), false);
  assert.equal(f.page.videoSingleSummary.value.total, 1);
  assert.equal(row.deleted, false);
  assert.equal(row.isDeleted, false);
  assert.equal(await f.page.toggleVideoSingleShelf(row), false);
  assert.equal(row.status, "上架");
  assert.equal(f.page.videoSingleSummary.value.onSale, 1);
  assert.equal(f.trash.length, 0);
});

test("a failed trash write rolls back deletion with explicit false flags on the server", async () => {
  const f = fixture({ serverRows: [single("real")] });
  await f.mount();
  f.failTrash();
  assert.equal(await f.page.deleteVideoSingle(f.page.selectedVideoSingle.value), false);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].payload.deleted, true);
  assert.equal(f.writes[1].payload.deleted, false);
  assert.equal(f.writes[1].payload.isDeleted, false);
  await f.page.refreshFromServer();
  assert.equal(f.page.videoSingleSummary.value.total, 1);
});

test("stale, unmounted, and expired-session requests cannot replace newer shared data", async () => {
  const f = fixture();
  let resolveOld;
  f.setLoad(() => new Promise((resolve) => { resolveOld = resolve; }));
  const old = f.page.refreshFromServer();
  f.setLoad(async () => [single("new")]);
  await f.page.refreshFromServer();
  resolveOld([single("old")]);
  await old;
  assert.deepEqual(ids(f.ctx.data.packages), ["new"]);
  let resolveExpired;
  f.setLoad(() => new Promise((resolve) => { resolveExpired = resolve; }));
  const expired = f.page.refreshFromServer();
  await f.expireSession();
  resolveExpired([single("expired")]);
  await expired;
  assert.deepEqual(ids(f.ctx.data.packages), ["new"]);
  assert.equal(f.page.listSource.value.length, 0);
  let resolveUnmounted;
  f.setLoad(() => new Promise((resolve) => { resolveUnmounted = resolve; }));
  const unmounted = f.page.refreshFromServer();
  f.unmount();
  resolveUnmounted([single("unmounted")]);
  await unmounted;
  assert.deepEqual(ids(f.ctx.data.packages), ["new"]);
});

test("video upload callbacks cannot modify disconnected or replaced source rows", async () => {
  const f = fixture({ serverRows: [single("real")] });
  await f.mount();
  const first = f.page.selectedVideoSingle.value;
  f.page.onVideoFilePick({ target: { files: [{}], value: "file" } });
  assert.equal(f.uploads.length, 1);
  f.setConnected(false);
  f.uploads[0].onUploaded({ url: "/ignored-after-disconnect.mp4" });
  assert.equal(first.videoUrl, undefined);
  f.page.onVideoFilePick({ target: { files: [{}], value: "file" } });
  assert.equal(f.uploads.length, 1);
  f.setConnected(true);
  await f.page.refreshFromServer();
  f.uploads[0].onUploaded({ url: "/ignored-after-refresh.mp4" });
  assert.equal(first.videoUrl, undefined);
  f.page.onVideoFilePick({ target: { files: [{}], value: "file" } });
  f.uploads[1].onUploaded({ url: "/accepted.mp4" });
  assert.equal(f.page.selectedVideoSingle.value.videoUrl, "/accepted.mp4");
});

test("the template binds every KPI to the same computed summary and exposes retry on load errors", () => {
  const template = read("src/views/content/videoSingle/videoSingle.html");
  assert.doesNotMatch(template, /videoSingleRows/);
  for (const key of ["total", "onSale", "mainPush", "pending"]) assert.match(template, new RegExp(`videoSingleSummary\\.${key}`));
  assert.match(template, /v-for="item in listSource"/);
  assert.match(template, /v-if="remoteError"/);
  assert.match(template, /重新加载/);
  assert.match(template, /真实数据：已开启/);
  assert.match(template, /演示数据：已开启/);
});
