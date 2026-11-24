/* Physical commerce uses its own action permissions; it never claims service orders. */
(function () {
  window.LXM_PHYSICAL_WORKBENCH_SETUP = function (ctx) {
    const { reactive, onUnmounted } = Vue;
    const p = reactive({ type: 'service', loading: false, busy: false, error: '', rows: [], total: 0, page: 1,
      status: '', keyword: '', detail: null, drawer: false, dialog: '', form: {}, tickets: [], carriers: [], alive: true });
    const names = { pending_payment: '待付款', awaiting_shipment: '待发货', awaiting_receipt: '待收货', completed: '已完成', closed: '已关闭' };
    const money = value => '¥' + (Number(value || 0)).toFixed(2);
    const label = row => row.publicStatusText || names[row.status || row.physicalStatus] || row.status || '—';
    const items = row => row.items || row.products || [];
    const role = () => ctx.state?.role || '';
    const canReview = () => ['super', 'admin', 'finance'].includes(role());
    const canInspect = () => ['super', 'admin', 'service', 'supervisor', 'service_supervisor'].includes(role());
    const can = (row, action) => Array.isArray(row.allowedActions) && row.allowedActions.includes(action)
      && (action === 'ship' ? canInspect() : action === 'withdrawShipment' ? ['super', 'admin', 'supervisor', 'service_supervisor'].includes(role()) : true);
    async function api(action, body, method = body == null ? 'GET' : 'POST') {
      const query = method === 'GET' && body ? '?' + new URLSearchParams(body) : '';
      const response = await window.LXM_HTTP.request('/api/physical/admin/' + action + query, { method,
        ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : {}) });
      const payload = await response.json();
      if (!response.ok || payload.code !== 0) throw new Error(payload.msg || payload.error || '实物服务暂不可用');
      return payload.data;
    }
    async function load(reset = false) {
      if (reset) p.page = 1;
      p.loading = true; p.error = '';
      try {
        const data = await api('list', { page: p.page, pageSize: 20, status: p.status, keyword: p.keyword }, 'GET');
        if (p.alive) { p.rows = data.items || data.orders || []; p.total = data.total || 0; }
      } catch (error) { p.error = error.message; } finally { p.loading = false; }
    }
    async function changeType(value) { p.type = value; if (value === 'physical') await load(true); }
    async function detail(row) {
      p.loading = true; p.error = '';
      try { p.detail = await api('detail', { orderId: row.id || row._id }, 'GET'); p.drawer = true; }
      catch (error) { p.error = error.message; } finally { p.loading = false; }
    }
    async function openShip(row) {
      if (!can(row, 'ship')) return;
      p.form = { orderId: row.id, version: row.version, carrierCode: '', trackingNo: '' };
      try { const cfg = await api('config', {}, 'GET'); p.carriers = cfg.carrierOptions || []; }
      catch (error) { p.error = error.message; return; }
      p.dialog = 'ship';
    }
    async function submit(action, payload, close = true) {
      if (p.busy) return;
      p.busy = true; p.error = '';
      try {
        const result = await api(action, payload);
        if (close) p.dialog = '';
        if (result?.refundPending) ctx.ElMessage.warning(result.message || '退款结果待核实，订单保持冻结');
        else ctx.ElMessage.success('操作已保存');
        if (p.drawer && payload.orderId) p.detail = await api('detail', { orderId: payload.orderId }, 'GET');
        if (payload.afterSaleId && payload.orderId) { const data = await api('afterSales', { orderId: payload.orderId }, 'GET'); p.tickets = data.items || []; }
        await load(); return result;
      } catch (error) { p.error = error.message; ctx.ElMessage.error(error.message); }
      finally { p.busy = false; }
    }
    async function ship() {
      if (!p.form.carrierCode || !String(p.form.trackingNo || '').trim()) { ctx.ElMessage.warning('请选择快递公司并填写物流单号'); return; }
      await submit('ship', { ...p.form, trackingNo: p.form.trackingNo.trim() });
    }
    async function tickets(row) {
      p.error = '';
      try { const data = await api('afterSales', { orderId: row.id }, 'GET'); p.tickets = Array.isArray(data) ? data : data.items || []; p.dialog = 'tickets'; }
      catch (error) { p.error = error.message; }
    }
    async function review(ticket, approved) {
      if (!await ctx.ElMessageBox.confirm(approved ? '按工单核定金额处理，已交运商品须先核实退货。' : '确认驳回此申请？', '售后审核').then(() => true).catch(() => false)) return;
      let returnAddress = '';
      if (approved && p.detail?.shipment && ticket.status !== 'ready_refund') {
        try { returnAddress = (await ctx.ElMessageBox.prompt('填写本次核实有效的退货收件地址、收件人及联系电话', '同意退货', { inputPattern: /.{10,}/, inputErrorMessage: '请填写完整退货信息' })).value; } catch (_) { return; }
      }
      let shippingRefundAmount = 0;
      if (approved) {
        try { shippingRefundAmount = Number((await ctx.ElMessageBox.prompt('填写本次核准退回的运费金额（元）。运费为整单金额，不得重复退还。', '核定退还运费', { inputValue: '0', inputPattern: /^\d+(\.\d{1,2})?$/, inputErrorMessage: '请输入非负金额，最多两位小数' })).value); } catch (_) { return; }
      }
      await submit('reviewAfterSale', { orderId: ticket.orderId, afterSaleId: ticket.id, approved, returnAddress, shippingRefundAmount, reason: approved ? '按申请审核' : '审核未通过' });
    }
    async function inspect(ticket) {
      if (!await ctx.ElMessageBox.confirm('确认已实际收到并逐件核验本次退货？物流签收不能代替实物核验。', '核验退货').then(() => true).catch(() => false)) return;
      const resellable = await ctx.ElMessageBox.confirm('本次退回商品是否可以再次销售？选择取消将不恢复可售库存。', '可售状态').then(() => true).catch(() => false);
      let note;
      try { note = (await ctx.ElMessageBox.prompt('逐项记录已收回商品、数量和品相核验结果', '核验记录', { inputPattern: /.{5,}/, inputErrorMessage: '请填写至少5字的核验记录' })).value; } catch (_) { return; }
      await submit('inspectReturn', { orderId: ticket.orderId, afterSaleId: ticket.id, received: true, resellable, note });
    }
    async function withdrawal(row) {
      try {
        const result = await ctx.ElMessageBox.prompt('请先确认实物仍在本方且已实际拦下，填写核实依据。', '撤销未交运出库', { inputPattern: /.{5,}/, inputErrorMessage: '请填写至少5字核实依据' });
        await submit('withdrawShipment', { orderId: row.id, version: row.version, reason: result.value, packageIntercepted: true });
      } catch (_) {}
    }
    async function refresh(row) { await submit('refreshLogistics', { orderId: row.id, refresh: true }, false); }
    async function retrySubscription(row) {
      await submit('retryLogisticsSubscription', { orderId: row.id, reason: '已核实配置与额度，重试当前包裹物流订阅' }, false);
    }
    function openEvidence(fileId) { if (window.LXM_UPLOAD) return window.LXM_UPLOAD.open({ fileId, type: 'image', name: '售后凭证' }); }
    async function exportRows() {
      try {
        const response = await window.LXM_HTTP.request('/api/physical/admin/export?' + new URLSearchParams({ status: p.status, keyword: p.keyword }));
        if (!response.ok || !(response.headers.get('content-type') || '').includes('text/csv')) throw new Error('导出失败');
        const url = URL.createObjectURL(await response.blob()), a = document.createElement('a'); a.href = url; a.download = '实物订单.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { p.error = error.message; }
    }
    let timer = setInterval(() => { if (p.type === 'physical' && !p.loading && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) load(); }, 30000);
    onUnmounted(() => { p.alive = false; clearInterval(timer); });
    return { physical: p, physicalNames: names, physicalMoney: money, physicalLabel: label, physicalItems: items,
      physicalCan: can, physicalLoad: load, physicalType: changeType, physicalDetail: detail, physicalOpenShip: openShip,
      physicalShip: ship, physicalTickets: tickets,
      physicalReview: review, physicalInspect: inspect, physicalWithdraw: withdrawal, physicalRefresh: refresh,
      physicalExport: exportRows, physicalSubmit: submit,
      physicalCanReview: canReview, physicalCanInspect: canInspect, physicalRetrySubscription: retrySubscription, physicalOpenEvidence: openEvidence };
  };
})();
