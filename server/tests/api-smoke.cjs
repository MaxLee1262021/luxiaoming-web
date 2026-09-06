"use strict";

// Project Hub v1 API contract smoke.  The harness owns its temporary fixture and
// never reads the repository's demo/customer data.  It intentionally uses only
// Node built-ins so it can run on a clean deployment host.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_START_TIMEOUT_MS = 7000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1200;
const DEFAULT_PROBE_TIMEOUT_MS = 3500;

const COLLECTION_KEYS = [
  "cities", "agents", "distributors", "shops", "staff", "spots", "series",
  "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary",
  "guides", "stories", "scans", "orders", "afterSales", "reconciliationTransfers",
  "financeSettings", "monthlyClosings", "adjustmentRecords", "homeConfig", "logs", "trash",
  "merchantCodes", "siteConfig", "userProfiles"
];

// Representative route permissions.  The matrix deliberately checks both a
// positive and negative path for every supported administrator role.
const ROLE_MATRIX = Object.freeze({
  super: {
    allow: ["/api/collection/staff", "/api/collection/orders"],
    deny: [],
  },
  service: {
    allow: ["/api/collection/orders"],
    deny: [{ path: "/api/collection/staff", method: "POST", body: {} }],
  },
  finance: {
    allow: ["/api/collection/financeSettings"],
    deny: [{ path: "/api/collection/staff", method: "POST", body: {} }],
  },
  photo: {
    allow: ["/api/collection/orders"],
    deny: [{ path: "/api/collection/staff", method: "POST", body: {} }],
    scope: { ownField: "photographerId", ownValue: "smoke-photo", ownOrder: "smoke-order-photo" },
  },
  merchant: {
    allow: ["/api/collection/merchantCodes", "/api/collection/orders"],
    deny: [{ path: "/api/collection/staff", method: "POST", body: {} }],
    scope: { ownField: "shopId", ownValue: "smoke-shop", ownOrder: "smoke-order-shop" },
  },
  distributor: {
    allow: ["/api/collection/shops", "/api/collection/orders"],
    deny: [{ path: "/api/collection/staff", method: "POST", body: {} }],
    scope: { ownField: "distributorId", ownValue: "smoke-distributor", ownOrder: "smoke-order-distributor" },
  },
  content: {
    allow: ["/api/collection/albums"],
    deny: ["/api/collection/orders"],
  },
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `lxm1$${salt}$${hash}`;
}

function randomPort() {
  // Avoid privileged ports and the two documented project ports.
  return 5300 + crypto.randomInt(0, 1200);
}

function safeChildEnv(overrides = {}) {
  // Do not copy the caller's complete environment: it may contain production
  // credentials.  These are the only process settings needed by Node on the
  // supported local hosts.
  const env = {};
  for (const key of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "NODE_PATH", "LANG", "LC_ALL",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.NODE_ENV = "test";
  env.NO_COLOR = "1";
  Object.assign(env, overrides);
  // Explicitly remove any accidentally supplied sensitive values.
  for (const key of [
    "ADMIN_PASSWORD", "DB_PASSWORD", "CLOUDBASE_SECRET_ID", "CLOUDBASE_SECRET_KEY",
    "REDIS_PASSWORD", "REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_DB",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) delete env[key];
  }
  return env;
}

function makeFixture() {
  // Every password is generated at runtime and only its salted hash is written
  // to the temporary JSON file.  No customer records or real credentials exist.
  const collections = Object.fromEntries(COLLECTION_KEYS.map((key) => [key, {}]));
  const accounts = {};
  const suffix = crypto.randomBytes(4).toString("hex");

  collections.cities["smoke-city"] = {
    id: "smoke-city", name: "Smoke City", code: "smoke", status: "启用",
  };

  for (const role of Object.keys(ROLE_MATRIX)) {
    if (role === "merchant") continue;
    const id = role === "photo" ? "smoke-photo" : role === "distributor" ? "smoke-distributor" : `smoke-${role}`;
    const account = `smoke_${role}_${suffix}`;
    const password = `S${crypto.randomBytes(12).toString("hex")}9`;
    accounts[role] = { account, password, role, staffId: id };
    collections.staff[id] = {
      id,
      name: `Smoke ${role}`,
      account,
      password: hashPassword(password),
      role,
      status: "启用",
      city: "Smoke City",
      cityId: "smoke-city",
      distributorId: role === "distributor" ? "smoke-distributor" : "",
      permissions: role === "super" ? ["*"] : ["view"],
    };
  }

  const merchantPassword = `S${crypto.randomBytes(12).toString("hex")}9`;
  const merchantAccount = `smoke_merchant_${suffix}`;
  accounts.merchant = {
    account: merchantAccount,
    password: merchantPassword,
    role: "merchant",
    staffId: "smoke-shop",
  };
  collections.shops["smoke-shop"] = {
    id: "smoke-shop",
    shopId: "smoke-shop",
    name: "Smoke Shop",
    account: merchantAccount,
    password: hashPassword(merchantPassword),
    status: "合作中",
    city: "Smoke City",
    cityId: "smoke-city",
  };
  collections.shops["smoke-shop-other"] = {
    id: "smoke-shop-other",
    shopId: "smoke-shop-other",
    name: "Smoke Other Shop",
    status: "合作中",
    city: "Smoke City",
    cityId: "smoke-city",
  };

  // Synthetic rows make row-level scope assertions meaningful without storing
  // names, phone numbers, addresses, or any other customer data.
  collections.orders["smoke-order-shop"] = {
    id: "smoke-order-shop", shopId: "smoke-shop", distributorId: "smoke-distributor",
    photographerId: "smoke-photo", status: "new", totalPrice: 100,
  };
  collections.orders["smoke-order-distributor"] = {
    id: "smoke-order-distributor", shopId: "smoke-shop-other", distributorId: "smoke-distributor",
    photographerId: "smoke-photo-other", status: "new", totalPrice: 200,
  };
  collections.orders["smoke-order-photo"] = {
    id: "smoke-order-photo", shopId: "smoke-shop-other", distributorId: "smoke-distributor-other",
    photographerId: "smoke-photo", status: "shooting", totalPrice: 300,
  };
  collections.orders["smoke-order-other"] = {
    id: "smoke-order-other", shopId: "smoke-shop-other", distributorId: "smoke-distributor-other",
    photographerId: "smoke-photo-other", status: "new", totalPrice: 400,
  };
  collections.merchantCodes["smoke-code"] = {
    id: "smoke-code", _id: "smoke-code", shopId: "smoke-shop", placementLabel: "Smoke Counter",
    status: "active", scanCount: 0,
  };
  collections.financeSettings["smoke-finance"] = { id: "smoke-finance", currency: "CNY" };
  collections.siteConfig["customPrice"] = { id: "customPrice", baseHours: 1, singlePersonPrice: 200, perExtraPerson: 100 };
  collections.siteConfig["bookingNotice"] = { id: "bookingNotice", 0: "Synthetic notice" };
  collections.albums["smoke-album"] = { id: "smoke-album", name: "Smoke Album", status: "已上架" };
  collections.packages["smoke-package"] = { id: "smoke-package", name: "Smoke Package", status: "已上架", price: 100 };
  collections.spots["smoke-spot"] = { id: "smoke-spot", name: "Smoke Spot", status: "启用" };

  return { db: { collections }, accounts };
}

function createTempFixture(root) {
  // selectSource rejects DB_FILE paths outside the project root.  Keep the
  // temporary directory under ignored server/data/ and remove it in finally.
  const fixtureRoot = root ? path.join(root, "server", "data") : os.tmpdir();
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtureRoot, ".project-hub-10522-"));
  const file = path.join(dir, "db.json");
  const envFile = path.join(dir, ".env");
  const fixture = makeFixture();
  fs.writeFileSync(file, JSON.stringify(fixture.db, null, 2), { encoding: "utf8", mode: 0o600 });
  // Prevent dotenv in the child server from reading a developer's real .env.
  fs.writeFileSync(envFile, "# isolated smoke environment\n", { encoding: "utf8", mode: 0o600 });
  return { ...fixture, dir, file, envFile };
}

