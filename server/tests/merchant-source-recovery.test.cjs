"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");
const engine = require("../lib/shareEngine.cjs");
const { qrScene, validateScene } = require("../lib/merchantShare.cjs");
const { fixture, merchant } = require("./fixtures/shareSql.cjs");
const { parseArgs, runRecovery } = require("../../scripts/recover-merchant-order-source.cjs");

const options = { root: "/synthetic-root", orderNo: "PRIVATE-ORDER-0001", merchantId: "m1", apply: false };
const applyOptions = { ...options, apply: true, reason: "按原始扫码记录核对并补正", operatorId: "synthetic-operator", requestKey: "source-repair-20261115" };
const scene1 = qrScene("0123456789ABCD"), scene2 = qrScene("ABCDEF01234567");

async function ready({ scan = true, scanAt = "2026-11-01T00:30:00Z" } = {}) {
  const f = fixture(), store = f.newStore();
  await store.ensureSchema();
  for (const [id, scene] of [["m1", scene1], ["m2", scene2]]) await store.onboardMerchant(merchant(id, { qr: { id: "qr-" + id, scene, imageUrl: "https://example.test/qr.png" } }));
  if (scan) {
    f.setTime(scanAt);
    await store.reportScan({ userId: "PRIVATE_USER", qrId: "qr-m1", bindEligible: false });
  }
  const collections = {
    orders: [{ id: "target", orderNo: options.orderNo, openid: "PRIVATE_USER", phone: "13899998888", customer: "PRIVATE_CUSTOMER", bookingId: "booking",
      createTime: "2026-11-01T04:00:00Z", source: { sourceType: "direct", shopId: "", scene: "" }, sourceType: "direct", sourceChannel: "direct", shopId: "", sourceCodeId: "", scene: "",
      depositPaid: "100.00", finalPaid: "400.00", finalPaidAt: "2026-11-01T03:00:00Z", status: "completed", statusLogs: [],
      paymentRecords: [{ id: "final", phase: "final", status: "confirmed", provider: "wechat_pay", paidAt: "2026-11-01T03:00:00Z" }] },
    { id: "unrelated", orderNo: "OTHER-ORDER", openid: "OTHER_USER", sourceType: "direct" }],
    bookingRequests: [{ id: "booking", openid: "PRIVATE_USER", createTime: "2026-11-01T01:00:00Z", sourceType: "direct", source: { sourceType: "direct" } }], afterSales: []
  };
  const state = { casCalls: 0, closeCalls: 0, casHook: null };
  const source = Object.assign(f.source, {
    async list(key) { return structuredClone(collections[key] || []); },
    async get(key, id) { return structuredClone((collections[key] || []).find(row => row.id === id) || null); },
    async compareAndUpdate(key, id, expected, patch) {
      state.casCalls++;
      if (state.casHook) await state.casHook();
      const row = (collections[key] || []).find(row => row.id === id);
      if (!row || !Object.entries(expected).every(([field, value]) => isDeepStrictEqual(row[field], value))) return null;
      Object.assign(row, structuredClone(patch));
      return structuredClone(row);
    },
    async close() { state.closeCalls++; }
  });
  f.setTime("2026-11-15T00:00:00Z");
  const runtime = { source, store, engine, validateScene, settings: () => ({ enabled: false, enableAt: null, csAttrDays: 7 }), now: () => new Date("2026-11-15T00:00:00Z") };
  return { f, store, source, runtime, collections, state };
}

test("merchant source recovery defaults to dry-run and requires explicit apply audit arguments", () => {
  const args = ["--root", "/synthetic-root", "--order-no", options.orderNo, "--merchant-id", "m1"];
  assert.equal(parseArgs(args).apply, false);
  assert.throws(() => parseArgs([...args, "--apply"]), { code: "MERCHANT_SOURCE_REPAIR_AUDIT_ARGUMENTS_REQUIRED" });
  assert.equal(parseArgs([...args, "--apply", "--reason", "核对证据", "--operator-id", "operator", "--request-key", "repair-request-0001"]).apply, true);
  assert.throws(() => parseArgs([...args, "--guess-latest-scan"]), { code: "MERCHANT_SOURCE_REPAIR_ARGUMENTS_INVALID" });
});

