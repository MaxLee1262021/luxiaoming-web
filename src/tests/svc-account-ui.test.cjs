"use strict";
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../api/svc-commission-ui.js'), 'utf8');
function fixture(mode = 'new', initialState = {}) {
  const requests = [], messages = [], unmounted = [], watchers = [], control = { fail: false, hold: null, staff: [], wecomResult: null };
  const Vue = { reactive: value => value, computed: fn => ({ get value() { return fn(); } }), watch(getter, callback, options) { watchers.push({ getter, callback }); if (options?.immediate) callback(getter()); }, onMounted() {}, onUnmounted(fn) { unmounted.push(fn); } };
  const window = { LXM_HTTP: { async request(url, init = {}) {
    const request = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }; requests.push(request);
    if (request.method === 'POST' && control.hold) await control.hold;
    let result;
    if (!control.fail && request.method === 'POST') {
      if (url.endsWith('/wecom-sync')) {
        result = { id: 'new-staff', ...control.wecomResult };
        const row = control.staff.find(item => item.id === result.id); if (row) Object.assign(row, result);
      } else {
        result = { ...request.body, password: undefined, id: 'new-staff', account_id: 'new-user', ...control.wecomResult };
        control.staff.push(result);
      }
    }
    return { ok: true, json: async () => control.fail ? { code: 4014, msg: '账号已存在，请更换账号' } : { code: 0, data: request.method === 'POST' ? result : { list: control.staff.map(row => ({ ...row })), total: control.staff.length } } };
  } } };
  const ctx = { state: { role: 'super', active: mode === 'new' ? 'svcStaffNew' : 'svcStaff', ...initialState }, ElMessage: Object.fromEntries(['success', 'warning', 'error'].map(kind => [kind, message => messages.push({ kind, message })])), ElMessageBox: { async confirm() {} } };
  vm.runInNewContext(source, { window, Vue, URLSearchParams, Intl, Date, setTimeout, clearTimeout });
  const ui = window.LXM_SVC_COMMISSION_SETUP(ctx, mode);
  return { ui, ctx, requests, messages, control, unmounted, watchers };
}
const fill = ui => Object.assign(ui.svc.form, { name: '新客服', phone: '13900000000', joined_at: '2026-11-13', account: ' service-01 ', password: ' Service123 ' });
const posts = f => f.requests.filter(request => request.method === 'POST');

test('new staff creates a trimmed login account with the unchanged password and prevents duplicate submissions', async () => {
  const f = fixture(); assert.equal(f.ui.svc.form.create_account, true); fill(f.ui);
  f.ui.svc.form.account_id = 'stale-linked-user';
  let release; f.control.hold = new Promise(resolve => { release = resolve; });
  const saving = f.ui.svcSubmit(); assert.equal(f.ui.svc.busy, true); assert.equal(posts(f).length, 1);
  await f.ui.svcSubmit(); f.ui.svcResetNew(); f.ui.svcCloseDialog();
  assert.equal(posts(f).length, 1); assert.equal(f.ui.svc.form.password, ' Service123 '); assert.equal(f.ui.svc.dialog, 'staff');
  assert.equal(posts(f)[0].body.create_account, true); assert.equal(posts(f)[0].body.account, 'service-01'); assert.equal(posts(f)[0].body.password, ' Service123 '); assert.equal('account_id' in posts(f)[0].body, false);
  release(); await saving;
  assert.equal(f.ui.svc.form.password, ''); assert.equal(f.ctx.state.active, 'svcStaff'); assert.equal(f.ui.svc.busy, false);
  assert.match(f.messages.find(message => message.kind === 'success').message, /登录账号已创建/);
});

