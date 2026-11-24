"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const createApi = require("../lib/api.cjs");
const { prepareGuideForSave } = require("../lib/guideContent.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const rpc = require("../lib/rpc.cjs");

async function fixture(t) {
  const rows = {
    staff: [{ id: "admin", account: "admin", role: "super", status: "启用" }, { id: "editor", account: "editor", role: "content", status: "启用" }],
    cities: [{ id: "city", name: "长沙", status: "运营中" }],
    spots: [{ id: "a", name: "A", cityId: "city", isShow: true, address: "江边", intro: "江景", tag: "推荐", tags: ["风景"], cover: "https://test.invalid/a.jpg" }, { id: "b", name: "B", cityId: "city", isShow: true }],
    series: [],
    albums: [{ id: "photo-a", name: "A照片", spotId: "a", price: 100.1, isShow: true, cover: "https://test.invalid/a.jpg", shootingNotes: "拍摄说明", tags: ["清新"], photoCount: 9, retouchCount: 9 }, { id: "photo-manual", name: "单独隐藏", spotId: "a", price: 12, isShow: false, tags: ["清新"] }],
    packages: [{ id: "video-b", name: "B视频", productKind: "video_single", type: "video", spotId: "b", price: 20.2, isShow: true, tags: ["电影感"] },
      { id: "bundle", name: "两地点套餐", spotIds: ["a", "b"], price: 110, isShow: true, tags: ["组合"], includedItems: [{ type: "album", albumId: "photo-a" }, { type: "video", productId: "video-b" }] }],
    peripherals: [{ id: "global", name: "通用周边", isShow: true, price: 3, stock: 7, unit: "件", shippingFee: 0,
      cover: "https://test.invalid/peripheral.jpg", intro: "周边商品说明", soldCount: 6 }],
    guides: [{ id: "guide-a", title: "A灵感", name: "A灵感", status: "启用", spotId: "a", content: "正文", mediaItems: [{ url: "https://test.invalid/photo.jpg", type: "image" }] }],
    tagLibrary: [], trash: [], logs: [],
    orders: [{ id: "historical", packageId: "bundle", spotId: "a", price: 110, packageSnapshot: { name: "两地点套餐", spotId: "a" } }],
  };
  let fail = null;
  const source = {
    async list(key) { return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find((row) => String(row.id || row._id) === String(id)) || null); },
    async create(key, body) {
      if (fail && fail("create", key, body)) throw new Error("injected");
      const row = structuredClone({ ...body, id: body.id || `${key}-${(rows[key] || []).length}` });
      (rows[key] ||= []).push(row); return structuredClone(row);
    },
    async update(key, id, body) {
      if (fail && fail("update", key, body)) throw new Error("injected");
      const row = (rows[key] || []).find((item) => item.id === id); if (!row) return null;
      Object.assign(row, structuredClone(body)); return structuredClone(row);
    },
    async replace(key, id, body) { const i = (rows[key] || []).findIndex((row) => row.id === id); if (i < 0) return null; rows[key][i] = structuredClone(body); return structuredClone(body); },
    async remove(key, id) { const i = (rows[key] || []).findIndex((row) => row.id === id); if (i < 0) return false; rows[key].splice(i, 1); return true; },
  };
  const auth = { async init() {}, async getSession(token) { return ["admin", "editor"].includes(token) ? { kind: "admin", role: token === "admin" ? "super" : "content", subjectId: token, account: token } : null; } };
  const handler = createApi(source, "json", { auth });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (key, id = "", body, method = body === undefined ? "GET" : "PUT", token = "admin") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/collection/${key}${id ? `/${id}` : ""}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { rows, source, request, setFailure: (callback) => { fail = callback; } };
}

test("three product types require configured tags on draft, offline, and published creation or editing", async (t) => {
  const f = await fixture(t);
  f.rows.series.push({ id: "linked-style", name: "关联风格" });
  const products = [
    ["albums", { name: "照片留影", cover: "https://test.invalid/photo.jpg", shootingNotes: "拍摄说明", photoCount: 3, retouchCount: 0, price: 10 }],
    ["packages", { name: "视频摄像", type: "video", productKind: "video_single", videoUrl: "https://test.invalid/video.mp4", shootingNotes: "拍摄说明", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "3天", price: 10 }],
    ["packages", { name: "旅拍套餐", type: "photo", productKind: "package", includedItems: [{ type: "album", albumId: "photo-a" }], price: 10 }]
  ];
  let sequence = 0;
  for (const [key, fields] of products) {
    for (const status of ["草稿", "下架", "上架"]) {
      const base = { ...fields, isShow: status === "上架", status, seriesId: "linked-style", serviceTags: ["旧服务标签"], styleTags: ["旧风格标签"] };
      for (const tags of [undefined, null, [], [" ", "\t"], " ，,| ", false, [null, {}, false]]) {
        const id = `invalid-tags-${sequence++}`;
        const before = structuredClone(f.rows);
        const invalid = await f.request(key, "", { ...base, id, tags }, "POST");
        assert.equal(invalid.status, 400, JSON.stringify({ key, status, tags, result: invalid.body }));
        assert.match(invalid.body.error, /请至少添加一个标签/);
        assert.deepEqual(f.rows, before, "Rejected tags must not persist the product, alias tags, or audit records");
      }
      const id = `valid-tags-${sequence++}`;
      const created = await f.request(key, "", { ...base, id, tags: [" 自定义标签 ", "自定义标签"] }, "POST");
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.deepEqual(created.body.tags, ["自定义标签"]);
      const updated = await f.request(key, id, { name: `${fields.name}已修改` });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.deepEqual(updated.body.tags, ["自定义标签"], "An omitted update field preserves the valid stored tags");
      for (const tags of [[], " ", [" "]]) {
        const before = await f.source.get(key, id);
        const cleared = await f.request(key, id, { tags });
        assert.equal(cleared.status, 400, JSON.stringify(cleared.body));
        assert.match(cleared.body.error, /请至少添加一个标签/);
        assert.deepEqual(await f.source.get(key, id), before);
      }
    }
  }
});

test("legacy untagged products can be withdrawn, but content edits and republishing still require tags", async (t) => {
  const f = await fixture(t);
  for (const [key, id] of [["albums", "photo-a"], ["packages", "video-b"], ["packages", "bundle"]]) {
    const row = f.rows[key].find((item) => item.id === id);
    delete row.tags;
    const hidden = await f.request(key, id, { isShow: false, status: "下架" });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    for (const patch of [{ name: "不能无标签保存" }, { tags: [], price: 1 }, { isShow: true, status: "上架" }]) {
      const before = await f.source.get(key, id);
      const rejected = await f.request(key, id, patch);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.match(rejected.body.error, /请至少添加一个标签/);
      assert.deepEqual(await f.source.get(key, id), before);
    }
    const fixed = await f.request(key, id, { tags: ["补齐标签"], name: "标签已补齐" });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  }
});

test("restoring cannot publish untagged products or silently accept tags from a recycle snapshot", async (t) => {
  const f = await fixture(t);
  Object.assign(f.rows.packages.find((row) => row.id === "video-b"), {
    videoUrl: "https://test.invalid/video.mp4", shootingNotes: "拍摄说明", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "3天"
  });
  for (const [key, id, tags] of [["albums", "photo-a", []], ["packages", "video-b", [" "]], ["packages", "bundle", undefined]]) {
    const row = f.rows[key].find((item) => item.id === id);
    row.tags = tags;
    row.isShow = false; row.status = "下架";
    assert.equal((await f.request(key, id, undefined, "DELETE")).status, 200);
    for (const extra of [{}, { tags: ["恢复请求中新填写的标签"] }]) {
      const before = structuredClone(f.rows);
      const published = await f.request(key, id, { deleted: false, isDeleted: false, isShow: true, status: "上架", ...extra });
      assert.equal(published.status, 400, JSON.stringify(published.body));
      assert.match(published.body.error, /先恢复为隐藏状态.*标签/);
      assert.deepEqual(f.rows, before, "Rejected restoration preserves the deleted record and its recycle entry");
    }
    const hidden = await f.request(key, id, { deleted: false, isDeleted: false, isShow: false, status: "下架" });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.equal(hidden.body.effectiveVisible, false);
    assert.equal(f.rows.trash.some((item) => item.sourceKey === key && item.sourceId === id), false);
    const fixed = await f.request(key, id, { tags: ["补齐标签"] });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    const shown = await f.request(key, id, { isShow: true, status: "上架" });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.deepEqual(shown.body.tags, ["补齐标签"]);
    assert.equal(shown.body.effectiveVisible, true);
  }
});

