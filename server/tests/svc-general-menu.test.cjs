"use strict";
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { install } = require('../../scripts/install-general-workbench-menu.cjs');
test('new-menu installation is additive and never restores existing grants or changes an existing menu', async () => {
  const calls = [];
  const source = existing => ({ async transaction(work) { return work({ async query(sql, args) { calls.push({ sql, args }); return sql.startsWith('SELECT') ? [existing ? [{ id: 'existing-disabled-menu' }] : []] : [{ affectedRows: 1 }]; } }); } });
  const reused = await install(source(true)); assert.equal(reused.created, false); assert.equal(calls.length, 1);
  calls.length = 0; const created = await install(source(false)); assert.equal(created.created, true); assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every(call => call.sql.startsWith('INSERT'))); assert.ok(calls.slice(1).every(call => call.sql.includes('svcGeneralWorkbench')));
  assert.match(calls[2].sql, /super.*service.*service_supervisor/); assert.doesNotMatch(calls[2].sql, /finance|photo|content/);
});
test('new menu is first in its group but original role home routes and original grants remain', () => {
  const config = { groups: ['客服工作台'], routeMenuKeys: [], menus: [], roles: { super: { home: 'dashboard', menus: ['dashboard'] }, service: { home: 'svcWorkbench', menus: [] }, finance: { home: 'financeReview', menus: [] } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../src/config/customer-service.js'), 'utf8'), { LXM_CONFIG: config });
  assert.equal(config.menus[0].key, 'svcGeneralWorkbench'); assert.equal(config.roles.super.home, 'dashboard'); assert.equal(config.roles.service.home, 'svcWorkbench');
  assert.ok(config.roles.service.menus.includes('svcGeneralWorkbench')); assert.ok(!config.roles.finance.menus.includes('svcGeneralWorkbench'));
  for (const key of ['svcWorkbench', 'productLinks', 'svcIntake', 'svcFollowup', 'svcComplaints']) assert.ok(config.roles.service.menus.includes(key));
});
