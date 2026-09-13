const { createApp, reactive, computed, onMounted, provide, watch } = Vue;

async function bootstrap() {
  if (window.LXM_PAGES?.loadAll) await window.LXM_PAGES.loadAll();
const { ElMessage, ElMessageBox } = ElementPlus;
const LXM_ELEMENT_LOCALE = {
  name: "zh-cn",
  el: {
    pagination: {
      goto: "前往",
      pagesize: "条/页",
      total: "共 {total} 条",
      pageClassifier: "页",
      page: "页",
      prev: "上一页",
      next: "下一页",
      currentPage: "第 {pager} 页",
      prevPages: "向前 {pager} 页",
      nextPages: "向后 {pager} 页"
    },
    datepicker: {
      now: "此刻",
      today: "今天",
      cancel: "取消",
      clear: "清空",
      confirm: "确定",
      selectDate: "选择日期",
      selectTime: "选择时间",
      startDate: "开始日期",
      startTime: "开始时间",
      endDate: "结束日期",
      endTime: "结束时间",
      prevYear: "前一年",
      nextYear: "后一年",
      prevMonth: "上个月",
      nextMonth: "下个月",
      year: "年",
      month1: "1月",
      month2: "2月",
      month3: "3月",
      month4: "4月",
      month5: "5月",
      month6: "6月",
      month7: "7月",
      month8: "8月",
      month9: "9月",
      month10: "10月",
      month11: "11月",
      month12: "12月",
      weeks: { sun: "日", mon: "一", tue: "二", wed: "三", thu: "四", fri: "五", sat: "六" },
      months: { jan: "1月", feb: "2月", mar: "3月", apr: "4月", may: "5月", jun: "6月", jul: "7月", aug: "8月", sep: "9月", oct: "10月", nov: "11月", dec: "12月" }
    }
  }
};

  const app = createApp({
  template: LXM_VIEWS.app,
  setup() {
    // 组装 ctx：先放 Vue 工具与提示组件，再按依赖顺序跑完 src/app/ 下的全部业务模块，
    // 每个模块把自己声明的 state/data/computed/方法合并进 ctx —— 等价于拆分前同一闭包里的全部顶层声明。
    const ctx = { reactive, computed, watch, onMounted, ElMessage, ElMessageBox };
    window.LXM_APP_PARTS.forEach((registerPart) => Object.assign(ctx, registerPart(ctx)));

    // viewModel：模板与 provide("lxm") 的暴露面 = 全部模块导出 + 全局常量（与拆分前等价的超集）
    const {
      reactive: _reactive, computed: _computed, watch: _watch, onMounted: _onMounted,
      ElMessage: _ElMessage, ElMessageBox: _ElMessageBox,
      ...partExports
    } = ctx;
    const viewModel = { LXM_CONFIG, LXM_SERVICE, ...partExports };
    provide("lxm", viewModel);
    return viewModel;
  },
});

  if (window.LXM_PAGES?.components) {
    Object.entries(window.LXM_PAGES.components()).forEach(([name, component]) => app.component(name, component));
  }

  app.use(ElementPlus, { locale: LXM_ELEMENT_LOCALE });
  app.mount("#app");
}

bootstrap().catch((error) => {
  console.error(error);
  const appRoot = document.getElementById("app");
  if (appRoot) appRoot.innerHTML = `<div class="empty-state">后台页面加载失败：${error.message}</div>`;
});
