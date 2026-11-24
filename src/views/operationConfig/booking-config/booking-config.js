window.LXM_PAGES.register({
  key: "bookingConfig", component: "LxmPageBookingConfig", group: "operationConfig",
  title: "预约配置", description: "默认定金比例、预约须知、成功页温馨提示、约拍定制定价与隐私配置", styleScope: "page-route-booking-config",
  setup(ctx) {
    const { ref, reactive, computed, onMounted } = window.Vue;
    const form = reactive({ depositRatioPercent: undefined, notice: "", version: "", single: undefined, extraPerPerson: undefined });
    const privacyForm = reactive({ title: "隐私政策", content: "", updateTime: "" });
    const tipsForm = reactive({ content: "" });
    const loading = ref(true), saving = ref(false), privacySaving = ref(false), tipsSaving = ref(false), loadError = ref("");
    const busy = computed(() => saving.value || privacySaving.value || tipsSaving.value);
    let originalNotice = "", originalVersion = "";
    const editable = computed(() => ctx.can("contentEdit"));
    const empty = value => value === null || value === undefined || String(value).trim() === "";
    const number = value => empty(value) ? undefined : Number(value);
    const noticeLines = value => (Array.isArray(value) ? value : String(value || "").split(/\r?\n/)).map(line => String(line).trim()).filter(Boolean);
    const percent = value => empty(value) ? undefined : Number((Number(value) > 1 ? Number(value) : Number(value) * 100).toFixed(6));
    const configured = (price, keys) => { const key = keys.find(key => Object.prototype.hasOwnProperty.call(price, key)); return key ? price[key] : undefined; };
    const ready = computed(() => !empty(form.depositRatioPercent) && noticeLines(form.notice).length > 0 && !!form.version.trim());
    const privacyReady = computed(() => !!privacyForm.title.trim() && !!privacyForm.content.trim());
    const privacyUpdatedAt = computed(() => {
      if (!privacyForm.updateTime) return "";
      const date = new Date(privacyForm.updateTime);
      return Number.isNaN(date.getTime()) ? privacyForm.updateTime : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    });
    function applyConfig(config = {}) {
      const price = config.customPrice || {};
      form.depositRatioPercent = percent(configured(price, ["depositRatio", "depositRate", "depositPercent"]));
      form.single = number(configured(price, ["single", "singlePersonPrice"]));
      form.extraPerPerson = number(configured(price, ["extraPerPerson", "perExtraPerson"]));
      form.notice = noticeLines(config.bookingNotice).join("\n");
      form.version = String(config.bookingNoticeVersion || config.agreementVersion || "").trim();
      originalNotice = form.notice; originalVersion = form.version;
    }
    function applyPrivacyConfig(config = {}) {
      const policy = config.privacyPolicy || {};
      privacyForm.title = String(policy.title || "隐私政策");
      if (typeof policy.content === "string") privacyForm.content = policy.content;
      else if (Array.isArray(policy.sections) && policy.sections.length) {
        privacyForm.content = policy.sections.map(section => {
          if (!section || typeof section !== "object") return "";
          const paragraphs = Array.isArray(section.paragraphs) && section.paragraphs.length ? section.paragraphs : [section.content || ""];
          return [section.title, ...paragraphs].filter(line => typeof line === "string" && line.trim()).join("\n");
        }).filter(Boolean).join("\n\n");
      } else privacyForm.content = typeof config.privacyText === "string" ? config.privacyText : "";
      privacyForm.updateTime = String(policy.updateTime || "");
    }
    async function loadConfig() {
      if (busy.value) return;
      loading.value = true; loadError.value = "";
      try {
        const result = await window.LXM_CLOUD.loadMenuData("bookingConfig", ctx.data, ctx.state, { force: true, joinPending: true });
        if (!result || result.ok !== true || !(result.loaded || []).includes("siteConfig")) throw new Error("预约配置加载失败，请重新加载后再编辑");
        applyConfig(ctx.state.siteConfig || {});
        applyPrivacyConfig(ctx.state.siteConfig || {});
        tipsForm.content = typeof ctx.state.siteConfig?.bookingSuccessTips === "string" ? ctx.state.siteConfig.bookingSuccessTips : "";
      } catch (error) {
        loadError.value = error.message || "预约配置加载失败，请稍后重试";
      } finally { loading.value = false; }
    }
    function validationError() {
      const ratio = number(form.depositRatioPercent);
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 100) return "请填写 0 到 100 之间的默认定金比例";
      for (const [field, label] of [["single", "单人价格"], ["extraPerPerson", "每增加一人价格"]]) {
        const value = number(form[field]);
        if (value !== undefined && (!Number.isFinite(value) || value < 0 || (field === "single" && value === 0) || !Number.isSafeInteger(Math.round(value * 100)))) return `请填写有效的${label}${field === "single" ? "（须大于 0）" : ""}`;
      }
      const lines = noticeLines(form.notice);
      if (!lines.length) return "请填写预约须知正文";
      const version = form.version.trim();
      if (!version || version.length > 128) return "请填写预约须知版本，最多 128 个字符";
      if (originalVersion && lines.join("\n") !== originalNotice && version === originalVersion) return "预约须知正文已修改，请同时更新须知版本";
      return "";
    }
    async function saveConfig() {
      if (!editable.value || loading.value || busy.value || loadError.value) return;
      if (!ctx.isServerConnected()) return ctx.ElMessage.error("服务端连接不可用，预约配置未保存");
      const error = validationError();
      if (error) return ctx.ElMessage.warning(error);
      const payload = {
        customPrice: { single: number(form.single) ?? null, extraPerPerson: number(form.extraPerPerson) ?? null, depositRatio: number(form.depositRatioPercent) / 100 },
        bookingNotice: noticeLines(form.notice), bookingNoticeVersion: form.version.trim()
      };
      saving.value = true;
      try {
        const result = await window.LXM_CLOUD.upsertDoc("siteConfig", "global", payload);
        if (!result || result.error || result.ok === false || !(result.ok === true || result.id || result._id)) throw new Error(result && result.error || "服务端未确认保存，请重试");
        ctx.state.siteConfig = { ...ctx.state.siteConfig, ...payload, customPrice: { ...ctx.state.siteConfig?.customPrice, ...payload.customPrice } };
        applyConfig(ctx.state.siteConfig);
        ctx.ElMessage.success("预约配置已保存，小程序重新进入预约页后生效");
      } catch (error) { ctx.ElMessage.error("保存失败：" + (error.message || "请稍后重试")); }
      finally { saving.value = false; }
    }
    async function saveSuccessTips() {
      if (!editable.value || loading.value || busy.value || loadError.value) return;
      if (!ctx.isServerConnected()) return ctx.ElMessage.error("服务端连接不可用，温馨提示未保存");
      const content = tipsForm.content.replace(/\r\n?/g, "\n").trim();
      if (content.length > 20000) return ctx.ElMessage.warning("温馨提示最多 20000 个字符");
      tipsSaving.value = true;
      try {
        const result = await window.LXM_CLOUD.upsertDoc("siteConfig", "global", { bookingSuccessTips: content });
        if (!result || result.error || result.ok === false || !(result.ok === true || result.id || result._id)) throw new Error(result && result.error || "服务端未确认保存，请重试");
        ctx.state.siteConfig = { ...ctx.state.siteConfig, bookingSuccessTips: content };
        tipsForm.content = content;
        ctx.ElMessage.success("温馨提示已保存，小程序重新进入预约成功页后生效");
      } catch (error) { ctx.ElMessage.error("保存失败：" + (error.message || "请稍后重试")); }
      finally { tipsSaving.value = false; }
    }
    async function savePrivacyConfig() {
      if (!editable.value || loading.value || busy.value || loadError.value) return;
      if (!ctx.isServerConnected()) return ctx.ElMessage.error("服务端连接不可用，隐私配置未保存");
      const title = privacyForm.title.trim(), content = privacyForm.content.trim();
      if (!title || title.length > 128) return ctx.ElMessage.warning("请填写隐私政策标题，最多 128 个字符");
      if (!content || content.length > 20000) return ctx.ElMessage.warning("请填写隐私政策正文，最多 20000 个字符");
      privacySaving.value = true;
      try {
        const result = await window.LXM_CLOUD.upsertDoc("siteConfig", "global", { privacyPolicy: { title, content } });
        if (!result || result.error || result.ok === false || !(result.ok === true || result.id || result._id)) throw new Error(result && result.error || "服务端未确认保存，请重试");
        ctx.state.siteConfig = { ...ctx.state.siteConfig, privacyPolicy: result.privacyPolicy || { title, content }, privacyText: content };
        applyPrivacyConfig(ctx.state.siteConfig);
        ctx.ElMessage.success("隐私配置已保存，小程序重新进入隐私政策页后生效");
      } catch (error) { ctx.ElMessage.error("保存失败：" + (error.message || "请稍后重试")); }
      finally { privacySaving.value = false; }
    }
    onMounted(loadConfig);
    return { form, privacyForm, tipsForm, loading, saving, privacySaving, tipsSaving, busy, loadError, editable, ready, privacyReady, privacyUpdatedAt, loadConfig, saveConfig, savePrivacyConfig, saveSuccessTips };
  }
});
