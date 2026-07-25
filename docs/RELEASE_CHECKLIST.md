# P5A 本地发布准备清单

更新时间：2026-07-25
范围：只读审计、质量门、构建和产物核验；不安装、不签名、不上传、不连接云端。

## 当前结论

用户已将新版本号确定为 `0.3.0`，P5A 本地候选已按该版本成功重建。版本冲突已经解除；候选仍包含未提交工作区内容，因此在形成明确提交并从该提交重建前，不能声明为可复现的正式发布版本。

## 候选元数据

| 项目               | 当前值                                                                           |
| ------------------ | -------------------------------------------------------------------------------- |
| 产品               | Fuck DDL                                                                         |
| 配置版本           | `0.3.0`                                                                          |
| 架构               | Windows x64                                                                      |
| 安装器             | `apps/desktop/src-tauri/target/release/bundle/nsis/Fuck DDL_0.3.0_x64-setup.exe` |
| 安装器大小         | 3,342,375 bytes                                                                  |
| 安装器 SHA256      | `33727A7F9339F556A9ED3492511EBC28CCD5446845FE7BEB4BEE097D359362CE`               |
| 安装器签名         | `NotSigned`（符合 P5A 边界）                                                     |
| 桌面 EXE SHA256    | `35795F1FA8D70577A6B288D42F3F0A0EB69FE24EA8486566D31A9D45B011B1FF`               |
| Native Host SHA256 | `4BBC2CCF1E922CE057AC89982883F00F75C170582E84B038B543D141E2B78669`               |
| 构建分支           | `master`                                                                         |
| 构建时 HEAD        | `62d7d6d4a0717fea6d38ec350b7def231a237d5e`                                       |
| 工作区             | 含未提交变更；候选包含工作区内容，不能只由上述 commit 重现                       |

安装器旁已生成 `Fuck DDL_0.3.0_x64-setup.exe.sha256`，用于离线校验；桌面 EXE 的 FileVersion 与 ProductVersion 均为 `0.3.0`。

## 已通过门禁

- [x] 根质量门 `pnpm check`：Prettier、ESLint、TypeScript、11 表 Schema、桌面 SQLite 能力检查、领域 24/24、Web 152/152、Vite 生产构建。
- [x] 桌面 Rust：格式检查、33/33 测试、Clippy `-D warnings`。
- [x] Native Host Rust：格式检查、6/6 测试、Clippy `-D warnings`、release 构建。
- [x] Edge：域名跟踪冒烟测试与生产目录构建。
- [x] Tauri NSIS x64 安装器构建成功。
- [x] 根目录忽略规则覆盖 `.env`、Cookie、session、token、构建缓存和本地工作目录。
- [x] 敏感文件名扫描未发现证书、私钥、Cookie、Token 或凭据文件；仅保留受控的 `apps/web/.env.example`。
- [x] 安装器、桌面 EXE 和 Native Host 均核验 SHA256 与 Authenticode 状态。

## P5A 明确未执行

- [ ] 未运行 `scripts/finish-local-release.ps1`，因为该脚本会安装软件并写 Edge Host 注册表。
- [ ] 未安装、升级或卸载本候选，未停止当前已安装应用。
- [ ] 未创建或修改 Supabase、GitHub OAuth 或任何外部服务。
- [ ] 未使用代码签名证书，未生成签名更新包。
- [ ] 未上传安装包，未创建 GitHub Release，未公开分发。

## 正式发布前阻塞项

1. **不可复现工作区**：当前仍有未提交变更；必须先审阅并形成明确提交，再从该提交重建候选。
2. **签名未授权**：安装器与可执行文件均为 `NotSigned`；进入 P5C 前不得声称正式签名。
3. **外部环境未授权**：Supabase/OAuth 属于 P5B，上传和公开发布属于 P5D。
4. **安装门禁未执行**：0.3.0 候选仍需单独授权本机安装/升级/卸载与数据保留验收。

## 后续授权边界

- P5B：Supabase、数据库迁移、GitHub OAuth 和双用户隔离。
- P5C：代码签名证书、签名安装包与签名验证。
- P5D：指定目标、版本和可见性后上传或公开发布。