function assertSyntheticFixtureSafe(fixture) {
  const serialized = fs.readFileSync(fixture.file, "utf8");
  for (const account of Object.values(fixture.accounts)) {
    assert.equal(serialized.includes(account.password), false, "temporary fixture must not persist plaintext passwords");
  }
  assert.equal(/customer|openid|phone|wechat/i.test(serialized), false, "temporary fixture must not contain customer fields");
}

function sanitizeDiagnostic(value) {
  return String(value || "")
    .replace(/lxm1\$[A-Za-z0-9$]+/g, "[redacted-hash]")
    .replace(/(password|secret|token|authorization|redis_url|db_password)[^\s,;]*/gi, "$1=[redacted]")
    .slice(0, 240);
}

function expectedConfigFailure(server, label) {
  const output = server && typeof server.getOutput === "function" ? server.getOutput() : {};
  const text = `${output.stdout || ""}\n${output.stderr || ""}`.toLowerCase();
  const expected = label.toLowerCase().includes("redis")
    ? /(redis|认证存储|auth.?store|unavailable|未配置|不可用|依赖)/i.test(text)
    : /(mysql|数据源|database|driver|config|配置|unavailable|不可用)/i.test(text);
  const unrelated = /(cannot find module .*api\.cjs|syntaxerror|cannot find module 'dotenv')/i.test(text);
  return expected && !unrelated;
}

