"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { isDeepStrictEqual } = require("node:util");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const { createTestWechatPay } = require("./helpers/wechatPay.cjs");
const clone = (value) => value == null ? value : structuredClone(value);
function fixture() {
  const collections = { orders: {}, afterSales: {}, logs: {}, packages: { p: { id: "p", name: "Portrait", price: 100, depositRatio: 30, status: "published" } },
    siteConfig: { global: { id: "global", bookingNotice: ["Current notice"], bookingNoticeVersion: "notice-2", customPrice: { depositRatio: 30 } } },
    staff: Object.fromEntries(["service", "other", "super", "photo", "finance"].map((id) => [id, { id, account: id, role: id === "other" ? "service" : id, status: "active" }])) };
  let sequence = 0; let casCalls = 0;
  return { collections, get casCalls() { return casCalls; },
    async list(key) { return clone(Object.values(collections[key] || {})); },
    async get(key, id) { return clone(collections[key]?.[id]) || null; },
    async create(key, row) { const id = row.id || row._id || `row-${++sequence}`; collections[key] ||= {}; collections[key][id] = { ...clone(row), id }; return clone(collections[key][id]); },
    async update(key, id, patch) { if (!collections[key]?.[id]) return null; Object.assign(collections[key][id], clone(patch)); return clone(collections[key][id]); },
    async compareAndUpdate(key, id, expected, patch) { casCalls++; const row = collections[key]?.[id]; if (!row || !Object.entries(expected).every(([field, value]) => isDeepStrictEqual(row[field], value))) return null; return this.update(key, id, patch); },
    async remove(key, id) { return delete collections[key]?.[id]; } };
}
const identity = { identity: { kind: "public", openid: "customer" }, wechatPay: createTestWechatPay() };
const input = () => ({ name: "Visitor", phone: "13800000000", expectedDate: "2026-12-20", expectedTimePeriod: "上午", agreement: { version: "notice-2", current: true }, items: [{ packageId: "p" }], idempotencyKey: "booking-latest-0001" });
async function api(t, source) {
  const sessions = Object.fromEntries(Object.values(source.collections.staff).map((staff) => [staff.id, { kind: "admin", subjectId: staff.id, account: staff.account, role: staff.role }]));
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]); }, async revokeSession() {} };
  const handler = createApi(source, "json", { auth, permissionStore: null });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return async (token, id, body, method = "POST") => {
    const path = body === undefined ? `/api/collection/orders/${id}` : `/api/orders/${id}/action`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? "GET" : method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
}
test("booking requires intent and the current notice, stores server consent facts and blocks missing monetary configuration", async () => {
  const source = fixture();
  const config = await rpc(source, "getBookingConfig", {});
  assert.equal(config.data.bookingNoticeVersion, "notice-2");
  for (const patch of [{ expectedDate: "" }, { expectedTimePeriod: "" }, { agreement: { version: "old", current: true } }, { agreement: { version: "notice-2", current: false } }]) {
    const result = await rpc(source, "createBooking", { data: { ...input(), ...patch } }, identity);
    assert.equal(result.success, false, JSON.stringify(patch));
    assert.equal(Object.keys(source.collections.orders).length, 0);
  }
  const result = await rpc(source, "createBooking", { data: { ...input(), agreementAcceptedBy: "forged", agreementAcceptedAt: "1900-01-01" } }, identity);
  assert.equal(result.success, true, JSON.stringify(result));
  const saved = await source.get("bookingRequests", result.bookingId);
  assert.equal(saved.intentDate, "2026-12-20");
  assert.equal(saved.intentTimePeriod, "上午");
  assert.equal(saved.appointmentAt, undefined);
  assert.equal(saved.agreementAcceptedBy, "customer");
  assert.notEqual(saved.agreementAcceptedAt, "1900-01-01");
  assert.equal(saved.agreementSnapshot.notice, "1. Current notice");
  source.collections.orders = {};
  source.collections.bookingRequests = {};
  delete source.collections.packages.p.price;
  assert.equal((await rpc(source, "createBooking", { data: input() }, identity)).success, false);
  source.collections.packages.p.price = 100;
  delete source.collections.packages.p.depositRatio;
  source.collections.siteConfig.global.customPrice = {};
  assert.equal((await rpc(source, "createBooking", { data: input() }, identity)).success, false);
});
test("claim uses CAS, transfer removes former access and generic updates cannot bypass ownership", async (t) => {
  const source = fixture();
  source.collections.orders.o = { id: "o", status: "deposit_paid", depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", totalAmount: 100, finalDue: 70, statusLogs: [], followRecords: [] };
  const request = await api(t, source);
  assert.equal((await request("service", "o", { action: "note", reason: "unclaimed note" })).status, 403);
  const claims = await Promise.all([request("service", "o", { action: "claim", reason: "claim by first" }), request("other", "o", { action: "claim", reason: "claim by second" })]);
  assert.equal(claims.filter((row) => row.status === 200).length, 1);
  assert.ok(source.casCalls > 0);
  const owner = source.collections.orders.o.assigneeId;
  const next = owner === "service" ? "other" : "service";
  assert.equal((await request(owner, "o", { action: "update", reason: "assignment bypass", fields: { assigneeId: next } })).status, 409);
  assert.equal((await request(owner, "o", { action: "update", reason: "source bypass", fields: { shopId: "forged" } })).status, 409);
  assert.equal((await request(owner, "o", { action: "transfer", assigneeId: next, reason: "transfer for continued service" })).status, 200);
  assert.equal((await request(owner, "o", undefined)).status, 404);
  assert.equal((await request(owner, "o", { action: "note", reason: "former owner mutation" })).status, 403);
  assert.equal((await request(next, "o", undefined)).status, 200);
});
test("service starts its assigned order, frozen deposit survives price adjustments and completed followup/delivery stay independent", async (t) => {
  const source = fixture();
  source.collections.orders.o = { id: "o", status: "assigned", assigneeId: "service", photographerId: "photo", totalAmount: 100, depositDue: 30, depositFrozenAmount: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70, statusLogs: [], followRecords: [] };
  const request = await api(t, source);
  assert.equal((await request("service", "o", { action: "start", reason: "customer and photographer met" })).status, 200);
  assert.equal((await request("photo", "o", { action: "start", reason: "photographer login disabled" })).status, 401);
  assert.equal((await request("service", "o", { action: "update", reason: "extra products", fields: { totalAmount: 160, finalDiscountAmount: 10, priceAdjustReason: "customer extra service" } })).status, 200);
  assert.equal(source.collections.orders.o.depositDue, 30);
  assert.equal(source.collections.orders.o.finalDue, 120);
  assert.equal((await request("service", "o", { action: "update", reason: "discount below deposit", fields: { totalAmount: 20, priceAdjustReason: "excessive discount" } })).status, 409);
  Object.assign(source.collections.orders.o, { status: "completed", finalPaid: 120, finalFinanceStatus: "confirmed", completedAt: "2026-10-14T01:00:00Z" });
  const completedAt = source.collections.orders.o.completedAt;
  assert.equal((await request("service", "o", { action: "deliveryrecord", deliveryMethod: "企业微信", note: "photos delivered" })).status, 200);
  assert.equal((await request("service", "o", { action: "followup", type: "second_contact", content: "customer feedback call", status: "pending", reason: "second followup" })).status, 200);
  assert.equal(source.collections.orders.o.status, "completed");
  assert.equal(source.collections.orders.o.completedAt, completedAt);
  assert.ok(source.collections.orders.o.followRecords.some((entry) => entry.type === "customer_followup" && entry.content === "customer feedback call"));
  const followup = source.collections.orders.o.followRecords.find((entry) => entry.type === "customer_followup");
  assert.equal(followup.ownerId, "service");
  assert.ok(followup.createdAt);
  assert.equal(followup.completedAt, undefined);
  assert.equal((await request("service", "o", { action: "followup", followupId: followup.id, type: "second_contact", content: "feedback received", status: "completed", reason: "resolved followup" })).status, 200);
  assert.ok(source.collections.orders.o.followRecords.find((entry) => entry.id === followup.id).completedAt);
  assert.equal((await request("super", "o", { action: "update", reason: "completed amount override", fields: { totalAmount: 200, priceAdjustReason: "unsafe correction" } })).status, 409);
  source.collections.orders.o.afterSaleStatus = "pending";
  assert.equal(workflow.businessStatusForOrder(source.collections.orders.o), "completed");
});
test("zero final balance acknowledges completion without a fabricated WeChat transaction", async () => {
  const source = fixture();
  source.collections.orders.o = { id: "o", openid: "customer", status: "shooting", totalAmount: 100, depositDue: 100, depositPaid: 100, depositFinanceStatus: "confirmed", finalDue: 0, paymentRecords: [], statusLogs: [], followRecords: [] };
  assert.equal(workflow.publicOrderProjection(source.collections.orders.o).canConfirmCompletion, false);
  const premature = await rpc(source, "createPayment", { data: { orderId: "o", phase: "final", selectionAccepted: true, idempotencyKey: "zero-premature-0001" } }, { identity: identity.identity });
  assert.equal(premature.success, false);
  assert.equal(source.collections.orders.o.status, "shooting");
  source.collections.orders.o.shootingCompletedAt = "2026-10-26T01:00:00Z";
  assert.equal(workflow.publicOrderProjection(source.collections.orders.o).canConfirmCompletion, true);
  const result = await rpc(source, "createPayment", { data: { orderId: "o", phase: "final", selectionAccepted: true, idempotencyKey: "zero-complete-0001" } }, { identity: identity.identity });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.provider, "zero_balance");
  assert.equal(result.data.invokeWeChatPay, false);
  assert.equal(source.collections.orders.o.status, "completed");
  assert.equal(source.collections.orders.o.paymentRecords[0].externalTransactionId, undefined);
  assert.equal((await rpc(source, "createPayment", { data: { orderId: "o", phase: "final", selectionAccepted: true, idempotencyKey: "zero-complete-0001" } }, { identity: identity.identity })).data.idempotent, true);
});

