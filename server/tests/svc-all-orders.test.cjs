"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createSvcMemoryStore, orderRow} = require("../lib/svcStore.cjs");
const {createSvcWorkbench} = require("../lib/svcWorkbench.cjs");
const AT = "2026-11-13 12:00:00";
const admin = {kind:"admin",role:"super",authzUserId:"admin"};
const service = {kind:"admin",role:"service",authzUserId:"account-1"};
function fixture() {
  const raw = (id, extra={}) => ({id,orderNo:id,createdAt:"2026-11-12 12:00:00",totalAmount:100,depositDue:20,depositPaid:0,finalPaid:0,...extra});
  const store = createSvcMemoryStore({
    staff:[{id:"s1",account_id:"account-1",staff_status:"active",name:"客服甲"},{id:"s2",account_id:"account-2",staff_status:"active",name:"客服乙"}],
    rules:[{id:"1",ver:1,beneficiary_type:"service",party_id:null,rate_photo_bp:500,rate_video_bp:500,rate_combo_bp:500,rate_peripheral_bp:500,eff_at:"2026-09-01 00:00:00"},{id:"2",ver:2,beneficiary_type:"service",party_id:null,rate_photo_bp:1000,rate_video_bp:1000,rate_combo_bp:1000,rate_peripheral_bp:1000,eff_at:"2026-11-01 00:00:00"}],
    orders:[
      raw("UNPAID"), raw("OLD",{depositPaid:20,depositPaidAt:"2026-10-01 12:00:00"}),
      raw("PAID",{svc_paid_processed:1,depositPaid:20,depositPaidAt:AT}),
      raw("FREE",{depositDue:0,depositRatio:0}),
      raw("DONE",{status:"completed",completedAt:AT}), raw("CANCELED",{status:"cancelled"}), raw("REFUNDED",{status:"refunded"}),
      raw("OTHER",{svc_paid_processed:1,service_status:"claimed",assignee_id:"s2",depositPaid:20,depositPaidAt:AT}),
    ].map(orderRow),
  });
  return {store,app:createSvcWorkbench({store,clock:()=>AT})};
}
test("intake defaults to all real orders without replaying attribution or creating accounting facts", async () => {
  const {store,app} = fixture(), before = store.snapshot();
  const result = await app.execute("GET","/api/kf/workbench/overview",{mode:"intake"},admin);
  assert.equal(result.total,8);
  assert.deepEqual(new Set(result.list.map(row=>row.order_no)), new Set(before.orders.map(row=>row.order_no)));
  const unpaid = result.list.find(row=>row.order_no==="UNPAID"), old = result.list.find(row=>row.order_no==="OLD");
  assert.equal(unpaid.paid_at,null); assert.equal(unpaid.payment_status,"unpaid"); assert.equal(unpaid.can_claim,false);
  assert.equal(old.payment_status,"paid"); assert.equal(old.can_claim,true); assert.equal(old.can_operate,false);
  assert.equal(result.list.find(row=>row.order_no==="DONE").service_status,"done");
  assert.equal(result.list.find(row=>row.order_no==="CANCELED").service_status,"canceled");
  assert.equal(result.list.find(row=>row.order_no==="REFUNDED").service_status,"refunded");
  assert.deepEqual(store.snapshot(),before);
});
test("all view preserves owner permissions and exposes unassigned historical terminal details", async () => {
  const {app} = fixture();
  const result = await app.execute("GET","/api/kf/orders/all",{},service);
  assert.equal(result.total,7); assert.ok(!result.list.some(row=>row.order_no==="OTHER"));
  const canceled = await app.execute("GET","/api/kf/orders/CANCELED",{},service);
  assert.equal(canceled.can_operate,false); assert.equal(canceled.service_status,"canceled");
  await assert.rejects(app.execute("GET","/api/kf/orders/OTHER",{},service),{code:403});
});
test("all view supports status/category/keyword filters and notices newly created orders on the next read", async () => {
  const {store,app} = fixture();
  const filtered = await app.execute("GET","/api/kf/orders/all",{keyword:"CANCEL",status:"canceled",type:"photo"},admin);
  assert.deepEqual(filtered.list.map(row=>row.order_no),["CANCELED"]);
  const page = await app.execute("GET","/api/kf/orders/all",{page:2,size:3},admin);
  assert.equal(page.total,8); assert.equal(page.list.length,3);
  await store.transaction(state=>state.orders.push(orderRow({id:"NEW",orderNo:"NEW",createdAt:AT,depositDue:0})));
  const next = await app.execute("GET","/api/kf/orders/all",{},admin);
  assert.equal(next.total,9); assert.equal(next.list[0].order_no,"NEW");
});
test("waived deposits enter the claim pool with no fabricated payment or commission", async () => {
  const {store,app} = fixture();
  const pool = await app.execute("GET","/api/kf/orders/pool",{},service);
  assert.deepEqual(new Set(pool.list.map(row=>row.order_no)),new Set(["OLD","PAID","FREE"]));
  const free = pool.list.find(row=>row.order_no==="FREE");
  assert.equal(free.can_claim,true); assert.equal(free.payment_status,"waived"); assert.equal(free.paid_at,null);
  await app.execute("POST","/api/kf/orders/FREE/claim",{expected_status:"new"},service);
  assert.equal(store.snapshot().orders.find(row=>row.order_no==="FREE").assignee_id,"s1");
  assert.equal(store.snapshot().ledger.length,0); assert.equal(store.snapshot().events.length,0);
});

