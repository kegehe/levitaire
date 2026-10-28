import { useEffect, useRef, useState, useCallback, useLayoutEffect, useMemo } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "../../components/Icon";
import AnnotationCanvas, { type AnnotationCanvasHandle } from "./annotate/AnnotationCanvas";
import AnnotationToolbar from "./annotate/AnnotationToolbar";
import { useAnnotations } from "./annotate/useAnnotations";
import {
  clampStrokeWidth,
  DEFAULT_TOOL,
  DEFAULT_TOOL_STYLES,
  type ActiveTool,
  type Annotation,
  type ToolStyles,
} from "./annotate/types";
import { applyEditZone, withStrokeWidth, zoneCursor, type EditZone } from "./annotate/edit";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../../styles/themePreferences";
import "./ScreenshotTool.css";
import {
  ensureLongCaptureControlsWindow,
  ensureLongCaptureFrameWindow,
} from "../../utils/toolWindows";

/** 截图模式：绘制选区 / 选区完成后进入标注 */
type Mode = "selecting" | "long-capturing" | "annotating";

interface Selection {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CapturedImage {
  base64: string;
  width: number;
  height: number;
}

interface PanelPosition {
  left: number;
  top: number;
}

interface MonitorWorkArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 选区方式：区域拖框 / 智能目标识别 */
type SelectMode = "region" | "window";
type CaptureKind = "normal" | "long";
type TargetScope = "element" | "window";

/**
 * 选区调整方向：整体移动 + 四边缩放 + 四角缩放。
 * 缩放方向刻意用单字符 token 拼写（"n"/"s"/"e"/"w" 及其组合），
 * 这样一条 `dir.includes("n")` 就能覆盖「北边」和「东北/西北角」两种情况。
 */
type AdjustMode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const ADJUST_MODES: AdjustMode[] = ["move", "n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** 需要渲染手柄的方向（除掉整体移动） */
const ADJUST_HANDLE_MODES: AdjustMode[] = ADJUST_MODES.filter((m) => m !== "move");

/** 选区的最小尺寸（CSS px）：拖动到比这更小就停住，避免选区塌成一条线后再也拉不回来 */
const MIN_SELECTION_SIZE = 8;

/** 标注缩放的最小边长（物理像素）：拖到比这更小就停住，避免框塌成一条线 */
const MIN_ANNOTATION_SIZE = 4;

/**
 * 滚轮调线宽的「空闲收口」时间：一次滚轮爆发在这段时间内没有新事件，就落成**一步撤销**。
 * 若每一格都 commit，index 式撤销栈会被几十条同样的编辑塞满。
 */
const WHEEL_EDIT_IDLE_MS = 450;

/**
 * 计算调整后的选区。纯函数，便于单测。
 *
 * @param anchor 调整开始时的选区（拖动过程中保持不变）
 * @param mode   调整方向
 * @param dx     指针相对起点的水平位移（CSS px，已对齐物理像素）
 * @param dy     指针相对起点的垂直位移（CSS px，已对齐物理像素）
 * @param bounds 允许的活动范围（CSS px，一般为 overlay 的视口尺寸）
 *
 * 缩放时**对侧边固定**：拖东边则左边不动，拖西北角则右下角不动——与所有截图/绘图工具一致。
 */
export function adjustSelection(
  anchor: Selection,
  mode: AdjustMode,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
): Selection {
  if (mode === "move") {
    const maxLeft = Math.max(0, bounds.width - anchor.width);
    const maxTop = Math.max(0, bounds.height - anchor.height);
    return {
      left: clamp(anchor.left + dx, 0, maxLeft),
      top: clamp(anchor.top + dy, 0, maxTop),
      width: anchor.width,
      height: anchor.height,
    };
  }

  const right0 = anchor.left + anchor.width;
  const bottom0 = anchor.top + anchor.height;
  // 各边独立夹到视口内。未参与本次拖动的边保持 anchor 原值。
  const left = mode.includes("w") ? clamp(anchor.left + dx, 0, bounds.width) : anchor.left;
  const right = mode.includes("e") ? clamp(right0 + dx, 0, bounds.width) : right0;
  const top = mode.includes("n") ? clamp(anchor.top + dy, 0, bounds.height) : anchor.top;
  const bottom = mode.includes("s") ? clamp(bottom0 + dy, 0, bounds.height) : bottom0;

  // 被拖过对侧边时，把「正在被拖动的那条边」退回最小尺寸，另一侧纹丝不动——
  // 这样选区是停住而不是翻转，松手前后看到的是同一个东西。
  // 下界取 min(原尺寸, MIN)：本来就不足 MIN 的窄选区（智能截图命中很小的控件时可能出现）
  // 不该被一次原地点击撑大，那样会白白触发一次重截。
  const width = shrinkToMin(
    left,
    right,
    mode.includes("w"),
    mode.includes("e"),
    Math.min(anchor.width, MIN_SELECTION_SIZE),
    bounds.width,
  );
  const height = shrinkToMin(
    top,
    bottom,
    mode.includes("n"),
    mode.includes("s"),
    Math.min(anchor.height, MIN_SELECTION_SIZE),
    bounds.height,
  );
  return {
    left: width.start,
    top: height.start,
    width: width.end - width.start,
    height: height.end - height.start,
  };
}

// 保证 [start, end] 至少有 minSize 宽：退让被拖动的那一侧；两侧都在拖（角）则退 end。
function shrinkToMin(
  start: number,
  end: number,
  dragStart: boolean,
  dragEnd: boolean,
  minSize: number,
  limit: number,
): { start: number; end: number } {
  if (end - start >= minSize) return { start, end };
  if (dragStart && !dragEnd) return { start: Math.max(0, end - minSize), end };
  return { start, end: Math.max(start, Math.min(limit, start + minSize)) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 手柄的定位方式：单边拉一条（沿边命中，比一个 8px 的点好抓），四角放方块 */
function adjustHandleStyle(sel: Selection, mode: AdjustMode): React.CSSProperties {
  if (mode === "n" || mode === "s") {
    return { left: sel.left, width: sel.width, top: mode === "n" ? sel.top : sel.top + sel.height };
  }
  if (mode === "e" || mode === "w") {
    return { top: sel.top, height: sel.height, left: mode === "w" ? sel.left : sel.left + sel.width };
  }
  return {
    left: mode.includes("w") ? sel.left : sel.left + sel.width,
    top: mode.includes("n") ? sel.top : sel.top + sel.height,
  };
}

/**
 * overlay 根节点的类名。两个修饰类都只在标注态生效：
 * - `ss-move-tool`：当前是移动工具。此时 canvas 必须 `pointer-events: none`（见 CSS），
 *   否则它会吃掉本该落到选区调整层上的指针事件。
 * - `ss-adjusting`：正在拖动调整。遮罩要抬到 canvas 之上，挡住伸出新选区的旧底图。
 */
function overlayClassName(
  mode: Mode,
  tool: ActiveTool,
  adjusting: boolean,
  nativeSelect: boolean,
): string {
  const classes = ["ss-overlay"];
  if (mode === "annotating" && tool === "move") classes.push("ss-move-tool");
  if (adjusting) classes.push("ss-adjusting");
  // 原生选区层接管期间，WebView 这套遮罩/选框只占位不绘制（DOM 保留：状态与测试都依赖它）
  if (nativeSelect) classes.push("ss-native-select");
  return classes.join(" ");
}

/**
 * 把主题的 --color-accent 换算成 RGB。
 *
 * 设计令牌用的是 oklch()，只有让浏览器自己解析才能得到 sRGB 分量：
 * 往 1x1 画布上填一格再读回来。解析失败时 fillStyle 会停在 #000，
 * 描边变黑显然不对，因此退回默认强调色。
 */
function accentRgb(): [number, number, number] {
  const fallback: [number, number, number] = [139, 92, 246];
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-accent")
      .trim();
    if (!raw) return fallback;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.fillStyle = "#000";
    ctx.fillStyle = raw;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    if (r === 0 && g === 0 && b === 0 && raw !== "#000" && raw !== "black") return fallback;
    return [r, g, b];
  } catch {
    return fallback;
  }
}

/** 后端智能截图目标的映射，坐标为虚拟桌面绝对物理像素。 */
interface ScreenshotTarget {
  kind: TargetScope;
  hwnd: number;
  left: number;
  top: number;
  width: number;
  height: number;
  controlType?: number;
  name?: string;
}

const OCR_PANEL_WIDTH = 420;
const OCR_PANEL_HEIGHT = 300;
const OCR_PANEL_GAP = 10;
const VIEWPORT_PADDING = 12;

function initialOcrPanelPosition(selection: Selection): PanelPosition {
  const width = Math.min(OCR_PANEL_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
  const height = Math.min(OCR_PANEL_HEIGHT, window.innerHeight - VIEWPORT_PADDING * 2);
  const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
  const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
  const below = selection.top + selection.height + OCR_PANEL_GAP;
  const top =
    below + height <= window.innerHeight - VIEWPORT_PADDING
      ? below
      : selection.top - height - OCR_PANEL_GAP;

  return {
    left: Math.max(VIEWPORT_PADDING, Math.min(selection.left, maxLeft)),
    top: Math.max(VIEWPORT_PADDING, Math.min(top, maxTop)),
  };
}

function ScreenshotTool() {
  // ⚠️ 必须 memo 化：getCurrentWebviewWindow() 每次调用都返回**新对象**
  // （@tauri-apps/api 里是 `new WebviewWindow(label, {skip:true})`）。它同时是
  // fetchReady / 挂载 effect / 焦点 effect 的依赖，写在渲染体里会让这些 effect
  // 每次渲染都重跑；而挂载 effect 里又会 setMonitorWorkArea(新对象) → 状态恒变
  // → 再渲染 → 自激循环（实测 ≈700 次/秒 IPC + 重渲染，且遮罩窗在启动时就被预加载）。
  const win = useMemo(() => getCurrentWebviewWindow(), []);
  const [mode, setMode] = useState<Mode>("selecting");
  const modeRef = useRef<Mode>("selecting");
  modeRef.current = mode;
  const [selectMode, setSelectMode] = useState<SelectMode>("region");
  const selectModeRef = useRef<SelectMode>("region");
  selectModeRef.current = selectMode;
  const [captureKind, setCaptureKind] = useState<CaptureKind>("normal");
  const captureKindRef = useRef<CaptureKind>("normal");
  captureKindRef.current = captureKind;
  const [targetScope, setTargetScope] = useState<TargetScope>("element");
  const targetScopeRef = useRef<TargetScope>("element");
  targetScopeRef.current = targetScope;
  const targetRef = useRef<ScreenshotTarget | null>(null);
  const targetRequestRef = useRef(0);
  const targetMoveInFlightRef = useRef(false);
  const targetMovePendingRef = useRef<{ x: number; y: number } | null>(null);
  const smartModeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueSmartModeCommand = useCallback(
    (operation: () => Promise<unknown>, reportError = true) => {
      smartModeQueueRef.current = smartModeQueueRef.current
        .then(() => operation())
        .catch((error) => {
          if (reportError) console.error("smart screenshot state update failed:", error);
        })
        .then(() => undefined);
    },
    [],
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  // selection 的 ref 镜像：endAdjust 与在途重截需要同步读最新值，避免批处理下的陈旧闭包
  const selectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection;
  const [image, setImage] = useState<CapturedImage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrSelection, setOcrSelection] = useState("");
  const [ocrPanelPosition, setOcrPanelPosition] = useState<PanelPosition | null>(null);
  const [toolbarAbove, setToolbarAbove] = useState(false);
  const [monitorWorkArea, setMonitorWorkArea] = useState<MonitorWorkArea | null>(null);
  const [captureTabsPosition, setCaptureTabsPosition] = useState<PanelPosition | null>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const scaleRef = useRef<number>(1);
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // 代际计数：cancel 时自增，异步回调 await 后比对，不等则丢弃结果，避免取消后状态复活
  const genRef = useRef(0);
  // 抑制失焦重置：save_image 等会弹系统对话框夺焦，此时不应重置截图状态
  const suppressFocusReset = useRef(false);
  // 错误提示自动清除的计时器句柄
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ocrTextRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const captureTabsRef = useRef<HTMLDivElement>(null);
  // 模式栏实测尺寸（CSS px）。拖框时定位函数每帧都要用它，不能在热路径里读 offsetWidth
  const captureTabsSizeRef = useRef({ width: 0, height: 0 });
  const monitorRequestRef = useRef(0);
  // 上次已下发的显示器工作区。IPC 每次都返回**新对象**，直接 setState 会让状态恒变，
  // 与「依赖 win 的 effect」叠加即自激；只在数值真的变化时才写状态（第二道保险：
  // 即使将来有人又把 win 写回非 memo 的取值，这里也不会再触发循环）。
  const monitorWorkAreaRef = useRef<MonitorWorkArea | null>(null);
  // 上次已下发的智能截图控件区（物理坐标）。`set_smart_screenshot_controls_bounds`
  // 是幂等的原子写，但每次都要走一次 IPC；拖框时控件栏位置逐帧变化，只在数值真的
  // 变了才下发，避免按帧刷 IPC。window 模式退出/卸载时置 null（见其专用 effect）。
  const smartControlsBoundsRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const ocrPanelDrag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  /**
   * 唯一的工作区写入口：同时更新 `monitorWorkAreaRef` 与 state。
   *
   * 两份数据必须同步。ref 用来做**值比较**（挡住「IPC 每次返回新对象 → 状态恒变 →
   * 自激」），state 负责渲染。若只写一边，值比较就会读到过期值：例如会话结束把
   * state 置 null、而 ref 仍留着旧值，再次打开遮罩时 IPC 返回**同一块屏**的相同数值，
   * 比较判定「没变」→ 不写 state → 工作区永远停在 null，坐标换算静默退回兜底值。
   */
  const applyMonitorWorkArea = useCallback((next: MonitorWorkArea | null) => {
    const prev = monitorWorkAreaRef.current;
    const changed =
      next === null
        ? prev !== null
        : prev === null ||
          prev.left !== next.left ||
          prev.top !== next.top ||
          prev.right !== next.right ||
          prev.bottom !== next.bottom;
    if (!changed) return;
    monitorWorkAreaRef.current = next;
    setMonitorWorkArea(next);
  }, []);
  // 失焦退出防抖计时器：失焦后延迟一小段时间再退出，期间若重新获焦则取消，
  // 兼顾「失焦应退出标注态」与「RDP/远程桌面等环境下 overlay 频繁瞬时失焦」。
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
  }, []);

  // 标注工具栏默认显示在选区下方；底部空间不足时翻到选区上方。
  // 使用实际尺寸而不是固定高度，兼容窄屏换行和错误提示导致的高度变化。
  useLayoutEffect(() => {
    if (mode !== "annotating" || !selection || !image || !toolbarRef.current) return;
    const toolbarRect = toolbarRef.current.getBoundingClientRect();
    const gap = 6;
    const belowTop = selection.top + selection.height + gap;
    const aboveTop = selection.top - toolbarRect.height - gap;
    const belowFits = belowTop + toolbarRect.height <= window.innerHeight - VIEWPORT_PADDING;
    const aboveFits = aboveTop >= VIEWPORT_PADDING;
    const shouldPlaceAbove = !belowFits && aboveFits;
    setToolbarAbove((current) => (current === shouldPlaceAbove ? current : shouldPlaceAbove));
  }, [mode, selection, image, busy, error]);

  // 模式栏尺寸只在「模式切换 / 窗口尺寸变化」时量一次：它随按钮文案与换行变化，
  // 但不随选区变化。量完缓存进 ref，拖框热路径只读缓存（见 updateCapturePanelPosition）。
  useLayoutEffect(() => {
    if (mode !== "selecting" || !ready) return;
    const measure = () => {
      const tabs = captureTabsRef.current;
      if (!tabs) return;
      captureTabsSizeRef.current = { width: tabs.offsetWidth, height: tabs.offsetHeight };
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mode, ready, selectMode, captureKind]);

  // The overlay spans the virtual desktop, so 50% would place the controls at
  // the seam between monitors. Anchor them to the monitor active at startup,
  // then clamp using their measured size for mixed layouts and DPI scales.
  useLayoutEffect(() => {
    if (mode !== "selecting" || !ready || !captureTabsRef.current) return;

    const updateCapturePanelPosition = () => {
      const tabs = captureTabsRef.current;
      if (!tabs) return;
      // 尺寸走缓存：这个函数依赖 selection，拖框时每次移动都会跑一遍，
      // 在里面读 offsetWidth 等于每帧强制一次同步布局。模式栏内容只在模式切换时变，
      // 尺寸由下面的独立 effect 量一次即可（首帧还没量到时才现场量）。
      let { width: tabsW, height: tabsH } = captureTabsSizeRef.current;
      if (!tabsW || !tabsH) {
        tabsW = tabs.offsetWidth;
        tabsH = tabs.offsetHeight;
        captureTabsSizeRef.current = { width: tabsW, height: tabsH };
      }
      const scale = scaleRef.current || 1;
      const origin = originRef.current;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const monitor = monitorWorkArea ?? {
        left: origin.x,
        top: origin.y,
        right: origin.x + viewportWidth * scale,
        bottom: origin.y + viewportHeight * scale,
      };
      const monitorLeft = (monitor.left - origin.x) / scale;
      const monitorTop = (monitor.top - origin.y) / scale;
      const monitorRight = (monitor.right - origin.x) / scale;
      const monitorBottom = (monitor.bottom - origin.y) / scale;
      const horizontalMin = Math.max(VIEWPORT_PADDING, monitorLeft + VIEWPORT_PADDING);
      const horizontalMax = Math.min(
        viewportWidth - tabsW - VIEWPORT_PADDING,
        monitorRight - tabsW - VIEWPORT_PADDING,
      );
      const centeredLeft = (monitorLeft + monitorRight - tabsW) / 2;
      const left =
        horizontalMax >= horizontalMin
          ? Math.max(horizontalMin, Math.min(centeredLeft, horizontalMax))
          : Math.max(
              VIEWPORT_PADDING,
              Math.min(centeredLeft, viewportWidth - tabsW - VIEWPORT_PADDING),
            );
      const verticalMin = Math.max(VIEWPORT_PADDING, monitorTop + VIEWPORT_PADDING);
      const verticalMax = Math.min(
        viewportHeight - tabsH - VIEWPORT_PADDING,
        monitorBottom - tabsH - VIEWPORT_PADDING,
      );
      let top =
        verticalMax >= verticalMin
          ? Math.max(verticalMin, Math.min(monitorTop + VIEWPORT_PADDING, verticalMax))
          : VIEWPORT_PADDING;

      // Keep the mode bar out of a selection when the user drags through the
      // top area. Prefer below, then above, while retaining the monitor bounds.
      if (selection && selection.width > 0 && selection.height > 0) {
        const overlaps =
          selection.left < left + tabsW &&
          selection.left + selection.width > left &&
          selection.top < top + tabsH &&
          selection.top + selection.height > top;
        if (overlaps) {
          const below = selection.top + selection.height + 8;
          const above = selection.top - tabsH - 8;
          if (below + tabsH <= monitorBottom - VIEWPORT_PADDING) {
            top = below;
          } else if (above >= verticalMin) {
            top = above;
          }
        }
      }

      setCaptureTabsPosition((current) =>
        current?.left === left && current.top === top ? current : { left, top },
      );
      if (captureKind === "normal" && selectMode === "window") {
        const bounds = {
          left: Math.round(left * scale + origin.x),
          top: Math.round(top * scale + origin.y),
          width: Math.round(tabsW * scale),
          height: Math.round(tabsH * scale),
        };
        const sent = smartControlsBoundsRef.current;
        if (
          !sent ||
          sent.left !== bounds.left ||
          sent.top !== bounds.top ||
          sent.width !== bounds.width ||
          sent.height !== bounds.height
        ) {
          smartControlsBoundsRef.current = bounds;
          enqueueSmartModeCommand(async () => {
            try {
              await invoke("set_smart_screenshot_controls_bounds", bounds);
            } catch (error) {
              // 下发失败就把记录清掉，让下一次位置计算重发。否则这个值会被永远当作
              // 「已下发」，控件区排除范围就一直停在旧值上 —— 原实现每次无条件重发，
              // 本身是天然容错的，去重不能把这个性质丢掉。
              if (smartControlsBoundsRef.current === bounds) {
                smartControlsBoundsRef.current = null;
              }
              throw error;
            }
          }, false);
        }
      }
    };

    updateCapturePanelPosition();
    window.addEventListener("resize", updateCapturePanelPosition);
    return () => {
      window.removeEventListener("resize", updateCapturePanelPosition);
    };
  }, [mode, ready, monitorWorkArea, selection, selectMode, captureKind, enqueueSmartModeCommand]);

  /**
   * 智能截图（窗口模式）控件区排除范围的启停。
   *
   * 必须独立成一个不依赖 `selection` 的 effect：原先这段「清零」写在上面布局 effect 的
   * cleanup 里，而该 effect 的依赖含 `selection`，于是拖框时每一次选区更新都会跟着发一次
   * 清零 IPC（实测真机上每帧一次；jsdom 环境更放大到每事件一次）。这里依赖只有模式开关，
   * 进入/离开窗口模式（含组件卸载、会话复位切回区域模式）时才清零一次，与既有语义一致。
   */
  useEffect(() => {
    if (mode !== "selecting" || captureKind !== "normal" || selectMode !== "window") return;
    return () => {
      smartControlsBoundsRef.current = null;
      enqueueSmartModeCommand(
        () =>
          invoke("set_smart_screenshot_controls_bounds", {
            left: 0,
            top: 0,
            width: 0,
            height: 0,
          }),
        false,
      );
    };
  }, [mode, captureKind, selectMode, enqueueSmartModeCommand]);

  useEffect(() => {
    const unlistenTheme = subscribeThemePreferences();
    return () => {
      unlistenTheme.then((fn) => fn()).catch(console.error);
    };
  }, []);
  // 标注
  const annotations = useAnnotations();
  // 这两个引用稳定（useState setter / useCallback），供 effect 依赖与滚轮编辑收口使用
  const setAnnotationDraft = annotations.setDraft;
  const commitAnnotation = annotations.commit;
  const clearRef = useRef(annotations.clear);
  clearRef.current = annotations.clear;
  const translateRef = useRef(annotations.translate);
  translateRef.current = annotations.translate;
  const annotateRef = useRef<AnnotationCanvasHandle>(null);
  const [tool, setTool] = useState<ActiveTool>(DEFAULT_TOOL);
  // 颜色/粗细按工具分别保存：每个绘图工具各自记住自己的颜色与粗细，互不影响。
  // 移动工具不产生标注，取其兜底样式（内容不会被用到，仅供 canvas 组件 props 完整）。
  const [toolStyles, setToolStyles] = useState<ToolStyles>(DEFAULT_TOOL_STYLES);
  const activeStyle = tool === "move" ? DEFAULT_TOOL_STYLES.rect : toolStyles[tool];
  // 工具栏二级面板只编辑「当前工具」的样式，因此 setter 写回当前工具那一项。
  const setActiveColor = useCallback(
    (c: string) => {
      setToolStyles((prev) =>
        tool === "move" ? prev : { ...prev, [tool]: { ...prev[tool], color: c } },
      );
    },
    [tool],
  );
  const setActiveStrokeWidth = useCallback(
    (next: number) => {
      setToolStyles((prev) =>
        tool === "move"
          ? prev
          : { ...prev, [tool]: { ...prev[tool], strokeWidth: clampStrokeWidth(next) } },
      );
    },
    [tool],
  );
  // 选区的调整快照。非 null 表示「正在调整选区」：`adjustAnchor` 冻结调整前的选区，
  // 底图 canvas 停在原处不动（旧裁剪的像素本来就等于桌面在那个位置的像素），
  // 遮罩/选框跟随 selection 实时更新，露出的新区域直接透出下方的实时桌面，
  // 接缝在视觉上无缝；抬手后才重新截取。见 adjustSelection / commitAdjusted。
  const [adjustAnchor, setAdjustAnchor] = useState<Selection | null>(null);
  const adjustAnchorRef = useRef<Selection | null>(null);
  adjustAnchorRef.current = adjustAnchor;
  const adjustRef = useRef<{
    pointerId: number;
    mode: AdjustMode;
    startX: number;
    startY: number;
    anchor: Selection;
  } | null>(null);
  // 调整重截的代际计数：只有最新一次的结果允许落地，避免连续拖动时旧结果覆盖新选区
  const adjustGenRef = useRef(0);

  // 标注编辑会话：在「移动」工具下命中已提交标注后拖动它（缩放/整体移动）。
  // 与选区调整互斥 —— 命中标注则编辑标注，未命中仍走选区调整。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 悬停光标（覆盖 .ss-adjust-body 的 cursor:move）：命中的部位决定缩放/移动光标
  const [hoverCursor, setHoverCursor] = useState("move");
  // 当前鼠标悬停在哪条标注上（由 .ss-adjust-body 的 pointermove 维护）。
  // 滚轮改线宽用它来判断「鼠标确实压在这条选中的标注上」——比读 wheel 事件的坐标更稳，
  // 也与指针实际位置同源。
  const hoveredAnnIdRef = useRef<string | null>(null);
  const annEditRef = useRef<{
    pointerId: number;
    zone: EditZone;
    original: Annotation;
    /** 拖动中的实时结果；同步写 ref，供 pointerup 在同一批内立即读到（不依赖 state 渲染） */
    draft: Annotation;
    start: { x: number; y: number }; // 画布内部物理像素
    moved: boolean;
  } | null>(null);

  // 滚轮调「已选中的已提交标注」线宽的会话：一次滚轮爆发合并成一步撤销。
  // 首次滚轮记下 original，之后每次滚轮更新 draft 并重置空闲定时器，定时器到点才 commit。
  const wheelEditRef = useRef<{
    id: string;
    original: Annotation;
    draft: Annotation;
    timer: number;
  } | null>(null);

  /** 滚轮编辑收口：把这一版提交进撤销栈，并清掉预览与定时器 */
  const finishWheelEdit = useCallback(() => {
    const edit = wheelEditRef.current;
    if (!edit) return;
    window.clearTimeout(edit.timer);
    wheelEditRef.current = null;
    setAnnotationDraft(null);
    // 文字/序号的字号、序号的半径都由 strokeWidth 派生，故只比 strokeWidth 即可判断是否真的变了
    if (edit.draft.strokeWidth !== edit.original.strokeWidth) commitAnnotation(edit.draft);
  }, [commitAnnotation, setAnnotationDraft]);

  /** 丢弃滚轮编辑（不提交）：用于取消/复位/卸载等整个会话被拆掉的路径 */
  const discardWheelEdit = useCallback(() => {
    const edit = wheelEditRef.current;
    if (!edit) return;
    window.clearTimeout(edit.timer);
    wheelEditRef.current = null;
    setAnnotationDraft(null);
  }, [setAnnotationDraft]);

  // 切到非「移动」工具时先收口滚轮编辑（保留用户刚调的线宽），再清掉标注选中态与预览
  useEffect(() => {
    if (tool === "move") return;
    finishWheelEdit();
    setSelectedId(null);
    setAnnotationDraft(null);
  }, [tool, setAnnotationDraft, finishWheelEdit]);

  // 工具栏的「撤销/重做」按钮不走键盘钩子（见下面的 onKey），必须同样先落定挂起的滚轮编辑：
  // 否则按钮先撤销（index 回退），450ms 后定时器再 commit 一版，把刚撤销掉的东西又推回来。
  const undoAnnotation = useCallback(() => {
    finishWheelEdit();
    annotations.undo();
  }, [finishWheelEdit, annotations.undo]);
  const redoAnnotation = useCallback(() => {
    finishWheelEdit();
    annotations.redo();
  }, [finishWheelEdit, annotations.redo]);
  // 工具栏只需要 undo/redo/canUndo/canRedo；用包裹后的版本覆盖这两个方法
  const toolbarAnnotations: typeof annotations = {
    ...annotations,
    undo: undoAnnotation,
    redo: redoAnnotation,
  };

  // 显示一条临时错误提示（4 秒后自动清除），用于 OCR 等失败时给用户可见反馈
  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  }, []);

  /**
   * 丢弃进行中的选区调整会话。会话重置（Esc / 全局 Esc / 长截图复位）时必须调用：
   * 否则在途的 capture_region 会在取消之后落地，把已清空的截图状态"复活"。
   */
  const resetAdjust = useCallback(() => {
    adjustGenRef.current++;
    adjustRef.current = null;
    setAdjustAnchor(null);
  }, []);

  // 透明背景 + scale + 虚拟桌面原点（用于把窗口相对坐标换算为虚拟桌面绝对物理坐标）
  // 两者都就绪前禁止交互，避免坐标换算用默认值导致错位
  // 拉取失败时 ready 保持 false，由 onFocusChanged 获焦重试，避免永久卡死
  const refreshMonitorWorkArea = useCallback(() => {
    const requestId = ++monitorRequestRef.current;
    invoke<MonitorWorkArea>("get_screenshot_monitor_bounds")
      .then((bounds) => {
        if (requestId !== monitorRequestRef.current) return;
        if (
          Number.isFinite(bounds.left) &&
          Number.isFinite(bounds.top) &&
          bounds.right > bounds.left &&
          bounds.bottom > bounds.top
        ) {
          applyMonitorWorkArea(bounds);
        }
      })
      .catch((e) => {
        if (requestId !== monitorRequestRef.current) return;
        console.error("get_screenshot_monitor_bounds failed:", e);
        applyMonitorWorkArea(null);
      });
  }, [applyMonitorWorkArea]);

  const fetchReady = useCallback(() => {
    let scaleReady = false;
    let originReady = false;
    const markReady = () => {
      if (scaleReady && originReady) {
        readyRef.current = true;
        setReady(true);
      }
    };
    win
      .scaleFactor()
      .then((s) => {
        scaleRef.current = s;
        scaleReady = true;
        markReady();
      })
      .catch((e) => console.error("scaleFactor failed:", e));
    invoke<{ originX: number; originY: number; width: number; height: number }>(
      "get_virtual_desktop_bounds",
    )
      .then((b) => {
        originRef.current = { x: b.originX, y: b.originY };
        originReady = true;
        markReady();
      })
      .catch((e) => console.error("get_virtual_desktop_bounds failed:", e));
    refreshMonitorWorkArea();
  }, [refreshMonitorWorkArea, win]);

  useEffect(() => {
    fetchReady();
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.overflow = "hidden";
    }
  }, [win, fetchReady, refreshMonitorWorkArea]);

