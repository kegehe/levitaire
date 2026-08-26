export const SKETCH_HISTORY_LIMIT_KEY = "levitaire-sketch-history-limit-v1";
export const DEFAULT_SKETCH_HISTORY_LIMIT = 10;
export const MAX_SKETCH_HISTORY_LIMIT = 20;

export function normalizeSketchHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SKETCH_HISTORY_LIMIT;
  return Math.max(1, Math.min(MAX_SKETCH_HISTORY_LIMIT, Math.trunc(value)));
}

export function readSketchHistoryLimit(): number {
  try {
    const value = Number(localStorage.getItem(SKETCH_HISTORY_LIMIT_KEY));
    return localStorage.getItem(SKETCH_HISTORY_LIMIT_KEY) === null
      ? DEFAULT_SKETCH_HISTORY_LIMIT
      : normalizeSketchHistoryLimit(value);
  } catch {
    return DEFAULT_SKETCH_HISTORY_LIMIT;
  }
}

export function writeSketchHistoryLimit(value: number): number {
  const normalized = normalizeSketchHistoryLimit(value);
  try { localStorage.setItem(SKETCH_HISTORY_LIMIT_KEY, String(normalized)); } catch { /* best effort */ }
  return normalized;
}
