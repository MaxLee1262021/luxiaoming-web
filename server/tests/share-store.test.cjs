"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createShareStore } = require("../lib/shareStore.cjs");

// A transaction-capable SQL test double. It persists across store instances,
// checks unique keys, serializes connections, and rolls back all changed tables.
// Production code has no test adapter path and always requires MySQL.
const { fixture, merchant } = require("./fixtures/shareSql.cjs");
async function ready() { const f = fixture(); const store = f.newStore(); await store.ensureSchema(); return { f, store }; }

test("merchant, first rule, QR, audit and caller projection are atomic; retry preserves the original", async () => {
  const { f, store } = await ready();
  await assert.rejects(store.onboardMerchant(merchant(), { beforeCommit: async () => { throw new Error("account conflict"); } }), /account conflict/);
  assert.equal(f.tables().merchant.length, 0); assert.equal(f.tables().rule.length, 0); assert.equal(f.tables().qr.length, 0); assert.equal(f.tables().audit.length, 0);
  let hookCalls = 0;
  const result = await store.onboardMerchant(merchant(), { beforeCommit: async conn => { hookCalls++; assert.equal(typeof conn.query, "function"); } });
  assert.equal(result.rule.versionNo, 1); assert.equal(result.qr.qrSeq, 1); assert.equal(result.existed, false);
  const repeated = await store.onboardMerchant(merchant("m1", { name: "不得覆盖" }), { beforeCommit: async () => { hookCalls++; } });
  assert.equal(repeated.merchant.name, "门店m1"); assert.equal(repeated.existed, true); assert.equal(hookCalls, 1);
  await assert.rejects(store.onboardMerchant(merchant("m2", { name: "门店m1" })), { code: "SHARE_4006" });
  assert.equal(f.tables().merchant.length, 1);
});

test("rule optimistic lock has one winner and retains historical superseded versions", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant()); f.setTime("2026-11-02T00:00:00Z");
  const input = { ...merchant(), ratioT1: "0.0800", expectedVersion: 1, reason: "调整" };
  const outcomes = await Promise.allSettled([store.saveRule(input), store.saveRule({ ...input, ratioT1: "0.0900" })]);
  assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(row => row.status === "rejected").reason.code, "SHARE_4091");
  const rules = await store.getRules("m1"); assert.equal(rules.length, 2); assert.equal(rules[1].status, "SUPERSEDED");
});

test("scan receive time is authoritative, five-second dedup is durable, QR rotation changes scan stats only", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant());
  f.setTime("2026-11-01T01:00:00Z");
  const scan = await store.reportScan({ userId: "u1", scene: "c=m1", scanAt: "2030-01-01T00:00:00Z" });
  assert.equal(scan.scan.scanAt, "2026-11-01T01:00:00.000Z");
  f.setTime("2026-11-01T01:00:04Z");
  assert.equal((await f.newStore().reportScan({ userId: "u1", qrId: "qr-m1" })).deduplicated, true);
  f.setTime("2026-11-01T01:00:05Z");
  assert.equal((await store.reportScan({ userId: "u1", qrId: "qr-m1" })).deduplicated, false);
  assert.equal((await store.getMerchantStats("m1")).scanCount, 2);
  await store.rotateQr({ merchantId: "m1", id: "qr-new", scene: "c=new", imageUrl: "https://example.test/real.png", reason: "物料损坏", operatorId: "o", requestId: "rotate-once" });
  const stats = await store.getMerchantStats("m1"); assert.equal(stats.scanCount, 0); assert.equal(stats.boundUsers, 1);
  await assert.rejects(store.reportScan({ userId: "u2", scene: "c=m1" }), { code: "SHARE_4002" });
  assert.equal((await store.listQrs("m1")).length, 2);
});

test("closure invalidation is replayable, reopening alone does not reactivate, a new scan does", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant());
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m1" });
  f.setTime("2026-11-02T00:00:00Z"); await store.upsertMerchant({ merchantId: "m1", status: "CLOSED" });
  assert.equal((await store.getBindingsAsOf("u1", "2026-11-01T12:00:00Z"))[0].status, "ACTIVE");
  assert.equal((await store.getBindingsAsOf("u1", "2026-11-02T01:00:00Z"))[0].status, "INACTIVE");
  f.setTime("2026-11-03T00:00:00Z"); await store.upsertMerchant({ merchantId: "m1", status: "OPEN" });
  assert.equal((await store.getMerchantStats("m1")).boundUsers, 0);
  await store.reportScan({ userId: "u1", scene: "c=m1" });
  assert.equal((await store.getMerchantStats("m1")).boundUsers, 1);
});

test("paid decisions persist over restart and later scans/configuration; pre-maturity refunds reduce base", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant()); await store.onboardMerchant(merchant("m2"));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m1" });
  f.setTime("2026-11-01T02:00:00Z");
  const queued = await store.enqueuePayment({ orderId: "o1", userId: "u1", payTime: "2026-11-01T02:00:00Z", paidTotal: "500.00",
    provider: "wechat_pay", display: { orderNo: "O0001", productName: "商品一 + 商品二" } });
  assert.equal(queued.decision.hitMerchantId, "m1"); assert.equal(queued.decision.availableAt, "2026-11-04T02:00:00.000Z");
  assert.equal((await store.processJob("o1")).pending, true); assert.equal(await store.getSnapshot("o1"), null);
  f.setTime("2026-11-02T00:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m2" });
  await store.saveRule({ ...merchant(), ratioT1: "0.1000", refundWindowDays: 9, expectedVersion: 1 });
  await store.recordRefund({ orderId: "o1", refundNo: "r1", amount: "200.00" });
  f.setTime("2026-11-04T02:00:00Z"); const restarted = f.newStore();
  assert.equal((await restarted.listDueJobs()).length, 1);
  const results = await Promise.all([restarted.processJob("o1"), restarted.processJob("o1")]);
  assert.equal(results.filter(row => !row.existed).length, 1);
  const snapshot = await restarted.getSnapshot("o1");
  assert.equal(snapshot.hitMerchantId, "m1"); assert.equal(snapshot.baseAmount, "300.00"); assert.equal(snapshot.splitAmount, "15.00");
  assert.equal(snapshot.ratio, "0.0500"); assert.equal(snapshot.refundWindowDays, 3);
  assert.equal(snapshot.displayJson.productName, "商品一 + 商品二");
  assert.equal((await restarted.listDetails()).total, 1);
  assert.ok(f.tables().outbox.some(row => row.event_type === "SHARE_SNAPSHOT_CREATED"));
});

