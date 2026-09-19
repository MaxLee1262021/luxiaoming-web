(window.LXM_APP_PARTS = window.LXM_APP_PARTS || []).push(function (ctx) {
  const upload = window.LXM_UPLOAD;
  function contentFile(target, field, collection, videoOnly = false, multiple = false) {
    if (!target || !ctx.can("contentEdit")) return;
    upload.pick({ purpose: "content", collection, recordId: target.id || target._id || undefined, videoOnly, imagesOnly: !videoOnly, multiple,
      onUploaded(file) {
        if (multiple) target[field] = [...(target[field] || []), file.url];
        else target[field] = file.url;
      }
    });
  }
  function attachmentFiles(form) { return (form?.attachmentFileIds || []).map((id) => ({ id, saved: (form.existingAttachmentFileIds || []).includes(id), name: (form.attachmentFiles || []).find((file) => (file.fileId || file.id) === id)?.name || "已上传附件" })); }
  function attach(form, purpose, orderId) {
    if (!orderId) return ctx.ElMessage.warning("请先填写并关联有效订单");
    upload.pick({ purpose, orderId, collection: purpose === "finance" ? "adjustmentRecords" : undefined, multiple: true, onUploaded(file) {
      const id = file.fileId || file.id;
      form.attachmentFileIds = [...new Set([...(form.attachmentFileIds || []), id])];
      form.attachmentFiles = [...(form.attachmentFiles || []).filter((item) => (item.fileId || item.id) !== id), file];
    } });
  }
  function uploadAfterSaleAttachment(process = false) { attach(process ? ctx.state.afterSaleProcessForm : ctx.state.afterSaleForm, "after-sale", ctx.state.currentOrder?.id || ctx.state.currentOrder?._id); }
  function uploadFinanceAttachment() {
    const form = ctx.state.adjustmentForm;
    const order = ctx.data.orders.find((item) => item.orderNo === form.orderNo || item.id === form.orderNo);
    attach(form, "finance", order?.id || order?._id);
  }
  function removeAttachment(form, id) {
    if ((form.existingAttachmentFileIds || []).includes(id)) return;
    form.attachmentFileIds = (form.attachmentFileIds || []).filter((value) => value !== id);
  }
  function validateMediaUrl(target, field) {
    if (target && upload.temporary(target[field])) {
      target[field] = "";
      ctx.ElMessage.warning("本地文件请使用上传按钮，链接填写可访问的图片或视频地址");
    }
  }
  function deliveryFiles(order = ctx.state.currentOrder, draft = true) {
    const files = draft ? order?.deliveryDraftFiles : order?.deliverFiles;
    const ids = draft ? order?.deliveryDraftFileIds : order?.deliverFileIds;
    if (Array.isArray(files) && files.length) return files.map((file) => typeof file === "string" ? { id: file, name: "成片文件" } : { ...file, id: file.fileId || file.id });
    return (ids || []).map((id) => ({ id, name: "成片文件" }));
  }
  function canUploadDelivery(order = ctx.state.currentOrder) {
    if (!order || ctx.state.orderReadonly && ctx.state.orderDrawer && ctx.state.currentOrder === order || ctx.isOrderAfterSaleLocked(order) || ctx.hasDeliveryRecord(order)) return false;
    const role = ctx.state.role;
    const own = ["super", "service"].includes(role) || role === "photo" && String(order.photographerId || "") === String(ctx.roleProfile.value.staffId || "");
    return own && !!(order.shootingCompletedAt || ["selection_pending", "awaiting_final_payment", "paid"].includes(ctx.workflowStageOf(order)));
  }
  function uploadDelivery(order = ctx.state.currentOrder) {
    if (!canUploadDelivery(order)) return ctx.ElMessage.warning("拍摄完成后可上传本单成片草稿");
    upload.pick({ purpose: "order-delivery", orderId: order.id || order._id, multiple: true, async onUploaded(file) {
      const fileIds = [...new Set([...deliveryFiles(order).map((item) => item.id), file.fileId || file.id])];
      if (!(await ctx.persistOrderAction(order, "deliverydraft", { fileIds }))) throw new Error("成片草稿尚未写入服务端，请重新登录后重试");
    } });
  }
  async function removeDeliveryFile(order, id) {
    if (!upload.ready() || !canUploadDelivery(order)) return;
    try { await upload.single(`draft:${order.id}`, () => ctx.persistOrderAction(order, "deliverydraft", { fileIds: deliveryFiles(order).map((file) => file.id).filter((value) => value !== id) })); }
    catch (_) {}
  }
  const deliveryDialog = ctx.reactive({ open: false, order: null, publishing: false, selected: [] });
  function deliverOrder(order = ctx.state.currentOrder) {
    if (!ctx.canDeliverOrder(order)) return ctx.ElMessage.warning("客服在确认线下选片后可发布成片");
    deliveryDialog.order = order;
    deliveryDialog.selected = deliveryFiles(order).map((file) => file.id);
    deliveryDialog.open = true;
  }
  async function publishDelivery(external = false) {
    const order = deliveryDialog.order;
    if (!upload.ready() || deliveryDialog.publishing || !ctx.canDeliverOrder(order)) return;
    if (!external && !deliveryDialog.selected.length) return ctx.ElMessage.warning("请先上传并选择要发布的成片");
    deliveryDialog.publishing = true;
    try {
      await ctx.ElMessageBox.confirm(external ? "确认成片已通过企业微信交付客户？" : "确认将所选成片发布给该订单客户？", "确认交付", { type: "warning", confirmButtonText: "确认交付", cancelButtonText: "取消" });
      await ctx.persistOrderAction(order, "deliver", { fileIds: external ? [] : deliveryDialog.selected.slice(), deliveryMethod: external ? "企业微信" : "小程序成片", reason: external ? "成片已通过企业微信交付客户" : "客服确认并发布成片" });
      deliveryDialog.open = false;
      ctx.ElMessage.success("成片已交付");
    } catch (_) {} finally { deliveryDialog.publishing = false; }
  }
  const guarded = {};
  for (const key of ["saveContent", "saveSeries", "saveVideoSingle", "saveHomeConfig", "submitAfterSale", "saveAfterSaleProcess", "submitAdjustmentRecord"]) {
    const action = ctx[key];
    if (typeof action === "function") guarded[key] = (...args) => upload.ready() ? upload.single(key, () => action(...args)) : undefined;
  }
  return { uploadJobs: upload.jobs, uploadBusy: ctx.computed(upload.busy), retryUpload: upload.retry, dismissUpload: upload.dismiss,
    storedFilePreview: upload.preview, closeStoredFilePreview: upload.closePreview,
    openStoredFile: upload.open, contentFile, validateMediaUrl, attachmentFiles, uploadAfterSaleAttachment, uploadFinanceAttachment, removeAttachment,
    deliveryFiles, canUploadDelivery, uploadDelivery, removeDeliveryFile, deliveryDialog, deliverOrder, publishDelivery, ...guarded };
});
