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
  emit: vi.fn((event: string, payload: unknown) => {
    listeners.get(event)?.forEach((handler) => handler({ payload }));
    return Promise.resolve();
  }),
  UnlistenFn: undefined,
}));

// Mock @tauri-apps/api/webviewWindow
const mockSetSize = vi.fn().mockResolvedValue(undefined);
const mockHide = vi.fn().mockResolvedValue(undefined);
const mockStartDragging = vi.fn().mockResolvedValue(undefined);
const mockSetAlwaysOnBottom = vi.fn().mockResolvedValue(undefined);
const mockSetAlwaysOnTop = vi.fn().mockResolvedValue(undefined);

// 可配置的窗口属性，测试用 setMockWindow 设置
let mockWindowLabel = "toolbar";
let mockScaleFactor = 1;
const mockFocusHandlers: Array<(p: { payload: boolean }) => void> = [];

export function setMockWindow(opts: { label?: string; scaleFactor?: number } = {}) {
  if (opts.label !== undefined) mockWindowLabel = opts.label;
  if (opts.scaleFactor !== undefined) mockScaleFactor = opts.scaleFactor;
}

// 触发 focus 变化（测试失焦保护用）
export function emitMockFocus(focused: boolean) {
  mockFocusHandlers.forEach((h) => h({ payload: focused }));
}

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    get label() {
      return mockWindowLabel;
    },
    listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
      return Promise.resolve(() => {
        listeners.get(event)?.delete(handler);
      });
    }),
    onFocusChanged: vi.fn((handler: (p: { payload: boolean }) => void) => {
      mockFocusHandlers.push(handler);
      return Promise.resolve(() => {
        const i = mockFocusHandlers.indexOf(handler);
        if (i >= 0) mockFocusHandlers.splice(i, 1);
      });
    }),
    scaleFactor: vi.fn(() => Promise.resolve(mockScaleFactor)),
    outerPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
    innerSize: vi.fn(() => ({ width: 400, height: 50 })),
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
