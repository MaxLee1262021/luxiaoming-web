"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const { createTestWechatPay } = require("./helpers/wechatPay.cjs");

const TEST_WECHAT_PAY = createTestWechatPay();

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeSource() {
  const collections = {
    packages: { p1: { id: "p1", name: "Portrait", price: 100, depositRatio: 40, status: "published" } },
    albums: {}, peripherals: {}, spots: {}, series: {}, shops: {}, merchantCodes: {},
    siteConfig: { global: { id: "global", customPrice: { depositRatio: 30 } } },
    orders: {}, afterSales: {}, logs: {}, mediaFiles: {},
    staff: {
      service: { id: "service", account: "service", role: "service", status: "active" },
      photo: { id: "photo", account: "photo", role: "photo", status: "active" },
      super: { id: "super", account: "super", role: "super", status: "active" },
    },
  };
  let sequence = 0;
  return {
    collections,
    async list(key) { return Object.values(collections[key] || {}).map(clone); },
    async get(key, id) { return clone(collections[key] && collections[key][String(id)]); },
    async create(key, document) {
      const id = String(document.id || document._id || `${key}-${++sequence}`);
      collections[key] ||= {};
      if (collections[key][id]) { const error = new Error("duplicate"); error.code = "DUPLICATE_RECORD"; throw error; }
      collections[key][id] = { ...clone(document), id, _id: id };
      return clone(collections[key][id]);
    },
    async update(key, id, patch) {
      if (!collections[key] || !collections[key][String(id)]) return null;
      collections[key][String(id)] = { ...collections[key][String(id)], ...clone(patch), id: String(id), _id: String(id) };
      return clone(collections[key][String(id)]);
    },
    async remove(key, id) {
      if (!collections[key] || !collections[key][String(id)]) return false;
      delete collections[key][String(id)]; return true;
    },
  };
}

function publicIdentity(openid = "owner") {
  return { identity: { kind: "public", openid }, wechatPay: TEST_WECHAT_PAY };
}

async function withApi(source, callback) {
  const sessions = {
    "super-token": { kind: "admin", subjectId: "super", account: "super", role: "super", menuKeys: ["orders", "packages", "afterSales"] },
    "photo-token": { kind: "admin", subjectId: "photo", account: "photo", role: "photo", menuKeys: ["tasks"] },
  };
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]) || null; } };
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("booking does not require an expected shooting time and uses the package deposit ratio", async () => {
  const source = makeSource();
  const result = await rpc(source, "createBooking", {
    data: { name: "Visitor", phone: "13800000000", items: [{ packageId: "p1" }], idempotencyKey: "booking-no-time-01" },
  }, publicIdentity());
  assert.equal(result.success, true, JSON.stringify(result));
  const order = await source.get("orders", result.orderId);
  assert.equal(order.date, "");
  assert.equal(order.timePeriod, "");
  assert.equal(order.depositRatio, 0.4);
  assert.equal(order.depositDue, 40);
  assert.equal(order.workflowStage, workflow.WORKFLOW_STAGES.AWAITING_DEPOSIT);
  assert.equal(result.order.statusText, "待支付");
  assert.equal(result.order.businessStatus, "pending_payment");

  const intent = await rpc(source, "createPayment", {
    data: { orderId: result.orderId, phase: "deposit", idempotencyKey: "deposit-no-time-01" },
  }, publicIdentity());
  assert.equal(intent.success, true, JSON.stringify(intent));
  assert.equal(intent.data.status, "pending");
});

