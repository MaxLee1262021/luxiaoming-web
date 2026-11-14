"use strict";
// Isolated visual/interaction fixtures, never selected by a runtime data mode.
const {createSvcMemoryStore}=require('../../lib/svcStore.cjs');
const B=require('../../lib/svcCommission.cjs');
const {createSvcWorkbench}=require('../../lib/svcWorkbench.cjs');
const {startBrowserFixture}=require('./merchant-share-browser.cjs');
async function startSvcPrototypeFixture(){
 const clock=()=>new Date('2026-11-12T10:30:00+08:00'),at='2026-11-12 10:30:00';
 const rates={rate_photo_bp:500,rate_video_bp:1000,rate_combo_bp:800,rate_peripheral_bp:1500};
 const staff=[{id:'s1',account_id:'qa-super',name:'林晓',phone:'13800000001',base_salary:3500,rate_mode:'custom',joined_at:'2026-03-15',staff_status:'active',assessment_tags:['核心客服'],rate_review_date:'2026-12-01'},
 {id:'s2',account_id:'qa-service2',name:'周珂',phone:'13800000002',base_salary:3000,rate_mode:'global',joined_at:'2026-05-20',staff_status:'active',assessment_tags:['在岗'],rate_review_date:null},
 {id:'s3',account_id:'qa-service3',name:'阿宁',phone:'13800000003',base_salary:0,rate_mode:'global',joined_at:'2026-06-18',staff_status:'paused',assessment_tags:[],rate_review_date:null}];
 const rules=[{id:'1',ver:1,beneficiary_type:'service',party_id:null,rule_mode:'global',...rates,eff_at:'2026-10-01 00:00:00',created_at:'2026-09-30 16:00:00',operator:'系统超管',reason:'正式统一比例'},
 {id:'2',ver:2,beneficiary_type:'service',party_id:'s1',rule_mode:'custom',rate_photo_bp:400,rate_video_bp:400,rate_combo_bp:400,rate_peripheral_bp:400,eff_at:'2026-10-01 00:00:00',created_at:'2026-09-30 16:20:00',operator:'系统超管',reason:'旺季专项激励'}];
 const configs=[{id:'1',ver:1,rebuy_on:1,protect_days:5,hold_minutes:60,quiet_start:'22:00',quiet_end:'09:00',observe_days:7,slot_remind_h:2,link_valid_days:7,offset_cap_bp:3000,offset_periods:3,holiday_dates:[],workday_dates:[],eff_at:'2026-10-01 00:00:00',operator:'系统超管',created_at:'2026-09-30 16:00:00'}];
 const products=['长沙city walk跟拍','橘子洲江景视频','长沙夜景双人套餐','定制实物相框'];
 const orders=Array.from({length:12},(_,i)=>({id:'qa-visual-'+i,order_no:'LM20261112-'+String(i+1).padStart(4,'0'),category:['photo','video','combo','peripheral'][i%4],product_name:products[i%4],product_id:'p'+i,
 customer_name:['张女士','李先生','王女士','赵先生'][i%4],customer_openid:'oEgLmtBTCsNsVnzW6P_z0YM7'+String(i).padStart(4,'0'),phone:'1390000'+String(i).padStart(4,'0'),merchant_name:['橘子洲 · 阿凯','太平街 · 影像小铺','五一广场 · 小白'][i%3],
 net_amount_fen:[69900,129900,159900,39900][i%4],service_net_amount_fen:[20000,30000,50000,20000][i%4],commission_basis:'paid_deposit',paid_at:i<7?'2026-11-12 09:30:00':'2026-11-01 09:00:00',
 requested_time:'2026-11-13 15:00:00',schedule_time:i>3?'2026-11-13 16:00:00':null,photo_id:i>3&&i%4!==3?'p1':null,service_status:i<2?'new':i<4?'reserved':i<6?'claimed':i===6?'confirmed':'done',assignee_id:i<4?null:i%2?'s2':'s1',reserve_staff_id:i===2||i===3?'s1':null,is_rebuy:i===2||i===3?1:0,svc_paid_processed:1,service_managed:true,source_type:'scan',done_at:i>6?'2026-11-02 10:00:00':null}));
 orders[5].service_status='shooting';orders[2].service_net_amount_fen=20000;
 const reserves=[{id:'1',order_no:orders[2].order_no,openid:orders[2].customer_openid,staff_id:'s1',source_order_no:'LM20261101-0001',paid_at:'2026-11-12 09:38:00',is_quiet:0,reserve_start_at:'2026-11-12 09:38:00',reserve_expire_at:'2026-11-12 10:38:00',status:'started',created_at:'2026-11-12 09:38:00'},
 {id:'2',order_no:orders[3].order_no,openid:orders[3].customer_openid,staff_id:'s1',source_order_no:'LM20261101-0003',paid_at:'2026-11-11 22:12:00',is_quiet:1,reserve_start_at:'2026-11-13 09:00:00',reserve_expire_at:'2026-11-13 10:00:00',status:'holding',created_at:'2026-11-11 22:12:00'}];
 const bindings=[{id:'1',openid:orders[2].customer_openid,staff_id:'s1',source_order_no:'LM20261101-0001',bound_at:'2026-11-10 12:00:00',expire_at:'2026-11-15 12:00:00',status:'active',created_at:'2026-11-10 12:00:00',updated_at:at},
 {id:'2',openid:orders[3].customer_openid,staff_id:'s1',source_order_no:'LM20261101-0003',bound_at:'2026-11-10 14:00:00',expire_at:'2026-11-15 14:00:00',status:'active',created_at:'2026-11-10 14:00:00',updated_at:at}];
 const store=createSvcMemoryStore({staff,rules,configs,orders,reserves,bindings,photographers:[{id:'p1',name:'阿凯',status:'active'},{id:'p2',name:'小白',status:'active'}]});
 await store.transaction(state=>{for(const order of state.orders)if(order.assignee_id)B.ensureLedger(state,order,clock());const zero=state.ledger.at(-1);zero.status='void';zero.zero_reason='complaint_service';state.complaints.push({id:'1',order_no:zero.biz_no,resp:'service',reason:'沟通信息未核对，已受理客户售后',effect:'void',rejudge_log:[],created_at:at});});
 const modules={store,workbench:createSvcWorkbench({store,clock,benefit:B,linkProvider:async({order})=>({path:'pages/index/index?order_no='+order.order_no})}),commission:B.createSvcCommission({store,clock})};
 const fixture=await startBrowserFixture({customerService:modules});return {...fixture,modules};
}
module.exports={startSvcPrototypeFixture};
