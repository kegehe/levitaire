import {
  WebviewWindow,
  type WebviewWindow as WebviewWindowInstance,
} from "@tauri-apps/api/webviewWindow";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { cursorPosition, monitorFromPoint, primaryMonitor } from "@tauri-apps/api/window";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  CONTEXT_MENU_WIDTH,
  contextMenuHeight,
  type ContextMenuRequest,
} from "../components/contextMenuTypes";
import { BACKEND_TOOLS } from "../tools/registry";
import {
  DEFAULT_SYSTEM_MONITOR_LAYOUT,
  monitorLayoutOption,
} from "../constants/systemMonitorConfig";
import { DEFAULT_CLEANER_HEIGHT, DEFAULT_CLEANER_WIDTH } from "../constants/diskCleanupConfig";
import { PANEL_SHADOW_MARGIN, panelWindowSize } from "./panelWindow";

type ToolWindowLabel =
  | "screenshot-overlay"
  | "monitor-overlay"
  | "recording-controls"
  | "long-capture-controls"
  | "long-capture-frame"
  | "context-menu"
  | "pin-ocr"
  | "time-overlay"
  | "todo-overlay"
  | "sketch-overlay"
  | "utility-hub-overlay"
  | "sticky-notes-manager"
  | "system-cleaner-overlay";

const pendingWindows = new Map<ToolWindowLabel, Promise<WebviewWindowInstance>>();
let screenshotOverlayReady = false;
let screenshotOverlayReadyListener: Promise<UnlistenFn> | undefined;
const screenshotOverlayReadyWaiters = new Set<() => void>();
let monitorReady = false;
let monitorReadyListener: Promise<UnlistenFn> | undefined;
const monitorReadyWaiters = new Set<() => void>();
let cleanerReady = false;
let cleanerReadyListener: Promise<UnlistenFn> | undefined;
const cleanerReadyWaiters = new Set<() => void>();
let recordingControlsReady = false;
let recordingControlsReadyListener: Promise<UnlistenFn> | undefined;
const recordingControlsReadyWaiters = new Set<() => void>();
let longCaptureControlsReady = false;
let longCaptureControlsReadyListener: Promise<UnlistenFn> | undefined;
const longCaptureControlsReadyWaiters = new Set<() => void>();
let longCaptureFrameReady = false;
let longCaptureFrameReadyListener: Promise<UnlistenFn> | undefined;
const longCaptureFrameReadyWaiters = new Set<() => void>();
let contextMenuReady = false;
let contextMenuReadyListener: Promise<UnlistenFn> | undefined;
const contextMenuReadyWaiters = new Set<() => void>();
let pinOcrReady = false;
let pinOcrReadyListener: Promise<UnlistenFn> | undefined;
const pinOcrReadyWaiters = new Set<() => void>();
let timerReady = false;
let timerReadyListener: Promise<UnlistenFn> | undefined;
const timerReadyWaiters = new Set<() => void>();
let todoReady = false;
let todoReadyListener: Promise<UnlistenFn> | undefined;
const todoReadyWaiters = new Set<() => void>();
let todoCreatePromise: Promise<WebviewWindowInstance> | undefined;
let sketchReady = false;
let sketchReadyListener: Promise<UnlistenFn> | undefined;
const sketchReadyWaiters = new Set<() => void>();
let sketchCloseHandlerReady = false;
let sketchCloseHandlerPromise: Promise<void> | undefined;

function startReadyRequestRetry(target: ToolWindowLabel, requestEvent: string): number {
  const request = () => {
    void emitTo(target, requestEvent).catch(() => {});
  };
  request();
  return window.setInterval(request, 100);
}

async function ensureSketchCloseHandler(window: WebviewWindowInstance): Promise<void> {
  if (sketchCloseHandlerReady) return;
  if (!sketchCloseHandlerPromise) {
    sketchCloseHandlerPromise = window
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await window.hide().catch(() => {});
      })
      .then(() => {
        sketchCloseHandlerReady = true;
      })
      .finally(() => {
        sketchCloseHandlerPromise = undefined;
      });
  }
  await sketchCloseHandlerPromise;
}

