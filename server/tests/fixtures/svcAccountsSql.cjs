"use strict";
// TEST_ONLY SQL transaction adapter. Runs the production service store and
// account provisioner without loading environment files or opening a database.
const assert = require("node:assert/strict");
const { TABLES, createSvcStore } = require("../../lib/svcStore.cjs");
const { createSvcCommission } = require("../../lib/svcCommission.cjs");
const { createSvcWorkbench } = require("../../lib/svcWorkbench.cjs");

function svcAccountsSqlFixture() {
  const names = [...Object.values(TABLES).map(([name]) => name), "svc_runtime_lock", "svc_staff_tag", "lxm_orders", "lxm_order_products", "photo_profile", "lxm_staff", "lxm_auth_users", "lxm_auth_roles", "lxm_auth_menus", "lxm_auth_role_menus"];
  let tables = Object.fromEntries(names.map(name => [name, []])), failAt, tail = Promise.resolve();
  const statements = [];
  tables.svc_runtime_lock.push({ id: 1 });
  tables.benefit_rule.push({ id: "1", ver: 1, beneficiary_type: "service", party_id: null, rule_mode: "global", rate_photo_bp: 500, rate_video_bp: 1000, rate_combo_bp: 800, rate_peripheral_bp: 1500, eff_at: "2026-01-01 00:00:00", reason: "TEST_ONLY", operator: "qa", created_at: "2026-01-01 00:00:00" });
  const conn = { async query(statement, params = []) {
    const sql = String(statement).replace(/\s+/g, " ").trim();
    statements.push({ sql, params: structuredClone(params) });
    if (failAt && sql.includes(failAt)) throw Object.assign(new Error("injected SQL failure"), { code: "QA_SQL_FAILURE" });
    const table = sql.match(/(?:FROM|INTO|UPDATE)\s+`?(\w+)`?/i)?.[1];
    assert.ok(tables[table], "unsupported TEST_ONLY table: " + table);
    if (/^SELECT/i.test(sql)) {
      let rows = structuredClone(tables[table]);
      if (table === "lxm_auth_roles" && /WHERE role_key\s*=\s*(?:'service'|\?)/i.test(sql)) rows = rows.filter(row => row.role_key === "service");
      if (table === "lxm_auth_menus") {
        if (/menu_key\s*=\s*\?/i.test(sql)) rows = rows.filter(row => row.menu_key === params[0]);
        else if (/menu_key\s*=\s*'([^']+)'/i.test(sql)) rows = rows.filter(row => row.menu_key === sql.match(/menu_key\s*=\s*'([^']+)'/i)[1]);
        else if (/menu_key IN \(/i.test(sql)) rows = rows.filter(row => params.includes(row.menu_key));
      }
      if (table === "lxm_auth_users" && /WHERE account\s*=\s*\?/i.test(sql)) rows = rows.filter(row => String(row.account).toLowerCase() === String(params[0]).toLowerCase() || /OR/i.test(sql) && row.subject_type === "staff" && row.subject_id === params.at(-1));
      else if (table === "lxm_auth_users" && /WHERE id IN \(/i.test(sql)) rows = rows.filter(row => params.includes(row.id));
      const projection = sql.match(/^SELECT (.*?) FROM /i)[1];
      if (!projection.includes("*")) {
        const fields = projection.split(",").map(field => field.trim().replace(/`/g, ""));
        rows = rows.map(row => Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
      }
      return [rows];
    }
    if (/^INSERT/i.test(sql)) {
      const match = sql.match(/\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)/i);
      assert.ok(match, "unsupported TEST_ONLY insert: " + sql);
      const fields = match[1].replace(/`/g, "").split(",").map(field => field.trim());
      const tokens = match[2].match(/'(?:[^']|'')*'|\?|NULL|-?\d+/gi), values = params.slice();
      const row = Object.fromEntries(fields.map((field, index) => [field, tokens[index] === "?" ? values.shift() : tokens[index] === "NULL" ? null : tokens[index].startsWith("'") ? tokens[index].slice(1, -1) : Number(tokens[index])]));
      const existing = tables[table].find(old => table === "lxm_auth_users" ? String(old.account).toLowerCase() === String(row.account).toLowerCase() || old.id === row.id
        : table === "lxm_auth_role_menus" ? old.role_id === row.role_id && old.menu_key === row.menu_key
        : table === "lxm_auth_roles" ? old.id === row.id || old.role_key === row.role_key
        : table === "lxm_auth_menus" ? old.id === row.id || old.menu_key === row.menu_key : row.id !== undefined && String(old.id) === String(row.id));
      if (existing) {
        if (/INSERT IGNORE/i.test(sql)) return [{ affectedRows: 0 }];
        throw Object.assign(new Error("duplicate TEST_ONLY record"), { code: "ER_DUP_ENTRY" });
      }
      tables[table].push(row); return [{ affectedRows: 1, insertId: row.id }];
    }
    if (/^DELETE FROM svc_staff_tag/i.test(sql)) { tables.svc_staff_tag = tables.svc_staff_tag.filter(row => row.staff_id !== params[0]); return [{ affectedRows: 1 }]; }
    if (/^UPDATE/i.test(sql)) {
      const fields = sql.match(/SET (.*?) WHERE/i)[1].split(",").map(field => field.match(/`(\w+)`=/)[1]);
      const pk = sql.match(/WHERE `(\w+)`=/)[1], row = tables[table].find(old => String(old[pk]) === String(params.at(-1)));
      assert.ok(row); fields.forEach((field, index) => { row[field] = params[index]; }); return [{ affectedRows: 1 }];
    }
    throw Error("unsupported TEST_ONLY statement: " + sql);
  } };
  const source = { async transaction(work) {
    const prior = tail; let release; tail = new Promise(resolve => { release = resolve; }); await prior;
    const before = structuredClone(tables);
    try { return await work(conn); } catch (error) { tables = before; throw error; } finally { release(); }
  } };
  const store = createSvcStore(source), clock = () => "2026-11-13 12:00:00";
  return { source, store, commission: createSvcCommission({ store, clock }), workbench: createSvcWorkbench({ store, clock }), tables: () => tables, fail: value => { failAt = value; }, statements };
}

module.exports = { svcAccountsSqlFixture };
