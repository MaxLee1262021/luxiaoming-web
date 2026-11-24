"use strict";

// Additive installation only. Without --apply, no database is opened.
async function install(source) {
  return source.transaction(async conn => {
    const [existing] = await conn.query("SELECT id FROM lxm_auth_menus WHERE menu_key='svcGeneralWorkbench' FOR UPDATE");
    if (existing.length) return { created: false, existingPermissionsPreserved: true };
    await conn.query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES ('menu_svcGeneralWorkbench','svcGeneralWorkbench','总工作台','/service/svcGeneralWorkbench',229,'active','客服工作台','page')");
    await conn.query("INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) SELECT id,'svcGeneralWorkbench' FROM lxm_auth_roles WHERE role_key IN ('super','service','service_supervisor') AND status='active'");
    return { created: true, roles: ["super", "service", "service_supervisor"], originalMenusUnchanged: true };
  });
}
async function main() {
  if (!process.argv.includes("--apply")) {
    process.stdout.write(JSON.stringify({ dryRun: true, menu: "svcGeneralWorkbench", name: "总工作台", group: "客服工作台", roles: ["super", "service", "service_supervisor"], originalMenusUnchanged: true }) + "\n");
    return;
  }
  require("dotenv").config({ path: require("node:path").resolve(__dirname, "../.env"), quiet: true });
  const conn = await require("mysql2/promise").createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME, charset: "utf8mb4" });
  try {
    const result = await install({ async transaction(work) {
      await conn.beginTransaction();
      try { const value = await work(conn); await conn.commit(); return value; }
      catch (error) { await conn.rollback(); throw error; }
    } });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { await conn.end(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.code || "GENERAL_MENU_INSTALL_FAILED"}\n`); process.exitCode = 1; });
module.exports = { install };
