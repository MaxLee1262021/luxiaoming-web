// 旅拍套餐管理页：与 videoSingle/album 结构一致（远端/本地切换、列表选中、表单编辑）。
// 数据来自 data.packages（type=photo；video 单品走 videoSingle 单独维护）。
window.LXM_PAGES.register({
  key: "packages",
  component: "LxmPagePackage",
  group: "content",
  title: "Package",
  description: "Travel photo package management",
  styleScope: "page-route-package",
  setup(ctx) {
    const Vue = window.Vue;
    const tip = (m) => { try { if (window.ElMessage) window.ElMessage(m); else if (ctx.toast) ctx.toast(m); else console.log(m); } catch (e) {} };

    // ctx 已暴露的字段：state / data / can / switchMenu / clearContentFilters /
    // openContent / openContentQuick / openContentLogs / openContentTrash /
    // previewContent / requestDeletePackage / productStatus / seriesName / spotName / money /
    // packageSummary / packagePriceText / packageServiceText / packageBookingText / packageAuditText
    const {
      state, data, can, switchMenu, clearContentFilters,
      openContent, openContentQuick, openContentLogs, openContentTrash, previewContent,
      requestDeletePackage, productStatus, seriesName, spotName, money,
      packageSummary, packagePriceText, packageServiceText, packageBookingText, packageAuditText
    } = ctx;

    const selectedPackageId = Vue.ref(null);
    const remotePackages = Vue.ref(null);
    const remoteOn = Vue.ref(LXM_API.remoteOn());
    const remoteLoading = Vue.ref(false);
    const serverConnected = () => !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && (!window.LXM_API_STATE || window.LXM_API_STATE.reachable !== false));

    function normalizePackageForEditor(pkg) {
      if (!pkg || typeof pkg !== "object") return pkg;
      const description = String(pkg.description || pkg.intro || "").trim();
      pkg.description = description;
      pkg.intro = description;
      const spotIds = [
        ...(Array.isArray(pkg.spotIds) ? pkg.spotIds : []),
        pkg.spotId
      ].filter(Boolean).map(String);
      pkg.spotIds = [...new Set(spotIds)];
      pkg.spotId = String(pkg.spotId || pkg.spotIds[0] || "");
      pkg.serviceTags = Array.isArray(pkg.serviceTags) ? pkg.serviceTags.filter(Boolean) : (Array.isArray(pkg.tags) ? pkg.tags.filter(Boolean) : []);
      pkg.tags = Array.isArray(pkg.tags) && pkg.tags.length ? pkg.tags.filter(Boolean) : pkg.serviceTags.slice();
      pkg.includedItems = Array.isArray(pkg.includedItems) ? pkg.includedItems : (Array.isArray(pkg.items) ? pkg.items : []);
      pkg.items = Array.isArray(pkg.items) ? pkg.items : pkg.includedItems.slice();
      if (pkg.isMainPush === true) pkg.mainPush = true;
      return pkg;
    }

    const listSource = Vue.computed(() => {
      if (remoteOn.value && remotePackages.value) return remotePackages.value.map(normalizePackageForEditor);
      // 旅拍套餐：取 type=photo 且未删除的；视频单品另由 videoSingle 维护
      return (data.packages || []).filter((r) => r && !r.deleted && r.type !== "video").map(normalizePackageForEditor);
    });

    const selectedPackage = Vue.computed(() => {
      const list = listSource.value;
      const id = selectedPackageId.value;
      if (id) {
        const found = list.find((p) => (p._id || p.id) === id);
        if (found) return found;
      }
      return list[0] || null;
    });

    function isSelected(p) {
      const s = selectedPackage.value;
      return !!(s && (s._id || s.id) === (p._id || p.id));
    }

    function selectPackage(p) {
      if (p) selectedPackageId.value = p._id || p.id;
    }

    function refreshFromServer() {
      remoteLoading.value = true;
      LXM_API.loadCollection("packages")
        .then((list) => {
          remotePackages.value = (list || []).filter((r) => r && r.type !== "video").map(normalizePackageForEditor);
          remoteOn.value = true;
          LXM_API.setRemote(true);
          remoteLoading.value = false;
          tip(`已从真实后端载入 ${(remotePackages.value || []).length} 个套餐`);
        })
        .catch((e) => { remoteLoading.value = false; tip("载入失败：" + e.message); });
    }

    function toggleRemote() {
      remoteOn.value = !remoteOn.value;
      LXM_API.setRemote(remoteOn.value);
      if (remoteOn.value) refreshFromServer();
      else tip("已切回本地演示数据");
    }

    async function saveSelectedPackage() {
      const p = selectedPackage.value;
      if (!p) return;
      if (!p.name) { tip("请填写套餐名称"); return; }
      const previous = { ...p, spotIds: Array.isArray(p.spotIds) ? p.spotIds.slice() : [], tags: Array.isArray(p.tags) ? p.tags.slice() : [], serviceTags: Array.isArray(p.serviceTags) ? p.serviceTags.slice() : [], includedItems: Array.isArray(p.includedItems) ? p.includedItems.slice() : [], items: Array.isArray(p.items) ? p.items.slice() : [] };
      normalizePackageForEditor(p);
      if (serverConnected() && typeof ctx.persistContentMutation === "function") {
        const ok = await ctx.persistContentMutation("packages", p, previous);
        if (ok) tip("已写入真实后端");
        return;
      }
      if (remoteOn.value) {
        LXM_API.saveDoc("packages", p).then(() => tip("已写入真实后端")).catch((e) => tip("写入失败：" + e.message));
      } else {
        tip("已保存到本地（演示数据模式，切换数据源后才写入服务端）");
      }
    }

    // 关联信息汇总（套餐引用的照片单品/视频/周边）
    function relationText(p) {
      if (!p) return "-";
      const tags = Array.isArray(p.tags) ? p.tags.join("、") : "";
      const albumIds = Array.isArray(p.albumIds) ? p.albumIds.length : 0;
      const videoIds = Array.isArray(p.videoIds) ? p.videoIds.length : 0;
      return `标签：${tags || "无"} · 关联照片单品 ${albumIds} · 关联视频 ${videoIds}`;
    }

    return {
      state, data, can, switchMenu, clearContentFilters,
      openContent, openContentQuick, openContentLogs, openContentTrash, previewContent,
      requestDeletePackage, productStatus, seriesName, spotName, money,
      packageSummary, packagePriceText, packageServiceText, packageBookingText, packageAuditText,
      selectedPackageId, remotePackages, remoteOn, remoteLoading,
      listSource, selectedPackage,
      isSelected, selectPackage,
      refreshFromServer, toggleRemote, saveSelectedPackage,
      relationText
    };
  }
});
