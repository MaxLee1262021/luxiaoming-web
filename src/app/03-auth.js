// 登录鉴权与角色切换
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    canPreviewRoles,
    contentKeys,
    currentOperatorName,
    data,
    log,
    menus,
    resetPageState,
    roleName,
    roleProfile,
    state
  } = ctx;

  // 运行时数据只在已验证会话后载入；登出/会话失效时清空，避免同一浏览器留下上一位管理员的数据。
  const RUNTIME_DATA_KEYS = [
    "cities", "agents", "distributors", "shops", "staff", "spots", "series", "albums", "samples",
    "packages", "addonServices", "peripherals", "videoSingles", "tagLibrary", "guides", "stories", "scans",
    "orders", "afterSales", "reconciliationTransfers", "financeSettings", "monthlyClosings", "adjustmentRecords"
  ];
  const RUNTIME_STATE_KEYS = ["homeConfig", "siteConfig", "logs", "trash"];
  const roleDefaults = Object.fromEntries(Object.entries(LXM_CONFIG.roles || {}).map(([key, profile]) => [key, {
    ...profile,
    menus: Array.isArray(profile.menus) ? profile.menus.slice() : []
  }]));
  const serverRoleOverrides = Object.create(null);
  const createRouteTargets = { svcStaffNew: 'svcStaff', photoNew: 'photoParty' };
  const navigationPresentation = new Map((LXM_CONFIG.menus || [])
    .filter((item) => item.navigationOrder !== undefined)
    .map((item) => [item.key, { label: item.label, group: item.group, navigationOrder: item.navigationOrder }]));
  const commissionPresentation = new Map((LXM_CONFIG.menus || [])
    .filter((item) => ['客服分成管理', '摄影师分成管理'].includes(item.group))
    .map((item) => [item.key, { label: item.label, group: item.group, parentKey: item.parentKey || '', parentId: item.parentKey || '', navigationOrder: item.navigationOrder, containerOnly: item.containerOnly === true }]));
  const knownMenuKeys = new Set([
    ...(LXM_CONFIG.menus || []).filter((item) => !item.containerOnly).map((item) => item.key),
    ...((window.LXM_PAGES && window.LXM_PAGES.manifest) || []).map((item) => item.key)
  ]);

  // 未认证页面不持有管理数据；验证会话成功后才请求真实服务。
  state.authChecking = true;
  state.authNotice = "";
  state.authSource = "";
  state.serverReachable = window.LXM_API_STATE ? window.LXM_API_STATE.reachable : null;
  state.dataLoading = false;
  state.mobileMenuOpen = false;

  function cloneValue(value) {
    if (value === undefined || value === null) return value;
    try {
      if (typeof structuredClone === "function") return structuredClone(value);
    } catch (e) {}
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }

  function clearRuntimeData() {
    ctx.clearContentPhotographers?.();
    state.svcCreateRequested = false;
    state.sharePermissions = [];
    state.photoPermissions = [];
    state.menuDataRequestId = (state.menuDataRequestId || 0) + 1;
    state.dataLoading = false;
    state.menuDataLoadingKey = "";
    window.LXM_CLOUD?.clearMenuLoadState?.();
    RUNTIME_DATA_KEYS.forEach((key) => {
      if (Array.isArray(data[key])) data[key] = [];
      else if (data[key] && typeof data[key] === "object") data[key] = {};
    });
  RUNTIME_STATE_KEYS.forEach((key) => {
    if (Array.isArray(state[key])) state[key] = [];
    else state[key] = {};
  });
    state.currentOrder = null;
    state.currentAfterSale = null;
    state.currentFinanceReview = null;
    state.selectedOrderIds = [];
    state.merchantCodes = [];
    state.merchantCodeStats = { scans: 0, orders: 0, deals: 0, codeCount: 0 };
  }

  function restoreRoleDefaults(key) {
    const target = LXM_CONFIG.roles && LXM_CONFIG.roles[key];
    const base = roleDefaults[key];
    if (!target || !base) return;
    Object.assign(target, {
      ...base,
      menus: base.menus.slice()
    });
    state.menuRevision += 1;
  }

  function applyRoleConfig(key, payload = {}) {
    const target = LXM_CONFIG.roles && LXM_CONFIG.roles[key];
    if (!target) return false;
    restoreRoleDefaults(key);
    const menus = Array.isArray(payload.menuKeys) ? payload.menuKeys : payload.menus;
    if (Array.isArray(menus)) target.menus = [...new Set(menus.filter((item) => knownMenuKeys.has(item) && item !== "shops"))];
    if (key === "merchant") { target.menus = ["shareMine"]; target.home = "shareMine"; }
    if (["photo", "photographer"].includes(key)) { target.menus = ["photoMine"]; target.home = "photoMine"; }
    if (payload.scope) target.scope = payload.scope;
    for (const field of ["shopId", "staffId", "distributorId", "agentId"]) target[field] = String(payload[field] ?? "");
    if (!["merchant", "photo", "photographer"].includes(key) && payload.home && knownMenuKeys.has(payload.home) && payload.home !== "shops") target.home = payload.home;
    state.menuRevision += 1;
    return true;
  }

  function retiredMenuKeys(definitions = []) {
    const rows = [...(LXM_CONFIG.menus || []), ...definitions];
    const retiredRoutes = ["shops", "svcClient", "photoClient", ...Object.keys(createRouteTargets)];
    const retired = new Set(retiredRoutes);
    rows.forEach((row) => { if (retiredRoutes.includes(String(row?.routeKey || row?.targetKey || row?.key || ""))) retired.add(String(row.key)); });
    let changed;
    do {
      changed = false;
      rows.forEach((row) => {
        const key = String(row?.key || "");
        const canonical = commissionPresentation.has(String(row?.routeKey || row?.targetKey || key));
        if (!canonical && !retired.has(key) && retired.has(String(row?.parentKey || row?.parentId || ""))) { retired.add(key); changed = true; }
        const children = rows.filter((item) => String(item?.parentKey || item?.parentId || "") === key);
        if (row?.containerOnly && children.length && children.every((item) => retired.has(String(item.key))) && !retired.has(key)) { retired.add(key); changed = true; }
      });
    } while (changed);
    return retired;
  }
  function normalizeSession(raw, fallback = {}) {
    const envelope = raw && typeof raw === "object" ? raw : {};
    const source = envelope.session && typeof envelope.session === "object"
      ? envelope.session
      : envelope.user && typeof envelope.user === "object" ? envelope.user : envelope;
    const session = {
      ok: envelope.ok !== false,
      token: source.token || envelope.token || fallback.token || "",
      role: source.role || envelope.role || fallback.role || "",
      roleId: source.roleId || envelope.roleId || fallback.roleId || "",
      roleName: source.roleName || envelope.roleName || fallback.roleName || "",
      account: source.account || envelope.account || fallback.account || "",
      name: source.name || envelope.name || fallback.name || "",
      staffId: source.staffId ?? envelope.staffId ?? "",
      menus: Array.isArray(source.menus) ? source.menus : (Array.isArray(envelope.menus) ? envelope.menus : source.menuKeys),
      menuKeys: Array.isArray(source.menuKeys) ? source.menuKeys : (Array.isArray(envelope.menuKeys) ? envelope.menuKeys : (Array.isArray(source.menus) ? source.menus : [])),
      menuDefinitions: Array.isArray(source.menuDefinitions) ? source.menuDefinitions : (Array.isArray(envelope.menuDefinitions) ? envelope.menuDefinitions : []),
      scope: source.scope || envelope.scope || fallback.scope || "",
      shopId: source.shopId ?? envelope.shopId ?? "",
      distributorId: source.distributorId ?? envelope.distributorId ?? "",
      agentId: source.agentId ?? envelope.agentId ?? "",
      permissionSource: source.permissionSource || envelope.permissionSource || fallback.permissionSource || "",
      sharePermissions: Array.isArray(source.sharePermissions) ? source.sharePermissions : Array.isArray(envelope.sharePermissions) ? envelope.sharePermissions : [],
      photoPermissions: Array.isArray(source.photoPermissions) ? source.photoPermissions : Array.isArray(envelope.photoPermissions) ? envelope.photoPermissions : [],
      expiresAt: source.expiresAt || envelope.expiresAt || fallback.expiresAt || 0,
    };
    const retired = retiredMenuKeys(session.menuDefinitions);
    session.menus = (session.menus || session.menuKeys || []).filter((key) => !retired.has(String(key)));
    session.menuKeys = (session.menuKeys || session.menus || []).filter((key) => !retired.has(String(key)));
    session.menuDefinitions = session.menuDefinitions.filter((row) => !retired.has(String(row.key)));
    if (session.role === "merchant") { session.menus = ["shareMine"]; session.menuKeys = ["shareMine"]; }
    if (["photo", "photographer"].includes(session.role)) { session.menus = ["photoMine"]; session.menuKeys = ["photoMine"]; }
    return session;
  }

