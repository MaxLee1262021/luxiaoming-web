// Select a data source. Misconfiguration is represented as an unavailable
// source; it must never silently downgrade a production request to JSON/mock.
const path = require("path");
const fs = require("fs");
const root = path.resolve(__dirname, "..", "..");

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
    object: fail,
    snapshot: fail,
    dashboard: fail,
    orderStats: fail,
    homeData: fail,
    generateMerchantCode: fail,
    listMerchantCodes: fail,
    merchantCodeStats: fail,
    async health() {
      return { backend: mode, configured: false, ready: false, persistent: !["mock", "invalid"].includes(mode), error: reason };
    },
    async close() {}
  };
}

function safeJsonPath(raw) {
  if (!raw) return undefined;
  const candidate = path.resolve(root, raw);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) return null;
  // Resolve an existing target before opening it so a DB_FILE symlink cannot
  // escape the repository boundary. Non-existent files remain valid targets;
  // the JSON adapter creates their parent directory on first write.
  try {
    if (fs.existsSync(candidate)) {
      const real = fs.realpathSync(candidate);
      if (real !== root && !real.startsWith(rootPrefix)) return null;
    }
  } catch (_) { return null; }
  return candidate;
}

module.exports = function selectSource() {
  const dataMode = String(process.env.DATA_MODE || "json").trim().toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const productionLike = ["production", "prod", "staging"].includes(nodeEnv);
  if (productionLike && (!process.env.DATA_MODE || ["json", "mock"].includes(dataMode))) {
    const source = unavailableSource(dataMode, "production_data_mode_required");
    return { source, mode: dataMode, status: { configured: false, ready: false, persistent: dataMode !== "mock", error: "production_data_mode_required" } };
  }

  if (dataMode === "mock") {
    try {
      return { source: require("./mockSource.cjs")(root), mode: "mock", status: { configured: true, ready: true, persistent: false } };
    } catch (e) {
      return { source: unavailableSource("mock", "mock_load_failed"), mode: "mock", status: { configured: false, ready: false, persistent: false, error: "mock_load_failed" } };
    }
  }

  if (dataMode === "cloud") {
    const envId = String(process.env.CLOUDBASE_ENV_ID || "").trim();
    const sid = String(process.env.CLOUDBASE_SECRET_ID || "").trim();
    const skey = String(process.env.CLOUDBASE_SECRET_KEY || "").trim();
    if (!envId || !sid || !skey) {
      const source = unavailableSource("cloud", "cloud_credentials_missing");
      return { source, mode: "cloud", status: { configured: false, ready: false, persistent: true, error: "cloud_credentials_missing" } };
    }
    try {
      return { source: require("./cloudSource.cjs")({ envId, secretId: sid, secretKey: skey }), mode: "cloud", status: { configured: true, ready: true, persistent: true } };
    } catch (e) {
      const source = unavailableSource("cloud", "cloud_driver_unavailable");
      return { source, mode: "cloud", status: { configured: false, ready: false, persistent: true, error: "cloud_driver_unavailable" } };
    }
  }

  if (dataMode === "mysql") {
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
      connectTimeout: Math.min(Math.max(Number(process.env.DB_CONNECT_TIMEOUT_MS || 3000), 500), 10000)
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
  }

  if (dataMode !== "json") {
    const source = unavailableSource("invalid", "unknown_data_mode");
    return { source, mode: "invalid", status: { configured: false, ready: false, persistent: false, error: "unknown_data_mode" } };
  }

  const jsonFile = safeJsonPath(process.env.DB_FILE);
  if (jsonFile === null) {
    const source = unavailableSource("json", "json_path_outside_root");
    return { source, mode: "json", status: { configured: false, ready: false, persistent: true, error: "json_path_outside_root" } };
  }
  try {
    const source = require("./dbSource.cjs")({ backend: "json", jsonFile });
    return { source, mode: "json", status: { configured: true, ready: true, persistent: true } };
  } catch (e) {
    const source = unavailableSource("json", "json_driver_unavailable");
    return { source, mode: "json", status: { configured: false, ready: false, persistent: true, error: "json_driver_unavailable" } };
  }
};
