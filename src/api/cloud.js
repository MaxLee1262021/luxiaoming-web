// 后台数据接入客户端：把后台数据池对接到 /api 接口。
// 两种运行模式都会在同源 /api 下提供接口：
//   - 开发/演示（npm run dev，serve.cjs 挂载 json 模式）：/api 读 server/data/db.json，保存写回 db.json；
//   - 生产（npm run server，server/index.cjs 挂 mysql/cloud 模式）：/api 读真实数据库。
// 若接口不可用（如直接双击打开 index.html 而没有起服务），拉取失败会保留本地演示数据，不阻塞页面。
// loadAdminData(data, state) 在 src/app.js 的 setup 里被调用，逐键拉取真实数据并写入响应式数据池。
(function () {
  const cfg = window.LXM_API_CONFIG || { base: "/api", dataKeys: [], stateKeys: [] };

  // 云模式探测：/api/health 在两种模式下都会返回 { ok, mode }。
  // 据此设置 window.LXM_CLOUD_MODE，保存逻辑用它判断是否把改动写回云。
  window.LXM_CLOUD_MODE = "mock";
  try {
    fetch(`${cfg.base}/health`)
      .then((r) => r.json())
      .then((j) => { window.LXM_CLOUD_MODE = (j && j.mode) || "mock"; window.dispatchEvent(new CustomEvent("lxm-cloud-mode", { detail: window.LXM_CLOUD_MODE })); })
      .catch(() => { window.LXM_CLOUD_MODE = "mock"; });
  } catch (e) {
    window.LXM_CLOUD_MODE = "mock";
  }

  async function getColl(key) {
    const r = await fetch(`${cfg.base}/collection/${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error("接口返回 " + r.status);
    return await r.json();
  }
  // 读取单条文档（用于 config/homeStats 这类"按固定 id 存的配置文档"）
  async function getDoc(key, id) {
    const r = await fetch(`${cfg.base}/collection/${encodeURIComponent(key)}/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return await r.json();
  }
  async function create(key, doc) {
    const r = await fetch(`${cfg.base}/collection/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc || {})
    });
    return r.json();
  }
  async function update(key, id, doc) {
    const r = await fetch(`${cfg.base}/collection/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc || {})
    });
    return r.json();
  }
  // 有则更新、无则创建（用 .set）。用于首页配置这类"按固定 id 存的配置文档"。
  async function upsertDoc(key, id, doc) {
    const r = await fetch(`${cfg.base}/doc/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc || {})
    });
    return r.json();
  }
  async function remove(key, id) {
    const r = await fetch(`${cfg.base}/collection/${encodeURIComponent(key)}/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
    return r.json();
  }

  // 把云数据库返回的文档规范化：云用 _id，前台代码统一用 id。补上 id 让前台列表/编辑照常工作。
  function normalizeIds(val) {
    if (Array.isArray(val)) {
      val.forEach((d) => { if (d && d._id && !d.id) d.id = d._id; });
    }
    return val;
  }

  // 逐键把接口数据写入后台响应式数据池；某键拉取失败则保留本地默认值，不阻塞整体。
  async function loadAdminData(data, state) {
    const all = cfg.dataKeys.concat(cfg.stateKeys, cfg.docKeys || []);
    for (const key of all) {
      try {
        // 首页配置是"按固定 id(homeStats)存的文档"，不是集合数组，单独读文档对象。
        // 云端文档顶部是小程序读取的形状；后台编辑器模型存在 editorConfig 字段里（小程序忽略它），读回时用它无损还原。
        if (key === "homeConfig") {
          const doc = await getDoc("homeConfig", "homeStats");
          if (doc && doc.editorConfig && state && state.homeConfig !== undefined) {
            state.homeConfig = doc.editorConfig;
          }
          continue;
        }
        // 小程序全局配置：按固定 id("global") 存的「单文档」，doc 本身就是编辑器模型，
        // 直接赋给 state.siteConfig，打开页面即读到真实配置（保存也走 upsertDoc 落库）。
        if (key === "siteConfig") {
          const doc = await getDoc("siteConfig", "global");
          if (doc && state && state.siteConfig !== undefined) {
            state.siteConfig = doc;
          }
          continue;
        }
        const val = normalizeIds(await getColl(key));
        if (val === undefined || val === null) continue;
        // 安全：staff / shops 含 password 字段，下发到前端会暴露凭据，这里剥离后再进数据池。
        // 登录校验走 /api/auth/login（后端 scrypt 比对），前端页面无需持有明文密码。
        const safe = (key === "staff" || key === "shops") && Array.isArray(val)
          ? val.map(({ password, ...rest }) => rest)
          : val;
        if (cfg.stateKeys.includes(key)) {
          if (state && state[key] !== undefined) state[key] = safe;
        } else {
          if (data && data[key] !== undefined) data[key] = safe;
        }
      } catch (e) {
        // 直接打开 index.html 而没有起后端服务时，fetch /api 失败或被浏览器以 HTML 兜底，
        // r.json() 会抛错 — 这是预期行为，使用本地演示数据即可，无需刷屏误导。
        if (!(e instanceof SyntaxError && e.message && e.message.includes('<'))) {
          console.warn("[cloud] 加载", key, "失败，使用本地默认值", e);
        }
      }
    }
  }

  window.LXM_CLOUD = { getColl, getDoc, create, update, upsertDoc, remove, loadAdminData, mode: () => window.LXM_CLOUD_MODE };
})();
