// 按环境变量选择数据源，供 server/index.cjs 与 scripts/serve.cjs 共用。
// DATA_MODE：
//   json  （默认，开发/测试）服务器本地文件 server/data/db.json，零依赖
//   mysql （生产，宝塔装好 MySQL）配 DB_HOST/DB_USER/DB_PASSWORD/DB_NAME
//   mock  （旧演示）内存数据，重启还原
//   cloud （兼容旧）腾讯云开发，配 CLOUDBASE_ENV_ID/SECRET_ID/SECRET_KEY
const path = require("path");
const root = path.resolve(__dirname, "..", "..");

module.exports = function selectSource() {
  const DATA_MODE = process.env.DATA_MODE || "json";

  if (DATA_MODE === "cloud") {
    const envId = process.env.CLOUDBASE_ENV_ID;
    const sid = process.env.CLOUDBASE_SECRET_ID;
    const skey = process.env.CLOUDBASE_SECRET_KEY;
    if (envId && sid && skey) {
      return { source: require("./cloudSource.cjs")({ envId, secretId: sid, secretKey: skey }), mode: "cloud" };
    }
    console.warn("[data] cloud 模式但未配置密钥，回退 json 自托管");
    return { source: require("./dbSource.cjs")({ backend: "json" }), mode: "json" };
  }
  if (DATA_MODE === "mock") {
    return { source: require("./mockSource.cjs")(root), mode: "mock" };
  }
  if (DATA_MODE === "mysql") {
    return {
      source: require("./dbSource.cjs")({
        backend: "mysql",
        dbHost: process.env.DB_HOST,
        dbUser: process.env.DB_USER,
        dbPassword: process.env.DB_PASSWORD,
        dbName: process.env.DB_NAME
      }),
      mode: "mysql"
    };
  }
  // 默认 json 自托管
  const jsonFile = process.env.DB_FILE ? path.resolve(root, process.env.DB_FILE) : undefined;
  return { source: require("./dbSource.cjs")({ backend: "json", jsonFile }), mode: "json" };
};
