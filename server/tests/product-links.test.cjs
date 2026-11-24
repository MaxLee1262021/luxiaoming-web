"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createProductLinksService, createUrlLinkProvider, ERROR_MESSAGES } = require("../lib/productLinks.cjs");

const credentials = { WX_APP_ID: "wx-fixture", WX_APP_SECRET: "private-fixture-secret" };
function fixture(overrides = {}) {
  const rows = {
    cities: [{ id: "city", name: "长沙", status: "运营中" }],
    spots: [{ id: "spot", name: "拍摄点", cityId: "city" }],
    series: [{ id: "style", name: "风格", spotId: "spot" }],
    albums: [{ id: "album", name: "照片留影", price: 99, seriesId: "style", summary: "  <p>拍摄服务</p>  " }],
    packages: [{ id: "video", title: "视频摄像", price: 199, spotId: "spot", type: "video", productKind: "video_single" },
      { id: "bundle", name: "旅拍套餐", price: 299, seriesId: "style", productKind: "package", includedItems: [{ type: "album", albumId: "album" }] }],
    peripherals: [{ id: "gift", name: "相框", spotId: "spot", specMode: "multiple", skus: [{ price: 20 }, { price: 15 }], stock: 9, cost: 5, privateNote: "not public" }],
    ...overrides,
  };
  const reads = [], writes = [];
  const source = {
    async list(key) { reads.push(key); return structuredClone(rows[key] || []); },
    async get(key, id) { return structuredClone((rows[key] || []).find(row => String(row.id) === String(id)) || null); },
    async update() { writes.push("update"); throw new Error("unexpected write"); },
    async create() { writes.push("create"); throw new Error("unexpected write"); },
  };
  return { rows, reads, writes, source };
}
function providerFixture(responder) {
  const calls = [];
  const request = async (url, options = {}, body) => {
    const call = { url: new URL(url), options, body: body ? JSON.parse(body) : null };
    calls.push(call);
    const result = responder ? await responder(call, calls.length) : call.url.pathname === "/cgi-bin/token" ? { access_token: "token", expires_in: 7200 } : { errcode: 0, url_link: "https://wxaurl.cn/generated" };
    return { status: 200, body: Buffer.from(JSON.stringify(result)) };
  };
  return { calls, request };
}
const target = { path: "pages/photoCollection/photoCollection", query: "albumId=album", expireDays: 30, environment: "release" };
const hasCode = (code, statusCode) => error => {
  assert.equal(error.code, code); assert.equal(error.message, ERROR_MESSAGES[code]);
  if (statusCode) assert.equal(error.statusCode, statusCode);
  return true;
};

test("catalog summarizes every service and peripheral without leaking management fields or writing data", async () => {
  const { source, reads, writes } = fixture();
  const service = createProductLinksService(source, { env: {} });
  const result = await service.catalog();
  assert.equal(result.configured, false);
  assert.equal(result.environment, "release");
  assert.deepEqual(result.items.map(row => row.type), ["album", "video", "package", "peripheral"]);
  assert.ok(result.items.every(row => row.canGenerate && row.status === "available"));
  assert.equal(result.items[0].summary, "拍摄服务");
  assert.equal(result.items[3].price, 15);
  assert.equal(result.items[3].stock, undefined);
  assert.equal(result.items[3].privateNote, undefined);
  for (const key of ["albums", "packages", "peripherals", "spots", "cities", "series"]) assert.equal(reads.filter(value => value === key).length, 1, key);
  assert.deepEqual(writes, []);
});

test("all catalog rows are included beyond the mini-program recommendation windows", async () => {
  const { source } = fixture({ albums: Array.from({ length: 130 }, (_, index) => ({ id: `photo-${index}`, name: `照片 ${index}`, price: 20 })) });
  const result = await createProductLinksService(source, { env: credentials }).catalog();
  assert.equal(result.items.filter(row => row.type === "album").length, 130);
  assert.equal(result.items.find(row => row.id === "photo-129").canGenerate, true);
});

