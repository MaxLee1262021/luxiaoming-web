"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBrowserFixture } = require("./fixtures/merchant-share-browser.cjs");

// Actual admin UI and HTTP handlers, backed only by synthetic memory records.
// This opt-in test never loads a configured database or a real user account.
test("spot direct-position and first-place moves preserve global ranks across filters and pagination", {
  skip: process.env.RUN_SPOT_ORDER_BROWSER !== "1", timeout: 180000
}, async (t) => {
  const playwright = require(process.env.SPOT_ORDER_PLAYWRIGHT_MODULE || process.env.CONTENT_ORDER_PLAYWRIGHT_MODULE || "playwright");
  const fixture = await startBrowserFixture();
  let browser;
  t.after(async () => { if (browser) await browser.close(); await fixture.close(); });
  const out = path.resolve(process.env.SPOT_ORDER_BROWSER_OUTPUT || path.join(__dirname, "../../../outputs/spot-order-20261127"));
  fs.mkdirSync(out, { recursive: true });
  await fixture.source.create("cities", { id: "qa-spot-city-a", name: "排序甲城", status: "运营中" });
  await fixture.source.create("cities", { id: "qa-spot-city-b", name: "排序乙城", status: "运营中" });
  const idFor = (index) => `qa-sort-spot-${index}`;
  const nameFor = (index) => `排序点位${String(index).padStart(2, "0")}`;
  const cover = fixture.url + "/qa-spot-cover.svg";
  for (let index = 1; index <= 17; index += 1) {
    await fixture.source.create("spots", { id: idFor(index), name: nameFor(index),
      cityId: index % 2 ? "qa-spot-city-a" : "qa-spot-city-b", isShow: index !== 7, status: index === 7 ? "停用" : "启用",
      address: "浏览器验收合成地址", intro: "排序测试点位，不对应真实地点", tags: ["测试风景"], tag: "推荐", cover,
      ...(index <= 15 ? { sort: index } : index === 16 ? { sort: 0 } : {}) });
  }
  await fixture.source.create("spots", { id: "qa-sort-spot-deleted", name: "已删除排序点位", cityId: "qa-spot-city-a",
    sort: 2, isShow: false, status: "停用", deleted: true, isDeleted: true });
  browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.SPOT_ORDER_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: "Asia/Shanghai" });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: "mysql" } });
  });
  await page.route("**/qa-spot-cover.svg", (route) => route.fulfill({ contentType: "image/svg+xml", body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#e8e0ef"/><circle cx="250" cy="60" r="30" fill="#ffe4a3"/><path d="M0 210 100 70 210 200 265 125 320 220V240H0Z" fill="#9a86b5"/></svg>' }));
  await page.goto(fixture.url);
  await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
  await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByPlaceholder("账号", { exact: true }).waitFor({ state: "hidden" });
  const section = page.locator('[data-page-key="spots"]');
  const search = section.getByPlaceholder("搜索点位名称、城市、标签或简介", { exact: true });
  const rows = section.locator(".el-table__body-wrapper tbody tr");
  const checks = [];
  let expected = Array.from({ length: 15 }, (_, index) => index + 1);
  function rowFor(index) { return rows.filter({ hasText: nameFor(index) }); }
  async function open() {
    await page.locator('[data-menu-key="spots"]').click();
    await rows.first().waitFor();
  }
  async function assertNames(indices) {
    await page.waitForFunction((names) => {
      const actual = [...document.querySelectorAll('[data-page-key="spots"] .el-table__body-wrapper .basic-content-media-cell strong')].map((element) => element.textContent.trim());
      return JSON.stringify(actual) === JSON.stringify(names);
    }, indices.map(nameFor));
    assert.deepEqual(await rows.locator(".basic-content-media-cell strong").allTextContents(), indices.map(nameFor));
  }
  function insert(index, position) {
    expected = expected.filter((item) => item !== index);
    expected.splice(position - 1, 0, index);
  }
  async function assertStoredOrder() {
    const stored = (await fixture.source.list("spots")).filter((row) => !row.deleted && !row.isDeleted && row.sort > 0).sort((left, right) => left.sort - right.sort);
    assert.deepEqual(stored.map((row) => row.id), expected.map(idFor));
    assert.deepEqual(stored.map((row) => row.sort), expected.map((_, index) => index + 1));
    assert.equal((await fixture.source.get("spots", "qa-sort-spot-deleted")).sort, 2, "deleted spots never join the active rank sequence");
  }
  function waitForMove(index) {
    return page.waitForResponse((response) => response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/collection/spots/${idFor(index)}`);
  }
  function writeCount(index) {
    return fixture.requests.filter((request) => request.method === "PUT" && request.pathname === `/api/collection/spots/${idFor(index)}`).length;
  }
  async function assertResponse(response, position, failure) {
    assert.equal(response.status(), failure ? 503 : 200, await response.text());
    assert.deepEqual(response.request().postDataJSON(), { sort: position });
    if (!failure) assert.ok(Array.isArray((await response.json()).__spotOrder), "server returns all affected global ranks");
  }
  async function openPrompt(index) {
    await rowFor(index).getByRole("button", { name: /^移动到/ }).click();
    const prompt = page.locator(".el-message-box");
    await prompt.waitFor();
    assert.match(await prompt.textContent(), /移动到指定位置/);
    return prompt;
  }
  async function moveTo(index, position, { failure = false, screenshot = false } = {}) {
    const prompt = await openPrompt(index);
    await prompt.locator("input").fill(String(position));
    if (screenshot) {
      await page.waitForFunction(() => !document.querySelector(".el-message"));
      await page.screenshot({ path: path.join(out, "spot-order-desktop-prompt.png"), animations: "disabled" });
      const bounds = await prompt.boundingBox();
      assert.ok(bounds.width >= 380 && bounds.width <= 560, "desktop spot prompt stays compact");
    }
    const responsePromise = waitForMove(index);
    await prompt.getByRole("button", { name: "确定", exact: true }).click();
    await assertResponse(await responsePromise, position, failure);
    await prompt.waitFor({ state: "hidden" });
    if (!failure) insert(index, position);
    await assertStoredOrder();
  }
  async function moveFirst(index, { failure = false } = {}) {
    const responsePromise = waitForMove(index);
    await rowFor(index).getByRole("button", { name: "移到最前", exact: true }).click();
    await assertResponse(await responsePromise, 1, failure);
    if (!failure) insert(index, 1);
    await assertStoredOrder();
  }
  async function filter(index) {
    await search.fill(nameFor(index));
    await assertNames([index]);
  }
  async function assertHighlight(index) {
    const outline = await rowFor(index).evaluate((element) => {
      const style = getComputedStyle(element);
      return { highlighted: element.classList.contains("is-sort-highlighted"), style: style.outlineStyle, width: style.outlineWidth };
    });
    assert.deepEqual(outline, { highlighted: true, style: "solid", width: "2px" }, "moved spot row has a visible highlight");
  }
  async function assertOpaqueActions(index) {
    const color = await rowFor(index).locator(".el-table-fixed-column--right").evaluate((element) => getComputedStyle(element).backgroundColor);
    const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color);
    assert.ok(color !== "transparent" && (!rgba || Number(rgba[1]) === 1),
      `fixed action cells need an opaque background so underlying columns do not show through (${color})`);
  }
  await open();
  await assertNames(expected.slice(0, 12));
  assert.equal(await rowFor(1).getByRole("button", { name: "移到最前", exact: true }).isDisabled(), true);
  assert.equal(await rowFor(1).getByRole("button", { name: "上移", exact: true }).isDisabled(), true);
  await filter(15);
  assert.match(await rowFor(15).textContent(), /全局第\s*15\s*位/);
  let before = writeCount(15);
  await moveTo(15, 3, { screenshot: true });
  assert.equal(writeCount(15) - before, 1, "a distant move uses a single request");
  await assertHighlight(15);
  await search.fill("");
  await assertNames(expected.slice(0, 12));
  await moveTo(15, 15);
  await assertNames([...expected.slice(12), 16, 17]);
  await assertHighlight(15);
  // Find the item again without assuming a filtered position is its global rank.
  await filter(15);
  assert.match(await rowFor(15).textContent(), /全局第\s*15\s*位/);
  before = writeCount(15);
  await moveFirst(15);
  assert.equal(writeCount(15) - before, 1);
  assert.equal(await rowFor(15).getByRole("button", { name: "移到最前", exact: true }).isDisabled(), true);
  checks.push("distant forward/backward moves, first-place movement, one-request saves, global rank labels and visible row highlight");
  await section.getByRole("button", { name: "重置", exact: true }).click();
  await assertNames(expected.slice(0, 12));
  await section.locator(".lxm-toolbar .el-select").first().click();
  await page.locator(".el-select-dropdown__item").filter({ hasText: "排序甲城" }).click();
  await filter(13);
  await moveTo(13, 2);
  assert.equal((await fixture.source.get("spots", idFor(2))).sort, expected.indexOf(2) + 1, "a point in the other city shifts with the same global order");
  assert.equal((await fixture.source.get("spots", idFor(7))).sort, expected.indexOf(7) + 1, "hidden points still occupy their global rank");
  checks.push("city and keyword filters keep the same global insertion range, including other cities and hidden spots");
  await section.getByRole("button", { name: "重置", exact: true }).click();
  await filter(16);
  assert.match(await rowFor(16).textContent(), /未设置排序/);
  assert.equal(await rowFor(16).getByRole("button", { name: "移到最前", exact: true }).isEnabled(), true);
  await moveTo(16, 16);
  assert.equal((await fixture.source.get("spots", idFor(17))).sort, undefined, "another unranked point remains outside the sequence");
  assert.match(await rowFor(16).textContent(), /全局第\s*16\s*位/);
  assert.equal(await rowFor(16).getByRole("button", { name: "下移", exact: true }).isDisabled(), true);
  checks.push("an unranked point can append at ranked-count plus one; other unranked and deleted points do not occupy places");
  before = writeCount(16);
  let prompt = await openPrompt(16);
  for (const value of ["", "0", "17", "1.5", "abc"]) {
    await prompt.locator("input").fill(value);
    await prompt.getByRole("button", { name: "确定", exact: true }).click();
    await prompt.locator(".el-message-box__errormsg").waitFor();
    assert.equal(await prompt.isVisible(), true);
    assert.equal(writeCount(16), before, `invalid position ${JSON.stringify(value)} is never sent`);
  }
  await prompt.locator("input").fill("2");
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await prompt.waitFor({ state: "hidden" });
  assert.equal(writeCount(16), before, "cancel keeps both the UI and source unchanged");
  prompt = await openPrompt(16);
  await prompt.locator("input").fill("16");
  await prompt.getByRole("button", { name: "确定", exact: true }).click();
  await prompt.waitFor({ state: "hidden" });
  assert.equal(writeCount(16), before, "the current position is a no-op");
  await assertStoredOrder();
  checks.push("invalid and out-of-range inputs are blocked; cancellation and same-position confirmation do not write");
  await moveFirst(16);
  const downResponse = waitForMove(16);
  await rowFor(16).getByRole("button", { name: "下移", exact: true }).click();
  await assertResponse(await downResponse, 2, false);
  insert(16, 2);
  await assertStoredOrder();
  const upResponse = waitForMove(16);
  await rowFor(16).getByRole("button", { name: "上移", exact: true }).click();
  await assertResponse(await upResponse, 1, false);
  insert(16, 1);
  await assertStoredOrder();
  await section.getByRole("button", { name: "重置", exact: true }).click();
  await filter(15);
  await page.route(`**/api/collection/spots/${idFor(15)}`, async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "QA模拟打卡点排序失败" }) });
    else await route.continue();
  });
  await moveFirst(15, { failure: true });
  await moveTo(15, 5, { failure: true });
  await assertNames([15]);
  assert.match(await rowFor(15).textContent(), /全局第\s*2\s*位/);
  await page.unroute(`**/api/collection/spots/${idFor(15)}`);
  checks.push("existing up/down controls remain compatible; failed first-place and direct saves preserve the complete rank sequence");
  await page.reload();
  await open();
  await assertNames(expected.slice(0, 12));
  checks.push("the saved order persists after page reload with pagination");
  await page.waitForFunction(() => !document.querySelector(".el-message"));
  await assertOpaqueActions(16);
  await assertOpaqueActions(15);
  assert.equal(await rowFor(16).locator(".spot-sort-mobile-name").isVisible(), false, "desktop keeps its existing product-name column");
  await page.screenshot({ path: path.join(out, "spot-order-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  const backdrop = page.getByRole("button", { name: "关闭导航", exact: true });
  if (await backdrop.isVisible()) await backdrop.click();
  await page.waitForFunction(() => document.querySelector(".lxm-sidebar").getBoundingClientRect().right <= 1);
  await filter(16);
  await assertOpaqueActions(16);
  assert.equal(await rowFor(16).locator(".spot-sort-mobile-name").isVisible(), true, "mobile fixed controls show the point name being changed");
  assert.equal((await rowFor(16).locator(".spot-sort-mobile-name").textContent()).trim(), nameFor(16));
  const moveButton = rowFor(16).getByRole("button", { name: /^移动到/ });
  await moveButton.scrollIntoViewIfNeeded();
  const buttonBounds = await moveButton.boundingBox();
  assert.ok(buttonBounds.x >= 0 && buttonBounds.x + buttonBounds.width <= 390, "mobile fixed operation column keeps the move button reachable");
  await page.screenshot({ path: path.join(out, "spot-order-mobile.png"), animations: "disabled" });
  prompt = await openPrompt(16);
  await page.screenshot({ path: path.join(out, "spot-order-mobile-prompt.png"), animations: "disabled" });
  const promptBounds = await prompt.boundingBox();
  assert.ok(promptBounds.x >= 0 && promptBounds.x + promptBounds.width <= 390, "mobile spot prompt fits inside the viewport");
  assert.equal(await prompt.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await prompt.waitFor({ state: "hidden" });
  checks.push("desktop table actions and mobile fixed actions and prompt are usable without clipped sort controls");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "browser-checks.json"), JSON.stringify({ passed: true, syntheticFixture: true, checks, pageErrors: errors }, null, 2));
});
