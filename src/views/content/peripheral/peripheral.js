// 影像周边管理页：与 videoSingle / album / package 同样的三栏编辑结构。
// 数据来自 data.peripherals；模板用 listSource + selectedPeripheral 模式。
window.LXM_PAGES.register({
  key: "peripherals",
  component: "LxmPagePeripheral",
  group: "content",
  title: "Peripheral",
  description: "Photo peripheral product management",
  styleScope: "page-route-peripheral",
  setup(ctx) {
    const Vue = window.Vue;
    const tip = (m) => { try { if (window.ElMessage) window.ElMessage(m); else if (ctx.toast) ctx.toast(m); else console.log(m); } catch (e) {} };

    const {
      state, data, can, switchMenu, clearContentFilters,
      openContent, openContentQuick, openContentLogs, openContentTrash, previewContent,
      requestDeletePeripheral, productStatus, togglePeripheralShelf, setPeripheralMode,
      peripheralSummary, peripheralModeText, peripheralStockStatus,
      seriesName, spotName, money
    } = ctx;

    const selectedPeripheralId = Vue.ref(null);
    const remotePeripherals = Vue.ref(null);
    const remoteOn = Vue.ref(LXM_API.remoteOn());
    const remoteLoading = Vue.ref(false);

    const listSource = Vue.computed(() => {
      if (remoteOn.value) return remotePeripherals.value || [];
      return (data.peripherals || []).filter((r) => r && !r.deleted);
    });

    const selectedPeripheral = Vue.computed(() => {
      const list = listSource.value;
      const id = selectedPeripheralId.value;
      if (id) {
        const found = list.find((p) => (p._id || p.id) === id);
        if (found) return found;
      }
      return list[0] || null;
    });

    function isSelected(p) {
      const s = selectedPeripheral.value;
      return !!(s && (s._id || s.id) === (p._id || p.id));
    }
    function selectPeripheral(p) {
      if (p) selectedPeripheralId.value = p._id || p.id;
    }

    function refreshFromServer() {
      remoteLoading.value = true;
      LXM_API.loadCollection("peripherals")
        .then((list) => { remotePeripherals.value = list || []; remoteOn.value = true; LXM_API.setRemote(true); remoteLoading.value = false; tip(`已从真实后端载入 ${(remotePeripherals.value || []).length} 个周边`); })
        .catch((e) => { remoteLoading.value = false; tip("载入失败：" + e.message); });
    }
    function toggleRemote() {
      remoteOn.value = !remoteOn.value;
      LXM_API.setRemote(remoteOn.value);
      if (remoteOn.value) refreshFromServer();
      else tip("已切回本地演示数据");
    }
    function saveSelectedPeripheral() {
      const p = selectedPeripheral.value;
      if (!p) return;
      if (!p.name) { tip("请填写周边名称"); return; }
      if (remoteOn.value) {
        LXM_API.saveDoc("peripherals", p).then(() => tip("已写入真实后端")).catch((e) => tip("写入失败：" + e.message));
      } else {
        tip("已保存到本地（演示数据模式，切换数据源后才写入服务端）");
      }
    }

    return {
      state, data, can, switchMenu, clearContentFilters,
      openContent, openContentQuick, openContentLogs, openContentTrash, previewContent,
      requestDeletePeripheral, productStatus, togglePeripheralShelf, setPeripheralMode,
      peripheralSummary, peripheralModeText, peripheralStockStatus,
      seriesName, spotName, money,
      selectedPeripheralId, remotePeripherals, remoteOn, remoteLoading,
      listSource, selectedPeripheral,
      isSelected, selectPeripheral,
      refreshFromServer, toggleRemote, saveSelectedPeripheral
    };
  }
});