test("video media does not change package routing and unmarked legacy video products cannot create a wrong detail link", async () => {
  const { source } = fixture({ packages: [
    { id: "photo-with-media", name: "旅拍套餐", productKind: "package", videoUrl: "https://media.test/preview.mp4" },
    { id: "legacy-video", name: "旧视频套餐", type: "video" },
    { id: "video-no-media", name: "视频摄像", type: "video", isVideoSingle: true },
  ] });
  const { items } = await createProductLinksService(source, { env: credentials }).catalog();
  assert.equal(items.find(row => row.id === "photo-with-media").type, "package");
  assert.equal(items.find(row => row.id === "photo-with-media").canGenerate, true);
  assert.equal(items.find(row => row.id === "legacy-video").canGenerate, false);
  assert.equal(items.find(row => row.id === "video-no-media").type, "video");
  assert.equal(items.find(row => row.id === "video-no-media").canGenerate, true);
});

test("offline and rejected rows remain visible but cannot generate, while deleted rows are absent", async () => {
  const { source } = fixture({ albums: [
    { id: "offline", status: "下架" }, { id: "rejected", auditStatus: "rejected" },
    { id: "deleted", deleted: true }, { id: "deleted-alias", isDeleted: true },
  ] });
  const service = createProductLinksService(source, { env: credentials });
  const { items } = await service.catalog();
  assert.ok(items.some(row => row.id === "offline" && !row.canGenerate));
  assert.ok(items.some(row => row.id === "rejected" && !row.canGenerate));
  assert.equal(items.some(row => row.id.startsWith("deleted")), false);
  await assert.rejects(service.generate({ type: "album", id: "offline" }), hasCode("PRODUCT_LINK_UNAVAILABLE", 409));
  await assert.rejects(service.generate({ type: "album", id: "deleted" }), hasCode("PRODUCT_LINK_NOT_FOUND", 404));
});

test("disabled cities, hidden bundle children and stale series relations disable exact detail targets", async () => {
  for (const mutate of [
    rows => { rows.cities[0].status = "筹备中"; },
    rows => { rows.spots[0].isShow = false; },
  ]) {
    const { source, rows } = fixture(); mutate(rows);
    const { items } = await createProductLinksService(source, { env: credentials }).catalog();
    assert.ok(items.every(row => !row.canGenerate));
  }
  const { source, rows } = fixture();
  rows.albums[0].status = "下架";
  let result = await createProductLinksService(source, { env: credentials }).catalog();
  assert.equal(result.items.find(row => row.id === "bundle").canGenerate, false);
  delete rows.albums[0].status;
  rows.packages[1].seriesId = "missing-style";
  result = await createProductLinksService(source, { env: credentials }).catalog();
  assert.equal(result.items.find(row => row.id === "bundle").canGenerate, false);
});

test("generate maps four exact product IDs to existing mini-program pages and fixes environment server-side", async () => {
  const { source, writes } = fixture();
  const seen = [];
  const service = createProductLinksService(source, { env: { ...credentials, WX_ENV_VERSION: "trial" }, now: () => Date.UTC(2026, 10, 19), provider: async value => { seen.push(value); return `https://wxmpurl.cn/link-${seen.length}`; } });
  const cases = [
    ["album", "album", "pages/photoCollection/photoCollection", "albumId=album"],
    ["video", "video", "pages/videoProductDetail/videoProductDetail", "productId=video"],
    ["package", "bundle", "pages/photoPackageDetail/photoPackageDetail", "packageId=bundle"],
    ["peripheral", "gift", "pages/peripherals/peripherals", "id=gift"],
  ];
  for (const [type, id, path, query] of cases) {
    const result = await service.generate({ type, id, expireDays: 7, path: "pages/untrusted", environment: "develop" });
    assert.equal(result.path, path); assert.equal(result.query, query);
    assert.equal(result.environment, "trial");
    assert.equal(result.expiresAt, "2026-11-26T00:00:00.000Z");
  }
  assert.ok(seen.every(value => value.expireDays === 7 && value.environment === "trial"));
  assert.deepEqual(writes, []);
});

