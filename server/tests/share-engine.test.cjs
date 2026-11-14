"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { judgeShare, decideAtPayment, finalizeDecision, calculateRefund, moneyToCents, formatMoney,
  validateRule, resolveRatioAt, resolveTtlAt, resolveSource, periodAt } = require("../lib/shareEngine.cjs");

const PAY = "2026-11-10T12:00:00+08:00";
function scenario(windowBits = [1, 1, 1], selfBits = [0, 0, 0]) {
  return {
    event: { orderId: "order-now", userId: "user-1", payTime: PAY, paidTotal: "500.00" },
    bindings: ["A", "B", "C"].map((merchantId, i) => ({ merchantId, userId: "user-1", status: "ACTIVE", lastScanAt: `2026-11-0${6 + i}T12:00:00+08:00`, lastScanId: String(i + 1) })),
    rules: ["A", "B", "C"].map((merchantId, i) => ({ merchantId, ratioT1: "0.0500", ratioT2: "0.0300", ttlHours: windowBits[i] ? 720 : 1,
      versionNo: 1, effectiveFrom: "2026-11-01T00:00:00+08:00", status: "ACTIVE", refundWindowDays: 3 })),
    merchants: ["A", "B", "C"].map(id => ({ id, status: "OPEN", refundWindowDays: 3 })),
    clicks: [{ id: "click-1", userId: "user-1", staffId: "staff-1", clickAt: "2026-11-10T11:00:00+08:00" }],
    selfOrders: ["A", "B", "C"].filter((_, i) => selfBits[i]).map(merchantId => ({ orderId: "self-" + merchantId, userId: "user-1", hitMerchantId: merchantId,
      splitType: "T1", paid: true, payTime: "2026-11-09T12:00:00+08:00", fullyRefunded: false })),
  };
}

// Expectations transcribed from DEV-SHR-001 section 11.1, not computed using
// the implementation's candidate-selection algorithm.
const MATRIX = [
  { window: [1, 1, 1], expected: ["C", "C", "B", "C", "A", "C", "B", "C"] },
  { window: [1, 1, 0], expected: ["B", "B", "B", "B", "A", "A", "B", "B"] },
  { window: [1, 0, 1], expected: ["C", "C", "C", "C", "A", "C", "A", "C"] },
  { window: [1, 0, 0], expected: ["A", "A", "A", "A", "A", "A", "A", "A"] },
  { window: [0, 1, 1], expected: ["C", "C", "B", "C", "C", "C", "B", "C"] },
  { window: [0, 1, 0], expected: ["B", "B", "B", "B", "B", "B", "B", "B"] },
  { window: [0, 0, 1], expected: ["C", "C", "C", "C", "C", "C", "C", "C"] },
  { window: [0, 0, 0], expected: ["0", "0", "0", "0", "0", "0", "0", "0"] },
];
for (const [group, row] of MATRIX.entries()) for (let mask = 0; mask < 8; mask++) {
  const bits = [(mask >> 2) & 1, (mask >> 1) & 1, mask & 1];
  const caseNo = group * 8 + mask + 1;
  test(`TC-T2-${String(caseNo).padStart(2, "0")}: window ${row.window.join("")} self ${bits.join("")}`, () => {
    const result = judgeShare(scenario(row.window, bits));
    assert.equal(result.hitMerchantId, row.expected[mask]);
    assert.equal(result.splitType, "T2");
    assert.equal(result.splitAmount, row.expected[mask] === "0" ? "0.00" : "15.00");
    assert.equal(result.candidateJson.candidates.length, 3);
  });
}

test("T1 persists across old scans, but a closed latest binding never revives an earlier merchant", () => {
  const input = scenario(); input.clicks = [];
  input.bindings[2].lastScanAt = "2026-11-08T12:00:00+08:00";
  input.rules.forEach(rule => rule.ttlHours = 1);
  assert.equal(judgeShare(input).hitMerchantId, "C");
  input.merchants[2].status = "CLOSED";
  assert.equal(judgeShare(input).hitMerchantId, "0");
  input.merchants[2].status = "OPEN"; input.bindings[2].status = "INACTIVE";
  assert.equal(judgeShare(input).hitMerchantId, "0");
});

