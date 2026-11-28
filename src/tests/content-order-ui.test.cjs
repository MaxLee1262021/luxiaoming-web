"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const order = require("../utils/content-order.js");
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const messages = [], writes = [], prompts = [];
  const message = value => messages.push(value);
  Object.assign(message, { warning: message, error: message, success: message });
  const ctx = { computed: getter => ({ get value() { return getter(); } }), can: () => true,
    state: { filters: {}, role: "super" }, ElMessage: message, log() {},
    ElMessageBox: { async prompt(message, title, options) {
      prompts.push({ message, title, options });
      return window.promptResult;
    } },
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
  return { ctx, window, writes, messages, prompts };
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

test("direct movement sends one target position, waits for all confirmed ranks, and blocks duplicate writes", async () => {
  const f = fixture(), pending = deferred();
  f.window.save = () => pending.promise;
  const row = f.ctx.data.albums[2];
  const move = f.ctx.moveContentToPosition("albums", row, 1);
  assert.equal(f.ctx.state.contentSortSaving, true);
  assert.deepEqual(f.ctx.data.albums.map(row => row.sort), [1, 2, 3]);
  assert.deepEqual(f.writes, [{ key: "albums", id: "a3", patch: { targetPosition: 1 } }]);
  assert.equal(await f.ctx.moveContentToPosition("albums", row, 2), false);
  assert.equal(await f.ctx.changeContentSort("albums", row, -1), false);
  assert.equal(await f.ctx.persistContentMutation("albums", row, clone(row)), false);
  pending.resolve({ id: "a3", sort: 1, __contentOrder: [{ id: "a1", sort: 2 }, { id: "a2", sort: 3 }, { id: "a3", sort: 1 }] });
  assert.equal(await move, true);
  assert.deepEqual(Array.from(f.ctx.sortedContentRows("albums", f.ctx.data.albums), row => row.id), ["a3", "a1", "a2"]);
  assert.equal(f.ctx.contentSortMoveDisabled("albums", row, 1), true);
  assert.equal(f.ctx.contentSortHighlighted("albums", row), true);
  assert.equal(f.ctx.contentSortHighlighted("guides", row), false);
  assert.equal(f.ctx.state.contentSortSaving, false);
  assert.match(f.messages.at(-1), /第 3 位移至第 1 位/);
});

test("position prompt uses the whole same-type group under filtering and validates integer bounds", async () => {
  const f = fixture();
  f.ctx.state.filters.keyword = "a1";
  f.window.promptResult = { value: "3" };
  f.window.save = async () => ({ id: "a1", sort: 3, __contentOrder: [{ id: "a1", sort: 3 }, { id: "a2", sort: 1 }, { id: "a3", sort: 2 }] });
  assert.equal(await f.ctx.promptContentSort("albums", f.ctx.data.albums[0]), true);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].title, "移动到指定位置");
  assert.match(f.prompts[0].message, /第 1 位，共 3 项/);
  const { inputValidator } = f.prompts[0].options;
  for (const value of ["", "0", "-1", "1.5", "1e0", "4", "abc", "9007199254740993"]) {
    assert.equal(inputValidator(value), "请输入 1 到 3 之间的整数", value);
  }
  for (const value of ["1", "3", " 2 "]) assert.equal(inputValidator(value), true, value);
  assert.deepEqual(f.writes, [{ key: "albums", id: "a1", patch: { targetPosition: 3 } }]);
});

test("cancelling the prompt and selecting the current position never submit a save", async () => {
  const f = fixture();
  f.ctx.ElMessageBox.prompt = async () => { throw "cancel"; };
  assert.equal(await f.ctx.promptContentSort("albums", f.ctx.data.albums[0]), false);
  f.ctx.ElMessageBox.prompt = async () => { throw "close"; };
  assert.equal(await f.ctx.promptContentSort("albums", f.ctx.data.albums[0]), false);
  f.ctx.ElMessageBox.prompt = async () => ({ value: "1" });
  assert.equal(await f.ctx.promptContentSort("albums", f.ctx.data.albums[0]), false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.messages.length, 0);
});

test("direct movement rejects invalid targets, read-only access, deleted rows and single-item groups", async () => {
  const f = fixture(), row = f.ctx.data.albums[0];
  for (const target of [0, -1, 4, 1.5, "2", NaN, Infinity]) {
    assert.equal(await f.ctx.moveContentToPosition("albums", row, target), false);
  }
  f.ctx.can = () => false;
  assert.equal(f.ctx.contentSortMoveDisabled("albums", row), true);
  assert.equal(await f.ctx.promptContentSort("albums", row), false);
  f.ctx.can = () => true;
  row.deleted = true;
  assert.equal(await f.ctx.moveContentToPosition("albums", row, 1), false);
  f.ctx.data.albums = [f.ctx.data.albums[1]];
  assert.equal(f.ctx.contentSortMoveDisabled("albums", f.ctx.data.albums[0]), true);
  assert.equal(await f.ctx.promptContentSort("albums", f.ctx.data.albums[0]), false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.prompts.length, 0);
});

test("failed target movement preserves ranks and releases the save lock for retry", async () => {
  const f = fixture(), before = clone(f.ctx.data.albums);
  f.window.save = async () => { throw new Error("排序保存失败"); };
  assert.equal(await f.ctx.moveContentToPosition("albums", f.ctx.data.albums[2], 1), false);
  assert.deepEqual(f.ctx.data.albums, before);
  assert.equal(f.ctx.state.contentSortSaving, false);
  assert.equal(f.ctx.contentSortMoveDisabled("albums", f.ctx.data.albums[2], 1), false);
  assert.equal(f.ctx.state.contentSortHighlight, undefined);
});

test("a pending position prompt opens once and rechecks the save lock before submitting", async () => {
  const f = fixture(), pending = deferred();
  let prompts = 0;
  f.ctx.ElMessageBox.prompt = () => { prompts++; return pending.promise; };
  const move = f.ctx.promptContentSort("albums", f.ctx.data.albums[2]);
  assert.equal(await f.ctx.promptContentSort("albums", f.ctx.data.albums[1]), false);
  assert.equal(prompts, 1);
  f.ctx.state.contentSortSaving = true;
  pending.resolve({ value: "1" });
  assert.equal(await move, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.ctx.state.contentSortSaving, true);
});
