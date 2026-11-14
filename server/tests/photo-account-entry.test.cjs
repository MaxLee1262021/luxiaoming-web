"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http");
const createApi=require("../lib/api.cjs");

test("all legacy photographer creation APIs require the transactional profile and account entry before any write",async t=>{
  const writes=[];
  const user={id:"admin-id",account:"admin",name:"管理员",status:"active",roleId:"role-super",extra:{subjectType:"staff",subjectId:"admin-id"}};
  const roles=[{id:"role-super",roleKey:"super",name:"管理员",status:"active"},{id:"role-photo",roleKey:"photo",name:"摄影师",status:"active"}];
  const deniedWrite=async(...args)=>{writes.push(args);throw Error("legacy photographer identity must not be written");};
  const permissionStore={required:true,backend:"mysql",async init(){},async getUser(){return user;},async getPolicyForUser(){return {role:roles[0],menuKeys:[]};},async listMenus(){return [];},async listRoles(){return roles;},async getRoleGrants(){return {menuKeys:[]};},async getRolePermissions(){return [];},createUser:deniedWrite,updateUser:deniedWrite,syncLegacyAccount:deniedWrite};
  const source={async get(){return null;},async list(){return [];},create:deniedWrite,update:deniedWrite};
  const auth={async init(){},async getSession(){return {kind:"admin",role:"super",account:"admin",subjectId:"admin-id",authzUserId:"admin-id"};}};
  const handler=createApi(source,"mysql",{auth,permissionStore,logger:{info(){},warn(){},error(){}}});
  const server=http.createServer((req,res)=>Promise.resolve(handler(req,res,req.url.split("?")[0])).catch(()=>{res.statusCode=500;res.end("{}");}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base="http://127.0.0.1:"+server.address().port;
  for(const [route,roleField] of [
    ["/api/permissions/users",{role:"photo"}],
    ["/api/permissions/users",{role:"role-photo"}],
    ["/api/permissions/staff",{roleKey:"photo"}],
    ["/api/collection/staff",{role:"photo"}],
    ["/api/collection/staff",{role:"photographer"}],
    ["/api/collection/staff",{roleKey:"photo"}],
  ]){
    const response=await fetch(base+route,{method:"POST",headers:{Authorization:"Bearer TEST_ONLY","Content-Type":"application/json"},body:JSON.stringify({name:"摄影师",account:"new_photo",password:"Account2026!",...roleField})});
    const body=await response.json();assert.equal(response.status,409,JSON.stringify(body));assert.equal(body.code,"PHOTO_PROFILE_REQUIRED");assert.equal(body.routeKey,"photoNew");assert.match(body.error,/同步创建登录账号/);
  }
  assert.deepEqual(writes,[],"generic staff, authentication accounts and audit rows remain untouched");
});
