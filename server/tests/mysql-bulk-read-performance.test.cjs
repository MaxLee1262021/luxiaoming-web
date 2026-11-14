"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const schema=require("../lib/mysqlSchema.cjs");
const createSource=require("../lib/mysqlSource.cjs");

function fixture(){
 const queries=[],documents=new Map(),columns=new Map();
 for(const key of schema.ALL_KEYS)columns.set(schema.tableName(key),schema.definition(key).columns.map(row=>row.name));
 for(const relation of Object.values(schema.RELATIONS))columns.set(relation.table,relation.columns.map(c=>c.split(/\s+/,1)[0]));
 const flags={failMetadata:false,failRelation:false,orphan:false,financeLeaves:false};
 const stats={active:0,peak:0};
 const pool={async query(sql,params=[]){
  queries.push({sql,params:[...params]});
  if(sql.includes("information_schema.columns")){
   if(flags.failMetadata)throw Object.assign(Error("metadata unavailable"),{code:"QA_METADATA_FAILURE"});
   return [params.flatMap(table=> (columns.get(table)||[]).map(column=>({TABLE_NAME:table,COLUMN_NAME:column})))];
  }
  if(sql.includes("information_schema.statistics"))return [params.map(table=>({TABLE_NAME:table,COLUMN_NAME:"updatedAt",INDEX_NAME:"idx_updated_at"}))];
  if(sql.includes("LEFT JOIN"))return [[{collection_name:"albums",count:flags.orphan?1:0}]];
  if(sql.includes("COUNT(*) AS count FROM `lxm_collection_values`"))return [[{count:flags.financeLeaves?1:0}]];
  if(!sql.startsWith("SELECT"))throw Error("read-only test must not mutate");
  stats.active++;stats.peak=Math.max(stats.peak,stats.active);await new Promise(setImmediate);stats.active--;
  const table=sql.match(/FROM `([^`]+)`/)?.[1];
  const key=schema.ALL_KEYS.find(k=>schema.tableName(k)===table);
  if(key){
   const docs=documents.get(key)||[];return [docs.filter(doc=>!sql.includes("WHERE id=?")||String(doc.id)===String(params[0])).map(doc=>({id:doc.id,...schema.splitDocument(key,doc).columns}))];
  }
  if(table===schema.RELATIONS.collection_values.table){
   const owners=new Map();
   if(sql.includes("WHERE collection_name=?"))owners.set(params[0],params.slice(1).map(String));
   else {
    let index=0;
    for(const match of sql.matchAll(/\(collection_name=\? AND record_id IN \(([^)]+)\)\)/g)){
     const collection=params[index++],count=match[1].split(",").length;
     if(!owners.has(collection))owners.set(collection,[]);
     owners.get(collection).push(...params.slice(index,index+count).map(String));index+=count;
    }
   }
   return [[...owners].flatMap(([collection,ids])=>(documents.get(collection)||[]).filter(doc=>ids.includes(String(doc.id))).flatMap(doc=>schema.splitDocument(collection,doc).attributes.map(a=>({...a,collection_name:collection,record_id:doc.id}))))];
  }
  if(flags.failRelation)throw Object.assign(Error("relation unavailable"),{code:"QA_RELATION_FAILURE"});
  for(const [collection,docs] of documents){
   const relName=(schema.RELATION_BY_KEY[collection]||[]).find(name=>schema.RELATIONS[name].table===table);
   if(relName)return [docs.filter(doc=>params.map(String).includes(String(doc.id))).flatMap(doc=>schema.splitDocument(collection,doc).relations[relName]||[])];
  }
  return [[]];
 }};
 const source=createSource({pool,autoMigrate:false,healthCacheMs:0,logger:{warn(){},error(){}}});
 return {source,queries,documents,columns,flags,stats};
}

test("cold schema and health use bounded metadata batches and retain every integrity check",async()=>{
 const f=fixture();assert.equal((await f.source.health()).ready,true);
 assert.equal(f.queries.length,5,"one startup catalog plus columns, indexes, finance leaves and orphan union");
 assert.equal(f.queries.filter(q=>q.sql.includes("LEFT JOIN")).length,1);
 assert.equal(f.queries.find(q=>q.sql.includes("LEFT JOIN")).params.length,schema.ALL_KEYS.length*2);
 f.flags.orphan=true;const orphan=await f.source.health();assert.equal(orphan.ready,false);assert.ok(orphan.incomplete.includes("lxm_collection_values.albums.orphan"));
 f.flags.orphan=false;f.flags.financeLeaves=true;const finance=await f.source.health();assert.equal(finance.ready,false);assert.ok(finance.incomplete.includes("lxm_collection_values.financeSettings"));
 f.flags.financeLeaves=false;f.columns.set("lxm_albums",f.columns.get("lxm_albums").filter(c=>c!=="name"));
 const missing=await f.source.health();assert.equal(missing.ready,false);assert.ok(missing.incomplete.includes("lxm_albums.name"));
});

test("batched startup rejects metadata failure and retries without recording a healthy missing schema",async()=>{
 const f=fixture();f.flags.failMetadata=true;
 await assert.rejects(f.source.list("albums"),{code:"QA_METADATA_FAILURE"});
 assert.equal((await f.source.health()).ready,false);
 f.flags.failMetadata=false;f.documents.set("albums",[{id:"a",name:"available after recovery"}]);
 assert.equal((await f.source.list("albums"))[0].name,"available after recovery");
 assert.equal((await f.source.health()).ready,true);
});

test("listMany shares typed-leaf reads across collections while preserving relations and duplicate IDs",async()=>{
 const f=fixture();
 f.documents.set("cities",[{id:"same",name:"长沙",custom:"city-private"}]);
 f.documents.set("staff",[{id:"same",name:"客服",custom:"staff-private"}]);
 f.documents.set("albums",[{id:"same",name:"样片",custom:"album-private",photoIds:["p2","p1"],tags:["night","city"]}]);
 await f.source.ensureSchema();f.queries.length=0;
 const batched=await f.source.listMany(["cities","staff","albums","staff"]);
 assert.deepEqual(Object.keys(batched),["cities","staff","albums"]);
 assert.equal(f.queries.length,6,"three main reads, one typed-leaf batch, and two album relation reads");
 assert.equal(f.queries.filter(q=>q.sql.includes("FROM `lxm_collection_values`")).length,1);
 assert.ok(f.stats.peak>=3,"independent pool reads start together");
 for(const key of Object.keys(batched))assert.deepEqual(batched[key],await f.source.list(key));
 assert.equal(batched.cities[0].custom,"city-private");assert.equal(batched.staff[0].custom,"staff-private");assert.equal(batched.albums[0].custom,"album-private");
 assert.deepEqual(batched.albums[0].photoIds,["p2","p1"]);
 f.documents.get("albums")[0].name="new name";assert.equal((await f.source.listMany(["albums"])).albums[0].name,"new name","no cross-request business cache");
 batched.albums[0].name="consumer mutation";assert.equal((await f.source.list("albums"))[0].name,"new name");
});

test("listMany validates all keys first, skips empty relation reads, and fails closed on hydration errors",async()=>{
 const f=fixture();await assert.rejects(f.source.listMany(["albums","lxm_auth_users"]),{code:"DATA_KEY_INVALID"});assert.equal(f.queries.length,0);
 assert.deepEqual(await f.source.listMany([]),{});assert.equal(f.queries.length,0);
 await f.source.ensureSchema();f.queries.length=0;
 const empty=await f.source.listMany(["albums","cities"]);assert.deepEqual(empty,{albums:[],cities:[]});assert.equal(f.queries.length,2);
 f.documents.set("albums",[{id:"a",name:"album",tags:["tag"]}]);f.flags.failRelation=true;
 await assert.rejects(f.source.listMany(["albums"]),{code:"QA_RELATION_FAILURE"});
});
