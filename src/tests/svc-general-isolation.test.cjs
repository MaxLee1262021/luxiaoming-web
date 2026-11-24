"use strict";
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const script = fs.readFileSync(path.resolve(__dirname, '../api/svc-workbench-ui.js'), 'utf8');
function fixture(isolation, mode = 'intake') {
  const mounts = [], requests = [], polls = [], transitions = [];
  const globals = { page: 'svcIntake', keyword: 'OLD-FILTER' }, oldAftersale = { order_no: 'OLD-AFTERSALE' };
  const window = { LXM_KF_Filters: globals, LXM_KF_AFtersale: oldAftersale, LXM_HTTP: { async request(url, options = {}) { requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) }); return { ok: true, json: async () => ({ code: 0, data: { list: [], total: 0, reserved: { list: [] } } }) }; } }, LXM_CLOUD: { getColl: async () => [], orderAction: async (...args) => transitions.push(args) } };
  const ctx = { state: { role: 'service', currentStaffId: 's1', active: mode === 'complaints' ? 'svcComplaints' : 'svcIntake' }, ...(isolation ? { kfIsolation: isolation } : {}), ElMessage: { success() {}, error() {}, warning() {} }, ElMessageBox: { confirm: async () => {}, prompt: async () => ({ value: '合理原因' }) }, switchMenu() {} };
  vm.runInNewContext(script, { window, Vue: { reactive: x => x, computed: fn => ({ get value() { return fn(); } }), onMounted: fn => mounts.push(fn), onUnmounted() {} }, URLSearchParams, AbortController, Intl, Date, setTimeout, clearTimeout, setInterval: (fn, interval) => { polls.push(interval); return polls.length; }, clearInterval() {}, document: { visibilityState: 'visible' } });
  return { window, ctx, ui: window.LXM_SVC_WORKBENCH_SETUP(ctx, mode), mounts, requests, polls, transitions, globals, oldAftersale, async mount() { for (const fn of mounts) await fn(); } };
}
test('legacy defaults still consume legacy navigation and use the original independent action guards', async () => {
  const f = fixture(); await f.mount();
  assert.equal(f.ui.kf.query.keyword, 'OLD-FILTER'); assert.equal(f.window.LXM_KF_Filters, undefined);
  assert.ok(f.requests.some(row => row.url.startsWith('/api/kf/workbench/overview?'))); assert.ok(f.polls.includes(30000));
  const count = f.requests.length;
  await f.ui.kfOpen('assign', { order_no: 'A', service_status: 'claimed', can_operate: true });
  await f.ui.kfOpen('assign', { order_no: 'B', service_status: 'confirmed', photo_id: 'p1', can_operate: true });
  assert.equal(f.ui.kf.dialog, ''); assert.equal(f.requests.length, count);
  f.ui.kfGoto('svcComplaints', 'claimed'); assert.equal(f.window.LXM_KF_Filters.page, 'svcComplaints');
});
test('new embedded instances consume and write only their own context', async () => {
  const local = { filters: { page: 'svcComplaints', keyword: 'NEW-FILTER' }, aftersale: { order_no: 'NEW-AFTERSALE' } };
  const f = fixture(local, 'complaints'); await f.mount();
  assert.equal(f.ui.kf.query.keyword, 'NEW-FILTER'); assert.equal(f.ui.kf.complaintForm.order_no, 'NEW-AFTERSALE');
  assert.equal(f.window.LXM_KF_Filters, f.globals); assert.equal(f.window.LXM_KF_AFtersale, f.oldAftersale);
  f.ui.kfGoto('svcFollowup', 'claimed'); assert.equal(local.filters.page, 'svcFollowup'); assert.equal(f.window.LXM_KF_Filters.page, 'svcIntake');
});
test('new helper instances skip hidden reads and polling and refresh their parent after a real action', async () => {
  let refreshed = 0;
  const f = fixture({ suppressAutoLoad: true, onAction: async () => { refreshed++; } }, 'workbench'); await f.mount();
  assert.equal(f.requests.length, 0); assert.equal(f.polls.length, 0);
  await f.ui.kfClaim({ order_no: 'CLAIM', service_status: 'new', can_claim: true });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'POST'); assert.equal(refreshed, 1);
  assert.equal(f.window.LXM_KF_Filters, f.globals);
});
test('review transport is replaced only for explicitly isolated new instances', async () => {
  const row = { id: 'id1', orderNo: 'NO1', assignee_id: 's1', service_status: 'confirmed', rescheduleRequest: { id: 'req1', status: 'pending', appointmentAt: '2026-12-01', timePeriod: '下午' }, canReviewReschedule: true };
  const custom = [], f = fixture({ suppressAutoLoad: true, reviewReschedule: async (...args) => custom.push(args) }, 'workbench');
  await f.ui.kfReviewReschedule(row, true); assert.equal(custom.length, 1); assert.equal(f.transitions.length, 0);
  const legacy = fixture(undefined, 'workbench'); await legacy.ui.kfReviewReschedule(row, true);
  assert.equal(legacy.transitions.length, 1); assert.equal(legacy.transitions[0][1], 'reviewreschedule');
});
