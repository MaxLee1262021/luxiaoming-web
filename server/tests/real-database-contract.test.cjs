"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const createSource = require("../lib/dbSource.cjs");
const createPermissionStore = require("../lib/permissionStore.cjs");

test("runtime business and authorization factories cannot open a JSON data source", async () => {
  assert.throws(() => createSource({ backend: "json", jsonFile: "must-not-open.json" }), { code: "DATA_SOURCE_CONFIG_INVALID" });
  const permissions = createPermissionStore({ backend: "json", jsonFile: "must-not-open.json" });
  assert.equal(permissions.unavailable, true);
  assert.equal((await permissions.health()).ready, false);
  await assert.rejects(permissions.listUsers(), { code: "DATA_SOURCE_CONFIG_INVALID" });
});

test("migration planning never discovers local data or accepts retired demo imports", () => {
  const runner = path.resolve(__dirname, "../../scripts/migrate-mysql.cjs");
  const invoke = (args, jsonFile) => spawnSync(process.execPath, [runner, ...args], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, JSON_FILE: jsonFile },
  });
  const plan = invoke(["--dry-run"], path.join(__dirname, "must-not-open.json"));
  assert.equal(plan.status, 0, plan.stderr);
  const report = JSON.parse(plan.stdout);
  assert.equal(report.jsonFile, null); assert.equal(report.importJson, false);
  assert.ok(Object.values(report.collections).every((count) => count === 0));
  const demo = invoke(["--import-fixture", "--dry-run"], "");
  assert.notEqual(demo.status, 0); assert.match(demo.stderr, /演示种子导入已移除/);
  const missing = invoke(["--import-json", "--dry-run"], "");
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /显式设置.*JSON_FILE/);
});