async function prepareScreenshotOverlayReadyListener(): Promise<void> {
  if (!screenshotOverlayReadyListener) {
    screenshotOverlayReadyListener = listen("screenshot-overlay-ready", () => {
      screenshotOverlayReady = true;
      screenshotOverlayReadyWaiters.forEach((resolve) => resolve());
      screenshotOverlayReadyWaiters.clear();
    });
  }
  await screenshotOverlayReadyListener;
}

async function waitForScreenshotOverlayReady(): Promise<void> {
  await prepareScreenshotOverlayReadyListener();
  if (screenshotOverlayReady) return;

  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry(
      "screenshot-overlay",
      "screenshot-overlay-ready-request",
    );
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      screenshotOverlayReadyWaiters.delete(onReady);
      reject(new Error("Screenshot overlay did not become ready within 5 seconds"));
    }, 5000);
    screenshotOverlayReadyWaiters.add(onReady);
  });
}

async function prepareMonitorWindowReadyListener(): Promise<void> {
  if (!monitorReadyListener) {
    monitorReadyListener = listen("monitor-window-ready", () => {
      monitorReady = true;
      monitorReadyWaiters.forEach((resolve) => resolve());
      monitorReadyWaiters.clear();
    });
  }
  await monitorReadyListener;
}

export async function waitForNewMonitorWindowReady(): Promise<void> {
  await prepareMonitorWindowReadyListener();
  if (monitorReady) return;

  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry("monitor-overlay", "monitor-window-ready-request");
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      monitorReadyWaiters.delete(onReady);
      reject(new Error("系统监控窗口初始化超时"));
    }, 5000);
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    monitorReadyWaiters.add(onReady);
  });
}

async function prepareRecordingControlsReadyListener(): Promise<void> {
  if (!recordingControlsReadyListener) {
    recordingControlsReadyListener = listen("recording-controls-ready", () => {
      recordingControlsReady = true;
      recordingControlsReadyWaiters.forEach((resolve) => resolve());
      recordingControlsReadyWaiters.clear();
    });
  }
  await recordingControlsReadyListener;
}

async function prepareLongCaptureControlsReadyListener(): Promise<void> {
  if (!longCaptureControlsReadyListener) {
    longCaptureControlsReadyListener = listen("long-capture-controls-ready", () => {
      longCaptureControlsReady = true;
      longCaptureControlsReadyWaiters.forEach((resolve) => resolve());
      longCaptureControlsReadyWaiters.clear();
    });
  }
  await longCaptureControlsReadyListener;
}

async function prepareLongCaptureFrameReadyListener(): Promise<void> {
  if (!longCaptureFrameReadyListener) {
    longCaptureFrameReadyListener = listen("long-capture-frame-ready", () => {
      longCaptureFrameReady = true;
      longCaptureFrameReadyWaiters.forEach((resolve) => resolve());
      longCaptureFrameReadyWaiters.clear();
    });
  }
  await longCaptureFrameReadyListener;
}

async function waitForLongCaptureFrameReady(): Promise<void> {
  await prepareLongCaptureFrameReadyListener();
  if (longCaptureFrameReady) return;
  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry(
      "long-capture-frame",
      "long-capture-frame-ready-request",
    );
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      longCaptureFrameReadyWaiters.delete(onReady);
      reject(new Error("Long capture frame did not become ready within 5 seconds"));
    }, 5000);
    longCaptureFrameReadyWaiters.add(onReady);
  });
}

async function prepareContextMenuReadyListener(): Promise<void> {
  if (!contextMenuReadyListener) {
    contextMenuReadyListener = listen("context-menu-ready", () => {
      contextMenuReady = true;
      contextMenuReadyWaiters.forEach((resolve) => resolve());
      contextMenuReadyWaiters.clear();
    });
  }
  await contextMenuReadyListener;
}

async function waitForContextMenuReady(): Promise<void> {
  await prepareContextMenuReadyListener();
  if (contextMenuReady) return;
  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry("context-menu", "context-menu-ready-request");
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      contextMenuReadyWaiters.delete(onReady);
      reject(new Error("Context menu did not become ready within 5 seconds"));
    }, 5000);
    contextMenuReadyWaiters.add(onReady);
  });
}