function serverErrorMessage(error) {
  if (!error) return "登录失败，请重试";
  if (error.code === "ACCOUNT_DISABLED") return "该账号已被停用，请联系管理员启用后再登录";
  if (error.status === 401) return error.message || "账号或密码错误";
  if (error.status === 403) return error.message || "该账号当前不可登录";
  if (error.status === 429) return error.message || "登录尝试过于频繁，请稍后再试";
  return error.message || "登录失败，请重试";
}

async function login() {
  const account = (state.login.account || "").trim();
  const password = state.login.password || "";
  if (!account) return ElMessage.warning("请输入账号");
  if (!password) return ElMessage.warning("请输入密码");
  state.loading = true;
  state.authNotice = "";
  try {
    let j;
    try {
      j = await window.LXM_AUTH.login(account, password);
    } catch (error) {
      const message = error && error.status ? serverErrorMessage(error) : "无法连接后台服务，请检查服务状态后重试";
      if (error && error.status === 403) state.authNotice = message;
      return ElMessage.error(message);
    }
    const session = normalizeSession(j);
    if (session.role) ensureServerRole(session);
    if (!session.ok || !session.role || !session.token || !LXM_CONFIG.roles[session.role]) {
      log("登录失败", "后台", "服务端未返回有效会话或角色", account, { level: "高" });
      return ElMessage.error("登录服务返回无效会话，请联系管理员");
    }
    clearRuntimeData();
    applyLogin(session, { source: "server" });
    await loadAuthenticatedData();
    ElMessage.success("登录成功");
  } catch (error) {
    const message = serverErrorMessage(error);
    if (error && error.status === 403) state.authNotice = message;
    ElMessage.error(message);
  } finally {
    state.loading = false;
  }
}

