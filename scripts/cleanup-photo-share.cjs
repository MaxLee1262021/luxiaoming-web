"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const cleanup = require("../server/lib/photoLegacyCleanup.cjs");
function parseArgs(args) {
  const options = {};
  const flags = { "--cutoff": "cutoff", "--snapshot": "snapshotPath", "--expect-sha256": "expectedHash", "--operator": "operator", "--restore-sql": "restorePath" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flags[flag]) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw Object.assign(new Error(flag + " 缺少参数"), { code: "PHOTO_CLEANUP_ARGUMENT" });
      options[flags[flag]] = args[++index];
    } else throw Object.assign(new Error("未知清理参数"), { code: "PHOTO_CLEANUP_ARGUMENT" });
  }
  if (options.apply && (!options.snapshotPath || !options.expectedHash || !options.operator)) throw Object.assign(new Error("执行清理须提供 --snapshot、--expect-sha256 和 --operator"), { code: "PHOTO_CLEANUP_ARGUMENT" });
  if (options.restorePath && (!options.snapshotPath || !options.expectedHash || options.apply)) throw Object.assign(new Error("导出恢复SQL须提供快照及SHA256，且不可与--apply混用"), { code: "PHOTO_CLEANUP_ARGUMENT" });
  return options;
}
// This CLI intentionally bypasses selectSource/mysqlSource.ensureSchema.
// Default inventory creates no tables and DB_AUTO_MIGRATE cannot affect it.
function directSource(options = {}) {
  const mysql = require("mysql2/promise");
  const cfg = options.config || { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME, connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 3000), dateStrings: true,
    ...(String(process.env.DB_SSL || "").toLowerCase() === "true" ? { ssl: { rejectUnauthorized: true } } : {}) };
  if (!cfg.host || !cfg.user || !cfg.database) throw Object.assign(new Error("数据库配置缺失"), { code: "PHOTO_CLEANUP_DB_CONFIG" });
  const pool = options.pool || mysql.createPool({ ...cfg, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 1, multipleStatements: false });
  return {
    async transaction(work) {
      const conn = await pool.getConnection();
      try { await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction(); const result = await work(conn); await conn.commit(); return result; }
      catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
      finally { conn.release(); }
    },
    close: () => pool.end(),
  };
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log("默认只读盘点：node scripts/cleanup-photo-share.cjs [--cutoff 含时区时间]\n生成仓库外财务快照：--cutoff 含时区时间 --snapshot 绝对路径.json\n核对后清理：--apply --snapshot 绝对路径.json --expect-sha256 已核对SHA256 --operator 操作人\n仅导出恢复SQL：--snapshot 绝对路径.json --expect-sha256 SHA256 --restore-sql 仓库外路径.sql\n只清理摄影师财务；保留订单履约、档案、账号、规则及客服/商家财务。恢复SQL不自动执行。");
    return;
  }
  if (options.restorePath) {
    const loaded = await cleanup.loadSnapshot(options.snapshotPath, options.expectedHash);
    const target = cleanup.outsideRepository(options.restorePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    cleanup.outsideRepository(await fs.realpath(path.dirname(target)));
    await fs.writeFile(target, cleanup.restoreSql(loaded.snapshot, loaded.sha256), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ restore_sql_path: target, execution: false, snapshot_id: loaded.snapshot.snapshot_id }, null, 2));
    return;
  }
  require("dotenv").config({ quiet: true });
  const source = directSource();
  try {
    let result;
    if (options.apply) {
      const loaded = await cleanup.loadSnapshot(options.snapshotPath, options.expectedHash);
      result = await cleanup.applySnapshot(source, loaded.snapshot, { sha256: loaded.sha256, operator: options.operator });
    } else if (options.snapshotPath) result = await cleanup.saveSnapshot(await cleanup.prepareSnapshot(source, options), options.snapshotPath);
    else result = await cleanup.inspectCleanup(source, options);
    console.log(JSON.stringify(result, null, 2));
  } finally { await source.close(); }
}
if (require.main === module) main().catch(error => {
  const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(String(error.code || "")) ? error.code : "PHOTO_CLEANUP_FAILED";
  console.error(JSON.stringify({ code, message: code.startsWith("PHOTO_CLEANUP_") || code === "PHOTO_FINANCE_RESET_MARKER_INVALID" ? error.message : "摄影师财务盘点或清理失败，请核对数据库结构及权限；未输出连接凭据" }));
  process.exitCode = 1;
});
module.exports = { parseArgs, directSource, main };
