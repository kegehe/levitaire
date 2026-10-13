/**
 * 应用自绘的文本右键菜单。
 *
 * WebView2 自带的右键菜单已在原生层关闭（见 src-tauri/src/webview_hardening.rs），
 * 这类菜单改用带应用样式的自绘菜单替代，同时不出现刷新 / 另存为 / 打印 等网页端菜单项：
 *
 * - 可编辑区域（input / textarea / contenteditable）：剪切 / 复制 / 粘贴 / 全选
 * - 页面里选中了文字的非编辑区域：复制
 *
 * 打开菜单时会先快照选区，动作执行前再还原：右键菜单自身的点击会抢焦点，
 * 不还原就会把用户选中的文字清掉。
 */

import { invoke } from "@tauri-apps/api/core";

const MENU_CLASS = "app-text-menu";
/** 菜单与窗口边缘之间的最小留白 */
const VIEWPORT_MARGIN = 6;

type EditableKind = "input" | "textarea" | "contenteditable";

interface EditableState {
  element: HTMLElement;
  kind: EditableKind;
  /** input / textarea 的选区 */
  start: number;
  end: number;
  /** contenteditable 的选区 */
  range: Range | null;
  hasSelection: boolean;
}

export interface AppMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  run: () => void;
}

let menuRoot: HTMLDivElement | null = null;
let listenersBound = false;

/** 记录打开菜单时的选区，供动作执行前还原。 */
function snapshotSelection(element: HTMLElement): EditableState {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    return {
      element,
      kind: element instanceof HTMLTextAreaElement ? "textarea" : "input",
      start,
      end,
      range: null,
      hasSelection: end > start,
    };
  }

  let range: Range | null = null;
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const candidate = selection.getRangeAt(0);
    const container = candidate.commonAncestorContainer;
    if (container === element || element.contains(container)) {
      range = candidate.cloneRange();
    }
  }
  return {
    element,
    kind: "contenteditable",
    start: 0,
    end: 0,
    range,
    hasSelection: Boolean(range && !range.collapsed),
  };
}

/** 把焦点与选区还给原来的编辑区域，再执行命令。 */
function restoreSelection(state: EditableState): void {
  state.element.focus();
  if (state.kind === "contenteditable") {
    if (!state.range) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(state.range);
    return;
  }
  try {
    (state.element as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
      state.start,
      state.end,
    );
  } catch {
    // number / date 等类型不支持选区 API，忽略即可
  }
}

