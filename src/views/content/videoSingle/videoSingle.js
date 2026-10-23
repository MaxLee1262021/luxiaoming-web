// 短视频管理页：三栏编辑器（左列表 · 中表单 · 右手机预览）。
// packages 是唯一可编辑数据池；统计、筛选、列表和编辑器始终使用同一份结果。
// 仅本页特有的「本地选择视频文件预览」放在 pageSetup，不污染中枢逻辑。
// 注：这里必须走 window.LXM_PAGES.register —— 全局没有裸 register 函数，裸调用会 ReferenceError 导致整页注册失效。
window.LXM_PAGES.register({
  key: "videoSingles",
  component: "LxmPageVideoSingle",
  group: "content",
  styleScope: "page-route-videoSingle",
  setup(ctx) {
    const Vue = window.Vue;
    const tip = (m) => { try { if (window.ElMessage) window.ElMessage(m); else if (ctx.toast) ctx.toast(m); else console.log(m); } catch (e) {} };

    // 模板用到的业务字段（ctx 上有的，单独解构出来；模板能直接访问 setup 内部 const）
    const { videoSingleStatus, seriesName, spotName, money } = ctx;

    const selectedVideoSingleId = Vue.ref(null);
    const serverSession = () => ctx.state.authSource === "server" || (ctx.state.authSource !== "demo" && !!window.LXM_AUTH?.hasSession?.());
    const remoteOn = Vue.ref(serverSession() || LXM_API.remoteOn());
    const remoteLoading = Vue.ref(false);
    const remoteReady = Vue.ref(false);
    const remoteError = Vue.ref("");
    const serverConnected = () => ctx.isServerConnected();
    const demoPackages = ctx.state.authSource === "demo" ? ctx.data.packages : null;
    const passedAudits = new Set(["approved", "pass", "passed", "published", "online", "已上", "已上架", "审核通过", "通过"]);
    let loadVersion = 0;

    const listSource = Vue.computed(() => {
      if (remoteOn.value && (!remoteReady.value || remoteLoading.value || remoteError.value)) return [];
      return ctx.filterVideoSingleRows(ctx.data.packages);
    });
    const videoSingleSummary = Vue.computed(() => {
      const rows = listSource.value;
      return {
        total: rows.length,
        onSale: rows.filter((row) => {
          const audit = String(row.auditStatus || row.reviewStatus || "").trim().toLowerCase();
          return videoSingleStatus(row) === "上架" && row.isShow !== false && row.visible !== false && row.enabled !== false && (!audit || passedAudits.has(audit));
        }).length,
        mainPush: rows.filter((row) => row.isMainPush || row.mainPush).length,
        pending: rows.filter((row) => [row.status, row.auditStatus, row.reviewStatus]
          .some((value) => /待|pending|reviewing/.test(String(value || "").toLowerCase()))).length
      };
    });

    const selectedVideoSingle = Vue.computed(() => {
      const list = listSource.value;
      const id = selectedVideoSingleId.value;
      if (id) {
        const found = list.find((v) => (v._id || v.id) === id);
        if (found) return found;
      }
      return list[0] || null;
    });

    function isSelected(v) {
      const s = selectedVideoSingle.value;
      return !!(s && (s._id || s.id) === (v._id || v.id));
    }

    function selectVideoSingle(v) {
      if (v) selectedVideoSingleId.value = v._id || v.id;
    }

    async function refreshFromServer() {
      const version = ++loadVersion;
      remoteOn.value = true;
      LXM_API.setRemote(true);
      remoteLoading.value = true;
      remoteReady.value = false;
      remoteError.value = "";
      try {
        const list = await LXM_API.loadCollection("packages");
        if (version !== loadVersion || !remoteOn.value) return false;
        if (!Array.isArray(list)) throw new Error("后端未返回有效的短视频列表");
        ctx.data.packages = list.map((row) => row && typeof row === "object"
          ? { ...row, id: row.id || row._id, _id: row._id || row.id }
          : row).filter(Boolean);
        remoteReady.value = true;
        return true;
      } catch (error) {
        if (version !== loadVersion) return false;
        remoteError.value = error.message || "请稍后重试";
        tip("短视频载入失败：" + remoteError.value);
        return false;
      } finally {
        if (version === loadVersion) remoteLoading.value = false;
      }
    }

    function toggleRemote(event) {
      // 已认证的在线后台始终编辑真实数据，避免把真实记录误标为演示或离线保存。
      if (serverSession() || ctx.state.authSource !== "demo") {
        remoteOn.value = true;
        if (event && event.target) event.target.checked = true;
        LXM_API.setRemote(true);
        tip("当前已登录真实后端，短视频使用真实数据");
        return;
      }
      remoteOn.value = !remoteOn.value;
      LXM_API.setRemote(remoteOn.value);
      if (remoteOn.value) return refreshFromServer();
      ++loadVersion;
      remoteLoading.value = false;
      remoteReady.value = false;
      remoteError.value = "";
      ctx.data.packages = demoPackages || [];
      tip("已切回本地演示数据");
    }

    function canEditSource() {
      if (remoteOn.value && (!remoteReady.value || remoteLoading.value || remoteError.value || !serverConnected())) {
        tip("真实后端数据尚不可用，请刷新后重试");
        return false;
      }
      return true;
    }

    function openVideoSingle(row = null) {
      if (canEditSource()) ctx.openVideoSingle(row);
    }

    async function mutateVideoSingle(action, row) {
      if (!canEditSource()) return false;
      return action(row);
    }

    Vue.onMounted(() => {
      if (remoteOn.value) return refreshFromServer();
    });
    Vue.onBeforeUnmount(() => { ++loadVersion; });
    Vue.watch(() => ctx.state.authSource, () => {
      if (serverSession()) {
        refreshFromServer();
      } else if (remoteOn.value) {
        ++loadVersion;
        remoteReady.value = false;
        remoteLoading.value = false;
        remoteError.value = "登录状态已失效，请重新登录";
      }
    });

    async function saveSelectedVideoSingle() {
      if (!canEditSource()) return false;
      return window.LXM_UPLOAD.single("video-single-save", async () => {
        if (!window.LXM_UPLOAD.ready() || !canEditSource()) return false;
        const s = selectedVideoSingle.value;
        if (!s) return false;
        if (!s.title && !s.name) { tip("请填写短视频名称"); return false; }
        const previous = { ...s };
        s.title = s.title || s.name;
        s.name = s.title;
        s.type = "video";
        s.isVideoSingle = true;
        s.productKind = "video_single";
        s.isShow = (s.status || "上架") === "上架";
        if (remoteOn.value) {
          const ok = await ctx.persistContentMutation("packages", s, previous);
          if (ok) tip("已写入真实后端");
          return ok;
        }
        tip("已保存到本地演示数据");
        return true;
      });
    }

    function onVideoFilePick(e) {
      const file = e.target.files && e.target.files[0];
      const target = selectedVideoSingle.value;
      e.target.value = '';
      if (!file || !target || !canEditSource()) return;
      window.LXM_UPLOAD.upload(file, { purpose: 'content', collection: 'packages', recordId: target.id || target._id, videoOnly: true,
        onUploaded(result) {
          if (canEditSource() && ctx.data.packages.includes(target)) target.videoUrl = result.url;
        }
      });
    }
    function uploadVideoCover() {
      if (canEditSource() && selectedVideoSingle.value) ctx.contentFile(selectedVideoSingle.value, 'cover', 'packages');
    }

    return {
      selectedVideoSingleId,
      remoteOn,
      remoteLoading,
      remoteError,
      videoSingleSummary,
      listSource,
      selectedVideoSingle,
      videoSingleStatus,
      seriesName,
      spotName,
      money,
      isSelected,
      selectVideoSingle,
      refreshFromServer,
      toggleRemote,
      openVideoSingle,
      deleteVideoSingle: (row) => mutateVideoSingle(ctx.deleteVideoSingle, row),
      toggleVideoSingleShelf: (row) => mutateVideoSingle(ctx.toggleVideoSingleShelf, row),
      saveSelectedVideoSingle,
      onVideoFilePick, uploadVideoCover
    };
  }
});
