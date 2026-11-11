import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAccentId = "blue" | "cyan" | "teal" | "green" | "indigo" | "violet";
export type ThemeSchemeId =
  "signal" | "cloud" | "studio" | "quartz" | "moss" | "ember" | "arctic" | "mono" | "iris" | "dusk";

export interface ThemePreferences {
  theme: ThemeMode;
  accent: ThemeAccentId;
  scheme: ThemeSchemeId;
}

interface AccentValues {
  accent: string;
  hover: string;
  active: string;
  subtle: string;
  focusShadow: string;
  swatch: string;
}

export interface ThemeAccent {
  id: ThemeAccentId;
  label: string;
  swatch: string;
  light: AccentValues;
  dark: AccentValues;
}

interface SchemeValues {
  bg: string;
  elevated: string;
  sunken: string;
  fg: string;
  muted: string;
  subtle: string;
  border: string;
  borderHover: string;
  borderStrong: string;
  radius: string;
  shadow: string;
}

export interface ThemeScheme {
  id: ThemeSchemeId;
  label: string;
  light: SchemeValues;
  dark: SchemeValues;
}

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  theme: "light",
  accent: "blue",
  scheme: "cloud",
};

export const THEME_ACCENTS: readonly ThemeAccent[] = [
  {
    id: "blue",
    label: "蓝色",
    swatch: "#2474d7",
    light: {
      accent: "oklch(0.5 0.19 250)",
      hover: "oklch(0.43 0.17 250)",
      active: "oklch(0.93 0.03 250)",
      subtle: "oklch(0.93 0.06 250)",
      focusShadow: "oklch(0.5 0.19 250 / 0.15)",
      swatch: "#2474d7",
    },
    dark: {
      accent: "oklch(0.68 0.15 250)",
      hover: "oklch(0.78 0.1 250)",
      active: "oklch(0.28 0.1 250)",
      subtle: "oklch(0.26 0.1 250)",
      focusShadow: "oklch(0.58 0.19 250 / 0.15)",
      swatch: "#70a8ef",
    },
  },
  {
    id: "cyan",
    label: "青色",
    swatch: "#0787a6",
    light: {
      accent: "oklch(0.53 0.13 215)",
      hover: "oklch(0.45 0.12 215)",
      active: "oklch(0.92 0.04 215)",
      subtle: "oklch(0.93 0.06 215)",
      focusShadow: "oklch(0.53 0.13 215 / 0.16)",
      swatch: "#0787a6",
    },
    dark: {
      accent: "oklch(0.74 0.12 215)",
      hover: "oklch(0.84 0.08 215)",
      active: "oklch(0.3 0.08 215)",
      subtle: "oklch(0.26 0.08 215)",
      focusShadow: "oklch(0.74 0.12 215 / 0.18)",
      swatch: "#72d3e5",
    },
  },
  {
    id: "teal",
    label: "蓝绿",
    swatch: "#0a7f75",
    light: {
      accent: "oklch(0.5 0.11 185)",
      hover: "oklch(0.42 0.1 185)",
      active: "oklch(0.91 0.04 185)",
      subtle: "oklch(0.93 0.05 185)",
      focusShadow: "oklch(0.5 0.11 185 / 0.16)",
      swatch: "#0a7f75",
    },
    dark: {
      accent: "oklch(0.73 0.11 185)",
      hover: "oklch(0.83 0.07 185)",
      active: "oklch(0.29 0.07 185)",
      subtle: "oklch(0.26 0.07 185)",
      focusShadow: "oklch(0.73 0.11 185 / 0.18)",
      swatch: "#70d4ca",
    },
  },
  {
    id: "green",
    label: "绿色",
    swatch: "#218752",
    light: {
      accent: "oklch(0.5 0.13 150)",
      hover: "oklch(0.42 0.11 150)",
      active: "oklch(0.91 0.05 150)",
      subtle: "oklch(0.93 0.07 150)",
      focusShadow: "oklch(0.5 0.13 150 / 0.16)",
      swatch: "#218752",
    },
    dark: {
      accent: "oklch(0.72 0.12 150)",
      hover: "oklch(0.82 0.08 150)",
      active: "oklch(0.29 0.07 150)",
      subtle: "oklch(0.26 0.07 150)",
      focusShadow: "oklch(0.72 0.12 150 / 0.18)",
      swatch: "#70d493",
    },
  },
  {
    id: "indigo",
    label: "靛蓝",
    swatch: "#5262bf",
    light: {
      accent: "oklch(0.5 0.15 275)",
      hover: "oklch(0.42 0.13 275)",
      active: "oklch(0.92 0.04 275)",
      subtle: "oklch(0.93 0.06 275)",
      focusShadow: "oklch(0.5 0.15 275 / 0.16)",
      swatch: "#5262bf",
    },
    dark: {
      accent: "oklch(0.72 0.13 275)",
      hover: "oklch(0.82 0.08 275)",
      active: "oklch(0.29 0.08 275)",
      subtle: "oklch(0.26 0.08 275)",
      focusShadow: "oklch(0.72 0.13 275 / 0.18)",
      swatch: "#a2adf6",
    },
  },
  {
    id: "violet",
    label: "紫罗兰",
    swatch: "#7b58bd",
    light: {
      accent: "oklch(0.5 0.16 305)",
      hover: "oklch(0.42 0.14 305)",
      active: "oklch(0.92 0.05 305)",
      subtle: "oklch(0.93 0.07 305)",
      focusShadow: "oklch(0.5 0.16 305 / 0.16)",
      swatch: "#7b58bd",
    },
    dark: {
      accent: "oklch(0.72 0.14 305)",
      hover: "oklch(0.82 0.09 305)",
      active: "oklch(0.29 0.08 305)",
      subtle: "oklch(0.26 0.08 305)",
      focusShadow: "oklch(0.72 0.14 305 / 0.18)",
      swatch: "#b99bf0",
    },
  },
];

