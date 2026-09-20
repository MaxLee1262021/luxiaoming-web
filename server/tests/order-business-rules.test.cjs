"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");

const CONFIRMED_DEPOSIT = {
  depositDue: 30,
  depositPaid: 30,
  depositFinanceStatus: "confirmed",
  paymentRecords: [{ id: "deposit-1", phase: "deposit", amount: 30, status: "confirmed", provider: "test_payment" }],
};

function order(overrides = {}) {
  return {
    id: "business-rule-order",
    totalAmount: 100,
    depositDue: 30,
    finalDue: 70,
    status: "new",
    ...overrides,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeSource() {
  const collections = {
    packages: {
      "package-1": { id: "package-1", name: "测试套餐", price: 100, depositRatio: 30, status: "published" },
    },
    albums: {}, peripherals: {}, spots: {}, series: {}, shops: {}, merchantCodes: {},
    siteConfig: { global: { id: "global", customPrice: { depositRatio: 30 } } },
    orders: {}, afterSales: {}, logs: {},
    staff: {
      super: { id: "super", account: "super", role: "super", status: "active" },
      service: { id: "service", account: "service", role: "service", status: "active" },
      photo: { id: "photo", account: "photo", role: "photo", status: "active" },
    },
  };
  let sequence = 0;
  return {
    collections,
    async list(key) { return Object.values(collections[key] || {}).map(clone); },
    async get(key, id) { return clone(collections[key] && collections[key][String(id)]) || null; },
    async create(key, document) {
      const id = String(document.id || document._id || `${key}-${++sequence}`);
      collections[key] ||= {};
      if (collections[key][id]) {
        const error = new Error("duplicate record"); error.code = "DUPLICATE_RECORD"; throw error;
      }
      if (key === "orders" && document.orderNo && Object.values(collections.orders).some((row) => row.orderNo === document.orderNo)) {
        const error = new Error("duplicate order number"); error.code = "ER_DUP_ENTRY"; throw error;
      }
      collections[key][id] = { ...clone(document), id, _id: id };
      return clone(collections[key][id]);
    },
    async update(key, id, patch) {
      const current = collections[key] && collections[key][String(id)];
      if (!current) return null;
      collections[key][String(id)] = { ...current, ...clone(patch), id: String(id), _id: String(id) };
      return clone(collections[key][String(id)]);
    },
    async remove(key, id) {
      if (!collections[key] || !collections[key][String(id)]) return false;
      delete collections[key][String(id)];
      return true;
    },
  };
}

function publicIdentity(openid = "owner") {
  return { identity: { kind: "public", openid } };
}

async function startAdminApi(source) {
  const sessions = {
    "super-token": { kind: "admin", subjectId: "super", account: "super", role: "super", menuKeys: ["orders", "tasks"] },
    "service-token": { kind: "admin", subjectId: "service", account: "service", role: "service", menuKeys: ["orders"] },
    "photo-token": { kind: "admin", subjectId: "photo", account: "photo", role: "photo", menuKeys: ["tasks"] },
  };
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]); } };
  const handler = createApi(source, "json", { auth, sourceStatus: { ready: true }, permissionStore: null });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (token, route, body) => {
    const response = await fetch(base + route, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, post };
}

async function closeServer(server) {
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
}

async function withTestPayment(callback) {
  const previous = process.env.TEST_PAYMENT_ENABLED;
  try {
    process.env.TEST_PAYMENT_ENABLED = "true";
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.TEST_PAYMENT_ENABLED;
    else process.env.TEST_PAYMENT_ENABLED = previous;
  }
}

test("scan booking has no expected time and snapshots the package deposit ratio", async () => {
  const source = makeSource();
  const created = await rpc(source, "createBooking", {
    data: {
      name: "测试用户", phone: "13800000000", items: [{ packageId: "package-1" }],
      idempotencyKey: "business-booking-0001",
    },
  }, publicIdentity("owner"));
  assert.equal(created.success, true, JSON.stringify(created));
  const first = await source.get("orders", created.orderId);
  assert.equal(first.businessStatus, "pending_payment");
  assert.equal(first.customerStatus, "待支付");
  assert.equal(first.date, "");
  assert.equal(first.time, "");
  assert.equal(first.depositRatio, 0.3);
  assert.equal(first.depositDue, 30);
  assert.equal(first.finalDue, 70);

  source.collections.packages["package-1"].depositRatio = 50;
  const second = await rpc(source, "createBooking", {
    data: {
      name: "第二位用户", phone: "13800000001", items: [{ packageId: "package-1" }],
      idempotencyKey: "business-booking-0002",
    },
  }, publicIdentity("owner-2"));
  assert.equal(second.success, true, JSON.stringify(second));
  const secondOrder = await source.get("orders", second.orderId);
  assert.equal(secondOrder.depositRatio, 0.5);
  assert.equal(secondOrder.depositDue, 50);
  assert.equal((await source.get("orders", first.id)).depositDue, 30, "existing orders keep their ratio snapshot");
});

