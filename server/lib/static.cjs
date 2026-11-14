// 静态文件服务（复用原 serve.cjs 的逻辑），同一台服务器既托管后台网页又提供 /api
const fs = require("fs");
const path = require("path");
const { gzip, createGzip } = require("node:zlib");
const { promisify } = require("node:util");
const compress = promisify(gzip);

function encodingFor(value, compressible, size) {
  const choices = new Map();
  for (const part of String(value || "").toLowerCase().split(",")) {
    const [name, ...parameters] = part.trim().split(";");
    if (!name) continue;
    const parameter = parameters.map(item => item.trim()).find(item => item.startsWith("q="));
    const quality = parameter === undefined ? 1 : Number(parameter.slice(2));
    choices.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const gzipQuality = choices.get("gzip") ?? choices.get("*") ?? 0;
  const identityQuality = choices.get("identity") ?? (choices.get("*") === 0 ? 0 : 1);
  const gzipAllowed = compressible && gzipQuality > 0;
  // Tiny files cost more to compress. Honor an explicit identity exclusion even
  // for them, and never override an encoding's explicit q=0 with a wildcard.
  if (gzipAllowed && (size >= 1024 || identityQuality === 0)
      && (!choices.has("identity") || gzipQuality >= identityQuality)) return "gzip";
  if (identityQuality > 0) return "identity";
  return gzipAllowed ? "gzip" : null;
}

function fileTag(stat) {
  // ctime also invalidates a same-size edit that preserves the previous mtime.
  return `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-${stat.ctimeMs.toString(16)}"`;
}

function unchanged(headers, tag, modifiedAt) {
  if (headers["if-none-match"] !== undefined) {
    return String(headers["if-none-match"]).split(",").some(value => {
      const candidate = value.trim();
      return candidate === "*" || candidate.replace(/^W\//, "") === tag.replace(/^W\//, "");
    });
  }
  const since = Date.parse(headers["if-modified-since"] || "");
  return Number.isFinite(since) && Math.floor(modifiedAt / 1000) * 1000 <= since;
}

module.exports = function (root) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon"
  };
  const publicDirs = new Set(["public", "src"]);
  const blockedSubdirs = new Set(["src/mock"]);
  const publicRootFiles = new Set(["index.html", "favicon.ico"]);
  const publicExtensions = new Set(Object.keys(types));
  const textExtensions = new Set([".html", ".css", ".js", ".json", ".svg"]);
  const compressedCache = new Map();
  const pendingCompression = new Map();
  const cacheLimit = 16 * 1024 * 1024;
  let cachedBytes = 0;

  async function compressedFile(file, stat, tag) {
    const cached = compressedCache.get(file);
    if (cached) {
      compressedCache.delete(file);
      if (cached.tag === tag) {
        compressedCache.set(file, cached);
        return cached.body;
      }
      cachedBytes -= cached.body.length;
    }
    const pendingKey = `${file}:${tag}`;
    if (pendingCompression.has(pendingKey)) return pendingCompression.get(pendingKey);
    // Large files or bursts use streaming compression with backpressure instead
    // of retaining whole inputs. Shared in-flight work avoids duplicate gzip jobs.
    if (stat.size > 4 * 1024 * 1024 || pendingCompression.size >= 4) return null;
    const pending = fs.promises.readFile(file).then(body => compress(body, { level: 6 })).then(body => {
      const previous = compressedCache.get(file);
      if (previous) {
        compressedCache.delete(file);
        cachedBytes -= previous.body.length;
      }
      while (cachedBytes + body.length > cacheLimit || compressedCache.size >= 128) {
        const oldest = compressedCache.keys().next().value;
        const entry = compressedCache.get(oldest);
        compressedCache.delete(oldest);
        cachedBytes -= entry.body.length;
      }
      compressedCache.set(file, { tag, body });
      cachedBytes += body.length;
      return body;
    }).finally(() => pendingCompression.delete(pendingKey));
    pendingCompression.set(pendingKey, pending);
    return pending;
  }

  function resolvePublicFile(urlPath) {
    let clean = "";
    try { clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, ""); }
    catch (_) { return { blocked: true }; }
    if (clean.includes("\0")) return { blocked: true };
    if (!clean) return { file: path.join(root, "index.html") };
    let candidate = path.resolve(root, clean);
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { blocked: true };
    const parts = relative.split(path.sep);
    if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return { blocked: true };
    const first = String(parts[0] || "").toLowerCase();
    const subdir = parts.slice(0, 2).map((part) => String(part).toLowerCase()).join("/");
    if (blockedSubdirs.has(subdir) || parts.some((part) => part.toLowerCase() === "tests") || relative.split(path.sep).join("/").toLowerCase() === "public/public-data.js") return { blocked: true };
    const rootFile = parts.length === 1 && publicRootFiles.has(first);
    const directoryFile = publicDirs.has(first) && publicExtensions.has(path.extname(relative).toLowerCase());
    if (!rootFile && !directoryFile) return { blocked: true };
    return { file: candidate };
  }

  function fail(res, status, message) {
    res.statusCode = status;
    for (const header of ["Content-Encoding", "Content-Length", "ETag", "Last-Modified"]) res.removeHeader(header);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(message);
  }

  return async function (req, res, urlPath) {
    if (req && !["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Allow", "GET, HEAD");
      return fail(res, 405, "Method not allowed");
    }
    const resolved = resolvePublicFile(urlPath || "");
    if (resolved.blocked) return fail(res, 404, "Not found");
    try {
      const candidate = resolved.file;
      const stat = await fs.promises.stat(candidate);
      if (!stat.isFile()) return fail(res, 404, "Not found");
      const ext = path.extname(candidate).toLowerCase();
      const compressible = textExtensions.has(ext);
      const headers = req?.headers || {};
      const encoding = encodingFor(headers["accept-encoding"], compressible, stat.size);
      if (compressible) {
        const vary = String(res.getHeader("Vary") || "").split(",").map(value => value.trim()).filter(Boolean);
        if (!vary.some(value => value === "*" || value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
        res.setHeader("Vary", vary.join(", "));
      }
      if (!encoding) return fail(res, 406, "No acceptable encoding");
      const tag = fileTag(stat);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", types[ext] || "application/octet-stream");
      // Filenames are not hashed: cache bytes, but revalidate after every reload
      // so a release or local edit becomes visible without a stale-cache window.
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      res.setHeader("ETag", tag);
      res.setHeader("Last-Modified", stat.mtime.toUTCString());
      if (unchanged(headers, tag, stat.mtimeMs)) {
        res.statusCode = 304;
        return res.end();
      }
      let body;
      if (encoding === "gzip") {
        body = await compressedFile(candidate, stat, tag);
        res.setHeader("Content-Encoding", "gzip");
        if (body) res.setHeader("Content-Length", body.length);
      } else res.setHeader("Content-Length", stat.size);
      if (req && req.method === "HEAD") return res.end();
      if (body) return res.end(body);
      const stream = fs.createReadStream(candidate);
      const onError = error => {
        if (res.headersSent) res.destroy(error);
        else fail(res, error.code === "ENOENT" ? 404 : 500, "Unable to read file");
      };
      stream.once("error", onError);
      if (encoding === "gzip") {
        const compressor = createGzip({ level: 6 });
        compressor.once("error", onError);
        res.once("close", () => { stream.destroy(); compressor.destroy(); });
        stream.pipe(compressor).pipe(res);
      } else {
        res.once("close", () => stream.destroy());
        stream.pipe(res);
      }
    } catch (error) {
      fail(res, error.code === "ENOENT" || error.code === "ENOTDIR" ? 404 : 500, "Unable to read file");
    }
  };
};
