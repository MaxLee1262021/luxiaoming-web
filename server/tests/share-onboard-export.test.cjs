"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {createShareService}=require('../lib/merchantShare.cjs');
const admin={kind:'admin',role:'super',subjectId:'admin'};
const input={name:'合作门店',account:'store-account',password:'Fixture123!',cooperationConfirmed:true,ratioT1:'0.0500',ratioT2:'0.0300',ttlHours:720,refundWindowDays:3,reason:'市场已完成合作沟通'};

test('merchant onboarding cannot claim the reserved administrator identity even when no account row exists yet',async()=>{
  const service=createShareService({}, {store:{},qrProvider:async()=>{throw new Error('reserved identity must be rejected before QR generation');}});
  for(const account of ['admin','ADMIN',' admin ']) await assert.rejects(service.onboard({...input,account},admin,'reserved'),{code:'SHARE_4001'});
});

test('duplicate merchant name is rejected before a WeChat image request even when its provider is unavailable',async()=>{
  let qrCalls=0;
  const service=createShareService({}, {store:{getMerchant:async()=>null,getMerchantByName:async()=>({id:'existing'})},qrProvider:async()=>{qrCalls++;throw new Error('provider unavailable');}});
  await assert.rejects(service.onboard(input,admin,'same-name'),{code:'SHARE_4006'});
  assert.equal(qrCalls,0);
});

test('an onboarding request cannot be reused for changed merchant data, and never stores a fast password fingerprint',async()=>{
  let saved, qrCalls=0;
  const store={getMerchant:async()=>saved || null,getMerchantByName:async()=>null,
    onboardMerchant:async data=>{saved=structuredClone(data);return{merchant:data,merchantId:data.merchantId,existed:false};}};
  const service=createShareService({}, {store,qrProvider:async()=>{qrCalls++;return'data:image/png;base64,iVBORw0KGgo=';}});
  const first=await service.onboard(input,admin,'request-one');
  const repeat=await service.onboard(input,admin,'request-one');
  assert.equal(repeat.merchantId,first.merchantId);assert.equal(repeat.existed,true);assert.equal(qrCalls,1);
  await assert.rejects(service.onboard({...input,phone:'13800001111'},admin,'request-one'),{code:'SHARE_4090'});
  assert.equal(saved.password,undefined);assert.equal(JSON.stringify(saved).includes(input.password),false);
  assert.match(saved.onboardRequestHash,/^[a-f0-9]{64}$/);
  let other;
  const second=createShareService({}, {store:{getMerchant:async()=>null,getMerchantByName:async()=>null,onboardMerchant:async data=>{other=data;return{merchant:data,merchantId:data.merchantId};}},qrProvider:async()=>'data:image/png;base64,iVBORw0KGgo='});
  await second.onboard({...input,password:'AnotherFixture456!'},admin,'request-one');
  assert.equal(other.onboardRequestHash,saved.onboardRequestHash,'the business-request digest must not become a fast password oracle');
});

test('current-month CSV exports all selected records beyond the estimated 2000 rather than truncating a page',async()=>{
  const rows=Array.from({length:2001},(_,i)=>({detailNo:`DETAIL-${i}`,merchantId:'A',merchantName:'门店A',splitType:'T1',direction:1,ratio:'0.0500',amount:'0.05',paidTotal:'1.00',payTime:'2026-11-06T00:00:00Z',display:{orderNo:`ORDER-${i}`,productName:i===2000?'最后一项':'商品',customer:'李某',paidAmount:'1.00'}}));
  let selection,audit;
  const service=createShareService({}, {clock:()=>new Date('2026-11-07T00:00:00Z'),store:{listDetails:async q=>{selection=q;return{list:rows,total:rows.length};},audit:async(...args)=>{audit=args;}}});
  const csv=await service.exportCsv({merchantId:'A',splitType:'T1',page:2},admin);
  assert.equal(selection.all,true);assert.equal(selection.period,'2026-11');assert.equal(selection.merchantId,'A');assert.equal(selection.splitType,'T1');
  assert.equal(csv.startsWith('\uFEFF"分成明细号"'),true);
  assert.equal(csv.includes('"DETAIL-0"'),true);assert.equal(csv.includes('"DETAIL-2000"'),true);assert.equal(csv.includes('"最后一项"'),true);
  assert.equal(csv.split('\r\n').length,2002);assert.equal(audit[2].count,2001);
  await assert.rejects(service.exportCsv({},{kind:'admin',role:'merchant',shopId:'A'}),{code:'SHARE_4030'});
});
