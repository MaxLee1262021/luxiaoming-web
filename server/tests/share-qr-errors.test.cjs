"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { deflateSync } = require("node:zlib");
const { createQrProvider, QR_ERROR_MESSAGES } = require("../lib/merchantCodes.cjs");
const { createShareService } = require("../lib/merchantShare.cjs");
const createApi = require("../lib/api.cjs");
const { fixture, merchant } = require("./fixtures/shareSql.cjs");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, body) {
  const typed = Buffer.concat([Buffer.from(type), body]); const header = Buffer.alloc(4), trailer = Buffer.alloc(4);
  header.writeUInt32BE(body.length); trailer.writeUInt32BE(crc32(typed)); return Buffer.concat([header, typed, trailer]);
}
function validLargePng() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr),
    pngChunk("tEXt", Buffer.from("Description\0" + "q".repeat(70000))), pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), pngChunk("IEND", Buffer.alloc(0))]);
}
function providerFor(bytes, options = {}) {
  return createQrProvider({ env: { WX_APP_ID: "synthetic-app", WX_APP_SECRET: "DO_NOT_EXPOSE_SECRET" }, ...options,
    request: async url => url.includes("/cgi-bin/token") ? { status: 200, body: Buffer.from(JSON.stringify({ access_token: "DO_NOT_EXPOSE_TOKEN", expires_in: 7200 })) } : { status: 200, body: bytes } });
}
test("share QR provider accepts a valid PNG above 60000 bytes while the legacy default retains its TEXT limit", async () => {
  const png = validLargePng(); assert.ok(png.length > 60000);
  await assert.rejects(providerFor(png)("c=legacy"), { code: "QR_IMAGE_TOO_LARGE" });
  const image = await providerFor(png, { maxImageBytes: 3 * 1024 * 1024 })("SABCDEF1234567890");
  assert.deepEqual(Buffer.from(image.split(",")[1], "base64"), png);
  assert.ok(Buffer.byteLength(image) > 60000);
  const f = fixture(), store = f.newStore(); await store.ensureSchema();
  await store.onboardMerchant({ ...merchant(), qr: { id: "large-qr", scene: "SABCDEF1234567890", imageUrl: image } });
  assert.equal((await store.getActiveQr("m1")).imageUrl, image);
});
test("custom encoded-size and binary response limits are enforced before persistence", async () => {
  const png = validLargePng(), dataBytes = Buffer.byteLength("data:image/png;base64," + png.toString("base64"));
  await assert.rejects(providerFor(png, { maxImageBytes: dataBytes - 1 })("c=small"), { code: "QR_IMAGE_TOO_LARGE" });
  assert.ok(await providerFor(png, { maxImageBytes: dataBytes })("c=exact"));
  const oversized = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
  await assert.rejects(providerFor(oversized, { maxImageBytes: 3 * 1024 * 1024 })("c=binary"), { code: "QR_IMAGE_TOO_LARGE" });
  const f = fixture(), store = f.newStore(); await store.ensureSchema();
  const limit = 3 * 1024 * 1024; const prefix = "data:image/png;base64,";
  await store.onboardMerchant({ ...merchant(), qr: { id: "qr-at-limit", scene: "c=atlimit", imageUrl: prefix + "A".repeat(limit - prefix.length) } });
  assert.equal(Buffer.byteLength((await store.getActiveQr("m1")).imageUrl), limit);
  await assert.rejects(store.rotateQr({ merchantId: "m1", id: "over", scene: "c=over", imageUrl: prefix + "A".repeat(limit - prefix.length + 1), reason: "size check", operatorId: "super", requestId: "too-large" }), { code: "SHARE_4001" });
  assert.equal((await store.getActiveQr("m1")).id, "qr-at-limit");
});
test("QR failures carry only fixed safe messages and numeric provider codes", async () => {
  const cases = [
    { code: "QR_CREDENTIALS_MISSING", provider: createQrProvider({ env: {} }) },
    { code: "QR_TOKEN_REJECTED", provider: createQrProvider({ env: { WX_APP_ID: "a", WX_APP_SECRET: "DO_NOT_EXPOSE_SECRET" }, request: async () => ({ status: 200, body: Buffer.from('{"errcode":40164,"errmsg":"DO_NOT_EXPOSE_TOKEN"}') }) }) },
    { code: "QR_PAGE_NOT_RELEASED", provider: providerFor(Buffer.from('{"errcode":41030,"errmsg":"DO_NOT_EXPOSE_TOKEN"}')) },
    { code: "QR_API_UNAVAILABLE", provider: createQrProvider({ env: { WX_APP_ID: "a", WX_APP_SECRET: "s" }, request: async () => { throw new Error("https://api.invalid?secret=DO_NOT_EXPOSE_SECRET"); } }) },
  ];
  for (const item of cases) await assert.rejects(item.provider("c=example"), error => error.code === item.code && error.message === QR_ERROR_MESSAGES[item.code] && !/DO_NOT_EXPOSE|https:/.test(JSON.stringify(error) + error.message));
});
test("onboarding exposes an allowlisted QR failure over HTTP and leaves the aggregate untouched", async t => {
  let writes = 0; const logged = [];
  const store = { getMerchant: async () => null, getMerchantByName: async () => null, onboardMerchant: async () => { writes++; throw new Error("must not persist"); } };
  const source = { list: async () => [], get: async () => ({ id: "admin", account: "admin", role: "super", status: "active" }) };
  const service = createShareService(source, { store, qrProvider: providerFor(Buffer.from('{"errcode":41030,"errmsg":"DO_NOT_EXPOSE_TOKEN"}')) });
  const auth = { init: async () => {}, getSession: async () => ({ kind: "admin", role: "super", account: "admin", subjectId: "admin" }) };
  let responseError = null;
  const handler = createApi(source, "json", { auth, permissionStore: null, shareService: { onboard: (...args) => responseError ? Promise.reject(responseError) : service.onboard(...args) },
    logger: { info() {}, warn() {}, error: (...args) => logged.push(args) }, wechatPay: { isConfigured: () => false } });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0])); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/share/merchants`, { method: "POST", headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json", "Idempotency-Key": "safe-error-test" },
      body: JSON.stringify({ name: "测试门店", account: "synthetic", password: "Synthetic123!", cooperationConfirmed: true, ratioT1: "0.05", ratioT2: "0.03", ttlHours: 720, refundWindowDays: 3, reason: "测试" }) });
    return { status: response.status, body: await response.json() };
  };
  const result = await send(); assert.equal(result.status, 503); assert.equal(result.body.code, "SHARE_QR_PAGE_NOT_RELEASED"); assert.equal(result.body.msg, QR_ERROR_MESSAGES.QR_PAGE_NOT_RELEASED); assert.equal(writes, 0);
  responseError = Object.assign(new Error("DO_NOT_EXPOSE_RAW_SQL"), { code: "ER_TEST_PRIVATE", statusCode: 503 });
  const privateError = await send(); assert.match(privateError.body.msg, /商家分成服务暂不可用/);
  assert.equal(JSON.stringify([result, privateError, logged]).includes("DO_NOT_EXPOSE"), false);
  assert.ok(logged.some(([event, data]) => event === "share.request.failed" && data.errorCode === "SHARE_QR_PAGE_NOT_RELEASED" && data.wechatCode === 41030));
});
