// 订单操作、售后与财务复核
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    ElMessage,
    ElMessageBox,
    addOrderTimeline,
    afterSaleRows,
    can,
    canEditOrder,
    clearOrderFilters,
    computed,
    currentOperatorName,
    data,
    currentStaff,
    dashboard,
    due,
    isOrderAfterSaleLocked,
    isOrderCancelledStatus,
    isOrderCompletedStatus,
    log,
    manualOrderProducts,
    money,
    normalizeReviewStatus,
    onMounted,
    orderFinanceReviews,
    persistOrderAction,
    roleProfile,
    scopedOrders,
    selectedOrders,
    sameShop,
    shopName,
    state,
    switchMenu
  } = ctx;

function handleMessage(row) {
  if (row.action === "pending") {
    clearOrderFilters();
    state.filters.status = "pending";
    switchMenu("orders", { preserveFilters: true });
  } else if (row.action === "due") {
    state.dashboardDrill = "due";
    switchMenu("dashboard", { preserveFilters: true });
  } else if (row.action === "unassigned") {
    clearOrderFilters();
    state.filters.status = "confirmed";
    state.filters.photographerId = "";
    switchMenu("orders", { preserveFilters: true });
  } else if (row.action === "scan") {
    state.dashboardDrill = "scan";
    switchMenu("dashboard", { preserveFilters: true });
  }
}
function onOrderSelection(rows) {
  state.selectedOrderIds = rows.map((row) => row.id);
}
async function refreshOrders() {
  const connected = !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD?.getColl && window.LXM_CLOUD_MODE !== "mock");
  if (!connected) return ElMessage.info("当前为本地演示数据，无需刷新");
  state.orderRefreshing = true;
  try {
    const response = await window.LXM_CLOUD.getColl("orders");
    const rows = Array.isArray(response) ? response : (response && (response.data || response.rows) || []);
    data.orders = rows.filter((row) => row && typeof row === "object").map((row) => {
      const next = { ...row };
      next.id = next.id || next._id || "";
      next._id = next._id || next.id;
      next.products = Array.isArray(next.products) ? next.products : (Array.isArray(next.productItems) ? next.productItems : (Array.isArray(next.items) ? next.items : []));
      next.productItems = Array.isArray(next.productItems) ? next.productItems : next.products;
      next.items = Array.isArray(next.items) ? next.items : next.products;
      next.customer = next.customer || next.contactName || next.name || "";
      next.totalAmount = next.totalAmount === undefined ? (next.totalPrice ?? next.price ?? 0) : next.totalAmount;
      next.totalPrice = next.totalPrice === undefined ? next.totalAmount : next.totalPrice;
      next.appointmentAt = next.appointmentAt || next.date || "";
      next.timePeriod = next.timePeriod || next.time || "";
      return next;
    });
    state.orderPage = 1;
    state.selectedOrderIds = [];
    ElMessage.success(`已刷新 ${data.orders.length} 条订单`);
  } catch (error) {
    ElMessage.error((error && error.message) || "订单刷新失败，请稍后重试");
  } finally {
    state.orderRefreshing = false;
  }
}
function exportOrders() {
  log("导出订单", "订单管理", `按当前筛选导"${scopedOrders.value.length} 条，选中 ${selectedOrders.value.length} 条`);
  ElMessage.success("演示版已记录订单导出，正式版按当前筛选生成 Excel");
}
function batchCancelOrders() {
  if (!can("cancelOrder")) return ElMessage.error("当前角色无权取消订单");
  if (!selectedOrders.value.length) return ElMessage.warning("请先勾选订");
  if (selectedOrders.value.some((order) => isOrderAfterSaleLocked(order))) return ElMessage.warning("选中的订单包含售后处理中订单，请先完成售后处");
   if (selectedOrders.value.some((order) => isOrderCompletedStatus(order))) return ElMessage.warning("选中的订单包含已完成订单，已完成订单不能取消");
  ElMessageBox.confirm(`确认取消已"${selectedOrders.value.length} 个订单？取消后进入回收站。`, "批量取消订单", { type: "warning", confirmButtonText: "确认取消", cancelButtonText: "暂不取消" }).then(async () => {
    let changed = 0;
    for (const order of selectedOrders.value) {
      try {
        await persistOrderAction(order, "cancel", { reason: "批量取消订单" });
        ctx.addTrashLocal?.({ id: `trash-${order.id}-${Date.now()}`, refId: order.id, type: "订单", name: order.orderNo, reason: "批量取消订单", time: LXMFormat.nowText(), operator: roleProfile.value.name, restorable: true });
        changed += 1;
      } catch (_) {}
    }
    if (changed) {
      log("批量取消订单", "订单管理", `${changed} 个订单进入回收站`);
      state.selectedOrderIds = [];
      ElMessage.success(`已批量取消 ${changed} 单并进入回收站`);
    }
  }).catch(() => {});
}
function canBatchAcceptOrder(order) {
  // Service confirmation creates an immutable commercial snapshot. It requires
  // per-order time, location, people count, service content and pricing, so it
  // must never be bypassed by a bulk "accept" operation.
  return false;
}
function batchAcceptOrders() {
  if (!selectedOrders.value.length) return ElMessage.warning("请先勾选订单");
  ElMessage.info("服务确认需要逐单核对时间、地点、人数、服务内容与报价，请从订单详情完成确认");
}
function openBatchNoteDialog() {
  if (!canEditOrder()) return ElMessage.error("当前角色无权批量备注");
  if (!selectedOrders.value.length) return ElMessage.warning("请先勾选订");
  state.batchNoteText = "";
  state.batchNoteDialog = true;
}
async function confirmBatchNote() {
  const text = String(state.batchNoteText || "").trim();
  if (!text) return ElMessage.warning("请填写批量备注内");
  const rows = selectedOrders.value.filter((order) => !isOrderAfterSaleLocked(order) && !isOrderCompletedStatus(order) && !isOrderCancelledStatus(order));
  if (!rows.length) return ElMessage.warning("已选订单均已锁定，不能批量备注");
  let changed = 0;
  for (const order of rows) {
    try {
      await persistOrderAction(order, "note", { reason: `批量备注：${text}` });
      changed += 1;
    } catch (_) {}
  }
  if (!changed) return;
  log("批量备注", "订单管理", `${changed} 个订单添加备注：${text}`);
  state.batchNoteDialog = false;
  state.batchNoteText = "";
  state.selectedOrderIds = [];
  ElMessage.success(`已为 ${changed} 单添加批量备注`);
}