test("HTTP shelf toggles restore a previously approved video and its package without stale audit state", async (t) => {
  const f = await fixture(t);
  const video = f.rows.packages.find((row) => row.id === "video-b");
  Object.assign(video, {
    status: "上架", auditStatus: "已下", tags: ["自然"], shootingNotes: "拍摄说明",
    videoUrl: "https://test.invalid/clip.mp4", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "3天"
  });
  const before = await f.request("packages", "bundle");
  assert.equal(before.body.effectiveVisible, false);
  const hidden = await f.request("packages", video.id, { isShow: false, status: "下架" });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.auditStatus, "已下");
  const shown = await f.request("packages", video.id, { isShow: true, status: "上架" });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.equal(shown.body.auditStatus, "已上");
  assert.equal(shown.body.effectiveVisible, true);
  assert.equal((await f.request("packages", "bundle")).body.effectiveVisible, true);
  const priced = await f.request("packages", "bundle", { price: 1 });
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  const home = await rpc(f.source, "getHomeData", { cityId: "city", spotId: "a", spotProductsOnly: true });
  assert.equal(home.success, true);
  assert.equal(home.data.spotProducts.packages.find((row) => row.id === "bundle").price, 1);
  assert.equal((await rpc(f.source, "getSeriesDetail", { packageId: "bundle" })).data.currentPackage.price, 1);
});

test("peripheral single-spec sales parameters persist and stock aliases remain synchronized", async (t) => {
  const f = await fixture(t);
  const result = await f.request("peripherals", "global", { specMode: "single", productCode: "  FRAME-01  ", unit: " 套 ", stock: 0, stockQty: 7, stockWarning: 3, shippingFee: "5.13", price: 29.9 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.productCode, "FRAME-01"); assert.equal(result.body.unit, "套");
  assert.equal(result.body.stock, 0); assert.equal(result.body.stockQty, 0);
  assert.equal(result.body.stockWarning, 3); assert.equal(result.body.shippingFee, 5.13);
  assert.equal((await f.request("peripherals", "global", { stockQty: "11" }, "PUT", "editor")).body.stock, 11);
  assert.equal((await f.request("peripherals", "global")).body.stockQty, 11);
  const draft = await f.request("peripherals", "", { id: "new-product", name: "待配商品", price: 1, stock: 0,
    shippingFee: 0, cover: "https://test.invalid/new.jpg", intro: "商品说明" }, "POST");
  assert.equal(draft.status, 201); assert.equal(draft.body.specMode, "single");
  assert.equal(draft.body.unit, "件"); assert.equal(draft.body.stock, 0); assert.equal(draft.body.stockWarning, 5);
  f.rows.peripherals.push({ id: "legacy", name: "历史周边", isShow: false });
  const legacy = await f.request("peripherals", "legacy", { name: "改名" });
  assert.equal(legacy.status, 400, "历史不完整商品普通编辑必须补齐配置");
  assert.equal((await f.source.get("peripherals", "legacy")).stock, undefined, "拒绝时不虚构库存");
});

test("peripheral required configuration is enforced on creation and every editor save, including hidden products", async (t) => {
  const f = await fixture(t);
  const complete = { name: "现货相框", unit: "件", price: 39.9, stock: 2, shippingFee: 0,
    cover: "https://test.invalid/frame.jpg", intro: "现货相框说明" };
  let sequence = 0;
  for (const status of ["草稿", "下架", "上架"]) {
    for (const field of ["name", "price", "stock", "shippingFee", "cover", "intro"]) {
      const id = `incomplete-${sequence++}`;
      const product = { ...complete, id, status, isShow: status === "上架" };
      delete product[field];
      const created = await f.request("peripherals", "", product, "POST");
      assert.equal(created.status, 400, JSON.stringify({ status, field, body: created.body }));
      assert.equal(await f.source.get("peripherals", id), null);
    }
    const id = `complete-${sequence++}`;
    const created = await f.request("peripherals", "", { ...complete, id, status, isShow: status === "上架" }, "POST");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const before = await f.source.get("peripherals", id);
    for (const patch of [{ name: " " }, { price: 0 }, { stock: null }, { shippingFee: null }, { unit: " " }, { cover: "" }, { intro: "" }]) {
      const updated = await f.request("peripherals", id, patch);
      assert.equal(updated.status, 400, JSON.stringify({ status, patch, body: updated.body }));
      assert.deepEqual(await f.source.get("peripherals", id), before);
    }
    assert.equal((await f.request("peripherals", id, { name: "改名后相框" })).status, 200, "合法旧值允许PATCH继承");
  }
  for (const field of ["price", "stock", "shippingFee", "unit", "cover", "intro"]) {
    const id = `legacy-missing-${field}`;
    const product = { ...complete, id, isShow: true };
    delete product[field];
    f.rows.peripherals.push(product);
    assert.equal((await f.request("peripherals", id, { name: "普通修改" })).status, 400, field);
    assert.deepEqual(await f.source.get("peripherals", id), product);
  }
});

test("peripheral money matches checkout limits; free shipping and zero stock remain valid explicit values", async (t) => {
  const f = await fixture(t);
  for (const field of ["price", "shippingFee"]) {
    for (const amount of [0.001, 5.125, 10000000.01, 10000000.001]) {
      const updated = await f.request("peripherals", "global", { [field]: amount });
      assert.equal(updated.status, 400, JSON.stringify({ field, amount, body: updated.body }));
    }
  }
  const result = await f.request("peripherals", "global", { price: 10000000, shippingFee: 0, stock: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.price, 10000000); assert.equal(result.body.shippingFee, 0); assert.equal(result.body.stock, 0);
  assert.equal((await f.request("peripherals", "global", { price: 0.1 + 0.2 })).status, 200, "允许正常浮点运算误差");
  const sku = { spec: "标准款", price: 0.01, stock: 0 };
  const soldOut = await f.request("peripherals", "global", { specMode: "multiple", skus: [sku] });
  assert.equal(soldOut.status, 200, JSON.stringify(soldOut.body));
  assert.equal(soldOut.body.stock, 0);
  for (const price of [0, 0.001, 5.125, 10000000.01]) {
    assert.equal((await f.request("peripherals", "global", { skus: [{ ...sku, price }] })).status, 400, `SKU ${price}`);
  }
});

test("only visibility changes bypass incomplete peripheral configuration, including internal-only withdrawal", async (t) => {
  const f = await fixture(t);
  for (const [id, patch] of [["offline-legacy", { isShow: false, status: "下架" }], ["private-legacy", { internalOnly: true }]]) {
    const legacy = { id, name: "历史未配商品", isShow: true, price: 0 };
    f.rows.peripherals.push(legacy);
    assert.equal((await f.request("peripherals", id, { ...patch, intro: "隐藏同时改说明" })).status, 400);
    assert.deepEqual(await f.source.get("peripherals", id), legacy);
    const hidden = await f.request("peripherals", id, patch);
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.equal(hidden.body.stock, undefined); assert.equal(hidden.body.shippingFee, undefined); assert.equal(hidden.body.unit, undefined);
    assert.equal((await f.request("peripherals", id, { isShow: true, status: "上架", internalOnly: false })).status, 400);
  }
});

test("legacy peripherals with unknown stock can be hidden before deletion without inventing inventory", async (t) => {
  const f = await fixture(t);
  const id = "legacy-diy";
  f.rows.peripherals.push({ id, name: "创意DIY套装", price: 139, isShow: true, status: "上架" });

  const blocked = await f.request("peripherals", id, undefined, "DELETE");
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /先隐藏/);

  const hidden = await f.request("peripherals", id, { isShow: false, status: "下架", auditStatus: "已下" });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.stock, undefined);
  assert.equal(hidden.body.stockQty, undefined);
  assert.equal(hidden.body.price, 139);
  const persisted = await f.request("peripherals", id);
  assert.equal(persisted.body.isShow, false);
  assert.equal(persisted.body.effectiveVisible, false);
  assert.equal(persisted.body.stock, undefined);

  const removed = await f.request("peripherals", id, { deleted: true, isDeleted: true, isShow: false, status: "下架" });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.deleted, true);
  assert.equal(removed.body.isDeleted, true);
  assert.equal(removed.body.stock, undefined);
  const trash = f.rows.trash.find((row) => row.sourceKey === "peripherals" && row.sourceId === id);
  assert.ok(trash);
  assert.equal(trash.source.name, "创意DIY套装");
  assert.equal(trash.source.stock, undefined);
  const recycled = await f.request("trash", "", { sourceKey: "peripherals", source: removed.body }, "POST");
  assert.equal(recycled.status, 200, JSON.stringify(recycled.body));
  assert.equal(recycled.body.id, trash.id);
  assert.equal(f.rows.trash.filter((row) => row.sourceKey === "peripherals" && row.sourceId === id).length, 1);
});

