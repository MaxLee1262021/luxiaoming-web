// Shared browser upload client. Application sessions are sent only to the API.
(function () {
  "use strict";
  const jobs = window.Vue.reactive([]);
  const preview = window.Vue.reactive({ open: false, loading: false, url: "", type: "image", name: "", error: "" });
  let previewVersion = 0;
  const work = new Map();
  const locks = new Set();
  const base = String(window.LXM_API_CONFIG?.base || "/api").replace(/\/$/, "");
  const imageTypes = ["image/jpeg", "image/png", "image/webp"];
  function message(type, text) { window.ElementPlus?.ElMessage?.[type]?.(text); }
  async function api(path, body) {
    const response = await window.LXM_HTTP.request(base + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error?.message || result.error || result.message || "文件请求失败");
    return result.data || result;
  }
  function validate(file, options) {
    const isImage = imageTypes.includes(file.type);
    const video = file.type === "video/mp4";
    const allowVideo = ["content", "order-delivery"].includes(options.purpose);
    if (!isImage && !(allowVideo && video)) throw new Error(allowVideo ? "支持 JPG、PNG、WebP 和 MP4" : "请选择 JPG、PNG 或 WebP 图片");
    if (options.imagesOnly && !isImage) throw new Error("请选择图片文件");
    if (options.videoOnly && !video) throw new Error("请选择 MP4 视频");
    const max = options.purpose === "avatar" ? 5 : video ? 500 : options.purpose === "order-delivery" ? 50 : 20;
    if (!file.size || file.size > max * 1024 * 1024) throw new Error(`文件不能为空且不能超过 ${max} MiB`);
    if (options.purpose === "avatar" && !isImage) throw new Error("头像必须是图片");
    return max;
  }
  function sendToOss(file, intent, progress) {
    return new Promise((resolve, reject) => {
      const target = new URL(intent.uploadUrl);
      if (target.protocol !== "https:") return reject(new Error("上传地址必须使用 HTTPS"));
      const xhr = new XMLHttpRequest();
      xhr.open("POST", target.href);
      xhr.withCredentials = false;
      xhr.timeout = 20 * 60 * 1000;
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 95)); };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`文件上传失败（${xhr.status}），请重试`));
      xhr.onerror = () => reject(new Error("上传网络中断，请重试"));
      xhr.ontimeout = () => reject(new Error("上传超时，请重试"));
      const form = new FormData();
      Object.entries(intent.fields || {}).forEach(([key, value]) => form.append(key, String(value)));
      form.append("file", file, file.name);
      xhr.send(form);
    });
  }
  async function run(job) {
    if (job.status === "uploading") return null;
    const task = work.get(job.id);
    if (!task) return null;
    job.status = "uploading"; job.error = "";
    try {
      if (!task.completed) {
        const { purpose, collection, recordId, orderId } = task.options;
        if (!task.intent || !task.sent) {
          task.intent = await api("/files/upload-intent", { purpose, collection, recordId, orderId, fileName: task.file.name, mimeType: task.file.type, size: task.file.size });
          await sendToOss(task.file, task.intent, (value) => { job.progress = value; });
          task.sent = true;
        }
        task.completed = await api(`/files/${encodeURIComponent(task.intent.fileId)}/complete`);
      }
      if (task.options.onUploaded) await task.options.onUploaded(task.completed);
      job.status = "done"; job.progress = 100;
      work.delete(job.id);
      return task.completed;
    } catch (error) {
      job.status = "failed"; job.error = error.message || "上传失败";
      message("error", `${job.name}：${job.error}`);
      return null;
    }
  }
  async function upload(file, options) {
    if (busy()) { message("warning", "请等待当前上传完成"); return null; }
    try { validate(file, options); } catch (error) { message("warning", error.message); return null; }
    const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const job = window.Vue.reactive({ id, name: file.name, status: "queued", progress: 0, error: "" });
    jobs.push(job); work.set(id, { file, options });
    return run(job);
  }
  function pick(options) {
    if (busy()) { message("warning", "请等待当前上传完成"); return; }
    const input = document.createElement("input");
    input.type = "file"; input.multiple = !!options.multiple;
    input.accept = options.videoOnly ? "video/mp4" : options.imagesOnly ? imageTypes.join(",") : [...imageTypes, ...(["content", "order-delivery"].includes(options.purpose) ? ["video/mp4"] : [])].join(",");
    input.onchange = async () => { for (const file of Array.from(input.files || [])) await upload(file, options); };
    input.click();
  }
  const busy = () => jobs.some((job) => job.status === "uploading" || job.status === "queued");
  function ready() {
    if (busy()) { message("warning", "请等待文件上传完成后再保存"); return false; }
    if (jobs.some((job) => job.status === "failed")) { message("warning", "请重试或取消失败的上传后再保存"); return false; }
    return true;
  }
  function temporary(value) { return typeof value === "string" && /^(?:data:|blob:|wxfile:)/i.test(value); }
  function persistable(value) {
    if (typeof value === "string") return !temporary(value);
    if (Array.isArray(value)) return value.every(persistable);
    if (value && typeof value === "object") return Object.values(value).every(persistable);
    return true;
  }
  async function single(key, action) {
    if (locks.has(key)) return;
    locks.add(key);
    try { return await action(); } finally { locks.delete(key); }
  }
  async function open(file, download = false) {
    const id = typeof file === "string" ? file : file?.fileId || file?.id;
    const version = ++previewVersion;
    const tab = download ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    if (!download) Object.assign(preview, { open: true, loading: true, url: "", error: "", name: file?.name || "文件预览", type: file?.type || "image" });
    try {
      const result = await api(`/files/${encodeURIComponent(id)}/access`, { download });
      const url = new URL(result.url, window.location.href);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("文件地址无效");
      if (!download) {
        if (version !== previewVersion || !preview.open) return;
        Object.assign(preview, { loading: false, url: url.href, name: result.name || file?.name || "文件预览", type: result.type || (result.mimeType?.startsWith("video/") ? "video" : "image") });
      } else if (tab) tab.location = url.href;
      else message("warning", "浏览器阻止了下载窗口，请允许弹出窗口后重试");
    } catch (error) {
      if (tab) tab.close();
      if (!download && version === previewVersion) Object.assign(preview, { loading: false, error: error.message, url: "" });
      message("error", error.message);
    }
  }
  function closePreview() { previewVersion++; Object.assign(preview, { open: false, loading: false, url: "", error: "" }); }
  function dismiss(id) {
    const index = jobs.findIndex((job) => job.id === id && job.status !== "uploading");
    if (index >= 0) { jobs.splice(index, 1); work.delete(id); }
  }
  window.LXM_UPLOAD = { jobs, preview, closePreview, upload, pick, busy, ready, temporary, persistable, single, open, validate, retry: (id) => { const job = jobs.find((item) => item.id === id); if (job && !busy()) return run(job); }, dismiss };
})();
