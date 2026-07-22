# Applications

本目录包含所有可执行端。共享业务规则应放在 `packages/domain`，不要复制到各应用。

| 目录                                       | 职责                          | 当前状态                         |
| ------------------------------------------ | ----------------------------- | -------------------------------- |
| [web](web/README.md)                       | React/Vite 共享界面和本地状态 | Web 118/118，完整质量门通过      |
| [desktop](desktop/README.md)               | Tauri 桌面构建包装            | 0.2.0 已安装，当前安装包缺失     |
| [edge-extension](edge-extension/README.md) | Edge 域名计时扩展             | 构建/冒烟通过，10 分钟实机待验收 |
| [native-host](native-host/README.md)       | Native Messaging 桥           | Rust 测试通过                    |

修改跨端行为时，先确认它属于共享领域、Web 展示还是平台能力。来源同步必须保持只读和幂等。
