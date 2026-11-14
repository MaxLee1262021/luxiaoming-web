"use strict";
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..'), source = fs.readFileSync(path.join(root, 'src/api/svc-commission-ui.js'), 'utf8');

function fixture(mode = 'new') {
  const requests = [], messages = [], control = { fail: false, config: { link_valid_days: 12, observe_days: 4 }, pendingConfig: { link_valid_days: 20, observe_days: 9 }, holdConfig: null };
  const Vue = { reactive: value => value, computed: fn => ({ get value() { return fn(); } }), watch() {}, onMounted() {}, onUnmounted() {} };
  const window = { LXM_HTTP: { async request(url, init = {}) {
    const entry = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }; requests.push(entry);
    if (entry.method === 'GET' && url.startsWith('/api/svc/rule') && control.holdConfig) await control.holdConfig;
    return { ok: true, json: async () => entry.method === 'POST' && control.fail ? { code: 4014, msg: '保存失败，请修改后重试' } : { code: 0, data: entry.method === 'POST' ? { id: 'saved-staff' } : { config: control.config, pending_config: control.pendingConfig, list: [], total: 0 } } };
  } } };
  const ctx = { state: { role: 'super', active: mode === 'new' ? 'svcStaffNew' : 'svcStaff' }, ElMessage: Object.fromEntries(['success', 'warning', 'error'].map(kind => [kind, message => messages.push({ kind, message })])), ElMessageBox: { async confirm() {} } };
  vm.runInNewContext(source, { window, Vue, URLSearchParams, Intl, Date, setTimeout, clearTimeout });
  return { ui: window.LXM_SVC_COMMISSION_SETUP(ctx, mode), ctx, requests, messages, control };
}
const posts = f => f.requests.filter(row => row.method === 'POST');
const fill = ui => Object.assign(ui.svc.form, { name: '时效测试客服', phone: '13900000000', joined_at: '2026-11-13', account: 'staff-timing', password: 'TimingQA123!' });

test('new staff timing starts with current shared defaults and reset uses the loaded configuration', async () => {
  const f = fixture(); assert.equal(f.ui.svc.form.link_valid_days, 7); assert.equal(f.ui.svc.form.observe_days, 7);
  await f.ui.svcLoad(); assert.equal(f.ui.svc.form.link_valid_days, 12); assert.equal(f.ui.svc.form.observe_days, 4);
  f.ui.svc.form.link_valid_days = 25; f.ui.svc.form.observe_days = 0; f.ui.svcTimingChanged('observe_days');
  f.ui.svcResetNew(); assert.equal(f.ui.svc.form.link_valid_days, 12); assert.equal(f.ui.svc.form.observe_days, 4);
  assert.equal(f.ui.svc.form.password, '');
});

test('late configuration responses never replace edited timing including an explicit seven-day value', async () => {
  const f = fixture(); let release; f.control.holdConfig = new Promise(resolve => { release = resolve; });
  const loading = f.ui.svcLoad();
  // One field keeps the initial value deliberately; the other changes without
  // an input event, covering programmatic edits and normal numeric edits.
  f.ui.svcTimingChanged('link_valid_days'); f.ui.svc.form.observe_days = 0;
  release(); await loading;
  assert.equal(f.ui.svc.form.link_valid_days, 7); assert.equal(f.ui.svc.form.observe_days, 0);
  await f.ui.svcLoad(); assert.equal(f.ui.svc.form.link_valid_days, 7); assert.equal(f.ui.svc.form.observe_days, 0);
  f.ui.svcResetNew(); assert.equal(f.ui.svc.form.link_valid_days, 12); assert.equal(f.ui.svc.form.observe_days, 4);
});

test('personal timing and zero wait submit with the profile and survive a failed save', async () => {
  const f = fixture(); fill(f.ui); f.ui.svc.form.link_valid_days = 30; f.ui.svc.form.observe_days = 0; f.control.fail = true;
  await f.ui.svcSubmit(); assert.equal(posts(f).length, 1);
  assert.equal(posts(f)[0].body.link_valid_days, 30); assert.equal(posts(f)[0].body.observe_days, 0);
  assert.equal(f.ui.svc.form.link_valid_days, 30); assert.equal(f.ui.svc.form.observe_days, 0); assert.equal(f.ctx.state.active, 'svcStaffNew');
  f.control.fail = false; await f.ui.svcSubmit(); assert.equal(posts(f).length, 2); assert.equal(f.ctx.state.active, 'svcStaff');
  assert.equal(f.ui.svcTiming({ link_valid_days: 30, observe_days: 0, timing: { link_valid_days: 7, observe_days: 7 } }), '链接 30 天 / 等待 0 天 / 月结');
});

test('timing validation rejects blanks, fractions and out-of-range values before posting', async () => {
  const f = fixture(); fill(f.ui);
  for (const [key, values] of [['link_valid_days', [undefined, null, '', '7', NaN, 0, -1, 1.5, 31]], ['observe_days', [undefined, null, '', '0', NaN, -1, 0.5, 31]]]) {
    for (const value of values) {
      f.ui.svc.form.link_valid_days = 7; f.ui.svc.form.observe_days = 7; f.ui.svc.form[key] = value;
      await f.ui.svcSubmit(); assert.equal(posts(f).length, 0, `${key}: ${String(value)}`);
      assert.equal(f.messages.at(-1).kind, 'warning');
    }
  }
  f.ui.svc.form.link_valid_days = 1; f.ui.svc.form.observe_days = 30; await f.ui.svcSubmit();
  assert.equal(posts(f).length, 1); assert.equal(posts(f)[0].body.link_valid_days, 1); assert.equal(posts(f)[0].body.observe_days, 30);
});

test('staff dialogs use the same editable fields and inherit shared values already loaded', async () => {
  const f = fixture('staff'); await f.ui.svcLoad(); await f.ui.svcOpen('staff'); fill(f.ui);
  assert.equal(f.ui.svc.form.link_valid_days, 12); assert.equal(f.ui.svc.form.observe_days, 4);
  f.ui.svc.form.observe_days = 0; await f.ui.svcSubmit(); assert.equal(posts(f)[0].body.observe_days, 0);
  for (const slug of ['new-staff', 'staff', 'rules', 'ledger', 'settlements', 'mine']) {
    const html = fs.readFileSync(path.join(root, `src/views/service/${slug}/${slug}.html`), 'utf8');
    for (const key of ['link_valid_days', 'observe_days']) {
      assert.ok(html.includes(`v-model="svc.form.${key}"`), `${slug}: editable ${key}`);
      assert.doesNotMatch(html, new RegExp(`<el-input-number[^>]*:model-value="svc\\.config\\.${key}"[^>]*disabled`));
    }
  }
});

test('staff dialog open before a list response receives untouched defaults and keeps typed values', async () => {
  const f = fixture('staff'); await f.ui.svcOpen('staff');
  f.ui.svc.form.observe_days = 0; f.ui.svcTimingChanged('observe_days');
  await f.ui.svcLoad(); assert.equal(f.ui.svc.form.link_valid_days, 12); assert.equal(f.ui.svc.form.observe_days, 0);
});
