"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, migrate } = require("../../scripts/migrate-merchant-share.cjs");

function fixture() {
  let state = {
    lxm_auth_users: [{ id: "admin-id", account: "admin", role_id: "super-role", status: "active" }, { id: "old-super", account: "other-super", role_id: "super-role", status: "active" }, { id: "old-member", account: "old-member", role_id: "member-role", status: "active" }],
    lxm_auth_roles: [{ id: "super-role", role_key: "super" }, { id: "member-role", role_key: "service" }],
    lxm_auth_user_attributes: [{ user_id: "admin-id" }, { user_id: "old-super" }, { user_id: "old-member" }], lxm_auth_user_permissions: [{ user_id: "admin-id" }, { user_id: "old-super" }, { user_id: "old-member" }],
    lxm_staff: [{ id: "business-staff", name: "保留业务人员记录" }],
    lxm_auth_role_menus: [{ role_id: "super-role", menu_key: "dashboard" }, { role_id: "member-role", menu_key: "orders" }],
    lxm_auth_role_permissions: [{ role_id: "super-role", permission_key: "old-grant" }, { role_id: "member-role", permission_key: "old-grant" }],
    lxm_auth_menus: [{ id: "old-shops", menu_key: "shops", status: "active" }],
    lxm_shops: [{ id: "old-shop", commissionRate: 20, shareRatio: 15 }],
    lxm_reconciliationTransfers: [{ id: "old-shop-transfer", objectType: "商家", amount: 25 }, { id: "photo-transfer", objectType: "摄影", amount: 30 }],
    lxm_adjustmentRecords: [{ id: "shop-adjust", targetType: "商家", amount: 3 }, { id: "photo-adjust", targetType: "摄影", amount: 4 }],
    lxm_share_audit: [], lxm_share_merchant: [],
  };
  const calls = []; let failAudit = false;
  const conn = { query: async (sql, params = []) => {
    calls.push(sql);
    const create = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/);
    if (create) { state[create[1]] ||= []; return [{ affectedRows: 0 }]; }
    if (/^(?:DROP TRIGGER IF EXISTS|CREATE TRIGGER) lxm_share_(?:snapshot|audit|correction)_no_(?:update|delete)/.test(sql)) return [{ affectedRows: 0 }];
    if (/SELECT COUNT.*lxm_auth_users/.test(sql)) return [[{ count: state.lxm_auth_users.filter(user => !state.lxm_auth_roles.some(role => role.id === user.role_id && role.role_key === "super")).length }]];
    if (/SELECT COUNT.*lxm_auth_roles/.test(sql)) return [[{ count: state.lxm_auth_roles.filter(row => row.role_key !== "super").length }]];
    if (/SELECT COUNT.*lxm_shops/.test(sql)) return [[{ count: state.lxm_shops.length }]];
    if (/SELECT COUNT.*lxm_reconciliationTransfers/.test(sql)) { const rows = state.lxm_reconciliationTransfers.filter(row => ["商家", "shop", "merchant"].includes(row.objectType)); return [[{ count: rows.length, amount: rows.reduce((sum, row) => sum + row.amount, 0) }]]; }
    if (/SELECT u.id,u.role_id.*JOIN lxm_auth_roles/.test(sql)) return [state.lxm_auth_users.filter(user => user.account.toLowerCase() === "admin" && user.status === "active" && state.lxm_auth_roles.some(role => role.id === user.role_id && role.role_key === "super")).map(user => ({ id: user.id, role_id: user.role_id }))];
    if (/SELECT id FROM lxm_auth_roles WHERE role_key='super'/.test(sql)) return [state.lxm_auth_roles.filter(role => role.role_key === "super").map(role => ({ id: role.id }))];
    if (/SELECT id FROM lxm_auth_users WHERE role_id IN/.test(sql)) return [state.lxm_auth_users.filter(user => params.includes(user.role_id)).map(user => ({ id: user.id }))];
    if (/SELECT id FROM lxm_share_audit/.test(sql)) return [state.lxm_share_audit.filter(row => row.action === "LEGACY_RESET_APPLIED").slice(0, 1)];
    if (/SELECT COUNT.*lxm_share_merchant/.test(sql)) return [[{ count: state.lxm_share_merchant.length }]];
    if (/INSERT INTO lxm_auth_menus/.test(sql)) {
      const current = state.lxm_auth_menus.find(row => row.menu_key === params[1]);
      if (current) Object.assign(current, { name: params[2], status: "active", meta_group: "商家分成管理" });
      else state.lxm_auth_menus.push({ id: params[0], menu_key: params[1], name: params[2], status: "active", meta_group: "商家分成管理" });
      return [{ affectedRows: 1 }];
    }
    if (/INSERT IGNORE INTO lxm_auth_role_menus/.test(sql)) { if (!state.lxm_auth_role_menus.some(row => row.role_id === params[0] && row.menu_key === params[1])) state.lxm_auth_role_menus.push({ role_id: params[0], menu_key: params[1] }); return [{ affectedRows: 1 }]; }
    if (/UPDATE lxm_auth_menus/.test(sql)) { state.lxm_auth_menus.filter(row => row.menu_key === "shops").forEach(row => { row.status = "disabled"; }); return [{ affectedRows: 1 }]; }
    const deletion = sql.match(/^DELETE FROM (\w+) WHERE (\w+) NOT IN \([?,]+\)/);
    if (deletion) { state[deletion[1]] = state[deletion[1]].filter(row => params.includes(row[deletion[2]])); return [{ affectedRows: 1 }]; }
    if (/UPDATE lxm_shops/.test(sql)) { state.lxm_shops.forEach(row => { row.commissionRate = 0; row.shareRatio = 0; }); return [{ affectedRows: 1 }]; }
    if (/UPDATE lxm_reconciliationTransfers/.test(sql)) { state.lxm_reconciliationTransfers.filter(row => ["商家", "shop", "merchant"].includes(row.objectType)).forEach(row => { row.amount = 0; row.status = "已清零"; }); return [{ affectedRows: 1 }]; }
    if (/UPDATE lxm_adjustmentRecords/.test(sql)) { state.lxm_adjustmentRecords.filter(row => ["商家", "shop", "merchant"].includes(row.targetType)).forEach(row => { row.amount = 0; }); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO lxm_share_audit/.test(sql)) {
      if (failAudit) throw Object.assign(new Error("injected reset audit failure"), { code: "ER_TEST_FAILURE" });
      state.lxm_share_audit.push({ id: String(state.lxm_share_audit.length + 1), action: "LEGACY_RESET_APPLIED", subject_id: params[0], operator_id: params[1], payload_json: params[2] }); return [{ insertId: state.lxm_share_audit.length }];
    }
    throw new Error("Unexpected migration SQL: " + sql);
  } };
  const source = { transaction: async work => { const before = structuredClone(state); try { return await work(conn); } catch (error) { state = before; throw error; } } };
  return { source, calls, state: () => state, failAudit: () => { failAudit = true; } };
}
const confirmed = () => parseArgs(["--apply", "--reset-legacy", "--confirm", "RESET_MERCHANT_SHARE", "--backup-confirmed"]);

