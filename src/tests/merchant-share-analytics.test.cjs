"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
function fixture() {
  const requests = [], events = {}, notices = [];
  const controls = { response: async () => ({ code: 0, data: { merchants: [], orderAttributions: [], totalAmount: "0.00" } }) };
  const window = { LXM_APP_PARTS: [], LXM_AUTH: { hasSession: () => true }, addEventListener: (name, handler) => { events[name] = handler; },
    LXM_HTTP: { async request(url) { requests.push(url); return { ok: true, json: () => controls.response() }; } } };
  const data = Object.fromEntries(["orders", "afterSales", "shops", "distributors", "agents", "staff", "cities", "scans", "packages", "albums", "peripherals", "addonServices", "spots", "series", "samples", "reconciliationTransfers", "monthlyClosings", "adjustmentRecords"].map((key) => [key, []]));
  const computed = (fn) => ({ get value() { return typeof fn === "function" ? fn() : fn.get(); } });
  const ctx = { data, computed, reactive: (value) => value, watch() {}, state: { role: "super", authed: true, active: "reconciliation", filters: { reconcileMonth: "2026-11" }, selectedReconciliationKeys: [], dashboardCityId: "" },
    roleProfile: { value: { scope: "all", menus: ["dashboard", "reconciliation", "shareRules", "shareDetails"] } }, currentStaff: { value: null }, statusDict: [],
    visibleCities: computed(() => data.cities), visibleDistributors: computed(() => data.distributors),
    ElMessage: Object.fromEntries(["error", "warning", "success"].map((kind) => [kind, (message) => notices.push({ kind, message })])), ElMessageBox: {}, switchMenu() {}, log() {}, selectedOrders: { value: [] },
    contentKeys: [] };
  const sandbox = { window, URLSearchParams, LXM_CONFIG: { roles: {}, menus: ctx.roleProfile.value.menus.map((key) => ({ key })) }, LXMFormat: { date: () => "2026-11-07", nowText: () => "2026-11-07 12:00:00" } };
  for (const file of ["02-order-basis.js", "04-scope-rows.js", "05-dashboard.js", "13-reconciliation.js", "15-reconciliation-views.js", "16-export.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, "src/app", file), "utf8"), sandbox); Object.assign(ctx, window.LXM_APP_PARTS.pop()(ctx));
    if (file === "02-order-basis.js") { ctx.isCreatedBooking = () => true; ctx.isReconciliationEligible = () => true; ctx.isEstimatedReconciliationOrder = () => true; ctx.isOrderCompletedStatus = () => true; ctx.isSettlementObservationPending = () => false; ctx.hasBlockingAfterSale = () => false; }
  }
  return { ctx, controls, requests, events, notices };
}
test("merchant ranks and read-only accrual use server attribution rather than the old source and current rate", async () => {
  const f = fixture();
  f.ctx.data.shops.push({ id: "old", name: "旧来源", commissionRate: 50 }, { id: "new", name: "新归属", commissionRate: 50 });
  f.ctx.data.orders.push({ id: "o1", orderNo: "ONE", status: "completed", shopId: "old", totalAmount: 100, appointmentAt: "2026-11-07", products: [], sourceType: "shop" });
  f.controls.response = async () => ({ code: 0, data: { merchants: [{ merchantId: "new", name: "新归属", totalAmount: "7.51", orderCount: 1, scanCount: 3, boundUsers: 2 }], orderAttributions: [{ orderId: "o1", merchantId: "new", splitType: "T2", amount: "7.51", ledgerAmount: "7.51" }], totalAmount: "7.51" } });
  await f.ctx.loadShareAnalytics();
  assert.match(f.requests[0], /period=2026-11/); assert.equal(f.ctx.shopRank.value[0].id, "new"); assert.equal(f.ctx.shopRank.value[0].amount, 7.51);
  const row = f.ctx.reconciliation("shop")[0]; assert.equal(row.commission, 7.51); assert.equal(row.ledgerReadOnly, true); assert.deepEqual(Array.from(row.orderIds), ["o1"]);
  assert.equal(f.ctx.withTransferStatus(row).transferStatus, "本期不结算"); assert.equal(f.ctx.settlementOrderAmount(f.ctx.data.orders[0], row), 0);
  assert.equal(f.ctx.shareSourceDistribution.value.find((row) => row.key === "T2").count, 1);
});
test("dashboard refresh reloads scan facts and presents each actual visit with distinct visitors and date filtering", async () => {
  const f = fixture(); const reloads = [];
  f.ctx.state.active = "dashboard"; f.ctx.state.filters.dateRange = ["2026-11-13", "2026-11-13"];
  f.ctx.data.shops.push({ id: "A", name: "商家A" });
  let newVisit = false;
  f.ctx.loadAuthenticatedData = async (route, options) => {
    reloads.push({ route, options });
    f.ctx.data.scans = [
      { id: "share-scan-1", shopId: "A", visitorHash: "visitor-a", date: "2026-11-13", businessDate: "2026-11-13", hour: 10 },
      { id: "share-scan-2", shopId: "A", visitorHash: "visitor-a", date: "2026-11-13", businessDate: "2026-11-13", hour: 10 },
      { id: "old-scan", shopId: "A", visitorHash: "visitor-b", date: "2026-11-12", hour: 9 },
      ...(newVisit ? [{ id: "share-scan-3", shopId: "A", visitorHash: "visitor-c", date: "2026-11-13", hour: 11 }] : [])
    ];
  };
  await f.ctx.refreshDashboard();
  assert.equal(reloads[0].route, "dashboard"); assert.equal(reloads[0].options.force, true);
  assert.equal(f.ctx.dashboard.value.scans, 2); assert.equal(f.ctx.dashboard.value.unique, 1); assert.equal(f.ctx.scanHeat.value[10].count, 2);
  newVisit = true; await f.ctx.refreshDashboard();
  assert.equal(f.ctx.dashboard.value.scans, 3); assert.equal(f.ctx.dashboard.value.unique, 2); assert.equal(f.ctx.scanHeat.value[11].count, 1);
  assert.equal(f.ctx.recentScanSources.value.length, 3); assert.equal(f.requests.length, 2);
});
test("projection drills only intersect already authorized orders, and unavailable projection does not fall back to old rates", async () => {
  const f = fixture(); f.ctx.data.orders.push({ id: "visible", totalAmount: 100, appointmentAt: "2026-11-07" });
  f.controls.response = async () => ({ code: 0, data: { merchants: [{ merchantId: "s", name: "商家", totalAmount: "3.00" }], orderAttributions: [{ orderId: "visible", merchantId: "s", amount: "3.00", ledgerAmount: "3.00" }, { orderId: "hidden", merchantId: "s", amount: "20.00", ledgerAmount: "20.00" }], totalAmount: "3.00" } });
  await f.ctx.loadShareAnalytics(); assert.deepEqual(Array.from(f.ctx.reconciliation("shop")[0].orderIds), ["visible"]);
  assert.equal(f.ctx.shareLedgerForOrders(f.ctx.scopedOrders.value), 3);
  f.controls.response = async () => { throw new Error("连接失败"); }; await f.ctx.loadShareAnalytics();
  assert.equal(f.ctx.shareAnalytics.ready, false); assert.equal(f.ctx.shareLedgerForOrders(f.ctx.data.orders), null); assert.equal(f.ctx.shopRank.value.length, 0); assert.match(f.ctx.shareAnalytics.error, /连接失败/);
});
test("a late analytics response is discarded when auth is cleared", async () => {
  const f = fixture(); let resolve; f.controls.response = () => new Promise((done) => { resolve = done; });
  const pending = f.ctx.loadShareAnalytics(); await new Promise(setImmediate); f.events["lxm-auth-expired"]();
  resolve({ code: 0, data: { merchants: [{ merchantId: "private" }], totalAmount: "99.00" } }); await pending;
  assert.equal(f.ctx.shareAnalytics.ready, false); assert.equal(f.ctx.shareAnalytics.merchants.length, 0);
});
test("old merchant settlement entry points refuse writes, and refund summaries count successful attempts only", async () => {
  const f = fixture(); const merchant = { id: "s", type: "shop", commission: 100, orderIds: ["o"] };
  f.ctx.confirmSettlementBatch(merchant); assert.equal(f.ctx.state.settlementDialog, undefined); assert.equal(await f.ctx.createSettlementRecordFromRow(merchant), null);
  assert.equal(f.ctx.settlementExportRow({ ledgerReadOnly: true, commission: 0, amount: 100 })["应计金额"], 0, "a zero ledger entry must not fall back to old order revenue");
  f.ctx.data.orders.push({ id: "o", totalAmount: 100, appointmentAt: "2026-11-07", products: [] });
  f.ctx.data.afterSales.push({ orderId: "o", financeStatus: "已审", refundAmount: 30, refundAttempts: [{ status: "SUCCESS", amountFen: 1000 }, { status: "PROCESSING", amountFen: 2000 }] });
  assert.equal(f.ctx.reconciliationSummary.value.reviewedRefundAmount, 10); assert.equal(f.ctx.reconciliationSummary.value.pendingRefundAmount, 20);
});

test("legacy monthly reconciliation cannot recreate photographer debts from preserved fulfillment orders", async () => {
  const f = fixture();
  f.ctx.data.staff.push({id:"old-photo",name:"保留摄影师",role:"photo",commissionRate:50});
  f.ctx.data.orders.push({id:"old-done",orderNo:"OLD-DONE",photographerId:"old-photo",status:"completed",totalAmount:100,appointmentAt:"2026-11-07",products:[],commissionSnapshot:{version:1,netAmount:100,photographerAmount:50,distributorAmount:0,shopAmount:0,headquarterAmount:50}});
  f.ctx.data.reconciliationTransfers.push({id:"old-transfer",month:"2026-11",objectType:"摄影师",objectId:"old-photo",amount:50,status:"已确"});
  f.ctx.data.adjustmentRecords.push({id:"old-adjust",time:"2026-11-07",targetType:"photo",amount:-20});
  assert.equal(f.ctx.reconciliation("photo").length,0);
  assert.equal(f.ctx.photographerSettlementRows.value.length,0);
  assert.equal(f.ctx.reconciliationTransferRows.value.length,0);
  assert.equal(f.ctx.adjustmentRecordRows.value.length,0);
  assert.equal(f.ctx.reconciliationSummary.value.photographerCommissionAmount,null);
  assert.equal(f.ctx.reconciliationSummary.value.estimatedPhotographerCommissionAmount,null);
  assert.equal(f.ctx.reconciliationSummary.value.headquarterAmount,null);
  assert.equal(f.ctx.reconciliationSummary.value.pendingTransferAmount,0);
  const exportHq=f.ctx.reconciliationCompositeExportRows().find(row=>row["主体名称"]==="总部收入");
  assert.equal(exportHq["金额"],null);assert.match(exportHq["说明"],/独立账本/);
  const target={id:"old-photo",type:"photo",typeName:"摄影",commission:50,orderIds:["old-done"]};
  f.ctx.confirmSettlementBatch(target);assert.equal(f.ctx.state.settlementDialog,undefined);
  assert.equal(await f.ctx.createSettlementRecordFromRow(target),null);
  assert.equal(f.ctx.settlementOrderAmount(f.ctx.data.orders[0],target),0);
  assert.equal(f.ctx.reconciliationDetailAmount(f.ctx.data.orders[0],"photo"),null);
  assert.equal(f.ctx.reconciliationDetailAmount(f.ctx.data.orders[0],"headquarter"),null);
  assert.equal(f.ctx.data.orders.length,1,"fulfillment facts stay available");
});

test("independent photographer link obeys granted menus and distributor reconciliation remains active", () => {
  const f=fixture();let navigation;
  f.ctx.switchMenu=key=>{navigation=key;};
  f.ctx.openPhotoFinanceLedger();assert.equal(navigation,undefined);assert.match(f.notices.at(-1).message,/开通/);
  f.ctx.roleProfile.value.menus.push("photoSettlement");
  f.ctx.openReconciliationDetail("photo","摄影师应计");assert.equal(navigation,"photoSettlement");assert.equal(f.ctx.state.reconciliationDialog,undefined);
  f.ctx.data.distributors.push({id:"distributor",name:"分销员",commissionRate:10});
  f.ctx.data.orders.push({id:"valid-distributor",orderNo:"DIST",distributorId:"distributor",status:"completed",totalAmount:100,appointmentAt:"2026-11-07",products:[],commissionSnapshot:{version:1,netAmount:100,photographerAmount:30,distributorAmount:10,shopAmount:0,headquarterAmount:60}});
  assert.equal(f.ctx.reconciliation("distributor")[0].commission,10);
  assert.equal(f.ctx.reconciliationSummary.value.distributorCommissionAmount,10);
  assert.equal(f.ctx.reconciliationSummary.value.pendingTransferAmount,10);
});
test("statistical merchant filtering follows T2 attribution A even when the latest channel is B, while employee order access stays restricted", async () => {
  const f = fixture(); f.ctx.state.role = "service"; f.ctx.state.active = "dashboard";
  Object.assign(f.ctx.roleProfile.value, { scope: "orders", staffId: "staff-me" }); f.ctx.state.filters.shopId = "A";
  f.ctx.data.shops.push({ id: "A", name: "归属A" }, { id: "B", name: "扫码B" });
  f.ctx.data.orders.push({ id: "mine", status: "completed", orderNo: "MINE", assigneeId: "staff-me", shopId: "B", source: { shopId: "B" }, appointmentAt: "2026-11-07" }, { id: "other", status: "completed", orderNo: "OTHER", assigneeId: "staff-other", shopId: "B", appointmentAt: "2026-11-07" });
  f.controls.response = async () => ({ code: 0, data: { merchants: [{ merchantId: "A", name: "归属A", totalAmount: "5.00" }], orderAttributions: ["mine", "other"].map((orderId) => ({ orderId, merchantId: "A", splitType: "T2", amount: "5.00", ledgerAmount: "5.00", pending: false })), totalAmount: "5.00" } });
  await f.ctx.loadShareAnalytics();
  assert.deepEqual(Array.from(f.ctx.scopedOrders.value.map((row) => row.id)), ["mine"]);
  assert.equal(f.ctx.shareSourceDistribution.value.find((row) => row.key === "T2").count, 1);
  assert.deepEqual(Array.from(f.ctx.reconciliation("shop")[0].orderIds), ["mine"]);
  f.ctx.state.active = "orders"; assert.equal(f.ctx.scopedOrders.value.length, 0, "the employee worklist still filters its original channel");
  f.ctx.state.filters.shopId = "B"; assert.deepEqual(Array.from(f.ctx.scopedOrders.value.map((row) => row.id)), ["mine"], "switching perspective never grants another employee's order");
});
test("city statistics follow the order business city even for a merchant without city metadata; merchant scan and binding totals stay intact", async () => {
  const f = fixture(); f.ctx.state.active = "dashboard"; f.ctx.state.dashboardCityId = "c1";
  f.ctx.data.cities.push({ id: "c1", name: "城市一" }, { id: "c2", name: "城市二" }); f.ctx.data.shops.push({ id: "A", name: "无城市商家" });
  f.ctx.data.orders.push({ id: "in", status: "completed", cityId: "c1", appointmentAt: "2026-11-07" }, { id: "out", status: "completed", source: { cityId: "c2" }, appointmentAt: "2026-11-07" }, { id: "unknown", status: "completed", appointmentAt: "2026-11-07" });
  f.controls.response = async () => ({ code: 0, data: { merchants: [{ merchantId: "A", name: "无城市商家", scanCount: 9, boundUsers: 4, orderCount: 1, totalAmount: "3.00" }], orderAttributions: [{ orderId: "in", merchantId: "A", splitType: "T1", amount: "3.00", ledgerAmount: "3.00", pending: false }], totalAmount: "3.00", cityScope: "order_business_city", scanScope: "current_qr_all_cities", bindingScope: "active_history_all_cities" } });
  await f.ctx.loadShareAnalytics(); assert.match(f.requests[0], /cityId=c1/);
  assert.deepEqual(Array.from(f.ctx.scopedOrders.value.map((row) => row.id)), ["in"]);
  assert.equal(f.ctx.shopRank.value[0].id, "A"); assert.equal(f.ctx.shopRank.value[0].scanCount, 9); assert.equal(f.ctx.shopRank.value[0].boundUsers, 4);
  assert.equal(f.ctx.scopedShops.value.length, 1); assert.equal(f.ctx.shareAnalytics.scanScope, "current_qr_all_cities");
  f.ctx.state.active = "reconciliation"; await f.ctx.loadShareAnalytics(); assert.doesNotMatch(f.requests.at(-1), /cityId=/, "a dashboard-only city selection does not silently constrain the accounting page");
});
test("cross-month reversals use period movements for merchant accrual and lifetime balances for headquarters, with pending and zero outcomes classified correctly", async () => {
  const f = fixture(); f.ctx.state.filters.reconcileMonth = "2026-12";
  const refunded = { id: "refund", status: "completed", appointmentAt: "2026-11-07", commissionSnapshot: { version: 1, netAmount: 50, distributorAmount: 10, photographerAmount: 0, shopAmount: 10, headquarterAmount: 30 } };
  f.ctx.data.orders.push(refunded, ...["zero", "platform", "pending"].map((id) => ({ id, status: "completed", appointmentAt: "2026-12-01" })));
  f.controls.response = async () => ({ code: 0, data: { merchants: [{ merchantId: "A", name: "商家A", totalAmount: "-2.50" }], orderAttributions: [
    { orderId: "refund", merchantId: "A", splitType: "T2", amount: "2.50", ledgerAmount: "-2.50", pending: false },
    { orderId: "zero", merchantId: "A", splitType: "T1", amount: "0.00", ledgerAmount: "0.00", pending: false },
    { orderId: "platform", merchantId: "0", splitType: "T1", amount: "0.00", ledgerAmount: "0.00", pending: false },
    { orderId: "pending", merchantId: "0", amount: "0.00", ledgerAmount: "0.00", pending: true }
  ], totalAmount: "-2.50" } });
  await f.ctx.loadShareAnalytics();
  assert.equal(f.ctx.shareLedgerForOrders([refunded]), -2.5); assert.equal(f.ctx.shareBalanceForOrders([refunded]), 2.5);
  assert.equal(f.ctx.shareHeadquarterForOrders([refunded]), 37.5, "a negative December movement must not inflate current retained headquarters income");
  assert.equal(f.ctx.reconciliationDetailAmount(refunded, "shop"), "-2.50");
  assert.deepEqual(Array.from(f.ctx.shareSourceDistribution.value.map((row) => row.count)), [1, 1, 1, 1]);
});
