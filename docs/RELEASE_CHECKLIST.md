# P5A 本地发布准备清单

更新时间：2026-07-25
范围：只读审计、质量门、构建和产物核验；不安装、不签名、不上传、不连接云端。

## 当前结论

用户已将新版本号确定为 `0.3.0`。P5A 本地候选已从审阅后的源码提交 `daad0374d04a62d9dba0943c20d0b256afe2553a` 在干净工作区成功重建，构建来源可追溯。当前未执行两次独立干净重建的逐字节比较，因此不声明 NSIS 产物具备逐字节确定性。

## 候选元数据

| 项目               | 当前值                                                                           |
| ------------------ | -------------------------------------------------------------------------------- |
| 产品               | Fuck DDL                                                                         |
| 配置版本           | `0.3.0`                                                                          |
| 架构               | Windows x64                                                                      |
| 安装器             | `apps/desktop/src-tauri/target/release/bundle/nsis/Fuck DDL_0.3.0_x64-setup.exe` |
| 安装器大小         | 3,340,907 bytes                                                                  |
| 安装器 SHA256      | `235C6DC792E0F6EFE3B014170D708B9D5DAC4D731F7BD8252F5ED9389DB16D82`               |
| 安装器签名         | `NotSigned`（符合 P5A 边界）                                                     |
| 桌面 EXE SHA256    | `BD09E624BE3AA040FB4F6C4FBD8E128EC62CAB0A841724855260EB0EAD04F80E`               |
| Native Host SHA256 | `4BBC2CCF1E922CE057AC89982883F00F75C170582E84B038B543D141E2B78669`               |
| 构建分支           | `master`                                                                         |
| 构建来源提交       | `daad0374d04a62d9dba0943c20d0b256afe2553a`                                       |
| 工作区             | 构建前后均为空；候选由上述提交直接重建                                           |

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
- [x] 34 个实际变更文件已逐项审阅，敏感文件名与凭据模式扫描均为零命中；源码形成明确提交后从该提交重建。

## P5A 明确未执行

- [ ] 未运行 `scripts/finish-local-release.ps1`，因为该脚本会安装软件并写 Edge Host 注册表。
- [ ] 未安装、升级或卸载本候选，未停止当前已安装应用。
- [ ] 未创建或修改 Supabase、GitHub OAuth 或任何外部服务。
- [ ] 未使用代码签名证书，未生成签名更新包。
- [ ] 未上传安装包，未创建 GitHub Release，未公开分发。

## 已解决事项

- [x] **工作区不可复现**：源码变更已审阅并提交为 `daad0374d04a62d9dba0943c20d0b256afe2553a`，候选已从该提交在干净工作区重建。
- 说明：本次确认了来源可追溯性，没有通过两次独立干净重建比较验证 NSIS 的逐字节确定性。

## 正式发布前剩余阻塞项

1. **签名未授权**：安装器与可执行文件均为 `NotSigned`；进入 P5C 前不得声称正式签名。
2. **外部环境未授权**：Supabase/OAuth 属于 P5B，上传和公开发布属于 P5D。
3. **安装门禁未执行**：0.3.0 候选仍需单独授权本机安装/升级/卸载与数据保留验收。

## 后续授权边界

- P5B：Supabase、数据库迁移、GitHub OAuth 和双用户隔离。
- P5C：代码签名证书、签名安装包与签名验证。
- P5D：指定目标、版本和可见性后上传或公开发布。
