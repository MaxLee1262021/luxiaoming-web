"use strict";

const crypto = require("node:crypto");
const { hashPassword } = require("./mysqlPermissionStore.cjs");
const { isBuiltinAdminAccount } = require("./permissionStore.cjs");
const { failure } = require("./svcBenefit.cjs");

function accountFailure(message, field) { return failure(4315, message, 200, field ? { field } : undefined); }
function validatePhotoCredentials(input = {}) {
  const account = String(input.account ?? "").trim(), password = String(input.password ?? "");
  if (!account || account.length > 128 || /[\u0000-\u001f\u007f]/.test(account)) throw accountFailure("请填写128个字符以内的登录账号", "account");
  if (isBuiltinAdminAccount(account)) throw accountFailure("该登录账号为平台保留，请更换摄影师账号", "account");
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw accountFailure("密码须为8–128位且包含字母和数字", "password");
  return { account, password };
}
function requirePhotoAdministrator(session) {
  if (!session || session.kind === "public" || !["super", "admin", "administrator"].includes(session.role)) throw failure(403, "仅管理员可创建摄影师档案及登录账号", 403);
}
async function provisionPhotoAccount(conn, profile, input) {
  if (!conn || typeof conn.query !== "function") throw failure(4399, "摄影师账号需与档案在同一数据库事务内创建", 503);
  const { account, password } = validatePhotoCredentials(input);
  if (!/^PH\d{8}$/.test(profile.id)) throw accountFailure("摄影师编号无效，不能生成登录账号");
  const query = async (sql, params = []) => (await conn.query(sql, params))[0];
  const roles = await query("SELECT id,role_key,status FROM lxm_auth_roles WHERE role_key='photo' FOR UPDATE");
  let roleId;
  if (roles.length) {
    if (roles.length !== 1 || roles[0].status !== "active") throw accountFailure("摄影师角色未启用，请在权限管理中检查后再建档");
    roleId = roles[0].id;
  } else {
    roleId = "role_photo_" + crypto.randomBytes(12).toString("hex");
    await query("INSERT INTO lxm_auth_roles (id,role_key,name,status,description) VALUES (?,'photo','摄影师','active','外部摄影师，仅查看本人分成')", [roleId]);
  }
  const menus = await query("SELECT id,status FROM lxm_auth_menus WHERE menu_key='photoMine' FOR UPDATE");
  if (menus.length) {
    if (menus.length !== 1 || menus[0].status !== "active") throw accountFailure("我的分成菜单未启用，请在权限管理中检查后再建档");
  } else {
    await query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES ('menu_photoMine','photoMine','我的分成','/photo-share/mine',275,'active','摄影师分成','page')");
  }
  // The API always confines the photo role to /photo/me, its own CSV and auth.
  // Existing role grants and legacy accounts are preserved, never rewritten.
  await query("INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) VALUES (?,'photoMine')", [roleId]);
  const existing = await query("SELECT id FROM lxm_auth_users WHERE account=? OR (subject_type='photo' AND subject_id=?) FOR UPDATE", [account, profile.id]);
  if (existing.length) throw accountFailure("登录账号或摄影师绑定已存在，请更换账号或检查已有绑定", "account");
  const userId = "usr_photo_" + crypto.randomBytes(12).toString("hex");
  try {
    await query("INSERT INTO lxm_auth_users (id,account,display_name,password_hash,role_id,status,phone,subject_type,subject_id) VALUES (?,?,?,?,?,'active',?,'photo',?)",
      [userId, account, profile.name, hashPassword(password), roleId, profile.phone, profile.id]);
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw accountFailure("登录账号已存在，请更换摄影师账号", "account");
    throw error;
  }
  // The administrator supplies the password. Only its hash is persisted and
  // credentials are never copied to profiles, accounting logs or responses.
  return { account, account_id: userId, account_created: true };
}

module.exports = { provisionPhotoAccount, requirePhotoAdministrator, validatePhotoCredentials };
