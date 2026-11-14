"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/svcCommission.cjs");
const { createSvcStore, createSvcMemoryStore, TABLES: SERVICE_TABLES, projection } = require("../lib/svcStore.cjs");
const { createSvcWorkbench } = require("../lib/svcWorkbench.cjs");
const { TABLES: PHOTO_TABLES } = require("../lib/photoStore.cjs");
const AT = "2026-11-11 12:00:00";
const A = "PH20260001", B = "PH20260002";
const rates = (id,party_id,bp=2000) => ({id:String(id),ver:id,beneficiary_type:"photo",party_id,rule_mode:party_id?"custom":"global",rate_photo_bp:bp,rate_video_bp:bp,rate_combo_bp:bp,rate_peripheral_bp:800,eff_at:"2026-01-01 00:00:00",reason:"initial",operator:"test",created_at:AT});
const order = () => ({id:"o1",order_no:"LM1",photo_id:A,category:"photo",net_amount_fen:69900,paid_at:"2026-11-10 10:00:00",service_status:"done",done_at:"2026-11-11 11:00:00",customer_openid:"same-customer"});
const profile = id => ({id,name:id,status:"active",phone:id===A?"13800138001":"13800138002",agree_no:"AGREEMENT",rate_mode:"custom",dispute_days:5,wait_days:3,cycle:"monthly",created_at:AT});
function state() { return {orders:[order()],staff:[],configs:[],rules:[rates(1,null),rates(2,B,2200)],ledger:[],settlements:[],appeals:[],adjustments:[],complaints:[],photographers:[profile(A),profile(B)],assignLogs:[],notifications:[],photoLogs:[],photoSettlements:[]}; }

test("service entrypoints delegate photographer completion with no observation state", () => {
  const s=state(); s.complaints.push({order_no:"LM1",resp:"unknown",rejudge_log:[]});
  const row=C.ensureLedger(s,s.orders[0],AT,"photo");
  assert.equal(row.status,"settleable"); assert.equal(row.observe_days,0); assert.equal(row.commission_fen,13980);
  C.refreshLedger(s,AT); assert.equal(row.status,"settleable");
  s.orders[0].photo_id=B; C.transferPhoto(s,s.orders[0],A,AT);
  assert.equal(s.ledger.find(r=>r.party_id===A).commission_fen,0);
  assert.equal(s.ledger.find(r=>r.party_id===A).zero_reason,"transfer");
  assert.equal(s.ledger.find(r=>r.party_id===B).commission_fen,15378);
  assert.equal(s.ledger.find(r=>r.party_id===B).status,"settleable");
});

test("service responsibility does not zero photo remuneration; photo responsibility uses photo branches", () => {
  const s=state(); C.ensureLedger(s,s.orders[0],AT,"photo");
  C.applyComplaint(s,s.orders[0],null,"service",AT);
  assert.equal(s.ledger[0].commission_fen,13980); assert.equal(s.ledger[0].status,"settleable");
  C.applyComplaint(s,s.orders[0],"service","photo",AT);
  assert.equal(s.ledger[0].commission_fen,0); assert.equal(s.ledger[0].zero_reason,"complaint_photo");
});

test("service rejudgment restores photographer snapshot and keeps order fulfillment unchanged", () => {
  const s=state(), original=structuredClone(s.orders[0]); C.ensureLedger(s,s.orders[0],AT,"photo");
  C.applyComplaint(s,s.orders[0],null,"photo",AT); assert.equal(s.ledger[0].status,"void");
  C.applyComplaint(s,s.orders[0],"photo","user",AT);
  assert.equal(s.ledger[0].status,"settleable"); assert.equal(s.ledger[0].commission_fen,13980); assert.equal(s.ledger[0].zero_reason,null);
  assert.deepEqual(s.orders[0],original);
});

