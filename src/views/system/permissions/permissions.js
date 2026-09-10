/* System permission management page.
 * The page owns its state so it can be mounted by the async page registry
 * without expanding the shared app state or coupling to a specific backend.
 */
(function () {
  const { computed, onMounted, reactive, ref } = Vue;
  const ROLE_COLLECTION = "roles";
  const MENU_COLLECTION = "menus";
  const USER_COLLECTION = "users";
  const ACTIONS = [
    { key: "view", label: "查看基础数据" },
    { key: "dashboard", label: "访问经营看板" },
    { key: "dashboardAll", label: "查看总部经营数据" },
    { key: "dashboardShop", label: "查看商家经营数据" },
    { key: "orderAll", label: "查看全部订单" },
    { key: "orderSelf", label: "查看本人订单" },
    { key: "orderStatus", label: "变更订单状态" },
    { key: "orderEdit", label: "编辑订单" },
    { key: "dispatch", label: "订单派单权限" },
    { key: "assign", label: "派单" },
    { key: "transfer", label: "转交" },
    { key: "cancelOrder", label: "取消订单" },
    { key: "financeReview", label: "财务审核" },
    { key: "staff", label: "人员数据管理" },
    { key: "shop", label: "商家数据管理" },
    { key: "shopEdit", label: "管理商家" },
    { key: "content", label: "内容数据管理" },
    { key: "contentEdit", label: "编辑内容" },
    { key: "shootUpdate", label: "更新拍摄任务" },
    { key: "system", label: "系统配置" },
    { key: "export", label: "导出" },
    { key: "permissionManage", label: "权限管理" }
  ];

  const text = (value, fallback = "") => value === undefined || value === null ? fallback : String(value);
  const unique = (items) => [...new Set((Array.isArray(items) ? items : []).map(text).filter(Boolean))];
  const unwrapRows = (value) => {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.rows)) return value.rows;
    return [];
  };
  const menuLabel = (key, fallback = "未命名菜单") => {
    const source = (window.LXM_CONFIG?.menus || []).find((item) => item && item.key === key);
    return source?.label || fallback;
  };
  const roleLabel = (key, fallback = "未命名角色") => window.LXM_CONFIG?.roles?.[key]?.name || fallback;

  function fallbackMenus() {
    return (window.LXM_CONFIG?.menus || []).map((item, index) => ({
      id: item.key,
      key: item.key,
      name: item.label,
      label: item.label,
      parentId: item.parentId || "",
      group: item.group || "",
      sort: item.sort === undefined ? index + 1 : item.sort,
      type: item.type || "menu",
      status: item.status || "启用"
    }));
  }

  function fallbackRoles() {
    return Object.entries(window.LXM_CONFIG?.roles || {}).map(([key, item]) => ({
      id: key,
      key,
      name: item.name || key,
      description: item.description || `${item.name || key}可访问的后台角色`,
      menus: unique(item.menus),
      actions: unique(item.actions),
      status: item.status || "启用"
    }));
  }

  function defaultUser() {
    return { id: "", name: "", account: "", phone: "", email: "", role: "service", status: "启用", password: "", permissionKeys: [] };
  }

  function setup(ctx) {
    const { data, roleProfile, state } = ctx;
    const { ElMessage, ElMessageBox } = ElementPlus;
    const activeTab = ref("menus");
    const loading = ref(false);
    const saving = ref(false);
    const readOnly = computed(() => state.role !== "super");
    const canWrite = computed(() => !readOnly.value);
    const menuRows = ref(fallbackMenus());
    const roleRows = ref(fallbackRoles());
    const userRows = ref([]);
    const menuFilter = ref("");
    const userFilter = reactive({ keyword: "", role: "", status: "" });
    const selectedRoleId = ref("");
    const menuDialog = ref(false);
    const roleDialog = ref(false);
    const userDialog = ref(false);
    const menuForm = reactive({ id: "", key: "", name: "", parentId: "", group: "", routeKey: "dashboard", type: "menu", sort: 1, status: "启用" });
    const roleForm = reactive({ id: "", key: "", name: "", description: "", menus: [], actions: [], status: "启用" });
    const userForm = reactive(defaultUser());

    const filteredMenus = computed(() => {
      const keyword = menuFilter.value.trim().toLowerCase();
      if (!keyword) return menuRows.value;
      return menuRows.value.filter((row) => JSON.stringify(row).toLowerCase().includes(keyword));
    });
    const filteredUsers = computed(() => {
      const keyword = userFilter.keyword.trim().toLowerCase();
      return userRows.value.filter((row) => {
        const matchesKeyword = !keyword || JSON.stringify(row).toLowerCase().includes(keyword);
        const matchesRole = !userFilter.role || row.role === userFilter.role;
        const matchesStatus = !userFilter.status || (row.status || "启用") === userFilter.status;
        return matchesKeyword && matchesRole && matchesStatus;
      });
    });
    const selectedRole = computed(() => roleRows.value.find((row) => row.id === selectedRoleId.value) || null);
    const menuOptions = computed(() => menuRows.value.filter((row) => row.id !== menuForm.id));
    const routeOptions = computed(() => {
      const labels = new Map((window.LXM_CONFIG?.menus || []).map((item) => [String(item.key), item.label || item.key]));
      const keys = Array.isArray(window.LXM_CONFIG?.routeMenuKeys) ? window.LXM_CONFIG.routeMenuKeys : [];
      return keys.map((key) => ({ key: String(key), label: labels.get(String(key)) || String(key) }));
    });
    const activeMenuCount = computed(() => menuRows.value.filter((row) => (row.status || "启用") === "启用").length);
    const activeRoleCount = computed(() => roleRows.value.filter((row) => (row.status || "启用") === "启用").length);

    function normalizeRows(rows, prefix) {
      return unwrapRows(rows).map((row, index) => ({
        ...(row || {}),
        id: text(row?.id || row?._id || row?.key || `${prefix}-${index + 1}`)
      }));
    }

    function setRows(target, rows, fallback, useFallback = false, prefix = "permission") {
      target.value = useFallback ? normalizeRows(fallback(), prefix) : normalizeRows(rows, prefix);
    }

    async function loadCollection(key, target, fallback) {
      const loader = key === MENU_COLLECTION ? window.LXM_PERMISSIONS?.menus
        : key === ROLE_COLLECTION ? window.LXM_PERMISSIONS?.roles
          : window.LXM_PERMISSIONS?.users;
      if (typeof loader !== "function" || !window.LXM_AUTH?.hasSession?.()) {
        setRows(target, [], fallback, false, key);
        return false;
      }
      try {
        setRows(target, await loader(), fallback, false, key);
        return true;
      } catch (error) {
        console.warn(`[permissions] load ${key} failed`, error);
        // An authenticated page must never substitute bundled demo rows for a
        // denied or unavailable permission service.
        setRows(target, [], fallback, false, key);
        return false;
      }
    }

    async function loadUsers() {
      await loadCollection(USER_COLLECTION, userRows, () => data?.staff || []);
    }

    async function loadAll() {
      loading.value = true;
      try {
        await Promise.all([
          loadCollection(MENU_COLLECTION, menuRows, fallbackMenus),
          loadCollection(ROLE_COLLECTION, roleRows, fallbackRoles),
          loadUsers()
        ]);
        if (!selectedRoleId.value && roleRows.value.length) selectedRoleId.value = roleRows.value[0].id;
      } finally {
        loading.value = false;
      }
    }

    function ensureWriteAccess() {
      if (canWrite.value) return true;
      ElMessage.warning("当前账号没有权限管理写入权限");
      return false;
    }

    function requireRemoteWrite(method) {
      if (!window.LXM_AUTH?.hasSession?.() || typeof window.LXM_PERMISSIONS?.[method] !== "function") {
        throw new Error("当前未连接真实权限数据服务，不能保存");
      }
      return window.LXM_PERMISSIONS[method];
    }

    function openMenu(row = null) {
      if (!ensureWriteAccess()) return;
      Object.assign(menuForm, row ? { ...row, routeKey: row.routeKey || row.targetKey || row.key } : { id: "", key: "", name: "", parentId: "", group: "系统安全", routeKey: routeOptions.value[0]?.key || "dashboard", type: "menu", sort: menuRows.value.length + 1, status: "启用" });
      menuDialog.value = true;
    }

    async function saveMenu() {
      if (!ensureWriteAccess() || !menuForm.key.trim() || !menuForm.name.trim() || !text(menuForm.routeKey).trim()) return ElMessage.warning("请填写菜单标识、菜单名称并选择目标页面");
      saving.value = true;
      try {
        const payload = { ...menuForm, key: menuForm.key.trim(), name: menuForm.name.trim(), routeKey: text(menuForm.routeKey).trim(), sort: Number(menuForm.sort || 0) };
        const write = requireRemoteWrite(menuForm.id ? "updateMenu" : "createMenu");
        const saved = menuForm.id ? await write(menuForm.id, payload) : await write(payload);
        const row = saved?.data || saved || payload;
        if (menuForm.id) {
          const index = menuRows.value.findIndex((item) => item.id === menuForm.id);
          if (index >= 0) menuRows.value.splice(index, 1, { ...menuRows.value[index], ...row });
        } else {
          menuRows.value.unshift({ ...row, id: row.id || row.key });
        }
        menuDialog.value = false;
        ElMessage.success("菜单配置已保存");
      } catch (error) {
        ElMessage.error(error?.message || "菜单保存失败，请检查权限或数据连接");
      } finally {
        saving.value = false;
      }
    }

    async function toggleMenu(row, enabled) {
      if (!ensureWriteAccess()) return;
      const previousStatus = row.status || "启用";
      const nextStatus = enabled === undefined ? (previousStatus === "启用" ? "停用" : "启用") : (enabled ? "启用" : "停用");
      try {
        const saved = await requireRemoteWrite("updateMenu")(row.id, { status: nextStatus });
        Object.assign(row, saved?.data || saved || { status: nextStatus });
        ElMessage.success(`菜单已${nextStatus}`);
      } catch (error) {
        row.status = previousStatus;
        ElMessage.error(error?.message || "菜单状态保存失败");
      }
    }

    async function deleteMenu(row) {
      if (!ensureWriteAccess()) return;
      try {
        await ElMessageBox.confirm(`删除菜单“${row.name || row.label || row.key}”后，已授权该菜单的角色需要重新配置。`, "删除菜单", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" });
        await requireRemoteWrite("deleteMenu")(row.id);
        menuRows.value = menuRows.value.filter((item) => item.id !== row.id);
        ElMessage.success("菜单已删除");
      } catch (error) {
        if (error === "cancel" || error === "close") return;
        ElMessage.error(error?.message || "菜单删除失败，请先解除角色授权");
      }
    }

    function selectRole(row) {
      selectedRoleId.value = row.id;
      Object.assign(roleForm, { ...row, menus: unique(row.menus), actions: unique(row.actions) });
    }

    function openRole(row = null) {
      if (!ensureWriteAccess()) return;
      const source = row || { id: "", key: "", name: "", description: "", menus: [], actions: ["view"], status: "启用" };
      Object.assign(roleForm, { ...source, menus: unique(source.menus), actions: unique(source.actions) });
      roleDialog.value = true;
    }

    function editSelectedRole() {
      if (selectedRole.value) openRole(selectedRole.value);
    }

    async function saveRole() {
      if (!ensureWriteAccess() || !roleForm.key.trim() || !roleForm.name.trim()) return ElMessage.warning("请填写角色标识和角色名称");
      saving.value = true;
      try {
        const payload = { ...roleForm, key: roleForm.key.trim(), name: roleForm.name.trim(), menus: unique(roleForm.menus), actions: unique(roleForm.actions) };
        const write = requireRemoteWrite(roleForm.id ? "updateRole" : "createRole");
        const saved = roleForm.id ? await write(roleForm.id, payload) : await write(payload);
        const row = saved?.data || saved || payload;
        if (roleForm.id) {
          const index = roleRows.value.findIndex((item) => item.id === roleForm.id);
          if (index >= 0) roleRows.value.splice(index, 1, { ...roleRows.value[index], ...row });
        } else {
          roleRows.value.unshift({ ...row, id: row.id || row.key });
        }
        selectedRoleId.value = row.id || roleForm.id || row.key;
        roleDialog.value = false;
        ElMessage.success("角色授权已保存");
      } catch (error) {
        ElMessage.error(error?.message || "角色保存失败，请检查权限或数据连接");
      } finally {
        saving.value = false;
      }
    }

    async function toggleRole(row) {
      if (!ensureWriteAccess()) return;
      const nextStatus = (row.status || "启用") === "启用" ? "停用" : "启用";
      try {
        const saved = await requireRemoteWrite("updateRole")(row.id, { status: nextStatus });
        Object.assign(row, saved?.data || saved || { status: nextStatus });
        ElMessage.success(`角色已${nextStatus}`);
      } catch (error) {
        ElMessage.error(error?.message || "角色状态保存失败");
      }
    }

    async function deleteRole(row) {
      if (!ensureWriteAccess()) return;
      try {
        await ElMessageBox.confirm(`删除角色“${row.name}”后无法恢复。请先将该角色下的人员调整到其他角色。`, "删除角色", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" });
        await requireRemoteWrite("deleteRole")(row.id);
        roleRows.value = roleRows.value.filter((item) => item.id !== row.id);
        selectedRoleId.value = roleRows.value[0]?.id || "";
        ElMessage.success("角色已删除");
      } catch (error) {
        if (error === "cancel" || error === "close") return;
        ElMessage.error(error?.message || "角色删除失败，请先解除人员绑定");
      }
    }

    function openUser(row = null) {
      if (!ensureWriteAccess()) return;
      Object.assign(userForm, row ? { ...row, password: "" } : defaultUser());
      userForm.permissionKeys = unique(userForm.permissionKeys || userForm.permissions);
      userDialog.value = true;
    }

    function userRoleName(row) { return roleLabel(row.role, row.roleName || row.role); }

    async function saveUser() {
      if (!ensureWriteAccess() || !userForm.name.trim() || !userForm.account.trim() || !userForm.role) return ElMessage.warning("请填写姓名、登录账号并选择角色");
      if (!userForm.id && !userForm.password) return ElMessage.warning("新增人员必须设置登录密码");
      saving.value = true;
      try {
        const payload = { ...userForm, name: userForm.name.trim(), account: userForm.account.trim(), permissionKeys: unique(userForm.permissionKeys) };
        if (!payload.password) delete payload.password;
        const write = requireRemoteWrite(userForm.id ? "updateUser" : "createUser");
        const saved = userForm.id ? await write(userForm.id, payload) : await write(payload);
        const row = saved?.data || saved || payload;
        delete row.password;
        if (userForm.id) {
          const index = userRows.value.findIndex((item) => item.id === userForm.id);
          if (index >= 0) userRows.value.splice(index, 1, { ...userRows.value[index], ...row });
        } else {
          userRows.value.unshift({ ...row, id: row.id || `staff-${Date.now()}` });
        }
        userDialog.value = false;
        ElMessage.success("人员信息已保存");
      } catch (error) {
        ElMessage.error(error?.message || "人员保存失败，请检查权限或数据连接");
      } finally {
        saving.value = false;
      }
    }

    async function toggleUser(row) {
      if (!ensureWriteAccess()) return;
      const nextStatus = (row.status || "启用") === "启用" ? "停用" : "启用";
      try {
        const saved = nextStatus === "停用"
          ? await requireRemoteWrite("disableUser")(row.id)
          : await requireRemoteWrite("enableUser")(row.id);
        Object.assign(row, saved?.data || saved || { status: nextStatus });
        ElMessage.success(`人员账号已${nextStatus}`);
      } catch (error) {
        ElMessage.error(error?.message || "人员状态保存失败");
      }
    }

    async function deleteUser(row) {
      if (!ensureWriteAccess()) return;
      try {
        await ElMessageBox.confirm(`删除人员“${row.name || row.account}”会同时删除其后台登录账号，且无法恢复。`, "删除人员", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" });
        await requireRemoteWrite("deleteUser")(row.id);
        userRows.value = userRows.value.filter((item) => item.id !== row.id);
        ElMessage.success("人员已删除");
      } catch (error) {
        if (error === "cancel" || error === "close") return;
        ElMessage.error(error?.message || "人员删除失败");
      }
    }

    onMounted(loadAll);
    return {
      activeTab, loading, saving, readOnly, canWrite, menuRows, roleRows, userRows,
      menuFilter, userFilter, filteredMenus, filteredUsers, selectedRole,
      menuOptions, routeOptions, activeMenuCount, activeRoleCount, ACTIONS, menuForm, roleForm, userForm,
      menuDialog, roleDialog, userDialog, selectedRoleId,
      openMenu, saveMenu, toggleMenu, deleteMenu, selectRole, openRole, editSelectedRole, saveRole, toggleRole, deleteRole,
      openUser, saveUser, toggleUser, deleteUser, userRoleName, menuLabel, roleLabel, loadAll
    };
  }

  window.LXM_PAGES.register({
    key: "permissions",
    component: "LxmPagePermissions",
    group: "system",
    title: "权限管理",
    description: "菜单配置、角色授权和人员账号管理",
    styleScope: "page-route-permissions",
    setup
  });
})();
