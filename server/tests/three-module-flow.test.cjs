"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");

test("photographer pending disposition filters active workbench orders without bypassing staff ownership", async () => {
  const store = createSvcMemoryStore({
    staff: [{ id: "st1", account_id: "account-1", staff_status: "active" }, { id: "st2", account_id: "account-2", staff_status: "active" }],
    orders: [
      ["OWN", "st1", "PH20260001", "confirmed"], ["OTHER-PHOTO", "st1", "PH20260002", "shooting"],
      ["OTHER-STAFF", "st2", "PH20260001", "shooting"], ["FINISHED", "st1", "PH20260001", "done"],
    ].map(([order_no, assignee_id, photo_id, service_status]) => ({ id: order_no, order_no, assignee_id, photo_id, service_status, paid_at: "2026-11-01 10:00:00", svc_paid_processed: 1 })),
  });
  const app = createSvcWorkbench({ store, clock: () => "2026-11-13 10:00:00" });
  const input = { view: "active", photo: "PH20260001" };
  const own = await app.execute("GET", "/api/kf/orders/mine", input, { role: "service", authzUserId: "account-1" });
  assert.deepEqual(own.list.map(row => row.order_no), ["OWN"]);
  const all = await app.execute("GET", "/api/kf/orders/mine", input, { role: "super", authzUserId: "admin" });
  assert.deepEqual(new Set(all.list.map(row => row.order_no)), new Set(["OWN", "OTHER-STAFF"]));
  assert.equal(store.snapshot().orders.length, 4);
});