test("same timestamp uses numeric scan ID; future scans and future clicks are excluded", () => {
  const input = scenario(); input.clicks = [];
  input.bindings.forEach(row => row.lastScanAt = "2026-11-09T12:00:00+08:00");
  input.bindings[0].lastScanId = "100"; input.bindings[1].lastScanId = "99"; input.bindings[2].lastScanAt = "2026-11-11T12:00:00+08:00";
  input.clicks = [{ id: "future", userId: "user-1", staffId: "staff-2", clickAt: "2026-11-10T12:00:01+08:00" }];
  const result = judgeShare(input);
  assert.equal(result.hitMerchantId, "A"); assert.equal(result.splitType, "T1");
});

test("TTL uses historical superseded scan-time rule while ratio and refund window use payment-time rule", () => {
  const input = scenario([1, 0, 0]);
  input.bindings = input.bindings.slice(0, 1); input.rules = input.rules.slice(0, 1);
  input.rules[0].status = "SUPERSEDED";
  input.rules.push({ ...input.rules[0], versionNo: 2, effectiveFrom: "2026-11-07T00:00:00+08:00", ratioT2: "0.0800", ttlHours: 1, status: "ACTIVE", refundWindowDays: 9 });
  const result = judgeShare(input);
  assert.equal(result.hitMerchantId, "A"); assert.equal(result.splitAmount, "40.00"); assert.equal(result.refundWindowDays, 9);
  assert.equal(result.candidateJson.candidates[0].ttlHours, 720);
  assert.equal(resolveRatioAt(input.rules, "A", PAY).versionNo, 2);
  assert.equal(resolveTtlAt(input.rules, "A", input.bindings[0].lastScanAt).ruleVersion, 1);
});

test("T2 includes the inclusive window endpoint and excludes fully refunded or future self orders", () => {
  const input = scenario([1, 1, 1], [1, 1, 0]);
  input.rules.forEach(rule => rule.ttlHours = 96);
  input.selfOrders[0].fullyRefunded = true;
  input.selfOrders[1].payTime = "2026-11-11T12:00:00+08:00";
  const result = judgeShare(input);
  assert.equal(result.hitMerchantId, "C");
  assert.equal(result.candidateJson.candidates.find(row => row.merchantId === "A").inWindow, true);
});

test("unmapped latest staff click means T1/missing; clicks never create a binding", () => {
  const input = scenario();
  input.clicks.push({ id: "unmapped", userId: "user-1", staffId: null, clickAt: "2026-11-10T11:30:00+08:00" });
  const result = judgeShare(input);
  assert.equal(result.splitType, "T1"); assert.equal(result.sourceFlag, "cs_link_missing");
  input.bindings = [];
  assert.equal(judgeShare(input).hitMerchantId, "0");
});

test("seven-day click window and zero-day explicit session window are respected", () => {
  const event = { userId: "u", payTime: PAY, sessionId: "same", sessionStartAt: "2026-11-10T11:00:00+08:00" };
  const click = { id: "1", userId: "u", staffId: "s", clickAt: "2026-11-03T12:00:00+08:00", sessionId: "same" };
  assert.equal(resolveSource({ event, clicks: [click] }).splitType, "T2");
  click.clickAt = "2026-11-03T11:59:59+08:00";
  assert.equal(resolveSource({ event, clicks: [click] }).splitType, "T1");
  click.clickAt = "2026-11-10T11:30:00+08:00";
  assert.equal(resolveSource({ event, clicks: [click], options: { csAttrDays: 0 } }).splitType, "T2");
  click.sessionId = "different";
  assert.equal(resolveSource({ event, clicks: [click], options: { csAttrDays: 0 } }).splitType, "T1");
});

