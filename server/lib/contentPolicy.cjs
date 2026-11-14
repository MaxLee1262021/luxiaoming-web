"use strict";

// Manual visibility is stored on the record. Relationship visibility is derived,
// so reopening a point cannot accidentally publish a manually hidden product.
const CONTENT_POLICY_KEYS = new Set(["spots", "albums", "packages", "peripherals", "guides", "tagLibrary"]);
const CONTEXT_KEYS = ["spots", "series", "albums", "packages", "peripherals", "guides"];
const idOf = (row) => String(row && (row.id || row._id) || "");
const unique = (values) => [...new Set(values.filter((x) => x !== undefined && x !== null && String(x).trim()).map(String))];
const deleted = (row) => !!(row && (row.deleted === true || row.isDeleted === true));
const falseLike = (value) => value === false || value === 0 || ["false", "0"].includes(String(value).trim().toLowerCase());
const HIDDEN = new Set(["草稿", "隐藏", "已隐藏", "下架", "已下架", "已下", "停用", "禁用", "待审", "待审核", "驳回", "draft", "hidden", "offline", "disabled", "down", "pending", "reviewing", "rejected"]);
const PASSED_AUDITS = new Set(["approved", "pass", "passed", "published", "online", "已上", "已上架", "审核通过", "通过"]);

function manualContentVisible(row = {}) {
  return !deleted(row) && ![row.isShow, row.visible, row.enabled, row.isSellable].some(falseLike)
    && !HIDDEN.has(String(row.status || row.saleStatus || row.shelfStatus || "").trim().toLowerCase());
}

function ownContentVisible(row = {}) {
  return manualContentVisible(row) && [row.auditStatus, row.reviewStatus].every((value) => {
    const status = String(value || "").trim().toLowerCase();
    return !status || PASSED_AUDITS.has(status);
  });
}

function isVideoSingle(row = {}) {
  if (row.isVideoSingle === true || row.productKind === "video_single") return true;
  if (row.isVideoSingle === false || ["package", "bundle"].includes(row.productKind) || packageReferences(row).length) return false;
  return [row.type, row.serviceType, row.productType].some((x) => /video|视频/.test(String(x || "")));
}