test("concurrent requests reuse one generated link but hiding or deleting a product invalidates access to cached links", async () => {
  const { source, rows } = fixture();
  let clock = 1000000, count = 0;
  const service = createProductLinksService(source, { env: credentials, now: () => clock, provider: async () => { count += 1; await new Promise(resolve => setImmediate(resolve)); return `https://wxaurl.cn/link-${count}`; } });
  const input = { type: "peripheral", id: "gift", expireDays: 1 };
  const results = await Promise.all([service.generate(input), service.generate(input), service.generate(input)]);
  assert.equal(count, 1); assert.equal(results[0].url, results[1].url);
  results[0].url = "mutated";
  assert.equal((await service.generate(input)).url, "https://wxaurl.cn/link-1");
  rows.peripherals[0].isShow = false;
  await assert.rejects(service.generate(input), hasCode("PRODUCT_LINK_UNAVAILABLE", 409));
  rows.peripherals[0].isShow = true;
  clock += 86400000;
  assert.equal((await service.generate(input)).url, "https://wxaurl.cn/link-2");
  rows.peripherals[0].deleted = true;
  await assert.rejects(service.generate(input), hasCode("PRODUCT_LINK_NOT_FOUND", 404));
});

test("invalid target IDs, mismatched types and unsupported expiry never call the provider", async () => {
  const { source } = fixture(); let called = false;
  const service = createProductLinksService(source, { env: credentials, provider: async () => { called = true; return "https://wxaurl.cn/x"; } });
  for (const input of [null, [], { type: "__proto__", id: "album" }, { type: "album", id: " album" }, { type: "album", id: "a\nb" }, { type: "album", id: "album", expireDays: true }, { type: "album", id: "album", expireDays: 365 }, { type: "album", id: "album", expireDays: 0 }]) {
    await assert.rejects(service.generate(input), hasCode("PRODUCT_LINK_INPUT_INVALID", 400));
  }
  await assert.rejects(service.generate({ type: "album", id: "gift" }), hasCode("PRODUCT_LINK_NOT_FOUND", 404));
  await assert.rejects(service.generate({ type: "package", id: "video" }), hasCode("PRODUCT_LINK_NOT_FOUND", 404));
  assert.equal(called, false);
});

test("special characters in canonical IDs are encoded once and cannot inject other query parameters", async () => {
  const id = "照片&A=1#%+?";
  const { source } = fixture({ albums: [{ id, name: "特殊编号" }] }); let seen;
  const service = createProductLinksService(source, { env: credentials, provider: async target => { seen = target; return "https://wxaurl.cn/encoded"; } });
  await service.generate({ type: "album", id });
  assert.deepEqual([...new URLSearchParams(seen.query)], [["albumId", id]]);
});

test("missing credentials and catalog errors produce bounded public errors", async () => {
  const { source } = fixture();
  await assert.rejects(createProductLinksService(source, { env: {} }).generate({ type: "album", id: "album" }), hasCode("PRODUCT_LINK_CREDENTIALS_MISSING"));
  await assert.rejects(createProductLinksService({ async list() { throw new Error("secret SQL password"); } }, { env: credentials }).catalog(), hasCode("PRODUCT_LINK_CATALOG_UNAVAILABLE"));
});

test("provider sends the official URL Link payload, caches tokens and refreshes expired tokens", async () => {
  let clock = 1000;
  const { calls, request } = providerFixture();
  const provider = createUrlLinkProvider({ env: credentials, now: () => clock, request });
  assert.equal(await provider(target), "https://wxaurl.cn/generated");
  await provider({ ...target, query: "albumId=other" });
  assert.equal(calls.filter(call => call.url.pathname === "/cgi-bin/token").length, 1);
  assert.deepEqual(calls[1].body, { path: target.path, query: target.query, expire_type: 1, expire_interval: 30, env_version: "release" });
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].url.origin, "https://api.weixin.qq.com");
  clock += 7200000;
  await provider(target);
  assert.equal(calls.filter(call => call.url.pathname === "/cgi-bin/token").length, 2);
});

