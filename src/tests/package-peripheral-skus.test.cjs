"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contentPolicy = require("../../server/lib/contentPolicy.cjs");

const root = path.resolve(__dirname, "../..");
const copy = value => JSON.parse(JSON.stringify(value));
const frame = {
  id: "frame", name: "相框摆台", specMode: "multiple", price: 25,
  stock: 30, shippingFee: 0, isShow: true,
  skus: [
    { skuCode: "FRAME-S", spec: "6寸", style: "横版", price: 25, stock: 10 },
    { skuCode: "FRAME-L", spec: "8寸", style: "竖版", price: 39.9, stock: 10 },
    { skuCode: "FRAME-L-WIDE", spec: "8寸", style: "横版", price: 42.5, stock: 10 }
  ]
};

// Run the actual page setup and persistence actions against isolated memory.
// These checks never access a database, real account, or production API.
function fixture(peripherals = [frame], packages = []) {
  const writes = [], messages = [];
  const computed = definition => typeof definition === "function"
    ? { get value() { return definition(); } }
    : { get value() { return definition.get(); }, set value(value) { definition.set(value); } };
  const Vue = { ref: value => ({ value }), reactive: value => value, computed, watch() {}, unref: value => value?.value ?? value };
  const notify = message => messages.push(message);
  Object.assign(notify, { warning: notify, error: notify, success: notify });
  const ctx = {
    data: { peripherals: copy(peripherals), packages: copy(packages), albums: [], spots: [], cities: [] },
    state: { filters: {} }, can: () => true, money: value => `¥${Number(value).toFixed(2)}`,
    normalizePackageTitle: value => String(value || "").trim(), packageTitleError: () => "",
    packageTitleLimit: 27, packageTitleLength: value => String(value || "").length,
    async persistContentMutation(collection, payload, previous) {
      writes.push({ collection, payload: copy(payload), previous: previous ? copy(previous) : null });
      return true;
    }
  };
  const window = { Vue, ElMessage: notify, LXM_UPLOAD: { ready: () => true, busy: () => false },
    LXM_PAGES: { register(page) { window.page = page; } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/views/content/package/package.js"), "utf8"), { window, console });
  const page = window.page.setup(ctx);
  const options = () => page.peripheralOptions.value;
  const option = (spec, style) => options().find(row => row.id === "frame" && row.spec === spec && row.style === style);
  function create() {
    page.openCreate();
    Object.assign(page.form.value, { name: "多规格周边套餐", tagText: "纪念" });
  }
  function add(...rows) {
    assert.ok(rows.length && rows.every(Boolean), "the requested SKU must appear in the picker");
    page.picker.peripheralIds = rows.map(row => row.key);
    return page.addPeripheralProducts();
  }
  return { page, ctx, writes, messages, options, option, create, add };
}

test("套餐周边选择器列出每个规格的样式和实际价格，单规格仍可按商品选择", () => {
  const f = fixture([frame, { id: "book", name: "照片书", specMode: "single", specs: ["12页"], price: 19.9, stock: 5, isShow: true }]);
  const options = Array.from(f.options());
  assert.equal(options.length, 4);
  assert.equal(new Set(options.map(row => row.key)).size, 4, "same product ID must not collapse its SKU options");
  for (const sku of frame.skus) {
    const option = f.option(sku.spec, sku.style);
    assert.ok(option);
    assert.equal(option.price, sku.price);
    assert.ok(option.label.includes("相框摆台"));
    assert.ok(option.label.includes(sku.spec));
    assert.ok(option.label.includes(sku.style));
  }
  assert.equal(options.find(row => row.id === "book").key, "book");
});

test("一次加入同商品不同规格，各自累计数量和金额并保留自定义套餐售价", () => {
  const f = fixture(); f.create();
  assert.equal(f.add(f.option("6寸", "横版"), f.option("8寸", "竖版")), true);
  const rows = f.page.form.value.includedItems;
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => [row.productId, row.spec, row.style, row.quantity, row.price]), [
    ["frame", "6寸", "横版", 1, 25], ["frame", "8寸", "竖版", 1, 39.9]
  ]);
  assert.equal(f.page.form.value.originalPrice, 64.9);
  assert.equal(f.page.form.value.price, 64.9);
  assert.deepEqual(Array.from(f.page.picker.peripheralIds), []);
  f.page.form.value.price = 60; f.page.setManualPrice();
  assert.equal(f.add(f.option("8寸", "竖版"), f.option("8寸", "横版")), true);
  assert.equal(rows.length, 3);
  assert.deepEqual(Array.from(rows, row => row.quantity), [1, 2, 1]);
  assert.equal(f.page.selectedQuantity.value, 4);
  assert.equal(f.page.form.value.originalPrice, 147.3);
  assert.equal(f.page.form.value.price, 60);
});