function videoProductMediaUrl(row = {}) {
  for (const value of [row.videoUrl, row.previewVideoUrl, ...(Array.isArray(row.videos) ? row.videos : [])]) {
    const media = typeof value === "string" ? { url: value } : value || {};
    const url = typeof (media.videoUrl || media.url || media.src) === "string" ? (media.videoUrl || media.url || media.src).trim() : "";
    const type = String(media.mediaType || media.mimeType || media.type || "").toLowerCase();
    if (url && !/\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic)(?:[?#]|$)|^data:image\//i.test(url) && !/^(?:image|photo)/.test(type)) return url;
  }
  return "";
}

function contentSpotIds(row = {}) {
  return unique([...(Array.isArray(row.spotIds) ? row.spotIds : []), row.spotId]);
}

function packageReferences(row = {}) {
  const primary = Array.isArray(row.includedItems) ? row.includedItems : [];
  const alias = Array.isArray(row.items) ? row.items : [];
  const refs = [];
  for (let i = 0; i < Math.max(primary.length, alias.length); i += 1) {
    const item = { ...(alias[i] || {}), ...(primary[i] || {}) };
    const target = item.target || {};
    const raw = String(item.type || item.productType || target.page || "").toLowerCase();
    const type = /video|视频/.test(raw) ? "video" : /peripheral|周边|实物/.test(raw) ? "peripheral"
      : /album|photo|照片|留影|写真/.test(raw) ? "album" : "";
    const id = String(type === "album" ? item.albumId || item.productId || target.albumId || target.productId || ""
      : type === "video" ? item.productId || item.videoId || target.productId || ""
        : item.peripheralId || item.productId || target.peripheralId || target.productId || target.id || "");
    if (type) refs.push({ type, key: type === "album" ? "albums" : type === "video" ? "packages" : "peripherals", id, item });
  }
  if (!refs.length && row.albumId) refs.push({ type: "album", key: "albums", id: String(row.albumId), item: {} });
  return refs;
}

async function createContentContext(source) {
  const values = await Promise.all(CONTEXT_KEYS.map((key) => source.list(key)));
  return Object.fromEntries(CONTEXT_KEYS.map((key, i) => [key, Array.isArray(values[i]) ? values[i] : []]));
}

// Read projections need only visibility dependencies. In particular, an
// article's visibility never depends on other articles or its booking product.
// Keep the full context above for publication validation and mutation plans.
async function createVisibilityContext(source, keys) {
  const dependencies = new Set();
  for (const key of keys) {
    if (["albums", "packages", "peripherals", "guides"].includes(key)) {
      dependencies.add("spots"); dependencies.add("series");
    }
    if (key === "packages") {
      for (const productKey of ["albums", "packages", "peripherals"]) dependencies.add(productKey);
    }
  }
  const names = [...dependencies];
  const values = await Promise.all(names.map((key) => source.list(key)));
  return Object.fromEntries(names.map((key, index) => [key, Array.isArray(values[index]) ? values[index] : []]));
}

function productSpotIds(row, context) {
  const ids = contentSpotIds(row);
  if (ids.length || row.spotBindingExplicit === true || !row.seriesId) return ids;
  const series = (context.series || []).find((item) => idOf(item) === String(row.seriesId));
  return series ? contentSpotIds(series) : [];
}

function effectivePackageSpotIds(row, context = {}) {
  const refs = packageReferences(row);
  if (!refs.length) return productSpotIds(row, context);
  return unique(refs.flatMap((ref) => {
    const product = (context[ref.key] || []).find((item) => idOf(item) === ref.id);
    return product ? productSpotIds(product, context) : [];
  }));
}

function effectiveContentVisibility(key, row, context = {}, visited = new Set()) {
  const reasons = [];
  if (!ownContentVisible(row)) reasons.push(deleted(row) ? "已删除" : "已单独隐藏");
  const token = `${key}:${idOf(row)}`;
  if (visited.has(token)) return { effectiveVisible: false, visibilityReasons: ["商品循环关联"] };
  const next = new Set([...visited, token]);
  const bundle = key === "packages" && !isVideoSingle(row);
  const ids = key === "spots" || key === "tagLibrary" ? [] : bundle ? effectivePackageSpotIds(row, context) : productSpotIds(row, context);
  // Rich articles can be shared across independent points. Preserve the old
  // all-points availability rule for articles saved by the legacy editor.
  const guideHasAvailablePoint = key === "guides" && typeof row.contentHtml === "string"
    && ids.some((id) => (context.spots || []).some((spot) => idOf(spot) === id && ownContentVisible(spot)));
  for (const id of ids) {
    const spot = (context.spots || []).find((item) => idOf(item) === id);
    if ((!spot || !ownContentVisible(spot)) && !guideHasAvailablePoint) reasons.push(`打卡点「${spot && spot.name || id}」已隐藏或删除`);
  }
  if (bundle) {
    for (const id of unique(Array.isArray(row.deletedSpotIds) ? row.deletedSpotIds : [])) reasons.push(`原关联打卡点「${id}」已删除`);
    for (const ref of packageReferences(row)) {
      const product = (context[ref.key] || []).find((item) => idOf(item) === ref.id);
      if (!product || !effectiveContentVisibility(ref.key, product, context, next).effectiveVisible) reasons.push(`套餐商品「${product && product.name || ref.id || "未选择"}」已隐藏或删除`);
    }
  }
  return { effectiveVisible: reasons.length === 0, visibilityReasons: unique(reasons) };
}

function policyError(message, status = 400) {
  const error = new Error(message); error.statusCode = status; error.code = "CONTENT_POLICY_INVALID"; return error;
}

function stripProjection(body) {
  const patch = { ...body };
  ["effectiveVisible", "visibilityReasons", "effectiveSpotIds", "__key", "__source", "deletedSpotIds"].forEach((field) => { delete patch[field]; });
  return patch;
}

function peripheralAmount(value, label) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") throw policyError(`请填写${label}`);
  const number = Number(value);
  const cents = Math.round(number * 100);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(cents)) throw policyError(`${label}必须为有效的非负金额`);
  return cents / 100;
}

