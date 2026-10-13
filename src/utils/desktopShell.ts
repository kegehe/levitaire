/**
 * 桌面外壳守卫 —— 让 WebView2 表现得像原生桌面应用，而不是浏览器页面。
 *
 * 安装版里 WebView2 会把网页端的行为一起带进来：右键弹出「刷新 / 另存为 / 打印 / 检查」
 * 的默认菜单，F5、Ctrl+P、Ctrl+S 之类的浏览器快捷键也会生效。这里做两层处理：
 *
 * 1. 原生层：调用后端 `harden_webview_window`，关掉 WebView2 自带的右键菜单
 *    （发布版再关掉浏览器快捷键）。渲染层只能拦住 DOM 区域的右键，滚动条等
 *    非 DOM 区域由 WebView2 自己画菜单，必须靠原生设置。
 * 2. 渲染层：document 级捕获监听拦掉右键默认行为。可编辑区域改用应用自绘的文本菜单
 *    （剪切 / 复制 / 粘贴 / 全选），避免用户失去鼠标右键粘贴的能力；其余区域右键不弹任何菜单，
 *    需要菜单的地方（悬浮球、托盘、贴图）都由应用自己的原生菜单负责。
 *
 * 另外拦掉两件事：外部文件被拖进窗口（WebView2 会直接导航到该文件）与发布环境下的
 * 浏览器快捷键。文本编辑类快捷键（Ctrl+X/C/V/A/Z）一律不碰。
 */

import { invoke } from "@tauri-apps/api/core";
import { hideTextContextMenu, showTextContextMenu, showTextSelectionMenu } from "./textContextMenu";

/** 允许弹出自绘文本菜单的 input 类型（其余类型不支持选区 API，直接不弹菜单） */
const TEXTUAL_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);

/** 可编辑宿主：多行输入、单行输入、声明了 contenteditable 的容器 */
const EDITABLE_SELECTOR =
  "textarea, input, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']";

/** 发布环境下屏蔽的浏览器快捷键（键名小写比较） */
const BLOCKED_PLAIN_KEYS = new Set(["f5", "f7", "f12"]);
const BLOCKED_CTRL_KEYS = new Set(["r", "p", "s", "u", "o"]);
const BLOCKED_CTRL_SHIFT_KEYS = new Set(["r", "i", "j", "c"]);

/** 发布构建才拦浏览器快捷键；开发构建保留 F12 / Ctrl+R，否则没法调试 */
function isHardenedRuntime(): boolean {
  return import.meta.env.PROD;
}

/**
 * 判断右键目标是否落在可编辑区域内，是则返回该编辑宿主。
 *
 * 用 closest 而不是逐层判断 isContentEditable：contenteditable 会被子节点继承，
 * 逐层判断会停在最内层的普通子节点上，「全选」就只能选到那一个子节点。
 */
export function findEditableHost(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : null;
  const host = element?.closest<HTMLElement>(EDITABLE_SELECTOR) ?? null;
  if (!host) return null;
  if (host instanceof HTMLInputElement) {
    return TEXTUAL_INPUT_TYPES.has(host.type) ? host : null;
  }
  return host;
}

/**
 * 判断按键是否命中需要屏蔽的浏览器快捷键。
 * 纯函数，便于单独验证发布环境的拦截清单。
 */
export function isBlockedBrowserShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  const key = event.key.toLowerCase();
  if (BLOCKED_PLAIN_KEYS.has(key)) return true;
  // 只认 Ctrl（含 Cmd）组合，避免误伤 Alt 组合与纯键
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (event.shiftKey) return BLOCKED_CTRL_SHIFT_KEYS.has(key);
  return BLOCKED_CTRL_KEYS.has(key);
}

/**
 * 右键接管的注册口。
 *
 * 有些窗口对右键有**比文本菜单更合适**的语义，例如便利贴里右键一张图片应该是
 * 「复制图片 / 删除图片」而不是「剪切 / 复制 / 粘贴 / 全选」（后者在没选中东西时
 * 复制是灰的，用户得先框选图片才能复制）。这类窗口在挂载时注册一个拦截器：
 * 返回 true 表示「这次右键我已经处理了」，返回 false 则继续走通用文本菜单。
 *
 * 只有一份：每个窗口一张页面，注册者（便利贴）在卸载时清掉，避免拿着已卸载组件的闭包。
 */
