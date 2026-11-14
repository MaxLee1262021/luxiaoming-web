"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture(role = "super") {
  const calls = [], notices = [], listeners = {}, clipboard = [];
  const control = { handler: async () => ({ code: 0, data: { rows: [], total: 0 } }) };
  const window = { LXM_APP_PARTS: [], addEventListener: (key, fn) => { listeners[key] = fn; }, LXM_AUTH: { hasSession: () => true }, LXM_HTTP: { async request(url, init) { calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined }); const result = await control.handler(url, init); return { ok: true, status: 200, json: async () => result }; } } };
  const ctx = { state: { role, authed: true, currentAccount: "test", filters: {} }, reactive: (value) => value, computed: (read) => ({ get value() { return read(); } }), watch() {}, can: () => false, switchMenu: async (key, options) => { calls.push({ menu: key, options }); }, ElMessage: Object.fromEntries(["error", "warning", "success"].map((type) => [type, (message) => notices.push({ type, message })])), ElMessageBox: { confirm: async () => true } };
  vm.runInNewContext(source("src/app/20-photo-share.js"), { window, URL, URLSearchParams, Intl, Date, console, navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } } });
  return { ui: window.LXM_APP_PARTS[0](ctx), control, ctx, window, listeners, calls, notices, clipboard };
}

test("all six photographer templates compile with the shipped Vue runtime", () => {
  const sandbox = { window: {}, console: { ...console, info() {} } }; vm.createContext(sandbox);
  vm.runInContext(source("public/vendor/vue.global.js"), sandbox);
  for (const page of ["rules", "ledger", "settlement", "party", "new", "mine"]) assert.equal(typeof sandbox.Vue.compile(source(`src/views/photo-share/${page}/${page}.html`), { onError(error) { throw error; }, decodeEntities: (text) => text }), "function");
  const mine = source("src/views/photo-share/mine/mine.html");
  assert.equal((mine.match(/<el-button\b/g) || []).length, 1, "PH06 has only the export action");
  assert.equal((mine.slice(mine.indexOf("我的报酬明细"), mine.indexOf("我的月度对账单")).match(/<el-table-column\b/g) || []).length, 10, "super preview adds one named-photographer column");
  assert.match(mine, /v-if="photoCanPreviewMine" prop="photo_name"/);
  const ledger = source("src/views/photo-share/ledger/ledger.html");
  assert.equal((ledger.slice(0, ledger.indexOf("<el-drawer")).match(/<el-table-column\b/g) || []).length, 11);
});

test("photographer role can read only bound mine, and cannot load or mutate management data", async () => {
  const f = fixture("photo");
  await f.ui.loadPhotoRules(); await f.ui.loadPhotoParties(); await f.ui.loadPhotoLedger(); await f.ui.loadPhotoSettlements(); await f.ui.savePhotoRule(); await f.ui.savePhotoParty(); await f.ui.generatePhotoSettlements(); await f.ui.loadPhotoDispatchOptions();
  assert.equal(f.calls.length, 0);
  f.ui.photoState.mineQuery.photo_id = "other-person"; await f.ui.loadPhotoMine();
  assert.match(f.calls[0].url, /^\/api\/photo\/me\?/);
  assert.doesNotMatch(f.calls[0].url, /photo_id|other-person/);
});

