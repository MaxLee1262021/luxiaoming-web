// 短视频管理页：三栏编辑器（左列表 · 中表单 · 右手机预览）。
// packages 是唯一可编辑数据池；统计、筛选、列表和编辑器始终使用同一份结果。
// 视频经统一上传服务保存，列表与草稿卡片直接使用视频播放器。
// 注：这里必须走 window.LXM_PAGES.register —— 全局没有裸 register 函数，裸调用会 ReferenceError 导致整页注册失效。
window.LXM_PAGES.register({
  key: "videoSingles",
  component: "LxmPageVideoSingle",
  group: "content",
  styleScope: "page-route-videoSingle",
  setup(ctx) {
    const Vue = window.Vue;
    const {
      contentPhotographerOptions = Vue.ref([]), contentPhotographersLoading = Vue.ref(false),
      contentPhotographersError = Vue.ref(""), contentPhotographerName = () => "未设置",
      loadContentPhotographers = () => {}
    } = ctx;
    loadContentPhotographers();
    const tip = (m) => { try { if (window.ElMessage) window.ElMessage(m); else if (ctx.toast) ctx.toast(m); else console.log(m); } catch (e) {} };

    // 模板用到的业务字段（ctx 上有的，单独解构出来；模板能直接访问 setup 内部 const）
    const { videoSingleStatus, seriesName, spotName, money } = ctx;

    const selectedVideoSingleId = Vue.ref(null);
    const editorOpen = Vue.ref(false);
    const videoDraft = Vue.ref(null);
    const saving = Vue.ref(false);
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const idOf = (row) => String(row && (row.id || row._id) || "");
    const emptyDeposit = (value) => value === null || value === undefined || typeof value === "string" && value.trim() === "";
    function videoDepositPercent(row = {}) {
      const value = Object.prototype.hasOwnProperty.call(row, "depositRatio") ? row.depositRatio : row.depositRate ?? row.depositPercent ?? row.depositPercentage;
      if (emptyDeposit(value) || !["number", "string"].includes(typeof value)) return undefined;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 100) return undefined;
      return Number((number <= 1 ? number * 100 : number).toFixed(6));
    }
    function videoDepositLabel(row = {}, draft = false) {
      const percent = draft ? row.depositRatioPercent : videoDepositPercent(row);
      return emptyDeposit(percent) ? "使用全局比例" : `${percent}%`;
    }
    const videoSource = (row = {}) => ctx.contentVideoUrl(row);
    const serverSession = () => ctx.state.authSource === "server" && !!window.LXM_AUTH?.hasSession?.();
    const remoteOn = Vue.ref(true);
    const remoteLoading = Vue.ref(false);
    const remoteReady = Vue.ref(false);
    const remoteError = Vue.ref("");
    const serverConnected = () => ctx.isServerConnected();
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
      list.forEach((row) => { if (ctx.hydrateProductSpot) ctx.hydrateProductSpot(row); });
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
    function resetVideoDraft() {
      const source = videoDraft.value && videoDraft.value.id ? ctx.data.packages.find((row) => idOf(row) === idOf(videoDraft.value)) : null;
      if (source) setVideoDraft(source);
    }
    function setVideoDraft(row) {
      const draft = clone(row);
      draft.recommendedPhotographerId = String(draft.recommendedPhotographerId || "");
      if (ctx.hydrateProductSpot) ctx.hydrateProductSpot(draft);
      draft.title = draft.title || draft.name || "";
      draft.tags = Array.isArray(draft.tags) ? draft.tags : String(draft.tags || "").split(/[，,、|\n]/).map((tag) => tag.trim()).filter(Boolean);
      draft.isMainPush = draft.isMainPush === true || draft.mainPush === true;
      draft.shootingNotes = String(draft.shootingNotes ?? draft.intro ?? "");
      draft.videoUrl = draft.videoUrl || videoSource({ videos: draft.videos });
      draft.isShow = draft.isShow !== false && !["下架", "草稿", "待审核"].includes(draft.status);
      draft.spotId = draft.spotId || (draft.spotIds || [])[0] || "";
      draft.depositRatioPercent = videoDepositPercent(row);
      delete draft.effectiveVisible;
      delete draft.visibilityReasons;
      videoDraft.value = draft;
    }
    function openVideoEditor(row = null) {
      if (!canEditSource() || (!row && ctx.can && !ctx.can("contentEdit"))) return false;
      if (row) { selectVideoSingle(row); setVideoDraft(row); }
      else videoDraft.value = { title: "", name: "", recommendedPhotographerId: "", videoUrl: "", previewVideoUrl: "", type: "video", productKind: "video_single", isVideoSingle: true, seriesId: "", tags: [], spotId: "", spotIds: [], spotBindingExplicit: true, price: 0, depositRatioPercent: undefined, videoDuration: 30, durationText: "30秒", finishedVideoCount: 1, deliveryCycle: "1–3 个工作日", shootingNotes: "", makeupIncluded: false, hasAerial: false, fullEdit: false, isShow: true, status: "上架", isMainPush: false };
      editorOpen.value = true;
      return true;
    }
    function closeEditor() { if (!saving.value) { editorOpen.value = false; videoDraft.value = null; } }
    function previewVisible(row) {
      const preview = { ...row, status: row.isShow === false ? "下架" : "上架", spotIds: row.spotId ? [String(row.spotId)] : [], spotBindingExplicit: true };
      return typeof ctx.contentEffectiveVisible === "function" ? ctx.contentEffectiveVisible(preview) : row.isShow !== false;
    }
    const videoTagOptions = Vue.computed(() => [...new Set([
      ...(typeof ctx.tagOptions === "function" ? ctx.tagOptions("风格").map((tag) => tag.name) : []),
      ...ctx.data.packages.flatMap((row) => Array.isArray(row.tags) ? row.tags : [])
    ])]);

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
      remoteOn.value = true;
      if (event?.target) event.target.checked = true;
      LXM_API.setRemote(true);
      return refreshFromServer();
    }

    function canEditSource() {
      if (!remoteReady.value || remoteLoading.value || remoteError.value || !serverConnected()) {
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
      if (!canEditSource() || saving.value || (ctx.can && !ctx.can("contentEdit"))) return false;
      return window.LXM_UPLOAD.single("video-single-save", async () => {
        if (!window.LXM_UPLOAD.ready() || !canEditSource()) return false;
        const draft = editorOpen.value ? videoDraft.value : selectedVideoSingle.value;
        if (!draft) return false;
        const s = clone(draft);
        s.recommendedPhotographerId = String(s.recommendedPhotographerId || "");
        if (!s.title && !s.name) { tip("请填写短视频名称"); return false; }
        s.tags = [...new Set((Array.isArray(s.tags) ? s.tags : typeof s.tags === "string" ? s.tags.split(/[，,、|\r\n]/) : [])
          .filter((tag) => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))];
        if (!s.tags.length) { tip("请至少添加一个标签"); return false; }
        if (editorOpen.value) {
          const value = draft.depositRatioPercent;
          if (!emptyDeposit(value) && (!["number", "string"].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) {
            tip("定金比例应为 0 到 100，或留空使用全局比例");
            return false;
          }
          s.depositRatio = emptyDeposit(value) ? null : Number(value) / 100;
          for (const alias of ["depositRate", "depositPercent", "depositPercentage"]) delete s[alias];
        }
        delete s.depositRatioPercent;
        const source = ctx.data.packages.find((row) => idOf(row) === idOf(s));
        const previous = source ? clone(source) : null;
        if (!idOf(s)) { s.id = `video_${Date.now().toString(36)}`; s._id = s.id; }
        s.title = s.title || s.name;
        s.name = s.title;
        s.type = "video";
        s.isVideoSingle = true;
        s.productKind = "video_single";
        s.isShow = editorOpen.value ? s.isShow !== false : (s.status || "上架") === "上架";
        if (editorOpen.value) {
          s.status = s.isShow ? "上架" : "下架";
          s.auditStatus = s.isShow ? "已上" : "已下";
          s.mainPush = s.isMainPush === true;
        }
        s.spotIds = s.spotId ? [String(s.spotId)] : [];
        s.spotBindingExplicit = true;
        s.videoDuration = Number(s.videoDuration || 0);
        if (s.videoDuration) s.durationText = `${s.videoDuration}秒`;
        s.shootingNotes = String(s.shootingNotes ?? s.intro ?? "").trim();
        s.intro = s.shootingNotes;
        saving.value = true;
        try {
          if (typeof ctx.persistContentMutation !== "function" || !(await ctx.persistContentMutation("packages", s, previous))) return false;
          if (source) Object.assign(source, s);
          else ctx.data.packages.unshift(s);
          selectedVideoSingleId.value = idOf(s);
          if (editorOpen.value) closeAfterSave();
          tip("已写入真实后端");
          return true;
        } finally { saving.value = false; }
      });
    }
    function closeAfterSave() { editorOpen.value = false; videoDraft.value = null; }

    function onVideoFilePick(e) {
      const file = e.target.files && e.target.files[0];
      const target = editorOpen.value ? videoDraft.value : selectedVideoSingle.value;
      e.target.value = '';
      if (!file || !target || saving.value || (ctx.can && !ctx.can("contentEdit")) || !canEditSource()) return;
      return window.LXM_UPLOAD.upload(file, { purpose: 'content', collection: 'packages', recordId: target.id || target._id, videoOnly: true,
        onUploaded(result) {
          if (canEditSource() && (editorOpen.value ? videoDraft.value === target : ctx.data.packages.includes(target))) target.videoUrl = result.url;
        }
      });
    }
    return {
      contentPhotographerOptions, contentPhotographersLoading, contentPhotographersError, contentPhotographerName, loadContentPhotographers,
      selectedVideoSingleId,
      editorOpen, videoDraft, saving, openVideoEditor, closeEditor, resetVideoDraft, videoTagOptions, previewVisible,
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
      onVideoFilePick, videoSource, videoDepositLabel
    };
  }
});
