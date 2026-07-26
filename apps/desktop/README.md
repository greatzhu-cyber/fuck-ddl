# Desktop

Tauri 2 桌面应用的 pnpm 包装层。前端来自 `../web`，原生实现位于 [src-tauri](src-tauri/README.md)。

## 命令

```powershell
pnpm --filter @fuck-ddl/desktop dev
pnpm --filter @fuck-ddl/desktop build
pnpm --filter @fuck-ddl/desktop build:installer
```

当前源码与已安装桌面版均为 0.3.0；修复版未签名 NSIS 安装器已完成本机升级及卸载/重装。Host 默认路径与 SQLite 启动优先级修复已通过实机验证；最终 13 条任务已从完整备份恢复，卸载/重装过程中出现的自动保留漂移仍需复核。
