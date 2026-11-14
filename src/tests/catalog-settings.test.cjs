"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
function fixture(file = "11-content-lists.js") {
  const writes = [], messages = [], trash = [];
  let fail = false;
  const window = {};
  const data = Object.fromEntries(["tagLibrary", "spots", "albums", "packages", "peripherals", "guides", "stories", "samples"].map(key => [key, []]));
  const state = { role: "super", filters: {}, homeConfig: {}, trash: [] };
  const ctx = {
    data, state, computed: getter => ({ get value() { return getter(); } }),
    ElMessage: Object.fromEntries(["warning", "success", "error", "info"].map(key => [key, message => messages.push(message)])),
    ElMessageBox: { confirm: async () => true }, log() {}, currentOperatorName: () => "测试管理员",
    persistContentMutation: async (key, row) => { writes.push({ key, row: structuredClone(row) }); return !fail; },
    persistTrashRecord: async row => { trash.push(row); return row; },
    pageConfigPages: [], makeDefaultPageConfig: () => ({})
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), { window, console, LXMFormat: { nowText: () => "2026-10-31", dateTime: () => "2026-10-31" } });
  Object.assign(ctx, window.LXM_APP_PARTS[0](ctx));
  return { ctx, writes, messages, trash, failWrites() { fail = true; } };
}
test("标签允许同名创建，运营与内容分类可选且删除标签不再出现在选项中", async () => {
  const f = fixture();
  for (const category of ["风格", "风格", "运营", "内容"]) {
    f.ctx.openTag(); Object.assign(f.ctx.state.editTag, { name: "  江景  ", category });
    await f.ctx.saveTag();
  }
  assert.equal(f.ctx.data.tagLibrary.length, 4);
  assert.equal(new Set(f.ctx.data.tagLibrary.map(row => row.id)).size, 4);
  assert.equal(f.ctx.tagSummary.value.operation, 1);
  assert.equal(f.ctx.tagSummary.value.content, 1);
  assert.equal(f.ctx.tagOptions("风格").length, 2);
  f.ctx.data.tagLibrary.find(row => row.category === "风格").isDeleted = true;
  assert.equal(f.ctx.tagOptions("风格").length, 1);
  f.ctx.openTag(); f.ctx.state.editTag.name = "  "; await f.ctx.saveTag();
  assert.equal(f.writes.length, 4, "空白名称不产生写入");
});
test("标签列表投影的启停修改源记录，保存失败会恢复", async () => {
  const f = fixture();
  f.ctx.data.tagLibrary.push({ id: "tag", name: "江景", category: "内容", status: "启用" });
  await f.ctx.toggleTagStatus(f.ctx.tagRows.value[0]);
  assert.equal(f.ctx.data.tagLibrary[0].status, "停用");
  assert.equal(f.ctx.tagOptions("内容").length, 0);
  f.failWrites(); await f.ctx.toggleTagStatus(f.ctx.tagRows.value[0]);
  assert.equal(f.ctx.data.tagLibrary[0].status, "停用");
});
test("标签删除需超管与先停用，保留商品文字引用并可回收", async () => {
  const f = fixture();
  const row = { id: "tag", name: "江景", category: "内容", status: "启用" };
  f.ctx.data.tagLibrary.push(row); f.ctx.data.albums.push({ id: "photo", tags: ["江景"] });
  await f.ctx.requestDeleteTag(row); assert.equal(f.writes.length, 0);
  row.status = "停用"; f.ctx.state.role = "content";
  await f.ctx.requestDeleteTag(row); assert.equal(f.writes.length, 0);
  f.ctx.state.role = "super"; await f.ctx.requestDeleteTag(row);
  assert.equal(row.deleted, true); assert.equal(f.trash[0].sourceKey, "tagLibrary");
  assert.deepEqual(f.ctx.data.albums[0].tags, ["江景"]);
});
test("多规格周边不能从货架覆盖汇总售价或规格售价", async () => {
  const f = fixture("12-content-edit.js");
  const source = { id: "multi", specMode: "multiple", price: 19.9, skus: [{ spec: "小号", price: 19.9, stock: 4 }, { spec: "大号", price: 29.9, stock: 2 }] };
  const previous = structuredClone(source);
  const row = { __key: "peripherals", __source: source, shelfPrice: 1 };
  assert.equal(await f.ctx.syncShelfPrice(row), false);
  assert.deepEqual(source, previous);
  assert.equal(row.shelfPrice, 19.9);
  assert.equal(f.writes.length, 0);
  assert.match(f.messages.at(-1), /商品管理.*规格售价/);
});

test("轮播保存移除已退役的城市限制，保留全局历史配置且不污染编辑值", () => {
  const f = fixture("12-content-edit.js");
  Object.assign(f.ctx.state.homeConfig, {
    cityId: "cs", cityName: "长沙", homeBanners: [{ id: "home", url: "/h.jpg", cityId: "cs", cityIds: ["cs"] }],
    exploreBanners: [{ id: "explore", url: "/e.jpg", cityId: "hz", cityIds: ["hz"] }]
  });
  const result = f.ctx.buildMiniProgramHomeConfig();
  assert.equal(result.defaultCityId, undefined, "不再生成当前首页不读取的默认城市配置"); assert.equal(result.cityId, "cs");
  assert.equal(result.homeBanners[0].cityId, undefined); assert.equal(result.exploreBanners[0].cityId, undefined);
  assert.equal(result.homeBanners[0].cityIds, undefined); assert.equal(result.exploreBanners[0].cityIds, undefined);
  result.homeBanners[0].url = "/changed.jpg";
  assert.equal(f.ctx.state.homeConfig.homeBanners[0].url, "/h.jpg");
  assert.deepEqual(f.ctx.state.homeConfig.homeBanners[0].cityIds, ["cs"]);
});
test("回收站恢复采用服务端的新关联而不是删除前的陈旧快照", async () => {
  const removed = [];
  const row = { id: "trash-guide", type: "旅拍灵感", sourceKey: "guides", name: "灵感", source: { id: "guide", spotId: "deleted-spot", deleted: true } };
  const state = { role: "super", trash: [row] };
  const data = { orders: [], spots: [], albums: [], peripherals: [], packages: [], addonServices: [], tagLibrary: [], series: [], samples: [], cities: [], guides: [], stories: [] };
  const window = { LXM_AUTH: { hasSession: () => true }, LXM_CLOUD_MODE: "mysql", LXM_API_STATE: { reachable: true }, LXM_CLOUD: {
    create: async () => ({}),
    update: async () => ({ id: "guide", title: "灵感", spotId: "", spotIds: [], deleted: false, isDeleted: false, isShow: false }),
    remove: async (key, id) => { removed.push([key, id]); return true; }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/08-trash.js"), "utf8"), { window });
  const api = window.LXM_APP_PARTS[0]({ data, state, ElMessage: { success() {}, error() {} }, log() {}, roleProfile: { value: { name: "测试管理员" } } });
  await api.restoreTrash(row);
  assert.equal(data.guides[0].spotId, "");
  assert.equal(data.guides[0].isShow, false);
  assert.equal(state.trash.length, 0);
  assert.deepEqual(removed, [["trash", "trash-guide"]]);
});
