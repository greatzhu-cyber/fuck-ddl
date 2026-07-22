# Project Scripts

本目录放置仓库级检查和本地发布编排。

- `verify-schema.mjs`：静态检查 Supabase 用户表、`user_id` 和 RLS 契约；
- `finish-local-release.ps1`：失败即停的本地质量门、构建和安装编排。

发布脚本会产生安装和系统状态变化，不应在普通代码检查中运行。当前 P0 只运行只读/构建型质量门，不重装现有桌面版。