test("migration is read-only by default, even when previewing the legacy reset", async () => {
  for (const args of [[], ["--reset-legacy"]]) {
    const f = fixture(); const before = structuredClone(f.state());
    const result = await migrate(f.source, parseArgs(args));
    assert.equal(result.dryRun, true); assert.equal(result.counts.nonSuperAccounts, 1);
    assert.equal(Object.hasOwn(result.counts, "nonAdminAccounts"), false);
    assert.equal(result.counts.legacyMerchantAmount, "25");
    assert.deepEqual(f.state(), before); assert.ok(f.calls.every(sql => /^SELECT/.test(sql)));
  }
});

test("CLI and direct migration both require apply, exact confirmation and backup proof before destructive SQL", async () => {
  for (const args of [["--apply", "--reset-legacy"], ["--apply", "--reset-legacy", "--confirm", "WRONG", "--backup-confirmed"], ["--apply", "--reset-legacy", "--confirm", "RESET_MERCHANT_SHARE"]]) assert.throws(() => parseArgs(args), /确认|清理|备份/);
  for (const options of [{ apply: true, reset: true }, { apply: true, reset: true, confirmation: "WRONG", backupConfirmed: true }, { apply: true, reset: true, confirmation: "RESET_MERCHANT_SHARE", backupConfirmed: false }]) {
    const f = fixture(); await assert.rejects(migrate(f.source, options), /清理|备份/); assert.equal(f.calls.length, 0);
  }
});

