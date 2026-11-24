"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { isDeepStrictEqual } = require("node:util");
const rpc = require("../lib/rpc.cjs");
const createApi = require("../lib/api.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const schema = require("../lib/mysqlSchema.cjs");
const { createSvcMemoryStore } = require("../lib/svcStore.cjs");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const { createTestWechatPay, createTestRefundGateway } = require("./helpers/wechatPay.cjs");

const owner = { identity: { kind: "public", openid: "arrival-owner" } };
const staff = { kind: "admin", role: "service", authzUserId: "service-account" };
const manager = { ...staff, role: "super" };
function fixture(patch = {}) {
  const order = { id: "arrival", orderNo: "ARRIVAL-1", order_no: "ARRIVAL-1", openid: owner.identity.openid,
    customer_openid: owner.identity.openid, status: "assigned", workflowStage: "awaiting_shoot", service_status: "confirmed",
    photographerId: "photo", photo_id: "photo", category: "photo", dispatchStatus: "accepted", svc_paid_processed: 1,
    schedule_time: "2026-12-20 10:00:00", appointmentAt: "2026-12-20 10:00:00", assignee_id: "service",
    totalAmount: 100, depositDue: 30, finalDue: 70, depositPaid: 30, depositFinanceStatus: "confirmed",
    paid_at: "2026-11-15 10:00:00", paymentRecords: [], statusLogs: [], followRecords: [], ...patch };
  const store = createSvcMemoryStore({ orders: [order], afterSales: [], logs: [],
    staff: [{ id: "service", account: "service-account", account_id: "service-account", role: "service", status: "active", staff_status: "active" }, { id: "super", account: "super", role: "super", status: "active" }] });
  const source = {
    async list(key) { return structuredClone(store.snapshot()[key] || []); },
    async get(key, id) { return (await this.list(key)).find(row => row.id === id) || null; },
    create: (key, row) => store.transaction(state => { state[key] ||= []; const value = { id: `row-${state[key].length}`, ...structuredClone(row) }; state[key].push(value); return value; }),
    update: (key, id, patch) => store.transaction(state => { const row = state[key].find(row => row.id === id); return row ? Object.assign(row, structuredClone(patch)) : null; }),
    remove: (key, id) => store.transaction(state => { const before = state[key].length; state[key] = state[key].filter(row => row.id !== id); return before !== state[key].length; }),
    compareAndUpdate: (key, id, expected, patch) => store.transaction(state => {
      const row = state[key].find(row => row.id === id);
      if (!row || Object.entries(expected).some(([field, value]) => !isDeepStrictEqual(row[field], value))) return null;
      return Object.assign(row, structuredClone(patch));
    }),
  };
  const app = createSvcWorkbench({ store, benefit: {}, clock: () => "2026-11-15 20:00:00" });
  return { source, store, app, arrive: (data = {}, context = owner) => rpc(source, "confirmOrderArrival", { data: { orderId: order.id, ...data } }, context) };
}

async function api(t, source) {
  const sessions = { owner: { kind: "public", openid: owner.identity.openid }, other: { kind: "public", openid: "other" },
    admin: { kind: "admin", role: "super", subjectId: "super", account: "super" },
    service: { kind: "admin", role: "service", subjectId: "service", account: "service-account" } };
  const auth = { async init() {}, async getSession(token) { return sessions[token] || null; } };
  const handler = createApi(source, "json", { auth, permissionStore: null, sourceStatus: { ready: true } });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (token, pathname, data) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
}

test("arrival requires an authenticated owner at both RPC and HTTP boundaries", async t => {
  const f = fixture(), post = await api(t, f.source);
  for (const identity of [{}, { identity: { kind: "admin", openid: owner.identity.openid } }, { identity: { kind: "public", openid: "other" } }]) {
    assert.equal((await f.arrive({ openid: owner.identity.openid }, identity)).success, false);
  }
  for (const token of ["", "other", "admin"]) {
    const response = await post(token, "/api/rpc/confirmOrderArrival", { data: { orderId: "arrival", openid: owner.identity.openid } });
    assert.equal(response.status === 401 || response.body.success === false, true, JSON.stringify(response));
  }
  assert.equal(f.store.snapshot().orders[0].customerArrivedAt, undefined);
  const response = await post("owner", "/api/rpc/confirmOrderArrival", { data: { orderId: "arrival" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true, JSON.stringify(response));
});

test("arrival atomically advances both views and logs a self-report without claiming shooting or payment completion", async () => {
  const f = fixture(), before = f.store.snapshot().orders[0];
  assert.equal(workflow.publicOrderProjection(before).canConfirmArrival, true);
  const results = await Promise.all(Array.from({ length: 16 }, () => f.arrive({ customerArrivedAt: "forged-client-time", status: "completed" })));
  for (const result of results) {
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.id, "arrival");
    assert.equal(result.data.businessStatus, "shooting");
    assert.equal(result.data.canConfirmArrival, false);
    assert.equal(result.data.canPayFinal, true);
    assert.equal(result.data.canConfirmCompletion, false);
    assert.ok(Number.isFinite(Date.parse(result.data.customerArrivedAt)));
    assert.equal(result.data.customerArrivedBy, undefined);
    assert.doesNotMatch(JSON.stringify(result.data), /arrival-owner|forged-client-time/);
  }
  const saved = f.store.snapshot().orders[0];
  assert.equal(saved.status, "shooting");
  assert.equal(saved.workflowStage, "shooting");
  assert.equal(saved.service_status, "shooting");
  assert.equal(saved.customerArrivedBy, owner.identity.openid);
  assert.equal(saved.shootingStartedAt, undefined);
  assert.equal(saved.shootingCompletedAt, undefined);
  assert.equal(saved.completedAt, undefined);
  assert.equal(saved.statusLogs.length, 1);
  assert.equal(saved.followRecords.length, 1);
  assert.equal(saved.statusLogs[0].source, "customer_self_report");
  assert.equal(results[0].data.statusTimeline[0].action, "游客确认到达点位");
  for (const field of ["totalAmount", "depositPaid", "finalDue", "paymentRecords"]) assert.deepEqual(saved[field], before[field]);
  assert.deepEqual(f.store.snapshot().ledger, []);
  assert.deepEqual(f.store.snapshot().bindings, []);
  assert.deepEqual(f.store.snapshot().notifications, []);
  const intent = await rpc(f.source, "createPayment", { data: { orderId: "arrival", phase: "final", selectionAccepted: true, idempotencyKey: "arrival-premature-payment" } }, { ...owner, wechatPay: createTestWechatPay() });
  assert.equal(intent.success, true, JSON.stringify(intent));
  assert.equal(f.store.snapshot().orders[0].paymentRecords[0].status, "pending");
  assert.equal(f.store.snapshot().orders[0].shootingCompletedAt, undefined);
  const detail = await f.app.execute("GET", "/api/kf/orders/ARRIVAL-1", {}, staff);
  assert.equal(detail.customerArrivedAt, saved.customerArrivedAt);
  assert.equal(detail.shootingStartedAt, undefined);
  assert.equal(detail.timeline.filter(row => row.action === "customer_arrival").length, 1);
  assert.equal(detail.timeline.find(row => row.action === "customer_arrival").operator, owner.identity.openid);
});

test("arrival permits final payment immediately and only a verified successful receipt completes service once", async t => {
  const f = fixture();
  const service = require("../lib/customerService.cjs").serviceFor(f.source, { store: f.store, benefit: {} }).workbench;
  t.after(() => require("../lib/wechatPay.cjs").drainMerchantShare(f.source));
  await f.arrive();
  const create = key => rpc(f.source, "createPayment", { data: { orderId: "arrival", phase: "final", selectionAccepted: true, idempotencyKey: key } }, { ...owner, wechatPay: createTestWechatPay() });
  assert.equal((await create("arrival-final-failed-0001")).success, true);
  const gateway = createTestRefundGateway(f.source);
  const transaction = record => ({ appid: "wx1234567890abcdef", mchid: "1900000109", outTradeNo: record.outTradeNo,
    transactionId: "arrival-verified-final", tradeState: "SUCCESS", tradeType: "JSAPI", payerOpenid: owner.identity.openid,
    amountTotal: 7000, amountCurrency: "CNY" });
  let row = f.store.snapshot().orders[0];
  assert.equal(row.shootingCompletedAt, undefined);
  assert.equal(row.completedAt, undefined);
  await gateway.confirmTransaction(f.source, { ...transaction(row.paymentRecords[0]), tradeState: "PAYERROR" });
  row = f.store.snapshot().orders[0];
  assert.equal(row.service_status, "shooting");
  assert.equal(row.completedAt, undefined);
  assert.equal(workflow.publicOrderProjection(row).canPayFinal, true);
  assert.equal((await create("arrival-final-success-0002")).success, true);
  row = f.store.snapshot().orders[0];
  const success = transaction(row.paymentRecords.at(-1));
  await gateway.confirmTransaction(f.source, success);
  await gateway.confirmTransaction(f.source, success);
  row = f.store.snapshot().orders[0];
  assert.equal(row.status, "completed");
  assert.equal(row.service_status, "done");
  assert.equal(row.finalPaid, 70);
  assert.ok(row.shootingCompletedAt);
  assert.ok(row.completedAt);
  assert.equal(row.shootingStartedAt, undefined);
  assert.equal(workflow.publicOrderProjection(row).canPayFinal, false);
  assert.equal((await service.execute("GET", "/api/kf/orders/ARRIVAL-1", {}, staff)).service_status, "done");
  assert.equal(f.store.snapshot().operationLogs.filter(row => row.action === "order_complete").length, 1);
  assert.equal(f.store.snapshot().bindings.length, 1);
});

test("zero-balance arrival requires customer acknowledgement and preserves payment and after-sale guards", async t => {
  const f = fixture({ totalAmount: 30, finalDue: 0 });
  require("../lib/customerService.cjs").serviceFor(f.source, { store: f.store, benefit: {} });
  t.after(() => require("../lib/wechatPay.cjs").drainMerchantShare(f.source));
  const arrived = await f.arrive();
  assert.equal(arrived.data.canConfirmCompletion, true);
  assert.equal(arrived.data.shootingCompleted, false);
  assert.equal(arrived.data.businessStatus, "shooting");
  const data = { orderId: "arrival", phase: "final", idempotencyKey: "arrival-zero-confirm-0001" };
  assert.equal((await rpc(f.source, "createPayment", { data }, owner)).success, false);
  for (const patch of [{ riskBlocked: true }, { frozen: true }, { depositPaid: 0 }, { afterSaleStatus: "pending" }]) {
    const blocked = fixture({ totalAmount: 30, finalDue: 0 });
    await blocked.arrive();
    await blocked.source.update("orders", "arrival", patch);
    assert.equal(workflow.publicOrderProjection(blocked.store.snapshot().orders[0]).canConfirmCompletion, false, JSON.stringify(patch));
    assert.equal((await rpc(blocked.source, "createPayment", { data: { ...data, selectionAccepted: true } }, owner)).success, false, JSON.stringify(patch));
    assert.equal(blocked.store.snapshot().orders[0].completedAt, undefined);
  }
  await f.source.create("afterSales", { orderId: "arrival", status: "pending" });
  assert.equal((await rpc(f.source, "createPayment", { data: { ...data, selectionAccepted: true } }, owner)).success, false);
  await f.store.transaction(state => { state.afterSales = []; });
  const done = await rpc(f.source, "createPayment", { data: { ...data, selectionAccepted: true } }, owner);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.data.invokeWeChatPay, false);
  assert.equal(f.store.snapshot().orders[0].service_status, "done");
  assert.ok(f.store.snapshot().orders[0].shootingCompletedAt);
  assert.equal(f.store.snapshot().orders[0].finalPaid, 0);
});

test("only arranging the photographer schedules the customer order and service roles cannot manually advance shooting", async t => {
  const f = fixture({ photographerId: "", photo_id: "", status: "deposit_paid", workflowStage: "awaiting_dispatch", service_status: "claimed" });
  await f.store.transaction(state => { state.photographers = [{ id: "photo", status: "active" }]; });
  await f.app.execute("POST", "/api/kf/orders/ARRIVAL-1/slot/confirm", { expected_status: "claimed", new_time: "2026-12-20 10:00:00" }, staff);
  assert.equal(workflow.publicOrderProjection(f.store.snapshot().orders[0]).businessStatus, "reserved");
  await f.app.execute("POST", "/api/kf/orders/ARRIVAL-1/assign", { expected_status: "confirmed", to_photo: "photo", reason: "摄影师已确认档期", channel: "phone" }, staff);
  assert.equal(workflow.publicOrderProjection(f.store.snapshot().orders[0]).businessStatus, "awaiting_shoot");
  for (const role of ["service", "supervisor", "service_supervisor"]) {
    for (const action of ["start", "finish"]) await assert.rejects(f.app.execute("POST", `/api/kf/orders/ARRIVAL-1/shoot/${action}`, { expected_status: "confirmed" }, { ...staff, role }), { code: 403 });
  }
  const post = await api(t, f.source);
  for (const action of ["start", "shootcomplete"]) {
    const result = await post("service", "/api/orders/arrival/action", { action, reason: "尝试人工修改状态" });
    assert.equal(result.status, 403, JSON.stringify(result));
  }
  assert.equal((await f.arrive()).success, true);
  assert.equal(workflow.publicOrderProjection(f.store.snapshot().orders[0]).canPayFinal, true);
});

test("arrival rejects absent assignment, unpaid, terminal, frozen and active after-sale orders", async () => {
  const patches = [
    { photographerId: "", photo_id: "" }, { dispatchStatus: "pending_reassignment" },
    { depositPaid: 0, depositFinanceStatus: "pending" }, { status: "cancelled" }, { completedAt: "2026-11-15T00:00:00Z" },
    { shootingCompletedAt: "2026-11-15T00:00:00Z" }, { paymentReviewRequired: true }, { category: "peripheral" },
    { riskBlocked: true }, { riskFlag: "review" }, { frozen: true }, { freezeReason: "review" }, { riskReason: "review" }, { afterSaleStatus: "pending" },
    { taskStatus: "unable" }, { afterSales: [{ status: "pending" }] },
  ];
  for (const patch of patches) {
    const f = fixture(patch), before = f.store.snapshot();
    assert.equal(workflow.publicOrderProjection(before.orders[0]).canConfirmArrival, false, JSON.stringify(patch));
    assert.equal((await f.arrive()).success, false, JSON.stringify(patch));
    assert.deepEqual(f.store.snapshot(), before);
  }
  const f = fixture();
  await f.source.create("afterSales", { id: "ticket", orderId: "arrival", status: "pending" });
  assert.equal((await rpc(f.source, "getOrderDetail", { data: { orderId: "arrival" } }, owner)).data.canConfirmArrival, false);
  assert.equal((await f.arrive()).success, false);
  const list = f.source.list;
  f.source.list = async key => { if (key === "afterSales") throw new Error("offline"); return list.call(f.source, key); };
  assert.equal((await rpc(f.source, "getOrderDetail", { data: { orderId: "arrival" } }, owner)).data.canConfirmArrival, false);
  assert.equal((await f.arrive()).success, false);
});

test("arrival CAS revalidates another server's cancellation, freeze, after-sale or photographer change", async () => {
  for (const patch of [{ status: "cancelled" }, { frozen: true }, { afterSaleStatus: "pending" }, { photographerId: "", photo_id: "" }]) {
    const f = fixture(), compare = f.source.compareAndUpdate;
    let first = true;
    f.source.compareAndUpdate = async (...args) => {
      if (first) { first = false; await f.source.update("orders", "arrival", patch); }
      return compare(...args);
    };
    assert.equal((await f.arrive()).success, false, JSON.stringify(patch));
    const saved = f.store.snapshot().orders[0];
    assert.equal(saved.customerArrivedAt, undefined);
    for (const [field, value] of Object.entries(patch)) assert.deepEqual(saved[field], value);
    assert.deepEqual(saved.statusLogs, []);
  }
});

test("arrival and staff actual start commute, including a CAS retry across processes", async () => {
  for (const arrivalFirst of [true, false]) {
    const f = fixture();
    const start = () => f.app.execute("POST", "/api/kf/orders/ARRIVAL-1/shoot/start", { expected_status: "confirmed" }, manager);
    const result = arrivalFirst ? await Promise.all([f.arrive(), start()]) : await Promise.all([start(), f.arrive()]);
    assert.equal(result[arrivalFirst ? 0 : 1].success, true);
    const saved = f.store.snapshot().orders[0];
    assert.ok(saved.customerArrivedAt);
    assert.equal(saved.shootingStartedAt, "2026-11-15 20:00:00");
    assert.equal(saved.service_status, "shooting");
    assert.equal(f.store.snapshot().operationLogs.filter(row => row.action === "shoot_start").length, 1);
    assert.equal((await start()).idempotent, true);
    const finished = await f.app.execute("POST", "/api/kf/orders/ARRIVAL-1/shoot/finish", { expected_status: "shooting" }, manager);
    assert.equal(finished.service_status, "final_pending");
    assert.equal(workflow.publicOrderProjection(f.store.snapshot().orders[0]).canPayFinal, true);
  }
  const f = fixture(), compare = f.source.compareAndUpdate;
  let first = true;
  f.source.compareAndUpdate = async (...args) => {
    if (first) { first = false; await f.source.update("orders", "arrival", { status: "shooting", service_status: "shooting", shootingStartedAt: "2026-11-15 19:00:00" }); }
    return compare(...args);
  };
  assert.equal((await f.arrive()).success, true);
  assert.equal(f.store.snapshot().orders[0].shootingStartedAt, "2026-11-15 19:00:00");
});

test("ordinary admin can register actual start or shooting completion after visitor arrival", async t => {
  for (const explicitStart of [true, false]) {
    const f = fixture({ svc_paid_processed: 0 }), post = await api(t, f.source);
    assert.equal((await f.arrive()).success, true);
    if (explicitStart) {
      const start = await post("admin", "/api/orders/arrival/action", { action: "start", reason: "客服确认实际开拍" });
      assert.equal(start.status, 200, JSON.stringify(start));
      assert.ok(f.store.snapshot().orders[0].shootingStartedAt);
    }
    const finish = await post("admin", "/api/orders/arrival/action", { action: "shootcomplete", reason: "客服确认本次拍摄完成" });
    assert.equal(finish.status, 200, JSON.stringify(finish));
    assert.equal(workflow.publicOrderProjection(f.store.snapshot().orders[0]).canPayFinal, true);
  }
});

test("arrival retries preserve later terminal and frozen facts and typed storage round-trips the audit", async () => {
  const f = fixture(); await f.arrive();
  const first = f.store.snapshot().orders[0].customerArrivedAt;
  for (const patch of [{ frozen: true }, { status: "completed", completedAt: "2026-11-15T13:00:00Z", service_status: "done" }, { status: "cancelled", service_status: "canceled" }]) {
    await f.source.update("orders", "arrival", patch);
    const before = f.store.snapshot(), result = await f.arrive();
    assert.equal(result.success, true);
    assert.equal(result.idempotent, true);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(result.data.customerArrivedAt, first);
    assert.equal(result.data.businessStatus, workflow.businessStatusForOrder(before.orders[0]));
  }
  const saved = f.store.snapshot().orders[0], split = schema.splitDocument("orders", saved);
  assert.equal(split.columns.customerArrivedAt, undefined);
  const restored = schema.hydrateDocument("orders", { id: saved.id, ...split.columns }, { ...split.relations, collection_values: split.attributes });
  assert.equal(restored.customerArrivedAt, first);
  assert.equal(restored.customerArrivedBy, owner.identity.openid);
  assert.equal(restored.statusLogs[0].operatorId, owner.identity.openid);
});

test("service status labels and old and new Chinese filters share stable codes", async () => {
  const f = fixture();
  for (const label of ["待拍摄", "已定档", "awaiting_shoot"]) {
    const result = await rpc(f.source, "getMyOrders", { data: { businessStatus: label } }, owner);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].statusText, "已定档");
  }
  await f.source.update("orders", "arrival", { photographerId: "", photo_id: "" });
  for (const label of ["待确认", "已预约", "reserved"]) {
    const result = await rpc(f.source, "getMyOrders", { data: { businessStatus: label } }, owner);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].statusText, "已预约");
  }
});

