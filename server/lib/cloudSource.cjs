// 真实云模式数据源：通过腾讯云开发 Node SDK 读写小程序同一个云环境。
// 仅在「服务器设置了云环境密钥」时才会被启用，且 @cloudbase/node-sdk 采用懒加载，
// 因此演示模式（无密钥）即使没装这个包也能正常运行。
// 部署到轻量服务器时：npm i @cloudbase/node-sdk，并设置下方三个环境变量。
const map = require("./map.cjs");

function safeCloudError() { return "云数据服务暂不可用，请稍后重试"; }

module.exports = function (cfg) {
  let app = null;
  function getApp() {
    if (app) return app;
    // 懒加载，避免演示模式缺包时报错
    const { init } = require("@cloudbase/node-sdk");
    app = init({
      env: cfg.envId,
      secretId: cfg.secretId,
      secretKey: cfg.secretKey
    });
    return app;
  }
  function realName(key) {
    return map[key] || key;
  }
  let _cmd = null;
  function cmd() {
    if (_cmd) return _cmd;
    _cmd = getApp().database().command;
    return _cmd;
  }
  async function coll(key) {
    const tcb = getApp();
    return tcb.database().collection(realName(key));
  }

  return {
    mode: "cloud",
    async list(key) {
      const c = await coll(key);
      const r = await c.limit(1000).get();
      return r.data || [];
    },
    async get(key, id) {
      const c = await coll(key);
      const r = await c.doc(id).get();
      return (r.data && r.data[0]) || null;
    },
    async create(key, doc) {
      const c = await coll(key);
      const res = await c.add(doc);
      return { ...doc, _id: res.id || res._id };
    },
    async update(key, id, patch) {
      const c = await coll(key);
      const safePatch = { ...(patch || {}) };
      delete safePatch._id;
      delete safePatch.id;
      await c.doc(id).update(safePatch);
      const latest = await c.doc(id).get();
      return { ...((latest.data && latest.data[0]) || {}), ...safePatch, _id: id };
    },
    async remove(key, id) {
      const c = await coll(key);
      await c.doc(id).remove();
      return true;
    },
    // 有则更新、无则创建（.set 覆盖写，可重复执行）。用于 config/homeStats 这类"按固定 id 存的配置文档"。
    async upsert(key, id, patch) {
      const c = await coll(key);
      let previous = { data: [] };
      try { previous = await c.doc(id).get(); }
      catch (error) {
        const message = String(error && (error.message || error.errMsg) || "");
        if (!/not.?found|不存在|404/i.test(message)) throw error;
      }
      const merged = { ...((previous.data && previous.data[0]) || {}), ...(patch || {}) };
      delete merged._id;
      await c.doc(id).set(merged);
      return { ...merged, _id: id };
    },
    async dashboard() {
      try {
        const tcb = getApp();
        const r = await tcb.callFunction({ name: "getDashboard" });
        return r.result;
      } catch (e) {
        return { error: safeCloudError() };
      }
    },
    async orderStats() {
      try {
        const tcb = getApp();
        const r = await tcb.callFunction({ name: "getOrderStatusCount" });
        return r.result;
      } catch (e) {
        return { error: safeCloudError() };
      }
    },
    async homeData() {
      try {
        const tcb = getApp();
        const r = await tcb.callFunction({ name: "getHomeData" });
        return r.result;
      } catch (e) {
        return { error: safeCloudError() };
      }
    },
    // 商家二维码：调用小程序云函数生成小程序码并落库
    async generateMerchantCode(body = {}) {
      try {
        const tcb = getApp();
        const r = await tcb.callFunction({ name: "generateMerchantQR", data: body });
        return r.result;
      } catch (e) {
        return { success: false, error: safeCloudError() };
      }
    },
    async listMerchantCodes(shopId = "") {
      try {
        const c = await coll("merchantCodes");
        const cond = shopId ? { shopId, isDeleted: cmd().neq(true), deleted: cmd().neq(true) } : { isDeleted: cmd().neq(true), deleted: cmd().neq(true) };
        const r = await c.where(cond).limit(1000).get();
        return r.data || [];
      } catch (e) {
        return [];
      }
    },
    async merchantCodeStats(shopId = "") {
      try {
        const c = await coll("merchantCodes");
        const cond = shopId ? { shopId, isDeleted: cmd().neq(true), deleted: cmd().neq(true) } : { isDeleted: cmd().neq(true), deleted: cmd().neq(true) };
        const codes = (await c.where(cond).limit(1000).get()).data || [];
        const scans = codes.reduce((s, x) => s + (Number(x.scanCount) || 0), 0);
        const orders = codes.reduce((s, x) => s + (Number(x.orderCount) || 0), 0);
        const deals = codes.reduce((s, x) => s + (Number(x.dealCount) || 0), 0);
        return { scans, orders, deals, codeCount: codes.length };
      } catch (e) {
        return { scans: 0, orders: 0, deals: 0, codeCount: 0 };
      }
    },
    async health() {
      try {
        const c = await coll("cities");
        await c.limit(1).get();
        return { backend: "cloud", configured: true, ready: true, persistent: true };
      } catch (e) {
        return { backend: "cloud", configured: true, ready: false, persistent: true, error: "unavailable" };
      }
    },
    async close() {}
  };
};
