"use strict";

// One-time migration for JSON account records. It never prints or commits
// credentials; use --dry-run to inspect the number of records to change.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const accountCollections = ["staff", "shops", "distributors", "agents"];

function parseArgs(argv) {
  const options = { file: path.join(root, "server", "data", "db.json"), dryRun: false, backup: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--file") options.file = path.resolve(root, argv[++i]);
    else if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--no-backup") options.backup = false;
    else if (argv[i] === "--help" || argv[i] === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

function hashPassword(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `lxm1$${salt}$${crypto.scryptSync(String(value), salt, 64).toString("hex")}`;
}

function assertInsideRoot(file) {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("目标文件必须位于项目目录内");
}

function migrateAccountRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 0;
  let count = 0;
  for (const field of ["password", "passwordHash"]) {
    const value = record[field];
    if (typeof value === "string" && value && !value.startsWith("lxm1$")) {
      record[field] = hashPassword(value);
      count += 1;
    }
  }
  return count;
}

function printHelp() {
  process.stdout.write("Usage: node scripts/migrate-passwords.cjs [--file server/data/db.json] [--dry-run] [--no-backup]\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  assertInsideRoot(options.file);
  const parsed = JSON.parse(fs.readFileSync(options.file, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.collections || typeof parsed.collections !== "object" || Array.isArray(parsed.collections)) throw new Error("JSON 数据文件格式无效");
  let changed = 0;
  for (const key of accountCollections) {
    const collection = parsed.collections[key];
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) continue;
    for (const record of Object.values(collection)) changed += migrateAccountRecord(record);
  }
  if (options.dryRun || changed === 0) {
    process.stdout.write(JSON.stringify({ file: path.relative(root, options.file), changed, dryRun: options.dryRun }) + "\n");
    return;
  }
  let backupFile = "";
  if (options.backup) {
    backupFile = `${options.file}.pre-password-migration-${Date.now()}.bak`;
    fs.copyFileSync(options.file, backupFile, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(backupFile, 0o600); } catch (_) {}
  }
  const temp = `${options.file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(parsed, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.renameSync(temp, options.file); } catch (_) { fs.copyFileSync(temp, options.file); fs.unlinkSync(temp); }
  try { fs.chmodSync(options.file, 0o600); } catch (_) {}
  process.stdout.write(JSON.stringify({ file: path.relative(root, options.file), changed, backup: backupFile ? path.relative(root, backupFile) : null }) + "\n");
}

try { main(); } catch (error) { process.stderr.write(`password migration failed: ${error.message}\n`); process.exitCode = 1; }
