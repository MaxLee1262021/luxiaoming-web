"use strict";

// This suite is opt-in and uses only an explicitly configured loopback test
// server. It never loads .env or connects to a deployed/business database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const schema = require("../lib/mysqlSchema.cjs");
const createSource = require("../lib/mysqlSource.cjs");
const physical = require("../lib/physicalStore.cjs");
const { createService } = require("../lib/physicalCommerce.cjs");

test("isolated MySQL verifies batch collation, complete hydration and physical read equivalence", {
  skip: process.env.RUN_ISOLATED_QUERY_MYSQL !== "1", timeout: 120000,
}, async t => {
  const mysql = require("mysql2/promise");
  const port = Number(process.env.ISOLATED_QUERY_MYSQL_PORT);
  assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535, "an explicit local test port is required");
  const database = `lxm_query_qa_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  assert.match(database, /^lxm_query_qa_\d{13}_[a-f0-9]{12}$/);
  const config = { host: "127.0.0.1", port, user: "root", password: "", charset: "utf8mb4", timezone: "+08:00" };
  const admin = await mysql.createConnection(config);
  let created = false, pool;
  try {
    assert.equal((await admin.query("SELECT DATABASE() db"))[0][0].db, null);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ ...config, database, connectionLimit: 10 });
    await schema.ensureSchema(pool);
    for (const sql of physical.statements()) await pool.query(sql);
    const queries = [];
    const counted = { async query(sql, params) { queries.push(sql); return pool.query(sql, params); }, async end() {} };
    const source = createSource({ pool: counted, autoMigrate: false, relationBatchSize: 2, logger: { warn() {}, error() {} } });
    await source.ensureSchema();
    async function insertDocument(key, doc) {
      const split = schema.splitDocument(key, doc);
      const row = { ...split.columns, id: doc.id };
      const fields = Object.keys(row);
      await pool.query(`INSERT INTO \`${schema.tableName(key)}\` (${fields.map(mysql.escapeId).join(",")}) VALUES (${fields.map(() => "?").join(",")})`, fields.map(k => row[k]));
      const relations = { ...split.relations, collection_values: split.attributes.map(a => ({ ...a, collection_name: key, record_id: doc.id })) };
      for (const [name, rows] of Object.entries(relations)) for (const relation of rows) {
        const columns = Object.keys(relation);
        await pool.query(`INSERT INTO \`${schema.RELATIONS[name].table}\` (${columns.map(mysql.escapeId).join(",")}) VALUES (${columns.map(() => "?").join(",")})`, columns.map(k => relation[k]));
      }
    }
    const docs = [
      { id: "Order-A", status: "pending", name: "完整关联", products: [{ id: "p1", type: "package", name: "套餐", quantity: 1 }], statusLogs: [{ action: "已支付" }], followRecords: [{ note: "跟进" }], custom: { values: [1, false, "a"] } },
      { id: "café", status: "confirmed", custom: { nested: "accent" } },
      { id: "0", status: "pending", custom: "zero" },
    ];
    for (const doc of docs) await insertDocument("orders", doc);
    await insertDocument("albums", { id: "same", name: "相册", tags: ["night", "city"], photoIds: ["p2", "p1"], custom: "album" });
    await insertDocument("cities", { id: "same", name: "长沙", custom: "city" });
    const ids = ["Order-A", "order-a", "Order-A ", "missing", "cafe", "CAFÉ", "0", "Order-A", "x' OR 1=1 --"];
    const expected = await Promise.all(ids.map(id => source.get("orders", id)));
    queries.length = 0;
    const batched = await source.getMany("orders", ids);
    assert.deepEqual(batched, expected, "actual database collation must match the old single-record read");
    assert.equal(batched[3], null);
    batched[0].custom.values.push("local");
    assert.deepEqual(batched[7].custom.values, [1, false, "a"]);
    const lists = await source.listMany(["orders", "albums", "cities"]);
    for (const key of Object.keys(lists)) assert.deepEqual(lists[key], await source.list(key));
    assert.equal(lists.albums[0].custom, "album");
    assert.equal(lists.cities[0].custom, "city");

    const physicalDocs = {
      config: [{ id: "settings", carrierOptions: [{ code: "sf", name: "顺丰" }] }],
      addresses: [{ id: "a1", openid: "buyer", isDefault: true }, { id: "a2", openid: "BUYER", isDefault: false }],
      orders: [{ id: "o1", orderNo: "PO1", openid: "buyer", status: "awaiting_payment", items: [], amountFen: 1000, createdAt: "2026-11-23T10:00:00.000Z" }, { id: "o2", orderNo: "PO2", openid: "other", status: "completed", items: [], createdAt: "2026-11-23T09:00:00.000Z" }],
      payments: [{ id: "pay1", orderId: "o1", status: "pending", amountFen: 1000 }],
      afterSales: [{ id: "sale1", orderId: "o1", openid: "buyer", status: "awaiting_return", returnShipmentId: "return1" }],
      shipments: [{ id: "return1", orderId: "o1", kind: "return", active: true }],
    };
    for (const [name, rows] of Object.entries(physicalDocs)) for (const row of rows) {
      // Deliberately stale index shadows verify that body truth and case-sensitive
      // ownership are preserved instead of accidentally changing authorization.
      await pool.query(`INSERT INTO \`${physical.TABLES[name]}\` (id,owner_id,order_id,body) VALUES (?,?,?,?)`, [row.id, "stale-shadow", "stale-shadow", JSON.stringify(row)]);
    }
    const physicalSql = [];
    const transactional = { async transaction(work) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await work({ async query(sql, args) { physicalSql.push(sql); return conn.query(sql, args); } });
        await conn.commit();
        return result;
      } catch (error) { await conn.rollback(); throw error; }
      finally { conn.release(); }
    } };
    const store = physical.createMysqlStore(transactional);
    const optimized = createService({ store, now: () => new Date("2026-11-23T10:00:00Z") });
    const legacy = createService({ store: { transaction: store.transaction }, now: () => new Date("2026-11-23T10:00:00Z") });
    for (const [action, input] of [
      ["getShippingAddresses", {}], ["getPhysicalOrders", {}], ["getPhysicalOrderCounts", {}],
      ["getPhysicalOrder", { orderId: "o1" }], ["getPhysicalOrder", { orderNo: "PO1" }], ["getPhysicalAfterSales", {}],
    ]) {
      const expected = await legacy.executePublic(action, input, { openid: "buyer" });
      physicalSql.length = 0;
      const actual = await optimized.executePublic(action, input, { openid: "buyer" });
      assert.deepEqual(actual, expected, action);
      assert.ok(physicalSql.every(sql => /^SELECT/.test(sql) && !/FOR UPDATE/.test(sql)), `${action} must not write or acquire the commerce mutex`);
    }
    for (const input of [{ orderId: "o2" }, { orderId: "O1" }, { orderId: "missing" }]) {
      const [a, b] = await Promise.allSettled([
        optimized.executePublic("getPhysicalOrder", input, { openid: "buyer" }),
        legacy.executePublic("getPhysicalOrder", input, { openid: "buyer" }),
      ]);
      assert.equal(a.status, "rejected");
      assert.equal(a.reason.code, b.reason.code);
      assert.equal(a.reason.message, b.reason.message);
    }
    assert.equal((await optimized.executePublic("getShippingAddresses", {}, { openid: "buyer" })).items.length, 1);
    const manyOrders = Array.from({ length: 601 }, (_, i) => ({ id: `large-${i}`, openid: "large-owner", orderNo: `LARGE${i}`, status: "completed", items: [], createdAt: "2026-11-23T10:00:00Z" }));
    for (const [name, rows] of [
      ["orders", manyOrders],
      ["payments", manyOrders.map(order => ({ id: `payment-${order.id}`, orderId: order.id, status: "confirmed" }))],
    ]) {
      await pool.query(`INSERT INTO \`${physical.TABLES[name]}\` (id,body) VALUES ${rows.map(() => "(?,?)").join(",")}`, rows.flatMap(row => [row.id, JSON.stringify(row)]));
    }
    const largeExpected = await legacy.executePublic("getPhysicalOrders", {}, { openid: "large-owner" });
    physicalSql.length = 0;
    const largeActual = await optimized.executePublic("getPhysicalOrders", {}, { openid: "large-owner" });
    assert.deepEqual(largeActual, largeExpected);
    assert.equal(largeActual.total, 601);
    assert.equal(physicalSql.length, 6, "large ownership uses one scan per required table and the nonlocking schema guard");
    assert.equal(physicalSql.filter(sql => sql.includes("FROM `lxm_physical_payments`")).length, 1);
    assert.ok(physicalSql.some(sql => sql.includes(" OR ")), "actual database executes grouped IN predicates");
    await pool.query("DELETE FROM lxm_physical_mutex WHERE id='commerce'");
    const [missingNew, missingOld] = await Promise.allSettled([
      optimized.executePublic("getShippingAddresses", {}, { openid: "buyer" }),
      legacy.executePublic("getShippingAddresses", {}, { openid: "buyer" }),
    ]);
    assert.equal(missingNew.status, "rejected");
    assert.equal(missingNew.reason.code, "PHYSICAL_SCHEMA_MISSING");
    assert.equal(missingNew.reason.code, missingOld.reason.code);
    t.diagnostic(`Validated actual MySQL ${(await pool.query("SELECT VERSION() version"))[0][0].version}; all data synthetic and isolated.`);
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
