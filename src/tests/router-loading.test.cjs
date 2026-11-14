"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const routerSource = fs.readFileSync(path.resolve(__dirname, "../router/index.js"), "utf8");
const settle = () => new Promise(setImmediate);

function fixture(options = {}) {
  const requests = [], resources = [], warnings = [], timers = new Map();
  const mounted = [], unmounted = [];
  let timerId = 0;
  const controls = { ...options };
  const context = { state: { active: "reconciliation" } };
  const Vue = {
    ref: (value) => ({ value }),
    shallowRef: (value) => ({ value }),
    inject(key) { assert.equal(key, "lxm"); return context; },
    onMounted(fn) { mounted.push(fn); },
    onBeforeUnmount(fn) { unmounted.push(fn); },
    h(type, props, children) { return { type, props: props || {}, children }; }
  };
  const window = { Vue, location: { href: "https://admin.example.test/" } };
  function query(selector) {
    const match = selector.match(/^(script|link)\[data-page-(script|style)=["']([^"']+)["']\]$/);
    if (!match) return null;
    return resources.find((node) => !node.removed && node.tagName === match[1].toUpperCase()
      && node.dataset[match[2] === "script" ? "pageScript" : "pageStyle"] === match[3]) || null;
  }
  function container() {
    return {
      children: [], querySelector: query,
      appendChild(node) { return this.insertBefore(node, null); },
      insertBefore(node, before) {
        node.parentNode = this;
        node.parentElement = this;
        const index = before ? this.children.indexOf(before) : -1;
        if (index < 0) this.children.push(node);
        else this.children.splice(index, 0, node);
        resources.push(node);
        queueMicrotask(() => {
          if (node.removed) return;
          const outcome = controls.resourceOutcome ? controls.resourceOutcome(node, resources) : "load";
          if (outcome === "hang") return;
          if (outcome === "error") { if (node.onerror) node.onerror(new Error("connection timed out")); return; }
          if (node.tagName === "SCRIPT" && controls.registerScript !== false) {
            const page = window.LXM_PAGES.manifest.find((item) => node.src.includes(`/${item.folder}/${item.slug}.js`));
            assert.ok(page, `Unexpected script: ${node.src}`);
            window.LXM_PAGES.register({ key: page.key, setup: () => ({ loadedPage: page.key }) });
          }
          if (node.onload) node.onload();
        });
        return node;
      },
      removeChild(node) {
        this.children = this.children.filter((item) => item !== node);
        node.parentNode = null;
        node.parentElement = null;
        node.removed = true;
        return node;
      }
    };
  }
  const document = {
    head: container(), body: container(), querySelector: query,
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(), dataset: {},
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        setAttribute(key, value) {
          if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
          else this[key] = String(value);
        },
        getAttribute(key) {
          if (key.startsWith("data-")) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
          return this[key] ?? null;
        }
      };
    }
  };
  const fetch = async (input, init = {}) => {
    const request = { url: String(input), signal: init.signal };
    requests.push(request);
    if (controls.fetch) return controls.fetch(request, requests.length);
    return { ok: true, status: 200, text: async () => `<div>Loaded ${request.url}</div>` };
  };
  const sandbox = {
    window, document, Vue, fetch, AbortController, URL,
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  window.setTimeout = sandbox.setTimeout;
  window.clearTimeout = sandbox.clearTimeout;
  vm.runInNewContext(routerSource, sandbox, { filename: "router/index.js" });
  return {
    pages: window.LXM_PAGES, requests, resources, warnings, controls, timers, mounted, unmounted, context,
    count(tag) { return resources.filter((node) => node.tagName === tag.toUpperCase()).length; },
    expire() {
      assert.ok(timers.size, "a stalled resource must have a timeout");
      const delay = Math.min(...Array.from(timers.values(), (timer) => timer.delay));
      const pending = Array.from(timers.entries()).filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of pending) {
        if (!timers.delete(id)) continue;
        timer.fn();
      }
      return delay;
    }
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  const children = Array.isArray(tree.children) ? tree.children : [tree.children];
  return [tree, ...children.flatMap(nodes)];
}

