"use strict";

// One snapshot per read-only RPC, including in-flight reads. This deliberately
// has no process-wide cache: the next request must see current publish state.
module.exports = function requestReadSource(source) {
  const lists = new Map();
  const documents = new Map();
  function read(cache, key, fetch) {
    if (!cache.has(key)) {
      const pending = Promise.resolve().then(fetch).catch((error) => {
        cache.delete(key);
        throw error;
      });
      cache.set(key, pending);
    }
    // Handlers sort lists and enrich nested values. Each consumer gets its own
    // copy so one projection cannot change another consumer's source snapshot.
    return cache.get(key).then((value) => structuredClone(value));
  }
  return new Proxy(source, {
    get(target, property) {
      if (property === "preload") return async (keys) => {
        if (typeof source.listMany !== "function") return;
        const missing=[...new Set(keys)].filter(key=>!lists.has(key));
        if (!missing.length) return;
        const batch=Promise.resolve().then(()=>source.listMany(missing));
        for (const key of missing) lists.set(key,batch.then(values=>{
          if (!Object.hasOwn(values,key)) throw Object.assign(new Error("批量读取缺少集合"),{code:"DATA_SOURCE_INVALID"});
          return values[key];
        }).catch(error=>{lists.delete(key);throw error;}));
        await Promise.all(missing.map(key=>lists.get(key)));
      };
      if (property === "list") return (key) => read(lists, key, () => source.list(key));
      if (property === "get") return (key, id) => {
        if (!documents.has(key)) documents.set(key, new Map());
        return read(documents.get(key), String(id), async () => {
          if (lists.has(key)) {
            const rows=await lists.get(key);
            const exact=Array.isArray(rows) ? rows.find(row=>String(row.id || row._id || "")===String(id)) : null;
            if (exact) return exact;
          }
          return source.get(key, id);
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
