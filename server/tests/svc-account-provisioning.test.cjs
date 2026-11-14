"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { svcAccountsSqlFixture } = require("./fixtures/svcAccountsSql.cjs");
const { hashPassword, verifyPassword } = require("../lib/mysqlPermissionStore.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const { createSvcCommission } = require("../lib/svcCommission.cjs");
const root = { kind: "admin", role: "super", authzUserId: "qa-root" };
const input = { name: "测试新客服", phone: "13900139020", joined_at: "2026-11-13", base_salary: 3500, rate_mode: "global", settlement_cycle: "周结", create_account: true, account: "  new-service-qa  ", password: "ServiceQA2026!", assessment_tags: ["新员工"], reason: "QA建档" };
const expectedMenus = ["svcWorkbench", "svcIntake", "svcFollowup", "svcComplaints", "svcMine"];
const create = (fixture, patch = {}, session = root) => fixture.commission.execute("POST", "/staff", { ...input, ...patch }, session);
function noSecret(value, password = input.password) {
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes(password), false, "cleartext password leaked");
  assert.equal(/password_hash|passwordHash|lxm1\$/.test(encoded), false, "credential hash leaked");
}

test("direct service onboarding saves its hashed login, profile, rule and audit together", async () => {
  const f = svcAccountsSqlFixture(), result = await create(f), tables = f.tables();
  assert.equal(result.account, "new-service-qa"); assert.ok(result.account_id);
  const user = tables.lxm_auth_users.find(row => row.id === result.account_id);
  assert.equal(user.account, result.account); assert.equal(user.display_name, input.name);
  assert.equal(user.subject_type, "staff"); assert.equal(user.subject_id, result.id); assert.equal(user.status, "active");
  assert.equal(user.phone, input.phone); assert.match(user.password_hash, /^lxm1\$/);
  assert.equal(verifyPassword(user.password_hash, input.password), true); assert.equal(verifyPassword(user.password_hash, "wrong-password"), false);
  const role = tables.lxm_auth_roles.find(row => row.id === user.role_id);
  assert.equal(role.role_key, "service"); assert.equal(role.status, "active");
  assert.deepEqual(tables.lxm_auth_role_menus.filter(row => row.role_id === role.id).map(row => row.menu_key).sort(), expectedMenus.slice().sort());
  assert.equal(tables.svc_staff.length, 1); assert.equal(tables.svc_staff[0].account_id, user.id);
  assert.equal(tables.svc_staff[0].settlement_cycle, "周结");
  assert.equal(tables.benefit_rule.filter(row => row.party_id === result.id).length, 1);
  assert.equal(tables.svc_staff_profile_log.filter(row => row.staff_id === result.id).length, 1);
  assert.deepEqual(tables.svc_staff_tag.map(row => row.tag), ["新员工"]);
  noSecret(result);
  assert.equal(JSON.stringify(tables).includes(input.password), false, "cleartext password entered persistent state");
  for (const path of ["/staff", "/rule", "/me"]) noSecret(await f.commission.execute("GET", path, {}, path === "/me" ? { kind: "admin", role: "service", authzUserId: user.id } : root));
  noSecret(tables.svc_staff); noSecret(tables.svc_staff_profile_log); noSecret(tables.benefit_rule);
});

test("credential validation matches merchant rules and preserves password whitespace", async () => {
  const invalid = [
    { account: "" }, { account: "   " }, { account: "x".repeat(129) }, { account: "bad\naccount" }, { account: "bad\u007faccount" }, { account: " ADMIN " },
    { password: "Ab12345" }, { password: "abcdefghi" }, { password: "123456789" }, { password: "Ab" + "1".repeat(127) }
  ];
  for (const patch of invalid) {
    const f = svcAccountsSqlFixture(), before = structuredClone(f.tables());
    await assert.rejects(create(f, patch)); assert.deepEqual(f.tables(), before);
  }
  const f = svcAccountsSqlFixture(), password = "  Pass123  ";
  const result = await create(f, { password });
  const user = f.tables().lxm_auth_users.find(row => row.id === result.account_id);
  assert.equal(verifyPassword(user.password_hash, password), true);
  assert.equal(verifyPassword(user.password_hash, password.trim()), false);
});

test("case-insensitive account collision cannot overwrite an existing user or leave a profile", async () => {
  const f = svcAccountsSqlFixture();
  f.tables().lxm_auth_users.push({ id: "existing", account: "NEW-SERVICE-QA", password_hash: "untouched", role_id: "other-role", status: "active" });
  const before = structuredClone(f.tables()); await assert.rejects(create(f)); assert.deepEqual(f.tables(), before);
});

