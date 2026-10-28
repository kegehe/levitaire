import { vi } from "vitest";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  // 便利贴等组件用 convertFileSrc 把本地路径转成 asset: URL 预览；测试环境直接透传。
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${String(path).replace(/\\/g, "/")}`),
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
/**
 * 原生窗口可见性。默认 true（多数用例里的窗口是"显示中"的）。
 * 用例可覆盖，例如面板的「点悬浮球开合」分支按它决定 show 还是 hide：
 *   mockIsVisible.mockResolvedValueOnce(false) // 模拟面板已被原生流程收起
 */
const mockIsVisible = vi.fn().mockResolvedValue(true);
const mockStartDragging = vi.fn().mockResolvedValue(undefined);
const mockStartResizeDragging = vi.fn().mockResolvedValue(undefined);
const mockSetAlwaysOnBottom = vi.fn().mockResolvedValue(undefined);
const mockSetAlwaysOnTop = vi.fn().mockResolvedValue(undefined);

// 可配置的窗口属性，测试用 setMockWindow 设置
let mockWindowLabel = "toolbar";
let mockScaleFactor = 1;
// 原生窗口内尺寸（物理像素）：手动改大小 / 拖动窗口边后的读回值
let mockInnerSizeValue = { width: 400, height: 50 };
const mockInnerSize = vi.fn(() => ({ ...mockInnerSizeValue }));
const mockFocusHandlers: Array<(p: { payload: boolean }) => void> = [];
// onResized 的回调带 payload（新的物理尺寸），与 Tauri 的 WindowEvent::Resized 一致
const mockResizeHandlers: Array<(event: { payload: { width: number; height: number } }) => void> =
  [];

export function setMockWindow(opts: { label?: string; scaleFactor?: number } = {}) {
  if (opts.label !== undefined) mockWindowLabel = opts.label;
  if (opts.scaleFactor !== undefined) mockScaleFactor = opts.scaleFactor;
}

/** 设置 innerSize() 的返回值（物理像素，测试里配合 scaleFactor 换算成逻辑尺寸） */
export function setMockInnerSize(size: { width: number; height: number }) {
  mockInnerSizeValue = size;
}

/** 触发一次原生 resize（模拟用户拖窗口边缘 / 拖手柄），payload 是新的物理尺寸 */
export function emitMockResize(size: { width: number; height: number }) {
  mockResizeHandlers.forEach((handler) => handler({ payload: size }));
}

// onScaleChanged 的回调带新的缩放系数，与 Tauri 的 WindowEvent::ScaleFactorChanged 一致。
// 窗口被拖到另一台缩放不同的显示器时，系统会先发这个、随后再发一次 Resized。
const mockScaleChangeHandlers: Array<
  (event: { payload: { scaleFactor: number; size: { width: number; height: number } } }) => void
> = [];

/** 触发一次缩放变化（模拟窗口被拖到另一台缩放不同的显示器） */
export function emitMockScaleChanged(scaleFactor: number) {
  const size = { ...mockInnerSizeValue };
  mockScaleFactor = scaleFactor;
  mockScaleChangeHandlers.forEach((handler) => handler({ payload: { scaleFactor, size } }));
}

// 拖放事件（便签窗把图片文件拖进来用）
const mockDragDropHandlers: Array<(event: { payload: unknown }) => void> = [];

export function emitMockDragDrop(payload: unknown) {
  mockDragDropHandlers.forEach((handler) => handler({ payload }));
}

/**
 * 清掉窗口事件回调（resize / 拖放）。
 * 组件卸载后 testing-library 不会自动摘掉这些 mock 回调，多个用例串起来时
 * emit 会打到已卸载组件的闭包上，断言次数就会莫名其妙地多出来。
 */
export function clearMockWindowEventHandlers() {
  mockResizeHandlers.length = 0;
  mockScaleChangeHandlers.length = 0;
  mockDragDropHandlers.length = 0;
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
    innerSize: mockInnerSize,
    hide: mockHide,
    show: vi.fn().mockResolvedValue(undefined),
    setSize: mockSetSize,
    center: vi.fn().mockResolvedValue(undefined),
    // 长截图控制条靠它拦截原生关闭（窗口一关就再也没有按钮能结束会话）
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
    setMinSize: vi.fn().mockResolvedValue(undefined),
    startDragging: mockStartDragging,
    startResizeDragging: mockStartResizeDragging,
    onDragDropEvent: vi.fn((handler: (event: { payload: unknown }) => void) => {
      mockDragDropHandlers.push(handler);
      return Promise.resolve(() => {
        const index = mockDragDropHandlers.indexOf(handler);
        if (index >= 0) mockDragDropHandlers.splice(index, 1);
      });
    }),
    setFocusable: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnBottom: mockSetAlwaysOnBottom,
    setAlwaysOnTop: mockSetAlwaysOnTop,
    // 自绘标题栏（TitleBar）用到的窗口控制方法
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    isFocused: vi.fn().mockResolvedValue(false),
    isVisible: mockIsVisible,
    close: vi.fn().mockResolvedValue(undefined),
    onResized: vi.fn((handler: (event: { payload: { width: number; height: number } }) => void) => {
      mockResizeHandlers.push(handler);
      return Promise.resolve(() => {
        const index = mockResizeHandlers.indexOf(handler);
        if (index >= 0) mockResizeHandlers.splice(index, 1);
      });
    }),
    onMoved: vi.fn(() => Promise.resolve(() => {})),
    onScaleChanged: vi.fn(
      (
        handler: (event: {
          payload: { scaleFactor: number; size: { width: number; height: number } };
        }) => void,
      ) => {
        mockScaleChangeHandlers.push(handler);
        return Promise.resolve(() => {
          const index = mockScaleChangeHandlers.indexOf(handler);
          if (index >= 0) mockScaleChangeHandlers.splice(index, 1);
        });
      },
    ),
  })),
}));

// Mock @tauri-apps/api/dpi
// PhysicalPosition 供录屏控制栏 `controls.setPosition(...)` 使用；缺了它会让
// 区域录制路径在测试里直接抛异常，整条路径再也测不到。
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class LogicalSize {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
  },
  PhysicalPosition: class PhysicalPosition {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
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

export {
  mockSetSize,
  mockHide,
  mockIsVisible,
  mockStartDragging,
  mockStartResizeDragging,
  mockInnerSize,
  menuState,
};
