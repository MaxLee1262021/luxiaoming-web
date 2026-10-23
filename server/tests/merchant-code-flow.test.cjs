"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrProvider, generateMerchantCode, merchantCodeStats, businessDate } = require("../lib/merchantCodes.cjs");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
function source() {
  const rows = { shops: [{ id: "shop-record", shopId: "shop-1", name: "测试门店", status: "启用" }], merchantCodes: [{ id: "old", shopId: "shop-1", status: "active", qrImage: "data:image/svg+xml;utf8,test" }], scans: [], orders: [] };
  return { rows, list: async key => rows[key] || [], get: async (key,id) => (rows[key] || []).find(row => row.id === id) || null,
    create: async (key,doc) => { rows[key].push(doc); return doc; }, update: async (key,id,patch) => { const row=rows[key].find(row=>row.id===id); Object.assign(row,patch); return row; } };
}
test("real WeChat code has c= source scene and exact JSON length; credentials never return to clients", async () => {
  const calls = [];
  const provider = createQrProvider({ env: { WX_APP_ID: "app", WX_APP_SECRET: "test-secret" }, request: async (url, opts, body) => {
    calls.push({ url, opts, body });
    return calls.length === 1 ? { status:200, body:Buffer.from(JSON.stringify({ access_token:"test-token",expires_in:7200 })) } : { status:200,body:png };
  } });
  const result = await provider("c=Qabc");
  assert.match(result,/^data:image\/png;base64,/);
  assert.doesNotMatch(result,/test-secret|test-token/);
  const payload=JSON.parse(calls[1].body);
  assert.equal(payload.scene,"c=Qabc");
  assert.equal(payload.page,"pages/scanEntry/scanEntry");
  assert.equal(payload.check_path,true);
  assert.equal(calls[1].opts.headers["Content-Length"],Buffer.byteLength(calls[1].body));
});
test("missing or invalid WeChat response fails instead of creating a fake QR", async () => {
  await assert.rejects(createQrProvider({env:{}})("c=Qtest"),/配置/);
  let step=0;
  const provider=createQrProvider({env:{WX_APP_ID:"a",WX_APP_SECRET:"s"},request:async()=>({status:200,body:Buffer.from(JSON.stringify(++step===1?{access_token:"t"}:{errcode:45009}))})});
  await assert.rejects(provider("c=Qtest"),/生成失败/);
});
test("one shop has one stable code even when regenerated concurrently, and old placement codes are disabled", async () => {
  const store=source(); let generated=0;
  const options={provider:async scene=>{generated++;assert.match(scene,/^c=Q/);return `data:image/png;base64,${png.toString("base64")}`;}};
  const [a,b]=await Promise.all([generateMerchantCode(store,{shopId:"shop-1",placementLabel:"收银"},options),generateMerchantCode(store,{shopId:"shop-record",placementLabel:"桌贴"},options)]);
  assert.equal(a.codeId,b.codeId);assert.equal(generated,1);assert.equal(store.rows.merchantCodes.filter(row=>row.status==="active").length,1);assert.equal(store.rows.merchantCodes[0].status,"disabled");
});
test("Shanghai date and daily unique WeChat visitors are separated from anonymous scan counts", async () => {
  const store=source();
  assert.equal(businessDate("2026-10-13T16:00:00.000Z"),"2026-10-14");
  store.rows.scans=[{shopId:"shop-1",businessDate:"2026-10-14",visitorHash:"a",openid:"owner"},{shopId:"shop-1",businessDate:"2026-10-14",visitorHash:"a",openid:"owner"},{shopId:"shop-1",businessDate:"2026-10-14",visitorHash:"anon"},{shopId:"shop-2",businessDate:"2026-10-14",visitorHash:"b",openid:"other"}];
  const result=await merchantCodeStats(store,"shop-1","2026-10-14");
  assert.equal(result.scans,3);assert.equal(result.unique,1);assert.equal(result.anonymousScans,1);
});
