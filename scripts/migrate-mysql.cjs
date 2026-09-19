"use strict";

// Idempotent MySQL migration for the admin delivery package.  Main collection
// rows are written as scalar columns; arrays and nested objects are materialized
// into relation/attribute rows by mysqlSchema.  The legacy `doc` column is only
// read during an explicit cutover and is removed after a successful conversion.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true }); } catch (_) {}

const mysql = require("mysql2/promise");
const schema = require("../server/lib/mysqlSchema.cjs");

const root = path.resolve(__dirname, "..");
const schemaFile = path.join(root, "server", "migrations", "001_authz.sql");
const defaultJsonFile = path.join(root, "server", "data", "db.json");
const businessKeys = schema.ALL_KEYS;
const accountKeys = new Set(["staff", "shops", "distributors", "agents"]);
const args = new Set(process.argv.slice(2));
const mode = args.has("--rollback") ? "rollback" : args.has("--apply") ? "apply" : "dry-run";
const importFixture = args.has("--import-fixture");
const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
function metadataValue(row, name) {
  if (!row || typeof row !== "object") return undefined;
  return row[name] ?? row[String(name).toUpperCase()];
}

function usage() {
  process.stdout.write([
    "Usage: node scripts/migrate-mysql.cjs [--dry-run|--apply|--rollback] [--confirm]",
    "       add --import-fixture only when intentionally seeding the demo fixture",
    "Environment: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, JSON_FILE",
    "--dry-run is the default. --rollback requires --confirm and only drops named lxm_* tables."
  ].join("\n") + "\n");
}

function config() {
  const database = env("DB_NAME", env("MYSQL_DATABASE", "luxiaoming_admin"));
  return {
    host: env("DB_HOST", env("MYSQL_HOST", "127.0.0.1")),
    port: Number(env("DB_PORT", env("MYSQL_PORT", "3306"))),
    user: env("DB_USER", env("MYSQL_USER", "root")),
    password: process.env.DB_PASSWORD ?? process.env.MYSQL_PASSWORD ?? "",
    database,
    connectTimeout: 5000,
    multipleStatements: false
  };
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || !value.collections || typeof value.collections !== "object" || Array.isArray(value.collections)) throw new Error("invalid");
    for (const [key, collection] of Object.entries(value.collections)) if (collection === null || typeof collection !== "object" || Array.isArray(collection)) throw new Error(`invalid collection: ${key}`);
    for (const key of Object.keys(value.collections)) if (!businessKeys.includes(key)) throw new Error(`unknown collection: ${key}`);
    return value;
  } catch (error) {
    if (error && error.code === "ENOENT") return { collections: {} };
    throw Object.assign(new Error("JSON 数据文件无效"), { code: "DATA_SOURCE_INVALID" });
  }
}

function readStaticConfig() {
  const file = path.join(root, "src", "config", "business-config.js");
  if (!fs.existsSync(file)) return {};
  const sandbox = { window: {}, console, Date, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  return sandbox.window.LXM_CONFIG || {};
}

function sourceRows(data, key, keepCredentials = false) {
  const value = data.collections && data.collections[key];
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`集合 ${key} 格式无效`), { code: "DATA_SOURCE_INVALID" });
  return Object.entries(value).map(([fallbackId, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error(`集合 ${key} 含有无效记录`), { code: "DATA_SOURCE_INVALID" });
    const doc = { ...raw };
    const id = String(doc.id || doc._id || (key === "orders" && doc.orderId) || fallbackId);
    doc.id = id;
    delete doc._id;
    if (!keepCredentials && accountKeys.has(key)) {
      delete doc.password;
      delete doc.passwordHash;
      delete doc.password_hash;
    }
    return { id, doc };
  });
}

function parseLegacy(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch (_) { throw Object.assign(new Error("旧 MySQL 记录格式无效"), { code: "DATA_SOURCE_INVALID" }); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("旧 MySQL 记录格式无效"), { code: "DATA_SOURCE_INVALID" });
  return value;
}

async function preflightLegacyPayloads(conn) {
  for (const key of businessKeys) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const columns = await tableColumns(conn, table);
    if (!columns.has("doc")) continue;
    const rows = await query(conn, `SELECT id,${quote("doc")} FROM ${quote(table)} ORDER BY id`);
    for (const row of rows) {
      const document = parseLegacy(row.doc);
      if (!String(row.id || document.id || document._id || "")) throw Object.assign(new Error(`旧表 ${table} 存在空主键`), { code: "MIGRATION_VERIFY_FAILED" });
    }
  }
  if (await tableExists(conn, "lxm_business_documents")) {
    const rows = await query(conn, "SELECT collection_name,id,doc FROM lxm_business_documents ORDER BY collection_name,id");
    for (const row of rows) {
      if (!businessKeys.includes(String(row.collection_name))) throw Object.assign(new Error(`旧聚合表包含未知集合: ${String(row.collection_name)}`), { code: "MIGRATION_VERIFY_FAILED" });
      const document = parseLegacy(row.doc);
      if (!String(row.id || document.id || document._id || "")) throw Object.assign(new Error("旧聚合表存在空主键"), { code: "MIGRATION_VERIFY_FAILED" });
    }
  }
  if (await tableExists(conn, "lxm_auth_menus")) {
    const columns = await tableColumns(conn, "lxm_auth_menus");
    if (columns.has("meta")) for (const row of await query(conn, "SELECT id,meta FROM lxm_auth_menus")) if (row.meta != null) parseLegacy(row.meta);
  }
  if (await tableExists(conn, "lxm_auth_users")) {
    const columns = await tableColumns(conn, "lxm_auth_users");
    if (columns.has("extra")) for (const row of await query(conn, "SELECT id,extra FROM lxm_auth_users")) if (row.extra != null) parseLegacy(row.extra);
  }
}

function quote(value) { return schema.quoteIdentifier(value); }
function relationColumnNames(definition) { return definition.columns.map((column) => String(column).trim().split(/\s+/, 1)[0]); }
function relationParent(name) {
  if (name === "account_permissions") return ["collection_name", "account_id"];
  if (name === "collection_values") return ["collection_name", "record_id"];
  if (name === "trash_source_attributes") return ["trash_id"];
  const definition = schema.RELATIONS[name];
  return definition ? [relationColumnNames(definition)[0]] : [];
}

async function query(conn, sql, params = []) { const [rows] = await conn.query(sql, params); return rows; }
async function execute(conn, sql, params = []) { const [result] = await conn.query(sql, params); return result; }

function sqlRow(key, id, columns) {
  const definition = schema.definition(key);
  const row = { id: String(id) };
  for (const column of definition.columns) {
    if (column.name === "id") continue;
    if (!Object.prototype.hasOwnProperty.call(columns, column.name)) continue;
    const value = columns[column.name];
    if (value === undefined || value === null) row[column.name] = null;
    else if (/TINYINT/i.test(column.type)) row[column.name] = value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true" ? 1 : 0;
    else if (/(?:INT|DECIMAL)/i.test(column.type)) { const number = Number(value); row[column.name] = Number.isFinite(number) ? number : null; }
    else {
      row[column.name] = value instanceof Date ? value.toISOString() : value;
      if (/\bTEXT\b/i.test(column.type) && typeof row[column.name] === "string" && Buffer.byteLength(row[column.name], "utf8") > 60000) throw Object.assign(new Error(`字段 ${column.name} 内容过大`), { code: "DATA_TOO_LARGE" });
    }
  }
  return row;
}

