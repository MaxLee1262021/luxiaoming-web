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
    hydrateFromStorage,
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
  const knownMenuKeys = new Set([
    ...(LXM_CONFIG.menus || []).map((item) => item.key),
    ...((window.LXM_PAGES && window.LXM_PAGES.manifest) || []).map((item) => item.key)
  ]);

  // 这些字段在 01-core-state 中以演示数据初始化；在 Vue 挂载前清空，未认证页面不会持有管理列表副本。
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

  function restoreDemoData() {
    RUNTIME_DATA_KEYS.forEach((key) => {
      const source = window.LXM_DATA && window.LXM_DATA[key];
      data[key] = cloneValue(source !== undefined ? source : (Array.isArray(data[key]) ? [] : {}));
    });
    state.homeConfig = cloneValue((window.LXM_DATA && window.LXM_DATA.homeConfig) || {});
    state.siteConfig = cloneValue((window.LXM_DATA && window.LXM_DATA.siteConfig) || {});
    state.logs = cloneValue((window.LXM_DATA && window.LXM_DATA.logs) || []);
    state.trash = cloneValue((window.LXM_DATA && window.LXM_DATA.trash) || []);
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
    if (Array.isArray(menus)) target.menus = [...new Set(menus.filter((item) => knownMenuKeys.has(item)))];
    if (payload.scope) target.scope = payload.scope;
    if (payload.shopId) target.shopId = payload.shopId;
    if (payload.staffId) target.staffId = payload.staffId;
    if (payload.distributorId) target.distributorId = payload.distributorId;
    if (payload.agentId) target.agentId = payload.agentId;
    if (payload.home && knownMenuKeys.has(payload.home)) target.home = payload.home;
    state.menuRevision += 1;
    return true;
  }

  function normalizeSession(raw, fallback = {}) {
    const envelope = raw && typeof raw === "object" ? raw : {};
    const source = envelope.session && typeof envelope.session === "object"
      ? envelope.session
      : envelope.user && typeof envelope.user === "object" ? envelope.user : envelope;
    return {
      ok: envelope.ok !== false,
      token: source.token || envelope.token || fallback.token || "",
      role: source.role || envelope.role || fallback.role || "",
      roleId: source.roleId || envelope.roleId || fallback.roleId || "",
      roleName: source.roleName || envelope.roleName || fallback.roleName || "",
      account: source.account || envelope.account || fallback.account || "",
      name: source.name || envelope.name || fallback.name || "",
      staffId: source.staffId || envelope.staffId || fallback.staffId || "",
      menus: Array.isArray(source.menus) ? source.menus : (Array.isArray(envelope.menus) ? envelope.menus : source.menuKeys),
      menuKeys: Array.isArray(source.menuKeys) ? source.menuKeys : (Array.isArray(envelope.menuKeys) ? envelope.menuKeys : (Array.isArray(source.menus) ? source.menus : [])),
      menuDefinitions: Array.isArray(source.menuDefinitions) ? source.menuDefinitions : (Array.isArray(envelope.menuDefinitions) ? envelope.menuDefinitions : []),
      scope: source.scope || envelope.scope || fallback.scope || "",
      shopId: source.shopId || envelope.shopId || fallback.shopId || "",
      distributorId: source.distributorId || envelope.distributorId || fallback.distributorId || "",
      agentId: source.agentId || envelope.agentId || fallback.agentId || "",
      permissionSource: source.permissionSource || envelope.permissionSource || fallback.permissionSource || "",
      expiresAt: source.expiresAt || envelope.expiresAt || fallback.expiresAt || 0,
    };
  }

function isExplicitDemoMode() {
  const protocol = window.location && window.location.protocol;
  return protocol === "file:" || window.LXM_DEMO_MODE === true;
}

