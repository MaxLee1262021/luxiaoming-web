"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBrowserFixture } = require("../../server/tests/fixtures/merchant-share-browser.cjs");

test("commission lists create through dialogs and refresh their lists with direct client menus", {
  skip: process.env.RUN_COMMISSION_MODALS_BROWSER !== "1", timeout: 90000,
}, async t => {
  // Auth/static transport is real; every commission response below is synthetic
  // test data. This test neither opens a MySQL connection nor creates real users.
  const fixture = await startBrowserFixture();
  const playwright = require(process.env.COMMISSION_PLAYWRIGHT_MODULE || "playwright");
  const browser = await playwright.chromium.launch({ headless: true,
    executablePath: process.env.COMMISSION_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1512, height: 1100 }, timezoneId: "Asia/Shanghai" });
  page.setDefaultTimeout(12000);
  const output = path.resolve(__dirname, "../../../outputs/commission-list-modals-20261116");
  fs.mkdirSync(output, { recursive: true });
  const report = { testOnly: true, realDatabaseAccess: false, status: "running", checks: [], requests: [], pageErrors: [] };
  page.on("pageerror", error => report.pageErrors.push(error.message));
  t.after(async () => {
    fs.writeFileSync(path.join(output, "browser.json"), JSON.stringify(report, null, 2));
    try { await browser.close(); } finally { await fixture.close(); }
  });
  const serviceStaff = [], photographers = [];
  let rejectService = true, rejectPhoto = true, rejectPhotoLink = true;
  const rates = { rate_photo_bp: 2000, rate_video_bp: 2000, rate_combo_bp: 2200, rate_peripheral_bp: 800 };
  await page.route(/\/api\/(?:svc|photo)\//, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    report.requests.push({ pathname: url.pathname, method, search: url.search });
    let data = {}, code = 0, msg = "ok";
    if (url.pathname === "/api/svc/rule") data = { current: { ver: 1, ...rates }, versions: [], config: { link_valid_days: 7, observe_days: 7 } };
    else if (url.pathname === "/api/svc/staff" && method === "GET") data = { list: serviceStaff, total: serviceStaff.length, config: { link_valid_days: 7, observe_days: 7 } };
    else if (url.pathname === "/api/svc/staff" && method === "POST") {
      const body = request.postDataJSON();
      assert.equal(body.account, "qa-service-modal"); assert.equal(body.password, "QaService2026!");
      assert.equal(body.link_valid_days, 9); assert.equal(body.observe_days, 4);
      if (rejectService) { code = 4015; msg = "测试账号已存在，请更换账号"; rejectService = false; }
      else { const row = { ...body, id: "qa-svc-modal", staff_status: "active", month_fen: 0, total_fen: 0 }; delete row.password; serviceStaff.push(row); data = { ...row, account_created: true }; }
    }
    else if (url.pathname === "/api/photo/rule") data = { current: { ver: 1, ...rates }, versions: [], overrides: [] };
    else if (url.pathname === "/api/photo/party" && method === "GET") data = { rows: photographers, total: photographers.length };
    else if (url.pathname === "/api/photo/party" && method === "POST") {
      const body = request.postDataJSON();
      if (body.create_account === false) {
        assert.equal(body.account, "qa-existing-photo");
        assert.equal(Object.hasOwn(body, "password"), false, "link requests must omit any stale password");
        assert.equal(Object.hasOwn(body, "account_id"), false);
        if (rejectPhotoLink) { code = 4315; msg = "测试已有账号尚未启用"; data = { field: "account" }; rejectPhotoLink = false; }
        else { const row = { ...body, id: "PH20269998", agree_no: "QA-PH-XY-LINK", status: "active", rates, pending_count: 0, month_fen: 0, total_fen: 0 }; photographers.push(row); data = { ...row, account: "QA-EXISTING-PHOTO", account_id: "qa-existing", account_created: false, account_linked: true }; }
      } else {
        assert.equal(body.create_account, true); assert.equal(body.account, "qa-photo-modal"); assert.equal(body.password, "QaPhoto2026!");
        if (rejectPhoto) { code = 4315; msg = "测试摄影账号已存在"; data = { field: "account" }; rejectPhoto = false; }
        else { const row = { ...body, id: "PH20269999", agree_no: "QA-PH-XY", status: "active", rates, pending_count: 0, month_fen: 0, total_fen: 0 }; delete row.password; photographers.push(row); data = { ...row, account_created: true }; }
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code, msg, data }) });
  });
  const listGets = pathname => report.requests.filter(row => row.pathname === pathname && row.method === "GET").length;
  const formInput = (dialog, label) => dialog.locator(".el-form-item").filter({ has: page.locator(".el-form-item__label").filter({ hasText: label }) }).locator("input").first();
  async function checkDialogGeometry(dialog, selector, saveLabel, name) {
    const viewport = page.viewportSize(), box = await page.locator(selector).boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, name + " dialog stays inside the viewport");
    const save = await dialog.getByRole("button", { name: saveLabel, exact: true }).boundingBox();
    assert.ok(save && save.y >= 0 && save.y + save.height <= viewport.height + 1, name + " save button remains visible without scrolling the overlay");
    const body = page.locator(selector + " .el-dialog__body");
    const dimensions = await body.evaluate(element => ({ height: element.clientHeight, width: element.clientWidth, contentHeight: element.scrollHeight, contentWidth: element.scrollWidth }));
    (report.dialogGeometry ||= []).push({ name, viewport, box, save, body: dimensions });
    assert.ok(dimensions.height > 200 && dimensions.contentWidth <= dimensions.width + 1, name + " form scrolls vertically without horizontal overflow");
    await body.evaluate(element => { element.scrollTop = 0; });
    report.checks.push(name + " " + viewport.width + "px: dialog and save button fit the viewport; form body owns vertical scrolling");
    await page.waitForFunction(() => !document.querySelector(".el-message"));
  }
  try {
    await page.goto(fixture.url);
    await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
    await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator('[data-menu-key="svcStaff"]').waitFor();
    for (const [group, keys, labels] of [
      ["客服分成管理", ["svcRules", "svcLedger", "svcStaff", "svcSettlements", "svcMine"], ["分成配置", "分成明细", "客服列表", "结算管理", "客服端"]],
      ["摄影师分成管理", ["photoRules", "photoLedger", "photoParty", "photoSettlement", "photoMine"], ["分成配置", "分成明细", "摄影师列表", "结算管理", "摄影端"]],
    ]) {
      const section = page.locator(".menu-section").filter({ has: page.locator(".menu-group strong", { hasText: group }) });
      assert.deepEqual(await section.locator("[data-menu-key]").evaluateAll(nodes => nodes.map(node => node.dataset.menuKey)), keys);
      assert.deepEqual(await section.locator(".menu-text").allTextContents(), labels);
      assert.equal(await section.locator(`[data-menu-key="${keys.at(-1)}"]`).getAttribute("data-menu-level"), "1");
    }
    assert.equal(await page.locator('[data-menu-key="photoNew"],[data-menu-key="svcStaffNew"]').count(), 0);
    report.checks.push("both menu groups match the requested ordering, with direct client page entries; extra My Commission levels and create pages are absent");
    await page.locator('[data-menu-key="svcStaff"]').click();
    await page.locator('[data-page-key="svcStaff"]').waitFor();
    await page.getByRole("button", { name: "新增客服", exact: true }).click();
    const serviceDialog = page.getByRole("dialog", { name: "新增客服", exact: true });
    await serviceDialog.waitFor();
    await serviceDialog.getByPlaceholder("与身份证一致").fill("QA新增客服");
    await serviceDialog.getByPlaceholder("13800000000", { exact: true }).fill("13800000011");
    await serviceDialog.getByPlaceholder("填写客服登录账号").fill("qa-service-modal");
    await serviceDialog.getByPlaceholder("8–128位，包含字母和数字").fill("QaService2026!");
    await serviceDialog.getByRole("spinbutton", { name: "链接有效期（天）", exact: true }).fill("9");
    await serviceDialog.getByRole("spinbutton", { name: "结算等待期（天）", exact: true }).fill("4");
    await checkDialogGeometry(serviceDialog, ".svc-form-dialog", "保存并生成分成规则", "service");
    await serviceDialog.screenshot({ path: path.join(output, "service-dialog-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkDialogGeometry(serviceDialog, ".svc-form-dialog", "保存并生成分成规则", "service");
    await serviceDialog.screenshot({ path: path.join(output, "service-dialog-mobile.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1512, height: 1100 });
    await serviceDialog.getByRole("button", { name: "保存并生成分成规则", exact: true }).click();
    await serviceDialog.getByText("测试账号已存在，请更换账号", { exact: true }).waitFor();
    assert.equal(await serviceDialog.getByPlaceholder("与身份证一致").inputValue(), "QA新增客服");
    assert.equal(await serviceDialog.getByPlaceholder("8–128位，包含字母和数字").inputValue(), "QaService2026!");
    const serviceBefore = listGets("/api/svc/staff");
    await serviceDialog.getByRole("button", { name: "保存并生成分成规则", exact: true }).click();
    await serviceDialog.waitFor({ state: "hidden" });
    await page.locator('[data-page-key="svcStaff"] .el-table').getByText("QA新增客服", { exact: true }).waitFor();
    assert.ok(listGets("/api/svc/staff") > serviceBefore);
    await page.screenshot({ path: path.join(output, "service-list-created.png"), fullPage: true, animations: "disabled" });
    report.checks.push("customer-service modal preserves all form data on rejected creation; successful retry closes it and GET refresh renders the new row");
    await page.getByRole("button", { name: "新增客服", exact: true }).click();
    await serviceDialog.waitFor(); assert.equal(await serviceDialog.getByPlaceholder("8–128位，包含字母和数字").inputValue(), "");
    await serviceDialog.getByRole("button", { name: "取消", exact: true }).click();
    await serviceDialog.waitFor({ state: "hidden" });
    await page.locator('[data-menu-key="photoParty"]').click();
    await page.locator('[data-page-key="photoParty"]').waitFor();
    await page.getByRole("button", { name: "新增摄影师", exact: true }).click();
    const photoDialog = page.getByRole("dialog", { name: "新增摄影师", exact: true });
    await photoDialog.waitFor();
    assert.equal(await photoDialog.getByRole("radio", { name: "新建登录账号", exact: true }).isChecked(), true);
    assert.equal(await formInput(photoDialog, /^登录密码$/).isVisible(), true);
    await photoDialog.getByPlaceholder("摄影师姓名").fill("QA新增摄影师");
    await photoDialog.getByPlaceholder("全平台唯一", { exact: true }).fill("13800000012");
    await formInput(photoDialog, /^登录账号$/).fill("qa-photo-modal");
    await formInput(photoDialog, /^登录密码$/).fill("QaPhoto2026!");
    await photoDialog.locator("textarea").fill("浏览器弹窗新增验证");
    await checkDialogGeometry(photoDialog, ".photo-create-dialog", "保存摄影师档案", "photo");
    await photoDialog.screenshot({ path: path.join(output, "photo-dialog-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkDialogGeometry(photoDialog, ".photo-create-dialog", "保存摄影师档案", "photo");
    await photoDialog.screenshot({ path: path.join(output, "photo-dialog-mobile.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1512, height: 1100 });
    await photoDialog.getByRole("button", { name: "保存摄影师档案", exact: true }).click();
    await photoDialog.locator(".photo-error").getByText("测试摄影账号已存在", { exact: true }).waitFor();
    assert.equal(await photoDialog.getByPlaceholder("摄影师姓名").inputValue(), "QA新增摄影师");
    assert.equal(await formInput(photoDialog, /^登录密码$/).inputValue(), "QaPhoto2026!");
    const photoBefore = listGets("/api/photo/party");
    await photoDialog.getByRole("button", { name: "保存摄影师档案", exact: true }).click();
    await photoDialog.waitFor({ state: "hidden" });
    await page.locator('[data-page-key="photoParty"] .el-table').getByText("QA新增摄影师", { exact: true }).waitFor();
    assert.ok(listGets("/api/photo/party") > photoBefore);
    await page.screenshot({ path: path.join(output, "photo-list-created.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "新增摄影师", exact: true }).click();
    await photoDialog.waitFor(); assert.equal(await formInput(photoDialog, /^登录密码$/).inputValue(), "");
    await formInput(photoDialog, /^登录密码$/).fill("StalePhoto2026!");
    await photoDialog.locator(".el-radio").filter({ hasText: "关联已有账号" }).click();
    assert.equal(await formInput(photoDialog, /^登录密码$/).count(), 0);
    await photoDialog.locator(".el-radio").filter({ hasText: "新建登录账号" }).click();
    assert.equal(await formInput(photoDialog, /^登录密码$/).inputValue(), "", "switching to link mode clears the previous password");
    await photoDialog.locator(".el-radio").filter({ hasText: "关联已有账号" }).click();
    await photoDialog.getByPlaceholder("摄影师姓名").fill("QA关联摄影师");
    await photoDialog.getByPlaceholder("全平台唯一", { exact: true }).fill("13800000013");
    await formInput(photoDialog, /^登录账号$/).fill("  qa-existing-photo  ");
    await photoDialog.locator("textarea").fill("关联已开通摄影师账号的浏览器验证");
    await checkDialogGeometry(photoDialog, ".photo-create-dialog", "保存摄影师档案", "photo-link");
    await photoDialog.locator(".photo-account-section").scrollIntoViewIfNeeded();
    await photoDialog.screenshot({ path: path.join(output, "photo-link-dialog-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkDialogGeometry(photoDialog, ".photo-create-dialog", "保存摄影师档案", "photo-link");
    await photoDialog.locator(".photo-account-section").scrollIntoViewIfNeeded();
    await photoDialog.screenshot({ path: path.join(output, "photo-link-dialog-mobile.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1512, height: 1100 });
    const linkBefore = listGets("/api/photo/party");
    await photoDialog.getByRole("button", { name: "保存摄影师档案", exact: true }).click();
    await photoDialog.locator(".photo-error").getByText("测试已有账号尚未启用", { exact: true }).waitFor();
    assert.equal(await photoDialog.getByRole("radio", { name: "关联已有账号", exact: true }).isChecked(), true);
    assert.equal(await photoDialog.getByPlaceholder("摄影师姓名").inputValue(), "QA关联摄影师");
    assert.equal(await formInput(photoDialog, /^登录账号$/).inputValue(), "  qa-existing-photo  ");
    assert.equal(await formInput(photoDialog, /^登录密码$/).count(), 0);
    assert.equal(listGets("/api/photo/party"), linkBefore, "rejected links do not refresh or close the form");
    await photoDialog.getByRole("button", { name: "保存摄影师档案", exact: true }).click();
    await photoDialog.waitFor({ state: "hidden" });
    await page.locator('[data-page-key="photoParty"] .el-table').getByText("QA关联摄影师", { exact: true }).waitFor();
    assert.ok(listGets("/api/photo/party") > linkBefore);
    report.checks.push("existing photographer accounts link without a password; switching modes clears secrets, rejected links retain the draft, and a successful retry closes the dialog and refreshes the list");
    await page.getByRole("button", { name: "新增摄影师", exact: true }).click();
    await photoDialog.waitFor();
    assert.equal(await photoDialog.getByRole("radio", { name: "新建登录账号", exact: true }).isChecked(), true);
    assert.equal(await formInput(photoDialog, /^登录账号$/).inputValue(), "");
    assert.equal(await formInput(photoDialog, /^登录密码$/).inputValue(), "");
    await photoDialog.getByRole("button", { name: "取消", exact: true }).click();
    await photoDialog.waitFor({ state: "hidden" });
    report.checks.push("photographer modal preserves rejected form data, closes on success, GET refreshes the list, and clears secrets on reopen/cancel");
    assert.deepEqual(report.pageErrors, []); report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.failure = error.stack || String(error);
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true, animations: "disabled" }).catch(() => {});
    throw error;
  }
});
