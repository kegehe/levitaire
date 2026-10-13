import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import ToolIcon from "./ToolIcon";
import OrbIcon from "./OrbIcon";
import { getOrbIcon, type OrbIconId } from "../constants/orbAppearance";
import {
  FLOATING_TOOLS,
  BACKEND_TOOLS,
  CATEGORY_LABELS,
  backendSetterFor,
  getEnabledTools,
  setEnabledTools,
  type FloatingTool,
  type ToolCategory,
} from "../tools/registry";
import {
  ensureScreenshotWindow,
  ensureSketchWindow,
  ensureMonitorWindow,
  ensureTimerWindow,
  ensureTodoWindow,
  ensureUtilityHubWindow,
  ensureStickyNotesManagerWindow,
  ensureSystemCleanerWindow,
  waitForNewMonitorWindowReady,
} from "../utils/toolWindows";
import { clampWindowToWorkArea } from "../utils/panelWindow";
import "./ToolPalette.css";

/** 各工具卡片的强调色（边框 / 底色 / 发光 / 图标 / 开关都取自它）。
 *
 * 判据是**感知色差**而不是色相数字或十六进制是否相同：任意两色按 CIEDE2000 算出的
 * ΔE 都要 ≥10。这个 10 是本仓库给面板定的下限——色块只有 38px（.palette-card-icon）、
 * 卡面底色又只是 20% 混色的淡底，比大色块更难分辨，不是通用的感知阈值。踩过两次：
 * todo / system-monitor / quick-input 曾共用 «#1d9e75»；utility-hub 与 todo 也曾是两个
 * 不同的绿（#2f9e78 / #1d9e75），色差却只有 ΔE 1.2，一样分不出来。守卫用例见
 * ToolPalette.test.tsx。
 *
 * 当前全表最紧的一对是 sketch × sticky-notes（ΔE 12.5，跨分组），余量不大，加新工具时
 * 先算一遍色差再落笔。另：utility-hub 的绿与滚动导航窗口「精确模式」状态点同色
 * （src/tools/scroll-navigator/ScrollNavigator.css:56），单独改卡片色两者就会对不上。 */
const TOOL_COLORS: Record<string, string> = {
  "utility-hub": "#2f9e78",
  // 青柠绿：色相 80°，与 utility-hub 的绿拉开到 ΔE 19.6（改前只有 1.2），
  // 也避开 sketch / sticky-notes / system-cleaner 那一串琥珀橙
  todo: "#6a921c",
  sketch: "#ba7517",
  "text-toolbar": "#378add",
  screenshot: "#d4537e",
  // 青蓝：与同组 timer 紫、sticky-notes 琥珀、system-cleaner 橙互不干扰
  "system-monitor": "#1a9cb8",
  timer: "#7f77dd",
  recording: "#e24b4a",
  // 品红：与同组 text-toolbar 蓝拉开，也不与任何「绿色系」工具混淆
  "quick-input": "#b14fbf",
  "sticky-notes": "#d99a1b",
  "system-cleaner": "#d06a3a",
};

/** 面板分组顺序。
 *
 * 用 `Record<ToolCategory, number>` 而非数组常量：`ToolCategory` 将来新增成员时，
 * 这里会**编译报错**并强制补上排序位。数组写法没有这层保护——漏加一个类别就会让
 * 该类别下的工具在面板里静默消失。 */
const CATEGORY_RANK: Record<ToolCategory, number> = {
  text: 0,
  screen: 1,
  system: 2,
};

