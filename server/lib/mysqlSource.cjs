"use strict";

// Normalized MySQL source adapter.  It deliberately exposes the same
// list/get/create/update/upsert/remove contract as the legacy source while
// storing scalar fields in lxm_<collection>, relation rows in the tables
// declared by mysqlSchema, and unknown leaf values in lxm_collection_values.
//
// The adapter is intentionally self-contained so the migration runner and the
// HTTP source can share exactly the same split/hydrate rules.  Legacy tables
// that still contain a `doc` column are read-only compatibility inputs. Runtime
// autoMigrate deliberately refuses those tables; use the explicit migration
// command for a controlled cutover so stale payloads can never overwrite live
// normalized writes.

const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const schema = require("./mysqlSchema.cjs");
const mysqlDescriptions = require("./mysqlDescriptions.cjs");
const { SQL_TIME_ZONE, normalizeDateTime } = require("./mysqlDateTime.cjs");
const { planSpotMutation } = require("./spotOrder.cjs");
const { KEYS: CONTENT_ORDER_KEYS, planContentMutation } = require("./contentOrder.cjs");
const { createLogger, errorCode, recordDatabaseOperation } = require("./observability.cjs");

const {
  ALL_KEYS,
  COLLECTIONS,
  RELATIONS,
  RELATION_BY_KEY,
  COLLECTION_VALUES_TABLE,
  assertKey,
  tableName,
  splitDocument,
  hydrateDocument,
  normalizeLogSnapshot,
  logSnapshotRelation,
} = schema;

const FAVORITE_TABLE = "lxm_user_favorites";
const FAVORITE_DDL = `CREATE TABLE IF NOT EXISTS \`${FAVORITE_TABLE}\` (
  \`openid\` VARCHAR(128) NOT NULL,
  \`favorite_key\` VARCHAR(256) NOT NULL,
  \`type\` VARCHAR(64) NOT NULL,
  \`item_id\` VARCHAR(128) NOT NULL,
  \`type_label\` VARCHAR(255) NULL,
  \`title\` VARCHAR(255) NULL,
  \`cover\` TEXT NULL,
  \`price\` DECIMAL(18,2) NULL,
  \`spot\` VARCHAR(255) NULL,
  \`spot_id\` VARCHAR(128) NULL,
  \`url\` TEXT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`openid\`, \`favorite_key\`),
  UNIQUE KEY \`uq_user_favorite_item\` (\`openid\`, \`type\`, \`item_id\`),
  KEY \`idx_user_favorite_created\` (\`openid\`, \`created_at\`),
  KEY \`idx_user_favorite_type\` (\`openid\`, \`type\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

function favoriteKey(openid, type, itemId) {
  return `${String(openid || "")}\u0000${String(type || "")}\u0000${String(itemId || "")}`;
}

function parseFavoriteRow(row) {
  const snapshot = {};
  for (const [field, column] of [["typeLabel", "type_label"], ["title", "title"], ["cover", "cover"], ["price", "price"], ["spot", "spot"], ["spotId", "spot_id"], ["url", "url"]]) {
    if (row && row[column] !== undefined && row[column] !== null && row[column] !== "") snapshot[field] = row[column];
  }
  const toIso = (value) => value instanceof Date ? value.toISOString() : String(value || "");
  return {
    key: favoriteKey(row && row.openid, row && row.type, row && row.item_id),
    openid: String(row && row.openid || ""),
    type: String(row && row.type || ""),
    itemId: String(row && row.item_id || ""),
    snapshot,
    createdAt: toIso(row && row.created_at),
    updatedAt: toIso(row && row.updated_at)
  };
}

function bool(value) { return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true"; }
function now() { return new Date(); }
function generatedId(key) { return `${String(key).slice(0, 2)}_${crypto.randomBytes(8).toString("hex")}`; }
function metadataValue(row, name) {
  if (!row || typeof row !== "object") return undefined;
  return row[name] ?? row[String(name).toUpperCase()];
}

function relationColumnNames(definition) {
  return definition.columns.map((column) => String(column).trim().split(/\s+/, 1)[0]);
}

function relationOrderColumns(definition) {
  const names = new Set(relationColumnNames(definition));
  const preferred = ["sort_no", "item_no", "record_no", "log_no", "tag_no", "nav_no", "banner_no", "notice_no", "word_no", "image_no", "spec_no", "ordinal"];
  const ordered = preferred.filter((name) => names.has(name));
  return ordered.length ? ordered : relationColumnNames(definition).slice(0, 2);
}

function relationParent(definitionName) {
  const definition = RELATIONS[definitionName];
  if (!definition) return null;
  const columns = relationColumnNames(definition);
  if (definitionName === "account_permissions") return { columns: ["collection_name", "account_id"] };
  if (definitionName === "collection_values") return { columns: ["collection_name", "record_id"] };
  if (definitionName === "trash_source_attributes") return { columns: ["trash_id"] };
  return { columns: columns.length ? [columns[0]] : [] };
}

function sqlSummary(sql) {
  const text = String(sql || "").replace(/\s+/g, " ").trim();
  const verb = (text.match(/^([A-Za-z]+)/) || ["", "SQL"])[1].toUpperCase();
  const table = (text.match(/\b(?:FROM|INTO|UPDATE|TABLE)\s+`?([A-Za-z0-9_]+)/i) || ["", "metadata"])[1];
  return `${verb}:${String(table || "metadata").slice(0, 120)}`;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

// Consume lazily: a pool's connection limit does not bound the number of
// queued promises or the result arrays retained by their closures.
async function forEachBounded(values, concurrency, work) {
  const iterator = values[Symbol.iterator]();
  let failed = false, failure;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failed) {
      const next = iterator.next();
      if (next.done) return;
      try { await work(next.value); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
}

function emptyRelations() {
  return { [COLLECTION_VALUES_TABLE]: [] };
}

function groupRelationRows(ids, attributes, relationRowsByName) {
  const output = new Map(ids.map((id) => [String(id), emptyRelations()]));
  for (const row of attributes || []) {
    const id = String(row && row.record_id || "");
    const target = output.get(id);
    if (target) target[COLLECTION_VALUES_TABLE].push(row);
  }
  for (const [relationName, payload] of Object.entries(relationRowsByName || {})) {
    const parentColumn = payload && payload.parentColumn;
    for (const row of payload && payload.rows || []) {
      const id = String(row && row[parentColumn] || "");
      const target = output.get(id);
      if (!target) continue;
      if (!target[relationName]) target[relationName] = [];
      target[relationName].push(row);
    }
  }
  return output;
}

function createCollectionSql(key) {
  const definition = COLLECTIONS[assertKey(key)];
  const columns = definition.columns.map((column) => `\`${column.name}\` ${column.type}`);
  columns.push("PRIMARY KEY (`id`)", "KEY `idx_updated_at` (`updatedAt`)");
  columns.push("created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
  columns.push("updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
  return `CREATE TABLE IF NOT EXISTS \`${tableName(key)}\` (\n  ${columns.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

function parseLegacy(raw) {
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch (_) { return null; }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

function sanitizeLegacyDocument(value) {
  if (Array.isArray(value)) return value.map(sanitizeLegacyDocument);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) if (!schema.isSensitiveField || !schema.isSensitiveField(key)) output[key] = sanitizeLegacyDocument(child);
  return output;
}

function coerceForSql(column, value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (/^DATETIME\b/i.test(column.type)) return normalizeDateTime(value);
  if (/TINYINT/i.test(column.type)) return bool(value) ? 1 : 0;
  if (/(?:INT|DECIMAL)/i.test(column.type)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (/\bTEXT\b/i.test(column.type) && typeof value === "string" && Buffer.byteLength(value, "utf8") > 60000) {
    const error = new Error(`字段 ${column.name} 内容过大，数据库文本字段上限约 60KB`); error.code = "DATA_TOO_LARGE"; throw error;
  }
  return value;
}

function rowForDocument(key, id, columns) {
  const definition = COLLECTIONS[assertKey(key)];
  const row = { id };
  for (const column of definition.columns) {
    if (column.name === "id") continue;
    if (Object.prototype.hasOwnProperty.call(columns, column.name)) row[column.name] = coerceForSql(column, columns[column.name]);
  }
  return row;
}

function rowColumns(row) {
  return Object.keys(row).filter((name) => name !== "created_at" && name !== "updated_at");
}

function insertSql(table, row, duplicate = false) {
  const names = rowColumns(row);
  const quoted = names.map((name) => `\`${name}\``).join(",");
  const placeholders = names.map(() => "?").join(",");
  const updates = names.filter((name) => name !== "id").map((name) => `\`${name}\`=VALUES(\`${name}\`)`);
  const suffix = duplicate ? ` ON DUPLICATE KEY UPDATE ${updates.concat("updated_at=CURRENT_TIMESTAMP(3)").concat(updates.length ? [] : ["id=id"]).join(",")}` : "";
  return { sql: `INSERT INTO \`${table}\` (${quoted}) VALUES (${placeholders})${suffix}`, params: names.map((name) => row[name]) };
}

function updateSql(table, row, id) {
  const names = rowColumns(row).filter((name) => name !== "id");
  if (!names.length) return { sql: `UPDATE \`${table}\` SET updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`, params: [id] };
  return { sql: `UPDATE \`${table}\` SET ${names.map((name) => `\`${name}\`=?`).join(",")}, updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`, params: names.map((name) => row[name]).concat(id) };
}

function relationInsertSql(definition, row) {
  const names = relationColumnNames(definition).filter((name) => Object.prototype.hasOwnProperty.call(row, name));
  const quoted = names.map((name) => `\`${name}\``).join(",");
  const placeholders = names.map(() => "?").join(",");
  const updates = names.slice(1).map((name) => `\`${name}\`=VALUES(\`${name}\`)`);
  // Payment relations are deleted for this owner before being reinserted.
  // A remaining unique-key collision belongs to another checkout/order and
  // must roll back the transaction, never mutate that other owner's index.
  const paymentRelation = ["lxm_order_payment_records", "lxm_booking_payment_records"].includes(definition.table);
  const suffix = !paymentRelation && updates.length ? ` ON DUPLICATE KEY UPDATE ${updates.join(",")}` : "";
  return { sql: `INSERT INTO \`${definition.table}\` (${quoted}) VALUES (${placeholders})${suffix}`, params: names.map((name) => row[name]) };
}

