"use strict";

// Explicit opt-in only. Creates and drops only its own random synthetic DB;
// the configured business database is never selected by any connection.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { statements, applyStatement } = require("../../scripts/migrate-customer-service.cjs");
const { createPhotoShareService, DEFAULT_RATES } = require("../lib/photoShare.cjs");
const SAFE_NAME = /^lxm_photo_qa_\d{13}_[a-f0-9]{12}$/;
test("isolated real MySQL photo profile atomicity, pending COUNT, row locks and immutable pushed adjustments", { skip: process.env.RUN_ISOLATED_PHOTO_MYSQL !== "1", timeout: 120000 }, async t => {
  const database = "lxm_photo_qa_" + Date.now() + "_" + crypto.randomBytes(6).toString("hex"); assert.match(database, SAFE_NAME);
  const report = { syntheticOnly: true, businessDatabaseSelected: false, created: false, dropped: false, cases: [] };
  let admin, pool, created = false;
  try {
    require("dotenv").config({ path: process.env.PHOTO_MYSQL_TEST_ENV || path.join(__dirname, "../../.env"), quiet: true, override: !!process.env.PHOTO_MYSQL_TEST_ENV });
    const env = process.env, mysql = require("mysql2/promise");
    const cfg = { host: env.DB_HOST || env.MYSQL_HOST, port: Number(env.DB_PORT || env.MYSQL_PORT || 3306), user: env.DB_USER || env.MYSQL_USER, password: env.DB_PASSWORD ?? env.MYSQL_PASSWORD ?? "", connectTimeout: 5000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true,
      ...(String(env.DB_SSL || "").toLowerCase() === "true" ? { ssl: { rejectUnauthorized: true } } : {}) };
    if (!cfg.host || !cfg.user) { report.status = "skipped"; report.skip_code = "PHOTO_MYSQL_TEST_NOT_CONFIGURED"; t.skip("Isolated test connection not configured"); return; }
    try { admin = await mysql.createConnection(cfg); } catch (error) { report.status = "skipped"; report.skip_code = String(error.code); t.skip("Isolated test connection unavailable: " + String(error.code)); return; }
    assert.equal((await admin.query("SELECT DATABASE() db"))[0][0].db, null);
    assert.notEqual(database, env.DB_NAME || env.MYSQL_DATABASE);
    try { await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch (error) { report.status = "skipped"; report.skip_code = String(error.code); t.skip("Isolated database creation unavailable: " + String(error.code)); return; }
    report.created = created = true; report.database = database;
    pool = mysql.createPool({ ...cfg, database, connectionLimit: 6 });
    const source = { transaction: async work => { const conn = await pool.getConnection(); try { assert.equal((await conn.query("SELECT DATABASE() db"))[0][0].db, database); await conn.beginTransaction(); try { const result = await work(conn); await conn.commit(); return result; } catch (error) { await conn.rollback(); throw error; } } finally { conn.release(); } } };
    const query = (sql, params = []) => source.transaction(conn => conn.query(sql, params));
    await query("CREATE TABLE lxm_orders (id VARCHAR(128) PRIMARY KEY,orderNo VARCHAR(128),photographerId VARCHAR(128),workflowStage VARCHAR(64),totalAmount DECIMAL(18,2),updatedAt VARCHAR(64)) ENGINE=InnoDB");
    for (const table of ["lxm_staff", "lxm_agents", "lxm_distributors", "lxm_shops", "lxm_userProfiles"]) await query(`CREATE TABLE ${table} (id VARCHAR(128) PRIMARY KEY,phone VARCHAR(64)) ENGINE=InnoDB`);
    await query("CREATE TABLE lxm_auth_roles (id VARCHAR(128) PRIMARY KEY,role_key VARCHAR(64) UNIQUE,name VARCHAR(128),status VARCHAR(32),description VARCHAR(500)) ENGINE=InnoDB");
    await query("CREATE TABLE lxm_auth_menus (id VARCHAR(128) PRIMARY KEY,menu_key VARCHAR(128) UNIQUE,name VARCHAR(128),path VARCHAR(255),sort_no INT,status VARCHAR(32),meta_group VARCHAR(128),meta_type VARCHAR(32)) ENGINE=InnoDB");
    await query("CREATE TABLE lxm_auth_role_menus (role_id VARCHAR(128),menu_key VARCHAR(128),PRIMARY KEY(role_id,menu_key)) ENGINE=InnoDB");
    await query("CREATE TABLE lxm_auth_users (id VARCHAR(128) PRIMARY KEY,account VARCHAR(128) UNIQUE,display_name VARCHAR(128),password_hash VARCHAR(255),role_id VARCHAR(128),status VARCHAR(32),phone VARCHAR(64),subject_type VARCHAR(64),subject_id VARCHAR(128)) ENGINE=InnoDB");
    for (const file of ["017_customer_service.sql", "018_service_benefit.sql", "019_photo_share.sql"]) for (const sql of statements(path.join(__dirname, "../migrations", file))) await source.transaction(conn => applyStatement(conn, sql));
    await query("INSERT INTO benefit_rule (ver,beneficiary_type,party_id,rule_mode,rate_photo_bp,rate_video_bp,rate_combo_bp,rate_peripheral_bp,eff_at,reason,operator) VALUES (1,'photo',NULL,'global',2000,2000,2000,800,'2026-01-01 00:00:00','synthetic','qa')");
    let clock = "2026-11-13 12:00:00";
    const service = createPhotoShareService({ source, clock: () => clock }), actor = { role: "super", account: "qa" };
    const check = async (name, work) => t.test(name, async () => { await work(); report.cases.push(name); });
    await check("failed native transaction leaves no profile, rate or log", async () => {
      await assert.rejects(source.transaction(async conn => { await conn.query("INSERT INTO photo_profile(id,name,phone,agree_no) VALUES ('PH20269999','synthetic','13800009999','QA')"); throw Object.assign(new Error("rollback"), { code: "QA_ROLLBACK" }); }), { code: "QA_ROLLBACK" });
      assert.equal(Number((await query("SELECT COUNT(*) count FROM photo_profile"))[0][0].count), 0);
    });
    let party;
    await check("profile/rule/log/account commit together; concurrent identical phone only one succeeds", async () => {
      const input = { name: "synthetic", phone: "13800001111", agree_no: "QA-ONLY", account: "synthetic-photo", password: "SyntheticPhoto123!", ...DEFAULT_RATES };
      const results = await Promise.allSettled([service.createParty(input, actor), service.createParty(input, actor)]);
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1); assert.equal(results.find(row => row.status === "rejected").reason.code, 4301); party = results.find(row => row.status === "fulfilled").value;
      assert.equal(Number((await query("SELECT COUNT(*) count FROM photo_profile"))[0][0].count), 1); assert.equal(Number((await query("SELECT COUNT(*) count FROM photo_profile_log"))[0][0].count), 1);
      assert.equal(Number((await query("SELECT COUNT(*) count FROM benefit_rule WHERE party_id=?", [party.id]))[0][0].count), 1);
      const user = (await query("SELECT account,subject_type,subject_id,password_hash FROM lxm_auth_users WHERE account=?", [input.account]))[0][0];
      assert.equal(user.subject_type, "photo"); assert.equal(user.subject_id, party.id);
      assert.equal(party.account,input.account);assert.equal(party.credentials,undefined);
      assert.equal(require("../lib/mysqlPermissionStore.cjs").verifyPassword(user.password_hash, input.password), true);
      assert.equal(JSON.stringify(party).includes(input.password),false);
    });
    await check("native COUNT blocks end without update/log and clears when order completed", async () => {
      await query("INSERT INTO lxm_orders (id,orderNo,photo_id,service_status) VALUES ('qa-order','QA-NATIVE',?,'confirmed')", [party.id]);
      await assert.rejects(service.setPartyStatus(party.id, { status: "ended", reason: "QA" }, actor), error => error.code === 4302 && error.data.pending_orders[0].order_no === "QA-NATIVE");
      assert.equal((await query("SELECT status FROM photo_profile WHERE id=?", [party.id]))[0][0].status, "active");
      assert.equal(Number((await query("SELECT COUNT(*) count FROM photo_profile_log WHERE action='end'"))[0][0].count), 0);
      await query("UPDATE lxm_orders SET service_status='done',done_at='2026-11-13 10:00:00' WHERE id='qa-order'");
      assert.equal((await service.listParties()).rows[0].pending_count, 0);
    });
    let ledger, statement;
    await check("idempotent assignment and completion inserts one safe integer ledger", async () => {
      const order = { no: "QA-NATIVE", photo_id: party.id, category: "combo", net_amount_fen: 299900, paid_at: "2026-11-02 10:00:00", done_at: "2026-11-13 10:00:00", service_status: "done", customer_openid: "oQA_SYNTHETIC" };
      ledger = (await service.onOrderChanged(order)).ledger; await service.onOrderChanged(order); assert.equal((await service.listLedger()).total, 1); assert.equal(Number(ledger.commission_fen), 59980);
    });
    await check("push exact Friday deadline and immutable original after repeated zero", async () => {
      statement = (await service.batchSettle({ ids: [ledger.id], period: "2026-11" }, actor)).rows[0];
      const pushed = await service.settlementAction(statement.settle_id, "push", {}, actor); assert.equal(pushed.dispute_until, "2026-11-20");
      await service.zeroLedger(ledger.id, "transfer", actor); await service.zeroLedger(ledger.id, "transfer", actor);
      assert.equal(Number((await query("SELECT amount_fen FROM photo_settlement WHERE settle_id=?", [statement.settle_id]))[0][0].amount_fen), 59980);
      assert.equal(Number((await query("SELECT commission_fen FROM benefit_ledger WHERE id=?", [ledger.id]))[0][0].commission_fen), 59980);
      assert.equal(Number((await query("SELECT COUNT(*) count FROM svc_adjust WHERE plan_id=?", ["photo:ledger:" + ledger.id]))[0][0].count), 1);
      assert.equal(Number((await query("SELECT COUNT(*) count FROM svc_notification WHERE event_type='photo_statement'"))[0][0].count), 1);
    });
    await check("deadline round trip is timezone independent and expiry acceptance persists", async () => {
      clock = "2026-11-21 00:05:00"; assert.equal((await service.runTasks()).accepted, 1); assert.equal((await service.runTasks()).accepted, 0);
      assert.equal((await service.listSettlements()).rows[0].status, "accepted");
      assert.ok((await service.listSettlements()).rows[0].acceptance_note.includes("逾期未提异议"));
    });
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    throw Object.assign(new Error("Isolated photo QA failed: " + String(error.code || "UNKNOWN")), { code: error.code || "PHOTO_QA_FAILED" });
  } finally {
    if (pool) await pool.end();
    if (created && admin) { assert.match(database, SAFE_NAME); await admin.query(`DROP DATABASE \`${database}\``); report.dropped = true; }
    if (admin) await admin.end();
    const output = path.join(__dirname, "../../../outputs/photographer-share/photo-mysql-isolated-results.json"); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
});
