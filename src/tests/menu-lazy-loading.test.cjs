"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");

function sessionStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fixture(options = {}) {
  const requests = [];
  const listeners = new Map();
  const stored = options.session
    ? { lxm_admin_session_v1: JSON.stringify({ token: "persisted-token", role: "super" }) }
    : {};
  const window = {
    location: { href: "https://admin.example.test/", origin: "https://admin.example.test" },
    sessionStorage: sessionStorage(stored),
    console: { warn() {} },
    addEventListener(type, handler) {
      const rows = listeners.get(type) || [];
      rows.push(handler);
      listeners.set(type, rows);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
      return true;
    }
  };
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input), window.location.href);
    requests.push({ path: url.pathname, search: url.search, method: init.method || "GET" });
    if (url.pathname === "/api/health") {
      if (options.healthNetworkFailure) throw new Error("offline");
      return response(options.healthBody || { ok: true, mode: "mysql" }, options.healthStatus || 200);
    }
    if (url.pathname === "/api/meta/keys") return response({ keys: window.LXM_API_CONFIG.dataKeys.concat(window.LXM_API_CONFIG.stateKeys, window.LXM_API_CONFIG.docKeys) });
    const moduleMatch = url.pathname.match(/^\/api\/modules\/([^/]+)$/);
    if (moduleMatch) {
      const keys = String(url.searchParams.get("keys") || "").split(",").filter(Boolean);
      const collections = {};
      for (const key of keys) {
        if (key === "homeConfig") collections[key] = { id: "homeStats", editorConfig: { id: "home-config" } };
        else if (key === "siteConfig") collections[key] = { id: "global", bookingNotice: [] };
        else if (key === "financeSettings") collections[key] = { id: "global", settlementObservationDays: 3 };
        else collections[key] = [{ id: key }];
      }
      const payload = { module: moduleMatch[1], collections, skippedKeys: [] };
      return options.moduleResponse ? options.moduleResponse(payload) : response(payload);
    }
    const documentMatch = url.pathname.match(/^\/api\/collection\/([^/]+)\/([^/]+)$/);
    if (documentMatch) {
      const [, key, id] = documentMatch;
      if (key === "homeConfig") return response({ id, editorConfig: { id: "home-config" } });
      if (key === "siteConfig") return response({ id, bookingNotice: [] });
      if (key === "financeSettings") return response({ id, settlementObservationDays: 3 });
      return response({ id });
    }
    const collectionMatch = url.pathname.match(/^\/api\/collection\/([^/]+)$/);
    if (collectionMatch) return response([{ id: collectionMatch[1] }]);
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  };
  window.fetch = fetch;
  const sandbox = { window, URL, Headers, Request, CustomEvent, console, Set, Map, Promise };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/config/api.js"), "utf8"), sandbox, { filename: "api.js" });
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/api/cloud.js"), "utf8"), sandbox, { filename: "cloud.js" });
  const data = Object.fromEntries(window.LXM_API_CONFIG.dataKeys.map((key) => [key, key === "financeSettings" ? {} : []]));
  const state = Object.fromEntries(Array.from(new Set(window.LXM_API_CONFIG.stateKeys.concat(window.LXM_API_CONFIG.docKeys))).map((key) => [key, {}]));
  state.active = "dashboard";
  return { window, requests, data, state };
}

function protectedRequests(rows) {
  return rows.filter((row) => row.path.startsWith("/api/") && row.path !== "/api/health");
}

test("schema readiness failure keeps a distinct transport signal without enabling local fallback writes", async () => {
  const f = fixture({ session: true, healthStatus: 503, healthBody: { ok: false, mode: "mysql", data: { error: "schema_incomplete", incomplete: ["lxm_guides.contentHtml"] } } });
  await new Promise(setImmediate);
  assert.equal(f.window.LXM_API_STATE.reachable, false);
  assert.equal(f.window.LXM_API_STATE.transportReachable, true);
  assert.equal(f.window.LXM_API_STATE.dataError, "schema_incomplete");
  assert.deepEqual(Array.from(f.window.LXM_API_STATE.incomplete), ["lxm_guides.contentHtml"]);
  assert.equal(f.window.LXM_CLOUD_MODE, "unavailable", "the unhealthy business store is never treated as ready");
  assert.equal(f.window.LXM_AUTH.hasSession(), true);
});

