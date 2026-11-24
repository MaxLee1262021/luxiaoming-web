"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const productContent = { cover: "https://test.invalid/frame.jpg", intro: "原木相框，现货发货。", shippingFee: 0 };
const completeDraft = (draft, values = {}) => Object.assign(draft, productContent, { name: "相框", price: 39.9, stock: 5 }, values);

function fixture(rows = [], options = {}) {
  const messages = [], writes = [];
  const Vue = { ref: (value) => ({ value }), reactive: (value) => value, computed: (getter) => ({ get value() { return getter(); } }) };
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
  const f = fixture([{ ...productContent, id: "frame", name: "相框", specs: ["10寸", "原木"], stockQty: 12, price: 38.5 }]);
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
  const f = fixture([{ ...productContent, id: "legacy", name: "旧相册", price: 20 }, { id: "empty", stock: 0 }, { id: "low", stockQty: 2 }, { id: "ready", stock: 20 }]);
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
  f.page.selectedPeripheral.value.isShow = false;
  assert.equal(source.isShow, true);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].previous.isShow, true);
  assert.equal(f.writes[0].payload.isShow, false);
  assert.equal(f.writes[0].payload.status, "下架");
  assert.equal(source.isShow, false);
  assert.equal(Object.hasOwn(source, "description"), false);
  assert.equal(source.price, 139);
  for (const field of ["stock", "stockQty", "specMode", "productCode", "unit", "stockWarning", "skus", "shippingFee"]) {
    assert.equal(Object.hasOwn(source, field), false, `${field} 不应由隐藏操作补入默认值`);
    assert.equal(Object.hasOwn(f.writes[0].payload, field), false, `${field} 不应作为销售参数改动提交`);
  }
  assert.deepEqual(Object.keys(f.writes[0].payload).sort(), ["_id", "auditStatus", "id", "isShow", "status"]);
  assert.equal(f.page.stockText(source), "未设置");
  assert.equal(f.page.editorOpen.value, false);
  assert.match(f.messages.at(-1), /已保存/);
});

