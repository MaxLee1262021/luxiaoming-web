// Select the MySQL-backed data source used by every runtime API request.
// Test adapters are separate modules and cannot be selected by environment flags.

function unavailableSource(mode, reason) {
  const fail = async () => {
    const err = new Error("数据源不可用");
    err.code = "DATA_SOURCE_UNAVAILABLE";
    throw err;
  };
  return {
    mode,
    backend: mode,
    unavailable: true,
    reason,
    list: fail,
    get: fail,
    create: fail,
    update: fail,
    remove: fail,
    upsert: fail,
    listFavorites: fail,
    getFavorite: fail,
    upsertFavorite: fail,
    removeFavorite: fail,
    object: fail,
    snapshot: fail,
    dashboard: fail,
    orderStats: fail,
    homeData: fail,
    generateMerchantCode: fail,
    listMerchantCodes: fail,
    merchantCodeStats: fail,
    async health() {
      return { backend: mode, configured: false, ready: false, persistent: true, error: reason };
    },
    async close() {}
  };
}

module.exports = function selectSource() {
  const dbPortRaw = String(process.env.DB_PORT || "").trim();
  if (dbPortRaw && (!/^\d+$/.test(dbPortRaw) || Number(dbPortRaw) < 1 || Number(dbPortRaw) > 65535)) {
    const source = unavailableSource("mysql", "mysql_config_invalid");
    return { source, mode: "mysql", status: { configured: false, ready: false, persistent: true, error: "mysql_config_invalid" } };
  }
  const cfg = {
    backend: "mysql",
    dbHost: String(process.env.DB_HOST || "").trim(),
    dbPort: Math.min(Math.max(Number(process.env.DB_PORT || 3306), 1), 65535),
    dbUser: String(process.env.DB_USER || "").trim(),
    dbPassword: process.env.DB_PASSWORD || "",
    dbName: String(process.env.DB_NAME || "").trim(),
    autoMigrate: String(process.env.DB_AUTO_MIGRATE || "false").toLowerCase() === "true",
    dbSsl: String(process.env.DB_SSL || "false").toLowerCase() === "true",
    dbCompress: String(process.env.DB_COMPRESS || "true").toLowerCase() === "true",
    connectTimeout: Math.min(Math.max(Number(process.env.DB_CONNECT_TIMEOUT_MS || 3000), 500), 10000),
    connectionLimit: Math.min(Math.max(Number(process.env.DB_CONNECTION_LIMIT || 10), 1), 100)
  };
  if (!cfg.dbHost || !cfg.dbUser || !cfg.dbName) {
    const source = unavailableSource("mysql", "mysql_config_missing");
    return { source, mode: "mysql", status: { configured: false, ready: false, persistent: true, error: "mysql_config_missing" } };
  }
  try {
    const source = require("./dbSource.cjs")(cfg);
    return { source, mode: "mysql", status: { configured: true, ready: true, persistent: true } };
  } catch (e) {
    const reason = e && e.code === "DATA_SOURCE_CONFIG_INVALID" ? "mysql_config_invalid" : "mysql_driver_unavailable";
    const source = unavailableSource("mysql", reason);
    return { source, mode: "mysql", status: { configured: false, ready: false, persistent: true, error: reason } };
  }
};
