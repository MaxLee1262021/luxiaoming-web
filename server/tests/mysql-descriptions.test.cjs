"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("../lib/mysqlSchema.cjs");
const descriptions = require("../lib/mysqlDescriptions.cjs");

test("all project MySQL tables and physical fields have descriptions", () => {
  const tables = descriptions.knownTableNames(schema);
  assert.equal(tables.length, 82);
  for (const table of tables) {
    assert.ok(descriptions.descriptionForTable(table), `${table} table description`);
    const columns = descriptions.knownColumnNames(schema, table);
    assert.ok(columns.length, `${table} columns`);
    for (const column of columns) assert.ok(descriptions.columnComment(column), `${table}.${column} column description`);
  }
});

test("generated dictionary covers the same table set", () => {
  const file = path.join(__dirname, "..", "..", "docs", "mysql-schema-dictionary.md");
  const text = fs.readFileSync(file, "utf8");
  for (const table of descriptions.knownTableNames(schema)) assert.match(text, new RegExp(`^## ${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});