export type ContextMenuInterceptor = (event: MouseEvent) => boolean;

let contextMenuInterceptor: ContextMenuInterceptor | null = null;

/** 注册 / 注销右键拦截器（传 null 注销）。 */
export function setContextMenuInterceptor(interceptor: ContextMenuInterceptor | null): void {
  contextMenuInterceptor = interceptor;
}

function handleContextMenu(event: MouseEvent): void {
  // 无论是否需要菜单，先无条件阻止 WebView2 默认菜单
  event.preventDefault();
  if (contextMenuInterceptor?.(event)) return;
  const editable = findEditableHost(event.target);
  if (editable) {
    showTextContextMenu({ ...menuPoint(event, editable), target: editable });
    return;
  }
  // 非编辑区域：只有页面里选中了文字时才给「复制」，其余情况不弹任何网页菜单
  // （应用自己的菜单走原生/自绘通道：悬浮球、托盘、贴图）
  if (hasTextSelection()) {
    showTextSelectionMenu(
      menuPoint(event, event.target instanceof HTMLElement ? event.target : null),
    );
    return;
  }
  hideTextContextMenu();
}

/** 页面里是否存在非折叠的文字选区（输入框内的选区由 findEditableHost 覆盖）。 */
function hasTextSelection(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return selection.toString().trim().length > 0;
}

/** 键盘（Shift+F10 / 菜单键）触发的 contextmenu 坐标为 0，退回元素位置。 */
function menuPoint(event: MouseEvent, target: HTMLElement | null): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = target?.getBoundingClientRect();
  return rect ? { x: rect.left + 8, y: rect.bottom - 4 } : { x: 12, y: 12 };
}

function handleKeyDown(event: KeyboardEvent): void {
  if (!isHardenedRuntime()) return;
  if (isBlockedBrowserShortcut(event)) event.preventDefault();
}

function handleExternalDrag(event: DragEvent): void {
  const types = event.dataTransfer?.types;
  if (!types) return;
  // 只拦外部文件/URI 拖入；应用内部拖拽排序用的是 text/plain，不受影响
  if (Array.from(types).some((type) => type === "Files" || type === "text/uri-list")) {
    event.preventDefault();
  }
}

function applyNativeHardening(): void {
  try {
    // 后端逐窗口关闭 WebView2 默认右键菜单（发布版同时关闭浏览器快捷键）
    void Promise.resolve(invoke("harden_webview_window")).catch((error: unknown) => {
      console.warn("[desktopShell] WebView2 加固失败", error);
    });
  } catch (error) {
    console.warn("[desktopShell] WebView2 加固失败", error);
  }
}

let dispose: (() => void) | undefined;

/**
 * 安装桌面外壳守卫。每个窗口的入口（src/main.tsx）调用一次即可。
 * 返回卸载函数，重复调用返回同一份（测试里用来还原监听）。
 */
export function installDesktopShell(): () => void {
  if (dispose) return dispose;

  document.addEventListener("contextmenu", handleContextMenu, true);
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("dragover", handleExternalDrag, true);
  window.addEventListener("drop", handleExternalDrag, true);
  // 窗口失焦时收起文本菜单，避免残留浮层
  window.addEventListener("blur", hideTextContextMenu);

  dispose = () => {
    document.removeEventListener("contextmenu", handleContextMenu, true);
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("dragover", handleExternalDrag, true);
    window.removeEventListener("drop", handleExternalDrag, true);
    window.removeEventListener("blur", hideTextContextMenu);
    hideTextContextMenu();
    // 拦截器由各窗口自己维护：守卫卸载时一并断掉，避免卸载后还指向旧闭包
    contextMenuInterceptor = null;
    dispose = undefined;
  };

  // 当前窗口 label 由后端从调用方解析，前端无需传参
  applyNativeHardening();

  return dispose;
}
