"use strict";
// Opt-in integration: no query ever selects the configured business database.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createSvcStore } = require("../lib/svcStore.cjs");
const C = require("../lib/svcCommission.cjs"), B = require("../lib/svcBenefit.cjs");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const { migrate } = require("../../scripts/migrate-customer-service.cjs");
const OPT_IN = process.env.RUN_ISOLATED_SVC_MYSQL === "1";
const SAFE_NAME = /^lxm_svc_qa_\d{13}_[a-f0-9]{12}$/;
const LIMITS = new Set(["ISOLATED_MYSQL_NOT_CONFIGURED", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET", "ER_ACCESS_DENIED_ERROR", "ER_HOST_NOT_PRIVILEGED", "ER_DBACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR"]);
const codeOf = error => /^[A-Z][A-Z0-9_]{1,90}$/.test(String(error?.code || "")) ? String(error.code) : /^\d{3,5}$/.test(String(error?.code)) ? String(error.code) : "ISOLATED_QA_ERROR";
function safeError(error, stage) { if (error?.code === "ERR_ASSERTION") return error; return Object.assign(new Error(`Isolated service MySQL ${stage}: ${codeOf(error)}`), { code: codeOf(error) }); }

test("isolated MySQL service migration, transactional ownership, ledger snapshots and settlement", { skip: !OPT_IN, timeout: 180000 }, async t => {
  const report = { testOnly: true, businessDatabaseSelected: false, isolatedDatabaseCreated: false, isolatedDatabaseDropped: false, status: "running", cases: [] };
  const output = path.resolve(__dirname, "../../..", ".codex-tmp/customer-service/mysql-isolated-results.json");
  const database = `lxm_svc_qa_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  assert.match(database, SAFE_NAME); let admin, pool, created = false, stage = "configuration";
  try {
    const loaded = require("dotenv").config({ path: process.env.SVC_MYSQL_TEST_ENV || path.resolve(__dirname, "../../.env"), quiet: true });
    if (loaded.error && process.env.SVC_MYSQL_TEST_ENV) throw Object.assign(new Error("test config unavailable"), { code: "ISOLATED_MYSQL_NOT_CONFIGURED" });
    const env = process.env, mysql = require("mysql2/promise");
    const config = { host: env.DB_HOST || env.MYSQL_HOST, port: Number(env.DB_PORT || env.MYSQL_PORT || 3306), user: env.DB_USER || env.MYSQL_USER,
      password: env.DB_PASSWORD ?? env.MYSQL_PASSWORD ?? "", connectTimeout: 5000, dateStrings: false, supportBigNumbers: true, bigNumberStrings: true,
      timezone: "+00:00", multipleStatements: false, ...(String(env.DB_SSL).toLowerCase() === "true" ? { ssl: { rejectUnauthorized: true } } : {}) };
    if (!config.host || !config.user) throw Object.assign(new Error("not configured"), { code: "ISOLATED_MYSQL_NOT_CONFIGURED" });
    stage = "connect"; admin = await mysql.createConnection(config);
    const [[scope]] = await admin.query("SELECT DATABASE() AS db"); assert.equal(scope.db, null);
    assert.notEqual(database.toLowerCase(), String(env.DB_NAME || env.MYSQL_DATABASE || "").toLowerCase());
    stage = "create_database";
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); created = true; report.isolatedDatabaseCreated = true; report.isolatedDatabase = database;
    pool = mysql.createPool({ ...config, database, waitForConnections: true, connectionLimit: 12 });
    async function transaction(work) {
      const conn = await pool.getConnection();
      try {
        const [[selected]] = await conn.query("SELECT DATABASE() AS db"); assert.equal(selected.db, database);
        await conn.query("SET time_zone = '+08:00'"); await conn.beginTransaction();
        try { const result = await work(conn); await conn.commit(); return result; } catch (error) { await conn.rollback(); throw error; }
      } finally { conn.release(); }
    }
    const source = { transaction }, query = (sql, values = []) => transaction(conn => conn.query(sql, values));
    async function check(name, work) { await t.test(name, async () => { try { await work(); report.cases.push({ name, status: "passed" }); } catch (error) { report.cases.push({ name, status: "failed", code: codeOf(error) }); throw error; } }); }
    stage = "business_tests";
    let clock = "2026-11-10 12:00:00";
    const store = createSvcStore(source), finance = C.createSvcCommission({ store, clock: () => clock });
    const workbench = createSvcWorkbench({ store, benefit: C, clock: () => new Date(B.timestamp(clock)) });
    const root = { kind: "admin", role: "super", authzUserId: "qa-root" }, self = { kind: "admin", role: "service", authzUserId: "qa-account-a" };
    const migrationOptions = { apply: true, enableAt: "2026-11-01T00:00:00+08:00", rates: { photo_bp: 300, video_bp: 300, combo_bp: 300, peripheral_bp: 240 } };
    await check("install/reapply migration preserves initialization and generated unique binding key", async () => {
      const schema = require("../lib/mysqlSchema.cjs");
      for (const sql of schema.authCoreStatements()) await query(sql);
      for (const sql of schema.schemaStatements()) if (/^CREATE TABLE IF NOT EXISTS `(?:lxm_orders|lxm_staff|lxm_order_products)`/.test(sql)) await query(sql);
      const dry = await migrate(source); assert.equal(dry.dryRun, true);
      await migrate(source, migrationOptions); await migrate(source, migrationOptions);
      const [[rule]] = await query("SELECT COUNT(*) AS n FROM benefit_rule"); assert.equal(Number(rule.n), 1);
      const [[config]] = await query("SELECT COUNT(*) AS n FROM svc_config"); assert.equal(Number(config.n), 1);
      const [unique] = await query("SELECT column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='svc_binding' AND index_name='uk_openid_active'");
      assert.equal(unique[0].column_name, "active_flag");
    });
    await check("profile and rule rollback atomically, then persist service account mapping", async () => {
      await assert.rejects(finance.execute("POST", "/staff", { name: "QA Bad", phone: "13900139001", joined_at: "2026-11-10", base_salary: 0, rate_mode: "custom", rates: { photo_bp: 400 } }, root), { code: 5008 });
      const [[bad]] = await query("SELECT COUNT(*) AS n FROM svc_staff"); assert.equal(Number(bad.n), 0);
      const first = await finance.execute("POST", "/staff", { name: "QA Alpha", phone: "13900139002", joined_at: "2026-11-10", base_salary: 3500, rate_mode: "global", account_id: "qa-account-a" }, root);
      const second = await finance.execute("POST", "/staff", { name: "QA Beta", phone: "13900139003", joined_at: "2026-11-10", base_salary: 0, rate_mode: "global", account_id: "qa-account-b" }, root);
      assert.ok(first.id && second.id && first.id !== second.id);
      await query("INSERT INTO lxm_staff (id,name,role,status) VALUES ('qa-photo','QA Photographer','photographer','active')");
      await query("INSERT INTO lxm_orders (id,orderNo,totalAmount,depositDue,depositPaid,depositFinanceStatus,finalDue,depositPaidAt,createdAt,customer_openid,requested_time,svc_paid_processed) VALUES ('qa-order','QA-ORDER',699,99,99,'confirmed',600,'2026-11-10 10:00:00','2026-11-10 10:00:00','qa-customer','2026-11-11 15:00:00',1)");
    });
    await check("50 real concurrent claims serialize to one owner and one immutable ledger", async () => {
      const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => workbench.execute("POST", "/api/kf/orders/QA-ORDER/claim", { expected_status: "new" }, i % 2 ? { ...self, authzUserId: "qa-account-b" } : self)));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      for (const result of results.filter(result => result.status === "rejected")) assert.equal(result.reason.code, 4001);
      const [[count]] = await query("SELECT COUNT(*) AS n FROM benefit_ledger"); assert.equal(Number(count.n), 1);
      const [[snapshot]] = await query("SELECT commission_fen,rate_bp,rule_ver,observe_days FROM benefit_ledger"); assert.equal(Number(snapshot.commission_fen), 297); assert.equal(Number(snapshot.observe_days), 7);
      const [[owner]] = await query("SELECT s.account_id FROM lxm_orders o JOIN svc_staff s ON s.id=o.assignee_id WHERE o.id='qa-order'"); self.authzUserId = owner.account_id;
      await assert.rejects(store.transaction(state => { state.ledger[0].commission_fen = 1; }), error => error.code === 5005);
    });
    await check("native configuration CAS rolls back the losing version and does not recalculate existing money", async () => {
      const [[current]] = await query("SELECT MAX(ver) AS ver FROM benefit_rule");
      const input = { ver: Number(current.ver), rates: { photo_bp: 500, video_bp: 300, combo_bp: 300, peripheral_bp: 240 }, reason: "QA version" };
      const results = await Promise.allSettled([finance.execute("POST", "/rule", input, root), finance.execute("POST", "/rule", input, root)]);
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1); assert.equal(results.find(row => row.status === "rejected").reason.code, 5003);
      const [[snapshot]] = await query("SELECT commission_fen,rate_bp FROM benefit_ledger"); assert.equal(Number(snapshot.commission_fen), 297); assert.equal(Number(snapshot.rate_bp), 300);
    });
    await check("shooting completion waits for final payment before observation and live binding", async () => {
      await workbench.execute("POST", "/api/kf/orders/QA-ORDER/slot/confirm", { expected_status: "claimed", new_time: "2026-11-11 15:00:00" }, self);
      await workbench.execute("POST", "/api/kf/orders/QA-ORDER/assign", { expected_status: "confirmed", photo_id: "qa-photo", reason: "QA dispatch", channel: "phone" }, self);
      await workbench.execute("POST", "/api/kf/orders/QA-ORDER/shoot/start", { expected_status: "confirmed" }, { ...self, role: "super" });
      await workbench.execute("POST", "/api/kf/orders/QA-ORDER/shoot/finish", { expected_status: "shooting" }, { ...self, role: "super" });
      const [[pending]] = await query("SELECT service_status,workflowStage,done_at FROM lxm_orders WHERE id='qa-order'");
      assert.equal(pending.service_status, "final_pending"); assert.equal(pending.workflowStage, "awaiting_final_payment"); assert.equal(pending.done_at, null);
      const [[shootingFact]] = await query("SELECT value_text FROM lxm_collection_values WHERE collection_name='orders' AND record_id='qa-order' AND path='shootingCompletedAt'"); assert.ok(shootingFact.value_text);
      assert.equal((await query("SELECT status FROM benefit_ledger"))[0][0].status, "est");
      assert.equal((await query("SELECT COUNT(*) AS n FROM svc_binding"))[0][0].n, 0);
      // Simulate the verified payment callback's atomic receipt/completion patch.
      await query("UPDATE lxm_orders SET finalPaid=600,finalFinanceStatus='confirmed',status='completed',workflowStage='completed',completedAt=?,service_status='done',done_at=? WHERE id='qa-order'", [clock, clock]);
      await workbench.onCompleted({ orderNo: "QA-ORDER" });
      const [[ledger]] = await query("SELECT status,done_at FROM benefit_ledger"); assert.equal(ledger.status, "obs"); assert.equal(ledger.done_at, "2026-11-10 12:00:00");
      const [[binding]] = await query("SELECT status,expire_at FROM svc_binding"); assert.equal(binding.status, "active"); assert.equal(binding.expire_at, "2026-11-15 12:00:00");
      clock = "2026-11-17 11:59:59"; await finance.runTasks(); assert.equal((await query("SELECT status FROM benefit_ledger"))[0][0].status, "obs");
      clock = "2026-11-17 12:00:00"; await finance.runTasks(); assert.equal((await query("SELECT status FROM benefit_ledger"))[0][0].status, "settleable");
    });
    let settlement;
    await check("real settlement locks numeric snapshots, appeal grants next-month makeup and pay requires receipt", async () => {
      const [[ledger]] = await query("SELECT id FROM benefit_ledger");
      const batch = await finance.execute("POST", "/ledger/batch-settle", { ledger_ids: [ledger.id], period: "2026-11" }, root); settlement = batch.list[0];
      await finance.execute("POST", `/settlement/${settlement.settle_id}/confirm`, {}, root);
      await assert.rejects(finance.execute("POST", `/settlement/${settlement.settle_id}/exclude`, { ledger_id: ledger.id, reason: "QA locked" }, root), { code: 5005 });
      await assert.rejects(finance.execute("POST", `/settlement/${settlement.settle_id}/pay`, {}, root), { code: 5006 });
      const appeal = await finance.execute("POST", "/appeal", { settle_id: settlement.settle_id, ledger_id: ledger.id, reason: "QA difference" }, self);
      await finance.execute("POST", `/appeal/${appeal.id}/l1`, { result: "revise", note: "QA checked", amount_fen: 100 }, root);
      await finance.execute("POST", `/appeal/${appeal.id}/l2`, { result: "accepted", note: "QA accepted" }, root);
      await finance.execute("POST", `/settlement/${settlement.settle_id}/pay`, { voucher_url: "/api/media/qa-voucher" }, root);
      const [[paid]] = await query("SELECT status,amount_fen,payable_fen FROM svc_settlement"); assert.equal(paid.status, "paid"); assert.equal(Number(paid.amount_fen), 297); assert.equal(Number(paid.payable_fen), 297);
      const [[makeup]] = await query("SELECT action,amount_fen,period FROM svc_adjust WHERE action='makeup'"); assert.equal(Number(makeup.amount_fen), 100); assert.equal(makeup.period, "2026-12");
    });
    await check("restart reconstructs typed data, CSV is full-value BOM, confirmed refunds queue once", async () => {
      const restarted = C.createSvcCommission({ store: createSvcStore(source), clock: () => clock });
      const mine = await restarted.execute("GET", "/me", { staff: "forged-other-staff" }, self); assert.equal(mine.total, 1); assert.equal(mine.list[0].customer_openid, "qa-customer");
      const csv = await restarted.execute("GET", "/ledger/export", {}, root); assert.equal(csv.csv.codePointAt(0), 0xFEFF); assert.ok(csv.csv.includes("qa-customer"));
      await store.transaction(state => { C.onRefund(state, state.orders[0], clock); C.onRefund(state, state.orders[0], clock); });
      const [[plan]] = await query("SELECT COUNT(*) AS n FROM svc_adjust WHERE action='offset_plan'"); assert.equal(Number(plan.n), 1);
      const [[ledger]] = await query("SELECT status,commission_fen FROM benefit_ledger"); assert.equal(ledger.status, "settled"); assert.equal(Number(ledger.commission_fen), 297);
    });
    await check("new service login, profile and initial rule persist together and duplicate accounts leave no partial profile", async () => {
      const { verifyPassword } = require("../lib/mysqlPermissionStore.cjs");
      const input = { name: "QA Direct Login", phone: "13900139004", joined_at: "2026-11-13", base_salary: 0, rate_mode: "global", settlement_cycle: "周结", link_valid_days: 3, observe_days: 0, create_account: true, account: "qa-direct-service", password: "QaService123!" };
      const created = await finance.execute("POST", "/staff", input, root);
      const [[user]] = await query("SELECT u.*,r.role_key FROM lxm_auth_users u JOIN lxm_auth_roles r ON r.id=u.role_id WHERE u.id=?", [created.account_id]);
      assert.equal(user.account, input.account); assert.equal(user.role_key, "service");
      assert.equal(user.subject_type, "staff"); assert.equal(user.subject_id, created.id);
      assert.equal(verifyPassword(user.password_hash, input.password), true);
      assert.equal(JSON.stringify(created).includes(input.password), false);
      const self = { kind: "admin", role: "service", authzUserId: user.id, subjectId: created.id };
      const mine = await finance.execute("GET", "/api/svc/me", {}, self);
      assert.equal(mine.staff.id, created.id); assert.equal(mine.staff.account, input.account);
      assert.equal(mine.staff.link_valid_days, 3); assert.equal(mine.staff.observe_days, 0);
      assert.equal(mine.config.link_valid_days, 3); assert.equal(mine.config.observe_days, 0);
      const counts = async () => {
        const result = {};
        for (const table of ["svc_staff", "benefit_rule", "svc_staff_profile_log", "lxm_auth_users"]) {
          const [[row]] = await query(`SELECT COUNT(*) AS n FROM \`${table}\``); result[table] = Number(row.n);
        }
        return result;
      };
      const before = await counts();
      await assert.rejects(finance.execute("POST", "/staff", { ...input, name: "QA Conflict", phone: "13900139005", account: input.account.toUpperCase() }, root), { code: 4014 });
      assert.deepEqual(await counts(), before);
      // Inject a failure after the account INSERT but before the shared commit.
      const failingSource = { transaction: work => source.transaction(conn => work({ query: (sql, values) => {
        if (sql.startsWith("INSERT INTO `svc_staff_profile_log`")) throw Object.assign(new Error("TEST_ONLY audit failure"), { code: "QA_AUDIT_FAILURE" });
        return conn.query(sql, values);
      } })) };
      const failing = C.createSvcCommission({ store: createSvcStore(failingSource), clock: () => clock });
      await assert.rejects(failing.execute("POST", "/staff", { ...input, phone: "13900139006", account: "qa-rollback-service" }, root), { code: "QA_AUDIT_FAILURE" });
      assert.deepEqual(await counts(), before);
    });
    report.status = report.cases.some(row => row.status !== "passed") ? "failed" : "passed";
  } catch (error) {
    if (LIMITS.has(codeOf(error)) && ["configuration", "connect", "create_database"].includes(stage)) { report.status = "unavailable"; report.reasonCode = codeOf(error); t.skip(`Isolated MySQL unavailable: ${codeOf(error)}`); }
    else { report.status = "failed"; report.reasonCode = codeOf(error); throw safeError(error, stage); }
  } finally {
    await pool?.end();
    if (created) {
      assert.match(database, SAFE_NAME); await admin.query(`DROP DATABASE \`${database}\``); report.isolatedDatabaseDropped = true;
      const [remaining] = await admin.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name=?", [database]); assert.equal(remaining.length, 0);
    }
    await admin?.end(); report.finishedAt = new Date().toISOString(); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
});
