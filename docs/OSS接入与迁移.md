# OSS 接入与历史文件迁移

## 当前结果（2026-09-17）

- 代码已接入 OSS V4 签名、上传确认、业务附件绑定及私有文件访问鉴权。
- 当前真实凭据已通过完整对象验收：V4 表单上传、文件头与大小校验、私有 ACL、签名读取、匿名读取拒绝、防覆盖和自动清理均成功。Bucket 保持私有，且“阻止公共访问”保持开启。
- 已执行 `migrate:files -- --schema`，新增 `lxm_mediaFiles`；MySQL 健康检查 `ready=true`，检查到 30 张规范化表。
- 真实历史盘点找到 **40 个媒体引用，全部是 SVG 演示占位**，没有可迁移的真实图片或视频。本轮未改这些业务字段，**不是已迁移 40 个文件**。
- 本次清单位于仓库外 `../.oss-migration/oss-20260917022002026.json`，不包含在部署包中。占位图应由运营上传真实素材替换。

## 存储与访问方式

使用一个私有 Bucket，所有对象均使用 `private` ACL。`OSS_KEY_PREFIX` 按用途分目录，数据库 `mediaFiles` 保存对象标识、归属、用途与完成状态。

公开商品素材的业务字段保存稳定地址 `/api/media/:fileId`；访问该地址时，服务端生成短期 OSS 读取签名并返回 302。这里的“公开”是应用层素材可见性，不是开放 Bucket。反向代理须把 `/api/media/` 转发到 Node API，不要把跳转响应缓存为长期固定地址。

头像、售后凭证、成片及财务附件均为私有文件。前端通过已认证的 `/api/files/:fileId/access` 按用途和订单归属取得临时访问地址；成片必须由客服/超管发布，发布后本人即可访问，不要求先确认尾款。摄影师只能上传自己负责订单的成片。

前端申请上传意图后，使用服务端返回的 V4 表单字段直传 OSS，再调用 `/complete` 验证实际文件大小、内容类型、文件头和私有 ACL。只有确认成功的文件才可关联业务。业务 Bearer token 只发送给应用 API，不能发送给 OSS。当前上传签名有效期 10 分钟，读取签名有效期 15 分钟；前端按需重新申请，不持久化签名地址。

| 上传用途 | 格式 | 单文件上限 |
| --- | --- | --- |
| 头像 | JPEG、PNG、WebP | 5 MiB |
| 公开素材、售后凭证、财务图片附件 | JPEG、PNG、WebP | 20 MiB |
| 成片照片 | JPEG、PNG、WebP | 50 MiB |
| 公开视频素材、成片视频 | MP4 | 500 MiB |

1 MiB = 1,048,576 字节。售后申请最多 9 张图片。SVG、GIF、任意文档及伪装文件不会作为新上传接受。

## 参数清单

将 `.env.example` 复制为部署机器的 `.env`，或通过进程环境注入配置。真实 AccessKey/STS token 只放在服务端。

| 参数 | 填写方式 |
| --- | --- |
| `OSS_BUCKET` | 当前私有 Bucket 为 `luxiaoming`，必填 |
| `OSS_REGION` | Bucket 所在地域，例如 `cn-shanghai`，必填；示例不是自动选择地域 |
| `OSS_ENDPOINT` | 例如 `https://oss-cn-shanghai.aliyuncs.com`；留空按地域生成 |
| `OSS_KEY_PREFIX` | 默认 `luxiaoming/prod/`；RAM 资源范围必须一致 |
| `OSS_ACCESS_KEY_ID` | 指定 RAM 身份或临时凭据的 AccessKey ID |
| `OSS_ACCESS_KEY_SECRET` | 同一凭据的 AccessKey Secret |
| `OSS_SESSION_TOKEN` | 使用 STS 时填写，与临时 AccessKey 配套；长期 RAM AccessKey 留空 |
| `OSS_READ_DOMAIN` | 可选，已绑定 Bucket 并配置 TLS 的自定义 HTTPS 域名，例如 `https://media.example.com`，不带路径 |