async function requestJson(baseUrl, requestPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  try {
    const response = await fetch(new URL(requestPath, baseUrl), {
      method: options.method || "GET",
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    return { status: response.status, body: parsed, text };
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function responseRows(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.rows)) return body.rows;
  return [];
}

function assertNoPasswordFields(value, label) {
  const seen = new Set();
  function walk(node, location) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      assert.equal(/password/i.test(key), false, `${label} contains a password field at ${location}.${key}`);
      walk(child, `${location}.${key}`);
    }
  }
  walk(value, label);
}

function assertNoSensitiveFields(value, label) {
  const seen = new Set();
  const sensitive = /^(?:password(?:Hash)?|secret(?:Id|Key)?|authorization|token)$/i;
  function walk(node, location) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      assert.equal(sensitive.test(key), false, `${label} contains a sensitive field at ${location}.${key}`);
      walk(child, `${location}.${key}`);
    }
  }
  walk(value, label);
}

function assertHealthShape(body) {
  assert.ok(body && typeof body === "object", "health response must be an object");
  assert.equal(body.ok, true, "health response must report ok=true");
  assert.equal(typeof body.mode, "string", "health response must include mode");
  assert.ok(body.auth && typeof body.auth === "object", "health response must include auth");
  assert.equal(typeof body.auth.required, "boolean", "health.auth.required must be boolean");
  assert.equal(typeof body.auth.sessionStore, "string", "health.auth.sessionStore must be a string");
  assert.ok(Object.prototype.hasOwnProperty.call(body, "dataStore"), "health response must include dataStore");
  assertNoSensitiveFields(body, "health");
  for (const key of ["secret", "secretId", "secretKey", "redisUrl", "dbPassword"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, `health must not expose ${key}`);
  }
}

