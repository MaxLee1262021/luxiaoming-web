"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const http = require("node:http");
const { once } = require("node:events");
const { prepareRelease, waitForHealth } = require("../../scripts/prepare-linux-update.cjs");

// Construct small archives directly so the rejection tests can exercise unsafe
// entries that a host's tar command would otherwise sanitize before writing.
function archiveEntry({ name, text = "", type = "0", link = "", mode = 0o644 }) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  assert.ok(Buffer.byteLength(name) <= 100, "fixture path fits a USTAR name");
  header.write(name, 0, 100, "utf8");
  const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(body.length, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

function releaseEntries() {
  const packageJson = {
    name: "luxiaoming-admin",
    scripts: {
      check: "node scripts/check-syntax.cjs",
      "backup:mysql": "node scripts/backup-mysql.cjs",
      "migrate:mysql": "node scripts/migrate-mysql.cjs"
    }
  };
  const files = {
    "package.json": JSON.stringify(packageJson),
    "package-lock.json": JSON.stringify({ name: "luxiaoming-admin", lockfileVersion: 3 }),
    "index.html": "<!doctype html><title>isolated new release</title>",
    "server/index.cjs": "// isolated server entry\n",
    "scripts/serve.cjs": "// isolated web entry\n",
    "scripts/check-syntax.cjs": "// isolated syntax check\n",
    "scripts/backup-mysql.cjs": "// isolated backup entry\n",
    "scripts/migrate-mysql.cjs": "// isolated migration entry\n",
    "deploy/linux/start.sh": "#!/bin/sh\nexec node scripts/serve.cjs\n",
    "deploy/linux/install.sh": "#!/bin/sh\nexit 0\n",
    "deploy/linux/luxiaoming-admin.service": "[Service]\nWorkingDirectory=/opt/luxiaoming-admin\n"
  };
  return [
    { name: "release/", type: "5", mode: 0o755 },
    ...Object.entries(files).map(([name, text]) => ({
      name: "release/" + name,
      text,
      mode: name.endsWith(".sh") ? 0o755 : 0o644
    }))
  ];
}

function writeFile(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function snapshot(root) {
  const found = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else found[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  visit(root);
  return found;
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-linux-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const currentDir = path.join(root, "apps", "current");
  const nextDir = path.join(root, "apps", "next");
  fs.mkdirSync(currentDir, { recursive: true });
  for (const entry of releaseEntries().filter(entry => entry.type !== "5")) {
    writeFile(currentDir, entry.name.slice("release/".length), entry.text);
  }
  writeFile(currentDir, "index.html", "old live site");
  const env = options.env || "# server-owned configuration\nNODE_ENV=production\nHOST=127.0.0.1\nPORT=5192\nDATA_MODE=mysql\n";
  writeFile(currentDir, ".env", env);
  const archivePath = path.join(root, "release.tar.gz");
  function archive(entries = releaseEntries()) {
    fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.concat([
      ...entries.map(archiveEntry), Buffer.alloc(1024)
    ])));
  }
  archive();
  return { root, currentDir, nextDir, archivePath, archive, env };
}

test("Linux release preparation preserves exact runtime config, payment files and an explicit custom directory", (t) => {
  const f = fixture(t);
  const publicKeyPath = path.join(f.currentDir, "verifiers", "custom", "platform-public.pem").replace(/\\/g, "/");
  const env = f.env + [
    "WECHAT_PAY_MCH_PRIVATE_KEY_PATH=./certs/merchant-private.pem",
    `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH="${publicKeyPath}"`,
    "WECHAT_PAY_PLATFORM_CERT_PATH=./certs/platform-cert.pem",
    ""
  ].join("\n");
  writeFile(f.currentDir, ".env", env);
  writeFile(f.currentDir, "certs/merchant-private.pem", "fixture merchant private material");
  writeFile(f.currentDir, "certs/platform-cert.pem", "fixture platform certificate");
  writeFile(f.currentDir, "verifiers/custom/platform-public.pem", "fixture platform public material");
  writeFile(f.currentDir, "verifiers/custom/rotation-notes.txt", "keep server-owned companion file");
  const before = snapshot(f.currentDir);

  const report = prepareRelease({ ...f, preserve: ["verifiers/custom"] });

  assert.equal(fs.readFileSync(path.join(f.nextDir, ".env"), "utf8"), env);
  for (const relative of ["certs/merchant-private.pem", "certs/platform-cert.pem", "verifiers/custom/platform-public.pem", "verifiers/custom/rotation-notes.txt"]) {
    assert.deepEqual(fs.readFileSync(path.join(f.nextDir, relative)), fs.readFileSync(path.join(f.currentDir, relative)), relative);
  }
  assert.match(fs.readFileSync(path.join(f.nextDir, "index.html"), "utf8"), /isolated new release/);
  assert.equal(Number(report.port), 5192);
  assert.deepEqual(snapshot(f.currentDir), before, "preparation never edits the live directory");
  assert.ok(!JSON.stringify(report).includes("fixture merchant private material"), "report does not reveal payment contents");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(f.nextDir, ".env")).mode & 0o777, 0o600);
    assert.ok(fs.statSync(path.join(f.nextDir, "deploy/linux/start.sh")).mode & 0o100, "launcher is executable by its owner");
    assert.equal(fs.statSync(path.join(f.nextDir, "deploy/linux/start.sh")).mode & 0o022, 0, "launcher is not writable by other users");
    assert.equal(fs.statSync(path.join(f.nextDir, "certs/merchant-private.pem")).mode & 0o077, 0);
  }
});

