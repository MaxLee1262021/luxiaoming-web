"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(rows = [], options = {}) {
  const messages = [], writes = [];
  const Vue = { ref: (value) => ({ value }), computed: (getter) => ({ get value() { return getter(); } }) };
  // The app exposes messages through ElementPlus and its injected context, not window.ElMessage.
  const ElMessage = (message) => messages.push(message);
  const window = { Vue, ElementPlus: { ElMessage }, LXM_UPLOAD: { ready: () => true }, LXM_PAGES: { register(page) { window.page = page; } } };
  const ctx = {
    ElMessage,
    state: { filters: {}, role: "super", authSource: "server" },
    data: { peripherals: clone(rows) }, can: () => options.readOnly !== true, money: (value) => `¥${value.toFixed(2)}`,
    productStatus: (row) => row.isShow === false ? "下架" : "上架", contentSpotIds: (row) => row.spotIds || [],
    clearContentFilters() { ctx.state.filters = {}; }, isServerConnected: () => options.connected !== false,
    async persistContentMutation(key, payload, previous) {
      writes.push({ key, payload: clone(payload), previous: previous && clone(previous) });
      if (options.saveError) throw new Error(options.saveError);
      return !options.failSave;
    }
  };
  const api = { remoteOn: () => !!options.remote, setRemote() {}, loadCollection: async () => clone(rows) };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/views/content/peripheral/peripheral.js"), "utf8"), { window, LXM_API: api });
  return { page: window.page.setup(ctx), ctx, messages, writes, options };
}

test("单规格销售参数保存成功后才写回列表，兼容库存别名和既有规格说明", async () => {
  const f = fixture([{ id: "frame", name: "相框", specs: ["10寸", "原木"], stockQty: 12, price: 38.5 }]);
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  const draft = f.page.selectedPeripheral.value;
  assert.equal(draft.stock, 12);
  Object.assign(draft, { productCode: " FRAME-001 ", unit: " 套 ", stock: 8, shippingFee: 6, stockWarning: 3 });
  assert.equal(source.stockQty, 12);
  assert.equal(source.productCode, undefined);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(source.stock, 8);
  assert.equal(source.stockQty, 8);
  assert.equal(source.productCode, "FRAME-001");
  assert.equal(source.unit, "套");
  assert.equal(source.shippingFee, 6);
  assert.equal(source.stockWarning, 3);
  assert.deepEqual(Array.from(source.specs), ["10寸", "原木"]);
  assert.equal(f.writes[0].previous.stockQty, 12);
  assert.equal(f.page.editorOpen.value, false);
});

test("旧商品未设置库存时明确提示填写，零库存与缺失库存分别筛选", async () => {
  const f = fixture([{ id: "legacy", name: "旧相册", price: 20 }, { id: "empty", stock: 0 }, { id: "low", stockQty: 2 }, { id: "ready", stock: 20 }]);
  const ids = () => Array.from(f.page.listSource.value, (row) => row.id);
  for (const [key, expected] of [["unset", "legacy"], ["empty", "empty"], ["low", "low"], ["normal", "ready"]]) {
    f.page.stockFilter.value = key;
    assert.deepEqual(ids(), [expected]);
  }
  f.page.selectPeripheral(f.ctx.data.peripherals[0]);
  assert.equal(f.page.selectedPeripheral.value.stock, undefined);
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /请填写库存/);
  assert.equal(f.writes.length, 0);
  f.page.selectedPeripheral.value.stock = 0;
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  f.ctx.state.filters.keyword = "不会命中";
  f.page.clearPeripheralFilters();
  assert.equal(f.page.listSource.value.length, 4);
});

test("旧商品仅隐藏时可保留未知库存和原销售参数，保存成功后再更新列表", async () => {
  const f = fixture([{ id: "diy", name: "创意DIY套装", price: 139, isShow: true }]);
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  Object.assign(f.page.selectedPeripheral.value, { isShow: false, intro: "暂停销售" });
  assert.equal(source.isShow, true);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].previous.isShow, true);
  assert.equal(f.writes[0].payload.isShow, false);
  assert.equal(f.writes[0].payload.status, "下架");
  assert.equal(source.isShow, false);
  assert.equal(source.description, "暂停销售");
  assert.equal(source.price, 139);
  for (const field of ["stock", "stockQty", "specMode", "productCode", "unit", "stockWarning", "skus", "shippingFee"]) {
    assert.equal(Object.hasOwn(source, field), false, `${field} 不应由隐藏操作补入默认值`);
    assert.equal(Object.hasOwn(f.writes[0].payload, field), false, `${field} 不应作为销售参数改动提交`);
  }
  assert.equal(f.page.stockText(source), "未设置");
  assert.equal(f.page.editorOpen.value, false);
  assert.match(f.messages.at(-1), /已保存/);
});