async function waitForHealth(baseUrl, child, timeoutMs = DEFAULT_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { ready: false, exited: true, exitCode: child.exitCode, diagnostic: sanitizeDiagnostic(lastError) };
    }
    try {
      const result = await requestJson(baseUrl, "/api/health", { timeoutMs: 350 });
      if (result.status) return { ready: true, health: result };
    } catch (error) {
      lastError = error && error.message;
    }
    await delay(80);
  }
  return { ready: false, timedOut: true, diagnostic: sanitizeDiagnostic(lastError) };
}

function spawnServer(root, fixtureFile, options = {}) {
  const port = options.port || randomPort();
  const localNodeModules = path.resolve(__dirname, "..", "..", "node_modules");
  const env = safeChildEnv({
    PORT: String(port),
    DATA_MODE: options.dataMode || "json",
    DB_FILE: fixtureFile,
    DOTENV_CONFIG_PATH: options.dotenvPath || path.join(path.dirname(fixtureFile), ".env"),
    SESSION_STORE: options.sessionStore || "memory",
    AUTH_REQUIRED: "true",
    ...(fs.existsSync(localNodeModules) ? { NODE_PATH: localNodeModules } : {}),
    ...(options.env || {}),
  });
  const entry = path.join(root, "server", "index.cjs");
  const child = spawn(process.execPath, [entry], {
    // Keep dotenv scoped to the isolated fixture directory.  The server uses
    // __dirname for all project paths, so changing cwd does not affect routing.
    cwd: path.dirname(fixtureFile),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-4096); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const baseUrl = `http://127.0.0.1:${port}/`;
  return { child, baseUrl, env, getOutput: () => ({ stdout, stderr }) };
}

async function stopServer(server) {
  if (!server || !server.child || server.child.exitCode !== null) return;
  const child = server.child;
  child.kill("SIGTERM");
  const deadline = Date.now() + 1200;
  while (child.exitCode === null && Date.now() < deadline) await delay(30);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startServer(root, fixtureFile, options = {}) {
  const server = spawnServer(root, fixtureFile, options);
  const status = await waitForHealth(server.baseUrl, server.child, options.timeoutMs || DEFAULT_START_TIMEOUT_MS);
  return { ...server, ...status };
}

function addPass(report, name, detail = "") {
  report.passed.push({ name, detail });
}

function addSkip(report, name, detail = "") {
  report.skipped.push({ name, detail });
}

function addFailure(report, name, error) {
  report.failures.push({ name, detail: sanitizeDiagnostic(error && error.message ? error.message : error) });
}

async function check(report, name, fn) {
  try {
    await fn();
    addPass(report, name);
    return true;
  } catch (error) {
    addFailure(report, name, error);
    return false;
  }
}

async function checkOptional(report, name, fn) {
  try {
    const result = await fn();
    if (result && result.skip) addSkip(report, name, result.reason);
    else addPass(report, name);
    return result;
  } catch (error) {
    addFailure(report, name, error);
    return null;
  }
}

async function login(baseUrl, account) {
  const result = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { account: account.account, password: account.password },
  });
  assert.equal(result.status, 200, "login must return HTTP 200");
  assert.ok(result.body && result.body.ok === true, "login must return ok=true");
  assert.equal(typeof result.body.token, "string", "login must return a token");
  assert.ok(result.body.token.length > 10, "login token must be non-empty");
  assert.equal(result.body.role, account.role, "login role must match fixture role");
  assert.equal(result.body.account, account.account, "login account must match fixture account");
  assert.equal(typeof result.body.staffId, "string", "login must return staffId");
  assertNoPasswordFields(result.body, "login");
  return result.body.token;
}