test("duplicate phone and competing account creations cannot leave extra credentials or profiles", async () => {
  const f = svcAccountsSqlFixture(); await create(f);
  const before = structuredClone(f.tables());
  await assert.rejects(create(f, { account: "another-service" })); assert.deepEqual(f.tables(), before);
  const concurrent = svcAccountsSqlFixture();
  const attempts = await Promise.allSettled([create(concurrent), create(concurrent, { phone: "13900139021" })]);
  assert.equal(attempts.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(row => row.status === "rejected").length, 1);
  assert.equal(concurrent.tables().lxm_auth_users.length, 1); assert.equal(concurrent.tables().svc_staff.length, 1);
  assert.equal(concurrent.tables().svc_staff_profile_log.length, 1); assert.equal(concurrent.tables().benefit_rule.length, 2);
});

test("new-account and legacy-link instructions cannot be mixed or silently discard a supplied password", async () => {
  for (const patch of [{ account_id: "existing-user" }, { create_account: false }]) {
    const f = svcAccountsSqlFixture(), before = structuredClone(f.tables());
    await assert.rejects(create(f, patch)); assert.deepEqual(f.tables(), before);
  }
});

test("disabled or ambiguous service roles and disabled menus cannot be re-enabled by onboarding", async () => {
  for (const condition of ["disabled-role", "duplicate-role", "disabled-menu"]) {
    const f = svcAccountsSqlFixture();
    if (condition === "disabled-role") f.tables().lxm_auth_roles.push({ id: "service-old", role_key: "service", status: "disabled" });
    if (condition === "duplicate-role") f.tables().lxm_auth_roles.push({ id: "service-a", role_key: "service", status: "active" }, { id: "service-b", role_key: "service", status: "active" });
    if (condition === "disabled-menu") f.tables().lxm_auth_menus.push({ id: "disabled-mine", menu_key: "svcMine", status: "disabled" });
    const before = structuredClone(f.tables()); await assert.rejects(create(f)); assert.deepEqual(f.tables(), before);
  }
});

test("existing active service role and its grants survive onboarding", async () => {
  const f = svcAccountsSqlFixture();
  f.tables().lxm_auth_roles.push({ id: "existing-service", role_key: "service", name: "客服专员", status: "active", description: "管理员维护" });
  f.tables().lxm_auth_role_menus.push({ role_id: "existing-service", menu_key: "orders" });
  const roleBefore = structuredClone(f.tables().lxm_auth_roles[0]);
  const grantsBefore = structuredClone(f.tables().lxm_auth_role_menus);
  const result = await create(f), user = f.tables().lxm_auth_users.find(row => row.id === result.account_id);
  assert.equal(user.role_id, "existing-service"); assert.deepEqual(f.tables().lxm_auth_roles, [roleBefore]);
  assert.deepEqual(f.tables().lxm_auth_role_menus, grantsBefore, "onboarding must not restore menus removed from an existing role");
});

test("an existing service role with all menu grants removed remains ungranted", async () => {
  const f = svcAccountsSqlFixture();
  f.tables().lxm_auth_roles.push({ id: "restricted-service", role_key: "service", name: "待授权客服", status: "active" });
  const result = await create(f), user = f.tables().lxm_auth_users.find(row => row.id === result.account_id);
  assert.equal(user.role_id, "restricted-service"); assert.deepEqual(f.tables().lxm_auth_role_menus, []);
});

test("account insert and later profile or audit failure roll back all onboarding records", async () => {
  for (const statement of ["INSERT INTO lxm_auth_users", "INSERT INTO `svc_staff`", "INSERT INTO `svc_staff_profile_log`", "INSERT INTO `benefit_rule`"]) {
    const f = svcAccountsSqlFixture(), before = structuredClone(f.tables()); f.fail(statement);
    await assert.rejects(create(f), { code: "QA_SQL_FAILURE" }); assert.deepEqual(f.tables(), before);
    f.fail(null); const result = await create(f); assert.ok(result.account_id); assert.equal(f.tables().lxm_auth_users.length, 1);
  }
});

test("new account provisioning rejects non-super callers and a store without its SQL transaction", async () => {
  for (const session of [ { kind: "admin", role: "service" }, { kind: "admin", role: "finance" }, { kind: "admin", role: "service_supervisor" }, { kind: "public", role: "super" } ]) {
    const f = svcAccountsSqlFixture(), before = structuredClone(f.tables()); await assert.rejects(create(f, {}, session)); assert.deepEqual(f.tables(), before);
    assert.equal(f.tables().lxm_auth_users.length, 0);
  }
  const f = svcAccountsSqlFixture(), store = createSvcMemoryStore({ rules: f.tables().benefit_rule });
  const service = createSvcCommission({ store, clock: () => "2026-11-13 12:00:00" }), before = store.snapshot();
  await assert.rejects(service.execute("POST", "/staff", input, root)); assert.deepEqual(store.snapshot(), before);
});

