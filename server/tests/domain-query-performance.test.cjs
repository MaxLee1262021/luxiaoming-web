"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {TABLES:PHOTO_TABLES,createPhotoStore}=require("../lib/photoStore.cjs");
const {TABLES:SVC_TABLES,createSvcStore}=require("../lib/svcStore.cjs");
const {createPhotoShareService,DEFAULT_RATES}=require("../lib/photoShare.cjs");
const {createSvcCommission}=require("../lib/svcCommission.cjs");
const AT="2026-11-11 15:00:00",PH="PH20260001",OTHER="PH20260002";
const ADMIN={kind:"admin",role:"super",account:"qa"};
function fixture(empty=false){
 const names=[...Object.values(PHOTO_TABLES),...Object.values(SVC_TABLES)].map(([name])=>name);
 const db=Object.fromEntries([...names,"lxm_orders","lxm_order_products","lxm_staff","lxm_agents","lxm_distributors","lxm_shops","lxm_userProfiles","lxm_auth_users","svc_staff_tag","photo_profile"].map(name=>[name,[]]));
 if(!empty){
  db.photo_profile=[{id:PH,name:"摄影甲",phone:"13800000001",rate_mode:"custom",status:"active"},{id:OTHER,name:"摄影乙",phone:"13800000002",rate_mode:"global",status:"ended"}];
  db.benefit_rule=[{id:"1",ver:1,beneficiary_type:"photo",party_id:null,rule_mode:"global",...DEFAULT_RATES,eff_at:"2026-01-01 00:00:00"},{id:"2",ver:2,beneficiary_type:"photo",party_id:PH,rule_mode:"custom",...DEFAULT_RATES,rate_combo_bp:2200,eff_at:"2026-01-01 00:00:00",reason:"协议22%"},{id:"3",ver:3,beneficiary_type:"service",party_id:null,rule_mode:"global",...DEFAULT_RATES,rate_combo_bp:800,eff_at:"2026-01-01 00:00:00"}];
  db.svc_staff=[{id:"s1",account_id:"u1",name:"客服甲",staff_status:"active",base_salary:3000,supervisor_id:"lead"},{id:"s2",account_id:"u2",name:"客服乙",staff_status:"active",base_salary:3000},{id:"lead",account_id:"ul",name:"主管",staff_status:"active"}];
  db.svc_staff_tag=[{staff_id:"s1",tag:"接单"},{staff_id:"s1",tag:"老客"}];
  db.svc_staff_profile_log=[{id:"1",staff_id:"s1",created_at:AT,reason:"标签"}];
  db.svc_config=[{id:"1",ver:1,eff_at:"2026-01-01 00:00:00",observe_days:7},{id:"2",ver:2,eff_at:"2026-11-12 00:00:00",observe_days:8}];
  db.lxm_orders=[{id:"o1",orderNo:"LM1",photo_id:PH,photographerId:PH,service_status:"confirmed",totalAmount:2999,depositPaid:100,depositPaidAt:"2026-11-10 12:00:00",done_at:null,completedAt:null,schedule_time:AT,assignee_id:"s1",packageId:"combo",packageName:"套餐1"},{id:"o2",orderNo:"LM2",photo_id:OTHER,service_status:"done",totalAmount:699,depositPaid:200,depositPaidAt:"2026-11-09 12:00:00",completedAt:AT,assignee_id:"s2",packageName:"照片2"}];
  db.lxm_order_products=[{order_id:"o1",item_no:0,product_type:"combo",name:"套餐商品",product_id:"prod1"}];
  db.benefit_ledger=[{id:"1",biz_no:"LM1",party_id:PH,beneficiary_type:"photo",category:"combo",net_amount_fen:299900,commission_fen:65978,rate_bp:2200,rate_mode:"custom",status:"est",paid_at:"2026-11-10 12:00:00",created_at:AT},{id:"2",biz_no:"LM2",party_id:OTHER,beneficiary_type:"photo",category:"photo",net_amount_fen:69900,commission_fen:13980,rate_bp:2000,rate_mode:"global",status:"settled",settle_id:"ST-P-B",paid_at:"2026-11-09 12:00:00",done_at:AT,created_at:AT},{id:"3",biz_no:"LM1",party_id:"s1",beneficiary_type:"service",category:"combo",net_amount_fen:10000,commission_fen:800,rate_bp:800,rate_mode:"global",status:"settled",settle_id:"ST-S-A",paid_at:"2026-11-10 12:00:00",created_at:AT},{id:"4",biz_no:"LM2",party_id:"s2",beneficiary_type:"service",category:"photo",net_amount_fen:20000,commission_fen:4000,rate_bp:2000,rate_mode:"global",status:"est",paid_at:"2026-11-09 12:00:00",created_at:AT}];
  db.photo_profile_log=[{id:"1",photo_id:PH,action:"create",detail:"建档",created_at:AT},{id:"2",photo_id:OTHER,action:"settle_accept",detail:"ST-P-B：逾期未提异议",created_at:AT}];
  db.photo_settlement=[{settle_id:"ST-P-B",period:"2026-11",photo_id:OTHER,status:"accepted",amount_fen:13980,payable_fen:13980}];
  db.svc_settlement=[{settle_id:"ST-S-A",staff_id:"s1",status:"confirmed",period:"2026-11",appeal_until:"2026-11-20"}];
  db.svc_appeal=[{id:"1",staff_id:"s1",settle_id:"ST-S-A",reason:"事实"}];
  db.svc_adjust=[{id:"1",staff_id:PH,order_no:"LM1",plan_id:"photo:ledger:1",amount_fen:-65978,settle_id:null,note:"转派"},{id:"2",staff_id:"s1",order_no:"LM1",plan_id:null,amount_fen:100,settle_id:"ST-S-A"}];
 }
 const calls=[];
 const pending=(row,ids)=>ids.includes(String(row.photo_id || row.photographerId || ""))&&(["claimed","confirmed","shooting","final_pending"].includes(row.service_status)||["new","reserved"].includes(row.service_status||"new")&&["awaiting_shoot","shooting","awaiting_final_payment"].includes(row.workflowStage));
 const source={async transaction(work){return work({async query(sql,params=[]){
  calls.push({sql,params:[...params]});assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/FOR UPDATE/);
  const name=sql.match(/\bFROM\s+`?(\w+)/i)?.[1];let rows=structuredClone(db[name]||[]);
  if(/WHERE beneficiary_type='(photo|service)'/.test(sql)){const type=sql.match(/WHERE beneficiary_type='(photo|service)'/)[1];rows=rows.filter(row=>row.beneficiary_type===type);}
  if(/plan_id LIKE 'photo:%'/.test(sql))rows=rows.filter(row=>String(row.plan_id||"").startsWith("photo:"));
  if(name==="lxm_orders"&&/service_status IN/.test(sql)){
   rows=rows.filter(row=>pending(row,params));
   if(/COUNT\(\*\)/.test(sql))return [[{count:rows.length}]];
   return [rows.map(row=>({id:row.id,order_no:row.orderNo,...(sql.includes("photo_owner")?{photo_owner:row.photo_id||row.photographerId}:{}),status:row.workflowStage==="awaiting_final_payment"?"final_pending":row.service_status,schedule_time:row.schedule_time}))];
  }
  if(name==="lxm_orders"&&sql.includes("<>''"))rows=rows.filter(row=>row.photo_id||row.photographerId);
  if(name==="lxm_orders"&&sql.includes("COALESCE(deleted,0)"))rows=rows.filter(row=>!row.deleted&&!row.isDeleted);
  if(/^SELECT phone/.test(sql))return [rows.filter(row=>row.phone).map(row=>({phone:row.phone}))];
  const where=sql.split(/\bWHERE\b/i)[1]||"";let at=0;
  for(const match of where.matchAll(/\b(id|party_id|staff_id|photo_id|settle_id|orderNo|order_id)\s*(=\?|IN \((?:\?,?)+\))/g)){
   const field=match[1],size=(match[2].match(/\?/g)||[]).length,values=params.slice(at,at+size).map(String);at+=size;
   rows=rows.filter(row=>values.includes(String(row[field]))||field==="party_id"&&where.includes("party_id IS NULL")&&(row.party_id==null||row.party_id===""));
  }
  return [rows];
 }});}};
 return {db,source,calls,photoStore:createPhotoStore(source),svcStore:createSvcStore(source)};
}
function photo(f,scoped=true){const store=scoped?f.photoStore:{withState:(work,config)=>f.photoStore.withState(work,{readOnly:true})};return createPhotoShareService({store,clock:()=>AT});}
function service(f,scoped=true){const store=scoped?f.svcStore:{read:work=>f.svcStore.read(work),transaction:f.svcStore.transaction};return createSvcCommission({store,clock:()=>AT});}
test("photographer scoped reads match full financial projections including personal rules, live pending and history",async()=>{
 for(const [method,args] of [["getRules",[]],["previewRule",[{...DEFAULT_RATES,rate_peripheral_bp:1000}]],["listLedger",[{period:"2026-11",keyword:"套餐"}]],["listParties",[{}]],["listSettlements",[{}]],["mine",[{photo_id:OTHER},{kind:"admin",role:"photo",subjectId:PH}]],["exportCsv",[{},ADMIN]],["exportCsv",[{photo_id:OTHER},{kind:"admin",role:"photo",subjectId:PH},{mine:true}]]]){
  const f=fixture(),before=await photo(f,false)[method](...args),after=await photo(f)[method](...args);assert.deepEqual(after,before,method);
 }
});
test("photo GET reads do not scan unrelated accounts or notifications, and batch pending rows independent of profile count",async()=>{
 const f=fixture();await photo(f).listParties();assert.equal(f.calls.length,5);
 assert.equal(f.calls.filter(c=>c.sql.includes("AS photo_owner")).length,1);assert.ok(f.calls.every(c=>!/lxm_auth|SELECT phone|svc_notification|svc_runtime_lock/.test(c.sql)));
 f.calls.length=0;await photo(f).getRules();assert.equal(f.calls.length,3);
 f.calls.length=0;await photo(f).listSettlements();assert.equal(f.calls.length,3);
 f.calls.length=0;await photo(f).mine({photo_id:OTHER},{role:"photo",subjectId:PH});
 assert.ok(f.calls.filter(c=>/FROM (?:photo_profile|benefit_rule|benefit_ledger)/.test(c.sql)).every(c=>c.params.includes(PH)));
});
test("photo GET and mutation reads retain pending ownership while the final balance is unpaid",async()=>{
 const f=fixture();Object.assign(f.db.lxm_orders[0],{service_status:"final_pending",workflowStage:"awaiting_final_payment"});
 const selected=await f.photoStore.withState(state=>state.profiles.find(row=>row.id===PH),{readOnly:true,kind:"parties"});
 assert.equal(selected.pending_count,1);assert.equal(selected.pending_orders[0].status,"final_pending");
 const pendingQuery=f.calls.find(call=>call.sql.includes("AS photo_owner"));
 assert.match(pendingQuery.sql,/'final_pending'/);assert.match(pendingQuery.sql,/'awaiting_final_payment'/);
 const legacy=await f.photoStore.withState(state=>state.profiles.find(row=>row.id===PH),{readOnly:true});
 assert.deepEqual(selected.pending_orders,legacy.pending_orders);
 f.db.lxm_orders[0].service_status="done";f.db.lxm_orders[0].workflowStage="completed";
 const completed=await f.photoStore.withState(state=>state.profiles.find(row=>row.id===PH),{readOnly:true,kind:"parties"});
 assert.equal(completed.pending_count,0);
});

test("super photographer selected preview keeps all picker options while SQL scopes financial rows to the selection",async()=>{
 const f=fixture(),result=await photo(f).mine({photo:PH,period:"2026-11"},ADMIN);
 assert.equal(result.photographers.length,2);assert.equal(result.photo.id,PH);assert.equal(result.rows.every(row=>row.photo_id===PH),true);
 const profile=f.calls.find(c=>/FROM photo_profile\b/.test(c.sql));assert.deepEqual(profile.params,[]);
 for(const call of f.calls.filter(c=>/FROM (?:benefit_ledger|benefit_rule|svc_adjust|photo_settlement)\b/.test(c.sql)))assert.ok(call.params.includes(PH),call.sql);
 assert.ok(f.calls.every(c=>!/lxm_auth|SELECT phone|svc_notification|svc_runtime_lock/.test(c.sql)));
 const all=await photo(f).mine({period:"2026-11"},ADMIN);assert.equal(all.aggregate,true);assert.equal(all.total,2);assert.equal(all.kpi.month_fen,79958);
});
test("customer-service commission scoped GET preserves role/filter/detail and profile metadata results",async()=>{
 for(const actor of [ADMIN,{kind:"admin",role:"service",subjectId:"s1",authzUserId:"u1"},{kind:"admin",role:"service_supervisor",subjectId:"lead",authzUserId:"ul"},{kind:"admin",role:"finance",subjectId:"finance"}]){
  for(const endpoint of ["/rule","/ledger","/ledger/export","/me","/staff","/settlement","/settlement/ST-S-A","/appeal"]){
   const f=fixture(),input={period:"2026-11",size:10};
   const invoke=svc=>svc.execute("GET","/api/svc"+endpoint,input,actor).then(data=>({data}),e=>({code:e.code}));
   assert.deepEqual(await invoke(service(f)),await invoke(service(f,false)),actor.role+" "+endpoint);
  }
 }
});
test("commission empty list/settlement/profile reads use only their table groups and stay fresh",async()=>{
 const f=fixture(true);
 for(const [endpoint,count] of [["/rule",4],["/ledger",3],["/staff",5],["/settlement",2],["/appeal",2]]){
  f.calls.length=0;await service(f).execute("GET","/api/svc"+endpoint,{},ADMIN);assert.equal(f.calls.length,count,endpoint);assert.ok(f.calls.every(c=>!/svc_notification|svc_runtime_lock|svc_binding(?!_log)|svc_assign_log/.test(c.sql)));
 }
 const populated=fixture();const before=await service(populated).execute("GET","/api/svc/ledger",{},ADMIN);populated.db.benefit_ledger[2].commission_fen=900;
 const after=await service(populated).execute("GET","/api/svc/ledger",{},ADMIN);assert.equal(after.total_commission_fen,before.total_commission_fen+100);
});
