# P5A 本地发布准备清单

更新时间：2026-08-09
范围：P5A 本地候选、P5B staging、P5D 生产集成、SignPath bootstrap 预发行和正式签名版发布门禁。

## 当前结论

用户已将新版本号确定为 `0.3.0`。P5A/P5B/P5D 的本地和真实云端门禁已通过；仓库已采用 MIT 并公开，`v0.3.0-unsigned-preview` 已作为 SignPath Foundation 申请用预发行发布。P5C 正式签名仍等待 SignPath Foundation 审核和受控签名流程，因此稳定签名版 Release 尚未完成。

## 当前收口（2026-08-09）

- [x] 本地完整质量门：Web 25 个测试文件/162 个测试、领域 24/24、Prettier、ESLint、TypeScript、Schema、Vite 构建。
- [x] 桌面/Native/Edge 门禁：桌面 Rust 35/35、Native Host 6/6、格式检查、两套 Clippy、Edge 冒烟和构建。
- [x] 生产 schema、GitHub OAuth、白名单、桌面回环登录、cloud_state 冲突恢复和重复同步 0/0 幂等。
- [x] 0.3.0 候选已从生产收口提交重建并完成哈希记录、远端推送和 CI 复验。
- [x] 仓库已设为 public，MIT、隐私、安全和代码签名政策已公开。
- [x] SignPath bootstrap 预发行已创建；安装包明确标注 `NotSigned`，未冒充稳定签名版。
- [ ] P5C 正式签名：等待 SignPath Foundation 审核和受控 CI 签名接入；不得用自签名证书替代。
- [ ] P5D 稳定签名版 Release：签名和 Authenticode 验证通过后另行创建。

## SignPath bootstrap 预发行（2026-08-09）

| 项目           | 当前值                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| 公开仓库       | `https://github.com/greatzhu-cyber/fuck-ddl`                                      |
| 许可证         | MIT                                                                               |
| 标签           | `v0.3.0-unsigned-preview`                                                         |
| 标签来源提交   | `68881a97703d2ccaaadbef91483c1941c3548e19`                                        |
| GitHub Actions | `31293179225`，`completed / success`                                              |
| Release        | `https://github.com/greatzhu-cyber/fuck-ddl/releases/tag/v0.3.0-unsigned-preview` |
| GitHub 资产名  | `Fuck.DDL_0.3.0_x64-setup.exe`                                                    |
| 安装器大小     | 3,350,680 bytes                                                                   |
| 安装器 SHA256  | `8935968D4992031C38032AC9D4C0F3034550B89056DA055992BBF6ABC5DC9104`                |
| Authenticode   | `NotSigned`                                                                       |
| 公开回读校验   | 下载 3,350,680 bytes，SHA256 与本地构建完全一致                                   |
| 正式发布资格   | 无；该资产仅用于 SignPath Foundation bootstrap 申请，不是稳定签名版               |

## 候选元数据

| 项目               | 当前值                                                                           |
| ------------------ | -------------------------------------------------------------------------------- |
| 产品               | Fuck DDL                                                                         |
| 配置版本           | `0.3.0`                                                                          |
| 架构               | Windows x64                                                                      |
| 安装器             | `apps/desktop/src-tauri/target/release/bundle/nsis/Fuck DDL_0.3.0_x64-setup.exe` |
| 安装器大小         | 3,342,127 bytes                                                                  |
| 安装器 SHA256      | `AE58F65717AD9F50AC46D7DCF738F64850B2706B9418CEB8229808B8112B7E6A`               |
| 安装器签名         | `NotSigned`（符合 P5A 边界）                                                     |
| 桌面 EXE SHA256    | `D5229139CBED3D72E85CF9F2C738EBE66F6F6D1E4B027F3440BA76D8BED98ADC`               |
| Native Host SHA256 | `4BBC2CCF1E922CE057AC89982883F00F75C170582E84B038B543D141E2B78669`               |
| 构建分支           | `master`                                                                         |
| 构建来源提交       | `7adc2d05230ee29ecb7be0bb42ecc379676073b3`                                       |
| 工作区             | 构建前后均为空；候选由上述提交直接重建                                           |
| 安装路径           | `C:\Users\zhu\Fuck DDL`                                                          |
| 安装版本           | ProductVersion、FileVersion、卸载注册均为 `0.3.0`                                |
| 安装 EXE SHA256    | `D5229139CBED3D72E85CF9F2C738EBE66F6F6D1E4B027F3440BA76D8BED98ADC`               |