test("native service accounting never edits photo snapshots while waiting for final SQL hook", () => {
  const s=state(); const row=C.ensureLedger(s,s.orders[0],AT,"photo"); s.photoNative=true;
  const original=structuredClone(row);
  s.orders[0].photo_id=B;
  C.transferPhoto(s,s.orders[0],A,AT); C.applyComplaint(s,s.orders[0],null,"photo",AT); C.onRefund(s,s.orders[0],AT); C.refreshLedger(s,AT);
  assert.deepEqual(s.ledger,[original]); assert.deepEqual(s.adjustments,[]);
  assert.equal(C.ensureLedger(s,s.orders[0],AT,"photo"),null);
});

// Transaction contract fixture executes the real typed SQL stores and final
// photo hook. It models connection commit/rollback, not MySQL SQL semantics.
function nativeFixture({published=false,failPhotoInsert=false,cleared=false}={}) {
  let database=Object.fromEntries([...Object.values(SERVICE_TABLES),...Object.values(PHOTO_TABLES)].map(([table])=>[table,[]]));
  Object.assign(database,{lxm_orders:[{id:"o1",orderNo:"LM1",photo_id:A,photographerId:A,service_status:"confirmed",status:"assigned",packageId:"pkg",totalAmount:"699.00",depositPaidAt:"2026-11-10 10:00:00",schedule_time:"2026-11-12 10:00:00",openid:"same-customer",deleted:0,isDeleted:0}],lxm_order_products:[{order_id:"o1",product_type:"photo",name:"照片",product_id:"p1"}],lxm_staff:[],photo_profile:[profile(A),profile(B)],benefit_rule:[rates(1,null),rates(2,B,2200)],svc_assign_log:[{id:"1",order_no:"LM1",action:"assign",to_photo:A,from_photo:null,reason:"initial",channel:"phone",operator:"test",created_at:"2026-11-10 10:00:00"}]});
  for(const table of ["lxm_agents","lxm_distributors","lxm_shops","lxm_userProfiles","lxm_auth_users"]) database[table]=[];
  database.benefit_ledger=[{id:"1",biz_no:"LM1",beneficiary_type:"photo",party_id:A,category:"photo",net_amount_fen:69900,rate_bp:2000,rate_mode:"global",rule_ver:1,commission_fen:13980,observe_days:0,status:published?"settled":"est",zero_reason:null,customer_openid:"same-customer",is_rebuy:0,paid_at:"2026-11-10 10:00:00",done_at:null,settle_id:published?"ST-P-202611-"+A:null,created_at:AT,updated_at:AT}];
  if(published) database.photo_settlement=[{settle_id:"ST-P-202611-"+A,period:"2026-11",photo_id:A,item_count:1,amount_fen:13980,offset_fen:0,payable_fen:13980,status:"pushed",pushed_at:AT,dispute_until:"2026-11-18",created_at:AT}];
  if(cleared){
    database.benefit_ledger=[];database.photo_settlement=[];
    database.photo_profile_log=[{id:"1",photo_id:"*",action:"finance_reset",detail:JSON.stringify({v:1,scope:require("../lib/photoLegacyCleanup.cjs").SCOPE,cutoff_at:"2026-11-11 00:00:00",snapshot_sha256:"a".repeat(64),reset_id:"test-only-reset"}),created_at:AT}];
  }
  const statements=[];
  const pending=(db,id)=>db.lxm_orders.filter(row=>(row.photo_id||row.photographerId)===id && ["claimed","confirmed","shooting"].includes(row.service_status));
  const source={ async transaction(work) {
    const db=structuredClone(database);
    const conn={async query(sql,values=[]) {
      statements.push({sql,values:structuredClone(values)});
      if(/^SELECT id FROM svc_runtime_lock/.test(sql))return [[{id:1}]];
      if(/^SELECT COUNT\(\*\)/.test(sql))return [[{count:pending(db,values[0]).length}]];
      if(/^SELECT id,orderNo order_no/.test(sql))return [pending(db,values[0]).map(r=>({id:r.id,order_no:r.orderNo,status:r.service_status,schedule_time:r.schedule_time}))];
      const select=/^SELECT .*? FROM `?([a-zA-Z_]+)`?/.exec(sql);
      if(select)return [structuredClone(db[select[1]]||[])];
      const insert=/^INSERT INTO `?([a-zA-Z_]+)`? \(([^)]+)\)/.exec(sql);
      if(insert) {
        if(failPhotoInsert && insert[1]==="benefit_ledger")throw Object.assign(new Error("injected ledger write failure"),{code:"TEST_LEDGER_WRITE_FAILED"});
        const row=Object.fromEntries(insert[2].split(",").map((field,i)=>[field.replace(/`/g,"").trim(),values[i]]));
        (db[insert[1]]||=[]).push(row);return [{affectedRows:1,insertId:row.id}];
      }
      const update=/^UPDATE `?([a-zA-Z_]+)`? SET (.+) WHERE `?([a-zA-Z_]+)`?=\?$/.exec(sql);
      if(update) {
        const row=(db[update[1]]||[]).find(r=>String(r[update[3]])===String(values.at(-1)));
        assert.ok(row,"updated typed row exists: "+sql);
        update[2].split(",").forEach((field,i)=>{row[field.split("=")[0].replace(/`/g,"").trim()]=values[i];});return [{affectedRows:1}];
      }
      throw new Error("Unsupported SQL fixture query: "+sql);
    }};
    const result=await work(conn); database=db; return result;
  }};
  return {source,store:createSvcStore(source),snapshot:()=>structuredClone(database),statements};
}
async function transfer(fixture) { return fixture.store.transaction(async s=>{
  assert.ok(s.photographers.some(p=>p.id===B && p.status==="active"),"PH profiles are dispatch candidates");
  const o=s.orders[0];o.photo_id=B;
  s.assignLogs.push({id:"2",order_no:"LM1",action:"transfer",from_photo:A,to_photo:B,reason:"reassign",channel:"phone",zero_amount:1,operator:"test",created_at:AT});
  C.transferPhoto(s,o,A,AT);
}); }