function preparePeripheralSalesPatch(patch, current) {
  const has = (field) => Object.prototype.hasOwnProperty.call(patch, field);
  const creating = !idOf(current);
  const fields = ["specMode", "productCode", "unit", "stock", "stockQty", "stockWarning", "skus", "shippingFee"];
  // Old content-only clients do not turn an unknown historical stock into zero.
  if (!creating && current.specMode !== "multiple" && !fields.some(has)) return;
  const integer = (value, label) => {
    if (!["number", "string"].includes(typeof value) || String(value).trim() === "") throw policyError(`请填写${label}`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > 2147483647) throw policyError(`${label}必须为 0 到 2147483647 的整数`);
    return number;
  };
  const text = (value, label, limit, required = false) => {
    if (typeof value !== "string") throw policyError(`${label}必须为文字`);
    const result = value.trim();
    if (required && !result) throw policyError(`请填写${label}`);
    if (result.length > limit) throw policyError(`${label}不能超过 ${limit} 个字符`);
    return result;
  };
  if (has("specMode") && !["single", "multiple"].includes(patch.specMode)) throw policyError("请选择单规格或多规格");
  const mode = patch.specMode ?? current.specMode ?? "single";
  if (!["single", "multiple"].includes(mode)) throw policyError("请选择单规格或多规格");
  patch.specMode = mode;
  if (has("productCode") || creating) patch.productCode = text(patch.productCode ?? "", "商品编码", 128);
  if (has("unit") || creating) patch.unit = text(has("unit") ? patch.unit : "件", "销售单位", 20, true);
  if (has("stockWarning") || creating) patch.stockWarning = integer(has("stockWarning") ? patch.stockWarning : 5, "库存预警值");
  if (has("shippingFee") || creating) patch.shippingFee = peripheralAmount(has("shippingFee") ? patch.shippingFee : 0, "运费");
  for (const field of ["stock", "stockQty"]) if (has(field)) patch[field] = integer(patch[field], "库存");
  if (has("skus") && !Array.isArray(patch.skus)) throw policyError("商品规格必须为列表");
  if (mode === "multiple") {
    const source = has("skus") ? patch.skus : current.skus;
    if (!Array.isArray(source) || !source.length || source.length > 100) throw policyError("多规格商品需填写 1 到 100 个规格");
    const specs = new Set(), codes = new Set();
    patch.skus = source.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw policyError(`第 ${index + 1} 个规格无效`);
      const spec = text(entry.spec, `第 ${index + 1} 个规格名称`, 160, true);
      const skuCode = text(entry.skuCode === undefined ? "" : entry.skuCode, `第 ${index + 1} 个规格编码`, 128);
      if (specs.has(spec)) throw policyError("规格名称不能重复");
      if (skuCode && codes.has(skuCode)) throw policyError("规格编码不能重复");
      specs.add(spec); if (skuCode) codes.add(skuCode);
      return { skuCode, spec, price: peripheralAmount(entry.price, `第 ${index + 1} 个规格售价`), stock: integer(entry.stock, `第 ${index + 1} 个规格库存`) };
    });
    patch.stock = integer(patch.skus.reduce((sum, sku) => sum + sku.stock, 0), "总库存");
    patch.stockQty = patch.stock;
    patch.specs = patch.skus.map((sku) => sku.spec);
    patch.price = Math.min(...patch.skus.map((sku) => sku.price));
  } else {
    if (has("stock") || has("stockQty") || creating || has("specMode")) {
      patch.stock = integer(patch.stock ?? patch.stockQty ?? current.stock ?? current.stockQty ?? 0, "库存");
      patch.stockQty = patch.stock;
    }
    // Clearing the old rows prevents stale SKU prices from resurfacing after a
    // product has intentionally returned to a single specification.
    if (creating || has("skus") || current.specMode === "multiple" || has("specMode")) patch.skus = [];
  }
}

