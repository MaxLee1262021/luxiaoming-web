"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const rpc = require("../lib/rpc.cjs");
const createSource = require("../lib/dbSource.cjs");

function identity(openid) { return { identity: { kind: "public", openid } }; }

test("收藏 RPC 按用户持久化、去重并隔离", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-favorites-"));
  const file = path.join(dir, "db.json");
  const source = createSource({ backend: "json", jsonFile: file });
  try {
    const first = await rpc(source, "addFavorite", {
      data: { type: "package", itemId: "pkg-1", item: { title: "长沙旅拍", cover: "https://img.test/pkg.jpg", price: 699 } }
    }, identity("user-a"));
    assert.equal(first.success, true);
    assert.equal(first.data.favorite, true);
    assert.equal(first.data.item.id, "pkg-1");
    assert.equal(first.data.item.type, "photo_package");

    const duplicate = await rpc(source, "addFavorite", {
      data: { type: "photo_package", id: "pkg-1", item: { title: "更新后的标题" } }
    }, identity("user-a"));
    assert.equal(duplicate.success, true);
    assert.equal((await source.listFavorites("user-a")).length, 1);
    assert.equal((await source.getFavorite("user-a", "photo_package", "pkg-1")).snapshot.title, "更新后的标题");

    const own = await rpc(source, "getMyFavorites", { data: {} }, identity("user-a"));
    assert.equal(own.success, true);
    assert.equal(own.data.total, 1);
    const other = await rpc(source, "getMyFavorites", { data: {} }, identity("user-b"));
    assert.equal(other.success, true);
    assert.equal(other.data.total, 0);

    const check = await rpc(source, "checkFavorite", { data: { type: "photo_package", id: "pkg-1" } }, identity("user-a"));
    assert.equal(check.data.favorite, true);
    const toggledOff = await rpc(source, "toggleFavorite", { data: { type: "photo_package", id: "pkg-1" } }, identity("user-a"));
    assert.equal(toggledOff.data.favorite, false);
    const toggledOn = await rpc(source, "toggleFavorite", { data: { type: "spot", id: "spot-1", item: { name: "橘子洲" } } }, identity("user-a"));
    assert.equal(toggledOn.data.favorite, true);
    const removed = await rpc(source, "removeFavorite", { data: { type: "spot", id: "spot-1" } }, identity("user-a"));
    assert.equal(removed.data.favorite, false);
    assert.equal((await source.listFavorites("user-a")).length, 0);
  } finally {
    await source.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("收藏 RPC 拒绝无效类型和未登录身份", async () => {
  const source = {
    async getFavorite() { return null; },
    async listFavorites() { return []; },
    async upsertFavorite() { throw new Error("should not be called"); },
    async removeFavorite() { return false; }
  };
  const invalid = await rpc(source, "addFavorite", { data: { type: "orders", id: "o-1" } }, identity("user-a"));
  assert.equal(invalid.success, false);
  const anonymous = await rpc(source, "getMyFavorites", { data: {} });
  assert.equal(anonymous.success, false);
});
