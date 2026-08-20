import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ThemeMode = "light" | "dark";
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
    label: "Signal",
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
    label: "Cloud",
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
    label: "Studio",
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
    label: "Quartz",
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
    label: "Moss",
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
    label: "Ember",
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
    label: "Arctic",
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
    label: "Mono",
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
    label: "Iris",
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
    label: "Dusk",
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

export function normalizeThemePreferences(
  value?: Partial<ThemePreferences> | null,
): ThemePreferences {
  return {
    theme: value?.theme === "dark" ? "dark" : "light",
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

export function applyThemePreferences(preferences: ThemePreferences): ThemePreferences {
  const normalized = normalizeThemePreferences(preferences);
  const root = document.documentElement;
  const values = ACCENT_BY_ID.get(normalized.accent)![normalized.theme];
  const scheme = SCHEME_BY_ID.get(normalized.scheme)![normalized.theme];
  const accentForeground = normalized.theme === "dark" ? "var(--neutral-950)" : "var(--neutral-0)";

  root.setAttribute("data-theme", normalized.theme);
  root.setAttribute("data-theme-scheme", normalized.scheme);
  root.style.setProperty("--color-bg", scheme.bg);
  root.style.setProperty("--color-bg-elevated", scheme.elevated);
  root.style.setProperty(
    "--color-bg-overlay",
    normalized.theme === "dark" ? "rgb(0 0 0 / .62)" : "rgb(255 255 255 / .82)",
  );
  root.style.setProperty("--color-bg-sunken", scheme.sunken);
  root.style.setProperty("--color-fg", scheme.fg);
  root.style.setProperty("--color-fg-muted", scheme.muted);
  root.style.setProperty("--color-fg-subtle", scheme.subtle);
  root.style.setProperty("--color-border", scheme.border);
  root.style.setProperty("--color-border-hover", scheme.borderHover);
  root.style.setProperty("--color-border-strong", scheme.borderStrong);
  root.style.setProperty("--shadow-sm", scheme.shadow);
  root.style.setProperty("--shadow-md", scheme.shadow);
  root.style.setProperty("--shadow-lg", scheme.shadow);
  root.style.setProperty("--toolbar-bg", scheme.elevated);
  root.style.setProperty("--toolbar-border", scheme.border);
  root.style.setProperty("--toolbar-radius", scheme.radius);
  root.style.setProperty("--palette-bg", scheme.elevated);
  root.style.setProperty("--palette-bg-fallback", scheme.elevated);
  root.style.setProperty("--palette-border", `1px solid ${scheme.border}`);
  root.style.setProperty("--palette-shadow", scheme.shadow);
  root.style.setProperty("--palette-card-bg", scheme.sunken);
  root.style.setProperty("--palette-card-bg-hover", scheme.elevated);
  root.style.setProperty("--palette-card-bg-enabled", values.subtle);
  root.style.setProperty("--palette-card-border", scheme.border);
  root.style.setProperty("--palette-card-border-hover", scheme.borderHover);
  root.style.setProperty("--palette-card-border-enabled", values.accent);
  root.style.setProperty("--palette-header-border", scheme.border);
  root.style.setProperty(
    "--palette-icon-bg",
    normalized.theme === "dark" ? "rgb(255 255 255 / .08)" : "rgb(0 0 0 / .05)",
  );
  root.style.setProperty("--palette-icon-color", scheme.muted);
  root.style.setProperty("--preview-bg", scheme.sunken);
  root.style.setProperty("--preview-border", scheme.border);
  root.style.setProperty("--settings-bg", scheme.bg);
  root.style.setProperty("--settings-section-bg", scheme.elevated);
  root.style.setProperty("--settings-heading-color", scheme.fg);
  root.style.setProperty("--settings-subheading-color", scheme.muted);
  root.style.setProperty("--settings-border", scheme.border);
  root.style.setProperty("--settings-input-bg", scheme.elevated);
  root.style.setProperty("--settings-sidebar-bg", scheme.elevated);
  root.style.setProperty("--settings-sidebar-border", scheme.border);
  root.style.setProperty("--button-hover-bg", scheme.sunken);
  root.style.setProperty("--button-active-bg", scheme.border);
  root.style.setProperty("--button-ghost-hover-bg", scheme.sunken);
  root.style.setProperty("--button-ghost-active-bg", scheme.border);
  root.style.setProperty("--tooltip-bg", normalized.theme === "dark" ? "#f0f2f4" : "#24272b");
  root.style.setProperty("--tooltip-text", normalized.theme === "dark" ? "#1d2228" : "#ffffff");
  root.style.setProperty("--tooltip-border", normalized.theme === "dark" ? "#c8d0d6" : "#454b52");
  root.style.setProperty("--radius-md", scheme.radius);
  root.style.setProperty("--color-brand", values.accent);
  root.style.setProperty("--color-brand-hover", values.hover);
  root.style.setProperty("--color-brand-active", values.active);
  root.style.setProperty("--color-brand-subtle", values.subtle);
  root.style.setProperty("--color-brand-fg", accentForeground);
  root.style.setProperty("--color-accent", values.accent);
  root.style.setProperty("--color-accent-hover", values.hover);
  root.style.setProperty("--color-accent-subtle", values.subtle);
  root.style.setProperty("--color-accent-fg", accentForeground);
  root.style.setProperty("--color-fg-on-accent", accentForeground);
  root.style.setProperty("--color-focus-ring", values.accent);
  root.style.setProperty("--button-primary-text", values.accent);
  root.style.setProperty("--button-primary-hover-bg", values.subtle);
  root.style.setProperty("--button-primary-active-bg", values.active);
  root.style.setProperty("--settings-focus-border", values.accent);
  root.style.setProperty("--settings-focus-shadow", values.focusShadow);
  root.style.setProperty("--settings-save-btn-bg", values.accent);
  root.style.setProperty("--settings-nav-active-bg", values.subtle);
  root.style.setProperty("--settings-nav-active-color", values.accent);
  root.style.setProperty("--settings-nav-active-border", values.accent);
  root.style.setProperty("--color-chart-cpu", values.accent);
  root.style.setProperty("--color-chart-mem", values.hover);
  root.style.setProperty("--color-chart-net", values.accent);
  root.style.setProperty("--color-chart-disk", values.hover);

  localStorage.setItem("levitaire-theme", normalized.theme);
  localStorage.setItem("levitaire-theme-accent", normalized.accent);
  localStorage.setItem("levitaire-theme-scheme", normalized.scheme);
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
  return unlisten;
}
