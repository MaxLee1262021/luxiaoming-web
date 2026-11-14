"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, merchant } = require("./fixtures/shareSql.cjs");
const { createShareService, qrScene } = require("../lib/merchantShare.cjs");

const session = { kind: "public", openid: "verified-user" };
const admin = { kind: "admin", role: "super" };
async function ready(enableAt) {
  const f = fixture();
  const store = f.newStore();
  await store.ensureSchema();
  const scene = qrScene("0123456789ABCD");
  await store.onboardMerchant(merchant("m1", { qr: { id: "qr-m1", scene, imageUrl: "data:image/png;base64,iVBORw0KGgo=" } }));
  let clock = new Date("2026-11-01T15:59:59Z");
  f.setTime(clock.toISOString());
  const service = createShareService(f.source, { store, enableAt, clock: () => clock });
  return { f, store, service, scene, at(value) { clock = new Date(value); f.setTime(value); } };
}

test("scan collection works without commission activation, counts Shanghai dates and remains read-only on QR views", async () => {
  const prior = process.env.SHARE_ENABLE_AT;
  delete process.env.SHARE_ENABLE_AT;
  try {
    const { f, store, service, scene, at } = await ready();
    assert.equal((await service.reportScan(session, { scene, requestKey: "first" })).recorded, true);
    at("2026-11-01T16:00:06Z");
    assert.equal((await service.reportScan(session, { scene, requestKey: "second" })).recorded, true);
    const expected = [{ date: "2026-11-01", count: 1 }, { date: "2026-11-02", count: 1 }];
    for (let i = 0; i < 2; i++) {
      const detail = await service.detail("m1", admin);
      const qr = await service.qr("m1", admin);
      assert.equal(detail.stats.scanCount, 2); assert.deepEqual(detail.stats.dailyScans, expected);
      assert.equal(qr.scanCount, 2); assert.deepEqual(qr.dailyScans, expected);
    }
    assert.equal((await store.listScanRecords()).length, 2);
    assert.equal(f.tables().binding.length, 0); assert.equal(f.tables().binding_event.length, 0);
    assert.equal((await store.getBindingsAsOf(session.openid, "2026-11-02T00:00:00Z")).length, 0);
  } finally {
    if (prior === undefined) delete process.env.SHARE_ENABLE_AT; else process.env.SHARE_ENABLE_AT = prior;
  }
});

test("a retried scan request remains idempotent after the dedup window and a later real scan is counted", async () => {
  const { f, store, service, scene, at } = await ready("2026-11-01T00:00:00Z");
  const first = await service.reportScan(session, { scene, requestKey: "scan-event-1" });
  at("2026-11-01T16:00:20Z");
  const replay = await service.reportScan(session, { scene, requestKey: "scan-event-1" });
  assert.equal(replay.deduped, true); assert.equal(replay.scanId, first.scanId);
  const next = await service.reportScan(session, { scene, requestKey: "scan-event-2" });
  assert.equal(next.recorded, true); assert.notEqual(next.scanId, first.scanId);
  assert.equal((await store.getMerchantStats("m1")).scanCount, 2);
  assert.equal(f.tables().binding.length, 1); assert.equal(f.tables().binding_event.length, 2);
});

test("activation does not turn a retried pre-activation scan into financial attribution", async () => {
  const { f, store, service, scene, at } = await ready("2026-11-02T00:00:00Z");
  await service.reportScan(session, { scene, requestKey: "before-activation" });
  at("2026-11-01T16:00:00Z");
  assert.equal((await service.reportScan(session, { scene, requestKey: "another-entry" })).recorded, true, "distinct entry keys are independent visits even within five seconds");
  at("2026-11-02T00:00:10Z");
  assert.equal((await service.reportScan(session, { scene, requestKey: "before-activation" })).deduped, true);
  assert.equal((await service.reportScan(session, { scene, requestKey: "another-entry" })).deduped, true);
  assert.equal(f.tables().binding_event.length, 0);
  assert.equal((await service.reportScan(session, { scene, requestKey: "after-activation" })).recorded, true);
  assert.equal(f.tables().binding_event.length, 1);
  const bindings = await store.getBindingsAsOf(session.openid, "2026-11-02T00:00:11Z");
  assert.equal(bindings.length, 1); assert.equal(bindings[0].lastScanAt, "2026-11-02T00:00:10.000Z");
  assert.equal((await store.getMerchantStats("m1")).scanCount, 3);
});

test("the first scan of a replacement QR is counted immediately and historical facts remain available", async () => {
  const { store, service, scene } = await ready("2026-11-01T00:00:00Z");
  await service.reportScan(session, { scene, requestKey: "old-code-scan" });
  const nextScene = qrScene("FEDCBA98765432");
  await store.rotateQr({ merchantId: "m1", id: "qr-new", scene: nextScene, imageUrl: "data:image/png;base64,iVBORw0KGgo=", reason: "replace", operatorId: "admin", requestId: "replace-once" });
  assert.equal((await service.reportScan(session, { scene: nextScene, requestKey: "new-code-scan" })).recorded, true);
  assert.equal((await service.qr("m1", admin)).scanCount, 1);
  assert.equal((await store.listScanRecords()).length, 2);
});
