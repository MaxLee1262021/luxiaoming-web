"use strict";

// Backend API contract smoke.  The harness owns its temporary fixture and
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
      permissions: role === "super" ? ["*"] : role === "service" ? ["view", "orderEdit", "assign", "cancelOrder"]
        : role === "finance" ? ["view", "financeReview"] : role === "photo" ? ["view", "shootUpdate"]
          : role === "content" ? ["view", "contentEdit"] : ["view", "dashboard", "export"],
      credentials: { password: hashPassword(`nested-${password}`), token: "nested-token" },
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
    credentials: { password: hashPassword(`nested-${merchantPassword}`) },
    status: "合作中",
    city: "Smoke City",
    cityId: "smoke-city",
    distributorId: "smoke-distributor",
  };
  collections.shops["smoke-shop-other"] = {
    id: "smoke-shop-other",
    shopId: "smoke-shop-other",
    name: "Smoke Other Shop",
    status: "合作中",
    city: "Smoke City",
    cityId: "smoke-city",
  };
  collections.shops["smoke-settlement-shop"] = {
    id: "smoke-settlement-shop", shopId: "smoke-settlement-shop", name: "Smoke Settlement Shop",
    status: "合作中", city: "Smoke City", cityId: "smoke-city", commissionRate: 10,
  };

  const distributorOnlyPassword = `S${crypto.randomBytes(12).toString("hex")}9`;
  accounts.distributorOnly = {
    account: `smoke_distributor_only_${suffix}`,
    password: distributorOnlyPassword,
    role: "distributor",
    staffId: "smoke-distributor-only",
  };
  collections.distributors["smoke-distributor-only"] = {
    id: "smoke-distributor-only", name: "Smoke Distributor Only", account: accounts.distributorOnly.account,
    password: hashPassword(distributorOnlyPassword), status: "启用", distributorId: "smoke-distributor-only",
  };
  const distributorAliasPassword = `S${crypto.randomBytes(12).toString("hex")}9`;
  accounts.distributorAlias = {
    account: `smoke_distributor_alias_${suffix}`,
    password: distributorAliasPassword,
    role: "distributor",
    staffId: "smoke-distributor-account",
  };
  collections.staff["smoke-distributor-account"] = {
    id: "smoke-distributor-account", name: "Smoke Distributor Account", account: accounts.distributorAlias.account,
    password: hashPassword(distributorAliasPassword), role: "distributor", status: "启用", distributorId: "smoke-distributor",
  };
  const agentOnlyPassword = `S${crypto.randomBytes(12).toString("hex")}9`;
  accounts.agentOnly = {
    account: `smoke_agent_only_${suffix}`,
    password: agentOnlyPassword,
    role: "agent",
    staffId: "smoke-agent-only",
  };
  collections.agents["smoke-agent-only"] = {
    id: "smoke-agent-only", name: "Smoke Agent Only", account: accounts.agentOnly.account,
    password: hashPassword(agentOnlyPassword), status: "启用", agentId: "smoke-agent-only",
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
  collections.orders["smoke-order-completed"] = {
    id: "smoke-order-completed", shopId: "smoke-shop", distributorId: "smoke-distributor",
    photographerId: "smoke-photo", status: "completed", customerStatus: "已完成", totalPrice: 100,
  };
  collections.orders["smoke-order-deleted"] = {
    id: "smoke-order-deleted", orderNo: "SMOKE-DELETED", status: "cancelled", customerStatus: "已取消",
    isDeleted: true, deleted: true, totalPrice: 100,
  };
  collections.orders["smoke-order-settlement"] = {
    id: "smoke-order-settlement", orderNo: "SMOKE-SETTLE", shopId: "smoke-settlement-shop",
    status: "completed", customerStatus: "已完成", totalAmount: 100, depositPaid: 40, finalPaid: 60,
    depositFinanceStatus: "已审", finalFinanceStatus: "已审",
  };
  collections.orders["smoke-order-recent"] = {
    id: "smoke-order-recent", orderNo: "SMOKE-RECENT", shopId: "smoke-settlement-shop",
    status: "completed", totalAmount: 100, depositPaid: 40, finalPaid: 60,
    depositFinanceStatus: "已审", finalFinanceStatus: "已审", completedAt: new Date().toISOString(),
  };
  collections.merchantCodes["smoke-code"] = {
    id: "smoke-code", _id: "smoke-code", shopId: "smoke-shop", placementLabel: "Smoke Counter",
    status: "active", distributorId: "smoke-distributor", scanCount: 0,
  };
  collections.merchantCodes["smoke-code-disabled"] = {
    id: "smoke-code-disabled", _id: "smoke-code-disabled", shopId: "smoke-shop", placementLabel: "Disabled Counter",
    status: "disabled", scanCount: 0,
  };
  collections.scans["smoke-scan"] = { id: "smoke-scan", shopId: "smoke-shop", distributorId: "smoke-distributor", status: "active" };
  collections.financeSettings["smoke-finance"] = { id: "smoke-finance", currency: "CNY" };
  collections.financeSettings["global"] = { id: "global", settlementObservationDays: 3, largeSettlementThreshold: 5000 };
  collections.siteConfig["customPrice"] = { id: "customPrice", baseHours: 1, singlePersonPrice: 200, perExtraPerson: 100 };
  collections.siteConfig["bookingNotice"] = { id: "bookingNotice", 0: "Synthetic notice" };
  collections.siteConfig["global"] = {
    id: "global",
    customPrice: { singlePersonPrice: 200, perExtraPerson: 100 },
    privacyPolicy: {
      title: "Synthetic Privacy", content: "Synthetic legal text",
      sections: [{ title: "Public section", content: "Public body", secretToken: "synthetic-privacy-secret" }],
    },
  };
  collections.homeConfig["homeStats"] = {
    id: "homeStats", activityNotice: "Synthetic public notice", internalSecret: "synthetic-home-secret",
    privateUrl: "https://private.invalid/home", auditNote: "synthetic-home-audit",
  };
  collections.albums["smoke-album"] = { id: "smoke-album", name: "Smoke Album", status: "已上架" };
  collections.packages["smoke-package"] = { id: "smoke-package", name: "Smoke Package", status: "已上架", price: 100 };
  collections.packages["smoke-package-conflict"] = { id: "smoke-package-conflict", name: "Smoke Conflict Package", status: "已上架", price: 80, conflictPackageIds: ["smoke-package"] };
  collections.packages["smoke-package-disabled"] = { id: "smoke-package-disabled", name: "Hidden Package", status: "已下架", price: 999 };
  collections.spots["smoke-spot"] = { id: "smoke-spot", name: "Smoke Spot", status: "启用" };
  collections.spots["smoke-spot-disabled"] = { id: "smoke-spot-disabled", name: "Hidden Spot", status: "已下架" };
  collections.guides["smoke-guide-hidden"] = { id: "smoke-guide-hidden", title: "Hidden Guide", status: "草稿", isShow: true };
  collections.samples["smoke-sample-hidden"] = { id: "smoke-sample-hidden", seriesId: "smoke-series", type: "image", status: "草稿", isShow: true };

  return { db: { collections }, accounts };
}