test("post-maturity refunds are independently idempotent, cumulative and booked in actual processing month", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "o1", userId: "u1", paidTotal: "1.00", payTime: "2026-11-01T01:00:00Z" });
  await store.processJob("o1"); const original = await store.getSnapshot("o1");
  f.setTime("2026-12-01T00:00:00Z");
  const args = { orderId: "o1", refundNo: "r1", amount: "0.10" };
  const results = await Promise.all([store.recordRefund(args), store.recordRefund(args)]);
  assert.equal(results.filter(row => !row.existed).length, 1);
  assert.equal((await store.recordRefund({ orderId: "o1", refundNo: "r2", amount: "0.10" })).detail, null);
  await store.recordRefund({ orderId: "o1", refundNo: "r3", amount: "0.80" });
  const details = await store.listDetails({ all: true });
  assert.equal(details.totalAmount, "0.00"); assert.equal(details.list.filter(row => row.direction === 2).length, 2);
  assert.ok(details.list.filter(row => row.direction === 2).every(row => row.period === "2026-12"));
  assert.deepEqual(await store.getSnapshot("o1"), original, "refunds cannot mutate original accounting snapshot");
  await assert.rejects(store.recordRefund({ orderId: "o1", refundNo: "excess", amount: "0.01" }), { code: "SHARE_4001" });
});

test("T2 uses earlier paid pending T1 jobs; later clicks and full-refunded prior jobs cannot influence historical attribution", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant()); await store.onboardMerchant(merchant("m2"));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "t1", userId: "u1", paidTotal: "100.00", payTime: "2026-11-01T01:00:00Z" });
  f.setTime("2026-11-01T02:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m2" });
  await store.reportClick({ userId: "u1", staffId: "service", linkId: "link" });
  const result = await store.enqueuePayment({ orderId: "t2", userId: "u1", paidTotal: "100.00", payTime: "2026-11-01T02:00:00Z" });
  assert.equal(result.decision.hitMerchantId, "m1"); assert.equal(result.decision.hitReason, "D_LATEST_SCAN");
  assert.equal(await store.getSnapshot("t1"), null);
  f.setTime("2026-11-01T03:00:00Z"); await store.recordRefund({ orderId: "t1", refundNo: "full", amount: "100.00" });
  const next = await store.enqueuePayment({ orderId: "t3", userId: "u1", paidTotal: "100.00", payTime: "2026-11-01T03:00:00Z" });
  assert.equal(next.decision.hitMerchantId, "m2"); assert.equal(next.decision.hitReason, "C_LATEST_SCAN");
  assert.equal(f.tables().scan.length, 2, "click reports must not insert scans");
});

test("failed accounting rolls back details/snapshot and retries survive restart; exhausted jobs enter durable failure/outbox", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "o1", userId: "u1", paidTotal: "100.00", payTime: "2026-11-01T01:00:00Z" });
  f.injectFailure("INSERT INTO `lxm_share_detail`", 4);
  const attemptsAt = ["2026-11-01T01:00:00Z", "2026-11-01T01:00:01Z", "2026-11-01T01:00:05Z", "2026-11-01T01:00:21Z"];
  const nextAt = ["2026-11-01T01:00:01.000Z", "2026-11-01T01:00:05.000Z", "2026-11-01T01:00:21.000Z"];
  for (let attempt = 1; attempt <= 4; attempt++) {
    f.setTime(attemptsAt[attempt - 1]);
    await assert.rejects(f.newStore().processJob("o1"), /injected storage failure/);
    assert.equal(await store.getSnapshot("o1"), null);
    assert.equal(f.tables().detail.length, 0);
    assert.equal((await store.getJob("o1")).attempts, attempt);
    if (attempt <= 3) {
      assert.equal((await store.getJob("o1")).nextAttemptAt, nextAt[attempt - 1]);
      assert.equal((await store.getJob("o1")).status, "PENDING");
      assert.equal((await store.processJob("o1")).deferred, true, "backoff must prevent early retry");
    }
  }
  assert.equal((await store.getJob("o1")).status, "FAILED"); assert.equal((await store.listFailures()).length, 1);
  assert.ok((await store.listOutbox()).some(row => row.eventType === "SHARE_JOB_FAILED"));
  assert.equal((await store.processJob("o1")).failed, true);
  await assert.rejects(store.retryJob("o1", "", "operator"), { code: "SHARE_4001" });
  const retriedJob = await store.retryJob("o1", "已核对并修复存储故障", "operator"); assert.equal(retriedJob.job.attempts, 0);
  const retried = await store.processJob("o1"); assert.equal(retried.snapshot.splitAmount, "5.00");
  assert.equal((await store.listFailures()).length, 0);
  assert.ok(f.tables().audit.some(row => row.action === "JOB_RETRY"));
});

test("concurrent QR rotation uses request identity and different contents cannot reuse that identity", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant());
  const input = { merchantId: "m1", id: "qr-rotate", scene: "c=rotate", imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "旧物料损坏", operatorId: "operator", requestId: "rotate-click-once" };
  const results = await Promise.all([store.rotateQr(input), store.rotateQr({ ...input, id: "qr-other", scene: "c=other" })]);
  assert.equal(results.filter(row => row.existed).length, 1);
  assert.equal((await store.listQrs("m1")).length, 2); assert.equal((await store.getActiveQr("m1")).id, "qr-rotate");
  await assert.rejects(store.rotateQr({ ...input, reason: "另一项操作" }), { code: "SHARE_4090" });
  assert.equal(f.tables().qr.filter(row => row.status === "ACTIVE").length, 1);
});