test("provider serializes concurrent token requests and refreshes an invalid token once", async () => {
  let tokenCalls = 0, linkCalls = 0;
  const { request } = providerFixture(call => {
    if (call.url.pathname === "/cgi-bin/token") return { access_token: `token-${++tokenCalls}`, expires_in: 7200 };
    linkCalls += 1;
    if (linkCalls === 1) return { errcode: 40001, errmsg: "invalid token with secret debug" };
    return { errcode: 0, url_link: "https://wxaurl.cn/retried" };
  });
  const provider = createUrlLinkProvider({ env: credentials, request });
  assert.equal(await provider(target), "https://wxaurl.cn/retried");
  assert.equal(tokenCalls, 2); assert.equal(linkCalls, 2);
  const parallel = providerFixture(async call => {
    if (call.url.pathname === "/cgi-bin/token") { await new Promise(resolve => setImmediate(resolve)); return { access_token: "shared", expires_in: 7200 }; }
    return { url_link: "https://wxmpurl.cn/shared" };
  });
  const parallelProvider = createUrlLinkProvider({ env: credentials, request: parallel.request });
  await Promise.all([parallelProvider(target), parallelProvider(target), parallelProvider(target)]);
  assert.equal(parallel.calls.filter(call => call.url.pathname === "/cgi-bin/token").length, 1);
});

test("provider retries invalid tokens only once and never leaks upstream error text", async () => {
  const { calls, request } = providerFixture(call => call.url.pathname === "/cgi-bin/token" ? { access_token: "invalid-secret-token" } : { errcode: 42001, errmsg: "private secret diagnostic" });
  await assert.rejects(createUrlLinkProvider({ env: credentials, request })(target), hasCode("PRODUCT_LINK_TOKEN_REJECTED"));
  assert.equal(calls.length, 4);
});

test("provider maps quota and page errors and rejects untrusted, malformed or oversized responses", async () => {
  for (const [result, code, status] of [
    [{ errcode: 45009, errmsg: "private" }, "PRODUCT_LINK_QUOTA_EXCEEDED", 429],
    [{ errcode: 41030 }, "PRODUCT_LINK_PAGE_INVALID", 400],
    [{ errcode: 99999 }, "PRODUCT_LINK_API_REJECTED", 503],
    [{ url_link: "https://wxaurl.cn.evil.test/link" }, "PRODUCT_LINK_RESPONSE_INVALID", 503],
    [{ url_link: "http://wxaurl.cn/link" }, "PRODUCT_LINK_RESPONSE_INVALID", 503],
    [{ url_link: "https://evil@wxaurl.cn/link" }, "PRODUCT_LINK_RESPONSE_INVALID", 503],
    [{ url_link: "javascript:alert(1)" }, "PRODUCT_LINK_RESPONSE_INVALID", 503],
  ]) {
    const { request } = providerFixture(call => call.url.pathname === "/cgi-bin/token" ? { access_token: "token" } : result);
    await assert.rejects(createUrlLinkProvider({ env: credentials, request })(target), hasCode(code, status));
  }
  for (const body of [Buffer.from("not JSON"), Buffer.alloc(65537, 32), Buffer.from("[]")]) {
    await assert.rejects(createUrlLinkProvider({ env: credentials, request: async () => ({ status: 200, body }) })(target), hasCode("PRODUCT_LINK_RESPONSE_INVALID"));
  }
  await assert.rejects(createUrlLinkProvider({ env: credentials, request: async () => { throw new Error("https://secret.example?token=private"); } })(target), hasCode("PRODUCT_LINK_API_UNAVAILABLE"));
});

test("failed generation is not cached and can be retried", async () => {
  const { source } = fixture(); let count = 0;
  const service = createProductLinksService(source, { env: credentials, provider: async () => { count += 1; if (count === 1) throw new Error("temporary"); return "https://wxaurl.cn/recovered"; } });
  await assert.rejects(service.generate({ type: "album", id: "album" }));
  assert.equal((await service.generate({ type: "album", id: "album" })).url, "https://wxaurl.cn/recovered");
  assert.equal(count, 2);
});