export const THEME_SCHEMES: readonly ThemeScheme[] = [
  {
    id: "signal",
    label: "信号",
    light: {
      bg: "#f7f9fa",
      elevated: "#ffffff",
      sunken: "#edf1f3",
      fg: "#172129",
      muted: "#5c6973",
      subtle: "#82909a",
      border: "#d8e0e4",
      borderHover: "#b9c6cd",
      borderStrong: "#98a8b2",
      radius: "14px",
      shadow: "0 18px 42px rgb(31 48 58 / .14)",
    },
    dark: {
      bg: "#1b1c1e",
      elevated: "#24262a",
      sunken: "#191a1c",
      fg: "#f1f4f7",
      muted: "#a9b0b8",
      subtle: "#747d87",
      border: "#3a3e44",
      borderHover: "#535a62",
      borderStrong: "#69717b",
      radius: "14px",
      shadow: "0 18px 42px rgb(0 0 0 / .38)",
    },
  },
  {
    id: "cloud",
    label: "云端",
    light: {
      bg: "#f9fbff",
      elevated: "#ffffff",
      sunken: "#f1f5f9",
      fg: "#172033",
      muted: "#5e6b81",
      subtle: "#8793a8",
      border: "#d9e1ed",
      borderHover: "#bdc9da",
      borderStrong: "#9eacc1",
      radius: "10px",
      shadow: "0 14px 34px rgb(44 62 89 / .13)",
    },
    dark: {
      bg: "#1e2430",
      elevated: "#262e3c",
      sunken: "#191e28",
      fg: "#eef3ff",
      muted: "#acb8cc",
      subtle: "#7d8aa0",
      border: "#3a465a",
      borderHover: "#55657d",
      borderStrong: "#71819a",
      radius: "10px",
      shadow: "0 18px 42px rgb(0 0 0 / .35)",
    },
  },
  {
    id: "studio",
    label: "工作室",
    light: {
      bg: "#f8faf8",
      elevated: "#ffffff",
      sunken: "#edf1ee",
      fg: "#16211d",
      muted: "#5f6c67",
      subtle: "#87918d",
      border: "#d5dcd8",
      borderHover: "#b8c4bd",
      borderStrong: "#9ca9a2",
      radius: "8px",
      shadow: "0 12px 28px rgb(30 47 39 / .13)",
    },
    dark: {
      bg: "#181a1a",
      elevated: "#202323",
      sunken: "#141515",
      fg: "#f3f6f4",
      muted: "#abb4b0",
      subtle: "#747d79",
      border: "#373d3a",
      borderHover: "#57605b",
      borderStrong: "#717a75",
      radius: "8px",
      shadow: "0 12px 28px rgb(0 0 0 / .4)",
    },
  },
  {
    id: "quartz",
    label: "石英",
    light: {
      bg: "#fafbfc",
      elevated: "#ffffff",
      sunken: "#eef1f5",
      fg: "#202833",
      muted: "#687482",
      subtle: "#929ba6",
      border: "#d9dfe6",
      borderHover: "#b9c3cf",
      borderStrong: "#9faab8",
      radius: "12px",
      shadow: "0 10px 26px rgb(41 53 68 / .12)",
    },
    dark: {
      bg: "#21252c",
      elevated: "#2a2f38",
      sunken: "#1c2026",
      fg: "#f1f4f8",
      muted: "#b2bac5",
      subtle: "#7e8998",
      border: "#414957",
      borderHover: "#5a677a",
      borderStrong: "#718095",
      radius: "12px",
      shadow: "0 16px 38px rgb(0 0 0 / .36)",
    },
  },
  {
    id: "moss",
    label: "苔藓",
    light: {
      bg: "#f9fbf8",
      elevated: "#ffffff",
      sunken: "#edf2ed",
      fg: "#1c2921",
      muted: "#637267",
      subtle: "#89958c",
      border: "#d3dfd5",
      borderHover: "#b5c6b8",
      borderStrong: "#96aa9b",
      radius: "12px",
      shadow: "0 11px 27px rgb(40 58 44 / .12)",
    },
    dark: {
      bg: "#1d2420",
      elevated: "#26302a",
      sunken: "#19201c",
      fg: "#eef5ef",
      muted: "#b0bdb2",
      subtle: "#7b897e",
      border: "#3e4d43",
      borderHover: "#5a6d60",
      borderStrong: "#728076",
      radius: "12px",
      shadow: "0 16px 38px rgb(0 0 0 / .38)",
    },
  },
  {
    id: "ember",
    label: "余烬",
    light: {
      bg: "#fcfaf9",
      elevated: "#ffffff",
      sunken: "#f4efed",
      fg: "#2b2422",
      muted: "#756762",
      subtle: "#9b8b85",
      border: "#e4d8d3",
      borderHover: "#cdbbb4",
      borderStrong: "#b49c94",
      radius: "14px",
      shadow: "0 12px 28px rgb(72 47 39 / .12)",
    },
    dark: {
      bg: "#231e1c",
      elevated: "#2d2623",
      sunken: "#1e1a18",
      fg: "#f8f1ef",
      muted: "#c3b2ac",
      subtle: "#8d7c76",
      border: "#4b3f39",
      borderHover: "#6b5850",
      borderStrong: "#836c62",
      radius: "14px",
      shadow: "0 17px 38px rgb(0 0 0 / .4)",
    },
  },
  {
    id: "arctic",
    label: "极地",
    light: {
      bg: "#f9fdfe",
      elevated: "#ffffff",
      sunken: "#eaf4f6",
      fg: "#17272c",
      muted: "#597078",
      subtle: "#81979e",
      border: "#cfdee3",
      borderHover: "#acc2c9",
      borderStrong: "#8faab2",
      radius: "7px",
      shadow: "0 9px 24px rgb(27 71 83 / .12)",
    },
    dark: {
      bg: "#172227",
      elevated: "#203037",
      sunken: "#131f23",
      fg: "#eaf7fa",
      muted: "#a9c1c7",
      subtle: "#779298",
      border: "#395159",
      borderHover: "#547078",
      borderStrong: "#6f8b93",
      radius: "7px",
      shadow: "0 15px 34px rgb(0 0 0 / .4)",
    },
  },
  {
    id: "mono",
    label: "黑白",
    light: {
      bg: "#fafaf8",
      elevated: "#ffffff",
      sunken: "#f0f0ec",
      fg: "#20211f",
      muted: "#686a65",
      subtle: "#92938d",
      border: "#dadbd4",
      borderHover: "#bfc1b8",
      borderStrong: "#a3a59d",
      radius: "4px",
      shadow: "0 8px 22px rgb(31 32 29 / .12)",
    },
    dark: {
      bg: "#1b1c1b",
      elevated: "#242524",
      sunken: "#161716",
      fg: "#f4f5ef",
      muted: "#b7b8b0",
      subtle: "#7d7f78",
      border: "#41433e",
      borderHover: "#61645d",
      borderStrong: "#7b7e75",
      radius: "4px",
      shadow: "0 13px 30px rgb(0 0 0 / .42)",
    },
  },
  {
    id: "iris",
    label: "鸢尾",
    light: {
      bg: "#fcfbfe",
      elevated: "#ffffff",
      sunken: "#f2eff7",
      fg: "#272334",
      muted: "#6f687e",
      subtle: "#958da5",
      border: "#ded8e9",
      borderHover: "#c4b9d5",
      borderStrong: "#a99bbc",
      radius: "12px",
      shadow: "0 12px 28px rgb(61 44 91 / .12)",
    },
    dark: {
      bg: "#211e2c",
      elevated: "#2a2637",
      sunken: "#1d1a27",
      fg: "#f5f1fa",
      muted: "#bdb3cc",
      subtle: "#877b99",
      border: "#463d58",
      borderHover: "#625372",
      borderStrong: "#7b6991",
      radius: "12px",
      shadow: "0 17px 38px rgb(0 0 0 / .4)",
    },
  },
  {
    id: "dusk",
    label: "黄昏",
    light: {
      bg: "#f8fbfc",
      elevated: "#ffffff",
      sunken: "#edf3f4",
      fg: "#1d2a30",
      muted: "#60727a",
      subtle: "#86959b",
      border: "#d3e0e3",
      borderHover: "#b5c6cb",
      borderStrong: "#98afb5",
      radius: "16px",
      shadow: "0 15px 34px rgb(32 64 73 / .12)",
    },
    dark: {
      bg: "#1a2529",
      elevated: "#233137",
      sunken: "#151f23",
      fg: "#eef6f6",
      muted: "#adc0c3",
      subtle: "#789095",
      border: "#3b535a",
      borderHover: "#567078",
      borderStrong: "#708b93",
      radius: "16px",
      shadow: "0 19px 42px rgb(0 0 0 / .4)",
    },
  },
];