async function runRoleMatrix(report, baseUrl, fixture) {
  for (const [role, matrix] of Object.entries(ROLE_MATRIX)) {
    const account = fixture.accounts[role];
    let token = null;
    const loggedIn = await check(report, `role ${role}: login contract`, async () => {
      token = await login(baseUrl, account);
    });
    if (!loggedIn) {
      addSkip(report, `role ${role}: permission matrix`, "login failed; route assertions skipped");
      continue;
    }

    for (const route of matrix.allow) {
      await check(report, `role ${role}: allow ${route}`, async () => {
        const result = await requestJson(baseUrl, route, { headers: authHeaders(token) });
        assert.equal(result.status, 200, "allowed management route must return 200");
        if (route === "/api/collection/orders" && matrix.scope) {
          const rows = responseRows(result.body);
          const ids = rows.map((row) => row && (row.id || row._id)).filter(Boolean);
          assert.ok(ids.includes(matrix.scope.ownOrder), "scoped role must receive its own row");
          assert.equal(ids.includes("smoke-order-other"), false, "scoped role must not receive another role's row");
          const ownField = matrix.scope.ownField;
          for (const row of rows) assert.equal(row[ownField], matrix.scope.ownValue, "scoped rows must match role scope");
        }
      });
    }
    for (const route of matrix.deny) {
      const spec = typeof route === "string" ? { path: route } : route;
      await check(report, `role ${role}: deny ${spec.method || "GET"} ${spec.path}`, async () => {
        const result = await requestJson(baseUrl, spec.path, {
          method: spec.method || "GET",
          body: spec.body,
          headers: authHeaders(token),
        });
        assert.equal(result.status, 403, "forbidden management route must return 403");
      });
    }
  }
}

async function runConfigProbe(report, root, fixtureFile, label, env, options = {}) {
  const server = await startServer(root, fixtureFile, {
    dataMode: options.dataMode || "json",
    sessionStore: options.sessionStore || "memory",
    env,
    timeoutMs: options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS,
  });
  try {
    if (!server.ready) {
      if (server.exited) {
        // A non-zero startup exit is an acceptable fail-closed outcome.
        if (server.exitCode && server.exitCode !== 0 && expectedConfigFailure(server, label)) {
          addPass(report, `${label}: fail-closed startup`);
          return;
        }
        addFailure(report, `${label}: fail-closed startup`, new Error("process exited without a fail-closed error"));
        return;
      }
      addFailure(report, `${label}: fail-closed startup`, new Error("process did not fail closed before timeout"));
      return;
    }
    const health = server.health || await requestJson(server.baseUrl, "/api/health");
    if (options.expectedMode && health.body && health.body.mode !== options.expectedMode) {
      addFailure(report, `${label}: no silent fallback`, new Error(`health mode changed from ${options.expectedMode}`));
      return;
    }
    if (options.expectedSessionStore && health.body && health.body.auth
      && health.body.auth.sessionStore !== options.expectedSessionStore) {
      addFailure(report, `${label}: no silent fallback`, new Error(`session store changed from ${options.expectedSessionStore}`));
      return;
    }
    const healthy = health.status === 200 && health.body && health.body.ok === true;
    const dataStore = health.body && health.body.dataStore;
    const dataHealthy = dataStore && typeof dataStore === "object"
      ? (dataStore.ok !== false && dataStore.status !== "error" && dataStore.status !== "unhealthy")
      : healthy;
    if (healthy && dataHealthy) {
      addFailure(report, `${label}: fail-closed health`, new Error("backend reports healthy despite unavailable configuration"));
      return;
    }
    addPass(report, `${label}: fail-closed health`);
  } finally {
    await stopServer(server);
  }
}