test("dry-run reads original booking-time scan evidence, returns masked financial plan, and writes nothing", async () => {
  const { runtime, f, collections, state } = await ready();
  const before = structuredClone({ tables: f.tables(), collections });
  const report = await runRecovery(options, runtime);
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.dryRun, true); assert.equal(report.applied, false);
  assert.equal(report.orderNo, "****0001"); assert.equal(report.merchantName, "门店m1");
  assert.equal(report.originalAt, "2026-11-01T01:00:00.000Z");
  assert.equal(report.paidTotal, "500.00"); assert.equal(report.ratioAtPay, "0.0500");
  assert.equal(report.refundWindowDays, 3); assert.equal(report.expectedShare, "25.00");
  assert.equal(report.availableAt, "2026-11-04T03:00:00.000Z"); assert.equal(report.enabled, false);
  assert.ok(report.matchedScanId); assert.match(report.planHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_USER|13899998888|PRIVATE_CUSTOMER|PRIVATE-ORDER/);
  assert.deepEqual({ tables: f.tables(), collections }, before);
  assert.equal(state.casCalls, 0); assert.equal(state.closeCalls, 1);
});

test("a scan after booking creation cannot be used even if it predates formal-order creation", async () => {
  const { runtime, state } = await ready({ scanAt: "2026-11-01T02:00:00Z" });
  const report = await runRecovery(applyOptions, runtime);
  assert.equal(report.ok, false); assert.equal(report.code, "MERCHANT_SOURCE_REPAIR_SCAN_NOT_FOUND");
  assert.equal(state.casCalls, 0);
});

test("recovery rejects wrong-user scans and ambiguity across merchants rather than guessing the latest scan", async () => {
  const first = await ready(); first.f.tables().scan[0].user_id = "OTHER_USER";
  assert.equal((await runRecovery(options, first.runtime)).code, "MERCHANT_SOURCE_REPAIR_SCAN_NOT_FOUND");
  const second = await ready();
  second.f.setTime("2026-11-01T00:45:00Z"); await second.store.reportScan({ userId: "PRIVATE_USER", qrId: "qr-m2", bindEligible: false });
  const ambiguous = await runRecovery(applyOptions, second.runtime);
  assert.equal(ambiguous.code, "MERCHANT_SOURCE_REPAIR_SCAN_AMBIGUOUS"); assert.equal(second.state.casCalls, 0);
});

test("historical QR issuance, scene and disable times must corroborate the source at checkout", async () => {
  for (const change of [
    { created_at: "2026-11-01 00:40:00.000" },
    { status: "DISABLED", disabled_at: "2026-11-01 00:50:00.000" },
    { scene: scene2 },
    { status: "DISABLED", disabled_at: null }
  ]) {
    const f = await ready(); Object.assign(f.f.tables().qr[0], change);
    assert.equal((await runRecovery(applyOptions, f.runtime)).code, "MERCHANT_SOURCE_REPAIR_SCAN_NOT_FOUND");
    assert.equal(f.state.casCalls, 0);
  }
});

test("conflicting source and existing accounting facts block fresh repairs", async () => {
  const conflict = await ready(); conflict.collections.orders[0].shopId = "m2";
  assert.equal((await runRecovery(applyOptions, conflict.runtime)).code, "MERCHANT_SOURCE_REPAIR_SOURCE_CONFLICT");
  const accounting = await ready();
  await accounting.store.enqueuePayment({ orderId: "target", userId: "PRIVATE_USER", payTime: "2026-11-01T03:00:00Z", paidTotal: "500.00" });
  assert.equal((await runRecovery(applyOptions, accounting.runtime)).code, "MERCHANT_SOURCE_REPAIR_ACCOUNTING_EXISTS");
  assert.equal(accounting.state.casCalls, 0);
});

