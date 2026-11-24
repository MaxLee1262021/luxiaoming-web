/* This page owns its workflow and temporary state. Existing desk components keep their defaults. */
(function () {
  const STATUS = { new: '待认领', reserved: '复购预占', claimed: '待确认', confirmed: '已确认待拍', shooting: '拍摄中', final_pending: '待付尾款', done: '已完成', refunded: '已退款', canceled: '已取消' };
  const CATEGORY = { photo: '照片留影', video: '视频摄像', combo: '旅拍套餐', peripheral: '周边服务' };
  const BUCKETS = [{ key: 'AM', label: '上午', range: '06:00–12:00', start: 6, end: 12, recommended: '10:00:00' }, { key: 'PM', label: '下午', range: '12:00–18:00', start: 12, end: 18, recommended: '14:00:00' }, { key: 'EVE', label: '晚间', range: '18:00–24:00', start: 18, end: 24, recommended: '19:00:00' }];
  const mask = value => value == null || value === '' ? '—' : String(value).replace(/(^|[^\d])(1\d{2})\d{4}(\d{4})(?!\d)/g, '$1$2****$3');
  const phone = value => !value ? '—' : /^1\d{10}$/.test(String(value)) ? String(value).slice(0, 3) + '****' + String(value).slice(-4) : String(value).includes('****') ? String(value) : '联系方式已隐藏';
  const no = row => String(row?.order_no || row?.orderNo || row?.no || '');
  const status = row => row?.service_status || '';
  const rowsOf = value => Array.isArray(value) ? value : value?.list || value?.rows || [];
  const datePart = value => {
    const text = String(value || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(text) && !/(?:Z|[+-]\d\d:\d\d)$/.test(text)) return text.slice(0, 10);
    const d = value ? new Date(value) : new Date();
    return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : '';
  };
  const timeText = value => value ? mask(String(value).replace('T', ' ').replace(/Z$/, '').slice(0, 19)) : '—';
  const bucketOf = value => {
    const text = String(value || ''); const m = text.match(/^\d{4}-\d{2}-\d{2}[ T](\d{2}):\d{2}/);
    if (!m) return null;
    return BUCKETS.find(bucket => Number(m[1]) >= bucket.start && Number(m[1]) < bucket.end) || null;
  };
  function displayView(value, cache = new WeakMap()) {
    if (!value || typeof value !== 'object' || value instanceof Date) return typeof value === 'string' && value ? mask(value) : value;
    if (cache.has(value)) return cache.get(value);
    const proxy = new Proxy(value, {
      get(target, key) {
        const result = Reflect.get(target, key, target);
        // Vue's identity/RAW flags must remain untouched. Wrapping RAW or using
        // this display proxy as a setter receiver suppresses reactive updates.
        return typeof key === 'string' && key.startsWith('__v_') ? result : displayView(result, cache);
      },
      set(target, key, next) { return Reflect.set(target, key, next, target); }
    });
    cache.set(value, proxy); return proxy;
  }
  function displayTemplate(template) {
    return template.replace(/{{([\s\S]*?)}}/g, (_, expression) => '{{ gwMask(' + expression.trim() + ') }}')
      .replace(/:(title|label|description)="([^"]*)"/g, (_, name, expression) => ':' + name + '="gwMask(' + expression + ')"');
  }
  function dialogFragment(template) {
    const start = template.indexOf('<el-dialog :model-value="!!kf.dialog"');
    if (start < 0) throw new Error('原客服操作组件暂不可用');
    const end = template.indexOf('</el-dialog>', start);
    if (end < 0) throw new Error('原客服操作组件不完整');
    return template.slice(start, end + '</el-dialog>'.length);
  }
  function physicalFragment(template) {
    const start = template.indexOf('<template v-if="physical.type');
    const end = template.indexOf('  <template v-else>', start);
    if (start < 0 || end < 0) throw new Error('实物工作区暂不可用');
    return template.slice(start, end);
  }
  window.LXM_PAGES.register({
    key: 'svcGeneralWorkbench', component: 'LxmPageSvcGeneralWorkbench', group: 'service', title: '总工作台', styleScope: 'page-route-general-workbench',
    setup(ctx) {
      const { reactive, computed, ref, markRaw, nextTick, provide, onMounted, onUnmounted } = Vue;
      const isolation = reactive({ suppressAutoLoad: true, disablePolling: true, filters: null, aftersale: null });
      const s = reactive({ loading: false, busy: false, error: '', cardsFailed: false, cards: {}, capabilities: {}, rows: [], total: 0, reserves: [], reserveTotal: 0, reserveError: '', serverTime: '', scope: '', workspace: 'service', workspaceLoading: false, workspaceError: '', embedded: null, embeddedKey: '', toolComponent: null, toolError: '', toolLoading: false,
        card: '', tab: 'all', query: { keyword: '', type: '', photo: '', status: '', page: 1, size: 20 }, photographers: [], drawer: false, detailLoading: false, detailError: '', detail: null, record: false, recordLoading: false, recordError: '', recordOrder: null,
        action: '', actionRow: null, actionBusy: false, actionError: '', actionUnknown: false, form: {}, wizardStep: 'confirm', confirmedInWizard: false, queueLoading: false, queueBusy: false, queueError: '', queueRows: [], queueTotal: 0, queuePage: 1,
        slot: { loading: false, error: '', items: [], photo: '', from: '', selectedDate: '', request: 0 }, contactLoading: false, contactError: '', contactMessage: '' });
      const host = ref(null); let alive = true, loadSeq = 0, detailSeq = 0, queueSeq = 0, recordSeq = 0, workspaceSeq = 0, contactSeq = 0;
      let loadController, detailController, slotController, refreshTimer, reserveTimer, reserveLoading = false, tools = null, legacyTemplate = '', toolPromise, sdkPromise;
      const unknownOrders = new Set();
      const abort = () => typeof AbortController === 'function' ? new AbortController() : null;
      const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const isAdmin = computed(() => ['super', 'admin', 'administrator'].includes(ctx.state.role));
      const isSupervisor = computed(() => ['supervisor', 'service_supervisor'].includes(ctx.state.role));
      const canOperate = computed(() => ['super', 'admin', 'administrator', 'service', 'supervisor', 'service_supervisor'].includes(ctx.state.role));
      const owns = row => typeof row?.can_operate === 'boolean' ? row.can_operate : isAdmin.value || !!ctx.state.currentStaffId && String(row?.assignee_id || row?.reserve_staff_id || '') === String(ctx.state.currentStaffId);
      const canAct = row => canOperate.value && owns(row) && ['claimed', 'confirmed', 'shooting'].includes(status(row));
      const peripheral = row => row?.category === 'peripheral';
      const money = value => value == null ? '—' : '¥' + (Number(value) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const statusLabel = row => status(row) === 'new' && row.payment_status === 'unpaid' ? '待支付' : status(row) === 'confirmed' && !row.photo_id ? '待派单' : STATUS[status(row)] || '—';
      const countdown = row => row.reserve_status === 'holding' || row.status === 'holding' || row.reserve_defer ? '--:--' : row.left_seconds == null ? '待更新' : String(Math.floor(Math.max(0, Number(row.left_seconds)) / 60)).padStart(2, '0') + ':' + String(Math.max(0, Number(row.left_seconds)) % 60).padStart(2, '0');
      async function api(path, method = 'GET', body, options = {}) {
        const response = await window.LXM_HTTP.request('/api/kf/' + path, { method, ...(options.signal ? { signal: options.signal } : {}), ...(body != null ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        let payload; try { payload = await response.json(); } catch (_) { throw new Error('服务返回异常，请重试'); }
        if (!response.ok || payload?.code !== 0) throw Object.assign(new Error(mask(payload?.msg || payload?.error || '服务暂不可用')), { code: payload?.code || response.status });
        return payload.data;
      }
      function query(extra = {}) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries({ ...s.query, card: s.card, tab: s.tab, ...extra })) if (value !== '' && value != null) params.set(key, value);
        return params.toString();
      }
      async function load(reset = false, background = false) {
        if (!alive || background && (s.loading || s.busy || s.actionBusy || hidden())) return;
        if (reset) s.query.page = 1;
        const seq = ++loadSeq; loadController?.abort(); loadController = abort();
        if (!background) s.loading = true; s.error = '';
        try {
          const data = await api('workbench/general?' + query(), 'GET', null, { signal: loadController?.signal });
          if (!alive || seq !== loadSeq) return;
          s.rows = rowsOf(data); s.total = Number(data.total || 0); s.cards = data.cards || {}; s.capabilities = data.capabilities || {};
          s.reserves = rowsOf(data.reserved); s.reserveTotal = Number(data.reserved?.total || 0); s.serverTime = data.server_time || ''; s.scope = data.data_scope || ''; s.cardsFailed = false; s.reserveError = '';
          if (s.query.page > 1 && !s.rows.length && s.total > 0) { s.query.page = Math.max(1, Math.ceil(s.total / s.query.size)); await load(); }
        } catch (error) { if (alive && seq === loadSeq && error.name !== 'AbortError') { s.error = mask(error.message); s.cardsFailed = true; } }
        finally { if (alive && seq === loadSeq) s.loading = false; }
      }
      async function refreshReserves() {
        if (!alive || reserveLoading || s.loading || s.busy || s.actionBusy || hidden()) return;
        reserveLoading = true;
        try { const result = await api('orders/reserved?size=100'); if (alive) { s.reserves = rowsOf(result); s.reserveTotal = Number(result.total || 0); s.reserveError = ''; } }
        catch (error) { if (alive) s.reserveError = '倒计时暂未更新：' + mask(error.message); }
        finally { reserveLoading = false; }
      }
      function filterCard(key) {
        if (key === 'reschedule' || key === 'complaints') return workspace(key);
        s.workspace = 'service'; s.card = s.card === key ? '' : key; s.tab = 'all'; s.query.status = ''; load(true);
      }
      function tab(value) { s.card = ['pool', 'mine'].includes(value) ? value : ''; s.tab = s.card ? 'all' : value; s.query.status = ''; load(true); }
      function statusChanged() { s.card = s.query.status === 'claimed' ? 'pending' : ''; s.tab = 'all'; load(true); }
      function reset() { Object.assign(s.query, { keyword: '', type: '', photo: '', status: '', page: 1 }); s.tab = 'all'; s.card = ''; load(true); }
      const cards = computed(() => [{ key: 'pool', label: '待认领', note: '可认领公共池' }, { key: 'mine', label: '我的跟进', note: '本人活跃订单' }, { key: 'pending', label: '待安排', note: '待确认时间' }, { key: 'reschedule', label: '改期审核', note: '待审核申请', jump: true }, { key: 'complaints', label: '售后处理', note: '未结售后工单', jump: true }, { key: 'today', label: '今日拍摄', note: '今日已确认 / 拍摄中' }].map(item => {
        const denied = item.key === 'reschedule' && s.capabilities.review_reschedule === false || item.key === 'complaints' && s.capabilities.handle_aftersales === false;
        return { ...item, value: s.cardsFailed ? '—' : denied ? '无权限' : s.cards[item.key] ?? '—', disabled: denied };
      }));
      const effectiveAction = computed(() => s.action === 'wizard' ? s.wizardStep : s.action);
      function actionReason(kind, row) {
        if (!row) return '订单暂不可用';
        if (kind === 'detail') return '';
        if (kind === 'claim') return canOperate.value && row.can_claim === true && status(row) === 'new' ? '' : '当前订单不可认领';
        if (kind === 'assign' && status(row) === 'confirmed' && row.photo_id) return '';
        if (!canAct(row)) return '当前账号或订单状态不允许此操作';
        if (peripheral(row)) return '此订单无需安排拍摄';
        if (kind === 'confirm') return status(row) === 'claimed' ? '' : '拍摄时间已确认';
        if (kind === 'assign') return ['claimed', 'confirmed'].includes(status(row)) ? '' : '当前状态不可登记派单';
        if (kind === 'transfer') return row.photo_id ? '' : '尚未派单，请先登记派单';
        return '';
      }
      function actions(row) {
        const st = status(row);
        const kinds = st === 'new' ? ['claim', 'detail'] : st === 'claimed' ? ['confirm', 'assign', 'reschedule', 'detail'] : st === 'confirmed' ? ['assign', 'reschedule', 'transfer', 'detail'] : ['detail'];
        return kinds.map(kind => ({ kind, label: { claim: '认领', confirm: '确认时间', assign: '登记派单', reschedule: '改期', transfer: '转派', detail: '详情' }[kind], reason: actionReason(kind, row), primary: ['claim', 'confirm'].includes(kind) }));
      }
      function detailActions(row) {
        const list = actions(row).filter(item => item.kind !== 'detail');
        if (status(row) === 'shooting' && !peripheral(row)) {
          list.push({ kind: 'reschedule', label: '改期', reason: actionReason('reschedule', row) });
          if (row.photo_id) list.push({ kind: 'transfer', label: '转派', reason: actionReason('transfer', row) });
        }
        return list;
      }
      async function photographers() {
        try { const result = await api('photographers'); if (alive) s.photographers = rowsOf(result).filter(item => !item.status || item.status === 'active'); }
        catch (error) { if (alive) s.error = mask(error.message); }
      }
      async function detail(row) {
        const number = no(row); if (!number) return;
        contactSeq++; s.contactLoading = false;
        const seq = ++detailSeq; detailController?.abort(); detailController = abort();
        s.drawer = true; s.detail = null; s.detailLoading = true; s.detailError = ''; s.contactError = ''; s.contactMessage = '';
        try { const result = await api('orders/' + encodeURIComponent(number), 'GET', null, { signal: detailController?.signal }); if (alive && seq === detailSeq) s.detail = result?.order ? { ...result.order, ...result } : result; }
        catch (error) { if (alive && seq === detailSeq && error.name !== 'AbortError') s.detailError = mask(error.message); }
        finally { if (alive && seq === detailSeq) s.detailLoading = false; }
      }
      function closeDetail() { s.drawer = false; s.detail = null; detailSeq++; contactSeq++; detailController?.abort(); s.detailLoading = false; s.contactLoading = false; }
      async function readOrder(number) { const result = await api('orders/' + encodeURIComponent(number)); return result?.order ? { ...result.order, ...result } : result; }
      async function record(row) {
        const seq = ++recordSeq; s.record = true; s.recordOrder = null; s.recordLoading = true; s.recordError = '';
        try { const result = await readOrder(no(row)); if (alive && seq === recordSeq) s.recordOrder = result; }
        catch (error) { if (alive && seq === recordSeq) s.recordError = mask(error.message); }
        finally { if (alive && seq === recordSeq) s.recordLoading = false; }
      }
      const recordEvents = computed(() => (s.recordOrder?.timeline || []).filter(event => ['assign', 'transfer'].includes(event.action || event.title)));
      function formFor(row, kind) { return { expected_status: status(row), order_no: no(row), new_time: kind === 'confirm' ? row.requested_time || '' : row.schedule_time || '', reason: '', channel: 'wechat', to_photo: '', preview_photo: row.photo_id || '' }; }
      async function open(kind, row) {
        if (!alive || s.actionBusy || s.busy) return;
        if (kind !== 'detail' && unknownOrders.has(no(row))) {
          s.busy = true;
          try { await readOrder(no(row)); unknownOrders.delete(no(row)); await load(); ctx.ElMessage.info('已核对上次提交的最新状态，请查看订单记录后重新选择操作'); }
          catch (error) { ctx.ElMessage.error('暂无法核对上次提交结果，已暂停重复提交：' + mask(error.message)); }
          finally { s.busy = false; }
          return;
        }
        const reason = actionReason(kind, row); if (reason) return ctx.ElMessage.warning(reason);
        if (kind === 'detail') return detail(row);
        if (kind === 'claim') return claim(row);
        if (kind === 'assign' && row.photo_id) return record(row);
        s.actionRow = row; s.actionError = ''; s.actionUnknown = false; s.confirmedInWizard = false; s.wizardStep = 'confirm';
        s.action = kind === 'assign' && status(row) === 'claimed' ? 'wizard' : kind;
        s.form = formFor(row, effectiveAction.value);
        s.slot.selectedDate = datePart(s.form.new_time) || datePart(s.serverTime); s.slot.items = []; s.slot.error = ''; s.slot.photo = '';
        if (!s.photographers.length) await photographers();
        if (!alive) return;
        loadOccupancy();
      }
      function closeAction() {
        if (s.actionBusy) return;
        if (s.confirmedInWizard) ctx.ElMessage.info('拍摄时间已保存，尚未完成派单；可稍后继续安排摄影师');
        s.action = ''; ++s.slot.request; slotController?.abort(); s.slot.loading = false;
      }
      const selectedPhoto = computed(() => ['assign', 'transfer'].includes(effectiveAction.value) ? s.form.to_photo : s.actionRow?.photo_id || s.form.preview_photo || '');
      const photoChoices = computed(() => s.photographers.filter(item => effectiveAction.value !== 'transfer' || String(item.id) !== String(s.actionRow?.photo_id)));
      const days = computed(() => {
        const start = s.slot.from || datePart(s.serverTime); if (!start) return [];
        const base = Date.parse(start + 'T12:00:00+08:00');
        return Array.from({ length: 14 }, (_, index) => { const value = datePart(new Date(base + index * 86400000)); const d = new Date(value + 'T12:00:00+08:00'); return { value, label: value.slice(5), day: index === 0 ? '今天' : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()] }; });
      });
      function count(date, bucket) { return s.slot.items.filter(item => no(item) !== no(s.actionRow) && datePart(item.appointment_at) === date && bucketOf(item.appointment_at)?.key === bucket).length; }
      const buckets = computed(() => BUCKETS.map(item => ({ ...item, count: count(s.slot.selectedDate, item.key) })));
      const finalTime = computed(() => ['assign', 'transfer'].includes(effectiveAction.value) ? s.actionRow?.schedule_time || '' : s.form.new_time || '');
      const finalBucket = computed(() => bucketOf(finalTime.value));
      const conflictCount = computed(() => !s.slot.error && !s.slot.loading && String(selectedPhoto.value) === String(s.slot.photo) && finalBucket.value ? count(datePart(finalTime.value), finalBucket.value.key) : 0);
      const inSlotWindow = computed(() => days.value.some(item => item.value === datePart(finalTime.value)));
      async function loadOccupancy() {
        if (!alive) return;
        const sequence = ++s.slot.request; slotController?.abort(); const currentController = abort(); slotController = currentController;
        s.slot.items = []; s.slot.error = ''; s.slot.loading = false; s.slot.photo = String(selectedPhoto.value || ''); s.slot.from = datePart(s.serverTime);
        if (!s.action || !selectedPhoto.value) return;
        s.slot.loading = true; let timer;
        try {
          const result = await Promise.race([api('photographers/' + encodeURIComponent(selectedPhoto.value) + '/occupancy?' + new URLSearchParams({ from: s.slot.from, days: 14 }), 'GET', null, { signal: currentController?.signal }), new Promise((_, reject) => { timer = setTimeout(() => { currentController?.abort(); reject(new Error('档期数据暂不可用')); }, 3000); })]);
          if (!alive || sequence !== s.slot.request) return;
          s.slot.items = Array.isArray(result.items) ? result.items : [];
        } catch (error) { if (alive && sequence === s.slot.request) s.slot.error = '档期数据暂不可用，仍可按原校验提交'; }
        finally { clearTimeout(timer); if (alive && sequence === s.slot.request) s.slot.loading = false; }
      }
      function chooseDate(value) { s.slot.selectedDate = value; }
      function chooseBucket(bucket) {
        if (!['confirm', 'reschedule'].includes(effectiveAction.value)) return;
        s.form.new_time = s.slot.selectedDate + ' ' + bucket.recommended;
      }
      function timeChanged() { const date = datePart(s.form.new_time); if (date && days.value.some(item => item.value === date)) s.slot.selectedDate = date; }
      function validation(kind) {
        if (!s.actionRow || !canAct(s.actionRow)) return '当前订单已无权操作，请刷新';
        if (['confirm', 'reschedule'].includes(kind) && !s.form.new_time) return '请选择拍摄时间';
        if (['assign', 'transfer', 'reschedule'].includes(kind) && !String(s.form.reason || '').trim()) return '请填写原因';
        if (kind === 'confirm' && s.actionRow.requested_time && s.form.new_time !== s.actionRow.requested_time && !String(s.form.reason || '').trim()) return '确认时间与客人提交值不同，请填写调整原因';
        if (['assign', 'transfer'].includes(kind) && !s.form.to_photo) return '请选择在职摄影师';
        return '';
      }
      function conflictContext() { return JSON.stringify([no(s.actionRow), effectiveAction.value, selectedPhoto.value, finalTime.value, s.slot.request, conflictCount.value]); }
      async function submit() {
        if (s.actionBusy || !s.action) return;
        if (s.actionUnknown) return ctx.ElMessage.warning('上次提交结果尚未核实，请先核对订单最新状态');
        const kind = effectiveAction.value, warning = validation(kind); if (warning) return ctx.ElMessage.warning(warning);
        s.actionBusy = true; s.actionError = ''; const number = no(s.actionRow);
        try {
          if (conflictCount.value > 0 && inSlotWindow.value) {
            const stamp = conflictContext();
            try { await ctx.ElMessageBox.confirm('该摄影师在当前可见范围内该时段已有 ' + conflictCount.value + ' 单，确认继续？', '档期冲突提示', { confirmButtonText: '继续提交', cancelButtonText: '返回调整', type: 'warning', customClass: 'gw-conflict-confirm' }); } catch (_) { return; }
            if (!alive || !s.action || stamp !== conflictContext()) { s.actionError = '时间或摄影师已变化，请重新确认后提交'; return; }
          }
          const endpoint = { confirm: 'slot/confirm', assign: 'assign', transfer: 'transfer', reschedule: 'slot/reschedule' }[kind];
          const body = { expected_status: status(s.actionRow), order_no: number, new_time: s.form.new_time, reason: String(s.form.reason || '').trim(), channel: s.form.channel, to_photo: s.form.to_photo };
          await api('orders/' + encodeURIComponent(number) + '/' + endpoint, 'POST', body);
          unknownOrders.delete(number);
          if (!alive) return;
          if (s.action === 'wizard' && kind === 'confirm') {
            const latest = await readOrder(number);
            if (!alive) return;
            if (status(latest) === 'confirmed' && !latest.photo_id && canAct(latest)) { s.actionRow = latest; s.wizardStep = 'assign'; s.confirmedInWizard = true; s.form = formFor(latest, 'assign'); s.slot.selectedDate = datePart(latest.schedule_time); await loadOccupancy(); ctx.ElMessage.success('拍摄时间已保存，请继续登记派单'); }
            else { s.action = ''; ctx.ElMessage.info('订单状态已更新，请查看最新详情'); }
          } else { s.action = ''; s.confirmedInWizard = false; ctx.ElMessage.success(kind === 'transfer' ? '已转派，客服归属及提成保持不变' : kind === 'reschedule' ? '已改期' : kind === 'assign' ? '摄影师已安排' : '拍摄时间已确认'); }
          await load(); if (s.drawer && no(s.detail) === number) await detail({ order_no: number });
        } catch (error) {
          if (!alive) return;
          s.actionError = mask(error.message) + '；请核对订单最新状态后重试';
          try {
            const latest = await readOrder(number); if (!alive) return;
            s.actionRow = latest; unknownOrders.delete(number);
            if (s.action === 'wizard' && status(latest) === 'confirmed' && !latest.photo_id && canAct(latest)) { s.wizardStep = 'assign'; s.confirmedInWizard = true; s.form = formFor(latest, 'assign'); s.actionError = '订单的拍摄时间已确认，已恢复到派单步骤。请核对后提交派单'; await loadOccupancy(); }
            else if (['confirm', 'reschedule'].includes(kind) && latest.schedule_time && String(latest.schedule_time).replace('T', ' ').slice(0, 19) === String(s.form.new_time).replace('T', ' ').slice(0, 19)) { s.action = ''; s.confirmedInWizard = false; ctx.ElMessage.info('已核实订单拍摄时间已保存，请查看最新服务记录'); }
            else if (['assign', 'transfer'].includes(kind) && latest.photo_id && (kind === 'assign' || String(latest.photo_id) === String(s.form.to_photo))) { s.action = ''; ctx.ElMessage.info('订单已有摄影师安排，请核对最新服务记录'); }
            else if (!canAct(latest)) s.action = '';
            await load();
          } catch (_) { unknownOrders.add(number); s.actionUnknown = true; s.actionError += '；暂无法核实结果，请先核对订单状态，勿重复提交'; }
        } finally { if (alive) s.actionBusy = false; }
      }
      async function checkAction() {
        if (!s.action || s.actionBusy) return;
        s.actionBusy = true;
        try {
          const latest = await readOrder(no(s.actionRow)); if (!alive) return;
          s.actionRow = latest; s.actionUnknown = false; unknownOrders.delete(no(latest));
          if (s.action === 'wizard' && status(latest) === 'confirmed' && !latest.photo_id && canAct(latest)) {
            s.wizardStep = 'assign'; s.confirmedInWizard = true; s.form = formFor(latest, 'assign');
            s.actionError = '已核实拍摄时间确认成功，已恢复派单步骤，请核对后继续'; await loadOccupancy();
          } else if (!canAct(latest) || ['assign', 'transfer'].includes(effectiveAction.value) && latest.photo_id && String(latest.photo_id) === String(s.form.to_photo)) {
            s.action = ''; s.confirmedInWizard = false; ctx.ElMessage.info('已核对订单最新结果，请查看最新服务记录');
          } else s.actionError = '订单状态已重新核对，请检查当前订单和表单后再提交';
          await load();
        } catch (error) { s.actionUnknown = true; s.actionError = '暂无法核实上次提交结果：' + mask(error.message) + '。已暂停再次提交'; }
        finally { if (alive) s.actionBusy = false; }
      }
      async function write(path, body, message) {
        if (!alive || s.busy) return; s.busy = true; s.error = '';
        try { await api(path, 'POST', body); if (alive) { ctx.ElMessage.success(message); await load(); if (s.drawer && s.detail) await detail(s.detail); } }
        catch (error) { if (alive) { s.error = mask(error.message); ctx.ElMessage.error(s.error); await load(); } }
        finally { if (alive) s.busy = false; }
      }
      async function claim(row) {
        if (isSupervisor.value) { await tool('claim', row); return; }
        return write('orders/' + encodeURIComponent(no(row)) + '/claim', { expected_status: 'new' }, '已认领，请确认拍摄时间');
      }
      async function reserve(row, kind) {
        if (!canOperate.value || !owns(row) || status(row) !== 'reserved') return;
        if (kind === 'giveup') { try { await ctx.ElMessageBox.confirm('放弃后该单立即回到公共池。若该客户已无其他预占单，保护绑定一并解除。', '放弃预占', { type: 'warning' }); } catch (_) { return; } }
        return write('orders/' + encodeURIComponent(no(row)) + '/reserve/' + kind, { expected_status: 'reserved' }, kind === 'take' ? '已接单，保护绑定已续期' : '已放弃预占，该单已回流');
      }
      async function receipt(row) {
        if (!peripheral(row) || !canAct(row)) return;
        try { await ctx.ElMessageBox.confirm('请确认客户已经收到实物商品。登记后该订单完成，提成观察期从本次登记时间开始；无需摄影师或拍摄登记。', '确认客户收货', { confirmButtonText: '客户已收货，登记完成', cancelButtonText: '取消', type: 'warning' }); } catch (_) { return; }
        await write('orders/' + encodeURIComponent(no(row)) + '/receipt/confirm', { received: true, expected_status: status(row) }, '已登记收货完成');
      }
      async function aftersale(row) {
        if (typeof ctx.openServiceAfterSale !== 'function') return ctx.ElMessage.error('售后操作暂不可用');
        await ctx.openServiceAfterSale(no(row), { onExisting: (order, ticket) => {
          if (typeof ctx.openAfterSaleProcess === 'function') return ctx.openAfterSaleProcess(ticket);
          throw new Error('售后处理组件暂不可用，请重试');
        } });
      }
      function childContext(active, toolsOnly = false) {
        const child = Object.create(ctx);
        child.state = new Proxy(ctx.state, { get(target, key) { return key === 'active' ? active : Reflect.get(target, key); }, set(target, key, value) { if (key === 'active') return true; return Reflect.set(target, key, value); } });
        child.kfIsolation = reactive({ ...isolation, suppressAutoLoad: toolsOnly, disablePolling: true, filters: null, aftersale: null, reviewReschedule: (id, body) => api('workbench/general/reschedule-review', 'POST', { order_id: id, ...body }), onAction: async () => { if (!alive) return; await load(); if (['reschedule', 'complaints'].includes(s.workspace)) await loadQueue(); } });
        child.switchMenu = key => workspace({ svcWorkbench: 'physical', svcComplaints: 'records', afterSales: 'complaints', productLinks: 'products', svcIntake: 'service', svcFollowup: 'service' }[key] || 'service');
        return child;
      }
      async function templateOf(key) {
        const meta = window.LXM_PAGES.pageFor(key);
        const response = await fetch('./src/views/' + meta.folder + '/' + meta.slug + '.html');
        if (!response.ok) throw new Error('操作工作区加载失败，请重试');
        return response.text();
      }
      async function ensureTools() {
        if (tools) return tools;
        if (toolPromise) return toolPromise;
        s.toolLoading = true; s.toolError = '';
        toolPromise = (async () => {
          legacyTemplate = legacyTemplate || await templateOf('svcWorkbench');
          if (!alive) return;
          s.toolComponent = markRaw({ name: 'GeneralWorkbenchTools', template: displayTemplate(dialogFragment(legacyTemplate)).replace('class="kf-dialog"', 'class="kf-dialog gw-modal gw-tools-modal"'), setup() {
            const toolCtx = childContext('svcGeneralWorkbench:tools', true); provide('lxm', toolCtx);
            const result = window.LXM_SVC_WORKBENCH_SETUP(toolCtx, 'workbench'); tools = result;
            return { ...toolCtx, ...result, kf: displayView(result.kf), gwMask: mask };
          } });
          await nextTick(); return tools;
        })().catch(error => { s.toolError = mask(error.message); toolPromise = null; throw error; }).finally(() => { s.toolLoading = false; });
        return toolPromise;
      }
      async function tool(kind, row) {
        try { const instance = await ensureTools(); if (instance) { await instance.kfOpen(kind, row); } }
        catch (error) { ctx.ElMessage.error(mask(error.message)); }
      }
      async function loadQueue() {
        if (!alive || !['reschedule', 'complaints'].includes(s.workspace)) return;
        const seq = ++queueSeq; s.queueLoading = true; s.queueError = '';
        try { const result = await api('workbench/general/queues?' + new URLSearchParams({ queue: s.workspace, page: s.queuePage, size: 20 })); if (alive && seq === queueSeq) { s.queueRows = rowsOf(result); s.queueTotal = Number(result.total || 0); } }
        catch (error) { if (alive && seq === queueSeq) { s.queueError = mask(error.message); s.queueRows = []; } }
        finally { if (alive && seq === queueSeq) s.queueLoading = false; }
      }
      async function review(row, approved) {
        if (s.queueBusy) return;
        s.queueBusy = true;
        try { const instance = await ensureTools(); if (!instance) return; await instance.kfReviewReschedule(row, approved); await Promise.all([loadQueue(), load()]); }
        catch (error) { s.queueError = mask(error.message); }
        finally { s.queueBusy = false; }
      }
      async function embed(key) {
        const seq = ++workspaceSeq; s.workspaceLoading = true; s.workspaceError = ''; s.embedded = null;
        try {
          if (key === 'physical') {
            legacyTemplate = legacyTemplate || await templateOf('svcWorkbench');
            const component = { name: 'GeneralPhysicalWorkspace', template: physicalFragment(legacyTemplate), setup() {
              const child = childContext('svcGeneralWorkbench:physical'); provide('lxm', child); const result = window.LXM_PHYSICAL_WORKBENCH_SETUP(child);
              onMounted(() => result.physicalType('physical'));
              return { ...child, ...result, kfAdmin: isAdmin };
            } };
            if (alive && seq === workspaceSeq) s.embedded = markRaw(component);
          } else {
            const pageKey = key === 'products' ? 'productLinks' : 'svcComplaints';
            await window.LXM_PAGES.loadPage(pageKey);
            const meta = window.LXM_PAGES.pageFor(pageKey), template = await templateOf(pageKey);
            if (!alive || seq !== workspaceSeq) return;
            s.embedded = markRaw({ name: 'GeneralEmbedded' + pageKey, template: '<section class="page-route page-route-' + meta.slug + '">' + displayTemplate(template) + '</section>', setup() {
              const child = childContext(pageKey); provide('lxm', child); const result = meta.setup(child, meta);
              return { ...child, ...result, ...(result.kf ? { kf: displayView(result.kf) } : {}), gwMask: mask };
            } });
          }
        } catch (error) { if (alive && seq === workspaceSeq) s.workspaceError = mask(error.message); }
        finally { if (alive && seq === workspaceSeq) s.workspaceLoading = false; }
      }
      async function workspace(key) {
        s.workspace = key; s.workspaceError = ''; ++workspaceSeq; ++queueSeq;
        s.queueRows = []; s.queueTotal = 0;
        if (['reschedule', 'complaints'].includes(key)) { s.queuePage = 1; await loadQueue(); }
        else if (['physical', 'products', 'records'].includes(key)) await embed(key);
        else { s.embedded = null; await load(); }
      }
      async function sdk() {
        if (window.ww?.openEnterpriseChat) return window.ww;
        if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = 'https://wwcdn.weixin.qq.com/node/wework/wwopen/js/wecom-jssdk-2.4.0.js'; script.async = true;
          const timer = setTimeout(() => { script.remove(); sdkPromise = null; reject(new Error('企业微信SDK加载超时，请重试')); }, 8000);
          script.onload = () => { clearTimeout(timer); window.ww ? resolve(window.ww) : reject(new Error('企业微信SDK不可用')); };
          script.onerror = () => { clearTimeout(timer); script.remove(); sdkPromise = null; reject(new Error('企业微信SDK加载失败')); };
          document.head.appendChild(script);
        });
        return sdkPromise;
      }
      async function contact(row) {
        if (!alive || s.contactLoading) return;
        const sequence = ++contactSeq, detailAtStart = detailSeq;
        const current = () => alive && sequence === contactSeq && detailAtStart === detailSeq;
        s.contactLoading = true; s.contactError = ''; s.contactMessage = '';
        try {
          const result = await api('orders/' + encodeURIComponent(no(row)) + '/contact', 'POST', { pageUrl: location.href.split('#')[0] });
          if (!current()) return;
          if (result.kind === 'wecom_jsapi') {
            if (!/wxwork/i.test(navigator.userAgent || '')) throw new Error('请在企业微信客户端中打开总工作台后联系客人');
            const ww = await sdk();
            if (!current()) return;
            ww.register({ corpId: result.corp_id, agentId: result.agent_id, jsApiList: ['openEnterpriseChat'], getConfigSignature: async () => result.config_signature, getAgentConfigSignature: async () => result.agent_signature });
            await ww.openEnterpriseChat(result.params || {});
            if (!current()) return;
            s.contactMessage = '已打开企业微信会话，请在客户端查看；此结果不代表客人已收到消息';
          } else throw new Error(result.message || '联系通路未正确配置，请联系管理员');
        } catch (error) { if (current()) s.contactError = mask(error.message); }
        finally { if (current()) s.contactLoading = false; }
      }
      function onVisibility() { if (!hidden()) { load(false, true); refreshReserves(); if (['reschedule', 'complaints'].includes(s.workspace)) loadQueue(); } }
      onMounted(async () => { await Promise.allSettled([load(), photographers(), ensureTools()]); if (!alive) return; refreshTimer = setInterval(() => load(false, true), 30000); reserveTimer = setInterval(refreshReserves, 1000); document.addEventListener('visibilitychange', onVisibility); });
      onUnmounted(() => { alive = false; loadSeq++; detailSeq++; queueSeq++; workspaceSeq++; recordSeq++; contactSeq++; s.slot.request++; loadController?.abort(); detailController?.abort(); slotController?.abort(); clearInterval(refreshTimer); clearInterval(reserveTimer); document.removeEventListener('visibilitychange', onVisibility); });
      return { gw: s, gwToolHost: host, gwCards: cards, gwCategories: CATEGORY, gwStatusNames: STATUS, gwBuckets: buckets, gwDays: days, gwSelectedPhoto: selectedPhoto, gwPhotoChoices: photoChoices, gwEffectiveAction: effectiveAction, gwConflictCount: conflictCount, gwFinalTime: finalTime, gwFinalBucket: finalBucket, gwInSlotWindow: inSlotWindow, gwRecordEvents: recordEvents,
        gwAdmin: isAdmin, gwCanOperate: canOperate, gwMask: mask, gwPhone: phone, gwNo: no, gwStatus: status, gwStatusLabel: statusLabel, gwMoney: money, gwTime: timeText, gwCountdown: countdown, gwOwns: owns, gwCanAct: canAct, gwPeripheral: peripheral,
        gwActions: actions, gwDetailActions: detailActions, gwActionReason: actionReason, gwLoad: load, gwFilterCard: filterCard, gwTab: tab, gwStatusChanged: statusChanged, gwReset: reset, gwWorkspace: workspace, gwDetail: detail, gwCloseDetail: closeDetail, gwRecord: record, gwOpen: open, gwCloseAction: closeAction, gwSubmit: submit, gwCheckAction: checkAction, gwLoadOccupancy: loadOccupancy, gwChooseDate: chooseDate, gwChooseBucket: chooseBucket, gwTimeChanged: timeChanged, gwReserve: reserve, gwReceipt: receipt, gwAftersale: aftersale, gwTool: tool, gwReview: review, gwLoadQueue: loadQueue, gwContact: contact };
    }
  });
})();
