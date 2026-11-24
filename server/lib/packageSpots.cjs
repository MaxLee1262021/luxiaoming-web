"use strict";

const { effectivePackageSpotIds } = require("./contentPolicy.cjs");

function safeApplicableSpots(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((spot) => {
    if (!spot || typeof spot !== "object") return [];
    const id = String(spot._id || spot.id || spot.spotId || "").trim();
    const name = String(spot.name || spot.spotName || "").trim().slice(0, 160);
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ _id: id, name }];
  });
}

// The same product relationship rules drive public shelves and the immutable
// checkout snapshot, including multiple points and inherited style bindings.
function productApplicableSpots(product = {}, context = {}) {
  const ids = effectivePackageSpotIds(product, { ...context, packages: context.packages || context.videos || [] });
  const byId = new Map((context.spots || []).map((spot) => [String(spot._id || spot.id || ""), spot]));
  return safeApplicableSpots(ids.map((id) => byId.get(String(id))).filter(Boolean));
}

function orderApplicableSpots(order = {}) {
  if (Array.isArray(order.applicableSpots)) return safeApplicableSpots(order.applicableSpots);
  if (Array.isArray(order.packageSnapshot?.applicableSpots)) return safeApplicableSpots(order.packageSnapshot.applicableSpots);
  const items = [order.products, order.productItems, order.items, order.packageSnapshot?.items].find((rows) => Array.isArray(rows) && rows.length) || [];
  return safeApplicableSpots(items.flatMap((item) => Array.isArray(item?.applicableSpots) ? item.applicableSpots : []));
}

module.exports = { safeApplicableSpots, productApplicableSpots, orderApplicableSpots };