test('paid pending orders appear in public pool and summary before attribution without changing any accounting facts', async () => {
  const {store,app} = fixture(), before = store.snapshot();
  for (const session of [admin,service,{...service,role:'service_supervisor'}]) {
    const direct = await app.execute('GET','/api/kf/orders/pool',{},session);
    assert.deepEqual(new Set(direct.list.map(row=>row.order_no)),new Set(['OLD','PAID','FREE']));
    assert.equal(direct.list.find(row=>row.order_no==='OLD').can_claim,true);
    assert.equal(direct.list.find(row=>row.order_no==='OLD').payment_status,'paid');
    const intake = await app.execute('GET','/api/kf/workbench/overview',{mode:'intake',tab:'pool',size:2},session);
    assert.equal(intake.total,3); assert.equal(intake.list.length,2);
    const summary = await app.execute('GET','/api/kf/workbench/summary',{},session);
    assert.equal(summary.pool,3);
    const filtered = await app.execute('GET','/api/kf/orders/pool',{keyword:'OLD',type:'photo'},session);
    assert.equal(filtered.total,1); assert.equal(filtered.list[0].order_no,'OLD');
  }
  assert.deepEqual(store.snapshot(),before);
});

test('public pool excludes assigned, unpaid, terminal and actively reserved orders even when normalized new', async () => {
  const {store,app} = fixture();
  await store.transaction(state => {
    const pending = state.orders.find(row=>row.order_no==='OLD');
    state.orders.push({...pending,id:'ASSIGNED',order_no:'ASSIGNED',assignee_id:'s2'},
      {...pending,id:'RESERVED-OWNER',order_no:'RESERVED-OWNER',reserve_staff_id:'s2'},
      {...pending,id:'ACTIVE-HOLD',order_no:'ACTIVE-HOLD'});
    state.reserves.push({id:'r',order_no:'ACTIVE-HOLD',staff_id:'s2',status:'holding'});
  });
  const before = store.snapshot(), pool = await app.execute('GET','/api/kf/orders/pool',{},service);
  assert.deepEqual(new Set(pool.list.map(row=>row.order_no)),new Set(['OLD','PAID','FREE']));
  assert.equal((await app.execute('GET','/api/kf/workbench/summary',{},service)).pool,3);
  assert.deepEqual(store.snapshot(),before);
});
test("unpaid orders and historical orders already past claiming cannot enter through claim", async () => {
  const {store,app} = fixture(), before = store.snapshot();
  for (const no of ["UNPAID","DONE","CANCELED","REFUNDED"]) await assert.rejects(app.execute("POST",`/api/kf/orders/${no}/claim`,{expected_status:"new"},service),{code:4003});
  assert.deepEqual(store.snapshot(),before);
  for (const service_status of ["claimed","confirmed","shooting"]) {
    const f = fixture();
    await f.store.transaction(state => Object.assign(state.orders.find(row=>row.order_no==="OLD"),{service_status}));
    const snapshot=f.store.snapshot();
    await assert.rejects(f.app.execute("POST","/api/kf/orders/OLD/claim",{expected_status:service_status},service),{code:4003});
    assert.deepEqual(f.store.snapshot(),snapshot);
  }
});

