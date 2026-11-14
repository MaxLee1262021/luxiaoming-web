"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const C = require("../lib/svcCommission.cjs"), B = require("../lib/svcBenefit.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const admin = { kind: "admin", role: "super", authzUserId: "root" };
const rates = photo => ({ rate_photo_bp: photo, rate_video_bp: photo + 100, rate_combo_bp: photo + 200, rate_peripheral_bp: photo + 300 });
const fields = row => Object.fromEntries(B.CATEGORIES.map(key => ["rate_" + key + "_bp", row["rate_" + key + "_bp"]]));
function seed() {
  return { staff: [
    { id: "a", name: "客服甲", staff_status: "active", account_id: "a-account", supervisor_id: "lead", rate_mode: "custom", base_salary: 0 },
    { id: "b", name: "客服乙", staff_status: "active", account_id: "b-account", rate_mode: "global", base_salary: 0 },
    { id: "lead", name: "主管", staff_status: "active", account_id: "lead-account", rate_mode: "global", base_salary: 0 },
  ], rules: [
    { id: "1", ver: 1, beneficiary_type: "service", party_id: null, rule_mode: "global", ...rates(300), eff_at: "2026-10-01 00:00:00" },
    { id: "2", ver: 2, beneficiary_type: "service", party_id: "a", rule_mode: "custom", ...rates(400), eff_at: "2026-10-01 00:00:00" },
  ] };
}
function fixture(initial = seed()) {
  let now = "2026-11-13 12:00:00";
  const store = createSvcMemoryStore(initial), app = C.createSvcCommission({ store, clock: () => now });
  return { store, app, at(value) { now = value; },
    async rows(session = admin) { return (await app.execute("GET", "/api/svc/staff", {}, session)).list; },
    async row(id = "a") { return (await this.rows()).find(row => row.id === id); },
    async save(id, photo, mode = "custom") { return app.execute("POST", "/staff/" + id + "/rate", { rates: rates(photo), rate_mode: mode, reason: "QA比例调整" }, admin); },
    async saveGlobal(photo) { const ver = Math.max(...store.snapshot().rules.map(row => Number(row.ver))); return app.execute("POST", "/rule", { rates: rates(photo), ver, reason: "QA统一比例调整" }, admin); },
  };
}
function payment(no, paidAt, staff = "a") { return { order_no: no, assignee_id: staff, category: "photo", net_amount_fen: 10000, service_net_amount_fen: 10000, paid_at: paidAt, service_status: "claimed" }; }

test("a saved personal rate appears immediately while payment snapshots keep the effective rate", async () => {
  const f = fixture();
  await f.store.transaction(state => { C.ensureLedger(state, payment("before-save", "2026-11-13 11:00:00"), "2026-11-13 11:00:00"); });
  const oldLedger = f.store.snapshot().ledger[0];
  const saved = await f.save("a", 900), row = await f.row();
  assert.deepEqual(fields(row.configured_rates), rates(900)); assert.deepEqual(fields(row.rates), rates(400));
  assert.equal(row.rate_pending, true); assert.equal(row.rate_effective_at, "2026-11-14 00:00:00");
  assert.equal(row.configured_rates.ver, saved.ver); assert.equal(row.configured_rates.rule_mode, "custom");
  const reload = C.createSvcCommission({ store: f.store, clock: () => "2026-11-13 23:59:59" });
  assert.equal((await reload.execute("GET", "/api/svc/staff", {}, admin)).list.find(item => item.id === "a").configured_rates.rate_photo_bp, 900);
  await f.store.transaction(state => {
    assert.equal(C.ensureLedger(state, payment("before-midnight", "2026-11-13 23:59:59"), "2026-11-13 23:59:59").rate_bp, 400);
    assert.equal(C.ensureLedger(state, payment("at-midnight", "2026-11-14 00:00:00"), "2026-11-14 00:00:00").rate_bp, 900);
  });
  assert.deepEqual(f.store.snapshot().ledger[0], oldLedger);
  f.at("2026-11-14 00:00:00"); const active = await f.row();
  assert.equal(active.rate_pending, false); assert.deepEqual(fields(active.rates), rates(900)); assert.deepEqual(fields(active.configured_rates), rates(900));
});

test("multiple same-day saves show the latest version and advance at the same next-midnight boundary", async () => {
  const f = fixture(), first = await f.save("a", 800), second = await f.save("a", 900);
  assert.equal(first.eff_at, second.eff_at); assert.ok(second.ver > first.ver);
  await f.store.transaction(state => { state.rules.reverse(); });
  assert.equal((await f.row()).configured_rates.ver, second.ver);
  f.at("2026-11-14 00:00:00"); assert.equal((await f.row()).rates.ver, second.ver);
  const third = await f.save("a", 1000), fourth = await f.save("a", 1100);
  const next = await f.row(); assert.equal(next.configured_rates.ver, fourth.ver); assert.equal(next.rates.ver, second.ver);
  assert.equal(next.rate_effective_at, "2026-11-15 00:00:00"); assert.equal(third.eff_at, fourth.eff_at);
  f.at("2026-11-15 00:00:00"); const active = await f.row(); assert.equal(active.rates.ver, fourth.ver); assert.equal(active.rate_pending, false);
});