test("peripheral multiple-spec prices and total stock derive only from validated SKU rows", async (t) => {
  const f = await fixture(t);
  f.rows.peripherals[0].specialPrice = 999;
  f.rows.peripherals[0].salePrice = 888;
  const skus = [{ spec: " 6寸 / 原木色 ", skuCode: " F-6 ", price: "20.00", stock: "3" }, { spec: "10寸 / 原木色", skuCode: "F-10", price: 39.9, stock: 0 }];
  let result = await f.request("peripherals", "global", { specMode: "multiple", skus, price: 1, stock: 999, specs: ["不能作为真实规格"] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.price, 20); assert.equal(result.body.specialPrice, 20); assert.equal(result.body.salePrice, 20);
  assert.equal(result.body.stock, 3); assert.equal(result.body.stockQty, 3);
  assert.deepEqual(result.body.specs, ["6寸 / 原木色", "10寸 / 原木色"]);
  assert.equal(result.body.skus[0].skuCode, "F-6"); assert.equal(result.body.skus[0].price, 20);
  result = await f.request("peripherals", "global", { price: 0.01, stock: 100, specs: ["货架上的旧规格"] });
  assert.equal(result.body.price, 20); assert.equal(result.body.stock, 3, "货架编辑不能覆盖SKU汇总");
  result = await f.request("peripherals", "global", { specMode: "single", price: 25.5, stock: 7, specs: ["标准款"] });
  assert.equal(result.body.price, 25.5); assert.equal(result.body.specialPrice, 25.5);
  assert.equal(result.body.stock, 7); assert.deepEqual(result.body.skus, []);
  assert.deepEqual(result.body.specs, ["标准款"]);
});

test("peripheral styles round-trip, distinguish same-size options and retain saved SKU identities", async (t) => {
  const f = await fixture(t);
  let result = await f.request("peripherals", "global", { skuStyle: " 可横可竖 " });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.skuStyle, "可横可竖");
  assert.ok(!f.rows.tagLibrary.some(tag => tag.name === "可横可竖"), "商品样式不写入风格标签库");
  result = await f.request("peripherals", "global", { specMode: "multiple", skus: [
    { spec: "8寸", style: " 可横可竖 ", price: 20, stock: 2 },
    { spec: "8寸", style: "两宫格", price: 25, stock: 3 },
    { spec: "10寸", price: 30, stock: 1 }
  ] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.skus.map(sku => sku.style), ["可横可竖", "两宫格", ""]);
  assert.equal(result.body.skus[0].skuCode, "", "首个无编码规格保留历史身份算法");
  assert.match(result.body.skus[1].skuCode, /^AUTO-/);
  assert.equal(result.body.skus[2].skuCode, "", "不同尺寸无需生成编码");
  const codes = result.body.skus.map(sku => sku.skuCode);
  result = await f.request("peripherals", "global", { skus: result.body.skus.map((sku, index) => ({ ...sku, style: index === 1 ? "单幅/四宫格" : sku.style })) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.skus.map(sku => sku.skuCode), codes, "修改样式不会重建规格编码");
  assert.equal(result.body.skus[1].style, "单幅/四宫格");
  const split = schema.splitDocument("peripherals", result.body);
  const restored = schema.hydrateDocument("peripherals", { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  assert.deepEqual(restored.skus, result.body.skus);
  assert.equal(restored.skuStyle, "可横可竖");
  const before = structuredClone(f.rows.peripherals[0]);
  const duplicate = await f.request("peripherals", "global", { skus: [before.skus[0], { ...before.skus[0], skuCode: "different", style: " 可横可竖 " }] });
  assert.equal(duplicate.status, 400); assert.match(duplicate.body.error, /样式组合不能重复/);
  assert.deepEqual(f.rows.peripherals[0], before);
  result = await f.request("peripherals", "global", { skuStyle: "" });
  assert.equal(result.status, 200); assert.equal(result.body.skuStyle, "");
});

test("adding a same-size style before an existing uncoded row preserves the existing inventory key", async (t) => {
  const f = await fixture(t);
  f.rows.peripherals[0].specMode = "multiple";
  f.rows.peripherals[0].skus = [{ spec: "8寸", style: "可横可竖", skuCode: "", price: 20, stock: 2 }];
  const result = await f.request("peripherals", "global", { skus: [
    { spec: "8寸", style: "两宫格", price: 25, stock: 3 },
    f.rows.peripherals[0].skus[0]
  ] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.skus[0].skuCode, /^AUTO-/);
  assert.equal(result.body.skus[1].skuCode, "", "按原样式匹配，不将旧身份移给前插的新样式");
});

test("invalid peripheral sales parameters never mutate stock or SKU rows", async (t) => {
  const f = await fixture(t);
  const invalid = [
    ...[null, "", " ", 0, true, false, [], {}, "NaN", "Infinity", 1e308, Number.MAX_SAFE_INTEGER].map((price) => ({ price })),
    ...[null, "", " ", -1, 1.5, true, [], {}, "NaN", "Infinity", 2147483648].map((stock) => ({ stock })),
    { stockQty: null }, { stockWarning: -1 }, { stockWarning: 1.1 }, { unit: " " }, { unit: {} }, { productCode: {} },
    { skuStyle: null }, { skuStyle: {} }, { skuStyle: "横".repeat(81) },
    { shippingFee: null }, { shippingFee: -0.01 }, { shippingFee: "Infinity" }, { specMode: "unlimited" }, { skus: {} },
    { specMode: "multiple", skus: [] }, { specMode: "multiple", skus: [null] },
    { specMode: "multiple", skus: [{ spec: " ", price: 2, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", price: null, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", price: -1, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", price: 1, stock: 0.1 }] },
    { specMode: "multiple", skus: [{ spec: "A", style: null, price: 1, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", style: [], price: 1, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", style: "横".repeat(81), price: 1, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", price: 1, stock: 1 }, { spec: " A ", price: 2, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "8寸", style: "可横可竖", price: 1, stock: 1 }, { spec: "8寸", style: "两宫格", skuCode: "8寸", price: 2, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", skuCode: "X", price: 1, stock: 1 }, { spec: "B", skuCode: " X ", price: 2, stock: 1 }] },
    { specMode: "multiple", skus: [{ spec: "A", price: 1, stock: 2147483647 }, { spec: "B", price: 1, stock: 1 }] },
    { specMode: "multiple", skus: Array.from({ length: 101 }, (_, i) => ({ spec: String(i), price: 1, stock: 0 })) },
  ];
  for (const patch of invalid) {
    const before = structuredClone(f.rows.peripherals[0]);
    const result = await f.request("peripherals", "global", patch);
    assert.equal(result.status, 400, JSON.stringify({ patch, body: result.body }));
    assert.deepEqual(f.rows.peripherals[0], before, JSON.stringify(patch));
  }
  const boundary = await f.request("peripherals", "global", { specMode: "multiple", skus: Array.from({ length: 100 }, (_, i) => ({ spec: String(i), price: 0.01, stock: i ? 0 : 2147483647 })) });
  assert.equal(boundary.status, 200, JSON.stringify(boundary.body)); assert.equal(boundary.body.stock, 2147483647);
});

test("peripheral SKU rows and sales parameters survive typed-leaf SQL storage", () => {
  const input = { id: "sku-product", specMode: "multiple", productCode: "P-1", unit: "套", stock: 3, stockQty: 3, stockWarning: 5, shippingFee: 6.5, price: 19.9,
    specs: ["6寸", "10寸"], skus: [{ spec: "6寸", skuCode: "S-6", price: 19.9, stock: 0 }, { spec: "10寸", skuCode: "S-10", price: 29.9, stock: 3 }] };
  const split = schema.splitDocument("peripherals", input);
  assert.equal(split.columns.stock, 3); assert.equal(split.columns.stockQty, 3);
  assert.ok(split.attributes.some((row) => row.path.startsWith("skus")), "SKU使用现有扩展属性存储");
  const restored = schema.hydrateDocument("peripherals", { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  for (const field of ["specMode", "productCode", "unit", "stock", "stockQty", "stockWarning", "shippingFee", "price", "specs", "skus"]) assert.deepEqual(restored[field], input[field], field);
});

test("catalog editors keep mobile aliases synchronized and clearing never revives old values", async (t) => {
  const f = await fixture(t);
  f.rows.packages[0].intro = "旧视频说明";
  const video = await f.request("packages", "video-b", { shootingNotes: "新视频说明", tags: "情侣，日落|情侣" });
  assert.equal(video.status, 200, JSON.stringify(video.body));
  assert.equal(video.body.intro, "新视频说明");
  assert.deepEqual(video.body.tags, ["情侣", "日落"]);
  assert.equal((await f.request("packages", "video-b", { shootingNotes: "" })).body.intro, "");
  assert.equal((await f.request("packages", "bundle", { description: "组合服务说明" })).body.intro, "组合服务说明");
  assert.equal((await f.request("packages", "bundle", { description: "" })).body.intro, "");
  const peripheral = await f.request("peripherals", "global", {
    intro: "实木相框说明", description: "旧说明", cover: "https://test.invalid/new.jpg", image: "https://test.invalid/old.jpg",
    specs: "10寸 / 原木色，10寸", tags: "原木,定制", category: "相框",
  });
  assert.equal(peripheral.status, 200, JSON.stringify(peripheral.body));
  assert.equal(peripheral.body.description, "实木相框说明");
  assert.equal(peripheral.body.image, peripheral.body.cover);
  assert.equal(peripheral.body.cate, "相框");
  assert.deepEqual(peripheral.body.specs, ["10寸", "原木色"]);
  assert.deepEqual(peripheral.body.tags, ["原木", "定制"]);
  const catalog = await rpc(f.source, "getPeripherals", {});
  const mobile = catalog.data.find((item) => item.id === "global");
  assert.equal(mobile.description, "实木相框说明");
  assert.deepEqual(mobile.specs, ["10寸", "原木色"]);
  assert.equal(mobile.stock, undefined, "库存仅用于后台商品管理");
  const cleared = await f.request("peripherals", "global", { intro: "新的说明", cover: "", images: ["https://test.invalid/detail.jpg"], specs: [], tags: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.description, "新的说明"); assert.equal(cleared.body.image, "");
  assert.deepEqual(cleared.body.specs, []); assert.deepEqual(cleared.body.tags, []);
  assert.equal(cleared.body.stock, 7, "编辑说明不改变已有库存");
});

test("spot cover aliases accept legacy updates and explicit clearing removes every old image", async (t) => {
  const f = await fixture(t);
  for (const field of ["coverUrl", "coverImage", "image", "cover"]) {
    const cover = `https://test.invalid/${field}.jpg`;
    const updated = await f.request("spots", "a", { [field]: cover });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    for (const alias of ["cover", "coverUrl", "coverImage", "image"]) assert.equal(updated.body[alias], cover);
    const home = await rpc(f.source, "getHomeData", {});
    const detail = await rpc(f.source, "getSpots", {});
    assert.equal(home.data.spots.find((row) => row._id === "a").cover, cover);
    assert.equal(detail.data.find((row) => row._id === "a").coverUrl, cover);
  }
  const cleared = await f.request("spots", "a", { cover: "", isShow: false });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  for (const field of ["cover", "coverUrl", "coverImage", "image"]) assert.equal(cleared.body[field], "");
  const republish = await f.request("spots", "a", { isShow: true });
  assert.equal(republish.status, 400, JSON.stringify(republish.body));
  assert.match(republish.body.error, /首图/);
});

test("point hide derives whole-package and inspiration visibility; show restores only manually visible products", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("spots", "a", { isShow: false })).status, 200);
  assert.equal(f.rows.albums[0].spotId, "a");
  assert.equal(f.rows.albums[0].isShow, true);
  assert.equal((await f.request("albums", "photo-a")).body.effectiveVisible, false);
  assert.equal((await f.request("packages", "bundle")).body.effectiveVisible, false);
  assert.equal((await f.request("guides", "guide-a")).body.effectiveVisible, false);
  assert.equal((await f.request("peripherals", "global")).body.effectiveVisible, true);
  assert.equal((await f.request("spots", "a", { isShow: true })).status, 200);
  assert.equal((await f.request("albums", "photo-a")).body.effectiveVisible, true);
  assert.equal((await f.request("albums", "photo-manual")).body.effectiveVisible, false);
  assert.equal((await f.request("packages", "bundle")).body.effectiveVisible, true);
});

test("manually hiding an included product forces related packages hidden and preserves historical orders", async (t) => {
  const f = await fixture(t); const orders = structuredClone(f.rows.orders);
  assert.equal((await f.request("albums", "photo-a", { isShow: false })).status, 200);
  const bundle = (await f.request("packages", "bundle")).body;
  assert.equal(bundle.effectiveVisible, false); assert.equal(bundle.isShow, true);
  assert.deepEqual(f.rows.orders, orders);
  await f.request("albums", "photo-a", { isShow: true });
  assert.equal((await f.request("packages", "bundle")).body.effectiveVisible, true);
});

test("content deletion requires super and hidden state, unlinks all point relations, and uses recycle records", async (t) => {
  const f = await fixture(t); const orders = structuredClone(f.rows.orders);
  assert.equal((await f.request("spots", "a", undefined, "DELETE")).status, 409);
  assert.equal((await f.request("spots", "a", { deleted: 1 }, "PUT", "editor")).status, 400);
  await f.request("spots", "a", { isShow: false });
  assert.equal((await f.request("spots", "a", { deleted: true }, "PUT", "editor")).status, 403);
  assert.equal((await f.request("spots", "a", undefined, "DELETE")).status, 200);
  assert.equal(f.rows.spots[0].deleted, true);
  assert.equal(f.rows.albums[0].spotId, ""); assert.equal(f.rows.guides[0].spotId, "");
  assert.deepEqual(f.rows.packages[1].spotIds, ["b"]);
  assert.deepEqual(f.rows.packages[1].deletedSpotIds, ["a"]);
  assert.equal((await f.request("packages", "bundle")).body.effectiveVisible, false);
  assert.deepEqual(f.rows.orders, orders);
  const trash = f.rows.trash[0];
  assert.equal((await f.request("trash", "", { sourceKey: "spots", source: { id: "a" } }, "POST")).body.id, trash.id);
  assert.equal(f.rows.trash.length, 1);
  assert.equal((await f.request("spots", "a", { deleted: false, isDeleted: false, isShow: true })).status, 200);
  assert.deepEqual(f.rows.packages[1].deletedSpotIds, []); assert.equal(f.rows.trash.length, 0);
});

test("recycle purge physically removes the source, and restoring an item cannot reintroduce stale point relations", async (t) => {
  const f = await fixture(t);
  await f.request("albums", "photo-manual", undefined, "DELETE");
  const albumTrash = f.rows.trash.find((row) => row.sourceKey === "albums");
  await f.request("spots", "a", { isShow: false });
  await f.request("spots", "a", undefined, "DELETE");
  assert.equal((await f.request("albums", "photo-manual", { ...albumTrash.source, deleted: false, isDeleted: false })).status, 200);
  assert.equal(f.rows.albums.find((row) => row.id === "photo-manual").spotId, "");
  const pointTrash = f.rows.trash.find((row) => row.sourceKey === "spots");
  assert.equal((await f.request("trash", pointTrash.id, undefined, "DELETE", "editor")).status, 403);
  assert.equal((await f.request("trash", pointTrash.id, undefined, "DELETE")).status, 200);
  assert.equal(await f.source.get("spots", "a"), null);
  assert.equal(f.rows.orders.length, 1);
});

test("package quantity drives original price; saved sale price is preserved; points derive from included products", async (t) => {
  const f = await fixture(t);
  const input = { id: "new", name: "组合", tags: ["组合"], isShow: true, spotIds: ["stale"], includedItems: [{ type: "album", albumId: "photo-a", quantity: 3 }, { type: "video", productId: "video-b", quantity: 2 }] };
  let result = await f.request("packages", "", input, "POST");
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.originalPrice, 340.7); assert.equal(result.body.price, 340.7);
  assert.deepEqual(result.body.spotIds, ["a", "b"]);
  result = await f.request("packages", "new", { price: 199.99 });
  assert.equal(result.body.price, 199.99);
  result = await f.request("packages", "new", { name: "新名字", effectiveVisible: false, visibilityReasons: ["fake"] });
  assert.equal(result.body.price, 199.99); assert.equal(result.body.effectiveVisible, true);
  assert.equal((await f.request("packages", "new", { includedItems: [{ type: "album", albumId: "photo-a", quantity: 0 }] })).status, 400);
  assert.equal((await f.request("packages", "new", { includedItems: [{ type: "album", albumId: "missing", quantity: 1 }] })).status, 400);
  assert.equal((await f.request("packages", "new", { includedItems: [] })).status, 400);
});

test("package variants retain separate SKU identities, authoritative prices and SQL metadata", async (t) => {
  const f = await fixture(t);
  const frame = { id: "frame", name: "相框", isShow: true, specMode: "multiple", price: 20, skus: [
    { spec: "8寸", style: "横版", skuCode: "FRAME-H", price: 20, stock: 4 },
    { spec: "8寸", style: "竖版", skuCode: "FRAME-V", price: 35.5, stock: 5 },
    { spec: "10寸", style: "", skuCode: "", price: 49, stock: 4 }
  ] };
  f.rows.peripherals.push(frame);
  const result = await f.request("packages", "", { id: "variant-bundle", name: "相框组合", tags: ["组合"], isShow: true, price: 100,
    includedItems: [
      { type: "peripheral", productId: "frame", quantity: 2, price: 0.01, target: { spec: "8寸", style: "横版" } },
      { type: "peripheral", productId: "frame", quantity: 3, skuId: "FRAME-V", spec: "伪造规格", style: "伪造样式", price: 0.01 },
      { type: "peripheral", productId: "frame", quantity: 1, spec: "10寸", style: "" }
    ] }, "POST");
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const items = result.body.includedItems;
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((item) => item.skuId)).size, 3);
  assert.deepEqual(items.map((item) => item.skuId), ["FRAME-H", "FRAME-V", ""]);
  assert.ok(items.every((item) => item.name === "相框"));
  assert.deepEqual(items.map((item) => item.price), [20, 35.5, 49]);
  assert.deepEqual(items.map((item) => item.specLabel), ["8寸【横版】", "8寸【竖版】", "10寸"]);
  assert.equal(result.body.originalPrice, 195.5); assert.equal(result.body.price, 100);
  for (const item of items) for (const field of ["skuId", "skuCode", "spec", "style", "specLabel"]) assert.equal(item.target[field], item[field]);
  assert.deepEqual(result.body.items, items);
  const split = schema.splitDocument("packages", result.body);
  const restored = schema.hydrateDocument("packages", { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  assert.deepEqual(restored.includedItems.map(({ skuId, skuCode, spec, style, specLabel, price, quantity }) => ({ skuId, skuCode, spec, style, specLabel, price, quantity })),
    items.map(({ skuId, skuCode, spec, style, specLabel, price, quantity }) => ({ skuId, skuCode, spec, style, specLabel, price, quantity })));
  const updated = await f.request("packages", "variant-bundle", { includedItems: restored.includedItems });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.includedItems.map((item) => item.skuId), items.map((item) => item.skuId));
});

test("package saves reject missing, ambiguous and removed multi-SKUs while accepting legacy single goods", async (t) => {
  const f = await fixture(t);
  f.rows.peripherals.push({ id: "frame", name: "相框", isShow: true, specMode: "multiple", price: 20, skus: [
    { spec: "8寸", style: "横版", skuCode: "H", price: 20, stock: 4 },
    { spec: "8寸", style: "竖版", skuCode: "V", price: 30, stock: 5 }
  ] });
  for (const selection of [{}, { spec: "8寸" }, { spec: "8寸", style: "已删除" }, { skuId: "missing", spec: "8寸", style: "横版" }]) {
    const before = structuredClone(f.rows.packages);
    const result = await f.request("packages", "bundle", { includedItems: [{ type: "peripheral", productId: "frame", ...selection }] });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error, /明确的规格/); assert.deepEqual(f.rows.packages, before);
  }
  f.rows.peripherals.at(-1).skus.pop();
  assert.equal((await f.request("packages", "bundle", { includedItems: [{ type: "peripheral", productId: "frame" }] })).status, 400, "A multiple-mode item must be explicitly selected even if one SKU remains");
  const malformed = f.rows.peripherals.at(-1).skus[0];
  malformed.price = null;
  const badPrice = await f.request("packages", "bundle", { includedItems: [{ type: "peripheral", productId: "frame", skuId: "H" }] });
  assert.equal(badPrice.status, 400); assert.match(badPrice.body.error, /单价/);
  malformed.price = 20;
  f.rows.packages.push({ id: "legacy-multi", name: "旧相框套餐", tags: ["组合"], isShow: true, includedItems: [{ type: "peripheral", productId: "frame" }] });
  const hidden = await f.request("packages", "legacy-multi", { isShow: false });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.isShow, false, "Incomplete historical packages must remain withdrawable without choosing a default variant");
  const edited = await f.request("packages", "legacy-multi", { name: "修改套餐" });
  assert.equal(edited.status, 400); assert.match(edited.body.error, /明确的规格/);
  Object.assign(f.rows.peripherals.at(-1), { specMode: "single", specs: ["6寸"], skuStyle: "横版", price: 25 });
  const changedMode = await f.request("packages", "bundle", { includedItems: [{ type: "peripheral", productId: "frame", spec: "8寸", style: "竖版" }] });
  assert.equal(changedMode.status, 400, "Changing the product to single mode cannot silently replace a selected historical SKU");
  const single = await f.request("packages", "bundle", { includedItems: [{ type: "peripheral", productId: "global", quantity: 2 }] });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.equal(single.body.includedItems[0].spec, "默认规格");
  assert.equal(single.body.originalPrice, 6);
});

test("optional product point accepts no association, rejects multiple; shared tags allow explicit duplicate names", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("albums", "photo-a", { spotIds: ["a", "b"] })).status, 400);
  assert.equal((await f.request("albums", "photo-a", { spotId: "", styles: ["新风格"] })).status, 200);
  assert.equal(f.rows.albums[0].spotId, ""); assert.deepEqual(f.rows.albums[0].spotIds, []);
  assert.ok(f.rows.tagLibrary.some((tag) => tag.name === "新风格"));
  for (const id of ["tag1", "tag2"]) assert.equal((await f.request("tagLibrary", "", { id, name: "同名", category: "style" }, "POST")).status, 201);
  assert.equal(f.rows.tagLibrary.filter((tag) => tag.name === "同名").length, 2);
  const peripheral = (await f.request("peripherals", "global")).body;
  assert.equal(peripheral.stock, 7); assert.equal(peripheral.soldCount, undefined);
  const guide = await prepareGuideForSave(f.source, { title: "无点位灵感", status: "启用", content: "正文", mediaType: "image", mediaItems: Array.from({ length: 20 }, () => ({ type: "image", url: "https://test.invalid/a.jpg" })) });
  assert.equal(guide.error, undefined); assert.equal(guide.guide.mediaItems.length, 20);
  await f.request("spots", "a", { tag: "同名分类", tags: ["同名分类"] });
  assert.deepEqual(f.rows.tagLibrary.filter((tag) => tag.name === "同名分类").map((tag) => tag.category).sort(), ["内容", "运营"].sort());
});

test("new records default to private drafts and required fields are enforced when publishing", async (t) => {
  const f = await fixture(t);
  const draft = await f.request("albums", "", { id: "draft-photo", name: "草稿", tags: ["清新"] }, "POST");
  assert.equal(draft.status, 201); assert.equal(draft.body.isShow, false); assert.equal(draft.body.effectiveVisible, false);
  assert.equal((await f.request("albums", "draft-photo", { isShow: true, status: "上架" })).status, 400);
  assert.equal((await f.request("albums", "", { id: "invalid-photo", name: "不完整", isShow: true }, "POST")).status, 400);
  const published = await f.request("albums", "draft-photo", { isShow: true, status: "上架", price: 0, cover: "https://test.invalid/a.jpg", tags: ["清新"], photoCount: 3, retouchCount: 0, shootingNotes: "拍摄须知" });
  assert.equal(published.status, 200, JSON.stringify(published.body)); assert.equal(published.body.effectiveVisible, true); assert.equal(published.body.makeupIncluded, false);
  assert.equal((await f.request("spots", "", { id: "invalid-spot", name: "不完整", isShow: true }, "POST")).status, 400);
  const video = { id: "valid-video", name: "短片", type: "video", productKind: "video_single", isShow: true, price: 1, tags: ["电影感"], videoUrl: "https://test.invalid/video.mp4", shootingNotes: "拍摄说明", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "2–5个工作日" };
  assert.equal((await f.request("packages", "", { ...video, deliveryCycle: "" }, "POST")).status, 400);
  assert.equal((await f.request("packages", "", video, "POST")).status, 201);
});

test("linked photo and video styles cannot replace their required product tags", async (t) => {
  const f = await fixture(t);
  f.rows.series.push(
    { _id: "linked-style", name: "渔人码头" },
    { id: "deleted-style", name: "已删除风格", deleted: true },
    { id: "removed-style", name: "已移除风格", isDeleted: true }
  );
  const products = [
    ["albums", { name: "照片留影", price: 10, cover: "https://test.invalid/photo.jpg", shootingNotes: "拍摄说明", photoCount: 3, retouchCount: 0 }],
    ["packages", { name: "视频摄像", type: "video", productKind: "video_single", price: 10, videoUrl: "https://test.invalid/video.mp4", shootingNotes: "拍摄说明", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "2个工作日" }]
  ];
  for (const [key, fields] of products) {
    const product = { ...fields, id: `${key}-linked`, isShow: true, tags: [], seriesId: "linked-style", spotId: "" };
    const created = await f.request(key, "", product, "POST");
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.match(created.body.error, /请至少添加一个标签/);
    assert.equal(await f.source.get(key, product.id), null);

    for (const seriesId of ["", "missing-style", "deleted-style", "removed-style"]) {
      const id = `${key}-invalid-${seriesId || "empty"}`;
      const rejected = await f.request(key, "", { ...product, id, seriesId }, "POST");
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.match(rejected.body.error, /请至少添加一个标签/);
      assert.equal(await f.source.get(key, id), null);
    }
    const tagged = await f.request(key, "", { ...product, id: `${key}-tagged`, seriesId: "", tags: ["清新"] }, "POST");
    assert.equal(tagged.status, 201, JSON.stringify(tagged.body));
  }
});

test("video products publish and play without a cover; an image alone cannot replace the video", async (t) => {
  const f = await fixture(t);
  const fields = { name: "无首图视频", type: "video", productKind: "video_single", isShow: true, price: 99,
    tags: ["电影感"], shootingNotes: "拍摄须知", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "2个工作日" };
  for (const media of [{ cover: "https://test.invalid/cover.jpg" }, { videoUrl: "https://test.invalid/cover.jpg" },
    { videos: [{ url: "https://test.invalid/image.jpg", type: "image" }] }]) {
    const rejected = await f.request("packages", "", { ...fields, ...media }, "POST");
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, /上传商品视频/);
  }
  for (const media of [{ videoUrl: "https://test.invalid/main.mp4" }, { previewVideoUrl: "https://test.invalid/preview.mp4" },
    { videos: [{ url: "https://test.invalid/legacy.mp4", type: "video" }] }]) {
    const id = `coverless-video-${f.rows.packages.length}`;
    const created = await f.request("packages", "", { ...fields, ...media, id }, "POST");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const expected = media.videoUrl || media.previewVideoUrl || media.videos[0].url;
    const home = await rpc(f.source, "getHomeData", {});
    const listing = await rpc(f.source, "getVideoSingles", {});
    for (const rows of [home.data.videoSingles, listing.data]) {
      const card = rows.find((row) => row.id === id);
      assert.equal(card.videoUrl, expected); assert.equal(card.cover, "");
    }
    assert.equal((await f.request("packages", id, { videoUrl: "", previewVideoUrl: "", videos: [] })).status, 400);
    assert.equal((await f.request("packages", id, { isShow: false, videoUrl: "", previewVideoUrl: "", videos: [] })).status, 200);
    assert.equal((await f.request("packages", id, { isShow: true })).status, 400);
  }
  assert.equal((await f.request("packages", "video-b", { price: 22 })).status, 200, "历史无视频记录仍可修改无关字段");
  assert.equal((await f.request("packages", "video-b", { name: "旧视频改名", videoUrl: "", previewVideoUrl: "", videos: [] })).status, 200,
    "旧记录的完整编辑表单补充空视频字段，仍可修改无关字段");
});

