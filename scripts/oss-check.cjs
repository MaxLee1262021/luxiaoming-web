"use strict";

// No secret, policy, Authorization header or signed URL is printed by this tool.
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { createOssStorage, readConfig } = require("../server/lib/ossStorage.cjs");
const { detectType } = require("../server/lib/fileService.cjs");

async function main() {
  const config = readConfig();
  const OSS = require("ali-oss");
  const client = new OSS({ ...config, region: `oss-${config.region}`, secure: true, authorizationV4: true });
  const info = await client.getBucketInfo(config.bucket);
  const cors = await client.getBucketCORS(config.bucket).catch(() => ({ rules: [] }));
  const report = { bucket: config.bucket, region: config.region,
    acl: info.bucket.AccessControlList && info.bucket.AccessControlList.Grant,
    blockPublicAccess: info.bucket.BlockPublicAccess, corsRuleCount: cors.rules.length, writeTest: false };
  if (process.argv.includes("--write-test")) {
    const adapter = createOssStorage({ config });
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const id = `file_${crypto.randomBytes(20).toString("hex")}`;
    const asset = { id, name: "oss-check.png", extension: "png", mimeType: "image/png", size: bytes.length, ...adapter.allocation(id, "png", "checks") };
    let uploaded = false;
    try {
      const signed = await adapter.signUpload(asset);
      const makeForm = () => { const form = new FormData(); for (const [key, value] of Object.entries(signed.fields)) form.append(key, value); form.append("file", new Blob([bytes], { type: asset.mimeType }), asset.name); return form; };
      const upload = await fetch(signed.uploadUrl, { method: "POST", body: makeForm(), signal: AbortSignal.timeout(30000) });
      if (upload.status !== 200) {
        const body = await upload.text();
        throw Object.assign(new Error("upload failed"), { code: (body.match(/<Code>([^<]+)<\/Code>/) || [])[1] || "UPLOAD_FAILED", status: upload.status });
      }
      uploaded = true;
      const inspected = await adapter.inspect(asset);
      if (inspected.size !== bytes.length || inspected.acl !== "private" || detectType(inspected.bytes) !== "image/png" || inspected.fileId !== id) throw new Error("VERIFY_FAILED");
      const read = await adapter.signRead(asset);
      const download = await fetch(read.url, { signal: AbortSignal.timeout(30000) });
      if (!download.ok || !Buffer.from(await download.arrayBuffer()).equals(bytes)) throw new Error("READ_FAILED");
      const anonymous = await fetch(`${signed.uploadUrl}/${asset.objectKey}`, { signal: AbortSignal.timeout(30000) });
      if (anonymous.status !== 403) throw new Error("ANONYMOUS_ACCESS_NOT_BLOCKED");
      if (anonymous.body) await anonymous.body.cancel();
      const duplicate = await fetch(signed.uploadUrl, { method: "POST", body: makeForm(), signal: AbortSignal.timeout(30000) });
      if (duplicate.status !== 409) throw new Error("OVERWRITE_NOT_BLOCKED");
      if (duplicate.body) await duplicate.body.cancel();
      report.writeTest = true;
      report.verified = ["V4 POST upload", "HEAD, file signature and private ACL", "signed download bytes", "anonymous read denied", "overwrite denied"];
    } finally { if (uploaded) { await adapter.remove(asset); report.testObjectRemoved = true; } }
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || "CHECK_FAILED", storageCode: error.storageCode, status: error.storageStatus || error.status || error.statusCode || null })); process.exitCode = 1; });
module.exports = { main };
