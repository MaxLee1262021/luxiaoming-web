"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const schema = require("../lib/mysqlSchema.cjs");
const createSource = require("../lib/mysqlSource.cjs");
const rpc = require("../lib/rpc.cjs");
const { createTestWechatPay } = require("./helpers/wechatPay.cjs");

const fields = ["requested_time", "schedule_time", "done_at"];
const legacyTime = { path: "schedule_time", ordinal: 0, value_type: "string", value_text: "2026-11-14T01:36:00.000Z", value_number: null, value_bool: null, value_time: null };

test("SQL date columns survive repeated document writes without becoming ISO extension leaves", () => {
  let order = { id: "date-roundtrip", requested_time: new Date("2026-11-14T01:30:00Z"),
    schedule_time: new Date("2026-11-14T01:36:00Z"), done_at: null, depositPaidAt: "2026-11-14T00:00:00.000Z" };
  for (let write = 0; write < 3; write++) {
    const split = schema.splitDocument("orders", order);
    assert.equal(split.columns.requested_time, "2026-11-14 09:30:00");
    assert.equal(split.columns.schedule_time, "2026-11-14 09:36:00");
    assert.equal(split.columns.done_at, null);
    assert.equal(split.columns.depositPaidAt, "2026-11-14T00:00:00.000Z", "VARCHAR timestamps retain their original timezone");
    assert.equal(split.attributes.some(attribute => fields.includes(attribute.path)), false);
    order = schema.hydrateDocument("orders", { id: order.id, ...split.columns }, { collection_values: split.attributes });
    order.done_at = null;
  }
});

test("old ISO datetime leaves normalize on read and move back to the existing SQL column", () => {
  const order = schema.hydrateDocument("orders", { id: "old-date", schedule_time: new Date("2026-11-14T01:36:00Z") }, { collection_values: [legacyTime] });
  assert.equal(order.schedule_time, "2026-11-14 09:36:00");
  const split = schema.splitDocument("orders", order);
  assert.equal(split.columns.schedule_time, "2026-11-14 09:36:00");
  assert.equal(split.attributes.some(attribute => attribute.path === "schedule_time"), false);
});

test("datetime instants, offsets, civil times and clearing preserve their intended Beijing time", () => {
  for (const [input, expected] of [
    ["2026-11-14T01:36:00.123Z", "2026-11-14 09:36:00"],
    ["2026-11-14T09:36:00+08:00", "2026-11-14 09:36:00"],
    ["2026-11-13T17:36:00-08:00", "2026-11-14 09:36:00"],
    ["2026-11-14 09:36:00", "2026-11-14 09:36:00"],
    ["2026-11-14T09:36", "2026-11-14 09:36:00"],
    ["2026-11-14", "2026-11-14 00:00:00"], ["", null], [null, null],
  ]) assert.equal(schema.splitDocument("orders", { id: "date-formats", schedule_time: input }).columns.schedule_time, expected);
  for (const value of ["invalid", "2026-02-30 09:00:00", "2026-11-14 25:00:00", new Date(NaN)]) {
    assert.throws(() => schema.splitDocument("orders", { id: "invalid-date", schedule_time: value }), { code: "DATA_DATETIME_INVALID" });
  }
});