test("detail totals use all filtered rows while monthly stats respect Shanghai accounting month", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m1" });
  for (const orderId of ["o1", "o2"]) {
    await store.enqueuePayment({ orderId, userId: "u1", paidTotal: "100.00", payTime: "2026-11-01T01:00:00Z" }); await store.processJob(orderId);
  }
  const firstPage = await store.listDetails({ size: 1 });
  assert.equal(firstPage.list.length, 1); assert.equal(firstPage.sum.netAmount, "10.00"); assert.equal(firstPage.orderCount, 2);
  f.setTime("2026-11-30T16:00:00Z"); await store.recordRefund({ orderId: "o1", refundNo: "dec-refund", amount: "100.00" });
  const current = await store.getMerchantStats("m1"); assert.equal(current.monthAmount, "-5.00"); assert.equal(current.monthOrders, 1);
  const december = await store.listDetails({ period: "2026-12" });
  assert.deepEqual(december.sum, { positiveAmount: "0.00", reverseAmount: "-5.00", netAmount: "-5.00" });
  assert.equal((await store.listRuleSummaries({ status: "configured" })).total, 1);
  assert.equal((await store.listRuleSummaries({ status: "unconfigured" })).total, 0);
  assert.ok(f.statements.every(call => !/^\s*(UPDATE|DELETE FROM)\s+`?lxm_share_snapshot/i.test(call.sql)), "snapshot remains append-only even with refunds");
});

test("store refuses non-transactional source and rejects manual payment events", async () => {
  assert.throws(() => createShareStore({}), { code: "SHARE_STORAGE_UNAVAILABLE" });
  const { store } = await ready();
  await assert.rejects(store.enqueuePayment({ orderId: "manual", userId: "u", paidTotal: "1.00", payTime: "2026-11-01T00:00:00Z", provider: "manual" }), { code: "SHARE_ONLINE_ONLY" });
});

test("registered customer-service links persist immutable staff identity and expiration without creating scans or bindings", async () => {
  const { f, store } = await ready(); const linkId = "abcdef0123456789abcdef0123456789";
  const result = await store.createCsLink({ linkId, staffId: "service", wecomUserId: "wecom-user", expiresAt: "2026-11-03T00:00:00Z", operatorId: "admin" });
  assert.equal(result.staffId, "service");
  assert.equal((await f.newStore().getCsLink(linkId)).wecomUserId, "wecom-user");
  assert.equal((await store.getCsLink(linkId)).expiresAt, "2026-11-03T00:00:00.000Z");
  await assert.rejects(store.createCsLink({ linkId: "predictable", staffId: "service", operatorId: "admin" }), { code: "SHARE_4001" });
  await assert.rejects(store.createCsLink({ linkId: "1".repeat(32), staffId: "service", expiresAt: "2026-10-01T00:00:00Z", operatorId: "admin" }), { code: "SHARE_4001" });
  await assert.rejects(store.createCsLink({ linkId, staffId: "forged-service", operatorId: "admin" }), { code: "SHARE_4090" });
  assert.equal((await store.getCsLink(linkId)).staffId, "service");
  assert.equal(f.tables().scan.length, 0); assert.equal(f.tables().binding.length, 0); assert.equal(f.tables().click.length, 0);
  assert.ok(f.tables().audit.some(row => row.action === "CS_LINK_CREATE"));
  const request = { staffId: "service", wecomUserId: "wecom-user", operatorId: "admin", requestId: "same-button-click" };
  const [first, second] = await Promise.all([store.createCsLink({ ...request, linkId: "1".repeat(32) }), store.createCsLink({ ...request, linkId: "2".repeat(32) })]);
  assert.equal(first.linkId, second.linkId); assert.equal(second.existed, true);
  assert.equal((await store.getCsLinkByRequest("admin", "same-button-click")).linkId, first.linkId);
  await assert.rejects(store.createCsLink({ ...request, linkId: "3".repeat(32), staffId: "other-service" }), { code: "SHARE_4090" });
});

async function missingEarlierSelfOrder() {
  const { f, store } = await ready();
  await store.onboardMerchant(merchant("m1", { refundWindowDays: 0, ratioT2: "0.0800" }));
  await store.onboardMerchant(merchant("m2", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m1" });
  f.setTime("2026-11-01T02:00:00Z"); await store.reportScan({ userId: "u1", scene: "c=m2" });
  await store.reportClick({ userId: "u1", staffId: "service", linkId: "link" });
  f.setTime("2026-11-01T02:10:00Z");
  await store.enqueuePayment({ orderId: "t2", userId: "u1", paidTotal: "100.00", payTime: "2026-11-01T02:10:00Z" });
  await store.processJob("t2");
  const original = await store.getSnapshot("t2"); assert.equal(original.hitMerchantId, "m2");
  // A durable observer recovered this earlier online payment after T2 posted.
  // Correction must replay its true pay time, not the current latest binding.
  f.setTime("2026-11-02T00:00:00Z");
  const earlier = await store.enqueuePayment({ orderId: "t1", userId: "u1", paidTotal: "50.00", payTime: "2026-11-01T01:30:00Z" });
  assert.equal(earlier.decision.hitMerchantId, "m1"); assert.equal(earlier.decision.splitType, "T1");
  return { f, store, original };
}

test("correction replays original payment facts, transfers remaining balance, and refunds only the effective revision", async () => {
  const { f, store, original } = await missingEarlierSelfOrder();
  await store.recordRefund({ orderId: "t2", refundNo: "before-correction", amount: "20.00" });
  const input = { reason: "补偿恢复早期支付证据后核对归属", requestId: "correct-once", operatorId: "super" };
  const results = await Promise.all([store.correctSnapshot("t2", input), store.correctSnapshot("t2", input)]);
  assert.equal(results.filter(result => !result.existed).length, 1);
  const correction = results.find(result => !result.existed);
  assert.equal(correction.state.hitMerchantId, "m1"); assert.equal(correction.state.splitAmount, "6.40");
  assert.equal(correction.state.refundedBeforeSnapshot, "20.00");
  assert.deepEqual(correction.details.map(detail => [detail.merchantId, detail.amount, detail.entryType]), [["m2", "-2.40", "CORRECTION_REVERSE"], ["m1", "6.40", "CORRECTION_POST"]]);
  assert.deepEqual(await store.getSnapshot("t2"), original);
  await store.recordRefund({ orderId: "t2", refundNo: "after-correction", amount: "30.00" });
  const latest = await store.listDetails({ orderId: "t2", all: true });
  assert.equal(latest.sum.netAmount, "4.00");
  const reversal = latest.list.find(detail => detail.refundNo === "after-correction");
  assert.equal(reversal.merchantId, "m1"); assert.equal(reversal.amount, "-2.40"); assert.equal(reversal.revisionNo, 1);
  await store.recordRefund({ orderId: "t2", refundNo: "last-refund", amount: "50.00" });
  assert.equal((await store.listDetails({ orderId: "t2", all: true })).sum.netAmount, "0.00");
  assert.equal((await store.getMerchantStats("m2")).totalAmount, "0.00");
  assert.equal(f.tables().snapshot.filter(row => row.order_id === "t2").length, 1);
  assert.equal((await store.getCorrections("t2")).length, 1);
  await assert.rejects(store.correctSnapshot("t2", { ...input, reason: "不同原因不可复用" }), { code: "SHARE_4090" });
});

test("no-op corrections preserve money rows, rebase subsequent refund rounding, and have an audited monthly limit", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "o", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T01:00:00Z" }); await store.processJob("o");
  const original = await store.getSnapshot("o");
  for (let i = 0; i < 10; i++) {
    if (i === 1) await store.recordRefund({ orderId: "o", refundNo: "first-refund", amount: "20.00" });
    const result = await store.correctSnapshot("o", { requestId: "noop-" + i, reason: "复核原始支付证据", operatorId: "super" });
    assert.equal(result.changed, false); assert.deepEqual(result.details, []);
  }
  assert.equal((await store.listDetails({ orderId: "o" })).total, 2);
  await assert.rejects(store.correctSnapshot("o", { requestId: "eleventh", reason: "本月第十一次", operatorId: "super" }), { code: "SHARE_CORRECTION_LIMIT" });
  const repeated = await store.correctSnapshot("o", { requestId: "noop-0", reason: "复核原始支付证据", operatorId: "super" }); assert.equal(repeated.existed, true);
  await store.recordRefund({ orderId: "o", refundNo: "second-refund", amount: "20.00" });
  assert.equal((await store.listDetails({ orderId: "o" })).sum.netAmount, "3.00");
  f.setTime("2026-12-01T00:00:00Z");
  assert.equal((await store.correctSnapshot("o", { requestId: "next-month", reason: "次月复核", operatorId: "super" })).existed, false);
  assert.deepEqual(await store.getSnapshot("o"), original);
  assert.equal(f.tables().audit.filter(row => row.action === "SNAPSHOT_CORRECTION").length, 11);
});

test("correction rollback preserves quota, ledger and immutable snapshot when any append fails", async () => {
  const { f, store, original } = await missingEarlierSelfOrder();
  const before = await store.listDetails({ orderId: "t2", all: true });
  f.injectFailure("INSERT INTO `lxm_share_audit`");
  const input = { requestId: "will-retry", reason: "核对后更正", operatorId: "super" };
  await assert.rejects(store.correctSnapshot("t2", input), /injected storage failure/);
  assert.deepEqual(await store.listDetails({ orderId: "t2", all: true }), before);
  assert.equal((await store.getCorrections("t2")).length, 0); assert.equal(f.tables().correction_quota.length, 0);
  assert.deepEqual(await store.getSnapshot("t2"), original);
  assert.equal((await store.correctSnapshot("t2", input)).state.splitAmount, "8.00");
  assert.equal(f.tables().correction_quota[0].used_count, 1);
  assert.ok(f.statements.every(call => !/^\s*(UPDATE|DELETE FROM)\s+`?lxm_share_snapshot/i.test(call.sql)));
});

