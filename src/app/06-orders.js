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
    canManageOrderRecords,
    clearOrderFilters,
    computed,
    currentOperatorName,
    data,
    currentStaff,
    dashboard,
    due,
    isOrderAfterSaleLocked,
    isCreatedBooking,
    isOrderCancelledStatus,
    isOrderCompletedStatus,
    isOrderLedgerReadonly,
    isAutomaticCustomerRefund,
    log,
    money,
    normalizeReviewStatus,
    normalizeAfterSaleStatus,
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
    state.filters.status = "reserved";
    switchMenu("orders", { preserveFilters: true });
  } else if (row.action === "due") {
    state.dashboardDrill = "due";
    switchMenu("dashboard", { preserveFilters: true });
  } else if (row.action === "unassigned") {
    clearOrderFilters();
    state.filters.status = "reserved";
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
  const connected = !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD?.getColl && window.LXM_CLOUD_MODE === "mysql");
  if (!connected) return ElMessage.error("真实后端连接不可用，无法刷新订单");
  state.orderRefreshing = true;
  try {
    const response = await window.LXM_CLOUD.getColl("orders");
    const rows = Array.isArray(response) ? response : (response && (response.data || response.rows) || []);
    data.orders = rows.filter((row) => row && typeof row === "object" && isCreatedBooking(row)).map((row) => {
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
  if (!window.LXM_AUTH?.hasSession?.()) return ElMessage.error("请先登录后导出真实订单");
  return ctx.openExportDialog("orderDetail");
}
function batchCancelOrders() {
  if (isOrderLedgerReadonly()) return ElMessage.warning("订单流水仅供查询与统计，请前往客服工作台处理订单");
  if (!can("cancelOrder")) return ElMessage.error("当前角色无权取消订单");
  if (!selectedOrders.value.length) return ElMessage.warning("请先勾选订");
  if (selectedOrders.value.some((order) => isOrderAfterSaleLocked(order))) return ElMessage.warning("选中的订单包含售后处理中订单，请先完成售后处");
   if (selectedOrders.value.some((order) => isOrderCompletedStatus(order))) return ElMessage.warning("选中的订单包含已完成订单，已完成订单不能取消");
  window.LXMActionConfirm.confirm(ElMessageBox, `确认取消已选 ${selectedOrders.value.length} 个订单？取消后进入回收站，不会自动执行退款。`, "批量取消订单", {
    confirmButtonClass: "lxm-action-confirm--danger",
    cancelButtonClass: "lxm-action-cancel",
    autofocus: false,
    type: "warning", confirmButtonText: "确认取消", cancelButtonText: "暂不取消" }).then(async () => {
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
  if (isOrderLedgerReadonly()) return ElMessage.warning("订单流水仅供查询与统计，请前往客服工作台处理订单");
  if (!canEditOrder()) return ElMessage.error("当前角色无权批量备注");
  if (!selectedOrders.value.length) return ElMessage.warning("请先勾选订");
  state.batchNoteText = "";
  state.batchNoteDialog = true;
}
async function confirmBatchNote() {
  if (isOrderLedgerReadonly()) return ElMessage.warning("订单流水仅供查询与统计，请前往客服工作台处理订单");
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
  if (!order || !order.orderNo || !isCreatedBooking(order)) return ElMessage.warning("未找到有效订单数据");
  if (options && options.type === "selection") return;
  state.currentOrder = order;
  state.orderSection = "info";
  // 记录入口来源，避免离开流水页后仍打开的详情恢复旧编辑能力。
  state.orderLedgerDetail = false;
  state.orderLedgerDetail = isOrderLedgerReadonly();
  state.orderReadonly = !!options.readonly || state.orderLedgerDetail || !canManageOrderRecords(order);
  state.orderWorkMode = options.mode || "service";
  state.currentFinanceReview = options.financeReview || null;
  state.moneyEdit = "";
  state.moneyDraft = 0;
  state.followText = "";
  order.statusLogs = order.statusLogs || [];
  state.orderDrawer = true;
  log("查看订单", order.orderNo, order.customer);
}
async function focusOrderSection(section) {
  if (!["info", "followup", "status", "photography"].includes(section)) return;
  state.orderSection = section;
  await window.Vue.nextTick();
  const target = document.querySelector(`.order-drawer [data-order-section="${section}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  target.focus({ preventScroll: true });
}
async function claimOrder(order) {
  if (isOrderLedgerReadonly()) return ElMessage.warning("请前往客服工作台承接订单");
  if (!order || state.role !== "service" || order.assigneeId) return;
  const staffId = roleProfile.value.staffId || state.currentStaffId || "";
  if (!staffId) return ElMessage.error("当前客服账号缺少人员标识，无法领取订单");
  const original = order.assigneeId;
  try {
    await persistOrderAction(order, "claim", { assigneeId: staffId, reason: "客服领取待处理订单" });
    order.assigneeId = staffId;
    ElMessage.success("订单已领取，当前客服成为负责人");
  } catch (_) {
    order.assigneeId = original;
  }
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
async function openServiceAfterSale(orderNo, options = {}) {
  if (state.afterSaleLookupLoading) return;
  const route = typeof ctx.menuRouteKey === "function" ? ctx.menuRouteKey(state.active) : state.active;
  if (!["svcGeneralWorkbench", "svcWorkbench", "svcIntake", "svcFollowup", "svcComplaints"].includes(route)) return ElMessage.warning("请前往客服工作台提交售后问题");
  const no = String(orderNo || "").trim();
  if (!no || !window.LXM_AUTH?.hasSession?.() || window.LXM_CLOUD_MODE !== "mysql" || !window.LXM_CLOUD?.getColl) return ElMessage.error("真实后端连接不可用，暂不能提交售后问题");
  state.afterSaleLookupLoading = true;
  try {
    // Resolve against authorized business documents. A service projection's
    // numeric id must never become an after-sale orderId by assumption.
    const [orders, tickets] = await Promise.all([window.LXM_CLOUD.getColl("orders"), window.LXM_CLOUD.getColl("afterSales")]);
    const matches = Array.isArray(orders) ? orders.filter(order => String(order.orderNo || order.order_no || "") === no && !order.deleted && !order.isDeleted) : [];
    if (matches.length !== 1 || !Array.isArray(tickets)) throw new Error("未找到唯一且有权限处理的订单，请刷新后重试");
    const row = matches[0], id = row.id || row._id;
    if (!id) throw new Error("订单记录缺少编号，请刷新后重试");
    const existing = data.orders.find(order => String(order.id || order._id) === String(id));
    const order = existing ? Object.assign(existing, row) : { ...row, id };
    if (!existing) data.orders.push(order);
    data.afterSales = tickets;
    state.orderDrawer = false;
    state.orderLedgerDetail = false;
    state.orderReadonly = false;
    state.currentOrder = order;
    if (isOrderAfterSaleLocked(order)) {
      if (route === "svcGeneralWorkbench" && typeof options.onExisting === "function") {
        const ticket = typeof ctx.activeAfterSales === "function" ? ctx.activeAfterSales(order)[0] : undefined;
        options.onExisting(order, ticket);
      } else openAfterSalesForOrder(order);
      return ElMessage.warning("该订单已有处理中售后，请继续处理现有工单");
    }
    openAfterSaleSubmit(order);
  } catch (error) {
    ElMessage.error(error.message || "售后订单加载失败，请稍后重试");
  } finally {
    state.afterSaleLookupLoading = false;
  }
}
function openAfterSaleSubmit(order = state.currentOrder) {
  if (isOrderLedgerReadonly()) return ElMessage.warning("订单流水仅供查询与统计，请前往客服工作台处理订单");
  if (!order) return;
  if (isOrderAfterSaleLocked(order)) return ElMessage.warning("该订单已有售后处理中，请先完成当前售后处理，避免重复提交");
  state.currentOrder = order;
  state.afterSaleForm = {
    attachmentFileIds: [], attachmentFiles: [],
    type: "退款申请",
    reason: "",
    refundAmount: Math.max(0, Number(order.depositPaid || 0) + Number(order.finalPaid || 0)),
  };
  state.afterSaleSubmitDialog = true;
}
async function submitAfterSale() {
  if (isOrderLedgerReadonly()) return ElMessage.warning("订单流水仅供查询与统计，请前往客服工作台处理订单");
  if (!window.LXM_AUTH?.hasSession?.() || window.LXM_CLOUD_MODE !== "mysql" || window.LXM_API_STATE?.reachable === false || !window.LXM_CLOUD?.create) return ElMessage.error("真实后端连接不可用，操作未保存");
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
    financeStatus: "未提交",
    reviewLane: "service_exception",
    approvedBy: "",
    approvedAt: "",
    logs: [`${currentOperatorName()}提交售后：${form.reason.trim()}`],
  };
  const connected = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE === "mysql" && window.LXM_AUTH?.hasSession?.();
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
    openAfterSalesForOrder(order);
    ElMessage.success("售后已提交，可在售后服务页面继续处理");
  } catch (error) {
    ElMessage.error((error && error.message) || "售后未保存，请稍后重试");
  }
}
function openAfterSaleProcess(row) {
  if (isAutomaticCustomerRefund(row)) return ElMessage.warning("该退款由系统自动处理，请在订单详情查看退款进度");
  state.currentAfterSale = row;
  const order = data.orders.find((item) => item.id === row.orderId);
  if (order) openOrder(order, { mode: "afterSale" });
  state.afterSaleProcessForm = {
    attachmentFileIds: (row.internalAttachmentFileIds || []).slice(),
    existingAttachmentFileIds: (row.internalAttachmentFileIds || []).slice(),
    attachmentFiles: (row.internalAttachments || []).slice(),
    action: "售后跟进",
    note: "",
    customerContacted: !!row.customerContactedAt,
    refundAmount: Number(row.refundAmount || row.amount || 0),
    refundConfirmed: isAfterSaleProcessReadonly(row),
  };
}
function completeAfterSale(row) {
  if (isAutomaticCustomerRefund(row) || isAfterSaleProcessReadonly(row)) return ElMessage.warning("该工单不能重复提交，请查看处理记录");
  openAfterSaleProcess(row);
  state.afterSaleProcessForm.action = "处理完成";
}
function isAfterSaleProcessReadonly(row = state.currentAfterSale) {
  if (!row) return false;
  return isAutomaticCustomerRefund(row) || ["已完成", "待财务审核"].includes(normalizeAfterSaleStatus(row.status)) || ["待审", "已审"].includes(normalizeReviewStatus(row.financeStatus));
}
function confirmAfterSaleRefundAmount() {
  const row = state.currentAfterSale;
  const source = row ? data.afterSales.find((item) => item.id === row.id) : null;
  if (!row || !source) return;
  if (isAfterSaleProcessReadonly(source)) return ElMessage.warning("该售后已处理完成，退款金额不能再修改");
  const amount = Number(state.afterSaleProcessForm.refundAmount || 0);
  if (amount <= 0) return ElMessage.warning("无退款金额时不需要确认退");
  window.LXMActionConfirm.confirm(ElMessageBox, `确认本次售后退款金额为 ${money(amount)}？确认后本次处理内金额会锁定，处理完成后进入财务审核。`, "确认退款金额", {
    confirmButtonClass: "lxm-action-confirm--warning",
    cancelButtonClass: "lxm-action-cancel",
    type: "warning",
    confirmButtonText: "确认退款金额",
    cancelButtonText: "再核对一下",
  }).then(() => {
    state.afterSaleProcessForm.refundConfirmed = true;
    ElMessage.success("退款金额已确认");
  }).catch(() => {});
}
async function saveAfterSaleProcess(complete = false, confirmed = false) {
  if (state.afterSaleProcessSubmitting) return;
  if (!window.LXM_AUTH?.hasSession?.() || window.LXM_CLOUD_MODE !== "mysql" || window.LXM_API_STATE?.reachable === false || !window.LXM_CLOUD?.afterSaleAction) return ElMessage.error("真实后端连接不可用，操作未保存");
  const row = state.currentAfterSale;
  if (!row) return;
  const source = data.afterSales.find((item) => item.id === row.id);
  const order = data.orders.find((item) => item.id === row.orderId);
  if (!source || !order) return;
  if (isAfterSaleProcessReadonly(source)) return ElMessage.warning("该售后已处理完成，不能再修改处理说明或退款金");
  const form = state.afterSaleProcessForm;
  if (!form.note.trim()) return ElMessage.warning("请填写售后跟进说明");
  const refundAmount = Number(form.refundAmount || 0);
  if (!Number.isFinite(refundAmount) || refundAmount < 0 || !/^\d+(?:\.\d{1,2})?$/.test(String(form.refundAmount || 0))) return ElMessage.warning("退款金额无效，最多两位小数");
  const hasRefundAmount = refundAmount > 0;
  if (complete && hasRefundAmount && !source.customerContactedAt) return ElMessage.warning("请先联系客人，勾选「已与客人取得联系」并保存跟进记录，再提交退款");
  if (complete && hasRefundAmount && !form.refundConfirmed) return ElMessage.warning("请先确认退款金额，再提交财务审核");
  if (complete && !confirmed) {
    const message = hasRefundAmount
      ? `确认将 ${row.orderNo || order.orderNo} 的退款 ${money(refundAmount)} 提交财务审核？财务通过后将自动发起原路退款，到账以微信退款结果为准。`
      : `确认将 ${row.orderNo || order.orderNo} 的售后处理标记为完成？完成后该订单解除售后锁定，并进入售后记录。`;
    return window.LXMActionConfirm.confirm(ElMessageBox, message, hasRefundAmount ? "提交退款审核" : "确认处理完成", {
      confirmButtonClass: "lxm-action-confirm--success",
      cancelButtonClass: "lxm-action-cancel",
      type: "warning",
      confirmButtonText: hasRefundAmount ? "提交财务审核" : "确认处理完成",
      cancelButtonText: "暂不完成",
    }).then(() => saveAfterSaleProcess(true, true)).catch(() => {});
  }
  state.afterSaleProcessSubmitting = true;
  try {
      const saved = await window.LXM_CLOUD.afterSaleAction(source.id || source._id, complete ? "complete" : "follow", {
        refundAmount: complete ? refundAmount : 0,
        refundConfirmed: !!form.refundConfirmed,
        customerContacted: !complete && form.customerContacted === true,
        reason: form.note.trim(),
        attachmentFileIds: (form.attachmentFileIds || []).slice(),
      });
      const serverTicket = saved && (saved.ticket || saved);
      if (!serverTicket || serverTicket.error || serverTicket.ok === false) throw new Error(serverTicket && serverTicket.error ? serverTicket.error : "售后工单保存失败");
      Object.assign(source, serverTicket);
      if (row !== source) Object.assign(row, serverTicket, { status: normalizeAfterSaleStatus(serverTicket.status) });
      form.customerContacted = !!source.customerContactedAt;
      form.attachmentFileIds = (source.internalAttachmentFileIds || []).slice();
      form.existingAttachmentFileIds = form.attachmentFileIds.slice();
      form.attachmentFiles = (source.internalAttachments || []).slice();
      if (saved && saved.order) Object.assign(order, saved.order);
  } catch (error) {
      return ElMessage.error((error && error.message) || "售后未保存，请稍后重试");
  } finally {
    state.afterSaleProcessSubmitting = false;
  }
  state.orderWorkMode = "afterSale";
  if (!complete) {
    state.afterSaleProcessForm.note = "";
    state.afterSaleProcessForm.action = "售后跟进";
  }
  ElMessage.success(complete ? hasRefundAmount ? "退款已提交财务审核" : "售后处理已完成" : "售后跟进记录已保存");
}
const financeRefundReviewRows = computed(() => afterSaleRows.value.filter((row) => !isAutomaticCustomerRefund(row)
  && Number(row.refundAmount || row.amount || 0) > 0
  && (["已审", "已驳"].includes(normalizeReviewStatus(row.financeStatus))
    || (normalizeReviewStatus(row.financeStatus) === "待审" && (normalizeAfterSaleStatus(row.status) === "待财务审核" || row.reviewLane === "pre_dispatch")))));
const financeReviewRows = computed(() => {
  const orderRows = scopedOrders.value.flatMap(orderFinanceReviews).filter((row) => row.status !== "未提");
  const refundRows = financeRefundReviewRows.value.map((row) => ({
    ...row,
    id: `refund-${row.id}`,
    type: "退款审核",
    amount: Number(row.refundAmount || row.amount || 0),
    status: normalizeReviewStatus(row.financeStatus),
    source: "afterSale",
    afterSaleId: row.id,
    note: row.reason || "售后退款待财务核对",
  }));
  let rows = [...refundRows, ...orderRows];
  if (state.filters.financeReviewStatus) rows = rows.filter((row) => row.status === state.filters.financeReviewStatus);
  if (state.filters.financeReviewType) rows = rows.filter((row) => row.type === state.filters.financeReviewType);
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
  if (row.source === "afterSale") return reviewRefund(row, approved);
  if (approved && normalizeReviewStatus(row.status) === "已审") return ElMessage.warning("该记录已审核通过，不能重复通过");
  if (!approved && row.status === "已驳") return ElMessage.warning("该记录已驳回，不能重复驳");
  const actionText = approved ? "审核通过" : "审核驳回";
  window.LXMActionConfirm.confirm(ElMessageBox, `确认 ${row.orderNo} 的「${row.type}${actionText}」？金额：${money(row.amount)}。`, `确认${approved ? "通过" : "驳回"}财务审核`, {
    confirmButtonClass: approved ? "lxm-action-confirm--success" : "lxm-action-confirm--danger",
    cancelButtonClass: "lxm-action-cancel",
    autofocus: approved,
    type: approved ? "warning" : "error",
    confirmButtonText: approved ? "确认通过" : "确认驳回",
    cancelButtonText: "再核对一下",
  }).then(() => applyFinanceReview(row, approved)).catch(() => {});
}
async function applyFinanceReview(row, approved = true) {
  if (!window.LXM_AUTH?.hasSession?.() || window.LXM_CLOUD_MODE !== "mysql" || window.LXM_API_STATE?.reachable === false) return ElMessage.error("真实后端连接不可用，操作未保存");
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
  const connected = window.LXM_CLOUD_MODE && window.LXM_CLOUD_MODE === "mysql" && window.LXM_AUTH?.hasSession?.();
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
function canQueryRefund(row) {
  if (!row || row.source !== "afterSale") return false;
  const ticket = data.afterSales.find((item) => item.id === (row.afterSaleId || row.id));
  return !!ticket && !isAutomaticCustomerRefund(ticket) && ["processing", "refund_failed"].includes(String(ticket.refundStatus || ""))
    && Array.isArray(ticket.refundAttempts) && ticket.refundAttempts.length > 0;
}
function reviewRefund(row, approved = true) {
  if (!can("financeReview")) return ElMessage.error("当前角色无权审核退款");
  const ticket = data.afterSales.find((item) => item.id === (row.afterSaleId || row.id));
  if (isAutomaticCustomerRefund(ticket)) return ElMessage.warning("该退款由系统自动处理，无需财务审核");
  const mayQuery = approved && canQueryRefund({ ...row, source: "afterSale" });
  if (!mayQuery && normalizeReviewStatus(row.status) !== "待审") return ElMessage.warning("该申请不在待审核队列，请刷新后查看");
  if (approved && normalizeReviewStatus(row.status) === "已审" && !mayQuery) return ElMessage.warning("该记录已审核通过，不能重复通过");
  if (!approved && row.status === "已驳") return ElMessage.warning("该记录已驳回，不能重复驳");
  const actionText = approved ? "审核通过" : "审核驳回";
  window.LXMActionConfirm.confirm(ElMessageBox, mayQuery ? `查询 ${row.orderNo} 已发起的微信退款结果，不创建新的退款单。` : `确认 ${row.orderNo} 的「退款审核${actionText}」？金额：${money(row.amount || row.refundAmount || 0)}。${approved ? "审核通过后将发起微信原路退款，到账以微信退款结果为准。" : ""}`, mayQuery ? "查询微信退款结果" : `确认${approved ? "通过" : "驳回"}退款审核`, {
    confirmButtonClass: approved ? "lxm-action-confirm--success" : "lxm-action-confirm--danger",
    cancelButtonClass: "lxm-action-cancel",
    autofocus: approved,
    type: approved ? "warning" : "error",
    confirmButtonText: approved ? "确认通过" : "确认驳回",
    cancelButtonText: "再核对一下",
  }).then(() => applyRefundReview(row, approved)).catch(() => {});
}
async function applyRefundReview(row, approved = true) {
  if (!window.LXM_AUTH?.hasSession?.() || window.LXM_CLOUD_MODE !== "mysql" || window.LXM_API_STATE?.reachable === false || !window.LXM_CLOUD?.afterSaleAction) return ElMessage.error("真实后端连接不可用，操作未保存");
  const source = data.afterSales.find((item) => item.id === (row.afterSaleId || row.id));
  const order = data.orders.find((item) => item.id === row.orderId);
  if (!source || !order) return;
  if (isAutomaticCustomerRefund(source)) return ElMessage.warning("该退款由系统自动处理，无需财务审核");
  try {
    // Approval starts a real online refund. Only its acknowledged result can
    // confirm funds; the browser never optimistically marks a refund paid.
    const saved = await window.LXM_CLOUD.afterSaleAction(source.id || source._id, "review", {
      approved,
      reason: approved ? "退款审核通过，申请微信原路退款" : "退款审核驳回",
    });
    const serverTicket = saved && (saved.ticket || saved);
    if (!serverTicket || serverTicket.error || serverTicket.ok === false) throw new Error(serverTicket && serverTicket.error ? serverTicket.error : "退款审核保存失败");
    Object.assign(source, serverTicket);
    if (saved && saved.order) Object.assign(order, saved.order);
    row.status = source.financeStatus;
    if (state.currentFinanceReview?.id === row.id) state.currentFinanceReview.status = source.financeStatus;
    if (!approved) return ElMessage.success("退款审核已驳回");
    if (source.refundStatus === "refunded" && source.refundConfirmed === true) return ElMessage.success("微信原路退款成功");
    if (source.refundStatus === "refund_failed") return ElMessage.warning("微信退款异常，请核查渠道结果后重试查询");
    ElMessage.success("退款审核已通过，微信退款处理中；到账以渠道结果为准");
  } catch (error) {
    // A timeout can follow a remotely accepted request. Its stable refund
    // number must be queried rather than replaced with another application.
    return ElMessage.error((error && error.message) || "退款结果暂未确认，请刷新后查询，勿重复创建申请");
  }
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
  if (!canManageOrderRecords(state.currentOrder)) return ElMessage.warning("请先领取订单后添加跟进");
  const detail = (text || state.followText || "").trim();
  if (!detail) return ElMessage.warning("请先填写跟进内容");
  const order = state.currentOrder;
  const original = JSON.parse(JSON.stringify(order));
  const reachable = window.LXM_API_STATE && window.LXM_API_STATE.reachable;
  const connected = !!(window.LXM_AUTH?.hasSession?.() && window.LXM_CLOUD_MODE === "mysql" && reachable !== false);
  try {
    await persistOrderAction(order, "followup", {
      type: "service",
      content: detail,
      status: "open",
      reason: detail,
      followupId: `followup_${Date.now().toString(36)}`
    });
    if (!connected) addOrderTimeline(order, detail);
  } catch (_) {
    Object.keys(order).forEach((field) => { if (!(field in original)) delete order[field]; });
    Object.assign(order, original);
    return;
  }
  state.followText = "";
  ElMessage.success("客服跟进记录已添");
}
async function completeFollowup(followupId, note = "") {
  const order = state.currentOrder;
  if (!order || !followupId || !canManageOrderRecords(order)) return;
  const row = (order.followRecords || []).find((item) => item.type === "customer_followup" && String(item.id || "") === String(followupId));
  if (!row || row.status === "completed") return;
  try {
    await persistOrderAction(order, "followup", {
      followupId: String(followupId), type: row.followupType || "service", content: row.content || "", status: "completed", reason: note || "客服完成跟进"
    });
    row.status = "completed";
    row.completedAt = LXMFormat.nowText();
    ElMessage.success("跟进已完成");
  } catch (_) {}
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
    focusOrderSection,
    claimOrder,
    completeFollowup,
    openOrderById,
    openAfterSalesForOrder,
    openServiceAfterSale,
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
    canQueryRefund,
    applyRefundReview,
    addFollowLog
  };
});
