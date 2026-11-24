"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { TABLES, projection, normalize } = require("../lib/photoStore.cjs");
const { migrate, backfill, sameTimestamp, sameLockedSnapshot } = require("../../scripts/migrate-photo-share.cjs");
test("photo migration dry run never opens DB; installation requires explicit zoned activation", async () => {
  const source = { transaction() { throw new Error("unexpected connection"); } };
  assert.equal((await migrate(source)).dryRun, true); await assert.rejects(migrate(source, { apply: true, enableAt: "2026-11-11 00:00:00" }), /含时区/);
});

test("photo installation writes the canonical navigation group and client label", async () => {
  const menus = [];
  const conn = { async query(sql, params = []) {
    if (sql.startsWith("INSERT INTO lxm_auth_menus")) menus.push(params);
    if (/SELECT id FROM benefit_rule/.test(sql)) return [[{ id: "existing-global-rule" }]];
    if (/information_schema/.test(sql)) return [[{ present: true }]];
    return [[]];
  } };
  const source = { transaction: work => work(conn) };
  await migrate(source, { apply: true, enableAt: "2026-11-14T00:00:00+08:00" });
  assert.deepEqual(menus.map(row => row[1]), ["photoRules", "photoLedger", "photoParty", "photoSettlement", "photoMine"]);
  assert.deepEqual(menus.map(row => row[2]), ["分成配置", "分成明细", "摄影师列表", "结算管理", "摄影端"]);
  assert.ok(menus.every(row => row[5] === "摄影师分成管理"));
});

test("confirmed cleanup policy disables historical backfill before any database work",async()=>{
  const source={transaction(){throw Error("must not open DB");},list(){throw Error("must not load old orders");}};
  for(const apply of [false,true]){
    await assert.rejects(migrate(source,{apply,backfill:true,enableAt:"2026-11-11T00:00:00+08:00"}),{code:"PHOTO_BACKFILL_DISABLED"});
    await assert.rejects(backfill(source,{apply}),{code:"PHOTO_BACKFILL_DISABLED"});
  }
  assert.equal((await migrate(source)).legacyFinancePolicy,"scoped-cleanup");
});
test("photo DATETIME/date projections override driver parsing for every business timestamp", () => {
  const fields = new Set(["created_at", "updated_at", "eff_at", "paid_at", "done_at", "pushed_at", "accepted_at", "dispute_until", "next_attempt_at", "sent_at"]);
  for (const [table, , names] of Object.values(TABLES)) {
    const sql = projection(table, names);
    for (const field of names.split(" ").filter(field => fields.has(field))) assert.ok(sql.includes("DATE_FORMAT(`" + field + "`,"), "SQL must return literal " + field);
    if (names.includes("dispute_until")) assert.ok(sql.includes("DATE_FORMAT(`dispute_until`,'%Y-%m-%d') AS `dispute_until`"));
  }
  assert.ok(projection("lxm_orders", "done_at schedule_time requested_time").includes("DATE_FORMAT(`schedule_time`,'%Y-%m-%d %H:%i:%s') AS `schedule_time`"));
});
test("SQL wall-clock strings and real JS instants have distinct timezone-stable normalization", () => {
  const script = "const P=require('./server/lib/photoStore.cjs'),B=require('./server/lib/svcBenefit.cjs');const r=P.normalize({eff_at:'2026-11-30 23:59:59',done_at:'2026-12-01 00:00:00',dispute_until:'2026-12-04',instant:new Date('2026-11-30T16:00:00Z')});process.stdout.write(JSON.stringify({r,period:B.periodAt(r.done_at)}));";
  const outputs = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map(TZ => execFileSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, "../.."), env: { ...process.env, TZ }, encoding: "utf8" }));
  assert.equal(outputs[0], outputs[1]); assert.equal(outputs[1], outputs[2]);
  const result = JSON.parse(outputs[0]); assert.equal(result.r.eff_at, "2026-11-30 23:59:59"); assert.equal(result.r.dispute_until, "2026-12-04"); assert.equal(result.r.instant, "2026-12-01 00:00:00"); assert.equal(result.period, "2026-12");
  assert.equal(normalize({ eff_at: "2026-11-30 23:59:59" }).eff_at, "2026-11-30 23:59:59");
});
test("backfill snapshot compares Date/ISO timestamps and DECIMAL/number amounts without false staleness", () => {
  const original = { updatedAt: "2026-11-11T04:00:00.000Z", totalAmount: 2999 }, normalized = { photo_id: "PH20260001" };
  const locked = { updatedAt: new Date("2026-11-11T04:00:00Z"), totalAmount: "2999.00", photo_id: normalized.photo_id };
  assert.equal(sameLockedSnapshot(locked, original, normalized), true);
  assert.equal(sameLockedSnapshot({ ...locked, totalAmount: "2999.01" }, original, normalized), false);
  assert.equal(sameLockedSnapshot({ ...locked, updatedAt: new Date("2026-11-11T04:00:01Z") }, original, normalized), false);
  assert.equal(sameTimestamp("2026-11-11 12:00:00", "2026-11-11T04:00:00Z"), true);
});