test("session-only attribution freezes trusted payment session facts and reuses them during correction after restart", async () => {
  const f = fixture(); const store = f.newStore({ csAttrDays: 0 }); await store.ensureSchema();
  await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  await store.reportClick({ userId: "u", staffId: "service", linkId: "verified-link", sessionId: "a".repeat(64) });
  f.setTime("2026-11-01T01:30:00Z");
  const payment = { orderId: "session-order", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T01:30:00Z", sessionId: "a".repeat(64), sessionStartAt: "2026-11-01T00:50:00Z" };
  const queued = await store.enqueuePayment(payment);
  assert.equal(queued.decision.splitType, "T2"); assert.equal(queued.decision.sessionId, payment.sessionId);
  assert.equal(queued.decision.sessionStartAt, "2026-11-01T00:50:00.000Z");
  await store.processJob(payment.orderId);
  f.setTime("2026-11-01T02:00:00Z");
  await store.reportClick({ userId: "u", staffId: "different-service", linkId: "future-link", sessionId: "b".repeat(64) });
  const restarted = f.newStore({ csAttrDays: 0 });
  const correction = await restarted.correctSnapshot(payment.orderId, { reason: "核验原支付会话", requestId: "session-correction", operatorId: "super" });
  assert.equal(correction.state.splitType, "T2"); assert.equal(correction.state.staffId, "service");
  assert.equal(correction.state.splitAmount, "3.00"); assert.equal(correction.changed, false);
  const otherSession = await restarted.enqueuePayment({ ...payment, orderId: "other-session", sessionId: "b".repeat(64) });
  assert.equal(otherSession.decision.splitType, "T1", "a click in another session or after the original payment cannot establish T2");
});

test("scheduled slots survive restart, exclude another live owner and allow expired-lease takeover with stale-token rejection", async () => {
  const { f, store } = await ready(); const at = "2026-11-06T02:00:00Z"; f.setTime(at);
  const input = { name: "DAILY_METRICS", slotAt: "2026-11-05T17:15:00Z", now: at, intervalMs: 86400000, leaseSeconds: 300 };
  const claims = await Promise.all([store.claimScheduledSlot(input), f.newStore().claimScheduledSlot(input)]);
  assert.equal(claims.filter(result => result.claimed).length, 1);
  const first = claims.find(result => result.claimed);
  f.setTime("2026-11-06T02:05:01Z");
  const takeover = await f.newStore().claimScheduledSlot({ ...input, now: "2026-11-06T02:05:01Z" });
  assert.equal(takeover.claimed, true); assert.notEqual(takeover.leaseToken, first.leaseToken);
  assert.equal(await store.completeScheduledSlot({ ...first, now: "2026-11-06T02:05:01Z", nextSlotAt: "2026-11-06T17:15:00Z" }), false);
  assert.equal(await store.completeScheduledSlot({ ...takeover, now: "2026-11-06T02:05:01Z", nextSlotAt: "2026-11-06T17:15:00Z", result: { handled: 1 } }), true);
  assert.equal((await f.newStore().claimScheduledSlot({ ...input, now: "2026-11-06T02:05:01Z" })).claimed, false);
  f.setTime("2026-11-10T02:00:00Z");
  const catchup = await store.claimScheduledSlot({ ...input, slotAt: "2026-11-09T17:15:00Z", now: "2026-11-10T02:00:00Z" });
  assert.equal(catchup.claimed, true); assert.equal(catchup.skippedSlots, 3, "long downtime collapses to latest due slot with an explicit count");
  assert.ok(f.tables().schedule_run.some(row => row.status === "LEASE_EXPIRED"));
});

test("A4 repairs a mature T+1 refund gap once and leaves the original snapshot intact", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "o", userId: "u", payTime: "2026-11-01T01:00:00Z", paidTotal: "100.00" }); await store.processJob("o");
  const original = await store.getSnapshot("o"); f.setTime("2026-11-03T02:00:00Z");
  const input = { refunds: [{ refundNo: "lost-refund", amount: "20.00", refundAt: "2026-11-01T02:00:00Z" }] };
  const repaired = await store.reconcileRefundReversals("o", input);
  assert.equal(repaired.overdue, true); assert.equal(repaired.overdueAmount, "1.00"); assert.equal(repaired.repairedAmount, "1.00");
  assert.equal((await store.listDetails({ orderId: "o" })).sum.netAmount, "4.00");
  assert.equal((await store.reconcileRefundReversals("o", input)).repairedAmount, "0.00");
  assert.equal(f.tables().outbox.filter(row => row.event_type === "REFUND_REVERSAL_OVERDUE").length, 1);
  assert.deepEqual(await store.getSnapshot("o"), original);
});

