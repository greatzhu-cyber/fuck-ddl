# Supabase Contract

本目录保存可审查的 SQL 迁移。P5B 只连接独立 staging 项目 `fuck-ddl-staging`（project ref：`vsrdkbjqjqmncgpbdqod`）；不得把现有项目 `pmxminhiaargbwbfnvpj` 当作 staging，也不得在 P5B 修改生产资源。

## 内容

- `20260707000100_core.sql`：GitHub 数字 ID 白名单 Hook、核心用户表、软删除、版本字段、操作回执和 RLS；
- `20260711000100_grade_records.sql`：独立成绩记录和相应隔离策略；
- `20260727000100_cloud_state.sql`：版本化本地业务状态的 staging 云镜像和 owner RLS。

### P5B staging 第一批

2026-07-28 已在独立 staging 项目按顺序执行三份迁移，三次均返回 `Success. No rows returned.`。远程只读核验确认 13 张预期 `public` 表全部存在并启用 RLS；除不向客户端开放的 `github_allowlist` 外，12 张用户数据表各有一条 owner 隔离策略。创建项目时已关闭 “Automatically expose new tables”，并开启 “Enable automatic RLS”。

已创建并启用 `Before User Created` Auth Hook，目标为 `public.hook_restrict_github_signup`。已创建独立 staging GitHub OAuth App `Fuck DDL Staging`，回调地址为 `https://vsrdkbjqjqmncgpbdqod.supabase.co/auth/v1/callback`，并已在 staging Supabase 中启用 GitHub Provider；Client Secret 未读取、未输出且未写入仓库。本地测试 Redirect URL `http://127.0.0.1:5173/**` 已加入允许列表。

两个真实 GitHub 测试账号现已建立：`greatzhu-cyber`（数字 ID `246487156`）和 `jingrruizhu`（数字 ID `310461428`）。第二账号在未入白名单时首次注册被 Hook 明确拒绝；加入 staging 白名单并保持 `enabled=true` 后再次 OAuth 成功。`auth.users` 只读核验确认两条对应记录。

客户端已接入 `cloud_state` 手动同步、非冲突合并、显式冲突选择和 staging 专用 RLS 隔离探针。`jingrruizhu` 的 21 个业务状态首次上传和第二次 0/0 幂等同步均通过；`greatzhu-cyber` 也已写入 21 个业务状态并通过第二次 0/0 幂等同步。两名真实用户分别以非空目标探针完成双向跨用户读取、更新、删除检查，六项操作均返回 0；postgres 后台复核两条目标探针均存在、未删除且更新时间未被对方会话改变。自动门禁通过 Web 25 个测试文件 161/161、Prettier、ESLint、Schema、`git diff --check` 和 P5B Vite 构建。

上述结果仍需用户明确验收后才能宣布 P5B 完成。根目录 `pnpm schema:check` 只是静态契约检查，不能替代远程双用户实测。

不得把数据库密码、service-role key、第三方会话或生产凭据加入仓库。P5B 不创建或修改生产资源；签名和公开部署仍等待用户单独授权。
