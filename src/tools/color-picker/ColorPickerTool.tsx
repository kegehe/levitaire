import type { ToolProps } from "../../tools/registry";

/**
 * Color picker interaction is hosted by ToolPalette so the result can stay
 * beside the tool cards. This component remains the registry entry point for
 * future standalone use and lazy-chunk preloading.
 */
export default function ColorPickerTool(_props: ToolProps) {
  return null;
}