async function deleteRelations(conn, key, id) {
  for (const name of schema.relationNames(key)) {
    const relation = schema.relationDefinition(name);
    const parent = relationParent(name);
    if (!parent.length) continue;
    const where = name === "account_permissions"
      ? "collection_name=? AND account_id=?"
      : `${quote(parent[0])}=?`;
    const params = name === "account_permissions" ? [key, id] : [id];
    await execute(conn, `DELETE FROM ${quote(relation.table)} WHERE ${where}`, params);
  }
  const values = schema.RELATIONS.collection_values;
  await execute(conn, `DELETE FROM ${quote(values.table)} WHERE collection_name=? AND record_id=?`, [key, id]);
}

function insertStatement(table, row, duplicate = true) {
  const names = Object.keys(row);
  const columns = names.map(quote).join(",");
  const placeholders = names.map(() => "?").join(",");
  const updates = names.filter((name) => name !== "id").map((name) => `${quote(name)}=VALUES(${quote(name)})`);
  if (duplicate) updates.push("updated_at=CURRENT_TIMESTAMP(3)");
  if (duplicate && !updates.length) updates.push("id=id");
  const suffix = duplicate && updates.length ? ` ON DUPLICATE KEY UPDATE ${updates.join(",")}` : "";
  return { sql: `INSERT INTO ${quote(table)} (${columns}) VALUES (${placeholders})${suffix}`, params: names.map((name) => row[name]) };
}

function relationStatement(definition, row) {
  const names = relationColumnNames(definition).filter((name) => Object.prototype.hasOwnProperty.call(row, name));
  const updates = names.slice(1).map((name) => `${quote(name)}=VALUES(${quote(name)})`);
  return {
    sql: `INSERT INTO ${quote(definition.table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})${updates.length ? ` ON DUPLICATE KEY UPDATE ${updates.join(",")}` : ""}`,
    params: names.map((name) => row[name])
  };
}

async function writeNormalized(conn, key, id, document, duplicate = true) {
  const split = schema.splitDocument(key, { ...(document || {}), id });
  const row = sqlRow(key, id, split.columns);
  const statement = insertStatement(schema.tableName(key), row, duplicate);
  await execute(conn, statement.sql, statement.params);
  await deleteRelations(conn, key, id);
  for (const [name, rows] of Object.entries(split.relations || {})) {
    const definition = schema.relationDefinition(name);
    for (const relationRow of rows || []) {
      const item = relationStatement(definition, relationRow);
      await execute(conn, item.sql, item.params);
    }
  }
  const values = schema.RELATIONS.collection_values;
  for (const attribute of split.attributes || []) {
    const attributePath = String(attribute.path || "");
    if (attributePath.length > 512) throw Object.assign(new Error("属性路径超过 512 字符"), { code: "SCHEMA_PATH_TOO_LONG" });
    const rowValue = {
      collection_name: key,
      record_id: id,
      path: attributePath,
      ordinal: Number.isInteger(attribute.ordinal) ? attribute.ordinal : 0,
      value_type: String(attribute.value_type || "string").slice(0, 16),
      value_text: attribute.value_text === undefined ? null : attribute.value_text,
      value_number: attribute.value_number === undefined ? null : attribute.value_number,
      value_bool: attribute.value_bool === undefined ? null : attribute.value_bool,
      value_time: attribute.value_time === undefined ? null : attribute.value_time
    };
    if (!rowValue.path) continue;
    const item = relationStatement(values, rowValue);
    await execute(conn, item.sql, item.params);
  }
  return row;
}

async function tableColumns(conn, table) {
  const rows = await query(conn, "SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=?", [table]);
  return new Set(rows.map((row) => String(metadataValue(row, "column_name") || "")).filter(Boolean));
}
async function tableExists(conn, table) {
  const rows = await query(conn, "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1", [table]);
  return rows.length > 0;
}
async function addMissingBusinessColumns(conn, key, columns) {
  const table = schema.tableName(key);
  const definition = schema.definition(key);
  for (const column of definition.columns) {
    if (columns.has(column.name)) continue;
    await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column.name)} ${column.type}`);
    columns.add(column.name);
  }
  if (!columns.has("created_at")) { await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`); columns.add("created_at"); }
  else {
    await execute(conn, `UPDATE ${quote(table)} SET created_at=CURRENT_TIMESTAMP(3) WHERE created_at IS NULL`);
    await execute(conn, `ALTER TABLE ${quote(table)} MODIFY COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
  }
  if (!columns.has("updated_at")) { await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`); columns.add("updated_at"); }
  else {
    await execute(conn, `UPDATE ${quote(table)} SET updated_at=CURRENT_TIMESTAMP(3) WHERE updated_at IS NULL`);
    await execute(conn, `ALTER TABLE ${quote(table)} MODIFY COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
  }
}

async function ensureNormalizedMainColumns(conn) {
  for (const key of businessKeys) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const columns = await tableColumns(conn, table);
    if (!columns.has("id")) throw Object.assign(new Error(`规范化表 ${table} 缺少主键列 id`), { code: "MIGRATION_VERIFY_FAILED" });
    for (const column of schema.definition(key).columns) {
      if (columns.has(column.name) || column.name === "id") continue;
      await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column.name)} ${column.type}`);
      columns.add(column.name);
    }
    if (!columns.has("created_at")) await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    else {
      await execute(conn, `UPDATE ${quote(table)} SET created_at=CURRENT_TIMESTAMP(3) WHERE created_at IS NULL`);
      await execute(conn, `ALTER TABLE ${quote(table)} MODIFY COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    }
    if (!columns.has("updated_at")) await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    else {
      await execute(conn, `UPDATE ${quote(table)} SET updated_at=CURRENT_TIMESTAMP(3) WHERE updated_at IS NULL`);
      await execute(conn, `ALTER TABLE ${quote(table)} MODIFY COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    }
  }
  for (const relation of Object.values(schema.RELATIONS)) {
    if (!(await tableExists(conn, relation.table))) continue;
    const columns = await tableColumns(conn, relation.table);
    for (const declaration of relation.columns) {
      const text = String(declaration).trim();
      const name = text.split(/\s+/, 1)[0];
      if (columns.has(name)) continue;
      // Only add nullable/defaulted columns in place. Missing key columns need
      // a reviewed table rebuild because existing rows cannot be backfilled
      // safely from an implicit value.
      if (!/\bNULL\b|\bDEFAULT\b/i.test(text)) throw Object.assign(new Error(`关系表 ${relation.table} 缺少必需列: ${name}`), { code: "MIGRATION_VERIFY_FAILED" });
      await execute(conn, `ALTER TABLE ${quote(relation.table)} ADD COLUMN ${quote(name)} ${text.slice(name.length).trim()}`);
      columns.add(name);
    }
  }
}

