# 鹿小鸣长沙旅拍 Web 管理后台

这是鹿小鸣旅拍小程序配套的 Web 管理后台演示项目，用于管理小程序页面内容、商品资料、上下架状态、运营推荐位和基础履约数据。

当前项目采用原生静态页面 + Vue 3 全局构建 + Element Plus 全局构建，支持直接打开预览，也支持本地静态服务访问。

## 项目结构

```text
luxiaoming-admin/
├─ index.html                 # 应用入口
├─ package.json               # 本地开发脚本
├─ public/                    # 第三方静态资源
├─ scripts/                   # 本地工具脚本
│  └─ serve.cjs               # 静态服务
├─ src/                       # 业务源码
│  ├─ app.js                  # Vue 应用入口与全局状态调度
│  ├─ api/                    # 业务接口封装
│  ├─ components/             # 公共组件
│  ├─ config/                 # 业务配置、角色权限、状态枚举
│  ├─ layout/                 # 后台整体壳层
│  ├─ mock/                   # 演示数据
│  ├─ router/                 # 页面注册与懒加载
│  ├─ styles/                 # 全局样式
│  ├─ utils/                  # 通用工具
│  └─ views/                  # 页面模块
└─ docs/                      # 项目说明与交接文档
```

## 主要模块

- 经营中心：经营看板、数据概览。
- 内容商品：打卡点、系列、照片单品、样片、套餐、短视频商品、周边、商品上下架。
- 运营装修：小程序装修预览、攻略管理、故事管理。
- 订单履约：订单管理、拍摄任务、售后服务。
- 渠道增长：人员、分销、商家管理。
- 财务管理：财务审核、月度对账。
- 系统安全：权限管理、操作日志、回收站。

## 启动方式

直接双击 `index.html` 可以预览。

也可以启动本地服务（同时提供前端和受保护的 `/api`）：

```powershell
# 首次运行：复制 .env.example 为 .env，填入本机 MySQL 密码。
# 默认使用单进程内存会话；生产/多实例部署再配置 Redis。
npm run migrate:mysql -- --apply
npm run dev
```

访问：

```text
http://127.0.0.1:5192/
```

没有安装 npm 时，可以直接运行：

```powershell
node scripts/serve.cjs
```

## 当前边界

- 本机运行使用 MySQL 业务数据与 Redis Bearer 会话；`DATA_MODE=json` 只保留给离线测试。
- MySQL 业务表采用字段化主表和独立关系表；`npm run migrate:mysql -- --apply` 会把历史记录转换为该结构并在校验后清理旧载荷列。默认 `--dry-run` 只读统计，真实库操作前需完成备份与维护窗口确认。
- `--apply` 默认只迁移现有数据库，不导入 `server/data/db.json`；仅在明确初始化演示库时追加 `--import-fixture`。
- 已定义的业务字段不会写入整包 JSON；未预先建模的扩展值按路径拆成 `lxm_collection_values` 的 typed leaf 行，便于后续补充正式列。
- 目标 MySQL 建议使用 5.7.7+ / 8.0，并确认 InnoDB `innodb_large_prefix`（或等效 DYNAMIC 行格式）已启用，以支持关系表复合索引。
- 运行时 `DB_AUTO_MIGRATE=true` 只创建规范化表并修复少量兼容列；发现历史 `doc` 表或有数据的聚合表会直接 fail-closed，必须先执行正式迁移，避免旧载荷覆盖新数据。
- 订单异常日志的结构化快照写入 `lxm_log_order_exception_snapshots` 的明确 before/after 字段；普通日志摘要仅允许写入长度受限的 `snapshotText`。
- 回滚使用 `npm run migrate:mysql -- --rollback --confirm`，只清理本项目命名表；数据恢复必须使用已验证的数据库备份。
- 管理 API 需要 Redis Bearer 会话，菜单、角色、账号、登录凭据和数据范围均由服务端校验；前端未认证不会加载管理数据。
- 权限中心提供菜单配置、角色授权、人员新增/编辑/停用。密码只保存在 `lxm_auth_users` 的哈希字段，业务投影不保存凭据。
- 静态 HTTP 服务只发布前端资源，原始 demo fixture、`server/data`、`.env` 和项目元数据不会被直接读取；直接打开 `index.html` 才会加载本地 demo fixture。
- JSON 账号明文迁移可运行 `npm run migrate:passwords`（自动生成 600 权限备份）；财务参数使用 `financeSettings/global` 单文档。
- 支付、提现、佣金结算等资金动作不在本演示版直接执行。

## 后续重点

- 将首页装修配置导出为小程序可消费的 `homeConfig / modules / recommendations` 数据结构。
- 将商品上下架、打卡点、系列、照片单品、短视频商品的编辑保存接入后端。
- ~~继续把 `src/app.js` 中的复杂业务逻辑拆分到 `services` 或页面模块，降低入口文件体积。~~ 已完成（2026-08）：`src/app.js` 已按业务域拆分为 `src/app/` 下 17 个模块文件（详见 `《鹿小鸣-后台-appjs模块化拆分说明.md》`），入口文件仅保留 76 行装配壳。
