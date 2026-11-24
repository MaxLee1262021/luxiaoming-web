"use strict";
// No database connection or configuration file is loaded in the default mode.
const fs = require("fs");
const path = require("path");
const { statements } = require("../server/lib/physicalStore.cjs");
async function main() {
  const args = new Set(process.argv.slice(2));
  if (!args.has("--apply")) { process.stdout.write(statements().join(";\n") + ";\n"); return; }
  if (!args.has("--backup-confirmed")) throw new Error("应用迁移前需完成可恢复备份并传 --backup-confirmed；默认无参数只输出SQL");
  require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
  const mysql = require("mysql2/promise");
  const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME, timezone: "Z", charset: "utf8mb4" });
  try { for (const sql of statements()) await connection.query(sql); process.stdout.write("实物交易专用表已创建；默认销售关闭，未修改历史服务订单、商品库存或业务账号。\n"); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
module.exports = { main };
