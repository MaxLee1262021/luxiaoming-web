"use strict";

// One snapshot per read-only RPC, including in-flight reads. This deliberately
// has no process-wide cache: the next request must see current publish state.
module.exports = function requestReadSource(source) {
  const lists = new Map();
  const documents = new Map();
  const documentBatches = new Map();

  // Merge independent lookups made in the same turn without retaining any
  // business data across requests. getMany is position-aligned with its IDs,
  // including nulls and database ID aliases; do not remap by the returned id.
  function fetchDocument(key, id) {
    if (typeof source.getMany !== "function" || typeof id !== "string") return source.get(key, id);
    let batch = documentBatches.get(key);
    if (!batch) {
      batch = [];
      documentBatches.set(key, batch);
      queueMicrotask(() => {
        documentBatches.delete(key);
        Promise.resolve().then(() => source.getMany(key, batch.map(item => item.id))).then(values => {
          if (!Array.isArray(values) || values.length !== batch.length || !batch.every((_, index) => Object.hasOwn(values, index))) {
            throw Object.assign(new Error("批量读取文档结果不完整"), { code: "DATA_SOURCE_INVALID" });
          }
          batch.forEach((item, index) => item.resolve(values[index]));
        }).catch(error => batch.forEach(item => item.reject(error)));
      });
    }
    return new Promise((resolve, reject) => batch.push({ id, resolve, reject }));
  }
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
          return fetchDocument(key, id);
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
