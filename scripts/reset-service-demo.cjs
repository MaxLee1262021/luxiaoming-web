"use strict";

// User-authorized pre-launch demo cleanup. Default is a read-only manifest.
// No environment option can select this tool from normal application startup.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const PROTECTED = /^(?:lxm_auth_|lxm_logs$|lxm_log_|lxm_share_(?:audit|snapshot|correction)$|photo_profile(?:_log)?$|svc_(?:binding_log|slot_log|assign_log)$|svc_staff(?:_tag|_profile_log)?$|svc_config$|benefit_rule$)/i;
const MAX_ROWS = 200000;
const OPERATION = "RESET_PRELAUNCH_SERVICE_DEMO_V1";
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function quote(value) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value))) throw fail("UNSAFE_IDENTIFIER", "不安全的数据库标识"); return "`" + value + "`"; }
function millis(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || "");
  if (!text) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? text.replace(" ", "T") + "+08:00" : text);
}
function cutoffOf(value) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.\d+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(String(value)) || !Number.isFinite(millis(value))) throw fail("CUTOFF_REQUIRED", "必须指定带时区的准确清理截止时间 --cutoff");
  return new Date(millis(value)).toISOString();
}
function createdBefore(row, cutoff) {
  const value = [row.createTime, row.createdAt, row.created_at, row.time, row.paid_at].map(millis).find(Number.isFinite);
  return value !== undefined && value < millis(cutoff);
}
function nonempty(value) { return value !== null && value !== undefined && String(value) !== ""; }
function onlineEvidence(payment) {
  return /^wechat_pay$/i.test(String(payment.provider || "")) || nonempty(payment.out_trade_no) || nonempty(payment.outTradeNo)
    || /^\d{20,64}$/.test(String(payment.external_transaction_id || payment.externalTransactionId || "")) || String(payment.trade_state || "").toUpperCase() === "SUCCESS";
}
function stableRow(row) { return Object.fromEntries(Object.keys(row).sort().map(key => [key, Buffer.isBuffer(row[key]) ? { binary: row[key].toString("base64") } : row[key]])); }
function primaryKey(row, columns) { return Object.fromEntries(columns.map(key => [key, row[key]])); }
function keyOf(row, columns) { return JSON.stringify(primaryKey(row, columns)); }
function tableOf(snapshot, name) { const table = Object.keys(snapshot.rows).find(table => table.toLowerCase() === name.toLowerCase()); return table || null; }
function rowsOf(snapshot, name) { const table = tableOf(snapshot, name); return table ? snapshot.rows[table] : []; }
function valueOf(row, names) { for (const name of names) if (nonempty(row[name])) return String(row[name]); return ""; }
function related(row, ids, numbers) { return ["order_id", "orderId"].some(key => ids.has(String(row[key] || ""))) || ["order_no", "orderNo", "order_number", "biz_no"].some(key => numbers.has(String(row[key] || ""))); }
function fingerprint(snapshot) { return hash({ identity: snapshot.identity, columns: snapshot.columns, primary: snapshot.primary }); }

