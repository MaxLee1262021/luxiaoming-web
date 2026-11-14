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
