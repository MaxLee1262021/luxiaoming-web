"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

function fixture() {
  const uploads = [];
  const window = { LXM_APP_PARTS: [], LXM_UPLOAD: { ready: () => true, busy: () => false, pick: (options) => uploads.push(options) } };
  const computed = (definition) => typeof definition === "function" ? { get value() { return definition(); } }
    : { get value() { return definition.get(); }, set value(value) { definition.set(value); } };
  const ctx = {
    computed, reactive: (value) => value, can: () => true, ElMessage: { warning() {}, success() {}, error() {} },
    activeMenu: { value: { label: "旅拍灵感" } }, log() {},
    state: { active: "guides", editContent: {} }, contentKeys: ["guides", "spots", "albums", "packages"],
    data: {
      spots: [{ id: "spot" }, { id: "other" }], series: [{ id: "style", spotIds: ["spot"] }], cities: [], samples: [], peripherals: [],
      albums: [{ id: "photo", name: "照片", seriesId: "style", status: "上架" }],
      packages: [
        { id: "package", name: "套餐", spotIds: ["spot", "other"], status: "上架" },
        { id: "video", name: "短片", spotId: "spot", type: "video", isVideoSingle: true, status: "上架" },
        { id: "wrong", spotId: "other", status: "上架" },
        { id: "offline", spotId: "spot", status: "下架" }
      ], guides: []
    }
  };
  const sandbox = { window, console };
  for (const file of ["12-content-edit.js", "18-files.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox);
    Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
  }
  return { ctx, uploads };
}

test("guide editor limits products to its point and clears selection on point changes", () => {
  const { ctx } = fixture();
  ctx.state.editContent = { __key: "guides", spotId: "spot" };
  assert.deepEqual(Array.from(ctx.guideProductOptions.value, (item) => item.value), ["album:photo", "package:package", "video:video"]);
  ctx.guideTargetValue.value = "album:photo";
  assert.equal(ctx.state.editContent.targetProductId, "photo");
  ctx.state.editContent.spotId = "other";
  ctx.changeGuideSpot();
  assert.equal(ctx.guideTargetValue.value, "");
  assert.equal(ctx.state.editContent.targetPackageId, "");
  assert.deepEqual(Array.from(ctx.guideProductOptions.value, (item) => item.id), ["package", "wrong"]);
});

test("upload callback preserves extensionless video type and editing media does not mutate saved content", () => {
  const { ctx, uploads } = fixture();
  const original = { id: "g", __key: "guides", title: "灵感", spotId: "spot", mediaType: "image", mediaItems: [{ url: "https://test.invalid/image", type: "image" }] };
  ctx.state.editContent = { ...original, mediaItems: original.mediaItems.map((item) => ({ ...item })) };
  ctx.removeGuideMedia(0);
  assert.equal(original.mediaItems.length, 1);
  ctx.state.editContent.mediaType = "video";
  ctx.contentFile(ctx.state.editContent, "mediaUrls", "guides", true, false);
  uploads[0].onUploaded({ url: "/api/media/file_123", type: "video" });
  assert.equal(ctx.state.editContent.mediaItems[0].type, "video");
  assert.equal(ctx.state.editContent.mediaUrls[0], "/api/media/file_123");
  uploads[0].onUploaded({ url: "/api/media/file_456", type: "video" });
  assert.equal(ctx.state.editContent.mediaItems.length, 2);
});

test("guide editing opens its dedicated page without changing the shared content form", () => {
  const { ctx } = fixture();
  const guide = { id: "guide", title: "旅拍灵感", spotIds: ["spot", "other"] };
  ctx.data.guides.push(guide);
  ctx.state.active = "spots";
  ctx.state.contentDialog = true;
  const originalForm = { name: "未保存的打卡点" };
  ctx.state.editContent = originalForm;
  ctx.openContent(guide);
  assert.equal(ctx.state.active, "guides");
  assert.equal(ctx.state.contentDialog, false);
  assert.equal(ctx.state.guideEditorRequest.row, guide);
  assert.equal(ctx.state.editContent, originalForm);
  const previousRequest = ctx.state.guideEditorRequest;
  ctx.openContent({ __key: "guides", __source: guide });
  assert.equal(ctx.state.guideEditorRequest.row, guide);
  assert.notEqual(ctx.state.guideEditorRequest, previousRequest);
});

test("new guides forward point relations to the dedicated editor, including point-page shortcuts", () => {
  const { ctx } = fixture();
  ctx.state.active = "spots";
  const relations = { spotId: "other", keepInSpot: true };
  ctx.openContentQuick("guides", relations);
  assert.equal(ctx.state.active, "guides");
  assert.equal(ctx.state.contentDialog, false);
  assert.equal(ctx.state.guideEditorRequest.row, null);
  assert.equal(ctx.state.guideEditorRequest.relations.spotId, "other");
  assert.equal(ctx.state.guideEditorRequest.relations.keepInSpot, undefined);
  assert.equal(relations.keepInSpot, true);
  ctx.openContent();
  assert.equal(ctx.state.guideEditorRequest.row, null);
});

test("guide visibility accepts rich text-only and media-only notes without applying the retired editor's media requirements", () => {
  const { ctx } = fixture();
  for (const content of [
    { contentHtml: "<p>正文分享</p>", content: "正文分享", mediaItems: [] },
    { contentHtml: '<p><img src="/api/media/image"></p>', content: "", mediaItems: [{ url: "/api/media/image", type: "image" }] },
    { contentHtml: '<video src="/api/media/video"></video>', content: "", mediaItems: [{ url: "/api/media/video", type: "video" }] },
    { content: "历史内容" }
  ]) {
    const previous = { id: "guide", status: "已发布", isShow: false, ...content };
    assert.equal(ctx.validateContentPublishing("guides", { ...previous, isShow: true }, previous), "");
  }
});

test("opening the guide module loads its product and style dependencies", () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/config/api.js"), "utf8"), { window });
  const config = window.LXM_API_CONFIG;
  const lists = Object.values(config).find((value) => value && Array.isArray(value.guides));
  assert.ok(lists, "module data requirements are defined");
  for (const key of ["guides", "spots", "series", "albums", "packages"]) assert.ok(lists.guides.includes(key), key);
});
