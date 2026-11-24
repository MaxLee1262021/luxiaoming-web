"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { svcAccountsSqlFixture } = require("./fixtures/svcAccountsSql.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const { createSvcCommission } = require("../lib/svcCommission.cjs");

// No environment files, database connections or real invitation requests.
const root = { kind: "admin", role: "super", authzUserId: "test-root" };
const input = { name: "企微测试客服", phone: "13900139020", joined_at: "2026-11-19", base_salary: 3000, rate_mode: "global", create_account: true, account: "wecom-test-service", password: "ServiceQA2026!" };
const member = { userid: "test_wecom_member", departmentId: 2, invitationStatus: "submitted" };
const create = (fixture, patch = {}) => fixture.commission.execute("POST", "/api/svc/staff", { ...input, ...patch }, root);
const retry = (service, id, session = root) => service.execute("POST", `/api/svc/staff/${id}/wecom-sync`, {}, session);
const profile = (patch = {}) => ({ id: "test-staff", name: input.name, phone: input.phone, staff_status: "active", account_id: "test-login", wecom_sync_status: "pending", ...patch });
function memoryFixture({ staff = profile(), ensureMember = async () => member, enabled = true, clock = () => "2026-11-19 12:00:00" } = {}) {
  const store = createSvcMemoryStore({ staff: [staff] });
  return { store, commission: createSvcCommission({ store, clock, wecomContacts: { enabled, ensureMember } }) };
}

test("onboarding commits its local profile and account before inviting and maps the login account", async () => {
  let calls = 0, f;
  f = svcAccountsSqlFixture({ wecomContacts: { enabled: true, async ensureMember(request) {
    calls++;
    const stored = f.tables().svc_staff[0];
    assert.equal(stored.id, request.staffId);
    assert.equal(stored.wecom_sync_status, "syncing");
    assert.equal(f.tables().lxm_auth_users[0].id, stored.account_id);
    assert.equal(f.tables().benefit_rule.filter(rule => rule.party_id === stored.id).length, 1);
    assert.equal(f.tables().svc_staff_profile_log.length, 1);
    // A second transaction must be able to acquire the accounting lock while
    // HTTP is in flight; inviting inside onboarding would deadlock this read.
    assert.equal(await f.source.transaction(async () => f.tables().svc_staff.length), 1);
    assert.deepEqual(request, { staffId: stored.id, name: input.name, phone: input.phone, userid: undefined });
    return member;
  } } });
  const saved = await create(f);
  assert.equal(calls, 1); assert.equal(saved.wecom_sync_status, "synced");
  assert.equal(saved.wecom_userid, member.userid); assert.equal(saved.wecom_department_id, 2);
  assert.match(saved.wecom_sync_message, /邀请已提交/);
  assert.equal(f.tables().svc_staff[0].wecom_sync_status, "synced");
  assert.deepEqual(f.tables().lxm_share_staff_map.map(row => ({ userid: row.wecom_userid, account: row.staff_id, status: row.status })), [{ userid: member.userid, account: saved.account_id, status: "ACTIVE" }]);
  assert.notEqual(saved.id, saved.account_id);
  const listed = await f.commission.execute("GET", "/api/svc/staff", {}, root);
  assert.equal(listed.list[0].wecom_userid, member.userid);
  assert.equal(listed.list[0].wecom_sync_status, "synced");
  assert.equal(JSON.stringify(saved).includes(input.password), false);
});

test("invitation failures preserve local credentials and retry the same saved profile", async () => {
  let calls = 0;
  const f = svcAccountsSqlFixture({ wecomContacts: { enabled: true, async ensureMember(request) {
    calls++;
    if (calls === 1) throw Object.assign(new Error("private token should not escape"), { userid: member.userid, userMessage: "邀请未完成，请重试" });
    assert.equal(request.userid, member.userid); return member;
  } } });
  const saved = await create(f);
  assert.equal(saved.wecom_sync_status, "failed"); assert.equal(saved.wecom_userid, member.userid);
  assert.equal(f.tables().lxm_auth_users.length, 1); assert.equal(f.tables().svc_staff.length, 1);
  const original = structuredClone(f.tables().lxm_auth_users[0]);
  const retried = await retry(f.commission, saved.id);
  assert.equal(retried.id, saved.id); assert.equal(retried.wecom_sync_status, "synced"); assert.equal(calls, 2);
  assert.deepEqual(f.tables().lxm_auth_users, [original]); assert.equal(f.tables().svc_staff_profile_log.length, 1);
  assert.equal(f.tables().benefit_rule.filter(rule => rule.party_id === saved.id).length, 1);
  await assert.rejects(create(f, { account: "duplicate-retry" }), /手机号或账号已建档/);
  assert.equal(calls, 2); assert.equal(f.tables().lxm_auth_users.length, 1);
});

