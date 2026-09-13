"use strict";

const https = require("node:https");

const RUNTIME_CONFIG_PATH = "/runtime-config.js";
const AMAP_SERVICE_PATH = "/_AMapService";
const DEFAULT_PROXY_TIMEOUT_MS = 8000;
const MAX_PROXY_TIMEOUT_MS = 30000;
const LOCAL_SERVICE_HOST = "__LXM_SAME_ORIGIN_AMAP_SERVICE__";

function cleanEnv(value) {
  return String(value || "").trim();
}

function isSafeCredential(value) {
  return Boolean(value) && /^[^\x00-\x20\x7f]+$/.test(value);
}

function isProductionLike(value) {
  return ["production", "prod", "staging"].includes(cleanEnv(value).toLowerCase());
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeServiceHost(value, nodeEnv) {
  const raw = cleanEnv(value);
  if (!raw) return { value: "", valid: true };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return { value: "", valid: false };
  }

  const pathname = parsed.pathname.replace(/\/$/, "");
  const usesHttp = parsed.protocol === "http:";
  const canUseHttp = !isProductionLike(nodeEnv) || isLoopbackHost(parsed.hostname);
  const valid = ["https:", "http:"].includes(parsed.protocol)
    && (!usesHttp || canUseHttp)
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && parsed.hostname
    && pathname.endsWith(AMAP_SERVICE_PATH);

  if (!valid) return { value: "", valid: false };
  return { value: `${parsed.origin}${pathname}`, valid: true };
}

function proxyTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PROXY_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(parsed), 1000), MAX_PROXY_TIMEOUT_MS);
}

function buildPublicConfig(env = process.env) {
  const key = cleanEnv(env.AMAP_WEB_JS_KEY);
  const securityJsCode = cleanEnv(env.AMAP_SECURITY_JS_CODE);
  const configuredHost = normalizeServiceHost(env.AMAP_SERVICE_HOST, env.NODE_ENV);
  const localProxyEnabled = isSafeCredential(key) && isSafeCredential(securityJsCode) && !configuredHost.value;

  if (!isSafeCredential(key)) {
    return {
      enabled: false,
      key: "",
      serviceHost: "",
      reason: "AMAP_KEY_MISSING",
      localProxyEnabled: false
    };
  }

  if (!configuredHost.valid) {
    return {
      enabled: false,
      key: "",
      serviceHost: "",
      reason: "AMAP_SERVICE_HOST_INVALID",
      localProxyEnabled: false
    };
  }

  if (configuredHost.value) {
    return {
      enabled: true,
      key,
      serviceHost: configuredHost.value,
      reason: "",
      localProxyEnabled: false
    };
  }

  if (localProxyEnabled) {
    return {
      enabled: true,
      key,
      serviceHost: LOCAL_SERVICE_HOST,
      reason: "",
      localProxyEnabled: true
    };
  }

  return {
    enabled: false,
    key: "",
    serviceHost: "",
    reason: "AMAP_PROXY_UNCONFIGURED",
    localProxyEnabled: false
  };
}

function clientConfig(config) {
  return {
    enabled: config.enabled,
    key: config.key,
    serviceHost: config.serviceHost,
    reason: config.reason
  };
}

function renderRuntimeConfig(config) {
  // Escape HTML-sensitive characters so an environment value cannot terminate a script context.
  const serialized = JSON.stringify(clientConfig(config))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const localMarker = JSON.stringify(LOCAL_SERVICE_HOST);
  const localPath = JSON.stringify(AMAP_SERVICE_PATH);
  return `;(function (window) {\n  var config = ${serialized};\n  if (config.serviceHost === ${localMarker}) config.serviceHost = window.location.origin + ${localPath};\n  window.LXM_AMAP_CONFIG = Object.freeze(config);\n})(window);\n`;
}

function sendText(res, statusCode, message, headers = {}) {
  res.statusCode = statusCode;
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(message);
}

