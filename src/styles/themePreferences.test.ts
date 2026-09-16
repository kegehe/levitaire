import { invoke } from "@tauri-apps/api/core";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
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
    // 图表色板不再跟随强调色（`--color-chart-*` 只由 tokens.css 声明）
    expect(document.documentElement.style.getPropertyValue("--color-chart-cpu")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--color-chart-mem")).toBe("");
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
    // 任何强调色 × 明暗主题下，图表色板都不许被写成强调色 ——
    // 否则监控窗里 cpu/net 或 mem/disk 会重新撞色（青、苔绿系强调色还会与磁盘的青撞）。
    for (const slot of ["cpu", "mem", "net", "disk", "gpu"]) {
      expect(
        document.documentElement.style.getPropertyValue(`--color-chart-${slot}`),
        `--color-chart-${slot} 被 ${accent.id}/${theme} 改写了`,
      ).toBe("");
    }
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

/**
 * 源码级 + 行为级守卫：`index.html` 的首帧主题预置脚本。
 *
 * 那是 React 挂载前唯一生效的主题来源。CSS 只有 `[data-theme="dark"]` 一档覆盖，
 * 所以脚本必须把 localStorage 里的 `system` **先解析成 light/dark** 再写进去：
 * 直接写原值会落回 :root 的浅色默认值 —— 选「跟随系统」且系统为深色时首帧闪一下浅色，
 * 而这类首帧问题在测试里和日常浅色环境下都看不见。
 *
 * 这里把 index.html 里的那段脚本**原样取出来执行**（而不是断言字符串），
 * 改坏了就会在下面的断言里直接失败。
 */
describe("index.html 首帧主题脚本", () => {
  const html = readFileSync(fileURLToPath(new NodeURL("../../index.html", import.meta.url)), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

  /** 只保留三段主题脚本所需的能力：localStorage + matchMedia */
  function runFirstPaintScript(options: { stored?: string | null; systemDark: boolean }) {
    if (options.stored === null || options.stored === undefined) {
      localStorage.removeItem("levitaire-theme");
    } else {
      localStorage.setItem("levitaire-theme", options.stored);
    }
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: options.systemDark && query.includes("prefers-color-scheme: dark"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    document.documentElement.removeAttribute("data-theme");
    // 执行的就是 index.html 里的那段首帧脚本（原样取出，不做改写）
    new Function(script)();
    return document.documentElement.getAttribute("data-theme");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("脚本确实取到了（避免下面是空跑）", () => {
    expect(script).toContain("data-theme");
  });

  it("跟随系统 + 系统深色 → 首帧就是 dark", () => {
    expect(runFirstPaintScript({ stored: "system", systemDark: true })).toBe("dark");
  });

  it("跟随系统 + 系统浅色 → light", () => {
    expect(runFirstPaintScript({ stored: "system", systemDark: false })).toBe("light");
  });

  it("显式 dark / light 不受系统设置影响", () => {
    expect(runFirstPaintScript({ stored: "dark", systemDark: false })).toBe("dark");
    expect(runFirstPaintScript({ stored: "light", systemDark: true })).toBe("light");
  });

  it("没存过主题时按 light 起步（跟随系统由设置页显式选择才生效）", () => {
    expect(runFirstPaintScript({ stored: null, systemDark: true })).toBe("light");
  });

  it("localStorage 不可用时退回 light，且不抛错", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.documentElement.removeAttribute("data-theme");
    expect(() => new Function(script)()).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