test("a real paid order can be explicitly claimed once without a payment marker, callback replay or binding changes", async () => {
  const {store,app} = fixture();
  await store.transaction(state => {
    Object.assign(state.orders.find(row=>row.order_no==="OLD"),{customer_openid:"returning",svc_paid_processed:0});
    state.bindings.push({id:"1",openid:"returning",staff_id:"s2",source_order_no:"PRIOR",status:"active",expire_at:"2026-11-20 12:00:00"});
  });
  const before=store.snapshot(),old=before.orders.find(row=>row.order_no==="OLD");
  const overview=await app.execute("GET","/api/kf/workbench/overview",{},service);
  assert.equal(overview.summary.pool,3);
  assert.equal(overview.list.find(row=>row.order_no==="OLD").can_claim,true);
  assert.deepEqual(store.snapshot(),before,"ordinary reads do not admit or replay this order");
  const outcomes=await Promise.allSettled(Array.from({length:50},(_,i)=>app.execute("POST","/api/kf/orders/OLD/claim",{expected_status:"new"},i%2?{...service,authzUserId:"account-2"}:service)));
  assert.equal(outcomes.filter(row=>row.status==="fulfilled").length,1);
  for(const result of outcomes.filter(row=>row.status==="rejected")) { assert.equal(result.reason.code,4001); assert.match(result.reason.message,/客服甲/); }
  const after=store.snapshot(),claimed=after.orders.find(row=>row.order_no==="OLD");
  assert.equal(claimed.service_status,"claimed"); assert.equal(claimed.assignee_id,"s1");
  assert.equal(claimed.paid_at,old.paid_at); assert.equal(claimed.svc_paid_processed,0);
  assert.deepEqual(after.events,before.events); assert.deepEqual(after.reserves,before.reserves); assert.deepEqual(after.bindings,before.bindings); assert.deepEqual(after.bindingLogs,before.bindingLogs);
  assert.equal(after.operationLogs.filter(log=>log.order_no==="OLD"&&log.action==="claim").length,1);
  assert.equal(after.ledger.length,1); assert.equal(after.ledger[0].paid_at,old.paid_at); assert.equal(after.ledger[0].rate_bp,500); assert.equal(after.ledger[0].rule_ver,1); assert.equal(after.ledger[0].commission_fen,100);
  const restarted=createSvcWorkbench({store,clock:()=>AT});
  const mine=await restarted.execute("GET","/api/kf/orders/mine",{},service);
  assert.equal(mine.list.find(row=>row.order_no==="OLD").can_operate,true);
  assert.equal((await restarted.execute("GET","/api/kf/workbench/summary",{},service)).pending,1);
  const hidden=await restarted.execute("GET","/api/kf/orders/mine",{},{...service,authzUserId:"account-2"});
  assert.ok(!hidden.list.some(row=>row.order_no==="OLD"));
  await restarted.execute("POST","/api/kf/orders/OLD/slot/confirm",{expected_status:"claimed",new_time:"2026-11-14 15:00:00"},service);
  assert.equal(store.snapshot().orders.find(row=>row.order_no==="OLD").service_status,"confirmed");
  assert.equal(store.snapshot().orders.find(row=>row.order_no==="OLD").svc_paid_processed,0); assert.equal(store.snapshot().events.length,0);
});

test("manual admission preserves existing accounting snapshots and rolls back if the original paid time has no rule", async () => {
  const {store,app}=fixture();
  const snapshot={id:"frozen",biz_no:"OLD",beneficiary_type:"service",party_id:"s1",category:"photo",net_amount_fen:1800,rate_bp:400,rate_mode:"custom",rule_ver:7,commission_fen:72,observe_days:3,status:"est",paid_at:"2026-10-01 12:00:00",done_at:null,settle_id:null,created_at:"2026-10-01 12:00:00"};
  await store.transaction(state=>state.ledger.push({...snapshot}));
  await app.execute("POST","/api/kf/orders/OLD/claim",{expected_status:"new"},service);
  const ledger=store.snapshot().ledger[0];
  for(const key of ["net_amount_fen","rate_bp","rate_mode","rule_ver","commission_fen","observe_days","paid_at","created_at"])assert.equal(ledger[key],snapshot[key],key);
  assert.equal(store.snapshot().ledger.length,1); assert.equal(store.snapshot().events.length,0);
  const missing=fixture();
  await missing.store.transaction(state=>{state.rules=state.rules.filter(rule=>rule.ver===2);});
  const before=missing.store.snapshot();
  await assert.rejects(missing.app.execute("POST","/api/kf/orders/OLD/claim",{expected_status:"new"},service),{code:5011});
  assert.deepEqual(missing.store.snapshot(),before,"failed admission leaves no owner, log or accounting changes");
});