const ACCENT_BY_ID = new Map(THEME_ACCENTS.map((accent) => [accent.id, accent]));
const SCHEME_BY_ID = new Map(THEME_SCHEMES.map((scheme) => [scheme.id, scheme]));

/** 将「跟随系统」解析为当前操作系统的实际浅色/深色偏好。 */
export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function normalizeThemePreferences(
  value?: Partial<ThemePreferences> | null,
): ThemePreferences {
  return {
    theme:
      value?.theme === "dark" || value?.theme === "system" ? (value.theme as ThemeMode) : "light",
    accent: ACCENT_BY_ID.has(value?.accent as ThemeAccentId)
      ? (value?.accent as ThemeAccentId)
      : DEFAULT_THEME_PREFERENCES.accent,
    scheme: SCHEME_BY_ID.has(value?.scheme as ThemeSchemeId)
      ? (value?.scheme as ThemeSchemeId)
      : DEFAULT_THEME_PREFERENCES.scheme,
  };
}

export function getStoredThemePreferences(): ThemePreferences {
  return normalizeThemePreferences({
    theme: (localStorage.getItem("levitaire-theme") as ThemeMode | null) ?? undefined,
    accent: (localStorage.getItem("levitaire-theme-accent") as ThemeAccentId | null) ?? undefined,
    scheme: (localStorage.getItem("levitaire-theme-scheme") as ThemeSchemeId | null) ?? undefined,
  });
}

