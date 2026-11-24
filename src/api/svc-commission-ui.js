/* Customer service commission pages share the server ledger; amounts are never calculated here. */
(function () {
  const categories = { photo: '照片', video: '视频', combo: '套餐', peripheral: '周边' };
  const settlementCycles=['月结','半月结','周结','隔天结'];
  const timingFields = [['link_valid_days', '链接有效期', 1, 30], ['observe_days', '结算等待期', 0, 30]];
  const statuses = { est: '预估', obs: '观察中', settleable: '可结算', settled: '已结算', void: '不计提成', draft: '草稿', confirmed: '已确认', paid: '已发放', pending: '待一审', l1: '一审中', l2: '终审中', accepted: '申诉成功', rejected: '维持原判', active: '在职', paused: '暂停', ended: '终止' };
  window.LXM_SVC_COMMISSION_SETUP = function (ctx, mode) {
    const { reactive, computed, onMounted, watch, onUnmounted } = Vue;
    const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
    const s = reactive({ loading: false, busy: false, wecomSyncingId: '', error: '', rows: [], total: 0, summary: {}, query: { staff: '', type: '', status: '', keyword: '', period: month, page: 1, size: 20 }, selected: [], rules: {}, rates: { photo_bp: 0, video_bp: 0, combo_bp: 0, peripheral_bp: 0 }, initialRates: '', reason: '', preview: null, config: {}, ver: 0, configVer: 0, staff: [], staffOptions: [], appeals: [], mineStaff: null, mineSettlements: [], mineAdjustments: [], adjustmentsOpen: false, adjustmentPeriod: '', drawer: false, detailLoading: false, settlementItems: [], current: null, dialog: '', form: {}, custom: false });
    const staffRateForm = reactive({ rates: { photo_bp:0,video_bp:0,combo_bp:0,peripheral_bp:0 }, reason:'', rate_mode:'custom' });
    let alive = true, requestId = 0, previewTimer, filterTimer;
    let timingDefaults = {}, timingEdited = {};
    const defaultTiming = () => Object.fromEntries(timingFields.map(([key]) => [key, Number(s.config[key] ?? 7)]));
    function timingChanged(key) { if (timingFields.some(([field]) => field === key)) timingEdited[key] = true; }
    function syncTimingDefaults() {
      if (s.dialog !== 'staff') return;
      const values = defaultTiming();
      for (const [key] of timingFields) if (!timingEdited[key] && s.form[key] === timingDefaults[key]) s.form[key] = values[key];
      timingDefaults = values;
    }
    const money = value => value == null ? '—' : '¥' + (Number(value) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const time = value => value ? String(value).replace('T', ' ').replace(/Z$/, '').slice(0, 19) : '—';
    const canManage = computed(() => ['super', 'admin'].includes(ctx.state.role));
    const minePreview = computed(() => mode === 'mine' && ctx.state.role === 'super');
    const canFinance = computed(() => ['super', 'admin', 'finance'].includes(ctx.state.role));
    const canDelegate = computed(() => ['supervisor', 'service_supervisor'].includes(ctx.state.role));
    const canEditProfile = row => row?.can_edit_profile === true || row?.can_edit_profile == null && canManage.value;
    const canReview = computed(() => ['super', 'admin', 'supervisor', 'service_supervisor', 'serviceManager'].includes(ctx.state.role));
    const title = { rules: '分成配置', ledger: '分成明细', settlements: '结算管理', staff: '客服列表', new: '新增客服', mine: '我的分成' }[mode];
    const listOf = data => Array.isArray(data) ? data : data?.list || data?.rows || data?.staff || data?.settlements || data?.ledger || [];
    async function api(path, method = 'GET', body) {
      const response = await window.LXM_HTTP.request('/api/svc/' + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const payload = await response.json();
      if (!response.ok || payload.code !== 0) throw Object.assign(new Error(payload.msg || payload.error || '服务暂不可用'), { code: payload.code });
      return payload.data;
    }
    function query() { const q = new URLSearchParams(); for (const [k, v] of Object.entries(s.query)) if (v !== '' && v != null && !(mode === 'mine' && !minePreview.value && k === 'staff')) q.set(k, v); return q.toString(); }
    async function load(reset = false) {
      if (reset) s.query.page = 1;
      const seq = ++requestId; s.loading = true; s.error = ''; s.selected = [];
      try {
        const endpoint = { rules: 'rule', ledger: 'ledger', settlements: 'settlement', staff: 'staff', new: 'rule', mine: 'me' }[mode];
        const data = await api(endpoint + '?' + query()); if (!alive || seq !== requestId) return;
        if (mode === 'rules' || mode === 'new') {
          s.rules = data || {}; const rule = data.current || data.active || data.rule || {};
          const latest = data.latest || data.pending || data.versions?.find(row => row.party_id == null) || rule;
          for (const k of Object.keys(s.rates)) s.rates[k] = Number(latest['rate_' + k] ?? latest[k] ?? 0);
          s.ver = Number(data.ver ?? data.version ?? latest.ver ?? 0); s.initialRates = JSON.stringify(s.rates);
          s.config = { ...(mode === 'new' ? data.config || data.rebuy_config || {} : data.pending_config || data.config || data.rebuy_config || {}) }; s.configVer = Number(data.latest_config_ver ?? s.config.ver ?? 0);
          if (mode === 'new') syncTimingDefaults();
          if (mode === 'new' && !s.form.name) { for (const key of Object.keys(categories)) s.form.rates[key + '_bp'] = s.rates[key + '_bp']; }
        } else { s.rows = listOf(data); s.total = Number(data?.total ?? s.rows.length); s.summary = { ...(data?.kpi || data?.summary || data?.stats || {}), ...(data?.status_totals || {}), ...(data?.total_commission_fen != null ? { total_commission_fen: data.total_commission_fen } : {}) }; if(data?.config){s.config={...data.config};syncTimingDefaults();} }
        if (mode === 'staff' && s.current?.id) { const current = s.rows.find(row => String(row.id) === String(s.current.id)); if (current) s.current = { ...s.current, ...current }; }
        if (mode === 'mine') { s.mineStaff = data.staff ? {...data.staff,...(data.current_rates?{rates:data.current_rates}:{})} : null; s.mineSettlements = data.settlements || []; s.appeals = data.appeals || []; s.staffOptions = minePreview.value ? data.staff_options || [] : []; s.mineAdjustments = data.adjustments || []; s.adjustmentPeriod = data.adjustment_period || ''; }
        if (mode === 'ledger') s.staffOptions = data.staff_options || [...new Map(s.rows.map(row => [row.party_id, { id:row.party_id, name:row.staff_name || row.party_id }])).values()];
        if (mode === 'new') await loadStaffOptions();
        if (mode === 'settlements') { try { const a = await api('appeal'); if (alive && seq === requestId) s.appeals = listOf(a); } catch (e) { if (alive && seq === requestId) s.error = '申诉列表：' + e.message; } }
      } catch (e) { if (alive && seq === requestId) s.error = e.message; }
      finally { if (alive && seq === requestId) s.loading = false; }
    }
    async function loadStaffOptions() {
      if (!canManage.value && !canFinance.value && !canDelegate.value) return;
      const data = await api('staff?size=100&page=1'); if (alive) s.staffOptions = listOf(data);
    }
    function filterChanged() { clearTimeout(filterTimer); filterTimer = setTimeout(() => load(true), 300); }
    async function act(path, body, message = '操作成功', reset = false) {
      if (s.busy) return; s.busy = true; s.error = '';
      try { const data = await api(path, 'POST', body || {}); if (typeof message === 'function') message(data); else ctx.ElMessage.success(message); s.dialog = ''; await load(reset); return data; }
      catch (e) { s.error = e.message; ctx.ElMessage.error(e.message); }
      finally { s.busy = false; }
    }
    function wecomStatus(row) { return ({ disabled: '未启用', pending: '待同步', syncing: '同步中', synced: '已同步', failed: '同步失败' })[row?.wecom_sync_status] || '未同步'; }
    function wecomTagType(row) { return row?.wecom_sync_status === 'synced' ? 'success' : row?.wecom_sync_status === 'failed' ? 'danger' : 'warning'; }
    function canRetryWecom(row) { return !!row && canManage.value && row.staff_status !== 'ended' && (row.wecom_sync_status == null || ['disabled', 'pending', 'syncing', 'failed'].includes(row.wecom_sync_status)); }
    function notifyWecom(row, savedMessage) {
      const status = row?.wecom_sync_status;
      if (status === 'synced') return ctx.ElMessage.success(savedMessage + '；' + (row.wecom_sync_message || '企微客服部门已同步，邀请已提交，成员需确认加入。'));
      if (['disabled', 'pending', 'syncing', 'failed'].includes(status)) return ctx.ElMessage.warning(savedMessage + '；' + (row.wecom_sync_message || '企微' + wecomStatus(row)) + '。可在客服列表重试企微同步，无需重复新增。');
      ctx.ElMessage.success(savedMessage);
    }
    async function retryWecom(row) {
      if (s.busy || !canRetryWecom(row)) return;
      const id = String(row.staff_id || row.id); s.busy = true; s.wecomSyncingId = id; s.error = '';
      try {
        const data = await api('staff/' + encodeURIComponent(id) + '/wecom-sync', 'POST', {});
        if (alive) {
          Object.assign(row, data);
          if (String(s.current?.staff_id || s.current?.id) === id) s.current = { ...s.current, ...data };
          notifyWecom(data, '客服档案已保存');
          await load();
        }
        return data;
      } catch (e) { s.error = e.message; ctx.ElMessage.error(e.message); }
      finally { s.wecomSyncingId = ''; s.busy = false; }
    }
    function staffRate(row, key) { const rates = row?.configured_rates || row?.rates || row; return Number(rates?.['rate_' + key + '_bp'] ?? rates?.[key + '_bp'] ?? 0); }
    function staffRateMode(row) { return row?.configured_rates?.rule_mode || row?.rates?.rule_mode || row?.rate_mode || 'global'; }
    function mergeRateVersion(row) { s.rules.versions = [row, ...(s.rules.versions || []).filter(version => Number(version.ver) !== Number(row.ver))].sort((a, b) => Number(b.ver) - Number(a.ver)); }
    function shortOpenid(value) { return value ? (String(value).length > 12 ? String(value).slice(0, 5) + '…' + String(value).slice(-4) : String(value)) : '—'; }
    function clearPassword() { if (s.form) s.form.password = ''; }
    function closeDialog() { if (s.busy) return; clearPassword(); s.dialog = ''; }
    function accountModeChanged() { clearPassword(); s.form.account_id = ''; }
    async function open(kind, row) {
      if (s.busy || kind === 'staff' && !canManage.value) return;
      clearPassword();
      s.dialog = kind; s.current = row || null; s.error = ''; s.settlementItems = [];
      if (kind === 'staff') { timingDefaults = defaultTiming(); timingEdited = {}; }
      s.form = kind === 'staff' ? { name: '', phone: '', create_account: true, account: '', password: '', account_id: '', supervisor_id: '', joined_at: '', base_salary: 0, rate_mode: 'global',settlement_cycle:'月结', ...timingDefaults, assessment_tags: [], rate_review_date: null, reason: '', rates: { ...s.rates } } : kind === 'profile' ? { assessment_tags: [...(row?.assessment_tags || [])], rate_review_date: row?.rate_review_date || null, reason: '' } : kind === 'rate' ? { rates: Object.fromEntries(Object.keys(categories).map(key => [key + '_bp', staffRate(row, key)])), reason: '', rate_mode: staffRateMode(row) } : { reason: '', voucher_url: '', evidence_url: '', ledger_id: '', settle_id: row?.settle_id || '', note: '', status: 'accepted', amount_fen: 0 };
      if (kind === 'staff' && mode === 'staff') {
        const form = s.form, initialRates = JSON.stringify(form.rates);
        const results = await Promise.allSettled([api('rule'), api('staff?size=100&page=1')]);
        if (!alive || s.dialog !== 'staff' || s.form !== form) return;
        const [ruleResult, staffResult] = results;
        if (ruleResult.status === 'fulfilled') {
          const data = ruleResult.value || {}, rule = data.latest || data.pending || data.versions?.find(row => row.party_id == null) || data.current || data.active || data.rule || {};
          s.rules = data;
          for (const key of Object.keys(s.rates)) s.rates[key] = Number(rule['rate_' + key] ?? rule[key] ?? 0);
          if (JSON.stringify(form.rates) === initialRates) form.rates = { ...s.rates };
          if (data.config) { s.config = { ...data.config }; syncTimingDefaults(); }
        }
        if (staffResult.status === 'fulfilled') s.staffOptions = listOf(staffResult.value);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) s.error = '新增客服配置加载失败：' + failure.reason.message;
      }
      if (kind === 'rate' && canManage.value) {
        try { const data = await api('rule'); if (alive) s.rules = data; const id = String(row.staff_id || row.id), latest = (data.versions || []).filter(item => String(item.party_id || '') === id).sort((a,b) => Number(b.ver) - Number(a.ver))[0]; if (alive && s.dialog === kind && s.current === row && !row.configured_rates && latest) { s.form.rates = Object.fromEntries(Object.keys(categories).map(key => [key + '_bp', staffRate(latest,key)])); s.form.rate_mode = latest.rule_mode || row.rate_mode; } }
        catch (e) { s.error = e.message; }
      }
      if (kind === 'exclude') {
        try { const data = await api('settlement/' + encodeURIComponent(row.settle_id)); if (alive && s.dialog === kind && s.current === row) s.settlementItems = listOf(data); }
        catch (e) { s.error = e.message; }
      }
    }
    async function viewSettlement(row) {
      s.current = { ...row, detail_kind: 'settlement', list: [], adjustments: [] }; s.drawer = true; s.detailLoading = true;
      try { const data = await api('settlement/' + encodeURIComponent(row.settle_id)); if (alive && s.current?.settle_id === row.settle_id) s.current = { ...data, detail_kind: 'settlement' }; }
      catch (e) { s.error = e.message; } finally { s.detailLoading = false; }
    }
    async function viewStaff(row) {
      s.current = { ...row, detail_kind: 'staff' }; s.drawer = true; s.detailLoading = true;
      staffRateForm.reason = ''; staffRateForm.rate_mode = staffRateMode(row);
      staffRateForm.rates = Object.fromEntries(Object.keys(categories).map(key => [key + '_bp', staffRate(row,key)]));
      try { const data = await api('rule'); if (alive && s.current?.detail_kind === 'staff' && String(s.current.id) === String(row.id)) { s.rules = data; const latest=(data.versions || []).filter(item=>String(item.party_id || '')===String(row.id)).sort((a,b)=>Number(b.ver)-Number(a.ver))[0]; if(!row.configured_rates && latest){staffRateForm.rates=Object.fromEntries(Object.keys(categories).map(key=>[key+'_bp',staffRate(latest,key)])); staffRateForm.rate_mode=latest.rule_mode || row.rate_mode;} } } catch (e) { if (canManage.value) s.error = e.message; }
      finally { s.detailLoading = false; }
    }
    async function saveDrawerRate(mode) {
      if (!canManage.value || !s.current || s.busy) return;
      if (!staffRateForm.reason.trim()) return ctx.ElMessage.warning('请填写变更原因');
      const data = await act('staff/' + encodeURIComponent(s.current.id) + '/rate', { rates:{...staffRateForm.rates},rate_mode:mode || 'custom',reason:staffRateForm.reason },'比例已保存，次日生效');
      if (data) { mergeRateVersion(data); staffRateForm.reason=''; staffRateForm.rate_mode=staffRateMode(s.current); staffRateForm.rates=Object.fromEntries(Object.keys(categories).map(key=>[key+'_bp',staffRate(s.current,key)])); }
    }
    function viewLedger(row) { s.current = { ...row, detail_kind: 'ledger' }; s.drawer = true; }
    function toggleRow(row, checked) { s.selected = s.selected.filter(item => String(item.id) !== String(row.id)); if (checked && row.status === 'settleable' && !row.settle_id) s.selected.push(row); }
    function toggleAll(checked) { s.selected = checked ? s.rows.filter(row => row.status === 'settleable' && !row.settle_id) : []; }
    function resetNew() { open('staff'); }
    async function saveRule() { if (!s.reason.trim()) return ctx.ElMessage.warning('请填写变更原因'); await act('rule', { rates: { ...s.rates }, ver: s.ver, reason: s.reason }, '已保存新版本，次日 00:00 生效'); }
    async function saveConfig() { await act('rule', { config: { ...s.config, holiday_dates: s.config.holiday_dates || [], workday_dates: s.config.workday_dates || [] }, ver: s.ver, config_ver: s.configVer, reason: s.reason || '调整复购与工作日历参数' }, '复购参数已保存，次日生效'); }
    async function preview() { try { s.preview = await api('rule/preview', 'POST', { rates: { ...s.rates }, period: s.query.period }); } catch (e) { s.preview = null; s.error = e.message; } }
    watch(() => JSON.stringify(s.rates), () => { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 350); });
    async function submitDialog() {
      if (s.busy) return;
      const id = s.current?.staff_id || s.current?.id;
      if (s.dialog === 'staff') {
        for (const [key, label, min, max] of timingFields) {
          const value = s.form[key];
          if (!Number.isInteger(value) || value < min || value > max) return ctx.ElMessage.warning(label + '须为' + min + '–' + max + '天的整数');
        }
        const account = String(s.form.account || '').trim(), createAccount = s.form.create_account !== false;
        const password = String(s.form.password || '');
        if (!account || account.length > 128 || /[\u0000-\u001f\u007f]/.test(account)) return ctx.ElMessage.warning('请填写128个字符以内的后台登录账号');
        if (createAccount && (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password))) return ctx.ElMessage.warning('初始密码须为8–128位且包含字母和数字');
        const body = { ...s.form, account, create_account: createAccount };
        delete body.account_id;
        if (!createAccount) delete body.password;
        const data = await act('staff', body, row => notifyWecom(row, createAccount ? '客服档案和登录账号已创建' : '客服档案已创建并关联登录账号'), true);
        if (data) { clearPassword(); if (mode === 'new') ctx.state.active = 'svcStaff'; }
        return data;
      }
      if (s.dialog === 'profile') {
        if (!String(s.form.reason || '').trim()) return ctx.ElMessage.warning('请填写修改原因');
        return act('staff/' + encodeURIComponent(id) + '/profile', { assessment_tags: [...s.form.assessment_tags], rate_review_date: s.form.rate_review_date || null, reason: s.form.reason }, '手工标签与复核日期已保存');
      }
      if (s.dialog === 'rate') { const data = await act('staff/' + encodeURIComponent(id) + '/rate', s.form, '比例已保存，次日生效'); if (data) mergeRateVersion(data); return data; }
      if (s.dialog === 'pay') return act('settlement/' + encodeURIComponent(s.current.settle_id) + '/pay', { voucher_url: s.form.voucher_url }, '已登记线下发放');
      if (s.dialog === 'appeal') return act('appeal', { ...s.form, ledger_id: s.current.id, settle_id: s.current.settle_id }, '申诉已提交');
      if (s.dialog === 'review') return act('appeal/' + encodeURIComponent(s.current.id) + '/' + (s.current.status === 'l2' ? 'l2' : 'l1'), { result: s.current.status === 'l2' ? s.form.status : s.form.status === 'accepted' ? 'revise' : 'maintain', note: s.form.note, amount_fen: s.form.amount_fen }, '审核结果已记录');
      if (s.dialog === 'exclude') return act('settlement/' + encodeURIComponent(s.current.settle_id) + '/exclude', { ledger_id: s.form.ledger_id, reason: s.form.reason }, '已从草稿剔除');
    }
    async function confirmSettlement(row) { try { await ctx.ElMessageBox.confirm('确认后金额及明细将锁定，差异进入下期调账。', '确认结算单', { type: 'warning' }); await act('settlement/' + encodeURIComponent(row.settle_id) + '/confirm'); } catch (_) {} }
    async function staffStatus(row, status) { try { await ctx.ElMessageBox.confirm(status === 'ended' ? '终止后保留档案及未结明细，是否继续？' : '确认变更客服状态？', '客服状态'); await act('staff/' + encodeURIComponent(row.staff_id || row.id) + '/status', { status }); } catch (_) {} }
    async function exportCsv() {
      s.busy = true;
      try { const q=new URLSearchParams(query()); if(mode==='mine'&&!minePreview.value){if(!s.mineStaff?.id)throw new Error('当前登录账号尚未关联客服档案');q.set('staff',s.mineStaff.id);}const response = await window.LXM_HTTP.request('/api/svc/ledger/export?' + q); if (!response.ok || !(response.headers.get('content-type') || '').includes('text/csv')) { const p = await response.json(); throw new Error(p.msg || p.error || '导出失败'); } const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = '客服分成明细.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      catch (e) { s.error = e.message; } finally { s.busy = false; }
    }
    async function copy(value) { if (!value) return; try { await navigator.clipboard.writeText(value); ctx.ElMessage.success('已复制完整 OpenID'); } catch (_) { ctx.ElMessage.warning('请在详情中手动复制完整 OpenID'); } }
    const selectedTotal = computed(() => s.selected.reduce((total, row) => total + Number(row.commission_fen || 0), 0));
    const changed = computed(() => JSON.stringify(s.rates) !== s.initialRates);
    const versions = computed(() => (s.rules.versions || s.rules.history || []).filter(row => row.party_id == null));
    const customStaff = computed(() => s.rules.custom_staff || s.rules.custom || []);
    const currentRule = computed(() => s.rules.current || s.rules.active || s.rules.rule || {});
    const rateSummary = (row, separator = ' / ') => Object.entries(categories).map(([key,label]) => label + ' ' + (staffRate(row,key) / 100).toFixed(1) + '%').join(separator);
    const ledgerKpis = computed(() => ({ amount: s.summary.total_commission_fen ?? s.summary.amount_fen, rows: s.total, voidCount: s.summary.void_count ?? (s.total <= s.rows.length ? s.rows.filter(row => row.status === 'void').length : null), orders: s.summary.order_count ?? (s.total <= s.rows.length ? new Set(s.rows.map(row => row.biz_no || row.order_no)).size : null) }));
    const staffKpis = computed(() => ({ active: s.summary.active_count ?? (s.total <= s.rows.length ? s.rows.filter(row=>row.staff_status === 'active').length : null), paused: s.summary.paused_count ?? (s.total <= s.rows.length ? s.rows.filter(row=>row.staff_status === 'paused').length : null), ended: s.summary.ended_count ?? (s.total <= s.rows.length ? s.rows.filter(row=>row.staff_status === 'ended').length : null), month: s.summary.month_fen }));
    const count = value => value == null ? '—' : Number(value).toLocaleString('zh-CN');
    const yuan = value => value == null ? '—' : (Number(value) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const salary = value => value == null ? '—' : '¥' + String(Number(value) / 100) + '/月';
    const baseSalary=computed(()=>s.summary.base_salary_fen != null?Number(s.summary.base_salary_fen):s.mineStaff?.base_salary_fen != null?Number(s.mineStaff.base_salary_fen):s.mineStaff?.base_salary != null?Number(s.mineStaff.base_salary)*100:null);
    const monthPay=computed(()=>s.summary.month_remuneration_fen != null?Number(s.summary.month_remuneration_fen):baseSalary.value != null && s.summary.month_fen != null?baseSalary.value+Number(s.summary.month_fen):null);
    const timing=row=>{const cfg=row?.timing || row?.config || s.config || {};const link=row?.link_valid_days ?? cfg.link_valid_days,wait=row?.observe_days ?? cfg.observe_days;return '链接 '+(link ?? '—')+' 天 / 等待 '+(wait ?? '—')+' 天 / '+(row?.settlement_cycle || cfg.cycle || cfg.settlement_cycle || '月结');};
    const versionStatus=row=>{const millis=value=>Date.parse(String(value).replace(' ','T')+(/[Zz]|[+-]\d{2}:\d{2}$/.test(String(value))?'':'+08:00'));if(millis(row.eff_at)>Date.now())return '待生效';const latest=[...(s.rules.versions||[])].filter(item=>String(item.party_id||'')===String(row.party_id||'')&&millis(item.eff_at)<=Date.now()).sort((a,b)=>millis(b.eff_at)-millis(a.eff_at)||Number(b.ver)-Number(a.ver))[0];return latest&&Number(latest.ver)===Number(row.ver)?'生效中':'历史';};
    const staffVersions = computed(() => (s.rules.versions || []).filter(row => String(row.party_id || '') === String(s.current?.id || s.current?.staff_id || '')));
    const typeClass = status => ({void:'r',settleable:'g',settled:'a',obs:'w',est:'n',paid:'g',confirmed:'a',draft:'n',active:'g',paused:'w',ended:'n'})[status] || 'n';
    const highRate = (category, bp) => Number(bp) > Number(currentRule.value['rate_' + category + '_bp'] || 0) * 3;
    function canReviewAppeal(row) { return canReview.value && (row.status === 'l2' ? canManage.value : ['pending', 'l1'].includes(row.status)); }
    if (mode === 'new') open('staff');
    if (mode === 'staff') watch(() => ctx.state.svcCreateRequested, requested => {
      if (!requested) return;
      ctx.state.svcCreateRequested = false;
      open('staff');
    }, { immediate: true });
    onMounted(load); onUnmounted(() => { clearPassword(); alive = false; requestId++; clearTimeout(previewTimer); clearTimeout(filterTimer); });
    return { svcSettlementCycles: settlementCycles, svc: s, svcMode: mode, svcTitle: title, svcCategories: categories, svcStatuses: statuses, svcMoney: money, svcYuan: yuan, svcSalary: salary, svcBaseSalary:baseSalary,svcMonthPay:monthPay,svcTiming:timing,svcVersionStatus:versionStatus,svcCount: count, svcTime: time, svcLoad: load, svcFilterChanged: filterChanged, svcAct: act, svcOpen: open, svcCloseDialog: closeDialog, svcAccountModeChanged: accountModeChanged, svcSubmit: submitDialog, svcSaveRule: saveRule, svcSaveConfig: saveConfig, svcPreview: preview, svcExport: exportCsv, svcCopy: copy, svcMinePreview: minePreview, svcCanManage: canManage, svcCanDelegate: canDelegate, svcCanEditProfile: canEditProfile, svcCanFinance: canFinance, svcCanReview: canReview, svcCanReviewAppeal: canReviewAppeal, svcStaffRate: staffRate, svcStaffRateMode: staffRateMode, svcStaffRateForm: staffRateForm, svcSaveDrawerRate: saveDrawerRate, svcShortOpenid: shortOpenid, svcHighRate: highRate, svcViewSettlement: viewSettlement, svcViewStaff: viewStaff, svcViewLedger: viewLedger, svcToggleRow: toggleRow, svcToggleAll: toggleAll, svcTimingChanged: timingChanged, svcResetNew: resetNew, svcRateSummary: rateSummary, svcLedgerKpis: ledgerKpis, svcStaffKpis: staffKpis, svcStaffVersions: staffVersions, svcTagClass: typeClass, svcSelectedTotal: selectedTotal, svcChanged: changed, svcVersions: versions, svcCustomStaff: customStaff, svcCurrentRule: currentRule, svcConfirm: confirmSettlement, svcStaffStatus: staffStatus, svcWecomStatus: wecomStatus, svcWecomTagType: wecomTagType, svcCanRetryWecom: canRetryWecom, svcRetryWecom: retryWecom };
  };
})();