test("super photographer view defaults to all data and can select one person's personal view", async () => {
  const f = fixture();
  assert.equal(f.ui.photoCanPreviewMine.value, true); assert.equal(f.ui.photoCanReadMine.value, true); assert.equal(f.ui.photoMineAll.value, true);
  const photographers = [{ id: "PH20260001", name: "阿坤" }, { id: "PH20260002", name: "老赵" }];
  f.control.handler = async url => ({ code: 0, data: { aggregate: !url.includes("photo="), photographers, photo: url.includes("photo=") ? photographers[1] : {}, kpi: { month_fen: 30000 }, rows: [{ photo_name: "老赵", biz_no: "QA-2" }], settlements: [{ photo_name: "老赵", settle_id: "QA-S2" }], total: 1 } });
  await f.ui.loadPhotoMine(); assert.doesNotMatch(f.calls.at(-1).url, /photo=/); assert.equal(f.ui.photoState.mine.photographers.length, 2); assert.equal(f.ui.photoState.mine.kpi.month_fen, 30000);
  f.ui.photoState.mineQuery.page = 4; f.ui.photoState.mineQuery.photo = "PH20260002"; await f.ui.loadPhotoMine(true);
  assert.match(f.calls.at(-1).url, /photo=PH20260002/); assert.equal(f.ui.photoState.mineQuery.page, 1); assert.equal(f.ui.photoMineAll.value, false);
  assert.equal(f.ui.photoState.mine.photo.name, "老赵"); assert.equal(f.ui.photoState.mine.settlements[0].photo_name, "老赵");
  await f.ui.exportPhotoLedger(true); assert.match(f.calls.at(-1).url, /\/ledger\/export\?/); assert.match(f.calls.at(-1).url, /mine=1/); assert.match(f.calls.at(-1).url, /photo=PH20260002/);
  f.ui.photoState.mineQuery.photo = ""; await f.ui.exportPhotoLedger(true); assert.match(f.calls.at(-1).url, /mine=1/); assert.doesNotMatch(f.calls.at(-1).url, /photo=/);
});

test("only super can preview; bound photographers omit injected selections from mine and export requests", async () => {
  for (const role of ["admin", "administrator", "finance", "service", "custom"]) {
    const f = fixture(role); f.ctx.can = () => true;
    assert.equal(f.ui.photoCanPreviewMine.value, false); assert.equal(f.ui.photoCanReadMine.value, false);
    await f.ui.loadPhotoMine(); await f.ui.exportPhotoLedger(true); assert.equal(f.calls.length, 0);
  }
  for (const role of ["photo", "photographer"]) {
    const f = fixture(role); Object.assign(f.ui.photoState.mineQuery, { photo: "PH_OTHER", photo_id: "PH_SPOOF", mine: 1 });
    await f.ui.loadPhotoMine(); assert.doesNotMatch(f.calls.at(-1).url, /photo=|photo_id|PH_OTHER|PH_SPOOF|mine=1/);
    await f.ui.exportPhotoLedger(true); assert.doesNotMatch(f.calls.at(-1).url, /photo=|photo_id|PH_OTHER|PH_SPOOF|mine=1/);
    assert.equal(f.ui.photoMineAll.value, false);
  }
});

test("invalid proportions and blank reasons are rejected before writes; zero is valid", async () => {
  const f = fixture(); const form = { photo: 20, video: 20, combo: 22, peripheral: 0, ver: 7, reason: "" };
  Object.assign(f.ui.photoState.ruleForm, form); await f.ui.savePhotoRule(); assert.equal(f.calls.length, 0); assert.match(f.ui.photoState.errors.ruleSave, /原因/);
  assert.match(f.ui.photoValidateRates({ ...form, combo: -0.1 }), /负数/);
  assert.match(f.ui.photoValidateRates({ ...form, combo: 20.01 }), /0.1%/);
  assert.match(f.ui.photoValidateRates({ ...form, combo: undefined }), /四类/);
  assert.equal(f.ui.photoValidateRates(form), "");
  assert.deepEqual(plain(f.ui.photoRatePayload(form)), { rate_photo_bp: 2000, rate_video_bp: 2000, rate_combo_bp: 2200, rate_peripheral_bp: 0 });
});