async function prepareContentPatch(source, key, body, current = {}, context) {
  const patch = stripProjection(body);
  context ||= await createContentContext(source);
  const row = { ...current, ...patch };
  // Editors and public pages share the same text aliases. An explicit empty
  // value clears both aliases so old descriptions cannot reappear on mobile.
  const has = (field) => Object.prototype.hasOwnProperty.call(patch, field);
  if (["albums", "packages", "peripherals"].includes(key) && (has("isShow") || has("status"))) {
    // These two historical values describe the shelf after approval. A shelf
    // toggle must update them together; actual review states stay untouched.
    const shelfAudit = manualContentVisible(row) ? "已上" : "已下";
    for (const field of ["auditStatus", "reviewStatus"]) {
      if (["已上", "已下"].includes(String(row[field] || "").trim())) patch[field] = row[field] = shelfAudit;
    }
  }
  if (key === "spots") {
    const coverField = ["cover", "coverUrl", "coverImage", "image"].find(has);
    if (coverField) {
      const cover = String(patch[coverField] ?? "").trim();
      // A replacement or explicit clear must replace every historical alias.
      // Otherwise a stale image can reappear after editing or on another page.
      for (const field of ["cover", "coverUrl", "coverImage", "image"]) patch[field] = cover;
    }
  }
  const normalizeList = (value, separator) => unique((Array.isArray(value) ? value : typeof value === "string" ? value.split(separator) : [])
    .map((entry) => typeof entry === "string" ? entry.trim() : entry && (entry.name || entry.label) || ""));
  if (["albums", "peripherals", "packages"].includes(key) && has("tags")) patch.tags = normalizeList(patch.tags, /[,，、|]/);
  if (key === "albums" || key === "packages" && isVideoSingle(row)) {
    if (has("shootingNotes") || has("intro")) {
      patch.shootingNotes = String(has("shootingNotes") ? patch.shootingNotes ?? "" : patch.intro ?? "").trim();
      patch.intro = patch.shootingNotes;
    }
  } else if (key === "packages" && (has("description") || has("intro"))) {
    patch.description = String(has("description") ? patch.description ?? "" : patch.intro ?? "").trim();
    patch.intro = patch.description;
  }
  if (key === "peripherals") {
    if (has("intro") || has("description")) {
      patch.description = String(has("intro") ? patch.intro ?? "" : patch.description ?? "").trim();
      patch.intro = patch.description;
    }
    if (has("cover") || has("image")) {
      patch.cover = String(has("cover") ? patch.cover ?? "" : patch.image ?? "").trim();
      patch.image = patch.cover;
    }
    if (has("specs")) patch.specs = normalizeList(patch.specs, /[,，/]/);
    if (has("category")) patch.cate = String(patch.category ?? "").trim();
    preparePeripheralSalesPatch(patch, current);
  }
  // When a client replaces one alias, do not merge stale entries from the
  // other alias stored on the old document back into the replacement.
  if (Object.prototype.hasOwnProperty.call(patch, "includedItems") && !Object.prototype.hasOwnProperty.call(patch, "items")) row.items = [];
  if (Object.prototype.hasOwnProperty.call(patch, "items") && !Object.prototype.hasOwnProperty.call(patch, "includedItems")) row.includedItems = [];
  if (["albums", "peripherals"].includes(key) || key === "packages" && isVideoSingle(row)) {
    const explicitBinding = Object.prototype.hasOwnProperty.call(body, "spotId") || Object.prototype.hasOwnProperty.call(body, "spotIds");
    let ids;
    if (Object.prototype.hasOwnProperty.call(patch, "spotIds")) ids = unique(Array.isArray(patch.spotIds) ? patch.spotIds : []);
    else if (Object.prototype.hasOwnProperty.call(patch, "spotId")) ids = patch.spotId ? [String(patch.spotId)] : [];
    else ids = contentSpotIds(row);
    if (ids.length > 1) throw policyError("单个商品最多关联一个打卡点");
    if (ids.some((id) => !(context.spots || []).some((spot) => idOf(spot) === id && !deleted(spot)))) throw policyError("关联打卡点不存在或已删除");
    if (explicitBinding || !idOf(current)) {
      patch.spotId = ids[0] || ""; patch.spotIds = ids;
      // An explicit empty binding is distinct from a legacy missing field.
      // Keep the style/series relation while suppressing point inheritance.
      if (explicitBinding || key === "albums" && !idOf(current)) patch.spotBindingExplicit = true;
    }
  }
  const positiveIntegerFields = key === "albums" ? ["retouchCount", "photoCount"] : key === "packages" && isVideoSingle(row)
    ? ["duration", "videoDuration", "finishedVideoCount"] : [];
  for (const field of positiveIntegerFields) {
    if (!(field in patch) || patch[field] === "") continue;
    const value = Number(patch[field]);
    if (!Number.isSafeInteger(value) || value < 0) throw policyError(`${field} 必须为非负整数`);
    patch[field] = value;
  }
  if (key === "albums") {
    if (has("seriesName")) {
      if (patch.seriesName !== null && patch.seriesName !== undefined && typeof patch.seriesName !== "string") throw policyError("风格系列名称必须为文字");
      patch.seriesName = String(patch.seriesName ?? "").trim();
      if (patch.seriesName.length > 160) throw policyError("风格系列名称不能超过 160 个字符");
    }
    if (has("seriesId")) {
      patch.seriesId = String(patch.seriesId ?? "").trim();
      const series = (context.series || []).find((item) => idOf(item) === patch.seriesId && !deleted(item));
      if (series) patch.seriesName = String(series.name || "");
      else if (!patch.seriesId && !has("seriesName")) patch.seriesName = "";
    }
    if ("retouchMode" in patch && !["count", "included", "excluded"].includes(patch.retouchMode)) throw policyError("请选择有效的修图方式");
    if ("makeupIncluded" in patch && typeof patch.makeupIncluded !== "boolean") throw policyError("是否含妆造必须为布尔值");
    if ("retouchMode" in patch || "retouchCount" in patch || !idOf(current)) {
      patch.retouchMode = patch.retouchMode || current.retouchMode || (Number(row.retouchCount) > 0 ? "count" : "excluded");
      patch.retouchCount = patch.retouchMode === "count" ? Number(patch.retouchCount ?? current.retouchCount ?? 0) : 0;
      if (patch.retouchMode === "count" && (!Number.isSafeInteger(patch.retouchCount) || patch.retouchCount < 1)) throw policyError("请填写正整数的修图张数");
    }
    if ("sampleUrls" in patch) {
      if (!Array.isArray(patch.sampleUrls) || patch.sampleUrls.some((url) => typeof url !== "string" || !url.trim())) throw policyError("商品照片必须为有效图片地址列表");
      patch.sampleUrls = [...new Set(patch.sampleUrls.map((url) => url.trim()))];
      const cover = String(has("cover") ? patch.cover ?? "" : current.cover || current.coverImage || current.coverUrl || current.image || "").trim();
      // Older clients supplied a separate cover alongside detail pictures.
      // Include that explicit cover once, while removing a previous cover from
      // the gallery must never silently restore it.
      if (patch.sampleUrls.length && has("cover") && cover && !patch.sampleUrls.includes(cover)) patch.sampleUrls.unshift(cover);
      patch.cover = patch.sampleUrls.includes(cover) ? cover : patch.sampleUrls[0] || "";
      for (const field of ["coverImage", "coverUrl", "image"]) patch[field] = patch.cover;
      patch.photoCount = patch.sampleUrls.length;
    }
    if (ownContentVisible(row) && "photoCount" in patch && (!Number.isSafeInteger(Number(patch.photoCount)) || Number(patch.photoCount) < 1)) throw policyError("请填写正整数的照片张数");
    if (ownContentVisible(row) && "cover" in patch && !String(patch.cover || "").trim()) throw policyError("请设置照片留影首图");
    // A photo product has one price; old sale-price aliases are never accepted
    // as a second price by the current catalog editor or public projection.
    delete patch.originalPrice;
    delete patch.specialPrice;
  }
  if (key === "packages" && isVideoSingle(row) && ownContentVisible(row)
    && ["videoUrl", "previewVideoUrl", "videos"].some(has) && videoProductMediaUrl(current) && !videoProductMediaUrl(row)) {
    throw policyError("请上传商品视频");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "price")) {
    if (key === "peripherals") patch.price = peripheralAmount(patch.price, "商品价格");
    if (patch.price === null || patch.price === undefined || String(patch.price).trim() === "") throw policyError("请填写商品价格");
    const price = Number(patch.price);
    if (!Number.isFinite(price) || price < 0) throw policyError("商品价格必须为非负金额");
    patch.price = Math.round(price * 100) / 100;
    if (key === "peripherals") for (const alias of ["specialPrice", "salePrice"]) {
      if (has(alias) || Object.prototype.hasOwnProperty.call(current, alias)) patch[alias] = patch.price;
    }
  }
  if (key === "packages" && !isVideoSingle(row)) {
    const refs = packageReferences(row);
    if (("includedItems" in patch || "items" in patch) && !refs.length) throw policyError("套餐至少需要一个具体商品");
    if (refs.length) {
      const items = [];
      for (const ref of refs) {
        const product = (context[ref.key] || []).find((item) => idOf(item) === ref.id);
        if (!product || deleted(product) || ref.key === "packages" && !isVideoSingle(product)) throw policyError("套餐包含的商品不存在、已删除或类型无效");
        const quantity = Number(ref.item.quantity ?? ref.item.qty ?? ref.item.count ?? 1);
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw policyError("套餐商品数量必须为正整数");
        const unitPrice = Number(product.price ?? product.specialPrice ?? 0);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) throw policyError("套餐商品单价无效");
        items.push({ ...ref.item, type: ref.type, productId: ref.id, name: String(product.name || product.title || ""), quantity, qty: quantity, price: unitPrice, unitPrice,
          ...(ref.type === "album" ? { albumId: ref.id } : ref.type === "peripheral" ? { peripheralId: ref.id } : {}),
          target: { ...(ref.item.target || {}), page: ref.type === "album" ? "photoCollection" : ref.type === "video" ? "videoProductDetail" : "peripheral", ...(ref.type === "album" ? { albumId: ref.id, seriesId: product.seriesId || "" } : ref.type === "video" ? { productId: ref.id } : { id: ref.id, peripheralId: ref.id }), spotId: product.spotId || "" } });
      }
      patch.includedItems = items; patch.items = items.map((item) => ({ ...item }));
      patch.originalPrice = Math.round(items.reduce((sum, item) => sum + item.quantity * Math.round(item.price * 100), 0)) / 100;
      patch.spotIds = effectivePackageSpotIds({ ...row, includedItems: items, items }, context);
      patch.spotId = patch.spotIds[0] || "";
      const price = body.price ?? body.specialPrice ?? current.price ?? current.specialPrice ?? patch.originalPrice;
      if (!Number.isFinite(Number(price)) || Number(price) < 0) throw policyError("套餐售价必须为非负金额");
      patch.price = Math.round(Number(price) * 100) / 100; patch.specialPrice = patch.price;
    }
  }
  return patch;
}