test("external payment files stay at their existing absolute locations", (t) => {
  const f = fixture(t);
  const externalKey = writeFile(f.root, "external/merchant.pem", "fixture external private key");
  const env = f.env + `WECHAT_PAY_MCH_PRIVATE_KEY_PATH="${externalKey.replace(/\\/g, "/")}"\n`;
  writeFile(f.currentDir, ".env", env);

  const result = prepareRelease(f);

  assert.equal(fs.readFileSync(path.join(f.nextDir, ".env"), "utf8"), env);
  assert.equal(fs.readFileSync(externalKey, "utf8"), "fixture external private key");
  assert.ok(!fs.existsSync(path.join(f.nextDir, "external")));
  assert.ok(result.externalPaymentFiles > 0);
});

for (const location of ["internal", "external"]) {
  test(`missing ${location} payment file fails before creating a release or touching the live app`, (t) => {
    const f = fixture(t);
    const missing = location === "internal" ? "./certs/missing.pem" : path.join(f.root, "external-missing.pem").replace(/\\/g, "/");
    writeFile(f.currentDir, ".env", f.env + `WECHAT_PAY_MCH_PRIVATE_KEY_PATH="${missing}"\n`);
    const before = snapshot(f.currentDir);

    assert.throws(() => prepareRelease(f), /payment|private|missing|exist|read|certificate|key|ENOENT/i);

    assert.deepEqual(snapshot(f.currentDir), before);
    assert.equal(fs.existsSync(f.nextDir), false);
  });
}

test("a release missing the server entry fails before creating a target", (t) => {
  const f = fixture(t);
  f.archive(releaseEntries().filter(entry => entry.name !== "release/server/index.cjs"));
  const before = snapshot(f.currentDir);

  assert.throws(() => prepareRelease(f), /server|entry|required|missing/i);

  assert.equal(fs.existsSync(f.nextDir), false);
  assert.deepEqual(snapshot(f.currentDir), before);
});

test("an existing release target is never replaced", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.nextDir);
  writeFile(f.nextDir, "sentinel", "do not replace this earlier release");
  const currentBefore = snapshot(f.currentDir);
  const nextBefore = snapshot(f.nextDir);

  assert.throws(() => prepareRelease(f), /exist|overwrite|target|available/i);

  assert.deepEqual(snapshot(f.currentDir), currentBefore);
  assert.deepEqual(snapshot(f.nextDir), nextBefore);
});

const unsafeEntries = [
  { name: "release/../../outside.txt", text: "traversal payload" },
  { name: (f) => path.join(f.root, "absolute-payload.txt").replace(/\\/g, "/"), text: "absolute payload" },
  { name: (f) => process.platform === "win32" ? path.join(f.root, "drive-payload.txt").replace(/\\/g, "/") : "C:/drive-payload.txt", text: "Windows absolute payload" },
  { name: "release\\..\\outside.txt", text: "backslash traversal payload" },
  { name: "release/linked", type: "2", link: "../../outside" },
  { name: "release/hardlinked", type: "1", link: "release/index.html" },
  { name: "release/device", type: "3" }
];
for (const entry of unsafeEntries) {
  test(`unsafe release archive entry is rejected: ${typeof entry.name === "function" ? entry.text : entry.name} (type ${entry.type || "0"})`, (t) => {
    const f = fixture(t);
    const archivePathEntry = { ...entry, name: typeof entry.name === "function" ? entry.name(f) : entry.name };
    f.archive([...releaseEntries(), archivePathEntry]);
    const before = snapshot(f.currentDir);

    assert.throws(() => prepareRelease(f), /archive|path|unsafe|unsupported|type|link|relative|absolute|travers|invalid|entry/i);

    assert.equal(fs.existsSync(f.nextDir), false);
    assert.equal(fs.existsSync(path.join(f.root, "outside.txt")), false);
    assert.equal(fs.existsSync(path.join(f.root, "absolute-payload.txt")), false);
    assert.equal(fs.existsSync(path.join(f.root, "drive-payload.txt")), false);
    assert.deepEqual(snapshot(f.currentDir), before);
  });
}

test("duplicate archive files are rejected instead of allowing the last payload to win", (t) => {
  const f = fixture(t);
  f.archive([...releaseEntries(), { name: "release/index.html", text: "duplicate replacement" }]);
  const before = snapshot(f.currentDir);

  assert.throws(() => prepareRelease(f), /duplicate|archive|exist|repeated/i);

  assert.equal(fs.existsSync(f.nextDir), false);
  assert.deepEqual(snapshot(f.currentDir), before);
});

