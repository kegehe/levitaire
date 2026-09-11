import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import ToolIcon from "./ToolIcon";
import {
  FLOATING_TOOLS,
  BACKEND_TOOLS,
  CATEGORY_LABELS,
  getEnabledTools,
  setEnabledTools,
  type FloatingTool,
  type ToolCategory,
} from "../tools/registry";
import {
  ensureScreenshotWindow,
  ensureSketchWindow,
  ensureMonitorWindow,
  ensurePomodoroWindow,
  ensureTimerWindow,
  ensureTodoWindow,
  ensureUtilityHubWindow,
  ensureStickyNotesManagerWindow,
  waitForNewMonitorWindowReady,
} from "../utils/toolWindows";
import "./ToolPalette.css";

const TOOL_COLORS: Record<string, string> = {
  "utility-hub": "#2f9e78",
  todo: "#1d9e75",
  sketch: "#ba7517",
  "text-toolbar": "#378add",
  screenshot: "#d4537e",
  "system-monitor": "#1d9e75",
  pomodoro: "#d85a30",
  timer: "#7f77dd",
  recording: "#e24b4a",
  "quick-input": "#1d9e75",
  "sticky-notes": "#d99a1b",
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
  const activationLock = useRef(false);
  const [isVisible, setIsVisible] = useState(true);
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

  // 窗口尺寸自适应：渲染后测量内容实际高度，调整窗口大小消除空白
  const containerRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // useLayoutEffect 在 DOM 更新后、浏览器绘制前同步执行，
    // offsetHeight 此时已是正确值，无需 requestAnimationFrame 延迟。
    const height = el.offsetHeight;
    if (height > 0 && height !== lastHeightRef.current) {
      lastHeightRef.current = height;
      getCurrentWebviewWindow().setSize(new LogicalSize(330, height)).catch(console.error);
    }
  }, [enabledIds, activateError]);

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

  // Esc 关闭 + 失焦隐藏。win 在 effect 内获取（getCurrentWebviewWindow 每次
  // 调用返回新对象，放组件顶层会导致本 effect 每次 render 重跑、监听器反复注册）。
  useEffect(() => {
    let disposed = false;
    const win = getCurrentWebviewWindow();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_palette").catch(console.error);
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
              setIsVisible(false);
              void emit("levitaire-palette-visibility", false);
              invoke("hide_palette").catch(console.error);
            })
            .catch(() => {
              if (disposed || generation !== focusGeneration.current) return;
              setIsVisible(false);
              void emit("levitaire-palette-visibility", false);
              invoke("hide_palette").catch(console.error);
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
  }, [syncFromBackend]);

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
      const command = {
        sketch: "set_sketch_enabled",
        screenshot: "set_screenshot_enabled",
        "text-toolbar": "set_text_toolbar_enabled",
        "system-monitor": "set_system_monitor_enabled",
        recording: "set_recording_enabled",
        pomodoro: "set_pomodoro_enabled",
        "quick-input": "set_quick_input_enabled",
        todo: "set_todo_enabled",
        timer: "set_timer_enabled",
        "sticky-notes": "set_sticky_notes_enabled",
      }[id as keyof Record<string, string>];
      if (command) await invoke(command, { enabled });
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

  const enableAll = () => {
    orderedTools.forEach((tool) => {
      if (!enabledIdsRef.current.includes(tool.id)) void toggleEnabled(tool.id);
    });
  };

  const disableAll = () => {
    orderedTools.forEach((tool) => {
      if (enabledIdsRef.current.includes(tool.id)) void toggleEnabled(tool.id);
    });
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
    if (!wasEnabled && tool.id !== "utility-hub") {
      const enabled = await toggleEnabled(tool.id);
      if (!enabled) {
        setActivateError(`${tool.name}启用失败，请重试`);
        activationLock.current = false;
        return;
      }
    }
    if (tool.id === "utility-hub" && !wasEnabled) {
      const next = [...enabledIdsRef.current, tool.id];
      setEnabledIds(next);
      setEnabledTools(next);
      enabledIdsRef.current = next;
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
        await invoke("hide_palette");
        return;
      }
      if (tool.activation === "immediate") {
        if (tool.id === "screenshot") {
          await ensureScreenshotWindow();
          await invoke("start_screenshot");
          await invoke("hide_palette").catch(console.error);
        } else if (tool.id === "sketch") {
          await ensureSketchWindow();
          await invoke("show_sketch_window");
          await invoke("hide_palette");
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
          await invoke("hide_palette").catch(console.error);
        } else if (tool.id === "recording") {
          await ensureScreenshotWindow();
          await invoke("start_recording_select");
          await invoke("hide_palette").catch(console.error);
        } else if (tool.id === "pomodoro") {
          await ensurePomodoroWindow();
          await invoke("show_pomodoro_window");
          await invoke("hide_palette").catch(console.error);
        } else if (tool.id === "timer") {
          await ensureTimerWindow();
          await invoke("show_timer_window");
          await invoke("hide_palette").catch(console.error);
        } else if (tool.id === "todo") {
          await ensureTodoWindow();
          await invoke("show_todo_window");
          await invoke("hide_palette").catch(console.error);
        } else if (tool.id === "sticky-notes") {
          await ensureStickyNotesManagerWindow();
          await invoke("show_sticky_notes_manager");
          await invoke("hide_palette").catch(console.error);
        } else if (tool.id === "quick-input") {
          // 点击「快速输入」卡片：切换唤起/关闭转盘（语义与触发键单击一致）
          await invoke("toggle_quick_input_wheel");
          await invoke("hide_palette").catch(console.error);
        }
      } else {
        // selection 类：工具 chunk 已在上方 loader() 预加载，隐藏面板，等待用户选中文字时由后端 selection-found 触发显示
        await invoke("hide_palette").catch(console.error);
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
      className={`palette-container ${isVisible ? "is-visible" : ""}`}
      ref={containerRef}
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
        <div className="palette-title-wrap">
          <span
            className={`palette-status ${enabledIds.length ? "is-live" : ""}`}
            aria-hidden="true"
          />
          <span className="palette-title">悬浮工具</span>
        </div>
        <button
          className="palette-close"
          aria-label="关闭"
          type="button"
          onClick={() => invoke("hide_palette").catch(console.error)}
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
                    style={{ "--tool-color": TOOL_COLORS[tool.id] ?? "#1d9e75" } as CSSProperties}
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
                      const distance = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
                      if (!drag.active && distance < 6) return;
                      drag.active = true;
                      setDraggingToolId(drag.fromId);
                      const target = document
                        .elementFromPoint(e.clientX, e.clientY)
                        ?.closest<HTMLElement>("[data-tool-id]");
                      const targetId = target?.dataset.toolId;
                      const sameCategory =
                        !!targetId && categoryById.get(targetId) === categoryById.get(drag.fromId);
                      setDragOverToolId(sameCategory ? targetId : null);
                      if (sameCategory && targetId !== drag.fromId) moveTool(drag.fromId, targetId);
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
  );
}

export default ToolPalette;
