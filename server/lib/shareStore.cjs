"use strict";

// All writes use the native connection supplied by source.transaction. No
// generic collection CRUD is called inside these transactions, and production
// never substitutes an in-memory ledger when MySQL is unavailable.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const engine = require("./shareEngine.cjs");
const { recordDatabaseOperation } = require("./observability.cjs");
const { id, shareError, time, iso, moneyToCents, formatMoney, periodAt } = engine;
const DATES = {
  merchant: ["created_at", "updated_at"], merchant_event: ["event_at"], rule: ["effective_from", "created_at"],
  qr: ["created_at", "disabled_at"], scan: ["scan_at"], binding: ["first_scan_at", "last_scan_at", "updated_at"],
  binding_event: ["scan_at", "event_at"], click: ["click_at"], cs_link: ["expires_at", "created_at"],
  job: ["pay_time", "available_at", "next_attempt_at", "created_at", "updated_at"],
  snapshot: ["judge_time", "available_at", "created_at"], detail: ["created_at"],
  refund: ["refund_at", "created_at"], correction: ["created_at"], outbox: ["next_attempt_at", "created_at", "updated_at"], failure: ["created_at"], audit: ["created_at"],
  schedule: ["slot_at", "next_slot_at", "lease_until", "next_attempt_at", "updated_at"], schedule_run: ["slot_at", "started_at", "finished_at"],
  metric: ["slot_at", "created_at"], observation: ["occurred_at"], risk: ["created_at"],
  pending_cursor: ["last_pay_time", "updated_at"], user_event: ["event_at"],
};
const DATE_FIELDS = new Set(Object.values(DATES).flat());
const MERCHANT_META = { onboardRequestHash: 64, contact: 255, phone: 64, address: 4000, account: 128, businessLicenseNo: 128,
  invoiceTitle: 255, taxNo: 128, bankName: 255, bankAccount: 128, accountHolder: 255 };
