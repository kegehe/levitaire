import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { findEditableHost, installDesktopShell, isBlockedBrowserShortcut } from "./desktopShell";

let dispose: (() => void) | undefined;

function contextMenuOn(target: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 30,
  });
  target.dispatchEvent(event);
  return event;
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".app-text-menu");
}

function menuItem(action: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`.app-text-menu__item[data-action="${action}"]`);
}

function keydownOn(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  dispose = installDesktopShell();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.mocked(invoke).mockClear();
});

describe("桌面外壳守卫 · 右键拦截", () => {
  it("非可编辑区域的右键被拦下，且不出现任何菜单", () => {
    document.body.innerHTML = "<div id='panel'>普通面板</div>";
    const event = contextMenuOn(document.getElementById("panel")!);

    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
  });

  it("输入框右键改为应用自绘菜单（不含刷新/另存为等网页项）", () => {
    document.body.innerHTML = "<input id='field' type='text' />";
    const event = contextMenuOn(document.getElementById("field")!);

    expect(event.defaultPrevented).toBe(true);
    const root = menu();
    expect(root).not.toBeNull();
    expect(Array.from(root!.querySelectorAll("[data-action]")).map((el) => el.textContent)).toEqual(
      ["剪切", "复制", "粘贴", "全选"],
    );
  });

  it("无选区时剪切/复制禁用，有选区时启用", () => {
    document.body.innerHTML = "<input id='field' value='hello' />";
    const field = document.getElementById("field") as HTMLInputElement;

    contextMenuOn(field);
    expect(menuItem("cut")!.disabled).toBe(true);
    expect(menuItem("copy")!.disabled).toBe(true);
    expect(menuItem("paste")!.disabled).toBe(false);

    field.setSelectionRange(0, 5);
    contextMenuOn(field);
    expect(menuItem("cut")!.disabled).toBe(false);
    expect(menuItem("copy")!.disabled).toBe(false);
  });

  it("textarea 与 contenteditable 同样走自绘菜单", () => {
    document.body.innerHTML =
      "<textarea id='area'></textarea><div id='note' contenteditable='true'>便签</div>";

    contextMenuOn(document.getElementById("area")!);
    expect(menu()).not.toBeNull();
    expect(menuItem("paste")).not.toBeNull();

    document
      .getElementById("note")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menu()).not.toBeNull();
    expect(menuItem("selectAll")).not.toBeNull();
  });

  it("非文本输入类型（如 checkbox）不弹菜单", () => {
    document.body.innerHTML = "<input id='check' type='checkbox' />";
    contextMenuOn(document.getElementById("check")!);
    expect(menu()).toBeNull();
  });

  it("非编辑区域里选中文字时只给「复制」", () => {
    document.body.innerHTML = "<p id='text'>可复制的正文内容</p>";
    const paragraph = document.getElementById("text")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    contextMenuOn(paragraph);
    const root = menu();
    expect(root).not.toBeNull();
    expect(Array.from(root!.querySelectorAll("[data-action]")).map((el) => el.textContent)).toEqual(
      ["复制"],
    );
    selection.removeAllRanges();
  });

  it("点击菜单外部或按 Escape 都会收起菜单", () => {
    document.body.innerHTML = "<input id='field' />";
    contextMenuOn(document.getElementById("field")!);
    expect(menu()).not.toBeNull();

    menuItem("paste")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu()).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu()).toBeNull();

    contextMenuOn(document.getElementById("field")!);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu()).toBeNull();
  });

  it("安装时请求后端关闭 WebView2 默认右键菜单", () => {
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("harden_webview_window");
  });
});

describe("桌面外壳守卫 · 可编辑宿主识别", () => {
  it("从子节点向上找到编辑宿主（不落在被继承的可编辑子节点上）", () => {
    document.body.innerHTML = "<div contenteditable='true'><span id='inner'>文字</span></div>";
    const host = findEditableHost(document.getElementById("inner"));
    expect(host?.getAttribute("contenteditable")).toBe("true");
  });

  it("普通容器返回 null", () => {
    document.body.innerHTML = "<div id='panel'><span id='inner'>文字</span></div>";
    expect(findEditableHost(document.getElementById("inner"))).toBeNull();
    expect(findEditableHost(null)).toBeNull();
  });
});

describe("桌面外壳守卫 · 浏览器快捷键清单", () => {
  const base = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  it("拦截刷新/打印/保存/查看源码/开发者工具", () => {
    expect(isBlockedBrowserShortcut({ ...base, key: "F5" })).toBe(true);
    expect(isBlockedBrowserShortcut({ ...base, key: "F12" })).toBe(true);
    expect(isBlockedBrowserShortcut({ ...base, key: "r", ctrlKey: true })).toBe(true);
    expect(isBlockedBrowserShortcut({ ...base, key: "R", ctrlKey: true, shiftKey: true })).toBe(
      true,
    );
    expect(isBlockedBrowserShortcut({ ...base, key: "p", ctrlKey: true })).toBe(true);
    expect(isBlockedBrowserShortcut({ ...base, key: "s", ctrlKey: true })).toBe(true);
    expect(isBlockedBrowserShortcut({ ...base, key: "u", ctrlKey: true })).toBe(true);
    expect(isBlockedBrowserShortcut({ ...base, key: "i", ctrlKey: true, shiftKey: true })).toBe(
      true,
    );
    expect(isBlockedBrowserShortcut({ ...base, key: "j", metaKey: true, shiftKey: true })).toBe(
      true,
    );
  });

  it("不碰文本编辑类与 Alt 组合快捷键", () => {
    expect(isBlockedBrowserShortcut({ ...base, key: "c", ctrlKey: true })).toBe(false);
    expect(isBlockedBrowserShortcut({ ...base, key: "v", ctrlKey: true })).toBe(false);
    expect(isBlockedBrowserShortcut({ ...base, key: "x", ctrlKey: true })).toBe(false);
    expect(isBlockedBrowserShortcut({ ...base, key: "a", ctrlKey: true })).toBe(false);
    expect(isBlockedBrowserShortcut({ ...base, key: "z", ctrlKey: true })).toBe(false);
    expect(isBlockedBrowserShortcut({ ...base, key: "s", ctrlKey: true, altKey: true })).toBe(
      false,
    );
    expect(isBlockedBrowserShortcut({ ...base, key: "r" })).toBe(false);
  });

  it("开发构建不拦快捷键（保留 F12 / Ctrl+R 调试）", () => {
    const event = keydownOn(window, { key: "F5" });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("桌面外壳守卫 · 外部文件拖放", () => {
  it("拖入外部文件时阻止 WebView2 导航", () => {
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("应用内部拖拽排序（text/plain）不受影响", () => {
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { types: ["text/plain"] } });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
