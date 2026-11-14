"use strict";

// Explicit Node preloader for api-smoke.cjs only. This file and every synthetic
// adapter are excluded from deployment archives and static HTTP delivery.
if (process.env.DATA_MODE !== "mysql") {
  const path = require("node:path");
  const root = path.resolve(process.env.LXM_SMOKE_ROOT || path.join(__dirname, "../../.."));
  const source = require("./jsonSource.cjs")({ jsonFile: process.env.DB_FILE });
  const selectPath = require.resolve(path.join(root, "server/lib/selectSource.cjs"));
  require(selectPath);
  require.cache[selectPath].exports = () => ({ source, mode: "json", status: { configured: true, ready: true, persistent: true } });

  const permissionPath = require.resolve(path.join(root, "server/lib/permissionStore.cjs"));
  const permissionStore = require(permissionPath);
  const fixturePermissionStore = require("./jsonPermissionStore.cjs");
  require.cache[permissionPath].exports = Object.assign((options) => fixturePermissionStore({ ...options, backend: "json", jsonFile: process.env.DB_FILE }), permissionStore);

  const paymentPath = require.resolve(path.join(root, "server/lib/wechatPay.cjs"));
  const payment = require(paymentPath);
  const { createTestWechatPay, confirmTestPayment } = require("../helpers/wechatPay.cjs");
  require.cache[paymentPath].exports = { ...payment, createWechatPay: createTestWechatPay };

  const apiPath = require.resolve(path.join(root, "server/lib/api.cjs"));
  const createApi = require(apiPath);
  require.cache[apiPath].exports = (dataSource, mode, options) => {
    // This read-only synthetic ledger exercises the real service owner scoping
    // and response whitelist without adding a runtime JSON storage fallback.
    const shareStore = {
      getMerchant: async id => { const row = await dataSource.get("shops", id); return row ? { ...row, merchantId: String(id) } : null; },
      getRules: async () => [{ ratioT1: "0.0500", ratioT2: "0.0300", ttlHours: 720, refundWindowDays: 3, versionNo: 1 }],
      getMerchantStats: async id => ({ boundUsers: 1, accT1Amount: "5.00", accT2Amount: "0.00", monthOrders: (await dataSource.list("orders")).filter(row => row.shopId === id).length }),
      listDetails: async filter => {
        const selected = (await dataSource.list("orders")).filter(row => row.shopId === filter.merchantId);
        const list = selected.map(row => ({ ...row, detailNo: `SHR-${row.id}`, orderNo: row.orderNo || row.id, splitType: "T1", ratio: "0.0500", amount: "5.00", direction: 1,
          display: { ...row, customer: row.customer || "Synthetic User", productName: row.packageName || "Synthetic Package", orderNo: row.orderNo || row.id, paidAmount: "100.00" } }));
        return { list, total: list.length, sum: { positiveAmount: "5.00", reverseAmount: "0.00", netAmount: "5.00" } };
      },
    };
    const handler = createApi(dataSource, mode, { ...options, shareOptions: { store: shareStore } });
    return async (req, res, pathname) => {
      if (pathname !== "/api/__fixture__/payment-confirmed") return handler(req, res, pathname);
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const identity = await options.auth.getSession(token);
      if (!identity || identity.kind !== "public") { res.statusCode = 401; return res.end(JSON.stringify({ success: false })); }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = await confirmTestPayment(dataSource, body, { identity });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    };
  };
}
