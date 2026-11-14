"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {fixture,merchant}=require("./fixtures/shareSql.cjs");
const {createShareService}=require("../lib/merchantShare.cjs");
async function ready(){const f=fixture();const store=f.newStore();await store.ensureSchema();return {f,store};}
test("merchant configuration statistics have bounded query count and include exact filtered and global totals",async()=>{
  const {f,store}=await ready();for(let i=1;i<=40;i++)await store.onboardMerchant(merchant("m"+i));
  const tables=f.tables();tables.detail.push({id:"d1",merchant_id:"m1",snapshot_id:"s1",order_id:"o1",split_type:"T1",amount:"12.34",period:"2026-11",created_at:"2026-11-01 00:00:00"});
  tables.detail.push({id:"d2",merchant_id:"m1",snapshot_id:"s1",order_id:"o1",split_type:"T1",amount:"-2.34",period:"2026-11",created_at:"2026-11-02 00:00:00"});
  f.statements.length=0;const result=await store.listRuleSummaries({keyword:"门店m1",page:1,size:20});
  assert.equal(result.total,11);assert.equal(result.summary.total,40);assert.equal(result.summary.configured,40);assert.equal(result.summary.monthNetAmount,"10.00");
  assert.equal(result.list.find(row=>row.id==="m1").totalAmount,"10.00");assert.equal(f.statements.filter(row=>/^SELECT/.test(row.sql)).length,6);
  f.statements.length=0;const service=createShareService(f.source,{store,clock:()=>new Date("2026-11-01T00:00:00Z")});
  const listed=await service.listRules({page:1,size:20},{kind:"admin",role:"super"});assert.equal(listed.summary.total,40);assert.equal(f.statements.length,6,"service reuses native aggregate instead of loading it twice");
});
test("detail projections batch snapshots and merchants for a full page while totals cover all movements",async()=>{
  const {f,store}=await ready();await store.onboardMerchant(merchant());
  f.tables().snapshot.push({id:"s1",order_id:"o1",paid_total:"100.00",judge_time:"2026-11-01 00:00:00",display_json:JSON.stringify({orderNo:"ORDER1",productName:"真实商品"})});
  for(let i=1;i<=30;i++)f.tables().detail.push({id:String(i),merchant_id:"m1",snapshot_id:"s1",order_id:"o1",split_type:"T1",amount:i===30?"-0.50":"1.00",period:"2026-11",created_at:"2026-11-01 00:00:00"});
  f.statements.length=0;const result=await store.listDetails({page:1,size:20});
  assert.equal(result.total,30);assert.equal(result.list.length,20);assert.equal(result.sum.netAmount,"28.50");assert.equal(result.list[0].merchantName,"门店m1");assert.equal(result.list[0].display.productName,"真实商品");assert.equal(f.statements.length,3);
  f.statements.length=0;const empty=await store.listDetails({merchantId:"absent"});assert.equal(empty.total,0);assert.equal(f.statements.length,1);
});
test("QR history batching preserves active-only scans and disabled-attempt evidence per code",async()=>{
  const {f,store}=await ready();await store.onboardMerchant(merchant());
  for(let i=0;i<30;i++)f.tables().qr.push({id:"old"+i,merchant_id:"m1",status:"DISABLED",qr_seq:i+2});
  f.tables().scan.push({id:"scan1",qr_id:"qr-m1",merchant_id:"m1",scan_at:"2026-11-01 00:00:00"},{id:"scan2",qr_id:"old0",merchant_id:"m1",scan_at:"2026-11-01 00:00:00"});
  f.tables().observation.push({id:"x",metric_key:"DISABLED_QR_SCAN",subject_hash:crypto.createHash("sha256").update("old0").digest("hex"),occurred_at:"2026-11-01 00:00:00"});
  f.statements.length=0;const result=await store.listQrs("m1");
  assert.equal(result.length,31);assert.equal(result.find(row=>row.id==="qr-m1").scanCount,1);assert.equal(result.find(row=>row.id==="old0").scanCount,0);assert.equal(result.find(row=>row.id==="old0").disabledScanCount,1);assert.equal(f.statements.length,3);
});
test("analytics facts read only its required four tables while workers retain the complete read",async()=>{
  const {f,store}=await ready();f.statements.length=0;
  const data=await store.readOperationalFacts({tables:["job","snapshot","detail","correction"]});
  assert.deepEqual(Object.keys(data),["job","snapshot","detail","correction"]);assert.equal(f.statements.length,4);
  f.statements.length=0;const all=await store.readOperationalFacts();assert.equal(Object.keys(all).length,10);assert.equal(f.statements.length,10);
});
