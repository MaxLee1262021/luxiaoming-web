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
      account: source.account || "",
      name: source.name || "",
      staffId: source.staffId || "",
      menus: Array.isArray(source.menus) ? source.menus.slice() : undefined,
      actions: Array.isArray(source.actions) ? source.actions.slice() : undefined,
      scope: source.scope || "",
      shopId: source.shopId || ""
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
      const apiPath = base.startsWith("/") ? base : `/${base}`;
      return parsed.origin === window.location.origin && (parsed.pathname === apiPath || parsed.pathname.startsWith(`${apiPath}/`));
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
    if (!requestInit.credentials) requestInit.credentials = "same-origin";

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

  function normalizeIds(value) {
    if (Array.isArray(value)) value.forEach((item) => { if (item && item._id && !item.id) item.id = item._id; });
    return value;
  }

  let loadPromise = null;
  async function loadAdminData(data, state) {
    if (!hasSession()) return { skipped: true, reason: "unauthenticated" };
    if (loadPromise) return loadPromise;
    const all = (cfg.dataKeys || []).concat(cfg.stateKeys || [], cfg.docKeys || []);
    loadPromise = (async () => {
      for (const key of all) {
        try {
          if (key === "homeConfig") {
            const doc = await getDoc("homeConfig", "homeStats");
            if (doc && doc.editorConfig && state && state.homeConfig !== undefined) state.homeConfig = doc.editorConfig;
            continue;
          }
          if (key === "siteConfig") {
            const doc = await getDoc("siteConfig", "global");
            if (doc && state && state.siteConfig !== undefined) state.siteConfig = doc;
            continue;
          }
          const value = normalizeIds(await getColl(key));
          if (value === undefined || value === null) continue;
          // 服务端已经剥离 password；这里再次防御，避免未来适配器误下发凭据。
          const safe = (key === "staff" || key === "shops") && Array.isArray(value)
            ? value.map(({ password, ...rest }) => rest)
            : value;
          if ((cfg.stateKeys || []).includes(key)) {
            if (state && state[key] !== undefined) state[key] = safe;
          } else if (data && data[key] !== undefined) {
            data[key] = safe;
          }
        } catch (error) {
          // 401/403 时不回退到演示数据，避免权限边界被本地默认值掩盖。
          if (error && (error.status === 401 || error.status === 403)) {
            if (error.status === 401) return { ok: false, status: 401 };
            continue;
          }
          // 网络/单集合故障只保留当前已成功数据，不把未认证或旧 mock 冒充真实数据。
          if (window.console && console.warn) console.warn(`[cloud] 加载 ${key} 失败，未覆盖当前数据`, error && error.message ? error.message : error);
        }
      }
      return { ok: true };
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  window.LXM_CLOUD = { getColl, getDoc, create, update, upsertDoc, remove, loadAdminData, mode: () => window.LXM_CLOUD_MODE };
})();