  /**
   * 原生选区层（遮罩 + 选框）的接管开关。
   *
   * 区域框选阶段遮罩和选框必须"黏"着手走；WebView 那条
   * pointermove → React → 合成 → 呈现 的队列实测就是 1 帧（60Hz 下 16.7ms，
   * 再加呈现 1~2 帧 ⇒ 快拖时稳定落后 25~50px）。这一段交给 Rust 侧的 GDI 原生层，
   * 坐标由全局鼠标钩子直接喂进去，完全不经过 React。详见 screenshot/selector.rs。
   *
   * prepare 是异步的（要走主线程建窗）：没就绪之前一律退回 WebView 绘制，
   * 避免"WebView 遮罩已隐藏、原生层还没起来"的空窗期。
   */
  const [nativeSelector, setNativeSelector] = useState(false);
  const nativeSelectorRef = useRef(false);
  nativeSelectorRef.current = nativeSelector;

  /**
   * prepare / dispose 串行闸。
   *
   * 两者都要投递到主线程建/拆窗。若「上一轮会话的 dispose」迟于「这一轮的 prepare」
   * 落地（IPC 命令在不同线程上执行，顺序没有保证），它会把刚建好的窗关掉 ——
   * 而那时前端已经隐藏了自己的遮罩，整块屏幕就彻底没有遮罩了。串成一条链保证顺序
   * 确定：本轮的 dispose 一定排在下一轮的 prepare 之前。
   */
  const selectorGateRef = useRef<Promise<unknown>>(Promise.resolve());
  const gateSelector = useCallback((task: () => Promise<unknown>) => {
    const next = selectorGateRef.current.then(task, task);
    selectorGateRef.current = next.catch(() => undefined);
    return next;
  }, []);