test("optimistic rule version uses latest scheduled version and conflicts preserve edits", async () => {
  const f = fixture();
  f.control.handler = async () => ({ code: 0, data: { current: { ver: 2, rate_photo_bp: 2000, rate_video_bp: 2000, rate_combo_bp: 2000, rate_peripheral_bp: 800 }, latest_ver: 3, versions: [] } });
  await f.ui.loadPhotoRules(); assert.equal(f.ui.photoState.ruleForm.ver, 3);
  f.ui.photoState.ruleForm.combo = 22; f.ui.photoState.ruleForm.reason = "协议变更";
  f.control.handler = async () => ({ code: 4303, msg: "配置已被他人修改，请刷新" });
  await f.ui.savePhotoRule(); assert.equal(f.calls.at(-1).body.ver, 3); assert.equal(f.ui.photoState.ruleForm.combo, 22); assert.match(f.ui.photoState.errors.ruleSave, /刷新/);
});

test("termination precheck immediately blocks and stale server 4302 uses the same dialog", async () => {
  const f = fixture(); const person = { id: "PH20260001", name: "老赵", status: "active", pending_count: 1, pending_orders: [{ order_no: "LM1", status: "confirmed" }] };
  f.ui.openPhotoStatus(person, "ended"); assert.equal(f.calls.length, 0); assert.equal(f.ui.photoState.blockOpen, true); assert.equal(f.ui.photoState.pendingOrders[0].order_no, "LM1");
  f.ui.photoState.blockOpen = false; f.ui.openPhotoStatus({ ...person, pending_count: 0, pending_orders: [] }, "ended"); f.ui.photoState.statusReason = "合作到期";
  f.control.handler = async () => ({ code: 4302, msg: "还有在途", data: { pending_orders: person.pending_orders } });
  await f.ui.savePhotoStatus(); assert.equal(f.ui.photoState.statusOpen, false); assert.equal(f.ui.photoState.blockOpen, true); assert.equal(f.ui.photoState.pendingOrders[0].order_no, "LM1");
  await f.ui.disposePhotoPending(); assert.equal(f.calls.at(-1).menu, "svcFollowup"); assert.deepEqual(plain(f.window.LXM_KF_Filters), { page: "svcFollowup", photo: person.id });
});

test("account change discards pending confidential responses and export form data", async () => {
  const f = fixture(); let finish;
  f.control.handler = () => new Promise((resolve) => { finish = resolve; }); const pending = f.ui.loadPhotoLedger();
  f.ui.photoState.voucherUrl = "https://private.example/transfer"; f.listeners["lxm-auth-changed"]();
  finish({ code: 0, data: { rows: [{ biz_no: "private" }], total: 1 } }); await pending;
  assert.deepEqual(plain(f.ui.photoState.ledger), []); assert.equal(f.ui.photoState.voucherUrl, ""); assert.equal(f.ui.photoState.ledgerTotal, 0);
});

test("late preview cannot replace newer values and negative input clears a stale estimate", async () => {
  const f = fixture(); Object.assign(f.ui.photoState.ruleForm, { photo: 20, video: 20, combo: 20, peripheral: 10 }); const queue = [];
  f.control.handler = () => new Promise((resolve) => { queue.push(resolve); });
  const first = f.ui.previewPhotoRules(); f.ui.photoState.ruleForm.peripheral = 12; const second = f.ui.previewPhotoRules();
  queue[1]({ code: 0, data: { affected_count: 2, delta_fen: 796 } }); await second;
  queue[0]({ code: 0, data: { affected_count: 2, delta_fen: 398 } }); await first;
  assert.equal(f.ui.photoState.preview.delta_fen, 796);
  f.ui.photoState.ruleForm.peripheral = -1; await f.ui.previewPhotoRules(); assert.equal(f.ui.photoState.preview, null); assert.match(f.ui.photoState.errors.preview, /负数/);
});

test("batch and payout refuse ineligible data rather than silently changing statements", async () => {
  const f = fixture(); f.ui.photoState.selected = [{ id: 1, status: "settled", commission_fen: 100 }]; await f.ui.batchPhotoSettle(); assert.equal(f.calls.length, 0);
  f.ui.openPhotoPay({ settle_id: "S1", status: "pushed" }); assert.equal(f.ui.photoState.payOpen, false);
  f.ui.openPhotoPay({ settle_id: "S2", status: "accepted", payable_fen: 100 }); await f.ui.payPhotoSettlement(); assert.equal(f.calls.length, 0); assert.match(f.ui.photoState.payError, /凭证/);
  f.ui.photoState.voucherUrl = "javascript:alert(1)"; await f.ui.payPhotoSettlement(); assert.equal(f.calls.length, 0); assert.match(f.ui.photoState.payError, /HTTPS/);
});