async function runSmoke(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, "..", ".."));
  const report = { passed: [], skipped: [], failures: [], root };
  const fixture = createTempFixture(root);
  let server = null;
  try {
    await check(report, "synthetic fixture contains no plaintext/customer data", async () => {
      assertSyntheticFixtureSafe(fixture);
    });
    server = await startServer(root, fixture.file, { sessionStore: "memory" });
    if (!server.ready) {
      addFailure(report, "server startup", new Error("local JSON server did not become healthy"));
    } else {

    await check(report, "health contract", async () => {
      const result = server.health || await requestJson(server.baseUrl, "/api/health");
      assert.equal(result.status, 200, "health must return HTTP 200");
      assertHealthShape(result.body);
      assert.equal(result.body.auth.sessionStore, "memory", "local smoke must use memory sessions");
    });

    for (const route of ["/api/dashboard", "/api/collection/orders", "/api/collection/staff", "/api/collection/shops"]) {
      await check(report, `unauthenticated ${route} rejected`, async () => {
        const result = await requestJson(server.baseUrl, route);
        assert.equal(result.status, 401, "management route without Bearer must return 401");
      });
    }

    await check(report, "public browsing RPC remains anonymous", async () => {
      const result = await requestJson(server.baseUrl, "/api/rpc/getHomeData", { method: "POST", body: {} });
      assert.equal([401, 403].includes(result.status), false, "public browsing RPC must not require admin auth");
      assert.ok(result.status >= 200 && result.status < 500, "public browsing RPC must return a handled response");
    });
    await check(report, "guide RPC aliases remain compatible", async () => {
      const result = await requestJson(server.baseUrl, "/api/rpc/listGuides", { method: "POST", body: { data: {} } });
      assert.equal(result.status, 200);
      assert.equal(result.body && result.body.success, true);
      const guide = responseRows(result.body)[0];
      if (guide && (guide.id || guide._id)) {
        const detail = await requestJson(server.baseUrl, "/api/rpc/getGuide", { method: "POST", body: { data: { id: guide.id || guide._id } } });
        assert.equal(detail.status, 200);
        assert.equal(detail.body && detail.body.success, true);
      }
    });
    let publicToken = null;
    await check(report, "public RPC login remains anonymous", async () => {
      const result = await requestJson(server.baseUrl, "/api/rpc/login", { method: "POST", body: {} });
      assert.equal([401, 403].includes(result.status), false, "public RPC login must not require admin auth");
      assert.equal(result.body && result.body.success, true, "local non-production smoke must issue a public session");
      assert.equal(typeof result.body.token, "string", "public login must return a session token");
      publicToken = result.body.token;
    });
    for (const name of ["getMyOrders", "createBooking"]) {
      await check(report, `order RPC ${name} rejects missing主体`, async () => {
        const result = await requestJson(server.baseUrl, `/api/rpc/${name}`, { method: "POST", body: {} });
        const succeeded = result.status >= 200 && result.status < 300 && result.body && result.body.success === true;
        assert.equal(succeeded, false, "order RPC must not succeed without a verified主体");
      });
    }

    await check(report, "invalid admin password rejected", async () => {
      const account = fixture.accounts.super;
      const result = await requestJson(server.baseUrl, "/api/auth/login", {
        method: "POST",
        body: { account: account.account, password: `wrong-${crypto.randomBytes(8).toString("hex")}` },
      });
      assert.equal(result.status, 401, "invalid password must return 401");
      assertNoPasswordFields(result.body, "invalid login");
    });

    await runRoleMatrix(report, server.baseUrl, fixture);

    const superToken = await (async () => {
      try { return await login(server.baseUrl, fixture.accounts.super); } catch { return null; }
    })();
    if (superToken) {
      let activeSuperToken = superToken;
      await check(report, "staff response does not expose password", async () => {
        const result = await requestJson(server.baseUrl, "/api/collection/staff", { headers: authHeaders(superToken) });
        assert.equal(result.status, 200);
        assertNoPasswordFields(result.body, "staff collection");
      });
      await check(report, "shop response does not expose password", async () => {
        const result = await requestJson(server.baseUrl, "/api/collection/shops", { headers: authHeaders(superToken) });
        assert.equal(result.status, 200);
        assertNoPasswordFields(result.body, "shop collection");
      });
      await check(report, "legacy site config fragments read as canonical document", async () => {
        const result = await requestJson(server.baseUrl, "/api/collection/siteConfig/global", { headers: authHeaders(superToken) });
        assert.equal(result.status, 200);
        assert.equal(result.body && result.body.id, "global");
        assert.equal(result.body && result.body.customPrice && result.body.customPrice.singlePersonPrice, 200);
        const doc = await requestJson(server.baseUrl, "/api/doc/siteConfig/global", { headers: authHeaders(superToken) });
        assert.equal(doc.status, 200);
        assert.equal(doc.body && doc.body.customPrice && doc.body.customPrice.singlePersonPrice, 200);
      });

      await check(report, "order action persists timeline", async () => {
        const result = await requestJson(server.baseUrl, "/api/orders/smoke-order-shop/action", {
          method: "POST",
          headers: authHeaders(superToken),
          body: { action: "note", reason: "synthetic persistence check" },
        });
        assert.equal(result.status, 200, "authorized order action must succeed");
        const detail = await requestJson(server.baseUrl, "/api/collection/orders/smoke-order-shop", { headers: authHeaders(superToken) });
        assert.equal(detail.status, 200);
        assert.ok((detail.body.statusLogs || []).some((row) => String(row.action || "").includes("synthetic persistence check")), "timeline must contain the action reason");
      });

      await check(report, "public booking records verified identity and source code", async () => {
        assert.ok(publicToken, "public login token is required");
        const result = await requestJson(server.baseUrl, "/api/rpc/createBooking", {
          method: "POST",
          headers: authHeaders(publicToken),
          body: {
            data: {
              name: "Synthetic User",
              phone: "13800000000",
              date: "2099-01-01",
              time: "10:00",
              codeId: "smoke-code",
              items: [{ packageId: "smoke-package", price: 9999 }],
              totalPrice: 9999,
            },
          },
        });
        assert.equal(result.status, 200);
        assert.equal(result.body && result.body.success, true, "verified public booking must succeed");
        const orders = await requestJson(server.baseUrl, "/api/collection/orders", { headers: authHeaders(superToken) });
        const created = responseRows(orders.body).find((row) => row && (row.id === result.body.orderId || row._id === result.body.orderId));
        assert.ok(created, "created booking must be readable by admin");
        assert.equal(created.openid, "dev_openid", "booking identity must come from the verified public session");
        assert.equal(created.sourceCodeId, "smoke-code", "source code must be persisted for attribution");
        assert.equal(created.source && created.source.codeId, "smoke-code", "nested source code must be persisted");
        assert.equal(created.totalPrice, 100, "booking total must be calculated from the server product price");
        return result.body.orderId;
      });

      await check(report, "public after-sale creates an independent ticket", async () => {
        const orders = await requestJson(server.baseUrl, "/api/collection/orders", { headers: authHeaders(superToken) });
        const created = responseRows(orders.body).find((row) => row && row.openid === "dev_openid" && row.sourceCodeId === "smoke-code");
        assert.ok(created, "booking fixture must exist before after-sale probe");
        const result = await requestJson(server.baseUrl, "/api/rpc/submitAfterSale", {
          method: "POST",
          headers: authHeaders(publicToken),
          body: { data: { orderId: created.id || created._id, reason: "synthetic after-sale reason" } },
        });
        assert.equal(result.status, 200);
        assert.equal(result.body && result.body.success, true, "after-sale submission must succeed");
        const tickets = await requestJson(server.baseUrl, "/api/collection/afterSales", { headers: authHeaders(superToken) });
        assert.ok(responseRows(tickets.body).some((row) => row && (row.id === result.body.data.ticketId || row._id === result.body.data.ticketId)), "after-sale ticket must be persisted separately");
      });

      const marker = `smoke-${crypto.randomBytes(10).toString("hex")}`;
      const persistId = `smoke-persist-${crypto.randomBytes(6).toString("hex")}`;
      await check(report, "JSON write accepted for persistence probe", async () => {
        const result = await requestJson(server.baseUrl, "/api/collection/siteConfig", {
          method: "POST",
          headers: authHeaders(superToken),
          body: { id: persistId, marker },
        });
        assert.ok([200, 201].includes(result.status), "synthetic config write must succeed");
      });

      await stopServer(server);
      server = await startServer(root, fixture.file, { sessionStore: "memory" });
      await check(report, "JSON data persists across server refresh", async () => {
        assert.equal(server.ready, true, "server must restart with the same JSON file");
        // Memory sessions are intentionally process-local; obtain a fresh token
        // after restart before reading the persisted marker.
        activeSuperToken = await login(server.baseUrl, fixture.accounts.super);
        const result = await requestJson(server.baseUrl, "/api/collection/siteConfig", { headers: authHeaders(activeSuperToken) });
        assert.equal(result.status, 200);
        const rows = responseRows(result.body);
        assert.ok(rows.some((row) => row && row.marker === marker), "persisted marker must be readable after restart");
      });

      await checkOptional(report, "auth/me contract (optional endpoint)", async () => {
        const result = await requestJson(server.baseUrl, "/api/auth/me", { headers: authHeaders(activeSuperToken) });
        if ([404, 405].includes(result.status)) return { skip: true, reason: "endpoint not implemented" };
        assert.equal(result.status, 200, "auth/me must return 200 when implemented");
        assert.equal(result.body && result.body.role, "super");
        assertNoPasswordFields(result.body, "auth/me");
        return { token: activeSuperToken };
      });
      await checkOptional(report, "auth/logout invalidates session (optional endpoint)", async () => {
        const result = await requestJson(server.baseUrl, "/api/auth/logout", {
          method: "POST", headers: authHeaders(activeSuperToken), body: {},
        });
        if ([404, 405].includes(result.status)) return { skip: true, reason: "endpoint not implemented" };
        assert.ok([200, 204].includes(result.status), "auth/logout must succeed when implemented");
        const after = await requestJson(server.baseUrl, "/api/collection/orders", { headers: authHeaders(activeSuperToken) });
        assert.equal(after.status, 401, "logged-out token must not access management routes");
        return { token: activeSuperToken };
      });
    } else {
      addSkip(report, "password redaction and JSON persistence", "super login failed");
    }
    }
  } finally {
    await stopServer(server);
    try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }

  // These probes are intentionally separate child processes so a config module
  // cannot inherit a healthy in-memory connection from the main smoke server.
  const probeFixture = createTempFixture(root);
  try {
    await runConfigProbe(report, root, probeFixture.file, "Redis missing configuration", {
      SESSION_STORE: "redis",
    }, { sessionStore: "redis", expectedSessionStore: "redis" });
    await runConfigProbe(report, root, probeFixture.file, "Redis unavailable connection", {
      SESSION_STORE: "redis",
      REDIS_URL: "redis://127.0.0.1:1/0",
      REDIS_CONNECT_TIMEOUT_MS: "250",
      REDIS_MAX_RETRIES: "0",
    }, { sessionStore: "redis", expectedSessionStore: "redis" });
    await runConfigProbe(report, root, probeFixture.file, "Redis host configuration unavailable", {
      SESSION_STORE: "redis",
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: "1",
      REDIS_DB: "0",
      REDIS_CONNECT_TIMEOUT_MS: "250",
      REDIS_MAX_RETRIES: "0",
    }, { sessionStore: "redis", expectedSessionStore: "redis" });
    await runConfigProbe(report, root, probeFixture.file, "MySQL missing configuration", {
      DATA_MODE: "mysql",
      DB_HOST: "",
      DB_USER: "",
      DB_PASSWORD: "",
      DB_NAME: "",
    }, { dataMode: "mysql", expectedMode: "mysql" });
  } finally {
    try { fs.rmSync(probeFixture.dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
  return report;
}

module.exports = {
  ROLE_MATRIX,
  runSmoke,
  makeFixture,
  assertHealthShape,
};
