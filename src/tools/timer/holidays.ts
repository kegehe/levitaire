// 法定节假日「休 / 班」标记。
// 数据来源：国务院办公厅历年部分节假日安排通知，仅记录正式放假日与调休上班日：
//   2023 年 http://www.gov.cn/zhengce/zhengceku/2022-12/08/content_5730844.htm
//   2024 年 https://www.gov.cn/zhengce/zhengceku/202310/content_6911528.htm
//   2025 年 https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
//   2026 年 https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
// 年份范围外（如 2027 年起）无数据，不显示角标；新通知发布后在此追加即可。
// 普通周末不在此列，因此不会显示「休」，由调用方按需渲染角标。

export type RestMark = "holiday" | "workday";

interface HolidayEntry {
  /** 公历日期，格式 "YYYY-MM-DD" */
  date: string;
  /** holiday = 休（放假），workday = 班（调休上班） */
  type: RestMark;
}

/** 角标文字：休 / 班。 */
export const REST_MARK_TEXT: Readonly<Record<RestMark, string>> = {
  holiday: "休",
  workday: "班",
};

/** 导出仅供测试校验数据完整性（格式、去重、调休日必落在周末），业务侧请用 getRestMark。 */
export const HOLIDAYS: readonly HolidayEntry[] = [
  // ── 2023 年元旦假期（2022-12-31 起）──
  { date: "2022-12-31", type: "holiday" },
  { date: "2023-01-01", type: "holiday" },
  { date: "2023-01-02", type: "holiday" },
  { date: "2023-01-21", type: "holiday" },
  { date: "2023-01-22", type: "holiday" },
  { date: "2023-01-23", type: "holiday" },
  { date: "2023-01-24", type: "holiday" },
  { date: "2023-01-25", type: "holiday" },
  { date: "2023-01-26", type: "holiday" },
  { date: "2023-01-27", type: "holiday" },
  { date: "2023-04-05", type: "holiday" },
  { date: "2023-04-29", type: "holiday" },
  { date: "2023-04-30", type: "holiday" },
  { date: "2023-05-01", type: "holiday" },
  { date: "2023-05-02", type: "holiday" },
  { date: "2023-05-03", type: "holiday" },
  { date: "2023-06-22", type: "holiday" },
  { date: "2023-06-23", type: "holiday" },
  { date: "2023-06-24", type: "holiday" },
  { date: "2023-09-29", type: "holiday" },
  { date: "2023-09-30", type: "holiday" },
  { date: "2023-10-01", type: "holiday" },
  { date: "2023-10-02", type: "holiday" },
  { date: "2023-10-03", type: "holiday" },
  { date: "2023-10-04", type: "holiday" },
  { date: "2023-10-05", type: "holiday" },
  { date: "2023-10-06", type: "holiday" },
  { date: "2023-01-28", type: "workday" },
  { date: "2023-01-29", type: "workday" },
  { date: "2023-04-23", type: "workday" },
  { date: "2023-05-06", type: "workday" },
  { date: "2023-06-25", type: "workday" },
  { date: "2023-10-07", type: "workday" },
  { date: "2023-10-08", type: "workday" },
  // ── 2024 年 ──
  { date: "2024-01-01", type: "holiday" },
  { date: "2024-02-10", type: "holiday" },
  { date: "2024-02-11", type: "holiday" },
  { date: "2024-02-12", type: "holiday" },
  { date: "2024-02-13", type: "holiday" },
  { date: "2024-02-14", type: "holiday" },
  { date: "2024-02-15", type: "holiday" },
  { date: "2024-02-16", type: "holiday" },
  { date: "2024-02-17", type: "holiday" },
  { date: "2024-04-04", type: "holiday" },
  { date: "2024-04-05", type: "holiday" },
  { date: "2024-04-06", type: "holiday" },
  { date: "2024-05-01", type: "holiday" },
  { date: "2024-05-02", type: "holiday" },
  { date: "2024-05-03", type: "holiday" },
  { date: "2024-05-04", type: "holiday" },
  { date: "2024-05-05", type: "holiday" },
  { date: "2024-06-10", type: "holiday" },
  { date: "2024-09-15", type: "holiday" },
  { date: "2024-09-16", type: "holiday" },
  { date: "2024-09-17", type: "holiday" },
  { date: "2024-10-01", type: "holiday" },
  { date: "2024-10-02", type: "holiday" },
  { date: "2024-10-03", type: "holiday" },
  { date: "2024-10-04", type: "holiday" },
  { date: "2024-10-05", type: "holiday" },
  { date: "2024-10-06", type: "holiday" },
  { date: "2024-10-07", type: "holiday" },
  { date: "2024-02-04", type: "workday" },
  { date: "2024-02-18", type: "workday" },
  { date: "2024-04-07", type: "workday" },
  { date: "2024-04-28", type: "workday" },
  { date: "2024-05-11", type: "workday" },
  { date: "2024-09-14", type: "workday" },
  { date: "2024-09-29", type: "workday" },
  { date: "2024-10-12", type: "workday" },
  // ── 2025 年 ──
  { date: "2025-01-01", type: "holiday" },
  { date: "2025-01-28", type: "holiday" },
  { date: "2025-01-29", type: "holiday" },
  { date: "2025-01-30", type: "holiday" },
  { date: "2025-01-31", type: "holiday" },
  { date: "2025-02-01", type: "holiday" },
  { date: "2025-02-02", type: "holiday" },
  { date: "2025-02-03", type: "holiday" },
  { date: "2025-02-04", type: "holiday" },
  { date: "2025-04-04", type: "holiday" },
  { date: "2025-04-05", type: "holiday" },
  { date: "2025-04-06", type: "holiday" },
  { date: "2025-05-01", type: "holiday" },
  { date: "2025-05-02", type: "holiday" },
  { date: "2025-05-03", type: "holiday" },
  { date: "2025-05-04", type: "holiday" },
  { date: "2025-05-05", type: "holiday" },
  { date: "2025-05-31", type: "holiday" },
  { date: "2025-06-01", type: "holiday" },
  { date: "2025-06-02", type: "holiday" },
  { date: "2025-10-01", type: "holiday" },
  { date: "2025-10-02", type: "holiday" },
  { date: "2025-10-03", type: "holiday" },
  { date: "2025-10-04", type: "holiday" },
  { date: "2025-10-05", type: "holiday" },
  { date: "2025-10-06", type: "holiday" },
  { date: "2025-10-07", type: "holiday" },
  { date: "2025-10-08", type: "holiday" },
  { date: "2025-01-26", type: "workday" },
  { date: "2025-02-08", type: "workday" },
  { date: "2025-04-27", type: "workday" },
  { date: "2025-09-28", type: "workday" },
  { date: "2025-10-11", type: "workday" },
  // ── 2026 年 ──
  { date: "2026-01-01", type: "holiday" },
  { date: "2026-01-02", type: "holiday" },
  { date: "2026-01-03", type: "holiday" },
  { date: "2026-02-15", type: "holiday" },
  { date: "2026-02-16", type: "holiday" },
  { date: "2026-02-17", type: "holiday" },
  { date: "2026-02-18", type: "holiday" },
  { date: "2026-02-19", type: "holiday" },
  { date: "2026-02-20", type: "holiday" },
  { date: "2026-02-21", type: "holiday" },
  { date: "2026-02-22", type: "holiday" },
  { date: "2026-02-23", type: "holiday" },
  { date: "2026-04-04", type: "holiday" },
  { date: "2026-04-05", type: "holiday" },
  { date: "2026-04-06", type: "holiday" },
  { date: "2026-05-01", type: "holiday" },
  { date: "2026-05-02", type: "holiday" },
  { date: "2026-05-03", type: "holiday" },
  { date: "2026-05-04", type: "holiday" },
  { date: "2026-05-05", type: "holiday" },
  { date: "2026-06-19", type: "holiday" },
  { date: "2026-06-20", type: "holiday" },
  { date: "2026-06-21", type: "holiday" },
  { date: "2026-09-25", type: "holiday" },
  { date: "2026-09-26", type: "holiday" },
  { date: "2026-09-27", type: "holiday" },
  { date: "2026-10-01", type: "holiday" },
  { date: "2026-10-02", type: "holiday" },
  { date: "2026-10-03", type: "holiday" },
  { date: "2026-10-04", type: "holiday" },
  { date: "2026-10-05", type: "holiday" },
  { date: "2026-10-06", type: "holiday" },
  { date: "2026-10-07", type: "holiday" },
  { date: "2026-01-04", type: "workday" },
  { date: "2026-02-14", type: "workday" },
  { date: "2026-02-28", type: "workday" },
  { date: "2026-05-09", type: "workday" },
  { date: "2026-09-20", type: "workday" },
  { date: "2026-10-10", type: "workday" },
];

/** 日期 → 标记 的索引，避免逐格线性查找。 */
const REST_MARKS: ReadonlyMap<string, RestMark> = new Map(
  HOLIDAYS.map((entry) => [entry.date, entry.type]),
);

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * 某个日期的休 / 班标记。
 * 法定放假日返回 holiday（休），调休上班日返回 workday（班）；
 * 普通周末与工作日均返回 null，即不显示角标。
 */
export function getRestMark(date: Date): RestMark | null {
  return REST_MARKS.get(dateKey(date)) ?? null;
}
