"use strict";
// Synthetic JSON adapter for isolated tests only. Never packaged or loaded by the runtime.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const merchantCodes = require("../../lib/merchantCodes.cjs");
const { isUnpaidBooking } = require("../../lib/orderWorkflow.cjs");
const { planSpotMutation } = require("../../lib/spotOrder.cjs");

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

module.exports = function(cfg = {}) { return withComputed(makeJson(cfg)); };
module.exports.ALL_KEYS = ALL_KEYS;
function makeJson(cfg) {
  if (!cfg.jsonFile) throw new Error("An explicit isolated JSON fixture path is required");
  const dataFile = cfg.jsonFile;
  let mem = null;
  let loadState = "missing";
  let loadError = "";
  function load() {
    if (mem) return mem;
    let candidate;
    try {
      candidate = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    } catch (e) {
      if (e && e.code === "ENOENT") {
        mem = { collections: {} };
        loadState = "empty";
        loadError = "";
        return mem;
      } else {
        mem = null;
        loadState = "invalid";
        loadError = "json_invalid";
        const err = new Error("JSON 数据文件无效");
        err.code = "DATA_SOURCE_INVALID";
        throw err;
      }
    }

    // Keep malformed input out of the live cache. A failed health check must
    // remain failed until the file is repaired, rather than becoming writable
    // on the next request because an invalid object was cached first.
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !candidate.collections || typeof candidate.collections !== "object" || Array.isArray(candidate.collections)) {
      mem = null;
      loadState = "invalid";
      loadError = "json_invalid";
      const err = new Error("JSON 数据文件格式无效");
      err.code = "DATA_SOURCE_INVALID";
      throw err;
    }
    for (const [key, value] of Object.entries(candidate.collections)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        mem = null;
        loadState = "invalid";
        loadError = "json_invalid";
        const err = new Error(`JSON 集合 ${key} 格式无效`);
        err.code = "DATA_SOURCE_INVALID";
        throw err;
      }
    }
    mem = candidate;
    loadState = "ready";
    loadError = "";
    return mem;
  }
  function persist(atomic = false) {
    load();
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    const text = JSON.stringify(mem, null, 2);
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    try {
      // Rename is atomic on the supported POSIX deployment targets. Windows
      // may reject replacing an existing file, so retain a safe copy fallback.
      fs.renameSync(tmp, dataFile);
    } catch (e) {
      if (atomic) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
      }
      fs.copyFileSync(tmp, dataFile);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    try { fs.chmodSync(dataFile, 0o600); } catch (_) {}
    loadState = "ready";
    loadError = "";
  }
  function col(key) {
    assertKey(key);
    const m = load();
    if (!m.collections[key]) m.collections[key] = {};
    return m.collections[key];
  }
  function genId(key) {
    return (key || "x").slice(0, 2) + "_" + crypto.randomBytes(6).toString("hex");
  }
  function favoriteCollection() {
    const m = load();
    if (!m.collections.favorites || typeof m.collections.favorites !== "object" || Array.isArray(m.collections.favorites)) m.collections.favorites = {};
    return m.collections.favorites;
  }
  function favoriteKey(openid, type, itemId) {
    return `${String(openid || "")}\u0000${String(type || "")}\u0000${String(itemId || "")}`;
  }
  function favoriteRecord(openid, input = {}) {
    const type = String(input.type || "").trim();
    const itemId = String(input.itemId || input.id || "").trim();
    const key = favoriteKey(openid, type, itemId);
    const createdAt = String(input.createdAt || new Date().toISOString());
    return {
      key,
      openid: String(openid || ""),
      type,
      itemId,
      snapshot: input.snapshot && typeof input.snapshot === "object" ? clone(input.snapshot) : {},
      createdAt,
      updatedAt: String(input.updatedAt || createdAt)
    };
  }
  return {
    mode: "json",
    backend: "json",
    async list(key) { return Object.values(col(key)).map(clone); },
    async get(key, id) { const d = col(key)[id]; return d ? clone({ ...d, id, _id: id }) : null; },
    async create(key, doc) {
      const id = doc.id || doc._id || genId(key);
      if (Object.prototype.hasOwnProperty.call(col(key), id)) {
        const err = new Error("记录已存在");
        err.code = "DUPLICATE_RECORD";
        throw err;
      }
      const item = { ...doc, id, _id: id };
      col(key)[id] = item; persist(); return clone(item);
    },
    async update(key, id, patch) {
      const c = col(key);
      if (!c[id]) return null;
      c[id] = { ...c[id], ...patch, id, _id: id };
      persist(); return clone(c[id]);
    },
    async applySpotMutation(id, patch, options = {}) {
      const previous = col("spots");
      const plan = planSpotMutation(Object.values(previous), id, patch, options);
      if (!plan) return null;
      const next = { ...previous };
      for (const change of plan.changes) next[change.id] = clone(change.after);
      // One file replacement publishes the point and every shifted rank together.
      mem.collections.spots = next;
      try { persist(true); }
      catch (error) { mem.collections.spots = previous; throw error; }
      return clone(plan);
    },
    async compareAndUpdate(key, id, expected, patch) {
      const c = col(key);
      if (!c[id] || !Object.entries(expected || {}).every(([field, value]) => isDeepStrictEqual(clone(c[id][field]), clone(value)))) return null;
      c[id] = { ...c[id], ...patch, id, _id: id };
      persist(); return clone(c[id]);
    },
    async replace(key, id, document) {
      const c = col(key);
      if (!c[id]) return null;
      c[id] = { ...clone(document), id, _id: id };
      persist(); return clone(c[id]);
    },
    async remove(key, id) { const c = col(key); if (!(id in c)) return false; delete c[id]; persist(); return true; },
    async upsert(key, id, patch) {
      const c = col(key);
      c[id] = { ...(c[id] || {}), ...patch, id, _id: id };
      persist(); return clone(c[id]);
    },
    async object(key) { return clone(col(key)); },
    async listFavorites(openid, options = {}) {
      const owner = String(openid || "").trim();
      if (!owner) return [];
      const type = String(options.type || "").trim();
      const rows = Object.values(favoriteCollection())
        .filter((row) => row && String(row.openid || "") === owner && (!type || String(row.type || "") === type))
        .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
        .map((row) => clone(row));
      const offset = Math.max(Number(options.offset || 0), 0);
      const limit = Math.min(Math.max(Number(options.limit || 100), 1), 200);
      return rows.slice(offset, offset + limit);
    },
    async getFavorite(openid, type, itemId) {
      const row = favoriteCollection()[favoriteKey(openid, type, itemId)];
      return row ? clone(row) : null;
    },
    async upsertFavorite(openid, input = {}) {
      const owner = String(openid || "").trim();
      const type = String(input.type || "").trim();
      const itemId = String(input.itemId || input.id || "").trim();
      if (!owner || !type || !itemId) return null;
      const key = favoriteKey(owner, type, itemId);
      const existing = favoriteCollection()[key];
      const row = favoriteRecord(owner, { ...(existing || {}), ...input, type, itemId, createdAt: existing && existing.createdAt, updatedAt: new Date().toISOString() });
      favoriteCollection()[key] = row;
      persist();
      return clone(row);
    },
    async removeFavorite(openid, type, itemId) {
      const collection = favoriteCollection();
      const key = favoriteKey(openid, type, itemId);
      if (!Object.prototype.hasOwnProperty.call(collection, key)) return false;
      delete collection[key];
      persist();
      return true;
    },
    async health() {
      try {
        load();
        return { backend: "json", configured: true, ready: true, persistent: true, file: loadState === "empty" ? "missing" : "present" };
      } catch (e) {
        return { backend: "json", configured: true, ready: false, persistent: true, error: loadError || "invalid" };
      }
    },
    async close() {}
  };
}

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
