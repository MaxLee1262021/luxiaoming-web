"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
function fixture() {
  const calls = [], errors = [], messages = [];
  const window = { LXM_HTTP: { request: async (url, init = {}) => {
    calls.push({ url, body: init.body && JSON.parse(init.body), method: init.method });
    return { ok: true, json: async () => ({ code: 0, data: url.includes('/config') ? { carrierOptions: [{ code: 'ems', name: 'EMS' }] } : url.includes('/list') ? { items: [], total: 0 } : { id: 'physical-one' } }) };
  } } };
  let dispose;
  const ctx = { state: { role: 'super' }, ElMessage: { warning: m => messages.push(m), error: m => errors.push(m), success() {} }, ElMessageBox: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/api/physical-workbench-ui.js'), 'utf8'), { window, Vue: { reactive: v => v, onUnmounted: fn => { dispose = fn; } }, URLSearchParams, setInterval: () => 1, clearInterval() {}, setTimeout, URL });
  return { ui: window.LXM_PHYSICAL_WORKBENCH_SETUP(ctx), calls, messages, errors, dispose: () => dispose() };
}
test('physical shipping requires carrier and tracking number and never supplies a handler or claim', async () => {
  const f = fixture();
  await f.ui.physicalOpenShip({ id: 'p1', version: 2, allowedActions: ['ship'] });
  assert.equal(f.ui.physical.dialog, 'ship');
  await f.ui.physicalShip();
  assert.equal(f.calls.some(c => c.url.endsWith('/ship')), false);
  assert.equal(f.messages.length, 1);
  Object.assign(f.ui.physical.form, { carrierCode: 'ems', trackingNo: '  EMS12345678CN  ' });
  await f.ui.physicalShip();
  const shipping = f.calls.find(c => c.url.endsWith('/ship'));
  assert.equal(shipping.body.trackingNo, 'EMS12345678CN');
  assert.equal(shipping.body.version, 2);
  assert.equal('handlerId' in shipping.body, false);
  assert.equal(f.calls.some(c => /claim|assign|transfer/.test(c.url)), false);
  f.dispose();
});
test('physical detail and paging use protected physical API, not service claims', async () => {
  const f = fixture();
  await f.ui.physicalType('physical');
  f.ui.physical.page = 3;
  await f.ui.physicalLoad();
  assert.match(f.calls.at(-1).url, /page=3/);
  await f.ui.physicalDetail({ id: 'p1' });
  assert.match(f.calls.at(-1).url, /\/physical\/admin\/detail\?orderId=p1/);
  assert.equal(f.ui.physical.drawer, true);
  f.dispose();
});
test('combined service/physical workbench Vue template compiles', () => {
  const sandbox = { window: {}, console: { info() {}, warn() {}, log() {} }, document: { createElement: () => ({}) } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/vendor/vue.global.js'), 'utf8'), sandbox);
  const errors = [];
  sandbox.Vue.compile(fs.readFileSync(path.join(root, 'src/views/service/workbench/workbench.html'), 'utf8'), { onError: error => errors.push(error.message), decodeEntities: text => text });
  assert.deepEqual(errors, []);
});
