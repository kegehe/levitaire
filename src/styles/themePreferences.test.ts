import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, emitMockEvent } from "../test/tauri-mock";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  normalizeThemePreferences,
  subscribeThemePreferences,
  THEME_ACCENTS,
  type ThemePreferences,
} from "./themePreferences";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  clearMockListeners();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("theme preferences", () => {
  it("uses safe defaults for missing or unsupported preferences", () => {
    expect(normalizeThemePreferences()).toEqual({
      theme: "light",
      accent: "blue",
      scheme: "cloud",
    });
    expect(normalizeThemePreferences({ theme: "dark", accent: "invalid" as "blue" })).toEqual({
      theme: "dark",
      accent: "blue",
      scheme: "cloud",
    });
  });

  it("applies and stores the selected style and semantic accent", () => {
    applyThemePreferences({ theme: "dark", accent: "teal", scheme: "moss" });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themeScheme).toBe("moss");
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#1d2420");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe(
      "oklch(0.73 0.11 185)",
    );
    expect(document.documentElement.style.getPropertyValue("--color-accent-fg")).toBe(
      "var(--neutral-950)",
    );
    expect(document.documentElement.style.getPropertyValue("--color-fg-on-accent")).toBe(
      "var(--neutral-950)",
    );
    expect(document.documentElement.style.getPropertyValue("--color-brand")).toBe(
      "oklch(0.73 0.11 185)",
    );
    expect(document.documentElement.style.getPropertyValue("--color-chart-cpu")).toBe(
      "oklch(0.73 0.11 185)",
    );
    expect(document.documentElement.style.getPropertyValue("--palette-card-border-enabled")).toBe(
      "oklch(0.73 0.11 185)",
    );
    expect(getStoredThemePreferences()).toEqual({ theme: "dark", accent: "teal", scheme: "moss" });
  });

  it("does not let a stale initial load overwrite a newer theme event", async () => {
    let resolveInitial!: (preferences: ThemePreferences) => void;
    const initialLoad = new Promise<ThemePreferences>((resolve) => {
      resolveInitial = resolve;
    });
    mockInvoke.mockImplementation(() => initialLoad);
    const changes: ThemePreferences[] = [];

    const subscription = subscribeThemePreferences((preferences) => changes.push(preferences));
    await Promise.resolve();
    emitMockEvent("levitaire-theme-changed", {
      theme: "dark",
      accent: "violet",
      scheme: "iris",
    });
    resolveInitial({ theme: "light", accent: "blue", scheme: "cloud" });

    const unlisten = await subscription;
    expect(changes).toEqual([{ theme: "dark", accent: "violet", scheme: "iris" }]);
    unlisten();
  });

  it.each(
    THEME_ACCENTS.flatMap((accent) =>
      (["light", "dark"] as const).map((theme) => ({ accent, theme })),
    ),
  )("applies $theme $accent.label across global brand surfaces", ({ accent, theme }) => {
    applyThemePreferences({ theme, accent: accent.id, scheme: "cloud" });

    const values = accent[theme];
    expect(document.documentElement.style.getPropertyValue("--color-brand")).toBe(values.accent);
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe(values.accent);
    expect(document.documentElement.style.getPropertyValue("--color-chart-cpu")).toBe(
      values.accent,
    );
    expect(document.documentElement.style.getPropertyValue("--color-chart-mem")).toBe(values.hover);
    expect(document.documentElement.style.getPropertyValue("--color-chart-net")).toBe(
      values.accent,
    );
    expect(document.documentElement.style.getPropertyValue("--color-chart-disk")).toBe(
      values.hover,
    );
    expect(document.documentElement.style.getPropertyValue("--palette-card-border-enabled")).toBe(
      values.accent,
    );
  });
});
