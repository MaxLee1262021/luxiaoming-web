"use strict";
// Optional real-browser regression; the ordinary unit suite never launches a
// browser. Persistence, accounts and QR assets remain TEST_ONLY fixture data.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { startBrowserFixture } = require("./fixtures/merchant-share-browser.cjs");

test("real browser places merchant field errors inline, preserves drafts and fits the refund-window label on narrow screens", {
  skip: process.env.RUN_MERCHANT_SHARE_BROWSER !== "1", timeout: 60000,
}, async t => {
  const playwright = require(process.env.SHARE_QA_PLAYWRIGHT_MODULE || "playwright");
  const directory = path.resolve(__dirname, "../../..", ".codex-tmp/merchant-share-qa");
  fs.mkdirSync(directory, { recursive: true });
  const result = { testOnly: true, startedAt: new Date().toISOString(), status: "running", checks: [], pageErrors: [], databaseAccess: false };
  const fixture = await startBrowserFixture();
  let browser;
  t.after(async () => { try { if (browser) await browser.close(); } finally { await fixture.close(); } });
  try {
    browser = await playwright.chromium.launch({ headless: true,
      ...(process.env.SHARE_QA_BROWSER_EXECUTABLE ? { executablePath: process.env.SHARE_QA_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => result.pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
    await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "配置列表", exact: true }).click();
    await page.getByRole("button", { name: "新增商家", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const nameField = dialog.locator(".el-form-item").filter({ has: page.getByText("商家名称", { exact: true }) });
    const phoneField = dialog.locator(".el-form-item").filter({ has: page.getByText("联系电话", { exact: true }) });
    await dialog.getByLabel("联系人", { exact: true }).fill("QA待保留联系人");
    await dialog.getByRole("button", { name: "保存并生成商家码", exact: true }).click();
    await nameField.locator(".el-form-item__error").waitFor({ state: "visible" });
    result.nameError = await nameField.locator(".el-form-item__error").innerText();
    assert.match(result.nameError, /请填写商家名称|商家名称.*必填/);
    assert.equal(await dialog.getByLabel("联系人", { exact: true }).inputValue(), "QA待保留联系人");
    result.checks.push({ name: "missing name is marked under its own form item", passed: true });
    await nameField.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, "16-inline-name-error.png"), fullPage: true, animations: "disabled" });

    await dialog.getByLabel("商家名称", { exact: true }).fill("QA行内校验草稿");
    await dialog.getByLabel("联系电话", { exact: true }).fill("12345");
    await dialog.getByLabel("登录账号", { exact: true }).fill("qa-inline-draft");
    await dialog.getByRole("button", { name: "保存并生成商家码", exact: true }).click();
    await phoneField.locator(".el-form-item__error").waitFor({ state: "visible" });
    result.phoneError = await phoneField.locator(".el-form-item__error").innerText();
    assert.match(result.phoneError, /11位手机号/);
    await nameField.locator(".el-form-item__error").waitFor({ state: "hidden" });
    assert.equal(await nameField.locator(".el-form-item__error").isVisible(), false, "correcting the name clears its visible field error");
    assert.equal(await dialog.getByLabel("商家名称", { exact: true }).inputValue(), "QA行内校验草稿");
    assert.equal(await dialog.getByLabel("联系人", { exact: true }).inputValue(), "QA待保留联系人");
    assert.equal(await dialog.getByLabel("登录账号", { exact: true }).inputValue(), "qa-inline-draft");
    assert.equal(await dialog.getByLabel("联系电话", { exact: true }).inputValue(), "12345");
    assert.equal(fixture.requests.filter(request => request.method === "POST" && request.pathname === "/api/share/merchants").length, 0, "invalid forms never invoke onboarding");
    result.checks.push({ name: "invalid phone is marked under its own form item and other inputs survive", passed: true });
    await phoneField.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, "17-inline-phone-error.png"), fullPage: true, animations: "disabled" });

    await page.setViewportSize({ width: 390, height: 844 });
    const windowInput = dialog.getByLabel("平台退款窗口期（天）", { exact: true });
    assert.equal(await windowInput.inputValue(), "3");
    const label = dialog.locator("label").filter({ hasText: /^平台退款窗口期（天）$/ });
    await label.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, "18-refund-window-label-mobile.png"), fullPage: true, animations: "disabled" });
    result.windowLabel = await label.evaluate(node => { const box = node.getBoundingClientRect(); return { text: node.textContent, left: box.left, right: box.right, width: box.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }; });
    assert.ok(result.windowLabel.left >= 0 && result.windowLabel.right <= 390);
    assert.ok(result.windowLabel.scrollWidth <= result.windowLabel.clientWidth);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    result.checks.push({ name: "refund window label and default three days fit the 390px viewport", passed: true });
    assert.deepEqual(result.pageErrors, []);
    result.status = "passed";
  } catch (error) { result.status = "failed"; result.failure = String(error.message || error).slice(0, 1500); throw error; }
  finally {
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(directory, "browser-inline-validation.json"), JSON.stringify(result, null, 2));
  }
});