async function waitForLongCaptureControlsWindowReady(): Promise<void> {
  await prepareLongCaptureControlsReadyListener();
  if (longCaptureControlsReady) return;
  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry(
      "long-capture-controls",
      "long-capture-controls-ready-request",
    );
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      longCaptureControlsReadyWaiters.delete(onReady);
      reject(new Error("Long capture controls window did not become ready within 5 seconds"));
    }, 5000);
    longCaptureControlsReadyWaiters.add(onReady);
  });
}

async function waitForRecordingControlsWindowReady(): Promise<void> {
  await prepareRecordingControlsReadyListener();
  if (recordingControlsReady) return;

  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry(
      "recording-controls",
      "recording-controls-ready-request",
    );
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      recordingControlsReadyWaiters.delete(onReady);
      reject(new Error("Recording controls window did not become ready within 5 seconds"));
    }, 5000);
    recordingControlsReadyWaiters.add(onReady);
  });
}

function createToolWindow(
  label: ToolWindowLabel,
  options: ConstructorParameters<typeof WebviewWindow>[1],
): Promise<WebviewWindowInstance> {
  const pending = pendingWindows.get(label);
  if (pending) return pending;

  const promise = (async () => {
    // 如果同名窗口已存在，先销毁再重建
    // Multiple WebViews can call ensure* concurrently (startup preload and
    // palette/hotkey activation). Reuse an existing window instead of
    // destroying it, otherwise one caller can tear down another caller's
    // freshly mounted overlay and lose its React state.
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) return existing;

    const win = new WebviewWindow(label, {
      url: "index.html",
      visible: false,
      // Tauri 的 dragDropEnabled 默认 true，Windows 上会劫持 WebView 拖放事件，
      // 使页面内 HTML5 拖拽（draggable + dragstart/dragover）完全不触发——待办窗口的
      // 任务拖拽排序就是因此失效的。本应用未使用任何 Tauri 原生拖放事件，故统一关闭。
      dragDropEnabled: false,
      ...options,
    });

    return new Promise<WebviewWindowInstance>((resolve, reject) => {
      win.once("tauri://created", () => {
        console.warn(`[toolWindows] window "${label}" created`);
        resolve(win);
      });
      win.once("tauri://error", async (event) => {
        // A different WebView may have won the same-label creation race.
        // Prefer that live window over surfacing a duplicate-window error.
        try {
          const racedWindow = await WebviewWindow.getByLabel(label);
          if (racedWindow) {
            console.warn(`[toolWindows] reusing concurrently created window "${label}"`);
            resolve(racedWindow);
            return;
          }
        } catch {
          // Fall through and preserve the original Tauri creation error.
        }
        reject(event.payload);
      });
    });
  })().finally(() => {
    pendingWindows.delete(label);
  });

  pendingWindows.set(label, promise);
  return promise;
}

