"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { photoAccountsSqlFixture } = require("./fixtures/photoAccountsSql.cjs");
const { createPhotoShareService } = require("../lib/photoShare.cjs");
const admin = { kind: "admin", role: "super", account: "qa-admin" };
const form = index => ({ name: "建档规则测试" + index, phone: "1389000" + String(index).padStart(4, "0"), account: "photo.rules-" + index, password: "PhotoRules123!", rate_mode: "global", reason: "TEST_ONLY建档规则" });
const legacy = (id, agree) => ({ id, name: "历史摄影师", phone: "13990000000", agree_no: agree, rate_mode: "global", status: "active", dispute_days: 5, wait_days: 3, cycle: "monthly", created_at: "2026-01-01 00:00:00" });

test("generated agreement and daily/weekly/monthly choice commit as typed fields and survive service restart", async () => {
  const f = photoAccountsSqlFixture();
  for (const [index, [cycle, label]] of Object.entries({ daily: "日结", weekly: "周结", monthly: "月结" }).entries()) {
    const created = await f.service.createParty({ ...form(index), cycle, agree_no: "DO-NOT-TRUST-CLIENT", agreeNo: "FORGED" }, admin);
    assert.equal(created.agree_no, "PH-XY-2026-" + String(index + 1).padStart(4, "0"));
    assert.equal(created.cycle, cycle);
    assert.equal(f.tables().photo_profile[index].cycle, cycle);
    const restarted = createPhotoShareService({ source: f.source, clock: () => "2026-11-13 12:00:00" });
    const read = (await restarted.listParties({ keyword: created.id })).rows[0];
    assert.equal(read.agree_no, created.agree_no); assert.equal(read.cycle, cycle);
    assert.ok(read.logs.some(log => log.detail.includes("协议 " + created.agree_no) && log.detail.includes("结算方式 " + label)));
    assert.equal((await restarted.mine({}, { role: "photo", subjectId: created.id })).photo.cycle, cycle);
  }
  const insert = f.statements.find(row => row.sql.startsWith("INSERT INTO photo_profile "));
  assert.match(insert.sql, /`agree_no`/); assert.match(insert.sql, /`cycle`/);
});

test("omitted cycle defaults to monthly and old profiles read as monthly without rewriting history", async () => {
  const f = photoAccountsSqlFixture(), old = legacy("PH20260004", "OLD-HANDWRITTEN-AGREEMENT");
  delete old.cycle; f.tables().photo_profile.push(old);
  const created = await f.service.createParty(form(0), admin);
  assert.equal(created.cycle, "monthly"); assert.equal(created.agree_no, "PH-XY-2026-0005");
  const rows = (await f.service.listParties()).rows;
  assert.equal(rows.find(row => row.id === old.id).cycle, "monthly");
  assert.equal((await f.service.mine({}, { role: "photo", subjectId: old.id })).photo.cycle, "monthly");
  assert.deepEqual(f.tables().photo_profile[0], old);
});

test("invalid cycle cannot create any profile, account, rule or log", async () => {
  for (const cycle of [null, "", "日结", "half-monthly", "weekly ", "toString", 1, {}, []]) {
    const f = photoAccountsSqlFixture(), before = structuredClone(f.tables());
    await assert.rejects(f.service.createParty({ ...form(0), cycle }, admin), error => error.code === 4314);
    assert.deepEqual(f.tables(), before); assert.equal(f.statements.length, 0);
  }
});

test("concurrent onboarding allocates unique annual agreements under the existing SQL lock", async () => {
  const f = photoAccountsSqlFixture();
  const rows = await Promise.all([0, 1, 2].map(index => f.service.createParty(form(index), admin)));
  assert.deepEqual(rows.map(row => row.id), ["PH20260001", "PH20260002", "PH20260003"]);
  assert.deepEqual(rows.map(row => row.agree_no), ["PH-XY-2026-0001", "PH-XY-2026-0002", "PH-XY-2026-0003"]);
  assert.equal(f.statements.filter(row => row.sql === "SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE").length, 3);
});

test("historical agreement sequence and case-insensitive collisions are skipped without changing existing numbers", async () => {
  const f = photoAccountsSqlFixture(), old = legacy("PH20260010", "ph-xy-2026-0015");
  f.tables().photo_profile.push(old);
  const created = await f.service.createParty(form(0), admin);
  assert.equal(created.id, "PH20260011"); assert.equal(created.agree_no, "PH-XY-2026-0016");
  assert.deepEqual(f.tables().photo_profile[0], old);
});

test("annual numbering switches at China midnight and preserves prior-year agreements", async () => {
  const f = photoAccountsSqlFixture(), old = legacy("PH20269999", "PH-XY-2026-9999");
  f.tables().photo_profile.push(old);
  const service = createPhotoShareService({ source: f.source, clock: () => new Date("2026-12-31T16:00:00Z") });
  const created = await service.createParty(form(0), admin);
  assert.equal(created.id, "PH20270001"); assert.equal(created.agree_no, "PH-XY-2027-0001");
  assert.equal(created.created_at, "2027-01-01 00:00:00"); assert.deepEqual(f.tables().photo_profile[0], old);
});

test("agreement exhaustion and failed commits leave no partial onboarding or consumed agreement", async () => {
  const exhausted = photoAccountsSqlFixture();
  exhausted.tables().photo_profile.push(legacy("PH20260001", "PH-XY-2026-9999"));
  const before = structuredClone(exhausted.tables());
  await assert.rejects(exhausted.service.createParty(form(0), admin), error => error.code === 4314 && /合作协议编号已用尽/.test(error.message));
  assert.deepEqual(exhausted.tables(), before);

  const f = photoAccountsSqlFixture(), initial = structuredClone(f.tables());
  f.fail("INSERT INTO photo_profile_log");
  await assert.rejects(f.service.createParty({ ...form(0), cycle: "weekly" }, admin), { code: "QA_SQL_FAILURE" });
  assert.deepEqual(f.tables(), initial);
  f.fail(null);
  const retry = await f.service.createParty({ ...form(0), cycle: "weekly" }, admin);
  assert.equal(retry.agree_no, "PH-XY-2026-0001"); assert.equal(retry.cycle, "weekly");
});
