// Runtime data source: MySQL only. Isolated synthetic adapters live under server/tests/fixtures.
const merchantCodes = require("./merchantCodes.cjs");
const { isUnpaidBooking } = require("./orderWorkflow.cjs");
const ALL_KEYS = [
  "cities", "agents", "distributors", "shops", "staff", "spots", "series",
  "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary",
  "guides", "stories", "scans", "orders", "bookingRequests", "afterSales", "reconciliationTransfers",
  "financeSettings", "monthlyClosings", "adjustmentRecords", "homeConfig", "logs", "trash",
  "merchantCodes", "siteConfig", "userProfiles", "config", "mediaFiles"
];
const KEY_SET = new Set(ALL_KEYS);

function assertKey(key) {
  if (!KEY_SET.has(key)) {
    const err = new Error("不支持的数据集合");
    err.code = "DATA_KEY_INVALID";
    throw err;
  }
  return key;
}

module.exports = function(cfg = {}) {
  if (cfg.backend && cfg.backend !== "mysql") throw Object.assign(new Error("Only MySQL is supported at runtime"), { code: "DATA_SOURCE_CONFIG_INVALID" });
  return withComputed(require("./mysqlSource.cjs")({ ...cfg, backend: "mysql" }));
};
module.exports.ALL_KEYS = ALL_KEYS;

function withComputed(base) {
  return Object.assign({}, base, {
    async snapshot() {
      const out = {};
      for (const k of ["orders", "shops", "merchantCodes", "spots", "albums", "series", "packages", "peripherals", "afterSales"]) {
        const rows = await base.list(k);
        out[k] = k === "orders" ? rows.filter((row) => !isUnpaidBooking(row)) : rows;
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
    async generateMerchantCode(body = {}) { return merchantCodes.generateMerchantCode(base, body); },
    async listMerchantCodes(shopId = "") { return merchantCodes.listMerchantCodes(base, shopId); },
    async merchantCodeStats(shopId = "", date) { return merchantCodes.merchantCodeStats(base, shopId, date); },
    async health() {
      if (typeof base.health === "function") return base.health();
      return { backend: base.mode || "unknown", configured: true, ready: true, persistent: false };
    },
    async close() { if (typeof base.close === "function") await base.close(); }
  });
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
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
