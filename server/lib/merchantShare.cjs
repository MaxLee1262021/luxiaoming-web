"use strict";

const crypto = require("node:crypto");
const { createQrProvider, businessDate, QR_ERROR_MESSAGES } = require("./merchantCodes.cjs");
const { hashPassword, verifyPassword, isBuiltinAdminAccount } = require("./permissionStore.cjs");
const services = new WeakMap();
const SHARE_ROUTES = ["shareRules", "shareDetails", "shareMine"];
const SAFE_MERCHANT_FIELDS = ["name", "contact", "phone", "address", "businessLicenseNo", "invoiceTitle", "taxNo", "bankName", "bankAccount", "accountHolder"];

function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code: `SHARE_${code}`, statusCode });
}
function str(value) { return String(value == null ? "" : value).trim(); }
function uid(prefix) { return `${prefix}_${crypto.randomBytes(12).toString("hex")}`; }
function checkScene(shortCode) {
  return [...shortCode].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 36, 0).toString(36).toUpperCase();
}
function qrScene(shortCode) { return `S${shortCode}${checkScene(shortCode)}`; }
function validateScene(value) {
  const scene = str(value);
  const match = /^S([A-Z0-9]{8,28})([A-Z0-9])$/.exec(scene);
  if (!match || scene.length > 32 || checkScene(match[1]) !== match[2]) throw failure(4002, "商家码无效");
  return scene;
}
function monthNow(now = new Date()) { return businessDate(now).slice(0, 7); }
function filters(input = {}, now) {
  const period = str(input.period) || monthNow(now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw failure(4001, "请选择有效月份");
  if (input.splitType && !["T1", "T2"].includes(input.splitType)) throw failure(4001, "分成类型无效");
  return { merchantId: str(input.merchantId), period, splitType: str(input.splitType), page: Math.max(1, Number(input.page) || 1), size: Math.min(2000, Math.max(1, Number(input.size) || 20)) };
}
function merchantFields(input = {}) {
  const result = {};
  for (const key of SAFE_MERCHANT_FIELDS) if (Object.hasOwn(input, key)) result[key] = str(input[key]);
  if (result.name !== undefined && (!result.name || result.name.length > 128)) throw failure(4001, "商家名称必填，最多128个字符");
  if (result.phone && !/^1\d{10}$/.test(result.phone)) throw failure(4001, "联系电话须为11位手机号，或留空");
  for (const [key, value] of Object.entries(result)) if (value.length > (key === "address" ? 1000 : 255)) throw failure(4001, "填写内容过长");
  return result;
}
function ruleFields(input = {}) {
  const r1 = input.ratioT1, r2 = input.ratioT2;
  if (r1 === "" || r1 === undefined || r2 === "" || r2 === undefined) throw failure(4001, "两项分成比例均必填");
  // Decimal ratios are 0..0.5. The engine rejects excess precision and avoids binary arithmetic.
  for (const value of [r1, r2]) {
    if (!/^\d(?:\.\d{1,4})?$/.test(String(value)) || Number(value) < 0 || Number(value) > 0.5) throw failure(4001, "分成比例须为0–50%，精度0.01%");
  }
  const ttlHours = input.ttlHours === undefined ? 720 : Number(input.ttlHours);
  const refundWindowDays = input.refundWindowDays === undefined ? 3 : Number(input.refundWindowDays);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 87600) throw failure(4001, "客服订单分成时效须为1–87600整数小时");
  if (!Number.isInteger(refundWindowDays) || refundWindowDays < 0 || refundWindowDays > 365) throw failure(4001, "平台退款窗口期须为0–365整数天");
  const reason = str(input.reason);
  if (!reason || reason.length > 255) throw failure(4001, "请填写变更或开通说明，最多255个字符");
  return { ratioT1: String(r1), ratioT2: String(r2), ttlHours, refundWindowDays, reason };
}
function grantedRoutes(session = {}) {
  const keys = new Set(session.menuKeys || []);
  for (const menu of session.menuDefinitions || []) if (keys.has(menu.key)) keys.add(menu.routeKey);
  return keys;
}
function canShare(session = {}, action = "view") {
  if (session.kind && session.kind !== "admin") return false;
  if (["super", "admin", "administrator"].includes(str(session.role))) return true;
  if (session.role === "merchant") return action === "mine" && !!str(session.shopId || session.subjectId);
  if(action==='admin') return false;
  if(['finance','service','photo'].includes(session.role) && action!=='view') return false;
  const permissions = new Set(session.sharePermissions || []);
  const routes = grantedRoutes(session);
  if (action === "config") return permissions.has("share:config") && routes.has('shareRules');
  return action === "view" && ["shareRules", "shareDetails"].some(k => routes.has(k));
}
function requireShare(session, action) {
  if (!canShare(session, action)) throw failure(4030, "无操作权限", 403);
}
function merchantProjection(row) {
  if (!row) return null;
  const out = {};
  for (const key of ["merchantId", "id", ...SAFE_MERCHANT_FIELDS, "status", "refundWindowDays", "account", "createdAt", "updatedAt", "cooperationConfirmed"]) if (row[key] !== undefined) out[key] = row[key];
  out.merchantId = str(row.merchantId || row.id);
  return out;
}
function merchantDetail(row) {
  return {
    detailNo: row.detailNo, orderNo: `****${str(row.orderNo).slice(-4)}`,
    payTime: row.payTime, splitType: row.splitType,
    splitTypeText: row.splitType === "T2" ? "客服推荐下单" : "用户自主下单",
    direction: row.direction, ratio: row.ratio, amount: row.amount,
    payAmount: row.payAmount, period: row.period,
  };
}
function adminDetail(row) {
  const display = row.display || row.displayJson || {};
  const customer = str(display.userLabel || display.customer);
  return {...row,detailNo:row.detailNo || row.id,
    orderNo:display.orderNo || row.orderNo || '',
    goodsName:display.productName || display.goodsName || row.goodsName || '',
    userLabel:customer.includes('*') ? customer : customer ? `${customer.slice(0,1)}**` : '用户',
    payAmount:display.paidAmount || display.payAmount || row.paidTotal || '0.00',
    payTime:row.payTime || display.payTime,
    splitTypeText:row.splitType==='T2'?'客服推荐下单':'用户自主下单'};
}
function safeCsv(value) {
  const text = String(value ?? "");
  const guarded = /^[\u0000-\u0020]*[=+@]/.test(text) || /^[\u0000-\u0020]*-/.test(text) && !/^-\d+(?:\.\d+)?$/.test(text.trim()) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function createShareService(source, options = {}) {
  const store = options.store || require("./shareStore.cjs").createShareStore(source, { enableAt: options.enableAt || process.env.SHARE_ENABLE_AT, clock: options.clock,
    csAttrDays:Number(process.env.CS_ATTR_DAYS ?? 7),candidateLimit:Number(process.env.MAX_CANDIDATE_MERCHANTS ?? 20),
    defaultTtlHours:Number(process.env.DEFAULT_TTL_HOURS ?? 720),dedupSeconds:Number(process.env.SCAN_DEDUP_SECONDS ?? 5),judgeRetryMax:Number(process.env.JUDGE_RETRY_MAX ?? 3) });
  const clock = options.clock || (() => new Date());
  const provider = options.qrProvider || createQrProvider({ maxImageBytes: 3 * 1024 * 1024 });
  const enableAt = () => str(options.enableAt || process.env.SHARE_ENABLE_AT);
  const operator = s => str(s.authzUserId || s.subjectId || s.account);
  const audit = input => store.audit(input.action,input.merchantId || input.orderId || input.operatorId,input,input.operatorId);
  const enabledNow = () => {
    const at=enableAt();
    return !!at && require('./shareEngine.cjs').time(clock())>=require('./shareEngine.cjs').time(at);
  };
  async function requireMerchant(id) {
    const row = await store.getMerchant(str(id));
    if (!row) throw failure(4003, "商家不存在", 404);
    return row;
  }
  async function buildQr(merchantId, stableId) {
    const shortCode = crypto.randomBytes(7).toString("hex").toUpperCase();
    const scene = qrScene(shortCode);
    let imageUrl;
    try { imageUrl = await provider(scene); }
    catch (error) {
      const code = Object.hasOwn(QR_ERROR_MESSAGES, error?.code) ? error.code : "QR_API_UNAVAILABLE";
      throw Object.assign(failure(code, QR_ERROR_MESSAGES[code], 503), {
        ...(Number.isSafeInteger(error?.wechatCode) ? { wechatCode: error.wechatCode } : {}),
      });
    }
    if (!/^data:image\/(?:png|jpeg);base64,/.test(imageUrl)) throw failure("QR_RESPONSE_INVALID", QR_ERROR_MESSAGES.QR_RESPONSE_INVALID, 503);
    return { id: stableId || uid("qr"), merchantId, shortCode, scene, imageUrl, status: "ACTIVE" };
  }
  async function detail(id, session) {
    requireShare(session, "view");
    const merchant = await requireMerchant(id);
    const [history, qr, qrHistory, stats] = await Promise.all([store.getRules(id), store.getActiveQr(id), store.listQrs(id), store.getMerchantStats(id)]);
    return { merchant: merchantProjection(merchant), rule: history[0] || null, history, qr:qr?{...qr,scanCount:stats.scanCount}:null, qrHistory, stats };
  }
  async function onboard(input, session, requestKey) {
    requireShare(session, "config");
    const values = merchantFields(input);
    if (!values.name) throw failure(4001, "商家名称必填");
    if (input.cooperationConfirmed !== true) throw failure(4001, "请确认市场人员已沟通并明确合作意向");
    const account = str(input.account), password = String(input.password || '');
    if (!account || account.length>128 || /[\u0000-\u001f\u007f]/.test(account)) throw failure(4001, "请填写128个字符以内的登录账号");
    if(isBuiltinAdminAccount(account)) throw failure(4001,'该登录账号为平台保留，请更换商家账号');
    if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw failure(4001, "密码须为8–128位且包含字母和数字");
    if (!requestKey || str(requestKey).length > 200) throw failure(4001, "请提供本次入驻请求标识");
    const merchantId = `sm_${crypto.createHash("sha256").update(`${operator(session)}:${requestKey}`).digest("hex").slice(0, 24)}`;
    const rules = ruleFields(input);
    const onboardRequestHash=crypto.createHash('sha256').update(JSON.stringify({...values,account,...rules,ratioT1:Number(rules.ratioT1).toFixed(4),ratioT2:Number(rules.ratioT2).toFixed(4)})).digest('hex');
    async function replay(existing) {
      if(existing.onboardRequestHash && existing.onboardRequestHash!==onboardRequestHash || !existing.onboardRequestHash && (existing.name!==values.name || existing.account!==account)) throw failure(4090,'同一入驻请求标识不能提交不同资料',409);
      if(source.transaction) {
        const [users]=await source.transaction(conn=>conn.query('SELECT password_hash FROM lxm_auth_users WHERE id=?',[`usr_${merchantId}`]));
        if(users.length!==1 || !verifyPassword(users[0].password_hash,password)) throw failure(4090,'入驻请求的账号凭据已变化，请刷新后重试',409);
      }
      return { merchantId, merchant: merchantProjection(existing), existed: true };
    }
    const existing = await store.getMerchant(merchantId);
    if(existing) return replay(existing);
    if(store.getMerchantByName && await store.getMerchantByName(values.name)) throw failure(4006,'商家名称已存在，请用品牌·门店名区分',409);
    if(source.transaction) {
      const [accounts]=await source.transaction(conn=>conn.query('SELECT id FROM lxm_auth_users WHERE account=? LIMIT 1',[account]));
      if(accounts.length) throw failure(4001,'登录账号已存在，请更换账号',409);
    }
    const qr = await buildQr(merchantId, `qr_${merchantId}`);
    const passwordHash = hashPassword(password);
    const userId = `usr_${merchantId}`;
    const result = await store.onboardMerchant({ ...values, ...rules, merchantId, id: merchantId, account, onboardRequestHash, status: "OPEN", cooperationConfirmed: true, operatorId: operator(session), qr }, {
      beforeCommit: async conn => {
        // Same database connection as merchant/rule/QR creation. A duplicate account rolls back everything.
        await conn.query("INSERT INTO lxm_auth_roles (id,role_key,name,status,description) VALUES ('role_merchant','merchant','商家','active','商家本人，仅我的分成') ON DUPLICATE KEY UPDATE id=id");
        const [roles]=await conn.query("SELECT id,status FROM lxm_auth_roles WHERE id='role_merchant' FOR UPDATE");
        if(roles.length!==1 || ['disabled','inactive','停用','禁用'].includes(String(roles[0].status).toLowerCase())) throw failure(4030,'商家账号角色已停用，请联系权限管理员',403);
        await conn.query("INSERT IGNORE INTO lxm_auth_role_menus (role_id,menu_key) VALUES ('role_merchant','shareMine')");
        await conn.query("INSERT INTO lxm_auth_users (id,account,display_name,password_hash,role_id,status,subject_type,subject_id,shop_id) VALUES (?,?,?,?,?,'active','merchant',?,?)", [userId, account, values.name, passwordHash, 'role_merchant', merchantId, merchantId]);
        await conn.query("INSERT INTO lxm_shops (id,name,shopId,account,contact,phone,address,status,commissionRate,shareRatio,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'合作中',0,0,?,?)", [merchantId, values.name, merchantId, account, values.contact || '', values.phone || '', values.address || '', clock().toISOString(), clock().toISOString()]);
      }
    });
    if(result.existed) return replay(result.merchant);
    return { ...result, merchantId, merchant: merchantProjection(result.merchant || result), qr: undefined };
  }
  async function updateMerchant(id, input, session) {
    requireShare(session, "config");
    const current = await requireMerchant(id);
    const patch = merchantFields(input);
    const reason = str(input.reason) || "维护商家资料";
    const updated = await store.upsertMerchant({ ...current, ...patch, merchantId: id, operatorId: operator(session), reason });
    // Business projection contains no credentials or banking details.
    if (source.update) await source.update("shops", id, Object.fromEntries(Object.entries(patch).filter(([k]) => ['name','contact','phone','address'].includes(k))));
    await audit({ action: "MERCHANT_EDIT", merchantId: id, operatorId: operator(session), reason, before: merchantProjection(current), after: merchantProjection(updated) });
    return merchantProjection(updated);
  }
  async function setStatus(id, input, session) {
    requireShare(session, "config");
    if (!["OPEN", "CLOSED", "CANCELLED"].includes(input.status) || !str(input.reason)) throw failure(4001, "状态及操作原因必填");
    const current = await requireMerchant(id);
    if (current.status === "CANCELLED" && input.status !== "CANCELLED") throw failure(4001, "已注销商家请重新入驻");
    const result = await store.upsertMerchant({ ...current, merchantId: id, status: input.status, operatorId: operator(session), reason: str(input.reason) });
    await audit({ action: "MERCHANT_STATUS", merchantId: id, operatorId: operator(session), reason: str(input.reason), before: {status:current.status}, after:{status:input.status} });
    if (source.update) await source.update("shops", id, {status:input.status === "OPEN" ? "合作中" : "停用"});
    return merchantProjection(result);
  }
  async function saveRule(input, session) {
    requireShare(session, "config");
    await requireMerchant(input.merchantId);
    return store.saveRule({ ...ruleFields(input), merchantId: str(input.merchantId), expectedVersion: input.versionNo ?? input.expectedVersion, operatorId: operator(session) });
  }
  async function listRules(query, session) {
    requireShare(session, "view");
    const status = {configured:'ACTIVE',unconfigured:'UNCONFIGURED'}[query.status] || str(query.status);
    const result = await store.listRuleSummaries({ keyword: str(query.keyword), status, page: Math.max(1,Number(query.page)||1), size:Math.min(100,Math.max(1,Number(query.size)||20)) });
    if (result.summary) return result;
    const all = await store.listMerchants({});
    const monthly = await store.listDetails({period:monthNow(clock()),page:1,size:1});
    return {...result,summary:{total:all.length,configured:all.filter(m=>!m.unconfigured).length,unconfigured:all.filter(m=>m.unconfigured).length,monthNetAmount:monthly.sum?.netAmount || monthly.totalAmount || '0.00'}};
  }
  async function listDetails(query, session) {
    requireShare(session, "view");
    const result=await store.listDetails(filters(query, clock()));
    return {...result,list:result.list.map(adminDetail),sum:result.sum || {netAmount:result.totalAmount || '0.00'}};
  }
  async function mine(query, session) {
    requireShare(session, "mine");
    const id = session.role === 'merchant' ? str(session.shopId || session.subjectId) : str(query.merchantId);
    if(!id) return {merchant:null,rule:null,stats:{},list:[],total:0,sum:{netAmount:'0.00'},selectMerchant:true};
    const merchant = await requireMerchant(id);
    const [history,result,stats] = await Promise.all([store.getRules(id),store.listDetails({ ...filters(query, clock()), merchantId:id }),store.getMerchantStats(id)]);
    return {
      merchant:{merchantId:id,name:merchant.name,status:merchant.status},
      rule: history[0] ? {ratioT1:history[0].ratioT1,ratioT2:history[0].ratioT2,ttlHours:history[0].ttlHours,refundWindowDays:history[0].refundWindowDays} : null,
      stats: { boundUsers:stats.boundUsers ?? stats.bindingCount ?? 0, accT1Amount:stats.accT1Amount || "0.00", accT2Amount:stats.accT2Amount || "0.00", monthAmount:result.sum?.netAmount || "0.00", monthOrders:stats.monthOrders ?? result.total },
      list: result.list.map(adminDetail).map(merchantDetail), total:result.total, sum:result.sum,
    };
  }
  async function qr(id, session) { requireShare(session,"view");await requireMerchant(id); return store.getActiveQr(id); }
  async function generateQr(id,session) {
    requireShare(session,'config');await requireMerchant(id);
    const existing=await store.getActiveQr(id);
    if(existing) return {...existing,existed:true};
    const generated=await buildQr(id);
    try {return await store.saveQr({...generated,merchantId:id,reason:'补发商家码',operatorId:operator(session)});}
    catch(error){const concurrent=await store.getActiveQr(id);if(concurrent) return {...concurrent,existed:true};throw error;}
  }
  async function rotate(id, input, session) {
    requireShare(session,"config");
    await requireMerchant(id);
    const reason = str(input.reason);
    if (!reason) throw failure(4001,"换码原因必填");
    const next = await buildQr(id);
    return store.rotateQr({...next,merchantId:id,reason,operatorId:operator(session),requestId:str(input.requestId)});
  }
  async function reportScan(session, input) {
    if (session.kind !== "public" || !str(session.openid)) throw failure(4030,"请先登录",401);
    let scene;
    try {scene=validateScene(input.scene);}
    catch(error){if(store.recordObservation) await store.recordObservation({metricKey:'SCENE_PARSE',success:false});throw error;}
    const active = await store.getQrByScene(scene);
    if(store.recordObservation) await store.recordObservation({metricKey:'SCENE_PARSE',success:!!active});
    if (!active) throw failure(4002,"商家码无效");
    if (active.status !== "ACTIVE") {
      if(store.recordObservation) await store.recordObservation({metricKey:'DISABLED_QR_SCAN',subjectId:String(active.id),success:false});
      throw failure(4004,"该码已停用，请联系门店");
    }
    // Traffic collection is independent of commission activation. Before that
    // boundary a real scan is counted without establishing attribution evidence.
    const result=await store.reportScan({userId:str(session.openid),merchantId:active.merchantId,qrId:active.id,scene,launchType:input.launchType,deviceId:str(input.deviceId).slice(0,128),clientScanAt:str(input.clientScanAt),requestKey:input.requestKey,bindEligible:enabledNow()});
    return {merchantId:active.merchantId,recorded:!result.deduplicated,deduped:!!result.deduplicated,scanId:result.scan?.id || result.scanId};
  }
  async function reportClick(session, input) {
    if (session.kind !== "public" || !str(session.openid)) throw failure(4030,"请先登录",401);
    if(!enabledNow()) return {recorded:false,reason:'SHARE_NOT_ENABLED'};
    let staffId = null;
    const wecomId = str(input.staffWecomId || input.staff_id);
    const linkId=str(input.linkId || input.link_id).slice(0,128);
    const link=linkId ? await store.getCsLink(linkId) : null;
    if(link && link.status==='ACTIVE' && require('./shareEngine.cjs').time(link.expiresAt)>require('./shareEngine.cjs').time(clock()) && wecomId && str(link.wecomUserId)===wecomId) staffId=link.staffId;
    const missingLink=linkId || `missing_${crypto.createHash('sha256').update(`${session.openid}:${Math.floor(clock().getTime()/30000)}`).digest('hex').slice(0,24)}`;
    const result = await store.reportClick({userId:str(session.openid),staffId,linkId:missingLink,channel:'WECOM',sessionId:str(session.sessionId || session.createdAt || session.id || ''),missing:!wecomId || !staffId});
    return {clickId:result.click?.id || result.clickId,staffId:staffId || null,clickAt:result.click?.clickAt || result.clickAt,existed:!!result.existed,...(!staffId?{warning:'STAFF_UNMAPPED'}:{})};
  }
  async function createCsLink(input,session) {
    if(session.kind!=='admin' || session.role==='merchant' || !(session.role==='service' && grantedRoutes(session).has('orders') || canShare(session,'view'))) throw failure(4030,'无操作权限',403);
    const staffId=session.role==='super' && input.staffId ? str(input.staffId) : str(session.authzUserId || session.subjectId);
    const [mapping]=await source.transaction(conn=>conn.query("SELECT m.wecom_userid,m.staff_id FROM lxm_share_staff_map m JOIN lxm_auth_users u ON u.id=m.staff_id WHERE m.staff_id=? AND m.status='ACTIVE' AND u.status='active' LIMIT 1",[staffId]));
    if(!mapping.length) throw failure(4001,'请先配置该客服的企业微信映射');
    if(!str(input.requestId)) throw failure(4001,'请提供本次链接生成请求标识');
    const existing=await store.getCsLinkByRequest(operator(session),str(input.requestId));
    if(existing && (existing.staffId!==staffId || existing.wecomUserId!==mapping[0].wecom_userid)) throw failure(4090,'同一请求标识不能生成不同客服的链接',409);
    const linkId=existing?.linkId || crypto.randomBytes(16).toString('hex');
    const link=existing || await store.createCsLink({linkId,requestId:str(input.requestId),staffId,wecomUserId:mapping[0].wecom_userid,operatorId:operator(session),expiresAt:new Date(clock().getTime()+7*86400000).toISOString()});
    return {linkId:link.linkId || linkId,expiresAt:link.expiresAt,path:`pages/index/index?staff_id=${encodeURIComponent(link.wecomUserId)}&link_id=${linkId}`};
  }
  async function exportCsv(query, session) {
    requireShare(session,'view');
    const raw = await store.listDetails({...filters(query,clock()),all:true});
    const result={...raw,list:raw.list.map(adminDetail)};
    const header = ['分成明细号','下单用户','商品名称','实付金额','支付时间','订单号','商家','类型','分成比例','分成金额'];
    const data = result.list.map(r=>[r.detailNo,r.userLabel,r.goodsName,r.payAmount,r.payTime,r.orderNo,r.merchantName,`${r.splitType==='T2'?'客服推荐下单':'用户自主下单'}${Number(r.direction)===2?'（冲抵）':''}`,`${(Number(r.ratio)*100).toFixed(2)}%`,r.amount]);
    await audit({action:'DETAIL_EXPORT',operatorId:operator(session),reason:JSON.stringify(filters(query,clock())),count:result.total});
    return '\uFEFF'+[header,...data].map(row=>row.map(safeCsv).join(',')).join('\r\n');
  }
  async function analytics(query,session) {
    requireShare(session,'view');
    const {moneyToCents,formatMoney,time}=require('./shareEngine.cjs');
    if(query.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.period)) throw failure(4001,'月份无效');
    for(const value of [query.startDate,query.endDate].filter(Boolean)) if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure(4001,'日期无效');
    const [result, merchantRows, operationalFacts, cityRows] = await Promise.all([
      store.listDetails({merchantId:str(query.merchantId),period:str(query.period),all:true,page:1,size:100000}),
      store.listMerchants({}),
      store.readOperationalFacts ? store.readOperationalFacts({tables:['job','snapshot','detail','correction']}) : null,
      query.cityId ? source.list('orders') : [],
    ]);
    const since=query.startDate?time(`${query.startDate}T00:00:00+08:00`):null;
    const until=query.endDate?time(`${query.endDate}T00:00:00+08:00`)+86400000:null;
    const cityOrders=query.cityId ? new Set(cityRows.filter(o=>String(o.cityId || o.source?.cityId || o.bookingCityId || o.products?.[0]?.cityId || '')===String(query.cityId)).map(o=>String(o.id || o._id))) : null;
    const list=result.list.filter(r=>(since===null || time(r.createdAt)>=since)&&(until===null || time(r.createdAt)<until)&&(!cityOrders || cityOrders.has(String(r.orderId))));
    const byMerchant=new Map(merchantRows.filter(m=>!query.merchantId || String(m.merchantId)===String(query.merchantId)).map(m=>[String(m.merchantId),{merchantId:String(m.merchantId),name:m.name,scanCount:m.scanCount||0,boundUsers:m.boundUsers||0,orderCount:0,monthOrders:0,accT1Amount:'0.00',accT2Amount:'0.00',totalAmount:'0.00',monthAmount:'0.00'}]));
    const movements=new Map();
    for(const row of list) {
      const merchant=byMerchant.get(String(row.merchantId));if(!merchant) continue;
      const key=row.splitType==='T2'?'accT2Amount':'accT1Amount';
      merchant[key]=formatMoney(moneyToCents(merchant[key],{signed:true})+moneyToCents(row.amount,{signed:true}));
      movements.set(String(row.orderId),(movements.get(String(row.orderId)) || 0)+moneyToCents(row.amount,{signed:true}));
    }
    // Attribution is a payment fact, including platform/zero/pending outcomes.
    // Period movements and the order's current lifetime balance serve different
    // readers; a December reversal must never turn November's commission negative.
    const facts=operationalFacts || {job:[],snapshot:[],correction:[],detail:result.list};
    const snapshots=new Map((facts.snapshot || []).map(s=>[String(s.orderId),s]));
    const corrected=new Map();
    for(const c of facts.correction || []) if(!corrected.has(String(c.orderId)) || Number(corrected.get(String(c.orderId)).revisionNo)<Number(c.revisionNo)) corrected.set(String(c.orderId),c);
    const balances=new Map();
    for(const row of facts.detail || []) balances.set(String(row.orderId),(balances.get(String(row.orderId)) || 0)+moneyToCents(row.amount,{signed:true}));
    const orders=new Map();
    for(const job of facts.job || []) {
      const id=String(job.orderId),state=corrected.get(id)?.nextStateJson || snapshots.get(id) || job.decisionJson || {};
      orders.set(id,{orderId:id,merchantId:String(state.hitMerchantId ?? '0'),splitType:state.splitType,payTime:job.payTime,
        amount:formatMoney(balances.get(id) || 0),ledgerAmount:formatMoney(movements.get(id) || 0),pending:job.status!=='DONE'});
    }
    // A test adapter may expose only detail rows. Production uses the complete
    // persisted job/snapshot/correction facts above and never fabricates a result.
    if(!store.readOperationalFacts) for(const row of facts.detail || []) if(!orders.has(String(row.orderId))) orders.set(String(row.orderId),{orderId:String(row.orderId),merchantId:String(row.merchantId),splitType:row.splitType,payTime:row.payTime,amount:formatMoney(balances.get(String(row.orderId)) || 0),ledgerAmount:formatMoney(movements.get(String(row.orderId)) || 0)});
    const attributions=[...orders.values()].filter(o=>!cityOrders || cityOrders.has(o.orderId));
    for(const merchant of byMerchant.values()) {
      merchant.totalAmount=formatMoney(moneyToCents(merchant.accT1Amount,{signed:true})+moneyToCents(merchant.accT2Amount,{signed:true}));
      merchant.monthAmount=merchant.totalAmount;
      merchant.orderCount=attributions.filter(o=>o.merchantId===merchant.merchantId && (!query.period || !o.payTime || require('./shareEngine.cjs').periodAt(o.payTime)===query.period) && (since===null || !o.payTime || time(o.payTime)>=since) && (until===null || !o.payTime || time(o.payTime)<until)).length;
      merchant.monthOrders=merchant.orderCount;
    }
    const relevant=cityOrders ? new Set([...attributions.map(o=>o.merchantId),...list.map(r=>String(r.merchantId))]) : null;
    const merchants=[...byMerchant.values()].filter(m=>!relevant || relevant.has(m.merchantId));
    return {merchants,orderAttributions:attributions,attributionScope:'payment_facts',amountScope:'current_order_balance',movementScope:'selected_period',cityScope:'order_business_city',scanScope:'current_qr_all_cities',bindingScope:'active_history_all_cities',totalAmount:formatMoney(merchants.reduce((sum,r)=>sum+moneyToCents(r.totalAmount,{signed:true}),0)),period:query.period||null};
  }
  async function adminOperation(action,input,session) {
    requireShare(session,'admin');
    if(action==='failures') return {jobs:await store.listFailures(),alerts:await store.listFailedOutbox()};
    if(action==='retry') return store.retryJob(str(input.orderId),str(input.reason),operator(session));
    if(action==='alertRetry') return store.retryOutbox(str(input.eventId),str(input.reason),operator(session));
    if(action==='invalidateUser') return store.invalidateUser(str(input.userId),{reason:str(input.reason),requestId:str(input.requestId),operatorId:operator(session)});
    if(action==='auditExport') {
      const [rows]=await source.transaction(conn=>conn.query('SELECT action,subject_id,operator_id,payload_json,created_at FROM lxm_share_audit ORDER BY created_at DESC,id DESC LIMIT 2000'));
      await audit({action:'AUDIT_EXPORT',operatorId:operator(session),reason:'导出最近2000条分成审计记录',count:rows.length});
      return '\uFEFF'+[['操作','对象','操作人','内容','时间'],...rows.map(r=>[r.action,r.subject_id,r.operator_id,typeof r.payload_json==='string'?r.payload_json:JSON.stringify(r.payload_json),r.created_at instanceof Date?r.created_at.toISOString():r.created_at])].map(row=>row.map(safeCsv).join(',')).join('\r\n');
    }
    if(action==='correct') {
      if(session.role!=='super') throw failure(4030,'仅超级管理员可以执行资金更正',403);
      return store.correctSnapshot(str(input.orderId),{reason:str(input.reason),requestId:str(input.requestId),operatorId:operator(session)});
    }
    throw failure(4001,'管理操作无效');
  }
  return {store,detail,onboard,updateMerchant,setStatus,saveRule,listRules,listDetails,mine,qr,generateQr,rotate,reportScan,reportClick,createCsLink,exportCsv,analytics,adminOperation,
    settings:()=>({enabled:!!enableAt(),enableAt:enableAt()||null,defaultTtlHours:Number(process.env.DEFAULT_TTL_HOURS ?? 720),defaultRefundWindowDays:3,
      csAttrDays:Number(process.env.CS_ATTR_DAYS ?? 7),maxCandidateMerchants:Number(process.env.MAX_CANDIDATE_MERCHANTS ?? 20),scanDedupSeconds:Number(process.env.SCAN_DEDUP_SECONDS ?? 5),judgeRetryMax:Number(process.env.JUDGE_RETRY_MAX ?? 3),engineVersion:require('./shareEngine.cjs').ENGINE_VERSION,
      phoneAlertConfigured:!!process.env.SHARE_PHONE_ALERT_URL,operationalAlertConfigured:!!process.env.SHARE_ALERT_WEBHOOK_URL})};
}
function serviceFor(source, options) {
  if (!services.has(source)) services.set(source,createShareService(source,options));
  return services.get(source);
}
async function enqueuePaidOrder(source, order) {
  if (!services.has(source) && !str(process.env.SHARE_ENABLE_AT)) return {skipped:true,reason:'SHARE_NOT_ENABLED'};
  const service = serviceFor(source);
  const settings = service.settings();
  if (!settings.enabled) return {skipped:true,reason:'SHARE_NOT_ENABLED'};
  const finalPayment = [...(Array.isArray(order.paymentRecords)?order.paymentRecords:[])].reverse().find(p=>p.phase==='final' && p.status==='confirmed' && ['wechat_pay','zero_balance'].includes(p.provider));
  if(!finalPayment) return {skipped:true,reason:'ONLINE_FINAL_PAYMENT_REQUIRED'};
  const payTime = order.finalPaidAt || finalPayment?.confirmedAt || order.completedAt;
  const { moneyToCents, formatMoney, time } = require('./shareEngine.cjs');
  if (!payTime || time(payTime) < time(settings.enableAt)) return {skipped:true,reason:'BEFORE_ENABLE'};
  const paidTotal = formatMoney(moneyToCents(order.depositPaid || '0') + moneyToCents(order.finalPaid || '0'));
  const lines = order.products || order.productItems || order.items || [];
  const goodsName = (Array.isArray(lines)?lines:[]).map(p=>str(p.name||p.title||p.productName)).filter(Boolean).join('、') || str(order.packageName||order.productName);
  const result=await service.store.enqueuePayment({orderId:str(order.id||order._id),userId:str(order.openid||order._openid),payTime,paidTotal,provider:finalPayment.provider,
    sessionId:order.finalPaymentSessionId || finalPayment.sessionId,sessionStartAt:order.finalPaymentSessionStartAt || finalPayment.sessionStartAt,
    display:{orderNo:str(order.orderNo),customer:str(order.customer||order.contactName||'用户'),productName:goodsName,paidAmount:paidTotal,payTime}});
  return result;
}
async function recordOrderRefund(source, {order,refundNo,amount,refundedAt}) {
  if (!services.has(source) && !str(process.env.SHARE_ENABLE_AT) && typeof source.transaction!=='function') return {skipped:true,reason:'SHARE_NOT_ENABLED'};
  const service=serviceFor(source);
  if(!service.settings().enabled) {
    // Disabling new attribution must not erase refunds of an existing ledger.
    // A pre-installation application has no share tables and no such obligation.
    let existing;
    try {existing=await service.store.getJob(str(order.id||order._id)) || await service.store.getSnapshot(str(order.id||order._id));}
    catch(error){if(error.code==='ER_NO_SUCH_TABLE') return {skipped:true,reason:'SHARE_NOT_ENABLED'};throw error;}
    if(!existing) return {skipped:true,reason:'SHARE_NOT_ENABLED'};
  }
  return service.store.recordRefund({orderId:str(order.id||order._id),refundNo:str(refundNo),amount,refundAt:refundedAt||new Date().toISOString()});
}
async function reportScan(source, session, input) { return serviceFor(source).reportScan(session,input); }
async function reportClick(source, session, input) { return serviceFor(source).reportClick(session,input); }

module.exports={createShareService,serviceFor,enqueuePaidOrder,recordOrderRefund,reportScan,reportClick,canShare,requireShare,merchantDetail,merchantProjection,filters,ruleFields,validateScene,qrScene,safeCsv,SHARE_ROUTES};
