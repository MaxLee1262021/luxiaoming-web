"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const calls = [], messages = [], prompts = [];
  const config = {
    id: "settings", version: 7, enabled: true, enabledProductIds: ["frame"],
    allowedProvinces: ["湖南省"], paymentMinutes: 30, afterSaleDays: 7,
    wechatReceiptRequired: true, shippingFeeMode: "maximum", returnDays: 12,
    maxPendingOrders: 4, carrierOptions: [{ code: "ems", name: "EMS" }],
    productPolicies: { frame: { fulfillmentMode: "stock", saleEnabled: true, annotation: { source: "existing" } } }
  };
  const catalog = { items: [{ id: "frame", name: "相框", fulfillmentMode: "stock",
    skus: [{ id: "frame-sku", spec: "8寸", available: 5, inventoryVersion: 9 }] }] };
  const ElMessage = message => messages.push({ type: "info", message });
  for (const type of ["success", "warning", "error"]) ElMessage[type] = message => messages.push({ type, message });
  const ctx = {
    state: { filters: {}, role: options.role || "super", authSource: "server" },
    data: { peripherals: [] }, can: () => true, ElMessage,
    isServerConnected: () => true,
    ElMessageBox: { async prompt(message, title, settings) {
      prompts.push({ message, title, settings });
      return { value: prompts.length % 2 ? "3" : "盘点补充库存" };
    } }
  };
  const Vue = {
    ref: value => ({ value }), reactive: value => value,
    computed: getter => ({ get value() { return getter(); } })
  };
  const window = {
    Vue, ElementPlus: { ElMessage },
    LXM_PAGES: { register(page) { window.page = page; } },
    LXM_HTTP: { async request(url, init = {}) {
      const action = url.split("?")[0].split("/").at(-1);
      const body = init.body && JSON.parse(init.body);
      calls.push({ url, action, method: init.method || "GET", body });
      const error = action === "saveConfig" && options.saveError || action === "adjustStock" && options.stockError || action === "config" && options.loadError;
      if (error) return { ok: false, json: async () => ({ code: "PHYSICAL_CONFLICT", msg: error }) };
      let data;
      if (action === "config") data = config;
      else if (action === "catalog") data = catalog;
      else if (action === "saveConfig") { Object.assign(config, clone(body)); data = config; }
      else if (action === "adjustStock") {
        const sku = catalog.items[0].skus[0];
        sku.available += body.delta; sku.inventoryVersion++;
        data = clone(sku);
      } else throw new Error("Unexpected API: " + url);
      return { ok: true, json: async () => ({ code: 0, data }) };
    } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/views/content/peripheral/peripheral.js"), "utf8"), {
    window, Vue, URLSearchParams,
    LXM_API: { remoteOn: () => true, setRemote() {}, loadCollection: async () => [] }
  });
  return { page: window.page.setup(ctx), ctx, calls, messages, prompts, config, catalog, options };
}

test("销售配置入口和完整表单迁到周边商品，工作台不再保留旧入口", () => {
  const peripheral = fs.readFileSync(path.join(root, "src/views/content/peripheral/peripheral.html"), "utf8");
  const workbench = fs.readFileSync(path.join(root, "src/views/service/workbench/workbench.html"), "utf8");
  assert.match(peripheral, /<el-button\b[^>]*v-if="physicalCanConfigureSales"[^>]*@click="physicalConfigure"[^>]*>销售配置<\/el-button>/);
  assert.match(peripheral, /title="实物销售配置"/);
  for (const label of ["开放实物购买", "允许购买的现货商品", "配送省份", "待付款有效期（分钟）", "售后申请期（天）", "适用微信发货管理", "同包运费", "交易库存", "调整库存"]) assert.ok(peripheral.includes(label), label);
  assert.doesNotMatch(workbench, /physicalConfigure|physicalSaveConfig|title="实物销售配置"/);
  assert.doesNotMatch(peripheral, /客服工作台 → 实物订单 → 销售配置|「实物订单 → 销售配置」/);
});

test("打开销售配置仅获取配置和目录，修改或取消草稿不污染已存配置", async () => {
  const f = fixture(), before = clone(f.config);
  await f.page.physicalConfigure();
  assert.equal(f.page.physicalSales.dialog, "config");
  assert.equal(f.page.physicalSales.loading, false);
  assert.deepEqual(f.calls.map(call => [call.action, call.method]).sort(), [["catalog", "GET"], ["config", "GET"]]);
  assert.equal(f.page.physicalSales.products[0].name, "相框");
  const draft = f.page.physicalSales.config;
  draft.enabled = false;
  draft.enabledProductIds.push("album");
  draft.allowedProvinces.push("广东省");
  draft.carrierOptions[0].name = "草稿快递";
  draft.productPolicies.frame.annotation.source = "draft";
  assert.deepEqual(f.config, before);
  f.page.physicalSales.dialog = "";
  await f.page.physicalConfigure();
  assert.deepEqual(clone(f.page.physicalSales.config), before);
  assert.equal(f.calls.some(call => call.method === "POST"), false);
});

