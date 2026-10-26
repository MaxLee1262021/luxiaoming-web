"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("后台品牌和权限页保留可见交互修复", () => {
  const shell = read("src/layout/app-shell.js");
  const login = read("src/views/login/login.html");
  const permissions = read("src/views/system/permissions/permissions.html");
  const permissionLogic = read("src/views/system/permissions/permissions.js");
  const shellStyles = read("src/styles/admin-ops.css");

  assert.match(shell, /<strong>麓小鸣旅拍<\/strong>/);
  assert.match(login, /<h1>麓小鸣旅拍<\/h1>/);
  assert.match(permissions, /permissions-overview-card/);
  assert.match(permissions, /@click\.stop="copyText\(/);
  assert.match(permissionLogic, /function onUserPhoneInput/);
  assert.match(permissionLogic, /1\[3-9\]\\d\{9\}/);
  assert.match(shellStyles, /\.lxm-topbar \.user-menu[\s\S]*position: absolute[\s\S]*right: 18px/);
  assert.match(permissions, /permissions-list-toolbar[\s\S]*新增人员/);
});

test("扫码明细使用可筛选的中文状态和空态文案", () => {
  const shell = read("src/layout/app-shell.js");
  const dashboard = read("src/app/05-dashboard.js");
  const state = read("src/app/01-core-state.js");

  assert.match(shell, /no-data-text="暂无位置数据"/);
  assert.match(shell, /empty-text="暂无扫码记录"/);
  assert.match(shell, /class="metric-filter-reset" plain/);
  assert.match(dashboard, /status: s\.orderId \? "已转化" : "浏览未下单"/);
  assert.match(state, /dashboardTab: "traffic"/);
});

test("照片留影详情轮播在后台装修页可选择、排序并导出", () => {
  const decor = read("src/views/operationConfig/mini-decor/mini-decor.html");
  const pageConfig = read("src/app/14-page-config.js");
  const builder = read("src/app/12-content-edit.js");

  assert.match(decor, /照片留影详情顶部轮播/);
  assert.match(decor, /movePageRelation\(entry\.field/);
  assert.match(pageConfig, /field: "sampleIds"/);
  assert.match(builder, /map\[page\.key\]\.sampleIds/);
});