/**
 * 首帧预置缓存：`applyThemePreferences()` 每次应用时会把亮/暗两套完整 CSS 变量
 * 写进 localStorage，`index.html` 在 React 挂载前按解析后的模式同步回放。
 * 这样自定义强调色/配色方案不会在窗口首次显示时先闪一帧默认蓝/默认方案。
 *
 * 之所以存「计算后的变量」而不是色板本身：色板只存在于本文件，
 * 首帧脚本无需再复制一份数据表，也不会因两边不同步而失效。
 * 换色板取值后旧缓存只会影响挂载前的一帧，随后即被重新应用覆盖。
 */
export const THEME_BOOT_CACHE_KEY = "levitaire-theme-boot-vars";
const THEME_BOOT_CACHE_VERSION = 1;

/** 计算指定明暗模式下需要注入的全部 CSS 变量。 */
function themeCssVariables(
  preferences: ThemePreferences,
  resolved: "light" | "dark",
): Record<string, string> {
  const values = ACCENT_BY_ID.get(preferences.accent)![resolved];
  const scheme = SCHEME_BY_ID.get(preferences.scheme)![resolved];
  const accentForeground = resolved === "dark" ? "var(--neutral-950)" : "var(--neutral-0)";
  const glass = resolved === "dark";

  return {
    "--color-bg": scheme.bg,
    "--color-bg-elevated": scheme.elevated,
    "--color-bg-overlay": glass ? "rgb(0 0 0 / .62)" : "rgb(255 255 255 / .82)",
    "--color-bg-sunken": scheme.sunken,
    "--color-fg": scheme.fg,
    "--color-fg-muted": scheme.muted,
    "--color-fg-subtle": scheme.subtle,
    "--color-border": scheme.border,
    "--color-border-hover": scheme.borderHover,
    "--color-border-strong": scheme.borderStrong,
    "--shadow-sm": scheme.shadow,
    "--shadow-md": scheme.shadow,
    "--shadow-lg": scheme.shadow,
    "--toolbar-bg": scheme.elevated,
    "--toolbar-border": scheme.border,
    "--toolbar-radius": scheme.radius,
    "--palette-bg": glass ? "rgb(22 28 37 / .94)" : "rgb(246 249 252 / .94)",
    "--palette-bg-fallback": glass ? "rgb(22 28 37)" : "rgb(244 248 250)",
    "--palette-border": glass
      ? "1px solid rgb(255 255 255 / .16)"
      : "1px solid rgb(105 122 141 / .26)",
    // 浮层面板投影。⚠️ 模糊半径/垂直偏移必须收在 ToolPalette 的窗口留白内
    // （.palette-stage 的 20px padding）：留白外的部分会被窗口边界硬切，
    // 在四个圆角缺口处留下带直角的残影。
    // 约束 = 模糊半径/2 + 垂直偏移 ≤ 20，这里各留 1px 余量（19）。
    // 该变量同时被 UtilityHub / ScrollNavigator 的面板复用。
    "--palette-shadow": glass
      ? `0 0 30px color-mix(in srgb, ${values.accent} 16%, transparent), 0 6px 24px rgb(0 0 0 / .45), inset 0 1px 0 rgb(255 255 255 / .13)`
      : `0 0 30px color-mix(in srgb, ${values.accent} 10%, transparent), 0 6px 26px rgb(31 36 45 / .2), inset 0 1px 0 rgb(255 255 255 / .95)`,
    "--palette-card-bg": glass ? "rgb(255 255 255 / .1)" : "rgb(255 255 255 / .72)",
    "--palette-card-bg-hover": glass ? "rgb(255 255 255 / .16)" : "rgb(255 255 255 / .9)",
    "--palette-card-bg-enabled": values.subtle,
    "--palette-card-border": glass ? "rgb(255 255 255 / .18)" : "rgb(105 122 141 / .28)",
    "--palette-card-border-hover": glass
      ? "rgb(255 255 255 / .24)"
      : `color-mix(in srgb, ${values.accent} 32%, transparent)`,
    "--palette-card-border-enabled": values.accent,
    "--palette-header-border": glass ? "rgb(255 255 255 / .1)" : "rgb(105 122 141 / .18)",
    "--palette-icon-bg": glass ? "rgb(255 255 255 / .12)" : "rgb(31 48 64 / .08)",
    "--palette-icon-color": scheme.muted,
    "--preview-bg": scheme.sunken,
    "--preview-border": scheme.border,
    "--settings-bg": scheme.bg,
    "--settings-section-bg": scheme.elevated,
    "--settings-heading-color": scheme.fg,
    "--settings-subheading-color": scheme.muted,
    "--settings-border": scheme.border,
    "--settings-input-bg": scheme.elevated,
    "--settings-sidebar-bg": scheme.elevated,
    "--settings-sidebar-border": scheme.border,
    "--button-hover-bg": scheme.sunken,
    "--button-active-bg": scheme.border,
    "--button-ghost-hover-bg": scheme.sunken,
    "--button-ghost-active-bg": scheme.border,
    "--tooltip-bg": glass ? "#f0f2f4" : "#24272b",
    "--tooltip-text": glass ? "#1d2228" : "#ffffff",
    "--tooltip-border": glass ? "#c8d0d6" : "#454b52",
    "--radius-md": scheme.radius,
    "--color-brand": values.accent,
    "--color-brand-hover": values.hover,
    "--color-brand-active": values.active,
    "--color-brand-subtle": values.subtle,
    "--color-brand-fg": accentForeground,
    "--color-accent": values.accent,
    "--color-accent-hover": values.hover,
    "--color-accent-subtle": values.subtle,
    "--color-accent-fg": accentForeground,
    "--color-fg-on-accent": accentForeground,
    "--color-focus-ring": values.accent,
    "--button-primary-text": values.accent,
    "--button-primary-hover-bg": values.subtle,
    "--button-primary-active-bg": values.active,
    "--settings-focus-border": values.accent,
    "--settings-focus-shadow": values.focusShadow,
    "--settings-save-btn-bg": values.accent,
    "--settings-nav-active-bg": values.subtle,
    "--settings-nav-active-color": values.accent,
    "--settings-nav-active-border": values.accent,
    // ⚠️ 有意**不**给 --color-chart-* 注入强调色。
    // 这里原来把 cpu/net 一起写成 accent、mem/disk 一起写成 hover，于是监控窗 5 条折线
    // 永远只有 2 种颜色（并且换强调色也还是 2 种）；图表是**分类色板**，必须五色互相可区分
    // 且与 UI 装饰色解耦，故只由 tokens.css 按明暗主题声明。守卫：themePreferences.test.ts
    // 「强调色不改写图表色板」。
  };
}

