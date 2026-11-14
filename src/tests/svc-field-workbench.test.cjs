"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('workbench retains original admin components and all DEMO business field labels',()=>{
 const source=fs.readFileSync(path.join(root,'src/views/service/workbench/workbench.html'),'utf8');
 assert.match(source,/<h2>\{\{ kfTitle \}\}<\/h2>/);assert.match(source,/<el-drawer[^>]*size="720px"/);assert.match(source,/<el-table/);assert.doesNotMatch(source,/class="kf-table"|class="kf-btn/);
 for(const label of ['待认领新单','待确认时间','待派单','拍摄中待跟进','待处理客诉','本月预估分成','今日拍摄','复购预占','优先级','客户 OpenID','客户 / 商品','停留时长','建议动作','实收','来源 / 归属','拍摄时间','完成时间','分成金额','对提成','选择周边商品','发给哪位客户 · 粘贴订单号 *','关联订单','问题描述','改判为','改判原因','时间','客服','金额','说明','预约提醒','复购来源','回流记录','订单净额','该类目比例','我的提成','摄影师分成','毛利占比','新的拍摄日期时间','改期原因','转派给','转派原因','通知方式','确认渠道','上次服务单','剩余时间'])assert.ok(source.includes(label),'missing DEMO label '+label);
 for(const slug of ['intake','followup','complaints'])assert.equal(fs.readFileSync(path.join(root,`src/views/service/${slug}/${slug}.html`),'utf8'),source);
 const css=fs.readFileSync(path.join(root,'src/views/service/workbench/workbench.css'),'utf8');assert.match(css,/--kf-muted:#82776c/);assert.doesNotMatch(css,/#3b5bdb|--kf-tx|\.kf-btn/);
});
