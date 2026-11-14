"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canPhoto, createPhotoRoute } = require("../lib/photoRoute.cjs");

function harness(service = {}, body = {}) {
  const response = { statusCode: null, headers: {}, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(value) { this.body = value; return this; } };
  const route = createPhotoRoute({ service,
    json(res, status, value) { res.statusCode = status; res.body = value; return res; },
    async readBody() { return body; } });
  return { response, async run(parts, session, method = "GET", query = {}) {
    await route({ method }, response, ["photo", ...parts], { query }, session);
    return response;
  } };
}
const photo = { kind: "admin", role: "photo", subjectId: "PH20260001", menuKeys: ["photoMine", "photoRules", "photoLedger", "photoParty", "photoSettlement"] };
const admin = { kind: "admin", role: "super", subjectId: "admin", account: "admin" };

test("external photographer cannot turn granted admin menus into write access", () => {
  for (const menu of ["photoRules", "photoLedger", "photoParty", "photoNew", "photoSettlement"]) {
    assert.equal(canPhoto(photo, menu, false), false, menu);
    assert.equal(canPhoto(photo, menu, true), false, menu);
  }
  assert.equal(canPhoto(photo, "photoMine", false), true);
  assert.equal(canPhoto(photo, "photoMine", true), false);
  assert.equal(canPhoto({ ...photo, kind: "customer" }, "photoMine", false), false);
});

test("photographer administrative routes fail before invoking service", async () => {
  let called = false;
  const service = new Proxy({}, { get() { return () => { called = true; throw new Error("must not execute"); }; } });
  for (const [parts, method] of [[ ["rule"], "GET" ], [ ["rule", "preview"], "POST" ], [ ["party"], "GET" ], [ ["party", "PH20260002", "status"], "POST" ], [ ["ledger"], "GET" ], [ ["ledger", "batch-settle"], "POST" ], [ ["settlement"], "GET" ]]) {
    const { run } = harness(service, { status: "ended", photo_id: "PH20260002" });
    const response = await run(parts, photo, method);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 403);
  }
  assert.equal(called, false);
});

test("mine route passes the authenticated identity, never an impersonated session", async () => {
  let call;
  const { run } = harness({ async mine(query, session) { call = { query, session }; return { kpi: {}, list: [] }; } });
  const response = await run(["me"], photo, "GET", { period: "2026-11", photo_id: "PH20260002" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.code, 0);
  assert.equal(call.session, photo);
  assert.equal(call.session.subjectId, "PH20260001");
  assert.equal(response.body.data.list.length, 0);
});

test("photographer CSV export is explicitly scoped to mine and retains BOM", async () => {
  let call;
  const csv = "\uFEFF订单号,OpenID\r\nLM1,openid";
  const { run } = harness({ async exportCsv(query, session, options) { call = { query, session, options }; return csv; } });
  const response = await run(["ledger", "export"], photo, "GET", { photo: "PH20260002" });
  assert.equal(call.options.mine, true);
  assert.equal(call.session.subjectId, "PH20260001");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/csv; charset=utf-8");
  assert.match(response.headers["content-disposition"], /attachment/);
  assert.equal(response.body, csv);
  assert.equal(response.body.charCodeAt(0), 0xFEFF);
});

test("super photographer preview export explicitly selects the same mine scope", async () => {
  const calls = [];
  const service = { async exportCsv(query, session, options) { calls.push({ query, session, options }); return "\uFEFF摄影师"; } };
  const query = { mine: "1", photo: "PH20260002", period: "2026-11" };
  assert.equal((await harness(service).run(["ledger", "export"], admin, "GET", query)).statusCode, 200);
  assert.deepEqual(calls[0], { query, session: admin, options: { mine: true } });
  await harness(service).run(["ledger", "export"], admin, "GET", {});
  assert.equal(calls[1].options.mine, false, "management exports retain their existing separate filter scope");
});

test("4302 stays HTTP 200 and preserves pending orders for the block dialog", async () => {
  const pending = [{ order_no: "LM20261110-0008", status: "confirmed", schedule_time: "2026-11-12 15:00:00" }];
  const { run } = harness({ async setPartyStatus(id, input, session) {
    assert.equal(id, "PH20260001"); assert.equal(input.status, "ended"); assert.equal(session, admin);
    throw Object.assign(new Error("无法终止：老赵 还有 1 笔在途订单"), { code: 4302, data: { pending_orders: pending } });
  } }, { status: "ended", reason: "合作到期" });
  const response = await run(["party", "PH20260001", "status"], admin, "POST");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.code, 4302);
  assert.deepEqual(response.body.data.pending_orders, pending);
  assert.match(response.body.msg, /无法终止/);
});

test("read grants alone cannot create profiles and unavailable storage is explicit", async () => {
  const viewer = { kind: "admin", role: "auditor", menuKeys: ["photoNew", "photoParty"] };
  assert.equal(canPhoto(viewer, "photoParty", false), true);
  assert.equal(canPhoto(viewer, "photoNew", true), false);
  const denied = await harness().run(["party"], viewer, "POST");
  assert.equal(denied.statusCode, 403);
  const unavailable = await harness({ async listParties() { throw new Error("private SQL connection detail"); } }).run(["party"], admin);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.code, "PHOTO_UNAVAILABLE");
  assert.doesNotMatch(unavailable.body.msg, /private SQL/);
  assert.match(unavailable.body.msg, /迁移与配置/);
});

test("only the administrator may create a photographer login even with broad delegated menu grants", async () => {
  let calls=0;
  const service={async createParty(){calls++;return {id:"PH20260001",account:"chosen-photographer",account_id:"usr-photo",account_created:true};}};
  for(const role of ["service","finance","auditor"]){
    const actor={kind:"admin",role,menuKeys:["photoNew"],photoPermissions:["photo:manage"]};
    assert.equal((await harness(service,{}).run(["party"],actor,"POST")).statusCode,403);
  }
  assert.equal(calls,0);
  const response=await harness(service,{}).run(["party"],admin,"POST");
  assert.equal(response.statusCode,200);
  assert.equal(response.headers["cache-control"],"no-store");
  assert.equal(response.headers.pragma,"no-cache");
  assert.equal(response.body.data.account,"chosen-photographer");
  assert.equal(response.body.data.account_created,true);
  assert.equal(response.body.data.credentials,undefined);
  assert.equal(calls,1);
});