async function ensureNormalizedIndexes(conn) {
  for (const key of businessKeys) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const rows = await query(conn, "SELECT index_name,column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=?", [table]);
    if (!rows.some((row) => String(metadataValue(row, "column_name") || "").toLowerCase() === "updatedat")) {
      const name = rows.some((row) => String(metadataValue(row, "index_name") || "").toLowerCase() === "idx_updated_at") ? "idx_updated_at_normalized" : "idx_updated_at";
      await execute(conn, `ALTER TABLE ${quote(table)} ADD KEY ${quote(name)} (${quote("updatedAt")})`);
    }
  }
  if (await tableExists(conn, "lxm_auth_users")) {
    const rows = await query(conn, "SELECT index_name,column_name,seq_in_index FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='lxm_auth_users'");
    const subject = rows.filter((row) => String(metadataValue(row, "column_name") || "").toLowerCase() === "subject_type" || String(metadataValue(row, "column_name") || "").toLowerCase() === "subject_id");
    if (!subject.length) await execute(conn, "ALTER TABLE lxm_auth_users ADD KEY idx_auth_user_subject (subject_type,subject_id)");
  }
  // These identities make booking retries and payment callbacks durable across
  // multiple Node instances. Blank historical values are normalized to NULL so
  // MySQL unique indexes retain their normal nullable semantics.
  async function uniqueIdentity(table, column, indexName) {
    if (!(await tableExists(conn, table))) return;
    const columns = await tableColumns(conn, table);
    if (!columns.has(column)) return;
    await execute(conn, `UPDATE ${quote(table)} SET ${quote(column)}=NULL WHERE ${quote(column)}=''`);
    const duplicates = await query(conn, `SELECT ${quote(column)} AS value_text,COUNT(*) AS count FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL GROUP BY ${quote(column)} HAVING COUNT(*)>1 LIMIT 1`);
    if (duplicates.length) throw Object.assign(new Error(`${table}.${column} 存在重复幂等标识，不能安全建立唯一索引`), { code: "MIGRATION_VERIFY_FAILED" });
    const indexes = await query(conn, "SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?", [table, indexName]);
    if (!indexes.length) await execute(conn, `ALTER TABLE ${quote(table)} ADD UNIQUE KEY ${quote(indexName)} (${quote(column)})`);
  }
  await uniqueIdentity("lxm_orders", "bookingIdempotencyKey", "uq_order_booking_idempotency");
  await uniqueIdentity("lxm_orders", "orderNo", "uq_order_number");
  for (const [column, indexName] of [
    ["payment_id", "uq_order_payment_id"],
    ["idempotency_key", "uq_order_payment_idempotency"],
    ["confirmation_idempotency_key", "uq_order_payment_confirmation_key"],
    ["external_transaction_id", "uq_order_payment_transaction"],
  ]) await uniqueIdentity("lxm_order_payment_records", column, indexName);
}