test("registering routed components is lazy and retains existing route aliases", () => {
  const f = fixture();
  const components = f.pages.components();
  assert.ok(components.LxmPageReconciliation);
  assert.ok(components.LxmPageLogin);
  assert.equal(Object.keys(components).length, f.pages.manifest.length);
  assert.equal(f.requests.length, 0);
  assert.equal(f.resources.length, 0);
  assert.equal(f.pages.pageFor("miniConfig").key, "miniDecor");
  assert.equal(f.pages.componentNameFor("miniConfig"), "LxmPageMiniDecor");
});

test("concurrent page visits share a load and successful resources are cached", async () => {
  const f = fixture();
  const first = f.pages.loadPage("reconciliation");
  const second = f.pages.loadPage("reconciliation");
  assert.equal(first, second);
  const component = await first;
  assert.match(component.template, /data-page-key="reconciliation"/);
  assert.match(component.template, /Loaded .*reconciliation\.html/);
  assert.equal(component.setup().loadedPage, "reconciliation");
  assert.equal(f.requests.length, 1);
  assert.equal(f.count("script"), 1);
  assert.equal(f.count("link"), 1);
  assert.equal(await f.pages.loadPage("reconciliation"), component);
  assert.equal(f.requests.length, 1);
  assert.equal(f.count("script"), 1);
  assert.equal(f.timers.size, 0);
});

test("a transient script failure removes its node and retries once", async () => {
  let scripts = 0;
  const f = fixture({ resourceOutcome(node) { return node.tagName === "SCRIPT" && ++scripts === 1 ? "error" : "load"; } });
  await f.pages.loadPage("reconciliation");
  const attempts = f.resources.filter((node) => node.tagName === "SCRIPT");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].removed, true);
  assert.equal(attempts[1].removed, undefined);
  assert.equal(f.pages.pageFor("reconciliation").setup().loadedPage, "reconciliation");
  assert.equal(f.timers.size, 0);
});

test("a failed script is never treated as loaded and a later visit can recover", async () => {
  const f = fixture({ resourceOutcome: (node) => node.tagName === "SCRIPT" ? "error" : "load" });
  await assert.rejects(f.pages.loadPage("reconciliation"), /script|脚本/i);
  assert.equal(f.count("script"), 2, "one automatic retry follows the initial failure");
  assert.ok(f.resources.filter((node) => node.tagName === "SCRIPT").every((node) => node.removed));
  f.controls.resourceOutcome = () => "load";
  const component = await f.pages.loadPage("reconciliation");
  assert.match(component.template, /reconciliation/);
  assert.equal(f.count("script"), 3);
  const scripts = f.resources.filter((node) => node.tagName === "SCRIPT");
  assert.equal(new Set(scripts.map((node) => node.src)).size, 3, "manual recovery also avoids a previous failed request URL");
  assert.equal(new Set(scripts.map((node) => node.dataset.pageScript)).size, 1, "the cache keeps one canonical resource identity");
  assert.equal(f.timers.size, 0);
});

test("a script response that does not register its page fails and remains retryable", async () => {
  const f = fixture({ registerScript: false });
  await assert.rejects(f.pages.loadPage("reconciliation"), /not registered/);
  assert.equal(f.count("script"), 2);
  assert.ok(f.resources.filter((node) => node.tagName === "SCRIPT").every((node) => node.removed));
  f.controls.registerScript = true;
  await f.pages.loadPage("reconciliation");
  assert.equal(f.count("script"), 3);
});

test("failed styles are removed and their automatic retry is awaited", async () => {
  let styles = 0;
  const f = fixture({ resourceOutcome(node) { return node.tagName === "LINK" && ++styles === 1 ? "error" : "load"; } });
  await f.pages.loadPage("reconciliation");
  const attempts = f.resources.filter((node) => node.tagName === "LINK");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].removed, true);
  assert.equal(f.timers.size, 0);
});

test("template errors retry once and a failed page can be loaded again", async () => {
  const f = fixture({ fetch: async () => ({ ok: false, status: 503, text: async () => "unavailable" }) });
  await assert.rejects(f.pages.loadPage("reconciliation"));
  assert.equal(f.requests.length, 2);
  f.controls.fetch = async () => ({ ok: true, status: 200, text: async () => "<div>Recovered template</div>" });
  assert.match((await f.pages.loadPage("reconciliation")).template, /Recovered template/);
  assert.equal(f.requests.length, 3);
  assert.equal(new Set(f.requests.map((request) => request.url)).size, 3);
  assert.equal(f.timers.size, 0);
});

