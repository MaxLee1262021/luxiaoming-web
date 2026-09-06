// 登录鉴权与角色切换
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    canPreviewRoles,
    contentKeys,
    currentOperatorName,
    data,
    log,
    menus,
    resetPageState,
    roleName,
    roleProfile,
    state
  } = ctx;

async function login() {
  state.loading = true;
  const account = (state.login.account || "").trim();
  const password = state.login.password || "";
  try {
    const base = (window.LXM_API_CONFIG && window.LXM_API_CONFIG.base) || "/api";
    let j = null, netErr = false;
    try {
      const r = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, password })
      });
      j = await r.json().catch(() => null);
    } catch (e) {
      netErr = true;
    }
    if (j && j.ok === true) { applyLogin(j); return; }
    if (netErr) {
      // 无后端服务：用本地演示数据（含明文密码）兜底比对，仅用于离线演示。
      const staff = (data.staff || []).find((u) => u && u.account === account && u.password === password);
      const merchant = (data.shops || []).find((s) => s && s.account === account && s.password === password);
      // 离线兜底同样校验账号状态：停用人员 / 暂停合作商家不允许登录（与服务端拦截同一规则）。
      if (staff && staff.status === "停用") {
        log("登录拦截", "后台", `停用人员「${staff.name || account}」密码正确但被状态拦截（离线模式）`, account, { level: "高" });
        return ElMessage.error("该账号已被停用，请联系管理员启用后再登录");
      }
      if (merchant && ["暂停合作", "已终止", "停用"].includes(merchant.status || "")) {
        log("登录拦截", "后台", `商家「${merchant.name || account}」合作状态为「${merchant.status}」，登录被拦截（离线模式）`, account, { level: "高" });
        return ElMessage.error("该商家合作已暂停或终止，账号暂无法登录");
      }
      if (staff || merchant) {
        applyLogin({
          role: merchant ? "merchant" : (staff.role || "super"),
          account,
          name: (staff && staff.name) || (merchant && merchant.name) || account,
          staffId: (staff && staff.id) || (merchant && merchant.id) || "st1"
        });
        return;
      }
    }
    // 登录失败留痕（无论服务端拒绝还是离线兜底失败），审计里可追溯到具体账号。
    log("登录失败", "后台", `账号「${account}」登录失败`, account, { level: "高" });
    ElMessage.error((j && j.error) || "账号或密码错");
  } catch (e) {
    ElMessage.error("登录失败，请重试");
  } finally {
    state.loading = false;
  }
}
function applyLogin(j) {
  state.authed = true;
  state.role = j.role || "super";
  if (j.role === "merchant") LXM_CONFIG.roles.merchant.shopId = j.staffId;
  state.loginRole = state.role;
  state.currentStaffId = j.staffId || "st1";
  state.currentAccount = j.account || state.login.account || "";
  state.previewRole = state.role;
  resetPageState();
  state.active = roleProfile.value.home;
  log("登录", "后台", `${j.name || j.account} 登录`);
  ElMessage.success("登录成功");
}