function snake(value) { return value.replace(/[A-Z]/g, letter => "_" + letter.toLowerCase()); }
function camel(value) { return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()); }
function dbTime(value) { return iso(value).slice(0, 23).replace("T", " "); }
function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}
function hydrate(row) {
  if (!row) return null;
  const result = {};
  for (const [key, value] of Object.entries(row)) result[camel(key)] = value instanceof Date ? value.toISOString()
    : DATE_FIELDS.has(key) && typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value.replace(" ", "T") + "Z"
    : /_json$/.test(key) ? parseJson(value) : typeof value === "bigint" ? String(value) : value;
  for (const key of ["id", "merchantId", "userId", "orderId", "staffId", "csClickId", "snapshotId", "lastScanId", "scanId", "hitMerchantId"]) {
    if (result[key] != null) result[key] = String(result[key]);
  }
  for (const key of ["paidTotal", "amount", "baseAmount", "splitAmount", "refundedBeforeSnapshot"]) {
    if (result[key] != null) result[key] = formatMoney(moneyToCents(result[key], { signed: key === "amount" }));
  }
  for (const key of ["ratioT1", "ratioT2", "ratio"]) if (result[key] != null) result[key] = Number(result[key]).toFixed(4);
  for (const key of ["versionNo", "ruleVersion", "ttlHours", "refundWindowDays", "attempts", "qrSeq", "direction", "revisionNo", "usedCount", "launchType"]) if (result[key] != null) result[key] = Number(result[key]);
  if (result.cooperationConfirmed != null) result.cooperationConfirmed = !!Number(result.cooperationConfirmed);
  return result;
}
function projection(table) {
  return `SELECT *${(DATES[table] || []).map(column => `, DATE_FORMAT(\`${column}\`, '%Y-%m-%dT%H:%i:%s.%fZ') AS \`${column}\``).join("")} FROM \`lxm_share_${table}\``;
}
async function query(conn, sql, values = []) {
  if (!conn || typeof conn.query !== "function") throw shareError("SHARE_STORAGE_UNAVAILABLE", "分成持久化事务不可用", 503);
  const started = process.hrtime.bigint();
  try { return (await conn.query(sql, values))[0]; }
  finally { recordDatabaseOperation(Number(process.hrtime.bigint() - started) / 1e6); }
}
async function rows(conn, table, suffix = "", values = []) {
  return (await query(conn, `${projection(table)} ${suffix}`, values)).map(hydrate);
}
async function one(conn, table, suffix, values) { return (await rows(conn, table, suffix, values))[0] || null; }
async function insert(conn, table, values) {
  const keys = Object.keys(values);
  const result = await query(conn, `INSERT INTO \`lxm_share_${table}\` (${keys.map(key => `\`${key}\``).join(",")}) VALUES (${keys.map(() => "?").join(",")})`, Object.values(values));
  return String(values.id || result.insertId || "");
}
function detailNo() { return "SHR" + crypto.randomBytes(16).toString("hex"); }
function normalizedMerchant(input, previous = null) {
  const result = { id: id(input.merchantId || input.id, "商家"), name: String(input.name == null ? previous && previous.name || "" : input.name).trim(),
    status: String(input.status == null ? previous && previous.status || "OPEN" : input.status).toUpperCase(),
    refundWindowDays: engine.refundDays(input.refundWindowDays == null ? previous && previous.refundWindowDays : input.refundWindowDays),
    cooperationConfirmed: input.cooperationConfirmed == null ? !!(previous && previous.cooperationConfirmed) : input.cooperationConfirmed === true || input.cooperationConfirmed === 1 };
  if (!result.name || result.name.length > 255) throw shareError("SHARE_4001", "商家名称必填且最多255字");
  if (!["OPEN", "CLOSED", "DISABLED", "TERMINATED", "CANCELLED"].includes(result.status)) throw shareError("SHARE_4001", "商家状态无效");
  if (previous && ["CANCELLED", "TERMINATED"].includes(previous.status) && result.status !== previous.status) throw shareError("SHARE_4001", "已注销商家须重新入驻，原标识不可恢复");
  for (const [key, max] of Object.entries(MERCHANT_META)) {
    result[key] = String(input[key] == null ? previous && previous[key] || "" : input[key]).trim();
    if (result[key].length > max) throw shareError("SHARE_4001", `${key}超出长度限制`);
  }
  return result;
}
function createShareStore(source, options = {}) {
  if (!source || typeof source.transaction !== "function") throw shareError("SHARE_STORAGE_UNAVAILABLE", "分成模块必须使用MySQL事务存储", 503);
  const now = () => iso(options.clock ? options.clock() : new Date());
  const effectiveOptions = { enableAt: options.enableAt, csAttrDays: options.csAttrDays, candidateLimit: options.candidateLimit,
    defaultTtlHours: engine.positiveInt(options.defaultTtlHours, 720, 87600, "默认客服时效"),
    defaultRefundWindowDays: options.defaultRefundWindowDays == null ? 3 : options.defaultRefundWindowDays };
  const dedupSeconds = engine.positiveInt(options.dedupSeconds, 5, 3600, "扫码去重秒数");
  const judgeRetryMax = engine.positiveInt(options.judgeRetryMax, 3, 10, "判定重试次数");
  async function transaction(work) {
    for (let attempt = 0; ; attempt++) {
      try { return await source.transaction(work); }
      catch (error) {
        if (attempt < 5 && ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error && error.code)) {
          // Retry the whole rolled-back SQL transaction, independently of the
          // accounting job's 1/4/16-second retry budget. Jitter avoids a herd of
          // deadlock victims immediately repeating the same lock upgrade.
          const delay = Math.min(100, 5 * 2 ** attempt) + crypto.randomInt(0, 6);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        if (error && (error.code === "ER_DUP_ENTRY" || error.code === "DUPLICATE_RECORD")) {
          if (/uk_share_merchant_name/.test(String(error.sqlMessage || error.message || ""))) throw shareError("SHARE_4006", "商家名称已存在，请用品牌·门店名区分", 409);
          throw shareError("SHARE_4090", "记录已存在，请刷新后重试", 409);
        }
        throw error;
      }
    }
  }
  async function ensureSchema() {
    const ddl = fs.readFileSync(path.join(__dirname, "../migrations/015_merchant_share.sql"), "utf8").replace(/^--.*$/gm, "");
    for (const statement of ddl.split(";").map(value => value.trim()).filter(Boolean)) await transaction(conn => query(conn, statement));
    return { ready: true, migration: "015_merchant_share" };
  }
  async function lockUser(conn, userId) {
    // A duplicate INSERT IGNORE takes an S-lock, then FOR UPDATE would need
    // an upgrade. Use a no-op UPDATE to acquire the X-lock from the outset.
    await query(conn, "INSERT INTO lxm_share_user_lock (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)", [userId]);
    await query(conn, "SELECT user_id FROM lxm_share_user_lock WHERE user_id=? FOR UPDATE", [userId]);
  }
  async function lockOrder(conn, orderId) {
    await query(conn, "INSERT INTO lxm_share_order_lock (order_id) VALUES (?) ON DUPLICATE KEY UPDATE order_id=VALUES(order_id)", [orderId]);
    await query(conn, "SELECT order_id FROM lxm_share_order_lock WHERE order_id=? FOR UPDATE", [orderId]);
  }
  async function auditTx(conn, action, subjectId, payload = {}, operatorId = null, at = now()) {
    return insert(conn, "audit", { action, subject_id: String(subjectId), operator_id: operatorId, payload_json: JSON.stringify(payload), created_at: dbTime(at) });
  }
  async function outboxTx(conn, eventKey, eventType, payload, at = now()) {
    const existing = await one(conn, "outbox", "WHERE event_key=?", [eventKey]);
    if (existing) return existing;
    return insert(conn, "outbox", { event_key: eventKey, event_type: eventType, payload_json: JSON.stringify(payload), status: "PENDING",
      attempts: 0, next_attempt_at: dbTime(at), created_at: dbTime(at), updated_at: dbTime(at) });
  }
  async function getMerchantTx(conn, merchantId, lock = false) {
    const merchant = await one(conn, "merchant", `WHERE id=?${lock ? " FOR UPDATE" : ""}`, [String(merchantId)]);
    return merchant ? { ...merchant, merchantId: merchant.id } : null;
  }
  async function writeMerchantTx(conn, input, at) {
    const previous = await getMerchantTx(conn, input.merchantId || input.id, true);
    const merchant = normalizedMerchant(input, previous);
    const duplicate = await one(conn, "merchant", "WHERE name=? AND id<>?", [merchant.name, merchant.id]);
    if (duplicate) throw shareError("SHARE_4006", "商家名称已存在，请用品牌·门店名区分", 409);
    const values = { name: merchant.name, status: merchant.status, refund_window_days: merchant.refundWindowDays,
      ...Object.fromEntries(Object.keys(MERCHANT_META).map(key => [snake(key), merchant[key]])), cooperation_confirmed: merchant.cooperationConfirmed ? 1 : 0, updated_at: dbTime(at) };
    if (previous) await query(conn, `UPDATE lxm_share_merchant SET ${Object.keys(values).map(key => `\`${key}\`=?`).join(",")} WHERE id=?`, [...Object.values(values), merchant.id]);
    else await insert(conn, "merchant", { id: merchant.id, ...values, created_at: dbTime(at) });
    await insert(conn, "merchant_event", { merchant_id: merchant.id, name: merchant.name, status: merchant.status, refund_window_days: merchant.refundWindowDays, event_at: dbTime(at) });
    if (previous && engine.activeMerchant(previous) && !engine.activeMerchant(merchant)) {
      const bindings = await rows(conn, "binding", "WHERE merchant_id=? AND status='ACTIVE' FOR UPDATE", [merchant.id]);
      for (const binding of bindings) await insert(conn, "binding_event", { user_id: binding.userId, merchant_id: merchant.id,
        scan_id: binding.lastScanId, scan_at: dbTime(binding.lastScanAt), status: "INACTIVE", event_at: dbTime(at) });
      await query(conn, "UPDATE lxm_share_binding SET status='INACTIVE', updated_at=? WHERE merchant_id=? AND status='ACTIVE'", [dbTime(at), merchant.id]);
    }
    await auditTx(conn, previous ? "MERCHANT_UPDATE" : "MERCHANT_CREATE", merchant.id, { before: previous, after: merchant }, input.operatorId || null, at);
    return { ...merchant, merchantId: merchant.id, createdAt: previous ? previous.createdAt : at, updatedAt: at };
  }
  async function getRulesTx(conn, merchantId = null) {
    return rows(conn, "rule", `${merchantId == null ? "" : "WHERE merchant_id=?"} ORDER BY effective_from DESC,version_no DESC`, merchantId == null ? [] : [String(merchantId)]);
  }
  async function saveRuleTx(conn, input, at) {
    if (input.expectedVersion == null || !Number.isSafeInteger(Number(input.expectedVersion)) || Number(input.expectedVersion) < 0) throw shareError("SHARE_4001", "请提供当前配置版本号");
    const merchant = await getMerchantTx(conn, input.merchantId, true);
    if (!merchant) throw shareError("SHARE_4003", "商家不存在", 404);
    const rule = engine.validateRule({ ...input, refundWindowDays: input.refundWindowDays == null ? merchant.refundWindowDays : input.refundWindowDays });
    const previous = await one(conn, "rule", "WHERE merchant_id=? ORDER BY version_no DESC LIMIT 1 FOR UPDATE", [rule.merchantId]);
    const version = previous ? previous.versionNo : 0;
    if (input.expectedVersion != null && Number(input.expectedVersion) !== version) throw shareError("SHARE_4091", "配置已被其他人修改，请刷新后重试", 409);
    // Historical versions remain queryable; SUPERSEDED describes current UI state.
    await query(conn, "UPDATE lxm_share_rule SET status='SUPERSEDED' WHERE merchant_id=? AND status='ACTIVE'", [rule.merchantId]);
    const ruleId = await insert(conn, "rule", { merchant_id: rule.merchantId, version_no: version + 1, ratio_t1: rule.ratioT1,
      ratio_t2: rule.ratioT2, ttl_hours: rule.ttlHours, refund_window_days: rule.refundWindowDays, status: "ACTIVE",
      reason: rule.reason, operator_id: rule.operatorId, effective_from: dbTime(at), created_at: dbTime(at) });
    await query(conn, "UPDATE lxm_share_merchant SET refund_window_days=?,updated_at=? WHERE id=?", [rule.refundWindowDays, dbTime(at), rule.merchantId]);
    const result = { ...rule, id: ruleId, ruleId, versionNo: version + 1, currentVersion: version + 1, effectiveFrom: at, effectiveAt: at, status: "ACTIVE" };
    await auditTx(conn, "RULE_SAVE", rule.merchantId, { before: previous, after: result }, rule.operatorId, at);
    return result;
  }
  async function saveQrTx(conn, input, at, rotate) {
    const merchantId = id(input.merchantId, "商家"); const qrId = id(input.id || input.qrId, "商家码");
    const requestKey = rotate ? id(input.requestId, "换码请求标识") : null;
    const merchant = await getMerchantTx(conn, merchantId, true);
    if (!merchant || !engine.activeMerchant(merchant)) throw shareError("SHARE_4003", "商家不存在或已停业", 409);
    if (requestKey) {
      const previous = await one(conn, "qr", "WHERE merchant_id=? AND rotate_request_key=?", [merchantId, requestKey]);
      if (previous) {
        if (previous.reason !== String(input.reason || "").trim() || previous.operatorId !== String(input.operatorId || "")) throw shareError("SHARE_4090", "换码请求标识已用于其他操作内容", 409);
        return { ...previous, existed: true };
      }
    }
    const active = await one(conn, "qr", "WHERE merchant_id=? AND status='ACTIVE' FOR UPDATE", [merchantId]);
    if (active && !rotate) return { ...active, existed: true };
    const scene = String(input.scene || ""); const imageUrl = String(input.imageUrl || ""); const reason = String(input.reason || "").trim();
    if (!scene || Buffer.byteLength(scene) > 32 || !imageUrl || Buffer.byteLength(imageUrl) > 3 * 1024 * 1024 || !reason || reason.length > 255) throw shareError("SHARE_4001", "商家码、真实码图与原因必填，scene不得超过32字节，码图不得超过3MiB");
    const old = await rows(conn, "qr", "WHERE merchant_id=? ORDER BY qr_seq DESC", [merchantId]);
    if (active) await query(conn, "UPDATE lxm_share_qr SET status='DISABLED',active_flag=NULL,disabled_at=? WHERE id=?", [dbTime(at), active.id]);
    const result = { id: qrId, merchantId, qrSeq: old.length ? Number(old[0].qrSeq) + 1 : 1, scene, imageUrl, status: "ACTIVE", reason, operatorId: id(input.operatorId, "操作人"), createdAt: at };
    await insert(conn, "qr", { id: qrId, merchant_id: merchantId, qr_seq: result.qrSeq, scene, image_url: imageUrl,
      status: "ACTIVE", active_flag: 1, reason, operator_id: result.operatorId, rotate_request_key: requestKey, created_at: dbTime(at), disabled_at: null });
    await auditTx(conn, rotate ? "QR_ROTATE" : "QR_CREATE", merchantId, { oldQrId: active && active.id, qrId, qrSeq: result.qrSeq, reason }, result.operatorId, at);
    return { ...result, existed: false };
  }
  async function getBindingsAsOfTx(conn, userId, at) {
    const events = await rows(conn, "binding_event", "WHERE user_id=? AND event_at<=? ORDER BY event_at DESC,id DESC", [userId, dbTime(at)]);
    const latest = new Map();
    for (const event of events) if (!latest.has(event.merchantId)) latest.set(event.merchantId, { userId, merchantId: event.merchantId,
      lastScanId: event.scanId, lastScanAt: event.scanAt, status: event.status });
    return [...latest.values()];
  }
  async function getClicksAsOfTx(conn, userId, at) {
    return rows(conn, "click", "WHERE user_id=? AND click_at<=? ORDER BY click_at DESC,id DESC LIMIT 100", [userId, dbTime(at)]);
  }
  async function merchantsAsOfTx(conn, at) {
    const events = await rows(conn, "merchant_event", "WHERE event_at<=? ORDER BY event_at DESC,id DESC", [dbTime(at)]);
    const latest = new Map();
    for (const event of events) if (!latest.has(event.merchantId)) latest.set(event.merchantId, { ...event, id: event.merchantId });
    return [...latest.values()];
  }
  async function refundTotalTx(conn, orderId, at = null) {
    const refunds = await rows(conn, "refund", `WHERE order_id=?${at ? " AND refund_at<=?" : ""}`, at ? [orderId, dbTime(at)] : [orderId]);
    return formatMoney(refunds.reduce((sum, refund) => sum + moneyToCents(refund.amount), 0));
  }
  async function effectiveStateTx(conn, orderId, original = null) {
    const latest = await one(conn, "correction", "WHERE order_id=? ORDER BY revision_no DESC LIMIT 1", [orderId]);
    if (latest) return { state: { ...latest.nextStateJson, id: latest.snapshotId }, revisionNo: latest.revisionNo, correctionId: latest.id };
    const snapshot = original || await one(conn, "snapshot", "WHERE order_id=?", [orderId]);
    return { state: snapshot ? { ...snapshot, payTime: snapshot.payTime || snapshot.judgeTime } : null, revisionNo: 0, correctionId: null };
  }
  async function decisionTx(conn, event) {
    const payTime = event.payTime || event.finalPaidAt;
    const bindings = await getBindingsAsOfTx(conn, event.userId, payTime);
    const clicks = await getClicksAsOfTx(conn, event.userId, payTime);
    const rules = await getRulesTx(conn);
    const merchants = await merchantsAsOfTx(conn, payTime);
    // Paid T1 jobs count before maturity as well. They are online payment facts,
    // not estimates; waiting for an accounting window must not change D.
    const paidJobs = await rows(conn, "job", "WHERE user_id=? AND pay_time<=? ORDER BY pay_time DESC,order_id DESC", [event.userId, dbTime(payTime)]);
    const selfOrders = [];
    for (const job of paidJobs) {
      const corrected = await one(conn, "correction", "WHERE order_id=? ORDER BY revision_no DESC LIMIT 1", [job.orderId]);
      const decision = corrected ? corrected.nextStateJson : job.decisionJson;
      if (decision.splitType !== "T1" || job.orderId === String(event.orderId)) continue;
      const refunded = await refundTotalTx(conn, job.orderId, payTime);
      selfOrders.push({ ...decision, paid: true, fullyRefunded: moneyToCents(refunded) >= moneyToCents(job.paidTotal) });
    }
    return engine.decideAtPayment({ event, bindings, clicks, rules, merchants, selfOrders, options: effectiveOptions });
  }
  function eventFromJob(job) {
    return { orderId: job.orderId, userId: job.userId, payTime: job.payTime, paidTotal: job.paidTotal,
      sessionId: job.decisionJson.sessionId, sessionStartAt: job.decisionJson.sessionStartAt };
  }
  async function refreshJobTx(conn, job, at) {
    const decision = await decisionTx(conn, eventFromJob(job));
    if (decision.skipped) throw shareError("SHARE_4090", "已接收任务不能因启用时间变更而丢弃，请核查启用配置", 409);
    await query(conn, "UPDATE lxm_share_job SET decision_json=?,available_at=?,updated_at=? WHERE order_id=?",
      [JSON.stringify(decision), dbTime(decision.availableAt), dbTime(at), job.orderId]);
    return { ...job, decisionJson: decision, availableAt: decision.availableAt, updatedAt: at };
  }
  async function refreshPendingJob(orderId, input = {}) {
    const wanted = id(orderId); const at = iso(input.now || now());
    return transaction(async conn => {
      await lockOrder(conn, wanted);
      const job = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
      if (!job || job.status !== "PENDING") return { skipped: true, job };
      await lockUser(conn, job.userId);
      return { job: await refreshJobTx(conn, job, at), skipped: false };
    });
  }
  async function refreshPendingBatch({ now: at = now(), limit = 100 } = {}) {
    const size = engine.positiveInt(limit, 100, 1000, "刷新批量"); const stamp = iso(at);
    // Reserve a page and release the cursor before taking any order/user lock.
    const page = await transaction(async conn => {
      await query(conn, "INSERT INTO lxm_share_pending_cursor (cursor_name,last_pay_time,last_order_id,cycle_no,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE cursor_name=VALUES(cursor_name)", ["pending", null, null, 0, dbTime(stamp)]);
      const cursor = await one(conn, "pending_cursor", "WHERE cursor_name=? FOR UPDATE", ["pending"]);
      const suffix = cursor.lastPayTime ? "WHERE status='PENDING' AND (pay_time,order_id)>(?,?) ORDER BY pay_time,order_id LIMIT ?" : "WHERE status='PENDING' ORDER BY pay_time,order_id LIMIT ?";
      const values = cursor.lastPayTime ? [dbTime(cursor.lastPayTime), cursor.lastOrderId, size] : [size];
      const jobs = await rows(conn, "job", suffix, values); const finished = jobs.length < size; const last = jobs.at(-1);
      await query(conn, "UPDATE lxm_share_pending_cursor SET last_pay_time=?,last_order_id=?,cycle_no=?,updated_at=? WHERE cursor_name=?",
        [finished || !last ? null : dbTime(last.payTime), finished || !last ? null : last.orderId, Number(cursor.cycleNo || 0) + (finished ? 1 : 0), dbTime(stamp), "pending"]);
      return { jobs, finished };
    });
    const result = { refreshed: 0, failed: 0, finished: page.finished, lastOrderId: page.jobs.at(-1)?.orderId || null };
    for (const job of page.jobs) {
      try { if (!(await refreshPendingJob(job.orderId, { now: stamp })).skipped) result.refreshed++; }
      catch (_) { result.failed++; }
    }
    return result;
  }
  async function reviewPostedFacts(input) {
    const factOrderId = id(input.orderId); const at = iso(input.now || now());
    const targets = await transaction(async conn => {
      const anchor = await one(conn, "job", "WHERE order_id=?", [factOrderId]);
      if (!anchor) return [];
      const refund = input.refundNo ? await one(conn, "refund", "WHERE refund_no=?", [id(input.refundNo)]) : null;
      if (refund && refund.orderId !== factOrderId) throw shareError("SHARE_4090", "退款归属不一致", 409);
      return rows(conn, "job", "WHERE user_id=? AND status='DONE' AND pay_time>=? ORDER BY pay_time,order_id", [anchor.userId, dbTime(refund ? refund.refundAt : anchor.payTime)]);
    });
    const result = { reviewed: 0, flagged: 0 };
    for (const target of targets) {
      if (target.orderId === factOrderId) continue;
      const flagged = await transaction(async conn => {
        await lockOrder(conn, target.orderId);
        const job = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [target.orderId]);
        if (!job || job.status !== "DONE") return false;
        await lockUser(conn, job.userId);
        const current = await effectiveStateTx(conn, job.orderId);
        if (!current.state) return false;
        const expected = await decisionTx(conn, eventFromJob(job));
        const changed = ["hitMerchantId", "splitType", "ratio", "staffId", "csClickId", "sourceReason"].some(key => String(current.state[key] || "") !== String(expected[key] || ""));
        if (!changed) return false;
        const payload = { orderId: job.orderId, factOrderId, refundNo: input.refundNo || null,
          currentMerchantId: current.state.hitMerchantId, expectedMerchantId: expected.hitMerchantId,
          currentType: current.state.splitType, expectedType: expected.splitType, currentRatio: current.state.ratio, expectedRatio: expected.ratio,
          priority: "P1", automaticRewrite: false };
        const key = "late-fact:" + crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        if (await one(conn, "outbox", "WHERE event_key=?", [key])) return false;
        const risk = await one(conn, "risk", "WHERE entity_type='ORDER' AND entity_id=? AND risk_code='SHARE_LATE_FACT_REVIEW'", [job.orderId]);
        if (!risk) await insert(conn, "risk", { entity_type: "ORDER", entity_id: job.orderId, risk_code: "SHARE_LATE_FACT_REVIEW", priority: "P1", status: "OPEN", payload_json: JSON.stringify(payload), created_at: dbTime(at) });
        else await query(conn, "UPDATE lxm_share_risk SET status='OPEN',payload_json=? WHERE entity_type='ORDER' AND entity_id=? AND risk_code='SHARE_LATE_FACT_REVIEW'", [JSON.stringify(payload), job.orderId]);
        await outboxTx(conn, key, "SHARE_LATE_FACT_REVIEW", payload, at);
        await auditTx(conn, "LATE_FACT_REVIEW", job.orderId, payload, null, at);
        return true;
      });
      result.reviewed++; if (flagged) result.flagged++;
    }
    return result;
  }
  async function invalidateUser(userId, input = {}) {
    const wanted = id(userId, "用户"); const requestId = id(input.requestId, "注销请求标识"); const operatorId = id(input.operatorId, "操作人");
    const reason = String(input.reason || "").trim(); if (!reason || reason.length > 255) throw shareError("SHARE_4001", "注销原因必填且最多255字");
    const at = now();
    return transaction(async conn => {
      await lockUser(conn, wanted);
      const prior = await one(conn, "user_event", "WHERE user_id=? AND request_key=?", [wanted, requestId]);
      if (prior) {
        if (prior.reason !== reason || prior.operatorId !== operatorId) throw shareError("SHARE_4090", "注销请求标识已用于其他操作", 409);
        return { userId: wanted, existed: true };
      }
      const bindings = await rows(conn, "binding", "WHERE user_id=? AND status='ACTIVE' FOR UPDATE", [wanted]);
      for (const binding of bindings) await insert(conn, "binding_event", { user_id: wanted, merchant_id: binding.merchantId, scan_id: binding.lastScanId,
        scan_at: dbTime(binding.lastScanAt), status: "INACTIVE", event_at: dbTime(at) });
      await query(conn, "UPDATE lxm_share_binding SET status='INACTIVE',updated_at=? WHERE user_id=? AND status='ACTIVE'", [dbTime(at), wanted]);
      await insert(conn, "user_event", { user_id: wanted, request_key: requestId, reason, operator_id: operatorId, event_at: dbTime(at) });
      await auditTx(conn, "USER_INVALIDATE", wanted, { reason, requestId, bindingsInvalidated: bindings.length }, operatorId, at);
      return { userId: wanted, bindingsInvalidated: bindings.length, existed: false };
    });
  }
  async function enqueuePayment(input) {
    const event = { ...input, orderId: id(input.orderId, "订单"), userId: id(input.userId, "用户"), payTime: iso(input.payTime || input.finalPaidAt), paidTotal: formatMoney(moneyToCents(input.paidTotal)) };
    if (input.provider && !["wechat_pay", "zero_balance"].includes(input.provider)) throw shareError("SHARE_ONLINE_ONLY", "新分成仅接受在线交易", 409);
    return transaction(async conn => {
      await lockOrder(conn, event.orderId);
      await lockUser(conn, event.userId);
      const existing = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [event.orderId]);
      if (existing) {
        if (existing.userId !== event.userId || existing.paidTotal !== event.paidTotal || time(existing.payTime) !== time(event.payTime)) throw shareError("SHARE_4090", "支付事件与已保存分成任务不一致", 409);
        return { job: existing, decision: existing.decisionJson, existed: true };
      }
      const decision = await decisionTx(conn, event);
      if (decision.skipped) return { skipped: true, code: decision.code, existed: false };
      const at = now();
      const display = { ...(input.display || {}) };
      const values = { order_id: event.orderId, user_id: event.userId, paid_total: event.paidTotal, pay_time: dbTime(event.payTime), available_at: dbTime(decision.availableAt),
        decision_json: JSON.stringify(decision), display_json: JSON.stringify(display), status: "PENDING", attempts: 0,
        next_attempt_at: dbTime(decision.availableAt), last_error: null, snapshot_id: null, created_at: dbTime(at), updated_at: dbTime(at) };
      await insert(conn, "job", values);
      await outboxTx(conn, `payment:${event.orderId}`, "SHARE_PAYMENT_QUEUED", { orderId: event.orderId, availableAt: decision.availableAt }, at);
      await auditTx(conn, "PAYMENT_ENQUEUE", event.orderId, { payTime: event.payTime, availableAt: decision.availableAt, hitMerchantId: decision.hitMerchantId }, null, at);
      return { job: hydrate(values), decision, existed: false };
    });
  }
  async function insertDetailTx(conn, snapshot, amount, direction, refundNo, at, revision = {}) {
    const amountCents = moneyToCents(amount, { signed: true });
    if (amountCents === 0) return null;
    const values = { detail_no: detailNo(), snapshot_id: snapshot.id, order_id: snapshot.orderId, merchant_id: snapshot.hitMerchantId,
      split_type: snapshot.splitType, direction, amount: formatMoney(amountCents), base_amount: snapshot.baseAmount, ratio: snapshot.ratio,
      period: periodAt(at), refund_no: refundNo || null, entry_key: revision.entryKey || (direction === 1 ? `snapshot:${snapshot.id}` : `refund:${snapshot.id}:${refundNo}`),
      entry_type: revision.entryType || (direction === 1 ? "POST" : "REFUND"), revision_no: revision.revisionNo || 0, correction_id: revision.correctionId || null,
      status: "EFFECTIVE", created_at: dbTime(at) };
    const detailId = await insert(conn, "detail", values);
    return { id: detailId, ...hydrate(values) };
  }
  async function processJob(orderId, processing = {}) {
    const wanted = id(orderId, "订单"); const at = iso(processing.now || now());
    const started = process.hrtime.bigint();
    try {
      return await transaction(async conn => {
        await lockOrder(conn, wanted);
        const found = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
        if (!found) throw shareError("SHARE_4040", "分成任务不存在", 404);
        await lockUser(conn, found.userId);
        let job = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
        const existing = await one(conn, "snapshot", "WHERE order_id=?", [wanted]);
        if (existing) return { snapshot: existing, existed: true, pending: false };
        if (job.status === "FAILED" && processing.retry !== true) return { job, failed: true, pending: false };
        job = await refreshJobTx(conn, job, at);
        if (time(at) < time(job.availableAt)) return { job, pending: true, existed: true };
        if (processing.retry !== true && job.attempts > 0 && time(at) < time(job.nextAttemptAt)) return { job, pending: true, deferred: true, existed: true };
        // Do not process a later accounting job before earlier paid facts are
        // enqueued by the payment observer; adapters reconcile missing jobs.
        const refunded = await refundTotalTx(conn, wanted);
        const snapshot = engine.finalizeDecision(job.decisionJson, { paidTotal: job.paidTotal, refundedAmount: refunded });
        const values = { order_id: wanted, user_id: job.userId, staff_id: snapshot.staffId, cs_click_id: snapshot.csClickId,
          split_type: snapshot.splitType, judge_time: dbTime(snapshot.payTime), hit_merchant_id: snapshot.hitMerchantId,
          hit_reason: snapshot.hitReason, candidate_json: JSON.stringify(snapshot.candidateJson), ratio: snapshot.ratio,
          rule_version: snapshot.ruleVersion, engine_version: snapshot.engineVersion, paid_total: snapshot.paidTotal,
          refunded_before_snapshot: snapshot.refundedBeforeSnapshot, base_amount: snapshot.baseAmount, split_amount: snapshot.splitAmount,
          refund_window_days: snapshot.refundWindowDays, available_at: dbTime(snapshot.availableAt), source_flag: snapshot.sourceFlag || null,
          source_reason: snapshot.sourceReason, status: snapshot.status, display_json: JSON.stringify(job.displayJson), created_at: dbTime(at) };
        const snapshotId = await insert(conn, "snapshot", values);
        const saved = { ...snapshot, id: snapshotId, displayJson: job.displayJson, createdAt: at };
        const detail = snapshot.shouldWriteDetail ? await insertDetailTx(conn, saved, snapshot.splitAmount, 1, null, at) : null;
        await query(conn, "UPDATE lxm_share_job SET status='DONE',snapshot_id=?,last_error=NULL,updated_at=? WHERE order_id=?", [snapshotId, dbTime(at), wanted]);
        await query(conn, "UPDATE lxm_share_failure SET status='RESOLVED' WHERE order_id=? AND status='OPEN'", [wanted]);
        await outboxTx(conn, `snapshot:${wanted}`, "SHARE_SNAPSHOT_CREATED", { orderId: wanted, snapshotId, merchantId: snapshot.hitMerchantId, amount: snapshot.splitAmount }, at);
        await auditTx(conn, "SNAPSHOT_CREATE", wanted, { snapshotId, amount: snapshot.splitAmount, refundedBeforeSnapshot: refunded }, null, at);
        await insert(conn, "observation", { metric_key: "JUDGE_DURATION_MS", subject_hash: null, success: 1,
          value_number: Number(process.hrtime.bigint() - started) / 1e6, occurred_at: dbTime(at) });
        return { snapshot: saved, detail, existed: false, pending: false };
      });
    } catch (error) {
      if (error && error.code === "SHARE_4040") throw error;
      // The accounting transaction rolled back. Failure state is durable in a
      // second transaction so a worker restart cannot lose its retry budget.
      await transaction(async conn => {
        const job = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
        if (!job || job.status === "DONE") return;
        const attempts = Number(job.attempts || 0) + 1;
        const failed = attempts > judgeRetryMax;
        const next = new Date(time(at) + Math.min(3600000, 1000 * 4 ** Math.max(0, attempts - 1))).toISOString();
        await query(conn, "UPDATE lxm_share_job SET attempts=?,status=?,next_attempt_at=?,last_error=?,updated_at=? WHERE order_id=?",
          [attempts, failed ? "FAILED" : "PENDING", dbTime(next), String(error.code || "SHARE_5001"), dbTime(at), wanted]);
        await insert(conn, "observation", { metric_key: "JUDGE_DURATION_MS", subject_hash: null, success: 0,
          value_number: Number(process.hrtime.bigint() - started) / 1e6, occurred_at: dbTime(at) });
        if (failed) {
          await insert(conn, "failure", { order_id: wanted, error_code: String(error.code || "SHARE_5001"), message: "分成任务重试耗尽，需人工核查", status: "OPEN", created_at: dbTime(at) });
          await outboxTx(conn, `failed:${wanted}`, "SHARE_JOB_FAILED", { orderId: wanted, code: error.code || "SHARE_5001" }, at);
        }
      });
      throw error;
    }
  }
  async function recordRefund(input) {
    const orderId = id(input.orderId, "订单"); const refundNo = id(input.refundNo, "退款单号");
    const amount = formatMoney(moneyToCents(input.amount)); const refundAt = iso(input.refundAt || now());
    if (moneyToCents(amount) <= 0) throw shareError("SHARE_4001", "退款金额必须大于0");
    return transaction(async conn => {
      await lockOrder(conn, orderId);
      const lookup = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [orderId]);
      if (lookup) await lockUser(conn, lookup.userId);
      const job = lookup ? await one(conn, "job", "WHERE order_id=? FOR UPDATE", [orderId]) : null;
      const existing = await one(conn, "refund", "WHERE refund_no=?", [refundNo]);
      if (existing) {
        if (existing.orderId !== orderId || existing.amount !== amount) throw shareError("SHARE_4090", "退款单号对应其他退款", 409);
        return { refund: existing, existed: true };
      }
      const at = now();
      const priorRefund = await refundTotalTx(conn, orderId);
      const cumulativeRefundAmount = formatMoney(moneyToCents(priorRefund) + moneyToCents(amount));
      if (job && moneyToCents(cumulativeRefundAmount) > moneyToCents(job.paidTotal)) throw shareError("SHARE_4001", "累计成功退款超过整单实付");
      await insert(conn, "refund", { refund_no: refundNo, order_id: orderId, amount, refund_at: dbTime(refundAt), created_at: dbTime(at) });
      const effective = await effectiveStateTx(conn, orderId);
      const snapshot = effective.state;
      let detail = null;
      if (snapshot && moneyToCents(snapshot.splitAmount) > 0) {
        const reversed = await rows(conn, "detail", "WHERE order_id=? AND direction=2 AND entry_type='REFUND' AND revision_no=?", [orderId, effective.revisionNo]);
        const alreadyReversed = formatMoney(reversed.reduce((sum, row) => sum - moneyToCents(row.amount, { signed: true }), 0));
        const refund = engine.calculateRefund({ snapshot, cumulativeRefundAmount, alreadyReversed });
        if (moneyToCents(refund.reverseAmount) > 0) detail = await insertDetailTx(conn, snapshot, formatMoney(-moneyToCents(refund.reverseAmount)), 2, refundNo, at,
          { revisionNo: effective.revisionNo, correctionId: effective.correctionId });
      }
      await outboxTx(conn, `refund:${refundNo}`, "SHARE_REFUND_RECORDED", { orderId, refundNo, amount, detailId: detail && detail.id }, at);
      await auditTx(conn, "REFUND_RECORD", orderId, { refundNo, amount, cumulativeRefundAmount, detailId: detail && detail.id }, null, at);
      return { refund: { refundNo, orderId, amount, refundAt }, detail, existed: false };
    });
  }
  async function correctSnapshot(orderId, input = {}) {
    const wanted = id(orderId, "订单"); const requestId = id(input.requestId, "更正请求标识"); const operatorId = id(input.operatorId, "操作人");
    const reason = String(input.reason || "").trim();
    if (!reason || reason.length > 255) throw shareError("SHARE_4001", "更正原因必填且最多255字");
    const at = now();
    return transaction(async conn => {
      await lockOrder(conn, wanted);
      const found = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
      if (!found) throw shareError("SHARE_4040", "分成任务不存在", 404);
      await lockUser(conn, found.userId);
      const job = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
      const previousRequest = await one(conn, "correction", "WHERE request_key=?", [requestId]);
      if (previousRequest) {
        if (previousRequest.orderId !== wanted || previousRequest.reason !== reason || previousRequest.operatorId !== operatorId) throw shareError("SHARE_4090", "更正请求标识已用于其他操作内容", 409);
        return { correction: previousRequest, state: previousRequest.nextStateJson, changed: !!Number(previousRequest.changed), existed: true };
      }
      const original = await one(conn, "snapshot", "WHERE order_id=?", [wanted]);
      if (!original || job.status !== "DONE") throw shareError("SHARE_4090", "未入账订单请重试任务，不能更正快照", 409);
      const period = periodAt(at);
      await query(conn, "INSERT INTO lxm_share_correction_quota (period,used_count) VALUES (?,?) ON DUPLICATE KEY UPDATE period=VALUES(period)", [period, 0]);
      const quota = await one(conn, "correction_quota", "WHERE period=? FOR UPDATE", [period]);
      if (quota.usedCount >= 10) throw shareError("SHARE_CORRECTION_LIMIT", "本月更正已达10次，请转人工复核", 409);
      const current = await effectiveStateTx(conn, wanted, original);
      const refunded = await refundTotalTx(conn, wanted);
      const decision = await decisionTx(conn, eventFromJob(job));
      if (decision.skipped) throw shareError("SHARE_4090", "上线前订单不能补算", 409);
      const next = { ...engine.finalizeDecision(decision, { paidTotal: job.paidTotal, refundedAmount: refunded }), id: original.id,
        displayJson: job.displayJson, createdAt: at };
      const ledger = await rows(conn, "detail", "WHERE order_id=?", [wanted]);
      const balance = ledger.reduce((sum, detail) => sum + moneyToCents(detail.amount, { signed: true }), 0);
      if (balance < 0) throw shareError("SHARE_4221", "订单分成余额异常，须人工核查后再更正", 422);
      const nextBalance = moneyToCents(next.splitAmount);
      const changed = balance !== nextBalance || current.state.hitMerchantId !== next.hitMerchantId || current.state.splitType !== next.splitType;
      const revisionNo = current.revisionNo + 1;
      const correctionId = await insert(conn, "correction", { order_id: wanted, snapshot_id: original.id, revision_no: revisionNo,
        request_key: requestId, operator_id: operatorId, reason, changed: changed ? 1 : 0,
        previous_state_json: JSON.stringify(current.state), next_state_json: JSON.stringify(next), previous_balance: formatMoney(balance), corrected_balance: next.splitAmount, created_at: dbTime(at) });
      const details = [];
      if (changed) {
        if (balance > 0) details.push(await insertDetailTx(conn, current.state, formatMoney(-balance), 2, null, at,
          { entryKey: `correction:${correctionId}:reverse`, entryType: "CORRECTION_REVERSE", revisionNo, correctionId }));
        if (nextBalance > 0 && next.hitMerchantId !== "0") details.push(await insertDetailTx(conn, next, next.splitAmount, 1, null, at,
          { entryKey: `correction:${correctionId}:post`, entryType: "CORRECTION_POST", revisionNo, correctionId }));
      }
      await query(conn, "UPDATE lxm_share_correction_quota SET used_count=? WHERE period=?", [quota.usedCount + 1, period]);
      await auditTx(conn, "SNAPSHOT_CORRECTION", wanted, { correctionId, revisionNo, requestId, reason, changed,
        originalSnapshotId: original.id, previousBalance: formatMoney(balance), correctedBalance: next.splitAmount }, operatorId, at);
      await query(conn, "UPDATE lxm_share_risk SET status='RESOLVED' WHERE entity_type='ORDER' AND entity_id=? AND risk_code='SHARE_LATE_FACT_REVIEW'", [wanted]);
      await outboxTx(conn, `correction:${correctionId}`, "SHARE_SNAPSHOT_CORRECTED", { orderId: wanted, correctionId, operatorId, changed, amount: next.splitAmount }, at);
      return { correction: { id: correctionId, orderId: wanted, snapshotId: original.id, revisionNo, requestKey: requestId,
        operatorId, reason, changed, previousBalance: formatMoney(balance), correctedBalance: next.splitAmount, createdAt: at }, state: next, details, changed, existed: false };
    });
  }
  async function reportScan(input) {
    const userId = id(input.userId, "用户"); const at = now();
    const bindEligible = input.bindEligible !== false;
    const launchType = Number(input.launchType == null ? 1 : input.launchType);
    const deviceId = input.deviceId == null ? null : String(input.deviceId).trim();
    const clientScanAt = input.clientScanAt == null || input.clientScanAt === "" ? null : String(input.clientScanAt);
    if (![1, 2].includes(launchType)) throw shareError("SHARE_4001", "启动类型须为1或2");
    if (deviceId && deviceId.length > 128) throw shareError("SHARE_4001", "设备标识不得超过128字符");
    if (clientScanAt && (clientScanAt.length > 64 || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(clientScanAt) || !Number.isFinite(Date.parse(clientScanAt)))) throw shareError("SHARE_4001", "客户端扫码时间须为最多64字符的ISO时间");
    // scanAt from a client is deliberately ignored: server receive time wins.
    return transaction(async conn => {
      await lockUser(conn, userId);
      // The first read is only an identity hint: merchant_id never changes for
      // an issued code. Match rotation's merchant -> QR lock order and re-read
      // the code under its X-lock before trusting its status or writing a scan.
      const hintRows = await query(conn, input.qrId ? "SELECT id,merchant_id FROM lxm_share_qr WHERE id=?" : "SELECT id,merchant_id FROM lxm_share_qr WHERE scene=?",
        [input.qrId ? id(input.qrId, "商家码") : String(input.scene || "")]);
      const hint = hydrate(hintRows[0]);
      if (!hint) throw shareError("SHARE_4002", "商家码无效或已停用", 409);
      const merchant = await getMerchantTx(conn, hint.merchantId, true);
      const qr = await one(conn, "qr", "WHERE id=? FOR UPDATE", [hint.id]);
      if (!qr || qr.id !== hint.id || qr.merchantId !== hint.merchantId || qr.status !== "ACTIVE"
        || input.scene && qr.scene !== String(input.scene)) throw shareError("SHARE_4002", "商家码无效或已停用", 409);
      if (!engine.activeMerchant(merchant)) throw shareError("SHARE_4003", "商家已停业", 409);
      if (input.merchantId && String(input.merchantId) !== qr.merchantId) throw shareError("SHARE_4002", "商家码与商家不匹配", 409);
      const existing = input.requestKey ? await one(conn, "scan", "WHERE request_key=?", [id(input.requestKey)]) : null;
      if (existing) {
        if (existing.userId !== userId || existing.qrId !== qr.id) throw shareError("SHARE_4090", "扫码请求标识不匹配", 409);
        return { scan: existing, deduplicated: true };
      }
      const binding = bindEligible ? await one(conn, "binding", "WHERE user_id=? AND merchant_id=? FOR UPDATE", [userId, qr.merchantId]) : null;
      // Stable entry keys identify actual visits. Only older clients without
      // one need the time-window fallback; dropping a new key here would leave
      // its later retry unrecognized and could create attribution after launch.
      const previous = input.requestKey ? null : !bindEligible
        ? await one(conn, "scan", "WHERE user_id=? AND qr_id=? ORDER BY scan_at DESC,id DESC LIMIT 1", [userId, qr.id])
        : binding && binding.status === "ACTIVE" ? await one(conn, "scan", "WHERE id=?", [binding.lastScanId]) : null;
      if (previous && previous.qrId === qr.id && time(at) - time(previous.scanAt) >= 0 && time(at) - time(previous.scanAt) < dedupSeconds * 1000) {
        return { scan: previous, binding, deduplicated: true };
      }
      const scanId = await insert(conn, "scan", { user_id: userId, merchant_id: qr.merchantId, qr_id: qr.id, scene: qr.scene,
        request_key: input.requestKey ? id(input.requestKey) : null, launch_type: launchType, device_id: deviceId || null, client_scan_at: clientScanAt, scan_at: dbTime(at) });
      if (bindEligible) {
        if (binding) await query(conn, "UPDATE lxm_share_binding SET last_scan_at=?,last_scan_id=?,status='ACTIVE',updated_at=? WHERE user_id=? AND merchant_id=?", [dbTime(at), scanId, dbTime(at), userId, qr.merchantId]);
        else await insert(conn, "binding", { user_id: userId, merchant_id: qr.merchantId, first_scan_at: dbTime(at), last_scan_at: dbTime(at), last_scan_id: scanId, status: "ACTIVE", updated_at: dbTime(at) });
        await insert(conn, "binding_event", { user_id: userId, merchant_id: qr.merchantId, scan_id: scanId, scan_at: dbTime(at), status: "ACTIVE", event_at: dbTime(at) });
      }
      return { scan: { id: scanId, userId, merchantId: qr.merchantId, qrId: qr.id, scanAt: at, launchType, deviceId: deviceId || null, clientScanAt }, deduplicated: false };
    });
  }
  async function reportClick(input) {
    const userId = id(input.userId, "用户"); const at = now();
    return transaction(async conn => {
      await lockUser(conn, userId);
      if (input.requestKey) {
        const prior = await one(conn, "click", "WHERE request_key=?", [id(input.requestKey)]);
        if (prior) {
          if (prior.userId !== userId) throw shareError("SHARE_4090", "客服点击请求标识不匹配", 409);
          return { click: prior, existed: true };
        }
      }
      const values = { user_id: userId, staff_id: input.staffId ? id(input.staffId) : null,
        staff_wecom_id: input.staffWecomId ? id(input.staffWecomId) : null, link_id: input.linkId ? id(input.linkId) : null,
        session_id: input.sessionId ? id(input.sessionId) : null, request_key: input.requestKey ? id(input.requestKey) : null, click_at: dbTime(at) };
      const clickId = await insert(conn, "click", values);
      return { click: { id: clickId, ...hydrate(values) }, existed: false };
    });
  }
  async function listDetails(filters = {}) {
    return transaction(async conn => {
      const where = []; const values = [];
      for (const [key, column] of [["merchantId", "merchant_id"], ["orderId", "order_id"], ["splitType", "split_type"], ["period", "period"]]) {
        if (filters[key]) { where.push(`${column}=?`); values.push(String(filters[key])); }
      }
      const all = await rows(conn, "detail", `${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC,id DESC`, values);
      const page = engine.positiveInt(filters.page, 1, 1000000, "页码"); const size = engine.positiveInt(filters.size, 20, 100000, "页大小");
      const selected = filters.all ? all : all.slice((page - 1) * size, page * size);
      const batches = async (table, column, keys) => {
        const unique = [...new Set(keys.map(String))];
        if (!unique.length) return [];
        const result = [];
        for (let start = 0; start < unique.length; start += 1000) {
          const batch = unique.slice(start, start + 1000);
          result.push(...await rows(conn, table, "WHERE " + batch.map(() => column + "=?").join(" OR "), batch));
        }
        return result;
      };
      const snapshots = new Map((await batches("snapshot", "id", selected.map(row => row.snapshotId))).map(row => [row.id, row]));
      const merchants = new Map((await batches("merchant", "id", selected.map(row => row.merchantId))).map(row => [row.id, row]));
      const list = [];
      for (const detail of selected) {
        const snapshot = snapshots.get(detail.snapshotId);
        const merchant = merchants.get(detail.merchantId);
        const display = snapshot && snapshot.displayJson || {};
        list.push({ ...detail, merchantName: merchant && merchant.name || "", display,
          orderNo: String(display.orderNo || detail.orderId), customer: String(display.customer || display.customerName || ""),
          productName: String(display.productName || ""), payAmount: snapshot && snapshot.paidTotal,
          payTime: snapshot && snapshot.judgeTime, paidTotal: snapshot && snapshot.paidTotal, hitReason: snapshot && snapshot.hitReason });
      }
      const positive = all.reduce((sum, row) => sum + Math.max(0, moneyToCents(row.amount, { signed: true })), 0);
      const reverse = all.reduce((sum, row) => sum + Math.min(0, moneyToCents(row.amount, { signed: true })), 0);
      const sum = { positiveAmount: formatMoney(positive), reverseAmount: formatMoney(reverse), netAmount: formatMoney(positive + reverse) };
      return { list, total: all.length, page, size, totalAmount: sum.netAmount, sum, orderCount: new Set(all.map(row => row.orderId)).size };
    });
  }
  function scanStats(scans) {
    const daily = new Map();
    for (const scan of scans) {
      const date = new Date(time(scan.scanAt) + 8 * engine.HOUR).toISOString().slice(0, 10);
      daily.set(date, (daily.get(date) || 0) + 1);
    }
    return { scanCount: scans.length, dailyScans: [...daily].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)) };
  }
  function merchantStats(merchantId, details, bindings, scans) {
    const totals = { T1: 0, T2: 0 }; const orders = new Set(); const typeOrders = { T1: new Set(), T2: new Set() };
    for (const detail of details) { totals[detail.splitType] += moneyToCents(detail.amount, { signed: true }); orders.add(detail.orderId); typeOrders[detail.splitType].add(detail.orderId); }
    const month = periodAt(now()); const current = details.filter(detail => detail.period === month);
    return { merchantId, accT1Amount: formatMoney(totals.T1), accT2Amount: formatMoney(totals.T2), totalAmount: formatMoney(totals.T1 + totals.T2),
      monthAmount: formatMoney(current.reduce((sum, detail) => sum + moneyToCents(detail.amount, { signed: true }), 0)),
      monthOrders: new Set(current.map(detail => detail.orderId)).size,
      bindingCount: bindings.length, boundUsers: bindings.length, ...scanStats(scans), orderCount: orders.size,
      t1OrderCount: typeOrders.T1.size, t2OrderCount: typeOrders.T2.size };
  }
  async function statsTx(conn, merchantId) {
    const details = await rows(conn, "detail", "WHERE merchant_id=?", [merchantId]);
    const bindings = await rows(conn, "binding", "WHERE merchant_id=? AND status='ACTIVE'", [merchantId]);
    const qr = await one(conn, "qr", "WHERE merchant_id=? AND status='ACTIVE'", [merchantId]);
    const scans = qr ? await rows(conn, "scan", "WHERE merchant_id=? AND qr_id=?", [merchantId, qr.id]) : [];
    return merchantStats(merchantId, details, bindings, scans);
  }
  async function listRuleSummaries(filters = {}) {
    return transaction(async conn => {
      const merchants = await rows(conn, "merchant", "ORDER BY created_at DESC,id DESC");
      const rules = merchants.length ? await getRulesTx(conn) : [];
      const details = await rows(conn, "detail");
      const bindings = merchants.length ? await rows(conn, "binding", "WHERE status='ACTIVE'") : [];
      const qrs = merchants.length ? await rows(conn, "qr", "WHERE status='ACTIVE'") : [];
      const scans = qrs.length ? await rows(conn, "scan") : [];
      const groupBy = (values, key) => { const map = new Map(); for (const row of values) { const id = row[key]; if (!map.has(id)) map.set(id, []); map.get(id).push(row); } return map; };
      const byRule = groupBy(rules, "merchantId"), byDetail = groupBy(details, "merchantId"), byBinding = groupBy(bindings, "merchantId"), byScan = groupBy(scans, "qrId");
      const activeQr = new Map(qrs.map(qr => [qr.merchantId, qr]));
      const latest = new Map();
      const all = [];
      for (const merchant of merchants) {
        const rule = (byRule.get(merchant.id) || [])[0] || null;
        latest.set(merchant.id, rule);
        const qr = activeQr.get(merchant.id);
        const item = { ...merchant, merchantId: merchant.id, merchantStatus: merchant.status, unconfigured: !rule,
          ratioT1: rule ? rule.ratioT1 : "0.0000", ratioT2: rule ? rule.ratioT2 : "0.0000", ttlHours: rule ? rule.ttlHours : 720,
          currentVersion: rule ? rule.versionNo : 0, lastModifiedAt: rule ? rule.effectiveFrom : merchant.updatedAt,
          configStatus: rule ? "ACTIVE" : "UNCONFIGURED", ...merchantStats(merchant.id, byDetail.get(merchant.id) || [], byBinding.get(merchant.id) || [], qr ? (byScan.get(qr.id) || []).filter(scan => scan.merchantId === merchant.id) : []) };
        if (filters.keyword && ![merchant.id, merchant.name].some(value => value.toLowerCase().includes(String(filters.keyword).toLowerCase()))) continue;
        const requestedStatus = String(filters.status || "").toUpperCase();
        if (requestedStatus && !(requestedStatus === "CONFIGURED" && !item.unconfigured) && ![item.status, item.configStatus].includes(requestedStatus)) continue;
        all.push(item);
      }
      const page = engine.positiveInt(filters.page, 1, 1000000, "页码"); const size = engine.positiveInt(filters.size, 20, 100000, "页大小");
      const month = periodAt(now());
      const summary = { total: merchants.length, configured: [...latest.values()].filter(Boolean).length, unconfigured: [...latest.values()].filter(rule => !rule).length,
        monthNetAmount: formatMoney(details.filter(detail => detail.period === month).reduce((sum, detail) => sum + moneyToCents(detail.amount, { signed: true }), 0)) };
      return { list: filters.all ? all : all.slice((page - 1) * size, page * size), total: all.length, page, size, summary };
    });
  }
  async function qrWithStats(conn, qr) {
    if (!qr) return null;
    const scans = qr.status === "ACTIVE" ? await rows(conn, "scan", "WHERE qr_id=?", [qr.id]) : [];
    const subjectHash = crypto.createHash("sha256").update(qr.id).digest("hex");
    const disabledAttempts = await rows(conn, "observation", "WHERE metric_key='DISABLED_QR_SCAN' AND subject_hash=?", [subjectHash]);
    return { ...qr, ...scanStats(scans), disabledScanCount: disabledAttempts.length };
  }
  async function reconcileRefundReversals(orderId, input = {}) {
    const wanted = id(orderId); const at = iso(input.now || now());
    return transaction(async conn => {
      await lockOrder(conn, wanted);
      const job = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
      if (job) await lockUser(conn, job.userId);
      let factsAdded = 0;
      for (const fact of input.refunds || []) {
        const refundNo = id(fact.refundNo); const amount = formatMoney(moneyToCents(fact.amount));
        if (moneyToCents(amount) <= 0) throw shareError("SHARE_4001", "退款金额必须大于0");
        const previous = await one(conn, "refund", "WHERE refund_no=?", [refundNo]);
        if (previous && (previous.orderId !== wanted || previous.amount !== amount)) throw shareError("SHARE_4090", "退款事实与既有记录不一致", 409);
        if (!previous) { await insert(conn, "refund", { refund_no: refundNo, order_id: wanted, amount, refund_at: dbTime(fact.refundAt || at), created_at: dbTime(at) }); factsAdded++; }
      }
      const refunds = (await rows(conn, "refund", "WHERE order_id=? ORDER BY refund_at,refund_no", [wanted])).filter(refund => time(refund.refundAt) <= time(at));
      const total = refunds.reduce((sum, refund) => sum + moneyToCents(refund.amount), 0);
      if (job && total > moneyToCents(job.paidTotal)) throw shareError("SHARE_4001", "累计成功退款超过整单实付");
      const effective = await effectiveStateTx(conn, wanted); const snapshot = effective.state;
      if (!snapshot || moneyToCents(snapshot.splitAmount) === 0) return { orderId: wanted, pending: !snapshot, repairedAmount: "0.00", overdueAmount: "0.00", overdue: false, factsAdded };
      const reversals = await rows(conn, "detail", "WHERE order_id=? AND direction=2 AND entry_type='REFUND' AND revision_no=?", [wanted, effective.revisionNo]);
      let reversed = reversals.reduce((sum, detail) => sum - moneyToCents(detail.amount, { signed: true }), 0);
      const dueTotal = refunds.filter(refund => time(refund.refundAt) <= time(at) - engine.DAY).reduce((sum, refund) => sum + moneyToCents(refund.amount), 0);
      const due = engine.calculateRefund({ snapshot, cumulativeRefundAmount: formatMoney(dueTotal), alreadyReversed: formatMoney(reversed) });
      const overdueAmount = due.reverseAmount;
      const expected = engine.calculateRefund({ snapshot, cumulativeRefundAmount: formatMoney(total), alreadyReversed: formatMoney(reversed) });
      const repairedAmount = expected.reverseAmount;
      if (moneyToCents(overdueAmount) > 0) await outboxTx(conn, `A4:${wanted}:${effective.revisionNo}:${due.targetReversedAmount}`, "REFUND_REVERSAL_OVERDUE",
        { orderId: wanted, revisionNo: effective.revisionNo, overdueAmount, repairedAmount, priority: "P1" }, at);
      let cumulative = 0;
      for (const refund of refunds) {
        cumulative += moneyToCents(refund.amount);
        const additional = engine.calculateRefund({ snapshot, cumulativeRefundAmount: formatMoney(cumulative), alreadyReversed: formatMoney(reversed) });
        if (moneyToCents(additional.reverseAmount) <= 0 || reversals.some(detail => detail.refundNo === refund.refundNo)) continue;
        const duplicate = await one(conn, "detail", "WHERE snapshot_id=? AND refund_no=?", [snapshot.id, refund.refundNo]);
        if (duplicate) continue;
        await insertDetailTx(conn, snapshot, formatMoney(-moneyToCents(additional.reverseAmount)), 2, refund.refundNo, at,
          { revisionNo: effective.revisionNo, correctionId: effective.correctionId });
        reversed += moneyToCents(additional.reverseAmount);
      }
      const remaining = engine.calculateRefund({ snapshot, cumulativeRefundAmount: formatMoney(total), alreadyReversed: formatMoney(reversed) });
      if (moneyToCents(remaining.reverseAmount) > 0) {
        const repairKey = `refund-repair:${snapshot.id}:${effective.revisionNo}:${remaining.targetReversedAmount}`;
        const repairNo = "FIX" + crypto.createHash("sha256").update(repairKey).digest("hex").slice(0, 32);
        await insertDetailTx(conn, snapshot, formatMoney(-moneyToCents(remaining.reverseAmount)), 2, repairNo, at,
          { entryKey: repairKey, revisionNo: effective.revisionNo, correctionId: effective.correctionId });
      }
      if (moneyToCents(repairedAmount) > 0) await auditTx(conn, "REFUND_REPAIR", wanted,
        { repairedAmount, overdueAmount, revisionNo: effective.revisionNo, refundNos: refunds.map(refund => refund.refundNo) }, null, at);
      return { orderId: wanted, repairedAmount, overdueAmount, overdue: moneyToCents(overdueAmount) > 0, revisionNo: effective.revisionNo, factsAdded };
    });
  }
  async function claimScheduledSlot(input) {
    const name = id(input.name); if (name.length > 64) throw shareError("SHARE_4001", "任务名过长");
    const at = iso(input.now || now()); const latest = iso(input.slotAt); const interval = Number(input.intervalMs);
    const leaseSeconds = engine.positiveInt(input.leaseSeconds, 300, 3600, "任务租约秒数");
    if (!Number.isFinite(interval) || interval < 60000) throw shareError("SHARE_4001", "任务周期无效");
    return transaction(async conn => {
      await query(conn, "INSERT INTO lxm_share_schedule (task_name,slot_at,next_slot_at,status,next_attempt_at,attempts,updated_at) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE task_name=VALUES(task_name)",
        [name, dbTime(latest), dbTime(latest), "PENDING", dbTime(at), 0, dbTime(at)]);
      const cursor = await one(conn, "schedule", "WHERE task_name=? FOR UPDATE", [name]);
      if (time(cursor.nextSlotAt) > time(at) || time(cursor.nextSlotAt) > time(latest) || time(cursor.nextAttemptAt) > time(at)
        || cursor.status === "RUNNING" && cursor.leaseUntil && time(cursor.leaseUntil) > time(at)) return { claimed: false, name };
      const skippedSlots = Math.max(0, Math.floor((time(latest) - time(cursor.nextSlotAt)) / interval));
      const token = crypto.randomBytes(16).toString("hex");
      const attempts = time(cursor.slotAt) === time(latest) ? cursor.attempts + 1 : 1;
      if (cursor.status === "RUNNING" && cursor.leaseToken) await query(conn, "UPDATE lxm_share_schedule_run SET status='LEASE_EXPIRED',finished_at=? WHERE lease_token=? AND status='RUNNING'", [dbTime(at), cursor.leaseToken]);
      await query(conn, "UPDATE lxm_share_schedule SET slot_at=?,status='RUNNING',lease_token=?,lease_until=?,next_attempt_at=?,attempts=?,updated_at=? WHERE task_name=?",
        [dbTime(latest), token, dbTime(new Date(time(at) + leaseSeconds * 1000)), dbTime(at), attempts, dbTime(at), name]);
      await insert(conn, "schedule_run", { task_name: name, slot_at: dbTime(latest), lease_token: token, status: "RUNNING", skipped_slots: skippedSlots, result_json: null, error_code: null, started_at: dbTime(at), finished_at: null });
      return { claimed: true, name, slotAt: latest, leaseToken: token, skippedSlots, attempts };
    });
  }
  async function settleScheduledSlot(input, failed) {
    const at = iso(input.now || now());
    return transaction(async conn => {
      const cursor = await one(conn, "schedule", "WHERE task_name=? FOR UPDATE", [id(input.name)]);
      if (!cursor || cursor.status !== "RUNNING" || cursor.leaseToken !== input.leaseToken || time(cursor.leaseUntil) < time(at)) return false;
      if (failed) await query(conn, "UPDATE lxm_share_schedule SET status='FAILED',lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE task_name=?", [dbTime(new Date(time(at) + 60000)), dbTime(at), input.name]);
      else await query(conn, "UPDATE lxm_share_schedule SET status='DONE',next_slot_at=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=? WHERE task_name=?", [dbTime(input.nextSlotAt), dbTime(at), dbTime(at), input.name]);
      await query(conn, "UPDATE lxm_share_schedule_run SET status=?,result_json=?,error_code=?,finished_at=? WHERE lease_token=?",
        [failed ? "FAILED" : "DONE", JSON.stringify(input.result || {}), failed ? String(input.errorCode || "SHARE_SCHEDULE_FAILED") : null, dbTime(at), input.leaseToken]);
      return true;
    });
  }
  return {
    ensureSchema,
    transaction,
    async onboardMerchant(input, hooks = {}) {
      const at = now();
      return transaction(async conn => {
        const existing = await getMerchantTx(conn, input.merchantId || input.id, true);
        if (existing) return { merchant: existing, merchantId: existing.id,
          rule: (await getRulesTx(conn, existing.id))[0] || null,
          qr: await one(conn, "qr", "WHERE merchant_id=? AND status='ACTIVE'", [existing.id]), existed: true };
        const merchant = await writeMerchantTx(conn, input, at);
        const rule = await saveRuleTx(conn, { ...input, merchantId: merchant.id, expectedVersion: 0 }, at);
        const qr = await saveQrTx(conn, { ...(input.qr || {}), merchantId: merchant.id, reason: input.reason || "商家入驻初始码", operatorId: input.operatorId }, at, false);
        if (hooks.beforeCommit) await hooks.beforeCommit(conn, { merchant, rule, qr });
        return { merchant, rule, qr, merchantId: merchant.id, existed: false };
      });
    },
    upsertMerchant: input => transaction(conn => writeMerchantTx(conn, input, now())),
    getMerchant: merchantId => transaction(conn => getMerchantTx(conn, id(merchantId))),
    getMerchantByName: name => transaction(conn => one(conn,'merchant','WHERE name=?',[String(name)])),
    listMerchants: filters => listRuleSummaries({ ...(filters || {}), all: true }).then(result => result.list),
    saveRule: input => transaction(conn => saveRuleTx(conn, input, now())),
    getRules: merchantId => transaction(conn => getRulesTx(conn, id(merchantId))),
    saveQr: input => transaction(conn => saveQrTx(conn, input, now(), false)),
    rotateQr: input => transaction(conn => saveQrTx(conn, input, now(), true)),
    getActiveQr: merchantId => transaction(async conn => qrWithStats(conn, await one(conn, "qr", "WHERE merchant_id=? AND status='ACTIVE'", [id(merchantId)]))),
    getQrByScene: scene => transaction(conn => one(conn, "qr", "WHERE scene=?", [String(scene)])),
    listQrs: merchantId => transaction(async conn => {
      const qrs = await rows(conn, "qr", "WHERE merchant_id=? ORDER BY qr_seq DESC", [id(merchantId)]);
      const active = qrs.filter(qr => qr.status === "ACTIVE");
      const scans = active.length ? await rows(conn, "scan", "WHERE " + active.map(() => "qr_id=?").join(" OR "), active.map(qr => qr.id)) : [];
      const hashes = qrs.map(qr => crypto.createHash("sha256").update(qr.id).digest("hex"));
      const attempts = hashes.length ? await rows(conn, "observation", "WHERE metric_key='DISABLED_QR_SCAN' AND (" + hashes.map(() => "subject_hash=?").join(" OR ") + ")", hashes) : [];
      const scanCounts = new Map(), disabledCounts = new Map();
      for (const scan of scans) scanCounts.set(scan.qrId, (scanCounts.get(scan.qrId) || 0) + 1);
      for (const attempt of attempts) disabledCounts.set(attempt.subjectHash, (disabledCounts.get(attempt.subjectHash) || 0) + 1);
      return qrs.map((qr, index) => ({ ...qr, scanCount: qr.status === "ACTIVE" ? scanCounts.get(qr.id) || 0 : 0, disabledScanCount: disabledCounts.get(hashes[index]) || 0 }));
    }),
    reportScan, reportClick,
    listScanRecords: () => transaction(conn => rows(conn, "scan", "ORDER BY scan_at DESC,id DESC")),
    async createCsLink(input) {
      const linkId = String(input.linkId || "").trim();
      if (!/^[A-Fa-f0-9]{32,64}$/.test(linkId)) throw shareError("SHARE_4001", "客服链接标识须为服务端生成的128位以上随机值");
      const staffId = id(input.staffId, "客服"); const operatorId = id(input.operatorId, "操作人"); const at = now();
      const expiresAt = iso(input.expiresAt || new Date(time(at) + 7 * engine.DAY));
      if (time(expiresAt) <= time(at)) throw shareError("SHARE_4001", "客服链接到期时间须晚于当前时间");
      const wecomUserId = input.wecomUserId ? id(input.wecomUserId, "企微用户") : null;
      const requestKey = input.requestId ? id(input.requestId, "链接生成请求标识") : null;
      const check = previous => {
        if (previous && (previous.staffId !== staffId || previous.wecomUserId !== wecomUserId)) throw shareError("SHARE_4090", "链接生成请求标识已用于其他客服", 409);
        return previous;
      };
      try {
        return await transaction(async conn => {
          const previous = requestKey ? await one(conn, "cs_link", "WHERE operator_id=? AND request_key=? FOR UPDATE", [operatorId, requestKey]) : null;
          if (previous) return { ...check(previous), existed: true };
          await insert(conn, "cs_link", { link_id: linkId, staff_id: staffId, wecom_user_id: wecomUserId, expires_at: dbTime(expiresAt), status: "ACTIVE", operator_id: operatorId, request_key: requestKey, created_at: dbTime(at) });
          await auditTx(conn, "CS_LINK_CREATE", linkId, { staffId, wecomUserId, expiresAt }, operatorId, at);
          return { linkId, staffId, wecomUserId, expiresAt, status: "ACTIVE", operatorId, createdAt: at, existed: false };
        });
      } catch (error) {
        // Under READ COMMITTED a concurrent insert may win without a gap-lock
        // deadlock. Read its committed result in a fresh transaction.
        if (requestKey && error.code === "SHARE_4090") {
          const previous = await transaction(conn => one(conn, "cs_link", "WHERE operator_id=? AND request_key=?", [operatorId, requestKey]));
          if (previous) return { ...check(previous), existed: true };
        }
        throw error;
      }
    },
    getCsLink: linkId => transaction(conn => one(conn, "cs_link", "WHERE link_id=?", [id(linkId, "客服链接")])),
    getCsLinkByRequest: (operatorId, requestId) => transaction(conn => one(conn, "cs_link", "WHERE operator_id=? AND request_key=?", [id(operatorId), id(requestId)])),
    getBindingsAsOf: (userId, at) => transaction(conn => getBindingsAsOfTx(conn, id(userId), iso(at))),
    getClicksAsOf: (userId, at) => transaction(conn => getClicksAsOfTx(conn, id(userId), iso(at))),
    enqueuePayment, recordRefund, processJob, correctSnapshot, reconcileRefundReversals, refreshPendingJob, refreshPendingBatch, reviewPostedFacts, invalidateUser,
    getEffectiveAttribution: orderId => transaction(async conn => effectiveStateTx(conn, id(orderId))),
    listRefundOrderIds: () => transaction(async conn => [...new Set((await query(conn, "SELECT DISTINCT order_id FROM lxm_share_refund")).map(row => String(row.order_id)))]),
    claimScheduledSlot,
    completeScheduledSlot: input => settleScheduledSlot(input, false),
    failScheduledSlot: input => settleScheduledSlot(input, true),
    renewScheduledSlot: input => transaction(async conn => {
      const at = iso(input.now || now()); const cursor = await one(conn, "schedule", "WHERE task_name=? FOR UPDATE", [id(input.name)]);
      if (!cursor || cursor.status !== "RUNNING" || cursor.leaseToken !== input.leaseToken || time(cursor.leaseUntil) < time(at)) return false;
      await query(conn, "UPDATE lxm_share_schedule SET lease_until=?,updated_at=? WHERE task_name=?", [dbTime(new Date(time(at) + 300000)), dbTime(at), input.name]); return true;
    }),
    readOperationalFacts: (options = {}) => transaction(async conn => {
      const allowed = ["job", "snapshot", "detail", "refund", "scan", "qr", "click", "cs_link", "observation", "correction"];
      const tables = options.tables == null ? allowed : [...new Set(options.tables)].filter(table => allowed.includes(table));
      const result = {}; for (const table of tables) result[table] = await rows(conn, table); return result;
    }),
    saveMetricSnapshot: input => transaction(async conn => {
      const previous = await one(conn, "metric", "WHERE slot_at=?", [dbTime(input.slotAt)]); if (previous) return previous;
      await insert(conn, "metric", { slot_at: dbTime(input.slotAt), metric_date: String(input.date), metrics_json: JSON.stringify(input.metrics), created_at: dbTime(now()) }); return input;
    }),
    recordObservation: input => {
      const valueText = input.valueText == null ? null : String(input.valueText);
      if (valueText && valueText.length > 255) throw shareError("SHARE_4001", "观测文本不得超过255字符");
      if (input.valueNumber != null && !Number.isFinite(Number(input.valueNumber))) throw shareError("SHARE_4001", "观测数值无效");
      return transaction(conn => insert(conn, "observation", { metric_key: id(input.metricKey),
        subject_hash: input.subjectId ? crypto.createHash("sha256").update(String(input.subjectId)).digest("hex") : null,
        success: input.success === false ? 0 : 1, value_number: input.valueNumber == null ? null : Number(input.valueNumber), value_text: valueText, occurred_at: dbTime(input.at || now()) }));
    },
    recordRisk: input => transaction(async conn => {
      const found = await one(conn, "risk", "WHERE entity_type=? AND entity_id=? AND risk_code=?", [String(input.entityType), id(input.entityId), id(input.code)]);
      if (found) return found;
      await insert(conn, "risk", { entity_type: String(input.entityType), entity_id: id(input.entityId), risk_code: id(input.code), priority: input.priority || "P1", status: "OPEN", payload_json: JSON.stringify(input.payload || {}), created_at: dbTime(now()) }); return input;
    }),
    getCorrections: orderId => transaction(conn => rows(conn, "correction", "WHERE order_id=? ORDER BY revision_no DESC", [id(orderId)])),
    getJob: orderId => transaction(conn => one(conn, "job", "WHERE order_id=?", [id(orderId)])),
    getSnapshot: orderId => transaction(conn => one(conn, "snapshot", "WHERE order_id=?", [id(orderId)])),
    retryJob: (orderId, reason, operatorId) => transaction(async conn => {
      const wanted = id(orderId, "订单"); const operator = id(operatorId, "操作人"); const explanation = String(reason || "").trim();
      if (!explanation || explanation.length > 255) throw shareError("SHARE_4001", "重试原因必填且最多255字");
      const job = await one(conn, "job", "WHERE order_id=? FOR UPDATE", [wanted]);
      if (!job) throw shareError("SHARE_4040", "分成任务不存在", 404);
      if (job.status === "DONE") return { job, existed: true };
      if (job.status !== "FAILED") throw shareError("SHARE_4090", "只有失败任务可以发起人工重试", 409);
      const at = now();
      await query(conn, "UPDATE lxm_share_job SET status='PENDING',attempts=?,next_attempt_at=?,last_error=NULL,updated_at=? WHERE order_id=?", [0, dbTime(at), dbTime(at), wanted]);
      await auditTx(conn, "JOB_RETRY", wanted, { reason: explanation, previousAttempts: job.attempts }, operator, at);
      return { job: { ...job, status: "PENDING", attempts: 0, nextAttemptAt: at }, existed: false };
    }),
    listDueJobs: ({ now: at = now(), limit = 100 } = {}) => transaction(conn => rows(conn, "job", "WHERE status='PENDING' AND available_at<=? AND (attempts=0 OR next_attempt_at<=?) ORDER BY pay_time,order_id LIMIT ?", [dbTime(at), dbTime(at), engine.positiveInt(limit, 100, 1000, "任务数")])),
    listDetails, listRuleSummaries,
    getMerchantStats: merchantId => transaction(conn => statsTx(conn, id(merchantId))),
    audit: (action, subjectId, payload, operatorId) => transaction(conn => auditTx(conn, action, id(subjectId), payload, operatorId)),
    listFailures: () => transaction(conn => rows(conn, "failure", "WHERE status='OPEN' ORDER BY created_at DESC")),
    listOutbox: ({ now: at = now(), limit = 100 } = {}) => transaction(conn => rows(conn, "outbox", "WHERE status='PENDING' AND next_attempt_at<=? ORDER BY id LIMIT ?", [dbTime(at), engine.positiveInt(limit, 100, 1000, "事件数")])),
    listFailedOutbox: () => transaction(conn => rows(conn, "outbox", "WHERE status='FAILED' ORDER BY updated_at DESC,id DESC")),
    retryOutbox: (eventId, reason, operatorId) => transaction(async conn => {
      const explanation = String(reason || "").trim(); if (!explanation || explanation.length > 255) throw shareError("SHARE_4001", "重试原因必填且最多255字");
      const event = await one(conn, "outbox", "WHERE id=? FOR UPDATE", [id(eventId)]); if (!event) throw shareError("SHARE_4040", "告警不存在", 404);
      if (event.status !== "FAILED") throw shareError("SHARE_4090", "仅失败通知可以重试", 409);
      const at = now(); await query(conn, "UPDATE lxm_share_outbox SET status='PENDING',attempts=?,next_attempt_at=?,updated_at=? WHERE id=?", [0, dbTime(at), dbTime(at), event.id]);
      await auditTx(conn, "ALERT_RETRY", event.id, { reason: explanation, eventType: event.eventType }, id(operatorId), at); return { id: event.id, status: "PENDING" };
    }),
    acknowledgeOutbox: eventId => transaction(conn => query(conn, "UPDATE lxm_share_outbox SET status='DONE',updated_at=? WHERE id=?", [dbTime(now()), id(eventId)])),
    failOutbox: eventId => transaction(async conn => {
      const event = await one(conn, "outbox", "WHERE id=? FOR UPDATE", [id(eventId)]);
      if (!event || event.status === "DONE") return null;
      const attempts = event.attempts + 1; const at = now();
      await query(conn, "UPDATE lxm_share_outbox SET attempts=?,status=?,next_attempt_at=?,updated_at=? WHERE id=?", [attempts, attempts >= 3 ? "FAILED" : "PENDING", dbTime(new Date(time(at) + 16000)), dbTime(at), event.id]);
      return { id: event.id, attempts };
    }),
  };
}
module.exports = { createShareStore, hydrate, dbTime };
