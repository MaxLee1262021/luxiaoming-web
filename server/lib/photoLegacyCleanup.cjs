"use strict";

// One-time, explicitly invoked financial cutover. The ordinary runtime only
// uses the marker readers at the bottom of this file; it never deletes data.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const B = require("./svcBenefit.cjs");
const ROOT = path.resolve(__dirname, "../..");
const SCOPE = "photographer-finance-20261111";
const FORMAT = "lxm-photo-finance-snapshot-v1";
const PHOTO_TYPES = new Set(["photo", "photographer", "摄影", "摄影师"]);
const TARGETS = Object.freeze({
  benefit_ledger: { keys: ["id"], dates: ["paid_at", "done_at", "created_at", "updated_at"] },
  photo_settlement: { keys: ["settle_id"], dates: ["dispute_until", "pushed_at", "accepted_at", "paid_at", "created_at"] },
  svc_adjust: { keys: ["id"], dates: ["created_at"] },
  svc_notification: { keys: ["id"], dates: ["next_attempt_at", "created_at", "sent_at"] },
  lxm_reconciliationTransfers: { keys: ["id"], dates: [] },
  lxm_adjustmentRecords: { keys: ["id"], dates: [] },
  lxm_reconciliation_transfer_orders: { keys: ["transfer_id", "order_no"], dates: [] },
  lxm_collection_values: { keys: ["collection_name", "record_id", "path", "ordinal"], dates: [] },
});
const REQUIRED = Object.freeze([...Object.keys(TARGETS), "photo_profile", "photo_profile_log", "lxm_staff", "svc_staff", "svc_runtime_lock"]);
const DELETE_ORDER = ["lxm_collection_values", "lxm_reconciliation_transfer_orders", "svc_notification", "svc_adjust", "benefit_ledger", "photo_settlement", "lxm_adjustmentRecords", "lxm_reconciliationTransfers"];
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(typeof value === "bigint" ? String(value) : value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function normalized(value) {
  if (value instanceof Date) throw fail("PHOTO_CLEANUP_DATE_CAST", "快照中的数据库业务时间必须以原始字符串读取");
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  return value;
}
function projection(table, dates = []) {
  return "SELECT *" + dates.map(field => `,DATE_FORMAT(\`${field}\`,'${field === "dispute_until" ? "%Y-%m-%d" : "%Y-%m-%d %H:%i:%s"}') AS \`${field}\``).join("") + ` FROM \`${table}\``;
}
const orderRows = rows => rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
const rolePhoto = row => PHOTO_TYPES.has(String(row.role || "").trim().toLowerCase());
const typePhoto = value => PHOTO_TYPES.has(String(value || "").trim().toLowerCase());
function moneyFen(value) {
  const text = String(value ?? "0");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw fail("PHOTO_CLEANUP_MONEY", "旧财务金额格式无效，需先核对");
  const [whole, decimal = ""] = text.replace(/^-/, "").split(".");
  return (BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0"))) * (text.startsWith("-") ? -1n : 1n);
}
function resetMarker(logs = []) {
  return logs.filter(row => row.photo_id === "*" && row.action === "finance_reset").map(row => {
    try {
      const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
      if (detail.scope !== SCOPE || detail.v !== 1 || !detail.cutoff_at) throw new Error("invalid marker");
      B.timestamp(detail.cutoff_at);
      return { ...detail, log_id: row.id };
    } catch (_) { throw fail("PHOTO_FINANCE_RESET_MARKER_INVALID", "摄影师存量清理标记损坏，请核对后恢复服务"); }
  }).sort((a, b) => B.timestamp(b.cutoff_at) - B.timestamp(a.cutoff_at))[0] || null;
}
function financeResetCutoff(logs = []) { return resetMarker(logs)?.cutoff_at || null; }
function isClearedOrder(order, logs = []) {
  const cutoff = financeResetCutoff(logs);
  return !!(cutoff && order && order.paid_at && B.timestamp(order.paid_at) <= B.timestamp(cutoff));
}
function pickRows(resources, cutoff) {
  const photoIds = new Set([...(resources.photo_profile || []).map(row => String(row.id)), ...(resources.lxm_staff || []).filter(rolePhoto).map(row => String(row.id))]);
  const serviceIds = new Set((resources.svc_staff || []).map(row => String(row.id)));
  const settlements = resources.photo_settlement || [];
  const settlementIds = new Set(settlements.map(row => String(row.settle_id)));
  const ledgers = (resources.benefit_ledger || []).filter(row => row.beneficiary_type === "photo");
  const ledgerNos = new Set(ledgers.map(row => String(row.biz_no)));
  const provenPhotoAdjustment = row => String(row.plan_id || "").startsWith("photo:") || settlementIds.has(String(row.settle_id || ""));
  const ambiguous = (resources.svc_adjust || []).filter(row => !provenPhotoAdjustment(row) && photoIds.has(String(row.staff_id)) && serviceIds.has(String(row.staff_id)));
  const adjustments = (resources.svc_adjust || []).filter(row => provenPhotoAdjustment(row) || photoIds.has(String(row.staff_id)) && !serviceIds.has(String(row.staff_id)));
  const transfers = (resources.lxm_reconciliationTransfers || []).filter(row => typePhoto(row.objectType));
  const legacyAdjusts = (resources.lxm_adjustmentRecords || []).filter(row => typePhoto(row.targetType));
  const transferIds = new Set(transfers.map(row => String(row.id)));
  const legacyAdjustIds = new Set(legacyAdjusts.map(row => String(row.id)));
  const future = ledgers.filter(row => !row.paid_at || B.timestamp(row.paid_at) > B.timestamp(cutoff));
  const notifications = (resources.svc_notification || []).filter(row => {
    if (!["photo_statement", "photo_payment"].includes(row.event_type)) return false;
    const prefix = row.event_type + ":";
    return String(row.event_key || "").startsWith(prefix) && settlementIds.has(String(row.event_key).slice(prefix.length)) || !!row.order_no && ledgerNos.has(String(row.order_no));
  });
  const selected = {
    benefit_ledger: ledgers, photo_settlement: settlements, svc_adjust: adjustments, svc_notification: notifications,
    lxm_reconciliationTransfers: transfers, lxm_adjustmentRecords: legacyAdjusts,
    lxm_reconciliation_transfer_orders: (resources.lxm_reconciliation_transfer_orders || []).filter(row => transferIds.has(String(row.transfer_id))),
    lxm_collection_values: (resources.lxm_collection_values || []).filter(row => row.collection_name === "reconciliationTransfers" && transferIds.has(String(row.record_id)) || row.collection_name === "adjustmentRecords" && legacyAdjustIds.has(String(row.record_id))),
  };
  for (const key of Object.keys(selected)) selected[key] = orderRows(selected[key]);
  return { rows: selected, exceptions: { ambiguous_adjustment_ids: ambiguous.map(row => String(row.id)), future_or_missing_payment_ledger_ids: future.map(row => String(row.id)), sending_notification_ids: notifications.filter(row => row.status === "sending").map(row => String(row.id)) } };
}
function summary(rows) {
  const counts = Object.fromEntries(Object.entries(rows).map(([table, records]) => [table, records.length]));
  const sum = (table, field, convert = value => BigInt(value || 0)) => rows[table].reduce((total, row) => total + convert(row[field]), 0n).toString();
  return { counts, amounts_fen: { ledger_commission: sum("benefit_ledger", "commission_fen"), settlement_payable: sum("photo_settlement", "payable_fen"), adjustment_signed: sum("svc_adjust", "amount_fen"), legacy_transfers: sum("lxm_reconciliationTransfers", "amount", moneyFen), legacy_adjustments: sum("lxm_adjustmentRecords", "amount", moneyFen) } };
}
async function readResources(conn, { lock = false } = {}) {
  if (lock) {
    const [rows] = await conn.query("SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE");
    if (rows.length !== 1) throw fail("PHOTO_CLEANUP_LOCK_MISSING", "共用事务锁未初始化，清理未执行");
  }
  const [[identity]] = await conn.query("SELECT DATABASE() AS database_name,@@hostname AS server_name,@@port AS server_port,@@lower_case_table_names AS lower_case_table_names");
  const [inventory] = await conn.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (${REQUIRED.map(() => "?").join(",")})`, REQUIRED);
  // MySQL mode 1 stores table names in lowercase, while mode 2 preserves their
  // spelling but compares names without case. Respect the server's rule when
  // checking the known camelCase legacy finance tables in its inventory.
  const tableName = value => Number(identity.lower_case_table_names) > 0 ? String(value).toLowerCase() : String(value);
  const present = new Set(inventory.map(row => tableName(row.table_name || row.TABLE_NAME)));
  const missing = REQUIRED.filter(table => !present.has(tableName(table)));
  if (missing.length) return { database_identity: sha256(canonical(identity)), missing_tables: missing };
  const resources = {};
  for (const [table, { dates }] of Object.entries(TARGETS)) {
    const [rows] = await conn.query(projection(table, dates) + (lock ? " FOR UPDATE" : ""));
    resources[table] = normalized(rows);
  }
  for (const [table, fields] of [["photo_profile", "id"], ["lxm_staff", "id,role"], ["svc_staff", "id"], ["photo_profile_log", "id,photo_id,action,detail"]]) {
    const [rows] = await conn.query(`SELECT ${fields} FROM \`${table}\`` + (lock ? " FOR UPDATE" : ""));
    resources[table] = normalized(rows);
  }
  return { database_identity: sha256(canonical(identity)), missing_tables: [], resources };
}
async function inspectCleanup(source, options = {}) {
  const cutoff = B.localTime(options.cutoff || new Date());
  return source.transaction(async conn => {
    const read = await readResources(conn);
    if (read.missing_tables.length) return { dryRun: true, ready: false, scope: SCOPE, cutoff_at: cutoff, missing_tables: read.missing_tables, tables: Object.keys(TARGETS) };
    const picked = pickRows(read.resources, cutoff), marker = resetMarker(read.resources.photo_profile_log);
    return { dryRun: true, ready: true, scope: SCOPE, cutoff_at: cutoff, ...summary(picked.rows), exceptions: picked.exceptions, already_applied: marker ? { reset_id: marker.reset_id, cutoff_at: marker.cutoff_at } : null };
  });
}
function validateSnapshot(snapshot) {
  if (snapshot.format !== FORMAT || snapshot.scope !== SCOPE || snapshot.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.database_identity || "")) throw fail("PHOTO_CLEANUP_SNAPSHOT_INVALID", "快照格式或清理范围不匹配");
  B.timestamp(snapshot.cutoff_at);
  if (!/^[a-f0-9]{32}$/.test(snapshot.snapshot_id || "")) throw fail("PHOTO_CLEANUP_SNAPSHOT_INVALID", "快照编号无效");
  if (Object.keys(snapshot.rows || {}).sort().join(",") !== Object.keys(TARGETS).sort().join(",")) throw fail("PHOTO_CLEANUP_SNAPSHOT_INVALID", "快照财务表范围不完整");
  if (canonical(summary(snapshot.rows)) !== canonical({ counts: snapshot.counts, amounts_fen: snapshot.amounts_fen })) throw fail("PHOTO_CLEANUP_SNAPSHOT_INVALID", "快照笔数或金额校验失败");
  if ((snapshot.exceptions?.future_or_missing_payment_ledger_ids || []).length) throw fail("PHOTO_CLEANUP_PAYMENT_FACTS", "存在支付时间缺失或晚于切换时刻的摄影师明细，需先核对");
  if ((snapshot.exceptions?.ambiguous_adjustment_ids || []).length) throw fail("PHOTO_CLEANUP_AMBIGUOUS_ADJUSTMENT", "存在摄影师与客服身份重叠的调账，需先明确归属，未执行清理");
  if ((snapshot.exceptions?.sending_notification_ids || []).length) throw fail("PHOTO_CLEANUP_NOTIFICATION_SENDING", "存在正在投递的摄影师通知，请等待完成后重新盘点，未执行清理");
  return snapshot;
}
async function prepareSnapshot(source, options = {}) {
  if (!options.cutoff || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(options.cutoff)) throw fail("PHOTO_CLEANUP_CUTOFF_REQUIRED", "生成快照须提供含时区的明确切换时间");
  const cutoff = B.localTime(options.cutoff), clock = options.clock ? options.clock() : new Date();
  if (B.timestamp(cutoff) > B.timestamp(clock)) throw fail("PHOTO_CLEANUP_FUTURE_CUTOFF", "切换时间不能晚于当前时间");
  return source.transaction(async conn => {
    const read = await readResources(conn);
    if (read.missing_tables.length) throw fail("PHOTO_CLEANUP_SCHEMA_MISSING", "清理所需结构未完成安装，请先核对只读检查结果");
    if (resetMarker(read.resources.photo_profile_log)) throw fail("PHOTO_CLEANUP_ALREADY_APPLIED", "本次存量已清理，不可生成新的清理范围");
    const picked = pickRows(read.resources, cutoff);
    const snapshot = { format: FORMAT, version: 1, scope: SCOPE, cutoff_at: cutoff, prepared_at: B.localTime(clock), database_identity: read.database_identity,
      ...summary(picked.rows), exceptions: picked.exceptions, rows: picked.rows };
    snapshot.snapshot_id = sha256(canonical(snapshot)).slice(0, 32);
    return validateSnapshot(snapshot);
  });
}
function markerDetail(snapshot, digest) {
  return JSON.stringify({ v: 1, scope: SCOPE, cutoff_at: snapshot.cutoff_at, snapshot_sha256: digest, reset_id: snapshot.snapshot_id });
}
async function applySnapshot(source, snapshot, options = {}) {
  validateSnapshot(snapshot);
  if (!/^[a-f0-9]{64}$/.test(options.sha256 || "")) throw fail("PHOTO_CLEANUP_HASH_REQUIRED", "执行清理须提供已核对的快照SHA256");
  if (sha256(JSON.stringify(snapshot, null, 2) + "\n") !== options.sha256) throw fail("PHOTO_CLEANUP_HASH_MISMATCH", "快照内容与提供的SHA256不一致，未执行清理");
  if (!options.operator || String(options.operator).length > 64) throw fail("PHOTO_CLEANUP_OPERATOR_REQUIRED", "执行清理须填写操作人（最多64字）");
  return source.transaction(async conn => {
    const read = await readResources(conn, { lock: true });
    if (read.missing_tables.length) throw fail("PHOTO_CLEANUP_SCHEMA_MISSING", "清理所需结构不完整，未执行删除");
    if (read.database_identity !== snapshot.database_identity) throw fail("PHOTO_CLEANUP_DATABASE_MISMATCH", "当前数据库与财务快照来源不一致，未执行删除");
    const existing = resetMarker(read.resources.photo_profile_log);
    if (existing) {
      if (existing.reset_id !== snapshot.snapshot_id || existing.snapshot_sha256 !== options.sha256) throw fail("PHOTO_CLEANUP_ALREADY_APPLIED", "本次存量清理已执行，禁止再次清除后续新增财务记录");
      return { applied: true, idempotent: true, reset_id: existing.reset_id, cutoff_at: existing.cutoff_at, ...summary(snapshot.rows) };
    }
    const selected = pickRows(read.resources, snapshot.cutoff_at);
    if (canonical(selected.rows) !== canonical(snapshot.rows) || canonical(selected.exceptions) !== canonical(snapshot.exceptions)) throw fail("PHOTO_CLEANUP_SNAPSHOT_STALE", "财务数据已在快照后变化，请重新生成和核对快照，未执行删除");
    const detail = markerDetail(snapshot, options.sha256);
    if (detail.length > 500) throw fail("PHOTO_CLEANUP_MARKER_LENGTH", "清理留痕超过存储长度");
    for (const table of DELETE_ORDER) {
      const keys = TARGETS[table].keys;
      for (const row of selected.rows[table]) {
        const [result] = await conn.query(`DELETE FROM \`${table}\` WHERE ${keys.map(key => `\`${key}\`=?`).join(" AND ")}`, keys.map(key => row[key]));
        if (Number(result.affectedRows) !== 1) throw fail("PHOTO_CLEANUP_DELETE_CONFLICT", "清理记录出现并发变化，事务已回滚");
      }
    }
    const at = B.localTime(options.clock ? options.clock() : new Date());
    await conn.query("INSERT INTO photo_profile_log (photo_id,action,detail,operator,created_at) VALUES ('*','finance_reset',?,?,?)", [detail, String(options.operator), at]);
    return { applied: true, idempotent: false, reset_id: snapshot.snapshot_id, cutoff_at: snapshot.cutoff_at, ...summary(snapshot.rows), finance_only: true };
  });
}
function outsideRepository(file, repoRoot = ROOT) {
  const target = path.resolve(file), relative = path.relative(path.resolve(repoRoot), target);
  if (!relative || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) throw fail("PHOTO_CLEANUP_BACKUP_PATH", "财务快照必须保存在代码仓库外");
  return target;
}
async function saveSnapshot(snapshot, file, options = {}) {
  validateSnapshot(snapshot);
  const target = outsideRepository(file, options.repoRoot || ROOT);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Reject a directory junction inside the repository as well as a lexical
  // path inside it; never turn restricted financial backups into source files.
  outsideRepository(await fs.realpath(path.dirname(target)), await fs.realpath(options.repoRoot || ROOT));
  const content = JSON.stringify(snapshot, null, 2) + "\n", digest = sha256(content);
  await fs.writeFile(target, content, { flag: "wx", mode: 0o600 });
  await fs.writeFile(target + ".sha256", digest + "\n", { flag: "wx", mode: 0o600 });
  return { snapshot_path: target, sha256: digest, snapshot_id: snapshot.snapshot_id, ...summary(snapshot.rows) };
}
async function loadSnapshot(file, expectedHash, options = {}) {
  const target = outsideRepository(file, options.repoRoot || ROOT);
  outsideRepository(await fs.realpath(target), await fs.realpath(options.repoRoot || ROOT));
  const content = await fs.readFile(target), digest = sha256(content);
  if (!/^[a-f0-9]{64}$/.test(expectedHash || "") || digest !== expectedHash) throw fail("PHOTO_CLEANUP_HASH_MISMATCH", "快照文件与提供的SHA256不一致，未执行清理");
  let snapshot;
  try { snapshot = JSON.parse(content.toString("utf8")); } catch (_) { throw fail("PHOTO_CLEANUP_SNAPSHOT_INVALID", "快照文件不能解析"); }
  return { snapshot: validateSnapshot(snapshot), sha256: digest };
}
function restoreSql(snapshot, digest) {
  validateSnapshot(snapshot);
  if (sha256(JSON.stringify(snapshot, null, 2) + "\n") !== digest) throw fail("PHOTO_CLEANUP_HASH_MISMATCH", "恢复快照SHA256不一致");
  const mysql = require("mysql2");
  const quote = field => "`" + String(field).replace(/`/g, "``") + "`";
  const lines = ["-- 摄影师财务清理前快照恢复；请先暂停业务写入及通知worker，核对数据库来源与SHA256。", "-- snapshot_id=" + snapshot.snapshot_id, "START TRANSACTION;", "SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE;"];
  for (const table of [...DELETE_ORDER].reverse()) for (const row of snapshot.rows[table]) {
    const fields = Object.keys(row);
    lines.push(`INSERT INTO ${quote(table)} (${fields.map(quote).join(",")}) VALUES (${fields.map(field => mysql.escape(row[field])).join(",")});`);
  }
  lines.push("DELETE FROM photo_profile_log WHERE photo_id='*' AND action='finance_reset' AND detail=" + mysql.escape(markerDetail(snapshot, digest)) + ";", "COMMIT;", "");
  return lines.join("\n");
}
module.exports = { SCOPE, FORMAT, TARGETS, REQUIRED, DELETE_ORDER, projection, canonical, sha256, pickRows, summary, inspectCleanup, prepareSnapshot, applySnapshot, saveSnapshot, loadSnapshot, financeResetCutoff, isClearedOrder, markerDetail, outsideRepository, restoreSql };
