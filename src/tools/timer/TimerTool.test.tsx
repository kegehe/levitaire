import { beforeEach, describe, expect, it } from "vitest";

describe("world clock preferences", () => {
  beforeEach(() => localStorage.clear());

  it("uses bounded defaults when no preference is stored", () => {
    expect(localStorage.getItem("levitaire-world-clocks")).toBeNull();
  });

  it("can persist a selected timezone list", () => {
    const zones = ["Asia/Shanghai", "Europe/London", "America/New_York"];
    localStorage.setItem("levitaire-world-clocks", JSON.stringify(zones));
    expect(JSON.parse(localStorage.getItem("levitaire-world-clocks") ?? "[]")).toEqual(zones);
  });

  it("formats a timezone without relying on the local timezone", () => {
    const value = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date("2026-01-01T00:00:00Z"));
    expect(value).toMatch(/^08:00/);
  });
});
