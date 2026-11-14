"use strict";

// Explicit operator-run migration. Default is read-only; never runs at startup.
const { createShareStore } = require("../server/lib/shareStore.cjs");
const { SHARE_ROUTES } = require("../server/lib/merchantShare.cjs");

function parseArgs(args) {
  const apply=args.includes('--apply');
  const reset=args.includes('--reset-legacy');
  const confirmation=args[args.indexOf('--confirm')+1];
  const options={apply,reset,confirmation,backupConfirmed:args.includes('--backup-confirmed')};
  validateReset(options);
  return options;
}
function validateReset(options) {
  if(options.apply && options.reset && (options.confirmation!=='RESET_MERCHANT_SHARE' || options.backupConfirmed!==true)) throw new Error('清理旧账号及旧商家金额需 --confirm RESET_MERCHANT_SHARE --backup-confirmed，且先完成可恢复的数据库备份');
}
async function inspect(source) {
  return source.transaction(async conn=>{
    const [users]=await conn.query("SELECT COUNT(*) count FROM lxm_auth_users u LEFT JOIN lxm_auth_roles r ON r.id=u.role_id WHERE COALESCE(r.role_key,'')<>'super'");
    const [roles]=await conn.query("SELECT COUNT(*) count FROM lxm_auth_roles WHERE role_key<>'super'");
    const [shops]=await conn.query('SELECT COUNT(*) count FROM lxm_shops');
    const [ledger]=await conn.query("SELECT COUNT(*) count,COALESCE(SUM(amount),0) amount FROM lxm_reconciliationTransfers WHERE objectType IN ('商家','shop','merchant')");
    return {nonSuperAccounts:Number(users[0].count),nonSuperRoles:Number(roles[0].count),legacyShops:Number(shops[0].count),legacyMerchantTransfers:Number(ledger[0].count),legacyMerchantAmount:String(ledger[0].amount)};
  });
}
async function migrate(source, options) {
  validateReset(options);
  if(!options.apply) return {dryRun:true,schema:'015_merchant_share.sql',menus:SHARE_ROUTES,resetLegacy:options.reset,counts:await inspect(source)};
  const store=createShareStore(source);
  await store.ensureSchema();
  const immutableSql=require('node:fs').readFileSync(require('node:path').join(__dirname,'../server/migrations/016_share_immutability.sql'),'utf8').replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
  await source.transaction(async conn=>{for(const sql of immutableSql) await conn.query(sql);});
  return source.transaction(async conn=>{
    const [admins]=await conn.query("SELECT u.id,u.role_id FROM lxm_auth_users u JOIN lxm_auth_roles r ON r.id=u.role_id WHERE LOWER(u.account)='admin' AND r.role_key='super' AND u.status='active' FOR UPDATE");
    if(admins.length!==1) throw new Error('必须存在唯一有效的内置admin超管，迁移未执行');
    const admin=admins[0];
    for(const [index,[key,name]] of [['shareRules','配置列表'],['shareDetails','分成明细'],['shareMine','商家端']].entries()) {
      await conn.query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES (?,?,?,?,?,'active','商家分成管理','page') ON DUPLICATE KEY UPDATE name=VALUES(name),status='active',meta_group='商家分成管理'",[`menu_${key}`,key,name,`/share/${['rule','detail','mine'][index]}`,200+index]);
      await conn.query('INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) VALUES (?,?)',[admin.role_id,key]);
    }
    await conn.query("UPDATE lxm_auth_menus SET status='disabled' WHERE menu_key='shops'");
    let resetApplied=false;
    if(options.reset) {
      const [previous]=await conn.query("SELECT id FROM lxm_share_audit WHERE action='LEGACY_RESET_APPLIED' LIMIT 1");
      if(!previous.length) {
        const [newMerchants]=await conn.query('SELECT COUNT(*) count FROM lxm_share_merchant');
        if(Number(newMerchants[0].count)) throw new Error('已存在新商家，禁止再清理账号；请核查切换顺序');
        // N14 retains every account attached to a super role, including disabled
        // accounts without changing their status. The builtin admin is an anchor,
        // not the complete retention set. Business staff records remain untouched.
        const [superRoles]=await conn.query("SELECT id FROM lxm_auth_roles WHERE role_key='super' FOR UPDATE");
        const superRoleIds=superRoles.map(role=>String(role.id));
        if(!superRoleIds.length || !superRoleIds.includes(String(admin.role_id))) throw new Error('超管保留集合异常，清理未执行');
        const roleSlots=superRoleIds.map(()=>'?').join(',');
        const [superUsers]=await conn.query(`SELECT id FROM lxm_auth_users WHERE role_id IN (${roleSlots}) FOR UPDATE`,superRoleIds);
        const superUserIds=superUsers.map(user=>String(user.id));
        if(!superUserIds.includes(String(admin.id))) throw new Error('内置admin不在超管保留集合中，清理未执行');
        const userSlots=superUserIds.map(()=>'?').join(',');
        await conn.query(`DELETE FROM lxm_auth_user_attributes WHERE user_id NOT IN (${userSlots})`,superUserIds);
        await conn.query(`DELETE FROM lxm_auth_user_permissions WHERE user_id NOT IN (${userSlots})`,superUserIds);
        await conn.query(`DELETE FROM lxm_auth_users WHERE role_id NOT IN (${roleSlots})`,superRoleIds);
        await conn.query(`DELETE FROM lxm_auth_role_menus WHERE role_id NOT IN (${roleSlots})`,superRoleIds);
        await conn.query(`DELETE FROM lxm_auth_role_permissions WHERE role_id NOT IN (${roleSlots})`,superRoleIds);
        await conn.query(`DELETE FROM lxm_auth_roles WHERE id NOT IN (${roleSlots})`,superRoleIds);
        await conn.query('UPDATE lxm_shops SET commissionRate=0,shareRatio=0');
        await conn.query("UPDATE lxm_reconciliationTransfers SET amount=0,status='已清零' WHERE objectType IN ('商家','shop','merchant')");
        await conn.query("UPDATE lxm_adjustmentRecords SET amount=0 WHERE targetType IN ('商家','shop','merchant')");
        await conn.query("INSERT INTO lxm_share_audit (action,subject_id,operator_id,payload_json,created_at) VALUES ('LEGACY_RESET_APPLIED',?,?,?,UTC_TIMESTAMP(3))",[admin.id,admin.id,JSON.stringify({reason:'用户确认N14/N15：只保留超管、旧商家分佣及未结金额清零',backupConfirmed:true})]);
        resetApplied=true;
      }
    }
    return {applied:true,schema:'015_merchant_share.sql',menus:SHARE_ROUTES,resetApplied,enableAtConfigured:!!process.env.SHARE_ENABLE_AT};
  });
}
async function main() {
  if(process.argv.includes('--help')) {console.log('node scripts/migrate-merchant-share.cjs [--apply] [--reset-legacy --confirm RESET_MERCHANT_SHARE --backup-confirmed]\n默认只读预检；--apply创建分成表与菜单；清理旧账号/旧商家金额必须另显式确认且先完成数据库备份。');return;}
  const options=parseArgs(process.argv.slice(2));
  require('dotenv').config({quiet:true});
  const {source}=require('../server/lib/selectSource.cjs')();
  try {console.log(JSON.stringify(await migrate(source,options),null,2));}
  finally {if(source.close) await source.close();}
}
if(require.main===module) main().catch(error=>{console.error(JSON.stringify({error:error.code || 'SHARE_MIGRATION_FAILED',message:/清理|备份|超管|新商家|顺序/.test(error.message)?error.message:'迁移失败，请核对数据库结构及权限；未输出数据库凭据'}));process.exitCode=1;});
module.exports={parseArgs,inspect,migrate};
