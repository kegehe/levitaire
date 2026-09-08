import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockListeners, emitMockEvent } from "../test/tauri-mock";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  normalizeThemePreferences,
  resolveThemeMode,
  subscribeSystemTheme,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 可触发 change 事件的可控 matchMedia 桩，用于模拟操作系统深浅色切换。 */
function stubMatchMedia(matches: boolean) {
  let current = matches;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    get matches() {
      return current;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((_type: string, listener: (event: { matches: boolean }) => void) =>
      listeners.add(listener),
    ),
    removeEventListener: vi.fn((_type: string, listener: (event: { matches: boolean }) => void) =>
      listeners.delete(listener),
    ),
    addListener: vi.fn((listener: (event: { matches: boolean }) => void) =>
      listeners.add(listener),
    ),
    removeListener: vi.fn((listener: (event: { matches: boolean }) => void) =>
      listeners.delete(listener),
    ),
    trigger: () => {
      current = !current;
      listeners.forEach((listener) => listener({ matches: current }));
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return query;
}

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

  it("normalizes and preserves the 'system' theme mode", () => {
    expect(normalizeThemePreferences({ theme: "system" as ThemePreferences["theme"] })).toEqual({
      theme: "system",
      accent: "blue",
      scheme: "cloud",
    });
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("dark")).toBe("dark");
  });

  it("resolves 'system' to the current OS preference when applying", () => {
    stubMatchMedia(true);
    applyThemePreferences({ theme: "system", accent: "teal", scheme: "moss" });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themeScheme).toBe("moss");
    // localStorage 仍保存用户选择的「跟随系统」，而不是解析后的具体模式
    expect(getStoredThemePreferences().theme).toBe("system");
  });

  it("keeps applying the resolved theme while the OS preference is 'system'", () => {
    const query = stubMatchMedia(false);
    applyThemePreferences({ theme: "system", accent: "blue", scheme: "cloud" });
    expect(document.documentElement.dataset.theme).toBe("light");

    const unlisten = subscribeSystemTheme();
    try {
      query.trigger();
      expect(document.documentElement.dataset.theme).toBe("dark");

      // 显式选择浅色后，系统偏好变化不应再影响外观
      applyThemePreferences({ theme: "light", accent: "blue", scheme: "cloud" });
      query.trigger();
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      unlisten();
    }
  });

  it("re-applies the stored theme when the system theme flips while subscribed", () => {
    const query = stubMatchMedia(false);
    applyThemePreferences({ theme: "system", accent: "blue", scheme: "cloud" });
    const onChange = vi.fn();
    const unlisten = subscribeSystemTheme(onChange);
    try {
      query.trigger();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({
        theme: "system",
        accent: "blue",
        scheme: "cloud",
      });
    } finally {
      unlisten();
    }
    query.trigger();
    // 取消订阅后不再触发
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