async function migrateLegacyBusiness(conn) {
  const plans = [];
  for (const key of businessKeys) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const columns = await tableColumns(conn, table);
    if (!columns.has("doc")) continue;
    const rows = await query(conn, `SELECT id,${quote("doc")} FROM ${quote(table)} ORDER BY id`);
    const parsed = rows.map((row) => {
      const document = parseLegacy(row.doc);
      const id = String(row.id || document.id || document._id || (key === "orders" && document.orderId) || "");
      if (!id) throw Object.assign(new Error(`旧表 ${table} 存在空主键`), { code: "MIGRATION_VERIFY_FAILED" });
      document.id = id;
      return { id, document };
    });
    plans.push({ key, table, columns, rows: parsed });
  }
  let aggregate = null;
  if (await tableExists(conn, "lxm_business_documents")) {
    const rows = await query(conn, "SELECT collection_name,id,doc FROM lxm_business_documents ORDER BY collection_name,id");
    const parsed = rows.map((row) => {
      if (!businessKeys.includes(String(row.collection_name))) throw Object.assign(new Error(`旧聚合表包含未知集合: ${String(row.collection_name)}`), { code: "MIGRATION_VERIFY_FAILED" });
      const document = parseLegacy(row.doc);
      const id = String(row.id || document.id || document._id || (String(row.collection_name) === "orders" && document.orderId) || "");
      if (!id) throw Object.assign(new Error("旧聚合表存在空主键"), { code: "MIGRATION_VERIFY_FAILED" });
      document.id = id;
      return { key: String(row.collection_name), id, document };
    });
    aggregate = parsed;
  }
  const transaction = async (work) => {
    if (typeof conn.beginTransaction !== "function") return work();
    await conn.beginTransaction();
    try { const result = await work(); await conn.commit(); return result; }
    catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
  };
  let converted = 0;
  for (const plan of plans) {
    await addMissingBusinessColumns(conn, plan.key, plan.columns);
    // A legacy NOT NULL payload column blocks an INSERT ... ON DUPLICATE KEY
    // UPDATE even when the id already exists. Make it nullable during the
    // controlled write; it is dropped only after verification succeeds.
    await execute(conn, `ALTER TABLE ${quote(plan.table)} MODIFY COLUMN ${quote("doc")} TEXT NULL`);
    await transaction(async () => {
      for (const row of plan.rows) await writeNormalized(conn, plan.key, row.id, row.document, true);
      if (plan.rows.length) {
        const ids = plan.rows.map((row) => row.id);
        const check = await query(conn, `SELECT COUNT(*) AS count FROM ${quote(plan.table)} WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
        if (Number(check[0] && check[0].count || 0) !== plan.rows.length) throw Object.assign(new Error(`旧表 ${plan.table} 迁移校验失败`), { code: "MIGRATION_VERIFY_FAILED" });
      }
    });
    await execute(conn, `ALTER TABLE ${quote(plan.table)} DROP COLUMN ${quote("doc")}`);
    converted += plan.rows.length;
  }
  if (aggregate) {
    await transaction(async () => {
      for (const row of aggregate) await writeNormalized(conn, row.key, row.id, row.document, true);
    });
    await execute(conn, "DROP TABLE IF EXISTS lxm_business_documents");
    converted += aggregate.length;
  }
  return converted;
}

async function migrateLegacyLogSnapshot(conn) {
  const table = schema.tableName("logs");
  if (!(await tableExists(conn, table))) return 0;
  let columns = await tableColumns(conn, table);
  if (!columns.has("snapshot")) {
    if (!columns.has("snapshotText")) await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN snapshotText VARCHAR(500) NULL`);
    return 0;
  }
  if (!columns.has("snapshotText")) {
    await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN snapshotText VARCHAR(500) NULL`);
    columns = await tableColumns(conn, table);
  }
  const rows = await query(conn, `SELECT id,${quote("snapshot")} FROM ${quote(table)} ORDER BY id`);
  // Validate every value before mutating rows. Unknown JSON-shaped snapshots
  // must stop the migration instead of being silently downgraded to text.
  const converted = rows.map((row) => {
    const normalized = schema.normalizeLogSnapshot(row.snapshot);
    if (normalized.kind === "text") {
      const text = row.snapshot == null ? null : String(normalized.text || "");
      if (text != null && text.length > 500) throw Object.assign(new Error(`日志 ${row.id} 的快照摘要超过 500 字`), { code: "LOG_SNAPSHOT_TOO_LONG" });
      return { id: String(row.id), text, relation: null };
    }
    return { id: String(row.id), text: null, relation: schema.logSnapshotRelation(row.id, row.snapshot) };
  });
  const run = async (work) => {
    if (typeof conn.beginTransaction !== "function") return work();
    await conn.beginTransaction();
    try { const result = await work(); await conn.commit(); return result; }
    catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
  };
  await run(async () => {
    const relation = schema.relationDefinition("log_order_exception_snapshots");
    const relationColumns = relation.columns.map((column) => String(column).trim().split(/\s+/, 1)[0]);
    for (const item of converted) {
      if (item.relation) {
        const names = relationColumns.filter((name) => Object.prototype.hasOwnProperty.call(item.relation, name));
        await execute(conn, `INSERT INTO ${quote(relation.table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")}) ON DUPLICATE KEY UPDATE ${names.filter((name) => name !== "log_id").map((name) => `${quote(name)}=VALUES(${quote(name)})`).join(",")}`, names.map((name) => item.relation[name]));
      } else await execute(conn, `DELETE FROM ${quote(relation.table)} WHERE log_id=?`, [item.id]);
      await execute(conn, `UPDATE ${quote(table)} SET snapshotText=? WHERE id=?`, [item.text, item.id]);
    }
  });
  await execute(conn, `ALTER TABLE ${quote(table)} DROP COLUMN ${quote("snapshot")}`);
  return converted.length;
}

async function cleanFinanceSettingAttributes(conn) {
  // financeSettings is a closed singleton whose supported values are scalar
  // columns. Remove any historical typed leaves (including values copied from
  // siteConfig by the old fallback path) before verification and future writes.
  const table = schema.RELATIONS.collection_values.table;
  if (!(await tableExists(conn, table))) return 0;
  const result = await execute(conn, `DELETE FROM ${quote(table)} WHERE collection_name=?`, ["financeSettings"]);
  return Number(result && result.affectedRows || 0);
}

async function normalizeFinanceSingleton(conn) {
  const table = schema.tableName("financeSettings");
  if (!(await tableExists(conn, table))) return { attributesRemoved: 0, fragmentsRemoved: 0 };
  const rows = await query(conn, `SELECT id,settlementObservationDays,largeSettlementThreshold,currency FROM ${quote(table)} ORDER BY id`);
  let global = rows.find((row) => String(row.id) === "global");
  if (!global) {
    // Older fixture imports represented singleton values as one row per field.
    // Fold only the three supported scalar fields into the canonical row.
    const values = { settlementObservationDays: null, largeSettlementThreshold: null, currency: null };
    for (const row of rows) {
      const id = String(row.id || "");
      if (Object.prototype.hasOwnProperty.call(values, id) && row[id] != null) values[id] = row[id];
    }
    await execute(conn, `INSERT INTO ${quote(table)} (id,settlementObservationDays,largeSettlementThreshold,currency) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE settlementObservationDays=VALUES(settlementObservationDays),largeSettlementThreshold=VALUES(largeSettlementThreshold),currency=VALUES(currency)`, ["global", values.settlementObservationDays == null ? 3 : values.settlementObservationDays, values.largeSettlementThreshold == null ? 5000 : values.largeSettlementThreshold, values.currency]);
    global = { id: "global", ...values };
  } else {
    const days = global.settlementObservationDays == null ? 3 : global.settlementObservationDays;
    const threshold = global.largeSettlementThreshold == null ? 5000 : global.largeSettlementThreshold;
    if (global.settlementObservationDays == null || global.largeSettlementThreshold == null) await execute(conn, `UPDATE ${quote(table)} SET settlementObservationDays=?,largeSettlementThreshold=? WHERE id=?`, [days, threshold, "global"]);
  }
  const fragments = await execute(conn, `DELETE FROM ${quote(table)} WHERE id<>?`, ["global"]);
  const attributesRemoved = await cleanFinanceSettingAttributes(conn);
  return { attributesRemoved, fragmentsRemoved: Number(fragments && fragments.affectedRows || 0) };
}

async function backfillCityIds(conn) {
  const cityTable = schema.tableName("cities");
  if (!(await tableExists(conn, cityTable))) return 0;
  const cities = await query(conn, `SELECT id,cityId,code,name FROM ${quote(cityTable)}`);
  const aliases = new Map();
  for (const city of cities) {
    const id = String(city.id || city.cityId || "");
    if (!id) continue;
    for (const value of [city.id, city.cityId, city.code, city.name, city.city]) if (value != null && String(value) !== "") aliases.set(String(value), id);
  }
  if (!aliases.size) return 0;
  let updated = 0;
  for (const key of ["agents", "distributors", "shops", "staff", "spots"]) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const columns = await tableColumns(conn, table);
    const sourceField = columns.has("city") ? "city" : columns.has("name") ? "name" : "";
    if (!sourceField) continue;
    const rows = await query(conn, `SELECT id,cityId,${quote(sourceField)} AS city_value FROM ${quote(table)} WHERE cityId IS NULL OR cityId=''`);
    for (const row of rows) {
      const cityId = aliases.get(String(row.city_value || ""));
      if (!cityId) continue;
      const result = await execute(conn, `UPDATE ${quote(table)} SET cityId=? WHERE id=? AND (cityId IS NULL OR cityId='')`, [cityId, row.id]);
      updated += Number(result && result.affectedRows || 0);
    }
  }
  return updated;
}

async function cleanOrphanCollectionValues(conn) {
  const valuesTable = schema.RELATIONS.collection_values.table;
  if (!(await tableExists(conn, valuesTable))) return 0;
  let removed = 0;
  for (const key of businessKeys) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const result = await execute(conn, `DELETE values_row FROM ${quote(valuesTable)} values_row LEFT JOIN ${quote(table)} parent_row ON parent_row.id=values_row.record_id WHERE values_row.collection_name=? AND parent_row.id IS NULL`, [key]);
    removed += Number(result && result.affectedRows || 0);
  }
  return removed;
}

async function normalizedRelationRows(conn, key, id) {
  const output = {
    collection_values: await query(conn,
      `SELECT collection_name,record_id,path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM ${quote(schema.RELATIONS.collection_values.table)} WHERE collection_name=? AND record_id=? ORDER BY path,ordinal`,
      [key, id])
  };
  for (const name of schema.relationNames(key)) {
    const relation = schema.relationDefinition(name);
    const parent = relationParent(name);
    if (!relation || !parent.length) continue;
    if (name === "account_permissions") {
      output[name] = await query(conn, `SELECT * FROM ${quote(relation.table)} WHERE collection_name=? AND account_id=? ORDER BY sort_no`, [key, id]);
      continue;
    }
    const order = relationColumnNames(relation).filter((column) => /(?:sort_no|item_no|record_no|log_no|tag_no|nav_no|banner_no|notice_no|word_no|image_no|spec_no)$/i.test(column));
    output[name] = await query(conn, `SELECT * FROM ${quote(relation.table)} WHERE ${quote(parent[0])}=?${order.length ? ` ORDER BY ${order.map(quote).join(",")}` : ""}`, [id]);
  }
  return output;
}

