// 内容页数据源切换：演示数据或已登录的真实后台。
// 请求经过 cloud.js 的统一 HTTP 客户端，自动带 Bearer 并在 401 时失效会话。
window.LXM_API = (() => {
  const KEY = "lxm_remote_on";

  function remoteOn() {
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }
  function setRemote(on) {
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
  }

  async function loadCollection(name) {
    if (!remoteOn()) return null;
    if (!window.LXM_AUTH?.hasSession()) throw new Error("需要登录后读取管理数据");
    const r = await window.LXM_HTTP.request(`/api/collection/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`载入 ${name} 失败 ${r.status}`);
    return await r.json();
  }

  async function saveDoc(name, doc) {
    if (!remoteOn()) return { skipped: true };
    if (!window.LXM_AUTH?.hasSession()) throw new Error("需要登录后写入管理数据");
    const id = doc._id || doc.id;
    const url = id ? `/api/collection/${encodeURIComponent(name)}/${encodeURIComponent(id)}` : `/api/collection/${encodeURIComponent(name)}`;
    const method = id ? "PUT" : "POST";
    const r = await window.LXM_HTTP.request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc)
    });
    if (!r.ok) throw new Error(`保存 ${name} 失败 ${r.status}`);
    return await r.json();
  }

  async function deleteDoc(name, id) {
    if (!remoteOn()) return { skipped: true };
    if (!window.LXM_AUTH?.hasSession()) throw new Error("需要登录后删除管理数据");
    const r = await window.LXM_HTTP.request(`/api/collection/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`删除 ${name} 失败 ${r.status}`);
    return true;
  }

  async function health() {
    try { const r = await window.LXM_HTTP.nativeFetch(`/api/health`, { credentials: "same-origin" }); return r.ok; } catch (e) { return false; }
  }

  return { remoteOn, setRemote, loadCollection, saveDoc, deleteDoc, health };
})();
