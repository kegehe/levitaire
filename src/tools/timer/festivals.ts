// 日历的节日 / 节气标注。
// 设计上：农历、节气依托 Intl 中国农历历法与天文太阳黄经计算，全部本地完成，不依赖网络与第三方库。

export type DayNoteKind = "festival" | "term";

export interface DayNote {
  text: string;
  kind: DayNoteKind;
}

/** 24 节气名与其对应的太阳黄经（度）。从「小寒」开始排列，索引 i 落在公历第 Math.floor(i/2) 月。 */
const SOLAR_TERMS: ReadonlyArray<readonly [name: string, longitude: number]> = [
  ["小寒", 285],
  ["大寒", 300],
  ["立春", 315],
  ["雨水", 330],
  ["惊蛰", 345],
  ["春分", 0],
  ["清明", 15],
  ["谷雨", 30],
  ["立夏", 45],
  ["小满", 60],
  ["芒种", 75],
  ["夏至", 90],
  ["小暑", 105],
  ["大暑", 120],
  ["立秋", 135],
  ["处暑", 150],
  ["白露", 165],
  ["秋分", 180],
  ["寒露", 195],
  ["霜降", 210],
  ["立冬", 225],
  ["小雪", 240],
  ["大雪", 255],
  ["冬至", 270],
];

/** 农历传统节日（键为农历月名，值为该月第几日 → 节日名）。 */
const LUNAR_FESTIVALS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  正月: { 1: "春节", 15: "元宵节" },
  二月: { 2: "龙抬头" },
  五月: { 5: "端午节" },
  七月: { 7: "七夕", 15: "中元节" },
  八月: { 15: "中秋节" },
  九月: { 9: "重阳节" },
  腊月: { 8: "腊八节", 23: "小年" },
};

/** 公历固定节日（键为月份，值为该月第几日 → 节日名）。 */
const SOLAR_FESTIVALS: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  1: { 1: "元旦" },
  2: { 14: "情人节" },
  3: { 8: "妇女节", 12: "植树节" },
  4: { 1: "愚人节" },
  5: { 1: "劳动节", 4: "青年节" },
  6: { 1: "儿童节" },
  7: { 1: "建党节" },
  8: { 1: "建军节" },
  9: { 10: "教师节" },
  10: { 1: "国庆节" },
  12: { 24: "平安夜", 25: "圣诞节" },
};

const DEG = Math.PI / 180;

/** 公历转儒略日（返回当日 0h UT 的 JD）。 */
function julianDayFromDate(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const century = Math.floor(y / 100);
  const offset = 2 - century + Math.floor(century / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + offset - 1524.5;
}

/** 太阳视黄经（度），低精度天文公式，误差约 0.01°，足以判定节气所在日期。 */
function sunApparentLongitude(jd: number): number {
  const t = (jd - 2451545) / 36525;
  const meanLongitude = (280.46646 + 36000.76983 * t + 0.0003032 * t * t) % 360;
  const meanAnomaly = 357.52911 + 35999.05029 * t - 0.0001537 * t * t;
  const anomalyRad = meanAnomaly * DEG;
  const equationOfCenter =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(anomalyRad) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * anomalyRad) +
    0.000289 * Math.sin(3 * anomalyRad);
  const trueLongitude = meanLongitude + equationOfCenter;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  return ((apparentLongitude % 360) + 360) % 360;
}

/** 某日 0 点（东八区）太阳黄经相对目标黄经的相位差。交节前 > 180°，交节后 < 180°。 */
function termPhaseOffset(year: number, month: number, day: number, longitude: number): number {
  // 当地 0 点 = 前一日 16:00 UTC
  const jd = julianDayFromDate(year, month, day) - 8 / 24;
  return (((sunApparentLongitude(jd) - longitude) % 360) + 360) % 360;
}

/** 某公历月内两个节气各自的名称与日期（东八区）。 */
function solarTermsOfMonth(year: number, monthIndex: number): Array<{ name: string; day: number }> {
  const month = monthIndex + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const result: Array<{ name: string; day: number }> = [];
  for (let i = monthIndex * 2; i <= monthIndex * 2 + 1; i += 1) {
    const [name, longitude] = SOLAR_TERMS[i];
    let termDay = 1;
    for (let day = 1; day <= daysInMonth; day += 1) {
      if (termPhaseOffset(year, month, day, longitude) > 180) termDay = day;
    }
    result.push({ name, day: termDay });
  }
  return result;
}

/** 某日落在哪个节气（返回节气名，非节气返回 null）。清明作为法定节假日，由调用方提升为节日。 */
function solarTermNameOn(date: Date): string | null {
  const year = date.getFullYear();
  const monthIndex = date.getMonth();
  const day = date.getDate();
  const terms = solarTermsOfMonth(year, monthIndex);
  return terms.find((term) => term.day === day)?.name ?? null;
}

function parseLunarMonthDay(date: Date): { month: string; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      month: "long",
      day: "numeric",
    }).formatToParts(date);
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if (!month || day < 1 || day > 30) return null;
    return { month, day };
  } catch {
    return null;
  }
}

/** 农历节日（含通过“次日为正月初一”判定的除夕）。闰月不重复过节，故跳过。 */
function lunarFestivalText(date: Date): string | null {
  const lunar = parseLunarMonthDay(date);
  if (!lunar || lunar.month.startsWith("闰")) return null;
  if (lunar.month === "腊月") {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    const nextLunar = parseLunarMonthDay(next);
    if (nextLunar?.month === "正月" && nextLunar.day === 1) return "除夕";
  }
  return LUNAR_FESTIVALS[lunar.month]?.[lunar.day] ?? null;
}

/** 母亲节（5 月第二个周日）与父亲节（6 月第三个周日）。 */
function nthWeekdayFestivalText(date: Date): string | null {
  const dayOfWeek = date.getDay();
  if (dayOfWeek !== 0) return null;
  const monthIndex = date.getMonth();
  const weekIndex = Math.ceil(date.getDate() / 7);
  if (monthIndex === 4 && weekIndex === 2) return "母亲节";
  if (monthIndex === 5 && weekIndex === 3) return "父亲节";
  return null;
}

function keyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * 单个日期上的标注：节日优先，其次节气。
 * 清明既是节气也是法定节假日，统一作为节日标红展示。
 */
export function getDayNote(date: Date): DayNote | null {
  const festival =
    lunarFestivalText(date) ??
    SOLAR_FESTIVALS[date.getMonth() + 1]?.[date.getDate()] ??
    nthWeekdayFestivalText(date);
  if (festival) return { text: festival, kind: "festival" };
  const term = solarTermNameOn(date);
  return term ? { text: term, kind: term === "清明" ? "festival" : "term" } : null;
}

/** 为一批日期（通常是某个月的 42 格）批量生成标注，按日期键 "YYYY-MM-DD" 索引。 */
export function buildDayNotes(dates: readonly Date[]): Map<string, DayNote> {
  const notes = new Map<string, DayNote>();
  for (const date of dates) {
    const note = getDayNote(date);
    if (note) notes.set(keyOf(date), note);
  }
  return notes;
}
