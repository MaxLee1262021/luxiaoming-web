"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {orderRow,createSvcMemoryStore}=require('../lib/svcStore.cjs');
const C=require('../lib/svcCommission.cjs'),{INITIAL_RATES}=require('../lib/svcApproved.cjs');
const {migrate,statements}=require('../../scripts/migrate-customer-service.cjs');
const path=require('node:path');
const at='2026-11-11 12:00:00';
test('confirmed initial service rates map to 5/10/8/15 percent and add manual metadata migration',async()=>{
 assert.deepEqual(INITIAL_RATES,{photo_bp:500,video_bp:1000,combo_bp:800,peripheral_bp:1500});
 const plan=await migrate(null);assert.deepEqual(plan.approvedInitialRates,INITIAL_RATES);assert.ok(plan.migrations.includes('020_service_confirmed.sql'));
 const sql=statements(path.resolve(__dirname,'../migrations/020_service_confirmed.sql')).join('\n');
 for(const table of ['svc_staff_tag','svc_staff_profile_log','svc_operation_log','svc_receipt_log'])assert.match(sql,new RegExp('CREATE TABLE IF NOT EXISTS '+table));
 assert.match(sql,/rate_review_date DATE/);assert.match(sql,/submitted_by VARCHAR/);
});
test('service commission uses actual paid deposit; photographer still sees whole agreed order net',async()=>{
 const order=orderRow({id:'o',orderNo:'DEPOSIT-1',totalAmount:'1000.00',finalDiscountAmount:'50.00',depositPaid:'200.01',finalPaid:'749.99',depositPaidAt:at,category:'photo',assignee_id:'cs',photo_id:'p',service_status:'claimed'});
 assert.equal(order.service_net_amount_fen,20001);assert.equal(order.net_amount_fen,95000);
 const store=createSvcMemoryStore({orders:[order],rules:[{id:'1',ver:1,beneficiary_type:'service',party_id:null,rule_mode:'global',rate_photo_bp:500,rate_video_bp:1000,rate_combo_bp:800,rate_peripheral_bp:1500,eff_at:'2026-11-01 00:00:00'}],staff:[{id:'cs',name:'Test'}]});
 await store.transaction(state=>C.ensureLedger(state,state.orders[0],at));
 let row=store.snapshot().ledger[0];assert.equal(row.net_amount_fen,20001);assert.equal(row.commission_fen,1000);
 await store.transaction(state=>{state.orders[0].totalAmount='2000';state.orders[0].finalPaid='1749.99';state.orders[0].net_amount_fen=195000;C.ensureLedger(state,state.orders[0],at);});
 row=store.snapshot().ledger[0];assert.equal(row.net_amount_fen,20001);assert.equal(row.commission_fen,1000);
});
test('unreceived deposit never falls back to full price or final payment for new customer-service rows',()=>{
 for(const depositPaid of [undefined,null,'0.00','-1.00']){
  const row=orderRow({id:'o',orderNo:'ZERO',totalAmount:'999.00',finalPaid:'999.00',depositPaid,depositPaidAt:at});
  assert.equal(row.service_net_amount_fen,0);assert.equal(row.net_amount_fen,99900);
 }
});
