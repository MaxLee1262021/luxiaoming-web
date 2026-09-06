// 内容总览页：小程序板块 ↔ 后台页面的一张「地图」+ 建议创建顺序引导。
// 定位：只读导航 + 计数展示，不承担增删改业务（各模块去各自页面操作），
// 解决「不知道小程序里哪些内容要在后台哪里创建」的问题。
window.LXM_PAGES.register({
  key: "contentOverview",
  component: "LxmPageContentOverview",
  group: "content",
  styleScope: "page-route-overview",
  setup(ctx) {
    const Vue = window.Vue;

    const cnt = (list) => (list || []).filter((x) => !x.deleted).length;

    // 短视频与旅拍套餐同存 packages 集合，按铁律分两类计数，绝不合并展示
    const videoSingleCount = Vue.computed(() =>
      (ctx.data.packages || []).filter((p) => !p.deleted && p.type === "video" && p.isVideoSingle).length
    );
    const photoPackageCount = Vue.computed(() =>
      (ctx.data.packages || []).filter((p) => !p.deleted && !(p.type === "video" && p.isVideoSingle)).length
    );

    // 建议创建顺序（新城市从 0 到上架小程序的完整路径）
    const stepDefs = [
      { key: "cities", label: "城市" },
      { key: "spots", label: "打卡点" },
      { key: "series", label: "拍摄风格" },
      { key: "samples", label: "素材库" },
      { key: "albums", label: "照片留影" },
      { key: "videoSingles", label: "短视频" },
      { key: "packages", label: "旅拍套餐" },
      { key: "peripherals", label: "影像周边" },
      { key: "guides", label: "旅拍灵感" },
      { key: "miniDecor", label: "首页装修" }
    ];

    // 模块卡片：miniView = 客人在小程序哪里看到；step 0 表示配置项不进创建顺序
    const cardGroups = [
      {
        key: "basis",
        label: "第一步 · 基础内容",
        desc: "先把这些基础打好，后面建商品才有地方挂",
        cards: [
          { key: "cities", miniView: "探索页 · 城市切换", desc: "开通运营的城市列表，客人切城市看对应的打卡点与商品。", count: Vue.computed(() => cnt(ctx.data.cities)) },
          { key: "spots", miniView: "探索页 · 地图与点位列表", desc: "打卡点 / 旅拍点位。照片、短视频、套餐都要挂到具体点位上。", count: Vue.computed(() => cnt(ctx.data.spots)) },
          { key: "series", miniView: "客人端 · 风格系列入口", desc: "拍摄风格分类（如古装、胶片、现代）。是分类标签，不是商品，建好供各商品选择。", count: Vue.computed(() => cnt(ctx.data.series)) },
          { key: "samples", miniView: "后台暂存 · 不直接展示", desc: "商品图片暂存池：先把作品图传上来，创建商品时直接选用，不用每次重新传。", count: Vue.computed(() => cnt(ctx.data.samples)) }
        ]
      },
      {
        key: "goods",
        label: "第二步 · 旅拍商品",
        desc: "客人在小程序浏览、直接下单的四类商品",
        cards: [
          { key: "albums", miniView: "首页板块 · 照片留影", desc: "照片单品商品，按拍摄风格分组，客人浏览样片后下单。", count: Vue.computed(() => cnt(ctx.data.albums)) },
          { key: "videoSingles", miniView: "首页板块 · 视频摄像", desc: "短视频产品。与旅拍套餐并列的独立商品种类，不合并、不互套。", count: videoSingleCount },
          { key: "packages", miniView: "首页板块 · 旅拍套餐", desc: "套餐组合商品，可多个内容组合定价销售。", count: photoPackageCount },
          { key: "peripherals", miniView: "首页板块 · 影像周边", desc: "相册、摆件等实物周边商品。", count: Vue.computed(() => cnt(ctx.data.peripherals)) }
        ]
      },
      {
        key: "publish",
        label: "第三步 · 内容与装修",
        desc: "帮客人做决策的攻略内容 + 小程序门面装修",
        cards: [
          { key: "guides", miniView: "首页板块 · 旅拍灵感", desc: "旅拍攻略内容，帮客人做决定、促成下单。", count: Vue.computed(() => cnt(ctx.data.guides)) },
          { key: "miniDecor", miniView: "小程序首页", desc: "首页轮播图（首页轮播 / 探索页轮播）、活动公告、板块开关与排序。", count: null },
          { key: "miniConfig", miniView: "小程序全局", desc: "客服企业微信、隐私政策等全局配置。", count: null }
        ]
      }
    ];

    // 按当前角色权限过滤可见卡片与步骤（roleProfile 是 computed，JS 中需 .value 取值）
    const visibleGroups = Vue.computed(() =>
      cardGroups
        .map((g) => ({ ...g, cards: g.cards.filter((c) => ctx.roleProfile.value.menus.includes(c.key)) }))
        .filter((g) => g.cards.length)
    );

    const visibleSteps = Vue.computed(() =>
      stepDefs.filter((s) => ctx.roleProfile.value.menus.includes(s.key))
    );

    const menuLabel = (key) => {
      const m = (ctx.LXM_CONFIG.menus || []).find((x) => x.key === key);
      return m ? m.label : key;
    };

    function goManage(key) {
      ctx.switchMenu(key);
    }

    return { visibleGroups, visibleSteps, menuLabel, goManage };
  }
});