test("A4 excludes pre-window base deductions, zero-share orders and refunds rounded to zero", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 3 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "window", userId: "u", paidTotal: "1.00", payTime: "2026-11-01T01:00:00Z" });
  await store.reconcileRefundReversals("window", { refunds: [{ refundNo: "before-mature", amount: "0.20", refundAt: "2026-11-01T02:00:00Z" }], now: "2026-11-03T02:00:00Z" });
  f.setTime("2026-11-04T01:00:00Z"); await store.processJob("window");
  const reconciled = await store.reconcileRefundReversals("window", { now: "2026-11-06T02:00:00Z" });
  assert.equal(reconciled.overdue, false); assert.equal(reconciled.repairedAmount, "0.00");
  const rounding = await store.reconcileRefundReversals("window", { refunds: [{ refundNo: "one-cent", amount: "0.01", refundAt: "2026-11-04T02:00:00Z" }], now: "2026-11-06T02:00:00Z" });
  assert.equal(rounding.overdue, false); assert.equal(rounding.repairedAmount, "0.00");
  await store.enqueuePayment({ orderId: "platform", userId: "unbound", paidTotal: "10.00", payTime: "2026-11-01T01:00:00Z" }); await store.processJob("platform");
  assert.equal((await store.reconcileRefundReversals("platform", { refunds: [{ refundNo: "platform-refund", amount: "10.00", refundAt: "2026-11-01T02:00:00Z" }], now: "2026-11-06T02:00:00Z" })).overdue, false);
  assert.equal(f.tables().outbox.some(row => row.event_type === "REFUND_REVERSAL_OVERDUE"), false);
});

test("failed notifications stay queryable and audited manual retry resets only a failed delivery", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "o", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T01:00:00Z" }); await store.processJob("o");
  f.setTime("2026-11-03T02:00:00Z");
  await store.reconcileRefundReversals("o", { refunds: [{ refundNo: "overdue", amount: "20.00", refundAt: "2026-11-01T02:00:00Z" }], now: "2026-11-03T02:00:00Z" });
  const event = (await store.listOutbox()).find(row => row.eventType === "REFUND_REVERSAL_OVERDUE");
  await store.failOutbox(event.id); await store.failOutbox(event.id); await store.failOutbox(event.id);
  assert.equal((await store.listFailedOutbox()).length, 1);
  await assert.rejects(store.retryOutbox(event.id, "", "super"), { code: "SHARE_4001" });
  await store.retryOutbox(event.id, "已配置通知通道，重试投递", "super");
  assert.equal((await store.listFailedOutbox()).length, 0); assert.equal((await store.listOutbox()).find(row => row.id === event.id).attempts, 0);
  assert.ok(f.tables().audit.some(row => row.action === "ALERT_RETRY"));
});

test("configured default TTL and scan dedup are applied with validated retry settings", async () => {
  const f = fixture(); const store = f.newStore({ defaultTtlHours: 2, dedupSeconds: 10, judgeRetryMax: 3 }); await store.ensureSchema();
  await store.upsertMerchant({ merchantId: "m", name: "尚未配置门店" });
  await store.saveQr({ merchantId: "m", id: "qr", scene: "c=m", imageUrl: "https://example.test/qr.png", reason: "入驻", operatorId: "super" });
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m" });
  f.setTime("2026-11-01T01:00:08Z"); assert.equal((await store.reportScan({ userId: "u", scene: "c=m" })).deduplicated, true);
  f.setTime("2026-11-01T04:00:00Z"); await store.reportClick({ userId: "u", staffId: "s" });
  const queued = await store.enqueuePayment({ orderId: "o", userId: "u", paidTotal: "10.00", payTime: "2026-11-01T04:00:00Z" });
  assert.equal(queued.decision.hitMerchantId, "0"); assert.equal(queued.decision.candidateJson.candidates[0].ttlHours, 2);
  for (const options of [{ defaultTtlHours: 0 }, { dedupSeconds: 0 }, { judgeRetryMax: 11 }]) assert.throws(() => f.newStore(options), { code: "SHARE_4001" });
});

