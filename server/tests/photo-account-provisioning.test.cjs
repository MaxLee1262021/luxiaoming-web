"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { photoAccountsSqlFixture } = require("./fixtures/photoAccountsSql.cjs");
const { verifyPassword, hashPassword } = require("../lib/mysqlPermissionStore.cjs");
const { DEFAULT_RATES, createPhotoShareService } = require("../lib/photoShare.cjs");
const { validatePhotoCredentials } = require("../lib/photoAccounts.cjs");
const admin = { kind: "admin", role: "super", account: "qa-admin" };
const input = { name: "测试摄影师", phone: "13812345678", agree_no: "QA-PH-ONLY", account: "photo.qa-user", password: "  ChosenPhoto123!  ", ...DEFAULT_RATES, reason: "TEST_ONLY首签" };

function existingPhotoAccount(f, patch = {}) {
  f.tables().lxm_auth_roles.push({ id: "existing-photo-role", role_key: "photo", status: "active" });
  f.tables().lxm_auth_menus.push({ id: "existing-photo-mine", menu_key: "photoMine", status: "active" });
  f.tables().lxm_auth_role_menus.push({ role_id: "existing-photo-role", menu_key: "photoMine" });
  const user = { id: "existing-photo-user", account: "Existing.Photo", display_name: "原账号名称", role_id: "existing-photo-role", status: "active", phone: input.phone, password_hash: hashPassword("ExistingPhoto123!"), subject_type: null, subject_id: null, ...patch };
  f.tables().lxm_auth_users.push(user);
  return user;
}
const linkInput = patch => ({ ...input, create_account: false, account: " existing.photo ", password: undefined, ...patch });

test("existing photographer login links a new PH identity using its stored account name and password without rewriting account settings", async () => {
  const f = photoAccountsSqlFixture(), user = existingPhotoAccount(f), before = structuredClone(f.tables());
  const result = await f.service.createParty(linkInput(), admin), after = f.tables();
  assert.equal(result.account_created, false); assert.equal(result.account_linked, true);
  assert.equal(result.account, user.account); assert.equal(result.account_id, user.id);
  assert.equal(after.lxm_auth_users.length, 1); assert.equal(after.photo_profile.length, 1); assert.equal(after.photo_profile_log.length, 1); assert.equal(after.benefit_rule.length, 2);
  assert.deepEqual(after.lxm_auth_users[0], { ...before.lxm_auth_users[0], subject_type: "photo", subject_id: result.id });
  for (const table of ["lxm_auth_roles", "lxm_auth_menus", "lxm_auth_role_menus"]) assert.deepEqual(after[table], before[table]);
  assert.equal(verifyPassword(after.lxm_auth_users[0].password_hash, "ExistingPhoto123!"), true);
  assert.equal(Object.hasOwn(result, "legacy_staff_id"), false);
  const self = { kind: "admin", role: "photo", subjectId: result.id };
  assert.equal((await f.service.mine({}, self)).photo.id, result.id);
  assert.equal(JSON.stringify([result, after.photo_profile, after.photo_profile_log]).includes("password"), false);
});

test("legacy photographer staff identities can link while preserving legacy rows and permitting their own phone", async () => {
  const f = photoAccountsSqlFixture(), user = existingPhotoAccount(f, { subject_type: "staff", subject_id: "legacy-photo", legacy_key: "staff", legacy_id: "legacy-photo" });
  f.tables().lxm_staff.push({ id: "legacy-photo", account: user.account.toLowerCase(), role: "photographer", status: "正常", phone: input.phone });
  const before = structuredClone(f.tables());
  const result = await f.service.createParty(linkInput(), admin);
  assert.deepEqual(f.tables().lxm_staff, before.lxm_staff);
  assert.deepEqual(f.tables().lxm_auth_users[0], { ...before.lxm_auth_users[0], subject_type: "photo", subject_id: result.id });
  assert.equal(result.account_created, false);
});

test("auth-only staff placeholder identities can link to their PH profile", async () => {
  const f = photoAccountsSqlFixture(); existingPhotoAccount(f, { subject_type: "staff", subject_id: "existing-photo-user", legacy_key: "staff" });
  const result = await f.service.createParty(linkInput(), admin);
  assert.equal(f.tables().lxm_auth_users[0].subject_id, result.id);
});

