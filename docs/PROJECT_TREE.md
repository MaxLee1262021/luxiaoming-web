# 管理后台目录树

后台项目独立存放在 `luxiaoming-admin/`，小程序项目不嵌套在后台目录内，双方通过后端接口或云数据库配置联动。

```text
luxiaoming-admin/
├─ index.html
├─ package.json
├─ scripts/
│  └─ serve.cjs
├─ src/
│  ├─ api/
│  ├─ components/
│  ├─ config/
│  ├─ layout/
│  ├─ mock/
│  ├─ router/
│  ├─ styles/
│  ├─ utils/
│  └─ views/
├─ docs/
│  ├─ COMMUNICATION_NOTES.md
│  ├─ PAGES_STRUCTURE.md
│  ├─ PROJECT_TREE.md
│  ├─ RESTRUCTURE_PLAN.md
│  ├─ ROLE_QA_NOTES.md
│  └─ miniprogram-hardcoded-points.json
├─ eslint.config.js
├─ jsconfig.json
└─ vite.config.js
```

## 已清理目录

- `src/pages/`：旧页面目录，已迁移到 `src/views/`。
- `src/services/`：旧服务目录，已迁移到 `src/api/`。
- `docs/legacy-render/`：旧静态渲染脚本，当前后台已不再使用。
- 根目录临时演示文件：`app-head-raw.js`、`app-repair-work.js`、`content-product-*.html` 已删除。
