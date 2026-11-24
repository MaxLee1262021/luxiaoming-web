"use strict";

// Opt-in only. Never selects the configured business database. Credentials are
// loaded silently and used exclusively to create/drop this run's random DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createShareStore } = require("../lib/shareStore.cjs");
const { merchant } = require("./fixtures/shareSql.cjs");
const OPT_IN = process.env.RUN_ISOLATED_SHARE_MYSQL === "1";
const SAFE_NAME = /^lxm_share_qa_\d{13}_[a-f0-9]{12}$/;
const CONNECTION_LIMITS = new Set(["ISOLATED_MYSQL_NOT_CONFIGURED", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET", "ER_ACCESS_DENIED_ERROR", "ER_HOST_NOT_PRIVILEGED", "HANDSHAKE_SSL_ERROR", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const CREATE_LIMITS = new Set(["ER_DBACCESS_DENIED_ERROR", "ER_ACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR"]);
const codeOf = error => /^[A-Z][A-Z0-9_]{1,90}$/.test(String(error?.code || "")) ? error.code : "ISOLATED_QA_ERROR";
function safeError(error, stage) {
  if (error?.code === "ERR_ASSERTION") return error; // assertions contain synthetic business values only
  const safe = new Error(`Isolated MySQL ${stage}: ${codeOf(error)}`);
  safe.code = codeOf(error);
  if (/^[A-Z0-9]{5}$/.test(String(error?.sqlState || ""))) safe.sqlState = error.sqlState;
  return safe;
}
function sqlStatements(file) {
  return fs.readFileSync(file, "utf8").replace(/^\s*--[^\n]*$/gm, "").split(";").map(value => value.trim()).filter(Boolean);
}

test("isolated real MySQL merchant share transactions, maturity, corrections and immutable snapshots", { skip: !OPT_IN, timeout: 180000 }, async t => {
  const report = { testOnly: true, startedAt: new Date().toISOString(), businessDatabaseSelected: false, defaultRunTouchesDatabase: false,
    plannedTestGroups: 15, cases: [], isolatedDatabaseCreated: false, isolatedDatabaseDropped: false, cleanupRequired: false, cleanupVerified: false, status: "running" };
  const output = path.resolve(__dirname, "../../..", ".codex-tmp/merchant-share-qa/mysql-isolated-results.json");
  let admin, pool, created = false, completed = false, stage = "configuration";
  let originalDatabase = "";
  const database = `lxm_share_qa_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  assert.ok(SAFE_NAME.test(database));
  try {
    const testConfig=process.env.SHARE_MYSQL_TEST_ENV || path.resolve(__dirname, "../../.env");
    const loaded=require("dotenv").config({ path:testConfig,quiet:true,override:!!process.env.SHARE_MYSQL_TEST_ENV });
    if(process.env.SHARE_MYSQL_TEST_ENV && loaded.error) throw Object.assign(new Error('test connection configuration unavailable'),{code:'ISOLATED_MYSQL_NOT_CONFIGURED'});
    const mysql = require("mysql2/promise");
    const env = process.env;
    originalDatabase = String(env.DB_NAME || env.MYSQL_DATABASE || "");
    const config = { host: env.DB_HOST || env.MYSQL_HOST, port: Number(env.DB_PORT || env.MYSQL_PORT || 3306),
      user: env.DB_USER || env.MYSQL_USER, password: env.DB_PASSWORD ?? env.MYSQL_PASSWORD ?? "", connectTimeout: 5000,
      multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, timezone: "+00:00",
      ...(String(env.DB_SSL || "").toLowerCase() === "true" ? { ssl: { rejectUnauthorized: true } } : {}) };
    if (!config.host || !config.user || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw Object.assign(new Error("not configured"), { code: "ISOLATED_MYSQL_NOT_CONFIGURED" });
    }
    // No database option is passed to this administrative connection.
    stage = "connect";
    admin = await mysql.createConnection(config);
    const [[adminScope]] = await admin.query("SELECT DATABASE() AS selected_database");
    assert.equal(adminScope.selected_database === null, true, "the initial connection must not select any business database");
    stage = "create_database";
    assert.equal(database.toLowerCase() !== originalDatabase.toLowerCase(), true, "the isolation target must differ from the configured business database");
    // No IF EXISTS/IF NOT EXISTS: only a successful CREATE establishes ownership.
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    report.isolatedDatabaseCreated = true;
    report.isolatedDatabase = database;
    pool = mysql.createPool({ ...config, database, waitForConnections: true, connectionLimit: 12 });
    async function inDatabase(work, transactional = true) {
      const conn = await pool.getConnection();
      try {
        const [[scope]] = await conn.query("SELECT DATABASE() AS selected_database");
        assert.equal(scope.selected_database === database, true, "all test/store SQL must remain in this run's isolated database");
        await conn.query("SET time_zone = '+00:00'");
        if (transactional) await conn.beginTransaction();
        try { const result = await work(conn); if (transactional) await conn.commit(); return result; }
        catch (error) { if (transactional) await conn.rollback(); throw error; }
      } catch (error) { throw safeError(error, "isolated_query"); }
      finally { conn.release(); }
    }
    const source = { transaction: work => inDatabase(work) };
    let clock = "2026-11-01T00:00:00.000Z";
    const setTime = value => { clock = value; };
    const newStore = () => createShareStore(source, { clock: () => clock, enableAt: "2026-11-01T00:00:00Z" });
    const store = newStore();
    const query = (sql, values = []) => inDatabase(conn => conn.query(sql, values), false);
    const count = async (table, predicate = "", values = []) => {
      assert.match(table, /^lxm_share_[a-z_]+$/);
      const [[row]] = await query(`SELECT COUNT(*) AS n FROM \`${table}\`${predicate ? ` WHERE ${predicate}` : ""}`, values);
      return Number(row.n);
    };
    async function check(name, work) {
      await t.test(name, async () => {
        try { await work(); report.cases.push({ name, status: "passed" }); }
        catch (error) { report.cases.push({ name, status: "failed", code: codeOf(error) }); throw safeError(error, name); }
      });
    }
    stage = "business_tests";
    await check("015 schema and independent projection table are created only in the isolated database", async () => {
      await store.ensureSchema();
      await query("CREATE TABLE lxm_share_qa_projection (id VARCHAR(128) PRIMARY KEY, name VARCHAR(255) NOT NULL) ENGINE=InnoDB");
      assert.equal(await count("lxm_share_snapshot"), 0);
      assert.equal(await count("lxm_share_schedule"), 0);
    });
    await check("beforeCommit failure rolls back merchant, rule, QR, audit and same-connection account projection", async () => {
      const input = merchant("rollback");
      await assert.rejects(store.onboardMerchant(input, { beforeCommit: async conn => {
        await conn.query("INSERT INTO lxm_share_qa_projection(id,name) VALUES (?,?)", [input.merchantId, "synthetic account projection"]);
        throw Object.assign(new Error("deliberate test failure"), { code: "ISOLATED_QA_HOOK_FAILURE" });
      } }), { code: "ISOLATED_QA_HOOK_FAILURE" });
      for (const table of ["merchant", "rule", "qr", "audit", "qa_projection"]) assert.equal(await count(`lxm_share_${table}`), 0);
    });
    await check("explicit native cutover preserves every super account and staff history, clears only merchant legacy amounts, and is idempotent", async () => {
      const schema=require('../lib/mysqlSchema.cjs');
      for(const statement of schema.authCoreStatements()) await query(statement);
      for(const statement of schema.schemaStatements()) if(/^CREATE TABLE IF NOT EXISTS `(?:lxm_auth_user_attributes|lxm_auth_menu_attributes|lxm_shops|lxm_reconciliationTransfers|lxm_adjustmentRecords|lxm_staff|lxm_orders)`/.test(statement)) await query(statement);
      await query("INSERT INTO lxm_auth_roles (id,role_key,name) VALUES ('qa-super','super','QA Super'),('qa-old-role','service','QA Old')");
      await query("INSERT INTO lxm_auth_users (id,account,display_name,password_hash,role_id,status) VALUES ('qa-admin','admin','QA Admin','synthetic','qa-super','active'),('qa-super-peer','qa-super-peer','QA disabled super','synthetic','qa-super','disabled'),('qa-old-user','qa-old-user','QA old user','synthetic','qa-old-role','active')");
      await query("INSERT INTO lxm_auth_user_attributes (user_id,attribute_key,ordinal,value_type,value_text) VALUES ('qa-super-peer','qaMarker',0,'string','retain-disabled-super'),('qa-old-user','qaMarker',0,'string','remove-old-user')");
      await query("INSERT INTO lxm_auth_role_permissions (role_id,permission_key) VALUES ('qa-super','qa:preserve'),('qa-old-role','qa:remove')");
      await query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,status) VALUES ('qa-shops','shops','旧商家','/shops','active')");
      await query("INSERT INTO lxm_shops (id,name,commissionRate,shareRatio) VALUES ('qa-old-shop','QA旧商家',0.2,0.1)");
      await query("INSERT INTO lxm_reconciliationTransfers (id,objectType,amount,status) VALUES ('qa-merchant-transfer','商家',20,'待结算'),('qa-photo-transfer','摄影师',123,'待结算')");
      await query("INSERT INTO lxm_adjustmentRecords (id,targetType,amount) VALUES ('qa-merchant-adjustment','merchant',5),('qa-staff-adjustment','staff',2)");
      await query("INSERT INTO lxm_staff (id,name) VALUES ('qa-history-staff','QA history staff')");
      await query("INSERT INTO lxm_orders (id,orderNo) VALUES ('qa-history-order','QA-HISTORY-ORDER')");
      const {migrate}=require('../../scripts/migrate-merchant-share.cjs');
      const preview=await migrate(source,{apply:false,reset:true});
      assert.equal(preview.dryRun,true);assert.equal(preview.counts.nonSuperAccounts,1);assert.equal(preview.counts.nonSuperRoles,1);
      await assert.rejects(migrate(source,{apply:true,reset:true}),/备份/);
      const options={apply:true,reset:true,confirmation:'RESET_MERCHANT_SHARE',backupConfirmed:true};
      assert.equal((await migrate(source,options)).resetApplied,true);
      const [users]=await query('SELECT id,status FROM lxm_auth_users ORDER BY id');
      assert.deepEqual(users.map(row=>[row.id,row.status]),[['qa-admin','active'],['qa-super-peer','disabled']]);
      const [attrs]=await query('SELECT user_id,value_text FROM lxm_auth_user_attributes');
      assert.deepEqual(attrs.map(row=>[row.user_id,row.value_text]),[['qa-super-peer','retain-disabled-super']]);
      const [permissions]=await query('SELECT role_id,permission_key FROM lxm_auth_role_permissions');
      assert.deepEqual(permissions.map(row=>[row.role_id,row.permission_key]),[['qa-super','qa:preserve']]);
      const [[legacyShop]]=await query("SELECT commissionRate,shareRatio FROM lxm_shops WHERE id='qa-old-shop'");
      assert.equal(Number(legacyShop.commissionRate),0);assert.equal(Number(legacyShop.shareRatio),0);
      const [transfers]=await query('SELECT id,amount,status FROM lxm_reconciliationTransfers ORDER BY id');
      assert.deepEqual(transfers.map(row=>[row.id,Number(row.amount),row.status]),[['qa-merchant-transfer',0,'已清零'],['qa-photo-transfer',123,'待结算']]);
      const [adjustments]=await query('SELECT id,amount FROM lxm_adjustmentRecords ORDER BY id');
      assert.deepEqual(adjustments.map(row=>[row.id,Number(row.amount)]),[['qa-merchant-adjustment',0],['qa-staff-adjustment',2]]);
      const [[history]]=await query("SELECT (SELECT COUNT(*) FROM lxm_staff WHERE id='qa-history-staff') AS staff,(SELECT COUNT(*) FROM lxm_orders WHERE id='qa-history-order') AS orders");
      assert.equal(Number(history.staff),1);assert.equal(Number(history.orders),1);
      await query("INSERT INTO lxm_auth_roles (id,role_key,name) VALUES ('qa-new-role','qa-new','QA new role')");
      await query("INSERT INTO lxm_auth_users (id,account,display_name,password_hash,role_id,status) VALUES ('qa-new-user','qa-new-user','QA new user','synthetic','qa-new-role','active')");
      assert.equal((await migrate(source,options)).resetApplied,false);
      const [[newUser]]=await query("SELECT COUNT(*) AS n FROM lxm_auth_users WHERE id='qa-new-user'");assert.equal(Number(newUser.n),1);
      assert.equal(await count('lxm_share_audit',"action='LEGACY_RESET_APPLIED'"),1);
    });
    await check("two merchants commit first rules, QR codes and their account projections atomically", async () => {
      for (const merchantId of ["m1", "m2"]) {
        const value = await store.onboardMerchant(merchant(merchantId), { beforeCommit: conn => conn.query("INSERT INTO lxm_share_qa_projection(id,name) VALUES (?,?)", [merchantId, "synthetic account projection"]) });
        assert.equal(value.rule.versionNo, 1); assert.equal(value.qr.qrSeq, 1);
      }
      assert.equal(await count("lxm_share_merchant"), 2);
      assert.equal(await count("lxm_share_qa_projection"), 2);
    });
    await check("real SQL scans use server time; T2 uses latest scan regardless of prior pending T1", async () => {
      setTime("2026-11-01T01:00:00Z");
      const scan = await store.reportScan({ userId: "u-priority", scene: "c=m1", scanAt: "2030-01-01T00:00:00Z" });
      assert.equal(new Date(scan.scan.scanAt).toISOString(), "2026-11-01T01:00:00.000Z");
      const first = await store.enqueuePayment({ orderId: "priority-t1", userId: "u-priority", paidTotal: "500.00", payTime: clock, provider: "wechat_pay", display: { orderNo: "QA-FIRST", productName: "synthetic products" } });
      assert.equal(first.decision.hitMerchantId, "m1");
      setTime("2026-11-01T02:00:00Z");
      await store.reportScan({ userId: "u-priority", scene: "c=m2" });
      await store.reportClick({ userId: "u-priority", staffId: "synthetic-service", linkId: "synthetic-verified-link" });
      const second = await store.enqueuePayment({ orderId: "priority-t2", userId: "u-priority", paidTotal: "100.00", payTime: clock, provider: "wechat_pay" });
      assert.equal(second.decision.hitMerchantId, "m2"); assert.equal(second.decision.hitReason, "BINDING");
      assert.equal(await store.getSnapshot("priority-t1"), null);
      assert.equal(await count("lxm_share_scan"), 2, "a customer-service click cannot create a scan");
    });
    let originalMature;
    await check("pre-maturity refund reduces the base; 3-day boundary and ten concurrent consumers produce one immutable snapshot", async () => {
      setTime("2026-11-02T00:00:00Z");
      await store.recordRefund({ orderId: "priority-t1", refundNo: "before-maturity", amount: "200.00" });
      setTime("2026-11-04T00:59:59.999Z");
      assert.equal((await store.processJob("priority-t1")).pending, true);
      assert.equal(await store.getSnapshot("priority-t1"), null);
      setTime("2026-11-04T01:00:00Z");
      const restarted = newStore();
      const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? restarted : store).processJob("priority-t1")));
      assert.equal(results.filter(result => result.existed === false).length, 1);
      assert.equal(await count("lxm_share_snapshot", "order_id=?", ["priority-t1"]), 1);
      assert.equal(await count("lxm_share_detail", "order_id=? AND direction=1", ["priority-t1"]), 1);
      originalMature = await store.getSnapshot("priority-t1");
      assert.equal(originalMature.baseAmount, "300.00"); assert.equal(originalMature.splitAmount, "15.00");
      assert.equal(originalMature.refundWindowDays, 3);
    });
    await check("post-maturity cumulative refunds, duplicate callbacks and full refund leave net zero without changing the original snapshot", async () => {
      setTime("2026-11-04T03:00:00Z");
      const refund = { orderId: "priority-t1", refundNo: "after-maturity-part", amount: "100.00" };
      const results = await Promise.all([store.recordRefund(refund), newStore().recordRefund(refund)]);
      assert.equal(results.filter(result => !result.existed).length, 1);
      await store.recordRefund({ orderId: "priority-t1", refundNo: "after-maturity-rest", amount: "200.00" });
      assert.equal((await store.listDetails({ orderId: "priority-t1", all: true })).sum.netAmount, "0.00");
      assert.deepEqual(await store.getSnapshot("priority-t1"), originalMature);
      const later = await store.enqueuePayment({ orderId: "after-full-refund-t2", userId: "u-priority", paidTotal: "10.00", payTime: clock, provider: "wechat_pay" });
      assert.equal(later.decision.hitMerchantId, "m2"); assert.equal(later.decision.hitReason, "BINDING");
    });
    await check("append-only correction transfers the effective revision; subsequent refunds use the corrected merchant and amount", async () => {
      setTime("2026-11-05T00:00:00Z");
      await store.saveRule({ ...merchant("m1"), expectedVersion: 1, refundWindowDays: 0, ratioT2: "0.0800", reason: "synthetic correction scenario" });
      await store.saveRule({ ...merchant("m2"), expectedVersion: 1, refundWindowDays: 0, reason: "synthetic correction scenario" });
      setTime("2026-11-05T01:00:00Z"); await store.reportScan({ userId: "u-correction", scene: "c=m1" });
      setTime("2026-11-05T02:00:00Z"); await store.reportScan({ userId: "u-correction", scene: "c=m2" });
      await store.reportClick({ userId: "u-correction", staffId: "synthetic-service", linkId: "synthetic-correction-link" });
      setTime("2026-11-05T02:10:00Z");
      await store.enqueuePayment({ orderId: "correction-t2", userId: "u-correction", paidTotal: "100.00", payTime: clock, provider: "wechat_pay" });
      await store.processJob("correction-t2");
      const original = await store.getSnapshot("correction-t2"); assert.equal(original.hitMerchantId, "m2");
      await store.recordRefund({ orderId: "correction-t2", refundNo: "correction-before", amount: "20.00" });
      setTime("2026-11-06T00:00:00Z");
      await store.enqueuePayment({ orderId: "late-earlier-t1", userId: "u-correction", paidTotal: "50.00", payTime: "2026-11-05T01:30:00Z", provider: "wechat_pay" });
      // Simulate recovery of a missing pre-payment scan fact. An earlier
      // payment alone no longer transfers a later order's attribution.
      setTime("2026-11-05T02:05:00Z"); await store.reportScan({ userId: "u-correction", scene: "c=m1" });
      setTime("2026-11-06T00:00:00Z");
      const input = { requestId: "isolated-correction-one", reason: "synthetic recovered earlier payment evidence", operatorId: "synthetic-super" };
      const results = await Promise.all([store.correctSnapshot("correction-t2", input), newStore().correctSnapshot("correction-t2", input)]);
      assert.equal(results.filter(result => !result.existed).length, 1);
      const corrected = results.find(result => !result.existed);
      assert.equal(corrected.state.hitMerchantId, "m1"); assert.equal(corrected.state.splitAmount, "6.40");
      assert.deepEqual(corrected.details.map(row => [row.merchantId, row.amount, row.entryType]), [["m2", "-2.40", "CORRECTION_REVERSE"], ["m1", "6.40", "CORRECTION_POST"]]);
      await store.recordRefund({ orderId: "correction-t2", refundNo: "correction-after", amount: "30.00" });
      const partial = await store.listDetails({ orderId: "correction-t2", all: true });
      assert.equal(partial.sum.netAmount, "4.00");
      const reversal = partial.list.find(row => row.refundNo === "correction-after");
      assert.equal(reversal.merchantId, "m1"); assert.equal(reversal.amount, "-2.40"); assert.equal(reversal.revisionNo, 1);
      await store.recordRefund({ orderId: "correction-t2", refundNo: "correction-full", amount: "50.00" });
      assert.equal((await store.listDetails({ orderId: "correction-t2", all: true })).sum.netAmount, "0.00");
      assert.equal((await store.getCorrections("correction-t2")).length, 1);
      assert.deepEqual(await store.getSnapshot("correction-t2"), original);
    });
    await check("QR rotations preserve multiple disabled codes and exactly one active code", async () => {
      setTime("2026-11-06T02:00:00Z");
      for (const revision of [1, 2]) await store.rotateQr({ merchantId: "m1", id: `qa-qr-${revision}`, scene: `qa-rotate-${revision}`, imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "synthetic printed material replacement", operatorId: "synthetic-super", requestId: `qa-rotate-request-${revision}` });
      const codes = await store.listQrs("m1");
      assert.equal(codes.length, 3); assert.equal(codes.filter(row => row.status === "ACTIVE").length, 1); assert.equal(codes.filter(row => row.status === "DISABLED").length, 2);
      await assert.rejects(store.reportScan({ userId: "u-old-code", scene: "c=m1" }), { code: "SHARE_4002" });
      const oldActive=await store.getActiveQr('m1');
      const tasks=[...Array.from({length:12},(_,index)=>store.reportScan({userId:`u-qr-concurrent-${index}`,scene:oldActive.scene})),
        ...['a','b'].map(key=>newStore().rotateQr({merchantId:'m1',id:`qa-qr-concurrent-${key}`,scene:`qa-concurrent-${key}`,imageUrl:'data:image/png;base64,iVBORw0KGgo=',reason:'synthetic concurrent rotation',operatorId:'synthetic-super',requestId:`qa-concurrent-rotation-${key}`}))];
      const results=await Promise.allSettled(tasks);
      for(const result of results.slice(0,12)) if(result.status==='rejected') assert.equal(result.reason.code,'SHARE_4002','a scan may lose to rotation, but cannot fail with a deadlock');
      for(const result of results.slice(12)) assert.equal(result.status,'fulfilled');
      const finalCodes=await store.listQrs('m1');assert.equal(finalCodes.length,5);assert.equal(finalCodes.filter(row=>row.status==='ACTIVE').length,1);
      await assert.rejects(store.reportScan({userId:'u-qr-after-rotation',scene:oldActive.scene}),{code:'SHARE_4002'});
      await store.reportScan({userId:'u-qr-after-rotation',scene:(await store.getActiveQr('m1')).scene});
    });
    await check("close and reopen do not restore old bindings; a later valid scan does", async () => {
      setTime("2026-11-07T01:00:00Z"); await store.reportScan({ userId: "u-reopen", scene: "c=m2" });
      setTime("2026-11-08T00:00:00Z"); await store.upsertMerchant({ merchantId: "m2", status: "CLOSED" });
      assert.equal((await store.getMerchantStats("m2")).boundUsers, 0);
      setTime("2026-11-09T00:00:00Z"); await store.upsertMerchant({ merchantId: "m2", status: "OPEN" });
      assert.equal((await store.getMerchantStats("m2")).boundUsers, 0);
      await store.reportScan({ userId: "u-reopen", scene: "c=m2" });
      assert.equal((await store.getMerchantStats("m2")).boundUsers, 1);
    });
    await check("durable scheduled-slot claim has one owner across two store instances", async () => {
      setTime("2026-11-09T02:00:00Z");
      const input = { name: "QA_METRICS", slotAt: "2026-11-08T17:15:00Z", now: clock, intervalMs: 86400000, leaseSeconds: 300 };
      const claims = await Promise.all([store.claimScheduledSlot(input), newStore().claimScheduledSlot(input)]);
      assert.equal(claims.filter(result => result.claimed).length, 1);
      const owner = claims.find(result => result.claimed);
      assert.equal(await store.completeScheduledSlot({ ...owner, now: clock, nextSlotAt: "2026-11-09T17:15:00Z", result: { synthetic: true } }), true);
    });
    await check("case-sensitive opaque user identities retain independent bindings", async () => {
      setTime("2026-11-10T00:00:00Z");
      await store.reportScan({userId:'u-CaseSensitive',scene:(await store.getActiveQr('m1')).scene});
      await store.reportScan({userId:'u-casesensitive',scene:(await store.getActiveQr('m2')).scene});
      const upper=await store.getBindingsAsOf('u-CaseSensitive',clock);
      const lower=await store.getBindingsAsOf('u-casesensitive',clock);
      assert.equal(upper.length,1);assert.equal(lower.length,1);
      assert.equal(upper[0].merchantId,'m1');assert.equal(lower[0].merchantId,'m2');
    });
    await check("016 triggers reject snapshot and audit UPDATE/DELETE with SQLSTATE 45000", async () => {
      for (const statement of sqlStatements(path.resolve(__dirname, "../migrations/016_share_immutability.sql"))) await query(statement);
      const original = await store.getSnapshot("priority-t1");
      for (const statement of ["UPDATE lxm_share_snapshot SET split_amount=split_amount WHERE order_id=?", "DELETE FROM lxm_share_snapshot WHERE order_id=?"]) {
        await assert.rejects(query(statement, ["priority-t1"]), error => error.code === "ER_SIGNAL_EXCEPTION" && error.sqlState === "45000");
      }
      assert.deepEqual(await store.getSnapshot("priority-t1"), original);
      assert.equal(await count("lxm_share_snapshot", "order_id=?", ["priority-t1"]), 1);
      for(const table of ['lxm_share_audit','lxm_share_correction']) {
        for(const statement of [`UPDATE ${table} SET id=id LIMIT 1`,`DELETE FROM ${table} LIMIT 1`]) await assert.rejects(query(statement),error=>error.code==='ER_SIGNAL_EXCEPTION' && error.sqlState==='45000');
      }
    });
    await check("real onboarding service commits hashed credentials and shop projection; projection failure or disabled role rolls back the full aggregate", async () => {
      const schema = require('../lib/mysqlSchema.cjs');
      for (const statement of schema.authCoreStatements()) await query(statement);
      const shops = schema.schemaStatements().find(statement => /^CREATE TABLE IF NOT EXISTS `lxm_shops`/.test(statement));
      assert.ok(shops);
      await query(shops);
      const {createShareService} = require('../lib/merchantShare.cjs');
      const {verifyPassword} = require('../lib/permissionStore.cjs');
      const service = createShareService(source,{store,clock:()=>new Date(clock),qrProvider:async()=> 'data:image/png;base64,iVBORw0KGgo='});
      const superSession={kind:'admin',role:'super',subjectId:'synthetic-super'};
      const input={name:'QA真实开户门店',account:'qa-native-merchant',password:'SyntheticPass123!',cooperationConfirmed:true,ratioT1:'0.0500',ratioT2:'0.0300',ttlHours:720,refundWindowDays:3,reason:'synthetic native onboarding verification'};
      const created=await service.onboard(input,superSession,'native-service-onboard');
      const [[user]]=await query('SELECT * FROM lxm_auth_users WHERE id=?',[`usr_${created.merchantId}`]);
      assert.equal(user.subject_id,created.merchantId);assert.equal(user.shop_id,created.merchantId);assert.equal(user.subject_type,'merchant');
      assert.equal(user.password_hash.startsWith('lxm1$'),true);assert.equal(verifyPassword(user.password_hash,input.password),true);
      const [[shop]]=await query('SELECT * FROM lxm_shops WHERE id=?',[created.merchantId]);
      assert.equal(shop.name,input.name);assert.equal(Number(shop.commissionRate),0);assert.equal(Number(shop.shareRatio),0);
      const [[menu]]=await query("SELECT COUNT(*) AS n FROM lxm_auth_role_menus WHERE role_id='role_merchant' AND menu_key='shareMine'");
      assert.equal(Number(menu.n),1);
      assert.equal((await service.onboard(input,superSession,'native-service-onboard')).existed,true);
      await assert.rejects(service.onboard({...input,password:'OtherPass123!'},superSession,'native-service-onboard'),{code:'SHARE_4090'});

      const tables=['lxm_share_merchant','lxm_share_rule','lxm_share_qr','lxm_share_audit','lxm_auth_users'];
      async function rowCounts() { const values=[];for(const table of tables) {const [[row]]=await query(`SELECT COUNT(*) AS n FROM ${table}`);values.push(Number(row.n));}return values; }
      const counts=await rowCounts();
      const request='native-projection-failure';
      const failedId=`sm_${crypto.createHash('sha256').update(`${superSession.subjectId}:${request}`).digest('hex').slice(0,24)}`;
      // Force the production beforeCommit hook to fail AFTER inserting the account.
      await query('INSERT INTO lxm_shops (id,name) VALUES (?,?)',[failedId,'QA pre-existing synthetic projection']);
      // The store translates the SQL duplicate into its public conflict code.
      await assert.rejects(service.onboard({...input,name:'QA投影失败门店',account:'qa-projection-failure'},superSession,request),{code:'SHARE_4090'});
      assert.deepEqual(await rowCounts(),counts);assert.equal(await store.getMerchant(failedId),null);
      await query('DELETE FROM lxm_shops WHERE id=?',[failedId]);

      await query("UPDATE lxm_auth_roles SET status='disabled' WHERE id='role_merchant'");
      await assert.rejects(service.onboard({...input,name:'QA停用角色门店',account:'qa-disabled-role'},superSession,'native-disabled-role'),{code:'SHARE_4030'});
      assert.deepEqual(await rowCounts(),counts);
      const [[role]]=await query("SELECT status FROM lxm_auth_roles WHERE id='role_merchant'");assert.equal(role.status,'disabled');
      await query("UPDATE lxm_auth_roles SET status='active' WHERE id='role_merchant'");
    });
    await check("native share grants change capabilities and menus atomically and revoke both while preserving unrelated grants", async () => {
      const createPermissionStore=require('../lib/mysqlPermissionStore.cjs');
      const permissionStore=createPermissionStore({pool,autoMigrate:false,logger:{warn(){},error(){}}});
      await query("INSERT INTO lxm_auth_roles (id,role_key,name) VALUES ('qa-grant-role','qa-operator','QA Operator'),('qa-finance-role','finance','QA Finance')");
      await query("INSERT INTO lxm_auth_role_menus (role_id,menu_key) VALUES ('qa-grant-role','orders')");
      await permissionStore.setShareGrants('qa-grant-role',['share:config']);
      async function grants() {
        const [caps]=await query("SELECT permission_key FROM lxm_auth_role_permissions WHERE role_id='qa-grant-role' ORDER BY permission_key");
        const [menus]=await query("SELECT menu_key FROM lxm_auth_role_menus WHERE role_id='qa-grant-role' ORDER BY menu_key");
        return {caps:caps.map(row=>row.permission_key),menus:menus.map(row=>row.menu_key)};
      }
      assert.deepEqual(await grants(),{caps:['share:config','share:view'],menus:['orders','shareDetails','shareRules']});
      await assert.rejects(permissionStore.setShareGrants('qa-finance-role',['share:config']),{code:'SHARE_4001'});
      const before=await grants();
      await query("CREATE TRIGGER lxm_qa_reject_share_grant BEFORE INSERT ON lxm_auth_role_menus FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic grant rollback'");
      try { await assert.rejects(permissionStore.setShareGrants('qa-grant-role',['share:view']),{code:'ER_SIGNAL_EXCEPTION'});assert.deepEqual(await grants(),before); }
      finally { await query('DROP TRIGGER lxm_qa_reject_share_grant'); }
      await permissionStore.setShareGrants('qa-grant-role',[]);
      assert.deepEqual(await grants(),{caps:[],menus:['orders']});
    });
    completed = report.cases.every(result => result.status === "passed");
    report.status = completed ? "passed" : "failed";
  } catch (error) {
    report.status = (["connect", "configuration"].includes(stage) && CONNECTION_LIMITS.has(codeOf(error)))
      || (stage === "create_database" && CREATE_LIMITS.has(codeOf(error))) ? "external_blocked" : "failed";
    report.error = { stage, code: codeOf(error) };
    throw safeError(error, stage);
  } finally {
    let cleanupFailure = null;
    try { if (pool) await pool.end(); }
    catch (error) { report.poolCloseError = { code: codeOf(error) }; cleanupFailure = error; }
    try {
      if (created) {
        report.cleanupRequired = true;
        assert.ok(SAFE_NAME.test(database), "cleanup target must be this run's validated random database");
        assert.equal(database.toLowerCase() !== originalDatabase.toLowerCase(), true, "cleanup must never target the configured business database");
        await admin.query(`DROP DATABASE \`${database}\``);
        report.isolatedDatabaseDropped = true;
        const [remaining] = await admin.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database]);
        report.cleanupVerified = remaining.length === 0;
        report.cleanupStatus = report.cleanupVerified ? "owned_database_dropped_and_absence_checked" : "absence_check_failed";
        assert.equal(report.cleanupVerified, true);
      } else { report.cleanupStatus = "not_required_no_database_created_by_this_run"; report.cleanupVerified = true; }
    } catch (error) {
      report.cleanupError = { code: codeOf(error) }; cleanupFailure = error;
    } finally {
      if (admin) await admin.end().catch(() => {});
      if (cleanupFailure) report.status = "cleanup_failed";
      report.finishedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
    }
    if (cleanupFailure) throw safeError(cleanupFailure, "cleanup");
  }
});
