"use strict";
const assert = require("node:assert/strict");
const { createShareStore } = require("../../lib/shareStore.cjs");

function fixture() {
  let tables = {}; const sequences = {}; const statements = []; let tail = Promise.resolve();
  let fail = null;
  const unique = {
    merchant: [["id"], ["name"]], user_lock: [["user_id"]], order_lock: [["order_id"]], correction_quota: [["period"]],
    correction: [["id"], ["request_key"], ["order_id", "revision_no"]], rule: [["merchant_id", "version_no"]],
    schedule: [["task_name"]], schedule_run: [["id"], ["lease_token"]], metric: [["slot_at"]], risk: [["entity_type", "entity_id", "risk_code"]],
    pending_cursor: [["cursor_name"]], user_event: [["id"], ["user_id", "request_key"]],
    qr: [["id"], ["scene"], ["merchant_id", "active_flag"], ["merchant_id", "qr_seq"], ["merchant_id", "rotate_request_key"]],
    scan: [["id"], ["request_key"]], binding: [["user_id", "merchant_id"]],
    click: [["id"], ["request_key"]], cs_link: [["link_id"], ["operator_id", "request_key"]], job: [["order_id"]], snapshot: [["id"], ["order_id"]],
    detail: [["id"], ["detail_no"], ["entry_key"], ["snapshot_id", "refund_no"]], refund: [["refund_no"]], outbox: [["id"], ["event_key"]],
  };
  const source = { transaction: async work => {
    let release; const prior = tail; tail = new Promise(resolve => { release = resolve; }); await prior;
    const backup = structuredClone(tables);
    try { return await work(conn); } catch (error) { tables = backup; throw error; } finally { release(); }
  } };
  function wherePredicate(text, values, cursor) {
    if (!text) return () => true;
    let expression = text.trim();
    if (expression.startsWith("(")) {
      let depth = 0; let closes = -1;
      for (let i = 0; i < expression.length; i++) { if (expression[i] === "(") depth++; if (expression[i] === ")" && --depth === 0) { closes = i; break; } }
      if (closes === expression.length - 1) return wherePredicate(expression.slice(1, -1), values, cursor);
    }
    for (const operator of ["OR", "AND"]) {
      let depth = 0; let quoted = false; let start = 0; const parts = [];
      for (let i = 0; i < expression.length; i++) {
        if (expression[i] === "'") quoted = !quoted;
        if (quoted) continue;
        if (expression[i] === "(") depth++;
        if (expression[i] === ")") depth--;
        const marker = " " + operator + " ";
        if (!depth && expression.slice(i, i + marker.length).toUpperCase() === marker) { parts.push(expression.slice(start, i)); start = i + marker.length; i = start - 1; }
      }
      if (parts.length) {
        parts.push(expression.slice(start)); const checks = parts.map(part => wherePredicate(part, values, cursor));
        return row => operator === "OR" ? checks.some(check => check(row)) : checks.every(check => check(row));
      }
    }
    const tuple = expression.match(/^\((\w+),(\w+)\)>\(\?,\?\)$/);
    if (tuple) { const first = values[cursor.index++], second = values[cursor.index++]; return row => row[tuple[1]] > first || row[tuple[1]] === first && row[tuple[2]] > second; }
    const match = expression.match(/^`?(\w+)`?\s*(=|<>|<=|>=|>|<)\s*(\?|'[^']*'|NULL|\d+)$/i);
    assert.ok(match, `test SQL condition not implemented: ${expression}`);
    const expected = match[3] === "?" ? values[cursor.index++] : match[3] === "NULL" ? null : /^\d+$/.test(match[3]) ? Number(match[3]) : match[3].slice(1, -1);
    return row => match[2] === "=" ? String(row[match[1]]) === String(expected) : match[2] === "<>" ? String(row[match[1]]) !== String(expected)
      : match[2] === "<=" ? row[match[1]] <= expected : match[2] === ">=" ? row[match[1]] >= expected : match[2] === ">" ? row[match[1]] > expected : row[match[1]] < expected;
  }
  const conn = { query: async (sql, values = []) => {
    statements.push({ sql, values: structuredClone(values) });
    if (fail && sql.includes(fail.match)) { const error = Object.assign(new Error("injected storage failure"), { code: "ER_TEST_FAILURE" }); if (--fail.count <= 0) fail = null; throw error; }
    const tableMatch = sql.match(/(?:INTO|FROM|UPDATE|EXISTS)\s+`?lxm_share_(\w+)`?/i);
    if (!tableMatch) throw new Error("unexpected SQL: " + sql);
    const table = tableMatch[1]; tables[table] ||= [];
    if (/^CREATE TABLE/i.test(sql)) return [{ affectedRows: 0 }];
    if (/^INSERT/i.test(sql)) {
      const match = sql.match(/\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)/i);
      const columns = match[1].replace(/`/g, "").split(",").map(value => value.trim());
      const row = Object.fromEntries(columns.map((key, i) => [key, values[i]]));
      if (!row.id && !["binding", "user_lock", "order_lock", "correction_quota", "cs_link", "job", "refund", "schedule", "metric", "risk", "pending_cursor"].includes(table)) row.id = String(sequences[table] = (sequences[table] || 0) + 1);
      const duplicate = (unique[table] || [["id"]]).some(keys => keys.every(key => row[key] != null)
        && tables[table].some(existing => keys.every(key => String(existing[key]) === String(row[key]))));
      if (duplicate) {
        if (/^INSERT IGNORE/i.test(sql)) return [{ affectedRows: 0, insertId: 0 }];
        if (/ON DUPLICATE KEY UPDATE/i.test(sql)) {
          const current = tables[table].find(existing => (unique[table] || [["id"]]).some(keys => keys.every(key => row[key] != null && String(existing[key]) === String(row[key]))));
          const assignments = sql.split(/ON DUPLICATE KEY UPDATE/i)[1].trim().split(",");
          for (const assignment of assignments) {
            const set = assignment.trim().match(/^`?(\w+)`?=VALUES\(`?(\w+)`?\)$/i);
            assert.ok(set, "fixture supports explicit VALUES upserts"); current[set[1]] = row[set[2]];
          }
          return [{ affectedRows: 0, insertId: current.id || 0 }];
        }
        throw Object.assign(new Error("duplicate fixture row"), { code: "ER_DUP_ENTRY", errno: 1062 });
      }
      tables[table].push(row); return [{ affectedRows: 1, insertId: row.id || 0 }];
    }
    if (/^SELECT/i.test(sql)) {
      const cursor = { index: 0 }; const where = (sql.match(/\bWHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|\s+FOR UPDATE|$)/i) || [])[1];
      let result = tables[table].filter(wherePredicate(where, values, cursor)).map(row => ({ ...row }));
      const order = (sql.match(/\bORDER BY\s+(.+?)(?:\s+LIMIT|\s+FOR UPDATE|$)/i) || [])[1];
      if (order) result.sort((a, b) => {
        for (const term of order.split(",")) {
          const [column, direction] = term.trim().split(/\s+/); const av = a[column]; const bv = b[column];
          const diff = /^\d+$/.test(String(av)) && /^\d+$/.test(String(bv)) ? Number(BigInt(av) - BigInt(bv)) : String(av).localeCompare(String(bv));
          if (diff) return direction && direction.toUpperCase() === "DESC" ? -diff : diff;
        }
        return 0;
      });
      const limit = (sql.match(/\bLIMIT\s+(\?|\d+)/i) || [])[1];
      if (limit) result = result.slice(0, limit === "?" ? values[cursor.index++] : Number(limit));
      for (const column of [...sql.matchAll(/DATE_FORMAT\(`(\w+)`/g)].map(match => match[1])) for (const row of result) {
        if (row[column] != null) row[column] = String(row[column]).replace(" ", "T") + "Z";
      }
      return [result];
    }
    if (/^UPDATE/i.test(sql)) {
      const cursor = { index: 0 }; const set = sql.match(/\bSET\s+(.+?)\s+WHERE/i)[1];
      const patch = {};
      for (const expression of set.split(",")) {
        const match = expression.trim().match(/^`?(\w+)`?=(\?|'[^']*'|NULL)$/);
        assert.ok(match, `test SQL update not implemented: ${expression}`);
        patch[match[1]] = match[2] === "?" ? values[cursor.index++] : match[2] === "NULL" ? null : match[2].slice(1, -1);
      }
      const predicate = wherePredicate(sql.match(/\bWHERE\s+(.+)$/i)[1], values, cursor); let count = 0;
      for (const row of tables[table]) if (predicate(row)) { Object.assign(row, patch); count++; }
      return [{ affectedRows: count }];
    }
    throw new Error("unimplemented fixture SQL: " + sql);
  } };
  let clock = "2026-11-01T00:00:00Z";
  const newStore = (options = {}) => createShareStore(source, { clock: () => clock, enableAt: "2026-11-01T00:00:00Z", ...options });
  return { source, newStore, setTime: value => { clock = value; }, tables: () => tables, statements,
    injectFailure: (match, count = 1) => { fail = { match, count }; } };
}
function merchant(id = "m1", overrides = {}) {
  return { merchantId: id, name: "门店" + id, status: "OPEN", ratioT1: "0.0500", ratioT2: "0.0300", ttlHours: 720, refundWindowDays: 3,
    reason: "首期合同", operatorId: "operator", cooperationConfirmed: true,
    qr: { id: "qr-" + id, scene: "c=" + id, imageUrl: "data:image/png;base64,iVBORw0KGgo=" }, ...overrides };
}

module.exports = { fixture, merchant };
