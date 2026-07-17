import { WebviewWindow, type WebviewWindow as WebviewWindowInstance } from "@tauri-apps/api/webviewWindow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type ToolWindowLabel = "screenshot-overlay" | "voice-overlay" | "monitor-overlay" | "recording-controls";

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
      try { await existing.destroy(); } catch (e) { console.warn(`[toolWindows] destroy failed:`, e); }
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
    title: "Floast Screenshot",
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
  });
  await waitForScreenshotOverlayReady();
  return window;
}

export function ensureVoiceWindow(): Promise<WebviewWindowInstance> {
  return createToolWindow("voice-overlay", {
    title: "Floast Voice",
    width: 260,
    height: 140,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
  });
}

export async function ensureRecordingControlsWindow(): Promise<WebviewWindowInstance> {
  await prepareRecordingControlsReadyListener();
  recordingControlsReady = false;
  const window = await createToolWindow("recording-controls", {
    title: "Floast Recording Controls",
    width: 136,
    height: 128,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
  });
  await waitForRecordingControlsWindowReady();
  return window;
}

export async function ensureMonitorWindow(): Promise<{ window: WebviewWindowInstance; created: boolean }> {
  const existing = await WebviewWindow.getByLabel("monitor-overlay");
  if (existing) {
    try { await existing.destroy(); } catch { /* ignore */ }
    await new Promise<void>((r) => setTimeout(r, 200));
    monitorReady = false;
  }

  await prepareMonitorWindowReadyListener();
  monitorReady = false;
  const window = await createToolWindow("monitor-overlay", {
    title: "Floast Monitor",
    width: 300,
    height: 520,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    x: 100,
    y: 100,
  });
  return { window, created: true };
}
