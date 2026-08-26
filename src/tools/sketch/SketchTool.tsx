import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor } from "@tauri-apps/api/window";
import Icon from "../../components/Icon";
import { readSketchHistoryLimit, SKETCH_HISTORY_LIMIT_KEY } from "../../constants/sketchConfig";
import "./SketchTool.css";

type Point = { x: number; y: number };
type SketchToolMode = "pen" | "line" | "rect" | "ellipse" | "arrow" | "text" | "eraser";
type Stroke = { points: Point[]; color: string; width: number; mode: SketchToolMode; text?: string; fontSize?: number; bold?: boolean };
type Viewport = { width: number; height: number; dpr: number };
type SketchSnapshot = { id: number; createdAt: string; strokes: Stroke[]; viewport?: Viewport };
type StoredSketchState = { strokes: Stroke[]; viewport: Viewport };
type SketchPreview = { dataUrl: string; filename: string; strokes: Stroke[]; revision: number };
type TextInputState = { point: Point; value: string };
type SketchPicker = "color" | "width";
const SKETCH_MODES: readonly SketchToolMode[] = ["pen", "line", "rect", "ellipse", "arrow", "text", "eraser"];

const SKETCH_STATE_KEY = "levitaire-sketch-state-v1";
const SKETCH_HISTORY_KEY = "levitaire-sketch-history-v1";
const MAX_STROKE_POINTS = 20000;

function currentViewport(): Viewport {
  return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight), dpr: window.devicePixelRatio || 1 };
}

function isViewport(value: unknown): value is Viewport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Viewport>;
  return Number.isFinite(candidate.width) && Number.isFinite(candidate.height) && candidate.width! > 0 && candidate.height! > 0;
}

function readStrokes(value: unknown): Stroke[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Stroke => {
    if (!item || typeof item !== "object") return false;
    const stroke = item as Partial<Stroke>;
    return Array.isArray(stroke.points)
      && stroke.points.length > 0
      && stroke.points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
      && typeof stroke.color === "string"
      && Number.isFinite(stroke.width)
      && SKETCH_MODES.includes(stroke.mode as SketchToolMode);
  }).map((stroke) => stroke.points.length > MAX_STROKE_POINTS
    ? { ...stroke, points: stroke.points.slice(0, MAX_STROKE_POINTS) }
    : stroke);
}

export function scaleStrokes(strokes: Stroke[], source: Viewport | undefined, target: Viewport): Stroke[] {
  const scaleX = source && isViewport(source) ? target.width / source.width : 1;
  const scaleY = source && isViewport(source) ? target.height / source.height : 1;
  const lineScale = (scaleX + scaleY) / 2;
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
    width: stroke.width * lineScale,
    fontSize: stroke.fontSize === undefined ? undefined : stroke.fontSize * lineScale,
  }));
}

function hasViewportSizeChanged(source: Viewport, target: Viewport): boolean {
  return source.width !== target.width || source.height !== target.height;
}

function pointsMatch(first: Point, second: Point): boolean {
  return first.x === second.x && first.y === second.y;
}

function readSketchState(): StoredSketchState {
  try {
    const value = JSON.parse(localStorage.getItem(SKETCH_STATE_KEY) ?? "null") as unknown;
    if (Array.isArray(value)) return { strokes: readStrokes(value), viewport: currentViewport() };
    if (value && typeof value === "object" && "strokes" in value) {
      const stored = value as Partial<StoredSketchState>;
      return { strokes: readStrokes(stored.strokes), viewport: isViewport(stored.viewport) ? stored.viewport : currentViewport() };
    }
  } catch { /* ignore malformed local sketch data */ }
  return { strokes: [], viewport: currentViewport() };
}

