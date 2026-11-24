"use strict";

// Operator-run, idempotent installation. A dry run never opens a connection.
const path = require("node:path");
const { statements, applyStatement } = require("./migrate-customer-service.cjs");
const B = require("../server/lib/svcBenefit.cjs");
const { DEFAULT_RATES } = require("../server/lib/photoShare.cjs");
const { MENUS } = require("../server/lib/photoRoute.cjs");
const FILES = ["017_customer_service.sql", "018_service_benefit.sql", "019_photo_share.sql"];
function sameTimestamp(left, right) {
  if (!left || !right) return String(left || "") === String(right || "");
  try { return B.timestamp(left) === B.timestamp(right); } catch (_) { return String(left) === String(right); }
}
function sameLockedSnapshot(locked, original, normalized) {
  const { fen } = require("../server/lib/photoOrderBridge.cjs");
  return !!locked && sameTimestamp(locked.updatedAt, original.updatedAt)
    && String(locked.photo_id || locked.photographerId || "") === normalized.photo_id
    && fen(locked.totalAmount ?? 0) === fen(original.totalAmount ?? 0);
}
async function migrate(source, options = {}) {
  if (options.backfill) throw Object.assign(new Error("已按回传结论取消存量回填，请使用摄影师存量清理工具"),{code:"PHOTO_BACKFILL_DISABLED"});
  if (!options.apply) return { dryRun: true, migrations: FILES, initial_rates_bp: DEFAULT_RATES, enableAtRequired: true, menus: Object.keys(MENUS), backfill: false, legacyFinancePolicy:"scoped-cleanup", existingHistoryPreserved: true };
  if (!options.enableAt || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(options.enableAt)) throw new Error("请提供含时区的 --enable-at，明确上线初始比例生效时刻");
  const activeAt = B.localTime(options.enableAt);
  // MySQL DDL commits implicitly. Each statement is restartable and no existing
  // business record is deleted or rewritten by installation.
  for (const file of FILES) for (const sql of statements(path.join(__dirname, "../server/migrations", file))) await source.transaction(conn => applyStatement(conn, sql));
  const result = await source.transaction(async conn => {
    await conn.query("SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE");
    const [existing] = await conn.query("SELECT id FROM benefit_rule WHERE beneficiary_type='photo' AND party_id IS NULL");
    if (!existing.length) {
      const [[version]] = await conn.query("SELECT COALESCE(MAX(ver),0)+1 ver FROM benefit_rule");
      await conn.query("INSERT INTO benefit_rule (ver,beneficiary_type,party_id,rule_mode,rate_photo_bp,rate_video_bp,rate_combo_bp,rate_peripheral_bp,eff_at,reason,operator) VALUES (?,'photo',NULL,'global',?,?,?,?,?,'上线初始化','migration')", [version.ver, DEFAULT_RATES.rate_photo_bp, DEFAULT_RATES.rate_video_bp, DEFAULT_RATES.rate_combo_bp, DEFAULT_RATES.rate_peripheral_bp, activeAt]);
    }
    for (const [index, [key, name]] of Object.entries(MENUS).entries()) {
      await conn.query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES (?,?,?,?,?,'active',?,'page') ON DUPLICATE KEY UPDATE name=VALUES(name),meta_group=VALUES(meta_group)", ["menu_" + key, key, name, "/photo-share/" + key, 270 + index, "摄影师分成管理"]);
      // Own read-only data access requires a separately bound photographer
      // identity; this migration does not create login credentials or accounts.
      const roles = key === "photoMine" ? ["super", "photo"] : ["photoLedger", "photoSettlement"].includes(key) ? ["super", "finance"] : ["super"];
      for (const role of roles) await conn.query("INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) SELECT id,? FROM lxm_auth_roles WHERE role_key=?", [key, role]);
    }
    return { applied: true, migrations: FILES, initializedPhotoRule: !existing.length, activation: activeAt, menus: Object.keys(MENUS), backfillApplied: false };
  });
  if (options.backfill) result.backfill = await backfill(source, options);
  return result;
}
async function backfill(source, options = {}) {
  throw Object.assign(new Error("已按回传结论取消存量回填，请使用摄影师存量清理工具"),{code:"PHOTO_BACKFILL_DISABLED"});
}
async function main() {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (args.includes("--help")) { console.log("默认只读：node scripts/migrate-photo-share.cjs\n安装：--apply --enable-at 2026-11-11T00:00:00+08:00\n已按回传结论取消历史回填。存量摄影师财务数据使用 scripts/cleanup-photo-share.cjs 单独盘点和清理。"); return; }
  const options = { apply: args.includes("--apply"), enableAt: value("--enable-at"), backfill: args.includes("--backfill") };
  if (!options.apply) { console.log(JSON.stringify(await migrate(null, options), null, 2)); return; }
  require("dotenv").config({ quiet: true });
  const { source } = require("../server/lib/selectSource.cjs")();
  try { console.log(JSON.stringify(await migrate(source, options), null, 2)); } finally { await source.close?.(); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ code: error.code || "PHOTO_MIGRATION_FAILED", message: /请提供/.test(error.message) ? error.message : "迁移失败，请核对数据库版本和权限；未输出连接凭据" })); process.exitCode = 1; });
module.exports = { migrate, backfill, FILES, sameTimestamp, sameLockedSnapshot };
