"use strict";

// Structured logs are emitted as one JSON object per line so journalctl,
// Docker and common log shippers can filter them without parsing prose.
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const SENSITIVE_FIELD = /(?:authorization|cookie|password|secret|token|private.?key|access.?key|api.?key|openid|unionid|phone|mobile|telephone|wechat)/i;
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const requestStorage = new AsyncLocalStorage();

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function currentLevel() {
  const configured = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
  return LEVELS[configured] || LEVELS.info;
}

function sanitize(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_FIELD.test(key)) continue;
      const next = sanitize(child, depth + 1);
      if (next !== undefined) output[key] = next;
    }
    return output;
  }
  return String(value);
}

function errorCode(error) {
  if (!error) return "UNKNOWN";
  const code = String(error.code || error.name || "REQUEST_FAILED").replace(/[^A-Za-z0-9_.:-]/g, "_");
  return code.slice(0, 120) || "REQUEST_FAILED";
}

function requestId(req) {
  const existing = String(req && (req.requestId || req.headers && req.headers["x-request-id"]) || "").trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing;
  return crypto.randomBytes(12).toString("hex");
}

function normalizePath(value) {
  const raw = String(value || "/").split("?")[0];
  return raw.length > 500 ? raw.slice(0, 500) : raw;
}

function apiModule(pathname) {
  const parts = normalizePath(pathname).replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const first = parts[0] || "root";
  if (first === "rpc") {
    const name = String(parts[1] || "unknown");
    if (/payment/i.test(name)) return "mini-payments";
    if (/order|booking|after.?sale/i.test(name)) return "mini-orders";
    if (/profile|phone|login/i.test(name)) return "mini-profile";
    return "mini-catalog";
  }
  if (first === "collection" || first === "doc") {
    const key = String(parts[1] || "unknown");
    if (/order|afterSale/i.test(key)) return "orders";
    if (/finance|reconciliation|closing|adjustment/i.test(key)) return "finance";
    if (/staff|shop|agent|distributor/i.test(key)) return "channel";
    if (/log|trash/i.test(key)) return "system";
    return "content";
  }
  if (first === "modules") return `admin-${String(parts[1] || "unknown")}`;
  if (first === "orders" || first === "after-sales") return "orders";
  if (first === "payments") return "payments";
  if (first === "permissions" || first === "permission" || first === "auth") return "iam";
  if (first === "files" || first === "media") return "files";
  if (first === "merchant-code" || first === "merchant-codes") return "channel";
  if (first === "dashboard" || first === "home") return "dashboard";
  return first;
}

function createLogger(options = {}) {
  const service = String(options.service || "luxiaoming-admin").slice(0, 80);
  const write = (level, event, fields = {}) => {
    if ((LEVELS[level] || LEVELS.info) < currentLevel()) return;
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event: String(event || "event").slice(0, 120),
      ...sanitize(fields),
    };
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

function observeRequest(req, res, logger, options = {}) {
  const id = requestId(req);
  const pathname = normalizePath(options.pathname || req && req.url || "/");
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const accessEnabled = String(process.env.HTTP_ACCESS_LOG_ENABLED || "true").trim().toLowerCase() !== "false";
  const slowMs = boundedNumber(process.env.HTTP_SLOW_REQUEST_MS, 1000, 1, 120000);
  const startedAt = process.hrtime.bigint();
  let completed = false;
  req.requestId = id;
  req.requestStartedAt = startedAt;
  req.apiModule = isApi ? apiModule(pathname) : "static";
  req.requestMetrics = { requestId: id, module: req.apiModule, dbQueryCount: 0, dbDurationMs: 0 };
  if (!res.headersSent && !res.getHeader("X-Request-Id")) res.setHeader("X-Request-Id", id);

  const durationMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
  const fields = () => ({
    requestId: id,
    module: req.apiModule || (isApi ? apiModule(pathname) : "static"),
    method: String(req.method || "GET").toUpperCase(),
    route: pathname,
    status: Number(res.statusCode || 0),
    durationMs: Math.round(durationMs() * 100) / 100,
    dbQueryCount: Number(req.requestMetrics && req.requestMetrics.dbQueryCount || 0),
    dbDurationMs: Math.round(Number(req.requestMetrics && req.requestMetrics.dbDurationMs || 0) * 100) / 100,
    actorType: String(req.requestActor && req.requestActor.type || ""),
    actorId: String(req.requestActor && req.requestActor.id || ""),
    actorRole: String(req.requestActor && req.requestActor.role || ""),
  });
  const finish = () => {
    if (completed) return;
    completed = true;
    const value = fields();
    if (isApi && (accessEnabled || value.status >= 400 || value.durationMs >= slowMs)) {
      const level = value.status >= 500 ? "error" : value.status >= 400 || value.durationMs >= slowMs ? "warn" : "info";
      logger[level]("http.request.completed", value);
    }
  };
  res.once("finish", finish);
  res.once("close", () => {
    if (completed || res.writableEnded) return;
    completed = true;
    logger.warn("http.request.aborted", { ...fields(), status: Number(res.statusCode || 499) || 499 });
  });
  if (isApi && accessEnabled) logger.info("http.request.started", {
    requestId: id,
    module: req.apiModule,
    method: String(req.method || "GET").toUpperCase(),
    route: pathname,
  });
  return { requestId: id, pathname, module: req.apiModule, durationMs };
}

function runWithRequestContext(req, task) {
  const metrics = req && req.requestMetrics ? req.requestMetrics : { dbQueryCount: 0, dbDurationMs: 0 };
  return requestStorage.run(metrics, task);
}

function recordDatabaseOperation(durationMs) {
  const metrics = requestStorage.getStore();
  if (!metrics) return;
  metrics.dbQueryCount = Number(metrics.dbQueryCount || 0) + 1;
  metrics.dbDurationMs = Number(metrics.dbDurationMs || 0) + Math.max(0, Number(durationMs) || 0);
}

function currentRequestContext() {
  return requestStorage.getStore() || null;
}

module.exports = {
  apiModule,
  currentRequestContext,
  createLogger,
  errorCode,
  observeRequest,
  recordDatabaseOperation,
  requestId,
  runWithRequestContext,
  sanitize,
};