test("unreachable or unknown health responses cannot authorize file uploads", async () => {
  for (const options of [{ healthNetworkFailure: true }, { healthStatus: 503, healthBody: { error: "proxy failed" } }]) {
    const f = fixture(options); await new Promise(setImmediate);
    assert.equal(f.window.LXM_API_STATE.reachable, false);
    assert.equal(f.window.LXM_API_STATE.transportReachable, false);
  }
});

test("legacy mock and JSON health responses cannot enable real-data mode", async () => {
  for (const mode of ["mock", "json", "", "unknown"]) {
    const f = fixture({ healthBody: { ok: true, mode } }); await new Promise(setImmediate);
    assert.equal(f.window.LXM_API_STATE.reachable, false);
    assert.equal(f.window.LXM_CLOUD_MODE, "unavailable");
  }
});

function collectionKey(pathname) {
  const match = pathname.match(/^\/api\/collection\/([^/]+)(?:\/[^/]+)?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function moduleKeys(row) {
  return decodeURIComponent(String(row && row.search || "").replace(/^\?keys=/, "")).split(",").filter(Boolean).sort();
}

test("persisted sessions do not read protected business data before authenticated menu loading", async () => {
  const f = fixture({ session: true });
  await Promise.resolve();
  assert.deepEqual(protectedRequests(f.requests), []);
  assert.equal(f.window.LXM_CLOUD.menuKeysFor("orders").includes("orders"), true);
  assert.equal(f.window.LXM_CLOUD.menuKeysFor("permissions").length, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "src/app/01-core-state.js"), "utf8"), /LXM_CLOUD\.loadAdminData\(data, state\)/);
});

test("orders menu requests only its configured data pack after login", async () => {
  const f = fixture();
  f.window.LXM_AUTH.setSession({ token: "session-token", role: "super" });
  const result = await f.window.LXM_CLOUD.loadMenuData("orders", f.data, f.state, { force: true });
  const expected = Array.from(f.window.LXM_API_CONFIG.menuData.orders).sort();
  const moduleRequests = protectedRequests(f.requests).filter((row) => row.path === "/api/modules/orders");
  const requestedKeys = moduleKeys(moduleRequests[0]);
  assert.equal(result.ok, true);
  assert.equal(moduleRequests.length, 1);
  assert.equal(protectedRequests(f.requests).filter((row) => row.path === "/api/meta/keys").length, 0);
  assert.deepEqual(requestedKeys, expected);
  for (const forbidden of ["logs", "trash", "guides", "stories", "homeConfig", "siteConfig", "monthlyClosings"]) {
    assert.equal(requestedKeys.includes(forbidden), false, `orders must not prefetch ${forbidden}`);
  }
  assert.equal(f.data.orders[0].id, "orders");
  assert.equal(f.data.afterSales[0].id, "afterSales");
});

test("套餐菜单直接进入时加载城市、点位和全部组合商品来源", async () => {
  const f = fixture();
  f.window.LXM_AUTH.setSession({ token: "session-token", role: "super" });
  const result = await f.window.LXM_CLOUD.loadMenuData("packages", f.data, f.state, { force: true });
  const requests = protectedRequests(f.requests);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/modules/content");
  const keys = moduleKeys(requests[0]);
  for (const key of ["cities", "spots", "albums", "packages", "peripherals"]) {
    assert.ok(keys.includes(key), `套餐组合需要加载 ${key}`);
    assert.equal(f.data[key][0].id, key);
  }
});

