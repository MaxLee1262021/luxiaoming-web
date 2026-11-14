"use strict";

const { rank, insertion } = require("../../src/utils/spot-order.js");

function idOf(row) { return String(row && (row.id || row._id) || ""); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function deleted(row) { return !!(row && (row.deleted || row.isDeleted)); }

// Call with the latest complete spot collection under the source's write lock.
// Unrelated edits keep their order; insertion/removal shifts only ranked records.
function planSpotMutation(rows, id, patch = {}, options = {}) {
  id = String(id || "");
  const current = (rows || []).find(row => idOf(row) === id) || null;
  if (options.create && current) throw Object.assign(new Error("记录已存在"), { code: "DUPLICATE_RECORD" });
  if (!options.create && !current) return null;
  const saved = { ...clone(current || {}), ...clone(patch), id, _id: id };
  const ownsSort = Object.prototype.hasOwnProperty.call(patch, "sort");
  if (ownsSort) saved.sort = rank(patch.sort);
  const membershipChanged = deleted(current) !== deleted(saved) && rank(saved.sort) > 0;
  const sortChanged = ownsSort && rank(current && current.sort) !== rank(saved.sort);
  const explicitReorder = ownsSort && options.reorder && !deleted(saved);
  const changes = [];
  if (membershipChanged || sortChanged || explicitReorder) {
    const order = insertion(rows, id, deleted(saved) ? 0 : saved.sort);
    if (!deleted(saved)) saved.sort = order.sort;
    for (const change of order.changes) {
      if (change.id === id) continue;
      const before = (rows || []).find(row => idOf(row) === change.id);
      if (before) changes.push({ id: change.id, before: clone(before), after: { ...clone(before), sort: change.sort } });
    }
  }
  changes.push({ id, before: clone(current), after: clone(saved) });
  return { saved, changes };
}

module.exports = { planSpotMutation, planMutation: planSpotMutation };
