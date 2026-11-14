"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("../lib/photoOrderBridge.cjs");
const base = () => ({ id: "order-1", orderNo: "LM20261110-0008", packageId: "package-1", packageName: "旅拍套餐", totalAmount: "2999.00", photographerId: "PH20260001", status: "assigned", service_status: "new", depositPaidAt: "2026-11-09 10:00:00", appointmentAt: "2026-11-12 15:00:00", openid: "customer-original-openid" });

test("bridge parses monetary source facts without floating point rounding", () => {
  assert.equal(bridge.fen("2999.00"), 299900);
  assert.equal(bridge.fen("0.01"), 1);
  assert.equal(bridge.fen("-12.3"), -1230);
  for (const value of ["1.001", "NaN", "1e3"]) assert.throws(() => bridge.fen(value));
  const row = bridge.normalizePhotoOrder({ ...base(), finalDiscountAmount: "10.01", refundConfirmed: true, refundAmount: "20.02" });
  assert.equal(row.net_amount_fen, 296897);
  assert.equal(row.customer_openid, "customer-original-openid");
});

test("migration default new cannot hide legacy order completion", () => {
  const old = base();
  const row = bridge.normalizePhotoOrder({ ...old, status: "completed", workflowStage: "completed", completedAt: "2026-11-30 23:59:59" }, old);
  assert.equal(row.service_status, "done");
  assert.equal(row.done_at, "2026-11-30 23:59:59");
  assert.equal(row.photo_id, "PH20260001");
});

test("shared workbench terminal facts and cancellations remain authoritative", () => {
  assert.equal(bridge.normalizePhotoOrder({ ...base(), service_status: "done", done_at: "2026-11-10 12:00:00" }).service_status, "done");
  const refunded = bridge.normalizePhotoOrder({ ...base(), status: "completed", service_status: "refunded" });
  assert.equal(refunded.service_status, "refunded");
  const canceled = bridge.normalizePhotoOrder({ ...base(), status: "cancelled" });
  assert.equal(canceled.service_status, "canceled");
  assert.equal(canceled.zero_reason, "stop_shoot");
  assert.equal(bridge.normalizePhotoOrder({ ...base(), service_status: "claimed" }).service_status, "claimed");
});

test("legacy shooting progression updates a stale service projection", () => {
  const old = { ...base(), service_status: "confirmed" };
  const row = bridge.normalizePhotoOrder({ ...old, status: "shooting", shootingStartedAt: "2026-11-12 15:00:00" }, old);
  assert.equal(row.service_status, "shooting");
});

test("completed shooting remains a pending service until a final receipt completes it", () => {
  const old = { ...base(), service_status: "shooting", status: "shooting" };
  const pending = { ...old, status: "final_pending", workflowStage: "awaiting_final_payment", shootingCompletedAt: "2026-11-13 12:00:00" };
  const row = bridge.normalizePhotoOrder(pending, old);
  assert.equal(row.service_status, "final_pending");
  assert.equal(row.done_at, null);
  const paid = bridge.normalizePhotoOrder({ ...pending, finalPaid: 70, finalFinanceStatus: "confirmed", status: "completed",
    workflowStage: "completed", completedAt: "2026-11-13 13:00:00" }, pending);
  assert.equal(paid.service_status, "done");
  assert.equal(paid.done_at, "2026-11-13 13:00:00");
});

test("a final payment cannot move a payment-time rule snapshot to a newer date", () => {
  const row = bridge.normalizePhotoOrder({ ...base(), finalPaidAt: "2026-12-01 10:00:00" });
  assert.equal(row.paid_at, "2026-11-09 10:00:00");
  const records = bridge.normalizePhotoOrder({ ...base(), depositPaidAt: null, paymentRecords: [
    { status: "paid", paidAt: "2026-11-15T12:00:00Z" },
    { status: "confirmed", confirmedAt: "2026-11-09 10:00:00" },
    { status: "pending", paidAt: "2026-01-01 10:00:00" }
  ] });
  assert.equal(records.paid_at, "2026-11-09 10:00:00");
  const missing = bridge.normalizePhotoOrder({ ...base(), depositPaidAt: null, createdAt: "2026-11-01 10:00:00" });
  assert.equal(missing.paid_at, undefined);
});

test("changed legacy or shared photographer field wins over its stale counterpart", () => {
  const old = { ...base(), photo_id: "PH20260001" };
  assert.equal(bridge.normalizePhotoOrder({ ...old, photographerId: "PH20260002" }, old).photo_id, "PH20260002");
  assert.equal(bridge.normalizePhotoOrder({ ...old, photo_id: "PH20260003" }, old).photo_id, "PH20260003");
  assert.equal(bridge.normalizePhotoOrder({ ...old, photographerId: "" }, old).photo_id, "");
  assert.equal(bridge.normalizePhotoOrder({ ...old, photo_id: null }, old).photo_id, "");
});

