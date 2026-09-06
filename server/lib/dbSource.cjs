// 自托管数据源：
//   backend="json"  （默认，开发/测试）数据存在服务器本地文件 server/data/db.json，零依赖、零安装。
//   backend="mysql" （生产，宝塔装好 MySQL 后）连你自己的 MySQL，代码不变，只改环境变量。
// 对外接口与 mockSource / cloudSource 完全一致（list/get/create/update/remove/upsert/dashboard/...），
// 因此后台与小程序可无缝切换数据层，业务代码无需改动。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ALL_KEYS = [
  "cities", "agents", "distributors", "shops", "staff", "spots", "series",
  "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary",
  "guides", "stories", "scans", "orders", "afterSales", "reconciliationTransfers",
  "financeSettings", "monthlyClosings", "adjustmentRecords", "homeConfig", "logs", "trash",
  "merchantCodes", "siteConfig", "userProfiles"
];

module.exports = function (cfg = {}) {
  const backend = cfg.backend || "json";
  const base = backend === "mysql" ? makeMysql(cfg) : makeJson(cfg);
  return withComputed(base);
};

module.exports.ALL_KEYS = ALL_KEYS;

/* ---------------------- JSON 文件后端（开发/测试默认） ---------------------- */
function makeJson(cfg) {
  const dataFile = cfg.jsonFile || path.join(__dirname, "..", "data", "db.json");
  let mem = null;
  function load() {
    if (mem) return mem;
    try { mem = JSON.parse(fs.readFileSync(dataFile, "utf8")); }
    catch { mem = { collections: {} }; }
    if (!mem.collections) mem.collections = {};
    return mem;
  }
  function persist() {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(mem, null, 2));
  }
  function col(key) {
    const m = load();
    if (!m.collections[key]) m.collections[key] = {};
    return m.collections[key];
  }
  function genId(key) {
    return (key || "x").slice(0, 2) + "_" + crypto.randomBytes(6).toString("hex");
  }
  return {
    mode: "json",
    async list(key) { return Object.values(col(key)); },
    async get(key, id) { const d = col(key)[id]; return d ? { ...d, id, _id: id } : null; },
    async create(key, doc) {
      const id = doc.id || doc._id || genId(key);
      const item = { ...doc, id, _id: id };
      col(key)[id] = item; persist(); return item;
    },
    async update(key, id, patch) {
      const c = col(key);
      if (!c[id]) return null;
      c[id] = { ...c[id], ...patch, id, _id: id };
      persist(); return c[id];
    },
    async remove(key, id) { const c = col(key); if (!(id in c)) return false; delete c[id]; persist(); return true; },
    async upsert(key, id, patch) {
      const c = col(key);
      c[id] = { ...(c[id] || {}), ...patch, id, _id: id };
      persist(); return c[id];
    },
    async object(key) { return col(key); }
  };
}

