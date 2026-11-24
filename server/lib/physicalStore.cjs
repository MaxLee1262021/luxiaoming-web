"use strict";

// Dedicated commerce tables keep transaction facts out of the already-wide
// legacy order table. One database lock serializes cross-SKU checkout writes;
// this deliberately favors correctness over throughput for the initial shop.
const { isDeepStrictEqual } = require("util");
const ENTITIES = ["config", "addresses", "carts", "inventory", "orders", "payments", "afterSales", "refunds", "shipments", "tasks", "audit"];
const TABLES = Object.fromEntries(ENTITIES.map(name => [name, `lxm_physical_${name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`]));
const clone = value => JSON.parse(JSON.stringify(value));
const blank = () => Object.fromEntries(ENTITIES.map(name => [name, []]));
const READ_IN_GROUP_SIZE = 500;
const READ_PARAMETER_LIMIT = 5000;
const READ_SQL_BUDGET = 512 * 1024;
function readScope(spec = {}, state) {
  const scopes = [];
  for (const [option, field] of [["id", "id"], ["owner", "openid"], ["orderId", "orderId"]]) {
    if (Object.hasOwn(spec, option)) scopes.push({ fields: [field], values: [spec[option]] });
  }
  if (Object.hasOwn(spec, "identity")) scopes.push({ fields: ["id", "orderNo"], values: [spec.identity] });
  if (spec.orderIdsFrom) {
    if (!Object.hasOwn(state, spec.orderIdsFrom)) throw new Error("Unknown physical read dependency");
    scopes.push({ fields: ["orderId"], values: [...new Set(state[spec.orderIdsFrom].map(row => row.id))] });
  }
  if (spec.idsFrom) {
    if (!Object.hasOwn(state, spec.idsFrom.table)) throw new Error("Unknown physical read dependency");
    scopes.push({ fields: ["id"], values: [...new Set(state[spec.idsFrom.table].map(row => row[spec.idsFrom.field]).filter(value => value != null))] });
  }
  return scopes.map(scope => ({ ...scope, valuesSet: new Set(scope.values) }));
}
function matchesReadScope(row, scopes) {
  return scopes.every(scope => scope.fields.some(field => scope.valuesSet.has(row[field])));
}
function readEntries(selection) {
  return Object.entries(selection || {}).map(([name, spec]) => {
    if (!ENTITIES.includes(name)) throw new Error("Unknown physical read table");
    return [name, spec || {}];
  });
}
async function readMysqlRows(conn, name, scopes) {
  if (scopes.some(scope => !scope.values.length)) return [];
  // The JSON body is authoritative. Older rows may have stale owner/order
  // projection columns, so those columns must not narrow access incorrectly.
  // Group IN terms in ONE query: issuing one query per 500 IDs would scan a
  // JSON-filtered table repeatedly. Oversized predicates use one broad read
  // and the same strict scope filter, preserving legacy correctness/order.
  const parameterCount = scopes.reduce((total, scope) => total + scope.fields.length * scope.values.length, 0);
  const values = [];
  const baseSql = `SELECT body FROM \`${TABLES[name]}\``;
  let sql = baseSql;
  if (parameterCount <= READ_PARAMETER_LIMIT) {
    const where = scopes.map(scope => "(" + scope.fields.map(field => {
      const groups = [];
      for (let offset = 0; offset < scope.values.length; offset += READ_IN_GROUP_SIZE) {
        const batch = scope.values.slice(offset, offset + READ_IN_GROUP_SIZE);
        values.push(...batch.map(String));
        groups.push(`CAST(JSON_UNQUOTE(JSON_EXTRACT(body,'$.${field}')) AS BINARY) IN (${batch.map(() => "CAST(? AS BINARY)").join(",")})`);
      }
      return "(" + groups.join(" OR ") + ")";
    }).join(" OR ") + ")").join(" AND ");
    const scopedSql = baseSql + (where ? " WHERE " + where : "");
    const wireBudget = Buffer.byteLength(scopedSql) + values.reduce((total, value) => total + 2 * Buffer.byteLength(value) + 3, 0);
    if (wireBudget <= READ_SQL_BUDGET) sql = scopedSql;
    else values.length = 0;
  }
  const [rows] = await conn.query(sql, values);
  const selected = [];
  for (const row of rows) {
    const body = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
    if (matchesReadScope(body, scopes)) selected.push(body);
  }
  return selected;
}
async function assertCommerceSchema(conn, lock) {
  const [rows] = await conn.query("SELECT version FROM lxm_physical_mutex WHERE id='commerce'" + (lock ? " FOR UPDATE" : ""));
  if (!rows.length) throw Object.assign(new Error("请先执行实物交易迁移"), { code: "PHYSICAL_SCHEMA_MISSING", statusCode: 503 });
}
function statements() {
  return [
    "CREATE TABLE IF NOT EXISTS lxm_physical_mutex (id VARCHAR(32) CHARACTER SET ascii NOT NULL PRIMARY KEY, version BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB",
    "INSERT IGNORE INTO lxm_physical_mutex (id,version) VALUES ('commerce',0)",
    ...ENTITIES.map(name => `CREATE TABLE IF NOT EXISTS \`${TABLES[name]}\` (id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL, owner_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL DEFAULT '', order_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL DEFAULT '', lookup_key VARCHAR(160) COLLATE utf8mb4_bin NULL, status VARCHAR(48) NOT NULL DEFAULT '', version BIGINT NOT NULL DEFAULT 1, body JSON NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(id), UNIQUE KEY uq_lookup(lookup_key), KEY idx_owner(owner_id), KEY idx_order(order_id), KEY idx_status(status,updated_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`)
  ];
}
function rowIndex(name, row) {
  let lookup = null;
  if (name === "orders") lookup = row.orderNo;
  if (name === "payments") lookup = row.outTradeNo;
  if (name === "refunds") lookup = row.refundNo;
  if (name === "inventory") lookup = row.skuId;
  return [row.id, row.openid || "", row.orderId || "", lookup || null, row.status || "", Number(row.version || 1), JSON.stringify(row)];
}
function createMysqlStore(source) {
  if (!source || typeof source.transaction !== "function") throw Object.assign(new Error("实物交易需要已迁移的 MySQL 数据源"), { code: "PHYSICAL_STORE_UNAVAILABLE", statusCode: 503 });
  return {
    backend: "mysql",
    async read(callback, selection) {
      const entries = readEntries(selection);
      return source.transaction(async conn => {
        await assertCommerceSchema(conn, false);
        const state = blank();
        for (const [name, spec] of entries) state[name] = await readMysqlRows(conn, name, readScope(spec, state));
        // The schema guard is nonlocking; no whole-state clone, diff or writes.
        const result = await callback(state);
        return clone(result === undefined ? null : result);
      });
    },
    async transaction(callback) {
      return source.transaction(async conn => {
        await assertCommerceSchema(conn, true);
        const state = blank();
        for (const name of ENTITIES) {
          const [rows] = await conn.query(`SELECT body FROM \`${TABLES[name]}\``);
          state[name] = rows.map(row => typeof row.body === "string" ? JSON.parse(row.body) : row.body);
        }
        const before = clone(state);
        const result = await callback(state);
        for (const name of ENTITIES) {
          const oldRows = new Map(before[name].map(row => [row.id, row]));
          const newIds = new Set(state[name].map(row => row.id));
          for (const old of before[name]) if (!newIds.has(old.id)) await conn.query(`DELETE FROM \`${TABLES[name]}\` WHERE id=?`, [old.id]);
          for (const row of state[name]) if (!isDeepStrictEqual(oldRows.get(row.id), row)) {
            await conn.query(`INSERT INTO \`${TABLES[name]}\` (id,owner_id,order_id,lookup_key,status,version,body) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE owner_id=VALUES(owner_id),order_id=VALUES(order_id),lookup_key=VALUES(lookup_key),status=VALUES(status),version=VALUES(version),body=VALUES(body),updated_at=CURRENT_TIMESTAMP(3)`, rowIndex(name, row));
          }
        }
        return clone(result === undefined ? null : result);
      });
    }
  };
}
function createMemoryStore(initial = {}) {
  let state = { ...blank(), ...clone(initial) }, tail = Promise.resolve();
  return {
    backend: "isolated_test_memory",
    async read(callback, selection) {
      await tail;
      const snapshot = state, selected = blank();
      for (const [name, spec] of readEntries(selection)) {
        const scopes = readScope(spec, selected);
        selected[name] = clone(snapshot[name].filter(row => matchesReadScope(row, scopes)));
      }
      const result = await callback(selected);
      return clone(result === undefined ? null : result);
    },
    async transaction(callback) {
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try { const draft = clone(state); const result = await callback(draft); state = draft; return clone(result === undefined ? null : result); }
      finally { release(); }
    },
    snapshot: () => clone(state)
  };
}
module.exports = { ENTITIES, TABLES, statements, createMysqlStore, createMemoryStore };
