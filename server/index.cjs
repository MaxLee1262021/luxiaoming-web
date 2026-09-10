// 鹿小鸣管理后台集成服务器（同一进程：托管后台网页 + 提供 /api 接口）
// 数据模式（环境变量 DATA_MODE）：
//   json  （默认，开发/测试）数据存在服务器本地文件 server/data/db.json，零依赖零安装
//   mysql （生产，宝塔装好 MySQL 后）DATA_MODE=mysql + DB_HOST/DB_USER/DB_PASSWORD/DB_NAME
//   mock  （旧演示）内存数据，重启还原
//   cloud （兼容旧）腾讯云开发，需 CLOUDBASE_ENV_ID/SECRET_ID/SECRET_KEY
// 启动：node server/index.cjs  （或 npm run server）
// 默认不自动灌入演示数据。需要种子时必须显式设置 SEED_DEMO_DATA=true。
// 管理 API 使用 server-side Bearer sessions；Redis 通过 REDIS_URL 可选启用。

// 载入 .env（真实云密钥从环境变量读取，避免硬编码进代码；.env 已被 gitignore）
require("dotenv").config();
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 5192);

const selected = require("./lib/selectSource.cjs")();
const { source, mode, status: sourceStatus } = selected;
const { createAuthStore } = require("./lib/auth.cjs");
const createPermissionStore = require("./lib/permissionStore.cjs");
const staticHandler = require("./lib/static.cjs")(root);
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
const apiHandler = require("./lib/api.cjs")(source, mode, { auth, permissionStore, sourceStatus });

// Demo seed is an explicit local operation. Production MySQL/cloud never gets
// seeded implicitly, and an unavailable source is never replaced by mock data.
async function bootstrap() {
  if (process.env.SEED_DEMO_DATA === "true" && mode === "json" && sourceStatus && sourceStatus.ready !== false) {
    const seed = require("./lib/seed.cjs")(source);
    await seed().catch((e) => console.error("[seed] 失败:", e && e.message));
  }
  const server = http
    .createServer((req, res) => {
      const p = (req.url || "/").split("?")[0];
      if (p.startsWith("/api/")) return apiHandler(req, res, p);
      return staticHandler(req, res, p);
    })
    .listen(PORT, "0.0.0.0", () => {
      console.log(
        `鹿小鸣管理后台(含接口)已启动: http://127.0.0.1:${PORT}/  [数据模式: ${mode}]`
      );
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
