"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBrowserFixture } = require("../../server/tests/fixtures/merchant-share-browser.cjs");

test("real browser loads only visited pages and recovers a timed out page without refreshing the app", {
  skip: process.env.RUN_ROUTER_BROWSER !== "1", timeout: 90000,
}, async t => {
  const fixture = await startBrowserFixture();
  const playwright = require(process.env.ROUTER_PLAYWRIGHT_MODULE || "playwright");
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.ROUTER_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  const output = path.resolve(__dirname, "../../../outputs/router-loading");
  fs.mkdirSync(output, { recursive: true });
  const report = { testOnly: true, realDatabaseAccess: false, status: "running", checks: [], pageErrors: [], routerWarnings: [] };
  t.after(async () => {
    fs.writeFileSync(path.join(output, "browser.json"), JSON.stringify(report, null, 2));
    try { await browser.close(); } finally { await fixture.close(); }
  });
  async function newPage() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => report.pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "warning" && message.text().startsWith("[router]")) report.routerWarnings.push(message.text()); });
    return page;
  }
  async function login(page) {
    await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
    await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator('[data-menu-key="reconciliation"]').waitFor();
  }
  const scriptPattern = /\/src\/views\/finance\/reconciliation\/reconciliation\.js(?:\?.*)?$/;
  const routePage = '[data-page-key="reconciliation"]';
  try {
    const page = await newPage();
    const resources = [];
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/src/views/")) resources.push(pathname);
    });
    let attempts = 0;
    await page.route(scriptPattern, async route => {
      attempts += 1;
      report.timeoutScriptAttempts = attempts;
      if (attempts === 1) return; // Keep the first transfer stalled past the loader's timeout.
      await route.continue();
    });
    await page.goto(fixture.url);
    await page.getByPlaceholder("账号", { exact: true }).waitFor();
    assert.deepEqual(resources.slice().sort(), ["css", "html", "js"].map(ext => `/src/views/login/login.${ext}`).sort());
    report.checks.push("startup requests only the login page's three resources");
    await login(page);
    const start = Date.now();
    await page.locator('[data-menu-key="reconciliation"]').click();
    await page.locator(`${routePage} h2`).filter({ hasText: "月度分账对账管理" }).waitFor({ timeout: 30000 });
    report.timeoutRecoveryMs = Date.now() - start;
    assert.equal(attempts, 2);
    assert.ok(report.timeoutRecoveryMs >= 9500, "the stalled transfer exercises the 10-second timeout");
    assert.equal(await page.locator('script[data-page-script$="/reconciliation.js"]').count(), 1);
    const styleState = await page.evaluate(() => {
      const links = [...document.head.querySelectorAll("link")];
      const own = links.filter(link => String(link.dataset.pageStyle || "").endsWith("/reconciliation.css"));
      const shared = document.head.querySelector("link[data-admin-ops]");
      return { count: own.length, beforeShared: links.indexOf(own[0]) < links.indexOf(shared) };
    });
    assert.deepEqual(styleState, { count: 1, beforeShared: true });
    report.checks.push("a genuinely stalled script times out, retries once, and renders the actual reconciliation template with one script/style node");
    const before = resources.length;
    await page.locator('[data-menu-key="dashboard"]').click();
    await page.locator('[data-page-key="dashboard"]').waitFor();
    await page.locator('[data-menu-key="reconciliation"]').click();
    await page.locator(`${routePage} h2`).waitFor();
    assert.equal(resources.slice(before).filter(resource => resource.includes("/finance/reconciliation/")).length, 0);
    await page.screenshot({ path: path.join(output, "reconciliation-recovered.png"), fullPage: true, animations: "disabled" });
    report.checks.push("revisiting a successful page reuses its loaded resources");

    const failed = await newPage();
    let rejectScript = true;
    let failedAttempts = 0;
    let documentLoads = 0;
    failed.on("request", request => { if (request.isNavigationRequest() && request.frame() === failed.mainFrame()) documentLoads += 1; });
    await failed.route(scriptPattern, async route => {
      failedAttempts += 1;
      if (rejectScript) await route.abort("timedout");
      else await route.continue();
    });
    await failed.goto(fixture.url);
    await login(failed);
    await failed.locator('[data-menu-key="reconciliation"]').click();
    const error = failed.locator('.lxm-content > .empty-state[role="alert"]');
    await error.waitFor();
    assert.equal(failedAttempts, 2);
    assert.match(await error.innerText(), /页面加载失败.*网络连接/);
    assert.equal(await failed.locator('script[data-page-script$="/reconciliation.js"]').count(), 0);
    await failed.locator('[data-menu-key="dashboard"]').click();
    await failed.locator('[data-page-key="dashboard"]').waitFor();
    await failed.locator('[data-menu-key="reconciliation"]').click();
    await error.waitFor();
    assert.equal(failedAttempts, 4);
    rejectScript = false;
    await error.getByRole("button", { name: "重新加载", exact: true }).click();
    await failed.locator(`${routePage} h2`).filter({ hasText: "月度分账对账管理" }).waitFor();
    assert.equal(failedAttempts, 5);
    assert.equal(documentLoads, 1, "manual recovery preserves the current app and authenticated session");
    report.checks.push("repeated failures show retry UI, leave other menus usable, and recover in place after the connection returns");
    assert.deepEqual(report.pageErrors, []);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack || String(error);
    report.pageStates = await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.evaluate(() => ({
      currentPage: document.querySelector(".lxm-content")?.innerText.slice(0, 500),
      scripts: [...document.querySelectorAll("script[data-page-script]")].map(script => ({ src: script.src, key: script.dataset.pageScript })),
    }))));
    throw error;
  }
});