// Login and permission-page refreshes must apply the same navigation rules.
// Capture presentation above from the shipped catalog, not mutable server rows.
function normalizeNavigationDefinitions(definitions = []) {
  const retired = retiredMenuKeys(definitions);
  return definitions.map((item) => {
    const key = String(item && (item.key || item.menuKey || item.id) || "").trim();
    if (!key) return null;
    const routeKey = String(item.routeKey || item.targetKey || key);
    // Retired global settings must not return through stored server menus.
    if (key === "miniConfig" || routeKey === "miniConfig" || retired.has(key) || routeKey === "shops") return null;
    return {
      key,
      routeKey: String(item.routeKey || item.targetKey || key),
      targetKey: String(item.targetKey || item.routeKey || key),
      label: String(item.label || item.name || key),
      group: String(item.group || item.meta?.group || "其他功能").trim() || "其他功能",
      parentKey: String(item.parentKey || item.parentId || ""),
      parentId: String(item.parentId || item.parentKey || ""),
      path: String(item.path || `/${key}`),
      icon: String(item.icon || ""),
      sort: Number(item.sort ?? item.sortNo ?? 0),
      status: ["停用", "disabled", "inactive"].includes(String(item.status || "").trim().toLowerCase()) ? "停用" : "启用",
      containerOnly: item.containerOnly === true,
      ...(navigationPresentation.get(routeKey) || {}),
      ...(commissionPresentation.get(routeKey) || {})
    };
  }).filter(Boolean);
}