test("隐藏旧商品保留 stockQty 库存别名和既有规格，修改库存后仍正常同步", async () => {
  const f = fixture([{ ...productContent, id: "diy", name: "创意DIY套装", price: 139, stockQty: 6, specs: ["标准套装"], isShow: true }]);
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
  // These sales fields are intentionally complete so only stock is invalid.
  draft.shippingFee = 0;
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
  completeDraft(f.page.selectedPeripheral.value, { name: "新隐藏商品", isShow: false, stock: undefined });
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
  completeDraft(draft, { name: "定制相框", specMode: "multiple", price: 999, stock: 999, specs: ["过期说明"] });
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

test("单规格样式与规格独立预览和保存，未填写样式的旧商品继续显示原规格", async () => {
  const f = fixture([{ ...productContent, id: "frame", name: "相框", price: 39.9, stock: 5, specs: ["8寸15×20cm"] }]);
  const source = f.ctx.data.peripherals[0];
  assert.equal(f.page.styleText(source), "未设置");
  assert.equal(f.page.specText(source), "8寸15×20cm");
  f.page.selectPeripheral(source);
  const draft = f.page.selectedPeripheral.value;
  assert.equal(draft.skuStyle, "");
  draft.skuStyle = " 可横可竖 ";
  assert.equal(f.page.styleText(draft), "可横可竖");
  assert.equal(f.page.specText(draft), "8寸15×20cm");
  assert.equal(source.skuStyle, undefined);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(f.writes[0].payload.skuStyle, "可横可竖");
  assert.deepEqual(f.writes[0].payload.specs, ["8寸15×20cm"]);
  f.page.selectPeripheral(source);
  assert.equal(f.page.selectedPeripheral.value.skuStyle, "可横可竖");
});

test("同尺寸不同样式可分别保存价格库存，但重复的规格样式组合被拒绝", async () => {
  const f = fixture(); f.page.createPeripheral();
  const draft = completeDraft(f.page.selectedPeripheral.value, { specMode: "multiple" });
  draft.skus = [
    { spec: "8寸15×20cm", style: " 可横可竖 ", price: 20, stock: 2 },
    { spec: "8寸15×20cm", style: " 两宫格 ", price: 30, stock: 3 }
  ];
  assert.equal(f.page.skuLabel(draft.skus[0]), "可横可竖 / 8寸15×20cm");
  assert.equal(f.page.styleText(draft), "可横可竖 / 两宫格");
  assert.equal(f.page.specText(draft), "2 个规格");
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  const saved = f.ctx.data.peripherals[0];
  assert.deepEqual(Array.from(saved.skus, (sku) => sku.style), ["可横可竖", "两宫格"]);
  assert.equal(saved.price, 20); assert.equal(saved.stock, 5);
  f.page.selectPeripheral(saved);
  f.page.selectedPeripheral.value.skus[1].style = " 可横可竖 ";
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /规格名称与样式.*重复/);
  assert.equal(f.writes.length, 1);
  assert.equal(saved.skus[1].style, "两宫格");
});

test("单规格与多规格模式切换保留共同样式，不同样式完整并入规格说明", async () => {
  const f = fixture([{ ...productContent, id: "frame", name: "相框", price: 20, stock: 2, specs: ["8寸15×20cm"], skuStyle: "可横可竖" }]);
  f.page.selectPeripheral(f.ctx.data.peripherals[0]);
  const draft = f.page.selectedPeripheral.value;
  draft.specMode = "multiple"; f.page.changeSpecMode("multiple");
  assert.equal(draft.skus[0].style, "可横可竖");
  f.page.addSku();
  Object.assign(draft.skus[1], { spec: "10寸20×25cm", style: "可横可竖", price: 30, stock: 3 });
  draft.specMode = "single"; f.page.changeSpecMode("single");
  assert.equal(draft.skuStyle, "可横可竖");
  assert.deepEqual(Array.from(draft.specs), ["8寸15×20cm", "10寸20×25cm"]);
  draft.specMode = "multiple"; draft.skus[1].style = "两宫格";
  draft.specMode = "single"; f.page.changeSpecMode("single");
  assert.equal(draft.skuStyle, "");
  assert.deepEqual(Array.from(draft.specs), ["8寸15×20cm【可横可竖】", "10寸20×25cm【两宫格】"]);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.deepEqual(Array.from(f.writes[0].payload.specs), ["8寸15×20cm【可横可竖】", "10寸20×25cm【两宫格】"]);
});

test("样式最多80字，单规格与多规格均在保存前校验并保留草稿", async () => {
  const f = fixture(); f.page.createPeripheral();
  const draft = completeDraft(f.page.selectedPeripheral.value, { skuStyle: "横".repeat(81) });
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /样式不能超过 80/);
  draft.skuStyle = "横".repeat(80);
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  f.page.createPeripheral();
  const multi = completeDraft(f.page.selectedPeripheral.value, { specMode: "multiple" });
  multi.skus = [{ spec: "8寸", style: "横".repeat(81), price: 20, stock: 2 }];
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /第 1 行样式不能超过 80/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.page.selectedPeripheral.value, multi);
});

