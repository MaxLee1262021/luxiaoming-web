"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createSvcGeneralContact, SDK_URL } = require("../lib/svcGeneralContact.cjs");
const customerId = "wm_TEST_EXTERNAL_CUSTOMER";
const baseEnv = {
  WECOM_GENERAL_CONTACT_ENABLED: "true", WECOM_CORP_ID: "ww_test_corp",
  WECOM_GENERAL_CONTACT_AGENT_ID: "1000021", WECOM_GENERAL_CONTACT_SECRET: "PRIVATE_SECRET_ONLY",
  WECOM_GENERAL_CONTACT_ORIGINS: "https://admin.example.test",
};
const input = {
  order: { order_no: "CONTACT-TEST-001", customer_openid: "customer-openid-test", wecom_external_userid: customerId, phone: "13900139021", customer_name: "PRIVATE_CUSTOMER_NAME" },
  staff: { wecom_userid: "test.staff", staff_status: "active" },
  pageUrl: "https://admin.example.test/?b=%E4%B8%AD&a=1#svcGeneralWorkbench",
  userAgent: "Mozilla/5.0 wxwork/4.1.36",
};
function fixture(handler = () => undefined, overrides = {}) {
  const calls = [];
  let currentTime = Date.parse("2026-11-20T02:00:00Z");
  const provider = createSvcGeneralContact({
    env: { ...baseEnv, ...overrides }, clock: () => currentTime, nonce: () => "nonce-test",
    fetch: async (rawUrl, init) => {
      const url = new URL(rawUrl), path = url.pathname.replace("/cgi-bin/", "");
      const call = { url, path, init }; calls.push(call);
      let data = await handler(call, calls);
      if (data === undefined) data = path === "gettoken" ? { access_token: "PRIVATE_ACCESS_TOKEN", expires_in: 7200 }
        : path === "externalcontact/get" ? { errcode: 0, external_contact: { external_userid: customerId, name: input.order.customer_name }, follow_user: [{ userid: "test.staff", remark_mobiles: [input.order.phone] }] }
          : { errcode: 0, ticket: path === "get_jsapi_ticket" ? "PRIVATE_CORP_TICKET" : "PRIVATE_AGENT_TICKET", expires_in: 7200 };
      if (data instanceof Error) throw data;
      if (typeof data?.json === "function") return data;
      return { ok: true, json: async () => data };
    },
  });
  return { provider, calls, count: path => calls.filter(call => call.path === path).length, advance: ms => { currentTime += ms; } };
}
function privateFieldsAbsent(output) {
  const serialized = typeof output === "string" ? output : JSON.stringify(output);
  for (const secret of ["PRIVATE_SECRET_ONLY", "PRIVATE_ACCESS_TOKEN", "PRIVATE_CORP_TICKET", "PRIVATE_AGENT_TICKET", input.order.phone, input.order.customer_name]) assert.equal(serialized.includes(secret), false, "sensitive data leaked");
}
function safeFailure(expected) {
  return failure => {
    assert.equal(failure.code, expected);
    privateFieldsAbsent({ ...failure, message: failure.message, stack: failure.stack });
    return true;
  };
}

test("contact prepares the official external-customer SDK call, signs exact URL and never sends a message", async () => {
  const f = fixture();
  const result = await f.provider.prepare(input);
  assert.equal(result.kind, "wecom_jsapi"); assert.equal(result.status, "ready_to_open");
  assert.equal(result.sdk_url, SDK_URL); assert.equal(result.corp_id, baseEnv.WECOM_CORP_ID); assert.equal(result.agent_id, 1000021);
  assert.deepEqual(result.params, { userIds: [], externalUserIds: [customerId], groupName: "", chatId: "" });
  const timestamp = Date.parse("2026-11-20T02:00:00Z") / 1000;
  const expected = ticket => crypto.createHash("sha1").update(`jsapi_ticket=${ticket}&noncestr=nonce-test&timestamp=${timestamp}&url=https://admin.example.test/?b=%E4%B8%AD&a=1`).digest("hex");
  assert.equal(result.config_signature.signature, expected("PRIVATE_CORP_TICKET"));
  assert.equal(result.agent_signature.signature, expected("PRIVATE_AGENT_TICKET"));
  assert.equal(result.config_signature.timestamp, timestamp);
  assert.equal(f.calls.find(call => call.path === "ticket/get").url.searchParams.get("type"), "agent_config");
  assert.ok(f.calls.every(call => call.init.method === "GET" && call.init.redirect === "error" && call.init.signal instanceof AbortSignal));
  assert.equal(f.calls.some(call => /send|invite|create|launch_code/.test(call.path)), false);
  assert.equal(result.url, undefined); assert.equal(result.phone, undefined); privateFieldsAbsent(result);
});

