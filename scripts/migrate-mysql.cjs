// Migrate the JSON delivery database into MySQL. Output is deliberately
// aggregate-only: passwords, connection strings, and business payloads never
// appear in logs.
const fs = require("fs");
const path = require("path");
try { require("dotenv").config(); } catch (_) {}
const createPermissionStore = require("../server/lib/permissionStore.cjs");

const args = new Set(process.argv.slice(2));
const mode = args.has("--rollback") ? "rollback" : args.has("--apply") ? "apply" : "dry-run";
const root = path.join(__dirname, "..");
const dataFile = process.env.JSON_FILE || path.join(root, "server", "data", "db.json");
const keys = createPermissionStore.BUSINESS_KEYS;
const env = (name, fallback = "") => String(process.env[name] || fallback).trim();

function config() {
  return { host: env("DB_HOST", env("MYSQL_HOST")), port: Number(env("DB_PORT", env("MYSQL_PORT", "3306"))), user: env("DB_USER", env("MYSQL_USER")), password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || "", database: env("DB_NAME", env("MYSQL_DATABASE")), connectTimeout: 4000, multipleStatements: false };
}
function readJson() {
  try { const d = JSON.parse(fs.readFileSync(dataFile, "utf8")); return d && d.collections ? d : { collections: {} }; }
  catch (e) { if (e.code === "ENOENT") return { collections: {} }; throw new Error("JSON 数据文件无效"); }
}
function records(data, key) {
  const value = data.collections && data.collections[key];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([id, doc]) => ({ id: String(doc && (doc.id || doc._id) || id), doc: { ...(doc || {}), id: String(doc && (doc.id || doc._id) || id) } }));
}
async function statements(conn) {
  const text = fs.readFileSync(path.join(root, "server", "migrations", "001_authz.sql"), "utf8").replace(/--[^\r\n]*/g, "");
  for (const sql of text.split(";").map((x) => x.trim()).filter(Boolean)) await conn.query(sql);
}
async function run() {
  const data = readJson();
  const counts = Object.fromEntries(keys.map((k) => [k, records(data, k).length]));
  const accountCount = ["staff", "shops", "distributors", "agents"].reduce((n, k) => n + records(data, k).filter((r) => r.doc.account).length, 0);
  if (mode === "dry-run") { console.log(JSON.stringify({ mode, dataFile, collections: counts, accounts: accountCount })); return; }
  let mysql;
  try { mysql = require("mysql2/promise"); } catch (_) { throw Object.assign(new Error("MySQL 驱动未安装"), { code: "DATA_SOURCE_UNAVAILABLE" }); }
  const cfg = config();
  if (!cfg.host || !cfg.user || !cfg.database) throw new Error("DB_HOST、DB_USER、DB_NAME 配置不完整");
  const conn = await mysql.createConnection(cfg);
  try {
    if (mode === "rollback") {
      for (const table of ["lxm_auth_role_permissions", "lxm_auth_role_menus", "lxm_auth_users", "lxm_auth_menus", "lxm_auth_roles", "lxm_business_documents"]) await conn.query(`DROP TABLE IF EXISTS ${table}`);
      console.log(JSON.stringify({ mode, dropped: 6 })); return;
    }
    await statements(conn);
    let migrated = 0;
    for (const key of keys) for (const row of records(data, key)) {
      await conn.query("INSERT INTO lxm_business_documents (collection_name,id,doc,created_at,updated_at) VALUES (?,?,?,?,NOW(3)) ON DUPLICATE KEY UPDATE doc=VALUES(doc),updated_at=NOW(3)", [key, row.id, JSON.stringify(row.doc), new Date(),]);
      await conn.query(`INSERT INTO lxm_${key} (id,doc,updated_at) VALUES (?,?,NOW(3)) ON DUPLICATE KEY UPDATE doc=VALUES(doc),updated_at=NOW(3)`, [row.id, JSON.stringify(row.doc)]);
      migrated++;
    }
    const store = createPermissionStore({ ...cfg, backend: "mysql" }); await store.init();
    let syncedAccounts = 0;
    for (const key of ["staff", "shops", "distributors", "agents"]) for (const row of records(data, key)) if (row.doc.account) { await store.syncLegacyAccount(key, row.doc); syncedAccounts++; }
    await store.close();
    console.log(JSON.stringify({ mode, migrated, syncedAccounts, collections: counts }));
  } finally { await conn.end(); }
}
run().catch((e) => { console.error(JSON.stringify({ error: e.code || "migration_failed", message: e.message })); process.exitCode = 1; });