test("after-sale association and its audit rollback preserve an arrival committed by another server", async () => {
  for (const phase of ["ticket", "cas"]) for (const failAudit of [false, true]) {
    const f = fixture(), create = f.source.create, compare = f.source.compareAndUpdate;
    let injected = false, rollbackInjected = false;
    // Another process can already have read the pre-ticket snapshot. Commit
    // its valid CAS directly to avoid sharing this process's order mutex.
    const commitArrival = async () => {
      injected = true;
      const current = await f.source.get("orders", "arrival"), at = "2026-11-15T13:00:00Z";
      const event = { type: "游客到达", action: "游客确认到达点位", operator: "customer", operatorId: owner.identity.openid, source: "customer_self_report", from: "assigned", to: "shooting", createTime: at };
      assert.ok(await compare("orders", "arrival", current, { customerArrivedAt: at, customerArrivedBy: owner.identity.openid,
        status: "shooting", workflowStage: "shooting", service_status: "shooting", statusLogs: [...current.statusLogs, event], followRecords: [...current.followRecords, event] }));
    };
    f.source.create = async (key, row) => {
      if (key === "logs" && failAudit) {
        // A later unrelated writer must survive the local association rollback.
        const current = await f.source.get("orders", "arrival"), note = { id: "concurrent-note", action: "客服追加备注" };
        await f.source.update("orders", "arrival", { statusLogs: [...current.statusLogs, note], followRecords: [...current.followRecords, note] });
        throw new Error("audit unavailable");
      }
      const saved = await create(key, row);
      if (key === "afterSales" && phase === "ticket") await commitArrival();
      return saved;
    };
    f.source.compareAndUpdate = async (key, id, expected, patch) => {
      if (key === "orders" && patch.afterSaleId && phase === "cas" && !injected) await commitArrival();
      if (key === "orders" && patch.afterSaleId === null && failAudit && !rollbackInjected) {
        rollbackInjected = true;
        const current = await f.source.get("orders", "arrival"), note = { id: "rollback-note", action: "回滚期间客服追加备注" };
        await f.source.update("orders", "arrival", { statusLogs: [...current.statusLogs, note], followRecords: [...current.followRecords, note] });
      }
      return compare(key, id, expected, patch);
    };
    const response = await rpc(f.source, "submitAfterSale", { data: { orderId: "arrival", type: "投诉反馈", reason: "希望调整本次拍摄安排" } }, owner);
    assert.equal(response.success, !failAudit, JSON.stringify({ phase, response }));
    const saved = f.store.snapshot().orders[0];
    assert.ok(saved.customerArrivedAt, phase);
    assert.equal(saved.status, "shooting");
    assert.equal(saved.service_status, "shooting");
    for (const field of ["statusLogs", "followRecords"]) {
      assert.equal(saved[field].filter(row => row.source === "customer_self_report").length, 1, `${phase}/${failAudit}/${field}`);
      assert.equal(saved[field].some(row => row.action === "客户提交售后申请" || row.type === "afterSale"), !failAudit);
      if (failAudit) assert.equal(saved[field].filter(row => row.id === "concurrent-note").length, 1);
      if (failAudit) assert.equal(saved[field].filter(row => row.id === "rollback-note").length, 1);
    }
    assert.equal(f.store.snapshot().afterSales.length, failAudit ? 0 : 1);
    if (failAudit) assert.equal(saved.afterSaleId, null);
    else assert.equal(saved.afterSaleId, response.data.ticketId);
  }
});
