# Edge Native Host

Rust Native Messaging Host，负责读取 Edge 长度帧、验证消息并转发到桌面应用写出的动态回环端点。

## 内容

- `src`：协议、配置和转发实现；
- `com.fuckddl.edge_host.template.json`：Host manifest 模板；
- `install-host.ps1`：本机注册脚本；
- `tests/e2e-host.ps1`：隔离端到端脚本。

## 验证

```powershell
cargo fmt --manifest-path apps/native-host/Cargo.toml --check
cargo test --manifest-path apps/native-host/Cargo.toml
cargo clippy --manifest-path apps/native-host/Cargo.toml -- -D warnings
```

当前 6 个测试、fmt 和 Clippy 通过。不要在真实已安装环境运行 `tests/e2e-host.ps1`，该脚本可能覆盖当前桥令牌。