test("legacy series-derived point survives unrelated edits; optional explicit empty binding retains its style", async (t) => {
  const f = await fixture(t);
  f.rows.series.push({ id: "style", name: "老风格", spotIds: ["a"] });
  f.rows.albums[0].seriesId = "style"; delete f.rows.albums[0].spotId;
  assert.equal((await f.request("albums", "photo-a", { price: 88 })).status, 200);
  assert.equal(f.rows.albums[0].seriesId, "style");
  await f.request("spots", "a", { isShow: false });
  assert.equal((await f.request("albums", "photo-a")).body.effectiveVisible, false);
  await f.request("albums", "photo-a", { spotId: "" });
  assert.equal(f.rows.albums[0].seriesId, "style");
  assert.equal((await f.request("albums", "photo-a")).body.effectiveVisible, true);
});

test("failed point unlink or audit compensates every content mutation", async (t) => {
  const f = await fixture(t);
  await f.request("spots", "a", { isShow: false });
  const before = structuredClone(f.rows);
  f.setFailure((method, key) => method === "update" && key === "packages");
  assert.equal((await f.request("spots", "a", undefined, "DELETE")).status, 503);
  assert.deepEqual(f.rows, before);
  f.setFailure((method, key) => method === "create" && key === "logs");
  assert.equal((await f.request("albums", "", { id: "bad", name: "回滚", price: 1, tags: ["回滚标签"], styles: ["不能留存"] }, "POST")).status, 503);
  assert.equal(await f.source.get("albums", "bad"), null);
  assert.ok(!f.rows.tagLibrary.some((tag) => tag.name === "不能留存"));
});

