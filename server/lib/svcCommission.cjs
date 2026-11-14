"use strict";
const crypto = require("node:crypto");
const B = require("./svcBenefit.cjs");
const core = require("./svcCore.cjs");
const { failure, timestamp, localTime, periodAt, nextDay, ratesOf, rateBpOf, commissionFen, statusOf, duePeriod, sumFen, integer, money, safeCsv, addWorkdays } = B;
const str = value => String(value == null ? "" : value).trim();
const SETTLEMENT_CYCLES=Object.freeze(['月结','半月结','周结','隔天结']);
function settlementCycle(value) {
  if(value===undefined)return '月结';
  if(typeof value!=='string'||!SETTLEMENT_CYCLES.includes(value))throw failure(4014,'多久结一次须选择月结、半月结、周结或隔天结');
  return value;
}
const idOf = (state, key) => String(state[key].reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1);
const actor = session => str(session.authzUserId || session.accountId || session.id || session.subjectId || "system");
const isSuper = session => session.kind !== "public" && ["super", "admin", "administrator"].includes(session.role);
const isFinance = session => session.kind !== "public" && session.role === "finance";
const isSupervisor = session => session.kind !== "public" && ["supervisor", "service_supervisor", "serviceManager"].includes(session.role);
const isService = session => session.kind !== "public" && session.role === "service";
function arrays(state) { for (const key of ["orders", "staff", "configs", "rules", "ledger", "settlements", "appeals", "adjustments", "complaints", "staffLogs"]) state[key] ||= []; return state; }
function configAt(state, at) { return {...core.DEFAULT_CONFIG,...state.configs.filter(row => timestamp(row.eff_at) <= timestamp(at)).sort((a, b) => timestamp(b.eff_at) - timestamp(a.eff_at) || Number(b.ver) - Number(a.ver))[0]}; }
function staffRateConfiguration(rules, staffId, at) {
  // Personnel management shows the latest saved configuration, including the
  // next-day version. Payment calculations continue to use rateBpOf at paid_at.
  const ordered = rules.filter(row => row.beneficiary_type === "service" && (row.party_id == null || row.party_id === "" || String(row.party_id) === String(staffId)))
    .sort((a, b) => timestamp(b.eff_at) - timestamp(a.eff_at) || Number(b.ver) - Number(a.ver));
  const personal = ordered.find(row => row.party_id != null && row.party_id !== "" && String(row.party_id) === String(staffId));
  const custom = personal && personal.rule_mode !== "global";
  const rule = custom ? personal : ordered.find(row => row.party_id == null || row.party_id === "");
  if (!rule) return { configured_rates: null, rate_pending: false, rate_effective_at: null };
  // A return-to-global marker contains a historical global snapshot. Resolve
  // the actual global rule and retain the later activation of that transition.
  const effAt = !custom && personal && timestamp(personal.eff_at) > timestamp(rule.eff_at) ? personal.eff_at : rule.eff_at;
  return { configured_rates: { ...rule, rule_mode: custom ? "custom" : "global", eff_at: effAt },
    rate_pending: timestamp(effAt) > timestamp(at), rate_effective_at: effAt };
}
function staffIdentity(state, session) {
  const direct = str(session.staffId || session.staff_id || session.subjectId);
  return state.staff.find(row => row.id === direct || row.account_id && row.account_id === session.authzUserId)?.id || direct;
}
function visibleStaff(state, session) {
  if (isSuper(session) || isFinance(session)) return null;
  const me = staffIdentity(state, session);
  if (isSupervisor(session)) return new Set(state.staff.filter(row => String(row.supervisor_id || "") === String(me) || row.id === me).map(row => row.id));
  if (isService(session)) return new Set([me]);
  throw failure(4030, "无操作权限", 403);
}
function canEditProfile(state, session, staffId) {
  if (isSuper(session)) return true;
  return isSupervisor(session) && visibleStaff(state, session).has(staffId);
}
function profileMetadata(input, previous = {}) {
  const result = { assessment_tags: [...(previous.assessment_tags || [])], rate_review_date: previous.rate_review_date || null };
  if (Object.hasOwn(input, "assessment_tags")) {
    if (!Array.isArray(input.assessment_tags) || input.assessment_tags.length > 10) throw failure(4014, "标签最多10个");
    result.assessment_tags = input.assessment_tags.map(tag => {
      if (typeof tag !== "string" || !tag.trim() || Array.from(tag.trim()).length > 32 || /[\u0000-\u001f\u007f]/.test(tag)) throw failure(4014, "每个标签须为1至32字的普通文字");
      return tag.trim();
    });
    if (new Set(result.assessment_tags).size !== result.assessment_tags.length) throw failure(4014, "标签不可重复");
  }
  if (Object.hasOwn(input, "rate_review_date")) {
    if (input.rate_review_date === null || input.rate_review_date === "") result.rate_review_date = null;
    else {
      const date = str(input.rate_review_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(core.millis(date + " 00:00:00")) || core.stamp(date + " 00:00:00").slice(0, 10) !== date) throw failure(4014, "复核日期无效");
      result.rate_review_date = date;
    }
  }
  return result;
}
function mustSuper(session) { if (!isSuper(session)) throw failure(4030, "仅超管可修改比例与档案", 403); }
function mustFinance(session) { if (!isSuper(session) && !isFinance(session)) throw failure(4030, "仅财务或超管可办理结算", 403); }
function reasonOf(value, max = 255) { const reason = str(value); if (!reason || reason.length > max) throw failure(5002, "变更原因必填且不得超过" + max + "字"); return reason; }
function requirePeriod(value) { const period = str(value); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw failure(4014, "归属期必须为YYYY-MM"); return period; }
function nextPeriod(period) { const [year, month] = requirePeriod(period).split("-").map(Number); return `${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}`; }
function adjustment(state, values, at) {
  const row = { id: idOf(state, "adjustments"), amount_fen: 0, settle_id: null, carried: 0, note: "", operator: "system", created_at: localTime(at), ...values };
  state.adjustments.push(row); return row;
}
// Both beneficiaries share svc_adjust. Photographer plans are owned by the
// photo module, including its positive recovery and makeup entries.
const serviceAdjustments = state => state.adjustments.filter(row => !str(row.plan_id).startsWith("photo:"));
function latestComplaint(state, order) {
  const complaint = state.complaints.find(row => row.order_no === order.order_no);
  if (!complaint) return "";
  const history = typeof complaint.rejudge_log === "string" ? JSON.parse(complaint.rejudge_log || "[]") : complaint.rejudge_log || [];
  return history.length ? history[history.length - 1].to : complaint.resp;
}
// SQL transactions defer photo events to svcStore's final flush, where the
// photo module can read its own published statements on the same connection.
// Isolated memory tests delegate to that same photo core with separate tables.
function photoState(state) {
  state.photoSettlements ||= []; state.photoLogs ||= []; state.notifications ||= []; state.assignLogs ||= [];
  return { profiles: state.photoProfiles || state.photographers || [], settlements: state.photoSettlements, logs: state.photoLogs,
    rules: state.rules, ledgers: state.ledger, adjustments: state.adjustments, assignments: state.assignLogs,
    orders: state.orders, notifications: state.notifications };
}
function photoOrder(state, order, reason) {
  const responsibility = Object.hasOwn(order, "complaint_resp") ? order.complaint_resp : latestComplaint(state, order);
  return { ...order, no: order.order_no || order.no, photo_id: order.photo_id || null,
    zero_reason: reason || (responsibility === "photo" ? "complaint_photo" : null) };
}
function syncMemoryPhoto(state, order, previous, at, reason) {
  if (state.photoNative || !state.rules.some(row => row.beneficiary_type === "photo")) return null;
  return require("./photoShare.cjs").syncOrder(photoState(state), photoOrder(state,order,reason), previous && photoOrder(state,previous), "service-workbench", at).ledger || null;
}
function ensureLedger(state, order, at = new Date(), beneficiaryType = "service") {
  arrays(state);
  if (beneficiaryType === "photo") return syncMemoryPhoto(state,order,null,at);
  const party = order.assignee_id;
  if (!party || !order.paid_at) return null;
  let row = state.ledger.find(item => item.biz_no === order.order_no && item.beneficiary_type === beneficiaryType && item.party_id === party);
  if (!row) {
    const rate = rateBpOf(state.rules, party, order.category, order.paid_at, beneficiaryType);
    const net = Number(integer(order.service_net_amount_fen ?? order.net_amount_fen ?? 0));
    row = { id: idOf(state, "ledger"), biz_no: order.order_no, beneficiary_type: beneficiaryType, party_id: party, category: order.category,
      net_amount_fen: net, rate_bp: rate.bp, rate_mode: rate.mode, rule_ver: rate.ver, commission_fen: commissionFen(net, rate.bp),
      observe_days: core.staffTiming(state.staff.find(staff => String(staff.id) === String(party)), configAt(state, order.paid_at)).observe_days, status: "est", zero_reason: null,
      customer_openid: order.customer_openid || null, is_rebuy: order.is_rebuy ? 1 : 0, paid_at: order.paid_at, done_at: order.done_at || null,
      settle_id: null, created_at: localTime(at), updated_at: localTime(at) };
    state.ledger.push(row);
  }
  if (row.status !== "settled") {
    if (order.done_at && !row.done_at) row.done_at = order.done_at;
    const complaintResp = latestComplaint(state, order);
    if (order.service_status === "refunded") row.zero_reason = "refund";
    else if (complaintResp === (beneficiaryType === "photo" ? "photo" : "service")) row.zero_reason = "complaint_service";
    row.status = statusOf(row, { ...order, complaint_resp: complaintResp }, at, row);
    row.updated_at = localTime(at);
  }
  return row;
}
function recompute(state, settlement) {
  if (settlement.status !== "draft") throw failure(5005, "本期已确认，明细已锁定");
  const rows = state.ledger.filter(row => row.settle_id === settlement.settle_id && row.beneficiary_type === "service" && row.status === "settled");
  settlement.item_count = rows.length;
  settlement.amount_fen = sumFen(rows, "commission_fen");
  settlement.payable_fen = settlement.amount_fen + Number(settlement.makeup_fen || 0) + Number(settlement.offset_fen || 0);
  return settlement;
}
function queueOffset(state, row, at, note, operator = "system") {
  const changes = serviceAdjustments(state);
  const existing = changes.find(plan => plan.order_no === row.biz_no && plan.staff_id === row.party_id && plan.action === "offset_plan" && !plan.settle_id
    && (!plan.plan_id || plan.plan_id === String(plan.id)) && !changes.some(item => item.plan_id === String(plan.id) && item.action === "cancel_offset"));
  // A refund and a responsibility decision describe the same lost commission.
  // They must never recover that commission twice.
  if (existing) return existing;
  const period = nextPeriod(periodAt(at));
  const plan = adjustment(state, { order_no: row.biz_no, staff_id: row.party_id, action: "offset_plan", amount_fen: -row.commission_fen,
    note, operator, period, plan_id: null }, at);
  plan.plan_id = String(plan.id); return plan;
}
function applyComplaint(state, order, oldResp, newResp, at = new Date(), operator = "system") {
  arrays(state);
  if (order.service_status === "refunded") { onRefund(state, order, at); return; }
  for (const row of state.ledger.filter(item => item.biz_no === order.order_no && item.beneficiary_type === "service")) {
    const accountable = "service";
    if (oldResp === newResp) continue;
    const settlement = state.settlements.find(item => item.settle_id === row.settle_id);
    const locked = settlement && settlement.status !== "draft";
    if (newResp === accountable) {
      if (locked) queueOffset(state, row, at, "判责变化，下期冲抵", operator);
      else {
        row.zero_reason = "complaint_service"; row.status = "void"; row.settle_id = null;
        adjustment(state, { order_no: row.biz_no, staff_id: row.party_id, action: "void", operator, note: "客服责任置零，金额快照保留" }, at);
        if (settlement) recompute(state, settlement);
      }
    } else if (oldResp === accountable) {
      if (locked) {
        const changes = serviceAdjustments(state);
        const plans = changes.filter(item => item.order_no === row.biz_no && item.staff_id === row.party_id && item.action === "offset_plan" && !item.settle_id
          && (!item.plan_id || item.plan_id === String(item.id)) && !changes.some(cancel => cancel.plan_id === String(item.id) && cancel.action === "cancel_offset"));
        let deducted = 0;
        for (const plan of plans) {
          const applied = changes.filter(item => item.plan_id === String(plan.id) && item.settle_id && item.action === "offset_plan");
          deducted += -sumFen(applied, "amount_fen");
          const remaining = Math.max(0, -plan.amount_fen + sumFen(applied, "amount_fen"));
          // Always close the plan, even when it was fully recovered. Otherwise
          // a retry can pay the makeup twice and a later decision cannot debit
          // the same order again. Cancellation is an audit event, not income.
          adjustment(state, { order_no: row.biz_no, staff_id: row.party_id, action: "cancel_offset", amount_fen: 0, plan_id: String(plan.id), operator,
            note: remaining ? "改判撤销未执行冲抵，剩余" + money(remaining) + "元" : "改判终止已执行冲抵计划" }, at);
        }
        if (deducted) adjustment(state, { order_no: row.biz_no, staff_id: row.party_id, action: "makeup", amount_fen: deducted, period: nextPeriod(periodAt(at)), operator, note: "改判补发，随下期结算发放" }, at);
      } else {
        if (row.zero_reason === "complaint_service") row.zero_reason = null;
        row.status = statusOf(row, { ...order, complaint_resp: newResp }, at, row);
        if (row.status === "settleable") adjustment(state, { order_no: row.biz_no, staff_id: row.party_id, action: "restore", operator, note: "改判恢复，金额快照不变" }, at);
      }
    } else if (newResp === "unknown" && !locked && row.status !== "void") {
      row.status = "obs"; row.settle_id = null;
      if (settlement) recompute(state, settlement);
    }
  }
  if (oldResp !== newResp && (newResp === "photo" || oldResp === "photo")) syncMemoryPhoto(state,
    { ...order, complaint_resp: newResp }, { ...order, complaint_resp: oldResp }, at);
}
function transferPhoto(state, order, oldId, at = new Date()) {
  return syncMemoryPhoto(state,order,{...order,photo_id:oldId},at);
}
function onRefund(state, order, at = new Date()) {
  for (const row of state.ledger.filter(item => item.biz_no === order.order_no && item.beneficiary_type === "service")) {
    const settlement = state.settlements.find(item => item.settle_id === row.settle_id);
    if (settlement && settlement.status !== "draft") {
      if (!state.adjustments.some(item => item.order_no === order.order_no && item.staff_id === row.party_id && item.action === "offset_plan" && item.note === "退款，下期冲抵")) queueOffset(state, row, at, "退款，下期冲抵");
    } else {
      if (row.zero_reason !== "refund") adjustment(state, { order_no: row.biz_no, staff_id: row.party_id, action: "void", amount_fen: 0, note: "退款置零，金额快照保留" }, at);
      row.zero_reason = "refund"; row.status = "void"; row.settle_id = null;
      if (settlement) recompute(state, settlement);
    }
  }
  syncMemoryPhoto(state,{...order,service_status:"refunded"},null,at,"refund");
}
function newSettlement(state, period, staffId, at) {
  let row = state.settlements.find(item => item.period === period && item.staff_id === staffId);
  if (row) return row;
  const suffix = crypto.createHash("sha256").update(String(staffId)).digest("hex").slice(0, 12);
  const staff = state.staff.find(item => item.id === staffId);
  row = { settle_id: `ST-S-${period.replace("-", "")}-${suffix}`, period, staff_id: staffId, item_count: 0, amount_fen: 0,
    base_salary_fen: Number(staff?.base_salary || 0) * 100, offset_fen: 0, makeup_fen: 0, payable_fen: 0, status: "draft",
    appeal_until: null, confirmed_at: null, acknowledged_at: null, paid_at: null, voucher_url: null, created_at: localTime(at) };
  state.settlements.push(row); return row;
}
function allocateAdjustments(state, settlement, at) {
  // Called once at confirmation: all allocations are append-only and rollback
  // together with the settlement if any verification fails.
  const config = configAt(state, at), capBp = Number(config.offset_cap_bp ?? 3000), maxPeriods = Number(config.offset_periods ?? 3);
  const changes = serviceAdjustments(state);
  const makeups = changes.filter(row => row.staff_id === settlement.staff_id && row.action === "makeup" && !row.settle_id && (row.period || nextPeriod(periodAt(row.created_at))) <= settlement.period);
  let makeup = 0;
  for (const row of makeups) if (!changes.some(item => item.action === "makeup" && item.plan_id === `makeup:${row.id}` && item.settle_id)) {
    makeup += Number(row.amount_fen);
    adjustment(state, { order_no: row.order_no, staff_id: row.staff_id, action: "makeup", amount_fen: row.amount_fen,
      settle_id: settlement.settle_id, plan_id: `makeup:${row.id}`, period: settlement.period, note: "补发入账" }, at);
  }
  let cap = commissionFen(settlement.amount_fen + makeup, capBp), offsets = 0;
  const plans = changes.filter(row => row.staff_id === settlement.staff_id && row.action === "offset_plan" && !row.settle_id
    && (!row.plan_id || row.plan_id === String(row.id)) && (row.period || nextPeriod(periodAt(row.created_at))) <= settlement.period);
  for (const plan of plans) {
    const records = changes.filter(row => row.plan_id === String(plan.id));
    if (records.some(row => row.action === "cancel_offset") || records.some(row => row.note === "已转线下")) continue;
    const applied = records.filter(row => row.action === "offset_plan" && row.settle_id);
    const remaining = Math.max(0, -Number(plan.amount_fen) + sumFen(applied, "amount_fen"));
    if (!remaining) continue;
    const carried = applied.length + 1, deduct = Math.min(remaining, cap);
    adjustment(state, { order_no: plan.order_no, staff_id: plan.staff_id, action: "offset_plan", amount_fen: -deduct,
      settle_id: settlement.settle_id, carried, plan_id: String(plan.id), period: settlement.period, note: `第${carried}期冲抵` }, at);
    cap -= deduct; offsets -= deduct;
    if (carried >= maxPeriods && remaining > deduct) adjustment(state, { order_no: plan.order_no, staff_id: plan.staff_id,
      action: "offset_plan", amount_fen: -(remaining - deduct), carried, plan_id: String(plan.id), period: settlement.period, note: "已转线下" }, at);
  }
  settlement.makeup_fen = makeup; settlement.offset_fen = offsets;
  recompute(state, settlement);
}
function adjustmentOverview(state, includesStaff, at) {
  const period = periodAt(at), changes = serviceAdjustments(state).filter(row => includesStaff(row.staff_id));
  const plans = changes.filter(row => row.action === "offset_plan" && !row.settle_id && (!row.plan_id || row.plan_id === String(row.id)));
  const pending = plans.map(plan => {
    const records = changes.filter(row => row.plan_id === String(plan.id));
    const closed = records.some(row => row.action === "cancel_offset" || row.note === "已转线下");
    const remaining = closed ? 0 : Math.max(0, -Number(plan.amount_fen) + sumFen(records.filter(row => row.action === "offset_plan" && row.settle_id), "amount_fen"));
    return { ...plan, remaining_fen: remaining };
  });
  // Use the same generator/allocator on a private snapshot to expose the
  // current month's capped recovery before finance confirms a draft.
  const preview = structuredClone(state);
  const people = new Set([...state.ledger.filter(row => row.beneficiary_type === "service" && includesStaff(row.party_id)).map(row => row.party_id), ...changes.map(row => row.staff_id)]);
  for (const staffId of people) {
    const draft = newSettlement(preview, period, staffId, at);
    if (draft.status !== "draft") continue;
    for (const row of preview.ledger) if (row.beneficiary_type === "service" && row.party_id === staffId && row.status === "settleable" && !row.settle_id && duePeriod(row, row) <= period) {
      row.status = "settled"; row.settle_id = draft.settle_id;
    }
    recompute(preview, draft); allocateAdjustments(preview, draft, at);
  }
  const current = preview.settlements.filter(row => includesStaff(row.staff_id) && row.period === period);
  return { period, offset_fen: sumFen(current, "offset_fen"), makeup_fen: sumFen(current, "makeup_fen"),
    pending_offset_fen: sumFen(pending, "remaining_fen"),
    adjustments: changes.map(row => ({ ...row, remaining_fen: pending.find(plan => String(plan.id) === String(row.id))?.remaining_fen,
      staff_name: state.staff.find(person => person.id === row.staff_id)?.name || row.staff_id })).sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || Number(b.id) - Number(a.id)) };
}
function projectLedger(state, row, at = new Date()) {
  const order = state.orders.find(item => item.order_no === row.biz_no) || {}, staff = state.staff.find(item => item.id === row.party_id) || {};
  return { ...row, order_no: row.biz_no, staff_name: staff.name || row.party_id, base_salary_fen: Number(staff.base_salary || 0) * 100,
    product_name: order.product_name || "—", merchant_name: order.merchant_name || "—", customer_name:order.customer_name || order.customer || order.contactName || '—',assignee_name:staff.name || row.party_id,biz_date: str(order.schedule_time || row.done_at || row.paid_at).slice(0, 10),
    calculation_basis: `净额 × ${B.CATEGORY_NAMES[row.category]} ${(row.rate_bp / 100).toFixed(1)}%`,
    review_required: staff.staff_status === "paused" && timestamp(row.paid_at) >= timestamp(staff.updated_at || row.created_at),
    effective_commission_fen: row.status === "void" ? 0 : row.commission_fen,
    appeal_available: !!row.settle_id && state.settlements.some(item => item.settle_id === row.settle_id && (!item.appeal_until || item.appeal_until >= localTime(at).slice(0, 10))) };
}
function page(rows, query) { const size = Math.min(100, Math.max(1, Number(query.size) || 20)), current = Math.max(1, Number(query.page) || 1); return { list: rows.slice((current - 1) * size, current * size), total: rows.length, page: current, size }; }
function selectedLedger(state, query, session, at) {
  const allowed = visibleStaff(state, session), keyword = str(query.keyword).toLowerCase();
  return state.ledger.filter(row => row.beneficiary_type === "service" && (!allowed || allowed.has(row.party_id)) && (!query.staff || row.party_id === query.staff)
    && (!query.type || row.category === query.type) && (!query.status || row.status === query.status) && (!query.period || periodAt(row.paid_at) === query.period))
    .map(row => projectLedger(state, row, at)).filter(row => !keyword || [row.biz_no, row.customer_openid, row.staff_name, row.product_name].some(value => str(value).toLowerCase().includes(keyword)))
    .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || Number(b.id) - Number(a.id));
}
function csvFor(rows) {
  const headers = ["序号", "订单号", "客户OpenID", "客服姓名", "基本工资(元/月)", "类目", "商品", "净额(元)", "计算依据", "比例", "提成(元)", "状态"];
  const labels = { est: "预估", obs: "观察中", settleable: "可结算", settled: "已结算", void: "不计提成" };
  return "\uFEFF" + [headers, ...rows.map((row, i) => [i + 1, row.biz_no, row.customer_openid, row.staff_name, money(row.base_salary_fen), B.CATEGORY_NAMES[row.category], row.product_name,
    money(row.net_amount_fen), row.calculation_basis, (row.rate_bp / 100).toFixed(1) + "%", money(row.status === "void" ? 0 : row.commission_fen), labels[row.status]])].map(row => row.map(safeCsv).join(",")).join("\r\n");
}
function createSvcCommission(options = {}) {
  const { store } = options; if (!store?.transaction || !store?.read) throw new Error("客服分成需事务持久化存储");
  const clock = () => options.clock ? options.clock() : new Date();
  async function execute(method, path, input = {}, session = {}) {
    method = method.toUpperCase(); path = path.replace(/^\/api\/svc/, "").replace(/\/$/, "") || "/";
    if (method === "GET") return store.read(async raw => {
      const state = arrays(raw), scope = visibleStaff(state, session);
      if (path === "/rule") {
        if (isService(session)) throw failure(4030, "无权限查看比例管理", 403);
        const versions = [...state.rules].filter(row => row.beneficiary_type === "service" && (!scope || row.party_id && scope.has(row.party_id))).sort((a, b) => Number(b.ver) - Number(a.ver));
        const current = state.rules.filter(row => row.beneficiary_type === "service" && row.party_id == null && timestamp(row.eff_at) <= timestamp(clock())).sort((a, b) => Number(b.ver) - Number(a.ver))[0] || null;
        const custom = state.staff.filter(row => !scope || scope.has(row.id)).flatMap(row => {
          try { const r = rateBpOf(state.rules, row.id, "photo", clock()); return r.mode === "custom" ? [{ ...row, rates: state.rules.find(rule => Number(rule.ver) === r.ver) }] : []; } catch (_) { return []; }
        });
        const binding_logs=(state.bindingLogs||[]).filter(row=>!scope||scope.has(row.from_staff)||scope.has(row.to_staff)).map(row=>({...row,customer_name:state.orders.find(order=>order.order_no===row.order_no)?.customer_name || row.openid,from_staff_name:state.staff.find(person=>String(person.id)===String(row.from_staff))?.name || null,to_staff_name:state.staff.find(person=>String(person.id)===String(row.to_staff))?.name || null}));
        return { current, ver: Math.max(0, ...state.rules.map(row => Number(row.ver))), versions, custom,binding_logs, config: configAt(state, clock()), latest_config_ver: Math.max(0, ...state.configs.map(row => Number(row.ver))), pending_config: state.configs.filter(row => timestamp(row.eff_at) > timestamp(clock())).sort((a, b) => Number(b.ver) - Number(a.ver))[0] || null };
      }
      if (path === "/ledger" || path === "/ledger/export") {
        const rows = selectedLedger(state, input, session, clock());
        if (path.endsWith("export")) return { csv: csvFor(rows), filename: "客服分成明细.csv", contentType: "text/csv; charset=utf-8" };
        const total_commission_fen = sumFen(rows.filter(row => row.status !== "void"), "commission_fen");
        const staffScope=visibleStaff(state,session);
        return { ...page(rows, input), total_commission_fen,staff_options:state.staff.filter(row=>!staffScope||staffScope.has(row.id)).map(row=>({id:row.id,name:row.name})),
          summary:{total_commission_fen,row_count:rows.length,void_count:rows.filter(row=>row.status==='void').length,order_count:new Set(rows.map(row=>row.biz_no)).size} };
      }
      if (path === "/me") {
        if (!isService(session) && !isSupervisor(session) && !isSuper(session)) throw failure(4030, "无操作权限", 403);
        const preview = session.kind !== 'public' && session.role === 'super';
        const me = preview ? str(input.staff) : staffIdentity(state, session);
        const personal = state.staff.find(row => row.id === me) || null;
        if (preview && me && !personal) throw failure(5010, '客服档案不存在');
        const includesStaff = id => preview && !me || String(id) === me;
        const rows = state.ledger.filter(row => row.beneficiary_type === "service" && includesStaff(row.party_id)).map(row => projectLedger(state, row, clock()))
          .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || Number(b.id) - Number(a.id));
        const current = rows.filter(row => periodAt(row.paid_at) === periodAt(clock()) && row.status !== "void");
        const sums = Object.fromEntries(["est", "obs", "settleable", "settled", "void"].map(status => [status, sumFen(rows.filter(row => row.status === status), "commission_fen")]));
        let current_rates=null;if(me)try{current_rates=Object.fromEntries(B.CATEGORIES.map(category=>[category+'_bp',rateBpOf(state.rules,me,category,clock()).bp]));}catch(error){if(Number(error.code)!==5011)throw error;}
        const people = state.staff.filter(row => includesStaff(row.id));
        const salary=preview && !me ? sumFen(people.map(row=>({base_salary_fen:Number(row.base_salary||0)*100})),'base_salary_fen') : personal ? Number(personal.base_salary||0)*100 : null,month=sumFen(current,'commission_fen');
        const adjustmentView = adjustmentOverview(state, includesStaff, clock());
        const pendingRows = rows.filter(row => row.status === "obs");
        const estimateRows = current.filter(row => row.status !== "settled");
        const named = row => ({...row,staff_name:state.staff.find(person=>person.id===row.staff_id)?.name || row.staff_id});
        return { staff:personal, current_rates,...(preview ? {preview:true,staff_options:state.staff.map(({id,name})=>({id,name}))} : {}),config:{...configAt(state,clock()),...core.staffTiming(personal,configAt(state,clock()))},kpi: { staff_count:people.length,month_fen: month, month_estimate_fen: sumFen(estimateRows, "commission_fen"), pending_count: pendingRows.length, pending_fen: sumFen(pendingRows, "commission_fen"), offset_fen: adjustmentView.offset_fen, makeup_fen: adjustmentView.makeup_fen, pending_offset_fen: adjustmentView.pending_offset_fen,base_salary_fen:salary,month_remuneration_fen:salary===null?null:salary+month,settleable_fen: sums.settleable, settled_fen: sums.settled, total_fen: sumFen(rows.filter(row => row.status !== "void"), "commission_fen") }, adjustments: adjustmentView.adjustments, adjustment_period: adjustmentView.period, status_totals: sums,
          ...page(rows.filter(row => (!input.status || row.status === input.status) && (!input.type || row.category === input.type) && (!input.period || periodAt(row.paid_at) === input.period) && (!input.keyword || [row.biz_no, row.customer_openid, row.product_name, row.staff_name].some(value => str(value).toLowerCase().includes(str(input.keyword).toLowerCase())))), input), settlements: state.settlements.filter(row => includesStaff(row.staff_id)).map(row => ({ ...named(row), can_appeal: !preview && (!row.appeal_until || row.appeal_until >= localTime(clock()).slice(0, 10)) })), appeals: state.appeals.filter(row => includesStaff(row.staff_id)).map(named) };
      }
      if (path === "/staff") {
        if (isService(session)) throw failure(4030, "无操作权限", 403);
        const rows = state.staff.filter(row => (!scope || scope.has(row.id)) && (!input.status || row.staff_status === input.status) && (!input.keyword || [row.name, row.phone].some(value => str(value).toLowerCase().includes(str(input.keyword).toLowerCase())))).map(row => {
          let rates = null; try { const rate = rateBpOf(state.rules, row.id, "photo", clock()); rates = state.rules.find(item => item.beneficiary_type === "service" && Number(item.ver) === rate.ver); } catch (_) {}
          const ledger=state.ledger.filter(item=>item.beneficiary_type==='service'&&String(item.party_id)===String(row.id)&&item.status!=='void');
          const supervisor=state.staff.find(person=>String(person.id)===String(row.supervisor_id));
          return { ...row,settlement_cycle:settlementCycle(row.settlement_cycle),supervisor_name:supervisor?.name || null,account:row.account || null,timing:{...core.staffTiming(row,configAt(state,clock())),cycle:settlementCycle(row.settlement_cycle)},month_fen:sumFen(ledger.filter(item=>periodAt(item.paid_at)===(input.period||periodAt(clock()))),'commission_fen'),total_fen:sumFen(ledger,'commission_fen'),assessment_tags: [...(row.assessment_tags || [])], rate_review_date: row.rate_review_date || null, can_edit_profile: canEditProfile(state, session, row.id), rates, ...staffRateConfiguration(state.rules,row.id,clock()), base_salary_fen: Number(row.base_salary || 0) * 100, profile_logs: state.staffLogs.filter(log => String(log.staff_id) === String(row.id)).sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at)) };
        }); return {...page(rows, input),config:configAt(state,clock()),summary:{staff_count:rows.length,active_count:rows.filter(row=>row.staff_status==='active').length,paused_count:rows.filter(row=>row.staff_status==='paused').length,ended_count:rows.filter(row=>row.staff_status==='ended').length,month_fen:sumFen(rows,'month_fen')}};
      }
      if (path === "/settlement") return page(state.settlements.filter(row => (!scope || scope.has(row.staff_id)) && (!input.period || row.period === input.period) && (!input.status || row.status === input.status)).map(row => ({ ...row, staff_name: state.staff.find(staff => staff.id === row.staff_id)?.name || row.staff_id })), input);
      const settlementMatch = path.match(/^\/settlement\/([^/]+)$/);
      if (settlementMatch) {
        const row = state.settlements.find(item => item.settle_id === settlementMatch[1] && (!scope || scope.has(item.staff_id)));
        if (!row) throw failure(5010, "结算单不存在");
        return { ...row, list: state.ledger.filter(item => item.settle_id === row.settle_id).map(item => projectLedger(state, item, clock())), adjustments: state.adjustments.filter(item => item.settle_id === row.settle_id) };
      }
      if (path === "/appeal") return page(state.appeals.filter(row => !scope || scope.has(row.staff_id)), input);
      throw failure(4040, "接口不存在", 404);
    }, { path: "/api/svc" + path, input, session });
    if (method !== "POST") throw failure(4040, "接口不存在", 404);
    return store.transaction(async (raw, conn) => {
      const state = arrays(raw), at = clock(), operator = actor(session);
      if (path === "/rule/preview") {
        mustSuper(session); const proposed = ratesOf(input.rates || input), period = requirePeriod(input.period || periodAt(at));
        const results = B.CATEGORIES.map(category => {
          const rows = state.ledger.filter(row => row.beneficiary_type === "service" && row.category === category && ["est", "obs", "settleable"].includes(row.status) && periodAt(row.paid_at) === period);
          const oldSum = sumFen(rows, "commission_fen"), newSum = rows.reduce((sum, row) => sum + commissionFen(row.net_amount_fen, row.rate_mode === "custom" ? row.rate_bp : proposed["rate_" + category + "_bp"]), 0);
          return { category, count: rows.filter(row => row.rate_mode !== "custom").length, old_sum_fen: oldSum, new_sum_fen: newSum, diff_fen: newSum - oldSum };
        }); return { list: results, count: results.reduce((sum, row) => sum + row.count, 0), diff_fen: sumFen(results, "diff_fen"), historical_snapshots_unchanged: true };
      }
      if (path === "/rule") {
        mustSuper(session);
        if (input.config && !input.rates && !Object.hasOwn(input, "photo_bp") && !Object.hasOwn(input, "rate_photo_bp")) return { config: core.saveConfig(state, input.config, operator, at) };
        const rates = ratesOf(input.rates || input), reason = reasonOf(input.reason), ver = Math.max(0, ...state.rules.map(row => Number(row.ver)));
        if (Number(input.ver) !== ver) throw failure(5003, "配置已被他人修改，请刷新");
        if (input.config) core.saveConfig(state, input.config, operator, at);
        const row = { id: idOf(state, "rules"), ver: ver + 1, beneficiary_type: "service", party_id: null, rule_mode: "global", ...rates, eff_at: nextDay(at), reason, operator, created_at: localTime(at) };
        state.rules.push(row); return row;
      }
      if (path === "/staff") {
        mustSuper(session); const name = str(input.name), phone = str(input.phone), salary = Number(integer(input.base_salary ?? 0, "基本工资"));
        const cycle=settlementCycle(input.settlement_cycle);
        const timing = core.validateStaffTiming(input);
        const createAccount = input.create_account === true;
        if (createAccount && str(input.account_id)) throw failure(4014, "新建登录账号不能同时关联已有账号 ID");
        if (createAccount) require("./svcAccounts.cjs").validateSvcCredentials(input);
        else if (input.password) throw failure(4014, "设置初始密码时请选择新建登录账号");
        if(!createAccount && str(input.account)){
          const linked=(state.accounts||[]).filter(account=>str(account.account)===str(input.account)&&['active','正常','启用'].includes(str(account.status||'active')));
          if(linked.length!==1)throw failure(4014,'后台账号不存在或已停用，请先在权限管理创建');
          if(input.account_id&&String(input.account_id)!==String(linked[0].id))throw failure(4014,'后台账号与关联账号不一致');
          input={...input,account_id:String(linked[0].id)};
        }
        if (!name || name.length > 64 || !/^1[3-9]\d{9}$/.test(phone) || salary < 0) throw failure(4014, "姓名、手机号或基本工资无效");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str(input.joined_at))) throw failure(4014, "入职日期必填");
        if (state.staff.some(row => row.phone === phone || input.account_id && row.account_id === input.account_id)) throw failure(4014, "手机号或账号已建档");
        const mode = input.rate_mode === "custom" ? "custom" : "global", reason = reasonOf(input.reason || "客服建档");
        let rates = mode === "custom" ? ratesOf(input.rates) : null;
        if (!rates) { const global = state.rules.filter(row => row.party_id == null && row.beneficiary_type === "service" && timestamp(row.eff_at) <= timestamp(at)).sort((a, b) => Number(b.ver) - Number(a.ver))[0]; if (!global) throw failure(5011, "请先初始化统一比例"); rates = Object.fromEntries(B.CATEGORIES.map(key => ["rate_" + key + "_bp", global["rate_" + key + "_bp"]])); }
        const metadata = profileMetadata(input);
        const row = { id: crypto.randomBytes(12).toString("hex"), name, phone, joined_at: str(input.joined_at), base_salary: salary, rate_mode: mode, supervisor_id: str(input.supervisor_id) || null,settlement_cycle:cycle,...timing,...metadata,
          staff_status: "active", account_id: str(input.account_id) || null, created_at: localTime(at), updated_at: localTime(at) };
        if (createAccount) Object.assign(row, await require("./svcAccounts.cjs").provisionSvcAccount(conn, row, input));
        state.staff.push(row);
        state.staffLogs.push({ id: idOf(state, "staffLogs"), staff_id: row.id, action: "create", from_tags: [], to_tags: [...row.assessment_tags], from_review_date: null, to_review_date: row.rate_review_date, reason, operator, created_at: localTime(at) });
        state.rules.push({ id: idOf(state, "rules"), ver: Math.max(0, ...state.rules.map(item => Number(item.ver))) + 1, beneficiary_type: "service", party_id: row.id, rule_mode: mode, ...rates, eff_at: nextDay(at), reason, operator, created_at: localTime(at) });
        return row;
      }
      const profileMatch = path.match(/^\/staff\/([^/]+)\/profile$/);
      if (profileMatch) {
        const staff = state.staff.find(row => String(row.id) === profileMatch[1]);
        if (!staff || !canEditProfile(state, session, staff.id)) throw failure(4030, "仅超管或直属主管可维护此客服的标签和复核日期", 403);
        if (Object.keys(input).some(key => !["assessment_tags", "rate_review_date", "reason"].includes(key))) throw failure(4014, "此入口只能维护标签、复核日期和原因");
        if (!Object.hasOwn(input, "assessment_tags") && !Object.hasOwn(input, "rate_review_date")) throw failure(4014, "请填写要更新的标签或复核日期");
        const metadata = profileMetadata(input, staff), reason = reasonOf(input.reason), fromTags = [...(staff.assessment_tags || [])], fromDate = staff.rate_review_date || null;
        if (JSON.stringify(fromTags) === JSON.stringify(metadata.assessment_tags) && fromDate === metadata.rate_review_date) return { ...staff, can_edit_profile: true, unchanged: true };
        Object.assign(staff, metadata, { updated_at: localTime(at) });
        state.staffLogs.push({ id: idOf(state, "staffLogs"), staff_id: staff.id, action: "profile", from_tags: fromTags, to_tags: [...metadata.assessment_tags], from_review_date: fromDate, to_review_date: metadata.rate_review_date, reason, operator, created_at: localTime(at) });
        return { ...staff, can_edit_profile: true };
      }
      const staffMatch = path.match(/^\/staff\/([^/]+)\/(rate|status)$/);
      if (staffMatch) {
        mustSuper(session); const staff = state.staff.find(row => row.id === staffMatch[1]); if (!staff) throw failure(4014, "客服档案不存在");
        if (staffMatch[2] === "status") { if (!["active", "paused", "ended"].includes(input.status)) throw failure(4014, "客服状态无效"); if (staff.staff_status === "ended" && input.status !== "ended") throw failure(4014, "已终止档案不能恢复，请重新建档"); staff.staff_status = input.status; staff.updated_at = localTime(at); return staff; }
        const reason = reasonOf(input.reason), mode = input.rate_mode === "global" || input.mode === "global" ? "global" : "custom";
        let rates;
        if (mode === "custom") rates = ratesOf(input.rates);
        else { const rule = state.rules.filter(row => row.party_id == null && row.beneficiary_type === "service" && timestamp(row.eff_at) <= timestamp(at)).sort((a, b) => Number(b.ver) - Number(a.ver))[0]; if (!rule) throw failure(5011, "无可用统一比例版本"); rates = Object.fromEntries(B.CATEGORIES.map(key => ["rate_" + key + "_bp", rule["rate_" + key + "_bp"]])); }
        const row = { id: idOf(state, "rules"), ver: Math.max(0, ...state.rules.map(item => Number(item.ver))) + 1, beneficiary_type: "service", party_id: staff.id, rule_mode: mode, ...rates, eff_at: nextDay(at), reason, operator, created_at: localTime(at) };
        state.rules.push(row); staff.rate_mode = mode; staff.updated_at = localTime(at); return row;
      }
      if (path === "/ledger/batch-settle" || path === "/settlement/generate") {
        mustFinance(session); const period = requirePeriod(input.period || periodAt(at));
        refreshLedger(state, at);
        let rows;
        if (path === "/ledger/batch-settle") {
          const ids = input.ledger_ids; if (!Array.isArray(ids) || !ids.length || new Set(ids.map(String)).size !== ids.length) throw failure(5004, "请选择明细，且不可重复");
          rows = ids.map((id, i) => { const row = state.ledger.find(item => String(item.id) === String(id) && item.beneficiary_type === "service");
            if (!row || row.status !== "settleable") throw failure(5004, `第 ${i + 1} 行处于观察期或已结算，暂不可结算`); return row; });
          for (const row of rows) if (row.settle_id) throw failure(5004, "明细已在结算单 " + row.settle_id);
        } else rows = state.ledger.filter(row => row.beneficiary_type === "service" && row.status === "settleable" && !row.settle_id && duePeriod(row, row) <= period);
        const settlements = [];
        for (const row of rows) {
          if (duePeriod(row, row) > period) throw failure(5004, "明细尚未进入指定可结算月");
          const settlement = newSettlement(state, period, row.party_id, at);
          if (settlement.status !== "draft") { if (path === "/settlement/generate") continue; throw failure(5005, "本期已确认，明细已锁定"); }
          row.settle_id = settlement.settle_id; row.status = "settled";
          if (!settlements.includes(settlement)) settlements.push(settlement);
        }
        // A period may legitimately contain only a carried debit or makeup.
        if (path === "/settlement/generate") for (const item of serviceAdjustments(state).filter(row => {
          if (row.settle_id || !["offset_plan", "makeup"].includes(row.action) || (row.period || nextPeriod(periodAt(row.created_at))) > period) return false;
          if (row.action === "makeup") return !state.adjustments.some(applied => applied.plan_id === `makeup:${row.id}` && applied.settle_id);
          if (row.plan_id && row.plan_id !== String(row.id)) return false;
          const records = state.adjustments.filter(applied => applied.plan_id === String(row.id));
          return !records.some(record => record.action === "cancel_offset" || record.note === "已转线下") && -Number(row.amount_fen) + sumFen(records.filter(record => record.settle_id), "amount_fen") > 0;
        })) {
          const settlement = newSettlement(state, period, item.staff_id, at); if (settlement.status === "draft" && !settlements.includes(settlement)) settlements.push(settlement);
        }
        return { list: settlements.map(row => recompute(state, row)) };
      }
      const settleMatch = path.match(/^\/settlement\/([^/]+)\/(confirm|pay|exclude)$/);
      if (settleMatch) {
        mustFinance(session); const settlement = state.settlements.find(row => row.settle_id === settleMatch[1]); if (!settlement) throw failure(5010, "结算单不存在");
        if (settleMatch[2] === "exclude") {
          reasonOf(input.reason); if (settlement.status !== "draft") throw failure(5005, "本期已确认，明细已锁定");
          const row = state.ledger.find(item => String(item.id) === String(input.ledger_id) && item.settle_id === settlement.settle_id); if (!row) throw failure(5010, "该明细不在本期结算单内");
          row.settle_id = null; row.status = "settleable"; adjustment(state, { order_no: row.biz_no, staff_id: row.party_id, action: "restore", amount_fen: 0, note: "草稿剔除：" + input.reason, operator }, at); return recompute(state, settlement);
        }
        if (settleMatch[2] === "confirm") {
          if (settlement.status !== "draft") throw failure(5005, "本期已确认");
          const rows = state.ledger.filter(row => row.settle_id === settlement.settle_id);
          if (rows.some(row => row.status !== "settled" || row.zero_reason)) throw failure(5012, "结算单包含未满足结算条件的明细，请刷新核查");
          if (rows.some(row => commissionFen(row.net_amount_fen, row.rate_bp) !== Number(row.commission_fen))) throw failure(5012, "明细复算不一致，已锁定确认，请核查");
          if (sumFen(rows, "commission_fen") !== Number(settlement.amount_fen)) throw failure(5012, "结算单与明细金额不符，已锁定确认，请核查");
          allocateAdjustments(state, settlement, at);
          const config = configAt(state, at);
          settlement.appeal_until = addWorkdays(at, 5, config.holiday_dates || options.holidays || [], config.workday_dates || options.workdays || []);
          settlement.confirmed_at = localTime(at); settlement.status = "confirmed"; return settlement;
        }
        if (settlement.status !== "confirmed") throw failure(5005, "仅已确认结算单可登记发放");
        if (!str(input.voucher_url)) throw failure(5006, "凭证必传");
        if (!/^(?:https?:\/\/|\/api\/media\/)/.test(input.voucher_url) || str(input.voucher_url).length > 255) throw failure(5006, "凭证地址无效");
        settlement.status = "paid"; settlement.voucher_url = str(input.voucher_url); settlement.paid_at = localTime(at); return settlement;
      }
      if (path === "/appeal") {
        if (!isService(session) && !isSupervisor(session) && !isSuper(session)) throw failure(4030, "请使用本人或主管账号申诉", 403);
        const scope = visibleStaff(state, session), settlement = state.settlements.find(row => row.settle_id === input.settle_id && (!scope || scope.has(row.staff_id)));
        const ledger = state.ledger.find(row => String(row.id) === String(input.ledger_id) && row.settle_id === settlement?.settle_id && row.party_id === settlement?.staff_id);
        if (!settlement || !ledger) throw failure(5010, "该明细不在本期结算单内");
        if (settlement.appeal_until && settlement.appeal_until < localTime(at).slice(0, 10)) throw failure(5009, "申诉时限已过");
        const duplicate = state.appeals.find(row => String(row.ledger_id) === String(ledger.id) && ["pending", "l1", "l2"].includes(row.status)); if (duplicate) return duplicate;
        const row = { id: idOf(state, "appeals"), settle_id: settlement.settle_id, ledger_id: ledger.id, staff_id: settlement.staff_id, submitted_by: operator, reason: reasonOf(input.reason, 500), evidence_url: str(input.evidence_url) || null,
          status: "pending", revise_amount_fen: 0, l1_note: null, l1_by: null, l1_at: null, l2_note: null, l2_by: null, l2_at: null, created_at: localTime(at) };
        state.appeals.push(row); return row;
      }
      const appealMatch = path.match(/^\/appeal\/([^/]+)\/(l1|l2)$/);
      if (appealMatch) {
        const row = state.appeals.find(item => String(item.id) === appealMatch[1]); if (!row) throw failure(5010, "申诉不存在");
        if (appealMatch[2] === "l1") {
          const scope = visibleStaff(state, session); if (!isSuper(session) && (!isSupervisor(session) || !scope.has(row.staff_id))) throw failure(4030, "仅本组主管或超管可一审", 403);
          if (!["pending", "l1"].includes(row.status)) throw failure(4014, "当前状态不允许一审");
          if (!["revise", "maintain"].includes(input.result)) throw failure(4014, "一审结果无效");
          row.l1_note = reasonOf(input.note, 500); row.l1_by = operator; row.l1_at = localTime(at); row.status = "l2";
          row.revise_amount_fen = input.result === "revise" ? Number(integer(input.amount_fen ?? 0)) : 0;
          if (row.revise_amount_fen < 0) throw failure(4014, "补发金额不能为负"); return row;
        }
        mustSuper(session); if (row.status !== "l2") throw failure(4014, "请先完成一审");
        if (!["accepted", "rejected"].includes(input.result)) throw failure(4014, "终审结果无效");
        row.l2_note = reasonOf(input.note, 500); row.l2_by = operator; row.l2_at = localTime(at); row.status = input.result;
        if (input.result === "accepted" && row.revise_amount_fen > 0) {
          const ledger = state.ledger.find(item => String(item.id) === String(row.ledger_id));
          adjustment(state, { order_no: ledger.biz_no, staff_id: row.staff_id, action: "makeup", amount_fen: row.revise_amount_fen, period: nextPeriod(periodAt(at)), note: "申诉成功，随下期结算发放", operator }, at);
        }
        return row;
      }
      throw failure(4040, "接口不存在", 404);
    });
  }
  async function runTasks(at = clock()) {
    const result = await store.transaction(async raw => {
      const state = arrays(raw); refreshLedger(state, at);
      for (const row of state.settlements) if (row.status === "confirmed" && row.appeal_until < localTime(at).slice(0, 10) && !row.acknowledged_at && !state.appeals.some(item => item.settle_id === row.settle_id && ["pending", "l1", "l2"].includes(item.status))) row.acknowledged_at = localTime(at);
      return { ledger_count: state.ledger.length, acknowledged_count: state.settlements.filter(row => row.acknowledged_at).length };
    });
    return result;
  }
  return { execute, runTasks, ensureLedger, transferPhoto, applyComplaint, onRefund, rateBpOf, commissionFen };
}
function refreshLedger(state, at) {
  for (const row of state.ledger.filter(item => item.beneficiary_type === "service")) {
    if (["settled", "void"].includes(row.status)) continue;
    const order = state.orders.find(item => item.order_no === row.biz_no);
    if (order) { if (order.done_at && !row.done_at) row.done_at = order.done_at; row.status = statusOf(row, { ...order, complaint_resp: latestComplaint(state, order) }, at, row); }
  }
}
module.exports = { createSvcCommission, ensureLedger, transferPhoto, applyComplaint, onRefund, refreshLedger, csvFor, configAt, allocateAdjustments, nextPeriod, profileMetadata };
