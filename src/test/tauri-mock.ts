import { vi } from "vitest";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/api/event
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(handler);
    return Promise.resolve(() => {
      listeners.get(event)?.delete(handler);
    });
  }),
  UnlistenFn: undefined,
}));

// Mock @tauri-apps/api/webviewWindow
const mockSetSize = vi.fn().mockResolvedValue(undefined);
const mockHide = vi.fn().mockResolvedValue(undefined);
const mockStartDragging = vi.fn().mockResolvedValue(undefined);
const mockSetAlwaysOnBottom = vi.fn().mockResolvedValue(undefined);
const mockSetAlwaysOnTop = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
      return Promise.resolve(() => {
        listeners.get(event)?.delete(handler);
      });
    }),
    hide: mockHide,
    show: vi.fn().mockResolvedValue(undefined),
    setSize: mockSetSize,
    startDragging: mockStartDragging,
    setAlwaysOnBottom: mockSetAlwaysOnBottom,
    setAlwaysOnTop: mockSetAlwaysOnTop,
  })),
}));

// Mock @tauri-apps/api/dpi
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class LogicalSize {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
  },
}));

// 测试辅助：触发 mock 事件
export function emitMockEvent(event: string, payload: unknown) {
  listeners.get(event)?.forEach((handler) => handler({ payload }));
}

// 测试辅助：清理所有监听器
export function clearMockListeners() {
  listeners.clear();
}

export { mockSetSize, mockHide };