/* ---------------------- MySQL 后端（生产，宝塔装的 MySQL） ---------------------- */
function makeMysql(cfg) {
  const mysql = require("mysql2/promise");
  const pool = mysql.createPool({
    host: cfg.dbHost, user: cfg.dbUser, password: cfg.dbPassword,
    database: cfg.dbName, waitForConnections: true, connectionLimit: 10
  });
  const table = (key) => "lxm_" + key;
  async function q(sql, p = []) { const [rows] = await pool.query(sql, p); return rows; }
  async function run(sql, p = []) { const [r] = await pool.query(sql, p); return r; }
  let ensured = false;
  async function ensure() {
    if (ensured) return; ensured = true;
    for (const key of ALL_KEYS) {
      await run(`CREATE TABLE IF NOT EXISTS \`${table(key)}\` (id VARCHAR(64) PRIMARY KEY, doc MEDIUMTEXT)`);
    }
  }
  function hydrate(r) { const d = JSON.parse(r.doc); return { ...d, id: r.id, _id: r.id }; }
  function strip(doc) { const { id, _id, ...rest } = doc; return rest; }
  return {
    mode: "mysql",
    async list(key) { await ensure(); const rows = await q(`SELECT id,doc FROM \`${table(key)}\``); return rows.map(hydrate); },
    async get(key, id) { await ensure(); const rows = await q(`SELECT doc FROM \`${table(key)}\` WHERE id=?`, [id]); return rows.length ? hydrate(rows[0]) : null; },
    async create(key, doc) {
      await ensure();
      const id = doc.id || doc._id || (key.slice(0, 2) + "_" + crypto.randomBytes(6).toString("hex"));
      const item = { ...doc, id, _id: id };
      await run(`INSERT INTO \`${table(key)}\` (id,doc) VALUES (?,?) ON DUPLICATE KEY UPDATE doc=VALUES(doc)`, [id, JSON.stringify(strip(item))]);
      return item;
    },
    async update(key, id, patch) {
      await ensure();
      const cur = await this.get(key, id); if (!cur) return null;
      const next = { ...cur, ...patch, id, _id: id };
      await run(`UPDATE \`${table(key)}\` SET doc=? WHERE id=?`, [JSON.stringify(strip(next)), id]);
      return next;
    },
    async remove(key, id) { await ensure(); await run(`DELETE FROM \`${table(key)}\` WHERE id=?`, [id]); return true; },
    async upsert(key, id, patch) {
      await ensure();
      const cur = await this.get(key, id);
      const next = cur ? { ...cur, ...patch, id, _id: id } : { ...patch, id, _id: id };
      await run(`INSERT INTO \`${table(key)}\` (id,doc) VALUES (?,?) ON DUPLICATE KEY UPDATE doc=VALUES(doc)`, [id, JSON.stringify(strip(next))]);
      return next;
    },
    async object() { return null; }
  };
}

/* ---------------------- 统一计算层（看板 / 订单统计 / 首页 / 商家码） ---------------------- */
function withComputed(base) {
  return Object.assign({}, base, {
    async snapshot() {
      const out = {};
      for (const k of ["orders", "shops", "merchantCodes", "spots", "albums", "series", "packages", "peripherals", "afterSales"]) {
        try { out[k] = await base.list(k); } catch { out[k] = []; }
      }
      return out;
    },
    async dashboard() { const db = await this.snapshot(); return computeDashboard(db); },
    async orderStats() { const db = await this.snapshot(); return computeOrderStats(db); },
    async homeData() {
      const doc = (await base.get("homeConfig", "homeStats")) || (await base.get("config", "homeStats")) || {};
      const db = await this.snapshot();
      return { ...doc, stats: computeDashboard(db) };
    },
    async generateMerchantCode(body = {}) { return generateMerchantCode(base, body); },
    async listMerchantCodes(shopId = "") { return listMerchantCodes(base, shopId); },
    async merchantCodeStats(shopId = "") {
      const codes = await listMerchantCodes(base, shopId);
      return {
        scans: codes.reduce((s, c) => s + (Number(c.scanCount) || 0), 0),
        orders: codes.reduce((s, c) => s + (Number(c.orderCount) || 0), 0),
        deals: codes.reduce((s, c) => s + (Number(c.dealCount) || 0), 0),
        codeCount: codes.length
      };
    }
  });
}

function computeDashboard(db) {
  const orders = db.orders || [];
  const byStatus = {};
  orders.forEach((o) => { const s = o.status || "unknown"; byStatus[s] = (byStatus[s] || 0) + 1; });
  return {
    spots: (db.spots || []).length,
    albums: (db.albums || []).length,
    series: (db.series || []).length,
    orders: orders.length,
    byStatus
  };
}
function computeOrderStats(db) {
  const orders = db.orders || [];
  const byStatus = {};
  orders.forEach((o) => { const s = o.status || "unknown"; byStatus[s] = (byStatus[s] || 0) + 1; });
  return byStatus;
}

