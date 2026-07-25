# 运维说明

版本：`0.1-draft`  
状态：已批准

## 1. 运行环境

计划支持：

- Windows 10/11 64 位桌面端。
- Microsoft Edge 当前受支持稳定版。
- 现代桌面与移动浏览器中的响应式网页端。
- Tauri 所需的 WebView2 Runtime。

开发环境在实施阶段固定 Node LTS、pnpm、Rust stable 和 Supabase CLI 版本，并提交版本文件；文档不提前锁定未经验证的具体版本号。

### 1.1 当前 Windows Alpha

- 便携文件：`apps/desktop/src-tauri/target/release/fuck-ddl.exe`。
- P5A 本地候选：`apps/desktop/src-tauri/target/release/bundle/nsis/Fuck DDL_0.3.0_x64-setup.exe`；已完成本机升级安装。
- 当前构建：Tauri 2 Release、未签名 NSIS x64 安装器；`0.3.0` 已锁定，并已从审阅后的源码提交 `daad0374d04a62d9dba0943c20d0b256afe2553a` 在干净工作区重建。
- 运行方式：优先安装后从开始菜单运行；本机安装路径为 `C:\Users\zhu\Fuck DDL`。
- 重新构建：在已加载 MSVC 环境且 Rust/Cargo 可用的终端运行 `pnpm desktop:build`。
- 当前数据以 WebView localStorage 为主，并由应用私有 SQLite 镜像和本机 JSON 自动备份保护；仍不视为云端多设备数据源。
- 2026-07-25 P5A 0.3.0 候选：3,340,907 bytes，SHA256 `235C6DC792E0F6EFE3B014170D708B9D5DAC4D731F7BD8252F5ED9389DB16D82`；Authenticode 状态为 `NotSigned`。来源可追溯，但尚未验证 NSIS 跨次重建的逐字节确定性。完整门禁与阻塞项见 `RELEASE_CHECKLIST.md`。
- 已安装 EXE 的 ProductVersion/FileVersion 均为 `0.3.0`，SHA256 `16742D85CB867CA4F164158952ABB16C1DF995B1E7BF3DAE455F4B10DCED465F`；它与构建 EXE 只相差 Tauri/NSIS 预期的 `BUNDLE_TYPE_VAR_UNK` → `BUNDLE_TYPE_VAR_NSS` 三字节打包标记。
- 升级前备份位于 `work/backups/pre-upgrade-0.2.0-to-0.3.0-20260725-233618`；24 个清单文件全部通过 SHA256 复核，未复制平台 Cookie 或登录会话。
- 主窗口关闭会隐藏到托盘；使用托盘菜单“显示 Fuck DDL”恢复，选择“彻底退出”才停止进程。重复启动会唤醒现有窗口。
- 通知插件已进入安装版；Windows 原生无声 Toast 已在安装版中完成可见性验收。

## 2. 环境分层

- `local`：本机 Supabase 或隔离开发项目，使用假数据。
- `staging`：测试 OAuth、网页部署、安装包和适配器，不放真实长期数据。
- `production`：白名单用户使用的正式环境。

三个环境使用独立数据库、OAuth 回调、密钥和扩展 ID。禁止用生产 service role 运行本地开发。

## 3. 密钥管理

云端机密：

- GitHub OAuth client secret。
- Supabase service role/secret key。
- Windows 更新签名私钥和代码签名凭据。

这些密钥只进入托管平台的 secret store 或离线安全介质，不写入 `.env.example`、日志、安装包或仓库。

桌面机密：

- Supabase refresh token。
- PTA 和学在浙大认证会话。
- Edge Native Messaging 配对令牌。

显式 token/secret 进入 Windows Credential Manager 或 Tauri Stronghold。PTA Cookie 由来源专属 WebView2 目录保存，应用不读取、导出或上传明文 Cookie；日志只记录会话状态，不记录值。

## 4. 部署流程

### 4.1 数据库

1. 在 staging 恢复最近生产备份的脱敏副本。
2. 执行向前迁移并运行 RLS/数据完整性测试。
3. 创建生产即时备份。
4. 执行生产迁移。
5. 验证登录、单用户查询和跨用户拒绝。

破坏性迁移必须使用“新增字段 → 回填 → 切换读取 → 后续版本删除”的扩展/收缩方式。

### 4.2 网页

- 先部署预览环境并运行核心流程。
- 生产部署必须使用已批准 commit。
- 检查 OAuth 回调、CSP、安全 Cookie、缓存和版本标识。
- 失败时回滚到上一个静态构建；数据库回滚遵循迁移方案，禁止直接降级破坏性 schema。

### 4.3 Windows

