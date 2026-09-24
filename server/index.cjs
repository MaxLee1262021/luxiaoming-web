// 鹿小鸣管理后台集成服务器（同一进程：托管后台网页 + 提供 /api 接口）
// Runtime API data is always served from MySQL. JSON is restricted to
// isolated Node test fixtures and cannot be selected by this server.
// 启动：node server/index.cjs  （或 npm run server）
// Runtime does not load demo data.
// 管理 API 使用 server-side Bearer sessions；Redis 通过 REDIS_URL 可选启用。

// 载入 .env（真实云密钥从环境变量读取，避免硬编码进代码；.env 已被 gitignore）
require("dotenv").config();
const http = require("http");
const path = require("path");
const { createLogger, errorCode, observeRequest, runWithRequestContext } = require("./lib/observability.cjs");

const root = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 5192);
const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const logger = createLogger({ service: "luxiaoming-admin" });

const selected = require("./lib/selectSource.cjs")();
const { source, mode, status: sourceStatus } = selected;
const { createAuthStore } = require("./lib/auth.cjs");
const createPermissionStore = require("./lib/permissionStore.cjs");
const staticHandler = require("./lib/static.cjs")(root);
const amapRuntime = require("./lib/amapRuntime.cjs").createAmapRuntime();
const wechatPay = require("./lib/wechatPay.cjs").createWechatPay();
const auth = createAuthStore();
const permissionStore = createPermissionStore({
  backend: mode,
  jsonFile: process.env.DB_FILE,
  dbHost: process.env.DB_HOST,
  dbPort: Number(process.env.DB_PORT || 3306),
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD || "",
  dbName: process.env.DB_NAME,
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 3000),
  connectionLimit: Math.min(Math.max(Number(process.env.DB_CONNECTION_LIMIT || 10), 1), 100),
  logger,
});
const apiHandler = require("./lib/api.cjs")(source, mode, { auth, permissionStore, sourceStatus, wechatPay, logger });

async function bootstrap() {
  const server = http.createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    observeRequest(req, res, logger, { pathname: p });
    const fail = (error) => {
      logger.error("http.request.unhandled", {
        requestId: req.requestId,
        module: req.apiModule,
        route: p,
        method: req.method,
        errorCode: errorCode(error),
      });
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "服务器暂不可用", requestId: req.requestId }));
      }
    };
    try {
      const result = runWithRequestContext(req, () => {
        if (p === "/api" || p.startsWith("/api/")) return apiHandler(req, res, p);
        if (amapRuntime.handlesRuntimeConfig(p)) return amapRuntime.handleRuntimeConfig(req, res);
        if (amapRuntime.handlesProxy(p)) return amapRuntime.handleProxy(req, res);
        return staticHandler(req, res, p);
      });
      if (result && typeof result.catch === "function") result.catch(fail);
    } catch (error) {
      fail(error);
    }
  });
  server.once("error", (error) => {
    logger.error("service.listen.failed", { port: PORT, errorCode: errorCode(error) });
  });
  server.listen(PORT, HOST, () => {
    logger.info("service.started", {
      port: PORT,
      host: HOST,
      dataMode: mode,
      sourceReady: !!(sourceStatus && sourceStatus.ready),
      sessionStore: String(process.env.SESSION_STORE || "memory").toLowerCase(),
    });
    if (!wechatPay.isConfigured()) {
      logger.warn("payment.configuration.incomplete", { missing: wechatPay.configurationErrors() });
    }
  });
  let shuttingDown = false;
  const shutdown = async (signal = "shutdown") => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("service.shutdown.started", { signal });
    try { await auth.close(); } catch (_) {}
    try { await permissionStore.close(); } catch (_) {}
    try { if (source && typeof source.close === "function") await source.close(); } catch (_) {}
    server.close(() => {
      logger.info("service.shutdown.completed", { signal });
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (error) => {
  logger.error("process.unhandled_rejection", { errorCode: errorCode(error) });
});

bootstrap().catch((error) => {
  logger.error("service.bootstrap.failed", { errorCode: errorCode(error) });
  process.exitCode = 1;
});
