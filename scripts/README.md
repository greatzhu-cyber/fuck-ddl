# Project Scripts

本目录放置仓库级检查和本地发布编排。

- `verify-schema.mjs`：静态检查 Supabase 用户表、`user_id` 和 RLS 契约；
- `finish-local-release.ps1`：失败即停的本地质量门、构建和安装编排；
- `build-signed-windows-release.ps1`：使用受信任代码签名证书构建并验证 Windows 主程序、NSIS 安装器和 Native Host；没有有效证书时失败即停。

发布脚本会产生安装和系统状态变化，不应在普通代码检查中运行。日常质量门只运行只读/构建型检查，不重装现有桌面版；正式签名脚本还要求证书预检通过。

## 正式 Windows 签名构建

证书必须位于当前用户的 Personal 证书存储，包含可访问私钥、Code Signing EKU 且处于有效期。时间戳 URL 和是否使用 RFC 3161 以证书提供商文档为准。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-signed-windows-release.ps1 `
  -CertificateThumbprint <40位证书指纹> `
  -TimestampUrl <证书提供商时间戳URL> `
  -UseRfc3161Timestamp
```

只检查证书条件而不构建时增加 `-PreflightOnly`。脚本要求 Git 工作区和暂存区均为空；成功时主程序、NSIS 安装器和 Native Host 的 Authenticode 状态必须全部为 `Valid`。
