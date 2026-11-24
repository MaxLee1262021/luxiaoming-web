"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const spotOrder = require("../utils/spot-order.js");
const { planSpotMutation } = require("../../server/lib/spotOrder.cjs");
const contentPolicy = require("../../server/lib/contentPolicy.cjs");

function fixture(options = {}) {
  const messages = [];
  const writes = [];
  const apiCalls = [];
  const computed = (definition) => typeof definition === "function"
    ? { get value() { return definition(); } }
    : { get value() { return definition.get(); }, set value(value) { definition.set(value); } };
  const message = (text) => messages.push(text);
  Object.assign(message, { warning: message, error: message, success: message });
  const Vue = { ref: (value) => ({ value }), reactive: (value) => value, computed, watch() {}, unref: (value) => value?.value ?? value };
  const window = { Vue, ElMessage: message, LXM_APP_PARTS: [], LXM_AUTH: { hasSession: () => false }, LXM_SPOT_ORDER: spotOrder, LXM_CONTENT_ORDER: require("../utils/content-order.js"), LXM_UPLOAD: { ready: () => !options.uploadBusy && options.uploadReady !== false, busy: () => !!options.uploadBusy }, LXM_PAGES: { register(page) { window.page = page; } } };
  window.LXM_AUTH.hasSession = () => true;
  window.LXM_CLOUD_MODE = "mysql";
  window.LXM_API_STATE = { reachable: true };
  window.LXM_CLOUD = {
    async update(key, id, payload) { return { ...clone(payload), id, _id: id }; },
    async create(key, payload) { return { ...clone(payload), id: payload.id || `${key}-test` }; }
  };
  const ctx = {
    computed, ElMessage: message, ElMessageBox: {}, can: () => true, money: (value) => `¥${value}`, log() {}, currentOperatorName: () => "管理员",
    state: { active: "packages", authSource: "server", role: "super", filters: {}, contentScope: {}, trash: [] },
    data: {
      cities: [{ id: "c1", name: "长沙" }, { id: "c2", name: "杭州" }],
      spots: [{ id: "a", name: "点A", cityId: "c1", sort: 1, isShow: true }, { id: "b", name: "点B", cityId: "c1", sort: 2, isShow: true }, { id: "c", name: "点C", cityId: "c2", sort: 1, isShow: true }],
      albums: [{ id: "photo", name: "照片", price: 12.34, spotId: "a", tags: ["测试风格"], isShow: true, cover: "/test.jpg", intro: "拍摄说明", photoCount: 5, retouchCount: 5, makeupIncluded: false }],
      packages: [{ id: "video", name: "短片", type: "video", tags: ["测试风格"], price: 20, spotId: "b", isShow: true }],
      peripherals: [{ id: "gift", name: "相框", price: 5, spotId: "", isShow: true }],
      guides: [{ id: "guide", title: "灵感", spotId: "a", isShow: true }],
      orders: [{ id: "historical", spotId: "a", products: [{ id: "photo", name: "历史照片", price: 10 }] }],
      series: [], samples: [], tagLibrary: [], stories: [], addonServices: []
    },
    spotRows: null,
    productStatus: (row) => row.isShow === false || ["下架", "停用"].includes(row.status) ? "下架" : "上架",
    cityById: (id) => ctx.data.cities.find((row) => String(row.id) === String(id)),
    albumDependencySummary: () => ({}), peripheralDependencySummary: () => ({}), spotDependencySummary: () => ({}),
    seriesBySpot: () => [], packagesByAlbum: () => [], packagesByPeripheral: () => [], packagesReferencingPackage: () => [],
    persistTrashRecord: async (row) => { ctx.state.trash.push(row); return row; },
    pager: () => ({ page: 1 }), contentKeys: ["spots", "albums", "packages", "peripherals", "guides"],
    activeMenu: { value: { label: "内容" } }
  };
  ctx.spotRows = computed(() => ctx.data.spots.filter((row) => !row.deleted));
  const LXM_API = {
    remoteOn: () => false,
    setRemote(value) { apiCalls.push({ action: "setRemote", value }); },
    async loadCollection(key) { apiCalls.push({ action: "loadCollection", key }); return clone(options.remoteRows || ctx.data[key] || []); }
  };
  window.LXM_API = LXM_API;
  const sandbox = { window, console, LXM_API, LXMFormat: { nowText: () => "2026-10-31", dateTime: () => "2026-10-31" } };
  for (const file of ["11-content-lists.js", "12-content-edit.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  }
  function page(relative) {
    vm.runInNewContext(fs.readFileSync(path.join(root, relative), "utf8"), sandbox);
    return window.page.setup(ctx);
  }
  function trackWrites() {
    ctx.persistContentMutation = async (key, row) => { writes.push({ key, row: clone(row) }); return true; };
  }
  return { ctx, page, writes, messages, trackWrites, window, sandbox, options, apiCalls };
}

// Exercise the actual editor persistence helper against the server's catalog
// preparation and validation, without a database or a mocked success shortcut.
function connectPeripheralPolicyServer(f) {
  const rows = clone(f.ctx.data.peripherals), calls = [];
  const source = { async list(key) { return clone(key === "peripherals" ? rows : f.ctx.data[key] || []); } };
  async function save(method, key, id, input) {
    assert.equal(key, "peripherals");
    const body = clone(input);
    calls.push({ method, key, id, body });
    const current = rows.find((row) => String(row.id || row._id) === String(id));
    if (method === "update" && !current) throw Object.assign(new Error("记录不存在"), { status: 404 });
    const context = await contentPolicy.createContentContext(source);
    const patch = await contentPolicy.prepareContentPatch(source, key, body, current || {}, context);
    const saved = { ...current, ...patch, id, _id: id };
    const error = contentPolicy.validateContentPublication(key, saved, current, context, body);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    if (current) Object.assign(current, saved); else rows.push(saved);
    return clone(saved);
  }
  f.window.LXM_CLOUD.update = (key, id, body) => save("update", key, id, body);
  f.window.LXM_CLOUD.create = (key, body) => save("create", key, body.id, body);
  return { rows, calls };
}

test("影像周边编辑页只隐藏历史商品时真实保存链保持纯可见性请求", async () => {
  for (const field of ["isShow", "internalOnly"]) {
    const f = fixture();
    f.ctx.data.peripherals = [{ id: "legacy", name: "历史商品", price: 0, isShow: true }];
    const server = connectPeripheralPolicyServer(f);
    const page = f.page("src/views/content/peripheral/peripheral.js");
    const source = f.ctx.data.peripherals[0];
    page.selectPeripheral(source);
    page.selectedPeripheral.value[field] = field === "isShow" ? false : true;
    assert.equal(await page.saveSelectedPeripheral(), true, f.messages.join("；"));
    assert.equal(server.calls.length, 1);
    assert.ok(server.calls[0].body.isShow === false || server.calls[0].body.internalOnly === true);
    assert.ok(Object.keys(server.calls[0].body).every((key) => ["isShow", "internalOnly", "status", "auditStatus"].includes(key)));
    for (const key of ["stock", "stockQty", "shippingFee", "unit", "cover", "images", "videos", "intro", "description"]) {
      assert.equal(Object.hasOwn(server.calls[0].body, key), false, `${field}: 请求不能补入 ${key}`);
      assert.equal(Object.hasOwn(server.rows[0], key), false, `${field}: 历史记录不能补入 ${key}`);
    }
    assert.equal(source.price, 0);
    assert.equal(page.editorOpen.value, false);
  }
});

test("全量历史周边仅下架时不归一化内容、不新增标签，保留无效旧售价", async () => {
  const f = fixture();
  f.ctx.data.peripherals = [{ id: "legacy", name: "历史商品", price: 0, tags: ["旧标签"], isShow: true }];
  const server = connectPeripheralPolicyServer(f);
  const source = f.ctx.data.peripherals[0], previous = clone(source);
  source.isShow = false;
  assert.equal(await f.ctx.persistContentMutation("peripherals", source, previous), true, f.messages.join("；"));
  assert.equal(server.calls.length, 1);
  assert.deepEqual(server.calls[0].body, { isShow: false });
  assert.equal(source.price, 0);
  assert.equal(Object.hasOwn(source, "stock"), false);
  assert.equal(Object.hasOwn(source, "description"), false);
  assert.deepEqual(f.ctx.data.tagLibrary, []);
});

test("历史影像周边货架下架保留审核元数据，仍禁止借下架改商品资料", async () => {
  const f = fixture();
  f.ctx.data.peripherals = [{ id: "legacy", name: "历史商品", price: 0, status: "上架", isShow: true }];
  const server = connectPeripheralPolicyServer(f);
  const source = f.ctx.data.peripherals[0];
  // The shelf switch updates isShow before invoking the shared change handler.
  source.isShow = false;
  await f.ctx.toggleShelf({ __key: "peripherals", __source: source, name: source.name });
  assert.equal(server.calls.length, 1, f.messages.join("；"));
  const body = server.calls[0].body;
  assert.equal(server.rows[0].isShow, false);
  assert.equal(body.status, "下架");
  assert.equal(body.auditType, "商品下架");
  assert.equal(body.auditSubmitter, "管理员");
  assert.ok(body.auditSubmitAt);
  assert.equal(body.auditReason, "商品下架");
  assert.equal(Object.hasOwn(body, "price"), false);
  for (const field of ["stock", "shippingFee", "unit", "intro", "description"]) assert.equal(Object.hasOwn(server.rows[0], field), false, field);

  const bad = fixture();
  bad.ctx.data.peripherals = [{ id: "legacy", name: "历史商品", price: 0, status: "上架", isShow: true }];
  const rejecting = connectPeripheralPolicyServer(bad);
  const current = bad.ctx.data.peripherals[0], previous = clone(current);
  Object.assign(current, { isShow: false, status: "下架", name: "试图绕过必填的新名称" });
  bad.ctx.markProductAudit(current, "商品下架");
  assert.equal(await bad.ctx.persistContentMutation("peripherals", current, previous), false);
  assert.equal(rejecting.calls.length, 1, "必须送普通资料修改到服务端校验");
  assert.equal(rejecting.calls[0].body.name, "试图绕过必填的新名称");
  assert.equal(rejecting.rows[0].name, "历史商品");
  assert.equal(rejecting.rows[0].isShow, true);
  assert.equal(current.name, "历史商品");
});

test("视频作为唯一素材的新周边经真实保存链通过并保留零库存包邮", async () => {
  const f = fixture();
  f.ctx.data.peripherals = [];
  const server = connectPeripheralPolicyServer(f);
  const page = f.page("src/views/content/peripheral/peripheral.js");
  page.createPeripheral();
  Object.assign(page.selectedPeripheral.value, {
    name: "视频展示商品", price: 29.9, stock: 0, shippingFee: 0,
    intro: "现货商品说明", videos: ["/api/media/peripheral-video"]
  });
  assert.equal(await page.saveSelectedPeripheral(), true, f.messages.join("；"));
  assert.equal(server.calls.at(-1).method, "create");
  assert.equal(server.rows.length, 1);
  assert.deepEqual(server.rows[0].videos, ["/api/media/peripheral-video"]);
  assert.equal(server.rows[0].stock, 0);
  assert.equal(server.rows[0].shippingFee, 0);
  assert.equal(server.rows[0].cover, "");
});

test("影像周边隐藏时同时修改资料仍须补齐必填信息且不发保存请求", async () => {
  const f = fixture();
  f.ctx.data.peripherals = [{ id: "legacy", name: "历史商品", price: 20, isShow: true }];
  const server = connectPeripheralPolicyServer(f);
  const page = f.page("src/views/content/peripheral/peripheral.js");
  const source = f.ctx.data.peripherals[0];
  page.selectPeripheral(source);
  Object.assign(page.selectedPeripheral.value, { isShow: false, name: "未补齐配置的新名称" });
  assert.equal(await page.saveSelectedPeripheral(), false);
  assert.equal(server.calls.length, 0);
  assert.equal(server.rows[0].name, "历史商品");
  assert.equal(source.name, "历史商品");
  assert.equal(source.isShow, true);
  assert.equal(page.editorOpen.value, true);
  assert.match(f.messages.at(-1), /运费/);
});

test("新增打卡点上传封面后才允许展示保存，图片别名保持一致", async () => {
  const f = fixture();
  f.ctx.openContentQuick("spots");
  const draft = f.ctx.state.editContent;
  assert.equal(draft.cover, "");
  Object.assign(draft, { name: "江畔打卡点", address: "湘江中路", intro: "沿江拍摄", tags: ["江景"] });
  const count = f.ctx.data.spots.length;
  await f.ctx.saveContent();
  assert.equal(f.ctx.data.spots.length, count);
  assert.match(f.messages.at(-1), /上传.*封面/);
  let uploaded;
  f.window.LXM_UPLOAD.upload = async (file, options) => { uploaded = options; options.onUploaded({ url: "/api/media/spot-cover" }); };
  const input = { files: [{ name: "cover.png", type: "image/png", size: 100 }], value: "cover.png" };
  f.ctx.uploadContentCover({ target: input });
  assert.equal(input.value, "");
  assert.equal(uploaded.purpose, "content");
  assert.equal(uploaded.collection, "spots");
  assert.equal(uploaded.imagesOnly, true);
  assert.equal(uploaded.recordId, undefined);
  assert.equal(draft.cover, "/api/media/spot-cover");
  await f.ctx.saveContent();
  const saved = f.ctx.data.spots.find((row) => row.name === draft.name);
  assert.ok(saved, f.messages.join("；"));
  for (const field of ["cover", "coverUrl", "coverImage", "image"]) assert.equal(saved[field], draft.cover);
  assert.equal(saved.description, draft.intro);
});

test("旧打卡点封面回填草稿，替换上传与异步完成只修改原草稿", async () => {
  for (const alias of ["coverUrl", "coverImage", "image"]) {
    const f = fixture();
    const source = f.ctx.data.spots[0];
    Object.assign(source, { cover: { invalid: true }, [alias]: "/old.jpg", description: "旧介绍" });
    f.ctx.state.active = "spots";
    f.ctx.openContent(source);
    const draft = f.ctx.state.editContent;
    assert.equal(draft.cover, "/old.jpg");
    assert.equal(draft.intro, "旧介绍");
    let options;
    f.window.LXM_UPLOAD.upload = (file, value) => { options = value; };
    f.ctx.uploadContentCover({ target: { files: [{ name: "new.png" }], value: "new.png" } });
    assert.equal(options.recordId, source.id);
    f.ctx.openContent(f.ctx.data.spots[1]);
    options.onUploaded({ url: "/api/media/replacement" });
    assert.equal(draft.cover, "/api/media/replacement");
    assert.equal(source[alias], "/old.jpg");
    assert.equal(f.ctx.state.editContent.cover, "");
    f.ctx.state.editContent = draft;
    Object.assign(draft, { address: "测试地址", tags: ["江景"], tag: "推荐" });
    await f.ctx.saveContent();
    for (const field of ["cover", "coverUrl", "coverImage", "image"]) assert.equal(source[field], "/api/media/replacement");
  }
});

test("封面清空不从旧字段复活，上传未完成时阻止保存", async () => {
  const f = fixture();
  const source = f.ctx.data.spots[0];
  Object.assign(source, { cover: "/old.jpg", image: "/stale.jpg", coverUrl: "/stale.jpg", intro: "介绍", address: "地址", tag: "推荐", tags: ["江景"] });
  f.ctx.state.active = "spots";
  f.ctx.openContent(source);
  f.window.LXM_UPLOAD.temporary = (value) => /^(data:|blob:)/.test(value);
  f.ctx.applyCoverUrl("");
  await f.ctx.saveContent();
  for (const field of ["cover", "coverUrl", "coverImage", "image"]) assert.equal(source[field], "");
  f.ctx.openContent(source);
  f.ctx.applyCoverUrl("/replacement.jpg");
  f.window.LXM_UPLOAD.ready = () => false;
  await f.ctx.saveContent();
  assert.equal(source.cover, "");
  f.window.LXM_UPLOAD.ready = () => true;
  await f.ctx.saveContent();
  assert.equal(source.cover, "/replacement.jpg");
});

test("照片商品新增不继承风格点位，单价格、三态服务和模板随实际保存落库", async () => {
  const f = fixture();
  f.ctx.data.series.push({ id: "garden", name: "春日清新系列", spotId: "a" });
  f.ctx.state.active = "albums";
  f.ctx.openContent();
  const draft = f.ctx.state.editContent;
  assert.equal(draft.spotId, "");
  assert.equal(draft.spotBindingExplicit, true);
  assert.equal(draft.cover, "");
  Object.assign(draft, { name: "春日花园照片单品", photoCount: 6, price: 699, retouchMode: "included", retouchCount: 99, makeupIncluded: true, tags: ["清新"], originalPrice: 999, specialPrice: 599 });
  f.ctx.applyAlbumShootingTemplate(draft);
  f.ctx.addAlbumPhoto(draft, "/cover.jpg");
  await f.ctx.saveContent();
  const saved = f.ctx.data.albums.find((row) => row.name === draft.name);
  assert.ok(saved, f.messages.join("；"));
  assert.equal(saved.spotId, "");
  assert.equal(saved.seriesName, "春日清新系列");
  assert.equal(saved.photoCount, 1);
  assert.equal(saved.retouchMode, "included");
  assert.equal(saved.retouchCount, 0);
  assert.equal(saved.makeupIncluded, true);
  assert.equal(saved.price, 699);
  assert.ok(!("originalPrice" in saved) && !("specialPrice" in saved));
  assert.equal(saved.shootingNotes, saved.intro);
  assert.ok(f.ctx.data.tagLibrary.some((row) => row.name === "清新"));
});

test("照片删除、替换和首图选择自动更新照片张数，也不重新混入旧素材", () => {
  const f = fixture();
  const picks = [];
  f.window.LXM_UPLOAD.pick = (options) => picks.push(options);
  f.ctx.data.samples.push({ id: "legacy", albumId: "photo", url: "/legacy.jpg", type: "photo" });
  const row = { id: "photo", cover: "/cover.jpg", photoCount: 6 };
  assert.deepEqual(Array.from(f.ctx.albumPhotoUrls(row)), ["/cover.jpg", "/legacy.jpg"]);
  f.ctx.removeAlbumPhoto(row, "/legacy.jpg");
  assert.deepEqual(Array.from(f.ctx.albumPhotoUrls(row)), ["/cover.jpg"]);
  f.ctx.addAlbumPhoto(row, "/second.jpg");
  f.ctx.setAlbumCover(row, "/second.jpg");
  assert.equal(f.ctx.albumPhotoUrls(row)[0], "/second.jpg");
  f.ctx.replaceAlbumPhoto(row, "/second.jpg");
  picks[0].onUploaded({ url: "/new.jpg" });
  assert.equal(row.cover, "/new.jpg");
  f.ctx.removeAlbumPhoto(row, "/new.jpg");
  assert.equal(row.cover, "/cover.jpg");
  f.ctx.removeAlbumPhoto(row, "/cover.jpg");
  assert.equal(row.cover, "");
  assert.deepEqual(Array.from(f.ctx.albumPhotoUrls(row)), []);
  assert.equal(row.photoCount, 0);
  // Upload completion uses the editor captured when the picker opened.
  f.ctx.reactive = (value) => value;
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/18-files.js"), "utf8"), f.sandbox);
  const files = f.window.LXM_APP_PARTS.pop()(f.ctx);
  files.contentFile(row, "sampleUrls", "albums");
  assert.equal(picks[1].multiple, true);
  f.ctx.state.editContent = { id: "other", cover: "/keep.jpg" };
  picks[1].onUploaded({ url: "/upload.jpg" });
  assert.equal(row.cover, "/upload.jpg");
  assert.equal(f.ctx.state.editContent.cover, "/keep.jpg");
  const legacy = { id: "legacy-cover", coverImage: "/old-cover.jpg", sampleUrls: [] };
  assert.deepEqual(Array.from(f.ctx.albumPhotoUrls(legacy)), [], "显式空照片数组不能从旧首图字段恢复图片");
  f.ctx.removeAlbumPhoto(legacy, "/old-cover.jpg");
  assert.equal(legacy.coverImage, "");
  assert.deepEqual(Array.from(f.ctx.albumPhotoUrls(legacy)), []);
});

test("照片创建默认隐藏且不关联打卡点，九张照片统计、首图和批量删除随保存生效", async () => {
  const f = fixture();
  const page = f.page("src/views/content/album/album.js");
  const initialCount = f.ctx.data.albums.length;
  page.createAlbum();
  const draft = page.selectedAlbum.value;
  assert.equal(draft.isShow, false);
  assert.equal(draft.spotId, "");
  assert.deepEqual(Array.from(draft.spotIds), []);
  assert.equal(draft.spotBindingExplicit, true);
  assert.equal(draft.photoCount, 0);
  assert.equal(page.photoCount.value, 0);
  assert.equal(page.allPhotosSelected.value, false);
  Object.assign(draft, { name: "九张照片商品", tags: ["测试标签"], price: 499, retouchMode: "count", retouchCount: 3, makeupIncluded: true });
  const photos = Array.from({ length: 9 }, (_, index) => `/photo-${index + 1}.jpg`);
  photos.forEach((url) => f.ctx.addAlbumPhoto(draft, url));
  assert.equal(draft.photoCount, 9);
  assert.equal(page.photoCount.value, 9);
  assert.equal(draft.cover, photos[0]);
  f.ctx.setAlbumCover(draft, photos[8]);
  page.togglePhotoSelection(photos[8], true);
  page.togglePhotoSelection(photos[2], true);
  page.togglePhotoSelection(photos[5], true);
  page.togglePhotoSelection(photos[5], true);
  assert.equal(page.selectedPhotoUrls.value.length, 3, "重复选中不会导致重复删除");
  page.removeSelectedPhotos();
  assert.equal(page.photoCount.value, 6);
  assert.equal(draft.photoCount, 6);
  assert.equal(draft.cover, photos[0], "批量删除首图时自动使用剩余第一张");
  const remaining = photos.filter((url) => ![photos[8], photos[2], photos[5]].includes(url));
  assert.deepEqual(Array.from(f.ctx.albumPhotoUrls(draft)), remaining);
  assert.equal(page.selectedPhotoUrls.value.length, 0);
  page.toggleAllPhotos(true);
  assert.equal(page.allPhotosSelected.value, true);
  page.togglePhotoSelection(photos[1], false);
  assert.equal(page.allPhotosSelected.value, false);
  page.toggleAllPhotos(false);
  assert.equal(page.selectedPhotoUrls.value.length, 0);
  assert.equal(await page.saveSelectedAlbum(), true, f.messages.join("；"));
  const saved = f.ctx.data.albums[0];
  assert.equal(f.ctx.data.albums.length, initialCount + 1);
  assert.equal(page.listSource.value[0].id, saved.id);
  assert.equal(saved.name, "九张照片商品");
  assert.equal(saved.photoCount, 6);
  assert.deepEqual(Array.from(saved.sampleUrls), remaining);
  assert.equal(saved.price, 499);
  assert.equal(saved.retouchCount, 3);
  assert.equal(saved.makeupIncluded, true);
  assert.equal(saved.isShow, false);
  assert.equal(saved.spotId, "");
  for (const alias of ["cover", "coverImage", "coverUrl", "image"]) assert.equal(saved[alias], photos[0]);
  assert.equal(page.editorOpen.value, false);
  assert.equal(page.creating.value, false);
  const snapshot = clone(saved);
  assert.equal(await page.refreshFromServer(), true);
  assert.deepEqual(clone(f.ctx.data.albums.find((row) => row.id === saved.id)), snapshot);
  assert.equal(page.photoCount.value, 6);
  assert.equal(page.selectedAlbum.value.cover, photos[0]);
});

test("照片全部删除后统计归零且禁止保存，原商品保持不变", async () => {
  const f = fixture();
  const page = f.page("src/views/content/album/album.js");
  const source = f.ctx.data.albums[0];
  page.selectAlbum(source);
  const snapshot = clone(source);
  page.toggleAllPhotos(true);
  assert.equal(page.allPhotosSelected.value, true);
  page.removeSelectedPhotos();
  assert.equal(page.photoCount.value, 0);
  assert.equal(page.selectedAlbum.value.photoCount, 0);
  assert.equal(page.selectedAlbum.value.cover, "");
  assert.equal(page.allPhotosSelected.value, false);
  assert.equal(await page.saveSelectedAlbum(), undefined);
  assert.match(f.messages.at(-1), /至少上传一张商品照片/);
  assert.deepEqual(clone(source), snapshot);
  assert.equal(page.editorOpen.value, true);
});

test("照片自定义风格与标签保存后可复用，重新编辑与单张删除保持数据一致", async () => {
  const f = fixture();
  f.ctx.data.albums[0].tags = ["历史活动"];
  f.ctx.data.tagLibrary.push({ id: "op", name: "节日限定", category: "运营", status: "启用" });
  const page = f.page("src/views/content/album/album.js");
  for (const tag of ["主推", "爆款", "新品", "历史活动", "节日限定"]) assert.ok(page.albumTagOptions.value.includes(tag), tag);
  assert.deepEqual(Array.from(page.albumSeriesOptions.value), [], "没有数据库风格时不注入示例风格");
  page.createAlbum();
  const draft = page.selectedAlbum.value;
  Object.assign(draft, { name: "自定义系列商品", seriesId: "暮色胶片", tags: ["新品", " 旅途限定 ", "新品"], price: 199, isShow: true });
  page.changeAlbumSeries(draft.seriesId);
  f.ctx.addAlbumPhoto(draft, "/custom-first.jpg");
  f.ctx.addAlbumPhoto(draft, "/custom-second.jpg");
  assert.equal(await page.saveSelectedAlbum(), true, f.messages.join("；"));
  const saved = f.ctx.data.albums[0];
  assert.equal(saved.seriesId, "");
  assert.equal(saved.seriesName, "暮色胶片");
  assert.deepEqual(Array.from(saved.tags), ["新品", "旅途限定"]);
  assert.ok(f.ctx.data.tagLibrary.some((row) => row.name === "旅途限定"));
  assert.equal(page.albumSeriesLabel(saved), "暮色胶片");
  page.selectAlbum(saved);
  assert.equal(page.selectedAlbum.value.seriesId, "暮色胶片");
  page.togglePhotoSelection("/custom-second.jpg", true);
  page.removePhoto("/custom-second.jpg");
  assert.equal(page.selectedPhotoUrls.value.length, 0);
  assert.equal(page.photoCount.value, 1);
  assert.equal(saved.photoCount, 2, "编辑草稿不会提前修改列表商品");
  assert.equal(await page.saveSelectedAlbum(), true, f.messages.join("；"));
  assert.equal(f.ctx.data.albums.length, 2, "编辑保存不会重复创建商品");
  assert.equal(saved.photoCount, 1);
  assert.deepEqual(Array.from(saved.sampleUrls), ["/custom-first.jpg"]);
  const reloaded = f.page("src/views/content/album/album.js");
  reloaded.selectAlbum(saved);
  assert.equal(reloaded.selectedAlbum.value.seriesId, "暮色胶片");
  assert.equal(reloaded.photoCount.value, 1);
  reloaded.createAlbum();
  assert.ok(reloaded.albumSeriesOptions.value.some((option) => option.value === "暮色胶片" && option.label === "暮色胶片"));
  assert.ok(reloaded.albumTagOptions.value.includes("旅途限定"));
  assert.equal(reloaded.selectedAlbum.value.isShow, false);
  assert.equal(reloaded.selectedAlbum.value.spotId, "");
});

test("照片选择已有风格保留风格ID且不会继承其打卡点", async () => {
  const f = fixture();
  f.ctx.data.series.push({ id: "garden", name: "春日清新系列", spotId: "a" });
  const page = f.page("src/views/content/album/album.js");
  page.createAlbum();
  const draft = page.selectedAlbum.value;
  Object.assign(draft, { name: "清新系列商品", seriesId: "garden", tags: ["测试标签"], price: 299, isShow: true });
  page.changeAlbumSeries("garden");
  f.ctx.addAlbumPhoto(draft, "/garden.jpg");
  assert.equal(draft.seriesName, "春日清新系列");
  assert.equal(draft.spotId, "");
  assert.equal(await page.saveSelectedAlbum(), true, f.messages.join("；"));
  const saved = f.ctx.data.albums[0];
  assert.equal(saved.seriesId, "garden");
  assert.equal(saved.seriesName, "春日清新系列");
  assert.equal(saved.spotId, "");
  assert.deepEqual(Array.from(saved.spotIds), []);
  assert.equal(page.previewVisible(saved), true);
});

test("照片在旧筛选条件下创建成功后仍立即出现在列表", async () => {
  const f = fixture();
  Object.assign(f.ctx.state.filters, { keyword: "不匹配任何新商品", contentSpotId: "b", contentSeriesId: "旧系列", contentStatus: "上架" });
  const page = f.page("src/views/content/album/album.js");
  assert.equal(page.listSource.value.length, 0);
  page.createAlbum();
  page.selectedAlbum.value.name = "筛选后新增照片";
  page.selectedAlbum.value.tags = ["测试标签"];
  f.ctx.addAlbumPhoto(page.selectedAlbum.value, "/filtered-create.jpg");
  assert.equal(await page.saveSelectedAlbum(), true, f.messages.join("；"));
  const saved = f.ctx.data.albums[0];
  assert.equal(saved.name, "筛选后新增照片");
  assert.equal(page.listSource.value[0].id, saved.id);
  assert.equal(page.selectedAlbum.value.id, saved.id);
  for (const field of ["keyword", "contentSpotId", "contentSeriesId", "contentStatus"]) assert.equal(f.ctx.state.filters[field], "");
});

test("照片风格筛选同时匹配已有系列ID和同名自定义系列", () => {
  const f = fixture();
  f.ctx.data.series.push({ id: "summer", name: "清新夏日" });
  Object.assign(f.ctx.data.albums[0], { seriesId: "summer", seriesName: "清新夏日" });
  f.ctx.data.albums.push(
    { id: "custom-summer", name: "自定义夏日商品", seriesId: "", seriesName: "清新夏日", isShow: false },
    { id: "custom-other", name: "自定义胶片商品", seriesId: "", seriesName: "复古胶片", isShow: false }
  );
  f.ctx.state.filters.contentSeriesId = "summer";
  assert.deepEqual(Array.from(f.ctx.albumRows.value, (row) => row.id), ["custom-summer", "photo"]);
});

test("照片上传期间阻止离开、还原、切换、修改选择与保存，文件夹参数完整转发", async () => {
  const f = fixture();
  const picks = [];
  f.ctx.contentFile = (...args) => picks.push(args);
  f.trackWrites();
  const page = f.page("src/views/content/album/album.js");
  page.createAlbum();
  const draft = page.selectedAlbum.value;
  draft.name = "上传中的商品";
  draft.tags = ["测试标签"];
  f.ctx.addAlbumPhoto(draft, "/upload-one.jpg");
  f.ctx.addAlbumPhoto(draft, "/upload-two.jpg");
  page.togglePhotoSelection("/upload-one.jpg", true);
  page.uploadAlbumPhotos();
  page.uploadAlbumPhotos(true);
  assert.equal(picks.length, 2);
  assert.equal(picks[0][0], draft);
  assert.deepEqual(picks[0].slice(1), ["sampleUrls", "albums", false, true, false]);
  assert.deepEqual(picks[1].slice(1), ["sampleUrls", "albums", false, true, true]);
  f.options.uploadBusy = true;
  assert.equal(page.photoUploadBusy.value, true);
  page.createAlbum();
  page.closeEditor();
  page.resetAlbumDraft();
  page.selectAlbum(f.ctx.data.albums[0]);
  page.togglePhotoSelection("/upload-two.jpg", true);
  page.toggleAllPhotos(true);
  page.removePhoto("/upload-two.jpg");
  page.removeSelectedPhotos();
  page.changeAlbumSeries("上传期间不变");
  page.uploadAlbumPhotos(true);
  page.toggleRemote();
  assert.equal(await page.saveSelectedAlbum(), false);
  assert.equal(await page.refreshFromServer(), false);
  assert.equal(page.selectedAlbum.value, draft);
  assert.equal(page.editorOpen.value, true);
  assert.equal(page.creating.value, true);
  assert.equal(page.photoCount.value, 2);
  assert.deepEqual(Array.from(page.selectedPhotoUrls.value), ["/upload-one.jpg"]);
  assert.equal(draft.seriesName, "");
  assert.equal(picks.length, 2);
  assert.equal(f.writes.length, 0);
  assert.equal(f.apiCalls.length, 0);
  f.options.uploadBusy = false;
  assert.equal(await page.saveSelectedAlbum(), true);
  assert.equal(f.writes.length, 1);
});

test("点位页快捷新增照片商品使用商品草稿，拍摄说明清空后不复活旧简介", async () => {
  const f = fixture();
  f.ctx.state.active = "spots";
  f.ctx.openContentQuick("albums");
  assert.equal(f.ctx.state.editContent.__key, "albums");
  assert.equal(f.ctx.state.editContent.spotId, "");
  f.ctx.openContentQuick("albums", { spotId: "b", seriesId: "linked" });
  assert.equal(f.ctx.state.editContent.__key, "albums");
  assert.equal(f.ctx.state.editContent.spotId, "b");
  assert.equal(f.ctx.state.active, "spots");
  f.ctx.openContent(f.ctx.data.albums[0]);
  f.ctx.state.editContent.shootingNotes = "";
  await f.ctx.saveContent();
  assert.equal(f.ctx.data.albums[0].shootingNotes, "");
  assert.equal(f.ctx.data.albums[0].intro, "");
});

test("照片服务自定义文案保存、重新编辑和增删预览照片时保持一致", async () => {
  const f = fixture();
  const page = f.page("src/views/content/album/album.js");
  page.createAlbum();
  const draft = page.selectedAlbum.value;
  Object.assign(draft, { name: "自由交付照片", tags: ["留影"], price: 198, photoCountText: " 底片全送 ", retouchText: " 像素蛋糕，AI精修9张，PS精修3张 ", makeupText: " 含简妆，自备服装 " });
  f.ctx.addAlbumPhoto(draft, "/first.jpg");
  f.ctx.addAlbumPhoto(draft, "/second.jpg");
  page.removePhoto("/first.jpg");
  assert.equal(await page.saveSelectedAlbum(), true, f.messages.join("；"));
  const saved = f.ctx.data.albums[0];
  assert.equal(saved.photoCount, 1);
  assert.equal(saved.photoCountText, "底片全送");
  assert.equal(saved.retouchText, "像素蛋糕，AI精修9张，PS精修3张");
  assert.equal(saved.makeupText, "含简妆，自备服装");
  assert.equal(saved.price, 198);
  page.selectAlbum(saved);
  assert.equal(page.selectedAlbum.value.photoCountText, "底片全送");
  assert.equal(page.photoCountLabel(saved), "底片全送");
  assert.equal(page.retouchLabel(saved), "像素蛋糕，AI精修9张，PS精修3张");
  assert.equal(page.makeupLabel(saved), "含简妆，自备服装");
  f.ctx.addAlbumPhoto(page.selectedAlbum.value, "/third.jpg");
  assert.equal(page.photoCount.value, 2);
  assert.equal(await page.saveSelectedAlbum(), true, f.messages.join("；"));
  assert.equal(saved.photoCountText, "底片全送");
  assert.equal(saved.photoCount, 2);
});

test("旧照片服务回填原文案，清空自定义时回退原数量和妆造状态", () => {
  const f = fixture();
  const page = f.page("src/views/content/album/album.js");
  const saved = f.ctx.data.albums[0];
  Object.assign(saved, { retouchCount: 3, makeupIncluded: true });
  page.selectAlbum(saved);
  assert.equal(page.selectedAlbum.value.photoCountText, "5 张照片");
  assert.equal(page.selectedAlbum.value.retouchText, "修图 3 张");
  assert.equal(page.selectedAlbum.value.makeupText, "包含");
  const cleared = { ...saved, photoCountText: " ", retouchText: "", makeupText: null };
  assert.equal(page.photoCountLabel(cleared), "5 张照片");
  assert.equal(page.retouchLabel(cleared), "修图 3 张");
  assert.equal(page.makeupLabel(cleared), "包含");
});

test("快捷照片编辑保存自定义文案，隐藏的旧修图张数不阻塞自定义修图", async () => {
  const f = fixture();
  f.ctx.state.active = "spots";
  f.ctx.openContentQuick("albums");
  const draft = f.ctx.state.editContent;
  assert.equal(draft.photoCountText, "", "新建时应等待输入，不能锁定为零张照片");
  Object.assign(draft, { name: "交付照片", tags: ["留影"], price: 99, photoCountText: "交付9张", retouchText: "修9张", makeupText: "自备妆造", retouchMode: "count", retouchCount: 0 });
  f.ctx.addAlbumPhoto(draft, "/preview.jpg");
  f.ctx.applyAlbumShootingTemplate(draft);
  await f.ctx.saveContent();
  const saved = f.ctx.data.albums.find(row => row.name === "交付照片");
  assert.ok(saved, f.messages.join("；"));
  assert.equal(saved.photoCountText, "交付9张");
  assert.equal(saved.retouchText, "修9张");
  assert.equal(saved.makeupText, "自备妆造");
  f.ctx.openContent(saved);
  assert.equal(f.ctx.state.editContent.photoCountText, "交付9张");
  assert.equal(f.ctx.state.editContent.retouchText, "修9张");
});

test("照片自定义服务文案超长时不保存且保留编辑草稿", async () => {
  for (const field of ["photoCountText", "retouchText", "makeupText"]) {
    const f = fixture();
    f.trackWrites();
    const page = f.page("src/views/content/album/album.js");
    page.selectAlbum(f.ctx.data.albums[0]);
    page.selectedAlbum.value[field] = "字".repeat(161);
    await page.saveSelectedAlbum();
    assert.equal(f.writes.length, 0, field);
    assert.match(f.messages.at(-1), /不能超过160个字符/);
    assert.equal(page.editorOpen.value, true);
    assert.equal(page.selectedAlbum.value[field].length, 161);
  }
});

test("照片商品修图可明确不包含，按张数时拒绝零和小数", async () => {
  const f = fixture();
  const row = { ...f.ctx.data.albums[0], retouchMode: "excluded", retouchCount: 9 };
  await f.ctx.persistContentMutation("albums", row, { ...row });
  assert.equal(row.retouchCount, 0);
  for (const retouchCount of [0, 1.5]) {
    assert.match(f.ctx.validateContentPublishing("albums", { ...row, retouchMode: "count", retouchCount }, row), /修图张数/);
  }
  assert.match(f.ctx.validateContentPublishing("albums", { ...row, photoCount: 1.5 }, row), /照片张数/);
});

test("组合商品数量与单价计算原价，手改售价保留，编辑明细不会丢失", async () => {
  const f = fixture();
  f.trackWrites();
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  page.form.value.tagText = "测试标签";
  page.form.value.name = "跨点位套餐";
  page.addIncludedItem();
  Object.assign(page.form.value.includedItems[0], { productId: "photo", quantity: 3 });
  page.syncIncludedItem(page.form.value.includedItems[0]);
  assert.equal(page.form.value.originalPrice, 37.02);
  assert.equal(page.form.value.price, 37.02);
  page.form.value.price = 30;
  page.setManualPrice();
  page.addIncludedItem();
  Object.assign(page.form.value.includedItems[1], { type: "video", productId: "video", quantity: 2 });
  page.syncIncludedItem(page.form.value.includedItems[1]);
  assert.equal(page.form.value.originalPrice, 77.02);
  assert.equal(page.form.value.price, 30);
  await page.saveForm();
  const saved = f.ctx.data.packages.find((row) => row.name === "跨点位套餐");
  assert.deepEqual(Array.from(saved.spotIds), ["a", "b"]);
  assert.equal(saved.includedItems.length, 2);
  assert.equal(saved.items[0].quantity, 3);
  page.openEdit(saved);
  page.removeIncludedItem(1);
  page.addIncludedItem();
  Object.assign(page.form.value.includedItems[1], { type: "peripheral", productId: "gift", quantity: 1 });
  page.syncIncludedItem(page.form.value.includedItems[1]);
  await page.saveForm();
  assert.equal(saved.includedItems[1].productId, "gift");
  assert.equal(saved.originalPrice, 42.02);
  assert.equal(saved.price, 30);
  assert.deepEqual(Array.from(saved.spotIds), ["a"]);
});

test("套餐按城市和打卡点逐级选择商品，切换来源保留已选商品与独立周边选择", () => {
  const f = fixture();
  f.ctx.data.albums.push({ id: "hz-photo", name: "杭州留影", price: 88, spotId: "c", isShow: true });
  f.ctx.data.spots.push({ id: "deleted-spot", name: "已删除点位", cityId: "c1", deleted: true });
  f.ctx.data.albums.push({ id: "deleted-photo", name: "已删除商品", price: 9, spotId: "a", deleted: true });
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  Object.assign(page.picker, { city: "c1", spotId: "a", productKey: "album:photo", peripheralId: "gift" });
  page.addSpotProduct();
  assert.equal(page.form.value.includedItems.length, 1);
  assert.equal(page.form.value.includedItems[0].productId, "photo");
  assert.equal(page.form.value.originalPrice, 12.34);
  assert.deepEqual(Array.from(page.pickerSpots.value, (spot) => spot.id), ["a", "b"]);
  assert.ok(page.spotProductOptions.value.some((option) => option.id === "photo"));
  assert.equal(page.spotProductOptions.value.some((option) => ["hz-photo", "deleted-photo"].includes(option.id)), false);

  page.picker.city = "c2";
  page.changePickerCity();
  assert.equal(page.picker.spotId, "");
  assert.equal(page.picker.productKey, "");
  assert.equal(page.picker.peripheralId, "gift");
  assert.deepEqual(Array.from(page.pickerSpots.value, (spot) => spot.id), ["c"]);
  page.picker.spotId = "c";
  page.changePickerSpot();
  assert.equal(page.picker.productKey, "");
  assert.equal(page.form.value.includedItems[0].productId, "photo", "切换来源不移除已选商品");
  assert.ok(page.spotProductOptions.value.some((option) => option.id === "hz-photo"));
  assert.equal(page.spotProductOptions.value.some((option) => option.id === "photo"), false);
  assert.ok(page.peripheralOptions.value.some((option) => option.id === "gift"));
  page.addPeripheralProduct();
  assert.deepEqual(Array.from(page.form.value.includedItems, (item) => item.type), ["album", "peripheral"]);
  assert.equal(page.form.value.originalPrice, 17.34);
});

test("套餐添加商品去重但保留数量，周边加入与恢复自动价均按实际数量计算", async () => {
  const f = fixture();
  f.trackWrites();
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  page.form.value.tagText = "测试标签";
  page.form.value.name = "演示交互组合套餐";
  Object.assign(page.picker, { city: "c1", spotId: "a", productKey: "album:photo", peripheralId: "gift" });
  page.addSpotProduct();
  page.form.value.includedItems[0].quantity = 3;
  page.recalculatePrice();
  page.picker.productKey = "album:photo";
  page.addSpotProduct();
  assert.equal(page.form.value.includedItems.length, 1);
  assert.equal(page.form.value.includedItems[0].quantity, 3);
  assert.equal(page.form.value.originalPrice, 37.02);
  page.form.value.price = 30;
  page.setManualPrice();
  page.picker.peripheralId = "gift";
  page.addPeripheralProduct();
  page.picker.peripheralId = "gift";
  page.addPeripheralProduct();
  assert.equal(page.form.value.includedItems.length, 2);
  assert.equal(page.form.value.originalPrice, 42.02);
  assert.equal(page.form.value.price, 30);
  page.recalculatePrice(true);
  assert.equal(page.form.value.price, 42.02);
  page.form.value.price = 35;
  page.setManualPrice();
  await page.saveForm();
  const saved = f.ctx.data.packages.find((row) => row.name === "演示交互组合套餐");
  assert.ok(saved, f.messages.join("；"));
  assert.equal(saved.price, 35);
  assert.equal(saved.originalPrice, 42.02);
  assert.equal(saved.items[0].quantity, 3);
  assert.equal(saved.includedItems[0].target.albumId, "photo");
  assert.equal(saved.includedItems[1].target.peripheralId, "gift");
  page.openEdit(saved);
  assert.equal(page.form.value.includedItems[0].quantity, 3);
  assert.equal(page.form.value.price, 35);
});

test("套餐标签支持自定义去重、预设切换和移除，保存后搜索包含组合商品名称", async () => {
  const f = fixture();
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  page.form.value.name = "假日组合";
  page.tagInput.value = "  周末限定  ";
  page.addTag();
  assert.deepEqual(Array.from(page.formTags.value), ["周末限定"]);
  page.tagInput.value = "周末限定";
  page.addTag();
  assert.deepEqual(Array.from(page.formTags.value), ["周末限定"]);
  page.addTag("爆款");
  assert.deepEqual(Array.from(page.formTags.value), ["周末限定", "爆款"]);
  page.addTag("爆款");
  assert.deepEqual(Array.from(page.formTags.value), ["周末限定"]);
  page.addTag("新品");
  page.removeTag(0);
  assert.deepEqual(Array.from(page.formTags.value), ["新品"]);
  Object.assign(page.picker, { city: "c1", spotId: "b", productKey: "video:video" });
  page.addSpotProduct();
  await page.saveForm();
  const saved = f.ctx.data.packages.find((row) => row.name === "假日组合");
  assert.ok(saved, f.messages.join("；"));
  assert.deepEqual(Array.from(saved.tags), ["新品"]);
  page.keyword.value = "短片";
  assert.deepEqual(Array.from(page.tableRows.value, (row) => row.id), [saved.id]);
  page.keyword.value = "不存在的组合商品";
  assert.equal(page.tableRows.value.length, 0);
});

test("套餐查看权限禁止保存和状态写入，关联隐藏状态不覆盖手动显示意图", async () => {
  const f = fixture();
  f.trackWrites();
  f.ctx.data.albums[0].isShow = false;
  const source = { id: "bundle-view", name: "只读组合", type: "photo", isShow: true, status: "上架", includedItems: [{ type: "album", productId: "photo", quantity: 1 }] };
  f.ctx.data.packages.push(source);
  f.ctx.can = () => false;
  const page = f.page("src/views/content/package/package.js");
  assert.equal(page.statusText(source), "已下架");
  assert.equal(page.manualVisible(source), true);
  page.openEdit(source);
  assert.equal(page.form.value.isShow, true);
  page.form.value.name = "不应保存的更名";
  await page.saveForm();
  await page.toggleVisible(source);
  await page.toggleMainPush(source);
  assert.equal(f.writes.length, 0);
  assert.equal(source.name, "只读组合");
  assert.equal(source.isShow, true);
  assert.equal(source.isMainPush, undefined);
});

test("套餐状态保存中抑制重复操作，失败后回退状态并允许重试", async () => {
  const f = fixture();
  const source = { id: "bundle-toggle", name: "状态组合", type: "photo", isShow: true, status: "上架", auditStatus: "已上" };
  f.ctx.data.packages.push(source);
  let resolveWrite;
  let writes = 0;
  f.ctx.persistContentMutation = async () => { writes += 1; return new Promise((resolve) => { resolveWrite = resolve; }); };
  const page = f.page("src/views/content/package/package.js");
  const snapshot = clone(source);
  const pending = page.toggleVisible(source);
  const repeated = page.toggleVisible(source);
  const conflicting = page.toggleMainPush(source);
  assert.equal(writes, 1);
  resolveWrite(false);
  await Promise.all([pending, repeated, conflicting]);
  assert.deepEqual(source, snapshot);
  const retry = page.toggleVisible(source);
  assert.equal(writes, 2);
  resolveWrite(true);
  await retry;
  assert.equal(source.isShow, false);
  assert.equal(source.status, "下架");
});

test("套餐通用照片在未关联点位入口可选，城市筛选不会误收通用或其他点位商品", async () => {
  const f = fixture();
  f.ctx.data.series.push({ id: "legacy-series", name: "点位风格", spotId: "a" });
  f.ctx.data.albums.push({ id: "unbound-photo", name: "通用照片", price: 15.5, seriesId: "legacy-series", spotId: "", spotIds: [], spotBindingExplicit: true, isShow: true });
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  page.form.value.tagText = "测试标签";
  assert.ok(page.pickerSpots.value.some((spot) => spot.id === "__unbound__"));
  Object.assign(page.picker, { spotId: "__unbound__", productKey: "album:unbound-photo" });
  assert.deepEqual(Array.from(page.spotProductOptions.value, (option) => option.id), ["unbound-photo"]);
  page.addSpotProduct();
  assert.equal(page.form.value.includedItems[0].spotId, "");
  page.picker.city = "c1";
  page.changePickerCity();
  assert.equal(page.pickerSpots.value.some((spot) => spot.id === "__unbound__"), false);
  Object.assign(page.picker, { spotId: "a", productKey: "album:unbound-photo" });
  page.addSpotProduct();
  assert.equal(page.form.value.includedItems.length, 1, "陈旧商品选择不能越过城市和点位筛选");
  page.form.value.name = "通用照片组合";
  await page.saveForm();
  const saved = f.ctx.data.packages.find((row) => row.name === "通用照片组合");
  assert.ok(saved, f.messages.join("；"));
  assert.deepEqual(Array.from(saved.spotIds), []);
  assert.equal(saved.includedItems[0].target.albumId, "unbound-photo");
});

test("创建套餐等待服务端保存成功后自动回到列表，清除旧筛选并结束编辑", async () => {
  const f = fixture();
  let completeSave;
  let writes = 0;
  let confirmations = 0;
  f.ctx.persistContentMutation = async () => {
    writes += 1;
    return new Promise((resolve) => { completeSave = resolve; });
  };
  f.ctx.ElMessageBox.confirm = async () => { confirmations += 1; };
  const page = f.page("src/views/content/package/package.js");
  page.keyword.value = "原来的搜索词";
  page.spotFilter.value = "b";
  page.visibilityFilter.value = "hidden";
  page.openCreate();
  page.form.value.tagText = "测试标签";
  page.form.value.name = "新建后返回列表";
  page.addIncludedItem();
  Object.assign(page.form.value.includedItems[0], { productId: "photo", quantity: 1 });
  page.syncIncludedItem(page.form.value.includedItems[0]);
  const count = f.ctx.data.packages.length;
  const saving = page.saveForm();
  for (let index = 0; index < 8 && !completeSave; index += 1) await Promise.resolve();
  assert.equal(typeof completeSave, "function");
  assert.equal(page.dialogVisible.value, true, "服务端确认前保留编辑窗口");
  assert.equal(page.saving.value, true);
  assert.equal(f.ctx.data.packages.length, count);
  assert.equal(page.keyword.value, "原来的搜索词");
  assert.equal(await page.saveForm(), false, "保存期间不重复提交");
  assert.equal(writes, 1);
  completeSave(true);
  assert.equal(await saving, true);
  assert.equal(page.dialogVisible.value, false);
  assert.equal(page.form.value, null);
  assert.equal(page.saving.value, false);
  assert.equal(page.keyword.value, "");
  assert.equal(page.spotFilter.value, "");
  assert.equal(page.visibilityFilter.value, "");
  assert.ok(page.tableRows.value.some((row) => row.name === "新建后返回列表"));
  assert.equal(confirmations, 0, "成功保存后不弹放弃修改确认");
  page.resetEditor();
  page.openCreate();
  page.form.value.tagText = "测试标签";
  assert.equal(page.form.value.name, "");
  assert.equal(page.form.value.includedItems.length, 0);
});

test("套餐保存失败或异常时精确恢复原记录，保留草稿并解除保存状态", async () => {
  for (const failure of ["false", "throw"]) {
    const f = fixture();
    const source = { id: `bundle-${failure}`, name: "原套餐", type: "photo", price: 10, includedItems: [{ type: "album", productId: "photo", quantity: 1 }] };
    f.ctx.data.packages.push(source);
    const snapshot = clone(source);
    f.ctx.persistContentMutation = async (key, record) => {
      record.uncommittedResponseField = "必须清除";
      if (failure === "throw") throw new Error("套餐网络中断");
      return false;
    };
    const page = f.page("src/views/content/package/package.js");
    page.openEdit(source);
    page.form.value.name = "尚未保存的更名";
    page.form.value.price = 8;
    page.setManualPrice();
    await page.saveForm();
    assert.deepEqual(clone(source), snapshot, failure);
    assert.equal(page.form.value.name, "尚未保存的更名");
    assert.equal(page.form.value.price, 8);
    assert.equal(page.dialogVisible.value, true);
    assert.equal(page.saving.value, false);
    assert.equal(f.ctx.data.packages.filter((row) => row.id === source.id).length, 1);

    page.openCreate();
    page.form.value.name = "保存失败的新套餐";
    Object.assign(page.picker, { city: "c1", spotId: "a", productKey: "album:photo" });
    page.addSpotProduct();
    const count = f.ctx.data.packages.length;
    await page.saveForm();
    assert.equal(f.ctx.data.packages.length, count);
    assert.equal(page.dialogVisible.value, true);
    assert.equal(page.saving.value, false);
  }
});

test("套餐放弃修改确认取消时保留草稿，关闭前回调与上传期间遵循同一保护", async () => {
  const f = fixture();
  let confirms = 0;
  let approve = false;
  f.ctx.ElMessageBox.confirm = async () => { confirms += 1; if (!approve) throw new Error("cancel"); };
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  await page.closeDialog();
  assert.equal(page.dialogVisible.value, false);
  assert.equal(confirms, 0, "未修改草稿无需确认");
  page.openCreate();
  page.form.value.name = "编辑中的套餐";
  await page.closeDialog();
  assert.equal(confirms, 1);
  assert.equal(page.dialogVisible.value, true);
  assert.equal(page.form.value.name, "编辑中的套餐");
  let done = 0;
  await page.beforeDialogClose(() => { done += 1; });
  assert.equal(done, 0);
  assert.equal(page.form.value.name, "编辑中的套餐");
  approve = true;
  f.options.uploadBusy = true;
  await page.beforeDialogClose(() => { done += 1; });
  assert.equal(done, 0, "上传未结束不可丢弃草稿");
  f.options.uploadBusy = false;
  await page.beforeDialogClose(() => { done += 1; });
  assert.equal(done, 1);
  await page.closeDialog();
  assert.equal(page.dialogVisible.value, false);
});

test("套餐最多六个标签，达到上限仍可移除预设并补充自定义标签", () => {
  const f = fixture();
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  for (const tag of ["主推", "爆款", "新品", "活动", "日落", "情侣"]) page.addTag(tag);
  assert.equal(page.formTags.value.length, 6);
  page.tagInput.value = "亲子";
  assert.equal(page.addTag(), false);
  assert.equal(page.formTags.value.length, 6);
  assert.match(f.messages.at(-1), /最多.*6/);
  page.addTag("爆款");
  assert.equal(page.formTags.value.length, 5);
  page.tagInput.value = "亲子";
  page.addTag();
  assert.equal(page.formTags.value.length, 6);
  assert.ok(page.formTags.value.includes("亲子"));
});

test("套餐订金百分数保存为统一比例，零、一和百分之百重新编辑均保持原值", async () => {
  for (const percent of [0, 1, 30, 100]) {
    const f = fixture();
    const page = f.page("src/views/content/package/package.js");
    page.openCreate();
  page.form.value.tagText = "测试标签";
    page.form.value.name = `订金${percent}%套餐`;
    page.form.value.depositRatio = percent;
    Object.assign(page.picker, { city: "c1", spotId: "a", productKey: "album:photo" });
    page.addSpotProduct();
    await page.saveForm();
    const saved = f.ctx.data.packages.find((row) => row.name === `订金${percent}%套餐`);
    assert.ok(saved, f.messages.join("；"));
    assert.equal(saved.depositRatio, percent / 100, `${percent}%应按0–1比例传给订单接口`);
    page.openEdit(saved);
    assert.equal(page.form.value.depositRatio, percent);
    await page.saveForm();
    assert.equal(saved.depositRatio, percent / 100, "重新保存不能反复放大或缩小订金比例");
  }
});

test("套餐可批量加入同点位多个商品，再跨点位跨城市追加并独立批量加入周边", async () => {
  const f = fixture();
  f.ctx.data.albums.push(
    { id: "photo-a2", name: "补充照片", price: 7.66, spotId: "a", isShow: true },
    { id: "photo-b", name: "照片", price: 30, spotId: "b", isShow: true },
    { id: "photo-c", name: "杭州照片", price: 50, spotId: "c", isShow: true }
  );
  f.ctx.data.packages.push({ id: "video-a", name: "点A短片", type: "video", price: 20, spotId: "a", isShow: true });
  f.ctx.data.peripherals.push({ id: "gift2", name: "照片书", price: 6, isShow: true });
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  page.form.value.tagText = "测试标签";
  page.form.value.name = "跨城市批量组合";
  Object.assign(page.picker, { city: "c1", spotId: "a", productKeys: ["album:photo", "album:photo-a2", "video:video-a"], peripheralIds: ["gift", "gift2"] });
  page.addSpotProducts();
  assert.deepEqual(Array.from(page.form.value.includedItems, (item) => item.productId), ["photo", "photo-a2", "video-a"]);
  assert.equal(page.form.value.originalPrice, 40);
  page.form.value.price = 120;
  page.setManualPrice();

  page.picker.spotId = "b";
  page.changePickerSpot();
  assert.deepEqual(Array.from(page.picker.productKeys), []);
  assert.deepEqual(Array.from(page.picker.peripheralIds), ["gift", "gift2"]);
  assert.equal(page.form.value.includedItems.length, 3);
  page.picker.productKeys = ["video:video", "album:photo-b"];
  page.addSpotProducts();
  assert.equal(page.form.value.includedItems.length, 5);
  assert.equal(page.form.value.originalPrice, 90);

  page.picker.city = "c2";
  page.changePickerCity();
  assert.equal(page.picker.spotId, "");
  assert.deepEqual(Array.from(page.picker.productKeys), []);
  assert.deepEqual(Array.from(page.picker.peripheralIds), ["gift", "gift2"]);
  page.picker.spotId = "c";
  page.changePickerSpot();
  page.picker.productKeys = ["album:photo-c"];
  page.addSpotProducts();
  page.addPeripheralProducts();
  assert.equal(page.form.value.includedItems.length, 8);
  assert.equal(page.selectedQuantity.value, 8);
  assert.equal(page.form.value.originalPrice, 151);
  assert.equal(page.form.value.price, 120);
  assert.equal(page.form.value.includedItems.filter((item) => item.name === "照片").length, 2, "同名不同ID商品必须分别保留");

  await page.saveForm();
  const saved = f.ctx.data.packages.find((row) => row.name === "跨城市批量组合");
  assert.ok(saved, f.messages.join("；"));
  assert.equal(saved.includedItems.length, 8);
  assert.equal(saved.items.length, 8);
  assert.deepEqual(Array.from(saved.spotIds).sort(), ["a", "b", "c"]);
  assert.equal(saved.originalPrice, 151);
  assert.equal(saved.price, 120);
  assert.equal(saved.includedItems.find((item) => item.productId === "photo-c").target.albumId, "photo-c");
  assert.equal(saved.includedItems.find((item) => item.productId === "video-a").target.productId, "video-a");
  assert.equal(saved.includedItems.find((item) => item.productId === "gift2").target.peripheralId, "gift2");
  page.openEdit(saved);
  assert.equal(page.form.value.includedItems.length, 8);
  assert.equal(page.form.value.price, 120);
});

test("套餐批量重复选择同一商品累计数量，同名不同ID及不同类型商品保持独立", () => {
  const f = fixture();
  f.ctx.data.albums.push(
    { id: "shared-photo", name: "跨点位照片", price: 10.1, spotIds: ["a", "b"], isShow: true },
    { id: "photo-second", name: "跨点位照片", price: 8, spotId: "a", isShow: true }
  );
  f.ctx.data.packages.push({ id: "shared-photo", name: "同ID视频", type: "video", price: 20, spotId: "a", isShow: true });
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  Object.assign(page.picker, { city: "c1", spotId: "a", productKeys: ["album:shared-photo", "album:photo-second", "video:shared-photo"] });
  page.addSpotProducts();
  assert.equal(page.form.value.includedItems.length, 3);
  assert.equal(page.form.value.originalPrice, 38.1);
  page.picker.spotId = "b";
  page.changePickerSpot();
  page.picker.productKeys = ["album:shared-photo"];
  page.addSpotProducts();
  const shared = page.form.value.includedItems.find((item) => item.type === "album" && item.productId === "shared-photo");
  assert.equal(shared.quantity, 2);
  assert.equal(page.form.value.includedItems.length, 3);
  assert.equal(page.form.value.includedItems.find((item) => item.type === "video").quantity, 1);
  assert.equal(page.form.value.originalPrice, 48.2);
  page.form.value.price = 40;
  page.setManualPrice();
  page.picker.peripheralIds = ["gift"];
  page.addPeripheralProducts();
  page.picker.peripheralIds = ["gift"];
  page.addPeripheralProducts();
  assert.equal(page.form.value.includedItems.length, 4);
  assert.equal(page.form.value.includedItems.find((item) => item.productId === "gift").quantity, 2);
  assert.equal(page.form.value.originalPrice, 58.2);
  assert.equal(page.form.value.price, 40);
});

test("套餐批量添加遵循当前来源与编辑权限，切换后的陈旧勾选不会加入错误商品", () => {
  const f = fixture();
  let editable = true;
  f.ctx.can = () => editable;
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  Object.assign(page.picker, { city: "c1", spotId: "a", productKeys: ["video:video"] });
  page.addSpotProducts();
  assert.equal(page.form.value.includedItems.length, 0, "点B视频不能从点A批量加入");
  Object.assign(page.picker, { productKeys: ["album:photo"], peripheralIds: ["gift"] });
  editable = false;
  page.addSpotProducts();
  page.addPeripheralProducts();
  assert.equal(page.form.value.includedItems.length, 0);
  editable = true;
  page.saving.value = true;
  page.addSpotProducts();
  page.addPeripheralProducts();
  assert.equal(page.form.value.includedItems.length, 0, "提交中的套餐不可继续更改组合");
});

test("打卡点列表按已保存排序展示数字，城市筛选不会修改排序", () => {
  const f = fixture();
  f.trackWrites();
  const page = f.page("src/views/content/spot/spot.js");
  f.ctx.data.spots[0].sort = 3;
  page.spotCityFilter.value = "c1";
  assert.deepEqual(Array.from(page.spotTableRows.value, (row) => row.id), ["b", "a"]);
  assert.equal(page.spotRankText(f.ctx.data.spots[0]), "3");
  assert.equal(page.spotRankText({ sort: 0 }), "—");
  assert.equal(page.spotRankText({}), "—");
  page.spotCityFilter.value = "c2";
  assert.deepEqual(Array.from(page.spotTableRows.value, (row) => row.id), ["c"]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.ctx.data.spots[0].sort, 3);
  assert.equal(f.ctx.data.spots[1].sort, 2);
  assert.equal(f.ctx.data.spots[2].sort, 1);
});

test("隐藏点位保留关联并联动整个套餐和灵感，恢复仍保留单独隐藏意图", async () => {
  const f = fixture();
  f.trackWrites();
  const bundle = { id: "bundle", type: "photo", isShow: true, includedItems: [{ type: "album", productId: "photo" }, { type: "video", productId: "video" }] };
  f.ctx.data.packages.push(bundle);
  const history = JSON.stringify(f.ctx.data.orders);
  await f.ctx.toggleSpotVisible(f.ctx.data.spots[0]);
  assert.equal(f.ctx.data.albums[0].spotId, "a");
  assert.equal(f.ctx.data.albums[0].isShow, true);
  assert.equal(f.ctx.contentEffectiveVisible(f.ctx.data.albums[0]), false);
  assert.equal(f.ctx.contentEffectiveVisible(bundle), false);
  assert.equal(f.ctx.contentEffectiveVisible(f.ctx.data.guides[0]), false);
  f.ctx.data.albums[0].isShow = false;
  await f.ctx.toggleSpotVisible(f.ctx.data.spots[0]);
  assert.equal(f.ctx.contentEffectiveVisible(f.ctx.data.guides[0]), true);
  assert.equal(f.ctx.contentEffectiveVisible(bundle), false);
  assert.equal(JSON.stringify(f.ctx.data.orders), history);
});

test("仅超管可删除隐藏点位，关联自动解除且历史订单保留", async () => {
  const f = fixture();
  f.trackWrites();
  const spot = f.ctx.data.spots[0];
  const history = JSON.stringify(f.ctx.data.orders);
  await f.ctx.requestDeleteSpot(spot);
  assert.equal(spot.deleted, undefined);
  await f.ctx.toggleSpotVisible(spot);
  f.ctx.state.role = "content";
  await f.ctx.requestDeleteSpot(spot);
  assert.equal(spot.deleted, undefined);
  f.ctx.state.role = "super";
  await f.ctx.requestDeleteSpot(spot);
  assert.equal(spot.deleted, true);
  assert.equal(f.ctx.data.albums[0].spotId, "a", "关联解除以服务端返回为准，客户端不模拟级联");
  assert.equal(f.ctx.data.guides[0].spotId, "a");
  assert.equal(f.ctx.state.trash.length, 1);
  assert.equal(JSON.stringify(f.ctx.data.orders), history);
});

test("单品保存归一化为一个可选点位，自动保存共享风格标签并复用已存在的名称", async () => {
  const f = fixture();
  const row = f.ctx.data.albums[0];
  Object.assign(row, { spotId: "b", spotIds: ["a", "b"], tags: ["新风格"] });
  await f.ctx.persistContentMutation("albums", row);
  assert.deepEqual(Array.from(row.spotIds), ["b"]);
  assert.equal(row.cityId, "c1");
  assert.equal(f.ctx.data.tagLibrary.length, 1);
  await f.ctx.persistContentMutation("packages", { id: "new-video", type: "video", tags: ["新风格"], spotId: "", isShow: false });
  assert.equal(f.ctx.data.tagLibrary.length, 1);
  row.spotId = "";
  f.ctx.markContentSpotChange(row);
  await f.ctx.persistContentMutation("albums", row);
  assert.deepEqual(Array.from(row.spotIds), []);
});

test("旧商品仅通过风格继承点位时普通编辑保留关联，明确清空后不会再次继承", async () => {
  const f = fixture();
  f.ctx.data.series.push({ id: "legacy-style", spotId: "a" });
  const row = { ...f.ctx.data.albums[0], spotId: "", spotIds: [], seriesId: "legacy-style", price: 18 };
  await f.ctx.persistContentMutation("albums", row, { ...row });
  assert.equal(row.spotId, "a");
  assert.equal(row.seriesId, "legacy-style");
  row.spotId = "";
  f.ctx.markContentSpotChange(row);
  await f.ctx.persistContentMutation("albums", row, { ...row });
  assert.equal(row.spotId, "");
  assert.equal(row.seriesId, "legacy-style");
  assert.equal(row.spotBindingExplicit, true);
  f.ctx.hydrateProductSpot(row);
  assert.equal(row.spotId, "");
  assert.deepEqual(Array.from(f.ctx.contentSpotIds(row)), []);
  assert.deepEqual(Array.from(row.spotIds), []);
});

test("新发布与隐藏后恢复显示校验必填，旧已发布内容的普通编辑保持兼容", () => {
  const f = fixture();
  assert.match(f.ctx.validateContentPublishing("albums", { name: "新照片", tags: ["风格"], price: 10, isShow: true }), /说明/);
  assert.equal(f.ctx.validateContentPublishing("albums", { name: "草稿", tags: ["风格"], isShow: false }), "");
  assert.equal(f.ctx.validateContentPublishing("albums", { name: "旧照片", tags: ["风格"], price: 15, isShow: true }, { isShow: true }), "");
  assert.match(f.ctx.validateContentPublishing("albums", { name: "恢复照片", tags: ["风格"], price: 10, isShow: true }, { isShow: false }), /说明/);
  const complete = { ...f.ctx.data.albums[0], tags: ["风格"], spotId: "" };
  assert.equal(f.ctx.validateContentPublishing("albums", complete), "", "点位可不关联");
});

test("照片留影关联拍摄风格后仍须填写商品标签才能保存", async () => {
  const f = fixture();
  f.ctx.data.series.push({ _id: "linked-style", name: "渔人码头", spotId: "a" });
  f.ctx.state.active = "albums";
  f.ctx.openContent();
  Object.assign(f.ctx.state.editContent, { name: "渔人码头", shootingNotes: "码头看湘江", sampleUrls: ["/test.jpg"], cover: "/test.jpg", tag: "码头" });
  assert.equal(f.ctx.state.editContent.seriesId, "linked-style");
  assert.equal(f.ctx.state.editContent.tags.length, 0);
  await f.ctx.saveContent();
  assert.equal(f.ctx.data.albums.some((row) => row.name === "渔人码头"), false);
  assert.equal(f.messages.at(-1), "请至少添加一个标签");
  f.ctx.state.editContent.tags = ["江景"];
  await f.ctx.saveContent();
  const saved = f.ctx.data.albums.find((row) => row.name === "渔人码头");
  assert.ok(saved, f.messages.join("；"));
  assert.equal(saved.seriesId, "linked-style");
  assert.deepEqual(Array.from(saved.tags), ["江景"]);
  assert.equal(f.ctx.state.contentDialog, false);
  assert.ok(f.ctx.data.tagLibrary.some((tag) => tag.name === "江景" && tag.category === "风格"));
});

test("风格关联不能替代商品标签，自定义标签仍可独立发布", () => {
  const f = fixture();
  f.ctx.data.series.push({ id: "linked-style" }, { id: "deleted-style", deleted: true }, { id: "removed-style", isDeleted: true });
  const products = [
    ["albums", { ...f.ctx.data.albums[0], tags: [] }],
    ["packages", { name: "视频摄像", type: "video", productKind: "video_single", price: 10, isShow: true, videoUrl: "/video.mp4", shootingNotes: "拍摄说明", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "2个工作日", tags: [] }]
  ];
  for (const [key, row] of products) {
    for (const previous of [null, { isShow: false }]) {
      assert.equal(f.ctx.validateContentPublishing(key, { ...row, seriesId: "linked-style" }, previous), "请至少添加一个标签");
      assert.equal(f.ctx.validateContentPublishing(key, { ...row, tags: ["清新"] }, previous), "");
      for (const seriesId of ["", "missing-style", "deleted-style", "removed-style"]) {
        assert.equal(f.ctx.validateContentPublishing(key, { ...row, seriesId }, previous), "请至少添加一个标签");
      }
    }
  }
});

test("三类商品保存均要求有效标签，草稿和旧商品清空也不能用风格或服务字段替代", () => {
  const f = fixture();
  f.ctx.data.series.push({ id: "linked-style" });
  const products = [
    ["albums", f.ctx.data.albums[0]],
    ["packages", { name: "视频摄像", type: "video", productKind: "video_single", price: 10, videoUrl: "/video.mp4", shootingNotes: "拍摄说明", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "2个工作日" }],
    ["packages", { name: "旅拍套餐", type: "photo", price: 100 }]
  ];
  for (const [key, product] of products) {
    for (const status of ["草稿", "下架", "上架"]) {
      const row = { ...product, status, isShow: status === "上架", seriesId: "linked-style", seriesName: "旧风格", tag: "旧运营", serviceTags: ["旧服务"], styleTags: ["旧风格"] };
      for (const tags of [undefined, null, [], [" ", "\n"], [null, false, {}, 0], " ， | "]) {
        assert.equal(f.ctx.validateContentPublishing(key, { ...row, tags }), "请至少添加一个标签");
        const previous = { ...row, tags: ["旧标签"] };
        assert.equal(f.ctx.validateContentPublishing(key, { ...row, tags }, previous), "请至少添加一个标签");
      }
      assert.equal(f.ctx.validateContentPublishing(key, { ...row, tags: ["  自定义标签  "] }), "");
    }
  }
});

test("存量无标签商品可纯状态下架，明确编辑保存或同时改内容仍必须补标签", () => {
  const f = fixture();
  for (const key of ["albums", "packages"]) {
    const previous = { id: "legacy", name: "旧商品", type: "photo", tags: [], isShow: true, status: "上架" };
    const hidden = { ...previous, isShow: false, status: "下架" };
    assert.equal(f.ctx.validateContentPublishing(key, hidden, previous), "");
    assert.equal(f.ctx.validateContentPublishing(key, hidden, previous, { forceTags: true }), "请至少添加一个标签");
    assert.equal(f.ctx.validateContentPublishing(key, { ...hidden, name: "改了资料" }, previous), "请至少添加一个标签");
    assert.equal(f.ctx.validateContentPublishing(key, previous, hidden), "请至少添加一个标签");
  }
});

test("照片留影不绑定拍摄风格时也可填写自定义标签保存", async () => {
  const f = fixture();
  f.ctx.state.active = "albums";
  f.ctx.openContent();
  Object.assign(f.ctx.state.editContent, { name: "自定义风格照片", shootingNotes: "拍摄说明", sampleUrls: ["/test.jpg"], cover: "/test.jpg", seriesId: "", tags: ["江景"] });
  await f.ctx.saveContent();
  const saved = f.ctx.data.albums.find((row) => row.name === "自定义风格照片");
  assert.ok(saved, f.messages.join("；"));
  assert.deepEqual(Array.from(saved.tags), ["江景"]);
  assert.ok(f.ctx.data.tagLibrary.some((tag) => tag.name === "江景" && tag.category === "风格"));
});

test("组合套餐不关联风格也必须至少填写一个标签", async () => {
  const f = fixture();
  const page = f.page("src/views/content/package/package.js");
  page.openCreate();
  page.form.value.name = "照片组合套餐";
  page.addIncludedItem();
  Object.assign(page.form.value.includedItems[0], { productId: "photo", quantity: 2 });
  page.syncIncludedItem(page.form.value.includedItems[0]);
  await page.saveForm();
  assert.equal(f.ctx.data.packages.some((row) => row.name === "照片组合套餐"), false);
  assert.equal(f.messages.at(-1), "请至少添加一个标签");
  page.addTag("双人");
  await page.saveForm();
  const saved = f.ctx.data.packages.find((row) => row.name === "照片组合套餐");
  assert.ok(saved, f.messages.join("；"));
  assert.equal(saved.price, 24.68);
  assert.equal(saved.seriesId, "");
  assert.deepEqual(Array.from(saved.tags), ["双人"]);
});

test("套餐编辑按三行容量限制27字符，超限不保存，边界标题不截断", async () => {
  const f = fixture();
  f.trackWrites();
  const page = f.page("src/views/content/package/package.js");
  assert.equal(page.packageTitleLimit, 27);
  page.openCreate();
  page.form.value.name = "旅".repeat(28);
  page.addTag("双人");
  page.addIncludedItem();
  Object.assign(page.form.value.includedItems[0], { productId: "photo", quantity: 1 });
  page.syncIncludedItem(page.form.value.includedItems[0]);
  await page.saveForm();
  assert.equal(f.writes.length, 0);
  assert.match(f.messages.at(-1), /最多 27 个字符/);
  assert.equal(page.form.value.name.length, 28);
  const name = "旅".repeat(21) + "ABC123";
  assert.equal(name.length, 27);
  page.form.value.name = name;
  assert.equal(await page.saveForm(), true, f.messages.join("；"));
  assert.equal(f.writes[0].row.name, name);
});

test("套餐快捷编辑覆盖字数校验和单行归一，视频单品沿用原标题范围", async () => {
  const f = fixture();
  const calls = [];
  f.window.LXM_CLOUD.create = async (key, payload) => { calls.push(clone(payload)); return { ...clone(payload), id: payload.id || "new-package" }; };
  f.window.LXM_CLOUD.update = async (key, id, payload) => { calls.push(clone(payload)); return { ...clone(payload), id }; };
  f.ctx.openContentQuick("packages");
  Object.assign(f.ctx.state.editContent, { name: "A".repeat(28), tags: ["组合"], isShow: false, status: "草稿" });
  await f.ctx.saveContent();
  assert.equal(calls.length, 0);
  assert.match(f.messages.at(-1), /最多 27 个字符/);
  f.ctx.state.editContent.name = "  城市\n  旅拍\t套餐  ";
  await f.ctx.saveContent();
  assert.equal(calls.at(-1).name, "城市 旅拍 套餐");
  const video = { __key: "packages", id: "video", name: "视频".repeat(25), type: "video", productKind: "video_single", tags: ["电影"], isShow: true };
  assert.equal(f.ctx.packageTitleError(video), "");
  assert.equal(f.ctx.packageTitleLength("旅".repeat(25) + "😀"), 27, "和输入框maxlength采用相同UTF-16字符数");
});

test("旧长套餐名不静默截断，可原名调价和下架，重新显示或改名须缩短", async () => {
  const f = fixture();
  f.trackWrites();
  const source = { id: "long-bundle", name: "旅".repeat(40), type: "photo", isShow: true, status: "上架", price: 12.34, tags: ["组合"], includedItems: [{ type: "album", productId: "photo", quantity: 1 }] };
  f.ctx.data.packages.push(source);
  const page = f.page("src/views/content/package/package.js");
  page.openEdit(source);
  page.form.value.price = 10;
  assert.equal(await page.saveForm(), true, f.messages.join("；"));
  assert.equal(source.name.length, 40);
  assert.equal(source.price, 10);
  await page.toggleVisible(source);
  assert.equal(source.isShow, false);
  const writes = f.writes.length;
  await page.toggleVisible(source);
  assert.equal(source.isShow, false);
  assert.equal(f.writes.length, writes);
  assert.match(f.messages.at(-1), /最多 27 个字符/);
  page.openEdit(source);
  page.form.value.name = "新".repeat(28);
  await page.saveForm();
  assert.equal(source.name.length, 40);
  assert.equal(f.writes.length, writes);
  page.form.value.name = "城市旅拍组合套餐";
  page.form.value.isShow = true;
  assert.equal(await page.saveForm(), true, f.messages.join("；"));
  assert.equal(source.name, "城市旅拍组合套餐");
  assert.equal(source.isShow, true);
});

function rankedSpotFixture() {
  const f = fixture();
  f.ctx.data.spots = ["a", "b", "c", "d", "e"].map((id, index) => ({ id, _id: id, name: id.toUpperCase(), cityId: index % 2 ? "c2" : "c1",
    sort: index + 1, status: "启用", isShow: true, cover: "/spot.jpg", address: "测试地址", intro: "点位介绍", tag: "推荐", tags: ["风景"] }));
  f.ctx.data.tagLibrary = [{ id: "operation", name: "推荐", category: "运营" }, { id: "content", name: "风景", category: "内容" }];
  f.ctx.state.active = "spots";
  connectSpotServer(f);
  return f;
}
function spotRanks(f) { return spotOrder.ordered(f.ctx.data.spots).map(row => [row.id || row._id, row.sort]); }
function connectSpotServer(f, update) {
  const calls = [];
  const serverRows = clone(f.ctx.data.spots);
  const execute = async (method, key, id, patch) => {
    calls.push({ method, key, id, patch: clone(patch) });
    if (update) return update(method, key, id, patch);
    const plan = planSpotMutation(serverRows, id, patch, { create: method === "create", reorder: Object.keys(patch).length === 1 && Object.hasOwn(patch, "sort") });
    if (!plan) throw Object.assign(new Error("未找到记录"), { status: 404 });
    for (const change of plan.changes) {
      const source = serverRows.find(row => row.id === change.id);
      if (source) Object.assign(source, change.after);
      else serverRows.push(clone(change.after));
    }
    return { ...plan.saved, __spotOrder: plan.changes.map(change => ({ id: change.id, sort: change.after.sort ?? 0 })) };
  };
  f.window.LXM_AUTH.hasSession = () => true;
  f.window.LXM_CLOUD_MODE = "mysql";
  f.window.LXM_CLOUD = {
    update: (key, id, patch) => execute("update", key, id, patch),
    create: (key, patch) => execute("create", key, patch.id || patch._id, patch)
  };
  return { calls, serverRows };
}

test("显示状态请求未返回时也阻止新重排，避免迟到响应覆盖最新顺位", async () => {
  const f = rankedSpotFixture();
  let finish;
  const server = connectSpotServer(f, () => new Promise(resolve => { finish = resolve; }));
  const page = f.page("src/views/content/spot/spot.js");
  const source = f.ctx.data.spots[2];
  const previous = { ...source };
  source.isShow = false;
  const saving = f.ctx.persistContentMutation("spots", source, previous);
  for (let i = 0; i < 8 && !finish; i++) await Promise.resolve();
  assert.equal(f.ctx.isSpotOrderSaving(), true);
  assert.equal(await page.changeSpotSort({ id: "e" }, -1), false);
  assert.equal(server.calls.length, 1);
  assert.equal(Object.hasOwn(server.calls[0].patch, "sort"), false);
  finish({ ...source, __spotOrder: [{ id: "c", sort: 3 }] });
  assert.equal(await saving, true);
  assert.equal(f.ctx.isSpotOrderSaving(), false);
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]);
});