test("apply atomically freezes only the chosen order's source and appends audit, while replay is idempotent", async () => {
  const { runtime, collections, f, state } = await ready();
  const other = structuredClone(collections.orders[1]), scans = structuredClone(f.tables().scan), bindings = structuredClone(f.tables().binding);
  const oldEnv = process.env.SHARE_ENABLE_AT;
  const result = await runRecovery(applyOptions, runtime);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.applied, true);
  const order = collections.orders[0];
  assert.equal(order.shopId, "m1"); assert.equal(order.sourceType, "merchant_qrcode");
  assert.equal(order.sourceName, "门店m1"); assert.equal(order.sourceCodeId, "qr-m1");
  assert.equal(order.source.scene, scene1); assert.equal(order.source.validatedAt, "2026-11-01T01:00:00.000Z");
  assert.notEqual(order.source.validatedAt, result.scanAt, "scan time is not fabricated as original server validation time");
  assert.equal(order.source.repairScanId, result.matchedScanId); assert.equal(order.shareEnqueuePending, true);
  assert.equal(order.statusLogs.length, 1); assert.equal(order.statusLogs[0].requestKey, applyOptions.requestKey);
  assert.equal(f.tables().audit.filter(row => row.action.startsWith("ORDER_SOURCE_REPAIR_")).length, 2);
  assert.equal(f.tables().job.length, 0); assert.equal(f.tables().snapshot.length, 0); assert.equal(f.tables().detail.length, 0);
  assert.deepEqual(collections.orders[1], other); assert.deepEqual(f.tables().scan, scans); assert.deepEqual(f.tables().binding, bindings);
  assert.equal(process.env.SHARE_ENABLE_AT, oldEnv);
  const again = await runRecovery(applyOptions, runtime);
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.alreadyRepaired, true); assert.equal(again.applied, false);
  assert.equal(state.casCalls, 1); assert.equal(order.statusLogs.length, 1);
  assert.equal(f.tables().audit.filter(row => row.action.startsWith("ORDER_SOURCE_REPAIR_")).length, 2);
});

test("CAS rejects concurrent source edits and audit failure prevents mutation", async () => {
  const raced = await ready();
  raced.state.casHook = () => { raced.collections.orders[0].source = { shopId: "m2" }; };
  const conflict = await runRecovery(applyOptions, raced.runtime);
  assert.equal(conflict.code, "MERCHANT_SOURCE_REPAIR_ORDER_CHANGED"); assert.equal(conflict.applied, false);
  assert.equal(raced.collections.orders[0].source.shopId, "m2"); assert.equal(raced.collections.orders[0].sourceType, "direct");
  const failedAudit = await ready(); failedAudit.f.injectFailure("INSERT INTO `lxm_share_audit`");
  const report = await runRecovery(applyOptions, failedAudit.runtime);
  assert.equal(report.ok, false); assert.equal(failedAudit.state.casCalls, 0);
  assert.equal(failedAudit.collections.orders[0].sourceType, "direct");
});

test("refund evidence reduces the planned net commission and T2 requires its own historical review", async () => {
  const refunded = await ready();
  refunded.collections.afterSales.push({ orderId: "target", refundAttempts: [{ status: "SUCCESS", refundNo: "synthetic-refund", amountFen: 10000 }] });
  const plan = await runRecovery(options, refunded.runtime);
  assert.equal(plan.ok, true, JSON.stringify(plan)); assert.equal(plan.expectedShare, "20.00"); assert.equal(plan.refundedAmount, "100.00");
  const t2 = await ready(); t2.f.setTime("2026-11-01T02:00:00Z");
  await t2.store.reportClick({ userId: "PRIVATE_USER", staffId: "synthetic-service" });
  assert.equal((await runRecovery(applyOptions, t2.runtime)).code, "MERCHANT_SOURCE_REPAIR_T2_REVIEW_REQUIRED");
  assert.equal(t2.state.casCalls, 0);
});

test("the financial plan respects a merchant closure and reopening between checkout and payment", async () => {
  const f = await ready();
  f.f.setTime("2026-11-01T01:30:00Z"); await f.store.upsertMerchant({ merchantId: "m1", status: "CLOSED" });
  f.f.setTime("2026-11-01T02:00:00Z"); await f.store.upsertMerchant({ merchantId: "m1", status: "OPEN" });
  const plan = await runRecovery(options, f.runtime);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.orderSourceInvalidated, true); assert.equal(plan.expectedShare, "0.00");
});
