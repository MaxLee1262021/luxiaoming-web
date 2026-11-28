"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const spotOrder = require("../utils/spot-order.js");
const { planSpotMutation } = require("../../server/lib/spotOrder.cjs");
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const computed = (definition) => ({ get value() { return definition(); } });
  const calls = [];
  const writes = [];
  const logs = [];
  const messages = [];
  const prompts = [];
  const pagers = new Map();
  const message = (text) => messages.push(text);
  Object.assign(message, { success: message, warning: message, error: message });
  const window = {
    Vue: { computed, ref: (value) => ({ value }), watch() {} },
    LXM_APP_PARTS: [], LXM_AUTH: { hasSession: () => options.online !== false }, LXM_SPOT_ORDER: spotOrder, LXM_CONTENT_ORDER: require("../utils/content-order.js"),
    LXM_PAGES: { register(page) { window.page = page; } }
  };
  const ctx = {
    computed,
    can: () => true,
    ElMessage: message,
    ElMessageBox: { async prompt(message, title, settings) {
      prompts.push({ message, title, options: settings });
      if (options.prompt) return options.prompt(message, title, settings);
      return options.promptResult || { value: "1" };
    } },
    log: (...args) => logs.push(args),
    state: { filters: {}, contentScope: {} },
    data: {
      cities: [{ id: "city", name: "长沙" }],
      spots: [{ id: "a", name: "A", cityId: "city", sort: 2 }, { _id: "b", name: "B", cityId: "city", sort: 1 }],
      series: [{ id: "style", spotId: "a" }],
      albums: [
        { id: "photo", spotId: "a", spotIds: ["a"] },
        { id: "inherited", seriesId: "style", isShow: false },
        { id: "unbound", seriesId: "style", spotBindingExplicit: true },
        { id: "override", seriesId: "style", spotId: "b" },
        { id: "deleted-photo", spotId: "a", deleted: true },
        { id: "removed-photo", spotId: "a", isDeleted: true }
      ],
      packages: [
        { id: "video", type: "video", isVideoSingle: true, spotId: "a" },
        { id: "inherited-video", type: "video", productKind: "video_single", seriesId: "style" },
        { id: "video-bundle", type: "video", includedItems: [{ type: "album", productId: "override" }] },
        { id: "photo-bundle", type: "photo", includedItems: [{ type: "album", productId: "photo" }] },
        { id: "legacy-package", type: "photo", spotId: "a" },
        { id: "deleted-video", type: "video", isVideoSingle: true, spotId: "a", deleted: true },
        { id: "removed-package", type: "photo", spotId: "a", isDeleted: true }
      ],
      guides: [{ id: "guide", spotId: "a", isShow: false }, { id: "inherited-guide", seriesId: "style" }, { id: "deleted-guide", spotId: "a", deleted: true }],
      peripherals: [{ id: "gift", spotId: "a" }],
      samples: [{ id: "sample", spotId: "a" }], tagLibrary: [], orders: []
    },
    switchMenu(key, options) { calls.push({ key, options }); },
    pager(key) {
      if (!pagers.has(key)) pagers.set(key, { page: 1, size: options.pageSize || 12 });
      return pagers.get(key);
    }
  };
  if (options.spots) ctx.data.spots = options.spots;
  const serverRows = clone(ctx.data.spots);
  window.LXM_CLOUD_MODE = "mysql";
  window.LXM_CLOUD = {
    async update(key, id, patch) {
      writes.push({ key, id, patch: clone(patch) });
      if (options.update) return options.update(key, id, patch);
      const plan = planSpotMutation(serverRows, id, patch, { create: false, reorder: Object.keys(patch).length === 1 && Object.hasOwn(patch, "sort") });
      for (const change of plan.changes) Object.assign(serverRows.find(row => String(row.id || row._id) === change.id), change.after);
      return { ...plan.saved, __spotOrder: plan.changes.map(change => ({ id: change.id, sort: change.after.sort ?? 0 })) };
    }
  };
  ctx.spotRows = computed(() => {
    let rows = ctx.data.spots.map((spot) => ({ ...spot, summary: {} }));
    if (ctx.state.filters.keyword) {
      const keyword = ctx.state.filters.keyword.toLowerCase();
      rows = rows.filter(spot => JSON.stringify(spot).toLowerCase().includes(keyword));
    }
    return rows;
  });
  const sandbox = { window, console };
  for (const file of ["11-content-lists.js", "12-content-edit.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  }
  ctx.persistContentMutation = async (key, source, previous) => {
    writes.push({ key, source, sort: source.sort, previous: { ...previous } });
    return true;
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/views/content/spot/spot.js"), "utf8"), sandbox);
  return { ctx, page: window.page.setup(ctx), calls, writes, logs, messages, prompts, window, options, serverRows };
}

test("点位关联资产区分四类，保留继承和组合关系，排除删除内容及其他商品", () => {
  const { ctx, page } = fixture();
  const counts = (spot) => JSON.parse(JSON.stringify(page.spotAssets(spot)));
  assert.deepEqual(counts({ id: "a" }), { albums: 2, videos: 2, packages: 2, guides: 2 });
  assert.deepEqual(counts({ _id: "b" }), { albums: 1, videos: 0, packages: 0, guides: 0 });
  assert.deepEqual(counts({ id: "missing" }), { albums: 0, videos: 0, packages: 0, guides: 0 });
  ctx.data.albums[0].deleted = true;
  assert.equal(page.spotAssets({ id: "a" }).albums, 1);
});

test("四类关联入口保留所选点位并清除其他内容筛选", () => {
  const { ctx, page, calls } = fixture();
  for (const [method, key] of [["goToAlbums", "albums"], ["goToVideos", "videoSingles"], ["goToPackages", "packages"], ["goToGuides", "guides"]]) {
    Object.assign(ctx.state.filters, { keyword: "旧关键词", contentStatus: "上架", contentSeriesId: "style", shelfType: "video" });
    ctx.state.contentScope = { type: "series", id: "style" };
    page[method]({ _id: "b" });
    assert.equal(ctx.state.filters.contentSpotId, "b");
    for (const field of ["keyword", "contentStatus", "contentSeriesId", "shelfType"]) assert.equal(ctx.state.filters[field], "");
    assert.equal(ctx.state.contentScope.type, "");
    assert.equal(calls.at(-1).key, key);
    assert.equal(calls.at(-1).options.preserveFilters, true);
  }
});

function fiveSpots() {
  return ["a", "b", "c", "d", "e"].map((id, index) => ({ id, name: id.toUpperCase(), cityId: "city", sort: index + 1 }));
}
function ranked(ctx) { return spotOrder.ordered(ctx.data.spots).map(row => [row.id || row._id, row.sort]); }

test("列表上下移动插入相邻位置并顺移其他点位，表格副本不参与写入", async () => {
  const { ctx, page, writes, logs } = fixture({ spots: fiveSpots() });
  const row = page.spotTableRows.value.find(row => row.id === "e");
  row.sort = 99;
  assert.equal(await page.changeSpotSort(row, -1), true);
  assert.deepEqual(ranked(ctx), [["a", 1], ["b", 2], ["c", 3], ["e", 4], ["d", 5]]);
  assert.equal(row.sort, 99);
  assert.equal(await page.changeSpotSort({ id: "e", sort: 999 }, 1), true);
  assert.deepEqual(ranked(ctx), [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]);
  assert.equal(writes.length, 2, "每次重排只向服务端提交一个插入位置");
  assert.equal(logs.length, 2);
  assert.ok(ctx.data.spots.every(row => !("summary" in row)));
});

test("首尾按钮按全局实际位置禁用，旧排序空洞与并列通过插入重新连续编号", async () => {
  const rows = fiveSpots();
  Object.assign(rows[0], { sort: 2, hotScore: 9 });
  Object.assign(rows[1], { sort: 2, hotScore: 1 });
  rows[2].sort = 10; rows[3].sort = 30; rows[4].sort = 2147483647;
  const { ctx, page } = fixture({ spots: rows });
  assert.equal(page.spotSortDisabled({ id: "a" }, -1), true);
  assert.equal(page.spotSortDisabled({ id: "e" }, 1), true);
  assert.equal(await page.changeSpotSort({ id: "a" }, 1), true);
  assert.deepEqual(ranked(ctx), [["b", 1], ["a", 2], ["c", 3], ["d", 4], ["e", 5]]);
});

test("城市筛选下仍跨城市和隐藏点位按全局相邻位置移动，删除记录不占位", async () => {
  const rows = fiveSpots();
  rows[1].cityId = "other";
  Object.assign(rows[3], { cityId: "other", isShow: false, status: "停用" });
  rows.push({ id: "deleted", sort: 1, deleted: true }, { id: "removed", sort: 2, isDeleted: true });
  const { ctx, page } = fixture({ spots: rows });
  ctx.data.cities.push({ id: "other", name: "杭州" });
  page.spotCityFilter.value = "city";
  assert.deepEqual(page.spotTableRows.value.map(row => row.id), ["a", "c", "e"]);
  await page.changeSpotSort({ id: "e" }, -1);
  assert.deepEqual(ranked(ctx), [["a", 1], ["b", 2], ["c", 3], ["e", 4], ["d", 5]]);
  assert.equal(ctx.data.spots.find(row => row.id === "deleted").sort, 1);
  assert.equal(ctx.data.spots.find(row => row.id === "removed").sort, 2);
});

test("未配置及无效排序从任一方向插入第一位，已有点位依次后移", async () => {
  for (const direction of [-1, 1]) for (const value of [undefined, 0, -1, "", null, "invalid", 1.5, NaN, Infinity]) {
    const rows = fiveSpots();
    if (value === undefined) delete rows[4].sort;
    else rows[4].sort = value;
    const { ctx, page } = fixture({ spots: rows });
    assert.equal(page.spotSortDisabled({ id: "e" }, direction), false);
    assert.equal(await page.changeSpotSort({ id: "e" }, direction), true);
    assert.deepEqual(ranked(ctx), [["e", 1], ["a", 2], ["b", 3], ["c", 4], ["d", 5]]);
  }
});

test("在线只提交一个插入位置，采用服务端返回的全局排序并移除响应元数据", async () => {
  const { ctx, page, writes } = fixture({ online: true, spots: fiveSpots() });
  assert.equal(await page.changeSpotSort({ id: "e" }, -1), true);
  assert.deepEqual(writes, [{ key: "spots", id: "e", patch: { sort: 4 } }]);
  assert.deepEqual(ranked(ctx), [["a", 1], ["b", 2], ["c", 3], ["e", 4], ["d", 5]]);
  assert.ok(ctx.data.spots.every(row => !("__spotOrder" in row)));
});

test("服务端失败不提前改变任一点位，释放全部排序按钮且不写成功日志", async () => {
  for (const reply of [null, { error: "排序暂不可用" }, new Error("网络中断")]) {
    const f = fixture({ online: true, spots: fiveSpots(), update: async () => { if (reply instanceof Error) throw reply; return reply; } });
    const before = clone(f.ctx.data.spots);
    assert.equal(await f.page.changeSpotSort({ id: "e" }, -1), false);
    assert.deepEqual(f.ctx.data.spots, before);
    assert.equal(f.ctx.isSpotOrderSaving(), false);
    assert.equal(f.page.isSpotSortSaving({ id: "a" }), false);
    assert.equal(f.logs.length, 0);
    assert.match(f.messages.at(-1), /失败|不可用|中断/);
  }
});

test("等待服务端时锁定所有点位并阻止重复请求，成功后一次应用返回排序", async () => {
  let finish;
  const f = fixture({ online: true, spots: fiveSpots(), update: () => new Promise(resolve => { finish = resolve; }) });
  const before = clone(f.ctx.data.spots);
  const saving = f.page.changeSpotSort({ id: "e" }, -1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.ctx.data.spots, before);
  assert.equal(f.ctx.isSpotOrderSaving(), true);
  for (const row of f.ctx.data.spots) for (const direction of [-1, 1]) assert.equal(f.page.spotSortDisabled(row, direction), true);
  assert.equal(await f.page.changeSpotSort({ id: "c" }, -1), false);
  assert.equal(f.writes.length, 1);
  finish({ ...f.serverRows[4], sort: 4, __spotOrder: [{ id: "e", sort: 4 }, { id: "d", sort: 5 }] });
  assert.equal(await saving, true);
  assert.deepEqual(ranked(f.ctx), [["a", 1], ["b", 2], ["c", 3], ["e", 4], ["d", 5]]);
  assert.equal(f.ctx.isSpotOrderSaving(), false);
  assert.equal(f.page.spotSortDisabled({ id: "c" }, -1), false);
  assert.equal(f.logs.length, 1);
});

test("无权限、已删除、无效方向及不存在的点位不能重排", async () => {
  const f = fixture({ online: true, spots: fiveSpots() });
  const before = clone(f.ctx.data.spots);
  f.ctx.can = () => false;
  assert.equal(await f.page.changeSpotSort({ id: "c" }, -1), false);
  f.ctx.can = () => true;
  f.ctx.data.spots[0].deleted = true;
  f.ctx.data.spots[1].isDeleted = true;
  for (const row of [{ id: "a" }, { id: "b" }, { id: "missing" }, {}]) {
    assert.equal(f.page.spotSortDisabled(row, -1), true);
    assert.equal(await f.page.changeSpotSort(row, -1), false);
  }
  assert.equal(await f.page.changeSpotSort({ id: "c" }, 0), false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.ctx.data.spots.map(row => row.sort), before.map(row => row.sort));
});

test("打卡点可从第30位直接移至第3位及最前，单次提交全局插位并定位高亮", async () => {
  const spots = Array.from({ length: 30 }, (_, index) => ({ id: `spot-${index + 1}`, name: `点位${index + 1}`, cityId: "city", sort: index + 1 }));
  const f = fixture({ spots });
  const row = f.page.spotTableRows.value.find(item => item.id === "spot-30");
  row.sort = 999;
  f.ctx.pager("spots").page = 3;
  assert.equal(await f.page.moveSpotToPosition(row, 3), true);
  const expected = ["spot-1", "spot-2", "spot-30", ...spots.slice(2, 29).map(item => item.id)];
  assert.deepEqual(ranked(f.ctx), expected.map((id, index) => [id, index + 1]));
  assert.deepEqual(f.writes, [{ key: "spots", id: "spot-30", patch: { sort: 3 } }]);
  assert.equal(f.ctx.pager("spots").page, 1);
  assert.equal(f.page.spotRowClassName({ row }), "is-sort-highlighted");
  assert.equal(f.page.spotRowClassName({ row: { id: "spot-1" } }), "");
  assert.equal(row.sort, 999, "表格副本不作为持久化来源");
  assert.ok(f.ctx.data.spots.every(item => !("summary" in item) && !("__spotOrder" in item)));
  assert.equal(await f.page.moveSpotToPosition(row, 30), true);
  assert.equal(f.ctx.pager("spots").page, 3, "默认每页12条时目标30定位到第3页");
  assert.equal(await f.page.moveSpotToPosition(row, 1), true);
  assert.equal(f.ctx.pager("spots").page, 1);
  assert.deepEqual(ranked(f.ctx).slice(0, 3), [["spot-30", 1], ["spot-1", 2], ["spot-2", 3]]);
  assert.equal(f.page.spotSortMoveDisabled(row, 1), true);
  assert.equal(f.writes.length, 3);
  assert.equal(f.logs.length, 3);
});

test("打卡点移位范围和实际顺位不受城市、关键词及分页影响，隐藏占位而删除不占位", async () => {
  const spots = fiveSpots();
  Object.assign(spots[1], { cityId: "other", sort: 2 });
  Object.assign(spots[3], { cityId: "other", isShow: false, sort: 20 });
  Object.assign(spots[4], { sort: 99, name: "唯一目标" });
  spots.push({ id: "deleted", sort: 1, deleted: true }, { id: "removed", sort: 2, isDeleted: true }, { id: "unranked", sort: 0 });
  const f = fixture({ spots, pageSize: 2 });
  f.page.spotCityFilter.value = "city";
  f.ctx.state.filters.keyword = "唯一目标";
  f.ctx.pager("spots").page = 9;
  assert.deepEqual(f.page.spotTableRows.value.map(row => row.id), ["e"]);
  assert.equal(f.page.spotSortPosition({ id: "e", sort: 1 }), 5);
  assert.equal(f.page.spotSortMoveLimit({ id: "e" }), 5);
  assert.equal(f.page.spotSortPosition({ id: "unranked" }), 0);
  assert.equal(f.page.spotSortMoveLimit({ id: "unranked" }), 6);
  assert.equal(await f.page.moveSpotToPosition({ id: "e" }, 2), true);
  assert.deepEqual(ranked(f.ctx), [["a", 1], ["e", 2], ["b", 3], ["c", 4], ["d", 5]]);
  assert.equal(f.ctx.pager("spots").page, 1, "目标所在的筛选结果只有一条");
  assert.equal(f.ctx.data.spots.find(row => row.id === "deleted").sort, 1);
  assert.equal(f.ctx.data.spots.find(row => row.id === "removed").sort, 2);
  f.page.spotCityFilter.value = "";
  f.ctx.state.filters.keyword = "";
  assert.equal(await f.page.moveSpotToPosition({ id: "e" }, 5), true);
  assert.equal(f.ctx.pager("spots").page, 3, "定位使用当前每页2条的设置");
});

test("未排名打卡点的目标上限为排名数加一，空队列也允许插入第1位", async () => {
  const f = fixture({ spots: [...fiveSpots(), { id: "new", name: "新点位", sort: 0 }] });
  assert.equal(f.page.spotSortMoveLimit({ id: "new" }), 6);
  assert.equal(f.page.spotSortMoveDisabled({ id: "new" }, 6), false);
  assert.equal(await f.page.moveSpotToPosition({ id: "new" }, 3), true);
  assert.deepEqual(ranked(f.ctx), [["a", 1], ["b", 2], ["new", 3], ["c", 4], ["d", 5], ["e", 6]]);
  const empty = fixture({ spots: [{ _id: "only", name: "尚未排名", sort: 0 }] });
  assert.equal(empty.page.spotSortPosition({ _id: "only" }), 0);
  assert.equal(empty.page.spotSortMoveLimit({ _id: "only" }), 1);
  assert.equal(empty.page.spotSortMoveDisabled({ _id: "only" }), false);
  assert.equal(await empty.page.moveSpotToPosition({ _id: "only" }, 1), true);
  assert.deepEqual(ranked(empty.ctx), [["only", 1]]);
  assert.equal(empty.page.spotSortMoveDisabled({ _id: "only" }), true);
  assert.equal(empty.page.spotSortMoveDisabled({ _id: "only" }, 1), true);
});

test("打卡点指定位置弹窗使用全局范围并校验整数，取消或当前顺位不写入", async () => {
  const spots = fiveSpots();
  spots[4].name = "唯一目标";
  const f = fixture({ spots, promptResult: { value: " 3 " } });
  f.page.spotCityFilter.value = "city";
  f.ctx.state.filters.keyword = "唯一目标";
  assert.equal(await f.page.promptSpotSort({ id: "e" }), true);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].title, "移动到指定位置");
  assert.equal(f.prompts[0].options.confirmButtonText, "确定");
  const { inputValidator } = f.prompts[0].options;
  for (const value of ["", "0", "-1", "1.5", "1e0", "6", "abc", "9007199254740993"]) {
    assert.equal(inputValidator(value), "请输入 1 到 5 之间的整数", value);
  }
  for (const value of ["1", "5", " 2 "]) assert.equal(inputValidator(value), true, value);
  assert.deepEqual(f.writes, [{ key: "spots", id: "e", patch: { sort: 3 } }]);
  for (const reason of ["cancel", "close"]) {
    f.ctx.ElMessageBox.prompt = async () => { throw reason; };
    assert.equal(await f.page.promptSpotSort({ id: "e" }), false);
  }
  f.ctx.ElMessageBox.prompt = async () => ({ value: "3" });
  assert.equal(await f.page.promptSpotSort({ id: "e" }), false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.logs.length, 1);
});