test("legacy photographer identities resolve a missing subject ID from legacy metadata or their auth ID", async () => {
  for (const legacyId of ["legacy-photo", "existing-photo-user"]) {
    const f = photoAccountsSqlFixture(); existingPhotoAccount(f, legacyId === "legacy-photo" ? { legacy_key: "staff", legacy_id: legacyId } : {});
    f.tables().lxm_staff.push({ id: legacyId, account: "Existing.Photo", role: "photo", status: "active", phone: input.phone });
    const result = await f.service.createParty(linkInput(), admin), user = f.tables().lxm_auth_users[0];
    assert.equal(user.subject_id, result.id); assert.equal(user.legacy_key, "staff"); assert.equal(user.legacy_id, legacyId);
  }
});

test("existing account association rejects invalid names, passwords, modes, missing or disabled accounts, wrong roles and conflicting identities atomically", async () => {
  const cases = [
    f => ({ account: "missing" }),
    f => { existingPhotoAccount(f, { status: "disabled" }); },
    f => { existingPhotoAccount(f); f.tables().lxm_auth_roles[0].status = "disabled"; },
    f => { existingPhotoAccount(f); f.tables().lxm_auth_roles[0].role_key = "service"; },
    f => { existingPhotoAccount(f); f.tables().lxm_auth_roles.length = 0; },
    f => { existingPhotoAccount(f, { subject_type: "photo", subject_id: "PH20269999" }); },
    f => { existingPhotoAccount(f, { subject_type: "merchant", subject_id: "shop1" }); },
    f => { existingPhotoAccount(f, { subject_type: "staff", subject_id: "legacy-service" }); f.tables().lxm_staff.push({ id: "legacy-service", account: "Existing.Photo", role: "service" }); },
    f => { existingPhotoAccount(f, { subject_type: "staff", subject_id: "missing-staff" }); },
    f => { existingPhotoAccount(f, { subject_type: "staff", subject_id: "legacy-photo", legacy_key: "staff", legacy_id: "other-staff" }); f.tables().lxm_staff.push({ id: "legacy-photo", account: "Existing.Photo", role: "photo" }); },
    f => { existingPhotoAccount(f); f.tables().svc_staff.push({ id: "svc-existing", account_id: "existing-photo-user" }); },
    f => { existingPhotoAccount(f); return { account_id: "wrong-user" }; },
    f => { existingPhotoAccount(f); return { password: "UnexpectedPassword123" }; },
    f => ({ account: "admin" }), f => ({ account: "" }), f => ({ create_account: "false" }),
  ];
  for (const setup of cases) {
    const f = photoAccountsSqlFixture(), patch = setup(f), before = structuredClone(f.tables());
    await assert.rejects(f.service.createParty(linkInput(patch), admin), error => error.code === 4315 && !!error.data.field);
    assert.deepEqual(f.tables(), before);
  }
});

test("association exempts only the selected account and matching legacy photographer from phone uniqueness", async () => {
  for (const table of ["lxm_auth_users", "lxm_staff", "lxm_agents", "lxm_shops", "svc_staff"]) {
    const f = photoAccountsSqlFixture(); existingPhotoAccount(f);
    f.tables()[table].push({ id: "unrelated", account: "unrelated-photo", phone: input.phone });
    const before = structuredClone(f.tables());
    await assert.rejects(f.service.createParty(linkInput(), admin), { code: 4301 });
    assert.deepEqual(f.tables(), before);
  }
});

test("association and profile/rule/log roll back together on SQL failure and can retry", async () => {
  for (const failure of ["UPDATE lxm_auth_users", "INSERT INTO photo_profile", "INSERT INTO photo_profile_log"]) {
    const f = photoAccountsSqlFixture(); existingPhotoAccount(f); const before = structuredClone(f.tables()); f.fail(failure);
    await assert.rejects(f.service.createParty(linkInput(), admin), { code: "QA_SQL_FAILURE" }); assert.deepEqual(f.tables(), before);
    f.fail(null); const result = await f.service.createParty(linkInput(), admin); assert.equal(result.id, "PH20260001"); assert.equal(f.tables().lxm_auth_users.length, 1);
  }
});