async function listMerchantCodes(base, shopId) {
  const list = (await base.list("merchantCodes")).filter((c) => !c.isDeleted);
  const filtered = shopId ? list.filter((c) => c.shopId === shopId) : list;
  const orders = await base.list("orders");
  return filtered.map((c) => {
    const os = orders.filter((o) => !o.deleted && (o.sourceCodeId === c._id || (o.source && o.source.codeId === c._id)));
    const deals = os.filter((o) => ["completed", "final_pending", "delivered"].includes(o.status) || o.customerStatus === "已完成");
    return { ...c, orderCount: os.length, dealCount: deals.length };
  });
}
async function generateMerchantCode(base, body = {}) {
  const shopId = body.shopId || "";
  const placementLabel = (body.placementLabel || "").trim();
  const placementType = ["counter", "table", "menu", "room"].includes(body.placementType) ? body.placementType : "custom";
  if (!shopId) return { success: false, error: "缺少 shopId" };
  if (!placementLabel) return { success: false, error: "缺少位置名称" };
  const codes = await base.list("merchantCodes");
  const exist = codes.find((c) => c.shopId === shopId && (c.placementLabel || "").trim() === placementLabel && !c.isDeleted);
  if (exist) return { success: true, existed: true, codeId: exist._id, scene: exist.scene, placementType: exist.placementType, placementLabel: exist.placementLabel, shopId, shopName: exist.shopName, qrImage: exist.qrImage || "" };
  const codeId = "Q" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const scene = "c=" + codeId;
  const shops = await base.list("shops");
  const shop = shops.find((s) => s.shopId === shopId || s.id === shopId);
  const shopName = (shop && shop.name) || "";
  const qrImage = buildDemoQr(shopName, placementLabel, codeId);
  const doc = { _id: codeId, shopId, shopName, placementType, placementLabel, scene, scanCount: 0, orderCount: 0, dealCount: 0, qrImage, status: "active", createTime: new Date().toISOString() };
  await base.create("merchantCodes", doc);
  return { success: true, existed: false, codeId, scene, placementType, placementLabel, shopId, shopName, qrImage };
}

// 演示模式：生成一张「仿真小程序码」占位图（SVG data URI）。正式部署后可换成真实小程序码生成。
function buildDemoQr(shopName, placementLabel, codeId) {
  const size = 420, n = 21, cell = size / n;
  let seed = 0;
  for (let i = 0; i < codeId.length; i++) seed = (seed * 31 + codeId.charCodeAt(i)) >>> 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const isFinder = (r, c) => {
    const inBox = (br, bc) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
    return inBox(0, 0) || inBox(0, n - 7) || inBox(n - 7, 0);
  };
  let rects = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (isFinder(r, c)) continue;
    if (rand() > 0.5) rects += `<rect x="${(c * cell).toFixed(1)}" y="${(r * cell).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" />`;
  }
  const finder = (x, y) =>
    `<rect x="${x}" y="${y}" width="${(7 * cell).toFixed(1)}" height="${(7 * cell).toFixed(1)}" fill="#2A211B"/>` +
    `<rect x="${(x + cell).toFixed(1)}" y="${(y + cell).toFixed(1)}" width="${(5 * cell).toFixed(1)}" height="${(5 * cell).toFixed(1)}" fill="#fff"/>` +
    `<rect x="${(x + 2 * cell).toFixed(1)}" y="${(y + 2 * cell).toFixed(1)}" width="${(3 * cell).toFixed(1)}" height="${(3 * cell).toFixed(1)}" fill="#2A211B"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#2A211B">${rects}</g>${finder(0, 0) + finder((n - 7) * cell, 0) + finder(0, (n - 7) * cell)}<circle cx="${size / 2}" cy="${size / 2}" r="34" fill="#EE2C2C"/><text x="${size / 2}" y="${size / 2 + 7}" font-size="26" fill="#fff" text-anchor="middle" font-family="Microsoft YaHei,Arial">鹿</text></svg>`;
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120"><rect width="420" height="120" fill="#FFFDF9"/><text x="210" y="46" font-size="26" fill="#2A211B" text-anchor="middle" font-family="Microsoft YaHei,Arial">${escapeXml(shopName || "鹿小鸣")} · ${escapeXml(placementLabel || "")}</text><text x="210" y="86" font-size="16" fill="#9C877A" text-anchor="middle" font-family="Microsoft YaHei,Arial">演示码（部署后生成真实小程序码）</text></svg>`;
  const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="540"><rect width="420" height="540" fill="#FFFDF9"/><g transform="translate(0,0)">${svg.replace(/<\/?svg[^>]*>/g, "")}</g><g transform="translate(0,420)">${label.replace(/<\/?svg[^>]*>/g, "")}</g></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(combined);
}
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));
}
