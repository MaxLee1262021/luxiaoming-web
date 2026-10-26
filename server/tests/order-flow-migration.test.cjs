"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { migrationPatch, migrateSource } = require("../lib/orderFlowMigration.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const createSource = require("../lib/dbSource.cjs");
const { spawnSync } = require("node:child_process");

test("migration keeps paid orders with empty assignment records pending confirmation", () => {
  const paid = { id: "empty-dispatch", status: "deposit_paid", totalAmount: 100, depositDue: 30, finalDue: 70, depositPaid: 30, depositFinanceStatus: "confirmed", dispatchRecord: {} };
  const patch = migrationPatch(paid);
  assert.equal(patch.workflowStage, "awaiting_dispatch");
  assert.equal(patch.businessStatus, "reserved");
  assert.equal(patch.customerStatus, "待确认");
});

test("historical migration preserves canceled facts and flags delivered orders without inventing payment", () => {
  assert.deepEqual(migrationPatch({ status: "cancelled", deleted: true }), { orderFlowVersion: "onsite-payment-v2" });
  const patch = migrationPatch({ status: "delivered", totalAmount: 100, depositDue: 30, finalDue: 70, depositPaid: 30, depositFinanceStatus: "confirmed", deliveredAt: "2026-09-10" });
  assert.equal(patch.migrationReviewRequired, true);
  assert.equal(patch.paymentReviewRequired, true);
  assert.notEqual(patch.businessStatus, "completed");
  assert.equal(patch.finalPaid, undefined);
  const paid = migrationPatch({ status: "paid", totalAmount: 100, depositDue: 30, finalDue: 70, finalPaid: 70, finalFinanceStatus: "confirmed", finalPaidAt: "2026-09-10", paymentRecords: [] });
  assert.equal(paid.status, "completed");
  assert.equal(paid.completedAt, "2026-09-10");
});

test("migration dry run is read-only; apply is idempotent and does not overwrite CAS conflicts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-flow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.json");
  fs.writeFileSync(file, JSON.stringify({ collections: { orders: { a: { id: "a", status: "assigned", photographerId: "photo", totalAmount: 100, depositDue: 30, finalDue: 70, depositPaid: 30, depositFinanceStatus: "confirmed" } } } }));
  const source = createSource({ backend: "json", jsonFile: file });
  const before = fs.readFileSync(file, "utf8");
  const dry = await migrateSource(source);
  assert.equal(dry.changed, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const applied = await migrateSource(source, { apply: true });
  assert.equal(applied.conflicts.length, 0);
  assert.equal((await source.get("orders", "a")).businessStatus, "awaiting_shoot");
  assert.equal((await migrateSource(source, { apply: true })).changed, 0);
  await source.update("orders", "a", { paymentRecords: [{ id: "p", status: "pending", omitted: undefined }] });
  const snapshot = await source.get("orders", "a");
  assert.ok(await source.compareAndUpdate("orders", "a", { paymentRecords: snapshot.paymentRecords }, { finalPaymentStatus: "pending" }), "JSON CAS must compare the same serialized values it returns");
  const conflict = await migrateSource({ list: async () => [{ id: "race", status: "shooting" }], compareAndUpdate: async () => null }, { apply: true });
  assert.deepEqual(conflict.conflicts, ["race"]);
});

test("new flow facts, consent, gift items and independent records round-trip in normalized MySQL without widening orders", () => {
  const input = {
    id: "v2", intentDate: "2030-10-14", intentTimePeriod: "上午", depositFrozenAmount: 30, depositFrozenAt: "2026-10-14",
    claimedAt: "2026-10-14", claimedBy: "service-a", assignmentVersion: 2, completionSource: "wechat_pay_final",
    agreement: { version: "notice-123", acceptedAt: "2026-10-14", acceptedBy: "customer" },
    assignmentRecords: [{ from: "a", to: "b", reason: "转交", operatorId: "admin" }],
    deliveryRecords: [{ id: "d", method: "现场交付", deliveredAt: "2026-10-14", fileIds: [], visibility: "customer" }],
    followRecords: [{ id: "f", type: "customer_followup", followupType: "peripheral", content: "寄出相框", ownerId: "b", status: "completed", completedAt: "2026-10-15", createTime: "2026-10-14" }],
    products: [{ id: "p", type: "peripheral", price: 0, quantity: 1, isGift: true, originalPrice: 20 }],
  };
  const split = schema.splitDocument("orders", input);
  for (const key of ["intentDate", "intentTimePeriod", "depositFrozenAmount", "claimedAt", "completionSource"]) assert.equal(split.columns[key], undefined);
  const restored = schema.hydrateDocument("orders", { id: "v2", ...split.columns }, { collection_values: split.attributes, ...split.relations });
  for (const key of ["intentDate", "intentTimePeriod", "depositFrozenAmount", "agreement", "assignmentRecords", "deliveryRecords"]) assert.deepEqual(restored[key], input[key]);
  assert.equal(restored.followRecords[0].status, "completed");
  assert.equal(restored.followRecords[0].content, "寄出相框");
  assert.equal(restored.products[0].isGift, true);
});

test("migration CLI applies and restores an isolated fixture from its automatic backup", (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lxm-flow-cli-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,"orders.json");
  const order={id:"test",_id:"test",status:"deposit_paid",totalAmount:100,depositDue:30,finalDue:70,depositPaid:30,depositFinanceStatus:"confirmed"};
  fs.writeFileSync(file,JSON.stringify({collections:{orders:{test:order}}}));
  const runner=path.join(__dirname,"../../scripts/migrate-order-flow.cjs");
  const invoke=(args)=>{
    const result=spawnSync(process.execPath,[runner,`--json=${file}`,...args],{encoding:"utf8",windowsHide:true});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  const report=invoke(["--apply"]);
  t.after(()=>fs.rmSync(report.backupFile,{force:true}));
  assert.equal(report.changed,1);
  assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).collections.orders.test.businessStatus,"reserved");
  const restored=invoke([`--restore=${report.backupFile}`,"--apply"]);
  assert.equal(restored.restored,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")).collections.orders.test,order);
});
