# Desktop

Tauri 2 桌面应用的 pnpm 包装层。前端来自 `../web`，原生实现位于 [src-tauri](src-tauri/README.md)。

## 命令

```powershell
pnpm --filter @fuck-ddl/desktop dev
pnpm --filter @fuck-ddl/desktop build
pnpm --filter @fuck-ddl/desktop build:installer
```

当前源码与已安装桌面版均为 0.3.0；未签名 NSIS 安装器已完成本机升级安装。旧版源码、安装器、已安装程序、SQLite 与 JSON 已建立可回滚备份；0.3.0 的版本、单实例、动态桥、业务状态恢复和正常重启保持均已通过，卸载/重装门禁尚未执行。