function readSketchHistory(): SketchSnapshot[] {
  try {
    const value = JSON.parse(localStorage.getItem(SKETCH_HISTORY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SketchSnapshot => {
      if (!item || typeof item !== "object") return false;
      const snapshot = item as Partial<SketchSnapshot>;
      return Number.isFinite(snapshot.id) && typeof snapshot.createdAt === "string" && readStrokes(snapshot.strokes).length === snapshot.strokes?.length;
    }).slice(-readSketchHistoryLimit());
  } catch { return []; }
}

const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#bf5af2", "#ffffff", "#111111"];
const WIDTHS = [2, 4, 8, 14];
const MIN_SKETCH_WIDTH = 1;
const MAX_SKETCH_WIDTH = 64;
const MIN_POINT_DISTANCE_SQUARED = 1;

function widthMarkerSize(value: number, maximum = 20): number {
  return Math.min(maximum, Math.max(4, value + 3));
}

function colorInputValue(value: string): string {
  const match = /^#([\da-f]{3})$/i.exec(value);
  if (match) return `#${match[1].split("").map((part) => part + part).join("")}`;
  return /^#[\da-f]{6}$/i.test(value) ? value : "#000000";
}

const CURSOR_SHAPES: Record<SketchToolMode, string> = {
  pen: '<path d="M5 19 18 6l3 3L8 22H5z"/><path d="m16 8 3 3"/>',
  line: '<path d="M4 20 20 4"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  text: '<path d="M5 5h14M12 5v14M8 19h8"/>',
  eraser: '<path d="m5 14 8-8a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8l-6 6a2 2 0 0 1-1.4.6H7a2 2 0 0 1-2-2v-1.2a2 2 0 0 1 0-1.4Z"/><path d="m9 10 6 6M7 18h6"/>',
};

function sketchCursor(tool: SketchToolMode, color: string): string {
  const shape = CURSOR_SHAPES[tool];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="#101216" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${shape}</g><g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shape}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 20, auto`;
}

function SketchTool() {
  const initialStateRef = useRef<StoredSketchState | null>(null);
  if (!initialStateRef.current) initialStateRef.current = readSketchState();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const drawingRef = useRef(false);
  const currentRef = useRef<Stroke | null>(null);
  const draggingTextRef = useRef<{ index: number; offsetX: number; offsetY: number; changed: boolean; preview?: Point } | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(() => scaleStrokes(initialStateRef.current!.strokes, initialStateRef.current!.viewport, currentViewport()));
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [color, setColor] = useState(COLORS[0]);
  const [customColor, setCustomColor] = useState("#ffffff");
  const [width, setWidth] = useState(4);
  const [openPicker, setOpenPicker] = useState<SketchPicker | null>(null);
  const [tool, setTool] = useState<SketchToolMode>("pen");
  const [textSize, setTextSize] = useState(20);
  const [bold, setBold] = useState(false);
  const [textInput, setTextInput] = useState<TextInputState | null>(null);
  const [history, setHistory] = useState<SketchSnapshot[]>(readSketchHistory);
  const [showHistory, setShowHistory] = useState(false);
  const viewportRef = useRef<Viewport>(currentViewport());
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  const redrawRef = useRef<() => void>(() => {});
  const closeRef = useRef<() => void>(() => {});
  const persistTimerRef = useRef<number | null>(null);
  const renderFrameRef = useRef<number | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveStateRef = useRef<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [preview, setPreview] = useState<SketchPreview | null>(null);
  const [historyLimit, setHistoryLimit] = useState(readSketchHistoryLimit);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewWindowOffset, setPreviewWindowOffset] = useState({ x: 0, y: 0 });
  const [previewImageOffset, setPreviewImageOffset] = useState({ x: 0, y: 0 });
  const [toolbarTooltip, setToolbarTooltip] = useState<{ text: string; left: number; top: number } | null>(null);
  const previewWindowDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const previewPanRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<SketchPreview | null>(null);
  const openPickerRef = useRef<SketchPicker | null>(null);
  const editVersionRef = useRef(0);
  previewRef.current = preview;
  saveStateRef.current = saveState;
  openPickerRef.current = openPicker;

  useEffect(() => {
    const unlistenReadyRequest = listen("sketch-window-ready-request", () => {
      void emit("sketch-window-ready");
    });
    void emit("sketch-window-ready");
    return () => {
      unlistenReadyRequest.then((fn) => fn());
    };
  }, []);

  const markDirty = () => {
    editVersionRef.current += 1;
    setSaveState("idle");
    setSaveError("");
  };
  const commitNewEdit = () => {
    markDirty();
    setRedo([]);
  };

  useEffect(() => {
    viewportRef.current = currentViewport();
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      try { localStorage.setItem(SKETCH_STATE_KEY, JSON.stringify({ strokes, viewport: viewportRef.current } satisfies StoredSketchState)); } catch { /* storage quota must not interrupt drawing */ }
      persistTimerRef.current = null;
    }, 350);
    return () => { if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current); };
  }, [strokes]);

  useEffect(() => {
    if (!textInput) return;
    const frame = window.requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [textInput]);

  useEffect(() => {
    try { localStorage.setItem(SKETCH_HISTORY_KEY, JSON.stringify(history.slice(-historyLimit))); } catch { /* history is best-effort */ }
  }, [history, historyLimit]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SKETCH_HISTORY_LIMIT_KEY) return;
      const next = readSketchHistoryLimit();
      setHistoryLimit(next);
      setHistory((items) => items.slice(-next));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => () => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
    try { localStorage.setItem(SKETCH_STATE_KEY, JSON.stringify({ strokes: strokesRef.current, viewport: viewportRef.current } satisfies StoredSketchState)); } catch { /* best effort on shutdown */ }
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      if (stroke.points.length < 2) continue;
      ctx.globalCompositeOperation = stroke.mode === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * window.devicePixelRatio;
      ctx.beginPath();
      const scale = window.devicePixelRatio;
      const start = stroke.points[0];
      const end = stroke.points[stroke.points.length - 1];
      ctx.moveTo(start.x * scale, start.y * scale);
      if (stroke.mode === "rect") {
        ctx.strokeRect(start.x * scale, start.y * scale, (end.x - start.x) * scale, (end.y - start.y) * scale);
        continue;
      }
      if (stroke.mode === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(((start.x + end.x) / 2) * scale, ((start.y + end.y) / 2) * scale, Math.abs(end.x - start.x) * scale / 2, Math.abs(end.y - start.y) * scale / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      if (stroke.mode === "text") {
        ctx.font = `${stroke.bold ? "700 " : ""}${(stroke.fontSize ?? 20) * scale}px sans-serif`;
        ctx.fillStyle = stroke.color;
        ctx.fillText(stroke.text ?? "", start.x * scale, start.y * scale);
        continue;
      }
      if (stroke.mode === "line" || stroke.mode === "arrow") {
        ctx.lineTo(end.x * scale, end.y * scale);
        ctx.stroke();
        if (stroke.mode === "arrow") {
          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const head = Math.max(10, stroke.width * 3.2);
          ctx.beginPath();
          ctx.moveTo(end.x * scale, end.y * scale);
          ctx.lineTo((end.x - head * Math.cos(angle - Math.PI / 6)) * scale, (end.y - head * Math.sin(angle - Math.PI / 6)) * scale);
          ctx.moveTo(end.x * scale, end.y * scale);
          ctx.lineTo((end.x - head * Math.cos(angle + Math.PI / 6)) * scale, (end.y - head * Math.sin(angle + Math.PI / 6)) * scale);
          ctx.stroke();
        }
        continue;
      }
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x * scale, point.y * scale);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [strokes]);
  redrawRef.current = redraw;

  const flushRender = useCallback(() => {
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
    const current = currentRef.current;
    if (current) {
      setStrokes((previous) => previous[previous.length - 1] === current
        ? [...previous.slice(0, -1), current]
        : [...previous, current]);
      return;
    }
    const drag = draggingTextRef.current;
    if (drag?.preview) {
      const preview = drag.preview;
      setStrokes((previous) => previous.map((item, index) => index === drag.index ? { ...item, points: [preview, preview] } : item));
    }
  }, []);

  const scheduleRender = useCallback(() => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      flushRender();
    });
  }, [flushRender]);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const nextViewport = { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight), dpr };
    const previousViewport = viewportRef.current;
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    viewportRef.current = nextViewport;
    if (hasViewportSizeChanged(previousViewport, nextViewport)) {
      setStrokes((previous) => scaleStrokes(previous, previousViewport, nextViewport));
      setRedo((previous) => scaleStrokes(previous, previousViewport, nextViewport));
    }
    redrawRef.current();
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (previewRef.current) {
        if (saveStateRef.current === "saving") return;
        setPreview(null);
        setSaveState("idle");
        setSaveError("");
        return;
      }
      if (saveStateRef.current === "saving") return;
      if (openPickerRef.current) {
        setOpenPicker(null);
        return;
      }
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
    };
  }, [resize]);

  useEffect(() => redraw(), [redraw]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): Point => ({ x: event.clientX, y: event.clientY });
  const commitTextInput = (value: string) => {
    const pending = textInput;
    setTextInput(null);
    const text = value.trim();
    if (!pending || !text) return;
    commitNewEdit();
    setStrokes((previous) => [...previous, { points: [pending.point, pending.point], color, width, mode: "text", text, fontSize: textSize, bold }]);
  };
  const cancelTextInput = () => setTextInput(null);
  const tooltipTarget = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const element = target.closest<HTMLElement>("[data-tooltip], [title]");
    if (!element || !element.closest(".sketch-toolbar, .sketch-picker-panel, .sketch-text-editor")) return null;
    // Keep the accessible label, but prevent the browser's native title bubble
    // from competing with the single tooltip rendered by the sketch overlay.
    const title = element.getAttribute("title");
    if (title && !element.dataset.tooltip) {
      element.dataset.tooltip = title;
      element.removeAttribute("title");
    }
    return element;
  };
  const showToolbarTooltip = (target: EventTarget | null) => {
    const element = tooltipTarget(target);
    if (!element || !element.dataset.tooltip) return setToolbarTooltip(null);
    const rect = element.getBoundingClientRect();
    setToolbarTooltip({ text: element.dataset.tooltip, left: rect.left + rect.width / 2, top: rect.top - 7 });
  };
  const handleToolbarPointerOut = (event: React.PointerEvent<HTMLElement>) => {
    const from = tooltipTarget(event.target);
    const related = event.relatedTarget;
    const next = tooltipTarget(related);
    if (from && next === from) return;
    if (!next) setToolbarTooltip(null);
  };
  const handleToolbarBlur = (event: React.FocusEvent<HTMLElement>) => {
    if (!tooltipTarget(event.relatedTarget)) setToolbarTooltip(null);
  };
  const begin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (openPicker) {
      setOpenPicker(null);
      return;
    }
    if (textInput) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const point = pointFromEvent(event);
    if (tool === "text") {
      for (let index = strokes.length - 1; index >= 0; index -= 1) {
        const item = strokes[index];
        if (item.mode !== "text") continue;
        const origin = item.points[0];
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) continue;
        const fontSize = item.fontSize ?? 20;
        ctx.font = `${item.bold ? "700 " : ""}${fontSize}px sans-serif`;
        const metrics = ctx.measureText(item.text ?? "");
        const ascent = metrics.actualBoundingBoxAscent || fontSize;
        const descent = metrics.actualBoundingBoxDescent || fontSize * 0.25;
        const textWidth = Math.max(1, metrics.width);
        if (point.x >= origin.x && point.x <= origin.x + textWidth && point.y >= origin.y - ascent && point.y <= origin.y + descent) {
          draggingTextRef.current = { index, offsetX: point.x - origin.x, offsetY: point.y - origin.y, changed: false };
          return;
        }
      }
      setTextInput({ point, value: "" });
      drawingRef.current = false;
      return;
    }
    currentRef.current = { points: [point], color, width, mode: tool };
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingTextRef.current) {
      const point = pointFromEvent(event);
      const drag = draggingTextRef.current;
      const { index, offsetX, offsetY } = drag;
      const current = strokesRef.current[index]?.points[0];
      const next = { x: point.x - offsetX, y: point.y - offsetY };
      if (!current || pointsMatch(current, next)) return;
      if (!drag.changed) {
        drag.changed = true;
        commitNewEdit();
      }
      drag.preview = next;
      scheduleRender();
      return;
    }
    if (!drawingRef.current || !currentRef.current) return;
    const point = pointFromEvent(event);
    const previousPoint = currentRef.current.points[currentRef.current.points.length - 1];
    const deltaX = point.x - previousPoint.x;
    const deltaY = point.y - previousPoint.y;
    if (pointsMatch(previousPoint, point) || deltaX * deltaX + deltaY * deltaY < MIN_POINT_DISTANCE_SQUARED) return;
    if (currentRef.current.points.length === 1) commitNewEdit();
    if ((tool === "pen" || tool === "eraser") && currentRef.current.points.length < MAX_STROKE_POINTS) currentRef.current.points.push(point);
    else currentRef.current.points = [currentRef.current.points[0], point];
    scheduleRender();
  };
  const end = () => {
    if (draggingTextRef.current) {
      flushRender();
      draggingTextRef.current = null;
      drawingRef.current = false;
      return;
    }
    if (!drawingRef.current || !currentRef.current) return;
    const finished = currentRef.current;
    if (finished.points.length < 2) {
      if (renderFrameRef.current !== null) {
        window.cancelAnimationFrame(renderFrameRef.current);
        renderFrameRef.current = null;
      }
      drawingRef.current = false;
      currentRef.current = null;
      return;
    }
    flushRender();
    setStrokes((previous) => (previous.includes(finished) ? previous : [...previous, finished]));
    drawingRef.current = false;
    currentRef.current = null;
  };
  const undo = () => {
    if (!strokes.length) return;
    markDirty();
    setStrokes((previous) => {
      if (!previous.length) return previous;
      const next = previous.slice(0, -1);
      setRedo((items) => [...items, previous[previous.length - 1]]);
      return next;
    });
  };
  const redoLast = () => {
    if (!redo.length) return;
    markDirty();
    setRedo((items) => {
      const item = items[items.length - 1];
      if (!item) return items;
      setStrokes((previous) => [...previous, item]);
      return items.slice(0, -1);
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (previewRef.current) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (!strokesRef.current.length) return;
        markDirty();
        setStrokes((previous) => {
          if (!previous.length) return previous;
          setRedo((items) => [...items, previous[previous.length - 1]]);
          return previous.slice(0, -1);
        });
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (!redoRef.current.length) return;
        markDirty();
        setRedo((items) => {
          const item = items[items.length - 1];
          if (!item) return items;
          setStrokes((previous) => [...previous, item]);
          return items.slice(0, -1);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const clear = () => {
    if (!strokes.length && !currentRef.current && !draggingTextRef.current && !textInput) return;
    markDirty();
    setTextInput(null);
    currentRef.current = null;
    draggingTextRef.current = null;
    drawingRef.current = false;
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    strokesRef.current = [];
    redoRef.current = [];
    setStrokes([]);
    setRedo([]);
    try { localStorage.removeItem(SKETCH_STATE_KEY); } catch { /* best effort */ }
  };
  const restoreSnapshot = (snapshot: SketchSnapshot) => {
    setTextInput(null);
    setStrokes(scaleStrokes(snapshot.strokes, snapshot.viewport, currentViewport()));
    setRedo([]);
    markDirty();
    setShowHistory(false);
  };
  const addHistoryEntry = (items: Stroke[]) => {
    const snapshot = items.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) }));
    setHistory((previous) => {
      const lastId = previous.reduce((maximum, item) => Math.max(maximum, item.id), 0);
      const id = Math.max(Date.now(), lastId + 1);
      return [...previous, { id, createdAt: new Date().toLocaleString(), strokes: snapshot, viewport: currentViewport() }].slice(-historyLimit);
    });
  };
  const removeHistoryEntry = (id: number) => {
    setHistory((previous) => previous.filter((snapshot) => snapshot.id !== id));
  };
  const selectColor = (nextColor: string) => {
    // Update the marker at pointer-down time as well as React state. This keeps
    // the visual selection immediate in transparent WebView windows where a
    // browser repaint can otherwise wait until focus changes.
    Object.entries(colorButtonRefs.current).forEach(([item, button]) => {
      if (button) button.dataset.selected = item === nextColor ? "true" : "false";
    });
    setColor(nextColor);
    setOpenPicker(null);
  };
  const selectWidth = (nextWidth: number) => {
    setWidth(Math.min(MAX_SKETCH_WIDTH, Math.max(MIN_SKETCH_WIDTH, nextWidth)));
    setOpenPicker(null);
  };
  const adjustWidth = (delta: number) => {
    setWidth((current) => Math.min(MAX_SKETCH_WIDTH, Math.max(MIN_SKETCH_WIDTH, current + delta)));
  };
  const openPreview = (dataUrl: string, filename: string, revision: number, items: Stroke[]) => {
    if (editVersionRef.current !== revision) return;
    const snapshot = items.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) }));
    setPreview({ dataUrl, filename, strokes: snapshot, revision });
    setPreviewZoom(1);
    setPreviewWindowOffset({ x: 0, y: 0 });
    setPreviewImageOffset({ x: 0, y: 0 });
    setSaveState("idle");
    setSaveError("");
  };
  const movePreviewWindow = (event: React.PointerEvent<HTMLElement>) => {
    const drag = previewWindowDragRef.current;
    if (!drag) return;
    setPreviewWindowOffset({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
  };
  const movePreviewImage = (event: React.PointerEvent<HTMLElement>) => {
    const pan = previewPanRef.current;
    if (!pan) return;
    setPreviewImageOffset({ x: pan.originX + event.clientX - pan.startX, y: pan.originY + event.clientY - pan.startY });
  };
  const save = async () => {
    setOpenPicker(null);
    const canvas = canvasRef.current;
    if (!canvas || !strokes.length || textInput) return;
    const revision = editVersionRef.current;
    openPreview(canvas.toDataURL("image/png"), "sketch.png", revision, strokes);
    return;
  };
  const saveWithBackground = async () => {
    setOpenPicker(null);
    const canvas = canvasRef.current;
    if (!canvas || !strokes.length || textInput) return;
    const revision = editVersionRef.current;
    setSaveState("saving");
    setSaveError("");
    try {
      const monitor = await currentMonitor().catch(() => null);
      if (!monitor) return save();
      const base64 = await invoke<string>("capture_sketch_background", {
        left: monitor.position.x,
        top: monitor.position.y,
        width: monitor.size.width,
        height: monitor.size.height,
      });
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("背景加载失败")); });
      const output = document.createElement("canvas");
      output.width = canvas.width;
      output.height = canvas.height;
      const ctx = output.getContext("2d");
      if (!ctx) throw new Error("无法创建保存画布");
      ctx.drawImage(image, 0, 0, output.width, output.height);
      ctx.drawImage(canvas, 0, 0);
      openPreview(output.toDataURL("image/png"), "sketch-with-background.png", revision, strokes);
      return;
    } catch (error) {
      if (editVersionRef.current !== revision) return;
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "保存失败，请重试");
    }
  };
  const savePreview = async () => {
    const currentPreview = preview;
    if (!currentPreview || editVersionRef.current !== currentPreview.revision) return;
    setSaveState("saving");
    setSaveError("");
    try {
      const didSave = await invoke<boolean>("save_image", { base64Data: currentPreview.dataUrl, filename: currentPreview.filename });
      if (!didSave) {
        if (editVersionRef.current === currentPreview.revision) setSaveState("idle");
        return;
      }
      if (editVersionRef.current !== currentPreview.revision) return;
      addHistoryEntry(currentPreview.strokes);
      closeRef.current();
    } catch (error) {
      if (editVersionRef.current !== currentPreview.revision) return;
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "淇濆瓨澶辫触锛岃閲嶈瘯");
    }
  };
  const close = () => {
    // Closing the sketch is an explicit discard action. Clear both the live
    // refs and persisted draft so reopening starts with a blank canvas.
    editVersionRef.current += 1;
    drawingRef.current = false;
    currentRef.current = null;
    draggingTextRef.current = null;
    setTextInput(null);
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    strokesRef.current = [];
    redoRef.current = [];
    setStrokes([]);
    setRedo([]);
    setSaveState("idle");
    setSaveError("");
    setPreview(null);
    setOpenPicker(null);
    setShowHistory(false);
    try { localStorage.removeItem(SKETCH_STATE_KEY); } catch { /* best effort */ }
    invoke("hide_sketch_window").catch(console.error);
  };
  closeRef.current = close;

  return (
    <main className="sketch-root" onPointerOver={(event) => showToolbarTooltip(event.target)} onPointerOut={handleToolbarPointerOut} onFocusCapture={(event) => showToolbarTooltip(event.target)} onBlurCapture={handleToolbarBlur}>
      <canvas ref={canvasRef} className="sketch-canvas" style={{ pointerEvents: preview ? "none" : "auto", cursor: preview ? "default" : sketchCursor(tool, tool === "eraser" ? "#f4f5f7" : color) }} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
      {textInput && <div
        className="sketch-text-editor"
        style={{
          left: Math.min(Math.max(8, textInput.point.x), Math.max(8, window.innerWidth - 280)),
          top: Math.min(Math.max(8, textInput.point.y - textSize - 8), Math.max(8, window.innerHeight - 58)),
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <input
          ref={textInputRef}
          className="sketch-text-input"
          value={textInput.value}
          style={{ fontSize: textSize, fontWeight: bold ? 700 : 400, color }}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setTextInput((current) => current ? { ...current, value } : current);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitTextInput(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelTextInput();
            }
          }}
          onBlur={(event) => commitTextInput(event.currentTarget.value)}
          aria-label="输入标注文字"
          placeholder="输入文字"
        />
        <button type="button" className="sketch-text-confirm" onPointerDown={(event) => { event.preventDefault(); commitTextInput(textInput.value); }} onClick={() => commitTextInput(textInput.value)} aria-label="确认文字" title="确认文字"><Icon name="Check" size={15} /></button>
        <button type="button" className="sketch-text-cancel" onPointerDown={(event) => { event.preventDefault(); cancelTextInput(); }} onClick={cancelTextInput} aria-label="取消文字" title="取消文字"><Icon name="X" size={15} /></button>
      </div>}
      {!preview && openPicker && <aside id={`sketch-${openPicker}-picker`} className={`sketch-picker-panel sketch-picker-panel-${openPicker}`} role="dialog" aria-label={openPicker === "color" ? "选择颜色" : "选择粗细"} onPointerDown={(event) => event.stopPropagation()}>
        {openPicker === "color" && <div className="sketch-picker-colors">
          {COLORS.map((item) => <button type="button" key={item} ref={(button) => { colorButtonRefs.current[item] = button; }} className="sketch-color" data-selected={color === item ? "true" : "false"} style={{ backgroundColor: item }} onPointerDown={() => selectColor(item)} onClick={() => selectColor(item)} title={`颜色 ${item}`} aria-label={`选择颜色 ${item}`} aria-pressed={color === item} />)}
          <label className={`sketch-custom-color ${color === customColor && !COLORS.includes(color) ? "active" : ""}`} title="自定义颜色">
            <input type="color" value={colorInputValue(customColor)} onChange={(event) => { setCustomColor(event.currentTarget.value); selectColor(event.currentTarget.value); }} aria-label="选择自定义颜色" />
            <span style={{ backgroundColor: customColor }} />
          </label>
        </div>}
        {openPicker === "width" && <div className="sketch-picker-widths">
          {WIDTHS.map((item) => <button type="button" key={item} className={`sketch-width ${width === item ? "active" : ""}`} onPointerDown={() => selectWidth(item)} onClick={() => selectWidth(item)} title={`粗细 ${item}`} aria-label={`选择粗细 ${item}`} aria-pressed={width === item}><span style={{ width: widthMarkerSize(item), height: widthMarkerSize(item) }} /></button>)}
          <div className="sketch-custom-width" role="spinbutton" tabIndex={0} aria-label="自定义粗细" aria-valuemin={MIN_SKETCH_WIDTH} aria-valuemax={MAX_SKETCH_WIDTH} aria-valuenow={width} title="滚轮调节自定义粗细" onWheel={(event) => { event.preventDefault(); adjustWidth(event.deltaY < 0 ? 1 : -1); }} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); adjustWidth(1); } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); adjustWidth(-1); } }}>
            <span className="sketch-custom-width-dot" style={{ width: widthMarkerSize(width, 38), height: widthMarkerSize(width, 38) }} />
            <span className="sketch-custom-width-value">{width}px</span>
          </div>
        </div>}
      </aside>}
      {!preview && <section className="sketch-toolbar" aria-label="草稿工具">
        <div className="sketch-tool-group">
          <button className={`sketch-icon-button ${tool === "pen" ? "active" : ""}`} onClick={() => setTool("pen")} title="画笔"><Icon name="Pencil" size={17} /></button>
          <button className={`sketch-icon-button ${tool === "line" ? "active" : ""}`} onClick={() => setTool("line")} title="直线"><Icon name="Minus" size={17} /></button>
          <button className={`sketch-icon-button ${tool === "rect" ? "active" : ""}`} onClick={() => setTool("rect")} title="矩形"><Icon name="Square" size={17} /></button>
          <button className={`sketch-icon-button ${tool === "ellipse" ? "active" : ""}`} onClick={() => setTool("ellipse")} title="椭圆"><Icon name="Circle" size={17} /></button>
          <button className={`sketch-icon-button ${tool === "arrow" ? "active" : ""}`} onClick={() => setTool("arrow")} title="箭头"><Icon name="ArrowUpRight" size={17} /></button>
          <button className={`sketch-icon-button ${tool === "text" ? "active" : ""}`} onClick={() => setTool("text")} title="文字"><Icon name="Type" size={17} /></button>
          <button className={`sketch-icon-button ${tool === "eraser" ? "active" : ""}`} onClick={() => setTool("eraser")} title="橡皮擦"><Icon name="Eraser" size={17} /></button>
        </div>
        <div className="sketch-picker-triggers">
          <button type="button" className={`sketch-icon-button sketch-color-trigger ${openPicker === "color" ? "active" : ""}`} onClick={() => setOpenPicker((current) => current === "color" ? null : "color")} title="颜色" aria-label="选择颜色" aria-expanded={openPicker === "color"} aria-controls="sketch-color-picker"><span style={{ backgroundColor: color }} /></button>
          <button type="button" className={`sketch-icon-button sketch-width-trigger ${openPicker === "width" ? "active" : ""}`} onClick={() => setOpenPicker((current) => current === "width" ? null : "width")} title="粗细" aria-label="选择粗细" aria-expanded={openPicker === "width"} aria-controls="sketch-width-picker"><span style={{ width: widthMarkerSize(width), height: widthMarkerSize(width) }} /></button>
        </div>
        {tool === "text" && <><select className="sketch-text-size" value={textSize} onChange={(event) => setTextSize(Number(event.target.value))} aria-label="文字大小"><option value={16}>16</option><option value={20}>20</option><option value={26}>26</option><option value={34}>34</option></select><button className={`sketch-icon-button ${bold ? "active" : ""}`} onClick={() => setBold((value) => !value)} title="粗体"><strong>B</strong></button></>}
        <div className="sketch-divider" />
        <button className="sketch-icon-button" onClick={undo} disabled={!strokes.length} title="撤销"><Icon name="Undo2" size={17} /></button>
        <button className="sketch-icon-button" onClick={redoLast} disabled={!redo.length} title="重做"><Icon name="Redo2" size={17} /></button>
        <button className="sketch-icon-button" onClick={clear} disabled={!strokes.length} title="清除画板" aria-label="清除画板"><Icon name="Trash2" size={17} /></button>
        <button className={`sketch-icon-button ${showHistory ? "active" : ""}`} onClick={() => setShowHistory((value) => !value)} title="草稿历史"><Icon name="History" size={17} /></button>
        <button type="button" className={`sketch-icon-button sketch-save ${saveState === "saved" ? "sketch-save-saved" : saveState === "saving" ? "sketch-save-saving" : saveState === "error" ? "sketch-save-failed" : ""}`} onClick={save} disabled={!strokes.length || saveState === "saving" || textInput !== null} title={saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败，点击重试" : "保存草稿"} aria-label={saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败，点击重试" : "保存草稿"}>
          {saveState === "saving" ? <Icon name="Loader2" size={17} /> : saveState === "saved" ? <Icon name="Check" size={17} /> : saveState === "error" ? <Icon name="AlertCircle" size={17} /> : <Icon name="Save" size={17} />}
        </button>
        <button className="sketch-icon-button sketch-save-with-background" onClick={saveWithBackground} disabled={!strokes.length || saveState === "saving" || textInput !== null} title="保存并包含屏幕背景"><Icon name="Image" size={17} /></button>
        <button className="sketch-icon-button sketch-close" onClick={close} disabled={saveState === "saving"} title={saveState === "saving" ? "保存中，暂不能退出" : "退出草稿"}><Icon name="X" size={17} /></button>
      </section>}
      {preview && <section className="sketch-preview" role="dialog" aria-label="草稿预览" style={{ transform: `translate(calc(-50% + ${previewWindowOffset.x}px), calc(-50% + ${previewWindowOffset.y}px))` }}>
        <header className="sketch-preview-titlebar" onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          previewWindowDragRef.current = { startX: event.clientX, startY: event.clientY, originX: previewWindowOffset.x, originY: previewWindowOffset.y };
        }} onPointerMove={movePreviewWindow} onPointerUp={() => { previewWindowDragRef.current = null; }} onPointerCancel={() => { previewWindowDragRef.current = null; }}>预览</header>
        <div className="sketch-preview-image-wrap" onWheel={(event) => {
          event.preventDefault();
          setPreviewZoom((value) => Math.min(4, Math.max(0.25, value * (event.deltaY < 0 ? 1.12 : 1 / 1.12))));
        }} onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          previewPanRef.current = { startX: event.clientX, startY: event.clientY, originX: previewImageOffset.x, originY: previewImageOffset.y };
        }} onPointerMove={movePreviewImage} onPointerUp={() => { previewPanRef.current = null; }} onPointerCancel={() => { previewPanRef.current = null; }}>
          <img className="sketch-preview-image" src={preview.dataUrl} alt="草稿预览" draggable={false} style={{ transform: `translate(${previewImageOffset.x}px, ${previewImageOffset.y}px) scale(${previewZoom})` }} />
        </div>
        <div className="sketch-preview-actions">
          <button className="sketch-preview-confirm" onClick={savePreview} disabled={saveState === "saving"}>{saveState === "saving" ? "保存中…" : "保存"}</button>
          <button className="sketch-preview-cancel" onClick={() => { setPreview(null); setSaveState("idle"); setSaveError(""); }} disabled={saveState === "saving"}>取消</button>
        </div>
      </section>}
      {saveError && <div className="sketch-save-error" role="status" aria-live="polite">{saveError}</div>}
      {showHistory && <aside className="sketch-history"><div className="sketch-history-title">草稿历史</div>{history.length === 0 ? <div className="sketch-history-empty">暂无已保存草稿</div> : history.slice().reverse().map((snapshot) => <div key={snapshot.id} className="sketch-history-item"><button className="sketch-history-restore" onClick={() => restoreSnapshot(snapshot)}><span>{snapshot.createdAt}</span><span>{snapshot.strokes.length} 个标注</span></button><button className="sketch-history-remove" onClick={() => removeHistoryEntry(snapshot.id)} title="删除此历史" aria-label="删除此历史"><Icon name="X" size={13} /></button></div>)}</aside>}
      {toolbarTooltip && <div className="sketch-tooltip" role="tooltip" style={{ left: toolbarTooltip.left, top: toolbarTooltip.top }}>{toolbarTooltip.text}</div>}
    </main>
  );
}

export default SketchTool;
