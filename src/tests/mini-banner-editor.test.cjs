"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../views/operationConfig/mini-decor/mini-decor.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(config = {}, rows = {}, editable = true) {
  let definition, upload, saveCount = 0;
  const messages = [];
  const ctx = { state: { homeConfig: plain(config) }, data: rows, can: () => editable,
    ElMessage: { warning: value => messages.push(value) }, validateMediaUrl() {},
    async saveHomeConfig() { saveCount++; return true; } };
  const window = { LXM_PAGES: { register: value => { definition = value; } },
    LXM_UPLOAD: { pick: options => { upload = options; } },
    Vue: { computed: getter => ({ get value() { return getter(); } }), ref: value => ({ value }),
      watch(source, callback, options) { if (options && options.immediate) callback(); } } };
  vm.runInNewContext(source, { window, URL });
  return { ctx, editor: definition.setup(ctx), messages, get upload() { return upload; }, get saveCount() { return saveCount; } };
}
const banner = id => ({ _id: id, url: `/${id}.jpg`, type: "image", targetType: "none" });

test("首页与探索页编辑独立，排序和删除只作用于当前页", () => {
  const f = fixture({ homeBanners: [banner("h1"), banner("h2")], exploreBanners: [banner("e1"), banner("e2")] });
  f.editor.activePage.value = "explore";
  f.editor.moveBanner(1, -1);
  f.editor.removeBanner(1);
  assert.deepEqual(plain(f.ctx.state.homeConfig.homeBanners).map(row => row._id), ["h1", "h2"]);
  assert.deepEqual(plain(f.ctx.state.homeConfig.exploreBanners).map(row => row._id), ["e2"]);
  f.editor.addBanner();
  assert.equal(f.editor.banners.value[1].targetType, "none");
  assert.equal(f.ctx.state.homeConfig.homeBanners.length, 2);
});

test("旧样片按选择顺序导入可编辑列表，删除后不会重新出现", () => {
  const f = fixture({ carouselIds: ["b", "hidden", "a"] }, { samples: [banner("a"), { ...banner("hidden"), isShow: false }, banner("b")] });
  assert.deepEqual(plain(f.editor.banners.value).map(row => row._id), ["b", "a"]);
  assert.deepEqual(plain(f.ctx.state.homeConfig.carouselIds), []);
  f.editor.removeBanner(1); f.editor.removeBanner(0);
  assert.equal(f.editor.banners.value.length, 0);
  const cleared = fixture({ bannerConfigVersion: 1, homeBanners: [], carouselIds: ["a"] }, { samples: [banner("a")] });
  assert.equal(cleared.editor.banners.value.length, 0);
});

test("两页各限六张，只读用户不能新增、排序、删除、上传或保存", async () => {
  const f = fixture({ homeBanners: Array.from({ length: 6 }, (_, i) => banner(String(i))) });
  f.editor.addBanner(); assert.equal(f.editor.banners.value.length, 6);
  f.editor.activePage.value = "explore"; f.editor.addBanner(); assert.equal(f.editor.banners.value.length, 1);
  const readonly = fixture({ homeBanners: [banner("a"), banner("b")] }, {}, false);
  readonly.editor.addBanner(); readonly.editor.moveBanner(0, 1); readonly.editor.removeBanner(0); readonly.editor.uploadBannerMedia(0, "image");
  await readonly.editor.saveBanners();
  assert.deepEqual(plain(readonly.editor.banners.value).map(row => row._id), ["a", "b"]);
  assert.equal(readonly.upload, undefined); assert.equal(readonly.saveCount, 0);
});

test("异步上传始终更新发起上传的轮播，切换页面后不串素材", () => {
  const f = fixture({ homeBanners: [banner("home")], exploreBanners: [banner("explore")] });
  f.editor.uploadBannerMedia(0, "video");
  assert.equal(f.upload.videoOnly, true);
  f.editor.activePage.value = "explore";
  f.upload.onUploaded({ url: "/uploaded.mp4" });
  assert.equal(f.ctx.state.homeConfig.homeBanners[0].url, "/uploaded.mp4");
  assert.equal(f.ctx.state.homeConfig.homeBanners[0].type, "video");
  assert.equal(f.ctx.state.homeConfig.exploreBanners[0].url, "/explore.jpg");
});