/** 写入首帧缓存。localStorage 不可用（隐私模式/配额）时静默跳过。 */
function writeThemeBootCache(preferences: ThemePreferences) {
  try {
    localStorage.setItem(
      THEME_BOOT_CACHE_KEY,
      JSON.stringify({
        v: THEME_BOOT_CACHE_VERSION,
        light: themeCssVariables(preferences, "light"),
        dark: themeCssVariables(preferences, "dark"),
      }),
    );
  } catch {
    // 首帧会退回 tokens.css 的默认主题，不影响正常渲染
  }
}

export function applyThemePreferences(preferences: ThemePreferences): ThemePreferences {
  const normalized = normalizeThemePreferences(preferences);
  const resolved = resolveThemeMode(normalized.theme);
  const root = document.documentElement;

  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-theme-scheme", normalized.scheme);
  for (const [name, value] of Object.entries(themeCssVariables(normalized, resolved))) {
    root.style.setProperty(name, value);
  }

  localStorage.setItem("levitaire-theme", normalized.theme);
  localStorage.setItem("levitaire-theme-accent", normalized.accent);
  localStorage.setItem("levitaire-theme-scheme", normalized.scheme);
  writeThemeBootCache(normalized);
  return normalized;
}

/** Accept the legacy string event payload while older windows are still running. */
export function applyThemeChange(payload: Partial<ThemePreferences> | ThemeMode): ThemePreferences {
  if (typeof payload === "string") {
    return applyThemePreferences({ ...getStoredThemePreferences(), theme: payload });
  }
  return applyThemePreferences(normalizeThemePreferences(payload));
}