function validateContentPublication(key, row, current, context = {}) {
  // Guide publication and its independent storefront visibility are validated
  // by prepareGuideForSave, including media-only rich-text articles.
  if (key === "guides") return "";
  if (key === "tagLibrary" || !ownContentVisible(row) || current && ownContentVisible(current)) return "";
  const text = (value) => value !== undefined && value !== null && String(value).trim() !== "";
  const list = (...values) => values.some((value) => Array.isArray(value) ? value.length > 0 : text(value));
  const integer = (value, min) => text(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min;
  if (!text(row.name || row.title)) return "请填写名称或标题";
  const cover = row.cover || row.coverUrl || row.image;
  const media = list(cover, row.mediaItems, row.mediaUrls, row.images, row.videos, row.photoIds, row.videoUrl, row.previewVideoUrl);
  const description = row.shootingNotes || row.description || row.intro;
  const seriesId = String(row.seriesId || "").trim();
  const linkedStyle = !!seriesId && (context.series || []).some((series) => series && !series.deleted && !series.isDeleted && idOf(series) === seriesId);
  const style = linkedStyle || key === "albums" && !seriesId && text(row.seriesName)
    || list(row.styles, row.styleTags, row.style, row.tags, row.serviceTags);
  if (key === "spots") {
    if (!text(row.cityId || row.city)) return "请选择所属城市";
    if (!text(row.address)) return "请填写详细地址";
    if (!text(row.description || row.intro)) return "请填写打卡点介绍";
    if (!list(row.tag, row.operationTags)) return "请选择或输入运营标签";
    if (!list(row.tags, row.contentTags, row.styles)) return "请选择或输入内容标签";
    if (!text(cover)) return "请上传打卡点首图";
  }
  if (["albums", "peripherals"].includes(key) || key === "packages" && isVideoSingle(row)) {
    if (key === "packages" ? !videoProductMediaUrl(row) : !media) return key === "packages" ? "请上传商品视频" : "请上传商品素材";
    if (!text(description)) return "请填写商品说明";
    if (!text(row.price) || !Number.isFinite(Number(row.price)) || Number(row.price) < 0) return "请填写有效的商品单价";
    if (key !== "peripherals" && !style) return "请选择关联拍摄风格或输入风格标签";
    if (key === "albums") {
      if (!text(cover)) return "请设置照片留影首图";
      if (!integer(row.photoCount, 1)) return "请填写正整数的照片张数";
      if (row.retouchMode === "count" && !integer(row.retouchCount, 1)) return "请填写正整数的修图张数";
      if (!row.retouchMode && !integer(row.retouchCount, 0)) return "请填写非负整数的修图张数";
    }
    if (key === "packages") {
      if (!text(row.durationText) && !(Number(row.videoDuration) > 0)) return "请填写视频时长";
      if (!integer(row.finishedVideoCount, 1)) return "请填写正整数的成片数量";
      if (!text(row.deliveryCycle)) return "请填写交付周期";
    }
  }
  if (key === "packages" && !isVideoSingle(row)) {
    if (!packageReferences(row).length) return "请选择套餐包含的具体商品";
    if (!text(row.price) || !Number.isFinite(Number(row.price)) || Number(row.price) < 0) return "请填写有效的套餐售价";
  }
  return "";
}

// Build a write plan before changing anything. The caller applies it together
// with the source record and compensates all writes if persistence fails.
function pointDeletionPlan(spotId, context) {
  const plan = [];
  for (const key of ["series", "albums", "packages", "peripherals", "guides"]) {
    for (const row of context[key] || []) {
      const direct = contentSpotIds(row).includes(spotId);
      const affectedBundle = key === "packages" && !isVideoSingle(row) && effectivePackageSpotIds(row, context).includes(spotId);
      if (!direct && !affectedBundle) continue;
      const ids = contentSpotIds(row).filter((id) => id !== spotId);
      const patch = {};
      if (direct) { patch.spotIds = ids; patch.spotId = ids[0] || ""; if (["albums", "peripherals"].includes(key) || key === "packages" && isVideoSingle(row)) patch.spotBindingExplicit = true; }
      if (affectedBundle) patch.deletedSpotIds = unique([...(row.deletedSpotIds || []), spotId]);
      if (key === "guides" && direct) {
        patch.seriesId = "";
        if (String(row.targetProductSpotId || row.spotId || "") === String(spotId)) {
          patch.targetProductId = ""; patch.targetProductType = ""; patch.targetPackageId = ""; patch.targetProductSpotId = "";
        }
      }
      plan.push({ key, id: idOf(row), before: row, patch });
    }
  }
  return plan;
}

function pointRestorationPlan(spotId, context) {
  return (context.packages || []).filter((row) => (row.deletedSpotIds || []).includes(spotId)).map((row) => ({ key: "packages", id: idOf(row), before: row,
    patch: { deletedSpotIds: row.deletedSpotIds.filter((id) => id !== spotId) } }));
}

function customTagNames(key, row) {
  return unique(customTagEntries(key, row).map((tag) => tag.name));
}

function customTagEntries(key, row) {
  const fields = key === "spots" ? { tag: "运营", operationTags: "运营", tags: "内容", contentTags: "内容", styles: "风格", styleTags: "风格" }
    : { style: "风格", styles: "风格", styleTags: "风格", tags: "风格", serviceTags: "风格" };
  const entries = [];
  for (const [field, category] of Object.entries(fields)) {
    for (const raw of Array.isArray(row[field]) ? row[field] : row[field] ? [row[field]] : []) {
      const name = String(typeof raw === "object" ? raw && (raw.name || raw.label) || "" : raw).trim();
      if (name && !entries.some((tag) => tag.name === name && tag.category === category)) entries.push({ name, category });
    }
  }
  return entries;
}

module.exports = { CONTENT_POLICY_KEYS, ownContentVisible, isVideoSingle, videoProductMediaUrl, contentSpotIds, effectiveProductSpotIds: productSpotIds, packageReferences, createContentContext, createVisibilityContext, effectivePackageSpotIds, effectiveContentVisibility,
  prepareContentPatch, validateContentPublication, pointDeletionPlan, pointRestorationPlan, customTagNames, customTagEntries, stripProjection, policyError, idOf, deleted };
