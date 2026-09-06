"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { runSmoke } = require("./api-smoke.cjs");

test("Project Hub v1 API smoke contract", async () => {
  const root = process.env.LXM_SMOKE_ROOT ? path.resolve(process.env.LXM_SMOKE_ROOT) : undefined;
  const report = await runSmoke({ root });
  assert.equal(
    report.failures.length,
    0,
    report.failures.map((item) => `${item.name}: ${item.detail}`).join("\n"),
  );
  assert.ok(report.passed.length > 0, "smoke must execute at least one check");
});
