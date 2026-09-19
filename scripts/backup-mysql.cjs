"use strict";

// Creates a portable, consistent SQL snapshot using the same mysql2 driver as
// the runtime. This avoids relying on an installed mysqldump binary whose
// authentication plugins may not match the local server.

const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const mysql = require("mysql2");
const mysqlPromise = require("mysql2/promise");

const root = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot serialize a non-finite number");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Date) return mysql.escape(value.toISOString());
  if (typeof value === "object") return mysql.escape(JSON.stringify(value));
  return mysql.escape(String(value));
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseArgs(argv) {
  const options = { output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") options.output = argv[++index] || "";
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  process.stdout.write([
    "Usage: node scripts/backup-mysql.cjs [--output <path>]",
    "Creates a read-only, transaction-consistent SQL backup using DB_* values from .env.",
    "The command refuses to overwrite an existing backup.",
  ].join("\n") + "\n");
}

async function write(stream, content) {
  if (!stream.write(content, "utf8")) await once(stream, "drain");
}

async function closeStream(stream) {
  stream.end();
  await once(stream, "finish");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const config = {
    host: env("DB_HOST", env("MYSQL_HOST", "127.0.0.1")),
    port: Number(env("DB_PORT", env("MYSQL_PORT", "3306"))),
    user: env("DB_USER", env("MYSQL_USER", "root")),
    password: process.env.DB_PASSWORD ?? process.env.MYSQL_PASSWORD ?? "",
    database: env("DB_NAME", env("MYSQL_DATABASE", "luxiaoming_admin")),
    connectTimeout: 10000,
  };
  if (!config.host || !config.user || !config.database || !Number.isInteger(config.port) || config.port < 1) {
    throw new Error("DB_HOST、DB_PORT、DB_USER、DB_NAME 配置无效");
  }

  const defaultOutput = path.resolve(root, "..", ".mysql-backups", `${config.database}-backup-${formatTimestamp()}.sql`);
  const output = path.resolve(options.output || defaultOutput);
  const partial = `${output}.partial`;
  if (fs.existsSync(output) || fs.existsSync(partial)) throw new Error("备份目标已存在，拒绝覆盖");
  await fs.promises.mkdir(path.dirname(output), { recursive: true });

  const stream = fs.createWriteStream(partial, { flags: "wx", encoding: "utf8", mode: 0o600 });
  const connection = await mysqlPromise.createConnection(config);
  let committed = false;
  try {
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    const [tables] = await connection.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
      [config.database],
    );
    let rowCount = 0;
    await write(stream, `-- ${config.database} backup created ${new Date().toISOString()}\n`);
    await write(stream, "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n");
    for (const row of tables) {
      const table = String(row.TABLE_NAME);
      const quoted = quoteIdentifier(table);
      const [createRows] = await connection.query(`SHOW CREATE TABLE ${quoted}`);
      const createSql = createRows[0] && (createRows[0]["Create Table"] || createRows[0]["Create View"]);
      if (!createSql) throw new Error(`无法读取表结构: ${table}`);
      await write(stream, `-- Table ${quoted}\n${createSql};\n`);
      const [columns] = await connection.query(`SHOW COLUMNS FROM ${quoted}`);
      const names = columns.map((column) => String(column.Field));
      const [rows] = await connection.query(`SELECT * FROM ${quoted}`);
      rowCount += rows.length;
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        const tuples = batch.map((record) => `(${names.map((name) => sqlValue(record[name])).join(",")})`);
        await write(stream, `INSERT INTO ${quoted} (${names.map(quoteIdentifier).join(",")}) VALUES\n${tuples.join(",\n")};\n`);
      }
      await write(stream, "\n");
    }
    await write(stream, "SET FOREIGN_KEY_CHECKS=1;\n");
    await connection.commit();
    committed = true;
    await closeStream(stream);
    await fs.promises.rename(partial, output);
    process.stdout.write(JSON.stringify({ database: config.database, tables: tables.length, rows: rowCount, output }) + "\n");
  } catch (error) {
    if (!committed) {
      try { await connection.rollback(); } catch (_) {}
    }
    stream.destroy();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  process.stderr.write(`backup failed: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