安装器旁已生成 `Fuck DDL_0.3.0_x64-setup.exe.sha256`，用于离线校验；桌面 EXE 的 FileVersion 与 ProductVersion 均为 `0.3.0`。

## 已通过门禁

- [x] 根质量门：Prettier、ESLint、TypeScript、11 表 Schema、桌面 SQLite 能力检查、领域 24/24、Web 153/153、Vite 生产构建。
- [x] 桌面 Rust：格式检查、33/33 测试、Clippy `-D warnings`。
- [x] Native Host Rust：格式检查、6/6 测试、Clippy `-D warnings`、release 构建。
- [x] Edge：域名跟踪冒烟测试与生产目录构建。
- [x] Tauri NSIS x64 安装器构建成功。
- [x] 根目录忽略规则覆盖 `.env`、Cookie、session、token、构建缓存和本地工作目录。
- [x] 敏感文件名扫描未发现证书、私钥、Cookie、Token 或凭据文件；仅保留受控的 `apps/web/.env.example`。
- [x] 安装器、桌面 EXE 和 Native Host 均核验 SHA256 与 Authenticode 状态。
- [x] 34 个实际变更文件已逐项审阅，敏感文件名与凭据模式扫描均为零命中；源码形成明确提交后从该提交重建。

## 本机安装与恢复验收

- [x] 升级前备份 0.2.0 源码、两份旧安装器、当前已安装程序、SQLite、11 份 JSON 和 Edge Host 状态；24 个清单文件全部通过 SHA256 复核。
- [x] NSIS 静默安装返回 0，安装版本与卸载注册均为 `0.3.0`。
- [x] 安装 EXE 与构建 EXE 只相差 Tauri/NSIS 预期的 `BUNDLE_TYPE_VAR_UNK` → `BUNDLE_TYPE_VAR_NSS` 三字节打包标记。
- [x] 通过应用自带导入流程恢复 21 个状态键和 13 条任务；正常重启后任务编码摘要与升级前 SQLite 逐字节一致。跨日复核仅有 `daily-work.dayKey` 与 `focus-state.dayKey` 按预期滚动。
- [x] Native Host 使用明确绝对路径完成注册；动态桥认证返回 `accepted`，临时调试端口已关闭。
- [x] 修复版 0.3.0 从提交 `7adc2d05` 重建并同版本升级安装；安装器返回码 0，ProductVersion、FileVersion、卸载注册均为 `0.3.0`。
- [x] 升级前维护备份 `work/backups/pre-maintenance-0.3.0-to-0.3.0-20260726-103436` 的 21 个文件校验通过；发现旧版已将当前 SQLite 覆盖为 1 条后，已从完整升级前备份恢复 13 条任务。
- [x] 修复版启动后 SQLite 保持 21 个状态键和 13 条任务，任务摘要与完整备份一致；桥接 `accepted`，第二次启动仍保持单实例。
- [x] 静默卸载返回码 0，程序文件和卸载注册移除，数据目录与 Native Host manifest 保留；修复版重装返回码 0，安装版本与卸载注册恢复为 `0.3.0`。
- [ ] 自动数据保留未无条件通过：停止进程后数据库曾从 13 条复核为 11 条，已用原始完整备份恢复 13 条并完成重装后验证；需后续复核优雅退出/备份时序。- [x] 已在提交 `a5152a2` 修复托盘优雅退出的 SQLite 写入时序；Web 154/154、Rust 33/33、Vite 和 Release 构建通过。
- [ ] 新修复候选尚未替换当前安装版；需在安装版上点击托盘“彻底退出”，再复核 13 条任务是否保持。
- [x] 修复 `install-host.ps1` 的默认 Host 路径解析；默认/显式路径回归测试通过。
- [x] 启动恢复改为 SQLite 优先；Web 全量 24 个测试文件、153/153 通过，新增“数据库完整、localStorage 过期”回归覆盖。

