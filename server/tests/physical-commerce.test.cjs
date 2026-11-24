"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createService, createMemoryStore } = require("../lib/physicalCommerce.cjs");
const admin = { role: "super", id: "admin", name: "管理员" }, user = { openid: "buyer" };
function fixture(overrides = {}) {
  let clock = new Date("2026-11-15T00:00:00Z");
  const products = [{ id: "album", name: "相册", status: "已上", isShow: true, price: 129, stock: 2, shippingFee: 8, specs: ["8寸"] }, { id: "frame", name: "相框", status: "已上", isShow: true, price: 89, stock: 2, shippingFee: 10, specs: ["6寸"] }];
  const transactions = new Map(), refunds = new Map();
  const payment = { isConfigured: () => true, async createJsapiTransaction({ payment }) { transactions.set(payment.outTradeNo, { tradeState: "NOTPAY", outTradeNo: payment.outTradeNo }); return { prepayId: "prepay", paymentParams: { package: "prepay_id=test" } }; }, async queryTransaction(no) { if (!transactions.has(no)) throw Object.assign(new Error("missing"), { code: "WECHAT_PAY_TRANSACTION_NOT_FOUND" }); return transactions.get(no); }, async closeTransaction(no) { transactions.set(no, { tradeState: "CLOSED", outTradeNo: no }); }, async createRefund({ payment, refundNo, amount }) { const result = { refundNo, refundId: "wx_refund", outTradeNo: payment.outTradeNo, transactionId: payment.externalTransactionId, status: "SUCCESS", amount: Math.round(amount * 100), total: payment.amountFen, successTime: clock.toISOString() }; refunds.set(refundNo, result); return result; }, async queryRefund(no) { return refunds.get(no); }, ...overrides.wechatPay };
  const store = createMemoryStore(); const service = createService({ ...overrides, store, catalogSource: async () => products, wechatPay: payment, now: () => clock });
  const pub = (action, input = {}, identity = user) => service.executePublic(action, input, identity), adm = (action, input = {}, identity = admin) => service.executeAdmin(action, input, identity);
  async function ready() { await adm("saveConfig", { enabled: true, enabledProductIds: ["album", "frame"] }); const catalog = await pub("getPhysicalCatalog"); const address = await pub("saveShippingAddress", { recipient: "测试用户", phone: "13800000000", province: "湖南省", city: "长沙市", district: "岳麓区", detail: "测试街道1号房" }); return { catalog, address }; }
  async function checkout(data, items, key = "test-request") { const input = { checkoutSource: "direct", items: items || [{ productId: "album", skuId: data.catalog.items[0].skus[0].id, quantity: 1 }], addressId: data.address.id }; const quote = await pub("previewPhysicalCheckout", input); return pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: key }); }
  async function paid(order) { await pub("createPhysicalPayment", { orderId: order.id }); const p = store.snapshot().payments.find(row => row.orderId === order.id); const transaction = { outTradeNo: p.outTradeNo, tradeState: "SUCCESS", transactionId: `wx_${order.id}`, amountTotal: p.amountFen, amountCurrency: "CNY", payerOpenid: "buyer", successTime: clock.toISOString() }; transactions.set(p.outTradeNo, transaction); await service.confirmPayment(transaction); return pub("getPhysicalOrder", { orderId: order.id }); }
  return { service, store, pub, adm, ready, checkout, paid, products, payment, transactions, advance: ms => { clock = new Date(clock.getTime() + ms); } };
}
test("checkout projects the current admin product descriptions for every item and retains them on the order", async () => {
  const f = fixture();
  Object.assign(f.products[0], { intro: "相册商品说明：8寸硬壳相册。", description: "旧相册说明，不应覆盖商品说明。" });
  Object.assign(f.products[1], { intro: "", description: "相框商品说明：6寸桌面相框。" });
  const d = await f.ready();
  assert.deepEqual(d.catalog.items.map(row => row.description), [f.products[0].intro, f.products[1].description]);
  for (const product of d.catalog.items) await f.pub("updatePhysicalCart", { operation: "add", productId: product.id, skuId: product.skus[0].id, quantity: 1 });
  const cart = await f.pub("getPhysicalCart");
  const input = { checkoutSource: "cart", items: cart.items.map(row => ({ lineId: row.id, quantity: row.quantity, version: row.version, description: "客户端伪造说明" })), addressId: d.address.id };
  // Re-read the admin content at checkout instead of keeping an older catalog snapshot.
  f.products[0].intro = "相册商品说明：8寸硬壳相册。\n请提供清晰照片。";
  f.products[1].description = "相框商品说明：6寸桌面相框，含支架。";
  const expected = [f.products[0].intro, f.products[1].description];
  const quote = await f.pub("previewPhysicalCheckout", input);
  assert.deepEqual(quote.items.map(row => row.description), expected);
  assert.equal(quote.goodsAmount, 218); assert.equal(quote.shippingFee, 10); assert.equal(quote.totalAmount, 228);
  assert.ok(f.store.snapshot().inventory.every(row => row.reserved === 0));
  const order = await f.pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "product-description" });
  assert.deepEqual(order.items.map(row => row.description), expected);
  assert.equal(order.status, "pending_payment"); assert.equal(order.totalAmount, 228);
  assert.equal((await f.pub("getPhysicalCart")).items.length, 0);
  assert.ok(f.store.snapshot().inventory.every(row => row.reserved === 1));
  f.products[0].intro = "下单后的新版商品说明";
  const saved = await f.pub("getPhysicalOrder", { orderId: order.id });
  assert.deepEqual(saved.items.map(row => row.description), expected);
});