test("integer fen display preserves zero and Shanghai dates", () => {
  const f = fixture(); assert.equal(f.ui.photoMoney(65978), "¥659.78"); assert.equal(f.ui.photoMoney(0), "¥0.00"); assert.equal(f.ui.photoMoney(undefined), "—"); assert.equal(f.ui.photoPercent(2200), "22%"); assert.equal(f.ui.photoPercent(0), "0%"); assert.equal(f.ui.photoTime("2026-11-10T16:00:00Z"), "2026-11-11 00:00");
});

const newForm = { name: "测试摄影师", phone: "13800000009", account: "  photo-admin-set  ", password: "  ChosenPhoto2026!  ", reason: "测试建档", photo: 20, video: 20, combo: 22, peripheral: 8, dispute_days: 5, wait_days: 3 };

test("new profiles submit the selected settlement cycle without a client-supplied agreement number", async () => {
  const f = fixture();
  assert.equal(f.ui.photoState.form.cycle, "monthly");
  assert.deepEqual(plain(f.ui.photoSettlementCycles).map(cycle => cycle.label), ["日结", "周结", "月结"]);
  f.control.handler = async () => ({ code: 4315, msg: "登录账号已存在，请更换账号", data: { field: "account" } });
  for (const cycle of ["daily", "weekly", "monthly"]) {
    Object.assign(f.ui.photoState.form, newForm, { cycle, agree_no: "CLIENT-OVERRIDE" });
    await f.ui.savePhotoParty();
    assert.equal(f.calls.at(-1).body.cycle, cycle);
    assert.equal(Object.hasOwn(f.calls.at(-1).body, "agree_no"), false);
    assert.equal(f.ui.photoState.form.cycle, cycle, "failed save preserves the selected cycle");
  }
  const count = f.calls.length;
  f.ui.photoState.form.cycle = "quarterly"; await f.ui.savePhotoParty();
  assert.equal(f.calls.length, count); assert.match(f.ui.photoState.formErrors.cycle, /日结、周结或月结/);
  f.ui.photoState.form.cycle = "weekly"; f.ui.clearPhotoFormError("cycle");
  assert.equal(f.ui.photoState.formErrors.cycle, undefined);
  await f.ui.cancelPhotoCreate(); assert.equal(f.ui.photoState.form.cycle, "monthly");
  for (const [cycle, label] of [["daily", "日结"], ["weekly", "周结"], ["monthly", "月结"], [undefined, "月结"]]) assert.equal(f.ui.photoCycleLabel(cycle), label);
});

test("administrator creates from the list dialog, clears secrets, and refreshes the first list page", async () => {
  const f = fixture(); Object.assign(f.ui.photoState.form, newForm); f.ui.photoState.createOpen = true;
  f.ui.photoState.partyQuery.page = 3;
  f.control.handler = async (url, init) => init?.method === "POST"
    ? { code: 0, data: { id: "PH20260009", name: newForm.name, account: "photo-admin-set", account_id: "usr-photo", account_created: true } }
    : { code: 0, data: { rows: [{ id: "PH20260009", name: newForm.name }], total: 1 } };
  await f.ui.savePhotoParty();
  assert.equal(f.calls[0].body.account, "photo-admin-set"); assert.equal(f.calls[0].body.password, newForm.password);
  assert.equal(f.ui.photoState.form.password, ""); assert.equal(f.ui.photoState.form.account, ""); assert.equal(f.ui.photoState.form.name, "");
  assert.equal(f.ui.photoState.createOpen, false); assert.equal(f.ui.photoState.partyQuery.page, 1);
  assert.match(f.calls.at(-1).url, /^\/api\/photo\/party\?/); assert.match(f.calls.at(-1).url, /page=1/);
  assert.equal(f.ui.photoState.parties[0].id, "PH20260009"); assert.equal(f.ui.photoState.partyTotal, 1);
  assert.equal(f.calls.filter(call => call.menu).length, 0); assert.equal(f.clipboard.length, 0);
  assert.equal(JSON.stringify(f.notices).includes(newForm.password), false);
  assert.equal(Object.hasOwn(f.ui.photoState,"credentials"),false);
  assert.doesNotMatch(source("src/views/photo-share/new/new.html"),/initial_password|credentialsOpen|自动生成的账号/);
});

