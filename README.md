# Fuck DDL

`Fuck DDL` 是 Windows 优先的 DDL 工作记录器，围绕“任务收集 → 今日安排 → 专注计时 → 工作记录 → 完成归档 → 复盘”组织，而不是普通待办列表。

## 当前状态

当前源码版本为 `0.2.0`，已安装桌面版可运行，单实例、托盘、动态 Edge 桥和 JSON 自动备份已通过本机冒烟。P0 工程基线已完成，P1 桌面可靠性待开始。

当前质量基线：Prettier、ESLint、TypeScript、Schema 契约、领域 24/24、Web 118/118、桌面 Rust 32/32、Native Host 6/6、Edge 冒烟/构建和生产构建均通过。

- 当前 SQLite 文件为空库，镜像能力需要在 P1 定位；
- 当前源码目录没有可交付的 0.2.0 NSIS 安装包；
- PTA/ZJU 真实成绩与 Edge 全屏 10 分钟仍需用户实机验收；
- 云端、OAuth、签名和公开发布尚未授权。

权威状态、执行规范和完整历史统一记录在 [codex.md](codex.md)。

## 项目骨架

| 路径                           | 内容                                       |
| ------------------------------ | ------------------------------------------ |
| [apps](apps/README.md)         | Web、Tauri 桌面端、Edge 扩展和 Native Host |
| [packages](packages/README.md) | 跨端共享领域规则                           |
| [docs](docs/README.md)         | 产品、UX、架构、运维和交付文档             |
| [scripts](scripts/README.md)   | Schema 检查与本地发布脚本                  |
| [supabase](supabase/README.md) | 未部署的数据库迁移和 RLS 契约              |
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
4. 不自动修改代理/VPN，不操作生产云，不公开发布。
5. 桌面、来源、Edge 和安装行为必须区分自动化、隔离 UI 和真实实机证据。
6. `apps/native-host/tests/e2e-host.ps1` 会影响桥令牌，不能用于当前真实安装环境。
