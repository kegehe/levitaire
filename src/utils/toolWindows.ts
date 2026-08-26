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
import { BACKEND_TOOLS, FLOATING_TOOLS } from "../tools/registry";

type ToolWindowLabel =
  | "screenshot-overlay"
  | "monitor-overlay"
  | "recording-controls"
  | "long-capture-controls"
  | "long-capture-frame"
  | "context-menu"
  | "pomodoro-overlay"
  | "sketch-overlay";

const pendingWindows = new Map<ToolWindowLabel, Promise<WebviewWindowInstance>>();
let screenshotOverlayReady = false;
let screenshotOverlayReadyListener: Promise<UnlistenFn> | undefined;
const screenshotOverlayReadyWaiters = new Set<() => void>();
let monitorReady = false;
let monitorReadyListener: Promise<UnlistenFn> | undefined;
const monitorReadyWaiters = new Set<() => void>();
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
let pomodoroReady = false;
let pomodoroReadyListener: Promise<UnlistenFn> | undefined;
const pomodoroReadyWaiters = new Set<() => void>();
let sketchReady = false;
let sketchReadyListener: Promise<UnlistenFn> | undefined;
const sketchReadyWaiters = new Set<() => void>();
let sketchCloseHandlerReady = false;

function startReadyRequestRetry(target: ToolWindowLabel, requestEvent: string): number {
  const request = () => {
    void emitTo(target, requestEvent).catch(() => {});
  };
  request();
  return window.setInterval(request, 100);
}

