"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const targets = [
  "src/app.js",
  "src/router/index.js",
  "src/layout/app-shell.js",
  "src/config/business-config.js",
  "src/config/api.js",
  "src/api/cloud.js",
  "server/lib/api.cjs",
  "server/lib/rpc.cjs",
  "server/lib/orderWorkflow.cjs",
  ...fs.readdirSync(path.join(root, "src", "app"))
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join("src", "app", name)),
];

for (const target of targets) {
  const absolute = path.join(root, target);
  if (!fs.existsSync(absolute)) continue;
  const result = spawnSync(process.execPath, ["--check", absolute], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write(`Syntax check passed for ${targets.length} modules.\n`);