test("manual account and password validation marks the field and rejects invalid credentials before any POST", async () => {
  const f = fixture(); Object.assign(f.ui.photoState.form, newForm, {account:"",password:""});
  await f.ui.savePhotoParty(); assert.equal(f.calls.length,0); assert.match(f.ui.photoState.formErrors.account,/账号/); assert.match(f.ui.photoState.formErrors.password,/密码/);
  for(const account of ["admin", " ADMIN ", "bad\nlogin", "x".repeat(129)]){
    Object.assign(f.ui.photoState.form,newForm,{account});await f.ui.savePhotoParty();assert.equal(f.calls.length,0);assert.ok(f.ui.photoState.formErrors.account);
  }
  for(const password of ["short1", "abcdefgh", "12345678", "a1".repeat(65)]){
    Object.assign(f.ui.photoState.form,newForm,{password});await f.ui.savePhotoParty();assert.equal(f.calls.length,0);assert.ok(f.ui.photoState.formErrors.password);
  }
  assert.match(source("src/views/photo-share/new/new.html"),/label="登录账号" required/);
  assert.match(source("src/views/photo-share/new/new.html"),/label="登录密码" required/);
});

test("a mismatched creation response clears the secret without claiming account success or automatically retrying",async()=>{
  for(const data of [{id:"PH20260009"},{id:"PH20260009",account:"PH20260009",account_created:true}]){
    const f=fixture();Object.assign(f.ui.photoState.form,newForm);f.control.handler=async()=>({code:0,data});
    await f.ui.savePhotoParty();assert.match(f.ui.photoState.errors.new,/档案已保存.*账号尚未确认/);assert.equal(f.ui.photoState.form.password,"");assert.equal(f.ui.photoState.form.account,"");assert.equal(f.calls.filter(c=>c.url).length,1);assert.equal(f.calls.filter(c=>c.menu).length,0);assert.equal(f.notices.filter(n=>n.type==="success").length,0);
  }
});

test("duplicate or rejected credentials preserve the draft and show the server field error for retry", async () => {
  for(const field of ["account","password"]){
    const f = fixture(); Object.assign(f.ui.photoState.form,newForm);const before=plain(f.ui.photoState.form);
    f.control.handler=async()=>({code:4315,msg:field==="account"?"登录账号已存在，请更换账号":"密码须为8–128位且包含字母和数字",data:{field}});
    await f.ui.savePhotoParty();assert.deepEqual(plain(f.ui.photoState.form),before);assert.equal(f.calls.filter(c=>c.menu).length,0);assert.ok(f.ui.photoState.formErrors[field]);
    f.ui.clearPhotoFormError(field);assert.equal(f.ui.photoState.formErrors[field],undefined);assert.equal(f.ui.photoState.errors.new,"");
  }
});

