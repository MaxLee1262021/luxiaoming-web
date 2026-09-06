// /api 路由处理：通用集合增删改查 + 看板/订单统计/首页 + 后台登录。
const url = require("url");
const crypto = require("crypto");

// 密码哈希：scrypt + 随机盐，存储格式 lxm1$<saltHex>$<hashHex>。
// 兼容旧版明文（无 lxm1$ 前缀时直接比对），全量迁移为哈希后可移除兼容分支。
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return "lxm1$" + salt + "$" + hash;
}
function verifyPassword(stored, plain) {
  if (!stored) return false;
  if (!stored.startsWith("lxm1$")) return stored === String(plain);
  const parts = stored.split("$");
  if (parts.length !== 3) return stored === String(plain);
  const actual = crypto.scryptSync(String(plain), parts[1], 64).toString("hex");
  return actual === parts[2];
}
// 新密码强度校验（前后端一致规则）：至少 8 位，且同时包含字母与数字。
// 返回 { ok, reason }，reason 在不过关时给中文提示，符合市面后台「实时强度 + 提交拦截」体验。
function validatePasswordStrength(pwd) {
  if (typeof pwd !== "string" || pwd.length < 8) return { ok: false, reason: "新密码至少 8 位" };
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) return { ok: false, reason: "新密码需同时包含字母和数字" };
  return { ok: true };
}

