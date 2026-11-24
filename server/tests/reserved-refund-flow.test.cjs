"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sourceFactory = require("./fixtures/jsonSource.cjs");
const createApi = require("../lib/api.cjs");
const rpc = require("../lib/rpc.cjs");
const workflow = require("../lib/orderWorkflow.cjs");
const { createTestRefundGateway } = require("./helpers/wechatPay.cjs");

const owner = { kind: "public", openid: "reserved-owner" };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function order(patch = {}) {
  return {
    id: "reserved-order", orderNo: "RESERVED-REFUND", openid: owner.openid, assigneeId: "service",
    status: "deposit_paid", workflowStage: "awaiting_dispatch", totalAmount: 100,
    depositDue: 30, depositPaid: 30, depositFinanceStatus: "confirmed", finalDue: 70, finalPaid: 0,
    paymentRecords: [{ id: "deposit", provider: "wechat_pay", phase: "deposit", amount: 30,
      status: "confirmed", outTradeNo: "RESERVED_DEPOSIT", externalTransactionId: "WX_RESERVED_DEPOSIT" }],
    statusLogs: [], followRecords: [], ...patch,
  };
}
async function fixture(t, patch = {}, gatewayOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-reserved-refund-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = sourceFactory({ jsonFile: path.join(directory, "db.json") });
  await source.create("orders", order(patch));
  for (const role of ["super", "finance", "service"]) await source.create("staff", { id: role, account: role, role, status: "active" });
  const wechatPay = createTestRefundGateway(source, gatewayOptions);
  return { source, wechatPay };
}
const input = patch => ({ orderId: "reserved-order", idempotencyKey: "reserved-refund-request", reason: "行程变更申请退款", ...patch });
const request = (fixture, patch = {}, identity = owner) => rpc(fixture.source, "requestOrderRefund", { data: input(patch) }, { identity, wechatPay: fixture.wechatPay });
async function startApi(t, fixture) {
  const sessions = Object.fromEntries(["super", "finance", "service"].map(role => [`${role}-token`, {
    kind: "admin", subjectId: role, account: role, role, menuKeys: ["orders", "afterSales", "financeReview"],
  }]));
  sessions["customer-token"] = { kind: "public", openid: owner.openid };
  sessions["stranger-token"] = { kind: "public", openid: "stranger" };
  const handler = createApi(fixture.source, "json", {
    auth: { async init() {}, async getSession(token) { return clone(sessions[token]); } },
    sourceStatus: { ready: true }, permissionStore: null, wechatPay: fixture.wechatPay,
  });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (role, route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + route, {
      method,
      headers: { ...(role ? { Authorization: `Bearer ${role}-token` } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
}
async function createStaffTicket(api, patch = {}) {
  const result = await api("service", "/api/collection/afterSales", {
    orderId: "reserved-order", type: "退款申请", reason: "客服记录客人提出的服务问题", refundAmount: 20, ...patch,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
const ticketRoute = ticket => `/api/after-sales/${ticket.id || ticket._id}/action`;
const review = { action: "review", approved: true, reason: "财务核对无误通过原路退款" };
const posts = fixture => fixture.wechatPay.refundRequests.filter(row => row.method === "POST");

test("reserved refund returns all confirmed funds automatically once and remains separate from after-sales", async t => {
  const value = order();
  value.depositPaid = 35;
  value.paymentRecords.push({ ...value.paymentRecords[0], id: "extra", amount: 5, outTradeNo: "RESERVED_EXTRA", externalTransactionId: "WX_RESERVED_EXTRA" });
  const f = await fixture(t, value, { status: "PROCESSING" });
  assert.equal(workflow.publicOrderProjection(await f.source.get("orders", "reserved-order")).canApplyRefund, true);
  const replies = await Promise.all(Array.from({ length: 4 }, (_, index) => request(f, { idempotencyKey: `refund-device-${index}`, refundAmount: 1, financeStatus: "待审" })));
  for (const reply of replies) {
    assert.equal(reply.success, true, JSON.stringify(reply));
    assert.equal(reply.data.refundAmount, 35, "the server refunds received funds, not the order total or client amount");
    assert.equal(reply.data.refundStatus, "processing", "provider acceptance does not claim money arrived");
  }
  assert.equal(posts(f).length, 2, "one request per original payment despite multiple devices");
  const saved = await f.source.get("orders", "reserved-order");
  const tickets = await f.source.list("afterSales");
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.afterSaleId || "", "");
  assert.equal(saved.depositPaid, 35);
  assert.deepEqual(saved.paymentRecords, value.paymentRecords);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].reviewLane, "customer_self_cancel");
  assert.equal(tickets[0].automaticApproval, true);
  assert.equal(tickets[0].refundConfirmed, false);
  const projected = workflow.publicOrderProjection(saved, { afterSales: tickets });
  assert.equal(projected.afterSaleActive, false);
  assert.equal(projected.businessStatus, "cancelled");
  const records = await rpc(f.source, "getMyAfterSales", { data: { orderId: saved.id } }, { identity: owner });
  assert.equal(records.success, true, JSON.stringify(records));
  assert.deepEqual(records.data, []);

  for (const [key, reply] of f.wechatPay.refundReplies) f.wechatPay.refundReplies.set(key, { ...reply, status: "SUCCESS", success_time: new Date().toISOString() });
  const done = await request(f, { idempotencyKey: "another-device-refund" });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.data.refundStatus, "refunded");
  assert.equal(posts(f).length, 2, "success queries reuse the original refund numbers");
  assert.equal((await f.source.get("orders", saved.id)).onlineRefundedAmount, 35);
});

test("refund requests require the owner and paid reserved state before changing an order or contacting WeChat", async t => {
  const denied = [
    { name: "another owner", identity: { kind: "public", openid: "stranger" } },
    { name: "anonymous", identity: null },
    { name: "unpaid", patch: { status: "deposit_pending", workflowStage: "awaiting_deposit", depositPaid: 0, depositFinanceStatus: "pending", paymentRecords: [] } },
    { name: "assigned", patch: { status: "assigned", workflowStage: "awaiting_shoot", photographerId: "photo" } },
    { name: "assignment history", patch: { dispatchHistory: [{ previous: { photographerId: "photo" } }] } },
    { name: "arrived", patch: { customerArrivedAt: new Date().toISOString() } },
    { name: "shooting", patch: { shootingStartedAt: new Date().toISOString() } },
    { name: "physical", patch: { orderType: "physical" } },
    { name: "deleted", patch: { isDeleted: true } },
  ];
  for (const scenario of denied) await t.test(scenario.name, async subtest => {
    const f = await fixture(subtest, scenario.patch);
    const before = await f.source.get("orders", "reserved-order");
    const result = await request(f, {}, Object.hasOwn(scenario, "identity") ? scenario.identity : owner);
    assert.equal(result.success, false, JSON.stringify(result));
    assert.deepEqual(await f.source.get("orders", "reserved-order"), before);
    assert.deepEqual(await f.source.list("afterSales"), []);
    assert.equal(posts(f).length, 0);
  });
});

test("automatic refund ledgers cannot be read or processed as admin after-sales", async t => {
  const f = await fixture(t, {}, { status: "PROCESSING" });
  const result = await request(f);
  assert.equal(result.success, true, JSON.stringify(result));
  const ticket = (await f.source.list("afterSales"))[0];
  const api = await startApi(t, f);
  for (const role of ["super", "finance", "service"]) {
    const list = await api(role, "/api/collection/afterSales");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body, []);
    assert.equal((await api(role, `/api/collection/afterSales/${ticket.id}`)).status, 404);
    const before = await f.source.get("afterSales", ticket.id);
    const reviewed = await api(role, ticketRoute(ticket), review);
    assert.ok([403, 404, 409].includes(reviewed.status), JSON.stringify(reviewed));
    assert.deepEqual(await f.source.get("afterSales", ticket.id), before);
  }
  assert.equal(posts(f).length, 1);
});

test("authenticated HTTP refund RPC binds the owner to the session and rejects anonymous or forged-owner calls", async t => {
  const f = await fixture(t);
  const api = await startApi(t, f);
  const route = "/api/rpc/requestOrderRefund";
  const before = await f.source.get("orders", "reserved-order");
  const anonymous = await api(null, route, { data: input({ openid: owner.openid }) });
  assert.equal(anonymous.status, 401, JSON.stringify(anonymous));
  const stranger = await api("stranger", route, { data: input({ openid: owner.openid }) });
  assert.equal(stranger.status, 200, JSON.stringify(stranger));
  assert.equal(stranger.body.success, false);
  assert.deepEqual(await f.source.get("orders", "reserved-order"), before);
  assert.equal(posts(f).length, 0);
  const accepted = await api("customer", route, { data: input({ openid: "stranger", refundAmount: 9999 }) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.body.success, true, JSON.stringify(accepted));
  assert.equal(accepted.body.data.refundStatus, "refunded");
  assert.equal(accepted.body.data.refundAmount, 30);
  assert.equal(posts(f).length, 1);
  const replay = await api("customer", route, { data: input({ idempotencyKey: "http-refund-another-device" }) });
  assert.equal(replay.body.success, true, JSON.stringify(replay));
  assert.equal(posts(f).length, 1);
});

test("generic after-sale PUT cannot bypass contact, refund submission or finance review for any staff role", async t => {
  const f = await fixture(t);
  const api = await startApi(t, f);
  const ticket = await createStaffTicket(api);
  const beforeTicket = await f.source.get("afterSales", ticket.id);
  const beforeOrder = await f.source.get("orders", "reserved-order");
  for (const role of ["super", "finance", "service"]) {
    const result = await api(role, `/api/collection/afterSales/${ticket.id}`, {
      status: "已完", financeStatus: "已审", customerContactedAt: new Date().toISOString(), refundConfirmed: true,
    }, "PUT");
    assert.equal(result.status, 403, JSON.stringify(result));
  }
  assert.deepEqual(await f.source.get("afterSales", ticket.id), beforeTicket);
  assert.deepEqual(await f.source.get("orders", "reserved-order"), beforeOrder);
  assert.equal(posts(f).length, 0);
});

test("service accounts can manage only their orders when SQL staff IDs differ from authentication account IDs", async t => {
  const f = await fixture(t, { assigneeId: "", assignee_id: "svc-own" });
  await f.source.create("orders", order({ id: "other-order", orderNo: "OTHER-OWNER", assignee_id: "svc-other", assigneeId: "service" }));
  await f.source.create("afterSales", { id: "other-ticket", orderId: "other-order", status: "待处", financeStatus: "未提交", refundAmount: 0 });
  const queriedAccounts = [];
  f.source.transaction = async callback => callback({
    async query(sql, params) {
      assert.match(sql, /^SELECT id FROM svc_staff WHERE account_id=\? AND staff_status='active'$/);
      queriedAccounts.push(params[0]);
      return [params[0] === "service" ? [{ id: "svc-own" }] : []];
    },
  });
  const api = await startApi(t, f);
  const list = await api("service", "/api/collection/orders");
  assert.equal(list.status, 200, JSON.stringify(list));
  assert.deepEqual(list.body.map(row => row.id), ["reserved-order"]);
  assert.equal((await api("service", "/api/collection/orders/other-order")).status, 404);
  const deniedCreate = await api("service", "/api/collection/afterSales", {
    orderId: "other-order", type: "退款申请", reason: "attempt to handle another service account's order", refundAmount: 10,
  });
  assert.equal(deniedCreate.status, 403, JSON.stringify(deniedCreate));
  const deniedFollow = await api("service", "/api/after-sales/other-ticket/action", {
    action: "follow", customerContacted: true, reason: "attempt to record contact on another account's issue",
  });
  assert.equal(deniedFollow.status, 403, JSON.stringify(deniedFollow));
  const ownTicket = await createStaffTicket(api, { assigneeId: "svc-other" });
  assert.equal((await f.source.get("afterSales", ownTicket.id)).assigneeId, "service", "ticket ownership comes from the authenticated account");
  const ownList = await api("service", "/api/collection/afterSales");
  assert.equal(ownList.status, 200, JSON.stringify(ownList));
  assert.deepEqual(ownList.body.map(row => row.id), [ownTicket.id]);
  const followed = await api("service", ticketRoute(ownTicket), { action: "follow", customerContacted: true, reason: "contacted own assigned customer about the issue" });
  assert.equal(followed.status, 200, JSON.stringify(followed));
  assert.ok((await f.source.get("afterSales", ownTicket.id)).customerContactedAt);
  assert.equal((await f.source.get("afterSales", "other-ticket")).customerContactedAt, undefined);
  assert.ok(queriedAccounts.length > 0);
  assert.ok(queriedAccounts.every(value => value === "service"));
  assert.equal(posts(f).length, 0);
});

test("staff-created issues cannot enter finance by supplying client review or contact fields", async t => {
  const f = await fixture(t);
  const api = await startApi(t, f);
  const ticket = await createStaffTicket(api, {
    financeStatus: "已审", reviewLane: "customer_self_cancel", refundConfirmed: true,
    automaticApproval: true, customerContacted: true, customerContactedAt: "2020-01-01T00:00:00Z",
  });
  const saved = await f.source.get("afterSales", ticket.id);
  assert.equal(saved.financeStatus, "未提交");
  assert.equal(saved.reviewLane, "service_exception");
  assert.equal(saved.customerContactedAt || "", "");
  assert.notEqual(saved.automaticApproval, true);
  assert.notEqual(saved.refundConfirmed, true);
  for (const role of ["finance", "super"]) {
    const result = await api(role, ticketRoute(ticket), review);
    assert.equal(result.status, 409, JSON.stringify(result));
  }
  const complete = await api("service", ticketRoute(ticket), { action: "complete", refundAmount: 20, customerContacted: true, reason: "未跟进直接提交退款" });
  assert.equal(complete.status, 409, JSON.stringify(complete));
  assert.equal(posts(f).length, 0);
  assert.equal((await f.source.get("afterSales", ticket.id)).customerContactedAt || "", "");
});

test("a contact record and submitted refund are required even when legacy finance status says pending", async t => {
  const f = await fixture(t);
  const api = await startApi(t, f);
  const ticket = await createStaffTicket(api);
  await f.source.update("afterSales", ticket.id, { financeStatus: "待审", customerContactedAt: new Date().toISOString() });
  const before = await f.source.get("afterSales", ticket.id);
  const result = await api("finance", ticketRoute(ticket), review);
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.deepEqual(await f.source.get("afterSales", ticket.id), before);
  assert.equal(posts(f).length, 0);
});

test("staff follow-up records contact, submits a refund, and only finance can authorize original-route payment", async t => {
  const f = await fixture(t, {}, { status: "PROCESSING" });
  const api = await startApi(t, f);
  const ticket = await createStaffTicket(api);
  const route = ticketRoute(ticket);
  const start = Date.now();
  const contact = await api("service", route, {
    action: "follow", customerContacted: true, reason: "电话联系客人，确认服务问题和退款意愿", customerContactedAt: "2020-01-01T00:00:00Z",
  });
  assert.equal(contact.status, 200, JSON.stringify(contact));
  const contacted = await f.source.get("afterSales", ticket.id);
  assert.ok(Date.parse(contacted.customerContactedAt) >= start, "contact time comes from the server");
  assert.equal(contacted.financeStatus, "未提交");
  assert.equal(posts(f).length, 0);
  const premature = await api("finance", route, review);
  assert.equal(premature.status, 409, JSON.stringify(premature));
  const submitted = await api("service", route, { action: "complete", refundAmount: 20, refundConfirmed: true, reason: "已联系客人，提交商定退款金额供财务审核" });
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  const pending = await f.source.get("afterSales", ticket.id);
  assert.equal(pending.status, "待财务审");
  assert.equal(pending.financeStatus, "待审");
  assert.notEqual(pending.refundConfirmed, true);
  assert.equal(posts(f).length, 0, "submitting to finance never moves funds");
  const denied = await api("service", route, review);
  assert.equal(denied.status, 403, JSON.stringify(denied));
  assert.equal(posts(f).length, 0);
  const approved = await api("finance", route, review);
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal(posts(f).length, 1);
  assert.equal((await f.source.get("afterSales", ticket.id)).refundStatus, "processing");
  assert.equal((await f.source.get("afterSales", ticket.id)).refundConfirmed, false);
  const refundRequest = JSON.parse(posts(f)[0].body);
  assert.equal(refundRequest.transaction_id, "WX_RESERVED_DEPOSIT");
  assert.equal(refundRequest.amount.refund, 2000);
  for (const [key, reply] of f.wechatPay.refundReplies) f.wechatPay.refundReplies.set(key, { ...reply, status: "SUCCESS", success_time: new Date().toISOString() });
  const done = await api("finance", route, review);
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal((await f.source.get("afterSales", ticket.id)).refundConfirmed, true);
  assert.equal(posts(f).length, 1, "rechecking a refund reuses its original number");
});