test("each menu activation reloads its own data pack without revisiting unrelated collections", async () => {
  const f = fixture();
  f.window.LXM_AUTH.setSession({ token: "session-token", role: "super" });
  await f.window.LXM_CLOUD.loadMenuData("orders", f.data, f.state, { force: true });
  const afterOrders = protectedRequests(f.requests).length;
  await f.window.LXM_CLOUD.loadMenuData("shops", f.data, f.state, { force: true });
  const shopRequests = protectedRequests(f.requests).slice(afterOrders);
  assert.equal(shopRequests.length, 1);
  assert.equal(shopRequests[0].path, "/api/modules/channel");
  assert.deepEqual(moduleKeys(shopRequests[0]), Array.from(f.window.LXM_API_CONFIG.menuData.shops).sort());
  const afterShops = protectedRequests(f.requests).length;
  await f.window.LXM_CLOUD.loadMenuData("orders", f.data, f.state, { force: true });
  const secondOrderRequests = protectedRequests(f.requests).slice(afterShops);
  assert.equal(secondOrderRequests.length, 1);
  assert.equal(secondOrderRequests[0].path, "/api/modules/orders");
  assert.deepEqual(moduleKeys(secondOrderRequests[0]), Array.from(f.window.LXM_API_CONFIG.menuData.orders).sort());
  assert.equal(protectedRequests(f.requests).filter((row) => row.path === "/api/meta/keys").length, 0, "module endpoint owns per-key authorization");
  assert.equal(moduleKeys(secondOrderRequests[0]).includes("logs"), false);
});

test("guide page mounting shares a pending navigation read while retries and later visits remain fresh", async () => {
  const replies = [];
  const f = fixture({ session: true, moduleResponse: (payload) => new Promise((resolve) => replies.push(() => resolve(response(payload)))) });
  const navigation = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state, { force: true });
  await new Promise(setImmediate);
  const mounted = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state, { force: true, joinPending: true });
  assert.equal(protectedRequests(f.requests).length, 1);
  replies.shift()();
  const results = await Promise.all([navigation, mounted]);
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(moduleKeys(protectedRequests(f.requests)[0]), ["albums", "guides", "packages", "series", "spots"]);
  const retry = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state, { force: true });
  const nextVisit = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state, { force: true });
  await new Promise(setImmediate);
  assert.equal(protectedRequests(f.requests).length, 2, "a retry starts a fresh read");
  replies.shift()();
  await retry;
  await new Promise(setImmediate);
  assert.equal(protectedRequests(f.requests).length, 3, "another navigation retains its own fresh read");
  replies.shift()();
  assert.equal((await nextVisit).ok, true);
});

test("pending menu reads are not shared across data or state containers", async () => {
  for (const container of ["data", "state"]) {
    const replies = [];
    const f = fixture({ session: true, moduleResponse: (payload) => new Promise((resolve) => replies.push(() => resolve(response(payload)))) });
    const first = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state);
    await new Promise(setImmediate);
    const otherData = container === "data" ? { ...f.data, guides: [] } : f.data;
    const otherState = container === "state" ? { ...f.state } : f.state;
    const second = f.window.LXM_CLOUD.loadMenuData("guides", otherData, otherState, { joinPending: true });
    replies.shift()();
    await first;
    await new Promise(setImmediate);
    assert.equal(protectedRequests(f.requests).length, 2, `${container} target needs its own read`);
    replies.shift()();
    assert.equal((await second).ok, true);
    assert.equal(otherData.guides[0].id, "guides");
  }
});

test("session changes discard old and queued menu reads without replacing the new session data", async () => {
  const replies = [];
  const f = fixture({ session: true, moduleResponse: (payload) => new Promise((resolve) => replies.push((id) => resolve(response({
    ...payload, collections: { ...payload.collections, guides: [{ id }] }
  })))) });
  const oldSession = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state);
  const queued = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state);
  await new Promise(setImmediate);
  f.window.LXM_AUTH.setSession({ token: "new-session", role: "super" });
  const newSession = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state, { joinPending: true });
  await new Promise(setImmediate);
  assert.equal(protectedRequests(f.requests).length, 2, "the new session never joins the old request");
  replies[1]("current");
  assert.equal((await newSession).ok, true);
  replies[0]("expired");
  assert.equal((await oldSession).reason, "session_changed");
  assert.equal((await queued).reason, "session_changed");
  assert.equal(protectedRequests(f.requests).length, 2, "an obsolete queued read never runs with the new credentials");
  assert.equal(f.data.guides[0].id, "current");
});