  useEffect(() => {
    if (mode !== "selecting" || selectMode !== "region" || !ready) {
      setNativeSelector(false);
      return;
    }
    let disposed = false;
    const [r, g, b] = accentRgb();
    gateSelector(() => invoke("selector_prepare", { r, g, b }))
      .then(() => {
        if (disposed) return;
        // 手速比建窗快：拖拽已经开始了。这一轮继续用 WebView 画到底，
        // 否则会在拖到一半时把遮罩换成原生层 —— 原生层此时没有锚点（begin 没发过），
        // 屏幕上会什么都没有。
        if (dragStart.current) {
          void gateSelector(() => invoke("selector_dispose")).catch(() => {});
          return;
        }
        setNativeSelector(true);
      })
      .catch((error) => {
        console.error("native selector prepare failed, falling back to webview mask:", error);
        if (!disposed) setNativeSelector(false);
      });
    return () => {
      disposed = true;
      setNativeSelector(false);
      void gateSelector(() => invoke("selector_dispose")).catch(() => {});
    };
  }, [mode, selectMode, ready, gateSelector]);

  // 智能截图模式：同步后端钩子状态；切回其他模式时清理旧状态
  useEffect(() => {
    const smart = mode === "selecting" && selectMode === "window" && captureKind === "normal";
    targetRef.current = null;
    targetRequestRef.current++;
    enqueueSmartModeCommand(() => invoke("set_smart_screenshot_mode", { active: smart }));
    return () => {
      enqueueSmartModeCommand(() => invoke("set_smart_screenshot_mode", { active: false }), false);
    };
  }, [mode, selectMode, captureKind, enqueueSmartModeCommand]);

