import { describe, expect, it } from "vitest";
import {
  migrateTaskSourceNames,
  normalizeSourceName,
  SOURCE_PTA,
  SOURCE_ZJU,
} from "./source-names.js";

describe("来源名称迁移", () => {
  it("把旧来源名称迁移为用户确认的正式名称", () => {
    expect(normalizeSourceName("Pintia")).toBe(SOURCE_PTA);
    expect(normalizeSourceName("浙大课程")).toBe(SOURCE_ZJU);
  });

  it("保留任务身份并且只在需要时创建新数组", () => {
    const legacy = [
      { id: "pintia:1", source: "Pintia" },
      { id: "zju:1", source: "浙大课程" },
    ];
    expect(migrateTaskSourceNames(legacy)).toEqual([
      { id: "pintia:1", source: SOURCE_PTA },
      { id: "zju:1", source: SOURCE_ZJU },
    ]);
    const current = [{ id: "manual", source: "手动" }];
    expect(migrateTaskSourceNames(current)).toBe(current);
  });
});
