"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBrowserFixture } = require("./fixtures/merchant-share-browser.cjs");

// This opt-in browser check runs the actual admin and HTTP handlers against an
// isolated, synthetic memory source. It never selects a database or real account.
test("four content lists support direct-position and first-place moves, including filtered and table views", {
  skip: process.env.RUN_CONTENT_ORDER_BROWSER !== "1", timeout: 180000
}, async (t) => {
  const playwright = require(process.env.CONTENT_ORDER_PLAYWRIGHT_MODULE || "playwright");
  const fixture = await startBrowserFixture();
  let browser;
  t.after(async () => { if (browser) await browser.close(); await fixture.close(); });
  const out = path.resolve(process.env.CONTENT_ORDER_BROWSER_OUTPUT || path.join(__dirname, "../../../outputs/content-order-20261127"));
  fs.mkdirSync(out, { recursive: true });
  const cover = fixture.url + "/qa-sort-cover.svg";
  await fixture.source.create("cities", { id: "qa-sort-city", name: "长沙", status: "运营中" });
  await fixture.source.create("spots", { id: "qa-sort-spot", name: "排序测试点位", cityId: "qa-sort-city", isShow: true });
  const definitions = [
    { menu: "albums", key: "albums", stem: "排序照片", selector: ".catalog-card" },
    { menu: "videoSingles", key: "packages", stem: "排序视频", selector: ".catalog-card" },
    { menu: "packages", key: "packages", stem: "排序套餐", selector: ".package-card" },
    { menu: "guides", key: "guides", stem: "排序灵感", selector: ".ig-inspiration-card" }
  ];
  const idFor = (definition, index) => `qa-sort-${definition.menu}-${index}`;
  const nameFor = (definition, index) => `${definition.stem}${index}`;
  for (const definition of definitions) {
    for (const index of [1, 2, 3]) {
      const row = { id: idFor(definition, index), name: nameFor(definition, index), title: nameFor(definition, index),
        tags: ["城市旅拍"], spotId: "qa-sort-spot", spotIds: ["qa-sort-spot"], spotBindingExplicit: true,
        price: 198, cover, shootingNotes: "浏览器排序测试说明", description: "浏览器排序测试商品说明",
        hotScore: 40 - index * 10, isShow: true, status: "上架", createTime: `2026-11-${24 - index}T00:00:00Z` };
      if (definition.menu === "albums") Object.assign(row, { seriesName: "城市留影", photoCount: 1, sampleUrls: [cover], retouchMode: "excluded", retouchCount: 0, makeupIncluded: false });
      if (definition.menu === "videoSingles") Object.assign(row, { type: "video", serviceType: "video", isVideoSingle: true, productKind: "video_single",
        seriesName: "城市留影", videoUrl: fixture.url + "/qa-sort-video.mp4", videoDuration: 30, finishedVideoCount: 1, deliveryCycle: "3天", makeupIncluded: false, hasAerial: false, fullEdit: true });
      if (definition.menu === "packages") Object.assign(row, { type: "photo", productKind: "package", includedItems: [{ type: "album", productId: "qa-sort-albums-1", name: "排序照片1", quantity: 1, price: 198 }] });
      if (definition.menu === "guides") Object.assign(row, { status: "已发布", contentHtml: "<p>浏览器排序测试旅拍灵感</p>", createdAt: row.createTime, updatedAt: row.createTime, category: "城市漫游" });
      await fixture.source.create(definition.key, row);
    }
  }
  browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.CONTENT_ORDER_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: "Asia/Shanghai" });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: "mysql" } });
  });
  await page.route("**/qa-sort-cover.svg", (route) => route.fulfill({ contentType: "image/svg+xml", body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#e8e0ef"/><circle cx="480" cy="110" r="55" fill="#ffe4a3"/><path d="M0 420 180 170 350 380 470 250 640 440V480H0Z" fill="#9a86b5"/></svg>' }));
  await page.route("**/qa-sort-video.mp4", (route) => route.fulfill({ contentType: "video/mp4", body: Buffer.alloc(0) }));
  await page.goto(fixture.url);
  await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
  await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByPlaceholder("账号", { exact: true }).waitFor({ state: "hidden" });
  const checks = [];
  async function open(definition) {
    await page.locator(`[data-menu-key="${definition.menu}"]`).click();
    const section = page.locator(`[data-page-key="${definition.menu}"]`);
    await section.locator(definition.selector).first().waitFor();
    return section;
  }
  async function assertOrder(definition, indices, selector = definition.selector) {
    const names = indices.map((index) => nameFor(definition, index));
    await page.waitForFunction(({ menu, selector, names }) => {
      const titles = [...document.querySelectorAll(`[data-page-key="${menu}"] ${selector} h3`)].map((item) => item.textContent.trim());
      return JSON.stringify(titles) === JSON.stringify(names);
    }, { menu: definition.menu, selector, names });
    assert.deepEqual(await page.locator(`[data-page-key="${definition.menu}"] ${selector} h3`).allTextContents(), names);
  }
  function cardFor(definition, section, index, options = {}) {
    if (options.table) return section.locator(".album-table tbody tr").filter({ hasText: nameFor(definition, index) });
    return section.locator(definition.selector).filter({ has: page.getByRole("heading", { name: nameFor(definition, index), exact: true }) });
  }
  function waitForMove(definition, index) {
    return page.waitForResponse((response) => response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/collection/${definition.key}/${idFor(definition, index)}`);
  }
  async function assertMoveResponse(response, patch, options = {}) {
    assert.equal(response.status(), options.failure ? 503 : 200, await response.text());
    assert.deepEqual(response.request().postDataJSON(), patch);
    if (!options.failure) assert.ok(Array.isArray((await response.json()).__contentOrder), "server confirms all shifted ranks");
  }
  async function move(definition, section, index, direction) {
    const responsePromise = waitForMove(definition, index);
    await cardFor(definition, section, index).getByRole("button", { name: direction < 0 ? "上移" : "下移", exact: true }).click();
    await assertMoveResponse(await responsePromise, { sortDirection: direction });
  }
  async function openPositionPrompt(definition, section, index, options = {}) {
    await cardFor(definition, section, index, options).getByRole("button", { name: /^移动到/ }).click();
    const prompt = page.locator(".el-message-box");
    await prompt.waitFor();
    assert.match(await prompt.textContent(), /移动到指定位置/);
    return prompt;
  }
  async function moveTo(definition, section, index, position, options = {}) {
    const prompt = await openPositionPrompt(definition, section, index, options);
    await prompt.locator("input").fill(String(position));
    if (definition.menu === "albums" && position === 1) {
      await page.waitForFunction(() => !document.querySelector(".el-message"));
      await page.screenshot({ path: path.join(out, "photo-order-desktop-prompt.png"), animations: "disabled" });
      const promptBounds = await prompt.boundingBox();
      assert.ok(promptBounds.width >= 380 && promptBounds.width <= 560, "desktop position prompt uses a compact, readable width");
    }
    const responsePromise = waitForMove(definition, index);
    await prompt.getByRole("button", { name: /确定|确认/ }).click();
    await assertMoveResponse(await responsePromise, { targetPosition: position }, options);
    await prompt.waitFor({ state: "hidden" });
  }
  async function moveFirst(definition, section, index, options = {}) {
    const responsePromise = waitForMove(definition, index);
    await cardFor(definition, section, index, options).getByRole("button", { name: "移到最前", exact: true }).click();
    await assertMoveResponse(await responsePromise, { targetPosition: 1 }, options);
  }
  async function assertRanks(definition, indices) {
    const snapshots = await Promise.all(indices.map((index) => fixture.source.get(definition.key, idFor(definition, index))));
    assert.deepEqual(snapshots.map((row) => row.sort), indices.map((_, index) => index + 1));
    assert.equal(snapshots.some((row) => Object.hasOwn(row, "targetPosition")), false, "the move command is never stored as product data");
  }
  function writeCount(definition, index) {
    const pathname = `/api/collection/${definition.key}/${idFor(definition, index)}`;
    return fixture.requests.filter((request) => request.method === "PUT" && request.pathname === pathname).length;
  }
  for (const definition of definitions) {
    const section = await open(definition);
    await assertOrder(definition, [1, 2, 3]);
    assert.equal(await section.locator(definition.selector).first().getByRole("button", { name: "上移", exact: true }).isDisabled(), true);
    assert.equal(await section.locator(definition.selector).first().getByRole("button", { name: "移到最前", exact: true }).isDisabled(), true);
    assert.equal(await section.locator(definition.selector).last().getByRole("button", { name: "下移", exact: true }).isDisabled(), true);
    await move(definition, section, 3, -1);
    await assertOrder(definition, [1, 3, 2]);
    await assertRanks(definition, [1, 3, 2]);
    let before = writeCount(definition, 3);
    await moveTo(definition, section, 3, 1);
    await assertOrder(definition, [3, 1, 2]);
    assert.equal(writeCount(definition, 3) - before, 1, "moving to a position uses one request");
    await moveTo(definition, section, 3, 3);
    await assertOrder(definition, [1, 2, 3]);
    before = writeCount(definition, 3);
    await moveFirst(definition, section, 3);
    await assertOrder(definition, [3, 1, 2]);
    await assertRanks(definition, [3, 1, 2]);
    assert.equal(await cardFor(definition, section, 3).evaluate((element) => element.classList.contains("is-sort-highlighted")), true,
      "the moved card is highlighted so it can be found after insertion");
    const highlight = await cardFor(definition, section, 3).evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    assert.deepEqual(highlight, { style: "solid", width: "2px" }, "the moved card highlight has a visible outline");
    assert.equal(writeCount(definition, 3) - before, 1, "moving to the front uses one request");
    assert.equal(await cardFor(definition, section, 3).getByRole("button", { name: "移到最前", exact: true }).isDisabled(), true);
    if (definition.menu === "videoSingles") {
      const untouched = await fixture.source.get("packages", "qa-sort-packages-1");
      assert.equal(untouched.sort, undefined, "video ranks do not touch package ranks");
    }
    await page.reload();
    await open(definition);
    await assertOrder(definition, [3, 1, 2]);
    if (definition.menu === "guides") {
      await section.screenshot({ path: path.join(out, "guide-order-desktop.png") });
      for (const card of await section.locator(definition.selector).all()) {
        assert.equal(await card.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false,
          "guide content and sorting actions fit the desktop card");
      }
      checks.push("guide desktop sorting actions fit without horizontal overflow");
    }
    checks.push(`${definition.menu}: legacy order, one-step controls, direct forward/backward insertion, move first, shifted ranks, persisted after reload`);
  }
  const photos = definitions[0];
  let section = await open(photos);
  const search = section.getByPlaceholder("搜索商品名称 / 标签", { exact: true });
  await search.fill("排序照片1");
  await assertOrder(photos, [1]);
  // A single filtered result still accepts position 3 in the complete pool.
  assert.equal(await section.locator(photos.selector).getByRole("button", { name: "移到最前", exact: true }).isEnabled(), true);
  await moveTo(photos, section, 1, 3);
  await search.fill("");
  await assertOrder(photos, [3, 2, 1]);
  await assertRanks(photos, [3, 2, 1]);
  checks.push("filtered direct movement uses the complete category range, shifting items outside the result");
  await section.screenshot({ path: path.join(out, "photo-order-desktop.png") });
  await section.getByRole("button", { name: "列表", exact: true }).click();
  const tableRows = section.locator(".album-table tbody tr");
  await tableRows.first().waitFor();
  assert.deepEqual(await tableRows.locator(".album-table-product strong").allTextContents(), ["排序照片3", "排序照片2", "排序照片1"]);
  await moveTo(photos, section, 1, 2, { table: true });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-page-key="albums"] .album-table-product strong')].map((item) => item.textContent).join(",") === "排序照片3,排序照片1,排序照片2");
  await moveFirst(photos, section, 1, { table: true });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-page-key="albums"] .album-table-product strong')].map((item) => item.textContent).join(",") === "排序照片1,排序照片3,排序照片2");
  checks.push("photo table view applies both direct-position and move-first controls");
  await section.getByRole("button", { name: "卡片", exact: true }).click();
  await assertOrder(photos, [1, 3, 2]);
  const countBeforePrompt = writeCount(photos, 3);
  let prompt = await openPositionPrompt(photos, section, 3);
  for (const value of ["", "0", "4", "1.5", "abc"]) {
    await prompt.locator("input").fill(value);
    await prompt.getByRole("button", { name: /确定|确认/ }).click();
    await prompt.locator(".el-message-box__errormsg").waitFor();
    assert.equal(await prompt.isVisible(), true);
    assert.equal(writeCount(photos, 3), countBeforePrompt, `invalid position ${JSON.stringify(value)} must not be submitted`);
  }
  await prompt.locator("input").fill("1");
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await prompt.waitFor({ state: "hidden" });
  assert.equal(writeCount(photos, 3), countBeforePrompt, "cancelling a valid move does not submit a request");
  await assertOrder(photos, [1, 3, 2]);
  checks.push("empty, out-of-range, decimal and non-numeric positions are rejected; cancellation leaves the order unchanged");
  await page.route("**/api/collection/albums/qa-sort-albums-3", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "QA模拟排序失败" }) });
    else await route.continue();
  });
  await moveFirst(photos, section, 3, { failure: true });
  await moveTo(photos, section, 3, 3, { failure: true });
  await assertOrder(photos, [1, 3, 2]);
  assert.equal((await fixture.source.get("albums", "qa-sort-albums-3")).sort, 2);
  await page.unroute("**/api/collection/albums/qa-sort-albums-3");
  checks.push("rejected save retains the prior UI and stored order");
  await page.setViewportSize({ width: 390, height: 844 });
  const backdrop = page.getByRole("button", { name: "关闭导航", exact: true });
  if (await backdrop.isVisible()) await backdrop.click();
  await page.waitForFunction(() => document.querySelector(".lxm-sidebar").getBoundingClientRect().right <= 1);
  await page.waitForFunction(() => !document.querySelector(".el-message"));
  await section.locator(photos.selector).first().screenshot({ path: path.join(out, "photo-order-mobile.png") });
  const firstCard = section.locator(photos.selector).first();
  assert.equal(await firstCard.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false, "mobile card has no horizontal overflow");
  checks.push("mobile sort buttons fit the product card");
  prompt = await openPositionPrompt(photos, section, 3);
  await page.waitForFunction(() => !document.querySelector(".el-message"));
  await page.screenshot({ path: path.join(out, "photo-order-mobile-prompt.png"), animations: "disabled" });
  assert.equal(await prompt.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false, "position prompt has no horizontal overflow on mobile");
  const promptBounds = await prompt.boundingBox();
  assert.ok(promptBounds.x >= 0 && promptBounds.x + promptBounds.width <= 390, "mobile position prompt stays inside the viewport");
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await prompt.waitFor({ state: "hidden" });
  checks.push("mobile direct-position prompt fits and can be cancelled");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "browser-checks.json"), JSON.stringify({ passed: true, syntheticFixture: true, checks, pageErrors: errors }, null, 2));
});