test("隐藏旧商品保留 stockQty 库存别名和既有规格，修改库存后仍正常同步", async () => {
  const f = fixture([{ id: "diy", name: "创意DIY套装", price: 139, stockQty: 6, specs: ["标准套装"], isShow: true }]);
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  f.page.selectedPeripheral.value.isShow = false;
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(source.stockQty, 6);
  assert.equal(Object.hasOwn(source, "stock"), false);
  assert.deepEqual(Array.from(source.specs), ["标准套装"]);
  assert.equal(f.page.stockText(source), "6 件");
  f.page.selectPeripheral(source);
  f.page.selectedPeripheral.value.stock = 3;
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(source.stock, 3);
  assert.equal(source.stockQty, 3);
  assert.equal(f.writes[1].payload.stock, 3);
  assert.equal(f.writes[1].payload.stockQty, 3);
});

test("隐藏已有商品不豁免销售参数改动校验，新建隐藏商品也须填写库存", async () => {
  const f = fixture([{ id: "diy", name: "创意DIY套装", price: 139, isShow: true }]);
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  const draft = f.page.selectedPeripheral.value;
  draft.isShow = false;
  for (const stock of [-1, null, "", 1.5, 2147483648]) {
    draft.stock = stock;
    assert.equal(await f.page.saveSelectedPeripheral(), false);
    assert.match(f.messages.at(-1), /库存/);
  }
  draft.stock = undefined;
  draft.price = 140;
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /库存/);
  assert.equal(source.isShow, true);
  assert.equal(source.price, 139);
  assert.equal(f.writes.length, 0);
  f.page.createPeripheral();
  Object.assign(f.page.selectedPeripheral.value, { name: "新隐藏商品", isShow: false, stock: undefined });
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /库存/);
  assert.equal(f.writes.length, 0);
});

test("隐藏未知库存旧商品失败时保留原显示状态和可重试草稿", async () => {
  const f = fixture([{ id: "diy", name: "创意DIY套装", price: 139, isShow: true }], { failSave: true });
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  const draft = f.page.selectedPeripheral.value;
  draft.isShow = false;
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.equal(f.writes.length, 1);
  assert.equal(source.isShow, true);
  assert.equal(source.stock, undefined);
  assert.equal(f.page.editorOpen.value, true);
  assert.equal(f.page.selectedPeripheral.value, draft);
  assert.equal(draft.isShow, false);
  assert.equal(f.page.saving.value, false);
  f.options.failSave = false;
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(source.isShow, false);
});

test("无法连接及保存异常均有页面提示，并保留商品草稿", async () => {
  const f = fixture([{ id: "diy", name: "创意DIY套装", price: 139, isShow: true }], { connected: false });
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  f.page.selectedPeripheral.value.isShow = false;
  await f.page.saveSelectedPeripheral();
  assert.match(f.messages.at(-1), /真实后端连接不可用/);
  assert.equal(f.writes.length, 0);
  f.options.connected = true;
  f.options.saveError = "网络中断";
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /保存失败.*网络中断/);
  assert.equal(source.isShow, true);
  assert.equal(f.page.editorOpen.value, true);
  assert.equal(f.page.saving.value, false);
});

test("多规格分别维护价格库存，总库存和起售价由规格自动汇总", async () => {
  const f = fixture();
  f.page.createPeripheral();
  const draft = f.page.selectedPeripheral.value;
  Object.assign(draft, { name: "定制相框", specMode: "multiple", price: 999, stock: 999, specs: ["过期说明"] });
  f.page.changeSpecMode("multiple");
  Object.assign(draft.skus[0], { spec: " 10寸 / 原木 ", skuCode: " A ", price: 39.9, stock: 3 });
  f.page.addSku();
  Object.assign(draft.skus[1], { spec: "12寸 / 胡桃", skuCode: "B", price: 59, stock: 5 });
  assert.equal(f.page.stockText(draft), "8 件");
  assert.equal(f.page.priceText(draft), "¥39.90 起");
  assert.equal(f.ctx.data.peripherals.length, 0);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  const saved = f.ctx.data.peripherals[0];
  assert.equal(saved.price, 39.9);
  assert.equal(saved.stock, 8);
  assert.equal(saved.stockQty, 8);
  assert.deepEqual(Array.from(saved.specs), ["10寸 / 原木", "12寸 / 胡桃"]);
  assert.equal(saved.skus[0].skuCode, "A");
});