test("an independent delivery record cannot open final payment before shooting is completed", async () => {
  const source = fixture();
  source.collections.orders.o = { id: "o", openid: "customer", status: "shooting", shootingStartedAt: "2026-10-26T01:00:00Z", totalAmount: 100,
    depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70, paymentRecords: [],
    deliveryRecord: { method: "现场补充交付" }, deliveryRecords: [{ method: "现场补充交付" }] };
  const projected = workflow.publicOrderProjection(source.collections.orders.o);
  assert.equal(projected.workflowStage, "shooting");
  assert.equal(projected.shootingCompleted, false);
  assert.equal(projected.canPayFinal, false);
  const premature = await rpc(source, "createPayment", { data: { orderId: "o", phase: "final", selectionAccepted: true, idempotencyKey: "delivery-premature-final" } }, identity);
  assert.equal(premature.success, false);
  assert.deepEqual(source.collections.orders.o.paymentRecords, []);
});

test("public projection returns current gifts and intent and excludes internal deliveries", () => {
  const order = { id: "o", status: "completed", completedAt: "2026-10-14T01:00:00Z", completionSource: "wechat_pay_final", selectionAcknowledgedAt: "2026-10-14T01:00:00Z",
    intentDate: "2026-12-20", intentTimePeriod: "下午", totalAmount: 100, depositDue: 30, depositFrozenAmount: 30, finalDue: 70, finalPaid: 70, finalFinanceStatus: "confirmed",
    productItems: [{ name: "stale" }], products: [{ id: "gift", name: "Current gift", price: 0, originalPrice: 50, isGift: true }], addons: [{ name: "Extra", price: 20 }],
    deliveryRecord: { method: "private", visibility: "internal" }, deliveryRecords: [{ method: "private", visibility: "internal", note: "secret" }, { method: "企业微信", note: "customer copy" }], deliverFiles: [{ id: "private" }] };
  const projected = workflow.publicOrderProjection(order);
  assert.equal(projected.productItems[0].name, "Current gift");
  assert.equal(projected.productItems[0].isGift, true);
  assert.equal(projected.productItems[0].originalPrice, 50);
  assert.equal(projected.intentDate, "2026-12-20");
  assert.equal(projected.canAfterSale, false);
  assert.equal(projected.deliveryRecord, undefined);
  assert.deepEqual(projected.deliverFiles, []);
  assert.deepEqual(projected.deliveryRecords, [{ method: "企业微信", note: "customer copy" }]);
  const unresolved = workflow.publicOrderProjection({ ...order, paymentReviewRequired: true });
  assert.notEqual(unresolved.businessStatus, "completed");
  assert.equal(unresolved.canPay, false);
});

test("production mock setting cannot mark a real order paid", async () => {
  const source = fixture();
  source.collections.orders.o = { id: "o", openid: "customer", status: "new", depositDue: 30, finalDue: 70, totalAmount: 100 };
  const previous = Object.fromEntries(["NODE_ENV", "DATA_MODE", "LXM_ALLOW_TEST_JSON_SOURCE", "PAYMENT_MODE"].map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "production"; process.env.DATA_MODE = "mysql"; process.env.LXM_ALLOW_TEST_JSON_SOURCE = "false"; process.env.PAYMENT_MODE = "mock";
    const result = await rpc(source, "createPayment", { data: { orderId: "o", phase: "deposit", idempotencyKey: "production-mock-0001" } }, { identity: identity.identity, wechatPay: { isConfigured() { return false; } } });
    assert.equal(result.success, false);
    assert.equal(source.collections.orders.o.status, "new");
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