- CI 构建签名安装包和更新清单。
- 在干净 Windows 虚拟机验证安装、升级、卸载和数据保留。
- 通知只能在已安装应用中判定是否正常。
- 先发布测试通道，再提升到稳定通道。

本机 Alpha 的完整质量门、构建、安装、Host 注册和动态桥验证可统一执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\finish-local-release.ps1
```

脚本任何一步失败都会立即停止，不安装半成品；成功结尾必须显示 `PASS`、版本、安装包路径和 SHA256。

### 4.4 Edge 扩展

- 开发期使用固定 key 保持扩展 ID 稳定。
- 生产 Native Messaging host 仅允许正式扩展 ID。
- 上架 Edge Add-ons 属于外部公开发布，必须另行得到用户授权。

当前本地 Alpha 安装步骤（不得由构建自动执行）：

1. 运行 `node apps/edge-extension/scripts/build.mjs` 生成 `apps/edge-extension/dist`。
2. 在 Edge 的扩展开发者模式中加载该目录，并记录 Edge 显示的扩展 ID。
3. 构建 `apps/native-host/target/release/fuck-ddl-edge-host.exe`。
4. 用户确认后运行 `.\apps\native-host\install-host.ps1 -ExtensionId <扩展 ID>`，仅写入当前用户的 Edge Native Messaging Host 注册表项。
5. 打开桌面端和扩展弹窗，确认“桌面端连接正常”；再用测试域名完成 10 分钟实机验收。

全屏提醒验收必须使用 0.1.13 或更高版本。达到阈值后，除静音系统通知外，桌面端还会显示标题为“Fuck DDL · 摸鱼提醒”的置顶小窗口，以绕过 Windows 在网页全屏时可能启用的通知抑制。桌面端启动时由 Windows 分配可用回环端口并写入 `edge-bridge.endpoint`，Native Host 每次投递前读取该端点；不得恢复为固定端口。若扩展未显示“桌面端连接正常”、专注未自动暂停或窗口未出现，不得把 Phase 6 标记为通过。

卸载时必须删除 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.fuckddl.edge_host` 和对应 manifest；不得删除 Fuck DDL 用户数据。0.2.0 已完成静默卸载→备份保留→重装→启动的本机验证。

## 5. 备份与恢复

云端：

- 使用 Supabase 可用的数据库备份能力，并在选定套餐前核对保留期。
- 每日导出业务表的加密逻辑备份到独立存储。
- 建议保留 7 个每日、4 个每周、6 个每月备份。

桌面：

- 桌面端每天生成一份脱敏本地 JSON 备份，保留最近 14 份；文件位于 `%LOCALAPPDATA%\com.fuckddl.desktop\backups`，不包含平台 Cookie、密码或 GitHub 会话。
- 用户可随时导出 JSON、CSV、Markdown。
- 导入前自动保存当前恢复点；备份格式与版本校验失败时不修改当前数据。

每季度至少执行一次恢复演练，并记录恢复点目标和实际耗时。

## 6. 日志与隐私

默认只写本地结构化日志：

- 应用版本、平台版本、错误码和操作类型。
- 同步批次 ID、条目数量、耗时和结果。
- 适配器名称、状态码类别和最后成功时间。

禁止记录：

- 密码、Cookie、token、授权 code。
- 完整 URL、网页标题、搜索词和输入内容。
- 任务备注正文，除非用户主动导出诊断包且明确确认。

远程错误上报默认关闭；若以后加入，必须提供清晰的选择加入和脱敏清单。

## 7. 监控指标

- 登录成功率和 OAuth 回调失败率。
- 同步成功率、outbox 积压量和冲突率。
- 数据库错误、RLS 拒绝异常增长和函数延迟。
- 客户端崩溃率与版本分布。
- 每个外部适配器的成功率、解析失败率和最后成功时间。

不上传域名访问明细；只允许用户选择同步汇总统计。

## 8. 常见故障处理

### 8.1 GitHub 登录失败

1. 检查 GitHub 状态、回调 URL 和 client secret。
2. 检查用户 GitHub ID 是否在白名单。
3. 检查 PKCE verifier 是否与发起登录的设备一致。
4. 不要求用户提供 GitHub 密码或 token。

### 8.2 桌面与网页数据不一致

1. 查看 outbox 是否积压。
2. 手动触发拉取并比较服务端版本。
3. 从 `task_versions` 恢复冲突前版本。
4. 禁止通过删除本地数据库“解决”同步问题。

### 8.3 PTA 同步失败

1. 检查登录会话是否过期。
2. 打开独立 PTA 窗口；有效会话会直接进入活跃题目集，失效时才重新认证。
3. 检查接口/DOM 契约测试是否失败。
4. 只有页面明确显示“无题目集”且完整同步成功时，才从活跃列表移出旧 PTA 任务。
5. 超时、登录过期、解析失败或单任务刷新都必须保留既有任务和最后成功时间。

