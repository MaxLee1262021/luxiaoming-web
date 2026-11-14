"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const script = fs.readFileSync(path.resolve(__dirname, "../api/svc-workbench-ui.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(mode = "workbench") {
  let mount, unmount, timerId = 0, now = 1000000;
  const requests = [], timers = new Map();
  const control = { handler: async () => ({ summary: { pool: 7 }, list: [{ order_no: "OWN-1", service_status: "claimed" }], total: 1, reserved: { list: [{ order_no: "R1", status: "started", left_seconds: 601, hold_minutes: 60 }], total: 1 } }) };
  const window = { LXM_HTTP: { async request(url, init = {}) {
    const request = { url, init, body: init.body && JSON.parse(init.body) }; requests.push(request);
    const data = await control.handler(request);
    return { ok: true, json: async () => ({ code: 0, data }) };
  } } };
  class Clock extends Date { static now() { return now; } }
  const sandbox = { window, Vue: { reactive: value => value, computed: fn => ({ get value() { return fn(); } }), onMounted: fn => { mount = fn; }, onUnmounted: fn => { unmount = fn; } },
    Date: Clock, Intl, URLSearchParams, AbortController, WeakMap, Set, setTimeout,clearTimeout,document: { visibilityState: "visible" },
    setInterval: (fn, interval) => { const id = ++timerId; timers.set(id, { fn, interval }); return id; }, clearInterval: id => timers.delete(id),
    navigator: { clipboard: { async writeText() {} } } };
  vm.createContext(sandbox); vm.runInContext(script, sandbox);
  const messages = [];
  const ctx = { state: { role: "service", currentStaffId: "S1",active:'svcWorkbench' }, ElMessage: Object.fromEntries(["success", "warning", "error"].map(kind => [kind, text => messages.push({ kind, text })])), ElMessageBox: { async confirm() {} }, switchMenu() {} };
  const ui = window.LXM_SVC_WORKBENCH_SETUP(ctx, mode);
  return { ui, requests, timers, control, sandbox, messages, mount: () => mount(), unmount: () => unmount(), advance(ms) { now += ms; }, timer: ms => [...timers.values()].find(timer => timer.interval === ms)?.fn() };
}

test("workbench first load fetches one overview containing summary, todo and reserves", async () => {
  const f = fixture(); await f.mount();
  assert.equal(f.requests.length, 1);
  const url = new URL(f.requests[0].url, "http://test");
  assert.equal(url.pathname, "/api/kf/workbench/overview"); assert.equal(url.searchParams.get("mode"), "workbench");
  assert.equal(f.ui.kf.summary.pool, 7); assert.equal(f.ui.kf.rows[0].order_no, "OWN-1"); assert.equal(f.ui.kf.reserves[0].order_no, "R1");
  assert.deepEqual([...f.timers.values()].map(timer => timer.interval).sort((a, b) => a - b), [1000, 30000]);
  f.unmount(); assert.equal(f.timers.size, 0);
});

test("intake combines the selected list and reserves while preserving filters and pagination", async () => {
  const f = fixture("intake"); f.ui.kf.query.keyword = "QA客户"; f.ui.kf.query.type = "peripheral";
  await f.mount(); assert.equal(f.requests.length, 2);assert.match(f.requests[1].url,/rebuy\/bindings/);
  let url = new URL(f.requests[0].url, "http://test"); assert.equal(url.searchParams.get("tab"), "all"); assert.equal(url.searchParams.get("keyword"), "QA客户"); assert.equal(url.searchParams.get("type"), "peripheral");
  f.ui.kf.tab = "mine"; f.ui.kf.query.page = 3; await f.ui.kfLoad();
  url = new URL(f.requests[2].url, "http://test"); assert.equal(url.searchParams.get("tab"), "mine"); assert.equal(url.searchParams.get("page"), "3");
  assert.deepEqual([...f.timers.values()].map(timer => timer.interval).sort((a, b) => a - b), [1000, 30000]); f.unmount();
});
test('reservation summary and badge use server total and original per-order holding window',async()=>{
 const f=fixture('intake');f.control.handler=async()=>({list:[],total:0,reserved:{list:[{order_no:'R1',status:'started',left_seconds:480,hold_minutes:90}],total:120}});
 await f.mount();assert.equal(f.ui.kf.reserveTotal,120);assert.equal(f.ui.kfReserveSummary.value,'120 单老客户复购，先给你 90 分钟');
 f.control.handler=async()=>({list:[],total:0});await f.timer(1000);assert.equal(f.ui.kf.reserveTotal,0);assert.equal(f.ui.kfReserveSummary.value,'暂无待接单的复购订单');f.unmount();
});

