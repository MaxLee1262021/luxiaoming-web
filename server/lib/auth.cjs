// Session and login-attempt storage.
// Memory is intentionally the default for a single local process. When REDIS_URL
// is set, Redis becomes mandatory: connection errors never fall back to memory.
const crypto = require("crypto");

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FAILS = 5;

class AuthStoreUnavailableError extends Error {
  constructor(message = "认证存储不可用") {
    super(message);
    this.name = "AuthStoreUnavailableError";
    this.code = "AUTH_STORE_UNAVAILABLE";
  }
}

class UnavailableAuthStore {
  constructor(reason = "auth_store_unavailable") {
    this.kind = "redis";
    this.reason = reason;
  }
  async init() { return this; }
  fail() { throw new AuthStoreUnavailableError("Redis 认证存储不可用"); }
  async createSession() { return this.fail(); }
  async getSession() { return this.fail(); }
  async revokeSession() { return this.fail(); }
  async recordLoginFailure() { return this.fail(); }
  async clearLoginFailures() { return this.fail(); }
  async isLoginLocked() { return this.fail(); }
  async health() { return { backend: "redis", configured: true, ready: false, persistent: true, required: true, error: this.reason }; }
  async close() {}
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function sessionTtlMs(value) {
  return positiveInt(value, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function newToken() {
  return "lxm-session-" + crypto.randomBytes(32).toString("hex");
}

function validToken(token) {
  return typeof token === "string" && token.length >= 32 && token.length <= 256 && /^[A-Za-z0-9_-]+$/.test(token);
}

class MemoryAuthStore {
  constructor(options = {}) {
    this.kind = "memory";
    this.ttlMs = sessionTtlMs(options.ttlMs);
    this.lockMs = positiveInt(options.lockMs, DEFAULT_LOCK_MS, 1000, 24 * 60 * 60 * 1000);
    this.maxFails = positiveInt(options.maxFails, DEFAULT_MAX_FAILS, 1, 100);
    this.sessions = new Map();
    this.attempts = new Map();
  }

  async init() { return this; }

  cleanup(now = Date.now()) {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
    for (const [key, rec] of this.attempts) {
      if (rec.lockedUntil <= now && rec.expiresAt <= now) this.attempts.delete(key);
    }
  }

  async createSession(payload = {}) {
    this.cleanup();
    const token = newToken();
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(token, { ...payload, tokenVersion: 1, createdAt: Date.now(), expiresAt });
    return { token, expiresAt, ttlMs: this.ttlMs };
  }

  async getSession(token) {
    if (!validToken(token)) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { ...session };
  }

  async revokeSession(token) {
    if (!validToken(token)) return false;
    return this.sessions.delete(token);
  }

  async recordLoginFailure(key) {
    this.cleanup();
    const now = Date.now();
    const rec = this.attempts.get(String(key)) || { fails: 0, lockedUntil: 0, expiresAt: now + this.lockMs };
    if (rec.lockedUntil > now) {
      return { blocked: true, lockedUntil: rec.lockedUntil, failures: rec.fails };
    }
    rec.fails += 1;
    rec.expiresAt = now + this.lockMs;
    if (rec.fails >= this.maxFails) {
      rec.lockedUntil = now + this.lockMs;
      rec.fails = 0;
      this.attempts.set(String(key), rec);
      return { blocked: true, lockedUntil: rec.lockedUntil, failures: this.maxFails };
    }
    this.attempts.set(String(key), rec);
    return { blocked: false, lockedUntil: 0, failures: rec.fails, remaining: this.maxFails - rec.fails };
  }

  async isLoginLocked(key) {
    const rec = this.attempts.get(String(key));
    if (!rec || rec.lockedUntil <= Date.now()) return { lockedUntil: 0 };
    return { lockedUntil: rec.lockedUntil, failures: rec.fails };
  }

  async clearLoginFailures(key) {
    this.attempts.delete(String(key));
  }

  async health() {
    return { backend: "memory", configured: false, ready: true, persistent: false, required: false, ttlSeconds: Math.floor(this.ttlMs / 1000) };
  }

  async close() {}
}

class RedisAuthStore {
  constructor(options = {}) {
    this.kind = "redis";
    this.url = options.url;
    this.prefix = options.prefix || "lxm:admin";
    this.ttlMs = sessionTtlMs(options.ttlMs);
    this.lockMs = positiveInt(options.lockMs, DEFAULT_LOCK_MS, 1000, 24 * 60 * 60 * 1000);
    this.maxFails = positiveInt(options.maxFails, DEFAULT_MAX_FAILS, 1, 100);
    this.connectTimeoutMs = positiveInt(options.connectTimeoutMs, 1500, 250, 10000);
    this.client = null;
    this.connectPromise = null;
    this.lastError = "";
  }

  async init() {
    // Do not connect during module loading. The first health/auth operation will
    // establish the connection and report a deterministic failure if unavailable.
    return this;
  }

  async ensureReady() {
    if (this.client && this.client.isReady) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      let createClient;
      try {
        ({ createClient } = require("redis"));
      } catch (e) {
        throw new AuthStoreUnavailableError("已配置 Redis，但运行时未安装 redis 依赖");
      }
      const client = createClient({
        url: this.url,
        socket: { connectTimeout: this.connectTimeoutMs, reconnectStrategy: false }
      });
      client.on("error", () => { this.lastError = "redis_error"; });
      try {
        await withTimeout(client.connect(), this.connectTimeoutMs + 500, "Redis 连接超时");
      } catch (e) {
        try { client.disconnect(); } catch (_) {}
        this.lastError = "redis_unavailable";
        throw new AuthStoreUnavailableError("Redis 连接不可用");
      }
      this.client = client;
      this.lastError = "";
      return client;
    })();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async requireReady() {
    try { return await this.ensureReady(); }
    catch (e) {
      if (e && e.code === "AUTH_STORE_UNAVAILABLE") throw e;
      throw new AuthStoreUnavailableError("Redis 认证存储不可用");
    }
  }

  sessionKey(token) { return `${this.prefix}:session:${digest(token)}`; }
  failKey(key) { return `${this.prefix}:login:${digest(key)}`; }
  lockKey(key) { return `${this.prefix}:lock:${digest(key)}`; }

  async createSession(payload = {}) {
    const client = await this.requireReady();
    const token = newToken();
    const expiresAt = Date.now() + this.ttlMs;
    const doc = { ...payload, tokenVersion: 1, createdAt: Date.now(), expiresAt };
    await client.set(this.sessionKey(token), JSON.stringify(doc), { PX: this.ttlMs });
    return { token, expiresAt, ttlMs: this.ttlMs };
  }

  async getSession(token) {
    if (!validToken(token)) return null;
    const client = await this.requireReady();
    const raw = await client.get(this.sessionKey(token));
    if (!raw) return null;
    try {
      const doc = JSON.parse(raw);
      if (!doc || Number(doc.expiresAt || 0) <= Date.now()) {
        await client.del(this.sessionKey(token));
        return null;
      }
      return doc;
    } catch (e) {
      await client.del(this.sessionKey(token));
      return null;
    }
  }

  async revokeSession(token) {
    if (!validToken(token)) return false;
    const client = await this.requireReady();
    return (await client.del(this.sessionKey(token))) > 0;
  }

  async recordLoginFailure(key) {
    const client = await this.requireReady();
    const lockTtl = await client.pTTL(this.lockKey(key));
    if (lockTtl > 0) return { blocked: true, lockedUntil: Date.now() + lockTtl, failures: this.maxFails };
    const failKey = this.failKey(key);
    const count = await client.incr(failKey);
    if (count === 1) await client.pExpire(failKey, this.lockMs);
    if (count >= this.maxFails) {
      await client.set(this.lockKey(key), "1", { PX: this.lockMs });
      await client.del(failKey);
      return { blocked: true, lockedUntil: Date.now() + this.lockMs, failures: this.maxFails };
    }
    return { blocked: false, lockedUntil: 0, failures: count, remaining: this.maxFails - count };
  }

  async isLoginLocked(key) {
    const client = await this.requireReady();
    const lockTtl = await client.pTTL(this.lockKey(key));
    return { lockedUntil: lockTtl > 0 ? Date.now() + lockTtl : 0, failures: lockTtl > 0 ? this.maxFails : 0 };
  }

  async clearLoginFailures(key) {
    const client = await this.requireReady();
    await client.del(this.failKey(key), this.lockKey(key));
  }

  async health() {
    try {
      await this.ensureReady();
      return { backend: "redis", configured: true, ready: true, persistent: true, required: true, ttlSeconds: Math.floor(this.ttlMs / 1000) };
    } catch (e) {
      return { backend: "redis", configured: true, ready: false, persistent: true, required: true, error: "unavailable", ttlSeconds: Math.floor(this.ttlMs / 1000) };
    }
  }

  async close() {
    if (!this.client) return;
    try { await this.client.quit(); } catch (_) { try { this.client.disconnect(); } catch (__) {} }
    this.client = null;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function redisUrlFromConfig(options = {}) {
  const explicit = options.redisUrl !== undefined ? options.redisUrl : process.env.REDIS_URL;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const host = String(options.redisHost !== undefined ? options.redisHost : process.env.REDIS_HOST || "").trim();
  if (!host) return "";
  const port = Number(options.redisPort !== undefined ? options.redisPort : process.env.REDIS_PORT || 6379);
  const database = Number(options.redisDb !== undefined ? options.redisDb : process.env.REDIS_DB || 0);
  const username = String(options.redisUsername !== undefined ? options.redisUsername : process.env.REDIS_USERNAME || "").trim();
  const password = options.redisPassword !== undefined ? String(options.redisPassword) : String(process.env.REDIS_PASSWORD || "");
  const auth = username || password ? `${encodeURIComponent(username || "default")}:${encodeURIComponent(password)}@` : "";
  const scheme = String(options.redisTls !== undefined ? options.redisTls : process.env.REDIS_TLS || "").toLowerCase() === "true" ? "rediss" : "redis";
  const safePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 6379;
  const safeDb = Number.isInteger(database) && database >= 0 ? database : 0;
  return `${scheme}://${auth}${host}:${safePort}/${safeDb}`;
}

function createAuthStore(options = {}) {
  const redisUrl = redisUrlFromConfig(options);
  const requestedStore = String(options.sessionStore !== undefined ? options.sessionStore : process.env.SESSION_STORE || "").trim().toLowerCase();
  const ttlMs = options.ttlMs !== undefined ? options.ttlMs : Number(process.env.SESSION_TTL_SECONDS || 0) * 1000 || DEFAULT_TTL_MS;
  const common = {
    ttlMs,
    lockMs: options.lockMs || Number(process.env.LOGIN_LOCK_SECONDS || 0) * 1000 || DEFAULT_LOCK_MS,
    maxFails: options.maxFails || Number(process.env.LOGIN_MAX_FAILS || 0) || DEFAULT_MAX_FAILS,
    connectTimeoutMs: options.connectTimeoutMs || Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 0) || 1500
  };
  if (requestedStore === "redis" && !(redisUrl && String(redisUrl).trim())) {
    return new UnavailableAuthStore("redis_config_missing");
  }
  if (redisUrl && String(redisUrl).trim()) {
    return new RedisAuthStore({ ...common, url: String(redisUrl).trim(), prefix: options.redisPrefix || process.env.REDIS_KEY_PREFIX || "lxm:admin" });
  }
  if (requestedStore && requestedStore !== "memory") return new UnavailableAuthStore("unknown_session_store");
  return new MemoryAuthStore(common);
}

function parseBearer(req) {
  const raw = req && req.headers ? req.headers.authorization : "";
  if (typeof raw !== "string") return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

module.exports = {
  AuthStoreUnavailableError,
  UnavailableAuthStore,
  createAuthStore,
  parseBearer,
  validToken,
  sessionTtlMs,
};
