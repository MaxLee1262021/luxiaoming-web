"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AMAP_SERVICE_PATH,
  buildProxyTarget,
  buildPublicConfig,
  createAmapRuntime,
  isJsonpRequest,
  renderRuntimeConfig
} = require("../lib/amapRuntime.cjs");

function responseCapture() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(value = "") { this.body += value; this.headersSent = true; }
  };
}

test("AMap runtime config exposes only the public JS key and same-origin proxy host", () => {
  const securityJsCode = "server-only-amap-security-code";
  const config = buildPublicConfig({
    NODE_ENV: "production",
    AMAP_WEB_JS_KEY: "public-web-js-key",
    AMAP_SECURITY_JS_CODE: securityJsCode
  });
  const script = renderRuntimeConfig(config);

  assert.equal(config.enabled, true);
  assert.equal(config.localProxyEnabled, true);
  assert.equal(config.serviceHost, "__LXM_SAME_ORIGIN_AMAP_SERVICE__");
  assert.match(script, /window\.location\.origin \+ "\/_AMapService"/);
  assert.match(script, /public-web-js-key/);
  assert.equal(script.includes(securityJsCode), false);
  assert.equal(script.includes("securityJsCode"), false);
});

test("AMap runtime config fails closed without a safe proxy", () => {
  const missingProxy = buildPublicConfig({ NODE_ENV: "production", AMAP_WEB_JS_KEY: "public-web-js-key" });
  assert.deepEqual(missingProxy, {
    enabled: false,
    key: "",
    serviceHost: "",
    reason: "AMAP_PROXY_UNCONFIGURED",
    localProxyEnabled: false
  });

  const insecureExternalProxy = buildPublicConfig({
    NODE_ENV: "production",
    AMAP_WEB_JS_KEY: "public-web-js-key",
    AMAP_SERVICE_HOST: "http://maps.example.com/_AMapService"
  });
  assert.equal(insecureExternalProxy.enabled, false);
  assert.equal(insecureExternalProxy.reason, "AMAP_SERVICE_HOST_INVALID");
});

test("AMap config endpoint is no-store and proxy is unavailable without a server secret", () => {
  const runtime = createAmapRuntime({ NODE_ENV: "test" });
  const configResponse = responseCapture();
  runtime.handleRuntimeConfig({ method: "GET" }, configResponse);
  assert.equal(configResponse.statusCode, 200);
  assert.equal(configResponse.getHeader("cache-control"), "no-store");
  assert.match(configResponse.body, /LXM_AMAP_CONFIG/);

  const proxyResponse = responseCapture();
  runtime.handleProxy({ method: "GET", url: `${AMAP_SERVICE_PATH}/v3/config/district` }, proxyResponse);
  assert.equal(proxyResponse.statusCode, 404);
});

test("AMap proxy keeps all requests on fixed AMap upstreams and replaces caller jscode", () => {
  const request = new URL(`http://localhost${AMAP_SERVICE_PATH}//attacker.example/path?jscode=caller-value&key=public-key`);
  const target = buildProxyTarget(request, "server-only-code");
  assert.equal(target.hostname, "restapi.amap.com");
  assert.equal(target.searchParams.get("jscode"), "server-only-code");
  assert.equal(target.searchParams.get("key"), "public-key");
});

test("AMap proxy identifies JSONP callbacks so they can retain script semantics", () => {
  assert.equal(isJsonpRequest(new URL("http://localhost" + AMAP_SERVICE_PATH + "/v3/geocode/regeo?callback=jsonp_123")), true);
  assert.equal(isJsonpRequest(new URL("http://localhost" + AMAP_SERVICE_PATH + "/v3/geocode/regeo")), false);
});