test("dispatch requires traceable manual shooting details and locks the deposit refund", async () => {
  const source = makeSource();
  source.collections.orders.dispatch = {
    ...order({
      id: "dispatch", _id: "dispatch", orderNo: "ORDER-DISPATCH", openid: "owner", status: "deposit_paid",
      ...CONFIRMED_DEPOSIT, finalDue: 70, dispatchStatus: "pending", depositRefundable: true,
    }),
  };
  const api = await startAdminApi(source);
  try {
    const missing = await api.post("service-token", "/api/orders/dispatch/action", {
      action: "assign", photographerId: "photo", reason: "派单信息不完整",
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));

    const assigned = await api.post("service-token", "/api/orders/dispatch/action", {
      action: "assign", photographerId: "photo", confirmedShootDate: "2026-12-20", confirmedShootTime: "10:00",
      confirmedShootLocation: "橘子洲集合点", participantCount: 2, dispatchNote: "游客已人工确认",
      confirmationMethod: "客服微信", customerConfirmationNote: "已与游客确认", reason: "人工确认档期后派单",
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const saved = await source.get("orders", "dispatch");
    assert.equal(saved.depositRefundable, false);
    assert.equal(saved.dispatchBaseInfo.confirmedShootDate, "2026-12-20");
    assert.equal(saved.dispatchBaseInfo.confirmedShootTime, "10:00");
    assert.equal(saved.dispatchBaseInfo.confirmedShootLocation, "橘子洲集合点");
    assert.equal(saved.dispatchBaseInfo.confirmationMethod, "客服微信");
    assert.equal(saved.dispatchRecord.next.photographerId, "photo");
    assert.equal(workflow.isDepositRefundable(saved), false);

    const bypass = await api.post("super-token", "/api/orders/dispatch/action", {
      action: "update", reason: "尝试恢复订金可退", fields: { depositRefundable: true },
    });
    assert.equal(bypass.status, 409, JSON.stringify(bypass.body));
  } finally {
    await closeServer(api.server);
  }
});

test("offline selection gates final payment and confirmed final payment gates delivery", async () => {
  const source = makeSource();
  source.collections.orders.selection = {
    ...order({
      id: "selection", _id: "selection", orderNo: "ORDER-SELECTION", openid: "owner", status: "final_pending",
      ...CONFIRMED_DEPOSIT, photographerId: "photo", dispatchStatus: "accepted", taskStatus: "accepted",
      dispatchRecord: { id: "dispatch-selection", next: { photographerId: "photo" } },
      shootingStartedAt: "2026-09-20T09:00:00.000Z", shootingCompletedAt: "2026-09-20T10:00:00.000Z",
      selectionStatus: "pending", depositRefundable: false,
    }),
  };
  const before = await rpc(source, "createPayment", {
    data: { orderId: "selection", phase: "final", idempotencyKey: "final-before-selection-0001" },
  }, publicIdentity("owner"));
  assert.equal(before.success, false);

  const api = await startAdminApi(source);
  try {
    const selected = await api.post("photo-token", "/api/orders/selection/action", {
      action: "selectionConfirm", reason: "游客已在线下完成选片",
    });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    const selectedOrder = await source.get("orders", "selection");
    assert.equal(selectedOrder.selectionMethod, "offline");
    assert.equal(selectedOrder.selectionRecord.method, "offline");

    const beforeDelivery = await api.post("super-token", "/api/orders/selection/action", {
      action: "deliver", deliveryMethod: "enterprise_wechat", reason: "尾款前禁止交付",
    });
    assert.equal(beforeDelivery.status, 409, JSON.stringify(beforeDelivery.body));
  } finally {
    await closeServer(api.server);
  }

  await withTestPayment(async () => {
    const paid = await rpc(source, "testPayment", {
      data: { orderId: "selection", phase: "final", idempotencyKey: "final-after-selection-0001" },
    }, publicIdentity("owner"));
    assert.equal(paid.success, true, JSON.stringify(paid));
    assert.equal((await source.get("orders", "selection")).status, "paid");

    const deliveryApi = await startAdminApi(source);
    try {
      const delivered = await deliveryApi.post("super-token", "/api/orders/selection/action", {
        action: "deliver", deliveryMethod: "enterprise_wechat", reason: "尾款已确认后交付",
      });
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
      const finalOrder = await source.get("orders", "selection");
      assert.equal(workflow.businessStatusForOrder(finalOrder), "delivered");
    } finally {
      await closeServer(deliveryApi.server);
    }
  });
});

test("customer projection exposes exactly the five normal business states", () => {
  const rows = [
    [order(), "pending_payment"],
    [order({ status: "deposit_paid", ...CONFIRMED_DEPOSIT }), "awaiting_photographer"],
    [order({
      status: "final_pending",
      ...CONFIRMED_DEPOSIT,
      shootingCompletedAt: "2026-09-20T10:00:00.000Z",
      selectionStatus: "confirmed",
      selectionConfirmedAt: "2026-09-20T12:00:00.000Z",
    }), "shot"],
    [order({
      status: "paid",
      ...CONFIRMED_DEPOSIT,
      finalPaid: 70,
      finalFinanceStatus: "confirmed",
      shootingCompletedAt: "2026-09-20T10:00:00.000Z",
      selectionStatus: "confirmed",
      selectionConfirmedAt: "2026-09-20T12:00:00.000Z",
      paymentRecords: [
        ...CONFIRMED_DEPOSIT.paymentRecords,
        { id: "final-1", phase: "final", amount: 70, status: "confirmed", provider: "test_payment" },
      ],
    }), "paid"],
    [order({
      status: "delivered",
      ...CONFIRMED_DEPOSIT,
      finalPaid: 70,
      finalFinanceStatus: "confirmed",
      deliveryRecord: { method: "manual", deliveredAt: "2026-09-20T13:00:00.000Z" },
      deliveredAt: "2026-09-20T13:00:00.000Z",
      paymentRecords: [
        ...CONFIRMED_DEPOSIT.paymentRecords,
        { id: "final-2", phase: "final", amount: 70, status: "confirmed", provider: "test_payment" },
      ],
    }), "delivered"],
  ];

  for (const [fixture, expected] of rows) {
    assert.equal(workflow.businessStatusForOrder(fixture), expected, expected);
    assert.equal(workflow.publicOrderProjection(fixture).businessStatus, expected, expected);
  }
});

test("offline selection is required before final payment, and delivery files stay private until payment", () => {
  const beforeSelection = workflow.publicOrderProjection(order({
    status: "final_pending",
    ...CONFIRMED_DEPOSIT,
    shootingCompletedAt: "2026-09-20T10:00:00.000Z",
    selectionStatus: "pending",
  }));
  assert.equal(beforeSelection.businessStatus, "awaiting_photographer");
  assert.equal(beforeSelection.canPayFinal, false);

  const selected = workflow.publicOrderProjection(order({
    status: "final_pending",
    ...CONFIRMED_DEPOSIT,
    shootingCompletedAt: "2026-09-20T10:00:00.000Z",
    selectionStatus: "confirmed",
    selectionConfirmedAt: "2026-09-20T12:00:00.000Z",
    deliveryRecord: { method: "manual", deliveredAt: "2026-09-20T12:30:00.000Z" },
    deliveredAt: "2026-09-20T12:30:00.000Z",
    deliverFiles: [{ id: "private-draft", name: "draft.jpg" }],
  }));
  assert.equal(selected.businessStatus, "shot");
  assert.equal(selected.canPayFinal, true);
  assert.deepEqual(selected.deliverFiles, [], "unpaid delivery files must remain private");
});

test("deposit refund eligibility is permanently closed by effective dispatch", () => {
  assert.equal(workflow.isDepositRefundable(order()), true);
  assert.equal(workflow.isDepositRefundable(order({
    photographerId: "photo-1",
    dispatchRecord: { id: "dispatch-1", next: { photographerId: "photo-1" } },
  })), false);
  assert.equal(workflow.isDepositRefundable(order({
    photographerId: "",
    dispatchRecord: null,
    depositRefundable: false,
  })), false);
});

test("a final payment cannot turn an order into paid without offline selection", () => {
  const illegal = order({
    status: "paid",
    ...CONFIRMED_DEPOSIT,
    finalPaid: 70,
    finalFinanceStatus: "confirmed",
    paymentRecords: [
      ...CONFIRMED_DEPOSIT.paymentRecords,
      { id: "final-illegal", phase: "final", amount: 70, status: "confirmed", provider: "test_payment" },
    ],
  });
  const businessStatus = workflow.businessStatusForOrder(illegal);
  assert.notEqual(businessStatus, "paid");
  assert.notEqual(businessStatus, "delivered");
});
