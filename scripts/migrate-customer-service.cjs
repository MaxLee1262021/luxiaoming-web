"use strict";
// Explicit installation only; default invocation never mutates the database.
const fs = require('node:fs');
const path = require('node:path');
const {menus} = require('../server/lib/customerService.cjs');
async function ensureOrderCapacity(conn) {
  // The established orders table is close to MySQL's declared row-size limit.
  // These two nullable display strings have no indexes and no numeric semantics.
  // Widening VARCHAR to TEXT preserves every value while freeing row capacity.
  for(const column of ['sourceName','seriesName']) {
    const [rows]=await conn.query('SELECT DATA_TYPE data_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',['lxm_orders',column]);
    if(!rows.length || String(rows[0].data_type || rows[0].DATA_TYPE).toLowerCase() !== 'varchar')continue;
    const [indexes]=await conn.query('SELECT INDEX_NAME index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',['lxm_orders',column]);
    if(indexes.length)throw Object.assign(new Error('订单兼容字段存在索引，需单独审查'),{code:'SVC_ORDER_CAPACITY_INDEXED'});
    await conn.query(`ALTER TABLE lxm_orders MODIFY COLUMN \`${column}\` TEXT NULL`);
  }
}
function statements(file) { return fs.readFileSync(file,'utf8').replace(/^\s*--[^\n]*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean); }
async function applyStatement(conn,statement) {
  const alter = statement.match(/^ALTER TABLE\s+`?(\w+)`?\s+([\s\S]+)$/i);
  if (alter) {
    const table=alter[1], body=alter[2];
    // Split only at ADD clauses; commas inside indexes and types stay intact.
    for (const part of body.split(/,\s*(?=ADD\s)/i)) {
      const column=part.match(/^ADD COLUMN\s+`?(\w+)`?/i), index=part.match(/^ADD (?:UNIQUE )?KEY\s+`?(\w+)`?/i);
      if (!column && !index) throw new Error('Unsupported migration clause');
      const [rows]=await conn.query(column?'SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?':'SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?',[table,(column||index)[1]]);
      if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ${part}`);
    }
  } else await conn.query(statement.replace(/^CREATE TABLE (?!IF NOT EXISTS)/i,'CREATE TABLE IF NOT EXISTS ').replace(/^INSERT INTO svc_runtime_lock/i,'INSERT IGNORE INTO svc_runtime_lock'));
}
async function migrate(source,options={}) {
  const files=['017_customer_service.sql','018_service_benefit.sql','020_service_confirmed.sql','021_svc_staff_settlement_cycle.sql','022_svc_staff_timing.sql'];
  const approved = require('../server/lib/svcApproved.cjs');
  if (!options.apply) return {dryRun:true,migrations:files,storageCompatibility:{ordersTextColumns:['sourceName','seriesName']},menus:menus.map(([key])=>key),approvedInitialRates:approved.INITIAL_RATES,activationRequired:'SVC_ENABLE_AT (ISO8601 with +08:00)',historicalBindingsCreated:false};
  const B=require('../server/lib/svcBenefit.cjs'), c=require('../server/lib/svcCore.cjs');
  if (!options.enableAt || !/[Zz]|[+-]\d{2}:\d{2}$/.test(options.enableAt)) throw new Error('请提供含时区的 --enable-at');
  const activeAt=c.stamp(options.enableAt), rates=B.ratesOf(options.rates || approved.INITIAL_RATES);
  await source.transaction(async conn=>{await ensureOrderCapacity(conn);for(const file of files)for(const statement of statements(path.join(__dirname,'../server/migrations',file)))await applyStatement(conn,statement);});
  return source.transaction(async conn=>{
    await conn.query('SELECT id FROM svc_runtime_lock WHERE id=1 FOR UPDATE');
    const [[{count}]]=await conn.query("SELECT COUNT(*) count FROM benefit_rule WHERE beneficiary_type='service' AND party_id IS NULL");
    const [[{max_ver}]]=await conn.query('SELECT COALESCE(MAX(ver),0) max_ver FROM benefit_rule');
    if (!Number(count)) await conn.query('INSERT INTO benefit_rule (ver,beneficiary_type,party_id,rule_mode,rate_photo_bp,rate_video_bp,rate_combo_bp,rate_peripheral_bp,eff_at,reason,operator) VALUES (?,\'service\',NULL,\'global\',?,?,?,?,?,\'上线初始化\',\'migration\')',[Number(max_ver)+1,rates.rate_photo_bp,rates.rate_video_bp,rates.rate_combo_bp,rates.rate_peripheral_bp,activeAt]);
    const [[config]]=await conn.query('SELECT COUNT(*) count FROM svc_config');
    if (!Number(config.count)) await conn.query('INSERT INTO svc_config (ver,eff_at,operator) VALUES (1,?,\'migration\')',[activeAt]);
    for(const [i,[key,name,group]] of menus.entries()) {
      await conn.query("INSERT INTO lxm_auth_menus (id,menu_key,name,path,sort_no,status,meta_group,meta_type) VALUES (?,?,?,?,?,'active',?,'page') ON DUPLICATE KEY UPDATE name=VALUES(name),meta_group=VALUES(meta_group)",['menu_'+key,key,name,'/service/'+key,230+i,group]);
      const roles=key==='svcMine'?['super','service','service_supervisor']:['svcComplaints','svcLedger','svcSettlements'].includes(key)?['super','finance',...(key==='svcComplaints'?['service','service_supervisor']:['svcLedger'].includes(key)?['service_supervisor']:[])]:['svcRules','svcStaffNew'].includes(key)?['super']:key==='svcStaff'?['super','service_supervisor']:['super','service','service_supervisor'];
      for(const role of roles) await conn.query('INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) SELECT id,? FROM lxm_auth_roles WHERE role_key=?',[key,role]);
    }
    return {applied:true,migrations:files,activation:activeAt,menus:menus.length,existingRulesPreserved:!!Number(count),historicalBindingsCreated:false};
  });
}
async function main() {
  const args=process.argv.slice(2),value=key=>args.includes(key)?args[args.indexOf(key)+1]:null;
  if(args.includes('--help')) { console.log('默认只读：node scripts/migrate-customer-service.cjs\n安装：--apply --enable-at <含时区ISO时间>\n业务已确认初始比例：照片5%、视频10%、套餐8%、周边15%。可选--rates <四类bp整数>。\n已有规则不覆盖；DDL可重入；不重算历史、不批量建绑。');return; }
  if(!args.includes('--apply')){console.log(JSON.stringify(await migrate(null),null,2));return;}
  const parts=value('--rates')?.split(',');if(parts && parts.length!==4)throw new Error('必须提供四类初始比例 --rates（万分位整数）');
  const rates=parts ? Object.fromEntries(['photo','video','combo','peripheral'].map((k,i)=>[k+'_bp',parts[i]])) : require('../server/lib/svcApproved.cjs').INITIAL_RATES;
  require('dotenv').config({quiet:true}); const {source}=require('../server/lib/selectSource.cjs')();
  try{console.log(JSON.stringify(await migrate(source,{apply:true,enableAt:value('--enable-at'),rates}),null,2));}finally{await source.close?.();}
}
if(require.main===module) main().catch(error=>{console.error(JSON.stringify({code:error.code||'SVC_MIGRATION_FAILED',message:/必须|提供|时区/.test(error.message)?error.message:'迁移失败，请检查数据库版本与权限；未输出连接凭据'}));process.exitCode=1;});
module.exports={migrate,applyStatement,statements,ensureOrderCapacity};
