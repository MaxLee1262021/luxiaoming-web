"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const requestReadSource = require("../lib/requestReadSource.cjs");

test("independent document lookups share a batch and preserve aliases, misses and nested isolation", async () => {
  const calls = [];
  const source = {
    async getMany(key, ids) {
      calls.push({ key, ids });
      return ids.map(id => id === "missing" ? null : { id: id.toLowerCase(), nested: { values: [key] } });
    },
    async get() { throw new Error("individual query should not be needed"); },
  };
  const scoped = requestReadSource(source);
  const [first, alias, duplicate, missing] = await Promise.all([
    scoped.get("mediaFiles", "ONE"), scoped.get("mediaFiles", "two"),
    scoped.get("mediaFiles", "ONE"), scoped.get("mediaFiles", "missing"),
  ]);
  assert.deepEqual(calls, [{ key: "mediaFiles", ids: ["ONE", "two", "missing"] }]);
  assert.equal(first.id, "one");
  assert.equal(alias.id, "two");
  first.nested.values.push("changed");
  assert.deepEqual(duplicate.nested.values, ["mediaFiles"]);
  assert.equal(missing, null);
  assert.equal(await scoped.get("mediaFiles", "missing"), null);
  assert.equal(calls.length, 1);
});

test("preloaded exact documents bypass batches and collections never share a batch", async () => {
  const calls = [];
  const scoped = requestReadSource({
    async list() { return [{ id: "known", value: "from list" }]; },
    async getMany(key, ids) { calls.push({ key, ids }); return ids.map(id => ({ id, key })); },
  });
  await scoped.list("a:b");
  const [known, a, b] = await Promise.all([
    scoped.get("a:b", "known"), scoped.get("a:b", "c"), scoped.get("a", "b:c"),
  ]);
  assert.equal(known.value, "from list");
  assert.equal(a.key, "a:b");
  assert.equal(b.key, "a");
  assert.equal(calls.length, 2);
});

test("batch failures fail every affected read and allow retry without cross-request caching", async () => {
  let failures = 1;
  let revision = 1;
  let calls = 0;
  const source = {
    async getMany(key, ids) {
      calls++;
      if (failures-- > 0) throw new Error("storage unavailable");
      return ids.map(id => ({ id, revision }));
    },
  };
  const scoped = requestReadSource(source);
  const results = await Promise.allSettled([scoped.get("orders", "a"), scoped.get("orders", "b")]);
  assert.ok(results.every(result => result.status === "rejected" && /storage unavailable/.test(result.reason.message)));
  assert.equal((await scoped.get("orders", "a")).revision, 1);
  revision = 2;
  assert.equal((await scoped.get("orders", "a")).revision, 1);
  assert.equal((await requestReadSource(source).get("orders", "a")).revision, 2);
  assert.equal(calls, 3);
});

test("malformed aligned results are rejected and may be retried", async () => {
  let valid = false;
  const scoped = requestReadSource({
    async getMany(key, ids) { return valid ? ids.map(id => ({ id })) : []; },
  });
  await assert.rejects(scoped.get("orders", "a"), { code: "DATA_SOURCE_INVALID" });
  valid = true;
  assert.deepEqual(await scoped.get("orders", "a"), { id: "a" });
});

test("legacy adapters and non-string identifiers retain the original get argument type", async () => {
  const calls = [];
  const source = {
    async get(key, id) { calls.push(id); return { key, id, inputType: typeof id }; },
    async getMany() { throw new Error("numeric identifiers must retain single-get semantics"); },
  };
  assert.equal((await requestReadSource(source).get("orders", 0)).inputType, "number");
  delete source.getMany;
  assert.equal((await requestReadSource(source).get("orders", 42)).id, 42);
  assert.deepEqual(calls, [0, 42]);
});
