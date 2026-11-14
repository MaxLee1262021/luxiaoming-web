"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {createShareService}=require('../lib/merchantShare.cjs');

function fixture() {
  const details=[
    {orderId:'old',merchantId:'A',splitType:'T1',amount:'50.00',period:'2026-11',createdAt:'2026-11-10T02:00:00Z'},
    {orderId:'old',merchantId:'A',splitType:'T1',amount:'-5.00',period:'2026-12',createdAt:'2026-12-10T02:00:00Z'},
    {orderId:'changed',merchantId:'A',splitType:'T1',amount:'5.00',period:'2026-11',createdAt:'2026-11-20T02:00:00Z'},
    {orderId:'changed',merchantId:'A',splitType:'T1',amount:'-5.00',period:'2026-12',createdAt:'2026-12-11T02:00:00Z'},
    {orderId:'changed',merchantId:'B',splitType:'T2',amount:'8.00',period:'2026-12',createdAt:'2026-12-11T02:00:00Z'},
  ];
  const jobs=[
    ['old','A','T1','2026-11-10T02:00:00Z','DONE'],
    ['changed','A','T1','2026-11-20T02:00:00Z','DONE'],
    ['platform','0','T1','2026-12-02T02:00:00Z','DONE'],
    ['pending','B','T2','2026-12-03T02:00:00Z','PENDING'],
    ['zero','A','T1','2026-12-04T02:00:00Z','DONE'],
  ].map(([orderId,hitMerchantId,splitType,payTime,status])=>({orderId,payTime,status,decisionJson:{hitMerchantId,splitType}}));
  const facts={job:jobs,snapshot:jobs.filter(j=>j.status==='DONE').map(j=>({orderId:j.orderId,...j.decisionJson})),detail:details,
    correction:[{orderId:'changed',revisionNo:1,nextStateJson:{hitMerchantId:'B',splitType:'T2'}}]};
  const store={
    listDetails:async q=>({list:details.filter(r=>(!q.period||r.period===q.period)&&(!q.merchantId||r.merchantId===q.merchantId))}),
    listMerchants:async()=>[{merchantId:'A',name:'商家A',scanCount:7,boundUsers:4},{merchantId:'B',name:'商家B',scanCount:3,boundUsers:2}],
    readOperationalFacts:async()=>structuredClone(facts),
  };
  const source={list:async key=>key==='orders'?[{id:'old',cityId:'city-x'},{id:'changed',source:{cityId:'city-y'}},{id:'platform',cityId:'city-y'},{id:'pending',cityId:'city-x'},{id:'zero',cityId:'city-x'}]:[]};
  return createShareService(source,{store,clock:()=>new Date('2026-12-15T00:00:00Z')});
}
const admin={kind:'admin',role:'super',subjectId:'admin'};

test('December movements and current order balance remain separate across refunds and corrections',async()=>{
  const result=await fixture().analytics({period:'2026-12'},admin);
  assert.equal(result.totalAmount,'-2.00');
  assert.equal(result.merchants.find(m=>m.merchantId==='A').totalAmount,'-10.00');
  assert.equal(result.merchants.find(m=>m.merchantId==='B').totalAmount,'8.00');
  const old=result.orderAttributions.find(o=>o.orderId==='old');
  assert.equal(old.amount,'45.00');assert.equal(old.ledgerAmount,'-5.00');
  const changed=result.orderAttributions.find(o=>o.orderId==='changed');
  assert.equal(changed.merchantId,'B');assert.equal(changed.splitType,'T2');assert.equal(changed.amount,'8.00');assert.equal(changed.ledgerAmount,'3.00');
  assert.equal(result.amountScope,'current_order_balance');
});

test('platform, zero-commission and immature paid orders retain an explicit attribution without amount rows',async()=>{
  const result=await fixture().analytics({period:'2026-12'},admin);
  const map=new Map(result.orderAttributions.map(o=>[o.orderId,o]));
  assert.equal(map.get('platform').merchantId,'0');assert.equal(map.get('platform').amount,'0.00');
  assert.equal(map.get('zero').merchantId,'A');assert.equal(map.get('zero').amount,'0.00');
  assert.equal(map.get('pending').merchantId,'B');assert.equal(map.get('pending').amount,'0.00');assert.equal(map.get('pending').pending,true);
  assert.equal(result.merchants.find(m=>m.merchantId==='A').monthOrders,1);
});

test('city totals use actual order business city even when new merchant records have no city field',async()=>{
  const result=await fixture().analytics({period:'2026-12',cityId:'city-x'},admin);
  assert.equal(result.totalAmount,'-5.00');
  assert.deepEqual(result.orderAttributions.map(o=>o.orderId).sort(),['old','pending','zero']);
  assert.equal(result.merchants.find(m=>m.merchantId==='A').totalAmount,'-5.00');
  assert.equal(result.merchants.find(m=>m.merchantId==='B').monthOrders,1);
  assert.equal(result.cityScope,'order_business_city');assert.equal(result.scanScope,'current_qr_all_cities');
  const noCity=await fixture().analytics({period:'2026-12',cityId:'nonexistent'},admin);
  assert.equal(noCity.totalAmount,'0.00');assert.deepEqual(noCity.merchants,[]);assert.deepEqual(noCity.orderAttributions,[]);
});

test('a period or merchant financial filter never replaces the complete lookup with negative-only or absent facts',async()=>{
  const result=await fixture().analytics({period:'2026-12',merchantId:'A'},admin);
  assert.equal(result.totalAmount,'-10.00');assert.deepEqual(result.merchants.map(m=>m.merchantId),['A']);
  assert.equal(result.orderAttributions.find(o=>o.orderId==='old').amount,'45.00');
  assert.equal(result.orderAttributions.find(o=>o.orderId==='changed').merchantId,'B');
  await assert.rejects(fixture().analytics({period:'2026-12'},{kind:'admin',role:'merchant',shopId:'A'}),{code:'SHARE_4030'});
});
