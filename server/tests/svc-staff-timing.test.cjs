"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const C = require("../lib/svcCommission.cjs"), B = require("../lib/svcBenefit.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const { DEFAULT_CONFIG } = require("../lib/svcCore.cjs");
const { svcAccountsSqlFixture } = require("./fixtures/svcAccountsSql.cjs");
const admin = { kind: "admin", role: "super", authzUserId: "root" };
const globalConfig = { ...DEFAULT_CONFIG, id: "1", ver: 1, link_valid_days: 7, observe_days: 7, eff_at: "2026-01-01 00:00:00" };
const globalRule = { id: "1", ver: 1, beneficiary_type: "service", party_id: null, rule_mode: "global", rate_photo_bp: 500, rate_video_bp: 1000, rate_combo_bp: 800, rate_peripheral_bp: 1500, eff_at: "2026-01-01 00:00:00" };
const staffForm = (index = 0) => ({ name: "时效测试" + index, phone: "139001391" + String(index).padStart(2, "0"), joined_at: "2026-11-13", base_salary: 0, rate_mode: "global" });
const staffSession = id => ({ kind: "admin", role: "service", authzUserId: "account-" + id });
function person(id, timing = {}) { return { id, account_id: "account-" + id, name: "客服" + id, staff_status: "active", base_salary: 0, rate_mode: "global", ...timing }; }
function order(id, assignee, extra = {}) {
  return { id, order_no: "TIMING-" + id, assignee_id: assignee, paid_at: "2026-11-13 10:00:00", category: "photo", service_net_amount_fen: 20000, net_amount_fen: 69900, customer_openid: "customer-" + id,
    product_id: "product-1", service_status: "claimed", svc_paid_processed: 1, service_managed: true, ...extra };
}
function fixture(initial = {}) {
  let at = "2026-11-13 12:00:00";
  const store = createSvcMemoryStore({ configs: [globalConfig], rules: [globalRule], ...initial });
  const generated = [];
  const commission = C.createSvcCommission({ store, clock: () => at });
  const workbench = createSvcWorkbench({ store, clock: () => at, linkProvider: async input => { generated.push(input); return { path: "pages/index/index?order_no=" + input.order.order_no }; } });
  return { store, commission, workbench, generated, at(value) { at = value; } };
}

test("new staff timing persists independently and legacy profiles continue to follow common settings", async () => {
  const f = fixture();
  const custom = await f.commission.execute("POST", "/staff", { ...staffForm(0), link_valid_days: "3", observe_days: "0" }, admin);
  const fallback = await f.commission.execute("POST", "/staff", staffForm(1), admin);
  const nullable = await f.commission.execute("POST", "/staff", { ...staffForm(2), link_valid_days: null, observe_days: null }, admin);
  assert.equal(custom.link_valid_days, 3); assert.equal(custom.observe_days, 0);
  assert.equal(fallback.link_valid_days, null); assert.equal(fallback.observe_days, null);
  assert.equal(nullable.link_valid_days, null); assert.equal(nullable.observe_days, null);
  await f.store.transaction(state => { state.configs.push({ ...globalConfig, id: "2", ver: 2, eff_at: "2026-11-13 11:00:00", link_valid_days: 12, observe_days: 4 }); });
  const restarted = C.createSvcCommission({ store: f.store, clock: () => "2026-11-13 12:00:00" });
  const rows = (await restarted.execute("GET", "/api/svc/staff", {}, admin)).list;
  assert.deepEqual(rows.find(row => row.id === custom.id).timing, { link_valid_days: 3, observe_days: 0, cycle: "月结" });
  for (const id of [fallback.id, nullable.id]) assert.deepEqual(rows.find(row => row.id === id).timing, { link_valid_days: 12, observe_days: 4, cycle: "月结" });
  assert.equal(f.store.snapshot().configs.length, 2, "individual onboarding never appends a common configuration");
});