test("保存检查两个页面的空素材及失效详情目标，none 不要求目标", async () => {
  const f = fixture({ homeBanners: [banner("home")], exploreBanners: [{ ...banner("explore"), url: "" }] });
  await f.editor.saveBanners(); assert.equal(f.saveCount, 0); assert.match(f.messages.at(-1), /探索页轮播/);
  const b = f.ctx.state.homeConfig.exploreBanners[0];
  b.url = "/explore.jpg"; b.targetType = "guide"; b.targetId = "missing";
  await f.editor.saveBanners(); assert.equal(f.saveCount, 0); assert.match(f.messages.at(-1), /有效的跳转目标/);
  b.targetType = "none"; b.jumpUrl = "/old"; f.editor.changeBannerTarget(b);
  assert.equal(b.jumpUrl, undefined); assert.equal(b.targetId, "");
  assert.equal(await f.editor.saveBanners(), true); assert.equal(f.saveCount, 1); assert.equal(f.editor.saving.value, false);
});

test("具体商品和旅拍灵感可按名称选择，排除不可公开内容", async () => {
  const f = fixture({ homeBanners: [banner("home")] }, {
    packages: [{ id: "package", name: "旅拍套餐", status: "上架" },
      { id: "video", name: "视频商品", type: "video", isVideoSingle: true, status: "上架" },
      { id: "hidden-package", status: "下架" }],
    albums: [{ _id: "album", name: "照片商品" }, { id: "hidden-album", isShow: false }],
    peripherals: [{ id: "peripheral", name: "相册商品" }],
    guides: [{ id: "guide", title: "长沙旅拍灵感", status: "已发布" }, { id: "draft-guide", status: "草稿" }]
  });
  const b = f.ctx.state.homeConfig.homeBanners[0];
  for (const type of ["package", "album", "video", "peripheral", "guide"]) {
    b.targetType = type;
    f.editor.changeBannerTarget(b);
    assert.equal(f.editor.bannerTargetNeedsId(b), true);
    assert.deepEqual(plain(f.editor.bannerTargetRows(b)).map(row => row.id || row._id), [type]);
    b.targetId = type;
    assert.equal(await f.editor.saveBanners(), true);
    assert.match(f.editor.jumpLabel(b), / · /);
  }
  b.targetType = "guides";
  f.editor.changeBannerTarget(b);
  assert.equal(f.editor.bannerTargetNeedsId(b), false);
  assert.equal(await f.editor.saveBanners(), true);
});

test("两页外部链接校验 HTTPS 地址，预览显示地址且切换类型清空旧目标", async () => {
  const f = fixture({ homeBanners: [banner("home")], exploreBanners: [banner("explore")] });
  assert.equal(f.editor.jumpPresets.some(option => option.value === "external"), true);
  const b = f.ctx.state.homeConfig.exploreBanners[0];
  b.targetType = "external";
  for (const url of ["", "javascript:alert(1)", "http://example.com", "https://", "https://bad host/path", "https://user:pass@example.com", "https://example.com\\@other.com"]) {
    b.linkUrl = url;
    await f.editor.saveBanners();
    assert.equal(f.saveCount, 0, url);
    assert.match(f.messages.at(-1), /探索页轮播第 1 张.*HTTPS/);
  }
  b.linkUrl = " https://example.com/travel?id=123&from=banner#detail ";
  assert.equal(await f.editor.saveBanners(), true);
  assert.equal(b.linkUrl, "https://example.com/travel?id=123&from=banner#detail");
  assert.match(f.editor.jumpLabel(b), /example.com\/travel/);
  b.linkUrl = "https://旅拍.example/灵感?id=123";
  assert.equal(await f.editor.saveBanners(), true);
  assert.equal(new URL(b.linkUrl).hostname.startsWith("xn--"), true);
  assert.match(b.linkUrl, /%E7%81%B5/);
  b.targetType = "package";
  f.editor.changeBannerTarget(b);
  assert.equal(b.linkUrl, "");
  assert.equal(b.targetId, "");
});
