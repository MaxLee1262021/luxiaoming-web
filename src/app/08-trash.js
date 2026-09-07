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

function remoteTrashEnabled() {
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  return !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD?.update && window.LXM_CLOUD?.remove
    && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
}
async function removeTrashRecordRemote(row) {
  if (!remoteTrashEnabled() || !row || !(row.id || row._id)) return true;
  await window.LXM_CLOUD.remove("trash", row.id || row._id);
  return true;
}
function trashSourceKey(row) {
  if (row && row.sourceKey) return row.sourceKey;
  return ({
    "打卡": "spots", "打卡点": "spots", "照片单品": "albums", "摄影周边": "peripherals",
    "样片": "samples", "图片样片": "samples", "视频样片": "samples", "拍摄风格": "series", "城市": "cities",
  })[row && row.type] || "";
}
async function restoreSourceRecordRemote(row) {
  if (!remoteTrashEnabled() || !row || !row.source) return true;
  const key = trashSourceKey(row);
  const id = row.source.id || row.source._id;
  if (!key || !id) return true;
  const patch = { ...row.source, id, _id: id, deleted: false, isDeleted: false };
  if (["打卡", "打卡点", "照片单品", "样片", "图片样片", "视频样片", "拍摄风格", "城市"].includes(row.type)) {
    patch.status = row.source.status === "停用" || row.source.status === "下架" ? "启用" : row.source.status || "启用";
  }
  if (["摄影周边", "照片套餐", "短视频套", "增值服务", "增值服"].includes(row.type) || ["peripherals", "packages", "addonServices"].includes(key)) {
    patch.status = row.source.status === "下架" ? "上架" : row.source.status || "上架";
    patch.isShow = true;
    if (["peripherals", "addonServices"].includes(key)) patch.enabled = true;
  }
  await window.LXM_CLOUD.update(key, id, patch);
  return true;
}

async function restoreTrash(row) {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以恢复回收站数");
  const order = data.orders.find((o) => o.id === row.refId || o.orderNo === row.name);
  if (remoteTrashEnabled() && row.type === "订单" && order) {
    try {
      if (!window.LXM_CLOUD.orderAction) throw new Error("订单恢复接口不可用");
      const restored = await window.LXM_CLOUD.orderAction(order.id, "restore", { reason: "从回收站恢复订单" });
      if (restored && typeof restored === "object") Object.assign(order, restored);
      await restoreSourceRecordRemote(row);
      await removeTrashRecordRemote(row);
    }
    catch (error) {
      return ElMessage.error((error && error.message) || "订单恢复保存失败，请稍后重试");
    }
  } else {
    try {
      await restoreSourceRecordRemote(row);
      await removeTrashRecordRemote(row);
    }
    catch (error) { return ElMessage.error((error && error.message) || "回收站记录删除失败，请稍后重试"); }
  }
  if (row.type === "订单" && order) {
    order.deleted = false;
    order.isDeleted = false;
    order.status = "new";
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
        restored.status = restored.status === "下架" ? "上架" : restored.status || "上架";
        restored.isShow = restored.isShow !== false;
      }
      if (row.sourceKey === "addonServices") {
        restored.enabled = true;
        restored.status = restored.status === "下架" ? "上架" : restored.status || "上架";
      }
      if (row.sourceKey === "tagLibrary") restored.status = restored.status || "启用";
      if (existing) Object.assign(existing, restored);
      else target.unshift(restored);
    }
  }
  const index = state.trash.indexOf(row);
  if (index >= 0) state.trash.splice(index, 1);
  log("恢复回收站数", row.name, row.reason || "");
  ElMessage.success("已恢复到业务列表");
  return true;
}
async function restoreAllTrash() {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以恢复回收站数");
  if (!state.trash.length) return ElMessage.warning("回收站暂无可恢复数据");
  ElMessageBox.confirm(`确认恢复回收站内 ${state.trash.length} 条数据？订单将回到待确认状态。`, "全部恢复", { type: "warning", confirmButtonText: "确认恢复", cancelButtonText: "暂不恢复" }).then(async () => {
    const rows = [...state.trash];
    let restored = 0;
    for (const row of rows) if (await restoreTrash(row)) restored += 1;
    if (restored === rows.length) {
      log("批量恢复回收站数", "回收", `${rows.length} 条数据已恢复`);
      ElMessage.success("已全部恢复到业务列表");
    } else if (restored) {
      ElMessage.warning(`已恢复 ${restored} 条，失败记录仍保留在回收站`);
    }
  }).catch(() => {});
}
async function purgeTrash(row) {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以彻底删除");
  ElMessageBox.confirm("彻底删除后演示数据中也不再显示，正式版需后端二次确认。是否继续？", "彻底删除", { type: "warning" }).then(async () => {
    try { await removeTrashRecordRemote(row); }
    catch (error) { return ElMessage.error((error && error.message) || "回收站删除失败，请稍后重试"); }
    const index = state.trash.indexOf(row);
    if (index >= 0) state.trash.splice(index, 1);
    log("彻底删除回收站数", row.name, row.reason || "");
    ElMessage.success("已彻底删除该条回收站记录");
  }).catch(() => {});
}
async function clearTrash() {
  if (state.role !== "super") return ElMessage.error("只有总部超管可以清空回收");
  if (!state.trash.length) return ElMessage.warning("回收站已经是空的");
  ElMessageBox.confirm(`确认清空回收站内 ${state.trash.length} 条数据？清空后不可在后台恢复。`, "清空回收", { type: "warning", confirmButtonText: "确认清空", cancelButtonText: "暂不清空" }).then(async () => {
    const count = state.trash.length;
    const rows = [...state.trash];
    try { for (const row of rows) await removeTrashRecordRemote(row); }
    catch (error) { return ElMessage.error((error && error.message) || "回收站清空失败，请稍后重试"); }
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
