# 后台 API smoke

本检查是本地、可重复的后台 API 合同 smoke，不连接生产数据库、Redis、云环境或客户数据。运行器每次在项目 `server/data/`（已被 `.gitignore` 忽略）下创建临时 synthetic JSON fixture，账号密码在进程内随机生成，文件中只保存带随机盐的测试哈希；为验证脱敏会短暂写入明确标记的合成联系方式/身份字段，进程结束后删除整个临时目录，不包含真实客户数据。

## 运行前提

- Node.js 18 或更高版本（使用内置 `fetch`、`node:test`）。
- 已在项目根目录安装依赖：`npm ci`（或 `npm install`）。
- 不需要启动 MySQL/Redis，也不需要填写 `.env`、云密钥或管理员密码。

如需针对另一个本地副本复测，先确认目标目录没有未预期的共享改动：

```powershell
git -C <project-copy> diff --name-only
```

本 smoke 只写入当前 `--root` 下的临时 `server/data/.api-smoke-*` 目录，不写源码路径。

## 命令

在项目根目录执行：

```powershell
node scripts/api-smoke.cjs
```

机器可读报告：

```powershell
node scripts/api-smoke.cjs --json
```

Node 内置测试 runner：

```powershell
node --test server/tests/api-smoke.test.cjs
```

复测另一个本地副本时显式传项目根目录：

```powershell
node scripts/api-smoke.cjs --root D:\path\to\project-copy
```

脚本返回码为 `0` 表示所有必需断言通过；返回码为 `1` 表示至少一项失败。`auth/me` 与 `auth/logout` 属于可选端点，服务返回 `404/405` 时报告为 `SKIP`，其余实现错误仍会失败。

## 覆盖范围

| 检查 | 断言 |
| --- | --- |
| 健康检查 | `/api/health` 为 200，包含 `ok`、`mode`、`auth.required`、`auth.sessionStore`、`dataStore`，且不泄露密码/密钥字段 |
| 未认证负向 | 管理看板、集合读取在没有 Bearer 时返回 401 |
| 公共 RPC | 浏览和小程序登录 RPC 不被后台 Bearer 拦截 |
| 订单 RPC 负向 | 缺少已验证主体时不能成功读取/创建订单 |
| 登录矩阵 | `super/service/finance/photo/merchant/distributor/agent/content` 均能登录并返回 token、角色、账号、主体 ID |
| 权限矩阵 | 每个角色至少有一个允许路由（200）和一个拒绝路由（403）；商家、分销员、摄影师订单按自身范围过滤 |
| 密码脱敏 | staff/shops 集合及登录、身份响应不含 `password` 字段 |
| 联系方式与公开投影 | 渠道/摄影师订单及小程序订单列表/详情不返回联系方式别名、来源归因或内部支付字段 |
| 工作流边界 | 通用订单/售后 PUT/DELETE、敏感状态跳转、完成/售后锁定字段、伪造来源码和下架内容均被拒绝 |
| 财务对账边界 | 结算主体、订单归属、订单号、审核收款、退款/风控/静置期和服务端分成金额均复核，重复批次幂等拒绝 |
| 静态资源边界 | `server/data`、`package.json`、原始 `src/mock/business-data.js` 不可通过 HTTP 读取 |
| JSON 持久化 | 超管写入 synthetic 标记，重启服务后重新登录仍可读到该标记 |
| Redis fail-closed | `SESSION_STORE=redis` 在缺配置、无效 URL、`REDIS_HOST/PORT/DB` 不可连接时不回落 memory |
| MySQL fail-closed | `DATA_MODE=mysql` 缺少连接配置时不伪装成健康或降级为 JSON |

Redis 探针只使用 `127.0.0.1:1` 这一不可用本地端口，不依赖或写入 Redis。MySQL 探针不发起连接；它验证缺配置状态应被报告为不可用。

## 证据与未覆盖项

脚本输出只包含检查名称、状态和脱敏后的短错误，不输出账号密码、token、数据库连接串或响应中的客户字段。它用于本地回归，不替代生产验收。

未覆盖：真实 Redis/MySQL 成功连接及故障转移、浏览器页面视觉、生产数据迁移、token 过期时间、复杂自定义权限编辑流程，以及小程序端真实微信登录。上述场景需在脱敏测试环境由对应 owner 另行验收。
