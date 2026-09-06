window.LXM_SERVICE = {
  auth() {
    return true;
  },
  queryOnlyNotice: "后台仅查询统计成交、核销、履约、分账应计与月度核对数据；收款、提现、佣金结算全部在线下或小程序侧完成。",
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
