"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createSvcStore,TABLES}=require("../lib/svcStore.cjs");
const {createSvcWorkbench}=require("../lib/svcWorkbench.cjs");
const {planFor,orderScope,scopeIds}=require("../lib/svcReadStore.cjs");
const AT="2026-11-11 15:00:00";
const superSession={kind:"admin",role:"super",authzUserId:"admin"};
const serviceSession={kind:"admin",role:"service",authzUserId:"account-1"};
function fixture(empty=false){
  const db=Object.fromEntries(Object.values(TABLES).map(([table])=>[table,[]]));
  Object.assign(db,{lxm_orders:[],lxm_order_products:[],photo_profile:[],lxm_staff:[],svc_staff_tag:[]});
  if(!empty){
    db.svc_staff=[{id:"st1",account_id:"account-1",name:"本人",supervisor_id:"leader",staff_status:"active"},{id:"st2",account_id:"account-2",name:"他人",staff_status:"active"},{id:"leader",account_id:"leader-account",name:"主管",staff_status:"active"}];
    db.svc_config=[{id:"1",ver:1,eff_at:"2026-11-01 00:00:00",observe_days:7,protect_days:5}];
    const row=(id,status,staff,managed=1)=>({id,orderNo:id,openid:"openid-"+id,depositPaidAt:"2026-11-10 12:00:00",depositPaid:100,totalAmount:100,requested_time:"2026-11-12 15:00:00",schedule_time:"2026-11-11 15:00:00",service_status:status,assignee_id:staff,svc_paid_processed:managed,deleted:0,isDeleted:0});
    db.lxm_orders=[row("LM1","claimed","st1"),row("LM2","reserved",null),row("LM3","new",null),row("LM4","done","st2"),row("LM5","shooting","st1",0),row("OLD","new",null,0)];
    db.lxm_orders[1].reserve_staff_id="st1";db.lxm_orders[4].photo_id="p1";
    db.svc_payment_event=[{order_no:"LM5",paid_at:"2026-11-10 12:00:00",processed_at:AT}];
    db.lxm_order_products=[{order_id:"LM1",item_no:0,product_type:"photo",name:"照片",product_id:"prod1"},{order_id:"LM2",item_no:0,product_type:"peripheral",name:"相册",product_id:"prod2"},{order_id:"LM5",item_no:0,product_type:"video",name:"视频",product_id:"prod5"}];
    db.benefit_ledger=[{id:"1",biz_no:"LM1",party_id:"st1",beneficiary_type:"service",commission_fen:500,net_amount_fen:10000,rate_bp:500,paid_at:"2026-11-10 12:00:00",status:"est"},{id:"2",biz_no:"LM4",party_id:"st2",beneficiary_type:"service",commission_fen:2000,paid_at:"2026-11-10 12:00:00",status:"settled"},{id:"3",biz_no:"LM5",party_id:"st1",beneficiary_type:"photo",commission_fen:3000,paid_at:"2026-11-10 12:00:00",status:"est"}];
    db.svc_complaint=[{id:"1",order_no:"LM1",resp:"unknown",reason:"事实核对",rejudge_log:[],created_at:AT},{id:"2",order_no:"LM4",resp:"service",reason:"外组投诉",rejudge_log:[],created_at:AT}];
    db.svc_reserve=[{id:"1",order_no:"LM2",staff_id:"st1",status:"started",reserve_start_at:"2026-11-11 14:00:00",reserve_expire_at:"2026-11-11 15:05:00",created_at:AT}];
    db.svc_binding=[{id:"1",openid:"openid-LM1",staff_id:"st1",status:"active",expire_at:"2026-11-16 15:00:00"},{id:"2",openid:"openid-LM4",staff_id:"st2",status:"active",expire_at:"2026-11-16 15:00:00"}];
    db.svc_binding_log=[{id:"1",openid:"openid-LM1",order_no:"LM1",action:"bind",created_at:AT}];
    db.svc_assign_log=[{id:"1",order_no:"LM1",action:"assign",to_photo:"p1",created_at:AT}];
    db.photo_profile=[{id:"PH20260001",name:"新摄影师",status:"active"}];
    db.lxm_staff=[{id:"p1",name:"旧摄影师",role:"photo",status:"active"}];
  }
  const queries=[];
  const source={async transaction(work){return work({async query(sql,params=[]){
    queries.push({sql,params:[...params]});
    assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/FOR UPDATE/);
    const matches=[...sql.matchAll(/\bFROM\s+`?(\w+)`?/gi)];const name=sql.includes("FROM `lxm_orders` o")?"lxm_orders":matches.at(-1)?.[1];
    let rows=structuredClone(db[name] || []);
    if(name==="lxm_orders"){
      if(sql.includes("_svc_event_managed"))rows=rows.map(row=>({...row,_svc_event_managed:db.svc_payment_event.some(event=>event.order_no===row.orderNo)?1:0}));
      if(sql.includes("AND (COALESCE(o.svc_paid_processed,0)<>0"))rows=rows.filter(row=>row.svc_paid_processed||row._svc_event_managed||sql.includes("FROM svc_operation_log cl")&&(db.svc_operation_log||[]).some(log=>log.order_no===row.orderNo&&log.action==='claim')||row.depositDue===0||row.depositRatio===0||sql.includes("OR (COALESCE(NULLIF(o.service_status,''),'new')='new'")&&(!row.service_status||row.service_status==='new')&&![row.assignee_id,row.assigneeId,row.serviceUserId,row.reserve_staff_id].some(Boolean));
      if(sql.includes("AND (o.id=? OR o.orderNo=?)"))rows=rows.filter(row=>row.id.toLowerCase()===String(params.at(-1)).toLowerCase()||row.orderNo.toLowerCase()===String(params.at(-1)).toLowerCase());
      if(sql.includes("LOCATE(?,o.orderNo)>0"))rows=rows.filter(row=>row.orderNo.includes(params.at(-1)));
    }
    if(sql.includes("WHERE beneficiary_type='service'")){
      rows=rows.filter(row=>row.beneficiary_type==="service");
      if(sql.includes("party_id IN"))rows=rows.filter(row=>params.includes(String(row.party_id))||sql.includes(" OR biz_no IN")&&params.includes(String(row.biz_no)));
      if(sql.includes("(0=1 OR biz_no IN"))rows=rows.filter(row=>params.includes(String(row.biz_no)));
    }
    if(sql.includes("WHERE staff_id IN"))rows=rows.filter(row=>params.includes(String(row.staff_id)));
    for(const column of ["biz_no","order_no","openid","order_id"]){
      if(sql.includes("WHERE "+column+" IN"))rows=rows.filter(row=>params.includes(String(row[column])));
    }
    if(sql.includes("AND beneficiary_type='service'"))rows=rows.filter(row=>row.beneficiary_type==="service");
    if(sql.includes("AND status IN ('holding','started')"))rows=rows.filter(row=>["holding","started"].includes(row.status));
    return [rows];
  }});}};
  return {db,source,queries,store:createSvcStore(source)};
}
function app(store){return createSvcWorkbench({store,clock:()=>AT});}