test("GNU long filenames in a normal release retain their complete path and contents", (t) => {
  const f = fixture(t);
  const relative = `public/${"nested-".repeat(12)}/guide-${"image".repeat(8)}.txt`;
  f.archive([...releaseEntries(),
    { name: "././@LongLink", type: "L", text: `release/${relative}\0` },
    { name: "release/public/truncated-placeholder", text: "long filename payload" }
  ]);

  prepareRelease(f);

  assert.equal(fs.readFileSync(path.join(f.nextDir, relative), "utf8"), "long filename payload");
  assert.equal(fs.existsSync(path.join(f.nextDir, "public/truncated-placeholder")), false);
});

test("archive traversal hidden in a GNU long filename is rejected before staging", (t) => {
  const f = fixture(t);
  f.archive([...releaseEntries(),
    { name: "././@LongLink", type: "L", text: "release/../../outside.txt\0" },
    { name: "release/harmless-header.txt", text: "extended-path traversal" }
  ]);
  const before = snapshot(f.currentDir);

  assert.throws(() => prepareRelease(f), /unsafe|path|archive|relative/i);

  assert.equal(fs.existsSync(f.nextDir), false);
  assert.equal(fs.existsSync(path.join(f.root, "outside.txt")), false);
  assert.deepEqual(snapshot(f.currentDir), before);
});

test("archive traversal hidden in PAX metadata is rejected before staging", (t) => {
  const f = fixture(t);
  const record = "path=release/../../outside.txt\n";
  let length = Buffer.byteLength(record) + 2;
  while (Buffer.byteLength(`${length} ${record}`) !== length) length = Buffer.byteLength(`${length} ${record}`);
  f.archive([...releaseEntries(),
    { name: "release/PaxHeader", type: "x", text: `${length} ${record}` },
    { name: "release/harmless-header.txt", text: "metadata-path traversal" }
  ]);
  const before = snapshot(f.currentDir);

  assert.throws(() => prepareRelease(f), /unsafe|path|archive|relative/i);

  assert.equal(fs.existsSync(f.nextDir), false);
  assert.equal(fs.existsSync(path.join(f.root, "outside.txt")), false);
  assert.deepEqual(snapshot(f.currentDir), before);
});

test("custom preservation cannot overwrite executable application code", (t) => {
  const f = fixture(t);
  writeFile(f.currentDir, "scripts/serve.cjs", "old executable code");
  const before = snapshot(f.currentDir);

  assert.throws(() => prepareRelease({ ...f, preserve: ["scripts"] }), /preserve|reserved|code|allow|path/i);

  assert.equal(fs.existsSync(f.nextDir), false);
  assert.deepEqual(snapshot(f.currentDir), before);
});

async function healthServer(t, handler) {
  const f = fixture(t);
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  writeFile(f.currentDir, ".env", `HOST=127.0.0.1\nPORT=${server.address().port}\n`);
  return { ...f, server, paths };
}

test("health verification accepts an actual HTTP 200 response with JSON ok=true", async (t) => {
  const f = await healthServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  const result = await waitForHealth(f.currentDir, 1);

  assert.equal(result.ok, true);
  assert.deepEqual(f.paths, ["/api/health"]);
});

for (const responseCase of [
  { label: "HTTP 200 with ok=false", status: 200, body: { ok: false } },
  { label: "HTTP 503 with ok=true", status: 503, body: { ok: true } }
]) {
  test(`health verification rejects ${responseCase.label}`, async (t) => {
    const f = await healthServer(t, (_request, response) => {
      response.writeHead(responseCase.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(responseCase.body));
    });

    await assert.rejects(waitForHealth(f.currentDir, 0.1), /health|timeout|ok=true/i);

    assert.ok(f.paths.length > 0, "the local HTTP endpoint was actually checked");
  });
}

test("health verification has a bounded timeout when the HTTP server never responds", async (t) => {
  const f = await healthServer(t, () => {});
  const start = performance.now();

  await assert.rejects(waitForHealth(f.currentDir, 0.1), /health|timeout|ok=true/i);

  assert.ok(performance.now() - start < 1500, "the stalled request is cancelled within a bounded period");
  assert.ok(f.paths.length > 0);
});

test("continuous response bytes cannot extend the health verification deadline", async (t) => {
  const timers = new Set();
  const f = await healthServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{");
    const timer = setInterval(() => response.write(" "), 10);
    timers.add(timer);
    response.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  t.after(() => { for (const timer of timers) clearInterval(timer); });
  const health = waitForHealth(f.currentDir, 0.1).then(
    () => "unexpected success",
    () => "timed out"
  );
  let guard;
  const result = await Promise.race([
    health,
    new Promise(resolve => { guard = setTimeout(() => resolve("deadline exceeded"), 1000); })
  ]);
  clearTimeout(guard);
  // Cleanup before asserting so a regressed deadline cannot leave a live HTTP
  // stream (or an unhandled rejection) running after the failed assertion.
  f.server.closeAllConnections();
  await health;

  assert.equal(result, "timed out", "inactivity timeouts alone do not enforce a total request deadline");
});