test("native workbench commits order, transfer history and photo ledger in one transaction",async()=>{
  const f=nativeFixture();await transfer(f);const db=f.snapshot();
  assert.equal(db.lxm_orders[0].photo_id,B);assert.equal(db.lxm_orders[0].photographerId,B);assert.equal(db.svc_assign_log.length,2);
  assert.equal(db.benefit_ledger.find(r=>r.party_id===A).commission_fen,0);
  assert.equal(db.benefit_ledger.find(r=>r.party_id===B).commission_fen,15378);
  assert.equal(db.benefit_ledger.find(r=>r.party_id===B).status,"est");
});

test("native photo write failure rolls back workbench order and transfer log",async()=>{
  const f=nativeFixture({failPhotoInsert:true});const before=f.snapshot();
  await assert.rejects(transfer(f),{code:"TEST_LEDGER_WRITE_FAILED"});
  assert.deepEqual(f.snapshot(),before);
  assert.ok(f.statements.some(r=>/^UPDATE lxm_orders/.test(r.sql)),"order write was attempted before failed accounting write");
});

test("native transfer preserves pushed photo statement and creates a single photo adjustment",async()=>{
  const f=nativeFixture({published:true});const before=f.snapshot();await transfer(f);const db=f.snapshot();
  assert.deepEqual(db.photo_settlement,before.photo_settlement);
  assert.deepEqual(db.benefit_ledger.find(r=>r.party_id===A),before.benefit_ledger[0]);
  const plan=db.svc_adjust.find(r=>r.staff_id===A);assert.equal(plan.action,"void");assert.equal(plan.amount_fen,-13980);assert.match(plan.plan_id,/^photo:/);
  assert.equal(db.benefit_ledger.find(r=>r.party_id===B).commission_fen,15378);
});

