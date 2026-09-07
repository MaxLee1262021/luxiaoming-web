// 演示模式数据源：直接读取后台现有的 mock 数据（src/mock/business-data.js），
// 通过接口原样吐出。这样现在就能看到"接口连通"的效果，且数据形状与后台完全一致。
// CRUD 在内存中生效（重启后回到文件原始值），仅供演示。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

module.exports = function (root) {
  const mockPath = path.join(root, "src/mock/business-data.js");
  const code = fs.readFileSync(mockPath, "utf8");
  const sandbox = { window: {}, encodeURIComponent, console, Date, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const LXM = sandbox.window.LXM_DATA || {};
  const db = JSON.parse(JSON.stringify(LXM)); // 深拷贝，避免改到源文件
  Object.keys(db).forEach((key) => {
    if (Array.isArray(db[key])) db[key] = db[key].map((row) => row && typeof row === "object" ? { ...row, id: row.id || row._id, _id: row._id || row.id } : row);
  });

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  function genId() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
    // 商家二维码：演示模式生成一张「仿真小程序码」占位 SVG（部署后由云函数生成真实小程序码）
    async generateMerchantCode(body = {}) {
      const shopId = body.shopId || "";
      const placementLabel = (body.placementLabel || "").trim();
      const placementType = ["counter", "table", "menu", "room"].indexOf(body.placementType) > -1 ? body.placementType : "custom";
      if (!shopId) return { success: false, error: "缺少 shopId" };
      if (!placementLabel) return { success: false, error: "缺少位置名称" };
      if (!Array.isArray(db.merchantCodes)) db.merchantCodes = [];
      const exist = db.merchantCodes.find((c) => String(c.shopId || "") === String(shopId) && (c.placementLabel || "").trim() === placementLabel && isActiveMerchantCode(c));
      if (exist) {
        return { success: true, existed: true, codeId: exist._id, scene: exist.scene, placementType: exist.placementType, placementLabel: exist.placementLabel, shopId, shopName: exist.shopName, qrImage: exist.qrImage || "" };
      }
      const codeId = "Q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const scene = "c=" + codeId;
      const shop = (db.shops || []).find((s) => s.shopId === shopId || s.id === shopId);
      const shopName = (shop && shop.name) || "";
      const qrImage = buildDemoQr(shopName, placementLabel, codeId);
      const doc = { _id: codeId, shopId, shopName, placementType, placementLabel, scene, scanCount: 0, orderCount: 0, dealCount: 0, qrImage, status: "active", createTime: new Date().toISOString() };
      db.merchantCodes.unshift(doc);
      return { success: true, existed: false, codeId, scene, placementType, placementLabel, shopId, shopName, qrImage };
    },
    async listMerchantCodes(shopId = "") {
      const list = Array.isArray(db.merchantCodes) ? db.merchantCodes.filter((c) => isActiveMerchantCode(c)) : [];
      const filtered = shopId ? list.filter((c) => String(c.shopId || "") === String(shopId)) : list;
      // 实时统计：订单关联交易码则计入 orderCount / dealCount
      return filtered.map((c) => {
        const orders = (db.orders || []).filter((o) => !o.deleted && (o.sourceCodeId === c._id || (o.source && o.source.codeId === c._id)));
        const deals = orders.filter((o) => o.status === "completed" || o.status === "final_pending" || o.status === "delivered" || o.customerStatus === "已完成");
        return { ...clone(c), orderCount: orders.length, dealCount: deals.length };
      });
    },
    async merchantCodeStats(shopId = "") {
      const codes = await this.listMerchantCodes(shopId);
      return {
        scans: codes.reduce((s, c) => s + (Number(c.scanCount) || 0), 0),
        orders: codes.reduce((s, c) => s + (Number(c.orderCount) || 0), 0),
        deals: codes.reduce((s, c) => s + (Number(c.dealCount) || 0), 0),
        codeCount: codes.length
      };
    },
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
  const orders = db.orders || db.bookings || [];
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
  const orders = db.orders || db.bookings || [];
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
function buildDemoQr(shopName, placementLabel, codeId) {
  const size = 420;
  const n = 21; // 21x21 网格
  const cell = size / n;
  let seed = 0;
  for (let i = 0; i < codeId.length; i++) seed = (seed * 31 + codeId.charCodeAt(i)) >>> 0;
  // 简单可复现伪随机
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const isFinder = (r, c) => {
    const inBox = (br, bc) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
    return inBox(0, 0) || inBox(0, n - 7) || inBox(n - 7, 0);
  };
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (isFinder(r, c)) continue;
      if (rand() > 0.5) {
        rects += `<rect x="${(c * cell).toFixed(1)}" y="${(r * cell).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" />`;
      }
    }
  }
  const finder = (x, y) =>
    `<rect x="${x}" y="${y}" width="${(7 * cell).toFixed(1)}" height="${(7 * cell).toFixed(1)}" fill="#2A211B"/>` +
    `<rect x="${(x + cell).toFixed(1)}" y="${(y + cell).toFixed(1)}" width="${(5 * cell).toFixed(1)}" height="${(5 * cell).toFixed(1)}" fill="#fff"/>` +
    `<rect x="${(x + 2 * cell).toFixed(1)}" y="${(y + 2 * cell).toFixed(1)}" width="${(3 * cell).toFixed(1)}" height="${(3 * cell).toFixed(1)}" fill="#2A211B"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<g fill="#2A211B">${rects}</g>` +
    finder(0, 0) + finder((n - 7) * cell, 0) + finder(0, (n - 7) * cell) +
    `<circle cx="${size / 2}" cy="${size / 2}" r="34" fill="#EE2C2C"/>` +
    `<text x="${size / 2}" y="${size / 2 + 7}" font-size="26" fill="#fff" text-anchor="middle" font-family="Microsoft YaHei,Arial">鹿</text>` +
    `</svg>`;
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120"><rect width="420" height="120" fill="#FFFDF9"/><text x="210" y="46" font-size="26" fill="#2A211B" text-anchor="middle" font-family="Microsoft YaHei,Arial">${escapeXml(shopName || "鹿小鸣")} · ${escapeXml(placementLabel || "")}</text><text x="210" y="86" font-size="16" fill="#9C877A" text-anchor="middle" font-family="Microsoft YaHei,Arial">演示码（部署后生成真实小程序码）</text></svg>`;
  // 合并：上码下图
  const combined =
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="540"><rect width="420" height="540" fill="#FFFDF9"/>` +
    `<g transform="translate(0,0)">${svg.replace(/<\/?svg[^>]*>/g, "")}</g>` +
    `<g transform="translate(0,420)">${label.replace(/<\/?svg[^>]*>/g, "")}</g></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(combined);
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));
}