test("规格切换保留资料且删除规格至少保留一条，单规格保存不残留失效SKU", async () => {
  const f = fixture([{ id: "gift", name: "周边", price: 20, stock: 4, specs: ["10寸", "原木"] }]);
  f.page.selectPeripheral(f.ctx.data.peripherals[0]);
  const draft = f.page.selectedPeripheral.value;
  draft.specMode = "multiple"; f.page.changeSpecMode("multiple");
  assert.equal(draft.skus[0].spec, "10寸 / 原木");
  assert.equal(draft.skus[0].stock, 4);
  f.page.removeSku(0); assert.equal(draft.skus.length, 1);
  f.page.addSku(); Object.assign(draft.skus[1], { spec: "12寸", price: 30, stock: 6 });
  draft.specMode = "single"; f.page.changeSpecMode("single");
  assert.equal(draft.stock, 10);
  assert.equal(draft.price, 20);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.deepEqual(Array.from(f.ctx.data.peripherals[0].skus), []);
  assert.equal(f.ctx.data.peripherals[0].specMode, "single");
});

test("非法库存、重复规格与编码、总库存溢出均阻止写入并保留草稿", async () => {
  const f = fixture();
  f.page.createPeripheral();
  const draft = f.page.selectedPeripheral.value;
  draft.name = "相册";
  for (const stock of [undefined, null, "", "  ", -1, 1.5, Infinity, 2147483648]) {
    draft.stock = stock;
    assert.equal(await f.page.saveSelectedPeripheral(), false);
  }
  draft.specMode = "multiple";
  const base = () => [{ spec: "10寸", skuCode: "A", price: 30, stock: 1 }, { spec: "12寸", skuCode: "B", price: 40, stock: 1 }];
  draft.skus = base(); draft.skus[1].spec = " 10寸 ";
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /规格名称.*重复/);
  draft.skus = base(); draft.skus[1].skuCode = " A ";
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /规格编码.*重复/);
  draft.skus = base(); draft.skus[0].stock = 2147483647;
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /总库存/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.page.editorOpen.value, true);
  assert.equal(f.page.selectedPeripheral.value, draft);
});

test("保存后端失败不污染原商品，取消及还原不保留草稿修改", async () => {
  const f = fixture([{ id: "frame", name: "相框", stock: 5, price: 40, specMode: "multiple", skus: [{ spec: "10寸", price: 40, stock: 5 }] }], { failSave: true });
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  f.page.selectedPeripheral.value.skus[0].stock = 2;
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.equal(source.skus[0].stock, 5);
  assert.equal(f.page.editorOpen.value, true);
  f.page.resetDraft(); assert.equal(f.page.selectedPeripheral.value.skus[0].stock, 5);
  f.page.selectedPeripheral.value.name = "未保存的相框";
  f.page.closeEditor(); assert.equal(source.name, "相框");
  assert.equal(f.page.selectedPeripheral.value, null);
});

test("金额不允许溢出分值范围，文本边界与规格数量也在写入前校验", async () => {
  const f = fixture();
  f.page.createPeripheral();
  const draft = f.page.selectedPeripheral.value;
  Object.assign(draft, { name: "相框", stock: 5 });
  for (const field of ["price", "shippingFee"]) {
    for (const value of [1e307, Number.MAX_SAFE_INTEGER, -1, null, ""]) {
      draft[field] = value;
      assert.equal(await f.page.saveSelectedPeripheral(), false);
    }
    draft[field] = 20;
  }
  draft.productCode = "X".repeat(129);
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  draft.productCode = "X".repeat(128);
  draft.unit = "件".repeat(21);
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  draft.unit = "件";
  draft.specMode = "multiple";
  draft.skus = [{ spec: "10寸", skuCode: "A", stock: 1, price: 1e307 }];
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  draft.skus[0].price = 20;
  draft.skus[0].spec = "寸".repeat(161);
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  draft.skus[0].spec = "10寸";
  draft.skus[0].skuCode = "A".repeat(129);
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  draft.skus = Array.from({ length: 101 }, (_, index) => ({ spec: `规格${index}`, skuCode: "", price: 20, stock: 1 }));
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.equal(f.writes.length, 0);
});

test("只读权限可查看销售参数，不能创建、增删规格或保存", async () => {
  const f = fixture([{ id: "frame", name: "相框", price: 40, stock: 10, specMode: "multiple", skus: [{ spec: "10寸", price: 40, stock: 10 }] }], { readOnly: true });
  f.page.createPeripheral(); assert.equal(f.page.editorOpen.value, false);
  f.page.selectPeripheral(f.ctx.data.peripherals[0]);
  f.page.addSku(); f.page.removeSku(0);
  assert.equal(f.page.selectedPeripheral.value.skus.length, 1);
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.equal(f.writes.length, 0);
});