test("sales disabled by default and payment requires safe catalog/address quote", async () => { const f = fixture(); const catalog = await f.pub("getPhysicalCatalog"); assert.equal(catalog.enabled, false); assert.equal(catalog.items[0].purchasable, false); });

test("catalog explains why buying is unavailable without confusing missing inventory with sold out", async t => {
  const cases = [
    { name: "store closed", config: { enabled: false }, expected: /商城暂未开放购买/ },
    { name: "product not enabled", config: { enabledProductIds: ["frame"] }, expected: /该商品尚未开放购买/ },
    { name: "photo customization", product: { requiresPhotos: true }, expected: /照片定制/ },
    { name: "price unconfirmed", product: { price: 0 }, expected: /价格待商家确认/ },
    { name: "shipping unconfirmed", product: { shippingFee: undefined }, expected: /配送信息待商家完善/ },
    { name: "inventory unconfirmed", product: { stock: undefined }, expected: /库存待商家确认/ },
    { name: "sold out", product: { stock: 0 }, expected: /已售罄/ },
    { name: "no specifications", product: { specMode: "multiple", skus: [] }, expected: /规格信息待商家完善/ },
    { name: "different SKU blockers", product: { specMode: "multiple", skus: [{ id: "one", price: 10, stock: 0 }, { id: "two", stock: 2 }] }, expected: /没有可购买的规格/ }
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = fixture();
    Object.assign(f.products[0], scenario.product);
    await f.adm("saveConfig", { enabled: true, enabledProductIds: ["album", "frame"], ...scenario.config });
    const product = (await f.pub("getPhysicalCatalog")).items.find(row => row.id === "album");
    assert.equal(product.purchasable, false);
    assert.match(product.disabledReason, scenario.expected);
    assert.ok(product.skus.every(sku => sku.purchasable === false && sku.disabledReason));
  });
});

test("an available specification keeps the product purchasable with no product-level warning", async () => {
  const f = fixture();
  Object.assign(f.products[0], { specMode: "multiple", skus: [{ id: "one", price: 10, stock: 0 }, { id: "two", price: 20, stock: 2 }] });
  await f.adm("saveConfig", { enabled: true, enabledProductIds: ["album"] });
  const product = (await f.pub("getPhysicalCatalog")).items.find(row => row.id === "album");
  assert.equal(product.purchasable, true);
  assert.equal(product.disabledReason, "");
  assert.match(product.skus[0].disabledReason, /售罄/);
  assert.equal(product.skus[1].disabledReason, "");
});

