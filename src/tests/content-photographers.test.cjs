"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const copy = (value) => JSON.parse(JSON.stringify(value));
const photographers = [
  { id: "PH20260001", name: "测试摄影师甲" },
  { id: "PH20260002", name: "测试摄影师乙" }
];
const products = {
  album: { file: "album/album", collection: "albums", title: "测试照片留影" },
  video: { file: "videoSingle/videoSingle", collection: "packages", title: "测试视频摄像" },
  package: { file: "package/package", collection: "packages", title: "测试旅拍套餐" }
};

// Execute the real page setup and save actions against isolated memory records.
// No production API, MySQL connection, uploads or external accounts are used.
function fixture(kind, options = {}) {
  const writes = [], messages = [], mounted = [];
  let optionsLoads = 0;
  const computed = (definition) => typeof definition === "function"
    ? { get value() { return definition(); } }
    : { get value() { return definition.get(); }, set value(value) { definition.set(value); } };
  const Vue = { ref: (value) => ({ value }), reactive: (value) => value, computed,
    watch() {}, onMounted: (callback) => mounted.push(callback), onBeforeUnmount() {}, unref: (value) => value?.value ?? value };
  const notify = (message) => messages.push(message);
  Object.assign(notify, { warning: notify, success: notify, error: notify });
  const data = {
    albums: [{ id: "fixture-photo", name: "测试照片", tags: ["风格"], price: 100, sampleUrls: ["/test.jpg"], cover: "/test.jpg", isShow: true }],
    packages: [{ id: "fixture-video", name: "测试视频", title: "测试视频", tags: ["风格"], type: "video", price: 200, isShow: true }],
    peripherals: [], cities: [], spots: [], series: [], tagLibrary: []
  };
  if (options.existing) {
    const row = kind === "album" ? data.albums[0] : kind === "video" ? data.packages[0] : {
      id: "fixture-package", name: "历史套餐", tags: ["风格"], type: "photo", isShow: true, price: 100,
      includedItems: [{ type: "album", productId: "fixture-photo", name: "测试照片", price: 100, quantity: 1 }]
    };
    Object.assign(row, options.existing);
    if (kind === "package") data.packages.push(row);
  }
  const ctx = {
    data, state: { authSource: "server", role: "super", filters: {} },
    can: () => true, isServerConnected: () => true, money: (value) => `¥${value}`,
    albumRows: computed(() => data.albums),
    albumPhotoUrls: (row) => row.sampleUrls || [],
    setAlbumCover: (row, url) => { row.cover = url; },
    contentVideoUrl: () => "", filterVideoSingleRows: (rows) => rows.filter((row) => row.type === "video"),
    videoSingleStatus: () => "上架", clearContentFilters() {},
    packageTitleLimit: 27, packageTitleLength: (value) => String(value || "").length,
    normalizePackageTitle: (value) => String(value || "").trim(), packageTitleError: () => "",
    contentPhotographerOptions: computed(() => photographers),
    contentPhotographersLoading: Vue.ref(false), contentPhotographersError: Vue.ref(""),
    loadContentPhotographers: async () => { optionsLoads += 1; return true; },
    contentPhotographerName: (row) => !row.recommendedPhotographerId ? "未设置"
      : photographers.find((person) => person.id === row.recommendedPhotographerId)?.name || "摄影师已失效",
    async persistContentMutation(collection, payload, previous) {
      writes.push({ collection, payload: copy(payload), previous: previous ? copy(previous) : null });
      return options.rejectSave !== true;
    }
  };
  const window = { Vue, ElMessage: notify, LXM_AUTH: { hasSession: () => true },
    LXM_UPLOAD: { ready: () => true, busy: () => false, single: async (_key, callback) => callback() },
    LXM_PAGES: { register(page) { window.page = page; } } };
  const LXM_API = { setRemote() {}, async loadCollection(key) { return copy(data[key]); } };
  const source = fs.readFileSync(path.join(root, "src/views/content", products[kind].file + ".js"), "utf8");
  vm.runInNewContext(source, { window, LXM_API, console });
  const page = window.page.setup(ctx);
  const record = () => kind === "album" ? data.albums.find((row) => row.name === products[kind].title)
    : data.packages.find((row) => row.name === products[kind].title);
  const draft = () => kind === "album" ? page.selectedAlbum.value : kind === "video" ? page.videoDraft.value : page.form.value;
  const edit = (row) => kind === "album" ? page.selectAlbum(row) : kind === "video" ? page.openVideoEditor(row) : page.openEdit(row);
  const save = () => kind === "album" ? page.saveSelectedAlbum() : kind === "video" ? page.saveSelectedVideoSingle() : page.saveForm();
  function create() {
    if (kind === "album") page.createAlbum();
    else if (kind === "video") page.openVideoEditor();
    else page.openCreate();
    Object.assign(draft(), { name: products[kind].title, title: products[kind].title, tags: ["风格"], price: 100 });
    if (kind === "album") draft().sampleUrls = ["/new-test.jpg"];
    if (kind === "package") Object.assign(draft(), { tagText: "风格", includedItems: [{ type: "album", productId: "fixture-photo", quantity: 1 }] });
  }
  return { ctx, page, writes, messages, draft, edit, save, create, record,
    get optionsLoads() { return optionsLoads; },
    async mount() { for (const callback of mounted) await callback(); } };
}