test("保存完整销售配置保留现有隐藏字段，成功关闭弹窗且不加载实物订单", async () => {
  const f = fixture();
  await f.page.physicalConfigure();
  Object.assign(f.page.physicalSales.config, { enabled: false, paymentMinutes: 45, afterSaleDays: 15 });
  f.page.physicalSales.config.allowedProvinces.push("广东省");
  const expected = clone(f.page.physicalSales.config);
  await f.page.physicalSaveConfig();
  const saves = f.calls.filter(call => call.action === "saveConfig");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].method, "POST");
  assert.deepEqual(saves[0].body, expected);
  assert.equal(saves[0].body.returnDays, 12);
  assert.equal(saves[0].body.maxPendingOrders, 4);
  assert.equal(saves[0].body.carrierOptions[0].code, "ems");
  assert.equal(f.page.physicalSales.dialog, "");
  assert.equal(f.page.physicalSales.busy, false);
  assert.equal(f.calls.some(call => ["list", "detail", "afterSales"].includes(call.action)), false);
  assert.ok(f.messages.some(message => /销售配置.*已保存/.test(message.message)));
});

test("保存失败时保留弹窗和完整草稿，展示错误后可重试", async () => {
  const f = fixture({ saveError: "销售配置保存失败，请稍后重试" });
  await f.page.physicalConfigure();
  f.page.physicalSales.config.paymentMinutes = 60;
  const expected = clone(f.page.physicalSales.config);
  await f.page.physicalSaveConfig();
  assert.equal(f.page.physicalSales.dialog, "config");
  assert.equal(f.page.physicalSales.busy, false);
  assert.deepEqual(clone(f.page.physicalSales.config), expected);
  assert.match(f.page.physicalSales.error, /销售配置保存失败/);
  assert.equal(f.config.paymentMinutes, 30);
  f.options.saveError = "";
  await f.page.physicalSaveConfig();
  assert.equal(f.page.physicalSales.dialog, "");
  assert.equal(f.config.paymentMinutes, 60);
});

test("配置载入失败明确展示错误，不打开不完整的配置弹窗", async () => {
  const f = fixture({ loadError: "配置暂时不可用" });
  await f.page.physicalConfigure();
  assert.equal(f.page.physicalSales.dialog, "");
  assert.equal(f.page.physicalSales.loading, false);
  assert.match(f.page.physicalSales.error, /配置暂时不可用/);
});

test("库存调整提交库存版本与原因，刷新目录但保留未保存的销售草稿", async () => {
  const f = fixture();
  await f.page.physicalConfigure();
  f.page.physicalSales.config.paymentMinutes = 55;
  await f.page.physicalAdjustStock(f.page.physicalSales.products[0].skus[0]);
  assert.equal(f.prompts.length, 2);
  const adjustment = f.calls.find(call => call.action === "adjustStock");
  assert.equal(adjustment.method, "POST");
  assert.deepEqual(adjustment.body, { skuId: "frame-sku", version: 9, delta: 3, reason: "盘点补充库存" });
  assert.equal(f.calls.filter(call => call.action === "catalog").length, 2);
  assert.equal(f.page.physicalSales.products[0].skus[0].available, 8);
  assert.equal(f.page.physicalSales.config.paymentMinutes, 55);
  assert.equal(f.config.paymentMinutes, 30);
  assert.equal(f.page.physicalSales.dialog, "config");
  assert.equal(f.calls.some(call => ["list", "detail", "saveConfig"].includes(call.action)), false);
});

test("库存冲突在销售配置中可见且不会吞掉错误或丢失草稿", async () => {
  const f = fixture({ stockError: "库存已变化，请刷新" });
  await f.page.physicalConfigure();
  f.page.physicalSales.config.afterSaleDays = 21;
  await f.page.physicalAdjustStock(f.page.physicalSales.products[0].skus[0]);
  assert.match(f.page.physicalSales.error, /库存已变化/);
  assert.equal(f.page.physicalSales.busy, false);
  assert.equal(f.page.physicalSales.dialog, "config");
  assert.equal(f.page.physicalSales.config.afterSaleDays, 21);
  assert.equal(f.calls.filter(call => call.action === "catalog").length, 1);
  assert.equal(f.messages.some(message => message.type === "success"), false);
});

test("销售配置保留管理员权限，其他角色看不到入口且直接调用也不请求接口", async t => {
  for (const role of ["super", "admin"]) await t.test(role, async () => {
    const f = fixture({ role });
    assert.equal(f.page.physicalCanConfigureSales.value, true);
    await f.page.physicalConfigure();
    assert.equal(f.page.physicalSales.dialog, "config");
  });
  for (const role of ["service", "content"]) await t.test(role, async () => {
    const f = fixture({ role });
    assert.equal(f.page.physicalCanConfigureSales.value, false);
    await f.page.physicalConfigure();
    await f.page.physicalSaveConfig();
    await f.page.physicalAdjustStock({ id: "frame-sku", inventoryVersion: 9 });
    assert.equal(f.calls.length, 0);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.page.physicalSales.dialog, "");
  });
});
