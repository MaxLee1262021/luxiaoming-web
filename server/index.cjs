// 鹿小鸣管理后台集成服务器（同一进程：托管后台网页 + 提供 /api 接口）
// 数据模式（环境变量 DATA_MODE）：
//   json  （默认，开发/测试）数据存在服务器本地文件 server/data/db.json，零依赖零安装
//   mysql （生产，宝塔装好 MySQL 后）DATA_MODE=mysql + DB_HOST/DB_USER/DB_PASSWORD/DB_NAME
//   mock  （旧演示）内存数据，重启还原
//   cloud （兼容旧）腾讯云开发，需 CLOUDBASE_ENV_ID/SECRET_ID/SECRET_KEY
// 启动：node server/index.cjs  （或 npm run server）
// 演示模式（默认，无需任何密钥）：接口直接返回后台现有 mock 数据
// 真实云模式（设置以下三个环境变量后自动切换）：读写小程序同一个云环境
//   CLOUDBASE_ENV_ID=cloudbase-xxxxxxxx
//   CLOUDBASE_SECRET_ID=xxxxxxxx
//   CLOUDBASE_SECRET_KEY=xxxxxxxx
// 可选：ADMIN_PASSWORD=你的后台密码（不设则演示模式任何人可进）

// 载入 .env（真实云密钥从环境变量读取，避免硬编码进代码；.env 已被 gitignore）
require("dotenv").config();
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 5192);

const { source, mode } = require("./lib/selectSource.cjs")();
const staticHandler = require("./lib/static.cjs")(root);
const apiHandler = require("./lib/api.cjs")(source, mode);

// 首次启动灌入演示数据（json/mysql 模式，且库为空时），灌完再监听端口
async function bootstrap() {
  if (mode !== "mock") {
    const seed = require("./lib/seed.cjs")(source);
    await seed().catch((e) => console.error("[seed] 失败:", e && e.message));
  }
  http
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
}

bootstrap();