function ToolPalette() {
  const [enabledIds, setEnabledIds] = useState<string[]>(() => getEnabledTools());
  // ref 镜像最新 enabledIds，供异步失败回滚读取当前真值，避免闭包陈旧
  const enabledIdsRef = useRef(enabledIds);
  enabledIdsRef.current = enabledIds;
  // 标记是否有后端 toggle 写入正在进行，syncFromBackend 在此期间跳过，
  // 避免后端 getter 读到 toggle 前旧值而覆盖乐观更新（窄窗口竞态）
  const pendingToggle = useRef(0);
  const syncGeneration = useRef(0);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  // 「全部开启 / 全部关闭」的批量失败汇总。逐项失败的细节只写进控制台，用户看不到，
  // 界面上必须指出「哪几项没生效」，否则只能对着面板一条条试。
  const [batchError, setBatchError] = useState<string | null>(null);
  const activationLock = useRef(false);
  const [isVisible, setIsVisible] = useState(true);
  // 标题左侧的品牌标记用悬浮球当前角色图标：外观与 orb 完全一致，且跟随设置实时变化
  const [orbIcon, setOrbIcon] = useState<OrbIconId>(() => getOrbIcon());
  const [toolOrder, setToolOrder] = useState<string[]>(() => {
    const ids = FLOATING_TOOLS.map((tool) => tool.id);
    try {
      const stored = JSON.parse(localStorage.getItem("levitaire-tools-order") ?? "null");
      if (Array.isArray(stored)) {
        return [
          ...stored.filter((id): id is string => ids.includes(id)),
          ...ids.filter((id) => !stored.includes(id)),
        ];
      }
    } catch {
      /* use registry order */
    }
    return ids;
  });
  const pointerDrag = useRef<{
    pointerId: number;
    fromId: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [draggingToolId, setDraggingToolId] = useState<string | null>(null);
  const [dragOverToolId, setDragOverToolId] = useState<string | null>(null);
  const lastDragAt = useRef(0);
  const paletteDragActive = useRef(false);
  const paletteDragReset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusLossTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusGeneration = useRef(0);
  const orderedTools = useMemo(
    () =>
      toolOrder
        .map((id) => FLOATING_TOOLS.find((tool) => tool.id === id))
        .filter((tool): tool is FloatingTool => Boolean(tool)),
    [toolOrder],
  );
  // 工具 id → 类别：供分组渲染与「拖拽只允许同组」校验使用
  const categoryById = useMemo(
    () => new Map(FLOATING_TOOLS.map((tool) => [tool.id, tool.category])),
    [],
  );
  // 按类别分组，组内沿用用户拖拽排序（toolOrder）的结果。
  // 从工具自身推导分组（而不是遍历固定的类别列表），任何类别都不会被漏掉。
  const groupedTools = useMemo(() => {
    const byCategory = new Map<ToolCategory, FloatingTool[]>();
    for (const tool of orderedTools) {
      const list = byCategory.get(tool.category);
      if (list) list.push(tool);
      else byCategory.set(tool.category, [tool]);
    }
    return [...byCategory.entries()]
      .map(([category, tools]) => ({ category, tools }))
      .sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
  }, [orderedTools]);

  // 同步主题（palette 是独立窗口）
  useLayoutEffect(() => {
    applyThemePreferences(getStoredThemePreferences());
    // 透明背景需逐窗口设置（与 FloatingOrb 同理，避免污染 settings 全局规则）
    // 同时覆盖 global.css 中 html/body/#root 的 height:100%，改为 fit-content 实现自适应
    document.documentElement.style.background = "transparent";
    document.documentElement.style.height = "fit-content";
    document.body.style.background = "transparent";
    document.body.style.height = "fit-content";
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.height = "fit-content";
    }
  }, []);

  useEffect(() => {
    const un = subscribeThemePreferences();
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // orb 角色图标变更：面板窗口是常驻的（关闭只 hide），只在挂载时读一次
  // localStorage 会一直停在旧图标，必须跟着设置窗口的全局广播更新。
  useEffect(() => {
    const unlisten = listen<{ id: string }>("levitaire-orb-icon-changed", (event) => {
      const icon = event.payload?.id as OrbIconId;
      if (icon) setOrbIcon(icon);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 窗口尺寸自适应：测量「面板 + 阴影留白」的实际外框，调整窗口大小消除空白。
  // 宽高都从测量值取——.palette-stage 的左右留白参与窗口宽度，写死面板宽度会把
  // 右侧留白切掉，投影又被窗口边界裁出直角（面板宽度见 ToolPalette.css 的
  // .palette-container 与 Rust 的 PALETTE_PANEL_WIDTH，三处必须同步）。
  const stageRef = useRef<HTMLDivElement>(null);
  const lastSizeRef = useRef("");
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // useLayoutEffect 在 DOM 更新后、浏览器绘制前同步执行，
    // offsetWidth/offsetHeight 此时已是正确值，无需 requestAnimationFrame 延迟。
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    if (width <= 0 || height <= 0) return;
    const size = `${width}:${height}`;
    if (size === lastSizeRef.current) return;
    lastSizeRef.current = size;
    getCurrentWebviewWindow().setSize(new LogicalSize(width, height)).catch(console.error);
    clampWindowToWorkArea(width, height);
  }, [enabledIds, activateError, batchError]);

  // 与后端真值同步：text-toolbar / screenshot 的启用状态持久化于 config.json，
  // localStorage 仅作前端默认。挂载时及每次窗口获焦时以后端为准修正勾选，
  // 避免重启后或外部修改导致 UI 显示与实际行为不一致。
  const syncFromBackend = useCallback(() => {
    // 有 toggle 写入 inflight 时跳过：此时后端 getter 可能尚未反映本次写入，
    // 用旧值覆盖会回退乐观更新。等 toggle 落定后下次获焦会重新同步。
    if (pendingToggle.current > 0) return;
    const generation = ++syncGeneration.current;
    Promise.all(
      BACKEND_TOOLS.map((t) =>
        invoke<boolean>(t.getter)
          .then((enabled) => ({ id: t.id, enabled }))
          .catch(() => null),
      ),
    ).then((results) => {
      if (generation !== syncGeneration.current || pendingToggle.current > 0) return;
      const valid = results.filter((r): r is { id: string; enabled: boolean } => r !== null);
      if (valid.length === 0) {
        console.warn("syncFromBackend: 后端命令均失败，保持 localStorage 状态");
        return;
      }
      // 同步启用状态
      const prev = enabledIdsRef.current;
      let next = prev;
      for (const { id, enabled } of valid) {
        const has = next.includes(id);
        if (enabled && !has) next = [...next, id];
        else if (!enabled && has) next = next.filter((x) => x !== id);
      }
      setEnabledIds(next);
      setEnabledTools(next);
      enabledIdsRef.current = next;
    });
  }, []);

  useEffect(() => {
    syncFromBackend();
  }, [syncFromBackend]);

  // 隐藏面板：本地可见态 + 广播 + 原生隐藏三件事总是一起做。
  // **所有**隐藏入口（Esc、关闭按钮、失焦、点击留白、激活工具后收起）都必须走这里：
  // 只调 invoke("hide_palette") 会漏掉 is-visible 与广播，导致下次打开时不播入场动画、
  // 悬浮球也停在「已展开」态。
  // 返回 promise 供调用方按需等待原生隐藏完成（如启动截图前先收起面板）。
  const hidePalette = useCallback(async () => {
    setIsVisible(false);
    void emit("levitaire-palette-visibility", false);
    try {
      await invoke("hide_palette");
    } catch (error) {
      console.error(error);
    }
  }, []);

  /** 显示面板（后端命令）。与 hidePalette 相对，同样只有这一条路径。 */
  const showPalette = useCallback(async () => {
    try {
      await invoke("show_palette");
    } catch (error) {
      console.error(error);
    }
  }, []);

  // 「点悬浮球开合面板」的另一半：悬浮球只负责广播意图，**开合由本窗口用原生可见性裁决**
  // （面板自己才是它可见性的权威），再走 hidePalette() / showPalette() 这两条既有路径 ——
  // is-visible、入场动画状态与 levitaire-palette-visibility 广播都由它们维护。
  //
  // ⚠️ 为什么不能信悬浮球那边传来的"我这边是开着的"：截图 / 长截图等流程会**不经前端**
  // 直接把面板 hide 掉（`commands/mod.rs`、`commands/long_capture.rs` 里的 `window.hide()`，
  // 以及 `commands/tools.rs` 激活工具前的收起），任何缓存在前端的状态都会因此过期 ——
  // 那种情况下按缓存判断会把「打开」当成「收起」，表现为点球空点一次。
  useEffect(() => {
    let disposed = false;
    const win = getCurrentWebviewWindow();
    const unlisten = listen("palette-toggle-requested", () => {
      if (disposed) return;
      void win
        .isVisible()
        .then((visible) => (visible ? hidePalette() : showPalette()))
        .catch(() => {
          // 读不到原生可见性（窗口异常）：按「打开」处理 —— show 是幂等的，
          // 而误 hide 会让用户这一次点击落空。
          void showPalette();
        });
    });
    return () => {
      disposed = true;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [hidePalette, showPalette]);

  // Esc 关闭 + 失焦隐藏。win 在 effect 内获取（getCurrentWebviewWindow 每次
  // 调用返回新对象，放组件顶层会导致本 effect 每次 render 重跑、监听器反复注册）。
  useEffect(() => {
    let disposed = false;
    const win = getCurrentWebviewWindow();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void hidePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    // 失焦自动隐藏（点击外部）；获焦时与后端真值重新同步
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      if (disposed) return;
      const generation = ++focusGeneration.current;
      if (!focused) {
        // Native window dragging can briefly report a focus loss. Keep the palette
        // alive during that transition; a real outside click still hides it normally.
        if (paletteDragActive.current) return;
        if (focusLossTimer.current) clearTimeout(focusLossTimer.current);
        focusLossTimer.current = setTimeout(() => {
          focusLossTimer.current = null;
          // Focus notifications can arrive out of order while the orb click
          // is still being released. Confirm the native state before hiding.
          void win
            .isFocused()
            .then((stillFocused) => {
              if (disposed || stillFocused || generation !== focusGeneration.current) return;
              void hidePalette();
            })
            .catch(() => {
              if (disposed || generation !== focusGeneration.current) return;
              void hidePalette();
            });
        }, 150);
      } else {
        if (focusLossTimer.current) {
          clearTimeout(focusLossTimer.current);
          focusLossTimer.current = null;
        }
        setIsVisible(true);
        void emit("levitaire-palette-visibility", true);
        // 每次显示面板时重新与后端真值同步（覆盖常驻窗口期间外部可能的状态变更）
        syncFromBackend();
      }
    });
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      if (paletteDragReset.current) clearTimeout(paletteDragReset.current);
      if (focusLossTimer.current) clearTimeout(focusLossTimer.current);
      unFocus.then((fn) => fn());
    };
  }, [syncFromBackend, hidePalette]);

  const toggleEnabled = async (id: string): Promise<boolean> => {
    // 用 ref 读取当前真值而非 render 闭包中的 enabledIds：
    // 快速连续切换同一开关时，若读到陈旧快照会把「先启用后禁用」误判为
    // 「两次启用」而令开关卡死在错误状态。ref 由本函数同步推进，语义上是最新值。
    const current = enabledIdsRef.current;
    const wasEnabled = current.includes(id);
    const next = wasEnabled ? current.filter((x) => x !== id) : [...current, id];
    setEnabledIds(next);
    setEnabledTools(next);
    enabledIdsRef.current = next;

    // 工具级开关同步到后端：仅启用时对应行为才触发
    // screenshot：仅启用时全局热键才触发
    // text-toolbar：仅启用时拖拽选中文本才弹出工具栏
    const enabled = !wasEnabled;
    // Invalidate any backend snapshot already in flight. It may still resolve
    // after this optimistic toggle and must not overwrite the user's choice.
    syncGeneration.current += 1;
    pendingToggle.current += 1;
    const rollback = () => {
      pendingToggle.current = Math.max(0, pendingToggle.current - 1);
      // 回滚读取 ref 当前真值再撤销本次 toggle，避免连续 toggle 竞态下
      // 用陈旧闭包覆盖掉后续合法修改
      const current = enabledIdsRef.current;
      const restored = enabled
        ? current.filter((x) => x !== id) // 本次想启用却失败 → 移除
        : [...current, id]; // 本次想禁用却失败 → 加回
      setEnabledIds(restored);
      setEnabledTools(restored);
      enabledIdsRef.current = restored;
    };
    try {
      // 命令名统一由 registry 的 BACKEND_TOOLS 提供：这里曾手写第二张 id→命令表，
      // 新增工具时两张表一旦不同步，开关就会静默退化成「只改前端状态」（通用工具踩过）。
      const command = backendSetterFor(id);
      if (command) await invoke(command, { enabled });
      else
        console.warn(
          `[ToolPalette] 工具 ${id} 未在 registry 的 BACKEND_TOOLS 登记，启用状态不会同步到后端`,
        );
      pendingToggle.current = Math.max(0, pendingToggle.current - 1);
      if (enabled && id === "quick-input") {
        void invoke("ensure_quick_input_window").catch((err) =>
          console.error("Failed to ensure quick input window:", err),
        );
      } else if (enabled && id === "todo") {
        void ensureTodoWindow().catch(console.error);
      } else if (enabled && id === "timer") {
        void ensureTimerWindow().catch(console.error);
      }
      return true;
    } catch (err) {
      console.error(`Failed to set ${id} enabled:`, err);
      rollback();
      return false;
    }
  };

  // 「全部开启 / 全部关闭」串行下发。
  //
  // 并发（原来那样 forEach + void toggleEnabled）会让后端的窗口清理互相打架：
  // `set_screenshot_enabled(false)` 的会话清理会按 `*_VISIBLE_BEFORE_SESSION` 系列标记
  // 把 time-overlay / todo-overlay / sketch-overlay 重新 show 回来；如果此时
  // `set_timer_enabled(false)` 的 hide 已经执行完，就会出现「全部关闭之后浮窗又冒出来」。
  // 串行后 hide 必然排在清理之后，结果稳定（后端侧另有一层「工具仍启用才恢复」的兜底）。
  //
  // 连点也要排队：第二次点击在第一轮跑完后才读取 enabledIdsRef，语义上才是最新的真值。
  const batchQueue = useRef<Promise<void>>(Promise.resolve());
  // 只有最后排队的那一批有权写提示：中途追加的批次会让上一批的结论过期
  // （上一批失败的项可能已被这一批成功改回），过期的汇总会误导用户。
  const batchGeneration = useRef(0);
  const applyToAll = (target: boolean) => {
    const generation = ++batchGeneration.current;
    // 先吞掉上一批可能留下的异常：`.then` 在 rejected 链上会跳过回调，
    // 若队列里留下一环 rejected，之后所有排队的批次都不再执行
    // ——「全部开启 / 全部关闭」就变成点了没反应。
    batchQueue.current = batchQueue.current
      .catch(() => {})
      .then(async () => {
        // 逐项失败不中断整批（其余项仍应生效），只把失败的名字攒起来最后汇总
        const failed: string[] = [];
        for (const tool of orderedTools) {
          if (enabledIdsRef.current.includes(tool.id) === target) continue;
          const ok = await toggleEnabled(tool.id);
          if (!ok) failed.push(tool.name);
        }
        if (generation !== batchGeneration.current) return;
        setBatchError(
          failed.length === 0
            ? null
            : `${target ? "全部开启" : "全部关闭"}有 ${failed.length} 项未生效：${failed.join("、")}`,
        );
      });
    return batchQueue.current;
  };

  const enableAll = () => {
    void applyToAll(true);
  };

  const disableAll = () => {
    void applyToAll(false);
  };

  const moveTool = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    // 分组后面板按类别分段展示，跨类别拖拽会让工具在自身组内的相对位置变得不可预期
    // （扁平 toolOrder 无法表达「插入到别的组的第几个」），故只允许同类别内排序。
    if (categoryById.get(fromId) !== categoryById.get(toId)) return;
    setToolOrder((current) => {
      const next = [...current];
      const from = next.indexOf(fromId);
      const to = next.indexOf(toId);
      if (from < 0 || to < 0) return current;
      next.splice(from, 1);
      next.splice(to, 0, fromId);
      localStorage.setItem("levitaire-tools-order", JSON.stringify(next));
      return next;
    });
  };

  const handleActivate = async (tool: FloatingTool) => {
    // A card click enables a disabled tool and continues directly into activation.
    if (activationLock.current || activating) return;
    activationLock.current = true;
    const wasEnabled = enabledIdsRef.current.includes(tool.id);
    if (!wasEnabled) {
      // 点卡片 = 顺带启用，然后直接进入激活流程。通用工具也有后端启用态，
      // 走的是与其它工具完全相同的一条路（曾在这里给它开过「只改前端状态」的后门）。
      const enabled = await toggleEnabled(tool.id);
      if (!enabled) {
        setActivateError(`${tool.name}启用失败，请重试`);
        activationLock.current = false;
        return;
      }
    }
    // 激活进行中禁止重复触发
    setActivateError(null);
    setActivating(true);
    try {
      // 预加载对应 chunk
      if (tool.activation === "selection") {
        await tool.loader();
      }
    } catch (err) {
      console.error("工具加载失败:", err);
      setActivateError("工具加载失败");
      // 加载失败不隐藏面板，保持可见供用户重试或选择其他工具
      setActivating(false);
      activationLock.current = false;
      return;
    }
    try {
      if (tool.id === "utility-hub") {
        await ensureUtilityHubWindow();
        await invoke("start_utility_hub");
        await hidePalette();
        return;
      }
      if (tool.activation === "immediate") {
        if (tool.id === "screenshot") {
          await ensureScreenshotWindow();
          await invoke("start_screenshot");
          await hidePalette();
        } else if (tool.id === "sketch") {
          await ensureSketchWindow();
          await invoke("show_sketch_window");
          await hidePalette();
        } else if (tool.id === "system-monitor") {
          try {
            const monitorWindow = await ensureMonitorWindow();
            if (monitorWindow.created) {
              await waitForNewMonitorWindowReady();
            }
            await invoke("show_monitor_window");
          } catch (err) {
            console.error("show_monitor_window 失败:", err);
            // 窗口创建了但显示失败：销毁残留窗口，避免下次 ensureMonitorWindow 拿到无效引用
            setActivateError(`系统监控启动失败: ${err}`);
            return;
          }
          await hidePalette();
        } else if (tool.id === "system-cleaner") {
          try {
            await ensureSystemCleanerWindow();
            await invoke("show_system_cleaner_window");
          } catch (err) {
            console.error("show_system_cleaner_window 失败:", err);
            setActivateError(`系统清理启动失败: ${err}`);
            return;
          }
          await hidePalette();
        } else if (tool.id === "recording") {
          await ensureScreenshotWindow();
          await invoke("start_recording_select");
          await hidePalette();
        } else if (tool.id === "timer") {
          await ensureTimerWindow();
          await invoke("show_timer_window");
          await hidePalette();
        } else if (tool.id === "todo") {
          await ensureTodoWindow();
          await invoke("show_todo_window");
          await hidePalette();
        } else if (tool.id === "sticky-notes") {
          await ensureStickyNotesManagerWindow();
          await invoke("show_sticky_notes_manager");
          await hidePalette();
        } else if (tool.id === "quick-input") {
          // 点击「快速输入」卡片：切换唤起/关闭转盘（语义与触发键单击一致）
          await invoke("toggle_quick_input_wheel");
          await hidePalette();
        }
      } else {
        // selection 类：工具 chunk 已在上方 loader() 预加载，隐藏面板，等待用户选中文字时由后端 selection-found 触发显示
        await hidePalette();
      }
    } catch (err) {
      console.error(`${tool.id} 启动失败:`, err);
      setActivateError(`${tool.name}启动失败，请重试`);
    } finally {
      setActivating(false);
      activationLock.current = false;
    }
  };

  return (
    <div
      className="palette-stage"
      ref={stageRef}
      onMouseDown={(event) => {
        // 阴影留白是一圈透明区域，但它仍属于本窗口，原生层不会把点击透给桌面，
        // 面板也不会因此失焦。若不处理，留白就变成一圈「吞点击」的死区：
        // 用户点在面板边上以为点到了桌面，面板却毫无反应。
        // 这里按「点了面板外面」处理，与失焦隐藏的语义保持一致。
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        void hidePalette();
      }}
    >
      <div
        className={`palette-container ${isVisible ? "is-visible" : ""}`}
        onMouseDown={(event) => {
          // Keep card sorting and all controls independent from window dragging.
          if (event.button !== 0) return;
          const target = event.target as HTMLElement;
          if (target.closest("[data-tool-id], button")) return;
          event.preventDefault();
          paletteDragActive.current = true;
          if (paletteDragReset.current) clearTimeout(paletteDragReset.current);
          // startDragging consumes the native mouse-up. The timeout is a safety net
          // for cancellation or platform-specific drag completion behavior.
          paletteDragReset.current = setTimeout(() => {
            paletteDragActive.current = false;
            paletteDragReset.current = null;
          }, 5000);
          getCurrentWebviewWindow()
            .startDragging()
            .catch((error) => console.error("Failed to start palette dragging:", error))
            .finally(() => {
              window.setTimeout(() => {
                paletteDragActive.current = false;
                if (paletteDragReset.current) {
                  clearTimeout(paletteDragReset.current);
                  paletteDragReset.current = null;
                }
              }, 150);
            });
        }}
      >
        <div className="palette-header">
          {/* 面板的中文名。字标换成品牌后，可访问名里只剩 "Levitaire"，
              这里把「悬浮工具」补回给屏幕阅读器，不占视觉空间。 */}
          <span className="palette-sr-only">悬浮工具</span>
          <div className="palette-title-wrap">
            <span className="palette-title">
              {/* 品牌标记 = 悬浮球当前角色图标（同一份 ICON_MARKUP + OrbIcon 组件，
                  含各自的待机动画），不额外画圆底：20px 的小圆底会糊成一坨。 */}
              <OrbIcon icon={orbIcon} size={20} />
              Levitaire
            </span>
          </div>
          <button
            className="palette-close"
            aria-label="关闭"
            type="button"
            onClick={() => void hidePalette()}
          >
            <ToolIcon name="X" size={16} />
          </button>
        </div>
        <div className="palette-body">
          {activateError && (
            <button className="palette-error" onClick={() => setActivateError(null)} type="button">
              {activateError}
            </button>
          )}
          {batchError && (
            <button className="palette-error" onClick={() => setBatchError(null)} type="button">
              {batchError}
            </button>
          )}
          {groupedTools.map(({ category, tools }) => (
            <section
              className="palette-section"
              key={category}
              aria-labelledby={`palette-group-${category}`}
            >
              <h3 className="palette-group-heading" id={`palette-group-${category}`}>
                {CATEGORY_LABELS[category]}
              </h3>
              <div className="palette-grid">
                {tools.map((tool) => {
                  const enabled = enabledIds.includes(tool.id);
                  return (
                    <div
                      className={`palette-card ${enabled ? "is-enabled" : ""} ${activating ? "is-busy" : ""}${draggingToolId === tool.id ? " is-dragging" : ""}${dragOverToolId === tool.id && draggingToolId !== tool.id ? " is-drag-over" : ""}`}
                      key={tool.id}
                      data-tool-id={tool.id}
                      title={`${tool.name}：${tool.description}`}
                      style={
                        {
                          // 未登记颜色的工具回落到主题强调色（.palette-card 的默认值），
                          // 不要硬编码某个工具的颜色——那会让新工具和该工具撞色。
                          "--tool-color": TOOL_COLORS[tool.id] ?? "var(--color-accent)",
                        } as CSSProperties
                      }
                      onClick={() => {
                        if (Date.now() - lastDragAt.current > 220) handleActivate(tool);
                      }}
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                        pointerDrag.current = {
                          pointerId: e.pointerId,
                          fromId: tool.id,
                          startX: e.clientX,
                          startY: e.clientY,
                          active: false,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const drag = pointerDrag.current;
                        if (!drag || drag.pointerId !== e.pointerId) return;
                        const distance = Math.hypot(
                          e.clientX - drag.startX,
                          e.clientY - drag.startY,
                        );
                        if (!drag.active && distance < 6) return;
                        drag.active = true;
                        setDraggingToolId(drag.fromId);
                        const target = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest<HTMLElement>("[data-tool-id]");
                        const targetId = target?.dataset.toolId;
                        const sameCategory =
                          !!targetId &&
                          categoryById.get(targetId) === categoryById.get(drag.fromId);
                        setDragOverToolId(sameCategory ? targetId : null);
                        if (sameCategory && targetId !== drag.fromId)
                          moveTool(drag.fromId, targetId);
                      }}
                      onPointerUp={(e) => {
                        const drag = pointerDrag.current;
                        if (!drag || drag.pointerId !== e.pointerId) return;
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        if (drag.active) lastDragAt.current = Date.now();
                        pointerDrag.current = null;
                        setDraggingToolId(null);
                        setDragOverToolId(null);
                      }}
                      onPointerCancel={(e) => {
                        const drag = pointerDrag.current;
                        if (!drag || drag.pointerId !== e.pointerId) return;
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        pointerDrag.current = null;
                        lastDragAt.current = Date.now();
                        setDraggingToolId(null);
                        setDragOverToolId(null);
                      }}
                      onLostPointerCapture={(e) => {
                        const drag = pointerDrag.current;
                        if (!drag || drag.pointerId !== e.pointerId) return;
                        pointerDrag.current = null;
                        lastDragAt.current = Date.now();
                        setDraggingToolId(null);
                        setDragOverToolId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || e.repeat) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleActivate(tool);
                        }
                      }}
                    >
                      <span className="palette-grip" aria-hidden="true">
                        <ToolIcon name="GripVertical" size={14} />
                      </span>
                      <div className="palette-card-icon">
                        <ToolIcon name={tool.icon} size={22} />
                      </div>
                      <div className="palette-card-name">{tool.name}</div>
                      <button
                        className={`palette-toggle ${enabled ? "is-on" : ""}`}
                        aria-label={enabled ? "禁用" : "启用"}
                        role="switch"
                        aria-checked={enabled}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleEnabled(tool.id);
                        }}
                      >
                        {enabled && <ToolIcon name="Check" size={11} />}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <div className="palette-footer">
          <span className="palette-count">
            <strong>{enabledIds.length}</strong>/{FLOATING_TOOLS.length} 已启用
          </span>
          <div className="palette-all-group">
            <button
              className="palette-all"
              type="button"
              onClick={enableAll}
              disabled={enabledIds.length === FLOATING_TOOLS.length}
            >
              全部开启
            </button>
            <button
              className="palette-all palette-all-off"
              type="button"
              onClick={disableAll}
              disabled={enabledIds.length === 0}
            >
              全部关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ToolPalette;
