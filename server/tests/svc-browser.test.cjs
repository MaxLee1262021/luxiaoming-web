"use strict";
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
const {createSvcMemoryStore}=require('../lib/svcStore.cjs');
const benefit=require('../lib/svcCommission.cjs');
const {createSvcWorkbench}=require('../lib/svcWorkbench.cjs');
const {startBrowserFixture}=require('./fixtures/merchant-share-browser.cjs');
function fixtureModules() {
 const clock=()=>new Date('2026-11-11T10:00:00+08:00');
 const store=createSvcMemoryStore({staff:[{id:'qa-s1',account_id:'qa-super',name:'测试客服',phone:'13800000001',base_salary:3500,joined_at:'2026-01-01',rate_mode:'global',staff_status:'active'}],
 configs:[{id:'1',ver:1,rebuy_on:1,protect_days:5,hold_minutes:60,quiet_start:'22:00',quiet_end:'09:00',observe_days:7,slot_remind_h:2,link_valid_days:7,eff_at:'2026-01-01 00:00:00'}],
 rules:[{id:'1',ver:1,beneficiary_type:'service',party_id:null,rule_mode:'global',rate_photo_bp:400,rate_video_bp:300,rate_combo_bp:300,rate_peripheral_bp:240,eff_at:'2026-01-01 00:00:00',reason:'测试基线'}],
 orders:[{id:'qa-o1',order_no:'QA-SVC-001',customer_openid:'oTestCustomerFullOpenid1234567',customer_name:'测试客户',phone:'13800000000',category:'photo',product_name:'城市旅拍',net_amount_fen:69900,paid_at:'2026-11-11 09:00:00',service_status:'new',service_managed:true,svc_paid_processed:1,requested_time:'2026-11-12 15:00:00'},
 {id:'qa-o2',order_no:'QA-SVC-002',customer_openid:'oTestHistoricalOpenid123456789',category:'video',product_name:'视频拍摄',net_amount_fen:129900,paid_at:'2026-11-01 09:00:00',done_at:'2026-11-02 10:00:00',service_status:'done',service_managed:true,svc_paid_processed:1,assignee_id:'qa-s1',photo_id:'qa-p1'}],photographers:[{id:'qa-p1',name:'测试摄影师',status:'active'}]});
 return {store,workbench:createSvcWorkbench({store,clock,benefit}),commission:benefit.createSvcCommission({store,clock})};
}
test('customer service HTTP routes preserve authentication, integer ledger and export contract',async t=>{
 const modules=fixtureModules(), fixture=await startBrowserFixture({customerService:modules});t.after(()=>fixture.close());
 assert.equal((await fetch(fixture.url+'/api/svc/ledger')).status,401);
 const login=await fetch(fixture.url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture.accounts.admin)}).then(r=>r.json());
 const token=login.token || login.session?.token; assert.ok(token);
 const api=async(p,body)=>{const r=await fetch(fixture.url+p,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return r.json();};
 const pool=await api('/api/kf/orders/pool');assert.equal(pool.code,0);assert.equal(pool.data.total,1);
 const claimed=await api('/api/kf/orders/QA-SVC-001/claim',{expected_status:'new'});assert.equal(claimed.code,0);
 const ledger=await api('/api/svc/ledger');assert.equal(ledger.code,0);assert.equal(ledger.data.list[0].commission_fen,2796);
 const csv=await fetch(fixture.url+'/api/svc/ledger/export',{headers:{Authorization:'Bearer '+token}});assert.match(csv.headers.get('content-type'),/text\/csv/);const bytes=new Uint8Array(await csv.arrayBuffer());assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
 const invalid=await api('/api/svc/rule',{ver:1,rates:{photo_bp:-10,video_bp:300,combo_bp:300,peripheral_bp:300},reason:'invalid'});assert.equal(invalid.code,5001);
});
test('customer service real browser navigation, claim, server ledger and settlement lock',{skip:process.env.RUN_SVC_BROWSER!=='1',timeout:90000},async t=>{
 const playwright=require(process.env.SVC_PLAYWRIGHT_MODULE||'playwright'), modules=fixtureModules(), fixture=await startBrowserFixture({customerService:modules});
 await modules.store.transaction(state=>benefit.ensureLedger(state,state.orders[1],'2026-11-11 10:00:00'));
 const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.SVC_BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const out=path.resolve(__dirname,'../../../.codex-tmp/customer-service/screenshots');fs.mkdirSync(out,{recursive:true});
 const page=await browser.newPage({viewport:{width:1512,height:1000},timezoneId:'Asia/Shanghai'}), errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 t.after(async()=>{try{if(!page.isClosed()){fs.writeFileSync(path.join(out,'browser-text.txt'),await page.locator('body').innerText());fs.writeFileSync(path.join(out,'browser-errors.json'),JSON.stringify(errors));await page.screenshot({path:path.join(out,'last-state.png')}).catch(()=>{});}}finally{await browser.close();await fixture.close();}});
 await page.goto(fixture.url);await page.getByPlaceholder('账号',{exact:true}).fill(fixture.accounts.admin.account);await page.getByPlaceholder('密码',{exact:true}).fill(fixture.accounts.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByPlaceholder('账号',{exact:true}).waitFor({state:'hidden'});
 await page.locator('[data-menu-key="svcIntake"]').click();await page.getByRole('button',{name:'认领',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('已认领')||document.body.innerText.includes('认领成功')||document.body.innerText.includes('操作成功'));
 await page.locator('[data-menu-key="svcFollowup"]').click();await page.getByRole('button',{name:'QA-SVC-001',exact:true}).first().click();await page.getByText('oTestCustomerFullOpenid1234567',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'workbench-detail.png'),animations:'disabled'});await page.keyboard.press('Escape');
 assert.equal(await page.locator('[data-menu-key="svcStaffNew"]').count(),0);
 for(const [key,label] of [['svcWorkbench','工作台'],['svcIntake','订单承接'],['svcFollowup','跟进与完成'],['svcComplaints','客诉与退款'],['svcRules','分成配置'],['svcLedger','分成明细'],['svcStaff','客服列表'],['svcSettlements','结算管理'],['svcMine','客服端']]){
   // Identify the menu by its configured key; repeated labels exist for merchant/photo modules.
   await page.locator('[data-menu-key="'+key+'"]').click();
   assert.equal((await page.locator('[data-menu-key="'+key+'"] .menu-text').innerText()).trim(),label);
   const section=page.locator('section[data-page-key="'+key+'"]');await section.waitFor();await page.waitForFunction(()=>!document.querySelector('.el-loading-mask'));
   assert.equal(await section.locator('.el-alert--error').count(),0,key+' load must succeed');await section.screenshot({path:path.join(out,key+'.png'),animations:'disabled'});
   if(key==='svcStaff'){
     await section.getByRole('button',{name:'新增客服',exact:true}).click();
     const dialog=page.getByRole('dialog',{name:'新增客服',exact:true});await dialog.waitFor({state:'visible'});
     await dialog.screenshot({path:path.join(out,'svc-staff-create-modal.png'),animations:'disabled'});
     await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
   }
 }
 await page.locator('[data-menu-key="svcRules"]').click();
 await page.getByPlaceholder('填写变更原因（必填）').fill('浏览器测试调整');const photoRate=page.locator('section[data-page-key="svcRules"] .el-input-number input').first();await photoRate.fill('4.5');await photoRate.press('Tab');await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByText('已保存新版本，次日 00:00 生效',{exact:true}).waitFor();
 assert.equal(modules.store.snapshot().ledger.find(row=>row.biz_no==='QA-SVC-001').commission_fen,2796);assert.deepEqual(errors,[]);
 await page.locator('[data-menu-key="svcSettlements"]').click();
 await page.getByRole('button',{name:'生成本期草稿',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await page.locator('.el-message-box').getByRole('button',{name:'确定',exact:true}).click();await page.getByRole('button',{name:'登记发放',exact:true}).waitFor();
 assert.equal(modules.store.snapshot().settlements[0].status,'confirmed');assert.equal(modules.store.snapshot().settlements[0].amount_fen,3897);
 const locked=await page.evaluate(async id=>{const r=await window.LXM_HTTP.request('/api/svc/settlement/'+id+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return r.json();},modules.store.snapshot().settlements[0].settle_id);assert.equal(locked.code,5005);
 await page.locator('[data-menu-key="svcRules"]').click();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'rules-mobile.png'),fullPage:true});
});
module.exports={fixtureModules};
