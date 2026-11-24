"use strict";

// Additive menu installation; the default command never opens a database.
async function install(source) {
  return source.transaction(async conn => {
    const [existing] = await conn.query("SELECT id FROM lxm_auth_menus WHERE menu_key='productLinks' FOR UPDATE");
    // Existing status, placement and role grants belong to permission management.
    if (existing.length) return { created: false, existingPermissionsPreserved: true };
    await conn.query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES ('menu_productLinks','productLinks','商品小程序外链','/service/productLinks',231,'active','客服工作台','page')");
    await conn.query("INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) SELECT id,'productLinks' FROM lxm_auth_roles WHERE role_key IN ('super','service','service_supervisor')");
    return { created: true, roles: ["super", "service", "service_supervisor"] };
  });
}

async function main() {
  if (!process.argv.includes("--apply")) {
    process.stdout.write(JSON.stringify({ dryRun: true, menu: "productLinks", name: "商品小程序外链", group: "客服工作台", roles: ["super", "service", "service_supervisor"], existingPermissionsPreserved: true }) + "\n");
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
if (require.main === module) main().catch(error => { process.stderr.write(`${error.code || "PRODUCT_LINK_MENU_INSTALL_FAILED"}\n`); process.exitCode = 1; });
module.exports = { install };
