"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageSource = fs.readFileSync(path.resolve(__dirname, "../views/content/album/album.js"), "utf8");

function fixture(row = {}) {
  const writes = [];
  const messages = [];
  const album = { id: "album-1", name: "Photo", price: 100, sampleUrls: ["/photo.jpg"], cover: "/photo.jpg", tags: ["测试标签"], ...row };
  const ctx = {
    state: { role: "super" },
    data: { albums: [album], series: [] },
    albumRows: { get value() { return ctx.data.albums; } },
    isServerConnected: () => true,
    can: () => true,
    albumPhotoUrls: (source) => source.sampleUrls || [],
    setAlbumCover: (source, cover) => { source.cover = cover; },
    async persistContentMutation(collection, payload) {
      writes.push({ collection, payload: structuredClone(payload) });
      return true;
    }
  };
  const window = {
    Vue: {
      ref: (value) => ({ value }),
      computed: (getter) => ({ get value() { return getter(); } }),
      watch() {}, unref: (value) => value?.value ?? value
    },
    ElMessage: (message) => messages.push(message),
    LXM_UPLOAD: { ready: () => true },
    LXM_PAGES: { register: (page) => { window.page = page; } }
  };
  vm.runInNewContext(pageSource, { window, console });
  const page = window.page.setup(ctx);
  return { ctx, page, writes, messages, album };
}

test("photo editor reads canonical and legacy deposit values and respects explicit global inheritance", () => {
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
    f.page.selectAlbum(f.album);
    assert.equal(f.page.selectedAlbum.value.depositRatioPercent, percent);
    assert.equal(f.page.albumDepositLabel(f.album), label);
    assert.equal(f.page.albumDepositLabel(f.page.selectedAlbum.value, true), label);
  }
});

test("photo editor saves percentages canonically, preserves zero, and clears stale aliases", async () => {
  for (const [percent, ratio] of [[1, 0.01], [0, 0], [12.5, 0.125], [100, 1], [null, null], [undefined, null], ["", null]]) {
    const f = fixture({ depositRatio: 0.3, depositRate: 30, depositPercent: 30, depositPercentage: 30 });
    f.page.selectAlbum(f.album);
    f.page.selectedAlbum.value.depositRatioPercent = percent;
    assert.equal(await f.page.saveSelectedAlbum(), true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].collection, "albums");
    assert.equal(f.writes[0].payload.depositRatio, ratio);
    for (const field of ["depositRatioPercent", "depositRate", "depositPercent", "depositPercentage"]) {
      assert.equal(Object.hasOwn(f.writes[0].payload, field), false);
    }
    assert.equal(f.album.depositRatio, ratio);
    assert.equal(f.page.editorOpen.value, false);
    f.page.selectAlbum(f.album);
    assert.equal(f.page.selectedAlbum.value.depositRatioPercent, ratio === null ? undefined : Number(percent));
  }
});

test("new photos inherit global deposit and resetting restores the saved percentage", async () => {
  const f = fixture({ depositRatio: 0.3 });
  f.page.createAlbum();
  assert.equal(f.page.selectedAlbum.value.depositRatioPercent, undefined);
  Object.assign(f.page.selectedAlbum.value, { name: "New photo", tags: ["测试标签"], sampleUrls: ["/new.jpg"] });
  assert.equal(await f.page.saveSelectedAlbum(), true);
  assert.equal(f.writes[0].payload.depositRatio, null);
  f.page.selectAlbum(f.album);
  f.page.selectedAlbum.value.depositRatioPercent = 50;
  f.page.resetAlbumDraft();
  assert.equal(f.page.selectedAlbum.value.depositRatioPercent, 30);
});

test("invalid photo deposit percentages block persistence and retain the draft", async () => {
  for (const percent of [-1, 101, NaN, Infinity, "invalid", true, {}]) {
    const f = fixture({ depositRatio: 0.3 });
    f.page.selectAlbum(f.album);
    f.page.selectedAlbum.value.depositRatioPercent = percent;
    assert.equal(await f.page.saveSelectedAlbum(), false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.album.depositRatio, 0.3);
    assert.equal(f.page.editorOpen.value, true);
    assert.match(f.messages.at(-1), /定金比例应为 0 到 100/);
  }
});
