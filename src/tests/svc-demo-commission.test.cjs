"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../api/svc-commission-ui.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function setup(mode='ledger',role='super') {
 const requests=[],responses=new Map(),messages=[],mounted=[];
 const Vue={reactive:value=>value,computed:fn=>({get value(){return fn();}}),watch(){},onMounted(fn){mounted.push(fn);},onUnmounted(){}};
 const window={LXM_HTTP:{async request(url,init={}){requests.push({url,body:init.body?JSON.parse(init.body):null,method:init.method || 'GET'});return {ok:true,json:async()=>({code:0,data:responses.get(url)||{list:[],total:0}})};}}};
 const ctx={state:{role,active:mode},ElMessage:Object.fromEntries(['success','warning','error'].map(key=>[key,text=>messages.push({key,text})])),ElMessageBox:{async confirm(){}}};
 const sandbox={window,Vue,URLSearchParams,Intl,Date,setTimeout,clearTimeout,navigator:{clipboard:{async writeText(){}}}};vm.createContext(sandbox);vm.runInContext(source,sandbox);
 const ui=window.LXM_SVC_COMMISSION_SETUP(ctx,mode);return {ui,ctx,requests,responses,messages,mounted};
}
test('ledger KPI cards use all-filter server totals while only current page remains rendered',async()=>{
 const f=setup('ledger','finance');f.ui.svc.query.period='2026-11';
 f.responses.set('/api/svc/ledger?period=2026-11&page=1&size=20',{list:[{id:'1',biz_no:'ORDER-1',party_id:'a',staff_name:'甲',commission_fen:100,status:'settleable'}],total:40,summary:{total_commission_fen:93215,row_count:40,void_count:4,order_count:39},staff_options:[{id:'a',name:'甲'},{id:'b',name:'乙'}]});
 await f.ui.svcLoad();assert.deepEqual(clone(f.ui.svcLedgerKpis.value),{amount:93215,rows:40,voidCount:4,orders:39});assert.equal(f.ui.svc.rows.length,1);assert.equal(f.ui.svc.staffOptions.length,2);
 assert.equal(f.requests.some(r=>r.url.startsWith('/api/svc/staff')),false,'finance ledger must not request forbidden personnel page');
});
test('batch UI cannot select estimated, void or already assigned rows',()=>{
 const f=setup(),rows=[{id:'open',status:'settleable',commission_fen:231},{id:'obs',status:'obs',commission_fen:999},{id:'void',status:'void',commission_fen:888},{id:'assigned',status:'settleable',settle_id:'S',commission_fen:777}];
 f.ui.svc.rows=rows;f.ui.svcToggleAll(true);assert.deepEqual(clone(f.ui.svc.selected),[rows[0]]);assert.equal(f.ui.svcSelectedTotal.value,231);
 f.ui.svcToggleRow(rows[1],true);f.ui.svcToggleRow(rows[3],true);assert.equal(f.ui.svc.selected.length,1);f.ui.svcToggleRow(rows[0],false);assert.equal(f.ui.svc.selected.length,0);
});
test('staff drawer saves all four ratios through version endpoint and requires reason',async()=>{
 const f=setup('staff');f.responses.set('/api/svc/rule',{versions:[{id:'old',party_id:'a',ver:2,rule_mode:'custom',rate_photo_bp:400,rate_video_bp:500,rate_combo_bp:600,rate_peripheral_bp:700}]});
 await f.ui.svcViewStaff({id:'a',name:'甲',rate_mode:'global'});assert.deepEqual(clone(f.ui.svcStaffRateForm.rates),{photo_bp:400,video_bp:500,combo_bp:600,peripheral_bp:700});
 await f.ui.svcSaveDrawerRate('global');assert.equal(f.requests.filter(r=>r.method==='POST').length,0);assert.match(f.messages.at(-1).text,/原因/);
 f.ui.svcStaffRateForm.reason='活动结束，恢复统一';f.responses.set('/api/svc/staff/a/rate',{id:'new',party_id:'a',ver:3,rule_mode:'global'});await f.ui.svcSaveDrawerRate('global');
 const write=f.requests.find(r=>r.method==='POST');assert.equal(write.url,'/api/svc/staff/a/rate');assert.deepEqual(write.body,{rates:{photo_bp:400,video_bp:500,combo_bp:600,peripheral_bp:700},rate_mode:'global',reason:'活动结束，恢复统一'});
 assert.equal(f.ui.svc.rules.versions[0].ver,3);
});
test('global version list excludes personal versions and rule summary never rewrites stored values',()=>{
 const f=setup('rules');f.ui.svc.rules.versions=[{ver:1,party_id:null},{ver:2,party_id:'a'}];assert.deepEqual(clone(f.ui.svcVersions.value),[{ver:1,party_id:null}]);
 const row={rates:{rate_photo_bp:500,rate_video_bp:1000,rate_combo_bp:800,rate_peripheral_bp:1500}},before=clone(row);assert.equal(f.ui.svcRateSummary(row),'照片 5.0% / 视频 10.0% / 套餐 8.0% / 周边 15.0%');assert.deepEqual(row,before);assert.equal(f.ui.svcSalary(350000),'¥3500/月');
});
test('dedicated new staff page submits the entered profile once and returns to personnel list',async()=>{
 const f=setup('new');assert.equal(f.ui.svc.dialog,'staff');f.ui.svc.form.name='甲';f.ui.svc.form.phone='13800138000';f.ui.svc.form.joined_at='2026-11-12';f.ui.svc.form.account='service-new';f.ui.svc.form.password='Service123';f.responses.set('/api/svc/staff',{id:'saved'});
 await f.ui.svcSubmit();const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/svc/staff');assert.equal(posts[0].body.name,'甲');assert.equal(f.ctx.state.active,'svcStaff');
});