test("保存与重开套餐保留具体规格和样式、SKU编码和各规格单价", async () => {
  const f = fixture(); f.create();
  f.add(f.option("8寸", "竖版"), f.option("8寸", "横版"));
  f.page.form.value.price = 75; f.page.setManualPrice();
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  assert.equal(f.writes.length, 1);
  const saved = f.ctx.data.packages[0];
  assert.equal(saved.price, 75);
  assert.equal(saved.originalPrice, 82.4);
  assert.equal(saved.includedItems.length, 2);
  assert.deepEqual(copy(saved.items), copy(saved.includedItems));
  for (const [index, sku] of frame.skus.slice(1).entries()) {
    const row = saved.includedItems[index];
    assert.equal(row.name, "相框摆台", "the product name remains usable as a catalog reference");
    assert.equal(row.spec, sku.spec);
    assert.equal(row.style, sku.style);
    assert.equal(row.skuCode, sku.skuCode);
    assert.equal(row.price, sku.price);
    assert.equal(row.target.peripheralId, "frame");
    assert.equal(row.target.spec, sku.spec);
    assert.equal(row.target.style, sku.style);
  }
  f.ctx.data.peripherals[0].skus.reverse();
  f.page.openEdit(saved);
  assert.deepEqual(Array.from(f.page.form.value.includedItems, row => [row.spec, row.style, row.price]), [
    ["8寸", "竖版", 39.9], ["8寸", "横版", 42.5]
  ], "reordering source SKUs must not change what the package contains");
  assert.equal(f.page.form.value.price, 75);
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  assert.equal(f.writes.at(-1).previous.includedItems[0].style, "竖版");
});

test("未设置SKU编码时，同名规格的不同样式仍可同时保存和回显", async () => {
  const raw = copy(frame);
  raw.skus = [
    { spec: "8寸", style: "可横可竖", price: 35.6, stock: 5 },
    { spec: "8寸", style: "两宫格", price: 45.6, stock: 5 }
  ];
  const f = fixture([raw]); f.create();
  f.add(f.option("8寸", "可横可竖"), f.option("8寸", "两宫格"));
  f.add(f.option("8寸", "两宫格"));
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  const saved = f.writes[0].payload;
  assert.equal(saved.originalPrice, 126.8);
  assert.deepEqual(saved.includedItems.map(row => [row.spec, row.style, row.quantity]), [
    ["8寸", "可横可竖", 1], ["8寸", "两宫格", 2]
  ]);
  f.page.openEdit(saved);
  assert.deepEqual(Array.from(f.page.form.value.includedItems, row => [row.spec, row.style, row.quantity]), [
    ["8寸", "可横可竖", 1], ["8寸", "两宫格", 2]
  ]);
  assert.match(f.page.itemDetails(saved), /可横可竖/);
  assert.match(f.page.itemDetails(saved), /两宫格/);
});

test("历史多规格套餐缺少规格时阻止保存，移除后可明确选择规格修复", async () => {
  const legacy = { id: "legacy", name: "历史套餐", type: "photo", tags: ["纪念"], isShow: true, price: 25,
    includedItems: [{ type: "peripheral", productId: "frame", name: "相框摆台", price: 25, quantity: 1, target: { peripheralId: "frame" } }] };
  const f = fixture([frame], [legacy]);
  f.page.openEdit(f.ctx.data.packages[0]);
  const draft = f.page.form.value;
  assert.ok(!draft.includedItems[0].spec, "opening legacy data must not silently choose the first SKU");
  assert.notEqual(await f.page.saveForm(), true);
  assert.equal(f.writes.length, 0);
  assert.match(f.messages.at(-1), /规格|不可用/);
  assert.equal(f.page.dialogVisible.value, true);
  assert.equal(f.ctx.data.packages[0].includedItems[0].spec, undefined);
  f.page.removeIncludedItem(0);
  f.add(f.option("8寸", "竖版"));
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  assert.equal(f.writes[0].payload.includedItems[0].style, "竖版");
  assert.equal(f.writes[0].payload.includedItems[0].price, 39.9);
});

test("已删除规格和陈旧勾选均不能被悄悄替换成同商品的其他规格", async () => {
  const f = fixture(); f.create();
  const removed = f.option("8寸", "横版");
  f.add(removed);
  f.ctx.data.peripherals[0].skus.pop();
  assert.notEqual(await f.page.saveForm(), true);
  assert.equal(f.writes.length, 0);
  assert.equal(f.page.form.value.includedItems[0].style, "横版");
  assert.match(f.messages.at(-1), /规格|不可用|重新选择/);
  f.page.picker.peripheralIds = [removed.key];
  assert.notEqual(f.page.addPeripheralProducts(), true);
  assert.equal(f.page.form.value.includedItems.length, 1);
  assert.equal(f.page.form.value.includedItems[0].quantity, 1);
});

