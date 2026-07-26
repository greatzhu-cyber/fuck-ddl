# Desktop

Tauri 2 桌面应用的 pnpm 包装层。前端来自 `../web`，原生实现位于 [src-tauri](src-tauri/README.md)。

## 命令

```powershell
pnpm --filter @fuck-ddl/desktop dev
pnpm --filter @fuck-ddl/desktop build
pnpm --filter @fuck-ddl/desktop build:installer
```

当前源码与已安装桌面版均为 0.3.0；上一修复版已完成本机升级及卸载/重装。当前工作区新增 SQLite 优雅退出修复并生成新的未签名 NSIS 候选，尚未替换当前安装版；13 条任务的卸载/重装自动保留漂移仍需在新候选上复核。
