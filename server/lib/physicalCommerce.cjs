"use strict";
const crypto = require("crypto");
const { createMysqlStore, createMemoryStore } = require("./physicalStore.cjs");
const PUBLIC_ACTIONS = ["getPhysicalCatalog", "getPhysicalCart", "updatePhysicalCart", "getShippingAddresses", "saveShippingAddress", "deleteShippingAddress", "setDefaultShippingAddress", "previewPhysicalCheckout", "createPhysicalOrder", "getPhysicalOrders", "getPhysicalOrder", "getPhysicalOrderCounts", "createPhysicalPayment", "getPhysicalPaymentStatus", "cancelPhysicalOrder", "confirmPhysicalReceipt", "requestPhysicalAddressChange", "createPhysicalAfterSale", "getPhysicalAfterSales", "getPhysicalLogistics", "updatePhysicalReturnShipment"];
const STATUS = { pending_payment: "待付款", awaiting_shipment: "待发货", awaiting_receipt: "待收货", completed: "已完成", closed: "已关闭" };
const DEFAULT_CONFIG = { enabled: false, enabledProductIds: [], shippingFeeMode: "maximum", paymentMinutes: 30, afterSaleDays: 7, returnDays: 7, maxPendingOrders: 5, maxLines: 50, maxQuantity: 99, queryIntervalMinutes: 30, carrierOptions: [{ code: "shunfeng", name: "顺丰速运" }, { code: "zhongtong", name: "中通快递" }, { code: "yuantong", name: "圆通速递" }, { code: "yunda", name: "韵达快递" }, { code: "shentong", name: "申通快递" }, { code: "jtexpress", name: "极兔速递" }, { code: "ems", name: "EMS" }, { code: "youzhengguonei", name: "邮政快递包裹" }], allowedProvinces: [] };
const clone = value => JSON.parse(JSON.stringify(value));
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const str = value => String(value == null ? "" : value).trim();
function fail(message, code = "PHYSICAL_INVALID", statusCode = 400) { throw Object.assign(new Error(message), { code, statusCode }); }
function required(value, name, limit = 128) { const result = str(value); if (!result || result.length > limit) fail(`${name}不能为空或过长`); return result; }
function integer(value, name = "数量", max = 2147483647, min = 0) { const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${name}不合法`); return result; }
function fen(value, name = "金额") { if (value === null || value === undefined || value === "") fail(`${name}未设置`); const result = Number(value); if (!Number.isFinite(result) || result < 0 || Math.abs(result * 100 - Math.round(result * 100)) > 1e-6 || result > 10000000) fail(`${name}不合法`); return Math.round(result * 100); }
const yuan = value => Number((Number(value || 0) / 100).toFixed(2));
const productId = row => str(row && (row.id || row._id));
function skuIdentity(product, sku, single = false) { return `sku_${hash([productId(product), single ? "default" : str(sku.id || sku.skuId || sku.skuCode || sku.spec)]).slice(0, 32)}`; }
function skuPresentation(sku) { const style = str(sku.style), spec = str(sku.spec || "默认规格"); return { style, specLabel: style ? `${spec}【${style}】` : spec }; }
function skuSnapshot(sku) { return str(sku.style) ? skuPresentation(sku) : {}; }
function configOf(state) { return { ...clone(DEFAULT_CONFIG), ...(state.config.find(row => row.id === "settings") || {}) }; }
function activeAfterSale(state, orderId) { return state.afterSales.find(row => row.orderId === orderId && !["rejected", "withdrawn", "completed"].includes(row.status)); }
function bump(row, at) { row.version = Number(row.version || 0) + 1; row.updatedAt = at; }
function audit(state, order, action, actor, at, detail = {}) { state.audit.push({ id: id("audit"), orderId: order && order.id || "", action, actor: str(actor), at, detail }); }
function actor(session) { return required(session && (session.authzUserId || session.accountId || session.subjectId || session.id || session.account), "操作人"); }
function publicIdentity(session) { return required(session && session.openid, "登录身份"); }
function roleOf(session) { return str(session && session.role).toLowerCase(); }
function adminAllowed(session, action) {
  const role = roleOf(session);
  const superRole = ["super", "admin", "administrator"].includes(role);
  const read = ["list", "detail", "export", "afterSales", "config", "readConfig", "catalog", "adminCatalog"].includes(action);
  const finance = ["finance"].includes(role);
  if (superRole) return;
  if (finance && (read || ["reviewAfterSale", "retryRefund"].includes(action))) return;
  if (["service", "supervisor", "service_supervisor"].includes(role) && (read || ["ship", "refreshLogistics", "retryLogisticsSubscription", "followAfterSale", "inspectReturn", "resolveAddressChange"].includes(action))) return;
  if (["content", "operator", "operation"].includes(role) && ["catalog", "adminCatalog", "adjustStock"].includes(action)) return;
  fail("无实物操作权限", "PHYSICAL_FORBIDDEN", 403);
}
function ownOrder(state, value, openid) { const order = state.orders.find(row => row.id === str(value) || row.orderNo === str(value)); if (!order || openid && order.openid !== openid) fail("订单不存在", "PHYSICAL_NOT_FOUND", 404); return order; }
function canScope(order, session) {
  const configured = session && (session.physicalScopeIds || session.allowedPhysicalScopeIds);
  if (Array.isArray(configured) && !configured.map(String).includes(order.scopeId || "platform")) fail("无权访问该范围订单", "PHYSICAL_FORBIDDEN", 403);
}
function paymentFor(state, order) { return state.payments.find(row => row.orderId === order.id && row.status === "confirmed") || state.payments.filter(row => row.orderId === order.id).slice(-1)[0] || (order.paymentMode === "package" ? order.parentPayment : null); }
function shipmentFor(state, order) { return state.shipments.find(row => row.orderId === order.id && row.kind === "outbound" && row.active); }
function remainingItems(order) { return order.items.map(row => ({ ...row, remainingQuantity: row.quantity - (row.refundedQuantity || 0) })).filter(row => row.remainingQuantity > 0); }
function frozen(state, order) { return !!order.parentCancellationPending || !!activeAfterSale(state, order.id) || !!order.addressChange && order.addressChange.status === "pending"; }
function publicOrder(state, order) {
  const result = clone(order), shipment = shipmentFor(state, order), hold = frozen(state, order);
  const payment = paymentFor(state, order);
  result.orderType = "physical"; result.publicStatus = order.status; result.publicStatusText = STATUS[order.status];
  result.goodsAmount = yuan(order.goodsAmountFen); result.shippingFee = yuan(order.shippingFeeFen); result.totalAmount = yuan(order.totalAmountFen); result.refundedAmount = yuan(order.refundedFen);
  result.afterSaleDays = configOf(state).afterSaleDays; result.returnDays = configOf(state).returnDays; result.deliveryMessage = "全部商品统一发货，以最晚交付周期为准";
  result.items = result.items.map(row => ({ ...row, price: yuan(row.priceFen), lineAmount: yuan(row.amountFen) }));
  result.shipment = shipment ? publicShipment(shipment) : null;
  result.paymentTransactionId = payment?.status === "confirmed" ? payment.externalTransactionId : null;
  result.receiptSyncRequired = !!configOf(state).wechatReceiptRequired && (order.paymentMode !== "package" || !!payment?.externalTransactionId);
  result.allowedActions = ["contactService"];
  if (order.status === "pending_payment") result.allowedActions.push("pay", "cancel", "changeAddress");
  if (["awaiting_shipment", "awaiting_receipt", "completed"].includes(order.status) && !hold) result.allowedActions.push("afterSale");
  if (order.status === "awaiting_shipment" && !hold) result.allowedActions.push("requestAddressChange", "changeAddress");
  if (order.status === "awaiting_receipt" && !hold && shipment) result.allowedActions.push("confirmReceipt", "viewLogistics");
  if (["completed", "closed"].includes(order.status)) result.allowedActions.push("buyAgain");
  if (order.paymentMode === "package") {
    if (order.status === "pending_payment") result.publicStatusText = "待套餐付清";
    result.allowedActions = result.allowedActions.filter(action => !["pay", "cancel", "afterSale"].includes(action));
    if (order.status === "pending_payment" && !hold) result.allowedActions.push("changeAddress");
    result.deliveryMessage = order.status === "pending_payment" ? "套餐款项付清后安排发货，商品金额已包含在套餐内" : "套餐内商品，使用实物订单统一发货";
    result.paymentIncludedInPackage = true;
  }
  result.afterSaleStatus = activeAfterSale(state, order.id)?.status || "none";
  delete result.checkoutKey; delete result.checkoutRequestHash; delete result.shippingTask; delete result.pendingReceipt; delete result.parentPayment;
  return result;
}
function publicShipment(row) { const copy = clone(row); delete copy.subscriptionSalt; delete copy.phone; delete copy.callbackId; delete copy.raw; delete copy.snapshot; copy.events = (copy.events || []).map(event => ({ ...event, context: str(event.context).replace(/1[3-9]\d{9}/g, phone => `${phone.slice(0, 3)}****${phone.slice(-4)}`) })); return copy; }
function publicAfterSale(state, row) {
  const result = {};
  for (const key of ["id", "orderId", "status", "items", "amountFen", "reason", "attachmentFileIds", "createdAt", "updatedAt", "version", "returnAddress", "returnDeadline", "returnShipmentId", "returnTrackingNo", "returnCarrierCode", "refundedAt", "reviewReason", "shippingRefundFen"]) if (row[key] !== undefined) result[key] = clone(row[key]);
  result.amount = yuan(row.amountFen); result.returnShipment = row.returnShipmentId ? publicShipment(state.shipments.find(shipment => shipment.id === row.returnShipmentId)) : null;
  return result;
}
function adminOrder(state, order, session) {
  const result = publicOrder(state, order), shipment = shipmentFor(state, order);
  result.allowedActions = ["detail"];
  for (const action of ["ship", "withdrawShipment", "refreshLogistics", "retryLogisticsSubscription", "resolveAddressChange"]) {
    try {
      adminAllowed(session, action);
      if (action === "ship" && order.status === "awaiting_shipment" && !frozen(state, order)) result.allowedActions.push(action);
      if (action === "withdrawShipment" && shipment && order.status === "awaiting_receipt" && !["collected", "in_transit", "delivering", "out_for_delivery", "signed"].includes(shipment.logisticsStatus)) result.allowedActions.push(action);
      if (action === "refreshLogistics" && shipment) result.allowedActions.push(action);
      if (action === "retryLogisticsSubscription" && shipment && state.tasks.some(row => row.type === "subscribe" && row.shipmentId === shipment.id && row.version === shipment.version && row.status === "retry")) result.allowedActions.push(action);
      if (action === "resolveAddressChange" && order.addressChange?.status === "pending") result.allowedActions.push(action);
    } catch (_) {}
  }
  if (roleOf(session) === "finance") {
    if (result.address) { result.address.phone = str(result.address.phone).replace(/^(\d{3})\d+(\d{4})$/, "$1****$2"); result.address.detail = "***"; }
    if (result.addressChange?.address) { result.addressChange.address.phone = "***"; result.addressChange.address.detail = "***"; }
  }
  return result;
}
function paginate(rows, input = {}) { const page = integer(input.page || 1, "页码", 1000000, 1), pageSize = integer(input.pageSize || 20, "每页数量", 100, 1); return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize }; }
function publicReadSelection(action, input, openid) {
  if (action === "getShippingAddresses") return { addresses: { owner: openid } };
  if (action === "getPhysicalOrderCounts") return { orders: { owner: openid }, afterSales: { orderIdsFrom: "orders" } };
  if (action === "getPhysicalAfterSales") return {
    config: { id: "settings" },
    afterSales: { owner: openid, ...(input.orderId ? { orderId: input.orderId } : {}) },
    shipments: { idsFrom: { table: "afterSales", field: "returnShipmentId" } },
  };
  if (action === "getPhysicalOrders" || action === "getPhysicalOrder") return {
    config: { id: "settings" },
    // Detail retains ownOrder's exact identity/ownership check and 404 result.
    orders: action === "getPhysicalOrders" ? { owner: openid } : { identity: str(input.orderId || input.id || input.orderNo) },
    afterSales: { orderIdsFrom: "orders" },
    payments: { orderIdsFrom: "orders" },
    shipments: { orderIdsFrom: "orders" },
  };
  return null;
}
function createService({ store, catalogSource, wechatPay, logistics, shipping, merchantCommission, now = () => new Date() }) {
  const time = () => new Date(now()).toISOString();
  const tx = callback => store.transaction(callback);
  const commission = merchantCommission || (catalogSource && typeof catalogSource.transaction === "function" ? {
    payment: order => require("./merchantShare.cjs").enqueuePhysicalOrder(catalogSource, order),
    refund: (order, refund) => require("./merchantShare.cjs").recordOrderRefund(catalogSource, { order, refundNo: refund.refundNo, amount: (refund.goodsAmountFen / 100).toFixed(2), refundedAt: refund.refundAt }),
  } : null);
  async function checkoutMerchantSource(input, at, openid) {
    let scene = str(input.scene); try { scene = decodeURIComponent(scene); } catch (_) {}
    // A supplied shop id alone is not evidence of a scan. Resolve issued codes
    // on the server and persist only their canonical merchant identity.
    if (!scene && !str(input.codeId || input.sourceCodeId)) return { sourceType: "direct", channel: "direct", shopId: "", scene: "" };
    if (!catalogSource || typeof catalogSource.list !== "function") fail("商家来源暂不可用，请稍后重试", "PHYSICAL_SOURCE_UNAVAILABLE", 503);
    if (/^S[A-Za-z0-9]+$/.test(scene)) {
      const share = require("./merchantShare.cjs"); share.validateScene(scene);
      const shareStore = share.serviceFor(catalogSource).store, qr = await shareStore.getQrByScene(scene);
      const engine = require("./shareEngine.cjs"), merchant = qr && await shareStore.getMerchant(qr.merchantId);
      if (!qr || !engine.activeMerchant(merchant)) fail("二维码无效或商家已停用", "PHYSICAL_SOURCE_INVALID", 409);
      let proof = {};
      if (qr.status !== "ACTIVE") {
        const current = qr.status === "DISABLED" && qr.disabledAt && await require("./merchantOrderEvidence.cjs").currentMerchantBinding(shareStore, openid, qr.merchantId, at);
        if (!current) fail("二维码无效或已失效", "PHYSICAL_SOURCE_INVALID", 409);
        // Restoring a stored scene after QR rotation does not constitute a new
        // scan. Carry the original server binding proof into the checkout.
        proof = { bindingScanId: str(current.lastScanId), bindingAt: current.lastScanAt };
      }
      return { shopId: str(qr.merchantId), shopName: str(merchant.name), scene, codeId: str(qr.id), sourceCodeId: str(qr.id), sourceType: "merchant_qrcode", channel: "merchant_qrcode", validatedAt: at, ...proof };
    }
    const codeId = str(input.codeId || input.sourceCodeId || (/^c=([^&]+)$/.exec(scene) || [])[1]);
    const codes = await catalogSource.list("merchantCodes");
    const code = (codes || []).find(row => require("./merchantCodes.cjs").active(row) && ((codeId && (str(row.id || row._id) === codeId || str(row.codeId) === codeId)) || (scene && str(row.scene) === scene)));
    if (!code) fail("二维码无效或已失效", "PHYSICAL_SOURCE_INVALID", 409);
    const shops = await catalogSource.list("shops"), shop = (shops || []).find(row => require("./shareEngine.cjs").activeMerchant(row) && [row.id, row._id, row.shopId].map(str).includes(str(code.shopId)));
    if (!shop) fail("二维码对应商家不存在或已停用", "PHYSICAL_SOURCE_INVALID", 409);
    return { shopId: str(code.shopId), shopName: str(shop.name), scene: str(code.scene), codeId: str(code.id || code._id), sourceCodeId: str(code.id || code._id), sourceType: "merchant_qrcode", channel: "merchant_qrcode", validatedAt: at };
  }
  function shareOrder(state, order) {
    const payment = state.payments.find(row => row.orderId === order.id && row.status === "confirmed");
    const cities = [...new Set(order.items.map(item => str(item.cityId)))];
    return { ...clone(order), shopId: str(order.source?.shopId), sourceType: order.source?.sourceType || "direct", sourceCodeId: str(order.source?.sourceCodeId), createTime: order.createdAt,
      // A mixed-city or partially unknown basket has no single business city. Never infer this
      // dimension from a delivery address or from the referring merchant.
      cityId: str(order.cityId) || (cities.length === 1 ? cities[0] : ""),
      depositPaid: 0, finalPaid: payment ? yuan(order.goodsAmountFen) : 0, finalPaidAt: payment?.confirmedAt || null, paidAmount: payment ? yuan(order.totalAmountFen) : 0,
      paymentRecords: payment ? [{ ...clone(payment), phase: "final", amount: yuan(order.goodsAmountFen), paidAt: payment.confirmedAt }] : [] };
  }
  function shareRefund(state, refund) {
    const order = ownOrder(state, refund.orderId), sale = state.afterSales.find(row => row.id === refund.afterSaleId);
    const goodsAmountFen = sale ? sale.amountFen : refund.latePayment ? order.goodsAmountFen : Math.max(0, refund.amountFen - (refund.shippingRefundFen || 0));
    return { refundNo: refund.refundNo, goodsAmountFen, amount: (goodsAmountFen / 100).toFixed(2), refundAt: refund.successAt || refund.updatedAt };
  }
  async function getShareOrder(orderId) { return tx(state => { const order = state.orders.find(row => row.id === str(orderId)); return order && order.paymentMode !== "package" ? shareOrder(state, order) : null; }); }
  async function listShareOrders() { return tx(state => state.orders.filter(order => order.paymentMode !== "package").map(order => shareOrder(state, order))); }
  async function getShareRefunds(orderId) { return tx(state => state.refunds.filter(row => row.orderId === str(orderId) && row.status === "SUCCESS" && !row.duplicatePayment).map(row => shareRefund(state, row)).filter(row => row.goodsAmountFen > 0)); }
  async function markShareAttribution(orderId, projection) {
    return tx(state => { const order = state.orders.find(row => row.id === str(orderId)); if (!order) fail("分成关联实物订单不存在", "SHARE_PROJECTION_ORDER_MISSING", 409);
      if (Number(order.shareAttributionRevision || 0) <= Number(projection.shareAttributionRevision || 0)) Object.assign(order, projection);
      return true; });
  }
  async function deliverCommissionTask(task) {
    if (!commission) return { skipped: true, reason: "SHARE_NOT_ENABLED" };
    const data = await tx(state => { const order = ownOrder(state, task.orderId), refund = task.refundId && state.refunds.find(row => row.id === task.refundId); return { order: shareOrder(state, order), refund: refund && shareRefund(state, refund) }; });
    if (task.type === "merchant_share_refund" && (!data.refund || data.refund.goodsAmountFen <= 0)) return { skipped: true, reason: "NO_REFUNDED_GOODS" };
    return task.type === "merchant_share_payment" ? commission.payment(data.order) : commission.refund(data.order, data.refund);
  }
  async function rawCatalog() {
    const rows = typeof catalogSource === "function" ? await catalogSource() : await catalogSource.list("peripherals");
    if (typeof catalogSource === "function") return Array.isArray(rows) ? rows : [];
    const policy = require("./contentPolicy.cjs"), context = await policy.createVisibilityContext(catalogSource, ["peripherals"]);
    return (Array.isArray(rows) ? rows : []).map(row => ({ ...row, _commerceVisible: policy.effectiveContentVisibility("peripherals", row, context).effectiveVisible }));
  }
  function materialize(state, products) {
    const config = configOf(state);
    return products.map(product => {
      const pid = productId(product), rawSkus = product.specMode === "multiple" ? product.skus || [] : [{ spec: (product.specs || []).join(" / ") || "默认规格", style: product.skuStyle, price: product.price, stock: product.stock ?? product.stockQty }];
      const policy = (config.productPolicies || {})[pid] || {};
      const visible = product._commerceVisible !== false && product.isShow !== false && product.enabled !== false && !product.internalOnly && !product.deleted && !["草稿", "下架", "已下", "hidden", "draft", "deleted"].includes(str(product.status));
      const custom = product.isCustom === true || product.requiresPhotos === true || policy.fulfillmentMode === "custom";
      const enabled = config.enabled && visible && !custom && (policy.saleEnabled === true || config.enabledProductIds.includes(pid));
      const blockedReason = !config.enabled ? "商城暂未开放购买，请稍后再来。"
        : !visible ? "该商品已下架，请选择其他商品。"
        : custom ? "该商品需要照片定制，请联系客服确认制作要求。"
        : !enabled ? "该商品尚未开放购买，请联系客服了解。" : "";
      const skus = rawSkus.map(raw => {
        const sid = skuIdentity(product, raw, product.specMode !== "multiple");
        let inventory = state.inventory.find(row => row.skuId === sid);
        const validStock = raw.stock !== null && raw.stock !== undefined && raw.stock !== "" && Number.isSafeInteger(Number(raw.stock)) && Number(raw.stock) >= 0;
        if (!inventory && validStock) { inventory = { id: sid, skuId: sid, productId: pid, onHand: Number(raw.stock), reserved: 0, sold: 0, version: 1, initializedAt: time() }; state.inventory.push(inventory); }
        let priceFen = null; try { priceFen = fen(raw.price); } catch (_) {}
        let shippingFeeFen = null; try { shippingFeeFen = fen(product.shippingFee, "运费"); } catch (_) {}
        const available = inventory ? inventory.onHand - inventory.reserved : 0;
        const disabledReason = blockedReason || (priceFen === null || priceFen <= 0 ? "该商品的价格待商家确认，请联系客服。"
          : shippingFeeFen === null ? "该商品的配送信息待商家完善，请联系客服。"
          : !inventory ? "该商品的库存待商家确认，请联系客服。"
          : available <= 0 ? "该商品已售罄，请选择其他商品或联系客服了解补货时间。" : "");
        return { id: sid, skuId: sid, spec: str(raw.spec || "默认规格"), ...skuPresentation(raw), priceFen, price: priceFen === null ? null : yuan(priceFen), available, availableQuantity: available, inventoryVersion: inventory?.version || 0, shippingFeeFen, purchasable: enabled && priceFen > 0 && shippingFeeFen !== null && !!inventory && available > 0, disabledReason };
      });
      const purchasable = skus.some(row => row.purchasable);
      const reasons = [...new Set(skus.map(row => row.disabledReason))];
      const disabledReason = purchasable ? "" : blockedReason || (!skus.length ? "该商品的规格信息待商家完善，请联系客服。" : reasons.length === 1 ? reasons[0] : "该商品当前没有可购买的规格，请联系客服了解。");
      return { id: pid, productId: pid, name: str(product.name), cover: str(product.cover || product.image || ""), description: str(product.intro || product.description), deliveryCycle: str(product.deliveryCycle), cityId: str(product.cityId), skus, price: skus.length ? Math.min(...skus.filter(row => row.price !== null).map(row => row.price)) : null, saleEnabled: policy.saleEnabled ?? config.enabledProductIds.includes(pid), fulfillmentMode: custom ? "custom" : "stock", visible, purchasable, disabledReason };
    });
  }
  function cartView(state, openid, catalog) {
    const items = state.carts.filter(row => row.openid === openid).map(row => {
      const product = catalog.find(product => product.id === row.productId), sku = product?.skus.find(sku => sku.id === row.skuId);
      const valid = !!sku?.purchasable && row.quantity <= sku.available;
      return { ...row, lineId: row.id, name: product?.name || row.name, cover: product?.cover || row.cover, spec: sku?.spec || row.spec, ...skuPresentation(sku || row), price: sku?.price ?? null, available: sku?.available || 0, valid, invalidReason: valid ? "" : product?.disabledReason || "商品已失效", lineAmount: sku?.price == null ? null : yuan(sku.priceFen * row.quantity) };
    });
    return { items, totalQuantity: items.reduce((n, row) => n + row.quantity, 0), selectedQuantity: items.filter(row => row.selected && row.valid).reduce((n, row) => n + row.quantity, 0), goodsAmount: items.filter(row => row.selected && row.valid).reduce((n, row) => n + (row.lineAmount || 0), 0) };
  }
  function addressInput(input, openid, at, old) {
    const recipient = required(input.recipient || input.name, "收货人", 40), phone = required(input.phone, "收货手机号", 20);
    if (!/^1[3-9]\d{9}$/.test(phone)) fail("请输入有效大陆手机号");
    const address = { id: old?.id || id("addr"), openid, recipient, name: recipient, phone, province: required(input.province, "省份", 40), city: required(input.city, "城市", 40), district: required(input.district, "区县", 40), detail: required(input.detail || input.detailAddress, "详细地址", 200), regionCode: str(input.regionCode || input.areaCode), label: str(input.label).slice(0, 20), isDefault: input.isDefault === true, version: (old?.version || 0) + 1, updatedAt: at };
    if (address.detail.length < 5) fail("详细地址请填写街道和门牌号");
    if (/香港|澳门|台湾|海外/.test(address.province)) fail("当前仅支持中国大陆快递地址");
    return address;
  }
  function quote(state, input, openid, catalog) {
    const config = configOf(state); if (!config.enabled) fail("商品购买暂未开放", "PHYSICAL_DISABLED", 409);
    const address = state.addresses.find(row => row.id === str(input.addressId) && row.openid === openid); if (!address) fail("请选择本人有效收货地址");
    if (config.allowedProvinces.length && !config.allowedProvinces.includes(address.province)) fail("所选地址暂不支持配送");
    const source = input.checkoutSource === "cart" ? "cart" : "direct";
    let lines = Array.isArray(input.items) ? input.items : [];
    if (source === "cart" && !lines.length) lines = state.carts.filter(row => row.openid === openid && row.selected).map(row => ({ ...row, lineId: row.id }));
    if (!lines.length || lines.length > config.maxLines || source === "direct" && lines.length !== 1) fail("请选择有效商品，直接购买一次仅选择一个规格");
    const seen = new Set();
    const items = lines.map(line => {
      const cart = source === "cart" ? state.carts.find(row => row.id === str(line.lineId || line.id) && row.openid === openid) : null;
      if (source === "cart" && (!cart || Number(line.version) !== cart.version || cart.quantity !== Number(line.quantity) || !cart.selected)) fail("购物车已变化，请刷新后确认", "PHYSICAL_CONFLICT", 409);
      const pid = str(cart?.productId || line.productId), sid = str(cart?.skuId || line.skuId), quantity = integer(line.quantity, "购买数量", config.maxQuantity, 1);
      if (seen.has(sid)) fail("同一规格请合并数量后提交"); seen.add(sid);
      const product = catalog.find(row => row.id === pid), sku = product?.skus.find(row => row.id === sid);
      if (!sku?.purchasable || quantity > sku.available) fail(`${product?.name || "商品"}规格不可售或库存不足`, "PHYSICAL_STOCK", 409);
      return { id: id("item"), productId: pid, skuId: sid, name: product.name, description: product.description, spec: sku.spec, ...skuSnapshot(sku), cover: product.cover, cityId: str(product.cityId || product.cityCode), quantity, priceFen: sku.priceFen, amountFen: sku.priceFen * quantity, shippingFeeFen: sku.shippingFeeFen, deliveryCycle: product.deliveryCycle, refundedQuantity: 0, ...(cart ? { cartLineId: cart.id, cartVersion: cart.version } : {}) };
    });
    const goodsAmountFen = items.reduce((sum, row) => sum + row.amountFen, 0), shippingFeeFen = Math.max(...items.map(row => row.shippingFeeFen));
    if (!Number.isSafeInteger(goodsAmountFen + shippingFeeFen) || goodsAmountFen + shippingFeeFen > 1000000000) fail("订单金额超限");
    const quoteVersion = hash([openid, source, address.id, address.version, items.map(row => [row.productId, row.skuId, row.spec, row.style || "", row.quantity, row.priceFen, row.shippingFeeFen, row.cartVersion]), config.version || 0]);
    return { checkoutSource: source, items, address: clone(address), goodsAmountFen, shippingFeeFen, totalAmountFen: goodsAmountFen + shippingFeeFen, quoteVersion, afterSaleDays: config.afterSaleDays, returnDays: config.returnDays, deliveryMessage: "全部商品统一发货，以最晚交付周期为准" };
  }
  function publicQuote(result) { return { ...result, items: result.items.map(row => ({ ...row, price: yuan(row.priceFen), lineAmount: yuan(row.amountFen) })), goodsAmount: yuan(result.goodsAmountFen), shippingFee: yuan(result.shippingFeeFen), totalAmount: yuan(result.totalAmountFen) }; }
  // Package fulfillment shares authoritative SKU inventory with standalone
  // sales, while its receipt and revenue remain on the service order.
  function packageKey(parent) { return required(parent && (parent.bookingId || parent.id || parent._id), "套餐父订单"); }
  function packageId(parent) { return `physical_pkg_${hash(packageKey(parent)).slice(0, 40)}`; }
  function parentIsTerminal(parent = {}) {
    return [parent.status, parent.bookingStatus, parent.businessStatus, parent.workflowStage, parent.service_status].some(value => ["closed", "cancelled", "canceled", "refunded", "已取消", "已退款"].includes(str(value).toLowerCase()));
  }
  function parentIsPaid(parent) {
    const workflow = require("./orderWorkflow.cjs"), totalFen = fen(parent.totalAmount ?? parent.totalPrice ?? parent.price ?? 0, "套餐金额");
    if (parent.paymentReviewRequired || parentIsTerminal(parent)) return false;
    if (!totalFen) return !!parent.completedAt && ["completed", "done", "已完成"].some(status => [parent.status, parent.businessStatus, parent.service_status].includes(status));
    const records = Array.isArray(parent.paymentRecords) ? parent.paymentRecords : [];
    const paidFen = ["deposit", "final"].reduce((sum, phase) => {
      if (!workflow.hasConfirmedPayment(parent, phase)) return sum;
      const recordAmount = records.filter(row => row.phase === phase && workflow.normalizePaymentStatus(row.status) === "confirmed")
        .reduce((maximum, row) => Math.max(maximum, Number(row.amount) || 0), 0);
      const financeStatus = parent[phase === "deposit" ? "depositFinanceStatus" : "finalFinanceStatus"], verify = str(parent.paymentVerify);
      const fieldVerified = workflow.normalizePaymentStatus(financeStatus) === "confirmed"
        || !!verify && !/(未|待|驳|拒|失败)/.test(verify) && /(核销|核对|到账|入账|已审)/.test(verify) && (!verify.includes("定金") && !verify.includes("尾款") || verify.includes(phase === "deposit" ? "定金" : "尾款"));
      return sum + fen(Math.max(recordAmount, fieldVerified ? Number(parent[phase === "deposit" ? "depositPaid" : "finalPaid"]) || 0 : 0));
    }, 0);
    const discountFen = fen(parent.finalDiscountAmount || 0, "套餐优惠金额");
    return paidFen >= Math.max(0, totalFen - discountFen);
  }
  function parentPayment(parent) {
    const workflow = require("./orderWorkflow.cjs");
    const records = (Array.isArray(parent.paymentRecords) ? parent.paymentRecords : []).filter(row => workflow.normalizePaymentStatus(row.status) === "confirmed" && row.provider === "wechat_pay" && row.externalTransactionId && row.outTradeNo);
    const payment = [...records].reverse().find(row => row.phase === "final") || records[records.length - 1];
    if (!payment) return null;
    return { id: str(payment.id || payment._id), provider: "wechat_pay", status: "confirmed", phase: payment.phase, amount: Number(payment.amount), amountFen: fen(payment.amount), outTradeNo: str(payment.outTradeNo), externalTransactionId: str(payment.externalTransactionId), confirmedAt: payment.confirmedAt || payment.paidAt || parent.finalPaidAt || parent.depositPaidAt || time() };
  }
  async function preparePackageFulfillment(lines = [], addressId, openid) {
    if (!Array.isArray(lines) || !lines.length) return null;
    const identity = required(openid, "登录身份"), products = await rawCatalog();
    return tx(state => {
      const address = state.addresses.find(row => row.id === str(addressId) && row.openid === identity);
      if (!address) fail("套餐含实物商品，请选择本人有效收货地址", "PHYSICAL_PACKAGE_ADDRESS_REQUIRED");
      const checkedAddress = addressInput(address, identity, time(), address), config = configOf(state);
      if (config.allowedProvinces.length && !config.allowedProvinces.includes(checkedAddress.province)) fail("所选地址暂不支持配送");
      if (lines.length > 500) fail("套餐实物商品种类过多");
      const catalog = materialize(state, products), merged = new Map();
      for (const line of lines) {
        const pid = required(line.productId, "套餐商品"), product = catalog.find(row => row.id === pid), raw = products.find(row => productId(row) === pid);
        if (!product?.visible || !raw) fail("套餐内周边商品不存在或已下架", "PHYSICAL_PACKAGE_PRODUCT_INVALID", 409);
        const quantity = integer(line.quantity ?? line.qty ?? 1, "套餐商品数量", 9801, 1);
        const selector = str(line.skuId || line.specId || line.skuCode), spec = str(line.spec);
        const rawSkus = raw.specMode === "multiple" ? raw.skus || [] : [{ spec: (raw.specs || []).join(" / ") || "默认规格" }];
        const matches = product.skus.filter((sku, index) => selector ? [sku.id, str(rawSkus[index]?.id), str(rawSkus[index]?.skuId), str(rawSkus[index]?.skuCode)].includes(selector) : spec ? (sku.spec === spec || sku.specLabel === spec) && (line.style === undefined || sku.style === str(line.style)) : product.skus.length === 1);
        if (matches.length !== 1) fail("套餐内周边商品需配置明确的规格", "PHYSICAL_PACKAGE_SKU_REQUIRED", 409);
        const sku = matches[0], stock = state.inventory.find(row => row.skuId === sku.id);
        if (!stock) fail("套餐内周边商品库存未配置", "PHYSICAL_PACKAGE_STOCK_REQUIRED", 409);
        const existing = merged.get(sku.id), wanted = quantity + (existing?.quantity || 0);
        if (!Number.isSafeInteger(wanted) || wanted > 2147483647 || wanted > stock.onHand - stock.reserved) fail(`${product.name}库存不足`, "PHYSICAL_STOCK", 409);
        // Catalog prices are reference values only. Package checkout never
        // creates a second goods charge or a separate shipping charge.
        const priceFen = sku.priceFen ?? (raw.price == null || raw.price === "" ? 0 : fen(raw.price));
        if (!Number.isSafeInteger(priceFen * wanted)) fail("套餐商品金额超限");
        merged.set(sku.id, { productId: pid, skuId: sku.id, quantity: wanted, name: product.name, spec: sku.spec, ...skuSnapshot(sku), cover: product.cover, priceFen, amountFen: priceFen * wanted, shippingFeeFen: 0, deliveryCycle: product.deliveryCycle });
      }
      delete checkedAddress.openid;
      return { items: [...merged.values()], address: checkedAddress };
    });
  }
  function reservePackage(state, parent, at) {
    const snapshot = parent && parent.physicalFulfillmentSnapshot;
    if (!snapshot || !Array.isArray(snapshot.items) || !snapshot.items.length) return null;
    const childId = packageId(parent), key = packageKey(parent), openid = required(parent.openid || parent._openid || parent.customer_openid, "套餐购买人");
    const address = addressInput(snapshot.address || {}, openid, at, snapshot.address);
    delete address.openid;
    const identity = hash(snapshot.items.map(row => [str(row.productId), str(row.skuId), Number(row.quantity)]));
    let order = state.orders.find(row => row.id === childId);
    if (order) {
      if (order.openid !== openid || order.packageSnapshotHash !== identity) fail("套餐履约商品快照不一致", "PHYSICAL_PACKAGE_CONFLICT", 409);
      if (order.status === "closed" && order.closeReason === "unpaid_expired" && !parentIsTerminal(parent)) {
        for (const item of order.items) {
          const stock = state.inventory.find(row => row.skuId === item.skuId);
          if (!stock || stock.onHand - stock.reserved < item.quantity) fail(`${item.name || "套餐商品"}库存不足`, "PHYSICAL_STOCK", 409);
          stock.reserved += item.quantity; bump(stock, at);
        }
        order.status = "pending_payment"; order.inventoryState = "reserved"; order.paymentStatus = "awaiting_package_payment"; delete order.closeReason; delete order.closedAt; bump(order, at);
        audit(state, order, "package_stock_reserved", openid, at, { parentKey: key, reopened: true });
      }
      if (parent.bookingId || !parent.bookingStatus) order.parentOrderId = str(parent.id || parent._id);
      if (parent.orderNo) order.parentOrderNo = str(parent.orderNo);
      return order;
    }
    if (parentIsTerminal(parent)) return null;
    const seen = new Set(), items = snapshot.items.map((row, index) => {
      const skuId = required(row.skuId, "套餐商品规格"), pid = required(row.productId, "套餐商品"), quantity = integer(row.quantity, "套餐商品数量", 2147483647, 1);
      if (seen.has(skuId)) fail("套餐商品规格必须合并", "PHYSICAL_PACKAGE_CONFLICT", 409); seen.add(skuId);
      const stock = state.inventory.find(value => value.skuId === skuId && value.productId === pid);
      if (!stock || stock.onHand - stock.reserved < quantity) fail(`${row.name || "套餐商品"}库存不足`, "PHYSICAL_STOCK", 409);
      stock.reserved += quantity; bump(stock, at);
      return { ...clone(row), id: `${childId}_item_${index}`, productId: pid, skuId, quantity, priceFen: 0, amountFen: 0, referencePriceFen: integer(row.priceFen || 0, "参考价格", 1000000000), referenceAmountFen: integer(row.amountFen || 0, "参考金额", Number.MAX_SAFE_INTEGER), shippingFeeFen: 0, refundedQuantity: 0 };
    });
    order = { id: childId, orderNo: `PGPK${hash(key).slice(0, 28).toUpperCase()}`, packageParentKey: key, parentBookingId: str(parent.bookingId || (parent.bookingStatus ? parent.id || parent._id : "")), parentOrderId: parent.bookingId || !parent.bookingStatus ? str(parent.id || parent._id) : "", parentOrderNo: str(parent.orderNo), packageSnapshotHash: identity, openid, scopeId: "platform", orderType: "physical", paymentMode: "package", paymentStatus: "awaiting_package_payment", status: "pending_payment", version: 1, items, address, goodsAmountFen: 0, totalAmountFen: 0, shippingFeeFen: 0, refundedFen: 0, refundedShippingFen: 0, createdAt: at, updatedAt: at, inventoryState: "reserved", remark: "套餐内实物商品，金额已包含在套餐内" };
    state.orders.push(order); audit(state, order, "package_stock_reserved", openid, at, { parentKey: key });
    return order;
  }
  async function reservePackageFulfillment(parent) {
    if (!parent?.physicalFulfillmentSnapshot?.items?.length) return null;
    return tx(state => { const order = reservePackage(state, parent, time()); return order ? publicOrder(state, order) : null; });
  }
  function releasePackage(state, parent, at) {
    const order = state.orders.find(row => row.id === packageId(parent));
    if (!order) return null;
    if (order.openid !== str(parent.openid || parent._openid || parent.customer_openid)) fail("套餐订单归属不一致", "PHYSICAL_PACKAGE_CONFLICT", 409);
    if (order.status === "closed") return order;
    if (shipmentFor(state, order) || ["awaiting_receipt", "completed"].includes(order.status)) {
      if (!order.parentCancellationPending) { order.parentCancellationPending = true; bump(order, at); audit(state, order, "package_cancel_requires_return", "system", at); }
      return order;
    }
    for (const item of order.items) {
      const stock = state.inventory.find(row => row.skuId === item.skuId);
      if (!stock) fail("套餐库存需核对", "PHYSICAL_STOCK_CONFLICT", 409);
      if (order.inventoryState === "reserved") { if (stock.reserved < item.quantity) fail("套餐预占库存需核对", "PHYSICAL_STOCK_CONFLICT", 409); stock.reserved -= item.quantity; }
      else if (order.inventoryState === "deducted") { if (Number(stock.sold || 0) < item.quantity) fail("套餐已售库存需核对", "PHYSICAL_STOCK_CONFLICT", 409); stock.onHand += item.quantity; stock.sold -= item.quantity; }
      bump(stock, at);
    }
    order.inventoryState = "released"; order.status = "closed"; order.closeReason = parent.physicalReleaseReason === "unpaid_expired" ? "unpaid_expired" : "parent_cancelled"; order.closedAt = at; order.paymentStatus = "package_cancelled"; bump(order, at); audit(state, order, "package_stock_released", "system", at); return order;
  }
  async function releasePackageFulfillment(parent) {
    if (!parent || !(parent.bookingId || parent.id || parent._id)) return null;
    return tx(state => { const order = releasePackage(state, parent, time()); return order ? publicOrder(state, order) : null; });
  }
  async function syncPackageFulfillment(parent) {
    if (!parent?.physicalFulfillmentSnapshot?.items?.length) return null;
    return tx(state => {
      const at = time();
      if (parentIsTerminal(parent)) { const closed = releasePackage(state, parent, at); return closed ? publicOrder(state, closed) : null; }
      const order = reservePackage(state, parent, at);
      if (order.status !== "pending_payment" || !parentIsPaid(parent)) return publicOrder(state, order);
      for (const item of order.items) {
        const stock = state.inventory.find(row => row.skuId === item.skuId);
        if (!stock || stock.reserved < item.quantity || stock.onHand < item.quantity) fail("套餐支付库存需核对", "PHYSICAL_STOCK_CONFLICT", 409);
        stock.reserved -= item.quantity; stock.onHand -= item.quantity; stock.sold = Number(stock.sold || 0) + item.quantity; bump(stock, at);
      }
      order.inventoryState = "deducted"; order.status = "awaiting_shipment"; order.paymentStatus = "included_in_package"; order.parentPayment = parentPayment(parent); order.paidAt = parent.finalPaidAt || parent.depositPaidAt || parent.completedAt || at;
      bump(order, at); audit(state, order, "package_payment_confirmed", "system", at, { parentOrderId: order.parentOrderId, parentOrderNo: order.parentOrderNo }); return publicOrder(state, order);
    });
  }
  async function packageFulfillmentOrders(parent, openid) {
    if (!parent || !(parent.bookingId || parent.id || parent._id)) return [];
    return tx(state => state.orders.filter(row => row.id === packageId(parent) && (!openid || row.openid === str(openid))).map(row => publicOrder(state, row)));
  }
  function addTask(state, type, payload, at) { const key = `${type}:${payload.shipmentId || payload.orderId}:${payload.version || 1}`; if (!state.tasks.some(row => row.key === key)) state.tasks.push({ id: id("task"), key, type, ...payload, status: "pending", attempts: 0, nextAt: at, createdAt: at }); }
  function safeRelease(state, order, at, reason) {
    if (order.status !== "pending_payment") return;
    for (const item of order.items) { const stock = state.inventory.find(row => row.skuId === item.skuId); if (!stock || stock.reserved < item.quantity) fail("库存预占需核对", "PHYSICAL_INVENTORY_CONFLICT", 409); stock.reserved -= item.quantity; bump(stock, at); }
    order.status = "closed"; order.closeReason = reason; order.closedAt = at; bump(order, at); audit(state, order, "close", order.openid, at, { reason });
  }
  function receipt(state, order, input, at) {
    if (["completed", "closed"].includes(order.status)) return publicOrder(state, order);
    const shipment = shipmentFor(state, order);
    if (frozen(state, order)) { if (input.platform) { order.pendingReceipt = clone(input); return publicOrder(state, order); } fail("售后或改址处理中，暂不能确认收货", "PHYSICAL_FROZEN", 409); }
    if (order.status !== "awaiting_receipt" || !shipment || shipment.version !== Number(input.shipmentVersion || shipment.version) || ["returned", "refused", "exception"].includes(shipment.logisticsStatus)) fail("发货事实需核对，暂不能确认收货", "PHYSICAL_RECEIPT_CONFLICT", 409);
    if (!input.platform && input.received !== true) fail("请确认已实际收到本订单全部剩余商品");
    order.status = "completed"; order.completedAt = at; order.receiptSource = input.platform ? "wechat" : "mini"; order.confirmationMethod = input.mode || "active"; order.confirmedAt = input.platform ? input.confirmedAt || null : at; delete order.pendingReceipt; bump(order, at); audit(state, order, "receipt", order.openid, at, { source: order.receiptSource });
    return publicOrder(state, order);
  }
  async function executePublic(action, input = {}, session = {}) {
    if (action === "getPhysicalCatalog") {
      const products = await rawCatalog(); return tx(state => { const config = configOf(state), items = materialize(state, products).filter(row => row.visible); return { items, enabled: config.enabled, carrierOptions: config.carrierOptions }; });
    }
    const openid = publicIdentity(session), at = time();
    if (["getPhysicalCart", "updatePhysicalCart", "previewPhysicalCheckout", "createPhysicalOrder"].includes(action)) {
      const products = await rawCatalog();
      // Idempotent retries retain the original validated checkout source.
      const existingOrder = action === "createPhysicalOrder" && await tx(state => state.orders.find(row => row.openid === openid && row.checkoutKey === str(input.idempotencyKey)) || null);
      const merchantSource = action === "createPhysicalOrder" && !existingOrder ? await checkoutMerchantSource(input, at, openid) : null;
      return tx(state => {
        if (action === "createPhysicalOrder") { const key = required(input.idempotencyKey, "下单请求标识"); const old = state.orders.find(row => row.openid === openid && row.checkoutKey === key); if (old) { if (old.checkoutRequestHash && old.checkoutRequestHash !== hash([input.checkoutSource, input.items, input.addressId])) fail("同一下单请求标识不能用于不同商品或地址", "PHYSICAL_IDEMPOTENCY_CONFLICT", 409); return publicOrder(state, old); } }
        const catalog = materialize(state, products), config = configOf(state);
        if (action === "getPhysicalCart") return cartView(state, openid, catalog);
        if (action === "updatePhysicalCart") {
          const op = input.operation || "add"; let line = state.carts.find(row => row.id === str(input.lineId) && row.openid === openid);
          if (op === "clearInvalid") { const invalid = new Set(cartView(state, openid, catalog).items.filter(row => !row.valid).map(row => row.id)); state.carts = state.carts.filter(row => !invalid.has(row.id)); return cartView(state, openid, catalog); }
          if (op === "selectAll") { for (const row of state.carts.filter(row => row.openid === openid)) { row.selected = input.selected === true; bump(row, at); } return cartView(state, openid, catalog); }
          if (op !== "add") { if (!line) fail("购物车商品不存在"); if (Number(input.version) !== line.version) fail("购物车已更新，请刷新", "PHYSICAL_CONFLICT", 409); }
          if (op === "remove") state.carts = state.carts.filter(row => row.id !== line.id);
          else if (op === "select") { line.selected = input.selected === true; bump(line, at); }
          else if (["add", "quantity", "spec"].includes(op)) {
            const pid = str(input.productId || line?.productId), sid = str(input.skuId || line?.skuId), product = catalog.find(row => row.id === pid), sku = product?.skus.find(row => row.id === sid);
            const quantity = integer(input.quantity ?? line?.quantity ?? 1, "数量", config.maxQuantity, 1);
            if (!sku?.purchasable) fail("该规格暂不可购买");
            const same = state.carts.find(row => row.openid === openid && row.productId === pid && row.skuId === sid && (op === "add" || row.id !== line?.id));
            const wanted = op === "quantity" ? quantity : quantity + (same?.quantity || 0);
            if (wanted > sku.available || wanted > config.maxQuantity) fail("库存不足或超过限购数量", "PHYSICAL_STOCK", 409);
            if (op === "quantity") { line.quantity = quantity; bump(line, at); }
            else if (same) { same.quantity = wanted; same.selected = true; bump(same, at); if (line) state.carts = state.carts.filter(row => row.id !== line.id); }
            else { if (!line && state.carts.filter(row => row.openid === openid).length >= config.maxLines) fail("购物车商品种类已达上限"); if (!line) { line = { id: id("cart"), openid, version: 0 }; state.carts.push(line); } Object.assign(line, { productId: pid, skuId: sid, quantity, selected: true, name: product.name, spec: sku.spec, ...skuPresentation(sku), cover: product.cover }); bump(line, at); }
          } else fail("不支持的购物车操作");
          return cartView(state, openid, catalog);
        }
        const preview = quote(state, input, openid, catalog);
        if (action === "previewPhysicalCheckout") return publicQuote(preview);
        if (required(input.quoteVersion, "结算报价版本") !== preview.quoteVersion) fail("价格或地址已变化，请重新确认", "PHYSICAL_QUOTE_CHANGED", 409);
        if (state.orders.filter(row => row.openid === openid && row.status === "pending_payment").length >= config.maxPendingOrders) fail("待付款订单过多，请先完成或取消已有订单", "PHYSICAL_PENDING_LIMIT", 409);
        for (const item of preview.items) { const stock = state.inventory.find(row => row.skuId === item.skuId); if (stock.onHand - stock.reserved < item.quantity) fail("库存不足", "PHYSICAL_STOCK", 409); stock.reserved += item.quantity; bump(stock, at); }
        const order = { ...preview, id: id("physical"), orderNo: `PG${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString("hex").toUpperCase()}`, openid, scopeId: "platform", orderType: "physical", status: "pending_payment", version: 1, checkoutKey: str(input.idempotencyKey), checkoutRequestHash: hash([input.checkoutSource, input.items, input.addressId]), createdAt: at, updatedAt: at, expiresAt: new Date(Date.parse(at) + config.paymentMinutes * 60000).toISOString(), refundedFen: 0, refundedShippingFen: 0, remark: str(input.remark).slice(0, 300), source: merchantSource };
        delete order.address.openid;
        state.orders.push(order);
        if (preview.checkoutSource === "cart") { const ids = new Set(preview.items.map(row => row.cartLineId)); state.carts = state.carts.filter(row => !ids.has(row.id)); }
        audit(state, order, "create", openid, at); return publicOrder(state, order);
      });
    }
    if (action === "createPhysicalPayment") return createPayment(input, openid, session);
    if (action === "getPhysicalPaymentStatus") return getPaymentStatus(input, openid);
    if (action === "cancelPhysicalOrder") return cancelOrder(input, openid);
    if (action === "getPhysicalLogistics") return readLogistics(input, openid);
    if (action === "requestPhysicalAddressChange") {
      const pending = await tx(state => ownOrder(state, input.orderId || input.id, openid).status === "pending_payment");
      if (pending) return changePendingAddress(input, openid);
    }
    if (action === "confirmPhysicalReceipt") {
      const context = await tx(state => { const order = ownOrder(state, input.orderId || input.id, openid), payment = paymentFor(state, order); return { required: !!configOf(state).wechatReceiptRequired && (order.paymentMode !== "package" || !!payment?.externalTransactionId), order: { ...order, payment }, shipment: shipmentFor(state, order) }; });
      if (context.required) {
        if (!shipping?.isConfigured()) fail("微信收货同步未配置，请稍后重试", "PHYSICAL_RECEIPT_UNAVAILABLE", 503);
        const update = await shipping.queryReceipt(context.order, context.shipment);
        if (!update.received || !update.shipmentMatches) fail("微信收货结果确认中，请稍后刷新", "PHYSICAL_RECEIPT_PENDING", 409);
        await applyWechatReceipt({ ...update, orderId: context.order.id, shipmentId: context.shipment?.id, version: context.shipment?.version });
        return tx(state => publicOrder(state, ownOrder(state, context.order.id, openid)));
      }
      if (input.source === "wechat") fail("微信收货结果须经服务端核实，请刷新后重试", "PHYSICAL_RECEIPT_PENDING", 409);
    }
    const selection = publicReadSelection(action, input, openid);
    const execute = selection && typeof store.read === "function" ? callback => store.read(callback, selection) : tx;
    return execute(state => {
      if (action === "getShippingAddresses") return { items: state.addresses.filter(row => row.openid === openid).sort((a, b) => Number(b.isDefault) - Number(a.isDefault)) };
      if (action === "saveShippingAddress") {
        const old = input.id ? state.addresses.find(row => row.id === str(input.id) && row.openid === openid) : null; if (input.id && !old) fail("地址不存在", "PHYSICAL_NOT_FOUND", 404);
        if (old && input.version != null && Number(input.version) !== old.version) fail("地址已更新，请刷新", "PHYSICAL_CONFLICT", 409);
        if (!old && state.addresses.filter(row => row.openid === openid).length >= 20) fail("收货地址最多20条");
        const address = addressInput(input, openid, at, old); if (!state.addresses.some(row => row.openid === openid)) address.isDefault = true;
        if (address.isDefault) state.addresses.filter(row => row.openid === openid && row.isDefault).forEach(row => { row.isDefault = false; bump(row, at); });
        state.addresses = state.addresses.filter(row => row.id !== address.id); state.addresses.push(address); return address;
      }
      if (["deleteShippingAddress", "setDefaultShippingAddress"].includes(action)) {
        const address = state.addresses.find(row => row.id === str(input.id || input.addressId) && row.openid === openid); if (!address) fail("地址不存在", "PHYSICAL_NOT_FOUND", 404);
        if (action === "deleteShippingAddress") state.addresses = state.addresses.filter(row => row.id !== address.id);
        else for (const row of state.addresses.filter(row => row.openid === openid)) { row.isDefault = row.id === address.id; bump(row, at); }
        return { items: state.addresses.filter(row => row.openid === openid) };
      }
      if (action === "getPhysicalOrders") { const rows = state.orders.filter(row => row.openid === openid && (!input.status || input.status === "all" || row.status === input.status)).filter(row => !input.afterSale || state.afterSales.some(sale => sale.orderId === row.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(row => publicOrder(state, row)); const result = paginate(rows, input); return { ...result, orders: result.items }; }
      if (action === "getPhysicalOrderCounts") { const rows = state.orders.filter(row => row.openid === openid); return { orderType: "physical", total: rows.length, ...Object.fromEntries(Object.keys(STATUS).map(status => [status, rows.filter(row => row.status === status).length])), afterSale: rows.filter(row => activeAfterSale(state, row.id)).length }; }
      if (action === "getPhysicalAfterSales") return { carrierOptions: configOf(state).carrierOptions, items: state.afterSales.filter(row => row.openid === openid && (!input.orderId || row.orderId === input.orderId)).map(row => publicAfterSale(state, row)) };
      if (action === "updatePhysicalReturnShipment") {
        const sale = state.afterSales.find(row => row.id === str(input.afterSaleId) && row.openid === openid); if (!sale || sale.status !== "awaiting_return") fail("没有可登记的退货工单");
        if (sale.returnShipmentId) fail("退货运单已登记，修订请联系客服", "PHYSICAL_STATE", 409);
        const order = ownOrder(state, sale.orderId, openid), companyCode = required(input.carrierCode || input.companyCode, "退货快递公司", 60), trackingNo = required(input.trackingNo, "退货物流单号", 32);
        if (!/^[A-Za-z0-9-]{6,32}$/.test(trackingNo)) fail("物流单号格式不正确");
        const carrier = configOf(state).carrierOptions.find(row => row.code === companyCode); if (!carrier) fail("请选择已支持的快递公司");
        const shipment = { id: id("return"), orderId: order.id, afterSaleId: sale.id, kind: "return", active: true, version: 1, carrierCode: companyCode, companyCode, carrierName: carrier.name, trackingNo, phone: order.address.phone, subscriptionSalt: crypto.randomBytes(24).toString("hex"), logisticsStatus: "awaiting_collection", monitorStatus: "pending", events: [], createdAt: at };
        state.shipments.push(shipment); sale.returnShipmentId = shipment.id; sale.returnTrackingNo = trackingNo; sale.returnCarrierCode = companyCode; bump(sale, at); addTask(state, "subscribe", { orderId: order.id, shipmentId: shipment.id, version: 1 }, at); return publicAfterSale(state, sale);
      }
      const order = ownOrder(state, input.orderId || input.id || input.orderNo, openid);
      if (action === "getPhysicalOrder") return publicOrder(state, order);
      if (action === "confirmPhysicalReceipt") return receipt(state, order, input, at);
      if (action === "requestPhysicalAddressChange") {
        if (order.status !== "awaiting_shipment" || frozen(state, order)) fail("当前订单不能直接申请改址，请联系客服核实交运", "PHYSICAL_STATE", 409);
        const address = state.addresses.find(row => row.id === str(input.addressId) && row.openid === openid); if (!address) fail("请选择本人收货地址");
        order.addressChange = { id: id("change"), status: "pending", address: clone(address), reason: str(input.reason).slice(0, 300), requestedAt: at }; bump(order, at); return publicOrder(state, order);
      }
      if (action === "createPhysicalAfterSale") return createAfterSale(state, order, input, at);
      fail("实物接口不存在", "PHYSICAL_NOT_FOUND", 404);
    });
  }
  async function createPayment(input, openid, session = {}) {
    await tx(state => { const order = ownOrder(state, input.orderId || input.id, openid); if (order.paymentMode === "package") fail("套餐内商品无需单独付款，请在套餐订单支付", "PHYSICAL_PACKAGE_PAYMENT_MANAGED", 409); });
    if (!wechatPay || !wechatPay.isConfigured()) fail("微信支付尚未配置", "PHYSICAL_PAY_UNAVAILABLE", 503);
    const at = time();
    const prepared = await tx(state => {
      const order = ownOrder(state, input.orderId || input.id, openid);
      if (order.addressEditInProgress) fail("地址更新中，请稍后刷新", "PHYSICAL_CONFLICT", 409);
      if (order.status !== "pending_payment" || Date.parse(order.expiresAt) <= Date.parse(at)) fail("订单已支付或已到期，请刷新", "PHYSICAL_STATE", 409);
      const existing = state.payments.find(row => row.orderId === order.id && ["pending", "confirmed"].includes(row.status));
      if (existing) {
        if (existing.preparing && Date.parse(at) - Date.parse(existing.preparingAt || existing.createdAt) < 60000) fail("支付单创建结果确认中，请稍后查询", "PHYSICAL_PAY_PENDING", 409);
        if (!existing.paymentParams && existing.status === "pending") { existing.preparing = true; existing.preparingAt = at; }
        return { order, payment: existing, reused: true };
      }
      const payment = { id: id("pay"), orderId: order.id, openid, phase: "full", provider: "wechat_pay", outTradeNo: `PG${crypto.randomBytes(14).toString("hex")}`, amount: yuan(order.totalAmountFen), amountFen: order.totalAmountFen, status: "pending", preparing: true, preparingAt: at, createdAt: at, version: 1,
        sessionId: str(session.sessionId || session.createdAt || session.id), sessionStartAt: session.createdAt && Number.isFinite(Date.parse(session.createdAt)) ? new Date(session.createdAt).toISOString() : at };
      state.payments.push(payment); return { order, payment, reused: false };
    });
    if (prepared.payment.status === "confirmed") return { orderId: prepared.order.id, status: "confirmed", phase: "full", order: prepared.order };
    if (prepared.payment.paymentParams) return { orderId: prepared.order.id, paymentId: prepared.payment.id, status: "pending", phase: "full", paymentParams: prepared.payment.paymentParams, payParams: prepared.payment.paymentParams };
    // A response may have been lost after WeChat accepted an earlier attempt.
    // Reuse the same out_trade_no, never create a second charge.
    let result;
    try { result = await wechatPay.createJsapiTransaction({ order: prepared.order, phase: "full", payment: prepared.payment, openid }); }
    catch (error) { await tx(state => { const payment = state.payments.find(row => row.id === prepared.payment.id); payment.preparing = false; payment.lastError = str(error.code || "PAYMENT_PREPARATION_FAILED"); }); throw error; }
    return tx(state => {
      const payment = state.payments.find(row => row.id === prepared.payment.id), order = ownOrder(state, prepared.order.id, openid);
      if (payment.status === "confirmed") return { orderId: order.id, status: "confirmed", order: publicOrder(state, order) };
      if (order.status !== "pending_payment" || payment.status !== "pending") fail("订单状态已变化，请查询支付结果", "PHYSICAL_STATE", 409);
      payment.preparing = false; payment.prepayId = result.prepayId; payment.paymentParams = result.paymentParams; bump(payment, time());
      return { orderId: order.id, paymentId: payment.id, phase: "full", status: payment.status, paymentParams: payment.paymentParams, payParams: payment.paymentParams };
    });
  }
  async function findPayment(outTradeNo) { return tx(state => state.payments.find(row => row.outTradeNo === str(outTradeNo)) || null); }
  async function findRefund(refundNo) { return tx(state => state.refunds.find(row => row.refundNo === str(refundNo)) || null); }
  async function confirmPayment(transaction) {
    const at = time();
    return tx(state => {
      const payment = state.payments.find(row => row.outTradeNo === str(transaction.outTradeNo)); if (!payment) return null;
      const order = ownOrder(state, payment.orderId);
      const payer = transaction.payerOpenid || transaction.openid, currency = transaction.amountCurrency || transaction.currency;
      if (transaction.tradeState === "SUCCESS" && (Number(transaction.amountTotal) !== payment.amountFen || payer !== order.openid || currency !== "CNY")) fail("支付金额或付款人不匹配", "PHYSICAL_PAYMENT_MISMATCH", 409);
      if (transaction.tradeState !== "SUCCESS") {
        if (payment.status !== "confirmed" && ["CLOSED", "PAYERROR", "REVOKED"].includes(transaction.tradeState)) { payment.status = "closed"; bump(payment, at); }
        return { order: publicOrder(state, order), payment };
      }
      const transactionId = required(transaction.transactionId, "微信交易号");
      if (state.payments.some(row => row.id !== payment.id && row.externalTransactionId === transactionId)) fail("支付流水已关联其他订单", "PHYSICAL_PAYMENT_MISMATCH", 409);
      if (payment.status === "confirmed") { if (payment.externalTransactionId !== transactionId) fail("支付流水不匹配", "PHYSICAL_PAYMENT_MISMATCH", 409); return { order: publicOrder(state, order), payment, idempotent: true }; }
      Object.assign(payment, { status: "confirmed", externalTransactionId: transactionId, confirmedAt: transaction.successTime || at }); bump(payment, at);
      order.paidAt = payment.confirmedAt; order.paymentStatus = "paid";
      addTask(state, "merchant_share_payment", { orderId: order.id, version: 1 }, at);
      if (order.status === "closed") { order.paymentException = "closed_order_paid"; addTask(state, "late_refund", { orderId: order.id }, at); bump(order, at); audit(state, order, "late_payment", "wechat", at); return { order: publicOrder(state, order), payment }; }
      if (order.status !== "pending_payment") {
        order.paymentException = "duplicate_payment";
        if (!state.refunds.some(row => row.paymentId === payment.id)) state.refunds.push({ id: id("refund"), orderId: order.id, paymentId: payment.id, refundNo: `PR${crypto.randomBytes(14).toString("hex")}`, outTradeNo: payment.outTradeNo, transactionId, totalFen: payment.amountFen, amountFen: payment.amountFen, status: "PENDING", duplicatePayment: true, reason: "重复实收款原路退回", createdAt: at });
        bump(order, at); audit(state, order, "duplicate_payment", "wechat", at, { paymentId: payment.id }); return { order: publicOrder(state, order), payment };
      }
      for (const item of order.items) { const stock = state.inventory.find(row => row.skuId === item.skuId); if (!stock || stock.reserved < item.quantity || stock.onHand < item.quantity) fail("支付库存需核对", "PHYSICAL_STOCK_CONFLICT", 409); stock.reserved -= item.quantity; stock.onHand -= item.quantity; stock.sold += item.quantity; bump(stock, at); }
      order.status = "awaiting_shipment"; bump(order, at); audit(state, order, "full_payment_confirmed", "wechat", at, { transactionId }); return { order: publicOrder(state, order), payment };
    });
  }
  async function getPaymentStatus(input, openid) {
    const context = await tx(state => { const order = ownOrder(state, input.orderId || input.id, openid); return { order, payment: paymentFor(state, order) || null }; });
    if (context.payment && context.payment.status === "pending" && wechatPay?.isConfigured()) {
      try { const transaction = await wechatPay.queryTransaction(context.payment.outTradeNo); await confirmPayment(transaction); }
      catch (error) { if (error.code !== "WECHAT_PAY_TRANSACTION_NOT_FOUND") return { orderId: context.order.id, status: "pending", confirming: true, message: "支付结果确认中，请稍后刷新" }; }
    }
    return tx(state => { const order = ownOrder(state, context.order.id, openid), payment = paymentFor(state, order); return { orderId: order.id, status: payment?.status || "unpaid", phase: "full", paid: payment?.status === "confirmed", order: publicOrder(state, order) }; });
  }
  async function cancelOrder(input, openid) {
    await tx(state => { if (ownOrder(state, input.orderId || input.id, openid).paymentMode === "package") fail("套餐内商品请通过套餐订单取消或联系客服", "PHYSICAL_PACKAGE_PAYMENT_MANAGED", 409); });
    const context = await tx(state => { const order = ownOrder(state, input.orderId || input.id, openid); if (order.addressEditInProgress) fail("地址更新中，请稍后取消", "PHYSICAL_CONFLICT", 409); if (order.status === "closed") return { order, payment: null }; if (order.status !== "pending_payment") fail("已付款订单请申请售后", "PHYSICAL_STATE", 409); return { order, payment: paymentFor(state, order) || null }; });
    if (context.order.status === "closed") return tx(state => publicOrder(state, ownOrder(state, context.order.id, openid)));
    const payment = context.payment;
    if (payment?.preparing && Date.parse(time()) - Date.parse(payment.preparingAt || payment.createdAt) < 60000) fail("支付创建尚未确认，请稍后查询再取消", "PHYSICAL_PAY_PENDING", 409);
    if (payment && payment.status !== "closed") {
      if (!wechatPay?.isConfigured()) fail("支付结果未核实，暂不能释放库存", "PHYSICAL_PAY_UNAVAILABLE", 503);
      let absent = false;
      try {
        const transaction = await wechatPay.queryTransaction(payment.outTradeNo);
        if (transaction.tradeState === "SUCCESS") { await confirmPayment(transaction); fail("订单已付款，请申请售后", "PHYSICAL_ALREADY_PAID", 409); }
        if (!["CLOSED", "REVOKED", "PAYERROR", "NOTPAY"].includes(transaction.tradeState)) fail("支付结果确认中，请稍后重试", "PHYSICAL_PAY_PENDING", 409);
      } catch (error) { if (error.code === "WECHAT_PAY_TRANSACTION_NOT_FOUND") absent = true; else throw error; }
      // A pending prepay creation can still be in flight. A not-found response
      // is insufficient proof that it can never charge; close by merchant id.
      try { await wechatPay.closeTransaction(payment.outTradeNo); }
      catch (error) { if (!absent || !["WECHAT_PAY_TRANSACTION_NOT_FOUND"].includes(error.code)) fail("支付关单结果未确认，库存暂保留", "PHYSICAL_CLOSE_PENDING", 409); }
    }
    return tx(state => {
      const order = ownOrder(state, context.order.id, openid), current = paymentFor(state, order);
      if (current?.status === "confirmed") fail("订单已付款，请申请售后", "PHYSICAL_ALREADY_PAID", 409);
      // Prevent createPayment from racing a cancellation that saw no intent.
      if (!payment && current) fail("支付已开始，请重新查询后取消", "PHYSICAL_CONFLICT", 409);
      if (current) { current.status = "closed"; bump(current, time()); }
      safeRelease(state, order, time(), input.reason === "timeout" ? "payment_timeout" : "user_cancel"); return publicOrder(state, order);
    });
  }
  async function changePendingAddress(input, openid) {
    const packageOrder = await tx(state => {
      const order = ownOrder(state, input.orderId || input.id, openid);
      if (order.paymentMode !== "package") return null;
      if (order.status !== "pending_payment" || frozen(state, order)) fail("套餐商品订单状态已变化，请刷新", "PHYSICAL_STATE", 409);
      if (input.version != null && Number(input.version) !== order.version) fail("订单已更新，请刷新", "PHYSICAL_CONFLICT", 409);
      const address = state.addresses.find(row => row.id === str(input.addressId) && row.openid === openid);
      if (!address) fail("请选择本人收货地址");
      const config = configOf(state); if (config.allowedProvinces.length && !config.allowedProvinces.includes(address.province)) fail("新地址不支持配送");
      const previous = clone(order.address); order.address = addressInput(address, openid, time(), address); delete order.address.openid;
      bump(order, time()); audit(state, order, "unpaid_address_changed", openid, time(), { previous }); return publicOrder(state, order);
    });
    if (packageOrder) return packageOrder;
    const token = id("edit");
    const context = await tx(state => {
      const order = ownOrder(state, input.orderId || input.id, openid), address = state.addresses.find(row => row.id === str(input.addressId) && row.openid === openid), config = configOf(state);
      if (!address) fail("请选择本人收货地址");
      if (order.status !== "pending_payment" || order.addressEditInProgress || Date.parse(order.expiresAt) <= Date.parse(time())) fail("订单状态已变化，请刷新", "PHYSICAL_CONFLICT", 409);
      if (input.version != null && Number(input.version) !== order.version) fail("订单已更新，请刷新", "PHYSICAL_CONFLICT", 409);
      if (config.allowedProvinces.length && !config.allowedProvinces.includes(address.province)) fail("新地址不支持配送");
      const payment = paymentFor(state, order); if (payment?.preparing && Date.parse(time()) - Date.parse(payment.preparingAt || payment.createdAt) < 60000) fail("支付创建结果未确认，暂不能改地址", "PHYSICAL_PAY_PENDING", 409);
      order.addressEditInProgress = token; order.addressEditAt = time(); return { order, payment: payment || null, address };
    });
    try {
      if (context.payment && context.payment.status !== "closed") {
        if (!wechatPay?.isConfigured()) fail("请先核实原支付结果后改址", "PHYSICAL_PAY_UNAVAILABLE", 503);
        const transaction = await wechatPay.queryTransaction(context.payment.outTradeNo);
        if (transaction.tradeState === "SUCCESS") await confirmPayment(transaction);
        else {
          if (!["NOTPAY", "CLOSED", "REVOKED", "PAYERROR"].includes(transaction.tradeState)) fail("支付结果未明，不能修改地址", "PHYSICAL_PAY_PENDING", 409);
          if (transaction.tradeState === "NOTPAY") await wechatPay.closeTransaction(context.payment.outTradeNo);
        }
      }
      return await tx(state => {
        const order = ownOrder(state, context.order.id, openid), payment = context.payment && state.payments.find(row => row.id === context.payment.id);
        if (order.addressEditInProgress !== token) fail("地址操作已更新，请刷新", "PHYSICAL_CONFLICT", 409);
        delete order.addressEditInProgress; delete order.addressEditAt;
        if (order.status === "awaiting_shipment" || payment?.status === "confirmed") {
          if (frozen(state, order)) fail("订单已付款且有待处理申请，请联系客服", "PHYSICAL_FROZEN", 409);
          order.addressChange = { id: id("change"), status: "pending", address: context.address, reason: "付款到账后改址转客服审核", requestedAt: time() };
        } else {
          if (order.status !== "pending_payment") fail("订单已关闭，不能改址", "PHYSICAL_STATE", 409);
          if (payment) { payment.status = "closed"; payment.paymentParams = null; bump(payment, time()); }
          const previous = clone(order.address); order.address = clone(context.address); delete order.address.openid;
          // Initial release uses one address-independent base fee per item;
          // freeze the original item rates and never apply current SKU prices.
          order.shippingFeeFen = Math.max(...order.items.map(row => row.shippingFeeFen)); order.totalAmountFen = order.goodsAmountFen + order.shippingFeeFen;
          audit(state, order, "unpaid_address_changed", openid, time(), { previous });
        }
        bump(order, time()); return publicOrder(state, order);
      });
    } finally { await tx(state => { const order = state.orders.find(row => row.id === context.order.id); if (order?.addressEditInProgress === token) { delete order.addressEditInProgress; delete order.addressEditAt; } }); }
  }
  function createAfterSale(state, order, input, at) {
    if (order.paymentMode === "package") fail("套餐内商品售后请联系客服并通过套餐订单处理", "PHYSICAL_PACKAGE_PAYMENT_MANAGED", 409);
    if (!["awaiting_shipment", "awaiting_receipt", "completed"].includes(order.status) || activeAfterSale(state, order.id)) fail("当前已有售后或订单不能申请售后", "PHYSICAL_STATE", 409);
    const config = configOf(state);
    if (order.completedAt && Date.parse(at) > Date.parse(order.completedAt) + config.afterSaleDays * 86400000) fail("已超过在线售后申请期限，请联系客服");
    const wanted = Array.isArray(input.items) && input.items.length ? input.items : remainingItems(order).map(row => ({ itemId: row.id, quantity: row.remainingQuantity }));
    const seen = new Set();
    const items = wanted.map(value => { const item = order.items.find(row => row.id === str(value.itemId || value.orderItemId || value.lineId || value.id)); if (!item || seen.has(item.id)) fail("售后商品不合法"); seen.add(item.id); const quantity = integer(value.quantity, "退款数量", item.quantity - item.refundedQuantity, 1); return { itemId: item.id, skuId: item.skuId, quantity, amountFen: item.priceFen * quantity }; });
    const sale = { id: id("sale"), orderId: order.id, openid: order.openid, status: shipmentFor(state, order) ? "dispatch_verification" : "pending_review", items, amountFen: items.reduce((sum, row) => sum + row.amountFen, 0), reason: required(input.reason, "售后原因", 500), attachmentFileIds: [...new Set((Array.isArray(input.attachmentFileIds) ? input.attachmentFileIds : []).map(value => required(value, "凭证文件ID", 128)))].slice(0, 9), createdAt: at, updatedAt: at, version: 1, originalStatus: order.status };
    state.afterSales.push(sale); bump(order, at); audit(state, order, "after_sale_requested", order.openid, at, { afterSaleId: sale.id }); return sale;
  }
  async function confirmRefund(result) {
    return tx(state => {
      const refund = state.refunds.find(row => row.refundNo === str(result.refundNo)); if (!refund) return null;
      if (Number(result.amount) !== refund.amountFen || Number(result.total) !== refund.totalFen || str(result.outTradeNo) !== refund.outTradeNo || result.transactionId && result.transactionId !== refund.transactionId) fail("退款流水不匹配", "PHYSICAL_REFUND_MISMATCH", 409);
      if (refund.status === "SUCCESS") return refund;
      refund.status = result.status; refund.refundId = result.refundId; refund.successAt = result.successTime || null; bump(refund, time());
      if (result.status !== "SUCCESS") return refund;
      const order = ownOrder(state, refund.orderId), sale = state.afterSales.find(row => row.id === refund.afterSaleId);
      if (refund.duplicatePayment) { audit(state, order, "duplicate_payment_refunded", "wechat", time(), { refundId: refund.id }); return refund; }
      addTask(state, "merchant_share_refund", { orderId: order.id, refundId: refund.id, version: refund.id }, time());
      if (sale) {
        for (const entry of sale.items) {
          const item = order.items.find(row => row.id === entry.itemId); if (item.refundedQuantity + entry.quantity > item.quantity) fail("累计退款数量超限", "PHYSICAL_REFUND_CONFLICT", 409); item.refundedQuantity += entry.quantity;
          const stock = state.inventory.find(row => row.skuId === item.skuId);
          if (stock && sale.restockAllowed) { stock.onHand += entry.quantity; bump(stock, time()); }
        }
        order.refundedShippingFen += sale.shippingRefundFen || 0; sale.status = "completed"; sale.refundedAt = time(); bump(sale, time());
      }
      order.refundedFen += refund.amountFen; if (order.refundedFen > order.totalAmountFen) fail("累计退款超过实收", "PHYSICAL_REFUND_CONFLICT", 409);
      order.paymentStatus = order.refundedFen === order.totalAmountFen ? "refunded" : "partially_refunded";
      if (!remainingItems(order).length || refund.latePayment) { order.status = "closed"; order.closeReason = "refunded"; order.closedAt = time(); }
      bump(order, time()); audit(state, order, "refund_success", "wechat", time(), { refundId: refund.id });
      if (order.pendingReceipt && !frozen(state, order) && order.status === "awaiting_receipt") receipt(state, order, order.pendingReceipt, time());
      return refund;
    });
  }
  async function issueRefund(refundId) {
    const data = await tx(state => { const refund = state.refunds.find(row => row.id === refundId); if (!refund) fail("退款不存在"); const payment = state.payments.find(row => row.id === refund.paymentId); return { refund, payment }; });
    if (data.refund.status === "SUCCESS") return data.refund;
    if (!wechatPay?.isConfigured()) fail("退款通道未配置，保持冻结", "PHYSICAL_PAY_UNAVAILABLE", 503);
    try {
      // Existing attempts must be queried, not replaced with another refund id.
      let result;
      if (data.refund.attemptedAt) { try { result = await wechatPay.queryRefund(data.refund.refundNo); } catch (error) { if (error.code !== "WECHAT_PAY_REFUND_NOT_FOUND") throw error; } }
      if (!result) { await tx(state => { const row = state.refunds.find(row => row.id === refundId); row.attemptedAt = time(); }); result = await wechatPay.createRefund({ payment: data.payment, refundNo: data.refund.refundNo, amount: yuan(data.refund.amountFen), reason: data.refund.reason }); }
      return confirmRefund(result);
    } catch (error) { await tx(state => { const row = state.refunds.find(row => row.id === refundId); row.lastError = str(error.code || "REFUND_FAILED"); row.updatedAt = time(); }); throw error; }
  }
  async function executeAdmin(action, input = {}, session = {}) {
    adminAllowed(session, action); const who = actor(session), at = time();
    if (["catalog", "adminCatalog", "syncCatalog"].includes(action)) { const products = await rawCatalog(); return tx(state => ({ items: materialize(state, products), inventory: state.inventory, config: configOf(state) })); }
    if (action === "refreshLogistics") return readLogistics(input, null, session);
    if (action === "retryRefund") { const refund = await tx(state => { const row = state.refunds.find(row => row.id === str(input.refundId)); if (!row) fail("退款不存在"); canScope(ownOrder(state, row.orderId), session); return row; }); return issueRefund(refund.id); }
    let refundToIssue = null;
    const result = await tx(state => {
      if (["config", "readConfig"].includes(action)) return configOf(state);
      if (action === "saveConfig") {
        const old = configOf(state), patch = { ...old };
        for (const key of ["enabled", "wechatReceiptRequired", "enabledProductIds", "allowedProvinces", "carrierOptions", "productPolicies"]) if (input[key] !== undefined) patch[key] = clone(input[key]);
        for (const key of ["paymentMinutes", "afterSaleDays", "returnDays", "maxPendingOrders", "maxLines", "maxQuantity", "queryIntervalMinutes"]) if (input[key] !== undefined) patch[key] = integer(input[key], key, key === "maxQuantity" ? 999 : 365, 1);
        patch.shippingFeeMode = "maximum";
        if (typeof patch.enabled !== "boolean" || !Array.isArray(patch.enabledProductIds) || !Array.isArray(patch.allowedProvinces) || !Array.isArray(patch.carrierOptions)) fail("销售配置格式不合法");
        patch.enabledProductIds = [...new Set(patch.enabledProductIds.map(String))]; patch.carrierOptions = patch.carrierOptions.map(row => ({ code: required(row.code, "快递编码", 60), name: required(row.name, "快递公司", 60) }));
        patch.id = "settings"; patch.version = (old.version || 0) + 1; patch.updatedAt = at; state.config = state.config.filter(row => row.id !== "settings"); state.config.push(patch); audit(state, null, "config", who, at); return patch;
      }
      if (action === "saveProductPolicy") { const cfg = configOf(state), pid = required(input.productId, "商品ID"); cfg.productPolicies ||= {}; cfg.productPolicies[pid] = { saleEnabled: input.saleEnabled === true, fulfillmentMode: input.fulfillmentMode === "custom" ? "custom" : "stock" }; cfg.id = "settings"; cfg.version = (cfg.version || 0) + 1; state.config = state.config.filter(row => row.id !== "settings"); state.config.push(cfg); return cfg.productPolicies[pid]; }
      if (action === "adjustStock") { const stock = state.inventory.find(row => row.skuId === str(input.skuId)); if (!stock) fail("规格库存未初始化"); const delta = Number(input.delta); if (!Number.isSafeInteger(delta) || !delta) fail("库存调整数量不合法"); required(input.reason, "调整原因", 300); if (input.version != null && Number(input.version) !== stock.version) fail("库存已变化，请刷新", "PHYSICAL_CONFLICT", 409); const next = stock.onHand + delta; if (next < stock.reserved || next > 2147483647) fail("库存调整不能低于已预占量或超过上限"); stock.onHand = next; bump(stock, at); audit(state, null, "stock_adjustment", who, at, { skuId: stock.skuId, delta, reason: input.reason }); return stock; }
      if (action === "list" || action === "export") {
        const rows = state.orders.filter(order => { try { canScope(order, session); return true; } catch (_) { return false; } }).filter(row => (!input.status || input.status === "all" || row.status === input.status) && (!input.keyword || [row.orderNo, shipmentFor(state, row)?.trackingNo || "", ...row.items.map(item => item.name)].join(" ").includes(str(input.keyword)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(row => adminOrder(state, row, session));
        if (action === "export") {
          const cell = value => { const raw = str(value); return `"${(/^[=+@-]/.test(raw) ? "'" + raw : raw).replace(/"/g, '""')}"`; };
          const csv = [["订单号", "状态", "商品", "件数", "实收", "退款", "处理人", "物流单号"], ...rows.map(row => [row.orderNo, row.publicStatusText, row.items.map(item => `${item.name} ${item.specLabel || item.spec}`).join("；"), row.items.reduce((n, item) => n + item.quantity, 0), row.paidAt ? row.totalAmount : 0, row.refundedAmount, row.handlerName || "", row.shipment?.trackingNo || ""])].map(row => row.map(cell).join(",")).join("\r\n");
          return { filename: `physical-orders-${at.slice(0, 10)}.csv`, csv: `\uFEFF${csv}`, total: rows.length };
        }
        const data = paginate(rows, input); return { ...data, orders: data.items };
      }
      if (action === "afterSales") { const rows = state.afterSales.filter(row => { try { canScope(ownOrder(state, row.orderId), session); return !input.orderId || input.orderId === row.orderId; } catch (_) { return false; } }); return paginate(rows, input); }
      const order = ownOrder(state, input.orderId || input.id || input.orderNo); canScope(order, session);
      if (action === "detail") return { ...adminOrder(state, order, session), afterSales: state.afterSales.filter(row => row.orderId === order.id), audit: state.audit.filter(row => row.orderId === order.id).map(row => { const clean = { ...row }; delete clean.rawSnapshot; return roleOf(session) === "finance" ? { ...clean, detail: { ...clean.detail, previous: undefined } } : clean; }), shipments: state.shipments.filter(row => row.orderId === order.id).map(publicShipment) };
      if (order.paymentMode === "package" && ["reviewAfterSale", "inspectReturn", "followAfterSale"].includes(action)) fail("套餐内商品售后请通过套餐父订单处理", "PHYSICAL_PACKAGE_PAYMENT_MANAGED", 409);
      if (input.version != null && Number(input.version) !== order.version) fail("订单已更新，请刷新", "PHYSICAL_CONFLICT", 409);
      if (action === "retryLogisticsSubscription") {
        const reason = required(input.reason, "重新订阅原因", 500), shipment = shipmentFor(state, order);
        if (!shipment) fail("当前没有有效去程包裹");
        const task = state.tasks.find(row => row.type === "subscribe" && row.shipmentId === shipment.id && row.version === shipment.version && row.status === "retry");
        if (!task) fail("当前订阅没有可重试的失败任务", "PHYSICAL_STATE", 409);
        if (["shutdown", "subscribed"].includes(shipment.monitorStatus)) fail("当前订阅仍有效或已正常结束，不能重复订阅", "PHYSICAL_SUBSCRIBE_ACTIVE", 409);
        if (task.lastManualRetryAt && Date.parse(at) - Date.parse(task.lastManualRetryAt) < 1800000) fail("同运单人工重订间隔至少30分钟，请等待", "PHYSICAL_SUBSCRIBE_RATE_LIMIT", 429);
        const month = at.slice(0, 7), retriesThisMonth = state.audit.filter(row => row.action === "subscription_manual_retry" && row.detail?.shipmentId === shipment.id && row.at.startsWith(month)).length;
        if (retriesThisMonth >= 3) fail("本月人工重订已达限制，请先与物流平台核对", "PHYSICAL_SUBSCRIBE_RATE_LIMIT", 429);
        task.status = "pending"; task.attempts = 0; task.nextAt = at; task.lastManualRetryAt = at; task.lastManualRetryBy = who;
        audit(state, order, "subscription_manual_retry", who, at, { shipmentId: shipment.id, version: shipment.version, reason });
        return { queued: true, shipmentId: shipment.id, nextAt: at };
      }
      if (action === "ship") {
        if (order.status !== "awaiting_shipment" || frozen(state, order) || shipmentFor(state, order)) fail("订单已发货、冻结或未付款，请刷新", "PHYSICAL_STATE", 409);
        addressInput(order.address || {}, order.openid, at, order.address);
        const companyCode = required(input.carrierCode || input.companyCode, "快递公司", 60), trackingNo = required(input.trackingNo || input.logisticsNo, "物流单号", 64);
        if (!/^[A-Za-z0-9-]{6,32}$/.test(trackingNo)) fail("物流单号格式不正确");
        const carrier = configOf(state).carrierOptions.find(row => row.code === companyCode); if (!carrier) fail("请选择已启用的快递公司");
        if (state.shipments.some(row => row.active && row.carrierCode === companyCode && row.trackingNo === trackingNo)) fail("该物流单号已经用于有效包裹", "PHYSICAL_SHIPMENT_DUPLICATE", 409);
        const shipment = { id: id("shipment"), orderId: order.id, kind: "outbound", active: true, version: (order.shipmentVersion || 0) + 1, carrierCode: companyCode, companyCode, carrierName: carrier.name, trackingNo, phone: order.address.phone, to: [order.address.province, order.address.city, order.address.district].join(""), subscriptionSalt: crypto.randomBytes(24).toString("hex"), logisticsStatus: "awaiting_collection", monitorStatus: "pending", events: [], shippedAt: at, dispatchConfirmedAt: at, handlerId: who, handlerName: str(session.name || session.displayName || session.account || who), items: remainingItems(order).map(row => ({ itemId: row.id, quantity: row.remainingQuantity })) };
        state.shipments.push(shipment); order.shipmentVersion = shipment.version; order.status = "awaiting_receipt"; order.shippedAt = at; order.handlerId = who; order.handlerName = shipment.handlerName; order.handledAt = at; bump(order, at);
        addTask(state, "subscribe", { orderId: order.id, shipmentId: shipment.id, version: shipment.version }, at); if (order.paymentMode !== "package" || paymentFor(state, order)?.externalTransactionId) addTask(state, "wechat_shipping", { orderId: order.id, shipmentId: shipment.id, version: shipment.version }, at); audit(state, order, "dispatch_confirmed", who, at, { shipmentId: shipment.id, version: shipment.version }); return publicOrder(state, order);
      }
      if (action === "withdrawShipment") {
        const shipment = shipmentFor(state, order); if (!shipment || input.packageIntercepted !== true || ["collected", "in_transit", "delivering", "out_for_delivery", "signed"].includes(shipment.logisticsStatus)) fail("须核实包裹仍在本方且已拦下；交运后不能撤销出库");
        required(input.reason, "撤销核实依据", 500); shipment.active = false; shipment.withdrawnAt = at; shipment.withdrawnBy = who; shipment.withdrawReason = str(input.reason); order.status = "awaiting_shipment"; delete order.handlerId; delete order.handlerName; delete order.handledAt; bump(order, at);
        for (const task of state.tasks.filter(row => row.shipmentId === shipment.id && row.status !== "done")) task.status = "cancelled";
        audit(state, order, "dispatch_withdrawn", who, at, { shipmentId: shipment.id, reason: input.reason }); return publicOrder(state, order);
      }
      if (action === "resolveAddressChange") {
        if (!order.addressChange || order.addressChange.status !== "pending") fail("没有待处理改址");
        if (input.approved === true) {
          if (order.status !== "awaiting_shipment" || shipmentFor(state, order)) fail("已出库订单须先核实交接");
          const next = order.addressChange.address, cfg = configOf(state); if (cfg.allowedProvinces.length && !cfg.allowedProvinces.includes(next.province)) fail("新地址不支持配送");
          const previous = clone(order.address); order.address = clone(next); delete order.address.openid; audit(state, order, "address_changed", who, at, { previous, reason: input.reason });
        }
        order.addressChange.status = input.approved === true ? "approved" : "rejected"; order.addressChange.resolvedAt = at; order.addressChange.resolvedBy = who; bump(order, at); return publicOrder(state, order);
      }
      if (["reviewAfterSale", "inspectReturn", "followAfterSale"].includes(action)) {
        const sale = state.afterSales.find(row => row.id === str(input.afterSaleId) && row.orderId === order.id); if (!sale || ["completed", "withdrawn", "rejected"].includes(sale.status)) fail("售后状态已变化");
        if (action === "followAfterSale") { sale.notes ||= []; sale.notes.push({ actor: who, at, note: required(input.note || input.reason, "跟进说明", 1000) }); bump(sale, at); return sale; }
        if (action === "inspectReturn") {
          if (sale.status !== "awaiting_return" || input.received !== true) fail("请核实实际退货及数量");
          required(input.note || input.reason, "退货商品和数量核验记录", 500);
          sale.returnInspected = true; sale.inspectedBy = who; sale.inspectedAt = at; sale.inspectionNote = str(input.note || input.reason); sale.restockAllowed = input.resellable === true; sale.status = "ready_refund"; bump(sale, at); return sale;
        }
        if (input.approved === false) { if (state.refunds.some(row => row.afterSaleId === sale.id)) fail("渠道退款已发起，不能直接驳回解冻"); sale.status = "rejected"; sale.reviewReason = required(input.reason, "审核原因", 500); bump(sale, at); bump(order, at); if (order.pendingReceipt && !frozen(state, order) && order.status === "awaiting_receipt") receipt(state, order, order.pendingReceipt, at); return sale; }
        const existingRefund = state.refunds.find(row => row.afterSaleId === sale.id);
        if (existingRefund) { refundToIssue = existingRefund.id; return sale; }
        const shipment = shipmentFor(state, order);
        if (shipment && sale.status !== "ready_refund") {
          if (input.packageIntercepted === true && input.notHandedOver === true && !["collected", "in_transit", "delivering", "signed"].includes(shipment.logisticsStatus)) fail("请先由主管撤销已核实拦下的出库，再审核退款");
          sale.status = "awaiting_return"; sale.returnAddress = required(input.returnAddress, "退货地址", 500); sale.returnDeadline = new Date(Date.parse(at) + configOf(state).returnDays * 86400000).toISOString(); bump(sale, at); return sale;
        }
        sale.shippingRefundFen = input.shippingRefundAmount == null ? sale.shippingRefundFen || 0 : fen(input.shippingRefundAmount, "退还运费");
        if (sale.shippingRefundFen > order.shippingFeeFen - order.refundedShippingFen) fail("退还运费超过剩余可退金额");
        if (!shipment) sale.restockAllowed = true;
        const payment = paymentFor(state, order); if (!payment || payment.status !== "confirmed") fail("未找到已核实实收流水");
        let refund = state.refunds.find(row => row.afterSaleId === sale.id);
        if (!refund) { const amountFen = sale.amountFen + sale.shippingRefundFen; if (amountFen + order.refundedFen > order.totalAmountFen) fail("退款超过可退金额"); refund = { id: id("refund"), orderId: order.id, afterSaleId: sale.id, paymentId: payment.id, refundNo: `PR${crypto.randomBytes(14).toString("hex")}`, outTradeNo: payment.outTradeNo, transactionId: payment.externalTransactionId, totalFen: payment.amountFen, amountFen, status: "PENDING", reason: sale.reason, createdAt: at }; state.refunds.push(refund); }
        sale.status = "refunding"; sale.reviewedBy = who; sale.reviewedAt = at; bump(sale, at); refundToIssue = refund.id; return sale;
      }
      fail("实物后台操作不存在", "PHYSICAL_NOT_FOUND", 404);
    });
    if (refundToIssue) { try { await issueRefund(refundToIssue); } catch (error) { return { ...result, refundPending: true, message: "退款结果待核实，订单保持冻结", errorCode: error.code }; } }
    return result;
  }
  async function applyLogisticsUpdate(update) {
    if (!update || update.trusted !== true) fail("物流结果尚未验证", "PHYSICAL_LOGISTICS_UNTRUSTED", 401);
    return tx(state => {
      const shipment = state.shipments.find(row => row.id === str(update.shipmentId)); if (!shipment || Number(update.version) !== shipment.version) fail("物流包裹版本不存在", "PHYSICAL_NOT_FOUND", 404);
      if (shipment.carrierCode !== update.company || shipment.trackingNo !== update.number) fail("物流运单不匹配", "PHYSICAL_LOGISTICS_MISMATCH", 409);
      const duplicate = state.audit.some(row => row.action === "logistics_snapshot" && row.detail?.shipmentId === shipment.id && row.detail?.hash === update.snapshotHash);
      if (duplicate) return { accepted: true, duplicate: true };
      audit(state, { id: shipment.orderId }, "logistics_snapshot", "kuaidi100", time(), { shipmentId: shipment.id, hash: update.snapshotHash, version: shipment.version, active: shipment.active });
      state.audit[state.audit.length - 1].rawSnapshot = clone(update.snapshot || {});
      if (!shipment.active) return { accepted: true, archived: true };
      if (update.monitorOnly) { shipment.monitorStatus = update.monitorStatus; shipment.providerMessage = str(update.providerMessage); shipment.lastSyncedAt = time(); return { accepted: true, shipment: publicShipment(shipment) }; }
      const oldTime = shipment.events?.[0]?.time || "", newTime = update.events?.[0]?.time || "";
      // Keep late history but do not regress the current fact on an old poll.
      if (!oldTime || newTime >= oldTime) { shipment.events = clone(update.events || []); shipment.logisticsStatus = update.logisticsStatus; shipment.monitorStatus = update.monitorStatus; }
      shipment.lastSyncedAt = time(); shipment.lastSnapshotHash = update.snapshotHash;
      if (update.collectedAt) shipment.collectedAt ||= update.collectedAt;
      shipment.updatedAt = time(); return { accepted: true, shipment: publicShipment(shipment) };
    });
  }
  async function receiveLogisticsNotification(subscriptionId, body) {
    const match = /^(.*):(\d+)$/.exec(str(subscriptionId)); if (!match) fail("物流订阅标识不合法");
    const shipment = await tx(state => state.shipments.find(row => row.id === match[1] && row.version === Number(match[2])) || null); if (!shipment) fail("物流订阅不存在", "PHYSICAL_NOT_FOUND", 404);
    if (!logistics) fail("物流接口未配置", "PHYSICAL_LOGISTICS_UNAVAILABLE", 503);
    return applyLogisticsUpdate(logistics.parseNotification(body, shipment));
  }
  async function readLogistics(input, openid, session) {
    const at = time();
    const data = await tx(state => {
      const order = ownOrder(state, input.orderId || input.id, openid); if (session) canScope(order, session);
      const shipment = input.shipmentId ? state.shipments.find(row => row.id === str(input.shipmentId) && row.orderId === order.id) : shipmentFor(state, order);
      if (!shipment) return { orderId: order.id, shipment: null, refresh: false };
      const interval = Math.max(30, configOf(state).queryIntervalMinutes) * 60000;
      const refresh = input.refresh === true && (!shipment.lastQueryAttemptAt || Date.parse(at) - Date.parse(shipment.lastQueryAttemptAt) >= interval);
      if (refresh) shipment.lastQueryAttemptAt = at;
      return { orderId: order.id, shipment: clone(shipment), refresh };
    });
    if (data.refresh && logistics?.isConfigured()) {
      try { await applyLogisticsUpdate(await logistics.query(data.shipment)); }
      catch (error) { await tx(state => { const row = state.shipments.find(row => row.id === data.shipment.id); if (row) { row.queryError = str(error.code || "LOGISTICS_UNAVAILABLE"); row.queryFailedAt = at; } }); }
    }
    return tx(state => { const order = ownOrder(state, data.orderId, openid); const shipment = data.shipment ? state.shipments.find(row => row.id === data.shipment.id) : null, projection = shipment ? publicShipment(shipment) : null; return { orderId: order.id, shipment: projection, events: projection?.events || [], status: shipment?.logisticsStatus || "not_shipped" }; });
  }
  async function applyWechatReceipt(update) {
    if (!update || update.received !== true || update.shipmentMatches !== true) return { accepted: false, reason: "unverified_receipt" };
    return tx(state => {
      const order = state.orders.find(row => row.id === str(update.orderId) || row.orderNo === str(update.orderNo)); if (!order) fail("微信收货订单不存在", "PHYSICAL_NOT_FOUND", 404);
      const shipment = shipmentFor(state, order); if (!shipment || update.shipmentId && update.shipmentId !== shipment.id || update.version && Number(update.version) !== shipment.version) { order.receiptConflict = "shipment_mismatch"; return { accepted: false }; }
      order.platformReceipt = { received: true, mode: update.mode || "unknown", confirmedAt: update.confirmedAt || null, observedAt: time() };
      if (["completed", "closed"].includes(order.status)) return { accepted: true, idempotent: true };
      try { return receipt(state, order, { platform: true, mode: update.mode || "unknown", confirmedAt: update.confirmedAt, shipmentVersion: shipment.version }, time()); }
      catch (error) { order.receiptConflict = str(error.code); return { accepted: true, pending: true }; }
    });
  }
  async function processPendingTasks() {
    const at = time(); let handled = 0;
    // Confirmed payment/refund facts remain authoritative after a crash or an
    // upgrade. Package children carry no additional charge and are excluded.
    await tx(state => {
      for (const order of state.orders.filter(row => row.paymentMode !== "package")) {
        if (state.payments.some(row => row.orderId === order.id && row.status === "confirmed" && !row.duplicatePayment)) addTask(state, "merchant_share_payment", { orderId: order.id, version: 1 }, at);
        for (const refund of state.refunds.filter(row => row.orderId === order.id && row.status === "SUCCESS" && !row.duplicatePayment)) addTask(state, "merchant_share_refund", { orderId: order.id, refundId: refund.id, version: refund.id }, at);
      }
    });
    const expired = await tx(state => state.orders.filter(row => row.paymentMode !== "package" && row.status === "pending_payment" && Date.parse(row.expiresAt) <= Date.parse(at)).slice(0, 20).map(row => ({ id: row.id, openid: row.openid })));
    for (const order of expired) { try { await cancelOrder({ orderId: order.id, reason: "timeout" }, order.openid); handled++; } catch (_) {} }
    const pendingRefunds = await tx(state => state.refunds.filter(row => row.status !== "SUCCESS" && row.status !== "CLOSED").slice(0, 10).map(row => row.id));
    for (const refundId of pendingRefunds) { try { await issueRefund(refundId); handled++; } catch (_) {} }
    const tasks = await tx(state => {
      const rows = state.tasks.filter(row => ["pending", "retry"].includes(row.status) && (row.attempts < 8 || row.type.startsWith("merchant_share_")) && (!row.nextAt || row.nextAt <= at))
        .sort((a, b) => Number(a.type.startsWith("merchant_share_")) - Number(b.type.startsWith("merchant_share_"))).slice(0, 20);
      for (const row of rows) { row.status = "running"; row.attempts++; row.leaseUntil = new Date(Date.parse(at) + 60000).toISOString(); }
      for (const row of state.tasks.filter(row => row.status === "running" && row.leaseUntil < at)) { row.status = "retry"; row.nextAt = at; }
      return rows;
    });
    for (const task of tasks) {
      try {
        if (["merchant_share_payment", "merchant_share_refund"].includes(task.type)) {
          const result = await deliverCommissionTask(task);
          await tx(state => { const row = state.tasks.find(value => value.id === task.id);
            if (result?.skipped && result.reason === "SHARE_NOT_ENABLED") { row.status = "pending"; row.attempts = Math.max(0, row.attempts - 1); row.nextAt = new Date(Date.parse(time()) + 60000).toISOString(); }
            else { row.status = "done"; row.completedAt = time(); } });
          handled++; continue;
        }
        const data = await tx(state => {
          const order = ownOrder(state, task.orderId), shipment = state.shipments.find(row => row.id === task.shipmentId), payment = paymentFor(state, order);
          return { order: { ...order, payment }, shipment: shipment || null };
        });
        if (task.type === "late_refund") {
          await tx(state => { if (!state.refunds.some(row => row.orderId === data.order.id)) state.refunds.push({ id: id("refund"), orderId: data.order.id, paymentId: data.order.payment.id, refundNo: `PR${crypto.randomBytes(14).toString("hex")}`, outTradeNo: data.order.payment.outTradeNo, transactionId: data.order.payment.externalTransactionId, totalFen: data.order.totalAmountFen, amountFen: data.order.totalAmountFen, status: "PENDING", latePayment: true, reason: "关闭订单迟到收款补偿", createdAt: time() }); });
        } else if (!data.shipment?.active || data.shipment.version !== task.version) {
          await tx(state => { state.tasks.find(row => row.id === task.id).status = "cancelled"; }); continue;
        } else if (task.type === "subscribe") {
          if (!logistics?.isConfigured()) fail("快递100未配置", "PHYSICAL_LOGISTICS_UNAVAILABLE", 503);
          const result = await logistics.subscribe(data.shipment);
          await tx(state => { const shipment = state.shipments.find(row => row.id === data.shipment.id); if (shipment.active) shipment.monitorStatus = result.status; });
        } else if (task.type === "wechat_shipping") {
          if (!shipping?.isConfigured()) fail("微信发货管理未配置", "PHYSICAL_SHIPPING_UNAVAILABLE", 503);
          const preparedShipment = await tx(state => { const row = state.shipments.find(row => row.id === data.shipment.id); if (!row.active) fail("出库已撤销", "PHYSICAL_SHIPMENT_WITHDRAWN", 409); row.wechatUploadRequestAt ||= time(); return row; });
          const result = await shipping.upload(preparedShipment, data.order);
          await tx(state => { const shipment = state.shipments.find(row => row.id === data.shipment.id); shipment.wechatUploadedAt = result.uploadedAt; shipment.wechatUpload = result; });
        }
        await tx(state => { const row = state.tasks.find(row => row.id === task.id); if (row.status !== "cancelled") { row.status = "done"; row.completedAt = time(); } }); handled++;
      } catch (error) {
        await tx(state => { const row = state.tasks.find(row => row.id === task.id); if (!row || row.status === "cancelled") return; const awaiting = error.code === "WECHAT_SHIPPING_AWAITING_HANDOVER"; row.status = "retry"; if (awaiting) row.attempts = Math.max(0, row.attempts - 1); row.lastError = str(error.code || "PROVIDER_UNAVAILABLE"); row.nextAt = new Date(Date.parse(time()) + (awaiting ? 1800000 : Math.min(3600000, 30000 * 2 ** row.attempts))).toISOString(); });
      }
    }
    if (shipping?.isConfigured()) {
      const receipts = await tx(state => state.orders.filter(row => row.status === "awaiting_receipt").filter(row => !row.lastReceiptQueryAt || Date.parse(at) - Date.parse(row.lastReceiptQueryAt) > 1800000).slice(0, 10).map(order => { order.lastReceiptQueryAt = at; return { order: { ...order, payment: paymentFor(state, order) }, shipment: shipmentFor(state, order) }; }));
      for (const data of receipts) { if (!data.shipment?.wechatUploadedAt) continue; try { const update = await shipping.queryReceipt(data.order, data.shipment); if (update.received) await applyWechatReceipt({ ...update, orderId: data.order.id, shipmentId: data.shipment.id, version: data.shipment.version }); } catch (_) {} }
    }
    return { handled };
  }
  async function guardCatalogMutation(current, patch) {
    const pid = productId(current);
    if (!pid || !["stock", "stockQty", "skus", "specMode"].some(key => Object.prototype.hasOwnProperty.call(patch, key))) return;
    return tx(state => {
      const inventory = state.inventory.filter(row => row.productId === pid); if (!inventory.length) return;
      if (patch.specMode && patch.specMode !== (current.specMode || "single")) fail("交易库存已初始化，不能直接切换规格模式；请新增商品或使用库存调整", "PHYSICAL_STOCK_PROTECTED", 409);
      if (current.specMode === "multiple" && patch.skus) {
        const before = current.skus || [], after = patch.skus;
        if (before.length !== after.length || before.some((row, index) => skuIdentity(current, row) !== skuIdentity(current, after[index] || {}))) fail("已初始化交易库存的规格不可删除、重命名或更改编码", "PHYSICAL_STOCK_PROTECTED", 409);
        if (before.some((row, index) => { const authoritative = inventory.find(stock => stock.skuId === skuIdentity(current, row)); return Number(row.stock) !== Number(after[index].stock) && Number(after[index].stock) !== authoritative?.onHand; })) fail("交易库存请通过专用库存调整操作修改", "PHYSICAL_STOCK_PROTECTED", 409);
      }
      const onHand = inventory.reduce((sum, row) => sum + row.onHand, 0);
      if (["stock", "stockQty"].some(key => Object.prototype.hasOwnProperty.call(patch, key) && Number(patch[key]) !== Number(current[key] ?? current.stock ?? current.stockQty) && Number(patch[key]) !== onHand)) fail("交易库存请通过专用库存调整操作修改", "PHYSICAL_STOCK_PROTECTED", 409);
    });
  }
  async function projectCatalogInventory(rows) {
    return tx(state => (Array.isArray(rows) ? rows : []).map(product => {
      const inventory = state.inventory.filter(row => row.productId === productId(product)); if (!inventory.length) return product;
      const result = { ...product, inventoryManaged: true, stock: inventory.reduce((sum, row) => sum + row.onHand, 0), reservedStock: inventory.reduce((sum, row) => sum + row.reserved, 0) }; result.stockQty = result.stock; result.availableStock = result.stock - result.reservedStock;
      if (product.specMode === "multiple") result.skus = (product.skus || []).map(sku => { const stock = inventory.find(row => row.skuId === skuIdentity(product, sku)); return stock ? { ...sku, stock: stock.onHand, reservedStock: stock.reserved, availableStock: stock.onHand - stock.reserved } : sku; });
      return result;
    }));
  }
  async function guardLegacyAddons(productIds) {
    const wanted = new Set((Array.isArray(productIds) ? productIds : []).map(String));
    if (!wanted.size) return;
    return tx(state => {
      const config = configOf(state);
      for (const pid of wanted) {
        const policy = config.productPolicies?.[pid];
        const standaloneEnabled = config.enabled && (policy?.saleEnabled === true || config.enabledProductIds.includes(pid)) && policy?.fulfillmentMode !== "custom";
        const traded = state.inventory.some(row => row.productId === pid && (Number(row.sold) > 0 || Number(row.reserved) > 0));
        if (standaloneEnabled || traded) fail("该周边商品已启用独立库存交易，请在影像周边单独购买，不能再加入服务预约", "PHYSICAL_LEGACY_ADDON_BLOCKED", 409);
      }
    });
  }
  return { executePublic, executeAdmin, findPayment, findRefund, confirmPayment, confirmRefund, applyLogisticsUpdate, receiveLogisticsNotification, applyWechatReceipt, processPendingTasks, getShareOrder, listShareOrders, getShareRefunds, markShareAttribution, guardCatalogMutation, projectCatalogInventory, guardLegacyAddons, preparePackageFulfillment, reservePackageFulfillment, syncPackageFulfillment, releasePackageFulfillment, packageFulfillmentOrders, store, configure(options = {}) { if (options.wechatPay) wechatPay = options.wechatPay; if (options.logistics) logistics = options.logistics; if (options.shipping) shipping = options.shipping; } };
}
const services = new WeakMap();
function serviceFor(source, options = {}) {
  if (!services.has(source)) services.set(source, createService({ store: options.store || createMysqlStore(source), catalogSource: source, ...options }));
  else services.get(source).configure(options);
  return services.get(source);
}
module.exports = { PUBLIC_ACTIONS, STATUS, DEFAULT_CONFIG, createService, serviceFor, createMemoryStore, skuIdentity };
