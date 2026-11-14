"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{gunzipSync}=require("node:zlib");
const {sendJson,acceptsGzip}=require("../lib/apiResponse.cjs");
const value={rows:Array.from({length:600},(_,id)=>({id,name:"后台业务列表",detail:"关联关系保留完整"}))};
function response(method="GET",encoding="gzip, deflate"){
 const headers={Vary:"Origin","Cache-Control":"no-store"};
 return {req:{method,headers:{"accept-encoding":encoding}},headers,setHeader(k,v){headers[k]=v;},getHeader(k){return headers[k];},end(body){this.body=body;}};
}
test("large GET JSON uses negotiated compression without changing data, cache policy or Vary",async()=>{
 const res=response();await sendJson(res,200,value);
 assert.equal(res.headers["Content-Encoding"],"gzip");assert.equal(res.headers["Cache-Control"],"no-store");assert.equal(res.headers.Vary,"Origin, Accept-Encoding");
 assert.deepEqual(JSON.parse(gunzipSync(res.body)),value);assert.ok(res.body.length<JSON.stringify(value).length/3);
});
test("small data, writes, errors and gzip exclusions retain ordinary response contracts",async()=>{
 for(const [method,encoding,status,input] of [["POST","gzip",200,value],["GET","gzip;q=0",200,value],["GET","br",200,value],["GET","gzip",403,value],["GET","gzip",200,{ok:true}]]){
  const res=response(method,encoding);await sendJson(res,status,input);assert.equal(res.headers["Content-Encoding"],undefined);assert.deepEqual(JSON.parse(res.body),input);
 }
 assert.equal(acceptsGzip("gzip;q=0,deflate"),false);assert.equal(acceptsGzip("gzip;q=0.5"),true);
});
