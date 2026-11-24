"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageSource = fs.readFileSync(path.resolve(__dirname, "../views/content/videoSingle/videoSingle.js"), "utf8");

function fixture(row = {}) {
  const writes = [];
  const messages = [];
  const mounted = [];
  const ctx = {
    state: { authSource: "server" },
    data: { packages: [] },
    isServerConnected: () => true,
    can: () => true,
    contentVideoUrl: () => "",
    videoSingleStatus: () => "上架",
    filterVideoSingleRows: (rows) => rows,
    async persistContentMutation(collection, payload) {
      writes.push({ collection, payload: structuredClone(payload) });
      return true;
    }
  };
  const api = { setRemote() {}, async loadCollection() { return [{ id: "video-1", name: "Video", tags: ["测试标签"], price: 100, ...row }]; } };
  const window = {
    Vue: {
      ref: (value) => ({ value }),
      computed: (getter) => ({ get value() { return getter(); } }),
      onMounted: (callback) => mounted.push(callback),
      onBeforeUnmount() {}, watch() {}
    },
    ElMessage: (message) => messages.push(message),
    LXM_AUTH: { hasSession: () => true },
    LXM_UPLOAD: { ready: () => true, single: async (_key, callback) => callback() },
    LXM_PAGES: { register: (page) => { window.page = page; } }
  };
  vm.runInNewContext(pageSource, { window, LXM_API: api, console });
  const page = window.page.setup(ctx);
  return { ctx, page, writes, messages, async mount() { for (const callback of mounted) await callback(); } };
}

test("video deposit editing converts canonical and legacy ratios to percentages without inventing a default", async () => {
  for (const [row, percent, label] of [
    [{ depositRatio: 0.3 }, 30, "30%"],
    [{ depositRatio: 30 }, 30, "30%"],
    [{ depositRatio: 0.01 }, 1, "1%"],
    [{ depositRatio: 1 }, 100, "100%"],
    [{ depositRatio: 0 }, 0, "0%"],
    [{ depositRate: 0.25 }, 25, "25%"],
    [{ depositRatio: null, depositRate: 0.25 }, undefined, "使用全局比例"],
    [{}, undefined, "使用全局比例"]
  ]) {
    const f = fixture(row);
    await f.mount();
    f.page.openVideoEditor(f.ctx.data.packages[0]);
    assert.equal(f.page.videoDraft.value.depositRatioPercent, percent);
    assert.equal(f.page.videoDepositLabel(f.ctx.data.packages[0]), label);
    assert.equal(f.page.videoDepositLabel(f.page.videoDraft.value, true), label);
  }
});

test("video editor persists 1%, zero, decimals and clearing to global inheritance without draft-only fields", async () => {
  for (const [percent, ratio] of [[1, 0.01], [0, 0], [12.5, 0.125], [100, 1], [null, null], [undefined, null], ["", null]]) {
    const f = fixture({ depositRatio: 0.3, depositRate: 30, depositPercent: 30, depositPercentage: 30 });
    await f.mount();
    f.page.openVideoEditor(f.ctx.data.packages[0]);
    f.page.videoDraft.value.depositRatioPercent = percent;
    assert.equal(await f.page.saveSelectedVideoSingle(), true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].collection, "packages");
    assert.equal(f.writes[0].payload.depositRatio, ratio);
    for (const field of ["depositRatioPercent", "depositRate", "depositPercent", "depositPercentage"]) {
      assert.equal(Object.hasOwn(f.writes[0].payload, field), false);
    }
    assert.equal(f.ctx.data.packages[0].depositRatio, ratio);
    assert.equal(f.page.editorOpen.value, false);
  }
});

test("new videos inherit global deposit and reset restores the persisted ratio", async () => {
  const f = fixture({ depositRatio: 0.3 });
  await f.mount();
  f.page.openVideoEditor();
  assert.equal(f.page.videoDraft.value.depositRatioPercent, undefined);
  f.page.videoDraft.value.title = "New video";
  f.page.videoDraft.value.tags = ["测试标签"];
  assert.equal(await f.page.saveSelectedVideoSingle(), true);
  assert.equal(f.writes[0].payload.depositRatio, null);
  f.page.openVideoEditor(f.ctx.data.packages.find((row) => row.id === "video-1"));
  f.page.videoDraft.value.depositRatioPercent = 50;
  f.page.resetVideoDraft();
  assert.equal(f.page.videoDraft.value.depositRatioPercent, 30);
});

test("invalid video percentages block persistence and retain the editable draft", async () => {
  for (const percent of [-1, 101, NaN, Infinity, "invalid", true, {}]) {
    const f = fixture({ depositRatio: 0.3 });
    await f.mount();
    f.page.openVideoEditor(f.ctx.data.packages[0]);
    f.page.videoDraft.value.depositRatioPercent = percent;
    assert.equal(await f.page.saveSelectedVideoSingle(), false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.ctx.data.packages[0].depositRatio, 0.3);
    assert.equal(f.page.editorOpen.value, true);
    assert.match(f.messages.at(-1), /定金比例应为 0 到 100/);
  }
});