export async function loadThemePreferences(): Promise<ThemePreferences> {
  try {
    return normalizeThemePreferences(await invoke<ThemePreferences>("get_theme_preferences"));
  } catch {
    return getStoredThemePreferences();
  }
}

/**
 * 监听操作系统浅色/深色切换。仅在用户选择了「跟随系统」时重放最近一次主题，
 * 使所有 webview 能随系统偏好实时切换外观。
 */
export function subscribeSystemTheme(
  onChange: (preferences: ThemePreferences) => void = applyThemePreferences,
): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => {
    if (getStoredThemePreferences().theme === "system") {
      onChange(getStoredThemePreferences());
    }
  };
  if (
    typeof query.addEventListener === "function" &&
    typeof query.removeEventListener === "function"
  ) {
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }
  // 旧版 WebView 兼容路径（WebKit 旧实现使用 addListener）
  if (typeof query.addListener === "function" && typeof query.removeListener === "function") {
    query.addListener(handleChange);
    return () => query.removeListener(handleChange);
  }
  return () => {};
}

/**
 * Subscribe before loading the persisted value so a newly opened webview cannot miss a change
 * emitted while it is mounting.
 */
export async function subscribeThemePreferences(
  onChange: (preferences: ThemePreferences) => void = applyThemePreferences,
): Promise<UnlistenFn> {
  let receivedEvent = false;
  const unlisten = await listen<Partial<ThemePreferences> | ThemeMode>(
    "levitaire-theme-changed",
    (event) => {
      receivedEvent = true;
      const preferences =
        typeof event.payload === "string"
          ? { ...getStoredThemePreferences(), theme: event.payload }
          : event.payload;
      onChange(normalizeThemePreferences(preferences));
    },
  );
  const initialPreferences = await loadThemePreferences();
  if (!receivedEvent) {
    onChange(initialPreferences);
  }
  const stopSystemTheme = subscribeSystemTheme(onChange);
  return () => {
    unlisten();
    stopSystemTheme();
  };
}