function onOrderPageSizeChange(size) {
  state.orderPageSize = size;
  state.orderPage = 1;
}
function openOrder(order, options = {}) {
  if (!order || !order.orderNo) return ElMessage.warning("未找到有效订单数据");
  if (options && options.type === "selection") return;
  if (!order.assigneeId && state.role === "service") order.assigneeId = roleProfile.value.staffId || state.currentStaffId || "";
  state.currentOrder = order;
  state.orderReadonly = !!options.readonly;
  state.orderWorkMode = options.mode || "service";
  state.currentFinanceReview = options.financeReview || null;
  state.moneyEdit = "";
  state.moneyDraft = 0;
  state.followText = "";
  order.statusLogs = order.statusLogs || [];
  state.orderDrawer = true;
  log("查看订单", order.orderNo, order.customer);
}
function resetManualOrderForm() {
  const now = LXMFormat.nowText();
  const today = now.slice(0, 10);
  const defaultProduct = manualOrderProducts.value[0] || {};
  state.manualOrderForm = {
    customer: "",
    phone: "",
    wechat: "",
    sourceType: "manual",
    shopId: "",
    distributorId: "",
    productId: defaultProduct.id || "",
    productType: defaultProduct.productType || defaultProduct.type || "package",
    appointmentAt: `${today} 10:00`,
    timePeriod: "待客服确",
    internalNote: "",
  };
}
function createManualOrder() {
  if (!canEditOrder()) return ElMessage.error("当前角色无权创建订单");
  resetManualOrderForm();
  state.manualOrderDialog = true;
}
async function confirmCreateManualOrder() {
  if (!canEditOrder()) return ElMessage.error("当前角色无权创建订单");
  const form = state.manualOrderForm;
  if (!String(form.customer || "").trim()) return ElMessage.warning("请填写客户姓");
  if (!String(form.phone || "").trim()) return ElMessage.warning("请填写客户手机号");
  if (form.sourceType === "shop" && !form.shopId) return ElMessage.warning("请选择来源商家");
  if (!form.productId) return ElMessage.warning("请选择下单商品");
  if (!form.appointmentAt) return ElMessage.warning("请选择拍摄预约时间");
  const now = LXMFormat.nowText();
  const today = now.slice(0, 10);
  const selected = manualOrderProducts.value.find((item) => item.id === form.productId) || {};
  const product = selected.id ? { id: selected.id, type: selected.productType || selected.type || "package", price: Number(selected.specialPrice || selected.price || 0) } : { id: "", type: "package", price: 0 };
  const isShopSource = form.sourceType === "shop";
  const isHeadquarterSourceValue = form.sourceType === "headquarter";
  const order = {
    id: `manual-${Date.now()}`,
    orderNo: `LS${today.replaceAll("-", "")}${String(data.orders.length + 101).slice(-3)}`,
    openid: "",
    customer: form.customer.trim(),
    phone: form.phone.trim(),
    wechat: String(form.wechat || "").trim(),
    shopId: isShopSource ? form.shopId : "",
    distributorId: isShopSource ? form.distributorId : "",
    sourceType: form.sourceType,
    sourceName: isHeadquarterSourceValue ? "总部二维码" : isShopSource ? "商家二维码" : "客服手动创建",
    sourceScene: isHeadquarterSourceValue ? "总部自有二维" : isShopSource ? "商家铺码转化" : "后台手动录入",
    status: "pending",
    customerStatus: "reserved",
    assigneeId: roleProfile.value.staffId || currentStaff.value?.id || "",
    photographerId: "",
    appointmentAt: form.appointmentAt,
    timePeriod: form.timePeriod || "待客服确",
    totalAmount: Number(product.price || 0),
    finalPaid: 0,
    depositFinanceStatus: "",
    finalFinanceStatus: "",
    paymentVerify: "未核销",
    packageSnapshot: selected.id ? { name: selected.name, price: Number(product.price || 0), originalPrice: Number(selected.originalPrice || selected.price || product.price || 0) } : {},
    priceAdjustReason: "",
    customerRemark: "",
    internalNote: form.internalNote || "客服后台手动创建订单",
    products: product.id ? [product] : [],
    addons: [],
    statusLogs: [
      {
        time: now,
        operator: currentOperatorName(),
        action: `客服手动创建订单 ${form.customer.trim()}，来源：${isShopSource ? shopName(form.shopId) : isHeadquarterSourceValue ? "总部二维码" : "后台手动录入"}`
      }
    ],
    deleted: false
  };
  const connected = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE !== "mock" && window.LXM_AUTH?.hasSession?.();
  if (connected && window.LXM_CLOUD?.create) {
    try {
      const saved = await window.LXM_CLOUD.create("orders", order);
      if (!saved || saved.error) throw new Error(saved && saved.error ? saved.error : "订单保存失败");
      Object.assign(order, saved, { id: saved.id || saved._id || order.id, _id: saved._id || saved.id || order.id });
    } catch (error) {
      return ElMessage.error((error && error.message) || "订单未保存，请稍后重试");
    }
  }
  data.orders.unshift(order);
  state.manualOrderDialog = false;
  state.filters.status = "";
  state.filters.keyword = "";
  log("创建订单", order.orderNo, "客服在订单管理手动创建新订单");
  openOrder(order, { mode: "service" });
  ElMessage.success("订单已创建，请先在订单详情登记订金并等待财务确认");
}
function openOrderById(id, options = {}) {
  const order = data.orders.find((o) => o.id === id || o.orderNo === id);
  if (order) openOrder(order, options);
}
function openAfterSalesForOrder(order) {
  state.filters.keyword = order.orderNo;
  state.filters.status = "";
  state.filters.productType = "";
  state.filters.assigneeId = "";
  switchMenu("afterSales", { preserveFilters: true });
}
function openAfterSaleSubmit(order = state.currentOrder) {
  if (!order) return;
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单已有售后处理中，请先完成当前售后处理，避免重复提交");
  state.afterSaleForm = {
    attachmentFileIds: [], attachmentFiles: [],
    type: "退款申请",
    reason: "",
    refundAmount: Math.max(0, Number(order.depositPaid || 0) + Number(order.finalPaid || 0)),
  };
  state.afterSaleSubmitDialog = true;
}
async function submitAfterSale() {
  const order = state.currentOrder;
  if (!order) return;
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单已有售后处理中，请先完成当前售后处理，避免重复提交");
  const form = state.afterSaleForm;
  if (!form.reason.trim()) return ElMessage.warning("请填写售后原");
  const refundAmount = Number(form.refundAmount || 0);
  const item = {
    id: `as${Date.now()}`,
    orderId: order.id,
    type: form.type,
    customer: order.customer,
    reason: form.reason.trim(),
    attachmentFileIds: (form.attachmentFileIds || []).slice(),
    status: "待处",
    customerVisibleStatus: "已提",
    submitSource: "后台提交",
    assigneeId: order.assigneeId || roleProfile.value.staffId || state.currentStaffId,
    createdAt: LXMFormat.nowText(),
    refundAmount,
    approvedBy: "",
    approvedAt: "",
    logs: [`${currentOperatorName()}提交售后：${form.reason.trim()}`],
  };
  const connected = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE !== "mock" && window.LXM_AUTH?.hasSession?.();
  try {
    if (connected && window.LXM_CLOUD?.create) {
      const saved = await window.LXM_CLOUD.create("afterSales", item);
      if (!saved || saved.error) throw new Error(saved && saved.error ? saved.error : "售后工单保存失败");
      const savedTicket = { ...saved };
      delete savedTicket.order;
      Object.assign(item, savedTicket, { id: saved.id || saved._id || item.id, _id: saved._id || saved.id || item.id });
      if (saved.order) Object.assign(order, saved.order);
    }
    data.afterSales.unshift(item);
    addOrderTimeline(order, `提交售后：${item.type} ${item.reason}`);
    state.afterSaleSubmitDialog = false;
    ElMessage.success("售后已提交，可在售后服务页面继续处理");
  } catch (error) {
    ElMessage.error((error && error.message) || "售后未保存，请稍后重试");
  }
}
function openAfterSaleProcess(row) {
  state.currentAfterSale = row;
  const order = data.orders.find((item) => item.id === row.orderId);
  if (order) openOrder(order, { mode: "afterSale" });
  state.afterSaleProcessForm = {
    attachmentFileIds: (row.internalAttachmentFileIds || []).slice(),
    existingAttachmentFileIds: (row.internalAttachmentFileIds || []).slice(),
    attachmentFiles: (row.internalAttachments || []).slice(),
    action: "售后跟进",
    note: "",
    refundAmount: Number(row.refundAmount || row.amount || 0),
    refundConfirmed: !!row.refundConfirmed || ["待财务审", "已完"].includes(row.status) || ["待审", "已审"].includes(normalizeReviewStatus(row.financeStatus)),
  };
}
function completeAfterSale(row) {
  if (isAfterSaleProcessReadonly(row)) return ElMessage.warning("该售后已处理完成，不能重复修");
  state.currentAfterSale = row;
  state.afterSaleProcessForm = {
    attachmentFileIds: (row.internalAttachmentFileIds || []).slice(),
    existingAttachmentFileIds: (row.internalAttachmentFileIds || []).slice(),
    attachmentFiles: (row.internalAttachments || []).slice(),
    action: "处理完成",
    note: "售后问题已处理完",
    refundAmount: Number(row.refundAmount || row.amount || 0),
    refundConfirmed: !!row.refundConfirmed || ["待财务审", "已完"].includes(row.status) || ["待审", "已审"].includes(normalizeReviewStatus(row.financeStatus)),
  };
  saveAfterSaleProcess(true);
}
function isAfterSaleProcessReadonly(row = state.currentAfterSale) {
  if (!row) return false;
  return row.status === "已完" || row.status === "待财务审" || ["待审", "已审"].includes(normalizeReviewStatus(row.financeStatus));
}
function confirmAfterSaleRefundAmount() {
  const row = state.currentAfterSale;
  const source = row ? data.afterSales.find((item) => item.id === row.id) : null;
  if (!row || !source) return;
  if (isAfterSaleProcessReadonly(source)) return ElMessage.warning("该售后已处理完成，退款金额不能再修改");
  const amount = Number(state.afterSaleProcessForm.refundAmount || 0);
  if (amount <= 0) return ElMessage.warning("无退款金额时不需要确认退");
  ElMessageBox.confirm(`确认本次售后退款金额为 ${money(amount)}？确认后本次处理内金额会锁定，处理完成后进入财务审核。`, "确认退款金", {
    type: "warning",
    confirmButtonText: "确认退款金",
    cancelButtonText: "再核对一下",
  }).then(() => {
    state.afterSaleProcessForm.refundConfirmed = true;
    source.refundAmount = amount;
    source.refundConfirmed = true;
    source.updatedAt = LXMFormat.nowText();
    ElMessage.success("退款金额已确认");
  }).catch(() => {});
}
async function saveAfterSaleProcess(complete = false, confirmed = false) {
  const row = state.currentAfterSale;
  if (!row) return;
  const source = data.afterSales.find((item) => item.id === row.id);
  const order = data.orders.find((item) => item.id === row.orderId);
  if (!source || !order) return;
  const beforeSource = JSON.parse(JSON.stringify(source));
  const beforeOrder = JSON.parse(JSON.stringify(order));
  if (isAfterSaleProcessReadonly(source)) return ElMessage.warning("该售后已处理完成，不能再修改处理说明或退款金");
  const form = state.afterSaleProcessForm;
  if (!form.note.trim()) return ElMessage.warning("请填写售后跟进说");
  const refundAmount = Number(form.refundAmount || 0);
  const hasRefundAmount = refundAmount > 0;
  if (complete && hasRefundAmount && !form.refundConfirmed) return ElMessage.warning("请先点击「确认退款金额」，再处理完");
  if (complete && !confirmed) {
    const message = hasRefundAmount
      ? `确认"${row.orderNo} 标记为售后处理完成，并提交退款金"${money(refundAmount)} 到财务审核？财务审核前订单仍会保持售后锁定。`
      : `确认"${row.orderNo} 的售后处理标记为完成？完成后该订单客服处理锁定会解除，并进入售后记录。`;
    return ElMessageBox.confirm(message, "确认处理完成", {
      type: "warning",
      confirmButtonText: "确认处理完成",
      cancelButtonText: "暂不完成",
    }).then(() => saveAfterSaleProcess(true, true)).catch(() => {});
  }
  if (complete && hasRefundAmount) {
    source.status = "待财务审";
    source.refundAmount = refundAmount;
    source.refundConfirmed = true;
    source.financeStatus = "待审";
    source.customerVisibleStatus = "处理";
    source.updatedAt = LXMFormat.nowText();
    addOrderTimeline(order, `退款售后已提交财务审核 ${money(source.refundAmount)}；说明：${form.note.trim()}`);
  } else if (complete) {
    source.refundAmount = 0;
    source.refundConfirmed = true;
    source.status = "已完";
    source.financeStatus = source.financeStatus || "无需财务审核";
    source.customerVisibleStatus = "已完";
    source.updatedAt = LXMFormat.nowText();
    addOrderTimeline(order, `售后已完成：${form.note.trim()}`);
  } else {
    source.status = "处理";
    source.customerVisibleStatus = "处理";
    if (hasRefundAmount && form.refundConfirmed) {
      source.refundAmount = refundAmount;
      source.refundConfirmed = true;
    }
    source.updatedAt = LXMFormat.nowText();
    addOrderTimeline(order, `售后处理中：${form.note.trim()}`);
  }
  source.logs = source.logs || [];
  source.logs.unshift(`${currentOperatorName()} ${complete ? "处理完成" : "保存跟进记录"}：${form.note.trim()}`);
  log("售后处理", order.orderNo, `${source.type} / ${source.status} / ${form.note.trim()}`);
  const connected = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE !== "mock" && window.LXM_AUTH?.hasSession?.();
  if (connected && window.LXM_CLOUD?.afterSaleAction) {
    try {
      const saved = await window.LXM_CLOUD.afterSaleAction(source.id || source._id, complete ? "complete" : "follow", {
        refundAmount,
        refundConfirmed: !!form.refundConfirmed,
        reason: form.note.trim(),
        attachmentFileIds: (form.attachmentFileIds || []).slice(),
      });
      const serverTicket = saved && (saved.ticket || saved);
      if (!serverTicket || serverTicket.error) throw new Error(serverTicket && serverTicket.error ? serverTicket.error : "售后工单保存失败");
      Object.assign(source, serverTicket);
      form.attachmentFileIds = (source.internalAttachmentFileIds || []).slice();
      form.existingAttachmentFileIds = form.attachmentFileIds.slice();
      form.attachmentFiles = (source.internalAttachments || []).slice();
      if (saved && saved.order) Object.assign(order, saved.order);
    } catch (error) {
      Object.assign(source, beforeSource);
      Object.assign(order, beforeOrder);
      return ElMessage.error((error && error.message) || "售后未保存，请稍后重试");
    }
  }
  state.orderWorkMode = "afterSale";
  if (!complete) {
    state.afterSaleProcessForm.note = "";
    state.afterSaleProcessForm.action = "售后跟进";
  }
  ElMessage.success(complete ? "售后处理完成状态已更新" : "售后跟进记录已保存");
}
const financeRefundReviewRows = computed(() => afterSaleRows.value.filter((row) => Number(row.refundAmount || row.amount || 0) > 0 && normalizeReviewStatus(row.financeStatus) !== "已审"));
const financeReviewRows = computed(() => {
  const orderRows = scopedOrders.value.flatMap(orderFinanceReviews).filter((row) => row.status !== "未提");
  const refundRows = financeRefundReviewRows.value.map((row) => ({
    ...row,
    id: `refund-${row.id}`,
    type: "退款审核",
    amount: Number(row.refundAmount || row.amount || 0),
    status: row.financeStatus || "待审",
    source: "afterSale",
    afterSaleId: row.id,
    note: row.reason || "售后退款待财务核对",
  }));
  let rows = [...refundRows, ...orderRows];
  if (state.filters.status) rows = rows.filter((row) => row.status === state.filters.status);
  if (state.filters.productType) rows = rows.filter((row) => row.type === state.filters.productType);
  if (state.filters.shopId) rows = rows.filter((row) => sameShop(row, state.filters.shopId));
  if (state.filters.keyword) rows = rows.filter((row) => JSON.stringify(row).includes(state.filters.keyword));
  return rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
});
const financeReviewOrderRows = computed(() => {
  const map = new Map();
  financeReviewRows.value.forEach((item) => {
    if (!map.has(item.orderId)) {
      map.set(item.orderId, {
        id: `finance-order-${item.orderId}`,
        orderId: item.orderId,
        orderNo: item.orderNo,
        customer: item.customer,
        shopId: item.shopId,
        createdAt: item.createdAt,
        items: [],
      });
    }
    const row = map.get(item.orderId);
    row.items.push(item);
    if (String(item.createdAt || "") > String(row.createdAt || "")) row.createdAt = item.createdAt;
  });
  return Array.from(map.values()).map((row) => ({
    ...row,
    amount: row.items.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    pendingCount: row.items.filter((item) => item.status === "待审").length,
    approvedCount: row.items.filter((item) => normalizeReviewStatus(item.status) === "已审").length,
    rejectedCount: row.items.filter((item) => item.status === "已驳").length,
    typesText: [...new Set(row.items.map((item) => item.type))].join(""),
    itemSummary: row.items.map((item) => `${item.type} ${money(item.amount)} · ${item.status}`).join(""),
    statusText: row.items.some((item) => item.status === "待审") ? "待审" : row.items.some((item) => item.status === "已驳") ? "有驳" : "已审",
  }));
});
const financeReviewRecordRows = computed(() => financeReviewRows.value.filter((row) => row.status !== "待审"));
const financeReviewSummary = computed(() => ({
  pending: financeReviewRows.value.filter((row) => row.status === "待审").length,
  approved: financeReviewRows.value.filter((row) => normalizeReviewStatus(row.status) === "已审").length,
  rejected: financeReviewRows.value.filter((row) => row.status === "已驳").length,
  amount: financeReviewRows.value.reduce((sum, row) => sum + Number(row.amount || 0), 0),
}));
function reviewFinanceItem(row, approved = true) {
  if (!can("financeReview")) return ElMessage.error("当前角色无权进行财务审核");
  if (approved && normalizeReviewStatus(row.status) === "已审") return ElMessage.warning("该记录已审核通过，不能重复通过");
  if (!approved && row.status === "已驳") return ElMessage.warning("该记录已驳回，不能重复驳");
  const actionText = approved ? "审核通过" : "审核驳回";
  ElMessageBox.confirm(`确认 ${row.orderNo} 的「${row.type}${actionText}」？金额：${money(row.amount)}。`, `确认${approved ? "通过" : "驳回"}财务审核`, {
    type: approved ? "warning" : "error",
    confirmButtonText: approved ? "确认通过" : "确认驳回",
    cancelButtonText: "再核对一下",
  }).then(() => applyFinanceReview(row, approved)).catch(() => {});
}
async function applyFinanceReview(row, approved = true) {
  const order = data.orders.find((item) => item && (item.id === row.orderId || item._id === row.orderId));
  if (!order) return;
  const original = JSON.parse(JSON.stringify(order));
  const status = approved ? "已审" : "已驳";
  if (row.source === "afterSale") {
    applyRefundReview(row, approved);
    return;
  }
  const typeText = row.type;
  const amountText = money(row.amount);
  const connected = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE !== "mock" && window.LXM_AUTH?.hasSession?.();
  if (connected && window.LXM_CLOUD?.orderAction) {
    try {
      const phase = row.field === "depositFinanceStatus" ? "deposit" : "final";
      const pendingRecord = (Array.isArray(order.paymentRecords) ? order.paymentRecords : [])
        .filter((record) => record && String(record.phase || "") === phase && String(record.status || "").toLowerCase() === "pending")
        .slice(-1)[0];
      const orderId = String(order.id || order._id || row.orderId || "order");
      const idempotencyKey = String((pendingRecord && (pendingRecord.idempotencyKey || pendingRecord.confirmationIdempotencyKey))
        || `finance-${orderId}-${phase}-${row.id}-${approved ? "confirm" : "reject"}`)
        .replace(/[^A-Za-z0-9_.:-]/g, "-")
        .slice(0, 120);
      await persistOrderAction(order, "payment", {
        phase,
        amount: Number(row.amount || 0),
        paymentStatus: approved ? "confirmed" : "failed",
        idempotencyKey,
        reason: `财务审核${approved ? "通过" : "驳回"}${typeText}`,
      });
    } catch (error) {
      Object.keys(order).forEach((key) => { if (!(key in original)) delete order[key]; });
      Object.assign(order, original);
      return ElMessage.error((error && error.message) || "财务审核未保存，请稍后重试");
    }
  } else {
    order[row.field] = status;
    const paymentField = row.field === "depositFinanceStatus" ? "depositPaymentStatus" : "finalPaymentStatus";
    order[paymentField] = approved ? "confirmed" : "failed";
  }
  row.status = status;
  if (state.currentFinanceReview?.id === row.id) state.currentFinanceReview.status = status;
  addOrderTimeline(order, `财务${approved ? "审核通过" : "审核驳回"}${typeText} ${amountText}`, currentOperatorName());
  log("财务审核", order.orderNo, `${typeText} / ${status} / ${amountText}`);
  ElMessage.success(`${typeText} ${approved ? "审核通过" : "审核驳回"}`);
}
function openFinanceReview(row) {
  const order = data.orders.find((item) => item.id === row.orderId);
  if (!order) return ElMessage.warning("未找到关联订");
  const items = row.items || financeReviewRows.value.filter((item) => item.orderId === row.orderId);
  openOrder(order, { mode: "finance", financeReview: { ...row, items } });
}
function reviewRefund(row, approved = true) {
  if (!can("financeReview")) return ElMessage.error("当前角色无权审核退款");
  if (approved && normalizeReviewStatus(row.status) === "已审") return ElMessage.warning("该记录已审核通过，不能重复通过");
  if (!approved && row.status === "已驳") return ElMessage.warning("该记录已驳回，不能重复驳");
  const actionText = approved ? "审核通过" : "审核驳回";
  ElMessageBox.confirm(`确认 ${row.orderNo} 的「退款审核${actionText}」？金额：${money(row.amount || row.refundAmount || 0)}。`, `确认${approved ? "通过" : "驳回"}退款审核`, {
    type: approved ? "warning" : "error",
    confirmButtonText: approved ? "确认通过" : "确认驳回",
    cancelButtonText: "再核对一下",
  }).then(() => applyRefundReview(row, approved)).catch(() => {});
}
async function applyRefundReview(row, approved = true) {
  const source = data.afterSales.find((item) => item.id === (row.afterSaleId || row.id));
  const order = data.orders.find((item) => item.id === row.orderId);
  if (!source || !order) return;
  const beforeSource = JSON.parse(JSON.stringify(source));
  const beforeOrder = JSON.parse(JSON.stringify(order));
  source.financeStatus = approved ? "已审" : "已驳";
  row.status = source.financeStatus;
  if (state.currentFinanceReview?.id === row.id) state.currentFinanceReview.status = source.financeStatus;
  source.financeReviewedBy = currentOperatorName();
  source.financeReviewedAt = LXMFormat.nowText();
  source.updatedAt = LXMFormat.nowText();
  source.status = approved ? "已完" : "处理";
  source.customerVisibleStatus = approved ? "已完" : "处理";
  source.logs = source.logs || [];
  source.logs.unshift(`${currentOperatorName()} ${approved ? "财务审核通过" : "财务审核驳回"}，退款金额 ${money(source.refundAmount || 0)}`);
  addOrderTimeline(order, `${approved ? "财务审核通过退" : "财务驳回退"} ${money(source.refundAmount || 0)}`);
  log("退款财务审", order.orderNo, `${approved ? "通过" : "驳回"} / ${money(source.refundAmount || 0)}`);
  const connected = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE !== "mock" && window.LXM_AUTH?.hasSession?.();
  if (connected && window.LXM_CLOUD?.afterSaleAction) {
    try {
      const saved = await window.LXM_CLOUD.afterSaleAction(source.id || source._id, "review", {
        approved,
        reason: approved ? "退款审核通过" : "退款审核驳回",
      });
      const serverTicket = saved && (saved.ticket || saved);
      if (!serverTicket || serverTicket.error) throw new Error(serverTicket && serverTicket.error ? serverTicket.error : "退款审核保存失败");
      Object.assign(source, serverTicket);
      if (saved && saved.order) Object.assign(order, saved.order);
    } catch (error) {
      Object.assign(source, beforeSource);
      Object.assign(order, beforeOrder);
      return ElMessage.error((error && error.message) || "退款审核未保存，请稍后重试");
    }
  }
  ElMessage.success(approved ? "退款已通过财务审核，并同步月度对账" : "退款审核已驳回，订单回到售后处理中");
}
onMounted(() => {
  window.LXM_OPEN_ORDER = openOrderById;
  document.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-order-open]");
    if (!target) return;
    const id = target.getAttribute("data-order-open");
    if (id) openOrderById(id);
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      if (!state.authed || state.sidebarCollapsed) state.sidebarCollapsed = false;
      const input = document.getElementById("menu-search-input");
      if (input) input.focus();
    }
    if (event.key === "Escape" && document.activeElement && document.activeElement.id === "menu-search-input") {
      state.menuSearch = "";
    }
  });
});
async function addFollowLog(text) {
  if (!state.currentOrder) return;
  if (isOrderAfterSaleLocked()) return ElMessage.warning("该订单售后处理中，客服处理信息暂时锁定，请先完成售后处理");
  const detail = (text || state.followText || "").trim();
  if (!detail) return ElMessage.warning("请先填写跟进内容");
  const order = state.currentOrder;
  const original = JSON.parse(JSON.stringify(order));
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  const connected = !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE !== "mock" && reachable !== false);
  try {
    await persistOrderAction(order, "note", { reason: detail });
    if (!connected) addOrderTimeline(order, detail);
  } catch (_) {
    Object.keys(order).forEach((field) => { if (!(field in original)) delete order[field]; });
    Object.assign(order, original);
    return;
  }
  state.followText = "";
  ElMessage.success("客服跟进记录已添");
}

  return {
    handleMessage,
    onOrderSelection,
    refreshOrders,
    exportOrders,
    batchCancelOrders,
    canBatchAcceptOrder,
    batchAcceptOrders,
    openBatchNoteDialog,
    confirmBatchNote,
    onOrderPageSizeChange,
    openOrder,
    resetManualOrderForm,
    createManualOrder,
    confirmCreateManualOrder,
    openOrderById,
    openAfterSalesForOrder,
    openAfterSaleSubmit,
    submitAfterSale,
    openAfterSaleProcess,
    completeAfterSale,
    isAfterSaleProcessReadonly,
    confirmAfterSaleRefundAmount,
    saveAfterSaleProcess,
    financeRefundReviewRows,
    financeReviewRows,
    financeReviewOrderRows,
    financeReviewRecordRows,
    financeReviewSummary,
    reviewFinanceItem,
    applyFinanceReview,
    openFinanceReview,
    reviewRefund,
    applyRefundReview,
    addFollowLog
  };
});