`OSS_READ_DOMAIN` 留空时读取使用默认 OSS 域名；上传始终使用 `https://<bucket>.oss-<region>.aliyuncs.com`。自定义域名需保留签名查询参数；使用代理/CDN 时不得把一个用户的私有签名响应当作无鉴权公共缓存。

当前实现接收配置中的 STS token，不会自动调用 AssumeRole 或刷新过期 token；采用 STS 的部署需由凭据供应方更新并重启服务。权限模板当前针对 `luxiaoming/luxiaoming/prod/*`，使用其他 Bucket 或 Prefix 时同步调整模板资源范围。

## OSS 跨域及微信域名

在 Bucket 的 CORS 配置中为实际管理后台添加规则。当前浏览器直传使用 V4 `POST` 表单，无需向浏览器提供 AccessKey Secret；V4 和 CORS 机制见阿里云 [服务端签名直传](https://www.alibabacloud.com/help/en/oss/user-guide/obtain-signature-information-from-the-server-and-upload-data-to-oss)。

| CORS 项 | 本项目配置 |
| --- | --- |
| Origin | 实际后台来源，例如 `https://admin.example.com`；本地联调按需加入 `http://localhost:5192`、`http://127.0.0.1:5192` |
| Allowed Methods | `POST`、`GET`、`HEAD` |
| Allowed Headers | `content-type`、`range`、`x-oss-*` |
| Exposed Headers | `ETag`、`x-oss-request-id` |
| Max Age | `600` 秒 |

配置时保留 Bucket 中其他应用已有规则。`PutBucketCors` 会整体覆盖现有规则，因此不能只提交一条新规则而遗漏旧规则；见 [阿里云 CORS API](https://www.alibabacloud.com/help/en/oss/developer-reference/putbucketcors)。运行时 RAM 权限模板不包含修改 Bucket ACL 或 CORS 的权限，由 Bucket 管理人员配置即可。

在微信公众平台“开发管理 → 开发设置 → 服务器域名”配置以下实际 HTTPS 域名（填写域名，不带 `/api` 等路径）：

| 微信配置项 | 应加入的域名 |
| --- | --- |
| request 合法域名 | 应用 API 域名，用于登录、申请上传、确认上传及获取访问地址 |
| uploadFile 合法域名 | `https://luxiaoming.oss-cn-shanghai.aliyuncs.com`，与 upload-intent 返回地址一致 |
| downloadFile 合法域名 | `https://luxiaoming.oss-cn-shanghai.aliyuncs.com`；配置 `OSS_READ_DOMAIN` 时还需加入该自定义域名，兼容旧资源或 `/api/media/` 跳转时同时加入应用域名及最终 OSS 域名 |

当前工作区尚未提供小程序正式 API 地址（`miniprogram/config/private-env.js` 不存在）。发布前需在该文件填写真实 `PROD_API_BASE`；不要根据 OSS Bucket 名称或现有 CORS 域名猜测业务 API。

体验版/正式版需使用真实 HTTPS 域名。开发工具“不校验合法域名”不能作为真机通过证据；验证图片预览、MP4 播放及相册保存权限。域名配置步骤可参考腾讯云 [小程序 downloadFile 域名配置](https://docs.cloudbase.net/en/lowcode/practices/miniapp-guide/downloadfile-guide)。

## 检查与迁移命令

以下命令在后台项目根目录运行。`--inventory` 不修改数据库和 OSS，但会在仓库外生成含历史引用的清单；保留该清单用于续跑和回滚。

```sh
# 只读检查 Bucket、地域和现有 CORS；通过不代表拥有上传权限。
npm run oss:check

# 补齐对象权限后执行：写入临时测试对象、验证读取/私有权限/禁止覆盖，再清理测试对象。
npm run oss:check -- --write-test

# 仅新增 OSS 元数据表 lxm_mediaFiles，不迁移或清理已有业务表。
npm run migrate:files -- --schema

# 默认也是 inventory；默认清单输出 ../.oss-migration/<runId>.json。
npm run migrate:files -- --inventory

# 使用实际盘点生成的清单路径；同一清单可中断后再次执行。
npm run migrate:files -- --apply --manifest ../.oss-migration/<runId>.json

# 按清单恢复业务引用；已被后续编辑的记录保留，并标记 rollback-conflict。
npm run migrate:files -- --rollback --manifest ../.oss-migration/<runId>.json
```

`--schema` 是本次 OSS 增量所需的建表步骤；不要为了增加文件表而执行整个旧库的 `migrate:mysql -- --apply`。全新数据库仍按项目数据库初始化说明建立完整表结构。

盘点覆盖内容配置、订单交付、售后、头像、财务附件和回收站中的已识别媒体字段。迁移先读取源文件、校验格式、写入私有 OSS 对象并复核，再用原始字段值作比较更新；并发变化记为 `conflict`，不覆盖他人编辑。公开引用替换为 `/api/media/:fileId`，私有引用替换为文件标识。`--apply` 可复用同一清单继续未完成项；修复清单内记录的源文件问题后再续跑，检查最终状态分布。

回滚同样比较迁移后的业务字段，遇后续修改记为 `rollback-conflict`；不删除原始对象，也不删除已迁入 OSS 的对象。保留源文件和清单直到验收结束，孤立新对象可在后续核对后单独清理。

历史文件的可恢复范围：

- 可读的 Base64 媒体、受允许来源约束的公网 HTTP(S) 地址、后台 `public/` 或相邻小程序 `miniprogram/` 内的本地媒体可以尝试迁移。
- 迁移清单中的 `allowedHosts` 应与实际历史资源来源一致；私网地址、非允许域名及不可读源文件会失败，不会静默改写引用。
- 独立 Linux 后台包不含小程序源码。迁移小程序 `images/` 等本地引用前，需准备相邻 `luxiaoming_交付包/miniprogram/` 源目录，或在对应可读源路径提供原文件。
- `cloud://` 需要旧云存储读取适配与授权；当前 CLI 未注入 `cloudRead` 时会记录 `cloud_read_credentials_required`，不会把云文件 ID 当成已迁移对象。
- `blob:`、`wxfile:`、不可恢复的本机路径和 SVG 演示占位会标记 `needs-original`，必须重新提供真实图片/视频。当前盘点的 40 个引用属于这一类。

## 部署包及验收

```sh
# 默认生成仓库旁的新目录与 tar.gz，不包含 .env。
npm run package:linux

# 已存在同名输出时使用新名称；脚本不会覆盖旧包或删除旧目录。
npm run package:linux -- --name luxiaoming-admin-linux-20260917-oss-r2

# 仅需定向交付本机运行配置时显式启用；归档中的 .env 为 0600。
npm run package:linux -- --name luxiaoming-admin-linux-20260917-oss-config --include-env
```

默认包名为 `luxiaoming-admin-linux-20260917-oss`，包含本说明和 `docs/oss-ram-policy.json`。目标目录、`.tar` 或 `.tar.gz` 任一个已存在都会报错，不会覆盖旧的 `20260915` 交付包。失败留下的输出也不会被下一次打包自动删除。

源码目录可运行 `npm run check`、`npm test`；部署包不含隔离测试目录，安装时执行 `npm run check`。真实 OSS 存储验收已通过；部署后仍需使用真实后台账号完成素材、头像、售后凭证和成片发布的业务验收，并在微信真机确认相册权限、签名过期刷新和跨订单访问拒绝。

## 本地验证记录

- 后台真实 Chrome 隔离联调覆盖全部上传入口、草稿与发布、售后和财务凭证；桌面 1440×1000 与窄屏 390×844 均通过，JavaScript 异常和 console.error 均为 0。OSS 在该检查中使用受控模拟响应，业务接口使用内存测试数据。
- 后台语法检查覆盖 94 个模块；上传前端 13 项、文件服务 6 项、文件业务 10 项和历史迁移 10 项测试通过，既有订单及 API smoke 回归通过。
- 小程序新增文件流程 17 项与原有 7 个测试脚本通过；微信原生编译器完成全部 40 个 WXML、41 个 WXSS 编译。微信真机相册权限与正式域名仍需发布环境验收。
- 真实 MySQL 使用本次自建的临时文件记录验证了元数据持久化、并发字段保留及条件更新冲突保护；记录已清理。未创建真实订单或修改历史业务数据。