test("candidate limit records truncation and considers the latest twenty only", () => {
  const input = scenario(); input.bindings = [];
  for (let i = 0; i < 21; i++) {
    const merchantId = "m" + i; input.merchants.push({ id: merchantId, status: "OPEN" });
    input.bindings.push({ userId: "user-1", merchantId, status: "ACTIVE", lastScanAt: "2026-11-09T12:00:00+08:00", lastScanId: String(i) });
    input.rules.push({ merchantId, ratioT1: "0.0500", ratioT2: "0.0300", ttlHours: 720, versionNo: 1, effectiveFrom: "2026-11-01T00:00:00+08:00" });
  }
  input.selfOrders = [{ userId: "user-1", hitMerchantId: "m0", orderId: "old", splitType: "T1", payTime: "2026-11-09T00:00:00+08:00" }];
  const result = judgeShare(input);
  assert.equal(result.hitMerchantId, "m20"); assert.equal(result.candidateJson.candidates.length, 20); assert.equal(result.candidateJson.truncated, true);
});

test("money is HALF_UP at cents and pending attribution is frozen until net-base accounting", () => {
  const input = scenario(); input.clicks = []; input.event.paidTotal = "0.10";
  const decision = decideAtPayment(input);
  assert.equal(finalizeDecision(decision, { paidTotal: "0.10" }).splitAmount, "0.01");
  const result = finalizeDecision(decision, { paidTotal: "500.00", refundedAmount: "200.00" });
  assert.equal(result.baseAmount, "300.00"); assert.equal(result.splitAmount, "15.00");
  assert.equal(result.refundedBeforeSnapshot, "200.00");
  assert.equal(periodAt("2026-11-30T16:00:00Z"), "2026-12");
  assert.equal(moneyToCents("900719.99"), 90071999); assert.equal(formatMoney(-1), "-0.01");
  assert.throws(() => moneyToCents("1.001"), { code: "SHARE_4001" });
});

test("cumulative refunds round cumulatively and the final refund reverses exactly the original split", () => {
  const snapshot = { splitAmount: "0.05", baseAmount: "1.00", paidTotal: "1.20", refundedBeforeSnapshot: "0.20" };
  assert.equal(calculateRefund({ snapshot, cumulativeRefundAmount: "0.30" }).reverseAmount, "0.01");
  assert.equal(calculateRefund({ snapshot, cumulativeRefundAmount: "0.40", alreadyReversed: "0.01" }).reverseAmount, "0.00");
  assert.equal(calculateRefund({ snapshot, cumulativeRefundAmount: "1.20", alreadyReversed: "0.01" }).reverseAmount, "0.04");
  assert.throws(() => calculateRefund({ snapshot, cumulativeRefundAmount: "1.21" }), { code: "SHARE_4001" });
});

test("zero-base snapshots are auditable VOID with no detail; launch cutoff creates no historical result", () => {
  const input = scenario(); input.event.refundedAmount = "500.00";
  const result = judgeShare(input);
  assert.equal(result.status, "VOID"); assert.equal(result.shouldWriteDetail, false);
  input.options = { enableAt: "2026-11-11T00:00:00+08:00" };
  assert.equal(judgeShare(input).code, "SHARE_4230");
});

test("configuration accepts 0 through 50%, 0.01% precision, positive whole-hour TTL and refund window", () => {
  const base = { merchantId: "m", ratioT1: "0", ratioT2: "0.5", ttlHours: 720, refundWindowDays: 0, reason: "合同", operatorId: "o" };
  assert.equal(validateRule(base).ratioT2, "0.5000");
  for (const change of [{ ratioT1: ".01" }, { ratioT2: "0.5001" }, { ratioT2: "0.00001" }, { ttlHours: 0 }, { ttlHours: 72.5 }, { reason: "" }]) {
    assert.throws(() => validateRule({ ...base, ...change }), { code: "SHARE_4001" });
  }
});
