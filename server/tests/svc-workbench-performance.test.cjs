"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createSvcWorkbench}=require("../lib/svcWorkbench.cjs");
const AT="2026-11-11 15:00:00";
function stateFixture(){
  const state={staff:[],reserves:[],ledger:[],orders:[],events:[],complaints:[],adjustments:[],configs:[],bindings:[],bindingLogs:[],photographers:[],slotLogs:[],assignLogs:[],receiptLogs:[],operationLogs:[],notifications:[]};
  state.staff=[{id:"lead",account_id:"account-lead",staff_status:"active",name:"主管"},{id:"mine",account_id:"account-mine",staff_status:"active",name:"本人",supervisor_id:"lead"},{id:"other",account_id:"account-other",staff_status:"active",name:"他人"}];
  const statuses=["new","reserved","claimed","confirmed","shooting","done","refunded","canceled"];
  for(let i=0;i<60;i++){
    const status=statuses[i%statuses.length],who=i%3===0?"other":"mine",no="ORDER"+String(i).padStart(4,"0");
    const order={id:"o"+i,order_no:no,service_status:status,svc_paid_processed:i===59?0:1,service_managed:false,paid_at:`2026-11-${String(i%9+1).padStart(2,"0")} 12:00:00`,schedule_time:i%2?"2026-11-11 16:00:00":"2026-11-12 16:00:00",assignee_id:status==="new"||status==="reserved"?null:who,reserve_staff_id:status==="reserved"?who:null,photo_id:i%2?"photo-own":"photo-other",depositPaid:i===58?0:100,finalPaid:0,category:i%2?"video":"photo",product_name:"商品"+i,customer_openid:"customer"+i,customer_name:"客户"+i,net_amount_fen:10000};
    state.orders.push(order);
    state.ledger.push({id:"l"+i,biz_no:no,party_id:who,beneficiary_type:"service",commission_fen:100+i,paid_at:order.paid_at,status:i%5?"est":"void",net_amount_fen:10000,rate_bp:100,rate_mode:"global"});
    if(status==="reserved")state.reserves.push({id:"r"+i,order_no:no,staff_id:who,status:i%3?"started":"holding",reserve_start_at:"2026-11-11 14:10:00",reserve_expire_at:i%3?"2026-11-11 15:05:00":"2026-11-12 10:00:00",created_at:"2026-11-11 14:10:00"});
    if(i%7===0)state.complaints.push({id:"c"+i,order_no:no,resp:"unknown",reason:"待核查",rejudge_log:[],created_at:"2026-11-11 14:00:00"});
  }
  // One unmarked historical order must remain hidden; an actual event keeps
  // its formerly sparse counterpart managed without replaying a payment.
  state.events.push({order_no:state.orders[57].order_no});
  state.orders[57].svc_paid_processed=0;
  state.ledger.push({id:"photo-ledger",beneficiary_type:"photo",party_id:"mine",biz_no:"ORDER0000",commission_fen:999999,paid_at:AT,status:"settled"});
  return state;
}
function service(state=stateFixture()){
  let reads=0,lastContext;
  const store={read:async(work,context)=>{reads++;lastContext=context;return work(state);},transaction:async()=>{throw Error("GET must not mutate");}};
  return {app:createSvcWorkbench({store,clock:()=>AT}),state,get reads(){return reads;},get context(){return lastContext;}};
}
test("one overview snapshot equals the former independent summary, todo and reservation calls for each actor scope",async()=>{
  const actors=[{role:"super"},{role:"service",authzUserId:"account-mine"},{role:"service_supervisor",authzUserId:"account-lead"},{role:"service",authzUserId:"not-linked"},{role:"finance"},{role:"photo",subjectId:"photo-own"}];
  for(const who of actors){
    const actor={kind:"admin",...who},f=service(),input={page:2,size:4,keyword:"ignored-for-todo",type:"photo"};
    const output=await f.app.execute("GET","/api/kf/workbench/overview",{...input,mode:"workbench"},actor);
    assert.equal(f.reads,1);
    const summary=await f.app.execute("GET","/api/kf/workbench/summary",{},actor);
    const todo=await f.app.execute("GET","/api/kf/workbench/todo",input,actor);
    assert.deepEqual({...output,reserved:undefined},{summary,...todo,reserved:undefined});
    const reserved=await f.app.execute("GET","/api/kf/orders/reserved",{page:1,size:100},actor);assert.deepEqual(output.reserved,reserved);
    assert.equal(f.context.path,"/api/kf/orders/reserved");assert.equal(f.context.session,actor);
  }
});
test("intake overview retains primary filters and pagination independently of the reservation strip",async()=>{
  for(const tab of ["pool","mine"]){
    const f=service(),actor={kind:"admin",role:"service",authzUserId:"account-mine"},input={mode:"intake",tab,page:2,size:2,type:"video",keyword:"商品"};
    const overview=await f.app.execute("GET","/api/kf/workbench/overview",input,actor);
    assert.equal(f.context.input,input);
    const expected=await f.app.execute("GET","/api/kf/orders/"+tab,input,actor);
    assert.deepEqual({...overview,summary:undefined,reserved:undefined},{...expected,summary:undefined,reserved:undefined});
    assert.deepEqual(overview.summary,{});
    assert.deepEqual(overview.reserved,await f.app.execute("GET","/api/kf/orders/reserved",{size:100},actor));
  }
});
test("GET presents only selected page rows and uses request indexes instead of per-row staff scans",async()=>{
  const f=service(),actor={kind:"admin",role:"service",authzUserId:"account-mine"};let presented=0,finds=0;
  const originalFind=f.state.staff.find.bind(f.state.staff);f.state.staff.find=(...args)=>{finds++;return originalFind(...args);};
  for(const order of f.state.orders)Object.defineProperty(order,"presentation_probe",{enumerable:true,get(){presented++;return "selected-row";}});
  const result=await f.app.execute("GET","/api/kf/orders/mine",{page:2,size:3},actor);
  assert.equal(result.list.length,3);assert.equal(presented,3);assert.ok(finds<=2,"staff identity is resolved once for scope and once for actor");
  presented=0;await f.app.execute("GET","/api/kf/workbench/summary",{},actor);assert.equal(presented,0);
});
test("invalid combined view parameters fail before storage and a later request sees changed state",async()=>{
  const f=service(),actor={kind:"admin",role:"super"};
  for(const input of [{mode:"unknown"},{mode:"intake",tab:"someone-else"}])await assert.rejects(f.app.execute("GET","/api/kf/workbench/overview",input,actor),{code:4014});
  assert.equal(f.reads,0);
  const before=await f.app.execute("GET","/api/kf/workbench/overview",{},actor);
  f.state.orders.find(o=>o.service_status==="new").service_status="claimed";
  const after=await f.app.execute("GET","/api/kf/workbench/overview",{},actor);
  assert.equal(after.summary.pool,before.summary.pool-1);assert.equal(after.summary.pending,before.summary.pending+1);assert.equal(f.reads,2);
});
