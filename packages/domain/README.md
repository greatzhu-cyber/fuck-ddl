# Domain

纯 TypeScript 领域包，是排序、DDL 时间条、任务状态、计时器和工作记录规则的唯一实现来源。

## 内容与命令

- `src`：领域类型、计算和状态机；
- 测试与源码同目录维护；
- 不依赖 React、Tauri、DOM 或具体来源页面。

```powershell
pnpm --filter @fuck-ddl/domain test
pnpm typecheck
```

当前领域测试 24/24 通过。修改规则时必须补充边界测试，并同步检查 Web 展示和产品文档。
