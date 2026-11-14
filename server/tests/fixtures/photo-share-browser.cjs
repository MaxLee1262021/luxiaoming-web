"use strict";
// TEST ONLY: synthetic in-memory persistence, real API/auth/domain service.
// No database, credentials, payment provider, notification transport or OSS.
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const createApi = require("../../lib/api.cjs");
const { createAuthStore } = require("../../lib/auth.cjs");
const { createPhotoShareService, DEFAULT_RATES } = require("../../lib/photoShare.cjs");
const { verifyPassword } = require("../../lib/mysqlPermissionStore.cjs");
const { MENUS } = require("../../lib/photoRoute.cjs");
const copy = value => structuredClone(value);
const PASSWORD = "QaPhoto123!";
const hash = value => { const salt = crypto.randomBytes(16).toString("hex"); return `lxm1$${salt}$${crypto.scryptSync(value, salt, 64).toString("hex")}`; };
async function startPhotoBrowserFixture() {
  const period = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
  const time = `${period}-11 12:00:00`;
  const rows = { staff: {}, shops: {}, orders: {}, afterSales: {}, logs: {} };
  const source = {
    async list(key) { return Object.values(rows[key] || {}).map(copy); }, async get(key, id) { return rows[key]?.[id] ? copy(rows[key][id]) : null; },
    async create(key, row) { rows[key] ||= {}; const id = row.id || crypto.randomUUID(); rows[key][id] = { ...copy(row), id, _id: id }; return copy(rows[key][id]); },
    async update(key, id, patch) { if (!rows[key]?.[id]) return null; Object.assign(rows[key][id], copy(patch)); return copy(rows[key][id]); },
    async remove(key, id) { delete rows[key]?.[id]; return true; }, async health() { return { configured: true, ready: true, backend: "TEST_ONLY_MEMORY" }; }, async dashboard() { return { orders: 0, shops: 0, revenue: 0 }; }
  };
  await source.create("staff", { id: "qa-photo-super", account: "qa-photo-admin", name: "测试管理员", role: "super", status: "active", password: hash(PASSWORD) });
  await source.create("staff", { id: "PH20260001", account: "qa-photo-self", name: "阿坤", role: "photo", status: "active", password: hash(PASSWORD) });
  await source.create("orders", {id:"qa-legacy-photo-order",orderNo:"QA-LEGACY-PH-DEBT",status:"completed",photographerId:"PH20260001",totalAmount:100,depositPaid:100,depositFinanceStatus:"已审",finalDue:0,completedAt:`${period}-01 12:00:00`,appointmentAt:`${period}-01`,commissionSnapshot:{version:1,netAmount:100,photographerAmount:50,distributorAmount:0,shopAmount:0,headquarterAmount:50},products:[],statusLogs:[]});
  // Normalize the same auth records used by production. Provisioning below
  // executes the real account helper's SQL against these isolated rows.
  let authTables = {
    roles: [{ id: "qa-role-super", role_key: "super", status: "active", name: "管理员" }, { id: "qa-role-photo", role_key: "photo", status: "active", name: "摄影师" }],
    menus: Object.entries({ dashboard: "经营看板", reconciliation:"月度对账", ...MENUS }).map(([key,name]) => ({ id: "menu_"+key, menu_key: key, name, path: "/photo-share/"+key, status:"active", meta_group: "摄影师分成管理", meta_type:"page" })),
    grants: [{ role_id: "qa-role-photo", menu_key: "photoMine" }],
    users: [{ id: "qa-photo-admin", account: "qa-photo-admin", display_name: "测试管理员", password_hash: hash(PASSWORD), role_id:"qa-role-super", status:"active", subject_type:"staff", subject_id:"qa-photo-super" }, { id:"qa-photo-self", account:"qa-photo-self", display_name:"阿坤", password_hash:hash(PASSWORD), role_id:"qa-role-photo",status:"active", subject_type:"photo",subject_id:"PH20260001" }]
  };
  function authConnection(tables) { return { async query(sql, params=[]) {
    if (/^SELECT id,role_key,status FROM lxm_auth_roles/.test(sql)) return [copy(tables.roles.filter(row=>row.role_key==="photo"))];
    if (/^SELECT id,status FROM lxm_auth_menus/.test(sql)) return [copy(tables.menus.filter(row=>row.menu_key==="photoMine"))];
    if (/^SELECT id FROM lxm_auth_users/.test(sql)) return [copy(tables.users.filter(row=>row.account.toLowerCase()===String(params[0]).toLowerCase() || row.subject_type==="photo" && row.subject_id===params[1]))];
    if (/^INSERT IGNORE INTO lxm_auth_role_menus/.test(sql)) { if (!tables.grants.some(row=>row.role_id===params[0] && row.menu_key==="photoMine")) tables.grants.push({role_id:params[0],menu_key:"photoMine"}); return [{affectedRows:1}]; }
    if (/^INSERT INTO lxm_auth_users/.test(sql)) { const [id,account,name,passwordHash,roleId,phone,photoId]=params; tables.users.push({id,account,display_name:name,password_hash:passwordHash,role_id:roleId,status:"active",phone,subject_type:"photo",subject_id:photoId}); return [{affectedRows:1}]; }
    throw new Error("Unsupported TEST_ONLY auth SQL: "+sql);
  } }; }
  const userView=row=>row ? {id:row.id,account:row.account,name:row.display_name,roleId:row.role_id,status:row.status,extra:{subjectType:row.subject_type,subjectId:row.subject_id},updatedAt:row.updated_at || "2026-11-11T00:00:00Z"} : null;
  const permissionStore={required:true,async init(){},async authenticate(account,password){const row=authTables.users.find(row=>row.account===account);return row && verifyPassword(row.password_hash,password) ? userView(row):null;},async getUser(id){return userView(authTables.users.find(row=>row.id===id));},async getPolicyForUser(user){const role=authTables.roles.find(row=>row.id===user.roleId);return {role:role && {id:role.id,roleKey:role.role_key,name:role.name,status:role.status},menuKeys:role?.role_key==="super" ? authTables.menus.map(row=>row.menu_key) : authTables.grants.filter(row=>row.role_id===role?.id).map(row=>row.menu_key)};},async listMenus(){return authTables.menus.map(row=>({id:row.id,menuKey:row.menu_key,name:row.name,status:row.status,path:row.path,meta:{group:row.meta_group,type:row.meta_type}}));},async getRolePermissions(){return [];},async health(){return {configured:true,ready:true,backend:"TEST_ONLY_AUTH"};}};
  let state = { profiles: [], settlements: [], logs: [], rules: [], ledgers: [], adjustments: [], notifications: [], assignments: [], orders: [], phones: [] };
  state.rules.push({ id: "1", ver: 1, beneficiary_type: "photo", party_id: null, rule_mode: "custom", ...DEFAULT_RATES, eff_at: "2020-01-01 00:00:00", reason: "测试初始规则", operator: "QA", created_at: time });
  for (const [id, name, phone, status, rate_mode] of [["PH20260001", "阿坤", "13800000001", "active", "custom"], ["PH20260002", "老赵", "13800000002", "active", "global"], ["PH20260003", "测试暂停摄影师", "13800000003", "paused", "global"], ["PH20260004", "测试已终止摄影师", "13800000004", "ended", "global"]]) state.profiles.push({ id, name, phone, agree_no: `QA-PH-${id}`, status, rate_mode, dispute_days: 5, wait_days: 3, cycle: "monthly", created_at: time });
  state.rules.push({ ...state.rules[0], id: "2", ver: 2, party_id: "PH20260001", rate_combo_bp: 2200, reason: "测试协议套餐22%" });
  const addLedger = (id, party_id, category, net, rate, status, orderStatus = "done") => {
    const biz_no = `QA-PH-ORDER-${id}`;
    state.ledgers.push({ id, biz_no, beneficiary_type: "photo", party_id, category, net_amount_fen: net, rate_bp: rate, rate_mode: party_id === "PH20260001" ? "custom" : "global", rule_ver: party_id === "PH20260001" ? 2 : 1, commission_fen: status === "void" ? 0 : Math.floor(net * rate / 10000), status, zero_reason: status === "void" ? "transfer" : null, customer_openid: "oQA01234567890123456789012345", paid_at: `${period}-01 10:00:00`, done_at: status === "est" ? null : `${period}-10 12:00:00`, settle_id: null, created_at: time, updated_at: time });
    state.orders.push({ id: `order-${id}`, no: biz_no, orderNo: biz_no, photo_id: party_id, service_status: orderStatus, schedule_time: `${period}-13 15:00:00`, product_name: category === "peripheral" ? "测试摄影周边" : "测试长沙旅拍套餐", merchant_name: "测试门店" });
  };
  addLedger("1", "PH20260001", "combo", 299900, 2200, "settleable");
  addLedger("2", "PH20260002", "photo", 69900, 2000, "settleable");
  addLedger("3", "PH20260001", "peripheral", 19900, 800, "settleable");
  addLedger("4", "PH20260002", "combo", 299900, 2000, "void");
  addLedger("5", "PH20260002", "peripheral", 19900, 800, "est", "confirmed");
  let clock = new Date(`${period}-11T04:00:00Z`);
  const store = { async withState(work, options = {}) { const next = copy(state), nextAuth=copy(authTables); for (const person of next.profiles) { const pending = next.orders.filter(order => order.photo_id === person.id && ["claimed", "confirmed", "shooting"].includes(order.service_status)); person.pending_count = pending.length; person.pending_orders = pending.map(order => ({ order_no: order.orderNo, status: order.service_status, schedule_time: order.schedule_time })); } const result = await work(next,{conn:authConnection(nextAuth)}); if (!options.readOnly) { state = next; authTables=nextAuth; } return copy(result); } };
  const photoService = createPhotoShareService({ store, clock: () => clock });
  const auth = createAuthStore({ sessionStore: "memory" });
  const api = createApi(source, "json", { auth, photoService, permissionStore, wechatPay: { isConfigured: () => false, configurationErrors: () => ["TEST_ONLY"], configSummary: () => ({ configured: false }) }, sourceStatus: { ready: true, configured: true } });
  const staticHandler = require("../../lib/static.cjs")(path.resolve(__dirname, "../../.."));
  const requests = [];
  const server = http.createServer((req, res) => { const pathname = (req.url || "/").split("?")[0]; requests.push({ method: req.method, pathname }); if (pathname === "/runtime-config.js") { res.setHeader("Content-Type", "application/javascript"); return res.end("window.LXM_RUNTIME_CONFIG={};"); } Promise.resolve(pathname.startsWith("/api/") ? api(req, res, pathname) : staticHandler(req, res, pathname)).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, source, store, photoService, requests, period, accounts: { admin: { account: "qa-photo-admin", password: PASSWORD }, photo: { account: "qa-photo-self", password: PASSWORD } }, snapshot: () => copy(state), authSnapshot:()=>copy(authTables), advance: value => { clock = new Date(value); }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await auth.close(); } };
}
module.exports = { startPhotoBrowserFixture };