// Earlier cutovers left a small number of modeled aliases and empty relation
// arrays in the generic typed-leaf lane. Rewriting these records through the
// current mapper makes the relationship tables authoritative exactly once.
async function normalizeMaterializedDocuments(conn) {
  const keys = ["homeConfig", "orders", "shops", "staff", "agents", "distributors"];
  let rewritten = 0;
  for (const key of keys) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const rows = await query(conn, `SELECT * FROM ${quote(table)} ORDER BY id`);
    for (const row of rows) {
      const id = String(row.id || "");
      if (!id) continue;
      const document = schema.hydrateDocument(key, row, await normalizedRelationRows(conn, key, id));
      await writeNormalized(conn, key, id, document, true);
      rewritten += 1;
    }
  }
  return rewritten;
}

async function normalizeLifecycleFlags(conn) {
  let updated = 0;
  for (const key of businessKeys) {
    const table = schema.tableName(key);
    if (!(await tableExists(conn, table))) continue;
    const columns = await tableColumns(conn, table);
    if (!columns.has("deleted") || !columns.has("isDeleted")) continue;
    const result = await execute(conn, `UPDATE ${quote(table)} SET deleted=CASE WHEN deleted=1 OR isDeleted=1 THEN 1 ELSE 0 END,isDeleted=CASE WHEN deleted=1 OR isDeleted=1 THEN 1 ELSE 0 END WHERE (deleted IS NULL AND isDeleted IS NOT NULL) OR (isDeleted IS NULL AND deleted IS NOT NULL) OR (deleted <> isDeleted)`);
    updated += Number(result && result.affectedRows || 0);
  }
  return updated;
}

async function normalizeSiteConfigSingleton(conn) {
  const table = schema.tableName("siteConfig");
  if (!(await tableExists(conn, table))) return { fragmentsRemoved: 0 };
  const rows = await query(conn, `SELECT * FROM ${quote(table)} ORDER BY id`);
  const fragments = rows.filter((row) => !["global", "homeStats"].includes(String(row.id)));
  const docs = [];
  for (const row of rows) {
    const id = String(row.id || "");
    const attributes = await query(conn, `SELECT path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM ${quote(schema.RELATIONS.collection_values.table)} WHERE collection_name=? AND record_id=? ORDER BY path,ordinal`, ["siteConfig", id]);
    const booking = await query(conn, `SELECT * FROM ${quote(schema.RELATIONS.site_booking_notices.table)} WHERE config_id=? ORDER BY notice_no`, [id]);
    const hotwords = await query(conn, `SELECT * FROM ${quote(schema.RELATIONS.site_hotwords.table)} WHERE config_id=? ORDER BY word_no`, [id]);
    docs.push(schema.hydrateDocument("siteConfig", row, { collection_values: attributes, site_booking_notices: booking, site_hotwords: hotwords }));
  }
  const canonical = docs.find((doc) => doc && String(doc.id) === "global")
    || docs.find((doc) => doc && String(doc.id) === "homeStats")
    || null;
  const merged = canonical ? { ...canonical } : { id: "global" };
  const fragmentMap = new Map(docs.filter((doc) => doc && !["global", "homeStats"].includes(String(doc.id))).map((doc) => [String(doc.id), doc]));
  const hasValue = (value) => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
  const mergeObject = (name, fragment) => {
    if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) return;
    fragment = { ...fragment };
    delete fragment.id;
    delete fragment._id;
    const current = merged[name] && typeof merged[name] === "object" && !Array.isArray(merged[name]) ? merged[name] : {};
    merged[name] = { ...fragment, ...Object.fromEntries(Object.entries(current).filter(([key, value]) => hasValue(value))) };
  };
  const booking = fragmentMap.get("bookingNotice");
  if (!hasValue(merged.bookingNotice) && booking) merged.bookingNotice = Object.keys(booking).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => booking[key]);
  const privacy = fragmentMap.get("privacyText");
  if (!hasValue(merged.privacyText) && privacy) merged.privacyText = Object.keys(privacy).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => privacy[key]).join("");
  mergeObject("customPrice", fragmentMap.get("customPrice"));
  mergeObject("search", fragmentMap.get("search"));
  mergeObject("wechat", fragmentMap.get("wechat"));
  mergeObject("footprint", fragmentMap.get("footprint"));
  await writeNormalized(conn, "siteConfig", "global", merged, true);
  for (const fragment of fragments) {
    const id = String(fragment.id);
    await execute(conn, `DELETE FROM ${quote(schema.RELATIONS.collection_values.table)} WHERE collection_name=? AND record_id=?`, ["siteConfig", id]);
    await execute(conn, `DELETE FROM ${quote(schema.RELATIONS.site_booking_notices.table)} WHERE config_id=?`, [id]);
    await execute(conn, `DELETE FROM ${quote(schema.RELATIONS.site_hotwords.table)} WHERE config_id=?`, [id]);
    await execute(conn, `DELETE FROM ${quote(table)} WHERE id=?`, [id]);
  }
  return { fragmentsRemoved: fragments.length };
}

