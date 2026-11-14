"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const requestReadSource = require("../lib/requestReadSource.cjs");
const rpc = require("../lib/rpc.cjs");

test("concurrent reads share one query and isolate nested projections", async () => {
  let lists = 0, gets = 0;
  const source = {
    async list() { lists++; return [{ id: "one", photos: ["original"] }]; },
    async get() { gets++; return { id: "one", photos: ["original"] }; }
  };
  const scoped = requestReadSource(source);
  const [a, b] = await Promise.all([scoped.list("albums"), scoped.list("albums")]);
  a[0].photos.push("local"); a.reverse();
  assert.deepEqual(b, [{ id: "one", photos: ["original"] }]);
  assert.deepEqual(await scoped.list("albums"), b);
  assert.equal(lists, 1);
  const [first, second] = await Promise.all([scoped.get("albums", "one"), scoped.get("albums", "one")]);
  first.photos.push("local");
  assert.deepEqual(second.photos, ["original"]);
  assert.equal(gets, 0, "an exact record already in this request's collection does not need another query");
});

test("keys do not collide, missing documents are memoized, failures can retry", async () => {
  let calls = 0, failures = 0;
  const scoped = requestReadSource({
    async get(key, id) { calls++; return id === "missing" ? null : { key, id }; },
    async list() { if (++failures === 1) throw new Error("transient"); return []; }
  });
  assert.deepEqual(await scoped.get("a:b", "c"), { key: "a:b", id: "c" });
  assert.deepEqual(await scoped.get("a", "b:c"), { key: "a", id: "b:c" });
  assert.equal(await scoped.get("a", "missing"), null);
  assert.equal(await scoped.get("a", "missing"), null);
  assert.equal(calls, 3);
  await assert.rejects(scoped.list("albums"), /transient/);
  assert.deepEqual(await scoped.list("albums"), []);
  assert.equal(failures, 2);
});

test("module preloading batches requested keys once and retains per-consumer snapshot isolation",async()=>{
 const calls=[];let getCalls=0;
 const source={async listMany(keys){calls.push(keys);return Object.fromEntries(keys.map(key=>[key,[{id:"one",key,nested:{value:1}}]]));},async list(){throw Error("must use batch");},async get(key,id){getCalls++;return {id,key,fallback:true};}};
 const scoped=requestReadSource(source);
 await scoped.preload(["logs","trash","logs"]);
 const [logs,trash,doc]=await Promise.all([scoped.list("logs"),scoped.list("trash"),scoped.get("logs","one")]);
 logs[0].nested.value=2;doc.nested.value=3;
 assert.equal((await scoped.list("logs"))[0].nested.value,1);assert.equal(trash[0].key,"trash");assert.equal(getCalls,0);
 await scoped.preload(["logs"]);assert.equal(calls.length,1);
 assert.equal((await scoped.get("logs","not-in-list")).fallback,true);assert.equal(getCalls,1);
 await requestReadSource(source).preload(["logs"]);assert.equal(calls.length,2,"next request still reads current data");
});
test("failed bulk preloads never provide partial data and a later attempt may retry",async()=>{
 let calls=0;
 const scoped=requestReadSource({async listMany(keys){if(++calls===1)throw Error("storage unavailable");return Object.fromEntries(keys.map(k=>[k,[]]));}});
 await assert.rejects(scoped.preload(["logs","trash"]),/storage unavailable/);
 await scoped.preload(["logs","trash"]);assert.deepEqual(await scoped.list("logs"),[]);assert.equal(calls,2);
});

test("the next RPC reads current visibility while each request reads a collection once", async () => {
  const counts = new Map();
  const rows = {
    cities: [{ id: "cs", name: "长沙", enabled: true }],
    spots: [{ id: "point", cityId: "cs", name: "江边", isShow: true }],
    series: [], packages: [], peripherals: [], guides: [], samples: [],
    albums: [{ id: "photo", spotId: "point", name: "留影", status: "上架", sampleUrls: ["https://example.test/photo.jpg"] }]
  };
  const source = {
    async list(key) { counts.set(key, (counts.get(key) || 0) + 1); return structuredClone(rows[key] || []); },
    async get(key, id) { return key === "homeConfig" ? { id, bannerConfigVersion: 1, banners: [] } : null; }
  };
  const first = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(first.success, true);
  assert.equal(first.data.albums.length, 1);
  for (const [key, count] of counts) assert.equal(count, 1, key);
  rows.spots[0].isShow = false;
  counts.clear();
  const second = await rpc(source, "getHomeData", { cityId: "cs" });
  assert.equal(second.success, true);
  assert.deepEqual(second.data.spots, []);
  assert.deepEqual(second.data.albums, []);
  for (const [key, count] of counts) assert.equal(count, 1, key);
});

test("spot pagination avoids unrelated product queries", async () => {
  const keys = [];
  const source = {
    async list(key) {
      keys.push(key);
      assert.ok(["cities", "spots", "series"].includes(key));
      return [];
    },
    async get() { return { bannerConfigVersion: 1 }; }
  };
  const result = await rpc(source, "getHomeData", { spotsOnly: true, spotOffset: 0, spotLimit: 20 });
  assert.equal(result.success, true);
  assert.deepEqual([...new Set(keys)].sort(), ["cities", "series", "spots"]);
  assert.equal(keys.length, 3);
});