function valueRows(key, id, attributes) {
  return (Array.isArray(attributes) ? attributes : []).map((row) => {
    const path = String(row.path || "");
    if (path.length > 512) { const error = new Error("属性路径超过 512 字符"); error.code = "SCHEMA_PATH_TOO_LONG"; throw error; }
    return {
      collection_name: key,
      record_id: id,
      path,
      ordinal: Number.isInteger(row.ordinal) ? row.ordinal : 0,
      value_type: String(row.value_type || "string").slice(0, 16),
      value_text: row.value_text === undefined ? null : row.value_text,
      value_number: row.value_number === undefined ? null : row.value_number,
      value_bool: row.value_bool === undefined ? null : row.value_bool,
      value_time: row.value_time === undefined ? null : row.value_time
    };
  }).filter((row) => row.path);
}

module.exports = function createMysqlSource(cfg = {}) {
  let mysql = null;
  if (!cfg.pool) {
    try { mysql = require("mysql2/promise"); }
    catch (error) {
      const failure = new Error("MySQL 驱动未安装");
      failure.code = "DATA_SOURCE_UNAVAILABLE";
      throw failure;
    }
  }
  if (!cfg.pool && (!cfg.dbHost || !cfg.dbUser || !cfg.dbName)) {
    const failure = new Error("MySQL 连接配置不完整");
    failure.code = "DATA_SOURCE_CONFIG_INVALID";
    throw failure;
  }

  const logger = cfg.logger || createLogger({ service: "luxiaoming-admin" });
  const pool = cfg.pool || mysql.createPool({
    host: cfg.dbHost,
    port: cfg.dbPort || 3306,
    user: cfg.dbUser,
    password: cfg.dbPassword || "",
    database: cfg.dbName,
    timezone: SQL_TIME_ZONE,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit || 10,
    multipleStatements: false,
    compress: String(cfg.dbCompress ?? process.env.DB_COMPRESS ?? "true").toLowerCase() === "true",
    enableKeepAlive: true,
    connectTimeout: cfg.connectTimeout || 3000,
    ...(cfg.dbSsl ? { ssl: { rejectUnauthorized: true } } : {})
  });
  const autoMigrate = cfg.autoMigrate !== undefined
    ? !!cfg.autoMigrate
    : String(process.env.DB_AUTO_MIGRATE || "false").toLowerCase() === "true";
  const state = new Map();
  let ensurePromise = null;
  let schemaReady = false;
  let closed = false;
  const configuredHealthCacheMs = Number(cfg.healthCacheMs ?? process.env.DB_HEALTH_CACHE_MS ?? 5000);
  const healthCacheMs = Number.isFinite(configuredHealthCacheMs)
    ? Math.min(Math.max(configuredHealthCacheMs, 0), 60000)
    : 5000;
  let latestReadyHealth = null;
  let healthInFlight = null;
  const slowQueryMs = Math.min(Math.max(Number(cfg.slowQueryMs ?? process.env.DB_SLOW_QUERY_MS ?? 500), 1), 120000);
  const slowTransactionMs = Math.min(Math.max(Number(cfg.slowTransactionMs ?? process.env.DB_SLOW_TRANSACTION_MS ?? 1000), 1), 120000);
  const relationBatchSize = Math.min(Math.max(Number(cfg.relationBatchSize ?? process.env.DB_RELATION_BATCH_SIZE ?? 500), 1), 1000);
  const readConcurrency = Math.min(Math.max(Math.trunc(Number(cfg.connectionLimit) || 10), 1), 100);

  async function query(conn, sql, params = []) {
    const startedAt = process.hrtime.bigint();
    const operation = sqlSummary(sql);
    try {
      const [rows] = await conn.query(sql, params);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      recordDatabaseOperation(durationMs);
      if (durationMs >= slowQueryMs) {
        logger.warn("database.query.slow", { operation, durationMs: Math.round(durationMs * 100) / 100, rowCount: Array.isArray(rows) ? rows.length : 0 });
      }
      return rows;
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      recordDatabaseOperation(durationMs);
      logger.error("database.query.failed", { operation, durationMs: Math.round(durationMs * 100) / 100, errorCode: errorCode(error) });
      throw error;
    }
  }
  async function readIndependentRelations(conn, reads) {
    // Pool reads use separate connections, so unrelated relation tables need
    // not pay one network round trip after another. A transaction must retain
    // its dedicated connection and query order. The pool bounds concurrency.
    if (conn === pool) return Promise.all(reads.map((read) => read()));
    const output = [];
    for (const read of reads) output.push(await read());
    return output;
  }
  async function execute(conn, sql, params = []) {
    const startedAt = process.hrtime.bigint();
    const operation = sqlSummary(sql);
    try {
      const [result] = await conn.query(sql, params);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      recordDatabaseOperation(durationMs);
      if (durationMs >= slowQueryMs) {
        logger.warn("database.execute.slow", { operation, durationMs: Math.round(durationMs * 100) / 100, affectedRows: Number(result && result.affectedRows || 0) });
      }
      return result;
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      recordDatabaseOperation(durationMs);
      logger.error("database.execute.failed", { operation, durationMs: Math.round(durationMs * 100) / 100, errorCode: errorCode(error) });
      throw error;
    }
  }
  async function withTransaction(fn) {
    if (typeof pool.getConnection !== "function") return fn(pool);
    const conn = await pool.getConnection();
    const startedAt = process.hrtime.bigint();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      logger.error("database.transaction.failed", { durationMs: Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100, errorCode: errorCode(error) });
      throw error;
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (durationMs >= slowTransactionMs) logger.warn("database.transaction.slow", { durationMs: Math.round(durationMs * 100) / 100 });
      try { conn.release(); } catch (_) {}
    }
  }

  async function inspectTable(conn, table) {
    const rows = await query(conn, "SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position", [table]);
    return new Set(rows.map((row) => String(metadataValue(row, "column_name") || "")).filter(Boolean));
  }

  async function inspectTables(conn, tables, statistics = false) {
    const names = [...new Set(tables)];
    const catalog = new Map(names.map(name => [name.toLowerCase(), new Set()]));
    if (!names.length) return catalog;
    const rows = await query(conn, statistics
      ? `SELECT table_name,column_name,index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN (${names.map(() => "?").join(",")})`
      : `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN (${names.map(() => "?").join(",")}) ORDER BY table_name,ordinal_position`, names);
    for (const row of rows) {
      const name = String(metadataValue(row, "table_name") || "").toLowerCase();
      const column = String(metadataValue(row, "column_name") || "");
      if (catalog.has(name) && column) catalog.get(name).add(column);
    }
    return catalog;
  }

  async function ensureIndexes(conn) {
    for (const key of ALL_KEYS) {
      const table = tableName(key);
      const columns = await inspectTable(conn, table);
      if (!columns.size) continue;
      const indexes = await query(conn, "SELECT index_name,column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=?", [table]);
      if (!indexes.some((row) => String(metadataValue(row, "column_name") || "").toLowerCase() === "updatedat")) {
        const name = indexes.some((row) => String(metadataValue(row, "index_name") || "").toLowerCase() === "idx_updated_at") ? "idx_updated_at_normalized" : "idx_updated_at";
        await execute(conn, `ALTER TABLE \`${table}\` ADD KEY \`${name}\` (\`updatedAt\`)`);
      }
    }
    const users = await inspectTable(conn, "lxm_auth_users");
    if (users.size) {
      const indexes = await query(conn, "SELECT index_name,column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='lxm_auth_users'");
      if (!indexes.some((row) => ["subject_type", "subject_id"].includes(String(metadataValue(row, "column_name") || "").toLowerCase()))) await execute(conn, "ALTER TABLE `lxm_auth_users` ADD KEY `idx_auth_user_subject` (subject_type,subject_id)");
    }
    // User-facing order numbers are lookup identifiers. Refuse to start if an
    // old database contains ambiguous values rather than silently returning
    // the first matching order from an application-level scan.
    const orderColumns = await inspectTable(conn, "lxm_orders");
    if (orderColumns.has("orderNo")) {
      await execute(conn, "UPDATE `lxm_orders` SET `orderNo`=NULL WHERE `orderNo`=''");
      const duplicates = await query(conn, "SELECT `orderNo` AS value_text,COUNT(*) AS count FROM `lxm_orders` WHERE `orderNo` IS NOT NULL GROUP BY `orderNo` HAVING COUNT(*)>1 LIMIT 1");
      if (duplicates.length) {
        const error = new Error("订单号存在重复记录，不能安全启用订单查询"); error.code = "SCHEMA_INCOMPLETE"; throw error;
      }
      const indexes = await query(conn, "SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='lxm_orders' AND index_name='uq_order_number'");
      if (!indexes.length) await execute(conn, "ALTER TABLE `lxm_orders` ADD UNIQUE KEY `uq_order_number` (`orderNo`)");
    }
  }

  async function createRelationTables(conn) {
    // The metadata module emits the same idempotent DDL as 002. Main tables
    // are handled separately; legacy payload tables require the formal cutover.
    for (const relation of Object.values(RELATIONS)) {
      const body = relation.columns.slice();
      if (relation.primary) body.push(relation.primary);
      (relation.indexes || []).forEach((index) => body.push(index));
      if (relation !== RELATIONS.account_permissions && relation !== RELATIONS.collection_values) {
        body.push("created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
        body.push("updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
      }
      await execute(conn, `CREATE TABLE IF NOT EXISTS \`${relation.table}\` (\n  ${body.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      const existing = await inspectTable(conn, relation.table);
      for (const declaration of relation.columns) {
        const text = String(declaration).trim();
        const name = text.split(/\s+/, 1)[0];
        if (existing.has(name)) continue;
        if (!/\bNULL\b|\bDEFAULT\b/i.test(text)) {
          const error = new Error(`关系表 ${relation.table} 缺少必需列: ${name}`); error.code = "SCHEMA_INCOMPLETE"; throw error;
        }
        await execute(conn, `ALTER TABLE \`${relation.table}\` ADD COLUMN \`${name}\` ${text.slice(name.length).trim()}`);
        existing.add(name);
      }
    }
    for (const statement of (typeof schema.authCoreStatements === "function" ? schema.authCoreStatements() : [])) await execute(conn, statement);
    const authWidths = {
      lxm_auth_menus: [["id", "VARCHAR(128) NOT NULL"], ["menu_key", "VARCHAR(128) NOT NULL"], ["parent_key", "VARCHAR(128) NULL"]],
      lxm_auth_roles: [["id", "VARCHAR(128) NOT NULL"], ["role_key", "VARCHAR(64) NOT NULL"]],
      lxm_auth_role_menus: [["role_id", "VARCHAR(128) NOT NULL"], ["menu_key", "VARCHAR(128) NOT NULL"]],
      lxm_auth_role_permissions: [["role_id", "VARCHAR(128) NOT NULL"], ["permission_key", "VARCHAR(128) NOT NULL"]],
      lxm_auth_user_permissions: [["user_id", "VARCHAR(128) NOT NULL"], ["permission_key", "VARCHAR(128) NOT NULL"]],
      lxm_auth_users: [["id", "VARCHAR(128) NOT NULL"], ["account", "VARCHAR(128) NOT NULL"], ["role_id", "VARCHAR(128) NOT NULL"]]
    };
    for (const [table, columns] of Object.entries(authWidths)) {
      const existing = await inspectTable(conn, table);
      for (const [name, type] of columns) if (existing.has(name)) await execute(conn, `ALTER TABLE \`${table}\` MODIFY COLUMN \`${name}\` ${type}`);
    }
    for (const table of Object.keys(authWidths)) {
      const existing = await inspectTable(conn, table);
      if (existing.has("created_at")) {
        await execute(conn, `UPDATE \`${table}\` SET created_at=CURRENT_TIMESTAMP(3) WHERE created_at IS NULL`);
        await execute(conn, `ALTER TABLE \`${table}\` MODIFY COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
      }
      if (existing.has("updated_at")) {
        await execute(conn, `UPDATE \`${table}\` SET updated_at=CURRENT_TIMESTAMP(3) WHERE updated_at IS NULL`);
        await execute(conn, `ALTER TABLE \`${table}\` MODIFY COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
      }
    }
    await execute(conn, "CREATE TABLE IF NOT EXISTS `lxm_auth_menu_attributes` (`menu_id` VARCHAR(128) NOT NULL, `attribute_key` VARCHAR(128) NOT NULL, `ordinal` INT NOT NULL DEFAULT 0, `value_type` VARCHAR(16) NOT NULL, `value_text` TEXT NULL, `value_number` DECIMAL(20,6) NULL, `value_bool` TINYINT(1) NULL, PRIMARY KEY (`menu_id`,`attribute_key`,`ordinal`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    await execute(conn, "CREATE TABLE IF NOT EXISTS `lxm_auth_user_attributes` (`user_id` VARCHAR(128) NOT NULL, `attribute_key` VARCHAR(128) NOT NULL, `ordinal` INT NOT NULL DEFAULT 0, `value_type` VARCHAR(16) NOT NULL, `value_text` TEXT NULL, `value_number` DECIMAL(20,6) NULL, `value_bool` TINYINT(1) NULL, PRIMARY KEY (`user_id`,`attribute_key`,`ordinal`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    for (const table of ["lxm_auth_menu_attributes", "lxm_auth_user_attributes"]) {
      const columns = await inspectTable(conn, table);
      if (table === "lxm_auth_menu_attributes") await execute(conn, "ALTER TABLE `lxm_auth_menu_attributes` MODIFY COLUMN `menu_id` VARCHAR(128) NOT NULL");
      if (table === "lxm_auth_user_attributes") await execute(conn, "ALTER TABLE `lxm_auth_user_attributes` MODIFY COLUMN `user_id` VARCHAR(128) NOT NULL");
      if (!columns.has("value_type")) await execute(conn, `ALTER TABLE \`${table}\` ADD COLUMN value_type VARCHAR(16) NOT NULL DEFAULT 'string'`);
    }
    await execute(conn, "CREATE TABLE IF NOT EXISTS `lxm_schema_version` (version INT NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    for (const auth of Object.values(schema.AUTH_NORMALIZED || {})) {
      const body = auth.columns.slice();
      if (auth.primary) body.push(auth.primary);
      (auth.indexes || []).forEach((index) => body.push(index));
      body.push("created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
      body.push("updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)");
      await execute(conn, `CREATE TABLE IF NOT EXISTS \`${auth.table}\` (\n  ${body.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }
    await execute(conn, "INSERT INTO `lxm_schema_version` (version) VALUES (2) ON DUPLICATE KEY UPDATE applied_at=CURRENT_TIMESTAMP(3)");
  }

  async function normalizeLegacyLogSnapshot(conn) {
    const table = tableName("logs");
    const columns = await inspectTable(conn, table);
    if (columns.has("doc")) return 0;
    if (!columns.size || !columns.has("snapshot")) {
      if (columns.size && !columns.has("snapshotText")) await execute(conn, `ALTER TABLE \`${table}\` ADD COLUMN snapshotText VARCHAR(500) NULL`);
      return 0;
    }
    if (!columns.has("snapshotText")) await execute(conn, `ALTER TABLE \`${table}\` ADD COLUMN snapshotText VARCHAR(500) NULL`);
    const rows = await query(conn, `SELECT id, \`snapshot\` FROM \`${table}\` ORDER BY id`);
    const converted = rows.map((row) => {
      const normalized = normalizeLogSnapshot(row.snapshot);
      if (normalized.kind === "text") {
        const value = row.snapshot == null ? null : String(normalized.text || "");
        if (value != null && value.length > 500) { const error = new Error(`日志 ${row.id} 的快照摘要超过 500 字`); error.code = "LOG_SNAPSHOT_TOO_LONG"; throw error; }
        return { id: String(row.id), text: value, relation: null };
      }
      return { id: String(row.id), text: null, relation: logSnapshotRelation(row.id, row.snapshot) };
    });
    const relation = RELATIONS.log_order_exception_snapshots;
    const names = relationColumnNames(relation);
    const work = async () => {
      for (const item of converted) {
        if (item.relation) {
          const insertNames = names.filter((name) => Object.prototype.hasOwnProperty.call(item.relation, name));
          const updates = insertNames.filter((name) => name !== "log_id").map((name) => `\`${name}\`=VALUES(\`${name}\`)`);
          await execute(conn, `INSERT INTO \`${relation.table}\` (${insertNames.map((name) => `\`${name}\``).join(",")}) VALUES (${insertNames.map(() => "?").join(",")}) ON DUPLICATE KEY UPDATE ${updates.join(",")}`, insertNames.map((name) => item.relation[name]));
        } else await execute(conn, `DELETE FROM \`${relation.table}\` WHERE log_id=?`, [item.id]);
        await execute(conn, `UPDATE \`${table}\` SET snapshotText=? WHERE id=?`, [item.text, item.id]);
      }
    };
    if (typeof conn.beginTransaction === "function") {
      await conn.beginTransaction();
      try { await work(); await conn.commit(); }
      catch (error) { try { await conn.rollback(); } catch (_) {} throw error; }
    } else await work();
    await execute(conn, `ALTER TABLE \`${table}\` DROP COLUMN \`snapshot\``);
    return converted.length;
  }

  async function upgradeLegacyKey(conn, key, oldColumns) {
    const oldTable = tableName(key);
    const hasLegacyPayload = [...oldColumns].some((name) => String(name).toLowerCase() === "doc");
    if (!hasLegacyPayload) {
      state.set(key, { table: oldTable, legacy: false });
      return;
    }
    if (!autoMigrate) {
      state.set(key, { table: oldTable, legacy: true });
      return;
    }
    const error = new Error(`检测到旧版 ${oldTable}.doc，请先执行 npm run migrate:mysql -- --apply`);
    error.code = "SCHEMA_LEGACY_MIGRATION_REQUIRED";
    throw error;
  }

  async function ensure() {
    if (closed) throw new Error("数据源已关闭");
    if (schemaReady) return true;
    if (!ensurePromise) {
      ensurePromise = (async () => {
        const conn = typeof pool.getConnection === "function" ? await pool.getConnection() : pool;
        try {
          // Schema facts are static for this source instance. The normal
          // read-only startup must not spend one network round trip per table.
          if (!autoMigrate) {
            const catalog = await inspectTables(conn, ["lxm_business_documents", ...ALL_KEYS.map(tableName)]);
            if (catalog.get("lxm_business_documents").size) {
              const rows = await query(conn, "SELECT 1 FROM `lxm_business_documents` LIMIT 1");
              if (rows.length) throw Object.assign(new Error("检测到旧版聚合表 lxm_business_documents，请先执行 npm run migrate:mysql -- --apply"), { code: "SCHEMA_LEGACY_MIGRATION_REQUIRED" });
            }
            for (const key of ALL_KEYS) {
              const table = tableName(key), columns = catalog.get(table.toLowerCase());
              if (!columns.size) state.set(key, { table, legacy: false, missing: true });
              else await upgradeLegacyKey(conn, key, columns);
            }
            schemaReady = true;
            return true;
          }
          const aggregateColumns = await inspectTable(conn, "lxm_business_documents");
          const aggregateRows = aggregateColumns.size ? await query(conn, "SELECT 1 FROM `lxm_business_documents` LIMIT 1") : [];
          if (aggregateRows.length) {
            const error = new Error("检测到旧版聚合表 lxm_business_documents，请先执行 npm run migrate:mysql -- --apply");
            error.code = "SCHEMA_LEGACY_MIGRATION_REQUIRED";
            throw error;
          }
          if (autoMigrate) await createRelationTables(conn);
          if (autoMigrate) {
            // Preflight every collection before any legacy-column ALTER. A
            // mixed database must go through the formal migration as a unit;
            // otherwise one converted table could be changed before another
            // old `doc` table stops startup.
            for (const key of ALL_KEYS) {
              const columns = await inspectTable(conn, tableName(key));
              if (columns.has("doc")) {
                const error = new Error(`检测到旧版 ${tableName(key)}.doc，请先执行 npm run migrate:mysql -- --apply`);
                error.code = "SCHEMA_LEGACY_MIGRATION_REQUIRED";
                throw error;
              }
            }
            await normalizeLegacyLogSnapshot(conn);
            await ensureIndexes(conn);
          }
          const transactionalUpgrade = autoMigrate && typeof conn.beginTransaction === "function";
          if (transactionalUpgrade) await conn.beginTransaction();
          try {
            for (const key of ALL_KEYS) {
              const table = tableName(key);
              let columns;
              try { columns = await inspectTable(conn, table); } catch (_) { columns = new Set(); }
              if (!columns.size) {
                if (autoMigrate) {
                  await execute(conn, createCollectionSql(key));
                  state.set(key, { table, legacy: false });
                } else state.set(key, { table, legacy: false, missing: true });
              } else await upgradeLegacyKey(conn, key, columns);
            }
            if (transactionalUpgrade) await conn.commit();
          } catch (error) {
            if (transactionalUpgrade) { try { await conn.rollback(); } catch (_) {} }
            throw error;
          }
          if (autoMigrate) await mysqlDescriptions.applyMysqlDescriptions(conn);
          schemaReady = true;
          return true;
        } finally { if (conn !== pool && typeof conn.release === "function") conn.release(); }
      })().finally(() => { ensurePromise = null; });
    }
    return ensurePromise;
  }

  let favoritesReady = false;
  let favoritesEnsurePromise = null;
  async function ensureFavorites() {
    await ensure();
    if (favoritesReady) return true;
    if (!favoritesEnsurePromise) {
      favoritesEnsurePromise = (async () => {
        const conn = typeof pool.getConnection === "function" ? await pool.getConnection() : pool;
        try {
          const columns = await inspectTable(conn, FAVORITE_TABLE);
          const requiredColumns = [
            ["openid", "VARCHAR(128) NOT NULL"], ["favorite_key", "VARCHAR(256) NOT NULL"], ["type", "VARCHAR(64) NOT NULL"],
            ["item_id", "VARCHAR(128) NOT NULL"], ["type_label", "VARCHAR(255) NULL"], ["title", "VARCHAR(255) NULL"],
            ["cover", "TEXT NULL"], ["price", "DECIMAL(18,2) NULL"], ["spot", "VARCHAR(255) NULL"], ["spot_id", "VARCHAR(128) NULL"],
            ["url", "TEXT NULL"], ["created_at", "DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)"], ["updated_at", "DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)"],
          ];
          if (!columns.size) {
            if (!autoMigrate) {
              const error = new Error("收藏数据表尚未就绪，请先执行数据库迁移");
              error.code = "SCHEMA_MISSING";
              throw error;
            }
            await execute(conn, FAVORITE_DDL);
          } else {
            const missing = requiredColumns.filter(([name]) => !columns.has(name));
            if (missing.length && !autoMigrate) {
              const error = new Error("收藏数据表结构不完整，请先执行数据库迁移");
              error.code = "SCHEMA_INCOMPLETE";
              throw error;
            }
            for (const [name, type] of missing) await execute(conn, `ALTER TABLE \`${FAVORITE_TABLE}\` ADD COLUMN \`${name}\` ${type}`);
          }
          if (autoMigrate) await mysqlDescriptions.applyMysqlDescriptions(conn);
          favoritesReady = true;
          return true;
        } finally { if (conn !== pool && typeof conn.release === "function") conn.release(); }
      })().finally(() => { favoritesEnsurePromise = null; });
    }
    return favoritesEnsurePromise;
  }

  async function listFavorites(openid, options = {}) {
    const owner = String(openid || "").trim();
    if (!owner) return [];
    await ensureFavorites();
    const type = String(options.type || "").trim();
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 200);
    const offset = Math.max(Number(options.offset || 0), 0);
    const where = type ? "WHERE openid=? AND type=?" : "WHERE openid=?";
    const params = type ? [owner, type, offset, limit] : [owner, offset, limit];
    const rows = await query(pool, `SELECT openid,favorite_key,type,item_id,type_label,title,cover,price,spot,spot_id,url,created_at,updated_at FROM \`${FAVORITE_TABLE}\` ${where} ORDER BY created_at DESC LIMIT ?,?`, params);
    return rows.map(parseFavoriteRow);
  }

  async function getFavorite(openid, type, itemId) {
    const owner = String(openid || "").trim();
    const favoriteType = String(type || "").trim();
    const id = String(itemId || "").trim();
    if (!owner || !favoriteType || !id) return null;
    await ensureFavorites();
    const rows = await query(pool, `SELECT openid,favorite_key,type,item_id,type_label,title,cover,price,spot,spot_id,url,created_at,updated_at FROM \`${FAVORITE_TABLE}\` WHERE openid=? AND type=? AND item_id=? LIMIT 1`, [owner, favoriteType, id]);
    return rows.length ? parseFavoriteRow(rows[0]) : null;
  }

  async function upsertFavorite(openid, input = {}) {
    const owner = String(openid || "").trim();
    const type = String(input.type || "").trim();
    const itemId = String(input.itemId || input.id || "").trim();
    if (!owner || !type || !itemId) return null;
    await ensureFavorites();
    const snapshot = input.snapshot && typeof input.snapshot === "object" && !Array.isArray(input.snapshot) ? input.snapshot : {};
    const price = snapshot.price === undefined || snapshot.price === null || snapshot.price === "" ? null : Number(snapshot.price);
    const safePrice = Number.isFinite(price) ? price : null;
    await execute(pool, `INSERT INTO \`${FAVORITE_TABLE}\` (openid,favorite_key,type,item_id,type_label,title,cover,price,spot,spot_id,url) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE type_label=VALUES(type_label),title=VALUES(title),cover=VALUES(cover),price=VALUES(price),spot=VALUES(spot),spot_id=VALUES(spot_id),url=VALUES(url),updated_at=CURRENT_TIMESTAMP(3)`, [owner, favoriteKey(owner, type, itemId), type, itemId, snapshot.typeLabel || null, snapshot.title || snapshot.name || null, snapshot.cover || snapshot.coverImage || snapshot.coverUrl || null, safePrice, snapshot.spot || snapshot.spotName || null, snapshot.spotId || null, snapshot.url || null]);
    return getFavorite(owner, type, itemId);
  }

  async function removeFavorite(openid, type, itemId) {
    const owner = String(openid || "").trim();
    const favoriteType = String(type || "").trim();
    const id = String(itemId || "").trim();
    if (!owner || !favoriteType || !id) return false;
    await ensureFavorites();
    const result = await execute(pool, `DELETE FROM \`${FAVORITE_TABLE}\` WHERE openid=? AND type=? AND item_id=?`, [owner, favoriteType, id]);
    return Number(result && result.affectedRows || 0) > 0;
  }

  function tableFor(key) {
    const item = state.get(assertKey(key));
    return item ? item.table : tableName(key);
  }

  async function readLegacy(key, id = null) {
    const table = tableName(key);
    const rows = id == null
      ? await query(pool, `SELECT id, \`doc\` FROM \`${table}\` ORDER BY id`)
      : await query(pool, `SELECT id, \`doc\` FROM \`${table}\` WHERE id=?`, [id]);
    const parsed = rows.map((row) => ({ id: String(row.id), doc: parseLegacy(row.doc) }));
    if (parsed.some((row) => !row.doc)) {
      const error = new Error("旧版数据记录格式无效"); error.code = "DATA_SOURCE_INVALID"; throw error;
    }
    return parsed;
  }

  async function relationRows(key, id, conn = pool) {
    const names = [COLLECTION_VALUES_TABLE];
    const reads = [() => query(conn, `SELECT collection_name,record_id,path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM \`${RELATIONS.collection_values.table}\` WHERE collection_name=? AND record_id=? ORDER BY path,ordinal`, [key, id])];
    for (const relationName of RELATION_BY_KEY[key] || []) {
      const relation = RELATIONS[relationName];
      const parent = relationParent(relationName);
      if (!relation || !parent) continue;
      if (relationName === "account_permissions") continue;
      else {
        const orderBy = relationOrderColumns(relation).map((name) => `\`${name}\``).join(",");
        names.push(relationName);
        reads.push(() => query(conn, `SELECT * FROM \`${relation.table}\` WHERE ${parent.columns[0]}=? ORDER BY ${orderBy}`, [id]));
      }
    }
    const rows = await readIndependentRelations(conn, reads);
    return Object.fromEntries(names.map((name, index) => [name, rows[index]]));
  }

  // A list used to hydrate every record by issuing one attribute query and one
  // query per relation for each row. Batch relationship reads keep query count
  // proportional to relationship types rather than the number of records.
  async function relationRowsMany(key, ids, conn = pool, knownAttributes) {
    const uniqueIds = [...new Set((ids || []).map((id) => String(id || "")).filter(Boolean))];
    const output = groupRelationRows(uniqueIds, knownAttributes, {});
    if (!uniqueIds.length) return output;
    const relationPayload = {};
    for (const relationName of RELATION_BY_KEY[key] || []) {
      if (relationName === "account_permissions") continue;
      const relation = RELATIONS[relationName];
      const parent = relationParent(relationName);
      if (relation && parent && parent.columns[0]) relationPayload[relationName] = { parentColumn: parent.columns[0] };
    }
    for (let offset = 0; offset < uniqueIds.length; offset += relationBatchSize) {
      const batch = uniqueIds.slice(offset, offset + relationBatchSize);
      const placeholders = batch.map(() => "?").join(",");
      const entries = Object.entries(relationPayload);
      const reads = knownAttributes === undefined ? [() => query(conn, `SELECT collection_name,record_id,path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM \`${RELATIONS.collection_values.table}\` WHERE collection_name=? AND record_id IN (${placeholders}) ORDER BY record_id,path,ordinal`, [key, ...batch])] : [];
      for (const [relationName, payload] of entries) {
        const relation = RELATIONS[relationName];
        const orderBy = relationOrderColumns(relation).map((name) => `\`${name}\``).join(",");
        reads.push(() => query(conn, `SELECT * FROM \`${relation.table}\` WHERE \`${payload.parentColumn}\` IN (${placeholders}) ORDER BY \`${payload.parentColumn}\`,${orderBy}`, batch));
      }
      const rows = await readIndependentRelations(conn, reads);
      if (knownAttributes === undefined) {
        for (const row of rows[0]) {
          const target = output.get(String(row && row.record_id || ""));
          if (target) target[COLLECTION_VALUES_TABLE].push(row);
        }
      }
      entries.forEach(([name, payload], index) => {
        for (const row of rows[index + (knownAttributes === undefined ? 1 : 0)]) {
          const target = output.get(String(row && row[payload.parentColumn] || ""));
          if (!target) continue;
          (target[name] ||= []).push(row);
        }
      });
    }
    return output;
  }

  async function hydrateReadRows(key, rows) {
    // Keep the full public list and its SQL order, but release each batch's
    // relation/EAV structures before hydrating the next one. Replace internal
    // raw rows in place rather than retaining a second full-length array.
    for (let offset = 0; offset < rows.length; offset += relationBatchSize) {
      const batch = rows.slice(offset, offset + relationBatchSize);
      const related = await relationRowsMany(key, batch.map(row => String(row.id)));
      for (let index = 0; index < batch.length; index++) {
        const row = batch[index];
        rows[offset + index] = hydrateDocument(key, row, related.get(String(row.id)) || emptyRelations());
      }
    }
    return rows;
  }

  async function readOne(key, id) {
    await ensure();
    const item = state.get(assertKey(key));
    if (item && item.missing) {
      const error = new Error("规范化数据表不存在"); error.code = "SCHEMA_MISSING"; throw error;
    }
    if (item && item.legacy) {
      const rows = await readLegacy(key, id);
      if (!rows.length) return null;
      return { ...sanitizeLegacyDocument(rows[0].doc), id: rows[0].id, _id: rows[0].id };
    }
    const rows = await query(pool, `SELECT * FROM \`${tableFor(key)}\` WHERE id=?`, [id]);
    if (!rows.length) return null;
    return hydrateDocument(key, rows[0], await relationRows(key, String(id)));
  }

  async function readMany(key) {
    await ensure();
    const item = state.get(assertKey(key));
    if (item && item.missing) {
      const error = new Error("规范化数据表不存在"); error.code = "SCHEMA_MISSING"; throw error;
    }
    if (item && item.legacy) return (await readLegacy(key)).map((row) => ({ ...sanitizeLegacyDocument(row.doc), id: row.id, _id: row.id }));
    const rows = await query(pool, `SELECT * FROM \`${tableFor(key)}\` ORDER BY id`);
    return hydrateReadRows(key, rows);
  }

  async function getMany(key, ids) {
    assertKey(key);
    if (!Array.isArray(ids)) throw Object.assign(new Error("记录标识列表格式无效"), { code: "DATA_SOURCE_INVALID" });
    if (!ids.length) return [];
    const requested = ids.map(id => String(id));
    const uniqueIds = [...new Set(requested)];
    await ensure();
    const item = state.get(key);
    if (item && item.missing) throw Object.assign(new Error("规范化数据表不存在"), { code: "SCHEMA_MISSING" });
    const found = new Map();
    const batchSize = Math.min(relationBatchSize, 100);
    for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
      const batch = uniqueIds.slice(offset, offset + batchSize);
      // Each indexed predicate is exactly the predicate used by get(). UNION
      // ALL preserves the database's collation and parameter semantics while
      // the ordinal maps aliases/missing IDs without lowercasing or an N+1
      // fallback. A derived-table JOIN could change collation coercibility.
      const projection = item && item.legacy ? "record.id, record.`doc`" : "record.*";
      const sql = batch.map((_, index) => `SELECT ${index} AS __read_index, ${projection} FROM \`${tableFor(key)}\` record WHERE id=?`).join(" UNION ALL ");
      const matches = (await query(pool, sql, batch)).map(({ __read_index, ...row }) => ({ index: Number(__read_index), row }));
      if (item && item.legacy) {
        for (const { index, row } of matches) {
          const doc = parseLegacy(row.doc);
          if (!doc) throw Object.assign(new Error("旧版数据记录格式无效"), { code: "DATA_SOURCE_INVALID" });
          if (!found.has(batch[index])) found.set(batch[index], { ...sanitizeLegacyDocument(doc), id: String(row.id), _id: String(row.id) });
        }
      } else {
        const related = await relationRowsForGets(key, matches.map(({ index }) => ({ index, id: batch[index] })));
        for (const { index, row } of matches) {
          const id = batch[index];
          if (!found.has(id)) found.set(id, hydrateDocument(key, row, related.get(index) || emptyRelations()));
        }
      }
    }
    // Duplicate IDs and database-equivalent aliases must not share mutable
    // documents: separate get() calls have separate nested results, too.
    const returned = new Set();
    return requested.map(id => {
      const doc = found.get(id);
      if (!doc) return null;
      if (returned.has(doc)) return structuredClone(doc);
      returned.add(doc);
      return doc;
    });
  }

  async function relationRowsForGets(key, owners) {
    const output = new Map(owners.map(({ index }) => [index, emptyRelations()]));
    if (!owners.length) return output;
    const names = [COLLECTION_VALUES_TABLE];
    const attributes = owners.map(({ index }) => `SELECT ${index} AS __read_owner, collection_name,record_id,path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM \`${RELATIONS.collection_values.table}\` WHERE collection_name=? AND record_id=?`).join(" UNION ALL ");
    const reads = [() => query(pool, `${attributes} ORDER BY __read_owner,path,ordinal`, owners.flatMap(({ id }) => [key, id]))];
    for (const name of RELATION_BY_KEY[key] || []) {
      if (name === "account_permissions") continue;
      const definition = RELATIONS[name], parent = relationParent(name);
      if (!definition || !parent) continue;
      const sql = owners.map(({ index }) => `SELECT ${index} AS __read_owner, related.* FROM \`${definition.table}\` related WHERE \`${parent.columns[0]}\`=?`).join(" UNION ALL ");
      const orderBy = relationOrderColumns(definition).map(column => `\`${column}\``).join(",");
      names.push(name);
      reads.push(() => query(pool, `${sql} ORDER BY __read_owner,${orderBy}`, owners.map(({ id }) => id)));
    }
    // Read owner ordinals from SQL rather than comparing returned owner keys
    // in JS. get() accepts the database's key equivalence independently in
    // each relation table, including historical case variants and empty IDs.
    const rows = await readIndependentRelations(pool, reads);
    rows.forEach((result, index) => {
      for (const { __read_owner, ...row } of result) {
        const target = output.get(Number(__read_owner));
        if (target) (target[names[index]] ||= []).push(row);
      }
    });
    return output;
  }

  async function listMany(keys) {
    // Module endpoints have already authorized their keys; the source still
    // validates every identifier before issuing any SQL. Results are fresh and
    // never shared across requests. Bound queued work as well as connections.
    if (!Array.isArray(keys)) throw Object.assign(new Error("集合列表格式无效"), { code: "DATA_SOURCE_INVALID" });
    const requested = [...new Set(keys.map(assertKey))];
    if (!requested.length) return {};
    await ensure();
    for (const key of requested) if (state.get(key)?.missing) throw Object.assign(new Error("规范化数据表不存在"), { code: "SCHEMA_MISSING" });
    const rawByKey = new Map();
    const legacyByKey = new Map();
    await forEachBounded(requested, readConcurrency, async key => {
      if (state.get(key)?.legacy) legacyByKey.set(key, (await readLegacy(key)).map(row => ({ ...sanitizeLegacyDocument(row.doc), id: row.id, _id: row.id })));
      else rawByKey.set(key, await query(pool, `SELECT * FROM \`${tableFor(key)}\` ORDER BY id`));
    });
    function* ownerBatches() {
      let batch = [];
      for (const [key, rows] of rawByKey) {
        for (let index = 0; index < rows.length; index++) {
          batch.push({ key, index, id: String(rows[index].id) });
          if (batch.length >= relationBatchSize) { yield batch; batch = []; }
        }
      }
      if (batch.length) yield batch;
    }
    const canonicalKeys = new Map(requested.map(key => [key.toLowerCase(),key]));
    // A rich order batch already fans out over eleven relation tables. Keep
    // only a small number of those batches resident while retaining enough
    // overlap to feed the pool; scalar-only collections can use every slot.
    const widestRelations = Math.max(0, ...requested.map(key => (RELATION_BY_KEY[key] || []).filter(name => name !== "account_permissions").length));
    const hydrationConcurrency = Math.min(readConcurrency, Math.max(2, Math.ceil(readConcurrency / (widestRelations + 1))));
    await forEachBounded(ownerBatches(), hydrationConcurrency, async batch => {
      const groups = new Map();
      for (const owner of batch) { if (!groups.has(owner.key)) groups.set(owner.key, []); groups.get(owner.key).push(owner); }
      const params = [], predicates = [];
      for (const [key, owners] of groups) {
        predicates.push(`(collection_name=? AND record_id IN (${owners.map(() => "?").join(",")}))`);
        params.push(key, ...owners.map(owner => owner.id));
      }
      const rows = await query(pool, `SELECT collection_name,record_id,path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM \`${RELATIONS.collection_values.table}\` WHERE ${predicates.join(" OR ")} ORDER BY collection_name,record_id,path,ordinal`, params);
      const attributesByKey = new Map([...groups.keys()].map(key => [key, []]));
      for (const row of rows) {
        const key = canonicalKeys.get(String(row.collection_name).toLowerCase());
        if (attributesByKey.has(key)) attributesByKey.get(key).push(row);
      }
      await Promise.all([...groups].map(async ([key, owners]) => {
        const related = await relationRowsMany(key, owners.map(owner => owner.id), pool, attributesByKey.get(key));
        const records = rawByKey.get(key);
        for (const owner of owners) records[owner.index] = hydrateDocument(key, records[owner.index], related.get(owner.id) || emptyRelations());
      }));
    });
    return Object.fromEntries(requested.map(key => [key, legacyByKey.has(key) ? legacyByKey.get(key) : rawByKey.get(key)]));
  }

  async function findOrderByPaymentOutTradeNo(outTradeNo) {
    await ensure();
    const value = String(outTradeNo || "").trim();
    if (!value) return null;
    const orderState = state.get("orders");
    if (orderState && (orderState.legacy || orderState.missing)) {
      const error = new Error("订单数据结构尚未就绪"); error.code = "SCHEMA_MISSING"; throw error;
    }
    const relation = RELATIONS.order_payment_records;
    const rows = await query(pool, `SELECT order_id FROM \`${relation.table}\` WHERE out_trade_no=? LIMIT 2`, [value]);
    if (rows.length !== 1) return null;
    return readOne("orders", String(rows[0].order_id));
  }

  async function findBookingByPaymentOutTradeNo(outTradeNo) {
    await ensure();
    const value = String(outTradeNo || "").trim();
    if (!value) return null;
    const relation = RELATIONS.booking_payment_records;
    const rows = await query(pool, `SELECT booking_id FROM \`${relation.table}\` WHERE out_trade_no=? LIMIT 2`, [value]);
    if (rows.length !== 1) return null;
    return readOne("bookingRequests", String(rows[0].booking_id));
  }

  async function deleteRelations(conn, key, id) {
    for (const relationName of RELATION_BY_KEY[key] || []) {
      const relation = RELATIONS[relationName]; const parent = relationParent(relationName);
      if (!relation || !parent) continue;
      if (relationName === "account_permissions") continue;
      await execute(conn, `DELETE FROM \`${relation.table}\` WHERE ${parent.columns[0]}=?`, [id]);
    }
    await execute(conn, `DELETE FROM \`${RELATIONS.collection_values.table}\` WHERE collection_name=? AND record_id=?`, [key, id]);
  }

  async function writeRelations(conn, key, id, relations, attributes) {
    await deleteRelations(conn, key, id);
    for (const [name, rows] of Object.entries(relations || {})) {
      if (name === "account_permissions") continue;
      const definition = RELATIONS[name]; if (!definition) continue;
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const statement = relationInsertSql(definition, row);
        await execute(conn, statement.sql, statement.params);
      }
    }
    for (const row of valueRows(key, id, attributes)) {
      const statement = relationInsertSql(RELATIONS.collection_values, row);
      await execute(conn, statement.sql, statement.params);
    }
  }

  async function writeRecord(conn, key, id, document, targetTable = tableFor(key), duplicate = false) {
    const split = splitDocument(key, { ...(document || {}), id });
    const row = rowForDocument(key, id, split.columns);
    const statement = duplicate ? insertSql(targetTable, row, true) : insertSql(targetTable, row, false);
    await execute(conn, statement.sql, statement.params);
    await writeRelations(conn, key, id, split.relations, split.attributes);
    return row;
  }

  async function create(key, document = {}) {
    assertKey(key); await ensure();
    const item = document && typeof document === "object" ? document : {};
    const id = String(item.id || item._id || (key === "orders" && item.orderId) || generatedId(key));
    const current = state.get(key);
    if (current && current.legacy) {
      const error = new Error("旧版数据表只读，请先执行规范化迁移"); error.code = "SCHEMA_LEGACY"; throw error;
    }
    try {
      await withTransaction(async conn => {
        await writeRecord(conn, key, id, item, tableFor(key), false);
        if (key === "orders") await require("./photoOrderBridge.cjs").syncPhotoOrderTx(conn,{...item,id},null);
      });
    } catch (error) {
      if (error && (error.code === "ER_DUP_ENTRY" || Number(error.errno) === 1062)) throw Object.assign(new Error("记录已存在"), { code: "DUPLICATE_RECORD" });
      throw error;
    }
    return readOne(key, id);
  }

  async function update(key, id, patch = {}) {
    assertKey(key); await ensure();
    const stateItem = state.get(key);
    if (stateItem && stateItem.legacy) { const error = new Error("旧版数据表只读，请先执行规范化迁移"); error.code = "SCHEMA_LEGACY"; throw error; }
    const changed = await withTransaction(async conn => {
      const rows = await query(conn, `SELECT * FROM \`${tableFor(key)}\` WHERE id=? FOR UPDATE`, [String(id)]);
      if (!rows.length) return false;
      const current = hydrateDocument(key, rows[0], await relationRows(key, String(id), conn));
      const normalizedPatch = schema.normalizeDocumentAliases(key, patch && typeof patch === "object" ? patch : {});
      const next = { ...current, ...normalizedPatch, id: String(id), _id: String(id) };
      await writeRecord(conn, key, String(id), next, tableFor(key), true);
      if (key === "orders") await require("./photoOrderBridge.cjs").syncPhotoOrderTx(conn,next,current);
      return true;
    });
    return changed ? readOne(key, String(id)) : null;
  }

  async function applySpotMutation(id, patch = {}, options = {}) {
    await ensure();
    const stateItem = state.get("spots");
    if (stateItem && (stateItem.legacy || stateItem.missing)) throw Object.assign(new Error("打卡点数据结构尚未就绪"), { code: stateItem.legacy ? "SCHEMA_LEGACY" : "SCHEMA_MISSING" });
    return withTransaction(async conn => {
      // Lock the complete order in a stable sequence, including insertion gaps.
      // Every reorder computes from committed values and publishes once at commit.
      const rows = await query(conn, `SELECT * FROM \`${tableFor("spots")}\` ORDER BY id FOR UPDATE`);
      const relations = await relationRowsMany("spots", rows.map(row => String(row.id)), conn);
      const documents = rows.map(row => hydrateDocument("spots", row, relations.get(String(row.id))));
      const plan = planSpotMutation(documents, id, schema.normalizeDocumentAliases("spots", patch), options);
      if (!plan) return null;
      for (const change of plan.changes) {
        await writeRecord(conn, "spots", change.id, change.after, tableFor("spots"), !!change.before);
      }
      return plan;
    });
  }

  async function applyContentMutation(key, id, patch = {}, options = {}) {
    if (!CONTENT_ORDER_KEYS.has(key)) throw new Error("不支持的内容排序类型");
    await ensure();
    const stateItem = state.get(key);
    if (stateItem && (stateItem.legacy || stateItem.missing)) throw Object.assign(new Error("商品数据结构尚未就绪"), { code: stateItem.legacy ? "SCHEMA_LEGACY" : "SCHEMA_MISSING" });
    return withTransaction(async conn => {
      // Serialize both pools in the packages table so conversion of a video
      // into a bundle cannot race either pool's insertion order.
      const rows = await query(conn, `SELECT * FROM \`${tableFor(key)}\` ORDER BY id FOR UPDATE`);
      const relations = await relationRowsMany(key, rows.map(row => String(row.id)), conn);
      const documents = rows.map(row => hydrateDocument(key, row, relations.get(String(row.id))));
      const plan = planContentMutation(key, documents, id, schema.normalizeDocumentAliases(key, patch), options);
      if (!plan) return null;
      for (const change of plan.changes) await writeRecord(conn, key, change.id, change.after, tableFor(key), !!change.before);
      return plan;
    });
  }

  async function upsert(key, id, patch = {}) {
    assertKey(key); await ensure();
    const current = await readOne(key, id);
    if (current) return update(key, id, patch);
    return create(key, { ...(patch || {}), id: String(id), _id: String(id) });
  }

  async function replace(key, id, document = {}) {
    assertKey(key); await ensure();
    const stateItem = state.get(key);
    if (stateItem && (stateItem.legacy || stateItem.missing)) throw Object.assign(new Error("数据结构尚未就绪"), { code: "SCHEMA_MISSING" });
    const changed = await withTransaction(async conn => {
      const rows = await query(conn, `SELECT id FROM \`${tableFor(key)}\` WHERE id=? FOR UPDATE`, [String(id)]);
      if (!rows.length) return false;
      const empty = Object.fromEntries(COLLECTIONS[key].columns.filter(column => column.name !== "id").map(column => [column.name, null]));
      await writeRecord(conn, key, String(id), { ...empty, ...schema.normalizeDocumentAliases(key, document), id: String(id), _id: String(id) }, tableFor(key), true);
      return true;
    });
    return changed ? readOne(key, String(id)) : null;
  }

  // Migration and file state changes compare under a row lock. Reading a
  // document before starting this transaction could overwrite a user's edit.
  async function compareAndUpdate(key, id, expected, patch) {
    assertKey(key); await ensure();
    const stateItem = state.get(key);
    if (stateItem && (stateItem.legacy || stateItem.missing)) throw Object.assign(new Error("数据结构尚未就绪"), { code: "SCHEMA_MISSING" });
    const changed = await withTransaction(async conn => {
      if (key === "orders" && ["rescheduleRequest", "cancellationSource", "customerCancelIdempotencyKey"].some(field => Object.hasOwn(patch || {}, field))) {
        // The workbench reads before flushing its changed columns. Share its
        // lock before reading this row, so a stale assignment/start cannot be
        // flushed after customer cancellation or reschedule approval commits.
        try { await query(conn, "SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE"); }
        catch (error) { if (error.code !== "ER_NO_SUCH_TABLE") throw error; }
      }
      const rows = await query(conn, `SELECT * FROM \`${tableFor(key)}\` WHERE id=? FOR UPDATE`, [String(id)]);
      if (!rows.length) return false;
      const current = hydrateDocument(key, rows[0], await relationRows(key, String(id), conn));
      if (!Object.entries(expected || {}).every(([field, value]) => isDeepStrictEqual(current[field], value))) return false;
      const normalized = schema.normalizeDocumentAliases(key, patch || {});
      const next = { ...current, ...normalized, id: String(id) };
      await writeRecord(conn, key, String(id), next, tableFor(key), true);
      if (key === "orders") await require("./photoOrderBridge.cjs").syncPhotoOrderTx(conn,next,current);
      return true;
    });
    return changed ? readOne(key, String(id)) : null;
  }

  async function remove(key, id) {
    assertKey(key); await ensure();
    const stateItem = state.get(key);
    if (stateItem && stateItem.legacy) { const error = new Error("旧版数据表只读，请先执行规范化迁移"); error.code = "SCHEMA_LEGACY"; throw error; }
    let affected = 0;
    await withTransaction(async (conn) => {
      await deleteRelations(conn, key, String(id));
      const result = await execute(conn, `DELETE FROM \`${tableFor(key)}\` WHERE id=?`, [id]);
      affected = Number(result && result.affectedRows || 0);
    });
    return affected > 0;
  }

  async function collectHealth() {
    try {
      await ensure();
      const names = ALL_KEYS.map((key) => tableFor(key));
      const relationNames = Object.values(RELATIONS).map((relation) => relation.table);
      const [columnsByTable,indexesByTable] = await Promise.all([
        inspectTables(pool, [...names, ...relationNames]),
        inspectTables(pool, names, true),
      ]);
      const columnsFor = name => columnsByTable.get(name.toLowerCase()) || new Set();
      const count = names.filter(name => columnsFor(name).size).length;
      const relationCount = relationNames.filter(name => columnsFor(name).size).length;
      const legacy = names.filter(name => columnsFor(name).has("doc")).length;
      const missing = names.length-count;
      const incomplete = [];
      for (const key of ALL_KEYS) {
        const columns = columnsFor(tableFor(key));
        if (columns.has("doc")) incomplete.push(`${tableFor(key)}.doc`);
        if (key === "logs" && (columns.has("snapshot") || !columns.has("snapshotText"))) incomplete.push(`${tableFor(key)}.snapshot`);
        for (const column of schema.definition(key).columns) if (!columns.has(column.name)) incomplete.push(`${tableFor(key)}.${column.name}`);
        const indexes = indexesByTable.get(tableFor(key).toLowerCase()) || new Set();
        if (![...indexes].some(column => column.toLowerCase() === "updatedat")) incomplete.push(`${tableFor(key)}.idx_updated_at`);
      }
      const financeLeaves = await query(pool, "SELECT COUNT(*) AS count FROM `lxm_collection_values` WHERE collection_name=?", ["financeSettings"]);
      if (Number(financeLeaves[0] && financeLeaves[0].count || 0) > 0) incomplete.push("lxm_collection_values.financeSettings");
      for (const relation of Object.values(RELATIONS)) {
        const columns = columnsFor(relation.table);
        for (const declaration of relation.columns) {
          const name = String(declaration).trim().split(/\s+/, 1)[0];
          if (!columns.has(name)) incomplete.push(`${relation.table}.${name}`);
        }
      }
      // A single request checks the same indexed orphan predicates as before.
      // Skip missing parent tables so health can report their precise columns.
      const parentKeys = ALL_KEYS.filter(key => columnsFor(tableFor(key)).has("id"));
      if (parentKeys.length && columnsFor(RELATIONS.collection_values.table).size) {
        const orphanRows = await query(pool, parentKeys.map(key => `SELECT ? AS collection_name,COUNT(*) AS count FROM \`${RELATIONS.collection_values.table}\` values_row LEFT JOIN \`${tableFor(key)}\` parent_row ON parent_row.id=values_row.record_id WHERE values_row.collection_name=? AND parent_row.id IS NULL`).join(" UNION ALL "), parentKeys.flatMap(key => [key,key]));
        for (const orphan of orphanRows) if (Number(orphan.count || 0) > 0) incomplete.push(`${RELATIONS.collection_values.table}.${orphan.collection_name}.orphan`);
      }
      const ready = count === ALL_KEYS.length && relationCount === relationNames.length && legacy === 0 && missing === 0 && incomplete.length === 0;
      return { backend: "mysql", configured: true, ready, persistent: true, tables: count, relationTables: relationCount, normalized: [...state.values()].filter((item) => !item.legacy && !item.missing).length, legacy, missing, ...(incomplete.length ? { error: "schema_incomplete", incomplete } : {}) };
    } catch (error) { return { backend: "mysql", configured: true, ready: false, persistent: true, error: error && error.code || "unavailable" }; }
  }

  async function health() {
    const timestamp = Date.now();
    if (latestReadyHealth && timestamp - latestReadyHealth.checkedAt < healthCacheMs) return latestReadyHealth.value;
    if (healthInFlight) return healthInFlight;
    healthInFlight = collectHealth()
      .then((value) => {
        if (value && value.ready) latestReadyHealth = { checkedAt: Date.now(), value };
        return value;
      })
      .finally(() => { healthInFlight = null; });
    return healthInFlight;
  }

  return {
    mode: "mysql",
    backend: "mysql",
    ALL_KEYS,
    schema,
    list: readMany,
    listMany,
    get: readOne,
    getMany,
    findOrderByPaymentOutTradeNo,
    findBookingByPaymentOutTradeNo,
    create,
    update,
    applySpotMutation,
    applyContentMutation,
    compareAndUpdate,
    replace,
    upsert,
    remove,
    listFavorites,
    getFavorite,
    upsertFavorite,
    removeFavorite,
    async object(key) { const rows = await readMany(key); return Object.fromEntries(rows.map((row) => [String(row.id || row._id), row])); },
    transaction: withTransaction,
    async ensureSchema() { await ensure(); return { version: 2 }; },
    async healthCheck() { return health(); },
    health,
    async close() { closed = true; if (typeof pool.end === "function") await pool.end(); }
  };
};

module.exports.ALL_KEYS = ALL_KEYS;
module.exports.schema = schema;
module.exports.groupRelationRows = groupRelationRows;