test("quantity, visibility blockers and new product fields survive normalized SQL round-trip", () => {
  const roundtrip = (key, row) => {
    const split = schema.splitDocument(key, row);
    return schema.hydrateDocument(key, { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  };
  const bundle = roundtrip("packages", { id: "bundle", name: "套餐", deletedSpotIds: ["old-point"], includedItems: [{ type: "album", productId: "photo", albumId: "photo", quantity: 3, qty: 3, unitPrice: 10.1, price: 10.1, target: { page: "photoCollection", albumId: "photo" } }] });
  assert.equal(bundle.includedItems[0].quantity, 3); assert.equal(bundle.items[0].qty, 3); assert.deepEqual(bundle.deletedSpotIds, ["old-point"]);
  const peripheral = roundtrip("peripherals", { id: "item", retouchIncluded: true, editingIncluded: false, videos: ["https://test.invalid/a.mp4"], spotBindingExplicit: true, spotId: "", spotIds: [] });
  assert.equal(peripheral.retouchIncluded, true); assert.equal(peripheral.editingIncluded, false);
  assert.equal(peripheral.spotBindingExplicit, true); assert.deepEqual(peripheral.videos, ["https://test.invalid/a.mp4"]);
  const photo = roundtrip("albums", { id: "photo", photoCount: 6, retouchMode: "count", retouchCount: 9, makeupIncluded: true, sampleUrls: ["https://test.invalid/a.jpg"], spotBindingExplicit: true });
  assert.equal(photo.retouchMode, "count"); assert.equal(photo.photoCount, 6);
  assert.equal(photo.retouchCount, 9); assert.equal(photo.makeupIncluded, true);
  assert.deepEqual(photo.sampleUrls, ["https://test.invalid/a.jpg"]); assert.equal(photo.spotBindingExplicit, true);
  const photoColumns = schema.splitDocument("albums", photo);
  assert.equal(photoColumns.columns.retouchMode, "count"); assert.equal(photoColumns.columns.retouchCount, 9);
  assert.equal(photoColumns.columns.makeupIncluded, true);
  assert.ok(!photoColumns.attributes.some((attribute) => ["retouchMode", "retouchCount", "makeupIncluded"].includes(attribute.path)));
  const home = roundtrip("homeConfig", { id: "homeStats", editorConfig: { activity: "城市轮播", banners: [{ id: "city-hero", url: "https://test.invalid/banner.jpg", cityId: "city-a", cityIds: ["city-a", "city-b"] }], homeBanners: [{ id: "city-home", url: "https://test.invalid/home.jpg", cityId: "city-b" }], exploreBanners: [{ id: "city-explore", url: "https://test.invalid/explore.jpg", cityIds: ["city-c"] }] } });
  assert.equal(home.banners[0].cityId, "city-a"); assert.deepEqual(home.banners[0].cityIds, ["city-a", "city-b"]);
  assert.equal(home.homeBanners[0].cityId, "city-b"); assert.deepEqual(home.exploreBanners[0].cityIds, ["city-c"]);
  assert.equal(home.editorConfig.banners[0].cityId, "city-a");
});

test("custom photo service copy survives SQL persistence and every public album projection independently of preview counts", async (t) => {
  const f = await fixture(t);
  const copy = { photoCountText: "底片全送，交付9张", retouchText: "像素蛋糕 / AI精修3张 / PS精修9张", makeupText: "自带妆造，含服装搭配" };
  const beforeOrders = structuredClone(f.rows.orders);
  const created = await f.request("albums", "", { id: "custom-service-copy", name: "自定义照片服务", tags: ["旅拍"],
    spotId: "a", sampleUrls: ["https://test.invalid/preview.jpg"], price: 198, shootingNotes: "请提前预约。",
    retouchMode: "count", retouchCount: 0, makeupIncluded: false,
    ...Object.fromEntries(Object.entries(copy).map(([field, value]) => [field, `  ${value}  `])),
    isShow: true, status: "上架" }, "POST");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.photoCount, 1, "numeric count remains compatible with preview uploads");
  assert.equal(created.body.price, 198);
  assert.equal(created.body.retouchCount, 0, "custom retouch copy does not require an unused legacy numeric count");
  assert.equal(created.body.makeupIncluded, false);
  for (const [field, value] of Object.entries(copy)) assert.equal(created.body[field], value, field);

  const split = schema.splitDocument("albums", await f.source.get("albums", "custom-service-copy"));
  for (const field of Object.keys(copy)) {
    assert.ok(split.attributes.some((attribute) => attribute.path === field && attribute.value_text === copy[field]), `${field} uses the existing typed extension table`);
    assert.equal(split.columns[field], undefined, "custom copy needs no physical schema migration");
  }
  const hydrated = schema.hydrateDocument("albums", { id: split.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  await f.source.replace("albums", "custom-service-copy", hydrated);
  const home = await rpc(f.source, "getHomeData", {});
  const spot = await rpc(f.source, "getHomeData", { spotProductsOnly: true, spotId: "a" });
  const booking = await rpc(f.source, "getBookingData", {});
  const detail = await rpc(f.source, "getPhotoCollection", { albumId: "custom-service-copy" });
  for (const response of [home, spot, booking, detail]) assert.equal(response.success, true, JSON.stringify(response));
  const publicRows = [home.data.albums, spot.data.spotProducts.albums, booking.data.albums, detail.data.collections];
  for (const rows of publicRows) {
    const product = rows.find((row) => row.id === "custom-service-copy" || row._id === "custom-service-copy");
    assert.ok(product);
    for (const [field, value] of Object.entries(copy)) assert.equal(product[field], value, field);
    assert.equal(product.price, 198);
  }

  const edited = await f.request("albums", "custom-service-copy", { sampleUrls: ["https://test.invalid/preview.jpg", "https://test.invalid/preview2.jpg"] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.photoCount, 2);
  for (const [field, value] of Object.entries(copy)) assert.equal(edited.body[field], value, "upload changes preserve custom service copy");
  assert.deepEqual(f.rows.orders, beforeOrders, "service copy never changes historical order terms");
});

test("custom photo service copy rejects nontext and long values atomically and supports explicit clearing", async (t) => {
  const f = await fixture(t);
  for (const field of ["photoCountText", "retouchText", "makeupText"]) {
    for (const invalid of [3, false, {}, [], "字".repeat(161)]) {
      const before = structuredClone(f.rows);
      const response = await f.request("albums", "photo-a", { [field]: invalid });
      assert.equal(response.status, 400, JSON.stringify({ field, invalid, response }));
      assert.deepEqual(f.rows, before, "invalid copy must not persist content or audit records");
    }
    const maximum = await f.request("albums", "photo-a", { [field]: "字".repeat(160) });
    assert.equal(maximum.status, 200, JSON.stringify(maximum.body));
    assert.equal(maximum.body[field].length, 160);
    const unrelated = await f.request("albums", "photo-a", { price: 100.1 });
    assert.equal(unrelated.body[field], maximum.body[field], "omitted text retains its saved value");
    for (const empty of ["  ", null]) {
      const cleared = await f.request("albums", "photo-a", { [field]: empty });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(cleared.body[field], "");
    }
  }
  const detail = await rpc(f.source, "getPhotoCollection", { albumId: "photo-a" });
  assert.equal(detail.success, true, JSON.stringify(detail));
  for (const field of ["photoCountText", "retouchText", "makeupText"]) assert.equal(detail.data.collections[0][field], "");
  assert.equal(detail.data.collections[0].retouchCount, 9, "clearing custom copy preserves legacy service facts");
});

test("photo product fields persist, reuse custom style tags, and hide from the mini-program", async (t) => {
  const f = await fixture(t);
  f.rows.series.push({ id: "style", name: "复古胶片系列", spotIds: ["a"] });
  f.rows.spots[0].isShow = false;
  const created = await f.request("albums", "", { id: "photo-new", name: "春日花园照片单品", seriesId: "style",
    photoCount: 6, price: 699, retouchMode: "included", makeupIncluded: true, tags: ["春日清新", "胶片质感"],
    shootingNotes: "拍摄前请与客服确认服装。", cover: "https://test.invalid/cover.jpg", sampleUrls: ["https://test.invalid/detail.jpg"],
    isShow: true, status: "上架" }, "POST");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.spotId, ""); assert.deepEqual(created.body.spotIds, []);
  assert.equal(created.body.spotBindingExplicit, true, "默认不关联，风格系列不隐式绑定点位");
  assert.equal(created.body.effectiveVisible, true); assert.equal(created.body.photoCount, 2);
  assert.equal(created.body.retouchMode, "included"); assert.equal(created.body.retouchCount, 0);
  const tagsBefore = f.rows.tagLibrary.length;
  assert.equal((await f.request("albums", "photo-new", { tags: ["春日清新"], retouchMode: "count", retouchCount: 3, makeupIncluded: false })).status, 200);
  assert.equal(f.rows.tagLibrary.length, tagsBefore, "同名风格标签复用，不重复创建");
  const shown = await rpc(f.source, "getPhotoCollection", { albumId: "photo-new" });
  assert.equal(shown.success, true, JSON.stringify(shown));
  const product = shown.data.collections[0];
  assert.equal(product.photoCount, 2); assert.equal(product.retouchCount, 3);
  assert.equal(product.retouchMode, "count"); assert.equal(product.makeupIncluded, false);
  assert.equal(product.price, 699); assert.equal(product.shootingNotes, "拍摄前请与客服确认服装。");
  assert.equal(product.seriesName, "复古胶片系列", "不关联点位的商品仍显示选择的风格系列名称");
  assert.deepEqual(product.tags, ["春日清新"]); assert.equal(product.spotId, "");
  assert.deepEqual(product.sampleUrls, ["https://test.invalid/cover.jpg", "https://test.invalid/detail.jpg"]);
  for (const invalid of [{ photoCount: 0 }, { photoCount: 1.5 }, { retouchMode: "invalid" }, { retouchMode: "count", retouchCount: 0 }, { retouchCount: -1 }, { makeupIncluded: "false" }, { cover: "" }]) {
    assert.equal((await f.request("albums", "photo-new", invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await f.request("albums", "photo-new", { retouchMode: "excluded", retouchCount: 9 })).status, 200);
  assert.equal((await f.source.get("albums", "photo-new")).retouchCount, 0);
  assert.equal((await f.request("albums", "photo-new", { isShow: false })).status, 200);
  assert.equal((await rpc(f.source, "getPhotoCollection", { albumId: "photo-new" })).success, false);
  assert.ok(!(await rpc(f.source, "getHomeData", {})).data.albums.some((album) => album.id === "photo-new"));
});

test("photo creation counts uploaded images, accepts a reusable custom series, and stays hidden and unlinked by default", async (t) => {
  const f = await fixture(t);
  const photos = Array.from({ length: 9 }, (_, index) => `https://test.invalid/product-${index + 1}.jpg`);
  const created = await f.request("albums", "", {
    id: "custom-photo", name: "汉服留影", seriesId: "", seriesName: "  古风汉服  ", tags: ["主推", "新品"],
    sampleUrls: [...photos, photos[0]], cover: photos[5], photoCount: 100,
    price: 199, retouchMode: "count", retouchCount: 3, makeupIncluded: true, shootingNotes: "按预约时间到店。",
  }, "POST");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.photoCount, 9, "上传照片去重后自动统计，忽略手工填写的数量");
  assert.deepEqual(created.body.sampleUrls, photos);
  assert.equal(created.body.cover, photos[5]);
  assert.equal(created.body.seriesName, "古风汉服");
  assert.equal(created.body.seriesId, "");
  assert.equal(created.body.isShow, false);
  assert.equal(created.body.effectiveVisible, false);
  assert.equal(created.body.spotId, "");
  assert.deepEqual(created.body.spotIds, []);
  assert.equal(created.body.spotBindingExplicit, true);
  assert.ok(!(await rpc(f.source, "getHomeData", {})).data.albums.some((album) => album.id === "custom-photo"));

  // A custom series stays independent of the separately required product tags.
  const published = await f.request("albums", "custom-photo", { isShow: true, status: "上架" });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const shown = await rpc(f.source, "getPhotoCollection", { albumId: "custom-photo" });
  assert.equal(shown.success, true, JSON.stringify(shown));
  assert.equal(shown.data.collections[0].seriesName, "古风汉服");
  assert.equal(shown.data.collections[0].photoCount, 9);
  assert.equal(shown.data.collections[0].cover, photos[5]);
  const second = await f.request("albums", "", { id: "custom-photo-2", name: "汉服留影二", tags: ["汉服"], seriesId: "", seriesName: created.body.seriesName }, "POST");
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.seriesName, "古风汉服");
  assert.equal(f.rows.series.length, 0, "自定义系列保存在商品上，无需创建独立风格或关联点位");
});

test("photo gallery edits recount images, replace deleted covers, and never restore removed photos", async (t) => {
  const f = await fixture(t);
  const photos = Array.from({ length: 9 }, (_, index) => `https://test.invalid/photo-${index}.jpg`);
  const created = await f.request("albums", "", { id: "gallery-photo", name: "相册", tags: ["照片"], sampleUrls: photos, cover: photos[0] }, "POST");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const remaining = photos.slice(2);
  const deleted = await f.request("albums", "gallery-photo", { sampleUrls: remaining });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.photoCount, 7);
  assert.equal(deleted.body.cover, remaining[0]);
  for (const alias of ["coverImage", "coverUrl", "image"]) assert.equal(deleted.body[alias], remaining[0]);
  assert.deepEqual(deleted.body.sampleUrls, remaining, "删除首图时旧封面不会被追加回来");
  const cleared = await f.request("albums", "gallery-photo", { sampleUrls: [], cover: remaining[0] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.photoCount, 0);
  for (const alias of ["cover", "coverImage", "coverUrl", "image"]) assert.equal(cleared.body[alias], "");
  assert.deepEqual(cleared.body.sampleUrls, []);
  const rejected = await f.request("albums", "gallery-photo", { isShow: true, status: "上架" });
  assert.equal(rejected.status, 400, "没有照片的草稿不能显示在小程序");
  const legacy = await f.request("albums", "photo-a", { price: 300 });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.photoCount, 9, "旧版无图片列表的商品修改无关字段仍保留原张数");
});

test("photo custom series names are bounded, clearable, and replaced by selected existing styles", async (t) => {
  const f = await fixture(t);
  f.rows.series.push({ id: "existing-style", name: "清新夏日", spotId: "a" });
  const created = await f.request("albums", "", { id: "named-photo", name: "自定义系列", tags: ["古风"], seriesId: "", seriesName: "古风汉服" }, "POST");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const seriesName of ["字".repeat(161), { name: "错误类型" }]) {
    const rejected = await f.request("albums", "named-photo", { seriesName });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  }
  assert.equal((await f.request("albums", "named-photo", { price: 99 })).body.seriesName, "古风汉服");
  const existing = await f.request("albums", "named-photo", { seriesId: "existing-style", seriesName: "过期名称" });
  assert.equal(existing.status, 200, JSON.stringify(existing.body));
  assert.equal(existing.body.seriesName, "清新夏日");
  assert.equal(existing.body.spotId, "");
  assert.equal(existing.body.spotBindingExplicit, true);
  const cleared = await f.request("albums", "named-photo", { seriesId: "" });
  assert.equal(cleared.body.seriesName, "");
});

test("package titles accept27 characters, reject overlong drafts and normalize whitespace to one line", async (t) => {
  const f = await fixture(t);
  const base = { type: "photo", productKind: "package", isShow: false, status: "草稿", tags: ["组合"], price: 10,
    includedItems: [{ type: "album", albumId: "photo-a", quantity: 1 }] };
  for (const name of ["旅".repeat(28), "A".repeat(28), "😀".repeat(14), { title: "非法" }]) {
    const rejected = await f.request("packages", "", { ...base, name }, "POST");
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, /套餐名称/);
  }
  for (const name of ["旅".repeat(21) + "ABC123", "旅".repeat(25) + "😀"]) {
    assert.equal(name.length, 27);
    const created = await f.request("packages", "", { ...base, name }, "POST");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.name, name);
  }
  const singleLine = await f.request("packages", "", { ...base, name: "  城市\n  旅拍\t套餐  " }, "POST");
  assert.equal(singleLine.status, 201, JSON.stringify(singleLine.body));
  assert.equal(singleLine.body.name, "城市 旅拍 套餐");
  const video = await f.request("packages", "video-b", { name: "视频".repeat(25) });
  assert.equal(video.status, 200, JSON.stringify(video.body));
  assert.equal(video.body.name.length, 50);
  const titleOnly = await f.request("packages", "", { ...base, title: "旅".repeat(28) }, "POST");
  assert.equal(titleOnly.status, 400, JSON.stringify(titleOnly.body));
  const titleAlias = await f.request("packages", "", { ...base, title: "  城市\n  旅拍套餐  " }, "POST");
  assert.equal(titleAlias.status, 201, JSON.stringify(titleAlias.body));
  assert.equal(titleAlias.body.name, "城市 旅拍套餐");
  assert.equal(titleAlias.body.title, "城市 旅拍套餐");
  const aliasUpdate = await f.request("packages", titleAlias.body.id, { title: "旅".repeat(28) });
  assert.equal(aliasUpdate.status, 400, JSON.stringify(aliasUpdate.body));
});

