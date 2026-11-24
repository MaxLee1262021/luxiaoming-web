"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { migrate } = require("../../scripts/migrate-wecom-contacts.cjs");

const columns = ["wecom_userid", "wecom_department_id", "wecom_sync_status", "wecom_sync_message", "wecom_sync_started_at", "wecom_synced_at"];

test("the focused WeCom migration defaults to a read-only plan without opening its source", async () => {
  const unopenedSource = new Proxy({}, { get() { throw Error("dry run must not access a data source"); } });
  assert.deepEqual(await migrate(unopenedSource), { dryRun: true, migrations: ["023_svc_staff_wecom.sql"], historicalMembersInvited: false });
  assert.equal((await migrate(null)).dryRun, true);
});

test("the default CLI plan never loads environment credentials or creates a database adapter", () => {
  const script = path.resolve(__dirname, "../../scripts/migrate-wecom-contacts.cjs");
  const code = `
    const Module = require('node:module'), original = Module._load;
    Module._load = function(request, ...args) {
      if (request === 'dotenv' || /selectSource\\.cjs$/.test(request)) throw Error('Database/environment access during dry run');
      return original.call(this, request, ...args);
    };
    process.argv = [process.execPath, ${JSON.stringify(script)}];
    Module._load(${JSON.stringify(script)}, null, true);
  `;
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.equal(JSON.parse(result.stdout).historicalMembersInvited, false);
});

test("the focused migration installs the shared map, adds six nullable columns and preserves existing data on reapply", async () => {
  const { statements } = require("../../scripts/migrate-customer-service.cjs");
  const normalize = sql => sql.replace(/\s+/g, " ").trim();
  const mapDefinition = normalize(statements(path.resolve(__dirname, "../migrations/015_merchant_share.sql")).find(sql => /^CREATE TABLE IF NOT EXISTS lxm_share_staff_map\b/.test(sql)));
  for (const alreadyInstalled of [false, true]) {
    const existing = new Set(["id", "name", "phone"]), queries = [];
    const mapping = { wecom_userid: "historical-member", staff_id: "historical-login", status: "ACTIVE", created_at: "2026-11-01 00:00:00.000" };
    let mapRows = alreadyInstalled ? [structuredClone(mapping)] : undefined;
    const business = { activation: "2026-11-01T00:00:00+08:00", benefit_rule: [{ id: "historical-rule", rate_photo_bp: 500 }], roles: [{ role_key: "service", grants: ["svcMine"] }], staff: [{ id: "historical-staff", name: "Existing" }] };
    const before = structuredClone(business);
    let transactions = 0;
    const source = { async transaction(work) {
      transactions++;
      return work({ async query(sql, params = []) {
        queries.push({ sql, params });
        if (/^CREATE TABLE IF NOT EXISTS lxm_share_staff_map\b/.test(sql)) {
          assert.equal(normalize(sql), mapDefinition, "the service-only installation must use the established shared mapping schema");
          if (!mapRows) mapRows = [];
          return [{ affectedRows: 0 }];
        }
        if (sql.startsWith("SELECT column_name FROM information_schema.columns")) {
          assert.equal(params[0], "svc_staff"); assert.ok(columns.includes(params[1]));
          return [existing.has(params[1]) ? [{ column_name: params[1] }] : []];
        }
        const alter = sql.match(/^ALTER TABLE `svc_staff` ADD COLUMN (wecom_\w+) (?:VARCHAR\(\d+\)|BIGINT UNSIGNED|DATETIME) NULL DEFAULT NULL$/);
        assert.ok(alter, "unexpected mutation or query: " + sql);
        assert.equal(existing.has(alter[1]), false); existing.add(alter[1]); return [{ affectedRows: 0 }];
      } });
    } };
    const result = await migrate(source, { apply: true });
    assert.equal(result.applied, true); assert.equal(result.historicalMembersInvited, false);
    assert.deepEqual(mapRows, alreadyInstalled ? [mapping] : [], "create-if-missing must preserve the original mapping table");
    assert.deepEqual([...existing].filter(name => name.startsWith("wecom_")), columns);
    assert.equal(queries.filter(query => query.sql.startsWith("ALTER TABLE")).length, 6);
    if (!alreadyInstalled) mapRows.push(structuredClone(mapping));
    const savedMappings = structuredClone(mapRows), count = queries.length;
    await migrate(source, { apply: true });
    assert.equal(transactions, 2);
    assert.equal(queries.slice(count).length, 7);
    assert.equal(queries.slice(count).filter(query => query.sql.startsWith("CREATE TABLE IF NOT EXISTS lxm_share_staff_map")).length, 1);
    assert.equal(queries.slice(count).filter(query => query.sql.startsWith("SELECT column_name FROM information_schema.columns")).length, 6);
    assert.equal(queries.filter(query => query.sql.startsWith("ALTER TABLE")).length, 6, "reapplying must not add columns again");
    assert.deepEqual(mapRows, savedMappings, "reapplying must preserve mappings inserted after the original installation");
    assert.deepEqual(business, before, "activation, accounting, roles and historical members must remain unchanged");
  }
});

test("the complete service installation plan includes the WeCom schema upgrade", async () => {
  const { migrate: fullMigrate } = require("../../scripts/migrate-customer-service.cjs");
  const plan = await fullMigrate(null);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.migrations.filter(file => file === "023_svc_staff_wecom.sql").length, 1);
  assert.equal(plan.historicalBindingsCreated, false);
});
