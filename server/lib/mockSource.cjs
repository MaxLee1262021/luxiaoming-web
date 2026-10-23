// 演示模式数据源：直接读取后台现有的 mock 数据（src/mock/business-data.js），
// 通过接口原样吐出。这样现在就能看到"接口连通"的效果，且数据形状与后台完全一致。
// CRUD 在内存中生效（重启后回到文件原始值），仅供演示。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const merchantCodes = require("./merchantCodes.cjs");
const { isUnpaidBooking } = require("./orderWorkflow.cjs");

module.exports = function (root) {
  const mockPath = path.join(root, "src/mock/business-data.js");
  const code = fs.readFileSync(mockPath, "utf8");
  const sandbox = { window: {}, encodeURIComponent, console, Date, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const LXM = sandbox.window.LXM_DATA || {};
  const db = JSON.parse(JSON.stringify(LXM)); // 深拷贝，避免改到源文件
  const favorites = new Map();
  Object.keys(db).forEach((key) => {
    if (Array.isArray(db[key])) db[key] = db[key].map((row) => row && typeof row === "object" ? { ...row, id: row.id || row._id, _id: row._id || row.id } : row);
  });

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  function genId() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function favoriteKey(openid, type, itemId) { return `${String(openid || "")}\u0000${String(type || "")}\u0000${String(itemId || "")}`; }
  function favoriteRow(openid, input = {}, existing = null) {
    const type = String(input.type || "");
    const itemId = String(input.itemId || input.id || "");
    const createdAt = existing && existing.createdAt || input.createdAt || new Date().toISOString();
    return {
      key: favoriteKey(openid, type, itemId), openid: String(openid || ""), type, itemId,
      snapshot: input.snapshot && typeof input.snapshot === "object" ? clone(input.snapshot) : {},
      createdAt, updatedAt: new Date().toISOString()
    };
  }

  return {
    mode: "mock",
    async list(key) {
      return clone(db[key]);
    },
    async get(key, id) {
      const coll = db[key];
      if (Array.isArray(coll)) return clone(coll.find((x) => x && String(x.id || x._id) === String(id)) || null);
      if (coll && typeof coll === "object") return clone(coll[id] || null);
      return null;
    },
    // 按固定 id 存取的配置文档（如首页装修 homeStats）：mock 模式下落到 db[key][id] 对象里
    async upsert(key, id, patch) {
      if (!db[key] || Array.isArray(db[key])) db[key] = {};
      db[key][id] = patch;
      return clone(db[key][id]);
    },
    async create(key, doc) {
      const item = { ...doc, id: doc.id || genId() };
      if (Array.isArray(db[key])) db[key].unshift(item);
      else db[key] = [item];
      return clone(item);
    },
    async update(key, id, patch) {
      const arr = db[key];
      if (Array.isArray(arr)) {
        const i = arr.findIndex((x) => x && String(x.id || x._id) === String(id));
        if (i >= 0) {
          arr[i] = { ...arr[i], ...patch, id };
          return clone(arr[i]);
        }
      }
      return null;
    },
    async remove(key, id) {
      const arr = db[key];
      if (Array.isArray(arr)) {
        db[key] = arr.filter((x) => !(x && String(x.id || x._id) === String(id)));
        return true;
      }
      return false;
    },
    async object(key) {
      return clone(db[key]);
    },
    async listFavorites(openid, options = {}) {
      const type = String(options.type || "");
      const rows = [...favorites.values()].filter((row) => row.openid === String(openid || "") && (!type || row.type === type)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(clone);
      const offset = Math.max(Number(options.offset || 0), 0);
      const limit = Math.min(Math.max(Number(options.limit || 100), 1), 200);
      return rows.slice(offset, offset + limit);
    },
    async getFavorite(openid, type, itemId) { return clone(favorites.get(favoriteKey(openid, type, itemId)) || null); },
    async upsertFavorite(openid, input = {}) {
      const key = favoriteKey(openid, input.type, input.itemId || input.id);
      const row = favoriteRow(openid, input, favorites.get(key));
      favorites.set(key, row);
      return clone(row);
    },
    async removeFavorite(openid, type, itemId) { return favorites.delete(favoriteKey(openid, type, itemId)); },
    async generateMerchantCode(body = {}) { return merchantCodes.generateMerchantCode(this, body); },
    async listMerchantCodes(shopId = "") { return merchantCodes.listMerchantCodes(this, shopId); },
    async merchantCodeStats(shopId = "", date) { return merchantCodes.merchantCodeStats(this, shopId, date); },
    async dashboard() {
      return computeDashboard(db);
    },
    async orderStats() {
      return computeOrderStats(db);
    },
    async homeData() {
      // 优先返回真正保存过的首页装修文档（mock 模式落到 homeConfig.homeStats / config.homeStats）
      return clone(
        (db.homeConfig && db.homeConfig.homeStats) ||
        (db.config && db.config.homeStats) ||
        {}
      );
    }
  };
};

function computeDashboard(db) {
  const orders = (db.orders || db.bookings || []).filter((row) => !isUnpaidBooking(row));
  const byStatus = {};
  orders.forEach((o) => {
    const s = o.status || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  return {
    spots: (db.spots || []).length,
    albums: (db.albums || []).length,
    series: (db.series || []).length,
    orders: orders.length,
    byStatus
  };
}

function computeOrderStats(db) {
  const orders = (db.orders || db.bookings || []).filter((row) => !isUnpaidBooking(row));
  const byStatus = {};
  orders.forEach((o) => {
    const s = o.status || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  return byStatus;
}

function isActiveMerchantCode(code) {
  return !!code && code.isDeleted !== true && code.deleted !== true
    && !["disabled", "inactive", "expired", "停用", "失效", "已失效", "下架", "已下架"].includes(String(code.status || "").trim().toLowerCase());
}

// 演示模式：生成一张「仿真小程序码」占位图（SVG data URI）。
// 真实部署时由小程序云函数 generateMerchantQR 生成可扫描的小程序码，这里仅用于后台预览。
