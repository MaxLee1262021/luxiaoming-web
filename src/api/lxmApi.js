// 轻量真实后端服务层（鹿小鸣旅拍后台）。
// 设计原则：默认 REMOTE 关闭，前端继续用 app.js 内存态（演示），不触碰任何业务逻辑。
// 开启后：内容视图从 /api/collection/{name} 读写真实后端（server/index.cjs，端口 5192）。
// 所有方法在 REMOTE 关闭时均为安全 no-op，绝不影响原逻辑。
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
    const r = await fetch(`/api/collection/${name}`);
    if (!r.ok) throw new Error(`载入 ${name} 失败 ${r.status}`);
    return await r.json();
  }

  async function saveDoc(name, doc) {
    if (!remoteOn()) return { skipped: true };
    const id = doc._id || doc.id;
    const url = id ? `/api/collection/${name}/${id}` : `/api/collection/${name}`;
    const method = id ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc)
    });
    if (!r.ok) throw new Error(`保存 ${name} 失败 ${r.status}`);
    return await r.json();
  }

  async function deleteDoc(name, id) {
    if (!remoteOn()) return { skipped: true };
    const r = await fetch(`/api/collection/${name}/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`删除 ${name} 失败 ${r.status}`);
    return true;
  }

  async function health() {
    try { const r = await fetch(`/api/health`); return r.ok; } catch (e) { return false; }
  }

  return { remoteOn, setRemote, loadCollection, saveDoc, deleteDoc, health };
})();
