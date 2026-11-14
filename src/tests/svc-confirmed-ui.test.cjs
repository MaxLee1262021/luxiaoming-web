"use strict";
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(kind,role='service_supervisor') {
  const requests=[],messages=[],confirmations=[],responses=new Map();
  const Vue={reactive:v=>v,computed:fn=>({get value(){return fn();}}),watch(){},onMounted(){},onUnmounted(){}};
  const window={LXM_HTTP:{async request(url,init={}){requests.push({url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});return {ok:true,json:async()=>({code:0,data:responses.get(url)||{list:[],total:0}})};}}};
  const ctx={state:{role,currentStaffId:'manager'},ElMessage:Object.fromEntries(['success','error','warning'].map(type=>[type,message=>messages.push({type,message})])),ElMessageBox:{async confirm(message,title,options){confirmations.push({message,title,options});}},switchMenu(){}};
  const sandbox={window,Vue,URLSearchParams,Intl,Date,setTimeout,clearTimeout,setInterval,clearInterval,navigator:{clipboard:{async writeText(){}}}};
  vm.createContext(sandbox);vm.runInContext(read('src/api/svc-'+kind+'-ui.js'),sandbox);
  const ui=kind==='workbench'?window.LXM_SVC_WORKBENCH_SETUP(ctx,'followup'):window.LXM_SVC_COMMISSION_SETUP(ctx,'staff');
  return {ui,ctx,requests,messages,confirmations,responses};
}
test('physical receipt completion requires explicit confirmation and submits server state without photographer or amount edits',async()=>{
  const f=fixture('workbench','service'), row={order_no:'PHYSICAL-1',category:'peripheral',service_status:'claimed',can_operate:true};
  f.ctx.ElMessageBox.confirm=async()=>{throw new Error('cancel');};await f.ui.kfReceipt(row);assert.equal(f.requests.length,0);
  f.ctx.ElMessageBox.confirm=async(message,title)=>f.confirmations.push({message,title});await f.ui.kfReceipt(row);
  const post=f.requests.find(r=>r.method==='POST');assert.equal(post.url,'/api/kf/orders/PHYSICAL-1/receipt/confirm');assert.deepEqual(post.body,{received:true,expected_status:'claimed'});assert.match(f.confirmations[0].message,/客户已经收到/);
  f.requests.length=0;await f.ui.kfReceipt({...row,category:'photo'});await f.ui.kfShoot(row,'finish');assert.equal(f.requests.length,0);
});
test('supervisor link action honors server delegation even when order is not personally owned',async()=>{
  const f=fixture('workbench');f.ui.kf.linkOrder={order_no:'DIRECT-1',is_mine:false,can_generate_link:true,assignee_id:'subordinate'};
  assert.equal(f.ui.kfCanGenerateLink(f.ui.kf.linkOrder),true);await f.ui.kfGenerateLink();
  assert.deepEqual(f.requests[0].body,{order_no:'DIRECT-1',no:'DIRECT-1'});
  assert.equal('staff_id' in f.requests[0].body,false,'link ownership must remain a server decision');
  f.requests.length=0;f.ui.kf.linkOrder.can_generate_link=false;await f.ui.kfGenerateLink();assert.equal(f.requests.length,0);
  assert.equal(f.ui.kfCanRejudge({can_rejudge:true}),true);assert.equal(f.ui.kfCanRejudge({can_rejudge:false}),false);
});
test('supervisor claim chooses a direct report as the beneficiary rather than silently taking the order personally',async()=>{
  const f=fixture('workbench');f.responses.set('/api/kf/staff',{list:[{id:'manager',name:'主管',is_self:true},{id:'direct',name:'直属客服',is_self:false}]});
  await f.ui.kfClaim({order_no:'POOL-1',service_status:'new',can_claim:true});assert.equal(f.ui.kf.dialog,'claim');assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
  f.ui.kf.form.staff_id='direct';await f.ui.kfSubmit();
  const post=f.requests.find(r=>r.method==='POST');assert.equal(post.url,'/api/kf/orders/POOL-1/claim');assert.deepEqual(post.body,{expected_status:'new',staff_id:'direct'});
});
test('manual personnel metadata editor preserves free text and date clearing without opening finance or global rate controls',async()=>{
  const f=fixture('commission'), row={id:'direct-staff',assessment_tags:['新员工'],rate_review_date:'2026-12-01',can_edit_profile:true};
  assert.equal(f.ui.svcCanEditProfile(row),true);assert.equal(f.ui.svcCanManage.value,false);assert.equal(f.ui.svcCanFinance.value,false);
  await f.ui.svcOpen('profile',row);f.ui.svc.form.assessment_tags.push('旺季复核');f.ui.svc.form.rate_review_date=null;f.ui.svc.form.reason='主管手工维护';
  assert.deepEqual(row.assessment_tags,['新员工']);await f.ui.svcSubmit();
  const post=f.requests.find(r=>r.method==='POST');assert.equal(post.url,'/api/svc/staff/direct-staff/profile');assert.deepEqual(post.body,{assessment_tags:['新员工','旺季复核'],rate_review_date:null,reason:'主管手工维护'});
  assert.equal(f.ui.svcCanEditProfile({can_edit_profile:false}),false);
});
test('calendar form submits shared date arrays and normalizes clear actions to empty arrays',async()=>{
  const work=fixture('workbench','super');work.ui.kf.config={holiday_dates:['2027-01-01'],workday_dates:null};work.ui.kf.configVer=7;await work.ui.kfSaveConfig();
  assert.deepEqual(work.requests.find(r=>r.method==='PUT').body,{holiday_dates:['2027-01-01'],workday_dates:[],ver:7});
  const finance=fixture('commission','super');finance.ui.svc.config={holiday_dates:null,workday_dates:['2027-01-02']};finance.ui.svc.ver=2;finance.ui.svc.configVer=7;await finance.ui.svcSaveConfig();
  assert.deepEqual(finance.requests.find(r=>r.method==='POST').body.config,{holiday_dates:[],workday_dates:['2027-01-02']});
});
test('all customer service templates compile with manual metadata, receipt and calendar controls',()=>{
  const decode=v=>v.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&apos;',"'");
  const document={createElement(){return {set innerHTML(v){this.textContent=decode(v);this.children=[{getAttribute:()=>decode(v.match(/^<div foo="([\s\S]*)">$/)?.[1] || v)}];},textContent:'',children:[]};}};
  const sandbox={window:{},document,console:{info(){},warn(){},log(){}}};vm.createContext(sandbox);vm.runInContext(read('public/vendor/vue.global.js'),sandbox);
  for(const slug of fs.readdirSync(path.join(root,'src/views/service'))) {
    const file=`src/views/service/${slug}/${slug}.html`;if(!fs.existsSync(path.join(root,file)))continue;
    const errors=[];sandbox.Vue.compile(read(file),{onError:error=>errors.push(error.message)});assert.deepEqual(errors,[],slug);
  }
});
