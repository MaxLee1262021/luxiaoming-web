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
    if (url.pathname === "/api/health") return response({ ok: true, mode: "mysql" });
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
      return response({ module: moduleMatch[1], collections, skippedKeys: [] });
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

test("fixed-document menus fetch only their owned document and permissions has no collection preload", async () => {
  const f = fixture();
  f.window.LXM_AUTH.setSession({ token: "session-token", role: "super" });
  await f.window.LXM_CLOUD.loadMenuData("permissions", f.data, f.state, { force: true });
  assert.deepEqual(protectedRequests(f.requests), []);
  await f.window.LXM_CLOUD.loadMenuData("miniConfig", f.data, f.state, { force: true });
  const configRequests = protectedRequests(f.requests).map((row) => row.path).sort();
  assert.deepEqual(configRequests, ["/api/modules/configuration"]);
  assert.deepEqual(moduleKeys(protectedRequests(f.requests)[0]), ["siteConfig"]);
  assert.deepEqual(f.state.siteConfig, { id: "global", bookingNotice: [] });
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

test("menu switching invokes a fresh route-key data load on every visit", async () => {
  const calls = [];
  const state = {
    authChecking: false, authNotice: "", authSource: "server", serverReachable: true, dataLoading: false,
    menuDataLoadingKey: "", menuDataRequestId: 0, mobileMenuOpen: false, authed: true,
    role: "super", loginRole: "super", previewRole: "super", currentStaffId: "staff-1", currentAccount: "admin",
    active: "dashboard", menuRevision: 0, selectedOrderIds: [], merchantCodes: [], merchantCodeStats: {},
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
    LXM_AUTH: { getSession: () => null, hasSession: () => true, setSession() {}, clearSession() {}, logout: async () => null },
    LXM_CLOUD: { async loadMenuData(routeKey, loadedData, loadedState, options) { calls.push({ routeKey, loadedData, loadedState, options }); return { ok: true, routeKey }; } },
    addEventListener(type, callback) { listeners.set(type, callback); }
  };
  const LXM_CONFIG = {
    menus: [{ key: "dashboard", label: "看板" }, { key: "salesWorklist", label: "订单工作台", routeKey: "orders" }, { key: "shops", label: "商家", routeKey: "shops" }],
    roles: { super: { name: "超管", home: "dashboard", menus: ["dashboard", "salesWorklist", "shops"], scope: "all", staffId: "staff-1" } }
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
  await auth.switchMenu("shops");
  await auth.switchMenu("salesWorklist");
  assert.deepEqual(calls.map((call) => call.routeKey), ["orders", "shops", "orders"]);
  assert.equal(calls.every((call) => call.options.force === true), true);
  assert.equal(state.active, "salesWorklist");
});