若出现 `Guest + 用户不存在`，在集成页点击“重置 PTA 登录”。该动作只清理 PTA 来源目录中的 Cookie、localStorage 和 sessionStorage，不删除任务，也不影响学在浙大会话。

会话保持验收：在 0.1.5 登录一次，关闭整个 Fuck DDL 后重新打开，再从集成页打开 PTA；应直接进入活跃题目集。若仍失效，保留任务 localStorage 和最后成功快照，记录为未通过。

### 8.4 学在浙大同步失败

1. 首先提示用户关闭 VPN/代理并重试。
2. 检查校园认证会话是否过期。
3. 检查平台是否只能从特定网络访问。
4. 不自动修改系统代理，不反复提交登录表单。
5. 仍失败时停用本次同步，保留旧数据。

读取口径：不要把 `/user/index` 的全局“待办事项为空”当作完整快照；当前适配器从 `/user/courses` 读取课程，再扫描课程 `/content` 页的标准摘要、父容器或状态标签附近结构。最多扫描课程列表前 40 门、累计 200 条作业。已完成和已过期作业不进入最近 DDL；只有成功完成全部扫描的快照才允许移除本来源的旧任务。

成绩读取口径：PTA 接收本地成绩账本中的最终 ID，跳过已出分和已确认错过的题目集，只复查未公布或尚未读取的项目；用户可设置同步起始日期和最多纳入 20/50/100/200 项。未定案详情仍按每轮最多 20 个、详情间隔 2.2 秒、列表翻页间隔 1.2 秒分批续扫；遇到“访问得太快”立即停止本轮并保留已取得成绩。学在浙大最多扫描课程列表中的 40 门课程，兼容作业标记位于父容器、标准摘要或状态标签附近三种结构；“已交 N 分”为已出分，“已交”为未公布，仅有“已结束”为错过 DDL。前端超时不得低于 180 秒。`unpublished` 必须保留空分数；解析失败保留上次成绩，不清空账本。

分类进度：平台只给出“未完成/部分完成/已完成”时，内部使用 0/50/100 绘制进度条，其中 50 只代表分类中点。界面必须显示“部分完成（平台未提供百分比）”，不得声称精确完成 50%。

验收：登录一次后点击“更新全部”，应读取信息安全课程综合实践中的 `Lab 1 - Pwn 基础`、`Web导论 — Homework` 和 `Lab0`；重复更新不得产生重复任务。随后关闭整个 Fuck DDL 并重新打开，再次更新，确认不要求重复登录。若失败，保留上次成功的学在浙大任务，不清空 localStorage。

### 8.5 Edge 提醒失效

1. 检查扩展权限和是否被禁用。
2. 检查 Native Messaging host 注册表和 allowed origin。
3. 检查桌面端是否运行及配对令牌是否有效。
4. 扩展更新后必须在 `edge://extensions` 对 Fuck DDL Focus Guard 点击一次“重新加载”。
5. 新版 ACK 契约要求桌面端明确处于专注状态；未专注时达到阈值不会消费提醒，开始专注后最多约 30 秒重试一次。
6. 扩展故障不得影响任务计时和核心应用。

### 8.6 数据恢复

1. 停止同步 worker。
2. 备份当前故障数据。
3. 在隔离环境验证备份可读、用户归属和版本连续性。
4. 恢复后运行完整性检查，再恢复同步。

## 9. 适配器维护策略

- 每个来源可通过远程配置单独停用，但远程配置不得包含任意代码。
- 解析失败达到阈值后自动熔断，避免持续请求网站。
- 页面/API 变化先更新脱敏固定样本和契约测试，再发布适配器。
- 同步默认每 45 分钟一次，失败采用指数退避，不进行高频抓取。
- 发布前核对第三方网站的使用条款和允许的自动化范围。

## 10. 发布检查表

- [x] 用户批准产品、UX、架构和运维文档。
- [x] 所有测试和构建通过。
- [ ] RLS 双用户隔离通过。
- [x] 本机 JSON 自动备份、导入前恢复点和卸载后保留验证通过。
- [x] Windows 0.1.9 → 0.1.10 静默升级、版本注册和启动通过。
- [x] Windows 卸载与数据保留策略实机验证通过。
- [ ] 更新包签名验证通过。
- [x] Edge 权限、域名脱敏、断线重试和生产目录构建检查通过。
- [x] PTA 0.1.5 登录、同步与重启保持验证通过。
- [x] 学在浙大安装版完成态移除与会话保持验证通过。
- [x] 源码、文档与构建输入未发现密钥、Cookie、真实邮箱或令牌模式；依赖缓存已排除。
