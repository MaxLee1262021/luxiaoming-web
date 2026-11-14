"use strict";

const {canonicalStage} = require("./orderWorkflow.cjs");
const {failure,integer,timestamp,localTime} = require("./svcBenefit.cjs");
const TYPE = {photo:"photo",photo_single:"photo",photo_package:"photo",album:"photo",video:"video",video_single:"video",video_package:"video",combo:"combo",package:"combo",peripheral:"peripheral"};
function fen(value) {
  const text = String(value ?? "0");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw failure(4310,"订单金额须为最多两位小数");
  const [whole,part=""] = text.replace(/^-/ ,"").split(".");
  return Number(integer((BigInt(whole)*100n+BigInt(part.padEnd(2,"0"))) * (text.startsWith("-")?-1n:1n)));
}
function photoId(order, previous) {
  if (!order) return "";
  // Both order UIs share the same accounting hook. A legacy dispatch edits
  // photographerId, while the service workbench edits photo_id. Honor the
  // field changed by this mutation, including an explicit unassignment.
  if (previous) {
    if (Object.hasOwn(order,"photo_id") && String(order.photo_id ?? "") !== String(previous.photo_id ?? "")) return String(order.photo_id ?? "");
    if (Object.hasOwn(order,"photographerId") && String(order.photographerId ?? "") !== String(previous.photographerId ?? "")) return String(order.photographerId ?? "");
  }
  return String(order.photo_id || order.photographerId || "");
}
function categoryOf(order) {
  const explicit = order.category || order.productType;
  if (TYPE[explicit]) return TYPE[explicit];
  const items = order.productItems || order.products || order.items || [];
  const categories = [...new Set(items.map(item=> TYPE[item.type || item.productType]).filter(Boolean))];
  if (categories.length>1) throw failure(4310,"该订单含多个分成类目，请拆为独立订单后再派单");
  return categories[0] || (order.packageId ? "combo" : null);
}
function serviceStatusOf(order,previous) {
  const stage = canonicalStage(order);
  const explicit = order.service_status;
  if (["refunded","canceled","cancelled"].includes(explicit)) return explicit;
  if (stage === "cancelled") return "canceled";
  // Follow the payment-aware workflow even when a legacy service field lags.
  // Completed shooting keeps its ledger estimated until the final receipt.
  if (stage === "completed") return "done";
  if (stage === "awaiting_final_payment") return "final_pending";
  const mapped = {awaiting_shoot:"confirmed",shooting:"shooting",selection_pending:"shooting",awaiting_delivery:"shooting"}[stage];
  const changedStage = previous && canonicalStage(previous) !== stage;
  if (mapped && (!explicit || ["new","reserved","done"].includes(explicit) || changedStage)) return mapped;
  return explicit || mapped || stage;
}
function firstPaymentAt(order) {
  if (order.paid_at) return order.paid_at;
  const recorded = (order.paymentRecords || []).filter(r=>["paid","confirmed","success","succeeded","approved","passed","SUCCESS","已审","已审核","已通过","已到账"].includes(r.status))
    .map(r=>r.paidAt || r.confirmedAt).filter(Boolean);
  const times = [order.depositPaidAt,order.depositConfirmedAt,...recorded,order.finalPaidAt,order.finalConfirmedAt].filter(Boolean);
  return times.sort((a,b)=>timestamp(a)-timestamp(b))[0];
}
function normalizePhotoOrder(order,previous) {
  const stage = canonicalStage(order);
  const serviceStatus = serviceStatusOf(order,previous);
  const category = categoryOf(order);
  if (!category) throw failure(4310,"订单缺少可识别的分成类目，请核对商品类型");
  const paidAt = firstPaymentAt(order);
  const refund = order.refundConfirmed ? fen(order.refundedAmount ?? order.refundAmount ?? 0) : fen(order.refundedAmount ?? 0);
  const net = order.net_amount_fen != null ? Number(integer(order.net_amount_fen)) : Math.max(0,fen(order.totalAmount ?? order.totalPrice ?? order.price ?? 0)-fen(order.finalDiscountAmount ?? 0)-refund);
  return {biz_no:String(order.orderNo || order.id || order._id),no:String(order.orderNo || order.id || order._id),photo_id:photoId(order,previous),category,
    net_amount_fen:net,paid_at:paidAt,done_at:order.done_at || order.completedAt || null,service_status:serviceStatus,
    customer_openid:String(order.customer_openid || order.openid || order._openid || ""),is_rebuy:order.is_rebuy || order.isRebuy || 0,
    product_name:String(order.packageName || itemsName(order)),merchant_name:String(order.shopName || ""),schedule_time:order.confirmedShootAt || order.appointmentAt || order.date || null,
    zero_reason:order.zero_reason || (order.complaint_resp === "photo" || order.complaintResponsibility === "photo" ? "complaint_photo" : order.stopShoot ? "stop_shoot" : refund>0 && net===0 ? "refund" : stage === "cancelled" ? "stop_shoot" : null)};
}
function itemsName(order) { return (order.productItems || order.products || order.items || []).map(r=>r.name).filter(Boolean).join("、"); }
// Called under the adapter's existing order row lock. No second connection or
// later write may leave assignment, ledger and transfer history out of sync.
async function syncPhotoOrderTx(conn,order,previous,options={}) {
  if (![photoId(order,previous),photoId(previous)].some(id=>/^PH\d{8}$/.test(id))) return;
  const normalized = normalizePhotoOrder(order,previous);
  const {createPhotoShareService} = require("./photoShare.cjs");
  const service = options.service || createPhotoShareService({source:{transaction:work=>work(conn)}});
  const previousId = photoId(previous);
  // Validate the new owner even when payment facts are incomplete or this is
  // a legacy completion write. Accounting must not silently accept a newly
  // assigned paused/ended photographer just because no ledger can be built.
  if (/^PH\d{8}$/.test(normalized.photo_id) && normalized.photo_id !== previousId) await service.validateAssignment(normalized.photo_id, { conn });
  // The older order editor writes camelCase fields. Publish its current facts
  // to the shared order columns before accounting reads/counts them, under the
  // SAME row lock. A stale photo_id must never keep blocking the old owner or
  // allow the new owner to terminate while this order is still in flight.
  if (String(order.photo_id || "") !== normalized.photo_id || order.service_status !== normalized.service_status || String(order.done_at || "") !== String(normalized.done_at || "")) {
    await conn.query("UPDATE lxm_orders SET photo_id=?,service_status=?,done_at=? WHERE id=?",
      [normalized.photo_id || null,normalized.service_status,normalized.done_at ? localTime(normalized.done_at) : null,String(order.id || order._id)]);
  }
  const operator = String((order.statusLogs || []).at(-1)?.operatorId || "order-workflow");
  if (/^PH\d{8}$/.test(normalized.photo_id) && normalized.photo_id !== previousId) {
    const record = order.dispatchRecord || (order.dispatchRecords || []).at(-1) || {};
    const method = record.channel || record.next?.confirmationMethod || order.confirmationMethod;
    const channel = ({wechat:"wechat",微信:"wechat",phone:"phone",电话:"phone",face:"face",当面:"face"})[method] || "legacy";
    const reason = String(record.reason || order.dispatchNote || (previousId ? "旧订单接口登记转派" : "旧订单接口登记派单")).slice(0,64);
    await conn.query("INSERT INTO svc_assign_log (order_no,action,from_photo,to_photo,reason,channel,zero_amount,operator,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [normalized.no,previousId?"transfer":"assign",previousId||null,normalized.photo_id,reason,channel,previousId?1:0,operator,localTime(options.clock ? options.clock() : new Date())]);
  }
  await service.syncOrderTx(conn,normalized,previous && normalizePhotoOrder(previous),operator);
}
module.exports = {fen,photoId,categoryOf,serviceStatusOf,firstPaymentAt,normalizePhotoOrder,syncPhotoOrderTx};