function mergeServerDefinitions(session) {
  const definitions = Array.isArray(session && session.menuDefinitions) ? session.menuDefinitions : [];
  const retired = retiredMenuKeys(definitions);
  LXM_CONFIG.menus = (LXM_CONFIG.menus || []).filter((item) => !retired.has(String(item.key)));
  retired.forEach((key) => knownMenuKeys.delete(key));
  normalizeNavigationDefinitions(definitions).forEach((next) => {
    const key = next.key;
    const existing = (LXM_CONFIG.menus || []).find((menu) => menu.key === key);
    if (!next.containerOnly) knownMenuKeys.add(key);
    if (existing) Object.assign(existing, next);
    else LXM_CONFIG.menus.push(next);
  });
  if (definitions.length) state.menuRevision += 1;
}

function ensureServerRole(session) {
  const role = String(session && session.role || "").trim().toLowerCase();
  if (!role) return false;
  mergeServerDefinitions(session);
  if (!LXM_CONFIG.roles[role]) {
    const menus = Array.isArray(session.menus) ? session.menus.map(String).filter((key) => knownMenuKeys.has(key)) : [];
    const profile = { name: session.roleName || role, home: menus[0] || "dashboard", scope: "all", menus };
    LXM_CONFIG.roles[role] = profile;
    roleDefaults[role] = { ...profile, menus: menus.slice() };
  }
  return true;
}

function isEnabledMenu(key, profile = roleProfile.value) {
  const menuKey = String(key || "");
  if (menuKey === "shops" || createRouteTargets[menuKey]) return false;
  const menu = (LXM_CONFIG.menus || []).find((item) => item && item.key === menuKey);
  return !!(menu && !menu.containerOnly && !["停用", "disabled", "inactive"].includes(String(menu.status || "").trim().toLowerCase()) && (profile.menus || []).includes(menuKey));
}

function defaultActiveMenu(profile = roleProfile.value) {
  if (isEnabledMenu(profile.home, profile)) return profile.home;
  return (profile.menus || []).find((key) => isEnabledMenu(key, profile)) || "";
}

function applyLogin(raw, options = {}) {
  const session = normalizeSession(raw);
  const role = session.role || "super";
  if (!session.token || options.source && options.source !== "server") throw new Error("需要真实服务端会话");
  ensureServerRole(session);
  if (!LXM_CONFIG.roles[role]) throw new Error("服务端返回了未知角色");
  window.LXM_AUTH.setSession(session);
  serverRoleOverrides[role] = { ...session, token: "" };
  applyRoleConfig(role, session);
  state.authed = true;
  state.authSource = "server";
  state.role = role;
  state.loginRole = role;
  state.currentStaffId = session.staffId || "";
  state.currentAccount = session.account || state.login.account || "";
  state.sharePermissions = session.sharePermissions.slice();
  state.photoPermissions = session.photoPermissions.slice();
  state.previewRole = role;
  state.mobileMenuOpen = false;
  resetPageState();
  state.active = defaultActiveMenu();
  log("登录", "后台", `${session.name || session.account || "账号"} 登录`);
}

function menuRouteKey(menuKey = state.active) {
  const key = String(menuKey || state.active || "");
  if (key === "miniConfig") return "miniDecor";
  if (createRouteTargets[key]) return createRouteTargets[key];
  const menu = (LXM_CONFIG.menus || []).find((item) => item && item.key === key);
  return String((menu && (menu.routeKey || menu.targetKey)) || key);
}

