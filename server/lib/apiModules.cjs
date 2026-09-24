"use strict";

// Module boundaries are intentionally enforced on the server. The browser may
// request a subset for a screen, but it cannot expand that screen into an
// arbitrary collection read by changing the query string.
const MODULE_COLLECTIONS = Object.freeze({
  dashboard: ["cities", "agents", "distributors", "shops", "staff", "spots", "series", "albums", "packages", "addonServices", "peripherals", "scans", "orders", "afterSales"],
  operations: ["orders", "shops", "scans", "cities", "agents", "distributors", "staff"],
  orders: ["orders", "afterSales", "shops", "cities", "distributors", "agents", "staff", "packages", "albums", "peripherals", "addonServices", "spots", "series", "samples"],
  finance: ["orders", "afterSales", "shops", "distributors", "agents", "staff", "cities", "reconciliationTransfers", "monthlyClosings", "adjustmentRecords", "financeSettings"],
  channel: ["staff", "cities", "distributors", "shops", "agents"],
  content: ["cities", "spots", "series", "samples", "albums", "packages", "peripherals", "guides", "stories", "tagLibrary", "orders", "addonServices", "homeConfig", "siteConfig"],
  configuration: ["homeConfig", "siteConfig", "spots", "series", "samples", "albums", "packages", "peripherals", "guides", "stories"],
  system: ["logs", "trash"],
});

const MENU_MODULES = Object.freeze({
  dashboard: "dashboard",
  performance: "operations",
  trace: "operations",
  orders: "orders",
  receive: "orders",
  dispatch: "orders",
  tasks: "orders",
  afterSales: "orders",
  financeReview: "finance",
  reconciliation: "finance",
  report: "finance",
  staff: "channel",
  distributors: "channel",
  shops: "channel",
  contentOverview: "content",
  spots: "content",
  cities: "content",
  series: "content",
  albums: "content",
  samples: "content",
  contentTags: "content",
  packages: "content",
  videoSingles: "content",
  shelfProducts: "content",
  productAudit: "content",
  addonServices: "content",
  peripherals: "content",
  guides: "content",
  stories: "content",
  miniDecor: "configuration",
  miniConfig: "configuration",
  logs: "system",
  trash: "system",
});

function resolveModule(value) {
  const raw = String(value || "").trim();
  const name = MENU_MODULES[raw] || raw;
  return Object.prototype.hasOwnProperty.call(MODULE_COLLECTIONS, name) ? name : "";
}

function parseKeys(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(raw.map((item) => String(item || "").trim()).filter((item) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item)))];
}

function keysForModule(moduleName, requested) {
  const module = resolveModule(moduleName);
  if (!module) return { module: "", keys: [], rejected: parseKeys(requested) };
  const allowed = new Set(MODULE_COLLECTIONS[module]);
  const parsed = parseKeys(requested);
  const keys = parsed.length ? parsed.filter((key) => allowed.has(key)) : [...allowed];
  return { module, keys, rejected: parsed.filter((key) => !allowed.has(key)) };
}

module.exports = {
  MENU_MODULES,
  MODULE_COLLECTIONS,
  keysForModule,
  parseKeys,
  resolveModule,
};
