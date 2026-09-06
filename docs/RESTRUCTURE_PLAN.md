# 鹿小鸣旅拍后台管理系统目录重构规划

本规划只针对当前目录：`桌面/AI的文件/luxiaoming-admin`。

当前项目是早期纯前端演示版，文件集中在根目录：

- `index.html`：页面入口，同时混有大量内联 CSS、CDN 引用和页面容器。
- `app.js`：模拟数据、角色权限、菜单、订单流程、页面渲染和业务操作全部堆在一起。
- `styles.css`：部分样式已经外置，但和 `index.html` 内联样式存在重复。
- `README.md`：基础说明。

重构目标不是马上改业务，而是先建立清晰目录边界，让后续订单、商家、人员、内容、权限等模块可以稳定迭代、可回滚、可迁移到服务器。

## 一、重构原则

1. 先保可运行，再拆目录
   每一步拆分后都必须打开页面验证，不允许一次性大搬家。

2. 先按业务域拆，再按技术层拆
   鹿小鸣后台核心业务域是：经营看板、订单履约、商家渠道、人员权限、内容商品、系统审计。

3. 数据、配置、视图、动作分离
   模拟数据不能继续和渲染函数混在一起；状态字典、权限字典、菜单配置要单独维护。

4. 保留静态部署能力
   当前阶段仍保持浏览器直接访问或静态服务访问，不引入复杂构建工具。后续正式商用再升级 Vue 工程化。

5. 每完成一个迁移步骤必须 Git commit
   任何一次拆分都要有独立提交，方便回滚。

## 二、目标目录结构

```text
luxiaoming-admin/
├─ index.html
├─ README.md
├─ RESTRUCTURE_PLAN.md
├─ package-notes.md                  # 后续可选：部署/版本说明
│
├─ assets/
│  ├─ images/
│  └─ icons/
│
├─ styles/
│  ├─ base.css                       # 变量、重置、通用字体、颜色
│  ├─ layout.css                     # 登录页、侧栏、顶部栏、主布局
│  ├─ components.css                 # 卡片、表格、弹窗、标签、按钮
│  ├─ pages/
│  │  ├─ dashboard.css
│  │  ├─ orders.css
│  │  ├─ merchants.css
│  │  ├─ staff.css
│  │  ├─ content.css
│  │  └─ system.css
│  └─ index.css                      # 汇总引入
│
├─ js/
│  ├─ app.js                         # 应用启动入口，只负责初始化
│  ├─ state.js                       # 全局状态 currentRole/currentMenu/filters
│  ├─ router.js                      # 菜单切换和页面渲染调度
│  │
│  ├─ config/
│  │  ├─ menus.js                    # 菜单配置
│  │  ├─ roles.js                    # 角色、权限、数据范围
│  │  ├─ order-status.js             # 订单状态、客户可见状态
│  │  └─ constants.js                # 品牌色、日期范围、二维码位置等常量
│  │
│  ├─ mock/
│  │  ├─ orders.js
│  │  ├─ shops.js
│  │  ├─ staff.js
│  │  ├─ products.js
│  │  ├─ content.js
│  │  ├─ scans.js
│  │  └─ logs.js
│  │
│  ├─ services/
│  │  ├─ dashboard-service.js        # 看板聚合：扫码、订单、成交、分账
│  │  ├─ order-service.js            # 订单筛选、改状态、收款、派单、取消
│  │  ├─ merchant-service.js         # 商家归因、二维码、分账
│  │  ├─ permission-service.js       # can/canView/canEdit 权限判断
│  │  ├─ product-service.js          # 套餐、照片单品、系列、打卡点关联
│  │  └─ export-service.js           # CSV 导出
│  │
│  ├─ render/
│  │  ├─ shell-render.js             # 登录、侧栏、顶部栏
│  │  ├─ dashboard-render.js
│  │  ├─ orders-render.js
│  │  ├─ merchants-render.js
│  │  ├─ staff-render.js
│  │  ├─ content-render.js
│  │  ├─ system-render.js
│  │  └─ common-render.js            # 表格、空状态、筛选条、弹窗等通用渲染
│  │
│  └─ utils/
│     ├─ date.js
│     ├─ money.js
│     ├─ dom.js
│     ├─ format.js
│     └─ storage.js
│
└─ vendor/
   ├─ vue.global.js                  # 如果当前版本继续使用 Vue/Element Plus CDN 本地化
   ├─ element-plus.index.css
   └─ element-plus.index.full.min.js
```

## 三、现有文件迁移映射

### `index.html`

保留职责：

- HTML 基础骨架
- 引入 `styles/index.css`
- 引入 `js/app.js`
- 挂载根容器

迁出内容：

- 内联 CSS 迁移到 `styles/`
- 内联页面模板或大段结构迁移到 `render/`
- 业务配置迁移到 `js/config/`

### `styles.css`

拆成：

- `styles/base.css`
- `styles/layout.css`
- `styles/components.css`
- `styles/pages/*.css`

最后由 `styles/index.css` 统一引入。

### `app.js`

拆成：

- 模拟数据：`js/mock/`
- 菜单、角色、状态：`js/config/`
- 业务计算和操作：`js/services/`
- 页面渲染：`js/render/`
- 工具函数：`js/utils/`
- 启动入口：保留为 `js/app.js`

## 四、模块边界设计

### 1. 经营看板

位置：

- `js/services/dashboard-service.js`
- `js/render/dashboard-render.js`
- `styles/pages/dashboard.css`

职责：

- 扫码量、去重访客、浏览未下单、转化订单
- 今日预约、本月成交额
- 已收定金、已收尾款、待收尾款
- 商家排行、扫码时段热力、订单漏斗
- 点击指标跳转或筛选明细