async function loadAuthenticatedData(menuKey = state.active, options = {}) {
  if (!window.LXM_CLOUD?.loadMenuData || !window.LXM_AUTH?.hasSession()) return;
  const routeKey = menuRouteKey(menuKey);
  // Share pages own their authenticated endpoints; never load old collections.
  if (routeKey.startsWith('svc') || ["shareRules", "shareDetails", "shareMine", "photoRules", "photoLedger", "photoSettlement", "photoParty", "photoNew", "photoMine"].includes(routeKey)) return { ok: true, routeKey, loaded: [] };
  const requestId = (state.menuDataRequestId || 0) + 1;
  state.menuDataRequestId = requestId;
  state.dataLoading = true;
  state.menuDataLoadingKey = routeKey;
  try {
    const result = await window.LXM_CLOUD.loadMenuData(routeKey, data, state, { force: options.force === true, joinPending: options.joinPending === true });
    if (["orders", "tasks"].includes(routeKey) && typeof ctx.loadPhotoDispatchOptions === "function") await ctx.loadPhotoDispatchOptions();
    if (state.menuDataRequestId !== requestId || result?.reason === "session_changed") return result;
    if (result && result.status === 401) {
      handleAuthExpired();
      return result;
    }
    if (result && result.failed && result.failed.length) state.authNotice = `菜单数据部分加载失败：${result.failed.join("、")}`;
    else if (state.authNotice && state.menuDataLoadingKey === routeKey) state.authNotice = "";
    return result;
  } catch (error) {
    if (state.menuDataRequestId !== requestId) return { ok: false, routeKey, error };
    if (error && error.status === 401) handleAuthExpired();
    else state.authNotice = "菜单数据载入失败，请切换菜单后重试";
    return { ok: false, routeKey, error };
  } finally {
    if (state.menuDataRequestId === requestId) {
      state.dataLoading = false;
      state.menuDataLoadingKey = "";
    }
  }
}

async function restoreSession() {
  const stored = window.LXM_AUTH?.getSession?.();
  if (!stored || !stored.token) {
    clearRuntimeData();
    state.authChecking = false;
    return;
  }
  state.authChecking = true;
  clearRuntimeData();
  try {
    const raw = await window.LXM_AUTH.me();
    const session = normalizeSession(raw, stored);
    if (session.role) ensureServerRole(session);
    if (!session.ok || !session.role || !LXM_CONFIG.roles[session.role]) throw new Error("会话信息无效");
    applyLogin(session, { source: "server", restored: true });
    await loadAuthenticatedData();
  } catch (error) {
    window.LXM_AUTH.clearSession();
    clearRuntimeData();
    state.authed = false;
    state.authNotice = error && error.status === 401 ? "登录已过期，请重新登录" : "会话验证失败，请重新登录";
  } finally {
    state.authChecking = false;
  }
}

function handleAuthExpired(silent = false) {
  if (!state.authed) return;
  state.authed = false;
  state.authSource = "";
  state.currentAccount = "";
  state.currentStaffId = "";
  state.loginRole = "";
  state.mobileMenuOpen = false;
  clearRuntimeData();
  Object.keys(roleDefaults).forEach(restoreRoleDefaults);
  Object.keys(serverRoleOverrides).forEach((key) => delete serverRoleOverrides[key]);
  state.role = "super";
  state.previewRole = "super";
  state.authNotice = "登录已过期，请重新登录";
  if (!silent) ElMessage.error(state.authNotice);
}

