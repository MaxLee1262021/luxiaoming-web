// 账号管理（员工/代理/分销/商家/商家码）
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    accountCollectionOf,
    accountPasswordError,
    canManageShopBinding,
    cityName,
    commission,
    computed,
    currentOperatorName,
    data,
    distributorName,
    due,
    financeDue,
    generateTempPassword,
    isReconciliationEligible,
    log,
    orderSplit,
    persistAccountToCloud,
    roleName,
    roleProfile,
    state,
    syncShopDistributorRates,
    visibleDistributors
  } = ctx;

function isRemoteSession() {
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  return !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
}

const staffRows = computed(() => {
  let list = data.staff;
  if (state.filters.staffRole) list = list.filter((s) => s.role === state.filters.staffRole);
  if (state.filters.cityId) list = list.filter((s) => s.cityId === state.filters.cityId);
  if (state.filters.keyword) list = list.filter((s) => JSON.stringify(s).includes(state.filters.keyword));
  return list;
});
const distributorRows = computed(() => visibleDistributors.value.filter((d) => (!state.filters.cityId || d.cityId === state.filters.cityId) && (!state.filters.agentId || d.agentId === state.filters.agentId) && (!state.filters.keyword || JSON.stringify(d).includes(state.filters.keyword))));
function permissionText(row) {
  const custom = (row.permissionKeys || []).map((key) => (LXM_CONFIG.permissionMatrix.find((p) => p.key === key) || {}).name).filter(Boolean);
  if (custom.length) return custom.join("");
  if (row.role === "super") return "全平台数据、人员、渠道、内容、日志、回收站";
  if (row.role === "agent") return "仅自己代理城市，可看城市数据、管理分销员和商家";
  if (row.role === "distributor") return "仅自己拓展商家，可录入商家和查看收益";
  if (row.role === "service") return "处理订单、联系客人、接单、派单、取消订单";
  if (row.role === "finance") return "查看经营看板、订单只读、售后记录和月度对账；可导出财务权限内报表";
  if (row.role === "photo") return "仅查看本人任务，不能看商家来源和完整联系方式";
  if (row.role === "content") return "维护打卡点、拍摄风格、照片单品、素材、套餐、周边、首页";
  return "商家账号只看自己门店扫码、订单、成交和收益";
}
function defaultPermissionKeys(role) {
  return LXM_CONFIG.permissionMatrix.filter((p) => !!p[role]).map((p) => p.key);
}
function applyRoleDefaultPermissions() {
  if (!state.editStaff) return;
  state.editStaff.permissionKeys = defaultPermissionKeys(state.editStaff.role);
  if (state.editStaff.role === "photo") {
    state.editStaff.commissionRate = Number(state.editStaff.commissionRate || 20);
    state.editStaff.settlementCycle = state.editStaff.settlementCycle || "月结";
  }
  ElMessage.success("已套用该角色默认权限，可继续手动微调");
}
function openStaff(row = null) {
  // 编辑时密码栏置空（留空=不改）；新增时不再预置弱口令 "123456"，必须手动设置强密码。
  const base = row ? { ...row, password: "" } : { id: "", name: "", account: "", password: "", phone: "", role: "service", status: "启用", cityId: "city1", city: "长沙", agentId: "", distributorId: "", shopId: "", permissions: [] };
  base.permissionKeys = base.permissionKeys || defaultPermissionKeys(base.role);
  if (base.role === "photo") {
    base.commissionRate = Number(base.commissionRate || 20);
    base.settlementCycle = base.settlementCycle || "月结";
  }
  state.editStaff = base;
  state.staffDialog = true;
}
async function saveStaff() {
  const row = state.editStaff;
  if (!row.name || !row.account) return ElMessage.warning("请填写姓名和账号");
  // 密码规则：新增必填强密码；编辑填了才校验（留空=不修改）。
  const pwdError = accountPasswordError(row.password);
  if (!row.id && pwdError) return ElMessage.warning(pwdError);
  if (row.id && row.password && pwdError) return ElMessage.warning(pwdError);
  if (!row.password) delete row.password;
  row.city = cityName(row.cityId);
  if (row.role === "photo") {
    row.commissionRate = Number(row.commissionRate || 20);
    row.settlementCycle = row.settlementCycle || "月结";
  }
  let saved;
  const previous = row.id ? { ...(data.staff.find((s) => s.id === row.id) || {}) } : null;
  if (row.id) { saved = data.staff.find((s) => s.id === row.id); Object.assign(saved, row); }
  else { saved = { ...row, id: `st${Date.now()}` }; data.staff.unshift(saved); }
  const synced = await persistAccountToCloud("staff", saved);
  if (!synced && isRemoteSession()) {
    if (previous) Object.assign(saved, previous);
    else data.staff = data.staff.filter((item) => item !== saved);
    return;
  }
  state.staffDialog = false;
  log("保存人员", row.name, roleName(row.role));
  ElMessage.success("人员账号已保存");
}
async function resetPassword(row) {
  const tempPwd = generateTempPassword();
  try {
    await ElMessageBox.confirm(`将「${row.name}」的密码重置为随机临时密码（重置后仅显示一次，请转达对方尽快登录修改）。确认重置吗？`, "重置密码", { type: "warning", confirmButtonText: "确认重置", cancelButtonText: "取消" });
  } catch (e) { return; }
  // 联网模式：临时密码经服务端哈希落库后立即生效；失败则不落地，避免「提示已重置但服务端还是旧密码」。
  const key = accountCollectionOf(row);
  if (ctx.isServerConnected() && key) {
    try {
      const res = await window.LXM_CLOUD.update(key, row.id, { password: tempPwd });
      if (!res || res.error) throw new Error(res && res.error);
    } catch (e) {
      return ElMessage.error("重置失败，未能同步到服务端：" + (e && e.message ? e.message : e));
    }
  }
  row.password = tempPwd; // 本地同步（离线演示模式直接生效；联网模式刷新后由服务端下发剥离态）
  log("重置密码", row.name, "已重置为随机临时密码，请转达尽快登录修改", currentOperatorName(), { level: "中" });
  ElMessageBox.alert(`「${row.name}」的新密码：${tempPwd}`, "重置成功", { confirmButtonText: "我已记下", type: "success" });
}
// 停用/启用人员账号：停用后该账号立即无法登录后台（服务端与离线兜底登录均已拦截）。
// 专业决策：账号不做物理删除——订单、分成、对账、审计日志都关联人员 id，删人会断追溯链；
// 「停用」才是账号的正确生命周期终点，历史记录完整保留。
async function toggleStaffStatus(row) {
  const target = data.staff.find((s) => s.id === row.id);
  if (!target) return;
  const disabling = target.status !== "停用";
  if (disabling) {
    // 守卫一：不能停用当前登录者自己，否则当场把自己锁在门外。
    if (target.id === state.currentStaffId || (state.currentAccount && target.account === state.currentAccount))
      return ElMessage.warning("不能停用当前登录中的账号，如需停用请换其他管理员操作");
    // 守卫二：不能停用最后一个「启用中」的超级管理员，避免全后台无人可管。
    if (target.role === "super") {
      const activeSupers = data.staff.filter((s) => s.role === "super" && s.status !== "停用");
      if (activeSupers.length <= 1)
        return ElMessage.warning("不能停用唯一启用中的超级管理员，请先新增或启用另一位超管再操作");
    }
  }
  const verb = disabling ? "停用" : "启用";
  try {
    await ElMessageBox.confirm(
      disabling
        ? `停用后「${target.name}」将立即无法登录后台（不影响其历史订单与分成记录）。确认停用吗？`
        : `启用后「${target.name}」可凭原密码正常登录后台。确认启用吗？`,
      `${verb}账号`,
      { type: "warning", confirmButtonText: `确认${verb}`, cancelButtonText: "取消" }
    );
  } catch (e) { return; }
  const previousStatus = target.status;
  target.status = disabling ? "停用" : "启用";
  const synced = await persistAccountToCloud("staff", target);
  if (!synced && isRemoteSession()) {
    target.status = previousStatus;
    return;
  }
  log(`${verb}人员`, target.name, `账号已${verb}，${disabling ? "登录入口已同步关闭" : "恢复登录"}`, currentOperatorName(), { level: "中" });
  ElMessage.success(`已${verb}「${target.name}」的账号`);
}
function openDistributor(row = null) {
  const defaultAgentId = state.role === "agent" ? roleProfile.value.agentId : "agent1";
  const defaultCityId = state.role === "agent" ? roleProfile.value.cityId : "city1";
  state.editDistributor = row ? { ...row, password: "" } : { id: "", cityId: defaultCityId, agentId: defaultAgentId, name: "", phone: "", commissionRate: 5, settlementCycle: "月结", status: "启用", account: "", password: "" };
  state.distributorDialog = true;
}
async function saveDistributor() {
  const row = state.editDistributor;
  if (!row.name || !row.agentId) return ElMessage.warning("请填写分销员名称和所属代");
  const pwdError = accountPasswordError(row.password);
  if (!row.id && pwdError) return ElMessage.warning(pwdError);
  if (row.id && row.password && pwdError) return ElMessage.warning(pwdError);
  if (!row.password) delete row.password;
  delete row.contact;
  row.cityId = row.cityId || (data.agents.find((a) => a.id === row.agentId) || {}).cityId || "city1";
  row.settlementCycle = row.settlementCycle || "月结";
  let saved;
  const previous = row.id ? { ...(data.distributors.find((d) => d.id === row.id) || {}) } : null;
  if (row.id) { saved = data.distributors.find((d) => d.id === row.id); Object.assign(saved, row); }
  else { saved = { ...row, id: `dist${Date.now()}` }; data.distributors.unshift(saved); }
  const synced = await persistAccountToCloud("distributors", saved);
  if (!synced && isRemoteSession()) {
    if (previous) Object.assign(saved, previous);
    else data.distributors = data.distributors.filter((item) => item !== saved);
    return;
  }
  state.distributorDialog = false;
  log("保存分销", row.name, `分销比例 ${row.commissionRate}%`);
  ElMessage.success("分销员信息已保存");
}
function openShop(row = null) {
  if (!canManageShopBinding()) return ElMessage.warning("分销员只能查看总部绑定给自己的商家，不能新增或编辑商家");
  const defaultAgentId = state.role === "agent" ? roleProfile.value.agentId : "agent1";
  const defaultCityId = state.role === "agent" ? roleProfile.value.cityId : "city1";
  state.editShop = row ? { ...row, password: "" } : { id: "", name: "", cityId: defaultCityId, city: cityName(defaultCityId), district: "", shopId: `SHOP${Date.now().toString().slice(-4)}`, scene: "门店二维", qrPosition: "收银", commissionRate: 10, shareRatio: 10, settlementCycle: "月结", agentId: defaultAgentId, distributorIds: [], distributorRates: {}, account: "", password: "", contact: "", phone: "", address: "", status: "合作" };
  syncShopDistributorRates();
  state.shopDialog = true;
}
async function saveShop() {
  if (!canManageShopBinding()) return ElMessage.warning("分销员没有新增、编辑或绑定商家的权");
  const row = state.editShop;
  if (!row.name || !row.account) return ElMessage.warning("请填写商家名称和登录账号");
  const pwdError = accountPasswordError(row.password);
  if (!row.id && pwdError) return ElMessage.warning(pwdError);
  if (row.id && row.password && pwdError) return ElMessage.warning(pwdError);
  if (!row.password) delete row.password;
  row.city = cityName(row.cityId);
  row.distributorIds = row.distributorIds || [];
  row.distributorRates = row.distributorRates && typeof row.distributorRates === "object" ? row.distributorRates : {};
  Object.keys(row.distributorRates).forEach((k) => { if (!row.distributorIds.includes(k)) delete row.distributorRates[k]; });
  row.distributorIds.forEach((id) => {
    if (row.distributorRates[id] == null) {
      const d = data.distributors.find((x) => x.id === id);
      row.distributorRates[id] = d ? Number(d.commissionRate || 0) : 0;
    }
  });
  let saved;
  const previous = row.id ? { ...(data.shops.find((s) => s.id === row.id) || {}) } : null;
  if (row.id) { saved = data.shops.find((s) => s.id === row.id); Object.assign(saved, row); }
  else { saved = { ...row, id: `shop${Date.now()}` }; data.shops.unshift(saved); }
  const synced = await persistAccountToCloud("shops", saved);
  if (!synced && isRemoteSession()) {
    if (previous) Object.assign(saved, previous);
    else data.shops = data.shops.filter((item) => item !== saved);
    return;
  }
  state.shopDialog = false;
  log("保存商家", row.name, `分账比例 ${row.commissionRate || row.shareRatio}%，绑定分销员：${(row.distributorIds && row.distributorIds.length) ? row.distributorIds.map(distributorName).join("、") : "未绑"}`);
  ElMessage.success("商家信息已保存");
}
function openQr(row) {
  state.currentShop = row;
  state.qrDialog = true;
  state.qrPreview = null;
  state.qrPlacementType = "counter";
  state.qrCustomLabel = "";
  loadMerchantCodes();
  fetchMerchantCodeStats();
}
async function loadMerchantCodes() {
  if (!state.currentShop) return;
  try {
    const r = await fetch(`/api/merchant-codes?shopId=${encodeURIComponent(state.currentShop.shopId)}`);
    if (r.ok) state.merchantCodes = await r.json();
    else state.merchantCodes = [];
  } catch (e) {
    state.merchantCodes = [];
  }
}
async function fetchMerchantCodeStats() {
  if (!state.currentShop) return;
  try {
    const r = await fetch(`/api/merchant-codes/stats?shopId=${encodeURIComponent(state.currentShop.shopId)}`);
    if (r.ok) state.merchantCodeStats = await r.json();
  } catch (e) {}
}
async function generateMerchantQr() {
  if (!state.currentShop) return;
  const custom = (state.qrCustomLabel || "").trim();
  let placementType, placementLabel;
  if (custom) {
    placementType = "custom";
    placementLabel = custom;
  } else {
    const placement = state.qrPositions.find((p) => p.type === state.qrPlacementType) || { type: state.qrPlacementType, label: state.qrPlacementType };
    placementType = placement.type;
    placementLabel = placement.label;
  }
  state.qrGenerating = true;
  try {
    const r = await fetch("/api/merchant-code/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopId: state.currentShop.shopId, placementType, placementLabel })
    });
    const res = await r.json();
    if (res && res.success) {
      state.qrPreview = { codeId: res.codeId, qrImage: res.qrImage, placementType: res.placementType, placementLabel: res.placementLabel, existed: res.existed };
      ElMessage.success(res.existed ? "该位置码已存在，已展示已有码" : "二维码生成成功");
      loadMerchantCodes();
      fetchMerchantCodeStats();
    } else {
      ElMessage.error((res && res.error) || "生成失败");
    }
  } catch (e) {
    ElMessage.error("网络异常，生成失败");
  } finally {
    state.qrGenerating = false;
  }
}
function downloadMerchantQr(code) {
  const target = code || state.qrPreview;
  const url = (target && target.qrImage) || "";
  if (!url) return ElMessage.warning("该码暂无图片，请先生成");
  const a = document.createElement("a");
  a.href = url;
  const label = (target && target.placementLabel) || "qr";
  const name = (state.currentShop ? state.currentShop.name : "luxiaoming") + "_" + label;
  a.download = name + (url.indexOf("image/png") > -1 ? ".png" : ".svg");
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  log("下载商家二维码", state.currentShop && state.currentShop.name, name);
  ElMessage.success("已开始下载");
}
function shopStats(shopId) {
  const orders = data.orders.filter((o) => o.shopId === shopId && !o.deleted);
  const scans = data.scans.filter((s) => s.shopId === shopId);
  const eligibleOrders = orders.filter(isReconciliationEligible);
  return { scans: scans.length, orders: orders.length, amount: orders.reduce((s, o) => s + Number(o.totalAmount || 0), 0), commission: eligibleOrders.reduce((s, o) => s + orderSplit(o).shopAmount, 0), due: orders.reduce((s, o) => s + financeDue(o), 0) };
}
function shopQrUrl(row) {
  return LXM_SERVICE.qrUrl(row.shopId);
}


  return {
    staffRows,
    distributorRows,
    permissionText,
    defaultPermissionKeys,
    applyRoleDefaultPermissions,
    openStaff,
    saveStaff,
    resetPassword,
    toggleStaffStatus,
    openDistributor,
    saveDistributor,
    openShop,
    saveShop,
    openQr,
    loadMerchantCodes,
    fetchMerchantCodeStats,
    generateMerchantQr,
    downloadMerchantQr,
    shopStats,
    shopQrUrl
  };
});
