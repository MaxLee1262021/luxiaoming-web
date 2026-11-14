"use strict";

const crypto = require("node:crypto");
const b = require("./svcBenefit.cjs");
const { createPhotoStore } = require("./photoStore.cjs");
const { provisionPhotoAccount, requirePhotoAdministrator, validatePhotoCredentials } = require("./photoAccounts.cjs");
const DEFAULT_RATES = Object.freeze({ rate_photo_bp: 2000, rate_video_bp: 2000, rate_combo_bp: 2000, rate_peripheral_bp: 800 });
const SETTLEMENT_CYCLES = Object.freeze({ daily: "日结", weekly: "周结", monthly: "月结" });
const ZERO_REASONS = Object.freeze({ refund: "整单退款", stop_shoot: "中途停拍", complaint_photo: "摄影师责任", transfer: "已被转派" });
const STATUS_NAMES = { est: "预估", settleable: "可结算", settled: "已结算", void: "已置零" };
const fail = (code, message, data) => { const error = b.failure(code, message, 200, data); error.statusCode = 200; return error; };
const txt = value => String(value == null ? "" : value).trim();
const nowId = (state, key) => String(state[key].reduce((max, row) => { const id = /^\d+$/.test(String(row.id)) ? BigInt(row.id) : 0n; return id > max ? id : max; }, 0n) + 1n);
const operator = session => txt(typeof session === "string" ? session : session && (session.account || session.accountId || session.id || session.userId)) || "system";
const photoRows = state => state.ledgers.filter(row => row.beneficiary_type === "photo");
const photoAdjusts = state => state.adjustments.filter(row => txt(row.plan_id).startsWith("photo:"));
function reasonOf(input) { const reason = txt(input.reason); if (!reason) throw fail(4305, "变更原因必填"); if (reason.length > 255) throw fail(4314, "变更原因最多255字"); return reason; }
function ratesOf(input) {
  const data = input.rates || input;
  for (const key of b.CATEGORIES) if (data[key + "_bp"] == null && data["rate_" + key + "_bp"] == null) throw fail(4308, "单人比例必须四类一次给全");
  try { return b.ratesOf(data); } catch (error) { throw fail(4304, error.message); }
}
function ratesDisplay(row) { return Object.fromEntries(b.CATEGORIES.map(key => [key + "_bp", Number(row["rate_" + key + "_bp"])])); }
function latestRule(state, id = null) { return state.rules.filter(row => row.beneficiary_type === "photo" && txt(row.party_id) === txt(id)).sort((a, c) => Number(c.ver) - Number(a.ver))[0] || null; }
function currentRule(state, id, at) { return b.CATEGORIES.reduce((out, category) => { const rule = b.rateBpOf(state.rules, id, category, at, "photo"); out["rate_" + category + "_bp"] = rule.bp; out.ver = rule.ver; out.rule_mode = rule.mode; return out; }, {}); }
function saveVersion(state, input, id, who, at, initial = false) {
  const latest = latestRule(state, id);
  if (!initial && (input.ver == null || Number(input.ver) !== Number(latest && latest.ver || 0))) throw fail(4303, "配置已被他人修改，请刷新");
  const mode = input.rate_mode || input.rule_mode || "custom";
  if (!["custom", "global"].includes(mode) || id == null && mode === "global") throw fail(4314, "比例模式无效");
  const rates = mode === "global" ? Object.fromEntries(b.CATEGORIES.map(key => ["rate_" + key + "_bp", currentRule(state, null, at)["rate_" + key + "_bp"]])) : ratesOf(input);
  const row = { id: nowId(state, "rules"), ver: state.rules.reduce((max, r) => Math.max(max, Number(r.ver) || 0), 0) + 1,
    beneficiary_type: "photo", party_id: id, rule_mode: mode, ...rates, eff_at: initial ? b.localTime(at) : b.nextDay(at), reason: reasonOf(input), operator: who, created_at: b.localTime(at) };
  state.rules.push(row); return row;
}
function findParty(state, id) { const row = state.profiles.find(row => String(row.id) === String(id)); if (!row) throw fail(4300, "摄影师不存在"); return row; }
function allocateProfileNumbers(profiles, createdAt) {
  const year = createdAt.slice(0, 4), idPrefix = "PH" + year, agreementPrefix = "PH-XY-" + year + "-";
  const idPattern = new RegExp("^" + idPrefix + "(\\d+)$", "i"), agreementPattern = new RegExp("^" + agreementPrefix + "(\\d+)$", "i");
  let sequence = 1, agreementSequence = 1;
  // Called inside the shared runtime-lock transaction, so parallel onboarding
  // observes the last committed profile and cannot allocate the same number.
  for (const profile of profiles) {
    const id = txt(profile.id).match(idPattern), agreement = txt(profile.agree_no).match(agreementPattern);
    if (id) sequence = Math.max(sequence, Number(id[1]) + 1);
    if (agreement) agreementSequence = Math.max(agreementSequence, Number(agreement[1]) + 1);
  }
  agreementSequence = Math.max(sequence, agreementSequence);
  if (sequence > 9999) throw fail(4314, "本年度摄影师编号已用尽");
  if (agreementSequence > 9999) throw fail(4314, "本年度合作协议编号已用尽");
  return { id: idPrefix + String(sequence).padStart(4, "0"), agree_no: agreementPrefix + String(agreementSequence).padStart(4, "0") };
}
function profileLog(state, id, action, detail, who, at) { const row = { id: nowId(state, "logs"), photo_id: id, action, detail: String(detail).slice(0, 500), operator: who, created_at: b.localTime(at) }; state.logs.push(row); return row; }
function periodOf(value) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(txt(value))) throw fail(4314, "期间须为 YYYY-MM"); return value; }
function nextPeriod(value, delta = 1) { const [year, month] = periodOf(value).split("-").map(Number), date = new Date(Date.UTC(year, month - 1 + delta, 1)); return date.toISOString().slice(0, 7); }
function periodDistance(from, to) { return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5)); }
function settlementFor(state, id) { const row = state.settlements.find(row => row.settle_id === id); if (!row) throw fail(4300, "对账单不存在"); return row; }
function cancelledPlan(state, plan) { return photoAdjusts(state).some(row => row.plan_id === plan.plan_id && row.action === "cancel_offset"); }
function appliedPlan(state, plan) { return b.sumFen(photoAdjusts(state).filter(row => row.plan_id === plan.plan_id && row.settle_id && row.action === "offset_plan" && Number(row.amount_fen) > 0), "amount_fen"); }
function remainingPlan(state, plan) { return cancelledPlan(state, plan) ? 0 : Math.max(0, -Number(plan.amount_fen) - appliedPlan(state, plan)); }
function remainingMakeup(state, plan) { return Math.max(0, Number(plan.amount_fen) - b.sumFen(photoAdjusts(state).filter(row => row.plan_id === plan.plan_id && row.settle_id && row.action === "makeup"), "amount_fen")); }
function offsetFor(state, settlement) {
  const plans = photoAdjusts(state).filter(row => !row.settle_id && Number(row.amount_fen) < 0 && row.staff_id === settlement.photo_id && !cancelledPlan(state, row)).sort((a, c) => String(a.id).localeCompare(String(c.id), undefined, { numeric: true }));
  const credits = photoAdjusts(state).filter(row => !row.settle_id && row.action === "makeup" && Number(row.amount_fen) > 0 && row.staff_id === settlement.photo_id);
  const balances = new Map(plans.map(plan => [plan.plan_id, remainingPlan(state, plan)]));
  const creditBalances = new Map(credits.map(plan => [plan.plan_id, remainingMakeup(state, plan)]));
  const drafts = state.settlements.filter(row => row.photo_id === settlement.photo_id && row.status === "draft" && row.period <= settlement.period).sort((a, c) => a.period.localeCompare(c.period));
  for (const draft of drafts) {
    const makeups = credits.filter(plan => plan.period <= draft.period && creditBalances.get(plan.plan_id) > 0).map(plan => {
      const amount = creditBalances.get(plan.plan_id); creditBalances.set(plan.plan_id, 0); return { plan, amount };
    });
    const makeup = makeups.reduce((total, entry) => total + entry.amount, 0);
    let budget = Number(draft.amount_fen) + makeup; const entries = [];
    for (const plan of plans) {
      const age = periodDistance(plan.period, draft.period);
      if (age < 0 || age >= 3) continue;
      const amount = Math.min(budget, balances.get(plan.plan_id));
      if (amount > 0) { entries.push({ plan, amount, carried: age + 1 }); budget -= amount; balances.set(plan.plan_id, balances.get(plan.plan_id) - amount); }
      if (!budget) break;
    }
    // A negative offset is a net supplement. It uses the existing signed
    // amount columns and never changes a previously published statement.
    if (draft.settle_id === settlement.settle_id) return { amount: Number(draft.amount_fen) - budget, entries, makeups };
  }
  return { amount: 0, entries: [], makeups: [] };
}
function recalcSettlement(state, id) {
  const settlement = settlementFor(state, id);
  if (settlement.status !== "draft") return settlement;
  const rows = photoRows(state).filter(row => row.settle_id === id && row.status === "settled");
  settlement.item_count = rows.length; settlement.amount_fen = b.sumFen(rows, "commission_fen");
  settlement.offset_fen = offsetFor(state, settlement).amount;
  settlement.payable_fen = Math.max(0, settlement.amount_fen - settlement.offset_fen);
  return settlement;
}
function zeroLedger(state, id, reason, who, at) {
  if (!Object.hasOwn(ZERO_REASONS, reason)) throw fail(4314, "置零原因无效");
  const row = photoRows(state).find(row => String(row.id) === String(id));
  if (!row) return row;
  if (row.status === "void") {
    if (reason === "transfer" && row.zero_reason !== "transfer") {
      row.zero_reason = "transfer"; row.updated_at = b.localTime(at);
      profileLog(state, row.party_id, "transfer_zero", `订单 ${row.biz_no} 因转派保留为零元明细`, who, at);
    }
    return row;
  }
  const settlement = row.settle_id && settlementFor(state, row.settle_id);
  if (settlement && settlement.status !== "draft") {
    const baseId = "photo:ledger:" + row.id;
    const plans = photoAdjusts(state).filter(a => !a.settle_id && Number(a.amount_fen) < 0 && (a.plan_id === baseId || a.plan_id.startsWith(baseId + ":")));
    if (plans.some(plan => !cancelledPlan(state, plan))) return row;
    const planId = plans.length ? baseId + ":" + (plans.length + 1) : baseId;
    state.adjustments.push({ id: nowId(state, "adjustments"), order_no: row.biz_no, staff_id: row.party_id,
      action: settlement.status === "paid" ? "offset_plan" : "void", amount_fen: -Number(row.commission_fen), settle_id: null, carried: 0, plan_id: planId,
      period: nextPeriod(b.periodAt(at)), note: ZERO_REASONS[reason], operator: who, created_at: b.localTime(at) });
    if (reason === "transfer") profileLog(state, row.party_id, "transfer_zero", `订单 ${row.biz_no} 因转派置零；原对账单保持不变，下期冲抵`, who, at);
    return row; // Published original ledger AND statement remain immutable.
  }
  Object.assign(row, { commission_fen: 0, status: "void", zero_reason: reason, settle_id: null, updated_at: b.localTime(at) });
  if (reason === "transfer") profileLog(state, row.party_id, "transfer_zero", `订单 ${row.biz_no} 因转派置零`, who, at);
  if (settlement) recalcSettlement(state, settlement.settle_id);
  return row;
}
function restoreComplaint(state, row, order, who, at) {
  if (row.status === "void" && row.zero_reason === "complaint_photo") {
    Object.assign(row, { commission_fen: b.commissionFen(row.net_amount_fen, row.rate_bp), status: order.service_status === "done" && order.done_at ? "settleable" : "est",
      zero_reason: null, done_at: row.done_at || (order.done_at ? b.localTime(order.done_at) : null), updated_at: b.localTime(at) });
    profileLog(state, row.party_id, "restore", `订单 ${row.biz_no} 改判，按原支付比例快照恢复报酬`, who, at);
  }
  const baseId = "photo:ledger:" + row.id;
  const plans = photoAdjusts(state).filter(plan => !plan.settle_id && Number(plan.amount_fen) < 0 && plan.note === ZERO_REASONS.complaint_photo
    && (plan.plan_id === baseId || plan.plan_id.startsWith(baseId + ":")) && !cancelledPlan(state, plan));
  for (const plan of plans) {
    const deducted = appliedPlan(state, plan);
    state.adjustments.push({ id: nowId(state, "adjustments"), order_no: row.biz_no, staff_id: row.party_id, action: "cancel_offset", amount_fen: 0,
      settle_id: null, carried: 0, plan_id: plan.plan_id, period: nextPeriod(b.periodAt(at)), note: "改判撤销未执行冲抵", operator: who, created_at: b.localTime(at) });
    if (deducted) state.adjustments.push({ id: nowId(state, "adjustments"), order_no: row.biz_no, staff_id: row.party_id, action: "makeup", amount_fen: deducted,
      settle_id: null, carried: 0, plan_id: "photo:makeup:" + plan.id, period: nextPeriod(b.periodAt(at)), note: "改判补发已执行冲抵", operator: who, created_at: b.localTime(at) });
    profileLog(state, row.party_id, "restore", `订单 ${row.biz_no} 改判，撤销冲抵；已执行 ${b.money(deducted)} 元转下期补发`, who, at);
  }
  if (plans.length) for (const draft of state.settlements.filter(s => s.photo_id === row.party_id && s.status === "draft")) recalcSettlement(state, draft.settle_id);
}
function ownerOf(state, order) {
  const last = state.assignments.filter(row => row.order_no === order.no && row.to_photo).sort((a, c) => b.timestamp(c.created_at) - b.timestamp(a.created_at) || Number(c.id) - Number(a.id))[0];
  return last ? last.to_photo : order.photo_id || null;
}
function syncOrder(state, order, previous, who, at) {
  if (require("./photoLegacyCleanup.cjs").isClearedOrder(order, state.logs)) return { skipped: true, reason: "HISTORICAL_FINANCE_CLEARED" };
  const explicitTransition = previous && Object.hasOwn(order, "photo_id") && order.photo_id !== previous.photo_id;
  const id = explicitTransition ? order.photo_id : ownerOf(state, order);
  const existing = photoRows(state).filter(row => row.biz_no === order.no);
  const priorOwnerRow = existing.find(row => row.party_id === id);
  if (explicitTransition && priorOwnerRow && priorOwnerRow.settle_id && state.settlements.some(s => s.settle_id === priorOwnerRow.settle_id && s.status !== "draft")) throw fail(4311, "该摄影师的此单报酬已推送对账，往返转派需先由运营核对历史冲抵，禁止重复计酬");
  if (previous && previous.photo_id && previous.photo_id !== id) for (const row of existing.filter(row => row.party_id !== id)) zeroLedger(state, row.id, "transfer", who, at);
  const zero = order.zero_reason || (order.service_status === "refunded" ? "refund" : ["canceled", "cancelled"].includes(order.service_status) ? "stop_shoot" : null);
  if (zero) { for (const row of existing) zeroLedger(state, row.id, zero, who, at); return { zeroed: existing.length }; }
  if (!id) return { skipped: true, reason: "UNASSIGNED" };
  const party = findParty(state, id);
  const same = existing.find(row => row.party_id === id);
  if (party.status !== "active" && (explicitTransition || !previous && !same && order.service_status !== "done")) throw fail(4310, "摄影师已暂停或终止，不可派新单");
  if (!order.paid_at || !order.category || order.net_amount_fen == null) return { skipped: true, reason: "INCOMPLETE_PAYMENT_FACTS" };
  if (same && previous && previous.zero_reason === "complaint_photo") {
    restoreComplaint(state, same, order, who, at);
    return { ledger: same, restored: true };
  }
  if (same && same.status === "void" && same.zero_reason === "transfer" && previous && previous.photo_id !== id) {
    // Reassignment back before settlement reuses the unique order/person row;
    // the assignment audit preserves the intermediate transfer timeline.
  } else if (same && same.status !== "est") return { ledger: same, unchanged: true };
  if (b.integer(order.net_amount_fen) < 0n) throw fail(4314, "订单净额不能为负数");
  const rule = b.rateBpOf(state.rules, id, order.category, order.paid_at, "photo");
  const row = { id: same ? same.id : nowId(state, "ledgers"), biz_no: order.no, beneficiary_type: "photo", party_id: id, category: order.category,
    net_amount_fen: Number(b.integer(order.net_amount_fen)), rate_bp: rule.bp, rate_mode: rule.mode, rule_ver: rule.ver,
    commission_fen: b.commissionFen(order.net_amount_fen, rule.bp), observe_days: 0, status: order.service_status === "done" && order.done_at ? "settleable" : "est",
    zero_reason: null, customer_openid: order.customer_openid || null, is_rebuy: order.is_rebuy ? 1 : 0,
    paid_at: b.localTime(order.paid_at), done_at: order.done_at ? b.localTime(order.done_at) : null, settle_id: null,
    created_at: same ? same.created_at : b.localTime(at), updated_at: b.localTime(at) };
  if (same) Object.assign(same, row); else state.ledgers.push(row);
  return { ledger: row };
}
function makeDraft(state, period, photoId, at) {
  let draft = state.settlements.find(row => row.period === period && row.photo_id === photoId);
  if (draft && draft.status !== "draft") throw fail(4306, "该对账单已推送，不可修改");
  if (!draft) {
    draft = { settle_id: "ST-P-" + period.replace("-", "") + "-" + photoId, period, photo_id: photoId, item_count: 0, amount_fen: 0, offset_fen: 0, payable_fen: 0,
      status: "draft", dispute_until: null, pushed_at: null, accepted_at: null, paid_at: null, voucher_url: null, created_at: b.localTime(at) };
    state.settlements.push(draft);
  }
  return draft;
}
function batchSettle(state, input, at) {
  const period = periodOf(input.period || b.periodAt(at));
  const ids = input.ids || input.ledger_ids;
  if (!Array.isArray(ids) || !ids.length) throw fail(4314, "请勾选可结算明细");
  const selected = [...new Set(ids.map(String))].map(id => photoRows(state).find(row => String(row.id) === id));
  if (selected.some(row => !row || row.status !== "settleable" || row.settle_id || !row.done_at || b.periodAt(row.done_at) !== period)) throw fail(4311, "只可选择同一完成月、尚未入单的可结算明细");
  const touched = new Set();
  for (const row of selected) { const draft = makeDraft(state, period, row.party_id, at); row.status = "settled"; row.settle_id = draft.settle_id; touched.add(draft.settle_id); }
  return { rows: [...touched].map(id => recalcSettlement(state, id)), selected_count: selected.length, amount_fen: b.sumFen(selected, "commission_fen") };
}
function generateDrafts(state, period, at) {
  periodOf(period);
  const candidates = photoRows(state).filter(row => row.status === "settleable" && !row.settle_id && row.done_at && b.periodAt(row.done_at) === period);
  const closed = new Set(state.settlements.filter(row => row.period === period && row.status !== "draft").map(row => row.photo_id));
  const rows = candidates.filter(row => !closed.has(row.party_id)), skipped = candidates.filter(row => closed.has(row.party_id));
  const result = rows.length ? batchSettle(state, { period, ids: rows.map(row => row.id) }, at) : { rows: [], selected_count: 0, amount_fen: 0 };
  const touched = new Map(result.rows.map(row => [row.settle_id, row]));
  // Supplements must still be payable when the photographer has no new
  // completed orders. An earlier draft reserves its credits until pushed.
  const credits = photoAdjusts(state).filter(plan => plan.action === "makeup" && !plan.settle_id && plan.period <= period && remainingMakeup(state, plan) > 0 && !closed.has(plan.staff_id)
    && !state.settlements.some(row => row.photo_id === plan.staff_id && row.status === "draft" && row.period < period && row.period >= plan.period));
  for (const photoId of new Set(credits.map(plan => plan.staff_id))) {
    const existing = state.settlements.find(row => row.period === period && row.photo_id === photoId);
    const before = existing && Number(existing.payable_fen);
    const draft = recalcSettlement(state, makeDraft(state, period, photoId, at).settle_id);
    if (!existing || Number(draft.payable_fen) !== before) touched.set(draft.settle_id, draft);
  }
  return { ...result, rows: [...touched.values()], generated: touched.size, skipped_closed: skipped.map(row => row.biz_no) };
}
function queueNotification(state, settlement, type, at) {
  const event = type + ":" + settlement.settle_id;
  if (!state.notifications.some(row => row.event_key === event)) state.notifications.push({ id: crypto.randomBytes(16).toString("hex"), event_key: event,
    event_type: type, order_no: null, recipient_id: settlement.photo_id, message: type === "photo_statement" ? `摄影师对账单 ${settlement.settle_id} 已推送，应付 ${b.money(settlement.payable_fen)} 元；异议截止 ${settlement.dispute_until}` : `摄影师对账单 ${settlement.settle_id} 已登记线下发放`,
    status: "pending", attempts: 0, next_attempt_at: b.localTime(at), created_at: b.localTime(at), sent_at: null, failure_note: null });
}
function assertSettlementMatches(state, settlement) {
  const rows = photoRows(state).filter(row => row.settle_id === settlement.settle_id);
  if (rows.length !== Number(settlement.item_count) || b.sumFen(rows, "commission_fen") !== Number(settlement.amount_fen)
    || Number(settlement.payable_fen) < 0 || Number(settlement.payable_fen) !== Number(settlement.amount_fen) - Number(settlement.offset_fen)) throw fail(4312, "对账单金额与明细不符，已禁止发放，请联系财务核查");
}
function settlementAction(state, id, action, input, who, at) {
  if (action === "generate") return generateDrafts(state, periodOf(input.period), at);
  const row = settlementFor(state, id);
  if (action === "push") {
    if (row.status !== "draft") throw fail(4306, "该对账单已推送，不可修改");
    recalcSettlement(state, id); assertSettlementMatches(state, row);
    const allocation = offsetFor(state, row);
    for (const { plan, amount } of allocation.makeups) state.adjustments.push({ id: nowId(state, "adjustments"), order_no: plan.order_no, staff_id: row.photo_id,
      action: "makeup", amount_fen: amount, settle_id: row.settle_id, carried: 0, plan_id: plan.plan_id, period: row.period,
      note: "改判补发入账；原计划 " + plan.id, operator: who, created_at: b.localTime(at) });
    for (const { plan, amount, carried } of allocation.entries) state.adjustments.push({ id: nowId(state, "adjustments"), order_no: plan.order_no, staff_id: row.photo_id,
      action: "offset_plan", amount_fen: amount, settle_id: row.settle_id, carried, plan_id: plan.plan_id, period: row.period,
      note: "本期已冲抵；原计划 " + plan.id, operator: who, created_at: b.localTime(at) });
    row.status = "pushed"; row.pushed_at = b.localTime(at); row.dispute_until = b.addWorkdays(at, Number(findParty(state, row.photo_id).dispute_days));
    queueNotification(state, row, "photo_statement", at); return row;
  }
  if (action === "accept") {
    if (row.status !== "pushed") throw fail(4313, "仅已推送对账单可登记认可");
    row.status = "accepted"; row.accepted_at = b.localTime(at); profileLog(state, row.photo_id, "settle_accept", `对账单 ${id}：${reasonOf(input)}`, who, at); return row;
  }
  if (action === "pay") {
    if (row.status !== "accepted") throw fail(4313, "对账单认可后才可登记发放");
    const voucher = txt(input.voucher_url || input.voucherUrl);
    if (!voucher) throw fail(4307, "凭证必传");
    if (voucher.length > 255 || !/^(https:\/\/|\/api\/media\/)/.test(voucher)) throw fail(4307, "凭证须为已上传的文件地址或 HTTPS 地址");
    assertSettlementMatches(state, row); row.status = "paid"; row.paid_at = b.localTime(at); row.voucher_url = voucher;
    queueNotification(state, row, "photo_payment", at); return row;
  }
  throw fail(4314, "对账单操作无效");
}
function runTasks(state, at, generate = true) {
  const today = b.localTime(at).slice(0, 10), hourMinute = b.localTime(at).slice(11, 16); let repaired = 0, accepted = 0;
  // Repair first so an overdue missing deadline can be accepted in this run.
  for (const row of state.settlements.filter(row => hourMinute >= "00:10" && row.status === "pushed" && !row.dispute_until)) {
    if (!row.pushed_at) continue;
    row.dispute_until = b.addWorkdays(row.pushed_at, Number(findParty(state, row.photo_id).dispute_days)); repaired++;
  }
  for (const row of state.settlements.filter(row => hourMinute >= "00:05" && row.status === "pushed" && row.dispute_until && row.dispute_until < today)) {
    row.status = "accepted"; row.accepted_at = b.localTime(at); profileLog(state, row.photo_id, "settle_accept", `对账单 ${row.settle_id}：逾期未提异议`, "system", at); accepted++;
  }
  const draftResult = generate && (!today.endsWith("-01") || hourMinute >= "00:30") ? generateDrafts(state, nextPeriod(b.periodAt(at), -1), at) : { generated: 0 };
  const generated = draftResult.generated;
  const alerts = [];
  for (const biz_no of draftResult.skipped_closed || []) alerts.push({ code: "PHOTO_LATE_LEDGER_AFTER_PUSH", biz_no });
  for (const row of state.settlements) { try { assertSettlementMatches(state, row); } catch (_) { alerts.push({ code: "PHOTO_SETTLEMENT_MISMATCH", settle_id: row.settle_id }); } }
  for (const row of photoRows(state).filter(row => row.status !== "void")) if (b.commissionFen(row.net_amount_fen, row.rate_bp) !== Number(row.commission_fen)) alerts.push({ code: "PHOTO_LEDGER_MISMATCH", biz_no: row.biz_no });
  for (const row of photoAdjusts(state).filter(row => !row.settle_id && Number(row.amount_fen) < 0)) if (periodDistance(row.period, b.periodAt(at)) >= 3 && remainingPlan(state, row)) alerts.push({ code: "PHOTO_OFFSET_REQUIRES_REVIEW", plan_id: row.plan_id, remaining_fen: remainingPlan(state, row) });
  return { repaired, accepted, generated, alerts };
}
function orderMeta(state, bizNo) { return state.orders.find(row => (row.no || row.orderNo || row.order_no) === bizNo) || {}; }
function ledgerView(state, row) {
  const order = orderMeta(state, row.biz_no), party = state.profiles.find(profile => profile.id === row.party_id);
  const correction = photoAdjusts(state).find(a => a.order_no === row.biz_no && a.staff_id === row.party_id && !a.settle_id && Number(a.amount_fen) < 0 && remainingPlan(state, a) > 0);
  const makeup = photoAdjusts(state).filter(a => a.order_no === row.biz_no && a.staff_id === row.party_id && !a.settle_id && a.action === "makeup").reduce((sum, plan) => sum + remainingMakeup(state, plan), 0);
  return { ...row, photo_name: party && party.name || row.party_id, product_name: order.product_name || order.productName || order.packageName || order.title || "",
    merchant_name: order.merchant_name || order.shopName || "", original_commission_fen: b.commissionFen(row.net_amount_fen, row.rate_bp),
    zero_text: ZERO_REASONS[row.zero_reason] || (Number(row.rate_bp) === 0 ? "比例已设为 0" : ""), adjustment_pending: !!correction || makeup > 0,
    adjustment_reason: correction && correction.note || (makeup ? "改判补发待入账" : ""), makeup_pending_fen: makeup };
}
function filteredLedger(state, query, owner) {
  const keyword = txt(query.keyword).toLowerCase();
  return photoRows(state).filter(row => (!owner || row.party_id === owner) && (!(query.photo || query.photo_id) || row.party_id === (query.photo || query.photo_id))
    && (!(query.type || query.category) || row.category === (query.type || query.category)) && (!query.status || row.status === query.status)
    && (!query.period || row.done_at && b.periodAt(row.done_at) === query.period || !row.done_at && b.periodAt(row.paid_at) === query.period))
    .map(row => ledgerView(state, row)).filter(row => !keyword || [row.biz_no, row.customer_openid, row.photo_name, row.product_name].some(v => txt(v).toLowerCase().includes(keyword))).sort((a, c) => Number(c.id) - Number(a.id));
}
function page(rows, query) { const number = Math.max(1, Math.floor(Number(query.page) || 1)), size = Math.min(200, Math.max(1, Math.floor(Number(query.size || query.page_size) || 20))); return { rows: rows.slice((number - 1) * size, number * size), total: rows.length, page: number, size }; }
function selfId(session) { const role = txt(session && (session.roleKey || session.role || session.subjectType)); if (!["photo", "photographer"].includes(role)) throw fail(4309, "请使用绑定摄影师档案的本人账号访问"); const id = txt(session.photo_id || session.subjectId || session.subject_id); if (!id) throw fail(4309, "账号尚未绑定摄影师档案"); return id; }
function mineScope(query, session) { const preview = session?.role === "super" && session.kind !== "public"; return { preview, owner: preview ? txt(query.photo || query.photo_id) : selfId(session) }; }
function createPhotoShareService(options = {}) {
  const store = options.store || createPhotoStore(options.source, options);
  const at = () => options.clock ? options.clock() : new Date();
  const read = (kind, work) => store.withState(work, { readOnly: true, kind });
  const readMine = (owner, work, preview = false) => store.withState(work, { readOnly: true, kind: "mine", owner, allProfiles: preview });
  const write = work => store.withState(work);
  async function getRules() { return read("rules", state => { const active = state.rules.filter(row => row.beneficiary_type === "photo" && !row.party_id && b.timestamp(row.eff_at) <= b.timestamp(at())).sort((a, c) => Number(c.ver) - Number(a.ver))[0]; return { current: active || null, latest_ver: Number(latestRule(state)?.ver || 0), versions: state.rules.filter(row => row.beneficiary_type === "photo" && !row.party_id).sort((a, c) => Number(c.ver) - Number(a.ver)), overrides: state.profiles.filter(p => p.rate_mode === "custom").map(p => { const latest = latestRule(state, p.id), effective = state.rules.filter(row => row.beneficiary_type === "photo" && row.party_id === p.id && b.timestamp(row.eff_at) <= b.timestamp(at())).sort((a, c) => Number(c.ver) - Number(a.ver))[0], detail = effective || latest; return { ...p, rates: ratesDisplay(currentRule(state, p.id, at())), latest_ver: Number(latest?.ver || 0), reason: detail && detail.reason || "", operator: detail && detail.operator || "", eff_at: detail && detail.eff_at || null, pending: latest && b.timestamp(latest.eff_at) > b.timestamp(at()) ? latest : null }; }) }; }); }
  async function previewRule(input) { const proposed = ratesOf(input); return read("preview", state => { const rows = photoRows(state).filter(row => row.rate_mode === "global" && row.status === "est"), categories = b.CATEGORIES.map(category => { const candidates = rows.filter(row => row.category === category).map(row => b.commissionFen(row.net_amount_fen, proposed["rate_" + category + "_bp"]) - Number(row.commission_fen)).filter(delta => delta !== 0); return { category, count: candidates.length, delta_fen: candidates.reduce((sum, delta) => sum + delta, 0) }; }); return { affected_count: categories.reduce((sum, row) => sum + row.count, 0), delta_fen: categories.reduce((sum, row) => sum + row.delta_fen, 0), categories, basis: "未完成且使用统一比例的明细模拟；历史快照不重算" }; }); }
  async function saveRule(input, session) { return write(state => saveVersion(state, input, null, operator(session), at())); }
  async function listLedger(query = {}) { return read("ledger", state => { const rows = filteredLedger(state, query); return { ...page(rows, query), summary: { amount_fen: b.sumFen(rows, "commission_fen"), rows: rows.length, settled_rows: rows.filter(r => r.status === "settled").length, void_rows: rows.filter(r => r.status === "void").length } }; }); }
  async function exportCsv(query = {}, session, config = {}) {
    const scope = config.mine ? mineScope(query, session) : { owner: undefined, preview: false };
    const includePhotographer = !config.mine || scope.preview;
    return store.withState(state => {
      if (scope.preview && scope.owner) findParty(state, scope.owner);
      const rows = filteredLedger(state, config.mine ? { period: query.period } : query, scope.owner);
      const headers = ["订单号", "客户OpenID", ...(includePhotographer ? ["摄影师"] : []), "类目", "商品", "净额（元）", "计算依据", "比例", "报酬（元）", "状态"];
      return "\uFEFF" + [headers, ...rows.map(row => [row.biz_no, row.customer_openid, ...(includePhotographer ? [row.photo_name] : []), b.CATEGORY_NAMES[row.category], row.product_name, b.money(row.net_amount_fen), `${b.money(row.net_amount_fen)} × ${b.CATEGORY_NAMES[row.category]} ${Number(row.rate_bp) / 100}%`, `${Number(row.rate_bp) / 100}%`, b.money(row.commission_fen), STATUS_NAMES[row.status] + (row.zero_text || row.adjustment_reason ? "（" + (row.zero_text || row.adjustment_reason) + "）" : "")])].map(row => row.map(b.safeCsv).join(",")).join("\r\n");
    }, { readOnly: true, kind: "ledger", owner: scope.owner });
  }
  async function listParties(query = {}) { return read("parties", state => { const keyword = txt(query.keyword); const rows = state.profiles.filter(p => (!query.status || p.status === query.status) && (!keyword || [p.name, p.id, p.phone].some(v => txt(v).includes(keyword)))).map(p => {
    const ledgers = photoRows(state).filter(row => row.party_id === p.id), rule = currentRule(state, p.id, at());
    return { ...p, cycle: p.cycle || "monthly", rates: ratesDisplay(rule), latest_ver: Number(latestRule(state, p.id)?.ver || 0), month_fen: b.sumFen(ledgers.filter(row => row.done_at && b.periodAt(row.done_at) === b.periodAt(at())), "commission_fen"), total_fen: b.sumFen(ledgers, "commission_fen"), logs: state.logs.filter(row => row.photo_id === p.id).sort((a, c) => Number(c.id) - Number(a.id)) };
  }); return page(rows, query); }); }
  async function createParty(input, session) {
    requirePhotoAdministrator(session);
    const login = validatePhotoCredentials(input);
    const cycle = input.cycle === undefined ? "monthly" : input.cycle;
    if (typeof cycle !== "string" || !Object.hasOwn(SETTLEMENT_CYCLES, cycle)) throw fail(4314, "结算方式请选择日结、周结或月结");
    return write(async (state, context = {}) => {
    const name = txt(input.name), phone = txt(input.phone), createdAt = b.localTime(at());
    if (!name || name.length > 32 || !/^1[3-9]\d{9}$/.test(phone)) throw fail(4314, "请填写姓名及有效手机号");
    if (state.profiles.some(p => p.phone === phone) || (state.phones || []).includes(phone)) throw fail(4301, "手机号全平台唯一，已存在");
    const { id, agree_no: agree } = allocateProfileNumbers(state.profiles, createdAt);
    const profile = { id, name, phone, agree_no: agree, rate_mode: input.rate_mode || "custom", status: "active", dispute_days: Number(input.dispute_days ?? 5), wait_days: Number(input.wait_days ?? 3), cycle, created_at: createdAt };
    if (!Number.isInteger(profile.dispute_days) || profile.dispute_days < 1 || profile.dispute_days > 30 || !Number.isInteger(profile.wait_days) || profile.wait_days < 0 || profile.wait_days > 30) throw fail(4314, "异议期须为1–30工作日，等待天数须为0–30整数");
    const supplied = input.rates || input;
    const rates = b.CATEGORIES.some(key => supplied["rate_" + key + "_bp"] != null || supplied[key + "_bp"] != null) ? ratesOf(input) : Object.fromEntries(b.CATEGORIES.map(key => ["rate_" + key + "_bp", currentRule(state, null, at())["rate_" + key + "_bp"]]));
    const creationReason = txt(input.reason) || "建档；协议 " + agree;
    saveVersion(state, { ...rates, rate_mode: profile.rate_mode, reason: creationReason }, id, operator(session), createdAt, true);
    state.profiles.push(profile); profileLog(state, id, "create", `建档；协议 ${agree}；结算方式 ${SETTLEMENT_CYCLES[cycle]}；比例 ${JSON.stringify(rates)}；原因：${creationReason}`, operator(session), createdAt);
    const account = await (options.provisionAccount || provisionPhotoAccount)(context.conn, profile, login);
    if (!account || account.account !== login.account || !account.account_id || account.account_created !== true) throw b.failure(4399, "摄影师账号创建未完成，建档已回滚", 503);
    return { ...profile, account: account.account, account_id: account.account_id, account_created: true };
  }); }
  async function savePartyRate(id, input, session) { return write(state => { const profile = findParty(state, id), old = currentRule(state, id, at()); const row = saveVersion(state, input, id, operator(session), at()); profile.rate_mode = row.rule_mode; profileLog(state, id, "rate", `${JSON.stringify(ratesDisplay(old))} → ${row.rule_mode === "global" ? "统一比例" : JSON.stringify(ratesDisplay(row))}；原因：${row.reason}；请同步合作协议`, operator(session), at()); return row; }); }
  async function setPartyStatus(id, input, session) { return write(state => { const profile = findParty(state, id); if (!["active", "paused", "ended"].includes(input.status)) throw fail(4314, "状态无效"); if (profile.status === "ended" && input.status !== "ended") throw fail(4310, "已终止档案不可恢复，请重新建档"); const reason = reasonOf(input); if (input.status === "ended" && Number(profile.pending_count) > 0) throw fail(4302, `无法终止：${profile.name} 还有 ${profile.pending_count} 笔在途订单，需逐单选择「改派 / 本人拍完 / 取消」，不允许一键放行`, { pending_count: Number(profile.pending_count), pending_orders: profile.pending_orders }); if (profile.status === input.status) return { photo_id: id, status: profile.status }; profile.status = input.status; profileLog(state, id, { active: "resume", paused: "pause", ended: "end" }[input.status], reason, operator(session), at()); return { photo_id: id, status: profile.status }; }); }
  async function listSettlements(query = {}) { return read("settlements", state => page(state.settlements.filter(row => (!query.period || row.period === query.period) && (!(query.photo || query.photo_id) || row.photo_id === (query.photo || query.photo_id)) && (!query.status || row.status === query.status)).map(row => ({ ...row, photo_name: findParty(state, row.photo_id).name, acceptance_note: state.logs.filter(log => log.photo_id === row.photo_id && log.action === "settle_accept" && log.detail.includes(row.settle_id)).map(log => log.detail).join("；") })).sort((a, c) => c.period.localeCompare(a.period)), query)); }
  async function mine(query = {}, session) {
    const { owner, preview } = mineScope(query, session);
    return readMine(owner, state => {
      const photo = owner ? findParty(state, owner) : null;
      const rows = filteredLedger(state, { period: query.period }, owner).map(row => ({ ...row, photo_id: row.party_id }));
      const all = photoRows(state).filter(row => !owner || row.party_id === owner);
      return {
        photo: photo ? { id: owner, name: photo.name, agree_no: photo.agree_no, status: photo.status, cycle: photo.cycle || "monthly" } : {},
        aggregate: preview && !owner,
        photographers: preview ? state.profiles.map(({ id, name, status }) => ({ id, name, status })) : [],
        kpi: { month_fen: b.sumFen(rows, "commission_fen"), total_fen: b.sumFen(all, "commission_fen"), month_orders: owner ? rows.length : new Set(rows.map(row => row.biz_no)).size, rates: owner ? ratesDisplay(currentRule(state, owner, at())) : null, settled_rows: all.filter(row => row.status === "settled").length },
        ...page(rows, query),
        settlements: state.settlements.filter(row => (!owner || row.photo_id === owner) && (preview || row.status !== "draft") && (!query.period || row.period === query.period)).map(row => ({ ...row, photo_name: state.profiles.find(profile => profile.id === row.photo_id)?.name || row.photo_id })),
      };
    }, preview);
  }
  async function onOrderChanged(order, previous, config = {}) { return store.withState(state => syncOrder(state, order, previous, config.operator || "system", at()), { conn: config.conn }); }
  async function validateAssignment(id, config = {}) { return store.withState(state => { const profile = findParty(state, id); if (profile.status !== "active") throw fail(4310, "摄影师已暂停或终止，不可派新单"); return profile; }, { conn: config.conn, readOnly: true, kind: "assignment", owner: id }); }
  return { store, getRules, previewRule, saveRule, listLedger, exportCsv, listParties, createParty, savePartyRate, setPartyStatus, listSettlements, mine,
    batchSettle: (input, session) => write(state => batchSettle(state, input, at())), settlementAction: (id, action, input = {}, session) => write(state => settlementAction(state, id, action, input, operator(session), at())),
    runTasks: value => write(state => runTasks(state, value || at())), onOrderChanged, validateAssignment,
    zeroLedger: (id, reason, session, config = {}) => store.withState(state => zeroLedger(state, id, reason, operator(session), at()), { conn: config.conn }),
    syncOrderTx: (conn, order, previous, who = "system") => onOrderChanged(order, previous, { conn, operator: who }) };
}
module.exports = { createPhotoShareService, DEFAULT_RATES, ZERO_REASONS, ratesOf, saveVersion, currentRule, zeroLedger, syncOrder, ownerOf, recalcSettlement, batchSettle, generateDrafts, settlementAction, runTasks, nextPeriod, remainingPlan, selfId };
