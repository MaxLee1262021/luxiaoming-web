"use strict";

const https = require("node:https");

class PhysicalProviderError extends Error {
  constructor(message, { code = "PHYSICAL_PROVIDER_ERROR", statusCode = 502, retryable = false, providerCode = "" } = {}) {
    super(message); this.name = "PhysicalProviderError"; this.code = code;
    this.statusCode = statusCode; this.retryable = retryable; this.providerCode = String(providerCode);
  }
}

// Fixed provider URLs are supplied by the adapters, never by a public request.
function requestJson({ url, method = "POST", headers = {}, body = "", timeoutMs = 8000, maxBytes = 1048576 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") return reject(new PhysicalProviderError("物流服务必须使用HTTPS", { code: "PHYSICAL_PROVIDER_PROTOCOL", statusCode: 500 }));
    const encoded = typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request(target, { method, headers: { ...headers, ...(encoded ? { "Content-Length": Buffer.byteLength(encoded) } : {}) }, timeout: timeoutMs }, res => {
      let bytes = 0; const chunks = [];
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(); req.destroy(new PhysicalProviderError("物流响应过大", { code: "PHYSICAL_PROVIDER_RESPONSE_LIMIT" })); }
        else chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new PhysicalProviderError("物流服务暂不可用", { code: "PHYSICAL_PROVIDER_HTTP", retryable: res.statusCode === 429 || res.statusCode >= 500 }));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (_) { reject(new PhysicalProviderError("物流响应格式异常", { code: "PHYSICAL_PROVIDER_JSON", retryable: true })); }
      });
      res.on("error", () => reject(new PhysicalProviderError("物流响应中断", { code: "PHYSICAL_PROVIDER_RESPONSE", retryable: true })));
    });
    req.once("timeout", () => req.destroy(new PhysicalProviderError("物流请求超时", { code: "PHYSICAL_PROVIDER_TIMEOUT", retryable: true })));
    req.once("error", error => reject(error instanceof PhysicalProviderError ? error : new PhysicalProviderError("物流连接失败", { code: "PHYSICAL_PROVIDER_NETWORK", retryable: true })));
    if (encoded) req.write(encoded);
    req.end();
  });
}

module.exports = { PhysicalProviderError, requestJson };
