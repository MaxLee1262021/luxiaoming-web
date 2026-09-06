# 页面结构说明

后台页面按业务模块拆分到 `src/views/`。每个页面目录通常包含三类文件：

```text
page-name.html  # 页面模板
page-name.css   # 页面局部样式
page-name.js    # 页面局部逻辑
```

页面注册由 `src/router/index.js` 统一维护。

## 模块对应关系

| 模块 | 目录 | 说明 |
| --- | --- | --- |
| 经营中心 | `src/views/operation/` | 经营看板、业绩分析、经营追踪 |
| 订单履约 | `src/views/orders/` | 订单管理、接单、拍摄任务、售后 |
| 财务管理 | `src/views/finance/` | 财务审核、月度对账、报表导出 |
| 渠道增长 | `src/views/channel/` | 人员、分销、商家管理 |
| 内容商品 | `src/views/content/` | 打卡点、系列、照片单品、套餐、短视频、周边、增值服务 |
| 运营装修 | `src/views/operationConfig/` | 小程序装修预览、攻略、故事 |
| 系统安全 | `src/views/system/` | 操作日志、回收站 |

## 菜单与页面

```text
经营中心
├─ 经营看板        -> src/views/operation/dashboard/
├─ 业绩分析        -> src/views/operation/performance/
└─ 经营追踪        -> src/views/operation/trace/

订单履约
├─ 订单管理        -> src/views/orders/order-list/
├─ 客服接单        -> src/views/orders/receive/
├─ 派单管理        -> src/views/orders/dispatch/
├─ 拍摄任务        -> src/views/orders/task/
└─ 售后服务        -> src/views/orders/after-sale/

内容商品
├─ 打卡点设置      -> src/views/content/spot/
├─ 系列管理        -> src/views/content/series/
├─ 照片单品管理    -> src/views/content/album/
├─ 样片管理        -> src/views/content/photo/
├─ 套餐设置        -> src/views/content/package/
├─ 短视频商品      -> src/views/content/package/  # 复用套餐页，按 active=videoProducts 区分
├─ 商品上下架      -> src/views/content/shelf-products/
├─ 标签管理        -> src/views/content/tag/
├─ 商品审核        -> src/views/content/audit/
├─ 摄影周边        -> src/views/content/peripheral/
└─ 增值服务        -> src/views/content/addon-service/

运营装修
├─ 小程序装修预览  -> src/views/operationConfig/mini-decor/
├─ 攻略管理        -> src/views/operationConfig/guide/
└─ 故事管理        -> src/views/operationConfig/story/
```

## 开发约束

- 公共菜单、角色、状态枚举放在 `src/config/`。
- 公共接口封装放在 `src/api/`。
- 公共工具放在 `src/utils/`。
- 页面模板和页面样式保持在对应 `src/views/` 目录内。
- 后续继续迭代时，应优先把 `src/app.js` 中可复用的计算和业务动作迁移到服务层。