test('invalid login credentials stop submission with the same length and composition rules as merchant onboarding', async () => {
  const f = fixture(); fill(f.ui);
  for (const account of ['', ' '.repeat(3), 'a'.repeat(129), 'staff\u0007id']) {
    f.ui.svc.form.account = account; await f.ui.svcSubmit(); assert.equal(posts(f).length, 0);
  }
  f.ui.svc.form.account = '客服' + 'a'.repeat(126);
  for (const password of ['', 'Short1', 'abcdefgh', '12345678', 'a1' + 'x'.repeat(127)]) {
    f.ui.svc.form.password = password; await f.ui.svcSubmit(); assert.equal(posts(f).length, 0);
  }
  f.ui.svc.form.password = 'a1' + 'x'.repeat(126); await f.ui.svcSubmit(); assert.equal(posts(f).length, 1);
});

test('failed creation preserves credentials and profile choices for a corrected retry, success clears the password', async () => {
  const f = fixture(); fill(f.ui); f.ui.svc.form.settlement_cycle = '周结'; f.control.fail = true;
  await f.ui.svcSubmit(); assert.equal(f.ui.svc.form.password, ' Service123 '); assert.equal(f.ui.svc.form.account, ' service-01 '); assert.equal(f.ui.svc.form.settlement_cycle, '周结'); assert.equal(f.ctx.state.active, 'svcStaffNew'); assert.equal(f.ui.svc.busy, false);
  f.control.fail = false; f.ui.svc.form.account = 'service-02'; await f.ui.svcSubmit();
  assert.equal(posts(f).length, 2); assert.equal(posts(f)[1].body.account, 'service-02'); assert.equal(f.ui.svc.form.password, ''); assert.equal(f.ctx.state.active, 'svcStaff');
});

test('linking an existing account requires an account and omits all password and account ID fields', async () => {
  const f = fixture(); fill(f.ui); f.ui.svc.form.create_account = false; f.ui.svcAccountModeChanged();
  assert.equal(f.ui.svc.form.password, ''); f.ui.svc.form.password = 'stale-secret'; f.ui.svc.form.account_id = 'stale-id';
  await f.ui.svcSubmit(); const body = posts(f)[0].body;
  assert.equal(body.create_account, false); assert.equal(body.account, 'service-01'); assert.equal('password' in body, false); assert.equal('account_id' in body, false); assert.equal(f.ui.svc.form.password, '');
});

test('reset, dialog dismissal and page disposal clear password references from both staff entry paths', async () => {
  const f = fixture(); fill(f.ui); const original = f.ui.svc.form; f.ui.svcResetNew();
  assert.equal(original.password, ''); assert.equal(f.ui.svc.form.password, ''); assert.equal(f.ui.svc.form.create_account, true);
  fill(f.ui); f.unmounted.forEach(fn => fn()); assert.equal(f.ui.svc.form.password, '');
  const modal = fixture('staff'); await modal.ui.svcOpen('staff'); fill(modal.ui); assert.equal(modal.ui.svc.form.create_account, true);
  modal.ui.svcCloseDialog(); assert.equal(modal.ui.svc.dialog, ''); assert.equal(modal.ui.svc.form.password, '');
  await modal.ui.svcOpen('staff'); fill(modal.ui); await modal.ui.svcSubmit(); assert.equal(posts(modal)[0].body.create_account, true); assert.equal(modal.ui.svc.form.password, '');
});

test('list modal creates in place and fetches page one from the staff API after success', async () => {
  const f = fixture('staff'); await f.ui.svcLoad(); await f.ui.svcOpen('staff');
  fill(f.ui); f.ui.svc.query.page = 3; f.ui.svc.form.settlement_cycle = '隔天结';
  await f.ui.svcSubmit();
  const postIndex = f.requests.findIndex(request => request.method === 'POST');
  const refresh = f.requests[postIndex + 1];
  assert.equal(refresh.method, 'GET'); assert.match(refresh.url, /^\/api\/svc\/staff\?/);
  assert.equal(new URLSearchParams(refresh.url.split('?')[1]).get('page'), '1');
  assert.equal(f.ui.svc.rows[0].name, '新客服'); assert.equal(f.ui.svc.rows[0].settlement_cycle, '隔天结');
  assert.equal(f.ui.svc.total, 1); assert.equal(f.ui.svc.dialog, ''); assert.equal(f.ctx.state.active, 'svcStaff');
});

