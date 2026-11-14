// Shared by the admin editor and server so every entry point inserts at a position.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LXM_SPOT_ORDER = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function idOf(row) { return String(row && (row.id || row._id) || ""); }
  function rank(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= 2147483647 ? number : 0;
  }
  function compare(left, right) {
    return (rank(left.sort) || Number.MAX_SAFE_INTEGER) - (rank(right.sort) || Number.MAX_SAFE_INTEGER)
      || Number(right.hotScore || 0) - Number(left.hotScore || 0)
      || String(left.name || "").localeCompare(String(right.name || ""), "zh-Hans-CN") || idOf(left).localeCompare(idOf(right));
  }
  function ordered(rows) {
    return (rows || []).filter(row => row && !row.deleted && !row.isDeleted && rank(row.sort)).slice().sort(compare);
  }
  function insertion(rows, id, requested) {
    id = String(id);
    const list = ordered(rows).filter(row => idOf(row) !== id);
    const sort = rank(requested) ? Math.min(rank(requested), list.length + 1) : 0;
    if (sort) list.splice(sort - 1, 0, { id });
    const previous = new Map((rows || []).filter(Boolean).map(row => [idOf(row), row]));
    const changes = list.map((row, index) => ({ id: idOf(row), sort: index + 1 }));
    if (!sort) changes.push({ id, sort: 0 });
    return { sort, changes: changes.filter(change => !previous.has(change.id) || previous.get(change.id).sort !== change.sort) };
  }
  return { idOf, rank, compare, ordered, insertion };
});