function safeRequestPath(rawUrl) {
  try {
    const parsed = new URL(rawUrl || "/", "http://localhost");
    if (parsed.pathname !== AMAP_SERVICE_PATH && !parsed.pathname.startsWith(`${AMAP_SERVICE_PATH}/`)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function buildProxyTarget(parsed, securityJsCode) {
  const suffix = parsed.pathname.slice(AMAP_SERVICE_PATH.length) || "/";
  let origin = "https://restapi.amap.com";
  let pathname = suffix;
  if (suffix === "/v4/map/styles") origin = "https://webapi.amap.com";
  if (suffix === "/v3/vectormap") origin = "https://fmap01.amap.com";

  // Assigning pathname to an already fixed origin prevents a user-controlled
  // path such as //host from changing the upstream host.
  const target = new URL(origin);
  target.pathname = pathname;
  target.search = parsed.search;
  target.searchParams.set("jscode", securityJsCode);
  return target;
}

function isJsonpRequest(parsed) {
  return Boolean(parsed && parsed.searchParams && cleanEnv(parsed.searchParams.get("callback")));
}

function copyResponseHeaders(upstream, res) {
  for (const name of ["content-type", "content-length", "content-encoding", "cache-control", "etag", "last-modified"]) {
    const value = upstream.headers[name];
    if (value !== undefined) res.setHeader(name, value);
  }
}

function createAmapRuntime(env = process.env) {
  const config = buildPublicConfig(env);
  const securityJsCode = cleanEnv(env.AMAP_SECURITY_JS_CODE);
  const timeoutMs = proxyTimeout(env.AMAP_PROXY_TIMEOUT_MS);

  function handlesRuntimeConfig(pathname) {
    return pathname === RUNTIME_CONFIG_PATH;
  }

  function handlesProxy(pathname) {
    return pathname === AMAP_SERVICE_PATH || pathname.startsWith(`${AMAP_SERVICE_PATH}/`);
  }

  function handleRuntimeConfig(req, res) {
    if (!req || !["GET", "HEAD"].includes(req.method)) {
      return sendText(res, 405, "Method not allowed", { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    return res.end(req.method === "HEAD" ? "" : renderRuntimeConfig(config));
  }

  function handleProxy(req, res) {
    if (!req || !["GET", "HEAD"].includes(req.method)) {
      return sendText(res, 405, "Method not allowed", { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    }
    if (!config.localProxyEnabled) return sendText(res, 404, "Not found", { "Cache-Control": "no-store" });

    const parsed = safeRequestPath(req.url);
    if (!parsed) return sendText(res, 404, "Not found", { "Cache-Control": "no-store" });
    const target = buildProxyTarget(parsed, securityJsCode);
    const upstream = https.request(target, {
      method: req.method,
      headers: {
        Accept: String(req.headers && req.headers.accept || "application/json, text/plain, */*"),
        "User-Agent": "luxiaoming-admin-amap-proxy/1.0"
      }
    }, (upstreamResponse) => {
      res.statusCode = upstreamResponse.statusCode || 502;
      res.setHeader("X-Content-Type-Options", "nosniff");
      copyResponseHeaders(upstreamResponse, res);
      // AMap's JS API requests geocoding through JSONP but upstream labels the
      // callback body as JSON. With nosniff, browsers refuse to execute it and
      // the JS API reports a generic error status.
      if (isJsonpRequest(parsed)) res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      if (req.method === "HEAD") {
        upstreamResponse.resume();
        return res.end();
      }
      return upstreamResponse.pipe(res);
    });

    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("AMap proxy timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) sendText(res, 502, "AMap service unavailable", { "Cache-Control": "no-store" });
      else res.destroy();
    });
    upstream.end();
    return undefined;
  }

  return {
    config,
    handlesRuntimeConfig,
    handlesProxy,
    handleRuntimeConfig,
    handleProxy
  };
}

module.exports = {
  AMAP_SERVICE_PATH,
  LOCAL_SERVICE_HOST,
  RUNTIME_CONFIG_PATH,
  buildProxyTarget,
  buildPublicConfig,
  createAmapRuntime,
  isJsonpRequest,
  normalizeServiceHost,
  renderRuntimeConfig
};