  useEffect(() => {
    const unMove = listen<{ x: number; y: number }>("screenshot-target-move", async ({ payload }) => {
      if (modeRef.current !== "selecting" || selectModeRef.current !== "window" || captureKindRef.current !== "normal") return;
      targetMovePendingRef.current = payload;
      if (targetMoveInFlightRef.current) return;
      targetMoveInFlightRef.current = true;
      try {
        while (targetMovePendingRef.current) {
          const point = targetMovePendingRef.current;
          targetMovePendingRef.current = null;
          const requestId = ++targetRequestRef.current;
          const target = await invoke<ScreenshotTarget | null>("detect_screenshot_target", {
            x: point.x,
            y: point.y,
            scope: targetScopeRef.current,
          }).catch(() => null);
          if (requestId !== targetRequestRef.current) continue;
          targetRef.current = target;
          if (!target) { setSelection(null); continue; }
          const scale = scaleRef.current || 1;
          const origin = originRef.current;
          setSelection({ left: (target.left - origin.x) / scale, top: (target.top - origin.y) / scale, width: target.width / scale, height: target.height / scale });
        }
      } finally {
        targetMoveInFlightRef.current = false;
      }
    });
    const unClick = listen<{ x: number; y: number }>("screenshot-target-click", async ({ payload }) => {
      if (modeRef.current !== "selecting" || selectModeRef.current !== "window" || captureKindRef.current !== "normal") return;
      const clickSessionGeneration = genRef.current;
      const clickScope = targetScopeRef.current;
      ++targetRequestRef.current;
      targetMovePendingRef.current = null;
      // Resolve once more at click time so a delayed mouse-move IPC response
      // can never cause a neighboring target to be captured.
      let target: ScreenshotTarget | null;
      try {
        target = await invoke<ScreenshotTarget | null>("detect_screenshot_target", {
          x: payload.x,
          y: payload.y,
          scope: clickScope,
        });
      } catch (error) {
        showError(
          typeof error === "string"
            ? error
            : ((error as { message?: string })?.message ?? "智能截图目标识别失败，请重试"),
        );
        return;
      }
      if (
        !target ||
        clickSessionGeneration !== genRef.current ||
        modeRef.current !== "selecting" ||
        selectModeRef.current !== "window" ||
        captureKindRef.current !== "normal" ||
        clickScope !== targetScopeRef.current
      ) return;
      const gen = ++genRef.current;
      setBusy("capture");
      try {
        const res = await invoke<{ pngBase64: string; width: number; height: number }>("capture_region_live", { left: target.left, top: target.top, width: target.width, height: target.height });
        if (gen !== genRef.current) return;
        const scale = scaleRef.current || 1;
        const origin = originRef.current;
        setSelection({ left: (target.left - origin.x) / scale, top: (target.top - origin.y) / scale, width: target.width / scale, height: target.height / scale });
        setImage({ base64: res.pngBase64, width: res.width, height: res.height });
        setMode("annotating");
      } catch (error) { showError(typeof error === "string" ? error : "智能截图失败"); }
      finally { if (gen === genRef.current) setBusy(null); }
    });
    const unScope = listen("screenshot-target-scope-toggle", () => {
      if (modeRef.current === "selecting" && selectModeRef.current === "window") {
        setTargetScope((scope) => (scope === "element" ? "window" : "element"));
      }
    });
    return () => {
      // Invalidate an in-flight detection from the previous scope/listener.
      targetRequestRef.current++;
      targetMovePendingRef.current = null;
      unMove.then((fn) => fn());
      unClick.then((fn) => fn());
      unScope.then((fn) => fn());
    };
  }, [showError]);

