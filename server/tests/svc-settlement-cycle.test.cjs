"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createSvcMemoryStore}=require('../lib/svcStore.cjs'),{createSvcCommission}=require('../lib/svcCommission.cjs');
const admin={kind:'admin',role:'super',authzUserId:'qa-root'},at='2026-11-13 10:00:00';
function fixture(){const store=createSvcMemoryStore({rules:[{id:'1',ver:1,beneficiary_type:'service',party_id:null,rule_mode:'global',rate_photo_bp:500,rate_video_bp:1000,rate_combo_bp:800,rate_peripheral_bp:1500,eff_at:'2026-11-01 00:00:00'}]});return{store,app:createSvcCommission({store,clock:()=>at})};}
const form=i=>({name:'周期测试'+i,phone:'1390000000'+i,joined_at:'2026-11-13',base_salary:0,rate_mode:'global'});
test('four requested settlement cycles persist with the profile and read back in timing',async()=>{
 const f=fixture();
 for(const [i,cycle]of ['月结','半月结','周结','隔天结'].entries()){
  const created=await f.app.execute('POST','/staff',{...form(i),settlement_cycle:cycle},admin);assert.equal(created.settlement_cycle,cycle);
  const restarted=createSvcCommission({store:f.store,clock:()=>at}),list=await restarted.execute('GET','/staff',{keyword:created.name},admin);
  assert.equal(list.list[0].settlement_cycle,cycle);assert.equal(list.list[0].timing.cycle,cycle);
 }
 assert.equal(f.store.snapshot().staffLogs.length,4);assert.equal(f.store.snapshot().rules.length,5);
});
test('old clients and existing profiles default to monthly, invalid choices rollback atomically',async()=>{
 const f=fixture(),created=await f.app.execute('POST','/staff',form(0),admin);assert.equal(created.settlement_cycle,'月结');
 await f.store.transaction(state=>{delete state.staff[0].settlement_cycle;});
 assert.equal((await f.app.execute('GET','/staff',{},admin)).list[0].timing.cycle,'月结');
 for(const value of ['',null,'季度结','每月',10,{},'月结 ']){const before=f.store.snapshot();await assert.rejects(f.app.execute('POST','/staff',{...form(1),settlement_cycle:value},admin),error=>error.code===4014);assert.deepEqual(f.store.snapshot(),before);}
 await assert.rejects(f.app.execute('POST','/staff',{...form(2),settlement_cycle:'周结'},{kind:'admin',role:'service'}),error=>error.code===4030);
});
