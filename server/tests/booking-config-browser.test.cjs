"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { startBrowserFixture } = require("./fixtures/merchant-share-browser.cjs");
test("booking settings save through the admin UI and reach the mini-program RPC", { skip: process.env.RUN_BOOKING_BROWSER !== "1", timeout: 90000 }, async t => {
  const playwright = require(process.env.BOOKING_PLAYWRIGHT_MODULE || "playwright");
  const fixture = await startBrowserFixture();
  fixture.source.upsert = async (key, id, patch) => await fixture.source.get(key, id) ? fixture.source.update(key, id, patch) : fixture.source.create(key, { ...patch, id });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.BOOKING_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  t.after(async () => { await browser.close(); await fixture.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: "Asia/Shanghai" });
  const errors = []; page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(12000);
  // This isolated synthetic fixture deliberately supplies the production-ready
  // health contract. No runtime data source or real database is selected.
  await page.route("**/api/health", async route => { const response = await route.fetch(); const body = await response.json(); await route.fulfill({ response, json: { ...body, mode: "mysql" } }); });
  await page.goto(fixture.url);
  await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
  await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByPlaceholder("账号", { exact: true }).waitFor({ state: "hidden" });
  await page.locator('[data-menu-key="bookingConfig"]').click();
  const section = page.locator('[data-page-key="bookingConfig"]');
  await section.getByRole("button", { name: "保存预约配置", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector(".el-loading-mask"));
  await section.getByRole("spinbutton", { name: "默认定金比例（%）", exact: true }).fill("30");
  await section.getByRole("textbox", { name: "预约须知版本", exact: true }).fill("qa-v1");
  await section.getByRole("textbox", { name: "预约须知正文", exact: true }).fill("测试预约规则\n测试退款规则");
  // First load works without a global document. Preserve changes to other
  // fields made after the editor loaded as well.
  await fixture.source.create("siteConfig", { id: "global", privacyText: "TEST_ONLY_KEEP", customPrice: { extension: "TEST_ONLY_KEEP" } });
  await section.getByRole("button", { name: "保存预约配置", exact: true }).click();
  await page.getByText("预约配置已保存，小程序重新进入预约页后生效", { exact: true }).waitFor();
  const config = await fixture.source.get("siteConfig", "global");
  assert.equal(config.customPrice.depositRatio, 0.3); assert.equal(config.privacyText, "TEST_ONLY_KEEP"); assert.equal(config.customPrice.extension, "TEST_ONLY_KEEP");
  const rpc = await (await fetch(fixture.url + "/api/rpc/getBookingConfig", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  assert.equal(rpc.data.depositRatio, 0.3); assert.equal(rpc.data.bookingNoticeVersion, "qa-v1"); assert.match(rpc.data.bookingNotice, /测试预约规则/);
  await section.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".el-loading-mask"));
  assert.equal(await section.getByRole("spinbutton", { name: "默认定金比例（%）", exact: true }).inputValue(), "30.00");
  const out = path.resolve(__dirname, "../../../.codex-tmp/booking-config-20261113"); fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, "booking-config-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const backdrop = page.getByRole("button", { name: "关闭导航", exact: true });
  if (await backdrop.isVisible()) await backdrop.click();
  const collapse = page.getByRole("button", { name: "收起菜单", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.getByText("预约配置已保存，小程序重新进入预约页后生效", { exact: true }).waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(out, "booking-config-mobile.png"), fullPage: true });
  const overflow = await section.evaluate(element => element.scrollWidth > element.clientWidth + 1); assert.equal(overflow, false);
  assert.deepEqual(errors, []);
});