test("规格切换保留资料且删除规格至少保留一条，单规格保存不残留失效SKU", async () => {
  const f = fixture([{ ...productContent, id: "gift", name: "周边", price: 20, stock: 4, specs: ["10寸", "原木"] }]);
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
  completeDraft(draft, { name: "相册" });
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
  const f = fixture([{ ...productContent, id: "frame", name: "相框", stock: 5, price: 40, specMode: "multiple", skus: [{ spec: "10寸", price: 40, stock: 5 }] }], { failSave: true });
  const source = f.ctx.data.peripherals[0];
  f.page.selectPeripheral(source);
  f.page.selectedPeripheral.value.skus[0].stock = 2;
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.equal(f.writes.length, 1);
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
  completeDraft(draft);
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

test("新建商品和新增规格不默认确认价格、库存及包邮", () => {
  const f = fixture();
  f.page.createPeripheral();
  const draft = f.page.selectedPeripheral.value;
  for (const field of ["price", "stock", "shippingFee"]) assert.equal(draft[field], undefined, field);
  assert.equal(f.page.stockState(draft).key, "unset");
  assert.equal(f.page.priceText(draft), "待填写");
  draft.specMode = "multiple";
  f.page.changeSpecMode("multiple");
  assert.equal(draft.skus[0].price, undefined);
  assert.equal(draft.skus[0].stock, undefined);
  draft.price = 20;
  f.page.addSku();
  assert.equal(draft.skus[1].stock, undefined);
  assert.equal(f.writes.length, 0);
});

test("新建逐项校验必填信息，缺失或空白值不会写入或关闭草稿", async t => {
  const cases = [
    { field: "name", values: [undefined, "", "  "], message: /商品名称/ },
    { field: "unit", values: [undefined, "", "  "], message: /销售单位/ },
    { field: "specMode", values: [undefined, "", "  ", "other"], message: /规格模式/ },
    { field: "price", values: [undefined, null, "", "  ", 0, "0.00"], message: /商品售价/ },
    { field: "stock", values: [undefined, null, "", "  "], message: /库存/ },
    { field: "shippingFee", values: [undefined, null, "", "  "], message: /运费/ },
    { field: "cover", values: [undefined, "", "  "], message: /商品素材/ },
    { field: "intro", values: [undefined, "", "  "], message: /商品说明/ }
  ];
  for (const { field, values, message } of cases) {
    for (const value of values) await t.test(`${field}=${String(value)}`, async () => {
      const f = fixture();
      f.page.createPeripheral();
      const draft = completeDraft(f.page.selectedPeripheral.value, { [field]: value });
      assert.equal(await f.page.saveSelectedPeripheral(), false);
      assert.match(f.messages.at(-1), message);
      assert.equal(f.writes.length, 0);
      assert.equal(f.ctx.data.peripherals.length, 0);
      assert.equal(f.page.editorOpen.value, true);
      assert.equal(f.page.selectedPeripheral.value, draft);
    });
  }
});

test("零库存和免费运费是明确有效值，单规格默认规格说明仍可为空", async () => {
  const f = fixture();
  f.page.createPeripheral();
  completeDraft(f.page.selectedPeripheral.value, { price: 0.01, stock: 0, shippingFee: 0, specs: [] });
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  const saved = f.writes[0].payload;
  assert.equal(saved.price, 0.01);
  assert.equal(saved.stock, 0);
  assert.equal(saved.stockQty, 0);
  assert.equal(saved.shippingFee, 0);
  assert.deepEqual(saved.specs, []);
  assert.equal(f.page.stockState(f.ctx.data.peripherals[0]).key, "empty");
});

test("商品素材可使用首图、照片或视频，空白素材列表不能充当必填内容", async t => {
  for (const [label, fields] of [
    ["首图", { cover: productContent.cover }],
    ["照片", { cover: "", images: [productContent.cover] }],
    ["视频", { cover: "", videos: ["https://test.invalid/frame.mp4"] }]
  ]) await t.test(label, async () => {
    const f = fixture(); f.page.createPeripheral();
    completeDraft(f.page.selectedPeripheral.value, fields);
    assert.equal(await f.page.saveSelectedPeripheral(), true);
    assert.equal(f.writes.length, 1);
  });
  const f = fixture(); f.page.createPeripheral();
  completeDraft(f.page.selectedPeripheral.value, { cover: "  ", images: ["", "  "], videos: ["  "] });
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /商品素材/);
  assert.equal(f.writes.length, 0);
});

test("已上架商品正常编辑不能清空素材、说明或运费", async t => {
  for (const [field, value, message] of [["cover", " ", /商品素材/], ["intro", " ", /商品说明/], ["shippingFee", undefined, /运费/]]) {
    await t.test(field, async () => {
      const f = fixture([{ ...productContent, id: "frame", name: "相框", price: 20, stock: 3, isShow: true }]);
      const source = f.ctx.data.peripherals[0], before = clone(source);
      f.page.selectPeripheral(source);
      f.page.selectedPeripheral.value[field] = value;
      assert.equal(await f.page.saveSelectedPeripheral(), false);
      assert.match(f.messages.at(-1), message);
      assert.equal(f.writes.length, 0);
      assert.deepEqual(source, before);
    });
  }
});

test("仅后台调用也能撤下历史商品，隐藏同时修改内容不能绕过必填校验", async t => {
  const hidden = fixture([{ id: "legacy", name: "旧相框", isShow: true }]);
  hidden.page.selectPeripheral(hidden.ctx.data.peripherals[0]);
  hidden.page.selectedPeripheral.value.internalOnly = true;
  assert.equal(await hidden.page.saveSelectedPeripheral(), true);
  assert.equal(hidden.writes[0].payload.internalOnly, true);
  assert.equal(hidden.writes[0].payload.status, "下架");
  assert.deepEqual(Object.keys(hidden.writes[0].payload).sort(), ["_id", "auditStatus", "id", "internalOnly", "isShow", "status"]);
  for (const field of ["isShow", "internalOnly"]) await t.test(field, async () => {
    const f = fixture([{ id: "legacy", name: "旧相框", price: 20, isShow: true }]);
    const source = f.ctx.data.peripherals[0], before = clone(source);
    f.page.selectPeripheral(source);
    Object.assign(f.page.selectedPeripheral.value, { [field]: field === "isShow" ? false : true, intro: "暂停销售" });
    assert.equal(await f.page.saveSelectedPeripheral(), false);
    assert.match(f.messages.at(-1), /运费|库存/);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(source, before);
  });
});

test("新增规格需要明确填写库存，零库存规格可与有库存规格一起保存", async () => {
  const f = fixture(); f.page.createPeripheral();
  const draft = completeDraft(f.page.selectedPeripheral.value, { specMode: "multiple" });
  f.page.changeSpecMode("multiple");
  Object.assign(draft.skus[0], { spec: "标准款", price: 20, stock: 5 });
  f.page.addSku();
  Object.assign(draft.skus[1], { spec: "大号", price: 30 });
  assert.equal(draft.skus[1].stock, undefined);
  assert.equal(await f.page.saveSelectedPeripheral(), false);
  assert.match(f.messages.at(-1), /第 2 行库存/);
  assert.equal(f.writes.length, 0);
  draft.skus[1].stock = 0;
  assert.equal(await f.page.saveSelectedPeripheral(), true);
  assert.equal(f.writes[0].payload.skus[1].stock, 0);
  assert.equal(f.writes[0].payload.stock, 5);
});

test("单价和运费拒绝多余小数或超交易上限，合法边界不被舍入", async t => {
  for (const field of ["price", "shippingFee"]) {
    for (const value of [1.001, "19.999", 10000000.01]) await t.test(`${field}=${value}`, async () => {
      const f = fixture(); f.page.createPeripheral();
      completeDraft(f.page.selectedPeripheral.value, { [field]: value });
      assert.equal(await f.page.saveSelectedPeripheral(), false);
      assert.match(f.messages.at(-1), /两位小数.*10000000/);
      assert.equal(f.writes.length, 0);
    });
    await t.test(`${field} 上限`, async () => {
      const f = fixture(); f.page.createPeripheral();
      completeDraft(f.page.selectedPeripheral.value, { [field]: 10000000 });
      assert.equal(await f.page.saveSelectedPeripheral(), true);
      assert.equal(f.writes[0].payload[field], 10000000);
    });
  }
});

test("多规格逐行校验名称、售价及库存，不能用起售价掩盖无效SKU", async t => {
  const cases = [
    ["spec", "  ", /第 2 行.*规格名称/],
    ["price", undefined, /第 2 行.*售价/],
    ["price", 0, /第 2 行.*售价/],
    ["price", 1.001, /第 2 行.*售价/],
    ["price", 10000000.01, /第 2 行.*售价/],
    ["stock", undefined, /第 2 行库存/],
    ["stock", -1, /第 2 行库存/]
  ];
  for (const [field, value, message] of cases) await t.test(`${field}=${String(value)}`, async () => {
    const f = fixture(); f.page.createPeripheral();
    const draft = completeDraft(f.page.selectedPeripheral.value, { specMode: "multiple" });
    draft.skus = [{ spec: "标准款", price: 20, stock: 2 }, { spec: "大号", price: 30, stock: 3, [field]: value }];
    assert.equal(await f.page.saveSelectedPeripheral(), false);
    assert.match(f.messages.at(-1), message);
    assert.equal(f.writes.length, 0);
    assert.equal(f.page.editorOpen.value, true);
  });
});

test("影像周边必填表单使用实际 Vue 运行时编译通过", () => {
  const sandbox = { window: {}, console: { info() {}, warn() {}, log() {} }, document: { createElement: () => ({}) } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "public/vendor/vue.global.js"), "utf8"), sandbox);
  const errors = [];
  const render = sandbox.Vue.compile(fs.readFileSync(path.join(root, "src/views/content/peripheral/peripheral.html"), "utf8"), {
    onError: error => errors.push(error.message), decodeEntities: text => text
  });
  assert.deepEqual(errors, []);
  assert.equal(typeof render, "function");
});