export async function ensureScreenshotWindow(): Promise<WebviewWindowInstance> {
  await prepareScreenshotOverlayReadyListener();
  // Keep the resident overlay alive. Recreating it here races with the native
  // hotkey path and can destroy the window whose ready event is still pending.
  const existing = await WebviewWindow.getByLabel("screenshot-overlay");
  if (existing) {
    // A native HWND is not enough: React still has to mount the selector and
    // register its event listeners before the native start command runs. The
    // overlay can also be preloaded before this orb WebView attaches its
    // listener; in that case its one-shot ready event is already gone, while
    // the mounted overlay remains usable. Do not reject a menu-launched
    // screenshot solely because that notification was missed.
    await waitForScreenshotOverlayReady();
    return existing;
  }
  screenshotOverlayReady = false;
  const window = await createToolWindow("screenshot-overlay", {
    title: "Levitaire Screenshot",
    width: 800,
    height: 600,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 0,
    y: 0,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForScreenshotOverlayReady();
  return window;
}

export async function ensureRecordingControlsWindow(): Promise<WebviewWindowInstance> {
  await prepareRecordingControlsReadyListener();
  const existing = await WebviewWindow.getByLabel("recording-controls");
  if (existing) {
    await waitForRecordingControlsWindowReady();
    return existing;
  }
  recordingControlsReady = false;
  const window = await createToolWindow("recording-controls", {
    title: "Levitaire Recording Controls",
    width: 136,
    height: 128,
    resizable: false,
    transparent: true,
    decorations: false,
    // 不启用原生阴影：录制控制栏紧邻录制区域放置（间距 CONTROLS_GAP），
    // Windows 方形 DWM 阴影会侵入录制区域底部被 BitBlt 截进视频；
    // 且原生阴影依附窗口矩形，圆角外会露出浅色边缘。同 monitor/pomodoro。
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForRecordingControlsWindowReady();
  return window;
}

async function prepareTimerWindowReadyListener(): Promise<void> {
  if (!timerReadyListener) {
    timerReadyListener = listen("timer-window-ready", () => {
      timerReady = true;
      timerReadyWaiters.forEach((resolve) => resolve());
      timerReadyWaiters.clear();
    });
  }
  await timerReadyListener;
}

async function prepareSystemCleanerWindowReadyListener(): Promise<void> {
  if (!cleanerReadyListener) {
    cleanerReadyListener = listen("system-cleaner-window-ready", () => {
      cleanerReady = true;
      cleanerReadyWaiters.forEach((resolve) => resolve());
      cleanerReadyWaiters.clear();
    });
  }
  await cleanerReadyListener;
}

async function waitForSystemCleanerWindowReady(): Promise<void> {
  await prepareSystemCleanerWindowReadyListener();
  if (cleanerReady) return;
  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry(
      "system-cleaner-overlay",
      "system-cleaner-window-ready-request",
    );
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      cleanerReadyWaiters.delete(onReady);
      reject(new Error("系统清理窗口初始化超时"));
    }, 5000);
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    cleanerReadyWaiters.add(onReady);
  });
}

async function waitForTimerWindowReady(): Promise<void> {
  await prepareTimerWindowReadyListener();
  if (timerReady) return;
  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry("time-overlay", "timer-window-ready-request");
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      timerReadyWaiters.delete(onReady);
      reject(new Error("时钟窗口初始化超时"));
    }, 5000);
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    timerReadyWaiters.add(onReady);
  });
}

async function prepareSketchWindowReadyListener(): Promise<void> {
  if (!sketchReadyListener) {
    sketchReadyListener = listen("sketch-window-ready", () => {
      sketchReady = true;
      sketchReadyWaiters.forEach((resolve) => resolve());
      sketchReadyWaiters.clear();
    });
  }
  await sketchReadyListener;
}

async function waitForSketchWindowReady(): Promise<void> {
  await prepareSketchWindowReadyListener();
  if (sketchReady) return;
  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry("sketch-overlay", "sketch-window-ready-request");
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      sketchReadyWaiters.delete(onReady);
      reject(new Error("Sketch window did not become ready within 5 seconds"));
    }, 5000);
    sketchReadyWaiters.add(onReady);
  });
}

async function prepareTodoWindowReadyListener(): Promise<void> {
  if (!todoReadyListener) {
    todoReadyListener = listen("todo-window-ready", () => {
      todoReady = true;
      todoReadyWaiters.forEach((resolve) => resolve());
      todoReadyWaiters.clear();
    });
  }
  await todoReadyListener;
}

async function waitForTodoWindowReady(): Promise<void> {
  await prepareTodoWindowReadyListener();
  if (todoReady) return;
  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry("todo-overlay", "todo-window-ready-request");
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      todoReadyWaiters.delete(onReady);
      reject(new Error("待办窗口初始化超时"));
    }, 5000);
    todoReadyWaiters.add(onReady);
  });
}

export async function ensureSketchWindow(): Promise<WebviewWindowInstance> {
  await prepareSketchWindowReadyListener();
  const existing = await WebviewWindow.getByLabel("sketch-overlay");
  if (existing) {
    await ensureSketchCloseHandler(existing);
    await fitSketchToPrimaryMonitor(existing);
    await waitForSketchWindowReady();
    return existing;
  }
  sketchReady = false;
  const window = await createToolWindow("sketch-overlay", {
    title: "Levitaire Sketch",
    width: 800,
    height: 600,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    closable: false,
    x: 0,
    y: 0,
    backgroundColor: [0, 0, 0, 0],
  });
  await ensureSketchCloseHandler(window);
  await fitSketchToPrimaryMonitor(window);
  await waitForSketchWindowReady();
  return window;
}

