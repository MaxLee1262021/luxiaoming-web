"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createSvcMemoryStore, orderRow } = require("../../server/lib/svcStore.cjs");
const { createSvcWorkbench } = require("../../server/lib/svcWorkbench.cjs");
const core = require("../../server/lib/svcCore.cjs");
const { startBrowserFixture } = require("../../server/tests/fixtures/merchant-share-browser.cjs");

test("customer booking time defaults in both desks and manual changes preserve the original time", { skip: process.env.RUN_SVC_APPOINTMENT_BROWSER !== "1", timeout: 90000 }, async t => {
  const date = core.stamp(Date.now() + 2 * core.DAY).slice(0, 10);
  const requested = date + " 14:30:00", adjusted = date + " 16:45:00";
  // Match mini-program orders: the requested intent exists before a confirmed schedule.
  const orders = [1, 2, 3].map(index => orderRow({ id: "booking-" + index, orderNo: "QA-BOOKING-" + index,
    contactName: "预约时间测试客人", openid: "qa-booking-customer-" + index, category: "photo", productName: "测试旅拍",
    intentDate: date, intentTimePeriod: "14:30", appointmentAt: "", bookingDate: "", bookingTime: "", requested_time: null, schedule_time: null,
    service_status: "claimed", assignee_id: "qa-s1", svc_paid_processed: 1, service_managed: true,
    totalAmount: 100, depositDue: 20, depositPaid: 20, depositFinanceStatus: "confirmed", finalDue: 80, depositPaidAt: core.stamp(Date.now() - 3600000) }));
  const store = createSvcMemoryStore({ orders, staff: [{ id: "qa-s1", account_id: "qa-super", name: "测试客服", staff_status: "active" }], photographers: [] });
  const fixture = await startBrowserFixture({ customerService: { store, workbench: createSvcWorkbench({ store }) } });
  let browser, page;
  const errors = [], output = path.resolve(__dirname, "../../../outputs/booking-confirm-time-20261122");
  fs.mkdirSync(output, { recursive: true });
  t.after(async () => {
    try {
      if (page) await page.screenshot({ path: path.join(output, "last-state.png"), animations: "disabled" }).catch(() => {});
      fs.writeFileSync(path.join(output, "browser-check.json"), JSON.stringify({ testOnly: true, realDatabaseAccess: false, errors, orders: store.snapshot().orders.map(row => ({ order_no: row.order_no, requested_time: row.requested_time, schedule_time: row.schedule_time })), slotLogs: store.snapshot().slotLogs }, null, 2));
    } finally {
      await browser?.close();
      await fixture.close();
    }
  });
  const playwright = require(process.env.SVC_PLAYWRIGHT_MODULE || "playwright");
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.SVC_BROWSER_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  page = await browser.newPage({ viewport: { width: 1512, height: 1000 }, timezoneId: "Asia/Shanghai" });
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  const saved = index => store.snapshot().orders.find(row => row.order_no === "QA-BOOKING-" + index);
  const writes = () => fixture.requests.filter(request => request.method === "POST" && /\/slot\/confirm$/.test(request.pathname));
  await page.goto(fixture.url);
  await page.getByPlaceholder("账号", { exact: true }).fill(fixture.accounts.admin.account);
  await page.getByPlaceholder("密码", { exact: true }).fill(fixture.accounts.admin.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByPlaceholder("账号", { exact: true }).waitFor({ state: "hidden" });
  await page.locator('[data-menu-key="svcFollowup"]').click();
  const oldDesk = page.locator('[data-page-key="svcFollowup"]');
  const row = index => oldDesk.locator("tr").filter({ hasText: "QA-BOOKING-" + index });
  await row(1).getByRole("button", { name: "确认时间", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认拍摄时间", exact: true });
  const input = dialog.getByPlaceholder("选择或输入拍摄时间");
  assert.equal(await input.inputValue(), requested.slice(0, 16));
  assert.ok((await dialog.innerText()).includes("客人提交：" + requested));
  assert.equal(saved(1).schedule_time, null, "opening the form must not confirm the request");
  await dialog.screenshot({ path: path.join(output, "default-customer-time.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "确认时间", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(saved(1).schedule_time, requested);
  assert.equal(store.snapshot().slotLogs.length, 0, "keeping the customer's time needs no adjustment reason");

  await row(2).getByRole("button", { name: "确认时间", exact: true }).click();
  assert.equal(await input.inputValue(), requested.slice(0, 16));
  await input.fill(adjusted.slice(0, 16));
  await input.press("Tab");
  await dialog.getByRole("button", { name: "确认时间", exact: true }).click();
  await page.getByText("确认时间与用户提交值不同，请填写改期原因", { exact: true }).waitFor();
  assert.equal(writes().length, 1, "a changed time without a reason cannot submit");
  await dialog.locator("textarea").fill("已与客人沟通，调整行程时间");
  await dialog.screenshot({ path: path.join(output, "manual-adjustment.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "确认时间", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(saved(2).schedule_time, adjusted);
  assert.equal(saved(2).requested_time, requested);
  assert.equal(store.snapshot().slotLogs[0].from_time, requested);
  assert.equal(store.snapshot().slotLogs[0].to_time, adjusted);
  assert.equal(store.snapshot().slotLogs[0].reason, "已与客人沟通，调整行程时间");

  await page.getByRole("button", { name: "总工作台", exact: true }).click();
  const general = page.locator('[data-page-key="svcGeneralWorkbench"]');
  await general.locator("tr").filter({ hasText: "QA-BOOKING-3" }).getByRole("button", { name: "确认时间", exact: true }).click();
  const generalDialog = page.getByRole("dialog", { name: "确认拍摄时间", exact: true });
  const generalInput = generalDialog.getByPlaceholder("选择或输入拍摄时间");
  assert.equal(await generalInput.inputValue(), requested.slice(0, 16));
  await generalInput.fill(adjusted.slice(0, 16));
  await generalInput.press("Tab");
  await generalDialog.locator("textarea").fill("客人要求调整时间");
  await generalDialog.getByRole("button", { name: "确认时间", exact: true }).click();
  await generalDialog.waitFor({ state: "hidden" });
  assert.equal(saved(3).schedule_time, adjusted);
  assert.equal(saved(3).requested_time, requested);
  assert.equal(writes().length, 3);
  assert.deepEqual(errors, []);
});
