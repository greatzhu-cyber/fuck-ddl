# Desktop

Tauri 2 桌面应用的 pnpm 包装层。前端来自 `../web`，原生实现位于 [src-tauri](src-tauri/README.md)。

## 命令

```powershell
pnpm --filter @fuck-ddl/desktop dev
pnpm --filter @fuck-ddl/desktop build
pnpm --filter @fuck-ddl/desktop build:installer
```

当前版本为 0.2.0。已安装程序的单实例、托盘、窗口唤醒、动态桥和 JSON 备份通过冒烟；当前源码目录中的 NSIS 产物缺失。P0 不重装现有程序，重新构建和安装验收应在质量门恢复后单独执行。
