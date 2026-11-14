"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TABLES } = require("../lib/photoStore.cjs");
const { createPhotoShareService, DEFAULT_RATES } = require("../lib/photoShare.cjs");
// SQL contract fixture: executes the store's parameterized statements and
// transaction rollback, independently of the pure financial-state fixture.
function fixture() {
  let tables = Object.fromEntries([...Object.values(TABLES).map(([table]) => table), "svc_runtime_lock", "svc_assign_log", "lxm_orders", "lxm_staff", "lxm_agents", "lxm_distributors", "lxm_shops", "lxm_userProfiles", "lxm_auth_users", "svc_staff"].map(table => [table, []]));
  tables.svc_runtime_lock = [{ id: 1 }];
  tables.benefit_rule = [{ id: "1", ver: 1, beneficiary_type: "photo", party_id: null, rule_mode: "global", ...DEFAULT_RATES, eff_at: "2026-01-01 00:00:00", reason: "qa", operator: "qa", created_at: "2026-01-01 00:00:00" }];
  let failure, tail = Promise.resolve(); const statements = [];
  function pending(rows, owner) { return rows.filter(row => (row.photo_id || row.photographerId) === owner && (["claimed", "confirmed", "shooting", "final_pending"].includes(row.service_status) || ["new", "reserved"].includes(row.service_status || "new") && ["awaiting_shoot", "shooting", "awaiting_final_payment"].includes(row.workflowStage))); }
  const conn = { query: async (sql, params = []) => {
    statements.push({ sql, params: structuredClone(params) });
    if (failure && sql.includes(failure)) throw Object.assign(new Error("injected SQL error"), { code: "QA_SQL_FAILURE" });
    const table = (sql.match(/(?:FROM|INTO|UPDATE)\s+`?(\w+)`?/i) || [])[1]; assert.ok(tables[table], "unsupported table in fixture: " + table);
    if (/^SELECT/i.test(sql)) {
      let rows = structuredClone(tables[table]);
      if (table === "lxm_orders" && sql.includes("COALESCE(NULLIF(photo_id,''),photographerId)=?")) rows = pending(rows, params[0]);
      else if (table === "lxm_orders" && sql.includes("<>''")) rows = rows.filter(row => row.photo_id || row.photographerId);
      if (/COUNT\(\*\)/i.test(sql)) return [[{ count: rows.length }]];
      if (/^SELECT phone/i.test(sql)) rows = rows.filter(row => row.phone).map(row => ({ phone: row.phone }));
      if (/orderNo order_no/i.test(sql)) rows = rows.map(row => ({ id: row.id, order_no: row.orderNo, status: ["claimed", "confirmed", "shooting", "final_pending"].includes(row.service_status) ? row.service_status : row.workflowStage === "awaiting_final_payment" ? "final_pending" : row.workflowStage === "shooting" ? "shooting" : "confirmed", schedule_time: row.schedule_time }));
      return [rows];
    }
    if (/^INSERT/i.test(sql)) {
      const fields = sql.match(/\(([^)]+)\) VALUES/i)[1].replace(/`/g, "").split(",").map(v => v.trim());
      const row = Object.fromEntries(fields.map((field, i) => [field, params[i]]));
      const pk = Object.values(TABLES).find(([name]) => name === table)[1];
      assert.ok(!tables[table].some(old => String(old[pk]) === String(row[pk])), "duplicate identity");
      tables[table].push(row); return [{ insertId: row[pk], affectedRows: 1 }];
    }
    if (/^UPDATE/i.test(sql)) {
      const fields = sql.match(/SET (.*?) WHERE/i)[1].split(",").map(part => part.match(/`(\w+)`=/)[1]), pk = sql.match(/WHERE `(\w+)`=/)[1];
      const row = tables[table].find(row => String(row[pk]) === String(params.at(-1))); assert.ok(row, "update target exists");
      fields.forEach((field, index) => { row[field] = params[index]; }); return [{ affectedRows: 1 }];
    }
    throw new Error("unsupported fixture statement");
  } };
  const source = { transaction: async work => { const prior = tail; let release; tail = new Promise(resolve => { release = resolve; }); await prior; const before = structuredClone(tables); try { return await work(conn); } catch (error) { tables = before; throw error; } finally { release(); } } };
  return { service: createPhotoShareService({ source, clock: () => "2026-11-13 12:00:00", provisionAccount: async (_, profile, input) => ({ account: input.account, account_id: "TEST_ONLY_" + profile.id, account_created: true }) }), tables: () => tables, statements, fail: sql => { failure = sql; } };
}
const admin = { role: "super", account: "qa" };
const person = { name: "SQL摄影", phone: "13812345678", agree_no: "QA-SQL", account: "sql-photo", password: "SqlPhoto123!", ...DEFAULT_RATES };
test("SQL store rolls back profile and rule if log insert fails, retries cleanly", async () => {
  const f = fixture(); f.fail("INSERT INTO photo_profile_log"); await assert.rejects(f.service.createParty(person, admin), { code: "QA_SQL_FAILURE" });
  assert.equal(f.tables().photo_profile.length, 0); assert.equal(f.tables().benefit_rule.length, 1); assert.equal(f.tables().photo_profile_log.length, 0);
  f.fail(null); const row = await f.service.createParty(person, admin); assert.equal(row.id, "PH20260001");
  assert.equal(f.tables().photo_profile.length, 1); assert.equal(f.tables().benefit_rule.length, 2); assert.equal(f.tables().photo_profile_log.length, 1);
  assert.ok(f.statements.some(row => row.sql.includes("svc_runtime_lock") && row.sql.includes("FOR UPDATE")));
});
test("SQL real-time pending COUNT blocks end before any write; no profile count persisted", async () => {
  const f = fixture(), profile = await f.service.createParty(person, admin);
  f.tables().lxm_orders.push({ id: "q1", orderNo: "QA-PENDING", photographerId: profile.id, photo_id: null, service_status: "new", workflowStage: "awaiting_shoot" });
  f.statements.length = 0;
  await assert.rejects(f.service.setPartyStatus(profile.id, { status: "ended", reason: "QA" }, admin), error => error.code === 4302 && error.data.pending_orders[0].order_no === "QA-PENDING");
  assert.ok(f.statements.some(row => row.sql.startsWith("SELECT COUNT(*) count FROM lxm_orders")));
  assert.ok(!f.statements.some(row => /^(INSERT|UPDATE|DELETE)/.test(row.sql))); assert.ok(!Object.hasOwn(f.tables().photo_profile[0], "pending_count"));
  f.tables().lxm_orders[0].service_status = "done"; await f.service.setPartyStatus(profile.id, { status: "ended", reason: "已完成" }, admin); assert.equal(f.tables().photo_profile[0].status, "ended");
});
test("SQL final balance pending keeps the photographer assigned until payment completes", async () => {
  const f = fixture(), profile = await f.service.createParty(person, admin);
  f.tables().lxm_orders.push({ id: "waiting-final", orderNo: "QA-FINAL-PENDING", photo_id: profile.id, service_status: "final_pending", workflowStage: "awaiting_final_payment" });
  f.statements.length = 0;
  await assert.rejects(f.service.setPartyStatus(profile.id, { status: "ended", reason: "未到账" }, admin), error => error.code === 4302 && error.data.pending_orders[0].status === "final_pending");
  assert.ok(f.statements.some(row => /SELECT COUNT\(\*\).*'final_pending'/.test(row.sql)));
  assert.ok(!f.statements.some(row => /^(INSERT|UPDATE|DELETE)/.test(row.sql)));
  f.tables().lxm_orders[0].service_status = "done";
  f.tables().lxm_orders[0].workflowStage = "completed";
  await f.service.setPartyStatus(profile.id, { status: "ended", reason: "尾款已确认" }, admin);
  assert.equal(f.tables().photo_profile[0].status, "ended");
});
test("SQL locks and writes ledger/statement atomically, pushed snapshot zero adds only adjustment", async () => {
  const f = fixture(), profile = await f.service.createParty(person, admin);
  const normalized = { no: "QA-MONEY", photo_id: profile.id, category: "combo", net_amount_fen: 299900, paid_at: "2026-11-02 00:00:00", done_at: "2026-11-13 10:00:00", service_status: "done" };
  const ledger = (await f.service.onOrderChanged(normalized)).ledger; await f.service.onOrderChanged(normalized); assert.equal(f.tables().benefit_ledger.length, 1);
  const draft = (await f.service.batchSettle({ ids: [ledger.id], period: "2026-11" }, admin)).rows[0]; await f.service.settlementAction(draft.settle_id, "push", {}, admin);
  const snapshots = structuredClone({ ledger: f.tables().benefit_ledger, statements: f.tables().photo_settlement });
  f.statements.length = 0; await f.service.zeroLedger(ledger.id, "transfer", admin); await f.service.zeroLedger(ledger.id, "transfer", admin);
  assert.deepEqual({ ledger: f.tables().benefit_ledger, statements: f.tables().photo_settlement }, snapshots); assert.equal(f.tables().svc_adjust.length, 1);
  assert.ok(f.statements.some(row => row.sql.startsWith("INSERT INTO svc_adjust"))); assert.ok(!f.statements.some(row => /^UPDATE (benefit_ledger|photo_settlement)/.test(row.sql)));
});
