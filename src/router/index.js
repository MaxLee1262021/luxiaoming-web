window.LXM_PAGES = (() => {
  const manifest = [
  ...[
    ['svcGeneralWorkbench', 'general-workbench'], ['svcWorkbench', 'workbench'], ['productLinks', 'product-links'], ['svcIntake', 'intake'], ['svcFollowup', 'followup'], ['svcComplaints', 'complaints'],
    ['svcRules', 'rules'], ['svcLedger', 'ledger'], ['svcSettlements', 'settlements'], ['svcStaff', 'staff'], ['svcMine', 'mine']
  ].map(([key, slug]) => ({ key, folder: 'service/' + slug, slug, component: 'LxmPage' + key[0].toUpperCase() + key.slice(1) })),
  {
    "key": "login",
    "folder": "login",
    "slug": "login",
    "component": "LxmPageLogin"
  },
  {
    "key": "dashboard",
    "folder": "operation/dashboard",
    "slug": "operation-dashboard",
    "component": "LxmPageOperationDashboard"
  },
  {
    "key": "performance",
    "folder": "operation/performance",
    "slug": "operation-performance",
    "component": "LxmPageOperationPerformance"
  },
  {
    "key": "trace",
    "folder": "operation/trace",
    "slug": "operation-trace",
    "component": "LxmPageOperationTrace"
  },
  {
    "key": "orders",
    "folder": "orders/order-list",
    "slug": "order-list",
    "component": "LxmPageOrderList"
  },
  {
    "key": "receive",
    "folder": "orders/receive",
    "slug": "receive",
    "component": "LxmPageReceive"
  },
  {
    "key": "dispatch",
    "folder": "orders/dispatch",
    "slug": "dispatch",
    "component": "LxmPageDispatch"
  },
  {
    "key": "tasks",
    "folder": "orders/task",
    "slug": "task",
    "component": "LxmPageTask"
  },
  {
    "key": "afterSales",
    "folder": "orders/after-sale",
    "slug": "after-sale",
    "component": "LxmPageAfterSale"
  },
  {
    "key": "financeReview",
    "folder": "finance/audit",
    "slug": "audit",
    "component": "LxmPageAudit"
  },
  {
    "key": "reconciliation",
    "folder": "finance/reconciliation",
    "slug": "reconciliation",
    "component": "LxmPageReconciliation"
  },
  {
    "key": "report",
    "folder": "finance/report",
    "slug": "report",
    "component": "LxmPageReport"
  },
  {
    "key": "staff",
    "folder": "channel/staff",
    "slug": "staff",
    "component": "LxmPageStaff"
  },
  {
    "key": "distributors",
    "folder": "channel/distributor",
    "slug": "distributor",
    "component": "LxmPageDistributor"
  },
  {
    "key": "shareRules", "folder": "share/rules", "slug": "rules", "component": "LxmPageShareRules"
  },
  {
    "key": "shareDetails", "folder": "share/details", "slug": "details", "component": "LxmPageShareDetails"
  },
  {
    "key": "shareMine", "folder": "share/mine", "slug": "mine", "component": "LxmPageShareMine"
  },
  { "key": "photoRules", "folder": "photo-share/rules", "slug": "rules", "component": "LxmPagePhotoRules"
  },
  { "key": "photoLedger", "folder": "photo-share/ledger", "slug": "ledger", "component": "LxmPagePhotoLedger"
  },
  { "key": "photoSettlement", "folder": "photo-share/settlement", "slug": "settlement", "component": "LxmPagePhotoSettlement"
  },
  { "key": "photoParty", "folder": "photo-share/party", "slug": "party", "component": "LxmPagePhotoParty"
  },
  { "key": "photoMine", "folder": "photo-share/mine", "slug": "mine", "component": "LxmPagePhotoMine"
  },
  {
    "key": "contentOverview",
    "folder": "content/overview",
    "slug": "overview",
    "component": "LxmPageContentOverview"
  },
  {
    "key": "spots",
    "folder": "content/spot",
    "slug": "spot",
    "component": "LxmPageSpot"
  },
  {
    "key": "cities",
    "folder": "content/city",
    "slug": "city",
    "component": "LxmPageCity"
  },
  {
    "key": "series",
    "folder": "content/series",
    "slug": "series",
    "component": "LxmPageSeries"
  },
  {
    "key": "albums",
    "folder": "content/album",
    "slug": "album",
    "component": "LxmPageAlbum"
  },
  {
    "key": "samples",
    "folder": "content/photo",
    "slug": "photo",
    "component": "LxmPagePhoto"
  },
  {
    "key": "packages",
    "folder": "content/package",
    "slug": "package",
    "component": "LxmPagePackage"
  },
  {
    "key": "shelfProducts",
    "folder": "content/shelf-products",
    "slug": "shelf-products",
    "component": "LxmPageShelfProducts"
  },
  {
    "key": "contentTags",
    "folder": "content/tag",
    "slug": "tag",
    "component": "LxmPageTag"
  },
  {
    "key": "productAudit",
    "folder": "content/audit",
    "slug": "content-audit",
    "component": "LxmPageContentAudit"
  },
  {
    "key": "addonServices",
    "folder": "content/addon-service",
    "slug": "addon-service",
    "component": "LxmPageAddonService"
  },
  {
    "key": "peripherals",
    "folder": "content/peripheral",
    "slug": "peripheral",
    "component": "LxmPagePeripheral"
  },
  {
    "key": "videoSingles",
    "folder": "content/videoSingle",
    "slug": "videoSingle",
    "component": "LxmPageVideoSingle"
  },
  {
    "key": "bookingConfig",
    "folder": "operationConfig/booking-config",
    "slug": "booking-config",
    "component": "LxmPageBookingConfig"
  },
  {
    "key": "miniDecor",
    "folder": "operationConfig/mini-decor",
    "slug": "mini-decor",
    "component": "LxmPageMiniDecor"
  },
  {
    "key": "guides",
    "folder": "operationConfig/guide",
    "slug": "guide",
    "component": "LxmPageGuide"
  },
  {
    "key": "stories",
    "folder": "operationConfig/story",
    "slug": "story",
    "component": "LxmPageStory"
  },
  {
    "key": "logs",
    "folder": "system/log",
    "slug": "log",
    "component": "LxmPageLog"
  },
  {
    "key": "permissions",
    "folder": "system/permissions",
    "slug": "permissions",
    "component": "LxmPagePermissions"
  },
  {
    "key": "trash",
    "folder": "system/trash",
    "slug": "trash",
    "component": "LxmPageTrash"
  }
];
  const registry = {};
  const resourceLoads = new Map();
  const resourceAttempts = new Map();
  const pageLoads = new Map();
  const resourceTimeout = 10000;

  function register(meta) {
    if (meta && meta.key) registry[meta.key] = { ...(registry[meta.key] || {}), ...meta };
  }

  function assetPath(page, ext) {
    return `${page.slug}.${ext}`;
  }

  function cachedLoad(cache, key, load) {
    if (!cache.has(key)) {
      const pending = Promise.resolve().then(load).catch((error) => {
        cache.delete(key);
        throw error;
      });
      cache.set(key, pending);
    }
    return cache.get(key);
  }

  async function retryResource(load) {
    try {
      return await load();
    } catch (_) {
      // A failed attempt must finish cleaning up before creating its replacement.
      return load();
    }
  }

  function requestPath(src) {
    const attempt = resourceAttempts.get(src) || 0;
    resourceAttempts.set(src, attempt + 1);
    // Removing a timed-out script does not always cancel its download. Use a new
    // URL so the browser cannot attach the retry to that still-pending request.
    return attempt ? `${src}?__lxm_retry=${attempt}` : src;
  }

  function loadElement(src, kind, page) {
    return cachedLoad(resourceLoads, src, () => retryResource(() => new Promise((resolve, reject) => {
      const style = kind === 'style';
      const element = document.createElement(style ? 'link' : 'script');
      const request = requestPath(src);
      if (style) {
        element.rel = 'stylesheet';
        element.href = request;
        element.dataset.pageStyle = src;
      } else {
        element.src = request;
        element.dataset.pageScript = src;
      }
      const finish = (error) => {
        clearTimeout(timer);
        element.onload = element.onerror = null;
        if (error) {
          element.remove();
          reject(error);
        } else resolve();
      };
      const failure = (reason) => new Error(`Failed to load page ${kind}: ${src}${reason ? ` (${reason})` : ''}`);
      const timer = setTimeout(() => finish(failure('timeout')), resourceTimeout);
      element.onload = () => finish(!style && !registry[page.key] ? failure('page not registered') : null);
      element.onerror = () => finish(failure());
      if (style) {
        // Shared operations styles must stay after asynchronously loaded page CSS.
        const sharedLayer = document.head.querySelector('link[data-admin-ops]');
        if (sharedLayer) document.head.insertBefore(element, sharedLayer);
        else document.head.appendChild(element);
      } else document.body.appendChild(element);
    })));
  }

  function loadTemplate(src) {
    return cachedLoad(resourceLoads, src, () => retryResource(() => {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Failed to load page template: ${src} (timeout)`));
          controller.abort();
        }, resourceTimeout);
      });
      const request = Promise.resolve().then(async () => {
        const response = await fetch(requestPath(src), { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to load page template: ${src} (HTTP ${response.status})`);
        return response.text();
      });
      // Keep the timeout active while reading the body, including stalled transfers.
      return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
    }));
  }

  function resolvePage(key) {
    if (key === 'miniConfig') key = 'miniDecor';
    if (key === 'svcStaffNew') key = 'svcStaff';
    if (key === 'photoNew') key = 'photoParty';
    return manifest.find((item) => item.key === key) || manifest.find((item) => item.key === 'dashboard');
  }

  function pageComponent(page, template) {
    return {
      name: page.component,
      template: `<section class="page-route page-route-${page.slug}" data-page-key="${page.key}">${template}</section>`,
      setup() {
        const ctx = Vue.inject('lxm');
        const pageMeta = pageFor(page.key);
        const pageSetup = typeof pageMeta.setup === 'function' ? pageMeta.setup(ctx, pageMeta) : {};
        return { ...ctx, pageMeta, ...pageSetup };
      }
    };
  }

  function loadPage(key) {
    const page = resolvePage(key);
    return cachedLoad(pageLoads, page.key, async () => {
      const base = `./src/views/${page.folder}/`;
      const resources = await Promise.allSettled([
        loadElement(base + assetPath(page, 'css'), 'style', page),
        loadTemplate(base + assetPath(page, 'html')),
        loadElement(base + assetPath(page, 'js'), 'script', page)
      ]);
      const failure = resources.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      return pageComponent(page, resources[1].value);
    });
  }

  async function loadAll() {
    const failures = [];
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < manifest.length) {
        const page = manifest[next++];
        try {
          await loadPage(page.key);
        } catch (err) {
          failures.push(page.key);
          console.warn(`[router] 页面 ${page.key} 加载失败：${err && err.message}`);
        }
      }
    }));
    if (failures.length) console.warn(`[router] 共 ${failures.length} 个页面加载失败：${failures.join('、')}`);
    return failures;
  }

  function componentNameFor(key) {
    return resolvePage(key).component;
  }

  function pageFor(key) {
    const page = resolvePage(key);
    return { ...page, ...(registry[page.key] || {}) };
  }

  function components() {
    return Object.fromEntries(manifest.map((page) => [
      page.component,
      {
        name: `${page.component}Loader`,
        setup() {
          const component = Vue.shallowRef(null);
          const loading = Vue.ref(true);
          const failed = Vue.ref(false);
          let active = true;
          async function reload() {
            loading.value = true;
            failed.value = false;
            try {
              const loaded = await loadPage(page.key);
              if (active) component.value = loaded;
            } catch (error) {
              if (active) {
                failed.value = true;
                console.warn(`[router] 页面 ${page.key} 加载失败：${error && error.message}`);
              }
            } finally {
              if (active) loading.value = false;
            }
          }
          Vue.onMounted(reload);
          Vue.onBeforeUnmount(() => { active = false; });
          return () => {
            if (component.value) return Vue.h(component.value);
            return Vue.h('div', { class: 'empty-state', role: failed.value ? 'alert' : 'status' }, [
              Vue.h('p', loading.value ? '正在加载页面…' : '页面加载失败，请检查网络连接后重试。'),
              failed.value ? Vue.h('button', { type: 'button', onClick: reload }, '重新加载') : null
            ]);
          };
        }
      }
    ]));
  }

  return { manifest, registry, register, loadPage, loadAll, componentNameFor, pageFor, components };
})();
