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
const schema = require("./mysqlSchema.cjs");

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

function bool(value) { return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true"; }
function now() { return new Date(); }
function generatedId(key) { return `${String(key).slice(0, 2)}_${crypto.randomBytes(8).toString("hex")}`; }

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
  const suffix = updates.length ? ` ON DUPLICATE KEY UPDATE ${updates.join(",")}` : "";
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

  const pool = cfg.pool || mysql.createPool({
    host: cfg.dbHost,
    port: cfg.dbPort || 3306,
    user: cfg.dbUser,
    password: cfg.dbPassword || "",
    database: cfg.dbName,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit || 10,
    multipleStatements: false,
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

  async function query(conn, sql, params = []) {
    const [rows] = await conn.query(sql, params);
    return rows;
  }
  async function execute(conn, sql, params = []) {
    const [result] = await conn.query(sql, params);
    return result;
  }
  async function withTransaction(fn) {
    if (typeof pool.getConnection !== "function") return fn(pool);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      throw error;
    } finally { try { conn.release(); } catch (_) {} }
  }

  async function inspectTable(conn, table) {
    const rows = await query(conn, "SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position", [table]);
    return new Set(rows.map((row) => String(row.column_name || row.COLUMN_NAME || "" )).filter(Boolean));
  }

  async function ensureIndexes(conn) {
    for (const key of ALL_KEYS) {
      const table = tableName(key);
      const columns = await inspectTable(conn, table);
      if (!columns.size) continue;
      const indexes = await query(conn, "SELECT index_name,column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=?", [table]);
      if (!indexes.some((row) => String(row.column_name).toLowerCase() === "updatedat")) {
        const name = indexes.some((row) => String(row.index_name).toLowerCase() === "idx_updated_at") ? "idx_updated_at_normalized" : "idx_updated_at";
        await execute(conn, `ALTER TABLE \`${table}\` ADD KEY \`${name}\` (\`updatedAt\`)`);
      }
    }
    const users = await inspectTable(conn, "lxm_auth_users");
    if (users.size) {
      const indexes = await query(conn, "SELECT index_name,column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='lxm_auth_users'");
      if (!indexes.some((row) => ["subject_type", "subject_id"].includes(String(row.column_name).toLowerCase()))) await execute(conn, "ALTER TABLE `lxm_auth_users` ADD KEY `idx_auth_user_subject` (subject_type,subject_id)");
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
          schemaReady = true;
          return true;
        } finally { if (conn !== pool && typeof conn.release === "function") conn.release(); }
      })().finally(() => { ensurePromise = null; });
    }
    return ensurePromise;
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

  async function relationRows(key, id) {
    const output = { [COLLECTION_VALUES_TABLE]: await query(pool, `SELECT collection_name,record_id,path,ordinal,value_type,value_text,value_number,value_bool,value_time FROM \`${RELATIONS.collection_values.table}\` WHERE collection_name=? AND record_id=? ORDER BY path,ordinal`, [key, id]) };
    for (const relationName of RELATION_BY_KEY[key] || []) {
      const relation = RELATIONS[relationName];
      const parent = relationParent(relationName);
      if (!relation || !parent) continue;
      if (relationName === "account_permissions") output[relationName] = await query(pool, `SELECT * FROM \`${relation.table}\` WHERE collection_name=? AND account_id=? ORDER BY sort_no`, [key, id]);
      else {
        const orderBy = relationOrderColumns(relation).map((name) => `\`${name}\``).join(",");
        output[relationName] = await query(pool, `SELECT * FROM \`${relation.table}\` WHERE ${parent.columns[0]}=? ORDER BY ${orderBy}`, [id]);
      }
    }
    return output;
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
    const output = [];
    for (const row of rows) output.push(hydrateDocument(key, row, await relationRows(key, String(row.id))));
    return output;
  }

  async function deleteRelations(conn, key, id) {
    for (const relationName of RELATION_BY_KEY[key] || []) {
      const relation = RELATIONS[relationName]; const parent = relationParent(relationName);
      if (!relation || !parent) continue;
      if (relationName === "account_permissions") await execute(conn, `DELETE FROM \`${relation.table}\` WHERE collection_name=? AND account_id=?`, [key, id]);
      else await execute(conn, `DELETE FROM \`${relation.table}\` WHERE ${parent.columns[0]}=?`, [id]);
    }
    await execute(conn, `DELETE FROM \`${RELATIONS.collection_values.table}\` WHERE collection_name=? AND record_id=?`, [key, id]);
  }

  async function writeRelations(conn, key, id, relations, attributes) {
    await deleteRelations(conn, key, id);
    for (const [name, rows] of Object.entries(relations || {})) {
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
      await withTransaction((conn) => writeRecord(conn, key, id, item, tableFor(key), false));
    } catch (error) {
      if (error && (error.code === "ER_DUP_ENTRY" || Number(error.errno) === 1062)) throw Object.assign(new Error("记录已存在"), { code: "DUPLICATE_RECORD" });
      throw error;
    }
    return readOne(key, id);
  }

  async function update(key, id, patch = {}) {
    assertKey(key); await ensure();
    const current = await readOne(key, id); if (!current) return null;
    const normalizedPatch = schema.normalizeDocumentAliases(key, patch && typeof patch === "object" ? patch : {});
    const next = { ...current, ...normalizedPatch, id: String(id), _id: String(id) };
    const stateItem = state.get(key);
    if (stateItem && stateItem.legacy) { const error = new Error("旧版数据表只读，请先执行规范化迁移"); error.code = "SCHEMA_LEGACY"; throw error; }
    await withTransaction((conn) => writeRecord(conn, key, String(id), next, tableFor(key), true));
    return readOne(key, String(id));
  }

  async function upsert(key, id, patch = {}) {
    assertKey(key); await ensure();
    const current = await readOne(key, id);
    if (current) return update(key, id, patch);
    return create(key, { ...(patch || {}), id: String(id), _id: String(id) });
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

  async function health() {
    try {
      await ensure();
      const names = ALL_KEYS.map((key) => tableFor(key));
      const rows = await query(pool, `SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (${names.map(() => "?").join(",")})`, names);
      const count = Number(rows[0] && rows[0].count || 0);
      const relationNames = Object.values(RELATIONS).map((relation) => relation.table);
      const relationRows = relationNames.length
        ? await query(pool, `SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (${relationNames.map(() => "?").join(",")})`, relationNames)
        : [{ count: 0 }];
      const relationCount = Number(relationRows[0] && relationRows[0].count || 0);
      const legacy = [...state.values()].filter((item) => item.legacy).length;
      const missing = [...state.values()].filter((item) => item.missing).length;
      const incomplete = [];
      for (const key of ALL_KEYS) {
        const columns = await inspectTable(pool, tableFor(key));
        if (columns.has("doc")) incomplete.push(`${tableFor(key)}.doc`);
        if (key === "logs" && (columns.has("snapshot") || !columns.has("snapshotText"))) incomplete.push(`${tableFor(key)}.snapshot`);
        for (const column of schema.definition(key).columns) if (!columns.has(column.name)) incomplete.push(`${tableFor(key)}.${column.name}`);
        const indexes = await query(pool, "SELECT column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=?", [tableFor(key)]);
        if (!indexes.some((row) => String(row.column_name).toLowerCase() === "updatedat")) incomplete.push(`${tableFor(key)}.idx_updated_at`);
      }
      const financeLeaves = await query(pool, "SELECT COUNT(*) AS count FROM `lxm_collection_values` WHERE collection_name=?", ["financeSettings"]);
      if (Number(financeLeaves[0] && financeLeaves[0].count || 0) > 0) incomplete.push("lxm_collection_values.financeSettings");
      for (const relation of Object.values(RELATIONS)) {
        const columns = await inspectTable(pool, relation.table);
        for (const declaration of relation.columns) {
          const name = String(declaration).trim().split(/\s+/, 1)[0];
          if (!columns.has(name)) incomplete.push(`${relation.table}.${name}`);
        }
      }
      for (const key of ALL_KEYS) {
        const orphan = await query(pool, `SELECT COUNT(*) AS count FROM \`${RELATIONS.collection_values.table}\` values_row LEFT JOIN \`${tableFor(key)}\` parent_row ON parent_row.id=values_row.record_id WHERE values_row.collection_name=? AND parent_row.id IS NULL`, [key]);
        if (Number(orphan[0] && orphan[0].count || 0) > 0) incomplete.push(`${RELATIONS.collection_values.table}.${key}.orphan`);
      }
      const ready = count === ALL_KEYS.length && relationCount === relationNames.length && legacy === 0 && missing === 0 && incomplete.length === 0;
      return { backend: "mysql", configured: true, ready, persistent: true, tables: count, relationTables: relationCount, normalized: [...state.values()].filter((item) => !item.legacy && !item.missing).length, legacy, missing, ...(incomplete.length ? { error: "schema_incomplete", incomplete } : {}) };
    } catch (error) { return { backend: "mysql", configured: true, ready: false, persistent: true, error: error && error.code || "unavailable" }; }
  }

  return {
    mode: "mysql",
    backend: "mysql",
    ALL_KEYS,
    schema,
    list: readMany,
    get: readOne,
    create,
    update,
    upsert,
    remove,
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
