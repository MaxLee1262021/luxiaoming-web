// 短视频管理页：三栏编辑器（左列表 · 中表单 · 右手机预览）。
// 数据统一存进 packages 集合（type=video + isVideoSingle），由 app.js videoSingleRows 提供行数据。
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
    const { videoSingleRows, videoSingleStatus, seriesName, spotName, money } = ctx;

    const selectedVideoSingleId = Vue.ref(null);
    const remoteVideoSingles = Vue.ref(null);
    const remoteOn = Vue.ref(LXM_API.remoteOn());
    const remoteLoading = Vue.ref(false);
    const serverConnected = () => !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && (!window.LXM_API_STATE || window.LXM_API_STATE.reachable !== false));

    const listSource = Vue.computed(() => {
      if (remoteOn.value && remoteVideoSingles.value) return remoteVideoSingles.value;
      return Vue.unref(ctx.videoSingleRows) || [];
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

    function refreshFromServer() {
      remoteLoading.value = true;
      LXM_API.loadCollection("packages")
        .then((list) => {
          remoteVideoSingles.value = (list || []).filter((r) => r.type === "video" && r.isVideoSingle);
          remoteOn.value = true;
          LXM_API.setRemote(true);
          remoteLoading.value = false;
          tip(`已从真实后端载入 ${(remoteVideoSingles.value || []).length} 条短视频`);
        })
        .catch((e) => { remoteLoading.value = false; tip("载入失败：" + e.message); });
    }

    function toggleRemote() {
      remoteOn.value = !remoteOn.value;
      LXM_API.setRemote(remoteOn.value);
      if (remoteOn.value) refreshFromServer();
      else tip("已切回本地演示数据");
    }

    async function saveSelectedVideoSingle() {
      return window.LXM_UPLOAD.single("video-single-save", async () => {
      if (!window.LXM_UPLOAD.ready()) return;
      const s = selectedVideoSingle.value;
      if (!s) return;
      if (!s.title && !s.name) { tip("请填写短视频名称"); return; }
      s.title = s.title || s.name;
      s.name = s.name || s.title;
      s.type = "video";
      s.isVideoSingle = true;
      s.productKind = "video_single";
      if (serverConnected() && typeof ctx.persistContentMutation === "function") {
        const ok = await ctx.persistContentMutation("packages", s, { ...s });
        if (ok) tip("已写入真实后端");
        return;
      }
      if (remoteOn.value) {
        return LXM_API.saveDoc("packages", s)
          .then(() => tip("已写入真实后端"))
          .catch((e) => tip("写入失败：" + e.message));
      } else {
        tip("已保存到本地（当前为演示数据模式，切换数据源后才写入服务端）");
      }
      });
    }

    function onVideoFilePick(e) {
      const file = e.target.files && e.target.files[0];
      const target = selectedVideoSingle.value;
      e.target.value = '';
      if (!file || !target) return;
      window.LXM_UPLOAD.upload(file, { purpose: 'content', collection: 'packages', recordId: target.id || target._id, videoOnly: true,
        onUploaded(result) { target.videoUrl = result.url; }
      });
    }
    function uploadVideoCover() { ctx.contentFile(selectedVideoSingle.value, 'cover', 'packages'); }

    return {
      selectedVideoSingleId,
      remoteVideoSingles,
      remoteOn,
      remoteLoading,
      listSource,
      selectedVideoSingle,
      videoSingleRows,
      videoSingleStatus,
      seriesName,
      spotName,
      money,
      isSelected,
      selectVideoSingle,
      refreshFromServer,
      toggleRemote,
      saveSelectedVideoSingle,
      onVideoFilePick, uploadVideoCover
    };
  }
});
