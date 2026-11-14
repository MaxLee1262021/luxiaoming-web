"use strict";
const fs = require("fs");
const path = require("path");
const createSource = require("../server/lib/dbSource.cjs");
const { migrateSource } = require("../server/lib/orderFlowMigration.cjs");
const root = path.resolve(__dirname, "..");
async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    process.stdout.write("node scripts/migrate-order-flow.cjs [--mysql] [--apply]\n默认只读报告。--apply 自动备份订单；--restore=备份文件 --apply 恢复。\n");
    return;
  }
  const apply = args.includes("--apply");
  if (args.some(arg => arg.startsWith("--json"))) throw new Error("订单流程迁移只连接真实 MySQL，不再支持 JSON 文件数据源");
  const restore = args.find(arg => arg.startsWith("--restore="));
  require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
  const source = createSource({ backend: "mysql", dbHost: process.env.DB_HOST, dbPort: Number(process.env.DB_PORT || 3306), dbUser: process.env.DB_USER, dbPassword: process.env.DB_PASSWORD, dbName: process.env.DB_NAME, autoMigrate: false });
  try {
    if (restore) {
      if (!apply) throw new Error("恢复订单必须显式传 --apply");
      const backup = JSON.parse(fs.readFileSync(path.resolve(root, restore.slice(10)), "utf8"));
      if (!Array.isArray(backup.orders)) throw new Error("备份格式无效");
      for (const order of backup.orders) await source.replace("orders", String(order.id || order._id), order);
      process.stdout.write(JSON.stringify({ restored: backup.orders.length }) + "\n");
      return;
    }
    let backupFile;
    if (apply) {
      const dir = path.join(root, ".codex-tmp", "order-flow-backups");
      fs.mkdirSync(dir, { recursive: true });
      backupFile = path.join(dir, "orders-" + Date.now() + ".json");
      fs.writeFileSync(backupFile, JSON.stringify({ version: "onsite-payment-v2", orders: await source.list("orders") }), { mode: 0o600 });
    }
    const report = await migrateSource(source, { apply });
    process.stdout.write(JSON.stringify({ ...report, ...(backupFile ? { backupFile } : {}) }, null, 2) + "\n");
    if (report.conflicts.length) process.exitCode = 1;
  } finally { await source.close(); }
}
if (require.main === module) main().catch(error => { process.stderr.write("订单流程迁移失败：" + error.message + "\n"); process.exitCode = 1; });
module.exports = { main };
