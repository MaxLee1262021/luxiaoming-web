"use strict";

const path = require("path");
const crypto = require("crypto");

function fileError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code: `FILE_${code}`, statusCode });
}

function readConfig(env = process.env) {
  const region = String(env.OSS_REGION || "").trim().replace(/^oss-/, "");
  const bucket = String(env.OSS_BUCKET || "").trim();
  const prefix = String(env.OSS_KEY_PREFIX || "luxiaoming/prod/").replace(/^\/+/, "").replace(/\/*$/, "/");
  if (!region || !/^[a-z0-9-]+$/.test(region) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    || !env.OSS_ACCESS_KEY_ID || !env.OSS_ACCESS_KEY_SECRET || !prefix || prefix.includes("..") || !/^[a-zA-Z0-9/_-]+\/$/.test(prefix)) {
    throw fileError("CONFIG", "文件存储配置不完整，请联系管理员", 503);
  }
  const endpoint = env.OSS_ENDPOINT ? String(env.OSS_ENDPOINT).replace(/\/$/, "") : `https://oss-${region}.aliyuncs.com`;
  const endpointUrl = new URL(endpoint.startsWith("https://") ? endpoint : `https://${endpoint}`);
  if (endpointUrl.username || endpointUrl.password || endpointUrl.pathname !== "/" || endpointUrl.search || endpointUrl.hash) throw fileError("CONFIG", "文件存储域名配置无效", 503);
  const readDomain = String(env.OSS_READ_DOMAIN || "").replace(/\/$/, "");
  if (readDomain && (!/^https:\/\//.test(readDomain) || new URL(readDomain).pathname !== "/")) throw fileError("CONFIG", "文件访问域名必须为 HTTPS 域名", 503);
  return { bucket, region, prefix, endpoint: endpointUrl.origin, readDomain,
    accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    stsToken: env.OSS_SESSION_TOKEN || undefined,
    uploadTtl: 600, readTtl: 900 };
}

function createOssStorage(options = {}) {
  let client;
  let reader;
  let config;
  function ready() {
    if (client) return;
    config = options.config || readConfig(options.env || process.env);
    const OSS = require("ali-oss");
    const shared = { region: `oss-${config.region}`, bucket: config.bucket,
      accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret,
      ...(config.stsToken ? { stsToken: config.stsToken } : {}), authorizationV4: true, secure: true, timeout: 30000 };
    client = new OSS({ ...shared, endpoint: config.endpoint });
    reader = config.readDomain ? new OSS({ ...shared, endpoint: config.readDomain, cname: true }) : client;
  }
  function assertObject(asset) {
    ready();
    if (asset.bucket !== config.bucket || !String(asset.objectKey || "").startsWith(config.prefix) || asset.objectKey.includes("..")) {
      throw fileError("SCOPE", "文件不属于当前存储目录", 403);
    }
  }
  async function safely(fn) {
    try { return await fn(); }
    catch (e) {
      if (String(e.code || "").startsWith("FILE_")) throw e;
      if (e.code === "NoSuchKey" || e.status === 404) throw fileError("MISSING", "文件尚未上传完成或已不存在", 409);
      // SDK errors contain signed request URLs/credentials; never propagate them.
      throw Object.assign(fileError("STORAGE", "文件存储服务暂不可用，请稍后重试", 503),
        { storageCode: /^[A-Za-z0-9_]+$/.test(String(e.code || "")) ? e.code : "request_failed", storageStatus: Number(e.status) || 0 });
    }
  }
  return {
    allocation(id, extension, purpose, date = new Date()) {
      ready();
      return { bucket: config.bucket, region: config.region,
        objectKey: `${config.prefix}${purpose}/${date.toISOString().slice(0, 7)}/${id}.${extension}` };
    },
    async signUpload(asset) {
      assertObject(asset);
      const date = new Date();
      const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const expiresAt = new Date(date.getTime() + config.uploadTtl * 1000).toISOString();
      const fields = {
        key: asset.objectKey, "Content-Type": asset.mimeType,
        "x-oss-signature-version": "OSS4-HMAC-SHA256",
        "x-oss-credential": `${config.accessKeyId}/${timestamp.slice(0, 8)}/${config.region}/oss/aliyun_v4_request`,
        "x-oss-date": timestamp, "x-oss-object-acl": "private",
        "x-oss-forbid-overwrite": "true", "x-oss-meta-file-id": asset.id,
        success_action_status: "200",
        ...(config.stsToken ? { "x-oss-security-token": config.stsToken } : {}),
      };
      const policy = { expiration: expiresAt, conditions: [
        { bucket: config.bucket }, ...Object.entries(fields).map(([key, value]) => ({ [key]: value })),
        ["content-length-range", asset.size, asset.size],
      ] };
      fields.policy = Buffer.from(JSON.stringify(policy)).toString("base64");
      fields["x-oss-signature"] = client.signPostObjectPolicyV4(policy, date);
      return { uploadUrl: `https://${config.bucket}.oss-${config.region}.aliyuncs.com`, fields, expiresAt };
    },
    async inspect(asset) {
      assertObject(asset);
      return safely(async () => {
        const result = await client.head(asset.objectKey);
        const h = result.res.headers;
        const prefix = await client.get(asset.objectKey, { headers: { Range: "bytes=0-511" } });
        const acl = await client.getACL(asset.objectKey);
        return { size: Number(h["content-length"]), mimeType: String(h["content-type"] || "").split(";")[0].toLowerCase(),
          etag: String(h.etag || "").replace(/"/g, ""), fileId: h["x-oss-meta-file-id"], sha256: h["x-oss-meta-sha256"], acl: acl.acl,
          bytes: Buffer.from(prefix.content).subarray(0, 512) };
      });
    },
    async signRead(asset, options = {}) {
      assertObject(asset);
      return safely(async () => {
        const filename = path.basename(String(asset.name || "file")).replace(/[\r\n"\\]/g, "_");
        const disposition = options.download ? `attachment; filename="download.${asset.extension || "bin"}"; filename*=UTF-8''${encodeURIComponent(filename)}` : "inline";
        // OSS rejects response-content-type overrides for objects that already
        // carry Content-Type. The upload has set the verified MIME type, so
        // retain it and only control inline versus download disposition.
        const url = await reader.signatureUrlV4(options.method === "HEAD" ? "HEAD" : "GET", config.readTtl,
          { queries: { "response-content-disposition": disposition } }, asset.objectKey);
        return { url, expiresAt: new Date(Date.now() + config.readTtl * 1000).toISOString() };
      });
    },
    async remove(asset) { assertObject(asset); return safely(() => client.delete(asset.objectKey)); },
    async put(asset, bytes) {
      assertObject(asset);
      return safely(async () => {
        const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        const result = await client.put(asset.objectKey, content, { headers: {
          "Content-Type": asset.mimeType, "x-oss-object-acl": "private", "x-oss-forbid-overwrite": "true",
          "x-oss-meta-file-id": asset.id, "x-oss-meta-sha256": crypto.createHash("sha256").update(content).digest("hex"),
        } });
        return { etag: result.res.headers.etag };
      });
    },
    configuration() { ready(); return { bucket: config.bucket, region: config.region, prefix: config.prefix, readDomain: config.readDomain }; },
  };
}

module.exports = { createOssStorage, readConfig, fileError };