test("photo bridge uses the existing order transaction and service hook", async () => {
  const writes=[];
  const conn = { transactionIdentity: "existing-order-row-lock",async query(sql,values) {writes.push({sql,values});return [{affectedRows:1}];} }, old = base();
  const current = { ...old, photographerId: "PH20260002", statusLogs: [{ operatorId: "operator-7" }] };
  let captured, validated;
  await bridge.syncPhotoOrderTx(conn, current, old, { service: {
    async validateAssignment(id, context) { validated = { id, conn: context.conn }; },
    async syncOrderTx(receivedConn, order, previous, operator) { captured = { receivedConn, order, previous, operator }; }
  } });
  assert.deepEqual(validated, { id: "PH20260002", conn });
  assert.equal(captured.receivedConn, conn);
  assert.equal(captured.order.photo_id, "PH20260002");
  assert.equal(captured.previous.photo_id, "PH20260001");
  assert.equal(captured.operator, "operator-7");
  const assignment=writes.find(row=>/INSERT INTO svc_assign_log/.test(row.sql));
  assert.deepEqual(assignment.values.slice(0,4),["LM20261110-0008","transfer","PH20260001","PH20260002"]);
  assert.equal(assignment.values[5],"legacy","missing legacy channel is recorded without fabricating confirmation");
  const orderUpdate=writes.find(row=>/^UPDATE lxm_orders/.test(row.sql));
  assert.equal(orderUpdate.values[0],"PH20260002","realtime pending SQL must see the new owner in photo_id");
  assert.equal(orderUpdate.values[1],"confirmed");
});

test("unchanged assignment appends no log; initial assignment records actual confirmation channel",async()=>{
  let writes=[];const conn={async query(sql,values){writes.push({sql,values});return [{affectedRows:1}];}};
  const service={async validateAssignment(){},async syncOrderTx(){}};
  await bridge.syncPhotoOrderTx(conn,base(),base(),{service});assert.equal(writes.filter(row=>/INSERT INTO svc_assign_log/.test(row.sql)).length,0);
  writes=[];
  await bridge.syncPhotoOrderTx(conn,{...base(),confirmationMethod:"微信"},{...base(),photographerId:""},{service});
  const assignment=writes.find(row=>/INSERT INTO svc_assign_log/.test(row.sql));
  assert.equal(assignment.values[1],"assign");assert.equal(assignment.values[2],null);assert.equal(assignment.values[5],"wechat");
});

test("legacy transfer rejects an inactive new owner before any order or accounting write", async () => {
  const old = base(), writes = [];
  for (const facts of [{ depositPaidAt: null }, { status: "completed", completedAt: "2026-11-13 10:00:00" }]) {
    await assert.rejects(bridge.syncPhotoOrderTx({ async query(sql) { writes.push(sql); } }, { ...old, ...facts, photographerId: "PH20260002" }, old, { service: {
      async validateAssignment(id, { conn }) { assert.equal(id, "PH20260002"); assert.ok(conn); throw Object.assign(Error("摄影师已终止"), { code: 4310 }); },
      async syncOrderTx() { throw Error("must not publish ledger"); }
    } }), { code: 4310 });
  }
  assert.deepEqual(writes, []);
});

test("unassignment still reaches the accounting hook to zero the previous owner", async () => {
  const old = { ...base(), photo_id: "PH20260001" };
  let captured;
  const writes=[];
  await bridge.syncPhotoOrderTx({async query(sql,values){writes.push({sql,values});return [{affectedRows:1}];}}, { ...old, photographerId: "" }, old, { service: {
    async syncOrderTx(conn, order, previous) { captured = { order, previous }; }
  } });
  assert.equal(captured.order.photo_id, "");
  assert.equal(captured.previous.photo_id, "PH20260001");
  assert.equal(writes.find(row=>/^UPDATE lxm_orders/.test(row.sql)).values[0],null);
});

test("unassigned and unrelated legacy orders do not touch accounting storage", async () => {
  const broken = { id: "old-order", photographerId: "old-staff-id" };
  await bridge.syncPhotoOrderTx({ query() { throw new Error("must not query"); } }, broken, null, { service: {
    syncOrderTx() { throw new Error("must not call"); }
  } });
  await bridge.syncPhotoOrderTx({}, { id: "no-assignment" }, null);
});

test("separate order categories remain independent and mixed orders are rejected", () => {
  assert.equal(bridge.categoryOf({ productItems: [{ productType: "peripheral", name: "相册" }] }), "peripheral");
  assert.equal(bridge.categoryOf({ productItems: [{ productType: "video_single", name: "短视频" }] }), "video");
  assert.throws(() => bridge.categoryOf({ products: [{ type: "photo" }, { type: "peripheral" }] }), /多个分成类目/);
});
