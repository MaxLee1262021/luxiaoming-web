"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),read=slug=>fs.readFileSync(path.join(root,'src/views/service',slug,slug+'.html'),'utf8');
const expected={
 rules:['当前版本','当前生效比例','类目','分成比例 %（可改）','说明','影响预估','版本','生效时间','参数','变更人','变更原因','姓名','覆盖内容','平台统一值','设置原因','复核日','操作','结算等待期（天，0 ~ 30）','链接有效期（天，1 ~ 30）','毛利告警线 %（30 ~ 90）','开关','夜间静默期 · 开始','夜间静默期 · 结束（次日）','静默期内下的复购单怎么算','绑定与解绑记录','时间','客户','触发订单','原归属','新归属','动作','原因'],
 ledger:['本月提成合计','明细行数','不计提成','涉及订单','客服姓名','类目','结算状态','关键词（订单号 / 商品 / 商家）','订单号','客户 OpenID','基本工资','商品','净额','计算依据','比例','提成','状态'],
 settlements:['结算单号','账期','笔数','应结金额','上期扣回','实结','状态','操作'],
 staff:['合作中','暂停','已终止（不隐藏）','本月提成合计','编号','姓名','状态','基本工资','分成比例','分成时效','主管','本月','累计','操作'],
 'new-staff':['姓名 *','手机号 *（全平台唯一）','承接主管','基本工资（元/月，可为 0）','合作起始日','后台账号','这个人的比例怎么定 *','链接有效期（天）','结算等待期（天）','多久结一次','开通说明（选填，建议写明为什么给他这个条件）'],
 mine:['本月报酬（含基本工资）','本月提成','基本工资','累计提成','我的比例','结算进度','订单号','客户 OpenID','类目','商品','日期','净额','计算依据','比例','我的提成','状态','搜索订单号 / 商品 / 商家']
};
test('all commission demo field names remain present in restored admin component templates',()=>{
 for(const [slug,names]of Object.entries(expected)){
  const html=read(slug);for(const name of names)assert.ok(html.includes(name),slug+' missing exact demo field: '+name);
  assert.ok(html.includes('class="svc-page"'));assert.ok(html.includes('class="svc-head"'));assert.ok(html.includes('<el-table')||slug==='new-staff');assert.doesNotMatch(html,/cs-demo|cs-phead|class="cs-card"/);
 }
 for(const name of ['编号','姓名','状态','承接主管','基本工资','分成比例','分成时效','本月分成','累计分成','版本','参数','生效时间','商品','商家','客户','净额','提成金额','链接归因'])assert.ok(read('staff').includes('label="'+name+'"'),'drawer missing: '+name);
});
function setup(mode='mine',role='service'){
 const callbacks=[],requests=[],responses=new Map(),Vue={reactive:v=>v,computed:fn=>({get value(){return fn();}}),watch(){},onMounted(fn){callbacks.push(fn);},onUnmounted(){}};
 const window={LXM_HTTP:{async request(url,init={}){requests.push({url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});return {ok:true,json:async()=>({code:0,data:responses.get(url)||{list:[],total:0}})};}}};
 const ctx={state:{role,active:'svcMine'},ElMessage:Object.fromEntries(['success','warning','error'].map(key=>[key,()=>{}])),ElMessageBox:{async confirm(){}}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/api/svc-commission-ui.js'),'utf8'),{window,Vue,URLSearchParams,Intl,Date,setTimeout,clearTimeout});
 return{ui:window.LXM_SVC_COMMISSION_SETUP(ctx,mode),callbacks,requests,responses};
}
test('personal remuneration, real rate fields and shared timing are mapped without changing settlement amount',async()=>{
 const f=setup();f.ui.svc.query.period='2026-11';f.responses.set('/api/svc/me?period=2026-11&page=1&size=20',{staff:{id:'s',name:'客服',base_salary:3500},current_rates:{photo_bp:500,video_bp:1000,combo_bp:800,peripheral_bp:1500},config:{link_valid_days:9,observe_days:6},kpi:{month_fen:12345,base_salary_fen:350000,month_remuneration_fen:362345},status_totals:{settled:12345},list:[],total:0});
 await f.ui.svcLoad();assert.equal(f.ui.svcMonthPay.value,362345);assert.equal(f.ui.svcBaseSalary.value,350000);assert.equal(f.ui.svcRateSummary(f.ui.svc.mineStaff),'照片 5.0% / 视频 10.0% / 套餐 8.0% / 周边 15.0%');assert.equal(f.ui.svcTiming({}),'链接 9 天 / 等待 6 天 / 月结');assert.equal(f.ui.svc.summary.settled,12345);assert.equal(f.requests.some(r=>r.method==='POST'),false);
});

test('super client preview loads all and selected staff data from one scoped response and clears back to all',async()=>{
 const f=setup('mine','super'); f.ui.svc.query.period='2026-11';
 const all={staff:null,staff_options:[{id:'a',name:'客服甲'},{id:'b',name:'客服乙'}],kpi:{staff_count:2,month_fen:6000,base_salary_fen:350000,month_remuneration_fen:356000},list:[{id:'1',party_id:'a'},{id:'2',party_id:'b'}],total:2,settlements:[{settle_id:'SB',staff_id:'b'}],appeals:[{id:'AB',staff_id:'b'}]};
 f.responses.set('/api/svc/me?period=2026-11&page=1&size=20',all);
 await f.ui.svcLoad(); assert.equal(f.ui.svcMinePreview.value,true); assert.equal(f.ui.svc.rows.length,2); assert.equal(f.ui.svc.staffOptions.length,2); assert.equal(f.ui.svcMonthPay.value,356000);
 f.ui.svc.query.staff='b'; f.ui.svc.query.page=3;
 f.responses.set('/api/svc/me?staff=b&period=2026-11&page=1&size=20',{...all,staff:{id:'b',name:'客服乙'},current_rates:{photo_bp:600},kpi:{month_fen:4000},list:[all.list[1]],total:1});
 await f.ui.svcLoad(true); assert.equal(f.ui.svc.mineStaff.id,'b'); assert.equal(f.ui.svc.mineStaff.rates.photo_bp,600); assert.equal(f.ui.svc.rows.length,1); assert.equal(f.ui.svc.appeals[0].id,'AB');
 f.ui.svc.query.staff=''; await f.ui.svcLoad(true); assert.equal(f.ui.svc.mineStaff,null); assert.equal(f.ui.svc.rows.length,2);
 assert.equal(f.requests.some(row=>row.url.includes('/appeal')||row.url.includes('/staff')||row.method==='POST'),false);
});

test('personal client never sends injected staff preview selection or renders another-person picker',async()=>{
 const f=setup(); f.ui.svc.query.staff='other'; await f.ui.svcLoad();
 assert.equal(f.ui.svcMinePreview.value,false); assert.equal(f.requests.length,1); assert.doesNotMatch(f.requests[0].url,/staff=/);
 assert.equal(f.ui.svc.staffOptions.length,0);
 const html=read('mine'); assert.match(html,/v-if="svcMinePreview"[^>]*class="svc-card svc-client-preview"/); assert.match(html,/!svcMinePreview && row.settle_id/);
});
