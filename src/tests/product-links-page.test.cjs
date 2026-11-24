"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const catalog = [
  { id: "PHOTO-A", type: "album", typeLabel: "照片留影", name: "街头留影", status: "available", statusLabel: "可访问", canGenerate: true, price: 0 },
  { id: "VIDEO-B", type: "video", typeLabel: "视频摄像", name: "城市短片", status: "available", statusLabel: "可访问", canGenerate: true },
  { id: "PACKAGE-C", type: "package", typeLabel: "旅拍套餐", name: "亲子旅拍", status: "unavailable", statusLabel: "暂不可访问", canGenerate: false, disabledReason: "已下架" },
  { id: "GOODS-D", type: "peripheral", typeLabel: "周边商品", name: "原木相框", status: "available", statusLabel: "可访问", canGenerate: true }
];

function fixture(options = {}) {
  const mounts = [], unmounts = [], requests = [], messages = [], selected = [];
  let nextResponse = null, failure = "", clipboardResult = options.clipboardResult, fallbackResult = options.fallbackResult !== false;
  const copied = [];
  const ctx = { ElMessage: Object.fromEntries(["warning", "error", "success"].map(type => [type, value => messages.push({ type, value })])) };
  const document = {
    activeElement: { focus() {} }, body: { appendChild() {} },
    createElement() { return { style: {}, setAttribute() {}, select() { selected.push(this.value); }, setSelectionRange() {}, remove() {} }; },
    execCommand() { if (options.fallbackThrows) throw new Error("Clipboard denied"); return fallbackResult; }
  };
  const window = {
    Vue: { ref: value => ({ value }), reactive: value => value, computed: getter => ({ get value() { return getter(); } }), watch() {}, onMounted: fn => mounts.push(fn), onUnmounted: fn => unmounts.push(fn) },
    navigator: options.noClipboard ? {} : { clipboard: { async writeText(value) { if (clipboardResult === false) throw new Error("Clipboard denied"); copied.push(value); } } },
    LXM_PAGES: { register(page) { window.page = page; } },
    LXM_HTTP: { async request(url, init) {
      requests.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
      if (failure) throw new Error(failure);
      if (nextResponse) return nextResponse();
      const body = url.endsWith("/catalog") ? { items: structuredClone(catalog), configured: options.configured !== false, environment: options.environment || "release" }
        : { url: "https://wxaurl.cn/test-only", expiresAt: "2026-12-19T02:00:00.000Z", environment: "release" };
      return { ok: true, async json() { return body; } };
    } }
  };
  vm.runInNewContext(read("src/views/service/product-links/product-links.js"), { window, document });
  const page = window.page.setup(ctx);
  return { page, requests, messages, selected, copied, window,
    mount: async () => { for (const fn of mounts) await fn(); }, unmount: () => unmounts.forEach(fn => fn()),
    fail: value => { failure = value; }, response: value => { nextResponse = value; }
  };
}

test("catalog filters combine type, visibility, name and case-insensitive product IDs without losing the source rows", async () => {
  const f = fixture(); await f.mount();
  assert.equal(f.page.items.value.length, 4);
  assert.deepEqual(Array.from(f.page.typeCounts.value, row => row.count), [1, 1, 1, 1]);
  f.page.filters.keyword = "photo-a"; assert.deepEqual(Array.from(f.page.rows.value, row => row.id), ["PHOTO-A"]);
  f.page.filters.type = "peripheral"; assert.equal(f.page.rows.value.length, 0);
  f.page.reset(); f.page.filters.status = "unavailable"; assert.equal(f.page.rows.value[0].id, "PACKAGE-C");
  assert.equal(f.page.items.value.length, 4);
  assert.equal(f.page.money(0), "¥0.00"); assert.equal(f.page.money(null), "—");
});

test("generation is blocked for missing credentials, hidden products and failed catalog loads", async () => {
  for (const options of [{ configured: false }, {}]) {
    const f = fixture(options); await f.mount();
    await f.page.generate(options.configured === false ? f.page.items.value[0] : f.page.items.value[2]);
    assert.equal(f.requests.length, 1); assert.equal(f.page.dialogOpen.value, false);
    assert.equal(f.messages.at(-1).type, "warning");
  }
  const f = fixture(); await f.mount(); f.fail("服务暂不可用"); await f.page.load();
  assert.equal(f.page.items.value.length, 0); assert.equal(f.page.configured.value, false);
  assert.equal(f.page.loadError.value, "服务暂不可用");
  await f.page.generate(catalog[0]); assert.equal(f.requests.length, 2);
});