function buildPlan(snapshot, options) {
  const cutoff = cutoffOf(options.cutoff), includeOnline = options.includeOnlineTestRecords === true;
  const orderPayments = rowsOf(snapshot, "lxm_order_payment_records"), bookingPayments = rowsOf(snapshot, "lxm_booking_payment_records");
  const leaves = rowsOf(snapshot, "lxm_collection_values");
  const onlineOrders = new Set(orderPayments.filter(onlineEvidence).map(row => String(row.order_id)));
  const onlineBookings = new Set(bookingPayments.filter(onlineEvidence).map(row => String(row.booking_id)));
  for (const leaf of leaves) {
    const collection = String(leaf.collection_name).toLowerCase(), p = String(leaf.path || ""), text = String(leaf.value_text || "");
    if (!/^orders$|^bookingrequests$/.test(collection)) continue;
    if (/paymentRecords.*(?:provider|externalTransactionId|outTradeNo)|refundAttempts|onlineRefund/i.test(p) && (/wechat_pay/i.test(text) || /outTradeNo|externalTransactionId|refundAttempts|onlineRefund/i.test(p) && nonempty(leaf.value_text))) (collection === "orders" ? onlineOrders : onlineBookings).add(String(leaf.record_id));
  }
  const allOrders = rowsOf(snapshot, "lxm_orders"), allBookings = rowsOf(snapshot, "lxm_bookingRequests");
  const oldOrders = allOrders.filter(row => createdBefore(row, cutoff));
  const orders = oldOrders.filter(row => includeOnline || !onlineOrders.has(String(row.id)));
  const orderIds = new Set(orders.map(row => String(row.id))), orderNumbers = new Set(orders.map(row => String(row.orderNo || row.order_no || "")).filter(Boolean));
  const existingOrderIds=new Set(allOrders.map(row=>String(row.id))),existingOrderNumbers=new Set(allOrders.map(row=>String(row.orderNo||row.order_no||'')));
  const orphanOldBill=row=>includeOnline&&createdBefore(row,cutoff)&&!related(row,existingOrderIds,existingOrderNumbers)&&(nonempty(row.orderId)||nonempty(row.orderNo));
  const bookings = allBookings.filter(row => createdBefore(row, cutoff) && (includeOnline || !onlineBookings.has(String(row.id))) && (!row.confirmedOrderId || orderIds.has(String(row.confirmedOrderId))));
  const bookingIds = new Set(bookings.map(row => String(row.id)));
  const selected = {}, blockers = [];
  function select(name, filter) {
    const table = tableOf(snapshot, name); if (!table || PROTECTED.test(table)) return [];
    const items = snapshot.rows[table].filter(filter); if (!items.length) return [];
    if (!snapshot.primary[table]?.length) { blockers.push({ code: "MISSING_PRIMARY_KEY", table, count: items.length }); return []; }
    selected[table] ||= new Map(); for (const row of items) selected[table].set(keyOf(row, snapshot.primary[table]), row); return items;
  }
  select("lxm_orders", row => orderIds.has(String(row.id)));
  select("lxm_bookingRequests", row => bookingIds.has(String(row.id)));
  const afterSales = select("lxm_afterSales", row => related(row, orderIds, orderNumbers)||orphanOldBill(row));
  const saleIds = new Set(afterSales.map(row => String(row.id)));
  const adjustments = select("lxm_adjustmentRecords", row => related(row, orderIds, orderNumbers)||orphanOldBill(row));
  const adjustmentIds = new Set(adjustments.map(row => String(row.id)));
  const ledger = select("benefit_ledger", row => orderNumbers.has(String(row.biz_no)));
  const ledgerIds = new Set(ledger.map(row => String(row.id))), settlementIds = new Set(ledger.map(row => row.settle_id).filter(Boolean).map(String));
  select("svc_adjust", row => orderNumbers.has(String(row.order_no)));
  for (const name of ["svc_settlement", "photo_settlement"]) select(name, row => {
    if (!settlementIds.has(String(row.settle_id))) return false;
    const otherLedger = rowsOf(snapshot, "benefit_ledger").some(item => item.settle_id === row.settle_id && !ledgerIds.has(String(item.id)));
    const otherAdjustment = rowsOf(snapshot, "svc_adjust").some(item => item.settle_id === row.settle_id && !orderNumbers.has(String(item.order_no)));
    if (otherLedger || otherAdjustment) { blockers.push({ code: "MIXED_SETTLEMENT", table: name, count: 1 }); return false; }
    return true;
  });
  select("svc_appeal", row => settlementIds.has(String(row.settle_id)) || ledgerIds.has(String(row.ledger_id)));
  const transfers = rowsOf(snapshot, "lxm_reconciliationTransfers").filter(row => {
    const links = rowsOf(snapshot, "lxm_reconciliation_transfer_orders").filter(link => String(link.transfer_id) === String(row.id));
    if(links.some(link=>related(link,orderIds,orderNumbers)) && links.some(link=>!related(link,orderIds,orderNumbers)))blockers.push({code:'MIXED_TRANSFER',table:'lxm_reconciliationTransfers',count:1});
    return links.length && links.every(link => related(link, orderIds, orderNumbers));
  });
  const transferIds = new Set(transfers.map(row => String(row.id)));
  select("lxm_reconciliationTransfers", row => transferIds.has(String(row.id)));
  const scans = select("lxm_scans", row => orderIds.has(String(row.orderId)));
  const scanIds = new Set(scans.map(row => String(row.id)));
  const media = select("lxm_mediaFiles", row => orderIds.has(String(row.orderId)) || /^orders?$/i.test(row.collection || "") && orderIds.has(String(row.recordId)) || /^afterSales?$/i.test(row.collection || "") && saleIds.has(String(row.recordId)));
  const mediaIds = new Set(media.map(row => String(row.id)));
  const trash = select("lxm_trash", row => /^orders?$/i.test(row.sourceKey || "") && orderIds.has(String(row.sourceId || row.refId)) || /^afterSales?$/i.test(row.sourceKey || "") && saleIds.has(String(row.sourceId || row.refId)));
  const trashIds = new Set(trash.map(row => String(row.id)));
  const retainedCustomers = new Set(allOrders.filter(row => !orderIds.has(String(row.id))).map(row => row.customer_openid || row.openid || row._openid).filter(Boolean).map(String));
  select("svc_binding", row => orderNumbers.has(String(row.source_order_no)) && !retainedCustomers.has(String(row.openid)));
  const collections = { orders: orderIds, bookingrequests: bookingIds, aftersales: saleIds, adjustmentrecords: adjustmentIds, reconciliationtransfers: transferIds, scans: scanIds, mediafiles: mediaIds, trash: trashIds };
  select("lxm_collection_values", row => collections[String(row.collection_name).toLowerCase()]?.has(String(row.record_id)));
  for (const [table, rows] of Object.entries(snapshot.rows)) {
    if (PROTECTED.test(table) || ["lxm_orders", "lxm_bookingrequests", "lxm_collection_values"].includes(table.toLowerCase())) continue;
    if (/^(?:lxm_order_|lxm_share_|svc_|benefit_)/i.test(table)) select(table, row => related(row, orderIds, orderNumbers));
    if (/^lxm_booking_/i.test(table)) select(table, row => bookingIds.has(String(row.booking_id)));
    if (/^lxm_after_sale_/i.test(table)) select(table, row => saleIds.has(String(row.after_sale_id)));
    if (/^lxm_reconciliation_transfer_orders$/i.test(table)) select(table, row => transferIds.has(String(row.transfer_id)));
    if (/^lxm_trash_source_attributes$/i.test(table)) select(table, row => trashIds.has(String(row.trash_id)));
  }
  const entries = Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)).map(([table, rows]) => ({ table, primary: snapshot.primary[table], count: rows.size,
    records: [...rows.values()].map(row => ({ key: primaryKey(row, snapshot.primary[table]), hash: hash(stableRow(row)) })).sort((a,b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key))) }));
  const preservedAudit = Object.entries(snapshot.rows).filter(([table]) => PROTECTED.test(table)).map(([table,rows]) => ({table,count:rows.length}));
  const result = { operation: OPERATION, version: 1, cutoff, includeOnlineTestRecords: includeOnline, databaseFingerprint: fingerprint(snapshot),
    totals: { oldOrders: oldOrders.length, selectedOrders: orders.length, selectedBookings: bookings.length, protectedOnlineOrders: includeOnline ? 0 : oldOrders.filter(row => onlineOrders.has(String(row.id))).length,
      selectedOnlineOrders: orders.filter(row => onlineOrders.has(String(row.id))).length, selectedOnlineBookings: bookings.filter(row => onlineBookings.has(String(row.id))).length, rows: entries.reduce((n,entry)=>n+entry.count,0) },
    entries, blockers, preservedAudit, preservedOss: true, preservedAccountsAndCatalog: true };
  result.manifestHash = hash(result); return result;
}