test("concurrent association of one existing account creates exactly one photographer and preserves the winning binding", async () => {
  const f = photoAccountsSqlFixture(); existingPhotoAccount(f);
  const results = await Promise.allSettled([f.service.createParty(linkInput(), admin), f.service.createParty(linkInput({ phone: "13912345678" }), admin)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(results.find(row => row.status === "rejected").reason.code, 4315);
  assert.equal(f.tables().photo_profile.length, 1); assert.equal(f.tables().photo_profile_log.length, 1); assert.equal(f.tables().benefit_rule.length, 2);
  assert.equal(f.tables().lxm_auth_users[0].subject_id, f.tables().photo_profile[0].id);
});

test("a linked legacy photographer retains PH identity through actual legacy staff edits and disabling while keeping its original password", async t => {
  const f = photoAccountsSqlFixture(), user = existingPhotoAccount(f, { subject_type: "staff", subject_id: "legacy-photo", legacy_key: "staff", legacy_id: "legacy-photo" });
  f.tables().lxm_staff.push({ id: "legacy-photo", account: user.account, role: "photo", status: "active", phone: input.phone });
  const result = await f.service.createParty(linkInput(), admin);
  const userDocument = row => row && ({ id: row.id, account: row.account, name: row.display_name, roleId: row.role_id, status: row.status, phone: row.phone, extra: { subjectType: row.subject_type, subjectId: row.subject_id, legacyKey: row.legacy_key, legacyId: row.legacy_id } });
  const permissionStore = require("../lib/permissionStore.cjs").decorateStore({
    backend: "mysql", required: true, async init() {},
    async authenticate(account, password) { const row = f.tables().lxm_auth_users.find(row => row.account.toLowerCase() === account.toLowerCase()); return row && verifyPassword(row.password_hash, password) ? userDocument(row) : null; },
    async getUser(id) { return userDocument(f.tables().lxm_auth_users.find(row => row.id === id)); },
    async listUsers() { return f.tables().lxm_auth_users.map(userDocument); },
    async updateUser(id, payload) {
      const row = f.tables().lxm_auth_users.find(row => row.id === id);
      assert.ok(row); Object.assign(row, { account: payload.account, display_name: payload.name, role_id: payload.roleId, status: payload.status, phone: payload.phone,
        subject_type: payload.extra.subjectType, subject_id: payload.extra.subjectId, legacy_key: payload.extra.legacyKey, legacy_id: payload.extra.legacyId });
      if (payload.password) row.password_hash = hashPassword(payload.password);
      return userDocument(row);
    },
    async createUser() { assert.fail("legacy edit must reuse the linked auth user"); },
    async getRole(id) { const row = f.tables().lxm_auth_roles.find(row => row.id === id); return row && { ...row, roleKey: row.role_key }; },
    async listRoles() { return f.tables().lxm_auth_roles.map(row => ({ ...row, roleKey: row.role_key })); },
    async getRoleMenus(id) { return { menuKeys: f.tables().lxm_auth_role_menus.filter(row => row.role_id === id).map(row => row.menu_key) }; },
    async getRolePermissions() { return { permissionKeys: [] }; },
    async listMenus() { return f.tables().lxm_auth_menus.map(row => ({ ...row, menuKey: row.menu_key })); },
  }, "mysql");
  f.tables().lxm_auth_roles.push({ id: "super-role", role_key: "super", status: "active" });
  f.tables().lxm_auth_users.push({ id: "qa-super", account: "admin", role_id: "super-role", status: "active", password_hash: hashPassword("AdminTest123!") });
  f.source.list = async key => key === "staff" ? structuredClone(f.tables().lxm_staff) : [];
  f.source.get = async (key, id) => key === "staff" ? structuredClone(f.tables().lxm_staff.find(row => row.id === id) || null) : null;
  f.source.update = async (key, id, patch) => { assert.equal(key, "staff"); const row = f.tables().lxm_staff.find(row => row.id === id); return row && structuredClone(Object.assign(row, patch)); };
  f.source.create = async (key, row) => { assert.equal(key, "logs"); return { ...row, id: "audit-only" }; };
  const auth = require("../lib/auth.cjs").createAuthStore({ sessionStore: "memory" });
  const api = require("../lib/api.cjs")(f.source, "mysql", { permissionStore, auth, photoService: f.service, logger: { info() {}, warn() {}, error() {} } });
  const server = http.createServer((req, res) => Promise.resolve(api(req, res, req.url.split("?")[0])).catch(() => { res.statusCode = 500; res.end("{}"); }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await auth.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "existing.photo", password: "ExistingPhoto123!" }) });
  assert.equal(response.status, 200); const login = await response.json();
  assert.equal(login.role, "photo"); assert.equal(login.staffId, result.id); assert.deepEqual(login.menuKeys, ["photoMine"]);
  const headers = { Authorization: "Bearer " + login.token };
  const mine = await fetch(base + "/api/photo/me?photo=PH20999999", { headers });
  assert.equal(mine.status, 200); assert.equal((await mine.json()).data.photo.id, result.id);
  assert.equal((await fetch(base + "/api/photo/party", { headers })).status, 403);
  assert.equal((await fetch(base + "/api/collection/orders", { headers })).status, 403);
  const rootResponse = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "admin", password: "AdminTest123!" }) });
  assert.equal(rootResponse.status, 200); const rootLogin = await rootResponse.json();
  const edit = patch => fetch(base + "/api/collection/staff/legacy-photo", { method: "PUT", headers: { Authorization: "Bearer " + rootLogin.token, "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const changed = await edit({ name: "修改后的姓名" }); assert.equal(changed.status, 200, await changed.text());
  assert.equal(f.tables().lxm_auth_users.find(row => row.id === user.id).subject_id, result.id);
  assert.equal((await fetch(base + "/api/photo/me", { headers })).status, 200);
  assert.equal((await edit({ status: "disabled" })).status, 200);
  assert.equal((await fetch(base + "/api/photo/me", { headers })).status, 401);
  const relogin = () => fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: user.account, password: "ExistingPhoto123!" }) });
  assert.equal((await relogin()).status, 403, "disabled legacy user stays disabled");
  assert.equal((await edit({ status: "active", role: "photographer" })).status, 200);
  const active = await relogin(); assert.equal(active.status, 200); assert.equal((await active.json()).staffId, result.id);
  assert.equal(f.tables().lxm_auth_users.length, 2, "no duplicate auth user is created for a different legacy ID");
});

