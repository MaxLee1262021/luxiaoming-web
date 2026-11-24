"use strict";

// A single-order, evidence-backed source repair. The default path only reads.
// Neither path enables revenue sharing, creates a binding, or writes a ledger.
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { isDeepStrictEqual } = require("node:util");

function fail(code) { return Object.assign(new Error(code), { code }); }
function str(value) { return String(value == null ? "" : value).trim(); }
function itemId(row) { return str(row && (row.id || row._id)); }
function safeError(error) { const code = str(error && error.code); return { code: /^\w{2,96}$/.test(code) ? code : "MERCHANT_SOURCE_REPAIR_FAILED" }; }
function parseArgs(argv) {
  const options = { root: "", orderNo: "", merchantId: "", apply: false, reason: "", operatorId: "", requestKey: "" };
  const names = { "--root": "root", "--order-no": "orderNo", "--merchant-id": "merchantId", "--reason": "reason", "--operator-id": "operatorId", "--request-key": "requestKey" };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (names[flag] && argv[index + 1] && !argv[index + 1].startsWith("--")) options[names[flag]] = argv[++index];
    else throw fail("MERCHANT_SOURCE_REPAIR_ARGUMENTS_INVALID");
  }
  if (!options.help) validateOptions(options);
  if (options.root) options.root = path.resolve(options.root);
  return options;
}
function validateOptions(options) {
  if (!str(options.root) || !str(options.orderNo) || !str(options.merchantId)
    || str(options.orderNo).length > 128 || str(options.merchantId).length > 128) throw fail("MERCHANT_SOURCE_REPAIR_ARGUMENTS_INVALID");
  if (options.apply && (!str(options.reason) || str(options.reason).length > 255 || !str(options.operatorId) || str(options.operatorId).length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(str(options.requestKey)))) throw fail("MERCHANT_SOURCE_REPAIR_AUDIT_ARGUMENTS_REQUIRED");
}
async function loadRuntime(options) {
  const installed = createRequire(path.join(options.root, "package.json"));
  installed("dotenv").config({ path: path.join(options.root, ".env"), quiet: true });
  process.env.DB_AUTO_MIGRATE = "false";
  process.chdir(options.root);
  const { source } = installed("./server/lib/selectSource.cjs")();
  try {
    const share = installed("./server/lib/merchantShare.cjs");
    const service = share.serviceFor(source);
    return { source, store: service.store, settings: service.settings, validateScene: share.validateScene, engine: installed("./server/lib/shareEngine.cjs") };
  } catch (error) { try { await source.close?.(); } catch (_) {} throw error; }
}
function originalTime(row, engine) {
  try { return engine.iso(row && (row.createTime || row.createdAt)); }
  catch (_) { throw fail("MERCHANT_SOURCE_REPAIR_ORIGINAL_TIME_INVALID"); }
}
function owner(row) { return str(row && (row.openid || row._openid || row.customerOpenid)); }
function validQrAt(qr, scan, at, engine) {
  if (!qr || itemId(qr) !== str(scan.qrId) || str(qr.merchantId) !== str(scan.merchantId) || str(qr.scene) !== str(scan.scene)) return false;
  try {
    if (engine.time(qr.createdAt) > engine.time(at)) return false;
    if (qr.disabledAt && engine.time(qr.disabledAt) <= engine.time(at)) return false;
    if (qr.status !== "ACTIVE" && !qr.disabledAt) return false;
    return true;
  } catch (_) { return false; }
}
function checkSource(row, merchantId, qr, scanId, originalAt) {
  const source = row.source && typeof row.source === "object" && !Array.isArray(row.source) ? row.source : {};
  const merchantIds = [row.shopId, source.shopId].map(str).filter(Boolean);
  if (merchantIds.some(value => value !== merchantId)) throw fail("MERCHANT_SOURCE_REPAIR_SOURCE_CONFLICT");
  const types = [row.sourceType, row.sourceChannel, source.sourceType, source.channel].map(str).filter(Boolean);
  if (types.some(value => !["direct", "natural", "miniprogram", "merchant_qrcode", "shop"].includes(value))) throw fail("MERCHANT_SOURCE_REPAIR_SOURCE_CONFLICT");
  const codes = [row.sourceCodeId, source.sourceCodeId, source.codeId].map(str).filter(Boolean);
  const scenes = [row.scene, row.sourceScene, source.scene].map(str).filter(Boolean);
  if (codes.some(value => value !== itemId(qr)) || scenes.some(value => value !== str(qr.scene))) throw fail("MERCHANT_SOURCE_REPAIR_SOURCE_CONFLICT");
  if (source.repairScanId && (str(source.repairScanId) !== scanId || str(source.validatedAt) !== originalAt)) throw fail("MERCHANT_SOURCE_REPAIR_SOURCE_CONFLICT");
  return merchantIds.length > 0 && source.repairScanId === scanId && source.validatedAt === originalAt
    && source.shopId === merchantId && source.scene === qr.scene && source.codeId === itemId(qr)
    && row.sourceCodeId === itemId(qr) && row.sourceType === "merchant_qrcode";
}
function sourceSnapshot(order) {
  const fields = ["source", "shopId", "sourceCodeId", "scene", "sourceScene", "sourceType", "sourceChannel", "sourceName", "distributorId", "bookingId", "openid", "_openid", "customerOpenid", "createTime", "createdAt", "paymentRecords", "depositPaid", "finalPaid", "finalPaidAt", "statusLogs", "shareEnqueuePending", "isDeleted", "deleted"];
  return Object.fromEntries(fields.map(key => [key, structuredClone(order[key])]));
}
async function assertNoAccounting(store, orderId) {
  const [job, snapshot] = await Promise.all([store.getJob(orderId), store.getSnapshot(orderId)]);
  if (job || snapshot) throw fail("MERCHANT_SOURCE_REPAIR_ACCOUNTING_EXISTS");
}
async function previewPayment(runtime, order, merchant, orderSource) {
  const { source, store, engine } = runtime;
  const settings = typeof runtime.settings === "function" ? runtime.settings() : runtime.settings || {};
  const enabled = !!settings.enabled && !!settings.enableAt;
  const receipt = [...(Array.isArray(order.paymentRecords) ? order.paymentRecords : [])].reverse().find(row => row.phase === "final" && row.status === "confirmed" && ["wechat_pay", "zero_balance"].includes(row.provider));
  const paidTotal = engine.formatMoney(engine.moneyToCents(order.depositPaid || "0") + engine.moneyToCents(order.finalPaid || "0"));
  const report = { paidTotal, enabled, enableAt: settings.enableAt || null, onlineFinalPaid: !!receipt, ratioAtPay: null, refundWindowDays: null, expectedShare: null, availableAt: null, eligibleAfterEnable: false };
  if (!receipt) return report;
  const payTime = engine.iso(order.finalPaidAt || receipt.paidAt || receipt.confirmedAt || order.completedAt);
  if (engine.time(orderSource.at) > engine.time(payTime)) throw fail("MERCHANT_SOURCE_REPAIR_PAYMENT_PRECEDES_ORDER");
  const event = { userId: owner(order), payTime, sessionId: order.finalPaymentSessionId || receipt.sessionId, sessionStartAt: order.finalPaymentSessionStartAt || receipt.sessionStartAt };
  const clicks = await store.getClicksAsOf(event.userId, payTime);
  const attribution = engine.resolveSource({ event, clicks, options: { csAttrDays: settings.csAttrDays ?? 7 } });
  // T2 has a separate multi-merchant historical window matrix. Do not present
  // a guessed target-merchant estimate as that matrix's accounting outcome.
  if (attribution.splitType !== "T1") throw fail("MERCHANT_SOURCE_REPAIR_T2_REVIEW_REQUIRED");
  const rule = engine.resolveRatioAt(await store.getRules(orderSource.merchantId), orderSource.merchantId, payTime);
  const atSql = engine.iso(payTime).slice(0, 23).replace("T", " ");
  const [history] = await source.transaction(conn => conn.query("SELECT status FROM lxm_share_merchant_event WHERE merchant_id=? AND event_at<=? ORDER BY event_at DESC,id DESC LIMIT 1", [orderSource.merchantId, atSql]));
  const activeAtPay = history.length > 0 && engine.activeMerchant(history[0]);
  const sourceSql = engine.iso(orderSource.at).slice(0, 23).replace("T", " ");
  const invalidated = await source.transaction(async conn => {
    const [userEvents] = await conn.query("SELECT id FROM lxm_share_user_event WHERE user_id=? AND event_at>=? AND event_at<=?", [owner(order), sourceSql, atSql]);
    const [merchantEvents] = await conn.query("SELECT status FROM lxm_share_merchant_event WHERE merchant_id=? AND event_at>=? AND event_at<=?", [orderSource.merchantId, sourceSql, atSql]);
    return userEvents.length > 0 || merchantEvents.some(row => !engine.activeMerchant(row));
  });
  const ratio = activeAtPay && !invalidated && rule ? rule.ratioT1 : "0.0000";
  const windowDays = engine.refundDays(rule?.refundWindowDays ?? merchant.refundWindowDays);
  const refunds = new Map();
  function addRefund(refundNo, amount) {
    if (!refundNo) throw fail("MERCHANT_SOURCE_REPAIR_REFUND_EVIDENCE_INVALID");
    const cents = engine.moneyToCents(amount);
    if (refunds.has(refundNo) && refunds.get(refundNo) !== cents) throw fail("MERCHANT_SOURCE_REPAIR_REFUND_EVIDENCE_INVALID");
    refunds.set(refundNo, cents);
  }
  const facts = await store.readOperationalFacts({ tables: ["refund"] });
  for (const refund of facts.refund || []) if (str(refund.orderId) === itemId(order)) addRefund(str(refund.refundNo), refund.amount);
  for (const ticket of await source.list("afterSales") || []) if (str(ticket.orderId) === itemId(order)) {
    for (const refund of ticket.refundAttempts || []) if (refund.status === "SUCCESS") {
      if (!Number.isSafeInteger(refund.amountFen) || refund.amountFen < 0) throw fail("MERCHANT_SOURCE_REPAIR_REFUND_EVIDENCE_INVALID");
      addRefund(str(refund.refundNo), engine.formatMoney(refund.amountFen));
    }
  }
  const refundedAmount = engine.formatMoney([...refunds.values()].reduce((sum, cents) => sum + cents, 0));
  const calculation = engine.finalizeDecision({ ratio, hitMerchantId: orderSource.merchantId }, { paidTotal, refundedAmount });
  return { ...report, payTime, splitType: "T1", activeAtPay, orderSourceInvalidated: invalidated, refundedAmount, ratioAtPay: ratio, refundWindowDays: windowDays,
    expectedShare: calculation.splitAmount, availableAt: new Date(engine.time(payTime) + windowDays * engine.DAY).toISOString(),
    eligibleAfterEnable: enabled && engine.time(payTime) >= engine.time(settings.enableAt) };
}
async function buildPlan(runtime, options) {
  const { source, store, engine } = runtime;
  const matches = (await source.list("orders") || []).filter(row => row.orderNo === options.orderNo);
  if (matches.length !== 1) throw fail(matches.length ? "MERCHANT_SOURCE_REPAIR_ORDER_AMBIGUOUS" : "MERCHANT_SOURCE_REPAIR_ORDER_NOT_FOUND");
  const order = matches[0], orderId = itemId(order), userId = owner(order);
  if (!orderId || !userId || order.isDeleted || order.deleted) throw fail("MERCHANT_SOURCE_REPAIR_ORDER_INVALID");
  const booking = order.bookingId ? await source.get("bookingRequests", order.bookingId) : null;
  if (order.bookingId && (!booking || owner(booking) !== userId)) throw fail("MERCHANT_SOURCE_REPAIR_BOOKING_INVALID");
  const originalAt = originalTime(booking || order, engine);
  const merchant = await store.getMerchant(options.merchantId);
  if (!merchant) throw fail("MERCHANT_SOURCE_REPAIR_MERCHANT_NOT_FOUND");
  const scans = (await store.listScanRecords()).filter(row => str(row.userId) === userId && engine.time(row.scanAt) <= engine.time(originalAt));
  const qrCache = new Map(), eligible = [];
  for (const scan of scans) {
    const merchantId = str(scan.merchantId);
    if (!qrCache.has(merchantId)) qrCache.set(merchantId, await store.listQrs(merchantId));
    const qr = qrCache.get(merchantId).find(row => itemId(row) === str(scan.qrId));
    if (!validQrAt(qr, scan, scan.scanAt, engine) || !validQrAt(qr, scan, originalAt, engine)) continue;
    try { runtime.validateScene(qr.scene); } catch (_) { continue; }
    eligible.push({ scan, qr });
  }
  const merchantIds = new Set(eligible.map(({ scan }) => str(scan.merchantId)));
  if (merchantIds.size > 1) throw fail("MERCHANT_SOURCE_REPAIR_SCAN_AMBIGUOUS");
  if (!eligible.length || !merchantIds.has(options.merchantId)) throw fail("MERCHANT_SOURCE_REPAIR_SCAN_NOT_FOUND");
  eligible.sort((a, b) => engine.time(b.scan.scanAt) - engine.time(a.scan.scanAt) || str(b.scan.id).localeCompare(str(a.scan.id)));
  const { scan, qr } = eligible[0], matchedScanId = str(scan.id);
  if (!matchedScanId) throw fail("MERCHANT_SOURCE_REPAIR_SCAN_INVALID");
  const atSql = engine.iso(originalAt).slice(0, 23).replace("T", " ");
  const [merchantHistory] = await source.transaction(conn => conn.query("SELECT status FROM lxm_share_merchant_event WHERE merchant_id=? AND event_at<=? ORDER BY event_at DESC,id DESC LIMIT 1", [options.merchantId, atSql]));
  if (!merchantHistory.length || !engine.activeMerchant(merchantHistory[0])) throw fail("MERCHANT_SOURCE_REPAIR_MERCHANT_INACTIVE_AT_CHECKOUT");
  const alreadyRepaired = checkSource(order, options.merchantId, qr, matchedScanId, originalAt);
  if (booking) checkSource(booking, options.merchantId, qr, matchedScanId, originalAt);
  if (!alreadyRepaired) await assertNoAccounting(store, orderId);
  const orderSource = { merchantId: options.merchantId, qrId: itemId(qr), scene: qr.scene, at: originalAt };
  const financial = await previewPayment(runtime, order, merchant, orderSource);
  const expected = sourceSnapshot(order);
  const planHash = crypto.createHash("sha256").update(JSON.stringify({ orderId, orderSource, matchedScanId, expected })).digest("hex");
  const report = { orderNo: `****${str(order.orderNo).slice(-4)}`, merchantId: options.merchantId, merchantName: str(merchant.name),
    matchedScanId, scanAt: engine.iso(scan.scanAt), originalAt, alreadyRepaired, ...financial, planHash };
  return { report, order, booking, expected, orderSource, matchedScanId, alreadyRepaired };
}
async function runRecovery(options, dependencies = {}) {
  const report = { ok: false, dryRun: options.apply !== true, applied: false };
  let runtime;
  try {
    validateOptions(options);
    runtime = dependencies.source ? dependencies : await (dependencies.loadRuntime || loadRuntime)(options);
    const plan = await buildPlan(runtime, options);
    Object.assign(report, plan.report);
    if (!options.apply || plan.alreadyRepaired) { report.ok = true; return report; }
    const { source, store, engine } = runtime;
    if (typeof source.compareAndUpdate !== "function") throw fail("MERCHANT_SOURCE_REPAIR_CAS_REQUIRED");
    const orderId = itemId(plan.order);
    const audit = { requestKey: options.requestKey, reason: options.reason, matchedScanId: plan.matchedScanId,
      planHash: plan.report.planHash, orderSource: plan.orderSource, previousSource: { source: plan.order.source || null, shopId: plan.order.shopId || "", sourceCodeId: plan.order.sourceCodeId || "", sourceType: plan.order.sourceType || "" } };
    await store.audit("ORDER_SOURCE_REPAIR_ATTEMPT", orderId, audit, options.operatorId);
    await assertNoAccounting(store, orderId);
    if (plan.booking) {
      const current = await source.get("bookingRequests", itemId(plan.booking));
      if (!isDeepStrictEqual(sourceSnapshot(current || {}), sourceSnapshot(plan.booking))) throw fail("MERCHANT_SOURCE_REPAIR_BOOKING_CHANGED");
    }
    const now = engine.iso(dependencies.now ? dependencies.now() : new Date());
    const frozen = { ...(plan.order.source || {}), shopId: options.merchantId, shopName: report.merchantName,
      codeId: plan.orderSource.qrId, sourceCodeId: plan.orderSource.qrId, scene: plan.orderSource.scene,
      sourceType: "merchant_qrcode", channel: "merchant_qrcode", validatedAt: plan.orderSource.at,
      repairScanId: plan.matchedScanId, repairRequestKey: options.requestKey };
    const patch = { shopId: options.merchantId, source: frozen, scene: plan.orderSource.scene, sourceScene: plan.orderSource.scene,
      sourceCodeId: plan.orderSource.qrId, sourceType: "merchant_qrcode", sourceChannel: "merchant_qrcode", sourceName: report.merchantName,
      ...(report.onlineFinalPaid ? { shareEnqueuePending: true } : {}),
      statusLogs: [...(Array.isArray(plan.order.statusLogs) ? plan.order.statusLogs : []), { type: "商家来源修复", action: "依据下单前持久扫码补正来源", operatorId: options.operatorId,
        reason: options.reason, requestKey: options.requestKey, matchedScanId: plan.matchedScanId, planHash: report.planHash, createTime: now }] };
    const saved = await source.compareAndUpdate("orders", orderId, plan.expected, patch);
    if (!saved) throw fail("MERCHANT_SOURCE_REPAIR_ORDER_CHANGED");
    report.applied = true;
    await store.audit("ORDER_SOURCE_REPAIR_APPLIED", orderId, { ...audit, appliedAt: now }, options.operatorId);
    // A separate running worker cannot participate in the generic document
    // CAS. Surface any accounting race for review, without changing its money.
    const [job, snapshot] = await Promise.all([store.getJob(orderId), store.getSnapshot(orderId)]);
    if (job || snapshot) throw fail("MERCHANT_SOURCE_REPAIR_CONCURRENT_ACCOUNTING_REVIEW");
    report.ok = true;
    return report;
  } catch (error) { Object.assign(report, safeError(error)); return report; }
  finally {
    if (runtime?.source?.close) try { await runtime.source.close(); } catch (error) { report.ok = false; report.closeError = safeError(error); }
  }
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write("Usage: node recover-merchant-order-source.cjs --root /opt/luxiaoming-admin --order-no ORDER_NO --merchant-id MERCHANT_ID [--apply --reason REASON --operator-id OPERATOR_ID --request-key REQUEST_KEY]\nDefault: read-only evidence and amount plan. Apply only repairs this order's frozen source and queues the existing payment observer; it never enables sharing or writes commission money.\n");
    return;
  }
  const report = await runRecovery(options);
  process.stdout.write(JSON.stringify(report) + "\n");
  if (!report.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, ...safeError(error) }) + "\n"); process.exitCode = 1; });
module.exports = { parseArgs, runRecovery, buildPlan, safeError };
