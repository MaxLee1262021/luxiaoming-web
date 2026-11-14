"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const C = require("../lib/photoLegacyCleanup.cjs");
const { parseArgs, directSource } = require("../../scripts/cleanup-photo-share.cjs");
const AT = "2026-11-11T04:00:00Z";
const PH = "PH20260001";
function initial() {
  const tables = Object.fromEntries(C.REQUIRED.map(table => [table, []]));
  tables.svc_runtime_lock = [{ id: 1 }];
  tables.photo_profile = [{ id: PH, name: "新摄影师档案保留" }];
  tables.lxm_staff = [{ id: "old-photo", role: "photo" }, { id: "staff-service", role: "service" }, { id: "ambiguous", role: "photo" }];
  tables.svc_staff = [{ id: "staff-service" }, { id: "ambiguous" }];
  tables.benefit_ledger = [
    { id: "1", beneficiary_type: "photo", biz_no: "OLD1", paid_at: "2026-11-01 12:00:00", commission_fen: "65978" },
    { id: "2", beneficiary_type: "service", biz_no: "OLD1", paid_at: "2026-11-01 12:00:00", commission_fen: "20000" },
  ];
  tables.photo_settlement = [{ settle_id: "ST-P-202611-" + PH, photo_id: PH, status: "paid", payable_fen: "65978" }];
  tables.svc_adjust = [
    { id: "1", staff_id: PH, amount_fen: "-12345", plan_id: "photo:ledger:1" },
    { id: "2", staff_id: "old-photo", amount_fen: "-6789", plan_id: null },
    { id: "3", staff_id: "staff-service", amount_fen: "-10000", plan_id: "service-plan" },
  ];
  tables.svc_notification = [
    { id: "n1", event_type: "photo_statement", event_key: "photo_statement:ST-P-202611-" + PH, status: "pending", recipient_id: PH },
    { id: "n2", event_type: "photo_payment", event_key: "photo_payment:ST-P-OTHER", status: "pending", recipient_id: "other" },
    { id: "n3", event_type: "service_statement", event_key: "service:ST-S-1", order_no: "OLD1", status: "pending" },
  ];
  tables.lxm_reconciliationTransfers = [
    { id: "t1", objectType: "摄影", objectId: "old-photo", amount: "123.45" },
    { id: "t2", objectType: "merchant", amount: "456.78" },
  ];
  tables.lxm_adjustmentRecords = [{ id: "a1", targetType: "photo", amount: "-100.01" }, { id: "a2", targetType: "service", amount: "-50.00" }];
  tables.lxm_reconciliation_transfer_orders = [{ transfer_id: "t1", order_no: 0, order_number: "OLD1" }, { transfer_id: "t2", order_no: 0, order_number: "KEEP" }];
  tables.lxm_collection_values = [
    { collection_name: "reconciliationTransfers", record_id: "t1", path: "custom", ordinal: 0, value_text: "old photo" },
    { collection_name: "reconciliationTransfers", record_id: "t2", path: "custom", ordinal: 0, value_text: "merchant" },
    { collection_name: "adjustmentRecords", record_id: "a1", path: "custom", ordinal: 0, value_text: "old photo" },
    { collection_name: "orders", record_id: "t1", path: "custom", ordinal: 0, value_text: "actual order stays" },
  ];
  return tables;
}
function fixture(start = initial()) {
  let database = structuredClone(start), failure = null;
  const sql = [], identity = { database_name: "synthetic-only", server_name: "fixture", server_port: 3306, lower_case_table_names: 0 };
  const source = { async transaction(work) {
    const next = structuredClone(database);
    const conn = { async query(statement, params = []) {
      sql.push({ statement, params: structuredClone(params) });
      if (failure && statement.includes(failure)) throw Object.assign(new Error("injected failure"), { code: "QA_INJECTED" });
      if (statement.startsWith("SELECT DATABASE()")) return [[identity]];
      if (statement.includes("information_schema.tables")) return [Object.keys(next).map(name => ({ table_name: identity.lower_case_table_names === 1 ? name.toLowerCase() : name }))];
      if (/^SELECT/.test(statement)) {
        const table = statement.match(/FROM\s+`?(\w+)/)[1];
        assert.ok(next[table], "only known financial/authority tables are read: " + table);
        return [structuredClone(next[table])];
      }
      if (/^DELETE/.test(statement)) {
        const table = statement.match(/FROM `(\w+)`/)[1], keys = [...statement.matchAll(/`(\w+)`=\?/g)].map(match => match[1]);
        assert.ok(C.TARGETS[table], "no delete outside financial whitelist");
        const before = next[table].length;
        next[table] = next[table].filter(row => !keys.every((key, index) => String(row[key]) === String(params[index])));
        return [{ affectedRows: before - next[table].length }];
      }
      if (/^INSERT INTO photo_profile_log/.test(statement)) {
        next.photo_profile_log.push({ id: "reset-log", photo_id: "*", action: "finance_reset", detail: params[0], operator: params[1], created_at: params[2] });
        return [{ affectedRows: 1, insertId: "reset-log" }];
      }
      throw Error("unexpected SQL: " + statement);
    } };
    const result = await work(conn); database = next; return result;
  } };
  return { source, sql, data: () => database, identity, failAt: value => { failure = value; } };
}
const hash = snapshot => C.sha256(JSON.stringify(snapshot, null, 2) + "\n");
async function prepared(f) { return C.prepareSnapshot(f.source, { cutoff: AT, clock: () => AT }); }
const apply = (f, s) => C.applySnapshot(f.source, s, { sha256: hash(s), operator: "reviewed-admin", clock: () => AT });

test("default cleanup is read-only and reports exact photographer totals with no account/order writes", async () => {
  const f = fixture(), before = structuredClone(f.data());
  const report = await C.inspectCleanup(f.source, { cutoff: AT });
  assert.equal(report.dryRun, true); assert.equal(report.ready, true);
  assert.equal(report.counts.benefit_ledger, 1); assert.equal(report.counts.svc_adjust, 2);
  assert.equal(report.amounts_fen.ledger_commission, "65978"); assert.equal(report.amounts_fen.adjustment_signed, "-19134");
  assert.equal(report.amounts_fen.legacy_transfers, "12345"); assert.equal(report.amounts_fen.legacy_adjustments, "-10001");
  assert.deepEqual(f.data(), before); assert.ok(f.sql.every(row => /^SELECT/.test(row.statement)));
});
test("missing schema is explicit and never installed by cleanup inspection", async () => {
  const data = initial(); delete data.photo_settlement;
  const f = fixture(data), report = await C.inspectCleanup(f.source, { cutoff: AT });
  assert.equal(report.ready, false); assert.deepEqual(report.missing_tables, ["photo_settlement"]);
  assert.ok(f.sql.every(row => /^SELECT/.test(row.statement)));
});
test("case-insensitive MySQL table inventory recognizes lowercase stored legacy finance names", async () => {
  const f = fixture(); f.identity.lower_case_table_names = 1;
  const report = await C.inspectCleanup(f.source, { cutoff: AT });
  assert.equal(report.ready, true);
  assert.equal(report.counts.lxm_reconciliationTransfers, 1);
  assert.equal(report.counts.lxm_adjustmentRecords, 1);
  assert.equal(report.amounts_fen.legacy_transfers, "12345");
  assert.ok(f.sql.every(row => /^SELECT/.test(row.statement)));
});
test("apply deletes only snapshotted photo finance and children, preserves service/merchant/profiles/rules/orders", async () => {
  const f = fixture(), snapshot = await prepared(f), authority = structuredClone({ profiles: f.data().photo_profile, staff: f.data().lxm_staff });
  const result = await apply(f, snapshot);
  assert.equal(result.applied, true); assert.equal(result.finance_only, true);
  assert.deepEqual(f.data().benefit_ledger.map(row => row.id), ["2"]);
  assert.deepEqual(f.data().svc_adjust.map(row => row.id), ["3"]);
  assert.deepEqual(f.data().svc_notification.map(row => row.id), ["n2", "n3"]);
  assert.deepEqual(f.data().lxm_reconciliationTransfers.map(row => row.id), ["t2"]);
  assert.deepEqual(f.data().lxm_adjustmentRecords.map(row => row.id), ["a2"]);
  assert.equal(f.data().lxm_reconciliation_transfer_orders[0].transfer_id, "t2");
  assert.equal(f.data().lxm_collection_values.some(row => row.collection_name === "orders"), true);
  assert.deepEqual(f.data().photo_profile, authority.profiles); assert.deepEqual(f.data().lxm_staff, authority.staff);
  assert.ok(!f.sql.some(row => /^DELETE/.test(row.statement) && /auth|profile`|rule|orders`/.test(row.statement.replace("lxm_reconciliation_transfer_orders", ""))));
  assert.equal(C.financeResetCutoff(f.data().photo_profile_log), "2026-11-11 12:00:00");
});
test("failed delete or marker insertion rolls the complete cleanup back", async () => {
  for (const failure of ["DELETE FROM `benefit_ledger`", "INSERT INTO photo_profile_log"]) {
    const f = fixture(), snapshot = await prepared(f), before = structuredClone(f.data());
    f.failAt(failure); await assert.rejects(apply(f, snapshot), { code: "QA_INJECTED" }); assert.deepEqual(f.data(), before);
  }
});
test("changed financial rows and wrong source or hash reject before any delete", async () => {
  for (const cause of ["row", "database", "hash"]) {
    const f = fixture(), snapshot = await prepared(f);
    if (cause === "row") f.data().benefit_ledger[0].commission_fen = "65979";
    if (cause === "database") f.identity.database_name = "another-database";
    await assert.rejects(C.applySnapshot(f.source, snapshot, { sha256: cause === "hash" ? "a".repeat(64) : hash(snapshot), operator: "admin" }), { code: ({ row: "PHOTO_CLEANUP_SNAPSHOT_STALE", database: "PHOTO_CLEANUP_DATABASE_MISMATCH", hash: "PHOTO_CLEANUP_HASH_MISMATCH" })[cause] });
    assert.ok(!f.sql.some(row => /^DELETE|^INSERT/.test(row.statement)));
  }
});
test("same reviewed snapshot is idempotent and cannot delete newly earned photographer money", async () => {
  const f = fixture(), snapshot = await prepared(f); await apply(f, snapshot);
  f.data().benefit_ledger.push({ id: "3", beneficiary_type: "photo", biz_no: "NEW", paid_at: "2026-11-12 09:00:00", commission_fen: "1234" });
  const result = await apply(f, snapshot); assert.equal(result.idempotent, true);
  assert.equal(f.data().benefit_ledger.find(row => row.id === "3").commission_fen, "1234");
  await assert.rejects(prepared(f), { code: "PHOTO_CLEANUP_ALREADY_APPLIED" });
});
test("old payment including exact cutoff stays cleared; new payment and shared service remain independent", () => {
  const logs = [{ photo_id: "*", action: "finance_reset", detail: JSON.stringify({ v: 1, scope: C.SCOPE, cutoff_at: "2026-11-11 12:00:00" }) }];
  assert.equal(C.isClearedOrder({ paid_at: "2026-11-11T04:00:00Z" }, logs), true);
  assert.equal(C.isClearedOrder({ paid_at: "2026-11-11T04:00:01Z" }, logs), false);
  assert.equal(C.isClearedOrder({ paid_at: null }, logs), false);
  assert.equal(C.isClearedOrder({ paid_at: "2026-11-01" }, []), false);
  assert.throws(() => C.isClearedOrder({ paid_at: "2026-11-01" }, [{ photo_id: "*", action: "finance_reset", detail: "broken" }]), { code: "PHOTO_FINANCE_RESET_MARKER_INVALID" });
});
test("ambiguous service/photo adjustment identity and future or missing payment block apply", async () => {
  const f = fixture(); f.data().svc_adjust.push({ id: "collision", staff_id: "ambiguous", amount_fen: "-5" });
  const report = await C.inspectCleanup(f.source, { cutoff: AT });
  assert.deepEqual(report.exceptions.ambiguous_adjustment_ids, ["collision"]);
  await assert.rejects(prepared(f), { code: "PHOTO_CLEANUP_AMBIGUOUS_ADJUSTMENT" });
  for (const paid_at of ["2026-11-12 12:00:00", null]) {
    const g = fixture(); g.data().benefit_ledger[0].paid_at = paid_at;
    await assert.rejects(prepared(g), { code: "PHOTO_CLEANUP_PAYMENT_FACTS" });
  }
  const g = fixture(); g.data().svc_notification[0].status = "sending";
  await assert.rejects(prepared(g), { code: "PHOTO_CLEANUP_NOTIFICATION_SENDING" });
});
test("financial snapshot stays outside repository, has hash verification, and produces explicit transactional restore SQL", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "photo-cleanup-qa-")); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo"), outside = path.join(temp, "restricted", "snapshot.json"); await fs.mkdir(repo);
  const f = fixture(), snapshot = await prepared(f);
  await assert.rejects(C.saveSnapshot(snapshot, path.join(repo, "bad.json"), { repoRoot: repo }), { code: "PHOTO_CLEANUP_BACKUP_PATH" });
  const saved = await C.saveSnapshot(snapshot, outside, { repoRoot: repo }); assert.equal(saved.sha256, hash(snapshot));
  const loaded = await C.loadSnapshot(outside, saved.sha256, { repoRoot: repo }); assert.deepEqual(loaded.snapshot, snapshot);
  await assert.rejects(C.loadSnapshot(outside, "0".repeat(64), { repoRoot: repo }), { code: "PHOTO_CLEANUP_HASH_MISMATCH" });
  await assert.rejects(C.saveSnapshot(snapshot, outside, { repoRoot: repo }), { code: "EEXIST" });
  const restore = C.restoreSql(snapshot, saved.sha256);
  assert.match(restore, /START TRANSACTION/); assert.match(restore, /INSERT INTO `benefit_ledger`/); assert.match(restore, /finance_reset/); assert.match(restore, /COMMIT/);
  assert.doesNotMatch(restore, /TRUNCATE|DROP TABLE|INSERT INTO `lxm_auth|INSERT INTO `lxm_orders`/);
});
test("CLI rejects unsafe argument combinations and bypasses automatic schema initialization", async () => {
  assert.throws(() => parseArgs(["--apply"]), { code: "PHOTO_CLEANUP_ARGUMENT" });
  assert.throws(() => parseArgs(["--restore-sql", "x", "--apply"]), { code: "PHOTO_CLEANUP_ARGUMENT" });
  assert.throws(() => parseArgs(["--unknown"]), { code: "PHOTO_CLEANUP_ARGUMENT" });
  assert.deepEqual(parseArgs([]), {});
  const calls = [], conn = { query: async sql => { calls.push(sql); }, beginTransaction: async () => calls.push("begin"), commit: async () => calls.push("commit"), rollback: async () => calls.push("rollback"), release: () => calls.push("release") };
  const source = directSource({ config: { host: "test", user: "test", database: "test" }, pool: { getConnection: async () => conn, end: async () => {} } });
  await source.transaction(async () => 1);
  assert.deepEqual(calls, ["SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ", "begin", "commit", "release"]);
});
