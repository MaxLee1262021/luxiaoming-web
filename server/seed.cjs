// 鹿小鸣管理后台 · 真实云灌库脚本（仅用于把演示数据写入你自己的云环境）
// 用法：在 luxiaoming-admin 目录下，确保 .env 已填好三变量，然后：
//   node server/seed.cjs
// 脚本会：① 对每个演示数据 key 找到对应云集合（用 lib/map.cjs）；② 确保集合已创建；
//         ③ 以 id 为主键 upsert（重复运行安全，不会写重复数据）。
// 注意：仅写入演示数据，可逆（在云控制台清空对应集合即可还原）。

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { init } = require("@cloudbase/node-sdk");

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const SECRET_ID = process.env.CLOUDBASE_SECRET_ID;
const SECRET_KEY = process.env.CLOUDBASE_SECRET_KEY;

if (!ENV_ID || !SECRET_ID || !SECRET_KEY) {
  console.error("缺少环境变量：请在 .env 中填好 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY");
  process.exit(1);
}

const map = require("./lib/map.cjs");

// 读取后台自带演示数据（business-data.js 是浏览器全局赋值，用 vm 在独立上下文加载）
const dataPath = path.join(__dirname, "..", "src", "mock", "business-data.js");
const code = fs.readFileSync(dataPath, "utf8");
const sandbox = { window: {}, encodeURIComponent, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const DATA = sandbox.window.LXM_DATA;
if (!DATA) {
  console.error("未能从 src/mock/business-data.js 解析出 LXM_DATA");
  process.exit(1);
}

const app = init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY });
const db = app.database();

function realName(key) {
  return map[key] || key;
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `lxm1$${salt}$${hash}`;
}

function prepareItem(key, item) {
  const accountKeys = new Set(["staff", "shops", "distributors", "agents"]);
  if (!accountKeys.has(key) || !item || typeof item !== "object") return item;
  const copy = Object.assign({}, item);
  if (typeof copy.password === "string" && copy.password && !copy.password.startsWith("lxm1$")) copy.password = hashPassword(copy.password);
  return copy;
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    console.log("  + 创建集合:", name);
  } catch (e) {
    // 已存在 / 控制台已手动建 / 无创建权限 —— 都视为可继续（写入时若集合真不存在会报错并提示）
  }
}

async function seedKey(key) {
  const collName = realName(key);
  const raw = DATA[key];
  if (raw === undefined || raw === null) return;
  const isStableObject = key === "siteConfig" || key === "homeConfig" || key === "config";
  const items = isStableObject ? [{ id: key === "siteConfig" ? "global" : "homeStats", ...raw }] : (Array.isArray(raw) ? raw : [raw]);
  if (items.length === 0) return;
  await ensureCollection(collName);
  const coll = db.collection(collName);
  let ok = 0;
  for (let i = 0; i < items.length; i++) {
    let item = items[i];
    if (typeof item !== "object" || item === null) continue;
    let id = item._id || item.id;
    if (!id) {
      id = key + "_" + (i + 1);
    }
    // 云开发 doc(id).set(body) 不允许 body 里再带 _id，否则报"不能更新_id的值"
    const body = Object.assign({}, prepareItem(key, item));
    delete body._id;
    await coll.doc(id).set(body);
    ok++;
  }
  console.log("  ✓ " + key + " → " + collName + " : " + ok + " 条");
}

(async () => {
  console.log("开始灌库到云环境: " + ENV_ID);
  // addonServices 在 map.cjs 中标记"待确认"且并入 peripherals，先跳过避免重复写入
  const skip = new Set(["addonServices"]);
  const keys = Object.keys(DATA).filter((k) => !skip.has(k));
  for (const key of keys) {
    try {
      await seedKey(key);
    } catch (e) {
      console.error("  ✗ " + key + " 失败:", e && e.message ? e.message : e);
    }
  }
  console.log("灌库完成。运行 npm run server 打开后台即可看到真实云数据。");
})();
