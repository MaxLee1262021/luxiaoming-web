/* Customer-service desk: all decisions, amounts and countdown values come from the protected API. */
(function () {
  const statusNames = { new: '待认领', reserved: '复购预占', claimed: '待确认', confirmed: '待派单 / 已定档', shooting: '拍摄中', final_pending: '拍摄中（待付尾款）', done: '已完成', refunded: '已退款', canceled: '已取消' };
  const categories = { photo: '照片', video: '视频', combo: '套餐', peripheral: '周边' };
  const timelineNames = {
    claim: '认领订单', reserve_take: '接受预占订单', reserve_timeout: '预占超时回流', reserve_giveup: '放弃预占',
    slot_confirm: '确认拍摄时间', customer_arrival: '游客确认到达', shoot_start: '开始拍摄', shoot_finish: '完成拍摄', link_generate: '生成服务链接', refund: '订单退款',
    receipt_confirmed: '客户收货完成', reschedule: '改期', assign: '登记派单', transfer: '转派', bind: '建立绑定', renew: '绑定续期',
    release: '解除绑定', makeup: '补发', cancel_offset: '撤销冲抵', restore: '恢复提成', offset_plan: '冲抵计划', void: '置零'
  };
  const timelineTitle = item => timelineNames[item.title] || item.title || timelineNames[item.action] || '服务记录';
  const responsibility = { service: '客服责任', photo: '摄影师责任', user: '用户原因', unknown: '无法判定' };
  const effectNames = { void: '不计提成', offset_planned: '已排冲抵', offset_done: '冲抵完成', none: '无影响' };
  const bindingNames = { active: '保护中', released: '已解除', expired: '已过期' };
  window.LXM_SVC_WORKBENCH_SETUP = function (ctx, mode) {
    const { reactive, computed, onMounted, onUnmounted } = Vue;
    // Opt-in context for embedded instances. Legacy callers keep their original
    // navigation globals and mounted requests; the general desk uses local state.
    const navigation = ctx.kfIsolation || window;
    const filtersKey = ctx.kfIsolation ? 'filters' : 'LXM_KF_Filters';
    const aftersaleKey = ctx.kfIsolation ? 'aftersale' : 'LXM_KF_AFtersale';
    const s = reactive({ loading: false, busy: false, error: '', reserveError: '', rows: [], reserves: [], total: 0, summary: {}, tab: mode === 'intake' ? 'all' : 'active', query: { keyword: '', type: '', status: '', photo: '', page: 1, size: 20 }, drawer: false, detail: null, detailLoading: false, detailError: '', dialog: '', current: null, form: {}, photographers: [], staffMembers: [], bindings: [], bindingsTotal: 0, bindingPage: 1, config: {}, configVer: 0, configActive: {}, configHistory: [], linkInput: '', linkOrder: null, linkResult: null, linkError: '', linkLoading: false, fromOrder: '' });
    Object.assign(s, { detailTab: 'timeline', complaintOrders: [], complaintForm: { order_no: '', resp: 'service', reason: '' }, inlineError: '', linkMatchTimer: null, bindingError: '', reserveTotal:0 });
    Object.assign(s, { rescheduleVisible: false, rescheduleLoading: false, rescheduleBusy: false, rescheduleError: '', rescheduleRows: [] });
    let rescheduleId = 0;
    let alive = true, requestId = 0, detailId = 0, reserveId = 0, reserveInFlight = false, loadInFlight = false, reserveTimer, refreshTimer, countdownTimer, searchTimer;
    let loadController, reserveController, detailController;
    const controller = () => typeof AbortController === 'function' ? new AbortController() : null;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    // Countdown is the server's left_seconds. The browser never recalculates
    // an expiry from its own clock; holding always displays a frozen --:--.
    function rememberCountdowns() {}
    const admin = computed(() => ['super', 'admin'].includes(ctx.state.role));
    const supervisor = computed(() => ['supervisor', 'service_supervisor'].includes(ctx.state.role));
    const operator = computed(() => ['super', 'admin', 'service', 'supervisor', 'service_supervisor'].includes(ctx.state.role));
    const rescheduleReviewer = computed(() => ['super', 'service'].includes(ctx.state.role));
    const canComplaint = computed(() => ['super', 'admin', 'service', 'supervisor', 'service_supervisor', 'finance'].includes(ctx.state.role));
    const title = { workbench: '工作台', intake: '订单承接', followup: '跟进与完成', complaints: '客诉与退款' }[mode];
    const rowsOf = data => Array.isArray(data) ? data : data?.list || data?.rows || [];
    const orderNo = row => String(row?.order_no || row?.no || row?.order?.order_no || '');
    const orderStatus = row => row?.service_status || row?.order?.service_status || '';
    const money = value => value == null ? '—' : '¥' + (Number(value) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const time = value => value ? String(value).replace('T', ' ').replace(/Z$/, '').slice(0, 19) : '—';
    function rescheduleTime(value) {
      const date = new Date(value);
      return /(?:Z|[+-]\d\d:\d\d)$/.test(String(value || '')) && Number.isFinite(date.getTime())
        ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : time(value);
    }
    const shortOpenid = value => value ? (String(value).length > 12 ? String(value).slice(0, 5) + '…' + String(value).slice(-4) : String(value)) : '—';
    const countdown = row => row.status === 'holding' || row.reserve_defer ? '--:--' : String(Math.floor(Number(row.left_seconds || 0) / 60)).padStart(2, '0') + ':' + String(Number(row.left_seconds || 0) % 60).padStart(2, '0');
    const progress = row => row.status === 'holding' || row.reserve_defer ? 100 : Math.max(0, Math.min(100, Number(row.left_seconds || 0) / Math.max(1, Number(row.hold_minutes || 60) * 60) * 100));
    function owns(row) { return typeof row?.can_operate === 'boolean' ? row.can_operate : admin.value || !!ctx.state.currentStaffId && String(row?.assignee_id || row?.reserve_staff_id || row?.staff_id || '') === String(ctx.state.currentStaffId); }
    function canClaim(row) { return operator.value && row?.can_claim === true && orderStatus(row) === 'new'; }
    function canAct(row) { return operator.value && owns(row) && ['claimed', 'confirmed', 'shooting'].includes(orderStatus(row)); }
    function isPeripheral(row) { return (row?.category || row?.order?.category) === 'peripheral'; }
    function canStart() { return false; }
    function canOpen(kind, row) {
      if (kind === 'claim') return canClaim(row);
      if (!['confirm', 'reschedule', 'assign', 'transfer'].includes(kind)) return true;
      if (!canAct(row)) return false;
      if (kind === 'reschedule') return true;
      if (isPeripheral(row)) return false;
      if (kind === 'confirm') return orderStatus(row) === 'claimed';
      if (kind === 'assign') return orderStatus(row) === 'confirmed' && !row.photo_id;
      return !!row.photo_id;
    }
    function canGenerateLink(row) { return operator.value && !!row && row.can_operate !== false && (typeof row.can_generate_link === 'boolean' ? row.can_generate_link : row.is_owner !== false && row.owned !== false && row.is_mine !== false); }
    function canRejudge(row) { return typeof row?.can_rejudge === 'boolean' ? row.can_rejudge : admin.value; }
    const paymentLabel = row => row?.payment_status_label || (row?.has_paid === false || !row?.paid_at ? '未支付' : '已支付');
    function assigneeLabel(row) {
      if (row?.assignee_name || row?.assignee_id) return row.assignee_name || row.assignee_id;
      if (row?.reserve_staff_name || row?.reserve_staff_id || orderStatus(row) === 'reserved' || ['holding', 'started'].includes(row?.reserve_status)) return row.reserve_staff_name || '复购预占';
      if (orderStatus(row) === 'new') return row?.payment_status === 'unpaid' ? '待支付' : '公共池';
      return '未记录客服归属';
    }
    const createdTime = row => row?.created_at || row?.createdAt;
    const statusLabel = row => orderStatus(row) === 'new' && row?.payment_status === 'unpaid' ? '待支付'
      : orderStatus(row) === 'confirmed' ? row?.photo_id ? '已定档' : '待派单'
        : orderStatus(row) === 'final_pending' ? '拍摄中' : statusNames[orderStatus(row)] || '—';
    function canAftersale(row) { return canComplaint.value && !!row && (typeof row.can_complaint === 'boolean' ? row.can_complaint : owns(row) || ctx.state.role === 'finance' && !!(row.service_managed || row.svc_paid_processed)); }
    function canReviewReschedule(row) {
      if (!rescheduleReviewer.value || row?.rescheduleRequest?.status !== 'pending') return false;
      if (typeof row.canReviewReschedule === 'boolean') return row.canReviewReschedule;
      const assignee = row.assigneeId || row.assignee_id || row.serviceUserId;
      return ctx.state.role === 'super' || !assignee || String(assignee) === String(ctx.state.currentStaffId || '');
    }
    function rescheduleCanApprove(row) {
      return canReviewReschedule(row) && !row.deleted && !row.isDeleted && !row.shootingStartedAt && !row.shootingCompletedAt
        && !['shooting', 'selection_pending', 'awaiting_delivery', 'awaiting_final_payment', 'final_pending', 'editing', 'retouching', 'paid', 'delivered', 'completed', 'done', 'cancelled', 'canceled', 'refunded', 'terminated', 'deleted', '拍摄中', '已拍摄', '已完成', '已交付', '已取消', '已退款', '已中止']
          .some(status => [row.status, row.workflowStage, row.businessStatus, row.service_status].includes(status));
    }
    async function loadRescheduleRequests() {
      if (!rescheduleReviewer.value || s.rescheduleBusy || s.rescheduleLoading) return;
      const seq = ++rescheduleId;
      s.rescheduleLoading = true; s.rescheduleError = '';
      try {
        if (!window.LXM_CLOUD?.getColl) throw new Error('改期申请暂不可用，请刷新后重试');
        const response = await window.LXM_CLOUD.getColl('orders');
        if (!alive || seq !== rescheduleId) return;
        const rows = Array.isArray(response) ? response : rowsOf(response?.data || response);
        s.rescheduleRows = rows.filter(row => row?.rescheduleRequest?.status === 'pending')
          .sort((a, b) => String(a.rescheduleRequest.requestedAt || '').localeCompare(String(b.rescheduleRequest.requestedAt || '')));
      } catch (e) { if (alive && seq === rescheduleId) s.rescheduleError = e.message; }
      finally { if (alive && seq === rescheduleId) s.rescheduleLoading = false; }
    }
    async function openRescheduleRequests() {
      if (!rescheduleReviewer.value) return;
      s.rescheduleVisible = true;
      await loadRescheduleRequests();
    }
    async function reviewReschedule(row, approved) {
      if (s.rescheduleBusy || s.rescheduleLoading || !canReviewReschedule(row) || approved && !rescheduleCanApprove(row)) return;
      const request = row.rescheduleRequest, id = row.id || row._id;
      if (!id || !request.id) return;
      s.rescheduleBusy = true; s.rescheduleError = '';
      let reason = '同意客人改期申请', failure = '';
      try {
        if (approved) await ctx.ElMessageBox.confirm(`订单 ${row.orderNo || id} 将由 ${row.appointmentAt || '待确认'} ${row.timePeriod || ''} 改为 ${request.appointmentAt} ${request.timePeriod}。确认同意客人的改期申请？`, '审核改期申请', { confirmButtonText: '同意并改期', cancelButtonText: '返回', type: 'warning' });
        else {
          const result = await ctx.ElMessageBox.prompt('请填写驳回原因，客人可在订单中查看。', '驳回改期申请', { confirmButtonText: '确认驳回', cancelButtonText: '返回', inputType: 'textarea', inputValidator: value => String(value || '').trim().length >= 2 && String(value || '').trim().length <= 500 || '请填写 2 至 500 字的驳回原因' });
          reason = String(result?.value || '').trim();
          if (reason.length < 2 || reason.length > 500) { s.rescheduleBusy = false; return; }
        }
      } catch (_) { s.rescheduleBusy = false; return; }
      if (!alive) return;
      try {
        const reviewBody = { requestId: request.id, approved: !!approved, reason };
        if (typeof ctx.kfIsolation?.reviewReschedule === 'function') await ctx.kfIsolation.reviewReschedule(id, reviewBody);
        else {
          if (!window.LXM_CLOUD?.orderAction) throw new Error('改期审核暂不可用，请刷新后重试');
          await window.LXM_CLOUD.orderAction(id, 'reviewreschedule', reviewBody);
        }
        if (!alive) return;
        s.rescheduleRows = s.rescheduleRows.filter(item => (item.id || item._id) !== id);
        ctx.ElMessage.success(approved ? '已同意改期，拍摄时间已更新' : '已驳回，原拍摄时间保持不变');
        if (!ctx.kfIsolation?.suppressAutoLoad) await load(false);
        if (typeof ctx.kfIsolation?.onAction === 'function') await ctx.kfIsolation.onAction();
        if (s.drawer && s.detail) await openDetail(s.detail);
      } catch (e) {
        if (alive) { failure = e.message; s.rescheduleError = failure; ctx.ElMessage.error(failure); }
      } finally { if (alive) s.rescheduleBusy = false; }
      if (alive) { await loadRescheduleRequests(); if (failure) s.rescheduleError = failure; }
    }
    async function api(path, method = 'GET', body, options = {}) {
      const response = await window.LXM_HTTP.request('/api/kf/' + path, { method, ...(options.signal ? { signal: options.signal } : {}), ...(body != null ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const payload = await response.json();
      if (!response.ok || payload.code !== 0) throw Object.assign(new Error(payload.msg || payload.error || '服务暂不可用'), { code: payload.code, data: payload.data });
      return payload.data;
    }
    function query(extra = {}) { const q = new URLSearchParams(); for (const [key, value] of Object.entries({ ...s.query, ...extra })) if (value !== '' && value != null) q.set(key, value); return q.toString(); }
    async function load(reset = false, background = false) {
      if (!alive || background && (loadInFlight || s.busy || hidden())) return;
      if (reset) s.query.page = 1;
      const seq = ++requestId;
      loadController?.abort(); loadController = controller();
      // A full overview includes reserves. Avoid a simultaneous polling read,
      // and prevent its older response replacing this newly loaded overview.
      if (mode === 'workbench' || mode === 'intake') { reserveId++; reserveController?.abort(); reserveInFlight = false; }
      loadInFlight = true;
      if (!background) s.loading = true;
      s.error = '';
      try {
        let data;
        if (mode === 'workbench' || mode === 'intake') {
          data = await api('workbench/overview?' + query({ mode, tab: mode === 'intake' ? s.tab : '' }), 'GET', undefined, { signal: loadController?.signal });
          if (!alive || seq !== requestId) return;
          if (mode === 'workbench') s.summary = data.summary || {};
          s.reserves = rowsOf(data.reserved);s.reserveTotal=Number(data.reserved?.total ?? s.reserves.length); rememberCountdowns(s.reserves); s.reserveError = '';
        } else if (mode === 'complaints') data = await api('complaints?' + query(), 'GET', undefined, { signal: loadController?.signal });
        else data = await api('orders/mine?' + query({ view: mode === 'followup' ? s.tab : '', status: mode === 'followup' && s.tab === 'done' ? 'done' : s.query.status }), 'GET', undefined, { signal: loadController?.signal });
        if (!alive || seq !== requestId) return;
        s.rows = rowsOf(data); s.total = Number(data?.total ?? s.rows.length); rememberCountdowns(s.rows);
      } catch (e) { if (alive && seq === requestId && e.name !== 'AbortError') s.error = e.message; }
      finally { if (alive && seq === requestId) { s.loading = false; loadInFlight = false; } }
    }
    async function refreshReserves() {
      if (!alive || reserveInFlight || loadInFlight || s.busy || hidden()) return;
      const seq = ++reserveId;
      reserveController = controller();
      reserveInFlight = true;
      try { const data = await api('orders/reserved?size=100', 'GET', undefined, { signal: reserveController?.signal }); if (alive && seq === reserveId) {
        s.reserves = rowsOf(data);s.reserveTotal=Number(data?.total ?? s.reserves.length);const byOrder=new Map(s.reserves.map(row=>[orderNo(row),row]));
        s.rows=s.rows.map(row=>orderStatus(row)==='reserved' && byOrder.has(orderNo(row)) ? {...row,...byOrder.get(orderNo(row))} : row);
        s.reserveError = '';
      } }
      catch (e) { if (alive && seq === reserveId && e.name !== 'AbortError') s.reserveError = '预占倒计时暂未更新：' + e.message; }
      finally { if (seq === reserveId) reserveInFlight = false; }
    }
    async function openDetail(row) {
      const no = orderNo(row); if (!no) return;
      s.drawer = true; s.detail = null; s.detailError = ''; s.detailLoading = true; s.detailTab = 'timeline'; s.dialog = '';
      const seq = ++detailId;
      detailController?.abort(); detailController = controller();
      try { const data = await api('orders/' + encodeURIComponent(no), 'GET', undefined, { signal: detailController?.signal }); if (alive && seq === detailId) s.detail = data?.order ? { ...data.order, ...data } : data; }
      catch (e) { if (alive && seq === detailId && e.name !== 'AbortError') s.detailError = e.message; }
      finally { if (alive && seq === detailId) s.detailLoading = false; }
    }
    async function action(path, body, success = '操作已完成') {
      if (s.busy) return;
      s.busy = true; s.error = '';
      try {
        const result = await api(path, 'POST', body || {});
        if (!alive) return result;
        ctx.ElMessage.success(typeof success === 'function' ? success(result) : success); s.dialog = '';
        if (!ctx.kfIsolation?.suppressAutoLoad) await load(false);
        if (typeof ctx.kfIsolation?.onAction === 'function') await ctx.kfIsolation.onAction();
        if (s.drawer && s.detail) await openDetail(s.detail);
        return result;
      } catch (e) {
        if (alive) {
          s.error = e.message; ctx.ElMessage.error(e.message);
          if (Number(e.code) === 4010) {
            const no = body?.order_no || s.form.order_no || orderNo(s.current);
            s.dialog = '';
            if (mode === 'complaints') {
              s.query.keyword = no; await load(true);
              const existing = s.rows.find(row => String(row.id) === String(e.data?.complaint_id || e.data?.id) || orderNo(row) === no);
              if (existing) await openDetail(existing);
            } else {
              navigation[filtersKey] = { page: 'svcComplaints', keyword: no };
              ctx.switchMenu('svcComplaints');
            }
          } else if ([4001, 4002, 4004, 4005].includes(Number(e.code))) await load();
        }
      } finally { if (alive) s.busy = false; }
    }
    async function claim(row) { if (!canClaim(row)) return; if (supervisor.value) return open('claim',row); return action('orders/' + encodeURIComponent(orderNo(row)) + '/claim', { expected_status: 'new' }, '已认领，请确认拍摄时间'); }
    async function reserve(row, kind) {
      if (!operator.value || !owns(row) || orderStatus(row) !== 'reserved') return;
      if (kind === 'giveup') { try { await ctx.ElMessageBox.confirm('放弃后该单立即回到公共池。若该客户已无其他预占单，保护绑定一并解除。', '放弃预占', { type: 'warning' }); } catch (_) { return; } }
      return action('orders/' + encodeURIComponent(orderNo(row)) + '/reserve/' + kind, { expected_status: 'reserved' }, kind === 'take' ? '已接单，保护绑定已续期' : '已放弃预占，该单已回流');
    }
    async function open(kind, row) {
      if (!canOpen(kind, row)) return;
      s.dialog = kind; s.current = row || null; s.error = '';
      const item = s.current || {};
      s.form = { expected_status: orderStatus(item), new_time: kind === 'confirm' ? item.requested_time || '' : item.schedule_time || '', reason: '', channel: 'wechat', to_photo: '', order_no: orderNo(item), resp: item.current_resp || item.resp || 'unknown' };
      if (kind === 'claim') {
        s.staffMembers = []; s.form.staff_id = '';
        try { const data = await api('staff'); if (alive && s.dialog === 'claim') { s.staffMembers = rowsOf(data); s.form.staff_id = s.staffMembers.find(person => person.is_self)?.id || ''; } }
        catch (e) { s.error = e.message; }
      }
      if (['assign', 'transfer'].includes(kind)) {
        try { const data = await api('photographers'); if (alive) s.photographers = rowsOf(data).filter(p => (!p.status || p.status === 'active') && (kind !== 'transfer' || String(p.id) !== String(item.photo_id))); }
        catch (e) { s.error = e.message; }
      }
      if (kind === 'link') { s.linkInput = orderNo(item); s.linkOrder = null; s.linkResult = null; s.linkError = ''; if (s.linkInput) await resolveLink(); }
      if (kind === 'config') {
        try { const data = await api('rebuy/config'); if (!alive) return; s.configActive = data.active || {}; s.config = { ...(data.latest || data.active || {}) }; s.configVer = Number(s.config.ver || 0); s.configHistory = data.versions || []; }
        catch (e) { s.error = e.message; }
      }
      if (kind === 'bindings') { s.bindingPage = 1; await loadBindings(); }
    }
    async function submit() {
      const kind = s.dialog, no = orderNo(s.current), f = { ...s.form };
      if (!canOpen(kind, s.current)) return;
      if (kind === 'claim') {
        if (!f.staff_id) return ctx.ElMessage.warning('请选择实际承接客服');
        return action('orders/' + encodeURIComponent(no) + '/claim', { expected_status: 'new', staff_id: f.staff_id }, '已为所选客服认领，提成归属所选客服');
      }
      if (['confirm', 'reschedule'].includes(kind) && !f.new_time) return ctx.ElMessage.warning('请选择拍摄时间');
      if (['reschedule', 'assign', 'transfer', 'complaint', 'rejudge'].includes(kind) && !String(f.reason).trim()) return ctx.ElMessage.warning('请填写原因');
      if (kind === 'confirm' && s.current?.requested_time && f.new_time !== s.current.requested_time && !f.reason.trim()) return ctx.ElMessage.warning('确认时间与用户提交值不同，请填写改期原因');
      if (['assign', 'transfer'].includes(kind) && !f.to_photo) return ctx.ElMessage.warning('请选择在职摄影师');
      const endpoint = { confirm: 'slot/confirm', reschedule: 'slot/reschedule', assign: 'assign', transfer: 'transfer' }[kind];
      if (endpoint) return action('orders/' + encodeURIComponent(no) + '/' + endpoint, f, kind === 'reschedule' ? '已改期，订单状态保持不变' : kind === 'transfer' ? '已转派，原摄影师报酬按结算状态置零或冲抵；客服归属及提成保持不变' : kind === 'assign' ? '摄影师已安排，订单已定档；游客确认到达点位后自动进入拍摄中并可支付尾款' : '拍摄时间已确认，安排摄影师后订单进入已定档');
      if (kind === 'complaint') return action('complaints', f, '售后与判责已登记');
      if (kind === 'rejudge') return action('complaints/' + encodeURIComponent(no) + '/rejudge', { resp: f.resp, reason: f.reason }, '改判已记录，差额按结算状态调账');
    }
    async function shoot() {
      return ctx.ElMessage.warning('游客确认到达点位后自动进入拍摄中，尾款支付成功后自动完成，无需客服手动变更');
    }
    async function confirmReceipt(row) {
      if (!isPeripheral(row) || !canAct(row)) return;
      try { await ctx.ElMessageBox.confirm('请确认客户已经收到实物商品。登记后该订单完成，提成观察期从本次登记时间开始；无需摄影师或拍摄登记。', '确认客户收货', { type: 'warning', confirmButtonText: '客户已收货，登记完成', cancelButtonText: '取消' }); }
      catch (_) { return; }
      return action('orders/' + encodeURIComponent(orderNo(row)) + '/receipt/confirm', { received: true, expected_status: orderStatus(row) }, '已登记收货完成，提成进入观察期');
    }
    async function aftersale(row) {
      if (!canAftersale(row) || s.busy) return;
      if (operator.value) {
        if (typeof ctx.openServiceAfterSale !== 'function') return ctx.ElMessage.error('售后服务暂不可用，请刷新后重试');
        s.busy = true;
        try { await ctx.openServiceAfterSale(orderNo(row)); }
        finally { if (alive) s.busy = false; }
        return;
      }
      s.fromOrder = orderNo(row); navigation[aftersaleKey] = { order_no: orderNo(row), expected_status: orderStatus(row) }; s.drawer = false; ctx.switchMenu('svcComplaints');
    }
    async function resolveLink() {
      const no = s.linkInput.trim(); s.linkOrder = null; s.linkResult = null; s.linkError = '';
      if (!no) { s.linkError = '请输入真实订单号'; return; }
      s.linkLoading = true;
      try { const data = await api('link/resolve?no=' + encodeURIComponent(no)); if (alive && s.linkInput.trim() === no) s.linkOrder = data?.order ? { ...data.order, ...data } : data; }
      catch (e) { if (alive) s.linkError = e.message + (e.data?.candidates?.length ? '；候选订单：' + e.data.candidates.join('、') : ''); }
      finally { if (alive) s.linkLoading = false; }
    }
    async function generateLink() {
      if (!canGenerateLink(s.linkOrder)) return;
      s.linkLoading = true; s.linkError = '';
      try { const data = await api('link/generate', 'POST', { order_no: orderNo(s.linkOrder), no: orderNo(s.linkOrder) }); if (alive) s.linkResult = data; }
      catch (e) { if (alive) s.linkError = e.message; }
      finally { if (alive) s.linkLoading = false; }
    }
    async function loadBindings() { try { const data = await api('rebuy/bindings?' + new URLSearchParams({ page: s.bindingPage, size: 20 })); if (alive) { s.bindings = rowsOf(data); s.bindingsTotal = Number(data?.total ?? s.bindings.length); } } catch (e) { s.error = e.message; } }
    function search() { clearTimeout(searchTimer); searchTimer = setTimeout(() => load(true), 300); }
    function linkInputChange() { s.linkOrder = null; s.linkResult = null; clearTimeout(s.linkMatchTimer); if (s.linkInput.trim()) s.linkMatchTimer = setTimeout(resolveLink, 400); }
    function goto(page, status) { navigation[filtersKey] = { page, status: status || '' }; ctx.switchMenu(page); }
    function todoAction(row) {
      if (row.suggested_action === 'rejudge') {
        if (canRejudge(row)) return open('rejudge', row);
        navigation[filtersKey] = { page: 'svcComplaints', keyword: orderNo(row) };
        return ctx.switchMenu('svcComplaints');
      }
      return openDetail(row);
    }
    function selectTab(value) { s.tab = value; tabChange(); }
    async function prepareComplaintOrders() {
      try { const data = await api('orders/mine?size=100'); if (alive) s.complaintOrders = rowsOf(data).filter(row => !['canceled','refunded','reserved','new'].includes(orderStatus(row))); }
      catch (e) { if (alive) s.inlineError = e.message; }
    }
    async function saveComplaint() {
      if (!s.complaintForm.order_no || !s.complaintForm.reason.trim()) return ctx.ElMessage.warning('请选择关联订单并填写问题描述');
      const result = await action('complaints', { ...s.complaintForm }, '售后与判责已登记');
      if (result) { s.complaintForm.reason = ''; s.fromOrder = ''; }
    }
    async function drawerTab(tab) {
      s.detailTab = tab;
      if (tab !== 'actions' || !s.detail || isPeripheral(s.detail) || !canAct(s.detail)) return;
      if (orderStatus(s.detail) === 'claimed') await open('confirm', s.detail);
      else if (orderStatus(s.detail) === 'confirmed' && !s.detail.photo_id) await open('assign', s.detail);
    }
    const adjustments = computed(() => {
      const values = new Map();
      for (const row of s.rows) for (const item of row.adjustments || []) values.set(String(item.id), { ...item, customer_openid: row.customer_openid, staff_name: row.assignee_name || row.assignee_id });
      return [...values.values()].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
    });
    const statusClass = row => ({new:'r',reserved:'p',claimed:'w',confirmed:'a',shooting:'a',final_pending:'w',done:'g',refunded:'n',canceled:'n'})[orderStatus(row)] || 'n';
    const priority = row => ({urgent:'最急',high:'高',medium:'中',normal:'常规',0:'最急',1:'高',2:'高',3:'中',4:'中',5:'常规',6:'常规'})[row.priority] || '常规';
    const stepIndex = row => ({new:0,reserved:0,claimed:1,confirmed:2,shooting:3,final_pending:4,done:5,refunded:5,canceled:5})[orderStatus(row)] || 0;
    const shortTime = value => value ? time(value).slice(5,16) : '—';
    const bindDays = row => { const end = Date.parse(String(row.expire_at || '').replace(' ','T') + (/Z|[+-]\d\d:\d\d$/.test(row.expire_at || '') ? '' : '+08:00')); return Number.isFinite(end) ? Math.max(0, Math.ceil((end - Date.now()) / 86400000)) : null; };
    async function saveConfig() {
      if (s.busy) return; s.busy = true;
      try { await api('rebuy/config', 'PUT', { ...s.config, holiday_dates: s.config.holiday_dates || [], workday_dates: s.config.workday_dates || [], ver: s.configVer }); ctx.ElMessage.success('复购参数新版本已保存，次日 00:00 生效'); s.dialog = ''; await load(); }
      catch (e) { s.error = e.message; ctx.ElMessage.error(e.message); }
      finally { s.busy = false; }
    }
    async function copy(value) { if (!value) return; try { await navigator.clipboard.writeText(String(value)); ctx.ElMessage.success('已复制完整内容'); } catch (_) { ctx.ElMessage.warning('浏览器未允许复制，请在详情中手动选择完整内容'); } }
    function tabChange() { s.query.status = ''; load(true); }
    const visibleRows = computed(() => mode !== 'followup' || s.tab === 'done' ? s.rows : s.rows.filter(row => ['claimed', 'confirmed', 'shooting', 'final_pending'].includes(orderStatus(row))));
    const reserveSummary = computed(() => {
      if (!s.reserves.length) return '暂无待接单的复购订单';
      const minutes=[...new Set(s.reserves.map(row=>Number(row.hold_minutes)).filter(value=>Number.isInteger(value)&&value>0))];
      return `${s.reserveTotal} 单老客户复购` + (minutes.length===1 && s.reserves.every(row=>Number(row.hold_minutes)===minutes[0]) ? `，先给你 ${minutes[0]} 分钟` : '，剩余时间以每单倒计时为准');
    });
    onMounted(async () => {
      if (ctx.kfIsolation?.suppressAutoLoad) return;
      if (navigation[filtersKey] && navigation[filtersKey].page === ctx.state.active) { s.query.status = navigation[filtersKey].status || ''; s.query.keyword = navigation[filtersKey].keyword || ''; s.query.photo = navigation[filtersKey].photo || ''; delete navigation[filtersKey]; }
      await load();
      if (!alive) return;
      if (mode === 'intake') await loadBindings();
      if (mode === 'complaints') await prepareComplaintOrders();
      if (mode === 'workbench' || mode === 'intake') reserveTimer = setInterval(refreshReserves, 1000);
      if (mode === 'workbench' || mode === 'intake') refreshTimer = setInterval(() => load(false, true), 30000);
      if (mode === 'complaints' && navigation[aftersaleKey]) { const source = navigation[aftersaleKey]; delete navigation[aftersaleKey]; s.fromOrder = source.order_no; s.complaintForm.order_no = source.order_no; }
    });
    onUnmounted(() => { alive = false; rescheduleId++; requestId++; detailId++; reserveId++; loadController?.abort(); reserveController?.abort(); detailController?.abort(); clearInterval(reserveTimer); clearInterval(refreshTimer); clearInterval(countdownTimer); clearTimeout(searchTimer); clearTimeout(s.linkMatchTimer); });
    return { kfRescheduleTime: rescheduleTime, kfRescheduleReviewer: rescheduleReviewer, kfRescheduleCanReview: canReviewReschedule, kfRescheduleCanApprove: rescheduleCanApprove, kfOpenReschedules: openRescheduleRequests, kfLoadReschedules: loadRescheduleRequests, kfReviewReschedule: reviewReschedule, kfReserveSummary: reserveSummary, kfTodoAction: todoAction, kfSearch: search, kfSelectTab: selectTab, kfGoto: goto, kfLinkInput: linkInputChange, kfSaveComplaint: saveComplaint, kfDrawerTab: drawerTab, kfAdjustments: adjustments, kfStatusClass: statusClass, kfPriority: priority, kfStepIndex: stepIndex, kfShortTime: shortTime, kfBindDays: bindDays, kf: s, kfMode: mode, kfTitle: title, kfStatusNames: statusNames, kfCategories: categories, kfRespNames: responsibility, kfEffectNames: effectNames, kfBindingNames: bindingNames, kfMoney: money, kfTime: time, kfTimelineTitle: timelineTitle, kfPaymentLabel: paymentLabel, kfAssigneeLabel: assigneeLabel, kfCreatedTime: createdTime, kfStatusLabel: statusLabel, kfNo: orderNo, kfStatus: orderStatus, kfOpenid: shortOpenid, kfCountdown: countdown, kfProgress: progress, kfOwns: owns, kfCanClaim: canClaim, kfCanAct: canAct, kfCanStart: canStart, kfCanAftersale: canAftersale, kfIsPeripheral: isPeripheral, kfCanGenerateLink: canGenerateLink, kfCanRejudge: canRejudge, kfCanOperate: operator, kfAdmin: admin, kfCanComplaint: canComplaint, kfLoad: load, kfTab: tabChange, kfRows: visibleRows, kfDetail: openDetail, kfOpen: open, kfSubmit: submit, kfClaim: claim, kfReserve: reserve, kfShoot: shoot, kfReceipt: confirmReceipt, kfAftersale: aftersale, kfResolveLink: resolveLink, kfGenerateLink: generateLink, kfLoadBindings: loadBindings, kfSaveConfig: saveConfig, kfCopy: copy };
  };
})();
