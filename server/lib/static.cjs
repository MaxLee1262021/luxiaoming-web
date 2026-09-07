// 静态文件服务（复用原 serve.cjs 的逻辑），同一台服务器既托管后台网页又提供 /api
const fs = require("fs");
const path = require("path");

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
    if (blockedSubdirs.has(subdir)) return { blocked: true };
    const rootFile = parts.length === 1 && publicRootFiles.has(first);
    const directoryFile = publicDirs.has(first) && publicExtensions.has(path.extname(relative).toLowerCase());
    if (!rootFile && !directoryFile) return { blocked: true };
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return { missing: true };
    return { file: candidate };
  }

  return function (req, res, urlPath) {
    if (req && !["GET", "HEAD"].includes(req.method)) {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      return res.end("Method not allowed");
    }
    const resolved = resolvePublicFile(urlPath || "");
    if (resolved.blocked || resolved.missing) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end("Not found");
    }
    const candidate = resolved.file;
    const ext = path.extname(candidate).toLowerCase();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", types[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    if (req && req.method === "HEAD") return res.end();
    fs.createReadStream(candidate)
      .on("error", () => {
        res.statusCode = 500;
        res.end("Server error");
      })
      .pipe(res);
  };
};