test("历史 target 中指定的SKU和单规格旧商品保持兼容", async () => {
  const raw = copy(frame); raw.skus[1].id = "sku-large";
  const legacy = { id: "legacy", name: "有规格的历史套餐", type: "photo", tags: ["纪念"], price: 44.9, isShow: true,
    includedItems: [
      { type: "peripheral", productId: "frame", quantity: 1, target: { peripheralId: "frame", skuId: "sku-large" } },
      { type: "peripheral", productId: "book", quantity: 1, target: { peripheralId: "book" } }
    ] };
  const f = fixture([raw, { id: "book", name: "照片书", price: 5, isShow: true }], [legacy]);
  f.page.openEdit(f.ctx.data.packages[0]);
  assert.deepEqual(Array.from(f.page.form.value.includedItems, row => [row.productId, row.price]), [["frame", 39.9], ["book", 5]]);
  assert.equal(f.page.form.value.includedItems[0].spec, "8寸");
  assert.equal(f.page.form.value.includedItems[0].style, "竖版");
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  const rows = f.writes[0].payload.includedItems;
  assert.equal(rows[0].skuId, "sku-large");
  assert.equal(rows[0].target.skuId, "sku-large");
  assert.equal(rows[1].target.peripheralId, "book");
});

test("原规格同时包含id和skuId时，历史skuId引用仍能回显正确规格", async () => {
  const raw = copy(frame);
  Object.assign(raw.skus[1], { id: "catalog-large", skuId: "legacy-large" });
  const legacy = { id: "legacy", name: "历史SKU别名套餐", type: "photo", tags: ["纪念"], price: 39.9, isShow: true,
    includedItems: [{ type: "peripheral", productId: "frame", quantity: 1, target: { peripheralId: "frame", skuId: "legacy-large" } }] };
  const f = fixture([raw], [legacy]);
  f.page.openEdit(f.ctx.data.packages[0]);
  const row = f.page.form.value.includedItems[0];
  assert.equal(row.spec, "8寸");
  assert.equal(row.style, "竖版");
  assert.equal(row.price, 39.9);
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  assert.equal(f.writes[0].payload.includedItems[0].spec, "8寸");
});

test("未编码的多规格商品切换为单规格后，原套餐不能默选不同的默认规格", async () => {
  const raw = copy(frame);
  raw.skus = [{ spec: "8寸", style: "两宫格", price: 45.6, stock: 5 }];
  const f = fixture([raw]); f.create();
  f.add(f.option("8寸", "两宫格"));
  Object.assign(f.ctx.data.peripherals[0], { specMode: "single", specs: ["6寸"], skuStyle: "横版", skus: [], price: 25 });
  assert.notEqual(await f.page.saveForm(), true);
  assert.equal(f.writes.length, 0);
  assert.match(f.messages.at(-1), /规格|重新选择/);
  assert.equal(f.page.form.value.includedItems[0].spec, "8寸");
  assert.equal(f.page.form.value.includedItems[0].style, "两宫格");
});

test("真实服务端规范化回传后，无规格单品和带编码多规格套餐可再次编辑保存", async () => {
  const f = fixture([frame, { id: "book", name: "照片书", specMode: "single", price: 5, stock: 10, shippingFee: 0, isShow: true }]);
  const source = { async list(key) { return copy(f.ctx.data[key] || []); } };
  f.ctx.persistContentMutation = async (collection, payload, previous) => {
    const context = await contentPolicy.createContentContext(source);
    const patch = await contentPolicy.prepareContentPatch(source, collection, copy(payload), copy(previous || {}), context);
    const saved = { ...copy(payload), ...copy(patch) };
    const error = contentPolicy.validateContentPublication(collection, saved, previous, context, payload);
    assert.equal(error, "");
    Object.assign(payload, saved);
    f.writes.push({ collection, payload: copy(saved), previous: previous ? copy(previous) : null });
    return true;
  };
  f.create();
  f.add(f.option("8寸", "竖版"), f.options().find(row => row.id === "book"));
  f.page.form.value.price = 40; f.page.setManualPrice();
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  const saved = f.ctx.data.packages[0];
  assert.equal(saved.includedItems[0].skuId, "FRAME-L", "the server returns a raw selector that the editor can resolve");
  assert.equal(saved.includedItems[1].spec, "默认规格");
  assert.equal(saved.includedItems[1].skuId, "");
  assert.equal(saved.originalPrice, 44.9);
  f.page.openEdit(saved);
  assert.deepEqual(Array.from(f.page.form.value.includedItems, row => [row.productId, row.spec, row.style, row.price]), [
    ["frame", "8寸", "竖版", 39.9], ["book", "默认规格", "", 5]
  ]);
  assert.equal(f.page.form.value.price, 40);
  assert.equal(await f.page.saveForm(), true, f.messages.join("；"));
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[1].payload.includedItems, f.writes[0].payload.includedItems);
  assert.deepEqual(f.writes[1].payload.items, f.writes[1].payload.includedItems);
  assert.equal(f.writes[1].payload.originalPrice, 44.9);
});

test("套餐多规格选择模板可用实际Vue运行时编译", () => {
  const sandbox = { window: {}, console: { info() {}, warn() {}, log() {} }, document: { createElement: () => ({}) } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "public/vendor/vue.global.js"), "utf8"), sandbox);
  const errors = [];
  const render = sandbox.Vue.compile(fs.readFileSync(path.join(root, "src/views/content/package/package.html"), "utf8"), {
    onError: error => errors.push(error.message), decodeEntities: text => text
  });
  assert.deepEqual(errors, []);
  assert.equal(typeof render, "function");
});
