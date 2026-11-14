"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const http=require("node:http");
const createApi=require("../lib/api.cjs");

test("legacy financial APIs cannot recreate or pay photographer liabilities after independent-ledger cutover",async t=>{
  const writes=[];
  const rows={staff:{admin:{id:"admin",account:"admin",role:"super",status:"active"}},
    reconciliationTransfers:{old:{id:"old",objectType:"摄影师",status:"已确",amount:123}},
    adjustmentRecords:{old:{id:"old",targetType:"photo",approvalStatus:"待审",amount:-50}}};
  const source={async get(key,id){return rows[key]?.[id] || null;},async list(key){return Object.values(rows[key] || {});},
    async create(...args){writes.push(args);throw Error("must not write old photo money");},async update(...args){writes.push(args);throw Error("must not write old photo money");}};
  const auth={async init(){},async getSession(){return {kind:"admin",role:"super",account:"admin",subjectId:"admin"};}};
  const handler=createApi(source,"json",{auth});
  const server=http.createServer((req,res)=>handler(req,res,req.url.split("?")[0]));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base="http://127.0.0.1:"+server.address().port;
  for(const [route,method,body] of [
    ["reconciliationTransfers","POST",{objectType:"photo",amount:20,orderIds:["old"]}],
    ["reconciliationTransfers/old","PUT",{payStatus:"已打"}],
    ["adjustmentRecords","POST",{targetType:"摄影",amount:-50,note:"旧冲抵"}],
    ["adjustmentRecords/old","PUT",{approvalStatus:"已审"}],
  ]){
    const res=await fetch(base+"/api/collection/"+route,{method,headers:{Authorization:"Bearer TEST_ONLY", "Content-Type":"application/json"},body:JSON.stringify(body)});
    const output=await res.json();assert.equal(res.status,409,JSON.stringify(output));assert.match(output.error,/摄影师/);
  }
  assert.deepEqual(writes,[]);
});