test("countdowns only change from the one-second server read and holding remains frozen", async () => {
  const f = fixture(); await f.mount();
  const waiting = { order_no: "H", status: "holding", left_seconds: null, reserve_defer: true }; f.ui.kf.reserves.push(waiting);
  f.advance(2300);
  assert.equal(f.ui.kf.reserves[0].left_seconds, 601); assert.equal(f.ui.kfCountdown(f.ui.kf.reserves[0]), "10:01");
  assert.equal(f.ui.kfCountdown(waiting), "--:--"); assert.equal(waiting.left_seconds, null); assert.equal(f.requests.length, 1);
  f.control.handler = async () => ({ list: [{ order_no: "R1", status: "started", left_seconds: 200, hold_minutes: 60 },waiting], total: 2 });
  await f.timer(1000); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].url, "/api/kf/orders/reserved?size=100"); assert.equal(f.ui.kf.reserves[0].left_seconds, 200);
  f.advance(210000);assert.equal(f.ui.kf.reserves[0].left_seconds, 200,'local clock cannot expire server reservation');
  f.control.handler=async()=>({list:[{order_no:'R1',status:'started',left_seconds:0},waiting],total:2});await f.timer(1000);assert.equal(f.ui.kf.reserves[0].left_seconds,0);assert.equal(f.ui.kfCountdown(f.ui.kf.reserves[1]),'--:--');f.unmount();
});

test("background polling does not overlap slow overview reads or hidden tabs", async () => {
  const f = fixture(); await f.mount(); let finish;
  f.control.handler = () => new Promise(resolve => { finish = resolve; });
  const pending = f.ui.kfLoad(); assert.equal(f.requests.length, 2);
  await f.timer(1000); await f.timer(30000); assert.equal(f.requests.length, 2, "in-flight overview already owns current refresh");
  finish({ list: [], total: 0, summary: {}, reserved: { list: [], total: 0 } }); await pending;
  f.sandbox.document.visibilityState = "hidden"; await f.timer(1000); await f.timer(30000); assert.equal(f.requests.length, 2); f.unmount();
});

test("an older reserve poll cannot replace the current overview or surface an obsolete failure", async () => {
  const f = fixture(); await f.mount(); let finishPoll;
  f.control.handler = request => request.url.includes("orders/reserved") ? new Promise(resolve => { finishPoll = resolve; }) : Promise.resolve({ list: [], total: 0, summary: { pool: 9 }, reserved: { list: [{ order_no: "FRESH", status: "started", left_seconds: 100 }], total: 1 } });
  const polling = f.timer(1000); const pollRequest = f.requests.at(-1);
  await f.ui.kfLoad(); assert.equal(pollRequest.init.signal.aborted, true);
  finishPoll({ list: [{ order_no: "STALE" }], total: 1 }); await polling;
  assert.equal(f.ui.kf.reserves[0].order_no, "FRESH"); assert.equal(f.ui.kf.summary.pool, 9); assert.equal(f.ui.kf.reserveError, ""); f.unmount();
});

test("filter changes abort the older query and discard its eventual response", async () => {
  const f = fixture("intake"), finishes = [];
  f.control.handler = () => new Promise(resolve => finishes.push(resolve));
  const old = f.ui.kfLoad(); f.ui.kf.query.keyword = "new"; const recent = f.ui.kfLoad(true);
  assert.equal(f.requests[0].init.signal.aborted, true); assert.equal(f.requests[1].init.signal.aborted, false);
  finishes[1]({ list: [{ order_no: "CURRENT" }], total: 1, reserved: { list: [] } }); await recent;
  finishes[0]({ list: [{ order_no: "OLD" }], total: 1, reserved: { list: [{ order_no: "OLD-RESERVE" }] } }); await old;
  assert.equal(f.ui.kf.rows[0].order_no, "CURRENT"); assert.deepEqual(plain(f.ui.kf.reserves), []); assert.equal(f.ui.kf.loading, false); f.unmount();
});

test("unmount cancels pending list and detail queries without writing stale data or leaving timers", async () => {
  const f = fixture(), finishes = [];
  f.control.handler = () => new Promise(resolve => finishes.push(resolve));
  const list = f.ui.kfLoad(), detail = f.ui.kfDetail({ order_no: "PRIVATE" });
  f.unmount(); assert.ok(f.requests.every(request => request.init.signal.aborted));
  finishes[0]({ list: [{ order_no: "PRIVATE" }], reserved: { list: [] }, summary: {} }); finishes[1]({ order_no: "PRIVATE" }); await Promise.all([list, detail]);
  assert.deepEqual(plain(f.ui.kf.rows), []); assert.equal(f.ui.kf.detail, null); assert.equal(f.timers.size, 0);
});

test("followup and inline complaints load only their needed lists and no reserve polling", async () => {
  for (const mode of ["followup", "complaints"]) {
    const f = fixture(mode); await f.mount(); assert.equal(f.requests.length, mode==='complaints'?2:1);
    assert.match(f.requests[0].url, mode === "followup" ? /^\/api\/kf\/orders\/mine\?/ : /^\/api\/kf\/complaints\?/);
    assert.equal(f.timers.size, 0); f.unmount();
  }
});
