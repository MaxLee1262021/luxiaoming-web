"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBrowserFixture } = require("../../server/tests/fixtures/merchant-share-browser.cjs");

test("startup paints while deferred scripts load, compiles the management shell after auth, and restores sessions", {
  skip: process.env.RUN_STARTUP_BROWSER !== "1", timeout: 60000,
}, async t => {
  const fixture = await startBrowserFixture();
  const playwright = require(process.env.STARTUP_PLAYWRIGHT_MODULE || "playwright");
  const browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.STARTUP_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const output = path.resolve(__dirname, "../../../outputs/startup-performance");
  fs.mkdirSync(output, { recursive: true });
  const report = { testOnly: true, realDatabaseAccess: false, checks: [], errors: [], status: "running" };
  page.on("pageerror", error => report.errors.push(error.message));
  t.after(async () => {
    fs.writeFileSync(path.join(output, "browser.json"), JSON.stringify(report, null, 2));
    try { await browser.close(); } finally { await fixture.close(); }
  });
  const resources = [];
  page.on("request", request => { resources.push(new URL(request.url()).pathname); });
  // Register an observable compiler using Vue's runtime-compiler boundary. This
  // records actual template compilation, rather than inferring it from the DOM.
  await page.route(/\/src\/app\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), contentType: "application/javascript; charset=utf-8", body: `
      window.__startupCompiles = [];
      const startupOriginalCompiler = Vue.compile;
      Vue.registerRuntimeCompiler((template, options) => {
        window.__startupCompiles.push({ managementShell: template === window.LXM_VIEWS.app });
        return startupOriginalCompiler(template, options);
      });
      ${await response.text()}` });
  });
  await page.addInitScript(() => {
    window.__startupLoginShown = false;
    new MutationObserver(() => {
      if (document.querySelector(".login-panel")) window.__startupLoginShown = true;
    }).observe(document, { childList: true, subtree: true });
  });
  let releaseVue;
  const vueGate = new Promise(resolve => { releaseVue = resolve; });
  await page.route(/\/public\/vendor\/vue\.global(?:\.prod)?\.js(?:\?.*)?$/, async route => {
    await vueGate;
    await route.continue();
  });
  const shellCompileCount = () => page.evaluate(() => window.__startupCompiles.filter(row => row.managementShell).length);
  async function login() {
    await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
    await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator('[data-page-key="dashboard"]').waitFor();
  }
  try {
    await page.goto(fixture.url, { waitUntil: "commit" });
    await page.getByText("正在打开后台", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => typeof window.Vue), "undefined");
    report.checks.push("a visible startup state paints before the framework download finishes");
    releaseVue();
    await page.getByPlaceholder("账号", { exact: true }).waitFor();
    assert.equal(await shellCompileCount(), 0, "login must not compile the management shell and all its dialogs");
    assert.deepEqual(resources.filter(value => value.startsWith("/src/views/")).sort(), ["css", "html", "js"].map(ext => `/src/views/login/login.${ext}`).sort(), "preloaded login assets are reused once by the router");
    assert.equal(fixture.requests.filter(request => request.pathname.startsWith("/api/") && request.pathname !== "/api/health").length, 0);
    report.checks.push("login is usable without management-shell compilation or protected data reads; login preloads are reused once");
    await login();
    assert.equal(await shellCompileCount(), 1);
    await page.locator(".user-trigger").click();
    await page.getByRole("menuitem", { name: "修改密码", exact: true }).click();
    const changePassword = page.getByRole("dialog", { name: "修改密码", exact: true });
    await changePassword.getByPlaceholder("请输入当前登录密码", { exact: true }).fill("unchanged-fixture-password");
    await changePassword.getByRole("button", { name: "取消", exact: true }).click();
    await changePassword.waitFor({ state: "hidden" });
    report.checks.push("authenticated shell compiles once and its password dialog receives the existing app context");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-page-key="dashboard"]').waitFor();
    assert.equal(await page.evaluate(() => window.__startupLoginShown), false, "a valid saved session must not flash a login form");
    assert.equal(await shellCompileCount(), 1);
    report.checks.push("a saved session restores the dashboard without a login-form flash");
    await page.locator(".user-trigger").click();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await page.getByPlaceholder("账号", { exact: true }).waitFor();
    assert.equal(await page.locator(".admin-shell").count(), 0);
    await login();
    report.checks.push("logout unmounts the shell and a second login still restores the full interface");
    await page.evaluate(() => sessionStorage.setItem("lxm_admin_session_v1", JSON.stringify({ token: "expired-startup-test-token", role: "super" })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("账号", { exact: true }).waitFor();
    await page.getByText("登录已过期，请重新登录", { exact: true }).waitFor();
    assert.equal(await shellCompileCount(), 0);
    assert.equal(await page.locator(".admin-shell").count(), 0);
    report.checks.push("an expired saved session returns to usable login without compiling the management shell");
    assert.deepEqual(report.errors, []);
    await page.screenshot({ path: path.join(output, "startup-session-expired.png"), fullPage: true, animations: "disabled" });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack || String(error);
    throw error;
  } finally {
    releaseVue();
  }
});