test("an old session module response cannot fall back to collections using new credentials", async () => {
  let finish;
  const f = fixture({ session: true, moduleResponse: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = f.window.LXM_CLOUD.loadMenuData("guides", f.data, f.state);
  await new Promise(setImmediate);
  f.window.LXM_AUTH.setSession({ token: "new-session", role: "super" });
  finish(response({ error: "old server" }, 404));
  assert.equal((await pending).reason, "session_changed");
  assert.equal(protectedRequests(f.requests).length, 1);
  assert.equal(f.data.guides.length, 0);
});

test("carousel settings fetch only banners and jump targets while retired settings have no data pack", async () => {
  const f = fixture();
  f.window.LXM_AUTH.setSession({ token: "session-token", role: "super" });
  await f.window.LXM_CLOUD.loadMenuData("permissions", f.data, f.state, { force: true });
  assert.deepEqual(protectedRequests(f.requests), []);
  await f.window.LXM_CLOUD.loadMenuData("miniDecor", f.data, f.state, { force: true });
  const configRequests = protectedRequests(f.requests).map((row) => row.path).sort();
  assert.deepEqual(configRequests, ["/api/modules/configuration"]);
  assert.deepEqual(moduleKeys(protectedRequests(f.requests)[0]), ["albums", "guides", "homeConfig", "packages", "peripherals", "samples", "spots"]);
  assert.deepEqual(Array.from(f.window.LXM_CLOUD.menuKeysFor("miniConfig")), []);
  assert.equal(f.window.LXM_API_CONFIG.menuModules.miniConfig, undefined);
});

test("legacy loader compatibility resolves to the active menu instead of the full collection catalog", async () => {
  const f = fixture();
  f.window.LXM_AUTH.setSession({ token: "session-token", role: "super" });
  f.state.active = "tasks";
  await f.window.LXM_CLOUD.loadAdminData(f.data, f.state);
  const requested = protectedRequests(f.requests);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].path, "/api/modules/orders");
  assert.deepEqual(moduleKeys(requested[0]), Array.from(f.window.LXM_API_CONFIG.menuData.tasks).sort());
  assert.equal(moduleKeys(requested[0]).length < f.window.LXM_API_CONFIG.dataKeys.length, true);
});

test("server share permissions survive the public session metadata boundary", () => {
  const f = fixture();
  f.window.LXM_AUTH.setSession({ token: "test-session", role: "custom-ops", sharePermissions: ["share:view", "share:config", "unrelated"] });
  assert.deepEqual(Array.from(f.window.LXM_AUTH.getSession().sharePermissions), ["share:view", "share:config"]);
});

