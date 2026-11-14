"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const reset=require('../../scripts/reset-service-demo.cjs');
const cutoff='2026-11-11T08:00:00.000Z';
function fixture(overrides={}) {
  const data={
    lxm_orders:[{id:'old-demo',orderNo:'DEMO-1',createdAt:'2026-10-01T00:00:00Z'},{id:'old-online',orderNo:'ONLINE-1',createdAt:'2026-10-02T00:00:00Z'},{id:'new-live',orderNo:'LIVE-1',createdAt:'2026-11-11T08:00:00Z'}],
    lxm_order_payment_records:[{order_id:'old-online',record_no:0,provider:'wechat_pay',status:'confirmed',external_transaction_id:'4200000000000000000000000001',amount:'0.04'}],
    lxm_bookingrequests:[{id:'old-booking',createdAt:'2026-10-01T00:00:00Z',confirmedOrderId:'old-online'},{id:'pending-test',createdAt:'2026-10-01T00:00:00Z',confirmedOrderId:null}],
    lxm_booking_payment_records:[{booking_id:'old-booking',record_no:0,out_trade_no:'TESTTRADE1'},{booking_id:'pending-test',record_no:0,out_trade_no:'TESTTRADE2'}],
    lxm_aftersales:[{id:'sale-demo',orderId:'old-demo',orderNo:'DEMO-1',createdAt:'2026-10-03T00:00:00Z'},{id:'sale-live',orderId:'new-live',orderNo:'LIVE-1',createdAt:'2026-11-11T09:00:00Z'},{id:'orphan',orderId:'gone-demo',orderNo:'GONE-1',createdAt:'2026-10-01T00:00:00Z'}],
    lxm_after_sale_logs:[{after_sale_id:'sale-demo',log_no:0,message:'test'},{after_sale_id:'orphan',log_no:0,message:'orphan'}],
    lxm_collection_values:[{collection_name:'orders',record_id:'old-demo',path:'custom',ordinal:0,value_text:'fixture'},{collection_name:'orders',record_id:'new-live',path:'custom',ordinal:0,value_text:'live'}],
    lxm_scans:[{id:'scan-demo',orderId:'old-demo'},{id:'scan-content',orderId:null}],
    lxm_mediafiles:[{id:'file-demo',orderId:'old-demo',objectKey:'keep-original-oss-key'},{id:'file-catalog',orderId:null,objectKey:'catalog-asset'}],
    lxm_share_audit:[{id:'audit',order_id:'old-demo',action:'test-audit'}],
    lxm_share_snapshot:[{id:'snapshot',order_id:'old-demo',amount:'12.00'}],
    lxm_share_correction:[{id:'correction',order_id:'old-demo',reason:'original correction'}],
    svc_config:[{id:'config',ver:1}],benefit_rule:[{id:'rule',ver:1}],svc_staff:[{id:'staff',name:'Fixture'}],
    ...overrides,
  };
  const pk={lxm_order_payment_records:['order_id','record_no'],lxm_booking_payment_records:['booking_id','record_no'],lxm_after_sale_logs:['after_sale_id','log_no'],lxm_collection_values:['collection_name','record_id','path','ordinal']};
  const snapshot={identity:'fixture-db',rows:{},columns:{},primary:{},generated:{},engines:{},allTables:Object.keys(data).sort()};
  for(const table of snapshot.allTables){snapshot.rows[table]=structuredClone(data[table]);snapshot.columns[table]=data[table].length?Object.keys(data[table][0]):['id'];snapshot.primary[table]=pk[table]||['id'];snapshot.engines[table]='InnoDB';}
  return snapshot;
}
function count(plan,table){return plan.entries.find(entry=>entry.table===table)?.count||0;}
function fakeConnection(snapshot){
 const state=structuredClone(snapshot.rows),calls=[];
 return {state,calls,async query(sql,params=[]){calls.push({sql,params});
  if(sql.startsWith('SELECT TABLE_NAME,COLUMN_NAME'))return [Object.entries(snapshot.columns).flatMap(([table,cols])=>cols.map(column=>({TABLE_NAME:table,COLUMN_NAME:column,COLUMN_KEY:snapshot.primary[table].includes(column)?'PRI':'',EXTRA:''})))];
  if(sql.startsWith('SELECT TABLE_NAME,ENGINE'))return [snapshot.allTables.map(table=>({TABLE_NAME:table,ENGINE:snapshot.engines[table]}))];
  if(sql.startsWith('SELECT TRIGGER_NAME'))return [[]];
  const select=sql.match(/^SELECT \* FROM `(\w+)`/);if(select)return [structuredClone(state[select[1]])];
  const create=sql.match(/^SHOW CREATE TABLE `(\w+)`/);if(create)return [[{'Create Table':`CREATE TABLE \`${create[1]}\` (id TEXT)`}]];
  const remove=sql.match(/^DELETE FROM `(\w+)`/);if(remove){const allKeys=[...sql.matchAll(/`(\w+)` <=> \?/g)].map(m=>m[1]),keys=[...new Set(allKeys)];let affected=0;for(let n=0;n<params.length;n+=keys.length){const i=state[remove[1]].findIndex(row=>keys.every((key,j)=>row[key]===params[n+j]));if(i>=0){state[remove[1]].splice(i,1);affected++;}}return [{affectedRows:affected}];}
  throw new Error('Unexpected SQL: '+sql);
 }};
}
test('cleanup cutoff is explicit and excludes records created at or after it',()=>{
 assert.throws(()=>reset.cutoffOf('2026-11-11 16:00:00'),{code:'CUTOFF_REQUIRED'});
 const plan=reset.buildPlan(fixture(),{cutoff});assert.equal(plan.totals.oldOrders,2);assert.equal(plan.totals.selectedOrders,1);
 assert.equal(plan.entries.find(e=>e.table==='lxm_orders').records[0].key.id,'old-demo');
 assert.equal(reset.createdBefore({createdAt:'invalid'},cutoff),false);
});
test('default cleanup protects pending or confirmed WeChat evidence and linked bookings',()=>{
 const plan=reset.buildPlan(fixture(),{cutoff});assert.equal(plan.totals.protectedOnlineOrders,1);assert.equal(count(plan,'lxm_order_payment_records'),0);assert.equal(plan.totals.selectedBookings,0);
 assert.equal(reset.onlineEvidence({provider:'wechat_pay',status:'pending'}),true);
 assert.equal(reset.onlineEvidence({provider:'mock_payment',external_transaction_id:'mock-receipt'}),false);
});
test('explicit online test cleanup includes old receipts and orphan demo bills but not new live data',()=>{
 const plan=reset.buildPlan(fixture(),{cutoff,includeOnlineTestRecords:true});
 assert.equal(plan.totals.selectedOrders,2);assert.equal(plan.totals.selectedBookings,2);assert.equal(count(plan,'lxm_order_payment_records'),1);assert.equal(count(plan,'lxm_aftersales'),2);assert.equal(count(plan,'lxm_after_sale_logs'),2);
 assert.equal(plan.entries.some(entry=>entry.records.some(record=>record.key.id==='new-live')),false);
 assert.equal(count(plan,'lxm_scans'),1);assert.equal(count(plan,'lxm_mediafiles'),1);assert.equal(count(plan,'lxm_collection_values'),1);
});
test('cleanup never deletes accounts/config/catalog or immutable audit snapshots',()=>{
 const plan=reset.buildPlan(fixture(),{cutoff,includeOnlineTestRecords:true});
 for(const table of ['svc_staff','svc_config','benefit_rule','lxm_share_snapshot','lxm_share_audit','lxm_share_correction'])assert.equal(count(plan,table),0,table);
 assert.equal(plan.preservedOss,true);assert.equal(plan.preservedAccountsAndCatalog,true);
});
test('mixed live/demo settlement is a blocker, not a partially edited accounting period',()=>{
 const plan=reset.buildPlan(fixture({benefit_ledger:[{id:'1',biz_no:'DEMO-1',settle_id:'mixed'},{id:'2',biz_no:'LIVE-1',settle_id:'mixed'}],svc_settlement:[{id:'unused',settle_id:'mixed'}]}),{cutoff});
 assert.equal(plan.blockers.some(item=>item.code==='MIXED_SETTLEMENT'),true);
});
test('apply rejects edited manifest, wrong hash or changed scope without issuing DELETE',async()=>{
 const snapshot=fixture(),plan=reset.buildPlan(snapshot,{cutoff}),conn=fakeConnection(snapshot);
 await assert.rejects(reset.applyPlan(conn,plan,{manifestHash:'wrong'}),{code:'MANIFEST_HASH_REQUIRED'});
 await assert.rejects(reset.applyPlan(conn,{...plan,cutoff:'2020-01-01T00:00:00Z'},{manifestHash:plan.manifestHash}),{code:'MANIFEST_TAMPERED'});
 const changed=fixture();changed.rows.lxm_orders[0].orderNo='CHANGED';const c=fakeConnection(changed);
 await assert.rejects(reset.applyPlan(c,plan,{manifestHash:plan.manifestHash,identity:'fixture-db'}),{code:'SCOPE_CHANGED'});
 assert.equal([...conn.calls,...c.calls].some(call=>call.sql.startsWith('DELETE')),false);
});
test('backup must be outside application tree and finishes before first delete',async t=>{
 const snapshot=fixture(),plan=reset.buildPlan(snapshot,{cutoff,includeOnlineTestRecords:true}),conn=fakeConnection(snapshot);
 await assert.rejects(reset.applyPlan(conn,plan,{manifestHash:plan.manifestHash,identity:'fixture-db',backupDir:path.resolve(__dirname,'../..'),mysql:require('mysql2')}),{code:'PRIVATE_BACKUP_REQUIRED'});
 assert.equal(conn.calls.some(call=>call.sql.startsWith('DELETE')),false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'svc-demo-reset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const result=await reset.applyPlan(conn,plan,{manifestHash:plan.manifestHash,identity:'fixture-db',backupDir:dir,mysql:require('mysql2')});
 assert.equal(result.deletedRows,plan.totals.rows);assert.equal(reset.hash(fs.readFileSync(result.backup.path)),result.backup.sha256);
 const backup=fs.readFileSync(result.backup.path,'utf8');assert.match(backup,/4200000000000000000000000001/);assert.match(backup,/original correction/);assert.match(backup,/keep-original-oss-key/);
 assert.equal(conn.state.lxm_orders.length,1);assert.equal(conn.state.lxm_orders[0].id,'new-live');assert.equal(conn.state.lxm_share_audit.length,1);assert.equal(conn.state.svc_staff.length,1);
 const firstDelete=conn.calls.findIndex(call=>call.sql.startsWith('DELETE')),lastBackupRead=conn.calls.findLastIndex(call=>call.sql.startsWith('SHOW CREATE TABLE'));
 assert.ok(firstDelete>lastBackupRead);
});
test('CLI never enables mutation or online override accidentally',()=>{
 assert.deepEqual(reset.parseArgs(['--cutoff',cutoff]),{apply:false,includeOnlineTestRecords:false,cutoff});
 assert.throws(()=>reset.parseArgs(['--apply','--hash']),{code:'ARGUMENT_REQUIRED'});assert.throws(()=>reset.parseArgs(['--force']),{code:'UNKNOWN_ARGUMENT'});
});