test("timing accepts integer boundaries and rejects invalid values without leaving any profile or rule", async () => {
  const f = fixture();
  for (const [index, timing] of [{ link_valid_days: 1, observe_days: 0 }, { link_valid_days: 30, observe_days: 30 }].entries()) {
    const saved = await f.commission.execute("POST", "/staff", { ...staffForm(index), ...timing }, admin);
    assert.equal(saved.link_valid_days, timing.link_valid_days); assert.equal(saved.observe_days, timing.observe_days);
  }
  for (const [field, invalid] of [
    ["link_valid_days", [0, -1, 31, 1.5, true, false, "", " ", "1.5", "invalid", NaN, Infinity, {}, []]],
    ["observe_days", [-1, 31, 0.5, true, false, "", " ", "0.5", "invalid", NaN, Infinity, {}, []]],
  ]) for (const value of invalid) {
    const before = f.store.snapshot();
    await assert.rejects(f.commission.execute("POST", "/staff", { ...staffForm(3), [field]: value }, admin), error => error.code === 4014, field + ": " + String(value));
    assert.deepEqual(f.store.snapshot(), before);
  }
  await assert.rejects(f.commission.execute("POST", "/staff", { ...staffForm(3), link_valid_days: 2, observe_days: 0 }, staffSession("a")), error => error.code === 4030);
});

test("typed SQL profile timing and new login commit together and roll back on a later audit failure", async () => {
  const f = svcAccountsSqlFixture();
  const input = { ...staffForm(0), create_account: true, account: "timing-new-service", password: "TimingQA123!", link_valid_days: 2, observe_days: 0 };
  const before = structuredClone(f.tables()); f.fail("INSERT INTO `svc_staff_profile_log`");
  await assert.rejects(f.commission.execute("POST", "/staff", input, admin), { code: "QA_SQL_FAILURE" });
  assert.deepEqual(f.tables(), before);
  f.fail(null); const created = await f.commission.execute("POST", "/staff", input, admin);
  const stored = f.tables().svc_staff.find(row => row.id === created.id);
  assert.equal(stored.link_valid_days, 2); assert.equal(stored.observe_days, 0);
  const rows = (await f.commission.execute("GET", "/api/svc/staff", {}, admin)).list;
  assert.equal(rows[0].timing.link_valid_days, 2); assert.equal(rows[0].timing.observe_days, 0);
  assert.equal(f.tables().lxm_auth_users.length, 1);
  assert.equal(f.tables().benefit_rule.filter(row => row.party_id === created.id).length, 1);
});

test("links use each order owner timing including supervisor delegation and preserve already issued expiries", async () => {
  const f = fixture({ staff: [person("a", { link_valid_days: 2, supervisor_id: "lead" }), person("b", { link_valid_days: 15 }), person("legacy"), person("lead", { link_valid_days: 30 })],
    orders: [order("a", "a"), order("b", "b"), order("legacy", "legacy")] });
  const links = {};
  for (const id of ["a", "b", "legacy"]) links[id] = await f.workbench.execute("POST", "/api/kf/link/generate", { order_no: "TIMING-" + id }, staffSession(id));
  assert.equal(links.a.expires_at, "2026-11-15 12:00:00");
  assert.equal(links.b.expires_at, "2026-11-28 12:00:00");
  assert.equal(links.legacy.expires_at, "2026-11-20 12:00:00");
  const supervisor = { ...staffSession("lead"), role: "service_supervisor" };
  const delegated = await f.workbench.execute("POST", "/api/kf/link/generate", { order_no: "TIMING-a", staff_id: "lead" }, supervisor);
  assert.equal(delegated.staff_id, "a"); assert.equal(delegated.expires_at, links.a.expires_at);
  await f.store.transaction(state => { state.staff.find(row => row.id === "a").link_valid_days = 1; state.configs[0].link_valid_days = 20; });
  const next = await f.workbench.execute("POST", "/api/kf/link/generate", { order_no: "TIMING-a" }, staffSession("a"));
  assert.equal(next.expires_at, "2026-11-14 12:00:00");
  assert.equal(f.store.snapshot().links.find(row => row.id === links.a.id).expires_at, "2026-11-15 12:00:00");
  assert.equal(f.generated[3].staff.id, "a"); assert.equal(f.generated[3].expires_at, "2026-11-15 12:00:00");
});

