"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createPhotoWorker}=require("../lib/photoWorker.cjs");
const {createPhotoNotifications}=require("../lib/photoNotifications.cjs");

test("photo worker serializes scans and waits for active scan on shutdown",async()=>{
  let resolve,scans=0,deliveries=0;
  const service={runTasks:async()=>{scans++;await new Promise(r=>{resolve=r;});return {alerts:[]};}};
  const worker=createPhotoWorker({transaction(){}},{service,notifications:{drain:async()=>{deliveries++;return {sent:1};}}});
  const first=worker.tick();const second=worker.tick();
  assert.equal(scans,1);
  let stopped=false; const end=worker.stop().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);resolve();
  await Promise.all([first,second,end]);assert.equal(deliveries,1);
  await worker.tick();assert.equal(scans,1);
});
test("notification delivery needs configuration; successful delivery uses recipient and stable event key",async()=>{
  let event={id:"e1",event_key:"photo_statement:ST-P-202611-PH20260001",event_type:"photo_statement",recipient_id:"PH20260001",message:"对账单已推送",attempts:0};
  const writes=[];
  const source={transaction:work=>work({query:async(sql,args)=>{
    if(sql.startsWith("SELECT"))return [event?[event]:[]];
    writes.push({sql,args}); if(sql.includes("status='sent'"))event=null;
    return [{affectedRows:1}];
  }})};
  const absent=createPhotoNotifications(source,{endpoint:""});
  assert.deepEqual(await absent.drain(),{configured:false,sent:0});assert.equal(writes.length,0);
  let request;
  const client=createPhotoNotifications(source,{endpoint:"https://notify.example.test/photo",clock:()=>new Date("2026-11-13T01:00:00Z"),transport:async(url,options)=>{request=options;return {ok:true};}});
  assert.deepEqual(await client.drain(),{configured:true,sent:1,failed:0});
  assert.equal(request.headers["Idempotency-Key"],"photo_statement:ST-P-202611-PH20260001");
  assert.equal(JSON.parse(request.body).photo_id,"PH20260001");
  assert.equal(writes.length,2);assert.match(writes[0].sql,/attempts=attempts\+1/);
  assert.match(writes[1].sql,/status='sent'/);
});
test("notification rejection stays pending with backoff; transport details never enter failure note",async()=>{
  let reads=0;const writes=[];
  const source={transaction:work=>work({query:async(sql,args)=>{
    if(sql.startsWith("SELECT"))return [reads++===0?[{id:"e",event_key:"k",event_type:"photo_payment",recipient_id:"PH20260001",message:"报酬",attempts:1}]:[]];
    writes.push({sql,args});return [{affectedRows:1}];
  }})};
  const client=createPhotoNotifications(source,{endpoint:"https://notify.example.test",clock:()=>new Date("2026-11-13T01:00:00Z"),transport:async()=>{throw Error("secret transport token");}});
  assert.deepEqual(await client.drain(),{configured:true,sent:0,failed:1});
  assert.match(writes[1].sql,/status='pending'/);
  assert.equal(writes[1].args[0],"2026-11-13 09:04:00");
  assert.equal(JSON.stringify(writes).includes("secret transport token"),false);
});
