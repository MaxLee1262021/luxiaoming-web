"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { orderRow } = require("../lib/svcStore.cjs");

const CREATED = "2026-11-01T01:00:00Z";
const PAID = "2026-11-02T02:00:00Z";
function project(extra = {}) { return orderRow({ id: "legacy-1", orderNo: "ORDER-1", status: "new", service_status: "new", createdAt: CREATED, totalAmount: 100, ...extra }); }

test("unpaid legacy orders keep creation time distinct from an unknown payment time", () => {
  for (const extra of [{}, { depositPaid: 0, finalPaid: 0 }, { depositPaid: 30, depositFinanceStatus: "pending" }]) {
    const row = project(extra);
    assert.equal(row.created_at, "2026-11-01 09:00:00");
    assert.equal(row.paid_at, null);
    assert.equal(row.has_paid, false);
    assert.equal(row.deposit_waived, false);
    assert.equal(row.payment_status, "unpaid");
    assert.equal(row.payment_status_label, "未支付");
  }
  assert.equal(project({created_at:"2026-11-13 12:00:00"}).created_at,"2026-11-01 09:00:00", "business creation time takes priority over the later database import time");
});

test("actual payment timestamps and confirmed positive records establish paid status", () => {
  for (const extra of [{ depositPaidAt: PAID }, { depositConfirmedAt: PAID }, { finalPaidAt: PAID }, { paid_at: PAID },
    { depositPaidAt: "invalid", paymentRecords: [{ phase: "deposit", amount: 30, status: "success", paidAt: PAID }] }]) {
    const row = project(extra);
    assert.equal(row.paid_at, "2026-11-02 10:00:00");
    assert.equal(row.has_paid, true);
    assert.equal(row.payment_status, "paid");
    assert.equal(row.payment_status_label, "已支付");
  }
  const noTime = project({ paymentRecords: [{ phase: "deposit", amount: 30, status: "confirmed" }] });
  assert.equal(noTime.has_paid, true);
  assert.equal(noTime.paid_at, null, "missing payment time must not be replaced by creation time");
  assert.equal(project({ depositPaid: 30 }).has_paid, true, "legacy positive receipts remain visible");
});

test("pending, failed and zero balance records cannot fabricate receipt of money", () => {
  const row = project({ paymentRecords: [
    { phase: "deposit", amount: 30, status: "pending", paidAt: PAID },
    { phase: "deposit", amount: 30, status: "failed", paidAt: PAID },
    { phase: "final", amount: 0, status: "confirmed", provider: "zero_balance", paidAt: PAID },
  ] });
  assert.equal(row.has_paid, false);
  assert.equal(row.paid_at, null);
});

test("waiving the deposit requires explicit zero payment terms with amount taking priority", () => {
  for (const extra of [{ depositDue: 0 }, { depositFrozenAmount: "0.00" }, { depositAmount: 0 }, { depositRatio: 0 }, { depositRate: "0" }, { packageSnapshot: { depositRatio: 0 } }]) {
    const row = project(extra);
    assert.equal(row.deposit_waived, true, JSON.stringify(extra));
    assert.equal(row.has_paid, false);
    assert.equal(row.paid_at, null);
    assert.equal(row.payment_status, "waived");
    assert.equal(row.payment_status_label, "免定金");
  }
  for (const extra of [{ depositDue: 30, depositRatio: 0 }, { depositDue: null }, { depositRatio: "" }, { depositRatio: false }, { depositDue: -1 }, { depositRatio: "invalid" }]) {
    assert.equal(project(extra).deposit_waived, false, JSON.stringify(extra));
  }
  assert.equal(project({ depositDue: 0, finalPaid: 100, finalPaidAt: PAID }).payment_status, "paid");
});

