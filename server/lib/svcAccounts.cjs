"use strict";

const crypto = require("node:crypto");
const { hashPassword } = require("./mysqlPermissionStore.cjs");
const { isBuiltinAdminAccount } = require("./permissionStore.cjs");
const { failure } = require("./svcBenefit.cjs");

const SERVICE_MENUS = Object.freeze([
  ["svcWorkbench", "工作台", "客服工作台"],
  ["svcIntake", "订单承接", "客服工作台"],
  ["svcFollowup", "跟进与完成", "客服工作台"],
  ["svcComplaints", "客诉与退款", "客服工作台"],
  ["svcMine", "我的分成", "客服分成管理"],
]);

function validateSvcCredentials(input) {
  const account = String(input.account ?? "").trim(), password = String(input.password ?? "");
  if (!account || account.length > 128 || /[\u0000-\u001f\u007f]/.test(account)) throw failure(4014, "请填写128个字符以内的登录账号");
  if (isBuiltinAdminAccount(account)) throw failure(4014, "该登录账号为平台保留，请更换客服账号");
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw failure(4014, "密码须为8–128位且包含字母和数字");
  return { account, password };
}

async function provisionSvcAccount(conn, profile, input) {
  if (!conn || typeof conn.query !== "function") throw failure(5012, "客服登录账号需与档案在同一MySQL事务内创建", 503);
  const { account, password } = validateSvcCredentials(input);
  const query = async (sql, params = []) => (await conn.query(sql, params))[0];
  const roles = await query("SELECT id,role_key,status FROM lxm_auth_roles WHERE role_key='service' FOR UPDATE");
  const newRole = roles.length === 0;
  let roleId;
  if (roles.length) {
    if (roles.length !== 1 || roles[0].status !== "active") throw failure(4014, "客服角色不存在或已停用，请在权限管理中检查后重试");
    roleId = roles[0].id;
  } else {
    roleId = "role_service_" + crypto.randomBytes(12).toString("hex");
    await query("INSERT INTO lxm_auth_roles (id,role_key,name,status,description) VALUES (?,'service','客服','active','客服工作台与本人分成')", [roleId]);
  }
  for (const [index, [key, name, group]] of SERVICE_MENUS.entries()) {
    const menus = await query("SELECT id,status FROM lxm_auth_menus WHERE menu_key=? FOR UPDATE", [key]);
    if (menus.length) {
      if (menus.length !== 1 || menus[0].status !== "active") throw failure(4014, `${name}菜单已停用，请在权限管理中检查后重试`);
    } else {
      await query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES (?,?,?,?,?,'active',?,'page')",
        ["menu_" + key, key, name, "/service/" + key, 230 + index, group]);
    }
    // Existing role grants belong to permission management. Onboarding must
    // never restore permissions intentionally removed for all other staff.
    if (newRole) await query("INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) VALUES (?,?)", [roleId, key]);
  }
  const existing = await query("SELECT id FROM lxm_auth_users WHERE account=? OR (subject_type='staff' AND subject_id=?) FOR UPDATE", [account, profile.id]);
  if (existing.length) throw failure(4014, "登录账号已存在，请更换账号或选择关联已有账号");
  const userId = "usr_service_" + crypto.randomBytes(12).toString("hex");
  try {
    await query("INSERT INTO lxm_auth_users (id,account,display_name,password_hash,role_id,status,phone,subject_type,subject_id) VALUES (?,?,?,?,?,'active',?,'staff',?)",
      [userId, account, profile.name, hashPassword(password), roleId, profile.phone, profile.id]);
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw failure(4014, "登录账号已存在，请更换账号或选择关联已有账号");
    throw error;
  }
  // Credentials never enter the profile, accounting state, audit log or response.
  return { account, account_id: userId };
}

module.exports = { provisionSvcAccount, validateSvcCredentials };
