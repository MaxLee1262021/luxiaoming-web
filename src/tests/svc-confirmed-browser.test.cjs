"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createSvcMemoryStore}=require('../../server/lib/svcStore.cjs');
const benefit=require('../../server/lib/svcCommission.cjs');
const {createSvcWorkbench}=require('../../server/lib/svcWorkbench.cjs');
const {startBrowserFixture}=require('../../server/tests/fixtures/merchant-share-browser.cjs');
test('browser records receipt without a photographer and persists manual staff metadata',{skip:process.env.RUN_SVC_BROWSER!=='1',timeout:90000},async t=>{
 const clock=()=>new Date('2026-11-11T10:00:00+08:00'), store=createSvcMemoryStore({
   staff:[{id:'qa-s1',account_id:'qa-super',name:'测试客服',phone:'13800000001',base_salary:3500,joined_at:'2026-01-01',rate_mode:'global',staff_status:'active',assessment_tags:[],rate_review_date:null}],
   configs:[{id:'1',ver:1,rebuy_on:1,protect_days:5,hold_minutes:60,quiet_start:'22:00',quiet_end:'09:00',observe_days:7,slot_remind_h:2,link_valid_days:7,eff_at:'2026-01-01 00:00:00'}],
   rules:[{id:'1',ver:1,beneficiary_type:'service',party_id:null,rule_mode:'global',rate_photo_bp:500,rate_video_bp:1000,rate_combo_bp:800,rate_peripheral_bp:1500,eff_at:'2026-01-01 00:00:00'}],
   orders:[{id:'qa-receipt',order_no:'QA-RECEIPT-001',customer_openid:'oReceiptCustomer',customer_name:'测试客户',category:'peripheral',product_name:'实物相框',net_amount_fen:20000,paid_at:'2026-11-11 09:00:00',service_status:'claimed',service_managed:true,svc_paid_processed:1,assignee_id:'qa-s1',photo_id:null}],photographers:[]
 });
 await store.transaction(state=>benefit.ensureLedger(state,state.orders[0],clock()));
 const modules={store,workbench:createSvcWorkbench({store,clock,benefit}),commission:benefit.createSvcCommission({store,clock})};
 const fixture=await startBrowserFixture({customerService:modules});
 const playwright=require(process.env.SVC_PLAYWRIGHT_MODULE||'playwright');
 const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.SVC_BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1512,height:1000},timezoneId:'Asia/Shanghai'}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 const out=path.resolve(__dirname,'../../../.codex-tmp/customer-service/confirmed-ui');fs.mkdirSync(out,{recursive:true});
 t.after(async()=>{try{await page.screenshot({path:path.join(out,'last-state.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'browser-errors.json'),JSON.stringify(errors));}finally{await browser.close();await fixture.close();}});
 await page.goto(fixture.url);await page.getByPlaceholder('账号',{exact:true}).fill(fixture.accounts.admin.account);await page.getByPlaceholder('密码',{exact:true}).fill(fixture.accounts.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByPlaceholder('账号',{exact:true}).waitFor({state:'hidden'});
 await page.locator('[data-menu-key="svcFollowup"]').click();await page.getByRole('button',{name:'登记收货完成',exact:true}).click();
 await page.locator('.el-message-box').getByRole('button',{name:'客户已收货，登记完成',exact:true}).click();await page.getByText('已登记收货完成，提成进入观察期',{exact:true}).waitFor();
 assert.equal(store.snapshot().orders[0].service_status,'done');assert.equal(store.snapshot().orders[0].photo_id,null);assert.equal(store.snapshot().ledger[0].status,'obs');assert.equal(store.snapshot().ledger[0].commission_fen,3000);
 await page.locator('[data-menu-key="svcStaff"]').click();await page.getByRole('button',{name:'标签与复核日期',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'手工标签与复核日期',exact:true});await dialog.locator('.svc-tags-editor input').fill('手工核对');await page.getByRole('option',{name:'手工核对',exact:true}).click();await dialog.locator('.el-tag').getByText('手工核对',{exact:true}).waitFor();
 await dialog.getByPlaceholder('可留空，手工选择日期').fill('2026-12-18');await dialog.getByPlaceholder('可留空，手工选择日期').press('Tab');await dialog.locator('textarea').fill('浏览器人工维护验证');await dialog.screenshot({path:path.join(out,'manual-metadata.png'),animations:'disabled'});
 await dialog.getByRole('button',{name:'提交',exact:true}).click();await page.getByText('手工标签与复核日期已保存',{exact:true}).waitFor();
 assert.deepEqual(store.snapshot().staff[0].assessment_tags,['手工核对']);assert.equal(store.snapshot().staff[0].rate_review_date,'2026-12-18');
 await page.locator('[data-menu-key="svcRules"]').click();const calendar=page.locator('.svc-calendar-fields');await calendar.getByText('申诉工作日历（超级管理员维护）',{exact:true}).waitFor();assert.equal(await calendar.getByPlaceholder('逐个选择放假日期').count(),1);assert.equal(await calendar.getByPlaceholder('逐个选择补班日期').count(),1);await calendar.screenshot({path:path.join(out,'calendar.png'),animations:'disabled'});
 assert.deepEqual(errors,[]);
});
