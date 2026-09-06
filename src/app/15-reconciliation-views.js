// 对账视图与弹窗
// 由 src/app.js 拆分而来（2026-08 巨无霸拆分）：块内声明顺序与原文件一致，代码逐字保留，
// 仅整体去一层缩进；引用更晚模块的名字已改写为 ctx.名字（调用期解析，语义等价）。
// 工厂函数接收 ctx（更早模块的导出 + state/data/Vue 工具），返回本块全部顶层声明。

(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const {
    commission,
    computed,
    due,
    financeDue,
    hasBlockingAfterSale,
    isEstimatedReconciliationOrder,
    isReconciliationEligible,
    isRetainedCancelledOrder,
    isSettlementObservationPending,
    netOrderAmount,
    orderAfterSales,
    orderSplit,
    reconciliation,
    reconciliationBlockReasons,
    roleProfile,
    scopedOrders,
    settlementObservationDays,
    state,
    visibleReconciliationSettlementRows
  } = ctx;

const reconciliationHoldRows = computed(() => scopedOrders.value.filter((order) => !isReconciliationEligible(order)).map((order) => {
  const afterSales = orderAfterSales(order);
  const observationHold = order.status === "completed" && isSettlementObservationPending(order);
  const reasons = reconciliationBlockReasons(order, { includeReleasedNote: true });
  return {
    ...order,
    isObservationHold: observationHold,
    holdReason: reasons.join("") || "暂缓原因待核",
    afterSaleText: afterSales.map((item) => `${item.type}/${item.status}`).join("") || "-",
  };
}));
function eligibleScopedOrders() {
  return scopedOrders.value.filter(isReconciliationEligible);
}
function reconciliationDetailAmount(row, type) {
  if (!row) return 0;
  if (type === "shop") return orderSplit(row).shopAmount;
  if (type === "distributor") return orderSplit(row).distributorAmount;
  if (type === "photo") return orderSplit(row).photographerAmount;
  if (type === "headquarter") return orderSplit(row).headquarterAmount;
  if (type === "due") return financeDue(row);
  if (type === "settlementDue") return Number(row.settlementDueAmount || row.pendingTransferAmount || row.pendingAmount || row.commission || 0);
  if (["eligible", "estimated", "observation", "retained"].includes(type)) return netOrderAmount(row);
  return Number(row.totalAmount || 0);
}
function openReconciliationDetail(type, label) {
  let rows = scopedOrders.value;
  let desc = "按当前角色和筛选范围展示订单明细";
  let amountLabel = "订单金额";
  if (type === "total") {
    rows = scopedOrders.value;
    desc = "当前范围内全部订单，包含未完成和售后暂缓订单。";
  } else if (type === "pending") {
    rows = scopedOrders.value.filter((order) => order.status !== "completed" && !isRetainedCancelledOrder(order));
    desc = "未完成订单暂不参与本月分账。";
  } else if (type === "observation") {
    rows = scopedOrders.value.filter(isSettlementObservationPending);
    desc = `已完成/已交付订单进入 ${settlementObservationDays()} 天订单静置期，期满且无售后退款后才参与分账。`;
  } else if (type === "blocked") {
    rows = scopedOrders.value.filter((order) => order.status === "completed" && hasBlockingAfterSale(order));
    desc = "存在退款相关或未结案售后，暂缓参与本月分账。";
  } else if (type === "eligible") {
    rows = eligibleScopedOrders();
    desc = "已完成、订单静置期满、财务审核通过且无退款/未结案售后的实际入池净额订单。";
    amountLabel = "入池净额";
  } else if (type === "retained") {
    rows = eligibleScopedOrders().filter(isRetainedCancelledOrder);
    desc = "订单已取消或中止，但财务已确认实收留存金额且退款/售后已结案，按留存净额参与分账。";
    amountLabel = "留存净额";
  } else if (type === "estimated") {
    rows = scopedOrders.value.filter(isEstimatedReconciliationOrder);
    desc = `预计可入分账池包含实际可分账订单，以及已交付/已完成且定金、尾款均经财务审核通过的订单；正式分账仍需满足 ${settlementObservationDays()} 天订单静置期、无售后退款和无风控阻塞。`;
    amountLabel = "预计入池净额";
  } else if (type === "shop") {
    rows = eligibleScopedOrders().filter((order) => commission(order, "shop") > 0);
    desc = "按商家分成比例计算的可分账订单。";
    amountLabel = "商家应计";
  } else if (type === "distributor") {
    rows = eligibleScopedOrders().filter((order) => commission(order, "distributor") > 0);
    desc = "按分销员分成比例计算的可分账订单。";
    amountLabel = "分销员应计";
  } else if (type === "agent") {
    rows = eligibleScopedOrders().filter((order) => commission(order, "agent") > 0);
    desc = "按城市代理分成比例计算的可分账订单。";
    amountLabel = "代理应计";
  } else if (type === "photo") {
    rows = eligibleScopedOrders().filter((order) => commission(order, "photo") > 0);
    desc = "按摄影师分成比例计算的可分账订单。";
    amountLabel = "摄影师应计";
  } else if (type === "headquarter") {
    rows = eligibleScopedOrders().filter((order) => orderSplit(order).headquarterAmount > 0);
    desc = "总部收入 = 实际入池净额 - 商家应计 - 分销员应计 - 摄影师应计；总部自有二维码订单不会产生商家/分销员分成。";
    amountLabel = "总部收入";
  } else if (type === "due") {
    rows = scopedOrders.value.filter((order) => financeDue(order) > 0);
    desc = "存在待收尾款的订单，供客服核对跟进。";
    amountLabel = "待收尾款";
  }
  state.reconciliationDetail = { title: label, desc, rows, amountLabel, type };
  state.reconciliationDialog = true;
}
function currentRoleRow(type) {
  const rows = reconciliation(type);
  const idMap = {
    shop: roleProfile.value.shopId,
    agent: roleProfile.value.agentId,
    distributor: roleProfile.value.distributorId,
    service: roleProfile.value.staffId,
    photo: roleProfile.value.staffId,
  };
  const id = idMap[type];
  return rows.filter((row) => row.id === id);
}
const reconciliationScopeInfo = computed(() => {
  const map = {
    super: ["总部后台 · 总部对账", "默认核对总部自营订单，可按商家、分销员筛选查看月度对账。"],
    agent: ["代理分店 · 自己代理城市", "代理相当于总部分店，重点核对本城市成交、下属分销员、合作商家和代理分店应计数据。"],
    distributor: ["分销员 · 自己拓展商家", "重点核对自己拓展商家的扫码成交、可分订单和分销应计数据。"],
    service: ["客服 · 订单跟进核对", "重点核对自己跟进订单的成交、待收尾款和暂缓订单，不显示渠道分账操作。"],
    finance: ["财务 · 总部对账", "默认核对总部自营订单，重点核对订单成交、已确认退款、订单静置期暂缓、售后暂缓、商家/分销员/摄影师应计和报表导出。"],
    photo: ["摄影师 · 我的拍摄任务核对", "仅核对分配给自己的拍摄任务、完成订单和待处理异常。"],
    merchant: ["商家 · 自己门店对账", "仅核对本门店扫码带来的订单、成交额、暂缓订单和商家应计数据。"],
    content: ["内容运营 · 内容数据核对", "内容角色以查看商品成交表现为主，不参与资金操作。"],
  };
  const info = map[state.role] || map.super;
  return { title: info[0], desc: info[1] };
});
const reconciliationFocus = computed(() => {
  if (state.role === "merchant") {
    return { title: "我的商家对账", desc: "本门店可分订单、暂缓订单和商家应计金额", rows: reconciliation("shop") };
  }
  if (state.role === "agent") {
    const rows = [
      ...currentRoleRow("agent"),
      ...reconciliation("distributor").filter((row) => row.totalOrders > 0),
      ...reconciliation("shop").filter((row) => row.totalOrders > 0),
    ];
    return { title: "我的代理分店对账", desc: "本城市代理分店、分销员、商家的月度核对汇总", rows };
  }
  if (state.role === "distributor") {
    const rows = [
      ...currentRoleRow("distributor"),
    ];
    return { title: "我的分销对账", desc: "只显示当前分销员来源订单与分销应计金额", rows };
  }
  if (state.role === "service") {
    return { title: "我的客服经手业绩", desc: "客服只统计经手订单业绩，不参与分成；重点看经手订单、完成成交、待收和售后暂缓", rows: currentRoleRow("service") };
  }
  if (state.role === "photo") {
    return { title: "我的摄影任务核对", desc: "分配给自己的拍摄任务、完成订单和异常暂缓", rows: currentRoleRow("photo") };
  }
  if (state.role === "finance") {
    return { title: "财务全平台对", desc: "财务视角核对分成对象应计、客服经手业绩、退款暂缓和已确认退款净额", rows: visibleReconciliationSettlementRows.value };
  }
  return { title: "总部对账", desc: "总部视角默认查看自营商家、分销员、摄影师应计明细；可按商家或分销员手动筛选", rows: visibleReconciliationSettlementRows.value };
});
function showReconciliationSection(section) {
  if (["super", "finance"].includes(state.role)) return true;
  if (section === "settlement") return ["distributor", "merchant", "photo"].includes(state.role);
  if (section === "hold") return true;
  if (section === "shop") return ["merchant"].includes(state.role);
  if (section === "channel") return ["distributor"].includes(state.role);
  if (section === "service") return ["super", "finance", "service"].includes(state.role);
  if (section === "photo") return ["super", "finance", "photo"].includes(state.role);
  if (section === "people") return ["service", "photo"].includes(state.role);
  return false;
}

  return {
    reconciliationHoldRows,
    eligibleScopedOrders,
    reconciliationDetailAmount,
    openReconciliationDetail,
    currentRoleRow,
    reconciliationScopeInfo,
    reconciliationFocus,
    showReconciliationSection
  };
});