test("legacy service account association continues without creating or rewriting credentials", async () => {
  const f = svcAccountsSqlFixture();
  f.tables().lxm_auth_users.push({ id: "legacy-user", account: "existing-service", status: "active", password_hash: "untouched" });
  const before = structuredClone(f.tables().lxm_auth_users);
  const result = await create(f, { create_account: false, account: "existing-service", password: undefined });
  assert.equal(result.account_id, "legacy-user"); assert.deepEqual(f.tables().lxm_auth_users, before);
});

test("a directly created service login authenticates over HTTP and resolves only its own profile", async t => {
  const f = svcAccountsSqlFixture();
  f.tables().lxm_auth_roles.push({ id: "qa-super-role", role_key: "super", name: "测试管理员", status: "active" });
  f.tables().lxm_auth_users.push({ id: "qa-root", account: "admin", display_name: "测试管理员", password_hash: hashPassword("AdminQA2026!"), role_id: "qa-super-role", status: "active", subject_type: "staff", subject_id: "qa-root" });
  const userView = row => row && ({ id: row.id, account: row.account, name: row.display_name, roleId: row.role_id, status: row.status, phone: row.phone, extra: { subjectType: row.subject_type, subjectId: row.subject_id } });
  const permissionStore = {
    backend: "mysql", required: true, async init() {},
    async authenticate(account, password) { const row = f.tables().lxm_auth_users.find(row => row.account.toLowerCase() === account.toLowerCase()); return row && verifyPassword(row.password_hash, password) ? userView(row) : null; },
    async getUser(id) { return userView(f.tables().lxm_auth_users.find(row => row.id === id)); },
    async getPolicyForUser(user) { const role = f.tables().lxm_auth_roles.find(row => row.id === user.roleId); return { role: role && { ...role, roleKey: role.role_key }, menuKeys: f.tables().lxm_auth_role_menus.filter(row => row.role_id === role?.id).map(row => row.menu_key), rolePermissions: [] }; },
    async listMenus() { return f.tables().lxm_auth_menus.map(row => ({ id: row.id, menuKey: row.menu_key, name: row.name, status: row.status, path: row.path, meta: { group: row.meta_group, type: "page" } })); },
    async getRolePermissions() { return []; }
  };
  const capturedLogs = [], logger = Object.fromEntries(["info", "warn", "error"].map(level => [level, (...args) => capturedLogs.push(args)]));
  const auth = require("../lib/auth.cjs").createAuthStore({ sessionStore: "memory" });
  const api = require("../lib/api.cjs")(f.source, "mysql", { permissionStore, auth, customerService: f, logger });
  const server = http.createServer((req, res) => Promise.resolve(api(req, res, req.url.split("?")[0])).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ code: error.code || "QA_FAILURE" })); }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await auth.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminLogin = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "admin", password: "AdminQA2026!" }) });
  assert.equal(adminLogin.status, 200); const adminSession = await adminLogin.json();
  const onboarding = await fetch(base + "/api/svc/staff", { method: "POST", headers: { Authorization: "Bearer " + adminSession.token, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(onboarding.status, 200); const saved = await onboarding.json(); assert.equal(saved.code, 0); noSecret(saved); const created = saved.data;
  const login = async password => fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: created.account, password }) });
  const response = await login(input.password); assert.equal(response.status, 200); const session = await response.json();
  assert.equal(session.role, "service"); assert.equal(session.staffId, created.id); assert.deepEqual(session.menuKeys.slice().sort(), expectedMenus.slice().sort()); noSecret(session);
  f.tables().svc_staff.push({ id: "other-staff", name: "其他客服", account_id: "other-account", staff_status: "active", base_salary: 9999 });
  const headers = { Authorization: "Bearer " + session.token };
  const me = await fetch(base + "/api/svc/me?staff=other-staff&staff_id=other-staff", { headers });
  assert.equal(me.status, 200); const mine = await me.json(); assert.equal(mine.code, 0); assert.equal(mine.data.staff.id, created.id); assert.equal(mine.data.kpi.base_salary_fen, 350000); noSecret(mine);
  for (const route of ["/api/svc/rule", "/api/svc/staff"]) assert.equal((await fetch(base + route, { headers })).status, 403, route);
  const denied = await fetch(base + "/api/svc/staff", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ ...input, phone: "13900139022", account: "forged-creator" }) });
  assert.equal(denied.status, 403); assert.equal(f.tables().lxm_auth_users.filter(row => row.account === "forged-creator").length, 0);
  const bad = await login("incorrect-password"); assert.equal(bad.status, 401);
  noSecret(capturedLogs);
});
