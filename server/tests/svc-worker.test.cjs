"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createSvcMemoryStore}=require('../lib/svcStore.cjs');
const CS=require('../lib/customerService.cjs'),c=require('../lib/svcCore.cjs');
function fakeSource() {
  const records=[{id:'ord',orderNo:'LM1',depositPaidAt:'2026-11-10 09:00:00',svcPaymentPending:true,svcPaymentAttempts:0}];
  return {async get(key,id){return structuredClone(records.find(r=>r.id===id));},async update(key,id,patch){Object.assign(records.find(r=>r.id===id),structuredClone(patch));return this.get(key,id);},async list(){return structuredClone(records);}};
}
test('payment retry preserves durable budget across instances and reaches dead letter after three retries',async()=>{
  const prior=process.env.SVC_ENABLE_AT;process.env.SVC_ENABLE_AT='2026-11-01T00:00:00+08:00';
  try {
    const source=fakeSource(),store=createSvcMemoryStore(),logs=[];let at='2026-11-10 09:00:00',calls=0;
    const options={store,clock:()=>new Date(c.millis(at)),schedule:false,logger:{error:(...args)=>logs.push(args)}};
    const instance=CS.serviceFor(source,options);
    instance.workbench.onPaid=async()=>{calls++;throw Object.assign(new Error('do not leak connection secrets'),{code:'SVC_TEST_FAILURE'});};
    const first=await CS.attemptPaid(source,await source.get('orders','ord'),options);assert.equal(first.next_attempt_at,'2026-11-10 09:00:05');
    at='2026-11-10 09:00:04';await CS.attemptPaid(source,await source.get('orders','ord'),options);assert.equal(calls,1);
    at='2026-11-10 09:00:05';let result=await CS.attemptPaid(source,await source.get('orders','ord'),options);assert.equal(result.next_attempt_at,'2026-11-10 09:00:30');
    // A repeated callback cannot replenish the exhausted-attempt budget.
    await CS.queuePaid(source,await source.get('orders','ord'),options);assert.equal((await source.get('orders','ord')).svcPaymentAttempts,2);
    at='2026-11-10 09:00:30';result=await CS.attemptPaid(source,await source.get('orders','ord'),options);assert.equal(result.next_attempt_at,'2026-11-10 09:02:35');
    at='2026-11-10 09:02:35';result=await CS.attemptPaid(source,await source.get('orders','ord'),options);assert.equal(result.dead,true);assert.equal(calls,4);
    const final=await source.get('orders','ord');assert.equal(final.svcPaymentPending,false);assert.equal(final.svcPaymentDeadAt,at);
    assert.equal(store.snapshot().notifications.filter(n=>n.event_type==='technical_alert').length,1);
    await CS.queuePaid(source,final,options);assert.equal(calls,4);assert.equal(JSON.stringify(logs).includes('connection secrets'),false);
  }finally{if(prior===undefined)delete process.env.SVC_ENABLE_AT;else process.env.SVC_ENABLE_AT=prior;}
});
test('notification retry never changes completed business state and stops at dead letter',async()=>{
  const {createSvcWorkbench}=require('../lib/svcWorkbench.cjs');let at='2026-11-10 09:00:00',calls=0;
  const store=createSvcMemoryStore({orders:[{id:'done',order_no:'DONE',service_status:'done'}],notifications:[{id:'n1',event_key:'reminder',event_type:'slot_reminder',message:'synthetic',status:'pending',attempts:0,next_attempt_at:at,created_at:at}]});
  const app=createSvcWorkbench({store,clock:()=>new Date(c.millis(at)),notifier:async()=>{calls++;throw new Error('synthetic unavailable');}});
  await app.deliverNotifications();assert.equal(store.snapshot().notifications[0].next_attempt_at,'2026-11-10 09:00:05');
  at='2026-11-10 09:00:05';await app.deliverNotifications();at='2026-11-10 09:00:30';await app.deliverNotifications();
  assert.equal(calls,3);assert.equal(store.snapshot().notifications[0].status,'dead');assert.equal(store.snapshot().orders[0].service_status,'done');
  at='2026-11-10 10:00:00';await app.deliverNotifications();assert.equal(calls,3);
});
test('reminders use rescheduled time once and old reminder window cannot enqueue',async()=>{
  const {createSvcWorkbench}=require('../lib/svcWorkbench.cjs');let at='2026-11-10 09:00:00';
  const store=createSvcMemoryStore({orders:[{id:'scheduled',order_no:'SCHEDULED',service_status:'confirmed',schedule_time:'2026-11-10 12:00:00',paid_at:'2026-11-09 08:00:00',assignee_id:'st1'}]});
  const app=createSvcWorkbench({store,clock:()=>new Date(c.millis(at))});
  await app.runTasks();assert.equal(store.snapshot().notifications.length,0);at='2026-11-10 10:00:00';await app.runTasks();await app.runTasks();assert.equal(store.snapshot().notifications.length,1);
});
test('reschedule cancels already queued reminder for previous appointment',async()=>{
  const {createSvcWorkbench}=require('../lib/svcWorkbench.cjs'),at='2026-11-10 10:00:00';
  const store=createSvcMemoryStore({staff:[{id:'st1',account_id:'a1',staff_status:'active'}],orders:[{id:'o1',order_no:'LM1',service_status:'confirmed',schedule_time:'2026-11-10 12:00:00',requested_time:'2026-11-10 12:00:00',paid_at:'2026-11-09 08:00:00',assignee_id:'st1',service_managed:true}]});
  const app=createSvcWorkbench({store,clock:()=>new Date(c.millis(at))});await app.runTasks();
  await app.execute('POST','/api/kf/orders/LM1/slot/reschedule',{expected_status:'confirmed',new_time:'2026-11-11 12:00:00',reason:'天气原因',channel:'phone'},{kind:'admin',role:'service',authzUserId:'a1'});
  assert.equal(store.snapshot().notifications.find(n=>n.event_type==='slot_reminder').status,'canceled');
});
