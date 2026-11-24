"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { createWecomContacts, WecomContactsError } = require("../lib/wecomContacts.cjs");
const env = { WECOM_CONTACT_SYNC_ENABLED: "true", WECOM_CORP_ID: "corp-test", WECOM_CONTACT_SECRET: "SECRET_TEST_ONLY" };
const profile = { staffId: "local-test-staff", name: "测试客服", phone: "13900139020" };
function fixture(handler, options = {}) {
  const calls = [];
  const provider = createWecomContacts({ env, ...options, fetch: async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname.replace("/cgi-bin/", ""), body = init.body && JSON.parse(init.body);
    const call = { url: parsed, path, body, init }; calls.push(call);
    const result = path === "gettoken" ? { access_token: "TOKEN_TEST_ONLY", expires_in: 7200 }
      : path === "department/simplelist" ? { errcode: 0, department_id: [{ id: 2, parentid: 1 }] }
        : await handler(call, calls);
    if (result instanceof Error) throw result;
    if (result && typeof result.json === "function") return result;
    return { ok: true, json: async () => result };
  } });
  return { provider, calls, count: path => calls.filter(call => call.path === path).length };
}
function noLeak(error) {
  const output = JSON.stringify({ ...error, message: error.message, stack: error.stack });
  for (const privateText of ["SECRET_TEST_ONLY", "TOKEN_TEST_ONLY", profile.phone, profile.name, "https://qyapi"]) {
    assert.equal(output.includes(privateText), false, "provider error leaked sensitive context");
  }
  assert.equal(error.userMessage, error.message);
  return true;
}

test("new contacts join configured department and submit a single-member invitation", async () => {
  const f = fixture(() => ({ errcode: 0 }));
  const result = await f.provider.ensureMember(profile);
  assert.equal(result.departmentId, 2); assert.equal(result.invitationStatus, "submitted");
  assert.match(result.userid, /^lxm_cs_[0-9a-f]{32}$/);
  const created = f.calls.find(call => call.path === "user/create");
  assert.deepEqual(created.body, { userid: result.userid, name: profile.name, mobile: profile.phone, department: [2], to_invite: false });
  assert.equal(created.body.enable_invite, undefined);
  assert.deepEqual(f.calls.find(call => call.path === "batch/invite").body, { user: [result.userid] });
  assert.equal(f.count("user/getuserid"), 0); assert.equal(f.count("user/list_id"), 0);
  assert.equal(f.calls[0].url.searchParams.get("corpsecret"), env.WECOM_CONTACT_SECRET);
  assert.ok(f.calls.every(call => call.init.signal instanceof AbortSignal && call.init.redirect === "error"));
});

test("member IDs are stable across retries and independent provider instances", async () => {
  const first = fixture(() => ({ errcode: 0 })), second = fixture(() => ({ errcode: 0 }));
  const a = await first.provider.ensureMember(profile), b = await second.provider.ensureMember({ ...profile, staffId: "after-local-rollback" });
  assert.equal(a.userid, b.userid); assert.equal(a.userid.includes(profile.phone), false);
  assert.equal((await second.provider.ensureMember({ ...profile, phone: "13900139021" })).userid === a.userid, false);
});

test("existing members are resolved by phone and keep memberships from all pages", async () => {
  const f = fixture(call => {
    if (call.path === "user/create") return { errcode: 60104, errmsg: "private" };
    if (call.path === "user/getuserid") return { errcode: 0, userid: "existing.member" };
    if (call.path === "user/list_id") return call.body.cursor
      ? { errcode: 0, dept_user: [{ userid: "existing.member", department: 7 }], next_cursor: "" }
      : { errcode: 0, dept_user: [{ userid: "another", department: 9 }, { userid: "existing.member", department: 1 }], next_cursor: "page-2" };
    return { errcode: 0 };
  });
  const result = await f.provider.ensureMember(profile);
  assert.equal(result.userid, "existing.member");
  assert.deepEqual(f.calls.find(call => call.path === "user/getuserid").body, { mobile: profile.phone });
  assert.deepEqual(f.calls.find(call => call.path === "user/update").body, { userid: "existing.member", department: [1, 7, 2] });
  assert.equal(f.count("user/list_id"), 2);
  assert.equal(f.count("user/get"), 0, "new contact-sync trusted IPs cannot use legacy user/get");
});

