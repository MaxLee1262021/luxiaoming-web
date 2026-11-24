// 商家分成专属状态。页面只展示服务端账本，不在浏览器重算分成金额。
(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const monthNow = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; };
  const freshMine = () => ({ merchant: {}, rule: {}, stats: {}, list: [], total: 0, sum: {}, orders: [], orderTotal: 0, orderStats: {}, notices: [] });
  const freshMineQuery = () => ({ merchantId: "", period: monthNow(), page: 1, size: 20, orderPage: 1, orderSize: 20 });
  const freshForm = () => ({ name: "", contact: "", phone: "", address: "", account: "", password: "", ratioT1: undefined, ratioT2: undefined, refundWindowDays: 3, reason: "", cooperationConfirmed: false, businessLicenseNo: "", invoiceTitle: "", taxNo: "", bankName: "", bankAccount: "", accountHolder: "" });
  const shareState = ctx.reactive({
    rules: [], ruleTotal: 0, summary: {}, ruleQuery: { keyword: "", status: "", page: 1, size: 20 },
    details: [], detailTotal: 0, detailSum: {}, detailQuery: { merchantId: "", period: monthNow(), splitType: "", page: 1, size: 20 },
    mine: freshMine(), mineQuery: freshMineQuery(),
    merchants: [], loading: { rules: false, details: false, mine: false, merchant: false, qr: false },
    errors: { rules: "", details: "", mine: "", merchant: "", qr: "" },
    busy: false, exporting: false, helpOpen: false, settings: null, settingsLoading: false, settingsError: "", grantsOpen: false, grantRoles: [], grantRoleId: "", grantPermissions: [], grantLoading: false, grantSaving: false, grantError: "", editorOpen: false, editorMode: "new", form: freshForm(), formError: "", formFieldErrors: {},
    merchantOpen: false, merchantTab: "info", merchant: null, infoForm: {}, configForm: {}, configError: "", configFieldErrors: {}, infoError: "",
    qrImage: "", rotateOpen: false, rotateReason: "", rotateError: "", statusOpen: false, status: "CLOSED", statusReason: "", statusError: ""
  });
  let epoch = 0;
  const sequence = {};
  const requestIds = {};
  const idOf = (row) => String(row?.merchantId ?? row?.id ?? row?.shopId ?? "");
  const ruleOf = (row) => row?.rule || row || {};
  const canAction = (name) => { try { return typeof ctx.can === "function" && ctx.can(name); } catch (_) { return false; } };
  const shareCanConfig = ctx.computed(() => ctx.state.role !== "merchant" && (ctx.state.role === "super" || canAction("shareConfig")));
  const shareCanView = ctx.computed(() => ctx.state.role !== "merchant" && (ctx.state.role === "super" || canAction("shareView") || canAction("shareConfig")));
  const shareIsMerchant = ctx.computed(() => ctx.state.role === "merchant");
  const shareMineConfigured = ctx.computed(() => {
    if (typeof shareState.mine.configured === "boolean") return shareState.mine.configured;
    if (typeof shareState.mine.unconfigured === "boolean") return !shareState.mine.unconfigured;
    const rule = shareState.mine.rule || {};
    return rule.ratioT1 !== undefined && rule.ratioT1 !== null && rule.ratioT2 !== undefined && rule.ratioT2 !== null;
  });
  const shareMerchantId = () => idOf(shareState.merchant?.merchant);
  const shareRule = ctx.computed(() => shareState.merchant?.rule || null);
  const shareHistory = ctx.computed(() => shareState.merchant?.history || []);
  const shareStats = ctx.computed(() => shareState.merchant?.stats || {});
  const shareQr = ctx.computed(() => shareState.merchant?.qr || null);
  const shareDailyScans = ctx.computed(() => {
    const rows = shareState.merchant?.stats?.dailyScans || shareState.merchant?.dailyScans || shareState.merchant?.qr?.dailyScans || [];
    const maximum = Math.max(1, ...rows.map((row) => Number(row.count ?? row.scans ?? 0)));
    return rows.map((row) => ({ date: row.date || row.day, count: Number(row.count ?? row.scans ?? 0), height: Math.max(0, Number(row.count ?? row.scans ?? 0)) / maximum * 100 }));
  });
  const shareSelectedMerchant = ctx.computed(() => shareState.merchant?.merchant || {});
  const settingLabels = [
    ["enabled", "启用日配置状态", "configured"], ["enableAt", "正式启用时间（北京时间）", "time"],
    ["defaultRefundWindowDays", "默认平台退款窗口期", "天"], ["csAttrDays", "客服点击归因窗口", "sessionDays"],
    ["scanDedupSeconds", "重复扫码去重窗口", "秒"], ["judgeRetryMax", "判定失败最大重试次数", "次"],
    ["engineVersion", "判定规则版本", ""], ["phoneAlertConfigured", "电话告警配置", "configured"], ["operationalAlertConfigured", "运营提醒配置", "configured"]
  ];
  const shareSettingsRows = ctx.computed(() => {
    if (ctx.state.role !== "super" || !shareState.settings) return [];
    return settingLabels.filter(([key]) => Object.prototype.hasOwnProperty.call(shareState.settings, key)).map(([key, label, unit]) => {
      const value = shareState.settings[key];
      const text = unit === "configured" ? value === true ? "已配置" : value === false ? "未配置" : "未提供"
        : unit === "time" ? value ? shareTime(value) : "未设置"
        : value === null || value === undefined ? "未提供"
        : unit === "sessionDays" ? Number(value) === 0 ? "仅本次会话" : `${value} 天`
        : `${value}${unit ? ` ${unit}` : ""}`;
      return { key, label, value: text };
    });
  });
  function failMessage(error) { return error?.message || "请求失败，请稍后重试"; }
  function shareMoney(value) {
    if (value === undefined || value === null || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? `¥ ${number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
  }
  function sharePercent(value) { return value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(2).replace(/\.?0+$/, "")}%`; }
  function shareTime(value) {
    if (!value) return "—";
    const text = String(value);
    if (/[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      const date = new Date(text);
      if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
    }
    return text.replace("T", " ").slice(0, 19);
  }
  function shareAccumulatedTotal(stats) {
    const total = shareValue(stats, "totalAmount", "accAmount", "accNetAmount");
    if (total !== undefined) return total;
    const cents = (value) => {
      if (value === undefined || value === null || value === "") return null;
      const match = String(value).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
      return match ? (match[1] ? -1 : 1) * (Number(match[2]) * 100 + Number((match[3] || "").padEnd(2, "0"))) : null;
    };
    const first = cents(stats?.accT1Amount), second = cents(stats?.accT2Amount);
    return first === null || second === null ? undefined : ((first + second) / 100).toFixed(2);
  }
  function shareCount(value) { return value === undefined || value === null ? "—" : Number(value).toLocaleString("zh-CN"); }
  function shareValue(source, ...keys) { for (const key of keys) if (source?.[key] !== undefined && source[key] !== null) return source[key]; return undefined; }
  function shareStatus(value) { return ["OPEN", "合作中", "营业中", "启用"].includes(value) ? "营业中" : ["CANCELLED", "注销"].includes(value) ? "已注销" : "已停业"; }
  function shareType(row) { return row?.splitType === "T2" ? "客服推荐下单" : "用户自主下单"; }
  function shareReverse(row) { return Number(row?.direction) === 2 || Number(row?.amount) < 0; }
  function shareOrderTail(row) { const value = String(row?.maskedOrderNo || row?.orderNo || row?.orderTail || ""); return value ? `****${value.slice(-4)}` : "—"; }
  function queryString(query) { return new URLSearchParams(Object.entries(query).filter(([, value]) => value !== "" && value !== null && value !== undefined)).toString(); }
  function newRequestId() { return window.crypto?.randomUUID?.() || `share-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function operationId(key, payload) {
    const fingerprint = JSON.stringify(payload);
    if (!requestIds[key] || requestIds[key].fingerprint !== fingerprint) requestIds[key] = { fingerprint, id: newRequestId() };
    return requestIds[key].id;
  }
  async function request(path, method = "GET", payload, operation = "") {
    if (!window.LXM_AUTH?.hasSession?.()) throw new Error("登录已失效，请重新登录");
    if (!window.LXM_HTTP?.request) throw new Error("接口连接未就绪，请刷新后重试");
    const headers = { Accept: "application/json" };
    if (payload) headers["Content-Type"] = "application/json";
    if (operation) headers["Idempotency-Key"] = operationId(operation, payload);
    const response = await window.LXM_HTTP.request(`/api/share${path}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok === false || (body.code !== undefined && ![0, "0"].includes(body.code))) {
      const error = new Error(body?.msg || body?.message || body?.error || `接口返回 ${response.status}`);
      error.status = response.status; error.code = body?.code; throw error;
    }
    return body.data?.data ?? body.data ?? body;
  }
  async function load(kind, path, apply) {
    const ticket = (sequence[kind] || 0) + 1; sequence[kind] = ticket;
    const scope = epoch;
    shareState.loading[kind] = true; shareState.errors[kind] = "";
    try {
      const result = await request(path);
      if (scope === epoch && ticket === sequence[kind]) apply(result);
    } catch (error) {
      if (scope === epoch && ticket === sequence[kind]) shareState.errors[kind] = failMessage(error);
    } finally { if (scope === epoch && ticket === sequence[kind]) shareState.loading[kind] = false; }
  }
  async function loadShareRules(reset = false) {
    if (!shareCanView.value) return;
    if (reset) shareState.ruleQuery.page = 1;
    await load("rules", `/rules?${queryString(shareState.ruleQuery)}`, (result) => {
      shareState.rules = result.list || []; shareState.ruleTotal = Number(result.total || 0); shareState.summary = result.summary || {};
    });
  }
  async function loadShareDetails(reset = false) {
    if (!shareCanView.value) return;
    if (reset) shareState.detailQuery.page = 1;
    if (!shareState.detailQuery.period) shareState.detailQuery.period = monthNow();
    await load("details", `/details?${queryString(shareState.detailQuery)}`, (result) => {
      shareState.details = result.list || []; shareState.detailTotal = Number(result.total || 0); shareState.detailSum = result.sum || {};
    });
  }
  async function loadShareMine(reset = false) {
    if (reset) { shareState.mineQuery.page = 1; shareState.mineQuery.orderPage = 1; }
    const isSuper = ctx.state.role === "super";
    if (!isSuper && !shareIsMerchant.value) { shareState.errors.mine = "仅商家本人及超级管理员可查看商家端"; return; }
    if (isSuper && !shareState.mineQuery.merchantId) {
      sequence.mine = (sequence.mine || 0) + 1; shareState.loading.mine = false; shareState.errors.mine = "";
      shareState.mine = freshMine(); return;
    }
    const query = { ...shareState.mineQuery };
    if (!isSuper) delete query.merchantId;
    await load("mine", `/mine?${queryString(query)}`, (result) => {
      shareState.mine = { ...freshMine(), ...result, merchant: result.merchant || {}, rule: result.rule || {}, stats: result.stats || {}, list: result.list || [], total: Number(result.total || 0), sum: result.sum || {},
        orders: result.orders || [], orderTotal: Number(result.orderTotal || 0), orderStats: result.orderStats || {}, notices: result.notices || [] };
    });
  }
  async function loadMerchantOptions() {
    if (!shareCanView.value) return;
    const scope = epoch;
    try {
      // Read all pages so the selector also covers unconfigured and closed shops.
      const all = []; let page = 1; let total = 0;
      do {
        const result = await request(`/rules?${queryString({ page, size: 100 })}`);
        if (scope !== epoch) return;
        all.push(...(result.list || [])); total = Number(result.total || 0); page += 1;
        if (!(result.list || []).length) break;
      } while (all.length < total);
      shareState.merchants = all;
    } catch (error) { if (scope === epoch) { shareState.errors.details = failMessage(error); if (ctx.state.active === "shareMine") shareState.errors.mine = failMessage(error); } }
  }
  function shareEnter(kind) {
    if (!ctx.state.authed) return;
    if (kind === "rules") loadShareRules();
    if (kind === "details") { loadShareDetails(); loadMerchantOptions(); }
    if (kind === "mine") { loadShareMine(); if (ctx.state.role === "super") loadMerchantOptions(); }
  }
  function openShareHelp() { shareState.helpOpen = true; if (ctx.state.role === "super") loadShareSettings(); }
  async function loadShareSettings() {
    if (ctx.state.role !== "super") return;
    const scope = epoch; const ticket = (sequence.settings || 0) + 1; sequence.settings = ticket;
    shareState.settingsLoading = true; shareState.settingsError = ""; shareState.settings = null;
    try {
      const result = await request("/settings");
      if (scope !== epoch || ticket !== sequence.settings || ctx.state.role !== "super") return;
      // Keep only reviewed business parameters. Unknown response fields, URLs
      // and secrets are neither copied into page state nor rendered.
      shareState.settings = Object.fromEntries(settingLabels.filter(([key]) => Object.prototype.hasOwnProperty.call(result, key) && (result[key] === null || ["boolean", "number", "string"].includes(typeof result[key]))).map(([key]) => [key, result[key]]));
    } catch (error) {
      if (scope === epoch && ticket === sequence.settings) shareState.settingsError = error.status === 403
        ? "当前账号没有全局参数查看权限，请重新登录确认授权"
        : "全局参数读取暂不可用，请重试";
    }
    finally { if (scope === epoch && ticket === sequence.settings) shareState.settingsLoading = false; }
  }
  function selectShareGrantRole() {
    const role = shareState.grantRoles.find((row) => String(row.id) === String(shareState.grantRoleId));
    shareState.grantPermissions = (role?.sharePermissions || []).filter((key) => ["share:view", "share:config"].includes(key));
    shareState.grantError = "";
    shareGrantPermissionsChanged();
  }
  function shareGrantPermissionsChanged() {
    if (!shareGrantCanConfig()) shareState.grantPermissions = shareState.grantPermissions.filter((key) => key !== "share:config");
    if (shareState.grantPermissions.includes("share:config") && !shareState.grantPermissions.includes("share:view")) shareState.grantPermissions.unshift("share:view");
  }
  function shareGrantCanConfig() {
    const role = shareState.grantRoles.find((row) => String(row.id) === String(shareState.grantRoleId));
    return !!role && !["service", "finance", "merchant", "super"].includes(String(role.roleKey || role.key || "").toLowerCase());
  }
  async function loadShareGrants() {
    if (ctx.state.role !== "super") return;
    const scope = epoch; const ticket = (sequence.grants || 0) + 1; sequence.grants = ticket;
    shareState.grantLoading = true; shareState.grantError = "";
    try {
      const result = await request("/grants");
      if (scope !== epoch || ticket !== sequence.grants) return;
      shareState.grantRoles = (result.roles || []).filter((role) => !["merchant", "super"].includes(String(role.roleKey || role.key || "").toLowerCase()));
      if (!shareState.grantRoles.some((role) => String(role.id) === String(shareState.grantRoleId))) shareState.grantRoleId = "";
      selectShareGrantRole();
    } catch (error) { if (scope === epoch && ticket === sequence.grants) shareState.grantError = failMessage(error); }
    finally { if (scope === epoch && ticket === sequence.grants) shareState.grantLoading = false; }
  }
  function openShareGrants() {
    if (ctx.state.role !== "super") return;
    shareState.grantsOpen = true; shareState.grantRoleId = ""; shareState.grantRoles = []; shareState.grantPermissions = []; loadShareGrants();
  }
  async function saveShareGrant() {
    if (ctx.state.role !== "super" || shareState.grantSaving || shareState.grantLoading) return;
    const role = shareState.grantRoles.find((row) => String(row.id) === String(shareState.grantRoleId));
    if (!role || ["super", "merchant"].includes(String(role.roleKey || role.key || "").toLowerCase())) { shareState.grantError = "请选择可授权角色"; return; }
    shareGrantPermissionsChanged();
    const permissions = [...new Set(shareState.grantPermissions.filter((key) => ["share:view", "share:config"].includes(key)))];
    const scope = epoch; shareState.grantSaving = true; shareState.grantError = "";
    try {
      await request("/grants", "POST", { roleId: role.id, permissions }, `grants:${role.id}`);
      if (scope !== epoch) return;
      delete requestIds[`grants:${role.id}`]; ctx.ElMessage.success("分成授权已保存，请该角色用户重新登录后使用"); await loadShareGrants();
    } catch (error) { if (scope === epoch) shareState.grantError = failMessage(error); }
    finally { if (scope === epoch) shareState.grantSaving = false; }
  }
  function openShareNewMerchant() {
    if (!shareCanConfig.value) return;
    shareState.form = freshForm(); shareState.formError = ""; shareState.formFieldErrors = {}; shareState.editorMode = "new"; shareState.editorOpen = true;
    delete requestIds.onboard;
  }
  function configForm(rule = {}) {
    return { ratioT1: rule.ratioT1 === undefined ? undefined : Number(rule.ratioT1) * 100, ratioT2: rule.ratioT2 === undefined ? undefined : Number(rule.ratioT2) * 100, refundWindowDays: rule.refundWindowDays ?? 3, reason: "", versionNo: rule.versionNo ?? rule.version ?? 0 };
  }
  function revokeQr() { if (shareState.qrImage) URL.revokeObjectURL(shareState.qrImage); shareState.qrImage = ""; }
  async function openShareMerchant(row, tab = "info") {
    if (!shareCanView.value) return;
    const id = idOf(row);
    if (!id) return;
    sequence.qr = (sequence.qr || 0) + 1; shareState.loading.qr = false; shareState.errors.qr = "";
    revokeQr(); shareState.merchant = null; shareState.merchantOpen = true; shareState.merchantTab = tab;
    shareState.configError = ""; shareState.configFieldErrors = {}; shareState.infoError = ""; shareState.rotateOpen = false; shareState.statusOpen = false;
    const pending = load("merchant", `/merchants/${encodeURIComponent(id)}`, (result) => {
      shareState.merchant = result;
      shareState.infoForm = { ...(result.merchant || {}) };
      shareState.configForm = configForm(result.rule || {});
    });
    const ticket = sequence.merchant;
    await pending;
    if (ticket === sequence.merchant && tab === "qr" && shareState.merchantOpen && shareMerchantId() === id) await loadShareQr(false);
  }
  function closeShareMerchant() { sequence.merchant = (sequence.merchant || 0) + 1; sequence.qr = (sequence.qr || 0) + 1; shareState.merchantOpen = false; revokeQr(); }
  async function loadShareQr(refresh = true) {
    const id = shareMerchantId(); if (!id || !shareState.merchantOpen) return;
    const ticket = (sequence.qr || 0) + 1; sequence.qr = ticket; const scope = epoch;
    shareState.loading.qr = true; shareState.errors.qr = ""; revokeQr();
    try {
      // Refresh the counts and daily series together. The metadata-only QR
      // endpoint must not replace the counted QR returned by merchant detail.
      if (refresh !== false) {
        const detail = await request(`/merchants/${encodeURIComponent(id)}`);
        if (scope !== epoch || ticket !== sequence.qr || shareMerchantId() !== id) return;
        shareState.merchant = { ...shareState.merchant, qr: detail.qr || null, stats: detail.stats || {}, qrHistory: detail.qrHistory || [] };
      }
      const image = await window.LXM_HTTP.request(`/api/share/merchants/${encodeURIComponent(id)}/qr/image?format=png&variant=raw`);
      if (!image.ok) { const body = await image.json().catch(() => ({})); throw new Error(body.msg || body.error || "码图暂不可用，请稍后重试"); }
      const blob = await image.blob();
      if (scope === epoch && ticket === sequence.qr) shareState.qrImage = URL.createObjectURL(blob);
    } catch (error) { if (scope === epoch && ticket === sequence.qr) shareState.errors.qr = failMessage(error); }
    finally { if (scope === epoch && ticket === sequence.qr) shareState.loading.qr = false; }
  }
  function configFieldErrors(form) {
    const errors = {};
    for (const [key, label] of [["ratioT1", "自主订单比例"], ["ratioT2", "客服订单比例"]]) {
      if (form[key] === "" || form[key] === null || form[key] === undefined) errors[key] = `请填写${label}，不分成请填0`;
      else if (!Number.isFinite(Number(form[key])) || Number(form[key]) < 0 || Number(form[key]) > 50) errors[key] = `${label}须在0–50%之间`;
      else if (Math.abs(Number(form[key]) * 100 - Math.round(Number(form[key]) * 100)) > 0.000001) errors[key] = `${label}最多保留两位小数`;
    }
    if (form.refundWindowDays === "" || form.refundWindowDays === null || !Number.isInteger(Number(form.refundWindowDays)) || Number(form.refundWindowDays) < 0 || Number(form.refundWindowDays) > 365) errors.refundWindowDays = "平台退款窗口期须为0–365的整数天数";
    if (!String(form.reason || "").trim()) errors.reason = "请填写原因，保存后将记录到历史版本";
    else if (String(form.reason).trim().length > 255) errors.reason = "原因最多填写255字";
    return errors;
  }
  function validateConfig(form) { return Object.values(configFieldErrors(form))[0] || ""; }
  function clearShareFieldError(group, field) { delete (group === "config" ? shareState.configFieldErrors : shareState.formFieldErrors)[field]; }
  function mapOnboardServerError(error) {
    // Request/provider/auth failures are global. Only a known input conflict is
    // attached to a field, leaving the complete entered draft available.
    if (![400, 409].includes(error.status)) return false;
    const message = failMessage(error);
    if (/(?:账号|account).*(?:已存在|重复|冲突|exists|duplicate)/i.test(message)) { shareState.formFieldErrors.account = message; return true; }
    if (String(error.code || "").endsWith("4006")) { shareState.formFieldErrors.name = message; return true; }
    return false;
  }
  function configPayload(form) {
    return { ratioT1: Number((Number(form.ratioT1) / 100).toFixed(4)), ratioT2: Number((Number(form.ratioT2) / 100).toFixed(4)), refundWindowDays: Number(form.refundWindowDays), reason: String(form.reason).trim() };
  }
  async function saveShareNewMerchant() {
    if (!shareCanConfig.value || shareState.busy) return;
    const form = shareState.form;
    const passwordError = typeof ctx.accountPasswordError === "function" ? ctx.accountPasswordError(form.password) : !form.password ? "请设置商家登录密码" : "";
    const fields = configFieldErrors(form);
    if (!String(form.name || "").trim()) fields.name = "请填写商家名称";
    if (!String(form.account || "").trim()) fields.account = "请填写登录账号";
    if (passwordError) fields.password = passwordError;
    if (form.phone && !/^1\d{10}$/.test(form.phone)) fields.phone = "联系电话须为11位手机号，或留空";
    if (!form.cooperationConfirmed) fields.cooperationConfirmed = "请确认已完成商家合作沟通";
    shareState.formError = ""; shareState.formFieldErrors = fields; if (Object.keys(fields).length) return;
    const payload = { ...form, ...configPayload(form), name: form.name.trim(), account: form.account.trim() };
    const scope = epoch; shareState.busy = true;
    try {
      const result = await request("/merchants", "POST", payload, "onboard");
      if (scope !== epoch) return;
      shareState.editorOpen = false; shareState.form.password = ""; delete requestIds.onboard;
      ctx.ElMessage.success("商家已创建，账号、首版配置及商家码已生成");
      await loadShareRules(); await openShareMerchant({ merchantId: result.merchantId ?? result.merchant?.id ?? result.id });
    } catch (error) { if (scope === epoch && !mapOnboardServerError(error)) shareState.formError = failMessage(error); }
    finally { if (scope === epoch) shareState.busy = false; }
  }
  async function saveShareConfig() {
    if (!shareCanConfig.value || shareState.busy || !shareMerchantId()) return;
    shareState.configError = ""; shareState.configFieldErrors = configFieldErrors(shareState.configForm); if (Object.keys(shareState.configFieldErrors).length) return;
    const id = shareMerchantId(); const scope = epoch; shareState.busy = true;
    try {
      await request("/rules/save", "POST", { merchantId: id, versionNo: shareState.configForm.versionNo, ...configPayload(shareState.configForm) }, `rule:${id}`);
      if (scope !== epoch) return;
      delete requestIds[`rule:${id}`]; ctx.ElMessage.success("配置已生效，历史分成保持原结果");
      await loadShareRules(); await openShareMerchant({ merchantId: id }, "config");
    } catch (error) { if (scope === epoch) shareState.configError = `${failMessage(error)}${error.status === 409 ? "；请关闭后重新打开详情获取最新版本，当前输入已保留" : ""}`; }
    finally { if (scope === epoch) shareState.busy = false; }
  }
  async function saveShareInfo() {
    if (!shareCanConfig.value || shareState.busy || !shareMerchantId()) return;
    const form = shareState.infoForm;
    shareState.infoError = !String(form.name || "").trim() ? "请填写商家名称" : form.phone && !/^1\d{10}$/.test(form.phone) ? "联系电话须为11位手机号，或留空" : "";
    if (shareState.infoError) return;
    const allowed = ["name", "contact", "phone", "address", "businessLicenseNo", "invoiceTitle", "taxNo", "bankName", "bankAccount", "accountHolder"];
    const payload = Object.fromEntries(allowed.map((key) => [key, String(form[key] || "").trim()]));
    const id = shareMerchantId(); const scope = epoch; shareState.busy = true;
    try {
      await request(`/merchants/${encodeURIComponent(id)}`, "PATCH", payload, `info:${id}`);
      if (scope !== epoch) return;
      delete requestIds[`info:${id}`]; ctx.ElMessage.success("商家资料已保存"); await loadShareRules(); await openShareMerchant({ merchantId: id });
    } catch (error) { if (scope === epoch) shareState.infoError = failMessage(error); }
    finally { if (scope === epoch) shareState.busy = false; }
  }
  function openShareRotate() { if (!shareCanConfig.value) return; shareState.rotateReason = ""; shareState.rotateError = ""; shareState.rotateOpen = true; delete requestIds.rotate; }
  async function rotateShareQr() {
    if (!shareCanConfig.value || shareState.busy) return;
    const reason = shareState.rotateReason.trim(); if (!reason || reason.length > 255) { shareState.rotateError = "请填写换码原因，最多255字"; return; }
    const id = shareMerchantId(); if (!id) return;
    const scope = epoch; shareState.busy = true;
    const requestId = operationId("rotate", { merchantId: id, reason });
    try {
      await request(`/merchants/${encodeURIComponent(id)}/qr/rotate`, "POST", { reason, requestId }, "rotate-write");
      if (scope !== epoch) return;
      shareState.rotateOpen = false; delete requestIds.rotate; delete requestIds["rotate-write"];
      ctx.ElMessage.success("换码完成，请更换门店物料"); await openShareMerchant({ merchantId: id }, "qr");
    } catch (error) { if (scope === epoch) shareState.rotateError = failMessage(error); }
    finally { if (scope === epoch) shareState.busy = false; }
  }
  function openShareStatus(status) { if (!shareCanConfig.value) return; shareState.status = status; shareState.statusReason = ""; shareState.statusError = ""; shareState.statusOpen = true; }
  async function saveShareStatus() {
    if (!shareCanConfig.value || shareState.busy) return;
    const id = shareMerchantId(); if (!id) return;
    const reason = shareState.statusReason.trim(); if (!reason || reason.length > 255) { shareState.statusError = "请填写状态变更原因，最多255字"; return; }
    const scope = epoch; shareState.busy = true;
    try {
      await request(`/merchants/${encodeURIComponent(id)}/status`, "POST", { status: shareState.status, reason }, `status:${id}`);
      if (scope !== epoch) return;
      shareState.statusOpen = false; delete requestIds[`status:${id}`]; ctx.ElMessage.success("经营状态已更新"); await loadShareRules(); await openShareMerchant({ merchantId: id });
    } catch (error) { if (scope === epoch) shareState.statusError = failMessage(error); }
    finally { if (scope === epoch) shareState.busy = false; }
  }
  async function download(path, filename) {
    const scope = epoch;
    const response = await window.LXM_HTTP.request(`/api/share${path}`);
    if (!response.ok || (response.headers?.get("content-type") || "").includes("application/json")) {
      const result = await response.json().catch(() => ({})); throw new Error(result.msg || result.error || "下载失败，请稍后重试");
    }
    const blob = await response.blob(); if (scope !== epoch) return;
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadShareQr() {
    const id = shareMerchantId(); if (!id || shareState.exporting) return;
    shareState.exporting = true;
    try { await download(`/merchants/${encodeURIComponent(id)}/qr/image?format=png&variant=raw`, `商家码-${id}.png`); }
    catch (error) { ctx.ElMessage.error(failMessage(error)); }
    finally { shareState.exporting = false; }
  }
  async function exportShareDetails() {
    if (!shareCanView.value || shareState.exporting) return;
    if (!shareState.detailQuery.period) shareState.detailQuery.period = monthNow();
    const { page, size, ...filters } = shareState.detailQuery;
    shareState.exporting = true;
    try { await download(`/details/export?${queryString(filters)}`, `商家分成明细-${filters.period || "全部月份"}.csv`); }
    catch (error) { ctx.ElMessage.error(failMessage(error)); }
    finally { shareState.exporting = false; }
  }
  function clearShareState() {
    epoch += 1; revokeQr();
    shareState.rules = []; shareState.ruleTotal = 0; shareState.summary = {}; shareState.merchants = [];
    shareState.details = []; shareState.detailTotal = 0; shareState.detailSum = {};
    shareState.mine = freshMine();
    shareState.merchant = null; shareState.merchantOpen = false; shareState.editorOpen = false; shareState.rotateOpen = false; shareState.statusOpen = false; shareState.helpOpen = false;
    shareState.settings = null; shareState.settingsLoading = false; shareState.settingsError = "";
    shareState.grantsOpen = false; shareState.grantRoles = []; shareState.grantRoleId = ""; shareState.grantPermissions = []; shareState.grantLoading = false; shareState.grantSaving = false; shareState.grantError = "";
    shareState.form = freshForm(); shareState.infoForm = {}; shareState.configForm = {}; shareState.busy = false; shareState.exporting = false;
    shareState.formFieldErrors = {}; shareState.configFieldErrors = {};
    shareState.ruleQuery = { keyword: "", status: "", page: 1, size: 20 };
    shareState.detailQuery = { merchantId: "", period: monthNow(), splitType: "", page: 1, size: 20 };
    shareState.mineQuery = freshMineQuery();
    Object.keys(shareState.loading).forEach((key) => { shareState.loading[key] = false; shareState.errors[key] = ""; });
    Object.keys(requestIds).forEach((key) => delete requestIds[key]);
  }
  if (ctx.watch) ctx.watch(() => [ctx.state.authed, ctx.state.role, ctx.state.currentAccount], clearShareState);
  window.addEventListener?.("lxm-auth-expired", clearShareState);
  window.addEventListener?.("lxm-auth-changed", clearShareState);
  return {
    shareState, shareCanConfig, shareCanView, shareIsMerchant, shareMineConfigured, shareRule, shareHistory, shareStats, shareQr, shareDailyScans, shareSelectedMerchant, shareSettingsRows,
    shareMoney, sharePercent, shareTime, shareAccumulatedTotal, shareCount, shareValue, shareStatus, shareType, shareReverse, shareOrderTail, shareId: idOf, shareRowRule: ruleOf,
    shareEnter, loadShareRules, loadShareDetails, loadShareMine, openShareHelp, loadShareSettings, openShareNewMerchant, saveShareNewMerchant, openShareMerchant, closeShareMerchant,
    openShareGrants, loadShareGrants, selectShareGrantRole, shareGrantPermissionsChanged, shareGrantCanConfig, saveShareGrant,
    saveShareConfig, saveShareInfo, loadShareQr, openShareRotate, rotateShareQr, openShareStatus, saveShareStatus, downloadShareQr, exportShareDetails,
    shareValidateConfig: validateConfig, shareConfigPayload: configPayload, clearShareFieldError, clearShareState
  };
});