function runExecCommand(command: string, value?: string): boolean {
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

/**
 * 读取剪贴板文本：优先走后端（Windows 剪贴板，结果确定），
 * 后端不可用时回退到浏览器剪贴板 API。
 */
async function readClipboardText(): Promise<string> {
  try {
    const text = await invoke<string>("clipboard_read_text");
    if (typeof text === "string") return text;
  } catch {
    // 回退到 navigator.clipboard
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

/** execCommand 不可用时的兜底：直接写 value 并补发 input 事件，保证 React 受控输入同步。 */
function insertWithValueSetter(state: EditableState, text: string): void {
  const element = state.element;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) return;
  setter.call(element, element.value.slice(0, state.start) + text + element.value.slice(state.end));
  element.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = state.start + text.length;
  try {
    element.setSelectionRange(caret, caret);
  } catch {
    // 忽略：不支持选区的输入类型
  }
}

async function pasteInto(state: EditableState): Promise<void> {
  const text = await readClipboardText();
  if (!text) return;
  // 单行输入框不含换行（与浏览器行为一致），多行输入统一成 LF
  const payload =
    state.kind === "input" ? text.replace(/\r\n|\r|\n/g, " ") : text.replace(/\r\n?/g, "\n");
  restoreSelection(state);
  if (runExecCommand("insertText", payload)) return;
  insertWithValueSetter(state, payload);
}

function cutOrCopyFrom(state: EditableState, command: "cut" | "copy"): void {
  restoreSelection(state);
  runExecCommand(command);
}

function selectAllIn(state: EditableState): void {
  state.element.focus();
  if (state.element instanceof HTMLInputElement || state.element instanceof HTMLTextAreaElement) {
    state.element.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(state.element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function clampPosition(root: HTMLDivElement, x: number, y: number): void {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - root.offsetWidth - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - root.offsetHeight - VIEWPORT_MARGIN);
  root.style.left = `${Math.min(Math.max(x, VIEWPORT_MARGIN), maxLeft)}px`;
  root.style.top = `${Math.min(Math.max(y, VIEWPORT_MARGIN), maxTop)}px`;
}

function handleDocumentMouseDown(event: MouseEvent): void {
  if (!menuRoot) return;
  if (event.target instanceof Node && menuRoot.contains(event.target)) return;
  hideTextContextMenu();
}

function handleDocumentKeyDown(event: KeyboardEvent): void {
  if (!menuRoot) return;
  // 不阻止默认行为也不停止传播：只收起菜单，Escape 交给页面原有逻辑处理
  if (event.key === "Escape") hideTextContextMenu();
}

function bindGlobalListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener("mousedown", handleDocumentMouseDown, true);
  // 绑在 window 上：键盘事件从焦点元素一路冒泡到这里，且不依赖 body 是否存在
  window.addEventListener("keydown", handleDocumentKeyDown, true);
  window.addEventListener("wheel", hideTextContextMenu, true);
  window.addEventListener("blur", hideTextContextMenu);
  window.addEventListener("resize", hideTextContextMenu);
}

/** 收起菜单（未打开时为空操作）。 */
export function hideTextContextMenu(): void {
  menuRoot?.remove();
  menuRoot = null;
}

/**
 * 用应用自绘样式弹一个菜单（位置 + 菜单项由调用方给）。
 *
 * 供 `showTextContextMenu` / `showTextSelectionMenu` 使用，也供需要**非文本**菜单项
 * 的地方复用（例如便利贴里右键一张图片 →「复制图片 / 删除图片」）：样式、边缘夹取、
 * 外部点击收起这些细节都只有这一份实现，各窗口不必再各写一套浮层。
 */
export function showAppMenu(
  position: { x: number; y: number },
  items: AppMenuItem[],
  label = "编辑",
): void {
  hideTextContextMenu();
  bindGlobalListeners();

  const root = document.createElement("div");
  root.className = MENU_CLASS;
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", label);
  // 防止菜单自身抢走输入框焦点（焦点一走，选区就没了）
  root.addEventListener("mousedown", (event) => event.preventDefault());
  // 菜单内的右键：吞掉默认菜单，不重开
  root.addEventListener("contextmenu", (event) => event.preventDefault());

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${MENU_CLASS}__item`;
    button.dataset.action = item.id;
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    // 先收起菜单再执行：菜单 DOM 不参与后续的焦点/选区计算
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      hideTextContextMenu();
      item.run();
    });
    root.appendChild(button);
  }

  // 先隐藏测量尺寸，再摆位，避免菜单在窗口边缘露出一帧
  root.style.visibility = "hidden";
  document.body.appendChild(root);
  clampPosition(root, position.x, position.y);
  root.style.visibility = "";

  menuRoot = root;
}

/**
 * 在可编辑区域弹出自绘菜单：剪切 / 复制 / 粘贴 / 全选。
 *
 * `target` 由 desktopShell 的右键拦截负责筛选（含非文本类 input 的排除）。
 */
export function showTextContextMenu(options: { x: number; y: number; target: HTMLElement }): void {
  const state = snapshotSelection(options.target);
  showAppMenu(options, [
    {
      id: "cut",
      label: "剪切",
      disabled: !state.hasSelection,
      run: () => cutOrCopyFrom(state, "cut"),
    },
    {
      id: "copy",
      label: "复制",
      disabled: !state.hasSelection,
      run: () => cutOrCopyFrom(state, "copy"),
    },
    { id: "paste", label: "粘贴", run: () => void pasteInto(state) },
    { id: "selectAll", label: "全选", run: () => selectAllIn(state) },
  ]);
}

/**
 * 非编辑区域里选中了页面文字时，只提供「复制」——
 * 这是原默认菜单里真正有用的一项，其余（刷新 / 另存为）不应出现。
 */
export function showTextSelectionMenu(position: { x: number; y: number }): void {
  showAppMenu(position, [{ id: "copy", label: "复制", run: () => runExecCommand("copy") }]);
}
