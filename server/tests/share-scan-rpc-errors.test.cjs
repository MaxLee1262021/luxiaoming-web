"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const rpc = require("../lib/rpc.cjs");
const { serviceFor, qrScene } = require("../lib/merchantShare.cjs");
const identity = { identity: { kind: "public", openid: "synthetic-user", sessionId: "verified-session" } };
const scene = qrScene("0123456789ABCD");
function sourceWith(store) {
  const source = {};
  serviceFor(source, { store, clock: () => new Date("2026-11-07T00:00:00Z"), enableAt: "2026-11-01T00:00:00Z" });
  return source;
}
test("stopped QR exposes the safe business code and cannot mutate a binding", async () => {
  let writes = 0;
  const source = sourceWith({ getQrByScene: async () => ({ id: "old-qr", merchantId: "shop", status: "DISABLED" }), reportScan: async () => { writes++; } });
  const result = await rpc(source, "reportShareScan", { data: { scene } }, identity);
  assert.equal(result.success, false); assert.equal(result.code, "SHARE_4004"); assert.equal(result.statusCode, 400);
  assert.equal(result.error, "该码已停用，请联系门店"); assert.equal(writes, 0);
});
test("invalid scene and click parameters expose only safe SHARE 4xxx codes", async () => {
  const source = sourceWith({ getCsLink: async () => null, reportClick: async () => { throw Object.assign(new Error("参数不完整"), { code: "SHARE_4001", statusCode: 400 }); } });
  const invalid = await rpc(source, "reportShareScan", { data: { scene: "not-a-scene" } }, identity);
  assert.equal(invalid.code, "SHARE_4002");
  const click = await rpc(source, "reportShareClick", { data: {} }, identity);
  assert.equal(click.code, "SHARE_4001"); assert.equal(click.statusCode, 400);
  const anonymous = await rpc(source, "reportShareScan", { data: { scene } });
  assert.equal(anonymous.code, "SHARE_4030"); assert.equal(anonymous.statusCode, 401);
});
test("database and unknown collection failures remain generic without internal codes or messages", async () => {
  for (const [name, code] of [["reportShareScan", "ER_ACCESS_DENIED_ERROR"], ["reportShareClick", "SHARE_5001"], ["reportShareClick", undefined]]) {
    const failure = async () => { throw Object.assign(new Error("PRIVATE_HOST PRIVATE_DATABASE PRIVATE_USER"), { code }); };
    const source = sourceWith({ getQrByScene: failure, getCsLink: failure });
    const result = await rpc(source, name, { data: { scene, linkId: "synthetic-link", staffWecomId: "staff" } }, identity);
    assert.equal(result.success, false); assert.equal(result.error, "来源采集失败"); assert.equal(result.code, undefined);
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  }
});