  // Esc 取消 + Ctrl+Z/Y 撤销重做（标注态）
  const cancelRef = useRef<() => void>(() => {});
  const undoRef = useRef(annotations.undo);
  const redoRef = useRef(annotations.redo);
  undoRef.current = annotations.undo;
  redoRef.current = annotations.redo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 文字输入聚焦时不拦截 Ctrl+Z/Y，交给 textarea 处理
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inTextInput = tag === "TEXTAREA" || tag === "INPUT";
      if (e.key === "Escape") {
        cancelRef.current();
        return;
      }
      if (inTextInput) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        if (e.shiftKey) {
          e.preventDefault();
          // 先把挂起的滚轮编辑落定，否则撤销后定时器会截断 redo 尾巴再 push，重做语义错乱
          finishWheelEdit();
          redoRef.current();
        } else {
          e.preventDefault();
          finishWheelEdit();
          undoRef.current();
        }
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        finishWheelEdit();
        redoRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finishWheelEdit]);

  // 监听后端全局 Esc 退出事件（透明全屏窗口失焦时前端 keydown 可能收不到，
  // 由 WH_KEYBOARD_LL 全局钩子触发 screenshot-cancelled 兜底）
  useEffect(() => {
    const un = listen("screenshot-cancelled", () => {
      // save_image/pin_image 夺焦期间（弹系统对话框）忽略全局 Esc，避免与对话框取消冲突清空标注
      if (suppressFocusReset.current) return;
      genRef.current++;
      readyRef.current = false;
      setReady(false);
      applyMonitorWorkArea(null);
      setCaptureTabsPosition(null);
      setSelection(null);
      setMode("selecting");
      setSelectMode("region");
      setCaptureKind("normal");
      setTargetScope("element");
      setImage(null);
      setBusy(null);
      setOcrText(null);
      setOcrSelection("");
      setOcrPanelPosition(null);
      dragStart.current = null;
      resetAdjust();
      // 每次新会话都从移动工具开始（与 Snipaste 一致）
      setTool(DEFAULT_TOOL);
      // 同步清空标注与失焦抑制，避免下次截图残留
      clearRef.current();
      // 一并丢弃标注编辑态（选中 / 拖动会话 / 挂起的滚轮编辑）
      setSelectedId(null);
      annEditRef.current = null;
      discardWheelEdit();
      suppressFocusReset.current = false;
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [discardWheelEdit]);

  useEffect(() => {
    const un = listen("long-capture-overlay-reset", () => {
      genRef.current++;
      readyRef.current = false;
      setReady(false);
      applyMonitorWorkArea(null);
      setCaptureTabsPosition(null);
      setSelection(null);
      setMode("selecting");
      setSelectMode("region");
      setCaptureKind("normal");
      setTargetScope("element");
      setImage(null);
      setBusy(null);
      setOcrText(null);
      setOcrSelection("");
      setOcrPanelPosition(null);
      dragStart.current = null;
      resetAdjust();
      setTool(DEFAULT_TOOL);
      clearRef.current();
      setSelectedId(null);
      annEditRef.current = null;
      discardWheelEdit();
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [discardWheelEdit]);

  // 失焦退出标注态：普通失焦（切走窗口、系统弹窗等）应清空截图状态，
  // 但 save/pin 弹系统对话框夺焦期间由 suppressFocusReset 抑制，避免与对话框冲突。
  // 加防抖：RDP/远程桌面下 overlay 会频繁瞬时失焦，延迟 250ms 再退出，
  // 期间若重新获焦则取消退出，避免截图模式被瞬时失焦误关。
  useEffect(() => {
    const un = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        if (blurTimer.current) {
          clearTimeout(blurTimer.current);
          blurTimer.current = null;
        }
        if (!readyRef.current) {
          fetchReady();
        } else {
          // 每次新截图会话都由后端重新记录启动显示器；刷新轻量布局信息
          // 可覆盖复用 overlay 窗口时上一次会话留下的屏幕位置。
          refreshMonitorWorkArea();
        }
        return;
      }
      // 框选态必须容忍焦点短暂切换。全局热键唤起时 Windows 可能在
      // overlay show/set_focus 后补发一次失焦事件；此时取消会让遮罩闪退。
      // Esc 已由全局键盘钩子兜底，因此框选态仍可可靠退出。
      if (modeRef.current === "selecting" || modeRef.current === "long-capturing") return;
      // 失焦：suppressFocusReset 期间（save/pin/copy 夺焦）不退出
      if (suppressFocusReset.current) return;
      if (blurTimer.current) clearTimeout(blurTimer.current);
      blurTimer.current = setTimeout(() => {
        blurTimer.current = null;
        cancelRef.current();
      }, 250);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [win, fetchReady, refreshMonitorWorkArea]);

  // 组件卸载时清除计时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
      if (blurTimer.current) clearTimeout(blurTimer.current);
      // 挂起的滚轮编辑定时器同样要在卸载时清掉（丢弃即可，组件都没了）
      if (wheelEditRef.current) window.clearTimeout(wheelEditRef.current.timer);
      wheelEditRef.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    // 自增代际，使进行中的异步回调（capture/ocr/pin 等）失效
    genRef.current++;
    readyRef.current = false;
    setReady(false);
    applyMonitorWorkArea(null);
    setCaptureTabsPosition(null);
    // 重置组件状态，避免 overlay 复用时残留上次的选区/图片
    setSelection(null);
    setMode("selecting");
    setSelectMode("region");
    setCaptureKind("normal");
    setTargetScope("element");
    setImage(null);
    setBusy(null);
    setOcrText(null);
    setOcrSelection("");
    setOcrPanelPosition(null);
    setError(null);
    suppressFocusReset.current = false;
    resetAdjust();
    // 工具回到默认的移动工具，避免上一次会话选的画笔/文字残留到下一次截图
    setTool(DEFAULT_TOOL);
    clearRef.current();
    setSelectedId(null);
    annEditRef.current = null;
    // 挂起的滚轮编辑直接丢弃：整个会话都要重置，不需要把它提交进撤销栈
    discardWheelEdit();
    if (errorTimer.current) {
      clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
    dragStart.current = null;
    invoke("cancel_screenshot").catch(console.error);
  }, [discardWheelEdit]);
  cancelRef.current = cancel;

  // 把浮点 CSS 坐标对齐到「整数物理像素」对应的 CSS 坐标。
  // 高 DPI（如 150%）下，整数 CSS px 不一定是整数物理 px（CSS 100→物理 150 整数，但 CSS 101→物理 151.5）。
  // 浏览器对非整数物理像素的盒模型边缘做子像素抗锯齿，导致蓝色边框向选区内部渗透
  // （视觉上“框线跑到截图内部”）。这里先换算到物理像素 round，再除回 CSS px，
  // 保证选区盒子的四条边都落在整数物理像素上，消除子像素渗透。
  const snap = useCallback((cssPx: number) => {
    const s = scaleRef.current || 1;
    return Math.round(cssPx * s) / s;
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (mode !== "selecting" || busy || !ready || selectMode !== "region") return;
    const x = snap(e.clientX);
    const y = snap(e.clientY);
    dragStart.current = { x, y };
    setSelection({ left: x, top: y, width: 0, height: 0 });
    // 原生选区层就绪时把锚点交出去（物理像素）：之后的坐标由全局鼠标钩子直接喂给原生层，
    // 不再经过 React。prepare 失败时这里什么也不做，WebView 那套遮罩继续兜底。
    if (nativeSelectorRef.current) {
      const scale = scaleRef.current || 1;
      const origin = originRef.current;
      void invoke("selector_begin", {
        x: Math.round(x * scale) + origin.x,
        y: Math.round(y * scale) + origin.y,
      }).catch((error) => {
        // 原生层没接住这次按下：立刻退回 WebView 绘制，别让这一拖变成"没有遮罩"。
        console.error("selector_begin failed, falling back to webview mask:", error);
        nativeSelectorRef.current = false;
        setNativeSelector(false);
      });
    }
    // 用 currentTarget（overlay 根 div，稳定存在）而非 target，避免重渲染替换子节点时丢失捕获
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (mode !== "selecting" || !dragStart.current) return;
    const start = dragStart.current;
    const cx = snap(e.clientX);
    const cy = snap(e.clientY);
    const left = Math.min(start.x, cx);
    const top = Math.min(start.y, cy);
    const width = Math.abs(cx - start.x);
    const height = Math.abs(cy - start.y);
    setSelection({ left, top, width, height });
  };

  const onPointerUp = async (e: React.PointerEvent) => {
    if (mode !== "selecting" || !dragStart.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const start = dragStart.current;
    dragStart.current = null;
    const cx = snap(e.clientX);
    const cy = snap(e.clientY);
    let left = Math.min(start.x, cx);
    let top = Math.min(start.y, cy);
    let width = Math.abs(cx - start.x);
    let height = Math.abs(cy - start.y);
    const scale = scaleRef.current;
    const origin = originRef.current;
    // 以原生层最后画出来的那一帧为准：用户眼睛看到的是它，截出来的区域必须与它一致，
    // 否则会出现「框到这里、截图差几像素」。取不到（原生层未启用/调用失败）时退回事件坐标。
    const nativeRect = nativeSelectorRef.current
      ? await invoke<{ left: number; top: number; width: number; height: number } | null>(
          "selector_end",
        ).catch(() => null)
      : null;
    let phys: Selection;
    if (nativeRect && nativeRect.width > 0 && nativeRect.height > 0) {
      phys = nativeRect;
      left = (nativeRect.left - origin.x) / scale;
      top = (nativeRect.top - origin.y) / scale;
      width = nativeRect.width / scale;
      height = nativeRect.height / scale;
    } else {
      phys = {
        left: Math.round(left * scale) + origin.x,
        top: Math.round(top * scale) + origin.y,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      };
    }
    if (width < 3 || height < 3) {
      // 选区过小，取消
      cancel();
      return;
    }
    setSelection({ left, top, width, height });
    setBusy("capture");
    if (captureKind === "long") {
      const gen = genRef.current;
      // Keep the overlay session alive while the target application is restored.
      // The overlay is hidden by Rust, but this state prevents transient focus
      // changes from cancelling the capture before the controls are usable.
      setMode("long-capturing");
      try {
        await Promise.all([ensureLongCaptureControlsWindow(), ensureLongCaptureFrameWindow()]);
        if (gen !== genRef.current) return;
        await invoke("start_long_capture", {
          left: phys.left,
          top: phys.top,
          width: phys.width,
          height: phys.height,
        });
      } catch (err) {
        console.error("start_long_capture failed:", err);
        if (gen === genRef.current) {
          const message =
            typeof err === "string"
              ? err
              : ((err as { message?: string })?.message ?? "长截图启动失败，请重新选择区域");
          showError(message);
          setMode("selecting");
          readyRef.current = false;
          setReady(false);
          applyMonitorWorkArea(null);
          setCaptureTabsPosition(null);
          setSelection(null);
          // start_long_capture may have cleaned up the native session. Re-open
          // the overlay so the user can retry without restarting the app.
          void invoke("start_screenshot").catch((restartError) => {
            console.error("restart screenshot after long capture failure:", restartError);
          });
        }
      } finally {
        if (gen === genRef.current) setBusy(null);
      }
      return;
    }
    // 代际在 await 前捕获：capture_region 期间若用户 Esc 取消，genRef 自增，
    // await 返回后比对即可丢弃这次已取消的截屏，避免状态复活。
    // capture_region 从 start_screenshot 时截取的全屏缓存裁剪，不 hide/show overlay，
    // 不触发失焦，故无需 suppressFocusReset。
    const gen = genRef.current;
    try {
      const res = await invoke<{ pngBase64: string; width: number; height: number }>(
        "capture_region",
        { left: phys.left, top: phys.top, width: phys.width, height: phys.height },
      );
      // 若期间已取消（Esc / 窗口隐藏），丢弃结果
      if (gen !== genRef.current) return;
      setImage({ base64: res.pngBase64, width: res.width, height: res.height });
      setMode("annotating");
    } catch (err) {
      console.error("capture_region failed:", err);
      showError(
        typeof err === "string" ? err : ((err as { message?: string })?.message ?? "截图失败，请重试"),
      );
      setSelection(null);
      setMode("selecting");
      // 原生层此时冻结在松手那一帧：截屏失败后 WebView 要重新接管，得先把它拆掉，
      // 否则会留一个和状态脱节的框在屏幕上。
      void invoke("selector_dispose").catch(() => {});
      setNativeSelector(false);
    } finally {
      if (gen === genRef.current) {
        setBusy(null);
      }
    }
  };

  const flushAnnotated = useCallback((): string | null => {
    // 导出前先把挂起的滚轮编辑落定（对照 AnnotationCanvas 内的 finishText）：
    // 这样导出即所见，且这一步宽度调整会作为一步留在撤销栈里。
    finishWheelEdit();
    if (!annotateRef.current) return image?.base64 ?? null;
    if (!annotateRef.current.isReady()) return null;
    return annotateRef.current.flushBase64();
  }, [image, finishWheelEdit]);

  /**
   * 按下选区调整层（整体移动 / 四边四角缩放）。
   *
   * 刻意**不**调用 `e.preventDefault()`：让正在编辑的文字 textarea 自然失焦 →
   * `finishText()` 提交 → 这条刚提交的标注随后被 `commitAdjusted` 的 translate 一并平移，
   * 不会停留在旧坐标。
   */
  const startAdjust = (e: React.PointerEvent, adjustMode: AdjustMode) => {
    if (mode !== "annotating" || tool !== "move" || !selection || busy || !ready) return;
    // busy 期间不接受新的调整：这一次重截的 translate 与 setImage 是在同一个批里落地的，
    // 若放行并发会话，被代际丢弃的那一次就没机会平移标注，坐标会错开。
    // 代价是重截在途时（通常几十毫秒）的按下会被忽略。
    if (adjustRef.current) return;
    // 标注编辑会话进行中：不并发开启选区调整（两者都由 .ss-adjust-body 接收事件）
    if (annEditRef.current) return;
    // 选区四边四角手柄是 .ss-adjust-body 的**兄弟节点**，不会走 body 的 onWheel/收口钩子。
    // 这里必须先把挂起的滚轮编辑落定：否则 commitAdjusted 的 translate 只平移已提交项，
    // 随后定时器会用「平移前坐标」的 draft 提交，去重取末次值 → 标注弹回原位。
    finishWheelEdit();
    const anchor = adjustAnchorRef.current ?? selection;
    adjustGenRef.current++;
    adjustRef.current = {
      pointerId: e.pointerId,
      mode: adjustMode,
      startX: snap(e.clientX),
      startY: snap(e.clientY),
      anchor,
    };
    setAdjustAnchor(anchor);
    // 捕获到当前元素（手柄/移动层），拖动过程中指针移出窗口也不会丢事件
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveAdjust = (e: React.PointerEvent) => {
    const drag = adjustRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = snap(e.clientX) - drag.startX;
    const dy = snap(e.clientY) - drag.startY;
    const next = adjustSelection(drag.anchor, drag.mode, dx, dy, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    // 同步写 ref：endAdjust 在同一个事件批次里读到的最新值，不能等下一次渲染
    selectionRef.current = next;
    setSelection(next);
  };

  const endAdjust = (e: React.PointerEvent) => {
    const drag = adjustRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    adjustRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const next = selectionRef.current ?? drag.anchor;
    // 原地点击（没有真的拖动）：不重截、不平移标注，直接收尾
    if (
      next.left === drag.anchor.left &&
      next.top === drag.anchor.top &&
      next.width === drag.anchor.width &&
      next.height === drag.anchor.height
    ) {
      selectionRef.current = drag.anchor;
      setSelection(drag.anchor);
      setAdjustAnchor(null);
      return;
    }
    void commitAdjusted(next, drag.anchor);
  };

  /** 指针被系统中断（触摸被撤销、窗口被夺走等）：不重截，选区退回调整前 */
  const cancelAdjust = (e: React.PointerEvent) => {
    const drag = adjustRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    adjustRef.current = null;
    selectionRef.current = drag.anchor;
    setSelection(drag.anchor);
    setAdjustAnchor(null);
  };

  /**
   * 「移动」工具下，选区内部（.ss-adjust-body）的按下：先命中测试已提交标注 ——
   * 命中则进入标注编辑会话（缩放/整体移动），未命中才落回原来的选区整体移动。
   * 选区四边四角手柄 z-index 更高，鼠标靠近选区边界时仍优先缩放选区。
   */
  const onBodyPointerDown = (e: React.PointerEvent) => {
    if (mode !== "annotating" || tool !== "move" || busy || !ready || !selection) return;
    if (adjustRef.current || annEditRef.current) return;
    // 先把挂起的滚轮编辑落定：命中测试与 original 才会带上刚调好的新线宽，
    // 且随后的 setAnnotationDraft(hit.annotation) 不会把滚轮预览悄悄丢掉。
    finishWheelEdit();
    const hit = annotateRef.current?.hitTest(e.clientX, e.clientY) ?? null;
    hoveredAnnIdRef.current = hit ? hit.annotation.id : null;
    if (!hit) {
      setSelectedId(null);
      startAdjust(e, "move");
      return;
    }
    const start = annotateRef.current?.toPhysical(e.clientX, e.clientY);
    if (!start) return;
    annEditRef.current = {
      pointerId: e.pointerId,
      zone: hit.zone,
      original: hit.annotation,
      draft: hit.annotation,
      start,
      moved: false,
    };
    setSelectedId(hit.annotation.id);
    // 立刻用 draft 顶替显示该标注：renderAll 会跳过同 id 的已生效项，因此不会与原版重影
    setAnnotationDraft(hit.annotation);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onBodyPointerMove = (e: React.PointerEvent) => {
    const edit = annEditRef.current;
    if (edit) {
      if (edit.pointerId !== e.pointerId) return;
      const p = annotateRef.current?.toPhysical(e.clientX, e.clientY);
      if (!p) return;
      const dx = p.x - edit.start.x;
      const dy = p.y - edit.start.y;
      // 小于 1 物理像素的抖动不算拖动：避免一次原地点击也产生撤销项
      if (!edit.moved && Math.hypot(dx, dy) < 1) return;
      edit.moved = true;
      // 同步写进 ref：pointerup 可能与 pointermove 落在同一批，读 state/ref 回 draft 会拿到陈旧值
      edit.draft = applyEditZone(edit.original, edit.zone, dx, dy, MIN_ANNOTATION_SIZE);
      setAnnotationDraft(edit.draft);
      return;
    }
    if (adjustRef.current) {
      moveAdjust(e);
      return;
    }
    if (mode !== "annotating" || tool !== "move" || busy || !ready) return;
    // 未拖动：只更新悬停光标（仅在变化时 setState，避免逐帧重渲染）
    const hit = annotateRef.current?.hitTest(e.clientX, e.clientY) ?? null;
    hoveredAnnIdRef.current = hit ? hit.annotation.id : null;
    const next = hit ? zoneCursor(hit.zone) : "move";
    setHoverCursor((cur) => (cur === next ? cur : next));
  };

  const onBodyPointerUp = (e: React.PointerEvent) => {
    const edit = annEditRef.current;
    if (edit) {
      if (edit.pointerId !== e.pointerId) return;
      annEditRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (edit.moved) {
        // 以同一个 id 提交这一版（撤销时自动回退到上一版，见 useAnnotations.dedupeById）
        annotations.commit(edit.draft);
      }
      setAnnotationDraft(null);
      return;
    }
    endAdjust(e);
  };

  const onBodyPointerCancel = (e: React.PointerEvent) => {
    const edit = annEditRef.current;
    if (edit && edit.pointerId === e.pointerId) {
      annEditRef.current = null;
      setAnnotationDraft(null);
      return;
    }
    cancelAdjust(e);
  };

  /**
   * 「移动」工具下、且已选中某标注时：鼠标悬停在该标注上滚轮 → 调它的线宽。
   * 一次滚轮爆发由空闲定时器收口成**一步撤销**（见 finishWheelEdit）。
   * 只按方向步进 ±1（不看 deltaY 大小），与工具栏圆点、草稿工具一致。
   */
  const onBodyWheel = (e: React.WheelEvent) => {
    if (mode !== "annotating" || tool !== "move" || busy || !ready) return;
    if (!selectedId || adjustRef.current || annEditRef.current) return;
    // 必须真的悬停在**选中的那条**标注上，避免在选区空白处滚动就误改
    if (hoveredAnnIdRef.current !== selectedId) return;
    // 只认纵向滚动：触控板横向滑动（deltaY=0）不该改线宽
    if (e.deltaY === 0) return;
    const target = annotations.getCommitted().find((a) => a.id === selectedId);
    if (!target) return;
    e.preventDefault();

    const existing = wheelEditRef.current;
    const session: { id: string; original: Annotation; draft: Annotation; timer: number } =
      existing && existing.id === selectedId
        ? existing
        : { id: selectedId, original: target, draft: target, timer: 0 };
    const next = withStrokeWidth(
      session.draft,
      session.draft.strokeWidth + (e.deltaY < 0 ? 1 : -1),
    );
    // 已到边界（钳制后没有变化）：不重启定时器，让已有会话自然收口
    if (next.strokeWidth === session.draft.strokeWidth) return;
    session.draft = next;
    if (session.timer) window.clearTimeout(session.timer);
    session.timer = window.setTimeout(finishWheelEdit, WHEEL_EDIT_IDLE_MS);
    wheelEditRef.current = session;
    setAnnotationDraft(next);
  };

  /**
   * 调整结束后重新截取新选区，并把标注平移到同一块屏幕内容上。
   *
   * 为什么必须重截：底图是旧选区的裁剪快照，选区变了就必须换底图。
   * 为什么不拖动中实时重截：PNG 编码 + IPC 对大区域要几百毫秒，跟着 pointermove 跑会卡。
   * 调整期间靠「底图停在原处 + 遮罩抬到 canvas 之上」撑住视觉（见 adjustAnchor 注释）。
   */
  const commitAdjusted = useCallback(
    async (next: Selection, anchor: Selection) => {
      const scale = scaleRef.current || 1;
      const origin = originRef.current;
      const gen = ++adjustGenRef.current;
      setBusy("capture");
      try {
        const res = await invoke<{ pngBase64: string; width: number; height: number }>(
          "capture_region",
          {
            left: Math.round(next.left * scale) + origin.x,
            top: Math.round(next.top * scale) + origin.y,
            width: Math.round(next.width * scale),
            height: Math.round(next.height * scale),
          },
        );
        if (gen !== adjustGenRef.current) return;
        // 先把新底图解码完，再切换选区/底图：否则切换后的第一帧画布是空的（白闪一帧，
        // 且马赛克标注会取到透明像素），同时 isReady() 短暂为 false —— 这段窗口里点导出
        // 会静默退化成「未标注的原图」。这里 await 的代价是 busy 多停留一次解码的时间，
        // 期间工具栏按钮保持禁用，正好挡住那次误导出。
        // 预解码失败（base64 损坏等）就忽略，退回 canvas 自己的异步加载路径。
        try {
          await annotateRef.current?.preload(res.pngBase64);
        } catch (preloadErr) {
          console.error("preload adjusted base image failed:", preloadErr);
        }
        if (gen !== adjustGenRef.current) return;
        // 标注坐标以「底图左上角」为原点，底图原点从 anchor 挪到 next，
        // 标注就要反向平移相同的物理距离，才能继续贴在同一块屏幕内容上。
        // 这是坐标系换算而非用户编辑动作，故不进撤销栈。
        const dx = (anchor.left - next.left) * scale;
        const dy = (anchor.top - next.top) * scale;
        translateRef.current(dx, dy);
        setImage({ base64: res.pngBase64, width: res.width, height: res.height });
        setSelection(next);
      } catch (err) {
        if (gen !== adjustGenRef.current) return;
        console.error("adjust capture_region failed:", err);
        // 重截失败：选区退回 anchor，底图与标注都还是原样，视觉上等于这次调整没发生
        setSelection(anchor);
        showError(
          typeof err === "string"
            ? err
            : ((err as { message?: string })?.message ?? "调整选区失败，请重试"),
        );
      } finally {
        if (gen === adjustGenRef.current) {
          // 底图已换成新选区（或已回退），锚定用不上了
          setAdjustAnchor(null);
          setBusy(null);
        }
      }
    },
    [showError],
  );


  // 小工具栏按钮
  const copyToClipboard = async () => {
    if (!image) return;
    setBusy("copy");
    try {
      const b64 = flushAnnotated() ?? image.base64;
      await invoke("clipboard_set_image", { base64Data: b64 });
      cancel();
    } catch (err) {
      console.error(err);
      // 用户可能在 invoke 期间已退出标注态（cancel 清空了 error），
      // 此时不再显示错误，避免过期错误残留到下一次截图会话。
      if (modeRef.current !== "annotating") return;
      showError(
        typeof err === "string" ? err : ((err as { message?: string })?.message ?? "复制失败"),
      );
    } finally {
      setBusy(null);
    }
  };

  const saveFile = async () => {
    if (!image) return;
    setBusy("save");
    // save_image 会弹系统保存对话框夺焦，抑制期间的失焦重置，避免截图状态被清空
    suppressFocusReset.current = true;
    try {
      const b64 = flushAnnotated() ?? image.base64;
      await invoke<boolean>("save_image", {
        base64Data: `data:image/png;base64,${b64}`,
        filename: "screenshot.png",
      });
      // 原生保存框无论确认还是取消都结束本次截图会话，与截图工具的
      // "保存完即完成" 交互一致，避免用户回到已失效的标注状态。
      cancel();
    } catch (err) {
      console.error(err);
      showError(
        typeof err === "string" ? err : ((err as { message?: string })?.message ?? "保存失败"),
      );
    } finally {
      suppressFocusReset.current = false;
      setBusy(null);
    }
  };

  const ocr = async () => {
    if (!selection || busy) return;
    const scale = scaleRef.current;
    const origin = originRef.current;
    const gen = genRef.current;
    setBusy("ocr");
    setError(null);
    try {
      const text = await invoke<string>("ocr_region", {
        left: Math.round(selection.left * scale) + origin.x,
        top: Math.round(selection.top * scale) + origin.y,
        width: Math.round(selection.width * scale),
        height: Math.round(selection.height * scale),
      });
      if (gen !== genRef.current) return;
      if (!text.trim()) {
        showError("未识别到文字");
        return;
      }
      setOcrText(text);
      setOcrSelection("");
      setOcrPanelPosition(initialOcrPanelPosition(selection));
      requestAnimationFrame(() => ocrTextRef.current?.focus());
    } catch (err) {
      console.error("ocr_region failed:", err);
      showError(
        typeof err === "string" ? err : ((err as { message?: string })?.message ?? "OCR 识别失败"),
      );
    } finally {
      if (gen === genRef.current) {
        setBusy(null);
      }
    }
  };

  const copyOcrText = async (text: string) => {
    if (!text) return;
    setBusy("copy");
    try {
      await invoke("copy_text", { text });
    } catch (err) {
      console.error("copy OCR text failed:", err);
      showError(typeof err === "string" ? err : "复制 OCR 文本失败");
    } finally {
      setBusy(null);
    }
  };

  const updateOcrSelection = () => {
    const textarea = ocrTextRef.current;
    if (!textarea) return;
    setOcrSelection(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd));
  };

  const startOcrPanelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    ocrPanelDrag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveOcrPanel = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = ocrPanelDrag.current;
    const panel = event.currentTarget.parentElement;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const rect = panel.getBoundingClientRect();
    setOcrPanelPosition({
      left: Math.max(0, Math.min(event.clientX - drag.offsetX, window.innerWidth - rect.width)),
      top: Math.max(0, Math.min(event.clientY - drag.offsetY, window.innerHeight - rect.height)),
    });
  };

  const stopOcrPanelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (ocrPanelDrag.current?.pointerId !== event.pointerId) return;
    ocrPanelDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const pinToDesktop = async () => {
    if (!image || !selection) return;
    const scale = scaleRef.current;
    const origin = originRef.current;
    setBusy("pin");
    // pin_image 创建新窗口会短暂夺焦，抑制期间的失焦重置
    suppressFocusReset.current = true;
    try {
      const b64 = flushAnnotated() ?? image.base64;
      await invoke("pin_image", {
        base64Data: b64,
        x: Math.round(selection.left * scale) + origin.x,
        y: Math.round(selection.top * scale) + origin.y,
        width: image.width,
        height: image.height,
      });
      cancel();
    } catch (err) {
      console.error("pin_image failed:", err);
      showError(
        typeof err === "string" ? err : ((err as { message?: string })?.message ?? "贴图失败，请重试"),
      );
    } finally {
      suppressFocusReset.current = false;
      setBusy(null);
    }
  };

  return (
    <div
      className={overlayClassName(mode, tool, adjustAnchor !== null, nativeSelector)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // 指针被系统取消（Alt+Tab、远程桌面断连等）时不会有 pointerup：
      // 原生选区层是独立跟踪光标的，不在这里收口它会一直跟着鼠标画下去。
      onPointerCancel={() => {
        if (!dragStart.current) return;
        dragStart.current = null;
        cancel();
      }}
    >
      {/* 顶部模式切换栏：区域拖框 / 窗口识别 */}
      {mode === "selecting" && (
        <div
          ref={captureTabsRef}
          className="ss-area-tabs"
          onPointerDown={(e) => e.stopPropagation()}
          style={
            captureTabsPosition
              ? { left: captureTabsPosition.left, top: captureTabsPosition.top, transform: "none" }
              : undefined
          }
        >
          <button
            className={`ss-area-tab ${captureKind === "long" ? "active" : ""}`}
            onClick={() => {
              setCaptureKind("long");
              setSelectMode("region");
            }}
          >
            <Icon name="ArrowDown" size={14} /> 长图
          </button>
          <button
            className={`ss-area-tab ${captureKind === "normal" && selectMode === "region" ? "active" : ""}`}
            onClick={() => {
              setCaptureKind("normal");
              setSelectMode("region");
            }}
          >
            <Icon name="Scissors" size={14} /> 区域
          </button>
          <button
            className={`ss-area-tab ${captureKind === "normal" && selectMode === "window" ? "active" : ""}`}
            onClick={() => {
              setCaptureKind("normal");
              setSelectMode("window");
            }}
          >
            <Icon name="AppWindow" size={14} /> 智能
          </button>
          <button className="ss-area-cancel" onClick={cancel}>
            取消
          </button>
        </div>
      )}

      {/* 智能截图模式：悬停识别目标，点击后直接截取 */}
      {mode === "selecting" && captureKind === "normal" && selectMode === "window" && (
        <div className="ss-smart-hint">{targetScope === "element" ? "智能识别控件" : "智能识别窗口"} · 按 Tab 切换</div>
      )}
      {/* 半透明遮罩：用 4 个 div 框出选区外的区域。尺寸标签仅在 selecting 时显示，
          参照 Snipaste：选区完成后只留工具栏，避免标签与工具栏并存干扰。
          截取底图来自 start_screenshot 时在 overlay 显示前抓取的全屏缓存，
          capture_region 直接裁剪该缓存，选区框/遮罩不会被截入，也无需 hide/show overlay，
          因此前端无需在此条件渲染上做额外处理。 */}
      {selection && selection.width > 0 && selection.height > 0 && (
        <>
          <div
            className="ss-mask"
            style={{ left: 0, top: 0, width: "100%", height: `${selection.top}px` }}
          />
          <div
            className="ss-mask"
            style={{ left: 0, top: selection.top + selection.height, width: "100%", bottom: 0 }}
          />
          <div
            className="ss-mask"
            style={{
              left: 0,
              top: selection.top,
              width: `${selection.left}px`,
              height: selection.height,
            }}
          />
          <div
            className="ss-mask"
            style={{
              left: selection.left + selection.width,
              top: selection.top,
              right: 0,
              height: selection.height,
            }}
          />
          <div className="ss-selection-box" style={boxStyle(selection)} />
          {/* 尺寸标签：框选时显示；标注态只在拖动调整期间短暂显示（静息时仍只留工具栏） */}
          {(mode === "selecting" || adjustAnchor !== null) && (
            <div className="ss-size-badge" style={sizeBadgeStyle(selection)}>
              {Math.round(selection.width * (scaleRef.current || 1))} ×{" "}
              {Math.round(selection.height * (scaleRef.current || 1))}
            </div>
          )}
        </>
      )}
      {(!selection || (selection.width === 0 && selection.height === 0)) && (
        <div className="ss-hint">
          {ready
            ? selectMode === "region"
              ? "拖动鼠标选择截图区域，按 Esc 取消"
              : "移动鼠标悬停识别目标，单击截取，按 Tab 切换，按 Esc 取消"
            : "正在准备截图…"}
        </div>
      )}
      {error && mode !== "annotating" && (
        <div className="ss-capture-error" role="alert">
          {error}
        </div>
      )}

      {mode === "annotating" && selection && image && (
        <>
          <AnnotationCanvas
            ref={annotateRef}
            image={image}
            // 调整期间底图停在 anchor 处（见 adjustAnchor 注释），不能跟着 selection 跑
            selection={adjustAnchor ?? selection}
            scale={scaleRef.current || 1}
            tool={tool}
            color={activeStyle.color}
            strokeWidth={activeStyle.strokeWidth}
            annotations={annotations}
            selectedId={tool === "move" ? selectedId : null}
          />
          {tool === "move" && (
            <>
              {/* 选区内部：按住拖动整体移动；命中已提交标注时改为编辑该标注；
                  已选中标注时滚轮改它的线宽。透明层，只为接管指针事件与光标。 */}
              <div
                className="ss-adjust-body"
                style={{ ...boxStyle(selection), cursor: hoverCursor }}
                onPointerDown={onBodyPointerDown}
                onPointerMove={onBodyPointerMove}
                onPointerUp={onBodyPointerUp}
                onPointerCancel={onBodyPointerCancel}
                onWheel={onBodyWheel}
              />
              {/* 四边四角：透明命中区，随时可抓（光标随之变缩放样式），四角在拖动时显形 */}
              {ADJUST_HANDLE_MODES.map((m) => (
                <div
                  key={m}
                  className={`ss-adjust-handle ss-adjust-${m}`}
                  style={adjustHandleStyle(selection, m)}
                  onPointerDown={(e) => startAdjust(e, m)}
                  onPointerMove={moveAdjust}
                  onPointerUp={endAdjust}
                  onPointerCancel={cancelAdjust}
                />
              ))}
            </>
          )}
          <AnnotationToolbar
            tool={tool}
            setTool={setTool}
            color={activeStyle.color}
            setColor={setActiveColor}
            strokeWidth={activeStyle.strokeWidth}
            onStrokeWidthChange={setActiveStrokeWidth}
            annotations={toolbarAnnotations}
            busy={busy}
            error={error}
            ready={true}
            onCopy={copyToClipboard}
            onSave={saveFile}
            onOcr={ocr}
            onPin={pinToDesktop}
            onCancel={cancel}
            toolbarRef={toolbarRef}
            above={toolbarAbove}
            style={{
              left: selection.left,
              ...(toolbarAbove
                ? { top: "auto", bottom: window.innerHeight - selection.top + 6 }
                : { top: selection.top + selection.height + 6 }),
            }}
          />
          {ocrText !== null && (
            <div
              className="ss-ocr-result"
              role="dialog"
              aria-modal="true"
              aria-label="OCR 结果"
              onPointerDown={(event) => event.stopPropagation()}
              style={ocrPanelPosition ? { ...ocrPanelPosition, transform: "none" } : undefined}
            >
              <div
                className="ss-ocr-result-header"
                onPointerDown={startOcrPanelDrag}
                onPointerMove={moveOcrPanel}
                onPointerUp={stopOcrPanelDrag}
              >
                <span>OCR 结果</span>
                <button
                  className="ss-btn"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    setOcrText(null);
                    setOcrPanelPosition(null);
                  }}
                  aria-label="关闭 OCR 结果"
                  data-tooltip="关闭"
                >
                  <Icon name="X" size={16} />
                </button>
              </div>
              <textarea
                ref={ocrTextRef}
                className="ss-ocr-result-text"
                value={ocrText}
                onChange={(event) => {
                  setOcrText(event.target.value);
                  setOcrSelection("");
                }}
                onSelect={updateOcrSelection}
                aria-label="OCR 识别文本"
                spellCheck={false}
              />
              <div className="ss-ocr-result-actions">
                <button
                  className="ss-ocr-action"
                  onClick={() => copyOcrText(ocrSelection)}
                  disabled={!ocrSelection || !!busy}
                >
                  复制选中
                </button>
                <button
                  className="ss-ocr-action ss-ocr-action-primary"
                  onClick={() => copyOcrText(ocrText)}
                  disabled={!ocrText || !!busy}
                >
                  复制全部
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function boxStyle(sel: Selection): React.CSSProperties {
  return {
    left: sel.left,
    top: sel.top,
    width: sel.width,
    height: sel.height,
  };
}

// 尺寸标签定位：参考 Snipaste 放在选区左上角外侧（上方），离选区顶 4px。
// 垂直方向：选区贴屏幕顶（< 标签高度 + 间距 ≈ 22px）时改放选区内部左上角，避免飞出屏幕被裁切。
// 水平方向：默认左对齐选区左边；当选区右边缘距视口右边不足标签宽度（≈ 80px）时，
// 改为右对齐选区右边缘，避免标签溢出视口右边被 .ss-overlay 的 overflow:hidden 裁切。
function sizeBadgeStyle(sel: Selection): React.CSSProperties {
  const BADGE_W = 80;
  const flipX = sel.left + sel.width + BADGE_W > window.innerWidth;
  return flipX
    ? { right: window.innerWidth - (sel.left + sel.width), top: sizeBadgeTop(sel.top) }
    : { left: sel.left, top: sizeBadgeTop(sel.top) };
}

function sizeBadgeTop(selTop: number): number {
  return selTop >= 22 ? selTop - 22 : selTop + 4;
}

export default ScreenshotTool;
