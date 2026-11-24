"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const createApi = require("../lib/api.cjs"), physical = require("../lib/physicalCommerce.cjs");
async function fixture(t) {
  const staff = [{ id: 'admin', role: 'super', name: '管理员' }, { id: 'PH00000001', role: 'photo', name: '摄影师' }];
  const source = { list: async key => key === 'staff' ? staff : [], get: async (key, id) => key === 'staff' ? staff.find(row => row.id === id) || null : null };
  const sessions = {
    owner: { kind: "public", openid: "owner" }, stranger: { kind: "public", openid: "stranger" },
    admin: { kind: "admin", role: "super", subjectId: "admin", name: "管理员", menuKeys: ["svcWorkbench"] },
    photo: { kind: "admin", role: "photo", subjectId: "PH00000001", menuKeys: ["svcWorkbench"] },
  };
  const calls = [];
  const physicalService = { async executeAdmin(action, body, session) { calls.push({ action, body, session }); return { items: [], total: 0 }; }, async receiveLogisticsNotification(subscriptionId, body) { calls.push({ subscriptionId, body }); } };
  const auth = { async init() {}, async getSession(token) { return sessions[token] || null; } };
  const store = physical.createMemoryStore();
  const fileCalls = [];
  const fileService = { async assertFiles(session, ids, scope) { fileCalls.push({ session, ids, scope }); if (ids.some(id => id !== 'own-evidence')) throw Object.assign(new Error('文件不属于当前订单'), { code: 'FILE_SCOPE', statusCode: 403 }); }, async markBound(ids) { fileCalls.push({ bound: ids }); } };
  const handler = createApi(source, "test", { auth, permissionStore: null, physicalService, fileService, physicalOptions: { store }, sourceStatus: { ready: true } });
  const server = http.createServer((req, res) => handler(req, res, req.url.split('?')[0]));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(route, token, body, method = body == null ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + route, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body != null ? { 'Content-Type': 'application/json' } : {}) }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { request, calls, source, store, fileCalls };
}
test('physical RPC requires verified user session and ignores supplied owner', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/rpc/getShippingAddresses', null, { openid: 'owner' })).status, 401);
  const saved = await f.request('/api/rpc/saveShippingAddress', 'owner', { data: { openid: 'stranger', recipient: '收件人', phone: '13800000001', province: '湖南省', city: '长沙市', district: '岳麓区', detail: '测试路一号门牌' } });
  assert.equal(saved.body.success, true, JSON.stringify(saved));
  const own = await f.request('/api/rpc/getShippingAddresses', 'owner', {});
  const other = await f.request('/api/rpc/getShippingAddresses', 'stranger', { openid: 'owner' });
  assert.equal(own.body.data.items.length, 1);
  assert.equal(other.body.data.items.length, 0);
});
test('physical workbench routes reject unauthorized roles and enforce HTTP methods', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/physical/admin/list')).status, 401);
  assert.equal((await f.request('/api/physical/admin/list', 'photo')).status, 403);
  assert.equal((await f.request('/api/physical/admin/ship', 'admin')).status, 405);
  assert.equal((await f.request('/api/physical/admin/ship', 'admin', { orderId: 'one', carrierCode: 'ems', trackingNo: 'EMS12345678' })).body.code, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].session.subjectId, 'admin');
});
test('physical aftersale evidence is checked against verified owner and order before creating ticket', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => state.orders.push({ id: 'physical-evidence', orderNo: 'PGEVIDENCE', openid: 'owner', status: 'awaiting_shipment', items: [{ id: 'one', skuId: 'sku', quantity: 1, refundedQuantity: 0, priceFen: 100 }], version: 1, address: {}, totalAmountFen: 100, goodsAmountFen: 100, shippingFeeFen: 0, refundedFen: 0 }));
  const input = { orderId: 'physical-evidence', reason: '商品需要申请退回', attachmentFileIds: ['other-evidence'] };
  const denied = await f.request('/api/rpc/createPhysicalAfterSale', 'owner', input);
  assert.equal(denied.body.success, false);
  assert.equal(f.store.snapshot().afterSales.length, 0);
  const accepted = await f.request('/api/rpc/createPhysicalAfterSale', 'owner', { ...input, attachmentFileIds: ['own-evidence'] });
  assert.equal(accepted.body.success, true, JSON.stringify(accepted));
  assert.equal(f.fileCalls.at(-2).session.openid, 'owner');
  assert.equal(f.fileCalls.at(-2).scope.orderId, 'physical-evidence');
  assert.deepEqual(f.fileCalls.at(-1).bound, ['own-evidence']);
});
