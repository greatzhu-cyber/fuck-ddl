# Edge Extension

Manifest V3 扩展，用于统计活动标签的域名停留，并通过 Native Messaging 把达到阈值的事件交给桌面端。

## 内容

- `service-worker.js`：活动标签和投递编排；
- `domain-tracker.js`：连续计时、阈值和恢复状态；
- `bridge-status.js`：桌面桥连接状态；
- `popup.*`：扩展状态界面；
- `scripts`：构建和隐私冒烟。

## 命令

```powershell
pnpm edge:test
pnpm edge:build
```

扩展只允许处理域名，不得采集完整 URL、标题、搜索词或页面内容。自动化和构建已通过；未专注拒绝与真实全屏 10 分钟置顶提醒仍待 P3 实机验收。
