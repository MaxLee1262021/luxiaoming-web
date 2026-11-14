"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createSvcMemoryStore } = require("../../server/lib/svcStore.cjs");
const { createSvcCommission } = require("../../server/lib/svcCommission.cjs");
const root = path.resolve(__dirname, "../.."), source = fs.readFileSync(path.join(root, "src/api/svc-commission-ui.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const initial = {
  staff: [{ id: "s1", name: "客服甲", phone: "13900000001", rate_mode: "custom", staff_status: "active" }],
  rules: [
    { id: "1", ver: 1, beneficiary_type: "service", party_id: null, rule_mode: "global", rate_photo_bp: 500, rate_video_bp: 1000, rate_combo_bp: 800, rate_peripheral_bp: 1500, eff_at: "2026-11-01 00:00:00" },
    { id: "2", ver: 2, beneficiary_type: "service", party_id: "s1", rule_mode: "custom", rate_photo_bp: 500, rate_video_bp: 500, rate_combo_bp: 500, rate_peripheral_bp: 1000, eff_at: "2026-11-01 00:00:00" }
  ]
};
function fixture(shared) {
  const store = shared?.store || createSvcMemoryStore(initial), control = shared?.control || { now: "2026-11-13 12:00:00", failPost: false, holdPost: null }, requests = [], messages = [];
  const commission = createSvcCommission({ store, clock: () => control.now });
  const Vue = { reactive: v => v, computed: fn => ({ get value() { return fn(); } }), watch() {}, onMounted() {}, onUnmounted() {} };
  const window = { LXM_HTTP: { async request(url, init = {}) {
    const parsed = new URL(url, "http://test.invalid"), method = init.method || "GET", body = init.body ? JSON.parse(init.body) : Object.fromEntries(parsed.searchParams);
    requests.push({ method, url, body });
    if (method === "POST" && control.holdPost) await control.holdPost;
    if (method === "POST" && control.failPost) return { ok: true, json: async () => ({ code: 5008, msg: "单人比例必须四类一次给全" }) };
    try {
      const data = await commission.execute(method, parsed.pathname, body, { kind: "admin", role: "super", authzUserId: "qa-admin" });
      return { ok: true, json: async () => ({ code: 0, data: plain(data) }) };
    } catch (error) { return { ok: true, json: async () => ({ code: error.code || 5000, msg: error.message }) }; }
  } } };
  const ctx = { state: { role: "super", active: "svcStaff" }, ElMessage: Object.fromEntries(["success", "error", "warning"].map(kind => [kind, text => messages.push({ kind, text })])), ElMessageBox: { async confirm() {} } };
  vm.runInNewContext(source, { window, Vue, URLSearchParams, Intl, Date, setTimeout, clearTimeout });
  return { ui: window.LXM_SVC_COMMISSION_SETUP(ctx, "staff"), store, control, requests, messages, commission };
}
const values = { photo_bp: 1200, video_bp: 1300, combo_bp: 1400, peripheral_bp: 1600 };

test("saving a staff rate reloads the list and open detail with the saved next-day values", async () => {
  const f = fixture(); await f.ui.svcLoad();
  assert.equal(f.ui.svcStaffRate(f.ui.svc.rows[0], "photo"), 500);
  await f.ui.svcViewStaff(f.ui.svc.rows[0]); assert.equal(f.ui.svc.drawer, true);
  await f.ui.svcOpen("rate", f.ui.svc.current);
  Object.assign(f.ui.svc.form, { rate_mode: "custom", rates: { ...values }, reason: "更新合作条件" });
  await f.ui.svcSubmit();
  const row = f.ui.svc.rows[0];
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  assert.equal(f.ui.svc.dialog, ""); assert.equal(f.ui.svc.drawer, true);
  assert.equal(f.ui.svcStaffRate(row, "photo"), 1200); assert.equal(row.rates.rate_photo_bp, 500);
  assert.equal(f.ui.svcStaffRate(f.ui.svc.current, "video"), 1300); assert.equal(f.ui.svc.current.detail_kind, "staff");
  assert.equal(row.rate_pending, true); assert.equal(row.rate_effective_at, "2026-11-14 00:00:00");
  assert.equal(f.ui.svc.current.rate_effective_at, row.rate_effective_at);
  assert.equal(f.ui.svcStaffRateMode(row), "custom");
  assert.match(f.ui.svcRateSummary(row), /照片 12.0%.*视频 13.0%.*套餐 14.0%.*周边 16.0%/);
  assert.equal(f.ui.svcStaffVersions.value.filter(version => Number(version.ver) === 3).length, 1);
  const restarted = fixture(f); await restarted.ui.svcLoad();
  assert.equal(restarted.ui.svcStaffRate(restarted.ui.svc.rows[0], "photo"), 1200);
  f.control.now = "2026-11-14 00:00:00"; await restarted.ui.svcLoad();
  assert.equal(restarted.ui.svc.rows[0].rate_pending, false); assert.equal(restarted.ui.svc.rows[0].rates.rate_photo_bp, 1200);
});

test("drawer save and return to global update the list, mode and editor from the server projection", async () => {
  const f = fixture(); await f.ui.svcLoad(); await f.ui.svcViewStaff(f.ui.svc.rows[0]);
  f.ui.svcStaffRateForm.rates = { ...values }; f.ui.svcStaffRateForm.reason = "个人专项比例";
  await f.ui.svcSaveDrawerRate("custom");
  assert.equal(f.ui.svcStaffRate(f.ui.svc.rows[0], "combo"), 1400);
  assert.equal(f.ui.svcStaffRate(f.ui.svc.current, "combo"), 1400);
  f.ui.svcStaffRateForm.reason = "恢复统一比例"; await f.ui.svcSaveDrawerRate("global");
  assert.equal(f.ui.svcStaffRateMode(f.ui.svc.rows[0]), "global");
  assert.equal(f.ui.svcStaffRateMode(f.ui.svc.current), "global");
  assert.equal(f.ui.svcStaffRate(f.ui.svc.rows[0], "video"), 1000); assert.equal(f.ui.svc.rows[0].rates.rate_video_bp, 500);
  assert.equal(f.ui.svcStaffRateForm.rate_mode, "global"); assert.equal(f.ui.svcStaffRateForm.rates.video_bp, 1000);
  assert.equal(f.ui.svcStaffVersions.value.filter(version => Number(version.ver) === 4).length, 1);
  await f.ui.svcOpen("rate", f.ui.svc.rows[0]);
  assert.equal(f.ui.svc.form.rate_mode, "global"); assert.equal(f.ui.svc.form.rates.video_bp, 1000);
});

test("a global marker cannot replace newer projected unified values when the editor loads rule history", async () => {
  const f = fixture();
  await f.commission.execute("POST", "/staff/s1/rate", { rate_mode: "global", reason: "恢复统一" }, { kind: "admin", role: "super" });
  await f.commission.execute("POST", "/rule", { ver: 3, rates: { photo_bp: 600, video_bp: 1700, combo_bp: 1800, peripheral_bp: 1900 }, reason: "同步更新统一比例" }, { kind: "admin", role: "super" });
  await f.ui.svcLoad(); assert.equal(f.ui.svcStaffRate(f.ui.svc.rows[0], "video"), 1700);
  await f.ui.svcOpen("rate", f.ui.svc.rows[0]);
  assert.equal(f.ui.svc.form.rate_mode, "global"); assert.equal(f.ui.svc.form.rates.video_bp, 1700);
  await f.ui.svcViewStaff(f.ui.svc.rows[0]);
  assert.equal(f.ui.svcStaffRateForm.rates.video_bp, 1700); assert.equal(f.ui.svcStaffRate(f.ui.svc.current, "video"), 1700);
});

test("failed rate persistence preserves list and detail, and repeated clicks cannot create two versions", async () => {
  const f = fixture(); await f.ui.svcLoad(); await f.ui.svcViewStaff(f.ui.svc.rows[0]);
  const beforeRows = plain(f.ui.svc.rows), beforeCurrent = plain(f.ui.svc.current), beforeStore = f.store.snapshot();
  await f.ui.svcOpen("rate", f.ui.svc.current); f.ui.svc.form.rates = { ...values }; f.ui.svc.form.reason = "测试保存失败"; f.control.failPost = true;
  await f.ui.svcSubmit();
  assert.deepEqual(plain(f.ui.svc.rows), beforeRows); assert.deepEqual(plain(f.ui.svc.current), beforeCurrent); assert.deepEqual(f.store.snapshot(), beforeStore);
  assert.equal(f.ui.svc.dialog, "rate"); assert.equal(f.ui.svc.form.rates.photo_bp, 1200); assert.equal(f.messages.at(-1).kind, "error");
  f.control.failPost = false; let release; f.control.holdPost = new Promise(resolve => { release = resolve; });
  const saving = f.ui.svcSubmit(); await f.ui.svcSubmit(); assert.equal(f.requests.filter(r => r.method === "POST").length, 2);
  release(); await saving; assert.equal(f.store.snapshot().rules.length, beforeStore.rules.length + 1);
});

test("staff list and detail explicitly identify pending values and display their server effective time", () => {
  const staffHtml = fs.readFileSync(path.join(root, "src/views/service/staff/staff.html"), "utf8");
  assert.match(staffHtml, /svcStaffRateMode\(row\)/); assert.match(staffHtml, /v-if="row.rate_pending"[^>]*>待生效/);
  assert.match(staffHtml, /svcTime\(row.rate_effective_at\)/);
  for (const slug of ["staff", "rules", "ledger", "settlements", "new-staff", "mine"]) {
    const html = fs.readFileSync(path.join(root, "src/views/service", slug, slug + ".html"), "utf8");
    assert.match(html, /v-if="svc.current.rate_pending"[^>]*>待生效/, slug);
    assert.match(html, /svcTime\(svc.current.rate_effective_at\)/, slug); assert.match(html, /label="当前生效比例"/, slug);
  }
});