// 写操作前对密码做服务端哈希：运营/商家/分销/代理账号经后台表单新增或修改时，
// 前端传来的是明文（或已是 lxm1$ 哈希），统一在服务端落库前转为哈希，杜绝明文落地。
// 已带 lxm1$ 前缀的视为已哈希，原样保留（避免二次哈希）。
const PASSWORD_KEYS = ["staff", "shops", "distributors", "agents"];
function sanitizePasswordBody(key, body) {
  if (PASSWORD_KEYS.includes(key) && body && typeof body.password === "string" && body.password && !body.password.startsWith("lxm1$")) {
    body.password = hashPassword(body.password);
  }
  return body;
}
// 写操作返回的单条记录也剥离密码字段（含哈希），前端无需回显密码。
function stripPassword(key, val) {
  if (!PASSWORD_KEYS.includes(key) || !val || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(({ password, ...r }) => r);
  const { password, ...r } = val;
  return r;
}
// 写接口密码策略：账号集合收到明文新密码时，服务端同样执行强度校验（防绕过前端直写弱口令）。
// 已是 lxm1$ 哈希或未携带密码的跳过。返回错误文案，空串=通过。
function passwordPolicyError(key, body) {
  if (!PASSWORD_KEYS.includes(key) || !body || typeof body.password !== "string" || !body.password || body.password.startsWith("lxm1$")) return "";
  const s = validatePasswordStrength(body.password);
  return s.ok ? "" : s.reason;
}

// ---- 登录防爆破（内存限流）----
// 同一账号连续 5 次密码错误，临时锁定 10 分钟；锁定事件直接写入 logs 审计集合。
// 单进程自托管（dev / json / mysql 单实例）够用；未来多进程部署需换成共享存储。
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginAttempts = new Map(); // key: 小写账号 -> { fails, lockedUntil }
function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ALL_KEYS = [
  "cities", "agents", "distributors", "shops", "staff", "spots", "series",
  "albums", "samples", "packages", "addonServices", "peripherals", "tagLibrary",
  "guides", "stories", "scans", "orders", "afterSales", "reconciliationTransfers",
  "financeSettings", "monthlyClosings", "adjustmentRecords", "homeConfig", "logs", "trash",
  "merchantCodes", "siteConfig", "userProfiles"
];

module.exports = function (source, mode) {
  return async function handle(req, res, pathname) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const parsed = url.parse(req.url, true);
    const parts = parsed.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);

    try {
      if (parts[0] === "health") return json(res, 200, { ok: true, mode });

      if (parts[0] === "meta" && parts[1] === "keys")
        return json(res, 200, { keys: ALL_KEYS });

      if (parts[0] === "dashboard") return json(res, 200, await source.dashboard());
      if (parts[0] === "orders" && parts[1] === "stats")
        return json(res, 200, await source.orderStats());
      if (parts[0] === "home") return json(res, 200, await source.homeData());

      // 自托管 RPC：小程序端把原来的 wx.cloud.callFunction 改为请求这里，
      // 由后台用自托管数据源实现原函数（getHomeData / createBooking / ...）。
      if (parts[0] === "rpc") {
        const name = parts[1];
        if (!name) return json(res, 400, { error: "缺少函数名" });
        if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
        const body = await readBody(req);
        try {
          const result = await require("./rpc.cjs")(source, name, body || {}, { req, res });
          return json(res, 200, result); // 成功返回数据对象；失败返回 {success:false,...}
        } catch (e) {
          return json(res, 200, { success: false, message: String((e && e.message) || e) });
        }
      }

      // 商家二维码生成器接口
      if (parts[0] === "merchant-code" && parts[1] === "generate") {
        if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
        const body = await readBody(req);
        return json(res, 200, await source.generateMerchantCode(body || {}));
      }
      if (parts[0] === "merchant-codes" && parts[1] === "stats") {
        const shopId = parsed.query.shopId || "";
        return json(res, 200, await source.merchantCodeStats(shopId));
      }
      if (parts[0] === "merchant-codes") {
        const shopId = parsed.query.shopId || "";
        return json(res, 200, await source.listMerchantCodes(shopId));
      }

      // 后台登录：基于 staff（运营人员）/ shops（合作商家）真实账号，scrypt 校验密码。
      // 不再依赖 ADMIN_PASSWORD 环境变量后门；超级管理员即 staff 中 role:"super"（默认 st1）。
      if (parts[0] === "auth" && parts[1] === "login") {
        const body = await readBody(req);
        const account = (body.account || "").trim();
        const password = body.password || "";
        if (!account || !password) return json(res, 401, { ok: false, error: "请输入账号和密码" });
        // 防爆破：锁定期内直接拒绝（即便密码正确），剩余时长提示到分钟。
        const lockKey = account.toLowerCase();
        const attempt = loginAttempts.get(lockKey);
        if (attempt && attempt.lockedUntil > Date.now()) {
          const mins = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
          return json(res, 429, { ok: false, error: `失败次数过多，账号已临时锁定，请约 ${mins} 分钟后再试` });
        }
        const staffList = (await source.list("staff")) || [];
        const shopList = (await source.list("shops")) || [];
        const staff = staffList.find((u) => u && u.account === account && verifyPassword(u.password, password));
        const merchant = shopList.find((s) => s && s.account === account && verifyPassword(s.password, password));
        // 状态拦截审计：密码正确但账号状态不允许登录时写日志留痕（写失败不影响拦截生效）。
        const writeBlockedAudit = async (detail) => {
          try {
            await source.create("logs", {
              id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
              time: nowText(),
              user: account,
              action: "登录拦截",
              target: "后台",
              detail,
              module: "后台",
              level: "高"
            });
          } catch (e) { /* 审计写失败不影响拦截生效 */ }
        };
        if (staff && staff.status === "停用") {
          await writeBlockedAudit(`停用人员「${staff.name || account}」密码校验通过但被状态拦截，拒绝登录`);
          return json(res, 403, { ok: false, error: "该账号已被停用，请联系管理员启用后再登录" });
        }
        if (merchant && ["暂停合作", "已终止", "停用"].includes(merchant.status || "")) {
          await writeBlockedAudit(`商家「${merchant.name || account}」合作状态为「${merchant.status}」，密码校验通过但被状态拦截，拒绝登录`);
          return json(res, 403, { ok: false, error: "该商家合作已暂停或终止，账号暂无法登录" });
        }
        if (!staff && !merchant) {
          // 密码错误：累计失败次数；达到阈值触发锁定并写审计日志。
          const rec = loginAttempts.get(lockKey) || { fails: 0, lockedUntil: 0 };
          rec.fails += 1;
          if (rec.fails >= LOGIN_MAX_FAILS) {
            rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
            rec.fails = 0;
            loginAttempts.set(lockKey, rec);
            try {
              await source.create("logs", {
                id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
                time: nowText(),
                user: account,
                action: "登录锁定",
                target: "后台",
                detail: `连续 ${LOGIN_MAX_FAILS} 次密码错误，临时锁定 10 分钟`,
                module: "后台",
                level: "高"
              });
            } catch (e) { /* 审计写失败不影响锁定生效 */ }
            return json(res, 401, { ok: false, error: "账号或密码错（失败次数过多，账号已临时锁定 10 分钟）" });
          }
          loginAttempts.set(lockKey, rec);
          return json(res, 401, { ok: false, error: "账号或密码错" });
        }
        loginAttempts.delete(lockKey);
        const role = merchant ? "merchant" : (staff.role || "super");
        const name = (staff && staff.name) || (merchant && merchant.name) || account;
        const token = "lxm-admin-" + Date.now() + "-" + crypto.randomBytes(8).toString("hex");
        return json(res, 200, {
          ok: true,
          role,
          account,
          name,
          // 登录者主体 id：运营人员取 staff.id，合作商家取 shops.id（用于按商家隔离数据）。
          staffId: (staff && staff.id) || (merchant && merchant.id) || "",
          token
        });
      }

      // 自助改密：登录角色在个人中心修改自己的密码。
      // 必须校验原密码（防任意改他人密码），新密码服务端再次校验强度并哈希落库。
      // 账号可能位于 staff / shops / distributors / agents 任一集合，按 account 跨集合定位。
      if (parts[0] === "auth" && parts[1] === "change-password") {
        if (req.method !== "POST") return json(res, 405, { error: "请使用 POST" });
        const body = await readBody(req);
        const account = (body.account || "").trim();
        const oldPassword = body.oldPassword || "";
        const newPassword = body.newPassword || "";
        if (!account || !oldPassword || !newPassword)
          return json(res, 400, { ok: false, error: "请完整填写账号、原密码和新密码" });
        const strength = validatePasswordStrength(newPassword);
        if (!strength.ok) return json(res, 400, { ok: false, error: strength.reason });
        if (newPassword === oldPassword)
          return json(res, 400, { ok: false, error: "新密码不能与原密码相同" });
        // 跨账号集合定位：找到 account 匹配且原密码校验通过的记录。
        let target = null;
        for (const key of PASSWORD_KEYS) {
          const list = (await source.list(key)) || [];
          const rec = list.find((u) => u && u.account === account && verifyPassword(u.password, oldPassword));
          if (rec) { target = { key, id: rec.id }; break; }
        }
        if (!target) return json(res, 401, { ok: false, error: "原密码不正确或账号不存在" });
        await source.update(target.key, target.id, { password: hashPassword(newPassword) });
        return json(res, 200, { ok: true });
      }

      if (parts[0] === "collection") {
        const key = parts[1];
        if (!key) return json(res, 400, { error: "缺少集合 key" });
        if (req.method === "GET") {
          const val = await source.list(key);
          // 安全：staff / shops 含密码字段（即便已是哈希也不应下发前端），登录校验在服务端内部完成。
          const out = (key === "staff" || key === "shops") && Array.isArray(val)
            ? val.map(({ password, ...rest }) => rest)
            : val;
          return json(res, 200, out === undefined ? [] : out);
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const policyErr = passwordPolicyError(key, body || {});
          if (policyErr) return json(res, 400, { error: policyErr });
          const created = await source.create(key, sanitizePasswordBody(key, body || {}));
          return json(res, 200, stripPassword(key, created));
        }
        if (req.method === "PUT") {
          const id = parts[2];
          const body = await readBody(req);
          const policyErr = passwordPolicyError(key, body || {});
          if (policyErr) return json(res, 400, { error: policyErr });
          const updated = await source.update(key, id, sanitizePasswordBody(key, body || {}));
          return json(res, updated ? 200 : 404, stripPassword(key, updated) || { error: "未找到记录" });
        }
        if (req.method === "DELETE") {
          const id = parts[2];
          const ok = await source.remove(key, id);
          return json(res, ok ? 200 : 404, { ok });
        }
      }

      // 按固定 id 存取的配置文档（如 config/homeStats）：有则更新、无则创建
      if (parts[0] === "doc") {
        const key = parts[1];
        const id = parts[2];
        if (!key || !id) return json(res, 400, { error: "缺少文档 key/id" });
        if (req.method === "GET") return json(res, 200, await source.get(key, id));
        if (req.method === "PUT") {
          const body = await readBody(req);
          return json(res, 200, await source.upsert(key, id, body || {}));
        }
        return json(res, 405, { error: "方法不支持" });
      }

      return json(res, 404, { error: "未知接口" });
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) });
    }
  };
};

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        // 先以 Buffer 累积，最后一次性转 UTF-8，避免多字节中文被按 chunk 截断导致乱码
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}