for (const kind of Object.keys(products)) {
  test(`${kind}: recommended photographer survives creation, editing and explicit clearing`, async () => {
    const f = fixture(kind);
    await f.mount();
    f.create();
    assert.equal(f.draft().recommendedPhotographerId, "", "new products have no default recommendation");
    assert.ok(f.optionsLoads > 0, "the page loads platform photographer names");
    assert.equal(f.page.contentPhotographerOptions.value.length, 2);
    f.draft().recommendedPhotographerId = photographers[0].id;
    assert.equal(await f.save(), true, f.messages.join("；"));
    assert.equal(f.writes.at(-1).collection, products[kind].collection);
    assert.equal(f.writes.at(-1).payload.recommendedPhotographerId, photographers[0].id);
    assert.equal(f.record().recommendedPhotographerId, photographers[0].id);
    assert.equal(f.page.contentPhotographerName(f.record()), photographers[0].name);

    f.edit(f.record());
    assert.equal(f.draft().recommendedPhotographerId, photographers[0].id, "editing restores the saved choice");
    f.draft().recommendedPhotographerId = photographers[1].id;
    assert.equal(await f.save(), true, f.messages.join("；"));
    assert.equal(f.record().recommendedPhotographerId, photographers[1].id);
    assert.equal(f.writes.at(-1).previous.recommendedPhotographerId, photographers[0].id);

    f.edit(f.record());
    assert.equal(f.draft().recommendedPhotographerId, photographers[1].id);
    f.draft().recommendedPhotographerId = null;
    assert.equal(await f.save(), true, f.messages.join("；"));
    assert.equal(f.writes.at(-1).payload.recommendedPhotographerId, "", "clearing must overwrite the old stored ID");
    f.edit(f.record());
    assert.equal(f.draft().recommendedPhotographerId, "");
    assert.equal(f.page.contentPhotographerName(f.record()), "未设置");
  });

  test(`${kind}: legacy records may save without selecting a photographer`, async () => {
    const f = fixture(kind, { existing: {} });
    await f.mount();
    const row = kind === "album" ? f.ctx.data.albums[0] : kind === "video" ? f.ctx.data.packages[0]
      : f.ctx.data.packages.find((row) => row.type === "photo");
    assert.equal(Object.hasOwn(row, "recommendedPhotographerId"), false);
    f.edit(row);
    assert.equal(f.draft().recommendedPhotographerId, "");
    assert.equal(await f.save(), true, f.messages.join("；"));
    assert.equal(f.writes.at(-1).payload.recommendedPhotographerId, "");
  });

  test(`${kind}: rejected saves preserve the prior recommendation and the edited draft`, async () => {
    const f = fixture(kind, { existing: { recommendedPhotographerId: photographers[0].id }, rejectSave: true });
    await f.mount();
    const row = kind === "album" ? f.ctx.data.albums[0] : kind === "video" ? f.ctx.data.packages[0]
      : f.ctx.data.packages.find((row) => row.type === "photo");
    f.edit(row);
    f.draft().recommendedPhotographerId = photographers[1].id;
    assert.equal(await f.save(), false);
    assert.equal(row.recommendedPhotographerId, photographers[0].id);
    assert.equal(f.draft().recommendedPhotographerId, photographers[1].id);
  });
}

