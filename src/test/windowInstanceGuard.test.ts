import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";

/**
 * 源码级守卫：窗口组件取窗口实例的写法。
 *
 * 背景（真 bug，非风格问题）：`getCurrentWebviewWindow()` 每次调用都返回**新对象**
 * （`@tauri-apps/api/webviewWindow.js` 里是 `new WebviewWindow(label, {skip:true})`）。
 * 一旦把它写进组件渲染体、又不 memo 化，同时它还被 effect / useCallback 当依赖，
 * 那些 effect 就会**每次渲染都重跑**；若 effect 内再 `setState(新对象)`（例如把
 * 「量内容」的 IPC 结果直接塞进状态），就是**自激渲染循环**。
 * 截图遮罩窗曾因此实测 ≈700 次 IPC/秒（且它在应用启动时就会被预加载 ⇒ 常驻空转），
 * 但既有测试看不见：mock 对量内容命令返回 undefined，状态被置回 null，React 会 bail out。
 *
 * 约定（`MEMORY.md` 第 8 条）：窗口组件一律
 *   ① `useMemo(() => getCurrentWebviewWindow(), [])`，或
 *   ② `useRef(getCurrentWebviewWindow())`（只取首次值，引用天然稳定）。
 * 行为级守卫见 `src/tools/screenshot/ScreenshotTool.loop.test.tsx`。
 */
const WINDOW_COMPONENTS = [
  "src/components/FloatingOrb.tsx",
  "src/components/ContextMenu.tsx",
  "src/components/TitleBar.tsx",
  "src/components/UpdatePrompt.tsx",
  "src/tools/screenshot/ScreenshotTool.tsx",
  "src/tools/screenshot/LongCaptureControls.tsx",
  "src/tools/screenshot/PinOcrResult.tsx",
  "src/tools/recording/RecordingTool.tsx",
  "src/tools/recording/RecordingControls.tsx",
  "src/tools/recording/AreaSelector.tsx",
  "src/tools/quick-input/QuickInputTool.tsx",
  "src/tools/timer/TimerTool.tsx",
  "src/tools/timer/PomodoroPanel.tsx",
  "src/tools/todo/TodoTool.tsx",
  "src/tools/sticky-note/StickyNote.tsx",
  "src/tools/sticky-note/StickyNoteManager.tsx",
  "src/tools/system-monitor/SystemMonitor.tsx",
];

const memoForm = "useMemo(() => getCurrentWebviewWindow(), [])";
const refForm = "useRef(getCurrentWebviewWindow())";

/** 读取仓库内文件（happy-dom 下 `?raw` 拿不到源码，必须走 node:fs） */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new NodeURL(`../../${rel}`, import.meta.url)), "utf8");
}

/**
 * 剥掉**整行**注释，避免「注释掉的代码」被当成有效调用（`VERIFY.md` 守卫注意事项 1）。
 *
 * 判据与 Rust 侧 `commands/mod.rs::strip_line_comments` 一致：`//` 之前全是空白才算注释行，
 * 否则会误伤字符串里的 `https://`。注释行一律置空串，不留内容。
 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index !== -1 && line.slice(0, index).trim() === "" ? "" : line;
    })
    .join("\n");
}

/** 读源码并剥掉注释 —— **做「是否存在某调用」类断言时必须用它**，否则注释式变异会假绿。 */
function readCode(rel: string): string {
  return stripLineComments(read(rel));
}

describe("窗口实例取值约定（防自激渲染循环）", () => {
  it("列出的窗口组件都真的用到了 getCurrentWebviewWindow（防止清单过期空跑）", () => {
    expect(WINDOW_COMPONENTS.length).toBeGreaterThanOrEqual(15);
    for (const rel of WINDOW_COMPONENTS) {
      expect(readCode(rel), `${rel} 已不再使用 getCurrentWebviewWindow`).toContain(
        "getCurrentWebviewWindow",
      );
    }
  });

  it("每个窗口组件都必须 memo / ref 取一次，不得裸取", () => {
    for (const rel of WINDOW_COMPONENTS) {
      const src = readCode(rel);
      const stabilized = src.includes(memoForm) || src.includes(refForm);
      expect(stabilized, `${rel} 未 memo/ref 窗口实例（会让依赖它的 effect 每次渲染重跑）`).toBe(
        true,
      );
      // 裸取（渲染体里直接赋值）必须不存在。effect 里临时取（TextToolbar 那种）不在本清单内。
      expect(
        src.includes("const win = getCurrentWebviewWindow();"),
        `${rel} 仍有裸的 const win = getCurrentWebviewWindow()`,
      ).toBe(false);
    }
  });

  it("提示文案里的写法与守卫一致（避免文档漂移）", () => {
    // 这条**有意用原文**（不剥注释）：它要找的就是注释里的解释性文案
    const withWhy = WINDOW_COMPONENTS.filter((rel) => /新对象|每次返回/.test(read(rel)));
    expect(withWhy.length).toBeGreaterThanOrEqual(6);
  });
});

