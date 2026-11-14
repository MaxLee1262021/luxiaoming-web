"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createShareService, serviceFor, enqueuePaidOrder, recordOrderRefund, canShare, qrScene, safeCsv } = require("../lib/merchantShare.cjs");

test("merchant projection uses session ownership and never exposes customer evidence or full order numbers", async () => {
  const selected = []; const raw = { detailNo: "SHR1", orderNo: "ORDER-12345678", customer: "PRIVATE_CUSTOMER", openid: "PRIVATE_OPENID", phone: "13800138000", paymentRecords: [{ private: true }],
    display: { orderNo: "ORDER-12345678", customer: "PRIVATE_CUSTOMER", productName: "PRIVATE_GOODS", paidAmount: "100.00" },
    splitType: "T1", ratio: "0.0500", direction: 1, amount: "5.00", period: "2026-11" };
  const store = {
    getMerchant: async merchantId => ({ merchantId, name: "门店", phone: "13900139000", bankAccount: "PRIVATE_BANK" }),
    getRules: async () => [{ ratioT1: "0.0500", ratioT2: "0.0300", ttlHours: 720, refundWindowDays: 3, operatorId: "PRIVATE_OPERATOR" }],
    listDetails: async filter => { selected.push(filter); return { list: [raw], total: 1, sum: { netAmount: "5.00" } }; },
    getMerchantStats: async () => ({ boundUsers: 4, accT1Amount: "5.00", monthOrders: 1, userIds: ["PRIVATE_UID"] }),
  };
  const service = createShareService({}, { store, clock: () => new Date("2026-11-06T00:00:00Z") });
  const result = await service.mine({ merchantId: "another-store" }, { kind: "admin", role: "merchant", shopId: "owned-store" });
  assert.equal(selected[0].merchantId, "owned-store"); assert.equal(result.merchant.merchantId, "owned-store");
  assert.equal(result.list[0].orderNo, "****5678");
  const serialized = JSON.stringify(result);
  for (const secret of ["PRIVATE_CUSTOMER", "PRIVATE_OPENID", "13800138000", "PRIVATE_BANK", "PRIVATE_OPERATOR", "PRIVATE_UID", "ORDER-12345678", "PRIVATE_GOODS"]) assert.equal(serialized.includes(secret), false);
  assert.equal(Object.hasOwn(result.list[0], "openid"), false);
  await assert.rejects(service.listDetails({}, { kind: "admin", role: "merchant", shopId: "owned-store" }), { code: "SHARE_4030" });
});

test("menu view permission does not imply configuration; merchant self page does not grant another workflow", () => {
  assert.equal(canShare({ kind: "admin", role: "custom", menuKeys: ["shareRules"] }, "view"), true);
  assert.equal(canShare({ kind: "admin", role: "custom", menuKeys: ["shareRules"] }, "config"), false);
  assert.equal(canShare({ kind: "admin", role: "custom", menuKeys:['shareRules'],sharePermissions: ["share:config"] }, "config"), true);
  assert.equal(canShare({ kind: "admin", role: "custom", menuKeys:[],sharePermissions: ["share:config"] }, "config"), false);
  assert.equal(canShare({ kind: "admin", role: "custom", menuKeys:[],sharePermissions: ["share:view"] }, "view"), false);
  assert.equal(canShare({ kind: "admin", role: "finance", menuKeys:['shareRules'],sharePermissions: ["share:config"] }, "config"), false);
  assert.equal(canShare({ kind: "admin", role: "custom", menuKeys:['shareRules'],sharePermissions: ["share:admin"] }, "admin"), false);
  assert.equal(canShare({ kind: "admin", role: "merchant", shopId: "m" }, "mine"), true);
  assert.equal(canShare({ kind: "admin", role: "merchant", shopId: "m" }, "view"), false);
  assert.equal(canShare({ kind: "public", role: "super" }, "config"), false);
});

test("CSV guards formula-like text including minus expressions while preserving numeric refund amounts", () => {
  for (const value of ["=1+2", "+1+2", "@SUM(1,2)", "-1+2", "-SUM(1,2)", "\t=1+2"]) assert.ok(safeCsv(value).startsWith('"\''), value);
  assert.equal(safeCsv("-12.34"), '"-12.34"'); assert.equal(safeCsv("5.00"), '"5.00"');
});