test("编辑表单将第 5 位插入第 3 位后，列表上下移动继续使用同一连续顺序", async () => {
  const f = rankedSpotFixture();
  f.ctx.openContent(f.ctx.data.spots.find(row => row.id === "e"));
  f.ctx.state.editContent.sort = 3;
  await f.ctx.saveContent();
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["e", 3], ["c", 4], ["d", 5]]);
  const page = f.page("src/views/content/spot/spot.js");
  await page.changeSpotSort({ id: "e" }, 1);
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["c", 3], ["e", 4], ["d", 5]]);
  await page.changeSpotSort({ id: "e" }, -1);
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["e", 3], ["c", 4], ["d", 5]]);
  assert.equal(f.ctx.isSpotOrderSaving(), false);
});

test("新增排序点位插入指定位置，过大排序追加，清空排序后其他点位补齐", async () => {
  const f = rankedSpotFixture();
  f.ctx.openContentQuick("spots");
  Object.assign(f.ctx.state.editContent, { name: "新增点位", cityId: "c1", cover: "/new.jpg", address: "新增地址", intro: "新增介绍", tag: "推荐", tags: ["风景"], sort: 2 });
  await f.ctx.saveContent();
  const created = f.ctx.data.spots.find(row => row.name === "新增点位");
  assert.ok(created, f.messages.join("；"));
  assert.deepEqual(spotRanks(f), [["a", 1], [created.id, 2], ["b", 3], ["c", 4], ["d", 5], ["e", 6]]);
  f.ctx.openContent(created);
  f.ctx.state.editContent.sort = 2147483647;
  await f.ctx.saveContent();
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], [created.id, 6]]);
  f.ctx.openContent(f.ctx.data.spots.find(row => row.id === "c"));
  f.ctx.state.editContent.sort = null;
  await f.ctx.saveContent();
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["d", 3], ["e", 4], [created.id, 5]]);
  assert.equal(f.ctx.data.spots.find(row => row.id === "c").sort, 0);
});