/**
 * 「尺寸会变的浮窗」在下发尺寸后必须夹回工作区。
 *
 * 窗口落点由后端按光标/选区/记忆位置算出，且只在**首次定位**时夹过；而窗口的最终
 * 尺寸是前端量完内容才下发的。贴屏幕右/下沿的窗口在内容变高变宽后（日历切视图
 * 320→380、监控切 full、便签加行、面板换页、工具栏弹出二维码预览）会有一部分跑到
 * 工作区外 —— 这些都是无边框置顶窗、没有滚动条，出屏的部分直接看不到也点不到。
 *
 * 反例（不在此清单，因为它们不需要）：`LongCaptureControls` 放大后紧跟 `center()`
 * 已居中；`toolWindows.ts` 的 `setSize` 是**创建**窗口时按显示器尺寸设的全屏遮罩。
 * 新增「尺寸随内容变化」的浮窗时必须一并调用 `clampWindowToWorkArea`，并加进本清单。
 */
const CLAMPED_WINDOW_COMPONENTS = [
  "src/tools/text-toolbar/TextToolbar.tsx",
  "src/tools/timer/TimerTool.tsx",
  "src/tools/system-monitor/SystemMonitor.tsx",
  "src/tools/sticky-note/StickyNote.tsx",
  "src/tools/sticky-note/StickyNoteManager.tsx",
  "src/components/ToolPalette.tsx",
  "src/tools/utility-hub/UtilityHub.tsx",
  "src/tools/scroll-navigator/ScrollNavigator.tsx",
  "src/tools/todo/TodoTool.tsx",
];

describe("浮窗尺寸变化后的工作区约束", () => {
  it("清单里的浮窗下发尺寸后都夹回了工作区", () => {
    expect(CLAMPED_WINDOW_COMPONENTS.length).toBeGreaterThanOrEqual(8);
    for (const rel of CLAMPED_WINDOW_COMPONENTS) {
      // readCode：剥掉注释再匹配 —— 否则「把调用注释掉」这种变异会假绿（实测过）。
      expect(
        readCode(rel),
        `${rel} 下发窗口尺寸后没有调用 clampWindowToWorkArea（贴屏幕右/下沿时会出屏）`,
      ).toContain("clampWindowToWorkArea(");
    }
  });

  /**
   * **每一条** setSize 路径都要配一次 clamp —— 只断言"文件里存在 clamp"远远不够：
   * 浮窗通常有多条改尺寸的路径（内容量高、切视图、切显示模式），新增一条忘了夹回时，
   * 只要文件里别处还有一次 clamp，上一条守卫就会**静默通过**。
   * 实测：对 SystemMonitor「量高 effect 去掉 clamp」做变异，加严前无反应、加严后报错。
   */
  it("每一条 setSize 路径都配了 clamp（数量对齐，防止新增路径漏夹）", () => {
    for (const rel of CLAMPED_WINDOW_COMPONENTS) {
      const src = readCode(rel);
      const setSizeCount = src.match(/\.setSize\(/g)?.length ?? 0;
      const clampCount = src.match(/clampWindowToWorkArea\(/g)?.length ?? 0;
      expect(setSizeCount, `${rel} 未找到 setSize（清单过期？）`).toBeGreaterThan(0);
      expect(
        clampCount,
        `${rel} 有 ${setSizeCount} 处 setSize 但只有 ${clampCount} 处 clampWindowToWorkArea`,
      ).toBe(setSizeCount);
    }
  });
});
