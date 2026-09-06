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
  return function (req, res, urlPath) {
    const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
    let candidate = path.resolve(root, clean || "index.html");
    if (!candidate.startsWith(root)) candidate = path.join(root, "index.html");
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      candidate = path.join(root, "index.html");
    }
    const ext = path.extname(candidate).toLowerCase();
    res.setHeader("Content-Type", types[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(candidate)
      .on("error", () => {
        res.statusCode = 500;
        res.end("Server error");
      })
      .pipe(res);
  };
};
