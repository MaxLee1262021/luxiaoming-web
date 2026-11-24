// One order for admin cards and public catalogs. Positive positions take priority
// over the legacy popularity/date order until an operator inserts a card.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LXM_CONTENT_ORDER = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function idOf(row) { return String(row && (row.id || row._id) || ""); }
  function rank(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= 2147483647 ? number : 0;
  }
  function isVideoSingle(row = {}) {
    if (!row || !(row.isVideoSingle === true || row.productKind === "video_single")) return false;
    return [row.serviceType, row.type, row.productType, row.productKind, row.category]
      .some(value => /video|短视频|视频/.test(String(value || "").trim().toLowerCase()));
  }
  function group(key, row = {}) {
    return key === "packages" ? (isVideoSingle(row) ? "videoSingles" : row.type === "video" ? "legacyVideos" : "packages") : key;
  }
  function timestamp(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const number = /^\d+(?:\.\d+)?$/.test(String(value || "")) ? Number(value) : Date.parse(value || "");
    return Number.isFinite(number) ? number : 0;
  }
  function compare(key, left, right) {
    const positions = (rank(left.sort) || Number.MAX_SAFE_INTEGER) - (rank(right.sort) || Number.MAX_SAFE_INTEGER);
    if (positions) return positions;
    if (key === "guides") return Number(right.isTop === true || (right.isTop === undefined && right.pinned === true))
      - Number(left.isTop === true || (left.isTop === undefined && left.pinned === true))
      || timestamp(right.updatedAt || right.updateTime || right.createTime || right.createdAt) - timestamp(left.updatedAt || left.updateTime || left.createTime || left.createdAt)
      || idOf(left).localeCompare(idOf(right));
    return (Number(right.hotScore) || 0) - (Number(left.hotScore) || 0)
      || timestamp(right.createTime || right.createdAt) - timestamp(left.createTime || left.createdAt)
      || idOf(left).localeCompare(idOf(right));
  }
  function ordered(key, rows, target) {
    return (rows || []).filter(row => row && !row.deleted && !row.isDeleted && (!target || group(key, row) === group(key, target)))
      .slice().sort((a, b) => compare(key, a, b));
  }
  function insertion(key, rows, id, requested) {
    id = String(id);
    const current = (rows || []).find(row => idOf(row) === id);
    const list = ordered(key, rows, current).filter(row => idOf(row) !== id);
    const sort = rank(requested) ? Math.min(rank(requested), list.length + 1) : 0;
    if (sort) list.splice(sort - 1, 0, { id });
    const previous = new Map((rows || []).filter(Boolean).map(row => [idOf(row), row]));
    const changes = list.map((row, index) => ({ id: idOf(row), sort: index + 1 }));
    return { sort, changes: changes.filter(change => !previous.has(change.id) || previous.get(change.id).sort !== change.sort) };
  }
  return { idOf, rank, isVideoSingle, group, compare, ordered, insertion };
});
