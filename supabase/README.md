# Supabase Contract

本目录只有可审查的 SQL 迁移，目前没有创建远程 Supabase 项目或 GitHub OAuth App。

## 内容

- `20260707000100_core.sql`：GitHub 数字 ID 白名单 Hook、核心用户表、软删除、版本字段、操作回执和 RLS；
- `20260711000100_grade_records.sql`：独立成绩记录和相应隔离策略。

根目录 `pnpm schema:check` 只做静态契约检查，不等同于真实 PostgreSQL/Supabase 迁移成功。部署前必须在隔离环境执行迁移、启用 Auth Hook，并使用两个测试用户验证读取和写入隔离。

不得把 service-role key、第三方会话或生产凭据加入仓库。云资源、OAuth 和公开部署仍等待用户单独授权。
