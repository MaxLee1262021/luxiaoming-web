"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const createStore=require("../lib/permissionStore.cjs");

function fixture(){
  const calls=[], users=Array.from({length:90},(_,i)=>({id:"u"+i,account:"account"+i,display_name:"人员"+i,role_id:"r"+i,status:"active",subject_type:"photo",subject_id:"PH2026"+String(i).padStart(4,"0"),password_hash:"PRIVATE_HASH"}));
  let attributes=[{user_id:"u1",path:"team",value_type:"string",value_text:"A"},{user_id:"u2",path:"team",value_type:"string",value_text:"B"}];
  const pool={async query(sql,params=[]){
    calls.push({sql,params});
    if(/FROM lxm_auth_user_attributes/.test(sql))return [attributes.filter(row=>!sql.includes("WHERE user_id=?")||row.user_id===params[0])];
    if(/FROM lxm_auth_users/.test(sql))return [sql.includes("WHERE id=?")?users.filter(row=>row.id===params[0]):users];
    if(/FROM lxm_auth_role_menus/.test(sql))return [params.flatMap(role_id=>[{role_id,menu_key:"orders"},{role_id,menu_key:"svcWorkbench"}])];
    if(/FROM lxm_auth_role_permissions/.test(sql))return [params.map(role_id=>({role_id,permission_key:"share:view"}))];
    throw Error("Unexpected SQL");
  }};
  return {store:createStore({backend:"mysql",pool,autoMigrate:false}),calls,users,setAttributes:value=>{attributes=value;}};
}
test("user listing batches all extension rows and preserves typed subject bindings without secret leakage",async()=>{
  const f=fixture();const users=await f.store.listUsers();
  assert.equal(users.length,90);assert.equal(f.calls.length,2);
  assert.equal(users[1].extra.team,"A");assert.equal(users[2].extra.team,"B");assert.equal(users[0].extra.team,undefined);
  assert.equal(users[2].extra.subjectType,"photo");assert.equal(users[2].extra.subjectId,"PH20260002");assert.equal(JSON.stringify(users).includes("PRIVATE_HASH"),false);
  f.users[1].status="disabled";f.setAttributes([{user_id:"u1",path:"team",value_type:"string",value_text:"C"}]);
  const next=await f.store.listUsers();assert.equal(next[1].status,"disabled");assert.equal(next[1].extra.team,"C");assert.equal(f.calls.length,4);
});
test("role grant listings use one parameterized query per grant kind instead of one per role",async()=>{
  const f=fixture(),ids=Array.from({length:90},(_,i)=>"r"+i);
  const menus=await f.store.getRoleMenusBatch(ids);const permissions=await f.store.getRolePermissionsBatch(ids);
  assert.equal(f.calls.length,2);assert.deepEqual(menus.r22.menuKeys,["orders","svcWorkbench"]);assert.deepEqual(permissions.r23.permissionKeys,["share:view"]);
  assert.deepEqual(f.calls[0].params,ids);assert.ok(!f.calls[0].sql.includes("r22"));
  await f.store.getRoleMenusBatch([]);await f.store.getRolePermissionsBatch([]);assert.equal(f.calls.length,2);
});
