export type ContextMenuSource = "orb" | "tray" | "pin";

export interface ContextMenuRequest {
  source: ContextMenuSource;
  x: number;
  y: number;
  pinId?: number;
}

// The longest Chinese labels fit comfortably with a 17px icon and standard
// pointer target padding; a compact width keeps the menu close to its anchor.
export const CONTEXT_MENU_WIDTH = 184;

export function contextMenuHeight(source: ContextMenuSource): number {
  // ContextMenu.css: 34px item height, 11px group separator, 12px outer
  // padding. Keeping these derived values here prevents a transparent tail
  // below the last item when the native window is resized.
  switch (source) {
    case "pin":
      return 396;
    case "orb":
      return 204;
    case "tray":
      return 125;
  }
}