test("只编辑点位资料或保留原排序不会重排已有空洞和并列值", async () => {
  const f = rankedSpotFixture();
  f.ctx.data.spots[1].sort = 3;
  f.ctx.data.spots[2].sort = 3;
  f.ctx.data.spots[4].sort = 12;
  connectSpotServer(f);
  const before = f.ctx.data.spots.map(row => [row.id, row.sort]);
  f.ctx.openContent(f.ctx.data.spots[1]);
  f.ctx.state.editContent.intro = "只修改介绍";
  await f.ctx.saveContent();
  assert.deepEqual(f.ctx.data.spots.map(row => [row.id, row.sort]), before);
  assert.equal(f.ctx.data.spots[1].intro, "只修改介绍");
});

test("在线表单只提交目标记录并采用服务端兄弟排序，不把响应元数据保存到记录", async () => {
  const f = rankedSpotFixture();
  const server = connectSpotServer(f);
  f.ctx.openContent(f.ctx.data.spots[4]);
  f.ctx.state.editContent.sort = 3;
  f.ctx.state.editContent.intro = "服务端点位介绍";
  await f.ctx.saveContent();
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].key, "spots");
  assert.equal(server.calls[0].id, "e");
  assert.equal(server.calls[0].patch.sort, 3);
  assert.equal(server.calls[0].patch.intro, "服务端点位介绍");
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["e", 3], ["c", 4], ["d", 5]]);
  assert.ok(f.ctx.data.spots.every(row => !("__spotOrder" in row)));
  assert.equal(f.ctx.data.spots[4].intro, "服务端点位介绍");
});