## P5A 明确未执行

- [ ] 未运行完整的 `scripts/finish-local-release.ps1`；本轮使用已校验安装器直接升级，并单独注册 Edge Host。
- [x] 已执行 0.3.0 卸载/重装与再次恢复门禁；最终安装、数据恢复、桥接和单实例通过，但自动数据保留漂移保留为待复核项。
- [ ] 未创建或修改 Supabase、GitHub OAuth 或任何外部服务。
- [ ] 未使用代码签名证书，未生成签名更新包。
- [ ] 未上传安装包，未创建 GitHub Release，未公开分发。

## 已解决事项

- [x] **工作区不可复现**：源码变更已审阅并提交为 `daad0374d04a62d9dba0943c20d0b256afe2553a`，候选已从该提交在干净工作区重建。
- [x] **安装门禁**：0.3.0 已安装，业务数据经支持的导入流程恢复，并在正常重启后保持。
- 说明：本次确认了来源可追溯性，没有通过两次独立干净重建比较验证 NSIS 的逐字节确定性。

## 正式发布前剩余阻塞项

1. **签名未授权**：安装器与可执行文件均为 `NotSigned`；进入 P5C 前不得声称正式签名。
2. **外部环境未授权**：Supabase/OAuth 属于 P5B，上传和公开发布属于 P5D。
3. **卸载/重装数据保留需复核**：卸载/重装流程已完成，最终状态已恢复为 13 条；停止进程后曾出现 13→11 漂移，需后续完成优雅退出/备份时序复核。

## 后续授权边界

- P5B：Supabase、数据库迁移、GitHub OAuth 和双用户隔离。
- P5C：代码签名证书、签名安装包与签名验证。
- P5D：指定目标、版本和可见性后上传或公开发布。

## P5B 完成与 P5C/P5D 启动审计（2026-07-30）

- [x] P5B 双用户真实 OAuth、cloud_state 同用户读写、幂等同步和双向 RLS 隔离通过，并获用户明确验收。
- [x] Windows SDK `signtool.exe` 可用；`scripts/build-signed-windows-release.ps1` 已通过语法和无证书失败即停测试。
- [ ] 正式代码签名证书：CurrentUser/LocalMachine 均未发现可用代码签名证书；不得以自签名证书替代公开发布公信签名。
- [ ] 发布仓库与可见性：当前 Git 仓库无 remote，GitHub CLI 未安装，用户尚未指定 owner/repo 及 public/private。
- [ ] 生产云配置：目前只有独立 staging 项目；正式客户端的 Supabase URL、publishable key、OAuth 回调和生产迁移尚未配置。
- [ ] Tauri 更新通道：尚无 updater endpoint、公钥、签名私钥或更新清单配置。
- [ ] 在上述条件满足后，从明确发布提交重建、签名、验证、上传，并记录最终 SHA256、Authenticode、Release URL 和回滚步骤。

## P5D 当前收口记录（2026-08-09）

- [x] 生产 Supabase schema、GitHub OAuth、白名单、桌面回环登录和 cloud_state 真实同步已完成；首次冲突按云端优先恢复，随后 0/0 幂等复核通过。
- [x] 生产变更提交为 `b88814b1`，发布候选记录提交为 `e3ba80a4`；两次提交均已推送到 `greatzhu-cyber/fuck-ddl` 的 `master`。
- [x] GitHub Actions 运行 `31291315852` 返回 `completed / success`；远端 `check` job 的领域 24/24、Web 25 个测试文件和 162/162 测试全部通过。
- [x] 当前 0.3.0 候选已从 `b88814b1` 重建：NSIS 3,353,420 bytes，SHA256 `C035E4672BD17B25A76A2BB6E292650FEB0E9B2A6862701B4AE6571D655381F3`；桌面 EXE SHA256 `BAECEFB79D92CEA5732A880C40139CC75C35D6483BDBA68E91D401ED54628179`。
- [ ] 正式签名：安装器与桌面 EXE 实测均为 `NotSigned`；当前没有受信任代码签名证书和私钥。
- [ ] 公开 Release：在正式签名条件满足前保持停止，不上传未签名安装器冒充正式发布。
