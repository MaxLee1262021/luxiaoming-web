window.LXM_SERVICE = {
  auth() {
    return !!window.LXM_AUTH?.hasSession?.();
  },
  queryOnlyNotice: "收款与退款通过微信线上完成。商家分成在退款观察期结束后入账，本期提供查询与对账，不提供商家结算及打款。",
  // 商家二维码落地路径：带 codeId 的小程序码落地到 scanEntry，由它解析后跳首页；
  // 仅传 shopId（旧式）则落地到首页并带入商家来源。
  qrUrl(code) {
    if (code && typeof code === "object") {
      return code.codeId
        ? `pages/scanEntry/scanEntry?c=${code.codeId}`
        : `pages/index/index?shopId=${code.shopId || ""}`;
    }
    return `pages/index/index?shopId=${code || ""}`;
  }
};