test("an existing membership is reused without modifying contact details or department", async () => {
  const f = fixture(call => call.path === "user/create" ? { errcode: 60102 }
    : call.path === "user/getuserid" ? { errcode: 0, userid: "existing" }
      : call.path === "user/list_id" ? { errcode: 0, dept_user: [{ userid: "existing", department: 2 }] }
        : { errcode: 0 });
  assert.equal((await f.provider.ensureMember({ ...profile, userid: "existing" })).userid, "existing");
  assert.equal(f.count("user/update"), 0); assert.equal(f.count("batch/invite"), 1);
});

test("missing or invisible departments cannot trigger implicit department creation", async () => {
  const calls = [];
  const provider = createWecomContacts({ env, fetch: async url => {
    const path = new URL(url).pathname; calls.push(path);
    return { ok: true, json: async () => path.endsWith("/gettoken") ? { access_token: "TOKEN_TEST_ONLY", expires_in: 7200 } : { errcode: 0, department_id: [] } };
  } });
  await assert.rejects(provider.ensureMember(profile), error => error.code === "WECOM_DEPARTMENT_MISSING" && noLeak(error));
  assert.equal(calls.some(path => path.includes("user/create")), false);
});

test("disabled or incomplete configuration never makes a network request", async () => {
  for (const invalidEnv of [{}, { ...env, WECOM_CONTACT_SECRET: "" }, { ...env, WECOM_CUSTOMER_SERVICE_DEPARTMENT_ID: "NaN" }, { ...env, WECOM_CUSTOMER_SERVICE_DEPARTMENT_ID: "-1" }]) {
    const provider = createWecomContacts({ env: invalidEnv, fetch: () => assert.fail("unconfigured contact made request") });
    await assert.rejects(provider.ensureMember(profile), error => error instanceof WecomContactsError && noLeak(error));
  }
  assert.equal(createWecomContacts({ env: {} }).enabled, false);
  assert.equal(createWecomContacts({ env }).enabled, true);
});

test("concurrent requests share their token and expired tokens refresh once", async () => {
  let time = Date.parse("2026-11-19T00:00:00Z");
  const f = fixture(() => ({ errcode: 0 }), { clock: () => time });
  await Promise.all([f.provider.ensureMember(profile), f.provider.ensureMember({ ...profile, phone: "13900139021" })]);
  assert.equal(f.count("gettoken"), 1);
  time += 7200 * 1000;
  await f.provider.ensureMember(profile); assert.equal(f.count("gettoken"), 2);
});

test("an API token rejection refreshes and replays only once", async () => {
  const f = fixture((call, calls) => call.path === "user/create" && calls.filter(x => x.path === "user/create").length === 1 ? { errcode: 42001 } : { errcode: 0 });
  await f.provider.ensureMember(profile); assert.equal(f.count("gettoken"), 2); assert.equal(f.count("user/create"), 2);
  const rejected = fixture(() => ({ errcode: 40014, errmsg: "SECRET_TEST_ONLY TOKEN_TEST_ONLY" }));
  await assert.rejects(rejected.provider.ensureMember(profile), error => error.providerCode === 40014 && noLeak(error));
  assert.equal(rejected.count("gettoken"), 2); assert.equal(rejected.count("user/create"), 2);
});

test("failed invitation retains confirmed member ID but never claims successful invitation", async () => {
  for (const failure of [{ errcode: 0, invaliduser: ["member"] }, { errcode: 60011, errmsg: "SECRET_TEST_ONLY TOKEN_TEST_ONLY" }]) {
    const f = fixture(call => call.path === "batch/invite" ? failure : { errcode: 0 });
    await assert.rejects(f.provider.ensureMember(profile), error => USER_ID(error.userid) && noLeak(error));
  }
});
function USER_ID(value) { return /^lxm_cs_[0-9a-f]{32}$/.test(value); }

test("provider errors discard raw network errors, HTTP bodies and invalid JSON", async () => {
  const failure = () => Error(`SECRET_TEST_ONLY TOKEN_TEST_ONLY ${profile.phone} ${profile.name} https://qyapi`);
  for (const response of [failure(), { ok: false, json: () => assert.fail("read failed HTTP body") }, { ok: true, json: async () => { throw failure(); } }, { errcode: "0" }, null]) {
    const f = fixture(() => response);
    await assert.rejects(f.provider.ensureMember(profile), noLeak);
  }
});