test("leaving or canceling the dialog clears the typed password and discards late create responses",async()=>{
  const f=fixture();Object.assign(f.ui.photoState.form,newForm);let finish;
  f.control.handler=()=>new Promise(resolve=>{finish=resolve;});const pending=f.ui.savePhotoParty();
  f.ui.clearPhotoNewPassword();assert.equal(f.ui.photoState.form.password,"");
  finish({code:0,data:{id:"PH20260009",account:"photo-admin-set",account_created:true}});await pending;
  assert.equal(f.calls.filter(c=>c.menu).length,0);assert.equal(f.notices.filter(n=>n.type==="success").length,0);
  assert.equal(f.ui.photoState.busy,false);
  Object.assign(f.ui.photoState.form,newForm);f.ui.photoState.createOpen=true;await f.ui.cancelPhotoCreate();assert.equal(f.ui.photoState.form.password,"");assert.equal(f.ui.photoState.form.account,"");assert.equal(f.ui.photoState.createOpen,false);assert.equal(f.calls.filter(call=>call.menu).length,0);
  assert.match(source("src/views/photo-share/party/party.js"), /onBeforeUnmount\(\(\) => ctx\.clearPhotoNewPassword\(\)\)/);
});

test("list creation initializes fresh rates and a canceled rule load cannot populate a closed draft", async () => {
  const f = fixture(); let finish;
  f.control.handler = () => new Promise(resolve => { finish = resolve; });
  Object.assign(f.ui.photoState.form, newForm);
  const opening = f.ui.openPhotoCreate();
  assert.equal(f.ui.photoState.createOpen, true); assert.equal(f.ui.photoState.form.password, "");
  await f.ui.cancelPhotoCreate();
  finish({ code: 0, data: { current: { rate_photo_bp: 2000, rate_video_bp: 2100, rate_combo_bp: 2200, rate_peripheral_bp: 800 } } });
  await opening; assert.equal(f.ui.photoState.createOpen, false); assert.equal(f.ui.photoState.form.photo, undefined);
  f.control.handler = async () => ({ code: 0, data: { current: { rate_photo_bp: 2300, rate_video_bp: 2400, rate_combo_bp: 2500, rate_peripheral_bp: 900 } } });
  await f.ui.openPhotoCreate(); assert.equal(f.ui.photoState.form.photo, 23); assert.equal(f.ui.photoState.form.peripheral, 9);
  const party = source("src/views/photo-share/party/party.html");
  assert.match(party, /@click="openPhotoCreate"/); assert.match(party, /<el-dialog[^>]*photoState\.createOpen/);
  assert.match(party, /label="登录账号" required/); assert.match(party, /label="登录密码" required/);
});

test("late creation defaults preserve rates typed while the rule request is pending", async () => {
  const f = fixture(); let finish;
  f.control.handler = () => new Promise(resolve => { finish = resolve; });
  const opening = f.ui.openPhotoCreate();
  f.ui.photoState.form.photo = 27.5; f.ui.photoState.form.name = "已填写的摄影师";
  finish({ code: 0, data: { current: { rate_photo_bp: 2000, rate_video_bp: 2100, rate_combo_bp: 2200, rate_peripheral_bp: 800 } } });
  await opening;
  assert.equal(f.ui.photoState.form.photo, 27.5); assert.equal(f.ui.photoState.form.video, 21);
  assert.equal(f.ui.photoState.form.combo, 22); assert.equal(f.ui.photoState.form.name, "已填写的摄影师");
});

test("authentication changes clear the new-account password and late creates cannot repopulate the form", async () => {
  for (const event of ["lxm-auth-expired", "lxm-auth-changed"]) {
    const f = fixture(); Object.assign(f.ui.photoState.form, newForm); let finish;
    f.control.handler = () => new Promise(resolve => { finish = resolve; });
    const pending = f.ui.savePhotoParty(); f.listeners[event]();
    finish({ code: 0, data: { id: "PH20260009", account:"photo-admin-set",account_created:true } }); await pending;
    assert.equal(f.ui.photoState.form.password, ""); assert.equal(f.ui.photoState.form.account, "");
    assert.equal(f.calls.filter(c=>c.menu).length,0);
  }
});

test("management grants do not allow a non-administrator to provision an account", async () => {
  for (const role of ["service", "finance", "custom", "photo"]) {
    const f = fixture(role); f.ctx.can = () => true; Object.assign(f.ui.photoState.form, newForm);
    assert.equal(f.ui.photoCanCreate.value, false); await f.ui.savePhotoParty(); assert.equal(f.calls.length, 0);
  }
});