test("scoped workbench reads preserve projections and role isolation against the old full snapshot",async()=>{
  const roles=[superSession,serviceSession,{kind:"admin",role:"service_supervisor",authzUserId:"leader-account"},{kind:"admin",role:"finance",authzUserId:"finance"}];
  const endpoints=["/api/kf/workbench/summary","/api/kf/workbench/todo","/api/kf/workbench/overview","/api/kf/orders/all","/api/kf/orders/pool","/api/kf/orders/mine","/api/kf/orders/reserved","/api/kf/complaints","/api/kf/rebuy/config","/api/kf/rebuy/bindings","/api/kf/orders/LM1","/api/kf/link/resolve"];
  for(const session of roles)for(const endpoint of endpoints){
    const f=fixture(),baseline=app({read:work=>f.store.read(work)}),optimized=app(f.store);
    const input=endpoint.endsWith("resolve")?{no:"LM4"}:{page:1,size:20};
    const expected=await baseline.execute("GET",endpoint,input,session).then(data=>({data}),error=>({code:error.code}));
    const actual=await optimized.execute("GET",endpoint,input,session).then(data=>({data}),error=>({code:error.code}));
    assert.deepEqual(actual,expected,session.role+" "+endpoint);
  }
});
test("GET plans avoid financial/audit table sweeps and still use a fresh read on each request",async()=>{
  const f=fixture(true);
  await f.store.read(state=>state,{path:"/api/kf/workbench/summary",session:superSession});
  assert.equal(f.queries.length,3,"empty summary only reads staff/orders/service ledger");
  assert.ok(f.queries.every(row=>!/(svc_appeal|svc_settlement|svc_notification|benefit_rule|FROM `svc_operation_log`)/.test(row.sql)));
  assert.match(f.queries.find(row=>row.sql.includes("_svc_event_managed")).sql,/EXISTS \(SELECT 1 FROM svc_payment_event/);
  assert.match(f.queries.find(row=>row.sql.includes("_svc_event_managed")).sql,/pe\.order_no=BINARY o\.orderNo/);
  const first=f.queries.length;
  await f.store.read(state=>state,{path:"/api/kf/workbench/summary",session:superSession});
  assert.equal(f.queries.length,first*2,"no stale state cache");
  f.queries.length=0;
  await f.store.read(state=>state,{path:"/api/kf/rebuy/config",session:superSession});assert.equal(f.queries.length,1);
  f.queries.length=0;
  await f.store.read(state=>state,{path:"/api/kf/staff",session:superSession});assert.equal(f.queries.length,1);
  f.queries.length=0;
  await f.store.read(state=>state,{path:"/api/kf/photographers",session:superSession});assert.equal(f.queries.length,2);
});

test('public pool SQL retains paid pending orders without service payment processing facts',async()=>{
  const f=fixture(),before=structuredClone(f.db);
  for(const input of [{mode:'intake',tab:'pool'},{mode:'workbench'}]){
    const result=await app(f.store).execute('GET','/api/kf/workbench/overview',input,serviceSession);
    if(input.mode==='intake'){
      assert.deepEqual(new Set(result.list.map(row=>row.order_no)),new Set(['LM3','OLD']));
      assert.equal(result.list.find(row=>row.order_no==='OLD').can_claim,true);
    }else assert.equal(result.summary.pool,2);
  }
  const sql=f.queries.find(row=>row.sql.includes('_svc_event_managed')).sql;
  assert.match(sql,/OR \(COALESCE\(NULLIF\(o\.service_status,''\),'new'\)='new'/);
  assert.deepEqual(f.db,before);assert.ok(f.queries.every(row=>/^SELECT/.test(row.sql)));
});

test('summary and pool both exclude active reservations even when the order lacks reserve ownership fields',async()=>{
  const f=fixture();f.db.svc_reserve.push({id:'active-old',order_no:'OLD',staff_id:'st2',status:'holding'});
  const summary=await app(f.store).execute('GET','/api/kf/workbench/summary',{},serviceSession);
  const pool=await app(f.store).execute('GET','/api/kf/orders/pool',{},serviceSession);
  assert.equal(summary.pool,1);assert.equal(pool.total,summary.pool);assert.equal(pool.list[0].order_no,'LM3');
  assert.ok(f.queries.some(row=>row.sql.includes('FROM `svc_reserve`')));
});

test("overview includes commission projections on visible orders independently of summary commission scope",async()=>{
  const f=fixture(),finance={kind:"admin",role:"finance",authzUserId:"unmapped-finance"};
  const result=await app(f.store).execute("GET","/api/kf/workbench/overview",{},finance);
  assert.equal(result.summary.commission_fen,0);
  assert.equal(result.list.find(row=>row.order_no==="LM1").commission_fen,500);
  const ledger=f.queries.find(row=>row.sql.includes("FROM `benefit_ledger`"));
  assert.match(ledger.sql,/beneficiary_type='service' AND \(0=1 OR biz_no IN/);
});
test("read SQL is parameterized and scoped to authenticated identity rather than caller selected staff",async()=>{
  const f=fixture();
  await f.store.read(state=>state,{path:"/api/kf/orders/mine",input:{staff_id:"st2",keyword:"' OR 1=1"},session:serviceSession});
  const orders=f.queries.find(row=>row.sql.includes("_svc_event_managed"));
  assert.match(orders.sql,/COALESCE\(NULLIF\(o.assignee_id,''\),NULLIF\(o.assigneeId,''\),o.serviceUserId\) IN \(\?\)/);
  assert.ok(orders.params.includes("st1"));assert.ok(!orders.params.includes("st2"));assert.doesNotMatch(orders.sql,/' OR 1=1/);
  assert.ok(!f.queries.some(row=>/svc_staff_tag|svc_runtime_lock/.test(row.sql)));
});
test("detail reads constrain related logs to the selected order and preserve pool detail access",async()=>{
  const f=fixture();const result=await app(f.store).execute("GET","/api/kf/orders/LM3",{},serviceSession);
  assert.equal(result.order_no,"LM3");
  const selected=f.queries.find(row=>row.sql.includes("_svc_event_managed"));
  assert.match(selected.sql,/AND \(o.id=\? OR o.orderNo=\?\)/);assert.deepEqual(selected.params.slice(-2),["LM3","LM3"]);
  for(const row of f.queries.filter(row=>/FROM `(?:svc_(?:slot_log|assign_log|adjust|receipt_log|operation_log|complaint))`/.test(row.sql))){
    assert.match(row.sql,/WHERE order_no IN \(\?\)/);assert.deepEqual(row.params,["LM3"]);
  }
});

test("exact detail preserves forbidden versus missing errors without returning foreign data",async()=>{
  for(const session of [serviceSession,{kind:"admin",role:"service",authzUserId:"unlinked"},{kind:"admin",role:"photo",subjectId:"p-unrelated"}]){
    for(const no of ["LM4","unknown","lm4"]){
      const f=fixture(),baseline=app({read:work=>f.store.read(work)}),optimized=app(f.store);
      const expected=await baseline.execute("GET","/api/kf/orders/"+no,{},session).then(data=>({data}),error=>({code:error.code}));
      const actual=await optimized.execute("GET","/api/kf/orders/"+no,{},session).then(data=>({data}),error=>({code:error.code}));
      assert.deepEqual(actual,expected,session.role+" "+no);
      assert.equal(actual.code,no==="LM4"?403:4003);assert.equal(Object.hasOwn(actual,"data"),false);
      const selected=f.queries.filter(row=>row.sql.includes("_svc_event_managed"));
      assert.equal(selected.length,1);assert.deepEqual(selected[0].params,[no,no]);
    }
  }
});
test("default reads remain complete for commission/worker callers and unsupported paths",async()=>{
  const f=fixture();const full=await f.store.read(state=>state);
  assert.equal(full.ledger.length,3);assert.equal(full.events.length,1);assert.equal(full.orders.length,6);assert.equal(full.photographers.length,2);
  assert.ok(f.queries.length>20);
  assert.equal(planFor("/api/kf/not-an-endpoint"),null);
  f.queries.length=0;await f.store.read(state=>state,{path:"/api/kf/not-an-endpoint"});assert.ok(f.queries.length>20);
});
test("scope selection keeps current owner aliases, supervisor groups and unbound identities separate",()=>{
  const f=fixture();
  assert.deepEqual(scopeIds(f.db.svc_staff,serviceSession),["st1"]);
  assert.deepEqual(scopeIds(f.db.svc_staff,{role:"service",authzUserId:"missing"}),[]);
  assert.deepEqual(scopeIds(f.db.svc_staff,{role:"service_supervisor",authzUserId:"leader-account"}),["leader","st1"]);
  assert.equal(scopeIds(f.db.svc_staff,superSession),null);
  assert.match(orderScope(f.db.svc_staff,{role:"photo",subjectId:"p1"},true).sql,/photographerId/);
});

test("scoped SQL lists load persisted transition and reservation history for residence and reflow projections", async () => {
  const f = fixture();
  f.db.svc_operation_log = [{ id: "1", order_no: "LM1", action: "claim", operator: "account-1", created_at: "2026-11-11 14:35:00" }, { id: "2", order_no: "LM3", action: "reserve_timeout", operator: "system", created_at: "2026-11-11 14:50:00" }];
  f.db.svc_reserve.push({ id: "old", order_no: "LM3", staff_id: "st1", status: "timeout", end_at: "2026-11-11 14:50:00" });
  const mine = await app(f.store).execute("GET", "/api/kf/orders/mine", {}, serviceSession);
  assert.equal(mine.list.find(row => row.order_no === "LM1").stay_minutes, 25);
  const pool = await app(f.store).execute("GET", "/api/kf/orders/pool", {}, serviceSession);
  assert.equal(pool.list.find(row => row.order_no === "LM3").reflow_count, 1);
  assert.equal(pool.list.find(row => row.order_no === "LM3").stay_minutes, 10);
  assert.ok(f.queries.some(row => /FROM `svc_operation_log`.*WHERE order_no IN/.test(row.sql)));
  assert.ok(f.queries.filter(row => row.sql.includes("FROM `svc_reserve`")).every(row => !row.sql.includes("status IN")));
  assert.ok(planFor("/api/kf/workbench/todo").keys.includes("complaints"));
});

test("a persisted explicit claim keeps an unmarked paid order in scoped mine, summary and todo without inventing payment events", async () => {
  const f=fixture();
  Object.assign(f.db.lxm_orders.find(row=>row.orderNo==='OLD'),{service_status:'claimed',assignee_id:'st1'});
  f.db.svc_operation_log=[{id:'manual',order_no:'OLD',action:'claim',staff_id:'st1',operator:'account-1',reason:'已支付订单手动接入客服流程',created_at:'2026-11-11 14:50:00'}];
  const before=structuredClone(f.db);
  const mine=await app(f.store).execute('GET','/api/kf/orders/mine',{},serviceSession);
  const admitted=mine.list.find(row=>row.order_no==='OLD');
  assert.ok(admitted);assert.equal(admitted.can_operate,true);assert.equal(admitted.svc_paid_processed,0);assert.equal(admitted.stay_minutes,10);
  const summary=await app(f.store).execute('GET','/api/kf/workbench/summary',{},serviceSession);assert.equal(summary.pending,2);
  const todo=await app(f.store).execute('GET','/api/kf/workbench/todo',{},serviceSession);assert.equal(todo.list.find(row=>row.order_no==='OLD').suggested_action,'slot_confirm');
  const scoped=await f.store.read(state=>state,{path:'/api/kf/orders/mine',input:{},session:serviceSession});assert.ok(!scoped.events.some(event=>event.order_no==='OLD'));
  const other=await app(f.store).execute('GET','/api/kf/orders/mine',{}, {kind:'admin',role:'service',authzUserId:'account-2'});assert.ok(!other.list.some(row=>row.order_no==='OLD'));
  const orderQueries=f.queries.filter(row=>row.sql.includes('_svc_event_managed'));
  assert.ok(orderQueries.every(row=>row.sql.includes("EXISTS (SELECT 1 FROM svc_operation_log cl WHERE cl.order_no=BINARY o.orderNo AND cl.action='claim')")));
  assert.deepEqual(f.db,before);assert.ok(f.queries.every(row=>/^SELECT/.test(row.sql)));
});
