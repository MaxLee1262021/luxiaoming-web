"use strict";

const PHOTOGRAPHER_ROLES = new Set(["photo", "photographer", "摄影", "摄影师"]);

// Product recommendations are catalogue metadata, not a dispatch or finance
// permission. Read every profile regardless of its city or cooperation status,
// and expose only the identity fields required by the product selector.
async function listContentPhotographers(source) {
  const profiles = typeof source.transaction === "function"
    ? await source.transaction(async (conn) => (await conn.query("SELECT id,name FROM photo_profile ORDER BY id"))[0])
    : [];
  const staff = await source.list("staff");
  const rows = new Map();
  for (const row of [...profiles, ...(Array.isArray(staff) ? staff : []).filter((item) => PHOTOGRAPHER_ROLES.has(String(item?.role || item?.roleKey || "").trim().toLowerCase()))]) {
    if (!row || row.deleted === true || row.isDeleted === true) continue;
    const id = String(row.id || row._id || "").trim(), name = String(row.name || "").trim();
    if (id && name && !rows.has(id)) rows.set(id, { id, name });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
}

async function prepareRecommendedPhotographer(source, patch, current = {}) {
  // Names are always resolved from the platform directory; a client cannot
  // attach a fabricated display name to an otherwise valid photographer ID.
  delete patch.recommendedPhotographerName;
  if (!Object.prototype.hasOwnProperty.call(patch, "recommendedPhotographerId")) return;
  const value = patch.recommendedPhotographerId;
  if (value != null && typeof value !== "string") throw invalid("推荐摄影师须为单个摄影师标识");
  const id = String(value ?? "").trim();
  if (id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) throw invalid("推荐摄影师标识无效");
  patch.recommendedPhotographerId = id;
  if (!id || id === current.recommendedPhotographerId) return;
  if (!(await listContentPhotographers(source)).some((row) => row.id === id)) throw invalid("推荐摄影师不存在，请重新选择");
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "CONTENT_POLICY_INVALID", statusCode: 400 });
}

module.exports = { listContentPhotographers, prepareRecommendedPhotographer };