function summary(plan) { return { operation: plan.operation, cutoff: plan.cutoff, includeOnlineTestRecords: plan.includeOnlineTestRecords, manifestHash: plan.manifestHash, totals: plan.totals,
  tables: plan.entries.map(({table,count})=>({table,count})), blockers: plan.blockers, preservedAudit: plan.preservedAudit.filter(item=>/audit|snapshot|correction/.test(item.table)), preservedOss:true,preservedAccountsAndCatalog:true }; }

async function loadSnapshot(conn, identity, lock = false) {
  const [meta] = await conn.query("SELECT TABLE_NAME,COLUMN_NAME,COLUMN_KEY,EXTRA FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION");
  const columns={}, primary={}, generated={};
  for(const row of meta) { (columns[row.TABLE_NAME]||=[]).push(row.COLUMN_NAME); if(row.COLUMN_KEY==='PRI')(primary[row.TABLE_NAME]||=[]).push(row.COLUMN_NAME); if(/GENERATED/.test(row.EXTRA||''))(generated[row.TABLE_NAME]||=[]).push(row.COLUMN_NAME); }
  const [tables] = await conn.query("SELECT TABLE_NAME,ENGINE FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'");
  const engines=Object.fromEntries(tables.map(row=>[row.TABLE_NAME,row.ENGINE])), rows={};
  const relevant = Object.keys(columns).filter(table=>/^(?:lxm_(?:orders|bookingrequests|aftersales|adjustmentrecords|reconciliationtransfers|order_|booking_|after_sale_|reconciliation_transfer_|collection_values|scans|mediafiles|trash|share_)|svc_|benefit_|photo_settlement)/i.test(table));
  for (const table of relevant.sort()) { const [values]=await conn.query(`SELECT * FROM ${quote(table)} LIMIT ${MAX_ROWS+1}${lock && !PROTECTED.test(table)?' FOR UPDATE':''}`); if(values.length>MAX_ROWS)throw fail('SCOPE_TOO_LARGE','清理范围超过安全上限，请分批建立计划'); rows[table]=values; }
  return {identity,columns,primary,generated,engines,rows,allTables:tables.map(row=>row.TABLE_NAME).sort()};
}
function inside(child,parent) { const c=path.resolve(child).toLowerCase(),p=path.resolve(parent).toLowerCase();return c===p||c.startsWith(p+path.sep); }
async function fullBackup(conn,snapshot,backupDir,manifestHash,mysql) {
  if(!backupDir||inside(backupDir,ROOT))throw fail('PRIVATE_BACKUP_REQUIRED','备份必须存放在项目目录之外');
  await fs.promises.mkdir(backupDir,{recursive:true,mode:0o700});
  const file=path.resolve(backupDir,`service-demo-${Date.now()}-${manifestHash.slice(0,12)}.sql`);
  const stream=fs.createWriteStream(file,{flags:'wx',mode:0o600,encoding:'utf8'});let digest=crypto.createHash('sha256'),rowCount=0;
  async function write(text) {digest.update(text);if(!stream.write(text))await new Promise((resolve,reject)=>{
    const cleanup=()=>{stream.removeListener('drain',drained);stream.removeListener('error',failed);};
    const drained=()=>{cleanup();resolve();},failed=error=>{cleanup();reject(error);};
    stream.once('drain',drained);stream.once('error',failed);
  });}
  const sqlValue=v=>v==null?'NULL':Buffer.isBuffer(v)?`X'${v.toString('hex')}'`:typeof v==='object'?mysql.escape(JSON.stringify(v)):mysql.escape(v);
  try {
    await write(`-- Full database backup before ${OPERATION}\n-- Manifest SHA256 ${manifestHash}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n`);
    for(const table of snapshot.allTables) {
      const [ddl]=await conn.query(`SHOW CREATE TABLE ${quote(table)}`); await write(`\n${ddl[0]['Create Table']};\n`);
      const [values]=await conn.query(`SELECT * FROM ${quote(table)}`);rowCount+=values.length;
      const columns=snapshot.columns[table].filter(key=>!(snapshot.generated[table]||[]).includes(key));
      for(let i=0;i<values.length;i+=100)await write(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES\n${values.slice(i,i+100).map(row=>'('+columns.map(col=>sqlValue(row[col])).join(',')+')').join(',\n')};\n`);
    }
    // Keep original append-only protections in the recovery artifact too.
    const [triggers]=await conn.query('SELECT TRIGGER_NAME FROM information_schema.triggers WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME');
    for(const row of triggers){const [ddl]=await conn.query(`SHOW CREATE TRIGGER ${quote(row.TRIGGER_NAME)}`);const statement=ddl[0]['SQL Original Statement'];if(statement)await write(`\nDELIMITER ;;\n${statement};;\nDELIMITER ;\n`);}
    await write('\nSET FOREIGN_KEY_CHECKS=1;\n');stream.end();await new Promise((resolve,reject)=>{stream.once('finish',resolve);stream.once('error',reject);});
    const sha256=digest.digest('hex'),actual=hash(await fs.promises.readFile(file));if(sha256!==actual)throw fail('BACKUP_VERIFY_FAILED','备份校验失败');
    return {path:file,sha256,tables:snapshot.allTables.length,rows:rowCount};
  }catch(error){stream.destroy();throw error;}
}
const DELETE_LAST = ['lxm_orders','lxm_bookingrequests'];
function deletionOrder(entries) { return [...entries].sort((a,b)=>{const ai=DELETE_LAST.indexOf(a.table.toLowerCase()),bi=DELETE_LAST.indexOf(b.table.toLowerCase());return (ai<0?-1:ai)-(bi<0?-1:bi)||a.table.localeCompare(b.table);}); }
async function applyPlan(conn, manifest, options) {
  if(!manifest || manifest.operation!==OPERATION || manifest.manifestHash!==options.manifestHash)throw fail('MANIFEST_HASH_REQUIRED','必须提供本次清理计划的完整SHA256');
  const copy={...manifest};delete copy.manifestHash;if(hash(copy)!==manifest.manifestHash)throw fail('MANIFEST_TAMPERED','清理计划内容与SHA256不一致');
  const snapshot=await loadSnapshot(conn,options.identity,true),current=buildPlan(snapshot,{cutoff:manifest.cutoff,includeOnlineTestRecords:manifest.includeOnlineTestRecords});
  if(current.manifestHash!==manifest.manifestHash)throw fail('SCOPE_CHANGED','数据已变化，必须重新生成并核对清理计划');
  if(current.blockers.length)throw fail('SCOPE_BLOCKED','存在混合结算或缺失主键，不能安全清理');
  for(const entry of current.entries)if(String(snapshot.engines[entry.table]).toLowerCase()!=='innodb')throw fail('NONTRANSACTIONAL_TABLE','目标表不支持事务，已停止清理');
  const backup=await fullBackup(conn,snapshot,options.backupDir,current.manifestHash,options.mysql);
  let deleted=0;
  for(const entry of deletionOrder(current.entries))for(let offset=0;offset<entry.records.length;offset+=100) {
    const batch=entry.records.slice(offset,offset+100),keys=Object.keys(batch[0].key);
    const where=batch.map(()=>`(${keys.map(k=>quote(k)+' <=> ?').join(' AND ')})`).join(' OR '),params=batch.flatMap(record=>keys.map(k=>record.key[k]));
    const [result]=await conn.query(`DELETE FROM ${quote(entry.table)} WHERE ${where}`,params);
    if(Number(result.affectedRows)!==batch.length)throw fail('DELETE_MISMATCH','清理数量与计划不一致，事务已停止');deleted+=batch.length;
  }
  return {applied:true,cutoff:current.cutoff,manifestHash:current.manifestHash,deletedRows:deleted,backup,preservedOss:true,preservedAudit:true,preservedAccountsAndCatalog:true};
}
function parseArgs(argv) {
  const result={apply:false,includeOnlineTestRecords:false};
  for(let i=0;i<argv.length;i++){const arg=argv[i];if(arg==='--apply')result.apply=true;else if(arg==='--include-online-test-records')result.includeOnlineTestRecords=true;else if(arg==='--help')result.help=true;else if(['--cutoff','--manifest','--hash','--backup-dir','--output'].includes(arg)){if(!argv[i+1]||argv[i+1].startsWith('--'))throw fail('ARGUMENT_REQUIRED','命令参数缺少值');result[{'--cutoff':'cutoff','--manifest':'manifest','--hash':'manifestHash','--backup-dir':'backupDir','--output':'output'}[arg]]=argv[++i];}else throw fail('UNKNOWN_ARGUMENT','不支持的命令参数');}return result;
}
async function main() {
  const options=parseArgs(process.argv.slice(2));
  if(options.help)return console.log('只读清理计划：node scripts/reset-service-demo.cjs --cutoff <ISO时间含时区> [--include-online-test-records] --output <计划JSON>\n执行：--apply --manifest <计划JSON> --hash <计划SHA256> --backup-dir <项目外私有目录>\n默认保护含线上支付证据的记录；已明确确认为测试的线上记录须在生成计划时显式选择。执行先生成全库可恢复SQL备份，保留审计、账号、商品配置及OSS。');
  if(!options.apply&&millis(cutoffOf(options.cutoff))>Date.now())throw fail('CUTOFF_FUTURE','清理截止时间不能晚于当前时间');
  require('dotenv').config({path:path.join(ROOT,'.env'),quiet:true});const mysql=require('mysql2'),promise=require('mysql2/promise');
  const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,connectTimeout:5000,multipleStatements:false};
  if(!config.host||!config.user||!config.database)throw fail('DB_CONFIG_REQUIRED','数据库连接未配置');
  const identity=hash({host:config.host,port:config.port,database:config.database});const conn=await promise.createConnection(config);
  try {
    await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    if(options.apply) {
      if(!options.manifest)throw fail('MANIFEST_REQUIRED','执行清理必须指定计划文件');
      const output=options.output||options.manifest+'.applied.json';if(fs.existsSync(output))throw fail('MANIFEST_RESULT_EXISTS','清理结果文件已存在，拒绝重复执行');
      const manifest=JSON.parse(await fs.promises.readFile(options.manifest,'utf8'));await conn.beginTransaction();
      const result=await applyPlan(conn,manifest,{...options,identity,mysql});await conn.commit();
      await fs.promises.writeFile(output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
    }else{
      await conn.query('START TRANSACTION READ ONLY');const snapshot=await loadSnapshot(conn,identity),plan=buildPlan(snapshot,options);await conn.rollback();
      if(options.output){if(inside(options.output,ROOT))throw fail('PRIVATE_MANIFEST_REQUIRED','计划文件必须保存在项目目录之外');await fs.promises.writeFile(options.output,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});}
      console.log(JSON.stringify({...summary(plan),readOnly:true,manifestPath:options.output||null}));
    }
  }catch(error){try{await conn.rollback();}catch(_){}throw error;}finally{await conn.end();}
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({error:error.code||'SERVICE_DEMO_RESET_FAILED',message:/^DB_|MANIFEST|SCOPE_|CUTOFF_|PRIVATE_|ARGUMENT|UNKNOWN_|NONTRANSACTIONAL|DELETE_|BACKUP_/.test(error.code||'')?error.message:'清理失败；数据库错误详情未输出，事务已回滚'}));process.exitCode=1;});
module.exports={buildPlan,summary,parseArgs,createdBefore,onlineEvidence,cutoffOf,applyPlan,deletionOrder,loadSnapshot,hash,OPERATION};
