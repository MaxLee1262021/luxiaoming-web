const http = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 5192);
const host = "127.0.0.1";

// Runtime API data is always served from MySQL. JSON is limited to isolated
// Node test fixtures by the source selector.
const selected = require(path.join(root, "server/lib/selectSource.cjs"))();
const { source, mode, status: sourceStatus } = selected;
const { createAuthStore } = require(path.join(root, "server/lib/auth.cjs"));
const createPermissionStore = require(path.join(root, "server/lib/permissionStore.cjs"));
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
});
const apiHandler = require(path.join(root, "server/lib/api.cjs"))(source, mode, { auth, permissionStore, sourceStatus });
const staticHandler = require(path.join(root, "server/lib/static.cjs"))(root);
const amapRuntime = require(path.join(root, "server/lib/amapRuntime.cjs")).createAmapRuntime();

async function bootstrap() {
  if (process.argv.includes("--check-only")) {
    const entry = path.join(root, "index.html");
    if (!fs.existsSync(entry)) {
      console.error("index.html not found");
      process.exit(1);
    }
    console.log("Static admin project structure check passed.");
    process.exit(0);
  }

  const server = http
    .createServer((req, res) => {
      const p = (req.url || "/").split("?")[0];
      if (p.startsWith("/api/")) return apiHandler(req, res, p);
      if (amapRuntime.handlesRuntimeConfig(p)) return amapRuntime.handleRuntimeConfig(req, res);
      if (amapRuntime.handlesProxy(p)) return amapRuntime.handleProxy(req, res);
      return staticHandler(req, res, p);
    })
    .listen(port, host, () => {
      console.log(`鹿小鸣管理后台已启动: http://${host}:${port}/  [数据模式: ${mode}]`);
    });
  const shutdown = async () => {
    try { await auth.close(); } catch (_) {}
    try { await permissionStore.close(); } catch (_) {}
    try { if (source && typeof source.close === "function") await source.close(); } catch (_) {}
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

bootstrap();
