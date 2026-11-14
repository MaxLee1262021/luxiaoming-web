"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,"../.."),read=file=>fs.readFileSync(path.join(root,file),"utf8");
const computed=fn=>({get value(){return fn();}}),plain=value=>JSON.parse(JSON.stringify(value));
function staffFixture(role="super"){
  const writes=[],notices=[],navigation=[];
  const ctx={state:{role,currentAccount:"admin",active:"staff",filters:{},editStaff:null,staffDialog:false},data:{staff:[],agents:[],distributors:[],orders:[],scans:[]},
    computed,isServerConnected:()=>true,accountPasswordError:()=>"",cityName:()=>"城市",roleName:role=>role,log(){},
    ElMessage:Object.fromEntries(["warning","error","success"].map(kind=>[kind,message=>notices.push({kind,message})])),ElMessageBox:{},
    async persistAccountToCloud(key,row){writes.push({key,row:plain(row)});return true;},async switchMenu(menu){navigation.push(menu);ctx.state.active=menu==='photoNew'?'photoParty':menu;}};
  const window={LXM_APP_PARTS:[]};vm.runInNewContext(read("src/app/10-accounts.js"),{window,console,LXM_CONFIG:{roles:{},menus:[]}});
  const ui=window.LXM_APP_PARTS[0](ctx);return {ctx,ui,writes,notices,navigation};
}
function permissionFixture(role="super"){
  const writes=[],notices=[],navigation=[];
  const ctx={state:{role,currentAccount:"admin",active:"permissions"},data:{},async switchMenu(menu){navigation.push(menu);ctx.state.active=menu==='photoNew'?'photoParty':menu;}};
  const vue={computed,reactive:value=>value,ref:value=>({value}),onMounted(){}};
  const messages=Object.fromEntries(["warning","error","success","info"].map(kind=>[kind,message=>notices.push({kind,message})]));
  const window={LXM_PAGES:{register(page){window.page=page;}},LXM_AUTH:{hasSession:()=>true},LXM_PERMISSIONS:{
    async createUser(payload){writes.push({kind:"create",payload:plain(payload)});},async updateUser(id,payload){writes.push({kind:"update",id,payload:plain(payload)});},
    async users(){return [];},async roles(){return [];}
  }};
  vm.runInNewContext(read("src/views/system/permissions/permissions.js"),{window,Vue:vue,ElementPlus:{ElMessage:messages,ElMessageBox:{}},console});
  const ui=window.page.setup(ctx);ui.roleRows.value=[{id:"role-photo",roleKey:"photo",name:"摄影师"},{id:"role-service",key:"service",name:"客服"}];
  return {ctx,ui,writes,notices,navigation};
}

