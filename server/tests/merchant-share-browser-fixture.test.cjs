"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startBrowserFixture } = require("./fixtures/merchant-share-browser.cjs");

test("browser QA fixture exercises real HTTP auth, onboard service and merchant isolation using only synthetic persistence", async t => {
  const fixture = await startBrowserFixture();
  t.after(() => fixture.close());
  async function call(path, token, body, headers = {}) {
    const response = await fetch(fixture.url + path, { method: body ? "POST" : "GET", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const admin = await call("/api/auth/login", null, fixture.accounts.admin);
  assert.equal(admin.status, 200);
  const token = admin.body.token;
  const me = await call("/api/auth/me", token);
  const session = me.body.data || me.body;
  const menus = session.menuKeys || session.menus;
  for (const key of ["shareRules", "shareDetails", "shareMine"]) assert.ok(menus.includes(key));
  assert.equal(menus.includes("shops"), false);
  for (const [group,clientKey,mineKey,listLabel,clientLabel] of [['客服分成管理','svcClient','svcMine','客服列表','客服端'],['摄影师分成管理','photoClient','photoMine','摄影师列表','摄影端']]) {
    assert.ok(menus.includes(mineKey),`${group} exposes its personal leaf to the administrator`);
    assert.equal(menus.includes(clientKey),false,'the retired display folder does not return as another route');
    const definitions=session.menuDefinitions.filter(menu=>menu.group===group);
    assert.deepEqual(definitions.map(menu=>menu.label),['分成配置','分成明细',listLabel,'结算管理',clientLabel]);
    assert.equal(definitions.find(menu=>menu.key===mineKey).parentKey,null);
    assert.equal(definitions.find(menu=>menu.key===mineKey).containerOnly,false);
    assert.equal(definitions.some(menu=>menu.key===clientKey),false);
  }
  for (const key of ['svcStaffNew','photoNew']) {
    assert.equal(menus.includes(key),false);
    assert.equal(session.menuDefinitions.some(menu=>menu.key===key),false);
  }
  const input = { name: "QA_HTTP_新门店", account: "qa-http-new", password: "QaHttpTest123!", ratioT1: 0.05, ratioT2: 0.03, ttlHours: 720, refundWindowDays: 3, cooperationConfirmed: true, reason: "QA HTTP contract initial version" };
  const headers = { "Idempotency-Key": "qa-http-new-merchant" };
  const invalid = await call("/api/share/merchants", token, { ...input, reason: "" }, headers);
  assert.equal(invalid.status, 400);
  assert.equal((await fixture.store.listMerchants()).length, 2);
  const created = await call("/api/share/merchants", token, input, headers);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.data.merchantId;
  assert.equal((await call("/api/share/merchants", token, input, headers)).body.data.merchantId, id);
  const changedRequest = await call("/api/share/merchants", token, { ...input, phone: "13800000001" }, headers);
  assert.equal(changedRequest.status, 409, "one onboarding request cannot silently replace the original merchant details");
  assert.equal((await fixture.store.getMerchant(id)).phone || "", "");
  assert.equal((await fixture.store.getRules(id)).length, 1);
  assert.equal((await fixture.store.getRules(id))[0].refundWindowDays, 3);
  const merchant = await call("/api/auth/login", null, { account: input.account, password: input.password });
  assert.equal(merchant.status, 200);
  const mine = await call("/api/share/mine?merchantId=qa-m1", merchant.body.token);
  assert.equal(mine.body.data.merchant.merchantId, id, "caller merchant ID cannot override the verified session");
  assert.equal((await call("/api/share/rules", merchant.body.token)).status, 403);
  assert.equal((await call("/api/collection/shops", merchant.body.token)).status, 403);
  const seeded = await call("/api/auth/login", null, fixture.accounts.merchant);
  const owned = await call("/api/share/mine?merchantId=qa-m2", seeded.body.token);
  assert.equal(owned.body.data.merchant.merchantId, "qa-m1");
  assert.equal(owned.body.data.list.length, 3);
  const serialized = JSON.stringify(owned.body.data);
  for (const privateValue of ["QA_PRIVATE_CUSTOMER", "QA_PRIVATE_OPENID", "QA-PRIVATE-ORDER-1001", "13900000000", "QA测试旅拍套餐"]) assert.equal(serialized.includes(privateValue), false);
});

test("a disabled merchant role rejects onboarding without creating a merchant or account", async t => {
  const fixture = await startBrowserFixture({ merchantRoleStatus: "disabled" });
  t.after(() => fixture.close());
  const login = await fetch(fixture.url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixture.accounts.admin) });
  const session = await login.json();
  assert.equal(login.status, 200);
  const response = await fetch(fixture.url + "/api/share/merchants", { method: "POST", headers: {
    Authorization: `Bearer ${session.token}`, "Content-Type": "application/json", "Idempotency-Key": "qa-disabled-role-onboard",
  }, body: JSON.stringify({ name: "QA_DISABLED_ROLE_NEW", account: "qa-disabled-role-new", password: "QaDisabled123!", ratioT1: 0.05, ratioT2: 0.03, ttlHours: 720, refundWindowDays: 3, cooperationConfirmed: true, reason: "Synthetic disabled role rejection" }) });
  assert.equal(response.status, 403);
  assert.match((await response.json()).msg, /角色已停用/);
  assert.equal((await fixture.store.listMerchants()).length, 2);
  assert.equal((await fixture.source.list("shops")).length, 2, "a rejected role must not leave a login account projection");
});
