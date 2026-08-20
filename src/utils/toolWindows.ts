import {
  WebviewWindow,
  type WebviewWindow as WebviewWindowInstance,
} from "@tauri-apps/api/webviewWindow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type ToolWindowLabel =
  | "screenshot-overlay"
  | "monitor-overlay"
  | "recording-controls"
  | "pomodoro-overlay";

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
let pomodoroReady = false;
let pomodoroReadyListener: Promise<UnlistenFn> | undefined;
const pomodoroReadyWaiters = new Set<() => void>();

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
    const onReady = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
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
    const timeout = window.setTimeout(() => {
      monitorReadyWaiters.delete(onReady);
      reject(new Error("系统监控窗口初始化超时"));
    }, 5000);
    const onReady = () => {
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

async function waitForRecordingControlsWindowReady(): Promise<void> {
  await prepareRecordingControlsReadyListener();
  if (recordingControlsReady) return;

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
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
    const timeout = window.setTimeout(() => {
      pomodoroReadyWaiters.delete(onReady);
      reject(new Error("番茄钟窗口初始化超时"));
    }, 5000);
    const onReady = () => {
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
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      console.warn(`[toolWindows] destroying existing window "${label}" before recreating`);
      try {
        await existing.destroy();
      } catch (e) {
        console.warn(`[toolWindows] destroy failed:`, e);
      }
      // 轮询等待窗口完全销毁
      for (let i = 0; i < 20; i++) {
        const check = await WebviewWindow.getByLabel(label);
        if (!check) break;
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      console.warn(`[toolWindows] window "${label}" destroyed, creating new one`);
    }

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
      win.once("tauri://error", (event) => reject(event.payload));
    });
  })().finally(() => {
    pendingWindows.delete(label);
  });

  pendingWindows.set(label, promise);
  return promise;
}

export async function ensureScreenshotWindow(): Promise<WebviewWindowInstance> {
  await prepareScreenshotOverlayReadyListener();
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
    return existing;
  }
  await preparePomodoroWindowReadyListener();
  pomodoroReady = false;
  const window = await createToolWindow("pomodoro-overlay", {
    title: "Levitaire Pomodoro",
    width: 240,
    height: 260,
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
