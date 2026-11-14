"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSvcMemoryStore } = require("../../server/lib/svcStore.cjs");
const { createSvcWorkbench } = require("../../server/lib/svcWorkbench.cjs");
const benefit = require("../../server/lib/svcCommission.cjs");
const B = require("../../server/lib/svcBenefit.cjs");
const { startBrowserFixture } = require("../../server/tests/fixtures/merchant-share-browser.cjs");

test("admin style uses one overview, server countdown polling and independent My Orders reservations", {
  skip: process.env.RUN_SVC_PERF_BROWSER !== "1", timeout: 60000,
}, async t => {
  const now = new Date(), clock = () => new Date(), stamp = value => B.localTime(value), ago = minutes => stamp(now.getTime() - minutes * 60000);
  const store = createSvcMemoryStore({
    staff: [{ id: "qa-s1", account_id: "qa-super", name: "QA客服", staff_status: "active" }],
    configs: [{ id: "1", ver: 1, hold_minutes: 60, observe_days: 7, eff_at: "2026-01-01 00:00:00", quiet_start: "22:00", quiet_end: "09:00" }], rules: [],
    orders: [
      { id: "o1", order_no: "QA-PERF-CLAIMED", customer_openid: "oSyntheticPerf1", customer_name: "待确认客户", category: "photo", product_name: "测试照片", net_amount_fen: 10000, paid_at: ago(10), service_managed: true, service_status: "claimed", assignee_id: "qa-s1" },
      { id: "o2", order_no: "QA-PERF-RESERVED", customer_openid: "oSyntheticPerf2", customer_name: "预占客户", category: "combo", product_name: "测试套餐", net_amount_fen: 20000, paid_at: ago(9), service_managed: true, service_status: "reserved", reserve_staff_id: "qa-s1" },
      { id: "o3", order_no: "QA-PERF-POOL", customer_openid: "oSyntheticPerf3", customer_name: "公共池客户", category: "peripheral", product_name: "测试相框", net_amount_fen: 3000, paid_at: ago(8), service_managed: true, service_status: "new" },
      { id: "o4", order_no: "QA-PERF-HOLDING", customer_openid: "oSyntheticPerf4", customer_name: "夜间预占客户", category: "photo", product_name: "夜间测试照片", net_amount_fen: 10000, paid_at: ago(7), service_managed: true, service_status: "reserved", reserve_staff_id: "qa-s1" },
    ],
    reserves: [
      { id: "1", order_no: "QA-PERF-RESERVED", staff_id: "qa-s1", status: "started", reserve_start_at: ago(9), reserve_expire_at: stamp(now.getTime() + 51 * 60000) },
      { id: "2", order_no: "QA-PERF-HOLDING", staff_id: "qa-s1", status: "holding", is_quiet: 1, reserve_start_at: stamp(now.getTime() + 8 * 3600000), reserve_expire_at: stamp(now.getTime() + 9 * 3600000) },
    ],
  });
  const modules = { store, workbench: createSvcWorkbench({ store, clock, benefit }), commission: benefit.createSvcCommission({ store, clock }) };
  const fixture = await startBrowserFixture({ customerService: modules });
  const playwright = require(process.env.SVC_PLAYWRIGHT_MODULE || "playwright");
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.SVC_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1512, height: 1000 }, timezoneId: "Asia/Shanghai" });
  const report = { testOnly: true, realDatabaseAccess: false, status: "running", checks: [], pageErrors: [] };
  const out = path.resolve(__dirname, "../../../outputs/svc-workbench-performance"); fs.mkdirSync(out, { recursive: true });
  const requests = []; page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/kf/")) requests.push({ pathname: url.pathname, search: url.search }); });
  page.on("pageerror", error => report.pageErrors.push(error.message)); page.setDefaultTimeout(10000);
  t.after(async () => { fs.writeFileSync(path.join(out, "browser.json"), JSON.stringify(report, null, 2)); try { await browser.close(); } finally { await fixture.close(); } });
  let serverSeconds = 1450, pollCount = 0, activePolls = 0, maximumPolls = 0, slowPoll = false;
  await page.route("**/api/kf/orders/reserved?**", async route => {
    pollCount++; activePolls++; maximumPolls = Math.max(maximumPolls, activePolls);
    try {
      if (slowPoll) await page.waitForTimeout(1500);
      const response = await route.fetch(), payload = await response.json();
      for (const row of payload.data.list || []) if (row.order_no === "QA-PERF-RESERVED") row.left_seconds = serverSeconds;
      await route.fulfill({ response, json: payload });
    } catch (error) { if (!/closed|aborted|disposed|ERR_FAILED/i.test(String(error.message))) throw error; }
    finally { activePolls--; }
  });
  const until = async (check, label) => { for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(50); } throw new Error("Timed out: " + label); };
  const overviewResponse = (mode, tab) => page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/kf/workbench/overview" && url.searchParams.get("mode") === mode && (!tab || url.searchParams.get("tab") === tab); });
  try {
    await page.goto(fixture.url);
    await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
    await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByPlaceholder("账号", { exact: true }).waitFor({ state: "hidden" });
    const overview = overviewResponse("workbench");
    await page.locator('[data-menu-key="svcWorkbench"]').click(); assert.equal((await overview).status(), 200);
    await page.locator(".kf-metrics").waitFor(); await page.getByRole("button", { name: "QA-PERF-CLAIMED", exact: true }).waitFor();
    assert.equal(requests.filter(request => request.pathname === "/api/kf/workbench/overview").length, 1);
    assert.equal(requests.some(request => /workbench\/(?:summary|todo)$/.test(request.pathname)), false);
    assert.equal(await page.locator(".kf-reserve-panel").count(), 1, "dashboard retains its original independent reservation panel");
    await until(() => pollCount >= 1, "one-second server poll begins");
    report.checks.push("dashboard uses one overview for summary/todo/reservations, then polls server values each second");
    await page.screenshot({ path: path.join(out, "workbench-desktop.png"), fullPage: true, animations: "disabled" });

    const beforeIntake = requests.length, intakeResponse = overviewResponse("intake", "all");
    await page.locator('[data-menu-key="svcIntake"]').click(); assert.equal((await intakeResponse).status(), 200);
    await page.getByRole("button", { name: "QA-PERF-POOL", exact: true }).waitFor();
    await until(() => requests.slice(beforeIntake).some(request => request.pathname === "/api/kf/rebuy/bindings"), "binding cards read");
    assert.equal(requests.slice(beforeIntake).filter(request => request.pathname === "/api/kf/workbench/overview").length, 1);
    assert.equal(await page.locator(".kf-reserve-panel").count(), 0, "public pool must not contain reservation actions");
    const mineResponse = overviewResponse("intake", "mine");
    await page.getByRole("tab", { name: "我的订单", exact: true }).click(); assert.equal((await mineResponse).status(), 200);
    await page.locator(".kf-reserve-panel").waitFor();
    await page.getByRole("button", { name: "QA-PERF-CLAIMED", exact: true }).waitFor();
    const reservations = page.locator(".kf-reserve-panel"), active = reservations.locator("tr").filter({ hasText: "QA-PERF-RESERVED" }), holding = reservations.locator("tr").filter({ hasText: "QA-PERF-HOLDING" });
    assert.equal(await reservations.getByRole("button", { name: /^QA-PERF-/ }).count(), 2);
    assert.equal(await page.locator(".kf-panel > .el-table").first().getByRole("button", { name: "QA-PERF-RESERVED", exact: true }).count(), 0);
    await until(async () => await active.locator(".kf-countdown strong").innerText() === "24:10", "server-supplied countdown");
    assert.equal(await holding.locator(".kf-countdown strong").innerText(), "--:--");
    const beforeSame = pollCount; await until(() => pollCount >= beforeSame + 2, "successive one-second reads");
    assert.equal(await active.locator(".kf-countdown strong").innerText(), "24:10", "unchanged server seconds must not decrement using local elapsed time");
    serverSeconds = 800; await until(async () => await active.locator(".kf-countdown strong").innerText() === "13:20", "updated server value");
    assert.equal(await holding.locator(".kf-countdown strong").innerText(), "--:--");
    report.checks.push("pool/mine use one overview per tab; bindings are an explicit additional read; reservations appear only in My Orders");
    report.checks.push("display follows authoritative left_seconds across one-second reads and freezes holding rows");

    slowPoll = true; const beforeSlow = pollCount; await until(() => pollCount > beforeSlow && activePolls === 1, "slow read starts");
    await page.waitForTimeout(1200); assert.equal(activePolls, 1); assert.equal(maximumPolls, 1, "interval ticks cannot overlap a pending reservation request");
    slowPoll = false; await until(() => activePolls === 0, "slow read completes");
    report.checks.push("slow reservation responses never overlap another poll");

    // This controls the document's public visibility API, without reaching into
    // Vue instances or bypassing the real mounted page and request transport.
    await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }));
    const beforeHidden = pollCount; await page.waitForTimeout(1400); assert.equal(pollCount, beforeHidden);
    await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }));
    await until(() => pollCount > beforeHidden, "visible polling resumes");
    report.checks.push("hidden document pauses polling and visible document resumes it");
    await page.screenshot({ path: path.join(out, "intake-mine-desktop.png"), fullPage: true, animations: "disabled" });
    assert.deepEqual(report.pageErrors, []); report.status = "passed";
  } catch (error) { report.status = "failed"; report.failure = String(error.message).slice(0, 1000); throw error; }
});