async function complaintVerdict(f, from, to) {
  return f.store.transaction(s=>{
    if (!s.complaints.length) s.complaints.push({id:"1",order_no:"LM1",resp:to,description:"TEST_ONLY",rejudge_log:[],created_at:AT});
    else s.complaints[0].rejudge_log.push({from,to,reason:"TEST_ONLY rejudge",operator:"test",at:AT});
    C.applyComplaint(s,s.orders[0],from,to,AT);
  });
}
test("native shared transaction restores void photo commission when supervisor reverses responsibility",async()=>{
  const f=nativeFixture(), before=f.snapshot();
  await complaintVerdict(f,null,"photo");assert.equal(f.snapshot().benefit_ledger[0].status,"void");
  await complaintVerdict(f,"photo","user");const db=f.snapshot();
  assert.equal(db.benefit_ledger[0].commission_fen,13980);assert.equal(db.benefit_ledger[0].status,"est");
  assert.deepEqual(db.lxm_orders,before.lxm_orders);assert.equal(JSON.parse(db.svc_complaint[0].rejudge_log).at(-1).to,"user");
});
test("native reversal cancels unexecuted photo debt without changing the published statement",async()=>{
  const f=nativeFixture({published:true}), before=f.snapshot();
  await complaintVerdict(f,null,"photo");assert.equal(f.snapshot().svc_adjust.length,1);
  await complaintVerdict(f,"photo","service");const db=f.snapshot();
  assert.deepEqual(db.photo_settlement,before.photo_settlement);assert.deepEqual(db.benefit_ledger,before.benefit_ledger);
  assert.equal(db.svc_adjust.filter(r=>r.action==="cancel_offset").length,1);assert.equal(db.svc_adjust.filter(r=>r.action==="makeup").length,0);
});

test("native service transfer cannot regenerate finance cleared by the shared cutoff marker",async()=>{
  const f=nativeFixture({cleared:true});await transfer(f);const db=f.snapshot();
  assert.equal(db.lxm_orders[0].photo_id,B);assert.equal(db.svc_assign_log.length,2,"operational transfer stays available");
  assert.deepEqual(db.benefit_ledger,[]);assert.deepEqual(db.svc_adjust,[]);assert.deepEqual(db.photo_settlement,[]);
  assert.ok(!f.statements.some(row=>/^INSERT INTO benefit_ledger/.test(row.sql)),"same-connection native photo hook honors the persisted finance cutoff");
});

test("service observation worker cannot change a photographer ledger",async()=>{
  const s=state();C.ensureLedger(s,s.orders[0],AT,"photo");s.ledger[0].status="obs";
  const store=createSvcMemoryStore(s),app=createSvcWorkbench({store,clock:()=>AT});
  await app.runTasks();assert.equal(store.snapshot().ledger[0].status,"obs","photo anomalies remain owned by the photo worker");
});

test("service notification worker does not consume photographer delivery events",async()=>{
  const s=state();s.notifications=[{id:"photo-message",event_type:"photo_statement",status:"pending",attempts:0,next_attempt_at:AT},{id:"service-message",event_type:"slot_changed",status:"pending",attempts:0,next_attempt_at:AT}];
  const sent=[],store=createSvcMemoryStore(s),app=createSvcWorkbench({store,clock:()=>AT,notifier:async n=>{sent.push(n.id);}});
  await app.deliverNotifications();assert.deepEqual(sent,["service-message"]);
  assert.equal(store.snapshot().notifications.find(n=>n.id==="photo-message").status,"pending");
  assert.equal(store.snapshot().notifications.find(n=>n.id==="service-message").status,"sent");
});

test("civil SQL dates are returned as text before mysql2 host-timezone conversion",()=>{
  const settlement=projection("svc_settlement",SERVICE_TABLES.settlements[2].split(" "));
  assert.match(settlement,/DATE_FORMAT\(`appeal_until`, '%Y-%m-%d'\) AS `appeal_until`/);
  assert.match(settlement,/DATE_FORMAT\(`confirmed_at`, '%Y-%m-%d %H:%i:%s'\) AS `confirmed_at`/);
  const slot=projection("svc_slot_log",SERVICE_TABLES.slotLogs[2].split(" "));
  assert.match(slot,/DATE_FORMAT\(`from_time`/);assert.match(slot,/DATE_FORMAT\(`to_time`/);
  const orderSql=projection("lxm_orders",["requested_time","schedule_time","done_at","depositPaidAt","createdAt"]);
  for(const column of ["requested_time","schedule_time","done_at"]) assert.ok(orderSql.includes("DATE_FORMAT(`"+column+"`"));
  assert.doesNotMatch(orderSql,/DATE_FORMAT\(`(?:depositPaidAt|createdAt)`/,"legacy ISO VARCHAR facts retain their explicit timezone");
});
