"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createSvcMemoryStore}=require('../lib/svcStore.cjs'),{createSvcCommission}=require('../lib/svcCommission.cjs');
test('prototype KPI totals cover filtered records beyond first page and retain staff scope',async()=>{
 const at='2026-11-12 12:00:00',staff=[{id:'a',name:'甲',account_id:'account-a',staff_status:'active',base_salary:3500},{id:'b',name:'乙',account_id:'account-b',staff_status:'paused',base_salary:0}];
 const ledger=[['1','a','ORDER1','settleable',100],['2','a','ORDER2','void',300],['3','a','ORDER1','settled',200],['4','b','ORDER3','obs',900]].map(([id,party_id,biz_no,status,commission_fen])=>({id,party_id,biz_no,status,commission_fen,beneficiary_type:'service',category:'photo',paid_at:at,created_at:at,rate_bp:500,rate_mode:'global',rule_ver:1,net_amount_fen:2000}));
 const app=createSvcCommission({store:createSvcMemoryStore({staff,ledger}),clock:()=>at}),self={kind:'admin',role:'service',authzUserId:'account-a'};
 const rows=await app.execute('GET','/ledger',{size:1,page:1,period:'2026-11'},self);
 assert.equal(rows.list.length,1);assert.deepEqual(rows.summary,{total_commission_fen:300,row_count:3,void_count:1,order_count:2});
 const filtered=await app.execute('GET','/ledger',{status:'settled'},self);assert.deepEqual(filtered.summary,{total_commission_fen:200,row_count:1,void_count:0,order_count:1});
 const people=await app.execute('GET','/staff',{size:1,period:'2026-11'},{kind:'admin',role:'super'});
 assert.deepEqual(people.summary,{staff_count:2,active_count:1,paused_count:1,ended_count:0,month_fen:1200});assert.equal(people.list.length,1);
 assert.equal(people.list[0].month_fen,300);
});
