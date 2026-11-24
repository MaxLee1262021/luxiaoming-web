"use strict";

// Optional synthetic comparison; not a production capacity/SQL benchmark.
// Run with --expose-gc and --baseline <saved mysqlSource.cjs>, optionally --rows.
// Each variant runs in its own process with identical documents and a bounded
// simulated pool. No credentials, server, writes or application workers run.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const { fixture } = require("./mysql-bounded-reads-fixture.cjs");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

async function run() {
  const baseline = argument("--baseline");
  if (!baseline) throw new Error("--baseline must name the saved original mysqlSource.cjs");
  const count = Math.max(1, Math.min(Number(argument("--rows", "10000")), 100000));
  const variant = argument("--variant");
  if (!variant) {
    const results = [];
    for (const name of ["baseline", "current"]) {
      const result = spawnSync(process.execPath, ["--expose-gc", __filename, "--baseline", baseline, "--rows", String(count), "--variant", name], { encoding: "utf8", timeout: 240000 });
      if (result.status !== 0) throw new Error(result.stderr || "comparison child failed");
      results.push(JSON.parse(result.stdout));
    }
    process.stdout.write(JSON.stringify({ kind: "synthetic SQL fixture; not measured production latency", results }, null, 2) + "\n");
    return;
  }
  let createSource = require("../lib/mysqlSource.cjs");
  if (variant === "baseline") {
    const filename = path.resolve(__dirname, "../lib/mysqlSource.cjs");
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(fs.readFileSync(baseline, "utf8"), filename);
    createSource = compiled.exports;
  }
  let peakHeap = 0, peakRss = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  };
  const orders = Array.from({ length: count }, (_, index) => ({
    id: `order-${String(index).padStart(7, "0")}`, orderNo: `SO${index}`, customer: `customer ${index}`, status: "confirmed",
    products: [{ id: "package", type: "package", name: "recorded package", quantity: 1, price: 100 }],
    paymentRecords: [{ id: `pay-${index}`, phase: "deposit", amount: 20, status: "confirmed" }],
    followRecords: [{ note: "contacted customer", createTime: "2026-11-23 10:00:00" }],
    statusLogs: [{ action: "deposit confirmed" }],
    extension: Object.fromEntries(Array.from({ length: 20 }, (_, leaf) => [`leaf${leaf}`, `record-${index}-leaf-${leaf}`]))
  }));
  const f = fixture({ orders }, { createSource, batchSize: 500, connectionLimit: 10, poolLimit: 10, delayMs: 1, captureQueries: false, observe: sample });
  await f.source.ensureSchema();
  global.gc?.();
  const start = process.memoryUsage();
  sample();
  const timer = setInterval(sample, 5);
  const begin = process.hrtime.bigint();
  const result = await f.source.listMany(["orders"]);
  const durationMs = Number(process.hrtime.bigint() - begin) / 1e6;
  sample(); clearInterval(timer);
  const checksum = result.orders.reduce((sum, row) => sum + row.extension.leaf0.length + row.products.length + row.paymentRecords.length + row.followRecords.length, 0);
  process.stdout.write(JSON.stringify({ variant, rows: result.orders.length, checksum, durationMs: Math.round(durationMs), baselineHeapMiB: +(start.heapUsed / 1048576).toFixed(1), peakHeapMiB: +(peakHeap / 1048576).toFixed(1), peakRssMiB: +(peakRss / 1048576).toFixed(1), queryCount: f.stats.reads, peakConnections: f.stats.peak }) + "\n");
}

run().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
