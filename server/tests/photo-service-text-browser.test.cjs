"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBrowserFixture } = require("./fixtures/merchant-share-browser.cjs");

test("photo service text saves through the editor, reaches public detail and survives reopening", {
  skip: process.env.RUN_PHOTO_SERVICE_BROWSER !== "1", timeout: 90000
}, async (t) => {
  const playwright = require(process.env.PHOTO_SERVICE_PLAYWRIGHT_MODULE || "playwright");
  const fixture = await startBrowserFixture();
  let browser;
  t.after(async () => { if (browser) await browser.close(); await fixture.close(); });
  const albumId = "qa-custom-photo-services";
  const cover = fixture.url + "/qa-photo-preview.svg";
  await fixture.source.create("cities", { id: "qa-city", name: "长沙", status: "运营中" });
  await fixture.source.create("spots", { id: "qa-spot", name: "QA测试打卡点", cityId: "qa-city", isShow: true });
  await fixture.source.create("albums", { id: albumId, name: "QA测试照片留影", tags: ["城市旅拍"],
    spotId: "qa-spot", spotIds: ["qa-spot"], spotBindingExplicit: true, seriesName: "清新留影",
    price: 198, photoCount: 9, sampleUrls: [cover], cover,
    retouchMode: "count", retouchCount: 3, makeupIncluded: false,
    shootingNotes: "请提前预约，按约定时间到店。", isShow: true, status: "上架" });
  browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.PHOTO_SERVICE_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: "Asia/Shanghai" });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Only this synthetic fixture advertises the normal connected editor mode.
  // The API and all persistence remain in memory, without selecting a database.
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: "mysql" } });
  });
  await page.route("**/qa-photo-preview.svg", (route) => route.fulfill({ contentType: "image/svg+xml", body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#dce8dd"/><circle cx="480" cy="110" r="55" fill="#ffe4a3"/><path d="M0 420 180 170 350 380 470 250 640 440V480H0Z" fill="#7f9e86"/></svg>' }));
  await page.goto(fixture.url);
  await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
  await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByPlaceholder("账号", { exact: true }).waitFor({ state: "hidden" });
  await page.locator('[data-menu-key="albums"]').click();
  const section = page.locator('[data-page-key="albums"]');
  await section.getByRole("button", { name: "编辑", exact: true }).click();
  const inputs = {
    photoCountText: section.getByPlaceholder("例如：底片全送、交付9张", { exact: true }),
    retouchText: section.getByPlaceholder("例如：像素蛋糕、AI精修9张、PS精修9张、修9张", { exact: true }),
    makeupText: section.getByPlaceholder("例如：包含妆造、含简妆、自备妆造", { exact: true })
  };
  assert.equal(await inputs.photoCountText.inputValue(), "9 张照片", "legacy delivery count remains editable as text");
  assert.equal(await inputs.retouchText.inputValue(), "修图 3 张");
  assert.equal(await inputs.makeupText.inputValue(), "不包含");
  const custom = { photoCountText: "底片全送，交付9张", retouchText: "像素蛋糕，AI精修3张、PS精修9张", makeupText: "含简妆，可自备服装" };
  for (const [field, value] of Object.entries(custom)) {
    assert.equal(await inputs[field].getAttribute("maxlength"), "160");
    await inputs[field].fill(value);
  }
  const servicePanel = section.locator("section.catalog-panel").filter({ has: page.getByRole("heading", { name: "价格与服务内容", exact: true }) });
  const out = path.resolve(process.env.PHOTO_SERVICE_BROWSER_OUTPUT || path.join(__dirname, "../../../outputs/photo-service-text-20261122"));
  fs.mkdirSync(out, { recursive: true });
  await servicePanel.screenshot({ path: path.join(out, "admin-service-fields-desktop.png") });
  await section.locator(".catalog-preview").screenshot({ path: path.join(out, "admin-live-preview-desktop.png") });
  await section.getByRole("button", { name: "保存确定", exact: true }).first().click();
  await inputs.photoCountText.waitFor({ state: "hidden" });
  const saved = await fixture.source.get("albums", albumId);
  for (const [field, value] of Object.entries(custom)) assert.equal(saved[field], value, field);
  assert.equal(saved.photoCount, 1, "preview count does not overwrite custom delivery copy");
  assert.equal(saved.price, 198);
  const detailResponse = await fetch(fixture.url + "/api/rpc/getPhotoCollection", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ albumId }) });
  const detail = await detailResponse.json();
  assert.equal(detail.success, true, JSON.stringify(detail));
  for (const [field, value] of Object.entries(custom)) assert.equal(detail.data.collections[0][field], value, field);
  await page.reload();
  await page.locator('[data-menu-key="albums"]').click();
  await section.getByRole("button", { name: "编辑", exact: true }).click();
  for (const [field, value] of Object.entries(custom)) assert.equal(await inputs[field].inputValue(), value, "saved copy survives a full reload");
  await servicePanel.screenshot({ path: path.join(out, "admin-service-fields-reopened.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const backdrop = page.getByRole("button", { name: "关闭导航", exact: true });
  if (await backdrop.isVisible()) await backdrop.click();
  await page.waitForFunction(() => document.querySelector(".lxm-sidebar").getBoundingClientRect().right <= 1);
  await servicePanel.screenshot({ path: path.join(out, "admin-service-fields-mobile.png") });
  assert.equal(await servicePanel.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "browser-checks.json"), JSON.stringify({ passed: true,
    syntheticFixture: true, fields: custom, savedPreviewCount: saved.photoCount, price: saved.price,
    checks: ["legacy values editable", "custom text saved", "public detail matches", "reload retains values", "mobile panel fits"], pageErrors: errors }, null, 2));
});
