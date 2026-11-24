"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function fixture(config = {}, options = {}) {
  const writes = [], messages = [], mounts = [];
  let stored = structuredClone(config), failedLoad = options.failedLoad, failedSave = false;
  const Vue = { ref: value => ({ value }), reactive: value => value,
    computed: getter => ({ get value() { return getter(); } }), onMounted: callback => mounts.push(callback) };
  const ctx = { data: {}, state: { siteConfig: {} }, can: () => options.editable !== false, isServerConnected: () => options.connected !== false,
    ElMessage: Object.fromEntries(["warning", "error", "success"].map(type => [type, value => messages.push({ type, value })])) };
  const window = { Vue, LXM_PAGES: { register(page) { window.page = page; } }, LXM_CLOUD: {
    async loadMenuData(key, data, state) { assert.equal(key, "bookingConfig"); if (failedLoad) return { ok: true, failed: ["siteConfig"], loaded: [] }; state.siteConfig = structuredClone(stored); return { ok: true, loaded: ["siteConfig"] }; },
    async upsertDoc(key, id, value) { assert.equal(key, "siteConfig"); assert.equal(id, "global"); writes.push(structuredClone(value)); if (failedSave) throw new Error("离线"); stored = { ...stored, ...value }; return { id: "global", ...value }; }
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../views/operationConfig/booking-config/booking-config.js"), "utf8"), { window });
  const page = window.page.setup(ctx);
  return { page, ctx, writes, messages, mount: async () => { for (const callback of mounts) await callback(); }, failLoad: value => { failedLoad = value; }, failSave: () => { failedSave = true; } };
}
const valid = { customPrice: { depositRatio: 0.3 }, bookingNotice: ["实际预约规则"], bookingNoticeVersion: "v1" };
test("unconfigured booking page has no invented pricing or consent and requires a default ratio", async () => {
  const f = fixture(); await f.mount();
  assert.equal(f.page.form.depositRatioPercent, undefined); assert.equal(f.page.form.version, ""); assert.equal(f.page.ready.value, false);
  await f.page.saveConfig(); assert.equal(f.writes.length, 0);
  Object.assign(f.page.form, { depositRatioPercent: 30, notice: "实际预约规则", version: "v1" });
  await f.page.saveConfig(); assert.equal(f.writes[0].customPrice.depositRatio, 0.3); assert.equal(f.writes[0].customPrice.single, null);
});
test("saving 1% and zero uses canonical ratios and excludes unrelated site secrets", async () => {
  for (const percent of [0, 1, 0.5, 30, 100]) {
    const f = fixture({ ...valid, wechat: { secret: "test-only" }, privacyText: "private-config", customPrice: { depositRatio: 30 } }); await f.mount();
    assert.equal(f.page.form.depositRatioPercent, 30);
    f.page.form.depositRatioPercent = percent; await f.page.saveConfig();
    assert.equal(f.writes[0].customPrice.depositRatio, percent / 100);
    assert.equal(Object.hasOwn(f.writes[0], "wechat"), false); assert.equal(Object.hasOwn(f.writes[0], "privacyText"), false);
    assert.equal(f.ctx.state.siteConfig.privacyText, "private-config");
  }
});
test("changed consent text requires a new version and persists nonempty trimmed lines", async () => {
  const f = fixture(valid); await f.mount(); f.page.form.notice = " 第一条 \n\n 第二条 ";
  await f.page.saveConfig(); assert.equal(f.writes.length, 0); assert.match(f.messages.at(-1).value, /更新须知版本/);
  f.page.form.version = "v2"; await f.page.saveConfig();
  assert.deepEqual(f.writes[0].bookingNotice, ["第一条", "第二条"]); assert.equal(f.writes[0].bookingNoticeVersion, "v2");
});
test("load failures, read-only roles and unavailable connections cannot save stale data", async () => {
  for (const options of [{ failedLoad: true }, { editable: false }, { connected: false }]) {
    const f = fixture(valid, options); await f.mount(); await f.page.saveConfig(); assert.equal(f.writes.length, 0);
  }
  const f = fixture(valid, { failedLoad: true }); await f.mount(); assert.ok(f.page.loadError.value);
  f.failLoad(false); await f.page.loadConfig(); assert.equal(f.page.loadError.value, ""); await f.page.saveConfig(); assert.equal(f.writes.length, 1);
});
test("failed writes retain draft edits and do not announce success", async () => {
  const f = fixture(valid); await f.mount(); f.failSave(); f.page.form.depositRatioPercent = 50;
  await f.page.saveConfig(); assert.equal(f.page.form.depositRatioPercent, 50); assert.equal(f.ctx.state.siteConfig.customPrice.depositRatio, 0.3);
  assert.equal(f.messages.some(message => message.type === "success"), false);
});
test("clearing custom pricing does not resurrect legacy aliases in the editor", async () => {
  const f = fixture({ ...valid, customPrice: { depositRatio: 0.3, singlePersonPrice: 100, perExtraPerson: 20 } }); await f.mount();
  assert.equal(f.page.form.single, 100);
  f.page.form.single = undefined; f.page.form.extraPerPerson = undefined; await f.page.saveConfig();
  assert.equal(f.page.form.single, undefined); assert.equal(f.page.form.extraPerPerson, undefined);
});
test("optional custom base pricing must be positive, while extra-person pricing can be zero", async () => {
  const f = fixture(valid); await f.mount(); f.page.form.single = 0;
  await f.page.saveConfig(); assert.equal(f.writes.length, 0);
  f.page.form.single = 0.01; f.page.form.extraPerPerson = 0;
  await f.page.saveConfig(); assert.equal(f.writes[0].customPrice.single, 0.01); assert.equal(f.writes[0].customPrice.extraPerPerson, 0);
});
test("privacy can be saved independently before booking settings exist, and reloaded", async () => {
  const f = fixture(); await f.mount();
  assert.equal(f.page.privacyForm.title, "隐私政策"); assert.equal(f.page.privacyForm.content, "");
  await f.page.savePrivacyConfig(); assert.equal(f.writes.length, 0);
  Object.assign(f.page.privacyForm, { title: " 测试政策标题 ", content: " 测试第一段\n\n测试第二段 " });
  await f.page.savePrivacyConfig();
  assert.deepEqual(f.writes, [{ privacyPolicy: { title: "测试政策标题", content: "测试第一段\n\n测试第二段" } }]);
  assert.equal(f.page.form.depositRatioPercent, undefined); assert.equal(f.page.form.version, "");
  f.page.privacyForm.content = "未保存草稿"; await f.page.loadConfig();
  assert.equal(f.page.privacyForm.content, "测试第一段\n\n测试第二段");
});
test("each save preserves the other form's unsaved draft and stored fields", async () => {
  const f = fixture({ ...valid, privacyPolicy: { title: "旧标题", content: "旧正文" } }); await f.mount();
  f.page.form.notice = "待保存须知"; f.page.form.version = "v2";
  f.page.privacyForm.content = "新隐私正文"; await f.page.savePrivacyConfig();
  assert.equal(f.page.form.notice, "待保存须知"); assert.equal(f.page.form.version, "v2");
  assert.equal(f.ctx.state.siteConfig.bookingNoticeVersion, "v1");
  f.page.privacyForm.content = "待保存隐私草稿"; await f.page.saveConfig();
  assert.equal(f.page.privacyForm.content, "待保存隐私草稿");
  assert.equal(f.ctx.state.siteConfig.privacyPolicy.content, "新隐私正文");
  assert.equal(Object.hasOwn(f.writes[1], "privacyPolicy"), false);
});
test("privacy editor reads legacy text and structured policies without restoring explicitly empty content", async () => {
  for (const [config, expected] of [
    [{ privacyText: "历史正文" }, "历史正文"],
    [{ privacyPolicy: { title: "结构标题", sections: [{ title: "分节", paragraphs: ["第一段", "第二段"] }, null, { paragraphs: [], content: "第三段" }] } }, "分节\n第一段\n第二段\n\n第三段"],
    [{ privacyText: "过期正文", privacyPolicy: { content: "当前正文", sections: [{ paragraphs: ["过期段落"] }] } }, "当前正文"],
    [{ privacyText: "过期正文", privacyPolicy: { content: "" } }, ""]
  ]) {
    const f = fixture(config); await f.mount(); assert.equal(f.page.privacyForm.content, expected);
  }
});
test("privacy rejects empty and oversized input and respects load, role and connection guards", async () => {
  const policy = { privacyPolicy: { title: "测试标题", content: "测试正文" } };
  for (const fields of [{ title: " " }, { content: "\n " }, { title: "字".repeat(129) }, { content: "字".repeat(20001) }]) {
    const f = fixture(policy); await f.mount(); Object.assign(f.page.privacyForm, fields);
    await f.page.savePrivacyConfig(); assert.equal(f.writes.length, 0);
  }
  for (const options of [{ failedLoad: true }, { editable: false }, { connected: false }]) {
    const f = fixture(policy, options); await f.mount(); await f.page.savePrivacyConfig(); assert.equal(f.writes.length, 0);
  }
});
test("failed privacy saves retain the draft and previously stored policy", async () => {
  const f = fixture({ privacyPolicy: { title: "测试标题", content: "旧正文" } }); await f.mount();
  f.failSave(); f.page.privacyForm.content = "尚未保存的新正文"; await f.page.savePrivacyConfig();
  assert.equal(f.page.privacyForm.content, "尚未保存的新正文"); assert.equal(f.ctx.state.siteConfig.privacyPolicy.content, "旧正文");
  assert.equal(f.page.privacySaving.value, false); assert.equal(f.messages.some(message => message.type === "success"), false);
});
test("success tips save independently, preserve line breaks, reload and can be cleared", async () => {
  const f = fixture(); await f.mount();
  assert.equal(f.page.tipsForm.content, "");
  f.page.tipsForm.content = " 第一段\r\n\r\n第二段 "; await f.page.saveSuccessTips();
  assert.deepEqual(f.writes, [{ bookingSuccessTips: "第一段\n\n第二段" }]);
  assert.equal(f.page.form.version, ""); assert.equal(f.page.form.depositRatioPercent, undefined);
  f.page.tipsForm.content = "未保存草稿"; await f.page.loadConfig();
  assert.equal(f.page.tipsForm.content, "第一段\n\n第二段");
  f.page.tipsForm.content = "\n "; await f.page.saveSuccessTips(); await f.page.loadConfig();
  assert.equal(f.writes[1].bookingSuccessTips, ""); assert.equal(f.page.tipsForm.content, "");
});

test("independent saves preserve stored success tips and drafts in the other editors", async () => {
  const f = fixture({ ...valid, bookingSuccessTips: "原提示", privacyPolicy: { title: "隐私", content: "原隐私" } }); await f.mount();
  f.page.form.notice = "须知草稿"; f.page.form.version = "v2"; f.page.privacyForm.content = "隐私草稿";
  f.page.tipsForm.content = "新提示"; await f.page.saveSuccessTips();
  assert.equal(f.page.form.notice, "须知草稿"); assert.equal(f.page.privacyForm.content, "隐私草稿");
  assert.equal(f.ctx.state.siteConfig.bookingNoticeVersion, "v1"); assert.equal(f.ctx.state.siteConfig.privacyPolicy.content, "原隐私");
  f.page.tipsForm.content = "提示草稿"; await f.page.saveConfig(); await f.page.savePrivacyConfig();
  assert.equal(f.page.tipsForm.content, "提示草稿"); assert.equal(f.ctx.state.siteConfig.bookingSuccessTips, "新提示");
  assert.equal(Object.hasOwn(f.writes[1], "bookingSuccessTips"), false); assert.equal(Object.hasOwn(f.writes[2], "bookingSuccessTips"), false);
});

test("success tips enforce size, role, load and connection guards", async () => {
  for (const options of [{ failedLoad: true }, { editable: false }, { connected: false }]) {
    const f = fixture({ bookingSuccessTips: "原提示" }, options); await f.mount();
    f.page.tipsForm.content = "新提示"; await f.page.saveSuccessTips(); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); await f.mount(); f.page.tipsForm.content = "字".repeat(20001);
  await f.page.saveSuccessTips(); assert.equal(f.writes.length, 0);
  f.page.tipsForm.content = "字".repeat(20000); await f.page.saveSuccessTips(); assert.equal(f.writes.length, 1);
});

test("failed success tips saves retain the draft and previous stored content", async () => {
  const f = fixture({ bookingSuccessTips: "原提示" }); await f.mount(); f.failSave(); f.page.tipsForm.content = "新提示";
  await f.page.saveSuccessTips();
  assert.equal(f.page.tipsForm.content, "新提示"); assert.equal(f.ctx.state.siteConfig.bookingSuccessTips, "原提示");
  assert.equal(f.page.tipsSaving.value, false); assert.equal(f.messages.some(message => message.type === "success"), false);
});

test("a success tips save blocks duplicate saves, unrelated writes and reloads while pending", async () => {
  const f = fixture({ ...valid, privacyPolicy: { title: "隐私", content: "正文" } }); await f.mount();
  f.page.tipsForm.content = "新提示";
  const pending = f.page.saveSuccessTips(); assert.equal(f.page.busy.value, true);
  await Promise.all([f.page.saveSuccessTips(), f.page.saveConfig(), f.page.savePrivacyConfig(), f.page.loadConfig()]);
  await pending; assert.equal(f.writes.length, 1); assert.equal(f.page.tipsForm.content, "新提示"); assert.equal(f.page.busy.value, false);
});

test("a content account granted only booking settings can edit them without unrelated content menus", () => {
  const window = { LXM_APP_PARTS: [] };
  const state = { role: "content" }, roleProfile = { value: { menus: ["bookingConfig"] } };
  const sandbox = { window, LXM_CONFIG: { menus: [{ key: "bookingConfig" }] } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../app/02-order-basis.js"), "utf8"), sandbox);
  const part = window.LXM_APP_PARTS.pop()({ state, roleProfile, computed: getter => ({ get value() { return getter(); } }), data: {} });
  assert.equal(part.can("contentEdit"), true);
  roleProfile.value.menus = []; assert.equal(part.can("contentEdit"), false);
  roleProfile.value.menus = ["bookingConfig"]; state.role = "service"; assert.equal(part.can("contentEdit"), false);
});