test("real browser shows global share settings read-only for super and hides them from merchant sessions", {
  skip: process.env.RUN_MERCHANT_SHARE_BROWSER !== "1", timeout: 60000,
}, async t => {
  const playwright = require(process.env.SHARE_QA_PLAYWRIGHT_MODULE || "playwright");
  const directory = path.resolve(__dirname, "../../..", ".codex-tmp/merchant-share-qa");
  fs.mkdirSync(directory, { recursive: true });
  const result = { testOnly: true, startedAt: new Date().toISOString(), status: "running", checks: [], pageErrors: [], databaseAccess: false, externalServiceAccess: false };
  const fixture = await startBrowserFixture();
  let browser;
  t.after(async () => { try { if (browser) await browser.close(); } finally { await fixture.close(); } });
  try {
    browser = await playwright.chromium.launch({ headless: true,
      ...(process.env.SHARE_QA_BROWSER_EXECUTABLE ? { executablePath: process.env.SHARE_QA_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    page.on("pageerror", error => result.pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
    await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "配置列表", exact: true }).click();
    const settingsResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/share/settings" && response.request().method() === "GET");
    await page.getByRole("button", { name: "规则说明", exact: true }).click();
    const response = await settingsResponse; assert.equal(response.status(), 200);
    const body = await response.json(); const actual = body.data?.data ?? body.data ?? body;
    const dialog = page.getByRole("dialog", { name: "商家分成规则" });
    const settings = dialog.locator('section[aria-label="全局分成参数只读区域"]');
    await settings.locator("dl dt").first().waitFor({ state: "visible" });
    assert.equal(await settings.locator("dl dt").count(), 9);
    result.displayedParameters = await settings.locator("dl").evaluate(node => Object.fromEntries(Array.from(node.querySelectorAll("dt")).map(label => [label.textContent.trim(), label.nextElementSibling.textContent.trim()])));
    const displayed = result.displayedParameters;
    assert.equal(displayed["启用日配置状态"], actual.enabled ? "已配置" : "未配置");
    assert.equal(displayed["默认客服订单分成时效"], undefined);
    assert.equal(displayed["默认平台退款窗口期"], `${actual.defaultRefundWindowDays} 天`);
    assert.equal(displayed["客服候选商家上限"], undefined);
    assert.equal(displayed["重复扫码去重窗口"], `${actual.scanDedupSeconds} 秒`);
    assert.equal(displayed["判定失败最大重试次数"], `${actual.judgeRetryMax} 次`);
    assert.equal(displayed["客服点击归因窗口"], Number(actual.csAttrDays) === 0 ? "仅本次会话" : `${actual.csAttrDays} 天`);
    assert.equal(displayed["判定规则版本"], actual.engineVersion);
    assert.equal(displayed["电话告警配置"], actual.phoneAlertConfigured ? "已配置" : "未配置");
    assert.equal(displayed["运营提醒配置"], actual.operationalAlertConfigured ? "已配置" : "未配置");
    assert.equal(displayed["正式启用时间（北京时间）"], "2026-01-01 08:00:00");
    assert.doesNotMatch(await settings.innerText(), /当前已启用|发送成功|https?:\/\//);
    result.checks.push({ name: "super opens rule help and all 9 current HTTP parameters match their business display", passed: true });
    result.checks.push({ name: "enabled and alert flags describe configuration, not launch activation or notification delivery", passed: true });
    assert.equal(await settings.locator("input,select,textarea,[contenteditable=true]").count(), 0);
    assert.deepEqual(await settings.getByRole("button").allTextContents(), ["刷新参数"]);
    result.checks.push({ name: "parameter area has no editable fields or write action", passed: true });
    await settings.scrollIntoViewIfNeeded();
    await settings.screenshot({ path: path.join(directory, "19-global-settings-readonly.png"), animations: "disabled" });

    const merchantContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
    const merchant = await merchantContext.newPage(); merchant.setDefaultTimeout(7000);
    merchant.on("pageerror", error => result.pageErrors.push(error.message));
    await merchant.goto(fixture.url);
    await merchant.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.merchant.account);
    await merchant.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.merchant.password);
    await merchant.getByRole("button", { name: "登录", exact: true }).click();
    await merchant.getByRole("heading", { name: "我的分成", exact: true }).waitFor({ state: "visible" });
    assert.equal(await merchant.locator('section[aria-label="全局分成参数只读区域"]').count(), 0);
    assert.equal(await merchant.getByRole("button", { name: "规则说明", exact: true }).count(), 0);
    result.merchantSettingsStatus = await merchant.evaluate(async () => (await window.LXM_HTTP.request("/api/share/settings")).status);
    assert.equal(result.merchantSettingsStatus, 403);
    result.checks.push({ name: "merchant page has no global parameter area and authenticated settings access is denied with 403", passed: true });
    assert.equal(fixture.requests.filter(request => request.pathname === "/api/share/settings" && request.method !== "GET").length, 0);
    assert.deepEqual(result.pageErrors, []); result.status = "passed";
  } catch (error) { result.status = "failed"; result.failure = String(error.message || error).slice(0, 1500); throw error; }
  finally { result.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(directory, "browser-global-settings.json"), JSON.stringify(result, null, 2)); }
});