### 2. 订单管理

位置：

- `js/services/order-service.js`
- `js/render/orders-render.js`
- `styles/pages/orders.css`

职责：

- 订单筛选：状态、商家、客服、摄影师、日期、商品类型
- 订单详情抽屉
- 客服手动改状态、收定金、收尾款、改价、加购商品
- 超管派客服/摄影师
- 摄影师只更新拍摄和交付状态
- 商家与摄影师视图脱敏
- 取消订单进入回收站

### 3. 商家管理

位置：

- `js/services/merchant-service.js`
- `js/render/merchants-render.js`
- `styles/pages/merchants.css`

职责：

- 商家档案、城市、位置、联系人、账号
- 一店一码、二维码物料位置
- 扫码统计、订单归因、成交额、预计分账
- 月度对账导出

### 4. 人员与权限

位置：

- `js/services/permission-service.js`
- `js/render/staff-render.js`
- `styles/pages/staff.css`
- `js/config/roles.js`

职责：

- 内部人员账号：超管、客服、摄影师、内容运营
- 商家账号不放在人员管理，放商家管理
- 角色默认权限
- 自定义角色权限
- 重置密码、启停账号、数据范围控制

### 5. 内容与商品

位置：

- `js/services/product-service.js`
- `js/render/content-render.js`
- `styles/pages/content.css`

职责：

- 打卡点
- 系列
- 照片单品
- 样片
- 套餐
- 摄影周边
- 加购服务
- 首页配置与小程序预览

数据关系：

```text
打卡点
└─ 系列
   └─ 照片单品
      └─ 样片

套餐
├─ 关联某个打卡点
└─ 全局主推套餐，不受打卡点限制

通用加购
├─ 摄影周边
├─ 修图/加急/加照片等服务
└─ 不依赖打卡点
```

### 6. 系统审计

位置：

- `js/render/system-render.js`
- `styles/pages/system.css`

职责：

- 操作日志
- 回收站
- 业务设置
- 状态字典
- 云函数字段映射

## 五、拆分执行顺序

### 阶段 0：安全准备

1. 初始化 Git 或确认 Git 可用。
2. 提交当前可运行版本。
3. 新建 `RESTRUCTURE_PLAN.md`。
4. 不移动任何业务文件。

验收标准：

- 页面仍能打开。
- Git 有恢复点。

### 阶段 1：样式拆分

1. 新建 `styles/`。
2. 把 `index.html` 内联 CSS 和 `styles.css` 合并拆分。
3. `index.html` 只保留 `<link rel="stylesheet" href="./styles/index.css">`。

验收标准：

- 登录页、侧栏、看板、订单页视觉不变。
- 无横向错位和明显样式丢失。

### 阶段 2：配置和模拟数据拆分

1. 新建 `js/config/`。
2. 拆出菜单、角色、订单状态、权限字典。
3. 新建 `js/mock/`。
4. 拆出订单、商家、人员、商品、扫码、日志数据。

验收标准：

- 菜单显示完整。
- 角色切换仍正常。
- 看板数据和订单数据仍能关联。

### 阶段 3：工具函数拆分

1. 新建 `js/utils/`。
2. 拆出日期、金额、DOM、格式化、存储函数。

验收标准：

- 日期筛选正常。
- 金额计算正常。
- 导出文件名正常。

### 阶段 4：业务服务拆分

1. 新建 `js/services/`。
2. 先拆 `order-service.js`。
3. 再拆 `dashboard-service.js`。
4. 再拆商家、权限、商品、导出服务。

验收标准：

- 订单状态、收款、派单、取消订单都能操作。
- 看板数据准确关联订单、扫码、商家。
- 权限按角色生效。

### 阶段 5：页面渲染拆分

1. 新建 `js/render/`。
2. 拆登录/壳层。
3. 拆看板。
4. 拆订单。
5. 拆商家/人员/内容/系统。

验收标准：

- 每个菜单页面能独立渲染。
- 弹窗、抽屉、表格、筛选条仍可用。
- 浏览器无控制台错误。

### 阶段 6：服务器部署准备

1. 保留静态版部署方式。
2. 新增 `serve-node.cjs` 或服务器部署说明。
3. 整理 `README.md`。
4. 标记后续云开发 API 对接点。

验收标准：

- 腾讯云轻量服务器可直接静态部署。
- 本地可用 `http://127.0.0.1:端口/` 访问。

## 六、风险控制

### 高风险点

- `app.js` 当前职责过多，直接拆容易丢函数。
- 页面渲染依赖全局状态，拆分时容易出现变量未定义。
- 订单、扫码、商家、分账数据必须保持同一套 ID 关联。
- 角色权限如果拆散，容易出现商家/摄影师看到不该看的数据。

### 控制方式

- 每次只拆一个层级或一个业务域。
- 每次拆完立即浏览器验证。
- 每次验证通过立即 Git commit。
- 每个服务文件先导出纯函数，再替换原调用。
- 不在目录重构阶段新增大功能。

## 七、推荐首批提交计划

```text
commit 1: docs: add admin restructure plan
commit 2: chore: add styles and js directory skeleton
commit 3: refactor: move global styles into styles directory
commit 4: refactor: split menu role and status config
commit 5: refactor: split mock data by business domain
commit 6: refactor: extract order service
commit 7: refactor: extract dashboard service
commit 8: refactor: extract merchant and permission service
commit 9: refactor: split page render modules
commit 10: docs: update deployment and maintenance guide
```

## 八、下一步执行建议

下一步不要马上拆 `app.js`。

建议先执行：

1. 初始化 Git。
2. 提交当前版本。
3. 创建空目录骨架。
4. 只迁移样式，不动业务逻辑。

这样风险最低，视觉和运行最容易验证。