async function migrateLegacyAuth(conn) {
  // Convert the two legacy flexible columns in place before seeding current
  // authorization data.  Existing password hashes are never replaced here.
  if (await tableExists(conn, "lxm_auth_menus")) {
    const columns = await tableColumns(conn, "lxm_auth_menus");
    for (const [name, type] of [["meta_group", "VARCHAR(64) NULL"], ["meta_type", "VARCHAR(64) NULL"], ["meta_label", "VARCHAR(128) NULL"]]) {
      if (!columns.has(name)) { await execute(conn, `ALTER TABLE lxm_auth_menus ADD COLUMN ${quote(name)} ${type}`); columns.add(name); }
    }
    if (columns.has("meta")) {
      const rows = await query(conn, "SELECT id,meta FROM lxm_auth_menus");
      const parsedRows = rows.map((row) => ({ ...row, meta: row.meta == null ? {} : parseLegacy(row.meta) }));
      for (const row of parsedRows) {
        const meta = row.meta;
        await execute(conn, "UPDATE lxm_auth_menus SET meta_group=?,meta_type=?,meta_label=? WHERE id=?", [meta.group || null, meta.type || null, meta.label || null, row.id]);
        const attributes = [];
        schema.flattenLeaves(Object.fromEntries(Object.entries(meta).filter(([key]) => !["group", "type", "label"].includes(key))), "meta", attributes);
        await execute(conn, "DELETE FROM lxm_auth_menu_attributes WHERE menu_id=?", [row.id]);
        for (const attribute of attributes) await execute(conn, "INSERT INTO lxm_auth_menu_attributes (menu_id,attribute_key,ordinal,value_type,value_text,value_number,value_bool) VALUES (?,?,?,?,?,?,?)", [row.id, attribute.path, attribute.ordinal || 0, attribute.value_type, attribute.value_text, attribute.value_number, attribute.value_bool]);
      }
      await execute(conn, "ALTER TABLE lxm_auth_menus DROP COLUMN meta");
    }
  }
  if (await tableExists(conn, "lxm_auth_users")) {
    const columns = await tableColumns(conn, "lxm_auth_users");
    const additions = [["legacy_key", "VARCHAR(64) NULL"], ["legacy_id", "VARCHAR(128) NULL"], ["subject_type", "VARCHAR(64) NULL"], ["subject_id", "VARCHAR(128) NULL"], ["shop_id", "VARCHAR(128) NULL"], ["distributor_id", "VARCHAR(128) NULL"], ["agent_id", "VARCHAR(128) NULL"]];
    for (const [name, type] of additions) if (!columns.has(name)) { await execute(conn, `ALTER TABLE lxm_auth_users ADD COLUMN ${quote(name)} ${type}`); columns.add(name); }
    if (columns.has("extra")) {
      const rows = await query(conn, "SELECT id,extra FROM lxm_auth_users");
      const parsedRows = rows.map((row) => ({ ...row, extra: row.extra == null ? {} : parseLegacy(row.extra) }));
      for (const row of parsedRows) {
        const extra = row.extra;
        const permissions = Array.isArray(extra.permissionKeys) ? extra.permissionKeys : Array.isArray(extra.permissions) ? extra.permissions : [];
        for (const permission of permissions) await execute(conn, "INSERT INTO lxm_auth_user_permissions (user_id,permission_key) VALUES (?,?) ON DUPLICATE KEY UPDATE permission_key=VALUES(permission_key)", [row.id, String(permission)]);
        await execute(conn, "UPDATE lxm_auth_users SET legacy_key=?,legacy_id=?,subject_type=?,subject_id=?,shop_id=?,distributor_id=?,agent_id=? WHERE id=?", [extra.legacyKey || null, extra.legacyId || null, extra.subjectType || null, extra.subjectId || null, extra.shopId || null, extra.distributorId || null, extra.agentId || null, row.id]);
        const known = new Set(["permissionKeys", "permissions", "legacyKey", "legacyId", "subjectType", "subjectId", "shopId", "distributorId", "agentId"]);
        const attributes = [];
        for (const [key, value] of Object.entries(extra)) if (!known.has(key)) schema.flattenLeaves(value, key, attributes);
        await execute(conn, "DELETE FROM lxm_auth_user_attributes WHERE user_id=?", [row.id]);
        for (const attribute of attributes) await execute(conn, "INSERT INTO lxm_auth_user_attributes (user_id,attribute_key,ordinal,value_type,value_text,value_number,value_bool) VALUES (?,?,?,?,?,?,?)", [row.id, attribute.path, attribute.ordinal || 0, attribute.value_type, attribute.value_text, attribute.value_number, attribute.value_bool]);
      }
      await execute(conn, "ALTER TABLE lxm_auth_users DROP COLUMN extra");
    }
  }
}

async function widenAuthCoreColumns(conn) {
  const specs = {
    lxm_auth_menus: [["id", "VARCHAR(128) NOT NULL"], ["menu_key", "VARCHAR(128) NOT NULL"], ["parent_key", "VARCHAR(128) NULL"]],
    lxm_auth_roles: [["id", "VARCHAR(128) NOT NULL"], ["role_key", "VARCHAR(64) NOT NULL"]],
    lxm_auth_role_menus: [["role_id", "VARCHAR(128) NOT NULL"], ["menu_key", "VARCHAR(128) NOT NULL"]],
    lxm_auth_role_permissions: [["role_id", "VARCHAR(128) NOT NULL"], ["permission_key", "VARCHAR(128) NOT NULL"]],
    lxm_auth_user_permissions: [["user_id", "VARCHAR(128) NOT NULL"], ["permission_key", "VARCHAR(128) NOT NULL"]],
    lxm_auth_users: [["id", "VARCHAR(128) NOT NULL"], ["account", "VARCHAR(128) NOT NULL"], ["role_id", "VARCHAR(128) NOT NULL"]]
  };
  for (const [table, columns] of Object.entries(specs)) {
    if (!(await tableExists(conn, table))) continue;
    const existing = await tableColumns(conn, table);
    for (const [name, type] of columns) if (existing.has(name)) await execute(conn, `ALTER TABLE ${quote(table)} MODIFY COLUMN ${quote(name)} ${type}`);
  }
}

async function ensureAuthAttributeColumns(conn) {
  for (const table of ["lxm_auth_menu_attributes", "lxm_auth_user_attributes"]) {
    if (!(await tableExists(conn, table))) continue;
    const columns = await tableColumns(conn, table);
    if (table === "lxm_auth_menu_attributes" && columns.has("menu_id")) await execute(conn, "ALTER TABLE lxm_auth_menu_attributes MODIFY COLUMN menu_id VARCHAR(128) NOT NULL");
    if (table === "lxm_auth_user_attributes" && columns.has("user_id")) await execute(conn, "ALTER TABLE lxm_auth_user_attributes MODIFY COLUMN user_id VARCHAR(128) NOT NULL");
    if (!columns.has("value_type")) await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN value_type VARCHAR(16) NOT NULL DEFAULT 'string'`);
  }
}

async function ensureAuthTimestampDefaults(conn) {
  const tables = ["lxm_auth_menus", "lxm_auth_roles", "lxm_auth_role_menus", "lxm_auth_role_permissions", "lxm_auth_user_permissions", "lxm_auth_users"];
  for (const table of tables) {
    if (!(await tableExists(conn, table))) continue;
    const columns = await tableColumns(conn, table);
    if (!columns.has("created_at")) await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    else {
      await execute(conn, `UPDATE ${quote(table)} SET created_at=CURRENT_TIMESTAMP(3) WHERE created_at IS NULL`);
      await execute(conn, `ALTER TABLE ${quote(table)} MODIFY COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    }
    if (!columns.has("updated_at")) await execute(conn, `ALTER TABLE ${quote(table)} ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    else {
      await execute(conn, `UPDATE ${quote(table)} SET updated_at=CURRENT_TIMESTAMP(3) WHERE updated_at IS NULL`);
      await execute(conn, `ALTER TABLE ${quote(table)} MODIFY COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    }
  }
}

function roleId(profileKey) { return `role_${String(profileKey).replace(/[^A-Za-z0-9_.-]/g, "_")}`; }
function menuId(menuKey) { return `menu_${String(menuKey).replace(/[^A-Za-z0-9_.-]/g, "_")}`; }
function normalizeAuthzRoleKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return ({ admin: "super", administrator: "super", photographer: "photo" })[key] || key;
}
function actionKeys(profileKey, profile, configData) {
  const output = new Set(Array.isArray(profile && profile.actions) ? profile.actions.map(String) : []);
  for (const item of Array.isArray(configData.permissionMatrix) ? configData.permissionMatrix : []) if (item && item[profileKey]) output.add(String(item.key));
  if (profileKey === "super") output.add("*");
  if (!output.size) output.add("view");
  return [...output];
}

