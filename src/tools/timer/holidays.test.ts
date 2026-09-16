import { describe, expect, it } from "vitest";
import { HOLIDAYS, REST_MARK_TEXT, getRestMark } from "./holidays";

describe("holidays 休 / 班标记", () => {
  it("法定放假日返回 holiday（休）", () => {
    expect(getRestMark(new Date(2026, 0, 1))).toBe("holiday");
    expect(getRestMark(new Date(2026, 1, 17))).toBe("holiday");
    expect(getRestMark(new Date(2026, 9, 1))).toBe("holiday");
    expect(getRestMark(new Date(2025, 0, 28))).toBe("holiday");
  });

  it("调休上班日返回 workday（班）", () => {
    expect(getRestMark(new Date(2026, 0, 4))).toBe("workday");
    expect(getRestMark(new Date(2026, 1, 14))).toBe("workday");
    expect(getRestMark(new Date(2026, 9, 10))).toBe("workday");
    expect(getRestMark(new Date(2025, 0, 26))).toBe("workday");
  });

  it("普通周末不显示休，工作日无标记", () => {
    // 2026-01-10 为周六、2026-01-11 为周日，均非法定放假安排
    expect(getRestMark(new Date(2026, 0, 10))).toBeNull();
    expect(getRestMark(new Date(2026, 0, 11))).toBeNull();
    // 2026-01-08 为周四
    expect(getRestMark(new Date(2026, 0, 8))).toBeNull();
  });

  it("范围外年份不做标记", () => {
    expect(getRestMark(new Date(2022, 5, 1))).toBeNull();
    expect(getRestMark(new Date(2030, 9, 1))).toBeNull();
  });

  it("角标文字为休 / 班", () => {
    expect(REST_MARK_TEXT.holiday).toBe("休");
    expect(REST_MARK_TEXT.workday).toBe("班");
  });
});

// 数据是手工维护的，追加新年份时最容易出格式 / 重复 / 改错类型三类问题，这里逐条卡住
describe("holidays 数据完整性", () => {
  it("日期均为规范且真实存在的 YYYY-MM-DD", () => {
    for (const { date } of HOLIDAYS) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const [year, month, day] = date.split("-").map(Number);
      const parsed = new Date(year, month - 1, day);
      // 非法日期（如 2026-02-30）会被 Date 顺延到别的日子，格式化回来就对不上
      const roundTrip = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(
        parsed.getDate(),
      ).padStart(2, "0")}`;
      expect(`原始 ${date}`).toBe(`原始 ${roundTrip}`);
    }
  });

  it("同一天不重复出现", () => {
    const dates = HOLIDAYS.map((entry) => entry.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("调休上班日（班）一律落在周末", () => {
    for (const { date, type } of HOLIDAYS) {
      if (type !== "workday") continue;
      const [year, month, day] = date.split("-").map(Number);
      const weekday = new Date(year, month - 1, day).getDay();
      expect(`${date} 是周${weekday}`).toMatch(/周[06]/);
    }
  });

  it("以 2026 年为例逐日核对（含跨年假期与调休）", () => {
    // 2026 年元旦：1/1–1/3 放，1/4（周日）补班
    expect([1, 2, 3].map((d) => getRestMark(new Date(2026, 0, d)))).toEqual([
      "holiday",
      "holiday",
      "holiday",
    ]);
    expect(getRestMark(new Date(2026, 0, 4))).toBe("workday");
    // 2026 年春节：2/15–2/23 放，2/14 与 2/28 补班
    expect(getRestMark(new Date(2026, 1, 15))).toBe("holiday");
    expect(getRestMark(new Date(2026, 1, 23))).toBe("holiday");
    expect(getRestMark(new Date(2026, 1, 14))).toBe("workday");
    expect(getRestMark(new Date(2026, 1, 28))).toBe("workday");
    expect(getRestMark(new Date(2026, 1, 24))).toBeNull();
    // 2026 年国庆：10/1–10/7 放，9/20 与 10/10 补班
    expect(getRestMark(new Date(2026, 9, 7))).toBe("holiday");
    expect(getRestMark(new Date(2026, 8, 20))).toBe("workday");
    expect(getRestMark(new Date(2026, 9, 10))).toBe("workday");
    // 跨年的 2023 年元旦假期从 2022-12-31 起
    expect(getRestMark(new Date(2022, 11, 31))).toBe("holiday");
  });
});