test("legacy long package titles keep price and withdrawal operations but need shortening before renaming or republication", async (t) => {
  const f = await fixture(t);
  const bundle = f.rows.packages.find((row) => row.id === "bundle");
  const longName = "旅".repeat(40);
  bundle.name = longName;
  const price = await f.request("packages", "bundle", { price: 99 });
  assert.equal(price.status, 200, JSON.stringify(price.body));
  assert.equal(price.body.name, longName);
  assert.equal((await f.request("packages", "bundle", { name: longName, price: 98 })).status, 200);
  const renamed = await f.request("packages", "bundle", { name: "新".repeat(28) });
  assert.equal(renamed.status, 400);
  assert.equal(bundle.name, longName);
  assert.equal((await f.request("packages", "bundle", { isShow: false, status: "下架" })).status, 200);
  const republished = await f.request("packages", "bundle", { isShow: true, status: "上架" });
  assert.equal(republished.status, 400, JSON.stringify(republished.body));
  assert.match(republished.body.error, /最多 27 个字符/);
  assert.equal(bundle.isShow, false);
  const shortened = await f.request("packages", "bundle", { name: "城市旅拍组合套餐", isShow: true, status: "上架" });
  assert.equal(shortened.status, 200, JSON.stringify(shortened.body));
  assert.equal(shortened.body.name, "城市旅拍组合套餐");
  assert.equal(f.rows.orders[0].packageSnapshot.name, "两地点套餐", "历史订单快照不受标题编辑影响");
});
