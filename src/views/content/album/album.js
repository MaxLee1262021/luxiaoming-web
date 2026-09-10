// 照片单品管理页：与 videoSingle 模板结构一致（远端/本地切换、列表选中、表单编辑）
window.LXM_PAGES.register({
  key: "albums",
  component: "LxmPageAlbum",
  group: "content",
  title: "Album",
  description: "Sellable sample album management",
  styleScope: "page-route-album",
  setup(ctx) {
    const Vue = window.Vue;
    const tip = (m) => { try { if (window.ElMessage) window.ElMessage(m); else if (ctx.toast) ctx.toast(m); else console.log(m); } catch (e) {} };

    // 模板用到的所有 ctx 字段（从 12-content-edit.js / 11-content-lists.js 暴露）
    const {
      albumSummary, albumRows, openAlbumReplace, uploadAlbumSample,
      toggleAlbumSellable, toggleAlbumMaterialUse, requestDeleteAlbum, previewContent,
      openContentLogs, openContentTrash, openContentQuick, openContent, clearContentFilters,
      seriesName, spotName, money
    } = ctx;

    const selectedAlbumId = Vue.ref(null);
    const remoteAlbums = Vue.ref(null);
    const remoteOn = Vue.ref(LXM_API.remoteOn());
    const remoteLoading = Vue.ref(false);
    const serverConnected = () => !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && (!window.LXM_API_STATE || window.LXM_API_STATE.reachable !== false));

    const listSource = Vue.computed(() => {
      if (remoteOn.value && remoteAlbums.value) return remoteAlbums.value;
      return ctx.albumRows || [];
    });

    const selectedAlbum = Vue.computed(() => {
      const list = listSource.value;
      const id = selectedAlbumId.value;
      if (id) {
        const found = list.find((a) => (a._id || a.id) === id);
        if (found) return found;
      }
      return list[0] || null;
    });

    function isSelected(a) {
      const s = selectedAlbum.value;
      return !!(s && (s._id || s.id) === (a._id || a.id));
    }

    function selectAlbum(a) {
      if (a) selectedAlbumId.value = a._id || a.id;
    }

    function refreshFromServer() {
      remoteLoading.value = true;
      LXM_API.loadCollection("albums")
        .then((list) => {
          remoteAlbums.value = list || [];
          remoteOn.value = true;
          LXM_API.setRemote(true);
          remoteLoading.value = false;
          tip(`已从真实后端载入 ${remoteAlbums.value.length} 条照片单品`);
        })
        .catch((e) => { remoteLoading.value = false; tip("载入失败：" + e.message); });
    }

    function toggleRemote() {
      remoteOn.value = !remoteOn.value;
      LXM_API.setRemote(remoteOn.value);
      if (remoteOn.value) refreshFromServer();
      else tip("已切回本地演示数据");
    }

    async function saveSelectedAlbum() {
      const a = selectedAlbum.value;
      if (!a) return;
      if (!a.name) { tip("请填写名称"); return; }
      if (serverConnected() && typeof ctx.persistContentMutation === "function") {
        const ok = await ctx.persistContentMutation("albums", a, { ...a });
        if (ok) tip("已写入真实后端");
        return;
      }
      if (remoteOn.value) {
        LXM_API.saveDoc("albums", a).then(() => tip("已写入真实后端")).catch((e) => tip("写入失败：" + e.message));
      } else {
        tip("已保存到本地（演示数据模式，切换数据源后才写入服务端）");
      }
    }

    return {
      // 业务字段
      albumSummary, albumRows,
      openAlbumReplace, uploadAlbumSample, toggleAlbumSellable, toggleAlbumMaterialUse,
      requestDeleteAlbum, previewContent,
      openContentLogs, openContentTrash, openContentQuick, openContent, clearContentFilters,
      seriesName, spotName, money,
      // 本地状态
      selectedAlbumId, remoteAlbums, remoteOn, remoteLoading,
      listSource, selectedAlbum,
      isSelected, selectAlbum,
      refreshFromServer, toggleRemote, saveSelectedAlbum
    };
  }
});
