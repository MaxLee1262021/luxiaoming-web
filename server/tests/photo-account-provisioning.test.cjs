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
