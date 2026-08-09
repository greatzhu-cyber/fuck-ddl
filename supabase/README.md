# Supabase Contract

本目录保存可审查的 SQL 迁移。staging 项目为 `fuck-ddl-staging`（project ref：`vsrdkbjqjqmncgpbdqod`），生产项目为 `fuck-ddl-production`（project ref：`lakcqfkvedjgokjyqgea`）；不得把旧项目 `pmxminhiaargbwbfnvpj` 当作 staging 或生产项目。

当前状态：P5B staging 双用户隔离与 cloud_state 验收已完成；P5D 生产 schema、GitHub OAuth、白名单、桌面回环登录、冲突恢复和重复同步 0/0 幂等已完成。生产凭据、Client Secret、Cookie、会话和数据库密码不进入仓库；P5C 正式签名与 P5D 公开 Release 仍受 Windows 受信任代码签名证书门禁约束。

## 内容

- `20260707000100_core.sql`：GitHub 数字 ID 白名单 Hook、核心用户表、软删除、版本字段、操作回执和 RLS；
- `20260711000100_grade_records.sql`：独立成绩记录和相应隔离策略；
- `20260727000100_cloud_state.sql`：版本化本地业务状态的 staging 云镜像和 owner RLS。

### P5B staging 第一批

2026-07-28 已在独立 staging 项目按顺序执行三份迁移，三次均返回 `Success. No rows returned.`。远程只读核验确认 13 张预期 `public` 表全部存在并启用 RLS；除不向客户端开放的 `github_allowlist` 外，12 张用户数据表各有一条 owner 隔离策略。创建项目时已关闭 “Automatically expose new tables”，并开启 “Enable automatic RLS”。

已创建并启用 `Before User Created` Auth Hook，目标为 `public.hook_restrict_github_signup`。已创建独立 staging GitHub OAuth App `Fuck DDL Staging`，回调地址为 `https://vsrdkbjqjqmncgpbdqod.supabase.co/auth/v1/callback`，并已在 staging Supabase 中启用 GitHub Provider；Client Secret 未读取、未输出且未写入仓库。本地测试 Redirect URL `http://127.0.0.1:5173/**` 已加入允许列表。

两个真实 GitHub 测试账号现已建立：`greatzhu-cyber`（数字 ID `246487156`）和 `jingrruizhu`（数字 ID `310461428`）。第二账号在未入白名单时首次注册被 Hook 明确拒绝；加入 staging 白名单并保持 `enabled=true` 后再次 OAuth 成功。`auth.users` 只读核验确认两条对应记录。

客户端已接入 `cloud_state` 手动同步、非冲突合并、显式冲突选择和 staging 专用 RLS 隔离探针。`jingrruizhu` 的 21 个业务状态首次上传和第二次 0/0 幂等同步均通过；`greatzhu-cyber` 也已写入 21 个业务状态并通过第二次 0/0 幂等同步。两名真实用户分别以非空目标探针完成双向跨用户读取、更新、删除检查，六项操作均返回 0；postgres 后台复核两条目标探针均存在、未删除且更新时间未被对方会话改变。自动门禁通过 Web 25 个测试文件 161/161、Prettier、ESLint、Schema、`git diff --check` 和 P5B Vite 构建。

上述结果曾等待用户明确验收；用户已完成验收并确认 P5B 通过。根目录 `pnpm schema:check` 只是静态契约检查，不能替代远程双用户实测。

不得把数据库密码、service-role key、第三方会话或生产凭据加入仓库。签名、生产 OAuth 配置和公开部署仍需单独授权与验收。

### P5D production schema

2026-08-03 已在生产项目完成 CLI 链接和迁移收口。生产库原有前两个迁移创建的表，但远程迁移历史为空；已使用 `migration repair` 仅登记 `20260707000100` 与 `20260711000100`，随后使用 `db push --linked` 应用 `20260727000100_cloud_state.sql`。最终本地与远程三条迁移版本一致，`public.cloud_state` 已创建且当前为空。

本机 `db diff --linked` 因 Docker Desktop 未运行无法执行 shadow database 差异检查；迁移应用、迁移历史和生产表存在性已通过 CLI 只读核验。

### P5D production OAuth 实际登录（2026-08-09）

生产项目 `fuck-ddl-production` 已完成 GitHub Provider、Redirect URLs、独立生产 OAuth App 和客户端生产配置。生产 GitHub OAuth App 的回调为 `https://lakcqfkvedjgokjyqgea.supabase.co/auth/v1/callback`；桌面回环地址为 `http://127.0.0.1:43123/auth/callback`。Client Secret 只保留在 Supabase 管理后台，未读取、输出或写入仓库。

生产 `public.github_allowlist` 初次只读核验为空；随后使用幂等 SQL 将已确认的 `greatzhu-cyber` 数字 GitHub ID `246487156` 加入并启用。写入后的只读结果为 1 行、`enabled=true`。用户随后完成生产桌面 GitHub OAuth 回环登录，说明 Provider、回调、客户端生产配置和白名单链路已贯通。

### P5D production cloud_state 实际验收

2026-08-09 已在生产本地页面以 `greatzhu-cyber` 完成真实 cloud_state 验收。首次点击“检查并同步”显示已上传 1 项、发现 14 项冲突；应用没有自动覆盖，随后按云端优先策略选择“使用云端数据”，页面成功恢复云端业务状态。恢复后再次同步显示已上传 0 项、已恢复 0 项，且冲突提示消失，生产同用户重复同步幂等通过。

本轮只同步合法的 `fuck-ddl:v1:*` 版本化业务状态；未读取、输出或写入密码、service-role key、GitHub 密码、Cookie、会话或 Client Secret。P5C 正式签名与 P5D 公开 Release 仍未完成。
