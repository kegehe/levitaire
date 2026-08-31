import { invoke } from "@tauri-apps/api/core";

/** 贴图窗口边框设置（跨窗口持久化于 config.json）。 */
export const DEFAULT_PIN_BORDER_COLOR = "#00C8FF";
export const PIN_BORDER_WIDTH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type PinBorderWidth = (typeof PIN_BORDER_WIDTH_OPTIONS)[number];

function isHexColor(value: string): boolean {
  return /^#[\da-f]{6}$/i.test(value);
}

export function normalizePinBorderColor(value: unknown): string {
  return typeof value === "string" && isHexColor(value)
    ? value.toUpperCase()
    : DEFAULT_PIN_BORDER_COLOR;
}

export function normalizePinBorderWidth(value: unknown): PinBorderWidth {
  return typeof value === "number" && PIN_BORDER_WIDTH_OPTIONS.includes(value as PinBorderWidth)
    ? (value as PinBorderWidth)
    : 1;
}

export async function fetchPinBorderColor(): Promise<string> {
  try {
    return normalizePinBorderColor(await invoke<string>("get_pin_border_color"));
  } catch {
    return DEFAULT_PIN_BORDER_COLOR;
  }
}

export async function fetchPinBorderWidth(): Promise<PinBorderWidth> {
  try {
    return normalizePinBorderWidth(await invoke<number>("get_pin_border_width"));
  } catch {
    return 1;
  }
}

export function savePinBorderColor(color: string): Promise<void> {
  return invoke("set_pin_border_color", { color: normalizePinBorderColor(color) });
}

export function savePinBorderWidth(width: PinBorderWidth): Promise<void> {
  return invoke("set_pin_border_width", { width });
}
