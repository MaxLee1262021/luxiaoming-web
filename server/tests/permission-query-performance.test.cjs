"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const createStore=require("../lib/permissionStore.cjs");

function fixture(){
 const calls=[];
 const menus=Array.from({length:80},(_,i)=>({id:"m"+i,menu_key:"menu"+i,parent_key:null,name:"Menu"+i,path:"/"+i,status:"active",meta_group:"后台",sort_no:i}));
 let attributes=[{menu_id:"m1",path:"meta.routeKey",ordinal:0,value_type:"string",value_text:"svcWorkbench"},{menu_id:"m2",path:"meta.label",ordinal:0,value_type:"string",value_text:"独立标签"},{menu_id:"m3",path:"meta.group",ordinal:0,value_type:"string",value_text:"工作台组"}];
 const pool={async query(sql,params=[]){
  calls.push({sql,params});
  if(/FROM lxm_auth_menu_attributes/.test(sql))return [attributes.filter(a=>!sql.includes("WHERE menu_id=?")||a.menu_id===params[0])];
  if(/FROM lxm_auth_menus/.test(sql))return [sql.includes("WHERE id=?")?menus.filter(m=>m.id===params[0]):menus];
  if(/FROM lxm_auth_roles/.test(sql))return [[{id:"r",roleKey:"service",name:"客服",status:"active"}]];
  if(/FROM lxm_auth_role_menus/.test(sql))return [[{menu_key:"menu1"},{menu_key:"menu2"}]];
  if(/FROM lxm_auth_role_permissions/.test(sql))return [[{permission_key:"share:view"}]];
  throw Error("unexpected SQL: "+sql);
 }};
 const store=createStore({backend:"mysql",pool,autoMigrate:false});
 return {store,calls,menus,setAttributes:value=>{attributes=value;}};
}
test("menu attributes are read in one batch independent of menu count and retain distinct overrides",async()=>{
 const f=fixture();const result=await f.store.listMenus();
 assert.equal(result.length,80);assert.equal(f.calls.length,2);
 assert.equal(result[1].meta.routeKey,"svcWorkbench");assert.equal(result[2].meta.label,"独立标签");assert.equal(result[3].meta.group,"工作台组");assert.equal(result[0].meta.routeKey,undefined);
 f.menus[1].status="disabled";f.setAttributes([{menu_id:"m2",path:"meta.label",ordinal:0,value_type:"string",value_text:"已即时修改"}]);
 const fresh=await f.store.listMenus();assert.equal(fresh[1].status,"disabled");assert.equal(fresh[1].meta.routeKey,undefined);assert.equal(fresh[2].meta.label,"已即时修改");assert.equal(f.calls.length,4,"no stale permission cache");
});
test("policy returns its already loaded menu snapshot for API assembly without rereading menus",async()=>{
 const f=fixture();const user={id:"u",account:"service-user",roleId:"r"};
 const result=await f.store.getPolicyForUser(user);
 assert.equal(result.menuRows.length,80);assert.equal(result.menuRows[1].meta.routeKey,"svcWorkbench");
 assert.deepEqual(result.menuKeys,["menu1","menu2"]);
 assert.deepEqual(result.rolePermissions,["share:view"]);
 assert.equal(f.calls.filter(c=>/FROM lxm_auth_menus/.test(c.sql)).length,1);
 assert.equal(f.calls.filter(c=>/FROM lxm_auth_menu_attributes/.test(c.sql)).length,1);
 f.menus[1].status="disabled";
 assert.deepEqual((await f.store.getPolicyForUser(user)).menuKeys,["menu2"],"next request observes revoked menu immediately");
});
