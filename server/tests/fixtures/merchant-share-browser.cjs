"use strict";
// TEST ONLY. Standalone browser fixture: real HTTP API, auth and share service;
// synthetic in-memory persistence/QR image. Never packaged or served in release.
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const createApi = require("../../lib/api.cjs");
const { createAuthStore } = require("../../lib/auth.cjs");
const { qrScene } = require("../../lib/merchantShare.cjs");
const { shareError } = require("../../lib/shareEngine.cjs");
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const idOf = row => String(row && (row.id || row._id || row.merchantId) || "");
const PASSWORD = "QaFixture123!";
const hash = value => { const salt = crypto.randomBytes(16).toString("hex"); return `lxm1$${salt}$${crypto.scryptSync(value, salt, 64).toString("hex")}`; };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=";

async function startBrowserFixture(options = {}) {
  const merchantRoleStatus = options.merchantRoleStatus || "active";
  const now = () => new Date().toISOString();
  const period = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
  const rows = { staff: {}, shops: {}, orders: {}, afterSales: {}, logs: {}, siteConfig: {} };
  const source = {
    async list(key) { return Object.values(rows[key] || {}).map(copy); },
    async get(key, id) { return copy(rows[key]?.[id]) || null; },
    async create(key, row) { rows[key] ||= {}; const id = idOf(row) || `fixture_${crypto.randomUUID()}`; rows[key][id] = { ...copy(row), id, _id: id }; return copy(rows[key][id]); },
    async update(key, id, patch) { if (!rows[key]?.[id]) return null; rows[key][id] = { ...rows[key][id], ...copy(patch) }; return copy(rows[key][id]); },
    async remove(key, id) { delete rows[key]?.[id]; return true; },
    async dashboard() { return { orders: 0, shops: 2, revenue: 0 }; },
    async health() { return { ready: true, configured: true, backend: "browser-fixture" }; },
  };
  await source.create("staff", { id: "qa-super", account: "qa-admin", name: "QA测试管理员", role: "super", status: "active", password: hash(PASSWORD) });
  const merchants = new Map(), rules = new Map(), qrs = new Map(), audit = [];
  for (const [id, name, configured] of [["qa-m1", "QA测试门店一", true], ["qa-m2", "QA未配置门店", false]]) {
    const merchant = { id, merchantId: id, name, status: "OPEN", account: `qa-${id}`, contact: "测试联系人", phone: "13800000000", address: "测试地址，不对应实际门店", unconfigured: !configured };
    merchants.set(id, merchant);
    await source.create("shops", { ...merchant, status: "合作中", shopId: id, password: hash(PASSWORD) });
    rules.set(id, configured ? [{ merchantId: id, versionNo: 1, versionLabel: "R-QA-1", ratioT1: "0.0500", ratioT2: "0.0300", ttlHours: 720, refundWindowDays: 3, reason: "QA初始配置", operatorName: "QA测试管理员", effectiveAt: now(), status: "ACTIVE" }] : []);
    qrs.set(id, [{ id: `qr-${id}`, merchantId: id, shortCode: "AABBCCDDEEFF01", scene: qrScene("AABBCCDDEEFF01"), imageUrl: PNG, status: "ACTIVE", scanCount: 12, createdAt: now() }]);
  }
  const details = [
    { detailNo: "SHR-QA-POSITIVE", merchantId: "qa-m1", orderId: "qa-order-1001", splitType: "T1", ratio: "0.0500", amount: "50.00", direction: 1, period },
    { detailNo: "SHR-QA-REVERSE", merchantId: "qa-m1", orderId: "qa-order-1001", splitType: "T1", ratio: "0.0500", amount: "-5.00", direction: 2, period },
    { detailNo: "SHR-QA-SERVICE", merchantId: "qa-m1", orderId: "qa-order-2002", splitType: "T2", ratio: "0.0300", amount: "30.00", direction: 1, period },
  ].map(row => ({ ...row, merchantName: "QA测试门店一", createdAt: now(), payTime: now(), display: { orderNo: row.orderId === "qa-order-1001" ? "QA-PRIVATE-ORDER-1001" : "QA-PRIVATE-ORDER-2002", customer: "QA_PRIVATE_CUSTOMER", openid: "QA_PRIVATE_OPENID", phone: "13900000000", productName: "QA测试旅拍套餐", paidAmount: "1000.00", payTime: now() } }));
  const sums = list => ({ positiveAmount: list.reduce((n, r) => n + Math.max(Number(r.amount), 0), 0).toFixed(2), reverseAmount: list.reduce((n, r) => n + Math.min(Number(r.amount), 0), 0).toFixed(2), netAmount: list.reduce((n, r) => n + Number(r.amount), 0).toFixed(2) });
  const store = {
    async getMerchant(id) { return copy(merchants.get(id)) || null; },
    async getRules(id) { return copy(rules.get(id) || []); },
    async getActiveQr(id) { return copy((qrs.get(id) || []).find(r => r.status === "ACTIVE")) || null; },
    async listQrs(id) { return copy(qrs.get(id) || []); },
    async listMerchants() { return [...merchants.values()].map(row => ({ ...copy(row), unconfigured: !(rules.get(idOf(row)) || []).length })); },
    async getMerchantStats(id) { const list = details.filter(r => r.merchantId === id); return { scanCount: 12, boundUsers: 4, monthOrders: 2, accT1Amount: sums(list.filter(r => r.splitType === "T1")).netAmount, accT2Amount: sums(list.filter(r => r.splitType === "T2")).netAmount, monthAmount: sums(list).netAmount, dailyScans: [{ date: `${period}-01`, count: 5 }, { date: `${period}-02`, count: 7 }] }; },
    async listRuleSummaries(filter) {
      const result = (await store.listMerchants()).map(row => ({ ...row, ...(rules.get(idOf(row)) || [])[0], ...awaitableStats(row), status: (rules.get(idOf(row)) || []).length ? "ACTIVE" : "UNCONFIGURED", merchantStatus: row.status }));
      const selected = result.filter(row => (!filter.keyword || `${row.name} ${row.merchantId}`.includes(filter.keyword)) && (!filter.status || row.status === filter.status));
      return { total: selected.length, list: selected.slice((filter.page - 1) * filter.size, filter.page * filter.size) };
    },
    async listDetails(filter) { const selected = details.filter(r => (!filter.merchantId || r.merchantId === filter.merchantId) && (!filter.period || r.period === filter.period) && (!filter.splitType || r.splitType === filter.splitType)); const page = filter.page || 1, size = filter.size || 20; return { total: selected.length, orderCount: new Set(selected.map(row => row.orderId)).size, list: copy(selected.slice((page - 1) * size, page * size)), sum: sums(selected) }; },
    async saveRule(input) {
      const previous = rules.get(input.merchantId) || [];
      if (Number(input.expectedVersion) !== Number(previous[0]?.versionNo || 0)) throw shareError("SHARE_4091", "配置已被他人修改，请刷新后重试", 409);
      const next = { ...input, versionNo: Number(previous[0]?.versionNo || 0) + 1, effectiveAt: now(), operatorName: "QA测试管理员", status: "ACTIVE" };
      rules.set(input.merchantId, [next, ...previous.map(r => ({ ...r, status: "SUPERSEDED" }))]); audit.push({ action: "RULE_SAVE", input: copy(input) }); return copy(next);
    },
    async upsertMerchant(input) { const previous = merchants.get(input.merchantId) || {}; const next = { ...previous, ...input }; merchants.set(input.merchantId, next); return copy(next); },
    async onboardMerchant(input, options) {
      if ([...merchants.values()].some(r => r.name === input.name)) throw shareError("SHARE_4006", "商家名称已存在", 400);
      if ((await source.list("shops")).some(r => r.account === input.account)) throw shareError("SHARE_4001", "账号已存在", 400);
      let account;
      // Emulate only the account/shops projection transaction callback. This is
      // explicitly a test persistence adapter, never a production SQL fallback.
      await options.beforeCommit({ query: async (sql, args = []) => {
        if (sql.startsWith("SELECT id,status FROM lxm_auth_roles")) return [[{ id: "role_merchant", status: merchantRoleStatus }]];
        if (sql.startsWith("INSERT INTO lxm_auth_users")) account = { account: args[1], password: args[3] };
        if (sql.startsWith("INSERT INTO lxm_shops")) await source.create("shops", { id: args[0], name: args[1], shopId: args[2], ...account, contact: args[4], phone: args[5], address: args[6], status: "合作中" });
        return [{ affectedRows: 1 }];
      } });
      merchants.set(input.merchantId, { ...copy(input), qr: undefined, password: undefined, unconfigured: false });
      rules.set(input.merchantId, [{ ...input, qr: undefined, versionNo: 1, effectiveAt: now(), operatorName: "QA测试管理员", status: "ACTIVE" }]);
      qrs.set(input.merchantId, [{ ...input.qr, createdAt: now() }]);
      audit.push({ action: "ONBOARD", input: { ...copy(input), password: undefined, qr: undefined } }); return { merchant: copy(merchants.get(input.merchantId)), ruleVersion: 1 };
    },
    async audit(...input) { audit.push(copy(input)); },
  };
  function awaitableStats(row) { const list = details.filter(r => r.merchantId === idOf(row)); return { accT1Amount: sums(list.filter(r => r.splitType === "T1")).netAmount, accT2Amount: sums(list.filter(r => r.splitType === "T2")).netAmount }; }
  const auth = createAuthStore({ sessionStore: "memory" });
  const wechatPay = { isConfigured: () => false, configurationErrors: () => ["TEST_ONLY_NO_REAL_PAYMENT"], configSummary: () => ({ configured: false }) };
  const api = createApi(source, "json", { auth, wechatPay, permissionStore: null, customerService:options.customerService, sourceStatus: { configured: true, ready: true }, shareOptions: { store, enableAt: "2026-01-01T00:00:00Z", qrProvider: async () => PNG } });
  const staticHandler = require("../../lib/static.cjs")(path.resolve(__dirname, "../../.."));
  const requests = [];
  const server = http.createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    requests.push({ method: req.method, pathname });
    if (pathname === "/runtime-config.js") { res.setHeader("Content-Type", "application/javascript"); return res.end("window.LXM_RUNTIME_CONFIG={};"); }
    Promise.resolve(pathname.startsWith("/api/") ? api(req, res, pathname) : staticHandler(req, res, pathname)).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, source, store, requests, audit, period,
    accounts: { admin: { account: "qa-admin", password: PASSWORD }, merchant: { account: "qa-qa-m1", password: PASSWORD } },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await auth.close(); },
  };
}
if (require.main === module) startBrowserFixture().then(fixture => console.log(JSON.stringify({ url: fixture.url, accounts: fixture.accounts, TEST_ONLY: true })));
module.exports = { startBrowserFixture };
