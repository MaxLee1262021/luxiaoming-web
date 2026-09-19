"use strict";

const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const migration = require("../server/lib/mediaMigration.cjs");
const { createOssStorage } = require("../server/lib/ossStorage.cjs");
const args = process.argv.slice(2);
const valueArg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };

async function main() {
  if (args.includes("--help")) {
    console.log("node scripts/migrate-files.cjs [--inventory | --apply | --rollback | --schema] [--manifest PATH]");
    console.log("Default: read-only inventory; writes a restricted manifest outside the source repository. Apply is resumable; rollback preserves edited records and never deletes source objects.");
    return;
  }
  if (args.includes("--schema")) {
    const mysql = require("mysql2/promise");
    const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
      connectTimeout: 8000, ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}) });
    try {
      const sql = require("../server/lib/mysqlSchema.cjs").schemaStatements().find(s => s.startsWith("CREATE TABLE IF NOT EXISTS `lxm_mediaFiles`"));
      await conn.query(sql);
      console.log(JSON.stringify({ ok: true, addedTable: "lxm_mediaFiles", existingBusinessTablesChanged: false }));
    } finally { await conn.end(); }
    return;
  }
  const { source } = require("../server/lib/selectSource.cjs")();
  const defaultDir = path.join(root, "..", ".oss-migration");
  let file = valueArg("--manifest");
  if (!file && (args.includes("--apply") || args.includes("--rollback"))) throw new Error("MANIFEST_REQUIRED");
  let manifest;
  const save = async doc => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  };
  try {
    if (args.includes("--apply") || args.includes("--rollback")) {
      file = path.resolve(file);
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("MANIFEST_INVALID");
      if (args.includes("--rollback")) await migration.rollbackManifest(source, manifest, save);
      else await migration.applyManifest(source, createOssStorage(), manifest, { save, staticRoots: [path.join(root, "public"), path.join(root, "..", "luxiaoming_交付包", "miniprogram")] });
    } else {
      manifest = await migration.inventory(source);
      file = path.resolve(file || path.join(defaultDir, `${manifest.runId}.json`));
      await save(manifest);
    }
    console.log(JSON.stringify({ ...migration.summary(manifest), manifest: file }, null, 2));
  } finally { await source.close(); }
}

if (require.main === module) main().catch(error => { console.error(JSON.stringify({ ok: false, code: /^[A-Z0-9_]+$/.test(String(error.code || error.message)) ? error.code || error.message : "MIGRATION_FAILED" })); process.exitCode = 1; });
module.exports = { main };
