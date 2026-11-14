"use strict";

// A connection and schema-presence probe. Never creates tables, seeds records,
// runs migrations or prints connection credentials.
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
const mysql = require("mysql2/promise");
const schema = require("../server/lib/mysqlSchema.cjs");

async function main() {
  const port = Number(process.env.DB_PORT || 3306);
  const config = { host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME,
    port, connectTimeout: 5000, ...(process.env.DB_SSL === "true" ? { ssl: {} } : {}) };
  if (!config.host || !config.user || !config.database || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("Missing or invalid MySQL configuration"), { code: "MYSQL_CONFIG_INVALID" });
  }
  let connection;
  try {
    connection = await mysql.createConnection(config);
    await connection.query("SET TRANSACTION READ ONLY");
    await connection.beginTransaction();
    await connection.query("SELECT 1 AS connected");
    const [caseRows] = await connection.query("SELECT @@lower_case_table_names AS value");
    const normalizeName = Number(caseRows[0] && caseRows[0].value) ? (name) => String(name).toLowerCase() : (name) => String(name);
    const [rows] = await connection.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'lxm_%'");
    const names = new Set(rows.map((row) => normalizeName(row.name)));
    const required = [...schema.ALL_KEYS.map(schema.tableName), ...Object.values(schema.RELATIONS).map((relation) => relation.table), "lxm_auth_users", "lxm_auth_roles", "lxm_auth_menus"];
    const missing = [...new Set(required)].filter((name) => !names.has(normalizeName(name)));
    const [columnRows] = await connection.query("SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name LIKE 'lxm_%'");
    const columns = new Set(columnRows.map((row) => `${normalizeName(row.table_name)}.${String(row.column_name).toLowerCase()}`));
    const missingColumns = [];
    const checkColumn = (table, name) => { if (names.has(normalizeName(table)) && !columns.has(`${normalizeName(table)}.${String(name).toLowerCase()}`)) missingColumns.push(`${table}.${name}`); };
    for (const key of schema.ALL_KEYS) for (const column of schema.definition(key).columns) checkColumn(schema.tableName(key), column.name);
    for (const relation of Object.values(schema.RELATIONS)) for (const declaration of relation.columns) checkColumn(relation.table, String(declaration).trim().split(/\s+/, 1)[0]);
    const result = { backend: "mysql", connected: true, ready: !missing.length && !missingColumns.length, readOnly: true, tables: names.size, missingTables: missing, missingColumns };
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ready) process.exitCode = 1;
  } finally {
    if (connection) { try { await connection.rollback(); } finally { await connection.end(); } }
  }
}

if (require.main === module) main().catch((error) => {
  process.stdout.write(JSON.stringify({ backend: "mysql", connected: false, ready: false, readOnly: true, error: error.code || "MYSQL_PROBE_FAILED" }) + "\n");
  process.exitCode = 1;
});

module.exports = { main };
