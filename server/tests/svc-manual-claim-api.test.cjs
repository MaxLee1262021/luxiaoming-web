"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startBrowserFixture } = require("./fixtures/merchant-share-browser.cjs");

test("explicitly claimed orders remain protected from legacy edits without a payment-event flag", async t => {
  const fixture = await startBrowserFixture();
  t.after(() => fixture.close());
  await fixture.source.create("orders", { id: "manual-order", orderNo: "MANUAL-CLAIM", service_status: "claimed", assignee_id: "service-1", svc_paid_processed: 0,
    status: "deposit_paid", depositPaid: 20, depositDue: 20, totalAmount: 100, depositFinanceStatus: "已审", depositPaidAt: "2026-11-13 10:00:00" });
  const before = await fixture.source.get("orders", "manual-order"), queries = [];
  fixture.source.transaction = async work => work({ async query(sql, params = []) {
    queries.push({sql,params});
    assert.match(sql, /^SELECT/);assert.match(sql, /svc_operation_log/);
    return [[{ has_manual_claims: 1 }]];
  } });
  const login = await fetch(fixture.url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixture.accounts.admin) }).then(response => response.json());
  const token = login.token || login.session?.token;
  assert.ok(token);
  const send = (url, method, body) => fetch(fixture.url + url, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const legacy = await send("/api/orders/manual-order/action", "POST", { action: "reschedule", date: "2026-12-01", reason: "old editor" });
  const legacyBody = await legacy.json();
  assert.equal(legacy.status, 409, JSON.stringify(legacyBody));assert.match(legacyBody.error, /客服工作台/);
  const collection = await send("/api/collection/orders/manual-order", "PUT", { appointmentAt: "2026-12-01 12:00:00" });
  assert.equal(collection.status, 403);assert.match((await collection.json()).error, /专用操作接口/);
  assert.equal(queries.length, 1);
  assert.deepEqual(await fixture.source.get("orders", "manual-order"), before);
});
