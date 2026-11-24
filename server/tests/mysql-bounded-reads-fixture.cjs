"use strict";

const assert = require("node:assert/strict");
const schema = require("../lib/mysqlSchema.cjs");
const createSource = require("../lib/mysqlSource.cjs");

// SQL fixture with explicit case/accent/trailing-space equivalence. It checks
// request ordinals, not the SQL engine's result order, and never performs writes.
function fixture(documents = {}, options = {}) {
  const normalize = value => String(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ +$/, "");
  const physical = new Map();
  const columns = new Map(schema.ALL_KEYS.map(key => [schema.tableName(key), schema.definition(key).columns.map(column => column.name)]));
  const legacy = new Set(options.legacy || []);
  for (const [key, docs] of Object.entries(documents)) {
    physical.set(key, docs.map(document => {
      const split = schema.splitDocument(key, document);
      return { row: { id: String(document.id), ...split.columns }, identity: normalize(document.id), split, doc: JSON.stringify(document) };
    }));
    if (legacy.has(key)) columns.set(schema.tableName(key), ["id", "doc"]);
  }
  for (const key of options.missing || []) columns.delete(schema.tableName(key));
  const stats = { queries: [], active: 0, peak: 0, attributeActive: 0, attributePeak: 0, reads: 0, failRelation: false };
  const equal = (left, right) => {
    return normalize(left) === normalize(right);
  };
  const selected = (records, ids) => {
    const identities = new Set(ids.map(normalize));
    return records.filter(item => identities.has(item.identity));
  };
  const waiting = [];
  let acquired = 0;
  async function acquire() {
    if (!options.poolLimit) return;
    if (acquired < options.poolLimit) { acquired++; return; }
    await new Promise(resolve => waiting.push(resolve));
  }
  function release() {
    if (!options.poolLimit) return;
    if (waiting.length) waiting.shift()();
    else acquired--;
  }
  const pool = {
    async query(sql, params = []) {
      if (options.captureQueries !== false) stats.queries.push({ sql, params: [...params] });
      assert.ok(sql.startsWith("SELECT"), "reads must not issue DDL/DML");
      if (sql.includes("information_schema.columns")) return [params.flatMap(table => (columns.get(String(table)) || []).map(column_name => ({ table_name: table, column_name })))];
      await acquire();
      const attribute = sql.includes("FROM `lxm_collection_values`");
      stats.reads++; stats.active++; stats.peak = Math.max(stats.peak, stats.active);
      if (attribute) { stats.attributeActive++; stats.attributePeak = Math.max(stats.attributePeak, stats.attributeActive); }
      try {
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
        else await new Promise(setImmediate);
        const table = sql.match(/FROM `([^`]+)`/)?.[1];
        const key = schema.ALL_KEYS.find(name => schema.tableName(name) === table);
        if (key) {
          const records = physical.get(key) || [];
          const materialize = item => legacy.has(key) ? { id: item.row.id, doc: item.doc } : { ...item.row };
          if (sql.includes("__read_index")) {
            const branches = [...sql.matchAll(/SELECT (\d+) AS __read_index/g)];
            assert.equal(branches.length, params.length, "every request has one parameterized primary-key predicate");
            return [params.flatMap((id, index) => records.filter(item => equal(item.row.id, id)).map(item => ({ __read_index: Number(branches[index][1]), ...materialize(item) }))).reverse()];
          }
          return [records.filter(item => !sql.includes("WHERE id=?") || equal(item.row.id, params[0])).map(materialize)];
        }
        if (attribute) {
          if (sql.includes("__read_owner")) {
            return [[...sql.matchAll(/SELECT (\d+) AS __read_owner/g)].flatMap((match, index) => selected(physical.get(params[index * 2]) || [], [params[index * 2 + 1]])
              .flatMap(item => item.split.attributes.map(row => ({ ...row, collection_name: params[index * 2], record_id: item.attributeOwner ?? item.row.id, __read_owner: Number(match[1]) }))))];
          }
          const owners = new Map();
          if (sql.includes("WHERE collection_name=?")) owners.set(params[0], params.slice(1));
          else {
            let index = 0;
            for (const match of sql.matchAll(/\(collection_name=\? AND record_id IN \(([^)]+)\)\)/g)) {
              const collection = params[index++], count = match[1].split(",").length;
              if (!owners.has(collection)) owners.set(collection, []);
              owners.get(collection).push(...params.slice(index, index + count)); index += count;
            }
          }
          return [[...owners].flatMap(([collection, ids]) => selected(physical.get(collection) || [], ids)
            .flatMap(item => item.split.attributes.map(row => ({ ...row, collection_name: collection, record_id: item.attributeOwner ?? item.row.id }))))];
        }
        if (stats.failRelation) throw Object.assign(new Error("relation unavailable"), { code: "QA_RELATION_FAILURE" });
        for (const [collection, records] of physical) {
          const relation = (schema.RELATION_BY_KEY[collection] || []).find(name => schema.RELATIONS[name].table === table);
          if (relation) {
            if (sql.includes("__read_owner")) return [[...sql.matchAll(/SELECT (\d+) AS __read_owner/g)].flatMap((match, index) => selected(records, [params[index]]).flatMap(item => (item.split.relations[relation] || []).map(row => ({ ...row, __read_owner: Number(match[1]) }))))];
            return [selected(records, params).flatMap(item => (item.split.relations[relation] || []).map(row => ({ ...row })))];
          }
        }
        return [[]];
      } finally {
        stats.active--;
        if (attribute) stats.attributeActive--;
        options.observe?.(stats);
        release();
      }
    }
  };
  const source = (options.createSource || createSource)({ pool, autoMigrate: false, connectionLimit: options.connectionLimit || 3, relationBatchSize: options.batchSize || 2, logger: { warn() {}, error() {} } });
  return { source, physical, stats };
}

module.exports = { fixture };
