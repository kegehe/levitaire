import { describe, expect, it } from "vitest";
import { buildDayNotes, getDayNote } from "./festivals";

describe("festivals 节日与节气标注", () => {
  it("识别农历传统节日与除夕", () => {
    expect(getDayNote(new Date(2025, 0, 29))).toEqual({ text: "春节", kind: "festival" });
    expect(getDayNote(new Date(2024, 5, 10))).toEqual({ text: "端午节", kind: "festival" });
    expect(getDayNote(new Date(2025, 9, 6))).toEqual({ text: "中秋节", kind: "festival" });
    expect(getDayNote(new Date(2024, 1, 9))).toEqual({ text: "除夕", kind: "festival" });
  });

  it("识别公历节日与母亲节/父亲节", () => {
    expect(getDayNote(new Date(2024, 4, 1))).toEqual({ text: "劳动节", kind: "festival" });
    expect(getDayNote(new Date(2024, 9, 1))).toEqual({ text: "国庆节", kind: "festival" });
    expect(getDayNote(new Date(2024, 4, 12))).toEqual({ text: "母亲节", kind: "festival" });
    expect(getDayNote(new Date(2024, 5, 16))).toEqual({ text: "父亲节", kind: "festival" });
  });

  it("清明作为节日展示，其余节气为节气标注", () => {
    expect(getDayNote(new Date(2024, 3, 4))).toEqual({ text: "清明", kind: "festival" });
    expect(getDayNote(new Date(2025, 1, 3))).toEqual({ text: "立春", kind: "term" });
    expect(getDayNote(new Date(2024, 11, 21))).toEqual({ text: "冬至", kind: "term" });
  });

  it("无标注的普通日期返回 null", () => {
    expect(getDayNote(new Date(2024, 5, 15))).toBeNull();
  });

  it("buildDayNotes 按日期键生成标注映射", () => {
    const notes = buildDayNotes([
      new Date(2025, 0, 5),
      new Date(2025, 0, 28),
      new Date(2025, 0, 29),
      new Date(2025, 0, 15),
    ]);
    expect(notes.get("2025-01-05")).toEqual({ text: "小寒", kind: "term" });
    expect(notes.get("2025-01-28")).toEqual({ text: "除夕", kind: "festival" });
    expect(notes.get("2025-01-29")).toEqual({ text: "春节", kind: "festival" });
    expect(notes.has("2025-01-15")).toBe(false);
  });
});
