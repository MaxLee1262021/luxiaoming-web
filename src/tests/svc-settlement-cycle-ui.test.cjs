"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'src/api/svc-commission-ui.js'),'utf8');
function fixture(){const requests=[],control={fail:false},Vue={reactive:v=>v,computed:fn=>({get value(){return fn();}}),watch(){},onMounted(){},onUnmounted(){}};
 const window={LXM_HTTP:{async request(url,init={}){requests.push({url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});return{ok:true,json:async()=>control.fail?{code:4014,msg:'保存失败，请稍后重试'}:{code:0,data:{id:'saved',list:[],total:0}}};}}};
 const ctx={state:{role:'super',active:'svcStaffNew'},ElMessage:{success(){},error(){},warning(){}},ElMessageBox:{async confirm(){}}};
 vm.runInNewContext(source,{window,Vue,URLSearchParams,Intl,Date,setTimeout,clearTimeout});return{ui:window.LXM_SVC_COMMISSION_SETUP(ctx,'new'),ctx,requests,control};}
test('new staff cycle defaults and reset match the four screenshot choices in order',()=>{
 const f=fixture();assert.deepEqual(Array.from(f.ui.svcSettlementCycles),['月结','半月结','周结','隔天结']);assert.equal(f.ui.svc.form.settlement_cycle,'月结');
 f.ui.svc.form.settlement_cycle='周结';f.ui.svcResetNew();assert.equal(f.ui.svc.form.settlement_cycle,'月结');
 const html=fs.readFileSync(path.join(root,'src/views/service/new-staff/new-staff.html'),'utf8');assert.match(html,/<el-select v-model="svc\.form\.settlement_cycle"/);assert.doesNotMatch(html,/<el-input model-value="月结" readonly/);
});
test('selected cycle is submitted once and a failed save preserves the form selection',async()=>{
 const f=fixture();Object.assign(f.ui.svc.form,{name:'新客服',phone:'13900000000',joined_at:'2026-11-13',settlement_cycle:'隔天结',account:'service-new',password:'Service123'});f.control.fail=true;
 await f.ui.svcSubmit();assert.equal(f.ctx.state.active,'svcStaffNew');assert.equal(f.ui.svc.form.settlement_cycle,'隔天结');assert.equal(f.requests[0].body.settlement_cycle,'隔天结');
 f.control.fail=false;await f.ui.svcSubmit();assert.equal(f.requests.filter(row=>row.method==='POST').length,2);assert.equal(f.requests.filter(row=>row.method==='POST')[1].body.settlement_cycle,'隔天结');assert.equal(f.ctx.state.active,'svcStaff');
 assert.match(f.ui.svcTiming({settlement_cycle:'周结',timing:{link_valid_days:7,observe_days:7,cycle:'月结'}}),/周结$/);
});
