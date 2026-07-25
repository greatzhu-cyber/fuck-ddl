# Web UI

React 19 + Vite 6 的共享界面，同时供浏览器原型和 Tauri WebView 使用。

## 内容

- `src/App.jsx`：页面渲染与交互编排；持久化业务状态已移入 `src/app-persistence.js`；
- `src/app-persistence.js`：统一业务状态 hook，集中维护键、校验器和迁移器；
- `src/persistence.js`：版本化 localStorage 持久化；
- `src/desktop-sqlite.js`：桌面数据库状态与降级状态边界；
- `src/storage/sqlite-repository.js`：SQLite repository、事务 schema、outbox 和同步游标接口；
- `src/storage/outbox-replay.js`：离线 outbox 重放编排，保留不可变 operation id，区分发送、重试、确认待处理和终止失败；
- `src/storage/sync-conflict-policy.js`：默认挂起的同步冲突分类与显式本地/远端优先策略；
- `src/integrations`：PTA/ZJU 桌面来源适配；
- `src/storage/sqlite-repository.integration.test.js`：使用 Node 内置真实内存 SQLite 演练租约、崩溃恢复和重复重放；
- `src/*test*`：Vitest 与 Testing Library 回归；
- `public`：静态资源和摸鱼提醒页面脚本。

## P4 约束

本批次只治理应用状态与本地存储边界，不改变 PTA/ZJU 任务读取、成绩读取、Edge 读取或云端同步行为。repository 的 outbox/cursor 接口已完成租约栅栏、成功确认、指数退避、过期租约回收和 8 次终止失败；离线重放与冲突策略完成本地边界。真实云端 transport 仍未接入，属于未授权 P5。

## 命令

```powershell
pnpm --filter @fuck-ddl/web dev
pnpm --filter @fuck-ddl/web test
pnpm --filter @fuck-ddl/web build
```

共享算法进入 `packages/domain`。来源字段只读，解析失败保留旧快照。当前 Web 测试 24 个测试文件、152/152，Prettier、Lint、生产构建和根目录质量门均通过。
