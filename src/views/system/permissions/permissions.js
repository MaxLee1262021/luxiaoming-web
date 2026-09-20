/* System permission management page.
 * The page owns its state so it can be mounted by the async page registry
 * without expanding the shared app state or coupling to a specific backend.
 */
(function () {
  const { computed, onMounted, reactive, ref } = Vue;
  const ROLE_COLLECTION = "roles";
  const MENU_COLLECTION = "menus";
  const USER_COLLECTION = "users";

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
      parentId: item.parentId ?? item.parentKey ?? "",
      parentKey: item.parentKey ?? item.parentId ?? "",
      group: item.group || "",
      sort: item.sort === undefined ? index + 1 : item.sort,
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
      status: item.status || "启用"
    }));
  }

  function defaultUser() {
    return { id: "", name: "", account: "", phone: "", email: "", role: "service", status: "启用", password: "" };
  }

  function setup(ctx) {
    const { data, state } = ctx;
    const { ElMessage, ElMessageBox } = ElementPlus;
    const activeTab = ref("menus");
    const loading = ref(false);
    const saving = ref(false);
    const readOnly = computed(() => state.role !== "super");
    const canWrite = computed(() => !readOnly.value);
    const isAdminAccount = computed(() => text(state.currentAccount).trim().toLowerCase() === "admin");
    const menuRows = ref(fallbackMenus());
    const roleRows = ref(fallbackRoles());
    const userRows = ref([]);
    const menuQuery = reactive({ keyword: "", level: "", status: "", group: "" });
    const menuFilters = reactive({ keyword: "", level: "", status: "", group: "" });
    const roleQuery = reactive({ keyword: "", status: "" });
    const roleFilters = reactive({ keyword: "", status: "" });
    const userQuery = reactive({ keyword: "", role: "", status: "" });
    const userFilters = reactive({ keyword: "", role: "", status: "" });
    const selectedRoleId = ref("");
    const menuDialog = ref(false);
    const roleDialog = ref(false);
    const userDialog = ref(false);
    const passwordDialog = ref(false);
    const menuForm = reactive({ id: "", key: "", name: "", parentId: "", group: "", routeKey: "dashboard", sort: 1, status: "启用" });
    const menuLevel = ref("一级菜单");
    const roleForm = reactive({ id: "", key: "", name: "", description: "", menus: [], status: "启用" });
    const userForm = reactive(defaultUser());
    const userPhoneError = ref("");
    const passwordForm = reactive({ id: "", account: "", name: "", password: "" });

    const menuLevelLabel = (row) => text(row?.parentKey !== undefined ? row.parentKey : row?.parentId).trim() ? "二级菜单" : "一级菜单";
    const parentKeyOf = (row) => text(row?.parentKey !== undefined ? row.parentKey : row?.parentId).trim();
    const menuTreeRows = computed(() => {
      const rows = menuRows.value.map((row, index) => ({ ...row, _index: index, depth: 0 }));
      const byKey = new Map(rows.map((row) => [text(row.key || row.id), row]));
      const children = new Map();
      const roots = [];
      const compare = (left, right) => Number(left.sort ?? left.sortNo ?? 0) - Number(right.sort ?? right.sortNo ?? 0)
        || left._index - right._index || text(left.key).localeCompare(text(right.key));
      rows.forEach((row) => {
        const parentKey = parentKeyOf(row);
        if (!parentKey || !byKey.has(parentKey)) {
          roots.push(row);
          return;
        }
        const siblings = children.get(parentKey) || [];
        siblings.push(row);
        children.set(parentKey, siblings);
      });
      const output = [];
      const append = (row, depth) => {
        output.push({ ...row, depth });
        (children.get(text(row.key || row.id)) || []).sort(compare).forEach((child) => append(child, depth + 1));
      };
      roots.sort(compare).forEach((row) => append(row, 0));
      return output;
    });
    const filteredMenus = computed(() => {
      const keyword = text(menuFilters.keyword).trim().toLowerCase();
      const matches = menuTreeRows.value.filter((row) => {
        const matchesKeyword = !keyword || `${JSON.stringify(row)} ${menuLevelLabel(row)}`.toLowerCase().includes(keyword);
        const matchesLevel = !menuFilters.level || menuLevelLabel(row) === menuFilters.level;
        const matchesStatus = !menuFilters.status || (row.status || "启用") === menuFilters.status;
        const matchesGroup = !menuFilters.group
          || (menuFilters.group === "__ungrouped__" ? !text(row.group).trim() : text(row.group).trim() === menuFilters.group);
        return matchesKeyword && matchesLevel && matchesStatus && matchesGroup;
      });
      if (matches.length === menuTreeRows.value.length) return matches;
      const visibleKeys = new Set(matches.map((row) => text(row.key || row.id)));
      const parents = new Map(menuTreeRows.value.map((row) => [text(row.key || row.id), parentKeyOf(row)]));
      [...visibleKeys].forEach((key) => {
        let parentKey = parents.get(key);
        while (parentKey) {
          visibleKeys.add(parentKey);
          parentKey = parents.get(parentKey);
        }
      });
      return menuTreeRows.value.filter((row) => visibleKeys.has(text(row.key || row.id)));
    });
    const filteredRoles = computed(() => {
      const keyword = text(roleFilters.keyword).trim().toLowerCase();
      return roleRows.value.filter((row) => {
        const matchesKeyword = !keyword || JSON.stringify(row).toLowerCase().includes(keyword);
        const matchesStatus = !roleFilters.status || (row.status || "启用") === roleFilters.status;
        return matchesKeyword && matchesStatus;
      });
    });
    const filteredUsers = computed(() => {
      const keyword = text(userFilters.keyword).trim().toLowerCase();
      return userRows.value.filter((row) => {
        const matchesKeyword = !keyword || JSON.stringify(row).toLowerCase().includes(keyword);
        const matchesRole = !userFilters.role || row.role === userFilters.role;
        const matchesStatus = !userFilters.status || (row.status || "启用") === userFilters.status;
        return matchesKeyword && matchesRole && matchesStatus;
      });
    });
    const selectedRole = computed(() => roleRows.value.find((row) => row.id === selectedRoleId.value) || null);
    const menuOptions = computed(() => menuRows.value.filter((row) => {
      const parent = row && row.parentKey !== undefined ? row.parentKey : row?.parentId;
      return row.id !== menuForm.id && !text(parent).trim();
    }));
    const routeOptions = computed(() => {
      const labels = new Map((window.LXM_CONFIG?.menus || []).map((item) => [String(item.key), item.label || item.key]));
      const keys = Array.isArray(window.LXM_CONFIG?.routeMenuKeys) ? window.LXM_CONFIG.routeMenuKeys : [];
      return keys.map((key) => ({ key: String(key), label: labels.get(String(key)) || String(key) }));
    });
    const activeMenuCount = computed(() => menuRows.value.filter((row) => (row.status || "启用") === "启用").length);
    const activeRoleCount = computed(() => roleRows.value.filter((row) => (row.status || "启用") === "启用").length);
    const menuGroupOptions = computed(() => {
      const configured = Array.isArray(window.LXM_CONFIG?.groups) ? window.LXM_CONFIG.groups : [];
      const dynamic = menuRows.value.map((row) => text(row.group).trim()).filter(Boolean);
      const groups = [...new Set([...configured, ...dynamic])];
      const options = [{ key: "", label: "全部菜单", count: menuRows.value.length }];
      groups.forEach((group) => options.push({
        key: group,
        label: group,
        count: menuRows.value.filter((row) => text(row.group).trim() === group).length
      }));
      const ungrouped = menuRows.value.filter((row) => !text(row.group).trim()).length;
      if (ungrouped) options.push({ key: "__ungrouped__", label: "未分组", count: ungrouped });
      return options;
    });
    const routeLabel = (routeKey) => routeOptions.value.find((item) => item.key === text(routeKey).trim())?.label || text(routeKey, "-");

    function applyMenuFilters() {
      Object.assign(menuFilters, { ...menuQuery, keyword: text(menuQuery.keyword).trim() });
    }

    function resetMenuFilters() {
      Object.assign(menuQuery, { keyword: "", level: "", status: "", group: "" });
      Object.assign(menuFilters, { keyword: "", level: "", status: "", group: "" });
    }

    function selectMenuGroup(group) {
      const nextGroup = group === "__ungrouped__" ? "__ungrouped__" : text(group).trim();
      menuQuery.group = nextGroup;
      menuFilters.group = nextGroup;
    }

    function applyRoleFilters() {
      Object.assign(roleFilters, { ...roleQuery, keyword: text(roleQuery.keyword).trim() });
    }

    function resetRoleFilters() {
      Object.assign(roleQuery, { keyword: "", status: "" });
      Object.assign(roleFilters, { keyword: "", status: "" });
    }

    function applyUserFilters() {
      Object.assign(userFilters, { ...userQuery, keyword: text(userQuery.keyword).trim() });
    }

    function resetUserFilters() {
      Object.assign(userQuery, { keyword: "", role: "", status: "" });
      Object.assign(userFilters, { keyword: "", role: "", status: "" });
    }

    function validateUserPhone(value = userForm.phone) {
      const phone = text(value).trim();
      userPhoneError.value = phone && !/^1[3-9]\d{9}$/.test(phone) ? "请输入有效的 11 位大陆手机号" : "";
      return !userPhoneError.value;
    }

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

    function syncMenuDefinitions(rows) {
      if (!window.LXM_CONFIG || !Array.isArray(rows)) return;
      const normalized = rows.map((row) => {
        const parent = row && row.parentKey !== undefined ? row.parentKey : row?.parentId;
        return {
          key: text(row.key || row.menuKey || row.id).trim(),
          label: text(row.name || row.label || row.key).trim(),
          group: text(row.group || row.meta?.group || "其他功能").trim() || "其他功能",
          parentId: text(parent).trim(),
          parentKey: text(parent).trim(),
          routeKey: text(row.routeKey || row.targetKey || row.key).trim(),
          targetKey: text(row.targetKey || row.routeKey || row.key).trim(),
          path: text(row.path || ""),
          icon: text(row.icon || ""),
          sort: Number(row.sort ?? row.sortNo ?? 0),
          status: ["停用", "disabled", "inactive"].includes(text(row.status).trim().toLowerCase()) ? "停用" : "启用"
        };
      }).filter((row) => row.key);
      window.LXM_CONFIG.menus.splice(0, window.LXM_CONFIG.menus.length, ...normalized);
      const superRole = window.LXM_CONFIG.roles?.super;
      if (superRole) superRole.menus = normalized.filter((row) => row.status !== "停用").map((row) => row.key);
      const activeKeys = new Set(normalized.filter((row) => row.status !== "停用").map((row) => row.key));
      if (!activeKeys.has(state.active)) state.active = normalized.find((row) => activeKeys.has(row.key))?.key || "";
      state.menuRevision += 1;
    }

    async function loadAll(options = {}) {
      loading.value = true;
      try {
        const [menusLoaded] = await Promise.all([
          loadCollection(MENU_COLLECTION, menuRows, fallbackMenus),
          loadCollection(ROLE_COLLECTION, roleRows, fallbackRoles),
          loadUsers()
        ]);
        if (menusLoaded) syncMenuDefinitions(menuRows.value);
        const preferredRoleId = text(options.selectedRoleId || selectedRoleId.value);
        selectedRoleId.value = roleRows.value.some((row) => row.id === preferredRoleId)
          ? preferredRoleId
          : (roleRows.value[0]?.id || "");
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
      const parentId = row ? (row.parentKey !== undefined ? row.parentKey : (row.parentId || "")) : "";
      Object.assign(menuForm, row ? {
        ...row,
        parentId,
        routeKey: row.routeKey || row.targetKey || row.key
      } : { id: "", key: "", name: "", parentId: "", group: "系统安全", routeKey: routeOptions.value[0]?.key || "dashboard", sort: menuRows.value.length + 1, status: "启用" });
      menuLevel.value = text(parentId).trim() ? "二级菜单" : "一级菜单";
      menuDialog.value = true;
    }

    function openChildMenu(row) {
      if (!ensureWriteAccess()) return;
      const parentKey = text(row?.key || row?.id).trim();
      if (!parentKey) return;
      Object.assign(menuForm, {
        id: "", key: "", name: "", parentId: parentKey,
        group: text(row?.group).trim() || "系统安全",
        routeKey: routeOptions.value[0]?.key || "dashboard",
        sort: menuRows.value.length + 1,
        status: "启用"
      });
      menuLevel.value = "二级菜单";
      menuDialog.value = true;
    }

    function changeMenuLevel(level) {
      if (level === "一级菜单") menuForm.parentId = "";
    }

    async function saveMenu() {
      if (!ensureWriteAccess() || !menuForm.key.trim() || !menuForm.name.trim() || !text(menuForm.routeKey).trim()) return ElMessage.warning("请填写菜单标识、菜单名称并选择目标页面");
      if (menuLevel.value === "二级菜单" && !text(menuForm.parentId).trim()) return ElMessage.warning("请选择所属一级菜单");
      const parent = menuRows.value.find((row) => text(row.key || row.id) === text(menuForm.parentId).trim());
      const selectedParentKey = parent && parent.parentKey !== undefined ? parent.parentKey : parent?.parentId;
      if (parent && text(selectedParentKey).trim()) return ElMessage.warning("菜单最多支持两级");
      saving.value = true;
      try {
        const parentKey = menuLevel.value === "二级菜单" ? text(menuForm.parentId).trim() || null : null;
        const payload = {
          key: menuForm.key.trim(),
          name: menuForm.name.trim(),
          routeKey: text(menuForm.routeKey).trim(),
          group: text(menuForm.group).trim(),
          parentKey,
          sort: Number(menuForm.sort || 0),
          status: menuForm.status
        };
        const write = requireRemoteWrite(menuForm.id ? "updateMenu" : "createMenu");
        await (menuForm.id ? write(menuForm.id, payload) : write(payload));
        await loadAll();
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
        await requireRemoteWrite("updateMenu")(row.id, { status: nextStatus });
        await loadAll();
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
        await loadAll();
        ElMessage.success("菜单已删除");
      } catch (error) {
        if (error === "cancel" || error === "close") return;
        ElMessage.error(error?.message || "菜单删除失败，请先解除角色授权");
      }
    }

    function selectRole(row) {
      selectedRoleId.value = row.id;
      Object.assign(roleForm, { ...row, menus: unique(row.menus) });
    }

    function openRole(row = null) {
      if (!ensureWriteAccess()) return;
      if (row?.key === "super" || row?.roleKey === "super") return ElMessage.warning("系统管理员权限由系统维护");
      const source = row || { id: "", key: "", name: "", description: "", menus: [], status: "启用" };
      Object.assign(roleForm, { ...source, menus: unique(source.menus) });
      roleDialog.value = true;
    }

    function editSelectedRole() {
      if (selectedRole.value) openRole(selectedRole.value);
    }

    async function saveRole() {
      if (!ensureWriteAccess() || !roleForm.key.trim() || !roleForm.name.trim()) return ElMessage.warning("请填写角色标识和角色名称");
      saving.value = true;
      try {
        const payload = { ...roleForm, key: roleForm.key.trim(), name: roleForm.name.trim(), menus: unique(roleForm.menus) };
        const write = requireRemoteWrite(roleForm.id ? "updateRole" : "createRole");
        const saved = roleForm.id ? await write(roleForm.id, payload) : await write(payload);
        const row = saved?.data || saved || payload;
        await loadAll({ selectedRoleId: row.id || roleForm.id || row.key });
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
      if (row?.key === "super" || row?.roleKey === "super") return ElMessage.warning("系统管理员权限由系统维护");
      const nextStatus = (row.status || "启用") === "启用" ? "停用" : "启用";
      try {
        await requireRemoteWrite("updateRole")(row.id, { status: nextStatus });
        await loadAll({ selectedRoleId: row.id });
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
        await loadAll();
        ElMessage.success("角色已删除");
      } catch (error) {
        if (error === "cancel" || error === "close") return;
        ElMessage.error(error?.message || "角色删除失败，请先解除人员绑定");
      }
    }

    function openUser(row = null) {
      if (!ensureWriteAccess()) return;
      Object.assign(userForm, row ? { ...row, password: "" } : defaultUser());
      validateUserPhone();
      userDialog.value = true;
    }

    function openPassword(row) {
      if (!isAdminAccount.value) return ElMessage.warning("仅 admin 账号可以修改人员密码");
      Object.assign(passwordForm, { id: text(row?.id), account: text(row?.account), name: text(row?.name || row?.account), password: "" });
      passwordDialog.value = true;
    }

    async function savePassword() {
      if (!isAdminAccount.value) return ElMessage.warning("仅 admin 账号可以修改人员密码");
      if (passwordForm.password.length < 8 || !/[A-Za-z]/.test(passwordForm.password) || !/\d/.test(passwordForm.password)) {
        return ElMessage.warning("密码至少 8 位且同时包含字母和数字");
      }
      saving.value = true;
      try {
        await requireRemoteWrite("updateUser")(passwordForm.id, { password: passwordForm.password });
        await loadAll();
        passwordDialog.value = false;
        ElMessage.success("人员密码已修改");
      } catch (error) {
        ElMessage.error(error?.message || "密码修改失败");
      } finally {
        saving.value = false;
      }
    }

    function userRoleName(row) { return roleLabel(row.role, row.roleName || row.role); }

    async function saveUser() {
      if (!ensureWriteAccess() || !userForm.name.trim() || !userForm.account.trim() || !userForm.role) return ElMessage.warning("请填写姓名、登录账号并选择角色");
      if (!userForm.id && !userForm.password) return ElMessage.warning("新增人员必须设置登录密码");
      if (!validateUserPhone()) return ElMessage.warning(userPhoneError.value);
      saving.value = true;
      try {
        const payload = { ...userForm, name: userForm.name.trim(), account: userForm.account.trim(), phone: text(userForm.phone).trim() };
        if (!payload.password) delete payload.password;
        const write = requireRemoteWrite(userForm.id ? "updateUser" : "createUser");
        await (userForm.id ? write(userForm.id, payload) : write(payload));
        await loadAll();
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
        await (nextStatus === "停用"
          ? await requireRemoteWrite("disableUser")(row.id)
          : await requireRemoteWrite("enableUser")(row.id));
        await loadAll();
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
        await loadAll();
        ElMessage.success("人员已删除");
      } catch (error) {
        if (error === "cancel" || error === "close") return;
        ElMessage.error(error?.message || "人员删除失败");
      }
    }

    onMounted(loadAll);
    return {
      activeTab, loading, saving, readOnly, canWrite, isAdminAccount, menuRows, roleRows, userRows,
      menuQuery, roleQuery, userQuery, filteredMenus, filteredRoles, filteredUsers, selectedRole,
      menuGroupOptions, menuOptions, routeOptions, activeMenuCount, activeRoleCount, menuForm, menuLevel, menuLevelLabel, roleForm, userForm, passwordForm,
      userPhoneError,
      menuDialog, roleDialog, userDialog, passwordDialog, selectedRoleId,
      applyMenuFilters, resetMenuFilters, selectMenuGroup, applyRoleFilters, resetRoleFilters, applyUserFilters, resetUserFilters,
      validateUserPhone, openMenu, openChildMenu, changeMenuLevel, saveMenu, toggleMenu, deleteMenu, selectRole, openRole, editSelectedRole, saveRole, toggleRole, deleteRole,
      openUser, saveUser, openPassword, savePassword, toggleUser, deleteUser, userRoleName, menuLabel, roleLabel, routeLabel, loadAll
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