test("在线表单失败保留所有已保存排序与编辑草稿，释放全局保存锁", async () => {
  const f = rankedSpotFixture();
  connectSpotServer(f, async () => { throw new Error("服务端暂不可用"); });
  const before = clone(f.ctx.data.spots);
  f.ctx.openContent(f.ctx.data.spots[4]);
  Object.assign(f.ctx.state.editContent, { sort: 3, intro: "未保存介绍" });
  await f.ctx.saveContent();
  assert.deepEqual(f.ctx.data.spots, before);
  assert.equal(f.ctx.state.contentDialog, true);
  assert.equal(f.ctx.state.editContent.sort, 3);
  assert.equal(f.ctx.isSpotOrderSaving(), false);
  assert.match(f.messages.at(-1), /服务端暂不可用/);
});

test("表单等待服务端期间阻止列表重排和再次保存，服务端确认前不提前修改排序", async () => {
  const f = rankedSpotFixture();
  let finish;
  const server = connectSpotServer(f, () => new Promise(resolve => { finish = resolve; }));
  const page = f.page("src/views/content/spot/spot.js");
  const before = clone(f.ctx.data.spots);
  f.ctx.openContent(f.ctx.data.spots[4]);
  f.ctx.state.editContent.sort = 3;
  const saving = f.ctx.saveContent();
  for (let i = 0; i < 5 && !finish; i++) await Promise.resolve();
  assert.equal(f.ctx.isSpotOrderSaving(), true);
  assert.deepEqual(f.ctx.data.spots, before);
  assert.equal(page.spotSortDisabled({ id: "b" }, 1), true);
  assert.equal(await page.changeSpotSort({ id: "b" }, 1), false);
  await f.ctx.saveContent();
  assert.equal(server.calls.length, 1);
  finish({ ...server.serverRows[4], sort: 3, __spotOrder: [{ id: "e", sort: 3 }, { id: "c", sort: 4 }, { id: "d", sort: 5 }] });
  await saving;
  assert.deepEqual(spotRanks(f), [["a", 1], ["b", 2], ["e", 3], ["c", 4], ["d", 5]]);
  assert.equal(f.ctx.isSpotOrderSaving(), false);
});

