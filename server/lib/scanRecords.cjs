"use strict";

const crypto = require("node:crypto");
const { time, HOUR } = require("./shareEngine.cjs");

// The legacy landing and merchant-share landing persist different event tables.
// Join their read projections instead of copying facts between tables: retries
// and a dashboard refresh must never create an additional scan.
function projectShareScan(scan) {
  const instant = time(scan.scanAt);
  const local = new Date(instant + 8 * HOUR).toISOString();
  const scanTime = new Date(instant).toISOString();
  const id = `share_scan:${scan.id}`;
  return {
    id, _id: id, shareScanId: String(scan.id), scanSource: "merchant_share",
    merchantId: String(scan.merchantId), shopId: String(scan.merchantId),
    codeId: String(scan.qrId), sourceCodeId: String(scan.qrId),
    sourceType: "merchant_qrcode", scene: scan.scene || "门店统一码",
    placementType: "fixed_shop", placementLabel: "门店统一码",
    visitorHash: crypto.createHash("sha256").update(String(scan.userId)).digest("hex"),
    visitorKind: "wechat", launchType: scan.launchType,
    date: local.slice(0, 10), businessDate: local.slice(0, 10),
    hour: Number(local.slice(11, 13)), scanTime, createTime: scanTime,
  };
}

function mergeScanRecords(legacy, shareScans) {
  const projected = new Map(shareScans.map(scan => [String(scan.id), projectShareScan(scan)]));
  const result = [];
  for (const row of legacy) {
    // An explicitly linked projection is the same fact. Never infer identity
    // from visitor/time: two actual visits may share both values.
    if (row.shareScanId != null && projected.has(String(row.shareScanId))) continue;
    if (row.scanSource === "merchant_share" && projected.has(String(row.id || row._id || "").replace(/^share_scan:/, ""))) continue;
    result.push(row);
  }
  result.push(...projected.values());
  return result.sort((a, b) => String(b.scanTime || b.createTime || b.date || "").localeCompare(String(a.scanTime || a.createTime || a.date || "")))
    .map(row => ({ ...row }));
}

async function readScanRecords(source, store) {
  const [legacy, scans] = await Promise.all([
    source.list("scans"),
    store && typeof store.listScanRecords === "function" ? store.listScanRecords().catch(error => {
      // Pre-installation databases have only legacy facts. Connection and
      // permission failures must surface, rather than presenting false zeroes.
      if (error.code === "ER_NO_SUCH_TABLE") return [];
      throw error;
    }) : [],
  ]);
  return mergeScanRecords(legacy, scans);
}

module.exports = { projectShareScan, mergeScanRecords, readScanRecords };