async function seedAuthorization(conn, configData, data) {
  const menus = Array.isArray(configData.menus) ? configData.menus : [];
  const roles = configData.roles && typeof configData.roles === "object" ? configData.roles : {};
  for (let index = 0; index < menus.length; index += 1) {
    const menu = menus[index] || {}; const key = String(menu.key || "").trim(); if (!key) continue;
    await execute(conn, "INSERT INTO lxm_auth_menus (id,menu_key,parent_key,name,path,icon,sort_no,status,meta_group,meta_type,meta_label) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE parent_key=VALUES(parent_key),name=VALUES(name),path=VALUES(path),icon=VALUES(icon),sort_no=VALUES(sort_no),status=VALUES(status),meta_group=VALUES(meta_group),meta_type=VALUES(meta_type),meta_label=VALUES(meta_label),updated_at=CURRENT_TIMESTAMP(3)", [menuId(key), key, menu.parentKey || menu.parentId || null, String(menu.label || key).slice(0, 128), String(menu.path || `/${key}`).slice(0, 255), menu.icon || null, Number(menu.sort || index + 1) || index + 1, menu.status === "停用" ? "disabled" : "active", menu.group || null, menu.type || "menu", menu.label || key]);
  }
  for (const [profileKey, profile] of Object.entries(roles)) {
    const role = profile && typeof profile === "object" ? profile : {};
    const rid = roleId(profileKey);
    await execute(conn, "INSERT INTO lxm_auth_roles (id,role_key,name,status,description) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),status=VALUES(status),description=VALUES(description),updated_at=CURRENT_TIMESTAMP(3)", [rid, profileKey, String(role.name || profileKey).slice(0, 128), "active", String(role.description || "").slice(0, 500)]);
    await execute(conn, "DELETE FROM lxm_auth_role_menus WHERE role_id=?", [rid]);
    for (const key of new Set(Array.isArray(role.menus) ? role.menus.map(String) : [])) if (menus.some((menu) => String(menu && menu.key || "") === key)) await execute(conn, "INSERT INTO lxm_auth_role_menus (role_id,menu_key) VALUES (?,?) ON DUPLICATE KEY UPDATE menu_key=VALUES(menu_key)", [rid, key]);
    await execute(conn, "DELETE FROM lxm_auth_role_permissions WHERE role_id=?", [rid]);
    for (const key of actionKeys(profileKey, role, configData)) await execute(conn, "INSERT INTO lxm_auth_role_permissions (role_id,permission_key) VALUES (?,?) ON DUPLICATE KEY UPDATE permission_key=VALUES(permission_key)", [rid, key]);
  }
  let users = 0;
  for (const key of accountKeys) for (const row of sourceRows(data, key, true)) {
    if (!row.doc.account) continue;
    const role = normalizeAuthzRoleKey(key === "shops" ? "merchant" : key === "distributors" ? "distributor" : key === "agents" ? "agent" : row.doc.role || "service");
    const existingRows = await query(conn, "SELECT id,account,password_hash FROM lxm_auth_users WHERE id=? OR account=?", [row.id, String(row.doc.account).slice(0, 128)]);
    const existing = existingRows.find((item) => String(item.id) === String(row.id)) || null;
    if (existingRows.some((item) => String(item.id) !== String(row.id))) {
      throw Object.assign(new Error(`权限账号冲突: ${String(row.doc.account).slice(0, 128)}`), { code: "MIGRATION_VERIFY_FAILED" });
    }
    const supplied = String(row.doc.passwordHash || row.doc.password || "");
    const passwordHash = existing && existing.password_hash ? existing.password_hash : supplied.startsWith("lxm1$") ? supplied : hashPassword(supplied || crypto.randomBytes(18).toString("hex"));
    const disabled = ["停用", "禁用", "disabled", "inactive"].includes(String(row.doc.status || "").toLowerCase());
    const userValues = [row.id, String(row.doc.account).slice(0, 128), String(row.doc.name || row.doc.title || row.doc.account).slice(0, 128), passwordHash, roleId(role), disabled ? "disabled" : "active", String(row.doc.phone || row.doc.contactPhone || "").slice(0, 64) || null, String(row.doc.email || "").slice(0, 255) || null, key, row.id, key === "shops" ? "merchant" : key === "distributors" ? "distributor" : key === "agents" ? "agent" : "staff", row.id, row.doc.shopId || null, row.doc.distributorId || null, row.doc.agentId || null];
    if (existing) {
      await execute(conn, "UPDATE lxm_auth_users SET account=?,display_name=?,role_id=?,status=?,phone=?,email=?,legacy_key=?,legacy_id=?,subject_type=?,subject_id=?,shop_id=?,distributor_id=?,agent_id=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?", [...userValues.slice(1, 3), ...userValues.slice(4), row.id]);
    } else {
      await execute(conn, "INSERT INTO lxm_auth_users (id,account,display_name,password_hash,role_id,status,phone,email,legacy_key,legacy_id,subject_type,subject_id,shop_id,distributor_id,agent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", userValues);
    }
    await execute(conn, "DELETE FROM lxm_auth_user_permissions WHERE user_id=?", [row.id]);
    const permissions = Array.isArray(row.doc.permissionKeys) ? row.doc.permissionKeys : Array.isArray(row.doc.permissions) ? row.doc.permissions : [];
    for (const permission of new Set(permissions.map(String))) await execute(conn, "INSERT INTO lxm_auth_user_permissions (user_id,permission_key) VALUES (?,?) ON DUPLICATE KEY UPDATE permission_key=VALUES(permission_key)", [row.id, permission]);
    users += 1;
  }
  return { menus: menus.length, roles: Object.keys(roles).length, users };
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `lxm1$${salt}$${crypto.scryptSync(String(plain), salt, 64).toString("hex")}`;
}

