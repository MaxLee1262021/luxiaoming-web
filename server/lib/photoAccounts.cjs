"use strict";

const crypto = require("node:crypto");
const { hashPassword } = require("./mysqlPermissionStore.cjs");
const { isBuiltinAdminAccount } = require("./permissionStore.cjs");
const { failure } = require("./svcBenefit.cjs");

function accountFailure(message, field) { return failure(4315, message, 200, field ? { field } : undefined); }
function validatePhotoAccountName(input = {}) {
  const account = String(input.account ?? "").trim();
  if (!account || account.length > 128 || /[\u0000-\u001f\u007f]/.test(account)) throw accountFailure("请填写128个字符以内的登录账号", "account");
  if (isBuiltinAdminAccount(account)) throw accountFailure("该登录账号为平台保留，请更换摄影师账号", "account");
  return account;
}
function validatePhotoCredentials(input = {}) {
  const account = validatePhotoAccountName(input), password = String(input.password ?? "");
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw accountFailure("密码须为8–128位且包含字母和数字", "password");
  return { account, password };
}
function validatePhotoAccountInput(input = {}) {
  if (input.create_account !== undefined && typeof input.create_account !== "boolean") throw accountFailure("请选择新建登录账号或关联已有账号", "create_account");
  if (input.create_account !== false) {
    if (String(input.account_id ?? "").trim()) throw accountFailure("新建登录账号不能同时关联已有账号 ID", "account");
    return validatePhotoCredentials(input);
  }
  const account = validatePhotoAccountName(input);
  if (String(input.password ?? "")) throw accountFailure("关联已有账号时无需填写密码，请使用原账号密码登录", "password");
  return { account, ...(input.account_id ? { account_id: String(input.account_id).trim() } : {}) };
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
    await query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES ('menu_photoMine','photoMine','摄影端','/photo-share/mine',275,'active','摄影师分成管理','page')");
  }
  // The API always confines the photo role to /photo/me, its own CSV and auth.
  // Existing role grants and legacy accounts are preserved, never rewritten.
  await query("INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) VALUES (?,'photoMine')", [roleId]);
  const existing = await query("SELECT id FROM lxm_auth_users WHERE account=? OR (subject_type='photo' AND subject_id=?) FOR UPDATE", [account, profile.id]);
  if (existing.length) throw accountFailure("登录账号或摄影师绑定已存在，请更换账号或选择关联已有账号", "account");
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

async function linkPhotoAccount(conn, profile, input) {
  if (!conn || typeof conn.query !== "function") throw failure(4399, "摄影师账号需与档案在同一数据库事务内关联", 503);
  const account = validatePhotoAccountName(input);
  if (!/^PH\d{8}$/.test(profile.id)) throw accountFailure("摄影师编号无效，不能关联登录账号");
  const query = async (sql, params = []) => (await conn.query(sql, params))[0];
  const users = await query("SELECT id,account,role_id,status,subject_type,subject_id,legacy_key,legacy_id FROM lxm_auth_users WHERE account=? FOR UPDATE", [account]);
  if (users.length !== 1 || !["active", "正常", "启用"].includes(String(users[0].status))) throw accountFailure("后台账号不存在或已停用，请在权限管理中检查", "account");
  const user = users[0];
  if (input.account_id && String(input.account_id) !== String(user.id)) throw accountFailure("后台账号与关联账号不一致", "account");
  const roles = await query("SELECT id,role_key,status FROM lxm_auth_roles WHERE id=? FOR UPDATE", [user.role_id]);
  if (roles.length !== 1 || !["photo", "photographer"].includes(String(roles[0].role_key)) || roles[0].status !== "active") throw accountFailure("该账号须绑定已启用的摄影师角色，请在权限管理中检查", "account");
  const subjectType = String(user.subject_type || ""), storedSubjectId = String(user.subject_id || ""), subjectId = storedSubjectId || String(user.legacy_id || user.id);
  if (!["", "staff", "photo"].includes(subjectType) || subjectType === "photo" && storedSubjectId || /^PH\d{8}$/.test(subjectId) || user.legacy_key && user.legacy_key !== "staff") throw accountFailure("该账号已绑定其他档案，不能重复关联", "account");
  const staff = subjectId ? await query("SELECT id,account,role,status FROM lxm_staff WHERE id=? FOR UPDATE", [subjectId]) : [];
  let legacyStaffId = null;
  if (staff.length) {
    const legacy = staff[0];
    if (staff.length !== 1 || !["photo", "photographer"].includes(String(legacy.role)) || String(legacy.account || "").toLowerCase() !== String(user.account).toLowerCase() || !["active", "正常", "启用"].includes(String(legacy.status || "active"))) throw accountFailure("该账号已绑定其他人员档案或人员已停用，不能关联", "account");
    legacyStaffId = String(legacy.id);
    if (user.legacy_id && String(user.legacy_id) !== legacyStaffId) throw accountFailure("该账号的历史人员关联不一致，请在权限管理中检查", "account");
  } else if (subjectId && subjectId !== String(user.id)) throw accountFailure("该账号已有人员绑定，请先在权限管理中检查", "account");
  const serviceProfiles = await query("SELECT id FROM svc_staff WHERE account_id=? FOR UPDATE", [user.id]);
  if (serviceProfiles.length) throw accountFailure("该账号已绑定客服档案，不能重复关联", "account");
  const bound = await query("SELECT id FROM lxm_auth_users WHERE subject_type='photo' AND subject_id=? FOR UPDATE", [profile.id]);
  if (bound.length) throw accountFailure("摄影师档案已有账号绑定，不能重复关联", "account");
  // Keep the existing credential, role, contact information and grants. Only
  // replace an unbound/legacy photographer identity with its new PH identity.
  const result = legacyStaffId
    ? await query("UPDATE lxm_auth_users SET `subject_type`=?,`subject_id`=?,`legacy_key`=?,`legacy_id`=? WHERE `id`=?", ["photo", profile.id, "staff", legacyStaffId, user.id])
    : await query("UPDATE lxm_auth_users SET `subject_type`=?,`subject_id`=? WHERE `id`=?", ["photo", profile.id, user.id]);
  if (Number(result.affectedRows) !== 1) throw failure(4399, "摄影师账号关联未完成，建档已回滚", 503);
  return { account: user.account, account_id: String(user.id), account_created: false, account_linked: true, legacy_staff_id: legacyStaffId };
}

module.exports = { provisionPhotoAccount, linkPhotoAccount, requirePhotoAdministrator, validatePhotoCredentials, validatePhotoAccountInput };