test("legacy staff creation cannot create a photographer without the PH profile; explicit navigation preserves draft until chosen",async()=>{
  const f=staffFixture();f.ui.openStaff();Object.assign(f.ctx.state.editStaff,{name:"待建摄影师",account:"draft-login",phone:"13800000000",password:"Draft123!",role:"photographer"});
  const before=plain(f.ctx.state.editStaff);assert.equal(f.ui.isNewPhotoStaff.value,true);
  await f.ui.saveStaff();assert.deepEqual(f.writes,[]);assert.deepEqual(plain(f.ctx.state.editStaff),before);assert.equal(f.ctx.data.staff.length,0);assert.equal(f.ctx.state.staffDialog,true);
  assert.match(f.notices.at(-1).message,/新增摄影师/);
  await f.ui.goToPhotoCreate();assert.deepEqual(f.navigation,["photoNew"]);assert.equal(f.ctx.state.staffDialog,false);assert.equal(f.ctx.state.editStaff.password,"");assert.equal(f.ctx.state.editStaff.name,before.name);
});
test("legacy staff photo edits and ordinary staff creation continue to persist through their existing paths",async()=>{
  const f=staffFixture(),existing={id:"old-photo",name:"已有摄影师",role:"photo",account:"existing",phone:"13800000000"};f.ctx.data.staff.push(existing);
  f.ui.openStaff(existing);await f.ui.saveStaff();assert.equal(f.writes.length,1);assert.equal(f.writes[0].row.id,"old-photo");assert.equal(f.ui.isNewPhotoStaff.value,false);
  f.ui.openStaff();Object.assign(f.ctx.state.editStaff,{name:"客服",account:"service1",password:"Service123!",role:"service"});await f.ui.saveStaff();assert.equal(f.writes.length,2);assert.equal(f.writes[1].row.role,"service");
});
test("non-admins cannot navigate a generic photographer creation draft past the admin-only PH entry",async()=>{
  const f=staffFixture("finance");f.ui.openStaff();Object.assign(f.ctx.state.editStaff,{role:"photo",password:"Draft123!"});
  await f.ui.goToPhotoCreate();assert.deepEqual(f.navigation,[]);assert.equal(f.ctx.state.staffDialog,true);assert.equal(f.ctx.state.editStaff.password,"Draft123!");assert.match(f.notices.at(-1).message,/管理员/);
});
test("permissions creation resolves role IDs and redirects the photographer choice without writes or draft loss",async()=>{
  const f=permissionFixture();f.ui.openUser();Object.assign(f.ui.userForm,{name:"待建摄影师",account:"typed-name",phone:"13800000000",password:"Draft123!",role:"role-photo"});
  const before=plain(f.ui.userForm);assert.equal(f.ui.isNewPhotoUser.value,true);await f.ui.saveUser();assert.deepEqual(f.writes,[]);assert.deepEqual(plain(f.ui.userForm),before);assert.equal(f.ui.userDialog.value,true);
  await f.ui.goToPhotoCreate();assert.deepEqual(f.navigation,["photoNew"]);assert.equal(f.ui.userDialog.value,false);assert.equal(f.ui.userForm.password,"");
});
test("existing PH user editing and password reset remain available in permission management",async()=>{
  const f=permissionFixture();f.ui.openUser({id:"usr-photo",name:"已有摄影师",account:"PH20260001",role:"photo",phone:"13800000000"});
  assert.equal(f.ui.isNewPhotoUser.value,false);await f.ui.saveUser();assert.equal(f.writes.length,1);assert.equal(f.writes[0].kind,"update");assert.equal(f.writes[0].id,"usr-photo");
  f.ui.openPassword({id:"usr-photo",account:"PH20260001"});f.ui.passwordForm.password="Changed123!";await f.ui.savePassword();assert.equal(f.writes.length,2);assert.deepEqual(f.writes[1].payload,{password:"Changed123!"});
});
test("a denied route change does not close forms or erase typed credentials",async()=>{
  for(const f of [staffFixture(),permissionFixture()]){
    f.ctx.switchMenu=async()=>{};
    if(f.ui.openStaff){f.ui.openStaff();Object.assign(f.ctx.state.editStaff,{role:"photo",password:"Draft123!"});await f.ui.goToPhotoCreate();assert.equal(f.ctx.state.staffDialog,true);assert.equal(f.ctx.state.editStaff.password,"Draft123!");}
    else{f.ui.openUser();Object.assign(f.ui.userForm,{role:"photo",password:"Draft123!"});await f.ui.goToPhotoCreate();assert.equal(f.ui.userDialog.value,true);assert.equal(f.ui.userForm.password,"Draft123!");}
  }
});
test("photographer guidance is visible in both legacy dialogs and does not remove existing account editors",()=>{
  const permissions=read("src/views/system/permissions/permissions.html"),shell=read("src/layout/app-shell.js");
  assert.match(permissions,/v-if="isNewPhotoUser"/);assert.match(permissions,/@click="goToPhotoCreate"/);assert.match(permissions,/v-if="!userForm.id" label="登录密码"/);
  assert.match(shell,/v-if="isNewPhotoStaff"/);assert.match(shell,/@click="goToPhotoCreate"/);
});
