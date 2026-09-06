// 回收站
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    addOrderTimeline,
    data,
    log,
    roleProfile,
    state
  } = ctx;

function restoreTrash(row) {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以恢复回收站数");
  const order = data.orders.find((o) => o.id === row.refId || o.orderNo === row.name);
  if (row.type === "订单" && order) {
    order.deleted = false;
    order.status = "pending";
    addOrderTimeline(order, "从回收站恢复订单，状态回到待确认", roleProfile.value.name);
  }
  if (row.type === "打卡" && row.source) {
    const existing = data.spots.find((item) => item.id === row.source.id);
    if (existing) Object.assign(existing, row.source, { deleted: false, status: row.source.status === "停用" ? "启用" : row.source.status || "启用" });
    else data.spots.unshift({ ...row.source, deleted: false, status: row.source.status || "启用" });
  }
  if (row.type === "照片单品" && row.source) {
    const existing = data.albums.find((item) => item.id === row.source.id);
    if (existing) Object.assign(existing, row.source, { deleted: false, status: row.source.status === "下架" ? "启用" : row.source.status || "启用" });
    else data.albums.unshift({ ...row.source, deleted: false, status: row.source.status || "启用" });
  }
  if (row.type === "摄影周边" && row.source) {
    const existing = data.peripherals.find((item) => item.id === row.source.id);
    if (existing) Object.assign(existing, row.source, { deleted: false, status: row.source.status === "下架" ? "上架" : row.source.status || "上架", enabled: true, isShow: true });
    else data.peripherals.unshift({ ...row.source, deleted: false, status: row.source.status || "上架", enabled: true, isShow: true });
  }
  if (row.sourceKey && row.source) {
    const restoreMap = {
      packages: data.packages,
      addonServices: data.addonServices,
      tagLibrary: data.tagLibrary,
      series: data.series,
      samples: data.samples,
    };
    const target = restoreMap[row.sourceKey];
    if (target) {
      const existing = target.find((item) => item.id === row.source.id);
      const restored = { ...row.source, deleted: false };
      if (row.sourceKey === "packages") {
        restored.status = restored.status || "下架";
        restored.isShow = restored.isShow !== false;
      }
      if (row.sourceKey === "addonServices") restored.enabled = restored.enabled !== false;
      if (row.sourceKey === "tagLibrary") restored.status = restored.status || "启用";
      if (existing) Object.assign(existing, restored);
      else target.unshift(restored);
    }
  }
  const index = state.trash.indexOf(row);
  if (index >= 0) state.trash.splice(index, 1);
  log("恢复回收站数", row.name, row.reason || "");
  ElMessage.success("已恢复到业务列表");
}
function restoreAllTrash() {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以恢复回收站数");
  if (!state.trash.length) return ElMessage.warning("回收站暂无可恢复数据");
  ElMessageBox.confirm(`确认恢复回收站内 ${state.trash.length} 条数据？订单将回到待确认状态。`, "全部恢复", { type: "warning", confirmButtonText: "确认恢复", cancelButtonText: "暂不恢复" }).then(() => {
    const rows = [...state.trash];
    rows.forEach((row) => {
      const order = data.orders.find((o) => o.id === row.refId || o.orderNo === row.name);
      if (row.type === "订单" && order) {
        order.deleted = false;
        order.status = "pending";
        addOrderTimeline(order, "从回收站批量恢复订单，状态回到待确认", roleProfile.value.name);
      } else if (row.type === "打卡" || row.type === "照片单品" || row.type === "摄影周边" || row.sourceKey) {
        restoreTrash(row);
      }
    });
    state.trash.splice(0, state.trash.length);
    log("批量恢复回收站数", "回收", `${rows.length} 条数据已恢复`);
    ElMessage.success("已全部恢复到业务列表");
  }).catch(() => {});
}
function purgeTrash(row) {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以彻底删除");
  ElMessageBox.confirm("彻底删除后演示数据中也不再显示，正式版需后端二次确认。是否继续？", "彻底删除", { type: "warning" }).then(() => {
    const index = state.trash.indexOf(row);
    if (index >= 0) state.trash.splice(index, 1);
    log("彻底删除回收站数", row.name, row.reason || "");
    ElMessage.success("已彻底删除该条回收站记录");
  }).catch(() => {});
}
function clearTrash() {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以清空回收");
  if (!state.trash.length) return ElMessage.warning("回收站已经是空的");
  ElMessageBox.confirm(`确认清空回收站内 ${state.trash.length} 条数据？清空后不可在后台恢复。`, "清空回收", { type: "warning", confirmButtonText: "确认清空", cancelButtonText: "暂不清空" }).then(() => {
    const count = state.trash.length;
    state.trash.splice(0, count);
    log("清空回收", "回收", `${count} 条数据已清空`);
    ElMessage.success("回收站已清空");
  }).catch(() => {});
}


  return {
    restoreTrash,
    restoreAllTrash,
    purgeTrash,
    clearTrash
  };
});