test("return-to-global display resolves the global rule instead of the marker historical snapshot", async () => {
  const f = fixture();
  const global = await f.saveGlobal(600), marker = await f.save("a", 9990, "global");
  assert.equal(marker.rate_photo_bp, 300, "the append-only marker snapshots today's common settings");
  const row = await f.row(); assert.deepEqual(fields(row.configured_rates), rates(600));
  assert.equal(row.configured_rates.ver, global.ver); assert.equal(row.configured_rates.rule_mode, "global");
  assert.deepEqual(fields(row.rates), rates(400)); assert.equal(row.rate_pending, true);
  assert.equal(row.rate_effective_at, marker.eff_at);
  f.at("2026-11-14 00:00:00"); const active = await f.row();
  assert.deepEqual(fields(active.rates), rates(600)); assert.equal(active.rate_pending, false);
  const nextGlobal = await f.saveGlobal(700); assert.deepEqual(fields((await f.row()).configured_rates), rates(700));
  assert.equal((await f.row()).rate_effective_at, nextGlobal.eff_at);
});

test("return-to-global retains the transition date even when the common rule is already active", async () => {
  const f = fixture(), marker = await f.save("a", 0, "global"), row = await f.row();
  assert.deepEqual(fields(row.configured_rates), rates(300)); assert.equal(row.configured_rates.rule_mode, "global");
  assert.equal(row.rate_effective_at, marker.eff_at); assert.equal(row.configured_rates.eff_at, marker.eff_at); assert.equal(row.rate_pending, true);
  assert.equal(row.rates.rule_mode, "custom");
  f.at(marker.eff_at); assert.equal((await f.row()).rate_pending, false); assert.equal((await f.row()).rates.rule_mode, "global");
});

test("global followers preview common changes and switching to custom stays isolated from other staff", async () => {
  const f = fixture(), common = await f.saveGlobal(700);
  const before = await f.row("b"); assert.deepEqual(fields(before.rates), rates(300)); assert.deepEqual(fields(before.configured_rates), rates(700));
  assert.equal(before.rate_effective_at, common.eff_at); assert.equal(before.rate_pending, true);
  assert.equal((await f.row("a")).rate_pending, false); assert.deepEqual(fields((await f.row("a")).configured_rates), rates(400));
  const saved = await f.save("b", 1200); const row = await f.row("b");
  assert.deepEqual(fields(row.configured_rates), rates(1200)); assert.equal(row.configured_rates.rule_mode, "custom");
  assert.equal(row.configured_rates.ver, saved.ver); assert.deepEqual(fields(row.rates), rates(300));
  await f.store.transaction(state => { state.rules.push({ ...saved, id: "unrelated-photo", ver: 999, beneficiary_type: "photo", ...rates(1500), eff_at: "2026-12-01 00:00:00" }); });
  assert.deepEqual(fields((await f.row("b")).configured_rates), rates(1200));
  const scope = await f.rows({ kind: "admin", role: "service_supervisor", authzUserId: "lead-account" });
  assert.deepEqual(scope.map(item => item.id).sort(), ["a", "lead"]);
  assert.ok(scope.every(item => item.configured_rates.party_id !== "b"));
  await assert.rejects(f.app.execute("GET", "/staff", {}, { kind: "admin", role: "service", authzUserId: "a-account" }), { code: 4030 });
});

test("a newly created pending-only custom profile shows its saved rates without fabricating an active rule", async () => {
  const f = fixture({ staff: [], rules: [] });
  const created = await f.app.execute("POST", "/staff", { name: "新客服", phone: "13900139200", joined_at: "2026-11-13", base_salary: 0, rate_mode: "custom", rates: rates(900) }, admin);
  const row = await f.row(created.id); assert.equal(row.rates, null);
  assert.deepEqual(fields(row.configured_rates), rates(900)); assert.equal(row.rate_pending, true); assert.equal(row.rate_effective_at, "2026-11-14 00:00:00");
  f.at("2026-11-14 00:00:00"); assert.deepEqual(fields((await f.row(created.id)).rates), rates(900));
});

test("missing rules remain absent and a pending global marker cannot borrow another staff custom rates", async () => {
  const f = fixture({ staff: seed().staff, rules: [{ ...seed().rules[1], eff_at: "2026-11-14 00:00:00" }] });
  const row = await f.row("b"); assert.equal(row.rates, null); assert.equal(row.configured_rates, null);
  assert.equal(row.rate_pending, false); assert.equal(row.rate_effective_at, null);
  await f.store.transaction(state => { state.rules.push({ ...seed().rules[0], party_id: "b", id: "3", ver: 3, eff_at: "2026-11-14 00:00:00" }); });
  const marker = await f.row("b"); assert.equal(marker.configured_rates, null); assert.equal(marker.rate_pending, false);
});