test("legacy sync preserves a linked PH subject when staff role changes and resolves the stored auth ID", async () => {
  const { decorateStore } = require("../lib/permissionStore.cjs");
  for (const sameId of [true, false]) {
    const id = sameId ? "legacy" : "auth-external";
    let user = { id, roleId: "photo-role", extra: { legacyKey: "staff", legacyId: "legacy", subjectType: "photo", subjectId: "PH20260001" } };
    const store = decorateStore({
      async getUser(userId) { return userId === user.id ? structuredClone(user) : null; },
      async listUsers() { return [structuredClone(user)]; },
      async updateUser(userId, payload) { assert.equal(userId, id); user = structuredClone(payload); return user; },
      async createUser() { assert.fail("must preserve existing user"); },
    }, "mysql");
    const result = await store.syncLegacyAccount("staff", { id: "legacy", account: "renamed.account", role: "service", roleId: "service-role", status: "disabled" });
    assert.equal(result.id, id); assert.equal(result.role, "service"); assert.equal(result.roleId, "service-role"); assert.equal(result.status, "disabled");
    assert.equal(result.extra.subjectType, "photo"); assert.equal(result.extra.subjectId, "PH20260001");
  }
});

test("administrator chosen account and exact password create a bound photographer login atomically without echoing a secret", async () => {
  const f = photoAccountsSqlFixture(), result = await f.service.createParty(input, admin), tables = f.tables();
  assert.equal(result.id, "PH20260001");
  assert.equal(result.account, input.account); assert.notEqual(result.account, result.id);
  assert.equal(result.account_created, true); assert.equal(result.credentials, undefined);
  assert.equal(tables.photo_profile.length, 1); assert.equal(tables.benefit_rule.length, 2); assert.equal(tables.photo_profile_log.length, 1);
  const user = tables.lxm_auth_users[0]; assert.equal(user.account, input.account); assert.equal(user.id, result.account_id); assert.equal(user.subject_type, "photo"); assert.equal(user.subject_id, result.id);
  assert.match(user.password_hash, /^lxm1\$/); assert.equal(verifyPassword(user.password_hash, input.password), true);
  assert.equal(verifyPassword(user.password_hash, input.password.trim()), false, "password whitespace is not normalized");
  assert.equal(tables.lxm_auth_roles.find(r => r.id === user.role_id).role_key, "photo");
  assert.deepEqual(tables.lxm_auth_role_menus, [{ role_id: user.role_id, menu_key: "photoMine" }]);
  const menu = tables.lxm_auth_menus.find(row => row.menu_key === "photoMine");
  assert.equal(menu.name, "摄影端"); assert.equal(menu.meta_group, "摄影师分成管理");
  for (const value of [tables, result]) assert.equal(JSON.stringify(value).includes(input.password), false, "plaintext secret is absent from stored rows, audit and response");
  const party = (await f.service.listParties()).rows[0]; assert.equal(Object.hasOwn(party, "credentials"), false);
  const mine = await f.service.mine({}, { kind: "admin", role: "photo", subjectId: user.subject_id }); assert.equal(mine.photo.id, result.id);
});
test("account insertion failure rolls profile/rule/log/role/menu back and leaves existing legacy accounts untouched", async () => {
  const f = photoAccountsSqlFixture();
  f.tables().lxm_auth_users.push({ id: "old", account: "old-photo", phone: "13912345678", role_id: "old-role", subject_type: "staff", subject_id: "old-staff", password_hash: "existing" });
  const before = structuredClone(f.tables()); f.fail("INSERT INTO lxm_auth_users");
  await assert.rejects(f.service.createParty(input, admin), { code: "QA_SQL_FAILURE" }); assert.deepEqual(f.tables(), before);
  f.fail(null); const result = await f.service.createParty(input, admin); assert.equal(result.id, "PH20260001"); assert.deepEqual(f.tables().lxm_auth_users[0], before.lxm_auth_users[0]);
});
test("log commit failure rolls back the account too and the same administrator input can retry without partial records", async () => {
  const f = photoAccountsSqlFixture(), before = structuredClone(f.tables()); f.fail("INSERT INTO photo_profile_log");
  await assert.rejects(f.service.createParty(input, admin), { code: "QA_SQL_FAILURE" }); assert.deepEqual(f.tables(), before);
  f.fail(null); const result = await f.service.createParty(input, admin); assert.equal(result.id, "PH20260001"); assert.equal(f.tables().lxm_auth_users.length, 1);
});
test("disabled photographer role or self menu cannot be silently re-enabled by onboarding", async () => {
  for (const disabled of ["role", "menu"]) {
    const f = photoAccountsSqlFixture();
    if (disabled === "role") f.tables().lxm_auth_roles.push({ id: "disabled-photo", role_key: "photo", status: "disabled" });
    else f.tables().lxm_auth_menus.push({ id: "disabled-mine", menu_key: "photoMine", status: "disabled" });
    const before = structuredClone(f.tables()); await assert.rejects(f.service.createParty(input, admin), { code: 4315 }); assert.deepEqual(f.tables(), before);
  }
});
test("case-insensitive chosen account collision never overwrites another user or creates orphaned profile", async () => {
  const f = photoAccountsSqlFixture();
  f.tables().lxm_auth_users.push({ id: "conflict", account: input.account.toUpperCase(), role_id: "custom-role", subject_type: "staff", subject_id: "old", password_hash: "existing" });
  const before = structuredClone(f.tables()); await assert.rejects(f.service.createParty({ ...input, account: " " + input.account + " " }, admin), error=>error.code===4315 && error.data.field==="account"); assert.deepEqual(f.tables(), before);
});

