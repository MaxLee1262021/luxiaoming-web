const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

if (process.argv.includes("--check-only")) {
  const entry = path.join(root, "index.html");
  if (!fs.existsSync(entry)) {
    console.error("index.html not found");
    process.exit(1);
  }
  console.log("Static admin project structure check passed.");
  process.exit(0);
}

// Keep `npm run dev` on the same observable integrated server as production.
// A second bootstrap here had drifted from server/index.cjs over time.
if (!process.env.HOST) process.env.HOST = "127.0.0.1";
require(path.join(root, "server", "index.cjs"));