test("已打开的旧草稿只修改资料时保留后来重排的新位置，在线请求不携带陈旧排序", async () => {
  for (const online of [false, true]) {
    const f = rankedSpotFixture();
    const server = online ? connectSpotServer(f) : null;
    f.ctx.openContent(f.ctx.data.spots.find(row => row.id === "c"));
    const draft = f.ctx.state.editContent;
    assert.equal(draft.sort, 3);
    assert.equal(await f.ctx.persistSpotSort({ id: "e" }, 1), true);
    assert.equal(f.ctx.data.spots.find(row => row.id === "c").sort, 4);
    const moved = spotRanks(f);
    draft.intro = "排序之后补充的点位介绍";
    await f.ctx.saveContent();
    assert.deepEqual(spotRanks(f), moved);
    assert.equal(f.ctx.data.spots.find(row => row.id === "c").intro, draft.intro);
    if (online) {
      assert.equal(server.calls.length, 2);
      assert.deepEqual(server.calls[0].patch, { sort: 1 });
      assert.equal(Object.hasOwn(server.calls[1].patch, "sort"), false);
    }
  }
});

test("排序保存期间批量显示等通用写入回退当前修改，释放锁后普通显示写入不携带排序", async () => {
  const f = rankedSpotFixture();
  let finish;
  const server = connectSpotServer(f, () => new Promise(resolve => { finish = resolve; }));
  const saving = f.ctx.persistSpotSort({ id: "e" }, 1);
  const source = f.ctx.data.spots.find(row => row.id === "b");
  const previous = clone(source);
  source.isShow = false;
  assert.equal(await f.ctx.persistContentMutation("spots", source, previous), false);
  assert.deepEqual(source, previous);
  assert.equal(server.calls.length, 1);
  finish({ ...server.serverRows[4], sort: 1, __spotOrder: [{ id: "e", sort: 1 }, { id: "a", sort: 2 }, { id: "b", sort: 3 }, { id: "c", sort: 4 }, { id: "d", sort: 5 }] });
  assert.equal(await saving, true);
  assert.equal(f.ctx.isSpotOrderSaving(), false);

  const ordinary = rankedSpotFixture();
  const online = connectSpotServer(ordinary);
  const row = ordinary.ctx.data.spots[1];
  const before = clone(row);
  row.isShow = false;
  assert.equal(await ordinary.ctx.persistContentMutation("spots", row, before), true);
  assert.equal(online.calls.length, 1);
  assert.equal(Object.hasOwn(online.calls[0].patch, "sort"), false);
  assert.equal(row.sort, 2);
  assert.equal(row.isShow, false);
});
