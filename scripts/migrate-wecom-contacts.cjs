"use strict";

// Existing service installations can add only the provisioning columns, without
// changing commission activation, rates, role grants or historical members.
const path = require("node:path");
const { statements, applyStatement } = require("./migrate-customer-service.cjs");
const FILE = "023_svc_staff_wecom.sql";
async function migrate(source, { apply = false } = {}) {
  if (!apply) return { dryRun: true, migrations: [FILE], historicalMembersInvited: false };
  await source.transaction(async conn => {
    for (const statement of statements(path.join(__dirname, "../server/migrations", FILE))) await applyStatement(conn, statement);
  });
  return { applied: true, migrations: [FILE], historicalMembersInvited: false };
}
async function main() {
  const apply = process.argv.includes("--apply");
  if (!apply) return console.log(JSON.stringify(await migrate(null), null, 2));
  require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });
  const { source } = require("../server/lib/selectSource.cjs")();
  try { console.log(JSON.stringify(await migrate(source, { apply }), null, 2)); }
  finally { await source.close?.(); }
}
if (require.main === module) main().catch(() => { console.error("企微同步字段迁移失败，请核对客服模块安装情况与数据库权限"); process.exitCode = 1; });
module.exports = { migrate };
