# Desktop

Tauri 2 桌面应用的 pnpm 包装层。前端来自 `../web`，原生实现位于 [src-tauri](src-tauri/README.md)。

## 命令

```powershell
pnpm --filter @fuck-ddl/desktop dev
pnpm --filter @fuck-ddl/desktop build
pnpm --filter @fuck-ddl/desktop build:installer
```

当前源码与本地候选版本为 0.3.0；未签名 NSIS 安装器已生成但未安装。现有已安装 0.2.0 的单实例、托盘、窗口唤醒、动态桥和 JSON 备份通过历史冒烟；0.3.0 的安装、升级、卸载和数据保留验收需要单独授权。
