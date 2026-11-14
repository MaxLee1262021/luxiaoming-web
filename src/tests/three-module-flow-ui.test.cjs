"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(mode = "followup", role = "service") {
  const requests = [], messages = [], navigations = [], confirmations = [];
  let mounted;
  const control = { respond: () => ({ code: 0, data: { list: [], total: 0 } }) };
  const window = { LXM_HTTP: { async request(url, init = {}) {
    requests.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    return { ok: true, json: async () => control.respond(requests.at(-1)) };
  } } };
  const ctx = { state: { role, active: mode === "complaints" ? "svcComplaints" : "svcFollowup" },
    ElMessage: Object.fromEntries(["success", "warning", "error"].map(type => [type, message => messages.push({ type, message })])),
    ElMessageBox: { async confirm(message, title) { confirmations.push({ message, title }); } }, switchMenu: page => navigations.push(page) };
  const sandbox = { window, Vue: { reactive: value => value, computed: fn => ({ get value() { return fn(); } }), onMounted: fn => { mounted = fn; }, onUnmounted() {} },
    Intl, Date, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../api/svc-workbench-ui.js"), "utf8"), sandbox);
  return { ui: window.LXM_SVC_WORKBENCH_SETUP(ctx, mode), requests, messages, confirmations, navigations, window, control, mount: () => mounted() };
}
const order = (status, photo = null) => ({ order_no: "FLOW-1", service_status: status, photo_id: photo, category: "photo", can_operate: true });

test("assignment and shooting controls require each preceding workflow step", async () => {
  const f = fixture();
  for (const status of ["new", "claimed", "shooting", "done"]) await f.ui.kfOpen("assign", order(status));
  await f.ui.kfOpen("assign", order("confirmed", "PH20260001"));
  assert.equal(f.requests.length, 0);
  await f.ui.kfOpen("assign", order("confirmed"));
  assert.equal(f.requests.at(-1).url, "/api/kf/photographers");
  f.requests.length = 0;
  for (const status of ["claimed", "confirmed", "done"]) await f.ui.kfShoot(order(status, "PH20260001"), "finish");
  await f.ui.kfShoot(order("shooting"), "finish");
  await f.ui.kfShoot(order("claimed", "PH20260001"), "start");
  assert.equal(f.requests.length, 0);
  await f.ui.kfShoot(order("shooting", "PH20260001"), "finish");
  assert.equal(f.requests.find(row => row.method === "POST").url, "/api/kf/orders/FLOW-1/shoot/finish");
});

test("duplicate complaint opens the existing order record without submitting a replacement", async () => {
  const f = fixture("complaints");
  f.control.respond = request => request.method === "POST" ? { code: 4010, msg: "该单已有客诉，可直接改判", data: { complaint_id: "existing" } }
    : request.url.includes("/orders/FLOW-1") ? { code: 0, data: { order: order("done", "PH20260001"), timeline: [] } }
    : { code: 0, data: { list: [{ id: "existing", ...order("done") }], total: 1 } };
  f.ui.kf.complaintForm = { order_no: "FLOW-1", resp: "service", reason: "重复反馈" };
  await f.ui.kfSaveComplaint();
  assert.equal(f.requests.filter(row => row.method === "POST").length, 1);
  assert.equal(f.ui.kf.query.keyword, "FLOW-1");
  assert.equal(f.ui.kf.drawer, true);
  assert.equal(f.ui.kf.detail.order_no, "FLOW-1");
});

test("completed shooting stays active for final payment and cannot be started or finished again", async () => {
  const f = fixture();
  const pending = order("final_pending", "PH20260001");
  f.ui.kf.rows = [pending];
  assert.equal(f.ui.kfRows.value.length, 1);
  assert.equal(f.ui.kfStatusLabel(pending), "待付尾款");
  assert.equal(f.ui.kfCanAct(pending), false);
  await f.ui.kfShoot(pending, "start");
  await f.ui.kfShoot(pending, "finish");
  assert.equal(f.requests.length, 0);
  f.ui.kf.query.status = "final_pending";
  await f.ui.kfLoad();
  assert.equal(new URL(f.requests[0].url, "http://fixture").searchParams.get("status"), "final_pending");
});

test("shooting completion reports waiting for final payment without claiming an observation period", async () => {
  const f = fixture();
  f.control.respond = request => request.method === "POST"
    ? { code: 0, data: { service_status: "final_pending" } }
    : { code: 0, data: { list: [], total: 0 } };
  await f.ui.kfShoot(order("shooting", "PH20260001"), "finish");
  assert.match(f.confirmations[0].message, /等待游客支付尾款/);
  assert.equal(f.confirmations[0].title, "登记拍摄完成");
  const success = f.messages.find(message => message.type === "success").message;
  assert.match(success, /等待游客支付尾款/);
  assert.doesNotMatch(success, /进入观察期|订单已完成/);
});

test("complaint review todo follows role permissions and retains its order filter", async () => {
  const row = { ...order("done"), suggested_action: "rejudge", can_rejudge: false };
  const staff = fixture();
  await staff.ui.kfTodoAction(row);
  assert.deepEqual(staff.navigations, ["svcComplaints"]);
  assert.equal(staff.window.LXM_KF_Filters.keyword, "FLOW-1");
  assert.equal(staff.requests.length, 0);
  const supervisor = fixture("workbench", "service_supervisor");
  await supervisor.ui.kfTodoAction({ ...row, can_rejudge: true, current_resp: "unknown" });
  assert.equal(supervisor.ui.kf.dialog, "rejudge");
  assert.equal(supervisor.ui.kf.form.resp, "unknown");
  assert.equal(supervisor.ui.kfPriority({ priority: 2 }), "高");
  assert.equal(supervisor.ui.kfPriority({ priority: 4 }), "中");
});

test("photographer disposition opens the workbench with the selected photographer filter", async () => {
  const f = fixture();
  f.window.LXM_KF_Filters = { page: "svcFollowup", photo: "PH20260002" };
  await f.mount();
  const url = new URL(f.requests[0].url, "http://fixture");
  assert.equal(url.searchParams.get("photo"), "PH20260002");
  assert.equal(url.searchParams.get("view"), "active");
  assert.equal(f.window.LXM_KF_Filters, undefined);
});
