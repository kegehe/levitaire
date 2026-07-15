import { WebviewWindow, type WebviewWindow as WebviewWindowInstance } from "@tauri-apps/api/webviewWindow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type ToolWindowLabel = "screenshot-overlay" | "voice-overlay" | "monitor-overlay" | "recording-controls";

const pendingWindows = new Map<ToolWindowLabel, Promise<WebviewWindowInstance>>();
let monitorReady = false;
let monitorReadyListener: Promise<UnlistenFn> | undefined;
const monitorReadyWaiters = new Set<() => void>();

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

function createToolWindow(
  label: ToolWindowLabel,
  options: ConstructorParameters<typeof WebviewWindow>[1],
): Promise<WebviewWindowInstance> {
  const pending = pendingWindows.get(label);
  if (pending) return pending;

  const promise = (async () => {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      // 验证窗口是否真的还活着：尝试获取内部尺寸，失败说明已被销毁
      try {
        await existing.innerSize();
        return existing;
      } catch {
        // 窗口已销毁（Rust 侧已不存在），JS 残留引用无效，清除后重建
        // continue to create new
      }
    }

    const win = new WebviewWindow(label, {
      url: "index.html",
      visible: false,
      ...options,
    });

    return new Promise<WebviewWindowInstance>((resolve, reject) => {
      win.once("tauri://created", () => resolve(win));
      win.once("tauri://error", (event) => reject(event.payload));
    });
  })().finally(() => {
    pendingWindows.delete(label);
  });

  pendingWindows.set(label, promise);
  return promise;
}

export function ensureScreenshotWindow(): Promise<WebviewWindowInstance> {
  return createToolWindow("screenshot-overlay", {
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

export function ensureRecordingControlsWindow(): Promise<WebviewWindowInstance> {
  return createToolWindow("recording-controls", {
    title: "Floast Recording Controls",
    width: 136,
    height: 128,
    resizable: false,
    transparent: true,
    decorations: false,
    shadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    x: 100,
    y: 100,
  });
}

export async function ensureMonitorWindow(): Promise<{ window: WebviewWindowInstance; created: boolean }> {
  const existing = await WebviewWindow.getByLabel("monitor-overlay");
  if (existing) {
    try {
      await existing.innerSize();
      return { window: existing, created: false };
    } catch {
      monitorReady = false;
    }
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
