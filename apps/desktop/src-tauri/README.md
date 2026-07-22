# Tauri Rust Core

本目录是 Windows 桌面原生层。

## 主要内容

- `src/lib.rs` / `src/main.rs`：Tauri 应用入口；
- `src/pintia.rs`、`src/zju.rs`：只读来源 WebView 与解析；
- `src/edge_bridge.rs`：动态回环端点和 Edge 事件校验；
- `src/backup.rs`：本地 JSON 备份；
- `tauri.conf.json`：窗口、权限、Bundle 和 SQLite preload；
- `capabilities`：Tauri 权限边界。

## 验证

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```

当前 32 个 Rust 测试、Rustfmt 和 Clippy 均通过。真实来源测试不得输出会话；学在浙大验收由用户关闭 VPN 后进行。