function createTempFixture(root) {
  // selectSource rejects DB_FILE paths outside the project root.  Keep the
  // temporary directory under ignored server/data/ and remove it in finally.
  const fixtureRoot = root ? path.join(root, "server", "data") : os.tmpdir();
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtureRoot, ".api-smoke-"));
  const file = path.join(dir, "db.json");
  const envFile = path.join(dir, ".env");
  const staticSentinel = path.join(dir, "static-sentinel.txt");
  const fixture = makeFixture();
  fs.writeFileSync(file, JSON.stringify(fixture.db, null, 2), { encoding: "utf8", mode: 0o600 });
  // Prevent dotenv in the child server from reading a developer's real .env.
  fs.writeFileSync(envFile, "# isolated smoke environment\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(staticSentinel, `STATIC_PRIVATE_SENTINEL_${crypto.randomBytes(8).toString("hex")}`, { encoding: "utf8", mode: 0o600 });
  return { ...fixture, dir, file, envFile, staticSentinel };
}

function assertSyntheticFixtureSafe(fixture) {
  const serialized = fs.readFileSync(fixture.file, "utf8");
  for (const account of Object.values(fixture.accounts)) {
    assert.equal(serialized.includes(account.password), false, "temporary fixture must not persist plaintext passwords");
  }
  assert.equal(/openid|phone|wechat|contactName|customerPhone|customerWechat/i.test(serialized), false, "temporary fixture must not contain customer contact fields");
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
      // Redis fail-closed health may spend up to the configured connect timeout
      // before returning 503; keep the probe from racing that response.
      const result = await requestJson(baseUrl, "/api/health", { timeoutMs: 1200 });
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
    if (options.expectedMode === "mysql") {
      const rpcResult = await requestJson(server.baseUrl, "/api/rpc/getBookingConfig", { method: "POST", body: {} });
      assert.equal(rpcResult.status, 503, "public config RPC must not fall back to defaults when MySQL is unavailable");
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
    await check(report, "synthetic fixture starts without plaintext/customer data", async () => {
      assertSyntheticFixtureSafe(fixture);
    });
    // Add contact aliases only after the fixture-safety assertion. These are
    // synthetic values used to prove role-specific redaction, never real data.
    fixture.db.collections.orders["smoke-order-redaction"] = {
      id: "smoke-order-redaction", shopId: "smoke-shop", distributorId: "smoke-distributor", photographerId: "smoke-photo", status: "new",
      phone: "13800138000", contactPhone: "13900139000", customerPhone: "13700137000",
      contactPhones: ["13600136000", "13500135000"], extraPhones: ["13400134000"],
      wechat: "wx-primary", contactWechat: "wx-contact", customerWechat: "wx-customer", extraWechats: ["wx-extra"],
      openid: "synthetic-openid", customerOpenid: "synthetic-customer-openid", internalNote: "synthetic internal", paymentRecords: [{ amount: 1 }],
      customer: { name: "Synthetic Customer", phone: "13800138000", openid: "nested-openid" },
      source: { contactPhone: "13800138000", codeId: "nested-code" }, packageSnapshot: { phone: "13800138000", internalNote: "nested-note" },
    };
    fixture.db.collections.orders["smoke-order-public"] = {
      id: "smoke-order-public", openid: "dev_openid", status: "new", customerStatus: "预约待确认",
      orderNo: "LS-SMOKE-PUBLIC", packageName: "Smoke Package", totalPrice: 100,
      phone: "13800138000", contactPhone: "13800000000", customerPhone: "13800138000",
      contactPhones: ["13800138000"], wechat: "wx-private", customerWechat: "wx-private",
      source: { codeId: "private-code", distributorId: "private-distributor" }, sourceCodeId: "private-code",
      internalNote: "private note", paymentRecords: [{ amount: 100, operator: "finance" }],
      customer: { name: "Synthetic User", phone: "13800138000", openid: "nested-openid" },
      packageSnapshot: { phone: "13800138000", internalNote: "nested-note" },
      items: [{ packageId: "smoke-package", name: "Smoke Package", price: 100, internalCost: 1 }],
      createTime: new Date().toISOString(),
    };
    fixture.db.collections.packages["smoke-package"].internalSecret = "synthetic-internal-secret";
    fixture.db.collections.packages["smoke-package"].privateUrl = "https://private.invalid/asset";
    fixture.db.collections.packages["smoke-package"].auditNote = "synthetic-audit-note";
    fixture.db.collections.packages["smoke-package"].openid = "synthetic-package-openid";
    fixture.db.collections.packages["smoke-package"].customerPhone = "13800000000";
    fixture.db.collections.packages["smoke-package"].source = { sourceCodeId: "synthetic-package-source" };
    fs.writeFileSync(fixture.file, JSON.stringify(fixture.db, null, 2), { encoding: "utf8", mode: 0o600 });

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

    await check(report, "static server denies private files", async () => {
      const relative = path.relative(root, fixture.staticSentinel).replace(/\\/g, "/");
      const result = await requestJson(server.baseUrl, `/${relative}`);
      assert.notEqual(result.status, 200, "private fixture file must not be served");
      assert.equal(result.text.includes("STATIC_PRIVATE_SENTINEL_"), false, "private fixture contents must not be exposed");
      const packageResult = await requestJson(server.baseUrl, "/package.json");
      assert.notEqual(packageResult.status, 200, "root metadata must not be served");
      const mockResult = await requestJson(server.baseUrl, "/src/mock/business-data.js");
      assert.notEqual(mockResult.status, 200, "raw demo fixture must not be served");
      const encodedMock = await requestJson(server.baseUrl, "/%73rc/%6d%6f%63%6b/business-data.js");
      assert.notEqual(encodedMock.status, 200, "encoded raw demo fixture must not be served");
      const publicData = await requestJson(server.baseUrl, "/public/public-data.js");
      assert.equal(publicData.status, 200, "public bootstrap data must remain available");
      assert.equal(/password|openid|customerPhone/i.test(publicData.text), false, "public bootstrap data must not contain credentials or customer fields");
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
      const booking = await requestJson(server.baseUrl, "/api/rpc/getBookingData", { method: "POST", body: {} });
      assert.equal(booking.status, 200);
      const bookingData = booking.body && booking.body.data || {};
      assert.equal((bookingData.allPackages || []).some((item) => item && (item.id === "smoke-package-disabled" || item._id === "smoke-package-disabled")), false, "下架套餐 must not be public");
      assert.equal((bookingData.spots || []).some((item) => item && (item.id === "smoke-spot-disabled" || item._id === "smoke-spot-disabled")), false, "下架点位 must not be public");
      const guides = await requestJson(server.baseUrl, "/api/rpc/listGuides", { method: "POST", body: { data: {} } });
      assert.equal(responseRows(guides.body).some((item) => item && (item.id === "smoke-guide-hidden" || item._id === "smoke-guide-hidden")), false, "草稿攻略 must not be public");
      const publicJson = JSON.stringify(bookingData);
      for (const raw of ["synthetic-internal-secret", "private.invalid", "synthetic-audit-note", "synthetic-package-openid", "synthetic-package-source", "13800000000"]) {
        assert.equal(publicJson.includes(raw), false, `public content must not expose ${raw}`);
      }
      const packageDetail = await requestJson(server.baseUrl, "/api/rpc/getSeriesDetail", {
        method: "POST", body: { data: { packageId: "smoke-package" } },
      });
      assert.equal(packageDetail.status, 200);
      for (const raw of ["synthetic-internal-secret", "private.invalid", "synthetic-audit-note", "synthetic-package-openid", "synthetic-package-source", "13800000000"]) {
        assert.equal(JSON.stringify(packageDetail.body || {}).includes(raw), false, `package detail must not expose ${raw}`);
      }
      const privacy = await requestJson(server.baseUrl, "/api/rpc/getPrivacyPolicy", { method: "POST", body: {} });
      assert.equal(privacy.status, 200);
      assert.equal(JSON.stringify(privacy.body || {}).includes("synthetic-privacy-secret"), false, "privacy sections must be projected");
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
    let superToken = null;
    await check(report, "public RPC login remains anonymous", async () => {
      const result = await requestJson(server.baseUrl, "/api/rpc/login", { method: "POST", body: {} });
      assert.equal([401, 403].includes(result.status), false, "public RPC login must not require admin auth");
      assert.equal(result.body && result.body.success, true, "local non-production smoke must issue a public session");
      assert.equal(typeof result.body.token, "string", "public login must return a session token");
      publicToken = result.body.token;
    });
    await check(report, "super session available for protected probes", async () => {
      superToken = await login(server.baseUrl, fixture.accounts.super);
      assert.ok(superToken);
    });
    await check(report, "public order responses use a customer-safe projection", async () => {
      assert.ok(publicToken, "public login token is required");
      const list = await requestJson(server.baseUrl, "/api/rpc/getMyOrders", {
        method: "POST", headers: authHeaders(publicToken), body: { data: {} },
      });
      assert.equal(list.status, 200);
      assert.equal(list.body && list.body.success, true);
      const row = responseRows(list.body).find((item) => item && item.orderNo === "LS-SMOKE-PUBLIC");
      assert.ok(row, "owned synthetic order must be listed");
      for (const field of ["openid", "_openid", "customerOpenid", "source", "sourceCodeId", "internalNote", "paymentRecords", "customerPhone", "customerWechat", "contactPhones"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(row, field), false, `public list must not expose ${field}`);
      }
      for (const raw of ["13800138000", "nested-openid", "nested-note", "private-code"]) assert.equal(JSON.stringify(row).includes(raw), false, `public list must not expose ${raw}`);
      const detail = await requestJson(server.baseUrl, "/api/rpc/getOrderDetail", {
        method: "POST", headers: authHeaders(publicToken), body: { data: { orderId: "smoke-order-public" } },
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.body && detail.body.success, true);
      for (const field of ["openid", "source", "internalNote", "paymentRecords", "customerPhone", "customerWechat", "contactPhones"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(detail.body.data || {}, field), false, `public detail must not expose ${field}`);
      }
      for (const raw of ["13800138000", "nested-openid", "nested-note", "private-code"]) assert.equal(JSON.stringify(detail.body.data || {}).includes(raw), false, `public detail must not expose ${raw}`);
    });
    await check(report, "public booking attribution rejects forged sources", async () => {
      assert.ok(publicToken, "public login token is required");
      const forged = await requestJson(server.baseUrl, "/api/rpc/createBooking", {
        method: "POST", headers: authHeaders(publicToken), body: { data: {
          name: "Synthetic User", phone: "13800000000", date: "2099-01-02", time: "11:00",
          codeId: "not-a-real-code", shopId: "smoke-shop-other", distributorId: "forged-distributor",
          items: [{ packageId: "smoke-package" }]
        } }
      });
      assert.equal(forged.body && forged.body.success, false, "unknown source code must be rejected");
      const disabled = await requestJson(server.baseUrl, "/api/rpc/resolveMerchantCode", {
        method: "POST", body: { data: { c: "smoke-code-disabled" } },
      });
      assert.equal(disabled.body && disabled.body.success, false, "disabled merchant code must not resolve");
      const validWithForgedFields = await requestJson(server.baseUrl, "/api/rpc/createBooking", {
        method: "POST", headers: authHeaders(publicToken), body: { data: {
          name: "Synthetic User", phone: "13800000000", date: "2099-01-03", time: "11:00",
          codeId: "smoke-code", shopId: "smoke-shop-other", distributorId: "forged-distributor",
          items: [{ packageId: "smoke-package" }]
        } }
      });
      assert.equal(validWithForgedFields.body && validWithForgedFields.body.success, true, "valid code should still allow booking");
      const orders = await requestJson(server.baseUrl, "/api/collection/orders", { headers: authHeaders(superToken) });
      const created = responseRows(orders.body).find((row) => row && row.id === validWithForgedFields.body.orderId);
      assert.ok(created, "validated booking must be persisted");
      assert.equal(created.shopId, "smoke-shop", "server must use code-owned shop");
      assert.equal(created.distributorId, "smoke-distributor", "server must ignore forged distributor");
    });
    await check(report, "public booking enforces package conflicts after product-type alias normalization", async () => {
      assert.ok(publicToken, "public login token is required");
      const result = await requestJson(server.baseUrl, "/api/rpc/createBooking", {
        method: "POST", headers: authHeaders(publicToken), body: { data: {
          name: "Synthetic User", phone: "13800000000", date: "2099-01-04", time: "11:00", codeId: "smoke-code",
          items: [
            { productId: "smoke-package", productType: "video_package" },
            { productId: "smoke-package-conflict", productType: "photo_package" },
          ],
        } },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body && result.body.success, false, "alias package types must not bypass conflict rules");
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

    await check(report, "distributor and agent collection accounts can authenticate", async () => {
      for (const key of ["distributorOnly", "agentOnly"]) {
        const token = await login(server.baseUrl, fixture.accounts[key]);
        const me = await requestJson(server.baseUrl, "/api/auth/me", { headers: authHeaders(token) });
        assert.equal(me.status, 200);
        assert.equal(me.body.role, fixture.accounts[key].role);
        assert.equal(me.body.staffId, fixture.accounts[key].staffId);
        const dashboard = await requestJson(server.baseUrl, "/api/dashboard", { headers: authHeaders(token) });
        assert.equal(dashboard.status, 200, `${fixture.accounts[key].role} dashboard must be available`);
        assert.equal(Number(dashboard.body.orders || 0), 0, "unassigned synthetic channel accounts must not see global order aggregates");
      }
      const aliasToken = await login(server.baseUrl, fixture.accounts.distributorAlias);
      const aliasDashboard = await requestJson(server.baseUrl, "/api/dashboard", { headers: authHeaders(aliasToken) });
      assert.equal(aliasDashboard.status, 200);
      assert.equal(aliasDashboard.body.orders, 5, "channel scope must follow distributorId relation when account id differs");
    });
      await check(report, "non-super roles cannot read global audit logs", async () => {
      for (const role of ["service", "finance", "photo", "merchant", "distributor", "content", "agentOnly"]) {
        const token = await login(server.baseUrl, fixture.accounts[role]);
        const result = await requestJson(server.baseUrl, "/api/collection/logs", { headers: authHeaders(token) });
        assert.equal(result.status, 403, `${role} must not read global audit logs`);
      }
    });
    await check(report, "client audit writes cannot impersonate an operator", async () => {
      const serviceToken = await login(server.baseUrl, fixture.accounts.service);
      const write = await requestJson(server.baseUrl, "/api/collection/logs", {
        method: "POST", headers: authHeaders(serviceToken), body: { operator: "evil", user: "evil", action: "synthetic client audit" },
      });
      assert.equal(write.status, 201);
      const logs = await requestJson(server.baseUrl, "/api/collection/logs", { headers: authHeaders(superToken) });
      const row = responseRows(logs.body).find((item) => item && item.action === "synthetic client audit");
      assert.ok(row);
      assert.equal(row.operator, fixture.accounts.service.account);
      assert.notEqual(row.operator, "evil");
    });
      await check(report, "channel dashboard and home aggregates stay scoped", async () => {
      const merchantToken = await login(server.baseUrl, fixture.accounts.merchant);
      const merchantDashboard = await requestJson(server.baseUrl, "/api/dashboard", { headers: authHeaders(merchantToken) });
      assert.equal(merchantDashboard.status, 200);
      assert.equal(merchantDashboard.body.orders, 4, "merchant dashboard must contain only its scoped orders");
      const merchantDashboardRpc = await requestJson(server.baseUrl, "/api/rpc/getDashboard", { method: "POST", headers: authHeaders(merchantToken), body: {} });
      assert.equal(merchantDashboardRpc.status, 200);
      assert.equal(merchantDashboardRpc.body.orders, 4, "admin dashboard RPC must use the same scoped aggregate");
      const merchantHome = await requestJson(server.baseUrl, "/api/home", { headers: authHeaders(merchantToken) });
      assert.equal(merchantHome.status, 200);
      assert.equal(merchantHome.body.stats.orders, 4, "merchant home stats must contain only its scoped orders");
      assert.equal(Object.prototype.hasOwnProperty.call(merchantHome.body, "activityNotice"), false, "channel home must not expose global content config");
      for (const raw of ["synthetic-home-secret", "private.invalid/home", "synthetic-home-audit"]) {
        assert.equal(JSON.stringify(merchantHome.body).includes(raw), false, `channel home must not expose ${raw}`);
      }
      const distributorToken = await login(server.baseUrl, fixture.accounts.distributor);
      const distributorDashboard = await requestJson(server.baseUrl, "/api/dashboard", { headers: authHeaders(distributorToken) });
      assert.equal(distributorDashboard.status, 200);
      assert.equal(distributorDashboard.body.orders, 5, "distributor dashboard must contain only its scoped orders");
      assert.equal(distributorDashboard.body.byStatus.other || 0, 0, "distributor dashboard must exclude other distributor orders");
      const distributorCodes = await requestJson(server.baseUrl, "/api/collection/merchantCodes", { headers: authHeaders(distributorToken) });
      assert.ok(responseRows(distributorCodes.body).some((row) => row && (row.id === "smoke-code" || row._id === "smoke-code")), "distributor must see codes for owned shops");
      const distributorScans = await requestJson(server.baseUrl, "/api/collection/scans", { headers: authHeaders(distributorToken) });
      assert.ok(responseRows(distributorScans.body).some((row) => row && (row.id === "smoke-scan" || row._id === "smoke-scan")), "distributor must see scans for owned shops");
      const contentToken = await login(server.baseUrl, fixture.accounts.content);
      const contentHome = await requestJson(server.baseUrl, "/api/home", { headers: authHeaders(contentToken) });
      assert.equal(contentHome.status, 403, "content role must not read operational home aggregates");
    });
    await check(report, "merchant code routes enforce shop ownership", async () => {
      const merchantToken = await login(server.baseUrl, fixture.accounts.merchant);
      const merchantOther = await requestJson(server.baseUrl, "/api/merchant-codes?shopId=smoke-shop-other", { headers: authHeaders(merchantToken) });
      assert.equal(merchantOther.status, 403);
      const distributorToken = await login(server.baseUrl, fixture.accounts.distributor);
      const distributorOther = await requestJson(server.baseUrl, "/api/merchant-codes?shopId=smoke-shop-other", { headers: authHeaders(distributorToken) });
      assert.equal(distributorOther.status, 403);
    });

    superToken = await (async () => {
      try { return await login(server.baseUrl, fixture.accounts.super); } catch { return null; }
    })();
    if (superToken) {
      let activeSuperToken = superToken;
      await check(report, "package content write persists to public catalog", async () => {
        const packageId = "smoke-package-content";
        const payload = {
          name: "Smoke Package Updated", type: "photo", price: 199, originalPrice: 299,
          status: "上架", isShow: true, isMainPush: true, spotId: "smoke-spot", spotIds: ["smoke-spot"],
          intro: "Synthetic package description", description: "Synthetic package description",
          serviceTags: ["拍摄60分钟", "精修12张"],
          includedItems: [{ type: "album", name: "Smoke Album", albumId: "smoke-album", target: { page: "photoCollection", albumId: "smoke-album", spotId: "smoke-spot" } }]
        };
        const saved = await requestJson(server.baseUrl, "/api/collection/packages", {
          method: "POST", headers: authHeaders(activeSuperToken), body: { ...payload, id: packageId, _id: packageId },
        });
        assert.equal(saved.status, 201, "authorized package creation must succeed");
        assert.equal(saved.body && saved.body.description, payload.description);
        const reloaded = await requestJson(server.baseUrl, `/api/collection/packages/${packageId}`, { headers: authHeaders(activeSuperToken) });
        assert.equal(reloaded.status, 200);
        assert.equal(reloaded.body && reloaded.body.includedItems && reloaded.body.includedItems[0].target.albumId, "smoke-album");
        const home = await requestJson(server.baseUrl, "/api/rpc/getHomeData", { method: "POST", body: { data: {} } });
        assert.equal(home.status, 200);
        const homeRows = home.body && home.body.data && home.body.data.packages || [];
        const publicPackage = homeRows.find((item) => item && (item.id === packageId || item._id === packageId));
        assert.ok(publicPackage, "updated package must appear in public home data");
        assert.equal(publicPackage.description, payload.description);
        assert.equal(publicPackage.duration, 60);
        assert.equal(publicPackage.retouchCount, 12);
        assert.ok((home.body.data.hotPackages || []).some((item) => item && (item.id === packageId || item._id === packageId)), "main-push package must appear in public recommendations");
        const detail = await requestJson(server.baseUrl, "/api/rpc/getSeriesDetail", {
          method: "POST", body: { data: { packageId } },
        });
        assert.equal(detail.status, 200);
        assert.equal(detail.body && detail.body.data && detail.body.data.currentPackage && detail.body.data.currentPackage.description, payload.description);
        const removed = await requestJson(server.baseUrl, `/api/collection/packages/${packageId}`, {
          method: "DELETE", headers: authHeaders(activeSuperToken),
        });
        assert.equal(removed.status, 200);
      });
      await check(report, "stale admin sessions stop after account disable", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const disabled = await requestJson(server.baseUrl, "/api/collection/staff/smoke-service", {
          method: "PUT", headers: authHeaders(superToken), body: { status: "停用" },
        });
        assert.equal(disabled.status, 200);
        const blocked = await requestJson(server.baseUrl, "/api/collection/orders", { headers: authHeaders(serviceToken) });
        assert.equal(blocked.status, 401, "disabled account token must be rejected");
        const restored = await requestJson(server.baseUrl, "/api/collection/staff/smoke-service", {
          method: "PUT", headers: authHeaders(superToken), body: { status: "启用" },
        });
        assert.equal(restored.status, 200);
      });
      await check(report, "permissionKeys updates take effect on existing sessions", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const narrowed = await requestJson(server.baseUrl, "/api/collection/staff/smoke-service", {
          method: "PUT", headers: authHeaders(superToken), body: { permissionKeys: ["view"] },
        });
        assert.equal(narrowed.status, 200);
        const denied = await requestJson(server.baseUrl, "/api/orders/smoke-order-shop/action", {
          method: "POST", headers: authHeaders(serviceToken), body: { action: "note", reason: "should be denied" },
        });
        assert.equal(denied.status, 403);
        const restored = await requestJson(server.baseUrl, "/api/collection/staff/smoke-service", {
          method: "PUT", headers: authHeaders(superToken), body: { permissions: ["view", "orderEdit", "assign", "cancelOrder"] },
        });
        assert.equal(restored.status, 200);
      });
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
      await check(report, "content role config response hides integration credentials", async () => {
        const contentToken = await login(server.baseUrl, fixture.accounts.content);
        const result = await requestJson(server.baseUrl, "/api/collection/siteConfig/global", { headers: authHeaders(contentToken) });
        assert.equal(result.status, 200);
        const text = JSON.stringify(result.body || {});
        assert.equal(/secret|token|password|private.?key|webhook/i.test(text), false, "content config must not expose integration secrets");
      });
      await check(report, "restricted order responses redact contact aliases", async () => {
        const merchantToken = await login(server.baseUrl, fixture.accounts.merchant);
        const photoToken = await login(server.baseUrl, fixture.accounts.photo);
        const paths = [
          ["merchant", merchantToken, ["phone", "contactPhone", "customerPhone", "contactPhones", "extraPhones"]],
          ["photo", photoToken, ["phone", "contactPhone", "customerPhone", "contactPhones", "extraPhones"]],
        ];
        const rawPhones = new Set(["13800138000", "13900139000", "13700137000", "13600136000", "13500135000", "13400134000"]);
        for (const [role, token, fields] of paths) {
          const detail = await requestJson(server.baseUrl, "/api/collection/orders/smoke-order-redaction", { headers: authHeaders(token) });
          assert.equal(detail.status, 200, `${role} detail must be readable for the scoped synthetic order`);
          const row = detail.body || {};
          for (const field of fields) {
            if (role === "photo") assert.equal(Object.prototype.hasOwnProperty.call(row, field), false, `${role} must not receive ${field}`);
            else if (Array.isArray(row[field])) assert.ok(row[field].every((value) => !rawPhones.has(String(value))), `${role} list alias ${field} must be masked`);
            else if (row[field]) assert.equal(rawPhones.has(String(row[field])), false, `${role} alias ${field} must be masked`);
          }
          for (const field of ["wechat", "contactWechat", "customerWechat", "extraWechats", "openid", "customerOpenid", "internalNote", "paymentRecords"]) {
            assert.equal(Object.prototype.hasOwnProperty.call(row, field), false, `${role} must not receive ${field}`);
          }
          const serialized = JSON.stringify(row);
          for (const raw of ["13800138000", "13900139000", "13700137000", "13600136000", "13500135000", "13400134000", "nested-openid", "nested-note", "nested-code"]) {
            assert.equal(serialized.includes(raw), false, `${role} response must not expose nested sensitive marker ${raw}`);
          }
        }
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

      await check(report, "generic order PUT cannot bypass workflow audit", async () => {
        const result = await requestJson(server.baseUrl, "/api/collection/orders/smoke-order-shop", {
          method: "PUT",
          headers: authHeaders(superToken),
          body: { status: "completed", depositPaid: 999, depositFinanceStatus: "已审" },
        });
        assert.equal(result.status, 403, "generic order PUT must be rejected");
        const detail = await requestJson(server.baseUrl, "/api/collection/orders/smoke-order-shop", { headers: authHeaders(superToken) });
        assert.equal(detail.body.status, "new", "rejected PUT must not mutate status");
        assert.equal(detail.body.depositPaid || 0, 0, "rejected PUT must not mutate payment");
      });
      await check(report, "non-super order update action cannot jump workflow", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const result = await requestJson(server.baseUrl, "/api/orders/smoke-order-shop/action", {
          method: "POST", headers: authHeaders(serviceToken),
          body: { action: "update", reason: "synthetic bypass attempt", fields: { status: "completed", depositPaid: 999, depositFinanceStatus: "已审" } },
        });
        assert.ok([400, 403, 409].includes(result.status), "sensitive order update must be rejected");
        const detail = await requestJson(server.baseUrl, "/api/collection/orders/smoke-order-shop", { headers: authHeaders(superToken) });
        assert.equal(detail.body.status, "new", "rejected sensitive update must not change status");
      });
      await check(report, "generic order and after-sale DELETE cannot bypass audit", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const orderDelete = await requestJson(server.baseUrl, "/api/collection/orders/smoke-order-shop", { method: "DELETE", headers: authHeaders(serviceToken) });
        assert.equal(orderDelete.status, 403);
        const ticketRows = await requestJson(server.baseUrl, "/api/collection/afterSales", { headers: authHeaders(superToken) });
        const ticket = responseRows(ticketRows.body)[0];
        if (ticket) {
          const ticketDelete = await requestJson(server.baseUrl, `/api/collection/afterSales/${encodeURIComponent(ticket.id || ticket._id)}`, { method: "DELETE", headers: authHeaders(superToken) });
          assert.equal(ticketDelete.status, 403);
        }
      });
      await check(report, "deleted orders accept only the super restore action", async () => {
        const blocked = await requestJson(server.baseUrl, "/api/orders/smoke-order-deleted/action", {
          method: "POST", headers: authHeaders(superToken), body: { action: "note", reason: "synthetic deleted mutation" },
        });
        assert.equal(blocked.status, 404, "deleted orders must reject non-restore actions");
        const restored = await requestJson(server.baseUrl, "/api/orders/smoke-order-deleted/action", {
          method: "POST", headers: authHeaders(superToken), body: { action: "restore", reason: "synthetic restore" },
        });
        assert.equal(restored.status, 200);
      });
      await check(report, "finance records and singleton docs cannot be deleted through collections", async () => {
        const financeToken = await login(server.baseUrl, fixture.accounts.finance);
        const financeDelete = await requestJson(server.baseUrl, "/api/collection/monthlyClosings/smoke-closing", { method: "DELETE", headers: authHeaders(financeToken) });
        assert.equal(financeDelete.status, 403);
        const contentToken = await login(server.baseUrl, fixture.accounts.content);
        const docDelete = await requestJson(server.baseUrl, "/api/collection/siteConfig/global", { method: "DELETE", headers: authHeaders(contentToken) });
        assert.ok([405, 403].includes(docDelete.status));
      });
      await check(report, "reconciliation writes are validated and idempotent", async () => {
        const financeToken = await login(server.baseUrl, fixture.accounts.finance);
        const financeDoc = await requestJson(server.baseUrl, "/api/doc/financeSettings/global", { headers: authHeaders(financeToken) });
        assert.equal(financeDoc.status, 200);
        assert.equal(Number(financeDoc.body.settlementObservationDays), 3, "finance settings must read as a singleton document");
        const financeDocUpdate = await requestJson(server.baseUrl, "/api/doc/financeSettings/global", {
          method: "PUT", headers: authHeaders(financeToken), body: { settlementObservationDays: 4 },
        });
        assert.equal(financeDocUpdate.status, 200);
        assert.equal(Number(financeDocUpdate.body.settlementObservationDays), 4);
        const key = `smoke-transfer-${crypto.randomBytes(4).toString("hex")}`;
        const create = await requestJson(server.baseUrl, "/api/collection/reconciliationTransfers", {
          method: "POST", headers: authHeaders(financeToken), body: {
            key, month: "2099-01", period: "2099-01-31", settlementCycle: "月结", objectType: "商家",
            objectId: "smoke-settlement-shop", objectName: "forged name", amount: 10,
            orderIds: ["smoke-order-settlement"], orderNos: ["SMOKE-SETTLE"],
          },
        });
        assert.equal(create.status, 201);
        assert.equal(create.body.objectId, "smoke-settlement-shop");
        assert.equal(create.body.objectName, "Smoke Settlement Shop", "server must derive settlement name");
        const forgedAmount = await requestJson(server.baseUrl, "/api/collection/reconciliationTransfers", {
          method: "POST", headers: authHeaders(financeToken), body: {
            key: `smoke-forged-${crypto.randomBytes(4).toString("hex")}`, month: "2099-01", period: "2099-01-31",
            settlementCycle: "月结", objectType: "商家", objectId: "smoke-settlement-shop", amount: 1,
            orderIds: ["smoke-order-settlement"], orderNos: ["SMOKE-SETTLE"],
          },
        });
        assert.equal(forgedAmount.status, 409, "settlement amount must match server commission");
        const forgedOrder = await requestJson(server.baseUrl, "/api/collection/reconciliationTransfers", {
          method: "POST", headers: authHeaders(financeToken), body: {
            key: `smoke-wrong-order-${crypto.randomBytes(4).toString("hex")}`, month: "2099-01", period: "2099-01-31",
            settlementCycle: "月结", objectType: "商家", objectId: "smoke-settlement-shop", amount: 10,
            orderIds: ["smoke-order-shop"], orderNos: ["SMOKE"],
          },
        });
        assert.equal(forgedOrder.status, 409, "settlement must validate entity/order ownership");
        const observationHold = await requestJson(server.baseUrl, "/api/collection/reconciliationTransfers", {
          method: "POST", headers: authHeaders(financeToken), body: {
            key: `smoke-observation-${crypto.randomBytes(4).toString("hex")}`, month: "2099-01", period: "2099-01-31",
            settlementCycle: "月结", objectType: "商家", objectId: "smoke-settlement-shop", amount: 10,
            orderIds: ["smoke-order-recent"], orderNos: ["SMOKE-RECENT"],
          },
        });
        assert.equal(observationHold.status, 409, "recent completed orders must respect settlement observation hold");
        const duplicate = await requestJson(server.baseUrl, "/api/collection/reconciliationTransfers", {
          method: "POST", headers: authHeaders(financeToken), body: { key, month: "2099-01", objectType: "商家", objectId: "smoke-shop", amount: 50 },
        });
        assert.equal(duplicate.status, 409);
        const id = create.body.id || create.body._id;
        const paid = await requestJson(server.baseUrl, `/api/collection/reconciliationTransfers/${encodeURIComponent(id)}`, {
          method: "PUT", headers: authHeaders(financeToken), body: { payStatus: "已打" },
        });
        assert.equal(paid.status, 200);
        const invalidAdjustment = await requestJson(server.baseUrl, "/api/collection/adjustmentRecords", {
          method: "POST", headers: authHeaders(financeToken), body: { orderNo: "missing", amount: 20, targetName: "Smoke", note: "bad order" },
        });
        assert.equal(invalidAdjustment.status, 404);
      });
      await check(report, "admin after-sale creation requires an owned order", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const missing = await requestJson(server.baseUrl, "/api/collection/afterSales", {
          method: "POST", headers: authHeaders(serviceToken), body: { orderId: "not-an-order", reason: "forged ticket" },
        });
        assert.equal(missing.status, 404);
        const financeToken = await login(server.baseUrl, fixture.accounts.finance);
        const denied = await requestJson(server.baseUrl, "/api/collection/afterSales", {
          method: "POST", headers: authHeaders(financeToken), body: { orderId: "smoke-order-shop", reason: "finance ticket" },
        });
        assert.equal(denied.status, 403);
      });
      await check(report, "finance update cannot forge reviewer identity", async () => {
        const financeToken = await login(server.baseUrl, fixture.accounts.finance);
        const result = await requestJson(server.baseUrl, "/api/orders/smoke-order-shop/action", {
          method: "POST", headers: authHeaders(financeToken),
          body: { action: "update", reason: "synthetic reviewer spoof", fields: { financeReviewedBy: "evil", financeReviewedAt: "1900-01-01" } },
        });
        assert.equal(result.status, 403);
      });
      await check(report, "service payment updates enforce combined amount", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const result = await requestJson(server.baseUrl, "/api/orders/smoke-order-shop/action", {
          method: "POST", headers: authHeaders(serviceToken),
          body: { action: "update", reason: "synthetic combined amount", fields: {
            depositPaid: 80, finalPaid: 30, depositFinanceStatus: "待审", finalFinanceStatus: "待审"
          } },
        });
        assert.equal(result.status, 409, "combined payments above order total must be rejected");
      });
      await check(report, "service update validates assignee and ticket references", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const result = await requestJson(server.baseUrl, "/api/orders/smoke-order-shop/action", {
          method: "POST", headers: authHeaders(serviceToken),
          body: { action: "update", reason: "synthetic reference validation", fields: {
            photographerId: "not-a-photo", assigneeId: "not-a-service", afterSaleId: "not-a-ticket"
          } },
        });
        assert.ok([403, 409].includes(result.status));
      });
      await check(report, "completed orders cannot be rescheduled", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const result = await requestJson(server.baseUrl, "/api/orders/smoke-order-completed/action", {
          method: "POST", headers: authHeaders(serviceToken),
          body: { action: "reschedule", reason: "synthetic completed reschedule", appointmentAt: "2099-02-01", timePeriod: "10:00" },
        });
        assert.equal(result.status, 409);
      });
      await check(report, "service cannot mutate completed or active-after-sale assignment/contact fields", async () => {
        const serviceToken = await login(server.baseUrl, fixture.accounts.service);
        const completed = await requestJson(server.baseUrl, "/api/orders/smoke-order-completed/action", {
          method: "POST", headers: authHeaders(serviceToken), body: {
            action: "update", reason: "synthetic completed assignment mutation", fields: { photographerId: "smoke-photo", contactName: "forged" },
          },
        });
        assert.equal(completed.status, 409, "completed order assignment/contact mutation must be locked");
        const ticket = await requestJson(server.baseUrl, "/api/collection/afterSales", {
          method: "POST", headers: authHeaders(superToken), body: { orderId: "smoke-order-shop", reason: "synthetic active ticket" },
        });
        assert.equal(ticket.status, 201, "synthetic active after-sale must be created");
        const active = await requestJson(server.baseUrl, "/api/orders/smoke-order-shop/action", {
          method: "POST", headers: authHeaders(serviceToken), body: {
            action: "update", reason: "synthetic active-after-sale assignment mutation", fields: { photographerId: "smoke-photo" },
          },
        });
        assert.equal(active.status, 409, "active after-sale assignment mutation must be locked");
      });

    let persistedBookingId = "";
    let persistedTicketId = "";
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
        persistedBookingId = result.body.orderId;
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
        const ticketId = result.body && result.body.data && (result.body.data.ticketId || result.body.data.id);
        assert.ok(ticketId, "after-sale response must include a ticket id");
        persistedTicketId = ticketId;
        const tickets = await requestJson(server.baseUrl, "/api/collection/afterSales", { headers: authHeaders(superToken) });
        assert.ok(responseRows(tickets.body).some((row) => row && (row.id === ticketId || row._id === ticketId)), "after-sale ticket must be persisted separately");
        const action = await requestJson(server.baseUrl, `/api/after-sales/${encodeURIComponent(ticketId)}/action`, {
          method: "POST", headers: authHeaders(superToken), body: { action: "follow", reason: "synthetic after-sale follow-up" },
        });
        assert.equal(action.status, 200, "dedicated after-sale action must succeed");
        const orderLocked = await requestJson(server.baseUrl, `/api/orders/${encodeURIComponent(created.id || created._id)}/action`, {
          method: "POST", headers: authHeaders(superToken), body: { action: "complete", reason: "synthetic locked completion" },
        });
        assert.equal(orderLocked.status, 409, "active after-sale must lock order completion");
        const undecided = await requestJson(server.baseUrl, `/api/after-sales/${encodeURIComponent(ticketId)}/action`, {
          method: "POST", headers: authHeaders(superToken), body: { action: "review", reason: "missing decision" },
        });
        assert.equal(undecided.status, 400, "finance review must require an explicit decision");
        const overRefund = await requestJson(server.baseUrl, `/api/after-sales/${encodeURIComponent(ticketId)}/action`, {
          method: "POST", headers: authHeaders(superToken), body: { action: "complete", reason: "over refund", refundAmount: 999, refundConfirmed: true },
        });
        assert.equal(overRefund.status, 409, "refund amount above order total must be rejected");
        const bypass = await requestJson(server.baseUrl, `/api/collection/afterSales/${encodeURIComponent(ticketId)}`, {
          method: "PUT", headers: authHeaders(superToken), body: { status: "completed", financeStatus: "已审", refundAmount: 999 },
        });
        assert.equal(bypass.status, 403, "generic after-sale PUT must be rejected");
      });

      const marker = `smoke-${crypto.randomBytes(10).toString("hex")}`;
      const persistId = `smoke-persist-${crypto.randomBytes(6).toString("hex")}`;
      await check(report, "JSON write accepted for persistence probe", async () => {
        const result = await requestJson(server.baseUrl, `/api/doc/siteConfig/${encodeURIComponent(persistId)}`, {
          method: "PUT",
          headers: authHeaders(superToken),
          body: { marker },
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
        const result = await requestJson(server.baseUrl, `/api/doc/siteConfig/${encodeURIComponent(persistId)}`, { headers: authHeaders(activeSuperToken) });
        assert.equal(result.status, 200);
        assert.equal(result.body && result.body.marker, marker, "persisted marker must be readable after restart");
        const orders = await requestJson(server.baseUrl, "/api/collection/orders", { headers: authHeaders(activeSuperToken) });
        assert.ok(responseRows(orders.body).some((row) => row && (row.id === persistedBookingId || row._id === persistedBookingId)), "created booking must persist after restart");
        const tickets = await requestJson(server.baseUrl, "/api/collection/afterSales", { headers: authHeaders(activeSuperToken) });
        assert.ok(responseRows(tickets.body).some((row) => row && (row.id === persistedTicketId || row._id === persistedTicketId)), "after-sale ticket must persist after restart");
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
  const productionFixture = createTempFixture(root);
  let productionServer = null;
  try {
    productionServer = await startServer(root, productionFixture.file, {
      sessionStore: "memory",
      env: { NODE_ENV: "production", ALLOW_DEV_OPENID: "true" },
    });
    await check(report, "production mode disables synthetic public identity", async () => {
      assert.equal(productionServer.ready, true);
      assert.equal(productionServer.health.status, 503, "production without Redis must report unhealthy");
      const result = await requestJson(productionServer.baseUrl, "/api/rpc/login", { method: "POST", body: {} });
      assert.ok([200, 503].includes(result.status));
      assert.equal(result.body && result.body.success, false, "production must not issue dev openid sessions");
    });
  } finally {
    await stopServer(productionServer);
    try { fs.rmSync(productionFixture.dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
  const malformedFixture = createTempFixture(root);
  let malformedServer = null;
  try {
    fs.writeFileSync(malformedFixture.file, JSON.stringify({ collections: [] }), { encoding: "utf8", mode: 0o600 });
    malformedServer = await startServer(root, malformedFixture.file, { sessionStore: "memory" });
    await check(report, "malformed JSON data fails closed", async () => {
      assert.equal(malformedServer.ready, true);
      assert.equal(malformedServer.health.status, 503, "malformed collections must report unhealthy");
      const secondHealth = await requestJson(malformedServer.baseUrl, "/api/health");
      assert.equal(secondHealth.status, 503, "malformed source must remain unhealthy on repeated reads");
      assert.equal(malformedServer.health.status, 503, "invalid JSON must not become a writable cache after the first read");
    });
  } finally {
    await stopServer(malformedServer);
    try { fs.rmSync(malformedFixture.dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
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
    await runConfigProbe(report, root, probeFixture.file, "Redis invalid numeric configuration", {
      SESSION_STORE: "redis",
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: "not-a-port",
      REDIS_DB: "0",
    }, { sessionStore: "redis", expectedSessionStore: "redis" });
    await runConfigProbe(report, root, probeFixture.file, "MySQL missing configuration", {
      DATA_MODE: "mysql",
      DB_HOST: "",
      DB_USER: "",
      DB_PASSWORD: "",
      DB_NAME: "",
    }, { dataMode: "mysql", expectedMode: "mysql" });
    await runConfigProbe(report, root, probeFixture.file, "MySQL unavailable connection", {
      DATA_MODE: "mysql",
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      DB_USER: "invalid",
      DB_PASSWORD: "invalid",
      DB_NAME: "invalid",
      DB_CONNECT_TIMEOUT_MS: "250",
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