test("unresolvable or partially paginated existing users never overwrite department membership", async () => {
  for (const memberList of [
    { errcode: 0, dept_user: [], next_cursor: "" },
    { errcode: 0, dept_user: [{ userid: "existing", department: 7 }], next_cursor: "repeated" },
    { errcode: 0, dept_user: [{ userid: "existing", department: "invalid" }] },
  ]) {
    const f = fixture(call => call.path === "user/create" ? { errcode: 60104 }
      : call.path === "user/getuserid" ? { errcode: 0, userid: "existing" } : memberList);
    await assert.rejects(f.provider.ensureMember(profile), noLeak);
    assert.equal(f.count("user/update"), 0); assert.equal(f.count("batch/invite"), 0);
  }
});

test("existing member phone resolution rejects a duplicate ID owned by another phone", async () => {
  const f = fixture(call => call.path === "user/create" ? { errcode: 60102 }
    : call.path === "user/getuserid" ? { errcode: 60121, errmsg: profile.phone } : { errcode: 0 });
  await assert.rejects(f.provider.ensureMember(profile), error => error.providerCode === 60121 && noLeak(error));
  assert.equal(f.count("user/update"), 0); assert.equal(f.count("batch/invite"), 0);
});

test("invalid profile input cannot cause any provider writes", async () => {
  for (const patch of [{ name: "" }, { name: "名".repeat(65) }, { phone: "123" }, { userid: "../invalid" }]) {
    const f = fixture(() => assert.fail("invalid contact requested provider"));
    await assert.rejects(f.provider.ensureMember({ ...profile, ...patch }), error => error.code === "WECOM_CONTACT_INVALID");
    assert.equal(f.calls.length, 0);
  }
});

test("concurrent expired-token responses cannot clear an already refreshed token", async () => {
  let tokenCalls = 0, expiredCalls = 0;
  let deliverLateExpiry;
  const lateExpiry = new Promise(resolve => { deliverLateExpiry = resolve; });
  const calls = [];
  const provider = createWecomContacts({ env, fetch: async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname.replace("/cgi-bin/", ""); calls.push(path);
    let result = { errcode: 0 };
    if (path === "gettoken") result = { access_token: "TOKEN_TEST_ONLY" + (++tokenCalls), expires_in: 7200 };
    else if (path === "department/simplelist") result.department_id = [{ id: 2 }];
    else if (path === "user/create" && parsed.searchParams.get("access_token") === "TOKEN_TEST_ONLY1") {
      expiredCalls++;
      if (expiredCalls === 2) await lateExpiry;
      result = { errcode: 42001 };
    } else if (path === "user/create") deliverLateExpiry();
    return { ok: true, json: async () => result };
  } });
  await Promise.all([provider.ensureMember(profile), provider.ensureMember({ ...profile, phone: "13900139021" })]);
  assert.equal(tokenCalls, 2); assert.equal(expiredCalls, 2);
  assert.equal(calls.filter(path => path === "batch/invite").length, 2);
});

test("the request timeout also aborts a response body that stops arriving", async t => {
  const http = require("node:http"), calls = [];
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0]; calls.push(path);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (path.endsWith("/gettoken")) res.end(JSON.stringify({ access_token: "TOKEN_TEST_ONLY", expires_in: 7200 }));
    else if (path.endsWith("/department/simplelist")) res.end(JSON.stringify({ errcode: 0, department_id: [{ id: 2 }] }));
    else res.write('{"errcode":'); // response.json() must remain covered by timeout.
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = createWecomContacts({ env: { ...env, WECOM_CONTACT_TIMEOUT_MS: "1000" }, fetch: (url, init) => {
    const parsed = new URL(url);
    return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}`, init);
  } });
  await assert.rejects(provider.ensureMember(profile), error => error.code === "WECOM_NETWORK_ERROR" && noLeak(error));
  assert.equal(calls.some(path => path.endsWith("/batch/invite")), false);
});

test("the unassigned-department placeholder is replaced when joining customer service", async () => {
  const f = fixture(call => call.path === "user/create" ? { errcode: 60104 }
    : call.path === "user/getuserid" ? { errcode: 0, userid: "existing" }
      : call.path === "user/list_id" ? { errcode: 0, dept_user: [{ userid: "existing", department: 0 }] }
        : { errcode: 0 });
  await f.provider.ensureMember(profile);
  assert.deepEqual(f.calls.find(call => call.path === "user/update").body, { userid: "existing", department: [2] });
});
