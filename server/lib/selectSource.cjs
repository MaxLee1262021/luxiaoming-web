// Select the MySQL-backed data source used by every runtime API request.
// JSON remains available only for isolated Node test fixtures.
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
  const dataMode = String(process.env.DATA_MODE || "mysql").trim().toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const testJsonFixture = nodeEnv === "test" && process.env.LXM_ALLOW_TEST_JSON_SOURCE === "true" && dataMode === "json";
  if (!testJsonFixture) {
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

  // Test-only branch: runtime servers never select the JSON adapter.
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
