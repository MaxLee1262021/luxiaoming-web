window.LXM_PAGES.register({
  key: "guides", component: "LxmPageGuide", group: "operationConfig", title: "旅拍灵感",
  description: "小程序旅拍灵感内容管理", styleScope: "page-route-guide",
  setup(ctx) {
    const { computed, ref } = window.Vue;
    const reactive = window.Vue.reactive || ctx.reactive || ((value) => value);
    const ui = reactive({ mode: "list", filter: "all", categoryFilter: "", form: {}, dirty: false, saving: false,
      savedAt: "", spotModal: false, spotKeyword: "", videoModal: false, videoUrl: "", preview: false, previewForm: null, loading: false, loadError: "", uploadIds: [] });
    const editorRef = ref(null);
    let savedRange = null;
    let formVersion = 0;
    const idOf = (row) => String(row && (row.id || row._id) || "");
    function writeAllowed(uploadOnly = false) {
      if (!ctx.can("contentEdit")) return false;
      if (ui.loading || ui.loadError) { ctx.ElMessage.warning("请先完成内容数据加载后重试"); return false; }
      if (!ctx.isServerConnected()) {
        // File storage is independent of guide-schema readiness. Keep uploads
        // usable when the authenticated API works but a new guide column is pending.
        if (uploadOnly && ctx.state.authSource === "server" && window.LXM_AUTH?.hasSession?.()
          && window.LXM_API_STATE?.transportReachable && window.LXM_API_STATE.dataError === "schema_incomplete") return true;
        if (window.LXM_API_STATE?.dataError === "schema_incomplete") { ctx.ElMessage.warning("数据库尚未补齐新版字段，当前内容未保存，请完成数据库更新后重试"); return false; }
        ctx.ElMessage.warning("服务端连接不可用，请恢复连接后重试；本次修改尚未保存"); return false;
      }
      return true;
    }
    function restoreRecord(row, previous) {
      Object.keys(row).forEach((key) => { if (!Object.prototype.hasOwnProperty.call(previous, key)) delete row[key]; });
      Object.assign(row, previous);
    }
    const escape = (value) => String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const textOf = (html) => {
      if (typeof document === "undefined") return String(html || "").replace(/<[^>]*>/g, " ").trim();
      const box = document.createElement("div"); box.innerHTML = html || "";
      return (box.textContent || "").replace(/\u200b/g, "").trim();
    };
    const safeUrl = (value) => /^(?:https?:\/\/[^\s<>"']+|\/(?!\/)[^\s<>"']*)$/i.test(String(value || "").trim()) ? String(value).trim() : "";
    // Keep pasted markup and preview on the same narrow surface as the server.
    function cleanHtml(html) {
      const box = document.createElement("div"); box.innerHTML = html || "";
      const allowed = new Set(["P", "DIV", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "B", "STRONG", "I", "EM", "U", "S", "UL", "OL", "LI", "BLOCKQUOTE", "HR", "IMG", "VIDEO", "SOURCE", "A"]);
      function clean(parent) {
        for (const node of Array.from(parent.childNodes)) {
          if (node.nodeType === 8) { node.remove(); continue; }
          if (node.nodeType !== 1) continue;
          if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE"].includes(node.tagName)) { node.remove(); continue; }
          clean(node);
          if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
          const src = safeUrl(node.getAttribute("src"));
          const poster = safeUrl(node.getAttribute("poster"));
          const alt = node.getAttribute("alt") || "";
          const attachment = node.tagName === "A" ? attachmentInfo(node) : null;
          Array.from(node.attributes).forEach((attr) => node.removeAttribute(attr.name));
          if (node.tagName === "A") {
            if (!attachment) { node.replaceWith(...node.childNodes); continue; }
            node.setAttribute("href", attachment.url);
            node.setAttribute("data-file-id", attachment.fileId); node.setAttribute("data-file-name", attachment.name);
            node.setAttribute("data-file-size", String(attachment.size)); node.setAttribute("data-file-type", attachment.mimeType);
            node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer");
            node.textContent = attachment.name;
          }
          if (["IMG", "VIDEO", "SOURCE"].includes(node.tagName)) {
            if (!src && node.tagName !== "VIDEO") { node.remove(); continue; }
            if (src) node.setAttribute("src", src);
            if (node.tagName === "IMG") node.setAttribute("alt", alt);
            if (node.tagName === "VIDEO") {
              node.setAttribute("controls", ""); node.setAttribute("playsinline", ""); node.setAttribute("preload", "metadata");
              if (poster) node.setAttribute("poster", poster);
              if (!src && !node.querySelector("source[src]")) node.remove();
            }
          }
        }
      }
      clean(box); return box.innerHTML;
    }
    function attachmentInfo(node) {
      const href = node.getAttribute("href") || "";
      const match = href.match(/^\/api\/media\/(file_[a-f0-9]{32,48})(?:\?download=(?:1|true))?$/i);
      if (!match || node.getAttribute("data-file-id") !== match[1]) return null;
      const size = Number(node.getAttribute("data-file-size") || 0);
      return { fileId: match[1], url: `/api/media/${match[1]}?download=1`, name: (node.getAttribute("data-file-name") || node.textContent || "附件").slice(0, 180),
        size: Number.isSafeInteger(size) && size > 0 ? size : 0, mimeType: node.getAttribute("data-file-type") || "" };
    }
    const spotIdsOf = (row) => [...new Set((typeof ctx.contentSpotIds === "function" ? ctx.contentSpotIds(row) : [row.spotId, ...(row.spotIds || [])]).filter(Boolean).map(String))];
    const spotLabel = (id) => (ctx.data.spots || []).find((spot) => idOf(spot) === String(id))?.name || "点位已失效";
    const isPublished = (row) => row.published === false ? false : !["草稿", "下架", "停用", "禁用", "draft", "offline", "disabled"].includes(String(row.status || "已发布").toLowerCase());
    const falseLike = (value) => value === false || value === 0 || ["false", "0"].includes(String(value).trim().toLowerCase());
    const frontVisible = (row) => ![row.isShow, row.visible, row.enabled].some(falseLike);
    const categoryOf = (row) => typeof row?.category === "string" ? row.category.trim() : "";
    const categoryOptions = computed(() => [...new Set((ctx.data.guides || [])
      .filter((row) => row && !row.deleted && !row.isDeleted).map(categoryOf).filter(Boolean))]);
    const guideTotal = computed(() => (ctx.data.guides || []).filter((row) => row && !row.deleted && !row.isDeleted).length);
    const guideRows = computed(() => {
      const keyword = String(ctx.state.filters.keyword || "").trim().toLowerCase();
      const spotId = String(ctx.state.filters.contentSpotId || "");
      return (ctx.data.guides || []).filter((row) => {
        if (!row || row.deleted || row.isDeleted) return false;
        const ids = spotIdsOf(row);
        return (!spotId || ids.includes(spotId)) && (ui.filter === "all" || (ui.filter === "published") === isPublished(row))
          && (!ui.categoryFilter || ui.categoryFilter === (categoryOf(row) ? `category:${categoryOf(row)}` : "uncategorized"))
          && (!keyword || [row.title, row.name, textOf(row.contentHtml || row.content || row.description), ...ids.map(spotLabel)].join(" ").toLowerCase().includes(keyword));
      }).slice().sort((a, b) => window.LXM_CONTENT_ORDER
        ? window.LXM_CONTENT_ORDER.compare("guides", a, b)
        : Number(!!b.isTop) - Number(!!a.isTop) || dateValue(b.updatedAt || b.createdAt) - dateValue(a.updatedAt || a.createdAt));
    });
    function dateValue(value) { const number = typeof value === "number" ? value : Date.parse(value || ""); return Number.isFinite(number) ? number : 0; }
    function timeLabel(value) {
      if (!dateValue(value)) return "暂无更新记录";
      return new Date(dateValue(value)).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }
    const validSpots = computed(() => (ctx.data.spots || []).filter((row) => row && !row.deleted && !row.isDeleted));
    function productMatchesSpot(product, spotId) {
      if (((product.includedItems || []).length || (product.items || []).length) && typeof ctx.contentSpotIds === "function") return ctx.contentSpotIds(product).map(String).includes(String(spotId));
      let ids = [product.spotId, ...(product.spotIds || [])].filter(Boolean).map(String);
      if (!ids.length && product.seriesId && !product.spotBindingExplicit) {
        const parent = (ctx.data.series || []).find((row) => idOf(row) === String(product.seriesId));
        ids = parent ? [parent.spotId, ...(parent.spotIds || [])].filter(Boolean).map(String) : [];
      }
      return ids.includes(String(spotId));
    }
    function availableProduct(row) {
      return row && !row.deleted && !row.isDeleted && row.isShow !== false && row.visible !== false && row.enabled !== false && row.isSellable !== false
        && !["草稿", "待审", "待审核", "驳回", "下架", "停用", "禁用", "已下", "已下架", "已下架商品", "draft", "pending", "reviewing", "rejected", "offline", "disabled", "down"].includes(String(row.status || row.saleStatus || "").toLowerCase())
        && (!(row.auditStatus || row.reviewStatus) || ["已上", "已上架", "审核通过", "通过", "approved", "pass", "passed", "published", "online"].includes(String(row.auditStatus || row.reviewStatus).toLowerCase()));
    }
    const allProducts = computed(() => [
      ...(ctx.data.albums || []).map((row) => ({ ...row, targetType: "album", typeLabel: "照片留影" })),
      ...(ctx.data.packages || []).map((row) => {
        const video = typeof ctx.isVideoSingleProduct === "function" ? ctx.isVideoSingleProduct(row) : row.type === "video" || row.isVideoSingle || row.productKind === "video_single";
        return { ...row, targetType: video ? "video" : "package", typeLabel: video ? "视频摄像" : "旅拍套餐" };
      })
    ].filter(availableProduct));
    const productsForSpot = (id) => allProducts.value.filter((row) => productMatchesSpot(row, id));
    const productGroups = computed(() => (ui.form.spotIds || []).map((id) => ({ id, name: spotLabel(id), products: productsForSpot(id) })));
    const spotChoices = computed(() => validSpots.value.filter((row) => !(ui.form.spotIds || []).includes(idOf(row))
      && (!ui.spotKeyword.trim() || [row.name, row.city, row.cityName].join(" ").toLowerCase().includes(ui.spotKeyword.trim().toLowerCase()))));
    function selectedProduct(form) {
      const id = form.targetProductId || form.targetPackageId;
      const type = form.targetProductType || (form.targetPackageId ? "package" : "");
      return allProducts.value.find((row) => idOf(row) === String(id) && row.targetType === type);
    }
    const pickedProduct = computed(() => selectedProduct(ui.form));
    const productLabel = (row) => selectedProduct(row)?.name || (row.targetProductId || row.targetPackageId ? "商品已失效" : "未关联商品");
    function selectProduct(spotId, row) {
      const selected = ui.form.targetProductSpotId === spotId && ui.form.targetProductId === idOf(row) && ui.form.targetProductType === row.targetType;
      Object.assign(ui.form, { targetProductSpotId: selected ? "" : spotId, targetProductId: selected ? "" : idOf(row), targetProductType: selected ? "" : row.targetType, targetPackageId: "" }); markDirty();
    }
    function clearProduct() { Object.assign(ui.form, { targetProductSpotId: "", targetProductId: "", targetProductType: "", targetPackageId: "" }); markDirty(); }
    function addSpot(row) { ui.form.spotIds.push(idOf(row)); ui.form.spotId = ui.form.spotIds[0] || ""; ui.spotModal = false; markDirty(); }
    function removeSpot(id) {
      ui.form.spotIds = ui.form.spotIds.filter((value) => value !== id); ui.form.spotId = ui.form.spotIds[0] || "";
      if (ui.form.targetProductSpotId === id) clearProduct(); markDirty();
    }
    function legacyHtml(row) {
      if (typeof row.contentHtml === "string") return row.contentHtml;
      const text = Array.isArray(row.content) ? row.content.join("\n\n") : row.content || row.description || "";
      const media = (Array.isArray(row.mediaItems) ? row.mediaItems : row.mediaUrls || []).map((item) => typeof item === "string" ? ({ url: item, type: row.mediaType === "video" || /\.(mp4|mov|webm)(\?|$)/i.test(item) ? "video" : "image" }) : item).filter(Boolean);
      return String(text).split(/\n\s*\n/).map((part) => `<p>${escape(part).replace(/\n/g, "<br>")}</p>`).join("")
        + media.filter((item) => safeUrl(item.url)).map((item) => item.type === "video" ? `<video src="${escape(item.url)}" controls playsinline></video>` : `<p><img src="${escape(item.url)}" alt=""></p>`).join("");
    }
    async function confirmLeave() {
      if (ui.saving || window.LXM_UPLOAD?.busy()) { ctx.ElMessage.warning("请等待保存或上传完成"); return false; }
      if (!ui.dirty) return true;
      try { await ctx.ElMessageBox.confirm("有未保存的修改，确定离开编辑页？", "离开编辑", { confirmButtonText: "离开", cancelButtonText: "继续编辑", type: "warning" }); return true; }
      catch (error) {
        if (error !== "cancel" && error !== "close" && error?.message !== "cancel") ctx.ElMessage.error("无法打开离开确认，请稍后重试");
        return false;
      }
    }
    async function openEditor(row = null, relations = {}) {
      if (!ctx.can("contentEdit")) return;
      if (ui.mode === "edit" && !(await confirmLeave())) return;
      formVersion++; savedRange = null;
      const source = row?.__source || row;
      const copy = source ? JSON.parse(JSON.stringify(source)) : {};
      delete copy.__source; delete copy.__key;
      const ids = source ? spotIdsOf(copy) : relations.spotIds || (relations.spotId ? [relations.spotId] : []);
      ui.form = { ...copy, title: copy.title || copy.name || "", category: categoryOf(copy), cover: copy.cover || copy.coverUrl || copy.image || "",
        contentHtml: source ? cleanHtml(legacyHtml(copy)) : "", spotIds: [...ids], spotId: ids[0] || "", isShow: source ? frontVisible(copy) : true,
        readCount: copy.readCount ?? copy.views ?? 0, score: copy.score ?? 0,
        isTop: copy.isTop === true, targetProductId: copy.targetProductId || copy.targetPackageId || "",
        targetProductType: copy.targetProductType || (copy.targetPackageId ? "package" : ""), targetProductSpotId: copy.targetProductSpotId || "" };
      if (!ui.form.targetProductSpotId && ui.form.targetProductId) ui.form.targetProductSpotId = ids.find((id) => productsForSpot(id).some((p) => idOf(p) === ui.form.targetProductId && p.targetType === ui.form.targetProductType)) || "";
      ui.mode = "edit"; ui.dirty = false; ui.savedAt = "";
      await window.Vue.nextTick();
      if (editorRef.value) editorRef.value.innerHTML = ui.form.contentHtml;
    }
    async function backToList() { if (await confirmLeave()) { ui.mode = "list"; formVersion++; } }
    function markDirty() { ui.dirty = true; }
    const wordCount = computed(() => textOf(ui.form.contentHtml).length);
    function editorInput() { if (editorRef.value) { ui.form.contentHtml = editorRef.value.innerHTML; markDirty(); } }
    function rememberSelection() {
      const selection = window.getSelection();
      if (selection?.rangeCount && editorRef.value?.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
    }
    function restoreSelection() {
      const editor = editorRef.value; if (!editor) return;
      editor.focus(); const selection = window.getSelection();
      const range = savedRange && editor.contains(savedRange.commonAncestorContainer) ? savedRange : document.createRange();
      if (range !== savedRange) { range.selectNodeContents(editor); range.collapse(false); }
      selection.removeAllRanges(); selection.addRange(range);
    }
    function insertHtml(html) { restoreSelection(); document.execCommand("insertHTML", false, html); editorInput(); rememberSelection(); }
    function format(command, value) { restoreSelection(); document.execCommand(command, false, value || null); editorInput(); rememberSelection(); }
    function insertMedia(url, type) {
      if (!safeUrl(url)) return;
      insertHtml(type === "video" ? `<video src="${escape(url)}" controls playsinline preload="metadata"></video><p><br></p>` : `<p><img src="${escape(url)}" alt=""></p><p><br></p>`);
    }
    const guideUploads = computed(() => (window.LXM_UPLOAD.jobs || []).filter((job) => ui.uploadIds.includes(job.id)));
    async function uploadFiles(files, cover = false, version = formVersion, kind = "", pickerRange = null) {
      if (version !== formVersion || ui.saving || !writeAllowed(true)) return;
      if (window.LXM_UPLOAD.busy()) { ctx.ElMessage.warning("请等待当前上传完成"); return; }
      const valid = Array.from(files || []).filter((file) => {
        if (cover && (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024)) { ctx.ElMessage.warning("封面请选择 5MB 以内的 JPG、PNG、WebP 图片"); return false; }
        if (!cover && file.type === "video/mp4" && file.size > 100 * 1024 * 1024) { ctx.ElMessage.warning("视频请选择 100MB 以内的 MP4 文件"); return false; }
        return true;
      });
      let insertionRange;
      if (!cover && editorRef.value) {
        const range = pickerRange || savedRange;
        insertionRange = range && editorRef.value.contains(range.commonAncestorContainer) ? range.cloneRange() : document.createRange();
        if (!range || !editorRef.value.contains(range.commonAncestorContainer)) { insertionRange.selectNodeContents(editorRef.value); insertionRange.collapse(false); }
      }
      const markers = new Map();
      const authSource = ctx.state.authSource;
      const active = () => version === formVersion && ui.mode === "edit" && authSource === ctx.state.authSource && ctx.can("contentEdit");
      return window.LXM_UPLOAD.uploadBatch(valid, { purpose: "content", collection: "guides", recordId: idOf(ui.form) || undefined,
        imagesOnly: cover || kind === "image", videoOnly: kind === "video", documentsOnly: kind === "file",
        onQueued(file, job) {
          ui.uploadIds.push(job.id);
          if (!insertionRange || !active()) return;
          const marker = document.createElement("span"); marker.setAttribute("data-guide-upload", job.id); marker.setAttribute("contenteditable", "false");
          marker.textContent = `上传中：${file.name}`;
          insertionRange.insertNode(marker); insertionRange.setStartAfter(marker); insertionRange.collapse(true);
          markers.set(job.id, marker); editorInput();
        },
        onUploaded(result, originalFile, job) {
          if (!active()) return;
          if (!safeUrl(result.url)) throw new Error("上传未返回有效文件地址，请重试");
          if (cover) { ui.form.cover = result.url; markDirty(); return; }
          const marker = markers.get(job.id);
          if (!marker || !editorRef.value?.contains(marker)) return;
          const type = result.type || (originalFile.type === "video/mp4" ? "video" : "image");
          let html;
          if (type === "file") {
            const id = result.fileId || result.id;
            if (!/^file_[a-f0-9]{32,48}$/i.test(id) || result.url.split("?")[0] !== `/api/media/${id}`) throw new Error("附件地址无效，请重试");
            html = `<a href="/api/media/${id}?download=1" data-file-id="${escape(id)}" data-file-name="${escape(result.name || originalFile.name)}" data-file-size="${Number(result.size || originalFile.size)}" data-file-type="${escape(result.mimeType || originalFile.type)}" target="_blank" rel="noopener noreferrer">${escape(result.name || originalFile.name)}</a>`;
          } else html = type === "video" ? `<video src="${escape(result.url)}" controls playsinline preload="metadata"></video>` : `<img src="${escape(result.url)}" alt="${escape(result.name || originalFile.name)}">`;
          const container = document.createElement("div"); container.innerHTML = html;
          marker.replaceWith(...Array.from(container.childNodes)); markers.delete(job.id); editorInput();
        },
        onFailed(error, file, job) {
          const marker = markers.get(job.id);
          if (active() && marker && editorRef.value?.contains(marker)) { marker.setAttribute("data-upload-failed", "true"); marker.textContent = `上传失败：${file.name}，请重试或移除`; editorInput(); }
        },
        onDismiss(file, job) {
          const marker = markers.get(job.id);
          if (active() && marker && editorRef.value?.contains(marker)) { marker.remove(); editorInput(); }
          markers.delete(job.id);
        }
      });
    }
    function pickFiles(kind) {
      rememberSelection();
      const version = formVersion;
      const range = savedRange?.cloneRange() || null;
      const input = document.createElement("input"); input.type = "file";
      input.accept = kind === "video" ? "video/mp4" : kind === "file" ? ".pdf,.docx,.xlsx,.pptx,.txt,.csv" : "image/jpeg,image/png,image/webp"; input.multiple = kind === "image" || kind === "file";
      input.onchange = () => { if (version !== formVersion) return; ui.videoModal = false; return uploadFiles(Array.from(input.files || []), kind === "cover", version, kind, range); }; input.click();
    }
    function pasteContent(event) {
      event.preventDefault(); rememberSelection();
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) return uploadFiles(files);
      const html = event.clipboardData?.getData("text/html");
      insertHtml(html ? cleanHtml(html) : escape(event.clipboardData?.getData("text/plain")).replace(/\n/g, "<br>"));
    }
    function dropFiles(event, cover = false) {
      if (!cover) {
        const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
        if (range && editorRef.value?.contains(range.startContainer)) savedRange = range;
      }
      uploadFiles(Array.from(event.dataTransfer?.files || []), cover);
    }
    function insertVideoUrl() {
      const url = safeUrl(ui.videoUrl);
      if (!url) return ctx.ElMessage.warning("请输入有效的 HTTP(S) 视频地址");
      insertMedia(url, "video"); ui.videoModal = false; ui.videoUrl = "";
    }
    function collectForm() {
      const html = cleanHtml(editorRef.value?.innerHTML ?? ui.form.contentHtml);
      const box = document.createElement("div"); box.innerHTML = html;
      const mediaItems = Array.from(box.querySelectorAll("img,video")).map((node) => ({ url: node.getAttribute("src") || node.querySelector("source")?.getAttribute("src") || "", type: node.tagName === "VIDEO" ? "video" : "image" })).filter((item) => item.url);
      const attachments = Array.from(box.querySelectorAll("a[data-file-id]")).map(attachmentInfo).filter(Boolean);
      const metricNumber = (value) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      return { ...ui.form, title: ui.form.title.trim(), name: ui.form.title.trim(), category: categoryOf(ui.form), cover: safeUrl(ui.form.cover), contentHtml: html,
        readCount: metricNumber(ui.form.readCount ?? ui.form.views ?? 0), score: metricNumber(ui.form.score ?? 0),
        content: textOf(html), description: textOf(html).slice(0, 200), mediaItems, mediaUrls: mediaItems.map((item) => item.url), attachments,
        mediaType: mediaItems.some((item) => item.type === "video") ? "video" : "image", spotId: ui.form.spotIds[0] || "", spotIds: [...ui.form.spotIds], seriesId: "",
        targetPackageId: ["package", "video"].includes(ui.form.targetProductType) ? ui.form.targetProductId : "" };
    }
    function validate(form) {
      if (!form.title) return "请填写标题";
      if (form.title.length > 50) return "标题不能超过 50 个字";
      if (form.category.length > 40) return "分类不能超过 40 个字";
      if (!Number.isSafeInteger(form.readCount) || form.readCount < 0 || form.readCount > 2147483647) return "初始浏览人数请填写 0–2147483647 之间的整数";
      if (!Number.isFinite(form.score) || form.score < 0 || form.score > 5 || !Number.isInteger(form.score * 10)) return "初始评分请填写 0–5 分，最多保留一位小数";
      if (!form.cover) return "请上传首页封面图";
      if (!textOf(form.contentHtml) && !form.mediaItems.length) return "正文内容不能为空";
      if (!form.spotIds.length || form.spotIds.some((id) => !validSpots.value.some((row) => idOf(row) === id))) return "请至少关联一个有效打卡点，并移除失效点位";
      if (form.targetProductId && (!form.spotIds.includes(form.targetProductSpotId) || !productsForSpot(form.targetProductSpotId).some((p) => idOf(p) === form.targetProductId && p.targetType === form.targetProductType))) return "原关联商品已失效，请重新选择或清除";
      return "";
    }
    async function saveArticle(publish) {
      if (!writeAllowed() || ui.saving || !window.LXM_UPLOAD.ready()) return false;
      const form = collectForm(); const error = validate(form);
      if (error) { ctx.ElMessage.warning(error); return false; }
      ui.saving = true;
      const version = formVersion;
      const authSource = ctx.state.authSource;
      try {
        const now = new Date().toISOString();
        const payload = { ...form, id: idOf(form) || `guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: publish ? "已发布" : "草稿", updatedAt: now, createdAt: form.createdAt || now };
        delete payload.__key; delete payload.__source; delete payload.published;
        delete payload.visible; delete payload.enabled;
        const saved = await ctx.pushContentToCloud("guides", payload);
        if (!saved) return false;
        if (version !== formVersion || authSource !== ctx.state.authSource || !ctx.can("contentEdit")) return false;
        const index = ctx.data.guides.findIndex((row) => idOf(row) === idOf(saved));
        if (index < 0) ctx.data.guides.unshift(saved); else Object.assign(ctx.data.guides[index], saved);
        ui.form = JSON.parse(JSON.stringify(saved)); ui.dirty = false; ui.savedAt = now; ui.preview = false;
        if (publish) ui.mode = "list";
        ctx.log(publish ? "发布旅拍灵感" : "保存旅拍灵感草稿", "旅拍灵感", saved.title);
        ctx.ElMessage.success(publish ? "发布成功" : "草稿已保存");
        return true;
      } finally { ui.saving = false; }
    }
    function openPreview(row) {
      ui.previewForm = row ? { ...row, contentHtml: cleanHtml(legacyHtml(row)) } : collectForm(); ui.preview = true;
    }
    async function mutate(row, patch, action) {
      if (!writeAllowed() || ui.saving) return;
      ui.saving = true; const previous = { ...row };
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      try { if (await ctx.persistContentMutation("guides", row, previous)) { ctx.log(action, "旅拍灵感", row.title || row.name); ctx.ElMessage.success(action); } else restoreRecord(row, previous); }
      finally { ui.saving = false; }
    }
    const toggleGuide = (row) => mutate(row, { isShow: !frontVisible(row), visible: !frontVisible(row), enabled: !frontVisible(row) }, frontVisible(row) ? "已在小程序前端隐藏" : "已在小程序前端显示");
    const pinGuide = (row) => mutate(row, { isTop: !row.isTop }, row.isTop ? "已取消置顶" : "已置顶");
    async function deleteGuide(row) {
      if (!writeAllowed() || ctx.state.role !== "super" || ui.saving || ctx.contentDeleteAllowed && !ctx.contentDeleteAllowed(row)) return;
      try { await ctx.ElMessageBox.confirm(`确定删除《${row.title || row.name || "未命名灵感"}》？删除后可在回收站查看。`, "确认删除", { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" }); } catch (_) { return; }
      ui.saving = true; const previous = { ...row };
      try {
        Object.assign(row, { deleted: true, isDeleted: true, isShow: false });
        if (!(await ctx.persistContentMutation("guides", row, previous))) { restoreRecord(row, previous); return; }
        const trash = { id: `trash-guide-${idOf(row)}-${Date.now()}`, type: "旅拍灵感", sourceKey: "guides", name: row.title || row.name, reason: "删除旅拍灵感", source: { ...row }, restorable: true, operator: ctx.currentOperatorName(), deletedAt: new Date().toISOString() };
        if (!(await ctx.persistTrashRecord(trash))) {
          restoreRecord(row, previous);
          const rollback = { ...previous, deleted: previous.deleted || false, isDeleted: previous.isDeleted || false };
          await ctx.persistContentMutation("guides", rollback);
          ctx.ElMessage.error("回收站保存失败，已撤销删除，请重试"); return;
        }
        ctx.log("删除旅拍灵感进入回收站", "旅拍灵感", row.title || row.name); ctx.ElMessage.success("已删除");
      } finally { ui.saving = false; }
    }
    const saveStatus = computed(() => ui.dirty ? "有未保存的修改" : ui.savedAt ? `已保存 ${timeLabel(ui.savedAt)}` : idOf(ui.form) ? "正在编辑" : "草稿未保存");
    async function loadGuideData(options = {}) {
      if (!ctx.loadAuthenticatedData || ctx.state.authSource !== "server") return;
      ui.loading = true; ui.loadError = "";
      try {
        const result = await ctx.loadAuthenticatedData("guides", { force: true, joinPending: options.joinPending === true });
        if (!result || result.ok === false || result.failed?.length) ui.loadError = "旅拍灵感或关联数据加载失败，请重试";
        if (ui.mode === "edit" && !ui.form.targetProductSpotId && ui.form.targetProductId) ui.form.targetProductSpotId = (ui.form.spotIds || []).find((id) => productsForSpot(id).some((p) => idOf(p) === ui.form.targetProductId && p.targetType === ui.form.targetProductType)) || "";
      } catch (_) { ui.loadError = "旅拍灵感数据加载失败，请重试"; }
      finally { ui.loading = false; }
    }
    const onRequest = (request) => { if (request) { ctx.state.guideEditorRequest = null; openEditor(request.row, request.relations); } };
    window.Vue.watch?.(() => ctx.state.guideEditorRequest, onRequest, { immediate: true });
    function beforeUnload(event) { if (ui.mode === "edit" && ui.dirty) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener?.("beforeunload", beforeUnload);
    ctx.state.guideLeaveGuard = () => ui.mode !== "edit" || confirmLeave();
    window.Vue.onBeforeUnmount?.(() => { formVersion++; ctx.state.guideLeaveGuard = null; window.removeEventListener("beforeunload", beforeUnload); });
    if (ctx.state.authSource === "server") loadGuideData({ joinPending: true });
    return { ui, editorRef, guideRows, guideTotal, categoryOf, categoryOptions, spotLabel, spotIdsOf, idOf, textOf, timeLabel, isPublished, frontVisible, productLabel,
      validSpots, spotChoices, productGroups, productsForSpot, pickedProduct, selectedProduct, selectProduct, clearProduct, addSpot, removeSpot,
      openEditor, backToList, markDirty, wordCount, editorInput, rememberSelection, format, pickFiles, pasteContent, dropFiles, insertVideoUrl, uploadFiles, collectForm, cleanHtml, guideUploads,
      saveArticle, openPreview, toggleGuide, pinGuide, deleteGuide, saveStatus, loadGuideData };
  }
});
