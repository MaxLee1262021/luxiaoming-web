"use strict";

const crypto = require("node:crypto");
const { serviceFor, enqueuePaidOrder } = require("./merchantShare.cjs");
const { createLogger } = require("./observability.cjs");
const { time, iso, periodAt, moneyToCents, formatMoney, DAY, HOUR } = require("./shareEngine.cjs");

const SCHEDULES = Object.freeze([
  { name: "PAYMENT_GAP_COMPENSATION", hour: 3, minute: 30, intervalMs: DAY },
  { name: "REFUND_REVERSAL_SCAN", hourly: true, intervalMs: HOUR },
  { name: "UNCONFIGURED_MERCHANTS", hour: 9, minute: 0, intervalMs: DAY },
  { name: "DAILY_METRICS", hour: 1, minute: 15, intervalMs: DAY },
]);
function dateAt(value) { return new Date(time(value) + 8 * HOUR).toISOString().slice(0, 10); }
function latestSlot(schedule, value) {
  const local = time(value) + 8 * HOUR;
  const slot = schedule.hourly ? Math.floor(local / HOUR) * HOUR
    : Math.floor(local / DAY) * DAY + schedule.hour * HOUR + schedule.minute * 60000;
  return new Date((slot > local ? slot - schedule.intervalMs : slot) - 8 * HOUR).toISOString();
}
function finalReceipt(order) {
  return [...(order.paymentRecords || [])].reverse().find(row => row.phase === "final" && row.status === "confirmed" && ["wechat_pay", "zero_balance"].includes(row.provider));
}
function paidAt(order) { const receipt = finalReceipt(order); return receipt && (order.finalPaidAt || receipt.paidAt || receipt.confirmedAt || order.completedAt); }
function eligible(orders, enableAt) {
  return (orders || []).filter(order => paidAt(order) && time(paidAt(order)) >= time(enableAt))
    .sort((a, b) => time(paidAt(a)) - time(paidAt(b)) || String(a.id || a._id).localeCompare(String(b.id || b._id)));
}
function createShareWorker(source, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || createLogger({ service: "merchant-share-worker" });
  const clock = options.clock || (() => new Date());
  const service = options.service || { settings: () => ({ enabled: !!env.SHARE_ENABLE_AT, enableAt: env.SHARE_ENABLE_AT || null }), get store() { return serviceFor(source).store; } };
  const physical = () => options.physicalService || require("./physicalCommerce.cjs").serviceFor(source);
  const isPhysical = value => /^physical[_-]/.test(String(value || ""));
  let running = false, timer = null, lastRecovery = 0, stopping = false;
  const activeTasks = new Set();
  function tracked(work) {
    const promise = Promise.resolve().then(work); activeTasks.add(promise);
    promise.then(() => activeTasks.delete(promise), () => activeTasks.delete(promise)); return promise;
  }
  const enabled = () => { const settings = service.settings(); return !!settings.enabled && !!settings.enableAt && time(clock()) >= time(settings.enableAt); };
  async function notify(event) {
    const body = event.payloadJson || {};
    const p0 = body.priority === "P0" || ["SHARE_JOB_FAILED", "SPLIT_OVER_BASE", "DUPLICATE_SNAPSHOT", "MERCHANT_SPIKE"].includes(event.eventType);
    const endpoint = p0 ? env.SHARE_PHONE_ALERT_URL : env.SHARE_ALERT_WEBHOOK_URL;
    if (!endpoint) throw Object.assign(new Error("分成通知通道未配置"), { code: "SHARE_ALERT_NOT_CONFIGURED" });
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && env.NODE_ENV !== "test") throw new Error("分成通知需使用HTTPS");
    const response = await (options.fetch || fetch)(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": String(event.id) },
      body: JSON.stringify({ eventId: event.id, type: event.eventType, ...body }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Object.assign(new Error("分成通知发送失败"), { code: "SHARE_ALERT_DELIVERY_FAILED" });
  }
  async function emit(key, type, payload) {
    const at = iso(clock()).slice(0, 23).replace("T", " ");
    await source.transaction(conn => conn.query("INSERT IGNORE INTO lxm_share_outbox (event_key,event_type,payload_json,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", [key, type, JSON.stringify(payload), "PENDING", 0, at, at, at]));
  }
  async function pendingOrders() {
    const ids = await source.transaction(async conn => {
      const [rows] = await conn.query("SELECT DISTINCT record_id FROM lxm_collection_values WHERE collection_name='orders' AND path IN ('shareEnqueuePending','shareRefundPending') AND value_bool=1 ORDER BY record_id LIMIT 100");
      return rows.map(row => String(row.record_id));
    });
    const orders = [];
    for (const id of ids) { const order = await source.get("orders", id); if (order) orders.push(order); }
    return orders;
  }
  async function enqueueOrders(orders) {
    const result = { scanned: 0, queued: 0, failed: 0 };
    for (const order of eligible(orders, service.settings().enableAt)) {
      result.scanned++;
      try {
        await enqueuePaidOrder(source, order); result.queued++;
        if (order.shareEnqueuePending) await source.update("orders", order.id || order._id, { shareEnqueuePending: false });
      } catch (error) { result.failed++; logger.error("share.payment.recovery.failed", { orderId: order.id || order._id, errorCode: error.code || "SHARE_5001" }); }
    }
    return result;
  }
  async function refundScan({ full = true, orders = null, now = clock() } = {}) {
    let tickets;
    const physicalIds = new Set((orders || []).map(order => String(order.id || order._id)).filter(isPhysical));
    if (full) tickets = await source.list("afterSales");
    else if (orders && orders.length) {
      const ids = orders.map(order => String(order.id || order._id)).filter(id => !isPhysical(id));
      const ticketIds = ids.length ? await source.transaction(async conn => {
        const [rows] = await conn.query("SELECT id FROM lxm_afterSales WHERE orderId IN (" + ids.map(() => "?").join(",") + ")", ids);
        return rows.map(row => row.id);
      }) : [];
      tickets = [];
      for (const id of ticketIds) { const ticket = await source.get("afterSales", id); if (ticket) tickets.push(ticket); }
    } else tickets = [];
    const facts = new Map();
    for (const ticket of tickets || []) {
      const refunds = (ticket.refundAttempts || []).filter(row => row.status === "SUCCESS").map(row => ({
        refundNo: row.refundNo, amount: formatMoney(row.amountFen), refundAt: row.successTime || ticket.updatedAt || now,
      }));
      if (refunds.length) {
        const order = await source.get("orders", ticket.orderId);
        if (!order || !paidAt(order) || time(paidAt(order)) < time(service.settings().enableAt)) continue;
        facts.set(String(ticket.orderId), [...(facts.get(String(ticket.orderId)) || []), ...refunds]);
      }
    }
    if (full) for (const orderId of await service.store.listRefundOrderIds()) {
      if (isPhysical(orderId)) physicalIds.add(orderId);
      else if (!facts.has(orderId)) facts.set(orderId, []);
    }
    // Read durable commerce refunds before a due snapshot, even if its
    // delivery task has not run yet. Shipping refunds do not reduce goods.
    for (const orderId of physicalIds) facts.set(orderId, await physical().getShareRefunds(orderId));
    const result = { scanned: facts.size, repaired: 0, overdue: 0, failed: 0 };
    for (const [orderId, refunds] of facts) {
      try {
        const repair = await service.store.reconcileRefundReversals(orderId, { refunds, now });
        if (repair.factsAdded > 0 || moneyToCents(repair.repairedAmount) > 0) await service.store.reviewPostedFacts({ orderId, kind: "REFUND_RECONCILIATION", now });
        if (moneyToCents(repair.repairedAmount) > 0) result.repaired++;
        if (repair.overdue) result.overdue++;
      } catch (error) { result.failed++; logger.error("share.refund.recovery.failed", { orderId, errorCode: error.code || "SHARE_5001" }); }
    }
    return result;
  }
  async function recover({ full = false } = {}) {
    // Provider reconciliation remains active even while referral accounting is disabled.
    if (options.wechatPay?.isConfigured()) await require("./onlineRefunds.cjs").reconcilePendingRefunds(source, { wechatPay: options.wechatPay, limit: 50 });
    if (!enabled()) return { skipped: true, reason: "SHARE_NOT_ENABLED" };
    const orders = full ? await source.list("orders") : await pendingOrders();
    const payments = await enqueueOrders(full ? orders : orders.filter(order => order.shareEnqueuePending));
    const refunds = full ? { scanned: 0, failed: 0 } : await refundScan({ full: false, orders: orders.filter(order => order.shareRefundPending) });
    return { ...payments, refundFailures: refunds.failed, failed: payments.failed + refunds.failed };
  }
  async function refreshPending() {
    const maximumPages = Math.max(1, Math.min(Number(options.pendingRefreshPages) || 10, 1000));
    const summary = { refreshed: 0, failed: 0, finished: false, pages: 0 };
    for (let page = 0; page < maximumPages; page++) {
      const result = await service.store.refreshPendingBatch({ now: clock(), limit: 100 });
      summary.refreshed += result.refreshed; summary.failed += result.failed; summary.pages++;
      if (result.finished) { summary.finished = true; break; }
    }
    if (!summary.finished || summary.failed) logger.warn("share.pending.refresh.partial", summary);
    return summary;
  }
  async function synchronizeAttribution(event) {
    const orderId = String(event.payloadJson?.orderId || "");
    if (!orderId) throw Object.assign(new Error("分成来源投影缺少订单"), { code: "SHARE_PROJECTION_ORDER_MISSING" });
    const effective = await service.store.getEffectiveAttribution(orderId);
    const state = effective.state;
    if (!state) throw Object.assign(new Error("分成正式快照不存在"), { code: "SHARE_PROJECTION_SNAPSHOT_MISSING" });
    const revision = Number(effective.revisionNo || 0);
    const projection = { shareOrderSource: state.splitType === "T2" ? "SERVICE" : "SELF", shareServiceStaffId: state.staffId || null,
      shareCsClickId: state.csClickId || null, shareSourceReason: state.sourceReason || "NONE", shareAttributionRevision: revision };
    if (isPhysical(orderId)) return physical().markShareAttribution(orderId, projection);
    if (typeof source.get !== "function") throw Object.assign(new Error("分成来源投影缺少订单"), { code: "SHARE_PROJECTION_ORDER_MISSING" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const order = await source.get("orders", orderId);
      if (!order) throw Object.assign(new Error("分成关联订单不存在"), { code: "SHARE_PROJECTION_ORDER_MISSING" });
      if (Number(order.shareAttributionRevision || 0) > revision || Object.entries(projection).every(([key, value]) => order[key] === value)) return true;
      let saved;
      if (typeof source.compareAndUpdate === "function") saved = await source.compareAndUpdate("orders", orderId, { shareAttributionRevision: order.shareAttributionRevision }, projection);
      else if (typeof source.update === "function") saved = await source.update("orders", orderId, projection);
      else throw Object.assign(new Error("分成订单来源投影存储不可用"), { code: "SHARE_PROJECTION_STORAGE_UNAVAILABLE" });
      if (saved) return true;
    }
    throw Object.assign(new Error("分成来源投影并发冲突"), { code: "SHARE_PROJECTION_CONCURRENT" });
  }
  async function unconfigured(slotAt) {
    const merchants = await service.store.listMerchants({});
    const ids = merchants.filter(row => row.unconfigured).map(row => row.merchantId || row.id);
    if (ids.length) await emit("unconfigured:" + dateAt(slotAt), "UNCONFIGURED_MERCHANTS", { merchantIds: ids, priority: "P1" });
    return { unconfigured: ids.length };
  }
  async function metrics({ slotAt = clock() } = {}) {
    const end = time(dateAt(slotAt) + "T00:00:00+08:00");
    const start = end - DAY, date = dateAt(new Date(start));
    const facts = await service.store.readOperationalFacts();
    const jobs = facts.job, snapshots = facts.snapshot, details = facts.detail;
    const dayJobs = jobs.filter(job => time(job.payTime) >= start && time(job.payTime) < end);
    const dayObservations = facts.observation.filter(row => time(row.occurredAt) >= start && time(row.occurredAt) < end);
    const byOrder = new Map();
    for (const snapshot of snapshots) byOrder.set(snapshot.orderId, [...(byOrder.get(snapshot.orderId) || []), snapshot]);
    for (const snapshot of snapshots) if (moneyToCents(snapshot.splitAmount) > Math.min(moneyToCents(snapshot.paidTotal), moneyToCents(snapshot.baseAmount))) {
      await service.store.recordRisk({ entityType: "ORDER", entityId: snapshot.orderId, code: "SPLIT_OVER_BASE", priority: "P0", payload: { freezeSettlement: true } });
      await emit("A1:" + snapshot.orderId, "SPLIT_OVER_BASE", { orderId: snapshot.orderId, priority: "P0", freezeSettlement: true });
    }
    for (const [orderId, entries] of byOrder) if (entries.length > 1) {
      await service.store.recordRisk({ entityType: "ORDER", entityId: orderId, code: "DUPLICATE_SNAPSHOT", priority: "P0", payload: { freezeSettlement: true } });
      await emit("A2:" + orderId, "DUPLICATE_SNAPSHOT", { orderId, priority: "P0", freezeSettlement: true });
    }
    const merchantAmounts = new Map();
    for (const detail of details) {
      const at = time(detail.createdAt);
      if (at < start - 7 * DAY || at >= end) continue;
      const bucket = merchantAmounts.get(detail.merchantId) || { today: 0, previous: 0 };
      bucket[at >= start ? "today" : "previous"] += moneyToCents(detail.amount, { signed: true }); merchantAmounts.set(detail.merchantId, bucket);
    }
    for (const [merchantId, amount] of merchantAmounts) if (amount.today > 0 && amount.today * 7 > Math.max(0, amount.previous) * 3) {
      await emit("A3:" + date + ":" + merchantId, "MERCHANT_SPIKE", { merchantId, date, amount: formatMoney(amount.today), previousSevenDays: formatMoney(amount.previous), priority: "P0" });
    }
    const userCounts = new Map();
    for (const job of dayJobs) if (job.decisionJson.splitType === "T1" && job.decisionJson.hitMerchantId !== "0" && Number(job.decisionJson.ratio) > 0)
      userCounts.set(job.userId, (userCounts.get(job.userId) || 0) + 1);
    for (const [userId, count] of userCounts) if (count > 20) {
      const subjectHash = crypto.createHash("sha256").update(userId).digest("hex");
      await service.store.recordRisk({ entityType: "USER", entityId: subjectHash, code: "USER_FREQUENT_ORDERS", priority: "P1", payload: { date, count, automaticBlock: false } });
      await emit("A5:" + date + ":" + subjectHash, "USER_FREQUENT_ORDERS", { subjectHash, count, date, priority: "P1", automaticBlock: false });
    }
    // Metric windows may catch up historical slots. Financial repair entries
    // always use execution time, never the historical metric slot.
    const repairs = await refundScan({ full: true, now: clock() });
    const online = eligible(await source.list("orders"), service.settings().enableAt).filter(order => time(paidAt(order)) < end);
    const queued = new Set(jobs.map(job => job.orderId));
    const mature = jobs.filter(job => time(job.availableAt) <= time(slotAt));
    const covered = mature.filter(job => byOrder.has(job.orderId)).length;
    const scenes = dayObservations.filter(row => row.metricKey === "SCENE_PARSE");
    const sceneFailures = scenes.filter(row => !Number(row.success)).length;
    const latencies = dayObservations.filter(row => row.metricKey === "JUDGE_DURATION_MS" && row.valueNumber != null).map(row => Number(row.valueNumber)).sort((a, b) => a - b);
    const clickDay = facts.click.filter(row => time(row.clickAt) >= start && time(row.clickAt) < end);
    const issuedLinks = new Map((facts.cs_link || []).map(link => [link.linkId, link.staffId]));
    const perStaff = new Map();
    for (const click of clickDay) {
      const attributableStaff = click.staffId || issuedLinks.get(click.linkId);
      const key = attributableStaff ? crypto.createHash("sha256").update(attributableStaff).digest("hex") : "unmapped";
      const bucket = perStaff.get(key) || { subjectHash: key, total: 0, missing: 0 };
      bucket.total++; if (!click.staffId) bucket.missing++; perStaff.set(key, bucket);
    }
    const missing = dayJobs.filter(job => String(job.decisionJson.sourceFlag || "").includes("cs_link_missing")).length;
    const truncated = dayJobs.filter(job => job.decisionJson.candidateJson?.truncated).length;
    const refundedAtEnd = new Map();
    for (const refund of facts.refund) if (time(refund.refundAt) < end) refundedAtEnd.set(refund.orderId, (refundedAtEnd.get(refund.orderId) || 0) + moneyToCents(refund.amount));
    const qrHashes = new Set((facts.qr || []).map(qr => crypto.createHash("sha256").update(String(qr.id)).digest("hex")));
    const citySamples = dayObservations.filter(row => row.metricKey === "SCAN_CITY" && Number(row.success) === 1 && row.valueText && qrHashes.has(row.subjectHash));
    const citiesByQr = new Map();
    for (const sample of citySamples) { const cities = citiesByQr.get(sample.subjectHash) || new Set(); cities.add(String(sample.valueText).trim()); citiesByQr.set(sample.subjectHash, cities); }
    const crossCity = [...citiesByQr].filter(([, cities]) => cities.size > 1);
    for (const [subjectHash, cities] of crossCity) await emit("scan-cross-city:" + date + ":" + subjectHash, "SHARE_QR_CROSS_CITY", { date, subjectHash, cities: [...cities], priority: "P1", automaticBlock: false });
    let scanDropQrCount = 0;
    for (const qr of (facts.qr || []).filter(row => row.status === "ACTIVE")) {
      const scans = (facts.scan || []).filter(scan => scan.qrId === qr.id);
      const currentCount = scans.filter(scan => time(scan.scanAt) >= start && time(scan.scanAt) < end).length;
      const previousCount = scans.filter(scan => time(scan.scanAt) >= start - 7 * DAY && time(scan.scanAt) < start).length;
      if (previousCount > 0 && currentCount * 70 <= previousCount) {
        scanDropQrCount++;
        await emit("scan-drop:" + date + ":" + qr.id, "SHARE_QR_SCAN_DROP", { date, qrId: qr.id, currentCount, previousSevenDayCount: previousCount, priority: "P1", automaticBlock: false });
      }
    }
    const disputes = dayObservations.filter(row => row.metricKey === "ATTRIBUTION_DISPUTE");
    const observations = {
      date, slotAt: iso(slotAt), eligiblePaidOrders: online.length, queuedOrders: online.filter(order => queued.has(String(order.id || order._id))).length,
      queueCoverage: online.length ? online.filter(order => queued.has(String(order.id || order._id))).length / online.length : 1,
      matureOrders: mature.length, snapshots: covered, coverage: mature.length ? covered / mature.length : 1,
      pendingRefundWindow: jobs.filter(job => time(job.availableAt) > time(slotAt)).length,
      t1Orders: dayJobs.filter(job => job.decisionJson.splitType === "T1").length, t2Orders: dayJobs.filter(job => job.decisionJson.splitType === "T2").length,
      expiredToPlatformAmount: formatMoney(dayJobs.filter(job => job.decisionJson.hitReason === "NO_MERCHANT_IN_WINDOW").reduce((sum, job) => sum + Math.max(0, moneyToCents(job.paidTotal) - (refundedAtEnd.get(job.orderId) || 0)), 0)),
      disputedOrders: disputes.length ? new Set(disputes.map((row, index) => row.subjectHash || row.id || String(index))).size : null,
      disputeMonitoringAvailable: disputes.length > 0, disputeSource: disputes.length ? "recorded_observations" : "NOT_SAMPLED",
      cityMonitoringAvailable: citySamples.length > 0, crossCityQrCount: citySamples.length ? crossCity.length : null, scanDropQrCount,
      sceneSamples: scenes.length, sceneFailures, sceneFailureRate: scenes.length ? sceneFailures / scenes.length : null,
      csLinkMissing: missing, csLinkMissingRate: dayJobs.length ? missing / dayJobs.length : 0, clickMissingByStaff: [...perStaff.values()].map(bucket => ({ ...bucket, missingRate: bucket.missing / bucket.total })),
      candidateTruncated: truncated, judgeP99Ms: latencies.length ? latencies[Math.ceil(latencies.length * .99) - 1] : null,
      queueBacklog: jobs.filter(job => job.status === "PENDING" && time(job.availableAt) <= time(slotAt)).length, refundRepairs: repairs,
    };
    observations.disputeRate = dayJobs.length && disputes.length ? observations.disputedOrders / dayJobs.length : null;
    observations.t1Ratio = dayJobs.length ? observations.t1Orders / dayJobs.length : 0;
    observations.t2Ratio = dayJobs.length ? observations.t2Orders / dayJobs.length : 0;
    if (repairs.failed) throw Object.assign(new Error("退款补偿未全部完成"), { code: "SHARE_REFUND_REPAIR_FAILED" });
    await service.store.saveMetricSnapshot({ slotAt, date, metrics: observations });
    if (observations.coverage < .999 || observations.queueCoverage < .999) await emit("coverage:" + date, "SHARE_COVERAGE_LOW", { date, coverage: observations.coverage, queueCoverage: observations.queueCoverage, priority: "P1" });
    if (observations.sceneFailureRate !== null && observations.sceneFailureRate >= .01) await emit("scene:" + date, "SHARE_SCENE_FAILURES", { date, rate: observations.sceneFailureRate, priority: "P1" });
    if (observations.csLinkMissingRate > .2) await emit("cs-missing:" + date, "SHARE_CS_LINK_MISSING", { date, rate: observations.csLinkMissingRate, priority: "P1" });
    for (const bucket of observations.clickMissingByStaff) if (bucket.subjectHash !== "unmapped" && bucket.missingRate > .2)
      await emit("cs-missing:" + date + ":" + bucket.subjectHash, "SHARE_CS_LINK_MISSING", { date, subjectHash: bucket.subjectHash, rate: bucket.missingRate, priority: "P1" });
    if (truncated) await emit("candidate-truncated:" + date, "SHARE_CANDIDATE_TRUNCATED", { date, count: truncated, priority: "P1" });
    if ((observations.judgeP99Ms || 0) >= 50 || observations.queueBacklog >= 100) await emit("engine-health:" + date, "SHARE_ENGINE_HEALTH", { date, p99Ms: observations.judgeP99Ms, backlog: observations.queueBacklog, priority: "P1" });
    return observations;
  }
  async function runSchedules(now) {
    const completed = [];
    for (const schedule of SCHEDULES) {
      if (stopping) break;
      const slotAt = latestSlot(schedule, now);
      if (time(slotAt) < time(service.settings().enableAt)) continue;
      const claim = await service.store.claimScheduledSlot({ name: schedule.name, slotAt, intervalMs: schedule.intervalMs, now, leaseSeconds: 300 });
      if (!claim.claimed) continue;
      if (claim.skippedSlots) logger.warn("share.schedule.catchup", { taskName: schedule.name, skippedSlots: claim.skippedSlots, slotAt });
      const lease = setInterval(() => service.store.renewScheduledSlot({ ...claim, now: clock() }).catch(error => logger.error("share.schedule.lease.failed", { taskName: schedule.name, errorCode: error.code || "SHARE_5001" })), 30000);
      lease.unref();
      try {
        let result;
        if (schedule.name === "PAYMENT_GAP_COMPENSATION") result = await recover({ full: true });
        else if (schedule.name === "REFUND_REVERSAL_SCAN") result = await refundScan({ full: true, now });
        else if (schedule.name === "UNCONFIGURED_MERCHANTS") result = await unconfigured(slotAt);
        else result = await metrics({ slotAt });
        if (result.failed) throw Object.assign(new Error("定时任务部分失败"), { code: "SHARE_SCHEDULE_PARTIAL_FAILURE" });
        const saved = await service.store.completeScheduledSlot({ ...claim, nextSlotAt: new Date(time(claim.slotAt) + schedule.intervalMs), now: clock(), result });
        if (saved) completed.push(schedule.name);
      } catch (error) {
        await service.store.failScheduledSlot({ ...claim, now: clock(), errorCode: error.code || "SHARE_SCHEDULE_FAILED" });
        logger.error("share.schedule.failed", { taskName: schedule.name, slotAt, errorCode: error.code || "SHARE_SCHEDULE_FAILED" });
      } finally { clearInterval(lease); }
    }
    return completed;
  }
  function schedules(now) { return stopping ? Promise.resolve([]) : tracked(() => runSchedules(now)); }
  async function runTick() {
    if (running) return { skipped: true };
    running = true;
    try {
      const now = clock();
      if (time(now) - lastRecovery >= 60000) { await recover(); if (enabled()) await refreshPending(); lastRecovery = time(now); }
      if (!enabled()) return { skipped: true, reason: "SHARE_NOT_ENABLED" };
      const jobs = await service.store.listDueJobs({ now: clock(), limit: 100 });
      for (const job of jobs) try {
        const refunds = await refundScan({ full: false, orders: [{ id: job.orderId }], now: clock() });
        if (refunds.failed) throw Object.assign(new Error("成熟前退款事实未全部同步"), { code: "SHARE_REFUND_REPAIR_FAILED" });
        await service.store.processJob(job.orderId, { now: clock() });
      }
      catch (error) { logger.warn("share.job.failed", { orderId: job.orderId, errorCode: error.code || "SHARE_5001" }); }
      const ran = await schedules(clock());
      const events = await service.store.listOutbox({ now: clock(), limit: 100 });
      for (const event of events) try {
        if (["SHARE_SNAPSHOT_CREATED", "SHARE_SNAPSHOT_CORRECTED"].includes(event.eventType)) await synchronizeAttribution(event);
        if (event.eventType === "SHARE_SNAPSHOT_CORRECTED") await service.store.reviewPostedFacts({ orderId: event.payloadJson?.orderId, kind: "CORRECTED_FACT", now: clock() });
        if (event.eventType === "SHARE_PAYMENT_QUEUED") await service.store.reviewPostedFacts({ orderId: event.payloadJson?.orderId, now: clock() });
        if (event.eventType === "SHARE_REFUND_RECORDED") await service.store.reviewPostedFacts({ orderId: event.payloadJson?.orderId, refundNo: event.payloadJson?.refundNo, now: clock() });
        if (!["SHARE_PAYMENT_QUEUED", "SHARE_SNAPSHOT_CREATED", "SHARE_REFUND_RECORDED"].includes(event.eventType)) await notify(event);
        await service.store.acknowledgeOutbox(event.id);
      } catch (error) { await service.store.failOutbox(event.id); logger.warn("share.alert.pending", { eventId: event.id, errorCode: error.code || "SHARE_ALERT_FAILED" }); }
      return { processed: jobs.length, events: events.length, schedules: ran, period: periodAt(clock()) };
    } finally { running = false; }
  }
  function tick() { return stopping ? Promise.resolve({ skipped: true, reason: "SHARE_WORKER_STOPPED" }) : tracked(runTick); }
  function start() { if (!timer) { stopping = false; timer = setInterval(() => tick().catch(error => logger.error("share.worker.failed", { errorCode: error.code || "SHARE_5001" })), 1000); timer.unref(); } }
  function stop() { stopping = true; if (timer) clearInterval(timer); timer = null; return Promise.allSettled([...activeTasks]); }
  return { start, stop, tick, recover, refundScan, metrics, schedules, refreshPending, synchronizeAttribution };
}
module.exports = { createShareWorker, SCHEDULES, latestSlot };
