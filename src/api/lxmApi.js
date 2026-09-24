// 内容页数据源切换：演示数据或已登录的真实后台。
// 请求经过 cloud.js 的统一 HTTP 客户端，自动带 Bearer 并在 401 时失效会话。
window.LXM_API = (() => {
  const KEY = "lxm_remote_on";
  const base = String((window.LXM_API_CONFIG && window.LXM_API_CONFIG.base) || "/api").replace(/\/$/, "");

  function remoteOn() {
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }
  function setRemote(on) {
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
  }

  function cloud() {
    if (!window.LXM_CLOUD) throw new Error("管理接口尚未初始化");
    return window.LXM_CLOUD;
  }

  async function loadCollection(name) {
    if (!remoteOn()) return null;
    if (!window.LXM_AUTH?.hasSession()) throw new Error("需要登录后读取管理数据");
    return cloud().getColl(name);
  }

  async function saveDoc(name, doc) {
    if (!remoteOn()) return { skipped: true };
    if (!window.LXM_AUTH?.hasSession()) throw new Error("需要登录后写入管理数据");
    const id = doc._id || doc.id;
    return id ? cloud().update(name, id, doc) : cloud().create(name, doc);
  }

  async function deleteDoc(name, id) {
    if (!remoteOn()) return { skipped: true };
    if (!window.LXM_AUTH?.hasSession()) throw new Error("需要登录后删除管理数据");
    return cloud().remove(name, id);
  }

  async function health() {
    try { const r = await window.LXM_HTTP.nativeFetch(`${base}/health`, { credentials: "same-origin" }); return r.ok; } catch (e) { return false; }
  }

  return { remoteOn, setRemote, loadCollection, saveDoc, deleteDoc, health };
})();