test("manual credentials are required and rejected before any database read or mutation", async () => {
  for (const [patch, field] of [[{account:""},"account"],[{account:" ADMIN "},"account"],[{account:"a".repeat(129)},"account"],[{account:"line\nbreak"},"account"],[{password:""},"password"],[{password:"abc1"},"password"],[{password:"12345678"},"password"],[{password:"NoDigitsHere"},"password"],[{password:"Aa1".repeat(44)},"password"]]) {
    const f=photoAccountsSqlFixture(), before=structuredClone(f.tables());
    await assert.rejects(f.service.createParty({...input,...patch},admin),error=>error.code===4315 && error.data.field===field);
    assert.equal(f.statements.length,0);assert.deepEqual(f.tables(),before);
  }
  assert.deepEqual(validatePhotoCredentials({account:" chosen.account ",password:input.password}),{account:"chosen.account",password:input.password});
  assert.equal(validatePhotoCredentials({account:"x",password:"Test1234"}).account,"x");
  assert.equal(validatePhotoCredentials({account:"a".repeat(128),password:"A1".repeat(64)}).password.length,128);
});

test("simultaneous chosen account creation commits only one profile and preserves the binding of the winner",async()=>{
  const f=photoAccountsSqlFixture();
  const results=await Promise.allSettled([f.service.createParty(input,admin),f.service.createParty({...input,name:"另一个摄影师",phone:"13912345678"},admin)]);
  assert.equal(results.filter(row=>row.status==="fulfilled").length,1);
  assert.equal(results.find(row=>row.status==="rejected").reason.code,4315);
  assert.equal(f.tables().photo_profile.length,1);assert.equal(f.tables().lxm_auth_users.length,1);
  assert.equal(f.tables().benefit_rule.length,2);assert.equal(f.tables().photo_profile_log.length,1);
  assert.equal(f.tables().lxm_auth_users[0].subject_id,f.tables().photo_profile[0].id);
});
test("finance, service, custom grants and public impersonation cannot provision photographer credentials", async () => {
  const f = photoAccountsSqlFixture();
  for (const role of ["finance", "service", "photo", "custom"]) await assert.rejects(f.service.createParty(input, { kind: "admin", role, photoPermissions: ["photo:manage"], menuKeys: ["photoNew"] }), { code: 403, status: 403 });
  await assert.rejects(f.service.createParty(input, { kind: "public", role: "super" }), { code: 403 });
  assert.equal(f.statements.length, 0);
});
test("production creation fails closed if a store cannot provide the provisioning transaction", async () => {
  const service = createPhotoShareService({ store: { withState(work) { return work({ profiles: [], rules: [{ id: "1", ver: 1, beneficiary_type: "photo", party_id: null, rule_mode: "global", ...DEFAULT_RATES, eff_at: "2020-01-01 00:00:00" }], logs: [], phones: [] }); } } });
  await assert.rejects(service.createParty(input, admin), { code: 4399, status: 503 });
});

