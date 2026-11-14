"use strict";
// TEST_ONLY typed SQL transaction adapter. It executes the real photo store and
// account provisioner without reading configured database credentials.
const assert = require("node:assert/strict");
const { TABLES } = require("../../lib/photoStore.cjs");
const { createPhotoShareService, DEFAULT_RATES } = require("../../lib/photoShare.cjs");
function photoAccountsSqlFixture() {
  const names = [...Object.values(TABLES).map(([name]) => name), "svc_assign_log", "svc_runtime_lock", "lxm_orders", "lxm_staff", "lxm_agents", "lxm_distributors", "lxm_shops", "lxm_userProfiles", "svc_staff", "lxm_auth_users", "lxm_auth_roles", "lxm_auth_menus", "lxm_auth_role_menus"];
  let tables = Object.fromEntries(names.map(name => [name, []])), failure, tail = Promise.resolve();
  tables.svc_runtime_lock.push({ id: 1 });
  tables.benefit_rule.push({ id: "1", ver: 1, beneficiary_type: "photo", party_id: null, rule_mode: "global", ...DEFAULT_RATES, eff_at: "2026-01-01 00:00:00", reason: "TEST_ONLY", operator: "qa", created_at: "2026-01-01 00:00:00" });
  const statements = [];
  const conn = { async query(sql, params = []) {
    statements.push({ sql, params: structuredClone(params) });
    if (failure && sql.includes(failure)) throw Object.assign(new Error("injected SQL failure"), { code: "QA_SQL_FAILURE" });
    const table = sql.match(/(?:FROM|INTO|UPDATE)\s+`?(\w+)`?/i)?.[1];
    assert.ok(tables[table], "unsupported TEST_ONLY table: " + table);
    if (/^SELECT/.test(sql)) {
      let rows = structuredClone(tables[table]);
      if (/role_key='photo'/.test(sql)) rows = rows.filter(row => row.role_key === "photo");
      if (/menu_key='photoMine'/.test(sql)) rows = rows.filter(row => row.menu_key === "photoMine");
      if (/WHERE account=\?/.test(sql)) rows = rows.filter(row => row.account.toLowerCase() === params[0].toLowerCase() || row.subject_type === "photo" && row.subject_id === params[1]);
      if (/^SELECT phone/.test(sql)) rows = rows.filter(row => row.phone).map(row => ({ phone: row.phone }));
      if (/^SELECT COUNT\(\*\)/.test(sql)) return [[{ count: 0 }]];
      return [rows];
    }
    if (/^INSERT/.test(sql)) {
      const [, columns, values] = sql.match(/\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)/i);
      const fields = columns.replace(/`/g, "").split(",").map(s => s.trim());
      const tokens = values.match(/'(?:[^']|'')*'|\?|NULL|-?\d+/gi), input = params.slice();
      const row = Object.fromEntries(fields.map((field, index) => [field, tokens[index] === "?" ? input.shift() : tokens[index] === "NULL" ? null : tokens[index].startsWith("'") ? tokens[index].slice(1,-1) : Number(tokens[index])]));
      const previous = table === "lxm_auth_role_menus" ? tables[table].find(old => old.role_id === row.role_id && old.menu_key === row.menu_key) : table === "lxm_auth_users" ? tables[table].find(old => old.account.toLowerCase() === row.account.toLowerCase()) : null;
      if (previous) {
        if (/INSERT IGNORE/.test(sql)) return [{ affectedRows: 0 }];
        throw Object.assign(new Error("duplicate TEST_ONLY account"), { code: "ER_DUP_ENTRY" });
      }
      tables[table].push(row); return [{ affectedRows: 1, insertId: row.id }];
    }
    if (/^UPDATE/.test(sql)) {
      const fields = sql.match(/SET (.*?) WHERE/i)[1].split(",").map(s => s.match(/`(\w+)`=/)[1]);
      const pk = sql.match(/WHERE `(\w+)`=/)[1], row = tables[table].find(old => String(old[pk]) === String(params.at(-1)));
      assert.ok(row); fields.forEach((field, index) => { row[field] = params[index]; }); return [{ affectedRows: 1 }];
    }
    throw Error("unsupported TEST_ONLY statement");
  } };
  const source = { async transaction(work) {
    const prior = tail; let release; tail = new Promise(resolve => { release = resolve; }); await prior;
    const before = structuredClone(tables);
    try { return await work(conn); } catch (error) { tables = before; throw error; } finally { release(); }
  } };
  return { source, service: createPhotoShareService({ source, clock: () => "2026-11-13 12:00:00" }), tables: () => tables, fail: value => { failure = value; }, statements };
}
module.exports = { photoAccountsSqlFixture };
