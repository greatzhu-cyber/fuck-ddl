# Fuck DDL

`Fuck DDL` 是 Windows 优先的 DDL 工作记录器，围绕“任务收集 → 今日安排 → 专注计时 → 工作记录 → 完成归档 → 复盘”组织，而不是普通待办列表。

作者：zhu
邮箱：1976114118@qq.com

## 当前状态

当前源码与已安装桌面版均为 `0.3.0`。未签名的 Windows x64 本地候选已在完成 0.2.0 源码、安装器、已安装程序和业务数据备份后安装；版本、单实例、动态 Edge 桥、SQLite 镜像与跨重启数据恢复均已通过本机验证。P0 工程基线、P1 桌面可靠性、P2 PTA/ZJU 联合验收、P3 Edge 全屏验收和 P4 架构治理均已通过；P5A 本地发布准备、P5B staging 云端验收、P5D 生产 schema、生产 OAuth 和 cloud_state 真实 0/0 幂等同步已完成；P5C 正式签名和 P5D 公开发布仍未完成。

当前质量基线：Web 25 个测试文件、162/162，ESLint、TypeScript、Prettier、Vite 生产构建、桌面 Rust 35/35、Native Host 6/6、Edge 冒烟/构建和标准桌面构建均通过。

- P4 第一批已抽出 `useAppPersistentState`，降低 `App.jsx` 的持久化状态编排耦合；
- SQLite 已建立事务 schema、`app_state` repository、`sync_outbox` 和 `sync_cursors` 边界；`sync_outbox` 已具备租约栅栏、成功确认、指数退避、崩溃回收和 8 次终止失败；
- 离线重放、幂等确认、崩溃恢复和显式冲突策略已通过真实内存 SQLite 演练；P4 自动门禁与用户实机验收均已通过；
- P5A 已按用户指定的 `0.3.0` 生成未签名 NSIS 本地候选和发布清单，并从审阅后的源码提交 `daad0374` 在干净工作区重新构建；本机安装后保留 21 个状态键与 13 条任务，任务编码摘要与升级前备份一致，跨日运行元数据按预期更新；
- staging 双用户云同步与 RLS 隔离已验收；生产 Supabase schema、Provider、Redirect URLs、客户端配置和白名单已完成。
- 桌面 OAuth 已接入一次性 `127.0.0.1` 回环 PKCE 回调和系统浏览器登录；生产 `greatzhu-cyber` 登录、云端冲突处理和恢复后 0/0 幂等同步均已完成真实验收。

权威状态、执行规范和完整历史统一记录在 [codex.md](codex.md)。

## 项目骨架

| 路径                           | 内容                                       |
| ------------------------------ | ------------------------------------------ |
| [apps](apps/README.md)         | Web、Tauri 桌面端、Edge 扩展和 Native Host |
| [packages](packages/README.md) | 跨端共享领域规则                           |
| [docs](docs/README.md)         | 产品、UX、架构、运维和交付文档             |
| [scripts](scripts/README.md)   | Schema 检查与本地发布脚本                  |
| [supabase](supabase/README.md) | staging/生产数据库迁移和 RLS 契约          |
| `work`                         | 本机备份和临时材料，不应提交               |
| `.github/workflows`            | Windows 持续集成配置                       |

## 常用命令

```powershell
pnpm install
pnpm dev
pnpm check
pnpm edge:test
pnpm edge:build
pnpm desktop:build
pnpm desktop:installer
```

Rust 子项目还应分别执行：

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path apps/native-host/Cargo.toml --check
cargo test --manifest-path apps/native-host/Cargo.toml
cargo clippy --manifest-path apps/native-host/Cargo.toml -- -D warnings
```

## 执行规范

1. 修改前先读 [codex.md](codex.md) 和所在目录 README。
2. 先运行定向测试，再运行完整质量门。
3. PTA/ZJU 的密码、Cookie、Token 和会话不得写日志或提交。
4. 不自动修改代理/VPN；生产云变更和公开发布必须有明确授权并留下核验记录。
5. 桌面、来源、Edge 和安装行为必须区分自动化、隔离 UI 和真实实机证据。
6. `apps/native-host/tests/e2e-host.ps1` 会影响桥令牌，不能用于当前真实安装环境。