test("menu switching invokes a fresh route-key data load on every visit", async () => {
  const calls = [];
  const state = {
    authChecking: false, authNotice: "", authSource: "server", serverReachable: true, dataLoading: false,
    menuDataLoadingKey: "", menuDataRequestId: 0, mobileMenuOpen: false, authed: true,
    role: "super", loginRole: "super", previewRole: "super", currentStaffId: "staff-1", currentAccount: "admin",
    active: "dashboard", login: {}, menuRevision: 0, selectedOrderIds: [], merchantCodes: [], merchantCodeStats: {},
    currentOrder: null, currentAfterSale: null, currentFinanceReview: null,
    filters: { status: "", financeStatus: "", afterSaleStatus: "", refundStatus: "", transferStatus: "", rescheduleStatus: "", assigneeId: "", photographerId: "", productType: "", contentStatus: "", contentSpotId: "", contentSeriesId: "", shelfType: "", cityId: "", agentId: "", distributorId: "", shopId: "", logUser: "", logModule: "", logLevel: "", logAction: "", keyword: "" }
  };
  const data = Object.fromEntries([
    "cities", "agents", "distributors", "shops", "staff", "spots", "series", "albums", "samples", "packages", "addonServices", "peripherals", "videoSingles", "tagLibrary", "guides", "stories", "scans", "orders", "afterSales", "reconciliationTransfers", "financeSettings", "monthlyClosings", "adjustmentRecords"
  ].map((key) => [key, []]));
  const listeners = new Map();
  const window = {
    LXM_APP_PARTS: [],
    LXM_DATA: {},
    LXM_API_STATE: { reachable: true },
    LXM_CLOUD_MODE: "mysql",
    LXM_AUTH: { getSession: () => ({ token: "fixture-session", role: "super" }), hasSession: () => true, setSession() {}, clearSession() {}, logout: async () => null },
    LXM_CLOUD: { async loadMenuData(routeKey, loadedData, loadedState, options) { calls.push({ routeKey, loadedData, loadedState, options }); return { ok: true, routeKey }; } },
    addEventListener(type, callback) { listeners.set(type, callback); }
  };
  const LXM_CONFIG = {
    menus: [{ key: "dashboard", label: "看板" }, { key: "salesWorklist", label: "订单工作台", routeKey: "orders" }, { key: "staff", label: "人员", routeKey: "staff" }, { key: "miniDecor", label: "轮播配置", group: "内容管理", navigationOrder: 9 }],
    roles: { super: { name: "超管", home: "dashboard", menus: ["dashboard", "salesWorklist", "staff", "miniDecor"], scope: "all", staffId: "staff-1" } }
  };
  const ctx = {
    ElMessage: { warning() {}, error() {}, success() {} },
    canPreviewRoles: { value: true }, contentKeys: [], currentOperatorName: () => "admin", data,
    hydrateFromStorage() {}, log() {}, menus: { value: LXM_CONFIG.menus }, resetPageState() {}, roleName: (key) => key,
    roleProfile: { value: LXM_CONFIG.roles.super }, state
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/app/03-auth.js"), "utf8"), { window, LXM_CONFIG, structuredClone, console, Set, Map, Object, Array, Promise }, { filename: "03-auth.js" });
  const auth = window.LXM_APP_PARTS[0](ctx);
  await auth.switchMenu("salesWorklist");
  await auth.switchMenu("staff");
  await auth.switchMenu("salesWorklist");
  assert.deepEqual(calls.map((call) => call.routeKey), ["orders", "staff", "orders"]);
  assert.equal(calls.every((call) => call.options.force === true), true);
  assert.equal(state.active, "salesWorklist");
  auth.applyLogin({ token: "fixture-session", role: "super", menus: ["dashboard", "miniDecor", "miniConfig", "legacyGlobal"], menuDefinitions: [
    { key: "miniDecor", label: "小程序首页", routeKey: "miniDecor" },
    { key: "miniConfig", label: "小程序全局配置", routeKey: "miniConfig" },
    { key: "legacyGlobal", label: "旧全局配置", routeKey: "miniConfig" }
  ] }, { source: "server" });
  assert.equal(LXM_CONFIG.menus.some((menu) => ["miniConfig", "legacyGlobal"].includes(menu.key)), false);
  assert.equal(LXM_CONFIG.menus.find((menu) => menu.key === "miniDecor").label, "轮播配置");
  await auth.switchMenu("miniConfig");
  assert.equal(calls.at(-1).routeKey, "miniDecor");
  assert.equal(state.active, "miniDecor");
});

test("retired settings route resolves to carousel settings without registering its deleted assets", () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/router/index.js"), "utf8"), { window });
  assert.equal(window.LXM_PAGES.manifest.some((page) => page.key === "miniConfig"), false);
  assert.equal(window.LXM_PAGES.componentNameFor("miniConfig"), "LxmPageMiniDecor");
  assert.equal(window.LXM_PAGES.pageFor("miniConfig").key, "miniDecor");
});
