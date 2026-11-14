"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const createApi=require('../lib/api.cjs');
const {qrScene}=require('../lib/merchantShare.cjs');

async function setup(t) {
  const calls=[];
  const order={id:'saved-order',orderNo:'ORDER-SAVED',openid:'actual-owner',customer:'测试客户',depositPaid:'10.00',finalPaid:'90.00',finalPaidAt:'2026-11-06T00:00:00Z',
    source:{sourceType:'original-channel'},products:[{name:'第一项'},{name:'第二项'}],paymentRecords:[{phase:'final',provider:'wechat_pay',status:'confirmed',confirmedAt:'2026-11-06T00:00:00Z'}]};
  const source={
    list:async()=>[],
    get:async(key,id)=>key==='staff' && id==='admin'?{id:'admin',account:'admin',role:'super',status:'active'}:key==='shops' && id==='m1'?{id:'m1',account:'merchant',role:'merchant',status:'active'}:key==='orders' && id===order.id?structuredClone(order):null,
    update:async(key,id,patch)=>{if(key==='orders' && id===order.id){Object.assign(order,patch);return structuredClone(order);}return null;},
    create:async(key,row)=>({...row,id:'audit'}),
  };
  const scene=qrScene('ABCDEF123456');
  const store={
    listRuleSummaries:async input=>{calls.push(['rules',input]);return{list:[],total:0};},
    listMerchants:async()=>[],
    listDetails:async input=>{calls.push(['details',input]);return{list:[],total:0,totalAmount:'0.00',sum:{positiveAmount:'0.00',reverseAmount:'0.00',netAmount:'0.00'}};},
    getQrByScene:async value=>value===scene?{id:'qr-real',merchantId:'m1',status:'ACTIVE'}:null,
    reportScan:async input=>{calls.push(['scan',input]);return{recorded:true};},
    getCsLink:async id=>id==='a'.repeat(32)?{linkId:id,staffId:'trusted-staff',wecomUserId:'actual-wecom',status:'ACTIVE',expiresAt:'2030-01-01T00:00:00Z'}:null,
    reportClick:async input=>{calls.push(['click',input]);return{click:{id:'trusted-click'}};},
    enqueuePayment:async input=>{calls.push(['enqueue',input]);return{job:{orderId:input.orderId},decision:{splitType:'T1',staffId:null,sourceReason:'NONE'},existed:false};},
    processJob:async(id,input)=>{calls.push(['process',id,input]);return{pending:true,job:{orderId:id,availableAt:'2026-11-09T00:00:00Z'}};},
  };
  const sessions={
    admin:{kind:'admin',role:'super',subjectType:'staff',subjectId:'admin',account:'admin',menuKeys:['dashboard']},
    public:{kind:'public',openid:'verified-public-user',createdAt:Date.parse('2026-11-06T00:00:00Z')},
    merchant:{kind:'admin',role:'merchant',subjectType:'merchant',subjectId:'m1',shopId:'m1',account:'merchant',menuKeys:['shareMine']},
  };
  const auth={init:async()=>{},getSession:async token=>sessions[token]&&structuredClone(sessions[token])};
  const handler=createApi(source,'json',{auth,permissionStore:null,wechatPay:{isConfigured:()=>false},shareOptions:{store,enableAt:'2026-01-01T00:00:00Z',clock:()=>new Date('2026-11-07T00:00:00Z')}});
  const server=http.createServer((req,res)=>handler(req,res,req.url.split('?')[0]));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  async function request(route,{token='admin',body}={}) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return{status:response.status,body:await response.json()};
  }
  return{request,calls,order,scene};
}

test('final contract list aliases preserve filters and require an administrative viewer',async t=>{
  const f=await setup(t);
  const rules=await f.request('/admin/share/rule/list?keyword=门店&page=2&size=10');
  assert.equal(rules.status,200);assert.equal(rules.body.code,0);
  assert.equal(f.calls.find(c=>c[0]==='rules')[1].keyword,'门店');
  const details=await f.request('/api/admin/share/detail/list?period=2026-11&splitType=T2');
  assert.equal(details.status,200);assert.equal(f.calls.find(c=>c[0]==='details'&&c[1].splitType==='T2')[1].period,'2026-11');
  assert.equal((await f.request('/admin/share/rule/list',{token:''})).status,401);
  assert.equal((await f.request('/admin/share/rule/list',{token:'public'})).status,401);
  assert.equal((await f.request('/admin/share/detail/list',{token:'merchant'})).status,403);
});

test('scan and click contract aliases use verified public identity and issued links',async t=>{
  const f=await setup(t);
  const scan=await f.request('/admin/share/scan/report',{token:'public',body:{scene:f.scene,userId:'forged',merchantId:'forged'}});
  assert.equal(scan.status,200);assert.equal(scan.body.code,0);
  const input=f.calls.find(c=>c[0]==='scan')[1];
  assert.equal(input.userId,'verified-public-user');assert.equal(input.merchantId,'m1');assert.equal(input.qrId,'qr-real');
  const click=await f.request('/admin/share/cs/click/report',{token:'public',body:{linkId:'a'.repeat(32),staffWecomId:'actual-wecom',userId:'forged',staffId:'forged'}});
  assert.equal(click.status,200);
  const event=f.calls.find(c=>c[0]==='click')[1];assert.equal(event.userId,'verified-public-user');assert.equal(event.staffId,'trusted-staff');assert.equal(event.sessionId,require('crypto').createHash('sha256').update('public').digest('hex'));
  const invalid=await f.request('/admin/share/scan/report',{token:'public',body:{scene:'FORGED'}});
  assert.equal(invalid.status,400);assert.equal(invalid.body.code,'SHARE_4002');
  assert.equal((await f.request('/admin/share/scan/report',{token:'admin',body:{scene:f.scene}})).status,401);
  assert.equal((await f.request('/admin/share/scan/report',{token:'public',body:null})).status,400);
});

test('internal snapshot requests read saved online receipt facts and cannot bypass maturity',async t=>{
  const f=await setup(t);
  const response=await f.request('/internal/share/snapshot',{body:{orderId:'saved-order',userId:'forged',goodsAmount:'999999.99',source:'SERVICE',serviceStaffId:'forged'}});
  assert.equal(response.status,200);assert.equal(response.body.data.pending,true);
  const event=f.calls.find(c=>c[0]==='enqueue')[1];
  assert.equal(event.userId,'actual-owner');assert.equal(event.paidTotal,'100.00');assert.equal(event.payTime,'2026-11-06T00:00:00Z');assert.equal(event.provider,'wechat_pay');assert.equal(event.display.productName,'第一项、第二项');
  assert.deepEqual(f.order.source,{sourceType:'original-channel'});assert.equal(f.order.shareOrderSource,undefined,'a pending preview must not masquerade as final order attribution');
  const before=f.calls.length;
  assert.equal((await f.request('/internal/share/snapshot',{token:'public',body:{orderId:'saved-order'}})).status,401);
  assert.equal((await f.request('/internal/share/snapshot',{token:'merchant',body:{orderId:'saved-order'}})).status,403);
  assert.equal(f.calls.length,before);
});
