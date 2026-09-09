"use strict";

const path = require("node:path");
const { runSmoke } = require("../server/tests/api-smoke.cjs");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = path.resolve(argv[++i]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write([
    "后台 API smoke",
    "",
    "Usage:",
    "  node scripts/api-smoke.cjs [--root <project-root>] [--json]",
    "",
    "The runner creates an isolated synthetic JSON fixture, starts a local server,",
    "checks auth/RBAC/redaction/persistence, and probes Redis/MySQL fail-closed paths.",
  ].join("\n") + "\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = await runSmoke(options);
  if (options.json) {
    process.stdout.write(JSON.stringify({
      passed: report.passed,
      skipped: report.skipped,
      failures: report.failures,
    }, null, 2) + "\n");
  } else {
    for (const item of report.passed) process.stdout.write(`[PASS] ${item.name}\n`);
    for (const item of report.skipped) process.stdout.write(`[SKIP] ${item.name}: ${item.detail}\n`);
    for (const item of report.failures) process.stdout.write(`[FAIL] ${item.name}: ${item.detail}\n`);
    process.stdout.write(`\n${report.passed.length} passed, ${report.skipped.length} skipped, ${report.failures.length} failed\n`);
  }
  process.exitCode = report.failures.length ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`api-smoke failed: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