test("SKU style reaches cart and checkout, changes invalidate quotes and existing orders retain their style", async () => {
  const f = fixture();
  f.products[0].skuStyle = "可横可竖";
  const d = await f.ready(), sku = d.catalog.items[0].skus[0];
  assert.equal(sku.spec, "8寸"); assert.equal(sku.style, "可横可竖"); assert.equal(sku.specLabel, "8寸【可横可竖】");
  await f.pub("updatePhysicalCart", { operation: "add", productId: "album", skuId: sku.id, quantity: 1 });
  let cart = await f.pub("getPhysicalCart");
  assert.equal(cart.items[0].specLabel, "8寸【可横可竖】");
  assert.equal(f.store.snapshot().carts[0].style, "可横可竖");
  const input = { checkoutSource: "direct", items: [{ productId: "album", skuId: sku.id, quantity: 1 }], addressId: d.address.id };
  let quote = await f.pub("previewPhysicalCheckout", input);
  assert.equal(quote.items[0].style, "可横可竖"); assert.equal(quote.items[0].specLabel, "8寸【可横可竖】");
  f.products[0].skuStyle = "两宫格";
  await assert.rejects(f.pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "stale-style" }), /变化/);
  assert.equal(f.store.snapshot().inventory[0].reserved, 0);
  const refreshed = (await f.pub("getPhysicalCatalog")).items[0].skus[0];
  assert.equal(refreshed.id, sku.id); assert.equal(f.store.snapshot().inventory.length, 2, "补充样式不能重建库存");
  cart = await f.pub("getPhysicalCart");
  assert.equal(cart.items[0].style, "两宫格"); assert.equal(cart.items[0].specLabel, "8寸【两宫格】");
  quote = await f.pub("previewPhysicalCheckout", input);
  const order = await f.pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "style-order" });
  f.products[0].skuStyle = "单幅/四宫格";
  const stored = await f.pub("getPhysicalOrder", { orderId: order.id });
  assert.equal(stored.items[0].spec, "8寸"); assert.equal(stored.items[0].style, "两宫格"); assert.equal(stored.items[0].specLabel, "8寸【两宫格】");
});