test("dispatch records confirmed facts, locks the deposit refund, and enforces selection -> final payment -> delivery", { concurrency: false }, async () => {
  const source = makeSource();
  source.collections.orders.o1 = {
    id: "o1", orderNo: "O-1", openid: "owner", status: "deposit_paid", totalAmount: 100,
    depositDue: 40, finalDue: 60, depositPaid: 40, depositFinanceStatus: "confirmed", depositRefundable: true,
    paymentRecords: [{ id: "d1", phase: "deposit", amount: 40, status: "confirmed", provider: "test_payment" }],
    selectionStatus: "not_started", statusLogs: [], followRecords: [], contactName: "Visitor", contactPhone: "13800000000",
  };
  const previous = process.env.TEST_PAYMENT_ENABLED;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousIsolatedSource = process.env.LXM_ALLOW_TEST_JSON_SOURCE;
  const previousDataMode = process.env.DATA_MODE;
  process.env.TEST_PAYMENT_ENABLED = "true";
  process.env.NODE_ENV = "test";
  process.env.LXM_ALLOW_TEST_JSON_SOURCE = "true";
  process.env.DATA_MODE = "json";
  try {
    await withApi(source, async (base) => {
      const post = async (token, path, body) => {
        const response = await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      const missing = await post("super-token", "/api/orders/o1/action", { action: "assign", photographerId: "photo", reason: "dispatch" });
      assert.equal(missing.status, 400);

      const assigned = await post("super-token", "/api/orders/o1/action", {
        action: "assign", photographerId: "photo", appointmentAt: "2026-12-20", timePeriod: "14:00-16:00",
        appointmentLocation: "Orange Island", peopleCount: 2, confirmationMethod: "phone",
        customerConfirmationNote: "Customer confirmed by phone", reason: "customer confirmed schedule",
      });
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      const afterAssign = await source.get("orders", "o1");
      assert.equal(afterAssign.depositRefundable, false);
      assert.equal(afterAssign.dispatchBaseInfo.confirmationMethod, "phone");
      assert.equal(afterAssign.dispatchBaseInfo.confirmedShootLocation, "Orange Island");
      assert.equal(afterAssign.dispatchRecords.length, 1);
      assert.equal(workflow.businessStatusForOrder(afterAssign), "awaiting_photographer");

      const refund = await post("super-token", "/api/collection/afterSales", { orderId: "o1", refundAmount: 40, refundPhase: "deposit", reason: "deposit refund" });
      assert.equal(refund.status, 409);

      const started = await post("photo-token", "/api/orders/o1/action", { action: "start", reason: "start shooting" });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const shot = await post("photo-token", "/api/orders/o1/action", { action: "shootcomplete", reason: "shooting completed" });
      assert.equal(shot.status, 200, JSON.stringify(shot.body));
      const selected = await post("photo-token", "/api/orders/o1/action", { action: "selectionConfirm", reason: "offline selection completed" });
      assert.equal(selected.status, 200, JSON.stringify(selected.body));
      const selectedOrder = await source.get("orders", "o1");
      assert.equal(selectedOrder.selectionMethod, "offline");
      assert.equal(workflow.businessStatusForOrder(selectedOrder), "shot");

      const finalBefore = await rpc(source, "createPayment", { data: { orderId: "o1", phase: "final", idempotencyKey: "final-before-delivery-01" } }, publicIdentity());
      assert.equal(finalBefore.success, true, JSON.stringify(finalBefore));
      const paid = await rpc(source, "testPayment", { data: { orderId: "o1", phase: "final", idempotencyKey: "test-final-flow-01" } }, publicIdentity());
      assert.equal(paid.success, true, JSON.stringify(paid));
      assert.equal(workflow.businessStatusForOrder(await source.get("orders", "o1")), "paid");

      const delivered = await post("super-token", "/api/orders/o1/action", { action: "deliver", deliveryMethod: "enterprise_wechat", reason: "files delivered" });
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
      assert.equal(workflow.businessStatusForOrder(await source.get("orders", "o1")), "delivered");
    });
  } finally {
    if (previous === undefined) delete process.env.TEST_PAYMENT_ENABLED;
    else process.env.TEST_PAYMENT_ENABLED = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousIsolatedSource === undefined) delete process.env.LXM_ALLOW_TEST_JSON_SOURCE;
    else process.env.LXM_ALLOW_TEST_JSON_SOURCE = previousIsolatedSource;
    if (previousDataMode === undefined) delete process.env.DATA_MODE;
    else process.env.DATA_MODE = previousDataMode;
  }
});

test("package deposit ratio is normalized and bounded by the admin API", async () => {
  const source = makeSource();
  await withApi(source, async (base) => {
    const send = (body) => fetch(base + "/api/collection/packages", {
      method: "POST", headers: { Authorization: "Bearer super-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const valid = await send({ id: "p2", name: "Video", price: 200, depositRatio: 25, status: "published" });
    assert.equal(valid.status, 201);
    assert.equal((await valid.json()).depositRatio, 0.25);
    const invalid = await send({ id: "p3", name: "Invalid", price: 200, depositRatio: 101, status: "published" });
    assert.equal(invalid.status, 400);
  });
});