test("指定位置保存时全局锁定新旧排序入口，成功前不改变顺位且只应用服务端结果", async () => {
  let finish;
  const f = fixture({ spots: fiveSpots(), update: () => new Promise(resolve => { finish = resolve; }) });
  const before = clone(f.ctx.data.spots);
  const saving = f.page.moveSpotToPosition({ id: "e" }, 1);
  assert.deepEqual(f.writes, [{ key: "spots", id: "e", patch: { sort: 1 } }]);
  assert.deepEqual(f.ctx.data.spots, before);
  assert.equal(f.ctx.isSpotOrderSaving(), true);
  for (const row of f.ctx.data.spots) {
    assert.equal(f.page.spotSortMoveDisabled(row), true);
    assert.equal(f.page.spotSortMoveDisabled(row, 1), true);
    assert.equal(f.page.spotSortDisabled(row, -1), true);
    assert.equal(f.page.spotSortDisabled(row, 1), true);
  }
  assert.equal(await f.page.moveSpotToPosition({ id: "c" }, 1), false);
  assert.equal(await f.page.promptSpotSort({ id: "c" }), false);
  assert.equal(await f.page.changeSpotSort({ id: "c" }, -1), false);
  assert.equal(await f.ctx.persistSpotSort(f.ctx.data.spots[2], 1), false);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.writes.length, 1);
  finish({ ...f.serverRows[4], sort: 1, __spotOrder: [{ id: "e", sort: 1 }, { id: "a", sort: 2 }, { id: "b", sort: 3 }, { id: "c", sort: 4 }, { id: "d", sort: 5 }] });
  assert.equal(await saving, true);
  assert.deepEqual(ranked(f.ctx), [["e", 1], ["a", 2], ["b", 3], ["c", 4], ["d", 5]]);
  assert.equal(f.ctx.isSpotOrderSaving(), false);
  assert.equal(f.page.spotSortMoveDisabled({ id: "c" }), false);
  assert.equal(f.page.spotRowClassName({ row: { id: "e" } }), "is-sort-highlighted");
  assert.equal(f.logs.length, 1);
});