async function fitSketchToPrimaryMonitor(window: WebviewWindowInstance): Promise<void> {
  const cursor = await cursorPosition().catch(() => null);
  const monitor = cursor
    ? await monitorFromPoint(cursor.x, cursor.y).catch(() => null)
    : await primaryMonitor().catch(() => null);
  if (!monitor) return;
  await window.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
  await window.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
}

export async function ensureLongCaptureControlsWindow(): Promise<WebviewWindowInstance> {
  await prepareLongCaptureControlsReadyListener();
  const existing = await WebviewWindow.getByLabel("long-capture-controls");
  if (existing) {
    // A completed capture resizes this window to the preview dimensions. Put
    // it back to the compact toolbar size before the next session. 72 只是
    // 「标题 + 说明 + 进度」三行的占位高度：真正的尺寸由 LongCaptureControls
    // 量完内容（含可能出现的警告行）下发，这里只求复位后第一帧不裁字。
    await existing.setSize(new LogicalSize(300, 72)).catch(() => {});
    await existing.hide().catch(() => {});
    await waitForLongCaptureControlsWindowReady();
    return existing;
  }
  longCaptureControlsReady = false;
  const window = await createToolWindow("long-capture-controls", {
    title: "Levitaire Long Screenshot",
    width: 300,
    // 三行文案的占位高度，实际高度随内容（警告行）变化
    height: 72,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // The capture frame remains click-through; this window must be focusable
    // so its explicit 完成/取消 buttons receive mouse clicks.
    focusable: true,
    x: 100,
    y: 100,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForLongCaptureControlsWindowReady();
  return window;
}

export async function ensureLongCaptureFrameWindow(): Promise<WebviewWindowInstance> {
  await prepareLongCaptureFrameReadyListener();
  const existing = await WebviewWindow.getByLabel("long-capture-frame");
  if (existing) {
    await existing.hide().catch(() => {});
    await waitForLongCaptureFrameReady();
    return existing;
  }
  longCaptureFrameReady = false;
  const window = await createToolWindow("long-capture-frame", {
    title: "Levitaire Long Screenshot Region",
    width: 640,
    height: 420,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    x: 100,
    y: 100,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForLongCaptureFrameReady();
  return window;
}

export async function ensureContextMenuWindow(): Promise<WebviewWindowInstance> {
  await prepareContextMenuReadyListener();
  const existing = await WebviewWindow.getByLabel("context-menu");
  if (existing) {
    await waitForContextMenuReady();
    return existing;
  }
  contextMenuReady = false;
  // 窗口 = 菜单 + 四周投影留白（见 panelWindow.ts 的 PANEL_SHADOW_MARGIN）
  const initialSize = panelWindowSize(CONTEXT_MENU_WIDTH, contextMenuHeight("pin"));
  const window = await createToolWindow("context-menu", {
    title: "Levitaire Context Menu",
    width: initialSize.width,
    height: initialSize.height,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 0,
    y: 0,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForContextMenuReady();
  return window;
}

async function preparePinOcrReadyListener(): Promise<void> {
  if (!pinOcrReadyListener) {
    pinOcrReadyListener = listen("pin-ocr-ready", () => {
      pinOcrReady = true;
      pinOcrReadyWaiters.forEach((resolve) => resolve());
      pinOcrReadyWaiters.clear();
    });
  }
}

async function waitForPinOcrReady(): Promise<void> {
  await preparePinOcrReadyListener();
  if (pinOcrReady) return;
  await new Promise<void>((resolve, reject) => {
    let retryTimer: number | null = null;
    const onReady = () => {
      if (retryTimer !== null) window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      if (retryTimer !== null) window.clearInterval(retryTimer);
      pinOcrReadyWaiters.delete(onReady);
      reject(new Error("Pin OCR window did not become ready within 5 seconds"));
    }, 5000);
    pinOcrReadyWaiters.add(onReady);
    retryTimer = startReadyRequestRetry("pin-ocr", "pin-ocr-ready-request");
  });
}

export async function ensurePinOcrWindow(): Promise<WebviewWindowInstance> {
  await preparePinOcrReadyListener();
  const existing = await WebviewWindow.getByLabel("pin-ocr");
  if (existing) {
    await waitForPinOcrReady();
    return existing;
  }
  pinOcrReady = false;
  const window = await createToolWindow("pin-ocr", {
    title: "Pin OCR",
    width: 460,
    height: 340,
    resizable: true,
    transparent: false,
    decorations: true,
    shadow: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    focusable: true,
    x: 120,
    y: 120,
  });
  await waitForPinOcrReady();
  return window;
}

interface DesktopBounds {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

function clampContextMenuPosition(
  request: ContextMenuRequest,
  width: number,
  height: number,
  bounds: DesktopBounds,
): PhysicalPosition {
  const minX = bounds.originX;
  const minY = bounds.originY;
  const maxX = Math.max(minX, bounds.originX + bounds.width - width);
  const maxY = Math.max(minY, bounds.originY + bounds.height - height);
  return new PhysicalPosition(
    Math.round(Math.min(Math.max(request.x, minX), maxX)),
    Math.round(Math.min(Math.max(request.y, minY), maxY)),
  );
}

export async function showContextMenu(request: ContextMenuRequest): Promise<void> {
  const window = await ensureContextMenuWindow();
  const width = CONTEXT_MENU_WIDTH;
  const height = contextMenuHeight(request.source);
  const [bounds, scaleFactor] = await Promise.all([
    invoke<DesktopBounds>("get_virtual_desktop_bounds"),
    window.scaleFactor(),
  ]);
  await window.hide();
  // Width/height describe CSS pixels; use logical size so the menu remains
  // identical on 100%, 125%, and 150% Windows display scaling.
  // 窗口尺寸含四周投影留白（面板另由 body.context-menu-window 的 padding 定位），
  // 否则投影会被窗口边界硬切成四个角的直角残影。
  const size = panelWindowSize(width, height);
  await window.setSize(new LogicalSize(size.width, size.height));
  // 留白参与窗口坐标：窗口左上角要比菜单目标位置再向左上让出一圈留白，
  // 菜单本体才会落在 request.x/y 上。
  const margin = Math.round(PANEL_SHADOW_MARGIN * scaleFactor);
  await window.setPosition(
    clampContextMenuPosition(
      { ...request, x: request.x - margin, y: request.y - margin },
      Math.round(size.width * scaleFactor),
      Math.round(size.height * scaleFactor),
      bounds,
    ),
  );
  await emitTo("context-menu", "context-menu-show", request);
}

export async function hideContextMenu(): Promise<void> {
  const window = await WebviewWindow.getByLabel("context-menu");
  if (window) await window.hide();
}

export async function ensureMonitorWindow(): Promise<{
  window: WebviewWindowInstance;
  created: boolean;
}> {
  // 复用已有窗口：保留采集历史（前端环形缓冲 ref 不清零）与已注册的
  // 关闭拦截监听器。若每次都销毁重建，曲线会从零开始，且旧窗口上的
  // Alt+F4 拦截监听器随之失效，导致新窗口关窗后后台采集线程空跑。
  // 复用策略同 ensureTimerWindow。
  const existing = await WebviewWindow.getByLabel("monitor-overlay");
  if (existing) {
    await waitForNewMonitorWindowReady();
    return { window: existing, created: false };
  }

  await prepareMonitorWindowReadyListener();
  monitorReady = false;
  const window = await createToolWindow("monitor-overlay", {
    title: "Levitaire Monitor",
    // 创建尺寸只是个占位：show_monitor_window 会在显示前按存储的「显示模式 + 显示样式」
    // 重新设置尺寸（样式不同宽度也不同，只有双列宫格是 340）。这里取默认样式的尺寸，
    // 免得两个地方各写一份数字。
    width: monitorLayoutOption(DEFAULT_SYSTEM_MONITOR_LAYOUT).width,
    height: monitorLayoutOption(DEFAULT_SYSTEM_MONITOR_LAYOUT).placeholderHeight,
    resizable: false,
    transparent: true,
    decorations: false,
    // 由 .monitor-body 的 CSS border 负责视觉边界。Windows 原生阴影依附
    // 窗口矩形而非 CSS 圆角，深色主题下圆角外四角会露出浅色边缘（白边）。
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
    backgroundColor: [0, 0, 0, 0],
  });
  return { window, created: true };
}

/** 创建或复用时间工具悬浮窗（隐藏，待 ready 后由 show_timer_window 显示）。
 * 窗口已存在时直接复用，保留用户拖拽后的位置与组件状态；计时由后端持有，不受影响。 */
export async function ensureTimerWindow(): Promise<WebviewWindowInstance> {
  const existing = await WebviewWindow.getByLabel("time-overlay");
  if (existing) {
    await waitForTimerWindowReady();
    return existing;
  }
  await prepareTimerWindowReadyListener();
  timerReady = false;
  const window = await createToolWindow("time-overlay", {
    title: "Levitaire 时间工具",
    width: 320,
    height: 220,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForTimerWindowReady();
  return window;
}

/** 创建或复用系统清理面板（创建后等 ready 再返回，避免拿到一个还没挂载监听器的窗口）。 */
export async function ensureSystemCleanerWindow(): Promise<WebviewWindowInstance> {
  const existing = await WebviewWindow.getByLabel("system-cleaner-overlay");
  if (existing) {
    await waitForSystemCleanerWindowReady();
    return existing;
  }
  await prepareSystemCleanerWindowReadyListener();
  cleanerReady = false;
  const window = await createToolWindow("system-cleaner-overlay", {
    title: "Levitaire 系统清理",
    width: DEFAULT_CLEANER_WIDTH,
    height: DEFAULT_CLEANER_HEIGHT,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 120,
    y: 120,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForSystemCleanerWindowReady();
  return window;
}

export async function ensureTodoWindow(): Promise<WebviewWindowInstance> {
  if (todoCreatePromise) return todoCreatePromise;
  todoCreatePromise = (async () => {
    const existing = await WebviewWindow.getByLabel("todo-overlay");
    if (existing) {
      await waitForTodoWindowReady();
      return existing;
    }
    await prepareTodoWindowReadyListener();
    todoReady = false;
    const window = await createToolWindow("todo-overlay", {
      title: "Levitaire Todo",
      // 只是首帧占位：待办窗高度随内容走（空清单只有一百多像素，折叠态更矮），
      // 挂载后由 `TodoTool.tsx` 按面板实测高度重新 setSize。给个接近常见内容的
      // 初始值，免得开窗时先看见一次「拉长再收窄」的跳变。
      width: 360,
      height: 300,
      resizable: false,
      transparent: true,
      decorations: false,
      shadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      x: 100,
      y: 100,
      backgroundColor: [0, 0, 0, 0],
    });
    await waitForTodoWindowReady();
    return window;
  })();
  try {
    return await todoCreatePromise;
  } finally {
    todoCreatePromise = undefined;
  }
}

export async function ensureUtilityHubWindow(): Promise<WebviewWindowInstance> {
  const existing = await WebviewWindow.getByLabel("utility-hub-overlay");
  if (existing) return existing;
  return createToolWindow("utility-hub-overlay", {
    title: "Levitaire 通用工具",
    // The frontend resizes to its active tool's measured content height plus
    // a transparent 26px gutter for upward tooltips.
    // 初始宽按「tools」模式的标题栏估算：手柄 + 取色 + 滚动导航 + 窗口置顶 + 关闭
    // = 面板 127px（见 UtilityHub.css 的 max-content），再加两侧投影留白。只是首帧
    // 占位：面板宽度不受窗口钳制，真实尺寸由 UtilityHub.tsx 量完下发，多了/少了
    // 工具按钮都能自愈。
    width: 167,
    height: 62,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 120,
    y: 120,
    backgroundColor: [0, 0, 0, 0],
  });
}

/** 创建或复用便利贴管理窗（隐藏，待 show_sticky_notes_manager 命令显示）。
 * 管理窗统筹所有便签的新建/删除/收起/唤出。
 * 高度只是创建时的占位值：面板高度随内容变化（空状态一两行、便签多时受列表
 * max-height 收口），实际窗口尺寸由 StickyNoteManager.tsx 按面板实测高度下发。
 * 这里取空状态附近的值，避免「先弹出一个高窗再跳矮」的闪烁。 */
export async function ensureStickyNotesManagerWindow(): Promise<WebviewWindowInstance> {
  const existing = await WebviewWindow.getByLabel("sticky-notes-manager");
  if (existing) return existing;
  return createToolWindow("sticky-notes-manager", {
    title: "Levitaire 便利贴",
    width: 360,
    height: 200,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
    backgroundColor: [0, 0, 0, 0],
  });
}

/**
 * Warm up only the windows a global hotkey may summon at an arbitrary moment,
 * plus the pinned-sticky-note restoration. All other tool windows are created
 * on first real use by their ensure-* / openToolWindow call sites.
 *
 * Background: each tool window is an independent WebView2 renderer (tens of MB
 * of working set). Pre-creating a hidden window for every enabled tool made
 * merely enabling a tool keep that renderer alive for the whole session, so
 * "3 tools enabled" could mean 6-7 resident WebViews. Auxiliary per-flow
 * windows (long-capture controls/frame, context menu, recording controls) and
 * panel tools (monitor/timer/utility-hub) do not need this and are now
 * created lazily. quick-input's overlay is ensured natively when enabled.
 */
export async function preloadEnabledToolWindows(): Promise<void> {
  const enabledResults = await Promise.all(
    BACKEND_TOOLS.map(async ({ id, getter }) => {
      try {
        return { id, enabled: await invoke<boolean>(getter) };
      } catch (error) {
        console.error(`[toolWindows] failed to read enabled state for ${id}:`, error);
        return { id, enabled: false };
      }
    }),
  );
  const enabledIds = new Set(enabledResults.filter(({ enabled }) => enabled).map(({ id }) => id));
  const tasks: Array<{ label: string; promise: Promise<unknown> }> = [];

  // The screenshot overlay is created by the hotkey path immediately before
  // capture. Keeping this WebView resident at startup wastes memory and makes
  // WebView2/GPU failures more likely when the machine is under pressure.
  if (enabledIds.has("sketch")) {
    // 草稿由全局热键唤起全屏画板，需即时可用。
    tasks.push({ label: "sketch overlay", promise: ensureSketchWindow() });
  }
  if (enabledIds.has("todo")) {
    // 待办支持 Ctrl+Alt+T 全局快速添加，需即时可用。
    tasks.push({ label: "todo", promise: ensureTodoWindow() });
  }
  if (enabledIds.has("sticky-notes")) {
    // 恢复启动前已钉在桌面的便签（后端按 visible 重建窗口），不打开管理窗。
    tasks.push({ label: "sticky notes", promise: invoke("restore_pinned_notes") });
  }

  const results = await Promise.allSettled(tasks.map(({ promise }) => promise));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[toolWindows] preload ${tasks[index].label} failed:`, result.reason);
    }
  });
}

/**
 * 根据工具 ID 打开对应的工具窗口。
 * 用于 ToolPalette 激活和 FloatingOrb 自启动两种场景。
 * 返回 true 表示成功打开，false 表示该工具不支持窗口打开或打开失败。
 */
export async function openToolWindow(toolId: string): Promise<boolean> {
  try {
    if (toolId === "utility-hub") {
      await ensureUtilityHubWindow();
      await invoke("start_utility_hub");
      return true;
    }
    if (toolId === "system-cleaner") {
      await ensureSystemCleanerWindow();
      await invoke("show_system_cleaner_window");
      return true;
    }

    if (toolId === "system-monitor") {
      const monitorWindow = await ensureMonitorWindow();
      if (monitorWindow.created) {
        await waitForNewMonitorWindowReady();
      }
      await invoke("show_monitor_window");
      return true;
    }
    if (toolId === "timer") {
      await ensureTimerWindow();
      await invoke("show_timer_window");
      return true;
    }
    if (toolId === "todo") {
      await ensureTodoWindow();
      await invoke("show_todo_window");
      return true;
    }
    if (toolId === "sticky-notes") {
      await ensureStickyNotesManagerWindow();
      await invoke("show_sticky_notes_manager");
      return true;
    }
    // 其他工具（screenshot、recording、text-toolbar）是按需触发的，
    // 自启动打开窗口对它们无意义，忽略
    return false;
  } catch (err) {
    console.error(`openToolWindow(${toolId}) failed:`, err);
    return false;
  }
}
