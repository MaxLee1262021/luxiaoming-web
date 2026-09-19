// 后台 API 客户端：健康探测、会话凭证与受保护数据读取。
// 所有 /api 请求都从这里经过，避免页面模块遗漏 Authorization 头。
(function () {
  const cfg = window.LXM_API_CONFIG || { base: "/api", dataKeys: [], stateKeys: [], docKeys: [] };
  const base = String(cfg.base || "/api").replace(/\/$/, "");
  const SESSION_KEY = "lxm_admin_session_v1";
  const nativeFetch = window.fetch.bind(window);
  let session = null;

  window.LXM_API_STATE = window.LXM_API_STATE || { reachable: null, mode: "checking" };
  window.LXM_CLOUD_MODE = "mock";

  function readStoredSession() {
    try {
      const raw = window.sessionStorage && window.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.token === "string" && parsed.token ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  session = readStoredSession();

  function sessionMeta(value) {
    const source = value || {};
    return {
      role: source.role || "",
      roleId: source.roleId || "",
      roleName: source.roleName || "",
      account: source.account || "",
      name: source.name || "",
      staffId: source.staffId || "",
      menus: Array.isArray(source.menus) ? source.menus.slice() : undefined,
      menuKeys: Array.isArray(source.menuKeys) ? source.menuKeys.slice() : undefined,
      menuDefinitions: Array.isArray(source.menuDefinitions) ? source.menuDefinitions.map((item) => ({ ...item })) : undefined,
      permissionSource: source.permissionSource || "",
      scope: source.scope || "",
      shopId: source.shopId || "",
      distributorId: source.distributorId || "",
      agentId: source.agentId || "",
      expiresAt: source.expiresAt || 0
    };
  }

  function publishAuthChange(authenticated) {
    try {
      // 事件只传非敏感元数据，绝不携带 token。
      window.dispatchEvent(new CustomEvent("lxm-auth-changed", {
        detail: { authenticated: !!authenticated, ...sessionMeta(session) }
      }));
    } catch (e) {}
  }

  function getSession() {
    return session ? { ...sessionMeta(session), token: session.token } : null;
  }

  function hasSession() {
    return !!(session && session.token);
  }

  function setSession(value) {
    const next = value && typeof value.token === "string" && value.token ? {
      token: value.token,
      ...sessionMeta(value)
    } : null;
    session = next;
    try {
      if (next) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else window.sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {}
    publishAuthChange(!!next);
    return !!next;
  }

  function clearSession() {
    session = null;
    try { window.sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    publishAuthChange(false);
  }

  function isApiRequest(input) {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    try {
      const parsed = new URL(raw, window.location.href);
      const configured = new URL(base, window.location.href);
      const apiPath = configured.pathname.replace(/\/$/, "") || "/api";
      return parsed.origin === configured.origin && (parsed.pathname === apiPath || parsed.pathname.startsWith(`${apiPath}/`));
    } catch (e) {
      return false;
    }
  }

  function requestUrl(input) {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    try { return new URL(raw, window.location.href); } catch (e) { return null; }
  }

  function authError(message, status) {
    const error = new Error(message || "接口请求失败");
    error.status = status || 0;
    error.isLxmHttpError = true;
    return error;
  }

  function request(input, init = {}, options = {}) {
    const url = requestUrl(input);
    const apiRequest = isApiRequest(input);
    const pathname = url ? url.pathname : "";
    const isLoginRequest = /\/auth\/login$/.test(pathname);
    const requestInit = { ...init };
    const sourceHeaders = init && init.headers
      ? init.headers
      : (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    const headers = new Headers(sourceHeaders || {});
    if (apiRequest && hasSession() && !isLoginRequest && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${session.token}`);
    }
    if (apiRequest && !headers.has("Accept")) headers.set("Accept", "application/json");
    requestInit.headers = headers;
    if (!requestInit.credentials) requestInit.credentials = url && url.origin === window.location.origin ? "same-origin" : "omit";

    return nativeFetch(input, requestInit).then((response) => {
      if (response.status === 401 && apiRequest && !isLoginRequest && !options.suppressAuthEvent) {
        clearSession();
        try { window.dispatchEvent(new CustomEvent("lxm-auth-expired")); } catch (e) {}
      }
      return response;
    }).catch((error) => {
      if (error && error.isLxmNetworkError) throw error;
      const wrapped = new Error("网络不可用");
      wrapped.isLxmNetworkError = true;
      wrapped.cause = error;
      throw wrapped;
    });
  }

  // 页面中仍有少量历史模块直接调用 fetch；仅拦截同源 /api，静态资源请求保持原行为。
  window.fetch = function lxmFetch(input, init) {
    return request(input, init || {});
  };
  window.LXM_HTTP = { request, nativeFetch };

  async function jsonResponse(response) {
    const body = await response.json().catch(() => null);
    if (!response.ok) throw authError((body && (body.error || body.message)) || `接口返回 ${response.status}`, response.status);
    return body;
  }

  async function authLogin(account, password) {
    const response = await request(`${base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, password })
    }, { suppressAuthEvent: true });
    return jsonResponse(response);
  }

  async function authMe() {
    if (!hasSession()) return null;
    const response = await request(`${base}/auth/me`, { method: "GET" });
    return jsonResponse(response);
  }

  async function authLogout() {
    if (!hasSession()) return null;
    try {
      const response = await request(`${base}/auth/logout`, { method: "POST" }, { suppressAuthEvent: true });
      return await response.json().catch(() => null);
    } finally {
      clearSession();
    }
  }

  window.LXM_AUTH = { getSession, hasSession, setSession, clearSession, login: authLogin, me: authMe, logout: authLogout };

  function publishCloudMode(mode, reachable) {
    const safeMode = mode || "mock";
    window.LXM_CLOUD_MODE = safeMode;
    window.LXM_API_STATE = { reachable: !!reachable, mode: safeMode };
    try { window.dispatchEvent(new CustomEvent("lxm-cloud-mode", { detail: safeMode })); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent("lxm-server-status", { detail: { reachable: !!reachable, mode: safeMode } })); } catch (e) {}
  }

  // 健康接口保持公开，仅用于显示连接状态；不读取业务数据。
  nativeFetch(`${base}/health`, { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((response) => response.json().then((body) => ({ response, body })))
    .then(({ response, body }) => publishCloudMode(response.ok ? ((body && body.mode) || "mock") : "mock", response.ok))
    .catch(() => publishCloudMode("mock", false));

  async function getColl(key) {
    if (!hasSession()) throw authError("需要登录后读取管理数据", 401);
    const response = await request(`${base}/collection/${encodeURIComponent(key)}`);
    return jsonResponse(response);
  }

  async function getDoc(key, id) {
    if (!hasSession()) throw authError("需要登录后读取管理数据", 401);
    const response = await request(`${base}/collection/${encodeURIComponent(key)}/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    return jsonResponse(response);
  }

  async function create(key, doc) {
    if (!hasSession()) throw authError("需要登录后写入管理数据", 401);
    const response = await request(`${base}/collection/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc || {})
    });
    return jsonResponse(response);
  }

  async function update(key, id, doc) {
    if (!hasSession()) throw authError("需要登录后写入管理数据", 401);
    const response = await request(`${base}/collection/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc || {})
    });
    return jsonResponse(response);
  }

  async function upsertDoc(key, id, doc) {
    if (!hasSession()) throw authError("需要登录后写入管理数据", 401);
    const response = await request(`${base}/doc/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc || {})
    });
    return jsonResponse(response);
  }

  async function remove(key, id) {
    if (!hasSession()) throw authError("需要登录后删除管理数据", 401);
    const response = await request(`${base}/collection/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    return jsonResponse(response);
  }

  async function orderAction(id, action, payload = {}) {
    if (!hasSession()) throw authError("需要登录后操作订单", 401);
    const response = await request(`${base}/orders/${encodeURIComponent(id)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(payload || {}) })
    });
    const result = await jsonResponse(response);
    return result && result.data ? result.data : result;
  }

  async function afterSaleAction(id, action, payload = {}) {
    if (!hasSession()) throw authError("需要登录后处理售后", 401);
    const response = await request(`${base}/after-sales/${encodeURIComponent(id)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(payload || {}) })
    });
    const result = await jsonResponse(response);
    return result && result.data ? result.data : result;
  }

  async function merchantCodes(shopId) {
    if (!hasSession()) throw authError("需要登录后读取商家码", 401);
    const response = await request(`${base}/merchant-codes?shopId=${encodeURIComponent(shopId || "")}`);
    return jsonResponse(response);
  }

  async function availableDataKeys() {
    if (!hasSession()) throw authError("需要登录后读取数据权限", 401);
    const response = await request(`${base}/meta/keys`);
    const body = await jsonResponse(response);
    return new Set(Array.isArray(body && body.keys) ? body.keys.map(String) : []);
  }

  // Permission data has its own normalized tables and must not be routed
  // through the business-document collection API. Keeping these calls here
  // gives every permission page the same bearer/session handling as the rest
  // of the admin client.
  async function permissionRequest(path = "", method = "GET", payload) {
    if (!hasSession()) throw authError("需要登录后读取权限数据", 401);
    const suffix = String(path || "").replace(/^\/?/, "/");
    const init = { method, headers: { Accept: "application/json" } };
    if (payload !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(payload || {});
    }
    return jsonResponse(await request(`${base}/permissions${suffix}`, init));
  }

  const permissionApi = {
    snapshot: () => permissionRequest(""),
    menus: () => permissionRequest("/menus"),
    roles: () => permissionRequest("/roles"),
    users: () => permissionRequest("/users"),
    createMenu: (payload) => permissionRequest("/menus", "POST", payload),
    updateMenu: (id, payload) => permissionRequest(`/menus/${encodeURIComponent(id)}`, "PUT", payload),
    deleteMenu: (id) => permissionRequest(`/menus/${encodeURIComponent(id)}`, "DELETE"),
    createRole: (payload) => permissionRequest("/roles", "POST", payload),
    updateRole: (id, payload) => permissionRequest(`/roles/${encodeURIComponent(id)}`, "PUT", payload),
    deleteRole: (id) => permissionRequest(`/roles/${encodeURIComponent(id)}`, "DELETE"),
    createUser: (payload) => permissionRequest("/users", "POST", payload),
    updateUser: (id, payload) => permissionRequest(`/users/${encodeURIComponent(id)}`, "PUT", payload),
    disableUser: (id) => permissionRequest(`/users/${encodeURIComponent(id)}/disable`, "POST"),
    enableUser: (id) => permissionRequest(`/users/${encodeURIComponent(id)}/enable`, "POST"),
    deleteUser: (id) => permissionRequest(`/users/${encodeURIComponent(id)}`, "DELETE")
  };
  window.LXM_PERMISSIONS = permissionApi;

  async function merchantCodeStats(shopId) {
    if (!hasSession()) throw authError("需要登录后读取商家码统计", 401);
    const response = await request(`${base}/merchant-codes/stats?shopId=${encodeURIComponent(shopId || "")}`);
    return jsonResponse(response);
  }

  async function generateMerchantCode(payload = {}) {
    if (!hasSession()) throw authError("需要登录后生成商家码", 401);
    const response = await request(`${base}/merchant-code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    return jsonResponse(response);
  }

  function normalizeIds(value) {
    if (Array.isArray(value)) value.forEach((item) => {
      if (!item || typeof item !== "object") return;
      if (item._id && !item.id) item.id = item._id;
      // Keep the admin templates compatible with both legacy and normalized
      // order payloads returned by JSON and MySQL sources.
      if (item.id && !item._id) item._id = item.id;
      if (Array.isArray(item.productItems) && !Array.isArray(item.products)) item.products = item.productItems;
      if (Array.isArray(item.items) && !Array.isArray(item.products)) item.products = item.items;
      if (!item.customer) item.customer = item.contactName || item.name || "";
      if (item.totalAmount === undefined) item.totalAmount = item.totalPrice !== undefined ? item.totalPrice : item.price;
      if (item.totalPrice === undefined) item.totalPrice = item.totalAmount;
      if (item.appointmentAt === undefined) item.appointmentAt = item.date || "";
      if (item.timePeriod === undefined) item.timePeriod = item.time || "";
    });
    return value;
  }

  const knownDataKeys = new Set((cfg.dataKeys || []).concat(cfg.stateKeys || [], cfg.docKeys || []));
  const stateDataKeys = new Set((cfg.stateKeys || []).concat(cfg.docKeys || []));
  const menuData = cfg.menuData && typeof cfg.menuData === "object" ? cfg.menuData : {};
  const routeAliases = { videoProducts: "videoSingles" };
  const allowedKeyCache = { value: null, promise: null };
  const menuLoadChains = new Map();
  const keyRequestVersion = new Map();
  const keyRequestSequence = new Map();
  let loadEpoch = 0;

  function normalizeMenuKey(value) {
    const raw = String(value || "").trim();
    return routeAliases[raw] || raw;
  }

  function menuKeysFor(menuKey) {
    const key = normalizeMenuKey(menuKey);
    const configured = Array.isArray(menuData[key]) ? menuData[key] : [];
    return [...new Set(configured.map((item) => String(item || "").trim()).filter((item) => knownDataKeys.has(item)))];
  }

  async function permittedKeys() {
    if (allowedKeyCache.value) return allowedKeyCache.value;
    if (!allowedKeyCache.promise) {
      allowedKeyCache.promise = availableDataKeys()
        .then((keys) => {
          allowedKeyCache.value = keys;
          return keys;
        })
        .catch((error) => {
          allowedKeyCache.promise = null;
          throw error;
        });
    }
    return allowedKeyCache.promise;
  }

  function clearMenuLoadState() {
    loadEpoch += 1;
    allowedKeyCache.value = null;
    allowedKeyCache.promise = null;
    menuLoadChains.clear();
    keyRequestVersion.clear();
    keyRequestSequence.clear();
  }

  function safeCollectionValue(key, value) {
    const normalized = normalizeIds(value);
    if (["staff", "shops", "distributors", "agents"].includes(key) && Array.isArray(normalized)) {
      return normalized.map(({ password, ...rest }) => rest);
    }
    return normalized;
  }

  function applyLoadedValue(key, value, data, state, version) {
    if (keyRequestVersion.get(key) !== version || value === undefined || value === null) return false;
    if (stateDataKeys.has(key)) {
      if (state && Object.prototype.hasOwnProperty.call(state, key)) state[key] = value;
    } else if (data && Object.prototype.hasOwnProperty.call(data, key)) {
      data[key] = value;
    }
    return true;
  }

  async function loadFinanceSettings(data, version) {
    const doc = await getDoc("financeSettings", "global");
    if (doc && data && Object.prototype.hasOwnProperty.call(data, "financeSettings")) {
      applyLoadedValue("financeSettings", { ...(data.financeSettings || {}), ...doc }, data, null, version);
      return true;
    }
    if (!data || !Object.prototype.hasOwnProperty.call(data, "financeSettings")) return false;
    // Retain support for pre-normalized servers where this singleton was a collection.
    const legacy = safeCollectionValue("financeSettings", await getColl("financeSettings"));
    const rows = Array.isArray(legacy) ? legacy : [];
    const merged = rows.reduce((memo, row) => {
      if (!row || typeof row !== "object") return memo;
      const id = String(row.id || row._id || "");
      const valueKeys = Object.keys(row).filter((name) => !["id", "_id"].includes(name));
      if (valueKeys.length === 1 && valueKeys[0] === "value") memo[id] = row.value;
      else Object.assign(memo, row);
      return memo;
    }, {});
    return applyLoadedValue("financeSettings", { ...(data.financeSettings || {}), ...merged }, data, null, version);
  }

  async function loadDataKey(key, data, state) {
    const sequence = (keyRequestSequence.get(key) || 0) + 1;
    keyRequestSequence.set(key, sequence);
    const version = `${loadEpoch}:${sequence}`;
    keyRequestVersion.set(key, version);
    try {
      if (key === "homeConfig") {
        const doc = await getDoc("homeConfig", "homeStats");
        const config = doc && doc.editorConfig && typeof doc.editorConfig === "object" ? doc.editorConfig : doc;
        return { key, loaded: applyLoadedValue(key, config, data, state, version) };
      }
      if (key === "siteConfig") {
        const doc = await getDoc("siteConfig", "global");
        return { key, loaded: applyLoadedValue(key, doc, data, state, version) };
      }
      if (key === "financeSettings") return { key, loaded: await loadFinanceSettings(data, version) };
      const value = safeCollectionValue(key, await getColl(key));
      return { key, loaded: applyLoadedValue(key, value, data, state, version) };
    } catch (error) {
      // 401/403 never falls back to local fixture data. A failed request leaves
      // only prior server data in place, preventing an authorization boundary
      // from being hidden by bundled demo records.
      if (error && error.status === 401) return { key, error, status: 401 };
      if (error && error.status === 403) return { key, skipped: true, status: 403 };
      if (window.console && console.warn) console.warn(`[cloud] 加载 ${key} 失败，未覆盖当前数据`, error && error.message ? error.message : error);
      return { key, error };
    }
  }

  async function loadMenuData(menuKey, data, state, options = {}) {
    if (!hasSession()) return { skipped: true, reason: "unauthenticated" };
    const routeKey = normalizeMenuKey(menuKey || (state && state.active));
    const keys = menuKeysFor(routeKey);
    if (!keys.length) return { ok: true, routeKey, loaded: [], skipped: [] };

    // Queue repeated visits to the same menu instead of collapsing them into a
    // stale cache hit. Every menu activation performs a new related-data read.
    const previous = menuLoadChains.get(routeKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      let allowedKeys = null;
      try {
        allowedKeys = await permittedKeys();
      } catch (error) {
        if (error && error.status === 401) return { ok: false, status: 401, routeKey };
        // A legacy server may not expose /meta/keys. The collection-level
        // authorization guard below remains the source of truth in that case.
      }
      const requested = allowedKeys ? keys.filter((key) => allowedKeys.has(key)) : keys;
      const skipped = allowedKeys ? keys.filter((key) => !allowedKeys.has(key)) : [];
      const results = await Promise.all(requested.map((key) => loadDataKey(key, data, state)));
      const unauthorized = results.find((result) => result && result.status === 401);
      if (unauthorized) return { ok: false, status: 401, routeKey, loaded: results.filter((result) => result.loaded).map((result) => result.key), skipped };
      return {
        ok: true,
        routeKey,
        loaded: results.filter((result) => result && result.loaded).map((result) => result.key),
        skipped: [...skipped, ...results.filter((result) => result && result.skipped).map((result) => result.key)],
        failed: results.filter((result) => result && result.error && !result.status).map((result) => result.key)
      };
    });
    menuLoadChains.set(routeKey, task);
    task.then(
      () => { if (menuLoadChains.get(routeKey) === task) menuLoadChains.delete(routeKey); },
      () => { if (menuLoadChains.get(routeKey) === task) menuLoadChains.delete(routeKey); }
    );
    return task;
  }

  // Compatibility alias for older callers. It now loads only the requested
  // menu (or the active route) and never expands to every known collection.
  function loadAdminData(data, state, menuKey, options) {
    return loadMenuData(menuKey || (state && state.active), data, state, options);
  }

  window.addEventListener("lxm-auth-changed", () => clearMenuLoadState());

  window.LXM_CLOUD = { getColl, getDoc, create, update, upsertDoc, remove, orderAction, afterSaleAction, merchantCodes, merchantCodeStats, generateMerchantCode, loadMenuData, loadAdminData, clearMenuLoadState, menuKeysFor, mode: () => window.LXM_CLOUD_MODE };
})();
