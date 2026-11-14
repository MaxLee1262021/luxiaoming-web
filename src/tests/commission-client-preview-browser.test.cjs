"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBrowserFixture } = require("../../server/tests/fixtures/merchant-share-browser.cjs");

test("super commission clients are direct pages with aggregate and individual previews", {
  skip: process.env.RUN_COMMISSION_CLIENT_BROWSER !== "1", timeout: 90000,
}, async t => {
  // The real local login and static assets run against isolated persistence.
  // Commission responses below are synthetic UI contracts, with no database,
  // external integration or production account mutations.
  const fixture = await startBrowserFixture();
  const playwright = require(process.env.COMMISSION_PLAYWRIGHT_MODULE || "playwright");
  const browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.COMMISSION_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1512, height: 1100 }, timezoneId: "Asia/Shanghai" });
  page.setDefaultTimeout(12000);
  const output = path.resolve(__dirname, "../../../outputs/commission-client-preview-20261113");
  fs.mkdirSync(output, { recursive: true });
  const report = { testOnly: true, realDatabaseAccess: false, status: "running", checks: [], requests: [], pageErrors: [] };
  page.on("pageerror", error => report.pageErrors.push(error.message));
  t.after(async () => {
    fs.writeFileSync(path.join(output, "browser.json"), JSON.stringify(report, null, 2));
    try { await browser.close(); } finally { await fixture.close(); }
  });
  const period = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date());
  const rates = { rate_photo_bp: 500, rate_video_bp: 1000, rate_combo_bp: 800, rate_peripheral_bp: 1500 };
  const serviceStaff = [
    { id: "qa-preview-svc-1", name: "QA预览客服甲", account: "qa-preview-svc-one", base_salary_fen: 300000, rates },
    { id: "qa-preview-svc-2", name: "QA预览客服乙", account: "qa-preview-svc-two", base_salary_fen: 400000, rates },
  ];
  const photographers = [
    { id: "PH20260001", name: "QA预览摄影师甲", status: "active", rates },
    { id: "PH20260002", name: "QA预览摄影师乙", status: "paused", rates },
  ];
  const ledgerRows = (people, prefix) => people.map((person, index) => ({
    id: prefix + "-" + index, party_id: person.id, staff_name: person.name, photo_name: person.name,
    biz_no: prefix + "-ORDER-" + (index + 1), order_no: prefix + "-ORDER-" + (index + 1),
    category: "photo", product_name: "QA预览旅拍", merchant_name: "QA预览门店", customer_openid: "oSyntheticPreview" + index,
    biz_date: period + "-10", done_at: period + "-10 10:00:00", paid_at: period + "-01 10:00:00",
    net_amount_fen: 100000, commission_fen: (index + 1) * 1000, rate_bp: 500, rule_ver: 1,
    rate_mode: "global", calculation_basis: "实收定金×5%", status: "settleable",
  }));
  const svcRows = ledgerRows(serviceStaff, "QA-SVC-PREVIEW"), photoRows = ledgerRows(photographers, "QA-PH-PREVIEW");
  await page.route(/\/api\/(?:svc|photo)\/(?:me|ledger\/export)(?:\?|$)/, async route => {
    const url = new URL(route.request().url()), isPhoto = url.pathname.startsWith("/api/photo/");
    report.requests.push({ pathname: url.pathname, search: url.search, method: route.request().method() });
    if (url.pathname.endsWith("/export")) return route.fulfill({ status: 200, contentType: "text/csv; charset=utf-8", body: "\uFEFF订单号,提成\r\nQA-PREVIEW,10.00" });
    const people = isPhoto ? photographers : serviceStaff, selectedId = url.searchParams.get(isPhoto ? "photo" : "staff");
    const selected = people.find(person => person.id === selectedId), allRows = isPhoto ? photoRows : svcRows;
    const rows = selected ? allRows.filter(row => row.party_id === selected.id) : allRows;
    const commission = rows.reduce((sum, row) => sum + row.commission_fen, 0);
    const kpi = { month_fen: commission, total_fen: commission, month_orders: rows.length, settled_rows: 0,
      base_salary_fen: selected ? selected.base_salary_fen || 0 : 700000, staff_count: people.length,
      est: 0, obs: 0, settleable: commission, settled: 0, rates };
    const data = isPhoto
      ? { photo: selected || null, photographers, kpi, rows, total: rows.length, settlements: [] }
      : { staff: selected || null, staff_options: serviceStaff, current_rates: rates, kpi, list: rows, total: rows.length, settlements: [], appeals: [] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, msg: "ok", data }) });
  });
  const clients = [
    { key: "svcMine", label: "客服端", endpoint: "/api/svc/me", parameter: "staff", picker: "选择预览客服", people: serviceStaff, prefix: "QA-SVC-PREVIEW", download: "下载" },
    { key: "photoMine", label: "摄影端", endpoint: "/api/photo/me", parameter: "photo", picker: "选择预览摄影师", people: photographers, prefix: "QA-PH-PREVIEW", download: "导出明细" },
  ];
  const responseFor = (client, id = "") => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === client.endpoint && (url.searchParams.get(client.parameter) || "") === id;
  });
  async function waitRows(client, selected) {
    await page.waitForFunction(({ key, first, second, selected }) => {
      const text = document.querySelector('[data-page-key="' + key + '"]')?.innerText || "";
      return text.includes(first) && (selected ? !text.includes(second) : text.includes(second));
    }, { key: client.key, first: client.prefix + "-ORDER-1", second: client.prefix + "-ORDER-2", selected });
  }
  try {
    await page.goto(fixture.url);
    await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
    await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator('button[data-menu-key="svcMine"]').waitFor();
    assert.equal(await page.locator('[data-menu-key="svcClient"],[data-menu-key="photoClient"]').count(), 0);
    for (const client of clients) {
      const menu = page.locator('button[data-menu-key="' + client.key + '"]');
      assert.equal((await menu.locator(".menu-text").innerText()).trim(), client.label);
      assert.equal(await menu.getAttribute("data-menu-level"), "1");
    }
    for (const viewport of [{ width: 1512, height: 1100 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const client of clients) {
        if (viewport.width < 800) await page.getByRole("button", { name: "打开导航", exact: true }).click();
        const aggregate = responseFor(client);
        await page.locator('button[data-menu-key="' + client.key + '"]').click();
        assert.equal((await aggregate).status(), 200);await waitRows(client, false);
        const section = page.locator('[data-page-key="' + client.key + '"]');
        await section.getByRole("heading", { name: "我的分成", exact: true }).waitFor();
        const picker = section.getByRole("combobox", { name: client.picker, exact: true });
        await picker.waitFor();
        await page.screenshot({ path: path.join(output, client.key + "-all-" + viewport.width + ".png"), fullPage: true, animations: "disabled" });
        const wrapper = picker.locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]');
        await wrapper.click();
        const individual = responseFor(client, client.people[0].id);
        await page.getByRole("option", { name: new RegExp(client.people[0].name) }).click();
        assert.equal((await individual).status(), 200);await waitRows(client, true);
        await section.getByText(client.people[0].name, { exact: false }).first().waitFor();
        await page.screenshot({ path: path.join(output, client.key + "-selected-" + viewport.width + ".png"), fullPage: true, animations: "disabled" });
        if (viewport.width > 800) {
          const download = page.waitForEvent("download");
          await section.getByRole("button", { name: client.download, exact: true }).click();await download;
          const exported = report.requests.filter(request => request.pathname === (client.key === "svcMine" ? "/api/svc/ledger/export" : "/api/photo/ledger/export")).at(-1);
          assert.equal(new URLSearchParams(exported.search).get(client.parameter), client.people[0].id);
        }
        await wrapper.hover();
        const cleared = responseFor(client);
        await wrapper.locator(".el-select__clear").click();
        assert.equal((await cleared).status(), 200);await waitRows(client, false);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), client.label + " does not overflow at " + viewport.width + "px");
        report.checks.push(client.label + " " + viewport.width + "px: direct page, aggregate rows, selected person, scoped export and clear to aggregate");
      }
    }
    assert.deepEqual(report.pageErrors, []);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";report.failure = error.message;
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true, animations: "disabled" }).catch(() => {});
    throw error;
  }
});