test('list modal failed creation stays open without refreshing and pending legacy entry opens on the list', async () => {
  const f = fixture('staff', { svcCreateRequested: true });
  assert.equal(f.ctx.state.svcCreateRequested, false); assert.equal(f.ui.svc.dialog, 'staff');
  await f.ui.svcOpen('staff'); fill(f.ui); f.control.fail = true;
  const count = f.requests.length; await f.ui.svcSubmit();
  assert.equal(f.requests.length, count + 1); assert.equal(f.ui.svc.dialog, 'staff');
  assert.equal(f.ui.svc.form.password, ' Service123 '); assert.equal(f.ctx.state.active, 'svcStaff');
  f.ui.svcCloseDialog(); assert.equal(f.ui.svc.form.password, '');
  const requested = f.watchers.find(watcher => watcher.getter() === false);
  f.ctx.state.svcCreateRequested = true; requested.callback(requested.getter());
  assert.equal(f.ctx.state.svcCreateRequested, false); assert.equal(f.ui.svc.dialog, 'staff');
});

test('successful staff creation reports a submitted WeCom invitation and confirmation is still required', async () => {
  const f = fixture('staff'); await f.ui.svcOpen('staff'); fill(f.ui);
  f.control.wecomResult = { wecom_sync_status: 'synced', wecom_userid: 'staff-new', wecom_department_id: 2 };
  await f.ui.svcSubmit();
  assert.equal(f.ui.svc.dialog, ''); assert.equal(f.ui.svc.form.password, '');
  assert.match(f.messages.find(message => message.kind === 'success').message, /邀请已提交，成员需确认加入/);
  assert.equal(f.ui.svc.rows[0].wecom_userid, 'staff-new');
  assert.equal(f.ui.svcWecomStatus(f.ui.svc.rows[0]), '已同步');
});

test('WeCom partial failures preserve the saved staff and close creation with a warning', async () => {
  for (const status of ['failed', 'disabled', 'pending', 'syncing']) {
    const f = fixture('staff'); await f.ui.svcOpen('staff'); fill(f.ui);
    f.control.wecomResult = { wecom_sync_status: status, wecom_sync_message: '请检查企微配置' };
    await f.ui.svcSubmit();
    assert.equal(f.control.staff.length, 1); assert.equal(f.ui.svc.rows.length, 1);
    assert.equal(f.ui.svc.dialog, ''); assert.equal(f.ui.svc.form.password, '');
    assert.equal(f.messages.some(message => message.kind === 'success'), false);
    assert.match(f.messages.find(message => message.kind === 'warning').message, /客服档案和登录账号已创建.*请检查企微配置.*无需重复新增/);
    await f.ui.svcSubmit(); assert.equal(posts(f).length, 1);
  }
});

test('WeCom retry sends only a dedicated empty request, prevents duplicate clicks and refreshes the saved row', async () => {
  const f = fixture('staff');
  const row = { id: 'new-staff', name: '新客服', wecom_sync_status: 'failed', password: 'must-not-send', wecom_secret: 'must-not-send' };
  f.control.staff.push(row); await f.ui.svcLoad();
  f.ui.svc.current = { ...f.ui.svc.rows[0], detail_kind: 'staff' };
  f.control.wecomResult = { wecom_sync_status: 'synced', wecom_userid: 'staff-new', wecom_department_id: 2 };
  let release; f.control.hold = new Promise(resolve => { release = resolve; });
  const saving = f.ui.svcRetryWecom(f.ui.svc.rows[0]);
  assert.equal(f.ui.svc.wecomSyncingId, 'new-staff'); assert.equal(f.ui.svc.busy, true);
  await f.ui.svcRetryWecom(f.ui.svc.rows[0]); assert.equal(posts(f).length, 1);
  assert.equal(posts(f)[0].url, '/api/svc/staff/new-staff/wecom-sync'); assert.deepEqual(posts(f)[0].body, {});
  release(); await saving;
  assert.equal(f.control.staff.length, 1); assert.equal(f.ui.svc.rows[0].wecom_sync_status, 'synced');
  assert.equal(f.ui.svc.current.wecom_userid, 'staff-new'); assert.equal(f.ui.svc.current.detail_kind, 'staff');
  assert.equal(f.ui.svc.busy, false); assert.equal(f.ui.svc.wecomSyncingId, '');
});