// 打开自助改密弹窗（顶栏用户菜单入口），清空上一次输入。
function openChangePwd() {
  state.changePwd = { open: true, oldPwd: "", newPwd: "", confirmPwd: "", loading: false };
}
// 实时密码强度：0 空 / 1-2 弱 / 3 中 / 4 强，供强度条与文案反馈。
function passwordStrength(pwd) {
  if (!pwd) return { score: 0, label: "", color: "#e2e8f0", tip: "请输入新密码" };
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
  if (/\d/.test(pwd)) score++;
  if (/[^a-zA-Z0-9]/.test(pwd)) score++;
  score = Math.min(4, score);
  const map = [
    { label: "弱", color: "#EF4444", tip: "密码强度过低，建议加长并混合大小写与符号" },
    { label: "弱", color: "#EF4444", tip: "建议至少 8 位并同时包含字母和数字" },
    { label: "中", color: "#F59E0B", tip: "还不错，可再加长或加入特殊字符" },
    { label: "强", color: "#10B981", tip: "密码强度良好" },
    { label: "很强", color: "#10B981", tip: "密码强度优秀" }
  ];
  return { score, ...map[score] };
}
// 账号密码强度校验（与服务端 validatePasswordStrength 同一规则）：返回中文错误文案，空串=通过。
function accountPasswordError(pwd) {
  if (!pwd || typeof pwd !== "string") return "请设置登录密码（至少 8 位，含字母和数字）";
  if (pwd.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) return "密码需同时包含字母和数字";
  return "";
}
// 随机临时密码（Lxm + 6 位数字）：天然满足强度规则，重置密码时一次性展示给管理员转达。
function generateTempPassword() {
  return "Lxm" + String(Math.floor(100000 + Math.random() * 900000));
}
// 账号资料写回服务端：服务端会自动把明文密码哈希落库；密码留空则不下发该字段（= 不改密码）。
async function persistAccountToCloud(key, row) {
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  const connected = ctx.isServerConnected() || (window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE === "mysql" && reachable !== false);
  if (!row || !connected || !window.LXM_CLOUD) { ElMessage.error("真实后端连接不可用，账号未保存"); return false; }
  try {
    const doc = { ...row };
    // Account records now inherit access solely from their role's menu grants.
    // Do not carry historical per-user action grants back into the API.
    delete doc.permissionKeys;
    delete doc.permissions;
    if (!doc.password) delete doc.password;
    let res;
    if (row.id) {
      try {
        res = await window.LXM_CLOUD.update(key, row.id, doc);
      } catch (error) {
        if (!error || error.status !== 404) throw error;
        res = await window.LXM_CLOUD.create(key, doc);
      }
    } else {
      res = await window.LXM_CLOUD.create(key, doc);
    }
    if (!res || typeof res !== "object" || Array.isArray(res) || res.error || res.ok === false
      || !(res.ok === true || res.id || res._id)) throw new Error(res && res.error || "服务端未确认账号保存");
    // Never retain a newly entered plaintext password in the reactive data pool
    // after the server has acknowledged the hashed write.
    if (row.password) delete row.password;
    return true;
  } catch (e) {
    ElMessage.error("服务端保存失败，本地改动未生效：" + (e && e.message ? e.message : e));
    return false;
  }
}
// 跨四个账号集合（运营人员/商家/分销员/代理）按引用或 id 定位记录所属集合名。
function accountCollectionOf(row) {
  const pools = [["staff", data.staff], ["shops", data.shops], ["distributors", data.distributors], ["agents", data.agents]];
  for (const [key, list] of pools) {
    if ((list || []).some((x) => x === row || (row.id && x && x.id === row.id))) return key;
  }
  return "";
}
// 自助改密：前端做完整校验（原密码非空、新密码强度、两次一致、不与旧相同），
// 再交给后端 /api/auth/change-password 校验原密码并哈希落库。
async function changePassword() {
  const cp = state.changePwd;
  if (!cp.oldPwd) return ElMessage.error("请输入原密码");
  if (cp.newPwd.length < 8 || !/[a-zA-Z]/.test(cp.newPwd) || !/\d/.test(cp.newPwd))
    return ElMessage.error("新密码至少 8 位，且需同时包含字母和数字");
  if (cp.newPwd !== cp.confirmPwd) return ElMessage.error("两次输入的新密码不一致");
  if (cp.newPwd === cp.oldPwd) return ElMessage.error("新密码不能与原密码相同");
  cp.loading = true;
  try {
    const account = state.currentAccount || state.login.account || "";
    let j = null;
    try {
      const r = await window.LXM_HTTP.request(`${(window.LXM_API_CONFIG && window.LXM_API_CONFIG.base) || "/api"}/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, oldPassword: cp.oldPwd, newPassword: cp.newPwd })
      });
      j = await r.json().catch(() => null);
    } catch (error) {
      return ElMessage.error("无法连接后台服务，密码未修改");
    }
    if (j && j.ok === true) {
      cp.open = false;
      if (j.reauthenticate) {
        // Password rotation revokes the old server session; require a fresh
        // login instead of leaving the shell in a token-less half-auth state.
        window.LXM_AUTH?.clearSession?.();
        handleAuthExpired(true);
      }
      log("修改密码", "后台", "本人通过「修改密码」入口更换登录密码", currentOperatorName(), { level: "中" });
      return ElMessage.success(j.reauthenticate ? "密码修改成功，请重新登录" : "密码修改成功，请牢记新密码");
    }
    ElMessage.error((j && j.error) || "密码修改失败");
  } finally {
    cp.loading = false;
  }
}
// 退出登录：清空会话态，回到登录页。
async function logout() {
  if (state.guideLeaveGuard && !(await state.guideLeaveGuard())) return;
  const pending = window.LXM_AUTH?.logout?.();
  state.authed = false;
  state.authSource = "";
  state.currentAccount = "";
  state.currentStaffId = "";
  state.loginRole = "";
  state.role = "super";
  state.previewRole = "super";
  state.login.password = "";
  state.mobileMenuOpen = false;
  state.authNotice = "";
  clearRuntimeData();
  Object.keys(roleDefaults).forEach(restoreRoleDefaults);
  Object.keys(serverRoleOverrides).forEach((key) => delete serverRoleOverrides[key]);
  Promise.resolve(pending).catch(() => {});
  ElMessage.success("已退出登录");
}
async function switchMenu(key, options = {}) {
  const createRoute = createRouteTargets[key] ? key : '';
  if (createRoute) key = createRouteTargets[key];
  if (key === "videoProducts") key = "videoSingles";
  if (key === "miniConfig") key = "miniDecor";
  if (key !== state.active && state.guideLeaveGuard && !(await state.guideLeaveGuard())) return;
  if (!isEnabledMenu(key)) {
    ElMessage.warning("当前角色无权访问该页");
    return;
  }
  const menu = (LXM_CONFIG.menus || []).find((item) => item && item.key === key);
  const routeKey = (menu && (menu.routeKey || menu.targetKey)) || key;
  if (!options.preserveFilters) {
    state.selectedOrderIds = [];
    if (routeKey === "logs") Object.assign(state.filters, { logUser: "", logModule: "", logLevel: "", logAction: "", keyword: "" });
    if (routeKey !== "orders") Object.assign(state.filters, { status: "", financeStatus: "", afterSaleStatus: "", refundStatus: "", transferStatus: "", rescheduleStatus: "", assigneeId: "", photographerId: "", productType: "" });
    if (!contentKeys.includes(routeKey)) Object.assign(state.filters, { contentStatus: "", contentSpotId: "", contentSeriesId: "" });
  }
  if (routeKey === "videoSingles" && !options.preserveFilters) state.filters.shelfType = "video";
  if (routeKey === "reconciliation" && ["super", "finance"].includes(state.role) && !options.preserveFilters) {
    Object.assign(state.filters, { cityId: "", agentId: "", distributorId: "", shopId: "" });
  }
  if (createRoute === 'svcStaffNew') state.svcCreateRequested = true;
  state.active = key;
  state.mobileMenuOpen = false;
  const result = await loadAuthenticatedData(routeKey, { force: true });
  if (createRoute === 'photoNew' && state.active === key) await ctx.openPhotoCreate?.();
  return result;
}
async function switchRole() {
  return ElMessage.warning("后台按真实登录账号的权限显示，请退出后使用其他账号登录");
}

window.addEventListener("lxm-auth-expired", () => handleAuthExpired(false));
window.addEventListener("lxm-server-status", (event) => {
  state.serverReachable = !!(event && event.detail && event.detail.reachable);
});

// 先验证已保存会话，再触发管理数据加载；无会话时 loadAdminData 会保持跳过。
restoreSession();


  return {
    login,
    applyLogin,
    normalizeNavigationDefinitions,
    loadAuthenticatedData,
    menuRouteKey,
    restoreSession,
    openChangePwd,
    passwordStrength,
    accountPasswordError,
    generateTempPassword,
    persistAccountToCloud,
    accountCollectionOf,
    changePassword,
    logout,
    switchMenu,
    switchRole
  };
});
