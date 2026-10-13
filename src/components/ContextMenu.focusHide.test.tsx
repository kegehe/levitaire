import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  clearMockListeners,
  emitMockEvent,
  emitMockFocus,
  setMockWindow,
} from "../test/tauri-mock";
import { hideContextMenu } from "../utils/toolWindows";
import { type UpdateSnapshot } from "../hooks/useUpdater";
import ContextMenu from "./ContextMenu";

/**
 * 托盘菜单的**显示/隐藏生命周期**，以及「更新」项在安装被拒时的走向。
 *
 * 两件事都是「更新期间」才会被用户撞上的：
 * ① 菜单重开时不会被自己关掉（`showContextMenu` 先 hide 再 show 的时序）；
 * ② 安装被拒时不会退化成会抢焦点的「检查更新」。
 */

// 被测目标只有菜单自身：窗口操作与主题订阅在这里都是噪声
vi.mock("../utils/toolWindows", () => ({
  hideContextMenu: vi.fn(async () => undefined),
  ensurePinOcrWindow: vi.fn(async () => ({})),
}));
vi.mock("../styles/themePreferences", () => ({
  applyThemePreferences: vi.fn(),
  getStoredThemePreferences: vi.fn(() => ({})),
  subscribeThemePreferences: vi.fn(async () => () => {}),
}));

const mockInvoke = vi.mocked(invoke);
const mockHideContextMenu = vi.mocked(hideContextMenu);
/** 与 ContextMenu.tsx 里失焦隐藏的延时保持一致 */
const BLUR_HIDE_DELAY_MS = 80;

function snapshot(partial: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    version: null,
    notes: "",
    phase: "idle",
    received: 0,
    total: null,
    error: null,
    ...partial,
  };
}

/** 按命令名分发 invoke；`installError` 非空表示安装命令抛错 */
function routeInvoke(status: UpdateSnapshot, installError?: string) {
  mockInvoke.mockImplementation((command: string) => {
    if (command === "get_update_status") return Promise.resolve(status);
    if (command === "install_update") {
      return installError ? Promise.reject(installError) : Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** 打开菜单窗口，并模拟一次「托盘右键」转发过来的 context-menu-show */
async function openTrayMenu() {
  render(<ContextMenu />);
  await act(flush);
  await act(async () => {
    emitMockEvent("context-menu-show", { source: "tray", x: 100, y: 100 });
  });
}

describe("托盘菜单重开时不会把自己关掉", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    clearMockListeners();
    setMockWindow({ label: "context-menu" });
    routeInvoke(snapshot());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 回归：`showContextMenu()`（utils/toolWindows.ts）每次都会先 `await window.hide()`，
   * 而隐藏一个**正持有焦点**的菜单窗会立刻让它失焦（tao 在 WM_KILLFOCUS 上发
   * `Focused(false)`）——于是**每一次重开菜单都会先排下一个 80ms 的隐藏定时器**，
   * 紧接着的 `show()+setFocus()` 又把它变回获焦状态。
   *
   * 重新获焦时若不清掉那个定时器，菜单会在重新打开后 80ms 被自己关掉：用户看到的是
   * 「右键托盘，菜单闪一下就没」，反复右键就成了「托盘菜单一直在触发」。更新期间用户
   * 恰恰会反复右键看「正在下载更新 x%」。
   */
  it("失焦后又重新获焦：残留的隐藏定时器必须被撤销", async () => {
    await openTrayMenu();

    await act(async () => {
      emitMockFocus(false);
    });
    await act(async () => {
      emitMockFocus(true);
    });
    await act(async () => {
      vi.advanceTimersByTime(BLUR_HIDE_DELAY_MS * 4);
    });

    expect(mockHideContextMenu).not.toHaveBeenCalled();
  });

  it("对照组：只失焦、没有重新获焦时，80ms 后照常隐藏", async () => {
    await openTrayMenu();

    await act(async () => {
      emitMockFocus(false);
    });
    await act(async () => {
      vi.advanceTimersByTime(BLUR_HIDE_DELAY_MS);
    });

    expect(mockHideContextMenu).toHaveBeenCalledTimes(1);
  });

  it("新一次 context-menu-show 也会撤销残留定时器（失焦回调晚到也不误关）", async () => {
    await openTrayMenu();
    await act(async () => {
      emitMockFocus(false);
    });
    await act(async () => {
      emitMockEvent("context-menu-show", { source: "tray", x: 120, y: 120 });
    });
    await act(async () => {
      vi.advanceTimersByTime(BLUR_HIDE_DELAY_MS * 4);
    });

    expect(mockHideContextMenu).not.toHaveBeenCalled();
  });
});

describe("安装被拒不会退化成会抢焦点的「检查更新」", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    clearMockListeners();
    setMockWindow({ label: "context-menu" });
  });

  /**
   * 提示窗 / 设置页已经抢到安装权时（`UpdaterState::try_begin_install` 是跨窗口唯一的
   * 闸门），托盘菜单再点「更新至 vX」会拿到「正在安装更新，请稍候」。
   *
   * 这条路径**不能**把菜单项变成「更新失败，重试」：那个 id 是 `check-update`，点它走的是
   * `check_for_updates`，而后端在「该版本已就绪」分支会重新 show 提示窗并抢焦点，把刚打开
   * 的菜单顶掉 —— 就成了「右键 → 点 → 菜单被顶掉 → 再右键」。
   *
   * 现状之所以成立：`buildTrayUpdateItem` 里 `ready` 分支排在 `failed` 之前，只要后端快照
   * 还是 ready，文案就只会是「更新至 vX」，重复点击走的仍是安装命令。本用例把这条顺序
   * 钉住 —— 谁把 `failed` 挪到 `ready` 前面（或让本地报错覆盖 ready），菜单就会开始抢焦点。
   */
  it("后端以「正在安装更新，请稍候」拒绝后，重复点击仍然走 install_update", async () => {
    routeInvoke(snapshot({ version: "0.1.6", phase: "ready" }), "正在安装更新，请稍候");
    await openTrayMenu();

    await act(async () => {
      fireEvent.click(screen.getByText("更新至 v0.1.6"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("更新至 v0.1.6"));
    });

    const installCalls = mockInvoke.mock.calls.filter(([command]) => command === "install_update");
    expect(installCalls).toHaveLength(2);
    expect(mockInvoke).not.toHaveBeenCalledWith("check_for_updates");
  });

  /** 对照：只有**后端**推进到 failed 时才给「更新失败，重试」——那是刻意的重试入口 */
  it("对照：快照进入 failed 时才出现「更新失败，重试」", async () => {
    routeInvoke(snapshot({ version: "0.1.6", phase: "failed", error: "安装包签名校验失败" }));
    await openTrayMenu();

    expect(screen.getByText("更新失败，重试")).toBeInTheDocument();
  });
});