test("failed local onboarding never calls the invitation API", async () => {
  let calls = 0;
  const f = svcAccountsSqlFixture({ wecomContacts: { enabled: true, async ensureMember() { calls++; return member; } } });
  const before = structuredClone(f.tables()); f.fail("INSERT INTO `svc_staff_profile_log`");
  await assert.rejects(create(f), { code: "QA_SQL_FAILURE" });
  assert.equal(calls, 0); assert.deepEqual(f.tables(), before);
});

test("disabled synchronization explicitly reports no invitation and can be enabled and retried", async () => {
  let calls = 0;
  const contacts = { enabled: false, async ensureMember() { calls++; return member; } };
  const f = svcAccountsSqlFixture({ wecomContacts: contacts });
  const saved = await create(f);
  assert.equal(saved.wecom_sync_status, "disabled"); assert.equal(calls, 0);
  assert.match(saved.wecom_sync_message, /尚未启用/);
  assert.equal(f.tables().lxm_auth_users.length, 1);
  contacts.enabled = true;
  assert.equal((await retry(f.commission, saved.id)).wecom_sync_status, "synced"); assert.equal(calls, 1);
});

test("retry authorization rejects non-super callers before any external action", async () => {
  let calls = 0;
  const f = memoryFixture({ ensureMember: async () => { calls++; return member; } });
  const before = f.store.snapshot();
  for (const session of [{ kind: "public", role: "super" }, { kind: "admin", role: "service" }, { kind: "admin", role: "service_supervisor" }, { kind: "admin", role: "finance" }]) {
    await assert.rejects(retry(f.commission, "test-staff", session), { code: 4030 });
  }
  assert.equal(calls, 0); assert.deepEqual(f.store.snapshot(), before);
});

test("concurrent retries share a durable lease and successful retries do not invite twice", async () => {
  let calls = 0, release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = memoryFixture({ ensureMember: async () => { calls++; entered(); await waiting; return member; } });
  const first = retry(f.commission, "test-staff"); await started;
  const second = await retry(f.commission, "test-staff");
  assert.equal(second.wecom_sync_status, "syncing"); assert.equal(calls, 1);
  release(); assert.equal((await first).wecom_sync_status, "synced");
  assert.equal((await retry(f.commission, "test-staff")).wecom_sync_status, "synced"); assert.equal(calls, 1);
});

test("expired leases are recoverable and an obsolete completion cannot overwrite the current result", async () => {
  let time = "2026-11-19 12:00:00", calls = 0, release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = memoryFixture({ clock: () => time, ensureMember: async () => {
    calls++;
    if (calls === 1) { entered(); await waiting; return { ...member, userid: "obsolete-member" }; }
    return member;
  } });
  const first = retry(f.commission, "test-staff"); await started;
  time = "2026-11-19 12:05:01";
  const current = await retry(f.commission, "test-staff");
  assert.equal(current.wecom_userid, member.userid); assert.equal(calls, 2);
  release(); assert.equal((await first).wecom_userid, member.userid);
  assert.equal(f.store.snapshot().staff[0].wecom_userid, member.userid);
});

test("terminated or missing staff cannot be synchronized", async () => {
  let calls = 0;
  const f = memoryFixture({ staff: profile({ staff_status: "ended" }), ensureMember: async () => { calls++; return member; } });
  await assert.rejects(retry(f.commission, "test-staff"), /已终止客服/);
  await assert.rejects(retry(f.commission, "missing-staff"), /客服档案不存在/);
  assert.equal(calls, 0);
});

test("provider raw errors and credentials never enter sync responses or persistent state", async () => {
  const secret = "access_token=PRIVATE_TEST_SECRET", f = memoryFixture({ ensureMember: async () => { throw new Error(secret); } });
  const result = await retry(f.commission, "test-staff");
  assert.equal(result.wecom_sync_status, "failed"); assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(f.store.snapshot()).includes(secret), false);
  assert.match(result.wecom_sync_message, /检查通讯录权限和服务器网络/);
});