test("scan metadata is archived while server time alone controls binding, dedup and the attribution window", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { ttlHours: 1, refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z");
  const future = "2030-12-01T10:11:12+08:00";
  const first = await store.reportScan({ userId: "u", qrId: "qr-m1", launchType: 2, deviceId: "d".repeat(128), clientScanAt: future });
  assert.equal(first.scan.scanAt, "2026-11-01T01:00:00.000Z"); assert.equal(first.scan.clientScanAt, future);
  assert.equal(f.tables().scan[0].launch_type, 2); assert.equal(f.tables().scan[0].device_id, "d".repeat(128)); assert.equal(f.tables().scan[0].client_scan_at, future);
  assert.equal(f.tables().scan[0].scan_at, "2026-11-01 01:00:00.000");
  f.setTime("2026-11-01T01:00:04Z");
  assert.equal((await store.reportScan({ userId: "u", qrId: "qr-m1", clientScanAt: "1970-01-01T00:00:00Z" })).deduplicated, true);
  assert.equal(f.tables().scan.length, 1); assert.equal(f.tables().scan[0].client_scan_at, future);
  f.setTime("2026-11-01T01:00:05Z");
  await store.reportScan({ userId: "u", qrId: "qr-m1", launchType: 1, clientScanAt: "1970-01-01T00:00:00Z" });
  assert.equal((await store.getBindingsAsOf("u", "2026-11-01T01:00:05Z"))[0].lastScanAt, "2026-11-01T01:00:05.000Z");
  f.setTime("2026-11-01T03:00:06Z"); await store.reportClick({ userId: "u", staffId: "service" });
  const payment = await store.enqueuePayment({ orderId: "outside-window", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T03:00:06Z" });
  assert.equal(payment.decision.hitMerchantId, "0", "a future client timestamp cannot extend the server-time window");
  for (const metadata of [{ launchType: 3 }, { deviceId: "d".repeat(129) }, { clientScanAt: "not-an-iso-date" }, { clientScanAt: "2026-01-01T00:00:00." + "1".repeat(50) + "Z" }])
    await assert.rejects(store.reportScan({ userId: "other", qrId: "qr-m1", ...metadata }), { code: "SHARE_4001" });
  assert.equal(f.tables().scan.length, 2);
});

test("disabled QR attempts remain observable per code without creating scans or changing active-code counts", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant());
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", qrId: "qr-m1" });
  await store.rotateQr({ merchantId: "m1", id: "qr-next", scene: "c=next", imageUrl: "https://example.test/real.png", reason: "物料更换", operatorId: "super", requestId: "next-code" });
  await assert.rejects(store.reportScan({ userId: "other", qrId: "qr-m1" }), { code: "SHARE_4002" });
  await store.recordObservation({ metricKey: "DISABLED_QR_SCAN", subjectId: "qr-m1", success: false });
  await store.recordObservation({ metricKey: "DISABLED_QR_SCAN", subjectId: "qr-m1", success: false });
  assert.equal(f.tables().scan.length, 1); assert.equal(f.tables().binding.length, 1);
  const history = await store.listQrs("m1");
  assert.equal(history.find(qr => qr.id === "qr-m1").disabledScanCount, 2); assert.equal(history.find(qr => qr.id === "qr-m1").scanCount, 0);
  assert.equal((await store.getActiveQr("m1")).disabledScanCount, 0); assert.equal((await store.getActiveQr("m1")).scanCount, 0);
  f.setTime("2026-11-01T01:00:06Z"); await store.reportScan({ userId: "u", qrId: "qr-next" });
  assert.equal((await store.getActiveQr("m1")).scanCount, 1); assert.equal((await store.getMerchantStats("m1")).scanCount, 1);
});