// 打开自助改密弹窗（顶栏用户菜单入口），清空上一次输入。
function openChangePwd() {
  state.changePwd = { open: true, oldPwd: "", newPwd: "", confirmPwd: "", loading: false };
}
// 实时密码强度：0 空 / 1-2 弱 / 3 中 / 4 强，供强度条与文案反馈。
function passwordStrength(pwd) {
  if (!pwd) return { score: 0, label: "", color: "#e2e8f0", tip: "请输入新密码" };
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
  if (/\d/.test(pwd)) score++;
  if (/[^a-zA-Z0-9]/.test(pwd)) score++;
  score = Math.min(4, score);
  const map = [
    { label: "弱", color: "#EF4444", tip: "密码强度过低，建议加长并混合大小写与符号" },
    { label: "弱", color: "#EF4444", tip: "建议至少 8 位并同时包含字母和数字" },
    { label: "中", color: "#F59E0B", tip: "还不错，可再加长或加入特殊字符" },
    { label: "强", color: "#10B981", tip: "密码强度良好" },
    { label: "很强", color: "#10B981", tip: "密码强度优秀" }
  ];
  return { score, ...map[score] };
}
// 账号密码强度校验（与服务端 validatePasswordStrength 同一规则）：返回中文错误文案，空串=通过。
function accountPasswordError(pwd) {
  if (!pwd || typeof pwd !== "string") return "请设置登录密码（至少 8 位，含字母和数字）";
  if (pwd.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) return "密码需同时包含字母和数字";
  return "";
}
// 随机临时密码（Lxm + 6 位数字）：天然满足强度规则，重置密码时一次性展示给管理员转达。
function generateTempPassword() {
  return "Lxm" + String(Math.floor(100000 + Math.random() * 900000));
}
// 账号资料写回服务端：服务端会自动把明文密码哈希落库；密码留空则不下发该字段（= 不改密码）。
async function persistAccountToCloud(key, row) {
  if (!ctx.isServerConnected() || !row) return;
  try {
    const doc = { ...row };
    if (!doc.password) delete doc.password;
    let res;
    if (row.id) {
      res = await window.LXM_CLOUD.update(key, row.id, doc);
      if (!res || res.error) res = await window.LXM_CLOUD.create(key, doc);
    } else {
      res = await window.LXM_CLOUD.create(key, doc);
    }
    if (res && res.error) throw new Error(res.error);
  } catch (e) {
    ElMessage.warning("账号已保存到本地，但同步服务端失败：" + (e && e.message ? e.message : e));
  }
}
// 跨四个账号集合（运营人员/商家/分销员/代理）按引用或 id 定位记录所属集合名。
function accountCollectionOf(row) {
  const pools = [["staff", data.staff], ["shops", data.shops], ["distributors", data.distributors], ["agents", data.agents]];
  for (const [key, list] of pools) {
    if ((list || []).some((x) => x === row || (row.id && x && x.id === row.id))) return key;
  }
  return "";
}
// 自助改密：前端做完整校验（原密码非空、新密码强度、两次一致、不与旧相同），
// 再交给后端 /api/auth/change-password 校验原密码并哈希落库；无后端时回退本地演示数据。
async function changePassword() {
  const cp = state.changePwd;
  if (!cp.oldPwd) return ElMessage.error("请输入原密码");
  if (cp.newPwd.length < 8 || !/[a-zA-Z]/.test(cp.newPwd) || !/\d/.test(cp.newPwd))
    return ElMessage.error("新密码至少 8 位，且需同时包含字母和数字");
  if (cp.newPwd !== cp.confirmPwd) return ElMessage.error("两次输入的新密码不一致");
  if (cp.newPwd === cp.oldPwd) return ElMessage.error("新密码不能与原密码相同");
  cp.loading = true;
  try {
    const account = state.currentAccount || state.login.account || "";
    const base = (window.LXM_API_CONFIG && window.LXM_API_CONFIG.base) || "/api";
    let j = null, netErr = false;
    try {
      const r = await fetch(`${base}/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, oldPassword: cp.oldPwd, newPassword: cp.newPwd })
      });
      j = await r.json().catch(() => null);
    } catch (e) {
      netErr = true;
    }
    if (j && j.ok === true) {
      cp.open = false;
      log("修改密码", "后台", "本人通过「修改密码」入口更换登录密码", currentOperatorName(), { level: "中" });
      return ElMessage.success("密码修改成功，请牢记新密码");
    }
    if (netErr) {
      // 离线演示模式：直接改本地集合里的明文密码（仅演示，不落库）。
      const pools = [data.staff, data.shops, data.distributors, data.agents];
      for (let i = 0; i < pools.length; i++) {
        const list = pools[i] || [];
        const rec = list.find((u) => u && u.account === account && u.password === cp.oldPwd);
        if (rec) {
          rec.password = cp.newPwd;
          cp.open = false;
          log("修改密码", "后台", "本人修改登录密码（离线演示模式，未落库）", currentOperatorName(), { level: "中" });
          return ElMessage.success("密码修改成功（演示模式，未连接服务端）");
        }
      }
      return ElMessage.error("原密码不正确或账号不存在");
    }
    ElMessage.error((j && j.error) || "密码修改失败");
  } finally {
    cp.loading = false;
  }
}
// 退出登录：清空会话态，回到登录页。
function logout() {
  state.authed = false;
  state.currentAccount = "";
  state.currentStaffId = "st1";
  state.role = "super";
  state.previewRole = "super";
  state.login.password = "";
  ElMessage.success("已退出登录");
}
function switchMenu(key, options = {}) {
  if (!roleProfile.value.menus.includes(key)) {
    ElMessage.warning("当前角色无权访问该页");
    return;
  }
  if (!options.preserveFilters) {
    state.selectedOrderIds = [];
    if (key === "logs") Object.assign(state.filters, { logUser: "", logModule: "", logLevel: "", logAction: "", keyword: "" });
    if (key !== "orders") Object.assign(state.filters, { status: "", financeStatus: "", afterSaleStatus: "", refundStatus: "", transferStatus: "", rescheduleStatus: "", assigneeId: "", photographerId: "", productType: "" });
    if (!contentKeys.includes(key)) Object.assign(state.filters, { contentStatus: "", contentSpotId: "", contentSeriesId: "" });
  }
  if (key === "videoProducts" && !options.preserveFilters) state.filters.shelfType = "video";
  if (key === "reconciliation" && ["super", "finance"].includes(state.role) && !options.preserveFilters) {
    Object.assign(state.filters, { cityId: "", agentId: "", distributorId: "", shopId: "" });
  }
  state.active = key;
}
function switchRole(key) {
  if (!canPreviewRoles.value) {
    ElMessage.warning("只有总部超管可以切换预览其他角色后台");
    return;
  }
  state.role = key;
  state.previewRole = key;
  state.currentStaffId = roleProfile.value.staffId || state.currentStaffId;
  resetPageState();
  if (key === "agent") {
    state.filters.agentId = roleProfile.value.agentId || "";
    state.filters.cityId = "";
  }
  state.active = roleProfile.value.home;
  log("切换角色", roleName(key), "超级管理员预览角色后");
}


  return {
    login,
    applyLogin,
    openChangePwd,
    passwordStrength,
    accountPasswordError,
    generateTempPassword,
    persistAccountToCloud,
    accountCollectionOf,
    changePassword,
    logout,
    switchMenu,
    switchRole
  };
});