test("scan accepts only a signed real QR and trusted public identity, not caller merchant/user IDs", async () => {
  const scene = qrScene("0123456789ABCD"); let received;
  const store = { getQrByScene: async value => value === scene ? { id: "qr", merchantId: "real-store", status: "ACTIVE" } : null,
    reportScan: async input => { received = input; return { deduplicated: false }; } };
  const service = createShareService({}, { store, enableAt: "2026-11-01T00:00:00Z", clock: () => new Date("2026-11-06T00:00:00Z") });
  await service.reportScan({ kind: "public", openid: "verified-user" }, { scene, userId: "forged-user", merchantId: "forged-store", requestKey: "real-entry-1" });
  assert.equal(received.userId, "verified-user"); assert.equal(received.merchantId, "real-store"); assert.equal(received.qrId, "qr");
  assert.equal(received.requestKey, "real-entry-1"); assert.equal(received.bindEligible, true);
  await assert.rejects(service.reportScan({ kind: "public", openid: "verified-user" }, { scene: scene.slice(0, -1) + (scene.endsWith("Z") ? "Y" : "Z") }), { code: "SHARE_4002" });
  await assert.rejects(service.reportScan({ kind: "admin", role: "super" }, { scene }), { code: "SHARE_4030" });
});

test("only an issued unexpired customer-service link can supply staff identity; forged parameters remain missing", async () => {
  let received;
  const source = { transaction: async () => { throw new Error("client staff parameters must not look up trusted staff identity"); } };
  const linkId = "a".repeat(32);
  const store = {
    getCsLink: async value => value === linkId ? { linkId, staffId: "mapped-service", wecomUserId: "wecom", status: "ACTIVE", expiresAt: "2026-11-07T00:00:00Z" }
      : value === "expired" ? { linkId: value, staffId: "mapped-service", status: "ACTIVE", expiresAt: "2026-11-05T00:00:00Z" } : null,
    reportClick: async input => { received = input; return { click: { id: "c" } }; },
  };
  const service = createShareService(source, { store, enableAt: "2026-11-01T00:00:00Z", clock: () => new Date("2026-11-06T00:00:00Z") });
  await service.reportClick({ kind: "public", openid: "verified-user", id: "session" }, { linkId, staffWecomId: "wecom", staffId: "forged-service" });
  assert.equal(received.staffId, "mapped-service"); assert.equal(received.userId, "verified-user");
  for (const input of [{ staffId: "forged-service", staffWecomId: "wecom" }, { linkId: "fake", staffWecomId: "wecom" }, { linkId: "expired" }, { linkId, staffWecomId: "mismatch" }]) {
    const result = await service.reportClick({ kind: "public", openid: "verified-user" }, input);
    assert.equal(received.staffId, null); assert.ok(result.warning, "an invalid click remains an auditable missing attribution");
  }
});

test("real scans are collected before commission activation without creating attribution evidence; clicks remain gated", async () => {
  let calls = 0, scanInput;
  const service = createShareService({}, { store: { getQrByScene: async () => ({ id: "qr", merchantId: "m", status: "ACTIVE" }), reportScan: async input => { scanInput = input; return { deduplicated: false }; }, reportClick: async () => { calls++; } },
    enableAt: "2026-11-07T00:00:00Z", clock: () => new Date("2026-11-06T00:00:00Z") });
  const session = { kind: "public", openid: "u" };
  assert.equal((await service.reportScan(session, { scene: qrScene("0123456789ABCD"), bindEligible: true })).recorded, true);
  assert.equal(scanInput.bindEligible, false, "client parameters cannot enable attribution early");
  assert.equal((await service.reportClick(session, { staffWecomId: "wecom" })).recorded, false);
  assert.equal(calls, 0);
});

