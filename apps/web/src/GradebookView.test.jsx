import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradebookView } from "./GradebookView.jsx";

const records = [
  {
    id: "grade:PTA:exam",
    sourceName: "PTA",
    sourceId: "exam",
    courseName: "数据结构基础",
    title: "课程期末考试试卷",
    status: "published",
    score: 73,
    maxScore: 100,
    rank: 505,
    rankingTotal: 935,
    deadlineAt: "2026-06-30T07:56:20.000Z",
  },
  {
    id: "grade:学在浙大:hidden",
    sourceName: "学在浙大",
    sourceId: "hidden",
    courseName: "大学物理（乙）",
    title: "第3章作业",
    status: "unpublished",
    score: null,
    maxScore: null,
    deadlineAt: "2026-03-13T13:11:00.000Z",
  },
  {
    id: "grade:学在浙大:missed",
    sourceName: "学在浙大",
    sourceId: "missed",
    courseName: "信息安全课程综合实践",
    title: "补交通道",
    status: "missed",
    score: null,
    maxScore: null,
    deadlineAt: "2026-07-01T00:00:00.000Z",
  },
];

afterEach(cleanup);

describe("GradebookView", () => {
  it("separates published, unpublished, and missed outcomes", () => {
    render(<GradebookView records={records} />);
    expect(screen.getByText("73.0%")).toBeTruthy();
    expect(screen.getByText("73 / 100 分")).toBeTruthy();
    expect(screen.getByText("课程期末考试试卷")).toBeTruthy();
    expect(screen.getByText("第3章作业")).toBeTruthy();
    expect(screen.getByText("补交通道")).toBeTruthy();
    expect(screen.getAllByText("错过 DDL").length).toBeGreaterThan(0);
  });

  it("filters by source and status without mutating the ledger", () => {
    render(<GradebookView records={records} />);
    fireEvent.change(screen.getByLabelText("成绩来源"), {
      target: { value: "学在浙大" },
    });
    fireEvent.change(screen.getByLabelText("成绩状态"), {
      target: { value: "unpublished" },
    });
    const ledger = screen.getByRole("table", { name: "成绩记录" });
    expect(within(ledger).getByText("第3章作业")).toBeTruthy();
    expect(within(ledger).queryByText("补交通道")).toBeNull();
    expect(within(ledger).queryByText("课程期末考试试卷")).toBeNull();
  });

  it("uses a directional empty state before the first sync", () => {
    render(<GradebookView records={[]} />);
    expect(screen.getByText("还没有成绩记录")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新成绩" })).toBeTruthy();
  });

  it("keeps the viewing range separate from the persisted sync scope", () => {
    const onSyncSettingsChange = vi.fn();
    const onSync = vi.fn();
    render(
      <GradebookView
        records={records}
        syncSettings={{
          sinceDate: "2026-02-01",
          maxItems: 100,
          includePta: true,
          zjuCourseIds: [],
        }}
        onSyncSettingsChange={onSyncSettingsChange}
        onSync={onSync}
      />,
    );

    expect(screen.getByText(/PTA · 学在浙大未选课/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("成绩更新起始日期"), {
      target: { value: "2026-03-01" },
    });
    expect(onSyncSettingsChange).toHaveBeenCalledWith({
      sinceDate: "2026-03-01",
      maxItems: 100,
      includePta: true,
      zjuCourseIds: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "更新成绩" }));
    expect(onSync).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("成绩查看起始日期"), {
      target: { value: "2026-07-01" },
    });
    expect(screen.getByText("补交通道")).toBeTruthy();
    expect(screen.queryByText("课程期末考试试卷")).toBeNull();
  });

  it("shows PTA and 学在浙大 course subdirectory for grade refresh", () => {
    const onSyncSettingsChange = vi.fn();
    const onLoadZjuCourses = vi.fn();
    render(
      <GradebookView
        records={records}
        syncSettings={{
          sinceDate: "",
          maxItems: 100,
          includePta: true,
          zjuCourseIds: [],
        }}
        onSyncSettingsChange={onSyncSettingsChange}
        onLoadZjuCourses={onLoadZjuCourses}
        zjuCourses={[
          {
            courseId: "95870",
            courseTitle: "大学物理（乙）I",
            courseUrl: "https://courses.zju.edu.cn/course/95870/content",
            semester: "2025-2026春夏",
          },
          {
            courseId: "95623",
            courseTitle: "计算机系统 I",
            courseUrl: "https://courses.zju.edu.cn/course/95623/content",
            semester: "2025-2026春夏",
          },
          {
            courseId: "90001",
            courseTitle: "微积分（甲）I",
            courseUrl: "https://courses.zju.edu.cn/course/90001/content",
            semester: "2025-2026秋冬",
          },
        ]}
      />,
    );

    expect(screen.getByLabelText("更新 PTA 成绩")).toBeTruthy();
    expect(screen.getByLabelText("学在浙大课程列表")).toBeTruthy();
    expect(screen.getByLabelText("学在浙大学期")).toBeTruthy();
    expect(screen.getByText("学期 / 课程")).toBeTruthy();
    // Header shortcut + in-tree button both trigger the same automation.
    const loadButtons = screen.getAllByRole("button", { name: "读取课程列表" });
    expect(loadButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(loadButtons[0]);
    expect(onLoadZjuCourses).toHaveBeenCalledTimes(1);
    // Default semester is newest (春夏); 微积分 is autumn-only.
    expect(screen.getByLabelText("选择课程 大学物理（乙）I")).toBeTruthy();
    expect(screen.queryByLabelText("选择课程 微积分（甲）I")).toBeNull();
    fireEvent.click(screen.getByLabelText("选择课程 大学物理（乙）I"));
    expect(onSyncSettingsChange).toHaveBeenCalledWith({
      sinceDate: "",
      maxItems: 100,
      includePta: true,
      zjuCourseIds: ["95870"],
    });
  });
});