async function ensureSketchCloseHandler(window: WebviewWindowInstance): Promise<void> {
  if (sketchCloseHandlerReady) return;
  await window.onCloseRequested(async (event) => {
    event.preventDefault();
    await window.hide().catch(() => {});
  });
  sketchCloseHandlerReady = true;
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
    const retryTimer = startReadyRequestRetry("screenshot-overlay", "screenshot-overlay-ready-request");
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
    const retryTimer = startReadyRequestRetry("long-capture-frame", "long-capture-frame-ready-request");
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
    const retryTimer = startReadyRequestRetry("long-capture-controls", "long-capture-controls-ready-request");
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
    const retryTimer = startReadyRequestRetry("recording-controls", "recording-controls-ready-request");
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

async function preparePomodoroWindowReadyListener(): Promise<void> {
  if (!pomodoroReadyListener) {
    pomodoroReadyListener = listen("pomodoro-window-ready", () => {
      pomodoroReady = true;
      pomodoroReadyWaiters.forEach((resolve) => resolve());
      pomodoroReadyWaiters.clear();
    });
  }
  await pomodoroReadyListener;
}

export async function waitForPomodoroWindowReady(): Promise<void> {
  await preparePomodoroWindowReadyListener();
  if (pomodoroReady) return;

  await new Promise<void>((resolve, reject) => {
    const retryTimer = startReadyRequestRetry("pomodoro-overlay", "pomodoro-window-ready-request");
    const timeout = window.setTimeout(() => {
      window.clearInterval(retryTimer);
      pomodoroReadyWaiters.delete(onReady);
      reject(new Error("番茄钟窗口初始化超时"));
    }, 5000);
    const onReady = () => {
      window.clearInterval(retryTimer);
      window.clearTimeout(timeout);
      resolve();
    };
    pomodoroReadyWaiters.add(onReady);
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
    // it back to the compact toolbar size before the next session.
    await existing.setSize(new LogicalSize(300, 64)).catch(() => {});
    await existing.hide().catch(() => {});
    await waitForLongCaptureControlsWindowReady();
    return existing;
  }
  longCaptureControlsReady = false;
  const window = await createToolWindow("long-capture-controls", {
    title: "Levitaire Long Screenshot",
    width: 300,
    height: 64,
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
  const window = await createToolWindow("context-menu", {
    title: "Levitaire Context Menu",
    width: CONTEXT_MENU_WIDTH,
    height: contextMenuHeight("pin"),
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
  await window.setSize(new LogicalSize(width, height));
  await window.setPosition(
    clampContextMenuPosition(
      request,
      Math.round(width * scaleFactor),
      Math.round(height * scaleFactor),
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
  // 复用策略同 ensurePomodoroWindow。
  const existing = await WebviewWindow.getByLabel("monitor-overlay");
  if (existing) {
    await waitForNewMonitorWindowReady();
    return { window: existing, created: false };
  }

  await prepareMonitorWindowReadyListener();
  monitorReady = false;
  const window = await createToolWindow("monitor-overlay", {
    title: "Levitaire Monitor",
    width: 300,
    height: 520,
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

/** 创建或复用番茄钟悬浮窗（隐藏，待 ready 后由 show_pomodoro_window 显示）。
 * 窗口已存在时直接复用，保留用户拖拽后的位置与组件状态；计时由后端持有，不受影响。 */
export async function ensurePomodoroWindow(): Promise<WebviewWindowInstance> {
  const existing = await WebviewWindow.getByLabel("pomodoro-overlay");
  if (existing) {
    await waitForPomodoroWindowReady();
    return existing;
  }
  await preparePomodoroWindowReadyListener();
  pomodoroReady = false;
  const window = await createToolWindow("pomodoro-overlay", {
    title: "Levitaire Pomodoro",
    width: 240,
    height: 240,
    resizable: false,
    transparent: true,
    decorations: false,
    // 视觉边界由 .pomo-body 的 CSS border 负责（同 monitor-overlay）
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
    backgroundColor: [0, 0, 0, 0],
  });
  await waitForPomodoroWindowReady();
  return window;
}

/**
 * 根据工具 ID 打开对应的工具窗口。
 * 用于 ToolPalette 激活和 FloatingOrb 自启动两种场景。
 * 返回 true 表示成功打开，false 表示该工具不支持窗口打开或打开失败。
 */
/**
 * Preload every tool that is currently enabled in the persisted backend
 * configuration. Windows remain hidden; this only moves WebView creation and
 * lazy chunk loading to application startup so first use is immediate.
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
  const enabledIds = new Set(
    enabledResults.filter(({ enabled }) => enabled).map(({ id }) => id),
  );
  const tasks: Array<{ label: string; promise: Promise<unknown> }> = [];

  for (const tool of FLOATING_TOOLS) {
    if (enabledIds.has(tool.id)) {
      tasks.push({ label: `${tool.id} component`, promise: tool.loader() });
    }
  }

  // Screenshot and recording share the selection overlay. A screenshot also
  // owns the long-capture and contextual-menu WebViews used after selection.
  if (enabledIds.has("screenshot") || enabledIds.has("recording")) {
    tasks.push({ label: "screenshot overlay", promise: ensureScreenshotWindow() });
  }
  if (enabledIds.has("screenshot")) {
    tasks.push(
      { label: "long capture controls", promise: ensureLongCaptureControlsWindow() },
      { label: "long capture frame", promise: ensureLongCaptureFrameWindow() },
      { label: "context menu", promise: ensureContextMenuWindow() },
    );
  }
  if (enabledIds.has("sketch")) {
    tasks.push({ label: "sketch overlay", promise: ensureSketchWindow() });
  }
  if (enabledIds.has("recording")) {
    tasks.push({ label: "recording controls", promise: ensureRecordingControlsWindow() });
  }
  if (enabledIds.has("system-monitor")) {
    tasks.push({
      label: "system monitor",
      promise: ensureMonitorWindow().then(async ({ created }) => {
        if (created) await waitForNewMonitorWindowReady();
      }),
    });
  }
  if (enabledIds.has("pomodoro")) {
    tasks.push({ label: "pomodoro", promise: ensurePomodoroWindow() });
  }
  if (enabledIds.has("quick-input")) {
    tasks.push({ label: "quick input", promise: invoke("ensure_quick_input_window") });
  }

  const results = await Promise.allSettled(tasks.map(({ promise }) => promise));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[toolWindows] preload ${tasks[index].label} failed:`, result.reason);
    }
  });
}

export async function openToolWindow(toolId: string): Promise<boolean> {
  try {
    if (toolId === "system-monitor") {
      const monitorWindow = await ensureMonitorWindow();
      if (monitorWindow.created) {
        await waitForNewMonitorWindowReady();
      }
      await invoke("show_monitor_window");
      return true;
    }
    if (toolId === "pomodoro") {
      await ensurePomodoroWindow();
      await invoke("show_pomodoro_window");
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
