"use strict";

const order = require("../../src/utils/content-order.js");
const KEYS = new Set(["albums", "packages", "guides"]);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deleted = row => !!(row && (row.deleted || row.isDeleted));
const { idOf, rank, group, ordered } = order;

// The caller holds the catalog mutex or locks the complete SQL collection. Only
// this command changes a stored order; stale editor snapshots cannot restore it.
function planContentMutation(key, rows, id, patch = {}, options = {}) {
  if (!KEYS.has(key)) throw new Error("不支持的内容排序类型");
  id = String(id || "");
  const current = (rows || []).find(row => idOf(row) === id) || null;
  if (options.create && current) throw Object.assign(new Error("记录已存在"), { code: "DUPLICATE_RECORD" });
  if (!options.create && !current) return null;
  const clean = clone(patch);
  delete clean.sort;
  delete clean.sortDirection;
  delete clean.targetPosition;
  delete clean.__contentOrder;
  const saved = { ...clone(current || {}), ...clean, id, _id: id };
  const changes = new Map();
  const updateRank = (row, sort) => {
    if (row.sort === sort) return;
    changes.set(idOf(row), { id: idOf(row), before: clone(row), after: { ...clone(row), sort } });
  };
  const normalize = (list) => list.forEach((row, index) => {
    if (idOf(row) === id) saved.sort = index + 1;
    else updateRank(row, index + 1);
  });
  const hasTargetPosition = Object.prototype.hasOwnProperty.call(options, "targetPosition");
  if (hasTargetPosition || options.direction) {
    const invalidOrder = message => Object.assign(new Error(message), { code: "CONTENT_ORDER_INVALID", statusCode: 400 });
    if (!current || deleted(current) || hasTargetPosition && options.direction || !hasTargetPosition && ![-1, 1].includes(options.direction)) {
      throw invalidOrder("排序操作无效");
    }
    const list = ordered(key, rows, current);
    if (hasTargetPosition && (!Number.isSafeInteger(options.targetPosition) || options.targetPosition < 1 || options.targetPosition > list.length)) {
      throw invalidOrder(`目标位置须为 1 至 ${list.length} 之间的整数`);
    }
    const index = list.findIndex(row => idOf(row) === id);
    const target = hasTargetPosition ? options.targetPosition - 1 : Math.max(0, Math.min(list.length - 1, index + options.direction));
    list.splice(index, 1);
    list.splice(target, 0, saved);
    normalize(list);
  } else {
    const oldGroup = current && group(key, current);
    const newGroup = group(key, saved);
    const removed = current && !deleted(current) && (deleted(saved) || oldGroup !== newGroup);
    const added = !deleted(saved) && (!current || deleted(current) || oldGroup !== newGroup);
    if (removed && rank(current.sort)) normalize(ordered(key, rows, current).filter(row => idOf(row) !== id));
    if (added) {
      const list = ordered(key, rows, saved).filter(row => idOf(row) !== id);
      // New cards join a manual order at the end. Restoring a removed card
      // inserts at its retained position without disturbing the other pool.
      const restoring = current && deleted(current) && oldGroup === newGroup;
      if (list.some(row => rank(row.sort)) || restoring && rank(current.sort)) {
        const index = restoring && rank(current.sort) ? Math.min(rank(current.sort) - 1, list.length) : list.length;
        list.splice(index, 0, saved);
        normalize(list);
      } else if (current && oldGroup !== newGroup) saved.sort = 0;
    }
    if (key === "guides" && current && !deleted(current) && !deleted(saved)
      && !!current.isTop !== !!saved.isTop && ordered(key, rows, current).some(row => rank(row.sort))) {
      const list = ordered(key, rows, current).filter(row => idOf(row) !== id);
      // Pinning keeps the existing card action meaningful after a manual move.
      // Unpin after the remaining pinned cards, retaining every sibling's order.
      const index = saved.isTop ? 0 : list.reduce((after, row, i) => row.isTop ? i + 1 : after, 0);
      list.splice(index, 0, saved);
      normalize(list);
    }
  }
  changes.set(id, { id, before: clone(current), after: clone(saved) });
  return { saved, changes: [...changes.values()] };
}

module.exports = { ...order, KEYS, planContentMutation };