test("customer-service link creation uses a server token and separates request idempotency from staff selection", async () => {
  const registered = new Map(); let mappedStaff;
  const source = { transaction: async work => work({ query: async (_, params) => { mappedStaff = params[0]; return [[{ wecom_userid: "staff-wecom", staff_id: params[0] }]]; } }) };
  const store = {
    getCsLinkByRequest: async (operatorId, requestId) => registered.get(operatorId + ":" + requestId) || null,
    createCsLink: async input => { registered.set(input.operatorId + ":" + input.requestId, input); return input; },
  };
  const service = createShareService(source, { store, clock: () => new Date("2026-11-06T00:00:00Z") });
  const session = { kind: "admin", role: "service", subjectId: "service-owned", authzUserId: "operator", menuKeys:['orders'] };
  const first = await service.createCsLink({ requestId: "predictable-1", staffId: "forged-staff" }, session);
  assert.equal(mappedStaff, "operator", "the mapping uses the authenticated authz account rather than client-selected staff"); assert.match(first.linkId, /^[0-9a-f]{32}$/);
  const second = await service.createCsLink({ requestId: "predictable-2" }, session);
  assert.notEqual(first.linkId, second.linkId);
  assert.notEqual(first.linkId, require("node:crypto").createHash("sha256").update("operator:predictable-1").digest("hex").slice(0, 32));
  assert.equal((await service.createCsLink({ requestId: "predictable-1" }, session)).linkId, first.linkId);
  assert.equal(registered.size, 2); assert.match(first.path, /link_id=[0-9a-f]{32}/);
  await assert.rejects(service.createCsLink({ requestId: "x" }, { kind: "admin", role: "merchant", shopId: "m" }), { code: "SHARE_4030" });
  await assert.rejects(service.createCsLink({ requestId: "x" }, {...session,menuKeys:[]}),{code:'SHARE_4030'});
});

test("payment observer requires an online final receipt and preserves complete product names and exact whole-order paid amount", async () => {
  const captured = []; const source = {};
  serviceFor(source, { store: { enqueuePayment: async input => { captured.push(input); return { existed: false }; } }, enableAt: "2026-11-01T00:00:00Z" });
  const order = { id: "o", openid: "u", orderNo: "FULLORDER", depositPaid: "0.10", finalPaid: "0.20", finalPaidAt: "2026-11-06T00:00:00Z",
    products: [{ name: "首件".repeat(200) }, { name: "加购第二件" }], paymentRecords: [{ phase: "final", status: "confirmed", provider: "manual" }] };
  assert.equal((await enqueuePaidOrder(source, order)).reason, "ONLINE_FINAL_PAYMENT_REQUIRED");
  order.paymentRecords[0].provider = "wechat_pay";
  await enqueuePaidOrder(source, order);
  assert.equal(captured[0].paidTotal, "0.30"); assert.equal(captured[0].provider, "wechat_pay");
  assert.equal(captured[0].display.productName, order.products.map(row => row.name).join("、"));
  assert.equal(captured[0].payTime, order.finalPaidAt);
  order.finalPaid = "0.00"; order.paymentRecords[0].provider = "zero_balance";
  await enqueuePaidOrder(source, order); assert.equal(captured[1].paidTotal, "0.10");
});

test("disabling new attribution still records historical ledger refunds while an absent schema explicitly skips", async () => {
  const captured = []; let existing = { orderId: "posted" }; let databaseError = null;
  const source = {};
  const store = { getJob: async () => { if (databaseError) throw Object.assign(new Error("synthetic storage failure"), { code: databaseError }); return existing; },
    getSnapshot: async () => null, recordRefund: async input => { captured.push(input); return { existed: false }; } };
  const service = serviceFor(source, { store }); service.settings = () => ({ enabled: false });
  const input = { order: { id: "posted" }, refundNo: "refund", amount: "10.00", refundedAt: "2026-11-06T00:00:00Z" };
  await recordOrderRefund(source, input);
  assert.equal(captured.length, 1); assert.equal(captured[0].orderId, "posted");
  existing = null; assert.equal((await recordOrderRefund(source, input)).skipped, true); assert.equal(captured.length, 1);
  databaseError = "ER_NO_SUCH_TABLE"; assert.equal((await recordOrderRefund(source, input)).skipped, true);
  databaseError = "ER_ACCESS_DENIED_ERROR"; await assert.rejects(recordOrderRefund(source, input), { code: "ER_ACCESS_DENIED_ERROR" });
});
