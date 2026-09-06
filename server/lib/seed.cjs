// 首次启动把演示数据灌入自托管库（数据来源：src/mock/business-data.js）。
// 仅当库为空时执行；之后后台/小程序的改动会真实落库，不会覆盖。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

module.exports = function (source) {
  return async function seed() {
    try {
      const existing = await source.list("cities");
      if (existing && existing.length) {
        console.log("[seed] 已有数据，跳过灌库");
        return;
      }
      const root = path.resolve(__dirname, "..", "..");
      const mockPath = path.join(root, "src/mock/business-data.js");
      if (!fs.existsSync(mockPath)) { console.warn("[seed] 未找到演示数据，跳过"); return; }
      const code = fs.readFileSync(mockPath, "utf8");
      const sandbox = { window: {}, encodeURIComponent, console, Date, Math, JSON };
      vm.createContext(sandbox);
      vm.runInContext(code, sandbox);
      const LXM = sandbox.window.LXM_DATA || {};
      let count = 0;
      for (const key of Object.keys(LXM)) {
        const val = LXM[key];
        if (Array.isArray(val)) {
          for (const item of val) {
            const id = item.id || item._id || (key.slice(0, 2) + "_seed_" + cryptoId());
            await source.upsert(key, id, item);
            count++;
          }
        } else if (val && typeof val === "object") {
          // 对象型集合：homeConfig / config 在应用里是以固定 id "homeStats" 整体读写的，
          // 所以把它们整体存成一条 id=homeStats 的文档；其余对象集合逐键灌入。
          if (key === "homeConfig" || key === "config") {
            await source.upsert(key, "homeStats", val);
            count++;
          } else {
            for (const id of Object.keys(val)) {
              await source.upsert(key, id, val[id]);
              count++;
            }
          }
        }
      }
      console.log(`[seed] 演示数据灌库完成，共 ${count} 条`);
    } catch (e) {
      console.error("[seed] 失败:", e && e.message);
    }
  };
};

function cryptoId() {
  return Math.random().toString(36).slice(2, 10);
}