test("missing configuration, invalid origins and ordinary browsers cannot prepare contact", async () => {
  for (const [overrides, expected] of [
    [{ WECOM_GENERAL_CONTACT_ENABLED: "false" }, "WECOM_GENERAL_DISABLED"],
    [{ WECOM_GENERAL_CONTACT_SECRET: "" }, "WECOM_GENERAL_NOT_CONFIGURED"],
    [{ WECOM_GENERAL_CONTACT_AGENT_ID: "NaN" }, "WECOM_GENERAL_NOT_CONFIGURED"],
    [{ WECOM_GENERAL_CONTACT_ORIGINS: "http://admin.example.test" }, "WECOM_GENERAL_NOT_CONFIGURED"],
    [{ WECOM_GENERAL_CONTACT_ORIGINS: "https://admin.example.test/path" }, "WECOM_GENERAL_NOT_CONFIGURED"],
  ]) {
    const f = fixture(undefined, overrides);
    await assert.rejects(f.provider.prepare(input), safeFailure(expected)); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.provider.prepare({ ...input, userAgent: "Mozilla/5.0 Chrome" }), safeFailure("WECOM_GENERAL_CLIENT_REQUIRED"));
  assert.equal(f.calls.length, 0);
});

test("signature service refuses untrusted or credential-bearing page URLs", async () => {
  for (const pageUrl of ["https://evil.example.test/", "http://admin.example.test/", "https://admin.example.test.evil.test/", "https://user:pass@admin.example.test/", "javascript:alert(1)", "not a url", " https://admin.example.test/", "https://admin.example.test/\tpath"]) {
    const f = fixture();
    await assert.rejects(f.provider.prepare({ ...input, pageUrl }), e => ["WECOM_GENERAL_URL_INVALID", "WECOM_GENERAL_URL_FORBIDDEN"].includes(e.code));
    assert.equal(f.calls.length, 0);
  }
});

test("only trusted order fields or server-side customer openid mappings select the external contact", async () => {
  const f = fixture(undefined, { WECOM_GENERAL_CONTACT_CUSTOMERS_JSON: JSON.stringify({ "customer-openid-test": customerId }) });
  const order = { ...input.order }; delete order.wecom_external_userid;
  assert.deepEqual((await f.provider.prepare({ ...input, order })).params.externalUserIds, [customerId]);
  const unmapped = fixture();
  await assert.rejects(unmapped.provider.prepare({ ...input, order, external_userid: customerId, phone: input.order.phone }), safeFailure("WECOM_GENERAL_CUSTOMER_UNMAPPED"));
  assert.equal(unmapped.calls.length, 0);
  for (const id of [input.order.phone, "test.staff", "wm_one;wm_two", "<script>"]) {
    await assert.rejects(unmapped.provider.prepare({ ...input, order: { ...input.order, wecom_external_userid: id } }), safeFailure("WECOM_GENERAL_CUSTOMER_INVALID"));
  }
});

