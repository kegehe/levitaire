import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { invoke } from "@tauri-apps/api/core";
import { setMockWindow, clearMockListeners } from "../../test/tauri-mock";
import ScreenshotTool from "./ScreenshotTool";

const mockInvoke = vi.mocked(invoke);

/**
 * 回归守卫：截图遮罩窗不得自激重渲染。
 *
 * 曾经的 bug：组件在渲染体里 `const win = getCurrentWebviewWindow()`，而该 API
 * 每次调用都返回**新对象**；`win` 又是挂载 effect 与其内部 fetchReady 的依赖，
 * 该 effect 还会 `setMonitorWorkArea(每次都是新对象)` → 状态恒变 → 再渲染 → 自激。
 * 实测峰值 ≈700 次 IPC/秒，且遮罩窗在应用启动时就被预加载，导致常驻空转。
 *
 * 为什么不用 RTL 的 render/act：act() 会等「所有挂起工作结束」，一旦循环回归，
 * 测试只会超时（5s）且看不出量级。这里用 createRoot + 定时采样，失败时直接打印
 * 调用次数曲线。
 */
describe("ScreenshotTool 自激重渲染守卫", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    setMockWindow({ label: "screenshot-overlay", scaleFactor: 1 });
    vi.clearAllMocks();
    clearMockListeners();
    mockInvoke.mockImplementation((cmd: string) => {
      // 必须返回**合法**对象：早先的测试用 undefined，异常走 catch 后状态被置回
      // null，而 null === null 会让 React bail out，循环在测试里看不见。
      if (cmd === "get_screenshot_monitor_bounds") {
        return Promise.resolve({ left: 0, top: 0, right: 2520, bottom: 1680 });
      }
      if (cmd === "get_virtual_desktop_bounds") {
        return Promise.resolve({ originX: 0, originY: 0, width: 2520, height: 1680 });
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  it("挂载后不应持续拉取显示器工作区（每 10ms 采样一次）", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const count = () =>
      mockInvoke.mock.calls.filter((c) => c[0] === "get_screenshot_monitor_bounds").length;

    const samples: number[] = [];
    const stop = { done: false };
    const tick = () => {
      samples.push(count());
      if (!stop.done && samples.length < 12) setTimeout(tick, 10);
    };

    root = createRoot(host);
    root.render(createElement(ScreenshotTool));
    setTimeout(tick, 10);
    await new Promise((r) => setTimeout(r, 260));
    stop.done = true;

    const last = samples[samples.length - 1] ?? 0;
    // 正常：挂载一次 + 可能的焦点刷新，远小于 10；自激时 260ms 内可达数百次
    expect(last, `调用次数曲线: ${JSON.stringify(samples)}`).toBeLessThan(10);
  });
});

/**
 * 源码级守卫：显示器工作区是「ref（做值比较）+ state（渲染）」双轨，只能有一个写入口。
 *
 * 曾经的事故形态：为挡住自激循环而加的值比较守卫读了 `monitorWorkAreaRef`，但会话重置
 * 路径仍然直接 `setMonitorWorkArea(null)` 而没同步 ref。于是「打开遮罩 → Esc 取消 →
 * 再打开」时，IPC 返回同一块屏的相同数值被判成「没变」，state 永远停在 null，坐标换算
 * 静默退回兜底值（选区/标注位置错位）。现在所有写入都必须经过 `applyMonitorWorkArea`。
 */
describe("ScreenshotTool 工作区状态写入约束", () => {
  it("setMonitorWorkArea 只允许出现在 applyMonitorWorkArea 内部", () => {
    const src = readFileSync(
      fileURLToPath(new NodeURL("./ScreenshotTool.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("const applyMonitorWorkArea = useCallback(");
    // 只数「行首的调用语句」：注释里也提到过这个函数名（`// ... 又会 setMonitorWorkArea(新对象)`），
    // useState 解构则写作 `setMonitorWorkArea]`，两者都不该被计入。
    const writes = src.match(/^\s*setMonitorWorkArea\(/gm) ?? [];
    expect(
      writes.length,
      `发现 ${writes.length} 处 setMonitorWorkArea( 调用——必须统一走 applyMonitorWorkArea（否则 ref/state 双轨失同步）`,
    ).toBe(1);
  });
});