test('WeCom retry is limited to managers and unsynced rows, and request errors do not create staff', async () => {
  const viewer = fixture('staff', { role: 'service_supervisor' });
  for (const status of ['disabled', 'pending', 'syncing', 'failed']) {
    const row = { id: 'new-staff', wecom_sync_status: status };
    assert.equal(viewer.ui.svcCanRetryWecom(row), false); await viewer.ui.svcRetryWecom(row);
  }
  assert.equal(posts(viewer).length, 0);
  const f = fixture('staff');
  for (const status of ['disabled', 'pending', 'syncing', 'failed']) assert.equal(f.ui.svcCanRetryWecom({ wecom_sync_status: status }), true);
  assert.equal(f.ui.svcCanRetryWecom({ wecom_sync_status: 'synced' }), false);
  await f.ui.svcRetryWecom({ id: 'new-staff', wecom_sync_status: 'synced' }); assert.equal(posts(f).length, 0);
  const row = { id: 'new-staff', wecom_sync_status: 'failed' }; f.control.staff.push(row); f.control.fail = true;
  await f.ui.svcRetryWecom(row);
  assert.equal(posts(f).length, 1); assert.equal(f.control.staff.length, 1); assert.equal(row.wecom_sync_status, 'failed');
  assert.equal(f.ui.svc.busy, false); assert.equal(f.ui.svc.wecomSyncingId, '');
  assert.equal(f.messages.at(-1).kind, 'error');
});

test('legacy staff can sync without a previous WeCom status while ended staff cannot retry', async () => {
  for (const status of [null, undefined]) {
    const f = fixture('staff');
    const row = { id: 'new-staff', staff_status: 'active', wecom_sync_status: status };
    f.control.staff.push(row); f.control.wecomResult = { wecom_sync_status: 'synced' };
    assert.equal(f.ui.svcCanRetryWecom(row), true);
    await f.ui.svcRetryWecom(row);
    assert.equal(posts(f).length, 1); assert.equal(posts(f)[0].url, '/api/svc/staff/new-staff/wecom-sync');
    assert.equal(f.control.staff.length, 1);
    const viewer = fixture('staff', { role: 'service_supervisor' });
    assert.equal(viewer.ui.svcCanRetryWecom({ staff_status: 'active', wecom_sync_status: status }), false);
  }
  const f = fixture('staff');
  for (const status of [null, undefined, 'disabled', 'pending', 'syncing', 'failed']) {
    const row = { id: 'ended-staff', staff_status: 'ended', wecom_sync_status: status };
    assert.equal(f.ui.svcCanRetryWecom(row), false); await f.ui.svcRetryWecom(row);
  }
  assert.equal(posts(f).length, 0); assert.equal(f.ui.svcCanRetryWecom(null), false);
});

test('synced staff display the server result without claiming an invitation was sent to active members', async () => {
  const f = fixture('staff'); await f.ui.svcOpen('staff'); fill(f.ui);
  const message = '企微成员已加入客服部门，成员已激活，无需再次邀请。';
  f.control.wecomResult = { wecom_sync_status: 'synced', wecom_sync_message: message };
  await f.ui.svcSubmit();
  const notification = f.messages.find(item => item.kind === 'success').message;
  assert.ok(notification.endsWith(message)); assert.doesNotMatch(notification, /邀请已提交|成员需确认加入/);
  assert.equal(f.ui.svc.dialog, ''); assert.equal(f.ui.svc.rows[0].wecom_sync_message, message);
});
