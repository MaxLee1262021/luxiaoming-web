"use strict";
// Synthetic in-process SQL transport, not a database/network benchmark.
// Run each mode in a fresh process with --expose-gc; the parent compares output.
const crypto = require("node:crypto");
const { createMysqlStore, ENTITIES, TABLES } = require("../../lib/physicalStore.cjs");
const { createService } = require("../../lib/physicalCommerce.cjs");
const count = Number(process.argv[2] || 1000), mode = process.argv[3] || "optimized", ownCount = Number(process.argv[4] || 3);
if (!["legacy", "optimized"].includes(mode) || !Number.isInteger(count) || count < 1 || count > 100000 || !Number.isInteger(ownCount) || ownCount < 1 || ownCount > 100000) throw new Error("Usage: node --expose-gc physicalReadBenchmark.cjs <other-orders:1..100000> <legacy|optimized> [own-orders:1..100000]");
function seed() {
  const data = Object.fromEntries(ENTITIES.map(name => [name, []]));
  const order = (number, openid) => ({ id: `physical-${number}`, orderNo: `NO-${number}`, openid, status: "awaiting_receipt", createdAt: `2026-11-${String(number % 20 + 1).padStart(2, "0")}T00:00:00Z`, goodsAmountFen: 10000, shippingFeeFen: 500, totalAmountFen: 10500, refundedFen: 0, items: [{ id: `item-${number}`, name: "合成相册商品", quantity: 1, priceFen: 10000, amountFen: 10000, description: "合成商品说明。".repeat(40) }], history: Array.from({ length: 4 }, (_, i) => ({ status: `step-${i}`, note: "合成操作记录".repeat(20) })) });
  data.config.push({ id: "settings", afterSaleDays: 7, returnDays: 7 });
  for (let i = 0; i < count + ownCount; i++) {
    const own = i >= count, value = order(i, own ? "current-user" : `other-${i % 100}`);
    data.orders.push(value);
    data.payments.push({ id: `pay-${i}`, orderId: value.id, status: "confirmed", externalTransactionId: `wx-${i}` });
    data.shipments.push({ id: `ship-${i}`, orderId: value.id, kind: "outbound", active: true, events: [{ context: "合成物流记录".repeat(10) }] });
    data.audit.push({ id: `audit-${i}`, orderId: value.id, action: "synthetic", detail: { note: "合成审计记录".repeat(80) } });
    if (i % 5 === 0) data.afterSales.push({ id: `sale-${i}`, orderId: value.id, openid: value.openid, status: "completed", amountFen: 100 });
  }
  // The transport evaluates predicates from these pre-decoded JSON facts so
  // fixture-side scanning does not allocate a second full application copy.
  return Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, rows.map(body => ({ body: JSON.stringify(body), facts: { id: body.id, openid: body.openid, orderId: body.orderId, orderNo: body.orderNo } }))]));
}
const database = seed();
let queries = 0, bodyRows = 0, bodyBytes = 0, heapPeak = 0;
function sample() { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); }
const bodyCondition = /CAST\(JSON_UNQUOTE\(JSON_EXTRACT\(body,'\$\.(\w+)'\)\) AS BINARY\) IN \((CAST\(\? AS BINARY\)(?:,CAST\(\? AS BINARY\))*)\)/g;
function queryRows(sql, values, records) {
  if (!sql.includes(" WHERE ")) return records;
  let offset = 0;
  const groups = sql.split(" WHERE ")[1].split(" AND ").map(group => [...group.matchAll(bodyCondition)].map(match => {
    const length = (match[2].match(/\?/g) || []).length, selected = new Set(values.slice(offset, offset + length)); offset += length;
    return { field: match[1], selected };
  }));
  if (groups.some(group => !group.length) || offset !== values.length) throw new Error("Unsupported fixture SQL");
  return records.filter(record => groups.every(group => group.some(condition => condition.selected.has(String(record.facts[condition.field])))));
}
const source = { async transaction(work) { return work({ async query(sql, values = []) {
  queries++; sample();
  if (sql.startsWith("SELECT version FROM lxm_physical_mutex")) return [[{ version: 0 }]];
  const table = sql.match(/^SELECT body FROM `([^`]+)`/);
  if (!table) throw new Error("Unexpected write/SQL in benchmark: " + sql);
  const key = Object.keys(TABLES).find(name => TABLES[name] === table[1]);
  const rows = queryRows(sql, values, database[key]);
  bodyRows += rows.length; bodyBytes += rows.reduce((total, row) => total + Buffer.byteLength(row.body), 0);
  sample(); return [rows];
} }); } };
const actual = createMysqlStore(source);
const store = mode === "legacy" ? { transaction: callback => actual.transaction(state => { sample(); const result = callback(state); sample(); return result; }) }
  : { read: (callback, selection) => actual.read(state => { sample(); const result = callback(state); sample(); return result; }, selection), transaction: callback => actual.transaction(callback) };
const service = createService({ store, now: () => new Date("2026-11-23T00:00:00Z") });
(async () => {
  global.gc?.(); const before = process.memoryUsage(); heapPeak = before.heapUsed;
  const start = process.hrtime.bigint();
  const result = await service.executePublic("getPhysicalOrders", { pageSize: 20 }, { openid: "current-user" });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6; sample();
  console.log(JSON.stringify({ fixture: "synthetic JSON SQL transport; no real DB or network", mode, historical_other_orders: count, current_user_orders: ownCount, queries, returned_body_rows: bodyRows, returned_body_bytes: bodyBytes, elapsed_ms: +elapsedMs.toFixed(2), heap_before_bytes: before.heapUsed, heap_peak_sampled_bytes: heapPeak, heap_peak_delta_bytes: heapPeak - before.heapUsed, rss_before_bytes: before.rss, rss_after_bytes: process.memoryUsage().rss, process_max_rss_kib: process.resourceUsage().maxRSS, result_count: result.items.length, result_hash: crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex") }));
})().catch(error => { console.error(error); process.exitCode = 1; });
