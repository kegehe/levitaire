import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import {
  applyThemePreferences,
  getStoredThemePreferences,
  subscribeThemePreferences,
} from "../styles/themePreferences";
import ToolIcon from "./ToolIcon";
import {
  FLOATING_TOOLS,
  BACKEND_TOOLS,
  getEnabledTools,
  setEnabledTools,
  type FloatingTool,
} from "../tools/registry";
import {
  ensureScreenshotWindow,
  ensureMonitorWindow,
  ensurePomodoroWindow,
  waitForNewMonitorWindowReady,
} from "../utils/toolWindows";
import "./ToolPalette.css";

function ToolPalette() {
  const [enabledIds, setEnabledIds] = useState<string[]>(() => getEnabledTools());
  // ref 镜像最新 enabledIds，供异步失败回滚读取当前真值，避免闭包陈旧
  const enabledIdsRef = useRef(enabledIds);
  enabledIdsRef.current = enabledIds;
  // 标记是否有后端 toggle 写入正在进行，syncFromBackend 在此期间跳过，
  // 避免后端 getter 读到 toggle 前旧值而覆盖乐观更新（窄窗口竞态）
  const pendingToggle = useRef(0);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

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
      getCurrentWebviewWindow().setSize(new LogicalSize(360, height)).catch(console.error);
    }
  }, [enabledIds, activateError]);

  // 与后端真值同步：text-toolbar / screenshot 的启用状态持久化于 config.json，
  // localStorage 仅作前端默认。挂载时及每次窗口获焦时以后端为准修正勾选，
  // 避免重启后或外部修改导致 UI 显示与实际行为不一致。
  const syncFromBackend = useCallback(() => {
    // 有 toggle 写入 inflight 时跳过：此时后端 getter 可能尚未反映本次写入，
    // 用旧值覆盖会回退乐观更新。等 toggle 落定后下次获焦会重新同步。
    if (pendingToggle.current > 0) return;
    Promise.all(
      BACKEND_TOOLS.map((t) =>
        invoke<boolean>(t.getter)
          .then((enabled) => ({ id: t.id, enabled }))
          .catch(() => null),
      ),
    ).then((results) => {
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
    const win = getCurrentWebviewWindow();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_palette").catch(console.error);
      }
    };
    window.addEventListener("keydown", onKey);
    // 失焦自动隐藏（点击外部）；获焦时与后端真值重新同步
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        invoke("hide_palette").catch(console.error);
      } else {
        // 每次显示面板时重新与后端真值同步（覆盖常驻窗口期间外部可能的状态变更）
        syncFromBackend();
      }
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      unFocus.then((fn) => fn());
    };
  }, [syncFromBackend]);

  const toggleEnabled = (id: string) => {
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
    if (id === "screenshot") {
      invoke("set_screenshot_enabled", { enabled })
        .then(() => {
          pendingToggle.current = Math.max(0, pendingToggle.current - 1);
        })
        .catch((err) => {
          console.error("Failed to set screenshot enabled:", err);
          rollback();
        });
    } else if (id === "text-toolbar") {
      invoke("set_text_toolbar_enabled", { enabled })
        .then(() => {
          pendingToggle.current = Math.max(0, pendingToggle.current - 1);
        })
        .catch((err) => {
          console.error("Failed to set text toolbar enabled:", err);
          rollback();
        });
    } else if (id === "system-monitor") {
      invoke("set_system_monitor_enabled", { enabled })
        .then(() => {
          pendingToggle.current = Math.max(0, pendingToggle.current - 1);
        })
        .catch((err) => {
          console.error("Failed to set system-monitor enabled:", err);
          rollback();
        });
    } else if (id === "recording") {
      invoke("set_recording_enabled", { enabled })
        .then(() => {
          pendingToggle.current = Math.max(0, pendingToggle.current - 1);
        })
        .catch((err) => {
          console.error("Failed to set recording enabled:", err);
          rollback();
        });
    } else if (id === "pomodoro") {
      invoke("set_pomodoro_enabled", { enabled })
        .then(() => {
          pendingToggle.current = Math.max(0, pendingToggle.current - 1);
        })
        .catch((err) => {
          console.error("Failed to set pomodoro enabled:", err);
          rollback();
        });
    } else if (id === "quick-input") {
      invoke("set_quick_input_enabled", { enabled })
        .then(() => {
          pendingToggle.current = Math.max(0, pendingToggle.current - 1);
          // 启用时预创建转盘窗口（隐藏），供触发键唤起时直接 show
          if (enabled) {
            invoke("ensure_quick_input_window").catch((err) =>
              console.error("Failed to ensure quick input window:", err),
            );
          }
        })
        .catch((err) => {
          console.error("Failed to set quick-input enabled:", err);
          rollback();
        });
    }
  };

  const handleActivate = async (tool: FloatingTool) => {
    // 未启用的工具不允许激活
    if (!enabledIds.includes(tool.id)) {
      setActivateError("请先启用该工具");
      return;
    }
    // 激活进行中禁止重复触发
    if (activating) return;
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
      return;
    }
    try {
      if (tool.activation === "immediate") {
        if (tool.id !== "system-monitor") {
          await invoke("hide_palette").catch(console.error);
        }
        if (tool.id === "screenshot") {
          await ensureScreenshotWindow();
          await invoke("start_screenshot").catch(console.error);
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
          await invoke("start_recording_select").catch(console.error);
        } else if (tool.id === "pomodoro") {
          await ensurePomodoroWindow();
          await invoke("show_pomodoro_window").catch(console.error);
        } else if (tool.id === "quick-input") {
          // 点击「快速输入」卡片：切换唤起/关闭转盘（语义与触发键单击一致）
          await invoke("toggle_quick_input_wheel").catch(console.error);
        }
      } else {
        // selection 类：工具 chunk 已在上方 loader() 预加载，隐藏面板，等待用户选中文字时由后端 selection-found 触发显示
        await invoke("hide_palette").catch(console.error);
      }
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="palette-container" ref={containerRef}>
      <div className="palette-header">
        <span className="palette-title">悬浮工具</span>
        <button
          className="palette-close"
          aria-label="关闭"
          onClick={() => invoke("hide_palette").catch(console.error)}
        >
          <ToolIcon name="X" size={16} />
        </button>
      </div>
      <div className="palette-body">
        {activateError && (
          <div className="palette-error" onClick={() => setActivateError(null)}>
            {activateError}
          </div>
        )}
        {FLOATING_TOOLS.map((tool) => {
          const enabled = enabledIds.includes(tool.id);
          return (
            <div
              className={`palette-card ${enabled ? "is-enabled" : ""} ${activating ? "is-busy" : ""}`}
              key={tool.id}
              onClick={() => handleActivate(tool)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                // 键盘激活：回车 / 空格等价于点击卡片
                // 忽略内嵌开关按钮冒泡上来的键盘事件，避免与 switch 原生触发冲突
                if (e.target !== e.currentTarget) return;
                // 按住不放的自动重复（auto-repeat）只对 keydown 生效，
                // 跳过以避免同一长按连续触发多次激活
                if (e.repeat) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleActivate(tool);
                }
              }}
            >
              <div className="palette-card-icon">
                <ToolIcon name={tool.icon} size={20} />
              </div>
              <div className="palette-card-text">
                <div className="palette-card-name">{tool.name}</div>
              </div>
              <button
                className={`palette-toggle ${enabled ? "is-on" : ""}`}
                aria-label={enabled ? "禁用" : "启用"}
                role="switch"
                aria-checked={enabled}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleEnabled(tool.id);
                }}
              >
                <span className="palette-toggle-knob" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ToolPalette;
