"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const staticHandler = require("../lib/static.cjs");

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-static-delivery-"));
  const write = (name, body) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const text = "/* Public admin assets: 页面加载 */\n".repeat(500);
  write("index.html", `<html><body>${text}</body></html>`);
  write("src/app.js", text);
  write("src/styles/app.css", text);
  write("public/vendor/tiny.js", "window.tiny = true;");
  write("public/icon.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const handler = staticHandler(root);
  const server = http.createServer((req, res) => {
    if (options.vary) res.setHeader("Vary", options.vary);
    handler(req, res, req.url).catch(error => {
      res.statusCode = 500;
      res.end(error.message);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (pathname, headers = {}, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: pathname, headers, method }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  return { root, write, text, request };
}

test("large public scripts, styles and HTML use negotiated gzip without changing their bytes", async t => {
  const f = await fixture(t);
  for (const pathname of ["/src/app.js", "/src/styles/app.css", "/"]) {
    const plain = await f.request(pathname);
    const zipped = await f.request(pathname, { "Accept-Encoding": "gzip, deflate, br" });
    assert.equal(plain.status, 200);
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers["content-encoding"], "gzip");
    assert.equal(zipped.headers.vary, "Accept-Encoding");
    assert.equal(zipped.headers["x-content-type-options"], "nosniff");
    assert.equal(zipped.headers.etag, plain.headers.etag, "the weak validator identifies the same content across transfer encodings");
    assert.equal(Number(zipped.headers["content-length"]), zipped.body.length);
    assert.deepEqual(gunzipSync(zipped.body), plain.body);
    assert.ok(zipped.body.length < plain.body.length / 4);
    assert.equal(zipped.headers["cache-control"], "public, max-age=0, must-revalidate");
  }
});

test("encoding exclusions, explicit preferences and small/binary responses are honored", async t => {
  const f = await fixture(t);
  for (const encoding of ["gzip;q=0", "br", "gzip;q=0, *;q=1", "gzip;q=0.2, identity;q=1", "gzip;q=invalid"]) {
    const response = await f.request("/src/app.js", { "Accept-Encoding": encoding });
    assert.equal(response.status, 200, encoding);
    assert.equal(response.headers["content-encoding"], undefined, encoding);
    assert.equal(response.body.toString(), f.text);
  }
  for (const pathname of ["/public/vendor/tiny.js", "/public/icon.png"]) {
    const response = await f.request(pathname, { "Accept-Encoding": "gzip" });
    assert.equal(response.headers["content-encoding"], undefined);
  }
  const tiny = await f.request("/public/vendor/tiny.js", { "Accept-Encoding": "identity;q=0, gzip;q=0.5" });
  assert.equal(tiny.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(tiny.body).toString(), "window.tiny = true;");
  for (const encoding of ["*;q=0", "identity;q=0, gzip;q=0", "identity;q=0, br"]) {
    const response = await f.request("/src/app.js", { "Accept-Encoding": encoding });
    assert.equal(response.status, 406);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-encoding"], undefined);
  }
});

test("compression adds its cache key without replacing an existing Vary header", async t => {
  const f = await fixture(t, { vary: "Origin" });
  const response = await f.request("/src/app.js", { "Accept-Encoding": "gzip" });
  assert.equal(response.headers.vary, "Origin, Accept-Encoding");
  const cached = await f.request("/src/app.js", { "If-None-Match": response.headers.etag });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.vary, "Origin, Accept-Encoding");
});

test("conditional revalidation returns no body and ETag takes precedence over modification dates", async t => {
  const f = await fixture(t);
  const first = await f.request("/src/app.js", { "Accept-Encoding": "gzip" });
  for (const headers of [
    { "If-None-Match": first.headers.etag, "Accept-Encoding": "gzip" },
    { "If-None-Match": `"other", ${first.headers.etag.replace(/^W\//, "")}` },
    { "If-None-Match": "*" },
    { "If-Modified-Since": first.headers["last-modified"] },
  ]) {
    const response = await f.request("/src/app.js", headers);
    assert.equal(response.status, 304);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers.etag, first.headers.etag);
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.equal(response.headers["cache-control"], "public, max-age=0, must-revalidate");
  }
  const different = await f.request("/src/app.js", {
    "If-None-Match": 'W/"outdated"', "If-Modified-Since": new Date(Date.now() + 60000).toUTCString(),
  });
  assert.equal(different.status, 200);
  assert.equal(different.body.toString(), f.text);
});

test("HEAD uses GET representation headers and sends no response body", async t => {
  const f = await fixture(t);
  for (const encoding of ["identity", "gzip"]) {
    const get = await f.request("/src/app.js", { "Accept-Encoding": encoding });
    const head = await f.request("/src/app.js", { "Accept-Encoding": encoding }, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    for (const key of ["content-type", "content-length", "content-encoding", "etag", "last-modified", "vary"]) {
      assert.equal(head.headers[key], get.headers[key], key);
    }
    assert.equal((await f.request("/src/app.js", { "If-None-Match": get.headers.etag }, "HEAD")).status, 304);
  }
});

test("editing a compressed asset invalidates both cached content and the browser validator", async t => {
  const f = await fixture(t);
  const first = await f.request("/src/app.js", { "Accept-Encoding": "gzip" });
  const file = path.join(f.root, "src/app.js");
  const before = fs.statSync(file);
  const updated = f.text.replace("Public", "Edited");
  assert.equal(Buffer.byteLength(updated), Buffer.byteLength(f.text));
  fs.writeFileSync(file, updated);
  fs.utimesSync(file, before.atime, before.mtime);
  const changed = await f.request("/src/app.js", {
    "Accept-Encoding": "gzip", "If-None-Match": first.headers.etag,
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.equal(gunzipSync(changed.body).toString(), updated);
  assert.equal((await f.request("/src/app.js", { "If-None-Match": changed.headers.etag })).status, 304);
  fs.unlinkSync(file);
  assert.equal((await f.request("/src/app.js", { "If-None-Match": changed.headers.etag })).status, 404);
});

test("public delivery still rejects secrets, test files, traversal and write methods", async t => {
  const f = await fixture(t);
  for (const name of [".env", "runtime-config.js", "server/settings.json", "src/mock/demo.js", "src/tests/test.js", "public/public-data.js"]) f.write(name, "PRIVATE");
  for (const pathname of ["/.env", "/runtime-config.js", "/server/settings.json", "/src/mock/demo.js", "/src/tests/test.js", "/public/public-data.js", "/src/../../.env", "/src/%2e%2e/%2e%2e/.env", "/src/%00bad.js", "/src/missing.js"]) {
    const response = await f.request(pathname, { "Accept-Encoding": "gzip", "If-None-Match": "*" });
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers["cache-control"], "no-store", pathname);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.body.includes(Buffer.from("PRIVATE")), false);
  }
  const write = await f.request("/src/app.js", { "Accept-Encoding": "gzip" }, "POST");
  assert.equal(write.status, 405);
  assert.equal(write.headers.allow, "GET, HEAD");
  assert.equal(write.headers["cache-control"], "no-store");
});

test("large uncached text streams through gzip and concurrent readers share valid responses", async t => {
  const f = await fixture(t);
  const large = "/* streamed public asset */\n".repeat(170000);
  f.write("public/large.js", large);
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.request("/public/large.js", { "Accept-Encoding": "gzip" })));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(response.body).toString(), large);
  }
});
