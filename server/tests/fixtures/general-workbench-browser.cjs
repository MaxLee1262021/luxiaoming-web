"use strict";
// Test-only synthetic data and memory storage; never opens an application DB.
const { createSvcMemoryStore } = require('../../lib/svcStore.cjs');
const { createSvcWorkbench } = require('../../lib/svcWorkbench.cjs');
const commission = require('../../lib/svcCommission.cjs');
const core = require('../../lib/svcCore.cjs');
const { startBrowserFixture } = require('./merchant-share-browser.cjs');
async function startGeneralFixture() {
  const at = (days, hour = 14) => { const date = new Date(Date.now() + days * 86400000); return core.stamp(date).slice(0, 10) + ` ${String(hour).padStart(2, '0')}:00:00`; };
  const base = { customer_name: 'QA客人', phone: '13912345678', customer_openid: 'oSyntheticCustomer', category: 'photo', product_name: 'QA摄影服务', paid_at: core.stamp(Date.now() - 3600000), created_at: core.stamp(Date.now() - 3600000), svc_paid_processed: 1, service_managed: true, net_amount_fen: 10000, totalAmount: 100, depositDue: 20, depositPaid: 20, depositFinanceStatus: 'confirmed', finalDue: 80, finalPaid: 0, finalFinanceStatus: 'pending', requested_time: at(2), customer_note: '请联系13912345678；座机0731-88886666' };
  const states = ['confirmed', 'shooting', 'claimed', 'new', 'new', 'confirmed', 'final_pending', 'claimed'];
  const ticket = { id: 'qa-ticket-1', orderId: 'qa-order-1', orderNo: 'QA-GENERAL-1', customer: 'QA售后客人', reason: '请联系13912345678确认售后', status: '待处理', amount: 0, type: '投诉反馈', createdAt: core.stamp(Date.now()), contactNote: '联系13912345678' };
  const orders = states.map((service_status, index) => ({ ...base, id: 'qa-order-' + (index + 1), order_no: 'QA-GENERAL-' + (index + 1), customer_openid: 'oSyntheticCustomer' + index, service_status, assignee_id: service_status === 'new' ? null : 'qa-s1', ...(index === 0 || index === 1 || index === 5 || index === 6 ? { photo_id: 'p1', schedule_time: at(2) } : {}) }));
  const store = createSvcMemoryStore({ staff: [{ id: 'qa-s1', account_id: 'qa-super', name: 'QA客服', staff_status: 'active' }], photographers: [{ id: 'p1', name: 'QA摄影师一', status: 'active' }, { id: 'p2', name: 'QA摄影师二', status: 'active' }], orders,
    afterSales: [ticket], configs: [{ id: '1', ...core.DEFAULT_CONFIG, ver: 1, eff_at: '2026-01-01 00:00:00' }], rules: [] });
  const modules = { store, workbench: createSvcWorkbench({ store, benefit: commission }), commission: commission.createSvcCommission({ store }) };
  const fixture = await startBrowserFixture({ customerService: modules });
  for (const order of orders) await fixture.source.create('orders', { ...order, orderNo: order.order_no, assigneeId: 'qa-super', status: order.service_status, appointmentAt: order.requested_time });
  await fixture.source.create('afterSales', ticket);
  return { ...fixture, store, modules, at };
}
module.exports = { startGeneralFixture };
