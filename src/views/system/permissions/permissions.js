/* System permission management page.
 * The page owns its state so it can be mounted by the async page registry
 * without expanding the shared app state or coupling to a specific backend.
 */
(function () {
  const { computed, onMounted, reactive, ref } = Vue;
  const ROLE_COLLECTION = "roles";
  const MENU_COLLECTION = "menus";
  const USER_COLLECTION = "staff";
  const ACTIONS = [
    { key: "view", label: "查看" },
    { key: "create", label: "新增" },
    { key: "edit", label: "编辑" },
    { key: "delete", label: "删除" },
    { key: "export", label: "导出" },
    { key: "approve", label: "审核" }
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
    return { id: "", name: "", account: "", phone: "", role: "service", status: "启用", password: "", permissionKeys: [] };
  }

  function setup(ctx) {
    const { ElMessage, data, roleProfile, state } = ctx;
    const activeTab = ref("menus");
    const loading = ref(false);
    const saving = ref(false);
    const readOnly = computed(() => state.role !== "super" && !roleProfile.value?.actions?.includes("permissionManage"));
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
    const menuForm = reactive({ id: "", key: "", name: "", parentId: "", group: "", type: "menu", sort: 1, status: "启用" });
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
      if (!window.LXM_CLOUD?.getColl || !window.LXM_AUTH?.hasSession?.()) {
        setRows(target, [], fallback, true, key);
        return false;
      }
      try {
        setRows(target, await window.LXM_CLOUD.getColl(key), fallback, false, key);
        return true;
      } catch (error) {
        if (error?.status !== 403) console.warn(`[permissions] load ${key} failed`, error);
        setRows(target, [], fallback, true, key);
        return false;
      }
    }

    async function loadUsers() {
      const loaded = await loadCollection(USER_COLLECTION, userRows, () => data?.staff || []);
      if (!loaded && Array.isArray(data?.staff)) userRows.value = data.staff.map((row) => ({ ...row }));
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
      if (!window.LXM_AUTH?.hasSession?.() || typeof window.LXM_CLOUD?.[method] !== "function") {
        throw new Error("当前未连接真实权限数据服务，不能保存");
      }
      return window.LXM_CLOUD[method];
    }

    function openMenu(row = null) {
      if (!ensureWriteAccess()) return;
      Object.assign(menuForm, row ? { ...row } : { id: "", key: "", name: "", parentId: "", group: "", type: "menu", sort: menuRows.value.length + 1, status: "启用" });
      menuDialog.value = true;
    }

    async function saveMenu() {
      if (!ensureWriteAccess() || !menuForm.key.trim() || !menuForm.name.trim()) return ElMessage.warning("请填写菜单标识和菜单名称");
      saving.value = true;
      try {
        const payload = { ...menuForm, key: menuForm.key.trim(), name: menuForm.name.trim(), sort: Number(menuForm.sort || 0) };
        const write = requireRemoteWrite(menuForm.id ? "update" : "create");
        const saved = menuForm.id ? await write(MENU_COLLECTION, menuForm.id, payload) : await write(MENU_COLLECTION, payload);
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

    async function toggleMenu(row) {
      if (!ensureWriteAccess()) return;
      const nextStatus = (row.status || "启用") === "启用" ? "停用" : "启用";
      try {
        const saved = await requireRemoteWrite("update")(MENU_COLLECTION, row.id, { status: nextStatus });
        Object.assign(row, saved?.data || saved || { status: nextStatus });
        ElMessage.success(`菜单已${nextStatus}`);
      } catch (error) {
        ElMessage.error(error?.message || "菜单状态保存失败");
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
        const write = requireRemoteWrite(roleForm.id ? "update" : "create");
        const saved = roleForm.id ? await write(ROLE_COLLECTION, roleForm.id, payload) : await write(ROLE_COLLECTION, payload);
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
        const saved = await requireRemoteWrite("update")(ROLE_COLLECTION, row.id, { status: nextStatus });
        Object.assign(row, saved?.data || saved || { status: nextStatus });
        ElMessage.success(`角色已${nextStatus}`);
      } catch (error) {
        ElMessage.error(error?.message || "角色状态保存失败");
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
        const write = requireRemoteWrite(userForm.id ? "update" : "create");
        const saved = userForm.id ? await write(USER_COLLECTION, userForm.id, payload) : await write(USER_COLLECTION, payload);
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
        const saved = await requireRemoteWrite("update")(USER_COLLECTION, row.id, { status: nextStatus });
        Object.assign(row, saved?.data || saved || { status: nextStatus });
        ElMessage.success(`人员账号已${nextStatus}`);
      } catch (error) {
        ElMessage.error(error?.message || "人员状态保存失败");
      }
    }

    onMounted(loadAll);
    return {
      activeTab, loading, saving, readOnly, canWrite, menuRows, roleRows, userRows,
      menuFilter, userFilter, filteredMenus, filteredUsers, selectedRole,
      menuOptions, activeMenuCount, activeRoleCount, ACTIONS, menuForm, roleForm, userForm,
      menuDialog, roleDialog, userDialog, selectedRoleId,
      openMenu, saveMenu, toggleMenu, selectRole, openRole, editSelectedRole, saveRole, toggleRole,
      openUser, saveUser, toggleUser, userRoleName, menuLabel, roleLabel, loadAll
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