test("invalid customer mapping JSON and invalid staff identities fail without network activity", async () => {
  for (const json of ["broken", "[]", "null"]) {
    const f = fixture(undefined, { WECOM_GENERAL_CONTACT_CUSTOMERS_JSON: json });
    await assert.rejects(f.provider.prepare({ ...input, order: { customer_openid: "customer-openid-test" } }), safeFailure("WECOM_GENERAL_MAPPING_INVALID"));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  for (const staff of [{}, { wecom_userid: "bad;staff" }, { ...input.staff, staff_status: "inactive" }]) {
    await assert.rejects(f.provider.prepare({ ...input, staff }), safeFailure("WECOM_GENERAL_STAFF_UNMAPPED"));
    assert.equal(f.calls.length, 0);
  }
});

test("current operator must actually follow the external customer; order ownership does not impersonate another member", async () => {
  const f = fixture(call => call.path === "externalcontact/get" ? { errcode: 0, external_contact: { external_userid: customerId }, follow_user: [{ userid: "another.staff" }] } : undefined);
  await assert.rejects(f.provider.prepare(input), safeFailure("WECOM_GENERAL_NOT_FOLLOWING"));
  assert.equal(f.count("get_jsapi_ticket"), 0); assert.equal(f.count("ticket/get"), 0);
});

test("following relationship is checked across all customer pages, with repeated cursors rejected", async () => {
  const f = fixture(call => call.path !== "externalcontact/get" ? undefined : call.url.searchParams.get("cursor")
    ? { errcode: 0, external_contact: { external_userid: customerId }, follow_user: [{ userid: "test.staff" }] }
    : { errcode: 0, external_contact: { external_userid: customerId }, follow_user: [], next_cursor: "next-1" });
  await f.provider.prepare(input); assert.equal(f.count("externalcontact/get"), 2);
  const repeated = fixture(call => call.path === "externalcontact/get" ? { errcode: 0, external_contact: { external_userid: customerId }, follow_user: [], next_cursor: "same" } : undefined);
  await assert.rejects(repeated.provider.prepare(input), safeFailure("WECOM_GENERAL_RESPONSE_INVALID"));
  assert.equal(repeated.count("externalcontact/get"), 2);
});

test("token and separate tickets are cached and shared, while contact relationship is always rechecked", async () => {
  const f = fixture();
  await Promise.all([f.provider.prepare(input), f.provider.prepare(input)]);
  assert.equal(f.count("gettoken"), 1); assert.equal(f.count("get_jsapi_ticket"), 1); assert.equal(f.count("ticket/get"), 1); assert.equal(f.count("externalcontact/get"), 2);
  f.advance(7200000); await f.provider.prepare(input);
  assert.equal(f.count("gettoken"), 2); assert.equal(f.count("get_jsapi_ticket"), 2); assert.equal(f.count("ticket/get"), 2);
});

test("rejected access token is refreshed once, not retried indefinitely", async () => {
  const once = fixture((call, calls) => call.path === "externalcontact/get" && calls.filter(c => c.path === call.path).length === 1 ? { errcode: 42001 } : undefined);
  await once.provider.prepare(input); assert.equal(once.count("gettoken"), 2); assert.equal(once.count("externalcontact/get"), 2);
  const always = fixture(call => call.path === "externalcontact/get" ? { errcode: 40014, errmsg: "PRIVATE_SECRET_ONLY PRIVATE_ACCESS_TOKEN" } : undefined);
  await assert.rejects(always.provider.prepare(input), safeFailure("WECOM_GENERAL_API_REJECTED")); assert.equal(always.count("gettoken"), 2);
});

test("malformed provider responses and private provider errors are never exposed", async () => {
  const failures = [
    { errcode: 48002, errmsg: `PRIVATE_SECRET_ONLY ${input.order.phone}` },
    { errcode: "0" },
    { errcode: 0, external_contact: { external_userid: "wm_OTHER_CUSTOMER" }, follow_user: [{ userid: "test.staff" }] },
    { errcode: 0, external_contact: { external_userid: customerId }, follow_user: null },
    { ok: false, json: () => assert.fail("must not parse failure body") },
    { ok: true, json: async () => { throw Error("PRIVATE_ACCESS_TOKEN"); } },
    Error(`https://qyapi.weixin.qq.com/?secret=PRIVATE_SECRET_ONLY ${input.order.phone}`),
  ];
  for (const result of failures) {
    const f = fixture(call => call.path === "externalcontact/get" ? result : undefined);
    await assert.rejects(f.provider.prepare(input), e => { privateFieldsAbsent({ ...e, message: e.message, stack: e.stack }); assert.equal(e.url, undefined); return true; });
  }
});

test("invalid tickets and short credential lifetimes do not produce misleading readiness", async () => {
  const invalid = fixture(call => call.path === "ticket/get" ? { errcode: 0, ticket: "", expires_in: 7200 } : undefined);
  await assert.rejects(invalid.provider.prepare(input), safeFailure("WECOM_GENERAL_CREDENTIAL_INVALID"));
  const short = fixture(call => ["get_jsapi_ticket", "ticket/get"].includes(call.path) ? { errcode: 0, ticket: "short-ticket", expires_in: 1 } : undefined);
  await short.provider.prepare(input); short.advance(1100); await short.provider.prepare(input);
  assert.equal(short.count("get_jsapi_ticket"), 2); assert.equal(short.count("ticket/get"), 2);
});
