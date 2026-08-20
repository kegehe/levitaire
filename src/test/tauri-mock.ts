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
    setFocusable: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnBottom: mockSetAlwaysOnBottom,
    setAlwaysOnTop: mockSetAlwaysOnTop,
    // 自绘标题栏（TitleBar）用到的窗口控制方法
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    onMoved: vi.fn(() => Promise.resolve(() => {})),
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

// Mock @tauri-apps/api/menu（FloatingOrb 右键菜单）
// 模拟 Tauri 的 MenuChannels 全局 id → action 映射，供测试触发菜单项
const menuState = vi.hoisted(() => {
  const items = new Map<string, { id: string; action?: (id: string) => void }>();
  return {
    items,
    popup: vi.fn(async () => undefined),
    registerItem: (opts: { id?: string; action?: (id: string) => void }) => {
      const item = { id: opts.id ?? "", action: opts.action };
      items.set(item.id, item);
      return item;
    },
  };
});

vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: {
    new: vi.fn(async (opts: { id?: string; action?: (id: string) => void }) =>
      menuState.registerItem(opts),
    ),
  },
  PredefinedMenuItem: {
    new: vi.fn(async () => ({ id: "__separator__", kind: "predefined" })),
  },
  Menu: {
    new: vi.fn(async (opts: { items?: unknown[] }) => ({
      items: opts.items ?? [],
      popup: menuState.popup,
    })),
  },
}));

// 测试辅助：触发 mock 事件
export function emitMockEvent(event: string, payload: unknown) {
  listeners.get(event)?.forEach((handler) => handler({ payload }));
}

// 测试辅助：触发某个菜单项的 action（模拟点击原生菜单项）
export function triggerMenuAction(id: string) {
  menuState.items.get(id)?.action?.(id);
}

// 测试辅助：清理所有监听器
export function clearMockListeners() {
  listeners.clear();
}

export { mockSetSize, mockHide, menuState };