test("successful generation submits the selected identity and lifetime and displays the server URL and expiry", async () => {
  const f = fixture(); await f.mount(); f.page.expireDays.value = 7;
  await f.page.generate(f.page.items.value[1]);
  assert.deepEqual(f.requests[1], { url: "/api/product-links/generate", method: "POST", body: { type: "video", id: "VIDEO-B", expireDays: 7 } });
  assert.equal(f.page.generated.value.name, "城市短片"); assert.equal(f.page.dialogOpen.value, true);
  assert.equal(f.page.generated.value.expiresAt, "2026-12-19T02:00:00.000Z"); assert.equal(f.page.busyKey.value, "");
  await f.page.copy(); assert.deepEqual(f.copied, ["https://wxaurl.cn/test-only"]);
  assert.equal(f.messages.at(-1).type, "success");
});

test("duplicate generation clicks share one in-flight request; provider failures clear old links without announcing success", async () => {
  const f = fixture(); await f.mount(); await f.page.generate(f.page.items.value[0]);
  let resolve;
  f.response(() => new Promise(done => { resolve = done; }));
  const first = f.page.generate(f.page.items.value[0]);
  assert.equal(f.page.generated.value, null); assert.equal(f.page.dialogOpen.value, false);
  await f.page.generate(f.page.items.value[1]); assert.equal(f.requests.length, 3);
  resolve({ ok: false, async json() { return { error: "微信接口额度不足" }; } }); await first;
  assert.equal(f.page.busyKey.value, ""); assert.equal(f.page.generated.value, null);
  assert.match(f.messages.at(-1).value, /微信接口额度不足/); assert.equal(f.messages.at(-1).type, "error");
});

test("malformed API results cannot become empty success lists or copyable links", async () => {
  const f = fixture(); f.response(async () => ({ ok: true, async json() { return {}; } })); await f.mount();
  assert.match(f.page.loadError.value, /列表返回异常/);
  const g = fixture(); await g.mount();
  g.response(async () => ({ ok: true, async json() { return { url: "javascript:alert(1)" }; } }));
  await g.page.generate(g.page.items.value[0]);
  assert.equal(g.page.dialogOpen.value, false); assert.equal(g.page.generated.value, null);
  await g.page.copy(); assert.equal(g.copied.length, 0);
});

test("clipboard denial and insecure contexts use manual copy fallback; failures do not falsely report success", async () => {
  for (const options of [{ clipboardResult: false }, { noClipboard: true }, { noClipboard: true, fallbackResult: false }, { noClipboard: true, fallbackThrows: true }]) {
    const f = fixture(options); await f.mount(); await f.page.generate(f.page.items.value[0]); await f.page.copy();
    assert.deepEqual(f.selected, ["https://wxaurl.cn/test-only"]);
    assert.equal(f.messages.at(-1).type, options.fallbackResult === false || options.fallbackThrows ? "warning" : "success");
    assert.equal(f.page.copying.value, false);
  }
});

test("unmounted catalog requests cannot repopulate page data", async () => {
  const f = fixture(); let resolve;
  f.response(() => new Promise(done => { resolve = done; }));
  const pending = f.mount(); f.unmount();
  resolve({ ok: true, async json() { return { items: catalog, configured: true }; } }); await pending;
  assert.equal(f.page.items.value.length, 0); assert.equal(f.page.configured.value, false);
});

test("the new menu, default customer-service roles and lazy page agree; the template compiles", () => {
  const sandbox = { window: {}, console: { info() {}, warn() {}, log() {} } };
  vm.createContext(sandbox); vm.runInContext(read("src/config/business-config.js"), sandbox);
  sandbox.LXM_CONFIG = sandbox.window.LXM_CONFIG;
  vm.runInContext(read("src/config/customer-service.js"), sandbox);
  const config = sandbox.window.LXM_CONFIG;
  assert.equal(config.menus.find(row => row.key === "productLinks").group, "客服工作台");
  for (const role of ["super", "service", "service_supervisor"]) assert.ok(config.roles[role].menus.includes("productLinks"));
  assert.equal(config.roles.finance.menus.includes("productLinks"), false);
  vm.runInContext(read("src/router/index.js"), sandbox);
  assert.equal(sandbox.window.LXM_PAGES.manifest.find(row => row.key === "productLinks").folder, "service/product-links");
  vm.runInContext(read("public/vendor/vue.global.js"), sandbox);
  assert.equal(typeof sandbox.Vue.compile(read("src/views/service/product-links/product-links.html"), { onError(error) { throw error; }, decodeEntities: text => text }), "function");
});
