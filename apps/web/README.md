# Web UI

React 19 + Vite 6 的共享界面，同时供浏览器原型和 Tauri WebView 使用。

## 内容

- `src/App.jsx`：当前主要页面和状态编排，约 3937 行，是后续架构治理重点；
- `src/persistence.js`：版本化 localStorage 持久化；
- `src/desktop-sqlite.js`：Tauri SQLite 状态镜像边界；
- `src/integrations`：PTA/ZJU 桌面来源适配；
- `src/*test*`：Vitest 与 Testing Library 回归；
- `public`：静态资源和摸鱼提醒页面脚本。

## 命令

```powershell
pnpm --filter @fuck-ddl/web dev
pnpm --filter @fuck-ddl/web test
pnpm --filter @fuck-ddl/web build
```

共享算法进入 `packages/domain`。来源字段只读，解析失败保留旧快照。当前 Web 测试 118/118，Prettier、Lint、生产构建和根目录质量门均通过。SQLite 写入错误目前会静默降级，P1 需要补充可诊断性。
