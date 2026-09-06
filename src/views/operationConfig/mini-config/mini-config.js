window.LXM_PAGES.register({
  key: "miniConfig",
  component: "LxmPageMiniConfig",
  group: "operationConfig",
  title: "小程序全局配置",
  description: "配置小程序全站通用文案与规则：约拍定价、预约须知、隐私政策、企业微信、搜索热词、足迹章册",
  styleScope: "page-route-mini-config",
  setup(ctx) {
    const { ElMessage } = ElementPlus;
    const state = ctx.state;

    function ensureSite() {
      const c = state.siteConfig || (state.siteConfig = {});
      c.customPrice = c.customPrice || { baseHours: 1, singlePersonPrice: 200, perExtraPerson: 100, note: "" };
      c.bookingNotice = Array.isArray(c.bookingNotice) ? c.bookingNotice : [];
      c.privacyText = c.privacyText || "";
      c.wechat = c.wechat || { corpId: "", appId: "", guideText: "" };
      c.search = c.search || { hotwords: [] };
      c.search.hotwords = Array.isArray(c.search.hotwords) ? c.search.hotwords : [];
      c.footprint = c.footprint || { enabled: true, total: 12, title: "", rewardText: "" };
      return c;
    }

    // 首次挂载前补齐 siteConfig 必备字段（模板 v-model 直接访问，避免 undefined.xxx 崩溃）
    ensureSite();

    // 预约须知
    function addNoticeLine() { ensureSite().bookingNotice.push("新须知条目"); }
    function removeNoticeLine(i) { ensureSite().bookingNotice.splice(i, 1); }

    // 搜索热词
    function addHotword() {
      const draft = (state._hotwordDraft || "").trim();
      if (!draft) return ElMessage.info("先输入热词再添加");
      ensureSite().search.hotwords.push(draft);
      state._hotwordDraft = "";
      ElMessage.success("已添加热词：" + draft);
    }
    function removeHotword(i) { ensureSite().search.hotwords.splice(i, 1); }

    // 隐私政策
    function resetPrivacy() {
      ensureSite().privacyText = "鹿小鸣旅拍（以下简称“我们”）非常重视你的个人信息和隐私保护。在你使用小程序预约旅拍服务时，我们仅收集完成预约所必需的姓名、手机号与拍摄偏好，用于安排摄影团队与交付成片。我们不会向无关第三方分享你的个人信息，详情可在小程序内查阅完整隐私政策。（运营可在后台编辑完整条款）";
      ElMessage.success("已恢复默认隐私政策");
    }

    return {
      // 暴露给模板的辅助绑定
      addHotword,
      removeHotword,
      addNoticeLine,
      removeNoticeLine,
      resetPrivacy
    };
  }
});
