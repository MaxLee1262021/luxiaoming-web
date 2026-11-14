"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {startSvcPrototypeFixture}=require('./fixtures/svc-prototype-browser.cjs');
test('existing admin style is restored while customer-service demo fields remain complete',{skip:process.env.RUN_SVC_BROWSER!=='1',timeout:90000},async t=>{
 const playwright=require(process.env.SVC_PLAYWRIGHT_MODULE||'playwright'),fixture=await startSvcPrototypeFixture(),browser=await playwright.chromium.launch({headless:true,executablePath:process.env.SVC_BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1512,height:1000},timezoneId:'Asia/Shanghai'}),errors=[],out=path.resolve(__dirname,'../../../.codex-tmp/customer-service-fields-20261112/verified');fs.mkdirSync(out,{recursive:true});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{fs.writeFileSync(path.join(out,'errors.json'),JSON.stringify(errors));await browser.close();await fixture.close();});
 await page.goto(fixture.url);await page.getByPlaceholder('账号',{exact:true}).fill(fixture.accounts.admin.account);await page.getByPlaceholder('密码',{exact:true}).fill(fixture.accounts.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByPlaceholder('账号',{exact:true}).waitFor({state:'hidden'});
 const labels={svcWorkbench:['待认领新单','待确认时间','待派单','拍摄中待跟进','待处理客诉','本月预估分成'],svcIntake:['订单号','客户 OpenID','客户','商品','实收','支付时间','来源 / 归属','状态','操作'],svcFollowup:['订单号','客户 OpenID','客户 / 商品','预约时间','摄影师','状态','预计提成','操作'],svcComplaints:['责任方','订单号','客户 OpenID','客户 / 商品','问题','对提成','状态'],svcRules:['类目','分成比例 %（可改）','说明','毛利告警线 %（30 ~ 90）','绑定与解绑记录'],svcLedger:['客户 OpenID','基本工资','计算依据','提成','状态'],svcSettlements:['结算单号','账期','应结金额','上期扣回','实结','状态'],svcStaff:['编号','姓名','状态','基本工资','分成比例','分成时效','主管','本月','累计','操作'],svcCreate:['姓名 *','手机号 *','承接主管','合作起始日','后台账号','链接有效期（天）','结算等待期（天）','多久结一次','开通说明'],svcMine:['本月报酬合计（含基本工资）','本月提成','基本工资合计','累计提成','客服人数','本月未结预估','待确认（观察中）','本期冲抵']};
 for(const key of Object.keys(labels)){
  const route=key==='svcCreate'?'svcStaff':key;
  await page.locator('[data-menu-key="'+route+'"]').click();let section=page.locator('[data-page-key="'+route+'"]');await section.waitFor();await section.locator('h2').first().waitFor();await page.waitForFunction(()=>!document.querySelector('.el-loading-mask'));
  if(key==='svcCreate'){
   await section.getByRole('button',{name:'新增客服',exact:true}).click();
   section=page.getByRole('dialog',{name:'新增客服',exact:true});await section.waitFor({state:'visible'});
  }
  assert.equal(await page.locator('body.svc-prototype').count(),0);assert.equal(await page.locator('.svc-prototype-nav').count(),0);await page.locator('.lxm-sidebar .lxm-brand').waitFor();
  const text=(await section.textContent()).replace(/\s+/g,' ');for(const label of labels[key])assert.ok(text.includes(label),key+' missing field '+label);
  if(key==='svcWorkbench'){
    const metrics=section.locator('.kf-metrics > div');
    assert.deepEqual(await metrics.locator(':scope > span').allTextContents(),['待认领新单','待确认时间','待派单','拍摄中待跟进','待处理客诉','本月预估分成']);
    assert.equal(await metrics.count(),6);assert.equal(await metrics.last().getAttribute('data-metric-key'),'commission_fen');
    const total=fixture.modules.store.snapshot().ledger.filter(row=>row.beneficiary_type==='service'&&row.status!=='void').reduce((sum,row)=>sum+Number(row.commission_fen),0);
    assert.equal((await metrics.last().locator('strong').innerText()).replace(/\s/g,''),(total/100).toFixed(2)+'元');
    const rectangles=await metrics.evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return{x:r.x,y:r.y,width:r.width,height:r.height,border:s.borderTopWidth,radius:s.borderTopLeftRadius};}));
    assert.equal(new Set(rectangles.map(r=>r.y)).size,1,'the six primary metrics remain in one desktop row');
    rectangles.forEach((r,i)=>{assert.equal(r.border,'1px');assert.equal(r.radius,'10px');if(i)assert.ok(r.x>rectangles[i-1].x+rectangles[i-1].width,'primary metric cards stay separate');});
    assert.equal(await section.locator('.kf-month').count(),0,'monthly amount must not be relocated below the six cards');
  }
  if(key==='svcStaff')assert.deepEqual((await section.locator('.el-table__header-wrapper').first().locator('thead th').allTextContents()).map(value=>value.trim()),['编号','姓名','状态','基本工资','分成比例','分成时效','主管','本月','累计','操作']);
  if(key==='svcRules')assert.deepEqual((await section.locator('.el-table').filter({hasText:'平台统一值'}).locator('thead th').allTextContents()).map(value=>value.trim()),['姓名','覆盖内容','平台统一值','设置原因','复核日','操作']);
  await page.screenshot({path:path.join(out,key+'.png'),animations:'disabled'});
  if(key==='svcCreate'){await section.getByRole('button',{name:'取消',exact:true}).click();await section.waitFor({state:'hidden'});}
 }
 assert.equal(await page.locator('link[href*="service-prototype.css"],script[src*="21-service-prototype.js"]').count(),0);
 await page.locator('[data-menu-key="svcWorkbench"]').click();await page.locator('.kf-metrics > div').last().click();await page.locator('[data-page-key="svcMine"] h2').waitFor();
 assert.deepEqual(errors,[]);
});