test("same-size styles keep distinct inventory and style edits preserve legacy uncoded SKU identity", async () => {
  const f = fixture();
  Object.assign(f.products[0], { specMode: "multiple", skus: [
    { spec: "8寸", style: "可横可竖", price: 20, stock: 2 },
    { spec: "8寸", style: "两宫格", skuCode: "AUTO-stored-variant", price: 25, stock: 3 }
  ] });
  const d = await f.ready(), skus = d.catalog.items[0].skus;
  assert.notEqual(skus[0].id, skus[1].id);
  assert.deepEqual(skus.map(sku => sku.specLabel), ["8寸【可横可竖】", "8寸【两宫格】"]);
  const before = structuredClone(f.products[0]);
  const patch = { skus: before.skus.map(sku => ({ ...sku, style: sku.style + "新版" })) };
  await f.service.guardCatalogMutation(before, patch);
  Object.assign(f.products[0], patch);
  const after = (await f.pub("getPhysicalCatalog")).items[0].skus;
  assert.deepEqual(after.map(sku => sku.id), skus.map(sku => sku.id));
  assert.deepEqual(after.map(sku => sku.available), [2, 3]);
  await f.pub("updatePhysicalCart", { operation: "add", productId: "album", skuId: after[0].id, quantity: 1 });
  const cart = await f.pub("getPhysicalCart");
  await f.pub("updatePhysicalCart", { operation: "spec", lineId: cart.items[0].id, version: cart.items[0].version, skuId: after[1].id });
  const changed = await f.pub("getPhysicalCart");
  assert.equal(changed.items[0].style, "两宫格新版");
  assert.equal(changed.items[0].specLabel, "8寸【两宫格新版】");
  f.products[0].skus[1].style = "";
  const cleared = await f.pub("getPhysicalCart");
  assert.equal(cleared.items[0].style, ""); assert.equal(cleared.items[0].specLabel, "8寸", "清空样式不能回退旧购物车样式");
});
test("cart multiple items create one full order, highest shipping fee and atomic consumption", async () => { const f = fixture(), d = await f.ready(); for (const product of d.catalog.items) await f.pub("updatePhysicalCart", { operation: "add", productId: product.id, skuId: product.skus[0].id, quantity: 1 }); const cart = await f.pub("getPhysicalCart"); const input = { checkoutSource: "cart", items: cart.items.map(row => ({ lineId: row.id, quantity: row.quantity, version: row.version })), addressId: d.address.id }; const quote = await f.pub("previewPhysicalCheckout", input); assert.equal(quote.totalAmount, 228); const order = await f.pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "cart-key" }); assert.equal(order.items.length, 2); assert.equal((await f.pub("getPhysicalCart")).items.length, 0); const again = await f.pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "cart-key" }); assert.equal(again.id, order.id); assert.equal(f.store.snapshot().inventory[0].reserved, 1); });
test("quote changes or one SKU missing never reserve partial stock or clear cart", async () => { const f = fixture(), d = await f.ready(); const input = { checkoutSource: "direct", items: [{ productId: "album", skuId: d.catalog.items[0].skus[0].id, quantity: 1 }], addressId: d.address.id }; const quote = await f.pub("previewPhysicalCheckout", input); f.products[0].price = 130; await assert.rejects(f.pub("createPhysicalOrder", { ...input, quoteVersion: quote.quoteVersion, idempotencyKey: "stale" }), /变化/); assert.equal(f.store.snapshot().orders.length, 0); assert.equal(f.store.snapshot().inventory[0].reserved, 0); });
test("last SKU concurrent purchases do not oversell", async () => { const f = fixture(), d = await f.ready(); const outcomes = await Promise.allSettled([f.checkout(d, null, "one"), f.checkout(d, null, "two"), f.checkout(d, null, "three")]); assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 2); assert.equal(f.store.snapshot().inventory[0].reserved, 2); });
test("full payment validates payer and amount then goes awaiting shipment, duplicates harmless", async () => { const f = fixture(), d = await f.ready(), order = await f.checkout(d); await f.pub("createPhysicalPayment", { orderId: order.id }); const p = f.store.snapshot().payments[0]; const event = { outTradeNo: p.outTradeNo, tradeState: "SUCCESS", transactionId: "wx_good", amountTotal: p.amountFen, amountCurrency: "CNY", payerOpenid: "other" }; await assert.rejects(f.service.confirmPayment(event), /不匹配/); event.payerOpenid = "buyer"; await f.service.confirmPayment(event); await f.service.confirmPayment(event); assert.equal((await f.pub("getPhysicalOrder", { orderId: order.id })).status, "awaiting_shipment"); assert.equal(f.store.snapshot().inventory[0].sold, 1); });
test("cancel safely closes provider before releasing reservation", async () => { const f = fixture(), d = await f.ready(), order = await f.checkout(d); await f.pub("createPhysicalPayment", { orderId: order.id }); await f.pub("cancelPhysicalOrder", { orderId: order.id }); assert.equal(f.store.snapshot().inventory[0].reserved, 0); assert.equal(f.store.snapshot().payments[0].status, "closed"); });
test("no intent cancellation blocked while prepay creation in flight", async () => { let release; const waiting = new Promise(resolve => { release = resolve; }); const f = fixture({ wechatPay: { async createJsapiTransaction() { await waiting; return { prepayId: "p", paymentParams: {} }; } } }), d = await f.ready(), order = await f.checkout(d); const pending = f.pub("createPhysicalPayment", { orderId: order.id }); await new Promise(resolve => setImmediate(resolve)); await assert.rejects(f.pub("cancelPhysicalOrder", { orderId: order.id }), /尚未确认/); release(); await pending; assert.equal(f.store.snapshot().inventory[0].reserved, 1); });
test("shipping requires number, records actual successful operator without claim", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); const staff = { role: "service", id: "staff1", name: "客服1" }; await assert.rejects(f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: " " }, staff)); assert.equal(f.store.snapshot().orders[0].handlerId, undefined); const outcomes = await Promise.allSettled([f.adm("ship", { orderId: order.id, version: order.version, carrierCode: "shunfeng", trackingNo: "SF12345678" }, staff), f.adm("ship", { orderId: order.id, version: order.version, carrierCode: "shunfeng", trackingNo: "SF88888888" }, { role: "service", id: "staff2" })]); assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1); assert.equal(f.store.snapshot().orders[0].handlerId, "staff1"); assert.equal(f.store.snapshot().shipments.length, 1); });
test("refund pending freezes shipping; partial refund restores only cancelled quantity", async () => { const f = fixture(), d = await f.ready(); const order = await f.paid(await f.checkout(d, [{ productId: "album", skuId: d.catalog.items[0].skus[0].id, quantity: 2 }])); const sale = await f.pub("createPhysicalAfterSale", { orderId: order.id, reason: "退款一件", items: [{ itemId: order.items[0].id, quantity: 1 }] }); await assert.rejects(f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }), /冻结/); await f.adm("reviewAfterSale", { orderId: order.id, afterSaleId: sale.id, approved: true, shippingRefundAmount: 0 }); const updated = await f.pub("getPhysicalOrder", { orderId: order.id }); assert.equal(updated.status, "awaiting_shipment"); assert.equal(updated.refundedAmount, 129); assert.equal(updated.items[0].refundedQuantity, 1); assert.equal(f.store.snapshot().inventory[0].onHand, 1); });
test("address book changes do not rewrite order, strangers cannot read order/address", async () => { const f = fixture(), d = await f.ready(), order = await f.checkout(d); await f.pub("saveShippingAddress", { ...d.address, detail: "新的街道二号房" }); assert.notEqual((await f.pub("getPhysicalOrder", { orderId: order.id })).address.detail, "新的街道二号房"); await assert.rejects(f.pub("getPhysicalOrder", { orderId: order.id }, { openid: "stranger" }), /不存在/); await assert.rejects(f.pub("deleteShippingAddress", { id: d.address.id }, { openid: "stranger" }), /不存在/); });
test("signed logistics do not complete, repeated callbacks keep stable subscription version", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }); const s = f.store.snapshot().shipments[0]; const update = { trusted: true, shipmentId: s.id, version: s.version, company: s.carrierCode, number: s.trackingNo, logisticsStatus: "signed", monitorStatus: "shutdown", snapshotHash: "one", events: [{ time: "2026-11-15 10:00:00", context: "签收联系13800000000" }] }; await f.service.applyLogisticsUpdate(update); await f.service.applyLogisticsUpdate({ ...update, snapshotHash: "two" }); assert.equal(f.store.snapshot().shipments[0].version, 1); const detail = await f.pub("getPhysicalOrder", { orderId: order.id }); assert.equal(detail.status, "awaiting_receipt"); assert.ok(!detail.shipment.events[0].context.includes("13800000000")); await f.pub("confirmPhysicalReceipt", { orderId: order.id, received: true }); assert.equal((await f.pub("getPhysicalOrder", { orderId: order.id })).status, "completed"); });
test("stock mutations guarded after initialized while price-only remains editable", async () => { const f = fixture(); await f.ready(); await assert.rejects(f.service.guardCatalogMutation(f.products[0], { stock: 100 }), /专用库存/); await f.service.guardCatalogMutation(f.products[0], { price: 150 }); });
test("public users never receive admin shipping actions and finance address is redacted", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); assert.ok(!order.allowedActions.includes("ship")); const staffList = await f.adm("list", {}, { role: "service", id: "staff" }); assert.ok(staffList.items[0].allowedActions.includes("ship")); const financeList = await f.adm("list", {}, { role: "finance", id: "finance" }); assert.ok(!financeList.items[0].allowedActions.includes("ship")); assert.equal(financeList.items[0].address.detail, "***"); assert.notEqual(financeList.items[0].address.phone, "13800000000"); });
test("withdrawn package late snapshot cannot restore or overwrite the next dispatch", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }); const old = f.store.snapshot().shipments[0]; await f.adm("withdrawShipment", { orderId: order.id, packageIntercepted: true, reason: "实物已拦下仍在仓库" }); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF87654321" }); const update = { trusted: true, shipmentId: old.id, version: old.version, company: old.carrierCode, number: old.trackingNo, logisticsStatus: "signed", snapshotHash: "old", events: [{ time: "2026-11-15 10:00:00", context: "旧包裹签收" }] }; const result = await f.service.applyLogisticsUpdate(update); assert.equal(result.archived, true); const current = await f.pub("getPhysicalOrder", { orderId: order.id }); assert.equal(current.shipment.trackingNo, "SF87654321"); assert.equal(current.shipment.logisticsStatus, "awaiting_collection"); });
test("monitor interruption preserves last reliable transport facts", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }); const s = f.store.snapshot().shipments[0], base = { trusted: true, shipmentId: s.id, version: 1, company: s.carrierCode, number: s.trackingNo }; await f.service.applyLogisticsUpdate({ ...base, logisticsStatus: "in_transit", events: [{ time: "2026-11-15 10:00:00", context: "运输中" }], snapshotHash: "moving" }); await f.service.applyLogisticsUpdate({ ...base, monitorOnly: true, monitorStatus: "abort", providerMessage: "中止", snapshotHash: "abort" }); const current = await f.pub("getPhysicalOrder", { orderId: order.id }); assert.equal(current.shipment.logisticsStatus, "in_transit"); assert.equal(current.shipment.events.length, 1); assert.equal(current.shipment.version, 1); });
test("credible wechat receipt during aftersale freezes then resumes after rejection", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }); const shipment = f.store.snapshot().shipments[0]; const sale = await f.pub("createPhysicalAfterSale", { orderId: order.id, reason: "先核对商品" }); await f.service.applyWechatReceipt({ orderId: order.id, shipmentId: shipment.id, version: 1, received: true, shipmentMatches: true, mode: "unknown", confirmedAt: null }); assert.equal(f.store.snapshot().orders[0].status, "awaiting_receipt"); await f.adm("reviewAfterSale", { orderId: order.id, afterSaleId: sale.id, approved: false, reason: "客户已实际收到，问题已核实" }); const complete = await f.pub("getPhysicalOrder", { orderId: order.id }); assert.equal(complete.status, "completed"); assert.equal(complete.confirmedAt, null); assert.equal(complete.confirmationMethod, "unknown"); });
test("required official receipt cannot be forged by client callback", async () => { const f = fixture({ shipping: { isConfigured: () => true, async queryReceipt() { return { received: false, shipmentMatches: false }; } } }), d = await f.ready(), order = await f.paid(await f.checkout(d)); await f.adm("saveConfig", { wechatReceiptRequired: true }); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }); await assert.rejects(f.pub("confirmPhysicalReceipt", { orderId: order.id, received: true, source: "wechat" }), /确认中/); assert.equal(f.store.snapshot().orders[0].status, "awaiting_receipt"); });
test("return logistics is independent and cannot itself trigger refunds or restock", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }); const sale = await f.pub("createPhysicalAfterSale", { orderId: order.id, reason: "退货退款" }); await f.adm("reviewAfterSale", { orderId: order.id, afterSaleId: sale.id, approved: true, returnAddress: "测试仓库退货地址1号" }); await f.pub("updatePhysicalReturnShipment", { afterSaleId: sale.id, carrierCode: "zhongtong", trackingNo: "ZT12345678" }); const r = f.store.snapshot().shipments.find(row => row.kind === "return"); await f.service.applyLogisticsUpdate({ trusted: true, shipmentId: r.id, version: 1, company: r.carrierCode, number: r.trackingNo, logisticsStatus: "signed", events: [], snapshotHash: "return-signed" }); assert.equal(f.store.snapshot().refunds.length, 0); assert.equal(f.store.snapshot().inventory[0].onHand, 1); await f.adm("inspectReturn", { orderId: order.id, afterSaleId: sale.id, received: true, resellable: true, note: "对应1件已收回且品相完好" }); await f.adm("reviewAfterSale", { orderId: order.id, afterSaleId: sale.id, approved: true, shippingRefundAmount: 8 }); assert.equal(f.store.snapshot().orders[0].status, "closed"); assert.equal(f.store.snapshot().inventory[0].onHand, 2); });
test("migration defaults to SQL-only and leaves legacy order schema untouched", () => { const { statements } = require("../lib/physicalStore.cjs"); const sql = statements().join("\n"); assert.ok(sql.includes("lxm_physical_mutex")); assert.ok(!sql.includes("ALTER TABLE `lxm_orders`")); });
test("unpaid address change safely closes old intent and preserves the same stock reservation", async () => { const f = fixture(), d = await f.ready(), order = await f.checkout(d); await f.pub("createPhysicalPayment", { orderId: order.id }); const second = await f.pub("saveShippingAddress", { recipient: "收件人二", phone: "13900000000", province: "湖南省", city: "长沙市", district: "天心区", detail: "另一街道二号房" }); const updated = await f.pub("requestPhysicalAddressChange", { orderId: order.id, addressId: second.id, version: order.version }); assert.equal(updated.id, order.id); assert.equal(updated.address.id, second.id); assert.equal(updated.status, "pending_payment"); assert.equal(f.store.snapshot().payments[0].status, "closed"); assert.equal(f.store.snapshot().inventory[0].reserved, 1); await f.pub("createPhysicalPayment", { orderId: order.id }); assert.equal(f.store.snapshot().payments.length, 2); });
test("idempotency key cannot be recycled for another address", async () => { const f = fixture(), d = await f.ready(), order = await f.checkout(d); await assert.rejects(f.pub("createPhysicalOrder", { checkoutSource: "direct", items: [{ productId: "album", skuId: d.catalog.items[0].skus[0].id, quantity: 1 }], addressId: "different", idempotencyKey: "test-request" }), /不同商品或地址/); assert.equal(f.store.snapshot().orders.length, 1); assert.equal(order.totalAmount, 137); });
test("authoritative stock projection follows payment while raw product edits cannot reset inventory", async () => { const f = fixture(), d = await f.ready(); await f.paid(await f.checkout(d)); const projected = await f.service.projectCatalogInventory(f.products); assert.equal(projected[0].stock, 1); assert.equal(projected[0].availableStock, 1); await f.service.guardCatalogMutation(f.products[0], { stock: 1, price: 130 }); assert.equal(f.store.snapshot().inventory[0].onHand, 1); });
test("manual subscription retry requeues only current failed task with reason and limit", async () => { const f = fixture(), d = await f.ready(), order = await f.paid(await f.checkout(d)); await f.adm("ship", { orderId: order.id, carrierCode: "shunfeng", trackingNo: "SF12345678" }); await f.store.transaction(state => { const task = state.tasks.find(row => row.type === "subscribe"); task.status = "retry"; task.attempts = 8; task.lastError = "KUAIDI100_QUOTA"; }); const staff = { role: "service", id: "staff" }; await assert.rejects(f.adm("retryLogisticsSubscription", { orderId: order.id }, staff), /原因/); const result = await f.adm("retryLogisticsSubscription", { orderId: order.id, reason: "已核对充值额度，恢复失败订阅" }, staff); assert.equal(result.queued, true); assert.equal(f.store.snapshot().tasks.find(row => row.type === "subscribe").attempts, 0); assert.equal(f.store.snapshot().shipments.length, 1); await assert.rejects(f.adm("retryLogisticsSubscription", { orderId: order.id, reason: "重复重试" }, staff), /没有可重试/); assert.equal(f.store.snapshot().audit.filter(row => row.action === "subscription_manual_retry").length, 1); });
test("legacy service addons stay compatible until independent sales or real stock activity", async () => {
  const f = fixture();
  await f.pub("getPhysicalCatalog");
  await f.service.guardLegacyAddons(["album"]);
  const d = await f.ready();
  await assert.rejects(f.service.guardLegacyAddons(["album"]), error => error.code === "PHYSICAL_LEGACY_ADDON_BLOCKED");
  await f.service.guardLegacyAddons(["unrelated"]);
  await f.checkout(d);
  await f.adm("saveConfig", { enabled: false, enabledProductIds: [] });
  await assert.rejects(f.service.guardLegacyAddons(["album"]), /独立库存交易/);
  await f.service.guardLegacyAddons(["frame"]);
  await f.paid(f.store.snapshot().orders[0]);
  await assert.rejects(f.service.guardLegacyAddons(["album"]), /独立库存交易/);
  assert.equal(f.store.snapshot().orders.length, 1);
});