test("mapping persistence failures retain the confirmed member ID and retry without recreating local records", async () => {
  let calls = 0, f;
  f = svcAccountsSqlFixture({ wecomContacts: { enabled: true, async ensureMember(request) {
    calls++; if (calls === 1) f.fail("INSERT INTO lxm_share_staff_map");
    else assert.equal(request.userid, member.userid);
    return member;
  } } });
  const first = await create(f);
  assert.equal(first.wecom_sync_status, "failed"); assert.equal(first.wecom_userid, member.userid);
  assert.equal(f.tables().lxm_share_staff_map.length, 0); assert.equal(f.tables().svc_staff.length, 1);
  f.fail(null);
  const result = await retry(f.commission, first.id);
  assert.equal(result.wecom_sync_status, "synced"); assert.equal(calls, 2);
  assert.equal(f.tables().lxm_share_staff_map[0].staff_id, first.account_id);
  assert.equal(f.tables().lxm_auth_users.length, 1); assert.equal(f.tables().svc_staff_profile_log.length, 1);
});

test("a storage outage after external success reports local creation and recovers the expired lease", async () => {
  let time = "2026-11-19 12:00:00", calls = 0, f;
  f = svcAccountsSqlFixture({ clock: () => time, wecomContacts: { enabled: true, async ensureMember() {
    calls++;
    if (calls === 1) f.fail("UPDATE `svc_staff`");
    return member;
  } } });
  const saved = await create(f);
  assert.equal(saved.wecom_sync_status, "pending"); assert.match(saved.wecom_sync_message, /客服已保存/);
  assert.equal(f.tables().svc_staff[0].wecom_sync_status, "syncing");
  assert.equal(f.tables().lxm_share_staff_map.length, 0, "mapping insert must roll back with the failed profile update");
  assert.equal(f.tables().lxm_auth_users.length, 1); assert.equal(f.tables().svc_staff.length, 1);
  f.fail(null);
  assert.equal((await retry(f.commission, saved.id)).wecom_sync_status, "syncing"); assert.equal(calls, 1);
  time = "2026-11-19 12:05:01";
  const result = await retry(f.commission, saved.id);
  assert.equal(result.wecom_sync_status, "synced"); assert.equal(result.wecom_userid, member.userid); assert.equal(calls, 2);
  assert.equal(f.tables().lxm_share_staff_map.length, 1); assert.equal(f.tables().lxm_auth_users.length, 1);
});

test("conflicting mapping is preserved and reported rather than reassigned", async () => {
  for (const conflictType of ["member", "account"]) {
    let f;
    f = svcAccountsSqlFixture({ wecomContacts: { enabled: true, async ensureMember() {
      const accountId = f.tables().svc_staff[0].account_id;
      f.tables().lxm_share_staff_map.push({ wecom_userid: conflictType === "member" ? member.userid : "another-member", staff_id: conflictType === "account" ? accountId : "another-login", status: "ACTIVE", created_at: "2026-11-01 00:00:00" });
      return member;
    } } });
    const result = await create(f);
    assert.equal(result.wecom_sync_status, "failed"); assert.match(result.wecom_sync_message, /已绑定其他客服/);
    const mapping = f.tables().lxm_share_staff_map[0];
    assert.equal(mapping.staff_id, conflictType === "account" ? result.account_id : "another-login");
    assert.equal(mapping.wecom_userid, conflictType === "member" ? member.userid : "another-member");
    assert.equal(f.tables().lxm_share_staff_map.length, 1);
  }
});

test("matching disabled mappings are reactivated without duplicating them", async () => {
  let f;
  f = svcAccountsSqlFixture({ wecomContacts: { enabled: true, async ensureMember() {
    f.tables().lxm_share_staff_map.push({ wecom_userid: member.userid, staff_id: f.tables().svc_staff[0].account_id, status: "INACTIVE", created_at: "2026-11-01 00:00:00" });
    return { ...member, invitationStatus: "active" };
  } } });
  const result = await create(f);
  assert.equal(result.wecom_sync_status, "synced"); assert.equal(result.wecom_sync_message, "已加入企业微信客服部门");
  assert.equal(f.tables().lxm_share_staff_map.length, 1); assert.equal(f.tables().lxm_share_staff_map[0].status, "ACTIVE");
});