test("all three catalog lists show photographer names and use a clearable single selection", () => {
  for (const [kind, product] of Object.entries(products)) {
    const template = fs.readFileSync(path.join(root, "src/views/content", product.file + ".html"), "utf8");
    const select = template.match(/<el-select\b[^>]*v-model="[^"]*\.recommendedPhotographerId"[^>]*>/)?.[0];
    assert.ok(select, kind + " photographer selector");
    assert.match(select, /\bclearable\b/);
    assert.match(select, /\bfilterable\b/);
    assert.doesNotMatch(select, /\bmultiple\b|\ballow-create\b/);
    assert.match(template, /推荐摄影师/);
    assert.match(template, /contentPhotographerName\((?:a|item|row)\)/, kind + " list recommendation");
    if (kind === "album") {
      assert.match(template, /<th[^>]*>推荐摄影师<\/th>/);
      assert.match(template, /<td>\s*{{\s*contentPhotographerName\(a\)\s*}}\s*<\/td>/);
    }
  }
});

function directoryFixture(request) {
  const ctx = { state: {}, data: {}, computed: (getter) => ({ get value() { return getter(); } }) };
  const window = { LXM_APP_PARTS: [], LXM_AUTH: { hasSession: () => true }, LXM_HTTP: { request } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/12-content-edit.js"), "utf8"), { window, console });
  return window.LXM_APP_PARTS[0](ctx);
}

test("photographer directory retries after an error and resolves list names from the latest directory", async () => {
  let requests = 0;
  const directory = directoryFixture(async (url) => {
    assert.equal(url, "/api/content/photographers");
    requests += 1;
    if (requests === 1) return { ok: false, async json() { return { error: "名单暂不可用" }; } };
    return { ok: true, async json() { return { rows: photographers.map((row) => ({ ...row, phone: "must not enter UI options" })) }; } };
  });
  assert.equal(await directory.loadContentPhotographers(), false);
  assert.equal(directory.contentPhotographersError.value, "名单暂不可用");
  assert.equal(directory.contentPhotographersLoading.value, false);
  assert.equal(await directory.loadContentPhotographers(), true);
  assert.equal(directory.contentPhotographersError.value, "");
  assert.deepEqual(copy(directory.contentPhotographerOptions.value), photographers);
  assert.equal(directory.contentPhotographerName({}), "未设置");
  assert.equal(directory.contentPhotographerName({ recommendedPhotographerId: photographers[0].id, recommendedPhotographerName: "过期姓名" }), photographers[0].name);
  assert.equal(directory.contentPhotographerName({ recommendedPhotographerId: "missing", recommendedPhotographerName: "已保存姓名" }), "已保存姓名");
});

test("simultaneous pages share a directory request and logout prevents late results replacing a new session", async () => {
  const pending = [];
  const directory = directoryFixture(() => new Promise((resolve) => pending.push(resolve)));
  const first = directory.loadContentPhotographers();
  const second = directory.loadContentPhotographers();
  await Promise.resolve();
  assert.equal(pending.length, 1);
  directory.clearContentPhotographers();
  assert.equal(directory.contentPhotographerOptions.value.length, 0);
  const current = directory.loadContentPhotographers();
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[1]({ ok: true, async json() { return { rows: [photographers[1]] }; } });
  assert.equal(await current, true);
  pending[0]({ ok: true, async json() { return { rows: [photographers[0]] }; } });
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.deepEqual(copy(directory.contentPhotographerOptions.value), [photographers[1]]);
  assert.equal(directory.contentPhotographersLoading.value, false);
});

function quickEditorFixture() {
  const writes = [], messages = [];
  let requests = 0;
  const computed = (getter) => ({ get value() { return getter(); } });
  const notify = (value) => messages.push(value);
  Object.assign(notify, { error: notify, warning: notify, success: notify });
  const ctx = {
    computed, ElMessage: notify, log() {}, currentOperatorName: () => "测试管理员",
    state: { active: "shelfProducts", role: "super", filters: {}, contentScope: {} },
    data: { cities: [], spots: [], series: [], albums: [], samples: [], packages: [], peripherals: [], guides: [],
      tagLibrary: [{ id: "fixture-style", name: "风格", category: "风格" }] },
    contentKeys: ["albums", "packages"], activeMenu: computed(() => ({ label: "商品" })),
    contentList: (key) => ctx.data[key], peripheralModeText: () => "全城通用",
    productStatus: (row) => row.isShow === false ? "下架" : "上架", packageAuditText: () => "已下"
  };
  async function write(key, id, payload) {
    writes.push({ key, payload: copy(payload) });
    return { ...copy(payload), id: id || payload.id, _id: id || payload.id };
  }
  const window = { LXM_APP_PARTS: [], LXM_AUTH: { hasSession: () => true },
    LXM_CLOUD_MODE: "mysql", LXM_API_STATE: { reachable: true },
    LXM_CLOUD: { update: write, create: (key, payload) => write(key, payload.id, payload) },
    LXM_UPLOAD: { ready: () => true },
    LXM_HTTP: { async request() { requests += 1; return { ok: true, async json() { return { rows: photographers }; } }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/12-content-edit.js"), "utf8"), {
    window, console, LXMFormat: { nowText: () => "2026-11-22", dateTime: () => "2026-11-22" }
  });
  Object.assign(ctx, window.LXM_APP_PARTS[0](ctx));
  return { ctx, writes, messages, get requests() { return requests; } };
}

test("quick editors opened from the shelf preserve and clear photographer recommendations", async () => {
  for (const kind of ["albums", "packages", "video"]) {
    const f = quickEditorFixture(), { ctx } = f;
    const open = (row) => kind === "video" ? ctx.openVideoSingle(row)
      : row ? ctx.openContent(row, kind) : ctx.openContentQuick(kind);
    const draft = () => kind === "video" ? ctx.state.videoSingleForm : ctx.state.editContent;
    const save = () => kind === "video" ? ctx.saveVideoSingle() : ctx.saveContent();
    open();
    assert.equal(draft().recommendedPhotographerId, "", kind + " starts without a recommendation");
    await Promise.resolve();
    assert.ok(f.requests > 0, kind + " quick edit loads the platform directory");
    Object.assign(draft(), { name: "快捷测试商品", title: "快捷测试商品", tags: ["风格"], serviceTags: [],
      isShow: false, status: "下架", price: 100, recommendedPhotographerId: photographers[0].id });
    await save();
    assert.equal(f.writes.at(-1)?.payload.recommendedPhotographerId, photographers[0].id, f.messages.join("；"));
    const key = kind === "albums" ? "albums" : "packages";
    const row = ctx.data[key][0];
    assert.ok(row, kind + " persisted row is added to the list");
    open(row);
    assert.equal(draft().recommendedPhotographerId, photographers[0].id, kind + " reopens with its saved choice");
    draft().recommendedPhotographerId = null;
    await save();
    assert.equal(f.writes.at(-1)?.payload.recommendedPhotographerId, "", kind + " explicitly clears the persisted choice");
    open(row);
    assert.equal(draft().recommendedPhotographerId, "");
  }
});

test("global quick edit dialogs expose photographer single selections for all three product types", () => {
  const shell = fs.readFileSync(path.join(root, "src/layout/app-shell.js"), "utf8");
  for (const [form, expectedCount] of [["state.editContent", 2], ["state.videoSingleForm", 1]]) {
    const selects = [...shell.matchAll(/<el-select\b[^>]*v-model="([^"]+\.recommendedPhotographerId)"[^>]*>/g)]
      .filter((match) => match[1] === form + ".recommendedPhotographerId");
    assert.equal(selects.length, expectedCount, form + " recommendation fields");
    for (const [select] of selects) {
      assert.match(select, /\bclearable\b/);
      assert.match(select, /\bfilterable\b/);
      assert.doesNotMatch(select, /\bmultiple\b|\ballow-create\b/);
    }
  }
});

test("browser: all three product editors select, restore and clear recommended photographers", {
  skip: process.env.RUN_CONTENT_PHOTOGRAPHERS_BROWSER !== "1", timeout: 90000
}, async (t) => {
  const { startBrowserFixture } = require("../../server/tests/fixtures/merchant-share-browser.cjs");
  const fixture = await startBrowserFixture();
  const playwright = require(process.env.CONTENT_PLAYWRIGHT_MODULE || "playwright");
  const browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.CONTENT_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1512, height: 1100 } });
  page.setDefaultTimeout(10000);
  const output = path.resolve(root, "../outputs/content-photographers-20261122");
  fs.mkdirSync(output, { recursive: true });
  const report = { testOnly: true, realDatabaseAccess: false, checks: [], writes: [], errors: [] };
  page.on("pageerror", (error) => report.errors.push(error.message));
  t.after(async () => {
    fs.writeFileSync(path.join(output, "browser.json"), JSON.stringify(report, null, 2));
    try { await browser.close(); } finally { await fixture.close(); }
  });
  await fixture.source.create("albums", { id: "browser-photo", name: "测试照片留影", tags: ["风格"], price: 100,
    photoCount: 1, sampleUrls: ["/images/placeholder.png"], cover: "/images/placeholder.png", isShow: true });
  await fixture.source.create("packages", { id: "browser-video", name: "测试视频摄像", title: "测试视频摄像", tags: ["风格"],
    price: 200, type: "video", isVideoSingle: true, isShow: true });
  await fixture.source.create("packages", { id: "browser-package", name: "测试旅拍套餐", tags: ["风格"],
    price: 100, type: "photo", isShow: true,
    includedItems: [{ type: "album", productId: "browser-photo", name: "测试照片留影", price: 100, quantity: 1 }] });
  // Explicitly synthetic transport for UI verification; database-mode health
  // unlocks the real frontend while all writes stay in the fixture's memory.
  await page.route("**/api/health", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ ok: true, mode: "mysql", data: { ready: true, configured: true } }) }));
  await page.route("**/api/content/photographers", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ rows: photographers }) }));
  await page.route(/\/api\/collection\//, async (route) => {
    const request = route.request();
    if (!["POST", "PUT"].includes(request.method())) return route.continue();
    const parts = new URL(request.url()).pathname.split("/");
    const key = decodeURIComponent(parts[3]), id = parts[4] && decodeURIComponent(parts[4]);
    const body = request.postDataJSON();
    let row;
    if (id) row = await fixture.source.update(key, id, body);
    if (!row) row = await fixture.source.create(key, { ...body, ...(id ? { id } : {}) });
    report.writes.push({ key, id: row.id, recommendedPhotographerId: row.recommendedPhotographerId });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(row) });
  });
  await page.goto(fixture.url);
  await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
  await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator('[data-menu-key="albums"]').waitFor();
  for (const [kind, menu, saveLabel] of [
    ["album", "albums", "保存确定"],
    ["video", "videoSingles", "保存产品"],
    ["package", "packages", "保存套餐"]
  ]) {
    await page.locator(`[data-menu-key="${menu}"]`).click();
    const view = page.locator(`[data-page-key="${menu}"]`);
    await view.waitFor();
    const card = view.locator(kind === "package" ? ".package-card" : ".catalog-card").filter({ hasText: products[kind].title });
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = kind === "package" ? page.locator(".package-dialog") : view;
    const selector = editor.locator("label").filter({ hasText: "推荐摄影师" }).locator(".el-select").first();
    await selector.click();
    const dropdown = page.locator(".el-select-dropdown:visible");
    for (const photographer of photographers) await dropdown.getByText(photographer.name, { exact: true }).waitFor();
    await dropdown.getByText(photographers[0].name, { exact: true }).click();
    await selector.getByText(photographers[0].name, { exact: true }).waitFor();
    await editor.screenshot({ path: path.join(output, `${kind}-editor.png`), animations: "disabled" });
    await editor.getByRole("button", { name: saveLabel, exact: true }).first().click();
    await card.getByText(photographers[0].name, { exact: true }).waitFor();
    assert.equal(report.writes.at(-1).recommendedPhotographerId, photographers[0].id);
    await view.screenshot({ path: path.join(output, `${kind}-list.png`), animations: "disabled" });
    if (kind === "album") {
      await view.getByRole("button", { name: "列表", exact: true }).click();
      await view.locator(".album-table").getByRole("columnheader", { name: "推荐摄影师", exact: true }).waitFor();
      await view.locator(".album-table").getByText(photographers[0].name, { exact: true }).waitFor();
      await view.screenshot({ path: path.join(output, "album-table.png"), animations: "disabled" });
      await view.getByRole("button", { name: "卡片", exact: true }).click();
    }
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    await selector.getByText(photographers[0].name, { exact: true }).waitFor();
    await selector.hover();
    await selector.locator(".el-select__clear").click();
    await editor.getByRole("button", { name: saveLabel, exact: true }).first().click();
    await card.getByText("未设置", { exact: true }).first().waitFor();
    assert.equal(report.writes.at(-1).recommendedPhotographerId, "");
    report.checks.push(`${kind}: two platform names available; selected recommendation persists, returns by name in lists, restores when editing and clears explicitly`);
  }
  assert.deepEqual(report.errors, []);
});
