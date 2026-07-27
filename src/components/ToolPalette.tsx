import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "./Icon";
import {
  FLOATING_TOOLS,
  CATEGORY_LABELS,
  BACKEND_TOOLS,
  getEnabledTools,
  setEnabledTools,
  getAutostartTools,
  setAutostartTools,
  type FloatingTool,
  type ToolCategory,
} from "../tools/registry";
import {
  ensureScreenshotWindow,
  ensureVoiceWindow,
  ensureMonitorWindow,
  waitForNewMonitorWindowReady,
} from "../utils/toolWindows";
import "./ToolPalette.css";

function ToolPalette() {
  const [enabledIds, setEnabledIds] = useState<string[]>(() => getEnabledTools());
  // ref 镜像最新 enabledIds，供异步失败回滚读取当前真值，避免闭包陈旧
  const enabledIdsRef = useRef(enabledIds);
  enabledIdsRef.current = enabledIds;
  const [autostartIds, setAutostartIdsState] = useState<string[]>(() => getAutostartTools());
  const autostartIdsRef = useRef(autostartIds);
  autostartIdsRef.current = autostartIds;
  // 标记是否有后端 toggle 写入正在进行，syncFromBackend 在此期间跳过，
  // 避免后端 getter 读到 toggle 前旧值而覆盖乐观更新（窄窗口竞态）
  const pendingToggle = useRef(0);
  const [query, setQuery] = useState("");
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  // 同步主题（palette 是独立窗口）
  useLayoutEffect(() => {
    const theme = localStorage.getItem("floatory-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
    // 透明背景需逐窗口设置（与 FloatingOrb 同理，避免污染 settings 全局规则）
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) {
      root.style.background = "transparent";
      root.style.margin = "0";
      root.style.height = "100%";
    }
  }, []);

  useEffect(() => {
    const un = listen<string>("floatory-theme-changed", (e) => {
      document.documentElement.setAttribute("data-theme", e.payload);
      localStorage.setItem("floatory-theme", e.payload);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 与后端真值同步：text-toolbar / screenshot 的启用状态持久化于 config.json，
  // localStorage 仅作前端默认。挂载时及每次窗口获焦时以后端为准修正勾选，
  // 避免重启后或外部修改导致 UI 显示与实际行为不一致。
  const syncFromBackend = useCallback(() => {
    // 有 toggle 写入 inflight 时跳过：此时后端 getter 可能尚未反映本次写入，
    // 用旧值覆盖会回退乐观更新。等 toggle 落定后下次获焦会重新同步。
    if (pendingToggle.current > 0) return;
    Promise.all([
      Promise.all(
        BACKEND_TOOLS.map((t) =>
          invoke<boolean>(t.getter)
            .then((enabled) => ({ id: t.id, enabled }))
            .catch(() => null),
        ),
      ),
      invoke<string[]>("get_tools_autostart").catch(() => null),
    ]).then(([results, autostartResult]) => {
      const valid = results.filter((r): r is { id: string; enabled: boolean } => r !== null);
      if (valid.length === 0 && autostartResult === null) {
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

      // 同步自启动状态
      if (autostartResult !== null) {
        // 自启动列表中只保留有效且已启用的工具
        const allIdSet = new Set(FLOATING_TOOLS.map((t) => t.id));
        const enabledSet = new Set(next);
        const validAutostart = autostartResult.filter((id) => allIdSet.has(id) && enabledSet.has(id));
        setAutostartIdsState(validAutostart);
        setAutostartTools(validAutostart);
        autostartIdsRef.current = validAutostart;
      }
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
    // 失焦自动隐藏（点击外部）；获焦时重置搜索词（每次 show 都显示完整列表）
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        invoke("hide_palette").catch(console.error);
      } else {
        setQuery("");
        // 每次显示面板时重新与后端真值同步（覆盖常驻窗口期间外部可能的状态变更）
        syncFromBackend();
      }
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      unFocus.then((fn) => fn());
    };
  }, [syncFromBackend]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FLOATING_TOOLS;
    return FLOATING_TOOLS.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }, [query]);

  const grouped = useMemo(() => {
    const map = new Map<ToolCategory, FloatingTool[]>();
    for (const tool of filtered) {
      if (!map.has(tool.category)) map.set(tool.category, []);
      map.get(tool.category)!.push(tool);
    }
    return map;
  }, [filtered]);

  const toggleEnabled = (id: string) => {
    const wasEnabled = enabledIds.includes(id);
    const next = wasEnabled
      ? enabledIds.filter((x) => x !== id)
      : [...enabledIds, id];
    setEnabledIds(next);
    setEnabledTools(next);
    enabledIdsRef.current = next;

    // 禁用工具时联动清除自启动标记（先记住旧值，以便启用回滚时恢复）
    const prevAutostart = autostartIds;
    let nextAutostart = autostartIds;
    if (wasEnabled && autostartIds.includes(id)) {
      nextAutostart = autostartIds.filter((x) => x !== id);
      setAutostartIdsState(nextAutostart);
      setAutostartTools(nextAutostart);
      autostartIdsRef.current = nextAutostart;
      // 独立计数，避免 set_*_enabled 完成后、set_tools_autostart 完成前
      // syncFromBackend 读取后端旧自启动值覆盖乐观更新
      pendingToggle.current += 1;
      invoke("set_tools_autostart", { ids: nextAutostart })
        .then(() => { pendingToggle.current = Math.max(0, pendingToggle.current - 1); })
        .catch((err) => {
          console.error("Failed to sync autostart to backend:", err);
          pendingToggle.current = Math.max(0, pendingToggle.current - 1);
        });
    }

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
        ? current.filter((x) => x !== id)   // 本次想启用却失败 → 移除
        : [...current, id];                 // 本次想禁用却失败 → 加回
      setEnabledIds(restored);
      setEnabledTools(restored);
      enabledIdsRef.current = restored;
      // 禁用失败时恢复被联动清除的自启动标记
      if (!enabled && nextAutostart !== prevAutostart) {
        setAutostartIdsState(prevAutostart);
        setAutostartTools(prevAutostart);
        autostartIdsRef.current = prevAutostart;
        // 同步恢复后端自启动值，避免下次 syncFromBackend 用后端旧值覆盖
        invoke("set_tools_autostart", { ids: prevAutostart }).catch((err) => {
          console.error("Failed to restore autostart on rollback:", err);
        });
      }
    };
    if (id === "screenshot") {
      invoke("set_screenshot_enabled", { enabled })
        .then(() => { pendingToggle.current = Math.max(0, pendingToggle.current - 1); })
        .catch((err) => {
          console.error("Failed to set screenshot enabled:", err);
          rollback();
        });
    } else if (id === "text-toolbar") {
      invoke("set_text_toolbar_enabled", { enabled })
        .then(() => { pendingToggle.current = Math.max(0, pendingToggle.current - 1); })
        .catch((err) => {
          console.error("Failed to set text toolbar enabled:", err);
          rollback();
        });
    } else if (id === "voice-input") {
      invoke("set_stt_enabled", { enabled })
        .then(() => { pendingToggle.current = Math.max(0, pendingToggle.current - 1); })
        .catch((err) => {
          console.error("Failed to set voice-input enabled:", err);
          rollback();
        });
    } else if (id === "system-monitor") {
      invoke("set_system_monitor_enabled", { enabled })
        .then(() => { pendingToggle.current = Math.max(0, pendingToggle.current - 1); })
        .catch((err) => {
          console.error("Failed to set system-monitor enabled:", err);
          rollback();
        });
    } else if (id === "recording") {
      invoke("set_recording_enabled", { enabled })
        .then(() => { pendingToggle.current = Math.max(0, pendingToggle.current - 1); })
        .catch((err) => {
          console.error("Failed to set recording enabled:", err);
          rollback();
        });
    }
  };

  const handleToggleAutostart = (id: string) => {
    // 仅已启用的工具可设置自启动
    if (!enabledIds.includes(id)) return;
    const has = autostartIds.includes(id);
    const prevAutostart = autostartIds;
    const next = has ? prevAutostart.filter((x) => x !== id) : [...prevAutostart, id];
    setAutostartIdsState(next);
    setAutostartTools(next);
    autostartIdsRef.current = next;
    // 标记 inflight，避免窗口获焦触发的 syncFromBackend 读到后端旧值覆盖乐观更新
    pendingToggle.current += 1;
    invoke("set_tools_autostart", { ids: next })
      .then(() => { pendingToggle.current = Math.max(0, pendingToggle.current - 1); })
      .catch((err) => {
        console.error("Failed to sync autostart to backend:", err);
        pendingToggle.current = Math.max(0, pendingToggle.current - 1);
        // 回滚到变更前的值
        setAutostartIdsState(prevAutostart);
        setAutostartTools(prevAutostart);
        autostartIdsRef.current = prevAutostart;
      });
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
        } else if (tool.id === "voice-input") {
          await ensureVoiceWindow();
          await invoke("show_voice_window").catch(console.error);
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
    <div className="palette-container">
      <div className="palette-header">
        <span className="palette-title">悬浮工具</span>
        <button
          className="palette-close"
          aria-label="关闭"
          onClick={() => invoke("hide_palette").catch(console.error)}
        >
          <Icon name="X" size={16} />
        </button>
      </div>
      <input
        className="palette-search"
        placeholder="搜索工具…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="palette-body">
        {activateError && (
          <div className="palette-error" onClick={() => setActivateError(null)}>
            {activateError}
          </div>
        )}
        {Array.from(grouped.entries()).map(([cat, tools]) => (
          <div className="palette-group" key={cat}>
            <div className="palette-group-label">{CATEGORY_LABELS[cat]}</div>
            <div className="palette-grid">
              {tools.map((tool) => {
                const enabled = enabledIds.includes(tool.id);
                const autostart = autostartIds.includes(tool.id);
                return (
                  <div
                    className={`palette-card ${enabled ? "is-enabled" : ""} ${activating ? "is-busy" : ""}`}
                    key={tool.id}
                    onClick={() => handleActivate(tool)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="palette-card-icon">
                      <Icon name={tool.icon} size={20} />
                    </div>
                    <div className="palette-card-text">
                      <div className="palette-card-name">{tool.name}</div>
                    </div>
                    {enabled && (
                      <button
                        className={`palette-autostart ${autostart ? "is-on" : ""}`}
                        aria-label={autostart ? "取消自启动" : "自启动"}
                        aria-pressed={autostart}
                        title={autostart ? "取消自启动" : "启动时自动打开"}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleAutostart(tool.id);
                        }}
                      >
                        <Icon name="Rocket" size={14} />
                      </button>
                    )}
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
        ))}
        {filtered.length === 0 && (
          <div className="palette-empty">未找到匹配的工具</div>
        )}
      </div>
    </div>
  );
}

export default ToolPalette;