test("personal waiting periods snapshot independently and shared fallback uses the payment-time version", async () => {
  const completed = { service_status: "done", done_at: "2026-11-29 23:50:00" };
  const f = fixture({ staff: [person("a", { observe_days: 0 }), person("b", { observe_days: 3 }), person("legacy")],
    orders: [order("a", "a", completed), order("b", "b", completed), order("legacy", "legacy", completed)] });
  f.at("2026-11-29 23:50:00");
  await f.store.transaction(state => {
    state.configs.push({ ...globalConfig, id: "2", ver: 2, eff_at: "2026-11-14 00:00:00", observe_days: 1 });
    for (const item of state.orders) C.ensureLedger(state, item, "2026-11-29 23:50:00");
  });
  let ledger = f.store.snapshot().ledger;
  assert.deepEqual(ledger.map(row => row.observe_days), [0, 3, 7]);
  assert.deepEqual(ledger.map(row => row.status), ["settleable", "obs", "obs"]);
  assert.deepEqual(ledger.map(row => B.duePeriod(row, row)), ["2026-11", "2026-12", "2026-12"]);
  await f.store.transaction(state => {
    for (const row of state.staff) row.observe_days = 30;
    for (const cfg of state.configs) cfg.observe_days = 30;
    for (const item of state.orders) C.ensureLedger(state, item, "2026-12-02 23:49:59");
  });
  f.at("2026-12-02 23:49:59"); await f.commission.runTasks();
  assert.deepEqual(f.store.snapshot().ledger.map(row => row.status), ["settleable", "obs", "obs"]);
  f.at("2026-12-02 23:50:00"); await f.workbench.runTasks();
  ledger = f.store.snapshot().ledger;
  assert.deepEqual(ledger.map(row => row.status), ["settleable", "settleable", "obs"]);
  assert.deepEqual(ledger.map(row => row.observe_days), [0, 3, 7], "neither personal nor global edits rewrite an existing payment snapshot");
  f.at("2026-12-06 23:50:00"); await f.commission.runTasks();
  assert.deepEqual(f.store.snapshot().ledger.map(row => row.status), ["settleable", "settleable", "settleable"]);
});

test("claim and receipt confirmation honor zero waiting and settlement/refund retain the frozen period", async () => {
  const f = fixture({ staff: [person("a", { observe_days: 0 })], orders: [order("zero", null, { service_status: "new", category: "peripheral" })] });
  await f.workbench.execute("POST", "/api/kf/orders/TIMING-zero/claim", { expected_status: "new" }, staffSession("a"));
  let row = f.store.snapshot().ledger[0]; assert.equal(row.observe_days, 0); assert.equal(row.status, "est");
  const done = await f.workbench.execute("POST", "/api/kf/orders/TIMING-zero/receipt/confirm", { expected_status: "claimed", received: true }, staffSession("a"));
  assert.equal(done.observe_until, "2026-11-13 12:00:00");
  row = f.store.snapshot().ledger[0]; assert.equal(row.status, "settleable");
  const batch = await f.commission.execute("POST", "/ledger/batch-settle", { ledger_ids: [row.id], period: "2026-11" }, admin);
  await f.commission.execute("POST", "/settlement/" + batch.list[0].settle_id + "/confirm", {}, admin);
  const before = f.store.snapshot().ledger[0];
  await f.workbench.onRefund("TIMING-zero");
  const after = f.store.snapshot();
  assert.equal(after.ledger[0].observe_days, 0); assert.equal(after.ledger[0].commission_fen, before.commission_fen);
  assert.equal(after.ledger[0].status, "settled"); assert.equal(after.adjustments.filter(item => item.action === "offset_plan").length, 1);
});