test("datetime serialization has the same result on UTC and Shanghai hosts", () => {
  const script = "const s=require('./server/lib/mysqlSchema.cjs');process.stdout.write(s.splitDocument('orders',{id:'tz',schedule_time:new Date('2026-11-14T01:36:00Z')}).columns.schedule_time);";
  for (const TZ of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
    const result = spawnSync(process.execPath, ["-e", script], { cwd: require("node:path").resolve(__dirname, "../.."), env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2026-11-14 09:36:00", TZ);
  }
});

function paymentFixture() {
  let main = { id: "date-payment", orderNo: "SYNTHETIC-DATE-PAYMENT", openid: "synthetic-owner", status: "final_pending", workflowStage: "awaiting_final_payment",
    totalAmount: "0.30", depositDue: "0.09", depositPaid: "0.09", depositFinanceStatus: "confirmed", finalDue: "0.21", finalPaid: "0.00",
    schedule_time: new Date("2026-11-14T01:36:00Z") };
  let attributes = [legacyTime, { path: "shootingCompletedAt", ordinal: 0, value_type: "string", value_text: "2026-11-14T01:37:00Z" }];
  let relations = {};
  let snapshot;
  const writes = [];
  const tables = new Map(schema.ALL_KEYS.map(key => [schema.tableName(key), schema.definition(key).columns.map(column => column.name)]));
  const relationByTable = new Map(Object.entries(schema.RELATIONS).map(([name, definition]) => [definition.table, name]));
  async function query(sql, params = []) {
    if (sql.includes("information_schema.columns")) return [params.flatMap(table => (tables.get(table) || []).map(column => ({ TABLE_NAME: table, COLUMN_NAME: column })))];
    if (/^SELECT \* FROM `lxm_orders`/.test(sql)) return [[structuredClone(main)]];
    const selectedTable = sql.match(/^SELECT .+? FROM `([^`]+)`/)?.[1];
    if (selectedTable === schema.COLLECTION_VALUES_TABLE) return [structuredClone(attributes)];
    if (selectedTable) return [structuredClone(relations[relationByTable.get(selectedTable)] || [])];
    const inserted = sql.match(/^INSERT INTO `([^`]+)` \(([^)]+)\)/);
    if (inserted) {
      const row = Object.fromEntries(inserted[2].split(",").map((name, index) => [name.replace(/`/g, ""), structuredClone(params[index])]));
      if (inserted[1] === "lxm_orders") {
        for (const field of fields) if (row[field] != null && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(row[field]))) {
          throw Object.assign(new Error("Invalid SQL datetime"), { code: "ER_TRUNCATED_WRONG_VALUE" });
        }
        writes.push(row);
        main = { ...main, ...row };
      } else if (inserted[1] === schema.COLLECTION_VALUES_TABLE) attributes.push(row);
      else (relations[relationByTable.get(inserted[1])] ||= []).push(row);
      return [{ affectedRows: 1 }];
    }
    const deletedTable = sql.match(/^DELETE FROM `([^`]+)`/)?.[1];
    if (deletedTable) {
      if (deletedTable === schema.COLLECTION_VALUES_TABLE) attributes = [];
      else relations[relationByTable.get(deletedTable)] = [];
      return [{ affectedRows: 1 }];
    }
    throw new Error("Unexpected synthetic SQL");
  }
  const connection = { query,
    async beginTransaction() { snapshot = structuredClone({ main, attributes, relations }); },
    async commit() {}, async rollback() { ({ main, attributes, relations } = snapshot); }, release() {} };
  const source = createSource({ pool: { query, async getConnection() { return connection; } }, autoMigrate: false, logger: { warn() {}, error() {} } });
  const paymentSource = { ...source, async list(key) { return key === "orders" ? source.list(key) : []; },
    async create(key, document) { assert.equal(key, "logs"); return document; } };
  return { source, paymentSource, writes, attributes: () => attributes };
}

test("final payment persists its prepay parameters and remains reusable when the order has a legacy date leaf", async () => {
  const f = paymentFixture();
  const ctx = { identity: { kind: "public", openid: "synthetic-owner" }, wechatPay: createTestWechatPay() };
  const request = { data: { orderId: "date-payment", phase: "final", selectionAccepted: true, idempotencyKey: "date-payment-original-request" } };
  const result = await rpc(f.paymentSource, "createPayment", request, ctx);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.invokeWeChatPay, true);
  assert.match(result.data.paymentParams.package, /^prepay_id=/);
  const saved = await f.source.get("orders", "date-payment");
  assert.equal(saved.schedule_time, "2026-11-14 09:36:00");
  assert.equal(saved.paymentRecords.length, 1);
  assert.equal(saved.paymentRecords[0].status, "pending");
  assert.ok(saved.paymentRecords[0].prepayId);
  assert.equal(f.writes.length, 2, "the intent and returned prepay parameters both commit");
  assert.equal(f.attributes().some(attribute => attribute.path === "schedule_time"), false);
  const repeated = await rpc(f.paymentSource, "createPayment", request, ctx);
  assert.equal(repeated.success, true);
  assert.equal(repeated.data.idempotent, true);
  assert.equal((await f.source.get("orders", "date-payment")).paymentRecords.length, 1);
});