test("指定位置失败保留全部点位及分页，释放锁且不显示成功高亮", async () => {
  for (const reply of [null, { error: "排序暂不可用" }, new Error("网络中断")]) {
    const f = fixture({ spots: fiveSpots(), update: async () => { if (reply instanceof Error) throw reply; return reply; } });
    const before = clone(f.ctx.data.spots);
    f.ctx.pager("spots").page = 4;
    assert.equal(await f.page.moveSpotToPosition({ id: "e" }, 1), false);
    assert.deepEqual(f.ctx.data.spots, before);
    assert.equal(f.ctx.pager("spots").page, 4);
    assert.equal(f.ctx.isSpotOrderSaving(), false);
    assert.equal(f.page.spotSortMoveDisabled({ id: "e" }, 1), false);
    assert.equal(f.page.spotRowClassName({ row: { id: "e" } }), "");
    assert.equal(f.logs.length, 0);
    assert.match(f.messages.at(-1), /失败|不可用|中断/);
  }
});

test("指定位置拒绝越界、非法值、无权限、删除及无效点位，单个已排名点位不可重复移动", async () => {
  const f = fixture({ spots: fiveSpots() });
  const before = clone(f.ctx.data.spots);
  for (const target of [0, -1, 6, 1.5, "2", null, undefined, NaN, Infinity]) {
    assert.equal(await f.page.moveSpotToPosition({ id: "c" }, target), false);
  }
  assert.equal(await f.page.moveSpotToPosition({ id: "c" }, 3), false);
  f.ctx.can = () => false;
  assert.equal(f.page.spotSortMoveDisabled({ id: "c" }), true);
  assert.equal(await f.page.moveSpotToPosition({ id: "c" }, 1), false);
  assert.equal(await f.page.promptSpotSort({ id: "c" }), false);
  f.ctx.can = () => true;
  f.ctx.data.spots[0].deleted = true;
  f.ctx.data.spots[1].isDeleted = true;
  for (const row of [{ id: "a" }, { id: "b" }, { id: "missing" }, {}, null, undefined]) {
    assert.equal(f.page.spotSortMoveDisabled(row), true);
    assert.equal(await f.page.moveSpotToPosition(row, 1), false);
    assert.equal(await f.page.promptSpotSort(row), false);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.ctx.data.spots.map(row => row.sort), before.map(row => row.sort));
  const lone = fixture({ spots: [{ id: "only", sort: 1 }] });
  assert.equal(lone.page.spotSortMoveDisabled({ id: "only" }), true);
  assert.equal(await lone.page.promptSpotSort({ id: "only" }), false);
  assert.equal(await lone.page.moveSpotToPosition({ id: "only" }, 1), false);
  assert.equal(lone.writes.length, 0);
});
