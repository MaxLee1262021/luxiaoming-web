"use strict";

const fs = require("fs");
const path = require("path");
const schema = require("../server/lib/mysqlSchema.cjs");
const descriptions = require("../server/lib/mysqlDescriptions.cjs");

function tableKey(table) {
  return String(table).replace(/^lxm_/, "");
}

function typeMap(table) {
  const output = new Map();
  const businessKey = schema.ALL_KEYS.find(key => schema.tableName(key) === table);
  if (businessKey) for (const column of schema.definition(businessKey).columns) output.set(column.name, column.type);
  const relation = Object.values(schema.RELATIONS).find(definition => definition.table === table);
  if (relation) for (const declaration of relation.columns) {
    const text = String(declaration).trim();
    const name = text.split(/\s+/, 1)[0];
    output.set(name, text.slice(name.length).trim());
  }
  if (table === "lxm_user_favorites") {
    for (const [name, type] of Object.entries({ openid: "VARCHAR(128)", favorite_key: "VARCHAR(256)", type: "VARCHAR(64)", item_id: "VARCHAR(128)", type_label: "VARCHAR(255)", title: "VARCHAR(255)", cover: "TEXT", price: "DECIMAL(18,2)", spot: "VARCHAR(255)", spot_id: "VARCHAR(128)", url: "TEXT", created_at: "DATETIME(3)", updated_at: "DATETIME(3)" })) output.set(name, type);
  }
  const authTypes = {
    id: "VARCHAR(128)", menu_key: "VARCHAR(128)", parent_key: "VARCHAR(128)", name: "VARCHAR(128)",
    path: "VARCHAR(255)", icon: "VARCHAR(64)", sort_no: "INT", status: "VARCHAR(32)",
    role_key: "VARCHAR(64)", role_id: "VARCHAR(128)", permission_key: "VARCHAR(128)", user_id: "VARCHAR(128)",
    account: "VARCHAR(128)", display_name: "VARCHAR(128)", password_hash: "VARCHAR(255)",
    phone: "VARCHAR(64)", email: "VARCHAR(255)", legacy_key: "VARCHAR(64)", legacy_id: "VARCHAR(128)",
    subject_type: "VARCHAR(64)", subject_id: "VARCHAR(128)", shop_id: "VARCHAR(128)",
    distributor_id: "VARCHAR(128)", agent_id: "VARCHAR(128)", created_at: "DATETIME(3)", updated_at: "DATETIME(3)",
    applied_at: "DATETIME(3)", version: "INT"
  };
  for (const name of descriptions.knownColumnNames(schema, table)) if (!output.has(name)) {
    output.set(name, authTypes[name] || (name === "created_at" || name === "updated_at" || name === "applied_at" ? "DATETIME(3)" : "VARCHAR(255)"));
  }
  return output;
}

function render() {
  const tables = descriptions.knownTableNames(schema).sort();
  const lines = [
    "# MySQL 表与字段字典",
    "",
    "> 本字典由 `scripts/generate-mysql-dictionary.cjs` 从 `mysqlSchema.cjs` 和 `mysqlDescriptions.cjs` 生成。数据库中的 `TABLE_COMMENT` / `COLUMN_COMMENT` 由 `npm run migrate:mysql -- --apply` 同步。",
    "",
    `共 ${tables.length} 张表。字段描述覆盖业务表、关系表、权限表、媒体表、收藏表和系统元数据表。`,
    ""
  ];
  for (const table of tables) {
    const key = tableKey(table);
    const columns = typeMap(table);
    lines.push(`## ${table}`, "", `**表描述：** ${descriptions.descriptionForTable(table, key)}`, "", "| 字段 | 类型 | 描述 |", "| --- | --- | --- |");
    for (const [name, type] of columns) lines.push(`| \`${name}\` | \`${String(type).replace(/\|/g, "\\|")}\` | ${descriptions.columnComment(name).replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  return lines.join("\n");
}

const output = path.join(__dirname, "..", "docs", "mysql-schema-dictionary.md");
fs.writeFileSync(output, render() + "\n", "utf8");
console.log(JSON.stringify({ output, tables: descriptions.knownTableNames(schema).length }));