function serverErrorMessage(error) {
  if (!error) return "登录失败，请重试";
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
      // 只有明确处于离线演示环境时才允许本地兜底；服务端 401/403 或已探测到服务端时绝不绕过。
      if (error && error.status) {
        log("登录失败", "后台", "服务端拒绝登录", account, { level: "高" });
        return ElMessage.error(serverErrorMessage(error));
      }
      const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
      if (!isExplicitDemoMode() || reachable === true) {
        log("登录失败", "后台", "无法连接后台服务，未启用本地演示兜底", account, { level: "高" });
        return ElMessage.error("无法连接后台服务，请检查服务状态后重试");
      }
      return loginDemo(account, password);
    }
    const session = normalizeSession(j);
    if (session.role) ensureServerRole(session);
    if (!session.ok || !session.role || !session.token || !LXM_CONFIG.roles[session.role]) {
      log("登录失败", "后台", "服务端未返回有效会话或角色", account, { level: "高" });
      return ElMessage.error("登录服务返回无效会话，请联系管理员");
    }
    // Drop the bundled demo snapshot before loading scoped server rows. This
    // prevents a role with a denied collection from seeing stale demo data.
    clearRuntimeData();
    applyLogin(session, { source: "server" });
    await loadAuthenticatedData();
    ElMessage.success("登录成功");
  } catch (error) {
    ElMessage.error(serverErrorMessage(error));
  } finally {
    state.loading = false;
  }
}