test("manual account login and administrator password reset preserve PH binding without creating generic staff", async t => {
  // Merchant-style account names may contain Unicode and internal spaces.
  // Existing-account maintenance must retain that accepted login identifier.
  const f = photoAccountsSqlFixture(), created = await f.service.createParty({ ...input, account: "photo 管理 1" }, admin);
  const document = row => row && ({ id: row.id, account: row.account, name: row.display_name, roleId: row.role_id, status: row.status, phone: row.phone, extra: { subjectType: row.subject_type, subjectId: row.subject_id } });
  const permissionStore = {
    backend: "mysql", required: true, async init() {},
    async authenticate(account, password) { const row = f.tables().lxm_auth_users.find(row => row.account.toLowerCase() === account.toLowerCase()); return row && verifyPassword(row.password_hash, password) ? document(row) : null; },
    async getUser(id) { return document(f.tables().lxm_auth_users.find(row => row.id === id)); },
    async getPolicyForUser(user) { const role = f.tables().lxm_auth_roles.find(row => row.id === user.roleId); return { role: { ...role, roleKey: role.role_key }, menuKeys: [...f.tables().lxm_auth_role_menus.filter(row => row.role_id === role.id).map(row => row.menu_key), "photoRules", "orders"] }; },
    async listMenus() { return f.tables().lxm_auth_menus.map(row => ({ ...row, menuKey: row.menu_key, meta: { group: row.meta_group } })); },
    async listRoles() { return f.tables().lxm_auth_roles.map(row => ({ ...row, roleKey: row.role_key })); },
    async listUsers() { return f.tables().lxm_auth_users.map(document); },
    async getUserState(id) { const row = f.tables().lxm_auth_users.find(row => row.id === id); return row && { ...document(row), passwordHash: row.password_hash }; },
    async updateUser(id, payload) {
      const row = f.tables().lxm_auth_users.find(row => row.id === id); if (!row) return null;
      Object.assign(row, { account: payload.account, display_name: payload.name, role_id: payload.roleId, status: payload.status, phone: payload.phone,
        subject_type: payload.extra.subjectType, subject_id: payload.extra.subjectId });
      if (payload.password) row.password_hash = hashPassword(payload.password);
      return document(row);
    }
  };
  const auth = require("../lib/auth.cjs").createAuthStore({ sessionStore: "memory" });
  const api = require("../lib/api.cjs")(f.source, "mysql", { permissionStore, auth, photoService: f.service, logger: { info() {}, warn() {}, error() {} } });
  const server = http.createServer((req,res) => Promise.resolve(api(req,res,req.url.split("?")[0])).catch(() => {res.statusCode=500;res.end("{}");}));
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await auth.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account:created.account,password:input.password})});
  assert.equal(loginResponse.status,200); const login = await loginResponse.json(); assert.equal(login.role,"photo"); assert.equal(login.staffId,created.id); assert.deepEqual(login.menuKeys,["photoMine"]);
  assert.equal(login.menuDefinitions.find(menu=>menu.key==='photoMine').parentKey,null);
  assert.equal(login.menuDefinitions.find(menu=>menu.key==='photoMine').label,'摄影端');
  assert.equal(login.menuDefinitions.some(menu=>menu.key==='photoClient'),false);
  assert.equal(JSON.stringify(login).includes(input.password),false); assert.equal(JSON.stringify(login).includes("password_hash"),false);
  const headers={Authorization:"Bearer "+login.token};
  const mineResponse=await fetch(base+"/api/photo/me?photo_id=PH20999999",{headers});assert.equal(mineResponse.status,200);assert.equal((await mineResponse.json()).data.photo.id,created.id);
  for(const route of ["/api/photo/party","/api/photo/rule","/api/collection/orders","/api/orders/private/action"]){const response=await fetch(base+route,{headers});assert.equal(response.status,403,route);}
  const bad=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account:created.account,password:"wrong-password"})});assert.equal(bad.status,401);
  const accountId=f.tables().lxm_auth_users.find(row=>row.subject_id===created.id).id;
  f.tables().lxm_auth_roles.push({id:"qa-super-role",role_key:"super",name:"测试管理员",status:"active"});
  f.tables().lxm_auth_users.push({id:"qa-super",account:"admin",display_name:"测试管理员",password_hash:hashPassword("AdminQA123!"),role_id:"qa-super-role",status:"active",subject_type:"staff",subject_id:"qa-super"});
  const writes=[];
  f.source.get=async()=>null;
  f.source.create=async(key,row)=>{writes.push({key,row});return {...row,id:"audit-only"};};
  f.source.update=async(key)=>{writes.push({key});throw Error("unexpected generic business projection");};
  const adminResponse=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account:"admin",password:"AdminQA123!"})});assert.equal(adminResponse.status,200);
  const adminLogin=await adminResponse.json();
  const reset=await fetch(base+"/api/permissions/users/"+accountId,{method:"PUT",headers:{Authorization:"Bearer "+adminLogin.token,"Content-Type":"application/json"},body:JSON.stringify({password:"ResetPhoto2026!"})});
  assert.equal(reset.status,200,JSON.stringify(await reset.clone().json()));
  const updated=f.tables().lxm_auth_users.find(row=>row.id===accountId);
  assert.equal(updated.subject_type,"photo");assert.equal(updated.subject_id,created.id);assert.equal(updated.account,created.account);
  assert.equal(verifyPassword(updated.password_hash,"ResetPhoto2026!"),true);assert.equal(verifyPassword(updated.password_hash,input.password),false);
  assert.ok(writes.every(row=>row.key==="logs"),"password reset writes auth+audit without creating or updating lxm_staff");
  assert.equal(f.tables().lxm_staff.length,0);
  const relogin=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({account:created.account,password:"ResetPhoto2026!"})});assert.equal(relogin.status,200);const renewed=await relogin.json();assert.equal(renewed.staffId,created.id);assert.deepEqual(renewed.menuKeys,["photoMine"]);
});