async function pendingLateFacts(windowA = 3, windowB = 7, { enqueueT1 = true } = {}) {
  const { f, store } = await ready();
  await store.onboardMerchant(merchant("m1", { refundWindowDays: windowA, ratioT2: "0.0800" }));
  await store.onboardMerchant(merchant("m2", { refundWindowDays: windowB }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  f.setTime("2026-11-01T02:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m2" });
  await store.reportClick({ userId: "u", staffId: "service" });
  f.setTime("2026-11-01T02:10:00Z");
  const queued = await store.enqueuePayment({ orderId: "t2", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T02:10:00Z" });
  assert.equal(queued.decision.hitMerchantId, "m2");
  f.setTime("2026-11-02T00:00:00Z");
  if (enqueueT1) {
    const lateT1 = await store.enqueuePayment({ orderId: "t1", userId: "u", paidTotal: "50.00", payTime: "2026-11-01T01:30:00Z" });
    assert.equal(lateT1.decision.splitType, "T1"); assert.equal(lateT1.decision.hitMerchantId, "m1");
  }
  return { f, store, queued };
}

test("a late earlier T1 refreshes pending T2 from seven to three days without a premature formal snapshot", async () => {
  const { f, store, queued } = await pendingLateFacts(3, 7);
  assert.equal(queued.job.availableAt, "2026-11-08T02:10:00.000Z");
  const originalRetryAt = (await store.getJob("t2")).nextAttemptAt;
  await store.refreshPendingBatch({ limit: 100 });
  const refreshed = await store.getJob("t2");
  assert.equal(refreshed.decisionJson.hitMerchantId, "m1"); assert.equal(refreshed.availableAt, "2026-11-04T02:10:00.000Z");
  assert.equal(refreshed.nextAttemptAt, originalRetryAt); assert.equal(await store.getSnapshot("t2"), null);
  f.setTime("2026-11-04T02:10:00Z");
  assert.ok((await store.listDueJobs()).some(job => job.orderId === "t2"), "a stale initial seven-day nextAttemptAt cannot hide a never-retried mature job");
  const posted = await store.processJob("t2");
  assert.equal(posted.snapshot.hitMerchantId, "m1"); assert.equal(posted.snapshot.splitAmount, "8.00");
});

test("processJob replays original t0 and extends the window if late T1 changes three-day B to seven-day A", async () => {
  const { f, store } = await pendingLateFacts(7, 3);
  f.setTime("2026-11-04T02:10:00Z");
  const attempt = await store.processJob("t2");
  assert.equal(attempt.pending, true); assert.equal(await store.getSnapshot("t2"), null);
  assert.equal(attempt.job.availableAt, "2026-11-08T02:10:00.000Z");
  f.setTime("2026-11-08T02:10:00Z"); const posted = await store.processJob("t2");
  assert.equal(posted.snapshot.hitMerchantId, "m1"); assert.equal(posted.snapshot.refundWindowDays, 7);
});

test("late pre-t0 full refund removes the provisional T1 preference before pending T2 posts", async () => {
  const { f, store } = await pendingLateFacts(7, 3);
  await store.refreshPendingJob("t2"); assert.equal((await store.getJob("t2")).decisionJson.hitMerchantId, "m1");
  await store.recordRefund({ orderId: "t1", refundNo: "late-full-refund", amount: "50.00", refundAt: "2026-11-01T01:50:00Z" });
  f.setTime("2026-11-04T02:10:00Z");
  const posted = await store.processJob("t2");
  assert.equal(posted.snapshot.hitMerchantId, "m2"); assert.equal(posted.snapshot.splitAmount, "3.00");
});

test("pending replay ignores post-payment scans, later clicks and later rule/window changes", async () => {
  const { f, store } = await pendingLateFacts(3, 3, { enqueueT1: false });
  await store.reportScan({ userId: "u", scene: "c=m1" }); await store.reportClick({ userId: "u", staffId: "future-service" });
  await store.saveRule({ ...merchant("m2"), ratioT2: "0.5000", refundWindowDays: 7, ttlHours: 1, expectedVersion: 1 });
  f.setTime("2026-11-04T02:10:00Z"); const posted = await store.processJob("t2");
  assert.equal(posted.snapshot.hitMerchantId, "m2"); assert.equal(posted.snapshot.ratio, "0.0300");
  assert.equal(posted.snapshot.staffId, "service"); assert.equal(posted.snapshot.refundWindowDays, 3);
});

test("pending refresh preserves failed-attempt budgets and cannot advance a real retry deadline", async () => {
  const { f, store } = await pendingLateFacts(3, 7, { enqueueT1: false });
  f.setTime("2026-11-08T02:10:00Z"); f.injectFailure("INSERT INTO `lxm_share_detail`");
  await assert.rejects(store.processJob("t2"), /injected storage failure/);
  const failed = await store.getJob("t2"); assert.equal(failed.attempts, 1);
  await store.enqueuePayment({ orderId: "t1", userId: "u", paidTotal: "50.00", payTime: "2026-11-01T01:30:00Z" });
  await store.refreshPendingBatch(); const refreshed = await store.getJob("t2");
  assert.equal(refreshed.availableAt, "2026-11-04T02:10:00.000Z");
  assert.equal(refreshed.attempts, 1); assert.equal(refreshed.nextAttemptAt, failed.nextAttemptAt);
  assert.equal((await store.processJob("t2")).deferred, true);
  assert.equal((await store.listDueJobs()).some(job => job.orderId === "t2"), false);
  f.setTime("2026-11-08T02:10:01Z"); assert.equal((await store.processJob("t2")).snapshot.hitMerchantId, "m1");
});

test("durable keyset pagination reaches beyond a hundred long-window jobs and resumes after restart", async () => {
  const { f, store } = await ready();
  f.setTime("2026-11-01T01:00:00Z");
  await store.enqueuePayment({ orderId: "seed", userId: "seed-user", paidTotal: "10.00", payTime: "2026-11-01T01:00:00Z" });
  const seed = structuredClone(f.tables().job[0]);
  f.tables().job = Array.from({ length: 205 }, (_, index) => {
    const orderId = "pending-" + String(index).padStart(3, "0"), userId = "user-" + index;
    return { ...structuredClone(seed), order_id: orderId, user_id: userId, decision_json: JSON.stringify({ ...JSON.parse(seed.decision_json), orderId, userId }) };
  });
  f.setTime("2026-11-02T00:00:00Z");
  assert.equal((await store.refreshPendingBatch({ limit: 100 })).lastOrderId, "pending-099");
  assert.equal((await f.newStore().refreshPendingBatch({ limit: 100 })).lastOrderId, "pending-199");
  const finalPage = await f.newStore().refreshPendingBatch({ limit: 100 }); assert.equal(finalPage.refreshed, 5); assert.equal(finalPage.finished, true);
  assert.ok(f.tables().job.every(job => job.updated_at === "2026-11-02 00:00:00.000"));
  assert.ok(f.tables().job.every(job => job.status === "PENDING")); assert.equal(f.tables().snapshot.length, 0);
  assert.equal((await store.refreshPendingBatch({ limit: 100 })).lastOrderId, "pending-099", "completed keyset passes wrap to the beginning rather than starving new earlier facts");
});

test("late facts affecting a posted snapshot only create review evidence until explicit correction", async () => {
  const { f, store, original } = await missingEarlierSelfOrder();
  const before = await store.listDetails({ orderId: "t2", all: true });
  const reviewed = await store.reviewPostedFacts({ orderId: "t1" });
  assert.equal(reviewed.flagged, 1); assert.deepEqual(await store.getSnapshot("t2"), original);
  assert.deepEqual(await store.listDetails({ orderId: "t2", all: true }), before);
  assert.ok(f.tables().risk.some(risk => risk.entity_id === "t2" && risk.risk_code === "SHARE_LATE_FACT_REVIEW" && risk.status === "OPEN"));
  assert.equal((await store.reviewPostedFacts({ orderId: "t1" })).flagged, 0);
  await store.correctSnapshot("t2", { reason: "复核迟到支付事实", requestId: "late-fact-correction", operatorId: "super" });
  assert.equal(f.tables().risk.find(risk => risk.entity_id === "t2").status, "RESOLVED");
});

test("a late successful full refund may flag a dependent posted T2 but cannot silently move its money", async () => {
  const { f, store } = await ready();
  await store.onboardMerchant(merchant("m1", { refundWindowDays: 0, ratioT2: "0.0800" })); await store.onboardMerchant(merchant("m2", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  f.setTime("2026-11-01T01:30:00Z"); await store.enqueuePayment({ orderId: "t1", userId: "u", paidTotal: "50.00", payTime: "2026-11-01T01:30:00Z" }); await store.processJob("t1");
  f.setTime("2026-11-01T02:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m2" }); await store.reportClick({ userId: "u", staffId: "service" });
  f.setTime("2026-11-01T02:10:00Z"); await store.enqueuePayment({ orderId: "t2", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T02:10:00Z" }); await store.processJob("t2");
  const original = await store.getSnapshot("t2"); assert.equal(original.hitMerchantId, "m1");
  f.setTime("2026-11-02T00:00:00Z"); await store.recordRefund({ orderId: "t1", refundNo: "late-confirmed-full", amount: "50.00", refundAt: "2026-11-01T01:50:00Z" });
  assert.equal((await store.reviewPostedFacts({ orderId: "t1", refundNo: "late-confirmed-full" })).flagged, 1);
  assert.deepEqual(await store.getSnapshot("t2"), original); assert.equal((await store.listDetails({ orderId: "t2" })).sum.netAmount, "8.00");
  const review = f.tables().outbox.find(event => event.event_type === "SHARE_LATE_FACT_REVIEW");
  assert.equal(JSON.parse(review.payload_json).expectedMerchantId, "m2");
});

test("user invalidation preserves ledger history, invalidates every binding and permits a new real scan", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "posted", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T01:00:00Z" }); await store.processJob("posted");
  const original = await store.getSnapshot("posted"), details = await store.listDetails({ all: true });
  f.setTime("2026-11-02T00:00:00Z");
  const request = { reason: "上游确认用户注销", requestId: "user-invalidate-once", operatorId: "super" };
  assert.equal((await store.invalidateUser("u", request)).bindingsInvalidated, 1);
  assert.equal((await store.enqueuePayment({ orderId: "after-invalidation", userId: "u", paidTotal: "10.00", payTime: "2026-11-02T00:00:00Z" })).decision.hitMerchantId, "0");
  assert.deepEqual(await store.getSnapshot("posted"), original); assert.deepEqual(await store.listDetails({ all: true }), details);
  await store.reportScan({ userId: "u", scene: "c=m1" });
  assert.equal((await store.invalidateUser("u", request)).existed, true, "replaying an old invalidation cannot destroy a later real scan");
  assert.equal((await store.enqueuePayment({ orderId: "rescanned", userId: "u", paidTotal: "10.00", payTime: "2026-11-02T00:00:00Z" })).decision.hitMerchantId, "m1");
  assert.ok(f.tables().audit.some(row => row.action === "USER_INVALIDATE"));
});

test("wrapped SQL deadlocks retry the full transaction without consuming accounting retries or duplicating postings", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant("m1", { refundWindowDays: 0 }));
  f.setTime("2026-11-01T01:00:00Z"); await store.reportScan({ userId: "u", scene: "c=m1" });
  await store.enqueuePayment({ orderId: "contended", userId: "u", paidTotal: "100.00", payTime: "2026-11-01T01:00:00Z" });
  const base = f.source.transaction; let conflicts = 3;
  f.source.transaction = async work => {
    if (conflicts > 0) { conflicts--; throw Object.assign(new Error("sanitized SQL error"), { code: "ER_LOCK_DEADLOCK", sqlState: "40001" }); }
    return base(work);
  };
  const posted = await store.processJob("contended");
  assert.equal(posted.snapshot.splitAmount, "5.00"); assert.equal(conflicts, 0);
  assert.equal((await store.getJob("contended")).attempts, 0, "SQL lock retries are not business adjudication failures");
  assert.equal(f.tables().failure.length, 0);
  const repeated = await Promise.all(Array.from({ length: 10 }, () => f.newStore().processJob("contended")));
  assert.ok(repeated.every(result => result.existed));
  assert.equal(f.tables().snapshot.length, 1); assert.equal(f.tables().detail.length, 1);
  assert.equal((await store.listDetails({ orderId: "contended" })).sum.netAmount, "5.00");
});

test("a QR disabled between the identity hint and merchant lock cannot create a scan or binding", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant());
  const base = f.source.transaction; let changed = false;
  f.source.transaction = work => base(conn => work({ ...conn, query: async (sql, values) => {
    // Simulate rotation committing after the nonlocking QR hint, before the
    // scan obtains the merchant lock. The final locked QR read must prevail.
    if (!changed && /FROM `lxm_share_merchant` WHERE id=\? FOR UPDATE/.test(sql)) {
      changed = true; f.tables().qr.find(qr => qr.id === "qr-m1").status = "DISABLED";
    }
    return conn.query(sql, values);
  } }));
  f.setTime("2026-11-01T01:00:00Z");
  await assert.rejects(store.reportScan({ userId: "u", qrId: "qr-m1", scene: "c=m1" }), { code: "SHARE_4002" });
  assert.equal(changed, true); assert.equal(f.tables().scan.length, 0); assert.equal(f.tables().binding.length, 0);
});

test("an explicit QR ID cannot bypass a conflicting scene identifier", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant());
  await assert.rejects(store.reportScan({ userId: "u", qrId: "qr-m1", scene: "c=other" }), { code: "SHARE_4002" });
  assert.equal(f.tables().scan.length, 0); assert.equal(f.tables().binding.length, 0);
});

test("a disabled code retains error precedence when its merchant is also closed", async () => {
  const { f, store } = await ready(); await store.onboardMerchant(merchant());
  await store.rotateQr({ merchantId: "m1", id: "qr-current", scene: "c=current", imageUrl: "https://example.test/qr.png", reason: "换码", operatorId: "super", requestId: "qr-replacement" });
  await store.upsertMerchant({ merchantId: "m1", status: "CLOSED" });
  await assert.rejects(store.reportScan({ userId: "u", qrId: "qr-m1" }), { code: "SHARE_4002" });
  await assert.rejects(store.reportScan({ userId: "u", qrId: "qr-current" }), { code: "SHARE_4003" });
  assert.equal(f.tables().scan.length, 0); assert.equal(f.tables().binding.length, 0);
});

module.exports = { fixture, merchant };