test("migration default new cannot reopen completed, canceled or refunded orders", () => {
  for (const status of ["completed", "done", "已完成"]) assert.equal(project({ status }).service_status, "done");
  for (const status of ["cancelled", "canceled", "terminated", "已取消"]) assert.equal(project({ status }).service_status, "canceled");
  for (const status of ["refunded", "已退款"]) assert.equal(project({ status }).service_status, "refunded");
  assert.equal(project({ completedAt: PAID }).service_status, "done");
  assert.equal(project({ workflowStage: "completed" }).service_status, "done");
  assert.equal(project({ workflowStage: "cancelled", completedAt: PAID }).service_status, "canceled");
  assert.equal(project({ status: "completed", service_status: "claimed" }).service_status, "done");
});

test("legacy lifecycle, ownership and confirmed schedule survive their service projection", () => {
  const appointmentAt = "2026-11-13T07:00:00Z";
  assert.equal(project({ status: "shooting", serviceUserId: "old-service" }).service_status, "shooting");
  for (const status of ["final_pending", "editing", "retouching"]) assert.equal(project({ status, serviceUserId: "old-service" }).service_status, "final_pending");
  const assigned = project({ assigneeId: "old-service", photographerId: "old-photo", appointmentAt });
  assert.equal(assigned.service_status, "confirmed");
  assert.equal(assigned.assignee_id, "old-service");
  assert.equal(assigned.photo_id, "old-photo");
  assert.equal(assigned.requested_time, "2026-11-13 15:00:00");
  assert.equal(assigned.schedule_time, "2026-11-13 15:00:00");
  assert.equal(project({ serviceUserId: "old-service" }).service_status, "claimed");
  assert.equal(project({ svc_paid_processed: "0" }).service_managed, false);
  assert.equal(project({ svc_paid_processed: "1" }).service_managed, true);
});

test("customer intent supplies the requested time without confirming a shooting slot", () => {
  for (const intentTimePeriod of ["15:30", "15:30:00"]) {
    const row = project({ intentDate: "2026-12-20", intentTimePeriod });
    assert.equal(row.requested_time, "2026-12-20 15:30:00");
    assert.equal(row.schedule_time, null);
    assert.equal(row.service_status, "new");
  }
  const confirmed = project({ intentDate: "2026-12-20", intentTimePeriod: "15:30", service_status: "confirmed",
    appointmentAt: "2026-12-21 16:00:00", schedule_time: "2026-12-21 16:00:00" });
  assert.equal(confirmed.requested_time, "2026-12-20 15:30:00");
  assert.equal(confirmed.schedule_time, "2026-12-21 16:00:00");
  assert.equal(project({ intentDate: "2026-12-20", intentTimePeriod: "15:30", requested_time: "2026-12-19 14:00:00" }).requested_time, "2026-12-19 14:00:00");
});

test("incomplete, textual and invalid customer intent cannot fabricate a requested datetime", () => {
  for (const extra of [{ intentDate: "2026-12-20" }, { intentTimePeriod: "15:30" },
    { intentDate: "2026-12-20", intentTimePeriod: "上午" }, { intentDate: "2026-12-20", intentTimePeriod: "15:00-16:00" },
    { intentDate: "2026-02-30", intentTimePeriod: "15:30" }, { intentDate: "2026-12-20", intentTimePeriod: "24:00" },
    { intentDate: "2026-12-20", intentTimePeriod: "15:60" }]) {
    const row = project({ ...extra, service_status: "confirmed", appointmentAt: "2026-12-21 16:00:00" });
    assert.equal(row.requested_time, null, JSON.stringify(extra));
    assert.equal(row.schedule_time, "2026-12-21 16:00:00", "confirmed time must not replace incomplete original intent");
  }
});

test("existing service ownership and reservation states are retained without changing input", () => {
  for (const status of ["reserved", "claimed", "confirmed", "shooting", "final_pending", "done", "refunded", "canceled"]) {
    const input = { orderNo: "ORDER-1", service_status: status, assignee_id: "s1", photo_id: "p1", depositPaidAt: PAID, svc_paid_processed: 1 };
    const previous = structuredClone(input);
    const row = orderRow(input);
    assert.equal(row.service_status, status);
    assert.equal(row.assignee_id, "s1");
    assert.deepEqual(input, previous);
  }
});