function mergeServerDefinitions(session) {
  const definitions = Array.isArray(session && session.menuDefinitions) ? session.menuDefinitions : [];
  definitions.forEach((item) => {
    const key = String(item && item.key || "").trim();
    if (!key) return;
    knownMenuKeys.add(key);
    const existing = (LXM_CONFIG.menus || []).find((menu) => menu.key === key);
    const next = {
      key,
      routeKey: String(item.routeKey || item.targetKey || key),
      targetKey: String(item.targetKey || item.routeKey || key),
      label: String(item.label || item.name || key),
      group: String(item.group || "其他功能"),
      parentKey: String(item.parentKey || item.parentId || ""),
      parentId: String(item.parentId || item.parentKey || ""),
      path: String(item.path || `/${key}`),
      icon: String(item.icon || ""),
      sort: Number(item.sort ?? item.sortNo ?? 0),
      status: item.status === "disabled" || item.status === "停用" ? "停用" : "启用",
      containerOnly: item.containerOnly === true
    };
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
  const menu = (LXM_CONFIG.menus || []).find((item) => item && item.key === menuKey);
  return !!(menu && !["停用", "disabled", "inactive"].includes(String(menu.status || "").trim().toLowerCase()) && (profile.menus || []).includes(menuKey));
}

function defaultActiveMenu(profile = roleProfile.value) {
  if (isEnabledMenu(profile.home, profile)) return profile.home;
  return (profile.menus || []).find((key) => isEnabledMenu(key, profile)) || "";
}

function loginDemo(account, password) {
  const demoRows = (key) => {
    const value = window.LXM_DATA && window.LXM_DATA[key];
    return Array.isArray(value) ? value : Object.values(value || {});
  };
  const sourceStaff = demoRows("staff").find((u) => u && u.account === account && u.password === password);
  const sourceMerchant = demoRows("shops").find((s) => s && s.account === account && s.password === password);
  const sourceDistributor = demoRows("distributors").find((s) => s && s.account === account && s.password === password);
  const sourceAgent = demoRows("agents").find((s) => s && s.account === account && s.password === password);
  const matched = [sourceStaff, sourceMerchant, sourceDistributor, sourceAgent].filter(Boolean);
  if (matched.length > 1) return ElMessage.error("账号配置冲突，请联系管理员");
  const source = matched[0];
  if (source && ["停用", "已停用", "禁用", "暂停合作", "已终止"].includes(source.status || "")) return ElMessage.error("该账号已被停用，请联系管理员启用后再登录");
  if (sourceMerchant && ["暂停合作", "已终止", "停用"].includes(sourceMerchant.status || "")) return ElMessage.error("该商家合作已暂停或终止，账号暂无法登录");
  if (!source) {
    log("登录失败", "后台", "本地演示账号校验失败", account, { level: "高" });
    return ElMessage.error("账号或密码错误");
  }
  window.LXM_AUTH.clearSession();
  restoreDemoData();
  hydrateFromStorage();
  applyLogin({
    role: sourceMerchant ? "merchant" : (sourceAgent ? "agent" : sourceDistributor ? "distributor" : (sourceStaff.role || "super")),
    account,
    name: source.name || account,
    staffId: source.id || "st1",
    shopId: sourceMerchant ? (sourceMerchant.id || sourceMerchant.shopId || "") : "",
    distributorId: sourceDistributor ? (sourceDistributor.id || sourceDistributor.distributorId || "") : (source.distributorId || ""),
    agentId: sourceAgent ? (sourceAgent.id || sourceAgent.agentId || "") : (source.agentId || "")
  }, { source: "demo" });
  state.authNotice = "当前为本地演示模式，改动不会写入数据库";
  ElMessage.warning(state.authNotice);
}

function applyLogin(raw, options = {}) {
  const session = normalizeSession(raw);
  const role = session.role || "super";
  if (options.source === "server") ensureServerRole(session);
  if (!LXM_CONFIG.roles[role]) throw new Error("服务端返回了未知角色");
  if (options.source === "server") {
    window.LXM_AUTH.setSession(session);
    serverRoleOverrides[role] = { ...session, token: "" };
  } else {
    window.LXM_AUTH.clearSession();
  }
  applyRoleConfig(role, session);
  state.authed = true;
  state.authSource = options.source || "server";
  state.role = role;
  state.loginRole = role;
  state.currentStaffId = session.staffId || roleProfile.value.staffId || "st1";
  state.currentAccount = session.account || state.login.account || "";
  state.previewRole = role;
  state.mobileMenuOpen = false;
  resetPageState();
  state.active = defaultActiveMenu();
  log("登录", "后台", `${session.name || session.account || "账号"} 登录`);
}

async function loadAuthenticatedData() {
  if (state.authSource === "demo" || !window.LXM_CLOUD?.loadAdminData || !window.LXM_AUTH?.hasSession()) return;
  state.dataLoading = true;
  try {
    const result = await window.LXM_CLOUD.loadAdminData(data, state);
    if (result && result.status === 401) handleAuthExpired();
  } catch (error) {
    if (error && error.status === 401) handleAuthExpired();
    else state.authNotice = "部分管理数据载入失败，请刷新后重试";
  } finally {
    state.dataLoading = false;
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
  state.currentStaffId = "st1";
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
  const connected = ctx.isServerConnected() || (window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
  if (!row || !connected || !window.LXM_CLOUD) return true;
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
    if (res && res.error) throw new Error(res.error);
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
// 再交给后端 /api/auth/change-password 校验原密码并哈希落库；无后端时回退本地演示数据。
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
    } catch (e) {
      // 仅在明确的本地演示环境中回退明文演示数据；联网模式失败即拒绝修改。
      if (!isExplicitDemoMode() || (window.LXM_API_STATE && window.LXM_API_STATE.reachable === true)) {
        return ElMessage.error("无法连接后台服务，密码未修改");
      }
      j = null;
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
    if (isExplicitDemoMode() && !(window.LXM_API_STATE && window.LXM_API_STATE.reachable === true) && !j) {
      // 离线演示模式：直接改本地集合里的明文密码（仅演示，不落库）。
      const pools = [data.staff, data.shops, data.distributors, data.agents];
      for (let i = 0; i < pools.length; i++) {
        const list = pools[i] || [];
        const rec = list.find((u) => u && u.account === account && u.password === cp.oldPwd);
        if (rec) {
          rec.password = cp.newPwd;
          cp.open = false;
          log("修改密码", "后台", "本人修改登录密码（离线演示模式，未落库）", currentOperatorName(), { level: "中" });
          return ElMessage.success("密码修改成功（演示模式，未连接服务端）");
        }
      }
      return ElMessage.error("原密码不正确或账号不存在");
    }
    ElMessage.error((j && j.error) || "密码修改失败");
  } finally {
    cp.loading = false;
  }
}
// 退出登录：清空会话态，回到登录页。
function logout() {
  const pending = window.LXM_AUTH?.logout?.();
  state.authed = false;
  state.authSource = "";
  state.currentAccount = "";
  state.currentStaffId = "st1";
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
function switchMenu(key, options = {}) {
  if (key === "videoProducts") key = "videoSingles";
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
  state.active = key;
  state.mobileMenuOpen = false;
}
function switchRole(key) {
  if (!canPreviewRoles.value) {
    ElMessage.warning("只有总部超管可以切换预览其他角色后台");
    return;
  }
  if (!LXM_CONFIG.roles[key]) return;
  applyRoleConfig(key, (key === state.loginRole && serverRoleOverrides[key]) || roleDefaults[key] || {});
  state.role = key;
  state.previewRole = key;
  state.currentStaffId = roleProfile.value.staffId || state.currentStaffId;
  resetPageState();
  if (key === "agent") {
    state.filters.agentId = roleProfile.value.agentId || "";
    state.filters.cityId = "";
  }
  state.active = defaultActiveMenu();
  state.mobileMenuOpen = false;
  log("切换角色", roleName(key), "超级管理员预览角色后");
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
    loadAuthenticatedData,
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