test("template body stalls are timed out and aborted before retry", async () => {
  const f = fixture({ fetch: async (request, attempt) => ({
    ok: true, status: 200,
    text: () => attempt > 1 ? Promise.resolve("<div>Retried template</div>") : new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted response body")), { once: true });
    })
  }) });
  const promise = f.pages.loadPage("reconciliation");
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.expire(), 10000);
  assert.match((await promise).template, /Retried template/);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.requests.length, 2);
  assert.equal(f.timers.size, 0);
});

test("stalled scripts have a timeout and their removed nodes cannot prevent retry", async () => {
  let scripts = 0;
  const f = fixture({ resourceOutcome(node) { return node.tagName === "SCRIPT" && ++scripts === 1 ? "hang" : "load"; } });
  const promise = f.pages.loadPage("reconciliation");
  await settle();
  assert.equal(f.expire(), 10000);
  await promise;
  assert.equal(f.count("script"), 2);
  const scriptNodes = f.resources.filter((node) => node.tagName === "SCRIPT");
  assert.notEqual(scriptNodes[0].src, scriptNodes[1].src, "a retry cannot join the browser's still-pending original download");
  assert.ok(f.resources.find((node) => node.tagName === "SCRIPT").removed);
  assert.equal(f.timers.size, 0);
});

test("legacy loadAll limits the number of pages loading concurrently", async () => {
  let active = 0, maximum = 0;
  const f = fixture({ fetch: async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await settle();
    active -= 1;
    return { ok: true, status: 200, text: async () => "<div>Loaded page</div>" };
  } });
  await f.pages.loadAll();
  assert.ok(maximum <= 4, `observed ${maximum} concurrent page requests`);
  assert.equal(f.requests.length, f.pages.manifest.length);
  assert.equal(f.count("script"), f.pages.manifest.length);
  assert.equal(f.timers.size, 0);
});

test("a lazy wrapper shows a recoverable error and retries from its button", async () => {
  const f = fixture({ resourceOutcome: (node) => node.tagName === "SCRIPT" ? "error" : "load" });
  const wrapper = f.pages.components().LxmPageReconciliation;
  const render = wrapper.setup();
  assert.equal(f.requests.length, 0, "setup does not request resources before mounting");
  assert.ok(nodes(render()).some((node) => node.props.role === "status"));
  for (const mount of f.mounted) mount();
  await settle();
  const failed = nodes(render());
  assert.ok(failed.some((node) => node.props.role === "alert"));
  const retry = failed.find((node) => node.type === "button");
  assert.ok(retry, "failure exposes a retry button");
  assert.equal(retry.children, "重新加载");
  f.controls.resourceOutcome = () => "load";
  await retry.props.onClick();
  await settle();
  const loaded = nodes(render());
  assert.ok(loaded.some((node) => node.type && typeof node.type === "object" && /reconciliation/.test(node.type.template || "")));
  assert.equal(loaded.some((node) => node.props.role === "alert"), false);
});

test("navigating away during loading does not render into the old wrapper", async () => {
  let finishBody;
  const f = fixture({ fetch: async () => ({ ok: true, status: 200,
    text: () => new Promise((resolve) => { finishBody = resolve; })
  }) });
  const wrapper = f.pages.components().LxmPageReconciliation;
  const oldRender = wrapper.setup();
  f.mounted[0]();
  await settle();
  f.unmounted[0]();
  finishBody("<div>Completed after navigating away</div>");
  await settle();
  assert.equal(nodes(oldRender()).some((node) => typeof node.type === "object"), false);
  const nextRender = wrapper.setup();
  f.mounted[1]();
  await settle();
  assert.ok(nodes(nextRender()).some((node) => node.type && typeof node.type === "object"
    && /Completed after navigating away/.test(node.type.template || "")));
  assert.equal(f.requests.length, 1, "a later visit reuses the completed page load");
  assert.equal(f.timers.size, 0);
});
