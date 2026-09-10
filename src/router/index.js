window.LXM_PAGES = (() => {
  const manifest = [
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
    "key": "shops",
    "folder": "channel/shop",
    "slug": "shop",
    "component": "LxmPageShop"
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
    "key": "miniDecor",
    "folder": "operationConfig/mini-decor",
    "slug": "mini-decor",
    "component": "LxmPageMiniDecor"
  },
  {
    "key": "miniConfig",
    "folder": "operationConfig/mini-config",
    "slug": "mini-config",
    "component": "LxmPageMiniConfig"
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
  const templates = {};
  const registry = {};

  function register(meta) {
    if (meta && meta.key) registry[meta.key] = { ...(registry[meta.key] || {}), ...meta };
  }

  function assetPath(page, ext) {
    return `${page.slug}.${ext}`;
  }

  function loadCss(href) {
    if (document.querySelector(`link[data-page-style="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.pageStyle = href;
    // Keep the shared operations layer last so asynchronously loaded page CSS
    // cannot reintroduce a different surface or focus treatment.
    const sharedLayer = document.head.querySelector('link[data-admin-ops]');
    if (sharedLayer) document.head.insertBefore(link, sharedLayer);
    else document.head.appendChild(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-page-script="${src}"]`)) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.dataset.pageScript = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load page script: ${src}`));
      document.body.appendChild(script);
    });
  }

  async function loadAll() {
    const failures = [];
    await Promise.all(manifest.map(async (page) => {
      try {
        const base = `./src/views/${page.folder}/`;
        loadCss(base + assetPath(page, 'css'));
        const response = await fetch(base + assetPath(page, 'html'));
        if (!response.ok) throw new Error(`Failed to load page template: ${page.key}`);
        templates[page.key] = await response.text();
        await loadScript(base + assetPath(page, 'js'));
      } catch (err) {
        // 单个页面加载失败不拖垮其他页面：记录并继续，避免 Promise.all 整体中断
        failures.push(page.key);
        console.warn(`[router] 页面 ${page.key} 加载失败：${err && err.message}`);
      }
    }));
    if (failures.length) console.warn(`[router] 共 ${failures.length} 个页面加载失败：${failures.join('、')}`);
  }

  function componentNameFor(key) {
    const page = manifest.find((item) => item.key === key) || manifest.find((item) => item.key === 'dashboard');
    return page.component;
  }

  function pageFor(key) {
    const page = manifest.find((item) => item.key === key) || manifest.find((item) => item.key === 'dashboard');
    return { ...page, ...(registry[page.key] || {}) };
  }

  function components() {
    return Object.fromEntries(manifest.map((page) => [
      page.component,
      {
        name: page.component,
        template: `<section class="page-route page-route-${page.slug}" data-page-key="${page.key}">${templates[page.key] || '<div class="empty-state">Page template loading</div>'}</section>`,
        setup() {
          const ctx = Vue.inject('lxm');
          const pageMeta = pageFor(page.key);
          const pageSetup = typeof pageMeta.setup === 'function' ? pageMeta.setup(ctx, pageMeta) : {};
          return { ...ctx, pageMeta, ...pageSetup };
        }
      }
    ]));
  }

  return { manifest, registry, register, loadAll, componentNameFor, pageFor, components };
})();
