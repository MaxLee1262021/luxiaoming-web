"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const order = require("../utils/content-order.js");
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const messages = [], writes = [];
  const message = value => messages.push(value);
  Object.assign(message, { warning: message, error: message, success: message });
  const ctx = { computed: getter => ({ get value() { return getter(); } }), can: () => true,
    state: { filters: {}, role: "super" }, ElMessage: message, log() {},
    data: { albums: [], packages: [], guides: [], spots: [], tagLibrary: [], series: [], orders: [] } };
  const window = { LXM_APP_PARTS: [], LXM_CONTENT_ORDER: order, LXM_AUTH: { hasSession: () => true },
    LXM_CLOUD_MODE: "mysql", LXM_API_STATE: { reachable: true },
    LXM_CLOUD: { async update(key, id, patch) {
      writes.push({ key, id, patch: clone(patch) });
      return window.save(key, id, patch);
    } } };
  const sandbox = { window, console };
  for (const file of ["11-content-lists.js", "12-content-edit.js"]) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  }
  ctx.data.albums = [1, 2, 3].map(sort => ({ id: `a${sort}`, name: `a${sort}`, sort }));
  return { ctx, window, writes, messages };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("pending reorder keeps local ranks unchanged, blocks duplicate clicks and regular writes, then applies all server ranks", async () => {
  const f = fixture(), pending = deferred();
  f.window.save = () => pending.promise;
  const row = f.ctx.data.albums[2];
  const first = f.ctx.changeContentSort("albums", row, -1);
  assert.equal(f.ctx.state.contentSortSaving, true);
  assert.deepEqual(f.ctx.data.albums.map(row => row.sort), [1, 2, 3]);
  assert.equal(await f.ctx.changeContentSort("albums", row, -1), false);
  assert.equal(await f.ctx.persistContentMutation("albums", row, clone(row)), false);
  assert.equal(await f.ctx.pushContentToCloud("guides", { id: "g1", title: "草稿" }), null);
  assert.equal(f.writes.length, 1);
  pending.resolve({ id: "a3", sort: 2, __contentOrder: [{ id: "a1", sort: 1 }, { id: "a2", sort: 3 }, { id: "a3", sort: 2 }] });
  assert.equal(await first, true);
  assert.deepEqual(Array.from(f.ctx.sortedContentRows("albums", f.ctx.data.albums), row => row.id), ["a1", "a3", "a2"]);
  assert.equal(row.__contentOrder, undefined);
  assert.equal(f.ctx.state.contentSortSaving, false);
});

test("pending editor save blocks sorting and drops stale draft rank from its request", async () => {
  const f = fixture(), pending = deferred();
  f.window.save = () => pending.promise;
  const first = f.ctx.pushContentToCloud("albums", { id: "a1", name: "新名称", sort: 99 });
  assert.equal(f.ctx.state.contentSortSaving, true);
  assert.equal(await f.ctx.changeContentSort("albums", f.ctx.data.albums[2], -1), false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].patch.sort, undefined);
  pending.resolve({ id: "a1", name: "新名称", sort: 1, __contentOrder: [{ id: "a2", sort: 2 }, { id: "a3", sort: 3 }] });
  const saved = await first;
  assert.equal(saved.sort, 1);
  assert.equal(saved.__contentOrder, undefined);
  assert.equal(f.ctx.state.contentSortSaving, false);
});

test("failed reorder preserves the entire list and releases the save lock for retry", async () => {
  const f = fixture(), before = clone(f.ctx.data.albums);
  f.window.save = async () => { throw new Error("保存失败"); };
  assert.equal(await f.ctx.changeContentSort("albums", f.ctx.data.albums[2], -1), false);
  assert.deepEqual(f.ctx.data.albums, before);
  assert.equal(f.ctx.state.contentSortSaving, false);
  assert.equal(f.ctx.contentSortDisabled("albums", f.ctx.data.albums[2], -1), false);
  assert.equal(f.messages.at(-1), "保存失败");
});