async function ensureDatabase(cfg) {
  const admin = { ...cfg }; delete admin.database;
  const conn = await mysql.createConnection(admin);
  try { await conn.query(`CREATE DATABASE IF NOT EXISTS ${quote(cfg.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
  finally { await conn.end(); }
}

function splitSql(sql) {
  return sql.replace(/--[^\r\n]*/g, "").split(";").map((part) => part.trim()).filter(Boolean);
}

async function runSchema(conn) {
  const sql = fs.readFileSync(schemaFile, "utf8");
  for (const statement of splitSql(sql)) await conn.query(statement);
}

async function rollback(conn) {
  const relationTables = Object.values(schema.RELATIONS).map((item) => item.table);
  const authTables = ["lxm_auth_user_permissions", "lxm_auth_role_permissions", "lxm_auth_role_menus", "lxm_auth_users", "lxm_auth_menus", "lxm_auth_roles", "lxm_auth_menu_attributes", "lxm_auth_user_attributes", "lxm_auth_menus_normalized", "lxm_auth_users_normalized"];
  const businessTables = businessKeys.flatMap((key) => [schema.tableName(key), `${schema.tableName(key)}_normalized`]);
  const tables = ["lxm_schema_version", ...authTables, ...relationTables, ...businessTables, "lxm_business_documents"];
  for (const table of [...new Set(tables)]) await execute(conn, `DROP TABLE IF EXISTS ${quote(table)}`);
  return [...new Set(tables)].length;
}

async function verifyNormalizedSchema(conn) {
  const rows = await query(conn, "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name LIKE 'lxm_%' AND column_name IN ('doc','meta','extra')");
  if (rows.length) throw Object.assign(new Error("规范化校验发现旧载荷列"), { code: "MIGRATION_VERIFY_FAILED" });
  const missing = [];
  for (const key of businessKeys) {
    const columns = await tableColumns(conn, schema.tableName(key));
    for (const column of schema.definition(key).columns) if (!columns.has(column.name)) missing.push(`${schema.tableName(key)}.${column.name}`);
    for (const column of ["created_at", "updated_at"]) if (!columns.has(column)) missing.push(`${schema.tableName(key)}.${column}`);
    if (columns.has("doc") || key === "logs" && columns.has("snapshot")) missing.push(`${schema.tableName(key)}.legacy_payload`);
  }
  for (const relation of Object.values(schema.RELATIONS)) {
    const columns = await tableColumns(conn, relation.table);
    for (const name of relation.columns.map((column) => String(column).trim().split(/\s+/, 1)[0])) if (!columns.has(name)) missing.push(`${relation.table}.${name}`);
  }
  const authTables = {
    lxm_auth_menus: ["id", "menu_key", "meta_group", "meta_type", "meta_label"],
    lxm_auth_roles: ["id", "role_key"],
    lxm_auth_role_menus: ["role_id", "menu_key"],
    lxm_auth_role_permissions: ["role_id", "permission_key"],
    lxm_auth_user_permissions: ["user_id", "permission_key"],
    lxm_auth_users: ["id", "account", "password_hash", "role_id", "legacy_key", "subject_type", "subject_id"],
    lxm_auth_menu_attributes: ["menu_id", "attribute_key", "value_type"],
    lxm_auth_user_attributes: ["user_id", "attribute_key", "value_type"]
  };
  for (const [table, names] of Object.entries(authTables)) {
    const columns = await tableColumns(conn, table);
    for (const name of names) if (!columns.has(name)) missing.push(`${table}.${name}`);
    for (const forbidden of ["meta", "extra"]) if (columns.has(forbidden)) missing.push(`${table}.${forbidden}`);
  }
  const financeLeaves = await query(conn, "SELECT COUNT(*) AS count FROM lxm_collection_values WHERE collection_name=?", ["financeSettings"]);
  if (Number(financeLeaves[0] && financeLeaves[0].count || 0) > 0) {
    throw Object.assign(new Error("financeSettings 不允许存在未建模属性"), { code: "MIGRATION_VERIFY_FAILED" });
  }
  for (const key of businessKeys) {
    const orphan = await query(conn, `SELECT COUNT(*) AS count FROM lxm_collection_values values_row LEFT JOIN ${quote(schema.tableName(key))} parent_row ON parent_row.id=values_row.record_id WHERE values_row.collection_name=? AND parent_row.id IS NULL`, [key]);
    if (Number(orphan[0] && orphan[0].count || 0) > 0) throw Object.assign(new Error(`集合 ${key} 存在孤立属性`), { code: "MIGRATION_VERIFY_FAILED" });
  }
  if (missing.length) throw Object.assign(new Error(`规范化表校验失败: ${missing.join(",")}`), { code: "MIGRATION_VERIFY_FAILED" });
  return { checked: businessKeys.length, relationTables: Object.keys(schema.RELATIONS).length, forbiddenColumns: 0 };
}

async function main() {
  if (args.has("--help") || args.has("-h")) return usage();
  const jsonFile = path.resolve(env("JSON_FILE", defaultJsonFile));
  const data = importFixture || mode === "dry-run" ? readJson(jsonFile) : { collections: {} };
  const configData = importFixture ? readStaticConfig() : {};
  const counts = Object.fromEntries(businessKeys.map((key) => [key, sourceRows(data, key).length]));
  const accountCount = [...accountKeys].reduce((sum, key) => sum + sourceRows(data, key, true).filter((row) => row.doc.account).length, 0);
  if (mode === "dry-run") {
    process.stdout.write(JSON.stringify({ mode, database: env("DB_NAME", "luxiaoming_admin"), jsonFile, importFixture, collections: counts, accounts: accountCount, schemaVersion: 2, schemaTables: typeof schema.schemaStatements === "function" ? schema.schemaStatements().length : 0, relationTables: Object.keys(schema.RELATIONS || {}).length, normalized: true }) + "\n");
    return;
  }
  if (mode === "rollback" && !args.has("--confirm")) throw new Error("回滚会删除项目 lxm_* 表，请同时传 --confirm");
  const cfg = config();
  if (!cfg.host || !cfg.user || !cfg.database || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error("DB_HOST、DB_PORT、DB_USER、DB_NAME 配置无效");
  await ensureDatabase(cfg);
  const conn = await mysql.createConnection(cfg);
  try {
    if (mode === "rollback") { process.stdout.write(JSON.stringify({ mode, database: cfg.database, dropped: await rollback(conn) }) + "\n"); return; }
    await runSchema(conn);
    await preflightLegacyPayloads(conn);
    await ensureNormalizedMainColumns(conn);
    await ensureNormalizedIndexes(conn);
    await execute(conn, "INSERT INTO lxm_schema_version (version) VALUES (2) ON DUPLICATE KEY UPDATE applied_at=CURRENT_TIMESTAMP(3)");
    const legacyLogSnapshots = await migrateLegacyLogSnapshot(conn);
    const legacyConverted = await migrateLegacyBusiness(conn);
    let financeNormalization = { attributesRemoved: 0, fragmentsRemoved: 0 };
    let siteConfigNormalization = { fragmentsRemoved: 0 };
    await ensureAuthAttributeColumns(conn);
    await widenAuthCoreColumns(conn);
    await migrateLegacyAuth(conn);
    await ensureAuthTimestampDefaults(conn);
    await conn.beginTransaction();
    try {
      let migrated = 0;
      let authorization = { skipped: true, reason: "fixture_import_disabled" };
      if (importFixture) {
        for (const key of businessKeys) for (const row of sourceRows(data, key)) { await writeNormalized(conn, key, row.id, row.doc, true); migrated += 1; }
        authorization = await seedAuthorization(conn, configData, data);
      }
      siteConfigNormalization = await normalizeSiteConfigSingleton(conn);
      financeNormalization = await normalizeFinanceSingleton(conn);
      const cityIdsBackfilled = await backfillCityIds(conn);
      const lifecycleFlagsNormalized = await normalizeLifecycleFlags(conn);
      const orphanAttributesRemoved = await cleanOrphanCollectionValues(conn);
      const materializedDocumentsNormalized = await normalizeMaterializedDocuments(conn);
      const verification = await verifyNormalizedSchema(conn);
      await conn.commit();
      process.stdout.write(JSON.stringify({ mode, database: cfg.database, migrated, importFixture, legacyConverted, legacyLogSnapshots, siteConfigNormalization, financeNormalization, cityIdsBackfilled, lifecycleFlagsNormalized, orphanAttributesRemoved, materializedDocumentsNormalized, authorization, verification, normalized: true }) + "\n");
    } catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
  } finally { await conn.end(); }
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(JSON.stringify({ error: error.code || "migration_failed", message: String(error.message || "迁移失败").slice(0, 180) }) + "\n"); process.exitCode = 1; });
}

module.exports = { splitSql, sourceRows, parseLegacy, sqlRow, writeNormalized, preflightLegacyPayloads, ensureNormalizedMainColumns, migrateLegacyLogSnapshot, cleanFinanceSettingAttributes, normalizeFinanceSingleton, backfillCityIds, cleanOrphanCollectionValues, normalizedRelationRows, normalizeMaterializedDocuments, normalizeSiteConfigSingleton, normalizeLifecycleFlags };