test("confirmed reset preserves both super accounts and their attributes and grants, while deleting the ordinary account", async () => {
  const f = fixture(); const result = await migrate(f.source, confirmed());
  assert.equal(result.resetApplied, true);
  assert.deepEqual(f.state().lxm_auth_users.map(row => row.id), ["admin-id", "old-super"]);
  assert.deepEqual(f.state().lxm_auth_roles.map(row => row.id), ["super-role"]);
  assert.deepEqual(f.state().lxm_auth_user_attributes, [{ user_id: "admin-id" }, { user_id: "old-super" }]);
  assert.deepEqual(f.state().lxm_auth_user_permissions, [{ user_id: "admin-id" }, { user_id: "old-super" }]);
  assert.deepEqual(f.state().lxm_staff, [{ id: "business-staff", name: "保留业务人员记录" }]);
  assert.equal(f.state().lxm_shops[0].commissionRate, 0); assert.equal(f.state().lxm_shops[0].shareRatio, 0);
  assert.equal(f.state().lxm_reconciliationTransfers.find(row => row.objectType === "商家").amount, 0);
  assert.equal(f.state().lxm_reconciliationTransfers.find(row => row.objectType === "摄影").amount, 30);
  assert.equal(f.state().lxm_adjustmentRecords.find(row => row.targetType === "摄影").amount, 4);
  assert.equal(f.state().lxm_auth_menus.find(row => row.menu_key === "shops").status, "disabled");
  assert.equal(f.state().lxm_share_audit.filter(row => row.action === "LEGACY_RESET_APPLIED").length, 1);
});

test("cleanup retains a disabled super account without re-enabling it", async () => {
  const f = fixture(); f.state().lxm_auth_users.find(user => user.id === "old-super").status = "disabled";
  await migrate(f.source, confirmed());
  assert.deepEqual(f.state().lxm_auth_users.map(user => [user.id, user.status]), [["admin-id", "active"], ["old-super", "disabled"]]);
});

test("cleanup refuses ambiguous built-in admin or existing new merchants and rolls back ordinary changes", async () => {
  for (const mutate of [state => { state.lxm_auth_users[0].status = "disabled"; }, state => { state.lxm_auth_users.push({ id: "duplicate-admin", account: "ADMIN", role_id: "super-role", status: "active" }); }, state => { state.lxm_share_merchant.push({ id: "new-merchant" }); }]) {
    const f = fixture(); mutate(f.state()); const before = structuredClone(f.state().lxm_auth_users);
    await assert.rejects(migrate(f.source, confirmed()), /超管|新商家/);
    assert.deepEqual(f.state().lxm_auth_users, before); assert.equal(f.state().lxm_shops[0].commissionRate, 20);
    assert.equal(f.calls.some(sql => /^DELETE/.test(sql)), false);
  }
});

test("re-running a completed reset preserves all newly onboarded accounts and money", async () => {
  const f = fixture(); await migrate(f.source, confirmed());
  f.state().lxm_share_merchant.push({ id: "new-merchant" });
  f.state().lxm_auth_users.push({ id: "new-user", account: "new-merchant", role_id: "new-role", status: "active" });
  f.state().lxm_auth_roles.push({ id: "new-role", role_key: "merchant" });
  const before = structuredClone(f.state().lxm_auth_users); f.calls.length = 0;
  const result = await migrate(f.source, confirmed());
  assert.equal(result.resetApplied, false); assert.deepEqual(f.state().lxm_auth_users, before);
  assert.equal(f.calls.some(sql => /^DELETE/.test(sql)), false);
  assert.equal(f.state().lxm_share_audit.filter(row => row.action === "LEGACY_RESET_APPLIED").length, 1);
});

test("reset audit failure rolls back identity deletion and old merchant money changes together", async () => {
  const f = fixture(); const before = structuredClone(f.state()); f.failAudit();
  await assert.rejects(migrate(f.source, confirmed()), /injected reset audit failure/);
  for (const table of ["lxm_auth_users", "lxm_auth_roles", "lxm_shops", "lxm_reconciliationTransfers", "lxm_adjustmentRecords"]) assert.deepEqual(f.state()[table], before[table]);
  assert.equal(f.state().lxm_share_audit.length, 0);
});
